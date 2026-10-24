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

import { buildModel, modelKey, baseKind, classOf, FIXED_KINDS, AIR_KINDS, celestialSize } from './models.js';
import { createEnvironment } from './environment.js';
import { createControls } from './controls.js';

const MAX_ENTITIES = 500;
const CLASS_COLOR = { person: 0xf3c623, animal: 0xff9b7a, plant: 0x3ddc84, building: 0xcfd8dc, structure: 0x9e9e9e, vehicle: 0x36d1c4, space: 0x8f86ff, celestial: 0xd98cff, thing: 0x7cc4ff };
const PALETTE = [0xf3c623, 0x36d1c4, 0x8f86ff, 0x3ddc84, 0xff9b7a, 0x7cc4ff, 0xffb300, 0xd98cff];
const KEEP_PROPS = ['color', 'roof', 'floors', 'heading', 'length', 'width', 'radius', 'size', 'inside', 'target', 'at', 'name', 'rings', 'clouds', 'shirt', 'livery', 'awning', 'lattice', 'orbit_radius', 'orbits', 'orbit_altitude', 'stages', 'energy', 'mood', 'home'];

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
  return { id: typeof world.id === 'string' ? world.id : '', size, entities, seed: Number(world.seed) || 1, tick: Number(world.tick) || 0, daySteps: Math.max(10, Number(world.day_steps) || 240), spaceAlt, name: world.name || '' };
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
    g.fillStyle = '#26402a'; g.fillRect(ox, oy, world.size.x * k, world.size.y * k);
    const X = (e) => ox + e.x * k; const Y = (e) => oy + (world.size.y - e.y) * k;
    for (const e of world.entities) if (e.base === 'lake') { g.fillStyle = '#1d5d8c'; g.beginPath(); g.arc(X(e), Y(e), (Number(e.props.radius) || 50) * k, 0, Math.PI * 2); g.fill(); }
    for (const e of world.entities) if (e.base === 'road' || e.base === 'runway' || e.base === 'bridge') {
      const len = (Number(e.props.length) || 100) * k; const wd = Math.max(1.5 * dpr, (Number(e.props.width) || 12) * k);
      g.save(); g.translate(X(e), Y(e)); g.rotate(-(Number(e.props.heading) || 0) * Math.PI / 180); g.fillStyle = e.base === 'bridge' ? '#8d6e63' : '#45484e'; g.fillRect(-len / 2, -wd / 2, len, wd); g.restore();
    }
    for (const e of world.entities) {
      if (['lake', 'road', 'runway', 'bridge'].includes(e.base)) continue;
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
    setView() {}, select(id) { sel = id; draw(); }, selected: () => sel,
    clock: () => clockOf(world),
    destroy() { if (ro) ro.disconnect(); canvas.removeEventListener('click', onClick); canvas.remove(); }
  };
}

function describe(e) {
  return { id: e.id, kind: e.kind, cls: e.cls, position: { x: Math.round(e.x), y: Math.round(e.y), z: Math.round(e.z) }, properties: { ...e.props } };
}

// --- painted textures for planets, moons and stars ---------------------------------------------

