// OpenRouter's balance guard. OpenRouter answers 402 to every model, its
// :free ones included, while the account balance is zero or below (it was
// -$0.03 with nothing ever bought), so a call there only costs a round trip.
// The guard reads the balance at most every 10 minutes and the router plans
// on it (lib/aiRouter.mjs setOpenRouterState / openRouterCandidate):
//
//   balance <= 0    dormant: OpenRouter is left out of every plan until a
//                   later check finds it above zero (re-enabled on its own)
//   0 < balance <= $2   free (:free) models only; paid ones are skipped and
//                   the operator gets one push per day saying so
//   balance > $2    free models first, then the paid ones (never for
//                   background jobs)
//
// Reads GET /api/v1/key (usage today, free-tier level: 50 free-model
// requests a day until $10 has ever been bought, 1,000 after) and
// GET /api/v1/credits (total bought minus total used = the balance). Never
// the key itself. Off with PG1_OPENROUTER_GUARD=0; under Node's test
// runner it is off unless PG1_OPENROUTER_GUARD=1 (the cache's convention).

import { setOpenRouterState, resolveKeys, OPENROUTER_PAID_MIN_BALANCE_USD } from '../aiRouter.mjs';
import { claimAlert } from './alerts.mjs';
import { pushToOperator, vapidKeys } from '../watches/push.mjs';

export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
export const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
export const GUARD_TTL_MS = 10 * 60 * 1000;
export const GUARD_TIMEOUT_MS = 4000;
export const LOW_BALANCE_ALERT = 'openrouter_low_balance';
export const DAY_MS = 24 * 60 * 60 * 1000;

export function guardEnabled(env = process.env) {
  const v = String((env && env.PG1_OPENROUTER_GUARD) || '').trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return !process.env.NODE_TEST_CONTEXT;
}

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// { ok, status, balanceUsd, usageDailyUsd, freeTier, freeDailyRequests,
//   limitRemainingUsd, active, paidAllowed } for one key. Never throws.
export async function readOpenRouter({ key, fetchImpl = globalThis.fetch, timeoutMs = GUARD_TIMEOUT_MS } = {}) {
  if (!key) return { ok: false, status: null, missing: true };
  const headers = { Authorization: `Bearer ${key}` };
  const get = async (url) => {
    const res = await fetchImpl(url, { headers, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data: body && body.data ? body.data : null };
  };
  try {
    const k = await get(OPENROUTER_KEY_URL);
    if (!k.ok) return { ok: false, status: k.status };
    let credits = null;
    try { credits = await get(OPENROUTER_CREDITS_URL); } catch (e) { credits = null; }
    const d = k.data || {};
    const bought = credits && credits.ok && credits.data ? num(credits.data.total_credits) : null;
    const used = credits && credits.ok && credits.data ? num(credits.data.total_usage) : null;
    const limitRemaining = num(d.limit_remaining);
    const balance = bought != null && used != null ? Number((bought - used).toFixed(4)) : limitRemaining;
    const freeTier = d.is_free_tier === true;
    return {
      ok: true, status: k.status,
      balanceUsd: balance,
      usageDailyUsd: num(d.usage_daily),
      usageTotalUsd: num(d.usage),
      limitRemainingUsd: limitRemaining,
      freeTier,
      freeDailyRequests: freeTier ? 50 : 1000,
      active: balance == null ? true : balance > 0,
      paidAllowed: balance == null ? false : balance > OPENROUTER_PAID_MIN_BALANCE_USD
    };
  } catch (e) {
    return { ok: false, status: null, detail: e && e.name === 'TimeoutError' ? 'timed out' : 'unreachable' };
  }
}

let cached = null;
let inFlight = null;
export function __resetOpenRouterGuard() { cached = null; inFlight = null; setOpenRouterState(null); }
export function openRouterGuardState() { return cached; }

// The low-balance push: once per day while the balance is $2 or less.
async function lowBalanceAlert(state, { env, store, supUrl, supKey, fetchImpl, push, now }) {
  if (!state || state.balanceUsd == null || state.balanceUsd > OPENROUTER_PAID_MIN_BALANCE_USD) return false;
  const canPush = !!(store && vapidKeys(env));
  if (!canPush) return false;
  const claimed = await claimAlert({ engine: LOW_BALANCE_ALERT, supUrl, supKey, fetchImpl, now, windowMs: DAY_MS });
  if (!claimed) return false;
  const body = state.balanceUsd <= 0
    ? `OpenRouter balance is ${state.balanceUsd < 0 ? '-' : ''}$${Math.abs(state.balanceUsd).toFixed(2)}: OpenRouter is switched off (it refuses even free models at zero or below) until the balance is above $0.`
    : `OpenRouter balance is $${state.balanceUsd.toFixed(2)}: paid models are off until it is above $${OPENROUTER_PAID_MIN_BALANCE_USD}; free models are still used.`;
  await push({ store, env, title: 'PG1: OpenRouter balance low', body, url: '/', tag: 'pg1-openrouter-balance', providerNames: true });
  return true;
}

// Brings the router's OpenRouter state up to date (at most one check per
// GUARD_TTL_MS per instance, shared by concurrent callers). Resolves to the
// state, or null when the guard is off or there is no key. Never throws.
export async function ensureOpenRouterState({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), store = null, supUrl = '', supKey = '', push = pushToOperator } = {}) {
  if (!guardEnabled(env)) return null;
  const key = resolveKeys(env).openrouter;
  if (!key) { setOpenRouterState(null); return null; }
  if (cached && now() - cached.checkedAt < GUARD_TTL_MS) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const r = await readOpenRouter({ key, fetchImpl });
      // An unreadable balance (OpenRouter down, a timeout) keeps the last
      // known state; with none, OpenRouter is planned free models only.
      const state = r.ok ? { ...r, checkedAt: now() } : (cached ? { ...cached, checkedAt: now() } : { active: true, paidAllowed: false, balanceUsd: null, unreadable: true, checkedAt: now() });
      cached = state;
      setOpenRouterState({ active: state.active !== false, balanceUsd: state.balanceUsd == null ? null : state.balanceUsd, paidAllowed: !!state.paidAllowed });
      try { await lowBalanceAlert(state, { env, store, supUrl, supKey, fetchImpl, push, now: now() }); } catch (e) { /* an alert never breaks a call */ }
      return state;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
