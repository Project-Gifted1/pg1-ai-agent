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
//   - a ground thing on the water (not someone swimming), a boat on land: to the nearest land or water;
//   - a road vehicle off the road: onto the nearest road;
//   - two things standing on top of each other (made there, or left there):
//     moved apart, one step at a time;
//   - something stuck (a trip, no progress for STUCK_STEPS): its trip is
//     dropped, so it chooses again.

import { catalogFor } from './catalog.mjs';
import { isGroundKind, isWaterKind } from './movement.mjs';
import { roadPoint, offRoad, isRoadVehicle, nearestNode } from './roads.mjs';
import { bodyFor, parseWaypoints, formatWaypoints, wayPoints, wayLength, pointOnWay, cutWay, footprint, boxesOverlap, VEHICLE_BODIES, VEHICLE_SAMPLES } from './vehicle-path.mjs';

export const BLOCKED_MAX = 12;   // steps a thing waits behind another before it chooses again
export const STUCK_STEPS = 240;  // a day at the default 240 steps a day
const ROUTINE = new Set(['moved apart', 'unstuck']);
const PASSES = 4;
const REACH = 26;   // the most two bodies reach ahead of each other (a ferry's half length and more)
const KNOT_WAIT = 3;             // steps a vehicle waits before squeezing past others that are waiting too
const PULL_IN = 15;              // metres from the end of its route: a vehicle pulling in to park
const ARRIVE = 6;                // metres from its goal: going in, not in the way
const FOLLOW = 2;                // metres a road vehicle keeps behind the one ahead

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
  // A place's door is at the edge of its footprint (movement.mjs), so that far out counts as there.
  if (typeof p.target === 'string') { const t = index.get(p.target); return t ? { x: t.position.x, y: t.position.y, r: catalogFor(t.kind).footprint || 0 } : null; }
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
  // A road vehicle behind another keeps its following distance (FOLLOW).
  const follow = traits(a.kind).road && traits(b.kind).road ? FOLLOW : 0;
  const reach = (la + Math.max(lb, wb)) / 2 + follow;
  const clear = (wa + Math.min(lb, wb)) / 2;
  if (side >= clear || fwd <= 0 || fwd >= dist + reach) return Infinity;
  return Math.max(0, fwd - reach);
}

// Who moves and the id index, worked out once a step for both passes.
export function settleContext(ents, removed) {
  const index = new Map(ents.map((e) => [e.id, e]));
  return { index, list: movers(ents, removed, index) };
}

