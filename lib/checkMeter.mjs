// The meter for check_agent_message and check_repo_trap (1.23.0): who the
// caller is (lib/plans.mjs tier), the hourly abuse limit that applies, and
// one use of the shared quota taken before the check runs (given back if the
// check fails on bad input, so only served checks count).
//
// Only the public transports meter (/api/mcp, /api/a2a, POST /api/repo-trap
// pass metered: true). The operator chat, the playground and PG1's own
// internal calls run the checks exactly as before.
//
// Fails open: if the key store or the counters cannot be reached, the check
// is served (the hourly abuse limit still applies) and nothing is counted.
// A licence that cannot be verified right now is never asked to pay.

import { isPaidChecksOn, decide, periodFor, hourlyLimitFor, quotaFor, planHeaders, limitLinks, PAY_PER_CHECK_USD } from './plans.mjs';
import { isPg1Key, resolveLicencePlan } from './paymentGate.mjs';
import { hashApiKey, isWellFormedPg1Key, freeKeySubject, licenceAccount, createSupabaseKeyStore } from './apiKeys.mjs';
import { freeTierKey } from './freeTier.mjs';
import { getSupabaseCreds } from './supabase.mjs';
import { logApiError } from './errorLog.mjs';

// Fail open, logged: when the key store or the usage counters cannot be
// reached the check is served uncounted, and one ERROR LOG row says so (at
// most every 15 minutes per instance, with how many checks went uncounted).
// Quotas never depend on telemetry: they are the atomic
// pg1_check_usage_take RPC, taken before the answer is returned.
export const METER_FAILURE_ROUTE = 'meter:pg1_check_usage';
const METER_LOG_INTERVAL_MS = 15 * 60 * 1000;
let meterFailure = { lastLoggedAt: -Infinity, uncounted: 0 };
export function __resetMeterFailureLogForTests() { meterFailure = { lastLoggedAt: -Infinity, uncounted: 0 }; }
export function meterFailureStats() { return { ...meterFailure }; }
function noteMeterFailure(what, now = Date.now()) {
  meterFailure.uncounted += 1;
  console.warn(`[meter] ${what}: check served uncounted`);
  if (now - meterFailure.lastLoggedAt < METER_LOG_INTERVAL_MS) return;
  const n = meterFailure.uncounted;
  meterFailure = { lastLoggedAt: now, uncounted: 0 };
  try {
    const { supUrl, supKey } = getSupabaseCreds();
    logApiError(supUrl, supKey, { source: 'server', route: METER_FAILURE_ROUTE, status: null, reason: `meter_${what}`, message: `Plan quota store could not be reached (${what}); ${n} check${n === 1 ? '' : 's'} served without being counted (fail open).`, category: 'network' }).catch(() => {});
  } catch (e) { /* storage not configured: the console line is all there is */ }
}

export class MeterError extends Error {
  constructor(decision) {
    super(decision.message);
    this.mcpToolError = true;
    this.code = decision.action === 'pay_per_check' ? 'payment_required' : 'quota_exceeded';
    this.meter = {
      plan: decision.tier,
      quota: decision.quota,
      resets_at: decision.resetsAt,
      ...limitLinks(),
      ...(decision.action === 'pay_per_check' ? { pay_per_check_usd: PAY_PER_CHECK_USD } : {})
    };
  }
}

// Key lookups are cached for a minute per instance (a deleted or rotated key
// stops working within a minute). Keyed by the key's hash, never the key.
const KEY_CACHE_MS = 60 * 1000;
const keyCache = new Map();
export function __clearKeyCacheForTests() { keyCache.clear(); }

async function lookupKey(store, key, now) {
  const h = hashApiKey(key);
  const hit = keyCache.get(h);
  if (hit && now < hit.expiresAt) return hit.row;
  const row = await store.findActiveKey(h);
  if (keyCache.size > 5000) keyCache.clear();
  keyCache.set(h, { row, expiresAt: now + KEY_CACHE_MS });
  return row;
}

export function forgetKey(key) {
  keyCache.delete(hashApiKey(key));
}

let defaultStore;
export function defaultKeyStore() {
  if (defaultStore !== undefined) return defaultStore;
  try {
    const { supUrl, supKey } = getSupabaseCreds();
    defaultStore = createSupabaseKeyStore({ supUrl, supKey });
  } catch (e) {
    defaultStore = null;
  }
  return defaultStore;
}
export function __setDefaultKeyStoreForTests(store) { defaultStore = store; }

