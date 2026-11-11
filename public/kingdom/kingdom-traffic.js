// PG1 City: traffic that behaves. Decoration only (never counted, captioned
// or shown as an event), but it obeys the road: no vehicle ever drives
// through another, through a red light or into the river.
//
// Pure: no three.js, no DOM. The scene draws what step() leaves in
// `vehicles`, `boats` and `trams`; tests/kingdom-traffic.test.mjs runs it for
// long simulated stretches and checks every frame.
//
//   The network   the avenue grid of kingdom-world.js (GRID 160 m, roads
//                 16 m wide). Every road carries one lane each way; Dublin
//                 drives on the left, so a lane's centre is LANE_OFFSET to
//                 the left of its direction. Links run junction to junction.
//                 North-south avenues stop at the river: only the main
//                 bridge (x = 0) crosses, with ramps up to its deck, so no
//                 lane is ever over water.
//   Following     each lane keeps its vehicles in order. Acceleration is the
//                 intelligent driver model (a safe time gap, a minimum gap,
//                 comfortable braking), and a hard rule on top: a vehicle
//                 never moves closer than MIN_GAP to the one ahead.
//   Junctions     signals with phases per junction (east-west green, amber,
//                 all red, north-south green, amber, all red). A vehicle
//                 enters only on its own green, only when the junction holds
//                 no crossing traffic, and only when its exit lane has room
//                 for it (no blocking the box). Right turns cross the
//                 oncoming lane, so they yield to oncoming traffic.
//                 Vehicles queue at the stop line on red and clear on green.
//   Spawning      only at the edge of the network (off the main view), only
//                 into free space; a vehicle that reaches the edge leaves.
//   Boats         river lanes, one each way, ordered like the road lanes;
//                 they also keep clear of the boats real events bring
//                 (`external`), and never leave the water.
//   The tram      a fixed track on the viaduct, two lines in opposite
//                 directions; it slows into each station and dwells there.
//
// The vehicle-collision check is the sandbox's (public/sandbox/vehicle-
// path.js footprint and boxesOverlap): overlaps() is what the tests run.

import { footprint, boxesOverlap } from '../sandbox/vehicle-path.js';

export const GRID = 160;
export const ROAD_W = 16;
export const LANE_OFFSET = 3.2;
export const RIVER_Z = 120;
export const RIVER_HALF = 45;
export const BRIDGE_X = 0;
export const BRIDGE_DECK_Y = 10.15;
// The deck spans RIVER_Z +- 60; ramps climb to it over RAMP_LEN.
export const BRIDGE_DECK_HALF = 60;
export const RAMP_LEN = 40;
export const MIN_GAP = 2.2;
export const JUNCTION_HALF = ROAD_W / 2;
export const STOP_BACK = 6; // the stop line, this far before the junction box (behind the zebra)
export const ZEBRA_IN = 1; export const ZEBRA_W = 4; // a zebra from 1 to 5 m outside the box
// Per axis: green, amber, all red, then a pedestrian phase (every vehicle
// signal red, people cross on every zebra).
export const PHASES = Object.freeze({ green: 14, amber: 3, allRed: 2, ped: 12 });
export const CYCLE = 2 * (PHASES.green + PHASES.amber + PHASES.allRed + PHASES.ped);
export const VEHICLE_TYPES = Object.freeze({
  car: { len: 4.5, wid: 1.9, v0: 13.5 },
  taxi: { len: 4.6, wid: 1.9, v0: 13.5 },
  van: { len: 5.8, wid: 2.1, v0: 12 },
  bus: { len: 12, wid: 2.5, v0: 10.5 }
});
export const inRiver = (z) => Math.abs(z - RIVER_Z) < RIVER_HALF;

function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// The road surface height at (x, z): 0 on land, the bridge deck and its ramps
// on the main bridge. NaN where no road may go (over the water).
export function roadHeight(x, z) {
  const fromCentre = Math.abs(z - RIVER_Z);
  if (Math.abs(x - BRIDGE_X) <= ROAD_W / 2 + 0.01) {
    if (fromCentre <= BRIDGE_DECK_HALF) return BRIDGE_DECK_Y;
    if (fromCentre <= BRIDGE_DECK_HALF + RAMP_LEN) return BRIDGE_DECK_Y * (1 - (fromCentre - BRIDGE_DECK_HALF) / RAMP_LEN);
    return 0;
  }
  return inRiver(z) ? NaN : 0;
}

