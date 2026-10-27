/**
 * /sandbox upgrade <world-id> [confirm] (lib/sandbox/upgrade.mjs): a
 * universe made before the road network (tests/fixtures/sandbox-universe-v1.json,
 * the template as it was), stepped 1,200 ticks, is upgraded in place:
 *   - without confirm nothing changes; with confirm it gains a connected
 *     road network and a runway (with a heading) for the island that had
 *     none, and one record on the black box long chain;
 *   - every inhabitant, family, country, treasury and research level is
 *     identical to before, and the tick is unchanged;
 *   - the land-and-sea, roads and flight checks pass for the next 2,000 steps;
 *   - other owners' worlds, blind copies and worlds past the limits are refused.
 *
 * Run with: node --test tests/sandbox-upgrade.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSandboxStore, __resetSandboxMemory } from '../lib/sandbox/store.mjs';
import { createWorld, stepWorldFor, pg1Principal, inviteAgent, resolveSandboxKey } from '../lib/sandbox/worlds.mjs';
import { handleSandboxCommand } from '../lib/sandbox/chat.mjs';
import { planUpgrade } from '../lib/sandbox/upgrade.mjs';
import { startExperiment } from '../lib/sandbox/experiments.mjs';
import { SANDBOX_LIMITS } from '../lib/sandbox/engine.mjs';
import { measureRun } from './helpers/sandboxMovement.mjs';

const V1 = JSON.parse(readFileSync(new URL('./fixtures/sandbox-universe-v1.json', import.meta.url), 'utf8'));
const say = (store, text) => handleSandboxCommand({ text, isOperator: true, store });
const LIVING = new Set(['person', 'child']);

test('a universe from before the roads, 1,200 ticks in: upgraded in place, its people and countries untouched, then 2,000 steps on land, sea and road', async () => {
  __resetSandboxMemory();
  const store = createSandboxStore();
  const pg1 = pg1Principal();
  const w = await createWorld(store, pg1, { name: 'Pg1-Universe', spec: V1 });
  for (let i = 0; i < 12; i++) await stepWorldFor(store, pg1, { world_id: w.id, steps: 100 });
  const before = await store.getWorld(w.id);
  assert.equal(before.tick, 1200);
  assert.equal(before.spec.roads, undefined, 'no roads yet');

  // Without confirm: a description, and nothing changes.
  const look = await say(store, `/sandbox upgrade ${w.id}`);
  assert.match(look.reply, /This would upgrade \*\*Pg1-Universe\*\* \(Simulation/);
  assert.match(look.reply, /Saltreach Airstrip \(\d+ m, heading \d+°\)/);
  assert.match(look.reply, /Nothing has changed yet/);
  assert.deepEqual(await store.getWorld(w.id), before);

  // With confirm.
  const out = await say(store, `/sandbox upgrade ${w.id} confirm`);
  assert.equal(out.upgraded, true, out.reply);
  const after = await store.getWorld(w.id);
  assert.equal(after.id, w.id);
  assert.equal(after.tick, 1200, 'the tick is unchanged');
  assert.ok(after.spec.roads && after.spec.roads.edges.length > 300, 'a road network');
  const runway = after.state.entities.find((e) => e.id === 'runway-saltreach');
  assert.ok(runway && typeof runway.properties.heading === 'number', 'a runway with a heading for Saltreach');
  assert.equal(after.state.entities.length, before.state.entities.length + 1, 'only the runway is added');
  // Nothing removed, renamed or moved; inhabitants, families, countries, treasuries, research identical.
  const byId = new Map(after.state.entities.map((e) => [e.id, e]));
  for (const e of before.state.entities) assert.deepEqual(byId.get(e.id), e, `${e.id} is exactly as it was`);
  const people = before.state.entities.filter((e) => LIVING.has(e.kind));
  assert.ok(people.length > 100);
  assert.deepEqual(after.state.society, before.state.society, 'countries, treasuries and research levels');
  for (const c of Object.keys(before.state.society)) {
    assert.equal(after.state.society[c].treasury, before.state.society[c].treasury);
    assert.deepEqual(after.state.society[c].rd, before.state.society[c].rd);
  }
  assert.deepEqual(after.state.relations, before.state.relations);
  assert.deepEqual(after.state.diplomacy, before.state.diplomacy);
  assert.deepEqual(after.state.awareness, before.state.awareness);
  assert.equal(after.state.rng, before.state.rng);
  // One record on the long chain: who, when, what.
  const long = await store.listBlackbox(w.id, { chain: 'long' });
  const rec = long.filter((r) => r.action === 'upgrade_world');
  assert.equal(rec.length, 1);
  assert.equal(rec[0].actor, 'pg1');
  assert.equal(rec[0].tick, 1200);
  assert.match(rec[0].detail.when, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(rec[0].detail.who, 'operator');
  assert.ok(rec[0].detail.added.roads.edges > 300 && rec[0].detail.added.runways.length === 1);
  // Again: nothing to add.
  assert.match((await say(store, `/sandbox upgrade ${w.id} confirm`)).reply, /Nothing to add/);

  // The next 2,000 steps.
  const run = measureRun(after.spec, after.state, 2000);
  assert.deepEqual(run.groundOnWater.slice(0, 5), []);
  assert.deepEqual(run.waterOnLand.slice(0, 5), []);
  assert.ok(run.onRoad >= 0.95, `${(run.onRoad * 100).toFixed(1)}% of vehicle positions on a road`);
  assert.deepEqual(run.steep.slice(0, 5), []);
  assert.ok(run.landings > 0);
  assert.deepEqual(run.offRunway, []);
});

test('refused: another owner\'s world, a blind copy, a world past the limits; usage', async () => {
  __resetSandboxMemory();
  const store = createSandboxStore();
  const inv = await inviteAgent(store, { label: 'Visitor' });
  const who = await resolveSandboxKey(store, inv.key);
  const theirs = await createWorld(store, who, { name: 'Theirs', template: 'meadow' });
  assert.match((await say(store, `/sandbox upgrade ${theirs.id} confirm`)).reply, /Only PG1's own worlds/);
  const mine = await createWorld(store, pg1Principal(), { name: 'Meadow', template: 'meadow' });
  const run = await startExperiment(store, { worldId: mine.id, blind: true, clues: false, situation: 'You stand in a meadow. Find the fox.' });
  assert.match((await say(store, `/sandbox upgrade ${run.world_id} confirm`)).reply, /blind run's copy/);
  assert.match((await say(store, '/universe upgrade nope')).reply, /Usage/);
  // Full to the entity limit with an island that has no runway: refused, saying what to delete.
  const full = { size: { x: 4000, y: 4000, z: 100 }, entities: [{ id: 'island-x', kind: 'island', properties: { country: 'x', name: 'Xland', radius: 1800 }, position: { x: 2000, y: 2000 } }, ...Array.from({ length: SANDBOX_LIMITS.entities - 1 }, (_, i) => ({ id: `t${i}`, kind: 'rock', position: { x: 1000 + (i % 40) * 50, y: 1000 + Math.floor(i / 40) * 80 } }))] };
  const plan = planUpgrade({ spec: full, state: null, tick: 0 });
  assert.match(plan.refuse || '', /Delete at least 1 things/);
});
