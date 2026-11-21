/**
 * PG1 City's real Dublin weather (lib/cityWeather.mjs): the cache and the
 * fallback, beyond tests/city-weather.test.mjs.
 *
 *   - read server-side, cached for at least 10 minutes (15 today);
 *   - requests that arrive while a read is in progress share it: one read,
 *     however many phones open the city at once;
 *   - a source that hangs is cut off after WEATHER_TIMEOUT_MS and the city
 *     gets the calm, clear sky; a failure is cached briefly (never hammered),
 *     and the real weather comes back once the source answers again;
 *   - the browser never asks Open-Meteo itself, and the feed's poll is not
 *     made more frequent.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cityWeather, __resetCityWeather, WEATHER_CACHE_MS, WEATHER_FAIL_CACHE_MS, WEATHER_TIMEOUT_MS, WEATHER_URL } from '../lib/cityWeather.mjs';
import { KINGDOM_POLL_MS } from '../public/kingdom/kingdom-ui.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OK = () => new Response(JSON.stringify({ current: { weather_code: 61, cloud_cover: 90, wind_speed_10m: 20, precipitation: 1.2, is_day: 1, time: '2026-11-21T12:00' } }), { status: 200 });

beforeEach(() => __resetCityWeather());

test('cached for at least 10 minutes', async () => {
  assert.ok(WEATHER_CACHE_MS >= 10 * 60 * 1000, `${WEATHER_CACHE_MS} ms`);
  let calls = 0; const fetchImpl = async () => { calls++; return OK(); };
  const t0 = Date.parse('2026-11-21T12:00:00Z');
  for (let m = 0; m < 10; m++) await cityWeather({ fetchImpl, now: t0 + m * 60000 });
  assert.equal(calls, 1, 'one read in ten minutes');
  const w = await cityWeather({ fetchImpl, now: t0 + 9.99 * 60000 });
  assert.equal(w.state, 'rain'); assert.equal(w.source, 'open-meteo');
});

test('requests during a read share it', async () => {
  let calls = 0; let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async () => { calls++; await gate; return OK(); };
  const now = Date.now();
  const all = Promise.all(Array.from({ length: 25 }, () => cityWeather({ fetchImpl, now })));
  release();
  const out = await all;
  assert.equal(calls, 1, '25 requests, one read');
  assert.ok(out.every((w) => w === out[0] && w.state === 'rain'));
});

test('a source that hangs is cut off: the calm, clear sky, in time', { timeout: WEATHER_TIMEOUT_MS + 5000 }, async () => {
  const hang = (url, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted'))); });
  const t = Date.now();
  // (AbortSignal.timeout's timer does not hold the event loop open; this does.)
  const keep = setTimeout(() => {}, WEATHER_TIMEOUT_MS + 4000);
  const w = await cityWeather({ fetchImpl: hang, now: t });
  clearTimeout(keep);
  assert.ok(Date.now() - t < WEATHER_TIMEOUT_MS + 1500, 'cut off at the timeout');
  assert.equal(w.state, 'clear'); assert.equal(w.source, 'fallback'); assert.equal(w.rain, 0); assert.equal(w.wind, 0);
});

test('after a failure: the fallback is cached briefly, then the real weather comes back', async () => {
  let up = false; let calls = 0;
  const fetchImpl = async () => { calls++; if (!up) throw new Error('down'); return OK(); };
  const t0 = Date.parse('2026-11-21T12:00:00Z');
  assert.equal((await cityWeather({ fetchImpl, now: t0 })).source, 'fallback');
  up = true;
  assert.equal((await cityWeather({ fetchImpl, now: t0 + WEATHER_FAIL_CACHE_MS - 1 })).source, 'fallback', 'not asked again yet');
  assert.equal(calls, 1);
  const back = await cityWeather({ fetchImpl, now: t0 + WEATHER_FAIL_CACHE_MS + 1 });
  assert.equal(back.source, 'open-meteo'); assert.equal(back.state, 'rain');
  assert.equal(calls, 2);
});

test('the browser never asks Open-Meteo, and the feed poll is no more frequent', () => {
  const host = new URL(WEATHER_URL).hostname;
  const files = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
  for (const f of files(join(ROOT, 'public')).filter((x) => /\.(js|mjs|html)$/.test(x))) assert.ok(!readFileSync(f, 'utf8').includes(host), `${f} must not call ${host}`);
  assert.ok(KINGDOM_POLL_MS >= 5000, 'the feed poll stays at 5 s or slower');
});
