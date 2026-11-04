// WebAuthn (passkeys) for the operator's sign-in: the options a browser's
// navigator.credentials.create() / .get() takes, and the server-side checks
// of what comes back. No library: Node's crypto verifies the signatures and
// lib/security/cbor.mjs reads the attestation object.
//
// What is checked, every time:
//   - clientDataJSON: the ceremony type, the one-time challenge PG1 issued
//     (lib/security/auth.mjs keeps it server side, single use) and the
//     page's origin, never a cross-origin frame.
//   - authenticator data: the hash of this site's RP ID, user presence AND
//     user verification (the phone's fingerprint, face or screen lock).
//   - sign-in: the signature over authData || SHA-256(clientDataJSON) with
//     the stored public key, and a signature counter that only moves
//     forward when the authenticator keeps one (synced passkeys report 0).
// Attestation is not used ('none'): which brand of authenticator made the
// key does not matter here, only that the same key signs later.
//
// Only public material is ever kept: the credential ID, the public key
// (SPKI, DER, base64url), its COSE algorithm and the counter.

import crypto from 'node:crypto';
import { decode, decodeFirst } from './cbor.mjs';

export const COSE_ES256 = -7;
export const COSE_EDDSA = -8;
export const COSE_RS256 = -257;
export const SUPPORTED_ALGORITHMS = Object.freeze([COSE_ES256, COSE_EDDSA, COSE_RS256]);
export const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;
export const RP_NAME = 'PG1';
// One operator, one user handle: every passkey belongs to it.
export const OPERATOR_USER_HANDLE = Buffer.from('pg1-operator', 'utf8');

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export class WebAuthnError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

export function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new WebAuthnError('bad_encoding');
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function randomChallenge() {
  return b64url(crypto.randomBytes(32));
}

function headerOf(req, name) {
  const h = req && req.headers;
  if (!h) return '';
  const v = typeof h.get === 'function' ? h.get(name) : h[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] || '') : '';
}

// The relying party for this request: its RP ID (the host, no port) and the
// exact origin the browser must report. The host is the one the request
// came in on (Vercel sets x-forwarded-host); an IP address is not a valid
// RP ID, so it is refused. Plain http only for localhost (local runs and
// the browser tests).
export function relyingParty(req) {
  const host = (headerOf(req, 'x-forwarded-host') || headerOf(req, 'host')).split(',')[0].trim().toLowerCase();
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(host);
  if (!m) throw new WebAuthnError('bad_host');
  const id = m[1];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(id) || !/[a-z]/.test(id)) throw new WebAuthnError('bad_host');
  const local = id === 'localhost' || id.endsWith('.localhost');
  const forwardedProto = headerOf(req, 'x-forwarded-proto').split(',')[0].trim().toLowerCase();
  const proto = local ? (forwardedProto === 'https' ? 'https' : 'http') : 'https';
  return { id, name: RP_NAME, origin: `${proto}://${host}` };
}

export function registrationOptions({ rp, challenge, excludeCredentialIds = [] }) {
  return {
    rp: { id: rp.id, name: rp.name },
    user: { id: b64url(OPERATOR_USER_HANDLE), name: 'operator', displayName: 'PG1 operator' },
    challenge,
    pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
    timeout: CEREMONY_TIMEOUT_MS,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: excludeCredentialIds.map((id) => ({ type: 'public-key', id }))
  };
}

// Discoverable sign-in: no credential IDs are handed to an anonymous
// caller; the phone offers the PG1 passkeys it holds.
export function authenticationOptions({ rp, challenge }) {
  return { challenge, rpId: rp.id, timeout: CEREMONY_TIMEOUT_MS, userVerification: 'required', allowCredentials: [] };
}

function checkClientData(clientDataB64, { type, challenge, origin }) {
  let raw;
  let data;
  try {
    raw = fromB64url(clientDataB64);
    data = JSON.parse(raw.toString('utf8'));
  } catch (e) { throw new WebAuthnError('bad_client_data'); }
  if (!data || data.type !== type) throw new WebAuthnError('wrong_type');
  if (typeof data.challenge !== 'string' || !challenge || !safeEqualStr(data.challenge, challenge)) throw new WebAuthnError('wrong_challenge');
  if (data.origin !== origin) throw new WebAuthnError('wrong_origin');
  if (data.crossOrigin === true) throw new WebAuthnError('cross_origin');
  return raw;
}

function safeEqualStr(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

function parseAuthData(buf) {
  if (buf.length < 37) throw new WebAuthnError('bad_auth_data');
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33) };
  if (out.flags & FLAG_AT) {
    if (buf.length < 55) throw new WebAuthnError('bad_auth_data');
    const idLen = buf.readUInt16BE(53);
    if (idLen < 16 || idLen > 1023 || buf.length < 55 + idLen) throw new WebAuthnError('bad_auth_data');
    out.aaguid = buf.subarray(37, 53);
    out.credentialId = buf.subarray(55, 55 + idLen);
    let first;
    try { first = decodeFirst(buf.subarray(55 + idLen)); } catch (e) { throw new WebAuthnError('bad_public_key'); }
    out.coseKey = first.value;
  }
  return out;
}

