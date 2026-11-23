// PG1 City: how the live view looks on each tier, in one place.
//
// The Showcase stills (scripts/showcase-render.mjs) look premium; the live
// City on a budget phone (a Galaxy A07: 4 GB, a Mali-class GPU) looked
// blurry, grey-hazed and flat at night. On the A07, halving the resolution
// did not raise the frame rate: it is held back by effects, draw calls and
// geometry, not pixels. So the rules here are:
//   - sharpness first: on a phone the render scale never goes below
//     PHONE_MIN_SCALE (0.8); when frames run slow, effects are dropped
//     first (EFFECT_LADDER) and resolution last; a contrast-adaptive
//     sharpen runs after any upscale;
//   - Auto picks the tier that holds 30 fps at scale 1.0, and on a phone
//     never Cinematic (autoAllowed); the menu says Cinematic "may look
//     softer on this phone";
//   - the fog follows the real weather but the first FOG_CLEAR_M metres
//     stay clear: fog only builds in the distance (the Showcase fogScale
//     idea, liveFog);
//   - cheap Showcase features (LOOK_TABLE): the night colour grade, a
//     moonlit fill and stronger window glow, a small night HDRI, a
//     mirror-free wet street, facade normal detail on near buildings, each
//     with a switch per tier and its measured cost on the A07 profile
//     (docs/perf/city-a07-after.json, scripts/city-measure.mjs).
// None of this changes WHAT the City shows: the same real events, the same
// counts, payments hidden. Only how it looks.

export const PHONE_MIN_SCALE = 0.8;
export const FOG_CLEAR_M = 400;
// Fog never thicker than this (exp2 density per metre): the far city fades,
// it never disappears into a grey wall.
export const FOG_MAX_DENSITY = 0.001;
// The live fog's share of the real weather's fog (the Showcase used 0.45).
export const LIVE_FOG_SCALE = 0.6;

// The features, by tier (the city's tier ids: legacy = Low, phone = Medium,
// balanced = High, cinematic). Phone values apply on a coarse pointer
// (a phone or tablet); computer values otherwise.
//   grade      the Showcase colour grade (tone, night teal and orange) as a
//              final pass
//   sharpen    contrast-adaptive sharpening while upscaling to the screen
//   moon       a moonlit fill light at night (no shadows)
//   glow       stronger window glow at night (a uniform; free)
//   hdri       the night HDRI as the environment map, small, loaded lazily
//   wet        wet streets in rain: a rough, normal-mapped ground layer and
//              light streaks under lamps and headlights (no mirror)
//   facade     facade normal detail on near buildings only
// costMs: the measured cost of each on the A07 profile (Cinematic, night,
// rain, switched off on its own; SwiftShader milliseconds compare costs,
// they are not A07 frame times). Filled from docs/perf/city-a07-after.json.
export const LOOK_TABLE = Object.freeze({
  grade: Object.freeze({ phone: { legacy: false, phone: true, balanced: true, cinematic: true }, computer: { legacy: false, phone: true, balanced: true, cinematic: true } }),
  sharpen: Object.freeze({ phone: { legacy: false, phone: true, balanced: true, cinematic: true }, computer: { legacy: false, phone: true, balanced: true, cinematic: true } }),
  moon: Object.freeze({ phone: { legacy: true, phone: true, balanced: true, cinematic: true }, computer: { legacy: true, phone: true, balanced: true, cinematic: true } }),
  glow: Object.freeze({ phone: { legacy: true, phone: true, balanced: true, cinematic: true }, computer: { legacy: true, phone: true, balanced: true, cinematic: true } }),
  hdri: Object.freeze({ phone: { legacy: false, phone: true, balanced: true, cinematic: true }, computer: { legacy: false, phone: true, balanced: true, cinematic: true } }),
  wet: Object.freeze({ phone: { legacy: false, phone: true, balanced: true, cinematic: true }, computer: { legacy: false, phone: true, balanced: true, cinematic: true } }),
  facade: Object.freeze({ phone: { legacy: false, phone: false, balanced: true, cinematic: true }, computer: { legacy: false, phone: true, balanced: true, cinematic: true } })
});
export const LOOK_FEATURES = Object.freeze(Object.keys(LOOK_TABLE));

export function lookFor(tier, { coarse = false } = {}) {
  const side = coarse ? 'phone' : 'computer';
  const out = {};
  for (const f of LOOK_FEATURES) out[f] = !!(LOOK_TABLE[f][side][tier]);
  return Object.freeze(out);
}

