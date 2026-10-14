// /api/flags/monitor: the hourly feature-flag check (vercel.json crons,
// lib/flags.mjs monitorFlags). Every operator- or public-stage flag whose
// error rate or cost per call over the last hour passes its threshold is
// switched off, and the operator is told in the error log (category
// alert). Also the tool error-rate alert: any public tool failing more than
// 5% of its calls over the last hour (lib/statusMetrics.mjs). CRON_SECRET auth (lib/cronAuth.mjs), like the other crons.

import { getSupabaseCreds } from '../../lib/supabase.mjs';
import { checkCronAuth } from '../../lib/cronAuth.mjs';
import { monitorFlags } from '../../lib/flags.mjs';
import { monitorErrorRates } from '../../lib/statusMetrics.mjs';
import { notifyOperator } from '../../lib/notify.mjs';
import { TOOLS } from '../mcp.mjs';

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
    return res.status(200).json({ ok: true, checked: results.length, disabled: results.filter((r) => r.breach).map((r) => r.key), error_rate_alerts: alerted });
  } catch (e) {
    return res.status(502).json({ error: 'flags unreadable' });
  }
}
