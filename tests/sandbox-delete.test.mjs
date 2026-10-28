/**
 * /sandbox delete <world-id> [confirm] (lib/sandbox/delete-command.mjs):
 * without confirm nothing is deleted; with confirm the world goes through
 * deleteWorldFor as pg1 and its black box (with the delete_world record)
 * is kept; another owner's world, a blind copy, a world with an active
 * run and PG1's oldest world are refused. /universe delete is the same.
 *
 * Run with: node --test tests/sandbox-delete.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxStore, __resetSandboxMemory } from '../lib/sandbox/store.mjs';
import { createWorld, inviteAgent, resolveSandboxKey, pg1Principal } from '../lib/sandbox/worlds.mjs';
import { startExperiment } from '../lib/sandbox/experiments.mjs';
import { handleSandboxCommand } from '../lib/sandbox/chat.mjs';
import { oldestPg1World } from '../lib/sandbox/delete-command.mjs';
import { meadowSpec } from '../lib/sandbox/templates.mjs';

beforeEach(() => { __resetSandboxMemory(); });

// A clock that moves a minute per call, so created_at orders the worlds.
function storeWithClock() {
  let t = Date.parse('2026-10-24T09:18:00Z');
  return createSandboxStore({ now: () => (t += 60000) });
}
const say = (store, text) => handleSandboxCommand({ text, isOperator: true, store });

async function threeWorlds(store) {
  const pg1 = pg1Principal();
  const first = await createWorld(store, pg1, { name: 'Pg1-Universe', spec: meadowSpec() });
  const second = await createWorld(store, pg1, { name: 'Pg1-Universe', spec: meadowSpec() });
  const third = await createWorld(store, pg1, { name: 'Pg1-Universe', spec: meadowSpec() });
  return { first, second, third };
}

test('without confirm it shows the world and deletes nothing', async () => {
  const store = storeWithClock();
  const { second } = await threeWorlds(store);
  const out = await say(store, `/sandbox delete ${second.id}`);
  assert.match(out.reply, new RegExp(second.id));
  assert.match(out.reply, /Pg1-Universe/);
  assert.match(out.reply, /tick 0 · in-world day 1 · created 2026-10-24/);
  assert.match(out.reply, /Simulation/);
  assert.match(out.reply, /repeat the command with confirm/);
  assert.match(out.reply, /Nothing has been deleted/);
  assert.ok(await store.getWorld(second.id), 'still there');
  assert.equal(out.deleted, undefined);
});

test('with confirm it deletes through deleteWorldFor as pg1, writes delete_world on the long chain and keeps the black box', async () => {
  const store = storeWithClock();
  const { second } = await threeWorlds(store);
  const before = await store.listBlackbox(second.id, { chain: 'long' });
  assert.ok(before.some((r) => r.action === 'create_world'));
  const out = await say(store, `/sandbox delete ${second.id} confirm`);
  assert.equal(out.deleted, true);
  assert.match(out.reply, /Deleted \*\*Pg1-Universe\*\*/);
  assert.match(out.reply, /black box was kept/);
  assert.equal(await store.getWorld(second.id), null);
  const after = await store.listBlackbox(second.id, { chain: 'long' });
  const del = after.find((r) => r.action === 'delete_world');
  assert.ok(del, 'the delete_world record is written');
  assert.equal(del.actor, 'pg1');
  assert.equal(del.actor_type, 'agent');
  assert.ok(after.some((r) => r.action === 'create_world'), 'earlier records are kept');
});

test('/universe delete works the same', async () => {
  const store = storeWithClock();
  const { third } = await threeWorlds(store);
  const look = await say(store, `/universe delete ${third.id}`);
  assert.match(look.reply, /Nothing has been deleted/);
  const out = await say(store, `/universe delete ${third.id} confirm`);
  assert.equal(out.deleted, true);
  assert.equal(await store.getWorld(third.id), null);
});

test('refuses PG1\'s oldest world, with the reason, even with confirm', async () => {
  const store = storeWithClock();
  const { first } = await threeWorlds(store);
  assert.equal((await oldestPg1World(store)).id, first.id);
  const out = await say(store, `/sandbox delete ${first.id} confirm`);
  assert.match(out.reply, /this is your first universe; it is kept/);
  assert.ok(await store.getWorld(first.id));
  assert.ok(!(await store.listBlackbox(first.id, { chain: 'long' })).some((r) => r.action === 'delete_world'));
});

test('refuses another owner\'s world, a blind copy and a world with an active experiment run', async () => {
  const store = storeWithClock();
  const { second, third } = await threeWorlds(store);
  // Another owner's world.
  const inv = await inviteAgent(store, { label: 'Visitor' });
  const who = await resolveSandboxKey(store, inv.key);
  const theirs = await createWorld(store, who, { name: 'Theirs', spec: meadowSpec() });
  const o1 = await say(store, `/sandbox delete ${theirs.id} confirm`);
  assert.match(o1.reply, /Only PG1's own worlds/);
  assert.ok(await store.getWorld(theirs.id));
  // An active run in a PG1 world, and its blind copy.
  const run = await startExperiment(store, { worldId: second.id, blind: true, clues: false, situation: 'You stand in a meadow. Find the fox.' });
  const o2 = await say(store, `/sandbox delete ${second.id} confirm`);
  assert.match(o2.reply, /experiment run is still active/);
  assert.ok(await store.getWorld(second.id));
  const o3 = await say(store, `/sandbox delete ${run.world_id} confirm`);
  assert.match(o3.reply, /blind run's copy/);
  assert.ok(await store.getWorld(run.world_id));
  // Bad input and the operator gate.
  assert.match((await say(store, '/sandbox delete nope confirm')).reply, /Usage/);
  const anon = await handleSandboxCommand({ text: `/sandbox delete ${third.id} confirm`, isOperator: false, store });
  assert.equal(anon.status, 401);
  assert.ok(await store.getWorld(third.id));
});

test('the short id /sandbox shows works too, when it names one of PG1\'s worlds', async () => {
  const store = storeWithClock();
  const { second } = await threeWorlds(store);
  const short = second.id.slice(0, 8);
  const look = await say(store, `/sandbox delete ${short}`);
  assert.match(look.reply, new RegExp(second.id));
  assert.match(look.reply, /Nothing has been deleted/);
  const out = await say(store, `/sandbox delete ${short} confirm`);
  assert.equal(out.deleted, true);
  assert.equal(await store.getWorld(second.id), null);
  assert.match((await say(store, '/sandbox delete abc confirm')).reply, /^Usage/, 'too short');
  assert.match((await say(store, '/sandbox delete 00000000 confirm')).reply, /No PG1 world has that id/);
});

test('a short id still never deletes PG1\'s oldest world', async () => {
  const store = storeWithClock();
  const { first } = await threeWorlds(store);
  const out = await say(store, `/sandbox delete ${first.id.slice(0, 8)} confirm`);
  assert.match(out.reply, /this is your first universe; it is kept/);
  assert.ok(await store.getWorld(first.id));
});
