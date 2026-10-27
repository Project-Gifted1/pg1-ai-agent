// PG1 SANDBOX MOVEMENT: how the travel rule moves things, by domain.
//
//   ground  people, animals, bikes, cars, buses, trucks, tractors never
//           stand on water (terrain.mjs). Vehicles drive the road network
//           (roads.mjs, A* on the graph): they join the nearest road, keep
//           right, slow for junctions and bends (acceleration and braking,
//           never an instant top speed) and leave by the destination's
//           driveway. People walk the pavements and footpaths; bikes ride
//           roads and paths. A trip to another island goes by the harbour
//           or the airport: aboard a ferry or a plane (the inside / riders
//           mechanism), off at the other end; with no link there, the trip
//           is refused with a plain event.
//   water   boats, ferries and ships never enter land: they sail round the
//           islands on a coarse sea grid (A*, cached per world) and berth
//           at the harbour's water side.
//   air     planes, small planes and jets taxi to the runway's end, line
//           up, roll and rotate, climb out at about 7% (4 degrees), cruise,
//           turn with a limited rate, join a straight final lined up with
//           the runway, descend on a 3-degree glide path, touch down near
//           the threshold, roll out braking and taxi off. Helicopters,
//           drones and balloons climb and come down vertically, smoothly.
//           Speeds change gradually; nothing stops dead in the air.
//   space   rockets and shuttles: straight, anywhere, into space.
//
// Deterministic: everything here is a function of the world's data. The
// caches (terrain, road graph, water graph, routes) only remember answers.

import { catalogFor, CRUISE_ALTITUDE } from './catalog.mjs';
import { buildTerrain, terrainSignature } from './terrain.mjs';
import { roadGraph, nearestNode, nextHop, offRoad, roadPoint, isRoadVehicle, FOOTPATH_WIDTH } from './roads.mjs';

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const DEG = Math.PI / 180;

// --- what moves where -----------------------------------------------------------------------

const GROUND_CLASSES = new Set(['person', 'animal', 'vehicle']);
export const isGroundKind = (kind) => { const c = catalogFor(kind); return c.domain === 'ground' && GROUND_CLASSES.has(c.class); };
export const isWaterKind = (kind) => catalogFor(kind).domain === 'water';
const FIXED_WING = new Set(['plane', 'small_plane', 'jet']);
const base = (kind) => { const c = catalogFor(kind); for (const k of ['plane', 'small_plane', 'jet', 'helicopter', 'drone', 'hot_air_balloon', 'bike', 'ferry', 'ship', 'boat', 'patrol_boat']) if (catalogFor(k) === c) return k; return String(kind); };
export const isFixedWing = (kind) => FIXED_WING.has(base(kind));

// Flight: speeds in metres a step; gradients as rise over run.
export const CLIMB_GRADIENT = 0.07;        // about 4 degrees
export const GLIDE_GRADIENT = Math.tan(3 * DEG); // the 3-degree glide path
export const MAX_GRADIENT = 0.08;          // never steeper than this, up or down
export const FLIGHT = Object.freeze({
  plane: Object.freeze({ vr: 160, vapp: 180, acc: 50, brake: 60, taxi: 50, cruiseAlt: CRUISE_ALTITUDE, turn: 20, final: 1600 }),
  small_plane: Object.freeze({ vr: 70, vapp: 85, acc: 25, brake: 30, taxi: 30, cruiseAlt: 350, turn: 30, final: 1200 }),
  jet: Object.freeze({ vr: 230, vapp: 250, acc: 80, brake: 95, taxi: 60, cruiseAlt: 1200, turn: 15, final: 2600 })
});
const ROTOR = Object.freeze({
  helicopter: { cruiseAlt: 250, vz: 40, az: 10, acc: 40 },
  drone: { cruiseAlt: 45, vz: 12, az: 4, acc: 20 },
  hot_air_balloon: { cruiseAlt: 180, vz: 6, az: 1.5, acc: 4 }
});
// Ground and water: acceleration a step (braking is 1.6 times this).
const ACCEL = { car: 25, taxi: 25, police_car: 30, bus: 12, truck: 12, army_truck: 14, tractor: 6, bike: 8, motorbike: 30, train: 15, boat: 8, ship: 6, ferry: 10, patrol_boat: 14 };
const accelOf = (kind, vmax) => { const c = catalogFor(kind); for (const [k, a] of Object.entries(ACCEL)) if (catalogFor(k) === c) return a; return Math.max(2, vmax * 0.3); };

// --- the world's terrain, roads and water, cached --------------------------------------------

const TERRAINS = new Map();
export function terrainOf(spec, ents) {
  const sig = `${spec.size.x}x${spec.size.y}|${terrainSignature(ents)}`;
  let t = TERRAINS.get(sig);
  if (!t) { t = buildTerrain(ents, spec.size); TERRAINS.set(sig, t); while (TERRAINS.size > 8) TERRAINS.delete(TERRAINS.keys().next().value); }
  return t;
}

// The water graph: the centres of sea (and lake) cells with open water
// round them, joined to their eight neighbours, plus the line of every
// river and creek. Boats find their way on it with A* (roads.mjs nextHop).
const WATERS = new Map();
export function waterGraph(spec, terrain) {
  const key = terrain;
  if (WATERS.has(key)) return WATERS.get(key);
  const S = spec.size;
  const cell = Math.max(25, Math.min(100, Math.max(S.x, S.y) / 120));
  const nx = Math.max(1, Math.ceil(S.x / cell)); const ny = Math.max(1, Math.ceil(S.y / cell));
  const xs = []; const ys = []; const id = new Int32Array(nx * ny).fill(-1);
  const open = Math.min(cell * 0.6, 40);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = Math.min(S.x, (i + 0.5) * cell); const y = Math.min(S.y, (j + 0.5) * cell);
    if (terrain.coastDistance(x, y) <= -open) { id[j * nx + i] = xs.length; xs.push(x); ys.push(y); }
  }
  const adj = [];
  const link = (a, b) => { const c = Math.hypot(xs[a] - xs[b], ys[a] - ys[b]); adj[a].push({ to: b, cost: c }); adj[b].push({ to: a, cost: c }); };
  for (let k = 0; k < xs.length; k++) adj.push([]);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = id[j * nx + i]; if (a < 0) continue;
    for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const ii = i + di; const jj = j + dj; if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const b = id[jj * nx + ii]; if (b < 0) continue;
      if (di && dj && (id[j * nx + ii] < 0 || id[jj * nx + i] < 0)) continue; // no corner cutting
      link(a, b);
    }
  }
  // Rivers and creeks: a node every 40 m along each, joined to the open
  // water and to each other where they meet.
  const stripNodes = [];
  for (const s of terrain.features.strips) {
    const L = Math.hypot(s.x2 - s.x, s.y2 - s.y); const n = Math.max(1, Math.ceil(L / 40));
    let prev = -1;
    for (let q = 0; q <= n; q++) {
      const x = s.x + ((s.x2 - s.x) * q) / n; const y = s.y + ((s.y2 - s.y) * q) / n;
      if (x < 0 || y < 0 || x > S.x || y > S.y || terrain.coastDistance(x, y) > -1) { prev = -1; continue; }
      const k = xs.length; xs.push(x); ys.push(y); adj.push([]); stripNodes.push(k);
      if (prev >= 0) link(prev, k);
      prev = k;
    }
  }
  for (const k of stripNodes) {
    for (let m = 0; m < xs.length; m++) {
      if (m === k || adj[k].some((x) => x.to === m)) continue;
      const d = Math.hypot(xs[m] - xs[k], ys[m] - ys[k]);
      if (d > 60) continue;
      if (terrain.clearLine({ x: xs[k], y: ys[k] }, { x: xs[m], y: ys[m] }, true, { every: 4, margin: 0.5 })) link(k, m);
    }
  }
  for (const list of adj) list.sort((p, q) => p.to - q.to);
  // Bodies of water: which nodes reach which.
  const comp = new Int32Array(xs.length).fill(-1); let c = 0;
  for (let k = 0; k < xs.length; k++) { if (comp[k] >= 0) continue; const stack = [k]; comp[k] = c; while (stack.length) { const u = stack.pop(); for (const { to } of adj[u]) if (comp[to] < 0) { comp[to] = c; stack.push(to); } } c++; }
  const gcell = 80; const grid = new Map();
  for (let k = 0; k < xs.length; k++) { const g = `${Math.floor(xs[k] / gcell)}|${Math.floor(ys[k] / gcell)}`; if (!grid.has(g)) grid.set(g, []); grid.get(g).push(k); }
  const g = { n: xs.length, xs: Float64Array.from(xs), ys: Float64Array.from(ys), adj: { boat: adj }, mass: Array.from(comp), cell: gcell, grid, hops: { boat: new Map() } };
  WATERS.set(key, g);
  while (WATERS.size > 6) WATERS.delete(WATERS.keys().next().value);
  return g;
}

