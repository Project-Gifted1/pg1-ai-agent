// The chat side's GitHub calls for the lab, with the deployment's
// GITHUB_TOKEN (Actions: read and write on this repository, which /film
// already needs; or PG1_LAB_DISPATCH_GITHUB_TOKEN when set): dispatch
// lab.yml, find an experiment's run by its run-name ("lab <id>"), read its
// status, cancel it, download its result artifact, and read the check runs
// on a lab draft PR's head (the gate's CI evidence). Never a write to code.

import { unzip } from './unzip.mjs';

export const LAB_WORKFLOW = 'lab.yml';
export const DEFAULT_LAB_REPO = 'Project-Gifted1/pg1-ai-agent';

export function labRepo(env = process.env) {
  const r = String(env.PG1_LAB_REPO || '').trim();
  return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : DEFAULT_LAB_REPO;
}
export function labGithubToken(env = process.env) {
  return String(env.PG1_LAB_DISPATCH_GITHUB_TOKEN || env.GITHUB_TOKEN || '').replace(/\s+/g, '');
}

export function createLabGithub({ env = process.env, fetchImpl = globalThis.fetch }) {
  const token = labGithubToken(env);
  const repo = labRepo(env);
  const api = async (path, options = {}) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'PG1-lab', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      cache: 'no-store'
    });
    return res;
  };
  return {
    configured: !!token,
    async dispatch({ id, kind, goal, input, budgetUsd, token: labToken, ref = env.PG1_LAB_REF || 'main' }) {
      const res = await api(`/actions/workflows/${LAB_WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref, inputs: { experiment_id: id, kind, goal, input, budget_usd: Number(budgetUsd).toFixed(2), token: labToken } }) });
      return { ok: res.status === 204 || res.status === 200, status: res.status };
    },
    async findRun(id) {
      const res = await api(`/actions/workflows/${LAB_WORKFLOW}/runs?event=workflow_dispatch&per_page=50`);
      if (!res.ok) return null;
      const j = await res.json();
      return (j.workflow_runs || []).find((r) => r.name === `lab ${id}` || r.display_title === `lab ${id}`) || null;
    },
    async getRun(runId) {
      const res = await api(`/actions/runs/${Number(runId)}`);
      return res.ok ? res.json() : null;
    },
    async cancel(runId) {
      const res = await api(`/actions/runs/${Number(runId)}/cancel`, { method: 'POST' });
      return { ok: res.status === 202 || res.status === 409, status: res.status };
    },
    async result(runId, id) {
      const res = await api(`/actions/runs/${Number(runId)}/artifacts?per_page=50`);
      if (!res.ok) return null;
      const arts = ((await res.json()).artifacts || []).filter((a) => a.name === `lab-result-${id}` && !a.expired);
      if (!arts.length) return null;
      const newest = arts.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      const zip = await api(`/actions/artifacts/${newest.id}/zip`);
      if (!zip.ok) return null;
      const files = unzip(Buffer.from(await zip.arrayBuffer()));
      const raw = files.get('result.json');
      return raw ? JSON.parse(raw.toString('utf8')) : null;
    },
    // CI on a PR head: { state: 'success'|'pending'|'failure'|'none', checks }.
    async prChecks(prNumber) {
      const pr = await api(`/pulls/${Number(prNumber)}`);
      if (!pr.ok) return { state: 'none', checks: [] };
      const sha = (await pr.json()).head.sha;
      const runs = await api(`/commits/${sha}/check-runs?per_page=100`);
      if (!runs.ok) return { state: 'none', checks: [] };
      const list = ((await runs.json()).check_runs || []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }));
      if (!list.length) return { state: 'none', checks: list, sha };
      if (list.some((c) => c.status !== 'completed')) return { state: 'pending', checks: list, sha };
      const ok = list.every((c) => ['success', 'skipped', 'neutral'].includes(c.conclusion));
      return { state: ok ? 'success' : 'failure', checks: list, sha };
    }
  };
}
