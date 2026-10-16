// Cloudflare R2 (bucket pg1-storage) through its S3-compatible API, for the
// large files: film masters and previews, the 9:16 cut, audio stems and
// clips. Small files (stills, frames, thumbnails, voice lines, music beds,
// PDFs) stay in Supabase Storage (pg1-vault).
//
// Settings (names only; the values live in Vercel and GitHub Actions):
//   R2_ACCOUNT_ID         the Cloudflare account id (the endpoint's host)
//   R2_ACCESS_KEY_ID      an R2 API token's access key id
//   R2_SECRET_ACCESS_KEY  that token's secret access key
//   R2_BUCKET             the bucket, default pg1-storage
// Without the first three, everything stays in Supabase Storage as before.
//
// Requests are signed with AWS Signature Version 4 (region "auto", service
// "s3"), path-style: https://<account>.r2.cloudflarestorage.com/<bucket>/<key>.

import crypto from 'node:crypto';

export const R2_DEFAULT_BUCKET = 'pg1-storage';
export const R2_PREFIX = 'r2:';
const MAX_PRESIGN_S = 7 * 24 * 60 * 60;

export function r2Config(env = {}) {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !accessKeyId || !secretAccessKey) return null;
  const bucket = String(env.R2_BUCKET || '').trim() || R2_DEFAULT_BUCKET;
  return { accountId, accessKeyId, secretAccessKey, bucket, host: `${accountId}.r2.cloudflarestorage.com`, region: 'auto' };
}

export const isR2Path = (p) => String(p || '').startsWith(R2_PREFIX);
export const r2Key = (p) => String(p).slice(R2_PREFIX.length);

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding, as SigV4 wants it; '/' kept between key segments.
export function encodeKey(key) {
  return String(key).split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

function amzDate(now) {
  const iso = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { stamp: iso, day: iso.slice(0, 8) };
}

function signingKey(secret, day, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
}

const canonicalQuery = (params) => Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');

// A presigned URL (query-string authentication). path starts with '/'.
export function presign({ method = 'GET', host, path, region, accessKeyId, secretAccessKey, expiresIn = 3600, now = Date.now(), service = 's3' }) {
  const { stamp, day } = amzDate(now);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(Math.max(1, Math.min(MAX_PRESIGN_S, Math.round(expiresIn)))),
    'X-Amz-SignedHeaders': 'host'
  };
  const query = canonicalQuery(params);
  const canonical = [method, path, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretAccessKey, day, region, service)).update(toSign).digest('hex');
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}

// Headers for a request signed in the Authorization header.
export function signedHeaders({ method, host, path, region, accessKeyId, secretAccessKey, body = null, contentType = null, extra = {}, now = Date.now(), service = 's3' }) {
  const { stamp, day } = amzDate(now);
  const payloadHash = body ? sha256(body) : sha256('');
  const headers = { host, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])), 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp };
  if (contentType) headers['content-type'] = contentType;
  const names = Object.keys(headers).sort();
  const canonical = [method, path, '', names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretAccessKey, day, region, service)).update(toSign).digest('hex');
  const { host: _host, ...rest } = headers;
  void _host;
  return { ...rest, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

async function withTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(id);
  }
}

// { upload(key, bytes, mime) -> 'r2:<key>', download('r2:<key>') -> Buffer,
//   sign('r2:<key>', seconds) -> URL }.
export function createR2({ config, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const c = config;
  const objectPath = (key) => `/${encodeURIComponent(c.bucket)}/${encodeKey(key)}`;
  const base = { host: c.host, region: c.region, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
  return {
    async upload(key, bytes, mimeType) {
      const body = Buffer.from(bytes);
      const p = objectPath(key);
      const headers = signedHeaders({ ...base, method: 'PUT', path: p, body, contentType: mimeType, now: now() });
      const res = await withTimeout(fetchImpl, `https://${c.host}${p}`, { method: 'PUT', headers, body }, 300000);
      if (!res.ok) throw new Error(`large-file storage upload failed: ${res.status}`);
      return `${R2_PREFIX}${key}`;
    },
    async download(stored) {
      const p = objectPath(r2Key(stored));
      const headers = signedHeaders({ ...base, method: 'GET', path: p, now: now() });
      const res = await withTimeout(fetchImpl, `https://${c.host}${p}`, { headers }, 300000);
      if (!res.ok) throw new Error(`large-file storage read failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    sign(stored, expiresIn = 3600) {
      return presign({ ...base, method: 'GET', path: objectPath(r2Key(stored)), expiresIn, now: now() });
    }
  };
}
