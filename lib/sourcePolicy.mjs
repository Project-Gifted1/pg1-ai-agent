// Per-source serving switches for threat_ioc_telemetry.
//
// Every external read of threat_ioc_telemetry (the /api/ioc STIX bundle and
// its /api/feeds/ioc alias, the paid get_threat_indicators / get_ioc_context /
// get_ioc_batch MCP tools, GET /api/ioc/context, and through those the chat
// tools and the playground) goes through fetchThreatTelemetry() below, so this
// file is the one place that decides which upstream sources PG1 may serve.
//
// A row's source is read from its verification_source label (written by the
// sovereign-threat-pipeline repo). Each source has an environment switch:
//
//   SOURCE_ABUSECH_ENABLED        default OFF. abuse.ch ThreatFox / URLhaus
//                                 (now "Malware IoCs" / "Malware URLs") are
//                                 community data that may not be served in a
//                                 paid API without a commercial agreement.
//   SOURCE_UNATTRIBUTED_ENABLED   default OFF. Rows with no source label, and
//                                 rows from the old pipeline that labelled every
//                                 feed "Sovereign-Engine-v3.2-<malware family>",
//                                 so abuse.ch rows can't be told apart from
//                                 the rest.
//   SOURCE_OTX_ENABLED, SOURCE_NVD_ENABLED, SOURCE_BLOCKLIST_DE_ENABLED,
//   SOURCE_ABUSEIPDB_ENABLED, SOURCE_PG1_SWARM_ENABLED,
//   SOURCE_SCAMSNIFFER_ENABLED, SOURCE_OTHER_ENABLED
//                                 default ON; set to "false" to stop serving.
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
export const THREAT_SOURCES = Object.freeze([
  { id: 'abusech', env: 'SOURCE_ABUSECH_ENABLED', defaultEnabled: false, patterns: ['*abuse.ch*', '*abusech*', '*abuse_ch*', '*threatfox*', '*urlhaus*', '*malwarebazaar*', '*feodo*', '*sslbl*', '*yaraify*'] },
  { id: 'unattributed', env: 'SOURCE_UNATTRIBUTED_ENABLED', defaultEnabled: false, patterns: ['Sovereign-Engine-*'] },
  { id: 'otx', env: 'SOURCE_OTX_ENABLED', defaultEnabled: true, patterns: ['*alienvault*', '*otx*'] },
  { id: 'nvd', env: 'SOURCE_NVD_ENABLED', defaultEnabled: true, patterns: ['NVD*'] },
  { id: 'blocklist_de', env: 'SOURCE_BLOCKLIST_DE_ENABLED', defaultEnabled: true, patterns: ['*blocklist.de*'] },
  { id: 'abuseipdb', env: 'SOURCE_ABUSEIPDB_ENABLED', defaultEnabled: true, patterns: ['*abuseipdb*'] },
  { id: 'pg1_swarm', env: 'SOURCE_PG1_SWARM_ENABLED', defaultEnabled: true, patterns: ['PG1-Swarm-*'] },
  { id: 'scamsniffer', env: 'SOURCE_SCAMSNIFFER_ENABLED', defaultEnabled: true, patterns: ['*scamsniffer*'] }
]);

// Any other non-empty label (a source added later, a test label).
export const OTHER_SOURCE = Object.freeze({ id: 'other', env: 'SOURCE_OTHER_ENABLED', defaultEnabled: true, patterns: [] });

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
  return switchValue(env[source.env], source.defaultEnabled);
}

export function isRowServable(row, env = process.env) {
  return isSourceEnabled(classifySource(row?.verification_source), env);
}

export function filterServableRows(rows, env = process.env) {
  return Array.isArray(rows) ? rows.filter((row) => isRowServable(row, env)) : [];
}

// PostgREST query parameters (already encoded, no leading '&') that drop
// disabled sources before `limit` applies. Empty when every source is on.
// A disabled source whose rows aren't pattern-matched ("other") can't be
// expressed here; filterServableRows still removes those.
export function disabledSourceQueryParams(env = process.env) {
  const conditions = THREAT_SOURCES
    .filter((s) => !isSourceEnabled(s.id, env))
    .flatMap((s) => s.patterns.map((p) => `verification_source.not.ilike.${p}`));
  if (!conditions.length) return [];
  // not.ilike is never true for a NULL label, so NULL rows drop out here too,
  // which is right unless unattributed rows are switched on.
  const tree = isSourceEnabled(UNATTRIBUTED.id, env)
    ? `or=(verification_source.is.null,and(${conditions.join(',')}))`
    : `and=(${conditions.join(',')})`;
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
