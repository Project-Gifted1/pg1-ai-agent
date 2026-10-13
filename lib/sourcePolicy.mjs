// Per-source serving rules for threat_ioc_telemetry.
//
// Every external read of threat_ioc_telemetry (the /api/ioc STIX bundle and
// its /api/feeds/ioc alias, the paid get_threat_indicators / get_ioc_context /
// get_ioc_batch MCP tools, GET /api/ioc/context, and through those the chat
// tools and the playground) goes through fetchThreatTelemetry() below, so this
// file is the one place that decides which upstream sources PG1 may serve.
// Those reads are all paid responses (or the same data a paid response
// carries), so a source is served only when PG1 may resell it: our own data,
// public-domain data, or a source whose terms explicitly allow commercial
// resale.
//
// A row's source is read from its verification_source label (written by the
// sovereign-threat-pipeline repo). There are three kinds of source:
//
//   LOCKED OFF. Never served, and the SOURCE_*_ENABLED switch is
//   ignored: serving one again takes a code change made once a licence is
//   signed, never an environment variable.
//     abusech       abuse.ch (ThreatFox, URLhaus, MalwareBazaar, Feodo,
//                   SSLBL, YARAify): Spamhaus asked PG1 to stop serving
//                   abuse.ch indicators in the paid API until licensed.
//     otx           AlienVault OTX: no commercial licence.
//     abuseipdb     AbuseIPDB: licence declined and its records deleted. Any
//                   AbuseIPDB-labelled row left behind is never served.
//     unattributed  rows with no source label, and the old pipeline's
//                   "Sovereign-Engine-v3.2-<malware family>" label, which
//                   hides the real feed: no recorded source means unlicensed.
//
//   ON BY DEFAULT: public-domain sources.
//     nvd           NIST NVD (US Government work, public domain).
//
//   OFF BY DEFAULT until their terms are confirmed for commercial resale.
//   SOURCE_<ID>_ENABLED=true serves one again; do that only once its terms
//   are confirmed in writing.
//     blocklist_de  Blocklist.de: free lists, no licence that allows resale.
//     pg1_swarm     "PG1-Swarm-*" labels: no writer in any PG1 repository, so
//                   provenance is unrecorded until shown to be our own data.
//     scamsniffer   ScamSniffer scam-database: GPL-3.0 repository, 7-day
//                   delayed; real-time data is a paid ScamSniffer product.
//     other         any other non-empty label (a source added later).
//
// "true"/"1"/"yes"/"on" turns a switch on, "false"/"0"/"no"/"off" turns it
// off, anything else (or unset) keeps the default. Switches are read on every
// query, not at import time.
//
// The filter runs twice from the same table below: as PostgREST conditions,
// so `limit` still counts only servable rows, and again on the returned rows,
// which is the authoritative check (it also catches labels the URL filter
// can't express, and a row whose source can't be classified at all).

// Matched in order, first hit wins, case-insensitive. Patterns use PostgREST
// ilike syntax (* is the wildcard) so the same strings drive both checks.
// abuse.ch comes first so no other pattern can claim one of its rows, and the
// legacy label comes before the named feeds because its suffix is free text
// (an OTX pulse name, a ThreatFox malware name) that could contain anything.
// AbuseIPDB comes before the rest for the same reason.
export const THREAT_SOURCES = Object.freeze([
  { id: 'abusech', env: 'SOURCE_ABUSECH_ENABLED', defaultEnabled: false, locked: true, patterns: ['*abuse.ch*', '*abusech*', '*abuse_ch*', '*threatfox*', '*urlhaus*', '*malwarebazaar*', '*feodo*', '*sslbl*', '*yaraify*'] },
  { id: 'unattributed', env: 'SOURCE_UNATTRIBUTED_ENABLED', defaultEnabled: false, locked: true, patterns: ['Sovereign-Engine-*'] },
  { id: 'abuseipdb', env: 'SOURCE_ABUSEIPDB_ENABLED', defaultEnabled: false, locked: true, patterns: ['*abuseipdb*'] },
  { id: 'otx', env: 'SOURCE_OTX_ENABLED', defaultEnabled: false, locked: true, patterns: ['*alienvault*', '*otx*', '*levelblue*'] },
  { id: 'nvd', env: 'SOURCE_NVD_ENABLED', defaultEnabled: true, patterns: ['NVD*'] },
  { id: 'blocklist_de', env: 'SOURCE_BLOCKLIST_DE_ENABLED', defaultEnabled: false, patterns: ['*blocklist.de*'] },
  { id: 'pg1_swarm', env: 'SOURCE_PG1_SWARM_ENABLED', defaultEnabled: false, patterns: ['PG1-Swarm-*'] },
  { id: 'scamsniffer', env: 'SOURCE_SCAMSNIFFER_ENABLED', defaultEnabled: false, patterns: ['*scamsniffer*'] }
]);