// The same for land, where a world has no roads: a coarse grid of cells
// clear of the coast. Ground things go round water on it.
const LANDS = new Map();
function landGraph(spec, terrain) {
  if (LANDS.has(terrain)) return LANDS.get(terrain);
  const S = spec.size;
  const cell = Math.max(10, Math.min(100, Math.max(S.x, S.y) / 120));
  const nx = Math.max(1, Math.ceil(S.x / cell)); const ny = Math.max(1, Math.ceil(S.y / cell));
  const xs = []; const ys = []; const id = new Int32Array(nx * ny).fill(-1);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = Math.min(S.x, (i + 0.5) * cell); const y = Math.min(S.y, (j + 0.5) * cell);
    if (terrain.coastDistance(x, y) >= Math.min(cell * 0.6, 20)) { id[j * nx + i] = xs.length; xs.push(x); ys.push(y); }
  }
  const adj = xs.map(() => []);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = id[j * nx + i]; if (a < 0) continue;
    for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const ii = i + di; const jj = j + dj; if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const b = id[jj * nx + ii]; if (b < 0) continue;
      if (di && dj && (id[j * nx + ii] < 0 || id[jj * nx + i] < 0)) continue;
      const c = Math.hypot(xs[a] - xs[b], ys[a] - ys[b]); adj[a].push({ to: b, cost: c }); adj[b].push({ to: a, cost: c });
    }
  }
  for (const list of adj) list.sort((p, q) => p.to - q.to);
  const gcell = 80; const grid = new Map();
  for (let k = 0; k < xs.length; k++) { const g = `${Math.floor(xs[k] / gcell)}|${Math.floor(ys[k] / gcell)}`; if (!grid.has(g)) grid.set(g, []); grid.get(g).push(k); }
  const g = { n: xs.length, xs: Float64Array.from(xs), ys: Float64Array.from(ys), adj: { walk: adj, car: adj }, mass: xs.map((x, k) => terrain.islandAt(x, ys[k])), cell: gcell, grid, hops: { walk: new Map(), car: new Map() } };
  LANDS.set(terrain, g);
  while (LANDS.size > 6) LANDS.delete(LANDS.keys().next().value);
  return g;
}

// The context a step's travel works in.
export function moveContext(spec, ents) {
  const terrain = terrainOf(spec, ents);
  const roads = roadGraph(spec, ents, terrain);
  return { spec, terrain, roads: roads.n ? roads : null, water: null, land: null, berths: new Map(), runways: ents.filter((e) => catalogFor(e.kind) === catalogFor('runway')) };
}
const waterOf = (ctx) => ctx.water || (ctx.water = waterGraph(ctx.spec, ctx.terrain));
const landOf = (ctx) => ctx.land || (ctx.land = landGraph(ctx.spec, ctx.terrain));

// --- small helpers ----------------------------------------------------------------------------

const clampTo = (p, S) => ({ x: r4(Math.min(S.x, Math.max(0, p.x))), y: r4(Math.min(S.y, Math.max(0, p.y))), z: r4(Math.min(S.z, Math.max(0, p.z || 0))) });
const angDiff = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
const bearing = (from, to) => (Math.atan2(to.y - from.y, to.x - from.x) / DEG + 360) % 360;
const nameOf = (e) => (e && e.properties && typeof e.properties.name === 'string' && e.properties.name ? `${e.properties.name}${e.properties.family ? ` ${e.properties.family}` : ''}` : e ? e.id : 'it');
function clearProps(p, keys) { for (const k of keys) delete p[k]; }
const ROUTE_KEYS = ['rn', 'rp', 'rg', 'open_to', 'sail_to'];
// Set while a vehicle has been told no road goes where it wanted (one event, not one a step).
const NO_ROAD = 'no_road';
// Places people walk to straight across open ground when the way is clear land.
const OPEN_GROUND = new Set(['beach', 'fountain', 'monument', 'lifeguard_tower']);
const FLIGHT_KEYS = ['fp', 'rw', 'rwd'];

// Steer along a grid graph (water, or land without roads): the farthest
// node of the route ahead that a straight line reaches.
function gridWaypoint(g, ctx, pos, goal, mode, wantWater) {
  const T = ctx.terrain;
  const margin = wantWater ? 1 : 1;
  if (T.clearLine(pos, goal, wantWater, { every: 8, margin })) return goal;
  const start = nearestNode(g, pos.x, pos.y, { mode, maxR: 600 });
  const end = nearestNode(g, goal.x, goal.y, { mode, maxR: 2000 });
  if (start < 0 || end < 0) return null;
  if (g.mass[start] !== g.mass[end]) return null;
  let best = { x: g.xs[start], y: g.ys[start] };
  let k = start;
  for (let i = 0; i < 10 && k !== end && k >= 0; i++) {
    k = nextHop(g, mode, k, end);
    if (k < 0) break;
    const pt = { x: g.xs[k], y: g.ys[k] };
    if (T.clearLine(pos, pt, wantWater, { every: 8, margin })) best = pt; else break;
  }
  if (k === end && T.clearLine(best, goal, wantWater, { every: 8, margin })) {
    if (T.clearLine(pos, goal, wantWater, { every: 8, margin })) return goal;
  }
  return best;
}

// Moves from `pos` up to `step` metres toward `to`; returns the new point and what is left.
function advance(pos, to, step) {
  const d = Math.hypot(to.x - pos.x, to.y - pos.y);
  if (d <= step) return { x: to.x, y: to.y, left: step - d, reached: true };
  const f = step / d;
  return { x: pos.x + (to.x - pos.x) * f, y: pos.y + (to.y - pos.y) * f, left: 0, reached: false };
}

// --- the travel rule ----------------------------------------------------------------------------

