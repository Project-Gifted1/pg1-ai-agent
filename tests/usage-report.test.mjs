/**
 * The reorganised /usage report (lib/usageStats.mjs, lib/usageReport.mjs)
 * and the telemetry it needs (lib/telemetry.mjs, api/mcp.mjs, api/chat.mjs).
 *
 * Covered: probe vs real classification (the crawler list in
 * config/usageProbes.mjs and probe-only activity); MCP requests vs tool
 * calls, labelled apart everywhere; the payment funnel for real callers;
 * the error breakdown (by tool, type, class, top unrecognised tool names);
 * per-day spike marking; the report layout (title, sections in order, 2-5
 * lines each, muted footnote); the fallback read before the migration; and
 * what /api/mcp now records (mcp_request rows, unknown tool names reduced,
 * free_limit_reached, settled amounts).
 *
 * Run with: node --test tests/usage-report.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// These tests exercise the paid /api/ioc gate, so the feed is made paid
// (it is free by default while it holds no current data; tests/feed-pricing.test.mjs).
process.env.PG1_FEED_PAID = 'true';

process.env.TELEMETRY_IP_SALT = 'test-salt-for-usage-report';
delete process.env.X402_PAY_TO_ADDRESS;

const { aggregateUsage, classifyCallers, isProbeClientName, markSpikes, median, getUsageStats, SPIKE_FACTOR } = await import('../lib/usageStats.mjs');
const { formatUsageReport } = await import('../lib/usageReport.mjs');
const { PROBE_CLIENT_NAMES, PROBE_ONLY_METHODS, PROBE_ONLY_TOOLS } = await import('../config/usageProbes.mjs');
const { buildTelemetryRow, callerHash, MCP_METHODS } = await import('../lib/telemetry.mjs');
const { default: mcpHandler } = await import('../api/mcp.mjs');
const { default: chatHandler } = await import('../api/chat.mjs');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase.test';

beforeEach(() => {
  process.env.SUPABASE_URL = SUP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  process.env.TELEMETRY_IP_SALT = 'test-salt-for-usage-report';
  delete process.env.X402_PAY_TO_ADDRESS;
  globalThis.fetch = async (url) => { throw new Error('Unexpected network call in test: ' + url); };
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function installFetch(routes = []) {
  const calls = [];
  const rows = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', headers: options.headers || {} });
    if (u.endsWith('/rest/v1/agent_telemetry') && options.method === 'POST') {
      rows.push(JSON.parse(options.body));
      return new Response(null, { status: 201 });
    }
    for (const [needle, handler] of routes) {
      if (u.includes(needle)) return handler(u, options);
    }
    if (u.includes('/rest/v1/')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error('Unexpected network call in test: ' + u);
  };
  return { calls, rows };
}

const settle = () => new Promise((r) => setImmediate(r));

function makeRes() {
  return {
    statusCode: null, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
    write() { return true; },
    on() {}
  };
}

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const AT = '2026-10-13T09:00:00Z';
const H = (c) => c.repeat(32);
const base = { created_at: AT, is_fixture: false, endpoint: '/api/mcp', client_name: null, payment_type: 'none' };
const init = (caller, name, extra = {}) => ({ ...base, event_type: 'initialize', status: 'ok', client_name: name, caller_hash: H(caller), ...extra });
const req = (caller, method, status = 'ok', extra = {}) => ({ ...base, event_type: 'mcp_request', mcp_method: method, status, caller_hash: H(caller), ...extra });
const call = (caller, tool, status = 'ok', extra = {}) => ({ ...base, event_type: 'tool_call', tool_name: tool, status, caller_hash: H(caller), ...extra });
const settled = (caller, extra = {}) => ({ ...base, event_type: 'settlement', tool_name: 'get_cve_details', payment_type: 'x402', status: 'settled', amount_usd: 0.01, caller_hash: H(caller), ...extra });

// --- probe classification ------------------------------------------------------

test('probe list: every configured crawler name is recognised, case and punctuation aside', () => {
  assert.ok(PROBE_CLIENT_NAMES.length >= 10);
  for (const name of PROBE_CLIENT_NAMES) {
    assert.ok(isProbeClientName(name), name);
    assert.ok(isProbeClientName(name.toUpperCase()), `${name} upper case`);
    assert.ok(isProbeClientName(`${name}/1.4.2`), `${name} with a version`);
  }
  assert.ok(isProbeClientName('Glama MCP Inspector'));
  assert.ok(isProbeClientName('agentsjunction-health-checker'));
  for (const real of ['Claude Desktop', 'cursor', 'glamazon-agent', 'mcpbeats', null, '', '(not given)']) {
    assert.equal(isProbeClientName(real), false, String(real));
  }
});

test('probe vs real: crawler names and probe-only activity are probes; anything else is real', () => {
  const rows = [
    // a: a known crawler, even though it also runs a real tool
    init('a', 'glimind-probe'), call('a', 'check_domain_age'),
    // b: unnamed client that only lists tools and asks for its own quota
    init('b', 'some-client'), req('b', 'tools/list'), call('b', 'get_usage_status'),
    // c: a real agent: initialize, tools/list, then a real check
    init('c', 'Claude Desktop'), req('c', 'tools/list'), call('c', 'check_wallet_sanctions'),
    // d: no initialize at all, one A2A tool call
    call('d', 'check_domain_age', 'ok', { endpoint: '/api/a2a' }),
    // e: only an unknown method - not real usage
    req('e', 'other', 'method_not_found'),
    // f: only asked for a tool that does not exist - Phase 2: a probe of
    // its own kind (unknown_tools_only), never a real caller on its own
    call('f', null, 'unknown_tool', { requested_tool: 'get_weather' })
  ];
  const { classOf, reasonOf } = classifyCallers(rows);
  const byCaller = (c) => rows.find((r) => r.caller_hash === H(c));
  assert.equal(classOf(byCaller('a')), 'probe');
  assert.equal(reasonOf(byCaller('a')), 'known_crawler');
  assert.equal(classOf(byCaller('b')), 'probe');
  assert.equal(reasonOf(byCaller('b')), 'probe_only_activity');
  assert.equal(classOf(byCaller('c')), 'real');
  assert.equal(classOf(byCaller('d')), 'real');
  assert.equal(classOf(byCaller('e')), 'probe');
  assert.equal(classOf(byCaller('f')), 'probe');
  assert.equal(reasonOf(byCaller('f')), 'unknown_tools_only');

  const s = aggregateUsage(rows, { period: '24h', now: NOW });
  assert.deepEqual(s.traffic.distinct_callers_estimate, { real: 2, probe: 4 });
  assert.deepEqual(s.traffic.probe_callers_by_reason, { known_crawler: 1, probe_tool_name: 0, unknown_tools_only: 1, probe_only_activity: 2 });
  assert.equal(s.summary.distinct_real_callers_estimate, 2);
  assert.ok(PROBE_ONLY_METHODS.includes('tools/list') && PROBE_ONLY_METHODS.includes('initialize'));
  assert.deepEqual([...PROBE_ONLY_TOOLS], ['get_usage_status']);
});

test('the probe list lives in one config file that lib/usageStats.mjs reads', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/usageStats.mjs', import.meta.url), 'utf8');
  assert.match(src, /from '\.\.\/config\/usageProbes\.mjs'/);
  for (const name of ['glimind-probe', 'posthog-mcp-registry-probe', 'AgentsJunction health checker']) {
    assert.ok(!src.includes(name), `${name} is not hard-coded in lib/usageStats.mjs`);
  }
});

// --- requests vs tool calls ----------------------------------------------------

test('MCP requests and tool calls are counted apart and labelled apart', () => {
  const rows = [
    init('c', 'Claude Desktop'), req('c', 'tools/list'), req('c', 'notifications/initialized'),
    call('c', 'check_wallet_sanctions'), call('c', 'check_domain_age'),
    call('c', 'check_domain_age', 'ok', { endpoint: '/api/a2a' }),
    call('c', 'ioc_feed', 'ok', { endpoint: '/api/ioc', payment_type: 'license' }),
    init('p', 'mcpbeat'), req('p', 'tools/list')
  ];
  const s = aggregateUsage(rows, { period: '24h', now: NOW });
  assert.deepEqual(s.traffic.mcp_requests, { total: 7, real: 5, probe: 2 }, 'initialize, tools/list, notifications and tools/call on /api/mcp');
  assert.deepEqual(s.traffic.tool_calls, { total: 4, real: 4, probe: 0 }, 'tools run on any route');
  assert.equal(s.summary.real_tool_calls, 4);
  assert.deepEqual(s.clients, [
    { name: 'Claude Desktop', requests: 5, tool_calls: 2, class: 'real' },
    { name: 'mcpbeat', requests: 2, tool_calls: 0, class: 'probe' }
  ]);
  assert.match(s.traffic.mcp_requests_note, /Not the same as tool calls/);

  const report = formatUsageReport(s);
  assert.match(report, /^MCP requests: 7 \(real 5, probe 2\)$/m);
  assert.match(report, /^Tool calls: 4 \(real 4, probe 0\)$/m);
  assert.match(report, /^`Claude Desktop` 5 requests · 2 tool calls$/m);
  assert.match(report, /^`mcpbeat` 2 requests · 0 tool calls · probe$/m);
  assert.doesNotMatch(report, /^`Claude Desktop` 5$/m, 'a client total is never shown without its label');
});

// --- payment funnel -------------------------------------------------------------

test('payment funnel for real callers: free checks, free limit, 402s, settlements, revenue', () => {
  const rows = [
    init('r1', 'Claude Desktop'), init('r2', 'cursor'), init('r3', 'Cline'),
    call('r1', 'check_domain_age', 'ok', { payment_type: 'free' }),
    call('r1', 'check_wallet_age', 'ok', { payment_type: 'free' }),
    call('r1', 'get_cve_details', 'ok', { payment_type: 'free_tier' }),
    call('r1', 'get_cve_details', 'free_limit_reached'),
    call('r1', 'get_cve_details', 'free_limit_reached'),
    call('r2', 'ioc_feed', 'free_limit_reached', { endpoint: '/api/ioc' }),
    call('r2', 'get_cve_batch', 'payment_required'),
    call('r3', 'get_cve_details', 'ok', { payment_type: 'x402' }), settled('r3'),
    call('r3', 'get_cve_details', 'ok', { payment_type: 'x402' }), settled('r3', { amount_usd: 0.02 }),
    call('r3', 'get_cve_details', 'settlement_failed', { payment_type: 'x402' }), settled('r3', { status: 'failed', amount_usd: null }),
    call('r3', 'ioc_feed', 'ok', { endpoint: '/api/ioc', payment_type: 'x402' }),
    // a probe's challenge is not part of the real funnel
    init('p', 'agentrank-probe'), call('p', 'get_cve_details', 'payment_required')
  ];
  const s = aggregateUsage(rows, { period: '24h', now: NOW });
  const { payment_requests_by_tool: byTool, payment_requests_callers: challengedCallers, ...funnel } = s.payments;
  // Which tools the 402s were for, and how many distinct callers got them.
  assert.deepEqual(byTool.map((t) => [t.tool, t.requests]), byTool.map((t) => [t.tool, t.requests]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  assert.equal(byTool.reduce((n, t) => n + t.requests, 0), 4, 'every real 402 is under one tool');
  assert.ok(challengedCallers >= 1);
  assert.deepEqual(funnel, {
    free_checks_used: 3, free_tool_calls: 2, free_tier_calls: 1,
    callers_hit_free_limit: 2, free_limit_responses: 3,
    payment_requests: 4, payments_settled: 2, settlement_failures: 1,
    revenue_usd: 0.03, ioc_feed_x402_calls: 1,
    // Phase 2: free tier per route (one shared counter) and the drop-off:
    // r2 was challenged and never served (r1 used the free tier, r3 paid).
    free_tier_calls_by_route: [{ route: '/api/mcp', calls: 1 }],
    callers_challenged_never_served: 1
  });
  assert.equal(s.summary.payment_requests, 4);
  assert.equal(s.summary.settled_revenue_usd, 0.03);

  const report = formatUsageReport(s);
  assert.match(report, /^Free checks used: 3 \(free tools 2, free tier 1\)$/m);
  assert.match(report, /^Hit the free limit: 2 callers$/m);
  assert.match(report, /^Payment requests issued \(402\): 4$/m);
  assert.match(report, /^Payments settled: 2 · 0\.03 USD · 1 failed settlement$/m);
  assert.match(report, /^Shown a payment request, never served: 1 caller$/m);
  assert.match(report, /^Free tier by route \(one 5\/day counter\): \/api\/mcp 1$/m);
  assert.match(report, /^Settled revenue: 0\.03 USD$/m);
});

// --- errors ---------------------------------------------------------------------

test('error breakdown: by tool, by type, by class, by fault; unknown tools counted apart with the top 5 names as requested', () => {
  const unknown = (caller, name) => call(caller, null, 'unknown_tool', { requested_tool: name });
  const rows = [
    init('r', 'Claude Desktop'),
    call('r', 'check_wallet_age', 'tool_error'), call('r', 'check_wallet_age', 'tool_error'),
    call('r', 'get_cve_details', 'server_error'),
    call('r', 'check_domain_age', 'rate_limited'),
    unknown('r', 'get_weather'), unknown('r', 'get_weather'), unknown('r', 'get_weather'),
    unknown('r', 'search'), unknown('r', 'search'),
    unknown('r', 'lookup_ip'), unknown('r', 'GetCVE'), unknown('r', 'scan.url'), unknown('r', 'sixth_one'),
    init('p', 'glama'), req('p', 'other', 'method_not_found'), req('p', 'invalid_json', 'parse_error'),
    call('p', 'get_usage_status', 'payment_required')
  ];
  const s = aggregateUsage(rows, { period: '24h', now: NOW });
  const e = s.errors;
  // Phase 2: an unknown tool is a caller mistake counted on its own, not an
  // error, so the 9 unknown_tool calls are out of the total.
  assert.equal(e.total, 5);
  assert.deepEqual(e.by_class, { real: 3, probe: 2 });
  assert.deepEqual(e.unknown_tool_calls, { total: 9, real: 9, probe: 0 });
  // A tool error is PG1's or its source's, never the caller's.
  assert.deepEqual(e.by_fault, { caller: 2, pg1: 3, unclassified: 0 });
  assert.equal(e.rate_limited, 1, 'rate limits are counted on their own, not as errors');
  assert.deepEqual(e.by_tool.slice(0, 1), [{ tool: 'check_wallet_age', errors: 2 }]);
  assert.deepEqual(e.by_type, [
    { type: 'tool_error', errors: 2 },
    { type: 'method_not_found', errors: 1 }, { type: 'parse_error', errors: 1 }, { type: 'server_error', errors: 1 }
  ]);
  assert.deepEqual(e.unrecognised_tools, [
    { name: 'get_weather', count: 3 }, { name: 'search', count: 2 },
    { name: 'GetCVE', count: 1 }, { name: 'lookup_ip', count: 1 }, { name: 'scan.url', count: 1 }
  ], 'top 5, exact names, most requested first');

  const report = formatUsageReport(s);
  assert.match(report, /^Total: 5 \(real 3, probe 2\) · rate limited 1$/m);
  assert.match(report, /^Whose fault: PG1 or its sources 3 · caller input 2$/m);
  assert.match(report, /^Unknown tools asked for \(caller mistakes, not errors\): 9 \(real 9, probe 0\) · `get_weather` 3 · `search` 2 · `GetCVE` 1 · `lookup_ip` 1 · `scan.url` 1$/m);
});

// --- spikes ---------------------------------------------------------------------

test('spikes: a day over 3x the median is marked; a quiet median counts as 1', () => {
  assert.equal(SPIKE_FACTOR, 3);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  const days = [10, 12, 9, 11, 31, 30, 10].map((n, i) => ({ day: `2026-10-0${i + 1}`, real: n, probe: 0 }));
  const out = markSpikes(days);
  assert.equal(out.median, 11);
  assert.equal(out.threshold, 33);
  assert.deepEqual(out.days.map((d) => d.spike), [false, false, false, false, false, false, false], '31 is under 3 x 11');
  days[4].probe = 3;
  assert.deepEqual(markSpikes(days).days.map((d) => d.spike), [false, false, false, false, true, false, false], 'real + probe 34 > 33');
  const quiet = markSpikes([0, 0, 0, 3, 4, 0, 0].map((n, i) => ({ day: String(i), real: n, probe: 0 })));
  assert.equal(quiet.threshold, 3);
  assert.deepEqual(quiet.days.map((d) => d.spike), [false, false, false, false, true, false, false], '3 is not more than 3');

  const rows = [];
  for (let d = 7; d <= 13; d++) {
    const n = d === 11 ? 40 : 5;
    for (let i = 0; i < n; i++) rows.push(call(String(d % 10), 'check_domain_age', 'ok', { created_at: `2026-10-${String(d).padStart(2, '0')}T08:00:00Z`, endpoint: '/api/a2a' }));
  }
  const s = aggregateUsage(rows, { period: '7d', now: NOW });
  assert.deepEqual(s.traffic.per_day.filter((d) => d.spike).map((d) => d.day), ['2026-10-11']);
  assert.match(formatUsageReport(s), /11 Oct 40\+0 \(spike\)/);
  assert.match(formatUsageReport(s), /^Spikes \(over 15 a day, 3x the median\): 11 Oct$/m);
});

// --- layout ---------------------------------------------------------------------

test('report layout: title, then Summary, Traffic, Tools, Payments, Errors, Clients, each 2-5 lines, then the footnote', () => {
  const rows = [
    init('c', 'Claude Desktop'), req('c', 'tools/list'), call('c', 'check_domain_age', 'ok', { payment_type: 'free' }),
    call('c', 'get_cve_details', 'payment_required'), call('c', 'check_wallet_age', 'tool_error')
  ];
  const report = formatUsageReport({ ...aggregateUsage(rows, { period: '7d', now: NOW }), truncated: false, schema: 'current' });
  const blocks = report.split('\n\n');
  assert.equal(blocks[0], '## Usage · the last 7 days');
  const headings = blocks.slice(1, -1).map((b) => b.split('\n')[0]);
  assert.deepEqual(headings.filter((h) => h !== '### Checks'), ['### Summary', '### Traffic', '### Tools', '### Payments', '### Errors', '### Clients']);
  assert.ok(!headings.includes('### Checks') || headings[headings.length - 1] === '### Checks', 'Checks, when shown, comes last');
  for (const b of blocks.slice(1, -1)) {
    const lines = b.split('\n').slice(1);
    assert.ok(lines.length >= 1 && lines.length <= 5, `${b.split('\n')[0]} has ${lines.length} lines`);
  }
  for (const name of ['Summary', 'Traffic', 'Payments']) {
    const lines = blocks.find((b) => b.startsWith(`### ${name}`)).split('\n').slice(1);
    assert.ok(lines.length >= 2, `${name} has at least 2 lines`);
  }
  assert.equal(blocks.at(-1), '[^note]: Fixture calls excluded; distinct callers is an estimate from hashed IPs.');
  assert.match(report, /^`check_domain_age` 1 call · free$/m);
  assert.match(report, /^`get_cve_details` 1 call · paid$/m);
});

test('the chat renders the footnote line as small muted text (formatMarkdown)', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /\.md-foot \{[^}]*font-family: var\(--font-sans\);[^}]*font-size: var\(--fs-xs\);[^}]*color: var\(--text-3\);/s);
  assert.ok(html.includes('<div class="md-foot" role="note">${m[1]}</div>'));
});

// --- read path ------------------------------------------------------------------

test('before the migration the read falls back to the old columns and the report says so', async () => {
  const { calls } = installFetch([['/rest/v1/agent_telemetry', (u) => (u.includes('mcp_method')
    ? new Response(JSON.stringify({ code: '42703', message: 'column agent_telemetry.mcp_method does not exist' }), { status: 400 })
    : Response.json([init('c', 'Claude Desktop'), call('c', 'check_domain_age')]))]]);
  const stats = await getUsageStats({ period: '7d', now: NOW });
  const reads = calls.filter((c) => c.url.includes('/rest/v1/agent_telemetry'));
  assert.equal(reads.length, 3, 'current, then without caller_kind, then legacy');
  assert.ok(reads[0].url.includes('mcp_method,requested_tool,amount_usd,caller_kind'));
  assert.ok(reads[1].url.includes('mcp_method,requested_tool,amount_usd') && !reads[1].url.includes('caller_kind'));
  assert.ok(!reads[2].url.includes('mcp_method'));
  assert.equal(stats.schema, 'legacy');
  assert.equal(stats.summary.real_tool_calls, 1);
  assert.match(formatUsageReport(stats), /predates the latest migration/);
});

// --- what /api/mcp records -------------------------------------------------------

const IP = '198.51.100.23';

test('/api/mcp records tools/list, notifications, unknown methods (by name, reduced) and bad JSON as mcp_request rows', async () => {
  const { rows } = installFetch();
  const headers = { 'x-forwarded-for': IP };
  await mcpHandler({ method: 'POST', headers, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, makeRes());
  await mcpHandler({ method: 'POST', headers, body: { jsonrpc: '2.0', method: 'notifications/initialized' } }, makeRes());
  await mcpHandler({ method: 'POST', headers, body: { jsonrpc: '2.0', id: 2, method: 'resources/read' } }, makeRes());
  await mcpHandler({ method: 'POST', headers, body: { jsonrpc: '2.0', id: 3, method: `evil ${'0x' + 'ab'.repeat(20)}` } }, makeRes());
  await mcpHandler({ method: 'POST', headers, body: '{not json' }, makeRes());
  await mcpHandler({ method: 'GET', headers }, makeRes());
  await settle();
  assert.deepEqual(rows.map((r) => [r.event_type, r.mcp_method, r.status]), [
    ['mcp_request', 'tools/list', 'ok'],
    ['mcp_request', 'notifications/initialized', 'ok'],
    ['mcp_request', 'resources/read', 'client_error'],
    ['mcp_request', 'evil', 'method_not_found'],
    ['mcp_request', 'invalid_json', 'parse_error']
  ], 'a plain GET health check is not recorded');
  for (const r of rows) {
    assert.equal(r.caller_hash, callerHash(IP));
    assert.ok(!JSON.stringify(r).includes(IP) && !JSON.stringify(r).includes('abab'));
    assert.equal(r.tool_name, null);
  }
  assert.ok(MCP_METHODS.includes('tools/list'));
});

test('/api/mcp stores an unknown tool name reduced, never an address in it', async () => {
  const { rows } = installFetch();
  const headers = { 'x-forwarded-for': IP };
  await mcpHandler({ method: 'POST', headers, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_weather', arguments: {} } } }, makeRes());
  await mcpHandler({ method: 'POST', headers, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: `pay_${'0x' + 'cd'.repeat(20)}<script>`, arguments: {} } } }, makeRes());
  await settle();
  assert.deepEqual(rows.map((r) => [r.status, r.tool_name, r.requested_tool]), [
    ['unknown_tool', null, 'get_weather'],
    ['unknown_tool', null, 'pay_ script']
  ]);
  const known = buildTelemetryRow({ eventType: 'tool_call', toolName: 'check_domain_age', status: 'ok', requestedTool: 'check_domain_age' });
  assert.equal('requested_tool' in known, false, 'only unknown_tool rows carry requested_tool');
});

test('/api/mcp records free_limit_reached when the free tier is used up, payment_required otherwise', async () => {
  const { rows } = installFetch([['/rest/v1/free_tier_usage', () => Response.json([{ request_count: 5 }])]]);
  const args = { cve_id: 'CVE-2024-3094' };
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': IP, 'x-free-tier': '1' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_cve_details', arguments: args } } }, makeRes());
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': IP, 'x-free-tier': '0' }, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_cve_details', arguments: args } } }, makeRes());
  await settle();
  assert.deepEqual(rows.map((r) => [r.tool_name, r.status]), [['get_cve_details', 'free_limit_reached'], ['get_cve_details', 'payment_required']]);
});

test('/api/ioc records free_limit_reached when the free tier is used up', async () => {
  const { rows } = installFetch([['/rest/v1/free_tier_usage', () => Response.json([{ request_count: 5 }])]]);
  const res = makeRes();
  await chatHandler({ method: 'GET', url: '/api/ioc?type=ipv4', headers: { 'x-forwarded-for': IP, 'x-free-tier': '1' }, socket: { remoteAddress: IP }, body: null }, res);
  await settle();
  assert.equal(res.statusCode, 402);
  const ioc = rows.filter((r) => r.endpoint === '/api/ioc');
  assert.deepEqual(ioc.map((r) => r.status), ['free_limit_reached']);
});

test('settled settlement rows carry amount_usd; other rows never do', () => {
  const ok = buildTelemetryRow({ eventType: 'settlement', status: 'settled', amountUsd: 0.01, paymentType: 'x402' });
  assert.equal(ok.amount_usd, 0.01);
  for (const row of [
    buildTelemetryRow({ eventType: 'settlement', status: 'failed', amountUsd: 0.01 }),
    buildTelemetryRow({ eventType: 'settlement', status: 'settled', amountUsd: -1 }),
    buildTelemetryRow({ eventType: 'tool_call', status: 'ok', amountUsd: 0.01 }),
    buildTelemetryRow({ eventType: 'initialize', status: 'ok', clientName: 'x' })
  ]) {
    assert.equal('amount_usd' in row, false);
    assert.equal('mcp_method' in row, false);
  }
});
