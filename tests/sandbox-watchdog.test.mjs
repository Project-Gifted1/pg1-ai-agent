/**
 * Things keep apart, and the watchdog puts right whatever behaves otherwise
 * (lib/sandbox/watchdog.mjs): no boat, vehicle or person passes through
 * another; vehicles queue; anything off the road, on the wrong side of the
 * shore, out of the world or stuck is put right, deterministically.
 *
 * Run with: node --test tests/sandbox-watchdog.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, stepWorld, validateSpec } from '../lib/sandbox/engine.mjs';
import { templateSpec } from '../lib/sandbox/templates.mjs';
import { moveContext } from '../lib/sandbox/movement.mjs';
import { onRoad } from '../lib/sandbox/roads.mjs';
import { watchdog, keepApart, BLOCKED_MAX, STUCK_STEPS } from '../lib/sandbox/watchdog.mjs';

const BOATS = new Set(['boat', 'ship', 'ferry', 'patrol_boat']);
const VEHICLES = new Set(['car', 'taxi', 'police_car', 'bus', 'truck', 'army_truck', 'motorbike']);
const PEOPLE = new Set(['person', 'child']);
const WIDTH = { ferry: 10, ship: 9, boat: 3, patrol_boat: 3, car: 1.9, taxi: 1.9, police_car: 1.9, bus: 2.5, truck: 2.5, army_truck: 2.5, motorbike: 0.8, person: 0.6, child: 0.45 };
const family = (k) => (BOATS.has(k) ? 'boats' : VEHICLES.has(k) ? 'vehicles' : PEOPLE.has(k) ? 'people' : null);

// Pairs of things on a trip (not at their door) whose bodies overlap, step by step.
function overlapsOver(spec, steps) {
  let st = initialState(spec);
  const found = { boats: [], vehicles: [], people: [] };
  for (let t = 1; t <= steps; t++) {
    st = stepWorld(spec, st, 1).state;
    const idx = new Map(st.entities.map((e) => [e.id, e]));
    const travelling = st.entities.filter((e) => family(e.kind) && !(e.properties.inside && idx.has(e.properties.inside)) && (e.position.z || 0) <= 1 && e.properties.target).filter((e) => {
      const g = idx.get(e.properties.target);
      return !g || Math.hypot(g.position.x - e.position.x, g.position.y - e.position.y) > 6;
    });
    for (let i = 0; i < travelling.length; i++) for (let j = i + 1; j < travelling.length; j++) {
      const a = travelling[i]; const b = travelling[j];
      if (family(a.kind) !== family(b.kind)) continue;
      if (Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) < (WIDTH[a.kind] + WIDTH[b.kind]) / 2 - 0.05) found[family(a.kind)].push(`${t}: ${a.id} ${b.id}`);
    }
  }
  return found;
}

test('600 steps of the universe: no boat, vehicle or person passes through another', () => {
  const found = overlapsOver(templateSpec('universe'), 600);
  assert.deepEqual(found.boats.slice(0, 5), [], 'boats');
  assert.deepEqual(found.vehicles.slice(0, 5), [], 'vehicles');
  assert.deepEqual(found.people.slice(0, 5), [], 'people');
});

test('two boats heading straight at each other go round, never through, and both get where they are going', () => {
  const spec = validateSpec({
    size: { x: 2000, y: 1000, z: 500 }, seed: 5,
    entities: [
      { id: 'buoy-w', kind: 'buoy', position: { x: 200, y: 500 } },
      { id: 'buoy-e', kind: 'buoy', position: { x: 1800, y: 500 } },
      { id: 'boat-a', kind: 'boat', properties: { target: 'buoy-e' }, position: { x: 300, y: 500 } },
      { id: 'boat-b', kind: 'boat', properties: { target: 'buoy-w' }, position: { x: 1700, y: 500 } }
    ],
    rules: [{ id: 'sail', type: 'travel', kind: 'boat' }]
  });
  let st = initialState(spec); let closest = Infinity; const arrived = new Set();
  for (let t = 0; t < 400 && arrived.size < 2; t++) {
    const r = stepWorld(spec, st, 1); st = r.state;
    for (const e of r.events) if (e.kind === 'arrive') arrived.add(e.ref);
    const [a, b] = ['boat-a', 'boat-b'].map((id) => st.entities.find((e) => e.id === id));
    closest = Math.min(closest, Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y));
  }
  assert.ok(closest >= 3 - 0.05, `closest ${closest.toFixed(2)} m, never through`);
  assert.deepEqual([...arrived].sort(), ['boat-a', 'boat-b']);
});

test('a car behind a stopped car waits behind it (a queue), and never drives through it', () => {
  const uni = templateSpec('universe');
  let st = initialState(uni);
  st = stepWorld(uni, st, 30).state;
  const mc = moveContext(uni, st.entities);
  // Two cars on one road: the leader stands still with a trip, the follower right behind.
  const edge = mc.roads.edges.find((e) => e.w >= 6 && Math.hypot(mc.roads.xs[e.b] - mc.roads.xs[e.a], mc.roads.ys[e.b] - mc.roads.ys[e.a]) > 80);
  const ax = mc.roads.xs[edge.a]; const ay = mc.roads.ys[edge.a]; const bx = mc.roads.xs[edge.b]; const by = mc.roads.ys[edge.b];
  const L = Math.hypot(bx - ax, by - ay); const ux = (bx - ax) / L; const uy = (by - ay) / L;
  const lead = { id: 'zz-lead', kind: 'car', properties: { target: 'zz-far', name: 'Lead' }, position: { x: ax + ux * 40, y: ay + uy * 40, z: 0 } };
  const follow = { id: 'zz-follow', kind: 'car', properties: { target: 'zz-far', name: 'Follow' }, position: { x: ax + ux * 30, y: ay + uy * 30, z: 0 } };
  const ents = [...st.entities, lead, follow];
  const before = new Map(ents.map((e) => [e.id, { ...e.position }]));
  // This step the follower would drive 20 m on, through the leader.
  follow.position = { x: ax + ux * 50, y: ay + uy * 50, z: 0 };
  keepApart(ents, new Set(), before, moveContext(uni, ents));
  const gap = (follow.position.x - lead.position.x) * ux + (follow.position.y - lead.position.y) * uy;
  assert.ok(gap <= -4.5 + 1e-6, `the follower stops behind (${gap.toFixed(2)} m)`);
  assert.equal(follow.properties.blocked, 1);
});

test('the watchdog puts right a car off the road, a person on the water and a boat on land, once, with one event', () => {
  const uni = templateSpec('universe');
  let st = stepWorld(uni, initialState(uni), 20).state;
  const ents = st.entities;
  const mc = moveContext(uni, ents);
  const car = ents.find((e) => e.kind === 'car' && !e.properties.inside);
  const person = ents.find((e) => e.kind === 'person' && !e.properties.inside);
  const boat = ents.find((e) => e.kind === 'boat' && !e.properties.inside);
  const land = mc.terrain.nearestLand(100, 100); const sea = { x: 50, y: 50 };
  car.position = { x: car.position.x + 37, y: car.position.y + 41, z: 0 };
  person.position = { ...sea, z: 0 };
  boat.position = { x: 2000, y: 2200, z: 0 };   // in Aurelia
  assert.equal(mc.terrain.isLand(boat.position.x, boat.position.y), true);
  const events = [];
  const before = new Map(ents.map((e) => [e.id, { ...e.position }]));
  watchdog(ents, new Set(), before, mc, uni.size, (kind, summary, ref) => events.push({ kind, summary, ref }));
  assert.ok(onRoad(mc.roads, car.position.x, car.position.y, {}), 'the car is on a road');
  assert.equal(mc.terrain.isLand(person.position.x, person.position.y), true, 'the person is on land');
  assert.equal(mc.terrain.isLand(boat.position.x, boat.position.y), false, 'the boat is on the water');
  assert.equal(events.length, 1);
  assert.match(events[0].summary, /^The watchdog put right: .*back on the road/);
  assert.ok(land);
});

test('something stuck, or waiting too long behind another, drops its trip and chooses again', () => {
  const uni = templateSpec('universe');
  const st = stepWorld(uni, initialState(uni), 5).state;
  const ents = st.entities;
  const mc = moveContext(uni, ents);
  const people = ents.filter((e) => e.kind === 'person' && !e.properties.inside).slice(0, 2);
  const house = ents.find((e) => e.kind === 'house');
  people[0].properties.target = house.id; people[0].properties.stuck = STUCK_STEPS - 1;
  people[1].properties.target = house.id; people[1].properties.blocked = BLOCKED_MAX;
  const before = new Map(ents.map((e) => [e.id, { ...e.position }]));
  watchdog(ents, new Set(), before, mc, uni.size, () => {});
  for (const p of people) { assert.equal(p.properties.target, undefined); assert.equal(p.properties.stuck, undefined); assert.equal(p.properties.blocked, undefined); }
});

test('deterministic: same world and seed, same result', () => {
  const uni = templateSpec('universe');
  const run = () => { let st = initialState(uni); for (let i = 0; i < 2; i++) st = stepWorld(uni, st, 100).state; return st; };
  const a = run(); const b = run();
  assert.deepEqual(a, b);
});
