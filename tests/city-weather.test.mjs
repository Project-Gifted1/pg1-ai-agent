/**
 * PG1 City's real weather (lib/cityWeather.mjs, public/kingdom/kingdom-data.js
 * weatherLook): decoration only.
 *
 *   - every WMO weather code maps to the right state; fog only when really
 *     foggy (the fog codes, or visibility under 1 km);
 *   - the source is Open-Meteo at api.open-meteo.com only (the network
 *     guard's allowlist), read at most every 15 minutes and cached;
 *   - when it cannot be read: a calm, clear sky at the real time of day, never a random storm;
 *   - the weather never changes a count, a caption or the threat level, and
 *     the threat level never changes the weather;
 *   - credited on /docs/attributions (CC BY 4.0).
 * Run with: node --test tests/city-weather.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  stateForCode, weatherFromOpenMeteo, cityWeather, fallbackWeather, moonPhase, __resetCityWeather,
  WEATHER_URL, WEATHER_CACHE_MS, WEATHER_STATES, WEATHER_ATTRIBUTION
} from '../lib/cityWeather.mjs';
import { ALLOWED_DATA_HOSTS, assertAllowedDataHost } from '../lib/netGuard.mjs';
import { weatherLook, normalizeWeather, FALLBACK_WEATHER, WEATHER_STATES as VIEW_STATES, eventLine, normalizeEvent } from '../public/kingdom/kingdom-data.js';
import { aggregateEvents, threatLevel, gadgetCounts, dayTotals } from '../lib/defenseFeed.mjs';
import { createDefenseFeedHandler, __resetDefenseFeedCache } from '../api/defense-feed.mjs';
import { attributionsMarkdown, WEATHER_SOURCE } from '../lib/attributions.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('every WMO weather code maps to the right state', () => {
  const cases = {
    clear: [0, 1], partly_cloudy: [2], overcast: [3], fog: [45, 48],
    drizzle: [51, 53, 55, 56, 57], rain: [61, 63, 66, 80, 81], heavy_rain: [65, 67, 82, 95, 96, 99],
    snow: [71, 73, 75, 77, 85, 86]
  };
  for (const [state, codes] of Object.entries(cases)) for (const c of codes) assert.equal(stateForCode(c), state, `code ${c}`);
  for (let c = 0; c <= 99; c++) assert.ok(WEATHER_STATES.includes(stateForCode(c)), `code ${c} maps to a known state`);
  // Fog only when it really is: a low visibility turns a dry sky to fog, never a wet one.
  assert.equal(stateForCode(3, { visibility: 600 }), 'fog');
  assert.equal(stateForCode(3, { visibility: 4000 }), 'overcast');
  assert.equal(stateForCode(63, { visibility: 600 }), 'rain');
  assert.deepEqual([...VIEW_STATES].sort(), [...WEATHER_STATES].sort(), 'the view knows every state');
});

test('an Open-Meteo answer becomes the view\'s weather (wind, cloud, day or night, the moon)', () => {
  const w = weatherFromOpenMeteo({ current: { time: '2026-11-11T21:00', weather_code: 63, cloud_cover: 96, wind_speed_10m: 42, wind_gusts_10m: 70, precipitation: 2.4, is_day: 0, visibility: 9000, temperature_2m: 8.1 } }, Date.parse('2026-11-11T21:00:00Z'));
  assert.equal(w.state, 'rain');
  assert.equal(w.source, 'open-meteo');
  assert.equal(w.is_day, false);
  assert.ok(w.wind > 0.5 && w.wind <= 1);
  assert.ok(w.cloud > 0.9);
  assert.equal(w.attribution, WEATHER_ATTRIBUTION);
  assert.ok(w.moon_phase >= 0 && w.moon_phase < 1);
  // A known full moon (2026-10-26) and new moon (2026-11-09), roughly.
  assert.ok(Math.abs(moonPhase(Date.parse('2026-10-26T04:12:00Z')) - 0.5) < 0.05);
  assert.ok(Math.min(moonPhase(Date.parse('2026-11-09T07:02:00Z')), 1 - moonPhase(Date.parse('2026-11-09T07:02:00Z'))) < 0.05);
});

test('the source: api.open-meteo.com only, read at most every 15 minutes, cached', async () => {
  assert.deepEqual(ALLOWED_DATA_HOSTS, ['api.open-meteo.com']);
  assert.equal(new URL(WEATHER_URL).hostname, 'api.open-meteo.com');
  assert.throws(() => assertAllowedDataHost('https://api.weather.example/v1'), /allowlist/);
  assert.throws(() => assertAllowedDataHost('http://api.open-meteo.com/v1'), /https/);
  assert.equal(WEATHER_CACHE_MS, 15 * 60 * 1000);
  __resetCityWeather();
  let calls = 0;
  const fetchImpl = async (url) => { calls++; assert.equal(url, WEATHER_URL); return new Response(JSON.stringify({ current: { weather_code: 2, cloud_cover: 40, wind_speed_10m: 12, is_day: 1 } }), { status: 200 }); };
  const t0 = Date.parse('2026-11-11T12:00:00Z');
  const a = await cityWeather({ fetchImpl, now: t0 });
  const b = await cityWeather({ fetchImpl, now: t0 + 14 * 60 * 1000 });
  assert.equal(calls, 1, 'cached for 15 minutes');
  assert.equal(a, b);
  await cityWeather({ fetchImpl, now: t0 + 15 * 60 * 1000 + 1 });
  assert.equal(calls, 2);
  __resetCityWeather();
});

test('when it cannot be read: a calm, clear sky, never a storm', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('network'); },
    async () => new Response('busy', { status: 503 }),
    async () => new Response('{"nope":1}', { status: 200 }),
    async () => new Response('not json', { status: 200 })
  ]) {
    __resetCityWeather();
    const w = await cityWeather({ fetchImpl, now: Date.now() });
    assert.equal(w.state, 'clear'); assert.equal(w.wind, 0); assert.equal(w.rain, 0); assert.equal(w.evening, true); assert.equal(w.source, 'fallback');
  }
  // A failure is cached briefly too: the source is never hammered.
  __resetCityWeather();
  let calls = 0; const failing = async () => { calls++; throw new Error('down'); };
  const t0 = Date.now();
  await cityWeather({ fetchImpl: failing, now: t0 }); await cityWeather({ fetchImpl: failing, now: t0 + 60000 });
  assert.equal(calls, 1);
  __resetCityWeather();
  // The view falls back the same way for anything it cannot read.
  for (const bad of [null, undefined, {}, { state: 'tornado' }, 'rain']) {
    const look = weatherLook(bad);
    assert.equal(look.state, 'clear'); assert.equal(look.rain, 0); assert.equal(look.evening, true);
  }
  assert.equal(normalizeWeather({ state: 'fog' }).state, 'fog');
  assert.equal(FALLBACK_WEATHER.state, 'clear');
  assert.deepEqual(fallbackWeather(0).state, 'clear');
});

test('each state looks like itself: rain and wet roads only when it rains, fog only in fog, stars only under clear skies', () => {
  const L = (state, extra = {}) => weatherLook({ state, source: 'open-meteo', cloud: 0.5, ...extra });
  assert.equal(L('clear').rain, 0); assert.equal(L('clear').sun, 1); assert.equal(L('clear').stars, 1);
  assert.ok(L('partly_cloudy', { cloud: 0.5 }).cover > L('clear', { cloud: 0.1 }).cover);
  assert.ok(L('overcast').cover > L('partly_cloudy', { cloud: 0.5 }).cover);
  assert.equal(L('overcast').sun, 0); assert.equal(L('overcast').rain, 0);
  assert.ok(L('drizzle').rain > 0 && L('drizzle').rain < L('rain').rain);
  assert.ok(L('heavy_rain').heavy === 1 && L('heavy_rain').rain === 1);
  for (const s of ['rain', 'heavy_rain']) assert.equal(L(s).wet, 1);
  assert.equal(L('fog').fog, 1);
  for (const s of WEATHER_STATES) if (s !== 'fog') assert.ok(L(s).fog <= 0.2, `${s} is not foggy`);
  assert.ok(L('snow').snow === 1);
  assert.equal(L('clear', { wind: 0.8 }).wind, 0.8, 'wind passes through');
});

test('the weather never changes a count or a caption, and the threat level never changes the weather', () => {
  const now = Date.now();
  const raw = [{ at: now - 1000, kind: 'probe', gadget: 'gate_wardens', role: 'attacker', severity: 'low', country: 'JP', caller: 'abcd1234', endpoint: '/api/mcp', check: 'tool_router', verdict: 'UNKNOWN_TOOL', reasons: [], source: 'telemetry' }];
  const events = aggregateEvents(raw);
  const before = { threat: threatLevel(events, now), today: gadgetCounts(events, now), day: dayTotals(events, now), line: eventLine(normalizeEvent(events[0])) };
  for (const s of WEATHER_STATES) weatherLook({ state: s, source: 'open-meteo' });
  assert.deepEqual({ threat: threatLevel(events, now), today: gadgetCounts(events, now), day: dayTotals(events, now), line: eventLine(normalizeEvent(events[0])) }, before);
  // The scene: the sky follows the weather (look.dark), the threat only lights PG1's rovers.
  const scene = read('public/kingdom/kingdom-scene.js');
  assert.match(scene, /storm \+= \(look\.dark - storm\)/);
  assert.doesNotMatch(scene, /storm \+= \(\(threat ===/);
  assert.match(scene, /actors\.update\(dt, t, camera, \{ storm: alarm \}\)/);
  // No weather word in any caption or ticker line, and no attacker drawn as weather.
  const data = read('public/kingdom/kingdom-data.js');
  for (const fn of ['eventLine', 'captionLine', 'tickerLine', 'defenceLine', 'enemyLine']) {
    const body = data.slice(data.indexOf(`export function ${fn}`), data.indexOf('\n}\n', data.indexOf(`export function ${fn}`)));
    // ("the fog" is the Fog Wall: calls with no country, not weather.)
    assert.doesNotMatch(body.replace(/the fog/g, ''), /weather|rain|fog|cloud|storm/i, `${fn} mentions weather`);
  }
  assert.doesNotMatch(read('public/kingdom/kingdom-actors.js'), /weather|rain-streaks|look\.rain/);
});

test('the feed carries the weather on full loads only, read through the cache; credited on /docs/attributions', async () => {
  __resetDefenseFeedCache();
  let reads = 0;
  const weather = async () => { reads++; return { state: 'rain', source: 'open-meteo' }; };
  const handler = createDefenseFeedHandler({ session: async () => ({ isOperator: true }), vault: { supUrl: null, supKey: null }, weather, buildState: async () => null });
  const res = () => ({ code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
  const full = res(); await handler({ method: 'GET', headers: {}, query: {} }, full);
  assert.equal(full.body.weather.state, 'rain');
  const poll = res(); await handler({ method: 'GET', headers: {}, query: { since: String(Date.now() - 5000) } }, poll);
  assert.equal(poll.body.weather, undefined, 'polls do not carry it');
  assert.equal(reads, 1);
  __resetDefenseFeedCache();
  const md = attributionsMarkdown();
  assert.match(md, /Open-Meteo/);
  assert.match(md, /CC-BY 4\.0/);
  assert.equal(WEATHER_SOURCE.licence, 'CC-BY 4.0');
  assert.ok(read('public/docs/attributions/index.html').includes('Open-Meteo'), 'the built page is up to date');
});
