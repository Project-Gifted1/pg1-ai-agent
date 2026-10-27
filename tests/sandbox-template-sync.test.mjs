/**
 * /sandbox upgrade brings a world made from a template up to date with what
 * the template has gained since (lib/sandbox/template-sync.mjs): a universe
 * made before its template gained a cinema, a hot-air balloon, a rule and a
 * far world's rings gets them; never a person; a new building goes where
 * nothing stands; nothing the world has is removed or changed; a second
 * upgrade has nothing to add; a world that is no template's gets nothing.
 *
 * Run with: node --test tests/sandbox-template-sync.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateSpec } from '../lib/sandbox/templates.mjs';
import { validateSpec } from '../lib/sandbox/engine.mjs';
import { buildTerrain } from '../lib/sandbox/terrain.mjs';
import { planTemplateSync, templateOf, syncIsEmpty } from '../lib/sandbox/template-sync.mjs';
import { createSandboxStore, __resetSandboxMemory } from '../lib/sandbox/store.mjs';
import { createWorld, stepWorldFor, pg1Principal } from '../lib/sandbox/worlds.mjs';
import { handleSandboxCommand } from '../lib/sandbox/chat.mjs';

// The universe as if made before its template gained these.
function olderUniverse() {
  const t = templateSpec('universe');
  const cinema = t.entities.find((e) => e.id === 'cinema-1');
  const person = t.entities.find((e) => e.kind === 'person');
  const entities = t.entities
    .filter((e) => e.id !== 'cinema-1' && e.kind !== 'hot_air_balloon' && e.id !== person.id)
    .map((e) => (e.id === 'alien_world-2' ? { ...e, properties: Object.fromEntries(Object.entries(e.properties).filter(([k]) => k !== 'rings')) } : e))
    // A house the inhabitants built since, where the template's cinema stands.
    .concat([{ id: 'house-built-1', kind: 'house', position: { ...cinema.position }, properties: { built: 100 } }]);
  return { spec: validateSpec({ ...t, entities, rules: t.rules.filter((r) => r.id !== 'balloon-drifts') }), cinema, person };
}

test('which template a world was made from', () => {
  assert.equal(templateOf(templateSpec('universe').entities), 'universe');
  assert.equal(templateOf(templateSpec('town').entities), 'town');
  assert.equal(templateOf(templateSpec('meadow').entities), null);
  assert.equal(templateOf([]), null);
});

test('what the template gained is added: the cinema clear of the house built where it stood, the balloon, its rule, the rings; never the person', () => {
  const { spec, cinema, person } = olderUniverse();
  const T = buildTerrain(spec.entities, spec.size);
  const s = planTemplateSync(spec, spec.entities, T);
  assert.equal(s.template, 'universe');
  const ids = s.entities.map((e) => e.id).sort();
  assert.deepEqual(ids, ['cinema-1', 'hot_air_balloon-1']);
  assert.ok(!ids.includes(person.id), 'never a person');
  const c = s.entities.find((e) => e.id === 'cinema-1');
  assert.ok(Math.hypot(c.position.x - cinema.position.x, c.position.y - cinema.position.y) > 10, 'moved off the house');
  assert.ok(T.isLand(c.position.x, c.position.y), 'on land');
  assert.deepEqual(s.rulesAdded, ['balloon-drifts']);
  assert.deepEqual(s.details.get('alien_world-2'), { rings: true });
  // Applied, a second look has nothing to add.
  const next = validateSpec({ ...spec, entities: spec.entities.map((e) => (s.details.has(e.id) ? { ...e, properties: { ...e.properties, ...s.details.get(e.id) } } : e)).concat(s.entities), rules: s.rules });
  assert.ok(syncIsEmpty(planTemplateSync(next, next.entities, buildTerrain(next.entities, next.size))));
});

test('the upgrade command adds them in place, keeps every thing the world has, and the next upgrade has nothing to add', async () => {
  __resetSandboxMemory();
  const store = createSandboxStore();
  const pg1 = pg1Principal();
  const { spec } = olderUniverse();
  const w = await createWorld(store, pg1, { name: 'Older', spec });
  await stepWorldFor(store, pg1, { world_id: w.id, steps: 100 });
  const before = await store.getWorld(w.id);
  const say = (text) => handleSandboxCommand({ text, isOperator: true, store });
  const look = await say(`/sandbox upgrade ${w.id}`);
  assert.match(look.reply, /from the universe template, what it has gained since this world was made: .*1 cinema/);
  assert.match(look.reply, /from the universe template, what it has gained since this world was made: .*1 hot air balloon/);
  assert.match(look.reply, /new rules: balloon-drifts/);
  const out = await say(`/sandbox upgrade ${w.id} confirm`);
  assert.equal(out.upgraded, true, out.reply);
  const after = await store.getWorld(w.id);
  for (const e of before.state.entities) assert.ok(after.state.entities.some((a) => a.id === e.id && a.kind === e.kind), `${e.id} kept`);
  assert.ok(after.state.entities.some((e) => e.id === 'cinema-1') && after.state.entities.some((e) => e.id === 'hot_air_balloon-1'));
  assert.ok(after.spec.rules.some((r) => r.id === 'balloon-drifts'));
  assert.equal(after.tick, before.tick);
  assert.match((await say(`/sandbox upgrade ${w.id} confirm`)).reply, /Nothing to add/);
  // It runs on.
  await stepWorldFor(store, pg1, { world_id: w.id, steps: 100 });
});

test('a world that is no template\'s gets nothing from one', () => {
  const spec = templateSpec('meadow');
  const s = planTemplateSync(spec, spec.entities, buildTerrain(spec.entities, spec.size));
  assert.equal(s.template, null);
  assert.ok(syncIsEmpty(s));
});

test('deterministic: the same world gives the same plan', () => {
  const { spec } = olderUniverse();
  const plan = () => { const s = planTemplateSync(spec, spec.entities, buildTerrain(spec.entities, spec.size)); return JSON.stringify({ ...s, details: [...s.details] }); };
  assert.equal(plan(), plan());
});
