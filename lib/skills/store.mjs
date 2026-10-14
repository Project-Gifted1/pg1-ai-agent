// PG1 skills storage: public.pg1_skills (the current version of each
// skill), public.pg1_skill_versions (every version ever saved, for history
// and rollback) and public.pg1_skill_signals (hashed request fingerprints
// for the "3 similar requests" suggestion, kept 30 days). Service role
// only, through PostgREST.
//
// Every save runs checkSkill (lib/skills/skill.mjs) first, so nothing
// unchecked is ever stored. A change to the instructions, description,
// tools or evals makes a new version; a change to an active skill puts it
// back to draft, so the operator approves the new text before it is used.

import { checkSkill, SkillError, SKILL_STATUSES } from './skill.mjs';

export const SKILL_TABLE = 'pg1_skills';
export const SKILL_VERSION_TABLE = 'pg1_skill_versions';
export const SKILL_SIGNAL_TABLE = 'pg1_skill_signals';
export const SIGNAL_RETENTION_DAYS = 30;
export const SIMILAR_REQUESTS_THRESHOLD = 3;
const COLUMNS = 'id,name,description,instructions,allowed_tools,evals,version,status,origin,untrusted,uses,successes,last_used_at,created_at,updated_at';

function headers(supKey, extra = {}) {
  return { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra };
}

export function createSkillStore({ supUrl, supKey, fetchImpl = globalThis.fetch, guard = null, timeoutMs = 8000 }) {
  if (!supUrl || !supKey) throw new SkillError('Skills need the vault (Supabase), which is not configured on this deployment.', 'not_configured');
  const rest = async (path, options = {}) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { ...options, headers: headers(supKey, options.headers), signal: controller.signal, cache: 'no-store' });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`skills storage ${res.status}`);
        err.status = res.status;
        err.detail = text.slice(0, 200);
        throw err;
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(t);
    }
  };
  const one = (rows) => (Array.isArray(rows) ? rows[0] || null : rows);

  const store = {
    async list({ status = null } = {}) {
      const rows = await rest(`${SKILL_TABLE}?select=${COLUMNS}${status ? `&status=eq.${encodeURIComponent(status)}` : ''}&order=name.asc&limit=200`);
      return Array.isArray(rows) ? rows : [];
    },
    async get(name) {
      const n = String(name || '').toLowerCase();
      if (!/^[a-z0-9-]{3,48}$/.test(n)) return null;
      return one(await rest(`${SKILL_TABLE}?select=${COLUMNS}&name=eq.${n}`));
    },
    async versions(skillId) {
      const rows = await rest(`${SKILL_VERSION_TABLE}?select=version,name,description,instructions,allowed_tools,evals,change_note,created_at&skill_id=eq.${encodeURIComponent(skillId)}&order=version.desc&limit=50`);
      return Array.isArray(rows) ? rows : [];
    },
    async addVersion(skill, changeNote) {
      await rest(SKILL_VERSION_TABLE, {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ skill_id: skill.id, version: skill.version, name: skill.name, description: skill.description, instructions: skill.instructions, allowed_tools: skill.allowed_tools, evals: skill.evals, change_note: String(changeNote || '').slice(0, 200) })
      });
    },
    // A new skill (draft unless `status` says lab). Throws SkillError.
    async create(input, { status = 'draft', changeNote = 'created' } = {}) {
      const checked = checkSkill(input, { guard });
      if (await store.get(checked.name)) throw new SkillError(`A skill called ${checked.name} already exists; edit it instead.`, 'exists');
      const row = one(await rest(`${SKILL_TABLE}?select=${COLUMNS}`, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ ...checked, version: 1, status: status === 'lab' ? 'lab' : 'draft' })
      }));
      await store.addVersion(row, changeNote);
      return row;
    },
    // A new version with `patch` applied to the editable fields. An active
    // skill goes back to draft until it is approved again.
    async edit(name, patch, { changeNote = 'edited' } = {}) {
      const cur = await store.get(name);
      if (!cur) throw new SkillError(`There is no skill called ${name}.`, 'not_found');
      const checked = checkSkill({ ...cur, ...patch, name: cur.name, origin: patch.origin || cur.origin, untrusted: cur.untrusted || patch.untrusted === true }, { guard });
      const next = { description: checked.description, instructions: checked.instructions, allowed_tools: checked.allowed_tools, evals: checked.evals, untrusted: checked.untrusted, version: cur.version + 1, status: cur.status === 'active' ? 'draft' : cur.status, updated_at: new Date().toISOString() };
      const row = one(await rest(`${SKILL_TABLE}?id=eq.${cur.id}&version=eq.${cur.version}&select=${COLUMNS}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(next) }));
      if (!row) throw new SkillError('The skill changed while you were editing it; try again.', 'conflict');
      await store.addVersion(row, changeNote);
      return row;
    },
    async setStatus(name, status) {
      if (!SKILL_STATUSES.includes(status)) throw new SkillError(`Unknown status ${status}.`);
      const cur = await store.get(name);
      if (!cur) throw new SkillError(`There is no skill called ${name}.`, 'not_found');
      return one(await rest(`${SKILL_TABLE}?id=eq.${cur.id}&select=${COLUMNS}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status, updated_at: new Date().toISOString() }) }));
    },
    // Restores version `version`'s text as a new version (draft).
    async rollback(name, version) {
      const cur = await store.get(name);
      if (!cur) throw new SkillError(`There is no skill called ${name}.`, 'not_found');
      const old = (await store.versions(cur.id)).find((v) => v.version === Number(version));
      if (!old) throw new SkillError(`${name} has no version ${version}.`, 'not_found');
      const row = await store.edit(name, { description: old.description, instructions: old.instructions, allowed_tools: old.allowed_tools, evals: old.evals }, { changeNote: `rollback to version ${old.version}` });
      return row.status === 'active' ? row : await store.setStatus(name, 'draft');
    },
    async recordUse(name, { success = true } = {}) {
      const cur = await store.get(name);
      if (!cur) return null;
      return one(await rest(`${SKILL_TABLE}?id=eq.${cur.id}&select=name,uses,successes`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ uses: (cur.uses || 0) + 1, successes: (cur.successes || 0) + (success ? 1 : 0), last_used_at: new Date().toISOString() }) }));
    },
    // The "similar requests" counter: one row per successful request with
    // no skill loaded, the keywords' hash only. Resolves to how many rows
    // share this fingerprint in the last SIGNAL_RETENTION_DAYS.
    async recordSignal(fingerprint, { now = Date.now() } = {}) {
      if (!/^[0-9a-f]{64}$/.test(String(fingerprint))) return 0;
      await rest(SKILL_SIGNAL_TABLE, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ fingerprint }) });
      const since = new Date(now - SIGNAL_RETENTION_DAYS * 86400000).toISOString();
      const rows = await rest(`${SKILL_SIGNAL_TABLE}?select=id&fingerprint=eq.${fingerprint}&created_at=gte.${encodeURIComponent(since)}&limit=50`);
      return Array.isArray(rows) ? rows.length : 0;
    }
  };
  return store;
}

