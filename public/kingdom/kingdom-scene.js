// PG1 Kingdom Defence: the live 3D view of PG1 defending its Command
// Centre, driven only by real events from /api/defense-feed.
//
//   createKingdomScene(container, { reducedMotion, coarse, threeUrl, onFocus, onTier, onCaption })
//     -> { renderer: 'webgl' | '2d', ingest(fresh), setThreat(level),
//          setToday(counts), focus(id), setDirector(on), tier(), setTier(t),
//          canvas, onFrame(fn), caption(), destroy() }
//
// The engine is the Sandbox viewer's (public/sandbox/): the same three.js
// (/vendor/three/, never a CDN), its quality tiers and governor
// (quality.js), post-processing (post.js), camera controls (controls.js)
// and water shader (water.js). Three tiers here, each one of the viewer's:
//   phone      the viewer's Low/Medium: no post-processing, no real-time
//              shadows (baked: darker wall bases, blob shadows under every
//              figure), instanced low-detail crowds, gradient sky, 30 fps
//   balanced   the viewer's High: soft shadows, bloom, SMAA, the water
//              shader and the physical sky, 60 fps
//   cinematic  the viewer's Ultra/Cinematic: bigger shadows, ambient
//              occlusion (GTAO), light shafts, bigger crowds, 60 fps
// The governor steps down a tier when frames run slow; nothing steps up on
// its own. Rendering stops while the tab is hidden or the view is closed.
//
// When nothing happens, nothing is staged: the guardians patrol, the sea
// moves, the sun follows Dublin's. Every attacker, ship and gadget action
// comes from one real event passed to ingest().
//
// prefers-reduced-motion, or no WebGL: a still 2D map of the kingdom with
// today's count by each gadget; the text feed beside it carries the events.

import { TIER_SETTINGS, pickTier, createGovernor, QUALITY_KEY } from '../sandbox/quality.js';
import { createPost } from '../sandbox/post.js';
import { createControls } from '../sandbox/controls.js';
import { createWaterMaterial } from '../sandbox/water.js';
import { buildWorld, ISLAND_R } from './kingdom-world.js';
import { createActors } from './kingdom-actors.js';
import { dublinSun, daylight, pickDirectorEvent, GADGET_META } from './kingdom-data.js';

export const KINGDOM_TIERS = Object.freeze(['phone', 'balanced', 'cinematic']);
export const KINGDOM_TIER_LABEL = Object.freeze({ phone: 'Phone', balanced: 'Balanced', cinematic: 'Cinematic' });
export const KINGDOM_QUALITY_KEY = 'pg1_kingdom_quality';
export const DIRECTOR_CUT_MS = 6500;

// The viewer's tier -> the kingdom's.
export function kingdomTierOf(viewerTier) {
  if (viewerTier === 'low' || viewerTier === 'medium') return 'phone';
  if (viewerTier === 'high') return 'balanced';
  return 'cinematic';
}
const VIEWER_TIER = { phone: 'low', balanced: 'high', cinematic: 'ultra' };

// What each tier turns on (shadows: the shadow map's size, 0 for none).
export function kingdomSettings(tier, { coarse = false } = {}) {
  const v = TIER_SETTINGS[VIEWER_TIER[tier] || 'high'];
  const base = {
    phone: { shadows: 0, post: null, water: false, sky: 'gradient', crowdCap: 150, perEvent: 12, shafts: false, rain: false, targetFps: 30, pixelRatio: 1.25 },
    balanced: { shadows: 1024, post: { aa: 'smaa', bloom: true, gtao: false, dof: false }, water: true, sky: 'physical', crowdCap: 400, perEvent: 30, shafts: false, rain: true, targetFps: 60, pixelRatio: 1.5 },
    cinematic: { shadows: coarse ? 1024 : 2048, post: { aa: 'smaa', bloom: true, gtao: true, dof: false }, water: true, sky: 'physical', crowdCap: 800, perEvent: 60, shafts: true, rain: true, targetFps: 60, pixelRatio: 2 }
  }[tier] || null;
  return Object.freeze({ tier, ...base, ease: v ? v.ease : 5 });
}

// --- the 2D map (reduced motion, no WebGL) ---------------------------------------------------

