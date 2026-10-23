// PG1 CORE STATE: one shared workspace every module publishes its state
// and events to, so PG1 (lib/core/self.mjs), the operator (/state) and the
// reflections (lib/core/reflect.mjs) read one picture of what is going on.
//
//   publishCoreState(area, snapshot)        the area's latest snapshot
//   publishCoreEvent(area, { kind, severity, summary, ref })
//   readCoreState({ events })               { areas, events, storage }
//
// Areas: router (engines: status, classified errors, cool-downs), spend
// (today per engine against its cap, confirmed job budgets), autonomy (the
// switch, kill switch, audit), missions, lab (runs and verdicts), feed (the
// feed guardian and the nightly counts), media (films, movies, music:
// status, paused_budget), self_heal, errors (the error log), approvals
// (pending), integrations (MCP, A2A, x402 and external callers' error
// rates: counts only), sandbox (worlds, steps today, quota use, world
// mission errors, running experiments: counts only, labelled simulation;
// never a blind run's content: supabase/migrations/20261110120000_pg1_sandbox.sql
// adds the area to the tables).
//
// Storage: pg1_core_state (one row per area) and pg1_core_events (append
// only, 30 days), service role only
// (supabase/migrations/20261109120000_pg1_core_state.sql). Until that
// migration runs, or without the database, each instance keeps the state
// in memory.
//
// Never in the state: secrets, keys, tokens, client data or request
// content. Every snapshot and event goes through sanitizeCoreValue: keys
// that name such things are dropped, strings are scrubbed (keys, tokens,
// emails, phone numbers, wallet addresses, IP addresses, URLs with a query)
// and capped. A relayed message (/relay) can never write: a chat turn that
// is relayed marks its async context (markRelayTurn) and every write in it
// is refused.

import { AsyncLocalStorage } from 'node:async_hooks';
import { scrub } from '../autonomous/state.mjs';

export const CORE_AREAS = Object.freeze(['router', 'spend', 'autonomy', 'missions', 'lab', 'feed', 'media', 'self_heal', 'errors', 'approvals', 'integrations', 'sandbox']);
export const CORE_SEVERITIES = Object.freeze(['info', 'warning', 'error']);
export const STATE_TABLE = 'pg1_core_state';
export const EVENTS_TABLE = 'pg1_core_events';
export const EVENT_RETENTION_DAYS = 30;
const MEMORY_EVENTS = 300;

// Keys that would carry a secret, client data or request content.
const FORBIDDEN_KEY_RE = /(?:key|token|secret|pass(?:word|kv)?|auth|cookie|session|credential|bearer|signature|prompt|content|body|message|text|input|output|reply|email|phone|ip_?addr|^ip$|wallet|address|payer|caller|customer|client_?(?:name|id|data)|user(?:name|_?id)?$|identifier|query|lyrics|transcript)/i;
const WALLET_RE = /\b0x[0-9a-fA-F]{40}\b|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b|\bbc1[0-9a-z]{25,60}\b/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi;
const URL_QUERY_RE = /\bhttps?:\/\/[^\s?#]+\?[^\s]*/gi;

export function scrubCoreText(value, max = 200) {
  return scrub(String(value == null ? '' : value).replace(URL_QUERY_RE, '[link]').replace(WALLET_RE, '[address]').replace(IPV6_RE, '[ip]').replace(IPV4_RE, '[ip]'), max);
}

// A copy safe to keep: forbidden keys dropped, strings scrubbed, sizes capped.
export function sanitizeCoreValue(value, depth = 0) {
  if (depth > 5) return null;
  if (typeof value === 'string') return scrubCoreText(value, 200);
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => sanitizeCoreValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      if (FORBIDDEN_KEY_RE.test(k)) continue;
      out[String(k).slice(0, 40)] = sanitizeCoreValue(v, depth + 1);
    }
    return out;
  }
  return null;
}

// --- relayed turns never write -------------------------------------------------------

const relayScope = new AsyncLocalStorage();
// One scope per chat request (api/chat.mjs wraps its handler): a relayed
// turn marks its own scope read-only and nothing outside it. Outside a
// scope there is nothing to mark (never enterWith: that would leak the mark
// into the caller and the next request).
export function withCoreScope(fn) { return relayScope.run({ relay: false }, fn); }
export function markRelayTurn() { const s = relayScope.getStore(); if (!s) return false; s.relay = true; return true; }
export function runAsRelay(fn) { return relayScope.run({ relay: true }, fn); }
export const isRelayTurn = () => !!(relayScope.getStore() && relayScope.getStore().relay);

// --- the store -------------------------------------------------------------------------

const memory = { areas: new Map(), events: [], seq: 0 };
export function __resetCoreState() { memory.areas.clear(); memory.events.length = 0; memory.seq = 0; dbMissing.clear(); }
const dbMissing = new Set(); // supUrls whose tables are not there yet

