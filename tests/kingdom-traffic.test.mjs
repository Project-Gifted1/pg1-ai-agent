/**
 * PG1 City's traffic (public/kingdom/kingdom-traffic.js): long simulated
 * runs, checked every frame.
 *
 *   - zero frames where two vehicle bodies overlap (the sandbox's own
 *     collision check), on the roads, the river and the tram line;
 *   - no vehicle ever over the water: only the main bridge crosses, on its
 *     deck and ramps;
 *   - vehicles stop at red: none enters a junction on amber or red, and a
 *     red approach holds a stopped queue at its stop line;
 *   - queues form on red and clear on green;
 *   - nobody on a zebra is ever inside a vehicle's body;
 *   - no gridlock: the network keeps flowing for an hour;
 *   - boats keep their lanes and spacing, and clear of event boats; the
 *     tram stops at its stations.
 * Run with: node --test tests/kingdom-traffic.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTraffic, buildNetwork, roadHeight, signalFor, pedPhase, turnOf, linkPoint, inRiver,
  RIVER_Z, RIVER_HALF, BRIDGE_X, BRIDGE_DECK_Y, PLAZA_CLEAR, LANE_OFFSET, CYCLE, PHASES, MIN_GAP, VEHICLE_TYPES
} from '../public/kingdom/kingdom-traffic.js';

const DT = 1 / 15;

test('the network: lanes both ways, on land only; only the road bridge crosses the river; the tower plaza is traffic-free', () => {
  const net = buildNetwork();
  for (const l of net.links) {
    // Its reverse exists: every road carries traffic both ways.
    assert.ok(net.links.some((o) => o.from === l.to && o.to === l.from), 'both directions');
    for (let s = 0; s <= l.len; s += 4) {
      const p = linkPoint(l, s);
      assert.ok(!Number.isNaN(p.y), `lane point over water at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
    }
    const crosses = Math.min(l.from.z, l.to.z) < RIVER_Z && Math.max(l.from.z, l.to.z) > RIVER_Z;
    if (crosses) assert.equal(l.from.x, BRIDGE_X, 'only the bridge avenue crosses');
  }
  // The deck and its ramps: up to the deck height over the water, down to the ground on the banks.
  assert.equal(roadHeight(BRIDGE_X + 3, RIVER_Z), BRIDGE_DECK_Y);
  assert.equal(roadHeight(BRIDGE_X + 3, RIVER_Z + 200), 0);
  assert.ok(Number.isNaN(roadHeight(320, RIVER_Z)), 'no road over the water off the bridge');
  // The tower plaza is traffic-free: no lane point within PLAZA_CLEAR of the tower.
  for (const l of net.links) for (let s = 0; s <= l.len; s += 2) { const p = linkPoint(l, s); assert.ok(Math.hypot(p.x, p.z) >= PLAZA_CLEAR - LANE_OFFSET, `lane through the plaza at ${p.x.toFixed(0)},${p.z.toFixed(0)}`); }
  // Every junction has a way on (no dead end that would trap a vehicle).
  for (const j of net.junctions) for (const l of j.in) assert.ok(j.out.some((o) => o.to !== l.from), `dead end at ${j.x},${j.z}`);
  // Dublin drives on the left: a lane heading east (+x) lies north (-z) of its centre line.
  const east = net.links.find((l) => l.dx === 1 && l.to.out.some((o) => o.dz === -1));
  assert.ok(linkPoint(east, 20).z < east.from.z);
  assert.equal(turnOf(east, east.to.out.find((o) => o.dz === -1)), 'left');
});

test('signals: per-axis phases with amber, all red and a pedestrian phase; never both axes green', () => {
  const net = buildNetwork();
  const j = net.junctions.find((x) => !x.edge);
  assert.equal(CYCLE, 2 * (PHASES.green + PHASES.amber + PHASES.allRed + PHASES.ped));
  let sawPed = 0;
  for (let t = 0; t < CYCLE * 2; t += 0.25) {
    const x = signalFor(j, 'x', t); const z = signalFor(j, 'z', t);
    assert.ok(!(x !== 'stop' && z !== 'stop'), `both axes open at t=${t}`);
    if (pedPhase(j, t)) { sawPed++; assert.equal(x, 'stop'); assert.equal(z, 'stop'); }
  }
  assert.ok(sawPed > 0);
});

test('a long run: zero overlapping frames, nothing in the water, nobody hit on a zebra', () => {
  const tr = createTraffic({ density: 1, seed: 5 });
  assert.ok(tr.vehicles.length > 500, `${tr.vehicles.length} vehicles`);
  let frames = 0; let overlapFrames = 0; let water = 0; let pedHits = 0; let crossings = 0;
  for (let i = 0; i < 9000; i++) { // 10 simulated minutes
    tr.step(DT);
    frames++;
    if (tr.overlaps().length) overlapFrames++;
    if (tr.pedHits().length) pedHits++;
    crossings += tr.peds.filter((p) => p.state === 'cross').length ? 1 : 0;
    for (const v of tr.vehicles) {
      const h = roadHeight(v.x, v.z);
      if (Number.isNaN(h)) water++;
      else if (Math.abs(v.y - h) > 0.01 && !v.inJ) water++;
    }
    for (const b of tr.boats) if (!inRiver(b.z) || Math.abs(b.z - RIVER_Z) > RIVER_HALF - b.wid) water += 1000;
  }
  assert.equal(overlapFrames, 0, `${overlapFrames} of ${frames} frames had overlapping vehicles`);
  assert.equal(water, 0, 'a vehicle off the road surface or a boat off the water');
  assert.equal(pedHits, 0, 'a person on a zebra inside a vehicle');
  assert.ok(crossings > frames * 0.3, 'people do cross');
});

test('vehicles stop at red: none enters a junction unless its own signal is green', () => {
  const tr = createTraffic({ density: 1, seed: 9 });
  const entered = new Set();
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    tr.step(DT);
    for (const j of tr.net.junctions) for (const v of j.occupants) {
      if (entered.has(v.id + ':' + j.id + ':' + v.link.id)) continue;
      entered.add(v.id + ':' + j.id + ':' + v.link.id);
      // The front has only just passed the stop line: the signal it saw was green.
      checked++;
      assert.equal(signalFor(j, v.link.axis, v.inJ.at), 'go', 'entered on amber or red');
    }
    // On a red approach no front vehicle is past its stop line.
    for (const l of tr.net.links) {
      if (l.to.edge || signalFor(l.to, l.axis, tr.time) === 'go') continue;
      const head = l.vehicles[0];
      if (head) assert.ok(head.s <= l.stopAt + 1e-6, `past the stop line on red by ${(head.s - l.stopAt).toFixed(2)} m`);
    }
  }
  assert.ok(checked > 200, `${checked} entries checked`);
  assert.equal(tr.stats.enteredOnRed, 0);
});

test('queues form on red and clear on green', () => {
  const tr = createTraffic({ density: 1.4, seed: 21 });
  // The busiest approach after a warm-up.
  for (let i = 0; i < 1500; i++) tr.step(DT);
  const approaches = tr.net.links.filter((l) => !l.to.edge);
  let formed = 0; let cleared = 0;
  const history = new Map();
  for (let i = 0; i < Math.ceil(CYCLE * 3 / DT); i++) {
    tr.step(DT);
    for (const l of approaches) {
      const sig = signalFor(l.to, l.axis, tr.time);
      const q = tr.queueAt(l);
      const h = history.get(l) || { redMax: 0, greenMin: Infinity, sawGreenAfterRed: false };
      if (sig !== 'go') h.redMax = Math.max(h.redMax, q);
      else if (h.redMax >= 2) { h.sawGreenAfterRed = true; h.greenMin = Math.min(h.greenMin, q); }
      history.set(l, h);
    }
  }
  for (const h of history.values()) {
    if (h.redMax >= 2) formed++;
    if (h.sawGreenAfterRed && h.greenMin < h.redMax) cleared++;
  }
  assert.ok(formed >= 20, `${formed} queues formed on red`);
  assert.ok(cleared >= formed * 0.8, `${cleared} of ${formed} queues shrank on green`);
  // Stopped vehicles in a queue keep at least the minimum gap.
  for (const l of approaches) for (let i = 1; i < l.vehicles.length; i++) assert.ok(l.vehicles[i - 1].s - l.vehicles[i - 1].len - l.vehicles[i].s >= MIN_GAP - 1e-6);
});

test('no gridlock: the network keeps flowing for an hour', () => {
  const tr = createTraffic({ density: 1, seed: 3 });
  const per = [];
  let last = 0;
  for (let i = 1; i <= Math.round(3600 / 0.1); i++) {
    tr.step(0.1);
    if (i % 3000 === 0) { per.push(tr.stats.entered - last); last = tr.stats.entered; }
  }
  const first = per[0];
  for (const n of per) assert.ok(n > first * 0.5, `throughput fell to ${n} (from ${first}) per 5 minutes: ${per.join(', ')}`);
  assert.equal(tr.overlaps().length, 0);
});

test('spawning: only into free space at the edge; despawning at the edge', () => {
  const tr = createTraffic({ density: 1, seed: 13 });
  for (let i = 0; i < 3000; i++) tr.step(DT);
  assert.ok(tr.stats.spawned > 50 && tr.stats.despawned > 50, `${tr.stats.spawned} in, ${tr.stats.despawned} out`);
  assert.ok(tr.vehicles.length <= tr.target);
  for (const l of tr.net.links) for (let i = 1; i < l.vehicles.length; i++) assert.ok(l.vehicles[i - 1].s >= l.vehicles[i].s, 'lane order kept');
});

test('boats: lanes kept, never through each other, and clear of the boats real events bring', () => {
  const tr = createTraffic({ density: 1, seed: 4 });
  const lane = tr.boats[0].lane;
  // An event boat sitting in the lane ahead of the first boat.
  const lead = tr.boats.filter((b) => b.lane === lane).sort((a, b) => (b.x - a.x) * lane.dir)[0];
  const external = [{ x: lead.x + lane.dir * 120, z: lane.z, len: 15, wid: 4.2 }];
  for (let i = 0; i < 3000; i++) {
    tr.step(DT, { external });
    for (const b of tr.boats) {
      assert.equal(b.z, b.lane.z, 'a boat left its lane');
      for (const e of external) if (Math.abs(e.z - b.z) < 5) assert.ok(Math.abs(e.x - b.x) >= (e.len + b.len) / 2 - 0.01, 'a boat ran into an event boat');
    }
    assert.equal(tr.overlaps().filter((h) => h[0] === 'boat').length, 0);
  }
});

test('the tram: two lines on separate tracks, slowing into stations and dwelling there', () => {
  const tr = createTraffic({ density: 0.2, seed: 2 });
  assert.equal(tr.trams.length, 2);
  assert.notEqual(tr.trams[0].z, tr.trams[1].z);
  const dwellAt = new Set();
  for (let i = 0; i < 20000; i++) { tr.step(0.1); for (const t of tr.trams) if (t.dwell > 0 && tr.stations.includes(t.x)) dwellAt.add(t.x); }
  assert.ok(dwellAt.size >= 3, `stopped at ${[...dwellAt].join(', ')}`);
});

test('vehicle bodies are the sandbox sizes, and buses keep straight on wherever a straight exit exists', () => {
  assert.equal(VEHICLE_TYPES.car.len, 4.5);
  assert.equal(VEHICLE_TYPES.bus.len, 12);
  const tr = createTraffic({ density: 1, seed: 8 });
  for (let i = 0; i < 2000; i++) {
    tr.step(DT);
    for (const v of tr.vehicles) if (v.type === 'bus' && v.inJ && v.link.to.out.some((o) => turnOf(v.link, o) === 'straight')) assert.equal(turnOf(v.link, v.next), 'straight');
  }
});
