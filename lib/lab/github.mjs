// The chat side's GitHub calls for the lab, with the deployment's
// GITHUB_TOKEN (Actions: read and write on this repository, which /film
// already needs; or PG1_LAB_DISPATCH_GITHUB_TOKEN when set): dispatch
// lab.yml, find an experiment's run by its run-name ("lab <id>"), read its
// status, cancel it, download its result artifact, and read the check runs
// on a lab draft PR's head (the gate's CI evidence). Never a write to code.

import { retryOnce } from '../commands/retry.mjs';
import { unzip } from './unzip.mjs';

export const LAB_WORKFLOW = 'lab.yml';
export const REQUIRED_CI_CHECKS = Object.freeze(['npm test']);
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
      // FAILURE -> RETRY (lib/commands/retry.mjs): once more after a 429 or
      // a dropped connection only. A 5xx may still have started the run,
      // and a second one would spend the experiment's budget twice.
      const send = async () => {
        try {
          const res = await api(`/actions/workflows/${LAB_WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref, inputs: { experiment_id: id, kind, goal, input, budget_usd: Number(budgetUsd).toFixed(2), token: labToken } }) });
          return { ok: res.status === 204 || res.status === 200, status: res.status };
        } catch (e) {
          return { ok: false, status: null, detail: String(e && e.message || 'network error') };
        }
      };
      const { result } = await retryOnce(send, { failed: (r) => !r.ok && (r.status === 429 || r.status == null) });
      if (result.status == null) throw new Error(result.detail);
      return result;
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
    // The run's result artifact: { ok: true, result } or { ok: false,
    // reason, transient }. reason says exactly what failed (artifact list
    // or download HTTP status, no artifact, a bad zip, no or bad
    // result.json); transient marks a failure worth retrying (network,
    // 429, 5xx). The zip endpoint answers with a redirect to blob storage:
    // it is followed by hand, without the GitHub token.
    async readResult(runId, id) {
      const fail = (reason, transient = false) => ({ ok: false, reason, transient });
      const transientStatus = (s) => s === 429 || s >= 500;
      let res;
      try { res = await api(`/actions/runs/${Number(runId)}/artifacts?per_page=50`); } catch (e) { return fail(`artifact list unreachable (${e.message || 'network error'})`, true); }
      if (!res.ok) return fail(`artifact list HTTP ${res.status}${res.status === 401 || res.status === 403 || res.status === 404 ? ' (the deployment\'s GitHub token needs Actions: read on this repository)' : ''}`, transientStatus(res.status));
      const all = (await res.json()).artifacts || [];
      const arts = all.filter((a) => a.name === `lab-result-${id}`);
      if (!arts.length) return fail('the run uploaded no lab-result artifact');
      const live = arts.filter((a) => !a.expired);
      if (!live.length) return fail('the result artifact has expired (GitHub keeps it 14 days)');
      const newest = live.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      let zip;
      try {
        zip = await api(`/actions/artifacts/${newest.id}/zip`, { redirect: 'manual' });
        if (zip.status >= 300 && zip.status < 400 && zip.headers && zip.headers.get('location')) {
          zip = await fetchImpl(zip.headers.get('location'), { cache: 'no-store' });
        }
      } catch (e) {
        return fail(`artifact download unreachable (${e.message || 'network error'})`, true);
      }
      if (!zip.ok) return fail(`artifact download HTTP ${zip.status}`, transientStatus(zip.status));
      let files;
      try { files = unzip(Buffer.from(await zip.arrayBuffer())); } catch (e) { return fail(`the result artifact is not a readable zip (${e.message})`); }
      const raw = files.get('result.json');
      if (!raw) return fail('the result artifact has no result.json');
      try {
        const result = JSON.parse(raw.toString('utf8'));
        if (!result || typeof result !== 'object' || Array.isArray(result)) return fail('result.json is not an object');
        return { ok: true, result };
      } catch (e) {
        return fail('result.json is not valid JSON');
      }
    },
    async result(runId, id) {
      const r = await this.readResult(runId, id);
      return r.ok ? r.result : null;
    },
    // CI on a PR head: { state: 'success'|'pending'|'failure'|'none', checks }.
    // 'none' until the Tests workflow's REQUIRED_CI_CHECKS have run on the
    // head: other apps' checks (a Vercel preview) are not CI evidence, and a
    // PR opened with the built-in GITHUB_TOKEN never starts Tests itself.
    async prChecks(prNumber) {
      const pr = await api(`/pulls/${Number(prNumber)}`);
      if (!pr.ok) return { state: 'none', checks: [] };
      const sha = (await pr.json()).head.sha;
      const runs = await api(`/commits/${sha}/check-runs?per_page=100`);
      if (!runs.ok) return { state: 'none', checks: [] };
      const list = ((await runs.json()).check_runs || []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }));
      if (!REQUIRED_CI_CHECKS.every((n) => list.some((c) => c.name === n))) return { state: 'none', checks: list, sha };
      if (list.some((c) => c.status !== 'completed')) return { state: 'pending', checks: list, sha };
      const ok = list.every((c) => ['success', 'skipped', 'neutral'].includes(c.conclusion));
      return { state: ok ? 'success' : 'failure', checks: list, sha };
    }
  };
}
