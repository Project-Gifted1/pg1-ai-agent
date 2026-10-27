// PG1 Sandbox: things keep apart, and a watchdog puts right whatever
// behaves otherwise. Runs in the engine after every step's movement
// (engine.mjs), deterministically: same world and seed, same result.
//
// keepApart: nothing on the ground or the water passes through anything
// else that moves there.
//   - Each thing has a body (a person about 0.6 m across, a car 4.5 m long
//     and 1.9 m wide, a ferry 40 m long...).
//   - A thing that moved this step and now overlaps something in front of
//     it gives way: a person or a boat first tries a step aside (on land
//     for a person, on water for a boat), else waits where it was; a road
//     vehicle never leaves its lane, it waits (queues) behind what is ahead.
//   - Only what is ahead counts: cars passing in the other lane, or someone
//     behind, do not block; a parked vehicle is in the way like any other.
//     Someone arriving at their door (within a few metres of where they are
//     going) goes in.
//   - Something that has waited too long (BLOCKED_MAX steps) drops its trip
//     and chooses again (the watchdog), instead of standing for ever.
//
// watchdog: after keepApart, every thing that moves is checked, and put
// right if it is wrong. Anything really wrong (off the road, on the wrong
// side of the shore, out of the world) is one `watchdog` event a step
// ("The watchdog put right: 2 back on the road"); everyday crowding (moved
// apart, a trip chosen again) is fixed without an event:
//   - a position that is not a number, or outside the world: back where it
//     was, or inside the world;
//   - a ground thing on the water, a boat on land: to the nearest land or water;
//   - a road vehicle off the road: onto the nearest road;
//   - two things standing on top of each other (made there, or left there):
//     moved apart, one step at a time;
//   - something stuck (a trip, no progress for STUCK_STEPS): its trip is
//     dropped, so it chooses again.

import { catalogFor } from './catalog.mjs';
import { isGroundKind, isWaterKind } from './movement.mjs';
import { roadPoint, offRoad, isRoadVehicle } from './roads.mjs';

export const BLOCKED_MAX = 12;   // steps a thing waits behind another before it chooses again
export const STUCK_STEPS = 240;  // a day at the default 240 steps a day
const ROUTINE = new Set(['moved apart', 'unstuck']);
const PASSES = 4;
const REACH = 26;   // the most two bodies reach ahead of each other (a ferry's half length and more)
const ARRIVE = 6;                // metres from its goal: going in, not in the way

// Bodies: [length, width] in metres, by the catalogue entry of a kind.
const BODY = [
  [['person', 'astronaut'], [0.6, 0.6]], [['child'], [0.45, 0.45]],
  [['dog', 'cat', 'rabbit', 'fox'], [0.9, 0.4]], [['deer', 'cow', 'horse'], [2.2, 0.8]],
  [['bike'], [1.8, 0.6]], [['motorbike'], [2.1, 0.8]], [['car', 'taxi', 'police_car'], [4.5, 1.9]],
  [['bus', 'truck', 'army_truck'], [11, 2.5]], [['tractor'], [4, 2.2]],
  [['canoe'], [7, 0.9]], [['boat', 'patrol_boat'], [9, 3]], [['ferry'], [40, 10]], [['ship', 'carrack'], [36, 9]], [['fish'], [0.5, 0.3]]
];
// Worked out once per kind (the catalogue is fixed).
const BODIES = new Map();
const bodyOf = (kind) => {
  let b = BODIES.get(kind);
  if (!b) { const c = catalogFor(kind); b = (BODY.find(([kinds]) => kinds.some((k) => catalogFor(k) === c)) || [null, [1, 1]])[1]; BODIES.set(kind, b); }
  return b;
};
const KINDS = new Map();
const traits = (kind) => {
  let t = KINDS.get(kind);
  if (!t) { t = { ground: isGroundKind(kind), water: isWaterKind(kind), road: isRoadVehicle(catalogFor(kind), kind) }; KINDS.set(kind, t); }
  return t;
};

