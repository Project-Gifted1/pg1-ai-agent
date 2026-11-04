/**
 * PG1 as the operator of its own service (lib/operator):
 *   - the daily and weekly reports from fixtures (every figure from the
 *     data, "not read" for a source that fails), stored, PDF'd and pushed
 *   - findings become tasks: fix/improve start lab code work, new starts a
 *     prototype, listing and pricing wait for approval (1.5x cost check)
 *   - a qualifying PR auto-merges; each disqualifying rule blocks it; the
 *     daily cap and one-at-a-time
 *   - rollback on a failed deploy and on an error or latency spike, with a
 *     revert PR and a push
 *   - approvals from the report (Approve runs the APPROVAL action, Decline,
 *     never self-approved), expiry after 7 days
 *   - PG1_AUTONOMY=off or the switch OFF stops all of it; NEVER stays never
 * Run with: node --test tests/operator.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, TIERS, ACTION_TIERS } from '../lib/autonomy.mjs';
import { setAutonomousSnapshot, __resetAutonomousSnapshot } from '../lib/autonomous/state.mjs';
import { aggregateUsage } from '../lib/usageStats.mjs';
import { gatherDaily, gatherWeekly, buildDailyReport, buildWeeklyReport } from '../lib/operator/reports.mjs';
import { dailyFindings, weeklyFindings, actOnFindings, decideTask, expireApprovals, SelfApprovalRefused, pricingProposal, APPROVAL_TTL_MS } from '../lib/operator/tasks.mjs';
import { qualifyPr, tryAutoMerge, watchMerge, compareHealth, MAX_AUTO_MERGES_PER_DAY, waitOnly } from '../lib/operator/merge.mjs';
import { runReport, operatorTick, operatorWatch } from '../lib/operator/run.mjs';
import { handleReportCommand, parseReportCommand } from '../lib/operator/chat.mjs';
import { checkCodePath } from '../lib/lab/policy.mjs';

const ORIGINAL_ENV = { ...process.env };
const NOW = Date.UTC(2026, 10, 4, 7, 15, 0); // Wed 4 Nov 2026 07:15 UTC
const SUP = 'https://supabase.test';
const ENV = { PG1_AUTONOMY: 'on', VERCEL_TOKEN: 'vt', VERCEL_TEAM_ID: 'team_T1', PG1_VERCEL_PROJECT_ID: 'prj_P1', GITHUB_TOKEN: 'gt' };

beforeEach(() => { __resetAutonomousSnapshot(); setAutonomousSnapshot(true, Date.now()); });
after(() => { process.env = { ...ORIGINAL_ENV }; __resetAutonomousSnapshot(); });

// --- in-memory stores ---------------------------------------------------------------

function memOpStore(now = () => NOW) {
  const tasks = [];
  const reports = [];
  let n = 0;
  const id = () => `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  return {
    tasks, reports,
    async addReport(r) { const row = { id: id(), created_at: new Date(now()).toISOString(), delivered_at: null, ...r }; reports.push(row); return row; },
    async updateReport(rid, p) { Object.assign(reports.find((r) => r.id === rid), p); return { id: rid }; },
    async latestReport(kind) { return reports.filter((r) => r.kind === kind).slice(-1)[0] || null; },
    async reportSince(kind, since) { return reports.find((r) => r.kind === kind && r.created_at >= since) || null; },
    async undeliveredReports() { return reports.filter((r) => !r.delivered_at); },
    async ackReports(ids) { reports.filter((r) => ids.includes(r.id)).forEach((r) => { r.delivered_at = 'x'; }); return ids.length; },
    async listTasks({ statuses = null } = {}) { return tasks.filter((t) => !statuses || statuses.includes(t.status)); },
    async getTask(x) { return tasks.find((t) => t.id === x || t.id.startsWith(x)) || null; },
    async taskByKey(k) { return tasks.find((t) => t.finding_key === k) || null; },
    async addTask(r) { const row = { id: id(), created_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString(), status: 'open', auto_merged: false, ...r }; tasks.push(row); return row; },
    async updateTask(tid, p) { const t = tasks.find((x) => x.id === tid); Object.assign(t, p, { updated_at: new Date(now()).toISOString() }); return t; },
    async autoMergesSince(since) { return tasks.filter((t) => t.auto_merged && t.merged_at >= since); }
  };
}
function memAutoStore(rows = []) {
  return { rows, async listActions({ statuses = null, sinceIso = null } = {}) { return rows.filter((r) => (!statuses || statuses.includes(r.status)) && (!sinceIso || r.at >= sinceIso)); }, async updateAction(id, p) { Object.assign(rows.find((r) => r.id === id), p); } };
}

// --- usage fixtures ------------------------------------------------------------------

const H = (s) => s.repeat(32).slice(0, 32);
function usageRows() {
  const rows = [];
  const at = (daysAgo, hour = 10) => new Date(Date.UTC(2026, 10, 4 - daysAgo, hour)).toISOString();
  const add = (daysAgo, caller, r, hour) => rows.push({ created_at: at(daysAgo, hour), is_fixture: false, endpoint: '/api/mcp', payment_type: 'free', status: 'ok', client_name: null, caller_hash: H(caller), event_type: 'tool_call', tool_name: 'check_domain_age', ...r });
  // Real tool calls per complete day: 10 days ago .. yesterday.
  const perDay = { 1: 120, 2: 100, 3: 80, 4: 80, 5: 80, 6: 80, 7: 80, 8: 60, 9: 60, 10: 60, 11: 60, 12: 60, 13: 60, 14: 60 };
  for (const [d, n] of Object.entries(perDay)) for (let i = 0; i < n; i++) add(Number(d), 'a', {});
  // Yesterday: 6 upstream errors for real callers on check_wallet_age.
  for (let i = 0; i < 6; i++) add(1, 'b', { tool_name: 'check_wallet_age', status: 'upstream_error' }, 20);
  // 402s that never settled, this week.
  for (let i = 0; i < 25; i++) add(2, 'c', { tool_name: 'get_cve_details', status: 'payment_required', payment_type: 'none' });
  // Unserved demand: an unknown tool (real and probe) and unknown methods.
  add(3, 'd', {}); // a real call too, so this caller is real, not a probe
  for (let i = 0; i < 4; i++) add(3, 'd', { tool_name: null, status: 'unknown_tool', requested_tool: 'get_token_risk' });
  // A probe asking for the same tool (only unknown calls).
  for (let i = 0; i < 2; i++) add(3, 'e', { tool_name: null, status: 'unknown_tool', requested_tool: 'get_token_risk' });
  for (let i = 0; i < 4; i++) add(3, 'd', { event_type: 'mcp_request', tool_name: null, status: 'method_not_found', mcp_method: 'server/discover' });
  for (let i = 0; i < 3; i++) add(3, 'd', { event_type: 'mcp_request', tool_name: null, status: 'method_not_found', mcp_method: 'skills/list' });
  return rows;
}
const ROWS = usageRows();
const getStats = async ({ period }) => ({ ...aggregateUsage(ROWS, { period, now: NOW }), truncated: false, schema: 'current' });

// Network for the reports: deploys, the autonomy log, observability, the registry.
function reportFetch({ deploys = [{ uid: 'dpl_new', state: 'READY', createdAt: NOW - 3600000, meta: { githubCommitMessage: 'Fix x' } }], registry = '1.20.0', fail = [] } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET' });
    for (const f of fail) if (u.includes(f)) return new Response('no', { status: 503 });
    if (u.startsWith('https://api.vercel.com/v6/deployments')) return Response.json({ deployments: deploys });
    if (u.startsWith(`${SUP}/rest/v1/pg1_autonomy_log`)) return Response.json([{ at: new Date(NOW - 7200000).toISOString(), action: 'lab:dispatch', tier: 'FREE', actor: 'pg1', decision: 'allowed' }, { at: new Date(NOW - 3600000).toISOString(), action: 'code:merge_low_risk', tier: 'FREE', actor: 'pg1', decision: 'allowed' }]);
    if (u.startsWith(`${SUP}/rest/v1/pg1_autonomy_log`)) return Response.json([]);
    if (u.startsWith('https://api.vercel.com/v2/observability/query')) return Response.json({ summary: [{ request_path: '/.well-known/agent-card.json', vercel_request_count_sum: 42 }], data: [] });
    if (u.startsWith('https://registry.modelcontextprotocol.io/')) return Response.json({ servers: [{ server: { name: 'io.github.Project-Gifted1/pg1-threat-intel', version: registry }, _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } } }] });
    if (u.startsWith(`${SUP}/rest/v1/pg1_autonomy_log`) || u.startsWith(`${SUP}/rest/v1/`)) return new Response(null, { status: 201 });
    throw new Error(`unexpected ${u}`);
  };
  fn.calls = calls;
  return fn;
}

// --- reports ---------------------------------------------------------------------------

test('daily report from fixtures: every figure from the data, with deploys, autonomy, next and approvals', async () => {
  const opStore = memOpStore();
  await opStore.addTask({ finding_key: 'listing:x', kind: 'listing', title: 'Registry out of date', status: 'needs_approval', approval: { reason: 'registry has 1.20.0, live 1.21.1', approvable: true }, approval_requested_at: new Date(NOW).toISOString() });
  const fetchImpl = reportFetch();
  const data = await gatherDaily({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl, now: NOW, getStats, opStore, autoStore: memAutoStore([{ id: 'a1', at: new Date(NOW - 3600000).toISOString(), type: 'lab_autopilot', status: 'done', result: 'started an experiment' }]) });
  assert.equal(data.usage.yesterday.day, '2026-11-03');
  const b = buildDailyReport(data);
  assert.match(b.markdown, /Real requests 3 Nov: 126/, 'yesterday: 120 calls + 6 errors, real only');
  assert.match(b.markdown, /Day before \(2 Nov\): 125 \(change \+0\.8%\)/);
  assert.match(b.markdown, /Average of the last 7 complete days: /);
  assert.match(b.markdown, /PG1 or its sources: 6 · callers: 0/);
  assert.match(b.markdown, /READY · Fix x/);
  assert.match(b.markdown, /code:merge_low_risk ×1/);
  assert.match(b.markdown, /lab_autopilot: done — started an experiment/);
  assert.match(b.markdown, /Registry out of date — registry has 1\.20\.0, live 1\.21\.1/);
  assert.match(b.markdown, /Received on chain: not read \(/, 'no chain check on this deployment: said, not estimated');
  assert.doesNotMatch(b.markdown, /\bestimat(?:e|ed) (?:revenue|usage)\b|\bsafe\b/i);
  assert.equal(b.approvals.length, 1);
  assert.equal(b.card.approvals[0].title, 'Registry out of date');
  assert.match(b.push.body, /126 real requests yesterday/);
  // A source that fails is named and shows no figure.
  const down = await gatherDaily({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: reportFetch({ fail: ['api.vercel.com'] }), now: NOW, getStats: async () => { throw new Error('down'); }, opStore, autoStore: null });
  const bd = buildDailyReport(down);
  assert.match(bd.markdown, /Usage: not read \(the usage report could not be read\)/);
  assert.match(bd.markdown, /- not read \(the platform API answered HTTP 503\)/);
});

test('weekly report from fixtures: trend, unserved demand real vs probe, funnel, discovery, experiments, proposals', async () => {
  const opStore = memOpStore();
  const data = await gatherWeekly({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: reportFetch(), now: NOW, getStats, opStore, autoStore: null, labHistory: async () => [{ id: 'e1', created_at: new Date(NOW - 86400000).toISOString(), kind: 'code', goal: 'Fix check_wallet_age', status: 'done', gate: { pass: true } }], proposals: async () => [{ id: 'p1', title: 'Token risk', status: 'proposed', price_usd: 0.05, margin_ok: true, run_cost_per_call_usd: 0.01 }] });
  const b = buildWeeklyReport(data);
  assert.match(b.markdown, /Unknown tools: `get_token_risk` 4\/2/);
  assert.match(b.markdown, /Unknown MCP methods: `server\/discover` 4\/0, `skills\/list` 3\/0/);
  assert.match(b.markdown, /402 challenges 25 → settled 0/);
  assert.match(b.markdown, /Agent-card fetches \(7 days\): 42/);
  assert.match(b.markdown, /MCP registry: lists 1\.20\.0, live is \d+\.\d+\.\d+ \(out of date\)/);
  assert.match(b.markdown, /code: Fix check_wallet_age — done, gate passed/);
  assert.match(b.markdown, /Token risk — proposed, price 0\.05 USD \(1\.5x cost met\)/);
  const f = weeklyFindings(data);
  assert.deepEqual(f.map((x) => x.kind).sort(), ['listing', 'new', 'new', 'new', 'pricing', 'pricing']);
  assert.deepEqual(f.find((x) => x.key === 'new:tool:get_token_risk').evidence, { requested_tool: 'get_token_risk', real: 4, probe: 2, window: '7d' });
});

test('runReport: stores the report, saves the PDF, pushes it, and acts on the findings once', async () => {
  const opStore = memOpStore();
  const started = [];
  const pushed = [];
  const deps = { skipSnapshot: true, opStore, autoStore: null, startLab: async (x) => { started.push(x); return { ok: true, id: `exp-${started.length}`, reply: 'started' }; }, push: async (p) => { pushed.push(p); return 1; }, makePdf: async () => 'doc-1' };
  const out = await runReport({ kind: 'daily', env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: reportFetch(), now: NOW, getStats, deps });
  assert.equal(out.ok, true);
  assert.equal(opStore.reports.length, 1);
  assert.equal(opStore.reports[0].document_id, 'doc-1');
  assert.equal(pushed[0].title, 'PG1 daily report');
  const fix = opStore.tasks.find((t) => t.kind === 'fix');
  assert.equal(fix.status, 'lab_running');
  assert.deepEqual(fix.evidence, { tool: 'check_wallet_age', type: 'upstream_error', route: '/api/mcp', real_errors: 6, probe_errors: 0, window: '24h' });
  assert.equal(started[0].kind, 'code');
  assert.match(started[0].goal, /^Fix: Fix check_wallet_age/);
  // Once a day; and the same finding never makes a second task.
  assert.equal((await runReport({ kind: 'daily', env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: reportFetch(), now: NOW + 3600000, getStats, deps })).skipped, 'already sent today');
  await runReport({ kind: 'daily', env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: reportFetch(), now: NOW, getStats, deps: { ...deps, force: true } });
  assert.equal(opStore.tasks.filter((t) => t.kind === 'fix').length, 1);
  // /report today shows it, with its card.
  const shown = await handleReportCommand({ text: '/report today', isOperator: true, supUrl: SUP, supKey: 'k', deps: { opStore } });
  assert.match(shown.reply, /^\*\*PG1 daily report · 4 Nov\*\*/);
  assert.equal(shown.toolResults[0].usage.title, 'Daily report');
  assert.equal((await handleReportCommand({ text: '/report week', isOperator: true, supUrl: SUP, supKey: 'k', deps: { opStore } })).reply.startsWith('No weekly report yet'), true);
  assert.equal((await handleReportCommand({ text: '/report today', isOperator: false })).status, 401);
  assert.deepEqual(parseReportCommand('/report approve abcd1234'), { sub: 'approve', kind: null, id: 'abcd1234' });
});

