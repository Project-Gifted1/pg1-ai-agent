/**
 * PG1 City: how PG1 intercepts (public/kingdom/kingdom-sequences.js), what
 * flies over the city (kingdom-air.js) and what drives in it
 * (kingdom-models.js, kingdom-traffic.js).
 *
 *   - every interception comes from one real event: its beats, shots, tag,
 *     aftermath and sound come only from the event's own fields; PG1 only
 *     defends (no chase, no strike back); the Legacy phone tier never cuts
 *     the camera; the highlight reel picks real events only, one per gadget;
 *   - the tower's security perimeter avoids every forbidden castle word and
 *     keeps the tower plaza traffic-free;
 *   - aircraft keep their altitude bands: never within 50 m of each other,
 *     never cruising below the tower top + 60 m (the shuttle only climbs and
 *     settles vertically over its own pads);
 *   - every road vehicle type has a model, wheels and light heights, and the
 *     mixed traffic still never overlaps.
 * Run with: node --test tests/kingdom-intercepts.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sequenceFor, pickHighlights, aftermathKey, BEATS, SHOTS, AFTERMATH_KINDS } from '../public/kingdom/kingdom-sequences.js';
import { normalizeEvent, DEFENCE_ACTIONS, GADGET_META } from '../public/kingdom/kingdom-data.js';
import { createAirTraffic, SEPARATION, TOWER_CLEAR } from '../public/kingdom/kingdom-air.js';
import { LIGHT_Y, WHEELS } from '../public/kingdom/kingdom-models.js';
import { createTraffic, VEHICLE_TYPES } from '../public/kingdom/kingdom-traffic.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let n = 0;
const ev = (o) => normalizeEvent({ id: (++n).toString(16).padStart(16, 'a'), time: new Date(Date.now() - n * 60000).toISOString(), last: new Date().toISOString(), kind: 'check_verdict', role: 'attacker', severity: 'medium', country_code: 'NL', caller_hash: null, endpoint: '/api/mcp', check: 'check_agent_message', verdict_code: 'suspicious', reasons: [], count: 1, source: 'verdicts', ...o });

test('every interception is one real event, beat by beat, and PG1 only defends', () => {
  for (const gadget of Object.keys(GADGET_META)) {
    const e = ev({ gadget, role: ['seal_forge', 'repair_crews', 'beacons'].includes(gadget) ? 'kingdom' : gadget === 'allies' ? 'ally' : 'attacker', reasons: ['AGENT_MESSAGE_PAYMENT_REDIRECT'] });
    if (!e) continue;
    const s = sequenceFor(e);
    if (!s) continue; // reserved gadgets have no play
    assert.equal(s.id, e.id, 'the sequence belongs to its event');
    assert.ok(DEFENCE_ACTIONS.includes(s.action), `${gadget}: ${s.action} is a defence`);
    assert.doesNotMatch(JSON.stringify(s), /chase|strike|attack_back|pursue|destroy/i, `${gadget} only defends`);
    for (const b of s.beats) assert.ok(BEATS.includes(b.kind));
    for (const sh of s.shots) assert.ok(SHOTS.includes(sh.shot));
    if (s.aftermath) assert.ok(AFTERMATH_KINDS.includes(s.aftermath));
    if (e.role === 'attacker') {
      assert.deepEqual(s.beats.map((b) => b.kind).slice(0, 3), ['approach', 'detect', 'respond']);
      assert.equal(s.tag.caught, 'Caught · PAYMENT_REDIRECT', 'the tag is the real reason code');
    } else assert.equal(s.tag, null, 'no threat tag on PG1\'s own or allies\' events');
  }
});

test('the director shot list is for high severity only, and never on Legacy phone', () => {
  const high = ev({ gadget: 'truth_lens', severity: 'high', verdict_code: 'malicious' });
  const med = ev({ gadget: 'truth_lens', severity: 'medium' });
  assert.deepEqual(sequenceFor(high).shots.map((x) => x.shot), ['wide', 'gadget', 'tower', 'release']);
  assert.deepEqual(sequenceFor(med).shots, []);
  assert.deepEqual(sequenceFor(high, { tier: 'legacy' }).shots, [], 'no camera cuts on Legacy phone');
  assert.equal(sequenceFor(high, { tier: 'legacy' }).particles, 'few');
});

test('a bigger real wave takes longer to clear, but never more than 6 s; the shield shows the wave (capped)', () => {
  const one = sequenceFor(ev({ gadget: 'rate_shield', count: 1 }));
  const big = sequenceFor(ev({ gadget: 'rate_shield', count: 400 }));
  const dur = (s) => { const r = s.beats.find((b) => b.kind === 'resolve'); return r.until - r.at; };
  assert.ok(dur(big) > dur(one) && dur(big) <= 6);
  assert.equal(one.wave, 1); assert.equal(big.wave, 24);
  assert.equal(sequenceFor(ev({ gadget: 'truth_lens', count: 50 })).wave, 0);
});

test('aftermath traces: boats that sink leave a buoy, floods a scorch ring, repairs a patch; cleared by the Dublin day', () => {
  assert.equal(sequenceFor(ev({ gadget: 'phishing_net' })).aftermath, 'buoy');
  assert.equal(sequenceFor(ev({ gadget: 'rate_shield' })).aftermath, 'scorch');
  assert.equal(sequenceFor(ev({ gadget: 'repair_crews', role: 'kingdom', check: 'tool' })).aftermath, 'patch');
  assert.equal(sequenceFor(ev({ gadget: 'seal_forge', role: 'kingdom' })).aftermath, null, 'signed results are too frequent to leave traces');
  assert.equal(aftermathKey(Date.parse('2026-11-11T23:30:00Z')), '2026-11-11', 'Dublin is on UTC in November');
  assert.equal(aftermathKey(Date.parse('2026-07-01T23:30:00Z')), '2026-07-02', 'Irish summer time');
  // Traces never count: kingdom-fx.js never touches the counts.
  assert.doesNotMatch(read('public/kingdom/kingdom-fx.js'), /fired\[|turned_away|gadgetCounts|setToday/);
});

test('highlights: real attackers only, the most important first, one per gadget', () => {
  const list = [ev({ gadget: 'truth_lens', severity: 'high', verdict_code: 'malicious' }), ev({ gadget: 'truth_lens', severity: 'high', verdict_code: 'malicious' }), ev({ gadget: 'rate_shield', count: 90 }), ev({ gadget: 'gate_wardens' }), ev({ gadget: 'seal_forge', role: 'kingdom' })];
  const h = pickHighlights(list, 3);
  assert.equal(h.length, 3);
  assert.equal(h[0].gadget, 'truth_lens');
  assert.equal(new Set(h.map((e) => e.gadget)).size, 3);
  assert.ok(h.every((e) => e.role === 'attacker'));
  assert.deepEqual(pickHighlights([], 3), []);
  assert.match(read('public/index.html'), /<option value="highlights">Highlights of the day<\/option>/);
});

test('the tower perimeter: a security fence with gates, guards, bollards and CCTV, no castle words; the plaza stays traffic-free', () => {
  const world = read('public/kingdom/kingdom-world.js');
  const names = [...world.matchAll(/'(tower-[a-z-]+)'/g)].map((m) => m[1]);
  for (const nm of ['tower-security-fence', 'tower-security-gate-arms', 'tower-guard-booths', 'tower-bollards', 'tower-cctv', 'tower-floodlights']) assert.ok(names.includes(nm), nm);
  for (const nm of names) assert.doesNotMatch(nm, /island|wall|moat|merlon|gatehouse|portcullis|container/i);
  assert.match(read('public/kingdom/kingdom-actors.js'), /const guards = new Crowd\(/);
  const tr = createTraffic({ density: 1, seed: 2 });
  for (let i = 0; i < 600; i++) { tr.step(1 / 10); for (const v of tr.vehicles) assert.ok(Math.hypot(v.x, v.z) > 52, 'a vehicle in the tower plaza'); }
});

test('aircraft: separated by altitude bands, cruising above the tower, the shuttle vertical over its pads', () => {
  const pads = [{ x: 100, y: 120, z: -80 }, { x: -200, y: 100, z: -150 }, { x: 300, y: 90, z: 200 }, { x: -120, y: 110, z: 300 }];
  const towerTop = 240;
  const air = createAirTraffic({ pads, towerTop });
  const kinds = new Set(air.aircraft.map((c) => c.kind));
  for (const k of ['airliner', 'light', 'helicopter', 'shuttle']) assert.ok(kinds.has(k), k);
  let min = Infinity; let landed = 0; let prev = '';
  for (let i = 0; i < 36000; i++) { // 30 minutes
    air.step(0.05);
    min = Math.min(min, air.minSeparation());
    for (const c of air.aircraft) {
      if (c.kind !== 'shuttle') assert.ok(c.y >= towerTop + TOWER_CLEAR - 0.01, `${c.kind} at ${c.y.toFixed(0)} m`);
      else {
        if (c.state === 'cruise') assert.ok(c.y >= towerTop + TOWER_CLEAR - 0.01);
        if (c.state === 'climb' || c.state === 'descend' || c.state === 'parked') { const p = c.pads[c.state === 'descend' ? c.to : c.from]; assert.ok(Math.hypot(c.x - p.x, c.z - p.z) < 0.01, 'vertical over its pad'); }
        if (c.state === 'parked' && prev !== 'parked') landed++;
        prev = c.state;
      }
    }
  }
  assert.ok(min >= SEPARATION, `two aircraft came within ${min.toFixed(1)} m`);
  assert.ok(landed >= 3, `the shuttle landed ${landed} times`);
  // No aircraft ever in the enemy red: navigation lights are white and green.
  assert.doesNotMatch(read('public/kingdom/kingdom-air.js'), /0xff3d3d|red light/i);
});

test('road vehicles: every type has a model, light heights and wheels, and mixed traffic never overlaps', () => {
  for (const ty of Object.keys(VEHICLE_TYPES)) {
    assert.ok(LIGHT_Y[ty] > 0, `${ty} lights`);
    assert.ok(Array.isArray(WHEELS[ty]) && WHEELS[ty].length >= 2, `${ty} wheels`);
    for (const [, wz] of WHEELS[ty]) assert.ok(Math.abs(wz) < VEHICLE_TYPES[ty].len / 2, `${ty} wheel inside the body`);
  }
  const tr = createTraffic({ density: 1, seed: 17 });
  const seen = new Set();
  let bad = 0;
  for (let i = 0; i < 6000; i++) { tr.step(1 / 15); for (const v of tr.vehicles) seen.add(v.type); if (i % 3 === 0 && tr.overlaps().length) bad++; }
  for (const ty of ['car', 'taxi', 'suv', 'motorbike', 'van', 'lorry', 'bus']) assert.ok(seen.has(ty), `${ty} on the road`);
  assert.equal(bad, 0);
});
