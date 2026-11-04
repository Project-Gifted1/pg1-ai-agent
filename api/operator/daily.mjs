// /api/operator/daily: PG1's daily report on its own service (vercel.json
// crons, 07:15 UTC; lib/operator/run.mjs). Findings become tasks PG1 acts
// on; the report goes to chat, push and the media library as a PDF.
// PG1_AUTONOMY=off or the Autonomous switch OFF stops it. CRON_SECRET auth.

import { getSupabaseCreds } from '../../lib/supabase.mjs';
import { checkCronAuth } from '../../lib/cronAuth.mjs';
import { runReport } from '../../lib/operator/run.mjs';
import { getUsageStats } from '../../lib/usageStats.mjs';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.status === 401 ? 'Unauthorized report request' : auth.error });
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch (e) {
    return res.status(503).json({ error: 'Storage not configured on this deployment.' });
  }
  try {
    const out = await runReport({ kind: 'daily', supUrl: creds.supUrl, supKey: creds.supKey, getStats: (o) => getUsageStats(o) });
    return res.status(200).json({ ok: out.ok, id: out.id || null, skipped: out.skipped || null, reason: out.ok ? null : out.reason, findings: out.findings ? out.findings.length : 0 });
  } catch (e) {
    console.error('[operator] daily_report_failed');
    return res.status(500).json({ error: 'daily report failed' });
  }
}
