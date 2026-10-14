// /lab and /promote in the chat (signed-in operator only).
//
//   /lab start <goal> [--kind research|skill|code] [--skill <name>] [--url <https url>]...
//                         checks the budgets, records the experiment and
//                         dispatches .github/workflows/lab.yml with a signed
//                         token; nothing runs on this server
//   /lab status           the latest experiments; finished runs are read
//                         back (result artifact), their spend goes on the
//                         ledger, skill drafts are stored with status lab,
//                         and a candidate that passes the gate gets the
//                         operator's approval card with the evidence
//   /lab stop <id>        cancels the run
//   /lab report <id>      the findings report and the gate's evidence
//   /promote <key>        a flag from operator-only to public (the second
//                         rollout step); /promote alone lists the flags
//
// Approving the card (LAB_PROMOTE) turns the candidate on for the operator
// only: a skill becomes active, a code change is marked approved for the
// operator to merge (PG1 never merges), and a flag is created at stage
// "operator". Declining discards it.

import crypto from 'node:crypto';
import { LAB_KINDS, labBudgetUsd, labDailyUsd } from './policy.mjs';
import { signLabToken } from './token.mjs';
import { createLabGithub } from './github.mjs';
import { createLabStore, ACTIVE_LAB_STATUSES } from './store.mjs';
import { evaluateGate, gateEvidenceText } from './gate.mjs';
import { createSkillStore } from '../skills/store.mjs';
import { createFlagStore, FLAG_STAGES } from '../flags.mjs';
import { authorize, autonomyMode, logAutonomy } from '../autonomy.mjs';

export const LAB_PROMOTE_ACTION = 'LAB_PROMOTE';
export function isLabAction(type) {
  return type === LAB_PROMOTE_ACTION;
}

export function isLabCommand(text) {
  return /^\/(?:lab|promote)(?:\s|$)/i.test(String(text || '').trim());
}

export function parseLabCommand(text) {
  const t = String(text || '').trim();
  const promote = /^\/promote\b\s*(\S*)/i.exec(t);
  if (promote) return { sub: 'promote', id: promote[1].toLowerCase(), goal: '', opts: {} };
  const body = t.replace(/^\/lab\b\s*/i, '');
  const m = /^(\S+)\s*([\s\S]*)$/.exec(body);
  if (!m) return { sub: 'help', id: '', goal: '', opts: {} };
  const sub = m[1].toLowerCase();
  if (sub === 'start') {
    let rest = m[2];
    const opts = { kind: 'research', urls: [], skill: '' };
    rest = rest.replace(/--kind\s+(\S+)/i, (x, k) => { opts.kind = k.toLowerCase(); return ''; });
    rest = rest.replace(/--skill\s+(\S+)/i, (x, k) => { opts.skill = k.toLowerCase(); opts.kind = 'skill'; return ''; });
    rest = rest.replace(/--url\s+(\S+)/gi, (x, u) => { opts.urls.push(u); return ''; });
    return { sub, id: '', goal: rest.replace(/\s+/g, ' ').trim().slice(0, 1000), opts };
  }
  if (['status', 'list'].includes(sub)) return { sub: 'status', id: '', goal: '', opts: {} };
  if (['stop', 'report'].includes(sub)) return { sub, id: (m[2].trim().split(/\s+/)[0] || '').toLowerCase(), goal: '', opts: {} };
  return { sub: 'help', id: '', goal: '', opts: {} };
}

export const LAB_HELP_TEXT = [
  '### [ LAB ]',
  '- **/lab start** <goal> [--kind research|skill|code] [--skill <name>] [--url <https url>]: one experiment on the lab runner (GitHub Actions, lab-only keys, no production data or payment keys)',
  '- **/lab status**, **/lab stop** <id>, **/lab report** <id>',
  '- **/promote** <flag>: from operator-only to public; **/promote** alone lists the flags',
  'Budgets: PG1_LAB_BUDGET_USD per experiment (default $2) and PG1_LAB_DAILY_USD per day (default $5). Results reach your approval card only after the gate: evals or CI, the safety scan, the licence check and the cost check. Code comes back as a DRAFT pull request that PG1 never merges.'
].join('\n');

const utcDay = (now) => new Date(now).toISOString().slice(0, 10);
const usd = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

// The gate's candidate for a finished result.
export function candidateFor(exp, result) {
  if (!result) return null;
  if (exp.kind === 'skill' && Array.isArray(result.skill_drafts) && result.skill_drafts[0]) return { type: 'skill', skill: result.skill_drafts[0], sources: [], pricing: null };
  if (exp.kind === 'code' && result.code && result.code.pr_number) return { type: 'code', files: result.code.files || [], pr_number: result.code.pr_number, pr_url: result.code.pr_url, sources: [], pricing: null };
  return null;
}