test('weekly findings: listing and pricing wait for approval with the prepared steps and the 1.5x check', async () => {
  const opStore = memOpStore();
  const data = await gatherWeekly({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: reportFetch(), now: NOW, getStats, opStore, autoStore: null });
  const started = [];
  await actOnFindings({ findings: weeklyFindings(data), opStore, env: ENV, audit: {}, now: NOW, startLab: async (x) => { started.push(x); return { ok: true, id: 'e' }; } });
  const listing = opStore.tasks.find((t) => t.kind === 'listing');
  assert.equal(listing.status, 'needs_approval');
  assert.equal(listing.approval.action, 'directory:register');
  assert.equal(listing.approval.workflow, 'publish-mcp.yml');
  const pricing = opStore.tasks.find((t) => t.kind === 'pricing');
  assert.equal(pricing.approval.approvable, false, 'without a worst-case cost the price cannot be approved');
  assert.match(pricing.approval.reason, /worst-case cost per call is not known/);
  const news = opStore.tasks.filter((t) => t.kind === 'new');
  assert.ok(news.every((t) => t.status === 'lab_running'));
  assert.ok(started.every((s) => s.action === 'opportunity:prototype' && /^Research and prototype/.test(s.goal)));
  assert.deepEqual(pricingProposal({ priceUsd: 0.01, worstCaseUsd: 0.005 }).ok, true);
  assert.deepEqual(pricingProposal({ priceUsd: 0.01, worstCaseUsd: 0.008 }).ok, false);
});

