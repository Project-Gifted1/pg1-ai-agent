// PG1 plans and limits for the metered checks (1.23.0): the one place that
// says what each tier gets for check_agent_message and check_repo_trap.
//
// The two tools share ONE quota per caller: a call to either counts once.
// Every other tool keeps its own pricing and behaviour (lib/x402Config.mjs).
//
//   anonymous   no key            25 checks a day per caller, on its own
//                                 counter (not the 5/day free tier of the
//                                 paid tools), then pay per check
//   free        free key (/keys)  500 checks a day, then pay per check
//   builder     9 USD a month     10,000 checks a month, then a clear error
//   team        49 USD a month    100,000 checks a month, up to 5 keys
//   partner     no charge         unlimited (the original licence product)
//
// Pay per check: 0.002 USD in USDC on Base, through the existing x402 flow,
// for a caller without a licence who is over the free limit.
//
// THE SWITCH: PG1_PAID_CHECKS=off|on (default off). While off nothing changes
// for anyone: anonymous callers keep the 60/hour limit with no daily cap and
// nobody is asked to pay. Only the free key already works: it lifts the
// hourly limit to its 500/day (after which the caller is treated as
// anonymous again, never worse off than without a key).
//
// The per-hour abuse limits stay, and never undercut a quota: a tier's
// hourly limit is either none or at least its whole daily allowance
// (tests/plans.test.mjs checks it). Licences (builder, team, partner) have no
// hourly limit, as licensed callers never had.
//
// What a "clean" result is called: no_findings, never "safe".

export const PAID_CHECKS_ENV = 'PG1_PAID_CHECKS';
export const METERED_TOOLS = Object.freeze(['check_agent_message', 'check_repo_trap']);
export const isMeteredTool = (name) => METERED_TOOLS.includes(name);

export const SITE_URL = 'https://pg1-ai-agent.vercel.app';
export const KEYS_URL = `${SITE_URL}/keys`;
export const PRICING_URL = `${SITE_URL}/pricing`;

// Pay per check over the free limit (x402, USDC on Base).
export const PAY_PER_CHECK_PRICE = '$0.002';
export const PAY_PER_CHECK_USD = 0.002;

export const TIERS = Object.freeze(['anonymous', 'free', 'builder', 'team', 'partner']);
// The licence tiers: card payment (or, for partner, granted).
export const LICENCE_TIERS = Object.freeze(['builder', 'team', 'partner']);

export const PLANS = Object.freeze({
  anonymous: Object.freeze({ tier: 'anonymous', label: 'Anonymous', period: 'day', quota: 25, hourly: 60, priceUsdMonth: 0, keys: 0, overLimit: 'pay_per_check' }),
  free: Object.freeze({ tier: 'free', label: 'Free key', period: 'day', quota: 500, hourly: 500, priceUsdMonth: 0, keys: 1, overLimit: 'pay_per_check' }),
  builder: Object.freeze({ tier: 'builder', label: 'Builder', period: 'month', quota: 10000, hourly: null, priceUsdMonth: 9, keys: 1, overLimit: 'quota_error', upgradeTo: 'team' }),
  team: Object.freeze({ tier: 'team', label: 'Team', period: 'month', quota: 100000, hourly: null, priceUsdMonth: 49, keys: 5, overLimit: 'quota_error', upgradeTo: 'partner' }),
  partner: Object.freeze({ tier: 'partner', label: 'Partner', period: null, quota: null, hourly: null, priceUsdMonth: 0, keys: null, overLimit: null })
});

// While the switch is off, anonymous callers keep today's 60/hour and no
// daily cap.
export const OFF_ANONYMOUS_HOURLY = 60;

export function planFor(tier) {
  return PLANS[tier] || PLANS.anonymous;
}

export function isPaidChecksOn(env = process.env) {
  return ['on', 'true', '1', 'yes'].includes(String(env?.[PAID_CHECKS_ENV] ?? '').trim().toLowerCase());
}

const pad = (n) => String(n).padStart(2, '0');

// The counting period a call falls in (UTC) and when it resets.
//   day:   key "2026-11-22", resets at the next 00:00 UTC
//   month: key "2026-11",    resets at 00:00 UTC on the 1st of next month
// Partner (no quota) has no period.
export function periodFor(tier, now = Date.now()) {
  const plan = planFor(tier);
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (plan.period === 'day') {
    return { key: `${y}-${pad(m + 1)}-${pad(d.getUTCDate())}`, resetsAt: new Date(Date.UTC(y, m, d.getUTCDate() + 1)).toISOString() };
  }
  if (plan.period === 'month') {
    return { key: `${y}-${pad(m + 1)}`, resetsAt: new Date(Date.UTC(y, m + 1, 1)).toISOString() };
  }
  return { key: null, resetsAt: null };
}