async function ingest({ exp, result, store, gh, supUrl, supKey, fetchImpl, guard, now }) {
  const patch = { status: ['done', 'failed', 'over_budget', 'timeout'].includes(result.status) ? result.status : 'failed', spent_usd: Number(result.spent_usd) || 0, result: { ...result, report_markdown: String(result.report_markdown || '').slice(0, 60000) }, error: result.error ? String(result.error).slice(0, 300) : null };
  await store.recordSpend({ experimentId: exp.id, spentUsd: patch.spent_usd, day: utcDay(now) }).catch(() => {});
  // Skill drafts come back as status "lab": never active until approved.
  for (const draft of Array.isArray(result.skill_drafts) ? result.skill_drafts : []) {
    try {
      const skills = createSkillStore({ supUrl, supKey, fetchImpl, guard });
      const name = (await skills.get(draft.name)) ? `${draft.name.slice(0, 40)}-${exp.id.slice(0, 4)}` : draft.name;
      await skills.create({ ...draft, name, origin: result.untrusted ? 'web' : 'lab' }, { status: 'lab', changeNote: `lab experiment ${exp.id.slice(0, 8)}` });
      if (draft.name !== name) draft.name = name;
    } catch (e) { /* the report still says what was drafted */ }
  }
  // The weekly opportunity scan's proposals (lib/opportunities.mjs).
  if (Array.isArray(result.proposals) && result.proposals.length) {
    try {
      const { storeProposals } = await import('../opportunities.mjs');
      await storeProposals({ supUrl, supKey, fetchImpl, experimentId: exp.id, proposals: result.proposals });
    } catch (e) { /* the report still lists them */ }
  }
  patch.candidate = candidateFor(exp, result);
  // An opportunity prototype carries its data sources and price into the
  // gate: the licence check needs cited resale terms, the cost check 1.5x.
  if (patch.candidate && patch.candidate.type === 'code') {
    try {
      const { createOpportunityStore } = await import('../opportunities.mjs');
      const opp = (await createOpportunityStore({ supUrl, supKey, fetchImpl }).list(100)).find((o) => o.prototype_experiment_id === exp.id);
      if (opp) {
        patch.candidate.sources = (opp.data_sources || []).filter((d) => d.licence_status !== 'own_data').map((d) => ({ url: d.url || d.name, licence: d.licence_status === 'unverified' || d.licence_status === 'not_permitted' ? 'unverified' : d.licence_status, resale_terms_url: d.resale_terms_url || (d.licence_status === 'public_domain' ? d.url : null) }));
        if (opp.price_usd != null && opp.run_cost_per_call_usd != null) patch.candidate.pricing = { price_usd: Number(opp.price_usd), worst_case_cost_usd: Number(opp.run_cost_per_call_usd) };
        patch.candidate.opportunity_id = opp.id;
      }
    } catch (e) { /* no opportunity: an ordinary code candidate */ }
  }
  await logAutonomy({ supUrl, supKey, fetchImpl }, { action: 'lab:ingest', actor: 'lab', decision: 'allowed', costUsd: patch.spent_usd, outcome: patch.status, detail: `experiment ${exp.id.slice(0, 8)} ${exp.kind}` });
  return { ...(await store.update(exp.id, patch)), result: patch.result };
}

// Runs the gate on a finished experiment's candidate; when it passes and
// no card exists yet, creates the approval card. Returns { gate, card }.
async function gateAndPropose({ exp, store, gh, guard, audit = {} }) {
  const candidate = exp.candidate;
  if (!candidate || exp.approval_token || exp.promoted_stage !== 'none') return { gate: exp.gate || null, card: null };
  const ci = candidate.type === 'code' && gh.configured ? await gh.prChecks(candidate.pr_number) : null;
  if (ci && ci.state === 'pending') return { gate: { pass: false, pending: true, checks: [{ name: 'evals', ok: false, evidence: 'CI still running' }] }, card: null };
  const gate = evaluateGate({ candidate, result: exp.result || {}, ci, guard });
  let card = null;
  if (gate.pass) {
    const evidence = `Lab experiment ${exp.id.slice(0, 8)} (${exp.kind}): ${exp.goal}\nSpent $${usd(exp.spent_usd)} of $${usd(exp.budget_usd)}.\n\n${gateEvidenceText(gate)}\n\nApproving turns it on for the operator only (/promote makes it public later).${candidate.type === 'code' ? ` PG1 never merges: merge ${candidate.pr_url} yourself.` : ''}`;
    card = await store.createPendingAction({ actionType: LAB_PROMOTE_ACTION, plan: { experiment_id: exp.id, candidate }, diffSummary: evidence });
    await store.update(exp.id, { gate, approval_token: card.token });
    card.evidence = evidence;
    await logAutonomy(audit, { action: 'lab:approval_card', decision: 'allowed', outcome: 'card', detail: `experiment ${exp.id.slice(0, 8)} passed the gate` });
  } else {
    await store.update(exp.id, { gate });
  }
  return { gate, card };
}

