// PG1 passkeys in the page (window.PG1Passkey): sign in with a passkey, add
// one, and the session's status, against /api/security
// (lib/security/auth.mjs). Built for Android Chrome first: discoverable
// passkeys (the phone offers the PG1 passkey it holds, no user name typed)
// with user verification (fingerprint, face or screen lock).
//
// The session itself is an httpOnly cookie the page never sees. Nothing
// here stores anything: no credential, key or token in localStorage.
(function () {
  'use strict';

  function toB64url(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64url(str) {
    var s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function supported() {
    return !!(window.PublicKeyCredential && navigator.credentials && typeof navigator.credentials.get === 'function' && window.isSecureContext !== false);
  }

  async function api(op, payload) {
    var res = await fetch('/api/security', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ op: op }, payload || {}))
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, ok: res.ok && !!(data && data.ok), data: data || {} };
  }

  function createOptions(o) {
    return Object.assign({}, o, {
      challenge: fromB64url(o.challenge),
      user: Object.assign({}, o.user, { id: fromB64url(o.user.id) }),
      excludeCredentials: (o.excludeCredentials || []).map(function (c) { return { type: c.type, id: fromB64url(c.id) }; })
    });
  }

  function getOptions(o) {
    return Object.assign({}, o, {
      challenge: fromB64url(o.challenge),
      allowCredentials: (o.allowCredentials || []).map(function (c) { return { type: c.type, id: fromB64url(c.id) }; })
    });
  }

  function attestationJSON(cred) {
    var r = cred.response;
    var transports = [];
    try { transports = typeof r.getTransports === 'function' ? r.getTransports() : []; } catch (e) { transports = []; }
    return { id: cred.id, rawId: toB64url(cred.rawId), type: cred.type, response: { clientDataJSON: toB64url(r.clientDataJSON), attestationObject: toB64url(r.attestationObject), transports: transports } };
  }

  function assertionJSON(cred) {
    var r = cred.response;
    return { id: cred.id, rawId: toB64url(cred.rawId), type: cred.type, response: { clientDataJSON: toB64url(r.clientDataJSON), authenticatorData: toB64url(r.authenticatorData), signature: toB64url(r.signature), userHandle: r.userHandle ? toB64url(r.userHandle) : null } };
  }

  // A browser's refusal as one sentence for the operator.
  function promptError(e) {
    var name = e && e.name;
    if (name === 'NotAllowedError') return 'The passkey prompt was closed or timed out.';
    if (name === 'InvalidStateError') return 'This device already has a PG1 passkey.';
    if (name === 'SecurityError') return 'Passkeys need the PG1 site itself (https).';
    if (name === 'NotSupportedError') return 'This browser cannot make a passkey PG1 accepts.';
    return 'The passkey prompt did not finish.';
  }

  // Sign in: { ok, error? }. On ok the session cookie is set.
  async function signIn() {
    if (!supported()) return { ok: false, error: 'This browser has no passkeys. Use Chrome on your phone.' };
    var start = await api('passkey-options');
    if (!start.ok) return { ok: false, error: start.data.error || 'Sign-in is not available right now.' };
    var cred;
    try {
      cred = await navigator.credentials.get({ publicKey: getOptions(start.data.options), mediation: 'optional' });
    } catch (e) { return { ok: false, error: promptError(e) }; }
    if (!cred) return { ok: false, error: 'No passkey was chosen.' };
    var done = await api('passkey', { credential: assertionJSON(cred), challengeToken: start.data.challengeToken });
    if (!done.ok) return { ok: false, status: done.status, error: done.data.error || 'That passkey was not accepted.' };
    return { ok: true, expiresAt: done.data.expiresAt };
  }

  // Add a passkey (signed-in operator): { ok, passkey?, first?, error? }.
  // extra: the password while the page has no session cookie yet.
  async function register(name, extra) {
    if (!supported()) return { ok: false, error: 'This browser has no passkeys. Use Chrome on your phone.' };
    var start = await api('register-options', extra);
    if (!start.ok) return { ok: false, status: start.status, error: start.data.error || 'Could not start adding a passkey.' };
    var cred;
    try {
      cred = await navigator.credentials.create({ publicKey: createOptions(start.data.options) });
    } catch (e) { return { ok: false, error: promptError(e) }; }
    if (!cred) return { ok: false, error: 'No passkey was made.' };
    var done = await api('register', Object.assign({}, extra || {}, { credential: attestationJSON(cred), challengeToken: start.data.challengeToken, name: name || '' }));
    if (!done.ok) return { ok: false, status: done.status, error: done.data.error || 'That passkey could not be added.' };
    return { ok: true, passkey: done.data.passkey, first: !!done.data.first };
  }

  async function status() {
    try { var r = await api('status'); return r.ok ? r.data : null; } catch (e) { return null; }
  }

  async function signOut() {
    try { await api('signout'); } catch (e) { /* the cookie ends on its own */ }
  }

  window.PG1Passkey = { supported: supported, signIn: signIn, register: register, status: status, signOut: signOut, _b64: { toB64url: toB64url, fromB64url: fromB64url } };
})();
