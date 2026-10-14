// One-off backfill for supabase/migrations/20261028120000_alert_subscriptions_hashed_key.sql:
// fills alert_subscriptions.license_key_hash = licenceKeyHash(license_key)
// on rows that have a plain key and no hash yet. Never changes license_key
// and never logs a key or a hash: the result is counts only.

import { licenceKeyHash } from './telemetry.mjs';

const PAGE = 500;

export async function backfillAlertSubscriptionHashes({ supUrl, supKey, apply = false, fetchImpl = fetch, hash = licenceKeyHash }) {
  if (!supUrl || !supKey) throw new Error('Supabase credentials are missing');
  const base = `${String(supUrl).replace(/\/+$/, '')}/rest/v1/alert_subscriptions`;
  const headers = { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json' };
  const out = { scanned: 0, hashed: 0, skipped_no_salt: 0, failed: 0, applied: Boolean(apply) };
  let lastId = null;
  for (;;) {
    const filters = ['select=id,license_key', 'license_key=not.is.null', 'license_key_hash=is.null', 'order=id.asc', `limit=${PAGE}`];
    if (lastId != null) filters.push(`id=gt.${encodeURIComponent(lastId)}`);
    const res = await fetchImpl(`${base}?${filters.join('&')}`, { headers });
    if (!res.ok) throw new Error(`reading alert_subscriptions failed: HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      out.scanned++;
      lastId = row.id;
      const h = hash(row.license_key);
      if (!h) { out.skipped_no_salt++; continue; }
      if (!apply) { out.hashed++; continue; }
      const p = await fetchImpl(`${base}?id=eq.${encodeURIComponent(row.id)}&license_key_hash=is.null`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ license_key_hash: h })
      });
      if (p.ok) out.hashed++; else out.failed++;
    }
    if (rows.length < PAGE) break;
  }
  return out;
}
