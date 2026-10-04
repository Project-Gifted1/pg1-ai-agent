/**
 * check_wallet_sanctions on /api/a2a: per-IP limit of
 * WALLET_SANCTIONS_RATE_LIMIT_MAX (120) calls/hour without a licence key,
 * reported with the same rate_limited error shape as check_wallet_age.
 * Fixture inputs never count, other IPs are unaffected, and the MCP tool
 * itself stays unlimited.
 * Run with: node --test tests/a2a-sanctions-rate-limit.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import a2aHandler from '../api/a2a.mjs';
import mcpHandler, { resolveTestFixture } from '../api/mcp.mjs';
import { FIXTURE_VALUES } from '../lib/fixtures.mjs';
import { WALLET_SANCTIONS_RATE_LIMIT_MAX, WALLET_AGE_RATE_LIMIT_MAX } from '../lib/x402Config.mjs';

const ADDRESS = '0x' + 'ab'.repeat(20);

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; }
  };
}

function sendBody(skill, args) {
  return {
    jsonrpc: '2.0', id: 1, method: 'message/send',
    params: { message: { role: 'user', messageId: 'msg-1', parts: [{ kind: 'data', data: { skill, arguments: args } }] } }
  };
}

async function a2a(skill, args, ip, extraHeaders = {}) {
  const res = makeRes();
  await a2aHandler({ method: 'POST', headers: { 'x-forwarded-for': ip, ...extraHeaders }, query: {}, body: sendBody(skill, args) }, res);
  return res;
}

const sanctions = (ip, address = ADDRESS, headers) => a2a('check_wallet_sanctions', { address }, ip, headers);
const isRateLimited = (res) => res.body.error?.data?.code === 'rate_limited';

// A reachable, non-empty sanctions list with no match: every real call
// succeeds with listed:false unless the limiter stops it first.
function withSanctionsBackend(t, { licenceValid = false } = {}) {
  const prev = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, fetch: global.fetch };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const calls = { lookups: 0 };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.gumroad.com/v2/licenses/verify')) {
      return { ok: true, json: async () => (licenceValid ? { success: true, purchase: {} } : { success: false }) };
    }
    if (u.includes('/rest/v1/sanctioned_wallets?select=updated_at')) {
      return { ok: true, json: async () => [{ updated_at: '2026-01-01T00:00:00.000Z' }] };
    }
    if (u.includes('/rest/v1/sanctioned_wallets?address_normalized=')) {
      calls.lookups += 1;
      return { ok: true, json: async () => [] };
    }
    throw new Error('unexpected fetch: ' + u);
  };
  t.after(() => {
    if (prev.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prev.url;
    if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
    global.fetch = prev.fetch;
  });
  return calls;
}

test('the limit is 120/hour, defined next to the other limits', () => {
  assert.equal(WALLET_SANCTIONS_RATE_LIMIT_MAX, 120);
});

test('the 121st call in an hour from one IP gets rate_limited, in the wallet age error shape', async (t) => {
  const calls = withSanctionsBackend(t);
  const ip = '203.0.113.10';
  for (let i = 1; i <= WALLET_SANCTIONS_RATE_LIMIT_MAX; i++) {
    const res = await sanctions(ip);
    assert.equal(res.statusCode, 200, `call ${i}`);
    assert.equal(res.body.result.artifacts[0].parts[0].data.listed, false, `call ${i} should be a real answer`);
  }
  assert.equal(calls.lookups, WALLET_SANCTIONS_RATE_LIMIT_MAX);

  const limited = await sanctions(ip);
  assert.equal(calls.lookups, WALLET_SANCTIONS_RATE_LIMIT_MAX, 'a limited call makes no lookup');
  assert.equal(limited.statusCode, 200);
  assert.equal(limited.body.error.code, -32000);
  assert.equal(limited.body.error.data.code, 'rate_limited');
  assert.equal(limited.body.error.data.status, 'unknown');
  assert.match(limited.body.error.message, /^check_wallet_sanctions is limited to 120 calls\/hour per caller\. Retry in about \d+ minute\(s\)/);
  assert.ok(limited.body.error.data.request_id);
  assert.equal(limited.headers['X-Request-Id'], limited.body.error.data.request_id);

  // Same envelope as check_wallet_age's rate_limited error, key for key.
  const ageIp = '203.0.113.11';
  let ageLimited;
  for (let i = 0; i <= WALLET_AGE_RATE_LIMIT_MAX; i++) ageLimited = await a2a('check_wallet_age', { address: ADDRESS }, ageIp);
  assert.equal(ageLimited.body.error.data.code, 'rate_limited');
  assert.equal(limited.statusCode, ageLimited.statusCode);
  assert.equal(limited.body.error.code, ageLimited.body.error.code);
  assert.deepEqual(Object.keys(limited.body.error.data).sort(), Object.keys(ageLimited.body.error.data).sort());
  assert.equal(limited.body.error.data.status, ageLimited.body.error.data.status);
  assert.deepEqual(limited.body.error.data.reasons, ageLimited.body.error.data.reasons);
  assert.equal(limited.body.error.data.checks[0].source, 'sanctions list');
  assert.equal(limited.body.error.data.checks[0].result, ageLimited.body.error.data.checks[0].result);
});

test('other IPs are unaffected by one IP hitting the limit', async (t) => {
  withSanctionsBackend(t);
  const busy = '203.0.113.20';
  for (let i = 0; i < WALLET_SANCTIONS_RATE_LIMIT_MAX; i++) await sanctions(busy);
  assert.ok(isRateLimited(await sanctions(busy)));

  const other = await sanctions('203.0.113.21');
  assert.equal(other.statusCode, 200);
  assert.equal(other.body.result.artifacts[0].parts[0].data.listed, false);
});

test('fixture inputs do not count against the limit, and still answer once it is reached', async (t) => {
  withSanctionsBackend(t);
  const ip = '203.0.113.30';
  // Only the addresses that are sanctions fixtures (DELEGATED is a real
  // sanctions lookup, so it counts like any other address).
  const fixtures = Object.values(FIXTURE_VALUES.wallet).filter((address) => resolveTestFixture('check_wallet_sanctions', { address }));
  assert.equal(fixtures.length, 3);
  for (let i = 0; i < WALLET_SANCTIONS_RATE_LIMIT_MAX * 2; i++) {
    const res = await sanctions(ip, fixtures[i % fixtures.length]);
    assert.ok(!isRateLimited(res), `fixture call ${i + 1} must not be rate limited`);
  }
  // The whole real budget is still there.
  for (let i = 1; i <= WALLET_SANCTIONS_RATE_LIMIT_MAX; i++) {
    assert.ok(!isRateLimited(await sanctions(ip)), `real call ${i}`);
  }
  assert.ok(isRateLimited(await sanctions(ip)));

  const fixture = await sanctions(ip, FIXTURE_VALUES.wallet.FLAGGED);
  assert.equal(fixture.statusCode, 200);
  assert.equal(fixture.body.result.artifacts[0].parts[0].data.test_fixture, true);
});

test('a valid licence key is exempt, as with check_wallet_age', async (t) => {
  withSanctionsBackend(t, { licenceValid: true });
  const ip = '203.0.113.40';
  for (let i = 0; i <= WALLET_SANCTIONS_RATE_LIMIT_MAX; i++) {
    assert.ok(!isRateLimited(await sanctions(ip, ADDRESS, { 'x-api-key': 'valid-licence' })), `licensed call ${i + 1}`);
  }
});

test('the MCP check_wallet_sanctions tool is not rate limited', async (t) => {
  withSanctionsBackend(t);
  for (let i = 0; i <= WALLET_SANCTIONS_RATE_LIMIT_MAX; i++) {
    const res = makeRes();
    await mcpHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.50' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_wallet_sanctions', arguments: { address: ADDRESS } } }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.result.isError, `MCP call ${i + 1} should not be an error`);
  }
});
