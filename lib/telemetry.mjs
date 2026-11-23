// Lightweight usage telemetry, written into the Supabase agent_telemetry
// table (see supabase/migrations/*_agent_telemetry*.sql):
//   - 'tool_call': one row per tool call on /api/mcp (tools/call), /api/a2a
//     (message/send), /api/ioc (the STIX feed) and /api/playground;
//   - 'settlement': one row per x402 settle attempt on /api/mcp;
//   - 'initialize': one row per MCP initialize handshake, carrying the
//     client's self-reported clientInfo name and version;
//   - 'mcp_request': one row per other JSON-RPC request to /api/mcp
//     (tools/list, notifications, ping, an unknown method, a body that is
//     not JSON), with the method in mcp_method, so /usage can count every
//     MCP request and not only tool calls. Plain GET / HEAD health checks
//     are not recorded.
// lib/usageStats.mjs reads these back as aggregates for the operator.
//
// Fire-and-forget by design, same as lib/errorLog.mjs's logApiError: the
// write is started but never awaited, every failure (missing Supabase
// config, network error, non-2xx from PostgREST, a throwing fetch) is
// swallowed, and recordTelemetry itself never throws, so telemetry can
// never slow down, fail or change an API response. The insert is cut off
// after TELEMETRY_INSERT_TIMEOUT_MS so a hung connection cannot hold the
// invocation open (see waitUntil below) either.
//
// Swallowed, not silent: a failed insert writes one pg1_errors row
// (route 'telemetry:agent_telemetry', reason telemetry_insert_failed with
// the HTTP status and PostgREST error code, or telemetry_insert_unreachable
// / telemetry_insert_timeout), at most once per TELEMETRY_FAILURE_LOG_INTERVAL_MS
// per server instance, so a table that does not match the code (missing
// column, failing check) shows up in the ERROR LOG instead of dropping every
// row unnoticed.
//
// Because the handler returns without awaiting the write, Vercel could
// freeze the function before the insert finishes. Every write is therefore
// registered with waitUntil from @vercel/functions, which keeps the
// invocation alive until the promise settles without delaying the
// response. Outside Vercel (tests, local dev) waitUntil is a no-op.
//
// Only fixed, PG1-chosen values belong here - a tool name from the server's
// own tool list, an endpoint path, and the short enums below. Never caller
// input (addresses, domains, IOC values, message contents), API/licence
// keys, payment payloads or upstream response text. Two narrow exceptions,
// both reduced before they are stored:
//   - the MCP clientInfo name/version (sanitizeClientName/Version: a plain
//     character set, long hex/alphanumeric runs removed, 64/32 characters);
//   - the caller IP, only ever as a salted hash (callerHash), never raw;
//   - the tool name an MCP caller asked for when it is not one of ours
//     (requested_tool, only on unknown_tool rows), reduced the same way as
//     the client name, so /usage can show what callers look for. A name
//     that is missing, not a string or empty once reduced is stored as a
//     fixed marker ((missing), (not a string), (unprintable)), never null,
//     so /usage never has to say "(not recorded)";
//   - the JSON-RPC method of an mcp_request row: one of MCP_METHODS as it
//     is, any other method reduced the same way (letters, digits and
//     / _ . - only, long hex/alphanumeric runs removed, 40 characters), so
//     /usage can say which methods callers asked for.
// country_code (PG1 Kingdom Defence): the request's country from Vercel's
// x-vercel-ip-country header (lib/defenseEvents.mjs requestCountry), two
// capital letters, never the IP. Sent only when there is one; until the
// 20261115120000 migration adds the column, an insert PostgREST rejects for
// it (PGRST204) is retried once without it, and the country is left off
// for COUNTRY_COLUMN_RETRY_MS, so no row is ever lost to it.
// caller_kind ('internal' or 'test', lib/ownTraffic.mjs) is set only on our
// own and test traffic, which /usage never counts as real.
//
// Retention: rows older than TELEMETRY_RETENTION_DAYS are deleted by
// purgeExpiredTelemetry, run daily by the /api/errors/cleanup cron.

import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { getSupabaseCreds } from './supabase.mjs';
import { logApiError } from './errorLog.mjs';
import { normalizeCountry } from './defenseEvents.mjs';

