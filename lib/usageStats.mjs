// Operator-only usage stats over the agent_telemetry table (written by
// lib/telemetry.mjs): "how many agents used our tools this week?".
//
// Reached only through the chat's get_usage_stats tool (operator role,
// lib/chatTools.mjs) and the /usage command (signed-in operator, api/chat.mjs)
// - never from /api/mcp, /api/a2a or /api/playground.
//
// Aggregates only. The table holds no raw IP and no queried value to begin
// with; the read selects just the columns the counts need, and what comes
// back is counts, the number of distinct caller hashes (never a hash
// itself), self-reported MCP client names and unknown tool names as callers
// sent them (both reduced before they were stored). Fixture calls
// (is_fixture) are left out by the query itself and again in
// aggregateUsage.
//
// The report (aggregateUsage) is organised for the /usage layout:
//   summary   real tool calls, distinct real callers (estimate), payment
//             requests, settled revenue
//   traffic   MCP requests (every JSON-RPC request to /api/mcp: initialize,
//             tools/list, tools/call, ...) and tool calls (every tool run on
//             any route), each split real vs probe; per route; per day with
//             spikes (> SPIKE_FACTOR x the period's median day) marked
//   tools     top tools by real calls, each free or paid
//   payments  the funnel for real callers: free checks used, callers who hit
//             the free limit, payment requests (402 challenges), payments
//             settled, revenue settled in USD
//   errors    by tool, by type, by caller class, by fault (caller / pg1 /
//             unclassified), a tool x type x class breakdown; unknown tool
//             calls counted apart (not errors) with the top names asked for
//   clients   top self-reported MCP clients: requests vs tool calls
//
// Own and test traffic (lib/ownTraffic.mjs): a caller with any caller_kind
// row, or whose hash is ours (PG1_OWN_CALLER_HASHES, PG1_OWN_IPS), is left
// out of every count below and reported apart (own_traffic). It is never
// real and never probe.
//
// Probe vs real: a caller is one salted IP hash. It is a probe when an MCP
// initialize from it named a crawler in config/usageProbes.mjs
// (known_crawler), when it called a tool by a checker's probe name
// (__verifymcp_auth_probe_*, __mcpcheckup_probe_*: probe_tool_name), when
// all it did in the period was probe-only methods and tools (initialize,
// tools/list, any method other than tools/call, get_usage_status, ...:
// probe_only_activity), or when, besides those, it only asked for tools we
// don't have (unknown_tools_only). Everything else is real. A row with no
// caller hash is judged on its own.
//
// Distinct callers is an estimate: it counts distinct salted hashes of the
// caller IP, and one agent can call from many addresses while many agents
// can share one. It is labelled as such everywhere it is shown.
//
// Failure: getUsageStats throws a UsageStatsUnavailableError (no detail,
// no partial numbers) when Supabase is missing, unreachable or answers
// with an error. Callers report it neutrally with a request_id.

import { getSupabaseCreds } from './supabase.mjs';
import { FREE_MCP_TOOLS, X402_PRICE, isFeedPaid, x402PriceUsd } from './x402Config.mjs';
import { PROBE_CLIENT_NAMES, PROBE_ONLY_TOOLS, PROBE_TOOL_NAME_PATTERNS } from '../config/usageProbes.mjs';
import { ownCallerHashes, isOwnHash, callerLabel } from './ownTraffic.mjs';

export const USAGE_PERIODS = Object.freeze(['24h', '7d', '30d']);
export const DEFAULT_USAGE_PERIOD = '7d';
export const USAGE_TOP = 5;
// A day is a spike when its requests are more than this many times the
// period's median day (a median under 1 counts as 1, so a quiet period
// does not mark every busy day).
export const SPIKE_FACTOR = 3;

// Paging for the PostgREST read: 1000 rows a page, at most 50 pages. A
// period with more rows than that is reported with truncated: true.
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const READ_TIMEOUT_MS = 8000;

// Statuses counted as errors. payment_required / free_limit_reached (an
// unpaid call answered with a payment challenge), rate_limited (counted on
// its own) and unknown_tool (a tool name we don't have: counted on its own
// with the names asked for, never as an error) are not. A notification
// (status 'ok', never answered) is never an error either.
export const ERROR_STATUSES = Object.freeze(['tool_error', 'client_error', 'server_error', 'settlement_failed', 'error', 'failed', 'method_not_found', 'parse_error', 'invalid_input', 'upstream_error']);

