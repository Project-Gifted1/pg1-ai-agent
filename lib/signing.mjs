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

function privateKeyFrom(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (/BEGIN PRIVATE KEY/.test(v)) return crypto.createPrivateKey(v.replace(/\\n/g, '\n'));
  const seed = fromB64u(v);
  if (seed.length !== 32) throw new Error('PG1_SIGNING_KEY must be a 32-byte Ed25519 seed (base64) or a PKCS#8 PEM');
  // PKCS#8 wrapper for a raw Ed25519 seed.
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

let keyCache = { raw: null, keys: null };
export function signingKeys(env = process.env) {
  const raw = `${env.PG1_SIGNING_KEY || ''}|${env.PG1_SIGNING_KEY_ID || ''}|${env.PG1_SIGNING_PREVIOUS_JWKS || ''}`;
  if (keyCache.raw === raw) return keyCache.keys;
  let current = null;
  try {
    const priv = privateKeyFrom(env.PG1_SIGNING_KEY);
    if (priv) {
      const pub = crypto.createPublicKey(priv);
      const jwk = pub.export({ format: 'jwk' });
      const kid = String(env.PG1_SIGNING_KEY_ID || '').trim() || sha256Hex(fromB64u(jwk.x)).slice(0, 16);
      current = { kid, privateKey: priv, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, alg: SIGNATURE_ALG, use: 'sig' } };
    }
  } catch (e) {
    current = null;
  }
  let previous = [];
  try {
    const list = JSON.parse(env.PG1_SIGNING_PREVIOUS_JWKS || '[]');
    previous = (Array.isArray(list) ? list : []).filter((k) => k && k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string' && k.kid && !k.d).map((k) => ({ kty: 'OKP', crv: 'Ed25519', x: k.x, kid: String(k.kid), alg: SIGNATURE_ALG, use: 'sig' }));
  } catch (e) {
    previous = [];
  }
  keyCache = { raw, keys: { current, previous } };
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

if (!String(process.env.PG1_SIGNING_KEY || '').trim() && process.env.VERCEL_ENV === 'production') {
  console.log('[signing] PG1_SIGNING_KEY is not set: results are not signed and /.well-known/pg1-signing-key is empty.');
}
