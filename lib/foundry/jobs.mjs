// The Tool Foundry pipeline for one build_tool request:
//
//   screen (structured labels + purpose classifier; deny by default)
//     -> refused | review (operator queue) | pass
//   feasibility + licence (plan from PG1 primitives and allowlisted sources)
//     -> infeasible | quote (build fee and per-call price, both >= 1.5x
//        cost; counter_offer when the offer is below)
//   x402 payment of the build fee (the paying wallet is screened first, P11)
//   build in the P4 lab (a code experiment: plan file, evals, CI)
//   evals + CI + safety scan (the lab gate)
//   operator approval (/foundry approve) -> deploy
//
// A paid build that fails, or that the operator rejects, credits the build
// fee to the paying wallet (never an on-chain refund) and flags the job
// for the operator.

import crypto from 'node:crypto';
import { normalizeSpec, screenStructured, decideScreening, FoundryInputError } from './screen.mjs';
import { feasibility, validatePlan } from './plan.mjs';
import { quoteFor, QUOTE_TTL_HOURS, allowedSourceIds, USE_CASES, SUBJECT_TYPES, REFUSAL_CATEGORIES } from './catalogue.mjs';
import { authorize, logAutonomy } from '../autonomy.mjs';

export const FOUNDRY_SKILL = 'build_tool';
export const PAYABLE_STATUSES = Object.freeze(['quoted', 'counter_offer']);
export const VISIBILITIES = Object.freeze(['private', 'public']);