// Whose fault each error status is. caller: the request was wrong (bad
// arguments checked before any source was asked, bad method, not JSON).
// pg1: PG1 or a source it calls failed. A tool error (an isError result,
// status tool_error, or a source's error, upstream_error) is always PG1's
// or its source's, never the caller's (lib/telemetry.mjs
// toolErrorTelemetryStatus): rows written before the split are counted the
// same way.
export const ERROR_FAULT = Object.freeze({
  client_error: 'caller', invalid_input: 'caller', method_not_found: 'caller', parse_error: 'caller',
  server_error: 'pg1', upstream_error: 'pg1', settlement_failed: 'pg1', error: 'pg1', failed: 'pg1',
  tool_error: 'pg1'
});
export const PAYMENT_CHALLENGE_STATUSES = Object.freeze(['payment_required', 'free_limit_reached']);

// Tools that are never charged for. Every other tool PG1 records (the paid
// MCP tools, get_ioc_context / get_ioc_batch when a record is found, and
// the /api/ioc STIX feed) is paid.
const FREE_TOOLS = new Set(FREE_MCP_TOOLS);
// The STIX feed (MCP tool and the /api/ioc row), free while PG1_FEED_PAID is off.
const FEED_TOOLS = ['get_threat_indicators', 'ioc_feed'];

export class UsageStatsUnavailableError extends Error {
  constructor() {
    super('Usage stats could not be read.');
    this.usageStatsUnavailable = true;
  }
}