export const TELEMETRY_EVENT_TYPES = new Set(['tool_call', 'settlement', 'initialize', 'mcp_request']);
// MCP methods stored as they are in mcp_method; anything else is 'other'.
// invalid_json is a POST whose body was not JSON.
export const MCP_METHODS = Object.freeze(['initialize', 'tools/list', 'tools/call', 'notifications/initialized', 'ping', 'resources/list', 'resources/templates/list', 'prompts/list', 'invalid_json', 'batch', 'invalid_request']);
export const CALLER_KINDS = Object.freeze(['internal', 'test']);
const MAX_MCP_METHOD_LEN = 40;
const MAX_REQUESTED_TOOL_LEN = 64;
export const TELEMETRY_PAYMENT_TYPES = new Set(['free', 'free_tier', 'license', 'x402', 'none']);
export const TELEMETRY_RETENTION_DAYS = 90;
export const TELEMETRY_INSERT_TIMEOUT_MS = 3000;
export const TELEMETRY_FAILURE_LOG_INTERVAL_MS = 15 * 60 * 1000;
export const TELEMETRY_FAILURE_ROUTE = 'telemetry:agent_telemetry';

const MAX_TEXT_LEN = 80;
const MAX_CLIENT_NAME_LEN = 64;
const MAX_CLIENT_VERSION_LEN = 32;

function cleanText(value) {
  if (value == null || value === '') return null;
  return String(value).slice(0, MAX_TEXT_LEN);
}

