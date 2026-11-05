// /api/security: the operator's sign-in (lib/security/auth.mjs). POST with
// an op, JSON body:
//
//   anyone
//   { op: 'status' }                       { signedIn, passkeyRequired, recovery }
//   { op: 'password', user, pass }         sign in with USER_API_KEY / USER_API_PASS
//                                          (refused once a passkey exists, unless
//                                          PG1_PASSWORD_RECOVERY=on); sets the cookie
//   { op: 'passkey-options' }              options for navigator.credentials.get()
//   { op: 'passkey', credential, challengeToken }
//                                          sign in with a passkey; sets the cookie
//   { op: 'signout' }                      ends this session, clears the cookie
//
//   the signed-in operator only
//   { op: 'register-options' }             options for navigator.credentials.create()
//   { op: 'register', credential, challengeToken, name? }
//                                          stores the new passkey (public key only)
//   { op: 'list' }                         the passkeys: name, device, dates
//   { op: 'remove', id }                   removes one and ends its sessions
//   { op: 'signout-all' }                  ends every session but this one
//
// The session is a cookie: httpOnly, Secure, SameSite=Strict, Path=/, 12 h
// (lib/security/sessions.mjs). A request whose Origin is another site is
// refused, and the body must be JSON, on top of SameSite. Replies are
// neutral: never why a password failed, never a key or credential ID.

import { authenticateOperator, signInWithPassword, beginPasskeySignIn, finishPasskeySignIn, beginPasskeyRegistration, finishPasskeyRegistration, listPasskeys, removePasskey, signOut, signOutOthers, recoveryOn } from '../lib/security/auth.mjs';
import { securityStore } from '../lib/security/store.mjs';
import { sessionCookie, clearSessionCookie } from '../lib/security/sessions.mjs';
import { relyingParty } from '../lib/security/webauthn.mjs';

export const config = { maxDuration: 15 };

const OPERATOR_OPS = new Set(['register-options', 'register', 'list', 'remove', 'signout-all']);
const PUBLIC_OPS = new Set(['status', 'password', 'passkey-options', 'passkey', 'signout']);

function headerOf(req, name) {
  const h = req && req.headers;
  if (!h) return '';
  const v = typeof h.get === 'function' ? h.get(name) : h[name];
  return typeof v === 'string' ? v : '';
}

function sameOrigin(req) {
  const origin = headerOf(req, 'origin');
  if (!origin) return true;
  try { return relyingParty(req).origin === origin; } catch (e) { return false; }
}

// deps: { store, env, now, push } for tests; the deployment passes none.
export function createSecurityHandler(deps = {}) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    if (!sameOrigin(req)) return res.status(403).json({ error: 'forbidden' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Invalid JSON body' });
    const op = String(body.op || '');
    if (!OPERATOR_OPS.has(op) && !PUBLIC_OPS.has(op)) return res.status(400).json({ error: 'unknown op' });

    const env = deps.env || process.env;
    const store = deps.store || securityStore();
    const now = deps.now || Date.now;
    const opts = { env, store, now, ...(deps.push !== undefined ? { push: deps.push } : {}) };
    const setCookie = (s) => res.setHeader('Set-Cookie', sessionCookie(s.token, s.expiresAt, now()));

    try {
      if (op === 'password') {
        const r = await signInWithPassword(req, { user: typeof body.user === 'string' ? body.user.trim() : '', pass: typeof body.pass === 'string' ? body.pass.trim() : '' }, opts);
        if (r.rateLimited) return res.status(429).json({ ok: false, error: 'Too many failed sign-in attempts. Try again later, or use your passkey.' });
        if (r.unavailable) return res.status(503).json({ ok: false, error: 'Sign-in is not available right now.' });
        if (!r.ok) return res.status(401).json({ ok: false, passkeyRequired: !!r.passwordDisabled, error: r.passwordDisabled ? 'Use your passkey to sign in.' : 'Access denied.' });
        setCookie(r.session);
        return res.status(200).json({ ok: true, authenticated: true, via: r.via, expiresAt: r.session.expiresAt });
      }
      if (op === 'passkey-options') {
        return res.status(200).json({ ok: true, ...beginPasskeySignIn(req, opts) });
      }
      if (op === 'passkey') {
        const r = await finishPasskeySignIn(req, { credential: body.credential, challengeToken: body.challengeToken }, opts);
        if (!r.ok) return res.status(r.reason === 'unavailable' ? 503 : 401).json({ ok: false, error: r.reason === 'unavailable' ? 'Sign-in is not available right now.' : 'That passkey was not accepted.' });
        setCookie(r.session);
        return res.status(200).json({ ok: true, authenticated: true, via: 'passkey', expiresAt: r.session.expiresAt });
      }

      const who = await authenticateOperator(req, { user: body.user, pass: body.pass }, opts);
      if (op === 'status') {
        let passkeys = 0;
        try { passkeys = await store.countPasskeys(); } catch (e) { passkeys = 1; }
        return res.status(200).json({ ok: true, signedIn: who.isOperator, passkeyRequired: passkeys > 0 && !recoveryOn(env), recovery: recoveryOn(env), ...(who.session ? { expiresAt: who.session.expires_at } : {}) });
      }
      if (op === 'signout') {
        if (who.session) await signOut(who.session.idHash, { store, now });
        res.setHeader('Set-Cookie', clearSessionCookie());
        return res.status(200).json({ ok: true });
      }
      if (who.rateLimited) return res.status(429).json({ ok: false, error: 'Too many failed sign-in attempts. Try again later.' });
      if (!who.isOperator) return res.status(401).json({ ok: false, error: 'Sign in first.' });

      if (op === 'register-options') {
        const r = await beginPasskeyRegistration(req, opts);
        if (!r.ok) return res.status(409).json({ ok: false, error: 'You have the most passkeys PG1 keeps (10). Remove one first.' });
        return res.status(200).json({ ok: true, options: r.options, challengeToken: r.challengeToken });
      }
      if (op === 'register') {
        const r = await finishPasskeyRegistration(req, { credential: body.credential, challengeToken: body.challengeToken, name: body.name }, opts);
        if (!r.ok) {
          const words = { already_registered: 'That passkey is already registered.', too_many: 'You have the most passkeys PG1 keeps (10). Remove one first.', unavailable: 'Passkeys are not available right now.' };
          return res.status(r.reason === 'unavailable' ? 503 : 400).json({ ok: false, error: words[r.reason] || 'That passkey could not be registered. Try again.' });
        }
        return res.status(200).json({ ok: true, passkey: r.passkey, first: r.first });
      }
      if (op === 'list') return res.status(200).json({ ok: true, passkeys: await listPasskeys({ store }), recovery: recoveryOn(env) });
      if (op === 'remove') {
        const r = await removePasskey(typeof body.id === 'string' ? body.id : '', { store, now });
        if (!r.ok) return res.status(r.reason === 'not_found' ? 404 : 400).json({ ok: false, error: r.reason === 'ambiguous' ? 'More than one passkey matches. Use its id.' : 'No such passkey.' });
        return res.status(200).json({ ok: true, removed: r.passkey, remaining: r.remaining, endedSessions: r.endedSessions });
      }
      if (op === 'signout-all') {
        const r = await signOutOthers(who.session ? who.session.idHash : null, { store, now });
        return res.status(200).json({ ok: true, ended: r.ended });
      }
    } catch (e) {
      return res.status(503).json({ ok: false, error: 'Sign-in is not available right now.' });
    }
    return res.status(400).json({ error: 'unknown op' });
  };
}

export default createSecurityHandler();
