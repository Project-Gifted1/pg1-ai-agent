/**
 * PG1 Showcase (scripts/showcase-render.mjs): the offline "showcase"
 * quality profile is desktop only and never chosen by Auto, the probe or the
 * governor; the shots' camera paths start and end where planned and ease in
 * and out; the encoder settings; the first universe is read through a store
 * that refuses every write; payments are left out.
 * Run with: node --test tests/showcase.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, TIER_SETTINGS, pickTier, createGovernor, SHOWCASE, SHOWCASE_SETTINGS, showcaseSettings, deviceSettings } from '../public/sandbox/quality.js';
import { kingdomShowcaseSettings, KINGDOM_TIERS, chooseKingdomStart } from '../public/kingdom/kingdom-scene.js';
import { chooseStart } from '../public/sandbox/sandbox-scene.js';
import { AUTO_TIERS, startTier, tierFromProbe } from '../public/sandbox/tier-probe.js';
import { SHOTS, planShot, poseAt, smootherstep, cameraPosition, frameCount, SHOWCASE_FPS } from '../lib/showcase/shots.mjs';
import { parseArgs, ffmpegArgs, readOnlyStore, isPaymentEvent, dublinEpoch } from '../scripts/showcase-render.mjs';
import { createSandboxStore } from '../lib/sandbox/store.mjs';
import { createWorld, observeWorld, stepWorldFor, pg1Principal } from '../lib/sandbox/worlds.mjs';

test('showcase is a profile, never a tier: Auto, the probe, the governor and a saved choice cannot pick it', () => {
  assert.equal(SHOWCASE, 'showcase');
  assert.ok(!TIERS.includes(SHOWCASE) && !AUTO_TIERS.includes(SHOWCASE) && !KINGDOM_TIERS.includes(SHOWCASE));
  for (const coarse of [false, true]) for (const memory of [0, 2, 4, 8, 16]) for (const cores of [0, 2, 4, 8, 16]) {
    assert.notEqual(pickTier({ coarse, memory, cores }), SHOWCASE);
    assert.notEqual(pickTier({ coarse, memory, cores, saved: SHOWCASE }), SHOWCASE, 'a saved "showcase" is ignored');
    assert.notEqual(startTier({ coarse, memory }), SHOWCASE);
    for (const workMs of [0.5, 2, 8, 30]) assert.notEqual(tierFromProbe({ workMs, probed: 'high', coarse, memory }), SHOWCASE);
  }
  assert.notEqual(chooseStart({ saved: SHOWCASE }).tier, SHOWCASE);
  assert.notEqual(chooseStart({ search: '?quality=showcase' }).tier, SHOWCASE);
  assert.notEqual(chooseKingdomStart({ saved: SHOWCASE, search: '?quality=showcase', profile: {} }).tier, SHOWCASE);
  const g = createGovernor({ tier: 'cinematic' });
  g.set(SHOWCASE);
  assert.equal(g.tier, 'cinematic', 'the governor refuses it');
});

test('showcase is desktop only: refused on a phone (coarse pointer), for the viewer and the City', () => {
  assert.equal(showcaseSettings({ coarse: true }), null);
  assert.equal(kingdomShowcaseSettings({ coarse: true }), null);
  assert.equal(showcaseSettings({ coarse: false }), SHOWCASE_SETTINGS);
  // Nothing a phone gets is the showcase's: deviceSettings never reaches its numbers.
  const phone = deviceSettings(TIER_SETTINGS.cinematic, { coarse: true, memory: 8, cores: 8, tier: 'cinematic' });
  assert.ok(phone.shadowMapSize <= 4096 && phone.reflect === 'sky' && !phone.settle);
});

test('showcase spends more: occlusion and shadow samples, 4096 shadows, the planar mirror, full foliage, TAA settled per frame', () => {
  const S = SHOWCASE_SETTINGS; const C = TIER_SETTINGS.cinematic;
  assert.equal(S.shadowMapSize, 4096); assert.equal(S.cascades, 4);
  assert.equal(S.reflect, 'planar'); assert.equal(S.dof, true); assert.equal(S.gtao, true);
  assert.ok(S.gtaoSamples > 12, 'more occlusion samples than any tier (post.js default 12)');
  assert.equal(S.aa, 'taa'); assert.equal(S.settle, true); assert.ok(S.taaSamples >= 4, '16 jittered samples a frame');
  assert.ok(S.foliage >= C.foliage && S.foliageRadius >= C.foliageRadius && S.lod >= C.lod);
  assert.equal(S.targetFps, 30); assert.equal(S.offline, true);
  const K = kingdomShowcaseSettings({ coarse: false });
  assert.equal(K.tier, 'cinematic'); assert.equal(K.profile, SHOWCASE);
  assert.equal(K.shadows, 4096); assert.equal(K.renderScale, false);
  assert.deepEqual({ aa: K.post.aa, settle: K.post.settle, dof: K.post.dof, gtao: K.post.gtao }, { aa: 'taa', settle: true, dof: true, gtao: true });
  assert.ok(K.post.gtaoSamples > 12);
});

test('five shots of 4 to 6 seconds at 30 fps, each with a planned camera path that eases in and out', () => {
  assert.deepEqual(SHOTS.map((s) => s.id), ['city-night', 'city-rain', 'first-universe', 'benin-warri', 'deep-space']);
  assert.equal(SHOWCASE_FPS, 30);
  for (const s of SHOTS) {
    assert.ok(s.seconds >= 4 && s.seconds <= 6, `${s.id} ${s.seconds} s`);
    const plan = planShot(s.id, {});
    assert.equal(plan.frames, frameCount(s.seconds));
    const a = poseAt(plan, 0); const b = poseAt(plan, 1);
    const k0 = plan.keys[0].pose; const k1 = plan.keys[plan.keys.length - 1].pose;
    assert.ok(Math.abs(a.dist - k0.dist) < 1e-6 && Math.abs(b.dist - k1.dist) < 1e-6, s.id);
    assert.ok(Math.abs(a.theta - k0.theta) < 1e-9 && Math.abs(b.phi - k1.phi) < 1e-9, s.id);
    // At rest at both ends: the first and last steps are tiny next to the middle one.
    const d = (t1, t2) => Math.hypot(...cameraPosition(poseAt(plan, t1)).map((v, i) => v - cameraPosition(poseAt(plan, t2))[i]));
    const n = plan.frames;
    assert.ok(d(0, 1 / n) < d(0.5, 0.5 + 1 / n) * 0.2, `${s.id} eases in`);
    assert.ok(d(1 - 1 / n, 1) < d(0.5, 0.5 + 1 / n) * 0.2, `${s.id} eases out`);
    for (let i = 0; i <= 20; i++) { const p = poseAt(plan, i / 20); assert.ok(p.dist > 0 && Number.isFinite(p.theta) && p.target.every(Number.isFinite)); }
  }
  assert.equal(smootherstep(0), 0); assert.equal(smootherstep(1), 1); assert.equal(smootherstep(0.5), 0.5);
});

test('the shots use their scenes: depth of field on the hero, none in deep space; Benin at the walls, from a canoe', () => {
  const night = planShot('city-night');
  assert.ok(poseAt(night, 0.5).focus > 0);
  assert.equal(poseAt(planShot('deep-space', { planet: [0, 3000, 0], star: [4000, 3000, 0], planetSize: 80 }), 0.5).focus, null);
  const benin = planShot('benin-warri', { canoe: [880, 0, -680], walls: [1550, 0, -1020] });
  assert.deepEqual(poseAt(benin, 0).target.map(Math.round), [880, 2, -680]);
  assert.deepEqual(poseAt(benin, 1).target.map(Math.round), [1550, 4, -1020]);
  // The universe shot starts high above the ground and ends near it.
  const u = planShot('first-universe', { spaceAlt: 2000, ground: [0, 0, 0] });
  assert.ok(cameraPosition(poseAt(u, 0))[1] > 2000 * 2 && cameraPosition(poseAt(u, 1))[1] < 60);
});

test('the encoder: H.264, -preset veryfast, CRF 18, yuv420p; options are checked', () => {
  const a = ffmpegArgs('/f', '/o.mp4', 30).join(' ');
  for (const k of ['-c:v libx264', '-preset veryfast', '-crf 18', '-pix_fmt yuv420p', '-framerate 30']) assert.ok(a.includes(k), k);
  const o = parseArgs(['--shots', 'deep-space', '--size', '320x568', '--frames', '2', '--jobs', '3']);
  assert.deepEqual([o.shots, o.width, o.height, o.frames, o.jobs], [['deep-space'], 320, 568, 2, 3]);
  assert.throws(() => parseArgs(['--shots', 'nope']));
  assert.throws(() => parseArgs(['--size', '321x568']), /even/);
  // Dublin's clock for the City's light: 23:10 in November is 23:10 UTC.
  assert.equal(new Date(dublinEpoch(23, 10, Date.UTC(2026, 10, 21, 9))).toISOString(), '2026-11-21T23:10:00.000Z');
});

test('the first universe is read through a store that refuses every write: never stepped, reset or changed', async () => {
  const store = createSandboxStore();
  const w = await createWorld(store, pg1Principal(), { name: 'First', template: 'universe' });
  const ro = readOnlyStore(store);
  const v = await observeWorld(ro, { owner: w.owner, quota: pg1Principal().quota }, { world_id: w.id, events: 0 });
  assert.equal(v.tick, 0);
  await assert.rejects(() => stepWorldFor(ro, pg1Principal(), { world_id: w.id, steps: 1 }), /read only/);
  for (const k of ['updateWorld', 'deleteWorld', 'createWorld', 'addEvents', 'addSteps', 'addBlackbox']) assert.throws(() => ro[k]({}), /read only/, k);
  assert.equal((await store.getWorld(w.id)).tick, 0, 'unchanged');
});

test('payments are left out of a showcase', () => {
  for (const e of [{ gadget: 'toll_bridge' }, { kind: 'payment_settled' }, { verdict: 'PAYMENT_REQUIRED_402' }, { verdict: 'SETTLED' }, { verdict: 'JOB_PAID' }, { kind: 'payer_refused', check: 'check_wallet_sanctions' }]) assert.equal(isPaymentEvent(e), true, JSON.stringify(e));
  for (const e of [{ gadget: 'rate_shield', kind: 'rate_limited', verdict: 'RATE_LIMITED' }, { gadget: 'truth_lens', check: 'check_agent_message', verdict: 'SUSPICIOUS' }]) assert.equal(isPaymentEvent(e), false);
});
