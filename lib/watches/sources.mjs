// Where watched states come from.
//
//   fromGithubEvent(event, payload)   a verified GitHub webhook → the
//                                     targets it says something about
//   fromVercelEvent(body)             a verified Vercel webhook → one deploy
//   readPr / readRun / readDeploy     the same states read back from the
//                                     APIs, for the re-sync cron (a webhook
//                                     that never arrived) and for a PR's
//                                     overall CI after a check_suite event
//
// Reads only: GitHub with the deployment's GITHUB_TOKEN, Vercel with
// VERCEL_TOKEN (optional; without it deploys are followed by webhook only).

import { prTarget, runTarget, parsePrTarget, parseRunTarget } from './targets.mjs';

export const LAB_RUN_NAME_RE = /^lab ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FAILED = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'];

const runState = (run) => (run.status === 'completed' ? String(run.conclusion || 'neutral') : String(run.status || 'queued'));

// [{ type, id, snapshot: { state, info } , needsCi? }] plus labId when a
// lab run finished.
export function fromGithubEvent(event, payload) {
  const out = { items: [], labId: null };
  const p = payload && typeof payload === 'object' ? payload : {};
  const repo = p.repository && REPO_RE.test(String(p.repository.full_name || '')) ? p.repository.full_name : null;
  if (!repo) return out;
  if (event === 'workflow_run' && p.workflow_run && Number.isFinite(Number(p.workflow_run.id))) {
    const run = p.workflow_run;
    out.items.push({ type: 'workflow_run', id: runTarget(repo, run.id), snapshot: { state: runState(run), info: { name: String(run.name || '').slice(0, 100), url: run.html_url, conclusion: run.conclusion || null } } });
    const lab = LAB_RUN_NAME_RE.exec(String(run.display_title || run.name || '')) || LAB_RUN_NAME_RE.exec(String(run.name || ''));
    if (lab && run.status === 'completed') out.labId = lab[1];
    return out;
  }
  if (event === 'pull_request' && p.pull_request && Number.isFinite(Number(p.pull_request.number))) {
    const pr = p.pull_request;
    const state = p.action === 'closed' ? (pr.merged ? 'merged' : 'closed') : ['opened', 'reopened', 'ready_for_review'].includes(p.action) ? 'open' : null;
    if (state) out.items.push({ type: 'pr', id: prTarget(repo, pr.number), snapshot: { state, info: { title: pr.title, url: pr.html_url } } });
    return out;
  }
  if (event === 'check_suite' && p.check_suite && p.action === 'completed') {
    const suite = p.check_suite;
    const fallback = FAILED.includes(suite.conclusion) ? 'ci_failure' : suite.conclusion === 'success' ? 'ci_success' : null;
    for (const pr of (Array.isArray(suite.pull_requests) ? suite.pull_requests : []).slice(0, 5)) {
      if (!Number.isFinite(Number(pr.number))) continue;
      out.items.push({ type: 'pr', id: prTarget(repo, pr.number), needsCi: true, snapshot: fallback ? { state: fallback, info: { failing: fallback === 'ci_failure' ? [String((suite.app && suite.app.name) || 'a check suite')] : [] } } : null });
    }
  }
  return out;
}

const VERCEL_STATES = { 'deployment.created': 'building', 'deployment.succeeded': 'ready', 'deployment.ready': 'ready', 'deployment.error': 'error', 'deployment.canceled': 'canceled' };

// { type: 'deploy', id, production, snapshot } or null.
export function fromVercelEvent(body) {
  const b = body && typeof body === 'object' ? body : {};
  const state = VERCEL_STATES[b.type];
  const p = b.payload && typeof b.payload === 'object' ? b.payload : {};
  const d = p.deployment && typeof p.deployment === 'object' ? p.deployment : {};
  const id = String(d.id || p.deploymentId || '');
  if (!state || !/^dpl_[A-Za-z0-9]{6,64}$/.test(id)) return null;
  const target = String(p.target || d.target || '') === 'production' ? 'production' : 'preview';
  return { type: 'deploy', id, production: target === 'production', snapshot: { state, info: { target, project: String(d.name || p.name || '').slice(0, 60) } } };
}

// --- reading back ------------------------------------------------------------

function gh(env, fetchImpl) {
  const token = String(env.GITHUB_TOKEN || '').replace(/\s+/g, '');
  if (!token) return null;
  return async (path) => {
    const res = await fetchImpl(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'PG1-watches' }, cache: 'no-store' });
    if (!res.ok) throw Object.assign(new Error(`github ${res.status}`), { status: res.status });
    return res.json();
  };
}

// A PR head's CI: ci_success, ci_failure, ci_pending, or open (no checks).
export function ciState(checkRuns) {
  const list = (Array.isArray(checkRuns) ? checkRuns : []).filter((c) => c && !['skipped', 'neutral'].includes(c.conclusion));
  if (!list.length) return { state: 'open', failing: [] };
  const failing = list.filter((c) => c.status === 'completed' && FAILED.includes(c.conclusion)).map((c) => String(c.name || 'check'));
  if (failing.length) return { state: 'ci_failure', failing };
  if (list.some((c) => c.status !== 'completed')) return { state: 'ci_pending', failing: [] };
  return { state: 'ci_success', failing: [] };
}

export async function readPr(targetId, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const api = gh(env, fetchImpl);
  const t = parsePrTarget(targetId);
  if (!api || !t) return null;
  const pr = await api(`/repos/${t.repo}/pulls/${t.number}`);
  const info = { title: pr.title, url: pr.html_url };
  if (pr.merged || pr.merged_at) return { state: 'merged', info };
  if (pr.state === 'closed') return { state: 'closed', info };
  const runs = await api(`/repos/${t.repo}/commits/${pr.head && pr.head.sha}/check-runs?per_page=100`);
  const ci = ciState(runs.check_runs);
  return { state: ci.state, info: { ...info, ci } };
}

export async function readRun(targetId, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const api = gh(env, fetchImpl);
  const t = parseRunTarget(targetId);
  if (!api || !t) return null;
  const run = await api(`/repos/${t.repo}/actions/runs/${t.runId}`);
  return { state: runState(run), info: { name: String(run.name || '').slice(0, 100), url: run.html_url, conclusion: run.conclusion || null } };
}

const VERCEL_READY = { READY: 'ready', ERROR: 'error', CANCELED: 'canceled' };
export async function readDeploy(id, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const token = String(env.VERCEL_TOKEN || '').replace(/\s+/g, '');
  if (!token || !/^dpl_[A-Za-z0-9]{6,64}$/.test(String(id))) return null;
  const team = String(env.VERCEL_TEAM_ID || '').trim();
  const res = await fetchImpl(`https://api.vercel.com/v13/deployments/${id}${/^team_[A-Za-z0-9]+$/.test(team) ? `?teamId=${team}` : ''}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) throw Object.assign(new Error(`deploy api ${res.status}`), { status: res.status });
  const d = await res.json();
  return { state: VERCEL_READY[d.readyState] || 'building', info: { target: d.target === 'production' ? 'production' : 'preview', project: String(d.name || '').slice(0, 60) } };
}
