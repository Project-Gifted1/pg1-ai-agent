// Retention for the tables and files added by the PG1 master upgrade: one
// list of jobs the daily cleanup (api/errors/cleanup.mjs) runs after its
// own. Each job deletes only what is past its limit and never throws; a
// failure is reported in the cleanup's JSON and does not stop the others.

import { getSupabaseCreds } from './supabase.mjs';
import { purgeExpiredDocuments } from './pdf/store.mjs';
import { purgeExpiredSkillSignals } from './skills/store.mjs';
import { logAutonomy } from './autonomy.mjs';
import { purgeA2aOutputs, A2A_JOB_RETENTION_DAYS } from './a2aJobs/admin.mjs';
import { WATCHLIST_TABLE, WATCHLIST_RETENTION_DAYS } from './watchlists.mjs';
import { FOUNDRY_JOB_TABLE, FOUNDRY_JOB_RETENTION_DAYS } from './foundry/store.mjs';
import { SCREENING_EVENT_TABLE, SCREENING_EVENT_RETENTION_DAYS } from './screening.mjs';

// Rows older than `days` by `column` (no files attached).
export function purgeOlderThan(table, column, days, extraFilter = '') {
  return async ({ supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now() }) => {
    const cutoff = new Date(now - days * 86400000).toISOString();
    try {
      const res = await fetchImpl(`${supUrl}/rest/v1/${table}?${column}=lt.${encodeURIComponent(cutoff)}${extraFilter ? `&${extraFilter}` : ''}`, { method: 'DELETE', headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, Prefer: 'return=minimal' } });
      return res.ok ? { ok: true } : { ok: false, status: res.status };
    } catch (e) {
      return { ok: false, error: 'unreachable' };
    }
  };
}

// The audit log's own purge function (append-only table; rows > 365 days).
async function purgeAutonomyLog({ supUrl, supKey, fetchImpl = globalThis.fetch }) {
  try {
    const res = await fetchImpl(`${supUrl}/rest/v1/rpc/pg1_autonomy_log_purge`, { method: 'POST', headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json' }, body: '{}' });
    return res.ok ? { ok: true } : { ok: false, status: res.status };
  } catch (e) {
    return { ok: false, error: 'unreachable' };
  }
}

export const RETENTION_JOBS = Object.freeze([
  { name: 'documents', run: (ctx) => purgeExpiredDocuments(ctx) },
  { name: 'skill_signals', run: (ctx) => purgeExpiredSkillSignals(ctx) },
  { name: 'lab_experiments', run: purgeOlderThan('pg1_lab_experiments', 'created_at', 180) },
  { name: 'autonomy_log', run: purgeAutonomyLog },
  { name: 'opportunities', run: purgeOlderThan('pg1_opportunities', 'created_at', 365) },
  { name: 'a2a_outputs', run: purgeA2aOutputs },
  { name: 'a2a_jobs', run: purgeOlderThan('pg1_a2a_jobs', 'created_at', A2A_JOB_RETENTION_DAYS) },
  // Watchlists (and their items, by cascade) 30 days after they expire.
  { name: 'watchlists', run: purgeOlderThan(WATCHLIST_TABLE, 'expires_at', WATCHLIST_RETENTION_DAYS) },
  // Foundry requests after a year, except those behind a deployed tool.
  // Screening refusals (hashed): 5 years, as evidence of screening.
  { name: 'screening_events', run: purgeOlderThan(SCREENING_EVENT_TABLE, 'created_at', SCREENING_EVENT_RETENTION_DAYS) },
  { name: 'foundry_jobs', run: purgeOlderThan(FOUNDRY_JOB_TABLE, 'created_at', FOUNDRY_JOB_RETENTION_DAYS, 'status=neq.deployed&tool_id=is.null') }
]);

export async function runRetentionJobs({ fetchImpl = globalThis.fetch, now = Date.now(), jobs = RETENTION_JOBS } = {}) {
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch (e) {
    return { ok: false, skipped: 'not configured' };
  }
  const out = {};
  // Housekeeping is a safety action: it runs whatever PG1_AUTONOMY says,
  // and the run itself is on the audit log.
  await logAutonomy({ supUrl: creds.supUrl, supKey: creds.supKey, fetchImpl }, { action: 'retention:purge', decision: 'allowed', detail: `${jobs.length} jobs` });
  for (const job of jobs) {
    try {
      out[job.name] = await job.run({ supUrl: creds.supUrl, supKey: creds.supKey, fetchImpl, now });
    } catch (e) {
      out[job.name] = { ok: false, error: 'failed' };
    }
  }
  return out;
}
