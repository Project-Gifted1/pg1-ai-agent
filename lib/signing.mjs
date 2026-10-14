// Signed results: every PG1 tool result carries an Ed25519 signature an
// agent can check offline against PG1's public key.
//
// What is signed: the canonical JSON (keys sorted, no spaces) of
//   { request_hash, result, sources, timestamp, version }
// - request_hash  sha256 of the canonical { tool, arguments } the caller sent
// - result        the tool's result object, without its own `signature`
// - sources       the result's checks[].source list (what was consulted)
// - timestamp     when PG1 signed it (ISO 8601, UTC)
// - version       PG1's public version (server.json)
// The signature block is
//   { alg: "EdDSA", kid, request_hash, sources, timestamp, version, sig }
// with sig the base64url Ed25519 signature. MCP puts it in
// result._meta["pg1/signature"] (and in structuredContent.signature), A2A in
// the task's metadata["pg1.signature"], REST at the top level as signature.
//
// Keys. PG1_SIGNING_KEY is the private key: a base64 or base64url 32-byte
// Ed25519 seed, or a PKCS#8 PEM. PG1_SIGNING_KEY_ID names it (default: the
// first 16 hex characters of the public key's SHA-256). For rotation, keep
// the old public keys in PG1_SIGNING_PREVIOUS_JWKS (a JSON array of public
// JWKs): they stay published at /.well-known/pg1-signing-key so older
// signatures still verify. Without PG1_SIGNING_KEY nothing is signed and
// the JWKS is empty (the deployment says so in its startup log).

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SIGNATURE_ALG = 'EdDSA';
export const MCP_SIGNATURE_META = 'pg1/signature';
export const A2A_SIGNATURE_META = 'pg1.signature';

