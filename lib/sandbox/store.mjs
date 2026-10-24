// Sandbox storage (supabase/migrations/20261110120000_pg1_sandbox.sql):
// worlds, their events, invite keys and quotas, consents and experiment
// records. Service role only. Without the database (or before the
// migration runs) the same calls work on this instance's memory, so the
// sandbox and its tests run anywhere.

import crypto from 'node:crypto';

export const TABLES = Object.freeze({
  worlds: 'pg1_worlds', events: 'pg1_world_events', keys: 'pg1_sandbox_keys', usage: 'pg1_sandbox_usage',
  consents: 'pg1_sandbox_consents', runs: 'pg1_experiment_runs', anomalies: 'pg1_experiment_anomalies', log: 'pg1_experiment_log',
  blackbox: 'pg1_world_blackbox'
});
export const EVENT_RETENTION_DAYS = 30;
export const KEY_PREFIX = 'pg1sb_';
export const PG1_OWNER = 'pg1';
export const keyOwner = (keyId) => `key:${keyId}`;

export const hashKey = (key) => crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
export function newSandboxKey() {
  return KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
}
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);
const iso = (now) => new Date(now).toISOString();
const enc = encodeURIComponent;

// --- memory -------------------------------------------------------------------------------

const MEM = { worlds: [], events: [], keys: [], usage: [], consents: [], runs: [], anomalies: [], log: [], blackbox: [], seq: 0 };
export function __resetSandboxMemory() { for (const k of Object.keys(MEM)) if (Array.isArray(MEM[k])) MEM[k].length = 0; MEM.seq = 0; }