function planetTexture(THREE, base, kind, seed) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  const col = new THREE.Color(base);
  let s = seed || 7;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  g.fillStyle = `#${col.getHexString()}`; g.fillRect(0, 0, 256, 128);
  if (kind === 'moon' || kind === 'asteroid') {
    for (let i = 0; i < 90; i++) { const x = r() * 256; const y = r() * 128; const rad = 1 + r() * 9; g.fillStyle = `rgba(0,0,0,${0.08 + r() * 0.15})`; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill(); g.strokeStyle = 'rgba(255,255,255,0.12)'; g.stroke(); }
  } else if (kind === 'star') {
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(255,${200 + r() * 55},${120 + r() * 80},${r() * 0.3})`; g.fillRect(r() * 256, r() * 128, 3, 3); }
  } else {
    // Bands, then land and clouds for the blue ones.
    for (let y = 0; y < 128; y += 2) {
      const t = Math.sin(y * 0.18 + r() * 0.6) * 0.5 + 0.5;
      const k = col.clone().offsetHSL((r() - 0.5) * 0.03, (r() - 0.5) * 0.1, (t - 0.5) * 0.18);
      g.fillStyle = `#${k.getHexString()}`; g.globalAlpha = 0.5; g.fillRect(0, y, 256, 2);
    }
    g.globalAlpha = 1;
    if (col.b > col.r) {
      for (let i = 0; i < 14; i++) { g.fillStyle = r() < 0.5 ? '#3f8f4a' : '#c2a46a'; g.beginPath(); g.ellipse(r() * 256, 20 + r() * 88, 10 + r() * 30, 6 + r() * 16, r() * 3, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = '#f5f7fa'; g.fillRect(0, 0, 256, 7); g.fillRect(0, 121, 256, 7);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
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

// --- the 3D scene --------------------------------------------------------------------------------

async function create3d(container, { coarse, threeUrl, onSelect }) {
  const THREE = await import(threeUrl);
  const canvas = document.createElement('canvas');
  canvas.className = 'living-lab-canvas sandbox-canvas';
  canvas.setAttribute('aria-label', 'The world in 3D. Drag to turn, pinch or scroll to zoom, two fingers to move, tap something to follow it.');
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: !coarse, alpha: false, powerPreference: coarse ? 'low-power' : 'high-performance', logarithmicDepthBuffer: true }); } catch (e) { return null; }
  container.appendChild(canvas);
  container.dataset.renderer = 'webgl';
  const targetFps = coarse ? 30 : 60;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = !coarse;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.3, 200000);
  const env = createEnvironment(THREE, scene, { coarse });
  const glow = glowTexture(THREE);

  const matBody = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.06 });
  const matGlass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.75 });
  const matGlow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const matFlame = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });

  // Overlays: a clock, a minimap, a label for the picked thing.
  const hud = document.createElement('div');
  hud.className = 'sandbox-hud';
  hud.innerHTML = '<span class="sandbox-clock" aria-live="off"></span><canvas class="sandbox-minimap" width="132" height="132" aria-label="Minimap: tap to move there"></canvas><div class="sandbox-label" hidden></div>';
  container.appendChild(hud);
  const clockEl = hud.querySelector('.sandbox-clock');
  const mini = hud.querySelector('.sandbox-minimap');
  const label = hud.querySelector('.sandbox-label');

  let world = normalizeWorld(null);
  let groundSig = '';
  let staticSig = '';
  const staticGroup = new THREE.Group();
  scene.add(staticGroup);
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
    for (const o of [...staticGroup.children]) { staticGroup.remove(o); o.geometry && o.geometry.dispose(); }
    staticBoxes = [];
    const layers = { body: [], glow: [], glass: [] };
    const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const p = new THREE.Vector3(); const one = new THREE.Vector3(1, 1, 1); const up = new THREE.Vector3(0, 1, 0);
    for (const e of world.entities) {
      if (!FIXED_KINDS.has(e.base)) continue;
      const model = modelFor(e);
      toScene(e, p);
      q.setFromAxisAngle(up, yawFromHeading(e.props.heading));
      m4.compose(p, q, one);
      const box = new THREE.Box3();
      for (const name of ['body', 'glow', 'glass']) {
        if (!model[name]) continue;
        const g = model[name].clone(); g.applyMatrix4(m4); layers[name].push(g);
        g.computeBoundingBox(); box.union(g.boundingBox);
      }
      if (!box.isEmpty()) staticBoxes.push({ id: e.id, box });
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
    const b = merge(layers.body); const gl = merge(layers.glow); const gs = merge(layers.glass);
    if (b) { const m = new THREE.Mesh(b, matBody); m.castShadow = !coarse; m.receiveShadow = !coarse; staticGroup.add(m); }
    if (gs) { const m = new THREE.Mesh(gs, matGlass); m.castShadow = !coarse; m.receiveShadow = !coarse; staticGroup.add(m); }
    if (gl) staticGroup.add(new THREE.Mesh(gl, matGlow));
  }

  // A celestial body: a painted sphere (and a glow, rings, clouds, a light).
  function celestial(e) {
    const g = new THREE.Group();
    const size = celestialSize(e.kind, e.props);
    const color = typeof e.props.color === 'string' ? e.props.color : e.base === 'star' ? '#ffd27a' : e.base === 'moon' ? '#cfcfcf' : '#8fa8c9';
    let seed = 0; for (const ch of e.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const tex = planetTexture(THREE, color, e.base, seed);
    const mat = e.base === 'star' ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: 0xffffff }) : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(size, 48, 24), mat);
    g.add(sphere);
    if (e.base === 'star') {
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      halo.scale.setScalar(size * 9);
      g.add(halo);
      const light = new THREE.PointLight(color, 3, 0, 0);
      g.add(light);
    } else {
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
      parts.push({ role: p.role, node: holder, r: Math.max(0.1, p.pivot[1]) });
    }
    return { group, inner, parts, size: model.size || 4, upright: !!model.upright, spin: model.spin || 0, seat: model.seat || null };
  }

  function syncMovers(duration) {
    const seen = new Set();
    for (const e of world.entities) {
      if (FIXED_KINDS.has(e.base) || e.base === 'lake') continue;
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

  // --- views ------------------------------------------------------------------------------
  let mode = 'overview'; let selectedId = null; let tourNext = 0;
  const controls = createControls(THREE, canvas, camera, { onTap: (x, y) => pick(x, y) });
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
    const span = Math.max(world.size.x, world.size.y);
    if (mode === 'overview') controls.flyTo({ target: centre(), dist: Math.min(span * 0.85, spread() * 2.6), phi: 0.95 });
    if (mode === 'space') {
      const star = world.entities.find((e) => e.base === 'star') || world.entities.find((e) => e.base === 'space_station' || e.base === 'planet');
      const t = star ? toScene(star) : new THREE.Vector3(0, world.spaceAlt * 1.5, 0);
      controls.flyTo({ target: t, dist: star && star.base === 'star' ? 2900 : 900, phi: 1.36 });
    }
    if (mode === 'follow' && selectedId) controls.flyTo({ dist: Math.max(14, sizeOf(selectedId) * 4.5), phi: 1.18 });
    if (mode === 'tour') tourNext = 0;
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
  function pick(x, y) {
    ray.setFromCamera({ x, y }, camera);
    let best = null; let bd = Infinity;
    const hits = ray.intersectObjects([...movers.values()].map((m) => m.group), true);
    for (const h of hits) { let o = h.object; while (o && !o.userData.entityId) o = o.parent; if (o && h.distance < bd) { bd = h.distance; best = o.userData.entityId; } break; }
    const v = new THREE.Vector3();
    for (const b of staticBoxes) { if (ray.ray.intersectBox(b.box, v)) { const d = v.distanceTo(ray.ray.origin); if (d < bd) { bd = d; best = b.id; } } }
    select(best);
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
    g.fillStyle = '#25402a'; g.fillRect(ox, oy, world.size.x * k, world.size.y * k);
    const X = (e) => ox + e.x * k; const Y = (e) => oy + (world.size.y - e.y) * k;
    for (const e of world.entities) {
      if (e.base === 'lake') { g.fillStyle = '#2f7fb0'; g.beginPath(); g.arc(X(e), Y(e), (Number(e.props.radius) || 50) * k, 0, 7); g.fill(); }
      else if (e.base === 'road' || e.base === 'runway') { const L = (Number(e.props.length) || 100) * k; g.save(); g.translate(X(e), Y(e)); g.rotate(-(Number(e.props.heading) || 0) * Math.PI / 180); g.fillStyle = '#5a5d63'; g.fillRect(-L / 2, -1, L, 2); g.restore(); }
    }
    for (const e of world.entities) {
      if (['lake', 'road', 'runway', 'bridge', 'grass', 'flower', 'lamp', 'fence', 'crop'].includes(e.base) || e.cls === 'plant') continue;
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
  function resize() {
    const r = container.getBoundingClientRect();
    renderer.setPixelRatio(Math.min(coarse ? 1.5 : 2, window.devicePixelRatio || 1));
    renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
    camera.aspect = Math.max(1, r.width) / Math.max(1, r.height);
    camera.updateProjectionMatrix();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  resize();

  let visible = true; let raf = 0; let last = performance.now(); let acc = 0;
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => { visible = entries.some((x) => x.isIntersecting); schedule(); }) : null;
  if (io) io.observe(container);
  const onVis = () => schedule();
  document.addEventListener('visibilitychange', onVis);
  const running = () => visible && !document.hidden;
  const tmpA = new THREE.Vector3(); const tmpB = new THREE.Vector3(); const proj = new THREE.Vector3();

  function animate(dt, now) {
    const t = Math.min(1, (now - stepStart) / stepDur);
    const tickF = tickFrom + (tickTo - tickFrom) * t;
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
      m.pos.lerpVectors(m.from, m.to, t);
      const dx = m.to.x - m.from.x; const dz = m.to.z - m.from.z; const dy = m.to.y - m.from.y;
      const dh = Math.hypot(dx, dz);
      const moving = dh > 0.05 || Math.abs(dy) > 0.05;
      const speed = (Math.hypot(dh, dy) / (stepDur / 1000));
      if (dh > 0.05 && !m.celestial && !m.upright) {
        const goal = Math.atan2(-dz, dx);
        let d = goal - m.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
        m.yaw += d * (1 - Math.exp(-dt * 6));
      }
      m.group.position.copy(m.pos);
      if (!m.celestial) m.group.rotation.y = m.upright ? 0 : m.yaw;
      // Flyers pitch with the climb and lean into turns; ground vehicles stay level.
      const flyer = AIR_KINDS.has(e.base) && !m.upright && !m.celestial;
      if (flyer) {
        const goalPitch = moving ? Math.atan2(dy, Math.max(dh, 0.01)) * 0.8 : 0;
        m.pitch += (goalPitch - m.pitch) * (1 - Math.exp(-dt * 3));
        m.inner.rotation.z = m.pitch;
      }
      if (e.base === 'boat' || e.base === 'ship') { m.inner.rotation.x = Math.sin(now / 900 + m.phase) * 0.03; m.inner.position.y = Math.sin(now / 700 + m.phase) * 0.15; }
      if (e.base === 'hot_air_balloon' || e.base === 'drone') m.inner.position.y = Math.sin(now / 1300 + m.phase) * (e.base === 'drone' ? 0.15 : 0.8);
      if (m.spin) m.group.rotation.y += m.spin * dt;
      if (m.celestial) m.group.traverse((o) => { if (o.userData.spin) o.rotation.y += o.userData.spin * dt; });
      const dist = speed * dt;
      m.phase += dt * Math.min(12, 2 + speed * 1.6);
      for (const p of m.parts) {
        switch (p.role) {
          case 'wheel': p.node.rotation.z -= moving ? dist / p.r : 0; break;
          case 'rotorY': p.node.rotation.y += dt * ((moving || e.z > 0.5) ? 30 : 4); break;
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
    }
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

    // Sky, light and fog from the time of day and the camera's height.
    const clk = clockOf(world, tickF);
    const camAlt = camera.position.y;
    const envState = env.update({ dayFraction: clk.fraction, cameraAlt: camAlt, spaceAlt: world.spaceAlt, camera, target: controls.target, shadowSpan: controls.dist * 0.7, dt: step });
    // Windows read as dark glass by day and warm light at night.
    const nt = Math.min(1, envState.night + envState.space * 0.4);
    matGlow.color.setRGB(0.22 + nt * 1.2, 0.27 + nt * 1.0, 0.36 + nt * 0.6);
    renderer.toneMappingExposure = 0.95 + envState.space * 0.15;

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

    clockEl.textContent = `Simulation · day ${clk.day} · ${clk.hh}:${clk.mm}${camAlt > world.spaceAlt ? ' · in space' : ''}`;
    if (now - miniAt > 250) { drawMini(); miniAt = now; }
    renderer.render(scene, camera);
    container.dataset.frames = String((Number(container.dataset.frames) || 0) + 1);
  }
  function schedule() { if (!raf && running()) { last = performance.now(); raf = requestAnimationFrame(frame); } }

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
      const gs = `${world.size.x}|${world.size.y}|${world.seed}|${world.entities.filter((e) => FIXED_KINDS.has(e.base) || e.base === 'lake').map((e) => `${e.id}:${Math.round(e.x)}:${Math.round(e.y)}:${e.props.radius || ''}`).join(',')}`;
      if (gs !== groundSig) {
        groundSig = gs;
        const lakeEntities = world.entities.filter((e) => e.base === 'lake' || e.base === 'road' || e.base === 'runway').map((e) => ({ ...e, sx: e.x - world.size.x / 2, sz: -(e.y - world.size.y / 2), radius: Number(e.props.radius) || 60, heading: -(Number(e.props.heading) || 0), length: Number(e.props.length) || 100, width: Number(e.props.width) || 12 }));
        const avoid = world.entities.filter((e) => e.z < 5).map((e) => ({ x: e.x - world.size.x / 2, z: -(e.y - world.size.y / 2), r: e.base === 'lake' ? (Number(e.props.radius) || 60) : e.cls === 'building' ? 25 : 0 }));
        env.buildGround({ size: world.size, seed: world.seed, entities: lakeEntities, avoid });
      }
      const ss = world.entities.filter((e) => FIXED_KINDS.has(e.base)).map((e) => `${e.id}:${modelKey(e.kind, e.props, e.id)}:${e.x}:${e.y}:${e.props.heading || 0}`).join(',');
      if (ss !== staticSig) { staticSig = ss; rebuildStatic(); }
      tickFrom = firstWorld ? world.tick : prevTick; tickTo = world.tick;
      syncMovers(duration);
      syncOrbits();
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
    view: () => mode,
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
      glow.dispose(); renderer.dispose(); canvas.remove(); hud.remove();
    }
  };
}

function hasWebGL() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
}

export async function createSandboxScene(container, { reducedMotion = false, coarse = false, threeUrl = '/vendor/three/three.module.min.js', onSelect = null } = {}) {
  if (!reducedMotion && hasWebGL()) {
    try { const s = await create3d(container, { coarse, threeUrl, onSelect }); if (s) return s; } catch (e) { if (typeof console !== 'undefined') console.warn('[sandbox] 3D view unavailable:', e && e.message); }
  }
  return create2d(container, { onSelect });
}
