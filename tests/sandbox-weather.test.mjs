/**
 * The Sandbox viewer's weather (public/sandbox/weather.js) and what it draws
 * (atmosphere.js): visual only, deterministic, by each island's climate.
 *
 *   - the same world, island and tick always give the same weather;
 *   - islands differ (rain over one, sun over another);
 *   - tropical islands (all of Benin–Warri's land) never get snow; cold ones do;
 *   - mist only in the morning;
 *   - no jumps: tick to tick, nothing changes by more than a small step;
 *   - every climate sees fair and wet spells over a month;
 *   - rain, snow and birds are sized per tier, and the simulation never
 *     reads the weather (no import of it outside the viewer).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { weatherAt, weatherWord, WEATHER_LOOK, CLIMATE_WEATHER, SPELL_HOURS } from '../public/sandbox/weather.js';
import { ATMOSPHERE_COUNTS } from '../public/sandbox/atmosphere.js';

const DAY = 240;
const month = (climate, key = 'island-a', seed = 4041) => Array.from({ length: DAY * 30 }, (_, tick) => weatherAt({ seed, key, tick, daySteps: DAY, climate }));

test('deterministic: the same world, island and tick give the same weather', () => {
  for (const tick of [0, 17, 240, 999, 7200]) {
    assert.deepEqual(weatherAt({ seed: 9, key: 'island-x', tick, climate: 'maritime' }), weatherAt({ seed: 9, key: 'island-x', tick, climate: 'maritime' }));
  }
  const a = month('temperate', 'island-a').map((w) => w.state).join();
  const b = month('temperate', 'island-b').map((w) => w.state).join();
  assert.notEqual(a, b, 'each island has its own weather');
});

test('by climate: no snow in the tropics (Benin–Warri), snow on cold islands, mist only in the morning', () => {
  const tropical = month('tropical');
  assert.ok(tropical.every((w) => w.snow === 0 && w.state !== 'snow'), 'never snow in the tropics');
  assert.ok(tropical.some((w) => w.state === 'storm') && tropical.some((w) => w.state === 'clear'), 'sun and thunderstorms');
  assert.ok(month('cold').some((w) => w.state === 'snow'), 'snow on a cold island');
  for (const c of Object.keys(CLIMATE_WEATHER)) {
    const m = month(c);
    assert.ok(m.some((w) => w.rain > 0.2 || w.snow > 0.2), `${c}: wet spells`);
    assert.ok(m.some((w) => w.dark < 0.1), `${c}: fair spells`);
    for (let tick = 0; tick < m.length; tick++) {
      if (m[tick].state !== 'mist' || m[tick].blend > 0) continue;
      const hour = ((tick / DAY) * 24 + 6) % 24;
      assert.ok(hour >= 6 && hour < 12, `${c}: mist at ${hour.toFixed(1)}h`);
    }
  }
  // Benin–Warri's islands are tropical or maritime: neither ever snows.
  assert.ok(!('snow' in CLIMATE_WEATHER.tropical) && !('snow' in CLIMATE_WEATHER.maritime));
});

test('no jumps: a spell blends into the next over its last hour', () => {
  for (const c of Object.keys(CLIMATE_WEATHER)) {
    const m = month(c);
    let worst = 0;
    for (let i = 1; i < m.length; i++) for (const n of ['cloud', 'rain', 'snow', 'wind', 'fog', 'dark']) worst = Math.max(worst, Math.abs(m[i][n] - m[i - 1][n]));
    // One tick is 6 minutes at 240 a day; a full change takes an hour (10 ticks).
    assert.ok(worst <= 0.2, `${c}: a change of ${worst} in one tick`);
  }
  assert.equal(SPELL_HOURS, 6);
});

test('each state looks like itself; the clock names only what is not fair', () => {
  for (const [s, l] of Object.entries(WEATHER_LOOK)) for (const n of ['cloud', 'rain', 'snow', 'wind', 'fog', 'dark']) assert.ok(l[n] >= 0 && l[n] <= 1, `${s}.${n}`);
  assert.ok(WEATHER_LOOK.storm.lightning && !WEATHER_LOOK.rain.lightning);
  assert.equal(WEATHER_LOOK.clear.rain, 0);
  assert.equal(weatherWord({ state: 'clear' }), '');
  assert.equal(weatherWord({ state: 'partly_cloudy' }), '');
  assert.equal(weatherWord({ state: 'storm' }), 'thunderstorm');
  assert.equal(weatherWord(null), '');
});

test('rain, snow and birds per tier; the simulation never reads the weather', () => {
  const order = ['low', 'medium', 'high'];
  for (let i = 1; i < order.length; i++) for (const n of ['rain', 'snow', 'birds']) assert.ok(ATMOSPHERE_COUNTS[order[i]][n] >= ATMOSPHERE_COUNTS[order[i - 1]][n], `${n} grows with the tier`);
  assert.ok(ATMOSPHERE_COUNTS.low.rain <= 1000, 'Low stays light');
  const lib = readdirSync(new URL('../lib/sandbox/', import.meta.url)).filter((f) => f.endsWith('.mjs'));
  for (const f of lib) assert.doesNotMatch(readFileSync(new URL(`../lib/sandbox/${f}`, import.meta.url), 'utf8'), /weather\.js|atmosphere\.js/, `${f} must not read the viewer's weather`);
  const scene = readFileSync(new URL('../public/sandbox/sandbox-scene.js', import.meta.url), 'utf8');
  assert.match(scene, /weatherAt\(\{ seed: world\.seed, key: best \? best\.id : 'world', tick: tickF/);
});
