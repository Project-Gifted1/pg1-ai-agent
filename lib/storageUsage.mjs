// Storage figures for the /usage card (lib/usageCard.mjs): the database size
// and the file storage per bucket, read with the service role through
// public.pg1_storage_usage() (supabase/migrations/20261029120000_pg1_storage_usage.sql).
// Sizes only, never object names: per bucket, and per folder (film and
// track ids folded into "*"). Limits are the plan's: the free plan's
// 500 MB database and 1 GB file storage unless PG1_DB_LIMIT_MB /
// PG1_STORAGE_LIMIT_MB say otherwise (0 = no limit shown).
//
// Never throws: anything missing (no credentials, the function not applied
// yet, a timeout) gives null and the card says the figures are not
// available.

export const DEFAULT_DB_LIMIT_MB = 500;
export const DEFAULT_STORAGE_LIMIT_MB = 1024;
const MB = 1024 * 1024;
const READ_TIMEOUT_MS = 5000;

function limitBytes(value, fallbackMb) {
  const raw = String(value == null ? '' : value).trim();
  if (raw === '') return fallbackMb * MB;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * MB) : null;
}

export function storageLimits(env = process.env) {
  return {
    database: limitBytes(env.PG1_DB_LIMIT_MB, DEFAULT_DB_LIMIT_MB),
    files: limitBytes(env.PG1_STORAGE_LIMIT_MB, DEFAULT_STORAGE_LIMIT_MB)
  };
}

const whole = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);

// The function's answer -> { database_bytes, files_bytes, buckets, limits }.
export function shapeStorageUsage(raw, env = process.env) {
  const r = Array.isArray(raw) ? raw[0] : raw;
  const body = r && typeof r === 'object' && r.pg1_storage_usage ? r.pg1_storage_usage : r;
  if (!body || typeof body !== 'object') return null;
  const database = whole(body.database_bytes);
  if (database == null) return null;
  const buckets = (Array.isArray(body.buckets) ? body.buckets : [])
    .map((b) => ({ name: String((b && b.name) || '').replace(/[^\w.-]/g, '').slice(0, 40), bytes: whole(b && b.bytes) || 0, objects: whole(b && b.objects) || 0 }))
    .filter((b) => b.name);
  // The largest folders (20261101120000 migration; absent before it), with
  // film and track ids already folded into "*" by the database.
  const folders = (Array.isArray(body.folders) ? body.folders : [])
    .map((f) => ({ name: String((f && f.name) || '').replace(/[^\w.\-:/*() ]/g, '').slice(0, 60), bytes: whole(f && f.bytes) || 0, objects: whole(f && f.objects) || 0 }))
    .filter((f) => f.name);
  return { database_bytes: database, files_bytes: buckets.reduce((s, b) => s + b.bytes, 0), buckets, folders, limits: storageLimits(env) };
}

export async function getStorageUsage({ supUrl, supKey, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (!supUrl || !supKey) return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), READ_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(`${supUrl}/rest/v1/rpc/pg1_storage_usage`, {
      method: 'POST',
      headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
      signal: controller ? controller.signal : undefined
    });
    if (!res || !res.ok) return null;
    return shapeStorageUsage(await res.json(), env);
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
