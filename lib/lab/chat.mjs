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
//   /lab report [id]      the findings report and the gate's evidence; the
//                         latest experiment when no id is given. An
//                         unfinished one is synced with its run first.
//   /promote <key>        a flag from operator-only to public (the second
//                         rollout step); /promote alone lists the flags
//
// Approving the card (LAB_PROMOTE) turns the candidate on for the operator
// only: a skill becomes active, a code change is marked approved for the
// operator to merge (PG1 never merges), and a flag is created at stage
// "operator". Declining discards it.

import crypto from 'node:crypto';
import { LAB_KINDS, labBudgetUsd, labDailyUsd, classifyLabKind, labPaidOff, LAB_PAID_OFF_REASON } from './policy.mjs';
import { signLabToken } from './token.mjs';
import { createLabGithub } from './github.mjs';
import { createLabStore, ACTIVE_LAB_STATUSES } from './store.mjs';
import { evaluateGate, gateEvidenceText } from './gate.mjs';
import { labCardView, labRequiredStages, labStatusLabel, labFailure } from './card.mjs';
import { createSkillStore } from '../skills/store.mjs';
import { createFlagStore, FLAG_STAGES } from '../flags.mjs';
import { authorize, autonomyMode, logAutonomy } from '../autonomy.mjs';
import { autoWatch } from '../watches/auto.mjs';
import { createCoreState } from '../core/state.mjs';
import { beforeActing } from '../core/self.mjs';

// What PG1 says about how its lab works (the chat's [CAPABILITIES]).
export const LAB_ARCHITECTURE_TEXT = 'How the lab really works: /lab start records the experiment in Supabase (pg1_lab_experiments) and dispatches the GitHub Actions workflow lab.yml. The runner on GitHub never touches Supabase or this server: it writes its result to a GitHub Actions artifact (lab-result-<id>). This server (Vercel) then pulls that artifact from GitHub with its GitHub token and stores the result in Supabase, when /lab status or /lab report runs and once an hour from the monitor cron. A finished run ends as done, or as failed with the reason (for example an unreadable or missing artifact). If asked about any other detail of the lab, say you are not sure rather than guessing.';

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
    const opts = { kind: '', urls: [], skill: '', kindNote: '' };
    rest = rest.replace(/--kind\s+(\S+)/i, (x, k) => { opts.kind = k.toLowerCase(); return ''; });
    rest = rest.replace(/--skill\s+(\S+)/i, (x, k) => { opts.skill = k.toLowerCase(); opts.kind = 'skill'; return ''; });
    rest = rest.replace(/--url\s+(\S+)/gi, (x, u) => { opts.urls.push(u); return ''; });
    const goal = rest.replace(/\s+/g, ' ').trim().slice(0, 1000);
    // The kind follows the goal's words when none is given. A goal that
    // implements, builds or prototypes code is a code experiment even when
    // --kind research was given: it must be built, tested and gated.
    const classed = classifyLabKind(goal);
    if (!opts.kind) opts.kind = classed;
    else if (opts.kind === 'research' && classed === 'code') { opts.kind = 'code'; opts.kindNote = 'Started as a code experiment: the goal builds code, so it goes through research, build, test and the gate.'; }
    return { sub, id: '', goal, opts };
  }
  if (['status', 'list'].includes(sub)) return { sub: 'status', id: '', goal: '', opts: {} };
  if (['stop', 'report'].includes(sub)) return { sub, id: (m[2].trim().split(/\s+/)[0] || '').toLowerCase(), goal: '', opts: {} };
  return { sub: 'help', id: '', goal: '', opts: {} };
}

