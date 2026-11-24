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

export function aheadFloor(obstacles, a, vx, vz, o = {}) {
  let y = flightFloor(obstacles, a.x, a.z, o);
  if (!Number.isFinite(vx) || !Number.isFinite(vz) || Math.hypot(vx, vz) < 0.5) return y;
  for (const s of LOOK_AHEAD_S) y = Math.max(y, flightFloor(obstacles, a.x + vx * s, a.z + vz * s, o));
  return y;
}

// One step of the rule for a flying agent: never below the floor here
// (hard), and climbing early towards the floor ahead (eased, so no pop).
export function keepClear(obstacles, a, dt, o = {}) {
  const vx = a.lx === undefined ? 0 : (a.x - a.lx) / Math.max(dt, 1e-3);
  const vz = a.lz === undefined ? 0 : (a.z - a.lz) / Math.max(dt, 1e-3);
  const here = flightFloor(obstacles, a.x, a.z, o);
  const ahead = aheadFloor(obstacles, a, vx, vz, o);
  if (a.y < ahead) a.y = Math.min(ahead, a.y + CLIMB_RATE * dt);
  if (a.y < here) a.y = here;
  a.lx = a.x; a.lz = a.z;
  return a.y;
}

export function insideBox(boxes, x, y, z, pad = 0) {
  for (const b of boxes) {
    if (x > b.min[0] - pad && x < b.max[0] + pad && y > b.min[1] - pad && y < b.max[1] + pad && z > b.min[2] - pad && z < b.max[2] + pad) return b;
  }
  return null;
}
