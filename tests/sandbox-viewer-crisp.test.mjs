/**
 * The Sandbox viewer: crisp space, clear planets, smooth on the phone.
 *   1. space: no depth of field in space or with nothing nearby followed;
 *      TAA unjittered and bloom held under the stars; stars and the galaxy
 *      band at least 2 px and below bloom's threshold
 *   2. planet fog from each world's air: the ground clear for 20 to 40 km,
 *      a light haze at the horizon, thinner with height; never on the sky
 *      or the stars; no tier thickens it
 *   3. smoothness: Cinematic lowers its render scale over 33 ms a frame;
 *      phones cap the shadow map at 4096 and scale foliage by device; the
 *      frame loop allocates nothing; a step's answer carries only what
 *      changed, and the page rebuilds exactly the same world from it
 *
 * Run with: node --test tests/sandbox-viewer-crisp.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STAR_PX, STAR_PEAK } from '../public/sandbox/environment.js';
import { STAR_BLOOM_FLOOR } from '../public/sandbox/post.js';
import { ATMOSPHERE, fogAmount, fogDensityFor } from '../public/sandbox/surface.js';
import { TIER_SETTINGS, deviceSettings, createRenderScale, PHONE_SHADOW_MAP } from '../public/sandbox/quality.js';
import { entitySnapshot, worldChanges } from '../lib/sandbox/stepDiff.mjs';
import { createSandboxStore, __resetSandboxMemory } from '../lib/sandbox/store.mjs';
import { createWorld, pg1Principal } from '../lib/sandbox/worlds.mjs';
import sandboxViewer, { __setSandboxViewerStore } from '../api/sandbox.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (f) => readFileSync(new URL(f, ROOT), 'utf8');

// --- 1. space -------------------------------------------------------------------------------

test('1: in space, or with nothing nearby followed, there is no depth of field; TAA is unjittered; bloom never smears the stars', () => {
  const post = read('public/sandbox/post.js');
  assert.match(post, /setSky\(on\) \{ skyView = !!on; if \(bokeh && skyView\) bokeh\.enabled = false; \}/);
  assert.match(post, /bokeh\.enabled = d != null && !skyView;/, 'focus null: depth of field off');
  assert.match(post, /taa\.sampleLevel = skyView \? 0 : 2; taa\.accumulate = !!still && !skyView;/, 'one unjittered sample in space');
  assert.match(post, /bloom\.threshold = Math\.max\(STAR_BLOOM_FLOOR,/);
  const scene = read('public/sandbox/sandbox-scene.js');
  assert.match(scene, /const skyView = effAlt > world\.spaceAlt \|\| mode === 'space' \|\| envState\.space > 0\.5;/);
  assert.match(scene, /post\.setSky\(skyView\)/);
  assert.match(scene, /const followNear = selectedId && \(mode === 'follow' \|\| mode === 'tour'\) && controls\.dist < FOCUS_NEAR;/);
  assert.match(scene, /post\.setFocus\(followNear \? controls\.dist : null\)/);
});

test('1: stars and the galaxy band are at least 2 px and just below bloom\'s threshold', () => {
  assert.ok(STAR_PX >= 2);
  assert.ok(STAR_PEAK < STAR_BLOOM_FLOOR, 'the brightest star stays under the bloom threshold');
  const env = read('public/sandbox/environment.js');
  assert.match(env, /const starMat = new THREE\.PointsMaterial\(\{ size: coarse \? STAR_PX \+ 0\.5 : STAR_PX, sizeAttenuation: false/);
  assert.match(env, /const band = new THREE\.Points\(gg, new THREE\.PointsMaterial\(\{ size: STAR_PX, sizeAttenuation: false/);
  assert.equal((env.match(/STAR_PEAK \/ Math\.max\(/g) || []).length, 2, 'stars and the band capped');
  assert.match(read('public/sandbox/surface.js'), /new THREE\.PointsMaterial\(\{ color: 0xd9d9d9, size: 2, sizeAttenuation: false/);
});

test('1: from space the sky is black from the space altitude up, and the sea never reflects day-blue', () => {
  const env = read('public/sandbox/environment.js');
  assert.match(env, /env\.space = smooth\(spaceAlt \* 0\.45, spaceAlt, cameraAlt\);/);
  assert.match(env, /u\.uZenith\.value\.copy\(skyU\.uTop\.value\)\.lerp\(SPACE_SEA_SKY, sp\); u\.uHorizon\.value\.copy\(skyU\.uHorizon\.value\)\.lerp\(SPACE_SEA_SKY, sp\);/);
  assert.match(env, /\.lerp\(SPACE_SEA, sp\); continue; \}/);
});

// --- 2. planet fog --------------------------------------------------------------------------------

test('2: each planet\'s air: the ground clear for 20 to 40 km, a light haze at the horizon, thinner with height', () => {
  for (const kind of ['ice', 'ocean', 'alien']) {
    const a = ATMOSPHERE[kind];
    assert.ok(a.visibility >= 20000 && a.visibility <= 40000, `${kind}: visibility ${a.visibility} m`);
    assert.ok(fogAmount(kind, 5000) < 0.05, `${kind}: 5 km is clear`);
    assert.ok(fogAmount(kind, 20000) < 0.5, `${kind}: 20 km is still clearly visible (${fogAmount(kind, 20000).toFixed(2)})`);
    assert.ok(Math.abs(fogAmount(kind, a.visibility) - 0.5) < 1e-9, 'half fog at the visibility');
    assert.ok(fogAmount(kind, 30000) < 0.75, `${kind}: a light haze at the horizon (${fogAmount(kind, 30000).toFixed(2)})`);
    assert.ok(fogAmount(kind, 30000, 1500) < fogAmount(kind, 30000, 0), 'thinner higher up');
  }
  assert.equal(fogAmount('rocky', 30000), 0, 'no air, no fog');
  // The old fog: 0.00022 a metre hid everything past a few kilometres.
  const old = (d) => 1 - Math.exp(-((0.00022 * d) ** 2));
  assert.ok(old(10000) > 0.99 && fogAmount('ocean', 10000) < 0.1);
  assert.ok(Math.abs(fogDensityFor(32000) - 2.6e-5) < 1e-6);
  const surface = read('public/sandbox/surface.js');
  assert.match(surface, /if \(air\) scene\.fog = new THREE\.FogExp2\(new THREE\.Color\(sky\.horizon\), fogDensityFor\(air\.visibility\)\);/);
  assert.match(surface, /side: THREE\.BackSide, depthWrite: false, fog: false/, 'the sky is never fogged');
  assert.match(surface, /opacity: sky\.air \? 0\.35 : 0\.9, depthWrite: false, fog: false/, 'nor the stars');
  assert.match(surface, /if \(!material \|\| !material\.fog \|\| material\.isShaderMaterial/, 'height fog only where fog is on');
  assert.match(surface, /const FAR = 60000;/, 'ground to the horizon');
  // No tier thickens the fog: nothing in the tiers, post-processing or the scene sets fog by quality.
  for (const f of ['public/sandbox/quality.js', 'public/sandbox/post.js']) assert.doesNotMatch(read(f), /fog/i, `${f} never touches the fog`);
  assert.doesNotMatch(read('public/sandbox/sandbox-scene.js'), /fog\.density|FogExp2/);
});

// --- 3. smoothness -----------------------------------------------------------------------------------

test('3: Cinematic lowers its render scale when frames run over 33 ms, and raises it again when they are fast', () => {
  const changes = [];
  const rs = createRenderScale({ onChange: (s) => changes.push(s) });
  for (let i = 0; i < 30; i++) rs.sample(60);
  assert.ok(rs.scale < 1 && rs.scale >= 0.5, `scale ${rs.scale}`);
  for (let i = 0; i < 300; i++) rs.sample(120);
  assert.equal(rs.scale, 0.5, 'never below half');
  for (let i = 0; i < 600; i++) rs.sample(10);
  assert.equal(rs.scale, 1);
  assert.ok(changes.length >= 3);
  const scene = read('public/sandbox/sandbox-scene.js');
  assert.match(scene, /const renderScale = createRenderScale\(\{ budgetMs: \(1000 \/ targetFps\) \* 1\.15, min: coarse && tier !== 'cinematic' \? 0\.65 : 0\.5,/);
  // On a phone: fewer pixels first (every effect kept); the tier steps down only once that is not enough.
  assert.match(scene, /if \(!scaling\(\) \|\| renderScale\.atMin\) governor\.sample\(ms\);/);
  const phone = createRenderScale({ min: 0.65 });
  for (let i = 0; i < 400; i++) phone.sample(120);
  assert.equal(phone.atMin, true);
  assert.equal(phone.scale, 0.65);
  assert.match(scene, /const scaling = \(\) => tier === 'cinematic' \|\| recording \|\| coarse;/);
  assert.match(scene, /\* \(renderScale && scaling\(\) \? renderScale\.scale : 1\)/);
});

test('3: on a phone the shadow map is at most 4096 and foliage scales with the device', () => {
  assert.equal(PHONE_SHADOW_MAP, 4096);
  const phone = deviceSettings(TIER_SETTINGS.cinematic, { coarse: true, memory: 4, cores: 4 });
  assert.equal(phone.shadowMapSize, 4096);
  assert.equal(deviceSettings(TIER_SETTINGS.cinematic, { coarse: false, memory: 16, cores: 16 }).shadowMapSize, 8192, 'a desktop keeps 8192');
  assert.equal(phone.foliage, Math.round(TIER_SETTINGS.cinematic.foliage * 0.6 * 0.6 * 0.75));
  assert.equal(deviceSettings(TIER_SETTINGS.high, { coarse: true, memory: 8, cores: 8 }).foliage, Math.round(TIER_SETTINGS.high.foliage * 0.6));
  assert.equal(deviceSettings(TIER_SETTINGS.low, { coarse: true }).foliage, 0);
});

// The body of a function in a source file (up to its matching brace).
function bodyOf(src, head) {
  const i = src.indexOf(head);
  assert.ok(i >= 0, head);
  let depth = 0; let j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (!depth) return src.slice(j, k + 1); } }
  return '';
}

test('3: the frame loop allocates nothing: no arrays, object literals, closures or getBoundingClientRect each frame', () => {
  const scene = read('public/sandbox/sandbox-scene.js');
  const frame = bodyOf(scene, 'function frame(now) {');
  const animate = bodyOf(scene, 'function animate(dt, now) {');
  for (const [name, body] of [['frame', frame], ['animate', animate]]) {
    assert.doesNotMatch(body, /env\.update\(\{|foliage\.place\(\{|getBoundingClientRect|\.traverse\(\(/, `${name}`);
    assert.doesNotMatch(body, /new THREE\./, `${name}: no new objects`);
  }
  assert.match(frame, /const clk = clockAt\(tickF\);/);
  assert.match(frame, /if \(clockKey !== lastClockKey\)/, 'the clock text changes once a simulated minute');
  const tags = bodyOf(scene, 'function updateTags(now) {');
  assert.doesNotMatch(tags.slice(tags.indexOf('let nPlaced')), /\.forEach\(|placed\.push|getBoundingClientRect/);
  assert.match(read('public/sandbox/environment.js'), /envOut\.day = day; envOut\.night = env\.night;/);
});

test('3: a step\'s answer carries only what changed, far smaller, and the page rebuilds exactly the same world', async (t) => {
  __resetSandboxMemory();
  process.env.USER_API_KEY = 'op-crisp'; process.env.USER_API_PASS = 'pass-crisp-sandbox';
  const store = createSandboxStore();
  __setSandboxViewerStore(() => store);
  const call = async (body) => { const r = { statusCode: null, body: null, setHeader() {}, getHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } }; await sandboxViewer({ method: 'POST', headers: {}, socket: { remoteAddress: '10.42.0.1' }, body: { ...body, user: 'op-crisp', pass: 'pass-crisp-sandbox' } }, r); return r; };
  const w = await createWorld(store, pg1Principal(), { name: 'Universe', template: 'universe' });
  let had = (await call({ op: 'world', id: w.id })).body.world;
  // The page's own merge, from public/index.html.
  const html = read('public/index.html');
  const src = bodyOf(html, 'function mergeSandboxChanges(had, w) {');
  const merge = new Function('had', 'w', src.slice(1, -1));
  const full = []; const diff = [];
  for (let i = 0; i < 5; i++) {
    const d = await call({ op: 'step', id: w.id, since: had.tick, have_roads: true });
    assert.equal(d.statusCode, 200);
    assert.ok(d.body.world.changes, 'only the changes');
    assert.equal(d.body.world.entities, undefined);
    assert.equal(d.body.world.roads, undefined, 'the roads it has are not sent again');
    diff.push(JSON.stringify(d.body).length);
    const merged = merge(had, d.body.world);
    const truth = (await call({ op: 'world', id: w.id })).body.world;
    full.push(JSON.stringify({ ok: true, world: truth }).length);
    assert.deepEqual(merged.entities, truth.entities, `step ${i + 1}: the same entities`);
    assert.equal(merged.tick, truth.tick);
    assert.ok(merged.roads && merged.roads.edges.length === truth.roads.edges.length, 'the roads kept');
    had = merged;
  }
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  t.diagnostic(`universe step answer: ${avg(diff)} bytes with only the changes, ${avg(full)} bytes whole`);
  assert.ok(avg(diff) < avg(full) * 0.6, `a step's answer: ${avg(diff)} bytes instead of ${avg(full)}`);
  // A viewer behind (another tick): the whole world, as before.
  const behind = await call({ op: 'step', id: w.id, since: 0, have_roads: true });
  assert.ok(Array.isArray(behind.body.world.entities));
  assert.equal(merge(had, { changes: { from: 999999 } }), null, 'not the world it has: asked for whole');
  const snap = entitySnapshot([{ id: 'a', x: 1 }, { id: 'b', x: 1 }]);
  assert.deepEqual(worldChanges(snap, [{ id: 'a', x: 2 }, { id: 'c', x: 1 }]), { upserts: [{ id: 'a', x: 2 }, { id: 'c', x: 1 }], removed: ['b'] });
});
