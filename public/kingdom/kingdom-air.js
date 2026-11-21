// PG1 City: what flies over it. Decoration only (never counted or
// captioned, never in the enemy red: navigation lights are white, green and
// amber). Pure: no three.js; the scene draws `aircraft`.
//
//   airliners    high on approach to and from the airport, 900 to 1,500 m,
//                on wide circuits, with contrails by day
//   light planes lower, about 550 to 650 m
//   helicopters  cruise at 300 to 380 m, well above the PG1 Tower (240 m)
//                and every other roof, along the river and round the city
//   the shuttle  one helicopter that hops between rooftop helipads: it lifts
//                vertically to its cruise height, flies across, and settles
//                vertically onto the next pad
//
// Every aircraft keeps its own altitude band (at least SEPARATION metres
// from any other band), so no two can ever meet; tests/kingdom-air.test.mjs
// checks it over long runs.

export const SEPARATION = 50;
export const TOWER_CLEAR = 60; // metres above the tower top for anything cruising
export const AIR_KINDS = Object.freeze(['airliner', 'light', 'helicopter', 'shuttle']);

function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

export function createAirTraffic({ pads = [], towerTop = 240, seed = 5, scale = 1 } = {}) {
  const r = rng(seed);
  const aircraft = [];
  const cruiseFloor = towerTop + TOWER_CLEAR;
  // Altitude bands, each SEPARATION + apart.
  const bands = { airliner: [900, 1080, 1260, 1440], light: [560, 640], helicopter: [cruiseFloor + 60, cruiseFloor + 120], shuttle: cruiseFloor };
  // The shuttle cruises in the lowest band, so its climbs and descents never cross anyone else's.
  const nAir = Math.max(1, Math.round(4 * Math.min(1, scale + 0.2)));
  for (let i = 0; i < nAir; i++) aircraft.push({ kind: 'airliner', alt: bands.airliner[i], a: r() * Math.PI * 2, rad: 1800 + i * 450, speed: (70 + r() * 15) / (1800 + i * 450), dir: i % 2 ? 1 : -1, len: 38, contrail: true });
  for (let i = 0; i < (scale < 0.5 ? 1 : 2); i++) aircraft.push({ kind: 'light', alt: bands.light[i], a: r() * Math.PI * 2, rad: 1100 + i * 300, speed: 45 / (1100 + i * 300), dir: i % 2 ? -1 : 1, len: 9 });
  // Cruising helicopters: an ellipse over the river and the centre, each its own band.
  for (let i = 0; i < (scale < 0.5 ? 1 : 2); i++) aircraft.push({ kind: 'helicopter', alt: bands.helicopter[i], a: r() * Math.PI * 2, rx: 700 - i * 150, rz: 260 + i * 80, cz: 120, speed: 32 / (600 - i * 150), dir: i % 2 ? 1 : -1, len: 14, rotor: 0 });
  // The pad shuttle (needs two pads).
  const usable = pads.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (usable.length >= 2) aircraft.push({ kind: 'shuttle', alt: bands.shuttle, pads: usable.slice(0, 6), from: 0, to: 1, state: 'parked', wait: 8 + r() * 10, x: usable[0].x, y: usable[0].y, z: usable[0].z, len: 12, rotor: 0, heading: 0 });

  let t = 0;
  // A cruising helicopter near (x, z): the shuttle never climbs or descends through its band while one is close.
  const heliNear = (x, z, R = 160) => aircraft.some((o) => o.kind === 'helicopter' && Math.hypot(o.x - x, o.z - z) < R);
  function step(dt) {
    t += dt;
    for (const c of aircraft) {
      c.rotor = (c.rotor || 0) + dt * (c.kind === 'helicopter' || (c.kind === 'shuttle' && c.state !== 'parked') ? 38 : c.kind === 'shuttle' ? 4 : 0);
      if (c.kind === 'airliner' || c.kind === 'light') {
        c.a += c.speed * c.dir * dt;
        c.x = Math.cos(c.a) * c.rad; c.z = Math.sin(c.a) * c.rad; c.y = c.alt + Math.sin(c.a * 2) * 12;
        c.heading = Math.atan2(-Math.sin(c.a) * c.dir, Math.cos(c.a) * c.dir); c.roll = c.dir * 0.18; c.pitch = 0;
      } else if (c.kind === 'helicopter') {
        c.a += c.speed * c.dir * dt;
        c.x = Math.cos(c.a) * c.rx; c.z = c.cz + Math.sin(c.a) * c.rz; c.y = c.alt + 3 + Math.sin(t * 0.4 + c.rx) * 3;
        const tx = -Math.sin(c.a) * c.rx * c.dir; const tz = Math.cos(c.a) * c.rz * c.dir;
        c.heading = Math.atan2(tx, tz); c.pitch = 0.12; c.roll = c.dir * 0.08;
      } else if (c.kind === 'shuttle') {
        const A = c.pads[c.from]; const B = c.pads[c.to];
        const V = 6; const H = 28;
        if (c.state === 'parked') { c.x = A.x; c.y = A.y; c.z = A.z; c.pitch = 0; c.roll = 0; c.wait -= dt; if (c.wait <= 0 && !heliNear(A.x, A.z)) c.state = 'climb'; }
        else if (c.state === 'climb') { if (!heliNear(A.x, A.z, 120)) c.y = Math.min(c.alt, c.y + V * dt); c.x = A.x; c.z = A.z; c.heading = Math.atan2(B.x - A.x, B.z - A.z); if (c.y >= c.alt) c.state = 'cruise'; }
        else if (c.state === 'cruise') {
          const dx = B.x - c.x; const dz = B.z - c.z; const d = Math.hypot(dx, dz);
          if (d < H * dt + 0.5) { c.x = B.x; c.z = B.z; if (!heliNear(B.x, B.z)) c.state = 'descend'; } else { c.x += dx / d * H * dt; c.z += dz / d * H * dt; }
          c.y = c.alt; c.pitch = 0.14;
        } else if (c.state === 'descend') { c.pitch = 0; if (!heliNear(B.x, B.z, 120)) c.y = Math.max(B.y, c.y - V * dt); if (c.y <= B.y) { c.state = 'parked'; c.wait = 14 + r() * 16; c.from = c.to; c.to = (c.to + 1 + Math.floor(r() * (c.pads.length - 1))) % c.pads.length; if (c.to === c.from) c.to = (c.from + 1) % c.pads.length; } }
      }
    }
  }
  step(0);
  return {
    aircraft, bands,
    get time() { return t; },
    step,
    // The smallest distance between any two aircraft right now (tests).
    minSeparation() {
      let m = Infinity;
      for (let i = 0; i < aircraft.length; i++) for (let j = i + 1; j < aircraft.length; j++) { const a = aircraft[i]; const b = aircraft[j]; m = Math.min(m, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)); }
      return m;
    }
  };
}
