// Retention for the tables and files added by the PG1 master upgrade: one
// list of jobs the daily cleanup (api/errors/cleanup.mjs) runs after its
// own. Each job deletes only what is past its limit and never throws; a
// failure is reported in the cleanup's JSON and does not stop the others.

import { getSupabaseCreds } from './supabase.mjs';
import { purgeExpiredDocuments } from './pdf/store.mjs';
import { purgeExpiredSkillSignals } from './skills/store.mjs';

export const RETENTION_JOBS = Object.freeze([
  { name: 'documents', run: (ctx) => purgeExpiredDocuments(ctx) },
  { name: 'skill_signals', run: (ctx) => purgeExpiredSkillSignals(ctx) }
]);

export async function runRetentionJobs({ fetchImpl = globalThis.fetch, now = Date.now(), jobs = RETENTION_JOBS } = {}) {
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch (e) {
    return { ok: false, skipped: 'not configured' };
  }
  const out = {};
  for (const job of jobs) {
    try {
      out[job.name] = await job.run({ supUrl: creds.supUrl, supKey: creds.supKey, fetchImpl, now });
    } catch (e) {
      out[job.name] = { ok: false, error: 'failed' };
    }
  }
  return out;
}