// --- auto-merge ------------------------------------------------------------------------

const EXP = { id: 'abcd1234-0000-4000-8000-000000000000', kind: 'code', candidate: { type: 'code', pr_number: 77, pr_url: 'https://github.com/x/y/pull/77' }, gate: { pass: true } };
const GREEN = { state: 'success', checks: [{ name: 'npm test', status: 'completed', conclusion: 'success' }, { name: 'browser tests', status: 'completed', conclusion: 'success' }] };
const PR = { number: 77, state: 'open', merged: false, draft: true, changed_files: 2, node_id: 'PR_n77', title: '[lab abcd1234] Fix wallet age', html_url: 'https://github.com/x/y/pull/77', head: { ref: 'lab/abcd1234', sha: 'h77' } };
const FILES = [{ filename: 'lib/walletAge.mjs', status: 'modified', additions: 20, deletions: 5, patch: '+const x = 1;' }, { filename: 'tests/wallet-age.test.mjs', status: 'added', additions: 30, deletions: 0, patch: '+test()' }];
const qBase = () => ({ task: { kind: 'fix' }, pr: PR, files: FILES, experiment: EXP, ci: GREEN, mergesToday: 0, watching: 0, decision: { allowed: true } });
// One more changed file (counted in the PR, with its patch).
const plus = (q, f) => { q.files = [...q.files, { status: 'modified', patch: '+x', ...f }]; q.pr = { ...q.pr, changed_files: q.files.length }; };

test('a qualifying PR qualifies', () => {
  assert.deepEqual(qualifyPr(qBase()), { ok: true, reasons: [], lines: 55 });
});

