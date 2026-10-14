// /api/opportunities/weekly: the weekly opportunity scan (vercel.json
// crons, lib/opportunities.mjs). Reads the last 7 days of usage as
// aggregates and starts one lab research experiment; the kill switch, the
// lab budgets and the audit log apply. CRON_SECRET auth (lib/cronAuth.mjs).

import { getSupabaseCreds } from '../../lib/supabase.mjs';
import { checkCronAuth } from '../../lib/cronAuth.mjs';
import { runOpportunityScan } from '../../lib/opportunities.mjs';
import { getUsageStats } from '../../lib/usageStats.mjs';

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
  const out = await runOpportunityScan({ supUrl: creds.supUrl, supKey: creds.supKey, getStats: (o) => getUsageStats(o) });
  return res.status(200).json({ ok: out.ok, started: out.ok ? out.id : null, message: out.reply });
}