function memoryStore({ now }) {
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  return {
    kind: 'memory',
    async createWorld(row) { const w = { id: crypto.randomUUID(), tick: 0, state: null, blind: false, visibility: 'private', created_at: iso(now()), updated_at: iso(now()), ...row }; MEM.worlds.push(w); return clone(w); },
    async getWorld(id) { return clone(MEM.worlds.find((w) => w.id === id) || null); },
    async listWorlds({ owner = null, includeInvited = false } = {}) { return clone(MEM.worlds.filter((w) => !owner || w.owner === owner || (includeInvited && w.visibility === 'invited')).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))); },
    async updateWorld(id, patch) { const w = MEM.worlds.find((x) => x.id === id); if (!w) return null; Object.assign(w, clone(patch), { updated_at: iso(now()) }); return clone(w); },
    async deleteWorld(id) { const i = MEM.worlds.findIndex((w) => w.id === id); if (i < 0) return false; MEM.worlds.splice(i, 1); for (const k of ['events', 'consents']) MEM[k] = MEM[k].filter((e) => e.world_id !== id); return true; },
    async addEvents(worldId, evs) { for (const e of evs) MEM.events.push({ id: ++MEM.seq, world_id: worldId, tick: e.tick, kind: e.kind, summary: e.summary, created_at: iso(now()) }); return evs.length; },
    async listEvents(worldId, { limit = 50 } = {}) { return clone(MEM.events.filter((e) => e.world_id === worldId).sort((a, b) => b.id - a.id).slice(0, limit)); },
    async pruneEvents(cutoffIso) { MEM.events = MEM.events.filter((e) => e.created_at >= cutoffIso); return true; },
    async insertKey(row) { const k = { id: crypto.randomUUID(), scopes: ['sandbox'], max_worlds: 3, max_steps_per_day: 1000, max_storage_kb: 1024, invited_by: 'operator', created_at: iso(now()), revoked_at: null, ...row }; MEM.keys.push(k); return clone(k); },
    async findKeyByHash(h) { return clone(MEM.keys.find((k) => k.key_hash === h) || null); },
    async getKey(id) { return clone(MEM.keys.find((k) => k.id === id) || null); },
    async listKeys() { return clone(MEM.keys.map(({ key_hash, ...k }) => k)); },
    async revokeKey(id) { const k = MEM.keys.find((x) => x.id === id); if (k) k.revoked_at = iso(now()); return !!k; },
    async stepsToday(owner) { const d = utcDay(now()); const r = MEM.usage.find((u) => u.owner === owner && u.day === d); return r ? r.steps : 0; },
    async addSteps(owner, n) { const d = utcDay(now()); let r = MEM.usage.find((u) => u.owner === owner && u.day === d); if (!r) { r = { owner, day: d, steps: 0 }; MEM.usage.push(r); } r.steps += n; return r.steps; },
    async addConsent(row) { const c = { id: crypto.randomUUID(), recorded_at: iso(now()), revoked_at: null, ...row }; MEM.consents.push(c); return clone(c); },
    async revokeConsent(id) { const c = MEM.consents.find((x) => x.id === id); if (c) c.revoked_at = iso(now()); return !!c; },
    async findConsent(keyId, worldId) { return clone(MEM.consents.find((c) => c.key_id === keyId && c.world_id === worldId && !c.revoked_at) || null); },
    async createRun(row) { const r = { id: crypto.randomUUID(), status: 'pending', turns: 0, max_turns: 20, final_answer: null, summary: null, created_at: iso(now()), finished_at: null, ...row }; MEM.runs.push(r); return clone(r); },
    async getRun(id) { return clone(MEM.runs.find((r) => r.id === id) || null); },
    async updateRun(id, patch) { const r = MEM.runs.find((x) => x.id === id); if (!r) return null; Object.assign(r, clone(patch)); return clone(r); },
    async activeRunFor(subject) { return clone(MEM.runs.filter((r) => r.subject === subject && r.status === 'running').sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] || null); },
    async listRuns({ limit = 50, status = null } = {}) { return clone(MEM.runs.filter((r) => !status || r.status === status).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit)); },
    async addAnomalies(rows) { const out = rows.map((a) => ({ id: crypto.randomUUID(), config: {}, shown_turn: null, shown_at: null, position: null, mentioned_turn: null, mentioned_at: null, reasoning: null, ...a })); MEM.anomalies.push(...out); return clone(out); },
    async listAnomalies(runId) { return clone(MEM.anomalies.filter((a) => a.run_id === runId)); },
    async updateAnomaly(id, patch) { const a = MEM.anomalies.find((x) => x.id === id); if (!a) return null; Object.assign(a, clone(patch)); return clone(a); },
    async addLog(runId, entries) { for (const e of entries) MEM.log.push({ id: ++MEM.seq, run_id: runId, turn: e.turn, kind: e.kind, content: String(e.content).slice(0, 4000), created_at: iso(now()) }); return entries.length; },
    async listLog(runId, { limit = 400 } = {}) { return clone(MEM.log.filter((e) => e.run_id === runId).sort((a, b) => a.id - b.id).slice(0, limit)); },
    // The black box (lib/sandbox/blackbox.mjs): append-only.
    async blackboxHead(worldId) { const rows = MEM.blackbox.filter((r) => r.world_id === worldId); return rows.length ? clone(rows[rows.length - 1]) : null; },
    async addBlackbox(rows) {
      for (const r of rows) if (MEM.blackbox.some((x) => x.world_id === r.world_id && x.seq === r.seq)) { const e = new Error('duplicate seq'); e.conflict = true; throw e; }
      for (const r of rows) MEM.blackbox.push({ id: ++MEM.seq, ...clone(r) });
      return rows.length;
    },
    async listBlackbox(worldId, { actor = null, limit = 200, beforeSeq = null } = {}) {
      return clone(MEM.blackbox.filter((r) => r.world_id === worldId && (!actor || r.actor === actor) && (beforeSeq == null || r.seq < beforeSeq)).sort((a, b) => b.seq - a.seq).slice(0, limit));
    },
    async blackboxActors(worldId) { const m = new Map(); for (const r of MEM.blackbox) if (r.world_id === worldId) m.set(r.actor, { actor: r.actor, actor_type: r.actor_type, records: (m.get(r.actor)?.records || 0) + 1 }); return [...m.values()]; },
    async pruneBlackbox(cutoffIso) { MEM.blackbox = MEM.blackbox.filter((r) => r.at >= cutoffIso); return true; }
  };
}

