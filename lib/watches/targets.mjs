// What PG1 can watch, and how each kind of target's states read.
//
//   lab           a lab experiment: its uuid. queued, running → done,
//                 failed, over_budget, timeout, stopped
//   pr            a pull request: "owner/repo#123". open, ci_pending →
//                 ci_success | ci_failure → merged | closed
//   workflow_run  a GitHub Actions run: "owner/repo@123456". queued,
//                 in_progress → success, failure, cancelled, timed_out, ...
//   deploy        a deployment: its id ("dpl_..."). building → ready,
//                 error, canceled
//
// report_on: 'finish' reports only the end state; 'changes' reports every
// state change (a PR's CI result, then its merge). Pure.

export const TARGET_TYPES = Object.freeze(['lab', 'pr', 'workflow_run', 'deploy']);
export const WATCH_STATUSES = Object.freeze(['open', 'done', 'stopped', 'expired']);

const HOUR = 3600 * 1000;
export const WATCH_TTL_MS = Object.freeze({ lab: 48 * HOUR, pr: 14 * 24 * HOUR, workflow_run: 24 * HOUR, deploy: 24 * HOUR });
export const DEFAULT_REPORT_ON = Object.freeze({ lab: 'finish', pr: 'changes', workflow_run: 'finish', deploy: 'finish' });

const REPO = '[A-Za-z0-9_.-]{1,100}\\/[A-Za-z0-9_.-]{1,100}';
const ID_RE = {
  lab: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  pr: new RegExp(`^${REPO}#\\d{1,9}$`),
  workflow_run: new RegExp(`^${REPO}@\\d{1,15}$`),
  deploy: /^dpl_[A-Za-z0-9]{6,64}$/
};

export function validTarget(type, id) {
  return TARGET_TYPES.includes(type) && typeof id === 'string' && ID_RE[type].test(id);
}

export const prTarget = (repo, number) => `${repo}#${Number(number)}`;
export const runTarget = (repo, runId) => `${repo}@${Number(runId)}`;
export function parsePrTarget(id) {
  const m = /^(.+)#(\d+)$/.exec(String(id || ''));
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}
export function parseRunTarget(id) {
  const m = /^(.+)@(\d+)$/.exec(String(id || ''));
  return m ? { repo: m[1], runId: Number(m[2]) } : null;
}

const TERMINAL = {
  lab: (s) => !['queued', 'running'].includes(s),
  pr: (s) => ['merged', 'closed'].includes(s),
  workflow_run: (s) => !['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(s),
  deploy: (s) => ['ready', 'error', 'canceled'].includes(s)
};

export function isTerminal(type, state) {
  return !!state && !!TERMINAL[type] && TERMINAL[type](String(state));
}

// Whether moving from `prev` to `next` is worth a report for this watch.
export function isReportable(watch, next) {
  if (!next || next === watch.last_state) return false;
  if (isTerminal(watch.target_type, next)) return true;
  if (watch.report_on !== 'changes') return false;
  // A PR's interesting changes: CI finished. "open" and "ci_pending" are
  // just bookkeeping.
  if (watch.target_type === 'pr') return ['ci_success', 'ci_failure'].includes(next);
  return false;
}

// A short name for a target, for lists and notifications. Never a key.
export function targetLabel(type, id, extra = '') {
  const tail = extra ? ` ${String(extra).replace(/\s+/g, ' ').trim().slice(0, 60)}` : '';
  if (type === 'lab') return `Lab experiment ${String(id).slice(0, 8)}${tail}`;
  if (type === 'pr') return `PR ${id}${tail}`;
  if (type === 'workflow_run') { const r = parseRunTarget(id); return `Workflow run ${r ? r.runId : id}${tail}`; }
  if (type === 'deploy') return `Deploy ${String(id).slice(0, 14)}${tail}`;
  return String(id);
}
