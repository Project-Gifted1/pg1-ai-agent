/**
 * Phase 2 (revenue funnel), end to end against mocked upstreams:
 *
 *   - EPSS: paid CVE responses (MCP, A2A; licence, free tier or x402) carry
 *     no EPSS and never call FIRST while PG1_SOURCE_EPSS_PAID is off (the
 *     default); turning it on brings EPSS back; free responses (the chat's
 *     read-only runners) always keep it.
 *   - threat_indicators (the 1,474 rows with no source_id): no paid route
 *     ever reads the table.
 *   - Shared free tier: one 5/day counter per caller across /api/mcp and
 *     /api/a2a (and /api/ioc, same lib/freeTier.mjs row).
 *   - A2A paid skills: unpaid -> input-required task carrying the x402
 *     PaymentRequired object (a2a-x402); licence; x402 via message metadata,
 *     settled after the skill succeeds, receipt in the task.
 *   - Unknown tools: -32602 with a did-you-mean suggestion, recorded as
 *     unknown_tool (a caller mistake, not an error).
 *
 * Run with: node --test tests/phase2-funnel.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// P11: these tests are about x402 itself; the payer's sanctions screening
// (lib/screening.mjs) is covered by tests/screening.test.mjs.
const { __setScreeningForTests } = await import('../lib/screening.mjs');
__setScreeningForTests(async () => ({ allowed: true, refused: false, unavailable: false, lists: [], cached: false }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const PAY_TO = '0x000000000000000000000000000000000000dEaD';

function baseEnv() {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.GUMROAD_PRODUCT_ID = 'test-product';
  process.env.X402_PAY_TO_ADDRESS = PAY_TO;
  process.env.TELEMETRY_IP_SALT = 'phase2-test-salt';
  delete process.env.PG1_SOURCE_EPSS_PAID;
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
}
baseEnv();

const mcp = await import('../api/mcp.mjs');
const { default: a2aHandler, A2A_SKILL_TOOLS, A2A_PAID_SKILL_NAMES } = await import('../api/a2a.mjs');
const { FREE_TIER_DAILY_LIMIT, freeTierKey } = await import('../lib/freeTier.mjs');
const { isEpssPaidEnabled } = await import('../lib/sourcePolicy.mjs');
const { suggestToolName } = await import('../lib/toolNames.mjs');

const fakeFacilitator = (calls) => ({
  getSupported: async () => ({ kinds: [{ x402Version: 2, network: 'eip155:8453', scheme: 'exact' }] }),
  verify: async () => { calls.verify++; return { isValid: true }; },
  settle: async () => { calls.settle++; return { success: true, transaction: '0xA2A_TX', network: 'eip155:8453', payer: '0xPayer' }; }
});

// ---------------------------------------------------------------------
// Mocked upstreams
// ---------------------------------------------------------------------

let state;
function resetState() {
  state = { freeTier: new Map(), epssCalls: 0, threatIndicatorReads: 0, telemetry: [], facilitator: { verify: 0, settle: 0 } };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function nvdCve(id) {
  return { id, published: '2021-12-10T00:00:00Z', lastModified: '2024-01-01T00:00:00Z', descriptions: [{ lang: 'en', value: `Description of ${id}` }], metrics: { cvssMetricV31: [{ cvssData: { baseScore: 10, baseSeverity: 'CRITICAL', vectorString: 'CVSS:3.1/AV:N' } }] } };
}

function installFetch() {
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = (options.method || 'GET').toUpperCase();
    if (url.hostname === 'services.nvd.nist.gov') {
      const id = url.searchParams.get('cveId');
      return json({ vulnerabilities: id ? [{ cve: nvdCve(id) }] : [{ cve: nvdCve('CVE-2021-44228') }, { cve: nvdCve('CVE-2021-45046') }] });
    }
    if (url.hostname === 'api.first.org') {
      state.epssCalls++;
      return json({ data: [{ epss: '0.97', percentile: '0.99' }] });
    }
    if (url.hostname === 'www.cisa.gov') return json({ vulnerabilities: [{ cveID: 'CVE-2021-44228', dateAdded: '2021-12-10', requiredAction: 'Patch', dueDate: '2021-12-24' }] });
    if (url.hostname === 'raw.githubusercontent.com') {
      return json({ objects: [{ type: 'intrusion-set', id: 'intrusion-set--1', name: 'APT29', aliases: ['Cozy Bear'], external_references: [{ source_name: 'mitre-attack', external_id: 'G0016' }] }] });
    }
    if (url.hostname === 'api.gumroad.com') return json({ success: true, purchase: {} });
    if (url.pathname === '/rest/v1/threat_indicators') { state.threatIndicatorReads++; return json([]); }
    if (url.pathname === '/rest/v1/free_tier_usage') {
      const id = decodeURIComponent((url.searchParams.get('identifier') || '').replace(/^eq\./, ''));
      if (method === 'GET') return json(state.freeTier.has(id) ? [{ request_count: state.freeTier.get(id) }] : []);
      if (method === 'PATCH') { state.freeTier.set(id, JSON.parse(options.body).request_count); return new Response(null, { status: 204 }); }
      if (method === 'POST') { const b = JSON.parse(options.body); state.freeTier.set(b.identifier, b.request_count); return new Response(null, { status: 201 }); }
    }
    if (url.pathname === '/rest/v1/agent_telemetry') { state.telemetry.push(JSON.parse(options.body)); return new Response(null, { status: 201 }); }
    if (url.pathname.startsWith('/rest/v1/')) return json([]);
    throw new Error(`unexpected fetch in test: ${url.hostname}${url.pathname}`);
  };
}

beforeEach(() => {
  baseEnv();
  resetState();
  installFetch();
  mcp.__setX402FacilitatorForTests(() => fakeFacilitator(state.facilitator));
});
after(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
});

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }
  };
}

const IP = '198.51.100.7';

async function callMcp(name, args, headers = {}) {
  const res = makeRes();
  await mcp.default({ method: 'POST', headers: { 'x-forwarded-for': IP, ...headers }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }, res);
  return res;
}

async function callA2a(skill, args, { headers = {}, metadata } = {}) {
  const res = makeRes();
  const message = { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { skill, arguments: args } }] };
  if (metadata) message.metadata = metadata;
  await a2aHandler({ method: 'POST', headers: { 'x-forwarded-for': IP, ...headers }, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message } } }, res);
  return res;
}

const mcpPayload = (res) => JSON.parse(res.body.result.content[0].text);
const a2aPayload = (res) => res.body.result.artifacts[0].parts[0].data;
const settle = () => new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------
// EPSS
// ---------------------------------------------------------------------

test('EPSS switch: off by default, on only for an explicit true value', () => {
  assert.equal(isEpssPaidEnabled({}), false);
  assert.equal(isEpssPaidEnabled({ PG1_SOURCE_EPSS_PAID: 'banana' }), false);
  assert.equal(isEpssPaidEnabled({ PG1_SOURCE_EPSS_PAID: 'true' }), true);
});

test('paid CVE responses on /api/mcp carry no EPSS and never call FIRST while PG1_SOURCE_EPSS_PAID is off', async () => {
  for (const [tool, args] of [['get_cve_details', { cve_id: 'CVE-2021-44228' }], ['get_cve_batch', { cve_ids: ['CVE-2021-44228', 'CVE-2021-45046'] }], ['get_cve_by_product', { vendor: 'apache', product: 'log4j' }]]) {
    const res = await callMcp(tool, args, { 'x-api-key': 'licence' });
    assert.equal(res.statusCode, 200, tool);
    const body = mcpPayload(res);
    const text = JSON.stringify(body);
    assert.ok(!/"epss"/.test(text), `${tool} has an epss field`);
    assert.ok(!/EPSS/.test(body.attribution), `${tool} credits EPSS`);
    assert.ok(!body.checks.some((c) => c.source === 'exploit prediction score'), `${tool} lists an EPSS check`);
  }
  assert.equal(state.epssCalls, 0);
});

test('free tier and A2A paid calls are paid responses too: no EPSS', async () => {
  const viaFreeTier = await callMcp('get_cve_details', { cve_id: 'CVE-2021-44228' }, { 'x-free-tier': '1' });
  assert.ok(!('epss' in mcpPayload(viaFreeTier)));
  const viaA2a = await callA2a('get_cve_details', { cve_id: 'CVE-2021-44228' }, { headers: { 'x-api-key': 'licence' } });
  assert.ok(!('epss' in a2aPayload(viaA2a)));
  assert.equal(state.epssCalls, 0);
});

test('PG1_SOURCE_EPSS_PAID=true puts EPSS back in paid responses', async () => {
  process.env.PG1_SOURCE_EPSS_PAID = 'true';
  const body = mcpPayload(await callMcp('get_cve_details', { cve_id: 'CVE-2021-44228' }, { 'x-api-key': 'licence' }));
  assert.deepEqual(body.epss, { score: 0.97, percentile: 0.99 });
  assert.match(body.attribution, /EPSS by FIRST/);
  assert.equal(state.epssCalls, 1);
});

test('free responses (the chat\'s read-only runners) keep EPSS', async () => {
  const body = await mcp.runReadOnlyTool('get_cve_details', { cve_id: 'CVE-2021-44228' });
  assert.deepEqual(body.epss, { score: 0.97, percentile: 0.99 });
  assert.match(body.attribution, /EPSS by FIRST/);
});

// ---------------------------------------------------------------------
// threat_indicators: never in a paid response
// ---------------------------------------------------------------------

test('no paid route reads threat_indicators', async () => {
  for (const [tool, args] of [['get_threat_indicators', { limit: 5 }], ['get_ioc_context', { value: '203.0.113.9' }], ['get_ioc_batch', { values: ['203.0.113.9'] }], ['get_cve_details', { cve_id: 'CVE-2021-44228' }], ['get_threat_actor_profile', { actor_name: 'APT29' }]]) {
    await callMcp(tool, args, { 'x-api-key': 'licence' });
  }
  for (const skill of A2A_PAID_SKILL_NAMES) await callA2a(skill, { cve_id: 'CVE-2021-44228', cve_ids: ['CVE-2021-44228'], vendor: 'apache', product: 'log4j', actor_name: 'APT29' }, { headers: { 'x-api-key': 'licence' } });
  assert.equal(state.threatIndicatorReads, 0);
});

test('threat_indicators is read only by operator-only code (diagnostics); the chat reads the feed through the source policy, operator only', () => {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(mjs|js)$/.test(entry.name) && /['"`/]threat_indicators\b/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) hits.push(rel);
    }
  };
  for (const dir of ['api', 'lib']) walk(dir);
  assert.deepEqual(hits.sort(), ['api/diagnostics/system-status-check.js']);
  // The chat's threat context now comes from threat_ioc_telemetry through
  // lib/sourcePolicy.mjs (lib/chatThreatFeed.mjs), still only in the
  // operator-only block.
  const chat = fs.readFileSync(path.join(ROOT, 'api/chat.mjs'), 'utf8');
  const at = chat.indexOf('loadChatThreatFeed({');
  assert.ok(at > 0 && chat.lastIndexOf('if (isOperator && supabaseUrl && supabaseKey)', at) > 0, 'the chat reads it only inside the operator-only block');
  assert.match(fs.readFileSync(path.join(ROOT, 'lib/chatThreatFeed.mjs'), 'utf8'), /fetchThreatTelemetry\(/);
});

// ---------------------------------------------------------------------
// Shared free tier
// ---------------------------------------------------------------------

test(`one ${FREE_TIER_DAILY_LIMIT}/day free-tier counter per caller, shared by /api/mcp and /api/a2a`, async () => {
  const headers = {}; // automatic: no header needed
  const served = [];
  for (let i = 0; i < FREE_TIER_DAILY_LIMIT; i++) {
    const res = i % 2 === 0
      ? await callMcp('get_cve_details', { cve_id: 'CVE-2021-44228' }, headers)
      : await callA2a('get_cve_details', { cve_id: 'CVE-2021-44228' }, { headers });
    served.push(i % 2 === 0 ? !res.body.result.isError : res.body.result.status.state === 'completed');
  }
  assert.deepEqual(served, Array(FREE_TIER_DAILY_LIMIT).fill(true));
  assert.equal(state.freeTier.get(freeTierKey(IP)), FREE_TIER_DAILY_LIMIT);

  const mcpAfter = await callMcp('get_cve_details', { cve_id: 'CVE-2021-44228' }, headers);
  assert.equal(mcpAfter.body.result.isError, true);
  assert.equal(mcpAfter.body.result.structuredContent.x402Version, 2);
  const a2aAfter = await callA2a('get_cve_details', { cve_id: 'CVE-2021-44228' }, { headers });
  assert.equal(a2aAfter.body.result.status.state, 'input-required');

  const usage = mcpPayload(await callMcp('get_usage_status', {}));
  assert.equal(usage.free_tier_calls_remaining_today, 0);
});

test('a failed paid skill does not spend a free-tier call', async () => {
  const res = await callA2a('get_cve_details', { cve_id: 'not-a-cve' }, { headers: { 'x-free-tier': '1' } });
  assert.ok(res.body.error);
  assert.equal(state.freeTier.get(freeTierKey(IP)) || 0, 0);
});

// ---------------------------------------------------------------------
// A2A paid skills
// ---------------------------------------------------------------------

test('A2A exposes the four paid skills and keeps the indicator feed tools MCP-only', () => {
  const names = A2A_SKILL_TOOLS.map((t) => t.name);
  for (const name of ['get_cve_details', 'get_cve_batch', 'get_cve_by_product', 'get_threat_actor_profile']) assert.ok(names.includes(name), name);
  for (const name of ['get_threat_indicators', 'get_ioc_context', 'get_ioc_batch', 'subscribe_alerts', 'submit_indicator']) assert.ok(!names.includes(name), name);
});

for (const version of ['0.3', '1.0']) {
  test(`A2A ${version}: an unpaid paid skill returns an input-required task with the x402 PaymentRequired object`, async () => {
    // X-Free-Tier: 0 so the challenge comes at once (the free tier is automatic).
    const res = await callA2a('get_threat_actor_profile', { actor_name: 'APT29' }, { headers: { 'a2a-version': version, 'x-free-tier': '0' } });
    assert.equal(res.statusCode, 200);
    const task = res.body.result;
    assert.equal(task.status.state, version === '1.0' ? 'TASK_STATE_INPUT_REQUIRED' : 'input-required');
    const meta = task.status.message.metadata;
    assert.equal(meta['x402.payment.status'], 'payment-required');
    const required = meta['x402.payment.required'];
    assert.equal(required.x402Version, 2);
    assert.equal(required.accepts[0].payTo, PAY_TO);
    assert.equal(required.accepts[0].network, 'eip155:8453');
    assert.equal(task.artifacts, undefined, 'no result without payment');
    await settle();
    const row = state.telemetry.find((r) => r.endpoint === '/api/a2a' && r.event_type === 'tool_call');
    assert.equal(row.status, 'payment_required');
    assert.equal(row.payment_type, 'none');
  });
}

test('A2A x402: payment in message metadata is verified, the skill runs, then it is settled and the receipt returned', async () => {
  const unpaid = await callA2a('get_threat_actor_profile', { actor_name: 'APT29' }, { headers: { 'x-free-tier': '0' } });
  const accepted = unpaid.body.result.status.message.metadata['x402.payment.required'].accepts[0];
  const payload = { x402Version: 2, scheme: 'exact', network: 'eip155:8453', accepted, payload: { signature: '0xsig', authorization: { from: '0xPayer', to: accepted.payTo, value: accepted.amount } } };
  const res = await callA2a('get_threat_actor_profile', { actor_name: 'APT29' }, { metadata: { 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': payload } });
  const task = res.body.result;
  assert.equal(task.status.state, 'completed');
  assert.equal(a2aPayload(res).actor_name, 'APT29');
  assert.equal(task.metadata['x402.payment.status'], 'payment-completed');
  assert.equal(task.metadata['x402.payment.receipts'][0].transaction, '0xA2A_TX');
  assert.deepEqual(state.facilitator, { verify: 1, settle: 1 });
  assert.ok(!JSON.stringify(task.history).includes('0xsig'), 'the signed payload is never echoed back');
  await settle();
  const settlement = state.telemetry.find((r) => r.event_type === 'settlement');
  assert.equal(settlement.endpoint, '/api/a2a');
  assert.equal(settlement.status, 'settled');
  assert.equal(Number(settlement.amount_usd), 0.01);
});

test('A2A licence key: served, no free-tier use, no payment', async () => {
  const res = await callA2a('get_cve_batch', { cve_ids: ['CVE-2021-44228'] }, { headers: { 'x-api-key': 'licence' } });
  assert.equal(res.body.result.status.state, 'completed');
  assert.equal(a2aPayload(res).total_found, 1);
  assert.equal(state.freeTier.size, 0);
  assert.deepEqual(state.facilitator, { verify: 0, settle: 0 });
});

test('A2A free skills are unchanged: no gate', async () => {
  const res = await callA2a('get_usage_status', {});
  assert.equal(res.body.result.status.state, 'completed');
});

// ---------------------------------------------------------------------
// Unknown tools
// ---------------------------------------------------------------------

test('suggestToolName: namespaced, dashed, truncated and misspelt names; nothing for noise', () => {
  const names = mcp.TOOLS.map((t) => t.name);
  assert.equal(suggestToolName('pg1-threat-intel:check_domain_age', names), 'check_domain_age');
  assert.equal(suggestToolName('Check-Domain-Age', names), 'check_domain_age');
  assert.equal(suggestToolName('get_threat_actor', names), 'get_threat_actor_profile');
  assert.equal(suggestToolName('check_walet_age', names), 'check_wallet_age');
  assert.equal(suggestToolName('get_cve', names), null, 'ambiguous: three get_cve tools');
  assert.equal(suggestToolName('execute_shell_command', names), null);
});

test('MCP unknown tool: -32602 with a suggestion, never echoing the name, recorded as unknown_tool', async () => {
  const res = await callMcp('pg1:check_walet_age', {});
  assert.equal(res.body.error.code, -32602);
  assert.equal(res.body.error.data.unknown_tool, true);
  assert.equal(res.body.error.data.suggestion, 'check_wallet_age');
  assert.match(res.body.error.message, /Did you mean check_wallet_age\?/);
  assert.ok(!res.body.error.message.includes('walet'));
  await settle();
  const row = state.telemetry.find((r) => r.event_type === 'tool_call');
  assert.equal(row.status, 'unknown_tool');
  assert.equal(row.tool_name, null);
});

test('A2A unknown skill: -32602 with a suggestion, recorded as unknown_tool', async () => {
  const res = await callA2a('get_cve_detail', {});
  assert.equal(res.body.error.code, -32602);
  assert.equal(res.body.error.data.suggestion, 'get_cve_details');
  await settle();
  const row = state.telemetry.find((r) => r.endpoint === '/api/a2a');
  assert.equal(row.status, 'unknown_tool');
  assert.equal(row.requested_tool, 'get_cve_detail');
});

test('tool errors are recorded by fault: invalid_input for caller mistakes', async () => {
  await callMcp('check_wallet_age', { address: 'not-an-address' });
  await settle();
  const row = state.telemetry.find((r) => r.event_type === 'tool_call');
  assert.equal(row.status, 'invalid_input');
});
