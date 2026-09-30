/**
 * Tests for "fix-it" invalid-input messages (issue #215 part B, item 4):
 * every invalid-input error keeps its existing error code but its message
 * says what was wrong, the expected format, one valid example and the
 * request_id - and never echoes the caller's raw input back.
 * Run with: node --test tests/invalid-input-messages.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import mcpHandler from '../api/mcp.mjs';
import a2aHandler from '../api/a2a.mjs';

// A distinctive raw input that must never appear in any error message.
const MARKER = 'ZZMARKER<b>secret</b>';

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
}

async function callMcp(name, args, headers) {
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: headers || {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }, res);
  return res;
}

async function callA2a(parts, headers) {
  const res = makeRes();
  await a2aHandler({ method: 'POST', headers: headers || {}, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm1', parts } } } }, res);
  return res;
}

function withEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

function withFetch(t, impl) {
  const original = global.fetch;
  global.fetch = impl;
  t.after(() => { global.fetch = original; });
}

function assertFixIt(message, res, label) {
  const requestId = res.headers['X-Request-Id'];
  assert.ok(requestId, label);
  assert.equal(typeof message, 'string', label);
  assert.ok(!message.includes('ZZMARKER'), `${label}: must not echo raw input: ${message}`);
  assert.ok(!message.includes('secret'), `${label}: must not echo raw input: ${message}`);
  assert.match(message, / Expected: .+\. Example: .+\. request_id: /, `${label}: ${message}`);
  assert.ok(message.endsWith(`request_id: ${requestId}`), `${label}: must end with this request's id: ${message}`);
}

test('MCP -32602 invalid-input errors carry a fix-it message and keep their code', async (t) => {
  withEnv(t, { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
  const cases = [
    ['check_wallet_sanctions', { address: 12345 }],
    ['check_domain_age', {}],
    ['get_ioc_context', {}],
    ['get_ioc_batch', { values: MARKER }],
    ['get_ioc_batch', { values: [] }],
    ['get_ioc_batch', { values: Array.from({ length: 21 }, (_, i) => `${MARKER}${i}`) }],
    [MARKER, {}]
  ];
  for (const [name, args] of cases) {
    const res = await callMcp(name, args);
    const label = `${name.slice(0, 30)} ${JSON.stringify(args).slice(0, 40)}`;
    assert.equal(res.body.error.code, -32602, label);
    assertFixIt(res.body.error.message, res, label);
  }
});

test('MCP isError invalid-input tool results keep their code and carry a fix-it message', async (t) => {
  withEnv(t, { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  // check_wallet_sanctions only rejects an unrecognised format after the
  // sanctions table has been read (a live match always wins), so answer
  // the sync-time read and an empty match.
  withFetch(t, async (url) => {
    const u = String(url);
    if (u.includes('order=updated_at.desc')) return { ok: true, json: async () => [{ updated_at: '2026-09-30T00:00:00Z' }] };
    if (u.includes('sanctioned_wallets')) return { ok: true, json: async () => [] };
    return { ok: false, json: async () => ({}) };
  });

  const cases = [
    ['check_wallet_sanctions', { address: MARKER }, 'invalid_address'],
    ['check_wallet_sanctions', { address: '   ' }, 'invalid_address'],
    ['check_wallet_age', { address: MARKER }, 'invalid_address'],
    ['check_wallet_age', { address: '0x' + 'a'.repeat(40), chain: MARKER }, 'invalid_chain'],
    ['check_hostname_reputation', { hostname: `https://${MARKER}/x` }, 'invalid_hostname'],
    ['check_hostname_reputation', { hostname: `${MARKER} other.com` }, 'invalid_hostname'],
    ['check_hostname_reputation', { hostname: `*.${MARKER}` }, 'invalid_hostname'],
    ['check_hostname_reputation', { hostname: `ZZMARKER.com:8080` }, 'invalid_hostname'],
    ['check_hostname_reputation', { hostname: 'ZZMARKER_secret.com' }, 'invalid_hostname'],
    ['check_hostname_reputation', { hostname: '' }, 'invalid_hostname']
  ];
  for (const [name, args, code] of cases) {
    const res = await callMcp(name, args);
    const label = `${name} ${JSON.stringify(args)}`;
    assert.equal(res.body.result.isError, true, label);
    const parsed = JSON.parse(res.body.result.content[0].text);
    assert.equal(parsed.code, code, label);
    assertFixIt(parsed.message, res, label);
  }
});

test('MCP paid-tool invalid input (after a valid licence) keeps its code and carries a fix-it message', async (t) => {
  withFetch(t, async (url) => {
    if (String(url).includes('gumroad')) return { ok: true, json: async () => ({ success: true, purchase: {} }) };
    throw new Error('unexpected fetch ' + url);
  });
  const headers = { 'x-api-key': 'valid-test-licence' };
  const cveDetails = await callMcp('get_cve_details', { cve_id: MARKER }, headers);
  assert.equal(cveDetails.statusCode, 404);
  assert.equal(cveDetails.body.error.code, -32004, 'existing code kept');
  assertFixIt(cveDetails.body.error.message, cveDetails, 'get_cve_details');

  for (const [name, args] of [
    ['get_cve_batch', { cve_ids: MARKER }],
    ['get_cve_batch', { cve_ids: Array.from({ length: 21 }, () => MARKER) }],
    ['get_cve_by_product', { vendor: MARKER }],
    ['get_threat_actor_profile', { actor_name: '   ' }],
    ['subscribe_alerts', { webhook_url: `http://${MARKER}` }],
    ['submit_indicator', { indicator: MARKER }]
  ]) {
    const res = await callMcp(name, args, headers);
    assert.equal(res.body.error.code, -32602, name);
    assertFixIt(res.body.error.message, res, name);
  }
});

test('A2A invalid-input errors carry a fix-it message and keep their code', async (t) => {
  withEnv(t, { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
  const unknownSkill = await callA2a([{ kind: 'data', data: { skill: MARKER, arguments: {} } }]);
  assert.equal(unknownSkill.body.error.code, -32602);
  assert.match(unknownSkill.body.error.message, /Unknown skill/);
  assertFixIt(unknownSkill.body.error.message, unknownSkill, 'unknown skill');

  const noDataPart = await callA2a([{ kind: 'text', text: MARKER }]);
  assert.equal(noDataPart.body.error.code, -32602);
  assertFixIt(noDataPart.body.error.message, noDataPart, 'no DataPart');

  const missingDomain = await callA2a([{ kind: 'data', data: { skill: 'check_domain_age', arguments: {} } }]);
  assert.equal(missingDomain.body.error.code, -32602);
  assertFixIt(missingDomain.body.error.message, missingDomain, 'check_domain_age missing domain');

  const badAddress = await callA2a([{ kind: 'data', data: { skill: 'check_wallet_age', arguments: { address: MARKER } } }]);
  assert.equal(badAddress.body.error.code, -32000);
  assert.equal(badAddress.body.error.data.code, 'invalid_address');
  assertFixIt(badAddress.body.error.message, badAddress, 'check_wallet_age bad address');
});

test('non-input errors (rate limit, upstream failure) are not rewritten', async (t) => {
  withEnv(t, { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined, ALCHEMY_API_KEY: undefined });
  const res = await callMcp('check_wallet_age', { address: '0x' + 'f'.repeat(40) }, { 'x-forwarded-for': '203.0.113.200' });
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'upstream_unavailable');
  assert.equal(parsed.message, 'Wallet age lookups are not configured on this deployment.');
});
