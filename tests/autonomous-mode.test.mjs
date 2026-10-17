/**
 * Autonomous mode (lib/autonomous/state.mjs, lib/autonomous/chat.mjs,
 * lib/autonomy.mjs, api/watches.mjs ops auto_*):
 *   1  one shared switch, stored server-side; a missing or unreachable
 *      table reads as OFF
 *   2  background work checks it: authorize() refuses PG1's own actions
 *      while it is off (safety actions still run)
 *   3  OFF: nothing new starts, queued actions are cancelled, a running one
 *      stops at its next checkpoint
 *   4  auto-off with an operator push: hourly limit, 3 failures in a row,
 *      the daily budget
 *   5  every action logged without secrets or personal data
 *   6  /auto on | off | status | log, operator only; the header's ops
 *
 * Run with: node --test tests/autonomous-mode.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAutonomousStore, runAutonomousAction, queueAutonomousAction, switchOff, switchOn, setLimits, scrub, ACTION_TYPES,
  refreshAutonomousSnapshot, __resetAutonomousSnapshot, autonomousSnapshot, AutonomousStopped
} from '../lib/autonomous/state.mjs';
import { handleAutoCommand, isAutoCommand } from '../lib/autonomous/chat.mjs';
import { authorize } from '../lib/autonomy.mjs';
import { createAutonomousDb } from './helpers/autonomousDb.mjs';

const SUP = 'https://auto-db.test';
beforeEach(() => { __resetAutonomousSnapshot(); });

function setup(opts = {}) {
  const db = createAutonomousDb(opts);
  const store = createAutonomousStore({ supUrl: SUP, supKey: 'service', fetchImpl: db.fetch });
  const pushes = [];
  const notify = async (p) => { pushes.push(p); };
  return { db, store, pushes, notify };
}

test('1: the switch lives server-side, shared by every caller; no table or no database reads as OFF', async () => {
  const { db, store } = setup();
  assert.equal((await store.getState()).enabled, false, 'OFF until the operator switches it on');
  await switchOn(store);
  const other = createAutonomousStore({ supUrl: SUP, supKey: 'service', fetchImpl: db.fetch });
  assert.equal((await other.getState()).enabled, true, 'another device / instance sees the same state');
  const missing = createAutonomousStore({ supUrl: SUP, supKey: 'service', fetchImpl: async () => new Response('{"code":"42P01"}', { status: 404 }) });
  const s = await missing.getState();
  assert.equal(s.enabled, false);
  assert.ok(s.error);
  assert.equal(autonomousSnapshot(), null, 'no table yet: the older PG1_AUTONOMY rule governs the rest');
  const down = createAutonomousStore({ supUrl: SUP, supKey: 'service', fetchImpl: async () => { throw new Error('network'); } });
  assert.equal((await down.getState()).enabled, false);
  assert.equal(autonomousSnapshot(), null, 'unreachable: Autonomous mode\'s own actions stay off (enabled false); the rest keep PG1_AUTONOMY\'s rule');
  assert.equal(await refreshAutonomousSnapshot({}), false, 'no database: OFF');
});

test('2: while OFF, authorize() refuses PG1\'s own actions (watch, lab, opportunities); safety actions and the operator still run', async () => {
  const { db, store } = setup();
  await switchOn(store);
  await refreshAutonomousSnapshot({ supUrl: SUP, supKey: 'service', fetchImpl: db.fetch });
  assert.equal(authorize('lab:ingest', { actor: 'pg1', mode: 'on' }).allowed, true);
  assert.equal(authorize('auto:feed_guardian', { actor: 'pg1', mode: 'lab' }).allowed, true, 'Autonomous capabilities run while ON, whatever PG1_AUTONOMY=lab says');
  assert.equal(authorize('auto:feed_guardian', { actor: 'pg1', mode: 'off' }).allowed, false, 'PG1_AUTONOMY=off still stops them');
  await switchOff(store);
  await refreshAutonomousSnapshot({ supUrl: SUP, supKey: 'service', fetchImpl: db.fetch });
  assert.equal(autonomousSnapshot(), false);
  for (const a of ['lab:ingest', 'lab:dispatch', 'opportunity:research', 'auto:feed_guardian']) {
    const d = authorize(a, { actor: 'pg1', mode: 'on' });
    assert.equal(d.allowed, false, a);
    assert.match(d.reason, /Autonomous mode is off/);
  }
  assert.equal(authorize('alert:operator', { actor: 'pg1', mode: 'on' }).allowed, true, 'safety still runs');
  assert.equal(authorize('watch:report', { actor: 'pg1', mode: 'on' }).allowed, true, 'telling the operator about a watch is not an action');
  assert.equal(authorize('command:/lab start', { actor: 'operator', mode: 'on' }).allowed, true, 'the operator\'s own commands still run');
  assert.equal(authorize('tool:check_wallet_age', { actor: 'external', mode: 'on' }).allowed, true, 'paying agents are not autonomous actions');
  __resetAutonomousSnapshot();
  assert.equal(authorize('lab:ingest', { actor: 'pg1', mode: 'on' }).allowed, true, 'an instance that never read the switch keeps PG1_AUTONOMY\'s rule');
  assert.equal(authorize('auto:feed_guardian', { actor: 'pg1', mode: 'on' }).allowed, false, 'but Autonomous capabilities need the switch read as ON');
});

test('3: OFF stops new actions, cancels queued ones and stops a running one at its next checkpoint', async () => {
  const { db, store } = setup();
  await switchOn(store);
  const queued = await queueAutonomousAction(store, { type: 'mission', reason: 'weekly check' });
  assert.equal(queued.status, 'queued');
  let steps = 0;
  const running = runAutonomousAction({
    store, type: 'feed_guardian', reason: 'scheduled',
    run: async ({ checkpoint }) => {
      steps++;
      await switchOff(store); // the operator taps OFF mid-run
      await checkpoint();
      steps++;
      return { ok: true, result: 'never reached' };
    }
  });
  const out = await running;
  assert.equal(out.status, 'stopped');
  assert.equal(steps, 1, 'stopped at the checkpoint');
  assert.equal(db.actions.find((r) => r.id === queued.id).status, 'cancelled');
  const later = await runAutonomousAction({ store, type: 'feed_guardian', run: async () => { throw new Error('must not run'); } });
  assert.equal(later.started, false);
  assert.equal(later.status, 'off');
  assert.ok(AutonomousStopped);
});

test('4: more than the hourly limit switches itself off and pushes the operator', async () => {
  const { store, pushes, notify } = setup();
  await switchOn(store);
  await setLimits(store, { maxPerHour: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await runAutonomousAction({ store, type: 'engine_watchdog', notify, run: async () => ({ ok: true, result: 'fine' }) })).status, 'done');
  const fourth = await runAutonomousAction({ store, type: 'engine_watchdog', notify, run: async () => ({ ok: true }) });
  assert.equal(fourth.status, 'auto_off');
  const s = await store.getState();
  assert.equal(s.enabled, false);
  assert.equal(s.changed_by, 'auto_off');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].body, /More than 3 autonomous actions in an hour/);
});

test('4: three failures of the same action type in a row switch it off', async () => {
  const { store, pushes, notify } = setup();
  await switchOn(store);
  for (let i = 0; i < 3; i++) await runAutonomousAction({ store, type: 'self_heal', notify, run: async () => ({ ok: false, result: 'CI still red' }) });
  assert.equal((await store.getState()).enabled, false);
  assert.match(pushes[0].body, /failed 3 times in a row/);
});

test('4: the daily budget: $0 by default refuses any paid estimate; a set budget switches off once used', async () => {
  const { db, store, pushes, notify } = setup();
  await switchOn(store);
  const paid = await runAutonomousAction({ store, type: 'mission', estimateUsd: 0.05, notify, run: async () => { throw new Error('must not run'); } });
  assert.equal(paid.status, 'refused');
  assert.match(db.actions.at(-1).result, /free tiers only/);
  await setLimits(store, { dailyBudgetUsd: 0.10 });
  const ok = await runAutonomousAction({ store, type: 'mission', estimateUsd: 0.05, notify, run: async () => ({ ok: true, result: 'done', costUsd: 0.10 }) });
  assert.equal(ok.status, 'done');
  assert.equal((await store.getState()).enabled, false, 'the day\'s budget is used: off');
  assert.match(pushes.at(-1).body, /budget of \$0\.10 is used up/);
});

test('5: the log keeps time, type, reason, inputs summary, result, cost and link, never a secret or personal data', async () => {
  const { db, store } = setup();
  await switchOn(store);
  await runAutonomousAction({
    store, type: 'self_heal', reason: 'deploy failed for gift@example.com', inputsSummary: 'error: token=ghp_abcdefghijklmnopqrstuvwxyz0123 call +353 87 123 4567',
    run: async () => ({ ok: true, result: 'Draft PR opened with key sk-ant-api03-abcdefghijklmnop', link: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/999', costUsd: 0 })
  });
  const row = db.actions.at(-1);
  for (const k of ['at', 'type', 'reason', 'inputs_summary', 'status', 'result', 'cost_usd', 'link']) assert.ok(k in row, k);
  const all = JSON.stringify(row);
  assert.doesNotMatch(all, /ghp_|sk-ant|gift@example\.com|353 87/);
  assert.match(all, /\[email\]/);
  assert.equal(row.link, 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/999');
  assert.equal(scrub('Bearer abcdefghijklmnopqrstuvwxyz'), '[secret]');
  const refused = await runAutonomousAction({ store, type: 'merge_to_main', run: async () => { throw new Error('never'); } });
  assert.equal(refused.status, 'refused', 'not on the allowlist');
  assert.ok(!Object.keys(ACTION_TYPES).some((t) => /merge|deploy|publish|email|post/.test(t)));
});

test('6: /auto on, status, log and off, operator only', async () => {
  const { db } = setup();
  const run = (text, isOperator = true) => handleAutoCommand({ text, isOperator, supUrl: SUP, supKey: 'service', fetchImpl: db.fetch });
  assert.equal(isAutoCommand('/auto on'), true);
  assert.equal(isAutoCommand('/autonomy'), false);
  assert.equal((await run('/auto on', false)).status, 401);
  assert.match((await run('/auto on')).reply, /Autonomous mode is \*\*ON\*\*/);
  assert.match((await run('/auto status')).reply, /AUTONOMOUS MODE: ON[\s\S]*Today: 0 autonomous actions/);
  const store = createAutonomousStore({ supUrl: SUP, supKey: 'service', fetchImpl: db.fetch });
  await runAutonomousAction({ store, type: 'feed_guardian', reason: 'scheduled', run: async () => ({ ok: true, result: 'feed healthy' }) });
  assert.match((await run('/auto log')).reply, /Feed guardian · done · scheduled → feed healthy/);
  assert.match((await run('/auto off')).reply, /Autonomous mode is \*\*OFF\*\*/);
  assert.match((await run('/auto limit 12')).reply, /more than 12 actions/);
  assert.match((await run('/auto budget 0')).reply, /free tiers only/);
  assert.doesNotMatch((await run('/auto status')).reply, /gemini|claude|anthropic|openai|groq/i);
});
