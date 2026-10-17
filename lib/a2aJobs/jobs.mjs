// A2A jobs: the lifecycle other agents go through to buy a job from PG1.
//
//   submitted  SendMessage {skill: "submit_job", arguments: {job_type, input}}
//              -> health check (busy -> 503 with Retry-After, never 402),
//              the kill switch, then validation of every field: nothing is
//              quoted that would not run
//   quote      the job is recorded (status quoted) with its price, ETA and
//              a 15-minute expiry, and answered as an input-required task
//              carrying the x402 payment requirements at the job's price
//              (a2a-x402). A job under $0.05 can use the shared 5/day free
//              tier instead: it is accepted at once.
//   payment    SendMessage on the task (message.taskId = the job id) with
//              the PaymentPayload in message.metadata["x402.payment.payload"]
//              -> the payment is VERIFIED (not settled), the paying wallet
//              is screened (P11 hook), the per-wallet limits
//              (PG1_A2A_JOBS_PER_HOUR, default 5; 2 running at once) and
//              the global limit (PG1_A2A_MAX_JOBS, default 3 running) are
//              checked, and only when the job is accepted to run is the
//              payment settled. A wallet with credit pays from it instead.
//   working    the job runs in the background (waitUntil); GetTask shows
//              its state and, when done, its artifacts
//   completed  artifacts: the JSON result and, where the job makes one, a
//              PDF, both as signed links valid for 7 days
//   failed     after one retry: the price goes to the wallet as a credit
//              for a later job, the operator is flagged; PG1 never claims an
//              on-chain refund
//
// Every decision is from validated schema fields; free text is size-capped
// and only ever data. Jobs are deleted after 30 days and their output
// files after 7 (lib/retention.mjs).

import crypto from 'node:crypto';
import { quoteFor, JobInputError, JOB_TYPES, FREE_TIER_JOB_MAX_USD } from './catalogue.mjs';
import { executeJob, backfillWriteup } from './execute.mjs';
import { createJobStore } from './store.mjs';
import { callerHash } from '../telemetry.mjs';
import { authorize, autonomyMode, logAutonomy } from '../autonomy.mjs';
import { notifyOperator } from '../notify.mjs';

export const QUOTE_TTL_MS = 15 * 60 * 1000;
export const OUTPUT_TTL_DAYS = 7;
export const JOB_TTL_DAYS = 30;
export const MAX_CONCURRENT_PER_WALLET = 2;
export const BUSY_RETRY_AFTER_S = 60;

export const jobsPerHour = (env = process.env) => { const n = Number(env.PG1_A2A_JOBS_PER_HOUR); return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 5; };
export const maxJobs = (env = process.env) => { const n = Number(env.PG1_A2A_MAX_JOBS); return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 3; };

export function payerHash(wallet) {
  return wallet ? callerHash(`wallet:${String(wallet).toLowerCase()}`) : null;
}

// A refusal the A2A layer turns into a JSON-RPC error (never a 402).
export class JobRefusal extends Error {
  constructor(message, { status = 200, code = -32602, retryAfter = null, data = {} } = {}) {
    super(message);
    this.jobRefusal = true;
    this.status = status;
    this.rpcCode = code;
    this.retryAfter = retryAfter;
    this.data = data;
  }
}

// Busy or unhealthy -> 503 with Retry-After, before any quote or payment.
export async function healthCheck({ store, env = process.env }) {
  const mode = autonomyMode(env);
  if (!authorize('a2a:quote', { actor: 'external', mode }).allowed) throw new JobRefusal('PG1 is not accepting jobs right now. Retry later.', { status: 503, code: -32010, retryAfter: 3600, data: { reason: 'paused' } });
  let active;
  try {
    active = await store.activeCount();
  } catch (e) {
    throw new JobRefusal('Jobs are temporarily unavailable. Retry shortly.', { status: 503, code: -32010, retryAfter: 30, data: { reason: 'storage_unavailable' } });
  }
  if (active >= maxJobs(env)) throw new JobRefusal(`PG1 is busy (${active} jobs running). Retry shortly.`, { status: 503, code: -32010, retryAfter: BUSY_RETRY_AFTER_S, data: { reason: 'busy' } });
  return { active };
}

function quoteView(job) {
  return {
    job_id: job.id,
    job_type: job.job_type,
    items: job.items,
    price_usd: Number(job.price_usd),
    currency: 'USD (USDC via x402)',
    eta_seconds: job.eta_s,
    quote_expires_at: job.quote_expires_at,
    outputs: JOB_TYPES[job.job_type].outputs,
    free_tier_eligible: Number(job.price_usd) < FREE_TIER_JOB_MAX_USD,
    how_to_pay: 'Send SendMessage with message.taskId set to job_id and the x402 PaymentPayload in message.metadata["x402.payment.payload"]. The payment is settled only when the job is accepted to run.'
  };
}

