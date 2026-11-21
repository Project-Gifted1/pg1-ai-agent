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

import { TIER_SETTINGS, pickTier, createGovernor, createRenderScale, QUALITY_KEY, SHOWCASE, SHOWCASE_SETTINGS } from '../sandbox/quality.js';
import { createPost } from '../sandbox/post.js';
import { createControls } from '../sandbox/controls.js';
import { createWaterMaterial } from '../sandbox/water.js';
import { buildWorld, RIVER, HERO_BEARING, TOWER_TOP } from './kingdom-world.js';
import { createActors } from './kingdom-actors.js';
import { createLife } from './kingdom-life.js';
import { loadBrand, BRAND_SVG_URL } from './kingdom-emblem.js';
import { dublinSun, daylight, pickDirectorEvent, normalizeState, windowRatios, dublinHour, weatherLook, GADGET_META } from './kingdom-data.js';
import { createWeatherFx } from './kingdom-weather.js';
import { mergeStatic, simplifyInstances, createLegacyWatch } from './kingdom-legacy.js';
import { createProbe, startTier, tierFromProbe, readProbeCache, writeProbeCache } from '../sandbox/tier-probe.js';
import { createDebugOverlay } from '../sandbox/debug-overlay.js';

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

export const KINGDOM_TIERS = Object.freeze(['legacy', 'phone', 'balanced', 'cinematic']);
// On screen: Low, Medium, High (picked automatically) and Cinematic (by hand
// only). The ids stay as they were (a choice kept on a device still holds).
export const KINGDOM_TIER_LABEL = Object.freeze({ legacy: 'Low', phone: 'Medium', balanced: 'High', cinematic: 'Cinematic' });
// The shared probe's tiers (tier-probe.js) and the city's.
export const KINGDOM_FROM_AUTO = Object.freeze({ low: 'legacy', medium: 'phone', high: 'balanced' });
export const KINGDOM_TO_AUTO = Object.freeze({ legacy: 'low', phone: 'medium', balanced: 'high', cinematic: 'high' });
export const KINGDOM_PROBE_KEY = 'pg1_kingdom_probe';
// ?quality= in the address (the operator): low, medium, high or cinematic (or a tier's id).
export function kingdomTierFromParam(search) {
  let q = null; try { q = new URLSearchParams(search || '').get('quality'); } catch (e) { q = null; }
  if (!q) return null;
  if (KINGDOM_TIERS.includes(q)) return q;
  if (q === 'cinematic') return 'cinematic';
  return KINGDOM_FROM_AUTO[q] || null;
}
// How the city's starting tier is chosen, in order: the caller's (a test, a
// recording, a rebuild), ?quality= (the operator, this visit), a tier kept
// by hand, Low for an iPhone 8-class device, the last probe's pick on this
// device; else Low on a phone or a 4 GB device (Medium on a computer) and a
// short probe of real frames that may step up (tier-probe.js).
export function chooseKingdomStart({ forced = null, search = '', saved = null, cached = null, profile = {}, coarse = false, memory = 0 } = {}) {
  if (forced) return { tier: forced, source: 'caller', probe: false, held: true };
  const url = kingdomTierFromParam(search);
  if (url) return { tier: url, source: 'address', probe: false, held: true };
  if (KINGDOM_TIERS.includes(saved)) return { tier: saved, source: 'manual', probe: false, held: true };
  if (detectLegacy(profile)) return { tier: 'legacy', source: 'device', probe: false, held: false };
  if (cached && KINGDOM_FROM_AUTO[cached]) return { tier: KINGDOM_FROM_AUTO[cached], source: 'probe (kept)', probe: false, held: false };
  return { tier: KINGDOM_FROM_AUTO[startTier({ coarse, memory })], source: 'probe', probe: true, held: false };
}
// The Legacy phone tier's budgets (an iPhone 8: A11 GPU, about 2 GB of RAM,
// Safari on iOS 16), checked by tests/browser/kingdom-city.browser.test.mjs.
export const LEGACY_BUDGET = Object.freeze({ drawCalls: 150, triangles: 150000, maxTexture: 1024, gpuMemoryMB: 300, targetFps: 30 });
// Frame time that sends a tier down to Legacy when it holds this long.
export const LEGACY_DROP = Object.freeze({ ms: 1000 / 30 * 1.6, frames: 90 });

// Which tier a device starts on, before any frame is drawn. Legacy for an
// iPhone 8-class phone: iOS 16 (the last iOS an iPhone 8 runs), an iPhone
// with the 4.7-inch 375 x 667 screen, 2 GB of memory or less, or a slow GPU
// benchmark (gpuMs: lib time to draw the benchmark, -1 if not run).
export function detectLegacy({ userAgent = '', screenW = 0, screenH = 0, memory = 0, gpuMs = -1, touch = false } = {}) {
  const ua = String(userAgent);
  const iphone = /iPhone/.test(ua);
  const ios = /(?:iPhone|iPad|iPod).*OS (\d+)_/.exec(ua);
  if (ios && Number(ios[1]) <= 16) return true;
  if (iphone && Math.min(screenW, screenH) === 375 && Math.max(screenW, screenH) === 667) return true;
  if (touch && memory > 0 && memory <= 2) return true;
  if (gpuMs >= 0 && gpuMs > 28) return true;
  return false;
}

