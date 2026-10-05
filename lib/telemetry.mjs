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
// never slow down, fail or change an API response.
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

export const TELEMETRY_EVENT_TYPES = new Set(['tool_call', 'settlement', 'initialize']);
export const TELEMETRY_PAYMENT_TYPES = new Set(['free', 'free_tier', 'license', 'x402', 'none']);
export const TELEMETRY_RETENTION_DAYS = 90;

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

// Records one telemetry row. Returns the in-flight promise (always
// resolves, never rejects) so tests can await it; production callers just
// ignore the return value.
export function recordTelemetry(event) {
  try {
    const { supUrl, supKey } = getSupabaseCreds();
    const row = buildTelemetryRow(event || {});
    return keepAlive(fetch(`${supUrl}/rest/v1/agent_telemetry`, {
      method: 'POST',
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(row)
    }).then(() => {}, () => {}));
  } catch {
    // Not configured, or fetch threw synchronously - best-effort only.
    return Promise.resolve();
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
