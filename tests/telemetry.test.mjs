/**
 * Tests for lib/telemetry.mjs and its wiring into api/mcp.mjs: every MCP
 * tools/call writes one agent_telemetry row (endpoint, tool_name,
 * payment_type, status, latency_ms) and every x402 settle attempt writes
 * one 'settlement' row - and a failing, throwing or unconfigured telemetry
 * write never changes or delays the API response.
 *
 * The x402 facilitator is swapped via __setX402FacilitatorForTests (same
 * seam as tests/mcp-x402-v2.test.mjs); Supabase is a mocked global fetch.
 *
 * Run with: node --test tests/telemetry.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodePaymentSignatureHeader } from '@x402/core/http';

process.env.X402_PAY_TO_ADDRESS = '0x000000000000000000000000000000000000dEaD';
delete process.env.CDP_API_KEY_ID;
delete process.env.CDP_API_KEY_SECRET;

const { default: handler, __setX402FacilitatorForTests } = await import('../api/mcp.mjs');
const { recordTelemetry, buildTelemetryRow } = await import('../lib/telemetry.mjs');

const SUP_URL = 'https://supabase.test';
const TELEMETRY_URL = `${SUP_URL}/rest/v1/agent_telemetry`;

function makeFakeFacilitator({ settle } = {}) {
  return {
    getSupported: async () => ({ kinds: [{ x402Version: 2, network: 'eip155:8453', scheme: 'exact' }] }),
    verify: async () => ({ isValid: true }),
    settle: settle || (async () => ({ success: true, transaction: '0xFAKE_TX', network: 'eip155:8453', payer: '0xPayer' }))
  };
}

beforeEach(() => {
  __setX402FacilitatorForTests(() => makeFakeFacilitator());
});

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    getHeader(key) { return this.headers[key]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
}

async function callTool(name, args, { headers, meta } = {}) {
  const params = { name, arguments: args };
  if (meta) params._meta = meta;
  const req = { method: 'POST', headers: headers || {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params } };
  const res = makeRes();
  await handler(req, res);
  // Let the fire-and-forget telemetry fetch(es) run.
  await new Promise((r) => setImmediate(r));
  return res;
}

// Installs Supabase env + a fetch mock. Telemetry POSTs are captured into
// `rows`; `telemetryBehaviour` lets a test make them fail; anything else is
// handled by `otherFetch` (or rejected).
function setup(t, { telemetryBehaviour = 'ok', otherFetch } = {}) {
  const prev = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, fetch: global.fetch };
  process.env.SUPABASE_URL = SUP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  const rows = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u === TELEMETRY_URL) {
      rows.push(JSON.parse(opts.body));
      if (telemetryBehaviour === 'reject') throw new Error('network down');
      if (telemetryBehaviour === 'http_error') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 201, json: async () => ({}) };
    }
    if (otherFetch) return otherFetch(u, opts);
    throw new Error('unexpected fetch: ' + u);
  };
  t.after(() => {
    if (prev.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prev.url;
    if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
    global.fetch = prev.fetch;
  });
  return rows;
}

function attackBundleFetch(u) {
  if (u.includes('mitre/cti')) {
    return {
      ok: true,
      json: async () => ({ objects: [{ type: 'intrusion-set', id: 'intrusion-set--1', name: 'APT29', aliases: ['Cozy Bear'], external_references: [{ source_name: 'mitre-attack', external_id: 'G0016' }] }] })
    };
  }
  throw new Error('unexpected fetch: ' + u);
}

function usageFetch(u) {
  if (u.includes('/rest/v1/free_tier_usage')) return { ok: true, json: async () => [{ request_count: 2 }] };
  throw new Error('unexpected fetch: ' + u);
}

async function paymentFor(toolName, args) {
  const unpaid = await callTool(toolName, args);
  const accepted = unpaid.body.result.structuredContent.accepts[0];
  return {
    x402Version: 2,
    accepted,
    payload: { signature: '0xsig', authorization: { from: '0xPayer', to: accepted.payTo, value: accepted.amount } }
  };
}

function assertRowShape(row) {
  assert.deepEqual(Object.keys(row).sort(), ['endpoint', 'event_type', 'latency_ms', 'payment_type', 'status', 'tool_name']);
  assert.equal(row.endpoint, '/api/mcp');
  assert.ok(Number.isInteger(row.latency_ms) && row.latency_ms >= 0);
}

// --- lib/telemetry.mjs unit tests --------------------------------------

test('buildTelemetryRow keeps the known fields and normalises unknown enums', () => {
  assert.deepEqual(
    buildTelemetryRow({ eventType: 'settlement', endpoint: '/api/mcp', toolName: 'get_cve_details', paymentType: 'x402', status: 'settled', latencyMs: 12.6 }),
    { event_type: 'settlement', endpoint: '/api/mcp', tool_name: 'get_cve_details', payment_type: 'x402', status: 'settled', latency_ms: 13 }
  );
  assert.deepEqual(
    buildTelemetryRow({ eventType: 'bogus', paymentType: 'bitcoin', latencyMs: -5 }),
    { event_type: 'tool_call', endpoint: 'unknown', tool_name: null, payment_type: 'none', status: 'unknown', latency_ms: null }
  );
  assert.equal(buildTelemetryRow({ toolName: 'x'.repeat(500) }).tool_name.length, 80);
});

test('recordTelemetry posts one row to agent_telemetry with the service-role key', async (t) => {
  let captured;
  const prev = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, fetch: global.fetch };
  process.env.SUPABASE_URL = SUP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  global.fetch = async (url, opts) => { captured = { url, opts }; return { ok: true }; };
  t.after(() => {
    if (prev.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prev.url;
    if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
    global.fetch = prev.fetch;
  });

  await recordTelemetry({ endpoint: '/api/mcp', toolName: 'get_usage_status', paymentType: 'free', status: 'ok', latencyMs: 4 });

  assert.equal(captured.url, TELEMETRY_URL);
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers.apikey, 'service-role-test');
  assert.equal(captured.opts.headers.Prefer, 'return=minimal');
  assert.deepEqual(JSON.parse(captured.opts.body), { event_type: 'tool_call', endpoint: '/api/mcp', tool_name: 'get_usage_status', payment_type: 'free', status: 'ok', latency_ms: 4 });
});

test('recordTelemetry fails silently: unconfigured, rejecting fetch, throwing fetch, non-2xx', async (t) => {
  const prev = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, keyAlt: process.env.SUPABASEAPI_KEY, fetch: global.fetch };
  t.after(() => {
    if (prev.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prev.url;
    if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
    if (prev.keyAlt === undefined) delete process.env.SUPABASEAPI_KEY; else process.env.SUPABASEAPI_KEY = prev.keyAlt;
    global.fetch = prev.fetch;
  });

  delete process.env.SUPABASE_URL;
  let called = false;
  global.fetch = async () => { called = true; return { ok: true }; };
  await recordTelemetry({ endpoint: '/api/mcp', status: 'ok' });
  assert.equal(called, false, 'no write without Supabase config');

  process.env.SUPABASE_URL = SUP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  for (const impl of [
    async () => { throw new Error('network down'); },
    () => { throw new Error('sync throw'); },
    async () => ({ ok: false, status: 500 })
  ]) {
    global.fetch = impl;
    assert.doesNotThrow(() => recordTelemetry({ endpoint: '/api/mcp', status: 'ok' }));
    await assert.doesNotReject(recordTelemetry({ endpoint: '/api/mcp', status: 'ok' }));
  }
});

// --- api/mcp.mjs wiring ------------------------------------------------

test('free tool call records a tool_call row with payment_type free and status ok', async (t) => {
  const rows = setup(t, { otherFetch: usageFetch });
  const res = await callTool('get_usage_status', { identifier: 'agent-1' });

  assert.equal(res.statusCode, 200);
  assert.equal(rows.length, 1);
  assertRowShape(rows[0]);
  assert.equal(rows[0].event_type, 'tool_call');
  assert.equal(rows[0].tool_name, 'get_usage_status');
  assert.equal(rows[0].payment_type, 'free');
  assert.equal(rows[0].status, 'ok');
});

test('unpaid call to a paid tool records status payment_required, payment_type none', async (t) => {
  const rows = setup(t, { otherFetch: attackBundleFetch });
  const res = await callTool('get_threat_actor_profile', { actor_name: 'APT29' });

  assert.equal(res.body.result.isError, true);
  assert.equal(rows.length, 1);
  assertRowShape(rows[0]);
  assert.equal(rows[0].tool_name, 'get_threat_actor_profile');
  assert.equal(rows[0].payment_type, 'none');
  assert.equal(rows[0].status, 'payment_required');
});

test('paid x402 call records a settlement row and an x402 tool_call row', async (t) => {
  const rows = setup(t, { otherFetch: attackBundleFetch });
  const payment = await paymentFor('get_threat_actor_profile', { actor_name: 'APT29' });
  rows.length = 0;

  const res = await callTool('get_threat_actor_profile', { actor_name: 'APT29' }, { meta: { 'x402/payment': payment } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result._meta['x402/payment-response'].transaction, '0xFAKE_TX');
  assert.equal(rows.length, 2);
  rows.forEach(assertRowShape);
  const settlement = rows.find((r) => r.event_type === 'settlement');
  const call = rows.find((r) => r.event_type === 'tool_call');
  assert.deepEqual({ ...settlement, latency_ms: 0 }, { event_type: 'settlement', endpoint: '/api/mcp', tool_name: 'get_threat_actor_profile', payment_type: 'x402', status: 'settled', latency_ms: 0 });
  assert.equal(call.payment_type, 'x402');
  assert.equal(call.status, 'ok');
});

test('failed settlement (header payment) records settlement failed and tool_call settlement_failed', async (t) => {
  const rows = setup(t, { otherFetch: attackBundleFetch });
  __setX402FacilitatorForTests(() => makeFakeFacilitator({ settle: async () => ({ success: false, errorReason: 'insufficient_funds', transaction: '', network: 'eip155:8453' }) }));
  const payment = await paymentFor('get_threat_actor_profile', { actor_name: 'APT29' });
  rows.length = 0;

  const res = await callTool('get_threat_actor_profile', { actor_name: 'APT29' }, { headers: { 'payment-signature': encodePaymentSignatureHeader(payment) } });

  assert.equal(res.body.result.isError, true);
  const settlement = rows.find((r) => r.event_type === 'settlement');
  const call = rows.find((r) => r.event_type === 'tool_call');
  assert.equal(settlement.status, 'failed');
  assert.equal(call.payment_type, 'x402');
  assert.equal(call.status, 'settlement_failed');
});

test('throwing settle records settlement status error', async (t) => {
  const rows = setup(t, { otherFetch: attackBundleFetch });
  __setX402FacilitatorForTests(() => makeFakeFacilitator({ settle: async () => { throw new Error('facilitator down'); } }));
  const payment = await paymentFor('get_threat_actor_profile', { actor_name: 'APT29' });
  rows.length = 0;

  await callTool('get_threat_actor_profile', { actor_name: 'APT29' }, { meta: { 'x402/payment': payment } });

  assert.equal(rows.find((r) => r.event_type === 'settlement').status, 'error');
  assert.equal(rows.find((r) => r.event_type === 'tool_call').status, 'settlement_failed');
});

test('unknown tool name is never stored (caller input) - status unknown_tool', async (t) => {
  const rows = setup(t);
  await callTool('drop_table_users; --', {});

  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool_name, null);
  assert.equal(rows[0].status, 'unknown_tool');
});

test('non-tools/call methods record nothing', async (t) => {
  const rows = setup(t);
  const res = makeRes();
  await handler({ method: 'POST', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, res);
  await new Promise((r) => setImmediate(r));
  assert.equal(res.statusCode, 200);
  assert.equal(rows.length, 0);
});

for (const behaviour of ['reject', 'http_error']) {
  test(`telemetry write failure (${behaviour}) leaves the paid response unchanged`, async (t) => {
    const rows = setup(t, { telemetryBehaviour: behaviour, otherFetch: attackBundleFetch });
    const payment = await paymentFor('get_threat_actor_profile', { actor_name: 'APT29' });

    const res = await callTool('get_threat_actor_profile', { actor_name: 'APT29' }, { meta: { 'x402/payment': payment } });

    assert.ok(rows.length > 0, 'telemetry was attempted');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.result.isError, undefined);
    assert.equal(res.body.result._meta['x402/payment-response'].transaction, '0xFAKE_TX');
  });
}

test('telemetry write is not awaited: a hanging Supabase insert does not block the response', async (t) => {
  const prev = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, fetch: global.fetch };
  process.env.SUPABASE_URL = SUP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  global.fetch = async (url) => {
    if (String(url) === TELEMETRY_URL) return new Promise(() => {}); // never settles
    return usageFetch(String(url));
  };
  t.after(() => {
    if (prev.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prev.url;
    if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
    global.fetch = prev.fetch;
  });

  const res = makeRes();
  await handler({ method: 'POST', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_usage_status', arguments: { identifier: 'agent-1' } } } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.result);
});
