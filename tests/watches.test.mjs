/**
 * Background watching and real-time reports (lib/watches, api/hooks/*,
 * api/watches.mjs, api/watches/sync.mjs, the lab.yml notify job, /watch and
 * "watch it" in the chat).
 *
 * Covered: the three signature checks (GitHub, Vercel, the lab's signed
 * notice) fail closed, and a rejection is logged without its payload; a
 * verified workflow_run for a lab run syncs the experiment at once and
 * reports it into the origin thread with a push; pull_request and
 * check_suite events report a watched PR; a duplicate event writes no
 * second report; production deploys are watched automatically and a
 * preview deploy is not; the lab notice (and the notify job's own script)
 * verifies and syncs; the cron reports what a webhook missed and expires
 * old watches; PG1_AUTONOMY=off holds reports until autonomy is back on;
 * reports say what happened, the result, the cost and the next step, with
 * real buttons; push text carries no secret, provider name or link; the
 * page API is operator-only; /lab start, "watch it", "tell me when it's
 * done", /watch list and /watch stop through the chat, and PRs PG1 opens
 * are watched.
 *
 * Run with: node --test tests/watches.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { makeDb, pgRest } from './helpers/pgrest.mjs';
import { makeZip } from './helpers/labWorld.mjs';

const { verifyGithubSignature, verifyVercelSignature, verifyLabCallback, signLabCallback, readRawBody, LAB_CALLBACK_MAX_AGE_S } = await import('../lib/watches/signatures.mjs');
const { createGithubHookHandler, createVercelHookHandler, createLabHookHandler } = await import('../lib/watches/hooks.mjs');
const { createWatchStore } = await import('../lib/watches/store.mjs');
const { composeReport } = await import('../lib/watches/report.mjs');
const { notificationText, pushToOperator } = await import('../lib/watches/push.mjs');
const { resyncWatches, autoWatch } = await import('../lib/watches/engine.mjs');
const { isWatchRequest, subjectFrom, referencesIn } = await import('../lib/watches/chat.mjs');
const { fromGithubEvent, fromVercelEvent, ciState } = await import('../lib/watches/sources.mjs');
const { authorize } = await import('../lib/autonomy.mjs');
const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
const { default: watchesApi, __clearWatchesRateLimitState, cleanSubscription } = await import('../api/watches.mjs');
const { default: syncCron } = await import('../api/watches/sync.mjs');

const ROOT = new URL('..', import.meta.url).pathname;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
// Test-only HMAC keys, made per run (not credentials).
const GH_SECRET = `gh-hook-${crypto.randomBytes(8).toString('hex')}`;
const VERCEL_SECRET = `vc-hook-${crypto.randomBytes(8).toString('hex')}`;
const LAB_SECRET = `lab-${crypto.randomBytes(8).toString('hex')}`;
const CRON = `cron-${crypto.randomBytes(8).toString('hex')}`;
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const THREAD = '0f0e0d0c-0b0a-4908-8706-050403020100';
const REPO = 'Project-Gifted1/pg1-ai-agent';

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.USER_API_KEY = OPERATOR.user;
  process.env.USER_API_PASS = OPERATOR.pass;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-watch-test';
  process.env.GITHUB_WEBHOOK_SECRET = GH_SECRET;
  process.env.VERCEL_WEBHOOK_SECRET = VERCEL_SECRET;
  process.env.PG1_LAB_DISPATCH_SECRET = LAB_SECRET;
  process.env.CRON_SECRET = CRON;
  process.env.GITHUB_TOKEN = ['gh', 'p_', 'watchtesttoken'.padEnd(36, '0')].join(''); // fake, built at runtime
  // Fake VAPID pair shapes; web-push itself is replaced in these tests.
  process.env.VAPID_PUBLIC_KEY = 'BTestPublicKey' + 'x'.repeat(70);
  process.env.VAPID_PRIVATE_KEY = 'test-private-' + 'y'.repeat(30);
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'GEMINI_API_KEY', 'GEMINI_API_KEY_FREE', 'GEMINI_API_KEY_PAID', 'ANTHROPIC_API_KEY', 'PG1_AUTONOMY', 'PG1_LAB_BUDGET_USD', 'PG1_LAB_DAILY_USD', 'PG1_LAB_DISPATCH_GITHUB_TOKEN', 'VERCEL_TOKEN']) delete process.env[k];
  __clearAuthRateLimitState();
  __clearWatchesRateLimitState();
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

// --- a world: Postgres behind PostgREST, a fake GitHub, a fake push service ----------

async function world() {
  const db = await makeDb(['20261019120000_pg1_skills.sql', '20261020120000_pg1_lab_and_flags.sql', '20261021120000_pg1_autonomy_log.sql', '20261028120000_pg1_watches.sql']);
  await db.exec(`create table public.pg1_ai_usage (id bigint generated always as identity primary key, at timestamptz not null default now(), day date not null default current_date, provider text not null, model text, task text, data_class text, input_tokens integer default 0, output_tokens integer default 0, chars integer default 0, unit text, cost_usd numeric not null default 0, cached boolean default false, ok boolean default true, status integer, fallback integer default 0, request_id text);
    create table public.pending_actions (token text primary key, action_type text, plan jsonb, diff_summary text, status text, created_at timestamptz, expires_at timestamptz, resolved_at timestamptz);`);
  const gh = { dispatches: [], runs: new Map(), artifacts: new Map(), pulls: new Map(), checks: new Map() };
  const github = async (u, options = {}) => {
    const p = new URL(u).pathname;
    let m;
    if (p === `/repos/${REPO}/actions/workflows/lab.yml/dispatches`) { gh.dispatches.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); }
    if (p === `/repos/${REPO}/actions/workflows/lab.yml/runs`) return Response.json({ workflow_runs: [...gh.runs.values()] });
    if ((m = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/artifacts$/.exec(p))) return Response.json({ artifacts: gh.artifacts.has(Number(m[1])) ? [{ id: Number(m[1]) * 10, name: gh.artifacts.get(Number(m[1])).name, expired: false, created_at: '2026-10-14T00:00:00Z' }] : [] });
    if ((m = /^\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/(\d+)\/zip$/.exec(p))) return new Response(gh.artifacts.get(Number(m[1]) / 10).zip);
    if ((m = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/.exec(p))) return gh.runs.has(Number(m[1])) ? Response.json(gh.runs.get(Number(m[1]))) : new Response('{}', { status: 404 });
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(p))) return gh.pulls.has(`${m[1]}#${m[2]}`) ? Response.json(gh.pulls.get(`${m[1]}#${m[2]}`)) : new Response('{}', { status: 404 });
    if ((m = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/check-runs$/.exec(p))) return Response.json({ check_runs: gh.checks.get(m[1]) || [] });
    throw new Error('Unexpected GitHub call in test: ' + u);
  };
  const calls = [];
  globalThis.fetch = pgRest(db, {
    calls,
    passthrough: async (u, o) => {
      if (u.startsWith('https://api.github.com/')) return github(u, o);
      if (u.includes('/storage/v1/')) return Response.json([]);
      return null;
    }
  });
  const pushes = [];
  const webpush = { gone: new Set(), async sendNotification(sub, payload, opts) { if (webpush.gone.has(sub.endpoint)) throw Object.assign(new Error('gone'), { statusCode: 410 }); pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts }); } };
  const store = createWatchStore({ supUrl: 'https://supabase.test', supKey: 'k' });
  return { db, gh, calls, pushes, webpush, store };
}

const rows = async (db, sql) => (await db.query(sql)).rows;
async function addDevice(store, n = 1) {
  await store.addSubscription({ endpoint: `https://push.example/device-${n}`, p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) });
}

function makeRes() {
  return { statusCode: null, headers: {}, jsonBody: null, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write() { return true; }, end() { return this; }, on() {} };
}
// A request whose body is an unread raw stream (the routes themselves get
// the exact bytes as req.rawBody from asWebHandler; see hooks-raw-body.test).
function rawReq(body, headers = {}) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from([buf]);
  req.method = 'POST';
  req.headers = headers;
  return req;
}
const ghHeaders = (event, raw, secret = GH_SECRET) => ({ 'x-github-event': event, 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}` });
const vcHeaders = (raw, secret = VERCEL_SECRET) => ({ 'x-vercel-signature': crypto.createHmac('sha1', secret).update(raw).digest('hex') });

async function ghHook(event, payload, w, { headers = null } = {}) {
  const raw = JSON.stringify(payload);
  const res = makeRes();
  await createGithubHookHandler({ webpushImpl: w.webpush })(rawReq(raw, headers || ghHeaders(event, raw)), res);
  return res;
}
async function vcHook(payload, w, { headers = null } = {}) {
  const raw = JSON.stringify(payload);
  const res = makeRes();
  await createVercelHookHandler({ webpushImpl: w.webpush })(rawReq(raw, headers || vcHeaders(raw)), res);
  return res;
}

let ip = 0;
async function chat(body, creds = OPERATOR) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.85.0.${++ip % 250}` }, body: { ...creds, ...body } }, res);
  return res;
}
async function api(body, creds = OPERATOR) {
  const res = makeRes();
  await watchesApi({ method: 'POST', headers: {}, socket: { remoteAddress: `10.86.0.${++ip % 250}` }, body: { ...creds, ...body } }, res);
  return res;
}

// A finished lab run for the newest dispatched experiment.
function finishLab(gh, result, runId = 950) {
  const id = gh.dispatches[gh.dispatches.length - 1].inputs.experiment_id;
  gh.runs.set(runId, { id: runId, name: `lab ${id}`, display_title: `lab ${id}`, status: 'completed', conclusion: 'success', html_url: `https://github.com/${REPO}/actions/runs/${runId}`, updated_at: new Date().toISOString() });
  gh.artifacts.set(runId, { name: `lab-result-${id}`, zip: makeZip({ 'result.json': JSON.stringify({ id, status: 'done', spent_usd: 0.37, calls: 3, report_markdown: '## Findings\nNVD allows commercial reuse of CVE records.', ...result }) }) });
  return { id, runId, run: gh.runs.get(runId) };
}

// --- signatures -----------------------------------------------------------------------

test('signatures: GitHub, Vercel and the lab notice verify the raw body and fail closed', () => {
  const raw = Buffer.from('{"a":1}');
  const req = (h) => ({ headers: h });
  assert.deepEqual(verifyGithubSignature(req(ghHeaders('ping', raw)), raw), { ok: true });
  assert.equal(verifyGithubSignature(req(ghHeaders('ping', raw, 'other-secret')), raw).reason, 'bad_signature');
  assert.equal(verifyGithubSignature(req({}), raw).reason, 'unsigned');
  assert.equal(verifyGithubSignature(req({ 'x-hub-signature-256': 'sha1=abc' }), raw).reason, 'malformed');
  assert.equal(verifyGithubSignature(req(ghHeaders('ping', raw)), Buffer.from('{"a":2}')).reason, 'bad_signature', 'a changed body fails');
  assert.equal(verifyGithubSignature(req(ghHeaders('ping', raw)), raw, {}).reason, 'not_configured');

  assert.deepEqual(verifyVercelSignature(req(vcHeaders(raw)), raw), { ok: true });
  assert.equal(verifyVercelSignature(req(vcHeaders(raw, 'nope')), raw).reason, 'bad_signature');
  assert.equal(verifyVercelSignature(req({}), raw).reason, 'unsigned');
  assert.equal(verifyVercelSignature(req(vcHeaders(raw)), raw, {}).reason, 'not_configured');

  const now = 1_800_000_000;
  const s = signLabCallback(raw, LAB_SECRET, now);
  const labReq = req({ 'x-pg1-timestamp': s.timestamp, 'x-pg1-signature': s.signature });
  assert.deepEqual(verifyLabCallback(labReq, raw, process.env, now + 5), { ok: true });
  assert.equal(verifyLabCallback(labReq, raw, process.env, now + LAB_CALLBACK_MAX_AGE_S + 1).reason, 'stale', 'an old notice cannot be replayed');
  assert.equal(verifyLabCallback(labReq, Buffer.from('{"a":9}'), process.env, now).reason, 'bad_signature');
  assert.equal(verifyLabCallback(req({ 'x-pg1-signature': s.signature }), raw, process.env, now).reason, 'unsigned');
  assert.equal(verifyLabCallback(labReq, raw, {}, now).reason, 'not_configured');
});

test('readRawBody reads the stream once, takes a Buffer or string, and refuses an over-size body', async () => {
  assert.equal((await readRawBody(rawReq('{"x":1}'))).toString(), '{"x":1}');
  assert.equal((await readRawBody({ body: '{"y":2}' })).toString(), '{"y":2}');
  assert.equal(await readRawBody({ body: { parsed: true } }), null, 'a parsed object cannot be verified');
  await assert.rejects(readRawBody(rawReq('x'.repeat(50)), { maxBytes: 10 }), /too large/);
});

test('hooks: unsigned, wrongly signed and unconfigured events are refused and logged without the payload', async () => {
  const w = await world();
  const logs = [];
  const warn = console.warn;
  console.warn = (...a) => logs.push(a.join(' '));
  try {
    const payload = { action: 'closed', repository: { full_name: REPO }, pull_request: { number: 7, merged: true, title: 'SECRET-PAYLOAD-MARKER' } };
    const raw = JSON.stringify(payload);
    assert.equal((await ghHook('pull_request', payload, w, { headers: { 'x-github-event': 'pull_request' } })).statusCode, 401);
    assert.equal((await ghHook('pull_request', payload, w, { headers: ghHeaders('pull_request', raw, 'wrong') })).statusCode, 401);
    assert.equal((await vcHook({ type: 'deployment.succeeded', payload: { deployment: { id: 'dpl_abcdef123' } } }, w, { headers: {} })).statusCode, 401);
    const labRes = makeRes();
    await createLabHookHandler()(rawReq('{"experiment_id":"x"}', { 'x-pg1-timestamp': '1800000000', 'x-pg1-signature': `sha256=${'0'.repeat(64)}` }), labRes);
    assert.equal(labRes.statusCode, 401);
    delete process.env.GITHUB_WEBHOOK_SECRET;
    assert.equal((await ghHook('pull_request', payload, w)).statusCode, 503, 'no secret: refused, never accepted unsigned');
    const getRes = makeRes();
    await createGithubHookHandler()({ method: 'GET', headers: {} }, getRes);
    assert.equal(getRes.statusCode, 405);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(logs.filter((l) => l.startsWith('[hooks]')), [
    '[hooks] rejected source=github reason=unsigned',
    '[hooks] rejected source=github reason=bad_signature',
    '[hooks] rejected source=vercel reason=unsigned',
    '[hooks] rejected source=lab reason=bad_signature',
    '[hooks] rejected source=github reason=not_configured'
  ]);
  assert.ok(logs.every((l) => !l.includes('SECRET-PAYLOAD-MARKER') && !l.includes(GH_SECRET)), 'no payload or secret in the log');
  assert.equal((await rows(w.db, 'select count(*)::int as n from public.pg1_watch_reports'))[0].n, 0);
});

// --- lab: start → watched → webhook → report in the origin thread, with a push --------

test('lab: /lab start is watched for its thread; the workflow_run webhook syncs it at once and reports what happened, the result, the cost and the next step, with a push', async () => {
  const w = await world();
  await addDevice(w.store);
  const start = await chat({ prompt: '/lab start check NVD licence terms', threadKey: THREAD });
  assert.match(start.jsonBody.reply, /^Lab experiment [0-9a-f]{8} queued .*I will post a report here when it finishes\.$/);
  const [watch] = await rows(w.db, 'select * from public.pg1_watches');
  assert.equal(watch.target_type, 'lab');
  assert.equal(watch.origin_thread, THREAD);
  assert.equal(watch.source, 'auto');
  assert.equal(watch.last_state, 'queued');
  const { id, run } = finishLab(w.gh, {});
  const res = await ghHook('workflow_run', { action: 'completed', repository: { full_name: REPO }, workflow_run: run }, w);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonBody, { ok: true, handled: 1, reported: 1 });
  const [exp] = await rows(w.db, `select status, spent_usd::float as spent from public.pg1_lab_experiments where id = '${id}'`);
  assert.deepEqual(exp, { status: 'done', spent: 0.37 }, 'the experiment was synced by the webhook, not by /lab status');
  const [report] = await rows(w.db, 'select * from public.pg1_watch_reports');
  assert.equal(report.origin_thread, THREAD);
  assert.equal(report.state, 'done');
  assert.match(report.body, /\*\*What happened\*\*: lab experiment [0-9a-f]{8} \(research: check NVD licence terms\) finished\./);
  assert.match(report.body, /\*\*Result\*\*: done\. NVD allows commercial reuse of CVE records\./);
  assert.match(report.body, /\*\*Cost\*\*: \$0\.37 of its \$2\.00 budget\./);
  assert.match(report.body, /\*\*Next step\*\*: Read the report\./);
  assert.deepEqual(report.actions, [{ label: `Lab report ${id.slice(0, 8)}`, command: `/lab report ${id.slice(0, 8)}`, confirm: false, kind: 'command' }]);
  const [closed] = await rows(w.db, 'select status, last_state from public.pg1_watches');
  assert.deepEqual(closed, { status: 'done', last_state: 'done' });
  assert.equal(w.pushes.length, 1);
  assert.equal(w.pushes[0].payload.title, `Lab ${id.slice(0, 8)}: done`);
  assert.match(w.pushes[0].payload.url, new RegExp(`^/\\?report=[0-9a-f-]{36}&thread=${THREAD}$`));
  assert.equal(w.pushes[0].opts.vapidDetails.publicKey, process.env.VAPID_PUBLIC_KEY);
  // The same delivery again (GitHub retries): no second report or push.
  await ghHook('workflow_run', { action: 'completed', repository: { full_name: REPO }, workflow_run: run }, w);
  assert.equal((await rows(w.db, 'select count(*)::int as n from public.pg1_watch_reports'))[0].n, 1);
  assert.equal(w.pushes.length, 1);
  const [log] = await rows(w.db, `select decision, outcome from public.pg1_autonomy_log where action = 'watch:report'`);
  assert.deepEqual(log, { decision: 'allowed', outcome: 'done' });
});

test('lab notice: the notify job\'s own script signs a notice that /api/hooks/lab accepts; PG1 syncs and reports the experiment', async () => {
  const w = await world();
  await chat({ prompt: '/lab start compare two CVE feeds', threadKey: THREAD });
  const { id, runId } = finishLab(w.gh, {});
  // Run the exact script from lab.yml with a stand-in fetch.
  const yml = readFileSync(`${ROOT}.github/workflows/lab.yml`, 'utf8');
  const notify = yml.slice(yml.indexOf('\n  notify:'));
  const script = /node -e '([\s\S]*?)'\n/.exec(notify)[1];
  let sent = null;
  const fakeFetch = async (url, init) => { sent = { url, init }; return { status: 200 }; };
  const fakeProcess = { env: { PG1_URL: 'https://pg1.example/', PG1_LAB_DISPATCH_SECRET: LAB_SECRET, LAB_ID: id, RUN_ID: String(runId), EXPERIMENT_RESULT: 'success' }, exit() { throw new Error('exited'); } };
  new Function('require', 'process', 'fetch', 'console', script)((m) => (m === 'crypto' ? crypto : null), fakeProcess, fakeFetch, { log() {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.url, 'https://pg1.example/api/hooks/lab');
  assert.deepEqual(JSON.parse(sent.init.body), { experiment_id: id, run_id: runId, conclusion: 'success' });
  const res = makeRes();
  let pending = null;
  await createLabHookHandler({ webpushImpl: w.webpush, waitUntil: (p) => { pending = p; } })(rawReq(sent.init.body, { 'x-pg1-timestamp': sent.init.headers['X-PG1-Timestamp'], 'x-pg1-signature': sent.init.headers['X-PG1-Signature'] }), res);
  assert.equal(res.statusCode, 202, 'answered at once; the sync runs after the answer');
  assert.deepEqual(await pending, { status: 'done', reported: true });
  assert.equal((await rows(w.db, `select status from public.pg1_lab_experiments where id = '${id}'`))[0].status, 'done');
  assert.equal((await rows(w.db, 'select count(*)::int as n from public.pg1_watch_reports'))[0].n, 1);
  // Unset PG1_URL: the step sends nothing.
  sent = null;
  assert.throws(() => new Function('require', 'process', 'fetch', 'console', script)(() => crypto, { ...fakeProcess, env: { ...fakeProcess.env, PG1_URL: '' } }, fakeFetch, { log() {} }), /exited/);
  assert.equal(sent, null);
});

test('lab notice: a still-running run is retried until GitHub shows it completed; a bad id is refused', async () => {
  const w = await world();
  await chat({ prompt: '/lab start long research', threadKey: THREAD });
  const { id, runId } = finishLab(w.gh, {});
  w.gh.runs.get(runId).status = 'in_progress';
  let sleeps = 0;
  const body = JSON.stringify({ experiment_id: id, run_id: runId, conclusion: 'success' });
  const s = signLabCallback(body, LAB_SECRET);
  const res = makeRes();
  await createLabHookHandler({ webpushImpl: w.webpush, sleep: async () => { if (++sleeps === 2) w.gh.runs.get(runId).status = 'completed'; } })(rawReq(body, { 'x-pg1-timestamp': s.timestamp, 'x-pg1-signature': s.signature }), res);
  assert.deepEqual(res.jsonBody, { ok: true, status: 'done', reported: true });
  assert.equal(sleeps, 2);
  const bad = JSON.stringify({ experiment_id: '../etc' });
  const s2 = signLabCallback(bad, LAB_SECRET);
  const res2 = makeRes();
  await createLabHookHandler()(rawReq(bad, { 'x-pg1-timestamp': s2.timestamp, 'x-pg1-signature': s2.signature }), res2);
  assert.equal(res2.statusCode, 400);
});

// --- PRs, check suites, workflow runs ------------------------------------------------

test('PR: a PR PG1 opens is watched; check_suite reports CI (failing checks named), pull_request reports the merge and closes the watch', async () => {
  const w = await world();
  const { store } = w;
  const r = await autoWatch({ supUrl: 'https://supabase.test', supKey: 'k', type: 'pr', id: `${REPO}#42`, label: 'PR #42 Fix x', originThread: THREAD });
  assert.equal(r.ok, true);
  w.gh.pulls.set(`${REPO}#42`, { number: 42, title: 'Fix x', html_url: `https://github.com/${REPO}/pull/42`, state: 'open', merged: false, head: { sha: 'abc42' } });
  w.gh.checks.set('abc42', [{ name: 'npm test', status: 'completed', conclusion: 'failure' }, { name: 'browser tests', status: 'completed', conclusion: 'success' }]);
  const suite = { action: 'completed', repository: { full_name: REPO }, check_suite: { conclusion: 'failure', head_sha: 'abc42', app: { name: 'GitHub Actions' }, pull_requests: [{ number: 42 }] } };
  assert.deepEqual((await ghHook('check_suite', suite, w)).jsonBody, { ok: true, handled: 1, reported: 1 });
  let reports = await rows(w.db, 'select state, title, body, actions from public.pg1_watch_reports order by created_at');
  assert.equal(reports[0].state, 'ci_failure');
  assert.equal(reports[0].title, 'PR #42 failed CI');
  assert.match(reports[0].body, /\*\*Result\*\*: failing: npm test\./);
  assert.deepEqual(reports[0].actions, [{ label: 'Open PR', url: `https://github.com/${REPO}/pull/42`, kind: 'link' }]);
  assert.equal((await store.openFor('pr', `${REPO}#42`)).status, 'open', 'a CI result does not end a PR watch');
  // Not watched: nothing.
  assert.deepEqual((await ghHook('pull_request', { action: 'closed', repository: { full_name: REPO }, pull_request: { number: 99, merged: true } }, w)).jsonBody, { ok: true, handled: 0, reported: 0 });
  // Merged.
  await ghHook('pull_request', { action: 'closed', repository: { full_name: REPO }, pull_request: { number: 42, merged: true, title: 'Fix x', html_url: `https://github.com/${REPO}/pull/42` } }, w);
  reports = await rows(w.db, 'select state, body from public.pg1_watch_reports order by created_at');
  assert.deepEqual(reports.map((x) => x.state), ['ci_failure', 'merged']);
  assert.match(reports[1].body, /\*\*Next step\*\*: Nothing to do; the change is in\./);
  assert.equal(await store.openFor('pr', `${REPO}#42`), null);
});

test('workflow run: a watched run reports when it completes; an in-progress event does not', async () => {
  const w = await world();
  await autoWatch({ supUrl: 'https://supabase.test', supKey: 'k', type: 'workflow_run', id: `${REPO}@777`, originThread: THREAD });
  const run = { id: 777, name: 'Tests', status: 'in_progress', conclusion: null, html_url: `https://github.com/${REPO}/actions/runs/777` };
  assert.equal((await ghHook('workflow_run', { action: 'in_progress', repository: { full_name: REPO }, workflow_run: run }, w)).jsonBody.reported, 0);
  assert.equal((await ghHook('workflow_run', { action: 'completed', repository: { full_name: REPO }, workflow_run: { ...run, status: 'completed', conclusion: 'failure' } }, w)).jsonBody.reported, 1);
  const [rep] = await rows(w.db, 'select title, actions from public.pg1_watch_reports');
  assert.equal(rep.title, 'Workflow run 777 ended: failure');
  assert.equal(rep.actions[0].url, `https://github.com/${REPO}/actions/runs/777`);
});

// --- deploys ----------------------------------------------------------------------

test('deploys: a production deploy is watched automatically and reported when it ends; a preview deploy nobody watches is not', async () => {
  const w = await world();
  await addDevice(w.store);
  const created = { type: 'deployment.created', payload: { target: 'production', deployment: { id: 'dpl_Prod12345', name: 'pg1-ai-agent' } } };
  assert.deepEqual((await vcHook(created, w)).jsonBody, { ok: true, handled: 1, reported: 0 });
  const [watch] = await rows(w.db, 'select target_type, target_id, source, last_state, origin_thread from public.pg1_watches');
  assert.deepEqual(watch, { target_type: 'deploy', target_id: 'dpl_Prod12345', source: 'auto', last_state: 'building', origin_thread: null });
  assert.deepEqual((await vcHook({ ...created, type: 'deployment.error' }, w)).jsonBody, { ok: true, handled: 1, reported: 1 });
  const [rep] = await rows(w.db, 'select title, body from public.pg1_watch_reports');
  assert.equal(rep.title, 'Production deploy failed');
  assert.match(rep.body, /\*\*Next step\*\*: Open the deployment's build log and fix the error before deploying again\./);
  assert.doesNotMatch(rep.body + w.pushes[0].payload.body + w.pushes[0].payload.title, /vercel/i, 'white label: no provider name');
  // Preview deploy: not watched, nothing reported.
  assert.deepEqual((await vcHook({ type: 'deployment.succeeded', payload: { target: null, deployment: { id: 'dpl_Preview999' } } }, w)).jsonBody, { ok: true, handled: 0, reported: 0 });
  assert.equal((await rows(w.db, 'select count(*)::int as n from public.pg1_watches'))[0].n, 1);
});

// --- the cron, expiry and the kill switch ---------------------------------------------

test('cron: a change a webhook missed is reported by the re-sync; expired watches close; it needs CRON_SECRET', async () => {
  const w = await world();
  const { store } = w;
  await autoWatch({ supUrl: 'https://supabase.test', supKey: 'k', type: 'pr', id: `${REPO}#5`, originThread: THREAD });
  await store.create({ type: 'workflow_run', id: `${REPO}@1`, now: Date.now() - 3 * 24 * 3600 * 1000 });
  w.gh.pulls.set(`${REPO}#5`, { number: 5, title: 'Docs', html_url: `https://github.com/${REPO}/pull/5`, state: 'closed', merged: true, merged_at: '2026-10-14T00:00:00Z', head: { sha: 's5' } });
  const unauth = makeRes();
  await syncCron({ method: 'GET', headers: {} }, unauth);
  assert.equal(unauth.statusCode, 401);
  const res = makeRes();
  await syncCron({ method: 'GET', headers: { authorization: `Bearer ${CRON}` } }, res);
  assert.equal(res.statusCode, 200);
  const byType = Object.fromEntries(res.jsonBody.watches.map((x) => [x.type, x]));
  assert.equal(byType.pr.reported, true);
  assert.equal(byType.workflow_run.expired, true);
  assert.deepEqual((await rows(w.db, 'select target_type, status from public.pg1_watches order by target_type')), [{ target_type: 'pr', status: 'done' }, { target_type: 'workflow_run', status: 'expired' }]);
});

test('kill switch: with PG1_AUTONOMY=off nothing is watched automatically and reports are held, then sent once autonomy is back on', async () => {
  const w = await world();
  process.env.PG1_AUTONOMY = 'off';
  assert.equal(authorize('watch:auto', { actor: 'pg1', mode: 'off' }).allowed, false);
  assert.equal(authorize('watch:report', { actor: 'pg1', mode: 'lab' }).allowed, true, 'lab mode (the default) still reports');
  assert.equal((await autoWatch({ supUrl: 'https://supabase.test', supKey: 'k', type: 'deploy', id: 'dpl_Off123456' })).ok, false);
  assert.equal((await rows(w.db, `select count(*)::int as n from public.pg1_watches`))[0].n, 0);
  const [denied] = await rows(w.db, `select decision from public.pg1_autonomy_log where action = 'watch:auto'`);
  assert.equal(denied.decision, 'denied');
  // A watch the operator asked for while off: the report waits.
  await w.store.create({ type: 'pr', id: `${REPO}#8`, originThread: THREAD });
  await ghHook('pull_request', { action: 'closed', repository: { full_name: REPO }, pull_request: { number: 8, merged: true } }, w);
  assert.equal((await rows(w.db, 'select count(*)::int as n from public.pg1_watch_reports'))[0].n, 0);
  assert.equal((await w.store.openFor('pr', `${REPO}#8`)).last_state, null, 'the state is not advanced, so it is reported later');
  delete process.env.PG1_AUTONOMY;
  w.gh.pulls.set(`${REPO}#8`, { number: 8, state: 'closed', merged: true, head: { sha: 's8' } });
  await resyncWatches({ supUrl: 'https://supabase.test', supKey: 'k', webpushImpl: w.webpush });
  assert.equal((await rows(w.db, `select state from public.pg1_watch_reports`))[0].state, 'merged');
});

// --- push --------------------------------------------------------------------------

test('push: notification text has no secret, key shape, wallet, link or provider name; a gone device is removed', async () => {
  process.env.SOME_SERVICE_TOKEN = 'live-value-' + 'q'.repeat(24);
  const t = notificationText(`Deploy on Vercel failed: token ${process.env.SOME_SERVICE_TOKEN} see https://vercel.com/x wallet 0x${'ab'.repeat(20)} sk-ant-${'z'.repeat(40)}`, 140);
  assert.doesNotMatch(t, /vercel|https?:|live-value|sk-ant|0xabab/i);
  assert.ok(t.length <= 140);
  const w = await world();
  await addDevice(w.store, 1);
  await addDevice(w.store, 2);
  w.webpush.gone.add('https://push.example/device-2');
  const sent = await pushToOperator({ store: w.store, title: 'PR #1: merged', body: 'Docs', url: 'https://elsewhere.example/', webpushImpl: w.webpush });
  assert.equal(sent, 1);
  assert.deepEqual((await rows(w.db, 'select endpoint from public.pg1_push_subscriptions')).map((r) => r.endpoint), ['https://push.example/device-1']);
  assert.equal(w.pushes[0].payload.url, '/', 'a URL that is not a plain path is replaced');
  delete process.env.VAPID_PRIVATE_KEY;
  assert.equal(await pushToOperator({ store: w.store, title: 'x', body: 'y', webpushImpl: w.webpush }), 0, 'no VAPID pair: nothing sent');
});

test('reports: every type says what happened, the result, the cost and the next step; buttons are real commands or GitHub links', () => {
  const cases = [
    [{ target_type: 'lab', target_id: '11111111-2222-4333-8444-555555555555' }, { state: 'failed', info: { exp: { kind: 'code', goal: 'g', spent_usd: 1.2, budget_usd: 2, error: 'tests failed', candidate: null } } }],
    [{ target_type: 'pr', target_id: `${REPO}#3` }, { state: 'ci_success', info: {} }],
    [{ target_type: 'workflow_run', target_id: `${REPO}@9` }, { state: 'success', info: {} }],
    [{ target_type: 'deploy', target_id: 'dpl_abcdef123' }, { state: 'ready', info: { target: 'production' } }]
  ];
  for (const [watch, snap] of cases) {
    const r = composeReport(watch, snap);
    for (const part of ['What happened', 'Result', 'Cost', 'Next step']) assert.match(r.body, new RegExp(`\\*\\*${part}\\*\\*: \\S`), `${watch.target_type}: ${part}`);
    assert.ok(r.title.length <= 120);
    for (const a of r.actions) assert.ok((a.kind === 'link' && /^https:\/\/github\.com\//.test(a.url)) || (a.command && a.command.startsWith('/')), JSON.stringify(a));
  }
  const failed = composeReport(...cases[0]);
  assert.match(failed.body, /\*\*Cost\*\*: \$1\.20 of its \$2\.00 budget\./);
  assert.match(failed.body, /\*\*Result\*\*: failed\. tests failed/);
});

test('sources: events and CI read as states', () => {
  assert.equal(fromGithubEvent('workflow_run', { repository: { full_name: REPO }, workflow_run: { id: 1, name: 'lab 11111111-2222-4333-8444-555555555555', status: 'completed', conclusion: 'success' } }).labId, '11111111-2222-4333-8444-555555555555');
  assert.equal(fromGithubEvent('workflow_run', { repository: { full_name: 'bad repo' }, workflow_run: { id: 1 } }).items.length, 0);
  assert.equal(fromGithubEvent('pull_request', { action: 'synchronize', repository: { full_name: REPO }, pull_request: { number: 1 } }).items.length, 0);
  assert.equal(fromVercelEvent({ type: 'deployment.succeeded', payload: { deployment: { id: 'not-an-id' } } }), null);
  assert.equal(fromVercelEvent({ type: 'deployment.succeeded', payload: { target: 'production', deployment: { id: 'dpl_abcdef1' } } }).production, true);
  assert.equal(ciState([]).state, 'open');
  assert.equal(ciState([{ name: 'a', status: 'in_progress' }]).state, 'ci_pending');
  assert.equal(ciState([{ name: 'a', status: 'completed', conclusion: 'success' }, { name: 'b', status: 'completed', conclusion: 'skipped' }]).state, 'ci_success');
});

// --- the chat ---------------------------------------------------------------------

test('chat: "watch it" (typed or spoken) watches the thing just discussed; with nothing discussed PG1 says so and watches nothing', async () => {
  for (const t of ['watch it', 'Monitor it.', 'PG1, tell me when it\'s done', 'let me know when it finishes', 'keep an eye on it please', 'tell me when the PR is merged']) assert.equal(isWatchRequest(t), true, t);
  for (const t of ['what should I watch tonight?', 'watch it and also write a long essay about everything that happened today in the lab please', '/watch']) assert.equal(isWatchRequest(t), false, t);
  assert.deepEqual(subjectFrom({ text: 'watch it', history: [{ role: 'assistant', text: `PR opened: https://github.com/${REPO}/pull/12` }, { role: 'user', text: 'thanks' }] }), { type: 'pr', id: `${REPO}#12`, at: 11, labPrefix: false });
  assert.equal(referencesIn('deploy dpl_Abc123456 done')[0].id, 'dpl_Abc123456');

  const w = await world();
  const none = await chat({ prompt: 'tell me when it\'s done', threadKey: THREAD, history: [{ role: 'user', text: 'hello' }] });
  assert.match(none.jsonBody.reply, /^I am not watching anything yet: I cannot tell what "it" is/);
  assert.equal((await rows(w.db, 'select count(*)::int as n from public.pg1_watches'))[0].n, 0);

  const pr = await chat({ prompt: 'watch it', threadKey: THREAD, history: [{ role: 'assistant', text: `Draft PR: https://github.com/${REPO}/pull/12` }] });
  assert.match(pr.jsonBody.reply, /^Watching PR Project-Gifted1\/pg1-ai-agent#12 \(watch [0-9a-f]{8}\)\. I will post a report in this chat when its CI finishes and when it is merged or closed\. No device has push notifications on yet/);
  const [row] = await rows(w.db, 'select target_type, target_id, origin_thread, source, report_on from public.pg1_watches');
  assert.deepEqual(row, { target_type: 'pr', target_id: `${REPO}#12`, origin_thread: THREAD, source: 'operator', report_on: 'changes' });
  assert.match((await chat({ prompt: 'monitor it', threadKey: THREAD, history: [{ role: 'assistant', text: `https://github.com/${REPO}/pull/12` }] })).jsonBody.reply, /^Already watching/);
  // A guest's "watch it" never reaches the watch table.
  globalThis.fetch = ((inner) => async (u, o) => (String(u).includes('generativelanguage') ? Response.json({ candidates: [{ content: { parts: [{ text: 'Sure.' }] }, finishReason: 'STOP' }] }) : inner(u, o)))(globalThis.fetch);
  process.env.GEMINI_API_KEY_PAID = 'stub-paid-key';
  await chat({ prompt: 'watch it', history: [{ role: 'assistant', text: `https://github.com/${REPO}/pull/13` }] }, { user: '', pass: '' });
  assert.equal((await rows(w.db, 'select count(*)::int as n from public.pg1_watches'))[0].n, 1);
});

test('chat: "watch it" after a lab start resolves the experiment; a finished one is not watched; /watch list and /watch stop', async () => {
  const w = await world();
  await chat({ prompt: '/lab start draft a digest', threadKey: THREAD });
  const id = w.gh.dispatches[0].inputs.experiment_id;
  await w.db.query(`update public.pg1_watches set status = 'stopped'`);
  const watched = await chat({ prompt: 'tell me when the experiment is done', threadKey: THREAD, history: [{ role: 'assistant', text: `Lab experiment ${id.slice(0, 8)} queued (research, budget $2.00).` }] });
  assert.match(watched.jsonBody.reply, new RegExp(`^Watching Lab experiment ${id.slice(0, 8)}: draft a digest \\(watch [0-9a-f]{8}\\)`));
  const list = await chat({ prompt: '/watch list' });
  assert.match(list.jsonBody.reply, new RegExp(`^### \\[ WATCHES \\]\\n- ([0-9a-f]{8}) · Lab experiment ${id.slice(0, 8)}: draft a digest · lab · last seen queued · asked · until `));
  const wid = /- ([0-9a-f]{8}) ·/.exec(list.jsonBody.reply)[1];
  assert.match((await chat({ prompt: `/watch stop ${wid}` })).jsonBody.reply, /^Stopped watching Lab experiment/);
  assert.equal((await rows(w.db, `select count(*)::int as n from public.pg1_watches where status = 'open'`))[0].n, 0);
  assert.match((await chat({ prompt: `/watch stop ${wid}` })).jsonBody.reply, /is already stopped/);
  assert.match((await chat({ prompt: '/watch stop ffffffff' })).jsonBody.reply, /^There is no watch ffffffff/);
  await w.db.query(`update public.pg1_lab_experiments set status = 'done'`);
  assert.match((await chat({ prompt: `/watch lab ${id.slice(0, 8)}` })).jsonBody.reply, /has already finished \(done\), so there is nothing to watch/);
  assert.equal((await chat({ prompt: '/watch list' }, { user: '', pass: '' })).statusCode, 401);
});

test('PRs PG1 opens: every path that opens one watches it for the thread, and says so only when the watch was written', async () => {
  const w = await world();
  const src = readFileSync(`${ROOT}api/chat.mjs`, 'utf8');
  assert.equal((src.match(/fetch\(`\$\{[A-Za-z]+\}\/pulls`/g) || []).length, 5, 'five places open a PR');
  assert.equal((src.match(/await watchOpenedPr\(/g) || []).length, 5, 'each one watches it');
  assert.match(src, /return watched\.ok \? '\\n\\nWatching this PR/);
  const r = await autoWatch({ supUrl: 'https://supabase.test', supKey: 'k', type: 'pr', id: `${REPO}#77`, originThread: THREAD, label: 'PR #77 Approved: README.md' });
  assert.equal(r.ok, true);
  assert.equal((await w.store.openFor('pr', `${REPO}#77`)).origin_thread, THREAD);
});

// --- the page API -------------------------------------------------------------------

test('api/watches: operator only; inbox returns undelivered reports for the thread (and thread-less ones) once; push subscribe validates', async () => {
  const w = await world();
  assert.equal((await api({ op: 'inbox' }, { user: '', pass: '' })).statusCode, 401);
  assert.equal((await api({ op: 'inbox' }, { user: 'test-operator', pass: 'wrong' })).statusCode, 401);
  await autoWatch({ supUrl: 'https://supabase.test', supKey: 'k', type: 'pr', id: `${REPO}#1`, originThread: THREAD });
  await autoWatch({ supUrl: 'https://supabase.test', supKey: 'k', type: 'pr', id: `${REPO}#2`, originThread: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  await autoWatch({ supUrl: 'https://supabase.test', supKey: 'k', type: 'deploy', id: 'dpl_Global1234' });
  for (const n of [1, 2]) await ghHook('pull_request', { action: 'closed', repository: { full_name: REPO }, pull_request: { number: n, merged: false } }, w);
  await vcHook({ type: 'deployment.succeeded', payload: { target: 'production', deployment: { id: 'dpl_Global1234' } } }, w);
  const inbox = await api({ op: 'inbox', threadKeys: [THREAD, 'not-a-key'] });
  assert.equal(inbox.statusCode, 200);
  assert.deepEqual(inbox.jsonBody.reports.map((r) => r.target_id).sort(), [`${REPO}#1`, 'dpl_Global1234']);
  const ack = await api({ op: 'ack', ids: inbox.jsonBody.reports.map((r) => r.id) });
  assert.equal(ack.jsonBody.acknowledged, 2);
  assert.equal((await api({ op: 'inbox', threadKeys: [THREAD] })).jsonBody.reports.length, 0, 'shown once');
  assert.equal((await api({ op: 'vapid' })).jsonBody.publicKey, process.env.VAPID_PUBLIC_KEY);
  assert.equal((await api({ op: 'subscribe', subscription: { endpoint: 'http://insecure.example/x', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } } })).statusCode, 400);
  assert.equal(cleanSubscription({ endpoint: 'https://push.example/1', keys: { p256dh: 'not base64!', auth: 'a'.repeat(22) } }), null);
  assert.equal((await api({ op: 'subscribe', subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } } })).jsonBody.subscribed, true);
  assert.equal((await api({ op: 'subscribe', subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'C'.repeat(87), auth: 'b'.repeat(22) } } })).jsonBody.subscribed, true, 'the same device again updates its row');
  assert.deepEqual(await rows(w.db, 'select p256dh from public.pg1_push_subscriptions'), [{ p256dh: 'C'.repeat(87) }]);
  assert.equal((await api({ op: 'unsubscribe', endpoint: 'https://push.example/1' })).jsonBody.removed, 1);
});

// --- the migration, the page, the workflow and the cron schedule --------------------------

test('migration: RLS on, nothing for anon or authenticated, one open watch per target, no destructive statement', async () => {
  const sql = readFileSync(`${ROOT}supabase/migrations/20261028120000_pg1_watches.sql`, 'utf8');
  const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\b(?:drop\s+table|truncate|delete\s+from)\b/i);
  for (const t of ['pg1_watches', 'pg1_watch_reports', 'pg1_push_subscriptions']) {
    assert.match(code, new RegExp(`alter table public\\.${t} enable row level security;`));
    assert.match(code, new RegExp(`revoke all on public\\.${t} from public, anon, authenticated;`));
  }
  assert.doesNotMatch(code, /create policy|grant /i);
  const w = await world();
  await w.store.create({ type: 'deploy', id: 'dpl_Unique1234' });
  await assert.rejects(w.db.query(`insert into public.pg1_watches (target_type, target_id, expires_at) values ('deploy', 'dpl_Unique1234', now())`), /duplicate key/);
});

test('page: push opt-in switch, service worker, report inbox and the thread key on every message', () => {
  const html = readFileSync(`${ROOT}public/index.html`, 'utf8');
  assert.match(html, /id="push-btn" class="switch" role="switch"/);
  assert.match(html, /navigator\.serviceWorker\.register\('\/sw\.js'/);
  assert.match(html, /pushManager\.subscribe\(\{ userVisibleOnly: true, applicationServerKey/);
  assert.match(html, /op: 'inbox', threadKeys: keys/);
  assert.match(html, /threadKey: currentThreadKey\(\)/);
  assert.match(html, /rel="noopener noreferrer"/);
  const sw = readFileSync(`${ROOT}public/sw.js`, 'utf8');
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /addEventListener\('notificationclick'/);
  assert.doesNotMatch(sw, /addEventListener\('fetch'/, 'the worker never intercepts requests');
  const vercel = JSON.parse(readFileSync(`${ROOT}vercel.json`, 'utf8'));
  assert.ok(vercel.crons.some((c) => c.path === '/api/watches/sync' && c.schedule === '*/5 * * * *'));
});

test('lab.yml notify job: always runs last, only the dispatch secret, no write permission, no checkout', () => {
  const yml = readFileSync(`${ROOT}.github/workflows/lab.yml`, 'utf8');
  const notify = yml.slice(yml.indexOf('\n  notify:'));
  assert.match(notify, /needs: \[experiment, test, pull\]\n    if: always\(\)/);
  assert.deepEqual([...notify.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]), ['PG1_LAB_DISPATCH_SECRET']);
  assert.doesNotMatch(notify, /permissions:|: write|actions\/checkout|npm |github\.token/);
  assert.match(notify, /continue-on-error: true/);
});
