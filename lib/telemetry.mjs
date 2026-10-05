// Lightweight usage telemetry, written into the Supabase agent_telemetry
// table (see supabase/migrations/*_agent_telemetry*.sql):
//   - 'tool_call': one row per tool call on /api/mcp (tools/call), /api/a2a
//     (message/send), /api/ioc (the STIX feed) and /api/playground;
//   - 'settlement': one row per x402 settle attempt on /api/mcp;
//   - 'initialize': one row per MCP initialize handshake, carrying the
//     client's self-reported clientInfo name and version.
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
//   - the caller IP, only ever as a salted hash (callerHash), never raw.
//
// Retention: rows older than TELEMETRY_RETENTION_DAYS are deleted by
// purgeExpiredTelemetry, run daily by the /api/errors/cleanup cron.

import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { getSupabaseCreds } from './supabase.mjs';
import { logApiError } from './errorLog.mjs';

export const TELEMETRY_EVENT_TYPES = new Set(['tool_call', 'settlement', 'initialize']);
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

export function sanitizeClientVersion(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').replace(/[^A-Za-z0-9._\-+]/g, '').slice(0, MAX_CLIENT_VERSION_LEN);
  return cleaned || null;
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

const CALLER_HASH_RE = /^[0-9a-f]{32}$/;

// Builds the agent_telemetry row. Exported for tests. `callerIp` is hashed
// here and never stored; `callerHash` (already hashed) is accepted as is
// when it has the hash shape.
export function buildTelemetryRow({ eventType, endpoint, toolName, paymentType, status, latencyMs, clientName, clientVersion, callerIp, callerHash: givenHash, isFixture }) {
  const type = TELEMETRY_EVENT_TYPES.has(eventType) ? eventType : 'tool_call';
  const hash = typeof givenHash === 'string' && CALLER_HASH_RE.test(givenHash) ? givenHash : callerHash(callerIp);
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
    is_fixture: isFixture === true
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
}

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

// Writes the one rate-limited pg1_errors row for a failed insert. Never
// rejects. `failure` is { status, code } for a non-2xx answer, or
// { kind: 'timeout' | 'unreachable' } when no answer came back.
function reportInsertFailure(supUrl, supKey, failure, now = Date.now()) {
  if (now - lastFailureLoggedAt < TELEMETRY_FAILURE_LOG_INTERVAL_MS) return Promise.resolve();
  lastFailureLoggedAt = now;
  const answered = typeof failure.status === 'number';
  const reason = answered ? 'telemetry_insert_failed' : `telemetry_insert_${failure.kind}`;
  const message = answered
    ? `agent_telemetry insert rejected (HTTP ${failure.status}${failure.code ? `, ${failure.code}` : ''}); rows are being dropped until the table matches lib/telemetry.mjs.`
    : `agent_telemetry insert got no answer (${failure.kind}); rows are being dropped.`;
  console.warn(`[telemetry] ${reason} status=${answered ? failure.status : '-'} code=${failure.code || '-'}`);
  try {
    return logApiError(supUrl, supKey, {
      source: 'server', route: TELEMETRY_FAILURE_ROUTE, status: answered ? failure.status : null,
      reason, message, category: answered ? undefined : failure.kind === 'timeout' ? 'timeout' : 'network'
    }).then(() => {}, () => {});
  } catch {
    return Promise.resolve();
  }
}

// Records one telemetry row. Returns the in-flight promise (always
// resolves, never rejects) so tests can await it; production callers just
// ignore the return value. The failure log, when there is one, is part of
// the same promise, so waitUntil keeps it alive too.
export function recordTelemetry(event) {
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch {
    // Not configured - nowhere to write a row or a failure to.
    return Promise.resolve();
  }
  const { supUrl, supKey } = creds;
  try {
    const row = buildTelemetryRow(event || {});
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(TELEMETRY_INSERT_TIMEOUT_MS)
      : undefined;
    return keepAlive(fetch(`${supUrl}/rest/v1/agent_telemetry`, {
      method: 'POST',
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(row),
      signal
    }).then(
      async (res) => {
        if (res && res.ok) return;
        const status = res && typeof res.status === 'number' ? res.status : 0;
        const code = res && typeof res.json === 'function' ? await postgrestErrorCode(res) : null;
        await reportInsertFailure(supUrl, supKey, { status, code });
      },
      (err) => reportInsertFailure(supUrl, supKey, { kind: err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'unreachable' })
    ).then(() => {}, () => {}));
  } catch {
    // fetch threw synchronously - best-effort only.
    return keepAlive(reportInsertFailure(supUrl, supKey, { kind: 'unreachable' }));
  }
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
