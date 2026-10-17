import { checkCronAuth } from '../../lib/cronAuth.mjs';
import { sharedLedger, spendSummary, utcDay } from '../../lib/aiRouter.mjs';

// AI SPEND: the first pulse of each UTC day logs yesterday's estimated
// spend per PG1 engine (the operator's daily summary, also on demand with
// /spend yesterday in the chat). Labels and figures only, never content.
export async function logDailySpend(now = Date.now(), log = console.log) {
  if (new Date(now).getUTCHours() !== 0) return null;
  const supUrl = (process.env.SUPABASE_URL || '').replace(/\s+/g, '');
  const supKey = (process.env.SUPABASEAPI_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLEKEY || '').replace(/\s+/g, '');
  const ledger = sharedLedger({ supUrl, supKey, fetchImpl: (u, o) => globalThis.fetch(u, o) });
  const summary = await spendSummary({ env: process.env, ledger, day: utcDay(now - 24 * 60 * 60 * 1000) });
  log(`[PG1-AGENT:SPEND] ${summary.replace(/\n/g, ' | ')}`);
  return summary;
}

// WRITE-UPS: A2A threat write-ups that completed while no AI engine was
// available get their analysis now (lib/a2aJobs/jobs.mjs
// backfillPendingWriteups), a few per pulse. Customer data: paid engines
// only, never the free key. Without storage it does nothing.
export async function backfillWriteups({ env = process.env, limit = 3, load = null } = {}) {
  const supUrl = (env.SUPABASE_URL || '').replace(/\s+/g, '');
  const supKey = (env.SUPABASEAPI_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLEKEY || '').replace(/\s+/g, '');
  if (!supUrl || !supKey) return null;
  const { jobs, svc } = load ? await load() : { jobs: await import('../../lib/a2aJobs/jobs.mjs'), svc: await import('../../lib/a2aJobs/service.mjs') };
  const store = jobs.createJobStore({ supUrl, supKey });
  const outputs = svc.outputStorage({ supUrl, supKey, env });
  const model = svc.jobModel({ env });
  return jobs.backfillPendingWriteups({
    store, limit,
    execDeps: { guard: svc.jobGuard(env), makePdf: (doc) => outputs.makePdf(doc), writeModel: (m) => model.write(m) },
    storeOutputs: (j, out) => outputs.storeOutputs(j, out)
  });
}

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = checkCronAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.status === 401 ? 'Unauthorized pulse request' : auth.error });
  }

  try {
    const timestamp = new Date().toISOString();
    console.log(`[PG1-AGENT:HEARTBEAT] Pulse logged at ${timestamp}`);
    try { await logDailySpend(); } catch (e) { /* the summary never fails the pulse */ }
    try {
      const filled = await backfillWriteups();
      if (filled && filled.checked) console.log(`[PG1-AGENT:WRITEUPS] ${filled.filled} of ${filled.checked} pending write-ups filled`);
    } catch (e) { /* a backfill never fails the pulse */ }

    return res.status(200).json({ 
      status: 'HEARTBEAT_ACTIVE',
      pulse_time: timestamp,
      message: 'Sprint 3 background loop successfully executed.'
    });
  } catch (error) {
    console.error('[PG1-AGENT:HEARTBEAT] Critical Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