// One step of a travel rule. ctx: { s, ents, removed, rand, emit, mc }.
export function travelStep(r, { s, ents, removed, rand, emit, mc, spaceAt }) {
  // One index of the step's entities, shared by every travel rule (what a
  // rule removes is checked as it goes).
  if (!mc.index || mc.indexed !== ents.length) { mc.index = new Map(ents.map((e) => [e.id, e])); mc.indexed = ents.length; }
  const all = mc.index;
  const index = { get: (id) => { const x = all.get(id); return x && !removed.has(id) ? x : undefined; }, has: (id) => all.has(id) && !removed.has(id), values: () => [...all.values()].filter((x) => !removed.has(x.id)) };
  const T = mc.terrain;
  for (const e of ents) {
    if (e.kind !== r.kind || removed.has(e.id)) continue;
    const p = e.properties;
    // A traveller aboard a ferry or a plane to another island gets off there.
    if (typeof p.inside === 'string' && p.inside && index.has(p.inside)) { if (p.transit) disembark(e, index.get(p.inside), { mc, index, emit, S: s.size }); continue; }
    let goal = null; let goalId = null;
    if (typeof p.target === 'string' && p.target) {
      const t = index.get(p.target);
      if (!t || t.id === e.id) continue;
      goal = { ...t.position }; goalId = t.id;
    } else if (['target_x', 'target_y', 'target_z'].some((key) => typeof p[key] === 'number')) {
      goal = { x: typeof p.target_x === 'number' ? p.target_x : e.position.x, y: typeof p.target_y === 'number' ? p.target_y : e.position.y, z: typeof p.target_z === 'number' ? p.target_z : e.position.z };
    } else if (r.roam) {
      // A ferry or a plane at its harbour or airport waits there a while
      // (TURNAROUND steps) so that passengers can board, then goes on.
      const hub = typeof p.at === 'string' ? index.get(p.at) : null;
      const ht = hub && hubType(hub);
      if (ht && HUB_CRAFT[ht].some((k) => catalogFor(k) === catalogFor(e.kind))) {
        const w = Number(p.turnaround) || 0;
        if (w < TURNAROUND) { p.turnaround = w + 1; continue; }
      }
      delete p.turnaround;
      // Somewhere it can get to: the same island on foot or by road, the same water by boat.
      let pool = ents.filter((o) => !removed.has(o.id) && o.id !== e.id && r.roam.includes(o.kind) && o.id !== p.at);
      if (isGroundKind(e.kind) && T.hasLand) { const here = T.islandAt(e.position.x, e.position.y); const same = pool.filter((o) => massOf(mc, o) === here); if (same.length) pool = same; }
      if (isWaterKind(e.kind)) { const reach = pool.filter((o) => sameWater(mc, e.position, berthOf(mc, o))); if (reach.length) pool = reach; }
      if (!pool.length) continue;
      const t = pool[Math.floor(rand() * pool.length)];
      p.target = t.id; goal = { ...t.position }; goalId = t.id;
    } else continue;
    const cat = catalogFor(e.kind);
    if (cat.domain === 'fixed') continue;
    const speed = r.speed !== undefined ? r.speed : (typeof p.speed === 'number' && p.speed > 0 ? Math.min(p.speed, 20000) : (cat.speed || 5));
    if (!(speed > 0)) continue;
    const goalEnt = goalId ? index.get(goalId) : null;
    moveEntity(e, { s, mc, index, emit, spaceAt, speed, goal, goalId, goalEnt });
  }
}

function moveEntity(e, env) {
  const cat = catalogFor(e.kind);
  if (cat.domain === 'space') moveSpace(e, env);
  else if (cat.domain === 'air') { if (isFixedWing(e.kind)) flyFixedWing(e, env); else flyRotor(e, env); }
  else if (cat.domain === 'water') sail(e, env);
  else moveGround(e, env);
}

// One step of travel for one entity toward another, by the same rules as
// the travel rule (the blind experiments' "go" uses it). Returns whether it
// arrived. The entity's own target is left as it was.
export function moveToward(spec, ents, e, dest, { speed = null, spaceAt = 2000 } = {}) {
  const mc = moveContext(spec, ents);
  const all = new Map(ents.map((x) => [x.id, x]));
  const index = { get: (id) => all.get(id), has: (id) => all.has(id), values: () => all.values() };
  const p = e.properties;
  const keep = { target: p.target, at: p.at };
  p.target = dest.id;
  const cat = catalogFor(e.kind);
  let arrived = false;
  const emit = (kind) => { if (kind === 'arrive') arrived = true; };
  moveEntity(e, { s: spec, mc, index, emit, spaceAt, speed: speed || cat.speed || 5, goal: { ...dest.position }, goalId: dest.id, goalEnt: dest });
  if (keep.target === undefined) delete p.target; else p.target = keep.target;
  if (!arrived) { if (keep.at === undefined) delete p.at; else p.at = keep.at; }
  return arrived;
}

// The land mass a place stands on, remembered for things that never move.
function massOf(mc, o) {
  if (catalogFor(o.kind).domain !== 'fixed') return mc.terrain.islandAt(o.position.x, o.position.y);
  const cache = mc.terrain.massCache || (mc.terrain.massCache = new Map());
  const key = `${o.id}|${o.position.x}|${o.position.y}`;
  let m = cache.get(key);
  if (m === undefined) { m = mc.terrain.islandAt(o.position.x, o.position.y); if (cache.size > 20000) cache.clear(); cache.set(key, m); }
  return m;
}

function arrive(e, goalId, emit) {
  const p = e.properties;
  delete p.target; delete p.target_x; delete p.target_y; delete p.target_z;
  clearProps(p, ROUTE_KEYS);
  if (goalId) p.at = goalId;
  emit('arrive', `${e.id} arrived at ${goalId || 'its destination'}`, e.id);
}

// Stop at a building's edge, not in the middle of it.
function doorPoint(e, goal, goalEnt, toward) {
  const fp = goalEnt ? (catalogFor(goalEnt.kind).footprint || 0) : 0;
  if (!(fp > 0)) return { x: goal.x, y: goal.y };
  const gx = toward.x - goal.x; const gy = toward.y - goal.y; const gd = Math.hypot(gx, gy);
  if (gd > fp) return { x: goal.x + (gx / gd) * fp, y: goal.y + (gy / gd) * fp };
  return { x: toward.x, y: toward.y };
}

// --- space: straight there, as before ------------------------------------------------------------

function moveSpace(e, { s, goal, goalId, goalEnt, speed, emit, spaceAt }) {
  const d0 = doorPoint(e, goal, goalEnt, e.position);
  let g = clampTo({ x: d0.x, y: d0.y, z: goal.z }, s.size);
  const from = e.position;
  const total = Math.hypot(g.x - from.x, g.y - from.y, g.z - from.z);
  let next;
  if (total <= speed) next = g;
  else { const f = speed / total; next = { x: from.x + (g.x - from.x) * f, y: from.y + (g.y - from.y) * f, z: from.z + (g.z - from.z) * f }; }
  next = clampTo(next, s.size);
  if (from.z < spaceAt && next.z >= spaceAt) emit('space', `${e.id} reached space`, e.id);
  if (from.z >= spaceAt && next.z < spaceAt) emit('reentry', `${e.id} came back down from space`, e.id);
  e.position = next;
  if (Math.hypot(next.x - g.x, next.y - g.y, next.z - g.z) < 1e-6) arrive(e, goalId, emit);
}

// --- ground -----------------------------------------------------------------------------------------

const HUB_CRAFT = { port: ['ferry', 'ship'], runway: ['plane', 'small_plane'] };
const TURNAROUND = 10;   // steps a ferry or plane waits at its hub for passengers (an hour at 240 steps a day)
const hubType = (e) => (catalogFor(e.kind) === catalogFor('port') ? 'port' : catalogFor(e.kind) === catalogFor('runway') ? 'runway' : null);

