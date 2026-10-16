// The lab card under /lab status and /lab report (and, built the same way
// on the page, under a lab watch report): the mascot's pose, the budget
// beaker and the stage track, all read from the experiment's row. Pure.
//
//   labCardView(exp) → { id, id8, kind, goal, status, pose, spent_usd,
//                        budget_usd, fill, high, stage, stages }
//
// pose: the mascot's state animation (queued | running | done | failed |
// over_budget | stopped). A timeout is "failed" (the run ended without a
// result); a stopped experiment gets the still pose, nothing happened.
//
// stage: where the experiment really is on research -> build -> test ->
// gate, from what the row records (the workflow does not report its jobs):
//   research  queued or running (the experiment job researches and drafts),
//             or finished without a candidate (research ends there)
//   build     finished with a candidate (a skill draft or a draft PR), the
//             gate not run yet
//   test      the gate is waiting on CI
//   gate      the gate ran (passed or failed)
// Each stage is done | current | todo | skipped; a research experiment
// that finished without a candidate (every research one, or a run that
// failed before building) skips build, test and gate.

export const LAB_STAGES = Object.freeze(['research', 'build', 'test', 'gate']);
const POSES = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', timeout: 'failed', over_budget: 'over_budget', stopped: 'stopped' };

const money = (n) => Math.max(0, Math.round((Number(n) || 0) * 100) / 100);

export function labStage(exp) {
  const e = exp || {};
  if (e.gate && !e.gate.pending && Array.isArray(e.gate.checks)) return 'gate';
  if (e.gate && e.gate.pending) return 'test';
  if (e.candidate) return 'build';
  return 'research';
}

export function labCardView(exp) {
  const e = exp || {};
  const status = POSES[e.status] ? e.status : 'queued';
  const spent = money(e.spent_usd);
  const budget = money(e.budget_usd);
  const fill = budget > 0 ? Math.min(1, spent / budget) : 0;
  const stage = labStage(e);
  const at = LAB_STAGES.indexOf(stage);
  const finished = !['queued', 'running'].includes(status);
  const researchOnly = finished && !e.candidate;
  const stages = LAB_STAGES.map((name, i) => {
    if (researchOnly && i > 0) return { name, state: 'skipped' };
    if (i < at) return { name, state: 'done' };
    if (i > at) return { name, state: 'todo' };
    // The stage reached: still going, or where it ended.
    if (stage === 'gate') return { name, state: e.gate.pass ? 'done' : 'failed' };
    if (!finished || stage === 'test') return { name, state: 'current' };
    return { name, state: status === 'done' ? 'done' : 'failed' };
  });
  return {
    id: String(e.id || ''),
    id8: String(e.id || '').slice(0, 8),
    kind: String(e.kind || 'research'),
    goal: String(e.goal || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    status,
    pose: POSES[status],
    spent_usd: spent,
    budget_usd: budget,
    fill: Math.round(fill * 1000) / 1000,
    high: fill >= 0.9,
    stage,
    stages
  };
}
