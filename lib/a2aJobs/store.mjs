// A2A job storage: public.pg1_a2a_jobs (one row per job, from quote to
// result) and public.pg1_a2a_credits (wallet credits after a failed paid
// job, keyed by a salted hash of the wallet). Service role only. No raw
// caller IP or wallet is stored: caller_hash and payer_hash are salted
// HMACs (lib/telemetry.mjs callerHash).

export const JOB_TABLE = 'pg1_a2a_jobs';
export const CREDIT_TABLE = 'pg1_a2a_credits';
export const ACTIVE_JOB_STATUSES = Object.freeze(['working']);
export const ACCEPTED_JOB_STATUSES = Object.freeze(['working', 'completed', 'failed']);

function headers(supKey, extra = {}) {
  return { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra };
}

export function createJobStore({ supUrl, supKey, fetchImpl = globalThis.fetch, timeoutMs = 6000 }) {
  if (!supUrl || !supKey) throw new Error('jobs need storage');
  const rest = async (path, options = {}) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { ...options, headers: headers(supKey, options.headers), signal: controller.signal, cache: 'no-store' });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`jobs storage ${res.status}`), { status: res.status });
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(t);
    }
  };
  const one = (r) => (Array.isArray(r) ? r[0] || null : r);
  const count = async (query) => {
    const rows = await rest(`${JOB_TABLE}?select=id&${query}&limit=1000`);
    return Array.isArray(rows) ? rows.length : 0;
  };
  return {
    async create(row) {
      return one(await rest(`${JOB_TABLE}?select=*`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) }));
    },
    async get(id) {
      if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
      return one(await rest(`${JOB_TABLE}?select=*&id=eq.${String(id).toLowerCase()}`));
    },
    // Conditional on the current status, so two requests cannot both
    // accept or both finish the same job. [] when it had moved on.
    async update(id, patch, { onlyIfStatus = null } = {}) {
      let url = `${JOB_TABLE}?id=eq.${id}&select=*`;
      if (onlyIfStatus) url += `&status=in.(${[].concat(onlyIfStatus).join(',')})`;
      const rows = await rest(url, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
      return Array.isArray(rows) ? rows : [];
    },
    activeCount: () => count(`status=in.(${ACTIVE_JOB_STATUSES.join(',')})`),
    activeForPayer: (payerHash) => count(`payer_hash=eq.${payerHash}&status=in.(${ACTIVE_JOB_STATUSES.join(',')})`),
    acceptedForPayerSince: (payerHash, sinceIso) => count(`payer_hash=eq.${payerHash}&status=in.(${ACCEPTED_JOB_STATUSES.join(',')})&accepted_at=gte.${encodeURIComponent(sinceIso)}`),
    async list({ sinceIso = null, limit = 50 } = {}) {
      const rows = await rest(`${JOB_TABLE}?select=id,created_at,updated_at,job_type,status,items,price_usd,worst_cost_usd,cost_usd,payment,attempts,error,credited_usd,flagged&order=created_at.desc&limit=${limit}${sinceIso ? `&created_at=gte.${encodeURIComponent(sinceIso)}` : ''}`);
      return Array.isArray(rows) ? rows : [];
    },
    // Completed write-ups whose analysis is still pending (no AI engine was
    // available when they ran): lib/a2aJobs/jobs.mjs backfillPendingWriteups.
    async pendingWriteups({ limit = 5 } = {}) {
      const rows = await rest(`${JOB_TABLE}?select=*&status=eq.completed&job_type=eq.threat_writeup_pdf&result->>ai_summary=eq.pending&order=created_at.asc&limit=${limit}`);
      return Array.isArray(rows) ? rows : [];
    },
    async creditBalance(payerHash) {
      const r = one(await rest(`${CREDIT_TABLE}?select=balance_usd&payer_hash=eq.${payerHash}`));
      return r ? Number(r.balance_usd) || 0 : 0;
    },
    async addCredit(payerHash, usd) {
      const r = one(await rest('rpc/pg1_a2a_credit_add', { method: 'POST', body: JSON.stringify({ p_payer: payerHash, p_amount: usd }) }));
      return r ? Number(r.balance_usd ?? r.pg1_a2a_credit_add ?? r) || 0 : 0;
    },
    // Takes `usd` from the wallet's credit only when it covers it all.
    async useCredit(payerHash, usd) {
      const r = one(await rest('rpc/pg1_a2a_credit_use', { method: 'POST', body: JSON.stringify({ p_payer: payerHash, p_amount: usd }) }));
      return !!(r && (r.used === true || r.pg1_a2a_credit_use === true || r === true));
    }
  };
}