function moveGround(e, env) {
  const { s, mc, index, emit, goalId, goalEnt } = env;
  const T = mc.terrain;
  const p = e.properties;
  let goal = { x: env.goal.x, y: env.goal.y };
  const here = T.islandAt(e.position.x, e.position.y);
  if (!T.isLand(goal.x, goal.y)) { const q = T.nearestLand(goal.x, goal.y); if (q) goal = q; }
  const there = T.islandAt(goal.x, goal.y);
  // Another island: by the harbour or the airport, aboard a ferry or a plane.
  if (T.hasLand && here && there && here !== there) {
    if (p.transit && p.transit_hub === goalId) { /* already heading to the hub */ } else {
      const hub = pickHub(e, here, there, mc, index);
      if (!hub) {
        emit('trip_refused', `${nameOf(e)} cannot get to ${goalEnt ? nameOf(goalEnt) : 'that place'}: no ferry or flight goes from here to there`, e.id);
        delete p.target; delete p.target_x; delete p.target_y; delete p.target_z; clearProps(p, ROUTE_KEYS);
        return;
      }
      p.transit = goalId || `@${r2(goal.x)},${r2(goal.y)}`;
      p.transit_hub = hub.id;
      delete p.target_x; delete p.target_y; delete p.target_z;
      p.target = hub.id;
      clearProps(p, ROUTE_KEYS);
      return moveGround(e, { ...env, goal: { ...hub.position }, goalId: hub.id, goalEnt: hub });
    }
  }
  if (p.transit && p.transit_hub !== goalId) { delete p.transit; delete p.transit_hub; }
  const person = ['person', 'animal'].includes(catalogFor(e.kind).class);
  const bike = catalogFor(e.kind) === catalogFor('bike');
  const mode = person || bike ? 'walk' : 'car';
  // A fixed place's door and its node on the network are worked out once.
  const g = mc.roads;
  const fixedGoal = goalEnt && catalogFor(goalEnt.kind).domain === 'fixed';
  const dkey = fixedGoal && g ? `${goalEnt.id}|${goal.x}|${goal.y}|${mode}` : null;
  let dc = dkey ? g.doors && g.doors.get(dkey) : null;
  if (!dc) {
    const side = roadSideOf(mc, goal, goalEnt, mode, there);
    const door0 = doorPoint(e, goal, goalEnt, side || e.position);
    dc = { door: door0, node: g ? nearestNode(g, door0.x, door0.y, { mode, mass: there || undefined }) : -1 };
    // Remembered only when it does not depend on who is asking (no road near: the door faces them).
    if (dkey && side) { if (!g.doors) g.doors = new Map(); if (g.doors.size > 50000) g.doors.clear(); g.doors.set(dkey, dc); }
  }
  // Vehicles keep strictly to the roads: they stop at the place's node on
  // the network (its driveway), never drive over open ground to its door,
  // and where no road goes they do not go.
  const vehicle = !person && !!g && isRoadVehicle(catalogFor(e.kind), e.kind);
  const door = vehicle && dc.node >= 0 ? { x: g.xs[dc.node], y: g.ys[dc.node] } : dc.door;
  const noRoad = () => {
    const what = goalId || `${Math.round(goal.x)},${Math.round(goal.y)}`;
    if (p[NO_ROAD] !== what) emit('trip_refused', `${nameOf(e)} cannot drive to ${goalEnt ? nameOf(goalEnt) : 'that place'}: no road goes there`, e.id);
    p[NO_ROAD] = what;
    delete p.target; delete p.target_x; delete p.target_y; delete p.target_z; clearProps(p, ROUTE_KEYS);
    if (!person) p.v = 0;
  };
  if (vehicle && dc.node < 0) return noRoad();
  // At a hub with a trip ahead: board whatever is in, else wait.
  if (p.transit && goalEnt && goalId === p.transit_hub && Math.hypot(door.x - e.position.x, door.y - e.position.y) < 2) { board(e, goalEnt, mc, index, emit); return; }
  const vmax = env.speed;
  const S = s.size;
  // Speed: people walk at their pace; vehicles accelerate and brake.
  const a = person ? vmax : accelOf(e.kind, vmax);
  const brake = a * 1.6;
  let v = person ? vmax : Math.min(vmax, (typeof p.v === 'number' ? p.v : 0) + a);
  const straight = Math.hypot(door.x - e.position.x, door.y - e.position.y);
  // On foot to open ground (a beach, a fountain, a monument), across it when the way is clear land.
  const openGround = person && goalEnt && OPEN_GROUND.has(base(goalEnt.kind));
  // (The way across is checked once a trip: a clear line stays clear as they walk along it.)
  const clearTo = () => { if (openGround && straight > 120) { if (p.open_to === goalId) return true; const ok = T.clearLine(e.position, door, false, { every: 12 }); if (ok) p.open_to = goalId; return ok; } return T.clearLine(e.position, door, false, { every: 6 }); };
  const near = !vehicle && straight <= (person ? (openGround ? 1200 : 120) : 50) && clearTo();
  let pos = { x: e.position.x, y: e.position.y };
  // A vehicle off the road (put there by hand, or built there) joins it at the nearest point first.
  if (vehicle && offRoad(g, pos.x, pos.y, { paths: bike }) > 0.5) {
    const q = roadPoint(g, pos.x, pos.y, { mode });
    if (!q) return noRoad();
    pos = { x: q.x, y: q.y };
  }
  let arrived = false;
  if (g && !near) {
    const goalNode = dc.node;
    if (goalNode >= 0) {
      // A new destination while already on the way to a node: carry on to
      // that node (no turning back mid-street), then on toward the new one.
      if (typeof p.rn === 'number' && p.rn >= 0 && p.rn < g.n && p.rg !== goalNode && Math.hypot(g.xs[p.rn] - pos.x, g.ys[p.rn] - pos.y) < 400) p.rg = goalNode;
      if (p.rg !== goalNode || typeof p.rn !== 'number' || p.rn >= g.n || p.rn < -2) {
        let start;
        if (vehicle) {
          // From the road it is on: whichever end of it the way goes through.
          const q = roadPoint(g, pos.x, pos.y, { mode });
          if (!q) return noRoad();
          const E = g.edges[q.edge];
          start = nextHop(g, mode, E.a, goalNode) === E.b ? E.b : E.a;
        } else start = nearestNode(g, pos.x, pos.y, { mode, mass: here || undefined });
        // A vehicle with no way along the roads from here to there stays put.
        if (vehicle && nextHop(g, mode, start, goalNode) < 0) return noRoad();
        if (start < 0) { p.rn = -2; p.rp = -1; } else { p.rn = start; p.rp = -1; }
        p.rg = goalNode;
      }
      // Speed for what is ahead: the next corner or junction, or the door.
      if (!person) {
        const ahead = p.rn >= 0 ? { x: g.xs[p.rn], y: g.ys[p.rn] } : door;
        const d = Math.hypot(ahead.x - pos.x, ahead.y - pos.y);
        const vc = p.rn >= 0 ? cornerSpeed(g, mode, p.rp, p.rn, p.rg, vmax) : 0;
        v = Math.min(v, Math.sqrt(vc * vc + 2 * brake * d));
        if (v < 1) v = Math.min(a, Math.max(1, d));
      }
      let left = v;
      for (let guard = 0; guard < 40 && left > 1e-6; guard++) {
        const to = p.rn >= 0 ? laneOf(g, mode, p.rp, p.rn, bike) : door;
        const st = advance(pos, to, left);
        pos = { x: st.x, y: st.y }; left = st.left;
        if (!st.reached) break;
        if (p.rn === -2) { arrived = true; break; }
        if (p.rn === p.rg) { p.rp = p.rn; p.rn = -2; continue; }
        const nh = nextHop(g, mode, p.rn, p.rg);
        if (nh < 0 && vehicle) return noRoad();
        p.rp = p.rn; p.rn = nh < 0 ? -2 : nh;
      }
    }
  }
  if (!arrived && vehicle && !(g && dc.node >= 0)) return noRoad();
  if (!arrived && !vehicle && (near || !g || dc.node < 0)) {
    // Straight to the door when the way is clear; otherwise round the water on the land grid.
    if (!person && near) v = Math.min(v, Math.sqrt(2 * brake * straight) + 1);
    const way = T.clearLine(pos, door, false, { every: 6 }) ? door : gridWaypoint(landOf(mc), mc, pos, door, mode, false);
    if (way) {
      const st = advance(pos, way, v);
      pos = { x: st.x, y: st.y };
      if (st.reached && way === door) arrived = true;
    }
  }
  const next = clampTo({ x: pos.x, y: pos.y, z: 0 }, S);
  if (!T.isLand(next.x, next.y) && T.isLand(e.position.x, e.position.y)) { p.v = 0; return; } // the water's edge: no further
  if (!person) p.v = r2(arrived ? 0 : Math.min(v, Math.hypot(next.x - e.position.x, next.y - e.position.y) + a));
  e.position = next;
  if (arrived || Math.hypot(next.x - door.x, next.y - door.y) < 1e-3) {
    if (p.transit && goalId === p.transit_hub) { clearProps(p, ROUTE_KEYS); p.at = goalId; board(e, goalEnt, mc, index, emit); return; }
    arrive(e, goalId, emit);
    delete p[NO_ROAD];
    if (!person) p.v = 0;
  }
}

