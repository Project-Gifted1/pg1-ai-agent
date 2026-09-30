// /api/errors (issue #201 Phase 2b): authenticated, rate-limited endpoint
// backing the ERROR LOG modal in public/index.html.
//
//   { op: 'ingest', user, pass, entries: [{ context }, ...] }
//     Sends the browser's local error-log entries into pg1_errors as
//     source='client' rows. Deliberately drops any free-text message the
//     client might carry - only the fixed context/category string the
//     client code itself assigns (e.g. 'status', 'window', 'promise') is
//     ever stored, so an attacker-influenced window.onerror/unhandledrejection
//     message can never reach the database as stored text.
//   { op: 'list', user, pass }
//     Returns pg1_errors rows (server + client, newest first) for the modal.
//   { op: 'resolve', user, pass, id }
//     Marks one row resolved.
//
// Uses the same POST-with-an-op-field shape as api/chat.mjs (action field)
// rather than distinct REST verbs, and the same USER_API_KEY/USER_API_PASS
// credential check, for consistency with that endpoint.

import { safeCompare } from './chat.mjs';
import { getSupabaseCreds } from '../lib/supabase.mjs';
import { logApiError } from '../lib/errorLog.mjs';

export const config = { maxDuration: 15 };

const MAX_INGEST_ENTRIES = 20;
const MAX_CONTEXT_LEN = 40;
const LIST_LIMIT = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;

var requestsByIp = new Map();

// Exposed for tests only, same reasoning as api/chat.mjs's
// __clearAuthRateLimitState (module-level Map can't be reset between test
// cases any other way).
export function __clearErrorsRateLimitState() {
  requestsByIp.clear();
}

function isRateLimited(ip) {
  var now = Date.now();
  var entry = requestsByIp.get(ip);
  if (!entry || (entry.windowStart + RATE_LIMIT_WINDOW_MS) < now) {
    requestsByIp.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

function getClientIp(req) {
  var forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    var first = String(forwardedFor).split(',')[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isAuthedRequest(user, pass) {
  var expectedUser = (process.env.USER_API_KEY || process.env.USER_API_USER || '').trim();
  var expectedPass = (process.env.USER_API_PASS || process.env.USER_API_PASSS || '').trim();
  return !!(expectedUser && expectedPass && safeCompare(user, expectedUser) && safeCompare(pass, expectedPass));
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  var clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'Too many requests, please slow down.' });
  }

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  var op = body.op;
  if (!isAuthedRequest(body.user, body.pass)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var creds;
  try {
    creds = getSupabaseCreds();
  } catch (e) {
    return res.status(503).json({ error: 'Error log storage not configured on this deployment.' });
  }
  var supUrl = creds.supUrl;
  var supKey = creds.supKey;
  var headers = { apikey: supKey, Authorization: `Bearer ${supKey}` };

  if (op === 'ingest') {
    var entries = Array.isArray(body.entries) ? body.entries.slice(0, MAX_INGEST_ENTRIES) : [];
    var ingested = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var context = (entry && typeof entry.context === 'string') ? entry.context.trim().slice(0, MAX_CONTEXT_LEN) : '';
      if (!context) continue;
      await logApiError(supUrl, supKey, { source: 'client', route: 'client', status: null, reason: context, message: null });
      ingested++;
    }
    return res.status(200).json({ ok: true, ingested: ingested });
  }

  if (op === 'list') {
    try {
      var listRes = await fetch(
        `${supUrl}/rest/v1/pg1_errors?select=id,time,source,route,status,reason,message,count,first_seen,last_seen,resolved&order=last_seen.desc&limit=${LIST_LIMIT}`,
        { headers: headers }
      );
      if (!listRes.ok) return res.status(502).json({ error: 'Could not read error log.' });
      var rows = await listRes.json();
      return res.status(200).json({ ok: true, errors: rows });
    } catch (e) {
      return res.status(502).json({ error: 'Could not read error log.' });
    }
  }

  if (op === 'resolve') {
    var id = typeof body.id === 'string' ? body.id : null;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    try {
      var patchRes = await fetch(`${supUrl}/rest/v1/pg1_errors?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ resolved: true })
      });
      if (!patchRes.ok) return res.status(502).json({ error: 'Could not mark error resolved.' });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: 'Could not mark error resolved.' });
    }
  }

  return res.status(400).json({ error: `Unknown op '${op}'` });
}
