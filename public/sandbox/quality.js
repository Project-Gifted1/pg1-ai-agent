// PG1 Sandbox viewer: quality tiers. Ultra, High, Medium and Low, picked
// from the device at the start, lowered automatically when frames keep
// running over budget, and overridable by hand (remembered on this device).
// Cinematic is above Ultra and only ever chosen by hand: for stills and
// slow looks around on a strong computer, not for a phone.
//
//   pickTier({ coarse, memory, cores, saved })   the starting tier
//   createGovernor({ tier, budgetMs, onChange })  watches frame times and
//                                                 steps down one tier when the
//                                                 budget is missed for a while
//
// What each tier turns on is TIER_SETTINGS; the scene reads it.

export const TIERS = Object.freeze(['low', 'medium', 'high', 'ultra', 'cinematic']);
export const TIER_LABEL = Object.freeze({ low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra', cinematic: 'Cinematic' });

// What each tier turns on:
//   pixelRatio, cascades, shadowMapSize   resolution and cascaded shadows
//   gtao, bloom, aa                       post-processing (post.js)
//   water, sky, textures, grass, forest   the world's surfaces (environment.js)
//   streets   detailed streets: markings, kerbs, pavements, crossings, lamps
//             (streets.js); Low keeps the plain road strips
//   coast     rocks along the coasts, and surf where the water shader is off (coast.js)
//   ibl       image-based light from the sky (a prefiltered environment map)
//   lod       how far (in model sizes) moving things keep their full model
//             before they become one instanced block each
//   reflect   'sky' (the water shader's sky and sun) or 'planar' (a true
//             mirror image of the scene in the water: Cinematic only)
//   dof       depth of field on the followed thing (Cinematic only)
//   ease      how quickly the camera settles (lower is slower and smoother)
//   foliage   grass tufts and flowers round the camera (foliage.js), and
//             foliageRadius, how far out they grow (metres)
export const TIER_SETTINGS = Object.freeze({
  low: Object.freeze({ pixelRatio: 1, cascades: 0, shadowMapSize: 0, gtao: false, bloom: false, aa: 'none', water: false, sky: 'gradient', textures: false, grass: 0.35, forest: 0.4, targetFps: 30, streets: false, coast: false, ibl: false, lod: 30, reflect: 'sky', dof: false, ease: 5, foliage: 0, foliageRadius: 60 }),
  medium: Object.freeze({ pixelRatio: 1.25, cascades: 2, shadowMapSize: 1024, gtao: false, bloom: true, aa: 'smaa', water: false, sky: 'physical', textures: true, grass: 0.7, forest: 0.7, targetFps: 60, streets: true, coast: true, ibl: true, lod: 45, reflect: 'sky', dof: false, ease: 5, foliage: 12000, foliageRadius: 45 }),
  high: Object.freeze({ pixelRatio: 1.75, cascades: 3, shadowMapSize: 2048, gtao: true, bloom: true, aa: 'smaa', water: true, sky: 'physical', textures: true, grass: 1, forest: 1, targetFps: 60, streets: true, coast: true, ibl: true, lod: 70, reflect: 'sky', dof: false, ease: 5, foliage: 30000, foliageRadius: 60 }),
  ultra: Object.freeze({ pixelRatio: 2, cascades: 4, shadowMapSize: 4096, gtao: true, bloom: true, aa: 'taa', water: true, sky: 'physical', textures: true, grass: 1.4, forest: 1.2, targetFps: 60, streets: true, coast: true, ibl: true, lod: 100, reflect: 'sky', dof: false, ease: 5, foliage: 60000, foliageRadius: 75 }),
  cinematic: Object.freeze({ pixelRatio: 2, cascades: 4, shadowMapSize: 8192, gtao: true, bloom: true, aa: 'taa', water: true, sky: 'physical', textures: true, grass: 1.6, forest: 1.4, targetFps: 30, streets: true, coast: true, ibl: true, lod: 160, reflect: 'planar', dof: true, ease: 1.6, foliage: 120000, foliageRadius: 95 })
});

export const QUALITY_KEY = 'pg1_sandbox_quality';

// The starting tier: a saved choice wins; otherwise from the device.
export function pickTier({ coarse = false, memory = 0, cores = 0, saved = null } = {}) {
  if (saved && (TIERS.includes(saved) || saved === 'auto')) { if (saved !== 'auto') return saved; }
  if (coarse) return memory && memory >= 8 && cores >= 8 ? 'high' : 'medium';
  if (memory && memory < 4) return 'medium';
  return cores >= 8 ? 'ultra' : 'high';
}

// Frame times in; a lower tier out when the frame budget is missed (by 20%)
// on average over `window` frames, or over as long as `window` frames at
// the budget would take, so a device drawing a frame a second steps down in
// seconds, not minutes. Never raises the tier on its own (that would
// flicker); a manual choice resets it.
export function createGovernor({ tier = 'high', budgetMs = 1000 / 60, window = 120, onChange = () => {} } = {}) {
  let current = tier; let auto = true; const samples = [];
  const span = window * budgetMs;
  let cooldown = 0;
  return {
    get tier() { return current; },
    get auto() { return auto; },
    set(t, { manual = true } = {}) { if (!TIERS.includes(t)) return; current = t; auto = !manual; samples.length = 0; cooldown = span; onChange(current, { manual }); },
    setAuto(on) { auto = !!on; samples.length = 0; },
    // The time between two rendered frames, in ms (the scene starts afresh
    // after a hidden tab, so only real slowness counts).
    sample(ms, budget = budgetMs) {
      if (!auto || !(ms >= 0)) return current;
      if (cooldown > 0) { cooldown -= ms; return current; }
      samples.push(ms); if (samples.length > window) samples.shift();
      const sum = samples.reduce((a, b) => a + b, 0);
      if (samples.length < window && (samples.length < 3 || sum < span)) return current;
      const avg = sum / samples.length;
      if (avg > budget * 1.2) {
        const i = TIERS.indexOf(current);
        if (i > 0) { current = TIERS[i - 1]; samples.length = 0; cooldown = span; onChange(current, { manual: false, avgMs: avg }); }
      }
      return current;
    }
  };
}

// What a tier turns on, fitted to the device: on a phone (coarse pointer)
// the shadow map is at most PHONE_SHADOW_MAP (4096) and the foliage scales
// with what the device has (fewer cores or less memory, fewer tufts).
export const PHONE_SHADOW_MAP = 4096;
export function deviceSettings(settings, { coarse = false, memory = 0, cores = 0 } = {}) {
  const s = { ...settings };
  if (coarse && s.shadowMapSize > PHONE_SHADOW_MAP) s.shadowMapSize = PHONE_SHADOW_MAP;
  let k = coarse ? 0.6 : 1;
  if (memory && memory <= 4) k *= 0.6;
  if (cores && cores <= 4) k *= 0.75;
  s.foliage = Math.round((s.foliage || 0) * k);
  return Object.freeze(s);
}

// Render scale for Cinematic: when frames run over budgetMs (33 ms: under
// 30 fps) for a while, draw fewer pixels (down to `min` of the full
// resolution); when they run well under it again, more. Never flickers:
// each change waits for a fresh window of frames.
export function createRenderScale({ budgetMs = 1000 / 30, min = 0.5, window = 30, onChange = () => {} } = {}) {
  let scale = 1; let n = 0; let sum = 0;
  return {
    get scale() { return scale; },
    get atMin() { return scale <= min + 1e-9; },
    sample(ms) {
      if (!(ms > 0) || ms > 1000) return scale;
      n++; sum += ms;
      if (n < window) return scale;
      const avg = sum / n; n = 0; sum = 0;
      let next = scale;
      if (avg > budgetMs) next = Math.max(min, Math.round(scale * Math.sqrt(budgetMs / avg) * 0.95 * 100) / 100);
      else if (avg < budgetMs * 0.6 && scale < 1) next = Math.min(1, Math.round(scale * 1.1 * 100) / 100);
      if (next !== scale) { scale = next; onChange(scale, avg); }
      return scale;
    }
  };
}
