/**
 * check_wallet_sanctions on /api/a2a and /api/mcp: per-IP limit of
 * WALLET_SANCTIONS_RATE_LIMIT_MAX (120) calls/hour without a licence key,
 * one counter per IP across both endpoints, reported with the same
 * rate_limited error shape as check_wallet_age. Fixture inputs never count,
 * valid licence keys are exempt, other IPs are unaffected, and the tool
 * definitions are byte-for-byte what they were before the limit.
 * While licence sales are paused, no rate-limit message suggests getting a
 * licence key: it gives the retry time only.
 * Run with: node --test tests/wallet-sanctions-rate-limit.test.mjs
 */

import { test } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import a2aHandler, { A2A_SKILL_TOOLS } from '../api/a2a.mjs';
import mcpHandler, { resolveTestFixture, TOOLS } from '../api/mcp.mjs';
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
  assert.match(limited.body.error.message, /^check_wallet_sanctions is limited to 120 calls\/hour per caller\. Retry in about \d+ minute\(s\)\.$/);
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

async function mcp(name, args, ip, extraHeaders = {}) {
  const res = makeRes();
  await mcpHandler({
    method: 'POST',
    headers: { 'x-forwarded-for': ip, ...extraHeaders },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
  }, res);
  return res;
}
const mcpSanctions = (ip, address = ADDRESS, headers) => mcp('check_wallet_sanctions', { address }, ip, headers);
const mcpPayload = (res) => JSON.parse(res.body.result.content[0].text);
const mcpRateLimited = (res) => res.body.result?.isError === true && mcpPayload(res).code === 'rate_limited';

// No rate-limit message may point at getting a licence key while sales are
// paused: the limit and the retry time, nothing else.
const RETRY_ONLY = (tool, max) => new RegExp(`^${tool} is limited to ${max} calls/hour per caller\\. Retry in about \\d+ minute\\(s\\)\\.`);
function assertNoLicencePitch(message) {
  assert.doesNotMatch(message, /licen[cs]e|gumroad|x-api-key|bypass|buy|purchase/i, message);
}

test('MCP: the 121st call in an hour from one IP gets rate_limited, in the wallet age error shape', async (t) => {
  const calls = withSanctionsBackend(t);
  const ip = '203.0.113.60';
  for (let i = 1; i <= WALLET_SANCTIONS_RATE_LIMIT_MAX; i++) {
    const res = await mcpSanctions(ip);
    assert.equal(res.statusCode, 200, `call ${i}`);
    assert.ok(!res.body.result.isError, `call ${i} should be a real answer`);
    assert.equal(res.body.result.structuredContent.listed, false);
  }
  assert.equal(calls.lookups, WALLET_SANCTIONS_RATE_LIMIT_MAX);

  const limited = await mcpSanctions(ip);
  assert.equal(calls.lookups, WALLET_SANCTIONS_RATE_LIMIT_MAX, 'a limited call makes no lookup');
  assert.equal(limited.statusCode, 200);
  assert.ok(mcpRateLimited(limited));
  const payload = mcpPayload(limited);
  assert.match(payload.message, RETRY_ONLY('check_wallet_sanctions', WALLET_SANCTIONS_RATE_LIMIT_MAX));
  assertNoLicencePitch(payload.message);
  assert.equal(payload.status, 'unknown');
  assert.equal(payload.checks[0].source, 'sanctions list');

  // Same isError payload as check_wallet_age's rate_limited result.
  const ageIp = '203.0.113.61';
  let ageLimited;
  for (let i = 0; i <= WALLET_AGE_RATE_LIMIT_MAX; i++) ageLimited = await mcp('check_wallet_age', { address: ADDRESS }, ageIp);
  assert.ok(mcpRateLimited(ageLimited));
  const agePayload = mcpPayload(ageLimited);
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(agePayload).sort());
  assert.equal(payload.error, agePayload.error);
  assert.equal(payload.status, agePayload.status);
  assert.deepEqual(payload.reasons, agePayload.reasons);
  assert.equal(payload.checks[0].result, agePayload.checks[0].result);
  assert.equal(limited.body.result.structuredContent, undefined);
});

test('MCP: other IPs are unaffected', async (t) => {
  withSanctionsBackend(t);
  const busy = '203.0.113.62';
  for (let i = 0; i < WALLET_SANCTIONS_RATE_LIMIT_MAX; i++) await mcpSanctions(busy);
  assert.ok(mcpRateLimited(await mcpSanctions(busy)));
  assert.ok(!(await mcpSanctions('203.0.113.63')).body.result.isError);
});

