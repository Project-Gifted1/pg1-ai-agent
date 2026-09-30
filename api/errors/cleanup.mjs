// /api/errors/cleanup (issue #201 Phase 2b): scheduled via vercel.json's
// crons entry. Deletes pg1_errors rows older than 30 days (by last_seen).
// Same CRON_SECRET auth pattern as api/heartbeat/pulse.js.

import { getSupabaseCreds } from '../../lib/supabase.mjs';

export const config = { maxDuration: 30 };

const RETENTION_DAYS = 30;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized cleanup request' });
  }

  var creds;
  try {
    creds = getSupabaseCreds();
  } catch (e) {
    return res.status(503).json({ error: 'Error log storage not configured on this deployment.' });
  }

  var cutoffIso = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

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
      return res.status(502).json({ error: 'Cleanup delete failed', status: deleteRes.status });
    }
    return res.status(200).json({ ok: true, cutoff: cutoffIso });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
