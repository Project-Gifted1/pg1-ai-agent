// /api/flags/monitor: the hourly feature-flag check (vercel.json crons,
// lib/flags.mjs monitorFlags). Every operator- or public-stage flag whose
// error rate or cost per call over the last hour passes its threshold is
// switched off, and the operator is told in the error log (category
// alert). Also the tool error-rate alert: any public tool failing more than
// 5% of its calls over the last hour (lib/statusMetrics.mjs), and Foundry tools
// failing more than 25% are disabled (lib/foundry/tools.mjs). Also the lab:
// every queued or running experiment is synced with its GitHub run, so a
// finished run ends as done or failed with a reason even when nobody runs
// /lab status (lib/lab/chat.mjs syncActiveLabExperiments). CRON_SECRET auth (lib/cronAuth.mjs), like the other crons.

import { getSupabaseCreds } from '../../lib/supabase.mjs';
import { checkCronAuth } from '../../lib/cronAuth.mjs';
import { monitorFlags } from '../../lib/flags.mjs';
import { monitorErrorRates } from '../../lib/statusMetrics.mjs';
import { notifyOperator } from '../../lib/notify.mjs';
import { TOOLS } from '../mcp.mjs';
import { autoDisableFoundryTools } from '../../lib/foundry/tools.mjs';
import { createFoundryStore } from '../../lib/foundry/store.mjs';
import { syncActiveLabExperiments } from '../../lib/lab/chat.mjs';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.status === 401 ? 'Unauthorized monitor request' : auth.error });
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch (e) {
    return res.status(503).json({ error: 'Storage not configured on this deployment.' });
  }
  try {
    const results = await monitorFlags({ supUrl: creds.supUrl, supKey: creds.supKey });
    let alerted = [];
    try {
      alerted = (await monitorErrorRates({ supUrl: creds.supUrl, supKey: creds.supKey, tools: TOOLS.map((t) => t.name), notify: notifyOperator })).map((b) => b.tool);
    } catch (e) { /* telemetry unreadable: the flags result still stands */ }
    let foundryDisabled = [];
    try {
      foundryDisabled = await autoDisableFoundryTools({ supUrl: creds.supUrl, supKey: creds.supKey, store: createFoundryStore({ supUrl: creds.supUrl, supKey: creds.supKey }), notify: notifyOperator });
    } catch (e) { /* the Foundry tables may not exist yet */ }
    const lab = await syncActiveLabExperiments({ supUrl: creds.supUrl, supKey: creds.supKey });
    return res.status(200).json({ ok: true, checked: results.length, disabled: results.filter((r) => r.breach).map((r) => r.key), error_rate_alerts: alerted, foundry_disabled: foundryDisabled, lab_synced: lab.map((x) => ({ id: x.id.slice(0, 8), status: x.status })) });
  } catch (e) {
    return res.status(502).json({ error: 'flags unreadable' });
  }
}
