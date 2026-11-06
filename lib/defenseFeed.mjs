// PG1 Kingdom Defence, the read side: the last 24 hours of real defence
// events, for /api/defense-feed (signed-in operator only) and the Kingdom
// view (public/kingdom/). Nothing here is invented: every event is one or
// more rows PG1 already logged, and when nothing was logged the feed is
// empty and the kingdom is calm.
//
// Sources (each an adapter in DEFENSE_SOURCES; a source that cannot be read
// is reported as 'error' and left out, never guessed):
//   telemetry   agent_telemetry (lib/telemetry.mjs): unknown-tool and
//               unknown-method probes on /api/mcp and /api/a2a, 402 payment
//               challenges, failed and settled x402 payments, refused payers,
//               rate-limit hits, caller-fault and PG1-fault errors, and
//               (while signing is on) the signed results
//   verdicts    pg1_defense_events (lib/defenseEvents.mjs): check_agent_message
//               malicious / suspicious, flagged hostname, domain-age, wallet
//               sanctions, package and preflight checks
//   screening   pg1_screening_events: payers refused by the sanctions screen
//   signin      pg1_auth_events: failed operator sign-ins and burst alerts,
//               as a count in a 10-minute slot only (no hash, no country)
//   reports     pg1_operator_reports: a daily or weekly report landed
//   approvals   pg1_operator_tasks and pg1_autonomous_actions waiting for
//               the operator
//   honeypot, firewall   reserved: idle until their logs exist
//
// PG1 only defends: this file only reads PG1's own database.
//
// Privacy: an event carries its time, kind, gadget, severity, the country
// (ISO code or null: "the fog"), a short caller hash (8 hex of the salted
// hash, never the IP), the PG1 check, its verdict code, the reason codes
// (PG1's own frozen list) and a count. Never an IP, a user agent, a key, a
// wallet, a domain, a tool name a caller made up, or any message content.
//
// Waves: rows of the same kind, check, verdict, country and caller within
// one minute are one event with a count (300 probes in a minute are one
// wave, not 300 characters).

import crypto from 'node:crypto';
import { irelandDayStart } from './chatThreatFeed.mjs';
import { signingStatus } from './signing.mjs';
import { normalizeCountry } from './defenseEvents.mjs';

export const DEFENSE_WINDOW_MS = 24 * 3600 * 1000;
export const DEFENSE_POLL_MS = 5000;
export const WAVE_BUCKET_MS = 60 * 1000;
export const SIGNIN_BUCKET_MS = 10 * 60 * 1000;
export const MAX_EVENTS = 600;
const READ_LIMIT = 5000;
const READ_TIMEOUT_MS = 4000;

// The gadgets: each is a real PG1 capability and fires only on its events.
export const GADGETS = Object.freeze([
  { id: 'truth_lens', name: 'Truth Lens', check: 'check_agent_message', what: 'Scans agent messages and skill files; a malicious or suspicious one burns with its reason code.' },
  { id: 'sanctions_gate', name: 'Sanctions Gate', check: 'check_wallet_sanctions', what: 'OFAC and EU sanctions: the portcullis slams on a listed wallet or a refused payer.' },
  { id: 'phishing_net', name: 'Phishing Net', check: 'check_hostname_reputation', what: 'Phishing-listed and look-alike hostnames, and domains registered in the last 30 days (check_domain_age).' },
  { id: 'supply_inspector', name: 'Supply Inspector', check: 'check_package', what: 'Packages reported malicious or new look-alikes sink at the harbour.' },
  { id: 'preflight_ward', name: 'Preflight Ward', check: 'preflight_check', what: 'One decision before an agent acts; a flagged decision is turned back.' },
  { id: 'toll_bridge', name: 'Toll Bridge', check: 'x402', what: 'Unpaid calls to paid skills stop at the toll (402); payers cross and light a lantern.' },
  { id: 'seal_forge', name: 'Seal Forge', check: 'Ed25519 signing', what: 'Every signed tool result stamps a seal (verify_result checks it).' },
  { id: 'passkey_vault', name: 'Passkey Vault', check: 'operator sign-in', what: 'Failed operator sign-ins bounce off the vault; a burst alert drops the second door.' },
  { id: 'rate_shield', name: 'Rate Shield', check: 'rate limits', what: 'The dome thickens as rate limits turn floods away.' },
  { id: 'gate_wardens', name: 'Gate Wardens', check: 'MCP / A2A router', what: 'Unknown-tool and unknown-method probes and malformed calls are turned away at the gate.' },
  { id: 'keep_wall', name: 'Keep Wall', check: 'PG1 faults', what: "PG1's own failures and its sources' failures: the kingdom takes the hit, shown honestly." },
  { id: 'beacons', name: 'Watchtower Beacons', check: 'operator reports and approvals', what: 'A beacon lights when a daily or weekly report lands or something waits for Gift.' },
  { id: 'fog_wall', name: 'Fog Wall', check: 'no country', what: 'Calls with no country header come out of the fog.' },
  { id: 'honeypot', name: 'Honeypot Decoys', check: 'honeypot logs', what: 'Reserved: idle until honeypot logs exist.', reserved: true },
  { id: 'ramparts', name: 'Firewall Ramparts', check: 'firewall temporary blocks', what: 'Reserved: idle until firewall block logs exist.', reserved: true }
]);
export const GADGET_IDS = Object.freeze(GADGETS.map((g) => g.id));

