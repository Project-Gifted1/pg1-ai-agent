// /api/errors/cleanup (issue #201 Phase 2b): scheduled via vercel.json's
// crons entry. Deletes pg1_errors rows older than 30 days (by last_seen),
// and agent_telemetry rows older than 90 days (lib/telemetry.mjs
// purgeExpiredTelemetry) - the one daily cleanup job for both tables.
// CRON_SECRET auth shared with api/heartbeat/pulse.js (lib/cronAuth.mjs):
// 403 when CRON_SECRET is unset, constant-time Bearer comparison otherwise.

import { getSupabaseCreds } from '../../lib/supabase.mjs';
import { purgeExpiredTelemetry } from '../../lib/telemetry.mjs';
import { checkCronAuth } from '../../lib/cronAuth.mjs';

export const config = { maxDuration: 30 };

const RETENTION_DAYS = 30;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var auth = checkCronAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.status === 401 ? 'Unauthorized cleanup request' : auth.error });
  }

  var creds;
  try {
    creds = getSupabaseCreds();
  } catch (e) {
    return res.status(503).json({ error: 'Error log storage not configured on this deployment.' });
  }

  var cutoffIso = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Telemetry retention runs first and on its own: a pg1_errors failure
  // below must not keep expired telemetry rows around (and vice versa).
  var telemetry = await purgeExpiredTelemetry();

  try {
    var deleteRes = await fetch(`${creds.supUrl}/rest/v1/pg1_errors?last_seen=lt.${encodeURIComponent(cutoffIso)}`, {
      method: 'DELETE',
      headers: {
        apikey: creds.supKey,
        Authorization: `Bearer ${creds.supKey}`,
        Prefer: 'return=minimal'
      }
    });
    if (!deleteRes.ok) {
      return res.status(502).json({ error: 'Cleanup delete failed', status: deleteRes.status, telemetry });
    }
    if (!telemetry.ok) {
      return res.status(502).json({ error: 'Telemetry retention delete failed', cutoff: cutoffIso, telemetry });
    }
    return res.status(200).json({ ok: true, cutoff: cutoffIso, telemetry });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
