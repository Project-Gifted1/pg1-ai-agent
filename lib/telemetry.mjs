// Lightweight usage telemetry: one row per MCP tool call and one row per
// x402 settlement attempt, written into the Supabase agent_telemetry table
// (see supabase/migrations/*_agent_telemetry.sql).
//
// Fire-and-forget by design, same as lib/errorLog.mjs's logApiError: the
// write is started but never awaited, every failure (missing Supabase
// config, network error, non-2xx from PostgREST, a throwing fetch) is
// swallowed, and recordTelemetry itself never throws, so telemetry can
// never slow down, fail or change an API response.
//
// Only fixed, PG1-chosen values belong here - a tool name from the server's
// own tool list, an endpoint path, and the short enums below. Never caller
// input (addresses, domains, IOC values), API/licence keys, payment
// payloads or upstream response text.

import { getSupabaseCreds } from './supabase.mjs';

export const TELEMETRY_EVENT_TYPES = new Set(['tool_call', 'settlement']);
export const TELEMETRY_PAYMENT_TYPES = new Set(['free', 'free_tier', 'license', 'x402', 'none']);

const MAX_TEXT_LEN = 80;

function cleanText(value) {
  if (value == null || value === '') return null;
  return String(value).slice(0, MAX_TEXT_LEN);
}

function cleanLatency(latencyMs) {
  const n = Number(latencyMs);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

// Builds the agent_telemetry row. Exported for tests.
export function buildTelemetryRow({ eventType, endpoint, toolName, paymentType, status, latencyMs }) {
  return {
    event_type: TELEMETRY_EVENT_TYPES.has(eventType) ? eventType : 'tool_call',
    endpoint: cleanText(endpoint) || 'unknown',
    tool_name: cleanText(toolName),
    payment_type: TELEMETRY_PAYMENT_TYPES.has(paymentType) ? paymentType : 'none',
    status: cleanText(status) || 'unknown',
    latency_ms: cleanLatency(latencyMs)
  };
}

// Records one telemetry row. Returns the in-flight promise (always
// resolves, never rejects) so tests can await it; production callers just
// ignore the return value.
export function recordTelemetry(event) {
  try {
    const { supUrl, supKey } = getSupabaseCreds();
    const row = buildTelemetryRow(event || {});
    return fetch(`${supUrl}/rest/v1/agent_telemetry`, {
      method: 'POST',
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(row)
    }).then(() => {}, () => {});
  } catch {
    // Not configured, or fetch threw synchronously - best-effort only.
    return Promise.resolve();
  }
}