// Who an event puts on the map: an attacker at the gate, an ally arriving,
// or the kingdom itself (a beacon, a seal, a hit it took).
export const ROLES = Object.freeze({ attacker: 'attacker', ally: 'ally', kingdom: 'kingdom' });

const CHECK_GADGET = { check_agent_message: 'truth_lens', check_wallet_sanctions: 'sanctions_gate', check_hostname_reputation: 'phishing_net', check_domain_age: 'phishing_net', check_package: 'supply_inspector', preflight_check: 'preflight_ward' };
const SHORT_HASH_RE = /^[0-9a-f]{32}$/;
const ENDPOINTS = new Set(['/api/mcp', '/api/a2a', '/api/preflight', '/api/ioc', '/api/playground', '/api/hosting-advisor']);
const TOOL_RE = /^[a-z][a-z0-9_.]{1,63}$/;

export const shortHash = (h) => (typeof h === 'string' && SHORT_HASH_RE.test(h) ? h.slice(0, 8) : null);
const cleanEndpoint = (e) => (ENDPOINTS.has(e) ? e : null);
// A tool name PG1 knows (telemetry stores tool_name only for its own tools;
// a caller's made-up name is in requested_tool and is never read here).
const cleanTool = (t) => (typeof t === 'string' && TOOL_RE.test(t) ? t : null);

// --- classification: one stored row -> one raw event (or null) -----------------------------

// agent_telemetry rows. signing: whether results are being signed now.
export function classifyTelemetryRow(row, { signing = false } = {}) {
  if (!row || typeof row !== 'object' || row.caller_kind || row.is_fixture === true) return null;
  const at = Date.parse(row.created_at);
  if (!Number.isFinite(at)) return null;
  const base = { at, country: normalizeCountry(row.country_code), caller: shortHash(row.caller_hash), endpoint: cleanEndpoint(row.endpoint), source: 'telemetry', reasons: [] };
  const tool = cleanTool(row.tool_name);
  const status = String(row.status || '');
  const ev = (kind, gadget, role, severity, check, verdict) => ({ ...base, kind, gadget, role, severity, check, verdict });
  if (row.event_type === 'settlement') {
    if (status === 'settled') return ev('payment_settled', 'toll_bridge', 'ally', 'low', 'x402', 'SETTLED');
    return ev('payment_failed', 'toll_bridge', 'attacker', 'low', 'x402', 'SETTLEMENT_FAILED');
  }
  if (row.event_type === 'mcp_request') {
    if (status === 'ok') return null;
    const verdict = row.mcp_method === 'invalid_json' ? 'INVALID_JSON' : status === 'method_not_found' ? 'UNKNOWN_METHOD' : 'MALFORMED_REQUEST';
    return ev('probe', 'gate_wardens', 'attacker', 'low', 'mcp_router', verdict);
  }
  if (row.event_type !== 'tool_call') return null;
  switch (status) {
    case 'ok':
      return signing && (base.endpoint === '/api/mcp' || base.endpoint === '/api/a2a' || base.endpoint === '/api/preflight') ? ev('signed_result', 'seal_forge', 'kingdom', 'low', tool || 'tool', 'SIGNED') : null;
    case 'unknown_tool':
      return ev('probe', 'gate_wardens', 'attacker', 'low', base.endpoint === '/api/a2a' ? 'a2a_router' : 'tool_router', 'UNKNOWN_TOOL');
    case 'payment_required':
      return ev('payment_challenge', 'toll_bridge', 'attacker', 'low', tool || 'x402', 'PAYMENT_REQUIRED_402');
    case 'free_limit_reached':
      return ev('payment_challenge', 'toll_bridge', 'attacker', 'low', tool || 'x402', 'FREE_LIMIT_REACHED');
    case 'settlement_failed':
      return ev('payment_failed', 'toll_bridge', 'attacker', 'low', tool || 'x402', 'SETTLEMENT_FAILED');
    case 'payer_refused':
      return ev('payer_refused', 'sanctions_gate', 'attacker', 'high', 'payer_screening', 'PAYER_REFUSED');
    case 'rate_limited':
      return ev('rate_limited', 'rate_shield', 'attacker', 'medium', tool || 'rate_limit', 'RATE_LIMITED');
    case 'invalid_input':
    case 'client_error':
      return ev('caller_fault', 'gate_wardens', 'attacker', 'low', tool || 'tool', 'CALLER_FAULT');
    case 'tool_error':
    case 'server_error':
      return ev('pg1_fault', 'keep_wall', 'kingdom', 'medium', tool || 'tool', 'PG1_FAULT');
    case 'upstream_error':
      return ev('pg1_fault', 'keep_wall', 'kingdom', 'low', tool || 'tool', 'SOURCE_FAULT');
    default:
      return null;
  }
}