const DISQUALIFY = [
  ['not opened by the lab', (q) => { q.pr = { ...PR, head: { ref: 'feature/x', sha: 'h' } }; }, /not opened by PG1's own lab/],
  ['another experiment\'s PR', (q) => { q.experiment = { ...EXP, candidate: { ...EXP.candidate, pr_number: 78 } }; }, /not opened by PG1's own lab/],
  ['a migration', (q) => plus(q, { filename: 'supabase/migrations/20261201000000_x.sql', additions: 3, deletions: 0 }), /SQL or migration/],
  ['an SQL file', (q) => plus(q, { filename: 'scripts/fix.sql', additions: 3, deletions: 0 }), /SQL or migration/],
  ['vercel.json', (q) => plus(q, { filename: 'vercel.json', additions: 1, deletions: 1 }), /env, vercel\.json, workflow/],
  ['a workflow', (q) => plus(q, { filename: '.github/workflows/tests.yml', additions: 1, deletions: 1 }), /env, vercel\.json, workflow/],
  ['an env file', (q) => plus(q, { filename: '.env.example', additions: 1, deletions: 0 }), /env, vercel\.json, workflow/],
  ['a new env var read', (q) => { q.files = [{ ...FILES[0], patch: '+const k = process.env.NEW_SECRET_KEY;' }]; }, /reads an environment variable/],
  ['lib/autonomy.mjs', (q) => plus(q, { filename: 'lib/autonomy.mjs', additions: 1, deletions: 1 }), /protected code/],
  ['lib/lab/policy.mjs', (q) => plus(q, { filename: 'lib/lab/policy.mjs', additions: 1, deletions: 1 }), /protected code/],
  ['pricing code', (q) => plus(q, { filename: 'lib/pricing.mjs', additions: 1, deletions: 1 }), /protected code/],
  ['payment code', (q) => plus(q, { filename: 'lib/paymentGate.mjs', additions: 1, deletions: 1 }), /protected code/],
  ['x402 code', (q) => plus(q, { filename: 'lib/x402Config.mjs', additions: 1, deletions: 1 }), /protected code/],
  ['licence code', (q) => plus(q, { filename: 'lib/licenceCheck.mjs', additions: 1, deletions: 1 }), /protected code/],
  ['signing code', (q) => plus(q, { filename: 'lib/signing.mjs', additions: 1, deletions: 1 }), /protected code/],
  ['secret-guard code', (q) => plus(q, { filename: 'lib/secretGuard.mjs', additions: 1, deletions: 1 }), /protected code/],
  ...[
    'lib/operator/tasks.mjs', 'lib/lab/agenda.mjs', 'lib/operatorSession.mjs', 'lib/cronAuth.mjs', 'lib/netGuard.mjs', 'lib/githubWriteGuard.mjs', 'lib/retention.mjs', 'api/chat.mjs',
    'lib/authHelpers.mjs', 'lib/sessionStore.mjs', 'lib/passkeyLogin.mjs', 'lib/webauthn.mjs', 'lib/cspHeaders.mjs', 'api/corsPolicy.mjs', 'lib/ratelimitStore.mjs', 'lib/rate-limit.mjs', 'lib/killSwitch.mjs',
    'supabase/functions/x.ts', 'scripts/deploy.mjs', 'public/index.html'
  ].map((f) => [`protected: ${f}`, (q) => plus(q, { filename: f, additions: 1, deletions: 1 }), /protected code/]),
  ['the MCP tool contract', (q) => plus(q, { filename: 'api/mcp.mjs', additions: 1, deletions: 1 }), /MCP contract/],
  ['a contract test', (q) => plus(q, { filename: 'tests/mcp-tools.test.mjs', additions: 1, deletions: 1 }), /MCP contract/],
  ['300 lines or more', (q) => { q.files = [{ filename: 'lib/big.mjs', additions: 250, deletions: 50, patch: '' }]; }, /300 changed lines \(limit 300\)/],
  ['npm test failed', (q) => { q.ci = { state: 'failure', checks: [{ ...GREEN.checks[0], conclusion: 'failure' }, GREEN.checks[1]] }; }, /^CI failed: npm test failure$/],
  ['browser tests failed', (q) => { q.ci = { state: 'failure', checks: [GREEN.checks[0], { ...GREEN.checks[1], conclusion: 'failure' }] }; }, /^CI failed: browser tests failure$/],
  ['browser tests not run yet (a wait)', (q) => { q.ci = { state: 'success', checks: [GREEN.checks[0]] }; }, /^CI is not green \(pending: browser tests\)$/],
  ['the whole diff not listed', (q) => { q.pr = { ...PR, changed_files: 5 }; }, /could not read the whole diff \(2 of 5 files read\)/],
  ['a file with no patch (too large or binary)', (q) => { q.files = [...FILES, { filename: 'public/docs/big.html', status: 'modified', additions: 900, deletions: 0 }]; q.pr = { ...PR, changed_files: 3 }; }, /could not read the whole diff \(no patch for public\/docs\/big\.html\)/],
  ['an existing test edited (lines deleted)', (q) => plus(q, { filename: 'tests/health.test.mjs', additions: 2, deletions: 3 }), /changes existing tests .*tests\/health\.test\.mjs 3 lines deleted/],
  ['a test file removed', (q) => plus(q, { filename: 'tests/health.test.mjs', status: 'removed', additions: 0, deletions: 40 }), /changes existing tests .*tests\/health\.test\.mjs removed/],
  ['env[\'NAME\'] read', (q) => { q.files = [{ ...FILES[0], patch: "+const k = env['NEW_TOKEN'];" }, FILES[1]]; }, /reads an environment variable/],
  ['env["NAME"] read', (q) => { q.files = [{ ...FILES[0], patch: '+const k = process.env[ "NEW_TOKEN" ];' }, FILES[1]]; }, /reads an environment variable/],
  ['auto-merge paused after a rollback', (q) => { q.paused = 'PR #70 was rolled back'; }, /^auto-merge is paused: PR #70 was rolled back$/],
  ['the gate not passed', (q) => { q.experiment = { ...EXP, gate: { pass: false } }; }, /promotion gate/],
  ['a new-tool task', (q) => { q.task = { kind: 'new' }; }, /a new task is never merged automatically/],
  ['autonomy not on', (q) => { q.decision = { allowed: false, reason: 'needs PG1_AUTONOMY=on (it is lab)' }; }, /not allowed: needs PG1_AUTONOMY=on/],
  ['the daily cap', (q) => { q.mergesToday = MAX_AUTO_MERGES_PER_DAY; }, /daily limit of 3 auto-merges/],
  ['another merge being watched', (q) => { q.watching = 1; }, /one at a time/]
];
for (const [name, change, re] of DISQUALIFY) {
  test(`auto-merge blocked: ${name}`, () => {
    const q = qBase();
    change(q);
    const r = qualifyPr(q);
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => re.test(x)), r.reasons.join(' | '));
  });
}

// GitHub and Vercel for a merge.
function mergeWorld({ deployState = 'READY', before = { total: 1000, errors: 2, p95: 600 }, after = { total: 1000, errors: 2, p95: 600 }, ci = GREEN, files = FILES, serving = null, extraChecks = [], headAt = NOW - 3600000 } = {}) {
  const calls = [];
  const notes = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body });
    if (u.startsWith('https://api.vercel.com/v6/deployments')) {
      const list = [{ uid: 'dpl_prev', state: 'READY', createdAt: NOW - 86400000, meta: { githubCommitSha: 'old' } }];
      if (Number(new URL(u).searchParams.get('since')) > NOW - 2 * 86400000) list.unshift({ uid: 'dpl_new', state: deployState, createdAt: NOW + 5 * 60000, meta: { githubCommitSha: 'm77' } });
      return Response.json({ deployments: list });
    }
    if (u.startsWith('https://api.vercel.com/v2/observability/query')) {
      const b = JSON.parse(opts.body);
      const w = Date.parse(b.startTime) < NOW ? before : after;
      if (b.metric === 'vercel.request.count') return Response.json({ summary: [{ http_status: '200', vercel_request_count_sum: w.total - w.errors }, { http_status: '500', vercel_request_count_sum: w.errors }] });
      return Response.json({ summary: [{ vercel_function_invocation_function_duration_ms_p95: w.p95 }] });
    }
    if (u.startsWith('https://api.vercel.com/v1/projects/prj_P1/rollback/dpl_prev')) return new Response('{}', { status: 201 });
    if (u.startsWith('https://api.vercel.com/v4/aliases/pg1-ai-agent.vercel.app')) return Response.json({ deploymentId: serving || 'dpl_prev' });
    if (u === 'https://api.github.com/graphql') {
      const q = JSON.parse(opts.body).query;
      if (q.includes('revertPullRequest')) return Response.json({ data: { revertPullRequest: { revertPullRequest: { number: 80, url: 'https://github.com/x/y/pull/80' } } } });
      return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    }
    if (u.endsWith('/pulls/77')) return Response.json(PR);
    if (u.includes('/pulls/77/files')) return Response.json(new URL(u).searchParams.get('page') === '1' ? files : []);
    if (u.endsWith('/commits/h77')) return Response.json({ commit: { committer: { date: new Date(headAt).toISOString() } } });
    if (u.includes('/commits/h77/check-runs')) return Response.json({ check_runs: [...ci.checks, ...extraChecks].map((c) => ({ ...c })) });
    if (u.endsWith('/pulls/77/merge')) return Response.json({ merged: true, sha: 'm77' });
    if (u.startsWith(SUP)) return new Response(null, { status: 201 });
    throw new Error(`unexpected ${u}`);
  };
  return { fetchImpl, calls, notes, notify: async (n) => notes.push(n) };
}
const labStore = { async get() { return EXP; } };

async function prTask(opStore, kind = 'fix') {
  return opStore.addTask({ finding_key: `${kind}:x:${Math.random()}`, kind, title: 'Fix wallet age errors', status: 'pr_open', experiment_id: EXP.id, pr_number: 77, pr_url: PR.html_url });
}

test('operatorTick: a qualifying lab PR is merged (ready, squash) and watched', async () => {
  const opStore = memOpStore();
  const t = await prTask(opStore);
  const w = mergeWorld();
  const out = await operatorTick({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: w.fetchImpl, now: NOW, deps: { opStore, autoStore: null, labStore, startLab: null } });
  assert.equal(out.merged, 1);
  assert.equal(t.status, 'watching');
  assert.equal(t.auto_merged, true);
  assert.equal(t.merge_sha, 'm77');
  assert.equal(t.previous_deploy_id, 'dpl_prev');
  assert.ok(w.calls.some((c) => c.url === 'https://api.github.com/graphql' && /markPullRequestReadyForReview/.test(c.body)));
  assert.equal(JSON.parse(w.calls.find((c) => c.url.endsWith('/pulls/77/merge')).body).merge_method, 'squash');
  assert.ok(w.calls.some((c) => c.url.includes('pg1_autonomy_log') && /code:merge_low_risk/.test(c.body)));
});

