// PG1 SANDBOX ROADS: a world's road network as data, and the way things
// find their way along it.
//
// A world spec may carry roads (validateSpec keeps them):
//   roads: { nodes: [[x, y], ...], edges: [[a, b, width, name], ...], names: [...] }
// a, b are node indexes; width in metres; name an index into names (-1:
// none). An edge narrower than FOOTPATH_WIDTH is a footpath (people and
// bikes only); a road or driveway takes vehicles too.
// Road entities (kind road: a straight strip, position its middle, with
// length, width and heading) join the network as well, so the streets a
// society builds are driven on once finished (built >= 100).
//
//   roadGraph(spec, entities, terrain)  the network as a graph, cached per
//                                       world and rebuilt only when the
//                                       roads change
//   nextHop(graph, mode, from, goal)    the next node on the shortest way
//                                       (A*, cached), for mode car | walk
//   planRoads(entities, terrain, opts)  a connected network for a world:
//                                       a ring road per island, its town's
//                                       streets, and a road or driveway to
//                                       every house, harbour, airport,
//                                       school, hospital, factory and pad,
//                                       kept clear of every building
//
// Pure and deterministic: the same roads give the same graph and the same
// routes every time.

import { catalogFor } from './catalog.mjs';

export const FOOTPATH_WIDTH = 3.5;
export const ROAD_LIMITS = Object.freeze({ nodes: 4000, edges: 6000, names: 300, nameLength: 60 });
const r1 = (v) => Math.round(v * 10) / 10;

// --- validation ---------------------------------------------------------------------------------

export function cleanRoads(raw, size) {
  const bad = (m) => { const e = new Error(m); e.code = 'invalid_world'; e.name = 'WorldError'; throw e; };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('roads must be an object { nodes, edges, names }');
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : bad('roads.nodes must be a list of [x, y]');
  const edges = Array.isArray(raw.edges) ? raw.edges : bad('roads.edges must be a list of [a, b, width, name]');
  const names = raw.names === undefined ? [] : Array.isArray(raw.names) ? raw.names : bad('roads.names must be a list of names');
  if (nodes.length > ROAD_LIMITS.nodes) bad(`roads can have at most ${ROAD_LIMITS.nodes} nodes`);
  if (edges.length > ROAD_LIMITS.edges) bad(`roads can have at most ${ROAD_LIMITS.edges} edges`);
  if (names.length > ROAD_LIMITS.names) bad(`roads can have at most ${ROAD_LIMITS.names} names`);
  const fin = (v, lo, hi, what) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : bad(`${what} must be a number between ${lo} and ${hi}`));
  const outN = nodes.map((n, i) => { if (!Array.isArray(n) || n.length !== 2) bad(`roads.nodes[${i}] must be [x, y]`); return [r1(fin(n[0], 0, size.x, `roads.nodes[${i}][0]`)), r1(fin(n[1], 0, size.y, `roads.nodes[${i}][1]`))]; });
  const outE = edges.map((e, i) => {
    if (!Array.isArray(e) || e.length < 3 || e.length > 4) bad(`roads.edges[${i}] must be [a, b, width, name]`);
    const a = fin(e[0], 0, outN.length - 1, `roads.edges[${i}][0]`); const b = fin(e[1], 0, outN.length - 1, `roads.edges[${i}][1]`);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) bad(`roads.edges[${i}] must join two different nodes`);
    const w = r1(fin(e[2], 1, 60, `roads.edges[${i}][2]`));
    const n = e.length > 3 ? fin(e[3], -1, names.length - 1, `roads.edges[${i}][3]`) : -1;
    if (!Number.isInteger(n)) bad(`roads.edges[${i}][3] must be a name index`);
    return [a, b, w, n];
  });
  const outNames = names.map((s, i) => (typeof s === 'string' && s.length <= ROAD_LIMITS.nameLength ? s : bad(`roads.names[${i}] must be text of at most ${ROAD_LIMITS.nameLength} characters`)));
  return { nodes: outN, edges: outE, names: outNames };
}

// --- geometry -----------------------------------------------------------------------------------

