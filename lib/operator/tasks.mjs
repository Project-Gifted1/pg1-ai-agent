// Findings from the reports become tasks with their evidence (the counts),
// and PG1 acts on them (lib/operator/tick.mjs moves them along):
//
//   fix, improve  a lab code experiment opens a PR; if it qualifies as low
//                 risk (lib/operator/merge.mjs) PG1 merges it itself and
//                 watches the deploy, otherwise it waits for approval
//   new           research and a prototype in the lab, then a PR for the
//                 operator's approval (never merged automatically)
//   listing,      PG1 prepares everything (listing text and steps; the price
//   pricing       with the 1.5x worst-case cost check) and puts an approval
//                 button in the next report
//
// One task per finding (finding_key is unique), so a finding seen again
// next day is not acted on twice. Approving runs the item under its own
// APPROVAL action (code:merge, directory:register, pricing:change) with
// approved: true, and is logged. Nothing approves itself: only the
// signed-in operator's decision (decideTask, actor 'operator') does, and an
// item not decided in APPROVAL_TTL_MS expires and is reported.

import { authorize, autonomyMode, logAutonomy, TIERS, tierOf } from '../autonomy.mjs';
import { X402_PRICE, x402PriceUsd } from '../x402Config.mjs';
import { priceCoversCost, minimumPrice, MIN_PRICE_MULTIPLIER } from '../pricing.mjs';
import { PG1_VERSION } from '../identity.mjs';
import { ERROR_FAULT } from '../usageStats.mjs';

export const APPROVAL_TTL_MS = 7 * 24 * 3600000;
export const FIX_MIN_ERRORS = 5;
export const IMPROVE_MIN_CALLER_ERRORS = 10;
export const NEW_MIN_REAL = 3;
export const PRICING_MIN_402 = 20;
export const MAX_NEW_TASKS_PER_RUN = 5;
// The action an approval runs, per task kind.
export const APPROVAL_ACTIONS = Object.freeze({ fix: 'code:merge', improve: 'code:merge', new: 'code:merge', listing: 'directory:register', pricing: 'pricing:change' });

