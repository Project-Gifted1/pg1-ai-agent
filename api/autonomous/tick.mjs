// /api/autonomous/tick: Autonomous mode's schedule (vercel.json crons,
// every 10 minutes; lib/autonomous/runner.mjs). Does nothing while the
// operator's switch is OFF. CRON_SECRET auth (lib/cronAuth.mjs), like the
// other crons. The answer carries counts and statuses only.

import { getSupabaseCreds } from '../../lib/supabase.mjs';
import { checkCronAuth } from '../../lib/cronAuth.mjs';
import { autonomousTick } from '../../lib/autonomous/runner.mjs';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.status === 401 ? 'Unauthorized tick request' : auth.error });
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch (e) {
    return res.status(503).json({ error: 'Storage not configured on this deployment.' });
  }
  try {
    const out = await autonomousTick({ supUrl: creds.supUrl, supKey: creds.supKey });
    return res.status(200).json({ ok: true, on: out.on, ran: out.ran.map((r) => ({ type: r.type, status: r.status })) });
  } catch (e) {
    console.error(`[autonomous] tick_failed ${e && e.status ? `status=${e.status}` : 'error'}`);
    return res.status(500).json({ error: 'tick failed' });
  }
}
