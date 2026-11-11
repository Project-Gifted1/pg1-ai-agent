// PG1 Kingdom Defence, the write side: the request's country and one row
// per real defence verdict PG1 returned (pg1_defense_events, migration
// 20261115120000). lib/defenseFeed.mjs reads these back, with the usage
// telemetry, sign-in failures, sanctions refusals and reports, for
// /api/defense-feed.
//
// PG1 only defends: nothing here contacts a caller or any third party. The
// only network call is the insert into PG1's own Supabase.
//
// Privacy, same rules as lib/telemetry.mjs:
//   - country: Vercel's x-vercel-ip-country header, two capital letters or
//     nothing. The IP is never read here and never stored.
//   - caller: the salted callerHash (32 hex), never the address.
//   - what was checked (a wallet, a domain, a package, a message) is never
//     stored: only the check's name, its verdict code and its reason codes,
//     each from PG1's own frozen list (lib/reasonCodes.mjs). The content of
//     a check_agent_message call never reaches this file at all; only the
//     verdict and reasons of its result do.
//
// Fire-and-forget like recordTelemetry: never throws, never awaited by a
// handler, kept alive with waitUntil, cut off after 3 s. Fixture calls and
// PG1's own or test traffic (callerKind) are not recorded: they are not
// attacks.

import { waitUntil } from '@vercel/functions';
import { getSupabaseCreds } from './supabase.mjs';
import { REASON_CODES } from './reasonCodes.mjs';

export const DEFENSE_TABLE = 'pg1_defense_events';
export const DEFENSE_CHECKS = Object.freeze(['check_agent_message', 'check_repo_trap', 'check_hostname_reputation', 'check_domain_age', 'check_wallet_sanctions', 'check_package', 'preflight_check']);
export const DEFENSE_ENDPOINTS = Object.freeze(['/api/mcp', '/api/a2a', '/api/preflight', '/api/repo-trap']);
export const SUBJECT_KINDS = Object.freeze(['skill_md', 'message', 'other']);
const INSERT_TIMEOUT_MS = 3000;
const MAX_REASONS = 8;
const HASH_RE = /^[0-9a-f]{32}$/;

function header(req, name) {
  const h = req && req.headers;
  if (!h) return '';
  const v = typeof h.get === 'function' ? h.get(name) : h[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] || '') : '';
}

// The request's country from Vercel's edge (ISO 3166-1 alpha-2), or null.
// Anything that is not exactly two letters is null; "XX" and "T1" style
// pseudo-codes are not countries.
export function requestCountry(req) {
  try {
    return normalizeCountry(header(req, 'x-vercel-ip-country'));
  } catch {
    return null;
  }
}

export function normalizeCountry(value) {
  const c = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX' || c === 'ZZ') return null;
  return c;
}

const knownReason = (code) => typeof code === 'string' && Object.hasOwn(REASON_CODES, code);

function reasonCodesOf(result) {
  const list = Array.isArray(result && result.reasons) ? result.reasons : [];
  const out = [];
  for (const r of list) {
    const code = r && typeof r === 'object' ? r.code : r;
    if (knownReason(code) && !out.includes(code)) out.push(code);
    if (out.length >= MAX_REASONS) break;
  }
  return out;
}

// The defence verdict in a check's result, or null when the result is not
// one (no flags, unknown, an error, a tool that is not a defence check).
//   check_agent_message  verdict malicious (high) or suspicious (medium)
//   check_repo_trap      the same (1.22.0); never a path or any file content
//   preflight_check      decision flagged (high)
//   the other checks     status flagged: sanctions high, the rest medium
export function defenseVerdictOf(toolName, result) {
  if (!DEFENSE_CHECKS.includes(toolName) || !result || typeof result !== 'object' || result.error) return null;
  const reasons = reasonCodesOf(result);
  if (toolName === 'check_agent_message' || toolName === 'check_repo_trap') {
    if (result.verdict === 'malicious') return { verdict_code: 'malicious', severity: 'high', reason_codes: reasons };
    if (result.verdict === 'suspicious') return { verdict_code: 'suspicious', severity: 'medium', reason_codes: reasons };
    return null;
  }
  if (toolName === 'preflight_check') {
    return result.decision === 'flagged' ? { verdict_code: 'flagged', severity: 'high', reason_codes: reasons } : null;
  }
  if (result.status !== 'flagged') return null;
  return { verdict_code: 'flagged', severity: toolName === 'check_wallet_sanctions' || reasons.includes('PACKAGE_REPORTED_MALICIOUS') ? 'high' : 'medium', reason_codes: reasons };
}

// The row as stored. Exported for tests.
export function buildDefenseRow({ toolName, endpoint, result, country, callerHash }) {
  const v = defenseVerdictOf(toolName, result);
  if (!v || !DEFENSE_ENDPOINTS.includes(endpoint)) return null;
  return {
    check_name: toolName,
    endpoint,
    verdict_code: v.verdict_code,
    reason_codes: v.reason_codes,
    severity: v.severity,
    // check_agent_message's declared kind, from its own fixed list; never content.
    subject_kind: toolName === 'check_agent_message' && SUBJECT_KINDS.includes(result.kind) ? result.kind : null,
    country_code: normalizeCountry(country),
    caller_hash: typeof callerHash === 'string' && HASH_RE.test(callerHash) ? callerHash : null
  };
}

function keepAlive(p) {
  try { waitUntil(p); } catch { /* outside Vercel */ }
  return p;
}

// Records one defence verdict, if the result is one. Returns the in-flight
// promise (always resolves) so tests can await it.
//   { toolName, endpoint, result, country, callerHash, callerKind, isFixture, fetchImpl }
export function recordDefenseEvent(event = {}) {
  try {
    if (!event || event.isFixture === true || event.callerKind) return Promise.resolve(false);
    const row = buildDefenseRow(event);
    if (!row) return Promise.resolve(false);
    let creds;
    try { creds = getSupabaseCreds(); } catch { return Promise.resolve(false); }
    const fetchImpl = event.fetchImpl || globalThis.fetch;
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(INSERT_TIMEOUT_MS) : undefined;
    return keepAlive(Promise.resolve().then(() => fetchImpl(`${creds.supUrl}/rest/v1/${DEFENSE_TABLE}`, {
      method: 'POST',
      headers: { apikey: creds.supKey, Authorization: `Bearer ${creds.supKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
      signal
    })).then((res) => !!(res && res.ok), () => false));
  } catch {
    return Promise.resolve(false);
  }
}
