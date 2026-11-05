// THE OPERATOR'S SIGN-IN: one place that decides whether a request is the
// operator. api/chat.mjs, lib/operatorSession.mjs (watches, threads,
// sandbox, diagnostics), api/errors.mjs, api/handoffs.mjs and
// api/security.mjs all ask authenticateOperator().
//
// A request is the operator when:
//   1. it carries a live session cookie (lib/security/sessions.mjs), or
//   2. it carries USER_API_KEY / USER_API_PASS (timing-safe compares) AND
//      no passkey is registered yet, or the recovery switch is on
//      (PG1_PASSWORD_RECOVERY=on, default off, set in Vercel by the
//      operator who has lost every passkey).
// Once a passkey exists the password alone is refused, and refused the same
// way whether it was right or wrong (no password oracle); the operator
// signs in with the passkey (api/security.mjs), which mints a session.
// Everything else is LEAST_PRIVILEGED_ROLE.
//
// THE DURABLE LOCKOUT (pg1_auth_events, shared by every instance):
//   - per IP (stored as a keyed hash, never the address): AUTH_MAX_FAILURES
//     failed attempts in AUTH_FAILURE_WINDOW_MS and that IP's password
//     attempts get 429 until the window passes;
//   - global: AUTH_GLOBAL_MAX_FAILURES failed attempts in an hour, from
//     anywhere, and every password attempt gets 429 until it passes.
// The lockout gates the password. A live session and a passkey (which no
// one can guess) still work from a locked IP, so an attacker cannot lock
// the operator out by failing on purpose from a shared mobile IP.
// Failures are mirrored into this instance's memory too, so a database
// outage still leaves a per-instance lockout. A database that does not
// answer never grants anything: no session, and the password is treated
// as disabled (a passkey may exist) unless the recovery switch is on.

import crypto from 'node:crypto';
import { safeCompare } from './compare.mjs';
import { securityStore, createMemorySecurityStore, MAX_PASSKEYS } from './store.mjs';
import { mintSession, verifySession, readSessionCookie, sessionKey, SESSION_MAX_MS } from './sessions.mjs';
import { alertSignIn, maybeAlertBurst, deviceType, defaultSecurityPush } from './alerts.mjs';
import { relyingParty, registrationOptions, authenticationOptions, verifyRegistration, verifyAuthentication, b64url, WebAuthnError, CEREMONY_TIMEOUT_MS } from './webauthn.mjs';
import { getRequestIdentifier } from '../freeTier.mjs';

export const LEAST_PRIVILEGED = 'guest';
export const AUTH_MAX_FAILURES = 5;
export const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_GLOBAL_MAX_FAILURES = 30;
export const AUTH_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
export const RECOVERY_ENV = 'PG1_PASSWORD_RECOVERY';

// Per-instance mirror of failures (see above). Tests reset it.
const mirror = createMemorySecurityStore();
export function __resetAuthMirror() { mirror.reset(); }

export function recoveryOn(env = process.env) {
  return String(env[RECOVERY_ENV] || '').trim().toLowerCase() === 'on';
}

const processSalt = crypto.randomBytes(32);
export function ipHash(ip, env = process.env) {
  const salt = String(env.TELEMETRY_IP_SALT || env.SUPABASEAPI_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLEKEY || '').trim();
  return crypto.createHmac('sha256', salt || processSalt).update(`pg1-auth-ip|${String(ip || 'unknown').trim().toLowerCase()}`).digest('hex').slice(0, 32);
}

function expectedCredentials(env) {
  return {
    user: String(env.USER_API_KEY || env.USER_API_USER || '').trim(),
    pass: String(env.USER_API_PASS || env.USER_API_PASSS || '').trim()
  };
}

// Both compares always run (no short circuit), so a right user name with a
// wrong password takes as long as both wrong.
export function passwordMatches({ user, pass }, env = process.env) {
  const exp = expectedCredentials(env);
  const u = safeCompare(user, exp.user);
  const p = safeCompare(pass, exp.pass);
  return !!(exp.user && exp.pass) && u && p;
}

async function countSafe(store, args) {
  try { return await store.countEvents(args); } catch (e) { return null; }
}

