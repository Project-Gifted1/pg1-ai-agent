/**
 * PG1's first universe (world aba0e1ed-5d32-40c6-a1e2-ca876ba84a91) is only
 * ever improved in place: never deleted, retemplated or reset, by any route.
 *
 *   - by its id, even when it is not PG1's oldest world: /sandbox delete,
 *     /sandbox retemplate and the agents' delete_world tool all refuse, and
 *     the world, its tick and its inhabitants are unchanged;
 *   - PG1's oldest world is protected the same way (a deployment without
 *     that id);
 *   - /sandbox upgrade improves it and keeps its id, tick and inhabitants.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxStore, __resetSandboxMemory } from '../lib/sandbox/store.mjs';
import { createWorld, stepWorldFor, deleteWorldFor, pg1Principal } from '../lib/sandbox/worlds.mjs';
import { handleSandboxCommand } from '../lib/sandbox/chat.mjs';
import { callSandboxTool } from '../lib/sandbox/mcp.mjs';
import { sandboxUpgradeCommand } from '../lib/sandbox/upgrade.mjs';
import { FIRST_UNIVERSE_ID, isFirstUniverse } from '../lib/sandbox/first-universe.mjs';

beforeEach(() => __resetSandboxMemory());

// A store holding an older PG1 world first, then the first universe under its
// real id (so the id alone must protect it), stepped a little.
async function fixture() {
  let t = Date.UTC(2026, 10, 1);
  const store = createSandboxStore({ now: () => (t += 60000) });
  const pg1 = pg1Principal();
  const older = await createWorld(store, pg1, { name: 'Older meadow', template: 'meadow' });
  const make = store.createWorld.bind(store);
  store.createWorld = (row) => make({ ...row, id: FIRST_UNIVERSE_ID });
  const first = await createWorld(store, pg1, { name: 'Pg1-Universe', template: 'universe' });
  store.createWorld = make;
  assert.equal(first.id, FIRST_UNIVERSE_ID);
  await stepWorldFor(store, pg1, { world_id: first.id, steps: 6 });
  return { store, pg1, older, first: await store.getWorld(first.id) };
}

const inhabitants = (w) => ((w.state && w.state.entities) || []).filter((e) => ['person', 'cat', 'dog', 'rabbit', 'fox', 'horse', 'cow', 'goat', 'bird'].includes(e.kind) || /person|animal/.test(e.cls || '')).map((e) => e.id).sort();

test('the id and the rule', () => {
  assert.equal(FIRST_UNIVERSE_ID, 'aba0e1ed-5d32-40c6-a1e2-ca876ba84a91');
  assert.equal(isFirstUniverse({ id: FIRST_UNIVERSE_ID }), true);
  assert.equal(isFirstUniverse({ id: FIRST_UNIVERSE_ID.toUpperCase() }), true);
  assert.equal(isFirstUniverse({ id: 'b0000000-0000-0000-0000-000000000000' }), false);
  assert.equal(isFirstUniverse({ id: 'b1' }, { id: 'b1' }), true, 'PG1\'s oldest world too');
  assert.equal(isFirstUniverse(null), false);
});

test('by its id it is never deleted or retemplated, by the chat or by an agent\'s tool', async () => {
  const { store, pg1, older, first } = await fixture();
  const before = { tick: first.tick, people: inhabitants(first), name: first.name };
  assert.ok(before.people.length > 0, 'it has inhabitants');

  const del = await handleSandboxCommand({ text: `/sandbox delete ${FIRST_UNIVERSE_ID} confirm`, isOperator: true, store });
  assert.match(del.reply, /Not deleted: this is your first universe; it is kept/);
  const re = await handleSandboxCommand({ text: `/sandbox retemplate ${FIRST_UNIVERSE_ID} meadow confirm`, isOperator: true, store });
  assert.match(re.reply, /Not changed: this is your first universe/);
  await assert.rejects(deleteWorldFor(store, pg1, { world_id: FIRST_UNIVERSE_ID }), (e) => e.code === 'first_universe');
  const tool = await callSandboxTool(store, pg1, 'delete_world', { world_id: FIRST_UNIVERSE_ID });
  assert.equal(tool.error && tool.error.code, 'first_universe', 'the agents\' delete_world tool refuses');
  assert.equal(tool.error.status, 403);

  const after = await store.getWorld(FIRST_UNIVERSE_ID);
  assert.ok(after, 'still there');
  assert.equal(after.tick, before.tick, 'its tick is kept');
  assert.equal(after.name, before.name);
  assert.deepEqual(inhabitants(after), before.people, 'its inhabitants are kept');
  // The protection is for that world: the older one can still be retemplated (it is the oldest, so also kept from deletion).
  assert.ok(await store.getWorld(older.id));
});

test('PG1\'s oldest world is kept the same way, where that id is not in the store', async () => {
  let t = Date.UTC(2026, 10, 1);
  const store = createSandboxStore({ now: () => (t += 60000) });
  const pg1 = pg1Principal();
  const oldest = await createWorld(store, pg1, { name: 'First', template: 'meadow' });
  const newer = await createWorld(store, pg1, { name: 'Second', template: 'meadow' });
  await assert.rejects(deleteWorldFor(store, pg1, { world_id: oldest.id }), (e) => e.code === 'first_universe');
  const out = await deleteWorldFor(store, pg1, { world_id: newer.id });
  assert.equal(out.deleted, true, 'any other world can be deleted');
});

test('/sandbox upgrade improves it in place: the same id, tick and inhabitants', async () => {
  const { store, first } = await fixture();
  const before = { tick: first.tick, people: inhabitants(first) };
  const out = await sandboxUpgradeCommand(store, `${FIRST_UNIVERSE_ID} confirm`);
  assert.equal(out.status, 200);
  const after = await store.getWorld(FIRST_UNIVERSE_ID);
  assert.equal(after.id, FIRST_UNIVERSE_ID);
  assert.equal(after.tick, before.tick);
  assert.deepEqual(inhabitants(after), before.people);
});