function cleanLatency(latencyMs) {
  const n = Number(latencyMs);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

// The MCP clientInfo name is whatever the client says it is, so it is cut
// down before it is stored: letters, digits, space and . _ - / @ + ( ) only,
// with any 0x-hex run or 20+ character letters-and-digits run removed (an
// address or key has no business in a client name), then 64 characters.
// Anything that ends up empty is null.
export function sanitizeClientName(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .normalize('NFKC')
    .replace(/0x[0-9a-f]{6,}/gi, ' ')
    .replace(/[^A-Za-z0-9 ._\-\/@+()]/g, ' ')
    .replace(/[A-Za-z0-9]{20,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CLIENT_NAME_LEN)
    .trim();
  return cleaned || null;
}

// An unknown tool name as the caller sent it, reduced like a client name
// (64 characters). Never null: a name that is missing, not a string or
// empty once reduced becomes a fixed marker.
export function sanitizeRequestedTool(value) {
  if (value === undefined || value === null || value === '') return '(missing)';
  if (typeof value !== 'string') return '(not a string)';
  return (sanitizeClientName(value) || '(unprintable)').slice(0, MAX_REQUESTED_TOOL_LEN);
}

// The JSON-RPC method as stored: a known one as it is, any other one
// reduced (method names are short identifiers like "resources/read" or
// "notifications/cancelled"; anything else in them is dropped).
export function sanitizeMcpMethod(value) {
  if (typeof value !== 'string' || !value) return null;
  if (MCP_METHODS.includes(value)) return value;
  const cleaned = value
    .normalize('NFKC')
    .replace(/0x[0-9a-f]{6,}/gi, ' ')
    .replace(/[^A-Za-z0-9\/_.\-]/g, ' ')
    .replace(/[A-Za-z0-9]{24,}/g, ' ')
    .trim()
    .split(/\s+/)[0] || '';
  return cleaned.slice(0, MAX_MCP_METHOD_LEN) || 'other';
}

function cleanMcpMethod(value) {
  return sanitizeMcpMethod(value);
}

function cleanAmountUsd(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e6) / 1e6;
}

export function sanitizeClientVersion(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').replace(/[^A-Za-z0-9._\-+]/g, '').slice(0, MAX_CLIENT_VERSION_LEN);
  return cleaned || null;
}

// The telemetry status for a tool call that ended in an MCP tool error
// (isError: true) or a thrown invalid-input error, so /usage can tell the
// caller's mistakes from PG1's own failures without storing the error:
//   rate_limited     the caller hit a PG1 rate limit
//   invalid_input    the arguments or headers the caller sent could not be
//                    used, checked before any source was asked (invalid_*,
//                    abuseipdb_key_required)
//   upstream_error   a data source PG1 calls failed, timed out, refused or
//                    rate limited the request (an AbuseIPDB 401 or 429
//                    included: the source answered with an error)
//   tool_error       anything else: PG1's own failure
// /usage counts upstream_error and tool_error as PG1's or its sources'
// fault, never the caller's.
export const CALLER_TOOL_ERROR_CODES = Object.freeze(['abuseipdb_key_required']);

export function toolErrorTelemetryStatus(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (code === 'rate_limited') return 'rate_limited';
  if (code === 'upstream_unavailable' || code === 'timeout' || (err && (err.serviceUnavailable || err.logCategory === 'upstream' || err.logCategory === 'timeout'))) return 'upstream_error';
  if (code.startsWith('invalid_') || CALLER_TOOL_ERROR_CODES.includes(code)) return 'invalid_input';
  return 'tool_error';
}

// The same split for a chat/playground executor outcome ({ ok: false, code }).
// not_found (nothing on record) is an answer, not an error.
export function outcomeTelemetryStatus(outcome) {
  if (!outcome || outcome.ok) return 'ok';
  if (outcome.code === 'not_found') return 'not_found';
  return toolErrorTelemetryStatus({ code: outcome.code, serviceUnavailable: outcome.code === 'unavailable' || outcome.code === 'service_unavailable', logCategory: outcome.category });
}

// The salt for callerHash: TELEMETRY_IP_SALT, or else a value derived from
// the Supabase service-role key (secret, server-side only). With neither,
// no hash is stored at all - never an unsalted one.
function callerHashSalt() {
  const explicit = (process.env.TELEMETRY_IP_SALT || '').trim();
  if (explicit) return explicit;
  const supKey = (process.env.SUPABASEAPI_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLEKEY || '').replace(/\s+/g, '');
  if (!supKey) return null;
  return crypto.createHmac('sha256', supKey).update('pg1-agent-telemetry-caller-hash-v1').digest('hex');
}

// HMAC-SHA256(salt, ip), first 32 hex characters. Distinct hashes are an
// estimate of distinct callers: one agent can call from several addresses
// and several agents can share one.
export function callerHash(ip) {
  const value = typeof ip === 'string' ? ip.trim().toLowerCase() : '';
  if (!value || value === 'unknown') return null;
  const salt = callerHashSalt();
  if (!salt) return null;
  return crypto.createHmac('sha256', salt).update(value).digest('hex').slice(0, 32);
}

// A Gumroad licence key as it may be stored (api_access_logs): the same
// salt as callerHash (TELEMETRY_IP_SALT, no new secret), domain-separated so
// a key and an IP can never produce the same hash; 32 hex characters, or
// null with no key or no salt (the caller then stores no key at all).
export function licenceKeyHash(licenceKey) {
  const value = typeof licenceKey === 'string' ? licenceKey.trim() : '';
  if (!value) return null;
  const salt = callerHashSalt();
  if (!salt) return null;
  return crypto.createHmac('sha256', salt).update(`pg1-licence-key-v1:${value}`).digest('hex').slice(0, 32);
}

const CALLER_HASH_RE = /^[0-9a-f]{32}$/;

// Builds the agent_telemetry row. Exported for tests. `callerIp` is hashed
// here and never stored; `callerHash` (already hashed) is accepted as is
// when it has the hash shape. mcp_method, requested_tool and amount_usd are
// only present on the rows they apply to, so every other row inserts into a
// table that does not have those columns yet.
// plan (1.23.0, lib/plans.mjs TIERS): the caller's plan on a metered check
// (check_agent_message, check_repo_trap); only on those rows.
export const TELEMETRY_PLANS = new Set(['anonymous', 'free', 'builder', 'team', 'partner']);

export function buildTelemetryRow({ eventType, endpoint, toolName, paymentType, status, latencyMs, clientName, clientVersion, callerIp, callerHash: givenHash, isFixture, mcpMethod, requestedTool, amountUsd, callerKind, countryCode, plan }) {
  const type = TELEMETRY_EVENT_TYPES.has(eventType) ? eventType : 'tool_call';
  const hash = typeof givenHash === 'string' && CALLER_HASH_RE.test(givenHash) ? givenHash : callerHash(callerIp);
  const extra = {};
  const method = type === 'mcp_request' ? cleanMcpMethod(mcpMethod) || 'other' : null;
  if (method) extra.mcp_method = method;
  const requested = type === 'tool_call' && status === 'unknown_tool' ? sanitizeRequestedTool(requestedTool) : null;
  if (requested) extra.requested_tool = requested;
  const amount = type === 'settlement' && status === 'settled' ? cleanAmountUsd(amountUsd) : null;
  if (amount != null) extra.amount_usd = amount;
  if (CALLER_KINDS.includes(callerKind)) extra.caller_kind = callerKind;
  const country = normalizeCountry(countryCode);
  if (country) extra.country_code = country;
  if (TELEMETRY_PLANS.has(plan)) extra.plan = plan;
  return {
    event_type: type,
    endpoint: cleanText(endpoint) || 'unknown',
    tool_name: cleanText(toolName),
    payment_type: TELEMETRY_PAYMENT_TYPES.has(paymentType) ? paymentType : 'none',
    status: cleanText(status) || 'unknown',
    latency_ms: cleanLatency(latencyMs),
    client_name: type === 'initialize' ? sanitizeClientName(clientName) : null,
    client_version: type === 'initialize' ? sanitizeClientVersion(clientVersion) : null,
    caller_hash: hash,
    is_fixture: isFixture === true,
    ...extra
  };
}

// Registers a background promise with Vercel's waitUntil. A missing request
// context or a throwing waitUntil must never break the caller.
function keepAlive(promise) {
  try {
    waitUntil(promise);
  } catch {
    // Best-effort - see module comment.
  }
  return promise;
}

// Rate limit for the failure log: the time the last pg1_errors row was
// started in this server instance.
let lastFailureLoggedAt = -Infinity;

export function __resetTelemetryFailureLogForTests() {
  lastFailureLoggedAt = -Infinity;
  countryColumnMissingAt = -Infinity;
  planColumnMissingAt = -Infinity;
  dropWindow = null;
  dropPending = null;
  dropWrittenAt = -Infinity;
}

// When PostgREST last said agent_telemetry has no country_code column.
export const COUNTRY_COLUMN_RETRY_MS = 60 * 60 * 1000;
let countryColumnMissingAt = -Infinity;
// The same for the plan column (20261122130000_pg1_telemetry_plan).
let planColumnMissingAt = -Infinity;

// PostgREST error codes are short fixed identifiers (PGRST204, 23514, ...);
// anything else in the body - which can echo the row - is never kept.
const POSTGREST_CODE_RE = /^[A-Z0-9]{3,10}$/;

async function postgrestErrorCode(res) {
  try {
    const body = await res.json();
    return body && typeof body.code === 'string' && POSTGREST_CODE_RE.test(body.code) ? body.code : null;
  } catch {
    return null;
  }
}

// --- dropped rows: counted precisely --------------------------------------------
//
// A row is dropped only after its insert was refused for good (a 4xx that is
// not a missing column) or got no usable answer after every retry. Each drop
// is counted: how many rows, the first and last time, and why. The warning
// in the ERROR LOG (one pg1_errors row per TELEMETRY_FAILURE_LOG_INTERVAL_MS
// per instance) names the count and the period since the last warning; each
// drop is also written to pg1_telemetry_drops (migration
// 20261123120000_pg1_telemetry_drops.sql) so the daily report can sum them.
// A drop record that cannot be written stays pending and is added to the
// next one.

let dropWindow = null; // since the last warning: { rows, first, last, reason }
let dropPending = null; // not yet written to pg1_telemetry_drops
let dropWrittenAt = -Infinity; // the last attempt to write it
// A pending drop record is retried after a successful insert at most this often.
export const TELEMETRY_DROP_RETRY_MS = 60 * 1000;

function addDrop(target, n, reason, at) {
  if (!target) return { rows: n, first: at, last: at, reason };
  return { rows: target.rows + n, first: Math.min(target.first, at), last: Math.max(target.last, at), reason: target.reason === reason ? reason : 'mixed' };
}

export function telemetryDropStats() {
  return { window: dropWindow ? { ...dropWindow } : null, pending: dropPending ? { ...dropPending } : null };
}

const hhmm = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
export function dropWarningText(d, { status, code, kind } = {}) {
  const rows = `${d.rows} row${d.rows === 1 ? '' : 's'}`;
  const period = d.first === d.last ? `at ${hhmm(d.first)} UTC` : `between ${hhmm(d.first)} and ${hhmm(d.last)} UTC`;
  if (typeof status === 'number') return `agent_telemetry insert rejected (HTTP ${status}${code ? `, ${code}` : ''}): ${rows} dropped ${period}; rows are dropped until the table matches lib/telemetry.mjs.`;
  return `agent_telemetry insert got no answer (${kind}) after ${TELEMETRY_RETRY_DELAYS_MS.length + 1} tries: ${rows} dropped ${period}.`;
}

function writeDropRecord(supUrl, supKey) {
  if (!dropPending) return Promise.resolve();
  dropWrittenAt = Date.now();
  const rec = dropPending;
  dropPending = null;
  const body = { first_dropped_at: new Date(rec.first).toISOString(), last_dropped_at: new Date(rec.last).toISOString(), rows_dropped: rec.rows, reason: String(rec.reason).slice(0, 40) };
  return fetch(`${supUrl}/rest/v1/${TELEMETRY_DROPS_TABLE}`, {
    method: 'POST',
    headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TELEMETRY_INSERT_TIMEOUT_MS) : undefined
  }).then((res) => {
    // 404: the table is not there yet. Anything else not ok: try again with the next drop.
    if (!res || (!res.ok && res.status !== 404)) dropPending = addDrop(dropPending, rec.rows, rec.reason, rec.first);
  }, () => { dropPending = addDrop(dropPending, rec.rows, rec.reason, rec.first); });
}

