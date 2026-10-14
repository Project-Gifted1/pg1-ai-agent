// The report PG1 writes when a watched thing changes state: what happened,
// the result, the cost, the next step, and buttons (real commands checked
// against lib/replyActions.mjs COMMANDS, or a link to the PR / run on
// GitHub). Built by code from the snapshot the event or the re-sync read,
// never by a model, so it says only what really happened. Pure.
//
//   composeReport(watch, snapshot) → { title, body, actions, push: { title, body } }
//
// snapshot: { state, info } where info depends on the target type:
//   lab           { exp }   the pg1_lab_experiments row
//   pr            { title, url, ci: { state, failing: [names] } }
//   workflow_run  { name, url, conclusion }
//   deploy        { target, project }

import { commandAction } from '../replyActions.mjs';
import { targetLabel, parsePrTarget, parseRunTarget } from './targets.mjs';
import { whiteLabel } from '../whiteLabel.mjs';

const usd = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const one = (v, n = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull\/\d+|actions\/runs\/\d+)(?:[/?#][\w\-/?=&#.]*)?$/;

export function linkAction(label, url) {
  return GITHUB_URL_RE.test(String(url || '')) ? { label: one(label, 40), url: String(url), kind: 'link' } : null;
}

// The first real sentence of a lab report: no headings, no list markers.
function firstLine(markdown) {
  for (const l of String(markdown || '').split('\n')) {
    if (/^\s*#/.test(l)) continue;
    const t = l.replace(/^[>*\-\s]+/, '').replace(/[*_`]/g, '').trim();
    if (t.length > 3) return one(t, 220);
  }
  return '';
}

function lab(watch, { state, info }) {
  const e = (info && info.exp) || {};
  const id8 = String(watch.target_id).slice(0, 8);
  const r = e.result || {};
  const prUrl = e.candidate && e.candidate.pr_url ? e.candidate.pr_url : r.code && r.code.pr_url;
  const what = { done: 'finished', failed: 'failed', over_budget: 'stopped at its budget', timeout: 'ran out of time', stopped: 'was stopped' }[state] || `is now ${state}`;
  const result = state === 'done'
    ? (firstLine(r.report_markdown) || 'a report is ready')
    : one(e.error || (state === 'over_budget' ? 'the run hit the signed budget' : 'no result'), 220);
  const next = state === 'done'
    ? (e.candidate && !isFoundry(e.goal) ? 'Read the report; if the candidate passes the gate, /lab status brings up the approval card.' : 'Read the report.')
    : state === 'stopped' ? 'Nothing more to do unless you start it again.' : 'Read the report for the reason, then start it again with /lab start if it is still worth doing.';
  const actions = [commandAction(`/lab report ${id8}`), linkAction('Open PR', prUrl), state === 'done' && e.candidate ? commandAction('/lab status') : null];
  return {
    title: `Lab experiment ${id8} ${what}`,
    lines: [
      `**What happened**: lab experiment ${id8} (${one(e.kind || 'lab', 20)}${e.goal ? `: ${one(e.goal, 80)}` : ''}) ${what}.`,
      `**Result**: ${state}${result ? `. ${result}` : ''}`,
      `**Cost**: $${usd(e.spent_usd)} of its $${usd(e.budget_usd)} budget.`,
      `**Next step**: ${next}`
    ],
    actions,
    push: { title: `Lab ${id8}: ${state.replace(/_/g, ' ')}`, body: `${what[0].toUpperCase()}${what.slice(1)}. Cost $${usd(e.spent_usd)}. Open PG1 for the report.` }
  };
}
const isFoundry = (goal) => String(goal || '').startsWith('[foundry]');

function pr(watch, { state, info }) {
  const p = parsePrTarget(watch.target_id) || { repo: '', number: '' };
  const i = info || {};
  const ci = i.ci || {};
  const failing = Array.isArray(ci.failing) ? ci.failing.slice(0, 4).map((n) => one(n, 40)) : [];
  const what = {
    merged: 'was merged',
    closed: 'was closed without merging',
    ci_success: 'passed CI',
    ci_failure: 'failed CI'
  }[state] || `is now ${state}`;
  const result = state === 'ci_failure' && failing.length ? `failing: ${failing.join(', ')}` : state === 'ci_success' ? 'every check on the head commit passed' : state;
  const next = {
    merged: 'Nothing to do; the change is in.',
    closed: 'Nothing to do unless it should be reopened.',
    ci_success: 'Review it and merge it yourself when you are happy (PG1 never merges).',
    ci_failure: 'Open the PR and look at the failing check.'
  }[state] || 'Open the PR.';
  return {
    title: `PR #${p.number} ${what}`,
    lines: [
      `**What happened**: PR #${p.number} in ${p.repo}${i.title ? ` (${one(i.title, 80)})` : ''} ${what}.`,
      `**Result**: ${result}.`,
      '**Cost**: none recorded by PG1.',
      `**Next step**: ${next}`
    ],
    actions: [linkAction('Open PR', i.url || `https://github.com/${p.repo}/pull/${p.number}`)],
    push: { title: `PR #${p.number}: ${what}`, body: i.title ? one(i.title, 100) : 'Open PG1 for the report.' }
  };
}

function run(watch, { state, info }) {
  const r = parseRunTarget(watch.target_id) || { repo: '', runId: '' };
  const i = info || {};
  const ok = state === 'success';
  return {
    title: `Workflow run ${r.runId} ${ok ? 'succeeded' : `ended: ${state}`}`,
    lines: [
      `**What happened**: workflow run ${r.runId}${i.name ? ` (${one(i.name, 60)})` : ''} in ${r.repo} finished.`,
      `**Result**: ${state}.`,
      '**Cost**: none recorded by PG1.',
      `**Next step**: ${ok ? 'Nothing to do.' : 'Open the run and read the failing job\'s log.'}`
    ],
    actions: [linkAction('Open run', i.url || `https://github.com/${r.repo}/actions/runs/${r.runId}`)],
    push: { title: `Run ${r.runId}: ${state}`, body: i.name ? one(i.name, 100) : 'Open PG1 for the report.' }
  };
}

function deploy(watch, { state, info }) {
  const i = info || {};
  const prod = i.target === 'production';
  const what = { ready: 'is live', error: 'failed', canceled: 'was canceled' }[state] || `is ${state}`;
  const kind = prod ? 'Production deploy' : 'Deploy';
  return {
    title: `${kind} ${what}`,
    lines: [
      `**What happened**: ${kind.toLowerCase()} ${one(watch.target_id, 40)}${i.project ? ` of ${one(i.project, 40)}` : ''} ${what}.`,
      `**Result**: ${state}.`,
      '**Cost**: none recorded by PG1.',
      `**Next step**: ${state === 'ready' ? (prod ? 'Check the live site; /status shows the runtime.' : 'Check the preview.') : 'Open the deployment\'s build log and fix the error before deploying again.'}`
    ],
    actions: [prod && state === 'ready' ? commandAction('/status') : null],
    push: { title: `${kind}: ${state}`, body: `${kind} ${what}.` }
  };
}

const BUILDERS = { lab, pr, workflow_run: run, deploy };

export function composeReport(watch, snapshot) {
  const b = BUILDERS[watch.target_type];
  const out = b(watch, snapshot || {});
  const title = whiteLabel(one(out.title, 120));
  const body = whiteLabel([`### [ REPORT · ${targetLabel(watch.target_type, watch.target_id)} ]`, ...out.lines].join('\n')).slice(0, 4000);
  const seen = new Set();
  const actions = out.actions.filter((a) => a && !seen.has(a.command || a.url) && seen.add(a.command || a.url)).slice(0, 3);
  return { title, body, actions, push: out.push };
}