// Whether a password attempt from this IP may run: { limited: false |
// 'ip' | 'global' }.
export async function passwordGate({ store, ipKey, nowMs }) {
  const ipArgs = { kind: 'failure', ipHash: ipKey, sinceMs: nowMs - AUTH_FAILURE_WINDOW_MS, limit: AUTH_MAX_FAILURES };
  const globalArgs = { kind: 'failure', sinceMs: nowMs - AUTH_GLOBAL_WINDOW_MS, limit: AUTH_GLOBAL_MAX_FAILURES };
  const [ipN, globalN, ipMirror, globalMirror] = await Promise.all([countSafe(store, ipArgs), countSafe(store, globalArgs), countSafe(mirror, ipArgs), countSafe(mirror, globalArgs)]);
  if (Math.max(ipN || 0, ipMirror || 0) >= AUTH_MAX_FAILURES) return { limited: 'ip' };
  if (Math.max(globalN || 0, globalMirror || 0) >= AUTH_GLOBAL_MAX_FAILURES) return { limited: 'global' };
  return { limited: false };
}

export async function recordFailure({ store, ipKey, method, device, nowMs, push }) {
  const row = { kind: 'failure', ip_hash: ipKey, method, device: String(device || '').slice(0, 40) || null, created_at: new Date(nowMs).toISOString() };
  await mirror.addEvent(row);
  try { await store.addEvent(row); } catch (e) { /* the mirror still counts it */ }
  if (push) await maybeAlertBurst({ store, push, device, nowMs });
}

async function clearFailures({ store, ipKey }) {
  await mirror.clearFailures(ipKey);
  try { await store.clearFailures(ipKey); } catch (e) { /* expires with its window */ }
}

// Passkeys registered; a store that does not answer counts as "some", so
// the password is not silently re-enabled by an outage.
async function passkeyCount(store) {
  try { return await store.countPasskeys(); } catch (e) { return 1; }
}

function guest(extra = {}) {
  return { role: LEAST_PRIVILEGED, isOperator: false, rateLimited: false, via: null, passwordDisabled: false, ...extra };
}

function operator(via, extra = {}) {
  return { role: 'operator', isOperator: true, rateLimited: false, via, passwordDisabled: false, ...extra };
}

function context(req, opts = {}) {
  const env = opts.env || process.env;
  const store = opts.store || securityStore();
  const nowMs = typeof opts.now === 'function' ? opts.now() : Date.now();
  const push = opts.push === undefined ? defaultSecurityPush({ env }) : opts.push;
  const ip = getRequestIdentifier({ headers: (req && req.headers) || {}, socket: req && req.socket });
  return { env, store, nowMs, push, ipKey: ipHash(ip, env), device: deviceType(req) };
}

// The password path. Never compares when locked out; records every
// refusal (including a right password while passkeys are required).
async function passwordAttempt(req, creds, ctx) {
  const { env, store, nowMs, ipKey, device, push } = ctx;
  const [gate, passkeys] = await Promise.all([passwordGate({ store, ipKey, nowMs }), passkeyCount(store)]);
  if (gate.limited) return guest({ rateLimited: true, limit: gate.limited });
  const matches = passwordMatches(creds, env);
  const recovery = recoveryOn(env);
  const passwordDisabled = passkeys > 0 && !recovery;
  if (matches && !passwordDisabled) {
    await clearFailures({ store, ipKey });
    return operator(passkeys > 0 ? 'recovery' : 'password');
  }
  await recordFailure({ store, ipKey, method: 'password', device, nowMs, push });
  return guest({ passwordDisabled, attempted: true });
}

// Every request's role. creds: { user, pass } from the body or a Basic
// header (lib/operatorSession.mjs reads them); a live session cookie wins
// and the credentials are then not looked at.
// Resolves to { role, isOperator, rateLimited, via: 'session' | 'password'
// | 'recovery' | null, passwordDisabled, session? }.
export async function authenticateOperator(req, creds = null, opts = {}) {
  const ctx = context(req, opts);
  const token = readSessionCookie(req);
  if (token) {
    let s = null;
    try { s = await verifySession(token, { store: ctx.store, env: ctx.env, nowMs: ctx.nowMs }); } catch (e) { s = null; }
    if (s) return operator('session', { session: s });
  }
  const user = creds && typeof creds.user === 'string' ? creds.user : '';
  const pass = creds && typeof creds.pass === 'string' ? creds.pass : '';
  if (!user && !pass) return guest();
  return passwordAttempt(req, { user, pass }, ctx);
}

async function startSession(ctx, { method, passkeyId = null }) {
  const s = await mintSession({ store: ctx.store, env: ctx.env, nowMs: ctx.nowMs, method, device: ctx.device, passkeyId });
  await alertSignIn({ push: ctx.push, method, device: ctx.device, nowMs: ctx.nowMs });
  try { await ctx.store.cleanup(ctx.nowMs); } catch (e) { /* housekeeping only */ }
  return s;
}

