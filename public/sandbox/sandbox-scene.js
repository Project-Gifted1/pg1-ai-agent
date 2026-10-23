// PG1 Sandbox viewer: one world as a 3D scene in the Living lab's style,
// built in code with three.js (served from /vendor/three/, never a CDN) and
// rendered in the browser: the phone does the work, the server only sends
// the world's data. Worlds are simulations; the screen around this says so.
//
//   createSandboxScene(container, { reducedMotion, coarse }) -> { update(world), destroy() }
//
// world: { size {x,y,z}, entities [{ id, kind, position {x,y,z} }] } as
// /api/sandbox op world returns it. Each entity is a glowing marker on the
// world's ground, coloured by its kind; markers glide to new positions after
// a step. Same rules as the Living lab: nothing flashes, 30 fps on phones and
// 60 on desktop, paused when off screen or the tab is hidden; with
// prefers-reduced-motion, or no WebGL, a still 2D map instead, redrawn only
// when the world changes.

const PALETTE = [0xf3c623, 0x36d1c4, 0x8f86ff, 0x3ddc84, 0xff9b7a, 0x7cc4ff, 0xffb300, 0xd98cff];
const MAX_MARKERS = 500;

export function kindColor(kind) {
  let h = 0;
  for (const ch of String(kind || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

export function normalizeWorld(w) {
  const world = w && typeof w === 'object' ? w : {};
  const s = world.size && typeof world.size === 'object' ? world.size : {};
  const size = { x: Math.max(1, Number(s.x) || 100), y: Math.max(1, Number(s.y) || 100), z: Math.max(0, Number(s.z) || 10) };
  const entities = (Array.isArray(world.entities) ? world.entities : []).filter((e) => e && typeof e.id === 'string').slice(0, MAX_MARKERS).map((e) => ({
    id: e.id.slice(0, 64), kind: String(e.kind || 'thing').slice(0, 32),
    x: Math.min(size.x, Math.max(0, Number(e.position && e.position.x) || 0)),
    y: Math.min(size.y, Math.max(0, Number(e.position && e.position.y) || 0)),
    z: Math.min(size.z, Math.max(0, Number(e.position && e.position.z) || 0))
  }));
  return { size, entities };
}

export function kindsOf(world) {
  const counts = new Map();
  for (const e of world.entities) counts.set(e.kind, (counts.get(e.kind) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => ({ kind, n, color: hex(kindColor(kind)) }));
}

// --- the 2D map -------------------------------------------------------------------------------

function create2d(container) {
  const canvas = document.createElement('canvas');
  canvas.className = 'living-lab-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);
  container.dataset.renderer = '2d';
  let world = normalizeWorld(null);
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
    g.fillStyle = '#141418'; g.fillRect(ox, oy, world.size.x * k, world.size.y * k);
    g.strokeStyle = '#26262b'; g.lineWidth = dpr;
    for (let i = 0; i <= 10; i++) {
      g.beginPath(); g.moveTo(ox + (world.size.x * k * i) / 10, oy); g.lineTo(ox + (world.size.x * k * i) / 10, oy + world.size.y * k); g.stroke();
      g.beginPath(); g.moveTo(ox, oy + (world.size.y * k * i) / 10); g.lineTo(ox + world.size.x * k, oy + (world.size.y * k * i) / 10); g.stroke();
    }
    const rad = Math.max(2.5 * dpr, Math.min(7 * dpr, k * 1.2));
    for (const e of world.entities) {
      g.fillStyle = hex(kindColor(e.kind));
      g.beginPath(); g.arc(ox + e.x * k, oy + (world.size.y - e.y) * k, rad, 0, Math.PI * 2); g.fill();
    }
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
  if (ro) ro.observe(container);
  return {
    renderer: '2d',
    update(next) { world = normalizeWorld(next); container.dataset.markers = String(world.entities.length); draw(); },
    destroy() { if (ro) ro.disconnect(); canvas.remove(); }
  };
}

// --- the 3D scene --------------------------------------------------------------------------------

function glowTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.3, 'rgba(255,255,255,0.55)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

async function create3d(container, { coarse, threeUrl }) {
  const THREE = await import(threeUrl);
  const canvas = document.createElement('canvas');
  canvas.className = 'living-lab-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: !coarse, alpha: false, powerPreference: 'low-power' }); } catch (e) { return null; }
  container.appendChild(canvas);
  container.dataset.renderer = 'webgl';
  const targetFps = coarse ? 30 : 60;
  renderer.setClearColor(0x0a0a0b, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0a0b, 0.018);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  const glow = glowTexture(THREE);
  const SPAN = 10; // the world's longer side, in scene units
  let world = normalizeWorld(null);
  let unit = SPAN / 100;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x141418, transparent: true, opacity: 0.92 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const grid = new THREE.GridHelper(1, 10, 0x36363c, 0x26262b);
  scene.add(grid);
  const markers = new Map(); // id -> { sprite, target: Vector3 }
  const toScene = (e) => new THREE.Vector3((e.x - world.size.x / 2) * unit, 0.12 + e.z * unit, -(e.y - world.size.y / 2) * unit);

  function layout() {
    unit = SPAN / Math.max(world.size.x, world.size.y);
    ground.scale.set(world.size.x * unit, world.size.y * unit, 1);
    grid.scale.set(world.size.x * unit, 1, world.size.y * unit);
  }
  function sync() {
    const seen = new Set();
    const size = Math.max(0.42, Math.min(0.8, unit * 4));
    for (const e of world.entities) {
      seen.add(e.id);
      let m = markers.get(e.id);
      const target = toScene(e);
      if (!m) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: kindColor(e.kind), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
        // A solid core inside the glow, so a marker reads on a small screen.
        const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffffff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
        dot.scale.setScalar(0.35);
        sprite.add(dot);
        sprite.position.copy(target);
        sprite.scale.setScalar(size);
        scene.add(sprite);
        m = { sprite, target };
        markers.set(e.id, m);
      }
      m.target = target;
      m.sprite.material.color.setHex(kindColor(e.kind));
    }
    for (const [id, m] of markers) if (!seen.has(id)) { scene.remove(m.sprite); m.sprite.traverse((o) => o.material && o.material.dispose()); markers.delete(id); }
    container.dataset.markers = String(markers.size);
  }

  // Drag to turn the view; it settles slowly when left alone.
  const view = { theta: 0.6, phi: 0.9, dist: 11, vt: 0, dragging: false, lastX: 0, idleFor: 0 };
  const onDown = (e) => { view.dragging = true; view.lastX = e.clientX; view.idleFor = 0; canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); };
  const onMove = (e) => { if (!view.dragging) return; view.vt = (e.clientX - view.lastX) * 0.005; view.lastX = e.clientX; };
  const onUp = () => { view.dragging = false; };
  canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp);

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
  function frame(now) {
    raf = 0;
    if (!running()) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    acc += dt; last = now;
    schedule();
    if (acc < 1 / targetFps - 0.002) return;
    const step = acc; acc = 0;
    const k = 1 - Math.exp(-step * 4);
    for (const m of markers.values()) m.sprite.position.lerp(m.target, k);
    view.idleFor += step;
    if (!view.dragging) { view.vt *= Math.exp(-step * 3); if (view.idleFor > 2) view.theta += step * 0.04; }
    view.theta += view.vt;
    camera.position.set(view.dist * Math.sin(view.phi) * Math.cos(view.theta), view.dist * Math.cos(view.phi), view.dist * Math.sin(view.phi) * Math.sin(view.theta));
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    container.dataset.frames = String((Number(container.dataset.frames) || 0) + 1);
  }
  function schedule() { if (!raf && running()) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  layout(); schedule();
  return {
    renderer: 'webgl',
    update(next) { world = normalizeWorld(next); layout(); sync(); schedule(); },
    destroy() {
      cancelAnimationFrame(raf); raf = 0;
      if (io) io.disconnect(); if (ro) ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      glow.dispose(); renderer.dispose(); canvas.remove();
    }
  };
}

function hasWebGL() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
}

export async function createSandboxScene(container, { reducedMotion = false, coarse = false, threeUrl = '/vendor/three/three.module.min.js' } = {}) {
  if (!reducedMotion && hasWebGL()) {
    try { const s = await create3d(container, { coarse, threeUrl }); if (s) return s; } catch (e) { /* the 2D map below */ }
  }
  return create2d(container);
}
