/**
 * PG1 City's lane-based traffic over 10,000 steps (public/kingdom/kingdom-traffic.js),
 * checked after every step:
 *
 *   - zero overlaps: no two vehicle bodies, boats or trams share space;
 *   - lanes kept: on every lane, each vehicle stays at least MIN_GAP behind
 *     the tail of the one ahead, in order;
 *   - nobody on a zebra is ever inside a vehicle;
 *   - deterministic: the same seed gives the same positions, step for step.
 * Run with: node --test tests/kingdom-traffic-10k.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTraffic, MIN_GAP } from '../public/kingdom/kingdom-traffic.js';

const DT = 1 / 15;
const STEPS = 10000;

function laneViolations(tr) {
  const bad = [];
  const links = new Set(tr.vehicles.filter((v) => !v.inJ && v.link).map((v) => v.link));
  for (const link of links) {
    const on = link.vehicles.filter((v) => !v.inJ).slice().sort((a, b) => b.s - a.s);
    for (let i = 1; i < on.length; i++) {
      const gap = (on[i - 1].s - on[i - 1].len) - on[i].s;
      if (gap < MIN_GAP - 1e-6) bad.push([on[i - 1].id, on[i].id, gap]);
    }
  }
  return bad;
}

test(`10,000 steps: zero overlaps, lanes and gaps kept, nobody hit on a zebra`, { timeout: 600000 }, () => {
  const tr = createTraffic({ density: 1, seed: 23 });
  assert.ok(tr.vehicles.length > 300, `${tr.vehicles.length} vehicles`);
  let overlapSteps = 0; let laneSteps = 0; let pedSteps = 0; let first = null;
  for (let i = 0; i < STEPS; i++) {
    tr.step(DT);
    const o = tr.overlaps();
    if (o.length) { overlapSteps++; if (!first) first = { step: i, pair: o[0] }; }
    if (laneViolations(tr).length) laneSteps++;
    if (tr.pedHits().length) pedSteps++;
  }
  assert.equal(overlapSteps, 0, `overlaps on ${overlapSteps} of ${STEPS} steps${first ? ` (first at step ${first.step}: ${first.pair.join(' / ')})` : ''}`);
  assert.equal(laneSteps, 0, 'a vehicle closer than MIN_GAP to the one ahead in its lane');
  assert.equal(pedSteps, 0, 'a person on a zebra inside a vehicle');
  assert.ok(tr.stats.entered > 500, 'the traffic keeps moving through the junctions');
});

test('the same seed gives the same traffic, step for step', () => {
  const a = createTraffic({ density: 0.6, seed: 9 });
  const b = createTraffic({ density: 0.6, seed: 9 });
  for (let i = 0; i < 1500; i++) {
    a.step(DT); b.step(DT);
    if (i % 100 === 0) assert.deepEqual(a.vehicles.map((v) => [v.id, v.x, v.z]), b.vehicles.map((v) => [v.id, v.x, v.z]), `step ${i}`);
  }
});