function segPoint(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay; const L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return { t, x: ax + dx * t, y: ay + dy * t, d: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) };
}
function crossing(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax; const ry = by - ay; const sx = dx - cx; const sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return { t, u, x: ax + rx * t, y: ay + ry * t };
}
// A road strip entity as a segment.
export function stripOf(e) {
  const p = e.properties || {};
  const L = typeof p.length === 'number' && p.length > 0 ? p.length : 100;
  const h = ((typeof p.heading === 'number' ? p.heading : 0) * Math.PI) / 180;
  const c = Math.cos(h) * (L / 2); const s = Math.sin(h) * (L / 2);
  return { ax: e.position.x - c, ay: e.position.y - s, bx: e.position.x + c, by: e.position.y + s, w: typeof p.width === 'number' && p.width > 0 ? p.width : 12, name: typeof p.name === 'string' ? p.name.slice(0, ROAD_LIMITS.nameLength) : null };
}

// --- a planar network under construction ------------------------------------------------------

class Net {
  constructor(size) { this.size = size; this.xs = []; this.ys = []; this.edges = []; this.names = []; this.nameIx = new Map(); this.cell = 60; this.grid = new Map(); }
  key(x, y) { return `${Math.floor(x / this.cell)}|${Math.floor(y / this.cell)}`; }
  nameOf(n) { if (!n) return -1; if (!this.nameIx.has(n)) { this.nameIx.set(n, this.names.length); this.names.push(n); } return this.nameIx.get(n); }
  node(x, y, tol = 2) {
    x = Math.min(this.size.x, Math.max(0, r1(x))); y = Math.min(this.size.y, Math.max(0, r1(y)));
    const cx = Math.floor(x / this.cell); const cy = Math.floor(y / this.cell);
    let best = -1; let bd = tol;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const k of this.grid.get(`${cx + i}|${cy + j}`) || []) { const d = Math.hypot(this.xs[k] - x, this.ys[k] - y); if (d <= bd) { bd = d; best = k; } }
    if (best >= 0) return best;
    const k = this.xs.length; this.xs.push(x); this.ys.push(y);
    const g = this.key(x, y); if (!this.grid.has(g)) this.grid.set(g, []); this.grid.get(g).push(k);
    return k;
  }
  has(a, b) { return this.edges.some((e) => e && ((e[0] === a && e[1] === b) || (e[0] === b && e[1] === a))); }
  // Adds a -> b, split where it crosses other edges (a junction each time)
  // and where it ends on one (a T-junction).
  add(ax, ay, bx, by, w, name) {
    const n = this.nameOf(name);
    const cuts = [{ t: 0, k: this.node(ax, ay) }, { t: 1, k: this.node(bx, by) }];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1) return;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i]; if (!e) continue;
      const [p, q] = e;
      const x = crossing(ax, ay, bx, by, this.xs[p], this.ys[p], this.xs[q], this.ys[q]);
      if (x) { const k = this.node(x.x, x.y); this.split(i, k); cuts.push({ t: x.t, k }); }
    }
    // Ends that land on an edge's middle join it.
    for (const c of [cuts[0], cuts[1]]) {
      for (let i = 0; i < this.edges.length; i++) {
        const e = this.edges[i]; if (!e || e[0] === c.k || e[1] === c.k) continue;
        const sp = segPoint(this.xs[c.k], this.ys[c.k], this.xs[e[0]], this.ys[e[0]], this.xs[e[1]], this.ys[e[1]]);
        if (sp.d < 1.5 && sp.t > 0.01 && sp.t < 0.99) { this.split(i, c.k); break; }
      }
    }
    cuts.sort((p, q) => p.t - q.t || p.k - q.k);
    for (let i = 1; i < cuts.length; i++) { const a = cuts[i - 1].k; const b = cuts[i].k; if (a !== b && !this.has(a, b)) this.edges.push([a, b, w, n]); }
  }
  split(i, k) {
    const e = this.edges[i]; if (!e || e[0] === k || e[1] === k) return;
    this.edges[i] = null;
    if (!this.has(e[0], k)) this.edges.push([e[0], k, e[2], e[3]]);
    if (!this.has(k, e[1])) this.edges.push([k, e[1], e[2], e[3]]);
  }
  // The nearest point on any edge (vehicles: roads only), or null.
  nearestOnEdge(x, y, { roadsOnly = false, ok = null } = {}) {
    let best = null;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i]; if (!e) continue;
      if (roadsOnly && e[2] < FOOTPATH_WIDTH) continue;
      const sp = segPoint(x, y, this.xs[e[0]], this.ys[e[0]], this.xs[e[1]], this.ys[e[1]]);
      if ((!best || sp.d < best.d) && (!ok || ok(sp))) best = { ...sp, i };
    }
    return best;
  }
  // The data: unused nodes dropped, numbered in order.
  data() {
    const live = this.edges.filter(Boolean);
    const used = new Map();
    const nodes = [];
    for (const e of live) for (const k of [e[0], e[1]]) if (!used.has(k)) { used.set(k, nodes.length); nodes.push([this.xs[k], this.ys[k]]); }
    const usedNames = new Map(); const names = [];
    const edges = live.map((e) => { let n = -1; if (e[3] >= 0) { if (!usedNames.has(e[3])) { usedNames.set(e[3], names.length); names.push(this.names[e[3]]); } n = usedNames.get(e[3]); } return [used.get(e[0]), used.get(e[1]), e[2], n]; });
    return { nodes, edges, names };
  }
}

