// /api/defense-feed: PG1 Kingdom Defence's data (lib/defenseFeed.mjs), the
// last 24 hours of real defence events, read-only.
//
//   GET  /api/defense-feed             the whole 24 h window
//   GET  /api/defense-feed?since=<ms>  a poll: events that started or grew
//                                      since then (the view polls every 5 s
//                                      while it is open)
//
// No server-sent events: Vercel functions are billed for the time a stream
// stays open, and a 5-second poll of a small JSON is cheaper here.
//
// Signed-in operator only, the same check as /api/home-context
// (lib/operatorSession.mjs: the session cookie, or the credentials in an
// Authorization: Basic header or a JSON body's user / pass, never the query
// string). Anyone else gets 401 and nothing else. Not given the wildcard
// CORS rule in vercel.json. PG1 only defends: this route only reads PG1's
// own database and sends nothing to anybody.

import { resolveOperatorSession } from '../lib/operatorSession.mjs';
import { buildDefenseFeed } from '../lib/defenseFeed.mjs';
import { getSupabaseCreds } from '../lib/supabase.mjs';
import { queryOf } from '../lib/requestQuery.mjs';

// Whole-window reads are cached per instance for a few seconds, so several
// open tabs do not each read 24 h of rows.
export const DEFENSE_FEED_CACHE_MS = 4000;
let cache = null;
export function __resetDefenseFeedCache() { cache = null; }

function vault() {
  try { return getSupabaseCreds(); } catch (e) { return { supUrl: null, supKey: null }; }
}

// opts (tests): { env, now, fetchImpl, session, vault }
export function createDefenseFeedHandler(opts = {}) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    const session = await (opts.session || resolveOperatorSession)(req);
    if (session.rateLimited) return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again later.' });
    if (!session.isOperator) return res.status(401).json({ error: 'unauthorized', message: 'The defence feed is for the signed-in operator only.' });

    const now = typeof opts.now === 'function' ? opts.now() : Date.now();
    let since = null;
    try {
      const q = queryOf(req);
      const raw = q && (typeof q.get === 'function' ? q.get('since') : q.since);
      const n = Number(raw);
      if (raw != null && raw !== '' && Number.isFinite(n) && n > 0 && n <= now + 60000) since = n;
    } catch (e) { since = null; }
    if (since == null && cache && now - cache.at < DEFENSE_FEED_CACHE_MS) return res.status(200).json({ ...cache.body, cached: true });
    const { supUrl, supKey } = opts.vault || vault();
    try {
      const body = await buildDefenseFeed({ supUrl, supKey, fetchImpl: opts.fetchImpl || globalThis.fetch, now, since, env: opts.env || process.env });
      if (since == null) cache = { at: now, body };
      return res.status(200).json({ ...body, cached: false });
    } catch (e) {
      console.error('[defense-feed] failed');
      return res.status(500).json({ error: 'defense_feed_failed' });
    }
  };
}

export default createDefenseFeedHandler();