export const PHONE_CINEMATIC_CITY = Object.freeze({ shadows: 1024, post: Object.freeze({ gtaoScale: 0.5, gtaoSamples: 8 }), crowdCap: 300, perEvent: 30, targetFps: 30, pixelRatio: 1.5, lifeScale: 0.55, renderScale: true });
export const KINGDOM_QUALITY_KEY = 'pg1_kingdom_quality';
export const DIRECTOR_CUT_MS = 6500;

// The viewer's tier -> the kingdom's.
export function kingdomTierOf(viewerTier) {
  if (viewerTier === 'low' || viewerTier === 'medium') return 'phone';
  if (viewerTier === 'high') return 'balanced';
  return 'cinematic';
}
const VIEWER_TIER = { legacy: 'low', phone: 'low', balanced: 'high', cinematic: 'ultra' };

// What each tier turns on (shadows: the shadow map's size, 0 for none).
export function kingdomSettings(tier, { coarse = false, memory = 0 } = {}) {
  const v = TIER_SETTINGS[VIEWER_TIER[tier] || 'high'];
  const base = {
    // The Legacy phone tier: no post-processing, shadows, reflections or
    // volumetrics; baked shading; instanced everything; a short far plane in
    // thicker haze; simple instanced rain and wet-road roughness; textures
    // capped at 1024 px; life and weather density cut down; 30 fps.
    legacy: { shadows: 0, post: null, water: false, sky: 'gradient', crowdCap: 80, perEvent: 8, shafts: false, rain: true, targetFps: 30, pixelRatio: 1, lifeScale: 0.3, weatherScale: 0.3, maxTexture: LEGACY_BUDGET.maxTexture, far: 2600, legacy: true },
    phone: { shadows: 0, post: null, water: false, sky: 'gradient', crowdCap: 150, perEvent: 12, shafts: false, rain: false, targetFps: 30, pixelRatio: 1.25 },
    balanced: { shadows: 1024, post: { aa: 'smaa', bloom: true, gtao: true, dof: false }, water: true, sky: 'physical', crowdCap: 400, perEvent: 30, shafts: false, rain: true, targetFps: 60, pixelRatio: 1.5 },
    cinematic: { shadows: coarse ? 1024 : 2048, post: { aa: 'smaa', bloom: true, gtao: true, dof: false }, water: true, sky: 'physical', crowdCap: 800, perEvent: 60, shafts: true, rain: true, targetFps: 60, pixelRatio: 2 }
  }[tier] || null;
  // Cinematic on a phone (a Galaxy A07 class GPU): the same look at 30 fps.
  // Kept: soft shadows, bloom, ambient occlusion, SMAA, the water shader and
  // the physical sky. Changed: occlusion at half resolution with 8 samples,
  // 1.5x pixels at most (the render scale lowers them while frames run
  // slow), smaller crowds and a little less ambient life.
  if (tier === 'cinematic' && coarse && base) Object.assign(base, PHONE_CINEMATIC_CITY, { post: { ...base.post, ...PHONE_CINEMATIC_CITY.post } });
  // 4 GB or less (the Galaxy A07): no ambient occlusion (its pass draws the whole city again).
  if (tier === 'cinematic' && coarse && memory && memory <= 4 && base) base.post = { ...base.post, gtao: false };
  return Object.freeze({ tier, ...base, ease: v ? v.ease : 5 });
}