test('MCP: fixture inputs do not count against the limit, and still answer once it is reached', async (t) => {
  withSanctionsBackend(t);
  const ip = '203.0.113.64';
  const fixtures = Object.values(FIXTURE_VALUES.wallet).filter((address) => resolveTestFixture('check_wallet_sanctions', { address }));
  for (let i = 0; i < WALLET_SANCTIONS_RATE_LIMIT_MAX * 2; i++) {
    assert.ok(!mcpRateLimited(await mcpSanctions(ip, fixtures[i % fixtures.length])), `fixture call ${i + 1}`);
  }
  for (let i = 1; i <= WALLET_SANCTIONS_RATE_LIMIT_MAX; i++) {
    assert.ok(!mcpRateLimited(await mcpSanctions(ip)), `real call ${i}`);
  }
  assert.ok(mcpRateLimited(await mcpSanctions(ip)));
  const fixture = await mcpSanctions(ip, FIXTURE_VALUES.wallet.FLAGGED);
  assert.equal(fixture.body.result.structuredContent.test_fixture, true);
});

test('MCP: a valid licence key is exempt', async (t) => {
  withSanctionsBackend(t, { licenceValid: true });
  const ip = '203.0.113.65';
  for (let i = 0; i <= WALLET_SANCTIONS_RATE_LIMIT_MAX; i++) {
    const res = await mcpSanctions(ip, ADDRESS, { 'x-api-key': 'valid-licence' });
    assert.ok(!res.body.result.isError, `licensed call ${i + 1}`);
  }
});

test('MCP: an invalid licence key gets no exemption', async (t) => {
  withSanctionsBackend(t, { licenceValid: false });
  const ip = '203.0.113.66';
  for (let i = 0; i < WALLET_SANCTIONS_RATE_LIMIT_MAX; i++) await mcpSanctions(ip, ADDRESS, { 'x-api-key': 'bad-licence' });
  assert.ok(mcpRateLimited(await mcpSanctions(ip, ADDRESS, { 'x-api-key': 'bad-licence' })));
});

test('one counter per IP across /api/a2a and /api/mcp, as for check_wallet_age', async (t) => {
  withSanctionsBackend(t);
  const ip = '203.0.113.67';
  for (let i = 0; i < WALLET_SANCTIONS_RATE_LIMIT_MAX / 2; i++) {
    await sanctions(ip);
    await mcpSanctions(ip);
  }
  assert.ok(isRateLimited(await sanctions(ip)));
  assert.ok(mcpRateLimited(await mcpSanctions(ip)));
});

test('rate-limit messages give the retry time only, never a licence-key pitch (A2A and MCP)', async (t) => {
  withSanctionsBackend(t);
  const checks = [
    ['check_wallet_sanctions', WALLET_SANCTIONS_RATE_LIMIT_MAX, '203.0.113.70', '203.0.113.71'],
    ['check_wallet_age', WALLET_AGE_RATE_LIMIT_MAX, '203.0.113.72', '203.0.113.73']
  ];
  for (const [tool, max, a2aIp, mcpIp] of checks) {
    let viaA2a;
    let viaMcp;
    for (let i = 0; i <= max; i++) {
      viaA2a = await a2a(tool, { address: ADDRESS }, a2aIp);
      viaMcp = await mcp(tool, { address: ADDRESS }, mcpIp);
    }
    assert.ok(isRateLimited(viaA2a), `${tool} over A2A`);
    assert.ok(mcpRateLimited(viaMcp), `${tool} over MCP`);
    for (const message of [viaA2a.body.error.message, mcpPayload(viaMcp).message]) {
      assert.match(message, RETRY_ONLY(tool, max));
      assertNoLicencePitch(message);
    }
  }
});

test('tool definitions are hash-identical to before the limit (name, description, schema)', () => {
  // SHA-256 of JSON.stringify(...) on main before this change. If a later,
  // deliberate tool change moves these, update them with that change.
  const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
  assert.equal(sha(TOOLS.find((t) => t.name === 'check_wallet_sanctions')), 'ea52c85a8e61a2718a5eceb0f61fd73320d1b57f77110c89bc8ec372edfbd0c7');
  // Moved by the 1.15.0 licensing release (three description edits, see
  // tests/source-policy.test.mjs).
  // 1.16.0 added check_ip_abuse at the end of both lists; everything before
  // it is still pinned to the same hashes.
  // check_package (also 1.16.0) is left out the same way.
  const added = new Set(['check_ip_abuse', 'check_package']);
  assert.equal(sha(TOOLS.filter((t) => !added.has(t.name))), 'a177e3276b64a976e1b3a8412e77418e7846bf532379c8c9129882aff3488f06');
  assert.equal(sha(A2A_SKILL_TOOLS.filter((t) => !added.has(t.name))), '188ab4f12daf429bd01e91689d29d682307afb6e27aae596a0e7324dbb6a2c3d');
});
