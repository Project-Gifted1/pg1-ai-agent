// The operator's view of A2A jobs: /a2a jobs, /a2a job <id>, the "A2A
// jobs" section of /usage, and the retention jobs (jobs deleted after 30
// days, output files after 7). Aggregates and job ids only: never a caller
// or a wallet.

import { createJobStore, JOB_TABLE } from './store.mjs';
import { VIDEO_BUCKET } from '../videoJobs.mjs';
import { JOB_TTL_DAYS } from './jobs.mjs';

const $ = (n) => { const v = Math.round((Number(n) || 0) * 10000) / 10000; return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(v && Math.abs(v) < 1 ? 4 : 2)}`; };

// Per job type: jobs, success rate, revenue (x402-settled), cost, credits
// issued, margin (revenue - cost - credits).
export function a2aJobsSummary(rows) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!['working', 'completed', 'failed'].includes(r.status)) continue;
    const t = by.get(r.job_type) || { job_type: r.job_type, jobs: 0, completed: 0, failed: 0, revenue_usd: 0, cost_usd: 0, credits_usd: 0, free_tier: 0 };
    t.jobs++;
    if (r.status === 'completed') t.completed++;
    if (r.status === 'failed') t.failed++;
    if (r.payment === 'x402') t.revenue_usd += Number(r.price_usd) || 0;
    if (r.payment === 'free_tier') t.free_tier++;
    t.cost_usd += Number(r.cost_usd) || 0;
    t.credits_usd += Number(r.credited_usd) || 0;
    by.set(r.job_type, t);
  }
  return [...by.values()].map((t) => ({ ...t, success_rate: t.completed + t.failed ? t.completed / (t.completed + t.failed) : null, margin_usd: t.revenue_usd - t.cost_usd - t.credits_usd })).sort((a, b) => b.jobs - a.jobs);
}

export function a2aJobsSection(rows, { periodLabel = 'the last 7 days' } = {}) {
  const s = a2aJobsSummary(rows);
  const quoted = (rows || []).filter((r) => r.status === 'quoted' || r.status === 'expired').length;
  if (!s.length) return `### A2A jobs\nNo accepted jobs in ${periodLabel}${quoted ? ` (${quoted} quote${quoted === 1 ? '' : 's'} not paid)` : ''}.`;
  return [
    '### A2A jobs',
    `${periodLabel}; revenue is x402-settled jobs, margin is revenue minus cost minus credits issued.${quoted ? ` ${quoted} quote${quoted === 1 ? '' : 's'} not paid.` : ''}`,
    '',
    '| Job type | Jobs | Success | Revenue | Cost | Credits | Margin | Free tier |',
    '|---|---|---|---|---|---|---|---|',
    ...s.map((t) => `| ${t.job_type} | ${t.jobs} | ${t.success_rate == null ? '-' : `${Math.round(t.success_rate * 100)}%`} | ${$(t.revenue_usd)} | ${$(t.cost_usd)} | ${$(t.credits_usd)} | ${$(t.margin_usd)} | ${t.free_tier} |`)
  ].join('\n');
}

export function isA2aCommand(text) {
  return /^\/a2a(?:\s|$)/i.test(String(text || '').trim());
}

export async function handleA2aCommand({ text, supUrl, supKey, fetchImpl = globalThis.fetch, isOperator = false }) {
  if (isOperator !== true) return { reply: 'A2A job details are for the signed-in operator only.' };
  const m = /^\/a2a\s*(\S*)\s*(\S*)/i.exec(String(text || '').trim());
  const sub = (m[1] || 'jobs').toLowerCase();
  try {
    const store = createJobStore({ supUrl, supKey, fetchImpl });
    if (sub === 'jobs') {
      const rows = await store.list({ limit: 20 });
      if (!rows.length) return { reply: 'No A2A jobs yet.' };
      return { reply: ['### [ A2A JOBS ]', ...rows.map((r) => `- ${r.id.slice(0, 8)} · ${r.job_type} · ${r.status} · ${r.items} item${r.items === 1 ? '' : 's'} · ${$(r.price_usd)}${r.payment ? ` · ${r.payment}` : ''}${r.flagged ? ' · **flagged**' : ''}`), '', '/a2a job <id> for one job'].join('\n') };
    }
    if (sub === 'job') {
      const id = (m[2] || '').toLowerCase();
      const rows = await store.list({ limit: 200 });
      const hit = rows.filter((r) => r.id.startsWith(id));
      if (!id || hit.length !== 1) return { reply: `There is no single A2A job ${id || '(no id)'}. /a2a jobs lists them.` };
      const j = await store.get(hit[0].id);
      return { reply: [
        `### [ A2A JOB ${j.id.slice(0, 8)} ]`,
        `- **Type**: ${j.job_type} · ${j.items} item${j.items === 1 ? '' : 's'} · **status** ${j.status}${j.flagged ? ' · **flagged for you**' : ''}`,
        `- **Price**: ${$(j.price_usd)} (worst-case cost ${$(j.worst_cost_usd)}) · paid by ${j.payment || 'not paid'}${j.settlement && j.settlement.transaction ? ` · tx ${j.settlement.transaction}` : ''}`,
        `- **Attempts**: ${j.attempts}${j.error ? ` · error ${j.error}` : ''}${Number(j.credited_usd) ? ` · ${$(j.credited_usd)} credited to the wallet (no on-chain refund)` : ''}`,
        `- **Created** ${String(j.created_at).slice(0, 16).replace('T', ' ')} UTC${j.output_expires_at ? ` · outputs until ${String(j.output_expires_at).slice(0, 10)}` : ''}`
      ].join('\n') };
    }
    return { reply: 'Use /a2a jobs or /a2a job <id>.' };
  } catch (e) {
    return { reply: 'A2A jobs could not be read right now.' };
  }
}

// Retention: output files after their expiry, jobs after 30 days.
export async function purgeA2aOutputs({ supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const h = { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json' };
  try {
    const res = await fetchImpl(`${supUrl}/rest/v1/${JOB_TABLE}?select=id,artifacts&output_expires_at=lt.${encodeURIComponent(new Date(now).toISOString())}&artifacts=not.is.null&limit=500`, { headers: h });
    if (!res.ok) return { ok: false, status: res.status };
    const rows = await res.json();
    const paths = rows.flatMap((r) => (Array.isArray(r.artifacts) ? r.artifacts : []).map((a) => a.path)).filter((p) => /^(?:a2a|documents)\//.test(String(p)));
    if (paths.length) {
      const del = await fetchImpl(`${supUrl}/storage/v1/object/${VIDEO_BUCKET}`, { method: 'DELETE', headers: h, body: JSON.stringify({ prefixes: paths }) });
      if (!del.ok) return { ok: false, status: del.status };
    }
    for (const r of rows) await fetchImpl(`${supUrl}/rest/v1/${JOB_TABLE}?id=eq.${r.id}`, { method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ artifacts: null, result: null }) });
    return { ok: true, outputs: rows.length };
  } catch (e) {
    return { ok: false, error: 'unreachable' };
  }
}

export const A2A_JOB_RETENTION_DAYS = JOB_TTL_DAYS;
