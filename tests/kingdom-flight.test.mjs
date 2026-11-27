// PG1 City flight rules (public/kingdom/kingdom-flight.js): pure, on boxes
// built here. The drawn city is checked in tests/browser/kingdom-flight.browser.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { footprint, flightFloor, ringAltitude, keepClear, unlift, flyTowards, insideBox, DRONE_RADIUS, DRONE_CLEARANCE, CLIMB_RATE, DESCENT_RATE, TURN_RATE, LIFT_ACCEL } from '../public/kingdom/kingdom-flight.js';
import { makeObstacleIndex } from '../public/kingdom/kingdom-world.js';

test('footprint: exact for a turned box, the diagonal for a twisted tower', () => {
  assert.deepEqual(footprint(20, 10, 0), { hw: 10, hd: 5 });
  const f = footprint(20, 10, 0.3);
  assert.ok(Math.abs(f.hw - (Math.cos(0.3) * 20 + Math.sin(0.3) * 10) / 2) < 1e-9);
  assert.ok(f.hd > 5, 'a turned box reaches further than its own depth');
  const tw = footprint(20, 10, 0, 'twist'); assert.equal(tw.hw, Math.hypot(20, 10) / 2);
});

test('flightFloor: the roof plus the clearance within the drone radius; open ground 0', () => {
  const ob = makeObstacleIndex([{ x: 0, z: 0, hw: 10, hd: 10, top: 80 }]);
  assert.equal(flightFloor(ob, 0, 0), 80 + DRONE_CLEARANCE);
  assert.equal(flightFloor(ob, 10 + DRONE_RADIUS - 0.5, 0), 80 + DRONE_CLEARANCE);
  assert.equal(flightFloor(ob, 10 + DRONE_RADIUS + 1, 0), 0);
});

test('a patrol ring is raised over every roof it passes, and never inside a box', () => {
  const boxes = [{ x: 90, z: 0, hw: 12, hd: 12, top: 150 }, { x: 0, z: -90, hw: 8, hd: 8, top: 60 }];
  const ob = makeObstacleIndex(boxes);
  const alt = ringAltitude(ob, 90, 70);
  assert.equal(alt, 150 + DRONE_CLEARANCE);
  const aabb = boxes.map((b) => ({ min: [b.x - b.hw, 0, b.z - b.hd], max: [b.x + b.hw, b.top, b.z + b.hd] }));
  for (let k = 0; k < 3600; k++) { const a = (k / 3600) * Math.PI * 2; assert.equal(insideBox(aabb, Math.sin(a) * 90, alt, -Math.cos(a) * 90), null); }
});

test('keepClear: a drone flying at a tower climbs before it, never enters it, and moves smoothly up and down', () => {
  const ob = makeObstacleIndex([{ x: 0, z: 0, hw: 15, hd: 15, top: 120 }]);
  const box = [{ min: [-15, 0, -15], max: [15, 120, 15] }];
  const dt = 1 / 30;
  const a = { x: -400, y: 40, z: 0 }; let climbedEarly = false; let prevY = a.y; let maxUp = 0; let maxDown = 0; let reversals = 0; let lastDir = 0; let prevV = 0; let maxDv = 0;
  for (let i = 0; i < 600; i++) {
    // The actors' frame: back to the flight's own height, a flight step at 60 m/s towards a target beyond the tower at 40 m, then the lift.
    unlift(a);
    flyTowards(a, { x: 400, y: 40, z: 0 }, 60, dt);
    keepClear(ob, a, dt);
    if (a.x < -15 - DRONE_RADIUS && a.y >= 120) climbedEarly = true;
    assert.equal(insideBox(box, a.x, a.y, a.z), null, `inside at x=${a.x.toFixed(1)} y=${a.y.toFixed(1)}`);
    const vy = (a.y - prevY) / dt; if (i > 0) maxDv = Math.max(maxDv, Math.abs(vy - prevV)); prevV = vy; maxUp = Math.max(maxUp, vy); maxDown = Math.min(maxDown, vy);
    const dir = Math.abs(vy) < 0.05 ? 0 : Math.sign(vy); if (dir && lastDir && dir !== lastDir) reversals++; if (dir) lastDir = dir;
    prevY = a.y;
  }
  assert.ok(climbedEarly, 'over the roof before reaching the wall');
  assert.ok(maxUp <= CLIMB_RATE + 1e-6, `climbs at most ${CLIMB_RATE} m/s (${maxUp.toFixed(1)})`);
  assert.ok(-maxDown <= DESCENT_RATE + 1e-6, `comes down at most ${DESCENT_RATE} m/s, never drops (${(-maxDown).toFixed(1)})`);
  assert.equal(reversals, 1, 'one climb, then one descent: no bouncing');
  assert.ok(maxDv <= LIFT_ACCEL * dt + 1e-6, `climbs and descents start and end softly (${(maxDv / dt).toFixed(0)} m/s²)`);
  assert.ok(Math.abs(a.y - 40) < 1, 'back at its own height after the tower');
});

test('a slow patrol glides: the same distance every frame, no stop-start steps; turns never snap', () => {
  const dt = 1 / 30; const ring = 45; const a = { x: 0, y: 70, z: -ring, heading: 0 };
  const steps = []; const turns = [];
  for (let i = 0; i < 300; i++) {
    const ang = -i * dt * 0.05; // 2.25 m/s round a 45 m ring (the slowest sentinel)
    const x0 = a.x; const z0 = a.z; const h0 = a.heading;
    flyTowards(a, { x: Math.sin(ang) * ring, y: 70, z: -Math.cos(ang) * ring }, 60, dt);
    if (i > 2) { steps.push(Math.hypot(a.x - x0, a.z - z0)); turns.push(Math.abs(Math.atan2(Math.sin(a.heading - h0), Math.cos(a.heading - h0)))); }
  }
  const lo = Math.min(...steps); const hi = Math.max(...steps);
  assert.ok(lo > 0, 'moves every frame');
  assert.ok(hi / lo < 1.05, `even steps (${lo.toFixed(3)}-${hi.toFixed(3)} m)`);
  assert.ok(Math.max(...turns) <= TURN_RATE * dt + 1e-9, 'turns at most TURN_RATE');
  // A target behind it: it turns round over several frames, not in one.
  const b = { x: 0, y: 50, z: 0, heading: 0 };
  flyTowards(b, { x: 0, y: 50, z: -100 }, 40, dt);
  assert.ok(Math.abs(b.heading) <= TURN_RATE * dt + 1e-9, 'no snap to face backwards');
});
