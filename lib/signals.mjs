// Proprietary signals: DESIGN ONLY, OFF. See docs/signals-design.md.
//
// The idea: aggregate what PG1's checks see across callers (for example
// "this wallet was checked by 40 distinct callers this week and flagged")
// into signals no single source has. Nothing here runs unless
// PG1_SIGNALS=on, and nothing calls recordSignal yet: the privacy notice
// and terms changes (docs/drafts/) must be reviewed and published first.
//
// Rules the code enforces when it is switched on:
// - callers only as the salted hash lib/telemetry.mjs already uses;
// - a signal is published only when at least SIGNALS_K_ANONYMITY distinct
//   caller hashes contributed (k-anonymity), and never with a caller list;
// - observations are deleted after SIGNALS_RETENTION_DAYS (90).

export const SIGNALS_K_ANONYMITY = 10;
export const SIGNALS_RETENTION_DAYS = 90;
export const SIGNAL_KINDS = Object.freeze(['wallet', 'domain', 'package', 'cve']);

export function signalsEnabled(env = process.env) {
  return String(env.PG1_SIGNALS || 'off').trim().toLowerCase() === 'on';
}

// One observation, or null when signals are off or the input is unusable.
// The target is hashed with the same salt so the store never holds a raw
// target either; the published aggregate is looked up by the same hash.
export function buildObservation({ kind, target, status, callerHash, now = Date.now() }, { env = process.env, hashTarget } = {}) {
  if (!signalsEnabled(env)) return null;
  if (!SIGNAL_KINDS.includes(kind) || !target || !callerHash || typeof hashTarget !== 'function') return null;
  if (!['no_flags', 'flagged', 'unknown'].includes(status)) return null;
  return { kind, target_hash: hashTarget(`${kind}:${String(target).toLowerCase()}`), status, caller_hash: callerHash, observed_at: new Date(now).toISOString() };
}

// Aggregates observations of one target into a publishable signal, or null
// below the k-anonymity threshold. Never returns caller hashes.
export function aggregateSignal(observations, { k = SIGNALS_K_ANONYMITY, now = Date.now() } = {}) {
  const cutoff = now - SIGNALS_RETENTION_DAYS * 86400000;
  const recent = (Array.isArray(observations) ? observations : []).filter((o) => o && Date.parse(o.observed_at) >= cutoff);
  const callers = new Set(recent.map((o) => o.caller_hash).filter(Boolean));
  if (callers.size < k) return null;
  const flaggedBy = new Set(recent.filter((o) => o.status === 'flagged').map((o) => o.caller_hash));
  return { distinct_callers_bucket: callers.size >= 100 ? '100+' : callers.size >= 50 ? '50-99' : callers.size >= 25 ? '25-49' : `${k}-24`, flagged_share: Math.round((flaggedBy.size / callers.size) * 20) / 20, window_days: SIGNALS_RETENTION_DAYS };
}