// In the water: a boat, or someone swimming (a property the beach and
// rescues set); stepping aside or moved apart, they stay in the water.
const wet = (e) => traits(e.kind).water || e.properties.swimming === true;
// A lifeguard and the swimmer they are bringing back are meant to be together.
const together = (a, b) => a.properties.rescuing === b.id || b.properties.rescuing === a.id;

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
    if (goal && Math.hypot(goal.x - want.x, goal.y - want.y) < ARRIVE + (goal.r || 0)) continue;   // going in
    // A vehicle at the end of its route (its place's node on the road) pulls in to park.
    if (mc.roads && typeof e.properties.rg === 'number' && e.properties.rg >= 0 && e.properties.rg < mc.roads.n && Math.hypot(mc.roads.xs[e.properties.rg] - want.x, mc.roads.ys[e.properties.rg] - want.y) < PULL_IN) continue;
    const dir = { x: mx / d, y: my / d };
    const vehicle = traits(e.kind).road;
    // The whole way from where it was, not only where it ends: nothing is jumped over.
    const others = near(grid, CELL, { x: (prev.x + want.x) / 2, y: (prev.y + want.y) / 2 }, d / 2 + REACH).filter((o) => o !== e && sameDomain(e, o) && !together(e, o));
    // Two vehicles each in the other's way (crossing at a junction, meeting
    // head on) would wait for each other for ever: the earlier (by id) has
    // the right of way and goes; the other waits for it. A parked vehicle
    // still blocks.
    function rightOfWay(a, o) {
      // A vehicle does not stop for people or animals along a whole step's
      // stretch of road (they step aside for it); it queues behind vehicles.
      if (vehicle && !traits(o.kind).road) return true;
      if (!vehicle || !traits(o.kind).road) return false;
      // A knot of three or more waiting for each other in a ring: after
      // waiting a while, a vehicle squeezes past others that are waiting too
      // (the watchdog then moves any two that touch apart, along the road).
      if ((Number(a.properties.blocked) || 0) >= KNOT_WAIT && (Number(o.properties.blocked) || 0) >= 1 && o.properties.target) return true;
      const op = before.get(o.id); const ow = intended.get(o.id) || o.position;
      if (!op) return false;
      const ox = ow.x - op.x; const oy = ow.y - op.y; const od = Math.hypot(ox, oy);
      // Overtaking: a much slower vehicle going the same way (a bike, a lorry) is passed.
      if (od > 1e-6 && ox * dir.x + oy * dir.y > 0.7 * od && od < d * 0.5) return true;
      if (a.id > o.id) return false;
      return od > 1e-6 && roomBefore(o, op, { x: ox / od, y: oy / od }, od, a) < Infinity;
    }
    // On the way: what has the right of way over it, or is let through, is not in its way;
    // where it ends up must still be clear of everything (crowds, below).
    const inWay = others.filter((o) => !rightOfWay(e, o));
    const room = (from, dist) => inWay.reduce((m, o) => Math.min(m, roomBefore(e, from, dir, dist, o)), Infinity);
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
        const okDomain = wet(e) ? !T.isLand(q.x, q.y) : T.isLand(q.x, q.y);
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
      // (Someone swimming, a property the beach and rescues set, is in the water on purpose.)
      const wrong = ground ? !T.isLand(e.position.x, e.position.y) && p.swimming !== true : T.isLand(e.position.x, e.position.y);
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
      if (o === e || !sameDomain(e, o) || together(e, o) || seen.has(`${o.id}|${e.id}`)) continue;
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
        const okDomain = wet(later) ? !T.isLand(q.x, q.y) : (!T.hasLand || T.isLand(q.x, q.y));
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

// --- vehicles: the whole way clear ---------------------------------------------------------
//
// vehicleSpace, after keepApart and the watchdog, every step: road vehicles
// and boats (at the surface, not riding in something else).
//   - The whole way each one goes this step (lib/sandbox/vehicle-path.mjs:
//     where it was, the corners it turned, where it ends; the viewer draws
//     it on exactly that way) is checked against every other vehicle's way
//     at the same moments: at least VEHICLE_SAMPLES times a step, more for a
//     fast one, so nothing passes through anything between two samples. A
//     body is kept a little bigger than it is (MARGIN_L ahead and behind:
//     the following distance; MARGIN_W to the sides).
//   - In a conflict one gives way: a vehicle catching up with one ahead
//     keeps behind it; otherwise a siren goes first, then whoever is already
//     in the junction, then the earlier id. Giving way is covering less of
//     its way this step (as far as stays clear), or none of it.
//   - Two that stand on top of each other (parked on the same spot, or put
//     there by hand) are moved apart: the later id to the nearest clear
//     spot on its road (or water), along its own length first.
// Each vehicle that moved keeps its heading (hdg, degrees) and its corners
// (wp) for the viewer; one that did not loses its corners.
// Returns the corrections, counted: { 'gave way': n, 'parked clear': n }.


const MARGIN_L = 0.75;
const STILL_GAP = 0.8;   // metres two parked vehicles keep between them
const MARGIN_W = 0.15;
const SAMPLE_EVERY = 1.0;   // metres of relative movement between two checks at most
const MAX_SAMPLES = 200;

const VBASE = new Map();
// The body table's own kind for a kind ("car_red" is a car), or null for
// what is not a road vehicle or a boat.
export function vehicleBase(kind) {
  if (VBASE.has(kind)) return VBASE.get(kind);
  const c = catalogFor(kind);
  let b = null;
  if (c.class === 'vehicle' && (c.domain === 'water' || isRoadVehicle(c, kind))) b = Object.keys(VEHICLE_BODIES).find((k) => catalogFor(k) === c) || String(kind);
  VBASE.set(kind, b);
  return b;
}
export const isVehicleBody = (kind) => vehicleBase(kind) !== null;
export const vehicleBodyOf = (kind) => bodyFor(vehicleBase(kind));

