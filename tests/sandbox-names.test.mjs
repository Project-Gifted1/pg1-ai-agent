/**
 * Every thing in a world has a name (lib/sandbox/names.mjs), and worlds
 * with the same name can be told apart (worldKindOf in worlds.mjs).
 *
 * Run with: node --test tests/sandbox-names.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, stepWorld, validateSpec } from '../lib/sandbox/engine.mjs';
import { templateSpec, TEMPLATE_NAMES } from '../lib/sandbox/templates.mjs';
import { nameEntities, kindLabel } from '../lib/sandbox/names.mjs';
import { worldKindOf } from '../lib/sandbox/worlds.mjs';

const unnamed = (st) => st.entities.filter((e) => typeof e.properties.name !== 'string' || !e.properties.name.trim());

test('every thing in every template has a name, at the start and after 600 steps', () => {
  for (const t of TEMPLATE_NAMES) {
    const spec = templateSpec(t);
    let st = initialState(spec);
    assert.deepEqual(unnamed(st).map((e) => e.id), [], `${t} at the start`);
    for (let i = 0; i < 6; i++) st = stepWorld(spec, st, 100).state;
    assert.deepEqual(unnamed(st).map((e) => e.id), [], `${t} after 600 steps`);
  }
});

test('names: kept when given, the owner\'s for an owned thing, else the kind and a number not already used', () => {
  const ents = [
    { id: 'p1', kind: 'person', properties: { name: 'Ivie', family: 'Aigbe' }, position: { x: 0, y: 0, z: 0 } },
    { id: 'car-a', kind: 'car', properties: { owner: 'p1' }, position: { x: 0, y: 0, z: 0 } },
    { id: 'car-b', kind: 'car', properties: {}, position: { x: 0, y: 0, z: 0 } },
    { id: 'car-c', kind: 'car', properties: { name: 'Car 2' }, position: { x: 0, y: 0, z: 0 } },
    { id: 'st-1', kind: 'space_station', properties: {}, position: { x: 0, y: 0, z: 0 } },
    { id: 'tree-1', kind: 'tree', properties: { name: 'the old oak' }, position: { x: 0, y: 0, z: 0 } }
  ];
  assert.equal(nameEntities(ents), 3);
  const by = Object.fromEntries(ents.map((e) => [e.id, e.properties.name]));
  assert.equal(by['car-a'], "Ivie Aigbe's car");
  assert.equal(by['car-b'], 'Car 3');            // 2 is taken
  assert.equal(by['car-c'], 'Car 2');
  assert.equal(by['st-1'], 'Space station 1');
  assert.equal(by['tree-1'], 'the old oak');
  assert.equal(kindLabel('launch_pad'), 'Launch pad');
});

test('the inhabitants of a life rule are named by their society, in their own culture\'s way', () => {
  const spec = templateSpec('universe');
  const st = initialState(validateSpec(spec));
  const people = st.entities.filter((e) => e.kind === 'person');
  assert.ok(people.length > 0);
  assert.ok(!people.some((e) => /^Person \d+$/.test(e.properties.name)), 'no person is a "Person n"');
});

test('naming is deterministic: same world and seed, same names', () => {
  const spec = templateSpec('town');
  const a = stepWorld(spec, initialState(spec), 100).state;
  const b = stepWorld(spec, initialState(spec), 100).state;
  assert.deepEqual(a.entities.map((e) => e.properties.name), b.entities.map((e) => e.properties.name));
});

test('worlds with the same name are told apart by what they are', () => {
  assert.equal(worldKindOf(templateSpec('universe')), 'universe: islands and space');
  assert.equal(worldKindOf(templateSpec('town')), 'town');
  assert.equal(worldKindOf(templateSpec('meadow')), 'meadow');
  assert.equal(worldKindOf({ entities: [] }), 'empty world');
});