// ?fx=-name,+name (only with ?debug=1): switch one feature or effect off or
// on, to measure what it costs (scripts/city-measure.mjs --fx). Names: the
// LOOK_FEATURES and gtao, shadows, bloom, water, fog, crowds, drones.
export const FX_NAMES = Object.freeze([...LOOK_FEATURES, 'gtao', 'shadows', 'bloom', 'water', 'fog', 'crowds', 'drones']);
export function parseFx(search) {
  let p = null;
  try { p = new URLSearchParams(search || ''); } catch (e) { return {}; }
  if (p.get('debug') !== '1') return {};
  const out = {};
  // Read raw: URLSearchParams would turn a '+' into a space.
  const raw = /[?&]fx=([^&]*)/.exec(String(search || ''));
  let list = '';
  try { list = raw ? decodeURIComponent(raw[1]) : ''; } catch (e) { list = ''; }
  for (const part of list.split(',')) {
    const m = /^([+-])([a-z]+)$/.exec(part.trim());
    if (m && FX_NAMES.includes(m[2])) out[m[2]] = m[1] === '+';
  }
  return out;
}
// The settings with ?fx= applied (a copy).
export function applyFx(settings, look, fx) {
  if (!fx || !Object.keys(fx).length) return { settings, look };
  const s = { ...settings, post: settings.post ? { ...settings.post } : null };
  const l = { ...look };
  for (const [k, on] of Object.entries(fx)) {
    if (k in l) l[k] = on;
    else if (k === 'gtao' && s.post) s.post.gtao = on;
    else if (k === 'bloom' && s.post) s.post.bloom = on;
    else if (k === 'shadows') s.shadows = on ? (s.shadows || 1024) : 0;
    else if (k === 'water') s.water = on;
    else if (k === 'fog') s.noFog = !on;
    else if (k === 'crowds') s.crowdCap = on ? s.crowdCap : 0;
    else if (k === 'drones') s.noDrones = !on;
  }
  return { settings: s, look: l };
}

// --- fog: clear foreground, haze only in the distance ----------------------------------

// The fog factor (0 clear .. 1 all fog) at distance d (metres) for an exp2
// density, with the first `start` metres clear: the same formula as the
// city's shader (kingdom-scene.js patchHeightFog, PG1_FOG_START).
export function fogFactorAt(d, density, start = FOG_CLEAR_M) {
  const x = Math.max(0, d - start) * density;
  return 1 - Math.exp(-x * x);
}

// The live fog density: the real weather's fog (and the storm's greyness),
// scaled and capped. fogBase: the tier's clear-air haze.
export function liveFog({ fogBase = 0.00055, storm = 0, fog = 0, scale = LIVE_FOG_SCALE } = {}) {
  const raw = fogBase + storm * 0.0005 + fog * 0.0024;
  return Math.min(FOG_MAX_DENSITY, raw * scale);
}

// --- sharpness and frame time -----------------------------------------------------------

// The render scale's lowest value: 0.8 on a phone (sharpness first), 0.5 on
// a computer as before.
export function minRenderScale({ coarse = false } = {}) {
  return coarse ? PHONE_MIN_SCALE : 0.5;
}

// Auto (the probe and the governor) may only choose a tier that holds 30 fps
// at scale 1.0. Phone Cinematic cannot on a budget phone (27 fps at scale
// 0.52 on a Galaxy A07), so on a phone Auto never picks it: it stays a
// choice by hand, marked in the menu.
export function autoAllowed(tier, { coarse = false } = {}) {
  if (coarse && tier === 'cinematic') return false;
  return ['legacy', 'phone', 'balanced', 'cinematic'].includes(tier);
}
export const CINEMATIC_PHONE_NOTE = 'may look softer on this phone';

// When frames run slow, what is given up, in order: effects first, then
// detail, resolution last (and never below minRenderScale on a phone).
export const EFFECT_LADDER = Object.freeze(['gtao', 'shadows', 'crowds', 'drones', 'far', 'hdri', 'scale']);

// Steps down EFFECT_LADDER while frames run over budget for a window of
// frames, and back up while they run well under it. Each step is one call
// to onStep(rung, on): on false = given up, true = restored. 'scale' is
// the last rung: the render scale takes over from there (createRenderScale,
// with min = minRenderScale).
export function createEffectLadder({ budgetMs = 1000 / 30, window = 30, rungs = EFFECT_LADDER, available = () => true, onStep = () => {} } = {}) {
  let level = 0; let n = 0; let sum = 0;
  const usable = () => rungs.filter((r) => r === 'scale' || available(r));
  return {
    get level() { return level; },
    get rung() { return usable()[level] || null; },
    get atScale() { return usable()[level] === 'scale'; },
    sample(ms) {
      if (!(ms > 0) || ms > 1000) return level;
      n++; sum += ms;
      if (n < window) return level;
      const avg = sum / n; n = 0; sum = 0;
      const list = usable();
      if (avg > budgetMs && list[level] !== 'scale') { onStep(list[level], false); level++; }
      else if (avg < budgetMs * 0.6 && level > 0 && list[level] !== 'scale') { level--; onStep(list[level], true); }
      return level;
    },
    // The render scale is back at 1: effects may come back.
    release() { if (usable()[level] === 'scale' && level > 0) { level--; onStep(usable()[level], true); } }
  };
}

