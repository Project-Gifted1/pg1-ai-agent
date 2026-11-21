// PG1 Showcase: the shots and their scripted camera paths, for the offline
// render (scripts/showcase-render.mjs). Pure: no browser, no three.js, so
// the paths are tested on their own (tests/showcase.test.mjs).
//
// A pose is the viewer's own camera terms (public/sandbox/controls.js):
//   { target: [x, y, z], dist, theta, phi, fov, focus }
// the camera at target + dist * (sin phi cos theta, cos phi, sin phi sin theta),
// looking at target; focus is the distance kept sharp (depth of field), or
// null for none (deep space: nothing is out of focus at infinity).
//
// A plan is a few keyed poses over the shot (t from 0 to 1), eased so every
// move starts and ends at rest (smootherstep), with distances blended in
// log space so a descent from orbit to the ground slows as it nears it.
//
//   SHOTS                    the five shots, in cut order
//   planShot(id, ctx)        a shot's plan from what the scene holds (ctx)
//   poseAt(plan, t)          the pose at t (0..1)
//   cameraPosition(pose)     where that puts the camera (world metres)
//   frameCount(seconds, fps) frames in a shot

export const SHOWCASE_FPS = 30;

// Each 4 to 6 seconds. scene: 'city' (PG1 City, public/kingdom/) or
// 'sandbox' (the Sandbox viewer, public/sandbox/). world: which world the
// viewer shows ('first-universe' is view only: never stepped, reset or
// changed). light / weather: how the shot is lit.
export const SHOTS = Object.freeze([
  Object.freeze({ id: 'city-night', title: 'PG1 City at night', scene: 'city', seconds: 5, light: 'night', weather: { state: 'clear', cloud: 0.1 }, move: 'dolly and crane up along the river, drones overhead, lamp pools on the quays, the beacons lit by real events' }),
  Object.freeze({ id: 'city-rain', title: 'PG1 City in Dublin rain', scene: 'city', seconds: 4, light: 'night-rain', weather: { state: 'rain', cloud: 1 }, move: 'low over the busiest junction, looking up the wet street to the tower: traffic in its lanes, reflections' }),
  Object.freeze({ id: 'first-universe', title: 'PG1 Universe: from space to the ground', scene: 'sandbox', world: 'first-universe', seconds: 5, move: 'descent from orbit down to a town square, turning as it falls' }),
  Object.freeze({ id: 'benin-warri', title: 'Benin–Warri c. 1610 at dawn', scene: 'sandbox', world: 'benin-warri', seconds: 4, weather: { state: 'mist', fog: 0.45, cloud: 0.35, dark: 0.12 }, move: 'from a canoe on the river, a crane up and push towards the walls of Benin, in dawn mist' }),
  Object.freeze({ id: 'deep-space', title: 'A planet and its star', scene: 'sandbox', world: 'space', seconds: 4, move: 'slow orbit and push-in on a planet, its star beyond' })
]);

export const shotById = (id) => SHOTS.find((s) => s.id === id) || null;
export const frameCount = (seconds, fps = SHOWCASE_FPS) => Math.max(1, Math.round(seconds * fps));

// Starts and ends at rest.
export function smootherstep(t) { const x = Math.max(0, Math.min(1, t)); return x * x * x * (x * (x * 6 - 15) + 10); }
const lerp = (a, b, t) => a + (b - a) * t;
const logLerp = (a, b, t) => Math.exp(lerp(Math.log(Math.max(1e-6, a)), Math.log(Math.max(1e-6, b)), t));

export function cameraPosition(p) {
  const s = Math.sin(p.phi);
  return [p.target[0] + s * Math.cos(p.theta) * p.dist, p.target[1] + Math.cos(p.phi) * p.dist, p.target[2] + s * Math.sin(p.theta) * p.dist];
}

// The pose at t (0..1): between the two keys either side, eased over the
// whole shot (one smooth move, never a stop at a middle key).
export function poseAt(plan, t) {
  const keys = plan.keys;
  const u = smootherstep(t);
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1].t) i++;
  const a = keys[i]; const b = keys[i + 1] || a;
  const k = b.t > a.t ? Math.max(0, Math.min(1, (u - a.t) / (b.t - a.t))) : 0;
  const A = a.pose; const B = b.pose;
  const dist = logLerp(A.dist, B.dist, k);
  // Focus keeps its proportion to the distance (the hero stays sharp as the camera moves).
  const focus = A.focus === null || B.focus === null ? null : dist * lerp((A.focus ?? A.dist) / A.dist, (B.focus ?? B.dist) / B.dist, k);
  return {
    target: [0, 1, 2].map((j) => lerp(A.target[j], B.target[j], k)),
    dist,
    theta: lerp(A.theta, B.theta, k),
    phi: lerp(A.phi, B.phi, k),
    fov: lerp(A.fov || 45, B.fov || 45, k),
    focus
  };
}