// Step 1: submit -> quote (or accepted on the free tier).
// deps: { store, env, callerId, freeTier: { wanted, check(), consume() }, startRun(job) }
export async function submitJob({ jobType, input, deps }) {
  const { store, env = process.env } = deps;
  await healthCheck({ store, env });
  let q;
  try {
    q = quoteFor(jobType, input);
  } catch (e) {
    if (e instanceof JobInputError) throw new JobRefusal(`Invalid job: ${e.message}`, { data: { reason: 'invalid_input' } });
    throw e;
  }
  const now = deps.now ? deps.now() : Date.now();
  const id = crypto.randomUUID();
  const base = {
    id, job_type: q.jobType, status: 'quoted', input: q.input, items: q.items, price_usd: q.priceUsd, worst_cost_usd: q.worstCaseCostUsd,
    eta_s: q.etaSeconds, quote_expires_at: new Date(now + QUOTE_TTL_MS).toISOString(), caller_hash: deps.callerId ? callerHash(deps.callerId) : null, attempts: 0
  };
  // The shared free tier covers a job under $0.05, unless the caller opted out.
  if (q.freeTierEligible && deps.freeTier && deps.freeTier.wanted) {
    const avail = await deps.freeTier.check().catch(() => null);
    if (avail && avail.allowed) {
      const job = await store.create({ ...base, status: 'working', payment: 'free_tier', accepted_at: new Date(now).toISOString() });
      await logAutonomy(deps.audit || {}, { action: 'a2a:job', actor: 'external', decision: 'allowed', outcome: 'free_tier', detail: q.jobType });
      deps.startRun(job, { onSuccess: () => deps.freeTier.consume(avail) });
      return { job, accepted: true, quote: quoteView(job) };
    }
  }
  const job = await store.create(base);
  await logAutonomy(deps.audit || {}, { action: 'a2a:quote', actor: 'external', decision: 'allowed', outcome: 'quoted', detail: `${q.jobType} ${q.items} items $${q.priceUsd}` });
  return { job, accepted: false, quote: quoteView(job) };
}

// Step 2: payment -> accepted (settled) or a refusal. Nothing is settled
// before validation, the health check, screening and every limit pass.
// deps: { store, env, gate: async (job) => { authorized, payer, settle, paymentRequired }, screen: async (wallet) => { allowed, reason }, startRun }
export async function payJob({ jobId, deps }) {
  const { store, env = process.env } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const job = await store.get(jobId);
  if (!job) throw new JobRefusal('Task not found.', { code: -32001, data: { reason: 'not_found' } });
  if (job.status !== 'quoted') return { job, already: true };
  if (Date.parse(job.quote_expires_at) < now) {
    await store.update(job.id, { status: 'expired' }, { onlyIfStatus: 'quoted' });
    throw new JobRefusal('This quote has expired. Submit the job again for a new quote.', { data: { reason: 'quote_expired' } });
  }
  await healthCheck({ store, env });
  const gate = await deps.gate(job);
  if (!gate.authorized) return { job, paymentRequired: gate.paymentRequired };
  const wallet = gate.payer || null;
  if (!wallet) throw new JobRefusal('The payment does not name a paying wallet.', { data: { reason: 'no_payer' } });
  // P11: the paying wallet is screened before anything is settled.
  const screened = deps.screen ? await deps.screen(wallet) : { allowed: true };
  if (!screened.allowed) {
    await store.update(job.id, { status: 'refused', error: 'payer_screening' }, { onlyIfStatus: 'quoted' });
    throw new JobRefusal('PG1 cannot accept this payment.', { data: { reason: 'refused' } });
  }
  const ph = payerHash(wallet);
  const sinceIso = new Date(now - 3600000).toISOString();
  if ((await store.acceptedForPayerSince(ph, sinceIso)) >= jobsPerHour(env)) throw new JobRefusal(`Limit reached: at most ${jobsPerHour(env)} jobs per hour per wallet. Retry later.`, { status: 429, code: -32029, retryAfter: 600, data: { reason: 'wallet_hourly_limit' } });
  if ((await store.activeForPayer(ph)) >= MAX_CONCURRENT_PER_WALLET) throw new JobRefusal(`Limit reached: at most ${MAX_CONCURRENT_PER_WALLET} jobs running at once per wallet. Retry when one finishes.`, { status: 429, code: -32029, retryAfter: 60, data: { reason: 'wallet_concurrency_limit' } });
  // Accepted to run: credit first, else settle the payment now.
  let payment = 'x402';
  let settlement = null;
  if (await store.useCredit(ph, Number(job.price_usd)).catch(() => false)) {
    payment = 'credit';
  } else {
    try {
      settlement = await gate.settle();
    } catch (e) {
      settlement = { success: false, errorReason: 'settlement_error' };
    }
    if (!settlement || !settlement.success) return { job, paymentRequired: await gate.settlementFailurePaymentRequired((settlement && (settlement.errorReason || settlement.errorMessage)) || 'Settlement failed'), settleFailed: true };
  }
  const rows = await store.update(job.id, { status: 'working', payment, payer_hash: ph, accepted_at: new Date(now).toISOString(), settlement: settlement ? { success: true, transaction: settlement.transaction || null, network: settlement.network || null } : null }, { onlyIfStatus: 'quoted' });
  if (!rows.length) return { job: await store.get(job.id), already: true };
  await logAutonomy(deps.audit || {}, { action: 'a2a:job', actor: 'external', decision: 'allowed', outcome: payment, costUsd: 0, detail: `${job.job_type} $${job.price_usd}` });
  deps.startRun(rows[0]);
  return { job: rows[0], accepted: true, settlement };
}

