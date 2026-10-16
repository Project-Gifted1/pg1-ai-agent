// The lab card under /lab status and /lab report (and under a lab watch
// report, built here on the server and carried with the report): the
// mascot's pose, the budget beaker, the stage track and the card's own
// buttons, all read from the experiment's row. Pure.
//
//   labCardView(exp, { actions }) → { id, id8, kind, goal, status, label,
//       pose, spent_usd, budget_usd, threshold_usd, fill, high, stage,
//       stages, actions? }
//
// Required stages per kind (labRequiredStages): research → research only;
// skill → build, test (its evals), gate; code → research, build, test, gate
// (a Foundry build's gate is /foundry approve, so its lab track ends at
// test). A stage the kind does not use is "skipped"; a required stage is
// done | current | failed | todo, and always agrees with the status:
//   queued       every required stage todo, none current (nothing runs yet)
//   running      the stages before the current one done; the current one
//                is the first required stage until a candidate exists, then
//                test while the gate waits on CI, else gate
//   done         every required stage done ("done" is only ever set when
//                they all passed: lib/lab/chat.mjs)
//   failed, timeout, over_budget
//                the stage it stopped at failed (the error names it:
//                "build: ..."; else the gate's own result; else where the
//                row says it got to), the ones before done, the rest todo
//   stopped      the ones before done, the rest todo
//
// label: the status as words. "over budget" only when the spend really
// passed the budget; the runner stops BEFORE a call that could cross it, so
// a stop under the budget is "near budget" with the stop threshold.

export const LAB_STAGES = Object.freeze(['research', 'build', 'test', 'gate']);
const POSES = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', timeout: 'failed', over_budget: 'over_budget', stopped: 'stopped' };
export const FOUNDRY_PREFIX = '[foundry]';

const money = (n) => Math.max(0, Math.round((Number(n) || 0) * 100) / 100);

export function labRequiredStages(kind, goal = '') {
  if (kind === 'skill') return ['build', 'test', 'gate'];
  if (kind === 'code') return String(goal || '').startsWith(FOUNDRY_PREFIX) ? ['research', 'build', 'test'] : ['research', 'build', 'test', 'gate'];
  return ['research'];
}

// A goal cut to at most n characters on a word boundary, with an ellipsis.
export function clipWords(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.(\-–—]+$/, '')}…`;
}

const gateRan = (e) => !!(e.gate && !e.gate.pending && Array.isArray(e.gate.checks));

// Where the experiment is (or stopped) on its required stages.
export function labStage(exp) {
  const e = exp || {};
  const req = labRequiredStages(e.kind, e.goal);
  const named = /^(research|build|test|gate): /.exec(String(e.error || ''));
  if (named && req.includes(named[1]) && !['queued', 'running', 'done'].includes(e.status)) return named[1];
  if (e.status === 'done') return req[req.length - 1];
  if (gateRan(e) && req.includes('gate')) return 'gate';
  if (e.candidate) return req.includes('gate') && !(e.gate && e.gate.pending) && e.status !== 'running' ? 'gate' : req.includes('test') ? 'test' : req[req.length - 1];
  return req[0];
}

// The status as words (and the spend's stop line when it stopped short).
export function labStatusLabel(exp) {
  const e = exp || {};
  if (e.status !== 'over_budget') return String(e.status || 'queued').replace(/_/g, ' ');
  return money(e.spent_usd) > money(e.budget_usd) ? 'over budget' : 'near budget';
}

export function labCardView(exp, { actions = false } = {}) {
  const e = exp || {};
  const status = POSES[e.status] ? e.status : 'queued';
  const spent = money(e.spent_usd);
  const budget = money(e.budget_usd);
  const fill = budget > 0 ? Math.min(1, spent / budget) : 0;
  const req = labRequiredStages(e.kind, e.goal);
  const stage = labStage({ ...e, status });
  const at = req.indexOf(stage);
  const stages = LAB_STAGES.map((name) => {
    const i = req.indexOf(name);
    if (i < 0) return { name, state: 'skipped' };
    if (status === 'queued') return { name, state: 'todo' };
    if (status === 'done') return { name, state: 'done' };
    if (i < at) return { name, state: 'done' };
    if (i > at) return { name, state: 'todo' };
    if (status === 'running') return { name, state: 'current' };
    if (status === 'stopped') return { name, state: 'todo' };
    return { name, state: 'failed' };
  });
  const stop = e.budget_stop || (e.result && e.result.budget_stop) || null;
  const threshold = status === 'over_budget' && stop && Number.isFinite(Number(stop.threshold_usd)) ? money(stop.threshold_usd) : null;
  const id8 = String(e.id || '').slice(0, 8);
  const view = {
    id: String(e.id || ''),
    id8,
    kind: String(e.kind || 'research'),
    goal: clipWords(e.goal, 120),
    status,
    label: labStatusLabel({ ...e, status }),
    pose: POSES[status],
    spent_usd: spent,
    budget_usd: budget,
    threshold_usd: threshold,
    fill: Math.round(fill * 1000) / 1000,
    high: fill >= 0.9,
    stage: status === 'queued' ? null : stage,
    stages
  };
  // The card's own buttons (/lab status): every lab gets its report; a
  // queued or running one also gets Stop (asks for a second tap).
  if (actions && /^[0-9a-f]{8}$/.test(id8)) {
    view.actions = [{ label: `Lab report ${id8}`, command: `/lab report ${id8}` }];
    if (status === 'queued' || status === 'running') view.actions.push({ label: `Stop experiment ${id8}`, command: `/lab stop ${id8}`, confirm: true });
  }
  return view;
}