function statusLine(e) {
  return `- ${e.id.slice(0, 8)} · ${e.kind} · ${e.status} · $${usd(e.spent_usd)} of $${usd(e.budget_usd)} · ${String(e.goal).slice(0, 60)}${e.gate ? ` · gate ${e.gate.pass ? 'passed' : e.gate.pending ? 'waiting on CI' : 'failed'}` : ''}${e.promoted_stage && e.promoted_stage !== 'none' ? ` · ${e.promoted_stage}` : ''}`;
}

// Starts one experiment: the kill switch, the lab's setup, the daily budget
// (spent today on the ledger plus every queued or running experiment's
// budget), the record, the signed dispatch, the audit log. Used by /lab
// start, the weekly opportunity scan and /opportunities approve.
// Resolves to { ok, id?, reply }. Never throws.
export async function startLabExperiment({ env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, kind, goal, input = {}, action = 'lab:dispatch', now = Date.now() }) {
  const audit = { supUrl, supKey, fetchImpl };
  try {
    const allowed = authorize(action, { actor: 'pg1', mode: autonomyMode(env) });
    if (!allowed.allowed) {
      await logAutonomy(audit, { action, decision: allowed.decision, mode: autonomyMode(env), detail: allowed.reason });
      return { ok: false, reply: `Not started: ${allowed.reason}. Set PG1_AUTONOMY=lab or on to use the lab.` };
    }
    if (!LAB_KINDS.includes(kind)) return { ok: false, reply: `Kind must be ${LAB_KINDS.join(', ')}.` };
    const store = createLabStore({ supUrl, supKey, fetchImpl });
    const gh = createLabGithub({ env, fetchImpl });
    const secret = String(env.PG1_LAB_DISPATCH_SECRET || '').trim();
    if (!secret || !gh.configured) return { ok: false, reply: 'The lab is not set up on this deployment (PG1_LAB_DISPATCH_SECRET and a GitHub token with Actions access are needed). Nothing was started.' };
    const budget = labBudgetUsd(env);
    const daily = labDailyUsd(env);
    const spent = await store.spentToday(utcDay(now));
    const reserved = (await store.active()).reduce((n, r) => n + (Number(r.budget_usd) || 0), 0);
    if (spent + reserved + budget > daily + 1e-9) {
      await logAutonomy(audit, { action, decision: 'denied', mode: autonomyMode(env), detail: 'over the daily lab budget' });
      return { ok: false, reply: `Not started: today's lab budget is $${usd(daily)}; $${usd(spent)} is spent and $${usd(reserved)} is reserved by running experiments, so another $${usd(budget)} experiment would go over. Try again tomorrow (UTC) or raise PG1_LAB_DAILY_USD yourself.` };
    }
    const g = String(goal || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    const inputB64 = input && Object.keys(input).length ? Buffer.from(JSON.stringify(input)).toString('base64') : '';
    const id = crypto.randomUUID();
    await store.create({ id, kind, goal: g, status: 'queued', budget_usd: budget, spent_usd: 0, promoted_stage: 'none' });
    const token = signLabToken({ id, kind, budgetUsd: budget, goal: g, input: inputB64, secret, now });
    const d = await gh.dispatch({ id, kind, goal: g, input: inputB64, budgetUsd: budget, token });
    if (!d.ok) {
      await store.update(id, { status: 'failed', error: `dispatch ${d.status}` });
      return { ok: false, reply: `The lab runner could not be started (GitHub ${d.status}). Nothing was spent.` };
    }
    await logAutonomy(audit, { action, decision: 'allowed', mode: autonomyMode(env), outcome: 'queued', detail: `experiment ${id.slice(0, 8)} ${kind}, budget $${usd(budget)}` });
    return { ok: true, id, reply: `Lab experiment ${id.slice(0, 8)} queued (${kind}, budget $${usd(budget)}; today: $${usd(spent)} spent, $${usd(reserved + budget)} reserved of $${usd(daily)}). Check it with /lab status.` };
  } catch (e) {
    return { ok: false, reply: 'The lab could not be reached right now.' };
  }
}

// Resolves to { reply, pendingApproval? }. Never throws.
export async function handleLabCommand({ text, env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, isOperator = false, guard = null, now = Date.now() }) {
  if (isOperator !== true) return { reply: 'The lab is for the signed-in operator only.' };
  const cmd = parseLabCommand(text);
  if (cmd.sub === 'help') return { reply: LAB_HELP_TEXT };
  let store;
  try {
    store = createLabStore({ supUrl, supKey, fetchImpl });
  } catch (e) {
    return { reply: e.message };
  }
  const gh = createLabGithub({ env, fetchImpl });
  try {
    if (cmd.sub === 'promote') {
      const flags = createFlagStore({ supUrl, supKey, fetchImpl });
      if (!cmd.id) {
        const rows = await flags.list();
        return { reply: rows.length ? ['### [ FLAGS ]', ...rows.map((f) => `- ${f.key} · ${f.stage}${f.disabled_reason ? ` (${f.disabled_reason})` : ''}`)].join('\n') : 'No feature flags yet. Approved lab candidates appear here at stage operator.' };
      }
      const f = await flags.get(cmd.id);
      if (!f) return { reply: `There is no flag called ${cmd.id}. /promote lists them.` };
      if (f.stage === 'public') return { reply: `${f.key} is already public.` };
      if (f.stage === 'disabled' && !/auto-disabled/.test(String(f.disabled_reason || ''))) return { reply: `${f.key} is disabled (${f.disabled_reason}). It goes back through the lab before it can be public.` };
      await flags.setStage(f.key, 'public');
      await logAutonomy({ supUrl, supKey, fetchImpl }, { action: 'flag:public_rollout', actor: 'operator', decision: 'allowed', detail: f.key });
      return { reply: `${f.key} is now public. The hourly monitor switches it off and tells you if its error rate or cost per call passes its threshold.` };
    }
    if (cmd.sub === 'start') {
      if (!cmd.goal) return { reply: 'Say what the experiment is for: /lab start <goal>.' };
      const input = {};
      if (cmd.opts.urls.length) input.urls = cmd.opts.urls.filter((u) => /^https:\/\//i.test(u)).slice(0, 5);
      if (cmd.opts.skill) {
        const sk = await createSkillStore({ supUrl, supKey, fetchImpl, guard }).get(cmd.opts.skill);
        if (!sk) return { reply: `There is no skill called ${cmd.opts.skill}.` };
        input.skill = { name: sk.name, description: sk.description, instructions: sk.instructions, allowed_tools: sk.allowed_tools, evals: sk.evals };
      }
      const started = await startLabExperiment({ env, supUrl, supKey, fetchImpl, kind: cmd.opts.kind, goal: cmd.goal, input, now });
      return { reply: started.reply };
    }
    if (cmd.sub === 'status') {
      const rows = await store.list(10);
      let pendingApproval = null;
      const notes = [];
      for (const e of rows) {
        if (!gh.configured) break;
        if (ACTIVE_LAB_STATUSES.includes(e.status)) {
          const run = e.run_id ? await gh.getRun(e.run_id) : await gh.findRun(e.id);
          if (!run) continue;
          if (!e.run_id) await store.update(e.id, { run_id: run.id, status: 'running' });
          e.status = 'running';
          if (run.status === 'completed') {
            const result = run.conclusion === 'cancelled' ? null : await gh.result(run.id, e.id);
            if (result) Object.assign(e, await ingest({ exp: { ...e }, result, store, gh, supUrl, supKey, fetchImpl, guard, now }));
            else Object.assign(e, await store.update(e.id, { status: run.conclusion === 'cancelled' ? 'stopped' : 'failed', error: run.conclusion === 'cancelled' ? null : 'no result from the runner' }));
          }
        }
        if (e.status === 'done' && e.candidate && !e.approval_token && (!e.promoted_stage || e.promoted_stage === 'none')) {
          const full = await store.get(e.id);
          const { gate, card } = await gateAndPropose({ exp: full, store, gh, guard, audit: { supUrl, supKey, fetchImpl } });
          e.gate = gate;
          if (card && !pendingApproval) {
            pendingApproval = { token: card.token, expiresAt: card.expiresAt };
            notes.push(`\n**Approval needed** for ${e.id.slice(0, 8)}:\n${card.evidence}`);
          }
        }
      }
      return { reply: rows.length ? ['### [ LAB ]', ...rows.map(statusLine), ...notes].join('\n') : 'No lab experiments yet. Start one with /lab start <goal>.', ...(pendingApproval ? { pendingApproval } : {}) };
    }
    const e = cmd.id ? await store.get(cmd.id) : null;
    if (!e) return { reply: `There is no lab experiment ${cmd.id || '(no id)'}. /lab status lists them.` };
    if (cmd.sub === 'stop') {
      if (!ACTIVE_LAB_STATUSES.includes(e.status)) return { reply: `Experiment ${e.id.slice(0, 8)} is already ${e.status}.` };
      const run = e.run_id ? { id: e.run_id } : await gh.findRun(e.id);
      if (run) await gh.cancel(run.id);
      await store.update(e.id, { status: 'stopped' });
      return { reply: `Experiment ${e.id.slice(0, 8)} stopped${run ? '' : ' (its run had not started)'}.` };
    }
    if (cmd.sub === 'report') {
      const r = e.result || {};
      return { reply: [`### [ LAB ${e.id.slice(0, 8)} · ${e.kind} · ${e.status} ]`, `Goal: ${e.goal}`, `Spent $${usd(e.spent_usd)} of $${usd(e.budget_usd)}${r.calls != null ? ` over ${r.calls} model calls` : ''}.`, '', r.report_markdown || (e.error ? `Error: ${e.error}` : 'No report yet.'), ...(e.gate ? ['', '#### Gate', gateEvidenceText(e.gate)] : [])].join('\n') };
    }
    return { reply: LAB_HELP_TEXT };
  } catch (err) {
    return { reply: 'The lab could not be reached right now.' };
  }
}

// The operator's decision on a LAB_PROMOTE card.
export async function handleLabApproval({ row, decision, supUrl, supKey, fetchImpl = globalThis.fetch, guard = null, isOperator = false }) {
  if (isOperator !== true) return { reply: 'Only the signed-in operator can approve lab results.' };
  const plan = row && row.plan && typeof row.plan === 'object' ? row.plan : {};
  const store = createLabStore({ supUrl, supKey, fetchImpl });
  const exp = await store.get(plan.experiment_id);
  if (!exp) return { reply: 'That experiment no longer exists.', resolution: 'declined' };
  const c = exp.candidate || plan.candidate;
  if (decision !== 'approve') {
    await store.update(exp.id, { promoted_stage: 'declined' });
    if (c && c.type === 'skill') await createSkillStore({ supUrl, supKey, fetchImpl, guard }).setStatus(c.skill.name, 'disabled').catch(() => {});
    return { reply: `Declined: lab experiment ${exp.id.slice(0, 8)} will not be used.`, resolution: 'declined' };
  }
  // Re-check the gate's own result before acting on it.
  if (!exp.gate || !exp.gate.pass) return { reply: 'This candidate has not passed the gate; nothing was changed.', resolution: 'declined' };
  const flags = createFlagStore({ supUrl, supKey, fetchImpl });
  if (c.type === 'skill') {
    await createSkillStore({ supUrl, supKey, fetchImpl, guard }).setStatus(c.skill.name, 'active');
    await flags.upsert({ key: `skill:${c.skill.name}`.slice(0, 64), kind: 'skill', stage: 'operator', experiment_id: exp.id, thresholds: {} });
    await store.update(exp.id, { promoted_stage: 'operator' });
    await logAutonomy({ supUrl, supKey, fetchImpl }, { action: 'flag:operator_rollout', actor: 'operator', decision: 'allowed', detail: `skill:${c.skill.name}` });
    return { reply: `Approved: skill ${c.skill.name} is active (operator only, flag skill:${c.skill.name}).`, resolution: 'approved' };
  }
  await flags.upsert({ key: `code:${c.pr_number}`, kind: 'code', stage: 'operator', experiment_id: exp.id, thresholds: {} });
  await store.update(exp.id, { promoted_stage: 'operator' });
  await logAutonomy({ supUrl, supKey, fetchImpl }, { action: 'flag:operator_rollout', actor: 'operator', decision: 'allowed', detail: `code:${c.pr_number}` });
  return { reply: `Approved for merge. PG1 never merges: review and merge ${c.pr_url} yourself; it runs for the operator only behind flag code:${c.pr_number} until /promote code:${c.pr_number}.`, resolution: 'approved' };
}

export { FLAG_STAGES };