// Records `n` dropped rows and writes the warning (rate-limited) and the drop
// record. Never rejects. `failure` is { status, code } for a refused insert,
// or { kind: 'timeout' | 'unreachable' } when no answer came back.
function reportInsertFailure(supUrl, supKey, failure, n = 1, now = Date.now()) {
  const answered = typeof failure.status === 'number';
  const reason = answered ? 'telemetry_insert_failed' : `telemetry_insert_${failure.kind}`;
  dropWindow = addDrop(dropWindow, n, reason, now);
  dropPending = addDrop(dropPending, n, reason, now);
  const record = writeDropRecord(supUrl, supKey);
  if (now - lastFailureLoggedAt < TELEMETRY_FAILURE_LOG_INTERVAL_MS) return record;
  lastFailureLoggedAt = now;
  const message = dropWarningText(dropWindow, failure);
  console.warn(`[telemetry] ${reason} status=${answered ? failure.status : '-'} code=${failure.code || '-'} dropped=${dropWindow.rows}`);
  dropWindow = null;
  try {
    return Promise.all([record, logApiError(supUrl, supKey, {
      source: 'server', route: TELEMETRY_FAILURE_ROUTE, status: answered ? failure.status : null,
      reason, message, category: answered ? undefined : failure.kind === 'timeout' ? 'timeout' : 'network'
    })]).then(() => {}, () => {});
  } catch {
    return record;
  }
}