function headers(supKey, extra = {}) {
  return { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra };
}
const missingTable = (status, text) => status === 404 || /42P01|does not exist|schema cache/i.test(String(text || ''));

export function createCoreState({ supUrl = null, supKey = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const db = () => !!(supUrl && supKey && !dbMissing.has(supUrl));
  const rest = async (path, init) => {
    const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { ...init, headers: headers(supKey, init && init.headers) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (missingTable(res.status, text)) dbMissing.add(supUrl);
      throw Object.assign(new Error(`core state ${res.status}`), { status: res.status });
    }
    return res;
  };
  return {
    // { ok, stored } or { ok: false, reason }.
    async publish(area, snapshot) {
      if (isRelayTurn()) return { ok: false, reason: 'relay' };
      if (!CORE_AREAS.includes(area)) return { ok: false, reason: 'unknown_area' };
      const clean = sanitizeCoreValue(snapshot && typeof snapshot === 'object' ? snapshot : {}) || {};
      const at = new Date(now()).toISOString();
      memory.areas.set(area, { snapshot: clean, updated_at: at });
      if (!db()) return { ok: true, stored: 'memory' };
      try {
        await rest(`${STATE_TABLE}?on_conflict=area`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ area, snapshot: clean, updated_at: at }]) });
        return { ok: true, stored: 'database' };
      } catch (e) { return { ok: true, stored: 'memory' }; }
    },
    async event(area, { kind = 'note', severity = 'info', summary = '', ref = null } = {}) {
      if (isRelayTurn()) return { ok: false, reason: 'relay' };
      if (!CORE_AREAS.includes(area)) return { ok: false, reason: 'unknown_area' };
      const row = {
        area,
        kind: scrubCoreText(kind, 40).replace(/[^\w.:-]/g, '_') || 'note',
        severity: CORE_SEVERITIES.includes(severity) ? severity : 'info',
        summary: scrubCoreText(summary, 300) || kind,
        ref: ref == null ? null : scrubCoreText(ref, 120),
        created_at: new Date(now()).toISOString()
      };
      memory.events.push({ id: `m${++memory.seq}`, ...row });
      if (memory.events.length > MEMORY_EVENTS) memory.events.splice(0, memory.events.length - MEMORY_EVENTS);
      if (!db()) return { ok: true, stored: 'memory', event: row };
      try {
        await rest(EVENTS_TABLE, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) });
        return { ok: true, stored: 'database', event: row };
      } catch (e) { return { ok: true, stored: 'memory', event: row }; }
    },
    async read({ events = 30, since = null } = {}) {
      const n = Math.max(0, Math.min(200, events));
      if (db()) {
        try {
          const areas = await (await rest(`${STATE_TABLE}?select=area,snapshot,updated_at`, { method: 'GET' })).json();
          const evs = n ? await (await rest(`${EVENTS_TABLE}?select=id,area,kind,severity,summary,ref,created_at&order=created_at.desc&limit=${n}${since ? `&created_at=gte.${encodeURIComponent(since)}` : ''}`, { method: 'GET' })).json() : [];
          return { areas: Object.fromEntries(areas.map((r) => [r.area, { snapshot: r.snapshot || {}, updated_at: r.updated_at }])), events: evs, storage: 'database' };
        } catch (e) { /* the instance's own copy below */ }
      }
      const evs = memory.events.filter((e) => !since || e.created_at >= since).slice(-n).reverse();
      return { areas: Object.fromEntries(memory.areas), events: evs, storage: 'memory' };
    },
    // Events older than 30 days are deleted (the hourly pulse).
    async prune() {
      const cutoff = new Date(now() - EVENT_RETENTION_DAYS * 86400000).toISOString();
      memory.events = memory.events.filter((e) => e.created_at >= cutoff);
      if (!db()) return { ok: true };
      try { await rest(`${EVENTS_TABLE}?created_at=lt.${encodeURIComponent(cutoff)}`, { method: 'DELETE' }); return { ok: true }; } catch (e) { return { ok: false }; }
    }
  };
}

// The deployment's workspace (service role from the environment, else
// memory). A write never throws and never breaks the caller.
function defaultStore() {
  const supUrl = String(process.env.SUPABASE_URL || '').replace(/\s+/g, '');
  const supKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || '').replace(/\s+/g, '');
  return createCoreState(supUrl && supKey ? { supUrl, supKey } : {});
}
export async function publishCoreState(area, snapshot, store = null) {
  try { return await (store || defaultStore()).publish(area, snapshot); } catch (e) { return { ok: false, reason: 'error' }; }
}
export async function publishCoreEvent(area, event, store = null) {
  try { return await (store || defaultStore()).event(area, event); } catch (e) { return { ok: false, reason: 'error' }; }
}
export async function readCoreState(opts = {}, store = null) {
  return (store || defaultStore()).read(opts);
}
