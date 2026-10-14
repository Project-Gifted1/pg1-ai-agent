// /api/watchlists: subscribe wallets, domains, packages and CVE products to
// a status-change webhook (lib/watchlists.mjs).
//
//   POST   /api/watchlists           { items: [{ kind, target, ecosystem?, chain? }], webhook_url }
//          -> 402 with the x402 payment request (price: items x 0.05 USD
//             for 30 days), then 201 { id, secret, expires_at, items }
//   GET    /api/watchlists?id=<id>   Authorization: Bearer <secret>
//   DELETE /api/watchlists?id=<id>   Authorization: Bearer <secret>
//
// Paid by x402 only (the paying wallet is the subscriber, as a salted
// hash). No free tier: a watchlist is a 30-day commitment.

import crypto from 'node:crypto';
import { runPricedX402Gate } from './mcp.mjs';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { getSupabaseCreds } from '../lib/supabase.mjs';
import { createWatchlistStore, createWatchlist, authorizeWatchlist, watchlistView, cancelWatchlist, WatchlistError } from '../lib/watchlists.mjs';
import { payerHash } from '../lib/a2aJobs/jobs.mjs';
import { payerScreen } from '../lib/screening.mjs';
import { notifyOperator } from '../lib/notify.mjs';

export const config = { maxDuration: 20 };

const deps = { screen: null, lookup: undefined, fetchImpl: undefined };
// Tests and P11 (sanctions screening) set these.
export function __setWatchlistDeps(next) {
  Object.assign(deps, next || {});
}

function bearer(req) {
  const h = req.headers && req.headers.authorization;
  const m = /^Bearer\s+(\S+)$/i.exec(typeof h === 'string' ? h : '');
  return m ? m[1] : '';
}

export default async function handler(req, res) {
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, PAYMENT-SIGNATURE, X-Payment');
  res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Request-Id');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    return res.status(405).json({ error: 'method not allowed', request_id: requestId });
  }
  try {
    let creds;
    try { creds = getSupabaseCreds(); } catch (e) { throw new WatchlistError('watchlists are not available on this deployment', { status: 503, code: 'unavailable' }); }
    const store = createWatchlistStore({ supUrl: creds.supUrl, supKey: creds.supKey, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    if (req.method === 'POST') {
      const out = await createWatchlist(req.body, {
        store,
        gate: (priceUsd, description) => runPricedX402Gate(req, { priceUsd, description }),
        subscriberHash: payerHash,
        // P11: the paying wallet is screened before settlement.
        screen: deps.screen || payerScreen({ supUrl: creds.supUrl, supKey: creds.supKey, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), notify: notifyOperator, context: 'watchlist' }),
        lookup: deps.lookup
      });
      if (out.status === 402) {
        res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(out.paymentRequired));
        return res.status(402).json(out.paymentRequired);
      }
      if (out.settled) res.setHeader('PAYMENT-RESPONSE', encodePaymentResponseHeader(out.settled));
      return res.status(201).json({ ...out.body, request_id: requestId });
    }
    const id = String((req.query && req.query.id) || '');
    const w = await authorizeWatchlist(store, id, bearer(req));
    if (req.method === 'DELETE') return res.status(200).json({ ...(await cancelWatchlist(store, w)), request_id: requestId });
    return res.status(200).json({ ...(await watchlistView(store, w)), request_id: requestId });
  } catch (err) {
    if (err && err.watchlistError) return res.status(err.status).json({ error: err.code, message: err.message, request_id: requestId });
    if (err && err.screeningUnavailable) {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({ error: 'screening_unavailable', message: err.message, request_id: requestId });
    }
    console.error('[watchlists] unhandled:', err && err.message);
    return res.status(500).json({ error: 'internal_error', request_id: requestId });
  }
}
