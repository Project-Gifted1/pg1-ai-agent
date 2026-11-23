/**
 * Plans for check_agent_message and check_repo_trap (1.23.0, lib/plans.mjs,
 * lib/checkMeter.mjs, lib/paymentGate.mjs resolveLicencePlan):
 *   - every tier's limit and reset (day and month, UTC);
 *   - the hourly abuse limits never undercut a quota;
 *   - the shared quota across both tools;
 *   - the switch off (no behaviour change) and on;
 *   - Partner unlimited (the original licence product, the presign-guard key);
 *   - licence verification, cache and cancellation paths (mocked);
 *   - the x402 fallback price (0.002 USD) and the links on 402 and over-quota;
 *   - /usage: the metered tools are never labelled "paid"; counts by plan;
 *   - no response ever says "safe".
 * Run with: node --test tests/plans.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANS, TIERS, METERED_TOOLS, PAY_PER_CHECK_PRICE, PAY_PER_CHECK_USD, KEYS_URL, PRICING_URL,
  isPaidChecksOn, periodFor, hourlyLimitFor, quotaFor, decide, planHeaders, METERED_DESCRIPTION_NOTE
} from '../lib/plans.mjs';
import { meterCheck, resolveCaller, MeterError, __clearKeyCacheForTests, __setDefaultKeyStoreForTests, meterFailureStats, __resetMeterFailureLogForTests } from '../lib/checkMeter.mjs';
import { createMemoryKeyStore, createFreeKey, licenceAccount, hashApiKey, keyHint, generateApiKey, freeKeySubject, hashEmail } from '../lib/apiKeys.mjs';
import { resolveLicencePlan, verifyGumroadProduct, __clearLicenceCachesForTests } from '../lib/paymentGate.mjs';
import mcpHandler, { handleCheckAgentMessage, handleCheckRepoTrap, resetAgentMessageRateLimit, resetRepoTrapRateLimit, TOOL_DEFINITIONS, __setX402GateForTests } from '../api/mcp.mjs';
import repoTrapRest from '../api/repo-trap.mjs';
import a2aHandler from '../api/a2a.mjs';
import { aggregateUsage, toolPricing, signupsView } from '../lib/usageStats.mjs';
import { usageCardView } from '../lib/usageCard.mjs';
import { __setScreeningForTests } from '../lib/screening.mjs';

const SAFE = /\bsafe\b/i;
const PROVIDERS = /gumroad|stripe|paddle|lemon ?squeezy|turnstile|cloudflare|coinbase|cdp\b/i;
const NOW = Date.UTC(2026, 10, 22, 15, 30); // 2026-11-22 15:30 UTC
const ON = { PG1_PAID_CHECKS: 'on', TELEMETRY_IP_SALT: 'plans-test-salt' };
const OFF = { TELEMETRY_IP_SALT: 'plans-test-salt' };
const noLicence = async () => ({ valid: false, error: 'Invalid, expired, or refunded license key.' });
const licence = (tier) => async () => ({ valid: true, tier });

function withSalt(t) {
  const prev = process.env.TELEMETRY_IP_SALT;
  process.env.TELEMETRY_IP_SALT = 'plans-test-salt';
  t.after(() => { if (prev === undefined) delete process.env.TELEMETRY_IP_SALT; else process.env.TELEMETRY_IP_SALT = prev; });
}

// --- the plan table ------------------------------------------------------------

test('tiers and limits are the published ones', () => {
  assert.deepEqual(TIERS, ['anonymous', 'free', 'builder', 'team', 'partner']);
  assert.deepEqual(METERED_TOOLS, ['check_agent_message', 'check_repo_trap']);
  assert.equal(PLANS.anonymous.quota, 25); assert.equal(PLANS.anonymous.period, 'day');
  assert.equal(PLANS.free.quota, 500); assert.equal(PLANS.free.period, 'day');
  assert.equal(PLANS.builder.quota, 10000); assert.equal(PLANS.builder.period, 'month'); assert.equal(PLANS.builder.priceUsdMonth, 9);
  assert.equal(PLANS.team.quota, 100000); assert.equal(PLANS.team.period, 'month'); assert.equal(PLANS.team.priceUsdMonth, 49); assert.equal(PLANS.team.keys, 5);
  assert.equal(PLANS.partner.quota, null); assert.equal(PLANS.partner.priceUsdMonth, 0);
  assert.equal(PAY_PER_CHECK_PRICE, '$0.002');
  assert.equal(PAY_PER_CHECK_USD, 0.002);
});

test('the switch: PG1_PAID_CHECKS defaults off; on/true/1/yes turn it on', () => {
  assert.equal(isPaidChecksOn({}), false);
  assert.equal(isPaidChecksOn({ PG1_PAID_CHECKS: 'off' }), false);
  assert.equal(isPaidChecksOn({ PG1_PAID_CHECKS: 'nonsense' }), false);
  for (const v of ['on', 'ON', 'true', '1', 'yes']) assert.equal(isPaidChecksOn({ PG1_PAID_CHECKS: v }), true, v);
});

test('periods and resets: day at 00:00 UTC, month on the 1st, December rolls the year', () => {
  assert.deepEqual(periodFor('anonymous', NOW), { key: '2026-11-22', resetsAt: '2026-11-23T00:00:00.000Z' });
  assert.deepEqual(periodFor('free', NOW), { key: '2026-11-22', resetsAt: '2026-11-23T00:00:00.000Z' });
  assert.deepEqual(periodFor('builder', NOW), { key: '2026-11', resetsAt: '2026-12-01T00:00:00.000Z' });
  assert.deepEqual(periodFor('team', Date.UTC(2026, 11, 31, 23, 59)), { key: '2026-12', resetsAt: '2027-01-01T00:00:00.000Z' });
  assert.deepEqual(periodFor('free', Date.UTC(2026, 11, 31, 23, 59)), { key: '2026-12-31', resetsAt: '2027-01-01T00:00:00.000Z' });
  assert.deepEqual(periodFor('partner', NOW), { key: null, resetsAt: null });
});

test('the hourly abuse limits never undercut a quota (switch on and off)', () => {
  for (const on of [false, true]) {
    for (const tier of TIERS) {
      const hourly = hourlyLimitFor(tier, { on });
      const quota = quotaFor(tier, { on });
      if (hourly == null) continue;
      if (PLANS[tier].period === 'month') assert.fail(`${tier} has a monthly quota and must have no hourly limit`);
      if (quota != null) assert.ok(hourly >= quota, `${tier} (on=${on}): hourly ${hourly} < quota ${quota}`);
    }
  }
  for (const tier of ['builder', 'team', 'partner']) assert.equal(hourlyLimitFor(tier, { on: true }), null);
  assert.equal(hourlyLimitFor('anonymous', { on: false }), 60, 'switch off: the old 60/hour');
});

test('decide: off changes nothing; on asks no-licence callers to pay and licences get a quota error', () => {
  assert.equal(quotaFor('anonymous', { on: false }), null, 'off: no daily cap without a key');
  assert.deepEqual(decide({ tier: 'anonymous', used: 10000, on: false, now: NOW }).action, 'serve');
  assert.equal(decide({ tier: 'free', used: 499, on: false, now: NOW }).action, 'serve');
  assert.equal(decide({ tier: 'free', used: 500, on: false, now: NOW }).action, 'serve_as_anonymous');
  assert.equal(decide({ tier: 'anonymous', used: 24, on: true, now: NOW }).action, 'serve');
  const anon = decide({ tier: 'anonymous', used: 25, on: true, now: NOW });
  assert.equal(anon.action, 'pay_per_check');
  assert.match(anon.message, /25 free checks a day/);
  assert.ok(anon.message.includes(KEYS_URL) && anon.message.includes(PRICING_URL));
  assert.match(anon.message, /0\.002 USD/);
  const free = decide({ tier: 'free', used: 500, on: true, now: NOW });
  assert.equal(free.action, 'pay_per_check');
  assert.match(free.message, /500 checks for today/);
  const builder = decide({ tier: 'builder', used: 10000, on: true, now: NOW });
  assert.equal(builder.action, 'quota_exceeded');
  assert.match(builder.message, /10,000 checks for this month/);
  assert.match(builder.message, /resets on 2026-12-01/);
  assert.match(builder.message, /Upgrade to Team/);
  assert.ok(builder.message.includes(PRICING_URL));
  const team = decide({ tier: 'team', used: 100000, on: true, now: NOW });
  assert.equal(team.action, 'quota_exceeded');
  assert.match(team.message, /100,000/);
  assert.equal(decide({ tier: 'partner', used: 1e9, on: true, now: NOW }).action, 'serve');
  assert.equal(decide({ tier: 'anonymous', used: 1e6, on: true, paid: true, now: NOW }).action, 'serve');
  for (const d of [anon, free, builder, team]) {
    assert.doesNotMatch(d.message, SAFE);
    assert.doesNotMatch(d.message, PROVIDERS);
  }
});

test('plan headers', () => {
  assert.deepEqual(planHeaders({ tier: 'free', quota: 500, remaining: 499, resetsAt: '2026-11-23T00:00:00.000Z' }), { 'X-PG1-Plan': 'free', 'X-PG1-Quota': '500', 'X-PG1-Quota-Remaining': '499', 'X-PG1-Quota-Reset': '2026-11-23T00:00:00.000Z' });
  assert.deepEqual(planHeaders({ tier: 'partner' }), { 'X-PG1-Plan': 'partner' });
});

// --- the meter -------------------------------------------------------------------

const deps = (store, env, extra = {}) => ({ meterDeps: { store, env, now: () => NOW, resolveLicence: noLicence, ...extra } });
const msg = { text: 'hello' };
const repo = { files: [{ path: 'a.py' }] };
const ctx = (ip, more = {}) => ({ identifier: ip, metered: true, ...more });

test('switch on, no key: 25 a day per caller, shared by both tools, then payment_required with the links', async (t) => {
  withSalt(t);
  resetAgentMessageRateLimit(); resetRepoTrapRateLimit();
  const store = createMemoryKeyStore();
  for (let i = 0; i < 25; i++) {
    const out = {};
    if (i % 2) await handleCheckAgentMessage(msg, ctx('198.51.100.10', { meterOut: out }), deps(store, ON));
    else await handleCheckRepoTrap(repo, ctx('198.51.100.10', { meterOut: out }), deps(store, ON));
    assert.equal(out.tier, 'anonymous');
    assert.equal(out.headers['X-PG1-Quota-Remaining'], String(24 - i));
  }
  for (const run of [() => handleCheckAgentMessage(msg, ctx('198.51.100.10'), deps(store, ON)), () => handleCheckRepoTrap(repo, ctx('198.51.100.10'), deps(store, ON))]) {
    await assert.rejects(run, (e) => {
      assert.ok(e instanceof MeterError);
      assert.equal(e.code, 'payment_required');
      assert.equal(e.mcpToolError, true);
      assert.equal(e.meter.keys_url, KEYS_URL);
      assert.equal(e.meter.pricing_url, PRICING_URL);
      assert.equal(e.meter.pay_per_check_usd, 0.002);
      assert.equal(e.meter.quota, 25);
      assert.equal(e.meter.resets_at, '2026-11-23T00:00:00.000Z');
      return true;
    });
  }
  // Another caller has its own 25.
  await handleCheckAgentMessage(msg, ctx('198.51.100.11'), deps(store, ON));
  // The counter is its own: subject anon:<hash>, never the 5/day free tier.
  assert.ok([...store.usage.keys()].every((k) => k.startsWith('anon:')));
  // A paid call is served and not counted.
  const out = {};
  await handleCheckAgentMessage(msg, ctx('198.51.100.10', { paid: true, meterOut: out }), deps(store, ON));
  assert.equal(out.paid, true);
});

test('a check that fails on bad input gives its use back', async (t) => {
  withSalt(t);
  resetAgentMessageRateLimit();
  const store = createMemoryKeyStore();
  await assert.rejects(() => handleCheckAgentMessage({ text: 'a'.repeat(70000) }, ctx('198.51.100.12'), deps(store, ON)));
  assert.deepEqual([...store.usage.values()], [0]);
});

test('switch off: no key keeps today\'s 60/hour and no daily cap; nothing is counted', async (t) => {
  withSalt(t);
  resetAgentMessageRateLimit();
  const store = createMemoryKeyStore();
  for (let i = 0; i < 60; i++) await handleCheckAgentMessage(msg, ctx('198.51.100.13'), deps(store, OFF));
  await assert.rejects(() => handleCheckAgentMessage(msg, ctx('198.51.100.13'), deps(store, OFF)), (e) => e.code === 'rate_limited' && /limited to 60 calls\/hour/.test(e.message));
  assert.equal(store.usage.size, 0, 'no counter is touched while off');
});

test('free key: 500 a day (500/hour abuse limit); off: then treated as no key; on: then pay per check', async (t) => {
  withSalt(t);
  const store = createMemoryKeyStore();
  const { key } = await createFreeKey(store, { email: 'dev@example.com', now: NOW });
  const subject = freeKeySubject(hashEmail('dev@example.com'));
  const period = '2026-11-22';
  // Off.
  resetAgentMessageRateLimit(); __clearKeyCacheForTests();
  const out = {};
  await handleCheckAgentMessage(msg, ctx('198.51.100.14', { licenseKey: key, meterOut: out }), deps(store, OFF));
  assert.equal(out.tier, 'free');
  assert.equal(out.headers['X-PG1-Quota'], '500');
  store.usage.set(`${subject}|${period}`, 500);
  const after = {};
  await handleCheckAgentMessage(msg, ctx('198.51.100.14', { licenseKey: key, meterOut: after }), deps(store, OFF));
  assert.equal(after.tier, 'anonymous', 'off: over 500, the holder is treated as having no key');
  // On.
  store.usage.set(`${subject}|${period}`, 499);
  const last = {};
  await handleCheckRepoTrap(repo, ctx('198.51.100.15', { licenseKey: key, meterOut: last }), deps(store, ON));
  assert.equal(last.headers['X-PG1-Quota-Remaining'], '0');
  await assert.rejects(() => handleCheckAgentMessage(msg, ctx('198.51.100.15', { licenseKey: key }), deps(store, ON)), (e) => e.code === 'payment_required' && e.meter.plan === 'free' && e.meter.quota === 500);
  // The hourly abuse limit for a free key is its whole day.
  resetAgentMessageRateLimit();
  store.usage.set(`${subject}|${period}`, 0);
  for (let i = 0; i < 70; i++) await handleCheckAgentMessage(msg, ctx('198.51.100.16', { licenseKey: key }), deps(store, ON));
});

test('Builder: 10,000 a month, then quota_exceeded naming the quota, the reset date and the upgrade; no hourly limit', async (t) => {
  withSalt(t);
  resetAgentMessageRateLimit();
  const store = createMemoryKeyStore();
  const key = 'AAAA1111-BBBB2222-CCCC3333-DDDD4444';
  const d = deps(store, ON, { resolveLicence: licence('builder') });
  for (let i = 0; i < 70; i++) await handleCheckAgentMessage(msg, ctx('198.51.100.17', { licenseKey: key }), d);
  store.usage.set(`${licenceAccount(key)}|2026-11`, 9999);
  await handleCheckRepoTrap(repo, ctx('198.51.100.17', { licenseKey: key }), d);
  await assert.rejects(() => handleCheckAgentMessage(msg, ctx('198.51.100.17', { licenseKey: key }), d), (e) => {
    assert.equal(e.code, 'quota_exceeded');
    assert.match(e.message, /10,000 checks for this month/);
    assert.match(e.message, /2026-12-01/);
    assert.match(e.message, /Upgrade to Team/);
    assert.equal(e.meter.resets_at, '2026-12-01T00:00:00.000Z');
    assert.equal(e.meter.pricing_url, PRICING_URL);
    assert.equal(e.meter.pay_per_check_usd, undefined, 'a licence is never asked to pay per check');
    return true;
  });
});

test('Team: the licence key and its team keys share one 100,000 quota', async (t) => {
  withSalt(t);
  resetAgentMessageRateLimit(); __clearKeyCacheForTests();
  const store = createMemoryKeyStore();
  const licenceKey = 'TEAM1111-BBBB2222-CCCC3333-DDDD4444';
  const account = licenceAccount(licenceKey);
  const member = generateApiKey();
  await store.insertKey({ key_hash: hashApiKey(member), key_hint: keyHint(member), tier: 'team', account });
  const d = deps(store, ON, { resolveLicence: licence('team') });
  await handleCheckAgentMessage(msg, ctx('198.51.100.18', { licenseKey: licenceKey }), d);
  const out = {};
  await handleCheckRepoTrap(repo, ctx('198.51.100.19', { licenseKey: member, meterOut: out }), d);
  assert.equal(out.tier, 'team');
  assert.equal(store.usage.get(`${account}|2026-11`), 2);
  store.usage.set(`${account}|2026-11`, 100000);
  await assert.rejects(() => handleCheckAgentMessage(msg, ctx('198.51.100.19', { licenseKey: member }), d), (e) => e.code === 'quota_exceeded' && /100,000/.test(e.message));
});

test('Partner (the original licence, e.g. presign-guard): unlimited, never counted, no hourly limit, on and off', async (t) => {
  withSalt(t);
  const store = createMemoryKeyStore();
  for (const env of [ON, OFF]) {
    resetAgentMessageRateLimit();
    const d = deps(store, env, { resolveLicence: licence('partner') });
    for (let i = 0; i < 80; i++) {
      const out = {};
      await handleCheckAgentMessage(msg, ctx('198.51.100.20', { licenseKey: 'PARTNER1-KEY', meterOut: out }), d);
      assert.equal(out.tier, 'partner');
    }
  }
  assert.equal(store.usage.size, 0);
});

test('fails open: an unreachable store serves the check uncounted (and logs it); an unverifiable licence is never asked to pay', async (t) => {
  withSalt(t);
  resetAgentMessageRateLimit();
  __resetMeterFailureLogForTests();
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  t.after(() => { console.warn = warn; });
  const broken = { ...createMemoryKeyStore(), takeUsage: async () => { throw new Error('down'); }, findActiveKey: async () => { throw new Error('down'); } };
  for (let i = 0; i < 30; i++) await handleCheckAgentMessage(msg, ctx('198.51.100.21'), deps(broken, ON));
  assert.equal(warned.filter((w) => /\[meter\] usage_take_failed: check served uncounted/.test(w)).length, 30, 'every uncounted check is logged');
  assert.equal(meterFailureStats().uncounted, 29, 'the ERROR LOG row is rate-limited and counts the rest');
  resetAgentMessageRateLimit();
  const store = createMemoryKeyStore();
  const d = deps(store, ON, { resolveLicence: async () => ({ valid: false, reason: 'verification_unavailable' }) });
  for (let i = 0; i < 30; i++) await handleCheckAgentMessage(msg, ctx('198.51.100.22', { licenseKey: 'SOME-LICENCE' }), d);
  assert.equal(store.usage.size, 0);
});

test('unmetered callers (operator chat, playground, internal) run exactly as in 1.22.0', async (t) => {
  withSalt(t);
  resetAgentMessageRateLimit();
  const store = createMemoryKeyStore();
  __setDefaultKeyStoreForTests(store);
  t.after(() => __setDefaultKeyStoreForTests(undefined));
  const prev = process.env.PG1_PAID_CHECKS;
  process.env.PG1_PAID_CHECKS = 'on';
  t.after(() => { if (prev === undefined) delete process.env.PG1_PAID_CHECKS; else process.env.PG1_PAID_CHECKS = prev; });
  for (let i = 0; i < 60; i++) await handleCheckAgentMessage(msg, { identifier: 'playground:abc' });
  await assert.rejects(() => handleCheckAgentMessage(msg, { identifier: 'playground:abc' }), (e) => e.code === 'rate_limited');
  for (let i = 0; i < 70; i++) await handleCheckAgentMessage(msg, { identifier: 'pg1-internal', licensed: true });
  assert.equal(store.usage.size, 0);
});

test('resolveCaller: a malformed or unknown pg1_ key is treated as no key', async (t) => {
  withSalt(t);
  __clearKeyCacheForTests();
  const store = createMemoryKeyStore();
  assert.equal((await resolveCaller({ licenseKey: 'pg1_short', identifier: '1.2.3.4' }, { store })).tier, 'anonymous');
  assert.equal((await resolveCaller({ licenseKey: generateApiKey(), identifier: '1.2.3.4' }, { store })).keyRejected, true);
  assert.equal((await resolveCaller({ identifier: '1.2.3.4', licensed: true }, { store })).tier, 'partner');
});

// --- licence verification (mocked) ----------------------------------------------------

function mockLicenceService(t, answers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const body = new URLSearchParams(String(opts.body));
    calls.push({ product: body.get('product_id'), key: body.get('license_key') });
    const a = answers(body.get('product_id'), body.get('license_key'));
    if (a === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(a), { status: a.success ? 200 : 404, headers: { 'content-type': 'application/json' } });
  };
  const env = process.env.GUMROAD_PRODUCT_ID;
  process.env.GUMROAD_PRODUCT_ID = 'prod-partner';
  t.after(() => { globalThis.fetch = original; if (env === undefined) delete process.env.GUMROAD_PRODUCT_ID; else process.env.GUMROAD_PRODUCT_ID = env; __clearLicenceCachesForTests(); });
  __clearLicenceCachesForTests();
  return calls;
}
const PRODUCTS = { GUMROAD_PRODUCT_BUILDER: 'prod-builder', GUMROAD_PRODUCT_TEAM: 'prod-team' };
const ok = (purchase = {}) => ({ success: true, purchase });
const no = { success: false, message: 'That license does not exist for the provided product.' };

test('licences map to plans by product; the Partner product is checked first and alone when valid', async (t) => {
  const calls = mockLicenceService(t, (product, key) => (product === 'prod-partner' && key === 'frits') || (product === 'prod-builder' && key === 'b') || (product === 'prod-team' && key === 't') ? ok() : no);
  assert.deepEqual(await resolveLicencePlan('frits', { env: PRODUCTS }), { valid: true, tier: 'partner' });
  assert.deepEqual(calls.map((c) => c.product), ['prod-partner'], 'a Partner key never reaches the other products');
  assert.deepEqual(await resolveLicencePlan('b', { env: PRODUCTS }), { valid: true, tier: 'builder' });
  assert.deepEqual(await resolveLicencePlan('t', { env: PRODUCTS }), { valid: true, tier: 'team' });
  assert.equal((await resolveLicencePlan('nobody', { env: PRODUCTS })).valid, false);
  assert.equal((await resolveLicencePlan('pg1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', { env: PRODUCTS })).valid, false);
  assert.ok(!calls.some((c) => c.key.startsWith('pg1_')), 'PG1 keys are never sent to the licence service');
  // Without the new product ids, only the Partner product is checked (today's behaviour).
  const before = calls.length;
  assert.equal((await resolveLicencePlan('b', { env: {} })).valid, false);
  assert.equal(calls.length - before, 1);
});

test('licence results are cached 24 h; a cancelled or refunded subscription loses its plan at the next check', async (t) => {
  let state = ok();
  const calls = mockLicenceService(t, (product, key) => (product === 'prod-builder' ? state : no));
  assert.equal((await resolveLicencePlan('k1', { env: PRODUCTS })).tier, 'builder');
  const n = calls.length;
  assert.equal((await resolveLicencePlan('k1', { env: PRODUCTS })).tier, 'builder');
  assert.equal(calls.filter((c) => c.product === 'prod-builder').length, 1, 'the builder answer is cached');
  assert.ok(calls.length >= n);
  // Next check (cache cleared = the 24 h passed): cancelled, ended, refunded, failed.
  for (const purchase of [{ subscription_ended_at: '2026-01-01T00:00:00Z' }, { subscription_cancelled_at: '2026-01-01T00:00:00Z' }, { refunded: true }, { chargebacked: true }, { subscription_failed_at: '2026-01-01T00:00:00Z' }]) {
    __clearLicenceCachesForTests();
    state = ok(purchase);
    assert.equal((await resolveLicencePlan('k1', { env: PRODUCTS })).valid, false, JSON.stringify(purchase));
  }
  // A cancellation dated in the future keeps the plan until then.
  __clearLicenceCachesForTests();
  state = ok({ subscription_cancelled_at: '2099-01-01T00:00:00Z' });
  assert.equal((await resolveLicencePlan('k1', { env: PRODUCTS })).tier, 'builder');
});

test('licence service unreachable: verification_unavailable, never "invalid"', async (t) => {
  mockLicenceService(t, () => 'down');
  const r = await resolveLicencePlan('k2', { env: PRODUCTS });
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'verification_unavailable');
  assert.equal((await verifyGumroadProduct('k2', 'prod-builder')).reason, 'verification_unavailable');
});

// --- MCP and REST with the switch on ------------------------------------------------------

function makeRes() {
  return { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; }, send(p) { this.body = p; return this; } };
}

function onEnv(t) {
  const original = process.env;
  process.env = { ...original, PG1_PAID_CHECKS: 'on', TELEMETRY_IP_SALT: 'plans-test-salt' };
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const store = createMemoryKeyStore();
  __setDefaultKeyStoreForTests(store);
  const prices = [];
  __setX402GateForTests(async (req, params, { price, description }) => {
    prices.push(price);
    const paying = params?._meta?.['x402/payment'] || req.headers['payment-signature'];
    if (!paying) return { authorized: false, paymentRequired: { x402Version: 2, error: 'Payment required', resource: { url: 'https://pg1-ai-agent.vercel.app/api/mcp', description }, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '2000', price }] } };
    return { authorized: true, payer: '0x1111111111111111111111111111111111111111', settle: async () => ({ success: true, transaction: '0xabc', network: 'eip155:8453' }), settlementFailurePaymentRequired: async () => ({}) };
  });
  // The payer's sanctions screening is covered by tests/screening.test.mjs.
  __setScreeningForTests(async () => ({ allowed: true, refused: false, unavailable: false, lists: [] }));
  t.after(() => { process.env = original; __setDefaultKeyStoreForTests(undefined); __setX402GateForTests(null); __setScreeningForTests(null); resetAgentMessageRateLimit(); resetRepoTrapRateLimit(); });
  resetAgentMessageRateLimit(); resetRepoTrapRateLimit(); __clearKeyCacheForTests();
  return { store, prices };
}

async function mcpCall(name, args, headers = {}, meta) {
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.50', ...headers }, query: {}, body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } } }, res);
  return res;
}

test('MCP, switch on: the 26th check gets an x402 challenge at 0.002 USD with /keys and /pricing; paying serves it', async (t) => {
  const { prices } = onEnv(t);
  for (let i = 0; i < 25; i++) {
    const r = await mcpCall(i % 2 ? 'check_agent_message' : 'check_repo_trap', i % 2 ? msg : repo);
    assert.ok(!r.body.result.isError, `call ${i + 1}`);
    assert.equal(r.headers['X-PG1-Plan'], 'anonymous');
  }
  const over = await mcpCall('check_agent_message', msg);
  assert.equal(over.statusCode, 200);
  assert.equal(over.body.result.isError, true);
  const pr = over.body.result.structuredContent;
  assert.equal(prices.at(-1), '$0.002');
  assert.ok(pr.error.includes(KEYS_URL) && pr.error.includes(PRICING_URL));
  assert.deepEqual(pr.extensions['pg1-plans'], { keys_url: KEYS_URL, pricing_url: PRICING_URL, pay_per_check_usd: 0.002, plan: 'anonymous', quota: 25, resets_at: periodFor('anonymous').resetsAt });
  assert.ok(over.headers['PAYMENT-REQUIRED']);
  assert.doesNotMatch(JSON.stringify(over.body), SAFE);
  assert.doesNotMatch(pr.error, PROVIDERS);
  const paid = await mcpCall('check_agent_message', msg, {}, { 'x402/payment': { x402Version: 2, payload: {} } });
  assert.ok(!paid.body.result.isError);
  assert.equal(paid.body.result._meta['x402/payment-response'].success, true);
  assert.equal(prices.at(-1), '$0.002');
  assert.equal(JSON.parse(paid.body.result.content[0].text).verdict, 'no_findings');
});

test('MCP, switch on: a refused payer is never served or charged', async (t) => {
  onEnv(t);
  __setScreeningForTests(async () => ({ allowed: false, refused: true, unavailable: false, lists: ['ofac'], message: 'This wallet is on a sanctions list. Nothing was charged.' }));
  const r = await mcpCall('check_agent_message', msg, {}, { 'x402/payment': { x402Version: 2 } });
  assert.equal(r.body.result.isError, true);
  assert.equal(JSON.parse(r.body.result.content[0].text).code, 'payer_refused');
});

test('MCP, switch on: a free key gets 500 a day; other tools ignore it and keep their pricing', async (t) => {
  const { store } = onEnv(t);
  const { key } = await createFreeKey(store, { email: 'mcp@example.com' });
  const r = await mcpCall('check_agent_message', msg, { 'x-api-key': key });
  assert.equal(r.headers['X-PG1-Plan'], 'free');
  assert.equal(r.headers['X-PG1-Quota'], '500');
  assert.equal(r.headers['X-PG1-Quota-Remaining'], '499');
});

test('MCP, switch off: no plan headers change the old answers; payment headers are ignored for these tools', async (t) => {
  onEnv(t);
  process.env.PG1_PAID_CHECKS = 'off';
  for (let i = 0; i < 30; i++) assert.ok(!(await mcpCall('check_repo_trap', repo)).body.result.isError);
  const r = await mcpCall('check_agent_message', msg, {}, { 'x402/payment': { x402Version: 2 } });
  assert.ok(!r.body.result.isError);
  assert.equal(r.body.result._meta && r.body.result._meta['x402/payment-response'], undefined, 'nobody is charged while off');
});

test('REST /api/repo-trap, switch on: 402 with PAYMENT-REQUIRED and the links over the limit', async (t) => {
  onEnv(t);
  const call = async (headers = {}) => { const res = makeRes(); await repoTrapRest({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.60', ...headers }, query: {}, body: repo }, res); return res; };
  for (let i = 0; i < 25; i++) assert.equal((await call()).statusCode, 200);
  const over = await call();
  assert.equal(over.statusCode, 402);
  assert.equal(over.body.error, 'payment_required');
  assert.equal(over.body.keys_url, KEYS_URL);
  assert.equal(over.body.pricing_url, PRICING_URL);
  assert.equal(over.body.pay_per_check_usd, 0.002);
  assert.ok(over.headers['PAYMENT-REQUIRED']);
  assert.doesNotMatch(JSON.stringify(over.body), SAFE);
  const paid = await call({ 'payment-signature': 'x' });
  assert.equal(paid.statusCode, 200);
  assert.ok(paid.headers['PAYMENT-RESPONSE']);
});

test('A2A, switch on: over the limit, an input-required task with the x402 requirements at 0.002 USD and the links', async (t) => {
  const { prices } = onEnv(t);
  const send = async (meta) => {
    const res = makeRes();
    await a2aHandler({ method: 'POST', headers: { 'a2a-version': '1.0', 'x-forwarded-for': '203.0.113.70' }, query: {}, body: { jsonrpc: '2.0', id: 3, method: 'SendMessage', params: { message: { messageId: 'm1', role: 'ROLE_USER', ...(meta ? { metadata: meta } : {}), parts: [{ data: { skill: 'check_repo_trap', arguments: repo } }] } } } }, res);
    return res;
  };
  for (let i = 0; i < 25; i++) assert.ok((await send()).body.result.task.artifacts, `call ${i + 1}`);
  const over = await send();
  const task = over.body.result.task;
  assert.equal(task.metadata['x402.payment.status'], 'payment-required');
  assert.equal(prices.at(-1), '$0.002');
  const note = JSON.stringify(task.status.message);
  assert.ok(note.includes(KEYS_URL) && note.includes(PRICING_URL));
  assert.doesNotMatch(note, PROVIDERS);
  assert.doesNotMatch(note, SAFE);
  const paid = await send({ 'x402.payment.payload': { x402Version: 2, payload: {} } });
  assert.ok(paid.body.result.task.artifacts, 'paying serves the check');
});

test('the two tools\' MCP descriptions only gain the plans sentence; names and schemas unchanged', () => {
  for (const name of METERED_TOOLS) {
    const def = TOOL_DEFINITIONS.find((d) => d.name === name);
    assert.ok(def.description.endsWith(METERED_DESCRIPTION_NOTE));
    assert.ok(def.description.includes(KEYS_URL) && def.description.includes(PRICING_URL));
    assert.match(METERED_DESCRIPTION_NOTE, /25 free checks a day/);
    assert.match(METERED_DESCRIPTION_NOTE, /500 a day with a free key/);
  }
});

// --- /usage ------------------------------------------------------------------------

test('/usage: the metered and other edge tools are never labelled paid; counts by plan; signups per day', () => {
  for (const tool of ['check_agent_message', 'check_repo_trap', 'check_x402_endpoint', 'check_agent_card', 'verify_result']) assert.equal(toolPricing(tool, {}), 'free', tool);
  assert.equal(toolPricing('check_agent_message', { PG1_PAID_CHECKS: 'on' }), 'plans');
  assert.equal(toolPricing('get_cve_details', {}), 'paid');
  const at = new Date(NOW - 3600e3).toISOString();
  const row = (plan, payment_type = 'free', tool_name = 'check_agent_message', i = 0) => ({ created_at: at, event_type: 'tool_call', endpoint: '/api/mcp', tool_name, payment_type, status: 'ok', plan, caller_hash: String(i).padStart(32, 'a') });
  const rows = [row('anonymous'), row('anonymous', 'free', 'check_repo_trap', 1), row('free'), row('builder'), row('team'), row('partner'), row('anonymous', 'x402'), row(undefined), row('free', 'free', 'check_domain_age')];
  const r = aggregateUsage(rows, { period: '24h', now: NOW, ownHashes: new Set() });
  assert.deepEqual(r.checks_by_plan, { anonymous: 2, free_key: 1, builder: 1, team: 1, partner: 1, x402_paid: 1, unrecorded: 1 });
  assert.ok(r.tools.filter((x) => METERED_TOOLS.includes(x.tool)).every((x) => x.pricing === 'free'));
  const s = signupsView({ '2026-11-22': 3 }, { days: ['2026-11-21', '2026-11-22'] });
  assert.deepEqual(s, { total: 3, per_day: [{ day: '2026-11-21', signups: 0 }, { day: '2026-11-22', signups: 3 }] });
  const card = usageCardView({ ...r, signups: s }, { now: NOW });
  const text = JSON.stringify(card);
  assert.match(text, /Message and repo checks by plan/);
  assert.match(text, /Free-key signups/);
  const tools = card.sections.find((x) => x.id === 'tools');
  const metered = tools.groups[0].rows.filter((x) => METERED_TOOLS.includes(x.label));
  assert.ok(metered.length > 0 && metered.every((x) => !/paid/.test(x.sub)), 'never "paid"');
});
