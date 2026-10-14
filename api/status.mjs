// GET /status (vercel.json rewrite) and /api/status: per-tool calls,
// success rate and p50/p95 latency over the last 24 hours
// (lib/statusMetrics.mjs). Public, no identifiers. HTML by default, JSON
// with ?format=json or Accept: application/json.

import { getSupabaseCreds } from '../lib/supabase.mjs';
import { serviceStatus, statusPageHtml } from '../lib/statusMetrics.mjs';
import { publicJwks } from '../lib/signing.mjs';
import { TOOLS } from './mcp.mjs';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'method not allowed' });
  }
  let creds = {};
  try { creds = getSupabaseCreds(); } catch (e) { creds = {}; }
  const status = await serviceStatus({ supUrl: creds.supUrl, supKey: creds.supKey, tools: TOOLS.map((t) => t.name) });
  const signing = publicJwks().keys.length > 0;
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const wantsJson = (req.query && req.query.format === 'json') || /application\/json/i.test(String((req.headers && req.headers.accept) || ''));
  if (wantsJson) return res.status(200).json({ ...status, signing });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(200).send(statusPageHtml(status, { signing }));
}
