// /api/opportunities/weekly: the weekly opportunity scan and the weekly
// report (vercel.json crons, Mondays 07:30 UTC; lib/opportunities.mjs,
// lib/operator/run.mjs). Reads the last 7 days of usage as
// aggregates and starts one lab research experiment; the kill switch, the
// lab budgets and the audit log apply. CRON_SECRET auth (lib/cronAuth.mjs).

import { getSupabaseCreds } from '../../lib/supabase.mjs';
import { checkCronAuth } from '../../lib/cronAuth.mjs';
import { refreshAutonomousSnapshot } from '../../lib/autonomous/state.mjs';
import { runOpportunityScan } from '../../lib/opportunities.mjs';
import { getUsageStats } from '../../lib/usageStats.mjs';
import { runReport } from '../../lib/operator/run.mjs';
import { createOpportunityStore } from '../../lib/opportunities.mjs';
import { createLabStore } from '../../lib/lab/store.mjs';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.status === 401 ? 'Unauthorized scan request' : auth.error });
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch (e) {
    return res.status(503).json({ error: 'Storage not configured on this deployment.' });
  }
  // AUTONOMOUS MODE: the operator's switch is read before PG1 acts on its own.
  await refreshAutonomousSnapshot(creds).catch(() => false);
  const out = await runOpportunityScan({ supUrl: creds.supUrl, supKey: creds.supKey, getStats: (o) => getUsageStats(o) });
  // THE WEEKLY REPORT (lib/operator/run.mjs), Mondays 07:30 UTC with the scan.
  let report = null;
  try {
    report = await runReport({
      kind: 'weekly', supUrl: creds.supUrl, supKey: creds.supKey, getStats: (o) => getUsageStats(o),
      deps: { skipSnapshot: true, labHistory: () => createLabStore(creds).history(100), proposals: () => createOpportunityStore(creds).list(20) }
    });
  } catch (e) { report = { ok: false, reason: 'failed' }; }
  return res.status(200).json({ ok: out.ok, started: out.ok ? out.id : null, message: out.reply, report: report ? { ok: report.ok, id: report.id || null, reason: report.ok ? null : report.reason } : null });
}
