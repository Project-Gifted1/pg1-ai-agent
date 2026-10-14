/**
 * A live integration with unlimited access (presign-guard: check_wallet_sanctions,
 * check_domain_age, check_hostname_reputation, check_wallet_age) is identified
 * by one thing only: a valid Gumroad licence key in the X-API-KEY header.
 * With it, on every route that serves those four checks:
 *   - /api/mcp tools/call and /api/a2a message/send: no hourly limit (well past
 *     the 60/hour and the 120/hour sanctions limits from one IP), no free-tier
 *     read or write, no payer screening, no x402 challenge;
 *   - REST /api/preflight (and preflight_check on /api/mcp and /api/a2a), the
 *     paid route that runs the same checks: authorized by the key before the
 *     free tier, screening or x402 are reached, with every inner check exempt
 *     from the hourly limits.
 * A key verified once stays good for 24 hours (lib/paymentGate.mjs), so a
 * Gumroad outage inside that window does not drop the integration to the
 * anonymous limits.
 * The same loops without the key are rate limited, so each assertion here can
 * fail.
 * Run with: node --test tests/licensed-integration-access.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import mcpHandler, { __setX402GateForTests } from '../api/mcp.mjs';
import a2aHandler from '../api/a2a.mjs';
import preflightHandler from '../api/preflight.mjs';
import { __setScreeningForTests } from '../lib/screening.mjs';
import {
  DOMAIN_AGE_RATE_LIMIT_MAX,
  HOSTNAME_REPUTATION_RATE_LIMIT_MAX,
  WALLET_AGE_RATE_LIMIT_MAX,
  WALLET_SANCTIONS_RATE_LIMIT_MAX
} from '../lib/x402Config.mjs';

// Built at runtime so secret scanners do not flag a key-shaped literal.
const LICENCE_KEY = ['TEST', 'LICENCE', 'UNLIMITED', String(Date.now() % 1e6)].join('-');
const CALLS = Math.max(DOMAIN_AGE_RATE_LIMIT_MAX, HOSTNAME_REPUTATION_RATE_LIMIT_MAX, WALLET_AGE_RATE_LIMIT_MAX, WALLET_SANCTIONS_RATE_LIMIT_MAX) + 10;

// Inputs never repeat across the whole file: the domain and hostname checks
// answer a cached input before their limiter, so a repeat would not count.
let inputCounter = 0;
const TOOLS = {
  check_wallet_sanctions: () => ({ address: '0x' + (++inputCounter).toString(16).padStart(40, '0') }),
  check_domain_age: () => ({ domain: `licensed-${++inputCounter}.com` }),
  check_hostname_reputation: () => ({ hostname: `licensed-${++inputCounter}.example.org` }),
  check_wallet_age: () => ({ address: '0x' + (0x10000000 + ++inputCounter).toString(16).padStart(40, '0'), chain: 'base' })
};

let ipCounter = 0;
const freshIp = () => `198.18.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function makeRes() {
  return {
    statusCode: null, body: null, headers: {}, done: false,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; this.done = true; return this; },
    send(p) { this.body = p; this.done = true; return this; },
    end(p) { if (p !== undefined) this.body = p; this.done = true; return this; }
  };
}

// Every upstream the four checks and the paid gate can reach, answered
// offline; `seen` counts what was touched so the test can assert on it.
function withWorld(t) {
  const saved = { fetch: global.fetch, env: { ...process.env } };
  Object.assign(process.env, {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    ALCHEMY_API_KEY: 'test-alchemy',
    GUMROAD_PRODUCT_ID: 'test-product'
  });
  const seen = { gumroad: 0, gumroadBadKey: 0, freeTier: 0, screening: 0, x402: 0, sanctionsLookups: 0, rdap: 0, phishing: 0, alchemy: 0 };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('api.gumroad.com/v2/licenses/verify')) {
      seen.gumroad += 1;
      const ok = new URLSearchParams(String(opts.body)).get('license_key') === LICENCE_KEY;
      if (!ok) seen.gumroadBadKey += 1;
      return json(ok ? { success: true, purchase: {} } : { success: false });
    }
    if (u.includes('free_tier_usage')) { seen.freeTier += 1; return json([]); }
    if (u.includes('sanctioned_wallets?select=updated_at')) return json([{ updated_at: '2026-10-01T00:00:00Z' }]);
    if (u.includes('sanctioned_wallets?')) { seen.sanctionsLookups += 1; return json([]); }
    if (u.includes('data.iana.org/rdap/dns.json')) return json({ services: [[['com'], ['https://rdap.test/']]] });
    if (u.startsWith('https://rdap.test/domain/')) {
      seen.rdap += 1;
      return json({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }], entities: [] });
    }
    if (u.includes('phishing_list_meta')) return json([{ source: 'eth-phishing-detect', tolerance: 3, synced_at: '2026-10-01T00:00:00Z' }]);
    if (u.includes('phishing_domains')) { seen.phishing += 1; return json([]); }
    if (u.includes('wallet_first_seen')) return opts.method === 'POST' ? json(null, 201) : json([]);
    if (u.includes('alchemy')) {
      seen.alchemy += 1;
      const body = JSON.parse(opts.body);
      if (body.method === 'eth_getCode') return json({ jsonrpc: '2.0', id: body.id, result: '0x' });
      return json({ jsonrpc: '2.0', id: body.id, result: { transfers: [{ blockNum: '0x10', metadata: { blockTimestamp: '2025-01-01T00:00:00.000Z' } }] } });
    }
    return json([]);
  };
  __setScreeningForTests(async () => { seen.screening += 1; return { allowed: true, refused: false, unavailable: false, lists: [] }; });
  __setX402GateForTests(async () => { seen.x402 += 1; return { authorized: false, paymentRequired: { x402Version: 2, error: 'Payment required', accepts: [] } }; });
  t.after(() => {
    global.fetch = saved.fetch;
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    __setScreeningForTests(null);
    __setX402GateForTests(null);
  });
  return seen;
}

async function mcpCall(tool, args, headers) {
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } } }, res);
  return res;
}

async function a2aCall(skill, args, headers) {
  const res = makeRes();
  await a2aHandler({ method: 'POST', headers, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm-1', parts: [{ kind: 'data', data: { skill, arguments: args } }] } } } }, res);
  return res;
}

const mcpOk = (res) => res.statusCode === 200 && res.body?.result && !res.body.result.isError && !res.headers['PAYMENT-REQUIRED'];
const mcpRateLimited = (res) => res.body?.result?.isError === true && JSON.parse(res.body.result.content[0].text).code === 'rate_limited';
const a2aOk = (res) => res.statusCode === 200 && ['completed', 'TASK_STATE_COMPLETED'].includes(res.body?.result?.status?.state);
const a2aRateLimited = (res) => res.body?.error?.data?.code === 'rate_limited';

for (const [route, call, ok, limited] of [['/api/mcp', mcpCall, mcpOk, mcpRateLimited], ['/api/a2a', a2aCall, a2aOk, a2aRateLimited]]) {
  for (const [tool, argsFor] of Object.entries(TOOLS)) {
    test(`${route} ${tool}: a valid licence key is never rate limited, and never touches the free tier, screening or x402`, async (t) => {
      const seen = withWorld(t);
      const headers = { 'x-forwarded-for': freshIp(), 'x-api-key': LICENCE_KEY };
      for (let i = 1; i <= CALLS; i++) {
        const res = await call(tool, argsFor(i), headers);
        assert.ok(ok(res), `licensed call ${i} of ${CALLS} failed: ${JSON.stringify(res.body).slice(0, 300)}`);
        assert.equal(res.headers['X-Free-Tier-Remaining'], undefined, 'no free-tier header on a licensed call');
      }
      assert.equal(seen.gumroadBadKey, 0);
      assert.equal(seen.freeTier, 0, 'the free tier was never read or written');
      assert.equal(seen.screening, 0, 'payer screening never ran');
      assert.equal(seen.x402, 0, 'no x402 gate ran');
    });

    test(`${route} ${tool}: the same loop without the key is rate limited (control)`, async (t) => {
      withWorld(t);
      const headers = { 'x-forwarded-for': freshIp() };
      let firstLimited = null;
      for (let i = 1; i <= CALLS && firstLimited === null; i++) {
        if (limited(await call(tool, argsFor(i), headers))) firstLimited = i;
      }
      assert.ok(firstLimited !== null, `${tool} was never limited without a key`);
      assert.ok(firstLimited <= CALLS);
    });
  }
}

test('one licensed caller exhausts no shared counter: the licensed loop on /api/mcp and /api/a2a from the same IP is unlimited for all four tools at once', async (t) => {
  const seen = withWorld(t);
  const headers = { 'x-forwarded-for': freshIp(), 'x-api-key': LICENCE_KEY };
  for (let i = 1; i <= CALLS; i++) {
    for (const [tool, argsFor] of Object.entries(TOOLS)) {
      assert.ok(mcpOk(await mcpCall(tool, argsFor(i), headers)), `mcp ${tool} call ${i}`);
      assert.ok(a2aOk(await a2aCall(tool, argsFor(i), headers)), `a2a ${tool} call ${i}`);
    }
  }
  assert.equal(seen.freeTier + seen.screening + seen.x402, 0);
});

// REST: /api/preflight is the paid HTTP route that runs these checks.
async function restPreflight(headers, query) {
  const res = makeRes();
  await preflightHandler({ method: 'GET', headers, query, url: '/api/preflight' }, res);
  return res;
}

test('REST /api/preflight with a licence key: authorized past every hourly limit, no free tier, no screening, no 402', async (t) => {
  const seen = withWorld(t);
  const headers = { 'x-forwarded-for': freshIp(), 'x-api-key': LICENCE_KEY };
  for (let i = 1; i <= CALLS; i++) {
    const wallet = await restPreflight(headers, { action: 'pay', target: TOOLS.check_wallet_sanctions(i).address, chain: 'base' });
    assert.equal(wallet.statusCode, 200, `wallet preflight ${i}: ${JSON.stringify(wallet.body).slice(0, 300)}`);
    assert.equal(wallet.headers['PAYMENT-REQUIRED'], undefined);
    assert.equal(wallet.headers['X-Free-Tier-Remaining'], undefined);
    assert.deepEqual(wallet.body.checks.map((c) => [c.tool, c.result]), [['check_wallet_sanctions', 'ok'], ['check_wallet_age', 'ok']]);

    const site = await restPreflight(headers, { action: 'open', target: `https://${TOOLS.check_domain_age().domain}/` });
    assert.equal(site.statusCode, 200, `site preflight ${i}: ${JSON.stringify(site.body).slice(0, 300)}`);
    assert.deepEqual(site.body.checks.map((c) => [c.tool, c.result]).sort(), [['check_domain_age', 'ok'], ['check_hostname_reputation', 'ok']]);
  }
  assert.equal(seen.freeTier, 0, 'the free tier was never read or written');
  assert.equal(seen.screening, 0, 'payer screening never ran');
  assert.equal(seen.x402, 0, 'no x402 gate ran');
  assert.equal(seen.gumroadBadKey, 0);
});

test('preflight_check on /api/mcp and /api/a2a with a licence key: no free tier, no screening, no x402', async (t) => {
  const seen = withWorld(t);
  const headers = { 'x-forwarded-for': freshIp(), 'x-api-key': LICENCE_KEY };
  for (let i = 1; i <= 10; i++) {
    const args = { action: 'pay', target: TOOLS.check_wallet_sanctions(i).address, chain: 'base' };
    const m = await mcpCall('preflight_check', args, headers);
    assert.ok(mcpOk(m), `mcp preflight_check ${i}: ${JSON.stringify(m.body).slice(0, 300)}`);
    const a = await a2aCall('preflight_check', args, headers);
    assert.ok(a2aOk(a), `a2a preflight_check ${i}: ${JSON.stringify(a.body).slice(0, 300)}`);
  }
  assert.equal(seen.freeTier + seen.screening + seen.x402, 0);
});

test('without a key the same REST preflight is gated (control): free tier first, then a 402', async (t) => {
  const seen = withWorld(t);
  const res = await restPreflight({ 'x-forwarded-for': freshIp(), 'x-free-tier': '0' }, { action: 'pay', target: TOOLS.check_wallet_sanctions(1).address });
  assert.equal(res.statusCode, 402);
  assert.equal(seen.x402, 1);
});

test('a Gumroad outage within 24 hours of the last good check keeps a licensed integration unlimited on /api/mcp and /api/a2a', async (t) => {
  const seen = withWorld(t);
  // A key of its own, so the verification below is the first for it.
  const key = ['TEST', 'OUTAGE', String(Date.now() % 1e6)].join('-');
  const okFetch = global.fetch;
  let gumroadDown = false;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes('api.gumroad.com')) {
      seen.gumroad += 1;
      if (gumroadDown) return new Response('<html>503</html>', { status: 503 });
      return new Response(JSON.stringify(new URLSearchParams(String(opts.body)).get('license_key') === key ? { success: true, purchase: {} } : { success: false }), { status: 200 });
    }
    return okFetch(url, opts);
  };
  const headers = { 'x-forwarded-for': freshIp(), 'x-api-key': key };
  assert.ok(mcpOk(await mcpCall('check_domain_age', TOOLS.check_domain_age(), headers)), 'first call verifies the key');
  const verifiedCalls = seen.gumroad;

  gumroadDown = true;
  const realNow = Date.now;
  const start = realNow();
  Date.now = () => start + 23 * 60 * 60 * 1000 + (realNow() - start);
  t.after(() => { Date.now = realNow; });

  for (let i = 1; i <= CALLS; i++) {
    for (const [tool, argsFor] of Object.entries(TOOLS)) {
      assert.ok(mcpOk(await mcpCall(tool, argsFor(i), headers)), `mcp ${tool} call ${i} during the outage`);
      assert.ok(a2aOk(await a2aCall(tool, argsFor(i), headers)), `a2a ${tool} call ${i} during the outage`);
    }
  }
  assert.equal(seen.gumroad, verifiedCalls, 'Gumroad was not contacted during the outage');
  assert.equal(seen.freeTier + seen.screening + seen.x402, 0);
});
