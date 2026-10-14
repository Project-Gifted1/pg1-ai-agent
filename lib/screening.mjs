// Customer sanctions screening (P11): before any payment, quote or job, the
// paying wallet is checked against the OFAC SDN list and the EU consolidated
// financial sanctions list.
//
// - Match: refused. No quote, no 402, nothing settled. A hashed record is
//   logged (pg1_screening_events) and the operator is told.
// - Unavailable (a list cannot be read): refused for now (fail closed),
//   nothing charged, with a retry hint. Not cached.
// - Clean: allowed. Results (clean and matched) are cached for 24 hours per
//   wallet, in memory, keyed by the wallet's salted hash.
// Screening is free and never counts against the free tier.
//
// Matching is on the exact normalised address (lib/walletAddress.mjs), so a
// "wrong match" means the list entry itself: OFAC entries are appealed to
// OFAC; an EU address PG1 extracted from the list's text can be dismissed by
// the operator after review (/screening dismiss). See docs/screening.md.

import { normalizeWalletAddress } from './walletAddress.mjs';
import { callerHash } from './telemetry.mjs';

export const SCREENING_CACHE_MS = 24 * 3600 * 1000;
export const SCREENING_EVENT_TABLE = 'pg1_screening_events';
export const EU_WALLET_TABLE = 'pg1_eu_sanctioned_wallets';
export const SCREENING_EVENT_RETENTION_DAYS = 1825;

export const EU_LIST_URL = 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw';
export const SCREENING_SOURCES = Object.freeze({
  ofac: { name: 'OFAC Specially Designated Nationals and Blocked Persons (SDN) list', url: 'https://sanctionslist.ofac.treas.gov/Home/SdnList', licence: 'US government work (public domain)', cadence: 'the existing sanctions sync into sanctioned_wallets' },
  eu: { name: 'EU consolidated list of persons, groups and entities subject to EU financial sanctions', url: EU_LIST_URL, dataset: 'https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions', licence: 'free reuse, including commercial, with attribution (Commission Decision 2011/833/EU)', cadence: 'daily (/api/sanctions/sync-eu)' }
});

export function refusalMessage(env = process.env) {
  const contact = String(env.PG1_SCREENING_APPEAL_CONTACT || '').trim() || 'https://pg1-ai-agent.vercel.app/docs/screening';
  return `This wallet cannot be served: it matches a sanctions list PG1 screens against. Nothing was charged. If you believe this is wrong, see ${contact}.`;
}
export const UNAVAILABLE_MESSAGE = 'Sanctions screening is temporarily unavailable, so PG1 cannot take this payment right now. Nothing was charged; retry in a few minutes.';

const cache = new Map();
export function __clearScreeningCache() {
  cache.clear();
}

async function get(fetchImpl, url, supKey, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

// deps: { supUrl, supKey, fetchImpl, notify?, env, now, timeoutMs }
// Resolves to { allowed, refused, unavailable, lists, cached, message }.
// Never throws.
// Tests of other payment paths opt out of the lists explicitly.
let screeningOverride = null;
export function __setScreeningForTests(fn) {
  screeningOverride = fn || null;
}

export async function screenPayer(wallet, { supUrl, supKey, fetchImpl = globalThis.fetch, notify = null, env = process.env, now = Date.now(), timeoutMs = 4000, context = 'payment' } = {}) {
  if (screeningOverride) return screeningOverride(wallet, { context });
  const address = typeof wallet === 'string' ? wallet.trim() : '';
  if (!address) return { allowed: false, refused: true, unavailable: false, lists: [], cached: false, reason: 'no_payer', message: 'The payment does not name a paying wallet, so it cannot be screened. Nothing was charged.' };
  const normalized = normalizeWalletAddress(address);
  const key = callerHash(`wallet:${normalized}`) || `unsalted:${normalized}`;
  const hit = cache.get(key);
  if (hit && hit.expires > now) return { ...hit.result, cached: true };
  if (!supUrl || !supKey) return { allowed: false, refused: false, unavailable: true, lists: [], cached: false, reason: 'not_configured', message: UNAVAILABLE_MESSAGE };

  const enc = encodeURIComponent(normalized);
  let ofacRows;
  let euRows = [];
  let euChecked = true;
  try {
    const [health, ofac, eu] = await Promise.all([
      get(fetchImpl, `${supUrl}/rest/v1/sanctioned_wallets?select=updated_at&order=updated_at.desc&limit=1`, supKey, timeoutMs),
      get(fetchImpl, `${supUrl}/rest/v1/sanctioned_wallets?select=sdn_uid&address_normalized=eq.${enc}&limit=5`, supKey, timeoutMs),
      get(fetchImpl, `${supUrl}/rest/v1/${EU_WALLET_TABLE}?select=eu_reference&address_normalized=eq.${enc}&dismissed=eq.false&limit=5`, supKey, timeoutMs)
    ]);
    if (!health.ok || !ofac.ok) throw new Error('ofac unavailable');
    const healthRows = await health.json();
    if (!Array.isArray(healthRows) || !healthRows.length) throw new Error('ofac list empty');
    ofacRows = await ofac.json();
    // The EU table is new (P11 migration): before it exists, OFAC alone
    // answers and the operator is told in the screening record.
    if (eu.status === 404) euChecked = false;
    else if (!eu.ok) throw new Error('eu unavailable');
    else euRows = await eu.json();
  } catch (e) {
    return { allowed: false, refused: false, unavailable: true, lists: [], cached: false, reason: 'unavailable', message: UNAVAILABLE_MESSAGE };
  }

  const lists = [...(ofacRows.length ? ['ofac'] : []), ...(euRows.length ? ['eu'] : [])];
  const result = lists.length
    ? { allowed: false, refused: true, unavailable: false, lists, cached: false, reason: 'sanctions_match', message: refusalMessage(env) }
    : { allowed: true, refused: false, unavailable: false, lists: [], lists_checked: euChecked ? ['ofac', 'eu'] : ['ofac'], cached: false };
  cache.set(key, { result, expires: now + SCREENING_CACHE_MS });

  if (result.refused) {
    // A hashed record only: never the wallet itself.
    try {
      await fetchImpl(`${supUrl}/rest/v1/${SCREENING_EVENT_TABLE}`, { method: 'POST', headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ wallet_hash: key.startsWith('unsalted:') ? null : key, lists, context: String(context).slice(0, 40), eu_references: euRows.map((r) => r.eu_reference).filter(Boolean).slice(0, 5), ofac_uids: ofacRows.map((r) => String(r.sdn_uid)).filter(Boolean).slice(0, 5) }) });
    } catch (e) { /* the refusal stands even if the record fails */ }
    if (notify) {
      try { await notify({ supUrl, supKey, route: '/screening', reason: 'sanctions_screening_match', message: `A ${context} from wallet ${key.slice(0, 12)}… matched ${lists.join(' and ').toUpperCase()} and was refused before any quote or payment.` }); } catch (e) { /* best effort */ }
    }
  }
  return result;
}

// The adapter each payment path takes as deps.screen: the P7 shape
// ({ allowed, reason }) and the P8/P9 shape ({ refused, message }) at once.
// Unavailable throws, so no path mistakes it for a refusal it records.
export function payerScreen(opts) {
  return async (wallet, context) => {
    const r = await screenPayer(wallet, { ...opts, context: context || opts.context || 'payment' });
    if (r.unavailable) throw Object.assign(new Error(r.message), { screeningUnavailable: true, status: 503, code: 'screening_unavailable', retryAfter: 60 });
    return { ...r, reason: r.refused ? 'payer_screening' : null };
  };
}
