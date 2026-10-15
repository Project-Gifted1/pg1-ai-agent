// Signature checks for the events PG1 takes in (api/hooks/*). Every check
// runs over the raw request bytes, compares in constant time and fails
// closed: no secret configured, no signature, a malformed one or a wrong
// one is a rejection. Callers log the reason only (logRejection), never the
// payload or a header value.
//
//   GitHub    X-Hub-Signature-256: sha256=<hex HMAC-SHA256(body)>, secret
//             GITHUB_WEBHOOK_SECRET
//   Vercel    x-vercel-signature: <hex HMAC-SHA1(body)>, secret
//             VERCEL_WEBHOOK_SECRET
//   lab       X-PG1-Timestamp: <unix seconds> and X-PG1-Signature:
//             sha256=<hex HMAC-SHA256("<timestamp>.<body>")>, secret
//             PG1_LAB_DISPATCH_SECRET (the lab's own secret, already in the
//             GitHub "lab" environment); older than LAB_CALLBACK_MAX_AGE_S
//             (or that far in the future) is refused, so a captured notice
//             cannot be replayed later

import crypto from 'node:crypto';

export const LAB_CALLBACK_MAX_AGE_S = 600;
export const MAX_HOOK_BODY_BYTES = 1024 * 1024;

function header(req, name) {
  const h = req && req.headers;
  if (!h) return '';
  const v = typeof h.get === 'function' ? h.get(name) : h[name] ?? h[name.toLowerCase()];
  return typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] || '') : '';
}
export { header as hookHeader };

function hmacHex(algo, secret, body) {
  return crypto.createHmac(algo, secret).update(body).digest('hex');
}

// Both sides decoded from hex to bytes, then compared in constant time.
function sameHex(given, expected) {
  const a = Buffer.from(String(given || ''), 'hex');
  const b = Buffer.from(expected, 'hex');
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A secret pasted into the dashboard often carries a trailing newline or
// spaces; the sender's copy never does.
const secretOf = (env, name) => String((env && env[name]) || '').trim();

const tooLarge = () => Object.assign(new Error('body too large'), { tooLarge: true });

// The request body exactly as sent, or null when it is no longer there.
// The hook routes are Web handlers (asWebHandler in hooks.mjs) and pass the
// bytes of request.arrayBuffer() as req.rawBody. A (req, res) handler on
// Vercel never sees them: the Node helpers read the stream and JSON-parse
// it before the handler runs, and a re-stringified object is not what the
// sender signed. So: req.rawBody first; then an unread stream; then a
// Buffer or string body. A stream that yields nothing although the request
// declared a body was drained by someone else, and an already-parsed
// object cannot be verified: both are null, never an empty or rebuilt body.
export async function readRawBody(req, { maxBytes = MAX_HOOK_BODY_BYTES } = {}) {
  if (req && Buffer.isBuffer(req.rawBody)) {
    if (req.rawBody.length > maxBytes) throw tooLarge();
    return req.rawBody;
  }
  if (req && typeof req[Symbol.asyncIterator] === 'function' && req.readable !== false && !req.readableEnded) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      n += b.length;
      if (n > maxBytes) throw tooLarge();
      chunks.push(b);
    }
    if (n > 0 || !(Number(header(req, 'content-length')) > 0)) return Buffer.concat(chunks);
  }
  const body = req && req.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return null;
}

// Each returns { ok: true } or { ok: false, reason } with a fixed reason
// word: not_configured, unsigned, malformed, no_raw_body (the exact bytes
// were not available, see readRawBody), bad_signature, stale.
export function verifyGithubSignature(req, raw, env = process.env) {
  const secret = secretOf(env, 'GITHUB_WEBHOOK_SECRET');
  if (!secret) return { ok: false, reason: 'not_configured' };
  const sig = header(req, 'x-hub-signature-256');
  if (!sig) return { ok: false, reason: 'unsigned' };
  const m = /^sha256=([0-9a-f]{64})$/i.exec(sig.trim());
  if (!m) return { ok: false, reason: 'malformed' };
  if (!raw) return { ok: false, reason: 'no_raw_body' };
  return sameHex(m[1], hmacHex('sha256', secret, raw)) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

export function verifyVercelSignature(req, raw, env = process.env) {
  const secret = secretOf(env, 'VERCEL_WEBHOOK_SECRET');
  if (!secret) return { ok: false, reason: 'not_configured' };
  const sig = header(req, 'x-vercel-signature');
  if (!sig) return { ok: false, reason: 'unsigned' };
  const m = /^([0-9a-f]{40})$/i.exec(sig.trim());
  if (!m) return { ok: false, reason: 'malformed' };
  if (!raw) return { ok: false, reason: 'no_raw_body' };
  return sameHex(m[1], hmacHex('sha1', secret, raw)) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

export function signLabCallback(body, secret, nowS = Math.floor(Date.now() / 1000)) {
  const ts = String(nowS);
  return { timestamp: ts, signature: `sha256=${hmacHex('sha256', secret, Buffer.concat([Buffer.from(`${ts}.`), Buffer.from(body)]))}` };
}

export function verifyLabCallback(req, raw, env = process.env, nowS = Math.floor(Date.now() / 1000)) {
  const secret = secretOf(env, 'PG1_LAB_DISPATCH_SECRET');
  if (!secret) return { ok: false, reason: 'not_configured' };
  const sig = header(req, 'x-pg1-signature');
  const ts = header(req, 'x-pg1-timestamp');
  if (!sig || !ts) return { ok: false, reason: 'unsigned' };
  const m = /^sha256=([0-9a-f]{64})$/i.exec(sig.trim());
  if (!m || !/^\d{9,11}$/.test(ts.trim())) return { ok: false, reason: 'malformed' };
  if (!raw) return { ok: false, reason: 'no_raw_body' };
  const expected = hmacHex('sha256', secret, Buffer.concat([Buffer.from(`${ts.trim()}.`), raw]));
  if (!sameHex(m[1], expected)) return { ok: false, reason: 'bad_signature' };
  if (Math.abs(nowS - Number(ts)) > LAB_CALLBACK_MAX_AGE_S) return { ok: false, reason: 'stale' };
  return { ok: true };
}

// One line per rejected event: the source and the fixed reason, never the
// payload, a header value or the caller.
export function logRejection(source, reason, log = console.warn) {
  log(`[hooks] rejected source=${String(source).replace(/[^a-z_]/g, '').slice(0, 20)} reason=${String(reason).replace(/[^a-z_]/g, '').slice(0, 30)}`);
}
