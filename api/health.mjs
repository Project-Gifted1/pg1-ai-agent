/**
 * Public uptime-monitoring health check — GET/HEAD /api/health.
 *
 * Deliberately ungated: no license key, free-tier opt-in or x402 check, and
 * it must never consume the free-tier daily quota (see lib/freeTier.mjs).
 * Uptime monitors are expected to hit this frequently, so the Supabase
 * reachability result is cached in memory for CACHE_TTL_MS and the check
 * itself uses a HEAD request (no row/column data, no count) against an
 * existing table for the cheapest possible read.
 */

import { getSupabaseCreds } from '../lib/supabase.mjs';

export const config = { maxDuration: 10 };

const CACHE_TTL_MS = 30_000;
const SUPABASE_TIMEOUT_MS = 2_000;
const HEALTH_CHECK_TABLE = 'threat_ioc_telemetry';

let cachedResult = null; // { expiresAt, statusCode, body }

async function checkSupabase() {
  let supUrl, supKey;
  try {
    ({ supUrl, supKey } = getSupabaseCreds());
  } catch {
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
  try {
    const res = await fetch(`${supUrl}/rest/v1/${HEALTH_CHECK_TABLE}?select=*&limit=1`, {
      method: 'HEAD',
      headers: { apikey: supKey, Authorization: `Bearer ${supKey}` },
      signal: controller.signal
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function buildResult(ok) {
  const time = new Date().toISOString();
  return ok
    ? { statusCode: 200, body: { status: 'ok', checks: { supabase: 'ok' }, time } }
    : { statusCode: 503, body: { status: 'degraded', checks: { supabase: 'unavailable' }, time } };
}

async function getHealthResult() {
  const now = Date.now();
  if (cachedResult && cachedResult.expiresAt > now) {
    return cachedResult;
  }
  const ok = await checkSupabase();
  const result = { ...buildResult(ok), expiresAt: now + CACHE_TTL_MS };
  cachedResult = result;
  return result;
}

// Test-only: the in-memory cache is module-level state, so tests need a way
// to reset it between cases instead of leaking across test files.
export function __resetHealthCache() {
  cachedResult = null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).end();
  }

  const result = await getHealthResult();

  if (req.method === 'HEAD') {
    return res.status(result.statusCode).end();
  }
  return res.status(result.statusCode).json(result.body);
}