// --- the graph things travel on ------------------------------------------------------------------

const GRAPHS = new Map(); // signature -> graph (a few worlds at a time)
function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); }

const SPEC_SIG = new WeakMap(); // a spec's roads object -> its hash (worked out once)
const ROAD = catalogFor('road');
export function roadSignature(spec, entities) {
  const r = spec && spec.roads;
  let rs = 'none';
  if (r) { rs = SPEC_SIG.get(r); if (!rs) { rs = `${r.nodes.length}/${r.edges.length}/${fnv(JSON.stringify(r))}`; SPEC_SIG.set(r, rs); } }
  let strips = '';
  for (const e of entities || []) if (catalogFor(e.kind) === ROAD && !(typeof e.properties.built === 'number' && e.properties.built < 100)) strips += `${e.id}:${e.position.x},${e.position.y},${e.properties.length},${e.properties.heading},${e.properties.width};`;
  return `${rs}|${fnv(strips)}`;
}

// The network as a graph: nodes (xs, ys, which land mass), adjacency (car
// and walk), a grid for "the nearest node", and the A* route cache.
export function roadGraph(spec, entities, terrain) {
  const sig = roadSignature(spec, entities);
  if (GRAPHS.has(sig)) { const g = GRAPHS.get(sig); GRAPHS.delete(sig); GRAPHS.set(sig, g); return g; }
  const size = spec.size;
  const net = new Net(size);
  const r = spec.roads;
  if (r) {
    // The spec's network is planar already: load it as it is.
    for (const [x, y] of r.nodes) { const k = net.xs.length; net.xs.push(x); net.ys.push(y); const g = net.key(x, y); if (!net.grid.has(g)) net.grid.set(g, []); net.grid.get(g).push(k); }
    for (const nm of r.names) net.nameOf(nm);
    for (const e of r.edges) net.edges.push([e[0], e[1], e[2], e[3]]);
  }
  // Road strips (the old straight streets, and those a society builds).
  const strips = (entities || []).filter((e) => catalogFor(e.kind) === catalogFor('road') && !(typeof e.properties.built === 'number' && e.properties.built < 100)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const covered = (x, y) => { const sp = net.nearestOnEdge(x, y); return sp && sp.d < 1; };
  for (const e of strips) {
    const s = stripOf(e);
    // A strip the spec's network already holds (a template's streets) is not added twice.
    if (r && covered(s.ax, s.ay) && covered(s.bx, s.by) && covered((s.ax + s.bx) / 2, (s.ay + s.by) / 2)) continue;
    net.add(s.ax, s.ay, s.bx, s.by, s.w, s.name);
    // Each end joins the nearest road within 300 m on the same land.
    for (const [x, y] of [[s.ax, s.ay], [s.bx, s.by]]) {
      const k = net.node(x, y);
      const deg = net.edges.filter((ed) => ed && (ed[0] === k || ed[1] === k)).length;
      if (deg > 1) continue;
      const near = net.nearestOnEdge(x, y, { roadsOnly: true, ok: (sp) => sp.d > 1 && sp.d < 300 });
      if (near && (!terrain || terrain.clearLine({ x, y }, near, false))) net.add(x, y, near.x, near.y, Math.min(10, s.w), null);
    }
  }
  const data = net.data();
  const n = data.nodes.length;
  const xs = new Float64Array(n); const ys = new Float64Array(n);
  data.nodes.forEach(([x, y], i) => { xs[i] = x; ys[i] = y; });
  const adjCar = Array.from({ length: n }, () => []); const adjWalk = Array.from({ length: n }, () => []);
  const edges = data.edges.map(([a, b, w, nm]) => ({ a, b, w, name: nm >= 0 ? data.names[nm] : null, len: Math.hypot(xs[b] - xs[a], ys[b] - ys[a]) }));
  edges.forEach((e, i) => {
    adjWalk[e.a].push({ to: e.b, cost: e.len, e: i }); adjWalk[e.b].push({ to: e.a, cost: e.len, e: i });
    if (e.w >= FOOTPATH_WIDTH) { const c = e.len * (e.w >= 9 ? 1 : e.w >= 6 ? 1.15 : 1.6); adjCar[e.a].push({ to: e.b, cost: c, e: i }); adjCar[e.b].push({ to: e.a, cost: c, e: i }); }
  });
  for (const list of [...adjCar, ...adjWalk]) list.sort((p, q) => p.to - q.to);
  const mass = Array.from({ length: n }, (_, i) => (terrain ? terrain.islandAt(xs[i], ys[i]) : 'main'));
  const cell = 80; const grid = new Map();
  for (let i = 0; i < n; i++) { const k = `${Math.floor(xs[i] / cell)}|${Math.floor(ys[i] / cell)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
  // Edges by cell too, for "is this point on a road".
  const egrid = new Map();
  edges.forEach((e, i) => {
    const x0 = Math.floor((Math.min(xs[e.a], xs[e.b]) - e.w) / cell); const x1 = Math.floor((Math.max(xs[e.a], xs[e.b]) + e.w) / cell);
    const y0 = Math.floor((Math.min(ys[e.a], ys[e.b]) - e.w) / cell); const y1 = Math.floor((Math.max(ys[e.a], ys[e.b]) + e.w) / cell);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) { const k = `${cx}|${cy}`; if (!egrid.has(k)) egrid.set(k, []); egrid.get(k).push(i); }
  });
  const g = { sig, n, xs, ys, edges, adj: { car: adjCar, walk: adjWalk }, mass, cell, grid, egrid, hops: { car: new Map(), walk: new Map() } };
  GRAPHS.set(sig, g);
  while (GRAPHS.size > 6) GRAPHS.delete(GRAPHS.keys().next().value);
  return g;
}

// The nearest node a mode can use, on the given land mass (or any), or -1.
export function nearestNode(g, x, y, { mode = 'car', mass = undefined, maxR = 3000 } = {}) {
  if (!g || !g.n) return -1;
  const cx = Math.floor(x / g.cell); const cy = Math.floor(y / g.cell);
  let best = -1; let bd = Infinity;
  for (let ring = 0; ring * g.cell <= maxR + g.cell; ring++) {
    for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
      for (const k of g.grid.get(`${cx + i}|${cy + j}`) || []) {
        if (!g.adj[mode][k].length) continue;
        if (mass !== undefined && g.mass[k] !== mass) continue;
        const d = Math.hypot(g.xs[k] - x, g.ys[k] - y);
        if (d < bd || (d === bd && k < best)) { bd = d; best = k; }
      }
    }
    if (best >= 0 && bd <= ring * g.cell) break;
  }
  return bd <= maxR ? best : -1;
}

// How far a point is from the nearest road (its edge, not its middle):
// <= 0 on the road. Footpaths count only with paths.
export function offRoad(g, x, y, { paths = false } = {}) {
  if (!g || !g.n) return Infinity;
  let best = Infinity;
  for (const i of g.egrid.get(`${Math.floor(x / g.cell)}|${Math.floor(y / g.cell)}`) || []) {
    const e = g.edges[i];
    if (!paths && e.w < FOOTPATH_WIDTH) continue;
    const sp = segPoint(x, y, g.xs[e.a], g.ys[e.a], g.xs[e.b], g.ys[e.b]);
    best = Math.min(best, sp.d - e.w / 2);
  }
  return best;
}
export const onRoad = (g, x, y, opts) => offRoad(g, x, y, opts) <= 0.5;

// The next node from `from` toward `goal` (A* with a straight-line
// estimate), or -1 when there is no way. Every node on a route found is
// cached, so a trip runs A* once.
export function nextHop(g, mode, from, goal) {
  if (from === goal) return goal;
  const cache = g.hops[mode];
  const key = from * 65536 + goal;
  if (cache.has(key)) return cache.get(key);
  const adj = g.adj[mode];
  const n = g.n;
  const gs = new Float64Array(n).fill(Infinity); const prev = new Int32Array(n).fill(-1); const closed = new Uint8Array(n);
  const h = (k) => Math.hypot(g.xs[k] - g.xs[goal], g.ys[k] - g.ys[goal]);
  // A binary heap of [f, node]; ties by node, so the route is the same every time.
  const heap = [];
  const less = (p, q) => p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]);
  const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const pi = (i - 1) >> 1; if (!less(heap[i], heap[pi])) break; [heap[i], heap[pi]] = [heap[pi], heap[i]]; i = pi; } };
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
  gs[from] = 0; push([h(from), from]);
  let found = false;
  while (heap.length) {
    const [, u] = pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (u === goal) { found = true; break; }
    for (const { to, cost } of adj[u]) {
      const ng = gs[u] + cost;
      if (ng < gs[to]) { gs[to] = ng; prev[to] = u; push([ng + h(to), to]); }
    }
  }
  if (cache.size > 200000) cache.clear();
  if (!found) { cache.set(key, -1); return -1; }
  const path = [goal];
  while (path[path.length - 1] !== from) path.push(prev[path[path.length - 1]]);
  path.reverse();
  for (let i = 0; i < path.length - 1; i++) cache.set(path[i] * 65536 + goal, path[i + 1]);
  return path[1];
}

// --- planning a network ---------------------------------------------------------------------------

// What roads keep clear of: buildings and the larger structures, as
// circles (runways as their rectangle, with a margin).
const KEEP_CLEAR = new Set(['port', 'beach', 'amusement', 'monument', 'fountain', 'launch_pad', 'stadium']);
export function obstaclesOf(entities) {
  const out = [];
  for (const e of entities || []) {
    const c = catalogFor(e.kind);
    const base = String(e.kind).replace(/[_-][a-z0-9]+$/, '');
    if (c.class === 'building' || KEEP_CLEAR.has(e.kind) || KEEP_CLEAR.has(base)) out.push({ id: e.id, x: e.position.x, y: e.position.y, r: Math.max(8, (c.footprint || 8) * 0.8 + 3) });
    if (c === catalogFor('runway')) {
      const p = e.properties || {};
      const L = typeof p.length === 'number' ? p.length : 800; const W = typeof p.width === 'number' ? p.width : 30;
      out.push({ id: e.id, x: e.position.x, y: e.position.y, rect: { L: L + 60, W: W + 40, h: ((typeof p.heading === 'number' ? p.heading : 0) * Math.PI) / 180 } });
    }
  }
  return out;
}
function hitsObstacle(ax, ay, bx, by, obstacles, halfW, except = null) {
  for (const o of obstacles) {
    if (except && except.has(o.id)) continue;
    if (o.rect) {
      // Sample the segment against the rectangle.
      const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 8));
      const c = Math.cos(o.rect.h); const s = Math.sin(o.rect.h);
      for (let i = 0; i <= n; i++) {
        const x = ax + ((bx - ax) * i) / n - o.x; const y = ay + ((by - ay) * i) / n - o.y;
        const u = x * c + y * s; const v = -x * s + y * c;
        if (Math.abs(u) < o.rect.L / 2 + halfW && Math.abs(v) < o.rect.W / 2 + halfW) return o;
      }
      continue;
    }
    if (segPoint(o.x, o.y, ax, ay, bx, by).d < o.r + halfW) return o;
  }
  return null;
}

// The door of a place: on the side facing (x, y), at its footprint.
function doorOf(e, toward) {
  const c = catalogFor(e.kind);
  const fp = Math.max(4, c.footprint || 6);
  const dx = toward.x - e.position.x; const dy = toward.y - e.position.y; const d = Math.hypot(dx, dy) || 1;
  return { x: e.position.x + (dx / d) * fp, y: e.position.y + (dy / d) * fp };
}

// Which places get a way in, the most important first.
const SPUR_NAME = { port: 'Harbour Road', terminal: 'Airport Road', launch_pad: 'Launch Pad Road', school: 'School Lane', hospital: 'Hospital Road', factory: 'Works Road', barn: 'Farm Lane', station: 'Station Approach', stadium: 'Stadium Way', hotel: 'Hotel Drive', beach: 'Beach Road', barracks: 'Barracks Road', hangar: 'Hangar Road', prison: 'Prison Road', police_station: 'Police Road' };
const PRIORITY = ['port', 'terminal', 'launch_pad', 'school', 'hospital', 'factory', 'station', 'barn', 'stadium', 'hotel', 'tower', 'apartment', 'shop', 'cafe', 'cinema', 'theatre', 'bar', 'barracks', 'hangar', 'police_station', 'prison', 'house', 'cabin', 'beach', 'fountain', 'amusement', 'monument', 'crop', 'bridge'];
const FOOT_ONLY = new Set(['beach', 'fountain', 'monument', 'crop', 'bridge']);
const baseKind = (k) => (PRIORITY.includes(k) ? k : String(k).replace(/[_-][a-z0-9]+$/, ''));

// A connected network for a world. opts: { size, streets: [{ points:
// [[x, y], ...], width, name }], ringFor(island) -> { radius } | null,
// keep: existing road strips to build on }. Returns the roads data.
export function planRoads(entities, terrain, { size, streets = [], ring = true, townRing = null } = {}) {
  const net = new Net(size);
  const obstacles = obstaclesOf(entities);
  const inside = (x, y, m = 30) => x >= m && y >= m && x <= size.x - m && y <= size.y - m;
  const landOk = (x, y, m = 8) => terrain.coastDistance(x, y) >= m;
  const clear = (ax, ay, bx, by, halfW, except) => terrain.clearLine({ x: ax, y: ay }, { x: bx, y: by }, false, { every: 8, margin: 6 }) && !hitsObstacle(ax, ay, bx, by, obstacles, halfW, except);
  // A way from a to b: straight when clear, else round the building in the
  // way (up to three times); null when water is in the way.
  const route = (ax, ay, bx, by, w, except, depth = 0) => {
    if (clear(ax, ay, bx, by, w / 2, except)) return [[ax, ay], [bx, by]];
    if (depth > 2) return null;
    const o = hitsObstacle(ax, ay, bx, by, obstacles, w / 2, except);
    if (!o) return null;
    // A point beside the obstacle, on the side the line passes.
    const sp = segPoint(o.x, o.y, ax, ay, bx, by);
    let nx = sp.x - o.x; let ny = sp.y - o.y; let nd = Math.hypot(nx, ny);
    if (nd < 0.01) { nx = -(by - ay); ny = bx - ax; nd = Math.hypot(nx, ny) || 1; }
    const rad = (o.rect ? Math.hypot(o.rect.L, o.rect.W) / 2 : o.r) + w / 2 + 6;
    for (const sgn of [1, -1]) {
      const vx = o.x + (nx / nd) * rad * sgn; const vy = o.y + (ny / nd) * rad * sgn;
      if (!inside(vx, vy, 10) || !landOk(vx, vy, 4)) continue;
      const p1 = route(ax, ay, vx, vy, w, except, depth + 1);
      const p2 = p1 && route(vx, vy, bx, by, w, except, depth + 1);
      if (p1 && p2) return [...p1, ...p2.slice(1)];
    }
    return null;
  };
  const addClear = (ax, ay, bx, by, w, name, except = null) => {
    const pts = route(ax, ay, bx, by, w, except);
    if (!pts) return false;
    for (let i = 1; i < pts.length; i++) net.add(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], w, name);
    return true;
  };

  // 1. Designed streets (a template's), and the strips already there.
  for (const s of streets) {
    for (let i = 1; i < s.points.length; i++) net.add(s.points[i - 1][0], s.points[i - 1][1], s.points[i][0], s.points[i][1], s.width || 10, s.name || null);
  }
  // 2. A ring road round each island (or round the town, without islands).
  const islands = (entities || []).filter((e) => e.kind === 'island');
  const rings = [];
  if (ring) {
    for (const isl of islands) {
      const R = typeof isl.properties.radius === 'number' ? isl.properties.radius : 500;
      // Each point on land and inside the world: pulled in where the coast or the edge is near.
      const cx = isl.position.x; const cy = isl.position.y;
      const pts = circle(cx, cy, R - Math.max(110, R * 0.13)).map(([x, y]) => {
        const a = Math.atan2(y - cy, x - cx); let rr = Math.hypot(x - cx, y - cy);
        while (rr > R * 0.45 && (!inside(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 40) || !landOk(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 40))) rr -= 20;
        return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
      });
      rings.push({ name: `${isl.properties.name || isl.id} Ring Road`, pts });
    }
    if (!islands.length && townRing) rings.push({ name: townRing.name || 'Ring Road', pts: townRing.points });
  }
  for (const rg of rings) {
    const pts = rg.pts.map(([x, y]) => [Math.min(size.x - 40, Math.max(40, x)), Math.min(size.y - 40, Math.max(40, y))]).map(([x, y]) => nudgeClear(x, y, obstacles, landOk, 9));
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]; const b = pts[(i + 1) % pts.length];
      if (!a || !b) continue;
      addClear(a[0], a[1], b[0], b[1], 12, rg.name);
    }
  }
  // 3. Trunk roads: from each town's own streets straight to its harbour,
  // airport, launch pad, school, hospital and works, where the way is clear.
  const seedNodes = new Set();
  for (const ed of net.edges) if (ed) { seedNodes.add(ed[0]); seedNodes.add(ed[1]); }
  const TRUNK = ['port', 'terminal', 'launch_pad', 'school', 'hospital', 'factory', 'barn', 'station', 'stadium'];
  const hubs = (entities || []).filter((e) => TRUNK.includes(baseKind(e.kind)) && terrain.isLand(e.position.x, e.position.y)).sort((a, b) => TRUNK.indexOf(baseKind(a.kind)) - TRUNK.indexOf(baseKind(b.kind)) || (a.id < b.id ? -1 : 1));
  for (const e of hubs) {
    const mass = terrain.islandAt(e.position.x, e.position.y);
    let best = -1; let bd = Infinity;
    for (const k of seedNodes) { if (terrain.islandAt(net.xs[k], net.ys[k]) !== mass) continue; const d = Math.hypot(net.xs[k] - e.position.x, net.ys[k] - e.position.y); if (d < bd || (d === bd && k < best)) { bd = d; best = k; } }
    if (best < 0 || bd < 250 || bd > 3000) continue;
    const door = doorOf(e, { x: net.xs[best], y: net.ys[best] });
    const k = baseKind(e.kind);
    addClear(net.xs[best], net.ys[best], door.x, door.y, 10, SPUR_NAME[k] ? `${placeName(e)}${SPUR_NAME[k]}` : null, new Set([e.id]));
  }
  // 4. A way in to every place, most important first: a road when it is far
  // from the network, a driveway (or, for a park or a beach, a footpath).
  const places = (entities || []).filter((e) => PRIORITY.includes(baseKind(e.kind)) && !(typeof e.properties.built === 'number' && e.properties.built < 100) && terrain.isLand(e.position.x, e.position.y));
  places.sort((a, b) => PRIORITY.indexOf(baseKind(a.kind)) - PRIORITY.indexOf(baseKind(b.kind)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const massOf = (x, y) => terrain.islandAt(x, y);
  for (const e of places) {
    const k = baseKind(e.kind);
    const foot = FOOT_ONLY.has(k);
    const mass = massOf(e.position.x, e.position.y);
    const except = new Set([e.id]);
    // The nearest point on the network, on the same land, that a straight way reaches.
    const tryFrom = (from) => {
      const cands = [];
      for (let i = 0; i < net.edges.length; i++) {
        const ed = net.edges[i]; if (!ed) continue;
        if (!foot && ed[2] < FOOTPATH_WIDTH) continue;
        const sp = segPoint(from.x, from.y, net.xs[ed[0]], net.ys[ed[0]], net.xs[ed[1]], net.ys[ed[1]]);
        cands.push({ ...sp, i });
      }
      cands.sort((p, q) => p.d - q.d || p.i - q.i);
      return cands.slice(0, 8).filter((c) => massOf(c.x, c.y) === mass);
    };
    const door0 = (() => { const near = tryFrom(e.position)[0]; return doorOf(e, near || { x: e.position.x + 1, y: e.position.y }); })();
    let done = false;
    for (const c of tryFrom(door0)) {
      const far = c.d > 220;
      const w = foot ? 2.5 : far ? 9 : k === 'house' || k === 'cabin' ? 4 : 6;
      const name = far || SPUR_NAME[k] ? (SPUR_NAME[k] ? `${placeName(e)}${SPUR_NAME[k]}` : null) : null;
      if (c.d < 1) { done = true; break; }
      if (addClear(door0.x, door0.y, c.x, c.y, w, name, except)) { done = true; break; }
    }
    if (!done) {
      // Otherwise toward the nearest node, round what is in the way.
      const near = tryFrom(door0)[0];
      if (near) addClear(door0.x, door0.y, near.x, near.y, foot ? 2.5 : 6, null, except);
    }
  }
  // 5. One network per island: join the pieces to the largest.
  joinPieces(net, terrain, addClear);
  return net.data();
}

function placeName(e) {
  const n = e.properties && typeof e.properties.name === 'string' ? e.properties.name : '';
  const first = n.replace(/\b(?:Harbour|Airport|Hotel|School|Hospital|Arena|Stadium)\b.*$/, '').trim();
  return first ? `${first} ` : '';
}
function circle(cx, cy, r) {
  const n = Math.max(16, Math.ceil((2 * Math.PI * r) / 160));
  return Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; });
}
// A ring point moved off a building (out, then in), or null.
function nudgeClear(x, y, obstacles, landOk, halfW) {
  const bad = (px, py) => obstacles.some((o) => (o.rect ? Math.hypot(px - o.x, py - o.y) < Math.hypot(o.rect.L, o.rect.W) / 2 + halfW : Math.hypot(px - o.x, py - o.y) < o.r + halfW)) || !landOk(px, py, 10);
  if (!bad(x, y)) return [x, y];
  for (let d = 8; d <= 120; d += 8) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) if (!bad(x + dx, y + dy)) return [x + dx, y + dy];
  return null;
}
function joinPieces(net, terrain, addClear) {
  for (let round = 0; round < 40; round++) {
    // Joined for vehicles: footpaths do not count.
    const live = net.edges.filter((e) => e && e[2] >= FOOTPATH_WIDTH);
    const parent = new Map();
    const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    for (const e of live) for (const k of [e[0], e[1]]) if (!parent.has(k)) parent.set(k, k);
    for (const e of live) { const a = find(e[0]); const b = find(e[1]); if (a !== b) parent.set(Math.max(a, b), Math.min(a, b)); }
    // Pieces by land mass.
    const pieces = new Map();
    for (const k of parent.keys()) { const root = find(k); const m = terrain.islandAt(net.xs[k], net.ys[k]); const key = `${m}`; if (!pieces.has(key)) pieces.set(key, new Map()); const pm = pieces.get(key); if (!pm.has(root)) pm.set(root, []); pm.get(root).push(k); }
    let joined = false;
    for (const pm of pieces.values()) {
      if (pm.size < 2) continue;
      const list = [...pm.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
      const main = list[0];
      for (const piece of list.slice(1)) {
        // The closest points (a node of the piece, a point on the main
        // network's roads), then a clear road between them.
        const inMain = new Set(main);
        const pairs = [];
        for (const a of piece) {
          for (let i = 0; i < net.edges.length; i++) {
            const ed = net.edges[i];
            if (!ed || ed[2] < FOOTPATH_WIDTH || !inMain.has(ed[0])) continue;
            const sp = segPoint(net.xs[a], net.ys[a], net.xs[ed[0]], net.ys[ed[0]], net.xs[ed[1]], net.ys[ed[1]]);
            pairs.push([sp.d, a, sp.x, sp.y]);
          }
        }
        pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3]);
        for (const [d, a, bx, by] of pairs.slice(0, 80)) { if (d > 1500) break; if (addClear(net.xs[a], net.ys[a], bx, by, 8, null)) { joined = true; break; } }
        if (joined) break;
      }
      if (joined) break;
    }
    if (!joined) return;
  }
}