const isoWeek = (ms) => {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / 86400000 + 1) / 7)).padStart(2, '0')}`;
};
const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9:._/-]+/g, '-').slice(0, 120);

// Findings from a daily report's data.
export function dailyFindings(data) {
  const out = [];
  const l = data.last24;
  if (l && l.ok) {
    for (const c of (l.errors.breakdown || [])) {
      if ((c.fault || ERROR_FAULT[c.type]) !== 'pg1' || Number(c.real) < FIX_MIN_ERRORS) continue;
      out.push({ kind: 'fix', key: key(`fix:${c.tool}:${c.type}:${String(data.to).slice(0, 10)}`), title: `Fix ${c.tool}: ${c.real} ${c.type} errors for real callers in 24 hours`, evidence: { tool: c.tool, type: c.type, route: c.route, real_errors: Number(c.real), probe_errors: Number(c.probe) || 0, window: '24h' } });
    }
  }
  return out;
}

// Findings from a weekly report's data.
export function weeklyFindings(data, { stats = null } = {}) {
  const out = [];
  const week = isoWeek(data.now);
  const d = data.demand;
  if (d && d.ok) {
    for (const t of d.unknown_tools) if (Number(t.real) >= NEW_MIN_REAL && /^[\w./-]{2,64}$/.test(t.name)) out.push({ kind: 'new', key: key(`new:tool:${t.name}`), title: `New tool asked for: ${t.name} (${t.real} real calls in 7 days)`, evidence: { requested_tool: t.name, real: Number(t.real), probe: Number(t.probe), window: '7d' } });
    for (const m of d.unknown_methods) if (Number(m.real) >= NEW_MIN_REAL && m.method !== 'other' && /^[\w./-]{2,40}$/.test(m.method)) out.push({ kind: 'new', key: key(`new:method:${m.method}`), title: `New MCP method asked for: ${m.method} (${m.real} real requests in 7 days)`, evidence: { method: m.method, real: Number(m.real), probe: Number(m.probe), window: '7d' } });
  }
  const errs = data.errors;
  if (errs) {
    for (const c of (errs.breakdown || [])) {
      if ((c.fault || ERROR_FAULT[c.type]) !== 'caller' || Number(c.real) < IMPROVE_MIN_CALLER_ERRORS) continue;
      out.push({ kind: 'improve', key: key(`improve:${c.tool}:${c.type}:${week}`), title: `Improve ${c.tool}: ${c.real} ${c.type} answers to real callers in 7 days (clearer inputs and messages)`, evidence: { tool: c.tool, type: c.type, real: Number(c.real), window: '7d' } });
    }
  }
  const r = data.discovery && data.discovery.registry;
  if (r && r.ok && !r.matches) out.push({ kind: 'listing', key: key(`listing:mcp-registry:${r.live}`), title: r.listed ? `MCP registry lists ${r.listed}; live is ${r.live}` : `Not listed in the MCP registry (live ${r.live})`, evidence: { listed: r.listed, live: r.live } });
  const f = data.funnel;
  if (f && f.ok && Number(f.payment_requests) >= PRICING_MIN_402 && Number(f.payments_settled) === 0) out.push({ kind: 'pricing', key: key(`pricing:402-unsettled:${week}`), title: `${f.payment_requests} payment requests, none settled in 7 days: review the price`, evidence: { payment_requests: Number(f.payment_requests), payments_settled: 0, callers_hit_free_limit: Number(f.callers_hit_free_limit) || 0, window: '7d' } });
  if (data.proposals && data.proposals.ok) {
    for (const p of data.proposals.list) if (p.status === 'proposed' && p.price_usd != null) out.push({ kind: 'pricing', key: key(`pricing:proposal:${p.id}`), title: `Price for the proposal "${String(p.title).slice(0, 80)}"`, evidence: { opportunity_id: p.id, price_usd: Number(p.price_usd), run_cost_per_call_usd: p.run_cost_per_call_usd == null ? null : Number(p.run_cost_per_call_usd) } });
  }
  return out;
}

// The price with the 1.5x worst-case cost check. worstCaseUsd null: not
// known, so it cannot be approved.
export function pricingProposal({ priceUsd, worstCaseUsd }) {
  const known = Number.isFinite(worstCaseUsd) && worstCaseUsd >= 0;
  const ok = known && priceCoversCost(priceUsd, worstCaseUsd);
  return {
    price_usd: priceUsd,
    worst_case_cost_usd: known ? worstCaseUsd : null,
    min_price_usd: known ? minimumPrice(worstCaseUsd) : null,
    check: known ? `${ok ? 'meets' : 'does NOT meet'} the ${MIN_PRICE_MULTIPLIER}x worst-case cost rule (minimum ${minimumPrice(worstCaseUsd)} USD)` : 'worst-case cost per call is not known (PG1_PAID_CALL_WORST_CASE_USD), so the 1.5x check cannot run',
    ok
  };
}

// What a listing or pricing task asks the operator to approve.
export function prepareApproval(f, { env = process.env } = {}) {
  if (f.kind === 'listing') {
    return {
      action: 'directory:register', approvable: true,
      reason: `Listing out of date: ${f.evidence.listed ? `registry has ${f.evidence.listed}` : 'not listed'}, live is ${f.evidence.live}.`,
      listing_text: `PG1 threat intelligence MCP server, version ${PG1_VERSION}: wallet, domain, package and agent-message checks for AI agents, with x402 pay-per-call.`,
      steps: ['Approve: PG1 runs the publish-mcp workflow on main, which publishes server.json to the MCP registry.', 'PG1 checks the registry version in the next weekly report.'],
      workflow: 'publish-mcp.yml'
    };
  }
  if (f.kind === 'pricing') {
    const proposalPrice = f.evidence.price_usd;
    const priceUsd = Number.isFinite(proposalPrice) ? proposalPrice : x402PriceUsd(X402_PRICE);
    const worst = f.evidence.run_cost_per_call_usd != null ? Number(f.evidence.run_cost_per_call_usd) : Number(env.PG1_PAID_CALL_WORST_CASE_USD);
    const p = pricingProposal({ priceUsd, worstCaseUsd: Number.isFinite(worst) ? worst : null });
    return { action: 'pricing:change', approvable: p.ok, reason: `${f.title}. Price ${priceUsd} USD: ${p.check}.`, pricing: p, steps: ['Approve: PG1 opens a lab PR that sets the price; it is never merged automatically (pricing code), so it comes back to you.'] };
  }
  return { action: APPROVAL_ACTIONS[f.kind] || 'code:merge', approvable: true, reason: f.title };
}

// Turns findings into tasks and starts the work. startLab({ kind, goal,
// input, action }) -> { ok, id, reply } (lib/lab/chat.mjs
// startLabExperiment). Never throws.
export async function actOnFindings({ findings, opStore, env = process.env, audit, startLab, now = Date.now() }) {
  const out = { created: 0, started: 0, approvals: 0, skipped: 0, refused: null };
  const gate = authorize('task:act', { actor: 'pg1', mode: autonomyMode(env) });
  if (!gate.allowed) {
    await logAutonomy(audit, { action: 'task:act', decision: gate.decision, mode: autonomyMode(env), detail: gate.reason });
    out.refused = gate.reason;
    return out;
  }
  let made = 0;
  for (const f of findings) {
    if (made >= MAX_NEW_TASKS_PER_RUN) break;
    let existing = null;
    try { existing = await opStore.taskByKey(f.key); } catch (e) { existing = null; }
    if (existing) { out.skipped++; continue; }
    const base = { finding_key: f.key, kind: f.kind, title: f.title, evidence: f.evidence };
    if (f.kind === 'listing' || f.kind === 'pricing') {
      await opStore.addTask({ ...base, status: 'needs_approval', approval: prepareApproval(f, { env }), approval_requested_at: new Date(now).toISOString() });
      await logAutonomy(audit, { action: APPROVAL_ACTIONS[f.kind], decision: 'needs_approval', mode: autonomyMode(env), detail: f.title });
      out.created++; out.approvals++; made++;
      continue;
    }
    const task = await opStore.addTask({ ...base, status: 'open' });
    out.created++; made++;
    const started = await startTaskLab({ task, startLab });
    if (started.ok) { await opStore.updateTask(task.id, { status: 'lab_running', experiment_id: started.id, detail: started.reply }); out.started++; }
    else await opStore.updateTask(task.id, { detail: `lab not started: ${started.reply || 'unknown'}` });
  }
  await logAutonomy(audit, { action: 'task:act', decision: 'allowed', mode: autonomyMode(env), outcome: 'done', detail: `${out.created} tasks, ${out.started} lab experiments, ${out.approvals} approvals` });
  return out;
}

export function labGoalFor(task) {
  const ev = JSON.stringify(task.evidence || {}).slice(0, 400);
  if (task.kind === 'fix') return { kind: 'code', action: 'lab:dispatch', goal: `Fix: ${task.title}. Find the cause of these errors and patch it with a test that reproduces it. Keep the change small; do not touch MCP tool names, inputs or outputs, SQL, env vars, pricing, payment, x402, licence or signing code. Evidence: ${ev}` };
  if (task.kind === 'improve') return { kind: 'code', action: 'lab:dispatch', goal: `Improve: ${task.title}. Make the inputs and error messages clearer, with tests. Keep the change small; do not change MCP tool names, inputs or output shapes, SQL, env vars, pricing, payment, x402, licence or signing code. Evidence: ${ev}` };
  return { kind: 'code', action: 'opportunity:prototype', goal: `Research and prototype: ${task.title}. Research what callers expect from it, then build a prototype behind a feature flag with tests, and open a PR for the operator's approval. Do not launch, price or publish it. Evidence: ${ev}` };
}