function vehiclesOf(ents, removed) {
  const index = new Map(ents.map((e) => [e.id, e]));
  return ents.filter((e) => !removed.has(e.id) && isVehicleBody(e.kind) && (e.position.z || 0) <= 1
    && !(typeof e.properties.inside === 'string' && e.properties.inside && index.has(e.properties.inside)));
}
const hdgOf = (e) => { const h = Number(e.properties.hdg); return Number.isFinite(h) ? h * Math.PI / 180 : 0; };
// A vehicle with no heading yet (never moved) faces along its road: set once.
function faceRoad(e, mc) {
  const p = e.properties;
  if (typeof p.hdg === 'number' || !mc.roads || wetVehicle(e)) return;
  const q = roadPoint(mc.roads, e.position.x, e.position.y, { mode: 'car' });
  const E = q && mc.roads.edges[q.edge];
  if (E) p.hdg = Math.round(Math.atan2(mc.roads.ys[E.b] - mc.roads.ys[E.a], mc.roads.xs[E.b] - mc.roads.xs[E.a]) * 1800 / Math.PI) / 10;
}
const wetVehicle = (e) => catalogFor(e.kind).domain === 'water';

// A vehicle's body at a fraction f of its way, at time t of the step.
function bodyAt(v, t, grow = true, out = {}) {
  const [L, W] = v.body;
  const pt = pointOnWay(v.pts, v.f * t, out);
  let hx = pt.hx; let hy = pt.hy;
  // Standing (or held where it was): it faces as it last did, as the viewer draws it.
  if ((!hx && !hy) || !(v.f * v.len > 1e-6)) { hx = Math.cos(v.h0); hy = Math.sin(v.h0); }
  return footprint(pt.x, pt.y, hx, hy, L + (grow ? 2 * MARGIN_L : 0), W + (grow ? 2 * MARGIN_W : 0));
}

// Whether a and b (each at its own fraction of its way) touch at any moment.
function clash(a, b) {
  if (a.wet !== b.wet) return false;
  // Far apart the whole step: no.
  if (Math.hypot(a.mid.x - b.mid.x, a.mid.y - b.mid.y) > a.reach + b.reach) return false;
  const n = Math.min(MAX_SAMPLES, Math.max(VEHICLE_SAMPLES, VEHICLE_SAMPLES * Math.ceil((a.len * a.f + b.len * b.f) / SAMPLE_EVERY / VEHICLE_SAMPLES)));
  // Both standing still: separateVehicles deals with that, not their ways.
  if (a.f <= 0 && b.f <= 0) return false;
  // Touching as they set off (a turn at the start of the step): a clash.
  if (boxesOverlap(bodyAt(a, 0, false), bodyAt(b, 0, false))) return true;
  const grow = !boxesOverlap(bodyAt(a, 0, true), bodyAt(b, 0, true));
  for (let k = 1; k <= n; k++) if (boxesOverlap(bodyAt(a, k / n, grow), bodyAt(b, k / n, grow))) return true;
  return false;
}

// Who keeps going when a and b would touch: a vehicle that has the other
// ahead of it (catching it up) gives way; then a siren, then whoever is in
// the junction, then the earlier id. True when a goes first.
function goesFirst(a, b) {
  const ahead = (x, y) => { if (!(x.len > 1e-6)) return false; const p = pointOnWay(x.pts, 0); const dx = y.pts[0].x - x.pts[0].x; const dy = y.pts[0].y - x.pts[0].y; const fwd = dx * p.hx + dy * p.hy; const side = Math.abs(-dx * p.hy + dy * p.hx); return fwd > 0 && side < (x.body[1] + y.body[1]) / 2 + 1; };
  if (ahead(b, a) && !ahead(a, b)) return true;    // a is ahead of b: b catches up, b waits
  if (ahead(a, b) && !ahead(b, a)) return false;
  if (a.siren !== b.siren) return a.siren;
  if (a.junction !== b.junction) return a.junction;
  return a.e.id < b.e.id;
}