// Where a place meets the road network (to set its door on that side).
function roadSideOf(mc, goal, goalEnt, mode, mass) {
  const g = mc.roads;
  if (!g || !goalEnt) return null;
  const k = nearestNode(g, goal.x, goal.y, { mode, mass: mass || undefined, maxR: 400 });
  return k >= 0 ? { x: g.xs[k], y: g.ys[k] } : null;
}

// The point to aim for at a node: on the right of the road (vehicles), on
// the pavement (people), at the edge (bikes).
function laneOf(g, mode, from, to, bike) {
  const x = g.xs[to]; const y = g.ys[to];
  if (from < 0) return { x, y };
  const dx = x - g.xs[from]; const dy = y - g.ys[from]; const d = Math.hypot(dx, dy) || 1;
  let w = 8;
  for (const it of g.adj.walk[from]) if (it.to === to) { w = g.edges[it.e] ? g.edges[it.e].w : w; break; }
  const off = mode === 'car' ? Math.min(w / 4, 2.5) : bike ? (w >= FOOTPATH_WIDTH ? Math.max(0, w / 2 - 1) : 0) : (w >= FOOTPATH_WIDTH ? w / 2 + 1.5 : 0);
  return { x: x + (dy / d) * off, y: y - (dx / d) * off };
}

// How fast to take the next node: slower for junctions and sharper bends.
function cornerSpeed(g, mode, prev, at, goal, vmax) {
  if (at === goal) return vmax * 0.4;
  const next = nextHop(g, mode, at, goal);
  if (next < 0 || prev < 0) return vmax * 0.5;
  const a1 = Math.atan2(g.ys[at] - g.ys[prev], g.xs[at] - g.xs[prev]);
  const a2 = Math.atan2(g.ys[next] - g.ys[at], g.xs[next] - g.xs[at]);
  let th = Math.abs(a2 - a1); if (th > Math.PI) th = 2 * Math.PI - th;
  let f = Math.max(0.2, Math.cos(th / 2) ** 2);
  if (g.adj[mode][at].length >= 3) f = Math.min(f, 0.6);
  return vmax * f;
}

// The harbour or airport on this island with a link to that one.
function pickHub(e, here, there, mc, index) {
  const T = mc.terrain;
  const all = [...index.values()];
  const hubs = (mass, type) => all.filter((h) => hubType(h) === type && T.islandAt(...landPointOf(h, T)) === mass);
  const opts = [];
  for (const type of ['port', 'runway']) {
    if (!all.some((x) => HUB_CRAFT[type].some((k) => catalogFor(x.kind) === catalogFor(k)))) continue;
    const mine = hubs(here, type); const theirs = hubs(there, type);
    if (!mine.length || !theirs.length) continue;
    for (const h of mine) opts.push({ h, d: Math.hypot(h.position.x - e.position.x, h.position.y - e.position.y) });
  }
  opts.sort((a, b) => a.d - b.d || (a.h.id < b.h.id ? -1 : 1));
  return opts.length ? opts[0].h : null;
}
const landPointOf = (h, T) => { if (T.isLand(h.position.x, h.position.y)) return [h.position.x, h.position.y]; const q = T.nearestLand(h.position.x, h.position.y) || h.position; return [q.x, q.y]; };

function board(e, hub, mc, index, emit) {
  const p = e.properties;
  const type = hubType(hub);
  if (!type) return;
  const near = type === 'port' ? 150 : 800;
  const crafts = [...index.values()].filter((x) => HUB_CRAFT[type].some((k) => catalogFor(x.kind) === catalogFor(k)) && x.properties.at === hub.id && !x.properties.target && Math.hypot(x.position.x - hub.position.x, x.position.y - hub.position.y) < near).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!crafts.length) return;
  const craft = crafts[0];
  p.inside = craft.id; e.position = { ...craft.position };
  clearProps(p, ROUTE_KEYS); delete p.v;
  emit('travel', `${nameOf(e)} boarded ${nameOf(craft)} at ${nameOf(hub)}`, e.id);
}

function disembark(e, craft, { mc, index, emit, S }) {
  const p = e.properties;
  if (craft.properties.target || typeof craft.properties.at !== 'string') return;
  const hub = index.get(craft.properties.at);
  if (!hub || !hubType(hub)) return;
  const T = mc.terrain;
  const dest = p.transit.startsWith('@') ? (() => { const [x, y] = p.transit.slice(1).split(',').map(Number); return { x, y }; })() : (index.get(p.transit) || { position: null }).position;
  if (!dest) { delete p.transit; delete p.transit_hub; return; }
  const want = T.islandAt(...(T.isLand(dest.x, dest.y) ? [dest.x, dest.y] : (() => { const q = T.nearestLand(dest.x, dest.y) || dest; return [q.x, q.y]; })()));
  if (T.islandAt(...landPointOf(hub, T)) !== want) return;
  delete p.inside;
  const [lx, ly] = landPointOf(hub, T);
  e.position = clampTo({ x: lx, y: ly, z: 0 }, S);
  if (p.transit.startsWith('@')) { p.target_x = dest.x; p.target_y = dest.y; } else p.target = p.transit;
  delete p.transit; delete p.transit_hub;
  p.at = hub.id;
  emit('travel', `${nameOf(e)} got off ${nameOf(craft)} at ${nameOf(hub)}`, e.id);
}

// --- water -------------------------------------------------------------------------------------------

// Where a boat stops for a place: the place itself on the water, else the
// nearest water to it (a harbour's water side).
export function berthOf(mc, ent) {
  const key = `${ent.id}|${ent.position.x}|${ent.position.y}`;
  const T = mc.terrain;
  const cache = T.berths || (T.berths = new Map());
  if (cache.has(key)) return cache.get(key);
  let b = { x: ent.position.x, y: ent.position.y };
  if (T.coastDistance(b.x, b.y) > -2) b = T.nearestWater(b.x, b.y, { margin: 8 }) || b;
  if (cache.size > 5000) cache.clear();
  cache.set(key, b);
  return b;
}
function sameWater(mc, a, b) {
  const g = waterOf(mc);
  const x = nearestNode(g, a.x, a.y, { mode: 'boat', maxR: 1500 }); const y = nearestNode(g, b.x, b.y, { mode: 'boat', maxR: 1500 });
  if (x < 0 || y < 0) return mc.terrain.clearLine(a, b, true);
  return g.mass[x] === g.mass[y];
}

function sail(e, env) {
  const { s, mc, emit, goalId, goalEnt } = env;
  const T = mc.terrain;
  const p = e.properties;
  let goal = goalEnt ? berthOf(mc, goalEnt) : { x: env.goal.x, y: env.goal.y };
  if (!goalEnt && T.coastDistance(goal.x, goal.y) > -2) goal = T.nearestWater(goal.x, goal.y, { margin: 5 }) || goal;
  goal = clampTo(goal, s.size);
  const vmax = env.speed;
  const a = accelOf(e.kind, vmax);
  const dist = Math.hypot(goal.x - e.position.x, goal.y - e.position.y);
  let v = Math.min(vmax, (typeof p.v === 'number' ? p.v : 0) + a, Math.sqrt(2 * a * 1.6 * dist) + a);
  if (v < 1) v = Math.min(dist, a);
  // Open water all the way: straight there (checked once a trip); otherwise round the land (A*).
  const open = p.sail_to === (goalId || `${goal.x},${goal.y}`) || (dist < 2500 && T.clearLine(e.position, goal, true, { every: 15, margin: 4 }) && (p.sail_to = goalId || `${goal.x},${goal.y}`));
  const way = open ? goal : gridWaypoint(waterOf(mc), mc, e.position, goal, 'boat', true) || goal;
  const st = advance(e.position, way, v);
  const next = clampTo({ x: st.x, y: st.y, z: 0 }, s.size);
  if (T.isLand(next.x, next.y) && !T.isLand(e.position.x, e.position.y)) { p.v = 0; return; } // the shore: no further
  p.v = r2(Math.hypot(next.x - e.position.x, next.y - e.position.y));
  e.position = next;
  if (Math.hypot(next.x - goal.x, next.y - goal.y) < 1e-3) { arrive(e, goalId, emit); p.v = 0; }
}