// The per-hour abuse limit for a tier, or null for none. With the switch
// off, anonymous callers keep the old 60/hour.
export function hourlyLimitFor(tier, { on = false } = {}) {
  if (!on && tier === 'anonymous') return OFF_ANONYMOUS_HOURLY;
  return planFor(tier).hourly;
}

// The quota that applies to a tier right now, or null for none.
// Switch off: only the free key is counted (500/day, then anonymous).
export function quotaFor(tier, { on = false } = {}) {
  if (!on) return tier === 'free' ? PLANS.free.quota : null;
  return planFor(tier).quota;
}

const n = (x) => Number(x).toLocaleString('en-US');
const dayText = (iso) => (iso ? iso.slice(0, 10) : '');

// What happens to a call, given the caller's tier and what it has used in
// the current period (before this call).
//   { action: 'serve' }                          within quota (or none)
//   { action: 'serve_as_anonymous' }             switch off, free key used up
//   { action: 'pay_per_check', ... }             no licence, over the free limit
//   { action: 'quota_exceeded', ... }            licence over its monthly quota
// A paid call (x402 verified for this call) is always served.
export function decide({ tier, used = 0, on = false, paid = false, now = Date.now() }) {
  const t = TIERS.includes(tier) ? tier : 'anonymous';
  if (paid) return { action: 'serve', tier: t, paid: true };
  const quota = quotaFor(t, { on });
  if (quota == null || used < quota) return { action: 'serve', tier: t, quota, remaining: quota == null ? null : quota - used - 1 };
  const plan = planFor(t);
  const { resetsAt } = periodFor(t, now);
  if (!on) return { action: 'serve_as_anonymous', tier: t, quota, resetsAt };
  if (plan.overLimit === 'pay_per_check') return { action: 'pay_per_check', tier: t, quota, resetsAt, message: payPerCheckMessage(t, resetsAt) };
  return { action: 'quota_exceeded', tier: t, quota, resetsAt, message: quotaExceededMessage(t, resetsAt) };
}

export function payPerCheckMessage(tier, resetsAt) {
  const plan = planFor(tier);
  const base = tier === 'free'
    ? `This free key has used its ${n(plan.quota)} checks for today (check_agent_message and check_repo_trap share the quota); it resets at ${resetsAt} (00:00 UTC).`
    : `The ${n(plan.quota)} free checks a day without a key are used up for this caller (check_agent_message and check_repo_trap share them); they reset at ${resetsAt} (00:00 UTC).`;
  const more = tier === 'free'
    ? `Pay per check (0.002 USD each) to continue now, or see the monthly plans at ${PRICING_URL}.`
    : `Get 500 checks a day free with a key at ${KEYS_URL}, pay per check (0.002 USD each) to continue now, or see the monthly plans at ${PRICING_URL}.`;
  return `${base} ${more}`;
}

export function quotaExceededMessage(tier, resetsAt) {
  const plan = planFor(tier);
  const up = plan.upgradeTo === 'team'
    ? `Upgrade to Team (${n(PLANS.team.quota)} checks a month, 49 USD) at ${PRICING_URL}.`
    : `For more, ask about a Partner plan at ${PRICING_URL}.`;
  return `This ${plan.label} licence has used its ${n(plan.quota)} checks for this month (check_agent_message and check_repo_trap share the quota). The quota resets on ${dayText(resetsAt)} (00:00 UTC). ${up} Results are never cut short or degraded: checks resume when the quota resets.`;
}

// The links every limit, 402 and over-quota response carries.
export function limitLinks() {
  return { keys_url: KEYS_URL, pricing_url: PRICING_URL };
}

// Response headers describing the caller's plan for a metered call.
export function planHeaders({ tier, quota, remaining, resetsAt }) {
  const h = { 'X-PG1-Plan': tier };
  if (quota != null) h['X-PG1-Quota'] = String(quota);
  if (remaining != null) h['X-PG1-Quota-Remaining'] = String(Math.max(0, remaining));
  if (resetsAt) h['X-PG1-Quota-Reset'] = resetsAt;
  return h;
}

// The one sentence the two tools' MCP descriptions gain (additions only).
export const METERED_DESCRIPTION_NOTE = `Plans: 25 free checks a day without a key, 500 a day with a free key from ${KEYS_URL}, monthly plans and pay per check at ${PRICING_URL} (check_agent_message and check_repo_trap share one quota).`;
