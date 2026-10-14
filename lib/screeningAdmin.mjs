// /screening (signed-in operator only):
//   /screening                    the last 30 days of refused payers (hash
//                                 prefix, lists, context) and the sources
//   /screening dismiss <address> <reason>
//                                 marks an address PG1 extracted from the EU
//                                 list as an extraction error after review.
//                                 OFAC entries cannot be dismissed here: a
//                                 wrong OFAC entry is appealed to OFAC.

import { SCREENING_EVENT_TABLE, EU_WALLET_TABLE, SCREENING_SOURCES, __clearScreeningCache } from './screening.mjs';
import { normalizeWalletAddress } from './walletAddress.mjs';
import { logAutonomy } from './autonomy.mjs';

export function isScreeningCommand(text) {
  return /^\/screening(?:\s|$)/i.test(String(text || '').trim());
}

export async function handleScreeningCommand({ text, supUrl, supKey, fetchImpl = globalThis.fetch, isOperator = false, now = Date.now() }) {
  if (isOperator !== true) return { reply: 'Screening details are for the signed-in operator only.' };
  const m = /^\/screening\s*(\S*)\s*(\S*)\s*([\s\S]*)$/i.exec(String(text || '').trim());
  const sub = (m[1] || '').toLowerCase();
  const h = { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json' };
  try {
    if (sub === 'dismiss') {
      const address = m[2];
      const why = (m[3] || '').trim();
      if (!address || why.length < 5) return { reply: 'Usage: /screening dismiss <address> <reason, after checking the EU list entry>.' };
      const normalized = normalizeWalletAddress(address);
      const res = await fetchImpl(`${supUrl}/rest/v1/${EU_WALLET_TABLE}?address_normalized=eq.${encodeURIComponent(normalized)}&select=address_normalized`, { method: 'PATCH', headers: { ...h, Prefer: 'return=representation' }, body: JSON.stringify({ dismissed: true, dismissed_reason: why.slice(0, 300), dismissed_at: new Date(now).toISOString() }) });
      const rows = res.ok ? await res.json() : [];
      if (!rows.length) return { reply: 'That address is not in PG1\'s copy of the EU list. OFAC entries cannot be dismissed: a wrongly listed wallet is appealed to OFAC.' };
      __clearScreeningCache();
      await logAutonomy({ supUrl, supKey, fetchImpl }, { action: 'screening:dismiss', decision: 'allowed', mode: 'operator', outcome: 'dismissed', detail: `EU list extraction, ${why.slice(0, 80)}` });
      return { reply: 'Dismissed. The address is no longer matched against the EU list while this entry stays listed, and the screening cache was cleared.' };
    }
    const since = new Date(now - 30 * 86400000).toISOString();
    const res = await fetchImpl(`${supUrl}/rest/v1/${SCREENING_EVENT_TABLE}?select=created_at,wallet_hash,lists,context,eu_references&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=50`, { headers: h });
    const rows = res.ok ? await res.json() : null;
    if (!rows) return { reply: 'The screening log could not be read right now.' };
    return {
      reply: [
        '### [ SANCTIONS SCREENING ]',
        `Sources: ${Object.values(SCREENING_SOURCES).map((s) => `${s.name} (${s.cadence})`).join('; ')}.`,
        rows.length ? `Refused payers in the last 30 days: ${rows.length}` : 'No refused payers in the last 30 days.',
        ...rows.map((r) => `- ${r.created_at.slice(0, 16).replace('T', ' ')} · ${(r.wallet_hash || '?').slice(0, 12)}… · ${(r.lists || []).join('+').toUpperCase()} · ${r.context}${r.eu_references && r.eu_references.length ? ` · EU ${r.eu_references.join(', ')}` : ''}`)
      ].join('\n')
    };
  } catch (e) {
    return { reply: 'The screening log could not be read right now.' };
  }
}
