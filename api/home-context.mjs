// /api/home-context: the live text for the empty chat state (the subtitle
// under the greeting and the four starting points), from PG1's real current
// state (lib/homeContext.mjs). Read-only, no AI call, cached for 60 s.
//
// Signed-in operator only (lib/operatorSession.mjs: the session cookie, or
// the credentials in an Authorization: Basic header or a JSON body's user /
// pass, never the query string). Anyone else gets 401 and the page keeps
// today's generic text. Not given the wildcard CORS rule in vercel.json.

import { resolveOperatorSession } from '../lib/operatorSession.mjs';
import { gatherHomeContext, pickHome, HOME_CONTEXT_CACHE_MS } from '../lib/homeContext.mjs';
import { getUsageStats } from '../lib/usageStats.mjs';
import { getSupabaseCreds } from '../lib/supabase.mjs';

let cache = null;
export function __resetHomeContextCache() { cache = null; }

function vault() {
  try { return getSupabaseCreds(); } catch (e) { return { supUrl: null, supKey: null }; }
}

// opts (tests): { env, now, fetchImpl, deps, session, vault }
export function createHomeContextHandler(opts = {}) {
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
    if (!session.isOperator) return res.status(401).json({ error: 'unauthorized', message: 'The home context is for the signed-in operator only.' });

    const now = typeof opts.now === 'function' ? opts.now() : Date.now();
    if (cache && now - cache.at < HOME_CONTEXT_CACHE_MS) return res.status(200).json({ ...cache.body, cached: true });
    const env = opts.env || process.env;
    const { supUrl, supKey } = opts.vault || vault();
    try {
      const signals = await gatherHomeContext({
        env, supUrl, supKey, now,
        fetchImpl: opts.fetchImpl || globalThis.fetch,
        deps: { getStats: supUrl ? (o) => getUsageStats(o) : undefined, ...(opts.deps || {}) }
      });
      const home = pickHome(signals, { now });
      const body = { ok: true, generated_at: new Date(now).toISOString(), signals, home };
      cache = { at: now, body };
      return res.status(200).json({ ...body, cached: false });
    } catch (e) {
      console.error('[home-context] failed');
      return res.status(500).json({ error: 'home_context_failed' });
    }
  };
}

export default createHomeContextHandler();
