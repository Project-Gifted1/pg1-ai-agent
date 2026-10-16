// /threat-radar (signed-in operator only): the radar card's data, read live
// on every call. Pure shaping plus two reads, both injectable for tests:
//
//   - threat_ioc_telemetry through fetchThreatTelemetry (lib/sourcePolicy.mjs),
//     so only sources PG1 may serve are shown: the indicators ingested in
//     the last 7 days, per feed per day (Ireland days)
//   - the CISA Known Exploited Vulnerabilities catalog (public domain): the
//     entries added in the last 7 days, and which of the feed's CVEs are on it
//
// buildThreatRadar(...) → view:
//   { as_of, fetched_ms, days: ['2026-10-10', ...7],
//     feeds: [{ id, label, total, per_day: [7 numbers], error? }],
//     findings: [{ id, value, type, status, kev, source, seen_at, angle, ring }],
//     counts: { flagged, unknown, no_flags }, kev: 'ok' | 'error' }
//
// A finding's status follows PG1's vocabulary: "flagged" when the CVE is on
// the KEV catalog, "no_flags" when the catalog was read and the CVE is not
// on it, "unknown" when the catalog could not be read or the indicator is
// not a CVE (the radar runs no check on it). Never "safe".
//
// Where a blip sits is not decoration either: its distance from the centre
// is its age (centre = now, rim = 7 days ago) and its bearing a stable hash
// of the value, so the same finding is always in the same place.

import { fetchThreatTelemetry, classifySource } from './sourcePolicy.mjs';

export const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
export const RADAR_DAYS = 7;
export const RADAR_MAX_FINDINGS = 24;
const DAY_MS = 86400000;
const TZ = 'Europe/Dublin';