// '24h', '7d' (default) or '30d'. 'today' and '1d' are taken as '24h'.
export function normalizeUsagePeriod(period) {
  const p = typeof period === 'string' ? period.trim().toLowerCase() : '';
  if (p === 'today' || p === '1d' || p === 'day') return '24h';
  return USAGE_PERIODS.includes(p) ? p : DEFAULT_USAGE_PERIOD;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Days are Ireland days (Europe/Dublin, the operator's clock), so the
// per-day list and the period's start match the dates the card shows.
export const USAGE_TIME_ZONE = 'Europe/Dublin';
const dublinParts = new Intl.DateTimeFormat('en-GB', { timeZone: USAGE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function wallClock(ms) {
  const p = Object.fromEntries(dublinParts.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month - 1, d: p.day, ms: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) };
}
const dayOf = (ms) => { const w = wallClock(ms); return new Date(Date.UTC(w.y, w.m, w.d)).toISOString().slice(0, 10); };
// The instant an Ireland calendar day (y, m, d) starts.
function dublinMidnight(y, m, d) {
  const guess = Date.UTC(y, m, d);
  let t = guess - (wallClock(guess).ms - guess);
  t -= wallClock(t).ms - Date.UTC(y, m, d);
  return t;
}

// The window for a period, in Ireland time: '24h' is the last 24 hours
// (two calendar days in the per-day list); '7d' and '30d' run from midnight
// 6 and 29 days ago, so the per-day list has 7 or 30 days.
export function usagePeriodRange(period, now = Date.now()) {
  const p = normalizeUsagePeriod(period);
  const today = wallClock(now);
  const fromMs = p === '24h' ? now - DAY_MS : dublinMidnight(today.y, today.m, today.d - ((p === '7d' ? 7 : 30) - 1));
  const first = wallClock(fromMs);
  const days = [];
  for (let i = 0; ; i++) {
    const day = new Date(Date.UTC(first.y, first.m, first.d + i)).toISOString().slice(0, 10);
    days.push(day);
    if (day >= dayOf(now)) break;
  }
  return { period: p, days, from: new Date(fromMs).toISOString(), to: new Date(now).toISOString() };
}

function countBy(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

function sortedCounts(map, keyName, valueName) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([k, v]) => ({ [keyName]: k, [valueName]: v }));
}

export function median(values) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Per-day totals with spikes marked. `days` is [{ day, real, probe }].
export function markSpikes(days, factor = SPIKE_FACTOR) {
  const totals = days.map((d) => d.real + d.probe);
  const med = median(totals);
  const threshold = factor * Math.max(med, 1);
  return {
    median: med,
    threshold,
    days: days.map((d, i) => ({ ...d, total: totals[i], spike: totals[i] > threshold }))
  };
}

// Lower-case words only: "Glama/1.2" -> "glama 1 2".
function words(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const PROBE_NAME_WORDS = PROBE_CLIENT_NAMES.map(words).filter(Boolean);

// True when a self-reported client name is a known probe (config/usageProbes.mjs).
export function isProbeClientName(name, probeNames = PROBE_NAME_WORDS) {
  const w = words(name);
  if (!w) return false;
  const padded = ` ${w} `;
  return probeNames.some((p) => padded.includes(` ${p} `));
}

// True when a tool name (requested or recorded) is a checker's probe name.
export function isProbeToolName(name, patterns = PROBE_TOOL_NAME_PATTERNS) {
  return typeof name === 'string' && name !== '' && patterns.some((re) => re.test(name));
}

function isMcpRequestRow(row) {
  return row.endpoint === '/api/mcp' && (row.event_type === 'initialize' || row.event_type === 'mcp_request' || row.event_type === 'tool_call');
}

// What a row did, for the probe-only test: an MCP method, or a tool. A
// call to a tool we don't have is probe activity too: scanners try names
// (admin tools, other servers' tools) and never use a real one.
function isProbeOnlyActivity(row) {
  if (row.event_type === 'initialize') return true;
  // Every mcp_request row is listing, a notification, a ping or a method we
  // don't serve: tools actually called are tool_call rows.
  if (row.event_type === 'mcp_request') return true;
  if (row.event_type === 'tool_call') return row.status === 'unknown_tool' || PROBE_ONLY_TOOLS.includes(row.tool_name);
  return true; // settlements follow a tool call and say nothing on their own
}

// The reasons a caller is a probe, in the order they are tested.
export const PROBE_REASONS = Object.freeze(['known_crawler', 'probe_tool_name', 'unknown_tools_only', 'probe_only_activity']);

// Classifies every caller in `rows` as 'probe' or 'real'. Returns
// { classOf(row), reasonOf(row), clientOf(row) }: clientOf is the caller's
// most-used self-reported MCP client name (null when it never sent one).
export function classifyCallers(rows) {
  const groups = new Map();
  const keyOf = new Map();
  rows.forEach((row, i) => {
    const key = typeof row.caller_hash === 'string' && row.caller_hash ? `h:${row.caller_hash}` : `r:${i}`;
    keyOf.set(row, key);
    let g = groups.get(key);
    if (!g) { g = { names: new Map(), probeName: false, probeTool: false, onlyProbeActivity: true, unknownTool: false }; groups.set(key, g); }
    if (row.event_type === 'tool_call' && row.status === 'unknown_tool') g.unknownTool = true;
    if (row.event_type === 'tool_call' && (isProbeToolName(row.requested_tool) || isProbeToolName(row.tool_name))) g.probeTool = true;
    if (row.event_type === 'initialize') {
      countBy(g.names, row.client_name || '(not given)');
      if (isProbeClientName(row.client_name)) g.probeName = true;
    }
    if (!isProbeOnlyActivity(row)) g.onlyProbeActivity = false;
  });
  for (const g of groups.values()) {
    g.cls = g.probeName || g.probeTool || g.onlyProbeActivity ? 'probe' : 'real';
    g.reason = g.probeName ? 'known_crawler' : g.probeTool ? 'probe_tool_name' : !g.onlyProbeActivity ? 'real' : g.unknownTool ? 'unknown_tools_only' : 'probe_only_activity';
    g.client = g.names.size ? sortedCounts(g.names, 'name', 'n')[0].name : null;
  }
  const groupOf = (row) => groups.get(keyOf.get(row));
  return {
    classOf: (row) => groupOf(row).cls,
    reasonOf: (row) => groupOf(row).reason,
    clientOf: (row) => groupOf(row).client,
    groups
  };
}

const split = () => ({ total: 0, real: 0, probe: 0 });
const bump = (s, cls) => { s.total++; s[cls]++; };
const round2 = (n) => Math.round(n * 100) / 100;

// Pure aggregation over agent_telemetry rows. Exported for tests. Rows with
// is_fixture true are skipped here too, whatever the query returned.
export function aggregateUsage(rows, { period = DEFAULT_USAGE_PERIOD, now = Date.now(), ownHashes = ownCallerHashes() } = {}) {
  const range = usagePeriodRange(period, now);
  const fromMs = Date.parse(range.from);
  const inPeriod = (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row || row.is_fixture === true) return false;
    const created = Date.parse(row.created_at);
    return Number.isFinite(created) && created >= fromMs && created <= now;
  });
  // Own and test traffic out first: a caller is ours when any of its rows
  // says so or its hash is ours.
  const ownKeys = new Set();
  for (const row of inPeriod) {
    const h = typeof row.caller_hash === 'string' && row.caller_hash ? row.caller_hash : null;
    if (h && (row.caller_kind || isOwnHash(h, ownHashes))) ownKeys.add(h);
  }
  const isOwnRow = (row) => !!row.caller_kind || (typeof row.caller_hash === 'string' && ownKeys.has(row.caller_hash));
  const own = ownTrafficSummary(inPeriod.filter(isOwnRow), range.days);
  const kept = inPeriod.filter((row) => !isOwnRow(row));
  const { classOf, clientOf, groups } = classifyCallers(kept);
  const callerKeyOf = (row) => (typeof row.caller_hash === 'string' && row.caller_hash ? row.caller_hash : null);
  // Per day, per caller (for the busiest day and spike days).
  const dayCallers = new Map(range.days.map((d) => [d, new Map()]));
  // get_usage_status calls by real callers: caller -> call times.
  const statusPolls = new Map();
  // Payment challenges (402s) by real callers, per tool.
  const challengesByTool = new Map();
  // MCP methods answered "method not found", per method.
  const methodsNotFound = new Map();

  const mcpRequests = split();
  const toolCalls = split();
  const perRoute = new Map();
  const perDay = new Map(range.days.map((d) => [d, { day: d, real: 0, probe: 0 }]));
  const toolCounts = new Map();
  const realCallers = new Set();
  const probeCallers = new Set();
  const clients = new Map();
  const errorsByTool = new Map();
  const errorsByType = new Map();
  const errorsByClass = { real: 0, probe: 0 };
  const unrecognised = new Map();
  const unknownToolCalls = { total: 0, real: 0, probe: 0 };
  const errorsByFault = { caller: 0, pg1: 0, unclassified: 0 };
  const errorMatrix = new Map();
  const freeTierByRoute = new Map();
  // Real tool calls served, by how they were paid for: free (an always-free
  // tool, a fixture-free found:false lookup), free_tier, paid (x402 or
  // licence). And for get_ioc_context / get_ioc_batch, how many lookups
  // found something: those are free only when nothing is found, so a found
  // lookup is one that went to the payment gate (served paid or free-tier,
  // or answered with a payment challenge).
  const servedBy = { free: 0, free_tier: 0, paid: 0 };
  const iocLookups = { total: 0, found: 0 };
  const challengedCallers = new Set();
  const convertedCallers = new Set();
  const funnel = {
    free_checks_used: 0, free_tool_calls: 0, free_tier_calls: 0,
    callers_hit_free_limit: 0, free_limit_responses: 0,
    payment_requests: 0, payments_settled: 0, settlement_failures: 0,
    revenue_usd: 0, ioc_feed_x402_calls: 0
  };
  const freeLimitCallers = new Set();
  let rateLimited = 0;
  const fallbackPrice = x402PriceUsd(X402_PRICE);

  for (const row of kept) {
    const cls = classOf(row);
    const hash = typeof row.caller_hash === 'string' && row.caller_hash ? row.caller_hash : null;

    if (row.event_type === 'settlement') {
      if (cls !== 'real') continue;
      if (row.status === 'settled') {
        funnel.payments_settled++;
        const amount = Number(row.amount_usd);
        funnel.revenue_usd += row.amount_usd != null && Number.isFinite(amount) && amount >= 0 ? amount : fallbackPrice;
      } else {
        funnel.settlement_failures++;
      }
      continue;
    }

    const isRequest = isMcpRequestRow(row);
    const isToolCall = row.event_type === 'tool_call';
    if (!isRequest && !isToolCall) continue;

    if (hash) (cls === 'real' ? realCallers : probeCallers).add(hash);
    if (isRequest) bump(mcpRequests, cls);
    if (isToolCall) bump(toolCalls, cls);

    const route = row.endpoint || 'unknown';
    if (!perRoute.has(route)) perRoute.set(route, { route, requests: 0, tool_calls: 0, real: 0, probe: 0 });
    const r = perRoute.get(route);
    r.requests++;
    r[cls]++;
    if (isToolCall) r.tool_calls++;

    const dayKey = dayOf(Date.parse(row.created_at));
    const day = perDay.get(dayKey);
    if (day) day[cls]++;
    const dc = dayCallers.get(dayKey);
    if (dc) {
      const key = callerKeyOf(row) || '(no hash)';
      if (!dc.has(key)) dc.set(key, { hash: callerKeyOf(row), requests: 0, tool_calls: 0, class: cls, client: clientOf(row), what: new Map() });
      const c = dc.get(key);
      c.requests++;
      if (isToolCall) c.tool_calls++;
      countBy(c.what, isToolCall ? (row.tool_name || (row.requested_tool ? `unknown:${row.requested_tool}` : '(unknown tool)')) : row.event_type === 'initialize' ? 'initialize' : (row.mcp_method || 'other'));
    }

    const client = clientOf(row);
    if (client && row.endpoint === '/api/mcp') {
      if (!clients.has(client)) clients.set(client, { name: client, requests: 0, tool_calls: 0, class: cls });
      const c = clients.get(client);
      c.requests++;
      if (isToolCall) c.tool_calls++;
    }

    const status = row.status || 'unknown';
    if (status === 'unknown_tool') {
      bump(unknownToolCalls, cls);
      countBy(unrecognised, row.requested_tool || '(not recorded)');
    } else if (ERROR_STATUSES.includes(status)) {
      if (status === 'method_not_found' && row.event_type === 'mcp_request') {
        const m = row.mcp_method || 'other';
        if (!methodsNotFound.has(m)) methodsNotFound.set(m, { method: m, total: 0, real: 0, probe: 0 });
        bump(methodsNotFound.get(m), cls);
      }
      const tool = isToolCall ? row.tool_name || '(unrecognised)' : `(${row.mcp_method || 'other'})`;
      const fault = ERROR_FAULT[status] || 'unclassified';
      countBy(errorsByTool, tool);
      countBy(errorsByType, status);
      errorsByClass[cls]++;
      errorsByFault[fault]++;
      const cellKey = `${tool}\u0000${status}`;
      if (!errorMatrix.has(cellKey)) errorMatrix.set(cellKey, { tool, type: status, fault, route: row.endpoint || 'unknown', errors: 0, real: 0, probe: 0 });
      const cell = errorMatrix.get(cellKey);
      cell.errors++;
      cell[cls]++;
    }

    if (!isToolCall) continue;
    if (status === 'rate_limited' && cls === 'real') rateLimited++;
    if (cls !== 'real') continue;

    countBy(toolCounts, row.tool_name || '(unrecognised)');
    if (row.tool_name === 'get_usage_status') {
      const key = hash || '(no hash)';
      if (!statusPolls.has(key)) statusPolls.set(key, { hash, times: [] });
      statusPolls.get(key).times.push(Date.parse(row.created_at));
    }
    if (PAYMENT_CHALLENGE_STATUSES.includes(status)) {
      const tool = row.endpoint === '/api/ioc' ? 'ioc_feed' : (row.tool_name || '(unrecognised)');
      if (!challengesByTool.has(tool)) challengesByTool.set(tool, { tool, requests: 0, callers: new Set(), route: row.endpoint || 'unknown' });
      const t = challengesByTool.get(tool);
      t.requests++;
      if (hash) t.callers.add(hash);
    }
    if (status === 'ok') {
      if (row.payment_type === 'free') servedBy.free++;
      else if (row.payment_type === 'free_tier') servedBy.free_tier++;
      else if (row.payment_type === 'x402' || row.payment_type === 'license') servedBy.paid++;
    }
    if (row.tool_name === 'get_ioc_context' || row.tool_name === 'get_ioc_batch') {
      const found = (status === 'ok' && row.payment_type !== 'free') || PAYMENT_CHALLENGE_STATUSES.includes(status);
      if (status === 'ok' || PAYMENT_CHALLENGE_STATUSES.includes(status)) {
        iocLookups.total++;
        if (found) iocLookups.found++;
      }
    }
    if (status === 'ok' && row.payment_type === 'free') { funnel.free_tool_calls++; funnel.free_checks_used++; }
    if (status === 'ok' && row.payment_type === 'free_tier') { funnel.free_tier_calls++; funnel.free_checks_used++; countBy(freeTierByRoute, row.endpoint || 'unknown'); }
    if (status === 'ok' && ['free_tier', 'x402', 'license'].includes(row.payment_type) && hash) convertedCallers.add(hash);
    if (PAYMENT_CHALLENGE_STATUSES.includes(status) && hash) challengedCallers.add(hash);
    if (status === 'ok' && row.payment_type === 'x402' && row.endpoint === '/api/ioc') funnel.ioc_feed_x402_calls++;
    if (PAYMENT_CHALLENGE_STATUSES.includes(status)) funnel.payment_requests++;
    if (status === 'free_limit_reached') {
      funnel.free_limit_responses++;
      freeLimitCallers.add(hash || `row:${funnel.free_limit_responses}`);
    }
  }
  funnel.callers_hit_free_limit = freeLimitCallers.size;
  funnel.free_tier_calls_by_route = sortedCounts(freeTierByRoute, 'route', 'calls');
  // Real callers shown a payment challenge who never completed a paid,
  // licensed or free-tier call in the period: the funnel's drop-off.
  funnel.callers_challenged_never_served = [...challengedCallers].filter((h) => !convertedCallers.has(h)).length;
  funnel.revenue_usd = round2(funnel.revenue_usd);

  funnel.payment_requests_by_tool = [...challengesByTool.values()]
    .map((t) => ({ tool: t.tool, route: t.route, requests: t.requests, callers: t.callers.size }))
    .sort((a, b) => b.requests - a.requests || a.tool.localeCompare(b.tool));
  funnel.payment_requests_callers = new Set([...challengesByTool.values()].flatMap((t) => [...t.callers])).size;

  const spikes = markSpikes([...perDay.values()]);
  const topCallersOn = (d) => [...(dayCallers.get(d) || new Map()).values()]
    .sort((a, b) => b.requests - a.requests || String(a.hash).localeCompare(String(b.hash)))
    .slice(0, USAGE_TOP)
    .map((c) => ({ caller: callerLabel(c.hash), requests: c.requests, tool_calls: c.tool_calls, class: c.class, client: c.client, top: sortedCounts(c.what, 'name', 'count').slice(0, 3) }));
  const busiest = spikes.days.reduce((best, d) => (d.real > (best ? best.real : -1) ? d : best), null);
  const dayDetail = (d) => ({ day: d.day, real: d.real, probe: d.probe, total: d.total, spike: d.spike, callers: topCallersOn(d.day) });
  const focusDays = spikes.days.filter((d) => d.spike || (busiest && d.day === busiest.day && d.real > 0));
  const realToolCalls = toolCalls.real;
  const errorsTotal = errorsByClass.real + errorsByClass.probe;
  const probeReasons = Object.fromEntries(PROBE_REASONS.map((r) => [r, 0]));
  for (const [key, g] of groups) if (key.startsWith('h:') && g.cls === 'probe') probeReasons[g.reason]++;

  return {
    period: range.period,
    from: range.from,
    to: range.to,
    summary: {
      real_tool_calls: toolCalls.real,
      distinct_real_callers_estimate: realCallers.size,
      payment_requests: funnel.payment_requests,
      settled_revenue_usd: funnel.revenue_usd
    },
    traffic: {
      mcp_requests: mcpRequests,
      mcp_requests_note: 'Every JSON-RPC request to /api/mcp: initialize, tools/list, tools/call and any other method. Not the same as tool calls.',
      tool_calls: toolCalls,
      tool_calls_note: 'Tools actually run, on every route (/api/mcp tools/call, /api/a2a, /api/ioc, /api/playground).',
      distinct_callers_estimate: { real: realCallers.size, probe: probeCallers.size },
      probe_callers_by_reason: probeReasons,
      by_route: [...perRoute.values()].sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route)),
      per_day: spikes.days,
      busiest_day: busiest && busiest.real > 0 ? busiest.day : null,
      day_callers: focusDays.map(dayDetail),
      day_callers_note: 'The busiest real day and every spike day, with the callers behind them (short salted-hash labels, never an IP), their class and what they called. Own and test traffic is already left out.',
      per_day_median: spikes.median,
      spike_threshold: spikes.threshold,
      spike_rule: `A day is a spike when its requests (real + probe) are more than ${SPIKE_FACTOR}x the period's median day.`
    },
    tools: sortedCounts(toolCounts, 'tool', 'calls').slice(0, USAGE_TOP).map((t) => ({ ...t, pricing: FREE_TOOLS.has(t.tool) || (FEED_TOOLS.includes(t.tool) && !isFeedPaid()) ? 'free' : 'paid' })),
    usage_status_polling: usageStatusPolling(statusPolls, realToolCalls),
    usage_status_polling_note: `get_usage_status calls by real callers, per caller. A caller is polling in a loop when it made at least ${POLL_LOOP_MIN_CALLS} calls with a median gap of ${POLL_LOOP_MAX_MEDIAN_GAP_S / 60} minutes or less.`,
    served_by: servedBy,
    served_by_note: 'Real tool calls served (status ok), by how they were paid for: free (always-free tools and found:false lookups), free_tier (the 5/day), paid (x402 or licence).',
    ioc_lookups: iocLookups,
    ioc_lookups_note: 'get_ioc_context / get_ioc_batch calls by real callers that were answered (served or challenged); found = something was on record.',
    payments: funnel,
    payments_note: 'Real callers only. Revenue is x402 settlements confirmed on /api/mcp and /api/a2a; /api/ioc x402 calls are settled by the payment middleware and counted separately; licence-key sales are not included. The free tier is one 5/day counter per caller shared by /api/mcp, /api/ioc and /api/a2a.',
    errors: {
      total: errorsTotal,
      by_tool: sortedCounts(errorsByTool, 'tool', 'errors'),
      by_type: sortedCounts(errorsByType, 'type', 'errors'),
      by_class: errorsByClass,
      by_fault: errorsByFault,
      by_fault_note: 'caller: the request was wrong (bad input, unknown method, not JSON). pg1: PG1 or a data source it calls failed. unclassified: tool_error rows recorded before errors were split, which can be either.',
      breakdown: [...errorMatrix.values()].sort((a, b) => b.errors - a.errors || a.tool.localeCompare(b.tool) || a.type.localeCompare(b.type)),
      unknown_tool_calls: unknownToolCalls,
      unknown_tool_calls_note: 'Calls naming a tool this server does not have. Caller mistakes, not counted as errors; a caller that only did this (and listing) is a probe.',
      unrecognised_tools: sortedCounts(unrecognised, 'name', 'count').slice(0, USAGE_TOP),
      methods_not_found: [...methodsNotFound.values()].sort((a, b) => b.total - a.total || a.method.localeCompare(b.method)),
      methods_not_found_note: 'JSON-RPC methods this server does not serve, as callers sent them (reduced before storage). Rows recorded before method names were kept show as other.',
      unrecognised_tools_note: 'Tool names exactly as callers requested them (reduced before storage: no addresses or long tokens); untrusted text.',
      rate_limited: rateLimited
    },
    clients: [...clients.values()].sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name)).slice(0, USAGE_TOP),
    clients_note: 'Self-reported MCP clientInfo names, sanitised; untrusted text. Requests and tool calls are attributed to a client by hashed IP, so they are estimates.',
    distinct_callers_note: 'An estimate: distinct salted hashes of caller IP addresses. One agent can use several addresses and several agents can share one, so this is not an exact count of agents.',
    own_traffic: own,
    own_traffic_note: 'Our own and test traffic (previews, our checkers and scripts, partner integration checks, PG1_OWN_IPS / PG1_OWN_CALLER_HASHES): left out of every count above.',
    fixtures_excluded: true
  };
}

