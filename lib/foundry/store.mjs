// Storage for the Tool Foundry (supabase/migrations/..._pg1_foundry.sql):
// pg1_foundry_jobs (one row per build request, from screening to deploy)
// and pg1_foundry_tools (deployed tools: the validated plan, never code).

export const FOUNDRY_JOB_TABLE = 'pg1_foundry_jobs';
export const FOUNDRY_TOOL_TABLE = 'pg1_foundry_tools';
export const FOUNDRY_JOB_RETENTION_DAYS = 365;

export function createFoundryStore({ supUrl, supKey, fetchImpl = globalThis.fetch, timeoutMs = 6000 }) {
  if (!supUrl || !supKey) throw Object.assign(new Error('the Foundry needs storage'), { code: 'unavailable' });
  const rest = async (path, options = {}) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { ...options, headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) }, signal: controller.signal, cache: 'no-store' });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`foundry storage ${res.status}`), { status: res.status });
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(t);
    }
  };
  const one = (r) => (Array.isArray(r) ? r[0] || null : r);
  const uuid = (id) => /^[0-9a-f-]{36}$/i.test(String(id || ''));
  return {
    async createJob(row) {
      return one(await rest(`${FOUNDRY_JOB_TABLE}?select=*`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) }));
    },
    async getJob(id) {
      const s = String(id || '').toLowerCase();
      if (uuid(s)) return one(await rest(`${FOUNDRY_JOB_TABLE}?select=*&id=eq.${s}`));
      if (!/^[0-9a-f]{8}$/.test(s)) return null;
      const rows = (await rest(`${FOUNDRY_JOB_TABLE}?select=id&order=created_at.desc&limit=500`)) || [];
      const hits = rows.filter((r) => r.id.startsWith(s));
      return hits.length === 1 ? one(await rest(`${FOUNDRY_JOB_TABLE}?select=*&id=eq.${hits[0].id}`)) : null;
    },
    // Conditional on the current status, so two requests cannot both move a job.
    async updateJob(id, patch, { onlyIfStatus = null } = {}) {
      let url = `${FOUNDRY_JOB_TABLE}?id=eq.${id}&select=*`;
      if (onlyIfStatus) url += `&status=in.(${[].concat(onlyIfStatus).join(',')})`;
      const rows = await rest(url, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
      return Array.isArray(rows) ? rows : [];
    },
    async listJobs({ statuses = null, limit = 30 } = {}) {
      const rows = await rest(`${FOUNDRY_JOB_TABLE}?select=id,created_at,status,spec,visibility,quote,build_fee_usd,per_call_usd,refusal_category,review_reason,classification,lab_experiment_id,tool_id,flagged,credited_usd&order=created_at.desc&limit=${limit}${statuses ? `&status=in.(${statuses.join(',')})` : ''}`);
      return Array.isArray(rows) ? rows : [];
    },
    async createTool(row) {
      return one(await rest(`${FOUNDRY_TOOL_TABLE}?select=*`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) }));
    },
    async getToolByName(name) {
      if (!/^ft_[a-z][a-z0-9_]{2,39}$/.test(String(name || ''))) return null;
      return one(await rest(`${FOUNDRY_TOOL_TABLE}?select=*&name=eq.${name}`));
    },
    async listTools({ publicOnly = false, activeOnly = false } = {}) {
      const rows = await rest(`${FOUNDRY_TOOL_TABLE}?select=*&order=created_at.asc&limit=500${publicOnly ? '&visibility=eq.public' : ''}${activeOnly ? '&status=eq.active' : ''}`);
      return Array.isArray(rows) ? rows : [];
    },
    async updateTool(id, patch) {
      await rest(`${FOUNDRY_TOOL_TABLE}?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    },
    // A wallet credit (shared with A2A jobs: pg1_a2a_credits).
    async credit(payerHash, amountUsd) {
      await rest('rpc/pg1_a2a_credit_add', { method: 'POST', body: JSON.stringify({ p_payer: payerHash, p_amount: amountUsd }) });
    }
  };
}
