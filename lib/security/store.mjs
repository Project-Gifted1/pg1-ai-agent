// Where the operator's sign-in state lives: passkeys (public keys only),
// sessions, used WebAuthn challenges (each works once) and failed-attempt events (the
// lockout and the burst alert). Tables from
// supabase/migrations/20261114120000_pg1_operator_security.sql, service
// role only.
//
// Two stores with the same methods:
//   createSupabaseSecurityStore: the deployment's. Shared by every
//     instance, so a lockout, a revoked session or a removed passkey holds
//     everywhere at once. Methods throw when the database does not answer;
//     lib/security/auth.mjs decides what that means (it fails closed).
//   createMemorySecurityStore: one process only. Used when Supabase is not
//     configured (a local run) and by the test suite.
//
// securityStore() picks one: an override (tests), else Supabase when
// configured, else the process's memory store.

import { getSupabaseCreds } from '../supabase.mjs';

export const PASSKEYS_TABLE = 'pg1_operator_passkeys';
export const SESSIONS_TABLE = 'pg1_operator_sessions';
export const EVENTS_TABLE = 'pg1_auth_events';
export const CHALLENGES_TABLE = 'pg1_auth_challenges';
export const MAX_PASSKEYS = 10;

const PASSKEY_COLUMNS = 'id,credential_id,public_key,algorithm,sign_count,transports,rp_id,name,device,backed_up,created_at,last_used_at';
const SESSION_COLUMNS = 'id_hash,created_at,expires_at,revoked_at,method,device,passkey_id';

export class SecurityStoreError extends Error {}

const iso = (ms) => new Date(ms).toISOString();

