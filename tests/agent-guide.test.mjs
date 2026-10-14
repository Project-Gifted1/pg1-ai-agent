/**
 * The README "For agents" section (published as /docs/agents): the
 * decision tree names only real tools, the free-tier and rate-limit cheat
 * sheet states the limits the code enforces, every user-facing tool is in
 * the cheat sheet, and the page is built, routed and listed. Plus the
 * /usage counters behind "which tools to double down on": calls served
 * free / free tier / paid, and indicator lookups that found a record.
 *
 * Run with: node --test tests/agent-guide.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.X402_PAY_TO_ADDRESS;
const { TOOLS } = await import('../api/mcp.mjs');
const { FREE_TIER_DAILY_LIMIT } = await import('../lib/freeTier.mjs');
const cfg = await import('../lib/x402Config.mjs');
const { markdownSection, DOC_PAGES } = await import('../scripts/build-docs.mjs');
const { aggregateUsage } = await import('../lib/usageStats.mjs');
const { formatUsageReport } = await import('../lib/usageReport.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const README = read('README.md');
const SECTION = markdownSection(README, 'For agents');
const TOOL_NAMES = TOOLS.map((t) => t.name);
const LICENCE_ONLY = ['subscribe_alerts', 'submit_indicator'];

function subsection(title) {
  const start = SECTION.indexOf(`## ${title}`);
  assert.ok(start >= 0, `missing "${title}"`);
  const next = SECTION.indexOf('\n## ', start + 3);
  return SECTION.slice(start, next === -1 ? undefined : next);
}

const toolsIn = (text) => [...new Set([...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => /^(get|check)_/.test(n)))];

test('the decision tree names only real tools, and covers every lookup tool', () => {
  const tree = subsection('Which tool to call');
  const named = toolsIn(tree);
  for (const name of named) assert.ok(TOOL_NAMES.includes(name), `${name} is not a tool`);
  for (const name of TOOL_NAMES.filter((n) => !LICENCE_ONLY.includes(n))) assert.ok(named.includes(name), `${name} missing from the decision tree`);
  // The pairings the guide promises.
  assert.match(tree, /`check_wallet_sanctions` \*\*and\*\* `check_wallet_age`/);
  assert.match(tree, /`check_hostname_reputation` \*\*and\*\* `check_domain_age`/);
});

test('the status table says no_flags is not proof of safety and unknown is never clean', () => {
  const status = subsection('What `status` means');
  assert.match(status, /`"no_flags"` \| Nothing bad is recorded \*\*in the sources checked\*\*/);
  assert.match(status, /`"flagged"` \|.*escalate/);
  assert.match(status, /`"unknown"` \|.*Never treat it as clean/);
});

test('the cheat sheet states the limits and price the code enforces', () => {
  const sheet = subsection('Free tier and rate limits');
  const row = (tool) => sheet.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${tool}\``));
  assert.match(row('check_wallet_sanctions'), new RegExp(`${cfg.WALLET_SANCTIONS_RATE_LIMIT_MAX} calls/hour`));
  for (const [tool, max] of [['check_domain_age', cfg.DOMAIN_AGE_RATE_LIMIT_MAX], ['check_hostname_reputation', cfg.HOSTNAME_REPUTATION_RATE_LIMIT_MAX], ['check_wallet_age', cfg.WALLET_AGE_RATE_LIMIT_MAX], ['check_package', cfg.PACKAGE_CHECK_RATE_LIMIT_MAX], ['check_ip_abuse', cfg.IP_ABUSE_RATE_LIMIT_MAX]]) {
    assert.match(row(tool), new RegExp(`${max} calls/${cfg.rateLimitWindowText()}`), tool);
  }
  assert.match(row('get_cve_details'), new RegExp(`${FREE_TIER_DAILY_LIMIT} free calls a day`));
  assert.match(row('get_cve_details'), new RegExp(cfg.x402PriceText().replace('.', '\\.')));
  for (const free of cfg.FREE_MCP_TOOLS) assert.match(row(free), /Always free/, free);
  // The STIX feed is free (and uses none of the free calls) while PG1_FEED_PAID is off.
  assert.equal(cfg.isFeedPaid({}), false);
  assert.match(row('get_threat_indicators'), /Free while the feed holds no current data \(`PG1_FEED_PAID` off\)/);
  assert.match(row('get_threat_indicators'), /does not use the 5 free calls a day/);
  assert.match(row('get_threat_indicators'), /`GET \/api\/ioc`/);
  assert.doesNotMatch(row('get_cve_details'), /get_threat_indicators/);
  for (const name of TOOL_NAMES.filter((n) => !LICENCE_ONLY.includes(n))) assert.ok(row(name), `${name} missing from the cheat sheet`);
  assert.match(sheet, /No header is needed for the free tier/);
  assert.match(sheet, /X-Free-Tier: 0/);
});

test('/docs/agents is built from the section, routed, secured and listed', () => {
  const page = DOC_PAGES.find((p) => p.route === '/docs/agents');
  assert.ok(page);
  assert.equal(page.section, 'For agents');
  const html = read(page.output);
  assert.match(html, /Which tool to call/);
  assert.match(html, /What <code>status<\/code> means/);
  const vercel = JSON.parse(read('vercel.json'));
  assert.ok(vercel.rewrites.some((r) => r.source === '/docs/agents' && r.destination === '/docs/agents/index.html'));
  assert.ok(vercel.headers.some((h) => h.source === '/docs/agents' && h.headers.some((x) => x.key === 'Content-Security-Policy')));
  assert.match(read('public/sitemap.xml'), /\/docs\/agents</);
  assert.match(read('public/llms.txt'), /## Which tool to call[\s\S]*https:\/\/pg1-ai-agent\.vercel\.app\/docs\/agents/);
});

test('/usage: calls served free / free tier / paid, and indicator lookups that found a record', () => {
  const NOW = Date.parse('2026-10-13T12:00:00Z');
  const row = (caller, tool, status, payment_type) => ({ created_at: new Date(NOW - 3600e3).toISOString(), event_type: 'tool_call', endpoint: '/api/mcp', tool_name: tool, status, payment_type, caller_hash: caller.repeat(32), is_fixture: false });
  const rows = [
    row('a', 'check_domain_age', 'ok', 'free'),
    row('a', 'get_ioc_context', 'ok', 'free'), // nothing found
    row('a', 'get_ioc_context', 'ok', 'free_tier'), // found, free tier
    row('b', 'get_ioc_batch', 'payment_required', 'none'), // found, challenged
    row('b', 'get_cve_details', 'ok', 'x402')
  ];
  const r = aggregateUsage(rows, { period: '24h', now: NOW });
  assert.deepEqual(r.served_by, { free: 2, free_tier: 1, paid: 1 });
  assert.deepEqual(r.ioc_lookups, { total: 3, found: 2 });
  const text = formatUsageReport(r);
  assert.match(text, /^Served: free 2 · free tier 1 · paid 1$/m);
  assert.match(text, /^Indicator lookups with a record found: 2 of 3$/m);
});