const r4 = (n) => Math.round(n * 1e4) / 1e4;
const finite = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z || 0);
const inWorld = (p, S) => p.x >= 0 && p.y >= 0 && p.x <= S.x && p.y <= S.y;
const clampTo = (p, S) => ({ x: r4(Math.min(S.x, Math.max(0, p.x))), y: r4(Math.min(S.y, Math.max(0, p.y))), z: r4(Math.min(S.z, Math.max(0, p.z || 0))) });

// Who takes part: things on the ground or the water, at ground level, not
// riding in something else.
function movers(ents, removed, index) {
  return ents.filter((e) => !removed.has(e.id) && (traits(e.kind).ground || traits(e.kind).water) && (e.position.z || 0) <= 1
    && !(typeof e.properties.inside === 'string' && e.properties.inside && index.has(e.properties.inside)));
}

// A grid of who is where, for finding neighbours quickly.
const cellKey = (p, cell) => `${Math.floor(p.x / cell)}|${Math.floor(p.y / cell)}`;
function gridOf(list, cell) {
  const g = new Map();
  for (const e of list) { const k = cellKey(e.position, cell); const a = g.get(k); if (a) a.push(e); else g.set(k, [e]); }
  return g;
}
// Moves e to pos, keeping the grid right.
function moveTo(g, cell, e, pos) {
  const k0 = cellKey(e.position, cell); const k1 = cellKey(pos, cell);
  e.position = pos;
  if (k0 === k1) return;
  const a = g.get(k0); if (a) { const i = a.indexOf(e); if (i >= 0) a.splice(i, 1); }
  const b = g.get(k1); if (b) b.push(e); else g.set(k1, [e]);
}
function near(g, cell, p, r) {
  const out = [];
  const x0 = Math.floor((p.x - r) / cell); const x1 = Math.floor((p.x + r) / cell); const y0 = Math.floor((p.y - r) / cell); const y1 = Math.floor((p.y + r) / cell);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const a = g.get(`${x}|${y}`); if (a) out.push(...a); }
  return out;
}
const sameDomain = (a, b) => traits(a.kind).water === traits(b.kind).water;
const goalOf = (e, index) => {
  const p = e.properties;
  if (typeof p.target === 'string') { const t = index.get(p.target); return t ? t.position : null; }
  if (typeof p.target_x === 'number' || typeof p.target_y === 'number') return { x: typeof p.target_x === 'number' ? p.target_x : e.position.x, y: typeof p.target_y === 'number' ? p.target_y : e.position.y };
  return null;
};

// How far a, setting out from pos along dir, can go (up to dist) before it
// runs into b: Infinity if b is not in its way. Only what is ahead counts.
function roomBefore(a, pos, dir, dist, b) {
  const [la, wa] = bodyOf(a.kind); const [lb, wb] = bodyOf(b.kind);
  const dx = b.position.x - pos.x; const dy = b.position.y - pos.y;
  const fwd = dx * dir.x + dy * dir.y;               // ahead of a
  const side = Math.abs(-dx * dir.y + dy * dir.x);   // to one side
  const reach = (la + Math.max(lb, wb)) / 2;
  const clear = (wa + Math.min(lb, wb)) / 2;
  if (side >= clear || fwd <= 0 || fwd >= dist + reach) return Infinity;
  return Math.max(0, fwd - reach);
}

// Who moves and the id index, worked out once a step for both passes.
export function settleContext(ents, removed) {
  const index = new Map(ents.map((e) => [e.id, e]));
  return { index, list: movers(ents, removed, index) };
}

