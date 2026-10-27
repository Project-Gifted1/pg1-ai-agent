// PG1 Sandbox viewer: one world, drawn in 3D in the browser with three.js
// (served from /vendor/three/, never a CDN). The server only sends the
// world's data; the phone or computer does the drawing. Worlds are
// simulations, and the screen around this says so.
//
//   createSandboxScene(container, { reducedMotion, coarse, onSelect })
//     -> { renderer, update(world, { duration }), setView(mode), select(id),
//          selected(), clock(), destroy() }
//
// What is drawn:
//   - every entity as a detailed model (public/sandbox/models.js): people
//     walk, cars and bikes roll, planes bank and climb, helicopters and
//     drones spin their rotors, rockets fire their engines on the way up;
//     things that never move (buildings, trees, roads) are batched into a
//     few draw calls;
//   - the world around them (environment.js): sky and sun on the world's
//     day (day_steps), terrain, lakes, clouds, stars, and the black of space
//     above the space altitude, where stations, planets and moons orbit;
//   - a clock, a minimap and a label for whatever is picked.
// Views: overview (the whole world), follow (tap something), tour (the
// camera visits what is moving), space (the sky above).
//
// Between steps, everything glides from where it was to where the engine
// put it, so a step of the simulation plays out over `duration` ms.
// With prefers-reduced-motion, or no WebGL, a still 2D map instead, redrawn
// only when the world changes.
//
// Quality (quality.js): Ultra, High, Medium or Low, from the device, lowered
// automatically when frames run slow, or chosen by hand (setQuality). A
// change of tier rebuilds the 3D view in place, keeping the world, the
// camera and what is picked. Post-processing is post.js.

import { buildModel, modelKey, baseKind, classOf, FIXED_KINDS, AIR_KINDS, HOME_KINDS, celestialSize, furnitureFor } from './models.js';
import { createEnvironment } from './environment.js';
import { buildStreets } from './streets.js';
import { buildCoast } from './coast.js';
import { createFoliage } from './foliage.js';
import { INTERIORS, interiorFor, storeysOf, doorOf } from './interiors.js';
import { Kit } from './kit.js';
import { setModelDetail } from './models.js';
import { buildSurface, surfaceKind } from './surface.js';
import { createControls } from './controls.js';
import { TIERS, TIER_SETTINGS, QUALITY_KEY, pickTier, createGovernor } from './quality.js';
import { createPost } from './post.js';
import { loadTextures, addSurfaceDetail } from './materials.js';
import { buildTerrain } from './terrain.js';

const MAX_ENTITIES = 1000;
const CLASS_COLOR = { person: 0xf3c623, animal: 0xff9b7a, plant: 0x3ddc84, building: 0xcfd8dc, structure: 0x9e9e9e, vehicle: 0x36d1c4, space: 0x8f86ff, celestial: 0xd98cff, thing: 0x7cc4ff };
const PALETTE = [0xf3c623, 0x36d1c4, 0x8f86ff, 0x3ddc84, 0xff9b7a, 0x7cc4ff, 0xffb300, 0xd98cff];
const KEEP_PROPS = ['to_x', 'to_y', 'gates', 'small', 'history', 'climate', 'culture', 'government', 'country', 'abroad', 'trip', 'text', 'color', 'roof', 'floors', 'heading', 'length', 'width', 'radius', 'size', 'inside', 'target', 'at', 'name', 'family', 'rings', 'clouds', 'shirt', 'livery', 'awning', 'lattice', 'orbit_radius', 'orbits', 'orbit_altitude', 'stages', 'energy', 'hunger', 'hygiene', 'social', 'mood', 'home', 'sex', 'age', 'job', 'work', 'education', 'money', 'partner', 'children', 'mother', 'father', 'saying', 'talking_to', 'built', 'furniture', 'owner', 'civ', 'jail_until', 'honesty', 'ambition', 'sociability', 'curiosity', 'crimes'];

export function kindColor(kind) {
  const c = CLASS_COLOR[classOf(kind)];
  if (c && classOf(kind) !== 'thing') return c;
  let h = 0;
  for (const ch of String(kind || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

export function normalizeWorld(w) {
  const world = w && typeof w === 'object' ? w : {};
  const s = world.size && typeof world.size === 'object' ? world.size : {};
  const size = { x: Math.max(1, Number(s.x) || 100), y: Math.max(1, Number(s.y) || 100), z: Math.max(0, Number(s.z) || 10) };
  const entities = (Array.isArray(world.entities) ? world.entities : []).filter((e) => e && typeof e.id === 'string').slice(0, MAX_ENTITIES).map((e) => {
    const props = {};
    const p = e.properties && typeof e.properties === 'object' ? e.properties : {};
    for (const k of KEEP_PROPS) if (p[k] !== undefined && (typeof p[k] !== 'string' || p[k].length <= 80)) props[k] = p[k];
    const kind = String(e.kind || 'thing').slice(0, 32);
    return {
      id: e.id.slice(0, 64), kind, base: baseKind(kind), cls: classOf(kind), props,
      x: Math.min(size.x, Math.max(0, Number(e.position && e.position.x) || 0)),
      y: Math.min(size.y, Math.max(0, Number(e.position && e.position.y) || 0)),
      z: Math.min(size.z, Math.max(0, Number(e.position && e.position.z) || 0))
    };
  });
  const spaceAlt = Number(world.space_altitude) > 0 ? Number(world.space_altitude) : (size.z >= 4000 ? 2000 : size.z / 2);
  return { id: typeof world.id === 'string' ? world.id : '', society: world.society && typeof world.society === 'object' ? world.society : null, size, entities, seed: Number(world.seed) || 1, tick: Number(world.tick) || 0, daySteps: Math.max(10, Number(world.day_steps) || 240), spaceAlt, name: world.name || '', roads: normalizeRoads(world.roads, size) };
}

// The road network (lib/sandbox/roads.mjs), as numbers only.
export function normalizeRoads(r, size) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.nodes) || !Array.isArray(r.edges)) return null;
  const nodes = r.nodes.slice(0, 4000).map((n) => [Math.min(size.x, Math.max(0, Number(n && n[0]) || 0)), Math.min(size.y, Math.max(0, Number(n && n[1]) || 0))]);
  const edges = r.edges.slice(0, 6000).filter((e) => Array.isArray(e) && Number.isInteger(e[0]) && Number.isInteger(e[1]) && e[0] >= 0 && e[1] >= 0 && e[0] < nodes.length && e[1] < nodes.length).map((e) => [e[0], e[1], Math.min(60, Math.max(1, Number(e[2]) || 8))]);
  return edges.length ? { nodes, edges } : null;
}
// The world's terrain (terrain.js, the engine's own): where land and water are.
export function terrainOfWorld(world) {
  return buildTerrain(world.entities.map((e) => ({ id: e.id, kind: e.kind, properties: e.props, position: { x: e.x, y: e.y } })), world.size);
}

