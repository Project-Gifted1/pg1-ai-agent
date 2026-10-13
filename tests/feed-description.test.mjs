/**
 * Since the licensing gate (lib/sourcePolicy.mjs) the only source PG1 serves
 * from threat_ioc_telemetry is NVD, so get_threat_indicators and GET
 * /api/ioc return CVE records and nothing else. Every place that describes
 * that feed must say so, and none may call it an IOC or indicator feed or
 * promise IPs, domains, URLs or file hashes while it holds none.
 *
 * Run with: node --test tests/feed-description.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.X402_PAY_TO_ADDRESS;
const { TOOLS } = await import('../api/mcp.mjs');
const { renderPaywallPage } = await import('../lib/paywallPage.mjs');
const { THREAT_SOURCES, isSourceEnabled } = await import('../lib/sourcePolicy.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tool = (name) => TOOLS.find((t) => t.name === name).description;

// The claim each description must not make while only NVD is served.
const INDICATOR_FEED = /indicator feed|IOC feed|bundle of (verified )?threat indicators|\(IPs, domains, URLs, file hashes/i;
const SAYS_CVE_FROM_NVD = /CVE records from (NIST )?NVD/;

test('the premise: NVD is the only source served by default', () => {
  assert.deepEqual(THREAT_SOURCES.filter((s) => isSourceEnabled(s.id, {})).map((s) => s.id), ['nvd']);
});

test('MCP tool descriptions: the feed is CVE records from NVD; lookups say IPs/domains/URLs/hashes return found: false', () => {
  assert.match(tool('get_threat_indicators'), SAYS_CVE_FROM_NVD);
  assert.match(tool('get_threat_indicators'), /no IP, domain, URL or file-hash indicators/);
  assert.doesNotMatch(tool('get_threat_indicators'), INDICATOR_FEED);
  for (const name of ['get_ioc_context', 'get_ioc_batch']) {
    assert.match(tool(name), /currently hold only CVE identifiers from NVD/, name);
    assert.match(tool(name), /found: false/, name);
  }
});

test('the x402 resource text (MCP and /api/ioc) and the browser 402 page say the same', () => {
  const mcp = read('api/mcp.mjs').match(/const X402_RESOURCE_DESCRIPTION = '([^']*)'/)[1];
  const chat = read('api/chat.mjs');
  const ioc = chat.slice(chat.indexOf('var iocX402RouteConfig'), chat.indexOf('x402Middleware = paymentMiddleware('));
  for (const [label, text] of [['MCP resource', mcp], ['/api/ioc 402', ioc]]) {
    assert.match(text, SAYS_CVE_FROM_NVD, label);
    assert.doesNotMatch(text, INDICATOR_FEED, label);
  }
  const page = renderPaywallPage({ resource: { url: 'https://pg1-ai-agent.vercel.app/api/ioc' } });
  assert.match(page, SAYS_CVE_FROM_NVD);
  assert.doesNotMatch(page, INDICATOR_FEED);
});

test('README, /docs/agents, llms.txt, OpenAPI, the About page, the home page, the agent card and server.json', () => {
  for (const rel of ['README.md', 'public/docs/agents/index.html', 'public/llms.txt', 'public/openapi.json', 'public/about/index.html', 'public/index.html', 'public/.well-known/agent-card.json', 'server.json']) {
    // The permanent reason code IOC_FOUND_IN_THREAT_FEED keeps its documented meaning.
    const text = read(rel).replace(/.*IOC_FOUND_IN_THREAT_FEED.*\n?/g, '');
    assert.doesNotMatch(text, INDICATOR_FEED, rel);
  }
  assert.doesNotMatch(JSON.parse(read('server.json')).description, /\bIOCs?\b/);
  for (const rel of ['README.md', 'public/llms.txt', 'public/openapi.json', 'public/about/index.html']) assert.match(read(rel), SAYS_CVE_FROM_NVD, rel);
  assert.match(read('public/docs/agents/index.html'), /STIX 2\.1 bundle of CVE records from NVD/);
});