// --- air: rotorcraft and balloons --------------------------------------------------------------------

// How tall the things are that a low flyer must clear (metres; as the
// viewer draws them): towers, blocks and hotels by their floors, the rest
// by kind.
const TALL = { stadium: 30, terminal: 30, amusement: 31, factory: 26, port: 26, hospital: 20, launch_pad: 18, station: 17, theatre: 15, school: 14, hangar: 14, barn: 14, cinema: 11, house: 11, cabin: 11, hotel: 20, apartment: 30, tower: 60, police_station: 14, prison: 14, barracks: 12, palace: 12, fire_station: 12 };
export function heightOf(e) {
  const f = Number(e.properties && e.properties.floors) || 0;
  const k = base(e.kind);
  if (k === 'tower' && f) return 3.6 * f + 25;
  if ((k === 'apartment' || k === 'hotel') && f) return 3.2 * f + 3.5;
  return TALL[k] || 0;
}
const distToSegment = (px, py, ax, ay, bx, by) => { const dx = bx - ax; const dy = by - ay; const L = dx * dx + dy * dy; const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0; return Math.hypot(px - ax - t * dx, py - ay - t * dy); };
// The highest thing near the straight way from a to b (within a building's
// size and a margin of it), b's own place left out; kept per step.
function obstacleTop(mc, a, b, skipId) {
  if (!mc.tall) mc.tall = [...(mc.index ? mc.index.values() : [])].filter((x) => catalogFor(x.kind).domain === 'fixed' && heightOf(x) > 8).map((x) => ({ id: x.id, x: x.position.x, y: x.position.y, h: heightOf(x), r: Math.max(15, catalogFor(x.kind).footprint || 0) + 25 }));
  let top = 0;
  for (const o of mc.tall) {
    if (o.id === skipId || o.h <= top) continue;
    if (distToSegment(o.x, o.y, a.x, a.y, b.x, b.y) < o.r) top = o.h;
  }
  return top;
}

const CLEARANCE = 30;   // metres above the tallest thing along the way
const LAND_OVER = 4;    // metres from the landing spot: only then down
const ROOF_PADS = new Set(['hospital', 'tower']);   // roofs with a helicopter pad

function flyRotor(e, env) {
  const { s, emit, goalId, goalEnt, spaceAt, mc } = env;
  const p = e.properties;
  const R = ROTOR[base(e.kind)] || { cruiseAlt: 150, vz: 20, az: 5, acc: Math.max(5, env.speed * 0.25) };
  // A helicopter lands on a hospital's or a tower's roof pad, not at its door.
  const roof = base(e.kind) === 'helicopter' && goalEnt && ROOF_PADS.has(base(goalEnt.kind)) && !goalEnt.properties.lattice;   // (not a launch site's lattice tower)
  const d0 = roof ? goalEnt.position : doorPoint(e, env.goal, goalEnt, e.position);
  const goal = clampTo({ x: d0.x, y: d0.y, z: roof ? heightOf(goalEnt) : Math.min(env.goal.z || 0, spaceAt - 1) }, s.size);
  const z = e.position.z || 0;
  const dh = Math.hypot(goal.x - e.position.x, goal.y - e.position.y);
  const vmax = env.speed;
  let v = typeof p.v === 'number' ? p.v : 0;
  let vz = typeof p.vz === 'number' ? p.vz : 0;
  // Never into a building: it flies at least CLEARANCE above the tallest
  // thing along the way, climbs straight up to that before going across,
  // and comes down only once it is over where it is going.
  // (A roof it lands on counts too: it arrives above it and comes straight down.)
  const safe = Math.max(obstacleTop(mc, e.position, goal, roof ? null : goalId), roof ? goal.z : 0) + CLEARANCE;
  const cruise = Math.min(Math.max(R.cruiseAlt, safe, goal.z), spaceAt - 1, s.size.z);
  const zWant = dh > LAND_OVER ? cruise : goal.z;
  // Vertical: ease toward the height wanted, never a jump.
  const dzWant = zWant - z;
  const vzTarget = Math.max(-R.vz, Math.min(R.vz, Math.sign(dzWant) * Math.min(Math.abs(dzWant), Math.sqrt(2 * R.az * Math.abs(dzWant)))));
  vz = vz + Math.max(-R.az, Math.min(R.az, vzTarget - vz));
  if (Math.abs(dzWant) < 0.5 && Math.abs(vz) <= R.az) vz = dzWant;
  // Horizontal: only once clear of everything along the way; slow down for the end.
  const up = z + vz >= Math.min(safe, cruise) - 1 || dh < 1;
  const vTarget = up ? Math.min(vmax, Math.sqrt(2 * R.acc * dh)) : 0;
  v = Math.max(0, v + Math.max(-R.acc, Math.min(R.acc, vTarget - v)));
  const st = advance(e.position, goal, v);
  // Coming down: never below where it is going (no overshoot into a roof or the ground).
  if (zWant <= z && z + vz < zWant) vz = zWant - z;
  const next = clampTo({ x: st.x, y: st.y, z: z + vz }, s.size);
  if (Math.abs(next.z - goal.z) < 0.5 && st.reached) next.z = goal.z;
  e.position = next;
  p.v = r2(st.reached ? 0 : v); p.vz = r2(next.z === goal.z ? 0 : vz);
  if (st.reached && next.z === goal.z) { arrive(e, goalId, emit); p.v = 0; p.vz = 0; }
}

// --- air: fixed wing -----------------------------------------------------------------------------------

export function runwayGeometry(rw) {
  const q = rw.properties || {};
  const h = typeof q.heading === 'number' ? q.heading : 0;
  return { id: rw.id, c: { x: rw.position.x, y: rw.position.y }, h, u: { x: Math.cos(h * DEG), y: Math.sin(h * DEG) }, L: typeof q.length === 'number' && q.length > 0 ? q.length : 800, W: typeof q.width === 'number' && q.width > 0 ? q.width : 30 };
}
// In a runway's frame for a landing direction d: s along it from the
// threshold (negative before it), x across (positive to the left).
function frame(G, d, pos) {
  const ux = G.u.x * d; const uy = G.u.y * d;
  const thr = { x: G.c.x - ux * G.L / 2, y: G.c.y - uy * G.L / 2 };
  const dx = pos.x - thr.x; const dy = pos.y - thr.y;
  return { s: dx * ux + dy * uy, x: -dx * uy + dy * ux, thr, ux, uy, hdg: (G.h + (d < 0 ? 180 : 0) + 360) % 360 };
}
const pointOn = (G, d, s, x = 0) => { const f = frame(G, d, G.c); return { x: f.thr.x + f.ux * s - f.uy * x, y: f.thr.y + f.uy * s + f.ux * x }; };

function nearestRunway(mc, pt, maxD = Infinity) {
  let best = null; let bd = maxD;
  for (const rw of mc.runways) { const d = Math.hypot(rw.position.x - pt.x, rw.position.y - pt.y); if (d < bd || (d === bd && best && rw.id < best.id)) { bd = d; best = rw; } }
  return best;
}
// Where a plane parks at a runway: beside it, on the terminal's side.
function standOf(G, index) {
  let side = 1;
  let best = null; let bd = 700;
  for (const t of index.values()) if (catalogFor(t.kind) === catalogFor('terminal')) { const d = Math.hypot(t.position.x - G.c.x, t.position.y - G.c.y); if (d < bd) { bd = d; best = t; } }
  if (best) { const dx = best.position.x - G.c.x; const dy = best.position.y - G.c.y; side = (-dx * G.u.y + dy * G.u.x) >= 0 ? 1 : -1; }
  const off = G.W / 2 + 45;
  return { x: G.c.x - G.u.y * off * side, y: G.c.y + G.u.x * off * side };
}

