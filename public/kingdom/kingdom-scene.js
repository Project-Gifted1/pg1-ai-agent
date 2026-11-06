// PG1 City (Kingdom Defence): the live 3D view of PG1 defending its Command
// Centre, a near-future city at dusk, driven only by real events from
// /api/defense-feed.
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
//              shadows or reflections (baked hemisphere light), emissive
//              windows only, fewer instanced buildings, gradient sky, 30 fps
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
import { buildWorld, RIVER, HERO_BEARING, TOWER_TOP } from './kingdom-world.js';
import { createActors } from './kingdom-actors.js';
import { createLife } from './kingdom-life.js';
import { loadBrand, BRAND_SVG_URL } from './kingdom-emblem.js';
import { dublinSun, daylight, pickDirectorEvent, normalizeState, windowRatios, dublinHour, dayWeather, GADGET_META } from './kingdom-data.js';

// The hero look: golden hour, the sun low in the west behind the tower.
export const DUSK_SUN = Object.freeze({ elevation: 0.035, azimuth: (262 * Math.PI) / 180 });
export const LIGHT_MODES = Object.freeze(['dusk', 'live']);
// The tallest building round the centre is lower than this (kingdom-world.js).
// The camera keeps at least this far from any building's box (metres).
export const CAMERA_CLEARANCE = 6;

// A camera position clear of every building: if the camera, or the line
// from it to what it looks at, passes through a building's box, the
// position is lifted above that building (plus the clearance). Pure, for
// the tests: obstacles is kingdom-world.js makeObstacleIndex.
export function clearCamera(cam, target, obstacles, clearance = CAMERA_CLEARANCE) {
  let y = cam.y;
  for (let k = 0; k <= 6; k++) {
    const t = 0.35 + (k / 6) * 0.65;
    const px = target.x + (cam.x - target.x) * t; const pz = target.z + (cam.z - target.z) * t; const py = target.y + (y - target.y) * t;
    const b = obstacles.hit(px, py, pz, clearance);
    if (b) { const need = target.y + ((b.top + clearance) - target.y) / t; if (need > y) y = need; }
  }
  return y;
}
// The default view: an aerial angle from the east, the river leading the eye to the tower.
// The hero shot: low along the river from the east, towards the PG1 Tower.
export const HOME_VIEW = Object.freeze({ target: [0, 135, 0], dist: 640, theta: HERO_BEARING, phi: 1.38 });
// On a phone the overlays cover the top of the view: aim higher and stand
// further back, so the whole tower sits below them.
export const HOME_VIEW_PHONE = Object.freeze({ target: [0, 150, 0], dist: 570, theta: HERO_BEARING, phi: 1.37 });
// No emblem may come nearer the camera than this in the hero shot (metres).
export const EMBLEM_CLEARANCE = 150;

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
    balanced: { shadows: 1024, post: { aa: 'smaa', bloom: true, gtao: true, dof: false }, water: true, sky: 'physical', crowdCap: 400, perEvent: 30, shafts: false, rain: true, targetFps: 60, pixelRatio: 1.5 },
    cinematic: { shadows: coarse ? 1024 : 2048, post: { aa: 'smaa', bloom: true, gtao: true, dof: false }, water: true, sky: 'physical', crowdCap: 800, perEvent: 60, shafts: true, rain: true, targetFps: 60, pixelRatio: 2 }
  }[tier] || null;
  return Object.freeze({ tier, ...base, ease: v ? v.ease : 5 });
}