async function startTaskLab({ task, startLab }) {
  const g = labGoalFor(task);
  try {
    const r = await startLab({ kind: g.kind, goal: g.goal.slice(0, 1000), input: { notes: `operator task ${task.id}`, operator_task_id: task.id }, action: g.action });
    return r && r.ok ? { ok: true, id: r.id, reply: String(r.reply || '').slice(0, 300) } : { ok: false, reply: String((r && r.reply) || 'not started').slice(0, 300) };
  } catch (e) {
    return { ok: false, reply: 'the lab could not be reached' };
  }
}

// The operator's decision on a task. Only actor 'operator' may decide:
// nothing PG1 runs can approve its own item.
export class SelfApprovalRefused extends Error {}

export async function decideTask({ id, decision, actor, opStore, env = process.env, fetchImpl = globalThis.fetch, audit, gh = null, startLab = null, mergeApproved = null, now = Date.now() }) {
  if (actor !== 'operator') throw new SelfApprovalRefused('Only the signed-in operator can approve or decline an item.');
  const task = await opStore.getTask(id);
  if (!task || task.status !== 'needs_approval') return { ok: false, message: 'That item is not waiting for a decision.' };
  const a = task.approval || {};
  const action = a.action || APPROVAL_ACTIONS[task.kind] || 'code:merge';
  if (decision !== 'approve') {
    await opStore.updateTask(task.id, { status: 'declined', decided_at: new Date(now).toISOString() });
    await logAutonomy(audit, { action, actor: 'operator', decision: 'denied', mode: autonomyMode(env), outcome: 'declined', detail: task.title });
    return { ok: true, decision: 'declined', message: 'Declined. Nothing was changed.' };
  }
  if (a.approvable === false) return { ok: false, message: `This item cannot be approved as it stands: ${a.reason || 'its check did not pass'}.` };
  if (tierOf(action) === TIERS.NEVER) return { ok: false, message: 'That is never allowed.' };
  const d = authorize(action, { actor: 'pg1', mode: autonomyMode(env), approved: true });
  if (!d.allowed) return { ok: false, message: `Not run: ${d.reason}.` };
  await opStore.updateTask(task.id, { status: 'approved', decided_at: new Date(now).toISOString() });
  await logAutonomy(audit, { action, actor: 'operator', decision: 'allowed', mode: autonomyMode(env), outcome: 'approved', detail: task.title });
  let message = 'Approved.';
  if (action === 'code:merge' && mergeApproved) {
    const r = await mergeApproved(task);
    message = r.ok ? `Approved and merged PR #${task.pr_number}; PG1 is watching the production deploy and rolls it back if it fails or degrades.` : `Approved, but the merge did not go through: ${r.reason}.`;
  } else if (action === 'directory:register' && gh && a.workflow) {
    const ok = await gh.dispatch(a.workflow).catch(() => false);
    await opStore.updateTask(task.id, { status: ok ? 'done' : 'approved', detail: ok ? `ran ${a.workflow}` : `${a.workflow} could not be started; steps: ${(a.steps || []).join(' ')}` });
    message = ok ? `Approved: PG1 started ${a.workflow}. The next weekly report checks the registry version.` : `Approved, but ${a.workflow} could not be started. The steps: ${(a.steps || []).join(' ')}`;
  } else if (action === 'pricing:change' && startLab) {
    const p = a.pricing || {};
    const r = await startLab({ kind: 'code', goal: `Set the price to ${p.price_usd} USD per paid call as approved by the operator (${task.title}). Change only the price constant and its tests.`, input: { operator_task_id: task.id }, action: 'lab:dispatch' }).catch(() => null);
    if (r && r.ok) await opStore.updateTask(task.id, { status: 'lab_running', experiment_id: r.id, detail: 'price PR in the lab; it comes back for approval to merge' });
    message = r && r.ok ? 'Approved: the price change is being prepared in the lab; its PR comes back to you to merge (pricing is never merged automatically).' : 'Approved, but the lab could not start the price change.';
  }
  return { ok: true, decision: 'approved', message };
}