// get_usage_status polling: per real caller, calls and the median gap
// between them; looping when POLL_LOOP_MIN_CALLS or more calls came at a
// median gap of POLL_LOOP_MAX_MEDIAN_GAP_S or less.
export const POLL_LOOP_MIN_CALLS = 10;
export const POLL_LOOP_MAX_MEDIAN_GAP_S = 300;

function usageStatusPolling(polls, realToolCalls) {
  const callers = [...polls.values()].map((p) => {
    const t = p.times.filter(Number.isFinite).sort((a, b) => a - b);
    const gaps = t.slice(1).map((x, i) => (x - t[i]) / 1000);
    const gap = gaps.length ? Math.round(median(gaps)) : null;
    return {
      caller: callerLabel(p.hash),
      calls: t.length,
      share_of_real_calls: realToolCalls ? Math.round((t.length / realToolCalls) * 1000) / 10 : 0,
      median_gap_s: gap,
      first: t.length ? new Date(t[0]).toISOString() : null,
      last: t.length ? new Date(t[t.length - 1]).toISOString() : null,
      looping: t.length >= POLL_LOOP_MIN_CALLS && gap != null && gap <= POLL_LOOP_MAX_MEDIAN_GAP_S
    };
  }).sort((a, b) => b.calls - a.calls || a.caller.localeCompare(b.caller));
  const total = callers.reduce((n, c) => n + c.calls, 0);
  return { total, callers: callers.slice(0, USAGE_TOP), callers_count: callers.length, looping: callers.filter((c) => c.looping).map((c) => c.caller) };
}

