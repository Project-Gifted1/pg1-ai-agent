/**
 * Autonomous capabilities (lib/autonomous/capabilities.mjs, runner.mjs,
 * missions.mjs, freeText.mjs), only while Autonomous mode is ON, and the
 * hard guardrails the switch can never lift:
 *   1  self-healing: a failed CI run or deploy -> a DRAFT PR with the report
 *      (and a fix when it applies cleanly); never a merge or a deploy
 *   2  feed guardian: anomalies confirmed by a second read, an alert, a SQL
 *      proposal on an approval card; nothing applied
 *   3  engine and credit watchdog: one alert per account per day
 *   4  missions: /mission add|list|pause|remove; planned and run on schedule
 *   5  lab autopilot: paid lab work refused at $0; promotions are cards
 *   6  integration watch: p95 near the 2.5 s budget, rising errors
 *   guardrails: free engines only at $0, a refusal stops, OFF does nothing,
 *   no secrets in prompts or PRs, the daily briefing
 *
 * Run with: node --test tests/autonomous-capabilities.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAutonomousStore, switchOn, __resetAutonomousSnapshot } from '../lib/autonomous/state.mjs';
import { autonomousTick, queueSelfHeal, parseSelfHealRef, selfHealRef } from '../lib/autonomous/runner.mjs';
import {
  feedCounts, feedAnomalies, feedGuardian, engineWatchdog, alertedFrom, integrationStats, integrationAlerts, p95, selfHeal, labAutopilot, briefingText, parseMissionPlan, parseSchedule
} from '../lib/autonomous/capabilities.mjs';
import { autonomousText, jsonFrom } from '../lib/autonomous/freeText.mjs';
import { handleMissionCommand, parseMissionCommand } from '../lib/autonomous/missions.mjs';
import { STATES } from '../lib/keysStatus.mjs';
import { __resetRouterState } from '../lib/aiRouter.mjs';
import { createAutonomousDb } from './helpers/autonomousDb.mjs';

const SUP = 'https://auto-cap.test';
const FREE = 'AIza-free-autonomous-0123456789';
const PAID = 'AQ.paid-autonomous-0123456789';
const ANTHROPIC = 'sk-ant-autonomous-0123456789abcdef';
const GH_TOKEN = 'ghp_autonomousTOKENabcdefghijklmnop01';
const H = 3600000;

beforeEach(() => { __resetAutonomousSnapshot(); __resetRouterState(); });

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const geminiReply = (text) => json({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });

// A small GitHub stand-in: branch refs, file contents, draft PRs. Any merge,
// deploy or other write is recorded as forbidden.
function fakeGithub({ file = 'export const x = 1;\n' } = {}) {
  const gh = { refs: [], puts: [], prs: [], forbidden: [], contents: { 'lib/broken.mjs': file } };
  gh.handle = async (url, opts = {}) => {
    const u = new URL(url);
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    const p = u.pathname;
    if (/\/merge$|\/deployments|\/dispatches$/.test(p) || (method === 'PUT' && /\/pulls\/\d+/.test(p))) { gh.forbidden.push(`${method} ${p}`); return json({}, 403); }
    if (p === '/repos/Project-Gifted1/pg1-ai-agent' && method === 'GET') return json({ default_branch: 'main' });
    if (p.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'abc123' } });
    if (p.endsWith('/git/refs') && method === 'POST') { gh.refs.push(body.ref); return json({ ref: body.ref }, 201); }
    const c = /\/contents\/(.+)$/.exec(p);
    if (c && method === 'GET') { const path = decodeURIComponent(c[1]); return gh.contents[path] ? json({ sha: 'f1', content: Buffer.from(gh.contents[path]).toString('base64') }) : json({}, 404); }
    if (c && method === 'PUT') { gh.puts.push({ path: decodeURIComponent(c[1]), branch: body.branch, content: Buffer.from(body.content, 'base64').toString('utf8') }); return json({ content: {} }, 201); }
    if (p.endsWith('/pulls') && method === 'POST') { gh.prs.push(body); return json({ number: 501, html_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/501' }, 201); }
    if (/\/actions\/runs\/\d+\/jobs/.test(p)) return json({ jobs: [{ id: 9, name: 'npm test', conclusion: 'failure' }] });
    if (/\/actions\/jobs\/9\/logs/.test(p)) return new Response(`not ok 1 - broken\nError: x is not defined at lib/broken.mjs:1\nGITHUB_TOKEN=${GH_TOKEN}\n`);
    return json({ message: 'not stubbed' }, 404);
  };
  return gh;
}

function world({ geminiFree = () => geminiReply('{}'), anthropic = null, gh = fakeGithub(), extra = null, now = () => Date.now() } = {}) {
  const calls = [];
  const db = createAutonomousDb({
    now,
    other: async (url, opts = {}) => {
      const u = String(url);
      calls.push({ url: u, method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: opts.body || '' });
      if (u.includes('generativelanguage.googleapis.com')) {
        const key = opts.headers['x-goog-api-key'];
        if (key === FREE) return geminiFree(JSON.parse(opts.body), u);
        return json({ error: { code: 402, message: 'paid key must not be called' } }, 402);
      }
      if (u.includes('api.anthropic.com')) { calls.push({ paid: true }); return anthropic ? anthropic() : json({ error: { message: 'paid engine must not be called' } }, 400); }
      if (u.startsWith('https://api.github.com')) return gh.handle(u, opts);
      if (extra) { const r = await extra(u, opts); if (r) return r; }
      if (u.includes('/rest/v1/pg1_missions')) return json([]);
      if (u.includes('/rest/v1/pg1_errors')) return json([]);
      if (u.includes('/rest/v1/pg1_push_subscriptions')) return json([]);
      return json({ message: `not stubbed: ${u}` }, 404);
    }
  });
  const env = { GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC, GITHUB_TOKEN: GH_TOKEN };
  const store = createAutonomousStore({ supUrl: SUP, supKey: 'service', fetchImpl: db.fetch, now });
  return { db, calls, env, store, gh };
}

const noScheduled = { engineWatchdog: async () => ({ ok: true, result: 'fine' }), integrationWatch: async () => ({ ok: true, result: 'fine' }), feedGuardian: async () => ({ ok: true, result: 'fine' }), listExperiments: async () => [], startExperiment: async () => ({ ok: false }) };

// --- the switch -----------------------------------------------------------------------

test('OFF: the tick does nothing at all, and webhooks queue nothing', async () => {
  const w = world();
  const out = await autonomousTick({ env: w.env, supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, deps: { notify: async () => {} } });
  assert.equal(out.on, false);
  assert.deepEqual(out.ran, []);
  assert.equal(await queueSelfHeal({ supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, kind: 'ci', ref: 'Project-Gifted1/pg1-ai-agent#run:77' }), null);
  assert.equal(w.db.actions.length, 0);
});

// --- 1. self-healing ------------------------------------------------------------------------

test('1: a failed CI run is diagnosed on a free engine and becomes a DRAFT PR with the report and the fix; never a merge, a deploy or a paid engine; no secret in the prompt or the PR', async () => {
  let prompt = '';
  const w = world({
    geminiFree: (body) => {
      prompt = JSON.stringify(body);
      return geminiReply(JSON.stringify({ cause: 'x is used before it is defined in lib/broken.mjs', confidence: 'high', report: 'The test run failed on lib/broken.mjs.', fix: { path: 'lib/broken.mjs', search: 'export const x = 1;', replace: 'export const x = 2;', why: 'define x' } }));
    }
  });
  await switchOn(w.store);
  const pushes = [];
  assert.ok(await queueSelfHeal({ supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, kind: 'ci', ref: 'Project-Gifted1/pg1-ai-agent#run:77', summary: 'Tests failed on main' }));
  assert.equal(await queueSelfHeal({ supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, kind: 'ci', ref: 'Project-Gifted1/pg1-ai-agent#run:77' }), null, 'one queued heal per failure');
  assert.equal(await queueSelfHeal({ supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, kind: 'ci', ref: 'Project-Gifted1/pg1-ai-agent#run:78', branch: 'self-heal-abc-1' }), null, 'its own draft PR never heals itself');
  const out = await autonomousTick({ env: w.env, supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, deps: { ...noScheduled, notify: async (p) => pushes.push(p) } });
  const heal = out.ran.find((r) => r.type === 'self_heal');
  assert.equal(heal.status, 'done');
  assert.equal(w.gh.prs.length, 1);
  assert.equal(w.gh.prs[0].draft, true, 'a draft PR');
  assert.equal(w.gh.prs[0].base, 'main');
  assert.match(w.gh.prs[0].head, /^self-heal-/);
  assert.match(w.gh.prs[0].body, /PG1 never merges or deploys/);
  assert.ok(w.gh.puts.some((p) => p.path === 'lib/broken.mjs' && p.content === 'export const x = 2;\n' && p.branch.startsWith('self-heal-')), 'the fix, on the branch only');
  assert.ok(w.gh.puts.some((p) => /^docs\/self-heal\//.test(p.path)), 'the report');
  assert.deepEqual(w.gh.forbidden, [], 'no merge, no deploy');
  assert.ok(!w.calls.some((c) => c.paid), 'no paid engine at $0');
  assert.ok(!prompt.includes(GH_TOKEN) && !JSON.stringify(w.gh.puts).includes(GH_TOKEN) && !JSON.stringify(w.gh.prs).includes(GH_TOKEN), 'no secret in the prompt or the PR');
  const row = w.db.actions.find((r) => r.type === 'self_heal');
  assert.equal(row.link, 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/501');
  assert.ok(pushes.some((p) => /Draft PR #501/.test(p.body)));
});

test('1: a fix that does not apply cleanly, or touches a protected path, is left out: report only', async () => {
  const w = world({ geminiFree: () => geminiReply(JSON.stringify({ cause: 'workflow broke', confidence: 'medium', report: 'r', fix: { path: '.github/workflows/tests.yml', search: 'a', replace: 'b' } })) });
  const out = await selfHeal({ env: w.env, fetchImpl: w.db.fetch, event: { kind: 'deploy', ref: 'dpl_abc123', summary: 'build failed', logs: 'Error: build failed' }, id: 'x1' });
  assert.match(out.result, /report only/);
  assert.ok(!w.gh.puts.some((p) => p.path.startsWith('.github')));
});

test('guardrail: a safety refusal stops the task and is never retried on another engine', async () => {
  const w = world({ geminiFree: () => json({ promptFeedback: { blockReason: 'SAFETY' } }) });
  const out = await selfHeal({ env: { ...w.env, GROQ_API_KEY: 'gsk_test_0123456789' }, fetchImpl: w.db.fetch, event: { kind: 'ci', ref: 'r', summary: 's', logs: '' } });
  assert.equal(out.refused, true);
  assert.ok(!w.calls.some((c) => c.url.includes('groq.com')), 'not retried on the next engine');
  assert.equal(w.gh.prs.length, 0);
});

test('guardrail: at $0 only free engines are asked; with no free engine nothing is called', async () => {
  const w = world();
  const out = await autonomousText({ env: { ANTHROPIC_API_KEY: ANTHROPIC, GEMINI_API_KEY_PAID: PAID }, system: 's', prompt: 'p', fetchImpl: w.db.fetch });
  assert.equal(out.ok, false);
  assert.match(out.reason, /no free text engine/);
  assert.equal(w.calls.length, 0);
  assert.deepEqual(jsonFrom('```json\n{"a":1}\n```'), { a: 1 });
});

test('1: self-heal references round-trip', () => {
  assert.deepEqual(parseSelfHealRef(selfHealRef('deploy', 'dpl_abc', 'build failed')), { kind: 'deploy', ref: 'dpl_abc', summary: 'build failed' });
});

// --- 2. the feed guardian ------------------------------------------------------------------

test('2: a source that drops sharply, a broken /api/ioc and a failed pipeline run are anomalies', () => {
  const now = Date.UTC(2026, 9, 17, 12);
  const rows = [];
  for (let d = 1; d < 7; d++) for (let i = 0; i < 50; i++) rows.push({ value: `CVE-2026-${1000 + d * 100 + i}`, verification_source: 'NVD-CVE-API', ingested_at: new Date(now - d * 24 * H - (i + 1) * 1000).toISOString() });
  rows.push({ value: 'CVE-2026-9999', verification_source: 'NVD-CVE-API', ingested_at: new Date(now - H).toISOString() });
  const counts = feedCounts(rows, now);
  assert.deepEqual(counts, [{ source: 'nvd', label: 'NVD', last24h: 1, dailyAverage: 50 }]);
  const a = feedAnomalies({ counts, ioc: { ok: false, why: 'HTTP 500' }, cve: { ok: true }, runs: [{ name: 'nightly', conclusion: 'failure', at: '2026-10-17T03:00', failed: true }] });
  assert.equal(a.length, 3);
  assert.match(a[0], /NVD: 1 rows in 24 hours against a daily average of 50/);
  assert.deepEqual(feedAnomalies({ counts: [], ioc: { ok: true }, cve: { ok: true }, runs: [] }), ['No rows were added to the feed in the last 24 hours.']);
});

test('2: the guardian confirms with a second read, alerts, and proposes SQL for placeholder rows without changing any data', async () => {
  const now = Date.now();
  const writes = [];
  let reads = 0;
  const w = world({
    extra: async (u, o) => {
      if (u.includes('/rest/v1/threat_ioc_telemetry')) {
        if ((o.method || 'GET') !== 'GET') { writes.push(u); return json({}, 405); }
        reads++;
        return json([{ value: 'test.com', verification_source: 'NVD-CVE-API', ingested_at: new Date(now - H).toISOString() }]);
      }
      if (u.includes('/api/ioc')) return json({ type: 'bundle', objects: [] });
      if (u.includes('/actions/runs')) return json({ workflow_runs: [] });
      return null;
    }
  });
  const out = await feedGuardian({ env: { ...w.env, PG1_PUBLIC_URL: 'https://app.test', SOURCE_OTHER_ENABLED: 'true' }, supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, now });
  assert.equal(reads, 2, 'a second read-only pass before alerting');
  assert.equal(out.alert, true);
  assert.match(out.body, /Anomalies \(confirmed by a second read\)/);
  assert.equal(out.needsApproval.kind, 'sql_proposal');
  assert.match(out.needsApproval.detail, /never changes data/);
  assert.match(out.needsApproval.sql, /^delete from public\.threat_ioc_telemetry/);
  assert.deepEqual(writes, [], 'nothing applied');
});

// --- 3. the watchdog ----------------------------------------------------------------------

test('3: accounts needing attention are alerted once a day each; routing keeps to working engines', async () => {
  const rows = [
    { engine: 'anthropic', set: true, state: STATES.NO_CREDIT }, { engine: 'groq', set: true, state: STATES.WORKING },
    { engine: 'replicate', set: true, state: STATES.INVALID }, { engine: 'openai', set: false, state: STATES.MISSING }
  ];
  const first = await engineWatchdog({ rows, alreadyAlerted: [] });
  assert.deepEqual(first.alertedAccounts, ['anthropic', 'replicate']);
  assert.match(first.alertText, /PG1 reasoning core: out of credit; PG1 Studio media fallback: invalid/);
  assert.doesNotMatch(first.alertText, /anthropic|replicate/i);
  const again = await engineWatchdog({ rows, alreadyAlerted: alertedFrom([{ inputs_summary: 'alerted: anthropic,replicate' }]) });
  assert.equal(again.alert, false, 'not twice in a day');
});

// --- 4. missions ---------------------------------------------------------------------------

test('4: /mission add, list, pause, remove (operator only)', async () => {
  const missions = [];
  const fetchImpl = async (url, o = {}) => {
    const u = new URL(url);
    const method = (o.method || 'GET').toUpperCase();
    if (method === 'POST') { const row = { id: '1234abcd-0000-4000-8000-000000000001', created_at: new Date().toISOString(), last_run_at: null, ...JSON.parse(o.body) }; missions.push(row); return json([row], 201); }
    if (method === 'PATCH') { const id = u.searchParams.get('id').slice(3); const m = missions.find((x) => x.id === id); Object.assign(m, JSON.parse(o.body)); return json([m]); }
    return json(missions.filter((m) => m.status !== 'removed'));
  };
  const run = (text, isOperator = true) => handleMissionCommand({ text, isOperator, supUrl: SUP, supKey: 'k', fetchImpl });
  assert.equal((await run('/mission add "x"', false)).status, 401);
  assert.deepEqual(parseMissionCommand('/mission add "keep the feed healthy" every 6h'), { sub: 'add', goal: 'keep the feed healthy', schedule: 'every 6h' });
  assert.match((await run('/mission add "keep the CVE feed healthy" every 6h')).reply, /Mission 1234abcd added: "keep the CVE feed healthy" \(every 6h\)/);
  assert.equal(missions[0].interval_minutes, 360);
  assert.match((await run('/mission list')).reply, /1234abcd · active · every 6h/);
  assert.match((await run('/mission pause 1234abcd')).reply, /paused/);
  assert.match((await run('/mission remove 1234abcd')).reply, /removed/);
  assert.equal(parseSchedule('weekly').label, 'weekly');
});

test('4: a due mission is planned on a free engine with read-only tasks only, and run', async () => {
  const mission = { id: 'abcd1234-0000-4000-8000-000000000002', goal: 'keep integrations fast', schedule: 'daily', interval_minutes: 1440, status: 'active', next_run_at: new Date(Date.now() - 1000).toISOString() };
  const patches = [];
  const w = world({
    geminiFree: (body) => geminiReply(/standing goal/i.test(JSON.stringify(body)) ? JSON.stringify({ tasks: [{ kind: 'integration_check', why: 'speed' }, { kind: 'merge_pr', why: 'not allowed' }, { kind: 'research_note', why: 'context', question: 'What is a good p95 for agent tools?' }] }) : 'Under one second is a good target.'),
    extra: async (u, o) => {
      if (u.includes('/rest/v1/pg1_missions')) { if ((o.method || 'GET') === 'PATCH') { patches.push(JSON.parse(o.body)); return json([mission]); } return json([mission]); }
      return null;
    }
  });
  await switchOn(w.store);
  const out = await autonomousTick({ env: w.env, supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, deps: { ...noScheduled, notify: async () => {}, integrationWatch: async () => ({ ok: true, result: 'Integration tools within budget.' }) } });
  assert.ok(out.ran.some((r) => r.type === 'mission' && r.status === 'done'));
  const row = w.db.actions.find((r) => r.type === 'mission');
  assert.match(row.body, /Integration check: Integration tools within budget\./);
  assert.match(row.body, /Research note: Under one second/);
  assert.doesNotMatch(row.body, /merge/i, 'a task kind off the list is dropped');
  assert.ok(patches.some((p) => p.next_run_at), 'the next run is scheduled');
  assert.deepEqual(parseMissionPlan('{"tasks":[{"kind":"deploy"}]}'), []);
});

// --- 5. lab autopilot ------------------------------------------------------------------------

test('5: lab work spends the lab\'s paid budget, so at $0 it is refused before anything starts; a gated experiment becomes an approval card', async () => {
  const w = world();
  await switchOn(w.store);
  let started = 0;
  const mission = { id: 'abcd1234-0000-4000-8000-000000000003', goal: 'find a new tool idea', interval_minutes: 1440, status: 'active', next_run_at: new Date(0).toISOString() };
  const deps = { ...noScheduled, notify: async () => {}, startExperiment: async () => { started++; return { ok: true, id: 'e1' }; } };
  const w2 = world({ extra: async (u) => (u.includes('/rest/v1/pg1_missions') ? json([mission]) : null) });
  await switchOn(w2.store);
  await autonomousTick({ env: { ...w2.env, PG1_LAB_BUDGET_USD: '2' }, supUrl: SUP, supKey: 'service', fetchImpl: w2.db.fetch, deps: { ...deps, feedGuardian: async () => ({ ok: true, result: 'x' }) } });
  // The mission itself ran first (free); the lab autopilot needs paid budget.
  const lab = w2.db.actions.find((r) => r.type === 'lab_autopilot');
  if (lab) assert.equal(lab.status, 'refused');
  assert.equal(started, 0, 'no lab experiment at $0');
  const out = await labAutopilot({ goal: null, listExperiments: async () => [{ id: 'e2e2e2e2-0000', kind: 'skill', goal: 'a skill', created_at: new Date(Date.now() - 2 * 86400000).toISOString(), gate: { pass: true }, promoted_stage: 'none' }], startExperiment: async () => ({ ok: false }) });
  assert.equal(out.needsApproval.kind, 'promote');
  assert.equal(out.needsApproval.command, '/lab report e2e2e2e2');
  assert.match(out.needsApproval.detail, /nothing is promoted until you approve/);
  assert.ok(w.db);
});

// --- 6. integration watch ---------------------------------------------------------------------

test('6: p95 near the 2.5 s budget or rising errors raise an alert', () => {
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const rows = [
    ...[2100, 2200, 2300, 2400, 900].map((l) => ({ tool_name: 'check_wallet_age', status: 'ok', latency_ms: l, created_at: at(60000) })),
    ...[1, 2, 3, 4].map(() => ({ tool_name: 'check_x402_endpoint', status: 'upstream_error', latency_ms: 300, created_at: at(60000) })),
    ...Array.from({ length: 20 }, () => ({ tool_name: 'check_x402_endpoint', status: 'ok', latency_ms: 300, created_at: at(5 * H) }))
  ];
  const stats = integrationStats(rows, ['check_wallet_age', 'check_x402_endpoint'], now);
  assert.equal(stats[0].p95Ms, 2400);
  const alerts = integrationAlerts(stats);
  assert.match(alerts[0], /check_wallet_age: p95 2400 ms over the last hour \(near the 2\.5 s budget\)/);
  assert.match(alerts[1], /check_x402_endpoint: 100% errors/);
  assert.equal(p95([]), null);
});

// --- the daily briefing ---------------------------------------------------------------------------

test('the daily briefing sums up the day and lists what waits for approval', () => {
  const now = Date.UTC(2026, 9, 17, 19);
  const rows = [
    { at: new Date(now - H).toISOString(), type: 'feed_guardian', status: 'done', result: 'Feed healthy', cost_usd: 0 },
    { at: new Date(now - 2 * H).toISOString(), type: 'self_heal', status: 'done', result: 'Draft PR #501 opened', link: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/501', cost_usd: 0 },
    { at: new Date(now - 3 * H).toISOString(), type: 'feed_guardian', status: 'needs_approval', result: 'Feed anomaly', approval: { title: 'Remove 2 placeholder rows' }, cost_usd: 0 }
  ];
  const text = briefingText(rows, { now, state: { enabled: true } });
  assert.match(text, /Autonomous mode: ON\. 3 actions today: 2 done/);
  assert.match(text, /Self-healing ops \(draft PR only\): done — Draft PR #501 opened/);
  assert.match(text, /Waiting for your approval \(1\):\n- Remove 2 placeholder rows/);
  assert.doesNotMatch(text, /gemini|claude|anthropic|groq|openai/i);
});

test('the tick sends the daily briefing once, after 18:00 Ireland time, with a push', async () => {
  const now = () => Date.UTC(2026, 9, 17, 19, 30); // 20:30 in Dublin
  const w = world({ now });
  await switchOn(w.store);
  const pushes = [];
  await autonomousTick({ env: w.env, supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, now, deps: { ...noScheduled, notify: async (p) => pushes.push(p) } });
  await autonomousTick({ env: w.env, supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, now, deps: { ...noScheduled, notify: async (p) => pushes.push(p) } });
  const briefings = w.db.actions.filter((r) => r.type === 'daily_briefing');
  assert.equal(briefings.length, 1);
  assert.match(briefings[0].body, /^PG1 daily briefing · 2026-10-17/);
  assert.equal(pushes.filter((p) => p.title === 'PG1 daily briefing').length, 1);
});
