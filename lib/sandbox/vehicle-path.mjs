// PG1 SANDBOX VEHICLE PATHS: where a vehicle is during a step, the one
// source of truth for the engine (lib/sandbox/watchdog.mjs vehicleSpace
// keeps every vehicle's whole way clear of every other) and the viewer
// (public/sandbox/sandbox-scene.js draws it there): public/sandbox/vehicle-path.js
// is a byte-for-byte copy made by scripts/build-sandbox-terrain.mjs, and
// tests/sandbox-play.test.mjs checks the two are the same.
//
// A vehicle's way through a step is a polyline: where it was, the corners it
// turned on the road (the engine's `wp` property, "x,y;x,y"), where it ended.
// It moves along it at an even pace: at time t (0..1 of the step) it is at
// t of the way's length, facing along the segment it is on. No curve that
// could cut into another lane or past another vehicle.
//
// Bodies: [length, width] in metres by kind (a car 4.5 by 1.9, a bus 11 by
// 2.5, a ferry 40 by 10). Pure functions, no imports.

export const VEHICLE_BODIES = Object.freeze({
  car: [4.5, 1.9], taxi: [4.5, 1.9], police_car: [4.8, 1.9], ambulance: [6, 2.2], fire_truck: [9, 2.5],
  bus: [11, 2.5], truck: [11, 2.5], army_truck: [8, 2.5], tractor: [4, 2.2], bike: [1.8, 0.6], motorbike: [2.1, 0.8],
  canoe: [7, 0.9], kayak: [4, 0.7], boat: [9, 3], patrol_boat: [9, 3], jet_ski: [3, 1.2], sailboat: [9, 3], yacht: [14, 4.5],
  ferry: [40, 10], ship: [36, 9], carrack: [36, 9]
});
export const DEFAULT_BODY = Object.freeze([3, 1.5]);
// The times within a step the viewer's way is checked at (the engine checks
// at least these, more for fast vehicles).
export const VEHICLE_SAMPLES = 10;

export function bodyFor(baseKind) {
  return VEHICLE_BODIES[baseKind] || DEFAULT_BODY;
}

// "x,y;x,y" -> [{ x, y }] (at most 6 corners; anything unreadable is left out).
export function parseWaypoints(wp) {
  if (typeof wp !== 'string' || !wp) return [];
  const out = [];
  for (const part of wp.split(';').slice(0, 6)) {
    const [x, y] = part.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
  }
  return out;
}
export function formatWaypoints(points) {
  const r = (n) => Math.round(n * 100) / 100;
  return (points || []).slice(-6).map((p) => `${r(p.x)},${r(p.y)}`).join(';');
}

// The way: from, the corners, to (no zero-length pieces).
export function wayPoints(from, to, wp = []) {
  const pts = [{ x: from.x, y: from.y }];
  for (const p of [...wp, to]) { const q = pts[pts.length - 1]; if (Math.hypot(p.x - q.x, p.y - q.y) > 1e-6) pts.push({ x: p.x, y: p.y }); }
  if (pts.length === 1) pts.push({ x: to.x, y: to.y });
  return pts;
}

export function wayLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

// Where along the way at fraction f (0..1 of its length), and which way it
// faces there: { x, y, hx, hy } (hx, hy a unit vector, or 0, 0 for a way of
// no length). out is filled in and returned when given.
export function pointOnWay(pts, f, out = {}) {
  const L = wayLength(pts);
  let s = Math.max(0, Math.min(1, f)) * L;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]; const b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < 1e-9) continue;
    if (s <= d || i === pts.length - 1) {
      const k = Math.min(1, s / d);
      out.x = a.x + (b.x - a.x) * k; out.y = a.y + (b.y - a.y) * k; out.hx = (b.x - a.x) / d; out.hy = (b.y - a.y) / d;
      return out;
    }
    s -= d;
  }
  out.x = pts[pts.length - 1].x; out.y = pts[pts.length - 1].y; out.hx = 0; out.hy = 0;
  return out;
}

// The corners within the first fraction f of the way (a vehicle that
// covers only part of it this step).
export function cutWay(pts, f) {
  const L = wayLength(pts);
  const s = Math.max(0, Math.min(1, f)) * L;
  const out = [pts[0]];
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (run + d >= s - 1e-9) { const end = pointOnWay(pts, f); out.push({ x: end.x, y: end.y }); return out; }
    run += d; out.push(pts[i]);
  }
  return out;
}

// A body as an oriented box: centre, heading (unit vector), half extents.
export function footprint(x, y, hx, hy, length, width) {
  return { x, y, ux: hx, uy: hy, hl: length / 2, hw: width / 2 };
}

// Whether two boxes overlap (separating axes; touching is not overlapping).
export function boxesOverlap(a, b) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  if (Math.hypot(dx, dy) >= Math.hypot(a.hl, a.hw) + Math.hypot(b.hl, b.hw)) return false;
  for (const [ax, ay] of [[a.ux, a.uy], [-a.uy, a.ux], [b.ux, b.uy], [-b.uy, b.ux]]) {
    const ra = a.hl * Math.abs(a.ux * ax + a.uy * ay) + a.hw * Math.abs(-a.uy * ax + a.ux * ay);
    const rb = b.hl * Math.abs(b.ux * ax + b.uy * ay) + b.hw * Math.abs(-b.uy * ax + b.ux * ay);
    if (Math.abs(dx * ax + dy * ay) >= ra + rb - 1e-9) return false;
  }
  return true;
}