// Signals past SIGNAL_RETENTION_DAYS (lib/retention.mjs).
export async function purgeExpiredSkillSignals({ supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!supUrl || !supKey) return { ok: false, skipped: 'not configured' };
  const cutoff = new Date(now - SIGNAL_RETENTION_DAYS * 86400000).toISOString();
  try {
    const res = await fetchImpl(`${supUrl}/rest/v1/${SKILL_SIGNAL_TABLE}?created_at=lt.${encodeURIComponent(cutoff)}`, { method: 'DELETE', headers: headers(supKey, { Prefer: 'return=minimal' }) });
    return res.ok ? { ok: true } : { ok: false, status: res.status };
  } catch (e) {
    return { ok: false, error: 'unreachable' };
  }
}

// The active skills for the chat prompt, cached per instance for
// ACTIVE_CACHE_MS so a chat message adds no storage round trip most of the
// time. [] on any failure (the chat then simply has no skills).
export const ACTIVE_CACHE_MS = 60000;
let activeCache = { at: 0, key: '', rows: [] };
export function __clearActiveSkillsCache() {
  activeCache = { at: 0, key: '', rows: [] };
}
export async function activeSkills({ supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 2500 } = {}) {
  if (!supUrl || !supKey) return [];
  if (activeCache.key === supUrl && now - activeCache.at < ACTIVE_CACHE_MS) return activeCache.rows;
  try {
    const rows = await createSkillStore({ supUrl, supKey, fetchImpl, timeoutMs }).list({ status: 'active' });
    activeCache = { at: now, key: supUrl, rows };
    return rows;
  } catch (e) {
    return [];
  }
}