const FEED_LABELS = { nvd: 'NVD', blocklist_de: 'Blocklist.de', pg1_swarm: 'PG1 Swarm', scamsniffer: 'ScamSniffer', other: 'Other sources', kev: 'CISA KEV' };

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const asOfFmt = new Intl.DateTimeFormat('en-IE', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

// The Ireland calendar day (YYYY-MM-DD) of an instant.
export function irelandDay(ms) {
  return dayFmt.format(new Date(ms));
}

// "16 Oct 2026, 09:46" in Ireland time.
export function irelandTime(ms) {
  return asOfFmt.format(new Date(ms)).replace(' at ', ', ');
}

// The last RADAR_DAYS Ireland days, oldest first, ending today.
export function radarDays(now) {
  const out = [];
  for (let i = RADAR_DAYS - 1; i >= 0; i--) {
    const d = irelandDay(now - i * DAY_MS);
    if (!out.includes(d)) out.push(d);
  }
  // DST can fold two instants onto one day: pad back to seven.
  while (out.length < RADAR_DAYS) out.unshift(irelandDay(Date.parse(`${out[0]}T12:00:00Z`) - DAY_MS));
  return out;
}

function perDay(days, stamps) {
  const counts = days.map(() => 0);
  for (const ms of stamps) {
    const i = days.indexOf(irelandDay(ms));
    if (i >= 0) counts[i]++;
  }
  return counts;
}

// A stable bearing (0-359) for a value: FNV-1a.
export function bearing(value) {
  let h = 0x811c9dc5;
  for (const ch of String(value)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

// Distance from the centre, 0.12 (now) to 0.94 (7 days ago).
export function ring(seenMs, now) {
  const age = Math.min(1, Math.max(0, (now - seenMs) / (RADAR_DAYS * DAY_MS)));
  return Math.round((0.12 + age * 0.82) * 1000) / 1000;
}

const isCve = (v) => /^CVE-\d{4}-\d{4,}$/i.test(String(v || '').trim());

async function readKev(fetchImpl, timeoutMs) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(KEV_URL, ctl ? { signal: ctl.signal } : {});
    if (!res || !res.ok) return null;
    const body = await res.json();
    return Array.isArray(body && body.vulnerabilities) ? body.vulnerabilities : null;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Resolves to the view. Never throws: a failed read shows as that feed's
// error and as "unknown" findings, never as an empty "all clear".
export async function buildThreatRadar({ supUrl, supKey, fetchImpl = globalThis.fetch, env = process.env, now = Date.now(), kevTimeoutMs = 5000 } = {}) {
  const days = radarDays(now);
  const sinceIso = new Date(Date.parse(`${days[0]}T00:00:00Z`) - DAY_MS).toISOString();
  const telemetry = supUrl && supKey
    ? fetchThreatTelemetry(supUrl, supKey, ['select=value,indicator_type,verification_source,ingested_at,last_seen', `ingested_at=gte.${encodeURIComponent(sinceIso)}`, 'order=ingested_at.desc', 'limit=1000'], { fetchImpl, env }).catch(() => ({ ok: false, rows: [] }))
    : Promise.resolve({ ok: false, rows: [], unconfigured: true });
  const [feed, kevList] = await Promise.all([telemetry, readKev(fetchImpl, kevTimeoutMs)]);

  const kevOk = Array.isArray(kevList);
  const kevIds = new Set(kevOk ? kevList.map((k) => String(k.cveID || '').toUpperCase()) : []);
  const inWindow = (ms) => Number.isFinite(ms) && days.includes(irelandDay(ms)) && ms <= now + 60000;

  // Feeds: one per servable source seen, plus KEV.
  const rows = (feed.rows || []).map((r) => ({ ...r, ms: Date.parse(r.ingested_at || r.last_seen || '') })).filter((r) => inWindow(r.ms));
  const bySource = new Map();
  for (const r of rows) {
    const id = classifySource(r.verification_source);
    if (!bySource.has(id)) bySource.set(id, []);
    bySource.get(id).push(r.ms);
  }
  const feeds = [];
  if (feed.ok && !bySource.size) feeds.push({ id: 'nvd', label: FEED_LABELS.nvd, total: 0, per_day: days.map(() => 0) });
  for (const [id, stamps] of bySource) feeds.push({ id, label: FEED_LABELS[id] || id, total: stamps.length, per_day: perDay(days, stamps) });
  if (!feed.ok) feeds.push({ id: 'nvd', label: FEED_LABELS.nvd, total: null, per_day: null, error: feed.unconfigured ? 'not configured on this deployment' : 'could not be read' });
  const kevRecent = kevOk ? kevList.map((k) => ({ id: String(k.cveID || '').toUpperCase(), ms: Date.parse(`${k.dateAdded}T12:00:00Z`) })).filter((k) => isCve(k.id) && inWindow(k.ms)) : [];
  feeds.push(kevOk
    ? { id: 'kev', label: FEED_LABELS.kev, total: kevRecent.length, per_day: perDay(days, kevRecent.map((k) => k.ms)) }
    : { id: 'kev', label: FEED_LABELS.kev, total: null, per_day: null, error: 'could not be read' });

  // Findings: the newest feed indicators and the KEV additions, one each.
  const seen = new Map();
  for (const r of rows) {
    const value = String(r.value || '').trim();
    const key = value.toUpperCase();
    if (!value || seen.has(key)) continue;
    const cve = isCve(value) || r.indicator_type === 'CVE';
    const kev = cve && kevIds.has(key);
    seen.set(key, { value: cve ? key : value, type: cve ? 'CVE' : String(r.indicator_type || 'indicator'), status: !cve || !kevOk ? 'unknown' : kev ? 'flagged' : 'no_flags', kev, source: classifySource(r.verification_source), ms: r.ms });
  }
  for (const k of kevRecent) {
    const had = seen.get(k.id);
    if (had) { had.kev = true; had.status = 'flagged'; continue; }
    seen.set(k.id, { value: k.id, type: 'CVE', status: 'flagged', kev: true, source: 'kev', ms: k.ms });
  }
  const findings = [...seen.values()]
    .sort((a, b) => (b.kev - a.kev) || (b.ms - a.ms))
    .slice(0, RADAR_MAX_FINDINGS)
    .sort((a, b) => b.ms - a.ms)
    .map((f) => ({ id: f.value, value: f.value, type: f.type, status: f.status, kev: f.kev, source: FEED_LABELS[f.source] || f.source, seen_at: new Date(f.ms).toISOString(), angle: bearing(f.value), ring: ring(f.ms, now) }));
  const counts = { flagged: 0, unknown: 0, no_flags: 0 };
  for (const f of findings) counts[f.status]++;

  return { as_of: irelandTime(now), fetched_ms: now, days, feeds, findings, counts, kev: kevOk ? 'ok' : 'error' };
}

// The reply text under the card (and what Read aloud says).
export function threatRadarLead(view) {
  const c = view.counts || {};
  const n = (view.findings || []).length;
  if (!n) return `**Threat radar**, data as of ${view.as_of} (Ireland): nothing new in the last ${RADAR_DAYS} days from the feeds PG1 serves.${view.kev === 'error' ? ' The known exploited catalog could not be read.' : ''}`;
  return `**Threat radar**, data as of ${view.as_of} (Ireland): ${n} recent ${n === 1 ? 'finding' : 'findings'}, ${c.flagged || 0} flagged (actively exploited), ${c.unknown || 0} unknown, ${c.no_flags || 0} with no flags in the sources checked.${view.kev === 'error' ? ' The known exploited catalog could not be read, so CVEs are unknown.' : ''}`;
}
