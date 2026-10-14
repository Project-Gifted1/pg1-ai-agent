// Short-TTL cache for completed, safe-to-share check results, so repeated
// checks of the same subject answer in milliseconds (status page target:
// cached p95 < 500 ms). Only results whose status is no_flags or flagged
// are cached (an unknown or failed check is always re-run), for
// RESULT_CACHE_TTL_MS (default 5 minutes; PG1_RESULT_CACHE_TTL_MS), per
// server instance, keyed by tool and canonical arguments. Nothing about the
// caller is part of a cached result.

import { canonicalJson } from './signing.mjs';

export const DEFAULT_RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 2000;
const cache = new Map();

export function resultCacheTtl(env = process.env) {
  const n = Number(env.PG1_RESULT_CACHE_TTL_MS);
  return Number.isFinite(n) && n >= 0 && n <= 3600000 ? n : DEFAULT_RESULT_CACHE_TTL_MS;
}

export function __clearResultCache() {
  cache.clear();
}

export async function cachedCheck(tool, args, run, { now = Date.now, ttlMs = resultCacheTtl() } = {}) {
  const key = `${tool}|${canonicalJson(args || {})}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < ttlMs) return { ...structuredClone(hit.value), cached: true };
  const value = await run();
  if (ttlMs > 0 && value && (value.status === 'no_flags' || value.status === 'flagged')) {
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now(), value: structuredClone(value) });
  }
  return value;
}
