/**
 * Ultra and Cinematic on a phone (quality.js PHONE_CINEMATIC): the same look
 * at a 30 fps budget a Galaxy A07 class GPU can hold, while a computer keeps
 * the full settings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TIER_SETTINGS, deviceSettings, PHONE_CINEMATIC } from '../public/sandbox/quality.js';

const A07 = { coarse: true, memory: 4, cores: 8 };

test('Cinematic on a phone keeps the look and fits 30 fps', () => {
  const s = deviceSettings(TIER_SETTINGS.cinematic, { ...A07, tier: 'cinematic' });
  // Kept.
  assert.equal(s.dof, true, 'depth of field on what is followed');
  assert.equal(s.bloom, true); assert.equal(s.water, true);
  assert.equal(s.gtao, false, 'no ambient occlusion on 4 GB: its extra full-scene pass');
  assert.equal(deviceSettings(TIER_SETTINGS.cinematic, { coarse: true, memory: 8, tier: 'cinematic' }).gtao, true, 'a stronger phone keeps it, at half resolution'); assert.equal(s.sky, 'physical'); assert.equal(s.ibl, true);
  assert.ok(s.cascades >= 2 && s.shadowMapSize >= 2048, 'soft cascaded shadows');
  // Made for the phone.
  assert.equal(s.aa, 'smaa', 'no temporal accumulation (four scene renders a frame)');
  assert.equal(s.reflect, 'sky', 'no planar mirror (the scene drawn twice)');
  assert.equal(s.gtaoScale, 0.5); assert.equal(s.gtaoSamples, 8);
  assert.equal(s.pixelRatio, 1.5); assert.equal(s.targetFps, 30);
  assert.ok(s.foliage <= PHONE_CINEMATIC.foliage, `${s.foliage} tufts`);
  // Ultra too, without depth of field (it never had it).
  const u = deviceSettings(TIER_SETTINGS.ultra, { ...A07, tier: 'ultra' });
  assert.equal(u.aa, 'smaa'); assert.equal(u.dof, false); assert.equal(u.targetFps, 30);
});

test('a computer keeps the full Cinematic', () => {
  const s = deviceSettings(TIER_SETTINGS.cinematic, { coarse: false, memory: 16, cores: 16, tier: 'cinematic' });
  assert.equal(s.aa, 'taa'); assert.equal(s.reflect, 'planar'); assert.equal(s.shadowMapSize, 8192); assert.equal(s.pixelRatio, 2);
  assert.equal(s.gtaoScale, undefined);
});

test('ambient occlusion at the scale asked for, kept on resize; the scene passes the tier', () => {
  const post = readFileSync(new URL('../public/sandbox/post.js', import.meta.url), 'utf8');
  assert.match(post, /new gtaoMod\.GTAOPass\(scene, camera, size\.x \* aoScale, size\.y \* aoScale\)/);
  assert.match(post, /gtao\.setSize\(Math\.max\(1, Math\.round\(w \* pr \* aoScale\)\)/);
  assert.match(readFileSync(new URL('../public/sandbox/sandbox-scene.js', import.meta.url), 'utf8'), /deviceSettings\(TIER_SETTINGS\[tier\] \|\| TIER_SETTINGS\.high, \{ coarse, memory: nav\.deviceMemory \|\| 0, cores: nav\.hardwareConcurrency \|\| 0, tier \}\)/);
});
