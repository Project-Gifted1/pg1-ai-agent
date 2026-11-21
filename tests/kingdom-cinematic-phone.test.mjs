/**
 * PG1 City's Cinematic on a phone (kingdom-scene.js PHONE_CINEMATIC_CITY):
 * the same look at 30 fps on a Galaxy A07 class GPU, with a render scale
 * that draws fewer pixels while frames run slow; a computer keeps it all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kingdomSettings } from '../public/kingdom/kingdom-scene.js';

test('Cinematic on a phone: shadows, bloom, occlusion, water and sky kept; 30 fps', () => {
  const s = kingdomSettings('cinematic', { coarse: true });
  assert.ok(s.shadows >= 1024); assert.equal(s.water, true); assert.equal(s.sky, 'physical');
  assert.equal(s.post.bloom, true); assert.equal(s.post.gtao, true); assert.equal(s.post.aa, 'smaa');
  assert.equal(s.post.gtaoScale, 0.5); assert.equal(s.post.gtaoSamples, 8);
  assert.equal(s.targetFps, 30); assert.equal(s.pixelRatio, 1.5); assert.equal(s.renderScale, true);
  assert.ok(s.crowdCap <= 300 && s.lifeScale < 1);
  // The Galaxy A07 (4 GB): no ambient occlusion; the rest of the look kept.
  const a07 = kingdomSettings('cinematic', { coarse: true, memory: 4 });
  assert.equal(a07.post.gtao, false); assert.equal(a07.post.bloom, true); assert.equal(a07.water, true); assert.ok(a07.shadows >= 1024);
});

test('a computer keeps the full Cinematic', () => {
  const s = kingdomSettings('cinematic', { coarse: false });
  assert.equal(s.targetFps, 60); assert.equal(s.pixelRatio, 2); assert.equal(s.crowdCap, 800); assert.ok(!s.renderScale);
  assert.equal(s.post.gtaoScale, undefined);
});

test('the render scale follows the frames, and a switch to Cinematic in place gets one', () => {
  const src = readFileSync(new URL('../public/kingdom/kingdom-scene.js', import.meta.url), 'utf8');
  assert.match(src, /if \(renderScale\) renderScale\.sample\(now - last\)/);
  assert.match(src, /ensureScale\(\);\n    await buildPost\(\);/);
  // No planar river mirror on a phone (it draws the whole city twice).
  assert.match(src, /const ReflectorMod = settings\.tier === 'cinematic' && !settings\.renderScale \?/);
});

test('the crowd\'s coats are never the enemy red', async () => {
  const { LIFE_COLOURS } = await import('../public/kingdom/kingdom-life.js');
  const { isEnemyColour } = await import('../public/kingdom/kingdom-data.js');
  assert.ok(LIFE_COLOURS.figure.length >= 10, 'a range of coat colours');
  for (const c of LIFE_COLOURS.figure) assert.ok(!isEnemyColour(c), c.toString(16));
});