test('a PR that is not low risk goes to approval with the reasons; CI still running only waits', async () => {
  const opStore = memOpStore();
  const t = await prTask(opStore);
  const w = mergeWorld({ files: [FILES[0], { filename: 'lib/pricing.mjs', status: 'modified', additions: 2, deletions: 1, patch: '+x' }] });
  await operatorTick({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: w.fetchImpl, now: NOW, deps: { opStore, autoStore: null, labStore, startLab: null } });
  assert.equal(t.status, 'needs_approval');
  assert.equal(t.approval.action, 'code:merge');
  assert.match(t.approval.reason, /^Not low risk: protected code/);
  assert.ok(!w.calls.some((c) => c.url.endsWith('/merge')));
  const op2 = memOpStore();
  const t2 = await prTask(op2);
  const pending = { state: 'pending', checks: [{ name: 'npm test', status: 'in_progress', conclusion: null }] };
  const wp = mergeWorld({ ci: pending });
  const r = await tryAutoMerge({ task: t2, gh: (await import('../lib/operator/merge.mjs')).createOperatorGithub({ env: ENV, fetchImpl: wp.fetchImpl }), labStore, opStore: op2, env: ENV, fetchImpl: wp.fetchImpl, now: NOW, audit: {} });
  assert.equal(r.waiting, true);
  assert.equal(t2.status, 'pr_open');
  assert.equal(waitOnly(['CI is not green (pending)']), true);
});

test('the daily cap: after 3 auto-merges today the next waits for tomorrow; one at a time while watching', async () => {
  const opStore = memOpStore();
  for (let i = 0; i < 3; i++) await opStore.addTask({ finding_key: `done${i}`, kind: 'fix', title: 'x', status: 'merged', auto_merged: true, merged_at: new Date(NOW - 3600000).toISOString() });
  const t = await prTask(opStore);
  const w = mergeWorld();
  const out = await operatorTick({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: w.fetchImpl, now: NOW, deps: { opStore, autoStore: null, labStore, startLab: null } });
  assert.equal(out.merged, 0);
  assert.equal(t.status, 'pr_open', 'it waits; it is not sent for approval');
  assert.ok(!w.calls.some((c) => c.url.endsWith('/merge')));
  const op2 = memOpStore();
  await op2.addTask({ finding_key: 'w', kind: 'fix', title: 'x', status: 'watching', auto_merged: true, merged_at: new Date(NOW - 600000).toISOString(), merge_sha: 'zzz' });
  const t3 = await prTask(op2);
  await operatorTick({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: mergeWorld().fetchImpl, now: NOW, deps: { opStore: op2, autoStore: null, labStore, startLab: null } });
  assert.equal(t3.status, 'pr_open');
});

// --- watching and rollback ---------------------------------------------------------------

async function watchedTask(opStore) {
  return opStore.addTask({ finding_key: `w${Math.random()}`, kind: 'fix', title: 'Fix wallet age errors', status: 'watching', auto_merged: true, merged_at: new Date(NOW).toISOString(), merge_sha: 'm77', pr_number: 77, previous_deploy_id: 'dpl_prev' });
}
const ghFor = async (fetchImpl) => (await import('../lib/operator/merge.mjs')).createOperatorGithub({ env: ENV, fetchImpl });