function checkAuthData(auth, rp) {
  const expected = crypto.createHash('sha256').update(rp.id).digest();
  if (!crypto.timingSafeEqual(auth.rpIdHash, expected)) throw new WebAuthnError('wrong_rp');
  if (!(auth.flags & FLAG_UP)) throw new WebAuthnError('no_user_presence');
  if (!(auth.flags & FLAG_UV)) throw new WebAuthnError('no_user_verification');
}

// A COSE_Key (RFC 9053) as a Node public key, or a WebAuthnError.
export function coseToKeyObject(cose) {
  if (!(cose instanceof Map)) throw new WebAuthnError('bad_public_key');
  const kty = cose.get(1);
  const alg = cose.get(3);
  let jwk;
  if (alg === COSE_ES256 && kty === 2 && cose.get(-1) === 1) {
    const x = cose.get(-2); const y = cose.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new WebAuthnError('bad_public_key');
    jwk = { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) };
  } else if (alg === COSE_EDDSA && kty === 1 && cose.get(-1) === 6) {
    const x = cose.get(-2);
    if (!Buffer.isBuffer(x) || x.length !== 32) throw new WebAuthnError('bad_public_key');
    jwk = { kty: 'OKP', crv: 'Ed25519', x: b64url(x) };
  } else if (alg === COSE_RS256 && kty === 3) {
    const n = cose.get(-1); const e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) throw new WebAuthnError('bad_public_key');
    jwk = { kty: 'RSA', n: b64url(n), e: b64url(e) };
  } else {
    throw new WebAuthnError('unsupported_algorithm');
  }
  try {
    return { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), alg };
  } catch (e) { throw new WebAuthnError('bad_public_key'); }
}

// response: the PublicKeyCredential as the page sends it (base64url
// fields). Resolves to the public record to store.
export function verifyRegistration({ credential, expectedChallenge, rp }) {
  const r = credential && credential.response;
  if (!credential || credential.type !== 'public-key' || !r) throw new WebAuthnError('bad_credential');
  checkClientData(r.clientDataJSON, { type: 'webauthn.create', challenge: expectedChallenge, origin: rp.origin });
  let att;
  try { att = decode(fromB64url(r.attestationObject)); } catch (e) { throw new WebAuthnError('bad_attestation'); }
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new WebAuthnError('bad_attestation');
  const auth = parseAuthData(att.get('authData'));
  checkAuthData(auth, rp);
  if (!auth.credentialId || !auth.coseKey) throw new WebAuthnError('no_credential_data');
  const credentialId = b64url(auth.credentialId);
  if (typeof credential.rawId === 'string' && credential.rawId !== credentialId) throw new WebAuthnError('id_mismatch');
  const { key, alg } = coseToKeyObject(auth.coseKey);
  const transports = Array.isArray(r.transports) ? r.transports.filter((t) => typeof t === 'string' && /^[a-z-]{2,16}$/.test(t)).slice(0, 6) : [];
  return {
    credentialId,
    publicKey: b64url(key.export({ type: 'spki', format: 'der' })),
    algorithm: alg,
    signCount: auth.signCount,
    transports,
    backedUp: !!(auth.flags & FLAG_BS),
    backupEligible: !!(auth.flags & FLAG_BE)
  };
}

// stored: the row verifyRegistration produced. Resolves to the new counter.
export function verifyAuthentication({ credential, expectedChallenge, rp, stored }) {
  const r = credential && credential.response;
  if (!credential || credential.type !== 'public-key' || !r || !stored) throw new WebAuthnError('bad_credential');
  if (stored.rp_id && stored.rp_id !== rp.id) throw new WebAuthnError('wrong_rp');
  const clientRaw = checkClientData(r.clientDataJSON, { type: 'webauthn.get', challenge: expectedChallenge, origin: rp.origin });
  const authRaw = fromB64url(r.authenticatorData || '');
  const auth = parseAuthData(authRaw);
  checkAuthData(auth, rp);
  if (r.userHandle) {
    const handle = fromB64url(r.userHandle);
    if (!handle.equals(OPERATOR_USER_HANDLE)) throw new WebAuthnError('wrong_user');
  }
  let key;
  try { key = crypto.createPublicKey({ key: fromB64url(stored.public_key), format: 'der', type: 'spki' }); } catch (e) { throw new WebAuthnError('bad_stored_key'); }
  const signed = Buffer.concat([authRaw, crypto.createHash('sha256').update(clientRaw).digest()]);
  const sig = fromB64url(r.signature || '');
  const alg = Number(stored.algorithm);
  let ok = false;
  try {
    if (alg === COSE_ES256) ok = crypto.verify('sha256', signed, { key, dsaEncoding: 'der' }, sig);
    else if (alg === COSE_RS256) ok = crypto.verify('sha256', signed, key, sig);
    else if (alg === COSE_EDDSA) ok = crypto.verify(null, signed, key, sig);
  } catch (e) { ok = false; }
  if (!ok) throw new WebAuthnError('bad_signature');
  const before = Number(stored.sign_count) || 0;
  if ((auth.signCount !== 0 || before !== 0) && auth.signCount <= before) throw new WebAuthnError('counter_replayed');
  return { signCount: auth.signCount, backedUp: !!(auth.flags & FLAG_BS) };
}