// Own and test traffic, counted apart.
function ownTrafficSummary(rows, days) {
  const callers = new Set();
  const byKind = { internal: 0, test: 0, listed: 0 };
  const perDay = new Map(days.map((d) => [d, 0]));
  let requests = 0;
  let toolCalls = 0;
  for (const row of rows) {
    if (row.event_type === 'settlement') continue;
    const isToolCall = row.event_type === 'tool_call';
    if (!isToolCall && !isMcpRequestRow(row)) continue;
    requests++;
    if (isToolCall) toolCalls++;
    if (row.caller_hash) callers.add(row.caller_hash);
    byKind[row.caller_kind === 'internal' || row.caller_kind === 'test' ? row.caller_kind : 'listed']++;
    const d = dayOf(Date.parse(row.created_at));
    if (perDay.has(d)) perDay.set(d, perDay.get(d) + 1);
  }
  return { requests, tool_calls: toolCalls, callers: callers.size, by_kind: byKind, per_day: [...perDay.entries()].map(([day, n]) => ({ day, requests: n })) };
}

const SELECT_COLUMNS = 'created_at,event_type,endpoint,tool_name,payment_type,status,client_name,caller_hash,is_fixture,mcp_method,requested_tool,amount_usd,caller_kind';
// Before the 20261101120000 migration there is no caller_kind column.
const PRE_CALLER_KIND_COLUMNS = 'created_at,event_type,endpoint,tool_name,payment_type,status,client_name,caller_hash,is_fixture,mcp_method,requested_tool,amount_usd';
// Before the 20261015120000 migration the table has no mcp_method,
// requested_tool or amount_usd: the read falls back to these columns, and
// the report says so (schema: 'legacy').
const LEGACY_SELECT_COLUMNS = 'created_at,event_type,endpoint,tool_name,payment_type,status,client_name,caller_hash,is_fixture';