// --- the network ---------------------------------------------------------------------

// { xs: avenue x's, zs: street z's } of the simulated area; the bridge
// avenue is always included.
export function buildNetwork({ cols = 6, rowsNorth = 4, rowsSouth = 4 } = {}) {
  const xs = []; for (let i = -cols; i <= cols; i++) xs.push(i * GRID);
  const zs = []; for (let j = -rowsNorth; j <= rowsSouth + 1; j++) { const z = j * GRID - 40; if (!inRiver(z)) zs.push(z); }
  const junctions = [];
  const jAt = new Map();
  const key = (x, z) => `${x},${z}`;
  for (const x of xs) for (const z of zs) {
    const j = { id: junctions.length, x, z, edge: x === xs[0] || x === xs[xs.length - 1] || z === zs[0] || z === zs[zs.length - 1], in: [], out: [], occupants: [], offset: 0 };
    // A green wave of sorts: offsets along the grid.
    j.offset = ((Math.round(x / GRID) * 3 + Math.round((z + 40) / GRID) * 5) % CYCLE + CYCLE) % CYCLE;
    junctions.push(j); jAt.set(key(x, z), j);
  }
  const links = [];
  const addLink = (a, b) => {
    const dx = Math.sign(b.x - a.x); const dz = Math.sign(b.z - a.z);
    const axis = dx ? 'x' : 'z';
    // Left-hand traffic: the lane's centre is to the left of its direction.
    const lx = dz * LANE_OFFSET; const lz = -dx * LANE_OFFSET;
    const len = Math.abs(b.x - a.x) + Math.abs(b.z - a.z);
    const link = { id: links.length, from: a, to: b, dx, dz, axis, lx, lz, len, start: JUNCTION_HALF, end: len - JUNCTION_HALF, stopAt: len - JUNCTION_HALF - STOP_BACK, vehicles: [], reserved: 0, busStop: null };
    links.push(link); a.out.push(link); b.in.push(link);
  };
  for (const x of xs) for (let k = 0; k + 1 < zs.length; k++) {
    const z1 = zs[k]; const z2 = zs[k + 1];
    // Over the river only on the bridge.
    const crosses = z1 < RIVER_Z && z2 > RIVER_Z;
    if (crosses && x !== BRIDGE_X) continue;
    const a = jAt.get(key(x, z1)); const b = jAt.get(key(x, z2));
    addLink(a, b); addLink(b, a);
  }
  for (const z of zs) for (let k = 0; k + 1 < xs.length; k++) { const a = jAt.get(key(xs[k], z)); const b = jAt.get(key(xs[k + 1], z)); addLink(a, b); addLink(b, a); }
  return { xs, zs, junctions, links };
}

// Where on a link a position s is (the lane centre), and the heading.
export function linkPoint(link, s) {
  const x = link.from.x + link.dx * s + link.lx;
  const z = link.from.z + link.dz * s + link.lz;
  return { x, z, y: roadHeight(x, z), heading: Math.atan2(link.dx, link.dz) };
}

// The signal for an approach: 'go', 'wait' (amber) or 'stop'.
export function signalFor(junction, axis, t) {
  const p = ((t + junction.offset) % CYCLE + CYCLE) % CYCLE;
  const g = PHASES.green; const a = PHASES.amber; const r = PHASES.allRed; const half = g + a + r + PHASES.ped;
  const first = axis === 'x';
  const q = first ? p : (p + half) % CYCLE;
  return q < g ? 'go' : q < g + a ? 'wait' : 'stop';
}

// Is it the pedestrians' turn at this junction?
export function pedPhase(junction, t) {
  const p = ((t + junction.offset) % CYCLE + CYCLE) % CYCLE;
  const half = CYCLE / 2; const q = p % half;
  return q >= PHASES.green + PHASES.amber + PHASES.allRed && q < half - 1.5;
}