let versionCache = null;
export function pg1Version() {
  if (!versionCache) {
    try { versionCache = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8')).version; } catch (e) { versionCache = '0.0.0'; }
  }
  return versionCache;
}

// Canonical JSON: sorted keys, no whitespace, undefined dropped.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function requestHash(tool, args) {
  return sha256Hex(canonicalJson({ tool: String(tool || ''), arguments: args && typeof args === 'object' ? args : {} }));
}

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Trims whitespace and a stray pair of surrounding quotes (a common paste
// slip in dashboard env editors).
function cleanKeyValue(raw) {
  return String(raw || '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
}

class SigningKeyError extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

function privateKeyFrom(raw) {
  const v = cleanKeyValue(raw);
  if (!v) return null;
  if (/BEGIN PRIVATE KEY/.test(v)) {
    try { return crypto.createPrivateKey(v.replace(/\\n/g, '\n')); } catch (e) { throw new SigningKeyError('invalid_pem', 'PG1_SIGNING_KEY looks like a PEM but does not parse as a PKCS#8 private key'); }
  }
  // Inner whitespace (a wrapped paste) is dropped; anything else outside
  // the base64/base64url alphabet is an error rather than silently ignored.
  const compact = v.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_=-]+$/.test(compact)) throw new SigningKeyError('invalid_characters', 'PG1_SIGNING_KEY has characters outside the base64/base64url alphabet');
  const seed = fromB64u(compact);
  if (seed.length !== 32) throw new SigningKeyError('wrong_length', `PG1_SIGNING_KEY decodes to ${seed.length} bytes; an Ed25519 seed is 32 bytes`);
  // PKCS#8 wrapper for a raw Ed25519 seed.
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

let keyCache = { raw: null, keys: null };
export function signingKeys(env = process.env) {
  const raw = `${env.PG1_SIGNING_KEY || ''}|${env.PG1_SIGNING_KEY_ID || ''}|${env.PG1_SIGNING_PREVIOUS_JWKS || ''}`;
  if (keyCache.raw === raw) return keyCache.keys;
  let current = null;
  let status = { enabled: false, reason: 'not_set', detail: 'PG1_SIGNING_KEY is not set' };
  try {
    const priv = privateKeyFrom(env.PG1_SIGNING_KEY);
    if (priv) {
      const pub = crypto.createPublicKey(priv);
      const jwk = pub.export({ format: 'jwk' });
      const kid = String(env.PG1_SIGNING_KEY_ID || '').trim() || sha256Hex(fromB64u(jwk.x)).slice(0, 16);
      current = { kid, privateKey: priv, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, alg: SIGNATURE_ALG, use: 'sig' } };
      status = { enabled: true, reason: 'ok', detail: `signing with kid ${kid}` };
    }
  } catch (e) {
    current = null;
    status = { enabled: false, reason: e.reason || 'invalid_key', detail: e instanceof SigningKeyError ? e.message : 'PG1_SIGNING_KEY could not be loaded as an Ed25519 key' };
  }
  let previous = [];
  try {
    const list = JSON.parse(env.PG1_SIGNING_PREVIOUS_JWKS || '[]');
    previous = (Array.isArray(list) ? list : []).filter((k) => k && k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string' && k.kid && !k.d).map((k) => ({ kty: 'OKP', crv: 'Ed25519', x: k.x, kid: String(k.kid), alg: SIGNATURE_ALG, use: 'sig' }));
  } catch (e) {
    previous = [];
  }
  keyCache = { raw, keys: { current, previous, status } };
  return keyCache.keys;
}

// The public JWKS served at /.well-known/pg1-signing-key.
export function publicJwks(env = process.env) {
  const { current, previous } = signingKeys(env);
  return { keys: [...(current ? [current.publicJwk] : []), ...previous.filter((k) => !current || k.kid !== current.kid)] };
}

export function sourcesOf(result) {
  const checks = result && Array.isArray(result.checks) ? result.checks : [];
  return [...new Set(checks.map((c) => c && c.source).filter(Boolean).map(String))];
}

function payloadOf({ request_hash, result, sources, timestamp, version }) {
  return canonicalJson({ request_hash, result, sources, timestamp, version });
}

// The signature block for one result, or null when no key is configured.
export function signResult({ tool, args, result, env = process.env, now = new Date() }) {
  const { current } = signingKeys(env);
  if (!current || !result || typeof result !== 'object') return null;
  const { signature: _drop, ...clean } = result;
  const block = { alg: SIGNATURE_ALG, kid: current.kid, request_hash: requestHash(tool, args), sources: sourcesOf(clean), timestamp: now.toISOString(), version: pg1Version() };
  const sig = crypto.sign(null, Buffer.from(payloadOf({ ...block, result: clean })), current.privateKey);
  return { ...block, sig: b64u(sig) };
}

// Checks a result against its signature block and a JWKS. Optional
// `tool`/`args`: also checks that it answers that exact request.
// Resolves to { valid, reason, kid }.
export function verifySignedResult({ result, signature, jwks, tool = null, args = null }) {
  if (!signature || typeof signature !== 'object') return { valid: false, reason: 'missing_signature' };
  if (signature.alg !== SIGNATURE_ALG) return { valid: false, reason: 'unsupported_alg' };
  const key = (jwks && Array.isArray(jwks.keys) ? jwks.keys : []).find((k) => k && k.kid === signature.kid && k.kty === 'OKP' && k.crv === 'Ed25519');
  if (!key) return { valid: false, reason: 'unknown_key', kid: signature.kid };
  if (tool != null && requestHash(tool, args || {}) !== signature.request_hash) return { valid: false, reason: 'request_mismatch', kid: key.kid };
  if (!result || typeof result !== 'object') return { valid: false, reason: 'missing_result', kid: key.kid };
  const { signature: _drop, ...clean } = result;
  const expectedSources = sourcesOf(clean);
  if (canonicalJson(expectedSources) !== canonicalJson(signature.sources || [])) return { valid: false, reason: 'sources_mismatch', kid: key.kid };
  let ok = false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
    ok = crypto.verify(null, Buffer.from(payloadOf({ ...signature, result: clean })), pub, fromB64u(signature.sig || ''));
  } catch (e) {
    ok = false;
  }
  return ok ? { valid: true, reason: 'ok', kid: key.kid } : { valid: false, reason: 'bad_signature', kid: key.kid };
}

// A new key pair, for the operator: run scripts/signing-key.mjs.
export function generateSigningKey() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return { PG1_SIGNING_KEY: b64u(der.subarray(der.length - 32)) };
}

// Whether signing is on, and why not when it is off. Never includes key
// material: the kid is public (it is in the JWKS).
export function signingStatus(env = process.env) {
  const { status, previous } = signingKeys(env);
  return { ...status, previous_keys: previous.length };
}

export function signingStartupLine(env = process.env) {
  const s = signingStatus(env);
  return s.enabled
    ? `[signing] on: ${s.detail}; ${s.previous_keys} previous key(s) published.`
    : `[signing] off (${s.reason}): ${s.detail}. Results are not signed and /.well-known/pg1-signing-key lists only previous keys (${s.previous_keys}).`;
}

// One line per cold start on Vercel (production and preview), so the
// deployment log says whether signing is on and why.
if (process.env.VERCEL_ENV) console.log(signingStartupLine());
