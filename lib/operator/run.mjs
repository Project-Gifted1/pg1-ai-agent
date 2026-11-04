// The operator loop's entry points:
//
//   runReport('daily' | 'weekly')  the scheduled reports (crons): gather,
//                                  turn findings into tasks and act on
//                                  them, then store, PDF and push the report
//   operatorTick                   every Autonomous mode tick (switch ON):
//                                  expire old approvals, follow lab work to
//                                  its PR, auto-merge what qualifies, send
//                                  the rest for approval
//   operatorWatch                  every tick, switch ON or OFF: watch
//                                  PG1's own merges in production and roll
//                                  back a failed or degraded deploy (a
//                                  safety action: it only undoes PG1's own
//                                  change)
//
// PG1_AUTONOMY=off or the Autonomous switch OFF stops the reports, the
// tasks and the merges (lib/autonomy.mjs: report:*, task:act and
// code:merge_low_risk are toggle actions).

import { authorize, autonomyMode, logAutonomy } from '../autonomy.mjs';
import { createAutonomousStore, refreshAutonomousSnapshot } from '../autonomous/state.mjs';
import { createOperatorStore } from './store.mjs';
import { gatherDaily, gatherWeekly, buildDailyReport, buildWeeklyReport, publishReport, waitingApprovals, attempt } from './reports.mjs';
import { dailyFindings, weeklyFindings, actOnFindings, expireApprovals, labGoalFor } from './tasks.mjs';
import { createOperatorGithub, tryAutoMerge, watchMerge, mergeTask } from './merge.mjs';

function defaultStartLab({ env, supUrl, supKey, fetchImpl }) {
  return async ({ kind, goal, input, action }) => {
    const { startLabExperiment } = await import('../lab/chat.mjs');
    return startLabExperiment({ env, supUrl, supKey, fetchImpl, kind, goal, input, action });
  };
}
function defaultPush({ env, supUrl, supKey, fetchImpl, webpushImpl = null }) {
  return async ({ title, body }) => {
    const { createWatchStore } = await import('../watches/store.mjs');
    const { pushToOperator } = await import('../watches/push.mjs');
    return pushToOperator({ store: createWatchStore({ supUrl, supKey, fetchImpl }), env, title, body, url: '/', tag: 'pg1-operator-report', webpushImpl });
  };
}

