// The threat feed as chat reads it (api/chat.mjs, a message about threats,
// indicators, the radar or the feed): the same source policy as /api/ioc,
// Ireland-time "today", no placeholder indicators, and confidence only when
// a source really gave one.
//
//   Source policy   rows come through fetchThreatTelemetry (lib/sourcePolicy.mjs),
//                   the one read path /api/ioc uses, so a switched-off or
//                   locked source never reaches a reply. The signed-in
//                   operator alone may also see the locked sources (OTX,
//                   abuse.ch, AbuseIPDB leftovers, unattributed rows), each
//                   row labelled with its source and "not licensed: operator
//                   view only"; anybody else never gets them.
//   Today           "today" is the Ireland calendar day (Europe/Dublin): the
//                   count of records added today, by source; when there are
//                   none, it says so and offers the latest records instead.
//   Placeholders    example and test indicators (contoso, example.com/.org/
//                   .net, maliciousdomain.com, test/sample/placeholder names,
//                   reserved TLDs and documentation IPs) are left out and
//                   counted. PLACEHOLDER_PATTERNS is the list the
//                   sovereign-threat-pipeline ingestion should drop too.
//   Confidence      a source whose rows all carry the same confidence score
//                   is showing a default, not a score: it is left out.
//                   Shown only when the source's rows differ.
//
// Never "safe": a source with nothing on an indicator has "no flags found".

import { fetchThreatTelemetry, rowSource, isReservedTestIndicator, THREAT_SOURCES, LOCKED_SOURCE_IDS } from './sourcePolicy.mjs';

export const FEED_TIME_ZONE = 'Europe/Dublin';
export const FEED_SELECT = 'select=value,indicator_type,verification_source,confidence_score,ingested_at';
export const TODAY_LIMIT = 1000;
export const SHOWN_ROWS = 10;