class SchemaMismatch extends Error {}

async function fetchPage(fetchImpl, url, headers, offset) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), READ_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { ...headers, 'Range-Unit': 'items', Range: `${offset}-${offset + PAGE_SIZE - 1}` },
      signal: controller ? controller.signal : undefined
    });
    if (res && res.status === 400 && offset === 0) throw new SchemaMismatch();
    if (!res || !res.ok) throw new UsageStatsUnavailableError();
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new UsageStatsUnavailableError();
    return rows;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readAll(fetchImpl, url, headers) {
  const rows = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await fetchPage(fetchImpl, url, headers, page * PAGE_SIZE);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { rows, truncated };
}

// getUsageStats({ period, now, fetchImpl }) -> the report (see
// aggregateUsage) plus generated_at, truncated and schema. Throws
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
  const urlFor = (columns) => `${creds.supUrl}/rest/v1/agent_telemetry?select=${columns}&is_fixture=eq.false&created_at=gte.${encodeURIComponent(range.from)}&order=created_at.asc,id.asc`;

  let read;
  let schema = 'current';
  try {
    for (const [columns, name] of [[SELECT_COLUMNS, 'current'], [PRE_CALLER_KIND_COLUMNS, 'no_caller_kind'], [LEGACY_SELECT_COLUMNS, 'legacy']]) {
      try {
        read = await readAll(fetchImpl, urlFor(columns), headers);
        schema = name;
        break;
      } catch (err) {
        if (!(err instanceof SchemaMismatch) || name === 'legacy') throw err;
      }
    }
  } catch {
    throw new UsageStatsUnavailableError();
  }

  return { ...aggregateUsage(read.rows, { period: range.period, now }), truncated: read.truncated, schema, generated_at: new Date(now).toISOString() };
}

// The wording PG1 uses for distinct callers: always an estimate.
export function distinctCallersText(n) {
  const count = Number.isFinite(n) ? n : 0;
  return `about ${count} distinct caller${count === 1 ? '' : 's'} (estimated from hashed IP addresses)`;
}

const PERIOD_WORDS = Object.freeze({ '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days' });

export function usagePeriodText(period) {
  return PERIOD_WORDS[normalizeUsagePeriod(period)];
}

export function usdText(n) {
  const v = Number.isFinite(n) ? n : 0;
  return `${v.toFixed(2)} USD`;
}