// The turn from link `inL` into link `outL`: 'straight', 'left', 'right'.
export function turnOf(inL, outL) {
  if (inL.dx === outL.dx && inL.dz === outL.dz) return 'straight';
  // Cross product of the headings (x, z) with y up: positive -> turning right
  // as seen from above in a right-handed frame where -z is ahead-left of +x.
  const cross = inL.dx * outL.dz - inL.dz * outL.dx;
  return cross > 0 ? 'right' : 'left';
}

// A path through the junction box from a's lane end to b's lane start: a
// quadratic curve via the corner, sampled at f in 0..1.
export function junctionPoint(inL, outL, f) {
  const p0 = linkPoint(inL, inL.end);
  const p2 = linkPoint(outL, outL.start);
  let cx; let cz;
  if (turnOf(inL, outL) === 'straight') { cx = (p0.x + p2.x) / 2; cz = (p0.z + p2.z) / 2; }
  else if (inL.dx) { cx = p2.x; cz = p0.z; } else { cx = p0.x; cz = p2.z; }
  const u = 1 - f;
  const x = u * u * p0.x + 2 * u * f * cx + f * f * p2.x;
  const z = u * u * p0.z + 2 * u * f * cz + f * f * p2.z;
  const tx = 2 * u * (cx - p0.x) + 2 * f * (p2.x - cx); const tz = 2 * u * (cz - p0.z) + 2 * f * (p2.z - cz);
  return { x, z, y: roadHeight(x, z) || 0, heading: Math.atan2(tx, tz) };
}
const pathLen = (inL, outL) => { let L = 0; let p = junctionPoint(inL, outL, 0); for (let i = 1; i <= 8; i++) { const q = junctionPoint(inL, outL, i / 8); L += Math.hypot(q.x - p.x, q.z - p.z); p = q; } return L; };

// --- following ------------------------------------------------------------------------

const A_MAX = 1.6; const B_COMF = 2.4; const T_GAP = 1.3; const S0 = 2.6;
function idm(v, v0, gap, dv) {
  const sStar = S0 + Math.max(0, v * T_GAP + (v * dv) / (2 * Math.sqrt(A_MAX * B_COMF)));
  return A_MAX * (1 - Math.pow(v / Math.max(0.1, v0), 4) - Math.pow(sStar / Math.max(0.1, gap), 2));
}

// --- the simulation ----------------------------------------------------------------------

// The zebra on one arm of a junction: a rectangle across the road, from the
// box edge outwards. arm: { dx, dz } pointing out of the junction.
export function zebraRect(j, arm) {
  const near = JUNCTION_HALF + ZEBRA_IN; const far = near + ZEBRA_W;
  if (arm.dx) { const x0 = j.x + arm.dx * near; const x1 = j.x + arm.dx * far; return { minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: j.z - ROAD_W / 2, maxZ: j.z + ROAD_W / 2, alongX: false }; }
  const z0 = j.z + arm.dz * near; const z1 = j.z + arm.dz * far; return { minX: j.x - ROAD_W / 2, maxX: j.x + ROAD_W / 2, minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1), alongX: true };
}
const ARMS = [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }];

