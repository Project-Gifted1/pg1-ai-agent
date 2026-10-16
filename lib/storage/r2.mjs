// Cloudflare R2 (bucket pg1-storage by default) through its S3-compatible
// API, for PG1 Studio's large files: clips, masters and previews, the 9:16
// social cut and the audio stems (lib/film/store.mjs R2_KINDS). Small files
// (stills, voice, music, frames, posters, notes) stay in Supabase storage.
//
// Signed with AWS Signature Version 4 on node:crypto, so no SDK is needed.
// Configured by four env vars (all on Vercel and in the render workflow):
//   R2_ACCOUNT_ID         the Cloudflare account id (the endpoint host)
//   R2_ACCESS_KEY_ID      an R2 API token's access key id
//   R2_SECRET_ACCESS_KEY  that token's secret access key
//   R2_BUCKET             optional, default pg1-storage
// Without the first three, R2 is off and every file goes to Supabase.

import crypto from 'node:crypto';

export const R2_DEFAULT_BUCKET = 'pg1-storage';
export const R2_ENV = Object.freeze(['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']);
// S3 presigned links last at most 7 days.
export const R2_MAX_LINK_SECONDS = 7 * 24 * 60 * 60;
const REGION = 'auto';
const SERVICE = 's3';

const clean = (v) => String(v == null ? '' : v).trim();

// { accountId, accessKeyId, secretAccessKey, bucket, host } or null when R2
// is not configured.
export function r2Config(env = {}) {
  const accountId = clean(env.R2_ACCOUNT_ID);
  const accessKeyId = clean(env.R2_ACCESS_KEY_ID);
  const secretAccessKey = clean(env.R2_SECRET_ACCESS_KEY);
  if (!/^[0-9a-f]{32}$/i.test(accountId) || !accessKeyId || !secretAccessKey) return null;
  const bucket = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(clean(env.R2_BUCKET)) ? clean(env.R2_BUCKET) : R2_DEFAULT_BUCKET;
  return { accountId, accessKeyId, secretAccessKey, bucket, host: `${accountId.toLowerCase()}.r2.cloudflarestorage.com` };
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// RFC 3986, as S3 wants it: every byte but A-Z a-z 0-9 - _ . ~ encoded.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const encodeKey = (key) => String(key).split('/').map(enc).join('/');

function amzDate(now) {
  const iso = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amz: iso, day: iso.slice(0, 8) };
}

function signingKey(secret, day, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
}

// The SigV4 signature for one request. `path` is already encoded; `query`
// an object of unencoded values; `headers` lower-case names.
export function sigV4({ method, host, path, query = {}, headers = {}, payloadHash, accessKeyId, secretAccessKey, now = Date.now(), region = REGION, service = SERVICE }) {
  const { amz, day } = amzDate(now);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const allHeaders = { host, ...headers };
  const names = Object.keys(allHeaders).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(allHeaders).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonical = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretAccessKey, day, region, service)).update(toSign).digest('hex');
  return { signature, signedHeaders, scope, amz, canonicalQuery, credential: `${accessKeyId}/${scope}` };
}

// A presigned GET link to `key`, valid `expiresIn` seconds (at most 7 days).
export function r2SignedUrl(cfg, key, { expiresIn = R2_MAX_LINK_SECONDS, now = Date.now(), host = cfg.host, path = `/${cfg.bucket}/${encodeKey(key)}` } = {}) {
  const seconds = Math.max(1, Math.min(R2_MAX_LINK_SECONDS, Math.round(Number(expiresIn) || R2_MAX_LINK_SECONDS)));
  const { amz, day } = amzDate(now);
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${day}/${REGION}/${SERVICE}/aws4_request`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(seconds),
    'X-Amz-SignedHeaders': 'host'
  };
  const s = sigV4({ method: 'GET', host, path, query, payloadHash: 'UNSIGNED-PAYLOAD', accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, now });
  return `https://${host}${path}?${s.canonicalQuery}&X-Amz-Signature=${s.signature}`;
}

function authHeaders(cfg, method, key, { body = null, contentType = null, now = Date.now() } = {}) {
  const path = `/${cfg.bucket}/${encodeKey(key)}`;
  const payloadHash = sha256(body || '');
  const headers = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(now).amz, ...(contentType ? { 'content-type': contentType } : {}) };
  const s = sigV4({ method, host: cfg.host, path, headers, payloadHash, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, now });
  return {
    url: `https://${cfg.host}${path}`,
    headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${s.credential}, SignedHeaders=${s.signedHeaders}, Signature=${s.signature}` }
  };
}

async function withTimeout(fetchImpl, url, options, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

export async function r2Put(cfg, key, bytes, contentType, { fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 300000 } = {}) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const { url, headers } = authHeaders(cfg, 'PUT', key, { body, contentType, now });
  const res = await withTimeout(fetchImpl, url, { method: 'PUT', headers, body }, timeoutMs);
  if (!res.ok) throw new Error(`large-file upload failed: ${res.status}`);
}

export async function r2Get(cfg, key, { fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 300000 } = {}) {
  const { url, headers } = authHeaders(cfg, 'GET', key, { now });
  const res = await withTimeout(fetchImpl, url, { method: 'GET', headers }, timeoutMs);
  if (!res.ok) throw new Error(`large-file read failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
