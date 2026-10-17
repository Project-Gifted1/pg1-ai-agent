/**
 * Autonomous mode against a real Postgres (PGlite behind the PostgREST
 * stand-in), with the migrations as written:
 *   - pg1_autonomous_state, pg1_autonomous_actions and pg1_missions apply,
 *     with RLS on and nothing granted to anon or authenticated
 *   - the GitHub webhook queues self-healing for a failed CI run on the
 *     default branch only while the switch is ON (never for PG1's own
 *     self-heal-* branches); the Vercel webhook does the same for a failed
 *     production deploy
 *   - approval cards: listed, approved or rejected by the operator only; an
 *     approval applies nothing itself (a SQL proposal is recorded, a
 *     promotion hands back the chat command)
 *   - the daily briefing reaches the chat once (auto_inbox, auto_ack)
 *
 * Run with: node --test tests/autonomous-approvals.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { makeDb, pgRest } from './helpers/pgrest.mjs';
import { createAutonomousStore, switchOn, switchOff, __resetAutonomousSnapshot } from '../lib/autonomous/state.mjs';

const { createGithubHookHandler, createVercelHookHandler } = await import('../lib/watches/hooks.mjs');
const { createWatchesHandler, __clearWatchesRateLimitState } = await import('../api/watches.mjs');
const { __clearAuthRateLimitState } = await import('../api/chat.mjs');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const GH_SECRET = `gh-hook-${crypto.randomBytes(8).toString('hex')}`;
const VERCEL_SECRET = `vc-hook-${crypto.randomBytes(8).toString('hex')}`;
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const SUP = 'https://supabase.test';

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, USER_API_KEY: OPERATOR.user, USER_API_PASS: OPERATOR.pass, SUPABASE_URL: SUP, SUPABASE_SERVICE_ROLE_KEY: 'service-role-auto', GITHUB_WEBHOOK_SECRET: GH_SECRET, VERCEL_WEBHOOK_SECRET: VERCEL_SECRET };
  for (const k of ['GITHUB_TOKEN', 'VERCEL_TOKEN', 'PG1_AUTONOMY']) delete process.env[k];
  __resetAutonomousSnapshot();
  __clearAuthRateLimitState();
  __clearWatchesRateLimitState();
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

async function world() {
  const db = await makeDb(['20261028120000_pg1_watches.sql', '20261104120000_pg1_autonomous.sql', '20261105120000_pg1_missions.sql']);
  globalThis.fetch = pgRest(db, { passthrough: async () => null });
  const store = createAutonomousStore({ supUrl: SUP, supKey: 'service-role-auto' });
  return { db, store };
}
const rows = async (db, sql) => (await db.query(sql)).rows;

function makeRes() {
  return { statusCode: null, headers: {}, jsonBody: null, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write() { return true; }, end() { return this; }, on() {} };
}
function rawReq(raw, headers) {
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = headers;
  return req;
}
async function ghHook(event, payload) {
  const raw = JSON.stringify(payload);
  const res = makeRes();
  await createGithubHookHandler()(rawReq(raw, { 'x-github-event': event, 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', GH_SECRET).update(raw).digest('hex')}` }), res);
  return res;
}
async function vcHook(payload) {
  const raw = JSON.stringify(payload);
  const res = makeRes();
  await createVercelHookHandler()(rawReq(raw, { 'x-vercel-signature': crypto.createHmac('sha1', VERCEL_SECRET).update(raw).digest('hex') }), res);
  return res;
}
async function api(body, creds = OPERATOR) {
  const res = makeRes();
  await createWatchesHandler()({ method: 'POST', headers: {}, socket: { remoteAddress: '10.77.0.1' }, body: { ...creds, ...body } }, res);
  return res;
}
const failedRun = (branch = 'main', id = 4242) => ({ action: 'completed', repository: { full_name: 'Project-Gifted1/pg1-ai-agent', default_branch: 'main' }, workflow_run: { id, name: 'Tests', status: 'completed', conclusion: 'failure', head_branch: branch, html_url: `https://github.com/Project-Gifted1/pg1-ai-agent/actions/runs/${id}` } });

test('the migrations apply with RLS on and nothing granted to anon or authenticated', async () => {
  const { db } = await world();
  for (const t of ['pg1_autonomous_state', 'pg1_autonomous_actions', 'pg1_missions']) {
    const [r] = await rows(db, `select relrowsecurity from pg_class where relname = '${t}'`);
    assert.equal(r.relrowsecurity, true, `${t}: RLS on`);
    const grants = await rows(db, `select grantee from information_schema.role_table_grants where table_name = '${t}' and grantee in ('anon', 'authenticated')`);
    assert.deepEqual(grants, [], `${t}: no anon or authenticated grants`);
  }
  const [state] = await rows(db, 'select enabled, max_actions_per_hour, daily_budget_usd from pg1_autonomous_state');
  assert.deepEqual({ ...state, daily_budget_usd: Number(state.daily_budget_usd) }, { enabled: false, max_actions_per_hour: 30, daily_budget_usd: 0 }, 'OFF, 30 an hour, $0 by default');
});

test('webhooks queue self-healing only while ON, only for the default branch, never for PG1\'s own self-heal branches', async () => {
  const { db, store } = await world();
  assert.equal((await ghHook('workflow_run', failedRun())).statusCode, 200);
  assert.equal((await rows(db, 'select count(*)::int as n from pg1_autonomous_actions'))[0].n, 0, 'OFF: nothing queued');
  await switchOn(store);
  await ghHook('workflow_run', failedRun('main', 4242));
  await ghHook('workflow_run', failedRun('main', 4242));
  await ghHook('workflow_run', failedRun('feature-x', 4243));
  await ghHook('workflow_run', failedRun('self-heal-abc-1', 4244));
  await vcHook({ type: 'deployment.error', payload: { deployment: { id: 'dpl_abcdef123456', name: 'pg1-ai-agent' }, target: 'production' } });
  await vcHook({ type: 'deployment.error', payload: { deployment: { id: 'dpl_preview123456', name: 'pg1-ai-agent' }, target: 'preview' } });
  const queued = await rows(db, "select type, status, inputs_summary from pg1_autonomous_actions order by at");
  assert.deepEqual(queued.map((r) => [r.type, r.status]), [['self_heal', 'queued'], ['self_heal', 'queued']]);
  assert.match(queued[0].inputs_summary, /^ci Project-Gifted1\/pg1-ai-agent#run:4242 · Tests failure on main/);
  assert.match(queued[1].inputs_summary, /^deploy dpl_abcdef123456/);
  // OFF cancels what is queued.
  await switchOff(store);
  assert.deepEqual((await rows(db, 'select status from pg1_autonomous_actions')).map((r) => r.status), ['cancelled', 'cancelled']);
});

test('approval cards: operator only; approving applies nothing; a promotion hands back the chat command', async () => {
  const { db, store } = await world();
  const sqlCard = await store.insertAction({ type: 'feed_guardian', status: 'needs_approval', result: 'Feed anomaly', approval: { kind: 'sql_proposal', title: 'Remove 2 placeholder rows', detail: 'Dry run only.', sql: 'delete from public.threat_ioc_telemetry where false;' } });
  const promo = await store.insertAction({ type: 'lab_autopilot', status: 'needs_approval', result: '1 passed', approval: { kind: 'promote', title: 'Promote lab e2e2e2e2', detail: 'Passed its gate.', command: '/lab report e2e2e2e2' } });
  assert.equal((await api({ op: 'auto_approvals' }, { user: 'x', pass: 'y' })).statusCode, 401, 'guests are refused');
  const list = (await api({ op: 'auto_approvals' })).jsonBody.approvals;
  assert.deepEqual(list.map((c) => c.kind).sort(), ['promote', 'sql_proposal']);
  assert.match(list.find((c) => c.kind === 'sql_proposal').sql, /^delete from/);
  const a = await api({ op: 'auto_decide', id: sqlCard.id, decision: 'approve' });
  assert.equal(a.jsonBody.decision, 'approved');
  assert.match(a.jsonBody.message, /PG1 changes no data/);
  assert.equal(a.jsonBody.command, undefined);
  const p = await api({ op: 'auto_decide', id: promo.id, decision: 'approve' });
  assert.equal(p.jsonBody.command, '/lab report e2e2e2e2');
  assert.equal((await api({ op: 'auto_decide', id: promo.id, decision: 'reject' })).statusCode, 404, 'decided once');
  assert.deepEqual((await rows(db, 'select status from pg1_autonomous_actions order by at')).map((r) => r.status), ['approved', 'approved']);
});

test('the daily briefing reaches the chat once', async () => {
  const { store } = await world();
  await store.insertAction({ type: 'daily_briefing', status: 'done', result: 'summary', body: 'PG1 daily briefing · 2026-10-17\nAutonomous mode: ON.' });
  const inbox = (await api({ op: 'auto_inbox' })).jsonBody.reports;
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].body, /^PG1 daily briefing/);
  assert.equal((await api({ op: 'auto_ack', ids: [inbox[0].id] })).jsonBody.acknowledged, 1);
  assert.equal((await api({ op: 'auto_inbox' })).jsonBody.reports.length, 0);
});
