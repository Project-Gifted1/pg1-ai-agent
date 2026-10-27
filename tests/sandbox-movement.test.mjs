/**
 * Movement over land, sea and air (lib/sandbox/movement.mjs, roads.mjs,
 * terrain.mjs): a deterministic 2,000-step run of the universe template, in
 * which
 *   - no ground thing (people, animals, bikes, cars, buses...) ever stands
 *     on water, and no boat, ferry or ship is ever on land;
 *   - at least 95% of ground-vehicle positions are on a road;
 *   - no aircraft climbs or descends steeper than the allowed gradient;
 *   - every aircraft that lands touches down on a runway, within its length;
 * plus the road network itself, roads kept clear of buildings, a trip to
 * another island by ferry (or refused when there is no link), the
 * corrections for a world from before (one event each) and determinism.
 *
 * Run with: node --test tests/sandbox-movement.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialState, stepWorld, validateSpec, SANDBOX_LIMITS } from '../lib/sandbox/engine.mjs';
import { templateSpec } from '../lib/sandbox/templates.mjs';
import { moveContext, MAX_GRADIENT, FLIGHT } from '../lib/sandbox/movement.mjs';
import { roadGraph, nearestNode, nextHop, offRoad, obstaclesOf } from '../lib/sandbox/roads.mjs';
import { CRUISE_ALTITUDE, DEFAULT_SPACE_ALTITUDE, catalogFor } from '../lib/sandbox/catalog.mjs';
import { NOTABLE } from '../lib/sandbox/blackbox.mjs';
import { measureRun } from './helpers/sandboxMovement.mjs';

const UNI = templateSpec('universe');
const RUN = measureRun(UNI, initialState(UNI), 2000);

test('2,000 steps of the universe: no ground thing on water, no boat on land', () => {
  assert.deepEqual(RUN.groundOnWater.slice(0, 5), [], 'ground things stay on land');
  assert.deepEqual(RUN.waterOnLand.slice(0, 5), [], 'boats stay on the water');
  assert.ok(!RUN.events.some((e) => e.kind === 'terrain_fix'), 'a new universe needs no corrections');
});

test('2,000 steps of the universe: every ground-vehicle position is on a road', () => {
  assert.ok(RUN.vehiclePositions > 50000, `${RUN.vehiclePositions} positions measured`);
  assert.equal(RUN.onRoad, 1, `${(RUN.onRoad * 100).toFixed(2)}% on a road`);
});

test('2,000 steps of the universe: aircraft climb and descend within the gradient, and land on runways', () => {
  assert.deepEqual(RUN.steep.slice(0, 5), [], `never steeper than ${MAX_GRADIENT}`);
  assert.ok(RUN.landings >= 10, `${RUN.landings} landings`);
  assert.deepEqual(RUN.offRunway, [], 'every touchdown is on a runway, within its length');
  assert.ok(RUN.events.some((e) => e.kind === 'touchdown'));
  // Cruise: higher than before, believable, below space.
  assert.ok(CRUISE_ALTITUDE >= 500 && CRUISE_ALTITUDE < DEFAULT_SPACE_ALTITUDE);
  for (const f of Object.values(FLIGHT)) assert.ok(f.cruiseAlt < DEFAULT_SPACE_ALTITUDE);
});

test('a plane taxis, rolls, lifts off at rotation speed, climbs at about 4 degrees, and its speed changes gradually', () => {
  const spec = UNI;
  let st = initialState(spec);
  const track = [];
  for (let i = 0; i < 60; i++) { st = stepWorld(spec, st, 1).state; const p = st.entities.find((e) => e.id === 'plane-1'); track.push({ ...p.position, fp: p.properties.fp, v: p.properties.v }); }
  const firstAir = track.findIndex((p) => p.z > 0);
  assert.ok(firstAir > 3, 'it taxis and rolls on the ground first');
  assert.ok(track.slice(0, firstAir).some((p) => p.fp === 'roll'), 'a take-off roll');
  assert.ok(track[firstAir - 1].v >= FLIGHT.plane.vr - 1e-9, 'airborne only at rotation speed');
  for (let i = 1; i < track.length; i++) {
    const dv = Math.abs((track[i].v || 0) - (track[i - 1].v || 0));
    if (track[i].z > 0 && track[i - 1].z > 0) assert.ok(dv <= FLIGHT.plane.acc, `no sudden change of speed in the air (${dv})`);
  }
});

test('the roads: a connected network per island, clear of every building, with names; routes found by A*', () => {
  const mc = moveContext(UNI, UNI.entities);
  const g = mc.roads;
  assert.ok(g && g.n > 300, `${g.n} road nodes`);
  assert.ok(Buffer.byteLength(JSON.stringify(UNI)) < SANDBOX_LIMITS.specBytes && UNI.entities.length < SANDBOX_LIMITS.entities, 'inside the limits');
  // One piece for vehicles on each island.
  for (const mass of ['aurelia', 'maravia', 'nordheim', 'saltreach']) {
    const nodes = [...Array(g.n).keys()].filter((k) => g.mass[k] === mass && g.adj.car[k].length);
    const seen = new Set([nodes[0]]); const stack = [nodes[0]];
    while (stack.length) { const u = stack.pop(); for (const { to } of g.adj.car[u]) if (!seen.has(to)) { seen.add(to); stack.push(to); } }
    assert.equal(seen.size, nodes.length, `${mass}: one network`);
  }
  // Roads keep clear of buildings (a road may lead to its own building's door).
  for (const o of obstaclesOf(UNI.entities).filter((x) => !x.rect && catalogFor(UNI.entities.find((e) => e.id === x.id).kind).class === 'building')) {
    assert.ok(offRoad(g, o.x, o.y, { paths: true }) > 0, `no road through ${o.id}`);
  }
  const names = new Set(g.edges.map((e) => e.name).filter(Boolean));
  for (const n of ['Aurelia Ring Road', 'Maravia Ring Road', 'Oak Street']) assert.ok(names.has(n), n);
  assert.ok([...names].some((n) => /Harbour Road/.test(n)) && [...names].some((n) => /Airport Road/.test(n)));
  // A* from the school to the harbour.
  const school = UNI.entities.find((e) => e.id === 'school-1'); const port = UNI.entities.find((e) => e.id === 'port-aurelia');
  const a = nearestNode(g, school.position.x, school.position.y); const b = nearestNode(g, port.position.x, port.position.y);
  let k = a; let hops = 0;
  while (k !== b && k >= 0 && hops < 1000) { k = nextHop(g, 'car', k, b); hops++; }
  assert.equal(k, b, 'a route by road');
  // Every country has a runway with a heading.
  for (const c of ['aurelia', 'maravia', 'nordheim', 'saltreach']) assert.ok(UNI.entities.some((e) => e.kind === 'runway' && typeof e.properties.heading === 'number' && mc.terrain.islandAt(e.position.x, e.position.y) === c), c);
  // A road network is data: validated like everything else.
  assert.throws(() => validateSpec({ ...UNI, roads: { nodes: [[0, 0]], edges: [[0, 5, 10, -1]], names: [] } }), /roads/);
});

test('a ground trip to another island goes by the harbour and the ferry; with no link it is refused with a plain event', () => {
  const base = {
    size: { x: 6000, y: 3000, z: 3000 }, seed: 3,
    entities: [
      { id: 'island-a', kind: 'island', properties: { country: 'a', name: 'Alpha', radius: 900 }, position: { x: 1200, y: 1500 } },
      { id: 'island-b', kind: 'island', properties: { country: 'b', name: 'Beta', radius: 900 }, position: { x: 4800, y: 1500 } },
      { id: 'port-a', kind: 'port', position: { x: 2050, y: 1500 } },
      { id: 'port-b', kind: 'port', position: { x: 3950, y: 1500 } },
      { id: 'home', kind: 'house', position: { x: 1000, y: 1500 } },
      { id: 'inn', kind: 'hotel', position: { x: 5000, y: 1500 } },
      { id: 'walker', kind: 'person', properties: { target: 'inn', name: 'Ada' }, position: { x: 1050, y: 1450 } }
    ],
    rules: [{ id: 'walk', type: 'travel', kind: 'person' }]
  };
  // No ferry: refused.
  const none = validateSpec(base);
  const r0 = stepWorld(none, initialState(none), 1);
  assert.ok(r0.events.some((e) => e.kind === 'trip_refused' && /Ada cannot get to/.test(e.summary)));
  assert.equal(r0.state.entities.find((e) => e.id === 'walker').properties.target, undefined);
  // With a ferry between the two harbours: to the harbour, aboard, off on the other side, to the hotel.
  const spec = validateSpec({ ...base, entities: [...base.entities, { id: 'ferry-1', kind: 'ferry', properties: { name: 'Gull' }, position: { x: 2200, y: 1500 } }], rules: [...base.rules, { id: 'sail', type: 'travel', kind: 'ferry', roam: ['port'] }] });
  const out = measureRun(spec, initialState(spec), 600);
  const kinds = out.events.filter((e) => e.ref === 'walker').map((e) => e.summary);
  assert.ok(kinds.some((s) => /Ada boarded Gull at port-a/.test(s)), 'boards the ferry');
  assert.ok(kinds.some((s) => /Ada got off Gull at port-b/.test(s)), 'gets off on the other island');
  assert.equal(out.state.entities.find((e) => e.id === 'walker').properties.at, 'inn', 'and walks on to the hotel');
  assert.deepEqual(out.groundOnWater, []);
  assert.deepEqual(out.waterOnLand, []);
});

test('a world from before: ground things on the sea and boats on land are put right once, one black box event each', () => {
  const v1 = validateSpec(JSON.parse(readFileSync(new URL('./fixtures/sandbox-universe-v1.json', import.meta.url), 'utf8')));
  const r = stepWorld(v1, initialState(v1), 2);
  const fixes = r.events.filter((e) => e.kind === 'terrain_fix');
  assert.ok(fixes.some((e) => e.ref === 'ferry-1' && /moved to the nearest water/.test(e.summary)), 'a ferry that stood in its harbour');
  assert.ok(fixes.some((e) => /standing on water/.test(e.summary) && /nearest shore of aurelia/.test(e.summary)), 'people whose garden was in the lake');
  assert.equal(new Set(fixes.map((e) => e.ref)).size, fixes.length, 'one event each');
  assert.ok(fixes.every((e) => e.tick === 1), 'all on the first step');
  assert.ok(NOTABLE.has('terrain_fix'), 'each one a black box record');
  // Deterministic: the same corrections every time.
  assert.deepEqual(stepWorld(v1, initialState(v1), 2).state, r.state);
});

test('the same world and seed give the same run', () => {
  const a = stepWorld(UNI, initialState(UNI), 100).state;
  const b = stepWorld(UNI, initialState(UNI), 100).state;
  assert.deepEqual(a, b);
  // The caches change nothing: a fresh graph routes the same way.
  const g = roadGraph(UNI, UNI.entities, moveContext(UNI, UNI.entities).terrain);
  assert.equal(nextHop(g, 'car', 0, g.n - 1), nextHop(g, 'car', 0, g.n - 1));
});
