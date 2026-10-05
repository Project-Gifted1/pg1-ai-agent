// Operator-only usage stats over the agent_telemetry table (written by
// lib/telemetry.mjs): "how many agents used our tools this week?".
//
// Reached only through the chat's get_usage_stats tool (operator role,
// lib/chatTools.mjs) and the /usage command (signed-in operator, api/chat.mjs)
// - never from /api/mcp, /api/a2a or /api/playground.
//
// Aggregates only. The table holds no raw IP and no queried value to begin
// with; the read selects just the columns the counts need, and what comes
// back is counts per tool, route and day, the number of distinct caller
// hashes (never a hash itself), top MCP client names with counts, and
// error / rate-limited / paid-settlement counts. Fixture calls (is_fixture)
// are left out by the query itself and again in aggregateUsage.
//
// Distinct callers is an estimate: it counts distinct salted hashes of the
// caller IP, and one agent can call from many addresses while many agents
// can share one. It is labelled as such everywhere it is shown.
//
// Failure: getUsageStats throws a UsageStatsUnavailableError (no detail,
// no partial numbers) when Supabase is missing, unreachable or answers
// with an error. Callers report it neutrally with a request_id.

import { getSupabaseCreds } from './supabase.mjs';

export const USAGE_PERIODS = Object.freeze(['today', '7d', '30d']);
export const DEFAULT_USAGE_PERIOD = '7d';
export const USAGE_TOP_CLIENTS = 10;

// Paging for the PostgREST read: 1000 rows a page, at most 50 pages. A
// period with more rows than that is reported with truncated: true.
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const READ_TIMEOUT_MS = 8000;

// Statuses counted as errors. payment_required (an unpaid call answered
// with a payment challenge) and rate_limited (counted on its own) are not.
export const ERROR_STATUSES = Object.freeze(['tool_error', 'client_error', 'server_error', 'settlement_failed', 'unknown_tool', 'error', 'failed']);

export class UsageStatsUnavailableError extends Error {
  constructor() {
    super('Usage stats could not be read.');
    this.usageStatsUnavailable = true;
  }
}

export function normalizeUsagePeriod(period) {
  const p = typeof period === 'string' ? period.trim().toLowerCase() : '';
  return USAGE_PERIODS.includes(p) ? p : DEFAULT_USAGE_PERIOD;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The window for a period, in UTC: 'today' from midnight, '7d' and '30d'
// from midnight 6 and 29 days ago (so the per-day list has 7 or 30 days).
export function usagePeriodRange(period, now = Date.now()) {
  const p = normalizeUsagePeriod(period);
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = p === 'today' ? 1 : p === '7d' ? 7 : 30;
  return { period: p, days, from: new Date(midnight - (days - 1) * DAY_MS).toISOString(), to: new Date(now).toISOString() };
}

function countBy(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sortedCounts(map, keyName, valueName) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([k, v]) => ({ [keyName]: k, [valueName]: v }));
}

// Pure aggregation over agent_telemetry rows. Exported for tests. Rows with
// is_fixture true are skipped here too, whatever the query returned.
export function aggregateUsage(rows, { period = DEFAULT_USAGE_PERIOD, now = Date.now() } = {}) {
  const range = usagePeriodRange(period, now);
  const perTool = new Map();
  const perRoute = new Map();
  const perDay = new Map();
  const clients = new Map();
  const callers = new Set();
  let calls = 0;
  let errors = 0;
  let rateLimited = 0;
  let paidSettlements = 0;
  let initializes = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.is_fixture === true) continue;
    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created) || created < Date.parse(range.from)) continue;

    if (row.event_type === 'settlement') {
      if (row.status === 'settled') paidSettlements++;
      continue;
    }
    if (row.event_type === 'initialize') {
      initializes++;
      countBy(clients, row.client_name || '(not given)');
      continue;
    }
    if (row.event_type !== 'tool_call') continue;

    calls++;
    if (typeof row.caller_hash === 'string' && row.caller_hash) callers.add(row.caller_hash);
    countBy(perTool, row.tool_name || '(unrecognised)');
    countBy(perRoute, row.endpoint || 'unknown');
    countBy(perDay, new Date(created).toISOString().slice(0, 10));
    if (row.status === 'rate_limited') rateLimited++;
    else if (ERROR_STATUSES.includes(row.status)) errors++;
  }

  const days = [];
  for (let i = 0; i < range.days; i++) {
    const day = new Date(Date.parse(range.from) + i * DAY_MS).toISOString().slice(0, 10);
    days.push({ day, calls: perDay.get(day) || 0 });
  }

  return {
    period: range.period,
    from: range.from,
    to: range.to,
    total_calls: calls,
    calls_per_tool: sortedCounts(perTool, 'tool', 'calls'),
    calls_per_route: sortedCounts(perRoute, 'route', 'calls'),
    calls_per_day: days,
    distinct_callers_estimate: callers.size,
    distinct_callers_note: 'An estimate: distinct salted hashes of caller IP addresses. One agent can use several addresses and several agents can share one, so this is not an exact count of agents.',
    mcp_initializations: initializes,
    top_clients: sortedCounts(clients, 'name', 'count').slice(0, USAGE_TOP_CLIENTS),
    top_clients_note: 'Self-reported MCP clientInfo names from initialize handshakes, sanitised; untrusted text.',
    errors,
    rate_limited: rateLimited,
    paid_settlements: paidSettlements,
    fixtures_excluded: true
  };
}

const SELECT_COLUMNS = 'created_at,event_type,endpoint,tool_name,status,client_name,caller_hash,is_fixture';

async function fetchPage(fetchImpl, url, headers, offset) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), READ_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { ...headers, 'Range-Unit': 'items', Range: `${offset}-${offset + PAGE_SIZE - 1}` },
      signal: controller ? controller.signal : undefined
    });
    if (!res || !res.ok) throw new UsageStatsUnavailableError();
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new UsageStatsUnavailableError();
    return rows;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// getUsageStats({ period, now, fetchImpl }) -> aggregates (see
// aggregateUsage) plus generated_at and truncated. Throws
// UsageStatsUnavailableError on any failure - never partial numbers.
export async function getUsageStats({ period, now = Date.now(), fetchImpl = fetch } = {}) {
  const range = usagePeriodRange(period, now);
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch {
    throw new UsageStatsUnavailableError();
  }
  const headers = { apikey: creds.supKey, Authorization: `Bearer ${creds.supKey}`, Accept: 'application/json' };
  const url = `${creds.supUrl}/rest/v1/agent_telemetry?select=${SELECT_COLUMNS}&is_fixture=eq.false&created_at=gte.${encodeURIComponent(range.from)}&order=created_at.asc,id.asc`;

  const rows = [];
  let truncated = false;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await fetchPage(fetchImpl, url, headers, page * PAGE_SIZE);
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }
  } catch {
    throw new UsageStatsUnavailableError();
  }

  return { ...aggregateUsage(rows, { period: range.period, now }), truncated, generated_at: new Date(now).toISOString() };
}

// The wording PG1 uses for distinct callers: always an estimate.
export function distinctCallersText(n) {
  const count = Number.isFinite(n) ? n : 0;
  return `about ${count} distinct caller${count === 1 ? '' : 's'} (estimated from hashed IP addresses)`;
}

const PERIOD_WORDS = Object.freeze({ today: 'today (UTC)', '7d': 'the last 7 days', '30d': 'the last 30 days' });

export function usagePeriodText(period) {
  return PERIOD_WORDS[normalizeUsagePeriod(period)];
}