test('rollback on a failed deploy: production back to the previous deployment, a revert PR, a push', async () => {
  const opStore = memOpStore();
  const t = await watchedTask(opStore);
  const w = mergeWorld({ deployState: 'ERROR' });
  const r = await watchMerge({ task: t, gh: await ghFor(w.fetchImpl), opStore, env: ENV, fetchImpl: w.fetchImpl, now: NOW + 10 * 60000, notify: w.notify, audit: { supUrl: SUP, supKey: 'k', fetchImpl: w.fetchImpl } });
  assert.equal(r.status, 'rolled_back');
  assert.equal(t.status, 'rolled_back');
  assert.ok(w.calls.some((c) => c.method === 'POST' && c.url.startsWith('https://api.vercel.com/v1/projects/prj_P1/rollback/dpl_prev?teamId=team_T1')));
  assert.deepEqual(r.revert, { number: 80, url: 'https://github.com/x/y/pull/80' });
  assert.match(t.detail, /^Rolled production back: the production deploy is ERROR\. Revert PR #80\./);
  assert.equal(w.notes[0].title, 'PG1 rolled production back');
  assert.ok(w.calls.some((c) => c.url.includes('pg1_autonomy_log') && /deploy:rollback/.test(c.body)));
});

test('rollback on an error spike, and on a latency spike; a healthy hour ends the watch', async () => {
  for (const [after, re] of [[{ total: 1000, errors: 40, p95: 600 }, /error rate 4\.00% vs 0\.20%/], [{ total: 1000, errors: 2, p95: 1200 }, /p95 latency 1200 ms vs 600 ms/]]) {
    const opStore = memOpStore();
    const t = await watchedTask(opStore);
    const w = mergeWorld({ after, serving: 'dpl_new' });
    const r = await watchMerge({ task: t, gh: await ghFor(w.fetchImpl), opStore, env: ENV, fetchImpl: w.fetchImpl, now: NOW + 30 * 60000, notify: w.notify, audit: {} });
    assert.equal(r.status, 'rolled_back');
    assert.match(r.why, re);
  }
  const opStore = memOpStore();
  const t = await watchedTask(opStore);
  const w = mergeWorld({ serving: 'dpl_new' });
  assert.equal((await watchMerge({ task: t, gh: await ghFor(w.fetchImpl), opStore, env: ENV, fetchImpl: w.fetchImpl, now: NOW + 30 * 60000, audit: {} })).status, 'watching');
  assert.equal((await watchMerge({ task: t, gh: await ghFor(w.fetchImpl), opStore, env: ENV, fetchImpl: w.fetchImpl, now: NOW + 61 * 60000, audit: {} })).status, 'merged');
  assert.ok(!w.calls.some((c) => c.url.includes('/rollback/')));
  // Not Ready within 60 minutes.
  const op3 = memOpStore();
  const t3 = await watchedTask(op3);
  const w3 = mergeWorld({ deployState: 'BUILDING' });
  assert.equal((await watchMerge({ task: t3, gh: await ghFor(w3.fetchImpl), opStore: op3, env: ENV, fetchImpl: w3.fetchImpl, now: NOW + 61 * 60000, audit: {} })).why, 'the production deploy was not Ready within 60 minutes');
  // A few stray errors on a quiet hour are not a spike.
  assert.equal(compareHealth({ total: 100, errors: 0, rate: 0, p95: 500 }, { total: 100, errors: 2, rate: 0.02, p95: 500 }).spike, false);
});

test('the rollback watch runs with the switch OFF (a safety action)', async () => {
  setAutonomousSnapshot(false, Date.now());
  const opStore = memOpStore();
  await watchedTask(opStore);
  const w = mergeWorld({ deployState: 'ERROR' });
  const out = await operatorWatch({ env: { ...ENV, PG1_AUTONOMY: 'off' }, supUrl: SUP, supKey: 'k', fetchImpl: w.fetchImpl, now: NOW + 600000, notify: w.notify, deps: { opStore, autoStore: null } });
  assert.equal(out[0].status, 'rolled_back');
  assert.equal(authorize('deploy:rollback', { actor: 'pg1', mode: 'off' }).allowed, true);
});

// --- approvals ---------------------------------------------------------------------------

test('approvals from the report: Approve runs the APPROVAL action, Decline changes nothing, nothing approves itself', async () => {
  const opStore = memOpStore();
  const listing = await opStore.addTask({ finding_key: 'l', kind: 'listing', title: 'Registry out of date', status: 'needs_approval', approval: { action: 'directory:register', approvable: true, workflow: 'publish-mcp.yml', steps: ['a'] } });
  const dispatched = [];
  const gh = { dispatch: async (wf) => { dispatched.push(wf); return true; } };
  await assert.rejects(decideTask({ id: listing.id, decision: 'approve', actor: 'pg1', opStore, env: ENV, audit: {}, gh }), SelfApprovalRefused);
  assert.equal(listing.status, 'needs_approval');
  const r = await decideTask({ id: listing.id, decision: 'approve', actor: 'operator', opStore, env: ENV, audit: {}, gh });
  assert.equal(r.decision, 'approved');
  assert.deepEqual(dispatched, ['publish-mcp.yml']);
  assert.equal(listing.status, 'done');
  // A new-tool PR: approving merges it (code:merge, approved) and watches it.
  const pr = await opStore.addTask({ finding_key: 'n', kind: 'new', title: 'New tool get_token_risk', status: 'needs_approval', pr_number: 77, approval: { action: 'code:merge', approvable: true } });
  const merged = [];
  const r2 = await decideTask({ id: pr.id.slice(0, 8), decision: 'approve', actor: 'operator', opStore, env: ENV, audit: {}, mergeApproved: async (t) => { merged.push(t.pr_number); return { ok: true }; } });
  assert.deepEqual(merged, [77]);
  assert.match(r2.message, /merged PR #77; PG1 is watching the production deploy/);
  // Decline.
  const p3 = await opStore.addTask({ finding_key: 'p', kind: 'pricing', title: 'Price', status: 'needs_approval', approval: { action: 'pricing:change', approvable: true, pricing: { price_usd: 0.02 } } });
  assert.equal((await decideTask({ id: p3.id, decision: 'decline', actor: 'operator', opStore, env: ENV, audit: {} })).decision, 'declined');
  assert.equal(p3.status, 'declined');
  // An item whose check failed cannot be approved.
  const p4 = await opStore.addTask({ finding_key: 'p4', kind: 'pricing', title: 'Price', status: 'needs_approval', approval: { action: 'pricing:change', approvable: false, reason: '1.5x rule not met' } });
  assert.match((await decideTask({ id: p4.id, decision: 'approve', actor: 'operator', opStore, env: ENV, audit: {} })).message, /cannot be approved as it stands/);
  // /report approve from chat is the operator's decision too.
  const l2 = await opStore.addTask({ finding_key: 'l2', kind: 'listing', title: 'Listing 2', status: 'needs_approval', approval: { action: 'directory:register', approvable: true, workflow: 'publish-mcp.yml' } });
  const audited = [];
  const chat = await handleReportCommand({ text: `/report approve ${l2.id.slice(0, 8)}`, isOperator: true, supUrl: SUP, supKey: 'k', fetchImpl: async (u, o) => { audited.push(JSON.parse(o.body)); return new Response(null, { status: 201 }); }, deps: { opStore, gh } });
  assert.match(chat.reply, /^Approved: PG1 started publish-mcp\.yml/);
  assert.deepEqual(audited.map((r) => [r.action, r.actor, r.outcome]), [['directory:register', 'operator', 'approved']], 'the approval is logged (stubbed: no network)');
});

test('an item not approved in 7 days expires and is reported', async () => {
  const opStore = memOpStore();
  const old = await opStore.addTask({ finding_key: 'o', kind: 'listing', title: 'Old listing', status: 'needs_approval', approval_requested_at: new Date(NOW - APPROVAL_TTL_MS - 1000).toISOString() });
  const fresh = await opStore.addTask({ finding_key: 'f', kind: 'listing', title: 'Fresh', status: 'needs_approval', approval_requested_at: new Date(NOW - 86400000).toISOString() });
  const auto = memAutoStore([{ id: 'c1', at: new Date(NOW - 8 * 86400000).toISOString(), type: 'self_heal', status: 'needs_approval', approval: { title: 'Old card' } }]);
  const expired = await expireApprovals({ opStore, autoStore: auto, now: NOW, audit: {}, env: ENV });
  assert.deepEqual(expired.map((e) => e.title), ['Old listing', 'Old card']);
  assert.equal(old.status, 'expired');
  assert.match(old.detail, /not approved within 7 days/);
  assert.equal(fresh.status, 'needs_approval');
  assert.equal(auto.rows[0].status, 'expired');
});

// --- off switches and NEVER ------------------------------------------------------------------

test('PG1_AUTONOMY=off or the switch OFF stops reports, tasks and merges; lab mode never auto-merges', async () => {
  for (const [mode, on] of [['off', true], ['on', false]]) {
    setAutonomousSnapshot(on, Date.now());
    const env = { ...ENV, PG1_AUTONOMY: mode };
    const opStore = memOpStore();
    const r = await runReport({ kind: 'daily', env, supUrl: SUP, supKey: 'k', fetchImpl: reportFetch(), now: NOW, getStats, deps: { skipSnapshot: true, opStore, autoStore: null, push: async () => { throw new Error('no push'); } } });
    assert.equal(r.ok, false);
    assert.equal(opStore.reports.length, 0);
    const acted = await actOnFindings({ findings: [{ kind: 'fix', key: 'k', title: 't', evidence: {} }], opStore, env, audit: {}, startLab: async () => { throw new Error('no lab'); } });
    assert.ok(acted.refused);
    assert.equal(opStore.tasks.length, 0);
    const t = await prTask(opStore);
    const w = mergeWorld();
    const tick = await operatorTick({ env, supUrl: SUP, supKey: 'k', fetchImpl: w.fetchImpl, now: NOW, deps: { opStore, autoStore: null, labStore, startLab: null } });
    assert.ok(tick.refused);
    assert.equal(t.status, 'pr_open');
    assert.ok(!w.calls.some((c) => c.url.endsWith('/merge')));
  }
  setAutonomousSnapshot(true, Date.now());
  assert.equal(authorize('code:merge_low_risk', { actor: 'pg1', mode: 'lab' }).allowed, false);
  assert.match(authorize('code:merge_low_risk', { actor: 'pg1', mode: 'lab' }).reason, /needs PG1_AUTONOMY=on/);
  assert.equal(authorize('code:merge_low_risk', { actor: 'pg1', mode: 'on' }).allowed, true);
  assert.equal(authorize('code:merge', { actor: 'pg1', mode: 'on' }).decision, 'needs_approval', 'every other merge stays APPROVAL');
});

test('NEVER stays never; payments, pricing, publishing, listings, contact, production writes and SQL stay APPROVAL; the lab cannot edit the policy', async () => {
  for (const a of ['policy:change', 'budget:raise', 'funds:move', 'funds:trade', 'audit:disable', 'audit:edit', 'keys:out_of_scope', 'env:write']) {
    assert.equal(ACTION_TIERS[a].tier, TIERS.NEVER);
    for (const opts of [{ actor: 'pg1', mode: 'on', approved: true }, { actor: 'operator', mode: 'on' }]) assert.equal(authorize(a, opts).allowed, false, a);
  }
  for (const a of ['payment:make', 'spend:outside_lab', 'pricing:change', 'publish:post', 'directory:register', 'contact:person', 'production:write', 'code:merge']) {
    assert.equal(ACTION_TIERS[a].tier, TIERS.APPROVAL, a);
    assert.equal(authorize(a, { actor: 'pg1', mode: 'on' }).allowed, false, a);
  }
  // An approval item can never carry a NEVER action through.
  const opStore = memOpStore();
  const bad = await opStore.addTask({ finding_key: 'bad', kind: 'pricing', title: 'Move funds', status: 'needs_approval', approval: { action: 'funds:move', approvable: true } });
  assert.equal((await decideTask({ id: bad.id, decision: 'approve', actor: 'operator', opStore, env: ENV, audit: {} })).message, 'That is never allowed.');
  for (const p of ['lib/autonomy.mjs', 'lib/lab/policy.mjs', 'lib/operator/merge.mjs']) assert.equal(checkCodePath(p).ok, false, p);
});

// --- review fixes ------------------------------------------------------------------------

test('CI: only the required checks decide; an always-red app check (Cloudflare Workers Builds) does not block', async () => {
  const cloudflare = { name: 'Workers Builds: pg1-ai-agent', status: 'completed', conclusion: 'failure' };
  const x402 = { name: 'x402-validate', status: 'completed', conclusion: 'failure' };
  const q = qBase();
  q.ci = { state: 'failure', checks: [...GREEN.checks, cloudflare, x402] };
  assert.deepEqual(qualifyPr(q), { ok: true, reasons: [], lines: 55 });
  // End to end: the tick merges it.
  const opStore = memOpStore();
  const t = await prTask(opStore);
  const w = mergeWorld({ extraChecks: [cloudflare, x402] });
  const out = await operatorTick({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: w.fetchImpl, now: NOW, deps: { opStore, autoStore: null, labStore, startLab: null } });
  assert.equal(out.merged, 1);
  assert.equal(t.status, 'watching');
  // A required check still running waits; a newer re-run that passed wins over an older failure.
  const running = { state: 'pending', checks: [GREEN.checks[0], { name: 'browser tests', status: 'in_progress', conclusion: null }] };
  const r = qualifyPr({ ...qBase(), ci: running });
  assert.equal(waitOnly(r.reasons), true);
  const rerun = { state: 'failure', checks: [GREEN.checks[0], { name: 'browser tests', status: 'completed', conclusion: 'failure', started_at: '2026-11-04T06:00:00Z' }, { name: 'browser tests', status: 'completed', conclusion: 'success', started_at: '2026-11-04T07:00:00Z' }] };
  assert.equal(qualifyPr({ ...qBase(), ci: rerun }).ok, true);
});

test('the diff is read page by page up to 300 files before deciding', async () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ filename: `docs/n${i}.md`, status: 'added', additions: 0, deletions: 0, patch: '' }));
  const seen = [];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    seen.push(u.searchParams.get('page'));
    const page = Number(u.searchParams.get('page'));
    return Response.json(many.slice((page - 1) * 100, page * 100));
  };
  const gh = (await import('../lib/operator/merge.mjs')).createOperatorGithub({ env: ENV, fetchImpl });
  const files = await gh.files(77);
  assert.equal(files.length, 250);
  assert.deepEqual(seen, ['1', '2', '3']);
  const q = qBase();
  q.files = files.slice(0, 200);
  q.pr = { ...PR, changed_files: 250 };
  assert.match(qualifyPr(q).reasons.join(' | '), /could not read the whole diff \(200 of 250 files read\)/);
});

