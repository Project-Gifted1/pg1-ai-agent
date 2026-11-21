// Automatic quality from a short probe of real frames, shared by the
// Sandbox viewer and PG1 City.
//
// The view starts on a safe tier (Low on a phone), draws a few frames and
// times the render work of each (the draw plus a one-pixel read-back, so the
// GPU really finished: requestAnimationFrame alone stops at the screen's
// refresh rate and cannot show headroom). From the median it estimates what
// each automatic tier would cost and picks the highest one that fits its
// frame budget with room to spare. Low, Medium and High are automatic;
// higher tiers are only ever chosen by hand.
//
//   AUTO_TIERS                      ['low', 'medium', 'high']
//   startTier({ coarse, memory })   the tier to probe on
//   tierFromProbe({ workMs, probed, coarse, memory })   the tier to use
//   createProbe({ warmup, frames }) -> { sample(ms) -> null | { workMs, frames } }
//   overrideTier(search, allowed)   ?quality=<tier> in the address (operator)
//   readProbeCache(storage, now) / writeProbeCache(storage, tier, now)
//
// Pure apart from the storage passed in; tests/tier-probe.test.mjs.

export const AUTO_TIERS = Object.freeze(['low', 'medium', 'high']);

// What a frame costs on each tier, relative to Low (measured on this
// project's scenes: post-processing, shadows and resolution add up).
export const TIER_COST = Object.freeze({ low: 1, medium: 2.2, high: 3.6 });

// The frame budget each automatic tier must fit (ms), and the share of it
// the render work may take (the rest is the simulation, the page and slack).
export const TIER_BUDGET_MS = Object.freeze({ low: 1000 / 30, medium: 1000 / 60, high: 1000 / 60 });
export const BUDGET_SHARE = 0.6;

// The probe: frames skipped while shaders compile and textures upload, then
// frames timed. Short: about a second on a phone.
export const PROBE = Object.freeze({ warmup: 6, frames: 20 });

// The tier to start (and probe) on: Low on a phone or a device with 4 GB of
// memory or less (a budget Android phone such as a Galaxy A07), Medium on a
// computer. A probe can only step up from there if the device has headroom.
export function startTier({ coarse = false, memory = 0 } = {}) {
  if (coarse) return 'low';
  if (memory && memory <= 4) return 'low';
  return 'medium';
}

// The tier to use, from the probe's median render work (ms) on the tier it
// ran on. A phone with 4 GB or less never goes past Medium on its own (its
// GPU heats up and throttles over minutes, which a one-second probe cannot see).
export function tierFromProbe({ workMs, probed = 'low', coarse = false, memory = 0 } = {}) {
  if (!(workMs > 0) || !Number.isFinite(workMs)) return probed && AUTO_TIERS.includes(probed) ? probed : 'low';
  const base = workMs / (TIER_COST[probed] || 1);
  let pick = 'low';
  for (const t of AUTO_TIERS) if (base * TIER_COST[t] <= TIER_BUDGET_MS[t] * BUDGET_SHARE) pick = t;
  if (coarse && memory && memory <= 4 && pick === 'high') pick = 'medium';
  return pick;
}

export function createProbe({ warmup = PROBE.warmup, frames = PROBE.frames } = {}) {
  let seen = 0; const times = []; let result = null;
  return {
    get done() { return !!result; },
    get result() { return result; },
    // One frame's render work (ms). Returns the result once, when complete.
    sample(ms) {
      if (result) return null;
      seen++;
      if (seen <= warmup || !(ms >= 0) || ms > 2000) return null;
      times.push(ms);
      if (times.length < frames) return null;
      const s = times.slice().sort((a, b) => a - b);
      result = Object.freeze({ workMs: Math.round(s[Math.floor(s.length / 2)] * 100) / 100, p90Ms: Math.round(s[Math.floor(s.length * 0.9)] * 100) / 100, frames: s.length });
      return result;
    }
  };
}

// ?quality=low|medium|high (or any allowed tier) in the address: the
// operator's override for this visit, ahead of the probe and the saved choice.
export function overrideTier(search, allowed = AUTO_TIERS) {
  try {
    const q = new URLSearchParams(search || '').get('quality');
    return q && allowed.includes(q) ? q : null;
  } catch (e) { return null; }
}

// ?debug=1: the frame-rate overlay.
export function debugOn(search) {
  try { return new URLSearchParams(search || '').get('debug') === '1'; } catch (e) { return false; }
}

// The probe's pick is kept on this device for a week, so later visits start
// on it straight away (the governor still steps down if frames run slow).
export const PROBE_CACHE_MS = 7 * 24 * 3600 * 1000;
export function readProbeCache(storage, key, now = Date.now()) {
  try {
    const v = JSON.parse(storage.getItem(key) || 'null');
    if (v && AUTO_TIERS.includes(v.tier) && Number.isFinite(v.at) && now - v.at >= 0 && now - v.at < PROBE_CACHE_MS) return v.tier;
  } catch (e) { /* none */ }
  return null;
}
export function writeProbeCache(storage, key, tier, now = Date.now(), workMs = null) {
  try { storage.setItem(key, JSON.stringify({ tier, at: now, workMs })); } catch (e) { /* private mode */ }
}