// --- the write queue: batched, retried, never awaited by a response ----------------
//
// recordTelemetry puts the row in a per-instance queue and returns at once.
// With no insert in flight the row goes out straight away, as one object,
// exactly as before. While an insert is in flight (a slow database, a retry
// waiting), new rows wait in the queue and go out together as one insert of
// up to TELEMETRY_BATCH_MAX rows when it finishes: the slower the database,
// the fewer inserts it gets. Rows with the same columns share an insert
// (PostgREST needs one shape per insert).
//
// No answer (timeout, network) or a 429/5xx: retried after
// TELEMETRY_RETRY_DELAYS_MS, within TELEMETRY_RETRY_BUDGET_MS so the
// invocation (kept alive by waitUntil) ends in time. A refused insert (4xx)
// is not retried, except once without a column the table does not have yet.
// The promise each call returns settles when its row is written or counted
// as dropped, and never rejects; the response never waits for it.

export const TELEMETRY_BATCH_MAX = 20;
export const TELEMETRY_RETRY_DELAYS_MS = Object.freeze([500, 2000]);
export const TELEMETRY_RETRY_BUDGET_MS = 8000;
export const TELEMETRY_DROPS_TABLE = 'pg1_telemetry_drops';
let retryDelays = TELEMETRY_RETRY_DELAYS_MS;
export function __setTelemetryRetryDelaysForTests(delays) { retryDelays = delays || TELEMETRY_RETRY_DELAYS_MS; }