// A session for a request the password path already let in (api/chat.mjs
// AUTH_VERIFY): via 'password' or 'recovery'. Sends the sign-in alert.
export async function startOperatorSession(req, via, opts = {}) {
  if (via !== 'password' && via !== 'recovery') throw new Error('not a password sign-in');
  return startSession(context(req, opts), { method: via });
}

// Sign-in with the password: a session when the password path lets the
// operator in. { ok, session?, rateLimited?, passwordDisabled? }.
export async function signInWithPassword(req, creds, opts = {}) {
  const ctx = context(req, opts);
  const r = await passwordAttempt(req, creds || {}, ctx);
  if (!r.isOperator) return { ok: false, rateLimited: r.rateLimited, passwordDisabled: r.passwordDisabled };
  try {
    const session = await startSession(ctx, { method: r.via });
    return { ok: true, via: r.via, session };
  } catch (e) {
    return { ok: false, unavailable: true };
  }
}

// ONE-TIME CHALLENGES: a signed token (kind, random challenge, expiry)
// handed to the page; used once (store.useChallenge) when it comes back.
function challengeMac(env, body) {
  return b64url(crypto.createHmac('sha256', sessionKey(env)).update(`pg1-webauthn-challenge|${body}`).digest());
}

export function issueChallenge(kind, { env = process.env, nowMs = Date.now() } = {}) {
  const challenge = b64url(crypto.randomBytes(32));
  const exp = Math.floor((nowMs + CEREMONY_TIMEOUT_MS) / 1000);
  const body = `${kind}.${challenge}.${exp}`;
  return { challenge, token: `${body}.${challengeMac(env, body)}` };
}