test('after a rollback auto-merge pauses, the push and the daily report say production is pinned, and /report resume needs a promoted deploy', async () => {
  const opStore = memOpStore();
  const t = await watchedTask(opStore);
  const w = mergeWorld({ deployState: 'ERROR' });
  await watchMerge({ task: t, gh: await ghFor(w.fetchImpl), opStore, env: ENV, fetchImpl: w.fetchImpl, now: NOW + 600000, notify: w.notify, audit: {} });
  assert.equal(t.approval.pinned, true);
  assert.match(t.detail, /Production is pinned to the earlier deploy: new merges will not go live until a deploy is promoted\. Auto-merge is paused/);
  assert.match(w.notes[0].body, /Production is pinned to the earlier deploy; new merges won't go live until a deploy is promoted\. Auto-merge paused\./);
  // The next qualifying PR waits: no code:merge_low_risk until the operator acts.
  const next = await prTask(opStore);
  const w2 = mergeWorld();
  const out = await operatorTick({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: w2.fetchImpl, now: NOW + 3600000, deps: { opStore, autoStore: null, labStore, startLab: null } });
  assert.equal(out.merged, 0);
  assert.equal(next.status, 'pr_open', 'it waits; it is not sent for approval either');
  assert.ok(!w2.calls.some((c) => c.url.endsWith('/merge')));
  // The daily report leads with it.
  const data = await gatherDaily({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: reportFetch(), now: NOW, getStats, opStore, autoStore: null });
  const b = buildDailyReport(data);
  assert.match(b.markdown, /^# PG1 daily report · 4 Nov\n\n## Production is pinned to an earlier deploy\n\n- PR #77 \(Fix wallet age errors\): rolled back\./);
  assert.match(b.markdown, /new merges will not go live until a deploy is promoted/);
  assert.equal(b.card.sections[0].id, 'pinned');
  assert.match(b.push.body, /^Production pinned to an earlier deploy; auto-merge paused/);
  // /report resume: refused while production is still pinned, then resumed.
  const stillPinned = await handleReportCommand({ text: '/report resume', isOperator: true, supUrl: SUP, supKey: 'k', deps: { opStore, productionPinned: async () => ({ pinned: true, serving: 'dpl_prev', latest: 'dpl_new' }) } });
  assert.match(stillPinned.reply, /^Production is still pinned to dpl_prev/);
  assert.equal(t.decided_at, undefined);
  const resumed = await handleReportCommand({ text: '/report resume', isOperator: true, supUrl: SUP, supKey: 'k', fetchImpl: async () => new Response(null, { status: 201 }), deps: { opStore, productionPinned: async () => ({ pinned: false, serving: 'dpl_x', latest: 'dpl_x' }) } });
  assert.match(resumed.reply, /Auto-merge is resumed \(1 pause cleared\)/);
  const w3 = mergeWorld();
  await operatorTick({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: w3.fetchImpl, now: NOW + 7200000, deps: { opStore, autoStore: null, labStore, startLab: null } });
  assert.equal(next.status, 'watching', 'merges again once resumed');
});

test('a merge whose deploy is not serving production (pinned) is not judged on health: recorded not live, auto-merge paused', async () => {
  const opStore = memOpStore();
  const t = await watchedTask(opStore);
  const w = mergeWorld({ serving: 'dpl_prev', after: { total: 1000, errors: 400, p95: 9000 } });
  const r = await watchMerge({ task: t, gh: await ghFor(w.fetchImpl), opStore, env: ENV, fetchImpl: w.fetchImpl, now: NOW + 30 * 60000, notify: w.notify, audit: {} });
  assert.equal(r.status, 'not_live');
  assert.equal(t.status, 'merged');
  assert.match(t.detail, /^Merged but NOT live: production is pinned to dpl_prev, not this deploy dpl_new\. Health was not judged\./);
  assert.ok(!w.calls.some((c) => c.url.includes('/v2/observability/query')), 'no health judged against a deploy that is not serving');
  assert.ok(!w.calls.some((c) => c.url.includes('/rollback/')), 'and nothing rolled back for it');
  assert.equal(w.notes[0].title, 'PG1: merge not live');
  // Auto-merge is paused by it, and a live pin (production serving an
  // older deploy than the newest Ready one) pauses it too.
  const q = await prTask(opStore);
  await operatorTick({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: mergeWorld().fetchImpl, now: NOW + 3600000, deps: { opStore, autoStore: null, labStore, startLab: null } });
  assert.equal(q.status, 'pr_open');
  const op2 = memOpStore();
  const q2 = await prTask(op2);
  await operatorTick({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: mergeWorld({ serving: 'dpl_older' }).fetchImpl, now: NOW, deps: { opStore: op2, autoStore: null, labStore, startLab: null } });
  assert.equal(q2.status, 'pr_open');
});

test('the lab is blocked from every newly protected path', () => {
  for (const p of ['lib/operator/tasks.mjs', 'lib/lab/agenda.mjs', 'lib/operatorSession.mjs', 'lib/cronAuth.mjs', 'lib/netGuard.mjs', 'lib/githubWriteGuard.mjs', 'lib/retention.mjs', 'api/chat.mjs', 'lib/authHelpers.mjs', 'lib/sessionStore.mjs', 'lib/passkeyLogin.mjs', 'lib/webauthn.mjs', 'lib/cspHeaders.mjs', 'api/corsPolicy.mjs', 'lib/ratelimitStore.mjs', 'lib/rate-limit.mjs', 'lib/killSwitch.mjs', 'supabase/migrations/20261201000000_x.sql', 'scripts/deploy.mjs', 'public/index.html']) {
    assert.equal(checkCodePath(p).ok, false, p);
  }
  assert.equal(checkCodePath('lib/walletAge.mjs').ok, true);
});

// --- follow-ups: weakened tests and stuck checks -------------------------------------------

const testFile = (patch, filename = 'tests/wallet-age.test.mjs') => ({ filename, status: 'added', additions: patch.split('\n').length, deletions: 0, patch });
for (const [group, patch, pattern] of [
  ['skip', "+test('wallet age', { skip: 'flaky' }, () => {});\n+test.skip('other', () => {});\n+it.skip('x');\n+describe.skip('y');\n+xit('z');\n+xdescribe('w');\n+suite.skip('v', () => {});", /tests\/wallet-age\.test\.mjs adds (?:\.skip\(|\{ skip: \}|test\.skip|it\.skip|describe\.skip|xit\(|xdescribe\()/],
  ['only', "+test.only('wallet age', () => {});\n+test('b', { only: true }, () => {});", /tests\/wallet-age\.test\.mjs adds (?:\.only\(|\{ only: \})/],
  ['todo', "+test.todo('wallet age checks the delegation');", /tests\/wallet-age\.test\.mjs adds \.todo\(/],
  ['early return', "+test('wallet age', async () => {\n+  // not ready yet\n+  return;\n+  assert.equal(1, 2);\n+});", /tests\/wallet-age\.test\.mjs adds early return/]
]) {
  test(`auto-merge blocked: a weakened test (${group})`, () => {
    const q = qBase();
    q.files = [FILES[0], testFile(patch)];
    const r = qualifyPr(q);
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /^weakens tests: /.test(x) && pattern.test(x)), r.reasons.join(' | '));
  });
}

test('each weakening pattern is named, alone', async () => {
  const { weakenedTests } = await import('../lib/operator/merge.mjs');
  const cases = { ".skip(": "+suite.skip('a')", '{ skip: }': "+test('a', { timeout: 5, skip: true }, () => {})", 'test.skip': '+test.skip', 'it.skip': '+it.skip', 'describe.skip': '+describe.skip', 'xit(': "+xit('a')", 'xdescribe(': "+xdescribe('a')", '.only(': "+t.only('a')", '{ only: }': "+test('a', { only: true }, f)", '.todo(': "+test.todo('a')", 'early return': "+it('a', function () { return; });" };
  for (const [name, patch] of Object.entries(cases)) assert.ok(weakenedTests([testFile(patch)]).some((w) => w.pattern === name), name);
  // Not weakening: the usual conditional skip shorthand, removed lines, files outside tests/, a return later in the body.
  assert.deepEqual(weakenedTests([testFile("+test('a', { skip, timeout: 180000 }, async () => {\n+  const r = await f();\n+  return r;\n+});\n-test.skip('old')"), { filename: 'lib/x.mjs', status: 'modified', patch: '+x.skip(1)' }]), []);
});

test('a normal added test still qualifies', () => {
  const q = qBase();
  q.files = [FILES[0], testFile("+import { test } from 'node:test';\n+test('wallet age is read from the first transfer', async () => {\n+  const out = await walletAge('0x' + '1'.repeat(40));\n+  assert.equal(out.first_seen, '2023-01-01');\n+});")];
  assert.deepEqual(qualifyPr(q).reasons, []);
});

test('stuck required checks: pending under 24 h waits; over 24 h, or never started, goes to approval and the daily report', async () => {
  const pending = { state: 'pending', checks: [GREEN.checks[0], { name: 'browser tests', status: 'queued', conclusion: null }] };
  // Under 24 h since the head commit: wait.
  const op1 = memOpStore();
  const t1 = await prTask(op1);
  const w1 = mergeWorld({ ci: pending, headAt: NOW - 23 * 3600000 });
  await operatorTick({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: w1.fetchImpl, now: NOW, deps: { opStore: op1, autoStore: null, labStore, startLab: null } });
  assert.equal(t1.status, 'pr_open');
  // Over 24 h: to approval with the reason.
  const op2 = memOpStore();
  const t2 = await prTask(op2);
  const w2 = mergeWorld({ ci: pending, headAt: NOW - 25 * 3600000 });
  await operatorTick({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: w2.fetchImpl, now: NOW, deps: { opStore: op2, autoStore: null, labStore, startLab: null } });
  assert.equal(t2.status, 'needs_approval');
  assert.equal(t2.approval.reason, 'required check browser tests has not finished in 24 h');
  assert.ok(!w2.calls.some((c) => c.url.endsWith('/merge')));
  const data = await gatherDaily({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: reportFetch(), now: NOW, getStats, opStore: op2, autoStore: null });
  assert.match(buildDailyReport(data).markdown, /Fix wallet age errors — required check browser tests has not finished in 24 h/);
  // A check that never started (missing) counts the same; the task's pr_open time is the clock when the commit time cannot be read.
  const op3 = memOpStore();
  const t3 = await op3.addTask({ finding_key: 'x3', kind: 'fix', title: 'Fix wallet age errors', status: 'pr_open', experiment_id: EXP.id, pr_number: 77, pr_url: PR.html_url, pr_opened_at: new Date(NOW - 30 * 3600000).toISOString() });
  const w3 = mergeWorld({ ci: { state: 'none', checks: [] }, headAt: NaN });
  await operatorTick({ env: ENV, supUrl: SUP, supKey: 'k', fetchImpl: w3.fetchImpl, now: NOW, deps: { opStore: op3, autoStore: null, labStore, startLab: null } });
  assert.equal(t3.status, 'needs_approval');
  assert.equal(t3.approval.reason, 'required check npm test has not finished in 24 h; required check browser tests has not finished in 24 h');
  // A new push restarts the clock: the later of the head commit and pr_open.
  const r = qualifyPr({ ...qBase(), ci: pending, now: NOW, checksSince: Math.max(NOW - 30 * 3600000, NOW - 2 * 3600000) });
  assert.equal(waitOnly(r.reasons), true);
});
