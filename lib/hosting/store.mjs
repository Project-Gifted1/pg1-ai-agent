// The hosting dataset in storage (pg1_jurisdictions, pg1_providers), with
// the bundled seed (lib/hosting/dataset.mjs) as the fallback when storage
// is not configured, unreachable or not migrated yet.

import { JURISDICTIONS, PROVIDERS } from './dataset.mjs';

export const JURISDICTION_TABLE = 'pg1_jurisdictions';
export const PROVIDER_TABLE = 'pg1_providers';
const CACHE_MS = 10 * 60 * 1000;

let cache = null;
export function __clearHostingCache() {
  cache = null;
}

export function bundledHostingData() {
  return { jurisdictions: JURISDICTIONS, providers: PROVIDERS, source: 'bundled' };
}

function rest({ supUrl, supKey, fetchImpl, timeoutMs = 3000 }) {
  return async (path, options = {}) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { ...options, headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) }, signal: controller.signal, cache: 'no-store' });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`hosting storage ${res.status}`), { status: res.status });
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(t);
    }
  };
}

// Never throws: the bundled seed when storage cannot answer.
export async function loadHostingData({ supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (cache && cache.expires > now) return cache.value;
  let value = bundledHostingData();
  if (supUrl && supKey) {
    try {
      const r = rest({ supUrl, supKey, fetchImpl });
      const [jurisdictions, providers] = await Promise.all([r(`${JURISDICTION_TABLE}?select=*&order=code.asc`), r(`${PROVIDER_TABLE}?select=*&order=id.asc`)]);
      if (Array.isArray(jurisdictions) && jurisdictions.length && Array.isArray(providers) && providers.length) {
        value = { jurisdictions: jurisdictions.map((j) => ({ ...j, government_access: j.government_access || [] })), providers, source: 'database' };
      }
    } catch (e) { /* the bundled seed answers */ }
  }
  // A fallback answer is retried sooner than a stored one.
  cache = { value, expires: now + (value.source === 'database' ? CACHE_MS : 60000) };
  return value;
}

export function createHostingStore({ supUrl, supKey, fetchImpl = globalThis.fetch }) {
  const r = rest({ supUrl, supKey, fetchImpl, timeoutMs: 6000 });
  return {
    async get(table, key) {
      const t = table === 'jurisdiction' ? JURISDICTION_TABLE : PROVIDER_TABLE;
      const col = table === 'jurisdiction' ? 'code' : 'id';
      const rows = await r(`${t}?select=*&${col}=eq.${encodeURIComponent(key)}`);
      return Array.isArray(rows) ? rows[0] || null : null;
    },
    async setField(table, key, field, fact) {
      const t = table === 'jurisdiction' ? JURISDICTION_TABLE : PROVIDER_TABLE;
      const col = table === 'jurisdiction' ? 'code' : 'id';
      await r(`${t}?${col}=eq.${encodeURIComponent(key)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ [field]: fact, updated_at: new Date().toISOString() }) });
      __clearHostingCache();
    }
  };
}