// SHOWCASE (scripts/showcase-render.mjs): the offline profile, on a computer
// only, never chosen by the probe, the governor or Auto (it is not one of
// KINGDOM_TIERS). Cinematic's city with the viewer's Showcase post-processing
// (quality.js SHOWCASE_SETTINGS: 32 occlusion samples, TAA settled per
// frame, depth of field), 4096 shadows, the planar river mirror, the full
// crowds, and no render scale: each frame takes as long as it needs.
export function kingdomShowcaseSettings({ coarse = false } = {}) {
  if (coarse) return null;
  const c = kingdomSettings('cinematic', { coarse: false });
  const S = SHOWCASE_SETTINGS;
  return Object.freeze({ ...c, shadows: S.shadowMapSize, post: Object.freeze({ aa: 'taa', taaSamples: S.taaSamples, settle: true, bloom: true, gtao: true, gtaoSamples: S.gtaoSamples, gtaoScale: 1, dof: true, grade: 'night' }), fogScale: S.fogScale, targetFps: S.targetFps, pixelRatio: S.pixelRatio, renderScale: false, profile: SHOWCASE, ease: S.ease });
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

async function create3d(container, { coarse, threeUrl, onFocus, onTier, onCaption, onGadget, tier: forcedTier, auto: rebuiltAuto = false, onRebuild = null, onContextLost = null, showcase = false }) {
  const THREE = await import(threeUrl);
  const canvas = document.createElement('canvas');
  canvas.className = 'kingdom-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  let saved = null;
  try { saved = localStorage.getItem(KINGDOM_QUALITY_KEY); } catch (e) { saved = null; }
  const memory = navigator.deviceMemory || 0;
  let probeStore = null; try { probeStore = localStorage; } catch (e) { probeStore = null; }
  const profile = { userAgent: navigator.userAgent, screenW: (window.screen && window.screen.width) || 0, screenH: (window.screen && window.screen.height) || 0, memory, touch: !!coarse };
  // A rebuild the probe or the governor asked for stays automatic.
  const begin = rebuiltAuto && forcedTier
    ? { tier: forcedTier, source: 'auto', probe: !(probeStore && readProbeCache(probeStore, KINGDOM_PROBE_KEY)), held: false }
    : chooseKingdomStart({ forced: forcedTier, search: location.search, saved, cached: probeStore ? readProbeCache(probeStore, KINGDOM_PROBE_KEY) : null, profile, coarse, memory });
  // Showcase: asked for by name, never on a phone; it holds its tier.
  const offline = showcase ? kingdomShowcaseSettings({ coarse }) : null;
  if (offline) { begin.tier = 'cinematic'; begin.source = SHOWCASE; begin.probe = false; begin.held = true; }
  let tier = begin.tier;
  const forced = begin.held;
  container.dataset.tierSource = begin.source;
  let settings = offline || kingdomSettings(tier, { coarse, memory });
  if (offline) container.dataset.profile = SHOWCASE;
  let renderer;
  try {
    // Low and Medium have no post-processing, so they take the GPU's own
    // multisampling: on a tile-based phone GPU (Mali, Adreno, Apple) it is
    // resolved on the chip for little cost, and edges no longer crawl.
    renderer = new THREE.WebGLRenderer({ canvas, antialias: !settings.post, alpha: false, powerPreference: 'high-performance' });
  } catch (e) {
    return null;
  }
  container.appendChild(canvas);
  container.dataset.renderer = 'webgl';
  container.dataset.tier = offline ? SHOWCASE : tier;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Count every pass of a frame (post-processing renders several times).
  renderer.info.autoReset = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = !!settings.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x8a8aa2, 0.0009);
  const camera = new THREE.PerspectiveCamera(42, 1, 1, settings.far || 12000);
  // Legacy: a nearer far plane, hidden in thicker haze (distance culling).
  const fogBase = settings.legacy ? 0.0011 : 0.00055;
  const ADD = '/vendor/three/addons/';
  // The river's planar mirror draws the whole city a second time: a
  // computer's Cinematic only (a phone's has the water shader, as High).
  const ReflectorMod = settings.tier === 'cinematic' && !settings.renderScale ? await import(`${ADD}objects/Reflector.js`).catch(() => null) : null;
  const normals = settings.water ? waterNormals(THREE) : null;
  const waterMaterial = settings.water ? createWaterMaterial(THREE, normals, [], { offset: false }) : null;
  patchHeightFog(THREE);
  // PG1's emblem comes from the brand asset itself; without it, no emblem (never a redraw).
  const brand = await loadBrand().catch(() => null);
  // Showcase: the look module, a night HDRI for light and reflections, and
  // PBR detail for the masonry (CC0 assets, docs/assets-licences.md).
  const showLook = offline ? await import('../sandbox/showcase-look.js') : null;
  const [hdri, asphalt, facadeDetail] = showLook ? await Promise.all([
    showLook.loadHdri(THREE, renderer, 'modern_buildings_night').catch(() => null),
    showLook.loadPbr(THREE, 'asphalt_02').catch(() => null),
    showLook.loadPbr(THREE, 'concrete_tile_facade').catch(() => null)
  ]) : [];
  const world = buildWorld(THREE, scene, settings, { waterMaterial, Reflector: ReflectorMod ? ReflectorMod.Reflector : null, brand, detail: facadeDetail ? facadeDetail.normalMap : null });
  // Mirrors drawn once a frame, not once per TAA sample.
  const mirrors = [];
  if (offline && world.mirror) mirrors.push(showLook.oncePerFrame(world.mirror));
  // Rain-wet streets: a rippled, puddled mirror over the ground on both banks.
  let wetGround = null;
  if (offline && ReflectorMod && asphalt) {
    wetGround = new THREE.Group(); wetGround.name = 'showcase-wet-streets';
    for (const [z0, z1] of [[-2200, RIVER.z - RIVER.half - 2], [RIVER.z + RIVER.half + 2, 2200]]) {
      const m = showLook.createWetGround(THREE, ReflectorMod.Reflector, { width: 4400, depth: z1 - z0, y: 0.09, textureWidth: 1080, textureHeight: 1080, normalMap: asphalt.normalMap, roughnessMap: asphalt.roughnessMap });
      m.position.z = (z0 + z1) / 2; wetGround.add(m); mirrors.push(m);
    }
    wetGround.visible = false; scene.add(wetGround);
  }
  for (const m of mirrors) m.userData.camera = camera;
  if (hdri) { scene.environment = hdri; scene.environmentIntensity = 0.12; }
  // Showcase renders keep payments out of the picture: no toll gantry (x402) on the bridge.
  if (offline) world.setBillboards({ brandOnly: true });
  // Showcase: the floating hologram reads as a faint second shield above the
  // crown's emblem, and the river's fixed light streaks turn into stray lines
  // seen along the river (the mirror and the wet streets reflect for real).
  if (offline) for (const n of ['pg1-emblem-hologram', 'river-light-streaks']) { const o = scene.getObjectByName(n); if (o) o.removeFromParent(); }
  if (offline && world.toll) { world.toll.visible = false; world.toll.traverse((o) => { o.visible = false; }); world.toll.removeFromParent(); }
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
  // Showcase: the hero car model (public/showcase/models/car.glb) in place of the box cars.
  if (offline) {
    const car = await showLook.loadHero('car').catch(() => null);
    const bodies = scene.getObjectByName('car-bodies'); const cabs = scene.getObjectByName('car-cabins');
    const part = (n) => { let g = null; if (car) car.traverse((o) => { if (o.isMesh && o.name === n) g = o.geometry; }); return g; };
    if (bodies && part('body')) { bodies.geometry = part('body'); bodies.material.vertexColors = true; bodies.material.needsUpdate = true; }
    if (cabs && part('glass')) { cabs.geometry = part('glass'); cabs.material.roughness = 0.05; cabs.material.needsUpdate = true; }
  }
  // Showcase: soft light cones ahead of every car's headlights (copied from the headlight instances).
  let cones = null; let headMesh = null;
  if (offline) {
    headMesh = scene.getObjectsByProperty('name', 'car-lights')[0] || null;
    if (headMesh) { cones = showLook.createHeadlightCones(THREE, headMesh.instanceMatrix.count); scene.add(cones); }
  }

  // Image-based light from the sky (Balanced and up), refreshed every few minutes.
  let pmrem = null; let envRT = null; let envAt = -Infinity;
  const refreshEnv = () => {
    if (!settings.post || !world.sky || hdri) return;
    try {
      pmrem = pmrem || new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene(); const skyClone = world.sky.clone(); envScene.add(skyClone);
      const rt = pmrem.fromScene(envScene, 0.02, 0.1, 10000);
      if (envRT) envRT.dispose();
      envRT = rt; scene.environment = rt.texture; scene.environmentIntensity = 0.9;
    } catch (e) { /* the hemisphere light is enough */ }
  };

  // The weather (decoration only): the real weather in Dublin from the feed.
  // The threat level never changes it, and it never changes a count.
  const wx = createWeatherFx(THREE, scene, world, settings);
  let look = weatherLook(null);
  // Legacy phone: static scenery merged by material, small high-poly instances as boxes.
  // Static scenery merged by material on every tier (fewer draw calls); on
  // Legacy phone, small high-poly instances are boxes too.
  { const m = mergeStatic(THREE, scene, undefined, undefined, { shadows: !!settings.shadows }); container.dataset.merged = `${m.removed}->${m.added}`; }
  if (settings.legacy) { const sv = simplifyInstances(THREE, scene); const m = mergeStatic(THREE, scene); container.dataset.legacyMerged = `${m.removed}->${m.added}`; container.dataset.legacySaved = String(sv.saved); }

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
  let ambientAt = -Infinity;

  // Size and quality. Cinematic on a phone draws fewer pixels while frames run
  // over 30 fps's budget (down to half), and more again when they recover.
  let renderScale = null;
  const resize = () => {
    const r = container.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)); const h = Math.max(1, Math.round(r.height));
    const pr = Math.min(settings.pixelRatio, window.devicePixelRatio || 1) * (settings.renderScale && renderScale ? renderScale.scale : 1);
    renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (post) post.setSize(w, h, pr);
  };
  const ensureScale = () => { if (settings.renderScale && !renderScale) renderScale = createRenderScale({ budgetMs: (1000 / settings.targetFps) * 1.15, min: 0.5, onChange: (sc) => { container.dataset.renderScale = String(sc); resize(); } }); if (!settings.renderScale) renderScale = null; };
  ensureScale();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  resize();

  // A lower tier in place: post-processing, shadows and resolution follow;
  // the crowds' size is kept (they were built for the starting tier) but
  // fewer new figures are staged per event.
  async function applyTier(next, { manual = false, probe = false } = {}) {
    if (!KINGDOM_TIERS.includes(next) || next === tier) return;
    // Into or out of Legacy: the city is rebuilt (density, textures, far plane).
    if ((next === 'legacy' || tier === 'legacy') && onRebuild) {
      if (manual) { try { localStorage.setItem(KINGDOM_QUALITY_KEY, next); } catch (e) { /* not remembered */ } }
      onRebuild(next, { manual, auto: probe });
      return;
    }
    tier = next; settings = kingdomSettings(tier, { coarse, memory });
    container.dataset.tier = tier;
    renderer.shadowMap.enabled = !!settings.shadows;
    world.sun.castShadow = !!settings.shadows;
    scene.traverse((o) => { if (o.material && o.material.needsUpdate !== undefined) o.material.needsUpdate = true; });
    ensureScale();
    await buildPost();
    resize();
    if (manual) { try { localStorage.setItem(KINGDOM_QUALITY_KEY, tier); } catch (e) { /* not remembered */ } }
    if (onTier) onTier(tier, { manual });
  }
  const governor = createGovernor({ tier: VIEWER_TIER[tier], budgetMs: 1000 / settings.targetFps, onChange: (vt, { manual }) => { if (!manual) applyTier(kingdomTierOf(vt)); } });
  // A tier chosen by the caller (a test, a recording) holds.
  // A tier chosen by hand (remembered on this device) holds too.
  if (forced) governor.setAuto(false);
  // The probe (automatic tiers only): render work timed over a few frames,
  // then the tier it says this device can hold (tier-probe.js), kept on the
  // device. Each frame's draw calls and triangles feed ?debug=1's overlay.
  let probeRun = begin.probe ? createProbe() : null;
  const probePx = new Uint8Array(4);
  // Bottom right, above the caption, clear of the HUD.
  const debug = createDebugOverlay(container, { at: 'right:8px;bottom:92px' });
  // ?debug=1 only: the renderer and scene, for looking into a frame from the console.
  if (debug && typeof window !== 'undefined') { window.__kingdomRenderer = renderer; window.__kingdomScene = scene; }
  const debugInfo = { calls: 0, triangles: 0, tier, source: begin.source, probeMs: null, scale: 1 };
  const onProbe = (r) => {
    container.dataset.probeMs = String(r.workMs); debugInfo.probeMs = r.workMs;
    const pick = KINGDOM_FROM_AUTO[tierFromProbe({ workMs: r.workMs, probed: KINGDOM_TO_AUTO[tier], coarse, memory })];
    if (probeStore) writeProbeCache(probeStore, KINGDOM_PROBE_KEY, KINGDOM_TO_AUTO[pick], Date.now(), r.workMs);
    container.dataset.probePick = pick;
    if (pick !== tier && governor.auto !== false) applyTier(pick, { probe: true });
  };

  // The loop: paused while hidden; frame listeners (the recorder) after each frame.
  const frameFns = new Set();
  let raf = 0; let last = 0; let running = true; let t0 = performance.now(); let threat = 'calm'; let storm = 0; let alarm = 0;
  const sunDir = new THREE.Vector3();
  let camLift = 0; let camInside = 0; let paused = false;
  const legacyWatch = createLegacyWatch(LEGACY_DROP);
  const lastInfo = { calls: 0, triangles: 0 };
  // WebGL context loss (a low-memory phone can lose it): stop drawing, show
  // the still map with the text feed, and rebuild one tier lower when the
  // context comes back. Never a crash.
  const onLost = (e) => { e.preventDefault(); running = false; if (raf) cancelAnimationFrame(raf); raf = 0; container.dataset.contextLost = 'yes'; if (onContextLost) onContextLost(); };
  const onRestored = () => { container.dataset.contextLost = 'restored'; if (onRebuild) onRebuild(KINGDOM_TIERS[Math.max(0, KINGDOM_TIERS.indexOf(tier) - 1)], { restored: true }); };
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);
  const focusPoint = new THREE.Vector3();
  // Showcase (scripts/showcase-render.mjs): one pose a frame { target, dist, theta, phi, fov?, focus? }.
  let showcasePose = null; const poseTarget = new THREE.Vector3();
  const frame = (now) => {
    raf = 0;
    if (!running) return;
    const budget = 1000 / settings.targetFps;
    if (now - last < budget - 2) { raf = requestAnimationFrame(frame); return; }
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0.016);
    if (last) { if (renderScale) renderScale.sample(now - last); governor.sample(now - last, budget); }
    // Frames that stay slow on the lowest ordinary tier: drop to Legacy phone.
    if (last && tier === 'phone' && !forced && governor.auto !== false && legacyWatch.sample(now - last)) { container.dataset.autoDrop = 'legacy'; applyTier('legacy'); }
    last = now;
    const t = (now - t0) / 1000;
    // Dusk (the hero look) or the live sun over Dublin.
    // The light always follows real Dublin time (or the chosen dusk); an unread weather only means a calm, clear sky.
    const sun = lightMode === 'live' ? dublinSun(Date.now()) : DUSK_SUN;
    sunDir.set(Math.sin(sun.azimuth) * Math.cos(sun.elevation), Math.sin(sun.elevation), -Math.cos(sun.azimuth) * Math.cos(sun.elevation)).normalize();
    const light = daylight(sun.elevation);
    const dusk = Math.max(0, 1 - Math.abs(sun.elevation - 0.06) / 0.2);
    // The sky's greyness follows the weather; the threat level only lights
    // PG1's own rovers (never the weather).
    storm += (look.dark - storm) * Math.min(1, dt * 0.25);
    alarm += ((threat === 'storm' ? 1 : threat === 'watch' ? 0.3 : 0) - alarm) * Math.min(1, dt * 0.5);
    world.update(dt, t, { sunDir, light, storm, cover: look.cover, wind: wx.state.wind, sunny: look.sun, dusk, fogColor: scene.fog.color });
    // Blue atmospheric haze, warmer at dusk, that fades the far city.
    scene.fog.color.setRGB(0.14 + 0.32 * light * (1 - dusk) + 0.08 * dusk, 0.19 + 0.36 * light * (1 - dusk) + 0.05 * dusk, 0.36 + 0.36 * light * (1 - dusk)).multiplyScalar(1 - storm * 0.4);
    scene.fog.density = (fogBase + storm * 0.0005 + look.fog * 0.0024) * (settings.fogScale || 1);
    renderer.toneMappingExposure = 0.7 + 0.22 * light * (1 - dusk);
    wx.update(dt, t, look, { target: controls.target, sunDir, light, dusk });
    world.setWet(wx.state.wet);
    if (now - envAt > 180000) { envAt = now; refreshEnv(); if (post && post.setNight) post.setNight(Math.max(dusk, 1 - light)); }
    actors.update(dt, t, camera, { storm: alarm });
    life.update(dt, t, { dark: Math.max(dusk, 1 - light), dusk, light, hour: lightMode === 'dusk' ? 19.5 : dublinHour(Date.now()), wet: wx.state.wet, rain: wx.state.rain, wind: wx.state.wind, external: actors.riverBoats ? actors.riverBoats() : [] });
    // Windows by the hour in Dublin, and the day's weather (scenery), every few seconds.
    if (now - ambientAt > 5000) {
      ambientAt = now;
      const hour = lightMode === 'dusk' ? 19.5 : dublinHour(Date.now());
      world.setWindowRatios(windowRatios(hour));
      container.dataset.windowHour = String(Math.floor(hour));
      container.dataset.weather = look.state;
      container.dataset.weatherSource = look.source;
    }
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
    // Showcase: the scripted camera's pose for this frame, exactly.
    if (showcasePose) {
      const p = showcasePose; poseTarget.set(p.target[0], p.target[1], p.target[2]);
      controls.jumpTo({ target: poseTarget, dist: p.dist, theta: p.theta, phi: p.phi }); controls.userActive = 0;
      if (p.fov && Math.abs(camera.fov - p.fov) > 1e-3) { camera.fov = p.fov; camera.updateProjectionMatrix(); }
    }
    controls.update(dt);
    if (showcasePose && post && post.setFocus) post.setFocus(showcasePose.focus === null ? null : showcasePose.focus || controls.dist);
    // The camera never goes into or through a building: lifted clear of
    // every box on its line of sight, smoothly (but never left inside one).
    const needY = clearCamera(camera.position, controls.target, world.obstacles);
    camLift += (Math.max(0, needY - camera.position.y) - camLift) * Math.min(1, dt * 3);
    camera.position.y += camLift;
    const hardY = clearCamera(camera.position, controls.target, world.obstacles, 2);
    if (hardY > camera.position.y) camera.position.y = hardY;
    camera.lookAt(controls.target);
    if (world.obstacles.hit(camera.position.x, camera.position.y, camera.position.z, 0)) camInside++;
    // Showcase: wet streets follow the rain, mirrors once a frame, the grain moves.
    if (offline) {
      for (const m of mirrors) m.userData.frame++;
      if (wetGround) { const wet = Math.min(1, wx.state.wet || 0); wetGround.visible = wet > 0.05; for (const m of wetGround.children) { m.material.uniforms.uWet.value = wet; m.material.uniforms.uTime.value = t; } }
      if (post && post.setTime) post.setTime(t);
      if (cones && headMesh) { cones.instanceMatrix.array.set(headMesh.instanceMatrix.array); cones.count = headMesh.count; cones.instanceMatrix.needsUpdate = true; cones.material.uniforms.uStrength.value = 0.05 + 0.1 * Math.min(1, wx.state.wet || 0) + 0.06 * (1 - light); }
    }
    renderer.info.reset();
    const timing = probeRun && !probeRun.done;
    const pt0 = timing ? performance.now() : 0;
    if (post) post.render(false); else renderer.render(scene, camera);
    if (timing) {
      // A one-pixel read-back waits for the GPU to finish: the frame's real cost.
      const gl = renderer.getContext(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probePx);
      const r = probeRun.sample(performance.now() - pt0);
      if (r) onProbe(r);
    }
    lastInfo.calls = renderer.info.render.calls; lastInfo.triangles = renderer.info.render.triangles;
    if (debug) { debugInfo.calls = lastInfo.calls; debugInfo.triangles = lastInfo.triangles; debugInfo.tier = KINGDOM_TIER_LABEL[tier]; debugInfo.scale = renderScale ? renderScale.scale : 1; debug.frame(now, debugInfo); }
    container.dataset.attackers = String(actors.attackers);
    if ((Number(container.dataset.frames) || 0) % 5 === 0) {
      container.dataset.fired = JSON.stringify(actors.fired);
      container.dataset.shield = world.domeMesh.visible ? 'visible' : 'hidden';
      container.dataset.sentinels = String(actors.sentinels);
      container.dataset.lanterns = String(actors.lanterns);
      container.dataset.pg1MaxR = String(Math.round(actors.pg1MaxR));
      container.dataset.commander = actors.commanderMode;
      container.dataset.camInside = String(camInside);
      // The sky has eased to the real weather (sky, fog and clouds).
      container.dataset.weatherSettled = Math.abs(storm - look.dark) < 0.01 && (world.cloudLag || 0) < 0.01 ? 'yes' : 'no';
      container.dataset.wet = wx.state.wet.toFixed(2);
    }
    container.dataset.frames = String((Number(container.dataset.frames) || 0) + 1);
    for (const fn of frameFns) { try { fn(canvas); } catch (e) { /* a listener never stops the view */ } }
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (!raf && running) { last = 0; raf = requestAnimationFrame(frame); } };
  const onVis = () => { if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; container.dataset.paused = 'yes'; } else { container.dataset.paused = 'no'; if (debug) debug.reset(); start(); } };
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
    // Showcase: the scripted camera (null gives it back; the director stays off meanwhile).
    setShowcasePose(p) { if (p) { setDirector(false); controls.minDist = Math.min(controls.minDist, p.dist); controls.maxDist = Math.max(controls.maxDist, p.dist); } showcasePose = p || null; },
    profile: () => (offline ? SHOWCASE : null),
    // Showcase: the grade's mood ('night', 'rain').
    setShowcaseLook({ mood } = {}) { if (post && post.setGrade && showLook) post.setGrade(mood, showLook); },
    showcaseInfo: () => (() => {
      const gl = renderer.getContext(); let unmasked = null;
      try { const ext = gl.getExtension('WEBGL_debug_renderer_info'); unmasked = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) { unmasked = null; }
      const nav = typeof navigator !== 'undefined' ? navigator : {};
      return { canvas: [canvas.width, canvas.height], drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], css: [window.innerWidth, window.innerHeight], dpr: window.devicePixelRatio || 1, tier: offline ? SHOWCASE : tier, tierSource: begin.source, profile: offline ? SHOWCASE : null, coarse: !!coarse, renderScale: renderScale ? renderScale.scale : 1, settingsPixelRatio: settings.pixelRatio, rendererPixelRatio: renderer.getPixelRatio(), governor: governor.auto ? 'on' : 'off', probe: probeRun && !probeRun.done ? 'on' : 'off', deviceMemory: nav.deviceMemory || 0, cores: nav.hardwareConcurrency || 0, touchPoints: nav.maxTouchPoints || 0, webglRenderer: unmasked, programs: renderer.info.programs ? renderer.info.programs.length : 0, textures: renderer.info.memory.textures };
    })(),
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
    // The real Dublin weather (the feed's weather), decoration only.
    setWeather(w) { look = weatherLook(w); container.dataset.weather = look.state; container.dataset.weatherSource = look.source; },
    // For the tests and Record mode's stills: hold the eased weather at its goal now.
    settleWeather() { storm = look.dark; world.settleClouds && world.settleClouds(look); wx.settle(look); world.setWet(wx.state.wet); },
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
      scene.traverse((o) => { if (o.name) names.add(o.name); if (o.userData && o.userData.mergedNames) for (const n of o.userData.mergedNames) names.add(n); if (o.isMesh || o.isSprite || o.isPoints) { meshes++; if (!o.name) unnamed++; } });
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
    // A tier by hand (kept on this device), or 'auto': forget it and the
    // last probe, and rebuild from the safe tier with a fresh probe.
    setTier: (t) => {
      if (t !== 'auto') return applyTier(t, { manual: true });
      try { localStorage.removeItem(KINGDOM_QUALITY_KEY); if (probeStore) probeStore.removeItem(KINGDOM_PROBE_KEY); } catch (e) { /* private mode */ }
      if (onRebuild) onRebuild(KINGDOM_FROM_AUTO[startTier({ coarse, memory })], { auto: true });
    },
    // For the tests and the budget check: what the last frame cost.
    stats() {
      let texBytes = 0; let maxTex = 0; const seen = new Set();
      let geoBytes = 0; const geos = new Set();
      scene.traverse((o) => {
        if (o.geometry && !geos.has(o.geometry)) { geos.add(o.geometry); for (const a of Object.values(o.geometry.attributes)) geoBytes += a.array.byteLength; if (o.geometry.index) geoBytes += o.geometry.index.array.byteLength; }
        if (o.isInstancedMesh) geoBytes += o.instanceMatrix.array.byteLength + (o.instanceColor ? o.instanceColor.array.byteLength : 0);
        const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of ms) for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'envMap', 'alphaMap']) {
          const t = m[k]; if (!t || seen.has(t) || !t.image) continue; seen.add(t);
          const w = t.image.width || 0; const h = t.image.height || 0; maxTex = Math.max(maxTex, w, h); texBytes += w * h * 4 * (t.generateMipmaps === false ? 1 : 1.34);
        }
      });
      const c = renderer.getContext(); const W = c.drawingBufferWidth; const H = c.drawingBufferHeight;
      const fbBytes = W * H * 4 * 3 + (settings.shadows ? settings.shadows * settings.shadows * 4 : 0);
      return { tier, label: KINGDOM_TIER_LABEL[tier], source: begin.source, probeMs: debugInfo.probeMs, calls: lastInfo.calls, triangles: lastInfo.triangles, textures: seen.size, maxTexture: maxTex, gpuMemoryMB: Math.round((texBytes + geoBytes + fbBytes) / 1048576), targetFps: settings.targetFps, pixelRatio: renderer.getPixelRatio(), life: life.counts(), weather: wx.counts() };
    },
    // For screenshots: the junction with the longest queue now.
    busiestJunction: () => life.traffic.busiest(),
    // For screenshots: the tallest towers near the centre (x, z, height, width).
    towers: () => world.roofSpots.filter((r) => r.ring === 'near').slice(0, 12).map((r) => ({ x: Math.round(r.x), z: Math.round(r.z), h: Math.round(r.h), w: Math.round(r.w) })),
    // For tuning: what each named object costs (renderables, triangles), largest first.
    costs() {
      const by = new Map();
      scene.traverse((o) => {
        if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
        let v = true; for (let p = o; p; p = p.parent) if (!p.visible) { v = false; break; }
        if (!v) return;
        const g = o.geometry; let tri = 0;
        if (g && o.isMesh) { const n = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0); tri = n / 3 * (o.isInstancedMesh ? o.count : 1); }
        const k = o.name || '(unnamed)'; const c = by.get(k) || { name: k, objects: 0, tris: 0 };
        c.objects++; c.tris += Math.round(tri); by.set(k, c);
      });
      return [...by.values()].sort((a, b) => b.objects - a.objects || b.tris - a.tris);
    },
    // For the tests: lose the WebGL context on purpose (and get it back).
    loseContext() { const ext = renderer.getContext().getExtension('WEBGL_lose_context'); if (ext) { ext.loseContext(); return ext; } return null; },
    onFrame(fn) { frameFns.add(fn); return () => frameFns.delete(fn); },
    caption: () => captionEvent,
    pause(on) { running = !on; if (on && raf) { cancelAnimationFrame(raf); raf = 0; } else start(); },
    destroy() {
      running = false; if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored);
      if (ro) ro.disconnect();
      controls.dispose(); actors.dispose(); life.dispose(); wx.dispose();
      if (post) post.dispose();
      if (envRT) envRT.dispose(); if (pmrem) pmrem.dispose();
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
      renderer.dispose(); canvas.remove();
    }
  };
}

