/**
 * Passkey sign-in (lib/security, api/security.mjs), on the real migration
 * (PGlite behind a PostgREST stand-in) with a software passkey that signs
 * for real (tests/helpers/softAuthenticator.mjs):
 *   - the signed-in operator registers passkeys (several), lists and
 *     removes them; only public material is stored;
 *   - a passkey signs in: a session cookie, httpOnly, Secure,
 *     SameSite=Strict, 12 h at most;
 *   - what is refused: another origin, another RP, no user verification, a
 *     bad signature, a used challenge, an unknown passkey, a counter that
 *     goes back;
 *   - once a passkey exists the password alone is refused (the same answer
 *     whether right or wrong), in /api/security, the chat and the other
 *     routes; PG1_PASSWORD_RECOVERY=on lets it in again (default off);
 *   - sessions expire after 12 h, a forged token is refused, signout-all
 *     ends every other session, removing a passkey ends its sessions;
 *   - the /security chat commands.
 * Run with: npm test (or node --import ./tests/helpers/spend-cap.mjs --test tests/security-passkeys.test.mjs)
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeDb, pgRest } from './helpers/pgrest.mjs';
import { createSoftAuthenticator } from './helpers/softAuthenticator.mjs';
import { createSupabaseSecurityStore, memorySecurityStore } from '../lib/security/store.mjs';
import { createSecurityHandler } from '../api/security.mjs';
import { authenticateOperator, recoveryOn, __resetAuthMirror } from '../lib/security/auth.mjs';
import { SESSION_COOKIE, SESSION_MAX_MS, checkSessionToken } from '../lib/security/sessions.mjs';
import { handleSecurityCommand } from '../lib/security/chat.mjs';
import { resolveOperatorSession } from '../lib/operatorSession.mjs';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { LEAST_PRIVILEGED_ROLE } from '../lib/chatTools.mjs';

const MIGRATION = '20261114120000_pg1_operator_security.sql';
const ORIGIN = 'http://localhost:3000';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const ENV = { USER_API_KEY: 'gift', USER_API_PASS: 'correct horse battery', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key' };

let db;
let store;
let clock;
let pushes;

async function freshDb() {
  db = await makeDb([MIGRATION]);
  store = createSupabaseSecurityStore({ supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: pgRest(db) });
}

beforeEach(async () => {
  await freshDb();
  __resetAuthMirror();
  __clearAuthRateLimitState();
  clock = Date.parse('2026-11-04T10:00:00Z');
  pushes = [];
});

const now = () => clock;
const push = async (m) => { pushes.push(m); return 1; };
const deps = (env = ENV) => ({ store, env, now, push });

function makeReq(body, { cookie = '', ip = '203.0.113.7', host = 'localhost:3000', origin = ORIGIN, ua = ANDROID } = {}) {
  const headers = { host, 'user-agent': ua, 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  return { method: 'POST', url: '/api/security', headers, socket: { remoteAddress: ip }, body };
}

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; }
  };
}

async function call(body, opts = {}, env = ENV) {
  const res = makeRes();
  await createSecurityHandler(deps(env))(makeReq(body, opts), res);
  return res;
}

const cookieOf = (res) => {
  const set = res.headers['set-cookie'];
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(String(set || ''));
  return m && m[1] ? `${SESSION_COOKIE}=${m[1]}` : '';
};

// Password sign-in while no passkey exists: the session to register with.
async function passwordSession(opts = {}, env = ENV) {
  const res = await call({ op: 'password', user: env.USER_API_KEY, pass: env.USER_API_PASS }, opts, env);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return cookieOf(res);
}

async function register(auth, cookie, name = '', extra = {}) {
  const start = await call({ op: 'register-options' }, { cookie });
  assert.equal(start.statusCode, 200, JSON.stringify(start.body));
  const credential = auth.create(start.body.options, extra);
  return call({ op: 'register', credential, challengeToken: start.body.challengeToken, name }, { cookie });
}

async function passkeySignIn(auth, extra = {}, reqOpts = {}) {
  const start = await call({ op: 'passkey-options' }, reqOpts);
  assert.equal(start.statusCode, 200);
  const credential = auth.get(start.body.options, extra);
  const res = await call({ op: 'passkey', credential, challengeToken: start.body.challengeToken }, reqOpts);
  return { res, start, credential };
}

test('the operator registers a passkey from a password session and signs in with it: a 12 h httpOnly Secure SameSite=Strict cookie', async () => {
  const cookie = await passwordSession();
  const phone = createSoftAuthenticator({ origin: ORIGIN });
  const reg = await register(phone, cookie, "Gift's Pixel");
  assert.equal(reg.statusCode, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.first, true);
  assert.equal(reg.body.passkey.name, "Gift's Pixel");
  assert.equal(reg.body.passkey.device, 'Android phone');

  const { res } = await passkeySignIn(phone);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.via, 'passkey');
  const set = String(res.headers['set-cookie']);
  assert.match(set, new RegExp(`^${SESSION_COOKIE}=v1\\.`));
  assert.match(set, /; HttpOnly/);
  assert.match(set, /; Secure/);
  assert.match(set, /; SameSite=Strict/);
  assert.match(set, /; Path=\//);
  const maxAge = Number(/Max-Age=(\d+)/.exec(set)[1]);
  assert.ok(maxAge > 0 && maxAge <= SESSION_MAX_MS / 1000, `Max-Age ${maxAge}`);
  assert.equal(SESSION_MAX_MS, 12 * 60 * 60 * 1000);

  // The cookie is the operator on every route.
  const who = await authenticateOperator(makeReq({}, { cookie: cookieOf(res) }), null, deps());
  assert.equal(who.isOperator, true);
  assert.equal(who.via, 'session');
  const row = (await db.query('select method, device, passkey_id from pg1_operator_sessions where passkey_id is not null')).rows[0];
  assert.deepEqual({ method: row.method, device: row.device }, { method: 'passkey', device: 'Android phone' });
});

test('several passkeys (the phone and a second device); only public material is stored; list never shows a key or credential ID', async () => {
  const cookie = await passwordSession();
  const phone = createSoftAuthenticator({ origin: ORIGIN });
  const laptop = createSoftAuthenticator({ origin: ORIGIN, alg: 'EdDSA' });
  assert.equal((await register(phone, cookie, 'Pixel')).statusCode, 200);
  const second = await register(laptop, cookie, 'Backup key');
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.first, false);
  // The same passkey twice is refused.
  const again = await register(phone, cookie, 'Pixel again');
  assert.equal(again.statusCode, 400);

  const rows = (await db.query('select * from pg1_operator_passkeys order by created_at')).rows;
  assert.equal(rows.length, 2);
  for (const r of rows) {
    const key = crypto.createPublicKey({ key: Buffer.from(r.public_key, 'base64url'), format: 'der', type: 'spki' });
    assert.equal(key.type, 'public');
    assert.equal(key.export({ format: 'jwk' }).d, undefined, 'no private part');
    assert.deepEqual(Object.keys(r).sort(), ['algorithm', 'backed_up', 'created_at', 'credential_id', 'device', 'id', 'last_used_at', 'name', 'public_key', 'rp_id', 'sign_count', 'transports']);
  }
  assert.deepEqual(rows.map((r) => Number(r.algorithm)), [-7, -8]);

  const list = await call({ op: 'list' }, { cookie });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.body.passkeys.map((p) => p.name), ['Pixel', 'Backup key']);
  const text = JSON.stringify(list.body);
  for (const r of rows) {
    assert.ok(!text.includes(r.public_key), 'no public key in the list');
    assert.ok(!text.includes(r.credential_id), 'no credential id in the list');
  }
  // Both sign in.
  assert.equal((await passkeySignIn(phone)).res.statusCode, 200);
  assert.equal((await passkeySignIn(laptop)).res.statusCode, 200);
});

test('a guest cannot register, list or remove passkeys, or sign others out', async () => {
  for (const op of ['register-options', 'register', 'list', 'remove', 'signout-all']) {
    const res = await call({ op });
    assert.equal(res.statusCode, 401, op);
  }
  const wrong = await call({ op: 'register-options', user: 'gift', pass: 'nope' });
  assert.equal(wrong.statusCode, 401);
  // Another site's page cannot drive the endpoint, even with a cookie.
  const cookie = await passwordSession();
  const cross = await call({ op: 'list' }, { cookie, origin: 'https://evil.example' });
  assert.equal(cross.statusCode, 403);
});

test('refused passkey sign-ins: another origin, another RP, no user verification, bad signature, used challenge, unknown passkey, counter replay', async () => {
  const cookie = await passwordSession();
  const phone = createSoftAuthenticator({ origin: ORIGIN, counter: 5 });
  assert.equal((await register(phone, cookie)).statusCode, 200);

  const cases = [
    ['another origin', { originOverride: 'https://evil.example' }],
    ['another RP ID', { rpOverride: 'evil.example' }],
    ['no user verification', { uv: false }],
    ['bad signature', { tamper: true }],
    ['counter went back', { bump: 0 }, () => phone.setCounter(2)]
  ];
  for (const [name, extra, setup] of cases) {
    if (setup) setup();
    const { res } = await passkeySignIn(phone, extra);
    assert.equal(res.statusCode, 401, name);
    assert.equal(res.headers['set-cookie'], undefined, `${name}: no cookie`);
    assert.equal(res.body.error, 'That passkey was not accepted.', `${name}: neutral reply`);
  }
  // A challenge works once.
  const ok = await passkeySignIn(phone, { bump: 10 });
  assert.equal(ok.res.statusCode, 200);
  const replay = await call({ op: 'passkey', credential: phone.get(ok.start.body.options), challengeToken: ok.start.body.challengeToken });
  assert.equal(replay.statusCode, 401, 'used challenge');
  // An edited challenge token is refused.
  const s = await call({ op: 'passkey-options' });
  const forged = s.body.challengeToken.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal((await call({ op: 'passkey', credential: phone.get(s.body.options), challengeToken: forged })).statusCode, 401);
  // A passkey PG1 never registered.
  const stranger = createSoftAuthenticator({ origin: ORIGIN });
  assert.equal((await passkeySignIn(stranger)).res.statusCode, 401);
  // An expired challenge (over 2 minutes).
  const late = await call({ op: 'passkey-options' });
  clock += 3 * 60 * 1000;
  assert.equal((await call({ op: 'passkey', credential: phone.get(late.body.options), challengeToken: late.body.challengeToken })).statusCode, 401);
  // A registration challenge cannot be used to sign in.
  clock += 60 * 1000;
  const regStart = await call({ op: 'register-options' }, { cookie: await (async () => { const r = await passkeySignIn(phone); return cookieOf(r.res); })() });
  assert.equal((await call({ op: 'passkey', credential: phone.get({ challenge: regStart.body.options.challenge, rpId: 'localhost' }), challengeToken: regStart.body.challengeToken })).statusCode, 401);
});

test('once a passkey exists the password alone is refused, the same way whether it is right or wrong, on every route', async () => {
  const cookie = await passwordSession();
  const phone = createSoftAuthenticator({ origin: ORIGIN });
  assert.equal((await register(phone, cookie)).statusCode, 200);

  const right = await call({ op: 'password', user: ENV.USER_API_KEY, pass: ENV.USER_API_PASS }, { ip: '198.51.100.1' });
  const wrong = await call({ op: 'password', user: ENV.USER_API_KEY, pass: 'not it' }, { ip: '198.51.100.2' });
  assert.equal(right.statusCode, 401);
  assert.deepEqual(right.body, wrong.body, 'no password oracle');
  assert.equal(right.body.passkeyRequired, true);
  assert.equal(right.headers['set-cookie'], undefined);

  // The other routes (lib/operatorSession.mjs) refuse it too: Basic auth.
  const basic = 'Basic ' + Buffer.from(`${ENV.USER_API_KEY}:${ENV.USER_API_PASS}`).toString('base64');
  const s = await resolveOperatorSession({ headers: { authorization: basic, host: 'localhost:3000' }, socket: { remoteAddress: '198.51.100.3' } }, deps());
  assert.equal(s.isOperator, false);
  assert.equal(s.role, LEAST_PRIVILEGED_ROLE);
  assert.equal(s.passwordDisabled, true);
  // The existing session still works.
  assert.equal((await authenticateOperator(makeReq({}, { cookie }), null, deps())).isOperator, true);
});

test('the chat (default store) refuses the password once a passkey exists, and AUTH_VERIFY starts a cookie session before that', async () => {
  const env = { ...process.env };
  process.env.USER_API_KEY = ENV.USER_API_KEY;
  process.env.USER_API_PASS = ENV.USER_API_PASS;
  delete process.env.PG1_PASSWORD_RECOVERY;
  try {
    __clearAuthRateLimitState();
    const chat = async (body, opts = {}) => {
      const res = makeRes();
      await chatHandler({ method: 'POST', url: '/api/chat', headers: { host: 'localhost:3000', 'user-agent': ANDROID, ...(opts.cookie ? { cookie: opts.cookie } : {}) }, socket: { remoteAddress: opts.ip || '192.0.2.10' }, body }, res);
      return res;
    };
    const verify = await chat({ prompt: 'AUTH_VERIFY', user: ENV.USER_API_KEY, pass: ENV.USER_API_PASS });
    assert.equal(verify.statusCode, 200);
    assert.equal(verify.body.session, true);
    const cookie = cookieOf(verify);
    assert.ok(cookie, 'AUTH_VERIFY set the session cookie');
    // With the cookie and no password, operator commands run.
    const list = await chat({ prompt: '/security passkeys' }, { cookie });
    assert.equal(list.statusCode, 200);
    assert.match(list.body.reply, /No passkeys yet/);

    // A passkey in the suite's store.
    await memorySecurityStore().addPasskey({ credential_id: 'x'.repeat(43), public_key: 'AA', algorithm: -7, rp_id: 'localhost', name: 'Pixel', device: 'Android phone' });
    const refused = await chat({ prompt: 'AUTH_VERIFY', user: ENV.USER_API_KEY, pass: ENV.USER_API_PASS }, { ip: '192.0.2.11' });
    assert.equal(refused.statusCode, 401);
    assert.equal(refused.body.passkeyRequired, true);
    const command = await chat({ prompt: '/keys', user: ENV.USER_API_KEY, pass: ENV.USER_API_PASS }, { ip: '192.0.2.12' });
    assert.equal(command.statusCode, 401);
    // The cookie from before still is the operator.
    const still = await chat({ prompt: '/security passkeys' }, { cookie });
    assert.equal(still.statusCode, 200);
    assert.match(still.body.reply, /1 passkey/);
    assert.match(still.body.reply, /The password alone does not sign in/);
  } finally {
    for (const k of ['USER_API_KEY', 'USER_API_PASS', 'PG1_PASSWORD_RECOVERY']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    __clearAuthRateLimitState();
  }
});

test('the recovery switch: PG1_PASSWORD_RECOVERY=on lets the password in again (a "recovery" session); default and anything but "on" is off', async () => {
  assert.equal(recoveryOn({}), false);
  for (const v of ['off', '1', 'true', 'yes', 'ON ', ' on']) assert.equal(recoveryOn({ PG1_PASSWORD_RECOVERY: v }), v.trim().toLowerCase() === 'on', v);
  const cookie = await passwordSession();
  const phone = createSoftAuthenticator({ origin: ORIGIN });
  assert.equal((await register(phone, cookie)).statusCode, 200);
  // Gift lost every passkey: sets the switch in Vercel.
  const env = { ...ENV, PG1_PASSWORD_RECOVERY: 'on' };
  const res = await call({ op: 'password', user: ENV.USER_API_KEY, pass: ENV.USER_API_PASS }, { ip: '198.51.100.9' }, env);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.via, 'recovery');
  const status = await call({ op: 'status' }, { cookie: cookieOf(res) }, env);
  assert.deepEqual({ signedIn: status.body.signedIn, passkeyRequired: status.body.passkeyRequired, recovery: status.body.recovery }, { signedIn: true, passkeyRequired: false, recovery: true });
  assert.equal((await db.query("select count(*)::int as n from pg1_operator_sessions where method = 'recovery'")).rows[0].n, 1);
  // Still only the right password: a wrong one is refused with the switch on.
  assert.equal((await call({ op: 'password', user: ENV.USER_API_KEY, pass: 'guess' }, { ip: '198.51.100.10' }, env)).statusCode, 401);
  // The /security reply says the switch is on.
  const r = await handleSecurityCommand({ text: '/security passkeys', env, store, now });
  assert.match(r.reply, /Password recovery is ON/);
  // Switch off again: refused.
  assert.equal((await call({ op: 'password', user: ENV.USER_API_KEY, pass: ENV.USER_API_PASS }, { ip: '198.51.100.11' })).statusCode, 401);
});

test('sessions: expire after 12 h, a forged or edited token is refused, signout ends this one', async () => {
  const cookie = await passwordSession();
  const req = () => makeReq({}, { cookie });
  assert.equal((await authenticateOperator(req(), null, deps())).isOperator, true);
  clock += 12 * 60 * 60 * 1000 - 1000;
  assert.equal((await authenticateOperator(req(), null, deps())).isOperator, true, 'still live just before 12 h');
  clock += 2000;
  assert.equal((await authenticateOperator(req(), null, deps())).isOperator, false, 'ended at 12 h');

  clock = Date.parse('2026-11-05T10:00:00Z');
  const c2 = await passwordSession();
  const token = c2.split('=')[1];
  const parts = token.split('.');
  // A later expiry with the old MAC.
  const edited = [parts[0], parts[1], String(Number(parts[2]) + 3600), parts[3]].join('.');
  assert.equal(checkSessionToken(edited, { env: ENV, nowMs: clock }), null);
  assert.equal((await authenticateOperator(makeReq({}, { cookie: `${SESSION_COOKIE}=${edited}` }), null, deps())).isOperator, false);
  // A token signed with another key (another deployment, or the password changed).
  assert.equal((await authenticateOperator(makeReq({}, { cookie: c2 }), null, { ...deps(), env: { ...ENV, USER_API_PASS: 'rotated' } })).isOperator, false);
  // Signing out ends it on the server, not just in the browser.
  const out = await call({ op: 'signout' }, { cookie: c2 });
  assert.equal(out.statusCode, 200);
  assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await authenticateOperator(makeReq({}, { cookie: c2 }), null, deps())).isOperator, false);
});

test('/security signout-all ends every other session (on every instance: it is in the database) and keeps this one', async () => {
  const phone = await passwordSession({ ip: '203.0.113.1' });
  const laptop = await passwordSession({ ip: '203.0.113.2', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
  const tablet = await passwordSession({ ip: '203.0.113.3' });
  const res = await call({ op: 'signout-all' }, { cookie: phone });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ended, 2);
  // A second instance: a new store over the same database.
  const other = createSupabaseSecurityStore({ supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: pgRest(db) });
  const on = async (cookie) => (await authenticateOperator(makeReq({}, { cookie }), null, { ...deps(), store: other })).isOperator;
  assert.equal(await on(phone), true);
  assert.equal(await on(laptop), false);
  assert.equal(await on(tablet), false);

  // The chat command does the same.
  const more = await passwordSession({ ip: '203.0.113.4' });
  const who = await authenticateOperator(makeReq({}, { cookie: phone }), null, deps());
  const r = await handleSecurityCommand({ text: '/security signout-all', session: who.session, env: ENV, store, now });
  assert.match(r.reply, /Signed out 1 other session\. This one stays signed in\./);
  assert.equal(await on(more), false);
  assert.equal(await on(phone), true);
});

test('/security passkey remove: removes one, ends the sessions it started; the last one removed turns the password back on', async () => {
  const cookie = await passwordSession();
  const phone = createSoftAuthenticator({ origin: ORIGIN });
  const backup = createSoftAuthenticator({ origin: ORIGIN });
  assert.equal((await register(phone, cookie, 'Pixel')).statusCode, 200);
  assert.equal((await register(backup, cookie, 'Backup')).statusCode, 200);
  const phoneSession = cookieOf((await passkeySignIn(phone)).res);
  const backupSession = cookieOf((await passkeySignIn(backup)).res);

  const list = await handleSecurityCommand({ text: '/security passkeys', env: ENV, store, now });
  assert.match(list.reply, /^2 passkeys\./);
  const id = (await db.query("select id from pg1_operator_passkeys where name = 'Pixel'")).rows[0].id;
  assert.ok(list.reply.includes(`/security passkey remove ${String(id).slice(0, 8)}`));

  const r = await handleSecurityCommand({ text: `/security passkey remove ${String(id).slice(0, 8)}`, env: ENV, store, now });
  assert.match(r.reply, /Removed \*\*Pixel\*\*\. Ended 1 session it started\./);
  assert.equal((await authenticateOperator(makeReq({}, { cookie: phoneSession }), null, deps())).isOperator, false);
  assert.equal((await authenticateOperator(makeReq({}, { cookie: backupSession }), null, deps())).isOperator, true);
  assert.equal((await passkeySignIn(phone)).res.statusCode, 401, 'a removed passkey no longer signs in');

  const last = await call({ op: 'remove', id: 'Backup' }, { cookie: backupSession });
  assert.equal(last.statusCode, 200);
  assert.equal(last.body.remaining, 0);
  assert.equal((await call({ op: 'password', user: ENV.USER_API_KEY, pass: ENV.USER_API_PASS }, { ip: '198.51.100.20' })).statusCode, 200);
  assert.match((await handleSecurityCommand({ text: '/security passkey remove nothing-like-it', env: ENV, store, now })).reply, /No passkey matches/);
});

test('/security passkey add sent to the server (a relay, a script) is pointed at the page; the registry has the commands', async () => {
  const r = await handleSecurityCommand({ text: '/security passkey add', env: ENV, store, now });
  assert.match(r.reply, /from the PG1 page/);
  const { findCommand } = await import('../lib/commands/registry.mjs');
  assert.equal(findCommand('/security passkey add').command, '/security passkey');
  assert.equal(findCommand('/security passkeys').command, '/security passkeys');
  assert.equal(findCommand('/security signout-all').command, '/security signout-all');
  assert.equal(findCommand('/security signout-all').dangerous, true);
});

test('a database that does not answer grants nothing: no session, and the password counts as disabled unless the recovery switch is on', async () => {
  const cookie = await passwordSession();
  const down = createSupabaseSecurityStore({ supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const d = { ...deps(), store: down };
  assert.equal((await authenticateOperator(makeReq({}, { cookie }), null, d)).isOperator, false);
  const pw = await authenticateOperator(makeReq({}, { ip: '198.51.100.30' }), { user: ENV.USER_API_KEY, pass: ENV.USER_API_PASS }, d);
  assert.equal(pw.isOperator, false);
  assert.equal(pw.passwordDisabled, true);
  const rec = await authenticateOperator(makeReq({}, { ip: '198.51.100.31' }), { user: ENV.USER_API_KEY, pass: ENV.USER_API_PASS }, { ...d, env: { ...ENV, PG1_PASSWORD_RECOVERY: 'on' } });
  assert.equal(rec.isOperator, true);
  assert.equal(rec.via, 'recovery');
});