// Runs an accepted job with one retry. On final failure: a credit to the
// wallet (paid jobs), the operator flagged, never an on-chain refund.
export async function runAcceptedJob(job, { store, execDeps, storeOutputs, env = process.env, onSuccess = null, notify = notifyOperator, audit = {}, now = () => Date.now() }) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await executeJob(job, execDeps);
      const artifacts = await storeOutputs(job, out);
      const outputExpires = new Date(now() + OUTPUT_TTL_DAYS * 86400000).toISOString();
      await store.update(job.id, { status: 'completed', attempts: attempt, result: out.json, artifacts, output_expires_at: outputExpires, cost_usd: Number(execDeps.spentUsd ? execDeps.spentUsd() : 0) }, { onlyIfStatus: 'working' });
      if (onSuccess) await onSuccess();
      return { ok: true, attempts: attempt };
    } catch (e) {
      lastError = e;
      await store.update(job.id, { attempts: attempt }, { onlyIfStatus: 'working' }).catch(() => {});
    }
  }
  const paid = job.payment === 'x402' || job.payment === 'credit';
  let credited = 0;
  if (paid && job.payer_hash) {
    try {
      await store.addCredit(job.payer_hash, Number(job.price_usd));
      credited = Number(job.price_usd);
    } catch (e) { credited = 0; }
  }
  await store.update(job.id, { status: 'failed', error: String((lastError && (lastError.code || lastError.message)) || 'failed').slice(0, 120), credited_usd: credited, flagged: true }, { onlyIfStatus: 'working' });
  await notify({ ...audit, route: '/a2a/jobs', reason: 'a2a_job_failed', message: `A2A job ${job.id.slice(0, 8)} (${job.job_type}) failed twice; ${credited ? `$${credited} credited to the paying wallet for a later job` : 'nothing was paid'}. No on-chain refund was made.` });
  return { ok: false, credited };
}

// The write-ups that completed while no AI engine was available
// (ai_summary "pending"): each one's analysis is written now from its
// stored results, and its result and PDF are replaced. One that still
// finds no engine stays pending for the next run (the hourly pulse).
// Resolves to { checked, filled }.
export async function backfillPendingWriteups({ store, execDeps, storeOutputs, limit = 5 }) {
  const jobs = await store.pendingWriteups({ limit });
  let filled = 0;
  for (const job of jobs) {
    try {
      const out = await backfillWriteup(job, execDeps);
      if (!out) continue;
      const artifacts = await storeOutputs(job, out);
      const rows = await store.update(job.id, { result: out.json, artifacts }, { onlyIfStatus: 'completed' });
      if (rows.length) filled++;
    } catch (e) { /* the next run tries again */ }
  }
  return { checked: jobs.length, filled };
}

// What GetTask and the reply show for a job. Signed links are made fresh.
export async function jobView(job, { signArtifact = null } = {}) {
  const view = { job_id: job.id, job_type: job.job_type, status: job.status, items: job.items, price_usd: Number(job.price_usd), payment: job.payment || null, attempts: job.attempts || 0 };
  if (job.status === 'quoted') Object.assign(view, { quote_expires_at: job.quote_expires_at, eta_seconds: job.eta_s });
  if (job.status === 'failed') {
    view.error = job.error || 'failed';
    view.credit_usd = Number(job.credited_usd) || 0;
    view.note = view.credit_usd ? `The job failed after a retry. ${view.credit_usd} USD is held as credit for this wallet's next PG1 job; no on-chain refund is made.` : 'The job failed after a retry; nothing was charged.';
  }
  if (job.status === 'completed') {
    const expired = job.output_expires_at && Date.parse(job.output_expires_at) < Date.now();
    view.output_expires_at = job.output_expires_at;
    // A write-up finished without an AI engine: the results are complete,
    // the written analysis follows (backfillPendingWriteups).
    if (job.result && job.result.ai_summary) view.ai_summary = job.result.ai_summary;
    view.artifacts = expired ? [] : await Promise.all((job.artifacts || []).map(async (a) => ({ kind: a.kind, name: a.name, mime_type: a.mime_type, url: signArtifact ? await signArtifact(a).catch(() => null) : null, pages: a.pages || undefined })));
  }
  return view;
}

export { createJobStore };
