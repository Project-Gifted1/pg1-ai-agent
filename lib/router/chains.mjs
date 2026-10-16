// PG1's fallback router: the one place that turns a routing chain from the
// capability registry (ROUTING_CHAINS) into the engines a call may use, in
// order, and runs a call down it (docs/director-mode.md, Part A).
//
//   chainPlan(id, opts)   the steps this deployment can use, in order, and
//                         why each other step was left out
//   runChain(opts)        a call down a plan: the next step only on a
//                         capacity failure; a refusal or a bad request stops
//
// Rules every chain keeps:
//   - Only a capacity failure moves on (lib/aiRouter.mjs failureClass): out
//     of credit or quota, 429, 5xx, timeout or network, a missing or revoked
//     key, a model that is gone. A content-safety refusal, the engine's or
//     PG1's own, stops the call and is never tried on another engine.
//   - Client work (clientWork: true) uses only steps whose registry licence
//     is commercial_ok; operator-only steps (the free Gemini key) never
//     carry client or customer data.
//   - A step whose provider is over its daily budget (PG1_DAILY_BUDGET_*) or
//     has no key is left out; a key in its breaker window goes last.
//   - Each capacity failure raises the operator's alert (lib/router/alerts.mjs)
//     once per engine per hour.
//
// Provider names stay in this file, the ledger and the operator's alerts.

import { ROUTING_CHAINS, stepLicence } from '../capabilities/registry.mjs';
import { resolveKeys, budgetAllows, isTripped, tripBreaker, failureClass, FAILURE } from '../aiRouter.mjs';

export { FAILURE, failureClass };

export const CHAIN_IDS = Object.freeze(Object.keys(ROUTING_CHAINS));

// The key a step's provider uses (the first, for a pool), or ''.
export function stepKey(env, provider) {
  const k = resolveKeys(env);
  const pools = { gemini_free: k.geminiFree, gemini_paid: k.geminiPaid };
  if (pools[provider]) return pools[provider][0] || '';
  return k[provider] || '';
}

export function chainSteps(id) {
  const chain = ROUTING_CHAINS[id];
  if (!chain) throw new Error(`no routing chain ${id}`);
  return chain;
}

// The usable steps of a chain, in order: { steps: [{ ...step, key, index,
// licence }], skipped: [{ provider, model, reason }] } where reason is
// 'no_key' | 'licence' | 'operator_only' | 'budget' | 'excluded' |
// 'film_rights'. Steps whose key is in its breaker window go last.
export function chainPlan(id, { env = {}, clientWork = false, operator = false, exclude = [], ledger = null, now = Date.now(), filmRights = null } = {}) {
  const steps = [];
  const skipped = [];
  const rights = filmRights == null ? String(env.PG1_ELEVENLABS_FILM_RIGHTS || '').trim() === '1' : !!filmRights;
  chainSteps(id).forEach((step, index) => {
    const licence = stepLicence(step);
    const skip = (reason) => skipped.push({ provider: step.provider, model: step.model || null, role: step.role, reason });
    if (exclude.includes(step.provider) || (step.slot && exclude.includes(`${step.provider}:${step.slot}`))) return skip('excluded');
    if (step.filmRightsOnly && !rights) return skip('film_rights');
    if (step.operatorOnly && (!operator || clientWork)) return skip('operator_only');
    if (clientWork && (licence !== 'commercial_ok' || step.clientOk === false)) return skip('licence');
    const key = stepKey(env, step.provider);
    if (!key) return skip('no_key');
    if (!budgetAllows(env, step.provider, { ledger, now })) return skip('budget');
    steps.push({ ...step, key, index, licence, keyId: `${step.provider}${step.slot ? `:${step.slot}` : ''}` });
  });
  const open = steps.filter((s) => !isTripped(s.keyId, now));
  return { id, steps: open.concat(steps.filter((s) => isTripped(s.keyId, now))), skipped };
}

// Why a plan is empty, in words for the operator (never for a client).
export function emptyPlanReason(plan, { clientWork = false } = {}) {
  if (plan.steps.length) return '';
  const reasons = new Set(plan.skipped.map((s) => s.reason));
  if (clientWork && reasons.has('licence')) return 'no engine with a settled commercial licence is configured for this client film';
  if (reasons.has('budget')) return "every engine for this step is over today's budget";
  if (reasons.has('no_key')) return 'no engine for this step is configured';
  return 'no engine is available for this step';
}

// Runs one call down a plan. attempt(step) resolves to { ok, value?,
// status?, text?, kind?, refused?, detail?, costUsd? } or throws (an
// EngineError: its kind/status/refused are read). Moves on only on a
// capacity failure; trips the breaker; calls onCapacity({ step, next,
// failure }) for each capacity failure (the alert). Resolves to
// { ok, value, step, attempts, failures, stopped: null | 'refused' | 'error' | 'exhausted' | 'empty' }.
export async function runChain({ plan, attempt, onCapacity = () => {}, now = () => Date.now() }) {
  const failures = [];
  if (!plan.steps.length) return { ok: false, value: null, step: null, attempts: 0, failures, stopped: 'empty' };
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    let r;
    try {
      r = await attempt(step);
    } catch (e) {
      r = { ok: false, status: e && e.status != null ? e.status : null, kind: e && e.kind, refused: !!(e && e.refused), detail: String((e && (e.detail || e.message)) || e), error: e };
    }
    if (r && r.ok) return { ok: true, value: r.value, step, attempts: i + 1, failures, stopped: null };
    const cls = failureClass({ status: r && r.status, text: r && (r.text || r.detail), refused: r && r.refused, kind: r && r.kind });
    const failure = { provider: step.provider, model: step.model || null, status: r ? r.status : null, kind: r && r.kind, cls, detail: String((r && r.detail) || '').slice(0, 300), error: r && r.error };
    failures.push(failure);
    if (cls !== FAILURE.CAPACITY) return { ok: false, value: null, step, attempts: i + 1, failures, stopped: cls };
    tripBreaker(step.keyId, failure.status === null && r && r.kind === 'billing' ? 402 : failure.status, failure.detail, now());
    try { await onCapacity({ step, next: plan.steps[i + 1] || null, failure }); } catch (e) { /* an alert never breaks a call */ }
  }
  return { ok: false, value: null, step: null, attempts: failures.length, failures, stopped: 'exhausted' };
}
