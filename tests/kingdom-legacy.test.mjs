/**
 * PG1 City's Legacy phone tier (an iPhone 8: A11 GPU, ~2 GB RAM, Safari on
 * iOS 16), the parts that need no browser. The budgets themselves are
 * measured in a real browser by tests/browser/kingdom-city.browser.test.mjs.
 *
 *   - the tier is chosen for an iPhone 8 user-agent profile (iOS 16, the
 *     4.7-inch 375 x 667 screen, 2 GB, or a slow GPU benchmark), and not for
 *     a current phone or a desktop;
 *   - its settings: 30 fps, no post-processing, shadows, reflections or
 *     volumetrics, textures capped at 1024 px, life and weather density cut;
 *   - the automatic drop: frames that stay slow send the tier to Legacy;
 *   - Record mode on the Legacy tier records 720p at 30 fps;
 *   - the static merge keeps every triangle (no scenery lost).
 * Run with: node --test tests/kingdom-legacy.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectLegacy, kingdomSettings, KINGDOM_TIERS, KINGDOM_TIER_LABEL, LEGACY_BUDGET, LEGACY_DROP } from '../public/kingdom/kingdom-scene.js';
import { createLegacyWatch, mergeGeometries, STATIC_NAMES } from '../public/kingdom/kingdom-legacy.js';
import { recordSpec, clipSize, RECORD_FPS } from '../public/kingdom/kingdom-record.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const IPHONE8_IOS16 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const IPHONE15_IOS18 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const PIXEL = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

test('the Legacy phone tier is chosen for an iPhone 8 profile, and not for current phones or desktops', () => {
  assert.equal(detectLegacy({ userAgent: IPHONE8_IOS16, screenW: 375, screenH: 667, touch: true }), true, 'iPhone 8 on iOS 16');
  assert.equal(detectLegacy({ userAgent: IPHONE8_IOS16 }), true, 'iOS 16 alone');
  assert.equal(detectLegacy({ userAgent: IPHONE15_IOS18, screenW: 375, screenH: 667, touch: true }), true, 'an iPhone with the 4.7-inch screen (SE / 8 class)');
  assert.equal(detectLegacy({ userAgent: IPHONE15_IOS18, screenW: 393, screenH: 852, touch: true }), false, 'a current iPhone');
  assert.equal(detectLegacy({ userAgent: PIXEL, screenW: 412, screenH: 915, memory: 8, touch: true }), false);
  assert.equal(detectLegacy({ userAgent: PIXEL, screenW: 360, screenH: 780, memory: 2, touch: true }), true, '2 GB phone');
  assert.equal(detectLegacy({ userAgent: PIXEL, screenW: 412, screenH: 915, memory: 4, touch: true, gpuMs: 60 }), true, 'slow GPU benchmark');
  assert.equal(detectLegacy({ userAgent: PIXEL, screenW: 412, screenH: 915, memory: 4, touch: true, gpuMs: 4 }), false, 'fast GPU benchmark');
  assert.equal(detectLegacy({ userAgent: DESKTOP, screenW: 1440, screenH: 900, memory: 2 }), false, 'not a touch device');
  // Selectable by hand, first in the list.
  assert.equal(KINGDOM_TIERS[0], 'legacy');
  assert.equal(KINGDOM_TIER_LABEL.legacy, 'Legacy phone');
  assert.match(read('public/index.html'), /<option value="legacy">Legacy phone<\/option>/);
});

test('Legacy settings: 30 fps, nothing heavy, textures capped, density cut', () => {
  const s = kingdomSettings('legacy');
  assert.equal(s.targetFps, 30);
  assert.equal(s.shadows, 0, 'no real-time shadows');
  assert.equal(s.post, null, 'no post-processing (no SSR, AO, bloom, volumetrics)');
  assert.equal(s.water, false, 'no reflective water shader');
  assert.equal(s.shafts, false, 'no light shafts');
  assert.equal(s.pixelRatio, 1);
  assert.equal(s.maxTexture, 1024);
  assert.ok(s.lifeScale < kingdomSettings('phone').crowdCap / 100 && s.lifeScale <= 0.25);
  assert.ok(s.weatherScale <= 0.35, 'simple, sparse rain');
  assert.ok(s.far <= 3000, 'distance culling: a near far plane');
  assert.deepEqual({ ...LEGACY_BUDGET }, { drawCalls: 150, triangles: 150000, maxTexture: 1024, gpuMemoryMB: 300, targetFps: 30 });
  // Cinematic keeps everything.
  const c = kingdomSettings('cinematic');
  assert.ok(c.shadows >= 1024 && c.post && c.water && c.shafts);
});

test('automatic drop: frames that stay slow send the tier to Legacy, a passing hiccup does not', () => {
  const w = createLegacyWatch(LEGACY_DROP);
  let fired = 0;
  for (let i = 0; i < 300; i++) if (w.sample(i % 10 === 0 ? 120 : 20)) fired++;
  assert.equal(fired, 0, 'occasional slow frames are forgiven');
  for (let i = 0; i < LEGACY_DROP.frames - 1; i++) assert.equal(w.sample(80), false);
  assert.equal(w.sample(80), true, 'drops after the window of slow frames');
  assert.equal(w.sample(80), false, 'only once');
  // The scene wires it: only on the Phone tier, never when a tier was chosen by hand.
  const scene = read('public/kingdom/kingdom-scene.js');
  assert.match(scene, /tier === 'phone' && !forced && governor\.auto !== false && legacyWatch\.sample\(now - last\)\) \{ container\.dataset\.autoDrop = 'legacy'; applyTier\('legacy'\); \}/);
});

test('Record mode on the Legacy tier records 720p at 30 fps', () => {
  assert.deepEqual(recordSpec({ legacy: true }), { maxEdge: 1280, fps: 30 });
  assert.deepEqual(clipSize('16:9', recordSpec({ legacy: true }).maxEdge), { w: 1280, h: 720 });
  assert.deepEqual(clipSize('9:16', recordSpec({ legacy: true }).maxEdge), { w: 720, h: 1280 });
  assert.equal(recordSpec({}).maxEdge, 1920);
  assert.equal(RECORD_FPS, 30);
  assert.match(read('public/kingdom/kingdom-ui.js'), /legacy: scene\.tier && scene\.tier\(\) === 'legacy'/);
});

test('the static merge keeps every vertex of what it merges', async () => {
  const THREE = await import('../public/vendor/three/three.module.min.js').catch(() => null);
  if (!THREE) return;
  const a = new THREE.BoxGeometry(1, 1, 1); const b = new THREE.CylinderGeometry(1, 1, 2, 8); b.translate(5, 0, 0);
  const m = mergeGeometries(THREE, [a, b]);
  assert.equal(m.attributes.position.count, a.toNonIndexed().attributes.position.count + b.toNonIndexed().attributes.position.count);
  assert.ok(m.attributes.normal && m.attributes.uv);
  assert.ok(STATIC_NAMES.includes('road') && !STATIC_NAMES.includes('rooftop-beacon'), 'animated things are never merged');
});