// pg1_defense_events rows.
export function classifyVerdictRow(row) {
  if (!row || typeof row !== 'object') return null;
  const at = Date.parse(row.created_at);
  const gadget = CHECK_GADGET[row.check_name];
  if (!Number.isFinite(at) || !gadget) return null;
  const reasons = (Array.isArray(row.reason_codes) ? row.reason_codes : []).filter((c) => typeof c === 'string' && /^[A-Z0-9_]{3,64}$/.test(c)).slice(0, 8);
  const severity = ['low', 'medium', 'high'].includes(row.severity) ? row.severity : 'medium';
  return {
    at, kind: 'check_verdict', gadget, role: 'attacker', severity,
    country: normalizeCountry(row.country_code), caller: shortHash(row.caller_hash), endpoint: cleanEndpoint(row.endpoint),
    check: row.check_name, verdict: String(row.verdict_code || 'flagged').slice(0, 24), reasons,
    subject: ['skill_md', 'message', 'other'].includes(row.subject_kind) ? row.subject_kind : null,
    source: 'verdicts'
  };
}

// pg1_screening_events rows (a refused payer): the lists only.
export function classifyScreeningRow(row) {
  const at = Date.parse(row && row.created_at);
  if (!Number.isFinite(at)) return null;
  const lists = (Array.isArray(row.lists) ? row.lists : []).filter((l) => l === 'ofac' || l === 'eu');
  return { at, kind: 'payer_refused', gadget: 'sanctions_gate', role: 'attacker', severity: 'high', country: null, caller: null, endpoint: null, check: 'check_wallet_sanctions', verdict: 'SANCTIONS_MATCH', reasons: lists.map((l) => (l === 'ofac' ? 'LIST_OFAC' : 'LIST_EU')), source: 'screening' };
}

// pg1_auth_events rows: the 10-minute slot and the kind only.
export function classifySigninRow(row) {
  const t = Date.parse(row && row.created_at);
  if (!Number.isFinite(t)) return null;
  const at = Math.floor(t / SIGNIN_BUCKET_MS) * SIGNIN_BUCKET_MS;
  if (row.kind === 'failure') return { at, kind: 'signin_failed', gadget: 'passkey_vault', role: 'attacker', severity: 'medium', country: null, caller: null, endpoint: null, check: 'operator_signin', verdict: 'SIGNIN_FAILED', reasons: [], source: 'signin', coarse: true };
  if (row.kind === 'burst_alert') return { at, kind: 'lockout', gadget: 'passkey_vault', role: 'attacker', severity: 'high', country: null, caller: null, endpoint: null, check: 'operator_signin', verdict: 'LOCKOUT_ALERT', reasons: [], source: 'signin', coarse: true };
  return null;
}

export function classifyReportRow(row) {
  const at = Date.parse(row && row.created_at);
  if (!Number.isFinite(at) || !['daily', 'weekly'].includes(row.kind)) return null;
  return { at, kind: 'report', gadget: 'beacons', role: 'kingdom', severity: 'low', country: null, caller: null, endpoint: null, check: `${row.kind}_report`, verdict: 'REPORT_LANDED', reasons: [], source: 'reports' };
}

export function classifyApprovalRow(row, table) {
  const at = Date.parse(row && (row.approval_requested_at || row.at || row.created_at));
  if (!Number.isFinite(at)) return null;
  return { at, kind: 'approval', gadget: 'beacons', role: 'kingdom', severity: 'medium', country: null, caller: null, endpoint: null, check: table === 'pg1_autonomous_actions' ? 'autonomous_action' : 'operator_task', verdict: 'NEEDS_APPROVAL', reasons: [], source: 'approvals' };
}