const hasTrip = (e) => { const p = e.properties; return (typeof p.target === 'string' && !!p.target) || typeof p.target_x === 'number' || typeof p.target_y === 'number'; };

// Where a parked road vehicle stands at the kerb: on the right of its road
// as it faces, clear of the lane traffic drives in (movement.mjs laneOf),
// when the road is wide enough for that; else null (it stays).
export function kerbSpot(e, mc) {
  const g = mc.roads;
  if (!g || wetVehicle(e) || e.kind === 'bike') return null;
  const q = roadPoint(g, e.position.x, e.position.y, { mode: 'car', maxR: 30 });
  const E = q && g.edges[q.edge];
  if (!E || q.d > E.w / 2) return null;
  const [, W] = vehicleBodyOf(e.kind);
  const lane = Math.max(Math.min(E.w / 4, 2.5), Math.min(1.6, E.w / 2 - 0.4));
  const off = E.w / 2 - W / 2 - 0.3;
  if (off - W / 2 < lane + 2.5 / 2 + 0.3) return null;   // no room beside the lane
  let ux = g.xs[E.b] - g.xs[E.a]; let uy = g.ys[E.b] - g.ys[E.a]; const d = Math.hypot(ux, uy) || 1; ux /= d; uy /= d;
  const h = hdgOf(e);
  if (Math.cos(h) * ux + Math.sin(h) * uy < 0) { ux = -ux; uy = -uy; }
  return { x: q.x + uy * off, y: q.y - ux * off };
}

// Where a vehicle's way lies this step: the middle and how far it reaches.
function bounds(v) {
  const xs = v.pts.map((q) => q.x); const ys = v.pts.map((q) => q.y);
  v.mid = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  v.reach = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 + Math.hypot(v.body[0], v.body[1]) / 2 + MARGIN_L;
  return v;
}

