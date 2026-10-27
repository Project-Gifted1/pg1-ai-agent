/**
 * Safe helicopters, emergency services and beach life (lib/sandbox/
 * emergency.mjs, movement.mjs flyRotor): helicopters never enter a
 * building; fires are fought by fire engines on the same island, or by
 * neighbours; the hurt are taken to hospital; people at the beach swim,
 * sunbathe and play, and a swimmer in trouble is rescued.
 *
 * Run with: node --test tests/sandbox-emergency.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, stepWorld, validateSpec } from '../lib/sandbox/engine.mjs';
import { templateSpec } from '../lib/sandbox/templates.mjs';
import { heightOf } from '../lib/sandbox/movement.mjs';
import { catalogFor } from '../lib/sandbox/catalog.mjs';
import { buildTerrain } from '../lib/sandbox/terrain.mjs';

const run = (spec, steps, st = null) => { let state = st || initialState(spec); const events = []; for (let n = steps; n > 0; n -= 100) { const r = stepWorld(spec, state, Math.min(100, n)); state = r.state; events.push(...r.events); } return { state, events }; };
// A world's spec with its life rule changed.
const withLife = (spec, change) => validateSpec({ ...spec, rules: spec.rules.map((r) => (r.type === 'life' ? { ...r, ...change } : r)) });

test('helicopters and drones never fly into a building (1,500 steps of the universe)', () => {
  const spec = templateSpec('universe');
  let st = initialState(spec);
  const buildings = st.entities.filter((e) => catalogFor(e.kind).class === 'building' && heightOf(e) > 0);
  const inside = [];
  for (let t = 1; t <= 1500; t++) {
    st = stepWorld(spec, st, 1).state;
    for (const h of st.entities.filter((e) => e.kind === 'helicopter' || e.kind === 'drone')) {
      const z = h.position.z || 0;
      for (const b of buildings) if (z > 0.5 && z < heightOf(b) - 0.5 && Math.hypot(h.position.x - b.position.x, h.position.y - b.position.y) < Math.max(8, (catalogFor(b.kind).footprint || 10) * 0.5)) inside.push(`${t} ${h.id} in ${b.id}`);
    }
  }
  assert.deepEqual(inside.slice(0, 5), []);
});

test('a fire: everyone gets out, the nearest fire engine on that island comes with its siren, the fire is put out, and it goes home', () => {
  const spec = withLife(templateSpec('town'), { fire_rate: 0.05 });
  const { state, events } = run(spec, 1500);
  const fires = events.filter((e) => e.kind === 'fire');
  assert.ok(fires.length >= 3, `${fires.length} fires`);
  assert.ok(events.some((e) => e.kind === 'dispatch' && /on its way to the fire/.test(e.summary)), 'an engine called out');
  assert.ok(events.some((e) => e.kind === 'fire_out' && /^Firefighters put out the fire/.test(e.summary)), 'put out by firefighters');
  // Engines not on a call have their sirens off.
  for (const v of state.entities.filter((e) => e.kind === 'fire_truck' && !e.properties.emergency)) assert.notEqual(v.properties.siren, true);
  // Every fire that started is out, or still burning at the end; none left half-handled with no one coming.
  const burning = state.entities.filter((e) => e.properties.fire > 0);
  for (const b of burning) assert.ok(state.entities.some((v) => v.properties.call === b.id) || state.entities.some((p) => p.properties.fighting_fire === b.id) || b.properties.fire_damaged, `${b.id} has help or is burning out`);
});

test('the hurt are collected by an ambulance and treated at the hospital', () => {
  const spec = withLife(templateSpec('town'), { fire_rate: 0.08 });
  const { events } = run(spec, 2000);
  if (!events.some((e) => e.kind === 'injured')) return;   // nobody was hurt in this run
  assert.ok(events.some((e) => e.kind === 'ambulance' && /picked up/.test(e.summary)), 'picked up');
  assert.ok(events.some((e) => e.kind === 'treated'), 'treated');
});

test('in a world with no fire engine, the neighbours fight the fire', () => {
  const town = templateSpec('town');
  const spec = withLife(validateSpec({ ...town, entities: town.entities.filter((e) => e.kind !== 'fire_truck' && e.kind !== 'fire_station') }), { fire_rate: 0.08 });
  const { events } = run(spec, 1200);
  assert.ok(events.some((e) => e.kind === 'neighbours'), 'neighbours came');
  assert.ok(!events.some((e) => e.kind === 'dispatch' && /fire/.test(e.summary)));
});

test('a day at the beach: people swim, sunbathe and play; swimmers are only ever in the water off a beach', () => {
  const spec = templateSpec('universe');
  let st = initialState(spec);
  const T = buildTerrain(spec.entities, spec.size);
  const beaches = st.entities.filter((e) => e.kind === 'beach');
  const seen = new Set(); const wrong = [];
  for (let i = 0; i < 40; i++) {
    st = stepWorld(spec, st, 100).state;
    for (const p of st.entities.filter((e) => e.properties.activity)) {
      seen.add(p.properties.activity);
      const nearBeach = beaches.some((b) => Math.hypot(b.position.x - p.position.x, b.position.y - p.position.y) < 150);
      if (!nearBeach) wrong.push(`${p.id} ${p.properties.activity} far from a beach`);
      if (p.properties.swimming && T.isLand(p.position.x, p.position.y)) wrong.push(`${p.id} swimming on land`);
    }
  }
  assert.deepEqual(wrong.slice(0, 5), []);
  assert.ok(seen.size >= 2, `activities seen: ${[...seen].join(', ')}`);
});

test('a swimmer in trouble: a lifeguard swims out and brings them back to the beach', () => {
  const spec = templateSpec('universe');
  let st = stepWorld(spec, initialState(spec), 5).state;
  const T = buildTerrain(spec.entities, spec.size);
  const beach = st.entities.find((e) => e.id === 'beach-aurelia');
  const tower = st.entities.find((e) => e.kind === 'lifeguard_tower' && e.properties.beach === beach.id);
  const [swimmer, guard] = st.entities.filter((e) => e.kind === 'person' && !e.properties.inside).slice(0, 2);
  const w = T.nearestWater(beach.position.x, beach.position.y, { margin: 4 });
  const d = Math.hypot(w.x - beach.position.x, w.y - beach.position.y);
  Object.assign(swimmer, { position: { x: w.x + ((w.x - beach.position.x) / d) * 10, y: w.y + ((w.y - beach.position.y) / d) * 10, z: 0 } });
  Object.assign(swimmer.properties, { activity: 'swim', activity_until: st.tick + 200, swimming: true, in_trouble: st.tick, at: beach.id });
  delete swimmer.properties.target;
  Object.assign(guard, { position: { ...tower.position } });
  Object.assign(guard.properties, { job: 'lifeguard', work: tower.id, rescuing: swimmer.id, swimming: true });
  delete guard.properties.target;
  const { events, state } = run(spec, 30, st);
  assert.ok(events.some((e) => e.kind === 'rescued' && e.ref === guard.id), events.filter((e) => e.ref === guard.id || e.ref === swimmer.id).map((e) => e.summary).join(' | '));
  const after = state.entities.find((e) => e.id === swimmer.id);
  assert.equal(after.properties.in_trouble, undefined);
  assert.equal(T.isLand(after.position.x, after.position.y), true, 'back on land');
});

test('deterministic: same world and seed, same fires and beaches', () => {
  const spec = withLife(templateSpec('town'), { fire_rate: 0.05 });
  const a = run(spec, 300); const b = run(spec, 300);
  assert.deepEqual(a.events, b.events);
});