// --- waves ----------------------------------------------------------------------

// Raw events -> events: one per (minute, kind, gadget, check, verdict,
// country, caller, reasons), with a count. The id is stable across polls,
// so a wave that grows keeps its id and the view updates its count.
export function aggregateEvents(raw, { bucketMs = WAVE_BUCKET_MS } = {}) {
  const map = new Map();
  for (const e of raw) {
    if (!e) continue;
    const bucket = Math.floor(e.at / bucketMs) * bucketMs;
    const reasons = Array.isArray(e.reasons) ? e.reasons : [];
    const key = [bucket, e.kind, e.gadget, e.check, e.verdict, e.country || '-', e.caller || '-', reasons.join('+'), e.subject || '-'].join('|');
    const cur = map.get(key);
    if (cur) { cur.count += Math.max(1, e.count || 1); if (e.at > cur.last) cur.last = e.at; if (e.at < cur.first) cur.first = e.at; continue; }
    map.set(key, { key, bucket, first: e.at, last: e.at, count: Math.max(1, e.count || 1), e });
  }
  const out = [];
  for (const { key, bucket, first, last, count, e } of map.values()) {
    out.push({
      id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
      time: new Date(e.coarse ? bucket : first).toISOString(),
      last: new Date(e.coarse ? bucket : last).toISOString(),
      kind: e.kind,
      gadget: e.gadget,
      role: e.role,
      severity: e.severity,
      country_code: e.country || null,
      caller_hash: e.caller || null,
      endpoint: e.endpoint || null,
      check: e.check,
      verdict_code: e.verdict,
      reasons: reasonsOf(e),
      subject: e.subject || null,
      count,
      source: e.source
    });
  }
  out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : a.id < b.id ? 1 : -1));
  return out;
}
const reasonsOf = (e) => (Array.isArray(e.reasons) ? e.reasons.slice(0, 8) : []);

// The weather: calm, watch or storm, from the attackers of the last 15
// minutes (a big wave or several high-severity events is a storm).
export function threatLevel(events, now = Date.now()) {
  const recent = events.filter((e) => e.role === 'attacker' && now - Date.parse(e.last || e.time) <= 15 * 60 * 1000);
  const total = recent.reduce((n, e) => n + e.count, 0);
  const high = recent.filter((e) => e.severity === 'high').length;
  const level = total >= 100 || high >= 3 ? 'storm' : total > 0 ? 'watch' : 'calm';
  return { level, attackers_15m: total, high_15m: high };
}

// Today's count per gadget (the Ireland calendar day), every gadget listed.
export function gadgetCounts(events, now = Date.now()) {
  const start = irelandDayStart(now);
  const counts = Object.fromEntries(GADGET_IDS.map((id) => [id, 0]));
  for (const e of events) {
    if (Date.parse(e.time) < start) continue;
    counts[e.gadget] = (counts[e.gadget] || 0) + e.count;
    if (e.role === 'attacker' && !e.country_code && e.source !== 'signin' && e.source !== 'screening') counts.fog_wall += e.count;
  }
  return counts;
}

// --- reading -----------------------------------------------------------------------

async function readRows({ supUrl, supKey, fetchImpl }, table, query) {
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(READ_TIMEOUT_MS) : undefined;
  const res = await fetchImpl(`${supUrl}/rest/v1/${table}?${query}`, { headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, Accept: 'application/json' }, signal });
  if (!res || !res.ok) { const err = new Error(`${table} ${res ? res.status : 'no answer'}`); err.status = res ? res.status : 0; throw err; }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

const TELEMETRY_COLS = 'created_at,event_type,endpoint,tool_name,status,mcp_method,caller_hash,caller_kind,is_fixture';