export function createSupabaseSecurityStore({ supUrl, supKey, fetchImpl = (u, o) => globalThis.fetch(u, o), timeoutMs = 4000 }) {
  const base = `${String(supUrl).replace(/\/+$/, '')}/rest/v1`;
  const headers = (extra = {}) => ({ apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra });
  const q = (v) => encodeURIComponent(String(v));

  async function call(path, { method = 'GET', body, prefer } = {}) {
    let res;
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    try {
      res = await fetchImpl(`${base}/${path}`, { method, headers: headers(prefer ? { Prefer: prefer } : {}), body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (e) {
      throw new SecurityStoreError('database unreachable');
    }
    if (!res || !res.ok) throw new SecurityStoreError(`database answered ${res ? res.status : 'nothing'}`);
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { throw new SecurityStoreError('database answered non-JSON'); }
  }
  const rows = (v) => (Array.isArray(v) ? v : []);

  return {
    kind: 'supabase',
    async listPasskeys() {
      return rows(await call(`${PASSKEYS_TABLE}?select=${PASSKEY_COLUMNS}&order=created_at.asc&limit=${MAX_PASSKEYS + 5}`));
    },
    async countPasskeys() {
      const r = await call(`${PASSKEYS_TABLE}?select=id&limit=${MAX_PASSKEYS + 5}`);
      if (!Array.isArray(r)) throw new SecurityStoreError('unexpected passkey answer');
      return r.length;
    },
    async getPasskey(credentialId) {
      return rows(await call(`${PASSKEYS_TABLE}?select=${PASSKEY_COLUMNS}&credential_id=eq.${q(credentialId)}&limit=1`))[0] || null;
    },
    async addPasskey(row) {
      return rows(await call(`${PASSKEYS_TABLE}?select=${PASSKEY_COLUMNS}`, { method: 'POST', body: row, prefer: 'return=representation' }))[0] || null;
    },
    async updatePasskey(id, patch) {
      await call(`${PASSKEYS_TABLE}?id=eq.${q(id)}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });
    },
    async removePasskey(id) {
      return rows(await call(`${PASSKEYS_TABLE}?id=eq.${q(id)}&select=id`, { method: 'DELETE', prefer: 'return=representation' })).length > 0;
    },
    // A challenge is single use: its first use inserts its id, a second
    // use hits the primary key. Resolves true the first time, false after.
    async useChallenge(row) {
      let res;
      try {
        res = await fetchImpl(`${base}/${CHALLENGES_TABLE}`, { method: 'POST', headers: headers({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
      } catch (e) { throw new SecurityStoreError('database unreachable'); }
      if (res.ok) return true;
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      if (res.status === 409 || (body && body.code === '23505')) return false;
      throw new SecurityStoreError(`database answered ${res.status}`);
    },
    async createSession(row) {
      await call(SESSIONS_TABLE, { method: 'POST', body: row, prefer: 'return=minimal' });
    },
    async getSession(idHash) {
      return rows(await call(`${SESSIONS_TABLE}?select=${SESSION_COLUMNS}&id_hash=eq.${q(idHash)}&limit=1`))[0] || null;
    },
    // Revokes live sessions: all but `except`, one passkey's, or one.
    async revokeSessions({ except = null, passkeyId = null, idHash = null, nowMs }) {
      const f = ['revoked_at=is.null', `expires_at=gt.${q(iso(nowMs))}`];
      if (except) f.push(`id_hash=neq.${q(except)}`);
      if (passkeyId) f.push(`passkey_id=eq.${q(passkeyId)}`);
      if (idHash) f.push(`id_hash=eq.${q(idHash)}`);
      return rows(await call(`${SESSIONS_TABLE}?${f.join('&')}&select=id_hash`, { method: 'PATCH', body: { revoked_at: iso(nowMs) }, prefer: 'return=representation' })).length;
    },
    async addEvent(row) {
      await call(EVENTS_TABLE, { method: 'POST', body: row, prefer: 'return=minimal' });
    },
    // How many events of a kind since a time (capped at limit, which is
    // all a threshold check needs), for one IP hash or for everyone.
    async countEvents({ kind, ipHash = null, sinceMs, limit }) {
      const f = [`kind=eq.${q(kind)}`, `created_at=gte.${q(iso(sinceMs))}`];
      if (ipHash) f.push(`ip_hash=eq.${q(ipHash)}`);
      const r = await call(`${EVENTS_TABLE}?select=id&${f.join('&')}&limit=${Math.max(1, Math.min(1000, limit | 0))}`);
      if (!Array.isArray(r)) throw new SecurityStoreError('unexpected events answer');
      return r.length;
    },
    async clearFailures(ipHash) {
      await call(`${EVENTS_TABLE}?kind=eq.failure&ip_hash=eq.${q(ipHash)}`, { method: 'DELETE', prefer: 'return=minimal' });
    },
    // Housekeeping after a sign-in: old events, used-up challenges and
    // sessions a day past their end.
    async cleanup(nowMs) {
      await Promise.all([
        call(`${EVENTS_TABLE}?created_at=lt.${q(iso(nowMs - 2 * 86400000))}`, { method: 'DELETE', prefer: 'return=minimal' }),
        call(`${CHALLENGES_TABLE}?expires_at=lt.${q(iso(nowMs))}`, { method: 'DELETE', prefer: 'return=minimal' }),
        call(`${SESSIONS_TABLE}?expires_at=lt.${q(iso(nowMs - 86400000))}`, { method: 'DELETE', prefer: 'return=minimal' })
      ]);
    }
  };
}

export function createMemorySecurityStore() {
  let passkeys = [];
  let sessions = new Map();
  let challenges = new Map();
  let events = [];
  let seq = 0;
  const copy = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
  const live = (s, nowMs) => !s.revoked_at && Date.parse(s.expires_at) > nowMs;
  return {
    kind: 'memory',
    async listPasskeys() { return passkeys.map(copy); },
    async countPasskeys() { return passkeys.length; },
    async getPasskey(credentialId) { return copy(passkeys.find((p) => p.credential_id === credentialId) || null); },
    async addPasskey(row) {
      if (passkeys.some((p) => p.credential_id === row.credential_id)) throw new SecurityStoreError('duplicate credential');
      const r = { id: `pk-${++seq}-${Math.random().toString(16).slice(2, 10)}`, created_at: new Date().toISOString(), last_used_at: null, sign_count: 0, transports: [], backed_up: false, ...copy(row) };
      passkeys.push(r);
      return copy(r);
    },
    async updatePasskey(id, patch) { const p = passkeys.find((x) => x.id === id); if (p) Object.assign(p, copy(patch)); },
    async removePasskey(id) { const n = passkeys.length; passkeys = passkeys.filter((p) => p.id !== id); return passkeys.length < n; },
    async useChallenge(row) {
      if (challenges.has(row.id)) return false;
      challenges.set(row.id, copy(row));
      return true;
    },
    async createSession(row) { sessions.set(row.id_hash, { revoked_at: null, created_at: new Date().toISOString(), ...copy(row) }); },
    async getSession(idHash) { return copy(sessions.get(idHash) || null); },
    async revokeSessions({ except = null, passkeyId = null, idHash = null, nowMs }) {
      let n = 0;
      for (const s of sessions.values()) {
        if (!live(s, nowMs)) continue;
        if (except && s.id_hash === except) continue;
        if (passkeyId && s.passkey_id !== passkeyId) continue;
        if (idHash && s.id_hash !== idHash) continue;
        s.revoked_at = iso(nowMs);
        n++;
      }
      return n;
    },
    async addEvent(row) { events.push({ id: ++seq, created_at: iso(Date.now()), ...copy(row) }); },
    async countEvents({ kind, ipHash = null, sinceMs, limit }) {
      const n = events.filter((e) => e.kind === kind && Date.parse(e.created_at) >= sinceMs && (!ipHash || e.ip_hash === ipHash)).length;
      return Math.min(n, limit);
    },
    async clearFailures(ipHash) { events = events.filter((e) => !(e.kind === 'failure' && e.ip_hash === ipHash)); },
    async cleanup(nowMs) {
      events = events.filter((e) => Date.parse(e.created_at) >= nowMs - 2 * 86400000);
      for (const [k, c] of challenges) if (Date.parse(c.expires_at) < nowMs) challenges.delete(k);
    },
    // Tests and __clearAuthRateLimitState only.
    reset() { passkeys = []; sessions = new Map(); challenges = new Map(); events = []; }
  };
}

const processStore = createMemorySecurityStore();
let override = null;

// Tests only: every caller that does not pass a store gets this one.
// null restores the default.
export function setSecurityStore(store) { override = store || null; }
export function memorySecurityStore() { return processStore; }

export function securityStore({ fetchImpl } = {}) {
  if (override) return override;
  let creds;
  try { creds = getSupabaseCreds(); } catch (e) { return processStore; }
  return createSupabaseSecurityStore({ ...creds, ...(fetchImpl ? { fetchImpl } : {}) });
}