export const LAB_HELP_TEXT = [
  '### [ LAB ]',
  '- **/lab start** <goal> [--kind research|skill|code] [--skill <name>] [--url <https url>]: one experiment on the lab runner (GitHub Actions, lab-only keys, no production data or payment keys)',
  '- **/lab status**: the latest experiments, each finished run read back from GitHub',
  '- **/lab report** [id]: one experiment\'s findings and cost (the latest when no id is given)',
  '- **/lab stop** <id>: cancels a queued or running experiment',
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

// The runner's verdict checked against the stages the kind requires. A
// result says "done" only for its own part; here every stage the runner and
// the workflow own must have passed: research with findings (a real
// answer, not an empty one), build with files or a skill draft, test with
// the lab's test run (code) or every eval (skill), and a draft PR for code.
// Returns { status, error, stages }: status "done" only when all of them
// passed; else "failed" with the first failed stage leading the error. A
// code or skill experiment that passed them all still has the gate ahead
// (gatePhase), so it stays "running" until the gate decides.
export function verdictFor(exp, result) {
  const r = result || {};
  const st = { ...(r.stages && typeof r.stages === 'object' ? r.stages : {}) };
  const req = labRequiredStages(exp.kind, exp.goal);
  if (req.includes('research') && !st.research) {
    const text = String(r.report_markdown || '').trim();
    const proposals = Array.isArray(r.proposals) ? r.proposals.length : 0;
    st.research = proposals ? { ok: true, proposals, inferred: true } : text.length >= 80 ? { ok: true, chars: text.length, sources: Array.isArray(r.sources) ? r.sources.length : 0, inferred: true } : { ok: false, reason: text ? `only ${text.length} characters of findings` : 'no findings: the research step returned an empty answer' };
  }
  if (exp.kind === 'code') {
    const c = r.code || null;
    if (!st.build) st.build = c && Array.isArray(c.files) && c.files.length ? { ok: true, files: c.files.length } : { ok: false, reason: 'no proposed change' };
    if (st.build.ok) {
      const t = c && c.tests;
      st.test = !t ? { ok: false, reason: 'no test result from the lab test run' } : !t.passed ? { ok: false, reason: 'the lab test run failed' } : c.pr_number ? { ok: true, pr_number: c.pr_number } : { ok: false, reason: `the tests passed but no draft PR was opened${c.pr_error ? ` (${String(c.pr_error).slice(0, 60)})` : ''}` };
    }
  }
  if (exp.kind === 'skill') {
    const drafted = Array.isArray(r.skill_drafts) && r.skill_drafts.length > 0;
    if (!st.build) st.build = drafted ? { ok: true } : { ok: false, reason: 'no skill draft' };
    if (st.build.ok && !st.test) {
      const ev = Array.isArray(r.evals) ? r.evals : [];
      const passed = ev.filter((e) => e && e.pass).length;
      st.test = { ok: ev.length > 0 && passed === ev.length, passed, total: ev.length, ...(ev.length ? {} : { reason: 'no eval results' }) };
    }
  }
  const known = ['done', 'failed', 'over_budget', 'timeout'].includes(r.status);
  if (!known) return { status: 'failed', error: `${req[0]}: the runner returned status "${String(r.status || 'none').slice(0, 40)}"`, stages: st };
  if (r.status !== 'done') return { status: r.status, error: r.error ? String(r.error).slice(0, 300) : `${req[0]}: the run ended as ${r.status}`, stages: st };
  const bad = req.find((name) => name !== 'gate' && (!st[name] || st[name].ok !== true));
  if (bad) {
    const why = st[bad] && st[bad].reason ? st[bad].reason : st[bad] && st[bad].total != null ? `${st[bad].passed} of ${st[bad].total} evals passed` : 'did not run';
    return { status: 'failed', error: `${bad}: ${String(why).slice(0, 280)}`, stages: st };
  }
  return { status: req.includes('gate') ? 'running' : 'done', error: null, stages: st };
}

async function ingest({ exp, result, store, gh, supUrl, supKey, fetchImpl, guard, now }) {
  result = cleanForStorage(result);
  const verdict = verdictFor(exp, result);
  const patch = { status: verdict.status, spent_usd: Math.max(0, Number(result.spent_usd) || 0), result: { ...result, stages: verdict.stages, ingested: true, report_markdown: String(result.report_markdown || '').slice(0, 60000) }, error: verdict.error };
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
  patch.candidate = verdict.status === 'failed' ? null : candidateFor(exp, result);
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
  // The record first, then the spend: a failed write leaves no ledger row
  // behind, so a retry never counts the same spend twice. If the full
  // result cannot be stored, the outcome and spend still are, with why.
  let row;
  try {
    row = await store.update(exp.id, patch);
  } catch (err) {
    console.error(`[lab] store_result_failed id=${exp.id.slice(0, 8)} status=${err.status || '-'} ${String(err.message || err).slice(0, 120)}`);
    // Without its candidate a code or skill experiment cannot reach the
    // gate: it ends failed rather than waiting forever.
    const shortStatus = patch.status === 'running' ? 'failed' : patch.status;
    const short = { status: shortStatus, spent_usd: patch.spent_usd, candidate: null, result: { status: shortStatus, spent_usd: patch.spent_usd, calls: result.calls, stages: verdict.stages, budget_stop: result.budget_stop || null, ingested: true, report_markdown: patch.result.report_markdown.slice(0, 8000) }, error: patch.error || (shortStatus !== patch.status ? `gate: the candidate could not be stored (lab storage ${err.status || 'error'})` : `the full result could not be stored (lab storage ${err.status || 'error'}); the report is cut to 8000 characters`) };
    try {
      row = await store.update(exp.id, short);
      patch.result = short.result;
    } catch (err2) {
      row = await store.update(exp.id, { status: 'failed', spent_usd: patch.spent_usd, candidate: null, error: `${labRequiredStages(exp.kind, exp.goal)[0]}: the result could not be stored (lab storage ${err2.status || 'error'})` });
      patch.result = null;
    }
  }
  await store.recordSpend({ experimentId: exp.id, spentUsd: patch.spent_usd, day: utcDay(now) }).catch(() => {});
  await logAutonomy({ supUrl, supKey, fetchImpl }, { action: 'lab:ingest', actor: 'lab', decision: 'allowed', costUsd: patch.spent_usd, outcome: row && row.status || patch.status, detail: `experiment ${exp.id.slice(0, 8)} ${exp.kind}` });
  console.log(`[lab] ingested id=${exp.id.slice(0, 8)} status=${row && row.status || patch.status} spent_usd=${patch.spent_usd}`);
  return { ...row, result: patch.result };
}

// JSON that Postgres jsonb accepts: no NUL characters, no lone surrogates.
export function cleanForStorage(value) {
  if (typeof value === 'string') return value.replace(/\u0000/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
  if (Array.isArray(value)) return value.map(cleanForStorage);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [cleanForStorage(k), cleanForStorage(v)]));
  return value;
}

