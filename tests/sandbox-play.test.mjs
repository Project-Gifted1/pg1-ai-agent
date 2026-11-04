/**
 * Sandbox Play (api/sandbox.mjs, lib/sandbox/worlds.mjs, the engine's
 * vehicleSpace, the viewer's pace and keyframes):
 *   1. stepping a PG1 world from the viewer counts against steps only, never
 *      changes; an invited agent's step still counts a change; a quota that
 *      stops Play says which one and when it resets
 *   2. Play runs 300 steps in a row on the benin-warri template through the
 *      API, with no refusal
 *   3. faster paces ask for several steps a call and get compact keyframes
 *   4. natural pace: every catalogue speed is real-life fast at 5.7 s a step;
 *      the stride matches the speed (no foot sliding)
 *   5. no two vehicles ever overlap along the viewer's way (2,000 steps of
 *      the universe and benin-warri templates, 10 points a step)
 *
 * Before this change (main at 6b92c31, the same 2,000 steps, measured with
 * the viewer's old Catmull-Rom interpolation): universe 343,074 overlapping
 * samples, watchdog corrections { moved apart: 210, unstuck: 1673 };
 * benin-warri 155 overlapping samples, { moved apart: 235, unstuck: 2 }.
 * The test reports the numbers after (t.diagnostic).
 *
 * Run with: node --test tests/sandbox-play.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSandboxStore, __resetSandboxMemory } from '../lib/sandbox/store.mjs';
import { createWorld, stepWorldFor, pg1Principal, inviteAgent, resolveSandboxKey, PG1_QUOTA, quotaResetsAt } from '../lib/sandbox/worlds.mjs';
import sandboxViewer, { __setSandboxViewerStore, VIEWER_MAX_STEPS } from '../api/sandbox.mjs';
import { templateSpec } from '../lib/sandbox/templates.mjs';
import { initialState, stepWorld, validateSpec } from '../lib/sandbox/engine.mjs';
import { CATALOG, STEP_SECONDS, catalogFor } from '../lib/sandbox/catalog.mjs';
import { FLIGHT, HIGHWAY_SPEED } from '../lib/sandbox/movement.mjs';
import { isVehicleBody, vehicleBodyOf } from '../lib/sandbox/watchdog.mjs';
import * as VP from '../public/sandbox/vehicle-path.js';
import { gait, groundCovered } from '../public/sandbox/gait.js';

const ROOT = new URL('../', import.meta.url);
const OP = { user: 'op-play', pass: 'pass-play-sandbox' };

beforeEach(() => { __resetSandboxMemory(); process.env.USER_API_KEY = OP.user; process.env.USER_API_PASS = OP.pass; });

function res() {
  return { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } };
}
function viewer(store) {
  __setSandboxViewerStore(() => store);
  return async (body) => { const r = res(); await sandboxViewer({ method: 'POST', headers: {}, socket: { remoteAddress: '10.41.0.1' }, body: { ...body, ...OP } }, r); return r; };
}

// --- 1. quotas ---------------------------------------------------------------------------------

test('1: the viewer\'s steps count against steps only, never changes; an agent\'s step still counts a change', async () => {
  const store = createSandboxStore();
  const pg1 = pg1Principal();
  const w = await createWorld(store, pg1, { name: 'Garden', template: 'meadow' });
  const changes0 = await store.actionsToday('pg1');
  assert.equal(changes0, 1, 'creating the world is a change');
  const call = viewer(store);
  for (let i = 0; i < 5; i++) assert.equal((await call({ op: 'step', id: w.id })).statusCode, 200);
  assert.equal(await store.actionsToday('pg1'), changes0, 'Play uses no changes');
  assert.equal(await store.stepsToday('pg1'), 5, 'Play uses steps');
  // An invited agent: its step is an agent call, a change.
  const inv = await inviteAgent(store, { label: 'Agent' });
  const agent = await resolveSandboxKey(store, inv.key);
  const theirs = await createWorld(store, agent, { name: 'Theirs', template: 'meadow' });
  const before = await store.actionsToday(agent.owner);
  await stepWorldFor(store, agent, { world_id: theirs.id, steps: 1 });
  assert.equal(await store.actionsToday(agent.owner), before + 1);
  // PG1's own world missions step as an agent too (no asViewer): a change.
  await stepWorldFor(store, pg1, { world_id: w.id, steps: 1 });
  assert.equal(await store.actionsToday('pg1'), changes0 + 1);
});

test('1: with PG1\'s changes all used, Play still runs; when steps run out the refusal names the quota and when it resets', async () => {
  const store = createSandboxStore();
  const pg1 = pg1Principal();
  const w = await createWorld(store, pg1, { name: 'Garden', template: 'meadow' });
  for (let i = 0; i < PG1_QUOTA.max_actions_per_day; i++) await store.addAction('pg1');
  const call = viewer(store);
  const ok = await call({ op: 'step', id: w.id });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  await store.addSteps('pg1', PG1_QUOTA.max_steps_per_day - (await store.stepsToday('pg1')));
  const refused = await call({ op: 'step', id: w.id });
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.body.error, 'quota_steps');
  assert.equal(refused.body.quota, 'steps');
  assert.equal(refused.body.max, 5000);
  assert.match(refused.body.resets_at, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.equal(quotaResetsAt(Date.UTC(2026, 9, 28, 23, 59)), '2026-10-29T00:00:00.000Z');
  // The page shows a banner for it: which quota and when it resets.
  const html = readFileSync(new URL('public/index.html', ROOT), 'utf8');
  assert.match(html, /id="sandbox-quota" role="alert" hidden/);
  assert.match(html, /function showSandboxQuota\(err\)/);
  assert.match(html, /PG1's daily steps quota/);
  assert.match(html, /It resets at 00:00 UTC/);
  assert.match(html, /if \(e\.quota\) showSandboxQuota\(e\)/);
});

// --- 2. 300 steps of Play ---------------------------------------------------------------------------

test('2: Play runs 300 steps in a row on the benin-warri template through the API, with no refusal', { timeout: 300000 }, async () => {
  const store = createSandboxStore();
  const w = await createWorld(store, pg1Principal(), { name: 'Benin–Warri c. 1610', template: 'benin-warri' });
  const call = viewer(store);
  const changes = await store.actionsToday('pg1');
  for (let i = 1; i <= 300; i++) {
    const r = await call({ op: 'step', id: w.id, steps: 1 });
    assert.equal(r.statusCode, 200, `step ${i}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.world.tick, i);
  }
  assert.equal(await store.stepsToday('pg1'), 300);
  assert.equal(await store.actionsToday('pg1'), changes, 'not one change used');
});

// --- 3. paces and keyframes ---------------------------------------------------------------------------

test('3: a faster pace asks for several steps a call and gets each step\'s positions as compact keyframes', async () => {
  const store = createSandboxStore();
  const w = await createWorld(store, pg1Principal(), { name: 'Town', template: 'town' });
  const call = viewer(store);
  const r = await call({ op: 'step', id: w.id, steps: 4 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.world.tick, 4);
  assert.equal(r.body.keyframes.length, 3, 'the steps before the last; the world itself is the last');
  assert.deepEqual(r.body.keyframes.map((k) => k.tick), [1, 2, 3]);
  const row = r.body.keyframes[0].m[0];
  assert.equal(typeof row[0], 'string');
  assert.ok(row.slice(1, 4).every((n) => typeof n === 'number'));
  assert.equal((await call({ op: 'step', id: w.id, steps: 1 })).body.keyframes, undefined, 'one step: no keyframes');
  assert.equal((await call({ op: 'step', id: w.id, steps: VIEWER_MAX_STEPS + 1 })).statusCode, 400);
  // The keyframes are the very positions the engine went through.
  const spec = validateSpec(templateSpec('town'));
  const seen = [];
  stepWorld(spec, initialState(spec), 3, { onStep: (tick, ents) => seen.push(new Map(ents.map((e) => [e.id, e.position]))) });
  const one = r.body.keyframes[1].m.find((x) => seen[1].get(x[0]));
  assert.ok(Math.abs(seen[1].get(one[0]).x - one[1]) < 0.01);
  // The page: Natural (5.7 s a step), 2x, 5x and 10x, kept on the device, at most one call about every 2 s.
  const html = readFileSync(new URL('public/index.html', ROOT), 'utf8');
  assert.match(html, /<option value="1">Natural<\/option><option value="2">2×<\/option><option value="5">5×<\/option><option value="10">10×<\/option>/);
  assert.match(html, /const SANDBOX_NATURAL_MS = 5700;/);
  assert.match(html, /const SANDBOX_CALL_MS = 2000;/);
  assert.match(html, /localStorage\.setItem\(SANDBOX_PACE_KEY/);
  const perCall = (pace) => Math.max(1, Math.min(10, Math.ceil(2000 / Math.round(5700 / pace))));
  for (const pace of [1, 2, 5, 10]) assert.ok(perCall(pace) * Math.round(5700 / pace) >= 1900, `${pace}x: one call per ${perCall(pace)} steps`);
  assert.deepEqual([1, 2, 5, 10].map(perCall), [1, 1, 2, 4]);
});

// --- 4. natural pace ----------------------------------------------------------------------------------------

test('4: at the Natural pace (5.7 s a step) every speed is real life: walking, bikes, cars, buses, boats, canoes, planes', () => {
  assert.equal(STEP_SECONDS, 5.7);
  const ms = (kind) => CATALOG[kind].speed / STEP_SECONDS;
  const within = (kinds, lo, hi) => { for (const k of kinds) assert.ok(ms(k) >= lo && ms(k) <= hi, `${k}: ${ms(k).toFixed(2)} m/s, not ${lo} to ${hi}`); };
  within(['person', 'child', 'visitor', 'porter', 'alien', 'astronaut'], 1.2, 1.5);
  within(['bike'], 4, 6);
  within(['car', 'taxi'], 11, 15);
  assert.ok(Math.abs(HIGHWAY_SPEED / STEP_SECONDS - 25) < 1, 'about 25 m/s on a main road');
  within(['bus', 'truck'], 10, 14);
  within(['motorbike'], 11, 16);
  within(['police_car', 'ambulance', 'fire_truck'], 15, 21);
  within(['tractor'], 3, 8);
  within(['canoe', 'kayak'], 1.2, 2.5);
  within(['carrack'], 2, 4);
  within(['boat', 'sailboat', 'yacht', 'ship', 'ferry'], 4, 10);
  within(['patrol_boat', 'jet_ski'], 9, 18);
  within(['horse'], 3, 6);
  within(['dog', 'cat', 'fox'], 1.5, 3);
  within(['cow', 'goat', 'fowl'], 0.4, 1.2);
  within(['bird'], 8, 12);
  within(['helicopter'], 35, 70);
  within(['small_plane'], 45, 70);
  within(['plane'], 90, 140);
  within(['jet'], 180, 260);
  // On the ground: taxiing 5 to 10 m/s; rotating and approaching near take-off speed.
  for (const k of ['plane', 'small_plane', 'jet']) assert.ok(FLIGHT[k].taxi / STEP_SECONDS >= 5 && FLIGHT[k].taxi / STEP_SECONDS <= 10, `${k} taxis at ${(FLIGHT[k].taxi / STEP_SECONDS).toFixed(1)} m/s`);
  assert.ok(FLIGHT.small_plane.vr / STEP_SECONDS >= 22 && FLIGHT.small_plane.vr / STEP_SECONDS <= 32);
  assert.ok(FLIGHT.plane.vr / STEP_SECONDS >= 50 && FLIGHT.plane.vr / STEP_SECONDS <= 85);
  assert.ok(FLIGHT.jet.vr / STEP_SECONDS >= 50 && FLIGHT.jet.vr / STEP_SECONDS <= 90);
  // A day of 240 steps lasts about 23 minutes; a walker covers about 1.4 m/s.
  assert.ok(Math.abs((240 * STEP_SECONDS) / 60 - 22.8) < 0.1);
  assert.ok(Math.abs(ms('person') - 1.4) < 0.05);
});

test('4: the stride matches the speed, walking or running: the feet never slide', () => {
  for (const hip of [0.88, 0.6, 0.45]) {
    for (const v of [0.6, 1.0, 1.4, 2.0, 3.5, 6]) {
      const g = gait(v, hip);
      assert.ok(Math.abs(groundCovered(g, 10) - v * 10) < 1e-6, `hip ${hip}, ${v} m/s`);
      assert.equal(g.run, v > 2.6);
      assert.ok(g.amp > 0 && g.amp <= 0.8);
    }
  }
  assert.ok(gait(5, 0.88).stepLength > gait(1.4, 0.88).stepLength, 'a runner strides further');
  assert.deepEqual(gait(0), { amp: 0, rate: 0, stepLength: 0, run: false });
  const scene = readFileSync(new URL('public/sandbox/sandbox-scene.js', ROOT), 'utf8');
  assert.match(scene, /gait\(moving \? speed : 0, legPart\.r\)/);
});

// --- 5. no vehicle through another --------------------------------------------------------------------------

test('the viewer\'s vehicle-path.js is the engine\'s, byte for byte', () => {
  assert.equal(readFileSync(new URL('public/sandbox/vehicle-path.js', ROOT), 'utf8'), readFileSync(new URL('lib/sandbox/vehicle-path.mjs', ROOT), 'utf8'));
  const scene = readFileSync(new URL('public/sandbox/sandbox-scene.js', ROOT), 'utf8');
  assert.match(scene, /from '\.\/vehicle-path\.js'/);
  assert.match(scene, /const q = pointOnWay\(st\.pts, u, wayPt\)/);
});

const WATER = new Set(['water']);
function overlapsOver(name, steps) {
  const spec = validateSpec(templateSpec(name));
  let st = initialState(spec);
  const fixes = {}; let watchdogEvents = 0; let samples = 0;
  const bad = [];
  for (let i = 0; i < steps; i++) {
    const before = new Map(st.entities.map((e) => [e.id, { ...e.position }]));
    const out = stepWorld(spec, st, 1);
    st = out.state;
    watchdogEvents += out.events.filter((e) => e.kind === 'watchdog').length;
    for (const [k, v] of Object.entries(out.fixes || {})) fixes[k] = (fixes[k] || 0) + v;
    const index = new Map(st.entities.map((e) => [e.id, e]));
    // Every road vehicle and boat at the surface, not riding in another, as the viewer draws it.
    const ways = st.entities.filter((e) => isVehicleBody(e.kind) && before.has(e.id) && (e.position.z || 0) <= 1 && (before.get(e.id).z || 0) <= 1 && !(typeof e.properties.inside === 'string' && index.has(e.properties.inside)))
      .map((e) => ({ id: e.id, wet: WATER.has(catalogFor(e.kind).domain), body: vehicleBodyOf(e.kind), hdg: (Number(e.properties.hdg) || 0) * Math.PI / 180, pts: VP.wayPoints(before.get(e.id), e.position, VP.parseWaypoints(e.properties.wp)) }));
    for (let k = 1; k <= VP.VEHICLE_SAMPLES; k++) {
      const boxes = ways.map((w) => {
        const p = VP.pointOnWay(w.pts, k / VP.VEHICLE_SAMPLES);
        const [hx, hy] = p.hx || p.hy ? [p.hx, p.hy] : [Math.cos(w.hdg), Math.sin(w.hdg)];
        return { w, b: VP.footprint(p.x, p.y, hx, hy, w.body[0], w.body[1]) };
      });
      for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
        samples++;
        if (boxes[a].w.wet !== boxes[b].w.wet) continue;
        if (VP.boxesOverlap(boxes[a].b, boxes[b].b)) bad.push(`step ${i + 1}, point ${k}: ${boxes[a].w.id} and ${boxes[b].w.id}`);
      }
    }
  }
  return { bad, fixes, watchdogEvents, samples };
}

for (const name of ['universe', 'benin-warri']) {
  test(`5: 2,000 steps of the ${name} template: no two vehicles' footprints ever overlap along the viewer's way`, { timeout: 900000 }, (t) => {
    const r = overlapsOver(name, 2000);
    t.diagnostic(`${name}: watchdog corrections after ${JSON.stringify(r.fixes)}; watchdog events ${r.watchdogEvents}; pairs checked ${r.samples}`);
    assert.deepEqual(r.bad.slice(0, 10), [], `${r.bad.length} overlapping samples`);
  });
}