async function redeemChallenge(token, kind, ctx) {
  const m = /^(register|signin)\.([A-Za-z0-9_-]{43})\.(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m || m[1] !== kind) return null;
  const expected = Buffer.from(challengeMac(ctx.env, `${m[1]}.${m[2]}.${m[3]}`));
  const given = Buffer.from(m[4]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  if (!(Number(m[3]) * 1000 > ctx.nowMs)) return null;
  const id = crypto.createHash('sha256').update(m[2]).digest('hex');
  const first = await ctx.store.useChallenge({ id, kind, expires_at: new Date(Number(m[3]) * 1000).toISOString() });
  return first ? m[2] : null;
}

// Passkey sign-in, step 1 (anyone): the options for navigator.credentials
// .get() and the challenge token to send back.
export function beginPasskeySignIn(req, opts = {}) {
  const env = opts.env || process.env;
  const nowMs = typeof opts.now === 'function' ? opts.now() : Date.now();
  const rp = relyingParty(req);
  const c = issueChallenge('signin', { env, nowMs });
  return { options: authenticationOptions({ rp, challenge: c.challenge }), challengeToken: c.token };
}

// Passkey sign-in, step 2: verifies the assertion against the stored
// public key; a session on success. A failure is recorded (it counts for
// the burst alert) unless the IP is already locked, which keeps a flood
// from growing the table; the passkey itself is never locked out.
export async function finishPasskeySignIn(req, { credential, challengeToken } = {}, opts = {}) {
  const ctx = context(req, opts);
  const fail = async (reason) => {
    const gate = await passwordGate({ store: ctx.store, ipKey: ctx.ipKey, nowMs: ctx.nowMs });
    if (!gate.limited) await recordFailure({ store: ctx.store, ipKey: ctx.ipKey, method: 'passkey', device: ctx.device, nowMs: ctx.nowMs, push: ctx.push });
    return { ok: false, reason };
  };
  let rp;
  try { rp = relyingParty(req); } catch (e) { return fail('bad_host'); }
  let challenge;
  try { challenge = await redeemChallenge(challengeToken, 'signin', ctx); } catch (e) { return { ok: false, reason: 'unavailable' }; }
  if (!challenge) return fail('challenge');
  const credId = credential && typeof credential.id === 'string' ? credential.id : '';
  let stored;
  try { stored = credId ? await ctx.store.getPasskey(credId) : null; } catch (e) { return { ok: false, reason: 'unavailable' }; }
  if (!stored) return fail('unknown_passkey');
  let result;
  try {
    result = verifyAuthentication({ credential, expectedChallenge: challenge, rp, stored });
  } catch (e) {
    return fail(e instanceof WebAuthnError ? e.code : 'invalid');
  }
  try {
    await ctx.store.updatePasskey(stored.id, { sign_count: result.signCount, backed_up: result.backedUp, last_used_at: new Date(ctx.nowMs).toISOString() });
    await clearFailures({ store: ctx.store, ipKey: ctx.ipKey });
    const session = await startSession(ctx, { method: 'passkey', passkeyId: stored.id });
    return { ok: true, via: 'passkey', session, passkey: { id: stored.id, name: stored.name } };
  } catch (e) {
    return { ok: false, reason: 'unavailable' };
  }
}

// Passkey registration, step 1 (the signed-in operator only; the caller
// checks): options for navigator.credentials.create().
export async function beginPasskeyRegistration(req, opts = {}) {
  const env = opts.env || process.env;
  const store = opts.store || securityStore();
  const nowMs = typeof opts.now === 'function' ? opts.now() : Date.now();
  const rp = relyingParty(req);
  const existing = await store.listPasskeys();
  if (existing.length >= MAX_PASSKEYS) return { ok: false, reason: 'too_many' };
  const c = issueChallenge('register', { env, nowMs });
  return { ok: true, options: registrationOptions({ rp, challenge: c.challenge, excludeCredentialIds: existing.map((p) => p.credential_id) }), challengeToken: c.token };
}

export function cleanPasskeyName(name, device) {
  const n = String(name || '').replace(/[\u0000-\u001f\u007f<>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return n || device || 'Passkey';
}

// Passkey registration, step 2: verifies the attestation, stores the
// public key. The operator's current session stays as it is.
export async function finishPasskeyRegistration(req, { credential, challengeToken, name } = {}, opts = {}) {
  const ctx = context(req, { ...opts, push: null });
  let rp;
  try { rp = relyingParty(req); } catch (e) { return { ok: false, reason: 'bad_host' }; }
  let challenge;
  try { challenge = await redeemChallenge(challengeToken, 'register', ctx); } catch (e) { return { ok: false, reason: 'unavailable' }; }
  if (!challenge) return { ok: false, reason: 'challenge' };
  let rec;
  try { rec = verifyRegistration({ credential, expectedChallenge: challenge, rp }); } catch (e) { return { ok: false, reason: e instanceof WebAuthnError ? e.code : 'invalid' }; }
  try {
    const existing = await ctx.store.listPasskeys();
    if (existing.length >= MAX_PASSKEYS) return { ok: false, reason: 'too_many' };
    if (existing.some((p) => p.credential_id === rec.credentialId)) return { ok: false, reason: 'already_registered' };
    const row = await ctx.store.addPasskey({
      credential_id: rec.credentialId, public_key: rec.publicKey, algorithm: rec.algorithm, sign_count: rec.signCount,
      transports: rec.transports, rp_id: rp.id, name: cleanPasskeyName(name, ctx.device), device: ctx.device, backed_up: rec.backedUp
    });
    return { ok: true, passkey: publicPasskey(row), first: existing.length === 0 };
  } catch (e) {
    return { ok: false, reason: 'unavailable' };
  }
}

// What the operator sees of a passkey: never the key or the credential ID.
export function publicPasskey(p) {
  return p ? { id: p.id, name: p.name, device: p.device || null, createdAt: p.created_at || null, lastUsedAt: p.last_used_at || null, synced: !!p.backed_up } : null;
}

export async function listPasskeys({ store = securityStore() } = {}) {
  return (await store.listPasskeys()).map(publicPasskey);
}

// Removes a passkey by id (or a unique id prefix of 6+ characters, or its
// exact name) and ends the sessions it started.
export async function removePasskey(ref, { store = securityStore(), now = Date.now } = {}) {
  const r = String(ref || '').trim();
  if (!r) return { ok: false, reason: 'no_ref' };
  const all = await store.listPasskeys();
  let hits = all.filter((p) => p.id === r);
  if (!hits.length && r.length >= 6) hits = all.filter((p) => String(p.id).startsWith(r));
  if (!hits.length) hits = all.filter((p) => String(p.name || '').toLowerCase() === r.toLowerCase());
  if (hits.length !== 1) return { ok: false, reason: hits.length ? 'ambiguous' : 'not_found' };
  const p = hits[0];
  // Sessions first: the row's delete sets their passkey_id to null.
  const ended = await store.revokeSessions({ passkeyId: p.id, nowMs: now() });
  await store.removePasskey(p.id);
  return { ok: true, passkey: publicPasskey(p), remaining: all.length - 1, endedSessions: ended };
}

// Ends every session but the caller's. { ended }.
export async function signOutOthers(currentIdHash, { store = securityStore(), now = Date.now } = {}) {
  const ended = await store.revokeSessions({ except: currentIdHash || null, nowMs: now() });
  return { ended };
}

export async function signOut(currentIdHash, { store = securityStore(), now = Date.now } = {}) {
  if (!currentIdHash) return { ended: 0 };
  return { ended: await store.revokeSessions({ idHash: currentIdHash, nowMs: now() }) };
}

export { SESSION_MAX_MS };