export function keepApart(ents, removed, before, mc, shared = settleContext(ents, removed)) {
  const T = mc.terrain;
  const { list, index } = shared;
  if (list.length < 2) return 0;
  const CELL = 50;
  const grid = gridOf(list, CELL);
  let gave = 0;
  // Until nothing changes (a thing that gives way can end up where another
  // was going), at most PASSES times; everything that moved is checked
  // against where everyone is now.
  const order = list.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const intended = new Map(order.map((e) => [e.id, { ...e.position }]));
  for (let pass = 0, changed = true; changed && pass < PASSES; pass++) {
  changed = false;
  for (const e of order) {
    const prev = before.get(e.id);
    if (!prev) continue;
    const want = intended.get(e.id);
    const mx = want.x - prev.x; const my = want.y - prev.y; const d = Math.hypot(mx, my);
    if (d < 1e-6) continue;                                   // it did not move
    const goal = goalOf(e, index);
    if (goal && Math.hypot(goal.x - want.x, goal.y - want.y) < ARRIVE) continue;   // going in
    const dir = { x: mx / d, y: my / d };
    const vehicle = traits(e.kind).road;
    // The whole way from where it was, not only where it ends: nothing is jumped over.
    const others = near(grid, CELL, { x: (prev.x + want.x) / 2, y: (prev.y + want.y) / 2 }, d / 2 + REACH).filter((o) => o !== e && sameDomain(e, o));
    const room = (from, dist) => others.reduce((m, o) => Math.min(m, roomBefore(e, from, dir, dist, o)), Infinity);
    // From any side: never end closer than body to body to something it came nearer to;
    // alongside each other, the later (by id) falls in behind.
    const [, we] = bodyOf(e.kind);
    const crowds = (pos) => others.some((o) => {
      const gap = (we + Math.min(...bodyOf(o.kind))) / 2;
      const dNow = Math.hypot(o.position.x - pos.x, o.position.y - pos.y);
      if (dNow >= gap) return false;
      const dWas = Math.hypot(o.position.x - prev.x, o.position.y - prev.y);
      return dNow < dWas - 1e-6 || (Math.abs(dNow - dWas) <= 1e-6 && o.id < e.id);
    });
    let free = room(prev, d);
    if (free === Infinity && crowds(want)) free = 0;
    const p = e.properties;
    if (free === Infinity) {
      if (e.position.x !== want.x || e.position.y !== want.y) { moveTo(grid, CELL, e, { ...want }); changed = true; }
      if (pass === 0) delete p.blocked;
      continue;
    }
    const waited = (Number(p.blocked) || 0) + (pass === 0 ? 1 : 0);
    const z = want.z || 0;
    let to = null;
    // A person or a boat steps round, staying on land or on water.
    if (!vehicle) {
      const [, w] = bodyOf(e.kind);
      for (const s of [1, -1, 2, -2]) {
        const q = { x: want.x - dir.y * w * 1.2 * s, y: want.y + dir.x * w * 1.2 * s, z };
        const okDomain = traits(e.kind).water ? !T.isLand(q.x, q.y) : T.isLand(q.x, q.y);
        if (okDomain && !crowds(q) && room({ x: q.x - dir.x * Math.min(d, 2), y: q.y - dir.y * Math.min(d, 2) }, Math.min(d, 2)) === Infinity) { to = { x: r4(q.x), y: r4(q.y), z }; break; }
      }
    }
    // Otherwise as far as there is room (a vehicle only where that is still on its road), else it waits.
    if (!to && free > 0.5) {
      const q = { x: r4(prev.x + dir.x * free), y: r4(prev.y + dir.y * free), z };
      if ((!vehicle || !mc.roads || offRoad(mc.roads, q.x, q.y, { paths: e.kind === 'bike' }) <= 0.5) && !crowds(q)) to = q;
    }
    const at = to || { ...prev };
    if (at.x !== e.position.x || at.y !== e.position.y) { moveTo(grid, CELL, e, at); changed = true; }
    if (vehicle && !to) p.v = 0;
    else if (vehicle && typeof p.v === 'number') p.v = Math.min(p.v, free);
    p.blocked = waited;
    if (pass === 0) gave += 1;
  }
  }
  return gave;
}