// Placeholder and example indicators: never real threat data. Each entry is
// { id, re, example } so the same list documents itself in a PR.
export const PLACEHOLDER_PATTERNS = Object.freeze([
  { id: 'contoso', re: /(?:^|[.@/\s-])(?:contoso|fabrikam|northwindtraders|adventure-works|wingtiptoys|tailspintoys|woodgrovebank)(?:[.\-]|$)/i, example: 'contoso.com, fabrikam.com (Microsoft sample names)' },
  { id: 'example_domain', re: /(?:^|[.@/])example\.(?:com|org|net|edu)(?:[/:?#]|$)/i, example: 'example.com, example.org, example.net, example.edu' },
  { id: 'malicious_placeholder', re: /(?:^|[.@/])(?:malicious|evil|bad|phishing|attacker|hacker)[-_]?(?:domain|site|host|server|url|ip|example|corp)\d*\.[a-z]{2,}(?:[/:?#]|$)/i, example: 'maliciousdomain.com, evil-site.net, attacker-server.org' },
  { id: 'test_sample_placeholder', re: /(?:^|[.@/])(?:test|testing|sample|placeholder|dummy|fake|foo|bar|demo|your)[-_]?(?:domain|site|host|server|url|ip|indicator|ioc|value|name)?\d*\.[a-z]{2,}(?:[/:?#]|$)/i, example: 'test.com, sample-domain.net, placeholder.io, dummy123.org, yourdomain.com' },
  { id: 'reserved_names', re: null, example: 'the reserved TLDs .example .test .invalid .localhost, the documentation IPs 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32, CVE-0000-*, PG1 fixture wallets (lib/sourcePolicy.mjs isReservedTestIndicator)' },
  { id: 'placeholder_ip', re: /^(?:0\.0\.0\.0|1\.2\.3\.4|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|255\.255\.255\.255|x\.x\.x\.x)$/i, example: '0.0.0.0, 1.2.3.4, loopback 127.0.0.0/8 and private 10/8, 172.16/12, 192.168/16' },
  { id: 'placeholder_hash', re: /^(?:0{32}|0{40}|0{64}|f{32}|f{40}|f{64}|d41d8cd98f00b204e9800998ecf8427e|da39a3ee5e6b4b0d3255bfef95601890afd80709|e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855|(?:0123456789abcdef){2,4}|(?:abcdef0123456789){2,4})$/i, example: 'all-zero or all-f hashes, the hashes of an empty file (MD5 d41d8cd9…, SHA-1 da39a3ee…, SHA-256 e3b0c442…), 0123456789abcdef repeats' },
  { id: 'placeholder_words', re: /^(?:test|sample|placeholder|example|dummy|fake|n\/a|none|null|undefined|tbd|todo|xxx+|lorem ipsum.*)$/i, example: 'a bare value of test, sample, placeholder, example, dummy, n/a, null, xxx' }
]);

export function isPlaceholderIndicator(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return true;
  if (isReservedTestIndicator(v)) return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.re && p.re.test(v));
}

// --- Ireland days -------------------------------------------------------------

const parts = new Intl.DateTimeFormat('en-GB', { timeZone: FEED_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function wall(ms) {
  const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month - 1, d: p.day, ms: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) };
}
export function irelandDay(ms = Date.now()) {
  const w = wall(ms);
  return new Date(Date.UTC(w.y, w.m, w.d)).toISOString().slice(0, 10);
}
// The instant today's Ireland calendar day started.
export function irelandDayStart(now = Date.now()) {
  const w = wall(now);
  const target = Date.UTC(w.y, w.m, w.d);
  let t = target - (wall(target).ms - target);
  t -= wall(t).ms - target;
  return t;
}

// --- questions ------------------------------------------------------------------

export function isThreatFeedQuestion(text) {
  const t = String(text || '').toLowerCase();
  return /\bthreat|\bindicator|\bradar\b|\bioc\b|\bthreat feed\b|\bfeed\b.*\b(?:threat|ioc|today)/.test(t);
}
export function asksForToday(text) {
  return /\btoday'?s?\b|\bthis morning\b|\bso far today\b/i.test(String(text || ''));
}

// --- the read ---------------------------------------------------------------------

const LABELS = Object.freeze({ nvd: 'NVD', blocklist_de: 'Blocklist.de', pg1_swarm: 'PG1 Swarm', scamsniffer: 'ScamSniffer', other: 'other source', abusech: 'abuse.ch', otx: 'AlienVault OTX', abuseipdb: 'AbuseIPDB', unattributed: 'no recorded source' });
export const sourceLabel = (id) => LABELS[id] || id;

function lockedFilter() {
  const locked = THREAT_SOURCES.filter((s) => s.locked);
  const ors = locked.flatMap((s) => s.patterns.map((p) => `verification_source.ilike.${p}`)).concat(['verification_source.is.null']);
  return `or=${encodeURIComponent(`(${ors.join(',')})`)}`;
}

async function readLocked(supUrl, supKey, filters, fetchImpl) {
  try {
    const res = await fetchImpl(`${supUrl}/rest/v1/threat_ioc_telemetry?${[...filters, lockedFilter()].join('&')}`, { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }, cache: 'no-store' });
    if (!res || !res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows.filter((r) => LOCKED_SOURCE_IDS.includes(rowSource(r))).map((r) => ({ ...r, locked: true })) : [];
  } catch (e) { return []; }
}

// Confidence a source really gave: per source, only when its rows differ.
export function confidenceIsReal(rows, sourceId) {
  const vals = rows.filter((r) => r.source === sourceId).map((r) => r.confidence_score).filter((v) => v !== null && v !== undefined && v !== '');
  return new Set(vals.map(String)).size > 1;
}

// { ok, today: boolean, day, rows, countsToday: [{ source, label, count }], totalToday,
//   placeholdersDropped, capped, latestInstead, block }
export async function loadChatThreatFeed({ supUrl, supKey, fetchImpl = globalThis.fetch, env = process.env, isOperator = false, prompt = '', now = Date.now() } = {}) {
  const day = irelandDay(now);
  const startIso = new Date(irelandDayStart(now)).toISOString();
  const wantToday = asksForToday(prompt);
  const operator = isOperator === true;
  const todayFilters = [FEED_SELECT, `ingested_at=gte.${encodeURIComponent(startIso)}`, 'order=ingested_at.desc', `limit=${TODAY_LIMIT}`];
  const [served, locked] = await Promise.all([
    fetchThreatTelemetry(supUrl, supKey, todayFilters, { fetchImpl, env }).catch(() => ({ ok: false, rows: [] })),
    operator ? readLocked(supUrl, supKey, todayFilters, fetchImpl) : Promise.resolve([])
  ]);
  if (!served.ok) return { ok: false, day, block: '' };
  const tag = (r) => ({ ...r, source: rowSource(r) });
  let todayRows = served.rows.map(tag).concat(locked.map(tag));
  const before = todayRows.length;
  todayRows = todayRows.filter((r) => !isPlaceholderIndicator(r.value));
  let placeholdersDropped = before - todayRows.length;
  const capped = served.rows.length >= TODAY_LIMIT;
  const counts = new Map();
  for (const r of todayRows) counts.set(r.source, (counts.get(r.source) || 0) + 1);
  const countsToday = [...counts.entries()].map(([source, count]) => ({ source, label: sourceLabel(source), count, locked: LOCKED_SOURCE_IDS.includes(source) })).sort((a, b) => b.count - a.count);
  const totalToday = todayRows.length;

  let shown = todayRows;
  let latestInstead = false;
  if (!totalToday) {
    // Nothing today: the latest records instead (servable, plus locked for the operator).
    const latestFilters = [FEED_SELECT, 'order=ingested_at.desc', 'limit=50'];
    const [s2, l2] = await Promise.all([
      fetchThreatTelemetry(supUrl, supKey, latestFilters, { fetchImpl, env }).catch(() => ({ ok: false, rows: [] })),
      operator ? readLocked(supUrl, supKey, latestFilters, fetchImpl) : Promise.resolve([])
    ]);
    const all = (s2.ok ? s2.rows : []).map(tag).concat(l2.map(tag));
    const kept = all.filter((r) => !isPlaceholderIndicator(r.value));
    placeholdersDropped += all.length - kept.length;
    shown = kept.sort((a, b) => String(b.ingested_at || '').localeCompare(String(a.ingested_at || '')));
    latestInstead = true;
  }
  shown = shown.slice(0, SHOWN_ROWS);
  const out = { ok: true, today: wantToday, day, rows: shown, countsToday, totalToday, placeholdersDropped, capped, latestInstead };
  out.block = threatFeedBlock(out, { allRows: todayRows.length ? todayRows : shown });
  return out;
}

function rowLine(r, allRows) {
  const conf = confidenceIsReal(allRows, r.source) ? ` · confidence ${r.confidence_score} (from the source)` : '';
  const lockedNote = r.locked ? ' · LOCKED SOURCE: not licensed, operator view only, never served to anyone else' : '';
  return `• [${r.indicator_type || 'indicator'}] ${r.value} · source: ${sourceLabel(r.source)}${conf}${lockedNote}`;
}

// The [CONTEXT] block for the model, with the rules for this answer.
export function threatFeedBlock(feed, { allRows = feed.rows } = {}) {
  const head = feed.latestInstead
    ? `[TODAY'S THREAT FEED (Ireland time, ${feed.day})]: No records were added today${feed.placeholdersDropped ? ` (${feed.placeholdersDropped} placeholder or example indicator${feed.placeholdersDropped === 1 ? '' : 's'} left out)` : ''}. Say so plainly and offer the latest records below instead (newest first).`
    : `[TODAY'S THREAT FEED (Ireland time, ${feed.day})]: ${feed.capped ? 'at least ' : ''}${feed.totalToday} record${feed.totalToday === 1 ? '' : 's'} added today: ${feed.countsToday.map((c) => `${c.label} ${c.count}${c.locked ? ' (locked source, operator view only)' : ''}`).join(', ')}${feed.placeholdersDropped ? `; ${feed.placeholdersDropped} placeholder or example indicator${feed.placeholdersDropped === 1 ? '' : 's'} left out` : ''}. Give this count and the split by source; the rows below are the newest ${feed.rows.length}.`;
  const rules = 'Rules: name each record\'s source as given; a row marked LOCKED SOURCE is never servable and must be described with its source and as operator view only; give a confidence only where one is shown below (a source that gives every row the same score is not scoring, so none is shown); a lookup that finds nothing is "no flags found", never "safe" or "clean".';
  const lines = feed.rows.length ? feed.rows.map((r) => rowLine(r, allRows)) : ['• (no records)'];
  return `\n\n${head}\n${rules}\n${lines.join('\n')}`;
}