// --- the final pass: grade and sharpen ---------------------------------------------------

// The Showcase grades (sandbox/showcase-look.js GRADES), without the grain
// on a phone (grain costs a hash per pixel and reads as noise when upscaled).
export const LIVE_GRADES = Object.freeze({
  night: Object.freeze({ shadows: [0.0, 0.03, 0.055], highlights: [1.08, 0.98, 0.86], contrast: 1.12, saturation: 1.12, vignette: 0.32 }),
  rain: Object.freeze({ shadows: [0.0, 0.035, 0.06], highlights: [1.1, 0.97, 0.85], contrast: 1.15, saturation: 1.08, vignette: 0.36 }),
  dusk: Object.freeze({ shadows: [0.02, 0.02, 0.045], highlights: [1.1, 1.0, 0.86], contrast: 1.08, saturation: 1.08, vignette: 0.3 }),
  day: Object.freeze({ shadows: [0.0, 0.012, 0.03], highlights: [1.05, 1.01, 0.94], contrast: 1.08, saturation: 1.1, vignette: 0.24 })
});
export function liveMood({ light = 1, dusk = 0, rain = 0 } = {}) {
  if (light < 0.35) return rain > 0.3 ? 'rain' : 'night';
  if (dusk > 0.5) return 'dusk';
  return rain > 0.3 ? 'rain' : 'day';
}

// One full-screen pass after tone mapping: the grade (split toning,
// contrast, saturation, vignette) and contrast-adaptive sharpening (CAS,
// after AMD FidelityFX: a cross of 5 taps, its strength set per pixel by the
// local contrast so edges sharpen and flat areas and noise do not). It reads
// the lower-resolution frame and writes the full-resolution canvas, so the
// sharpening happens after the upscale.
export function finishShader() {
  const g = LIVE_GRADES.night;
  return {
    name: 'PG1CityFinish',
    uniforms: {
      tDiffuse: { value: null }, uTexel: { value: [1 / 720, 1 / 1600] }, uSharp: { value: 0.0 }, uGrade: { value: 1.0 },
      uLift: { value: g.shadows.slice() }, uGain: { value: g.highlights.slice() }, uContrast: { value: g.contrast }, uSaturation: { value: g.saturation }, uVignette: { value: g.vignette }, uAspect: { value: 0.45 }
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uSharp; uniform float uGrade; uniform vec3 uLift; uniform vec3 uGain; uniform float uContrast; uniform float uSaturation; uniform float uVignette; uniform float uAspect; varying vec2 vUv;
      void main(){
        vec3 e = texture2D(tDiffuse, vUv).rgb;
        vec3 x = e;
        if (uSharp > 0.0) {
          vec3 b = texture2D(tDiffuse, vUv + vec2(0.0, -uTexel.y)).rgb;
          vec3 d = texture2D(tDiffuse, vUv + vec2(-uTexel.x, 0.0)).rgb;
          vec3 f = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb;
          vec3 h = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb;
          vec3 mn = min(min(min(d, e), min(f, b)), h);
          vec3 mx = max(max(max(d, e), max(f, b)), h);
          vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
          vec3 w = amp * (-1.0 / mix(8.0, 5.0, uSharp));
          x = clamp((b * w + d * w + f * w + h * w + e) / (1.0 + 4.0 * w), 0.0, 1.0);
        }
        if (uGrade > 0.0) {
          vec3 c = x;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c += uLift * (1.0 - smoothstep(0.0, 0.55, l));
          c *= mix(vec3(1.0), uGain, smoothstep(0.35, 1.0, l));
          c = (c - 0.5) * uContrast + 0.5;
          float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l2), c, uSaturation);
          vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0) / max(uAspect, 1.0);
          c *= 1.0 - uVignette * smoothstep(0.25, 0.85, length(q) * 1.35);
          x = mix(x, clamp(c, 0.0, 1.0), uGrade);
        }
        gl_FragColor = vec4(x, 1.0);
      }`
  };
}
