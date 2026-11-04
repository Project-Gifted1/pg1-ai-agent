// The low-risk auto-merge, and watching what a merge does to production.
//
// code:merge_low_risk (lib/autonomy.mjs: FREE, only while the Autonomous
// switch is ON and PG1_AUTONOMY=on). A PR qualifies only when ALL hold
// (qualifyPr; each failed rule is named):
//   - opened by PG1's own lab: a lab/<id> branch whose experiment holds
//     this PR as its code candidate, for a fix or improve task
//   - no SQL or migration file
//   - no env var, vercel.json, workflow or package change
//   - no change to lib/autonomy.mjs, lib/lab/policy.mjs, or any pricing,
//     payment, x402, licence, signing or secret-guard code
//   - no change to an MCP tool's name, inputs or output shape: the MCP and
//     A2A handlers, the listings and the contract tests are untouched
//   - under MAX_DIFF_LINES changed lines
//   - the REQUIRED checks ("npm test" and "browser tests") passed on the
//     head SHA; other checks (app checks such as Cloudflare Workers Builds,
//     x402-validate) are not judged. A required check still running is a
//     wait; a failed one means not low risk
//   - the whole diff was read (every changed file, each with its patch, up
//     to MAX_FILES), and existing tests are only added to: no deleted line
//     in an existing file under tests/, no removed or renamed test file
//   - auto-merge is not paused: after a rollback production is pinned to
//     the earlier deploy, so PG1 merges nothing on its own until the
//     operator promotes a deploy and sends /report resume
//   - the lab's promotion gate passed (safety scan, licence check)
//   - at most MAX_AUTO_MERGES_PER_DAY a UTC day, one at a time (none still
//     being watched)
// Anything else stays code:merge (APPROVAL): the PR goes to the report's
// approvals with the reasons.
//
// After a merge PG1 first confirms the merge's deploy is the one serving
// production (the production alias, GET /v4/aliases/{alias}); when
// production is pinned to another deploy it does not judge health against
// it, records the merge as not live and pauses auto-merge. Otherwise it
// watches the production deploy for WATCH_MS. If it is
// not Ready (failed, or still not Ready after WATCH_MS), or the real error
// rate or p95 latency rises more than 50% against the hour before the
// merge, PG1 rolls production back to the deployment before it (Vercel
// rollback, the existing token), opens a revert PR, and pushes a report at
// once. Rolling back PG1's own change is a safety action (deploy:rollback).

import { authorize, autonomyMode, logAutonomy } from '../autonomy.mjs';
import { labRepo } from '../lab/github.mjs';
import { readDeploys, observability, vercelProject, PINNED_TEXT } from './reports.mjs';

export const MAX_DIFF_LINES = 300;
export const MAX_AUTO_MERGES_PER_DAY = 3;
export const WATCH_MS = 60 * 60 * 1000;
export const MIN_WATCH_MS = 10 * 60 * 1000;
export const SPIKE_FACTOR = 1.5;
// An error spike needs at least this many 5xx answers since the deploy, so
// one stray error on a quiet hour is not a "rise".
export const MIN_SPIKE_ERRORS = 5;
export const REQUIRED_CHECKS = Object.freeze(['npm test', 'browser tests']);
export const AUTO_MERGE_KINDS = Object.freeze(['fix', 'improve']);