let queue = [];
let inFlight = 0;
let inFlightSince = 0;
// An insert that has not settled long after its timeout and retries could
// have (a fetch that ignores its abort signal) stops holding the queue.
export const TELEMETRY_STALL_MS = TELEMETRY_RETRY_BUDGET_MS + 2 * TELEMETRY_INSERT_TIMEOUT_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shapeOf = (row) => Object.keys(row).sort().join(',');

// Starts the next insert(s) unless one is in flight. The fetch starts
// synchronously, so a quick database sees no difference from before.
function flushQueue(creds) {
  if (!queue.length) return;
  if (inFlight > 0 && Date.now() - inFlightSince < TELEMETRY_STALL_MS) return;
  inFlightSince = Date.now();
  const items = queue.splice(0, TELEMETRY_BATCH_MAX);
  const groups = new Map();
  for (const it of items) {
    const k = shapeOf(it.row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  for (const group of groups.values()) {
    inFlight++;
    writeGroup(creds, group.map((g) => g.row)).then(() => {}, () => {}).then(() => {
      for (const g of group) g.resolve();
      inFlight--;
      flushQueue(creds);
    });
  }
}

function insertRows(creds, rows) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(TELEMETRY_INSERT_TIMEOUT_MS)
    : undefined;
  return fetch(`${creds.supUrl}/rest/v1/agent_telemetry`, {
    method: 'POST',
    headers: {
      apikey: creds.supKey,
      Authorization: `Bearer ${creds.supKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(rows.length === 1 ? rows[0] : rows),
    signal
  });
}

const retryable = (res) => !res || res.status === 429 || res.status >= 500;

async function writeGroup(creds, rows) {
  const { supUrl, supKey } = creds;
  const started = Date.now();
  let attempt = 0;
  let current = rows;
  let columnRetried = false;
  for (;;) {
    let res = null;
    let failure = null;
    try {
      res = await insertRows(creds, current);
    } catch (err) {
      failure = { kind: err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'unreachable' };
    }
    if (res && res.ok) {
      if (dropPending && Date.now() - dropWrittenAt >= TELEMETRY_DROP_RETRY_MS) await writeDropRecord(supUrl, supKey);
      return;
    }
    if (res && !retryable(res)) {
      const code = typeof res.json === 'function' ? await postgrestErrorCode(res) : null;
      // No country_code or plan column yet (a migration is not run: the
      // 20261115120000 country or the 20261122130000 plan migration): once
      // more without them, and leave them off for a while. The newer column
      // is the likelier one missing: with a plan on a row, only the plan is
      // left off for a while.
      if (!columnRetried && res.status === 400 && code === 'PGRST204' && current.some((r) => r.country_code || r.plan)) {
        columnRetried = true;
        if (current.some((r) => r.plan)) planColumnMissingAt = Date.now();
        else countryColumnMissingAt = Date.now();
        current = current.map(({ country_code: _drop, plan: _dropPlan, ...rest }) => rest);
        continue;
      }
      // Own/test rows (caller_kind) are never counted; before the
      // caller_kind migration they cannot be stored, which is not a fault.
      if (current.every((r) => r.caller_kind)) return;
      await reportInsertFailure(supUrl, supKey, { status: res.status, code }, current.length);
      return;
    }
    if (!failure) failure = { status: res.status, code: null };
    const delay = retryDelays[attempt];
    if (delay === undefined || Date.now() - started + delay + TELEMETRY_INSERT_TIMEOUT_MS > TELEMETRY_RETRY_BUDGET_MS) {
      await reportInsertFailure(supUrl, supKey, failure, current.length);
      return;
    }
    attempt++;
    await sleep(delay);
  }
}

// Records one telemetry row. Returns a promise (always resolves, never
// rejects) that settles when the row is written or counted as dropped, so
// tests can await it; production callers just ignore the return value. It is
// registered with waitUntil, which keeps the invocation alive for the write
// and its retries without delaying the response.
export function recordTelemetry(event) {
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch {
    // Not configured - nowhere to write a row or a failure to.
    return Promise.resolve();
  }
  try {
    const row = buildTelemetryRow(event || {});
    if (row.country_code && Date.now() - countryColumnMissingAt < COUNTRY_COLUMN_RETRY_MS) delete row.country_code;
    if (row.plan && Date.now() - planColumnMissingAt < COUNTRY_COLUMN_RETRY_MS) delete row.plan;
    const done = new Promise((resolve) => { queue.push({ row, resolve }); });
    flushQueue(creds);
    return keepAlive(done);
  } catch {
    // Building the row threw - best-effort only.
    return keepAlive(reportInsertFailure(creds.supUrl, creds.supKey, { kind: 'unreachable' }));
  }
}

// Resolves once nothing is queued or in flight (tests, and a caller that
// wants its rows written before it exits). Never rejects.
export async function telemetryIdle({ timeoutMs = TELEMETRY_STALL_MS } = {}) {
  const until = Date.now() + timeoutMs;
  while ((queue.length || inFlight > 0) && Date.now() < until) await new Promise((r) => setTimeout(r, 2));
}

export function __resetTelemetryQueueForTests() {
  queue = [];
  inFlight = 0;
  inFlightSince = 0;
  dropWindow = null;
  dropPending = null;
  dropWrittenAt = -Infinity;
}

// The telemetry rows dropped since a time (pg1_telemetry_drops), for the
// daily report: { rows, records, first, last } (first/last ISO or null).
// Throws with a reason when the table cannot be read.
export async function readTelemetryDrops({ supUrl, supKey, sinceIso, fetchImpl = fetch }) {
  if (!supUrl || !supKey) throw Object.assign(new Error('x'), { reason: 'storage is not configured' });
  const res = await fetchImpl(`${supUrl}/rest/v1/${TELEMETRY_DROPS_TABLE}?select=rows_dropped,first_dropped_at,last_dropped_at&last_dropped_at=gte.${encodeURIComponent(sinceIso)}&order=first_dropped_at.asc&limit=1000`, { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }, cache: 'no-store' });
  if (!res || !res.ok) throw Object.assign(new Error('x'), { reason: res && res.status === 404 ? 'the drop log is not set up yet (migration 20261123120000)' : `the drop log answered HTTP ${res ? res.status : '-'}` });
  const rows = await res.json();
  if (!Array.isArray(rows)) throw Object.assign(new Error('x'), { reason: 'the drop log could not be read' });
  const sum = rows.reduce((n, r) => n + (Number(r.rows_dropped) || 0), 0);
  return { rows: sum, records: rows.length, first: rows.length ? rows[0].first_dropped_at : null, last: rows.length ? rows.reduce((m, r) => (r.last_dropped_at > m ? r.last_dropped_at : m), rows[0].last_dropped_at) : null };
}

// Deletes every row older than TELEMETRY_RETENTION_DAYS. Awaited by the
// cleanup cron (unlike recordTelemetry); resolves to { ok, cutoff, status? }
// and never throws.
export async function purgeExpiredTelemetry({ now = Date.now(), fetchImpl = fetch } = {}) {
  const cutoff = new Date(now - TELEMETRY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { supUrl, supKey } = getSupabaseCreds();
    const res = await fetchImpl(`${supUrl}/rest/v1/agent_telemetry?created_at=lt.${encodeURIComponent(cutoff)}`, {
      method: 'DELETE',
      headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, Prefer: 'return=minimal' }
    });
    return res && res.ok ? { ok: true, cutoff } : { ok: false, cutoff, status: res ? res.status : null };
  } catch {
    return { ok: false, cutoff };
  }
}