export async function runReport({ kind, env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), getStats, deps = {} }) {
  const audit = { supUrl, supKey, fetchImpl };
  if (!deps.skipSnapshot) await refreshAutonomousSnapshot({ supUrl, supKey, fetchImpl }).catch(() => false);
  const action = kind === 'weekly' ? 'report:weekly' : 'report:daily';
  const d = authorize(action, { actor: 'pg1', mode: autonomyMode(env) });
  if (!d.allowed) {
    await logAutonomy(audit, { action, decision: d.decision, mode: autonomyMode(env), detail: d.reason });
    return { ok: false, reason: d.reason };
  }
  const opStore = deps.opStore || createOperatorStore({ supUrl, supKey, fetchImpl, now: () => now });
  const autoStore = deps.autoStore === undefined ? createAutonomousStore({ supUrl, supKey, fetchImpl }) : deps.autoStore;
  const dayStart = `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;
  if (!deps.force) {
    const already = await opStore.reportSince(kind, dayStart).catch(() => null);
    if (already) return { ok: true, skipped: 'already sent today', id: already.id };
  }
  const data = kind === 'weekly'
    ? await gatherWeekly({ env, supUrl, supKey, fetchImpl, now, getStats, opStore, autoStore, labHistory: deps.labHistory, proposals: deps.proposals })
    : await gatherDaily({ env, supUrl, supKey, fetchImpl, now, getStats, opStore, autoStore });
  const findings = kind === 'weekly' ? weeklyFindings(data) : dailyFindings(data);
  const acted = await actOnFindings({ findings, opStore, env, audit, now, startLab: deps.startLab || defaultStartLab({ env, supUrl, supKey, fetchImpl }) });
  // The report shows the approvals as they stand after acting.
  const approvals = await attempt(() => waitingApprovals({ opStore, autoStore }), 'the approvals could not be read');
  data.approvals = approvals.ok ? { ok: true, list: approvals.value } : { ok: false, reason: approvals.reason };
  const built = kind === 'weekly' ? buildWeeklyReport(data) : buildDailyReport(data);
  const published = await publishReport({ built, data, opStore, env, supUrl, supKey, fetchImpl, push: deps.push || defaultPush({ env, supUrl, supKey, fetchImpl }), makePdf: deps.makePdf || null });
  await logAutonomy(audit, { action, decision: 'allowed', mode: autonomyMode(env), outcome: 'done', detail: `${findings.length} findings, ${acted.created} new tasks, pdf ${published.documentId ? 'saved' : 'not saved'}, pushed to ${published.pushed} device${published.pushed === 1 ? '' : 's'}` });
  return { ok: true, id: published.id, built, findings, acted, published };
}

// The deps a tick needs, built once.
function tickParts({ env, supUrl, supKey, fetchImpl, now, deps }) {
  return {
    audit: { supUrl, supKey, fetchImpl },
    opStore: deps.opStore || createOperatorStore({ supUrl, supKey, fetchImpl, now: () => now }),
    autoStore: deps.autoStore === undefined ? createAutonomousStore({ supUrl, supKey, fetchImpl }) : deps.autoStore,
    gh: deps.gh || createOperatorGithub({ env, fetchImpl }),
    labStore: deps.labStore || null
  };
}

async function labStoreFor({ supUrl, supKey, fetchImpl, deps }) {
  if (deps.labStore) return deps.labStore;
  const { createLabStore } = await import('../lab/store.mjs');
  return createLabStore({ supUrl, supKey, fetchImpl });
}

export async function operatorTick({ env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), notify = null, deps = {} }) {
  const p = tickParts({ env, supUrl, supKey, fetchImpl, now, deps });
  const done = { expired: [], advanced: 0, merged: 0, approvals: 0 };
  const gate = authorize('task:act', { actor: 'pg1', mode: autonomyMode(env) });
  if (!gate.allowed) return { ...done, refused: gate.reason };
  done.expired = await expireApprovals({ opStore: p.opStore, autoStore: p.autoStore, now, audit: p.audit, env });
  const labStore = await labStoreFor({ supUrl, supKey, fetchImpl, deps });
  // Lab work to its PR.
  for (const t of await p.opStore.listTasks({ statuses: ['lab_running'], limit: 20 })) {
    const e = t.experiment_id ? await labStore.get(t.experiment_id).catch(() => null) : null;
    if (!e) continue;
    const c = e.candidate;
    if (c && c.type === 'code' && c.pr_number) { await p.opStore.updateTask(t.id, { status: 'pr_open', pr_number: Number(c.pr_number), pr_url: c.pr_url || null }); done.advanced++; }
    else if (['failed', 'stopped', 'cancelled'].includes(e.status) || (e.status === 'done' && !c)) { await p.opStore.updateTask(t.id, { status: 'failed', detail: `lab experiment ${String(e.id).slice(0, 8)} ${e.status}${e.error ? `: ${e.error}` : ''}` }); done.advanced++; }
  }
  // Open PRs: fix/improve may auto-merge; everything else goes for approval.
  for (const t of await p.opStore.listTasks({ statuses: ['pr_open'], limit: 20 })) {
    if (t.kind === 'fix' || t.kind === 'improve') {
      const r = await tryAutoMerge({ task: t, gh: p.gh, labStore, opStore: p.opStore, env, fetchImpl, now, audit: p.audit });
      if (r.merged) { done.merged++; break; } // one at a time
      if (!r.waiting) done.approvals++;
    } else {
      await p.opStore.updateTask(t.id, { status: 'needs_approval', approval_requested_at: new Date(now).toISOString(), approval: { action: 'code:merge', approvable: true, reason: t.kind === 'new' ? `PG1 researched and prototyped this in the lab: ${t.pr_url || `PR #${t.pr_number}`}. New tools and methods are merged only with your approval.` : `Price change PR ${t.pr_url || `#${t.pr_number}`}: pricing code is never merged automatically.`, pr_url: t.pr_url } });
      await logAutonomy(p.audit, { action: 'code:merge', decision: 'needs_approval', mode: autonomyMode(env), detail: `PR #${t.pr_number}: ${t.title}` });
      done.approvals++;
    }
  }
  // An open task whose lab did not start: try again (one a tick).
  const retry = (await p.opStore.listTasks({ statuses: ['open'], limit: 5 })).find((t) => !t.experiment_id && ['fix', 'improve', 'new'].includes(t.kind));
  if (retry && deps.startLab !== null) {
    const g = labGoalFor(retry);
    const start = deps.startLab || defaultStartLab({ env, supUrl, supKey, fetchImpl });
    const r = await start({ kind: g.kind, goal: g.goal.slice(0, 1000), input: { operator_task_id: retry.id }, action: g.action }).catch(() => null);
    if (r && r.ok) await p.opStore.updateTask(retry.id, { status: 'lab_running', experiment_id: r.id });
  }
  return done;
}

// Rollback watch on PG1's merges. Runs whatever the switch says.
export async function operatorWatch({ env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), notify = null, deps = {} }) {
  let p;
  try { p = tickParts({ env, supUrl, supKey, fetchImpl, now, deps }); } catch (e) { return []; }
  const out = [];
  let watching = [];
  try { watching = await p.opStore.listTasks({ statuses: ['watching'], limit: 10 }); } catch (e) { return out; }
  for (const t of watching) {
    try { out.push({ id: t.id, ...(await watchMerge({ task: t, gh: p.gh, opStore: p.opStore, env, fetchImpl, now, notify, audit: p.audit })) }); } catch (e) { out.push({ id: t.id, status: 'error' }); }
  }
  return out;
}

// The merge an approval runs (code:merge, approved): same watch and rollback.
export function approvedMerger({ env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), deps = {} }) {
  const p = tickParts({ env, supUrl, supKey, fetchImpl, now, deps });
  return async (task) => {
    const pr = await p.gh.pr(task.pr_number);
    if (!pr || pr.state !== 'open') return { ok: false, reason: 'the PR is not open' };
    return mergeTask({ task, pr, gh: p.gh, opStore: p.opStore, env, fetchImpl, now, auto: false, audit: p.audit });
  };
}