export function vehicleSpace(ents, removed, before, travelled, mc, S, shared = null) {
  const fixed = {};
  const note = (what) => { fixed[what] = (fixed[what] || 0) + 1; };
  const list = vehiclesOf(ents, removed);
  if (!list.length) return fixed;
  // Parked on a road wide enough: at the kerb, out of the traffic lane.
  let kerbed = 0;
  for (const e of list) {
    const prev = before.get(e.id);
    if (!prev || prev.x !== e.position.x || prev.y !== e.position.y || hasTrip(e)) continue;
    const q = kerbSpot(e, mc);
    if (q && Math.hypot(q.x - e.position.x, q.y - e.position.y) > 0.2) { e.position = { x: r4(q.x), y: r4(q.y), z: e.position.z || 0 }; delete e.properties.wp; kerbed++; }
  }
  if (kerbed) fixed['pulled in'] = kerbed;
  // Parked on top of each other: apart first (a short move this step, checked below like any other).
  const parked = separateVehicles(list, removed, mc, S, { before });
  if (parked) fixed['parked clear'] = parked;
  const roads = mc.roads;
  const V = list.map((e) => {
    const p = e.properties;
    const prev = before.get(e.id) || e.position;
    const moved = Math.hypot(e.position.x - prev.x, e.position.y - prev.y) > 1e-6;
    const tr = travelled.get(e.id);
    // Its corners hold only when its own travel set them this step and nothing moved it since.
    const fresh = moved && tr && (tr.x !== prev.x || tr.y !== prev.y) && tr.x === e.position.x && tr.y === e.position.y;
    const pts = wayPoints(prev, e.position, fresh ? parseWaypoints(p.wp) : []);
    const len = moved ? wayLength(pts) : 0;
    const body = vehicleBodyOf(e.kind);
    let junction = false;
    if (roads && !wetVehicle(e)) { const k = nearestNode(roads, prev.x, prev.y, { mode: 'car', maxR: 15 }); junction = k >= 0 && (roads.adj.car[k] || []).length >= 3; }
    return bounds({ e, pts, len, f: moved ? 1 : 0, moved, fresh, body, h0: hdgOf(e), wet: wetVehicle(e), siren: !!p.siren, junction, held: !moved });
  }).sort((a, b) => (a.e.id < b.e.id ? -1 : 1));
  // Near each other at all this step (a coarse grid of their reaches).
  const CELL = 120;
  const grid = new Map();
  for (const v of V) for (let i = Math.floor((v.mid.x - v.reach) / CELL); i <= Math.floor((v.mid.x + v.reach) / CELL); i++) for (let j = Math.floor((v.mid.y - v.reach) / CELL); j <= Math.floor((v.mid.y + v.reach) / CELL); j++) { const k = `${i}|${j}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(v); }
  const near = new Map(V.map((v) => [v, new Set()]));
  for (const cell of grid.values()) for (const a of cell) for (const b of cell) if (a !== b) near.get(a).add(b);
  // Give way and keep to the road, until both hold: a vehicle stopped
  // short to stay on its road changes what the others must give way to.
  for (let round = 0; round < 4; round++) {
    // Give way, until nothing changes: a vehicle covers as much of its way as
    // stays clear of those that go first and of those standing still.
    let settled = false;
    for (let pass = 0; pass < 12 && !settled; pass++) {
      settled = true;
      for (const v of V) {
        if (v.held || v.f <= 0) continue;
        const others = [...near.get(v)].filter((o) => o.held || o.f <= 0 || goesFirst(o, v));
        if (!others.some((o) => clash(v, o))) continue;
        let best = 0;
        for (let f = Math.round((v.f - 0.1) * 10) / 10; f > 0.05; f = Math.round((f - 0.1) * 10) / 10) { v.f = f; if (!others.some((o) => clash(v, o))) { best = f; break; } }
        v.f = best;
        settled = false;
      }
    }
    // Still touching after all that: the one that gives way stays where it was.
    for (let pass = 0; pass < V.length && !settled; pass++) {
      settled = true;
      for (const v of V) {
        if (v.held || v.f <= 0) continue;
        const bad = [...near.get(v)].find((o) => clash(v, o));
        if (!bad) continue;
        const loser = bad.held || bad.f <= 0 || goesFirst(bad, v) ? v : bad;
        loser.f = 0; settled = false;
      }
    }
    // A road vehicle cut short on a straight line across a corner (something
    // else moved it this step, so its corners are gone) stops on the road.
    let cut = false;
    for (const v of V) {
      if (v.wet || !mc.roads || !v.moved || v.f <= 0 || v.f >= 1) continue;
      const onRoadAt = (f) => { const q = pointOnWay(v.pts, f); return offRoad(mc.roads, q.x, q.y, { paths: v.e.kind === 'bike' }) <= 0.5; };
      if (onRoadAt(v.f)) continue;
      let f = Math.round((v.f - 0.1) * 10) / 10;
      for (; f > 0.05; f = Math.round((f - 0.1) * 10) / 10) { const was = v.f; v.f = f; if (onRoadAt(f) && !V.some((o) => o !== v && clash(v, o))) break; v.f = was; }
      if (!(f > 0.05)) v.f = 0;
      cut = true;
    }
    if (!cut) break;
  }
  // Last of all, whatever still touches: the one that gives way stays where it was.
  for (let pass = 0, again = true; pass < V.length && again; pass++) {
    again = false;
    for (const v of V) {
      if (v.held || v.f <= 0) continue;
      const bad = [...near.get(v)].find((o) => clash(v, o));
      if (!bad) continue;
      (bad.held || bad.f <= 0 || goesFirst(bad, v) ? v : bad).f = 0; again = true;
    }
  }
  // A boat that has to give way steps round instead, to its right (then its
  // left), on open water and clear of every other vehicle's way.
  const T = mc.terrain;
  for (const v of V) {
    if (!v.wet || !v.moved || v.f > 0) continue;
    const a = v.pts[0]; const b = v.pts[v.pts.length - 1];
    const d = Math.hypot(b.x - a.x, b.y - a.y); if (d < 1e-6) continue;
    const ux = (b.x - a.x) / d; const uy = (b.y - a.y) / d;
    const keep = { pts: v.pts, len: v.len, f: v.f, mid: v.mid, reach: v.reach };
    const reachFwd = Math.min(d, v.body[0]) * 0.5;
    for (const [side, fwd] of [[1, reachFwd], [-1, reachFwd], [1, 0], [-1, 0], [2, 0], [-2, 0], [1, -reachFwd], [-1, -reachFwd]]) {
      const off = side * (v.body[1] + 2 * MARGIN_W + 1.2);
      const q = { x: a.x + ux * fwd + uy * off, y: a.y + uy * fwd - ux * off };
      if (q.x < 0 || q.y < 0 || q.x > S.x || q.y > S.y || (T.hasLand && (T.isLand(q.x, q.y) || !T.clearLine(a, q, true)))) continue;
      Object.assign(v, { pts: wayPoints(a, q), f: 1, fresh: false }); v.len = wayLength(v.pts); bounds(v);
      if (!V.some((o) => o !== v && clash(v, o))) { v.stepped = true; break; }
      Object.assign(v, keep);
    }
  }
  // Where each one really gets to this step.
  for (const v of V) if (v.moved && (v.f < 1 || v.stepped)) { const end = pointOnWay(v.pts, v.f); v.e.position = { x: r4(end.x), y: r4(end.y), z: v.e.position.z || 0 }; }
  // Held where they were and still on top of another (they ended the last
  // step so): apart now, so the next step starts clear.
  const heldIds = new Set(V.filter((v) => v.f <= 0).map((v) => v.e.id));
  if (heldIds.size) {
    const again = separateVehicles(list, removed, mc, S, { still: (e) => heldIds.has(e.id) });
    if (again) {
      fixed['parked clear'] = (fixed['parked clear'] || 0) + again;
      for (const v of V) {
        if (!heldIds.has(v.e.id) || (v.e.position.x === v.pts[0].x && v.e.position.y === v.pts[0].y)) continue;
        // The short way to its new spot passes nothing (else it stays put this step).
        const keep = { pts: v.pts, len: v.len, f: v.f, moved: v.moved, held: v.held, mid: v.mid, reach: v.reach };
        Object.assign(v, { pts: wayPoints(v.pts[0], v.e.position), f: 1, moved: true, fresh: false, held: false });
        v.len = wayLength(v.pts); bounds(v);
        if (V.some((o) => o !== v && clash(v, o))) { Object.assign(v, keep); v.e.position = { ...v.pts[0], z: v.e.position.z || 0 }; fixed['parked clear']--; }
      }
    }
  }
  for (const v of V) {
    const p = v.e.properties;
    if (v.stepped) { delete p.wp; note('stepped round'); }
    else if (v.moved && v.f < 1) {
      const cut = cutWay(v.pts, v.f);
      const corners = cut.slice(1, -1);
      if (corners.length && v.fresh) p.wp = formatWaypoints(corners); else delete p.wp;
      if (typeof p.v === 'number') p.v = Math.round(Math.min(p.v, v.len * v.f) * 100) / 100;
      if (v.f <= 0) p.blocked = (Number(p.blocked) || 0) + 1;
      v.pts = cut; v.len = wayLength(cut);
      note('gave way');
    } else if (!v.moved || !v.fresh) delete p.wp;
    if (v.moved && v.len > 1e-6) {
      const a = v.pts[v.pts.length - 2]; const b = v.pts[v.pts.length - 1];
      p.hdg = Math.round(Math.atan2(b.y - a.y, b.x - a.x) * 1800 / Math.PI) / 10;
    } else faceRoad(v.e, mc);
  }
  return fixed;
}

// Vehicles standing on top of each other move apart: the later id to the
// nearest clear spot (on its road, or on the water), along its own length
// first, then to the side. Used every step (vehicleSpace) and when a world
// is made (engine.mjs initialState). Returns how many moved.
export function separateVehicles(list0, removed, mc, S, { before = null, still: isStill = null } = {}) {
  const list = list0.filter((e) => !removed.has(e.id) && isVehicleBody(e.kind) && (e.position.z || 0) <= 1).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const e of list) faceRoad(e, mc);
  const index = new Map(list0.map((e) => [e.id, e]));
  const riding = (e) => typeof e.properties.inside === 'string' && e.properties.inside && index.has(e.properties.inside);
  const T = mc.terrain;
  // Two standing still keep STILL_GAP round their bodies (room to pull
  // out); one standing and one that moved: their bodies as they face.
  const reachOf = (e) => Math.hypot(...vehicleBodyOf(e.kind)) / 2;
  const boxOf = (e, at, grow = 0) => { const [L, W] = vehicleBodyOf(e.kind); const h = hdgOf(e); return footprint(at.x, at.y, Math.cos(h), Math.sin(h), L + grow, W + grow); };
  const stillOf = (e) => { if (isStill) return isStill(e); const prev = before && before.get(e.id); return !prev || (prev.x === e.position.x && prev.y === e.position.y); };
  const placed = list.filter((e) => !riding(e)).map((e) => ({ e, wet: wetVehicle(e), still: stillOf(e), x: e.position.x, y: e.position.y, r: reachOf(e) }));
  const clashesAt = (me, at) => placed.some((o) => o.e !== me.e && o.wet === me.wet && (o.still
    ? boxesOverlap(boxOf(me.e, at, STILL_GAP), boxOf(o.e, o, STILL_GAP))
    : boxesOverlap(boxOf(me.e, at, 0.4), boxOf(o.e, o))));
  let moved = 0;
  for (const me of placed) {
    if (!me.still) continue;
    // Only the later of two (by id) moves; the earlier keeps its place.
    const clashWith = (at) => placed.some((o) => o.e !== me.e && o.wet === me.wet && (!o.still || o.e.id < me.e.id || o.moved) && (o.still ? boxesOverlap(boxOf(me.e, at, STILL_GAP), boxOf(o.e, o, STILL_GAP)) : boxesOverlap(boxOf(me.e, at, 0.4), boxOf(o.e, o))));
    if (!clashWith(me)) continue;
    const e = me.e;
    const [L, W] = vehicleBodyOf(e.kind);
    const h = hdgOf(e); const ux = Math.cos(h); const uy = Math.sin(h);
    let to = null;
    for (let r = 1; r <= 8 && !to; r++) {
      const dl = L + STILL_GAP + 0.2; const dw = W + STILL_GAP + 0.2;
      for (const [a, b] of [[r * dl, 0], [-r * dl, 0], [0, r * dw], [0, -r * dw], [r * dl, r * dw], [-r * dl, -r * dw], [r * dl, -r * dw], [-r * dl, r * dw]]) {
        const q = { x: e.position.x + ux * a - uy * b, y: e.position.y + uy * a + ux * b, z: e.position.z || 0 };
        if (q.x < 0 || q.y < 0 || q.x > S.x || q.y > S.y) continue;
        const okDomain = !T.hasLand || (wetVehicle(e) ? !T.isLand(q.x, q.y) : T.isLand(q.x, q.y));
        const onRoad = wetVehicle(e) || !mc.roads || offRoad(mc.roads, q.x, q.y, { paths: e.kind === 'bike' }) <= 0.5;
        if (!okDomain || !onRoad || clashesAt(me, q)) continue;
        // The short way there passes nothing either.
        let clear = true;
        for (let k = 1; k < 5 && clear; k++) { const m = { x: me.x + (q.x - me.x) * k / 5, y: me.y + (q.y - me.y) * k / 5 }; if (placed.some((o) => o.e !== me.e && o.wet === me.wet && boxesOverlap(boxOf(e, m), boxOf(o.e, o)) && !boxesOverlap(boxOf(e, me), boxOf(o.e, o)))) clear = false; }
        if (clear) { to = { x: r4(q.x), y: r4(q.y), z: q.z }; break; }
      }
    }
    if (to) { e.position = to; me.x = to.x; me.y = to.y; me.moved = true; delete e.properties.wp; moved++; }
  }
  return moved;
}
