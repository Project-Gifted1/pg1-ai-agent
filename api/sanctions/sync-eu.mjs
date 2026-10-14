// /api/sanctions/sync-eu: the daily EU consolidated list sync (vercel.json
// crons, lib/sanctionsEu.mjs). A failed sync keeps yesterday's rows and
// tells the operator. CRON_SECRET auth (lib/cronAuth.mjs).

import { getSupabaseCreds } from '../../lib/supabase.mjs';
import { checkCronAuth } from '../../lib/cronAuth.mjs';
import { syncEuList } from '../../lib/sanctionsEu.mjs';
import { notifyOperator } from '../../lib/notify.mjs';

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.status === 401 ? 'Unauthorized sync request' : auth.error });
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch (e) {
    return res.status(503).json({ error: 'Storage not configured on this deployment.' });
  }
  const out = await syncEuList({ supUrl: creds.supUrl, supKey: creds.supKey });
  if (!out.ok) await notifyOperator({ supUrl: creds.supUrl, supKey: creds.supKey, route: '/screening', reason: 'eu_sanctions_sync_failed', message: `The EU consolidated list sync failed (${out.error}); screening keeps the last good copy.` });
  return res.status(out.ok ? 200 : 502).json(out);
}
