// PG1 City: nothing that flies goes through a building. Pure (no three.js),
// shared by the live City and the Showcase render (the same actors), and
// tested on its own (tests/kingdom-flight.test.mjs) and against the drawn
// city (tests/browser/kingdom-flight.browser.test.mjs).
//
//   footprint(w, d, ry, shape)         a building's axis-aligned half extents
//                                      (exact for a box turned by ry)
//   flightFloor(obstacles, x, z, o)    the lowest height a drone may fly at
//                                      over (x, z): the highest roof within
//                                      its radius plus the clearance; 0 over
//                                      open ground
//   ringAltitude(obstacles, ring, alt) a patrol ring's height, raised over
//                                      every roof the whole ring passes
//   aheadFloor(obstacles, a, vx, vz)   the floor along the next few seconds
//                                      of a straight flight (climbs start
//                                      before a building, never at its wall)
//   keepClear(obstacles, a, dt) / unlift(a)
//                                      the lift over roofs, eased both ways
//   flyTowards(a, target, speed, dt)   a smooth flight step (no stutter,
//                                      no heading snaps)
//   insideBox(boxes, x, y, z, pad)     the box a point is inside, or null

// A drone's half span (the scale-5.2 quad with its rotors) plus a gap, and
// the height kept over a roof (above the bob and the nav lights).
export const DRONE_RADIUS = 9;
export const DRONE_CLEARANCE = 12;
// Climb rate (m/s) towards a building ahead, and how far ahead (s) it looks.
export const CLIMB_RATE = 45;
export const LOOK_AHEAD_S = [0.5, 1, 1.5, 2, 3, 4];

export function footprint(w, d, ry = 0, shape = 'box') {
  // A twisted tower turns through its height: its widest reach is the diagonal.
  if (shape === 'twist') { const r = Math.hypot(w, d) / 2; return { hw: r, hd: r }; }
  const c = Math.abs(Math.cos(ry)); const s = Math.abs(Math.sin(ry));
  return { hw: (c * w + s * d) / 2, hd: (s * w + c * d) / 2 };
}

export function flightFloor(obstacles, x, z, { radius = DRONE_RADIUS, clearance = DRONE_CLEARANCE } = {}) {
  if (!obstacles || !obstacles.topAt) return 0;
  const top = obstacles.topAt(x, z, radius);
  return top > 0 ? top + clearance : 0;
}

export function ringAltitude(obstacles, ring, alt, { samples = 720, ...o } = {}) {
  let y = alt;
  for (let k = 0; k < samples; k++) {
    const a = (k / samples) * Math.PI * 2;
    y = Math.max(y, flightFloor(obstacles, Math.sin(a) * ring, -Math.cos(a) * ring, o));
  }
  return y;
}

// Sampled every AHEAD_STEP metres along the next LOOK_AHEAD_S[last] seconds
// (closer than a drone's width, 2 x DRONE_RADIUS, so no building falls
// between two samples: a sparse look-ahead made the floor ahead flicker and
// the drone climb in steps), at most AHEAD_MAX samples.
export const AHEAD_STEP = 12;
export const AHEAD_MAX = 24;
export function aheadFloor(obstacles, a, vx, vz, o = {}) {
  let y = flightFloor(obstacles, a.x, a.z, o);
  const v = Math.hypot(vx, vz);
  if (!Number.isFinite(v) || v < 0.5) return y;
  const reach = v * LOOK_AHEAD_S[LOOK_AHEAD_S.length - 1];
  const n = Math.min(AHEAD_MAX, Math.max(1, Math.ceil(reach / AHEAD_STEP)));
  for (let k = 1; k <= n; k++) { const s = (reach * k) / n / v; y = Math.max(y, flightFloor(obstacles, a.x + vx * s, a.z + vz * s, o)); }
  return y;
}

// One step of the rule for a flying agent. a.y is the height its own flight
// gives it this frame; the lift above that is kept on a.lift, so the flight
// and the rule never pull against each other (27 Nov: the flight pulled a
// drone back down at 60 m/s each frame while the rule lifted it, so it popped
// up over a roof and dropped after it). The lift eases up early towards the
// floor ahead (at most CLIMB_RATE), eases back down after (at most
// DESCENT_RATE), and is never below the floor here (hard). Call unlift(a)
// before the next frame's flight step.
export const DESCENT_RATE = 9;
export const LIFT_EASE = 2.5;
export const LIFT_ACCEL = 60;
export function keepClear(obstacles, a, dt, o = {}) {
  const vx = a.lx === undefined ? 0 : (a.x - a.lx) / Math.max(dt, 1e-3);
  const vz = a.lz === undefined ? 0 : (a.z - a.lz) / Math.max(dt, 1e-3);
  const base = a.y;
  const hard = Math.max(0, flightFloor(obstacles, a.x, a.z, o) - base);
  const need = Math.max(0, aheadFloor(obstacles, a, vx, vz, o) - base);
  let lift = a.lift || 0;
  // The climb speed it wants (eased towards the need, within the rates),
  // reached at most LIFT_ACCEL m/s² so a climb or a descent starts and ends softly.
  const want = Math.max(-DESCENT_RATE, Math.min(CLIMB_RATE, (need - lift) * LIFT_EASE));
  const v0 = a.liftV || 0; const dv = LIFT_ACCEL * dt;
  let v = v0 + Math.max(-dv, Math.min(dv, want - v0));
  lift += v * dt;
  if (lift <= 0) { lift = 0; v = Math.max(0, v); }
  if (lift < hard) { lift = hard; v = Math.max(v, 0); }
  a.lift = lift; a.liftV = v; a.y = base + lift;
  a.lx = a.x; a.lz = a.z;
  return a.y;
}
// Back to the agent's own flight height (before its next flight step).
export function unlift(a) { if (a.lift) { a.y -= a.lift; } }

// A flight step towards a target at `speed` m/s: continuous (no dead zone, so
// a slow patrol glides instead of stepping), and turning smoothly towards the
// way it moves (at most TURN_RATE rad/s, eased), not snapping.
export const TURN_RATE = 2.4;
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
export function flyTowards(a, t, speed, dt) {
  const dx = t.x - a.x; const dy = t.y - a.y; const dz = t.z - a.z; const d = Math.hypot(dx, dy, dz);
  if (d > 1e-4 && dt > 0) {
    const k = Math.min(1, (speed * dt) / d);
    a.x += dx * k; a.y += dy * k; a.z += dz * k;
    const h = Math.hypot(dx, dz) * k / dt;
    if (h > 0.5) {
      const turn = wrap(Math.atan2(dx, dz) - (a.heading || 0));
      const lim = TURN_RATE * dt;
      a.heading = wrap((a.heading || 0) + Math.max(-lim, Math.min(lim, turn * Math.min(1, dt * 6))));
    }
  }
  return d;
}

export function insideBox(boxes, x, y, z, pad = 0) {
  for (const b of boxes) {
    if (x > b.min[0] - pad && x < b.max[0] + pad && y > b.min[1] - pad && y < b.max[1] + pad && z > b.min[2] - pad && z < b.max[2] + pad) return b;
  }
  return null;
}