export const SQL_PATHS = [/\.sql$/i, /^supabase\//];
export const CONFIG_PATHS = [/^\.github\//, /^vercel\.json$/, /(?:^|\/)\.env/, /^wrangler\.toml$/, /^package(?:-lock)?\.json$/, /^\.vercel\//];
export const PROTECTED_PATHS = [
  /^lib\/autonomy\.mjs$/, /^lib\/lab\//, /^lib\/operator\//,
  /pric/i, /payment/i, /x402/i, /licen[cs]e/i, /sign(?:ing|ature)/i, /secret/i, /paywall/i, /freeTier/i,
  // Sign-in, sessions, cron auth, network and write guards, retention,
  // the chat handler, the kill switch, and anything that runs outside the
  // app (scripts, the database). public/index.html holds the sign-in modal
  // and its session code inline, so all of it is protected.
  /^lib\/operatorSession\.mjs$/, /^lib\/cronAuth\.mjs$/, /^lib\/netGuard\.mjs$/, /^lib\/githubWriteGuard\.mjs$/, /^lib\/retention\.mjs$/,
  /^api\/chat\.mjs$/, /auth|session|passkey|webauthn|csp|cors|ratelimit|rate-limit|kill/i,
  /^supabase\//, /^scripts\//, /^public\/index\.html$/
];
export const MAX_FILES = 300;
// The MCP contract: the handlers that define tool names, inputs and output
// shapes, the published listings, and the tests that pin them.
export const CONTRACT_PATHS = [
  /^api\/mcp\.mjs$/, /^api\/a2a\.mjs$/, /^server\.json$/, /^public\/\.well-known\//, /^public\/openapi\.json$/, /^public\/llms\.txt$/,
  /^tests\/(?:mcp-[\w-]+|listings-drift|jsonrpc-envelope|agent-card|a2a|discovery-files|presign-guard-contract)\.test\.mjs$/
];
// A new environment variable read in the added lines: env.NAME,
// process.env.NAME, env['NAME'] and env["NAME"] (also with spaces).
export const ENV_READ_RE = /^\+(?!\+\+).*\b(?:process\.env|env)\s*(?:\.\s*[A-Z][A-Z0-9_]{2,}|\[\s*(['"`])[A-Z][A-Z0-9_]{2,}\1\s*\])/m;

const any = (res, p) => res.some((re) => re.test(p));

// input: { task, pr, files: [{ filename, additions, deletions, patch }],
// experiment, ci: { state, checks }, mergesToday, watching, decision }.
// -> { ok, reasons: [] }
export function qualifyPr({ task, pr, files = [], experiment, ci, mergesToday = 0, watching = 0, decision = null, paused = null }) {
  const reasons = [];
  if (decision && !decision.allowed) reasons.push(`not allowed: ${decision.reason}`);
  if (!task || !AUTO_MERGE_KINDS.includes(task.kind)) reasons.push(`a ${task ? task.kind : 'unknown'} task is never merged automatically`);
  const head = pr && pr.head ? String(pr.head.ref || '') : '';
  const labId = /^lab\/([0-9a-f]{8})$/.exec(head);
  const c = experiment && experiment.candidate;
  if (!pr || !labId || !experiment || experiment.kind !== 'code' || !String(experiment.id).startsWith(labId[1]) || !c || Number(c.pr_number) !== Number(pr.number)) reasons.push('not opened by PG1\'s own lab');
  if (pr && (pr.state !== 'open' || pr.merged)) reasons.push('the PR is not open');
  const paths = files.map((f) => String(f.filename || ''));
  if (!paths.length) reasons.push('no changed files could be read');
  // The whole diff, or no decision: every changed file listed and each with
  // its patch (GitHub leaves it out of a file too large or binary).
  const changed = pr ? Number(pr.changed_files) : NaN;
  const noPatch = files.filter((f) => typeof f.patch !== 'string' && !(f.status === 'renamed' && !(Number(f.additions) || Number(f.deletions))));
  if (!Number.isFinite(changed) || changed > files.length || noPatch.length) reasons.push(`could not read the whole diff (${!Number.isFinite(changed) ? 'changed file count unknown' : changed > files.length ? `${files.length} of ${changed} files read` : `no patch for ${noPatch.slice(0, 3).map((f) => f.filename).join(', ')}`})`);
  // Existing tests are only added to.
  const testEdits = files.filter((f) => /^tests\//.test(String(f.filename || '')) && (f.status === 'removed' || f.status === 'renamed' || (f.status !== 'added' && Number(f.deletions) > 0)));
  if (testEdits.length) reasons.push(`changes existing tests (only added lines and new test files are allowed): ${testEdits.slice(0, 3).map((f) => `${f.filename} ${f.status === 'removed' ? 'removed' : f.status === 'renamed' ? 'renamed' : `${f.deletions} lines deleted`}`).join(', ')}`);
  const sql = paths.filter((p) => any(SQL_PATHS, p));
  if (sql.length) reasons.push(`SQL or migration files: ${sql.slice(0, 3).join(', ')}`);
  const cfg = paths.filter((p) => any(CONFIG_PATHS, p));
  if (cfg.length) reasons.push(`env, vercel.json, workflow or package files: ${cfg.slice(0, 3).join(', ')}`);
  const envRead = files.filter((f) => ENV_READ_RE.test(String(f.patch || ''))).map((f) => f.filename);
  if (envRead.length) reasons.push(`reads an environment variable: ${envRead.slice(0, 3).join(', ')}`);
  const prot = paths.filter((p) => any(PROTECTED_PATHS, p));
  if (prot.length) reasons.push(`protected code (autonomy, lab policy, pricing, payment, x402, licence, signing or secret guard): ${prot.slice(0, 3).join(', ')}`);
  const contract = paths.filter((p) => any(CONTRACT_PATHS, p));
  if (contract.length) reasons.push(`touches the MCP contract (tool names, inputs or outputs, or their tests): ${contract.slice(0, 3).join(', ')}`);
  const lines = files.reduce((n, f) => n + (Number(f.additions) || 0) + (Number(f.deletions) || 0), 0);
  if (lines >= MAX_DIFF_LINES) reasons.push(`${lines} changed lines (limit ${MAX_DIFF_LINES})`);
  const req = requiredChecks(ci);
  if (req.failed.length) reasons.push(`CI failed: ${req.failed.join(', ')}`);
  else if (req.pending.length) reasons.push(`CI is not green (pending: ${req.pending.join(', ')})`);
  if (!experiment || !experiment.gate || experiment.gate.pass !== true) reasons.push('the promotion gate (safety scan, licence check) has not passed');
  if (mergesToday >= MAX_AUTO_MERGES_PER_DAY) reasons.push(`the daily limit of ${MAX_AUTO_MERGES_PER_DAY} auto-merges is reached`);
  if (watching > 0) reasons.push('another auto-merge is still being watched (one at a time)');
  if (paused) reasons.push(`auto-merge is paused: ${paused}`);
  return { ok: reasons.length === 0, reasons, lines };
}

// Reasons that clear on their own (wait and look again) vs ones that send
// the PR to the operator.
export function waitOnly(reasons) {
  return reasons.length > 0 && reasons.every((r) => /^CI is not green \(pending|daily limit|still being watched|^auto-merge is paused/.test(r));
}

// Only the REQUIRED checks decide, on the head SHA: { failed, pending }.
// A required check that has not run yet, or is still running, is pending;
// one that completed with anything but success (or skipped/neutral) failed.
// When a check ran more than once, its newest run counts.
export function requiredChecks(ci) {
  const checks = (ci && Array.isArray(ci.checks)) ? ci.checks : [];
  const failed = [];
  const pending = [];
  for (const name of REQUIRED_CHECKS) {
    const runs = checks.filter((c) => c && c.name === name);
    const c = runs.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))[0];
    if (!c || c.status !== 'completed') pending.push(name);
    else if (c.conclusion !== 'success') failed.push(`${name} ${c.conclusion || 'failed'}`);
  }
  return { failed, pending };
}

// --- GitHub ------------------------------------------------------------------------

export function operatorGithubToken(env = process.env) {
  return String(env.GITHUB_TOKEN || env.PG1_LAB_DISPATCH_GITHUB_TOKEN || '').replace(/\s+/g, '');
}

export function createOperatorGithub({ env = process.env, fetchImpl = globalThis.fetch }) {
  const token = operatorGithubToken(env);
  const repo = labRepo(env);
  const h = (body) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'PG1-operator', ...(body ? { 'Content-Type': 'application/json' } : {}) });
  const api = async (path, opts = {}) => fetchImpl(`https://api.github.com/repos/${repo}${path}`, { ...opts, headers: h(opts.body), cache: 'no-store' });
  const graphql = async (query, variables) => {
    const res = await fetchImpl('https://api.github.com/graphql', { method: 'POST', headers: h(true), body: JSON.stringify({ query, variables }), cache: 'no-store' });
    const j = res.ok ? await res.json() : null;
    if (!j || j.errors) throw new Error(`github graphql ${res.status}`);
    return j.data;
  };
  return {
    configured: !!token,
    repo,
    async pr(n) { const r = await api(`/pulls/${Number(n)}`); return r.ok ? r.json() : null; },
    // Every changed file, up to MAX_FILES (GitHub pages them 100 at a time).
    async files(n) {
      const out = [];
      for (let page = 1; page <= Math.ceil(MAX_FILES / 100); page++) {
        const r = await api(`/pulls/${Number(n)}/files?per_page=100&page=${page}`);
        if (!r.ok) break;
        const list = await r.json();
        if (!Array.isArray(list)) break;
        out.push(...list);
        if (list.length < 100) break;
      }
      return out;
    },
    async checks(sha) {
      const r = await api(`/commits/${sha}/check-runs?per_page=100`);
      if (!r.ok) return { state: 'none', checks: [] };
      const list = ((await r.json()).check_runs || []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, started_at: c.started_at || null }));
      if (!list.length) return { state: 'none', checks: list };
      if (list.some((c) => c.status !== 'completed')) return { state: 'pending', checks: list };
      return { state: list.every((c) => ['success', 'skipped', 'neutral'].includes(c.conclusion)) ? 'success' : 'failure', checks: list };
    },
    async markReady(nodeId) {
      await graphql('mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }', { id: nodeId });
    },
    async merge(n, sha, title) {
      const r = await api(`/pulls/${Number(n)}/merge`, { method: 'PUT', body: JSON.stringify({ merge_method: 'squash', sha, commit_title: String(title || '').slice(0, 200) }) });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok && j.merged === true, status: r.status, sha: j.sha || null };
    },
    async revert(nodeId, title, body) {
      const d = await graphql('mutation($id: ID!, $title: String, $body: String) { revertPullRequest(input: { pullRequestId: $id, title: $title, body: $body }) { revertPullRequest { number url } } }', { id: nodeId, title, body });
      const p = d && d.revertPullRequest && d.revertPullRequest.revertPullRequest;
      return p ? { number: p.number, url: p.url } : null;
    },
    async dispatch(workflow, ref = 'main', inputs = {}) {
      const r = await api(`/actions/workflows/${workflow}/dispatches`, { method: 'POST', body: JSON.stringify({ ref, inputs }) });
      return r.status === 204 || r.status === 200;
    }
  };
}

// --- production -------------------------------------------------------------------

// The production deployment serving now (newest READY).
export async function currentProduction({ env, fetchImpl, now }) {
  const list = await readDeploys({ env, fetchImpl, sinceMs: now - 30 * 24 * 3600000, limit: 20 });
  return list.find((d) => d.state === 'READY') || null;
}

// The deployment serving production: what the production alias points at.
export function productionAlias(env = process.env) {
  const a = String(env.PG1_PRODUCTION_ALIAS || 'pg1-ai-agent.vercel.app').trim();
  return /^[a-z0-9.-]+$/i.test(a) ? a : 'pg1-ai-agent.vercel.app';
}
export async function servingDeployment({ env, fetchImpl }) {
  const token = String(env.VERCEL_TOKEN || '').replace(/\s+/g, '');
  const team = String(env.VERCEL_TEAM_ID || '').trim();
  const res = await fetchImpl(`https://api.vercel.com/v4/aliases/${productionAlias(env)}${/^team_/.test(team) ? `?teamId=${team}` : ''}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) throw Object.assign(new Error('x'), { reason: `the platform API answered HTTP ${res.status}` });
  const j = await res.json();
  return String(j.deploymentId || (j.deployment && j.deployment.id) || '') || null;
}
// Pinned: production is served by something other than the newest Ready
// production deploy (an instant rollback, or a deploy not promoted).
export async function productionPinned({ env, fetchImpl, now }) {
  const [serving, latest] = await Promise.all([servingDeployment({ env, fetchImpl }), currentProduction({ env, fetchImpl, now })]);
  return { pinned: !!(serving && latest && serving !== latest.id), serving, latest: latest ? latest.id : null };
}
export { PINNED_TEXT };

// Why auto-merge is paused, or ''. A rollback (or a merge found not live
// because production was pinned) pauses it until the operator acts.
export async function pauseReason({ opStore }) {
  const rows = await opStore.listTasks({ statuses: ['rolled_back', 'merged'], limit: 50 });
  const p = rows.find((t) => t.approval && t.approval.pinned === true && !t.decided_at);
  return p ? `${p.status === 'rolled_back' ? `PR #${p.pr_number} was rolled back` : `PR #${p.pr_number} is not live`}; production is pinned to the earlier deploy until a deploy is promoted (then /report resume)` : '';
}

// Real error rate (5xx / all requests) and p95 function duration in a window.
export async function healthWindow({ env, fetchImpl, fromIso, toIso }) {
  const [reqs, p95] = await Promise.all([
    observability({ env, fetchImpl, body: { metric: 'vercel.request.count', startTime: fromIso, endTime: toIso, groupBy: ['http_status'] } }),
    observability({ env, fetchImpl, body: { metric: 'vercel.function_invocation.function_duration_ms', aggregation: 'p95', startTime: fromIso, endTime: toIso } })
  ]);
  let total = 0;
  let errors = 0;
  for (const r of reqs.summary) {
    const n = Number(r.vercel_request_count_sum) || 0;
    total += n;
    if (/^5\d\d$/.test(String(r.http_status))) errors += n;
  }
  const p = p95.summary[0] ? Number(p95.summary[0].vercel_function_invocation_function_duration_ms_p95) : null;
  return { total, errors, rate: total ? errors / total : 0, p95: Number.isFinite(p) ? p : null };
}

// -> { spike: bool, why: '' }
export function compareHealth(before, after) {
  const why = [];
  if (after.errors >= MIN_SPIKE_ERRORS && after.rate > before.rate * SPIKE_FACTOR) why.push(`error rate ${(after.rate * 100).toFixed(2)}% vs ${(before.rate * 100).toFixed(2)}% the hour before`);
  if (after.p95 != null && before.p95 != null && before.p95 > 0 && after.p95 > before.p95 * SPIKE_FACTOR) why.push(`p95 latency ${Math.round(after.p95)} ms vs ${Math.round(before.p95)} ms the hour before`);
  return { spike: why.length > 0, why: why.join('; ') };
}

export async function rollbackProduction({ env, fetchImpl, deploymentId }) {
  const token = String(env.VERCEL_TOKEN || '').replace(/\s+/g, '');
  const team = String(env.VERCEL_TEAM_ID || '').trim();
  const project = vercelProject(env);
  if (!token || !/^prj_[A-Za-z0-9]+$/.test(project) || !/^dpl_[A-Za-z0-9]+$/.test(String(deploymentId || ''))) return { ok: false, reason: 'rollback is not configured (token, project or previous deployment missing)' };
  const res = await fetchImpl(`https://api.vercel.com/v1/projects/${project}/rollback/${deploymentId}${/^team_/.test(team) ? `?teamId=${team}` : ''}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? { ok: true } : { ok: false, reason: `the platform API answered HTTP ${res.status}` };
}

// --- one PR -----------------------------------------------------------------------

// Merges a PR (auto, or after the operator's approval) and starts watching.
export async function mergeTask({ task, pr, gh, opStore, env, fetchImpl, now = Date.now(), auto, audit }) {
  const previous = await currentProduction({ env, fetchImpl, now }).catch(() => null);
  if (pr.draft && pr.node_id) await gh.markReady(pr.node_id);
  const m = await gh.merge(pr.number, pr.head && pr.head.sha, `${pr.title} (#${pr.number})`);
  if (!m.ok) {
    await opStore.updateTask(task.id, { detail: `merge refused by GitHub (HTTP ${m.status})` });
    return { ok: false, reason: `GitHub refused the merge (HTTP ${m.status})` };
  }
  const at = new Date(now).toISOString();
  await opStore.updateTask(task.id, { status: 'watching', merge_sha: m.sha, merged_at: at, auto_merged: !!auto, previous_deploy_id: previous ? previous.id : null, pr_number: pr.number, pr_url: pr.html_url || task.pr_url, detail: `${auto ? 'auto-merged' : 'merged after approval'}; watching the production deploy` });
  await logAutonomy(audit, { action: auto ? 'code:merge_low_risk' : 'code:merge', decision: 'allowed', mode: autonomyMode(env), outcome: 'merged', detail: `PR #${pr.number}: ${task.title}` });
  return { ok: true, sha: m.sha };
}

// The auto-merge step for a fix/improve task whose PR is open.
export async function tryAutoMerge({ task, gh, labStore, opStore, env = process.env, fetchImpl = globalThis.fetch, now = Date.now(), audit }) {
  const decision = authorize('code:merge_low_risk', { actor: 'pg1', mode: autonomyMode(env) });
  const pr = await gh.pr(task.pr_number);
  const files = pr ? await gh.files(task.pr_number) : [];
  const experiment = task.experiment_id ? await labStore.get(task.experiment_id) : null;
  const ci = pr && pr.head ? await gh.checks(pr.head.sha) : null;
  const day = `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;
  const mergesToday = (await opStore.autoMergesSince(day)).length;
  const watching = (await opStore.listTasks({ statuses: ['watching'], limit: 10 })).filter((t) => t.auto_merged).length;
  let paused = await pauseReason({ opStore });
  if (!paused) {
    const pin = await productionPinned({ env, fetchImpl, now }).catch(() => null);
    if (!pin) paused = 'the production deployment could not be read';
    else if (pin.pinned) paused = `production is pinned to ${pin.serving}, not the newest deploy ${pin.latest}`;
  }
  const q = qualifyPr({ task, pr, files, experiment, ci, mergesToday, watching, decision, paused });
  if (q.ok) {
    const out = await mergeTask({ task, pr, gh, opStore, env, fetchImpl, now, auto: true, audit });
    return { merged: out.ok, reason: out.reason || '' };
  }
  if (!decision.allowed && /Autonomous mode is off|autonomy is off/.test(decision.reason)) return { merged: false, waiting: true, reasons: q.reasons };
  if (waitOnly(q.reasons)) return { merged: false, waiting: true, reasons: q.reasons };
  await opStore.updateTask(task.id, {
    status: 'needs_approval', approval_requested_at: new Date(now).toISOString(),
    approval: { action: 'code:merge', reason: `Not low risk: ${q.reasons.join('; ')}`.slice(0, 300), pr_url: pr ? pr.html_url : task.pr_url, approvable: !!pr && pr.state === 'open' }
  });
  await logAutonomy(audit, { action: 'code:merge', decision: 'needs_approval', mode: autonomyMode(env), detail: `PR #${task.pr_number}: ${q.reasons[0]}` });
  return { merged: false, reasons: q.reasons };
}

// One look at a merged PR's production deploy.
export async function watchMerge({ task, gh, opStore, env = process.env, fetchImpl = globalThis.fetch, now = Date.now(), notify = null, audit }) {
  const mergedAt = Date.parse(task.merged_at);
  const deploys = await readDeploys({ env, fetchImpl, sinceMs: mergedAt - 60000, limit: 20 });
  const dep = deploys.find((d) => d.commit_sha && task.merge_sha && d.commit_sha === task.merge_sha) || null;
  const failed = dep && ['ERROR', 'CANCELED'].includes(dep.state);
  let why = '';
  if (failed) why = `the production deploy is ${dep.state}`;
  else if ((!dep || dep.state !== 'READY') && now - mergedAt >= WATCH_MS) why = 'the production deploy was not Ready within 60 minutes';
  else if (dep && dep.state === 'READY') {
    if (dep.id !== task.deploy_id) await opStore.updateTask(task.id, { deploy_id: dep.id });
    // Is this deploy the one serving production? If production is pinned
    // elsewhere, its health says nothing about this merge: not judged.
    let serving = null;
    try { serving = await servingDeployment({ env, fetchImpl }); } catch (e) { return { status: 'watching', note: 'the serving deployment could not be read' }; }
    if (serving && serving !== dep.id) {
      if (now - Date.parse(dep.created_at) < MIN_WATCH_MS) return { status: 'watching', note: 'not serving yet' };
      await opStore.updateTask(task.id, { status: 'merged', approval: { pinned: true, kind: 'not_live', serving }, detail: `Merged but NOT live: production is pinned to ${serving}, not this deploy ${dep.id}. Health was not judged. ${PINNED_TEXT}` });
      await logAutonomy(audit, { action: 'code:merge_low_risk', decision: 'denied', mode: autonomyMode(env), outcome: 'paused', detail: `PR #${task.pr_number} not live: production pinned` });
      if (notify) { try { await notify({ title: 'PG1: merge not live', body: `#${task.pr_number} merged but production is pinned to an earlier deploy. Auto-merge paused until a deploy is promoted.` }); } catch (e) { /* recorded */ } }
      return { status: 'not_live', serving };
    }
    const readyAt = Date.parse(dep.created_at);
    if (now - readyAt >= MIN_WATCH_MS) {
      const before = await healthWindow({ env, fetchImpl, fromIso: new Date(mergedAt - 3600000).toISOString(), toIso: new Date(mergedAt).toISOString() });
      const after = await healthWindow({ env, fetchImpl, fromIso: new Date(readyAt).toISOString(), toIso: new Date(now).toISOString() });
      const cmp = compareHealth(before, after);
      if (cmp.spike) why = cmp.why;
      else if (now - mergedAt >= WATCH_MS) {
        await opStore.updateTask(task.id, { status: 'merged', detail: `deploy Ready and healthy for 60 minutes (error rate ${(after.rate * 100).toFixed(2)}%, p95 ${after.p95 == null ? '—' : `${Math.round(after.p95)} ms`})` });
        return { status: 'merged' };
      }
    }
  }
  if (!why) return { status: 'watching' };
  return rollBack({ task, gh, opStore, env, fetchImpl, why, notify, audit });
}

export async function rollBack({ task, gh, opStore, env, fetchImpl, why, notify, audit }) {
  const rb = await rollbackProduction({ env, fetchImpl, deploymentId: task.previous_deploy_id });
  await logAutonomy(audit, { action: 'deploy:rollback', decision: 'allowed', mode: autonomyMode(env), outcome: rb.ok ? 'rolled_back' : 'failed', detail: `PR #${task.pr_number}: ${why}`.slice(0, 200) });
  let revert = null;
  try {
    const pr = await gh.pr(task.pr_number);
    if (pr && pr.node_id) revert = await gh.revert(pr.node_id, `Revert #${task.pr_number}: ${why}`.slice(0, 200), `PG1 rolled production back to the deployment before #${task.pr_number} because ${why}. This PR reverts the change on main.`);
  } catch (e) { revert = null; }
  await logAutonomy(audit, { action: 'pr:revert', decision: 'allowed', mode: autonomyMode(env), outcome: revert ? 'opened' : 'failed', detail: `revert of PR #${task.pr_number}` });
  // A rollback pins production to the earlier deploy: later deploys are
  // not promoted on their own, so auto-merge pauses until the operator acts.
  await opStore.updateTask(task.id, { status: 'rolled_back', approval: { pinned: true, kind: 'rollback', serving: task.previous_deploy_id }, detail: `${rb.ok ? 'Rolled production back' : `Rollback FAILED (${rb.reason})`}: ${why}.${revert ? ` Revert PR #${revert.number}.` : ' The revert PR could not be opened.'}${rb.ok ? ` ${PINNED_TEXT}` : ''}` });
  if (notify) {
    try { await notify({ title: rb.ok ? 'PG1 rolled production back' : 'PG1 rollback failed', body: rb.ok ? `#${task.pr_number}: ${why}. Production is pinned to the earlier deploy; new merges won't go live until a deploy is promoted. Auto-merge paused.` : `#${task.pr_number}: ${why}; rollback failed: ${rb.reason}` }); } catch (e) { /* the task records it */ }
  }
  return { status: 'rolled_back', rolledBack: rb.ok, revert, why };
}