// Each adapter: { id, read(ctx) -> raw events }. A later source (honeypot
// logs, firewall blocks) adds an adapter here with its own classifier;
// until then it is listed with read: null and reported 'idle'.
export const DEFENSE_SOURCES = Object.freeze([
  {
    id: 'telemetry',
    async read(ctx) {
      // Rows that are not an event (an ok handshake or tools/list) are not read.
      const q = (cols) => `select=${cols}&created_at=gte.${encodeURIComponent(ctx.sinceIso)}&not.and=(event_type.in.(initialize,mcp_request),status.eq.ok)&order=created_at.desc&limit=${READ_LIMIT}`;
      let rows;
      try {
        rows = await readRows(ctx, 'agent_telemetry', q(`${TELEMETRY_COLS},country_code`));
      } catch (e) {
        // Before the country_code migration: the same read without it.
        if (e.status !== 400) throw e;
        rows = await readRows(ctx, 'agent_telemetry', q(TELEMETRY_COLS));
      }
      return rows.map((r) => classifyTelemetryRow(r, { signing: ctx.signing }));
    }
  },
  { id: 'verdicts', read: async (ctx) => (await readRows(ctx, 'pg1_defense_events', `select=created_at,check_name,endpoint,verdict_code,reason_codes,severity,subject_kind,country_code,caller_hash&created_at=gte.${encodeURIComponent(ctx.sinceIso)}&order=created_at.desc&limit=${READ_LIMIT}`)).map(classifyVerdictRow) },
  { id: 'screening', read: async (ctx) => (await readRows(ctx, 'pg1_screening_events', `select=created_at,lists&created_at=gte.${encodeURIComponent(ctx.sinceIso)}&order=created_at.desc&limit=500`)).map(classifyScreeningRow) },
  { id: 'signin', read: async (ctx) => (await readRows(ctx, 'pg1_auth_events', `select=created_at,kind&created_at=gte.${encodeURIComponent(ctx.sinceIso)}&order=created_at.desc&limit=${READ_LIMIT}`)).map(classifySigninRow) },
  { id: 'reports', read: async (ctx) => (await readRows(ctx, 'pg1_operator_reports', `select=created_at,kind&created_at=gte.${encodeURIComponent(ctx.sinceIso)}&order=created_at.desc&limit=50`)).map(classifyReportRow) },
  {
    id: 'approvals',
    async read(ctx) {
      const [tasks, actions] = await Promise.all([
        readRows(ctx, 'pg1_operator_tasks', 'select=approval_requested_at,created_at&status=eq.needs_approval&limit=100'),
        readRows(ctx, 'pg1_autonomous_actions', 'select=at&status=eq.needs_approval&limit=100')
      ]);
      return [...tasks.map((r) => classifyApprovalRow(r, 'pg1_operator_tasks')), ...actions.map((r) => classifyApprovalRow(r, 'pg1_autonomous_actions'))];
    }
  },
  { id: 'honeypot', read: null },
  { id: 'firewall', read: null }
]);

// The feed. since (ms): only events at or after it (the poll), else the
// whole 24 h window. Never throws: a source that fails is 'error'.
export async function buildDefenseFeed({ supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), since = null, env = process.env, sources = DEFENSE_SOURCES } = {}) {
  const sinceMs = Number(since);
  const polling = Number.isFinite(sinceMs) && sinceMs > 0;
  // A poll reads only what it needs: from a whole minute before `since`
  // (so the waves it returns are complete) and at least the last 15 minutes
  // (the weather), never more than the 24 h window.
  const windowStart = polling
    ? Math.max(now - DEFENSE_WINDOW_MS, Math.min(Math.floor(sinceMs / WAVE_BUCKET_MS) * WAVE_BUCKET_MS - WAVE_BUCKET_MS, now - 15 * 60 * 1000))
    : now - DEFENSE_WINDOW_MS;
  const ctx = { supUrl, supKey, fetchImpl, sinceIso: new Date(windowStart).toISOString(), signing: !!signingStatus(env).enabled };
  const status = {};
  const raw = [];
  await Promise.all(sources.map(async (s) => {
    if (typeof s.read !== 'function') { status[s.id] = 'idle'; return; }
    if (!supUrl || !supKey) { status[s.id] = 'not_configured'; return; }
    try {
      const got = await s.read(ctx);
      for (const e of got) if (e && e.at >= windowStart && e.at <= now + 60000) raw.push(e);
      status[s.id] = 'ok';
    } catch (e) {
      status[s.id] = 'error';
    }
  }));
  const all = aggregateEvents(raw);
  const events = (polling ? all.filter((e) => Date.parse(e.last) >= sinceMs) : all).slice(0, MAX_EVENTS);
  return {
    ok: true,
    generated_at: new Date(now).toISOString(),
    window_hours: 24,
    poll_ms: DEFENSE_POLL_MS,
    since: polling ? new Date(sinceMs).toISOString() : null,
    events,
    // On a poll the view keeps its own counts (it merges events by id).
    total_events: polling ? null : all.length,
    today: polling ? null : gadgetCounts(all, now),
    threat: threatLevel(all, now),
    sources: status,
    gadgets: GADGETS
  };
}
