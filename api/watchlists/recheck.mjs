// /api/watchlists/recheck: the watchlist recheck (vercel.json crons,
// lib/watchlists.mjs). Rechecks due items with the preflight checks and
// sends the signed webhook on a status change. CRON_SECRET auth.

import { getSupabaseCreds } from '../../lib/supabase.mjs';
import { checkCronAuth } from '../../lib/cronAuth.mjs';
import { createWatchlistStore, recheckWatchlists } from '../../lib/watchlists.mjs';
import { runPreflight } from '../../lib/preflight.mjs';
import { internalRunTool } from '../mcp.mjs';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.status === 401 ? 'Unauthorized recheck request' : auth.error });
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch (e) {
    return res.status(503).json({ error: 'Storage not configured on this deployment.' });
  }
  try {
    const store = createWatchlistStore({ supUrl: creds.supUrl, supKey: creds.supKey });
    const out = await recheckWatchlists({ store, runPreflight: (args) => runPreflight(args, { runTool: internalRunTool }) });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'recheck failed' });
  }
}