// Height fog: the scene's exponential fog, thicker low down (blue hour),
// only for materials that define PG1_HEIGHT_FOG (the city's), so other
// three.js views on the page are untouched.
let heightFogPatched = false;
function patchHeightFog(THREE) {
  if (heightFogPatched) return;
  heightFogPatched = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = C.fog_pars_vertex.replace('#ifdef USE_FOG', '#ifdef USE_FOG\n#ifdef PG1_HEIGHT_FOG\nvarying float vPg1FogY;\n#endif');
  C.fog_vertex = C.fog_vertex.replace('#ifdef USE_FOG', `#ifdef USE_FOG
    #ifdef PG1_HEIGHT_FOG
      vec4 pg1Fw = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        pg1Fw = instanceMatrix * pg1Fw;
      #endif
      vPg1FogY = (modelMatrix * pg1Fw).y;
    #endif`);
  C.fog_pars_fragment = C.fog_pars_fragment.replace('#ifdef USE_FOG', '#ifdef USE_FOG\n#ifdef PG1_HEIGHT_FOG\nvarying float vPg1FogY;\n#endif');
  C.fog_fragment = C.fog_fragment.replace('gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );', `#ifdef PG1_HEIGHT_FOG
      fogFactor = clamp(fogFactor * (0.55 + 0.9 * exp(-max(vPg1FogY, 0.0) / 120.0)), 0.0, 1.0);
    #endif
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );`);
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
    // A still drawing of PG1 City: the skyline at dusk, the river, the tower.
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, level === 'storm' ? '#141a26' : '#1b2a4a'); sky.addColorStop(0.62, level === 'storm' ? '#3a3f4a' : '#e08a52'); sky.addColorStop(1, '#2a2d32');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const base = h * 0.66;
    for (let i = 0; i < 70; i++) { const bw = w * (0.02 + rnd() * 0.04); const bx = rnd() * w; const bh = h * (0.05 + rnd() * 0.25) * (1 - Math.abs(bx - cx) / w); g.fillStyle = '#1d2733'; g.fillRect(bx, base - bh, bw, bh); g.fillStyle = 'rgba(255,200,130,0.55)'; for (let k = 0; k < bh / (6 * dpr); k++) if (rnd() < 0.4) g.fillRect(bx + bw * 0.3, base - bh + k * 6 * dpr, Math.max(1, bw * 0.15), 2 * dpr); }
    g.fillStyle = '#2a4a68'; g.beginPath(); g.moveTo(cx - w * 0.03, base); g.lineTo(cx, base - h * 0.5); g.lineTo(cx + w * 0.03, base); g.closePath(); g.fill();
    g.fillStyle = '#f3c623'; g.beginPath(); g.arc(cx, base - h * 0.5, 3 * dpr, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#16324a'; g.fillRect(0, base + h * 0.04, w, h * 0.08);
    g.strokeStyle = '#d8dde3'; g.lineWidth = 2 * dpr; g.beginPath(); g.ellipse(cx, base + h * 0.06, w * 0.12, h * 0.05, 0, Math.PI, 0); g.stroke();
    const ids = Object.keys(GADGET_META);
    g.font = `${Math.round(11 * dpr)}px Inter, system-ui, sans-serif`; g.textAlign = 'center';
    ids.forEach((id, i) => {
      const x = (w / (ids.length + 1)) * (i + 1); const y = h - 30 * dpr; void R; void cy;
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
    focus() {}, setDirector() {}, director: () => false, tier: () => 'still', setTier() {}, onFrame() {}, caption: () => null, setState() {}, setDay() {}, setLight() {}, inspect: () => null,
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

async function create3d(container, { coarse, threeUrl, onFocus, onTier, onCaption, onGadget, tier: forced }) {
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
  scene.fog = new THREE.FogExp2(0x8a8aa2, 0.0009);
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 12000);
  const ADD = '/vendor/three/addons/';
  const ReflectorMod = settings.tier === 'cinematic' ? await import(`${ADD}objects/Reflector.js`).catch(() => null) : null;
  const normals = settings.water ? waterNormals(THREE) : null;
  const waterMaterial = settings.water ? createWaterMaterial(THREE, normals, [], { offset: false }) : null;
  patchHeightFog(THREE);
  // PG1's emblem comes from the brand asset itself; without it, no emblem (never a redraw).
  const brand = await loadBrand().catch(() => null);
  const world = buildWorld(THREE, scene, settings, { waterMaterial, Reflector: ReflectorMod ? ReflectorMod.Reflector : null, brand });
  // Blue-hour height fog on every material in the city (thicker low down).
  const fogDefine = (o) => { const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; for (const m of ms) if (!m.isShaderMaterial && !m.isSpriteMaterial && !m.isPointsMaterial && m.fog !== false && !(m.defines && m.defines.PG1_HEIGHT_FOG !== undefined)) { m.defines = { ...(m.defines || {}), PG1_HEIGHT_FOG: '' }; m.needsUpdate = true; } };
  scene.traverse(fogDefine);
  // The emblem's gold reflects a dusk sky on every tier (a small prefiltered
  // sky made in code; on Balanced and up the scene's sky also lights it).
  try {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
    const g = cv.getContext('2d'); const gr = g.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, '#1b2a52'); gr.addColorStop(0.45, '#6b6f9a'); gr.addColorStop(0.55, '#f2a35e'); gr.addColorStop(0.62, '#3a3440'); gr.addColorStop(1, '#14161c');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 128);
    g.fillStyle = 'rgba(255,230,180,0.9)'; g.beginPath(); g.ellipse(70, 68, 22, 6, 0, 0, Math.PI * 2); g.fill();
    const eq = new THREE.CanvasTexture(cv); eq.mapping = THREE.EquirectangularReflectionMapping; eq.colorSpace = THREE.SRGBColorSpace;
    const pm = new THREE.PMREMGenerator(renderer); const envTex = pm.fromEquirectangular(eq).texture; pm.dispose(); eq.dispose();
    for (const grp of world.emblemMeshes) grp.traverse((m) => { if (m.isMesh && m.material && m.material.isMeshPhysicalMaterial) { m.material.envMap = envTex; m.material.needsUpdate = true; } });
  } catch (e) { /* the scene's light is enough */ }
  const actors = createActors(THREE, scene, world, settings);
  actors.onFire = (g, e) => { if (onGadget) onGadget(g, e); };
  const life = createLife(THREE, scene, world, settings);

  // Image-based light from the sky (Balanced and up), refreshed every few minutes.
  let pmrem = null; let envRT = null; let envAt = -Infinity;
  const refreshEnv = () => {
    if (!settings.post || !world.sky) return;
    try {
      pmrem = pmrem || new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene(); const skyClone = world.sky.clone(); envScene.add(skyClone);
      const rt = pmrem.fromScene(envScene, 0.02, 0.1, 10000);
      if (envRT) envRT.dispose();
      envRT = rt; scene.environment = rt.texture; scene.environmentIntensity = 0.9;
    } catch (e) { /* the hemisphere light is enough */ }
  };

  // Rain (Balanced and up), only in a storm.
  let rain = null;
  if (settings.rain) {
    const n = settings.tier === 'cinematic' ? 6000 : 2500;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { p[i * 3] = (Math.random() - 0.5) * 700; p[i * 3 + 1] = Math.random() * 300; p[i * 3 + 2] = (Math.random() - 0.5) * 700; }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    rain = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xaab8c8, size: 0.8, transparent: true, opacity: 0, depthWrite: false }));
    rain.name = 'rain';
    scene.add(rain);
  }

  let post = null;
  const buildPost = async () => {
    if (post) { post.dispose(); post = null; }
    if (settings.post) post = await createPost(THREE, renderer, scene, camera, settings.post).catch(() => null);
  };
  await buildPost();

  // Camera: the viewer's orbit controls. By default a slow aerial flyover
  // (the river leading the eye to the tower); the director (on by default)
  // moves in close when an event plays, then pulls back.
  let focusId = null; let director = true; let lastCut = 0; let captionEvent = null; let lastLive = 0;
  container.dataset.director = 'on';
  const ndc = new THREE.Vector2();
  const controls = createControls(THREE, canvas, camera, {
    onTap(x, y) {
      ndc.set(x, y);
      const id = actors.pick(ndc, camera);
      if (id) { focus(id, { user: true }); }
    }
  });
  const HV = coarse ? HOME_VIEW_PHONE : HOME_VIEW;
  const home = new THREE.Vector3(...HV.target);
  controls.minDist = 30; controls.maxDist = 3000; controls.ease = settings.ease; controls.autoRotate = 0;
  controls.jumpTo({ target: home, dist: HV.dist, theta: HV.theta, phi: HV.phi });

  const events = new Map();
  function focus(id, { user = false } = {}) {
    focusId = id || null;
    if (user) setDirector(false);
    const e = id ? events.get(id) : null;
    captionEvent = e || null;
    container.dataset.focus = id || '';
    if (onFocus) onFocus(e || null);
    if (onCaption) onCaption(e || null);
    if (!id) { controls.flyTo({ target: home, dist: HV.dist, theta: HV.theta, phi: HV.phi }); actors.commanderTo(null); }
    else if (e && e.severity === 'high') { const p = actors.whereIs(id); if (p) actors.commanderTo(p); }
  }
  function setDirector(on) {
    director = !!on; lastCut = 0;
    container.dataset.director = director ? 'on' : 'off';
  }
  // Real Dublin time of day by default; dusk is the hero look (and Record mode's).
  let lightMode = 'live';
  container.dataset.light = lightMode;
  let weather = dayWeather(); let ambientAt = -Infinity;

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
  // A tier chosen by hand (remembered on this device) holds too.
  if (forced || KINGDOM_TIERS.includes(saved)) governor.setAuto(false);

  // The loop: paused while hidden; frame listeners (the recorder) after each frame.
  const frameFns = new Set();
  let raf = 0; let last = 0; let running = true; let t0 = performance.now(); let threat = 'calm'; let storm = 0;
  const sunDir = new THREE.Vector3();
  let camLift = 0; let camInside = 0; let paused = false;
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
    // Dusk (the hero look) or the live sun over Dublin.
    const sun = lightMode === 'live' ? dublinSun(Date.now()) : DUSK_SUN;
    sunDir.set(Math.sin(sun.azimuth) * Math.cos(sun.elevation), Math.sin(sun.elevation), -Math.cos(sun.azimuth) * Math.cos(sun.elevation)).normalize();
    const light = daylight(sun.elevation);
    const dusk = Math.max(0, 1 - Math.abs(sun.elevation - 0.06) / 0.2);
    storm += ((threat === 'storm' ? 1 : threat === 'watch' ? 0.3 : 0) - storm) * Math.min(1, dt * 0.25);
    world.update(dt, t, { sunDir, light, storm, dusk, fogColor: scene.fog.color });
    // Blue atmospheric haze, warmer at dusk, that fades the far city.
    scene.fog.color.setRGB(0.14 + 0.32 * light * (1 - dusk) + 0.08 * dusk, 0.19 + 0.36 * light * (1 - dusk) + 0.05 * dusk, 0.36 + 0.36 * light * (1 - dusk)).multiplyScalar(1 - storm * 0.4);
    scene.fog.density = 0.00055 + storm * 0.0008;
    renderer.toneMappingExposure = 0.62 + 0.3 * light * (1 - dusk);
    if (rain) { rain.material.opacity += ((storm > 0.6 || weather === 'rain' ? 0.45 : 0) - rain.material.opacity) * Math.min(1, dt); if (rain.material.opacity > 0.01) { const a = rain.geometry.attributes.position; for (let i = 1; i < a.array.length; i += 3) { a.array[i] -= dt * 60; if (a.array[i] < 0) a.array[i] += 120; } a.needsUpdate = true; rain.position.set(controls.target.x, 0, controls.target.z); } }
    if (now - envAt > 180000) { envAt = now; refreshEnv(); if (post && post.setNight) post.setNight(Math.max(dusk, 1 - light)); }
    actors.update(dt, t, camera, { storm });
    life.update(dt, t, { dark: Math.max(dusk, 1 - light), dusk, light });
    // Windows by the hour in Dublin, and the day's weather (scenery), every few seconds.
    if (now - ambientAt > 5000) {
      ambientAt = now;
      const hour = lightMode === 'dusk' ? 19.5 : dublinHour(Date.now());
      world.setWindowRatios(windowRatios(hour));
      weather = dayWeather(Date.now());
      world.setWet(weather === 'rain');
      container.dataset.windowHour = String(Math.floor(hour));
      container.dataset.weather = weather;
    }
    if (weather === 'mist') scene.fog.density += 0.00022;
    // Director: cut to the most important live event every few seconds.
    if (director && now - lastCut > DIRECTOR_CUT_MS) {
      lastCut = now;
      const live = actors.activeIds.map((id) => events.get(id)).filter(Boolean);
      const pick = pickDirectorEvent(live, Date.now(), { exclude: live.length > 1 ? focusId : null }) || (live.length ? live[0] : null);
      if (pick) lastLive = now;
      if (pick && pick.id !== focusId) focus(pick.id);
      // Nothing playing for a while: pull back to the aerial view.
      if (!pick && focusId && now - lastLive > 4000) focus(null);
    }
    if (focusId) {
      const p = actors.whereIs(focusId);
      // A close-up framed from outside: the clearance below keeps it out of buildings.
      if (p) { focusPoint.set(p.x, p.y + 4, p.z); controls.flyTo({ target: focusPoint, dist: coarse ? 150 : 130, phi: 0.95 }); }
    } else if (controls.userActive <= 0) {
      // The slow flyover: a gentle sway across the river axis.
      // A slow sway that keeps the sightline along the river (no building enters it).
      controls.goalTheta = HV.theta + 0.025 * Math.sin(t * 0.03);
    }
    controls.update(dt);
    // The camera never goes into or through a building: lifted clear of
    // every box on its line of sight, smoothly (but never left inside one).
    const needY = clearCamera(camera.position, controls.target, world.obstacles);
    camLift += (Math.max(0, needY - camera.position.y) - camLift) * Math.min(1, dt * 3);
    camera.position.y += camLift;
    const hardY = clearCamera(camera.position, controls.target, world.obstacles, 2);
    if (hardY > camera.position.y) camera.position.y = hardY;
    camera.lookAt(controls.target);
    if (world.obstacles.hit(camera.position.x, camera.position.y, camera.position.z, 0)) camInside++;
    if (post) post.render(false); else renderer.render(scene, camera);
    container.dataset.attackers = String(actors.attackers);
    if ((Number(container.dataset.frames) || 0) % 5 === 0) {
      container.dataset.fired = JSON.stringify(actors.fired);
      container.dataset.shield = world.domeMesh.visible ? 'visible' : 'hidden';
      container.dataset.sentinels = String(actors.sentinels);
      container.dataset.lanterns = String(actors.lanterns);
      container.dataset.pg1MaxR = String(Math.round(actors.pg1MaxR));
      container.dataset.commander = actors.commanderMode;
      container.dataset.camInside = String(camInside);
      // The weather has eased to the threat level (sky, fog and clouds).
      const stormGoal = threat === 'storm' ? 1 : threat === 'watch' ? 0.3 : 0;
      container.dataset.weatherSettled = Math.abs(storm - stormGoal) < 0.01 && (world.cloudLag || 0) < 0.01 ? 'yes' : 'no';
    }
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
    // For the tests: hold the camera on a view, and measure how noisy the
    // next frame is (mean absolute Laplacian of the luminance over the
    // central region, relative to its mean): window patterns that alias
    // into noise make it jump.
    // home(): back to the hero shot, held.
    home() { setDirector(false); focusId = null; controls.userActive = 1e9; controls.jumpTo({ target: home.clone(), dist: HV.dist, theta: HV.theta, phi: HV.phi }); },
    debugView({ target, dist, theta = HV.theta, phi = HV.phi }) { setDirector(false); focusId = null; controls.userActive = 1e9; controls.jumpTo({ target: new THREE.Vector3(...target), dist, theta, phi }); },
    sampleNoise() {
      return new Promise((resolve) => {
        const off = this.onFrame((cv) => {
          off();
          const w = cv.width; const h = cv.height;
          const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
          const g = c2.getContext('2d'); g.drawImage(cv, 0, 0);
          const x0 = Math.floor(w * 0.25); const y0 = Math.floor(h * 0.25); const rw = Math.floor(w * 0.5); const rh = Math.floor(h * 0.5);
          const d = g.getImageData(x0, y0, rw, rh).data;
          const L = new Float32Array(rw * rh);
          for (let i = 0; i < rw * rh; i++) L[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
          let hf = 0; let mean = 0; let n = 0;
          for (let y = 1; y < rh - 1; y++) for (let x = 1; x < rw - 1; x++) { const i = y * rw + x; hf += Math.abs(L[i] - (L[i - 1] + L[i + 1] + L[i - rw] + L[i + rw]) / 4); mean += L[i]; n++; }
          resolve({ hf: hf / n, mean: mean / n, rel: hf / Math.max(1e-6, mean) });
        });
      });
    },
    // While the feed is disconnected nothing new plays.
    setPaused(on) { paused = !!on; container.dataset.feedPaused = paused ? 'yes' : 'no'; },
    ingest(fresh, { perEventCap, live = false } = {}) {
      if (paused && live) return;
      for (const { event, delta } of fresh) {
        events.set(event.id, event);
        actors.stage(event, delta, { perEventCap: perEventCap || settings.perEvent });
      }
      if (events.size > 1500) { const keep = new Set(actors.activeIds); for (const id of events.keys()) { if (events.size <= 1000) break; if (!keep.has(id)) events.delete(id); } }
    },
    setThreat(level) { threat = ['calm', 'watch', 'storm'].includes(level) ? level : 'calm'; container.dataset.threat = threat; },
    setToday() { /* the legend shows the counts */ },
    // PG1's real state (the feed's state): the tower's beacon and emblems, sentinels, beacons.
    setState(raw) {
      const st = normalizeState(raw);
      const lit = world.setState(st);
      const n = actors.setSentinels(st.checks || 0);
      Object.assign(container.dataset, { beacon: st.beacon, seal: st.seal || 'none', passkeys: String(st.passkeys), signing: String(st.signing), beaconsLit: String(lit), sentinels: String(n) });
    },
    // Threats only: no payment figure is shown, so the bridge lanterns are just lamps.
    setDay() {},
    setLight(mode) { lightMode = LIGHT_MODES.includes(mode) ? mode : 'dusk'; container.dataset.light = lightMode; envAt = -Infinity; },
    // For the tests: what the scene holds (names only).
    inspect() {
      const names = new Set(); let unnamed = 0; let meshes = 0;
      scene.traverse((o) => { if (o.name) names.add(o.name); if (o.isMesh || o.isSprite || o.isPoints) { meshes++; if (!o.name) unnamed++; } });
      const brandFills = world.emblemMeshes.flatMap((g) => g.children.filter((m) => m.material && m.material.userData.brandFill).map((m) => m.material.userData.brandFill));
      return { names: [...names].sort(), unnamed, meshes, buildings: world.buildingCount, emblemSource: world.emblemMeshes.length ? BRAND_SVG_URL : null, brandFills: [...new Set(brandFills)], lifeColours: life.colours(), lifeCounts: life.counts(), billboard: world.billboardText };
    },
    // For the tests: where the crown emblem is on screen (CSS pixels), if in view.
    emblemScreen() {
      const g = world.emblemMeshes[0];
      if (!g) return null;
      const box = new THREE.Box3().setFromObject(g);
      const r = canvas.getBoundingClientRect();
      const pts = [];
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) { const v = new THREE.Vector3(x, y, z).project(camera); pts.push(v); }
      const ys = pts.map((v) => (1 - v.y) / 2 * r.height); const xs = pts.map((v) => (v.x + 1) / 2 * r.width);
      const inView = pts.every((v) => v.z < 1) && Math.max(...xs) > 0 && Math.min(...xs) < r.width && Math.max(...ys) > 0 && Math.min(...ys) < r.height;
      return { inView, height: Math.max(...ys) - Math.min(...ys), x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 };
    },
    setBillboards(stats) { world.setBillboards(stats); container.dataset.billboard = world.billboardText.join(' | '); },
    // For the tests: where the whole tower is on screen (CSS px, base and top).
    towerScreen() {
      const r = canvas.getBoundingClientRect();
      const p = (y) => { const v = new THREE.Vector3(0, y, 0).project(camera); return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, front: v.z < 1 }; };
      return { base: p(0), top: p(TOWER_TOP), width: r.width, height: r.height };
    },
    // Every emblem in the scene: how far it is from the camera, and whether it stands upright.
    emblems() {
      const out = []; const n = new THREE.Vector3(); const q = new THREE.Quaternion(); const wp = new THREE.Vector3();
      scene.traverse((o) => {
        if (!/^pg1-emblem/.test(o.name) || (o.parent && /^pg1-emblem/.test(o.parent.name))) return;
        o.getWorldPosition(wp); o.getWorldQuaternion(q);
        n.set(0, 0, 1).applyQuaternion(q);
        out.push({ name: o.name, y: wp.y, distance: wp.distanceTo(camera.position), upright: Math.abs(n.y) < 0.9, visible: o.visible });
      });
      return out;
    },
    // For the tests: colour statistics of a region of the next frame (fractions of the canvas).
    sampleRegion({ x0 = 0, x1 = 1, y0 = 0, y1 = 1 } = {}) {
      return new Promise((resolve) => {
        const off = this.onFrame((cv) => {
          off();
          const c2 = document.createElement('canvas'); c2.width = cv.width; c2.height = cv.height;
          const g = c2.getContext('2d'); g.drawImage(cv, 0, 0);
          const X0 = Math.floor(x0 * cv.width); const Y0 = Math.floor(y0 * cv.height); const W = Math.max(1, Math.floor((x1 - x0) * cv.width)); const H = Math.max(1, Math.floor((y1 - y0) * cv.height));
          const d = g.getImageData(X0, Y0, W, H).data; let red = 0; let sat = 0; const n = W * H;
          for (let i = 0; i < n; i++) { const r = d[i * 4] / 255; const gg = d[i * 4 + 1] / 255; const b = d[i * 4 + 2] / 255; const mx = Math.max(r, gg, b); const mn = Math.min(r, gg, b); if (r > 0.45 && r - Math.max(gg, b) > 0.22) red++; if (mx > 0.35 && mx - mn > 0.45) sat++; }
          resolve({ red: red / n, saturated: sat / n });
        });
      });
    },
    focus: (id) => focus(id, { user: true }),
    // The director cuts straight to a live arrival (it stays on).
    cutTo(id) { if (!director) return; lastCut = performance.now(); lastLive = lastCut; focus(id); },
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
      controls.dispose(); actors.dispose(); life.dispose();
      if (post) post.dispose();
      if (envRT) envRT.dispose(); if (pmrem) pmrem.dispose();
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
      renderer.dispose(); canvas.remove();
    }
  };
}

export async function createKingdomScene(container, { reducedMotion = false, coarse = false, threeUrl = '/vendor/three/three.module.min.js', onFocus = null, onTier = null, onCaption = null, onGadget = null, tier = null } = {}) {
  if (!reducedMotion) {
    try {
      const s = await create3d(container, { coarse, threeUrl, onFocus, onTier, onCaption, onGadget, tier });
      if (s) return s;
    } catch (e) { /* no WebGL: the 2D map */ }
  }
  return create2d(container);
}
