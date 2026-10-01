/**
 * Tests for the integration test fixture behaviour in api/mcp.mjs and
 * api/a2a.mjs (issue #215 part B, item 2): every fixture returns its
 * expected result over MCP (and, for the 4 fixture-bearing skills, over
 * A2A); fixture calls are free and never touch upstream data sources, any
 * cache, the rate limiter, the x402 payment gate, the licence check or the
 * error log (proved with a fetch spy, which every one of those except the
 * rate limiter and payment gate goes through, an x402 facilitator spy, and
 * a rate-limit exhaustion check); UNKNOWN fixtures reproduce a real
 * upstream failure's shape; and a near-miss value is treated as a real
 * input.
 * Run with: node --test tests/fixtures-dispatch.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_FIXTURES, FIXTURE_VALUES, FIXTURE_DELEGATE_ADDRESS, A2A_FIXTURE_SKILLS, FIXTURE_DOMAIN_FLAGGED_AGE_DAYS, fixtureDaysAgoMidnightUtc } from '../lib/fixtures.mjs';

// api/mcp.mjs reads X402_PAY_TO_ADDRESS at module load, and only then does a
// paid call ever reach the facilitator - set it first so the facilitator spy
// below would genuinely see any payment-gate activity.
process.env.X402_PAY_TO_ADDRESS = '0x1111111111111111111111111111111111111111';
const mcp = await import('../api/mcp.mjs');
const { default: mcpHandler, __setX402FacilitatorForTests } = mcp;
const { default: a2aHandler } = await import('../api/a2a.mjs');

let facilitatorCalls = 0;
__setX402FacilitatorForTests(() => {
  facilitatorCalls += 1;
  throw new Error('facilitator spy: payment gate reached');
});

const STRUCTURED_CONTENT_TOOLS = new Set(['check_wallet_sanctions', 'check_domain_age', 'check_hostname_reputation', 'check_wallet_age']);
const SERVICE_UNAVAILABLE_MCP_CODES = { check_wallet_sanctions: -32003, check_hostname_reputation: -32003, get_ioc_context: -32603, get_ioc_batch: -32003 };

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
  await mcpHandler({ method: 'POST', headers: headers || {}, body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } } }, res);
  return res;
}

async function callA2a(skill, args, headers) {
  const res = makeRes();
  await a2aHandler({
    method: 'POST',
    headers: headers || {},
    query: {},
    body: { jsonrpc: '2.0', id: 7, method: 'message/send', params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { skill, arguments: args } }] } } }
  }, res);
  return res;
}

// Records every fetch (upstream sources, Supabase caches/tables, the Gumroad
// licence check, free-tier accounting and the error log all go through
// global fetch) and fails it, so any call is both counted and harmless.
function spyFetch(t) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    throw new Error('fetch spy: network touched');
  };
  t.after(() => { global.fetch = original; });
  return calls;
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

// Supabase + Alchemy configured, so a real call WOULD reach caches, the
// error log and upstream - which makes "zero fetches" meaningful.
function withAllBackends(t) {
  withEnv(t, {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    ALCHEMY_API_KEY: 'test-alchemy-key'
  });
}

function assertFixtureResultBody(body, fixture, pg1RequestId) {
  assert.equal(body.test_fixture, true, `${fixture.tool}/${fixture.kind}: test_fixture`);
  assert.equal(body.status, fixture.expected.status, `${fixture.tool}/${fixture.kind}: status`);
  assert.deepEqual(body.reasons.map((r) => r.code), fixture.expected.reason_codes, `${fixture.tool}/${fixture.kind}: reasons`);
  assert.ok(Array.isArray(body.checks) && body.checks.length > 0);
  for (const c of body.checks) {
    assert.equal(c.source, 'fixture');
    assert.deepEqual(Object.keys(c).sort(), ['checked_at', 'data_as_of', 'result', 'source']);
    assert.equal(c.data_as_of, c.checked_at, `${fixture.tool}/${fixture.kind}: data_as_of must equal checked_at`);
  }
  assert.equal(body.request_id, pg1RequestId);
}

test('MCP: every fixture returns its expected result, with no key and no network, cache, payment, licence or error-log activity', async (t) => {
  withAllBackends(t);
  const calls = spyFetch(t);
  facilitatorCalls = 0;

  for (const fixture of TEST_FIXTURES) {
    const res = await callMcp(fixture.tool, fixture.arguments);
    const label = `${fixture.tool}/${fixture.kind}`;
    const pg1RequestId = res.headers['X-Request-Id'];
    assert.ok(pg1RequestId, label);
    assert.equal(res.body.request_id, undefined, `${label}: request_id is never on the JSON-RPC envelope`);

    if (fixture.expected.outcome === 'service_unavailable') {
      assert.equal(res.statusCode, 503, label);
      assert.equal(res.body.error.code, SERVICE_UNAVAILABLE_MCP_CODES[fixture.tool], label);
      assert.match(res.body.error.message, /temporarily unavailable, please retry\.$/, label);
      assert.deepEqual(res.body.error.data, { test_fixture: true, request_id: pg1RequestId }, label);
      continue;
    }

    assert.equal(res.statusCode, 200, label);
    const parsed = JSON.parse(res.body.result.content[0].text);
    if (fixture.expected.outcome === 'tool_error') {
      assert.equal(res.body.result.isError, true, label);
      assert.equal(parsed.error, true);
      assert.equal(parsed.code, fixture.expected.error_code);
      assert.equal(parsed.found, undefined, `${label}: an upstream failure must never carry found`);
      assertFixtureResultBody(parsed, fixture, pg1RequestId);
      continue;
    }

    assert.equal(res.body.result.isError, undefined, label);
    assertFixtureResultBody(parsed, fixture, pg1RequestId);
    if (STRUCTURED_CONTENT_TOOLS.has(fixture.tool)) {
      assert.deepEqual(res.body.result.structuredContent, parsed, `${label}: structuredContent mirrors content`);
    } else {
      assert.equal(res.body.result.structuredContent, undefined, label);
    }
    assert.equal(res.body.result._meta, undefined, `${label}: no payment receipt - fixtures are free`);
  }

  assert.deepEqual(calls, [], 'fixture calls must never call fetch (upstream, cache, licence, free tier, error log)');
  assert.equal(facilitatorCalls, 0, 'fixture calls must never reach the x402 payment gate');
});

test('MCP: fixtures ignore a licence key entirely (never verified) and still return the fixture', async (t) => {
  withAllBackends(t);
  const calls = spyFetch(t);
  for (const fixture of TEST_FIXTURES) {
    const res = await callMcp(fixture.tool, fixture.arguments, { 'x-api-key': 'BOGUS-KEY', 'x-free-tier': '1', 'payment-signature': 'not-a-real-signature' });
    assert.notEqual(res.statusCode, 402, `${fixture.tool}/${fixture.kind}`);
    if (res.body.result && res.body.result.content) {
      assert.equal(JSON.parse(res.body.result.content[0].text).test_fixture, true);
    } else {
      assert.equal(res.body.error.data.test_fixture, true);
    }
  }
  assert.deepEqual(calls, []);
});

test('MCP: fixture responses have the same fields as the real response for each tool', async (t) => {
  withAllBackends(t);
  spyFetch(t);
  const sample = {
    check_wallet_sanctions: ['address', 'address_normalized', 'listed', 'matches', 'source', 'list_last_synced', 'disclaimer'],
    check_domain_age: ['found', 'available', 'domain'],
    check_hostname_reputation: ['hostname', 'verdict', 'sources', 'lookalike_of', 'list_synced_at', 'checked_at', 'attribution'],
    check_wallet_age: ['address', 'chain', 'found', 'first_seen', 'age_days', 'first_seen_block', 'first_direction', 'is_contract', 'delegated', 'delegate_address', 'note', 'source', 'cached']
  };
  for (const fixture of TEST_FIXTURES.filter((f) => sample[f.tool] && f.expected.outcome === 'result')) {
    const res = await callMcp(fixture.tool, fixture.arguments);
    const parsed = JSON.parse(res.body.result.content[0].text);
    for (const key of sample[fixture.tool]) assert.ok(key in parsed, `${fixture.tool}/${fixture.kind} missing ${key}`);
  }
});

test('MCP: paid-tool fixtures are free even though a real call with no key gets a payment challenge', async (t) => {
  withAllBackends(t);
  spyFetch(t);
  facilitatorCalls = 0;
  const fixture = await callMcp('get_cve_details', { cve_id: FIXTURE_VALUES.cve.FLAGGED });
  assert.equal(JSON.parse(fixture.body.result.content[0].text).test_fixture, true);
  assert.equal(facilitatorCalls, 0);

  // Sensitivity check: the same tool with a near-miss id goes to the real
  // payment gate, which the facilitator spy does see.
  const real = await callMcp('get_cve_details', { cve_id: 'CVE-0000-0004' });
  assert.equal(real.body.result.isError, true);
  assert.equal(real.body.result.structuredContent.x402Version, 2);
  assert.equal(facilitatorCalls, 1, 'a real (non-fixture) paid call must reach the payment gate');
});

test('MCP: fixture calls never count toward the rate limit', async (t) => {
  // No Supabase or Alchemy: a real check_wallet_age call skips the cache,
  // goes through the rate limiter, then fails upstream_unavailable - or
  // rate_limited if the limiter had been fed by the fixture calls.
  withEnv(t, { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined, ALCHEMY_API_KEY: undefined });
  spyFetch(t);
  const headers = { 'x-forwarded-for': '198.51.100.77' };
  for (let i = 0; i < 100; i++) {
    const res = await callMcp('check_wallet_age', { address: FIXTURE_VALUES.wallet.CLEAN }, headers);
    assert.equal(JSON.parse(res.body.result.content[0].text).test_fixture, true);
  }
  const real = await callMcp('check_wallet_age', { address: '0x' + 'b'.repeat(40) }, headers);
  assert.equal(JSON.parse(real.body.result.content[0].text).code, 'upstream_unavailable');

  // Sensitivity check: 60 real calls from another caller do exhaust it.
  const other = { 'x-forwarded-for': '198.51.100.78' };
  let last;
  for (let i = 0; i < 61; i++) last = await callMcp('check_wallet_age', { address: '0x' + 'c'.repeat(40) }, other);
  assert.equal(JSON.parse(last.body.result.content[0].text).code, 'rate_limited');
});

test('MCP: UNKNOWN fixtures reproduce the real upstream-failure shape for each tool', async (t) => {
  withAllBackends(t);
  const original = global.fetch;
  t.after(() => { global.fetch = original; });

  // Real failures: every upstream/Supabase fetch rejects (a network outage).
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const realSanctions = await callMcp('check_wallet_sanctions', { address: '0x' + 'd'.repeat(40) });
  const realHostname = await callMcp('check_hostname_reputation', { hostname: 'example.com' });
  const realIoc = await callMcp('get_ioc_context', { value: '192.0.2.200' });
  const realIocBatch = await callMcp('get_ioc_batch', { values: ['192.0.2.201'] });
  const realWalletAge = await callMcp('check_wallet_age', { address: '0x' + 'e'.repeat(40), chain: 'arbitrum' });

  const pairs = [
    [realSanctions, await callMcp('check_wallet_sanctions', { address: FIXTURE_VALUES.wallet.UNKNOWN })],
    [realHostname, await callMcp('check_hostname_reputation', { hostname: FIXTURE_VALUES.domain.UNKNOWN })],
    [realIoc, await callMcp('get_ioc_context', { value: FIXTURE_VALUES.ipv4.UNKNOWN })],
    [realIocBatch, await callMcp('get_ioc_batch', { values: [FIXTURE_VALUES.ipv6.UNKNOWN] })]
  ];
  for (const [real, fixture] of pairs) {
    assert.equal(fixture.statusCode, real.statusCode);
    assert.equal(fixture.body.error.code, real.body.error.code);
    assert.equal(fixture.body.error.message, real.body.error.message);
    assert.deepEqual(real.body.error.data, { request_id: real.headers['X-Request-Id'] });
    assert.deepEqual(fixture.body.error.data, { test_fixture: true, request_id: fixture.headers['X-Request-Id'] });
  }

  // check_wallet_age: the upstream_unavailable isError shape, never found:false.
  const walletFixture = await callMcp('check_wallet_age', { address: FIXTURE_VALUES.wallet.UNKNOWN, chain: 'arbitrum' });
  const realBody = JSON.parse(realWalletAge.body.result.content[0].text);
  const fixtureBody = JSON.parse(walletFixture.body.result.content[0].text);
  assert.equal(realWalletAge.body.result.isError, true);
  assert.equal(walletFixture.body.result.isError, true);
  assert.deepEqual(Object.keys(fixtureBody).filter((k) => k !== 'test_fixture'), Object.keys(realBody));
  assert.equal(fixtureBody.code, realBody.code);
  assert.equal(fixtureBody.status, 'unknown');
  assert.equal(fixtureBody.found, undefined);

  // check_domain_age: a real RDAP timeout is a found:false result with
  // reason_code "timeout" and status "unknown" - the fixture matches it.
  global.fetch = async (url) => {
    if (String(url).includes('data.iana.org')) {
      return { ok: true, json: async () => ({ services: [[['com'], ['https://rdap.example.test/']]] }) };
    }
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  const realDomain = JSON.parse((await callMcp('check_domain_age', { domain: 'example.com' })).body.result.content[0].text);
  const fixtureDomain = JSON.parse((await callMcp('check_domain_age', { domain: FIXTURE_VALUES.domain.UNKNOWN })).body.result.content[0].text);
  assert.deepEqual(Object.keys(fixtureDomain).filter((k) => k !== 'test_fixture'), Object.keys(realDomain));
  for (const key of ['found', 'available', 'reason', 'reason_code', 'status']) assert.equal(fixtureDomain[key], realDomain[key], key);
  assert.equal(fixtureDomain.reason_code, 'timeout');
});

test('MCP: a near-miss value is treated as a real input, not a fixture', async (t) => {
  withEnv(t, { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined, ALCHEMY_API_KEY: undefined });
  spyFetch(t);
  const near = FIXTURE_VALUES.wallet.FLAGGED.slice(0, -1) + '9'; // ...00000004 is the DELEGATED fixture
  const res = await callMcp('check_wallet_age', { address: near }, { 'x-forwarded-for': '198.51.100.79' });
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'upstream_unavailable', 'went down the real path (no Alchemy key configured)');
  assert.equal(parsed.test_fixture, undefined);

  const host = await callMcp('check_hostname_reputation', { hostname: 'pg1-test-flagged.invalie' }, { 'x-forwarded-for': '198.51.100.79' });
  assert.notEqual(host.body.error?.data?.test_fixture, true);
  assert.equal(host.body.result, undefined, 'real path: Supabase not configured, so no verdict');
});

test('MCP: check_wallet_age fixtures echo the requested chain and have no age threshold', async (t) => {
  spyFetch(t);
  const flagged = JSON.parse((await callMcp('check_wallet_age', { address: FIXTURE_VALUES.wallet.FLAGGED, chain: 'polygon' })).body.result.content[0].text);
  assert.equal(flagged.chain, 'polygon');
  assert.equal(flagged.found, false);
  assert.equal(flagged.first_seen, null);
  const clean = JSON.parse((await callMcp('check_wallet_age', { address: FIXTURE_VALUES.wallet.CLEAN.toUpperCase().replace('0X', '0x') })).body.result.content[0].text);
  assert.equal(clean.chain, 'base');
  assert.equal(clean.found, true);
  assert.equal(clean.first_seen, '2023-09-01T00:00:00.000Z');
  assert.equal(clean.address, FIXTURE_VALUES.wallet.CLEAN);
  assert.equal(clean.delegated, false);
  assert.equal(clean.delegate_address, null);
  assert.equal(flagged.delegated, false);
  const delegated = JSON.parse((await callMcp('check_wallet_age', { address: FIXTURE_VALUES.wallet.DELEGATED, chain: 'ethereum' })).body.result.content[0].text);
  assert.equal(delegated.chain, 'ethereum');
  assert.equal(delegated.found, true);
  assert.equal(delegated.is_contract, true);
  assert.equal(delegated.delegated, true);
  assert.equal(delegated.delegate_address, FIXTURE_DELEGATE_ADDRESS);
  assert.deepEqual(delegated.reasons.map((r) => r.code), ['WALLET_DELEGATED']);
  assert.equal(delegated.test_fixture, true);
  // An invalid chain is still an invalid-input error, fixture address or not.
  const bad = await callMcp('check_wallet_age', { address: FIXTURE_VALUES.wallet.FLAGGED, chain: 'solana' });
  assert.equal(JSON.parse(bad.body.result.content[0].text).code, 'invalid_chain');
});

test('A2A: the 4 fixture skills return their expected result with no network activity', async (t) => {
  withAllBackends(t);
  const calls = spyFetch(t);
  for (const fixture of TEST_FIXTURES.filter((f) => A2A_FIXTURE_SKILLS.includes(f.tool))) {
    const res = await callA2a(fixture.tool, fixture.arguments);
    const label = `${fixture.tool}/${fixture.kind}`;
    const pg1RequestId = res.headers['X-Request-Id'];
    if (fixture.expected.outcome === 'service_unavailable') {
      assert.equal(res.statusCode, 503, label);
      assert.equal(res.body.error.code, -32010, label);
      assert.deepEqual(res.body.error.data, { test_fixture: true, request_id: pg1RequestId }, label);
    } else if (fixture.expected.outcome === 'tool_error') {
      assert.equal(res.statusCode, 200, label);
      assert.equal(res.body.error.code, -32000, label);
      assert.equal(res.body.error.data.code, fixture.expected.error_code);
      assertFixtureResultBody(res.body.error.data, fixture, pg1RequestId);
    } else {
      assert.equal(res.statusCode, 200, label);
      const data = res.body.result.artifacts[0].parts[0].data;
      assertFixtureResultBody(data, fixture, pg1RequestId);
    }
  }
  assert.deepEqual(calls, []);
});

// Fixture dates must stay valid forever: with the clock frozen 60 days from
// now, every fixture still returns its documented verdict (over MCP and,
// for the A2A skills, over A2A), check_domain_age FLAGGED is still exactly
// FLAGGED_AGE_DAYS old relative to the frozen "today", and every check's
// data_as_of still equals its checked_at.
test('fixtures: with the clock frozen 60 days ahead, every fixture still returns its documented verdict', async (t) => {
  withAllBackends(t);
  const calls = spyFetch(t);
  const frozenNow = Date.now() + 60 * 24 * 60 * 60 * 1000;
  t.mock.timers.enable({ apis: ['Date'], now: frozenNow });
  assert.equal(Date.now(), frozenNow);

  for (const fixture of TEST_FIXTURES) {
    const label = `${fixture.tool}/${fixture.kind} (+60d)`;
    const res = await callMcp(fixture.tool, fixture.arguments);
    if (fixture.expected.outcome === 'service_unavailable') {
      assert.equal(res.statusCode, 503, label);
      assert.equal(res.body.error.code, SERVICE_UNAVAILABLE_MCP_CODES[fixture.tool], label);
      continue;
    }
    assert.equal(res.statusCode, 200, label);
    const parsed = JSON.parse(res.body.result.content[0].text);
    if (fixture.expected.outcome === 'tool_error') {
      assert.equal(res.body.result.isError, true, label);
      assert.equal(parsed.code, fixture.expected.error_code, label);
      assert.equal(parsed.found, undefined, label);
    }
    assertFixtureResultBody(parsed, fixture, res.headers['X-Request-Id']);
    for (const c of parsed.checks) assert.equal(c.checked_at, new Date(frozenNow).toISOString(), label);

    if (fixture.tool === 'check_domain_age' && fixture.kind === 'FLAGGED') {
      assert.equal(parsed.age_days, FIXTURE_DOMAIN_FLAGGED_AGE_DAYS, label);
      assert.equal(parsed.registration_date, fixtureDaysAgoMidnightUtc(FIXTURE_DOMAIN_FLAGGED_AGE_DAYS, frozenNow), label);
      assert.ok(new Date(parsed.registration_date).getTime() > Date.now() - 30 * 24 * 60 * 60 * 1000, label);
      assert.equal(parsed.newly_registered, true, label);
    }
  }

  for (const fixture of TEST_FIXTURES.filter((f) => A2A_FIXTURE_SKILLS.includes(f.tool))) {
    const label = `A2A ${fixture.tool}/${fixture.kind} (+60d)`;
    const res = await callA2a(fixture.tool, fixture.arguments);
    if (fixture.expected.outcome === 'service_unavailable') {
      assert.equal(res.statusCode, 503, label);
    } else if (fixture.expected.outcome === 'tool_error') {
      assert.equal(res.body.error.data.code, fixture.expected.error_code, label);
      assertFixtureResultBody(res.body.error.data, fixture, res.headers['X-Request-Id']);
    } else {
      assertFixtureResultBody(res.body.result.artifacts[0].parts[0].data, fixture, res.headers['X-Request-Id']);
    }
  }
  assert.deepEqual(calls, []);
});
