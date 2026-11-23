/**
 * Free API keys (1.23.0, lib/apiKeys.mjs, lib/keysApi.mjs, /keys):
 *   - the key is returned once and stored only as a hash;
 *   - one active free key per email; rotating revokes the old key;
 *   - "delete my key and email" by key or by email removes the email, the
 *     keys and the usage counts;
 *   - consent is required, product news is opt-in (off by default);
 *   - a strict per-IP signup limit without a bot check, the bot check when
 *     configured;
 *   - Team keys: only with a Team licence, at most 4 (5 with the licence);
 *   - the pages and responses never say "safe" and never name a provider;
 *   - the migration runs on a real Postgres and keeps one free key per email.
 * Run with: node --test tests/keys-signup.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createKeysHandler, __resetKeyLimitsForTests, SIGNUP_LIMIT_WITHOUT_CHALLENGE, SIGNUP_MESSAGE, DELETION_REQUEST_MESSAGE } from '../lib/keysApi.mjs';
import { handleKeysCommand, pendingDeletionSummary } from '../lib/keysOperator.mjs';
import { createMemoryKeyStore, hashApiKey, hashEmail, freeKeySubject, isWellFormedPg1Key, normalizeEmail, licenceAccount } from '../lib/apiKeys.mjs';
import { resolveCaller, __clearKeyCacheForTests } from '../lib/checkMeter.mjs';
import subscribe, { checkoutUrl } from '../api/plans/subscribe.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SAFE = /\bsafe\b/i;
const PROVIDERS = /gumroad|stripe|paddle|lemon ?squeezy|turnstile|cloudflare|coinbase/i;

function makeRes() {
  return { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; }, send(p) { this.body = p; return this; } };
}

function setup(t, { env = {}, verifyChallenge, resolveLicence } = {}) {
  const prev = process.env.TELEMETRY_IP_SALT;
  process.env.TELEMETRY_IP_SALT = 'keys-test-salt';
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  t.after(() => { console.log = orig; if (prev === undefined) delete process.env.TELEMETRY_IP_SALT; else process.env.TELEMETRY_IP_SALT = prev; });
  __resetKeyLimitsForTests();
  __clearKeyCacheForTests();
  const store = createMemoryKeyStore();
  const deps = { store, env, verifyChallenge, resolveLicence };
  const call = async (action, { method = 'POST', body, headers = {}, ip = '198.51.100.30', query = {} } = {}) => {
    const res = makeRes();
    await createKeysHandler(action, deps)({ method, body, headers: { 'x-forwarded-for': ip, ...headers }, query }, res);
    return res;
  };
  return { store, call, logs };
}

test('signup: the key is returned once, well formed, and stored only as a hash', async (t) => {
  const { store, call, logs } = setup(t);
  const r = await call('signup', { body: { email: '  Dev@Example.COM ', consent: true } });
  assert.equal(r.statusCode, 200);
  assert.ok(isWellFormedPg1Key(r.body.key));
  assert.equal(r.body.shown_once, true);
  assert.equal(r.body.header, 'X-API-KEY');
  assert.equal(r.body.daily_quota, 500);
  assert.equal(r.headers['Cache-Control'], 'no-store');
  const row = store.keys[0];
  assert.equal(row.key_hash, hashApiKey(r.body.key));
  assert.equal(row.email, 'dev@example.com');
  assert.equal(row.email_hash, hashEmail('dev@example.com'));
  assert.equal(row.marketing_opt_in, false, 'no product news unless asked');
  assert.ok(row.consent_at);
  assert.ok(!JSON.stringify(store.keys).includes(r.body.key), 'the raw key is never stored');
  assert.ok(!logs.join('\n').includes(r.body.key) && !logs.join('\n').includes('dev@example.com'), 'never logged');
  // The key now resolves to the free plan.
  assert.equal((await resolveCaller({ licenseKey: r.body.key, identifier: '1.2.3.4' }, { store })).tier, 'free');
});

test('signup: consent required, product news only when ticked, invalid email refused', async (t) => {
  const { store, call } = setup(t);
  assert.equal((await call('signup', { body: { email: 'a@example.com' } })).body.error, 'consent_required');
  assert.equal((await call('signup', { body: { email: 'a@example.com', consent: 'yes' } })).body.error, 'consent_required');
  for (const bad of ['', 'nope', 'a@b', 'a b@example.com', '<a@example.com>', `${'a'.repeat(250)}@example.com`]) {
    assert.equal((await call('signup', { body: { email: bad, consent: true }, ip: `198.51.100.${40 + bad.length % 50}` })).body.error, 'invalid_email', bad);
  }
  assert.equal(normalizeEmail('X@Y.IE'), 'x@y.ie');
  const r = await call('signup', { body: { email: 'news@example.com', consent: true, marketing: true }, ip: '198.51.100.99' });
  assert.equal(r.statusCode, 200);
  assert.equal(store.keys.find((k) => k.email === 'news@example.com').marketing_opt_in, true);
});

test('one active free key per email; rotation revokes the old key and keeps the day\'s count', async (t) => {
  const { store, call } = setup(t);
  const first = await call('signup', { body: { email: 'one@example.com', consent: true } });
  const again = await call('signup', { body: { email: 'one@example.com', consent: true }, ip: '198.51.100.31' });
  // The answer never says whether the email is registered: the same status
  // and message as a fresh signup; only no key in it.
  const fresh = await call('signup', { body: { email: 'two@example.com', consent: true }, ip: '198.51.100.32' });
  assert.equal(again.statusCode, 200);
  assert.equal(again.statusCode, fresh.statusCode);
  assert.equal(again.body.message, fresh.body.message);
  assert.equal(again.body.message, SIGNUP_MESSAGE);
  assert.equal(SIGNUP_MESSAGE, 'If this email can get a key, it has been issued; check the page.');
  assert.ok(!('key' in again.body));
  assert.ok(!JSON.stringify(again.body).match(/exist|already|registered/i), 'no word gives it away');
  assert.ok(fresh.body.key, 'a key only when one was created');
  store.usage.set(`${freeKeySubject(hashEmail('one@example.com'))}|2026-11-22`, 7);
  const rotated = await call('rotate', { headers: { 'x-api-key': first.body.key } });
  assert.equal(rotated.statusCode, 200);
  assert.equal(rotated.body.old_key_revoked, true);
  assert.notEqual(rotated.body.key, first.body.key);
  assert.equal(await store.findActiveKey(hashApiKey(first.body.key)), null, 'the old key is revoked');
  assert.ok(await store.findActiveKey(hashApiKey(rotated.body.key)));
  assert.equal(store.keys.filter((k) => !k.revoked_at && k.email === 'one@example.com').length, 1, 'still one active key for the email');
  assert.equal((await resolveCaller({ licenseKey: rotated.body.key, identifier: 'x' }, { store })).subject, freeKeySubject(hashEmail('one@example.com')), 'same counter after rotation');
  assert.equal((await call('rotate', { headers: { 'x-api-key': first.body.key } })).statusCode, 404);
  assert.equal((await call('rotate', { headers: {} })).statusCode, 400);
});

test('delete my key and email: at once with the key; with only an email, a request the operator carries out', async (t) => {
  const { store, call } = setup(t);
  const a = await call('signup', { body: { email: 'del@example.com', consent: true } });
  store.usage.set(`${freeKeySubject(hashEmail('del@example.com'))}|2026-11-22`, 3);
  const byKey = await call('delete', { headers: { 'x-api-key': a.body.key } });
  assert.equal(byKey.statusCode, 200);
  assert.equal(byKey.body.deleted, true);
  assert.equal(store.keys.length, 0);
  assert.deepEqual([...store.usage.keys()].filter((k) => k.startsWith('free:')), [], 'the usage counts are deleted');
  // With only an email: NOTHING is deleted (anyone can type an email); a request is recorded.
  const b = await call('signup', { body: { email: 'del2@example.com', consent: true } });
  const byEmail = await call('delete', { body: { email: 'DEL2@example.com' } });
  assert.equal(byEmail.statusCode, 200);
  assert.equal(byEmail.body.message, "We'll delete your email and key within 30 days.");
  assert.equal(byEmail.body.message, DELETION_REQUEST_MESSAGE);
  assert.equal(store.keys.length, 1, 'the key still works');
  assert.ok(await store.findActiveKey(hashApiKey(b.body.key)));
  assert.equal(store.requests.length, 1);
  assert.equal(store.requests[0].email_hash, hashEmail('del2@example.com'));
  assert.ok(!JSON.stringify(store.requests).includes('del2@'), 'the request stores no email');
  // Asked twice: still one request.
  await call('delete', { body: { email: 'del2@example.com' } });
  assert.equal(store.requests.length, 1);
  // The same answer for an email that never had a key; nothing recorded for it.
  const none = await call('delete', { body: { email: 'never@example.com' } });
  assert.equal(none.statusCode, byEmail.statusCode);
  assert.deepEqual(none.body.message, byEmail.body.message);
  assert.equal(store.requests.length, 1);
  assert.equal((await call('delete', { body: {} })).statusCode, 400);
  // The operator carries it out: /keys delete-request <id> approve.
  const id = store.requests[0].id.slice(0, 8);
  assert.equal((await handleKeysCommand({ text: '/keys delete-requests', isOperator: false, store })).status, 401, 'operator only');
  const list = await handleKeysCommand({ text: '/keys delete-requests', isOperator: true, store });
  assert.match(list.reply, new RegExp(`\\\`${id}\\\` · asked 0 days ago · due in 30 days`));
  assert.ok(!list.reply.includes('del2@'), 'never an email in the reply');
  const done = await handleKeysCommand({ text: `/keys delete-request ${id} approve`, isOperator: true, store });
  assert.match(done.reply, /Done .*: 1 key, the email and its usage counts deleted\./);
  assert.equal(store.keys.length, 0);
  assert.equal(store.requests[0].status, 'done');
  assert.match((await handleKeysCommand({ text: `/keys delete-request ${id} approve`, isOperator: true, store })).reply, /No waiting request/);
  // Decline closes one without deleting.
  const c = await call('signup', { body: { email: 'keep@example.com', consent: true }, ip: '198.51.100.33' });
  await call('delete', { body: { email: 'keep@example.com' } });
  const id2 = store.requests.find((r) => r.status === 'pending').id.slice(0, 8);
  assert.match((await handleKeysCommand({ text: `/keys delete-request ${id2} decline`, isOperator: true, store })).reply, /Declined/);
  assert.ok(await store.findActiveKey(hashApiKey(c.body.key)));
  // The daily report names the waiting requests.
  await call('delete', { body: { email: 'keep@example.com' } });
  const sum = await pendingDeletionSummary({ store });
  assert.equal(sum.count, 1);
});

test('a strict per-IP signup limit without a bot check', async (t) => {
  const { call } = setup(t);
  for (let i = 0; i < SIGNUP_LIMIT_WITHOUT_CHALLENGE; i++) assert.equal((await call('signup', { body: { email: `u${i}@example.com`, consent: true }, ip: '198.51.100.77' })).statusCode, 200);
  const over = await call('signup', { body: { email: 'u9@example.com', consent: true }, ip: '198.51.100.77' });
  assert.equal(over.statusCode, 429);
  assert.equal(over.body.error, 'rate_limited');
  assert.equal((await call('signup', { body: { email: 'other@example.com', consent: true }, ip: '198.51.100.78' })).statusCode, 200);
});

test('the bot check when both keys are set: the site key is published, a failed check is refused', async (t) => {
  const seen = [];
  const { call } = setup(t, { env: { TURNSTILE_SITE_KEY: 'site-key-1', TURNSTILE_SECRET_KEY: 'secret-1' }, verifyChallenge: async (token, { secret }) => { seen.push({ token, secret }); return token === 'good'; } });
  const cfg = await call('signup', { method: 'GET' });
  assert.equal(cfg.body.challenge_site_key, 'site-key-1');
  assert.ok(!JSON.stringify(cfg.body).includes('secret-1'));
  assert.equal((await call('signup', { body: { email: 'bot@example.com', consent: true, challenge_token: 'bad' } })).statusCode, 403);
  assert.equal((await call('signup', { body: { email: 'bot@example.com', consent: true, challenge_token: 'good' } })).statusCode, 200);
  assert.deepEqual(seen.map((s) => s.secret), ['secret-1', 'secret-1']);
  const off = setup(t);
  assert.equal((await off.call('signup', { method: 'GET' })).body.challenge_site_key, null);
});

test('storage down: 503, never a key that was not saved', async (t) => {
  const { call } = setup(t);
  const broken = createMemoryKeyStore();
  broken.insertKey = async () => { throw new Error('down'); };
  const res = makeRes();
  await createKeysHandler('signup', { store: broken })({ method: 'POST', headers: { 'x-forwarded-for': '198.51.100.88' }, body: { email: 'x@example.com', consent: true } }, res);
  assert.equal(res.statusCode, 503);
  assert.ok(!('key' in res.body));
  void call;
});

test('Team keys: only with a Team licence, up to 4 more keys (5 in all), revocable', async (t) => {
  const { store, call } = setup(t, { resolveLicence: async (k) => (k === 'TEAM-LIC' ? { valid: true, tier: 'team' } : k === 'BUILDER-LIC' ? { valid: true, tier: 'builder' } : { valid: false }) });
  assert.equal((await call('team', { method: 'GET' })).statusCode, 401);
  assert.equal((await call('team', { method: 'GET', headers: { 'x-api-key': 'BUILDER-LIC' } })).statusCode, 403);
  const made = [];
  for (let i = 0; i < 4; i++) {
    const r = await call('team', { body: { label: `ci-${i}` }, headers: { 'x-api-key': 'TEAM-LIC' } });
    assert.equal(r.statusCode, 201);
    made.push(r.body);
  }
  assert.equal((await call('team', { body: {}, headers: { 'x-api-key': 'TEAM-LIC' } })).body.error, 'team_key_limit');
  const list = await call('team', { method: 'GET', headers: { 'x-api-key': 'TEAM-LIC' } });
  assert.equal(list.body.keys.length, 4);
  assert.ok(!JSON.stringify(list.body).includes(made[0].key), 'listing never shows a key');
  assert.ok(store.keys.every((k) => k.account === licenceAccount('TEAM-LIC')));
  const del = await call('team', { method: 'DELETE', query: { id: made[0].id }, headers: { 'x-api-key': 'TEAM-LIC' } });
  assert.equal(del.statusCode, 200);
  assert.equal((await call('team', { body: {}, headers: { 'x-api-key': 'TEAM-LIC' } })).statusCode, 201);
});

test('card checkout links come from env and are https only', () => {
  assert.equal(checkoutUrl('builder', {}), null);
  assert.equal(checkoutUrl('builder', { PG1_CHECKOUT_URL_BUILDER: 'http://x.example/l/a' }), null);
  assert.equal(checkoutUrl('team', { PG1_CHECKOUT_URL_TEAM: 'https://x.example/l/t' }), 'https://x.example/l/t');
  const res = makeRes();
  subscribe({ query: { plan: 'enterprise' } }, res);
  assert.equal(res.statusCode, 400);
  const closed = makeRes();
  subscribe({ query: { plan: 'builder' } }, closed);
  assert.equal(closed.statusCode, 503);
  assert.doesNotMatch(String(closed.body), PROVIDERS);
});

test('the /keys and /pricing pages: the tiers, the privacy notice, the links; never "safe", no provider names', () => {
  const keys = read('public/keys/index.html');
  const pricing = read('public/pricing/index.html');
  for (const page of [keys, pricing]) {
    const text = page.replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(text.replace(/never &ldquo;safe&rdquo;/g, ''), SAFE);
    assert.doesNotMatch(text, PROVIDERS);
    assert.ok(!/<script>(?!<\/script>)/.test(page) && !/\son[a-z]+=/i.test(page), 'no inline scripts or handlers (CSP)');
    assert.ok(!/style="/.test(page), 'no inline styles (CSP)');
  }
  assert.match(keys, /href="\/pricing"/);
  assert.match(keys, /What is stored:/);
  assert.match(keys, /Delete my key and email/);
  assert.match(keys, /id="marketing" name="marketing" type="checkbox">/, 'the product-news box is not pre-ticked');
  assert.doesNotMatch(keys, /id="marketing"[^>]*checked/);
  for (const s of ['25 checks a day', '500 checks a day', '10,000 checks a month', '100,000 checks a month', 'Up to 5 keys', 'Unlimited checks', '0.002 USD', '9 USD', '49 USD', 'no_findings', 'What counts as a check']) assert.ok(pricing.includes(s), s);
  assert.match(pricing, /href="\/keys"/);
  const vercel = JSON.parse(read('vercel.json'));
  for (const p of ['/keys', '/pricing']) assert.ok(vercel.rewrites.some((r) => r.source === p), `${p} rewrite`);
  const keysCsp = vercel.headers.find((h) => h.source === '/keys').headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(keysCsp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(keysCsp, /frame-ancestors 'none'/);
  // The agent card's docs page links to /pricing and /keys.
  const docs = read('public/docs/agents/index.html');
  assert.ok(docs.includes('https://pg1-ai-agent.vercel.app/pricing') && docs.includes('https://pg1-ai-agent.vercel.app/keys'));
  assert.equal(JSON.parse(read('public/.well-known/agent-card.json')).documentationUrl, 'https://pg1-ai-agent.vercel.app/docs/agents');
});

test('migration: runs twice on a real Postgres; one active free key per email; atomic take and refund', async () => {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role; create table public.agent_telemetry (id bigint);');
  for (const f of ['20261122120000_pg1_paid_checks.sql', '20261122130000_pg1_telemetry_plan.sql', '20261123120000_pg1_telemetry_drops.sql', '20261123130000_pg1_key_deletion_requests.sql']) {
    const sql = read(`supabase/migrations/${f}`).replace(/notify pgrst[^;]*;/g, '');
    await db.exec(sql);
    await db.exec(sql);
  }
  const take = async (limit) => (await db.query("select public.pg1_check_usage_take('anon:abc', '2026-11-22', 'anonymous', $1) as v", [limit])).rows[0].v;
  assert.deepEqual([await take(2), await take(2), await take(2)], [1, 2, -1]);
  await db.query("select public.pg1_check_usage_refund('anon:abc', '2026-11-22')");
  assert.equal(await take(2), 2);
  const ins = (h) => db.query("insert into public.pg1_api_keys (key_hash, key_hint, tier, email, email_hash, consent_at) values ($1, 'pg1_abcd', 'free', 'a@example.com', $2, now())", [h, 'b'.repeat(64)]);
  await ins('a'.repeat(64));
  await assert.rejects(() => ins('c'.repeat(64)), /duplicate|unique/);
  await db.query("update public.pg1_api_keys set revoked_at = now()");
  await ins('d'.repeat(64));
  await assert.rejects(() => db.query("insert into public.pg1_api_keys (key_hash, key_hint, tier) values ($1, 'pg1_x', 'free')", ['e'.repeat(64)]), /check/);
  await assert.rejects(() => db.query("insert into public.agent_telemetry (id, plan) values (1, 'gold')"), /check/);
});

test('the migration for deletion requests: one pending request per email, no email stored', async () => {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const sql = read('supabase/migrations/20261123130000_pg1_key_deletion_requests.sql').replace(/notify pgrst[^;]*;/g, '');
  await db.exec(sql); await db.exec(sql);
  const add = () => db.query("insert into public.pg1_key_deletion_requests (email_hash) values ($1)", ['a'.repeat(64)]);
  await add();
  await assert.rejects(add, /duplicate|unique/);
  await db.query("update public.pg1_key_deletion_requests set status = 'done'");
  await add();
  await assert.rejects(() => db.query("insert into public.pg1_key_deletion_requests (email_hash) values ('someone@example.com')"), /check/);
  const cols = (await db.query("select column_name from information_schema.columns where table_name = 'pg1_key_deletion_requests'")).rows.map((r) => r.column_name);
  assert.ok(!cols.includes('email'), 'never the address');
});

test('no marketing email before the address is verified: the opt-in is only stored', () => {
  const src = read('lib/apiKeys.mjs');
  assert.match(src, /NO marketing\s+\/\/ email may be sent on it until the address is verified/);
  assert.match(read('docs/pricing-setup.md'), /No marketing email may be sent until the address is verified/);
});