// Source ids that may never be served, whatever the environment says.
export const LOCKED_SOURCE_IDS = Object.freeze(THREAT_SOURCES.filter((s) => s.locked).map((s) => s.id));

// Any other non-empty label (a source added later, a test label).
export const OTHER_SOURCE = Object.freeze({ id: 'other', env: 'SOURCE_OTHER_ENABLED', defaultEnabled: false, patterns: [] });

const ALL_SOURCES = [...THREAT_SOURCES, OTHER_SOURCE];
const UNATTRIBUTED = THREAT_SOURCES.find((s) => s.id === 'unattributed');

function patternToRegExp(pattern) {
  const body = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'i');
}

const MATCHERS = THREAT_SOURCES.map((source) => ({ source, regexps: source.patterns.map(patternToRegExp) }));

// Source id for one verification_source label.
export function classifySource(label) {
  const text = label == null ? '' : String(label).trim();
  if (!text) return UNATTRIBUTED.id;
  for (const { source, regexps } of MATCHERS) {
    if (regexps.some((re) => re.test(text))) return source.id;
  }
  return OTHER_SOURCE.id;
}

function switchValue(raw, fallback) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

export function isSourceEnabled(id, env = process.env) {
  const source = ALL_SOURCES.find((s) => s.id === id);
  if (!source) return false;
  if (source.locked) return false;
  return switchValue(env[source.env], source.defaultEnabled);
}

export function isRowServable(row, env = process.env) {
  return isSourceEnabled(classifySource(row?.verification_source), env);
}

export function filterServableRows(rows, env = process.env) {
  return Array.isArray(rows) ? rows.filter((row) => isRowServable(row, env)) : [];
}

// PostgREST query parameters (already encoded, no leading '&') that drop
// switched-off sources before `limit` applies. When "other" labels are off
// (the default), this is an allowlist: a row must match an enabled source's
// pattern and none of the switched-off sources' patterns (which come first
// in THREAT_SOURCES, so they win the classification). When "other" is on, it
// is a denylist of the switched-off patterns. A NULL label never matches
// ilike, so unattributed rows always drop out here, as they must.
export function disabledSourceQueryParams(env = process.env) {
  const disabled = THREAT_SOURCES.filter((s) => !isSourceEnabled(s.id, env));
  const deny = disabled.flatMap((s) => s.patterns.map((p) => `verification_source.not.ilike.${p}`));
  let tree;
  if (isSourceEnabled(OTHER_SOURCE.id, env)) {
    tree = deny.length ? `and=(${deny.join(',')})` : null;
  } else {
    const allow = THREAT_SOURCES.filter((s) => isSourceEnabled(s.id, env)).flatMap((s) => s.patterns.map((p) => `verification_source.ilike.${p}`));
    // Nothing servable at all: a condition no row can meet.
    tree = allow.length
      ? `and=(or(${allow.join(',')})${deny.length ? `,${deny.join(',')}` : ''})`
      : 'and=(verification_source.is.null,verification_source.not.is.null)';
  }
  if (!tree) return [];
  const eq = tree.indexOf('=');
  return [`${tree.slice(0, eq)}=${encodeURIComponent(tree.slice(eq + 1))}`];
}

// The one read path for threat_ioc_telemetry. `filters` are the caller's own
// PostgREST params (select, order, limit, value=eq..., ...). Returns the
// fetch Response's status plus the servable rows; network and HTTP failures
// are returned, not thrown, so each caller keeps its own error handling.
export async function fetchThreatTelemetry(supUrl, supKey, filters, { fetchImpl = fetch, env = process.env } = {}) {
  const params = [...filters, ...disabledSourceQueryParams(env)];
  const res = await fetchImpl(`${supUrl}/rest/v1/threat_ioc_telemetry?${params.join('&')}`, {
    headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }
  });
  if (!res || !res.ok) return { ok: false, status: res ? res.status : null, rows: [] };
  return { ok: true, status: res.status, rows: filterServableRows(await res.json(), env) };
}