const key = (t, pose) => ({ t, pose });

// A shot's plan from what the scene holds. ctx (all optional, scene metres):
//   city:  { heroBearing, junction: { x, z } }
//   first-universe: { spaceAlt, ground: [x, y, z] }   (a town square)
//   benin-warri: { canoe: [x, y, z], walls: [x, y, z] }
//   deep-space: { planet: [x, y, z], planetSize, star: [x, y, z] }
export function planShot(id, ctx = {}) {
  const shot = shotById(id);
  if (!shot) throw new Error(`unknown shot ${id}`);
  const base = { id, seconds: shot.seconds, frames: frameCount(shot.seconds) };
  if (id === 'city-night') {
    // Low over the river from the east, rising a little as it pushes in on the tower.
    const th = ctx.heroBearing ?? 0.16;
    return { ...base, keys: [
      key(0, { target: [0, 110, 60], dist: 980, theta: th + 0.05, phi: 1.47, fov: 40, focus: 980 }),
      key(1, { target: [0, 150, 0], dist: 600, theta: th - 0.04, phi: 1.36, fov: 36, focus: 600 })
    ] };
  }
  if (id === 'city-rain') {
    // Over the river in the rain, from the south-east: the quays' traffic in
    // its lanes, the lit tower and its reflection on the wet water, an orbit
    // that drifts in.
    const th = (ctx.heroBearing ?? 0.16) + 0.5;
    return { ...base, keys: [
      key(0, { target: [0, 95, 80], dist: 520, theta: th + 0.12, phi: 1.43, fov: 42, focus: 520 }),
      key(1, { target: [0, 120, 40], dist: 400, theta: th - 0.1, phi: 1.4, fov: 40, focus: 400 })
    ] };
  }
  if (id === 'first-universe') {
    // From orbit, looking straight down, to the ground at a town square.
    const alt = ctx.spaceAlt || 2000; const g = ctx.ground || [0, 0, 0];
    return { ...base, keys: [
      key(0, { target: [g[0], g[1], g[2]], dist: alt * 2.6, theta: 0.4, phi: 0.12, fov: 50, focus: null }),
      key(0.6, { target: [g[0], g[1] + 4, g[2]], dist: 420, theta: 0.95, phi: 0.85, fov: 46, focus: 420 }),
      key(1, { target: [g[0], g[1] + 6, g[2]], dist: 70, theta: 1.25, phi: 1.3, fov: 42, focus: 70 })
    ] };
  }
  if (id === 'benin-warri') {
    // From a canoe on the river at dawn, a crane up and push in over the
    // water to the walls of Benin (the earthwork and its gate), in light mist.
    const c = ctx.canoe || [0, 0, 0]; const w = ctx.walls || [c[0] + 670, 0, c[2] - 340];
    // The camera on the river side, so the walls stand ahead, beyond the canoe.
    const away = Math.atan2(c[2] - w[2], c[0] - w[0]);
    return { ...base, keys: [
      key(0, { target: [c[0], c[1] + 1.5, c[2]], dist: 26, theta: away - 0.3, phi: 1.44, fov: 40, focus: 26 }),
      key(0.5, { target: [c[0] + (w[0] - c[0]) * 0.55, 6, c[2] + (w[2] - c[2]) * 0.55], dist: 120, theta: away - 0.1, phi: 1.42, fov: 40, focus: 120 }),
      key(1, { target: [w[0], 4, w[2]], dist: 95, theta: away + 0.05, phi: 1.36, fov: 38, focus: 95 })
    ] };
  }
  if (id === 'deep-space') {
    // The planet in front, its star beyond and to one side (never behind it).
    const p = ctx.planet || [0, 3000, 0]; const s = ctx.star || [p[0] + 4000, p[1], p[2]]; const r = ctx.planetSize || 80;
    const fromStar = Math.atan2(p[2] - s[2], p[0] - s[0]);
    return { ...base, keys: [
      key(0, { target: p, dist: r * 7, theta: fromStar + 0.45, phi: 1.98, fov: 45, focus: null }),
      key(1, { target: p, dist: r * 5.6, theta: fromStar + 0.52, phi: 2.02, fov: 42, focus: null })
    ] };
  }
  throw new Error(`no plan for ${id}`);
}
