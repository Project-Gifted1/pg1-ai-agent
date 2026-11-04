/**
 * The durable sign-in lockout and the sign-in alerts (lib/security), on
 * the real migration (PGlite behind a PostgREST stand-in):
 *   - the per-IP lockout (5 failures in 15 minutes) lives in the database,
 *     so it survives a new instance (fresh memory, new store object);
 *   - the global limit (30 failures an hour from anywhere) stops every
 *     password attempt, from any IP, even the right one; a passkey still
 *     signs in;
 *   - a right sign-in clears that IP's failures; IPs are stored as a keyed
 *     hash, never the address;
 *   - a database that does not answer still leaves a per-instance lockout;
 *   - a push on every new sign-in (password, recovery, passkey) and on a
 *     burst of 5+ failures in 10 minutes (once per window): device type
 *     and rough time only, never the IP or the user agent;
 *   - the compares are the timing-safe ones.
 * Run with: npm test
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb, pgRest } from './helpers/pgrest.mjs';
import { createSoftAuthenticator } from './helpers/softAuthenticator.mjs';
import { createSupabaseSecurityStore } from '../lib/security/store.mjs';
import { createSecurityHandler } from '../api/security.mjs';
import { authenticateOperator, ipHash, __resetAuthMirror, AUTH_MAX_FAILURES, AUTH_GLOBAL_MAX_FAILURES, AUTH_FAILURE_WINDOW_MS } from '../lib/security/auth.mjs';
import { deviceType, roughTime, BURST_FAILURES, BURST_WINDOW_MS } from '../lib/security/alerts.mjs';
import { safeCompare as sharedCompare } from '../lib/security/compare.mjs';
import { safeCompare as chatCompare } from '../api/chat.mjs';

const MIGRATION = '20261114120000_pg1_operator_security.sql';
const ORIGIN = 'http://localhost:3000';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ENV = { USER_API_KEY: 'gift', USER_API_PASS: 'correct horse battery', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key' };
const RIGHT = { user: ENV.USER_API_KEY, pass: ENV.USER_API_PASS };
const WRONG = { user: ENV.USER_API_KEY, pass: 'wrong' };

let db;
let clock;
let pushes;

beforeEach(async () => {
  db = await makeDb([MIGRATION]);
  __resetAuthMirror();
  clock = Date.parse('2026-11-04T13:37:00Z');
  pushes = [];
});

// One "instance": its own store object (and, after __resetAuthMirror, its
// own empty memory) over the shared database.
const instance = () => createSupabaseSecurityStore({ supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: pgRest(db) });
const push = async (m) => { pushes.push(m); return 1; };
const req = (ip, ua = ANDROID, extra = {}) => ({ headers: { host: 'localhost:3000', 'user-agent': ua, ...extra }, socket: { remoteAddress: ip } });
const attempt = (store, ip, creds, ua) => authenticateOperator(req(ip, ua), creds, { store, env: ENV, now: () => clock, push });

test('the per-IP lockout is in the database: it survives a new instance, and holds the right password out too', async () => {
  const a = instance();
  for (let i = 0; i < AUTH_MAX_FAILURES; i++) {
    const r = await attempt(a, '203.0.113.50', WRONG);
    assert.equal(r.rateLimited, false, `attempt ${i + 1}`);
    assert.equal(r.isOperator, false);
  }
  assert.equal((await attempt(a, '203.0.113.50', RIGHT)).rateLimited, true);

  // A cold start somewhere else: nothing in memory, a new store.
  __resetAuthMirror();
  const b = instance();
  const r = await attempt(b, '203.0.113.50', RIGHT);
  assert.equal(r.rateLimited, true, 'still locked on the new instance');
  assert.equal(r.isOperator, false);
  assert.equal(r.limit, 'ip');
  // Another IP is not locked.
  assert.equal((await attempt(b, '203.0.113.51', RIGHT)).isOperator, true);
  // The window passes: unlocked.
  clock += AUTH_FAILURE_WINDOW_MS + 1000;
  __resetAuthMirror();
  assert.equal((await attempt(instance(), '203.0.113.50', RIGHT)).isOperator, true);
});

test('the IP is stored as a keyed hash, never the address; a right sign-in clears that IP\'s failures', async () => {
  const a = instance();
  for (let i = 0; i < 3; i++) await attempt(a, '203.0.113.60', WRONG);
  const rows = (await db.query('select * from pg1_auth_events')).rows;
  assert.equal(rows.length, 3);
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes('203.0.113.60'), 'no address');
  assert.ok(!dump.includes('203.0.113'), 'no part of one');
  assert.ok(!dump.includes('Pixel'), 'no user agent');
  assert.equal(rows[0].ip_hash, ipHash('203.0.113.60', ENV));
  assert.match(rows[0].ip_hash, /^[0-9a-f]{32}$/);
  assert.equal(rows[0].device, 'Android phone');
  assert.equal(rows[0].method, 'password');
  assert.equal((await attempt(a, '203.0.113.60', RIGHT)).isOperator, true);
  assert.equal((await db.query("select count(*)::int as n from pg1_auth_events where kind = 'failure'")).rows[0].n, 0);
});

test(`the global limit: ${AUTH_GLOBAL_MAX_FAILURES} failures an hour from anywhere stop every password attempt, on every instance; a passkey still signs in`, async () => {
  const a = instance();
  // A distributed guess: never 5 from one IP.
  for (let i = 0; i < AUTH_GLOBAL_MAX_FAILURES; i++) {
    clock += 1000;
    const r = await attempt(a, `198.51.100.${i + 1}`, WRONG, WINDOWS);
    assert.equal(r.rateLimited, false, `attempt ${i + 1}`);
  }
  __resetAuthMirror();
  const b = instance();
  const fresh = await attempt(b, '192.0.2.200', RIGHT);
  assert.equal(fresh.rateLimited, true, 'a new IP with the right password is held off');
  assert.equal(fresh.limit, 'global');
  assert.equal(fresh.isOperator, false);

  // Gift's passkey is not a password attempt: it still works.
  const phone = createSoftAuthenticator({ origin: ORIGIN });
  const handler = createSecurityHandler({ store: b, env: ENV, now: () => clock, push });
  const res = () => ({ statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(x) { this.body = x; return this; } });
  const call = async (body, ip = '192.0.2.201') => { const r = res(); await handler({ method: 'POST', headers: { host: 'localhost:3000', origin: ORIGIN, 'user-agent': ANDROID }, socket: { remoteAddress: ip }, body }, r); return r; };
  // (registered before the attack, straight into the store)
  const startReg = await call({ op: 'register-options', ...RIGHT }, '192.0.2.202');
  assert.equal(startReg.statusCode, 429, 'password-authed registration is held off too');
  const { beginPasskeyRegistration, finishPasskeyRegistration } = await import('../lib/security/auth.mjs');
  const reg = await beginPasskeyRegistration(req('192.0.2.203'), { store: b, env: ENV, now: () => clock });
  assert.equal((await finishPasskeyRegistration(req('192.0.2.203'), { credential: phone.create(reg.options), challengeToken: reg.challengeToken }, { store: b, env: ENV, now: () => clock })).ok, true);
  const s = await call({ op: 'passkey-options' });
  const signin = await call({ op: 'passkey', credential: phone.get(s.body.options), challengeToken: s.body.challengeToken });
  assert.equal(signin.statusCode, 200, JSON.stringify(signin.body));

  // An hour later the password path opens again (no passkey case aside).
  clock += 60 * 60 * 1000 + 1000;
  __resetAuthMirror();
  const later = await attempt(instance(), '192.0.2.204', WRONG);
  assert.equal(later.rateLimited, false);
});

test('a database that does not answer still leaves this instance\'s lockout (the memory mirror)', async () => {
  const down = createSupabaseSecurityStore({ supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: async () => new Response('{}', { status: 503 }) });
  for (let i = 0; i < AUTH_MAX_FAILURES; i++) await attempt(down, '203.0.113.70', WRONG);
  assert.equal((await attempt(down, '203.0.113.70', RIGHT)).rateLimited, true);
});

test('a push on every new sign-in: the device type and a rough time, never the IP or the user agent', async () => {
  const handler = createSecurityHandler({ store: instance(), env: ENV, now: () => clock, push });
  const out = { statusCode: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(x) { this.body = x; return this; } };
  await handler({ method: 'POST', headers: { host: 'localhost:3000', origin: ORIGIN, 'user-agent': ANDROID }, socket: { remoteAddress: '203.0.113.80' }, body: { op: 'password', ...RIGHT } }, out);
  assert.equal(out.statusCode, 200);
  assert.equal(pushes.length, 1);
  const [p] = pushes;
  assert.equal(p.title, 'New PG1 sign-in');
  assert.equal(p.tag, 'pg1-signin');
  assert.equal(p.body, `Signed in with the password on an Android phone, ${roughTime(clock)}. Not you? Send /security signout-all.`);
  assert.match(p.body, /about \d\d:(00|15|30|45)/);
  assert.ok(!/203\.0\.113|\d+\.\d+\.\d+\.\d+/.test(JSON.stringify(p)), 'no IP');
  assert.ok(!/Mozilla|Chrome|Pixel/.test(JSON.stringify(p)), 'no user agent');

  // A passkey sign-in says so. (Rough time: 13:37 is "about 13:30"; the
  // operator's zone, Europe/Dublin, is UTC in November.)
  assert.equal(roughTime(Date.parse('2026-11-04T13:37:00Z')), 'about 13:30');
  assert.equal(roughTime(Date.parse('2026-07-04T13:40:00Z')), 'about 14:45');
  const store = instance();
  const phone = createSoftAuthenticator({ origin: ORIGIN });
  const { beginPasskeyRegistration, finishPasskeyRegistration, beginPasskeySignIn, finishPasskeySignIn } = await import('../lib/security/auth.mjs');
  const reg = await beginPasskeyRegistration(req('203.0.113.81'), { store, env: ENV, now: () => clock });
  await finishPasskeyRegistration(req('203.0.113.81'), { credential: phone.create(reg.options), challengeToken: reg.challengeToken }, { store, env: ENV, now: () => clock });
  assert.equal(pushes.length, 1, 'adding a passkey is not a sign-in');
  const s = beginPasskeySignIn(req('203.0.113.81'), { env: ENV, now: () => clock });
  const r = await finishPasskeySignIn(req('203.0.113.81', WINDOWS), { credential: phone.get(s.options), challengeToken: s.challengeToken }, { store, env: ENV, now: () => clock, push });
  assert.equal(r.ok, true);
  assert.equal(pushes.length, 2);
  assert.match(pushes[1].body, /^Signed in with a passkey on a Windows computer, about \d\d:\d\d\./);
  // Requests on an existing session send nothing.
  await authenticateOperator(req('203.0.113.81', ANDROID, { cookie: `__Host-pg1_session=${r.session.token}` }), null, { store, env: ENV, now: () => clock, push });
  assert.equal(pushes.length, 2);
});

test(`a burst alert at ${BURST_FAILURES}+ failed attempts in 10 minutes, once per window, from any mix of IPs and instances`, async () => {
  const a = instance();
  for (let i = 0; i < BURST_FAILURES - 1; i++) { clock += 30000; await attempt(a, `198.51.100.${i + 10}`, WRONG, WINDOWS); }
  assert.equal(pushes.length, 0, 'four is not a burst');
  // The fifth, on another instance.
  __resetAuthMirror();
  const b = instance();
  clock += 30000;
  await attempt(b, '198.51.100.99', WRONG, WINDOWS);
  assert.equal(pushes.length, 1);
  const [p] = pushes;
  assert.equal(p.title, 'Failed PG1 sign-ins');
  assert.equal(p.tag, 'pg1-signin-failures');
  assert.equal(p.body, `5 failed sign-in attempts in 10 minutes, the latest from a Windows computer, ${roughTime(clock)}.`);
  assert.ok(!/198\.51|\d+\.\d+\.\d+\.\d+/.test(JSON.stringify(p)), 'no IP');
  // More failures in the same window: no second alert.
  for (let i = 0; i < 3; i++) { clock += 10000; await attempt(instance(), `198.51.100.${i + 50}`, WRONG); }
  assert.equal(pushes.length, 1);
  // Failed passkey attempts count too, in a later window.
  clock += BURST_WINDOW_MS + 60000;
  const { finishPasskeySignIn } = await import('../lib/security/auth.mjs');
  for (let i = 0; i < BURST_FAILURES; i++) {
    clock += 1000;
    await finishPasskeySignIn(req(`192.0.2.${i + 1}`), { credential: { type: 'public-key', id: 'nope', response: {} }, challengeToken: 'bad' }, { store: instance(), env: ENV, now: () => clock, push });
  }
  assert.equal(pushes.length, 2);
  assert.match(pushes[1].body, /^5 failed sign-in attempts in 10 minutes, the latest from an Android phone, about/);
});

test('device types are a few fixed words', () => {
  assert.equal(deviceType(ANDROID), 'Android phone');
  assert.equal(deviceType('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/141 Safari/537.36'), 'Android tablet');
  assert.equal(deviceType('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iPhone');
  assert.equal(deviceType(WINDOWS), 'Windows computer');
  assert.equal(deviceType('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), 'Mac');
  assert.equal(deviceType('curl/8.4.0'), 'script or bot');
  assert.equal(deviceType(''), 'unknown device');
});

test('timing-safe compares: one shared safeCompare, both compares always run', () => {
  assert.equal(chatCompare, sharedCompare);
  const src = readFileSync(new URL('../lib/security/auth.mjs', import.meta.url), 'utf8');
  assert.match(src, /const u = safeCompare\(user, exp\.user\);\n\s*const p = safeCompare\(pass, exp\.pass\);/);
  const cmp = readFileSync(new URL('../lib/security/compare.mjs', import.meta.url), 'utf8');
  assert.match(cmp, /crypto\.timingSafeEqual\(providedBuf, expectedBuf\)/);
  for (const f of ['../api/errors.mjs', '../api/handoffs.mjs', '../lib/operatorSession.mjs']) {
    const s = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(s, /authenticateOperator/, `${f} uses the shared sign-in`);
    assert.doesNotMatch(s, /process\.env\.USER_API_PASS/, `${f} has no compare of its own`);
  }
});