// Items not decided within APPROVAL_TTL_MS expire. Returns the expired.
export async function expireApprovals({ opStore, autoStore = null, now = Date.now(), audit, env = process.env }) {
  const cutoff = now - APPROVAL_TTL_MS;
  const expired = [];
  for (const t of await opStore.listTasks({ statuses: ['needs_approval'], limit: 200 })) {
    const at = Date.parse(t.approval_requested_at || t.updated_at || t.created_at);
    if (Number.isFinite(at) && at < cutoff) {
      await opStore.updateTask(t.id, { status: 'expired', detail: `not approved within 7 days (asked ${new Date(at).toISOString().slice(0, 10)})` });
      expired.push({ id: t.id, title: t.title, source: 'task' });
    }
  }
  if (autoStore) {
    for (const r of await autoStore.listActions({ statuses: ['needs_approval'], limit: 100 })) {
      if (Date.parse(r.at) < cutoff) {
        await autoStore.updateAction(r.id, { status: 'expired', finished_at: new Date(now).toISOString() });
        expired.push({ id: r.id, title: (r.approval && r.approval.title) || r.type, source: 'action' });
      }
    }
  }
  if (expired.length) await logAutonomy(audit, { action: 'task:act', decision: 'allowed', mode: autonomyMode(env), outcome: 'expired', detail: `${expired.length} approval${expired.length === 1 ? '' : 's'} expired after 7 days` });
  return expired;
}
