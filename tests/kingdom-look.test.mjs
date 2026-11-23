/**
 * PG1 City on a budget phone (1.23, public/kingdom/kingdom-look.js): the
 * rules that bring the live view closer to the Showcase look on a Galaxy A07
 * without dropping below 30 fps.
 *   - the render scale never goes below 0.8 on a phone (City and Sandbox);
 *   - slow frames give up effects first, resolution last;
 *   - Auto never picks a tier that cannot hold 30 fps at scale 1.0: on a
 *     phone never Cinematic, and the menu says it may look softer;
 *   - the fog follows the weather but the first 400 m stay clear;
 *   - one look table with a switch per tier for every feature;
 *   - the banner says "Probes and checks" unless every counted event was a
 *     blocked attack.
 * Run with: node --test tests/kingdom-look.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PHONE_MIN_SCALE, FOG_CLEAR_M, FOG_MAX_DENSITY, LOOK_TABLE, LOOK_FEATURES, lookFor, parseFx, applyFx, fogFactorAt, liveFog,
  minRenderScale, autoAllowed, CINEMATIC_PHONE_NOTE, EFFECT_LADDER, createEffectLadder, liveMood, finishShader, LIVE_GRADES
} from '../public/kingdom/kingdom-look.js';
import { kingdomSettings, chooseKingdomStart, KINGDOM_FROM_AUTO, KINGDOM_TIERS } from '../public/kingdom/kingdom-scene.js';
import { createRenderScale } from '../public/sandbox/quality.js';
import { tierFromProbe, startTier } from '../public/sandbox/tier-probe.js';
import { weatherLook } from '../public/kingdom/kingdom-data.js';
import { originsKind, BLOCKED_ATTACK_KINDS } from '../lib/defenseFeed.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PHONE = { coarse: true, memory: 4 };

// --- sharpness ------------------------------------------------------------------------------

test('the render scale never goes below 0.8 on a phone, however slow the frames', () => {
  assert.equal(PHONE_MIN_SCALE, 0.8);
  assert.equal(minRenderScale({ coarse: true }), 0.8);
  assert.equal(minRenderScale({ coarse: false }), 0.5);
  const rs = createRenderScale({ min: minRenderScale({ coarse: true }) });
  for (let i = 0; i < 2000; i++) rs.sample(200);
  assert.equal(rs.scale, 0.8);
  // Every phone tier above Low draws at least 0.8 of a 2x screen, and is upscaled and sharpened to it.
  for (const tier of ['phone', 'balanced', 'cinematic']) {
    const s = kingdomSettings(tier, PHONE);
    assert.ok(s.pixelRatio >= 2 * PHONE_MIN_SCALE, `${tier}: pixel ratio ${s.pixelRatio}`);
    assert.equal(s.outputPixelRatio, 2, `${tier}: output at the screen's resolution`);
    assert.equal(s.renderScale, true);
    assert.equal(s.post.finish.sharpen, true, `${tier}: sharpened after the upscale`);
  }
  // Low keeps its own budget (the iPhone 8's): the GPU's multisampling straight to the screen.
  assert.equal(kingdomSettings('legacy', PHONE).post, null);
  // The City and the Sandbox viewer both use the floor.
  assert.match(read('public/kingdom/kingdom-scene.js'), /min: minRenderScale\(\{ coarse \}\)/);
  assert.match(read('public/sandbox/sandbox-scene.js'), /min: coarse \? PHONE_MIN_SCALE : 0\.5/);
});

test('slow frames give up effects first (occlusion, shadows, crowds, drone detail, far detail, HDRI), resolution last', () => {
  assert.deepEqual([...EFFECT_LADDER], ['gtao', 'shadows', 'crowds', 'drones', 'far', 'hdri', 'scale']);
  const steps = [];
  const ladder = createEffectLadder({ budgetMs: 33, window: 10, onStep: (r, on) => steps.push(`${on ? '+' : '-'}${r}`) });
  for (let i = 0; i < 10 * 6; i++) ladder.sample(60);
  assert.deepEqual(steps, ['-gtao', '-shadows', '-crowds', '-drones', '-far', '-hdri']);
  assert.equal(ladder.atScale, true, 'only now does the render scale move');
  for (let i = 0; i < 10 * 3; i++) ladder.sample(60);
  assert.equal(steps.length, 6, 'the ladder stops at the scale');
  ladder.release();
  assert.equal(steps.at(-1), '+hdri', 'back to scale 1: effects come back');
  for (let i = 0; i < 10 * 6; i++) ladder.sample(10);
  assert.equal(ladder.level, 0);
  assert.equal(steps.at(-1), '+gtao');
  // A rung the tier does not have is skipped.
  const s2 = [];
  const l2 = createEffectLadder({ budgetMs: 33, window: 5, available: (r) => r !== 'gtao' && r !== 'shadows', onStep: (r) => s2.push(r) });
  for (let i = 0; i < 5; i++) l2.sample(60);
  assert.deepEqual(s2, ['crowds']);
  // Frames slower than a second (a very slow phone, software 3D) still count:
  // the ladder steps down instead of ignoring them.
  const s3 = [];
  const l3 = createEffectLadder({ budgetMs: 33, window: 5, onStep: (r) => s3.push(r) });
  for (let i = 0; i < 5 * 3; i++) l3.sample(2500);
  assert.deepEqual(s3, ['gtao', 'shadows', 'crowds']);
  // One stall cannot outweigh a window of fast frames.
  const s4 = [];
  const l4 = createEffectLadder({ budgetMs: 33, window: 40, onStep: (r) => s4.push(r) });
  l4.sample(60000); for (let i = 0; i < 39; i++) l4.sample(5);
  assert.deepEqual(s4, []);
  // In the scene: the governor (a lower tier) only once the ladder and the scale are spent.
  assert.match(read('public/kingdom/kingdom-scene.js'), /if \(!ladder \|\| \(ladder\.atScale && \(!renderScale \|\| renderScale\.atMin\)\)\) governor\.sample\(ms, budget\);/);
});

test('Auto never picks a tier that cannot hold 30 fps at scale 1.0; on a phone never Cinematic', () => {
  assert.equal(autoAllowed('cinematic', { coarse: true }), false);
  for (const t of ['legacy', 'phone', 'balanced']) assert.equal(autoAllowed(t, { coarse: true }), true);
  assert.equal(autoAllowed('cinematic', { coarse: false }), true);
  assert.ok(!Object.values(KINGDOM_FROM_AUTO).includes('cinematic'), 'the probe never maps to Cinematic');
  // The start: a phone never starts on Cinematic unless chosen by hand or in the address.
  for (const memory of [2, 4, 8]) assert.notEqual(chooseKingdomStart({ coarse: true, memory }).tier, 'cinematic');
  assert.equal(chooseKingdomStart({ coarse: true, memory: 4, saved: 'cinematic' }).tier, 'cinematic', 'by hand it holds');
  // The probe (run at scale 1.0, before any scaling): the tier it picks fits 30 fps.
  assert.equal(startTier({ coarse: true }), 'low');
  assert.equal(tierFromProbe({ workMs: 40, probed: 'low', coarse: true, memory: 4 }), 'low', 'too slow for more: Low');
  assert.notEqual(tierFromProbe({ workMs: 2, probed: 'low', coarse: true, memory: 4 }), 'high', 'a 4 GB phone never goes past Medium on its own');
  // In the scene: an automatic change to a tier Auto may not pick is refused; the menu marks Cinematic.
  assert.match(read('public/kingdom/kingdom-scene.js'), /if \(!manual && !autoAllowed\(next, \{ coarse \}\)\) return;/);
  assert.equal(CINEMATIC_PHONE_NOTE, 'may look softer on this phone');
  assert.match(read('public/kingdom/kingdom-ui.js'), /cin\.textContent = `Cinematic \(\$\{CINEMATIC_PHONE_NOTE\}\)`/);
});

// --- haze ---------------------------------------------------------------------------------

test('the fog follows the weather, but the first 400 m always stay clear and it never becomes a wall', () => {
  assert.equal(FOG_CLEAR_M, 400);
  for (const state of ['clear', 'partly_cloudy', 'overcast', 'drizzle', 'rain', 'heavy_rain', 'fog', 'snow']) {
    const w = weatherLook({ state, source: 'open-meteo' });
    for (const fogBase of [0.00055, 0.0011]) {
      const d = liveFog({ fogBase, storm: w.dark, fog: w.fog });
      assert.ok(d <= FOG_MAX_DENSITY, `${state}: density ${d}`);
      assert.equal(fogFactorAt(0, d), 0, `${state}: clear at the camera`);
      assert.equal(fogFactorAt(399, d), 0, `${state}: clear at 399 m`);
      assert.ok(fogFactorAt(1500, d) < 0.75, `${state}: the city at 1.5 km still shows`);
    }
  }
  // Real fog still builds in the distance, more than a clear night's haze.
  const fogDay = liveFog({ fog: 1, storm: 0.35 });
  const clearNight = liveFog({ fog: 0, storm: 0 });
  assert.ok(fogFactorAt(2500, fogDay) > fogFactorAt(2500, clearNight) * 2);
  assert.ok(fogFactorAt(2500, fogDay) > 0.4, 'fog shows in the distance');
  // The shader uses the same start (PG1_FOG_START), on the live tiers only.
  const scene = read('public/kingdom/kingdom-scene.js');
  assert.match(scene, /float pg1FogD = max\(vFogDepth - PG1_FOG_START, 0\.0\);/);
  assert.match(scene, /const fogStart = offline \? null : `\$\{FOG_CLEAR_M\.toFixed\(1\)\}`;/);
});

// --- the look table -------------------------------------------------------------------------

test('one look table: every feature has a switch for every tier, phone and computer', () => {
  assert.deepEqual([...LOOK_FEATURES], ['grade', 'sharpen', 'moon', 'glow', 'hdri', 'wet', 'facade']);
  for (const f of LOOK_FEATURES) for (const side of ['phone', 'computer']) for (const t of KINGDOM_TIERS) assert.equal(typeof LOOK_TABLE[f][side][t], 'boolean', `${f}.${side}.${t}`);
  // Medium and up on a phone: the grade, sharpening, moonlight, window glow, the small HDRI and wet streets.
  for (const t of ['phone', 'balanced', 'cinematic']) { const l = lookFor(t, { coarse: true }); assert.ok(l.grade && l.sharpen && l.moon && l.glow && l.hdri && l.wet, t); }
  // Facade detail on a phone only from High up (Medium stays under its draw and triangle budget).
  assert.equal(lookFor('phone', { coarse: true }).facade, false);
  assert.equal(lookFor('balanced', { coarse: true }).facade, true);
  // Low: the night fill and glow only (free), none of the passes.
  assert.deepEqual(lookFor('legacy', { coarse: true }), { grade: false, sharpen: false, moon: true, glow: true, hdri: false, wet: false, facade: false });
  // The settings carry the look.
  assert.deepEqual(kingdomSettings('phone', PHONE).look, lookFor('phone', { coarse: true }));
});

test('?fx= switches one feature or effect, only with ?debug=1 (for measuring its cost)', () => {
  assert.deepEqual(parseFx('?fx=-grade'), {}, 'ignored without debug');
  assert.deepEqual(parseFx('?debug=1&fx=-grade,+facade,-gtao,-nonsense'), { grade: false, facade: true, gtao: false });
  const s = kingdomSettings('cinematic', { coarse: true });
  const { settings, look } = applyFx(s, s.look, { grade: false, bloom: false, shadows: false, fog: false });
  assert.equal(look.grade, false); assert.equal(settings.post.bloom, false); assert.equal(settings.shadows, 0); assert.equal(settings.noFog, true);
  assert.equal(s.post.bloom, true, 'the original is untouched');
});

test('the final pass: the Showcase grade (no grain) and contrast-adaptive sharpening', () => {
  const sh = finishShader();
  for (const u of ['tDiffuse', 'uTexel', 'uSharp', 'uGrade', 'uLift', 'uGain', 'uContrast', 'uSaturation', 'uVignette']) assert.ok(u in sh.uniforms, u);
  assert.match(sh.fragmentShader, /min\(mn, 1\.0 - mx\) \/ max\(mx/, 'sharpening scaled by local contrast');
  assert.doesNotMatch(sh.fragmentShader, /fract\(sin/, 'no grain on a phone');
  assert.deepEqual(Object.keys(LIVE_GRADES), ['night', 'rain', 'dusk', 'day']);
  assert.equal(liveMood({ light: 0.05, rain: 0 }), 'night');
  assert.equal(liveMood({ light: 0.05, rain: 0.6 }), 'rain');
  assert.equal(liveMood({ light: 1, dusk: 0.8 }), 'dusk');
  assert.equal(liveMood({ light: 1 }), 'day');
  // The sharpening is on only when the frame is upscaled (post.js setSize).
  assert.match(read('public/sandbox/post.js'), /u\.uSharp\.value = finish\.userData\.sharpen && outPr > pr \* 1\.01/);
});

test('the A07 default tier (phone Medium) is built lean, on the Low model', () => {
  const s = kingdomSettings('phone', PHONE);
  assert.equal(s.leanDrones, true); assert.equal(s.lowFigures, true); assert.equal(s.ambientSprites, false); assert.equal(s.leanCity, true);
  assert.equal(s.shadows, 0); assert.equal(s.post.gtao, false); assert.equal(s.post.bloom, false); assert.equal(s.post.aa, 'msaa');
  assert.equal(s.targetFps, 30);
  // A computer's Medium is unchanged apart from the final pass.
  const c = kingdomSettings('phone', { coarse: false });
  assert.ok(!c.leanDrones && !c.leanCity);
});

// --- the banner ----------------------------------------------------------------------------------

test('banner wording: "Probes and checks" unless every counted event was a blocked attack', async () => {
  const { countriesText, billboardLines, createEventStore } = await import('../public/kingdom/kingdom-data.js');
  assert.deepEqual([...BLOCKED_ATTACK_KINDS], ['payer_refused']);
  const ev = (kind, cc = 'FR') => ({ role: 'attacker', kind, country_code: cc, count: 1 });
  assert.equal(originsKind([ev('probe'), ev('rate_limited', 'US')]), 'probes_and_checks');
  assert.equal(originsKind([ev('check_verdict'), ev('payer_refused')]), 'probes_and_checks');
  assert.equal(originsKind([ev('payer_refused'), ev('payer_refused', 'US')]), 'blocked');
  assert.equal(originsKind([{ role: 'ally', kind: 'payment_settled', country_code: 'IE' }]), 'probes_and_checks', 'nothing counted');
  assert.equal(originsKind([{ role: 'attacker', kind: 'probe', country_code: null }, ev('payer_refused')]), 'blocked', 'events without a country are not counted');
  assert.equal(countriesText(5), 'Probes and checks from 5 countries · last 24 h');
  assert.equal(countriesText(5, 'blocked'), 'Hostile traffic from 5 countries · last 24 h');
  assert.match(billboardLines({ countries: 3 })[0], /probes and checks/);
  const store = createEventStore();
  store.merge({ origins: [{ country_code: 'US', count: 2 }], origins_kind: 'blocked', events: [] });
  assert.equal(store.originsKind, 'blocked');
  store.merge({ origins: [{ country_code: 'US', count: 2 }], origins_kind: 'probes_and_checks', events: [] });
  assert.equal(store.originsKind, 'probes_and_checks');
  assert.match(read('public/index.html'), /<span id="kingdom-countries-text">Probes and checks from 0 countries · last 24 h<\/span>/);
});
