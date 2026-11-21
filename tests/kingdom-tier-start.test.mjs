/**
 * How PG1 City picks its quality tier (kingdom-scene.js chooseKingdomStart,
 * with the shared probe in public/sandbox/tier-probe.js):
 *
 *   - on screen the tiers are Low, Medium, High (automatic) and Cinematic
 *     (by hand only); the ids legacy, phone, balanced and cinematic are kept;
 *   - a Samsung Galaxy A07 (Android, touch, 4 GB) starts on Low and probes;
 *     on its GPU the probe keeps it on Low (30 fps);
 *   - an iPhone 8-class device is Low without a probe (#422's rule);
 *   - a computer starts on Medium and probes;
 *   - ?quality=low|medium|high|cinematic in the address is the operator's
 *     override for the visit; then a tier kept by hand; then the probe's
 *     last pick on this device.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseKingdomStart, kingdomTierFromParam, KINGDOM_FROM_AUTO, KINGDOM_TO_AUTO, KINGDOM_TIER_LABEL, KINGDOM_TIERS, kingdomSettings } from '../public/kingdom/kingdom-scene.js';
import { tierFromProbe } from '../public/sandbox/tier-probe.js';

const A07 = { profile: { userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-A075F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', screenW: 360, screenH: 800, memory: 4, touch: true }, coarse: true, memory: 4 };
const IPHONE8 = { profile: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', screenW: 375, screenH: 667, touch: true }, coarse: true };
const DESKTOP = { profile: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', screenW: 1920, screenH: 1080, memory: 8 }, coarse: false, memory: 8 };

test('Low, Medium, High and Cinematic on screen; the probe\'s tiers map onto the city\'s', () => {
  assert.deepEqual(KINGDOM_TIERS.map((t) => KINGDOM_TIER_LABEL[t]), ['Low', 'Medium', 'High', 'Cinematic']);
  assert.deepEqual(KINGDOM_FROM_AUTO, { low: 'legacy', medium: 'phone', high: 'balanced' });
  for (const t of ['low', 'medium', 'high']) assert.equal(KINGDOM_TO_AUTO[KINGDOM_FROM_AUTO[t]], t);
  // Low holds 30 fps with no post-processing; Cinematic is never automatic.
  assert.equal(kingdomSettings('legacy').targetFps, 30);
  assert.equal(kingdomSettings('legacy').post, null);
  assert.ok(!Object.values(KINGDOM_FROM_AUTO).includes('cinematic'));
});

test('the Galaxy A07 starts on Low and probes; its GPU keeps it there', () => {
  const s = chooseKingdomStart(A07);
  assert.deepEqual(s, { tier: 'legacy', source: 'probe', probe: true, held: false });
  // Low's render work on a Mali-G57 MC2 class GPU: well over what Medium at 60 fps needs.
  assert.equal(KINGDOM_FROM_AUTO[tierFromProbe({ workMs: 12, probed: KINGDOM_TO_AUTO[s.tier], coarse: true, memory: 4 })], 'legacy');
  // A stronger phone may step up to Medium, never to High on 4 GB.
  assert.equal(KINGDOM_FROM_AUTO[tierFromProbe({ workMs: 3, probed: 'low', coarse: true, memory: 4 })], 'phone');
  assert.equal(KINGDOM_FROM_AUTO[tierFromProbe({ workMs: 0.5, probed: 'low', coarse: true, memory: 4 })], 'phone');
});

test('an iPhone 8 is Low without a probe; a computer starts on Medium and probes', () => {
  assert.deepEqual(chooseKingdomStart(IPHONE8), { tier: 'legacy', source: 'device', probe: false, held: false });
  assert.deepEqual(chooseKingdomStart(DESKTOP), { tier: 'phone', source: 'probe', probe: true, held: false });
});

test('the operator\'s override, a tier kept by hand, the kept probe', () => {
  assert.equal(kingdomTierFromParam('?quality=low'), 'legacy');
  assert.equal(kingdomTierFromParam('?debug=1&quality=medium'), 'phone');
  assert.equal(kingdomTierFromParam('?quality=high'), 'balanced');
  assert.equal(kingdomTierFromParam('?quality=cinematic'), 'cinematic');
  assert.equal(kingdomTierFromParam('?quality=balanced'), 'balanced');
  assert.equal(kingdomTierFromParam('?quality=nope'), null);
  assert.deepEqual(chooseKingdomStart({ ...A07, search: '?quality=high', saved: 'phone' }), { tier: 'balanced', source: 'address', probe: false, held: true });
  assert.deepEqual(chooseKingdomStart({ ...A07, saved: 'phone' }), { tier: 'phone', source: 'manual', probe: false, held: true });
  assert.deepEqual(chooseKingdomStart({ ...DESKTOP, cached: 'high' }), { tier: 'balanced', source: 'probe (kept)', probe: false, held: false });
  assert.deepEqual(chooseKingdomStart({ ...A07, forced: 'cinematic' }), { tier: 'cinematic', source: 'caller', probe: false, held: true });
});

test('mid-rebuild, what the page sets is kept for the new scene, never an error', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/kingdom/kingdom-scene.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!cur\) return REPLAY\.includes\(key\) \? \(\.\.\.args\) => \{ memo\.set\(key, args\); \} : undefined;/);
  // Everything the page calls on each feed update is in REPLAY.
  const replay = /const REPLAY = \[([^\]]+)\]/.exec(src)[1];
  for (const k of ['setThreat', 'setWeather', 'setState', 'setToday', 'setPaused']) assert.ok(replay.includes(`'${k}'`), k);
});
