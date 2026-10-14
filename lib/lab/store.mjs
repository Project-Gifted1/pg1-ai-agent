// Lab storage: public.pg1_lab_experiments (one row per experiment: kind,
// goal, budget and spend, the run, the result, the candidate, the gate's
// evidence) and the lab's spend on the shared usage ledger
// (public.pg1_ai_usage, task 'lab'). Service role only.

import { LAB_TASK } from './policy.mjs';

export const LAB_TABLE = 'pg1_lab_experiments';
export const ACTIVE_LAB_STATUSES = Object.freeze(['queued', 'running']);

function headers(supKey, extra = {}) {
  return { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra };
}

export function createLabStore({ supUrl, supKey, fetchImpl = globalThis.fetch }) {
  if (!supUrl || !supKey) throw new Error('The lab needs the vault (Supabase), which is not configured on this deployment.');
  const rest = async (path, options = {}) => {
    const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { ...options, headers: headers(supKey, options.headers), cache: 'no-store' });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`lab storage ${res.status}`), { status: res.status });
    return text ? JSON.parse(text) : null;
  };
  const one = (r) => (Array.isArray(r) ? r[0] || null : r);
  const store = {
    async create(row) {
      return one(await rest(`${LAB_TABLE}?select=*`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) }));
    },
    async get(id) {
      const s = String(id || '').toLowerCase();
      if (/^[0-9a-f-]{36}$/.test(s)) return one(await rest(`${LAB_TABLE}?select=*&id=eq.${s}`));
      if (!/^[0-9a-f]{8}$/.test(s)) return null;
      const rows = (await store.list(100)).filter((r) => r.id.startsWith(s));
      return rows.length === 1 ? store.get(rows[0].id) : null;
    },
    async list(limit = 10) {
      const rows = await rest(`${LAB_TABLE}?select=id,created_at,updated_at,kind,goal,status,budget_usd,spent_usd,run_id,candidate,gate,promoted_stage,approval_token,error&order=created_at.desc&limit=${Math.max(1, Math.min(100, limit))}`);
      return Array.isArray(rows) ? rows : [];
    },
    async active() {
      const rows = await rest(`${LAB_TABLE}?select=id,budget_usd,status&status=in.(${ACTIVE_LAB_STATUSES.join(',')})&limit=100`);
      return Array.isArray(rows) ? rows : [];
    },
    async update(id, patch) {
      return one(await rest(`${LAB_TABLE}?id=eq.${id}&select=*`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) }));
    },
    // Lab spend recorded on the ledger today (UTC).
    async spentToday(day) {
      const rows = await rest(`pg1_ai_usage?select=cost_usd&task=eq.${LAB_TASK}&day=eq.${day}&limit=5000`);
      return (Array.isArray(rows) ? rows : []).reduce((n, r) => n + (Number(r.cost_usd) || 0), 0);
    },
    // One ledger row per finished experiment: the spend the runner measured.
    async recordSpend({ experimentId, spentUsd, provider = 'lab', day }) {
      if (!(spentUsd > 0)) return;
      await rest('pg1_ai_usage', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ day, provider, model: 'lab', task: LAB_TASK, data_class: 'operator', cost_usd: Number(spentUsd.toFixed(6)), request_id: `lab:${String(experimentId).slice(0, 36)}` }) });
    },
    async createPendingAction({ actionType, plan, diffSummary, ttlMinutes = 7 * 24 * 60 }) {
      const token = globalThis.crypto.randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlMinutes * 60000).toISOString();
      await rest('pending_actions', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ token, action_type: actionType, plan, diff_summary: String(diffSummary || '').slice(0, 20000), status: 'pending', created_at: now.toISOString(), expires_at: expiresAt }]) });
      return { token, expiresAt };
    }
  };
  return store;
}
