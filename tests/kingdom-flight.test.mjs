// PG1 City flight rules (public/kingdom/kingdom-flight.js): pure, on boxes
// built here. The drawn city is checked in tests/browser/kingdom-flight.browser.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { footprint, flightFloor, ringAltitude, keepClear, insideBox, DRONE_RADIUS, DRONE_CLEARANCE } from '../public/kingdom/kingdom-flight.js';
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

test('keepClear: a drone flying at a tower climbs before it and never enters it', () => {
  const ob = makeObstacleIndex([{ x: 0, z: 0, hw: 15, hd: 15, top: 120 }]);
  const box = [{ min: [-15, 0, -15], max: [15, 120, 15] }];
  const a = { x: -400, y: 40, z: 0 }; let climbedEarly = false;
  for (let i = 0; i < 400; i++) {
    // The actors' moveTo: 60 m/s straight at a target beyond the tower, at 40 m.
    const dx = 400 - a.x; const dy = 40 - a.y; const d = Math.hypot(dx, dy); const k = Math.min(1, (60 * 0.05) / d); a.x += dx * k; a.y += dy * k;
    keepClear(ob, a, 0.05);
    if (a.x < -15 - DRONE_RADIUS && a.y >= 120) climbedEarly = true;
    assert.equal(insideBox(box, a.x, a.y, a.z), null, `inside at x=${a.x.toFixed(1)} y=${a.y.toFixed(1)}`);
  }
  assert.ok(climbedEarly, 'over the roof before reaching the wall');
});