export function kindsOf(world) {
  const counts = new Map();
  for (const e of world.entities) counts.set(e.kind, (counts.get(e.kind) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => ({ kind, n, color: hex(kindColor(kind)) }));
}

// The simulated time of day from the tick: step 0 is 06:00.
export function clockOf(world, tickF = world.tick) {
  const f = ((tickF / world.daySteps) + 0.25);
  const day = Math.floor(f) + 1;
  const mins = Math.floor((f - Math.floor(f)) * 24 * 60);
  return { day, hh: String(Math.floor(mins / 60)).padStart(2, '0'), mm: String(mins % 60).padStart(2, '0'), fraction: f - Math.floor(f) };
}

// --- the 2D map -------------------------------------------------------------------------------

function create2d(container, { onSelect } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'living-lab-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);
  container.dataset.renderer = '2d';
  let world = normalizeWorld(null);
  let sel = null;
  let view = null;
  const draw = () => {
    const r = container.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    const g = canvas.getContext('2d');
    if (!g) return;
    const w = canvas.width; const h = canvas.height;
    g.fillStyle = '#0a0a0b'; g.fillRect(0, 0, w, h);
    const pad = 16 * dpr;
    const k = Math.min((w - 2 * pad) / world.size.x, (h - 2 * pad) / world.size.y);
    const ox = (w - world.size.x * k) / 2; const oy = (h - world.size.y * k) / 2;
    view = { k, ox, oy, dpr };
    const X = (e) => ox + e.x * k; const Y = (e) => oy + (world.size.y - e.y) * k;
    const isl = world.entities.filter((e) => e.base === 'island');
    g.fillStyle = isl.length ? '#1f5f86' : '#26402a'; g.fillRect(ox, oy, world.size.x * k, world.size.y * k);
    for (const e of isl) { g.fillStyle = e.props.climate === 'tropical' ? '#3f7d34' : e.props.climate === 'cold' ? '#7d8a7a' : '#2f5a2a'; g.beginPath(); g.arc(X(e), Y(e), (Number(e.props.radius) || 500) * k, 0, Math.PI * 2); g.fill(); }
    for (const e of world.entities) if (e.base === 'lake') { g.fillStyle = '#1d5d8c'; g.beginPath(); g.arc(X(e), Y(e), (Number(e.props.radius) || 50) * k, 0, Math.PI * 2); g.fill(); }
    if (world.roads) { g.strokeStyle = '#45484e'; g.lineCap = 'round'; for (const [a, b, wd] of world.roads.edges) { const A = world.roads.nodes[a]; const B = world.roads.nodes[b]; g.lineWidth = Math.max(1 * dpr, wd * k); g.beginPath(); g.moveTo(ox + A[0] * k, oy + (world.size.y - A[1]) * k); g.lineTo(ox + B[0] * k, oy + (world.size.y - B[1]) * k); g.stroke(); } }
    for (const e of world.entities) if (e.base === 'road' || e.base === 'runway' || e.base === 'bridge') {
      const len = (Number(e.props.length) || 100) * k; const wd = Math.max(1.5 * dpr, (Number(e.props.width) || 12) * k);
      g.save(); g.translate(X(e), Y(e)); g.rotate(-(Number(e.props.heading) || 0) * Math.PI / 180); g.fillStyle = e.base === 'bridge' ? '#8d6e63' : '#45484e'; g.fillRect(-len / 2, -wd / 2, len, wd); g.restore();
    }
    for (const e of world.entities) {
      if (['lake', 'island', 'road', 'runway', 'bridge'].includes(e.base)) continue;
      g.fillStyle = hex(kindColor(e.kind));
      if (e.cls === 'building') { const s = Math.max(2.5 * dpr, 14 * k); g.fillRect(X(e) - s / 2, Y(e) - s / 2, s, s); continue; }
      const rad = e.cls === 'plant' ? Math.max(1.5 * dpr, 3 * k) : Math.max(2.5 * dpr, Math.min(6 * dpr, 6 * k));
      g.globalAlpha = e.z > world.spaceAlt ? 0.5 : 1;
      g.beginPath(); g.arc(X(e), Y(e), rad, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
      if (sel === e.id) { g.strokeStyle = '#f3c623'; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(X(e), Y(e), rad + 4 * dpr, 0, Math.PI * 2); g.stroke(); }
    }
  };
  const onClick = (ev) => {
    if (!view) return;
    const r = canvas.getBoundingClientRect();
    const px = (ev.clientX - r.left) * view.dpr; const py = (ev.clientY - r.top) * view.dpr;
    let best = null; let bd = 14 * view.dpr;
    for (const e of world.entities) { const d = Math.hypot(view.ox + e.x * view.k - px, view.oy + (world.size.y - e.y) * view.k - py); if (d < bd) { bd = d; best = e; } }
    sel = best ? best.id : null; draw();
    if (onSelect) onSelect(best ? describe(best) : null);
  };
  canvas.addEventListener('click', onClick);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
  if (ro) ro.observe(container);
  return {
    renderer: '2d',
    update(next) { world = normalizeWorld(next); container.dataset.markers = String(world.entities.length); draw(); },
    setView() {}, setXray() {}, setNames() {}, xray: () => false, names: () => false, select(id) { sel = id; draw(); }, selected: () => sel,
    clock: () => clockOf(world),
    screenshot,
    destroy() { if (ro) ro.disconnect(); canvas.removeEventListener('click', onClick); canvas.remove(); }
  };
}

function describe(e) {
  return { id: e.id, kind: e.kind, cls: e.cls, position: { x: Math.round(e.x), y: Math.round(e.y), z: Math.round(e.z) }, properties: { ...e.props } };
}

// --- painted textures for planets, moons and stars ---------------------------------------------

// A body's surface, painted on a canvas from seeded noise (512 x 256): rocky
// worlds and moons mottled and cratered, ocean worlds with continents,
// shallows and ice caps, gas giants in turbulent bands, ice worlds cracked,
// stars granulated, far alien worlds glowing with lights.
function planetTexture(THREE, base, kind, seed) {
  const W = 512; const H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const col = new THREE.Color(base); const hsl = {}; col.getHSL(hsl);
  let s = seed || 7;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  // Value noise on a sphere-ish wrap (x wraps), a few octaves.
  const P = 64; const grid = new Float32Array(P * P); for (let i = 0; i < grid.length; i++) grid[i] = r();
  const vn = (x, y) => { const xi = Math.floor(x); const yi = Math.floor(y); const xf = x - xi; const yf = y - yi; const at = (a, b) => grid[(((b % P) + P) % P) * P + (((a % P) + P) % P)]; const u = xf * xf * (3 - 2 * xf); const v = yf * yf * (3 - 2 * yf); return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v; };
  const fbm = (x, y) => { let t = 0; let a = 0.5; let f = 1; for (let o = 0; o < 5; o++) { t += a * vn(x * f, y * f); a *= 0.5; f *= 2; } return t; };
  const img = g.createImageData(W, H); const d = img.data; const px = new THREE.Color();
  const ocean = kind === 'planet' && col.b > col.r && col.b > col.g * 0.9;
  const ice = kind === 'planet' && hsl.l > 0.6 && !ocean;
  const giant = kind === 'planet' && !ocean && !ice && hsl.s < 0.55 && hsl.l > 0.45;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x / W) * P; const v = (y / H) * (P / 2);
    const n = fbm(u * 0.25, v * 0.25); const lat = Math.abs(y / H - 0.5) * 2;
    if (kind === 'star') px.copy(col).offsetHSL(0, 0, (n - 0.5) * 0.25 + (vn(u * 2, v * 2) - 0.5) * 0.15);
    else if (ocean) {
      const land = n > 0.53;
      if (land) px.setRGB(0.25, 0.42, 0.2).lerp(new THREE.Color(0.6, 0.5, 0.33), Math.min(1, (n - 0.53) * 6)).offsetHSL(0, 0, (vn(u, v) - 0.5) * 0.1);
      else px.copy(col).offsetHSL(0, 0, -0.12 + Math.max(0, n - 0.42) * 1.2);
      if (lat > 0.82 - (n - 0.5) * 0.2) px.setRGB(0.93, 0.95, 0.97);
    } else if (giant) {
      const band = Math.sin((y / H) * Math.PI * 14 + (n - 0.5) * 6) * 0.5 + 0.5;
      px.copy(col).offsetHSL((band - 0.5) * 0.03, (band - 0.5) * 0.1, (band - 0.5) * 0.22 + (vn(u * 3, v * 0.6) - 0.5) * 0.08);
    } else if (ice) {
      px.copy(col).offsetHSL(0, 0, (n - 0.5) * 0.15);
      if (Math.abs(vn(u * 1.5, v * 1.5) - 0.5) < 0.012) px.offsetHSL(0, 0.1, -0.25);   // cracks
    } else if (kind === 'alien_world') px.copy(col).offsetHSL((n - 0.5) * 0.08, 0, (n - 0.5) * 0.3);
    else px.copy(col).offsetHSL(0, 0, (n - 0.5) * 0.35 + (vn(u * 4, v * 4) - 0.5) * 0.1);
    const i = (y * W + x) * 4;
    d[i] = Math.max(0, Math.min(255, px.r * 255)); d[i + 1] = Math.max(0, Math.min(255, px.g * 255)); d[i + 2] = Math.max(0, Math.min(255, px.b * 255)); d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  if (kind === 'moon' || kind === 'asteroid' || (kind === 'planet' && !ocean && !giant && !ice)) {
    for (let i = 0; i < 160; i++) { const x = r() * W; const y = 10 + r() * (H - 20); const rad = 1 + r() * r() * 22; g.fillStyle = `rgba(0,0,0,${0.1 + r() * 0.2})`; g.beginPath(); g.ellipse(x, y, rad, rad * 0.9, 0, 0, Math.PI * 2); g.fill(); g.strokeStyle = `rgba(255,255,255,${0.08 + r() * 0.12})`; g.lineWidth = 1 + rad * 0.08; g.stroke(); }
  }
  if (kind === 'alien_world') for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(255,${220 + r() * 35},${120 + r() * 80},${0.5 + r() * 0.5})`; g.fillRect(r() * W, 32 + r() * (H - 64), 1.5, 1.5); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
// A glow round a world with air: brighter at its edge (a Fresnel shell).
const ATMO_VERT = `varying vec3 vN; varying vec3 vV;
void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
const ATMO_FRAG = `uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
void main() { float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6); gl_FragColor = vec4(uColor * f * 1.6, f); }`;
function glowTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.2, 'rgba(255,255,255,0.6)'); grad.addColorStop(0.5, 'rgba(255,255,255,0.15)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function ringTexture(THREE, base) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 4;
  const g = c.getContext('2d');
  const col = new THREE.Color(base);
  for (let x = 0; x < 256; x++) { const a = (Math.sin(x * 0.3) * 0.5 + 0.5) * (Math.sin(x * 0.07) * 0.3 + 0.6); const k = col.clone().offsetHSL(0, -0.1, (Math.sin(x * 0.9) * 0.08)); g.fillStyle = `rgba(${Math.round(k.r * 255)},${Math.round(k.g * 255)},${Math.round(k.b * 255)},${a.toFixed(2)})`; g.fillRect(x, 0, 1, 4); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// A point (out) and the direction (tan) at t on the Catmull-Rom curve
// through p0, p1, p2 between p1 and p2, with p3 carried on from p1 -> p2.
export function catmull(p0, p1, p2, t, out, tan) {
  const t2 = t * t; const t3 = t2 * t;
  for (const k of ['x', 'y', 'z']) {
    const a = p0[k]; const b = p1[k]; const c = p2[k]; const d = c + (c - b);
    out[k] = 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    if (tan) tan[k] = 0.5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t + 3 * (-a + 3 * b - 3 * c + d) * t2);
  }
  return out;
}

// --- the 3D scene --------------------------------------------------------------------------------

async function create3d(container, { coarse, threeUrl, onSelect, tier = 'high', onTierChange = null }) {
  const THREE = await import(threeUrl);
  const settings = TIER_SETTINGS[tier] || TIER_SETTINGS.high;
  // Low draws the plain shapes; Medium and up the finer detail (models.js).
  setModelDetail(tier === 'low' ? 1 : 2);
  const ADD = '/vendor/three/addons/';
  const [skyMod, csmMod, textures, reflMod] = await Promise.all([
    settings.sky === 'physical' ? import(`${ADD}objects/Sky.js`).catch(() => null) : null,
    settings.cascades > 0 ? import(`${ADD}csm/CSM.js`).catch(() => null) : null,
    settings.textures ? loadTextures(THREE) : null,
    settings.reflect === 'planar' ? import(`${ADD}objects/Reflector.js`).catch(() => null) : null
  ]);
  const canvas = document.createElement('canvas');
  canvas.className = 'living-lab-canvas sandbox-canvas';
  canvas.setAttribute('aria-label', 'The world in 3D. Drag to turn, pinch or scroll to zoom, two fingers to move, tap something to follow it.');
  let renderer;
  // No logarithmic depth (ambient occlusion reads the depth buffer): the near
  // plane follows the camera's distance instead, which keeps depth precise.
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.aa === 'none' && !coarse, alpha: false, powerPreference: tier === 'low' ? 'low-power' : 'high-performance', preserveDrawingBuffer: false }); } catch (e) { return null; }
  container.appendChild(canvas);
  container.dataset.renderer = 'webgl';
  container.dataset.tier = tier;
  const targetFps = coarse && tier === 'low' ? 30 : settings.targetFps;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = settings.cascades > 0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.3, 200000);
  const env = createEnvironment(THREE, scene, { coarse, quality: settings, camera, renderer, addons: { Sky: skyMod && skyMod.Sky, CSM: csmMod && csmMod.CSM, Reflector: reflMod && reflMod.Reflector } });
  // Streets in detail (streets.js) replace the plain road strips, here and in the ground.
  env.detailedRoads = !!settings.streets;
  let streets = null; let coast = null; let detailSig = '';
  // Grass and flowers round the camera (foliage.js): not on water, roads or pavements, nor in space.
  const foliage = settings.foliage > 0 ? createFoliage(THREE, { density: Math.round(settings.foliage * (coarse ? 0.6 : 1)), radius: settings.foliageRadius, setupMaterial: env.setupMaterial, coarse }) : null;
  if (foliage) scene.add(foliage.group);
  // Footprints of everything built (not plants or flat roads), for the grass to keep out of.
  let footGrid = new Map();
  function indexFootprints() {
    footGrid = new Map();
    for (const b of staticBoxes) {
      if (!b.e || b.e.cls === 'plant' || ['road', 'runway', 'bridge', 'grass', 'flower', 'crop', 'beach'].includes(b.e.base)) continue;
      for (let i = Math.floor(b.box.min.x / 20); i <= Math.floor(b.box.max.x / 20); i++) for (let j = Math.floor(b.box.min.z / 20); j <= Math.floor(b.box.max.z / 20); j++) { const k = `${i}|${j}`; if (!footGrid.has(k)) footGrid.set(k, []); footGrid.get(k).push(b.box); }
    }
  }
  const onFootprint = (x, z) => { const l = footGrid.get(`${Math.floor(x / 20)}|${Math.floor(z / 20)}`); return !!l && l.some((b) => x > b.min.x - 1 && x < b.max.x + 1 && z > b.min.z - 1 && z < b.max.z + 1); };
  const blockedAt = (x, z) => (env.waterAt ? env.waterAt(x, z) : false) || (streets ? streets.covers(x, z) : false) || onFootprint(x, z) || Math.abs(x) > world.size.x / 2 + 400 || Math.abs(z) > world.size.y / 2 + 400;
  env.textures = textures;
  const glow = glowTexture(THREE);

  const matBody = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.06 });
  const matGlass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.75 });
  const matGlow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const matFlame = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  // Buildings have their own materials, so "See inside" can make them glass.
  const matBuild = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.06 });
  const matBuildGlass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.75 });
  const matBuildGlow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  for (const m of [matBody, matGlass, matBuild, matBuildGlass]) env.setupMaterial(m);
  // PBR surface detail (after the shadow setup, which replaces the compile hook).
  if (textures) { addSurfaceDetail(matBody, textures); addSurfaceDetail(matBuild, textures, { strength: 0.6, scale: 3 }); }
  const furnitureGroup = new THREE.Group();
  furnitureGroup.visible = false;
  let xray = false;
  let showNames = true;

  scene.add(furnitureGroup);
  function setXray(on) {
    xray = !!on;
    for (const m of [matBuild, matBuildGlass]) { m.transparent = xray; m.opacity = xray ? 0.16 : 1; m.depthWrite = !xray; m.needsUpdate = true; }
    matBuildGlow.transparent = xray; matBuildGlow.opacity = xray ? 0.3 : 1; matBuildGlow.needsUpdate = true;
    furnitureGroup.visible = xray;
    container.dataset.xray = String(xray);
  }

  // Overlays: a clock, a minimap, a label for the picked thing.
  const hud = document.createElement('div');
  hud.className = 'sandbox-hud';
  hud.innerHTML = '<span class="sandbox-clock" aria-live="off"></span><canvas class="sandbox-minimap" width="132" height="132" aria-label="Minimap: tap to move there"></canvas><div class="sandbox-tags" aria-hidden="true"></div><div class="sandbox-label" hidden></div><div class="sandbox-floors" hidden><button type="button" data-floor="1" aria-label="Up a floor">▲</button><span></span><button type="button" data-floor="-1" aria-label="Down a floor">▼</button></div>';
  container.appendChild(hud);
  const clockEl = hud.querySelector('.sandbox-clock');
  const mini = hud.querySelector('.sandbox-minimap');
  const label = hud.querySelector('.sandbox-label');
  const floorsEl = hud.querySelector('.sandbox-floors');
  // Names and what people are saying, over their heads (the nearest few).
  const tagsEl = hud.querySelector('.sandbox-tags');
  const TAG_MAX = coarse ? 8 : 16;
  const tags = Array.from({ length: TAG_MAX }, () => { const d = document.createElement('div'); d.className = 'sandbox-tag'; d.hidden = true; d.innerHTML = '<b></b><span class="job"></span><span class="say"></span>'; tagsEl.appendChild(d); return d; });
  let tagsAt = 0; let tagList = [];
  const JOB_WORD = { soldier: 'soldier', leader: 'leader', farmer: 'farmer', shopkeeper: 'shopkeeper', driver: 'driver', builder: 'builder', teacher: 'teacher', police: 'police', engineer: 'engineer', doctor: 'doctor', scientist: 'scientist', pilot: 'pilot', astronaut: 'astronaut', retired: 'retired', unemployed: 'looking for work' };
  function updateTags(now) {
    if (!showNames) { for (const t of tags) t.hidden = true; return; }
    if (now - tagsAt > 200) {
      tagsAt = now;
      tagList = [...movers.values()].filter((m) => m.e && m.e.cls === 'person' && m.group.visible && (!m.e.props.inside || movers.get(m.e.props.inside)?.seat))
        .map((m) => ({ m, d: camera.position.distanceTo(m.group.position) })).filter((x) => x.d < 260).sort((a, b) => (b.m.e.props.saying ? 1 : 0) - (a.m.e.props.saying ? 1 : 0) || a.d - b.d).slice(0, TAG_MAX);
    }
    const r = container.getBoundingClientRect();
    const placed = [];
    tags.forEach((t, i) => {
      const it = tagList[i];
      if (!it || it.m.id === selectedId) { t.hidden = true; return; }
      const e = it.m.e; const p = e.props;
      proj.copy(it.m.group.position); proj.y += (e.base === 'child' ? 1.4 : 2.1);
      proj.project(camera);
      if (proj.z >= 1 || Math.abs(proj.x) > 1 || Math.abs(proj.y) > 1) { t.hidden = true; return; }
      const sx = (proj.x * 0.5 + 0.5) * r.width; const sy = (-proj.y * 0.5 + 0.5) * r.height;
      // No pile-ups: a tag too close to one already shown waits its turn.
      if (placed.some(([px, py]) => Math.abs(px - sx) < 90 && Math.abs(py - sy) < 20)) { t.hidden = true; return; }
      placed.push([sx, sy]);
      t.hidden = false;
      const name = `${p.name || e.id}${p.family ? ` ${p.family}` : ''}`;
      if (t.children[0].textContent !== name) t.children[0].textContent = name;
      const job = e.base === 'child' ? `${Math.floor(p.age || 0)}` : JOB_WORD[p.job] || (e.base === 'alien' ? 'visitor' : '');
      if (t.children[1].textContent !== job) t.children[1].textContent = job;
      const say = p.saying ? `“${p.saying}”` : '';
      if (t.children[2].textContent !== say) t.children[2].textContent = say;
      t.classList.toggle('is-talking', !!say);
      t.style.transform = `translate(${Math.round((proj.x * 0.5 + 0.5) * r.width)}px, ${Math.round((-proj.y * 0.5 + 0.5) * r.height)}px) translate(-50%, -100%)`;
    });
  }

  let world = normalizeWorld(null);
  let groundSig = '';
  let staticSig = '';
  const staticGroup = new THREE.Group();
  scene.add(staticGroup);
  // (furnitureGroup is added below, once the materials exist.)
  let staticBoxes = []; // [{ id, box }]
  const movers = new Map(); // id -> mover
  const geoCache = new Map();
  const orbitLines = new Map();
  let stepStart = performance.now(); let stepDur = 1200; let tickFrom = 0; let tickTo = 0;

  const toScene = (e, out = new THREE.Vector3()) => out.set(e.x - world.size.x / 2, e.z, -(e.y - world.size.y / 2));
  const yawFromHeading = (deg) => (Number(deg) || 0) * Math.PI / 180;

  function modelFor(e) {
    const key = modelKey(e.kind, e.props, e.id);
    let m = geoCache.get(key);
    if (!m) { m = buildModel(THREE, e.kind, e.props, e.id); geoCache.set(key, m); }
    return m;
  }
  function meshesOf(geo, cast = true) {
    const g = new THREE.Group();
    if (geo.body) { const m = new THREE.Mesh(geo.body, matBody); m.castShadow = cast && !coarse; m.receiveShadow = !coarse; g.add(m); }
    if (geo.glass) { const m = new THREE.Mesh(geo.glass, matGlass); m.castShadow = cast && !coarse; g.add(m); }
    if (geo.glow) g.add(new THREE.Mesh(geo.glow, matGlow));
    return g;
  }

  // Things that never move: batched into three meshes.
  function rebuildStatic() {
    for (const o of [...staticGroup.children, ...furnitureGroup.children]) { o.parent.remove(o); o.geometry && o.geometry.dispose(); }
    staticBoxes = [];
    const layers = { body: [], glow: [], glass: [] };
    const blayers = { body: [], glow: [], glass: [] };
    const flayers = { body: [], glow: [], glass: [] };
    const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const p = new THREE.Vector3(); const one = new THREE.Vector3(1, 1, 1); const up = new THREE.Vector3(0, 1, 0);
    for (const e of world.entities) {
      if (!FIXED_KINDS.has(e.base) || (e.base === 'road' && settings.streets)) continue;
      const model = modelFor(e);
      toScene(e, p);
      q.setFromAxisAngle(up, yawFromHeading(e.props.heading));
      m4.compose(p, q, one);
      const box = new THREE.Box3();
      const into = e.cls === 'building' ? blayers : layers;
      for (const name of ['body', 'glow', 'glass']) {
        if (!model[name]) continue;
        const g = model[name].clone(); g.applyMatrix4(m4); into[name].push(g);
        g.computeBoundingBox(); box.union(g.boundingBox);
      }
      if (!box.isEmpty()) staticBoxes.push({ id: e.id, box, e });
      // A finished home's furniture, for "See inside".
      if (HOME_KINDS.has(e.base) && !(typeof e.props.built === 'number' && e.props.built < 100)) {
        const fkey = `furniture|${e.base}|${Math.min(12, Number(e.props.furniture) || 0)}`;
        let fm = geoCache.get(fkey);
        if (!fm) { fm = { ...furnitureFor(THREE, e.base, Math.min(12, Number(e.props.furniture) || 0)), parts: [] }; geoCache.set(fkey, fm); }
        for (const name of ['body', 'glow', 'glass']) if (fm[name]) { const g = fm[name].clone(); g.applyMatrix4(m4); flayers[name].push(g); }
      }
      // Every other building's inside (interiors.js): shown when you go in, or with "See inside".
      if (INTERIORS[e.base] && !(typeof e.props.built === 'number' && e.props.built < 100) && !(e.base === 'tower' && e.props.lattice)) {
        const ikey = `interior|${e.base}|${storeysOf(e.base, e.props)}`;
        let im = geoCache.get(ikey);
        if (!im) { im = { ...(interiorFor(THREE, Kit, e.base, e.props) || {}), parts: [] }; geoCache.set(ikey, im); }
        for (const name of ['body', 'glow', 'glass']) if (im[name]) { const g = im[name].clone(); g.applyMatrix4(m4); flayers[name].push(g); }
      }
    }
    const merge = (list) => {
      if (!list.length) return null;
      let n = 0; for (const g of list) n += g.attributes.position.count;
      const pos = new Float32Array(n * 3); const nor = new Float32Array(n * 3); const col = new Float32Array(n * 3);
      let o = 0;
      for (const g of list) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3); o += g.attributes.position.count; g.dispose(); }
      const m = new THREE.BufferGeometry();
      m.setAttribute('position', new THREE.BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); m.setAttribute('color', new THREE.BufferAttribute(col, 3));
      m.computeBoundingSphere();
      return m;
    };
    const add = (group, ls, mats) => {
      const b = merge(ls.body); const gl = merge(ls.glow); const gs = merge(ls.glass);
      if (b) { const m = new THREE.Mesh(b, mats[0]); m.castShadow = !coarse; m.receiveShadow = !coarse; group.add(m); }
      if (gs) { const m = new THREE.Mesh(gs, mats[1]); m.castShadow = !coarse; m.receiveShadow = !coarse; group.add(m); }
      if (gl) group.add(new THREE.Mesh(gl, mats[2]));
    };
    add(staticGroup, layers, [matBody, matGlass, matGlow]);
    add(staticGroup, blayers, [matBuild, matBuildGlass, matBuildGlow]);
    add(furnitureGroup, flayers, [matBody, matGlass, matGlow]);
  }

  // A celestial body: a painted sphere (and a glow, rings, clouds, a light).
  function celestial(e) {
    const g = new THREE.Group();
    const size = celestialSize(e.kind, e.props);
    const color = typeof e.props.color === 'string' ? e.props.color : e.base === 'star' ? '#ffd27a' : e.base === 'moon' ? '#cfcfcf' : '#8fa8c9';
    let seed = 0; for (const ch of e.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const tex = planetTexture(THREE, color, e.base, seed);
    const mat = e.base === 'star' || e.base === 'alien_world' ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: 0xffffff }) : new THREE.MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: e.base === 'moon' || e.base === 'asteroid' ? 2.5 : 0.8, roughness: 0.9, metalness: 0 });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(size, coarse ? 48 : 96, coarse ? 24 : 48), mat);
    g.add(sphere);
    // Air: a glowing rim round worlds with clouds, oceans or an alien sky.
    const airy = e.base === 'alien_world' || (e.base === 'planet' && (e.props.clouds || new THREE.Color(color).b > new THREE.Color(color).r));
    if (airy) {
      const shell = new THREE.Mesh(new THREE.SphereGeometry(size * 1.05, 64, 32), new THREE.ShaderMaterial({ vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG, uniforms: { uColor: { value: new THREE.Color(e.base === 'alien_world' ? color : '#6fb6ff') } }, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      g.add(shell);
    }
    if (e.base === 'star') {
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      halo.scale.setScalar(size * 9);
      g.add(halo);
      const light = new THREE.PointLight(color, 3, 0, 0);
      g.add(light);
    } else if (!airy) {
      // (Worlds with air have the rim glow instead: the two together wash a world out.)
      const atmo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: e.base === 'planet' ? color : 0x888888, transparent: true, opacity: e.base === 'planet' ? 0.35 : 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
      atmo.scale.setScalar(size * 3);
      g.add(atmo);
    }
    if (e.props.clouds) { const cl = new THREE.Mesh(new THREE.SphereGeometry(size * 1.02, 40, 20), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, roughness: 1, depthWrite: false })); cl.userData.spin = 0.05; g.add(cl); }
    if (e.props.rings) {
      const rg = new THREE.RingGeometry(size * 1.4, size * 2.4, 96, 1);
      const uv = rg.attributes.uv; const pp = rg.attributes.position; const v = new THREE.Vector3();
      for (let i = 0; i < uv.count; i++) { v.fromBufferAttribute(pp, i); uv.setXY(i, (v.length() - size * 1.4) / (size * 1.0), 0.5); }
      const ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ map: ringTexture(THREE, color), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2 + 0.35;
      g.add(ring);
    }
    sphere.userData.spin = e.base === 'star' ? 0.01 : 0.08;
    return { group: g, inner: g, parts: [], size: size * 2, celestial: true };
  }

  function makeMover(e) {
    if (e.cls === 'celestial' && e.base !== 'asteroid') return celestial(e);
    const model = modelFor(e);
    const group = new THREE.Group();
    const inner = new THREE.Group();          // the model, so pitch and roll do not touch the yaw
    group.add(inner);
    inner.add(meshesOf(model));
    const parts = [];
    for (const p of model.parts) {
      const holder = new THREE.Group();
      holder.position.set(p.pivot[0], p.pivot[1], p.pivot[2]);
      const pm = p.role === 'flame' ? (() => { const gg = new THREE.Group(); if (p.geo.glow) gg.add(new THREE.Mesh(p.geo.glow, matFlame)); return gg; })() : meshesOf(p.geo);
      holder.add(pm);
      inner.add(holder);
      parts.push({ role: p.role, node: holder, r: Math.max(0.1, p.pivot[1]), front: p.pivot[0] > 0.05 });
    }
    return { group, inner, parts, size: model.size || 4, upright: !!model.upright, spin: model.spin || 0, seat: model.seat || null, far: farOf(e, model) };
  }

  // Far away, a moving thing is drawn as one block of its own size and
  // colour: all of them together in one instanced mesh (one draw call).
  const farCache = new Map();
  function farOf(e, model) {
    const key = modelKey(e.kind, e.props, e.id);
    if (farCache.has(key)) return farCache.get(key);
    const box = new THREE.Box3(); const c = new THREE.Color(0, 0, 0); let n = 0;
    for (const name of ['body', 'glass']) {
      const g = model[name]; if (!g) continue;
      g.computeBoundingBox(); box.union(g.boundingBox);
      const col = g.attributes.color;
      if (col && name === 'body') for (let i = 0; i < col.count; i += 3) { c.r += col.getX(i); c.g += col.getY(i); c.b += col.getZ(i); n++; }
    }
    for (const p of model.parts) { const g = p.geo.body; if (g) { g.computeBoundingBox(); const b = g.boundingBox.clone().translate(new THREE.Vector3(...p.pivot)); box.union(b); } }
    const f = box.isEmpty() ? null : { size: box.getSize(new THREE.Vector3()), centre: box.getCenter(new THREE.Vector3()), color: n ? c.multiplyScalar(1 / n) : new THREE.Color(0.5, 0.5, 0.5) };
    farCache.set(key, f);
    return f;
  }
  let farMesh = null;
  const farBox = new THREE.BoxGeometry(1, 1, 1);
  const farMat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05 });
  env.setupMaterial(farMat);
  function farCapacity(n) {
    if (farMesh && farMesh.instanceMatrix.count >= n) return farMesh;
    if (farMesh) { scene.remove(farMesh); farMesh.dispose(); }
    farMesh = new THREE.InstancedMesh(farBox, farMat, Math.max(64, Math.ceil(n * 1.25)));
    farMesh.frustumCulled = false;
    farMesh.castShadow = false; farMesh.receiveShadow = !coarse;
    farMesh.count = 0;
    scene.add(farMesh);
    return farMesh;
  }

  function syncMovers(duration) {
    const seen = new Set();
    for (const e of world.entities) {
      if (FIXED_KINDS.has(e.base) || e.base === 'lake' || e.base === 'island') continue;
      seen.add(e.id);
      let m = movers.get(e.id);
      const key = modelKey(e.kind, e.props, e.id);
      if (m && m.key !== key) { scene.remove(m.group); movers.delete(e.id); m = null; }
      const to = toScene(e);
      if (!m) {
        m = makeMover(e);
        m.key = key; m.id = e.id;
        m.from = to.clone(); m.to = to.clone(); m.pos = to.clone();
        m.yaw = yawFromHeading(e.props.heading); m.pitch = 0; m.roll = 0; m.phase = Math.random() * 6;
        m.group.position.copy(to);
        m.group.userData.entityId = e.id;
        scene.add(m.group);
        movers.set(e.id, m);
      } else {
        // The step before too, for a curved path through the steps (Catmull-Rom).
        m.prev = m.from.clone();
        m.from = m.pos.clone();
        m.to = to;
      }
      m.e = e;
    }
    for (const [id, m] of movers) if (!seen.has(id)) { scene.remove(m.group); movers.delete(id); }
    stepDur = Math.max(200, duration || 1200);
    stepStart = performance.now();
    container.dataset.markers = String(world.entities.length);
  }

  function syncOrbits() {
    const want = new Set();
    for (const e of world.entities) {
      const r = Number(e.props.orbit_radius);
      if (!(r > 0) || typeof e.props.orbits !== 'string') continue;
      want.add(e.id);
      if (!orbitLines.has(e.id)) {
        const pts = []; for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x8f86ff, transparent: true, opacity: 0.35, depthWrite: false }));
        line.userData = { center: e.props.orbits, alt: Number(e.props.orbit_altitude) || 0 };
        scene.add(line);
        orbitLines.set(e.id, line);
      }
    }
    for (const [id, l] of orbitLines) if (!want.has(id)) { scene.remove(l); l.geometry.dispose(); l.material.dispose(); orbitLines.delete(id); }
  }

  // An asteroid belt round the star, where its asteroids orbit (or, with
  // none, in the widest gap between its planets' orbits): scenery drawn by
  // the viewer round the world's own asteroids, like the woods.
  let belt = null; let beltKey = '';
  function syncBelt() {
    const star = world.entities.find((e) => e.base === 'star');
    const radii = star ? world.entities.filter((e) => e.props.orbits === star.id && Number(e.props.orbit_radius) > 0).map((e) => Number(e.props.orbit_radius)).sort((a, b) => a - b) : [];
    const key = star && radii.length >= 2 ? `${star.id}|${radii.join(',')}` : '';
    if (key === beltKey) return;
    beltKey = key;
    if (belt) { scene.remove(belt); belt.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); belt = null; }
    if (!key) return;
    // Where the star's asteroids orbit, if it has any; else the widest gap.
    let gap = 0; let at = 0;
    const rocksR = world.entities.filter((e) => e.base === 'asteroid' && e.props.orbits === star.id).map((e) => Number(e.props.orbit_radius)).filter((x) => x > 0);
    if (rocksR.length) { const lo = Math.min(...rocksR); const hi = Math.max(...rocksR); at = (lo + hi) / 2; gap = Math.max(200, (hi - lo + 120) / 0.36); }
    else for (let i = 1; i < radii.length; i++) if (radii[i] - radii[i - 1] > gap) { gap = radii[i] - radii[i - 1]; at = (radii[i] + radii[i - 1]) / 2; }
    const n = coarse ? 260 : 900;
    const geo = new THREE.DodecahedronGeometry(1, 1);
    const pp = geo.attributes.position; for (let i = 0; i < pp.count; i++) { const k = 0.75 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.5; pp.setXYZ(i, pp.getX(i) * k, pp.getY(i) * k * 0.8, pp.getZ(i) * k); }
    geo.computeVertexNormals();
    const rocks = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }), n);
    let q = 4242; const rnd = () => { q = (Math.imul(q, 1664525) + 1013904223) >>> 0; return q / 4294967296; };
    const m4 = new THREE.Matrix4(); const qt = new THREE.Quaternion(); const e3 = new THREE.Euler(); const v = new THREE.Vector3(); const sc = new THREE.Vector3(); const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2; const rr = at + (rnd() + rnd() - 1) * gap * 0.18;
      e3.set(rnd() * 6, rnd() * 6, rnd() * 6); qt.setFromEuler(e3);
      const k = 1.5 + rnd() * rnd() * 11;
      m4.compose(v.set(Math.cos(a) * rr, (rnd() - 0.5) * 30, Math.sin(a) * rr), qt, sc.set(k, k * (0.6 + rnd() * 0.5), k * (0.8 + rnd() * 0.4)));
      rocks.setMatrixAt(i, m4); rocks.setColorAt(i, c.setHSL(0.07 + rnd() * 0.05, 0.12 + rnd() * 0.1, 0.25 + rnd() * 0.2));
    }
    rocks.instanceMatrix.needsUpdate = true; if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    rocks.computeBoundingSphere();
    belt = new THREE.Group(); belt.add(rocks); belt.userData.star = star.id;
    scene.add(belt);
  }

  // Landing on another world (surface.js): its own scene, walked at eye
  // height; the page allows it only once the inhabitants have reached it.
  let surface = null; let drawnScene = scene;
  function closeSurface() {
    if (!surface) return;
    surface.dispose(); surface = null; delete container.dataset.surface;
  }
  function land(id, { contact = false } = {}) {
    const e = world.entities.find((x) => x.id === id);
    const kind = surfaceKind(e);
    if (!kind || kind === 'giant') return false;
    closeSurface();
    const colony = world.entities.find((c) => c.base === 'colony' && c.props.orbits === id) || null;
    const mats = { body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.06 }), glass: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.75 }), glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }) };
    const model = (k, props, mid) => {
      const m = buildModel(THREE, k, props, mid); if (!m) return null;
      const g = new THREE.Group();
      const add = (geo, at) => { for (const name of ['body', 'glass', 'glow']) if (geo[name]) { const mesh = new THREE.Mesh(geo[name], mats[name]); mesh.castShadow = name !== 'glow' && !coarse; if (at) mesh.position.set(at[0], at[1], at[2]); g.add(mesh); } };
      add(m); for (const p of m.parts || []) add(p.geo, p.pivot);
      return g;
    };
    let seed = 0; for (const ch of id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    surface = buildSurface(THREE, { kind, name: e.props.name || e.kind.replace(/_/g, ' '), color: typeof e.props.color === 'string' ? e.props.color : '#8a8a8a', seed, colony, city: kind === 'alien' && contact ? (e.props.name || e.id) : null, model, coarse });
    const own = surface.dispose; surface.dispose = () => { own(); for (const m of Object.values(mats)) m.dispose(); };
    container.dataset.surface = kind;
    mode = 'explore'; controls.autoRotate = 0; controls.minDist = 1.5; container.dataset.view = mode;
    selectedId = null; marker.visible = false; if (onSelect) onSelect(null);
    controls.jumpTo({ target: new THREE.Vector3(0, surface.heightAt(0, 70) + 1.6, 70), dist: 6, phi: 1.5, theta: Math.PI / 2 });
    if (typeof container.onViewChange === 'function') container.onViewChange(mode);
    schedule();
    return true;
  }

  // --- views ------------------------------------------------------------------------------
  let mode = 'overview'; let selectedId = null; let tourNext = 0;
  const controls = createControls(THREE, canvas, camera, { onTap: (x, y) => pick(x, y) });
  controls.ease = settings.ease || 5;
  controls.onPan = () => { if (mode === 'follow' || mode === 'tour') setMode('free'); };
  // The overview frames where things are (the town), not the empty corners.
  const centre = () => {
    const pts = world.entities.filter((e) => e.z < world.spaceAlt && e.cls !== 'plant');
    if (!pts.length) return new THREE.Vector3(0, 0, 0);
    const v = new THREE.Vector3();
    for (const e of pts) v.add(toScene(e, new THREE.Vector3()).setY(0));
    return v.multiplyScalar(1 / pts.length);
  };
  const spread = () => {
    const c = centre(); const ds = world.entities.filter((e) => e.z < world.spaceAlt && e.cls !== 'plant').map((e) => toScene(e, new THREE.Vector3()).setY(0).distanceTo(c)).sort((a, b) => a - b);
    return ds.length ? Math.max(60, ds[Math.floor(ds.length * 0.8)]) : Math.max(world.size.x, world.size.y) / 2;
  };

  function entityPos(id) {
    const m = movers.get(id);
    if (m) return m.group.position.clone();
    const sb = staticBoxes.find((b) => b.id === id);
    if (sb) return sb.box.getCenter(new THREE.Vector3()).setY(0);
    return null;
  }
  function sizeOf(id) {
    const m = movers.get(id);
    if (m) return m.size || 4;
    const sb = staticBoxes.find((b) => b.id === id);
    return sb ? sb.box.getSize(new THREE.Vector3()).length() : 10;
  }
  function setMode(next, { quiet = false } = {}) {
    mode = next;
    controls.autoRotate = mode === 'overview' ? 0.03 : mode === 'tour' ? 0.05 : mode === 'space' ? 0.02 : 0;
    controls.minDist = mode === 'explore' ? 1.5 : 4;
    if (mode !== 'explore') { leave(); closeSurface(); }
    const span = Math.max(world.size.x, world.size.y);
    if (mode === 'overview') controls.flyTo({ target: centre(), dist: Math.min(span * 0.85, spread() * 2.6), phi: 0.95 });
    if (mode === 'space') {
      const star = world.entities.find((e) => e.base === 'star') || world.entities.find((e) => e.base === 'space_station' || e.base === 'planet');
      const t = star ? toScene(star) : new THREE.Vector3(0, world.spaceAlt * 1.5, 0);
      controls.flyTo({ target: t, dist: star && star.base === 'star' ? 2900 : 900, phi: 1.36 });
    }
    // Close enough to see it: a station or colony fills the view; a planet sits in it.
    if (mode === 'follow' && selectedId) { const se = world.entities.find((x) => x.id === selectedId); const close = se && ['space_station', 'colony', 'satellite'].includes(se.base); const person = se && se.cls === 'person'; const vehicle = se && se.cls === 'vehicle' && !AIR_KINDS.has(se.base); controls.flyTo({ dist: person ? 4.5 : vehicle ? Math.max(7, sizeOf(selectedId) * 1.8) : Math.max(14, sizeOf(selectedId) * (close ? 1.3 : 4.5)), phi: person ? 1.38 : vehicle ? 1.2 : close ? 1.05 : 1.18 }); }
    if (mode === 'tour') tourNext = 0;
    // Explore: down at eye height where the camera looks; drag to look
    // round, tap the ground to walk there, pinch to step back.
    if (mode === 'explore') {
      const at = controls.target.clone(); at.y = Math.max(0, (env.heightAt || (() => 0))(at.x, at.z)) + 1.6;
      if (at.y > 60) at.set(centre().x, 1.6, centre().z);
      controls.flyTo({ target: at, dist: 6, phi: 1.5 });
    }
    container.dataset.view = mode;
    if (!quiet && typeof container.onViewChange === 'function') container.onViewChange(mode);
  }
  function select(id, { follow = true } = {}) {
    selectedId = id && world.entities.some((e) => e.id === id) ? id : null;
    const e = selectedId ? world.entities.find((x) => x.id === selectedId) : null;
    if (onSelect) onSelect(e ? describe(e) : null);
    if (e && follow) setMode('follow');
    marker.visible = !!e;
  }
  const ray = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function pick(x, y) {
    ray.setFromCamera({ x, y }, camera);
    let best = null; let bd = Infinity;
    const hits = ray.intersectObjects([...movers.values()].map((m) => m.group), true);
    for (const h of hits) { let o = h.object; while (o && !o.userData.entityId) o = o.parent; if (o && h.distance < bd) { bd = h.distance; best = o.userData.entityId; } break; }
    const v = new THREE.Vector3();
    for (const b of staticBoxes) { if (ray.ray.intersectBox(b.box, v)) { const d = v.distanceTo(ray.ray.origin); if (d < bd) { bd = d; best = b.id; } } }
    // On another world: a tap on the ground walks there.
    if (surface) {
      groundPlane.constant = -controls.target.y + 1.6;
      const hit = ray.ray.intersectPlane(groundPlane, new THREE.Vector3());
      if (hit && hit.distanceTo(ray.ray.origin) < 600) controls.flyTo({ target: new THREE.Vector3(hit.x, surface.heightAt(hit.x, hit.z) + 1.6, hit.z) });
      return;
    }
    // Exploring: a tap on a building goes in at its front door.
    if (mode === 'explore' && best && enter(best)) return;
    // Exploring: a tap on open ground (or water's edge, or the floor you are on) walks there.
    if (mode === 'explore' && !best) {
      groundPlane.constant = -(inside ? floorY(inside) : 0);
      const hit = ray.ray.intersectPlane(groundPlane, v);
      if (hit && hit.distanceTo(ray.ray.origin) < 400) {
        const y = (inside ? floorY(inside) : Math.max(0, (env.heightAt || (() => 0))(hit.x, hit.z))) + 1.6;
        controls.flyTo({ target: new THREE.Vector3(hit.x, y, hit.z) });
        return;
      }
    }
    select(best);
  }

  // Going inside: the building's walls turn see-through, its rooms show,
  // and ▲ ▼ change floors. Leaving (walking out, or another view) undoes it.
  let inside = null; let autoXray = false;
  const HOME_DOOR = { house: [11, 9], cabin: [8, 7], apartment: [20, 14] };
  function floorY(st) { return 0.3 + st.storey * st.fh; }
  function enter(id) {
    const sb = staticBoxes.find((b) => b.id === id); if (!sb || sb.e.cls !== 'building') return false;
    const e = sb.e; const home = HOME_DOOR[e.base];
    const door = home ? { x: home[0] / 2 - 1.5, z: 0 } : doorOf(e.base);
    if (!door) return false;
    const yaw = yawFromHeading(e.props.heading);
    const c = toScene(e, new THREE.Vector3());
    const off = new THREE.Vector3(door.x, 0, door.z).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    inside = { id, e, storey: 0, storeys: home ? 1 : storeysOf(e.base, e.props), fh: home ? 3.1 : INTERIORS[e.base].fh, base: c.y, box: sb.box };
    // Look in, away from the door (the model's -x).
    const theta = Math.PI - (Number(e.props.heading) || 0) * Math.PI / 180;
    controls.flyTo({ target: new THREE.Vector3(c.x + off.x, floorY(inside) + 1.6, c.z + off.z), dist: 2.5, phi: 1.52, theta: theta + Math.PI });
    if (!xray) { autoXray = true; setXray(true); }
    showFloors();
    return true;
  }
  function leave() {
    if (!inside) return;
    inside = null; floorsEl.hidden = true;
    if (autoXray) { autoXray = false; setXray(false); }
  }
  function showFloors() {
    floorsEl.hidden = !inside || inside.storeys < 2;
    if (inside) floorsEl.querySelector('span').textContent = inside.storey === 0 ? 'Ground' : `Floor ${inside.storey}`;
  }
  floorsEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b || !inside) return;
    ev.stopPropagation();
    inside.storey = Math.max(0, Math.min(inside.storeys - 1, inside.storey + Number(b.dataset.floor)));
    controls.flyTo({ target: new THREE.Vector3(controls.goalTarget.x, floorY(inside) + 1.6, controls.goalTarget.z) });
    showFloors(); schedule();
  });
  // Walked out of the building's footprint: outside again.
  function checkInside() {
    if (!inside) return;
    const t = controls.goalTarget; const b = inside.box;   // where the camera is going (it eases there)
    if (mode !== 'explore' || t.x < b.min.x - 3 || t.x > b.max.x + 3 || t.z < b.min.z - 3 || t.z > b.max.z + 3) leave();
  }

  // The marker over what is picked: a gold cone that bobs gently.
  const marker = new THREE.Mesh(new THREE.ConeGeometry(1, 2, 4), new THREE.MeshBasicMaterial({ color: 0xf3c623, toneMapped: false }));
  marker.rotation.x = Math.PI;
  marker.visible = false;
  scene.add(marker);

  // --- the minimap ------------------------------------------------------------------------
  let miniAt = 0;
  function drawMini() {
    const g = mini.getContext('2d'); if (!g) return;
    const W = mini.width; const H = mini.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(10,10,11,0.78)'; g.fillRect(0, 0, W, H);
    const k = (W - 12) / Math.max(world.size.x, world.size.y);
    const ox = (W - world.size.x * k) / 2; const oy = (H - world.size.y * k) / 2;
    const X = (e) => ox + e.x * k; const Y = (e) => oy + (world.size.y - e.y) * k;
    const isl = world.entities.filter((e) => e.base === 'island');
    g.fillStyle = isl.length ? '#1f5f86' : '#25402a'; g.fillRect(ox, oy, world.size.x * k, world.size.y * k);
    for (const e of isl) { g.fillStyle = e.props.climate === 'tropical' ? '#3f7d34' : e.props.climate === 'cold' ? '#7d8a7a' : '#3a6a30'; g.beginPath(); g.arc(X(e), Y(e), (Number(e.props.radius) || 500) * k, 0, 7); g.fill(); }
    if (world.roads) { g.strokeStyle = '#5a5d63'; g.lineWidth = 1; g.beginPath(); for (const [a, b, wd] of world.roads.edges) { if (wd < 6) continue; const A = world.roads.nodes[a]; const B = world.roads.nodes[b]; g.moveTo(ox + A[0] * k, oy + (world.size.y - A[1]) * k); g.lineTo(ox + B[0] * k, oy + (world.size.y - B[1]) * k); } g.stroke(); }
    for (const e of world.entities) {
      if (e.base === 'lake') { g.fillStyle = '#2f7fb0'; g.beginPath(); g.arc(X(e), Y(e), (Number(e.props.radius) || 50) * k, 0, 7); g.fill(); }
      else if (e.base === 'road' || e.base === 'runway') { const L = (Number(e.props.length) || 100) * k; g.save(); g.translate(X(e), Y(e)); g.rotate(-(Number(e.props.heading) || 0) * Math.PI / 180); g.fillStyle = '#5a5d63'; g.fillRect(-L / 2, -1, L, 2); g.restore(); }
    }
    for (const e of world.entities) {
      if (['lake', 'island', 'road', 'runway', 'bridge', 'grass', 'flower', 'lamp', 'fence', 'crop', 'beach'].includes(e.base) || e.cls === 'plant') continue;
      const m = movers.get(e.id);
      let x = X(e); let y = Y(e);
      if (m) { x = ox + (m.group.position.x + world.size.x / 2) * k; y = oy + (m.group.position.z + world.size.y / 2) * k; }
      g.fillStyle = e.z > world.spaceAlt ? '#b9a8ff' : hex(kindColor(e.kind));
      const s = e.cls === 'building' ? 2.4 : e.cls === 'vehicle' ? 2 : 1.3;
      g.fillRect(x - s / 2, y - s / 2, s, s);
    }
    const tx = ox + (controls.target.x + world.size.x / 2) * k; const ty = oy + (controls.target.z + world.size.y / 2) * k;
    g.strokeStyle = '#f3c623'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(tx, ty); g.lineTo(tx - Math.cos(controls.theta) * 12, ty - Math.sin(controls.theta) * 12); g.stroke();
    g.beginPath(); g.arc(tx, ty, 3, 0, 7); g.stroke();
    mini._map = { k, ox, oy };
  }
  const onMini = (ev) => {
    ev.stopPropagation();
    const mm = mini._map; if (!mm) return;
    const r = mini.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (mini.width / r.width); const py = (ev.clientY - r.top) * (mini.height / r.height);
    const wx = (px - mm.ox) / mm.k; const wy = world.size.y - (py - mm.oy) / mm.k;
    setMode('free', { quiet: false });
    controls.flyTo({ target: new THREE.Vector3(wx - world.size.x / 2, 0, -(wy - world.size.y / 2)), dist: Math.min(controls.goalDist, 600) });
  };
  mini.addEventListener('click', onMini);

  // --- sizing and the frame loop ---------------------------------------------------------
  let post = null;
  function resize() {
    const r = container.getBoundingClientRect();
    const pr = Math.min(settings.pixelRatio, window.devicePixelRatio || 1);
    renderer.setPixelRatio(pr);
    renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
    camera.aspect = Math.max(1, r.width) / Math.max(1, r.height);
    camera.updateProjectionMatrix();
    if (post) post.setSize(Math.max(1, r.width), Math.max(1, r.height), pr);
    if (env.csm) env.csm.updateFrustums();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  resize();
  try { post = await createPost(THREE, renderer, scene, camera, settings); } catch (e) { post = null; if (typeof console !== 'undefined') console.warn('[sandbox] post-processing unavailable:', e && e.message); }
  resize();
  // The governor steps the tier down when frames keep running slow.
  const governor = createGovernor({ tier, budgetMs: 1000 / targetFps, onChange: (t, info) => { if (onTierChange) onTierChange(t, info); } });
  let lastRender = 0;

  let visible = true; let raf = 0; let last = performance.now(); let acc = 0;
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => { visible = entries.some((x) => x.isIntersecting); schedule(); }) : null;
  if (io) io.observe(container);
  const onVis = () => schedule();
  document.addEventListener('visibilitychange', onVis);
  const running = () => visible && !document.hidden;
  const tmpA = new THREE.Vector3(); const tmpB = new THREE.Vector3(); const proj = new THREE.Vector3(); const tmpM4 = new THREE.Matrix4(); const tmpT = new THREE.Vector3();

  const farM4 = new THREE.Matrix4(); const farS = new THREE.Vector3(); const farP = new THREE.Vector3();
  function animate(dt, now) {
    const t = Math.min(1, (now - stepStart) / stepDur);
    const tickF = tickFrom + (tickTo - tickFrom) * t;
    const far = farCapacity(movers.size);
    let farN = 0;
    for (const m of movers.values()) {
      const e = m.e;
      // Riders: on a bike, motorbike or horse they sit on it; otherwise inside, out of sight.
      const inside = e.props.inside && movers.get(e.props.inside);
      if (inside) {
        const open = inside.seat || ['horse'].includes(inside.e.base);
        m.group.visible = !!open;
        if (open) {
          const seat = inside.seat || [0, 1.1, 0];
          tmpA.set(seat[0], seat[1] - 0.85, seat[2]).applyAxisAngle(THREE.Object3D.DEFAULT_UP, inside.yaw);
          m.group.position.copy(inside.group.position).add(tmpA);
          m.group.rotation.y = inside.yaw;
          for (const p of m.parts) if (p.role === 'legL' || p.role === 'legR') p.node.rotation.z = 1.2;
          m.pos.copy(m.group.position);
        }
        continue;
      }
      m.group.visible = true;
      // Along a curve through the last steps (Catmull-Rom), not a straight
      // line between two of them: a car rounds a corner, a plane turns.
      const span0 = m.prev ? m.prev.distanceTo(m.from) : 0; const span1 = m.from.distanceTo(m.to);
      const curve = m.prev && !m.celestial && span0 > 0.05 && span1 > 0.05 && span0 < span1 * 4 + 20 && span1 < span0 * 4 + 20;
      if (curve) catmull(m.prev, m.from, m.to, t, m.pos, tmpT);
      else { m.pos.lerpVectors(m.from, m.to, t); tmpT.subVectors(m.to, m.from); }
      if (m.from.y < 0.05 && m.to.y < 0.05) m.pos.y = Math.max(0, Math.min(m.from.y, m.to.y));  // wheels stay on the ground
      const dx = tmpT.x; const dz = tmpT.z; const dy = m.to.y - m.from.y;
      const dh = Math.hypot(m.to.x - m.from.x, m.to.z - m.from.z);
      const moving = dh > 0.05 || Math.abs(dy) > 0.05;
      const speed = (Math.hypot(dh, dy) / (stepDur / 1000));
      let yawRate = 0;
      if (dh > 0.05 && !m.celestial && !m.upright) {
        const goal = Math.atan2(-dz, dx);
        let d = goal - m.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
        const step = d * (1 - Math.exp(-dt * 6));
        m.yaw += step;
        yawRate = dt > 0 ? step / dt : 0;
      }
      m.group.position.copy(m.pos);
      if (!m.celestial) m.group.rotation.y = m.upright ? 0 : m.yaw;
      // Flyers pitch with the climb and lean into turns; ground vehicles stay level.
      const flyer = AIR_KINDS.has(e.base) && !m.upright && !m.celestial;
      if (flyer) {
        const goalPitch = moving ? Math.atan2(dy, Math.max(dh, 0.01)) * 0.8 : 0;
        m.pitch += (goalPitch - m.pitch) * (1 - Math.exp(-dt * 3));
        m.inner.rotation.z = m.pitch;
        // Bank into turns (never on the ground).
        const goalRoll = e.z > 2 ? Math.max(-0.6, Math.min(0.6, -yawRate * 0.9)) : 0;
        m.roll += (goalRoll - m.roll) * (1 - Math.exp(-dt * 3));
        m.inner.rotation.x = m.roll;
      }
      m.steer = (m.steer || 0) + (Math.max(-0.5, Math.min(0.5, yawRate * 0.35)) - (m.steer || 0)) * Math.min(1, dt * 8);
      if (e.base === 'boat' || e.base === 'ship') { m.inner.rotation.x = Math.sin(now / 900 + m.phase) * 0.03; m.inner.position.y = Math.sin(now / 700 + m.phase) * 0.15; }
      if (e.base === 'hot_air_balloon' || e.base === 'drone') m.inner.position.y = Math.sin(now / 1300 + m.phase) * (e.base === 'drone' ? 0.15 : 0.8);
      if (m.spin) m.group.rotation.y += m.spin * dt;
      if (m.celestial) m.group.traverse((o) => { if (o.userData.spin) o.rotation.y += o.userData.spin * dt; });
      const dist = speed * dt;
      m.phase += dt * Math.min(12, 2 + speed * 1.6);
      for (const p of m.parts) {
        switch (p.role) {
          case 'wheel': p.node.rotation.z -= moving ? dist / p.r : 0; if (p.front) p.node.rotation.y = m.steer; break;
          case 'rotorY': p.node.rotation.y += dt * ((moving || e.z > 0.5) ? 30 : 4); break;
          case 'ring': p.node.rotation.y += dt * 0.12; break;   // a station's habitat ring turns slowly
          case 'rotorZ': p.node.rotation.z += dt * ((moving || e.z > 0.5) ? 40 : 6); break;
          case 'propX': p.node.rotation.x += dt * ((moving || e.z > 0.5) ? 50 : 0); break;
          case 'legL': case 'legR': { const a = moving ? Math.sin(m.phase) * 0.55 : 0; p.node.rotation.z += ((p.role === 'legL' ? a : -a) - p.node.rotation.z) * Math.min(1, dt * 10); break; }
          case 'armL': case 'armR': { const a = moving ? Math.sin(m.phase) * 0.45 : 0; p.node.rotation.z += ((p.role === 'armL' ? -a : a) - p.node.rotation.z) * Math.min(1, dt * 10); break; }
          case 'wingL': case 'wingR': { const a = Math.sin(m.phase * 2.5) * 0.7; p.node.rotation.x = p.role === 'wingL' ? a : -a; break; }
          case 'flame': { const on = moving && (dy > 0.5 || e.z > 1); p.node.visible = on; if (on) { const s = 1 + Math.sin(now / 160) * 0.08; p.node.scale.set(1, s, 1); } break; }
          default: break;
        }
      }
      // Far away, small things are not drawn (they would be under a pixel).
      const camD = camera.position.distanceTo(m.group.position);
      if (!m.celestial) m.group.visible = camD < Math.max(600, (m.size || 2) * 420);
      // Beyond the tier's detail distance (never the followed thing): the block.
      if (m.group.visible && m.far && !m.celestial && m.id !== selectedId && camD > Math.max(60, (m.size || 2) * settings.lod)) {
        m.group.visible = false;
        m.group.updateMatrix();
        farP.copy(m.far.centre); farS.copy(m.far.size).max(tmpB.set(0.3, 0.3, 0.3));
        farM4.makeTranslation(farP.x, farP.y, farP.z).premultiply(m.group.matrix);
        farM4.multiply(tmpM4.makeScale(farS.x, farS.y, farS.z));
        far.setMatrixAt(farN, farM4); far.setColorAt(farN, m.far.color);
        farN++;
      }
    }
    far.count = farN;
    far.instanceMatrix.needsUpdate = true;
    if (far.instanceColor) far.instanceColor.needsUpdate = true;
    // The belt goes round with its star.
    if (belt) { const c = entityPos(belt.userData.star); if (c) belt.position.copy(c); belt.rotation.y += dt * 0.004; belt.visible = !!c; }
    // Orbit paths follow their centres.
    for (const l of orbitLines.values()) {
      const c = entityPos(l.userData.center);
      if (c) l.position.set(c.x, c.y + l.userData.alt, c.z);
      l.visible = !!c;
    }
    return tickF;
  }

  function frame(now) {
    raf = 0;
    if (!running()) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    acc += dt; last = now;
    schedule();
    if (acc < 1 / targetFps - 0.002) return;
    const step = acc; acc = 0;
    if (lastRender && now - lastRender < 250) governor.sample(now - lastRender);
    lastRender = now;
    const tickF = animate(step, now);

    // Camera modes.
    if ((mode === 'follow' || mode === 'tour') && selectedId) {
      const p = entityPos(selectedId);
      // Locked on: the camera keeps up with fast things (a car covers 90 m a step).
      if (p) { controls.goalTarget.copy(p).add(tmpB.set(0, Math.min(6, sizeOf(selectedId) * 0.3), 0)); controls.target.lerp(controls.goalTarget, 1 - Math.exp(-step * 9)); }
    }
    if (mode === 'tour' && now > tourNext) {
      const pool = [...movers.values()].filter((m) => m.e && !m.e.props.inside && !m.celestial && m.from.distanceTo(m.to) > 0.5);
      const pref = pool.filter((m) => ['rocket', 'plane', 'helicopter', 'shuttle', 'bus', 'small_plane', 'ship', 'hot_air_balloon'].includes(m.e.base));
      const list = pref.length && Math.random() < 0.6 ? pref : pool;
      if (list.length) {
        const m = list[Math.floor(Math.random() * list.length)];
        selectedId = m.id;
        if (onSelect) onSelect(describe(m.e));
        controls.flyTo({ dist: Math.max(16, m.size * 4), phi: 1.1 + Math.random() * 0.25, theta: controls.goalTheta + 0.8 });
      }
      tourNext = now + 9000;
    }
    controls.update(step);
    checkInside();
    // The near plane follows the camera's distance (2% of it): depth stays
    // precise enough for a coast 20 cm above the sea seen from 10 km.
    const near = Math.min(1000, Math.max(0.2, controls.dist * 0.02));
    if (Math.abs(near - camera.near) / camera.near > 0.05) { camera.near = near; camera.updateProjectionMatrix(); }

    // Sky, light and fog from the time of day and the camera's height.
    const clk = clockOf(world, tickF);
    const camAlt = camera.position.y;
    // Space when looking at space; a high overview of the ground keeps its sky.
    const effAlt = controls.target.y > world.spaceAlt * 0.5 ? camAlt : Math.min(camAlt, world.spaceAlt * 0.4);
    const envState = env.update({ dayFraction: clk.fraction, cameraAlt: effAlt, spaceAlt: world.spaceAlt, camera, target: controls.target, shadowSpan: controls.dist * 0.7, dt: step });
    // Windows read as dark glass by day and warm light at night.
    const nt = Math.min(1, envState.night + envState.space * 0.4);
    matGlow.color.setRGB(0.22 + nt * 1.2, 0.27 + nt * 1.0, 0.36 + nt * 0.6);
    renderer.toneMappingExposure = 0.95 + envState.space * 0.15;
    if (post) post.setNight(nt);
    if (streets) streets.update(envState.night);
    if (coast) coast.update(now / 1000, envState.day);
    if (foliage) {
      if (controls.target.y < 50) foliage.place({ cx: controls.target.x, cz: controls.target.z, heightAt: env.heightAt || (() => 0), blocked: blockedAt });
      foliage.update(now / 1000, controls.target.y < 50 ? controls.dist : Infinity);
    }
    if (post && post.setFocus) post.setFocus(controls.dist);

    // The marker and label over what is picked.
    if (selectedId && marker.visible) {
      const p = entityPos(selectedId);
      if (p) {
        const s = Math.max(0.25, Math.min(8, sizeOf(selectedId) * 0.1));
        marker.scale.setScalar(s);
        marker.position.copy(p).add(tmpA.set(0, sizeOf(selectedId) * 0.75 + s * 2 + Math.sin(now / 400) * s * 0.3, 0));
        proj.copy(marker.position).project(camera);
        const r = container.getBoundingClientRect();
        if (proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1) {
          const e = world.entities.find((x) => x.id === selectedId);
          label.hidden = false;
          label.textContent = e ? `${e.props.name || e.kind.replace(/_/g, ' ')} · ${e.id}` : selectedId;
          label.style.transform = `translate(${Math.round((proj.x * 0.5 + 0.5) * r.width)}px, ${Math.round((-proj.y * 0.5 + 0.5) * r.height) - 12}px) translate(-50%, -100%)`;
        } else label.hidden = true;
      }
    } else label.hidden = true;

    // Walking on another world, the ground follows its hills.
    if (surface) { const h = surface.heightAt(controls.goalTarget.x, controls.goalTarget.z) + 1.6; if (Math.abs(controls.goalTarget.y - h) > 0.05) controls.goalTarget.y = h; }
    clockEl.textContent = surface ? `Simulation · day ${clk.day} · ${clk.hh}:${clk.mm} · on ${surface.name}` : `Simulation · day ${clk.day} · ${clk.hh}:${clk.mm}${effAlt > world.spaceAlt ? ' · in space' : ''}`;
    updateTags(now);
    if (now - miniAt > 250) { drawMini(); miniAt = now; }
    const still = controls.userActive <= 0 && !controls.autoRotate && t0done(now);
    draw(still);
    container.dataset.frames = String((Number(container.dataset.frames) || 0) + 1);
  }
  function draw(still) {
    const sc = surface ? surface.scene : scene;
    if (sc !== drawnScene) { drawnScene = sc; if (post && post.setScene) post.setScene(sc); }
    if (!surface) env.beforeRender(camera);
    if (post) post.render(still); else renderer.render(sc, camera);
  }
  // A still of the view (a PNG data URL), stamped "Simulation" with the day and time.
  function screenshot() {
    draw(true);
    const src = renderer.domElement;
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    const g = c.getContext('2d'); if (!g) return null;
    g.drawImage(src, 0, 0);
    const clk = clockOf(world);
    const text = `Simulation · day ${clk.day} · ${clk.hh}:${clk.mm}`;
    const fs = Math.max(12, Math.round(c.height / 36));
    g.font = `600 ${fs}px system-ui, sans-serif`;
    const w = g.measureText(text).width;
    g.fillStyle = 'rgba(10,10,11,0.6)'; g.fillRect(fs * 0.6, c.height - fs * 2.4, w + fs * 1.2, fs * 1.8);
    g.fillStyle = '#ffffff'; g.fillText(text, fs * 1.2, c.height - fs * 1.05);
    return c.toDataURL('image/png');
  }
  function schedule() { if (!raf && running()) { last = performance.now(); lastRender = 0; raf = requestAnimationFrame(frame); } }
  const t0done = (now) => now - stepStart >= stepDur;

  let firstWorld = true;
  return {
    renderer: 'webgl',
    update(next, { duration } = {}) {
      const prevTick = world.tick;
      const prevId = world.id;
      world = normalizeWorld(next);
      // Another world: start afresh (camera, things, selection, clock).
      if (!firstWorld && world.id !== prevId) {
        for (const m of movers.values()) scene.remove(m.group);
        movers.clear();
        selectedId = null; marker.visible = false;
        if (onSelect) onSelect(null);
        firstWorld = true;
      }
      const gs = `${world.size.x}|${world.size.y}|${world.seed}|${world.roads ? `${world.roads.nodes.length}/${world.roads.edges.length}` : ''}|${world.entities.filter((e) => FIXED_KINDS.has(e.base) || e.base === 'lake' || e.base === 'island').map((e) => `${e.id}:${Math.round(e.x)}:${Math.round(e.y)}:${e.props.radius || ''}`).join(',')}`;
      if (gs !== groundSig) {
        groundSig = gs;
        const lakeEntities = world.entities.filter((e) => e.base === 'lake' || e.base === 'road' || e.base === 'runway').map((e) => ({ ...e, sx: e.x - world.size.x / 2, sz: -(e.y - world.size.y / 2), radius: Number(e.props.radius) || 60, heading: -(Number(e.props.heading) || 0), length: Number(e.props.length) || 100, width: Number(e.props.width) || 12 }));
        const islands = world.entities.filter((e) => e.base === 'island').map((e) => ({ sx: e.x - world.size.x / 2, sz: -(e.y - world.size.y / 2), r: Number(e.props.radius) || 500, climate: e.props.climate || 'temperate', name: e.props.name || e.id }));
        const avoid = world.entities.filter((e) => e.z < 5).map((e) => ({ x: e.x - world.size.x / 2, z: -(e.y - world.size.y / 2), r: e.base === 'lake' ? (Number(e.props.radius) || 60) : e.cls === 'building' ? 25 : 0 }));
        env.buildGround({ size: world.size, seed: world.seed, entities: lakeEntities, avoid, islands, terrain: terrainOfWorld(world), roads: world.roads });
      }
      // Streets and coasts, when the ground or the road network changes.
      const rd = world.roads || (next && next.roads) || null;
      const ds = `${groundSig}|${rd && rd.nodes ? `${rd.nodes.length}/${rd.edges.length}` : ''}`;
      if (ds !== detailSig) {
        detailSig = ds;
        for (const d of [streets, coast]) if (d) { scene.remove(d.group); d.dispose(); }
        streets = null; coast = null;
        const heightAt = env.heightAt || (() => 0);
        if (settings.streets) { streets = buildStreets(THREE, { ...world, roads: rd }, { heightAt, setupMaterial: env.setupMaterial, coarse }); scene.add(streets.group); container.dataset.lamps = String(streets.stats.lamps); }
        const isl = world.entities.filter((e) => e.base === 'island').map((e) => ({ sx: e.x - world.size.x / 2, sz: -(e.y - world.size.y / 2), r: Number(e.props.radius) || 500, climate: e.props.climate || 'temperate' }));
        const lakes = env.lakeList || [];
        if (settings.coast && (isl.length || lakes.length)) { coast = buildCoast(THREE, isl, { seed: world.seed, heightAt, setupMaterial: env.setupMaterial, coarse, surf: !settings.water, lakes }); scene.add(coast.group); }
        if (foliage) foliage.place({ cx: controls.target.x, cz: controls.target.z, heightAt, blocked: blockedAt, force: true });
      }
      const ss = world.entities.filter((e) => FIXED_KINDS.has(e.base)).map((e) => `${e.id}:${modelKey(e.kind, e.props, e.id)}:${e.x}:${e.y}:${e.props.heading || 0}`).join(',');
      if (ss !== staticSig) { staticSig = ss; rebuildStatic(); indexFootprints(); if (foliage) foliage.place({ cx: controls.target.x, cz: controls.target.z, heightAt: env.heightAt || (() => 0), blocked: blockedAt, force: true }); }
      tickFrom = firstWorld ? world.tick : prevTick; tickTo = world.tick;
      syncMovers(duration);
      syncOrbits();
      syncBelt();
      if (firstWorld) {
        firstWorld = false;
        const span = Math.max(world.size.x, world.size.y);
        controls.maxDist = Math.max(20000, span * 6);
        controls.jumpTo({ target: centre(), dist: Math.min(span * 0.85, spread() * 2.6), phi: 0.95, theta: 0.8 });
        setMode('overview', { quiet: true });
      }
      if (selectedId && !world.entities.some((e) => e.id === selectedId)) select(null);
      else if (selectedId && onSelect) { const e = world.entities.find((x) => x.id === selectedId); if (e) onSelect(describe(e)); }
      schedule();
    },
    setView(m) { if (m === 'follow' && !selectedId) return; setMode(m); schedule(); },
    // Land on a world (the page checks the inhabitants have reached it); false if it has no surface.
    land(id, opts) { return land(id, opts); },
    surfaceKind: (id) => surfaceKind(world.entities.find((x) => x.id === id)),
    onSurface: () => (surface ? { kind: surface.kind, name: surface.name } : null),
    // Go into a building (Explore, at its front door); false if it has no inside.
    enter(id) { closeSurface(); if (mode !== 'explore') setMode('explore', { quiet: true }); const ok = enter(id); schedule(); return ok; },
    inside: () => (inside ? { id: inside.id, storey: inside.storey, storeys: inside.storeys } : null),
    floor(d) { if (!inside) return; floorsEl.querySelector(`[data-floor="${d > 0 ? 1 : -1}"]`).click(); },
    // Explore from a place in the world (world metres), looking toward a heading (degrees, 0 = east).
    exploreAt(wx, wy, heading = 0) {
      closeSurface();
      const x = wx - world.size.x / 2; const z = -(wy - world.size.y / 2);
      controls.jumpTo({ target: new THREE.Vector3(x, Math.max(0, (env.heightAt || (() => 0))(x, z)) + 1.6, z), dist: 6, phi: 1.5, theta: Math.PI - (Number(heading) || 0) * Math.PI / 180 });
      mode = 'explore'; controls.autoRotate = 0; controls.minDist = 2; container.dataset.view = mode;
      if (typeof container.onViewChange === 'function') container.onViewChange(mode);
      schedule();
    },
    setXray(on) { setXray(on); schedule(); }, xray: () => xray,
    setNames(on) { showNames = !!on; schedule(); }, names: () => showNames,
    view: () => mode,
    tier: () => governor.tier,
    governor,
    cameraState: () => ({ target: controls.target.clone(), dist: controls.dist, theta: controls.theta, phi: controls.phi, mode, selectedId }),
    restoreCamera(st) { if (!st) return; controls.jumpTo({ target: st.target, dist: st.dist, theta: st.theta, phi: st.phi }); if (st.selectedId && world.entities.some((e) => e.id === st.selectedId)) { select(st.selectedId, { follow: false }); } setMode(st.mode === 'follow' && !selectedId ? 'free' : st.mode, { quiet: true }); schedule(); },
    select(id) { select(id); schedule(); },
    selected: () => selectedId,
    clock: () => clockOf(world),
    destroy() {
      cancelAnimationFrame(raf); raf = 0;
      if (io) io.disconnect(); if (ro) ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      mini.removeEventListener('click', onMini);
      controls.dispose();
      env.dispose();
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); }); });
      for (const m of geoCache.values()) { for (const k of ['body', 'glow', 'glass']) m[k] && m[k].dispose(); for (const p of m.parts) for (const k of ['body', 'glow', 'glass']) p.geo[k] && p.geo[k].dispose(); }
      if (post) post.dispose();
      for (const d of [streets, coast, foliage]) if (d) d.dispose();
      closeSurface();
      if (farMesh) farMesh.dispose(); farBox.dispose(); farMat.dispose();
      glow.dispose(); renderer.dispose(); canvas.remove(); hud.remove();
    }
  };
}