// The scene the page holds: the 3D city, or the still 2D map. It survives
// a rebuild (into or out of Legacy, or after a lost WebGL context): the page
// keeps one object, and the last state set on it is set again.
export async function createKingdomScene(container, { reducedMotion = false, coarse = false, threeUrl = '/vendor/three/three.module.min.js', onFocus = null, onTier = null, onCaption = null, onGadget = null, tier = null, showcase = false } = {}) {
  if (reducedMotion) return create2d(container);
  let impl = null; let fallback = null; let rebuilding = null;
  const memo = new Map();
  const REPLAY = ['setThreat', 'setWeather', 'setState', 'setBillboards', 'setLight', 'setDirector', 'setToday', 'setDay', 'setPaused'];
  const frameFns = new Set();
  const showFallback = () => { if (!fallback) { fallback = create2d(container); container.dataset.renderer = 'webgl-lost'; for (const [k, a] of memo) if (fallback[k]) fallback[k](...a); } };
  const build = async (t, { auto = false } = {}) => {
    const s = await create3d(container, { coarse, threeUrl, onFocus, onTier, onCaption, onGadget, tier: t, auto, onRebuild, onContextLost: showFallback, showcase });
    if (!s) return null;
    for (const [k, a] of memo) { try { s[k](...a); } catch (e) { /* the next poll sets it again */ } }
    for (const fn of frameFns) s.onFrame(fn);
    return s;
  };
  async function onRebuild(next, { restored = false, auto = false } = {}) {
    if (rebuilding) return rebuilding;
    rebuilding = (async () => {
      const old = impl; impl = null;
      try { old.destroy(); } catch (e) { /* a lost context cannot be disposed cleanly */ }
      const s = await build(next, { auto }).catch(() => null);
      if (s) { impl = s; if (fallback) { fallback.destroy(); fallback = null; } if (onTier) onTier(s.tier(), { manual: false, rebuilt: true, restored }); }
      else showFallback();
      container.dataset.rebuilds = String((Number(container.dataset.rebuilds) || 0) + 1);
      rebuilding = null;
    })();
    return rebuilding;
  }
  try { impl = await build(tier); } catch (e) { impl = null; try { console.warn('[kingdom] 3D failed, showing the map:', e && e.message); } catch (e2) { /* no console */ } }
  if (!impl) return create2d(container);
  return new Proxy({}, {
    get(_, key) {
      if (key === 'onFrame') return (fn) => { frameFns.add(fn); const off = impl ? impl.onFrame(fn) : () => {}; return () => { frameFns.delete(fn); off(); }; };
      if (key === 'rebuilding') return rebuilding;
      if (key === 'renderer') return fallback && !impl ? '2d' : 'webgl';
      const cur = impl || fallback;
      // Mid-rebuild (a quality change, a restored context) there is no scene
      // for a moment: what the page sets then (the threat, the weather, the
      // light...) is kept and played onto the new scene when it is built,
      // never a "not a function" error when a feed update lands in that gap.
      if (!cur) return REPLAY.includes(key) ? (...args) => { memo.set(key, args); } : undefined;
      const v = cur[key];
      if (typeof v !== 'function') return v;
      return (...args) => { if (REPLAY.includes(key)) memo.set(key, args); return v.apply(cur, args); };
    }
  });
}