// Runs the gate on a finished experiment's candidate; when it passes and
// no card exists yet, creates the approval card. Returns { gate, card }.
async function gateAndPropose({ exp, store, gh, guard, audit = {} }) {
  const candidate = exp.candidate;
  if (!candidate || exp.approval_token || exp.promoted_stage !== 'none') return { gate: exp.gate || null, card: null };
  const ci = candidate.type === 'code' && gh.configured ? await gh.prChecks(candidate.pr_number) : null;
  // CI still running, or not started yet (a draft PR opened with the
  // built-in token starts no workflow): the gate waits, it does not fail.
  if (ci && (ci.state === 'pending' || ci.state === 'none')) return { gate: { pass: false, pending: true, checks: [{ name: 'evals', ok: false, evidence: ci.state === 'pending' ? 'CI still running' : 'CI has not started on the draft PR: close and reopen it, or push a commit to its branch, yourself' }] }, card: null };
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

// /lab status shows this many experiments, each as one card.
export const LAB_STATUS_CARDS = 6;

// The words above the cards (and what Read aloud says): how many of each
// status. The cards carry the rest, so no list repeats them.
export function statusSummary(rows) {
  const counts = new Map();
  for (const e of rows) {
    const w = labStatusLabel(e);
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const parts = [...counts].map(([w, n]) => `${n} ${w}`);
  // A stopped run says where and why (in words, for Read aloud; each card
  // shows it too), so a failure is never only a red dot.
  const stopped = rows.map((e) => ({ e, f: labFailure(e) })).filter((x) => x.f).map(({ e, f }) => `${String(e.id || '').slice(0, 8)} ${labStatusLabel(e)} at **${f.stage}** (${f.message})`);
  return `**Lab**: the latest ${rows.length === 1 ? 'experiment' : `${rows.length} experiments`}: ${parts.join(', ')}. Each card has its report button.${stopped.length ? ` Stopped: ${stopped.join('; ')}.` : ''}`;
}

// Starts one experiment: the kill switch, the lab's setup, the daily budget
// (spent today on the ledger plus every queued or running experiment's
// budget), the record, the signed dispatch, the audit log. Used by /lab
// start, the weekly opportunity scan and /opportunities approve.
// Resolves to { ok, id?, reply }. Never throws.
// Every start is watched (lib/watches): its report goes to originThread
// (the chat thread that started it; none for the weekly scan) when it
// finishes, unless PG1_AUTONOMY=off.
export async function startLabExperiment({ env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, kind, goal, input = {}, action = 'lab:dispatch', originThread = null, now = Date.now() }) {
  const audit = { supUrl, supKey, fetchImpl };
  try {
    const allowed = authorize(action, { actor: 'pg1', mode: autonomyMode(env) });
    if (!allowed.allowed) {
      await logAutonomy(audit, { action, decision: allowed.decision, mode: autonomyMode(env), detail: allowed.reason });
      return { ok: false, reply: `Not started: ${allowed.reason}. Set PG1_AUTONOMY=lab or on to use the lab.` };
    }
    if (!LAB_KINDS.includes(kind)) return { ok: false, reply: `Kind must be ${LAB_KINDS.join(', ')}.` };
    // PG1's self-model before acting (lib/core/self.mjs).
    const gate = await beforeActing('lab', { env, store: createCoreState() });
    if (gate) return { ok: false, reply: gate.refused };
    if (labPaidOff(env)) {
      await logAutonomy(audit, { action, decision: 'denied', mode: autonomyMode(env), detail: 'daily spend cap $0' });
      return { ok: false, reply: `Not started: ${LAB_PAID_OFF_REASON}. Set PG1_DAILY_SPEND_CAP_USD above $0 to use the lab.` };
    }
    const store = createLabStore({ supUrl, supKey, fetchImpl });
    const gh = createLabGithub({ env, fetchImpl });
    const secret = String(env.PG1_LAB_DISPATCH_SECRET || '').trim();
    if (!secret || !gh.configured) return { ok: false, reply: 'The lab is not set up on this deployment (PG1_LAB_DISPATCH_SECRET and a GitHub token with Actions access are needed). Nothing was started.' };
    const budget = labBudgetUsd(env);
    const daily = labDailyUsd(env);
    const spent = await store.spentToday(utcDay(now));
    // A running experiment that already has its candidate only waits on the
    // gate: its spend is on the ledger, so it reserves nothing more.
    const reserved = (await store.active()).reduce((n, r) => n + (r.candidate ? 0 : Number(r.budget_usd) || 0), 0);
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
    const watched = await autoWatch({ env, supUrl, supKey, fetchImpl, type: 'lab', id, label: `Lab experiment ${id.slice(0, 8)}: ${g.slice(0, 60)}`, originThread, lastState: 'queued', now });
    const watchLine = watched.ok ? ' I will post a report here when it finishes.' : '';
    return { ok: true, id, watched: !!watched.ok, reply: `Lab experiment ${id.slice(0, 8)} queued (${kind}, budget $${usd(budget)}; today: $${usd(spent)} spent, $${usd(reserved + budget)} reserved of $${usd(daily)}). Check it with /lab status.${watchLine}` };
  } catch (e) {
    return { ok: false, reply: 'The lab could not be reached right now.' };
  }
}

// Foundry builds (lib/foundry) are lab code experiments whose goal starts
// with this marker.
export const FOUNDRY_GOAL_PREFIX = '[foundry]';
export const isFoundryGoal = (goal) => String(goal || '').startsWith(FOUNDRY_GOAL_PREFIX);

// How long a finished run's result may stay unreadable for a transient
// reason (GitHub 5xx, network) before the experiment is marked failed.
export const LAB_RESULT_GRACE_MS = 30 * 60 * 1000;

// Brings one queued or running experiment up to date with its runner:
// records the run id, and when the run has finished, ends the experiment
// as done (or the runner's own failed / over_budget / timeout) with its
// result, or as failed with the reason. A finished run never stays
// "running": only a transient read failure inside LAB_RESULT_GRACE_MS of
// the run's end waits for the next sync, with the reason in `error`.
// Mutates and returns e; null when no run was found yet.
export async function syncLabExperiment(e, { store, gh, supUrl, supKey, fetchImpl = globalThis.fetch, guard = null, now = Date.now() }) {
  // Already ingested (it has a candidate) and still running: only the gate
  // is left.
  if (e.status === 'running' && e.candidate) return gatePhase(e, { store, gh, supUrl, supKey, fetchImpl, guard, now });
  const run = e.run_id ? await gh.getRun(e.run_id) : await gh.findRun(e.id);
  if (!run) return null;
  if (!e.run_id || e.status === 'queued') {
    await store.update(e.id, { run_id: run.id, status: 'running' });
    e.run_id = run.id;
  }
  e.status = 'running';
  if (run.status !== 'completed') return e;
  const end = (patch) => store.update(e.id, patch).then((row) => Object.assign(e, row || patch));
  if (run.conclusion === 'cancelled') {
    await end({ status: 'stopped', error: 'the run was cancelled' });
    return e;
  }
  let read;
  try {
    read = gh.readResult ? await gh.readResult(run.id, e.id) : { ok: false, reason: 'no result reader' };
  } catch (err) {
    read = { ok: false, reason: `the result could not be read (${String(err && err.message || err).slice(0, 120)})`, transient: true };
  }
  if (read.ok) {
    Object.assign(e, await ingest({ exp: { ...e }, result: read.result, store, gh, supUrl, supKey, fetchImpl, guard, now }));
    if (e.status === 'running' && e.candidate) return gatePhase(e, { store, gh, supUrl, supKey, fetchImpl, guard, now });
    return e;
  }
  const endedAt = Date.parse(run.updated_at || run.run_started_at || '') || 0;
  const conclusion = run.conclusion && run.conclusion !== 'success' ? ` (the run's conclusion: ${run.conclusion})` : '';
  const reason = `no result from the runner: ${read.reason}${conclusion}`.slice(0, 300);
  console.error(`[lab] result_unreadable id=${e.id.slice(0, 8)} run=${run.id} transient=${!!read.transient} ${reason}`);
  if (read.transient && endedAt && now - endedAt < LAB_RESULT_GRACE_MS) {
    await store.update(e.id, { error: `waiting to read the result: ${read.reason}`.slice(0, 300) });
    e.error = `waiting to read the result: ${read.reason}`;
    return e;
  }
  await end({ status: 'failed', error: reason });
  return e;
}

// How long the gate may wait on CI that never reports before the
// experiment is marked failed.
export const LAB_GATE_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

// The last required stage of a code or skill experiment: the promotion
// gate. Passed: "done", with the operator's approval card (e.card). Failed:
// "failed", the failed checks in the error. Waiting on CI: stays "running"
// (until LAB_GATE_WAIT_MS). Mutates and returns e.
async function gatePhase(e, { store, gh, guard = null, supUrl, supKey, fetchImpl, now = Date.now() }) {
  const full = (await store.get(e.id)) || e;
  if (!full.candidate) return e;
  const { gate, card } = await gateAndPropose({ exp: full, store, gh, guard, audit: { supUrl, supKey, fetchImpl } });
  if (!gate) return Object.assign(e, full);
  e.gate = gate;
  if (gate.pending) {
    const age = now - (Date.parse(full.created_at || '') || now);
    if (age > LAB_GATE_WAIT_MS) Object.assign(e, await store.update(e.id, { status: 'failed', gate, error: 'gate: CI never reported on the draft PR within 7 days' }));
    return e;
  }
  if (gate.pass) {
    Object.assign(e, await store.update(e.id, { status: 'done', error: null }));
    if (card) e.card = card;
    return e;
  }
  const failedChecks = (gate.checks || []).filter((c) => !c.ok).map((c) => `${c.name} (${String(c.evidence || '').slice(0, 80)})`).join('; ');
  Object.assign(e, await store.update(e.id, { status: 'failed', error: `gate: ${failedChecks || 'did not pass'}`.slice(0, 300) }));
  return e;
}

// Syncs every queued or running experiment (the hourly monitor, so a
// finished run is closed even when nobody runs /lab status). One
// experiment's failure never stops the others. Resolves to
// [{ id, status, error }]. Never throws.
export async function syncActiveLabExperiments({ env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const out = [];
  try {
    const store = createLabStore({ supUrl, supKey, fetchImpl });
    const gh = createLabGithub({ env, fetchImpl });
    if (!gh.configured) return out;
    for (const row of await store.active()) {
      const e = await store.get(row.id).catch(() => null);
      if (!e) continue;
      try {
        await syncLabExperiment(e, { store, gh, supUrl, supKey, fetchImpl, now });
        out.push({ id: e.id, status: e.status, error: e.error || null });
      } catch (err) {
        console.error(`[lab] sync_failed id=${e.id.slice(0, 8)} ${String(err && err.message || err).slice(0, 160)}`);
        out.push({ id: e.id, status: e.status, error: 'sync failed' });
      }
    }
  } catch (err) {
    console.error(`[lab] sync_all_failed ${String(err && err.message || err).slice(0, 160)}`);
  }
  return out;
}

// /lab report: what each required stage really did, from the stored result.
export function stagesLines(e) {
  const st = (e.result && e.result.stages) || null;
  if (!st) return [];
  const say = (name, x) => {
    if (!x) return null;
    if (x.ok === false) return `- ${name}: failed, ${x.reason || 'did not pass'}`;
    if (name === 'research') return `- research: passed, ${x.chars || 0} characters of findings, ${x.sources || 0} sources${x.calls != null ? `, ${x.calls} model call${x.calls === 1 ? '' : 's'}` : ''}`;
    if (name === 'build') return `- build: passed${x.files ? `, ${x.files} file${x.files === 1 ? '' : 's'}` : x.skill ? `, skill ${x.skill}` : ''}`;
    if (name === 'test') return `- test: passed${x.total != null ? `, ${x.passed} of ${x.total} evals` : x.pr_number ? `, draft PR #${x.pr_number}` : ''}`;
    return `- ${name}: passed`;
  };
  const lines = labRequiredStages(e.kind, e.goal).filter((n) => n !== 'gate').map((n) => say(n, st[n]) || `- ${n}: not reached`);
  return ['', '#### Stages', ...lines];
}

// Resolves to { reply, pendingApproval? }. Never throws.
export async function handleLabCommand({ text, env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, isOperator = false, guard = null, threadKey = null, now = Date.now() }) {
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
      const started = await startLabExperiment({ env, supUrl, supKey, fetchImpl, kind: cmd.opts.kind, goal: cmd.goal, input, originThread: threadKey, now });
      return { reply: started.ok && cmd.opts.kindNote ? `${started.reply} ${cmd.opts.kindNote}` : started.reply };
    }
    if (cmd.sub === 'status') {
      const rows = await store.list(LAB_STATUS_CARDS);
      let pendingApproval = null;
      const notes = [];
      for (const e of rows) {
        if (!gh.configured) break;
        if (ACTIVE_LAB_STATUSES.includes(e.status)) {
          let synced = null;
          try {
            synced = await syncLabExperiment(e, { store, gh, supUrl, supKey, fetchImpl, guard, now });
          } catch (err) {
            console.error(`[lab] sync_failed id=${e.id.slice(0, 8)} ${String(err && err.message || err).slice(0, 160)}`);
            notes.push(`\n${e.id.slice(0, 8)} could not be synced right now; /lab report ${e.id.slice(0, 8)} retries.`);
          }
          if (!synced) continue;
        }
        // Foundry builds are approved through /foundry approve, not a lab card.
        if (isFoundryGoal(e.goal)) continue;
        // A row finished before the gate was a stage of its own ("done"
        // with a candidate, never gated): the gate decides it now.
        if (e.status === 'done' && e.candidate && !e.gate && !e.approval_token && (!e.promoted_stage || e.promoted_stage === 'none')) {
          await gatePhase(e, { store, gh, supUrl, supKey, fetchImpl, guard, now });
        } else if (e.status === 'done' && e.gate && !e.gate.pending && Array.isArray(e.gate.checks) && !e.gate.pass) {
          // An older row marked done although its gate failed.
          const failedChecks = e.gate.checks.filter((c) => !c.ok).map((c) => c.name).join(', ');
          Object.assign(e, await store.update(e.id, { status: 'failed', error: `gate: ${failedChecks || 'did not pass'}` }));
        }
        if (e.card && !pendingApproval) {
          pendingApproval = { token: e.card.token, expiresAt: e.card.expiresAt };
          notes.push(`\n**Approval needed** for ${e.id.slice(0, 8)}:\n${e.card.evidence}`);
        } else if (!pendingApproval && e.status === 'done' && e.approval_token && (!e.promoted_stage || e.promoted_stage === 'none')) {
          // A card the hourly sync created: still waiting for the operator.
          const waiting = await store.pendingAction(e.approval_token).catch(() => null);
          if (waiting && waiting.status === 'pending' && Date.parse(waiting.expires_at) > now) {
            pendingApproval = { token: waiting.token, expiresAt: waiting.expires_at };
            notes.push(`\n**Approval needed** for ${e.id.slice(0, 8)}:\n${waiting.diff_summary || ''}`);
          }
        }
      }
      // One card per experiment (mascot, budget beaker, stage track and its
      // own Report and Stop buttons); the words only summarise them.
      const seen = new Set();
      const unique = rows.filter((e) => !seen.has(e.id) && seen.add(e.id));
      return { reply: unique.length ? [statusSummary(unique), ...notes].join('\n') : 'No lab experiments yet. Start one with /lab start <goal>.', ...(unique.length ? { labCards: unique.map((e) => labCardView(e, { actions: true })) } : {}), ...(pendingApproval ? { pendingApproval } : {}) };
    }
    if (cmd.sub === 'stop' && !cmd.id) return { reply: 'Say which experiment to stop: /lab stop <id>. /lab status lists the ids.' };
    // /lab report with no id: the latest experiment.
    const latest = cmd.id ? null : (await store.list(1))[0];
    let e = cmd.id ? await store.get(cmd.id) : latest ? await store.get(latest.id) : null;
    if (!e) return { reply: cmd.id ? `There is no lab experiment ${cmd.id}. /lab status lists them.` : 'No lab experiments yet. Start one with /lab start <goal>.' };
    if (cmd.sub === 'stop') {
      if (!ACTIVE_LAB_STATUSES.includes(e.status)) return { reply: `Experiment ${e.id.slice(0, 8)} is already ${e.status}.` };
      const run = e.run_id ? { id: e.run_id } : await gh.findRun(e.id);
      if (run) await gh.cancel(run.id);
      await store.update(e.id, { status: 'stopped' });
      return { reply: `Experiment ${e.id.slice(0, 8)} stopped${run ? '' : ' (its run had not started)'}.` };
    }
    if (cmd.sub === 'report') {
      if (ACTIVE_LAB_STATUSES.includes(e.status) && gh.configured) {
        try {
          if (await syncLabExperiment(e, { store, gh, supUrl, supKey, fetchImpl, guard, now })) e = (await store.get(e.id)) || e;
        } catch (err) {
          console.error(`[lab] sync_failed id=${e.id.slice(0, 8)} ${String(err && err.message || err).slice(0, 160)}`);
        }
      }
      const r = e.result || {};
      const word = labStatusLabel(e).replace(/ /g, '_');
      const stop = e.status === 'over_budget' && r.budget_stop && Number.isFinite(Number(r.budget_stop.threshold_usd)) && word === 'near_budget' ? ` Stopped at its stop threshold of $${usd(r.budget_stop.threshold_usd)}: the next call could have cost up to $${usd(r.budget_stop.next_call_worst_usd)}.` : '';
      return { reply: [`### [ LAB ${e.id.slice(0, 8)} · ${e.kind} · ${word} ]`, `Goal: ${e.goal}`, `Spent $${usd(e.spent_usd)} of $${usd(e.budget_usd)}${r.calls != null ? ` over ${r.calls} model calls` : ''}.${stop}`, ...stagesLines(e), '', r.report_markdown ? (e.error ? `${r.report_markdown}\n\nNote: ${e.error}` : r.report_markdown) : e.error ? `${ACTIVE_LAB_STATUSES.includes(e.status) ? 'Not finished' : 'Failed'}: ${e.error}` : ACTIVE_LAB_STATUSES.includes(e.status) ? `No report yet: the run ${e.run_id ? `${e.run_id} has not finished` : 'has not started'} on GitHub.` : 'No report.', ...(e.gate ? ['', '#### Gate', gateEvidenceText(e.gate)] : [])].join('\n'), labCards: [labCardView(e)] };
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