// full: check everything (the first step of each call, after any edits by
// agents); otherwise only what moved this step, since nothing standing
// still can have gone wrong.
export function watchdog(ents, removed, before, mc, S, emit, shared = settleContext(ents, removed), { full = true } = {}) {
  const T = mc.terrain;
  const { list, index } = shared;
  const fixed = {};
  const note = (what) => { fixed[what] = (fixed[what] || 0) + 1; };
  for (const e of list) {
    const p = e.properties;
    const prev = before.get(e.id);
    // Not a number, or out of the world.
    if (!finite(e.position)) { e.position = prev && finite(prev) ? { ...prev } : clampTo({ x: S.x / 2, y: S.y / 2, z: 0 }, S); note('put back in the world'); }
    else if (!inWorld(e.position, S)) { e.position = clampTo(e.position, S); note('put back in the world'); }
    const ground = traits(e.kind).ground;
    const movedNow = !prev || prev.x !== e.position.x || prev.y !== e.position.y;
    // Land and water.
    if (T.hasLand && (full || movedNow)) {
      const wrong = ground ? !T.isLand(e.position.x, e.position.y) : T.isLand(e.position.x, e.position.y);
      if (wrong) {
        const to = ground ? T.nearestLand(e.position.x, e.position.y) : T.nearestWater(e.position.x, e.position.y);
        if (to) { e.position = clampTo({ x: to.x, y: to.y, z: 0 }, S); note(ground ? 'back on land' : 'back on the water'); }
      }
    }
    // Road vehicles on the road.
    if ((full || movedNow) && ground && mc.roads && traits(e.kind).road && offRoad(mc.roads, e.position.x, e.position.y, { paths: e.kind === 'bike' }) > 0.5) {
      const q = roadPoint(mc.roads, e.position.x, e.position.y, { mode: e.kind === 'bike' ? 'walk' : 'car' });
      if (q) { e.position = clampTo({ x: q.x, y: q.y, z: 0 }, S); note('back on the road'); }
    }
    // Waiting too long behind another, or stuck: the trip is dropped and chosen again.
    const moved = prev && (Math.abs(prev.x - e.position.x) > 1e-6 || Math.abs(prev.y - e.position.y) > 1e-6);
    const tripping = !!goalOf(e, index);
    if (tripping && !moved) p.stuck = (Number(p.stuck) || 0) + 1; else delete p.stuck;
    if (Number(p.blocked) >= BLOCKED_MAX || Number(p.stuck) >= STUCK_STEPS) {
      delete p.target; delete p.target_x; delete p.target_y; delete p.target_z; delete p.blocked; delete p.stuck;
      for (const k of ['rn', 'rp', 'rg']) delete p[k];
      note('unstuck');
    }
  }
  // Two things standing on top of each other: apart, a little each step.
  const CELL = 50;
  const grid = gridOf(list, CELL);
  const seen = new Set();
  for (const e of list.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const vehicle = traits(e.kind).road;
    for (const o of near(grid, CELL, e.position, 11)) {
      if (o === e || !sameDomain(e, o) || seen.has(`${o.id}|${e.id}`)) continue;
      seen.add(`${e.id}|${o.id}`);
      const [le, we] = bodyOf(e.kind); const [lo, wo] = bodyOf(o.kind);
      const gap = (Math.min(le, we) + Math.min(lo, wo)) / 2;   // side by side, just touching
      const dx = o.position.x - e.position.x; const dy = o.position.y - e.position.y; const dd = Math.hypot(dx, dy);
      if (dd >= gap) continue;                              // not overlapping
      // Move the later one (by id) clear, trying directions from its id round
      // the compass, staying in its domain (and on its road).
      const later = e.id < o.id ? o : e; const other = later === e ? o : e;
      let h = 0; for (const ch of later.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const need = gap - dd + 0.1;
      for (let i = 0; i < 8; i++) {
        const a = ((h % 8) + i) * Math.PI / 4;
        const q = { x: later.position.x + Math.cos(a) * need, y: later.position.y + Math.sin(a) * need, z: later.position.z || 0 };
        if (Math.hypot(q.x - other.position.x, q.y - other.position.y) < gap) continue;
        const okDomain = traits(later.kind).water ? !T.isLand(q.x, q.y) : (!T.hasLand || T.isLand(q.x, q.y));
        const onRoad = !traits(later.kind).road || !mc.roads || offRoad(mc.roads, q.x, q.y, { paths: later.kind === 'bike' }) <= 0.5;
        if (okDomain && onRoad && inWorld(q, S)) { later.position = { x: r4(q.x), y: r4(q.y), z: q.z }; note('moved apart'); break; }
      }
    }
  }
  // Everyday crowding (moved apart, a new route) is counted, not announced;
  // anything really wrong is one event.
  const words = Object.entries(fixed).filter(([k]) => !ROUTINE.has(k)).sort().map(([k, n]) => `${n} ${k}`);
  if (words.length) emit('watchdog', `The watchdog put right: ${words.join(', ')}`);
  return fixed;
}