function flyFixedWing(e, env) {
  const { s, mc, emit, goalId, goalEnt, index, spaceAt } = env;
  const p = e.properties;
  const F = FLIGHT[base(e.kind)] || FLIGHT.plane;
  const cruiseV = env.speed;
  const ceiling = Math.max(30, Math.min(F.cruiseAlt, spaceAt - 1, s.size.z - 1));
  const z0 = e.position.z || 0;
  // The runway to land on: the target, else the nearest one to the target.
  const destRw = goalEnt && catalogFor(goalEnt.kind) === catalogFor('runway') ? goalEnt : nearestRunway(mc, env.goal);
  const D = destRw ? runwayGeometry(destRw) : null;
  if (!p.fp) {
    p.v = typeof p.v === 'number' ? p.v : 0;
    if (z0 > 3) { p.fp = 'cruise'; p.v = Math.max(p.v, F.vapp); if (typeof p.hdg !== 'number') p.hdg = Math.round(bearing(e.position, env.goal)); } else p.fp = 'taxi_out';
  }
  let v = typeof p.v === 'number' ? p.v : 0;
  let hdg = typeof p.hdg === 'number' ? p.hdg : bearing(e.position, env.goal);
  let z = z0;
  let pos = { x: e.position.x, y: e.position.y };
  const turnTo = (want) => { const d = angDiff(want, hdg); hdg = (hdg + Math.max(-F.turn, Math.min(F.turn, d)) + 360) % 360; };
  const fwd = (dist) => { pos = { x: pos.x + Math.cos(hdg * DEG) * dist, y: pos.y + Math.sin(hdg * DEG) * dist }; };
  const done = () => { clearProps(p, FLIGHT_KEYS); p.v = 0; e.position = clampTo({ x: pos.x, y: pos.y, z: 0 }, s.size); p.hdg = Math.round(hdg); arrive(e, goalId || (destRw && destRw.id), emit); };
  // The landing direction: approach from the side the plane is on.
  const landDir = () => { if (!D) return 1; const f = frame(D, 1, pos); return f.s < D.L / 2 ? 1 : -1; };

  switch (p.fp) {
    case 'taxi_out': {
      const depRw = nearestRunway(mc, pos, 1000);
      if (depRw && destRw && depRw.id === destRw.id) {
        // Already at the airport it is going to: taxi to the stand.
        const stand = standOf(D, index);
        const st = advance(pos, stand, F.taxi);
        if (st.left || st.reached) hdg = bearing(pos, stand);
        pos = { x: st.x, y: st.y };
        if (st.reached) { done(); return; }
        break;
      }
      let start; let rh;
      if (depRw) {
        const G = runwayGeometry(depRw);
        const d = ((env.goal.x - G.c.x) * G.u.x + (env.goal.y - G.c.y) * G.u.y) >= 0 ? 1 : -1;
        start = pointOn(G, d, 30); rh = (G.h + (d < 0 ? 180 : 0) + 360) % 360; p.rw = depRw.id; p.rwd = d;
      } else { start = { ...pos }; rh = bearing(pos, env.goal); p.rw = ''; }
      const st = advance(pos, start, F.taxi);
      if (Math.hypot(start.x - pos.x, start.y - pos.y) > 0.5) hdg = bearing(pos, start);
      pos = { x: st.x, y: st.y }; v = st.reached ? 0 : F.taxi; z = 0;
      if (st.reached) { hdg = rh; p.fp = 'roll'; v = 0; }
      break;
    }
    case 'roll': {
      v = Math.min(F.vr, v + F.acc); z = 0; fwd(v);
      if (v >= F.vr) p.fp = 'climb';
      break;
    }
    case 'goaround':
    case 'climb':
    case 'cruise':
    case 'final': {
      const d = D ? (typeof p.rwd === 'number' && p.fp === 'final' ? p.rwd : landDir()) : 1;
      if (p.fp !== 'final' && D) p.rwd = d;
      const finalLen = Math.max(F.final, 3 * (F.vapp / (F.turn * DEG)));
      // Without a runway anywhere: straight down to the target at the glide gradient.
      const tdS = D ? D.L * 0.12 : 0;
      const E = D ? pointOn(D, d, -finalLen) : { x: env.goal.x, y: env.goal.y };
      const fr = D ? frame(D, d, pos) : null;
      // The distance still to fly to the touchdown point: along the final
      // when on it or already lined up in front of the runway, else by way of the fix E.
      const lined = D && fr.s < 0 && fr.s > -finalLen * 1.2 && Math.abs(fr.x) < 300 && Math.abs(angDiff(hdg, fr.hdg)) < 45;
      const toGo = D ? (p.fp === 'final' || lined ? Math.max(0, tdS - fr.s) + Math.abs(fr.x) * 0.5 : Math.hypot(E.x - pos.x, E.y - pos.y) + finalLen + tdS) : Math.hypot(env.goal.x - pos.x, env.goal.y - pos.y);
      // Speed: cruise, slowing to the approach speed for the last stretch.
      const vWant = p.fp === 'final' || toGo < finalLen * 2.2 ? F.vapp : cruiseV;
      v = v + Math.max(-F.acc * 0.6, Math.min(F.acc * 0.6, vWant - v));
      if (p.fp === 'climb' || p.fp === 'goaround') v = Math.max(v, F.vr);
      // Height: the most the remaining distance allows on the way down, at most the cruise.
      let zWant = Math.min(ceiling, toGo * GLIDE_GRADIENT * 0.95);
      if (p.fp === 'goaround') zWant = Math.max(zWant, 90);
      // On the final: where the glide path is at the end of this step.
      if (p.fp === 'final') zWant = Math.max(0, (tdS - fr.s - v) * GLIDE_GRADIENT);
      // Heading: straight out until clear of the ground, then for the final.
      if (p.fp === 'final') {
        const want = (fr.hdg + Math.max(-35, Math.min(35, -fr.x * 0.25))) % 360;
        turnTo(want);
      } else if (D && (() => { const f0 = frame(D, d, pos); return f0.s < -200 && f0.s > -finalLen * 3 && Math.abs(f0.x) < finalLen && Math.abs(angDiff(hdg, f0.hdg)) < (p.fp === 'climb' || p.fp === 'goaround' ? 20 : 100); })()) {
        // In front of the runway, more or less lined up: follow the
        // centreline in, and take the final once on it and low enough.
        const f0 = frame(D, d, pos);
        const want = (f0.hdg + Math.max(-60, Math.min(60, -f0.x * 0.12))) % 360;
        if (!((p.fp === 'climb' && z < 60) || (p.fp === 'goaround' && z < 80)) || Math.abs(f0.x) < 60) turnTo(want);
        if (z >= 15 && Math.abs(f0.x) < 60 && Math.abs(angDiff(hdg, f0.hdg)) < 8 && f0.s > -finalLen * 1.4 && z <= (tdS - f0.s) * GLIDE_GRADIENT + 20) p.fp = 'final';
      } else if (p.fp === 'goaround' && z < 80) { /* straight ahead */ }
      else if (p.fp === 'climb' && z < 60) { /* straight ahead */ }
      else if (D) {
        // Away from the runway: head for a point on its centreline well out
        // in front, then the final approach fix, to join the final lined up.
        const E2 = pointOn(D, d, -finalLen * 1.6);
        turnTo(bearing(pos, Math.hypot(E2.x - pos.x, E2.y - pos.y) > finalLen * 0.5 ? E2 : E));
      } else turnTo(bearing(pos, env.goal));
      // Keep inside the world: turn back toward its middle near the edge.
      if (p.fp !== 'final' && !lined) {
        const look = 2.5 * v / (F.turn * DEG) + v;
        const ax = pos.x + Math.cos(hdg * DEG) * look; const ay = pos.y + Math.sin(hdg * DEG) * look;
        if (ax < 0 || ay < 0 || ax > s.size.x || ay > s.size.y) turnTo(bearing(pos, { x: s.size.x / 2, y: s.size.y / 2 }));
      }
      const dzMax = (p.fp === 'final' ? GLIDE_GRADIENT * 1.25 : CLIMB_GRADIENT) * v;
      // Down: the glide path, with room to correct, never past MAX_GRADIENT.
      const dzMin = -(p.fp === 'final' ? MAX_GRADIENT * 0.95 : GLIDE_GRADIENT * 1.3) * v;
      let dz = Math.max(dzMin, Math.min(p.fp === 'final' ? 0 : dzMax, zWant - z));
      if (p.fp === 'climb' && z + dz >= Math.min(ceiling, zWant) - 1 && z > 60) p.fp = 'cruise';
      if (p.fp === 'goaround' && z >= 80) p.fp = 'cruise';
      const was = { ...pos };
      fwd(v);
      pos = { x: Math.min(s.size.x, Math.max(0, pos.x)), y: Math.min(s.size.y, Math.max(0, pos.y)) };
      // Never steeper than the gradient over the ground actually covered.
      const run = Math.hypot(pos.x - was.x, pos.y - was.y);
      if (Math.abs(dz) > MAX_GRADIENT * 0.95 * run) dz = Math.sign(dz) * MAX_GRADIENT * 0.95 * run;
      z = Math.max(0, z + dz);
      if (p.fp === 'final' && D) {
        const f1 = frame(D, d, pos);
        // Go round when not lined up near the runway, or too high.
        if ((f1.s > -400 && (Math.abs(f1.x) > 25 || Math.abs(angDiff(hdg, f1.hdg)) > 12)) || f1.s > D.L * 0.5 || (f1.s > -300 && z > (tdS - f1.s) * GLIDE_GRADIENT + 40)) { p.fp = 'goaround'; break; }
        // Touchdown: on the runway, near the threshold.
        if (z <= 0.5 || f1.s >= tdS) {
          if (z <= 1 && f1.s >= 0 && f1.s <= D.L * 0.5 && Math.abs(f1.x) <= D.W / 2) { z = 0; p.fp = 'rollout'; pos = pointOn(D, d, f1.s, 0); hdg = f1.hdg; emit('touchdown', `${e.id} touched down on ${destRw.id}`, e.id); }
          else { p.fp = 'goaround'; z = Math.max(z, 1); }
        }
      }
      if (!D && Math.hypot(env.goal.x - pos.x, env.goal.y - pos.y) <= v && z <= v * GLIDE_GRADIENT * 1.25 + 0.5) { z = 0; pos = { x: env.goal.x, y: env.goal.y }; done(); return; }
      break;
    }
    case 'rollout': {
      const d = typeof p.rwd === 'number' ? p.rwd : 1;
      const f = frame(D, d, pos);
      const left = Math.max(30, D.L - f.s - 40);
      const b = Math.max(F.brake, (v * v) / (2 * left));
      v = Math.max(F.taxi, v - b); z = 0;
      const step = Math.min(v, Math.max(0, D.L - f.s - 5));
      fwd(step);
      if (v <= F.taxi) p.fp = 'taxi_in';
      break;
    }
    case 'taxi_in': {
      const stand = standOf(D, index);
      if (Math.hypot(stand.x - pos.x, stand.y - pos.y) > 0.5) hdg = bearing(pos, stand);
      const st = advance(pos, stand, F.taxi);
      pos = { x: st.x, y: st.y }; v = F.taxi; z = 0;
      if (st.reached) { done(); return; }
      break;
    }
    default: p.fp = z > 3 ? 'cruise' : 'taxi_out';
  }
  if (p.fp && !D && !['taxi_out', 'roll', 'climb', 'cruise', 'goaround', 'final'].includes(p.fp)) p.fp = 'cruise';
  p.v = r2(v); p.hdg = Math.round(hdg * 10) / 10;
  e.position = clampTo({ x: pos.x, y: pos.y, z }, s.size);
}

