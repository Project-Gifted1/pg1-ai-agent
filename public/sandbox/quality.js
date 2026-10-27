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
  medium: Object.freeze({ pixelRatio: 1.25, cascades: 2, shadowMapSize: 1024, gtao: false, bloom: true, aa: 'smaa', water: false, sky: 'physical', textures: true, grass: 0.7, forest: 0.7, targetFps: 60, streets: true, coast: true, ibl: true, lod: 45, reflect: 'sky', dof: false, ease: 5, foliage: 12000, foliageRadius: 70 }),
  high: Object.freeze({ pixelRatio: 1.75, cascades: 3, shadowMapSize: 2048, gtao: true, bloom: true, aa: 'smaa', water: true, sky: 'physical', textures: true, grass: 1, forest: 1, targetFps: 60, streets: true, coast: true, ibl: true, lod: 70, reflect: 'sky', dof: false, ease: 5, foliage: 30000, foliageRadius: 90 }),
  ultra: Object.freeze({ pixelRatio: 2, cascades: 4, shadowMapSize: 4096, gtao: true, bloom: true, aa: 'taa', water: true, sky: 'physical', textures: true, grass: 1.4, forest: 1.2, targetFps: 60, streets: true, coast: true, ibl: true, lod: 100, reflect: 'sky', dof: false, ease: 5, foliage: 60000, foliageRadius: 110 }),
  cinematic: Object.freeze({ pixelRatio: 2, cascades: 4, shadowMapSize: 8192, gtao: true, bloom: true, aa: 'taa', water: true, sky: 'physical', textures: true, grass: 1.6, forest: 1.4, targetFps: 30, streets: true, coast: true, ibl: true, lod: 160, reflect: 'planar', dof: true, ease: 1.6, foliage: 120000, foliageRadius: 140 })
});

export const QUALITY_KEY = 'pg1_sandbox_quality';

// The starting tier: a saved choice wins; otherwise from the device.
export function pickTier({ coarse = false, memory = 0, cores = 0, saved = null } = {}) {
  if (saved && (TIERS.includes(saved) || saved === 'auto')) { if (saved !== 'auto') return saved; }
  if (coarse) return memory && memory >= 8 && cores >= 8 ? 'high' : 'medium';
  if (memory && memory < 4) return 'medium';
  return cores >= 8 ? 'ultra' : 'high';
}

// Frame times in; a lower tier out when the frame budget is missed for
// `window` frames on average (by 20%). Never raises the tier on its own
// (that would flicker); a manual choice resets it.
export function createGovernor({ tier = 'high', budgetMs = 1000 / 60, window = 120, onChange = () => {} } = {}) {
  let current = tier; let auto = true; const samples = [];
  let cooldown = 0;
  return {
    get tier() { return current; },
    get auto() { return auto; },
    set(t, { manual = true } = {}) { if (!TIERS.includes(t)) return; current = t; auto = !manual; samples.length = 0; cooldown = window; onChange(current, { manual }); },
    setAuto(on) { auto = !!on; samples.length = 0; },
    // The time between two rendered frames, in ms (the scene skips gaps
    // after a hidden tab, so only real slowness counts).
    sample(ms, budget = budgetMs) {
      if (!auto || !(ms >= 0)) return current;
      if (cooldown > 0) { cooldown--; return current; }
      samples.push(ms); if (samples.length > window) samples.shift();
      if (samples.length < window) return current;
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      if (avg > budget * 1.2) {
        const i = TIERS.indexOf(current);
        if (i > 0) { current = TIERS[i - 1]; samples.length = 0; cooldown = window; onChange(current, { manual: false, avgMs: avg }); }
      }
      return current;
    }
  };
}
