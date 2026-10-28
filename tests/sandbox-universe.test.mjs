/**
 * The Sandbox's living worlds: the catalogue (people, buildings, vehicles,
 * space), the travel and orbit rules, riders, the town and universe
 * templates, update_entity (how an agent drives), get_catalog, the viewer's
 * "create" op, and the blind subject's enter / leave / go.
 *
 * Worlds are simulations: every result here still says so.
 *
 * Run with: node --test tests/sandbox-universe.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stepWorld, initialState, validateSpec, spaceAltitude, SANDBOX_LIMITS, RULE_TYPES } from '../lib/sandbox/engine.mjs';
import { catalogFor, catalogView, CATALOG_KINDS } from '../lib/sandbox/catalog.mjs';
import { templateSpec, TEMPLATE_NAMES } from '../lib/sandbox/templates.mjs';
import { rulesInWords } from '../lib/sandbox/describe.mjs';
import { createSandboxStore, __resetSandboxMemory } from '../lib/sandbox/store.mjs';
import { createWorld, updateEntity, stepWorldFor, observeWorld, pg1Principal } from '../lib/sandbox/worlds.mjs';
import { callSandboxTool, SANDBOX_TOOLS } from '../lib/sandbox/mcp.mjs';
import { act, subjectSpec, BLIND_TOOL_NAMES, containsBanned } from '../lib/sandbox/blind.mjs';
import sandboxViewer, { __setSandboxViewerStore } from '../api/sandbox.mjs';

beforeEach(() => { __resetSandboxMemory(); });

const at = (state, id) => state.entities.find((e) => e.id === id);
const run = (spec, steps) => { let st = initialState(spec); const events = []; for (let n = steps; n > 0; n -= 100) { const r = stepWorld(spec, st, Math.min(100, n)); st = r.state; events.push(...r.events); } return { state: st, events }; };

test('the catalogue: people, animals, plants, buildings, roads, vehicles from bikes to rockets, and space; any other kind still works', () => {
  for (const k of ['person', 'house', 'apartment', 'tower', 'road', 'car', 'bike', 'motorbike', 'bus', 'truck', 'train', 'boat', 'ship', 'plane', 'jet', 'helicopter', 'rocket', 'shuttle', 'space_station', 'satellite', 'star', 'planet', 'moon']) assert.ok(CATALOG_KINDS.includes(k), k);
  assert.equal(catalogFor('car').domain, 'ground');
  assert.equal(catalogFor('boat').domain, 'water');
  assert.equal(catalogFor('plane').domain, 'air');
  assert.equal(catalogFor('rocket').domain, 'space');
  assert.equal(catalogFor('house').domain, 'fixed');
  assert.equal(catalogFor('car_red').class, 'vehicle', 'a suffix keeps the base kind');
  assert.equal(catalogFor('gizmo').class, 'thing');
  assert.ok(catalogFor('bus').seats >= 20);
  assert.ok(catalogView().every((c) => c.kind && c.class && c.domain && typeof c.speed_m_per_step === 'number'));
  assert.ok(RULE_TYPES.includes('travel') && RULE_TYPES.includes('orbit'));
});

test('travel: a car drives on the ground to a house and stops at its door; a plane rolls, climbs and lands; arrival is recorded', () => {
  const spec = validateSpec({
    size: { x: 3000, y: 3000, z: 5000 },
    entities: [
      { id: 'home', kind: 'house', position: { x: 1000, y: 1000 } },
      { id: 'c1', kind: 'car', position: { x: 0, y: 0, z: 0 }, properties: { target: 'home' } },
      { id: 'strip', kind: 'runway', position: { x: 2500, y: 0 } },
      { id: 'p1', kind: 'plane', position: { x: 0, y: 0, z: 0 }, properties: { target: 'strip' } }
    ],
    rules: [{ id: 'cars', type: 'travel', kind: 'car' }, { id: 'planes', type: 'travel', kind: 'plane' }]
  });
  const first = stepWorld(spec, initialState(spec), 1).state;
  assert.equal(at(first, 'c1').position.z, 0, 'cars stay on the ground');
  // Realistic flight (lib/sandbox/movement.mjs): no instant climb. The plane
  // rolls along the ground first, then lifts off within a few steps.
  assert.equal(at(first, 'p1').position.z, 0, 'the take-off roll is on the ground');
  assert.ok(run(spec, 8).state.entities.find((e) => e.id === 'p1').position.z > 0, 'the plane climbs');
  const { state, events } = run(spec, 40);
  const car = at(state, 'c1');
  const d = Math.hypot(car.position.x - 1000, car.position.y - 1000);
  assert.ok(Math.abs(d - catalogFor('house').footprint) < 0.5, `the car stops at the house's door, not inside it (${d} m away)`);
  assert.equal(car.properties.at, 'home');
  assert.equal(car.properties.target, undefined, 'the target is cleared on arrival');
  assert.equal(at(state, 'p1').position.z, 0, 'the plane lands');
  assert.ok(events.some((e) => e.kind === 'arrive' && e.ref === 'c1'));
  // Deterministic: the same world runs the same way.
  assert.deepEqual(run(spec, 40).state, state);
});

test('roam keeps a town moving; a rocket carries its crew to space and back; riders move with what they are inside', () => {
  const spec = validateSpec({
    size: { x: 4000, y: 4000, z: 10000 }, space_altitude: 2000,
    entities: [
      { id: 'pad', kind: 'launch_pad', position: { x: 100, y: 100 } },
      { id: 'centre', kind: 'fountain', position: { x: 2000, y: 2000 } },
      { id: 'iss', kind: 'space_station', position: { x: 2000, y: 2000, z: 2600 }, properties: { orbits: 'centre', orbit_radius: 500, orbit_period: 100, orbit_altitude: 2600 } },
      { id: 'r', kind: 'rocket', position: { x: 100, y: 100 } },
      { id: 'crew', kind: 'astronaut', position: { x: 100, y: 100 }, properties: { inside: 'r', target: 'pad' } },
      { id: 'h1', kind: 'house', position: { x: 500, y: 500 } }, { id: 'h2', kind: 'house', position: { x: 900, y: 500 } },
      { id: 'walker', kind: 'person', position: { x: 600, y: 600 } }
    ],
    rules: [
      { id: 'shuttle', type: 'travel', kind: 'rocket', roam: ['space_station', 'launch_pad'] },
      { id: 'orbit', type: 'orbit', kind: 'space_station' },
      { id: 'walk', type: 'travel', kind: 'person', roam: ['house'] },
      { id: 'crew-walks', type: 'travel', kind: 'astronaut' }
    ]
  });
  // A launch, a stay at the station and a landing take a few hundred steps.
  const { state, events } = run(spec, 300);
  assert.ok(events.some((e) => e.kind === 'space' && e.ref === 'r'), 'the rocket reached space');
  assert.ok(events.some((e) => e.kind === 'reentry' && e.ref === 'r'), 'and came back down');
  assert.deepEqual(at(state, 'crew').position, at(state, 'r').position, 'the crew rides with the rocket');
  assert.ok(events.filter((e) => e.kind === 'arrive' && e.ref === 'walker').length >= 2, 'the walker keeps picking new houses');
  const iss = at(state, 'iss');
  assert.equal(iss.position.z, 2600);
  assert.ok(Math.abs(Math.hypot(iss.position.x - 2000, iss.position.y - 2000) - 500) < 0.01, 'the station stays on its orbit');
  assert.equal(spaceAltitude(spec), 2000);
  assert.match(rulesInWords(spec).map((r) => r.text).join(' | '), /rockets head for their target at their own speed, then pick a space station, launch pad to go to next/);
});

test('templates: the town and the universe are valid, under every limit, and alive (people, cars, planes, a rocket and orbits all move)', () => {
  assert.deepEqual([...TEMPLATE_NAMES], ['meadow', 'town', 'universe', 'benin-warri']);
  const town = templateSpec('town');
  const uni = templateSpec('universe');
  for (const s of [town, uni]) {
    assert.ok(s.entities.length <= SANDBOX_LIMITS.entities && s.rules.length <= SANDBOX_LIMITS.rules);
    assert.ok(Buffer.byteLength(JSON.stringify(s)) < SANDBOX_LIMITS.specBytes);
    assert.deepEqual(validateSpec(s), s);
  }
  const kinds = new Set(uni.entities.map((e) => e.kind));
  for (const k of ['person', 'house', 'tower', 'road', 'car', 'bike', 'bus', 'boat', 'plane', 'helicopter', 'rocket', 'space_station', 'star', 'planet', 'moon', 'shuttle']) assert.ok(kinds.has(k), k);
  assert.deepEqual(templateSpec('universe'), uni, 'a template is the same JSON every time');
  const { state, events } = run(uni, 200);
  const moved = (id) => { const a = uni.entities.find((e) => e.id === id).position; const b = at(state, id).position; return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 1; };
  for (const id of ['person-2', 'car-4', 'bus-2', 'plane-1', 'rocket-1', 'planet-2', 'moon-1', 'space_station-1']) assert.ok(moved(id), `${id} moved`);
  assert.ok(events.some((e) => e.kind === 'space'), 'something reached space');
  assert.equal(templateSpec('nope'), null);
});

test('create_world from a template, update_entity to drive (target, get in, get out), get_catalog; all labelled as simulations', async () => {
  const store = createSandboxStore();
  const who = pg1Principal();
  const made = await callSandboxTool(store, who, 'create_world', { name: 'Town', template: 'town' });
  assert.equal(made.result.simulation, true);
  assert.equal(made.result.entity_count, templateSpec('town').entities.length);
  const bad = await callSandboxTool(store, who, 'create_world', { name: 'X', template: 'mars' });
  assert.equal(bad.error.code, 'invalid_template');
  const id = made.result.id;
  // Get a person into a car and send the car to the hospital.
  const inCar = await updateEntity(store, who, { world_id: id, entity_id: 'person-20', set: { inside: 'car-10' } });
  assert.equal(inCar.entity.properties.inside, 'car-10');
  await updateEntity(store, who, { world_id: id, entity_id: 'car-10', set: { target: 'hospital-1' } });
  await stepWorldFor(store, who, { world_id: id, steps: 60 });
  const v = await observeWorld(store, who, { world_id: id });
  const car = v.entities.find((e) => e.id === 'car-10');
  const rider = v.entities.find((e) => e.id === 'person-20');
  assert.deepEqual(rider.position, car.position, 'the passenger rode along');
  // Get out.
  const out = await callSandboxTool(store, who, 'update_entity', { world_id: id, entity_id: 'person-20', clear: ['inside'] });
  assert.equal(out.result.entity.properties.inside, undefined);
  const nowhere = await callSandboxTool(store, who, 'update_entity', { world_id: id, entity_id: 'person-20', set: { inside: 'no-such-car' } });
  assert.equal(nowhere.error.code, 'invalid_world');
  const missing = await callSandboxTool(store, who, 'update_entity', { world_id: id, entity_id: 'ghost', set: { a: 1 } });
  assert.equal(missing.error.code, 'entity_not_found');
  const cat = await callSandboxTool(store, who, 'get_catalog', {});
  assert.ok(cat.result.kinds.some((k) => k.kind === 'rocket' && k.domain === 'space'));
  assert.equal(cat.result.simulation, true);
  for (const t of SANDBOX_TOOLS) assert.match(t.description, /simulation/i, t.name);
});

test('the viewer creates a universe for the operator only', async () => {
  const store = createSandboxStore();
  __setSandboxViewerStore(() => store);
  process.env.USER_API_KEY = 'operator';
  process.env.USER_API_PASS = 'passkey';
  const call = async (body) => { const out = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } }; await sandboxViewer({ method: 'POST', headers: {}, socket: { remoteAddress: '10.1.1.1' }, body }, out); return out; };
  assert.equal((await call({ op: 'create' })).statusCode, 401);
  const ok = await call({ op: 'create', user: 'operator', pass: 'passkey' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.world.entities.length, templateSpec('universe').entities.length);
  assert.equal(ok.body.world.label, 'Simulation');
  assert.equal(ok.body.world.space_altitude, 2000);
  __setSandboxViewerStore(null);
});

test('blind: the subject can get into a car, ride it somewhere, see height and space in plain words, and get out; nothing leaks', () => {
  const base = { size: { x: 4000, y: 4000, z: 10000 }, space_altitude: 2000, entities: [
    { id: 'c', kind: 'car', position: { x: 2002, y: 2000 }, properties: { description: 'a small red car' } },
    { id: 'shop', kind: 'shop', position: { x: 2600, y: 2000 }, properties: { description: 'a corner shop with a striped awning' } },
    { id: 'r', kind: 'rocket', position: { x: 1995, y: 2000 }, properties: { description: 'a tall white rocket' } },
    { id: 'high', kind: 'space_station', position: { x: 1990, y: 2000, z: 9000 }, properties: { description: 'a turning ring of metal' } }
  ] };
  assert.deepEqual(BLIND_TOOL_NAMES.slice(-3), ['enter', 'leave', 'go']);
  const spec = subjectSpec(base, []);
  let o = act(spec, null, 'enter', { thing: 'red car' }, { anomalies: [] });
  assert.match(o.text, /You get into a small red car\./);
  assert.match(o.text, /You are inside a small red car\./);
  o = act(spec, o.state, 'go', { place: 'corner shop' }, { anomalies: [] });
  assert.match(o.text, /You (?:head toward|arrive near) a corner shop/);
  const me = o.state.entities.find((e) => e.id === 'you');
  assert.ok(me.position.x > 2002, 'the car carried the subject toward the shop');
  o = act(spec, o.state, 'leave', {}, { anomalies: [] });
  assert.match(o.text, /You get out of a small red car\./);
  assert.equal(act(spec, o.state, 'leave', {}, { anomalies: [] }).text.split('\n')[0], 'You are not inside anything.');
  // Up in the rocket, into space.
  let s2 = act(spec, null, 'enter', { thing: 'rocket' }, { anomalies: [] });
  // A launch, not a jump: up through the sky a step at a time.
  for (let i = 0; i < 80 && !/the sky is black/.test(s2.text); i++) s2 = act(spec, s2.state, 'go', { place: 'ring of metal' }, { anomalies: [] });
  assert.match(s2.text, /the sky is black and full of unblinking stars/);
  assert.match(act(spec, s2.state, 'leave', {}, { anomalies: [] }).text, /It is a long way down/);
  for (const t of [o.text, s2.text]) assert.equal(containsBanned(t), false, t);
  assert.equal(act(spec, null, 'go', { place: 'the moon base' }, { anomalies: [] }).text, 'You do not know where that is.');
});