function create2d(container) {
  const canvas = document.createElement('canvas');
  canvas.className = 'kingdom-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);
  container.dataset.renderer = '2d';
  let today = {}; let level = 'calm';
  const draw = () => {
    const r = container.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
    const g = canvas.getContext('2d');
    if (!g) return;
    const w = canvas.width; const h = canvas.height; const cx = w / 2; const cy = h / 2; const R = Math.min(w, h) * 0.4;
    g.fillStyle = level === 'storm' ? '#1a2230' : '#16324a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#5f8a3e'; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#2bb3b1'; g.lineWidth = R * 0.07; g.beginPath(); g.arc(cx, cy, R * 0.5, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#b9b2a3'; g.beginPath();
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; const x = cx + Math.sin(a) * R * 0.42; const y = cy - Math.cos(a) * R * 0.42; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.closePath(); g.fill();
    g.fillStyle = '#8d877b'; g.fillRect(cx - R * 0.08, cy - R * 0.08, R * 0.16, R * 0.16);
    g.fillStyle = '#f3c623'; g.beginPath(); g.arc(cx, cy, R * 0.04, 0, Math.PI * 2); g.fill();
    const ids = Object.keys(GADGET_META);
    g.font = `${Math.round(11 * dpr)}px Inter, system-ui, sans-serif`; g.textAlign = 'center';
    ids.forEach((id, i) => {
      const a = (i / ids.length) * Math.PI * 2;
      const x = cx + Math.sin(a) * R * 1.12; const y = cy - Math.cos(a) * R * 1.12;
      const n = today[id] || 0;
      g.fillStyle = '#' + GADGET_META[id].color.toString(16).padStart(6, '0');
      g.globalAlpha = n ? 1 : 0.45; g.beginPath(); g.arc(x, y, 5 * dpr, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ececee'; g.fillText(String(n), x, y + 17 * dpr); g.globalAlpha = 1;
    });
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
  if (ro) ro.observe(container);
  draw();
  return {
    renderer: '2d', canvas,
    ingest() { /* the text feed carries the events; the map shows the counts */ },
    setThreat(l) { level = l; container.dataset.threat = l; draw(); },
    setToday(c) { today = { ...c }; draw(); },
    focus() {}, setDirector() {}, director: () => false, tier: () => 'still', setTier() {}, onFrame() {}, caption: () => null,
    destroy() { if (ro) ro.disconnect(); canvas.remove(); }
  };
}

// --- the 3D scene ------------------------------------------------------------------------------

function waterNormals(THREE) {
  const N = 128; const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'); const img = g.createImageData(N, N);
  const waves = [[1, 0, 1.0], [0, 2, 0.7], [3, 1, 0.45], [-2, 3, 0.35], [5, -3, 0.2], [-6, -5, 0.15]];
  const h = (x, y) => waves.reduce((t, [a, b, k]) => t + k * Math.sin((a * x + b * y) * Math.PI * 2 / N + a * 1.3 + b * 0.7), 0);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = h(x + 1, y) - h(x - 1, y); const dy = h(x, y + 1) - h(x, y - 1);
    const l = Math.hypot(dx, dy, 2); const i = (y * N + x) * 4;
    img.data[i] = (-dx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (-dy / l * 0.5 + 0.5) * 255; img.data[i + 2] = (2 / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

async function create3d(container, { coarse, threeUrl, onFocus, onTier, onCaption, tier: forced }) {
  const THREE = await import(threeUrl);
  const canvas = document.createElement('canvas');
  canvas.className = 'kingdom-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  } catch (e) {
    return null;
  }
  let saved = null;
  try { saved = localStorage.getItem(KINGDOM_QUALITY_KEY); } catch (e) { saved = null; }
  const viewerSaved = (() => { try { return localStorage.getItem(QUALITY_KEY); } catch (e) { return null; } })();
  let tier = forced || (KINGDOM_TIERS.includes(saved) ? saved : kingdomTierOf(pickTier({ coarse, memory: navigator.deviceMemory || 0, cores: navigator.hardwareConcurrency || 0, saved: viewerSaved })));
  let settings = kingdomSettings(tier, { coarse });
  container.appendChild(canvas);
  container.dataset.renderer = 'webgl';
  container.dataset.tier = tier;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = !!settings.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xbcd0e0, 0.0011);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 9000);
  const ADD = '/vendor/three/addons/';
  const SkyMod = settings.sky === 'physical' ? await import(`${ADD}objects/Sky.js`).catch(() => null) : null;
  const normals = settings.water ? waterNormals(THREE) : null;
  const waterMaterial = settings.water ? createWaterMaterial(THREE, normals, [{ sx: 0, sz: 0, r: ISLAND_R - 6 }]) : null;
  const world = buildWorld(THREE, scene, settings, { normals, waterMaterial, Sky: SkyMod ? SkyMod.Sky : null });
  const actors = createActors(THREE, scene, world, settings);

  // Image-based light from the sky (Balanced and up), refreshed every few minutes.
  let pmrem = null; let envRT = null; let envAt = -Infinity;
  const refreshEnv = () => {
    if (!settings.post || !world.sky || !world.sky.material || !world.sky.material.uniforms || !world.sky.material.uniforms.sunPosition) return;
    try {
      pmrem = pmrem || new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene(); const skyClone = world.sky.clone(); envScene.add(skyClone);
      const rt = pmrem.fromScene(envScene, 0.02, 0.1, 10000);
      if (envRT) envRT.dispose();
      envRT = rt; scene.environment = rt.texture; scene.environmentIntensity = 0.55;
    } catch (e) { /* the hemisphere light is enough */ }
  };

  // Rain (Balanced and up), only in a storm.
  let rain = null;
  if (settings.rain) {
    const n = settings.tier === 'cinematic' ? 6000 : 2500;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { p[i * 3] = (Math.random() - 0.5) * 260; p[i * 3 + 1] = Math.random() * 120; p[i * 3 + 2] = (Math.random() - 0.5) * 260; }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    rain = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xaab8c8, size: 0.35, transparent: true, opacity: 0, depthWrite: false }));
    scene.add(rain);
  }

  let post = null;
  const buildPost = async () => {
    if (post) { post.dispose(); post = null; }
    if (settings.post) post = await createPost(THREE, renderer, scene, camera, settings.post).catch(() => null);
  };
  await buildPost();

  // Camera: the viewer's orbit controls; a slow cinematic orbit by default.
  let focusId = null; let director = false; let lastCut = 0; let captionEvent = null;
  const ndc = new THREE.Vector2();
  const controls = createControls(THREE, canvas, camera, {
    onTap(x, y) {
      ndc.set(x, y);
      const id = actors.pick(ndc, camera);
      if (id) { focus(id, { user: true }); }
    }
  });
  controls.minDist = 18; controls.maxDist = 1200; controls.ease = settings.ease; controls.autoRotate = 0.035;
  controls.jumpTo({ target: new THREE.Vector3(0, 8, 0), dist: coarse ? 300 : 240, theta: 0.9, phi: 1.12 });

  const events = new Map();
  function focus(id, { user = false } = {}) {
    focusId = id || null;
    if (user) setDirector(false);
    const e = id ? events.get(id) : null;
    captionEvent = e || null;
    container.dataset.focus = id || '';
    if (onFocus) onFocus(e || null);
    if (onCaption) onCaption(e || null);
    if (!id) controls.flyTo({ target: new THREE.Vector3(0, 8, 0), dist: 240 });
  }
  function setDirector(on) {
    director = !!on; lastCut = 0;
    container.dataset.director = director ? 'on' : 'off';
    controls.autoRotate = director ? 0.02 : 0.035;
  }

  // Size and quality.
  const resize = () => {
    const r = container.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)); const h = Math.max(1, Math.round(r.height));
    const pr = Math.min(settings.pixelRatio, window.devicePixelRatio || 1);
    renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (post) post.setSize(w, h, pr);
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  resize();

  // A lower tier in place: post-processing, shadows and resolution follow;
  // the crowds' size is kept (they were built for the starting tier) but
  // fewer new figures are staged per event.
  async function applyTier(next, { manual = false } = {}) {
    if (!KINGDOM_TIERS.includes(next) || next === tier) return;
    tier = next; settings = kingdomSettings(tier, { coarse });
    container.dataset.tier = tier;
    renderer.shadowMap.enabled = !!settings.shadows;
    world.sun.castShadow = !!settings.shadows;
    scene.traverse((o) => { if (o.material && o.material.needsUpdate !== undefined) o.material.needsUpdate = true; });
    await buildPost();
    resize();
    if (manual) { try { localStorage.setItem(KINGDOM_QUALITY_KEY, tier); } catch (e) { /* not remembered */ } }
    if (onTier) onTier(tier, { manual });
  }
  const governor = createGovernor({ tier: VIEWER_TIER[tier], budgetMs: 1000 / settings.targetFps, onChange: (vt, { manual }) => { if (!manual) applyTier(kingdomTierOf(vt)); } });
  // A tier chosen by the caller (a test, a recording) holds.
  if (forced) governor.setAuto(false);

  // The loop: paused while hidden; frame listeners (the recorder) after each frame.
  const frameFns = new Set();
  let raf = 0; let last = 0; let running = true; let t0 = performance.now(); let threat = 'calm'; let storm = 0;
  const sunDir = new THREE.Vector3();
  const focusPoint = new THREE.Vector3();
  const frame = (now) => {
    raf = 0;
    if (!running) return;
    const budget = 1000 / settings.targetFps;
    if (now - last < budget - 2) { raf = requestAnimationFrame(frame); return; }
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0.016);
    if (last) governor.sample(now - last, budget);
    last = now;
    const t = (now - t0) / 1000;
    // The real sun over Dublin.
    const sun = dublinSun(Date.now());
    sunDir.set(Math.sin(sun.azimuth) * Math.cos(sun.elevation), Math.sin(sun.elevation), -Math.cos(sun.azimuth) * Math.cos(sun.elevation)).normalize();
    const light = daylight(sun.elevation);
    storm += ((threat === 'storm' ? 1 : threat === 'watch' ? 0.3 : 0) - storm) * Math.min(1, dt * 0.25);
    world.update(dt, t, { sunDir, light, storm });
    scene.fog.color.setRGB(0.74 * light + 0.04, 0.82 * light + 0.05, 0.88 * light + 0.08).multiplyScalar(1 - storm * 0.4);
    scene.fog.density = 0.0011 + storm * 0.0016;
    if (rain) { rain.material.opacity += ((storm > 0.6 ? 0.55 : 0) - rain.material.opacity) * Math.min(1, dt); if (rain.material.opacity > 0.01) { const a = rain.geometry.attributes.position; for (let i = 1; i < a.array.length; i += 3) { a.array[i] -= dt * 60; if (a.array[i] < 0) a.array[i] += 120; } a.needsUpdate = true; rain.position.set(controls.target.x, 0, controls.target.z); } }
    if (now - envAt > 180000) { envAt = now; refreshEnv(); }
    actors.update(dt, t, camera);
    // Director: cut to the most important live event every few seconds.
    if (director && now - lastCut > DIRECTOR_CUT_MS) {
      lastCut = now;
      const live = actors.activeIds.map((id) => events.get(id)).filter(Boolean);
      const pick = pickDirectorEvent(live, Date.now(), { exclude: live.length > 1 ? focusId : null }) || (live.length ? live[0] : null);
      if (pick && pick.id !== focusId) focus(pick.id);
      if (!pick && focusId) focus(null);
    }
    if (focusId) {
      const p = actors.whereIs(focusId);
      if (p) { focusPoint.set(p.x, p.y + 2, p.z); controls.flyTo({ target: focusPoint, dist: Math.min(controls.goalDist, 90) }); }
    }
    controls.update(dt);
    if (post) post.render(false); else renderer.render(scene, camera);
    container.dataset.attackers = String(actors.attackers);
    container.dataset.frames = String((Number(container.dataset.frames) || 0) + 1);
    for (const fn of frameFns) { try { fn(canvas); } catch (e) { /* a listener never stops the view */ } }
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (!raf && running) { last = 0; raf = requestAnimationFrame(frame); } };
  const onVis = () => { if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; container.dataset.paused = 'yes'; } else { container.dataset.paused = 'no'; start(); } };
  document.addEventListener('visibilitychange', onVis);
  start();

  return {
    renderer: 'webgl', canvas,
    ingest(fresh, { perEventCap } = {}) {
      for (const { event, delta } of fresh) {
        events.set(event.id, event);
        actors.stage(event, delta, { perEventCap: perEventCap || settings.perEvent });
      }
      if (events.size > 1500) { const keep = new Set(actors.activeIds); for (const id of events.keys()) { if (events.size <= 1000) break; if (!keep.has(id)) events.delete(id); } }
    },
    setThreat(level) { threat = ['calm', 'watch', 'storm'].includes(level) ? level : 'calm'; container.dataset.threat = threat; },
    setToday() { /* the legend shows the counts */ },
    focus: (id) => focus(id, { user: true }),
    setDirector, director: () => director,
    tier: () => tier,
    setTier: (t) => applyTier(t, { manual: true }),
    onFrame(fn) { frameFns.add(fn); return () => frameFns.delete(fn); },
    caption: () => captionEvent,
    pause(on) { running = !on; if (on && raf) { cancelAnimationFrame(raf); raf = 0; } else start(); },
    destroy() {
      running = false; if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      if (ro) ro.disconnect();
      controls.dispose(); actors.dispose();
      if (post) post.dispose();
      if (envRT) envRT.dispose(); if (pmrem) pmrem.dispose();
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
      renderer.dispose(); canvas.remove();
    }
  };
}

export async function createKingdomScene(container, { reducedMotion = false, coarse = false, threeUrl = '/vendor/three/three.module.min.js', onFocus = null, onTier = null, onCaption = null, tier = null } = {}) {
  if (!reducedMotion) {
    try {
      const s = await create3d(container, { coarse, threeUrl, onFocus, onTier, onCaption, tier });
      if (s) return s;
    } catch (e) { /* no WebGL: the 2D map */ }
  }
  return create2d(container);
}
