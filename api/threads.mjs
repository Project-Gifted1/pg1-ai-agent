// /api/threads: saved chats for the Session threads sheet and the save
// button in the chat's top bar (lib/chatThreads.mjs). Signed-in operator
// only - the same credentials, lockout and least-privilege rule as the
// chat (lib/operatorSession.mjs); a guest or a wrong passkey gets 401 and
// never reaches the table. POST with an op, like api/handoffs.mjs:
//
//   { op: 'list' }                         newest first (updated_at), no messages
//   { op: 'get', id }                      one thread with its messages
//   { op: 'save', messages, title? }       a new thread; the title defaults
//                                          to one made from the first message
//   { op: 'save', id, messages }           replaces that thread's messages
//                                          (auto-update after saving); the
//                                          title is left as it is
//   { op: 'rename', id, title }
//   { op: 'delete', id, confirm: true }    the client asks first; without
//                                          confirm: true nothing is deleted
//
// Every title and message passes the reply secret guard before it is
// stored. Storage is public.pg1_chat_threads through the service-role key
// only. Failures are neutral: no Supabase detail reaches the client.

import { getSupabaseCreds } from '../lib/supabase.mjs';
import { resolveOperatorSession } from '../lib/operatorSession.mjs';
import {
  THREAD_TABLE, THREAD_ID_RE, THREAD_LIST_LIMIT, ThreadInputError,
  cleanMessages, cleanTitle, autoTitle, threadGuard, threadSummary
} from '../lib/chatThreads.mjs';

export const config = { maxDuration: 15 };

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const SUMMARY_COLUMNS = 'id,title,created_at,updated_at,message_count';

const requestsByIp = new Map();

export function __clearThreadsRateLimitState() {
  requestsByIp.clear();
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = requestsByIp.get(ip);
  if (!entry || entry.windowStart + RATE_LIMIT_WINDOW_MS < now) {
    requestsByIp.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

function clientIp(req) {
  const forwardedFor = req.headers && req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const first = String(forwardedFor).split(',')[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function database() {
  try {
    const { supUrl, supKey } = getSupabaseCreds();
    return { url: `${supUrl}/rest/v1/${THREAD_TABLE}`, headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, Accept: 'application/json' } };
  } catch {
    return null;
  }
}

async function rest(db, query, options = {}) {
  const res = await fetch(`${db.url}${query}`, {
    ...options,
    headers: { ...db.headers, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`threads storage ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function threadId(body) {
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!THREAD_ID_RE.test(id)) throw new ThreadInputError('Invalid thread id');
  return id.toLowerCase();
}

const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'That saved chat no longer exists.' });

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  if (isRateLimited(clientIp(req))) {
    return res.status(429).json({ error: 'Too many requests, please slow down.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid JSON body' });

  req.body = body;
  const session = resolveOperatorSession(req);
  if (session.rateLimited) return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again later.' });
  if (!session.isOperator) return res.status(401).json({ error: 'unauthorized', message: 'Saving chats is for the signed-in operator only.' });

  const db = database();
  if (!db) return res.status(503).json({ error: 'unavailable', message: 'Saved chats are not available on this deployment.' });

  const op = body.op;
  try {
    if (op === 'list') {
      const rows = await rest(db, `?select=${SUMMARY_COLUMNS}&order=updated_at.desc&limit=${THREAD_LIST_LIMIT}`);
      return res.status(200).json({ ok: true, threads: (Array.isArray(rows) ? rows : []).map(threadSummary) });
    }

    if (op === 'get') {
      const id = threadId(body);
      const rows = await rest(db, `?select=${SUMMARY_COLUMNS},messages&id=eq.${id}`);
      if (!Array.isArray(rows) || !rows[0]) return notFound(res);
      return res.status(200).json({ ok: true, thread: { ...threadSummary(rows[0]), messages: Array.isArray(rows[0].messages) ? rows[0].messages : [] } });
    }

    if (op === 'save') {
      const guard = threadGuard();
      const messages = cleanMessages(body.messages, guard);
      const now = new Date().toISOString();
      if (body.id != null) {
        const id = threadId(body);
        const rows = await rest(db, `?id=eq.${id}&select=${SUMMARY_COLUMNS}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ messages, message_count: messages.length, updated_at: now })
        });
        if (!Array.isArray(rows) || !rows[0]) return notFound(res);
        return res.status(200).json({ ok: true, thread: threadSummary(rows[0]) });
      }
      if (!messages.length) throw new ThreadInputError('There is nothing to save yet.');
      const title = body.title != null && String(body.title).trim() ? cleanTitle(body.title, guard) : cleanTitle(autoTitle(messages), guard);
      const rows = await rest(db, `?select=${SUMMARY_COLUMNS}`, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ title, messages, message_count: messages.length, created_at: now, updated_at: now })
      });
      if (!Array.isArray(rows) || !rows[0]) throw new Error('threads storage returned no row');
      return res.status(201).json({ ok: true, thread: threadSummary(rows[0]) });
    }

    if (op === 'rename') {
      const id = threadId(body);
      const title = cleanTitle(body.title, threadGuard());
      const rows = await rest(db, `?id=eq.${id}&select=${SUMMARY_COLUMNS}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ title, updated_at: new Date().toISOString() })
      });
      if (!Array.isArray(rows) || !rows[0]) return notFound(res);
      return res.status(200).json({ ok: true, thread: threadSummary(rows[0]) });
    }

    if (op === 'delete') {
      const id = threadId(body);
      if (body.confirm !== true) throw new ThreadInputError('Deleting a saved chat needs confirm: true.');
      const rows = await rest(db, `?id=eq.${id}&select=id`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      if (!Array.isArray(rows) || !rows[0]) return notFound(res);
      return res.status(200).json({ ok: true, deleted: id });
    }

    return res.status(400).json({ error: 'bad_request', message: `Unknown op '${typeof op === 'string' ? op.slice(0, 20) : ''}'` });
  } catch (err) {
    if (err && err.threadInputError) return res.status(err.status).json({ error: err.status === 413 ? 'too_large' : 'bad_request', message: err.message });
    console.error('[THREADS] storage failed:', err && err.name === 'TimeoutError' ? 'timeout' : 'error');
    return res.status(502).json({ error: 'unavailable', message: 'Saved chats could not be reached right now.' });
  }
}
