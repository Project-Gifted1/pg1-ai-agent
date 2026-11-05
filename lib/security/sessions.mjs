// Operator sessions: a signed token in an httpOnly, Secure, SameSite=Strict
// cookie, 12 hours at most, and revocable.
//
// The token is v1.<id>.<expiry>.<mac>: 32 random bytes, the expiry in
// seconds, and an HMAC-SHA256 over both. The MAC lets a forged or edited
// token be refused without a database read; the database row (keyed by
// SHA-256 of the id, so a database read never yields a usable token) is
// what makes it revocable: a revoked or expired row ends the session on
// every instance at once.
//
// The MAC key is derived from the operator's credentials and the service
// role key, never from the password alone (a leaked token must not let
// anyone test password guesses offline). Changing USER_API_PASS ends every
// session. Without a service role key (a local run) the key is random per
// process.

import crypto from 'node:crypto';
import { b64url } from './webauthn.mjs';

export const SESSION_COOKIE = '__Host-pg1_session';
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
export const SESSION_METHODS = Object.freeze(['password', 'passkey', 'recovery']);

const processKey = crypto.randomBytes(32);

export function sessionKey(env = process.env) {
  const service = String(env.SUPABASEAPI_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLEKEY || '').replace(/\s+/g, '');
  const user = String(env.USER_API_KEY || env.USER_API_USER || '').trim();
  const pass = String(env.USER_API_PASS || env.USER_API_PASSS || '').trim();
  const root = service ? Buffer.from(service, 'utf8') : processKey;
  return crypto.createHmac('sha256', root).update(`pg1-operator-session-v1|${user}|${pass}`).digest();
}

export function hashSessionId(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex');
}

function mac(key, body) {
  return b64url(crypto.createHmac('sha256', key).update(body).digest());
}

// Parses and checks a token's MAC and expiry: { idHash, expMs } or null.
export function checkSessionToken(token, { env = process.env, nowMs = Date.now() } = {}) {
  const m = /^v1\.([A-Za-z0-9_-]{43})\.(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m) return null;
  const expected = Buffer.from(mac(sessionKey(env), `v1.${m[1]}.${m[2]}`));
  const given = Buffer.from(m[3]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const expMs = Number(m[2]) * 1000;
  if (!(expMs > nowMs) || expMs - nowMs > SESSION_MAX_MS + 60000) return null;
  return { idHash: hashSessionId(m[1]), expMs };
}

// A new session, stored: { token, idHash, expiresAt }.
export async function mintSession({ store, env = process.env, nowMs = Date.now(), method, device = null, passkeyId = null }) {
  if (!SESSION_METHODS.includes(method)) throw new Error('unknown session method');
  const id = b64url(crypto.randomBytes(32));
  const exp = Math.floor((nowMs + SESSION_MAX_MS) / 1000);
  const body = `v1.${id}.${exp}`;
  const token = `${body}.${mac(sessionKey(env), body)}`;
  const idHash = hashSessionId(id);
  const expiresAt = new Date(exp * 1000).toISOString();
  await store.createSession({ id_hash: idHash, created_at: new Date(nowMs).toISOString(), expires_at: expiresAt, method, device: device ? String(device).slice(0, 40) : null, passkey_id: passkeyId || null });
  return { token, idHash, expiresAt };
}

// The live session a token names, or null (bad MAC, expired, revoked or
// unknown). Throws only when the store does.
export async function verifySession(token, { store, env = process.env, nowMs = Date.now() }) {
  const t = checkSessionToken(token, { env, nowMs });
  if (!t) return null;
  const row = await store.getSession(t.idHash);
  if (!row || row.revoked_at) return null;
  if (!(Date.parse(row.expires_at) > nowMs)) return null;
  return { ...row, idHash: t.idHash };
}

function headerOf(req, name) {
  const h = req && req.headers;
  if (!h) return '';
  const v = typeof h.get === 'function' ? h.get(name) : h[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join('; ') : '';
}

export function readSessionCookie(req) {
  const raw = headerOf(req, 'cookie');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}

export function sessionCookie(token, expiresAtIso, nowMs = Date.now()) {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAtIso) - nowMs) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