export function createTraffic({ density = 1, seed = 11, cols = 6, rowsNorth = 4, rowsSouth = 4, busStops = true, boats = true, trams = true, tramZ = -200, pedestrians = 1 } = {}) {
  const r = rng(seed);
  const net = buildNetwork({ cols, rowsNorth, rowsSouth });
  const vehicles = [];
  let nextId = 1;
  let t = 0;
  const stats = { spawned: 0, despawned: 0, stoppedAtRed: 0, enteredOnRed: 0, entered: 0, refusedBlocked: 0 };
  const target = Math.round(net.links.length * 3.4 * density);

  // Bus stops: on some links, a third of the way along.
  if (busStops) for (const l of net.links) if (l.len > 100 && r() < 0.18) l.busStop = { s: Math.min(l.stopAt - 30, l.len * 0.45), people: 2 + Math.floor(r() * 5) };

  const pickType = () => { const k = r(); return k < 0.74 ? 'car' : k < 0.84 ? 'taxi' : k < 0.94 ? 'van' : 'bus'; };
  const tailOf = (v) => v.s - v.len;
  // Free space at the start of a link for a vehicle of length len.
  const roomAtStart = (link, len) => {
    const last = link.vehicles[link.vehicles.length - 1];
    const tail = last ? tailOf(last) : link.len;
    return tail - link.start - link.reserved >= len + MIN_GAP;
  };
  const place = (link, s, type) => {
    const spec = VEHICLE_TYPES[type];
    const v = { id: nextId++, type, len: spec.len, wid: spec.wid, v0: spec.v0 * (0.85 + r() * 0.3), link, s, v: spec.v0 * 0.6, next: null, inJ: null, x: 0, y: 0, z: 0, heading: 0, dwell: 0, servedStop: false, waitedRed: false };
    link.vehicles.push(v); link.vehicles.sort((a, b) => b.s - a.s);
    vehicles.push(v); return v;
  };
  // Seed the network: vehicles spread along links with room between them.
  for (const link of net.links) {
    let s = link.stopAt - r() * 20;
    while (s > link.start + 6) {
      if (vehicles.length >= target) break;
      if (r() < 0.45 * Math.min(1.5, density)) { const type = pickType(); const spec = VEHICLE_TYPES[type]; if (s - spec.len > link.start) { place(link, s, type); s -= spec.len + MIN_GAP + 6 + r() * 14; continue; } }
      s -= 12 + r() * 10;
    }
  }
  const entries = net.links.filter((l) => l.from.edge && !l.to.edge);

  function chooseNext(link, type) {
    // Buses keep to straight routes; nobody turns back the way they came.
    let opts = link.to.out.filter((o) => !(o.to === link.from));
    if (type === 'bus') { const st = opts.filter((o) => turnOf(link, o) === 'straight'); if (st.length) opts = st; }
    if (!opts.length) return null;
    const weights = opts.map((o) => (turnOf(link, o) === 'straight' ? 3 : 1));
    let k = r() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < opts.length; i++) { k -= weights[i]; if (k <= 0) return opts[i]; }
    return opts[opts.length - 1];
  }

  // May vehicle v (at the stop line of v.link, heading into v.next) enter now?
  function mayEnter(v) {
    const j = v.link.to;
    if (signalFor(j, v.link.axis, t) !== 'go') return false;
    // No crossing traffic in the box, and one vehicle per approach at a time.
    for (const o of j.occupants) {
      if (o.link === v.link) return false;
      if (o.link.axis !== v.link.axis) return false;
      const turnO = turnOf(o.link, o.next); const turnV = turnOf(v.link, v.next);
      if (turnO === 'right' || turnV === 'right') return false;
    }
    // A right turn yields to oncoming traffic close to the junction.
    if (turnOf(v.link, v.next) === 'right') {
      const opp = j.in.find((l) => l.dx === -v.link.dx && l.dz === -v.link.dz);
      if (opp) {
        const near = opp.vehicles[0];
        // Only traffic actually coming: a stopped oncoming car is waiting itself.
        if (near && near.v > 0.8 && opp.stopAt - near.s < 30 && turnOf(opp, near.next || opp) !== 'right') return false;
      }
    }
    // Nobody on the zebras it drives over (its own approach's and its exit's).
    if (zebraBusy(j, { dx: -v.link.dx, dz: -v.link.dz }) || zebraBusy(j, { dx: v.next.dx, dz: v.next.dz })) return false;
    // The exit lane must have room: no blocking the box.
    if (!roomAtStart(v.next, v.len)) {
      stats.refusedBlocked++;
      // Blocked for a while: take another exit that has room (a driver's
      // detour), so queues round a block never lock into a cycle.
      v.blocked = (v.blocked || 0) + 1;
      if (v.blocked > 40) {
        const alt = v.link.to.out.filter((o) => o !== v.next && o.to !== v.link.from && roomAtStart(o, v.len + 6) && (v.type !== 'bus' || turnOf(v.link, o) === 'straight'));
        if (alt.length) { v.next = alt[Math.floor(r() * alt.length)]; v.blocked = 0; stats.rerouted = (stats.rerouted || 0) + 1; }
      }
      return false;
    }
    v.blocked = 0;
    return true;
  }

  function stepVehicle(v, dt) {
    if (v.inJ) {
      // Through the junction at a steady pace: D is how far the front is
      // past the stop line; the body follows the lane, the curve, the exit.
      v.v = Math.max(v.v, 4);
      v.inJ.d += v.v * dt;
      if (v.inJ.d >= v.inJ.total) {
        const j = v.link.to;
        j.occupants = j.occupants.filter((o) => o !== v);
        v.next.reserved -= v.len + MIN_GAP;
        v.link = v.next; v.next = null; v.inJ = null; v.s = v.link.start + v.len; v.servedStop = false; v.waitedRed = false;
        v.link.vehicles.push(v); v.link.vehicles.sort((a, b) => b.s - a.s);
      }
      return;
    }
    const link = v.link;
    const idx = link.vehicles.indexOf(v);
    const ahead = idx > 0 ? link.vehicles[idx - 1] : null;
    if (!v.next && !link.to.edge) v.next = chooseNext(link, v.type);
    // The obstacle ahead: the next vehicle's tail, a red stop line, a bus stop.
    let gap = Infinity; let dv = 0;
    if (ahead) { gap = tailOf(ahead) - v.s; dv = v.v - ahead.v; }
    // A vehicle from this lane still crossing: its tail may be on the lane.
    else for (const o of link.to.occupants) if (o.link === link) { const tail = link.stopAt + o.inJ.d - o.len; if (tail - v.s < gap) { gap = tail - v.s; dv = v.v - o.v; } }
    const atEdge = link.to.edge;
    const lineGap = link.stopAt - v.s;
    if (!atEdge && idx === 0) {
      const sig = signalFor(link.to, link.axis, t);
      const canGo = sig === 'go' && v.next && (lineGap > 40 || mayEnter(v));
      if (!canGo && lineGap < gap) { gap = lineGap; dv = v.v; }
    }
    if (v.type === 'bus' && link.busStop && !v.servedStop) {
      const stopGap = link.busStop.s - v.s;
      // A stop point, not a vehicle: aim for it exactly (S0 is a following gap).
      if (stopGap > -0.5 && stopGap + S0 < gap) { gap = Math.max(0.01, stopGap + S0); dv = v.v; }
      if (stopGap <= 0.6 && stopGap > -2 && v.v < 0.4) { v.dwell += dt; v.v = 0; if (v.dwell > 9) { v.servedStop = true; v.dwell = 0; } return; }
    }
    const acc = idm(v.v, v.v0, Math.max(0.01, gap), dv);
    v.v = Math.max(0, Math.min(v.v0 * 1.05, v.v + acc * dt));
    let ns = v.s + v.v * dt;
    // The hard rule: never closer than MIN_GAP to the vehicle ahead.
    if (ahead) ns = Math.min(ns, tailOf(ahead) - MIN_GAP);
    else for (const o of link.to.occupants) if (o.link === link) ns = Math.min(ns, link.stopAt + o.inJ.d - o.len - MIN_GAP);
    // Never over a stop line it may not cross.
    if (!atEdge && idx === 0) {
      const sig = signalFor(link.to, link.axis, t);
      if (ns > link.stopAt && v.s <= link.stopAt) {
        if (sig === 'go' && v.next && mayEnter(v)) {
          const curve = pathLen(link, v.next);
          v.inJ = { d: 0, curve, total: STOP_BACK + curve + v.len, at: t };
          if (signalFor(link.to, link.axis, t) !== 'go') stats.enteredOnRed++;
          link.to.occupants.push(v); v.next.reserved += v.len + MIN_GAP;
          link.vehicles.splice(idx, 1);
          stats.entered++;
          return;
        }
        if (sig !== 'go' && !v.waitedRed) { stats.stoppedAtRed++; v.waitedRed = true; }
        ns = link.stopAt; v.v = 0;
      }
    }
    if (atEdge && ns >= link.end) { v.gone = true; return; }
    v.s = Math.max(v.s, ns);
  }

  // Where the body's centre is: on the lane, on the curve or on the exit.
  function pose(v) {
    let p;
    if (v.inJ) {
      const c = v.inJ.d - v.len / 2;
      if (c < STOP_BACK) p = linkPoint(v.link, v.link.stopAt + c);
      else if (c < STOP_BACK + v.inJ.curve) p = junctionPoint(v.link, v.next, (c - STOP_BACK) / v.inJ.curve);
      else p = linkPoint(v.next, v.next.start + (c - STOP_BACK - v.inJ.curve));
    } else p = linkPoint(v.link, v.s - v.len / 2);
    v.x = p.x; v.z = p.z; v.y = p.y; v.heading = p.heading;
  }

  // --- boats ---
  const boatList = [];
  const RIVER_LANES = [{ z: RIVER_Z - 8, dir: 1 }, { z: RIVER_Z + 8, dir: -1 }];
  const RIVER_END = 1400;
  if (boats) for (const lane of RIVER_LANES) { lane.boats = []; for (let i = 0; i < 4; i++) { const ferry = r() < 0.3; const b = { ferry, len: ferry ? 25 : 14.5, wid: ferry ? 7 : 4, v0: ferry ? 5 : 8.5, v: 4, x: -RIVER_END + i * 650 + r() * 200, z: lane.z, lane, heading: lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2 }; lane.boats.push(b); boatList.push(b); } lane.boats.sort((a, b) => (b.x - a.x) * lane.dir); }
  function stepBoats(dt, external = []) {
    for (const lane of RIVER_LANES) {
      if (!lane.boats) continue;
      lane.boats.sort((a, b) => (b.x - a.x) * lane.dir);
      lane.boats.forEach((b, i) => {
        const ahead = i > 0 ? lane.boats[i - 1] : null;
        let gap = ahead ? (ahead.x - b.x) * lane.dir - (ahead.len + b.len) / 2 : Infinity; let dv = ahead ? b.v - ahead.v : 0;
        // Boats from real events on the river: keep clear of any in the lane.
        for (const e of external) {
          if (Math.abs(e.z - lane.z) > (e.wid || 5) / 2 + b.wid / 2 + 1.5) continue;
          const d = (e.x - b.x) * lane.dir - ((e.len || 15) + b.len) / 2;
          if (d > -b.len && d < gap) { gap = Math.max(0.01, d); dv = b.v; }
        }
        const acc = idm(b.v, b.v0, Math.max(0.01, gap), dv);
        b.v = Math.max(0, Math.min(b.v0, b.v + acc * dt));
        let nx = b.x + b.v * lane.dir * dt;
        if (ahead) { const lim = ahead.x - lane.dir * ((ahead.len + b.len) / 2 + MIN_GAP * 2); nx = lane.dir > 0 ? Math.min(nx, lim) : Math.max(nx, lim); }
        b.x = nx;
      });
      // Off one end, back in at the other, only into free water.
      for (const b of lane.boats) {
        if (b.x * lane.dir > RIVER_END) {
          const startX = -lane.dir * RIVER_END;
          const last = lane.boats.reduce((m, o) => (o === b ? m : Math.min(m, (o.x - startX) * lane.dir - (o.len + b.len) / 2)), Infinity);
          if (last > MIN_GAP * 4) { b.x = startX; b.v = b.v0 * 0.6; } else b.v = 0;
        }
      }
    }
  }

  // --- the tram: two lines on the viaduct, stations ---
  const TRAM_LEN = 5 * 18.6; const TRAM_END = 1100;
  const stations = [-760, -400, -40, 320, 680];
  const tramList = trams ? [{ x: -TRAM_END + 100, dir: 1, z: tramZ - 2, v: 0, dwell: 0, served: null, len: TRAM_LEN }, { x: TRAM_END - 300, dir: -1, z: tramZ + 2, v: 0, dwell: 0, served: null, len: TRAM_LEN }] : [];
  function stepTrams(dt) {
    for (const tr of tramList) {
      if (tr.dwell > 0) { tr.dwell -= dt; tr.v = 0; continue; }
      const nextSt = stations.filter((s) => (s - tr.x) * tr.dir > 0.5 && s !== tr.served).sort((a, b) => (a - b) * tr.dir)[0];
      const endGap = TRAM_END - tr.x * tr.dir;
      let gap = Math.min(endGap, nextSt == null ? Infinity : (nextSt - tr.x) * tr.dir) + S0;
      const acc = idm(tr.v, 15, Math.max(0.01, gap), tr.v);
      tr.v = Math.max(0, Math.min(15, tr.v + acc * dt));
      tr.x += Math.min(tr.v * dt, Math.max(0, gap - S0)) * tr.dir;
      // At the platform (it has slowed right down on the way in): stop and dwell.
      if (nextSt != null && Math.abs(nextSt - tr.x) < 0.6 && tr.v < 3) { tr.served = nextSt; tr.dwell = 14; tr.x = nextSt; tr.v = 0; }
      if (TRAM_END - tr.x * tr.dir < 0.6 && tr.v < 3) { tr.dir *= -1; tr.served = null; tr.dwell = 20; tr.v = 0; }
    }
  }

  // --- people on the zebras ---
  const peds = [];
  const zebras = [];
  if (pedestrians > 0) for (const j of net.junctions) {
    if (j.edge) continue;
    for (const arm of ARMS) {
      if (!j.out.some((l) => l.dx === arm.dx && l.dz === arm.dz)) continue;
      const z = { j, arm, rect: zebraRect(j, arm), people: [] };
      zebras.push(z);
      const n = Math.round((1 + r() * 5) * pedestrians);
      for (let k = 0; k < n; k++) { const p = { zebra: z, side: r() < 0.5 ? -1 : 1, lat: r(), speed: 1.7 + r() * 0.4, u: 0, state: 'wait', rest: r() * 20, x: 0, z: 0, heading: 0, dog: r() < 0.08, umbrella: r() }; z.people.push(p); peds.push(p); }
    }
  }
  const zebraKey = (j, arm) => zebras.find((z) => z.j === j && z.arm.dx === arm.dx && z.arm.dz === arm.dz);
  function zebraBusy(j, arm) { const z = zebraKey(j, arm); return !!z && z.people.some((p) => p.state === 'cross'); }
  // Is any vehicle body on this zebra?
  function zebraHasVehicle(z) {
    const R = z.rect;
    for (const v of vehicles) { const hl = v.len / 2 + 0.5; if (v.x + hl < R.minX || v.x - hl > R.maxX || v.z + hl < R.minZ || v.z - hl > R.maxZ) continue; return true; }
    return false;
  }
  const CROSS = ROAD_W + 3; // kerb to kerb, a step onto each pavement
  function stepPeds(dt) {
    for (const z of zebras) {
      const ped = pedPhase(z.j, t);
      const remaining = (() => { const p = ((t + z.j.offset) % CYCLE + CYCLE) % CYCLE; const q = p % (CYCLE / 2); return CYCLE / 2 - 1.5 - q; })();
      // Only into an empty box and a clear zebra; vehicles then wait for them (mayEnter).
      const clear = ped && z.j.occupants.length === 0 && !zebraHasVehicle(z);
      for (const p of z.people) {
        if (p.state === 'wait') { p.rest -= dt; if (p.rest <= 0 && clear && remaining > 3) { p.state = 'cross'; p.u = 0; } }
        else if (p.state === 'cross') { p.u += p.speed * dt; if (p.u >= CROSS) { p.state = 'wait'; p.side = -p.side; p.rest = 15 + r() * 40; p.u = 0; } }
        const R = z.rect; const span = CROSS;
        const pos = p.state === 'cross' ? p.u : 0;
        const along = -p.side * (span / 2) + p.side * pos; // across the road
        const lateral = 0.6 + p.lat * (ZEBRA_W - 1.2);
        // People walk across the road: along x for a zebra on a north-south arm.
        if (z.arm.dz) { p.z = (z.arm.dz > 0 ? R.minZ : R.maxZ - ZEBRA_W) + lateral; p.x = z.j.x + along; p.heading = p.side > 0 ? Math.PI / 2 : -Math.PI / 2; }
        else { p.x = (z.arm.dx > 0 ? R.minX : R.maxX - ZEBRA_W) + lateral; p.z = z.j.z + along; p.heading = p.side > 0 ? 0 : Math.PI; }
        if (p.state === 'wait') { // waiting on the kerb, a little apart
          if (z.arm.dz) p.x = z.j.x - p.side * (span / 2 + 0.4 + p.lat * 1.2); else p.z = z.j.z - p.side * (span / 2 + 0.4 + p.lat * 1.2);
        }
      }
    }
  }

  function spawn() {
    if (vehicles.length >= target) return;
    for (let tries = 0; tries < 4 && vehicles.length < target; tries++) {
      const link = entries[Math.floor(r() * entries.length)];
      const type = pickType(); const len = VEHICLE_TYPES[type].len;
      if (roomAtStart(link, len + 4)) { const v = place(link, link.start + len, type); v.v = 6; stats.spawned++; }
    }
  }

  function step(dt, { external = [] } = {}) {
    const n = Math.max(1, Math.ceil(dt / 0.1)); const h = dt / n;
    for (let k = 0; k < n; k++) {
      t += h;
      // Lead vehicles first, so a follower sees where its leader is now.
      for (const link of net.links) for (const v of [...link.vehicles]) if (!v.inJ) stepVehicle(v, h);
      for (const v of vehicles) if (v.inJ) stepVehicle(v, h);
      for (let i = vehicles.length - 1; i >= 0; i--) {
        const v = vehicles[i];
        if (v.gone) { const l = v.link; l.vehicles.splice(l.vehicles.indexOf(v), 1); vehicles.splice(i, 1); stats.despawned++; }
      }
      spawn();
      stepBoats(h, external);
      stepTrams(h);
      stepPeds(h);
    }
    for (const v of vehicles) pose(v);
  }
  for (const v of vehicles) pose(v);
  stepPeds(0);

  // Every pair of vehicles whose bodies overlap (the sandbox's check, on
  // footprints a hair smaller than the body so touching is not a hit).
  function overlaps() {
    const cell = 24; const grid = new Map(); const hits = [];
    const fp = vehicles.map((v) => footprint(v.x, v.z, Math.sin(v.heading), Math.cos(v.heading), v.len - 0.05, v.wid - 0.05));
    vehicles.forEach((v, i) => { const k = `${Math.floor(v.x / cell)},${Math.floor(v.z / cell)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    vehicles.forEach((v, i) => {
      const cx = Math.floor(v.x / cell); const cz = Math.floor(v.z / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of grid.get(`${cx + a},${cz + b}`) || []) {
        if (j <= i || Math.abs(vehicles[j].y - v.y) > 3) continue;
        if (boxesOverlap(fp[i], fp[j])) hits.push([v.id, vehicles[j].id]);
      }
    });
    for (const lane of RIVER_LANES) if (lane.boats) for (let i = 0; i < lane.boats.length; i++) for (let j = i + 1; j < lane.boats.length; j++) { const a = lane.boats[i]; const b = lane.boats[j]; if (Math.abs(a.x - b.x) < (a.len + b.len) / 2 - 0.05) hits.push(['boat', 'boat']); }
    if (tramList.length === 2 && Math.abs(tramList[0].z - tramList[1].z) < 2.8) hits.push(['tram', 'tram']);
    return hits;
  }

  return {
    net, vehicles, boats: boatList, trams: tramList, stations, stats, target, peds, zebras,
    // People on a zebra inside a vehicle's body (the tests: never).
    pedHits() {
      const hits = [];
      for (const p of peds) { if (p.state !== 'cross') continue; for (const v of vehicles) { const fp = footprint(v.x, v.z, Math.sin(v.heading), Math.cos(v.heading), v.len, v.wid); if (boxesOverlap(fp, footprint(p.x, p.z, 1, 0, 0.5, 0.5))) hits.push(v.id); } }
      return hits;
    },
    get time() { return t; },
    step, overlaps,
    signal: (j, axis) => signalFor(j, axis, t),
    // The junction with the most vehicles waiting at it right now (for the camera).
    busiest() {
      let best = null; let n = -1;
      for (const j of net.junctions) { if (j.edge) continue; const q = j.in.reduce((k, l) => k + this.queueAt(l), 0); if (q > n) { n = q; best = j; } }
      return best ? { x: best.x, z: best.z, queued: n } : null;
    },
    queueAt(link) { let n = 0; for (const v of link.vehicles) if (v.v < 0.5 && link.stopAt - v.s < 60) n++; return n; }
  };
}
