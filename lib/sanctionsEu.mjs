// The EU consolidated financial sanctions list, as wallet addresses PG1 can
// screen against (lib/screening.mjs). The official XML is fetched daily
// (/api/sanctions/sync-eu); each sanctioned entity's block is searched for
// digital-currency addresses, which are stored with the entity's EU
// reference number. Entries no longer on the list are removed; an address
// the operator dismissed after review stays dismissed while it is listed.
//
// The EU list rarely carries wallet addresses today, so OFAC remains the
// main source; the EU list is screened whenever it does.

import { normalizeWalletAddress } from './walletAddress.mjs';
import { EU_LIST_URL, EU_WALLET_TABLE } from './screening.mjs';
import { uniformRows } from './restRows.mjs';

const MAX_BYTES = 80 * 1024 * 1024;
const EVM = /\b0x[a-fA-F0-9]{40}\b/g;
const BECH32 = /\b(?:bc1|ltc1|tb1)[a-z0-9]{25,62}\b/g;
const BASE58 = /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g;
const TRON = /\bT[a-km-zA-HJ-NP-Z1-9]{33}\b/g;
// A base58 match counts only near words that mark an address, so ordinary
// identifiers in the list's text are not mistaken for wallets.
const ADDRESS_CONTEXT = /(?:digital currency|virtual currency|crypto|wallet|address|XBT|BTC|ETH|USDT|TRX)/i;

function decode(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// [{ address, address_normalized, eu_reference, entity_name }]
export function extractEuWallets(xml) {
  const out = new Map();
  const blocks = String(xml || '').split(/<sanctionEntity\b/).slice(1);
  for (const raw of blocks) {
    const block = raw.slice(0, raw.indexOf('</sanctionEntity>') >= 0 ? raw.indexOf('</sanctionEntity>') : raw.length);
    const ref = (/euReferenceNumber="([^"]+)"/.exec(block) || [])[1] || null;
    const name = decode((/wholeName="([^"]+)"/.exec(block) || [])[1] || '');
    const text = decode(block);
    const found = [...(text.match(EVM) || []), ...(text.match(BECH32) || [])];
    for (const re of [BASE58, TRON]) {
      for (const m of text.matchAll(re)) {
        const around = text.slice(Math.max(0, m.index - 200), m.index + m[0].length + 50);
        if (ADDRESS_CONTEXT.test(around)) found.push(m[0]);
      }
    }
    for (const address of found) {
      const normalized = normalizeWalletAddress(address);
      if (!out.has(normalized)) out.set(normalized, { address, address_normalized: normalized, eu_reference: ref, entity_name: name.slice(0, 200) || null });
    }
  }
  return [...out.values()];
}

// Fetches the list and replaces the table's contents. Never throws.
export async function syncEuList({ supUrl, supKey, fetchImpl = globalThis.fetch, url = EU_LIST_URL, now = Date.now() }) {
  const h = { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json' };
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return { ok: false, error: `list ${res.status}` };
    const text = await res.text();
    if (text.length > MAX_BYTES || !/<export\b|<sanctionEntity\b/.test(text)) return { ok: false, error: 'not the EU list' };
    const entities = (text.match(/<sanctionEntity\b/g) || []).length;
    if (entities < 100) return { ok: false, error: `only ${entities} entities: refusing to treat a partial file as the list` };
    const rows = extractEuWallets(text);
    const seenAt = new Date(now).toISOString();
    if (rows.length) {
      const up = await fetchImpl(`${supUrl}/rest/v1/${EU_WALLET_TABLE}?on_conflict=address_normalized`, { method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(uniformRows(rows.map((r) => ({ ...r, last_seen_at: seenAt })), EU_WALLET_TABLE)) });
      if (!up.ok) return { ok: false, error: `store ${up.status}` };
    }
    // Delisted: not in today's file.
    const del = await fetchImpl(`${supUrl}/rest/v1/${EU_WALLET_TABLE}?last_seen_at=lt.${encodeURIComponent(seenAt)}`, { method: 'DELETE', headers: { ...h, Prefer: 'return=minimal' } });
    return { ok: del.ok, entities, wallets: rows.length };
  } catch (e) {
    return { ok: false, error: 'unreachable' };
  }
}