const anonSubject = (identifier) => {
  const h = identifier && identifier !== 'unknown' ? freeTierKey(identifier) : null;
  return h ? 'anon:' + h : null;
};

// Who is calling: { tier, subject } (subject: the usage counter, or null).
export async function resolveCaller({ licenseKey, identifier, licensed } = {}, { store = defaultKeyStore(), resolveLicence = resolveLicencePlan, env = process.env, now = Date.now() } = {}) {
  if (licensed === true) return { tier: 'partner', subject: null, internal: true };
  const anon = (extra = {}) => ({ tier: 'anonymous', subject: anonSubject(identifier), ...extra });
  const key = typeof licenseKey === 'string' ? licenseKey.trim() : '';
  if (!key) return anon();
  if (isPg1Key(key)) {
    if (!isWellFormedPg1Key(key) || !store) return anon({ keyRejected: true });
    let row;
    try { row = await lookupKey(store, key, now); } catch (e) { noteMeterFailure('key_lookup_failed', now); return anon({ keyUnavailable: true }); }
    if (!row) return anon({ keyRejected: true });
    if (row.tier === 'free') return { tier: 'free', subject: freeKeySubject(row.email_hash) };
    if (row.tier === 'team' && row.account) return { tier: 'team', subject: row.account };
    return anon({ keyRejected: true });
  }
  const r = await resolveLicence(key, { env }).catch(() => ({ valid: false, reason: 'verification_unavailable' }));
  if (r.valid) return { tier: r.tier, subject: r.tier === 'partner' ? null : licenceAccount(key) };
  if (r.reason === 'verification_unavailable') return anon({ licenceUnavailable: true });
  return anon({ keyRejected: true });
}

const noop = async () => {};

// Meters one call. Returns
//   { tier, hourly, headers, refund }   serve it (hourly: the abuse limit
//                                       for the caller, null for none)
// or throws MeterError (code payment_required or quota_exceeded).
// ctx.paid: an x402 payment for this call has been verified by the
// transport, so the quota is not touched.
export async function meterCheck(ctx = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now ? deps.now() : Date.now();
  const store = deps.store !== undefined ? deps.store : defaultKeyStore();
  const on = isPaidChecksOn(env);
  const caller = await resolveCaller(ctx, { store, resolveLicence: deps.resolveLicence, env, now });
  const tier = caller.tier;
  const base = { tier, refund: noop, keyRejected: !!caller.keyRejected };
  if (caller.internal) return { ...base, hourly: null, headers: {} };
  if (ctx.paid) return { ...base, tier, paid: true, hourly: null, headers: planHeaders({ tier }) };
  // A licence the licence service could not confirm right now: served, not
  // counted, with the anonymous hourly limit.
  if (caller.licenceUnavailable) return { ...base, hourly: hourlyLimitFor('anonymous', { on }), headers: planHeaders({ tier }) };

  const quota = quotaFor(tier, { on });
  const hourly = hourlyLimitFor(tier, { on });
  if (quota == null || !caller.subject || !store) return { ...base, hourly, headers: planHeaders({ tier, quota: quota ?? undefined }) };

  const { key: period, resetsAt } = periodFor(tier, now);
  let used;
  try {
    used = await store.takeUsage(caller.subject, period, tier, quota);
  } catch (e) {
    noteMeterFailure('usage_take_failed', now);
    return { ...base, hourly, headers: planHeaders({ tier, quota }), uncounted: true };
  }
  if (Number.isFinite(used) && used >= 0) {
    return {
      ...base,
      hourly,
      headers: planHeaders({ tier, quota, remaining: quota - used, resetsAt }),
      refund: async () => { try { await store.refundUsage(caller.subject, period); } catch (e) { /* best effort */ } }
    };
  }
  const d = decide({ tier, used: quota, on, now });
  if (d.action === 'serve_as_anonymous') {
    // Switch off and the free key's 500 for today are used: the caller is
    // treated exactly as without a key (60/hour, no daily cap).
    return { ...base, tier: 'anonymous', viaFreeKey: true, hourly: hourlyLimitFor('anonymous', { on }), headers: planHeaders({ tier: 'anonymous' }) };
  }
  throw new MeterError(d);
}
