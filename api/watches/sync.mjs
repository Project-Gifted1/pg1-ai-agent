// /api/watches/sync: the fallback for webhooks that never arrived (vercel.json
// crons, every 5 minutes). Expires old watches and re-reads every open one
// from its source: the lab experiment (synced with its run), the PR and its
// CI, the workflow run, the deploy (with VERCEL_TOKEN). A change that a
// webhook missed is reported now (lib/watches/engine.mjs resyncWatches).
// CRON_SECRET auth (lib/cronAuth.mjs), like the other crons.

import { getSupabaseCreds } from '../../lib/supabase.mjs';
import { checkCronAuth } from '../../lib/cronAuth.mjs';
import { resyncWatches } from '../../lib/watches/engine.mjs';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.status === 401 ? 'Unauthorized watch sync request' : auth.error });
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch (e) {
    return res.status(503).json({ error: 'Storage not configured on this deployment.' });
  }
  const out = await resyncWatches({ supUrl: creds.supUrl, supKey: creds.supKey });
  return res.status(200).json({ ok: true, checked: out.length, watches: out });
}
