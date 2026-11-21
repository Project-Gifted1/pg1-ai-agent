/**
 * Automatic quality from a short probe (public/sandbox/tier-probe.js), shared
 * by the Sandbox viewer and PG1 City, and how the viewer chooses its
 * starting tier (sandbox-scene.js chooseStart):
 *
 *   - a phone, or any device with 4 GB of memory or less (a budget Android
 *     phone such as a Galaxy A07), starts on Low; a computer on Medium;
 *   - the probe skips its warm-up frames and takes the median, so one slow
 *     frame (a shader compiling) does not decide;
 *   - the pick is the highest automatic tier whose estimated frame fits its
 *     budget with room to spare; a 4 GB phone never goes past Medium alone;
 *     Ultra and Cinematic are never picked automatically;
 *   - ?quality= in the address (the operator) wins over everything but the
 *     caller; then a tier kept by hand; then the last probe's pick (a week);
 *   - ?debug=1 turns on the frame-rate overlay, nothing else does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_TIERS, TIER_COST, TIER_BUDGET_MS, BUDGET_SHARE, startTier, tierFromProbe, createProbe, overrideTier, debugOn, readProbeCache, writeProbeCache, PROBE_CACHE_MS } from '../public/sandbox/tier-probe.js';
import { frameSummary } from '../public/sandbox/debug-overlay.js';
import { chooseStart } from '../public/sandbox/sandbox-scene.js';

const A07 = { coarse: true, memory: 4 };

test('the starting tier: Low on a phone or a 4 GB device, Medium on a computer', () => {
  assert.equal(startTier(A07), 'low');
  assert.equal(startTier({ coarse: true, memory: 8 }), 'low');
  assert.equal(startTier({ coarse: false, memory: 4 }), 'low');
  assert.equal(startTier({ coarse: false, memory: 8 }), 'medium');
  assert.equal(startTier({}), 'medium');
});

test('the probe: warm-up skipped, the median of the timed frames', () => {
  const p = createProbe({ warmup: 3, frames: 5 });
  for (const ms of [400, 300, 200]) assert.equal(p.sample(ms), null, 'warm-up frames are not timed');
  assert.equal(p.done, false);
  let r = null;
  for (const ms of [10, 11, 90, 12, 9]) r = p.sample(ms) || r;
  assert.equal(r.workMs, 11, 'one slow frame does not decide');
  assert.equal(r.frames, 5);
  assert.equal(p.sample(1), null, 'reported once');
  assert.equal(p.done, true);
});

test('the pick from the probe: the highest tier that fits, never Ultra or Cinematic', () => {
  // The A07 on Low: about 14 ms of render work a frame (Mali-G57 MC2 class) -> stays Low.
  assert.equal(tierFromProbe({ workMs: 14, probed: 'low', ...A07 }), 'low');
  // Headroom for Medium at 60 fps (2.2 x 4 ms = 8.8 ms <= 10 ms), not High.
  assert.equal(tierFromProbe({ workMs: 4, probed: 'low', ...A07 }), 'medium');
  // A fast phone with 4 GB: High would fit, but it stays on Medium (it throttles with heat).
  assert.equal(tierFromProbe({ workMs: 1, probed: 'low', ...A07 }), 'medium');
  assert.equal(tierFromProbe({ workMs: 1, probed: 'low', coarse: true, memory: 8 }), 'high');
  // A computer probed on Medium.
  assert.equal(tierFromProbe({ workMs: 4, probed: 'medium', memory: 16 }), 'high');
  assert.equal(tierFromProbe({ workMs: 9, probed: 'medium', memory: 16 }), 'medium');
  assert.equal(tierFromProbe({ workMs: 30, probed: 'medium', memory: 16 }), 'low', 'a slow computer steps down');
  // No answer: stay where it started.
  assert.equal(tierFromProbe({ workMs: NaN, probed: 'low' }), 'low');
  assert.equal(tierFromProbe({ workMs: 0, probed: 'medium' }), 'medium');
  for (let ms = 0.2; ms < 80; ms *= 1.3) for (const probed of AUTO_TIERS) assert.ok(AUTO_TIERS.includes(tierFromProbe({ workMs: ms, probed })), 'only Low, Medium or High');
  // Each pick fits its budget with room to spare.
  for (let ms = 0.2; ms < 80; ms *= 1.3) {
    const t = tierFromProbe({ workMs: ms, probed: 'low', memory: 16 });
    if (t !== 'low') assert.ok(ms * TIER_COST[t] <= TIER_BUDGET_MS[t] * BUDGET_SHARE + 1e-9);
  }
});

test('the operator\'s override and the debug overlay come from the address only', () => {
  assert.equal(overrideTier('?quality=low'), 'low');
  assert.equal(overrideTier('?debug=1&quality=high'), 'high');
  assert.equal(overrideTier('?quality=ultra'), null, 'not an automatic tier by default');
  assert.equal(overrideTier('?quality=ultra', ['low', 'ultra']), 'ultra');
  assert.equal(overrideTier('?quality=<script>'), null);
  assert.equal(overrideTier(''), null);
  assert.equal(debugOn('?debug=1'), true);
  assert.equal(debugOn('?debug=true'), false);
  assert.equal(debugOn(''), false);
});

test('the probe\'s pick is kept for a week on this device', () => {
  const mem = new Map(); const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  const now = Date.UTC(2026, 10, 21);
  assert.equal(readProbeCache(storage, 'k', now), null);
  writeProbeCache(storage, 'k', 'medium', now, 6.5);
  assert.equal(readProbeCache(storage, 'k', now + 1000), 'medium');
  assert.equal(readProbeCache(storage, 'k', now + PROBE_CACHE_MS + 1), null, 'probed again after a week');
  mem.set('k', '{"tier":"cinematic","at":' + now + '}');
  assert.equal(readProbeCache(storage, 'k', now), null, 'never an automatic Cinematic');
  mem.set('k', 'not json');
  assert.equal(readProbeCache(storage, 'k', now), null);
});

test('the viewer\'s start: caller, then ?quality=, then a tier kept by hand, then the kept probe, else probe', () => {
  assert.deepEqual(chooseStart({ tier: 'high', search: '?quality=low' }), { tier: 'high', source: 'caller', probe: false, auto: false });
  assert.deepEqual(chooseStart({ search: '?quality=low', saved: 'ultra' }), { tier: 'low', source: 'address', probe: false, auto: false });
  assert.equal(chooseStart({ search: '?quality=cinematic' }).tier, 'cinematic', 'the operator may ask for any tier');
  assert.deepEqual(chooseStart({ saved: 'ultra', cached: 'low' }), { tier: 'ultra', source: 'manual', probe: false, auto: false });
  assert.deepEqual(chooseStart({ saved: 'auto', cached: 'medium' }), { tier: 'medium', source: 'probe (kept)', probe: false, auto: true });
  assert.deepEqual(chooseStart({ ...A07 }), { tier: 'low', source: 'probe', probe: true, auto: true }, 'the A07 starts on Low and probes');
  assert.deepEqual(chooseStart({ memory: 16 }), { tier: 'medium', source: 'probe', probe: true, auto: true });
});

test('the overlay\'s numbers: frames a second, average and slowest 5%', () => {
  const s = frameSummary([33.3, 33.3, 33.4, 33.3, 50]);
  assert.equal(s.fps, 27.3);
  assert.equal(s.p95Ms, 50);
  assert.deepEqual(frameSummary([]), { fps: 0, avgMs: 0, p95Ms: 0 });
});