function hasWebGL() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
}

// The quality tier: a saved choice (this device), else from the device.
function savedTier() { try { return localStorage.getItem(QUALITY_KEY); } catch (e) { return null; } }
function saveTier(t) { try { if (t) localStorage.setItem(QUALITY_KEY, t); else localStorage.removeItem(QUALITY_KEY); } catch (e) { /* private mode */ } }

export async function createSandboxScene(container, { reducedMotion = false, coarse = false, threeUrl = '/vendor/three/three.module.min.js', onSelect = null, tier = null, onQuality = null } = {}) {
  if (reducedMotion || !hasWebGL()) return create2d(container, { onSelect });
  const saved = savedTier();
  let auto = !saved || saved === 'auto';
  let current = tier || pickTier({ coarse, memory: (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0, cores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0, saved });
  let inner = null; let lastWorld = null; let lastDuration = 1200; let busy = null; let destroyed = false;
  const opts = () => ({ coarse, threeUrl, onSelect, tier: current, onTierChange: (t) => { if (auto) switchTo(t, { manual: false }); } });
  async function build(state) {
    const s = await create3d(container, opts());
    if (!s) return null;
    s.governor.setAuto(auto);
    if (lastWorld) s.update(lastWorld, { duration: lastDuration });
    if (state) s.restoreCamera(state);
    return s;
  }
  // Rebuild in place at another tier, keeping the world, the camera and the selection.
  function switchTo(t, { manual }) {
    if (!TIERS.includes(t) || destroyed) return busy;
    if (t === current && inner) return busy;
    current = t;
    busy = (async () => {
      const state = inner ? inner.cameraState() : null;
      const xray = inner ? inner.xray() : false; const names = inner ? inner.names() : true;
      if (inner) { inner.destroy(); inner = null; }
      inner = await build(state);
      if (inner) { inner.setXray(xray); inner.setNames(names); }
      container.dataset.tier = current;
      if (onQuality) onQuality({ tier: current, auto, manual });
      return inner;
    })();
    return busy;
  }
  try { inner = await build(null); } catch (e) { if (typeof console !== 'undefined') console.warn('[sandbox] 3D view unavailable:', e && e.message); inner = null; }
  if (!inner) return create2d(container, { onSelect });
  const call = (name, ...a) => (inner && inner[name] ? inner[name](...a) : undefined);
  return {
    renderer: 'webgl',
    update(next, o = {}) { lastWorld = next; lastDuration = o.duration || lastDuration; call('update', next, o); },
    setView: (m) => call('setView', m), view: () => call('view'),
    exploreAt: (x, y, h) => call('exploreAt', x, y, h),
    land: (id, o) => !!call('land', id, o), surfaceKind: (id) => call('surfaceKind', id) || null, onSurface: () => call('onSurface') || null,
    enter: (id) => !!call('enter', id), inside: () => call('inside') || null, floor: (d) => call('floor', d),
    setXray: (on) => call('setXray', on), xray: () => !!call('xray'),
    setNames: (on) => call('setNames', on), names: () => !!call('names'),
    select: (id) => call('select', id), selected: () => call('selected'),
    clock: () => call('clock'),
    screenshot: () => call('screenshot') || null,
    quality: () => ({ tier: current, auto, tiers: TIERS.slice() }),
    // 'auto', or a tier to keep (remembered on this device).
    async setQuality(t) {
      if (t === 'auto') { auto = true; saveTier('auto'); const pick = pickTier({ coarse, memory: (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0, cores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0 }); await switchTo(pick, { manual: true }); if (inner) inner.governor.setAuto(true); if (onQuality) onQuality({ tier: current, auto, manual: true }); return; }
      if (!TIERS.includes(t)) return;
      auto = false; saveTier(t);
      await switchTo(t, { manual: true });
      if (inner) inner.governor.setAuto(false);
      if (onQuality) onQuality({ tier: current, auto, manual: true });
    },
    get inner() { return inner; },
    destroy() { destroyed = true; if (inner) inner.destroy(); inner = null; }
  };
}