export class FoundryRefusal extends Error {
  constructor(message, { status = 400, code = 'invalid_input', data = {} } = {}) {
    super(message);
    this.foundryRefusal = true;
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

// The access key of a deployed tool: derived, never stored. The
// commissioner reads it once from the job (the job id is their handle).
export function toolAccessKey(toolId, env = process.env) {
  const master = String(env.PG1_FOUNDRY_SECRET || '');
  if (master.length < 32) return null;
  return crypto.createHmac('sha256', master).update(`foundry-tool:${toolId}`).digest('base64url');
}

function offerOf(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  return { build_fee_usd: n(o.build_fee_usd), per_call_usd: n(o.per_call_usd) };
}

// Quote (or counter-offer) for a job that passed screening.
function priced(spec, offer, { labBudgetUsd, now }) {
  const f = feasibility(spec);
  if (!f.feasible) return { status: 'infeasible', review_reason: f.reason, quote: f.achievable_ms ? { achievable_p95_ms: f.achievable_ms } : null };
  const q = quoteFor(f.plan, { labBudgetUsd });
  const below = (offer.build_fee_usd != null && offer.build_fee_usd < q.build_fee_usd) || (offer.per_call_usd != null && offer.per_call_usd < q.per_call_usd);
  return {
    status: below ? 'counter_offer' : 'quoted',
    plan: f.plan,
    quote: { ...q, expires_at: new Date(now + QUOTE_TTL_HOURS * 3600000).toISOString(), ...(below ? { your_offer: offer, note: 'Your offer is below PG1\'s cost-based minimum. This counter-offer stands for 24 hours; pay the build fee to accept.' } : {}) },
    build_fee_usd: q.build_fee_usd,
    per_call_usd: q.per_call_usd
  };
}

// deps: { store, classify(purpose) -> {category, confidence} | null,
// labReady() -> bool, labBudgetUsd, callerHash, notify?, now }
export async function submitBuild({ spec: rawSpec, offer: rawOffer, visibility = 'private' }, deps) {
  const now = deps.now ? deps.now() : Date.now();
  if (!VISIBILITIES.includes(visibility)) throw new FoundryRefusal('visibility must be private or public');
  let spec;
  try {
    spec = normalizeSpec(rawSpec);
  } catch (e) {
    if (e instanceof FoundryInputError) throw new FoundryRefusal(`Invalid spec: ${e.message}`, { data: { allowed_use_cases: Object.keys(USE_CASES), allowed_subject_types: SUBJECT_TYPES, allowed_sources: allowedSourceIds() } });
    throw e;
  }
  const offer = offerOf(rawOffer);
  const structured = screenStructured(spec);
  // The classifier runs only when the structured checks pass (no model call
  // for a request that is already refused or headed to review).
  const classification = structured.decision === 'pass' ? await deps.classify(spec.purpose).catch(() => null) : null;
  const screening = decideScreening(spec, structured, classification);
  const base = { spec, visibility, offer, caller_hash: deps.callerHash || null, classification: screening.classification || null };

  if (screening.decision === 'refuse') {
    return deps.store.createJob({ ...base, status: 'refused', refusal_category: screening.category, review_reason: screening.detail || null });
  }
  if (screening.decision === 'review' || !deps.labReady()) {
    const job = await deps.store.createJob({ ...base, status: 'review', review_reason: screening.decision === 'review' ? screening.reason : 'the lab is not set up on this deployment' });
    if (deps.notify) await deps.notify({ route: '/foundry', reason: 'foundry_review', message: `Foundry request ${job.id.slice(0, 8)} (${spec.name}) is waiting in /foundry queue: ${job.review_reason}.` });
    return job;
  }
  const p = priced(spec, offer, { labBudgetUsd: deps.labBudgetUsd, now });
  return deps.store.createJob({ ...base, ...p });
}

// The operator's decision on a job in review: allow -> priced like an
// automatic pass; deny -> refused.
export async function reviewDecision(job, decision, deps) {
  if (!job || job.status !== 'review') throw new FoundryRefusal('only a job in review can be allowed or denied', { status: 409, code: 'not_in_review' });
  const now = deps.now ? deps.now() : Date.now();
  if (decision === 'deny') return (await deps.store.updateJob(job.id, { status: 'refused', refusal_category: 'operator_review' }, { onlyIfStatus: 'review' }))[0];
  if (!deps.labReady()) throw new FoundryRefusal('the lab is not set up on this deployment', { status: 503, code: 'unavailable' });
  const p = priced(job.spec, job.offer || {}, { labBudgetUsd: deps.labBudgetUsd, now });
  return (await deps.store.updateJob(job.id, p, { onlyIfStatus: 'review' }))[0];
}

async function creditAndFlag(job, why, deps) {
  const amount = Number(job.build_fee_usd) || 0;
  if (job.payer_hash && amount > 0) await deps.store.credit(job.payer_hash, amount);
  if (deps.notify) await deps.notify({ route: '/foundry', reason: 'foundry_build_failed', message: `Foundry job ${job.id.slice(0, 8)}: ${why}. ${amount > 0 && job.payer_hash ? `$${amount.toFixed(2)} credited to the paying wallet.` : ''}`.trim() });
  return { credited_usd: job.payer_hash ? amount : 0, flagged: true };
}

// deps: { store, gate(job) -> x402 gate, subscriberHash(payer), screen?(payer),
// startBuild(job) -> { ok, id?, reply }, notify?, now }
export async function payBuild(jobId, deps) {
  const job = await deps.store.getJob(jobId);
  if (!job) throw new FoundryRefusal('No such Foundry job.', { status: 404, code: 'not_found' });
  if (!PAYABLE_STATUSES.includes(job.status)) return { job };
  const now = deps.now ? deps.now() : Date.now();
  if (job.quote && job.quote.expires_at && Date.parse(job.quote.expires_at) < now) {
    const [expired] = await deps.store.updateJob(job.id, { status: 'expired' }, { onlyIfStatus: PAYABLE_STATUSES });
    return { job: expired || { ...job, status: 'expired' } };
  }
  const g = await deps.gate(job);
  if (!g.authorized) return { job, paymentRequired: g.paymentRequired };
  if (!g.payer) throw new FoundryRefusal('The payment does not name a paying wallet.', { status: 402, code: 'payment_invalid' });
  if (deps.screen) {
    const s = await deps.screen(g.payer);
    if (s && s.refused) throw new FoundryRefusal(s.message || 'This wallet cannot be served.', { status: 403, code: 'refused' });
  }
  let settled = null;
  try { settled = await g.settle(); } catch (e) { settled = null; }
  if (!settled || !settled.success) return { job, paymentRequired: await g.settlementFailurePaymentRequired((settled && (settled.errorMessage || settled.errorReason)) || 'Settlement failed') };
  const [building] = await deps.store.updateJob(job.id, { status: 'building', payer_hash: deps.subscriberHash(g.payer), settlement_tx: settled.transaction || null, paid_at: new Date(now).toISOString() }, { onlyIfStatus: PAYABLE_STATUSES });
  if (!building) return { job: await deps.store.getJob(job.id), settlement: settled };
  const started = await deps.startBuild(building).catch(() => ({ ok: false, reply: 'the lab could not be reached' }));
  if (!started.ok) {
    const c = await creditAndFlag(building, `the lab build could not start (${String(started.reply || '').slice(0, 120)})`, deps);
    const [failed] = await deps.store.updateJob(job.id, { status: 'build_failed', error: 'lab_start_failed', ...c });
    return { job: failed, settlement: settled };
  }
  const [withLab] = await deps.store.updateJob(job.id, { lab_experiment_id: started.id });
  return { job: withLab || building, settlement: settled };
}

// Moves a building job on from its lab experiment. deps: { store,
// evaluate(job) -> { state: 'pending' | 'pass' | 'fail', gate?, why? },
// notify? }. evaluate syncs the lab run and runs the lab gate (evals and
// CI, safety scan, licence, cost). Resolves to the (maybe updated) job.
export async function refreshBuild(job, deps) {
  if (!job || job.status !== 'building' || !job.lab_experiment_id) return job;
  const ev = await deps.evaluate(job).catch(() => ({ state: 'pending' }));
  if (!ev || ev.state === 'pending') return job;
  if (ev.state === 'pass' && ev.gate && ev.gate.pass) {
    const [next] = await deps.store.updateJob(job.id, { status: 'awaiting_approval', gate: ev.gate }, { onlyIfStatus: 'building' });
    if (next && deps.notify) await deps.notify({ route: '/foundry', reason: 'foundry_awaiting_approval', message: `Foundry job ${job.id.slice(0, 8)} (${job.spec.name}) passed the gate and waits for /foundry approve.` });
    return next || job;
  }
  const c = await creditAndFlag(job, `the lab build ${ev.why || 'did not pass the gate'}`, deps);
  const [next] = await deps.store.updateJob(job.id, { status: 'build_failed', gate: ev.gate || null, error: String(ev.why || 'gate_failed').slice(0, 120), ...c }, { onlyIfStatus: 'building' });
  return next || job;
}

// Deploy needs the operator's approval (foundry:deploy is APPROVAL tier):
// only the signed-in operator's /foundry approve reaches here, and only
// for a job whose lab build passed the gate.
export async function approveBuild(job, { store, audit = null, isOperator = false, env = process.env }) {
  const auth = authorize('foundry:deploy', { actor: isOperator === true ? 'operator' : 'pg1' });
  if (!auth.allowed) throw new FoundryRefusal('Deploying a Foundry tool needs the operator\'s approval.', { status: 403, code: 'needs_approval' });
  if (!job || job.status !== 'awaiting_approval') throw new FoundryRefusal(`Only a job whose build passed the gate can be deployed${job ? ` (this one is ${job.status})` : ''}.`, { status: 409, code: 'not_ready' });
  if (!job.gate || !job.gate.pass) throw new FoundryRefusal('The lab gate has not passed for this job.', { status: 409, code: 'gate_not_passed' });
  validatePlan(job.plan, job.spec.inputs);
  const tool = await store.createTool({
    name: `ft_${job.spec.name}`,
    job_id: job.id,
    description: `PG1 Foundry tool (commissioned): ${job.spec.purpose}`.slice(0, 600),
    input_schema: job.spec.inputs,
    plan: job.plan,
    visibility: job.visibility,
    owner_hash: job.payer_hash,
    per_call_usd: job.per_call_usd,
    commissioner_per_call_usd: job.quote.commissioner_per_call_usd,
    worst_call_cost_usd: job.quote.worst_call_cost_usd,
    status: 'active'
  });
  const [deployed] = await store.updateJob(job.id, { status: 'deployed', tool_id: tool.id }, { onlyIfStatus: 'awaiting_approval' });
  if (audit) await logAutonomy(audit, { action: 'foundry:deploy', decision: 'allowed', mode: 'operator', outcome: 'deployed', detail: `${tool.name} (${tool.visibility})` });
  return { job: deployed, tool, accessKey: toolAccessKey(tool.id, env) };
}

export async function rejectBuild(job, why, deps) {
  if (!job || !['awaiting_approval', 'building'].includes(job.status)) throw new FoundryRefusal('Only a job that is building or waiting for approval can be rejected.', { status: 409, code: 'not_rejectable' });
  const c = await creditAndFlag(job, `rejected by the operator${why ? `: ${why}` : ''}`, deps);
  return (await deps.store.updateJob(job.id, { status: 'rejected', error: 'operator_rejected', ...c }))[0];
}

// What the commissioner sees for a job (no caller or payer hashes).
export function foundryJobView(job, { tool = null, env = process.env } = {}) {
  if (!job) return null;
  const v = { job_id: job.id, status: job.status, name: job.spec && job.spec.name, visibility: job.visibility };
  if (job.status === 'refused') {
    const cat = job.refusal_category;
    v.refusal = cat === 'operator_review' ? { category: cat, reason: 'Declined after review.', alternative: 'PG1\'s existing tools and A2A jobs remain available.' } : { category: cat, ...(REFUSAL_CATEGORIES[cat] || {}) };
  }
  if (job.status === 'review') v.note = 'Waiting for PG1\'s operator to review this request. No payment is taken until it is quoted.';
  if (job.status === 'infeasible') v.reason = job.review_reason;
  if (PAYABLE_STATUSES.includes(job.status) || job.quote) v.quote = job.quote;
  if (job.status === 'building') v.note = 'Building and testing in PG1\'s lab.';
  if (job.status === 'awaiting_approval') v.note = 'Built and tested; waiting for the operator\'s approval to deploy.';
  if (['build_failed', 'rejected'].includes(job.status)) v.credited_usd = Number(job.credited_usd) || 0;
  if (job.status === 'deployed' && job.tool_id) {
    v.tool = { name: tool ? tool.name : `ft_${job.spec.name}`, access_key: toolAccessKey(job.tool_id, env), how_to_call: 'MCP tools/call or A2A skill with this name; send the access key in X-PG1-Tool-Key. Private tools answer only to this key or the commissioning wallet.' };
  }
  return v;
}