// --- keeping to the domain ---------------------------------------------------------------------------

// Before a step's rules: anything standing where it cannot be (a world from
// before the terrain rules: a car on the sea, a boat on land) is moved
// deterministically to the nearest shore of its own island (or the nearest
// water), one event each.
// Someone swimming (emergency.mjs: beach life, a rescue) is in the water on purpose.
export const inWaterOnPurpose = (e) => e.properties && e.properties.swimming === true;

export function correctDomains(ents, removed, mc, emit, S) {
  const T = mc.terrain;
  const index = new Map(ents.map((e) => [e.id, e]));
  for (const e of ents) {
    if (removed.has(e.id)) continue;
    const p = e.properties;
    if (typeof p.inside === 'string' && p.inside && index.has(p.inside)) continue;
    if ((e.position.z || 0) > 1) continue;
    if (isGroundKind(e.kind) && !T.isLand(e.position.x, e.position.y) && !inWaterOnPurpose(e)) {
      const own = typeof p.country === 'string' && p.country ? p.country : null;
      const to = (own && T.nearestLand(e.position.x, e.position.y, { island: own })) || T.nearestLand(e.position.x, e.position.y);
      if (!to) continue;
      const from = e.position;
      e.position = clampTo({ x: to.x, y: to.y, z: 0 }, S);
      clearProps(p, ROUTE_KEYS);
      emit('terrain_fix', `${nameOf(e)} (${e.id}) was standing on water at ${Math.round(from.x)}, ${Math.round(from.y)}; moved to the nearest shore${T.islandAt(to.x, to.y) && T.islandAt(to.x, to.y) !== 'main' ? ` of ${T.islandAt(to.x, to.y)}` : ''}`, e.id);
    } else if (isWaterKind(e.kind) && T.isLand(e.position.x, e.position.y)) {
      const to = T.nearestWater(e.position.x, e.position.y, { margin: 5 });
      if (!to) continue;
      const from = e.position;
      e.position = clampTo({ x: to.x, y: to.y, z: 0 }, S);
      emit('terrain_fix', `${nameOf(e)} (${e.id}) was on land at ${Math.round(from.x)}, ${Math.round(from.y)}; moved to the nearest water`, e.id);
    }
  }
}

// After a step's rules: whatever the rules did (wandering, attraction, a
// spawn), ground things stay on land and boats on water: back where they
// were, or to the nearest place they can be.
export function keepDomains(ents, removed, before, mc, S) {
  const T = mc.terrain;
  const index = new Map(ents.map((e) => [e.id, e]));
  for (const e of ents) {
    if (removed.has(e.id)) continue;
    const ground = isGroundKind(e.kind) && !inWaterOnPurpose(e); const water = !isGroundKind(e.kind) && isWaterKind(e.kind);
    if (!ground && !water) continue;
    if (typeof e.properties.inside === 'string' && e.properties.inside && index.has(e.properties.inside)) continue;
    if ((e.position.z || 0) > 1) continue;
    const ok = (pt) => (ground ? T.isLand(pt.x, pt.y) : !T.isLand(pt.x, pt.y));
    // A road vehicle the rules pushed off the road goes back where it was.
    if (ground && mc.roads && isRoadVehicle(catalogFor(e.kind), e.kind)) {
      const prev = before.get(e.id);
      const off = (pt) => offRoad(mc.roads, pt.x, pt.y, { paths: e.kind === 'bike' }) > 0.5;
      if (prev && (prev.x !== e.position.x || prev.y !== e.position.y) && off(e.position) && !off(prev)) { e.position = { ...prev }; continue; }
    }
    if (ok(e.position)) continue;
    const prev = before.get(e.id);
    if (prev && ok(prev)) { e.position = { ...prev }; continue; }
    const to = ground ? T.nearestLand(e.position.x, e.position.y, { island: typeof e.properties.country === 'string' && e.properties.country ? e.properties.country : null }) : T.nearestWater(e.position.x, e.position.y, { margin: 5 });
    if (to) e.position = clampTo({ x: to.x, y: to.y, z: 0 }, S);
  }
}