// --- the database -------------------------------------------------------------------------

function restStore({ supUrl, supKey, fetchImpl, now }) {
  const rest = async (path, { method = 'GET', body, prefer } = {}) => {
    const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { method, cache: 'no-store', headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) { const e = new Error(`sandbox store ${res.status}`); e.status = res.status; throw e; }
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  };
  const one = (rows) => (Array.isArray(rows) ? rows[0] || null : rows);
  const W = 'id,owner,name,spec,state,tick,visibility,blind,created_at,updated_at';
  return {
    kind: 'database',
    async createWorld(row) { return one(await rest(TABLES.worlds, { method: 'POST', body: row, prefer: 'return=representation' })); },
    async getWorld(id) { return one(await rest(`${TABLES.worlds}?id=eq.${enc(id)}&select=${W}`)); },
    async listWorlds({ owner = null, includeInvited = false } = {}) {
      const f = owner ? (includeInvited ? `&or=(owner.eq.${enc(owner)},visibility.eq.invited)` : `&owner=eq.${enc(owner)}`) : '';
      return (await rest(`${TABLES.worlds}?select=${W}${f}&order=created_at.desc&limit=200`)) || [];
    },
    async updateWorld(id, patch) { return one(await rest(`${TABLES.worlds}?id=eq.${enc(id)}`, { method: 'PATCH', body: { ...patch, updated_at: iso(now()) }, prefer: 'return=representation' })); },
    async deleteWorld(id) { await rest(`${TABLES.worlds}?id=eq.${enc(id)}`, { method: 'DELETE' }); return true; },
    async addEvents(worldId, evs) { if (!evs.length) return 0; await rest(TABLES.events, { method: 'POST', body: evs.map((e) => ({ world_id: worldId, tick: e.tick, kind: e.kind, summary: e.summary })), prefer: 'return=minimal' }); return evs.length; },
    async listEvents(worldId, { limit = 50 } = {}) { return (await rest(`${TABLES.events}?world_id=eq.${enc(worldId)}&select=id,tick,kind,summary,created_at&order=id.desc&limit=${limit}`)) || []; },
    async pruneEvents(cutoffIso) { await rest(`${TABLES.events}?created_at=lt.${enc(cutoffIso)}`, { method: 'DELETE' }); return true; },
    async insertKey(row) { return one(await rest(TABLES.keys, { method: 'POST', body: row, prefer: 'return=representation' })); },
    async findKeyByHash(h) { return one(await rest(`${TABLES.keys}?key_hash=eq.${enc(h)}&select=*`)); },
    async getKey(id) { return one(await rest(`${TABLES.keys}?id=eq.${enc(id)}&select=*`)); },
    async listKeys() { return (await rest(`${TABLES.keys}?select=id,label,scopes,max_worlds,max_steps_per_day,max_storage_kb,invited_by,created_at,revoked_at&order=created_at.desc`)) || []; },
    async revokeKey(id) { await rest(`${TABLES.keys}?id=eq.${enc(id)}`, { method: 'PATCH', body: { revoked_at: iso(now()) } }); return true; },
    async stepsToday(owner) { const r = one(await rest(`${TABLES.usage}?owner=eq.${enc(owner)}&day=eq.${utcDay(now())}&select=steps`)); return r ? Number(r.steps) || 0 : 0; },
    async addSteps(owner, n) {
      const cur = await this.stepsToday(owner);
      await rest(`${TABLES.usage}?on_conflict=owner,day`, { method: 'POST', body: [{ owner, day: utcDay(now()), steps: cur + n }], prefer: 'resolution=merge-duplicates,return=minimal' });
      return cur + n;
    },
    async addConsent(row) { return one(await rest(TABLES.consents, { method: 'POST', body: row, prefer: 'return=representation' })); },
    async revokeConsent(id) { await rest(`${TABLES.consents}?id=eq.${enc(id)}`, { method: 'PATCH', body: { revoked_at: iso(now()) } }); return true; },
    async findConsent(keyId, worldId) { return one(await rest(`${TABLES.consents}?key_id=eq.${enc(keyId)}&world_id=eq.${enc(worldId)}&revoked_at=is.null&select=*&limit=1`)); },
    async createRun(row) { return one(await rest(TABLES.runs, { method: 'POST', body: row, prefer: 'return=representation' })); },
    async getRun(id) { return one(await rest(`${TABLES.runs}?id=eq.${enc(id)}&select=*`)); },
    async updateRun(id, patch) { return one(await rest(`${TABLES.runs}?id=eq.${enc(id)}`, { method: 'PATCH', body: patch, prefer: 'return=representation' })); },
    async activeRunFor(subject) { return one(await rest(`${TABLES.runs}?subject=eq.${enc(subject)}&status=eq.running&select=*&order=created_at.desc&limit=1`)); },
    async listRuns({ limit = 50, status = null } = {}) { return (await rest(`${TABLES.runs}?select=*${status ? `&status=eq.${enc(status)}` : ''}&order=created_at.desc&limit=${limit}`)) || []; },
    async addAnomalies(rows) { if (!rows.length) return []; return (await rest(TABLES.anomalies, { method: 'POST', body: rows, prefer: 'return=representation' })) || []; },
    async listAnomalies(runId) { return (await rest(`${TABLES.anomalies}?run_id=eq.${enc(runId)}&select=*`)) || []; },
    async updateAnomaly(id, patch) { return one(await rest(`${TABLES.anomalies}?id=eq.${enc(id)}`, { method: 'PATCH', body: patch, prefer: 'return=representation' })); },
    async addLog(runId, entries) { if (!entries.length) return 0; await rest(TABLES.log, { method: 'POST', body: entries.map((e) => ({ run_id: runId, turn: e.turn, kind: e.kind, content: String(e.content).slice(0, 4000) })), prefer: 'return=minimal' }); return entries.length; },
    async listLog(runId, { limit = 400 } = {}) { return (await rest(`${TABLES.log}?run_id=eq.${enc(runId)}&select=id,turn,kind,content,created_at&order=id.asc&limit=${limit}`)) || []; },
    async blackboxHead(worldId) { return one(await rest(`${TABLES.blackbox}?world_id=eq.${enc(worldId)}&select=seq,hash&order=seq.desc&limit=1`)); },
    async addBlackbox(rows) { if (!rows.length) return 0; for (let i = 0; i < rows.length; i += 1000) await rest(TABLES.blackbox, { method: 'POST', body: rows.slice(i, i + 1000), prefer: 'return=minimal' }); return rows.length; },
    async listBlackbox(worldId, { actor = null, limit = 200, beforeSeq = null } = {}) {
      return (await rest(`${TABLES.blackbox}?world_id=eq.${enc(worldId)}${actor ? `&actor=eq.${enc(actor)}` : ''}${beforeSeq != null ? `&seq=lt.${Number(beforeSeq)}` : ''}&select=world_id,seq,actor,actor_type,action,detail,tick,at,prev_hash,hash&order=seq.desc&limit=${Math.min(2000, limit)}`)) || [];
    },
    async blackboxActors(worldId) { return (await rest(`rpc/pg1_blackbox_actors`, { method: 'POST', body: { p_world_id: worldId } })) || []; },
    async pruneBlackbox(cutoffIso) { await rest(`${TABLES.blackbox}?at=lt.${enc(cutoffIso)}`, { method: 'DELETE' }); return true; }
  };
}

export function createSandboxStore({ supUrl = null, supKey = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  return supUrl && supKey ? restStore({ supUrl, supKey, fetchImpl, now }) : memoryStore({ now });
}

// The deployment's store: the service role from the environment, else memory.
export function defaultSandboxStore(env = process.env) {
  const supUrl = String(env.SUPABASE_URL || '').replace(/\s+/g, '');
  const supKey = String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASEAPI_KEY || '').replace(/\s+/g, '');
  return createSandboxStore(supUrl && supKey ? { supUrl, supKey } : {});
}
