// PG1 City's weather: the real current weather in Dublin, for the sky only.
//
// Decoration, never an event: the weather never changes a threat count, a
// caption, the ticker or the HUD, and nothing PG1's attackers do is drawn as
// weather (lib/defenseFeed.mjs threatLevel stays the Rate Shield's alone).
//
// Source: Open-Meteo's free forecast API (no key; data CC BY 4.0, credited on
// /docs/attributions), host api.open-meteo.com only (lib/netGuard.mjs
// ALLOWED_DATA_HOSTS). Read server-side at most once every 15 minutes per
// instance and cached; a failed read is cached too (for 5 minutes), so a
// slow or broken source is never hammered. When it cannot be read the city
// shows a calm, clear evening: never a random storm.
//
//   cityWeather({ fetchImpl, now })  -> the view's weather object
//   weatherFromOpenMeteo(json, now)  -> the same, from a response (pure)
//   stateForCode(code, extras)       -> one of WEATHER_STATES (pure)
//   moonPhase(ms)                    -> 0 new .. 0.5 full .. 1 new (pure)

import { assertAllowedDataHost } from './netGuard.mjs';

export const DUBLIN = Object.freeze({ latitude: 53.3498, longitude: -6.2603 });
export const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${DUBLIN.latitude}&longitude=${DUBLIN.longitude}&current=weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,precipitation,is_day,visibility,temperature_2m&timezone=Europe%2FDublin`;
export const WEATHER_CACHE_MS = 15 * 60 * 1000;
export const WEATHER_FAIL_CACHE_MS = 5 * 60 * 1000;
export const WEATHER_TIMEOUT_MS = 3000;
export const WEATHER_ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';
export const WEATHER_STATES = Object.freeze(['clear', 'partly_cloudy', 'overcast', 'drizzle', 'rain', 'heavy_rain', 'fog', 'snow']);

// WMO weather interpretation codes (the ones Open-Meteo returns) -> state.
// Fog only for the fog codes, or a measured visibility under 1 km: "really
// foggy", never a guess.
export function stateForCode(code, { visibility = null } = {}) {
  const c = Number(code);
  let s;
  if (c === 0 || c === 1) s = 'clear';
  else if (c === 2) s = 'partly_cloudy';
  else if (c === 3) s = 'overcast';
  else if (c === 45 || c === 48) s = 'fog';
  else if (c >= 51 && c <= 57) s = 'drizzle';
  else if (c === 61 || c === 80 || c === 66) s = 'rain';
  else if (c === 63 || c === 81) s = 'rain';
  else if (c === 65 || c === 67 || c === 82 || c === 95 || c === 96 || c === 99) s = 'heavy_rain';
  else if ((c >= 71 && c <= 77) || c === 85 || c === 86) s = 'snow';
  else s = 'clear';
  if (Number.isFinite(visibility) && visibility < 1000 && (s === 'clear' || s === 'partly_cloudy' || s === 'overcast')) s = 'fog';
  return s;
}

// The moon's phase from the date alone (a mean synodic month from a known
// new moon, 2000-01-06 18:14 UTC): 0 new, 0.5 full.
export function moonPhase(ms = Date.now()) {
  const SYNODIC = 29.530588853 * 86400000;
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  return (((ms - ref) / SYNODIC) % 1 + 1) % 1;
}

// The calm clear evening shown when the weather cannot be read.
export function fallbackWeather(now = Date.now(), reason = 'unavailable') {
  return Object.freeze({ state: 'clear', cloud: 0.05, wind: 0, gusts: 0, rain: 0, is_day: null, evening: true, moon_phase: moonPhase(now), source: 'fallback', reason, attribution: null, observed_at: null });
}

export function weatherFromOpenMeteo(json, now = Date.now()) {
  const cur = json && typeof json === 'object' ? json.current : null;
  if (!cur || typeof cur !== 'object' || !Number.isFinite(Number(cur.weather_code))) return fallbackWeather(now, 'malformed');
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const visibility = cur.visibility == null ? null : num(cur.visibility, null);
  const state = stateForCode(cur.weather_code, { visibility });
  const windKmh = num(cur.wind_speed_10m);
  const gustKmh = num(cur.wind_gusts_10m, windKmh);
  return Object.freeze({
    state,
    code: Number(cur.weather_code),
    cloud: Math.max(0, Math.min(1, num(cur.cloud_cover) / 100)),
    // 0 calm .. 1 a gale: trees, flags and clouds respond to it.
    wind: Math.max(0, Math.min(1, (windKmh - 8) / 52)),
    gusts: Math.max(0, Math.min(1, (gustKmh - 15) / 70)),
    rain: Math.max(0, Math.min(1, num(cur.precipitation) / 6)),
    temperature_c: cur.temperature_2m == null ? null : num(cur.temperature_2m),
    visibility_m: visibility,
    is_day: cur.is_day === 1 || cur.is_day === true ? true : cur.is_day === 0 || cur.is_day === false ? false : null,
    evening: false,
    moon_phase: moonPhase(now),
    observed_at: typeof cur.time === 'string' ? cur.time.slice(0, 16) : null,
    source: 'open-meteo',
    attribution: WEATHER_ATTRIBUTION
  });
}

let cache = null;
export function __resetCityWeather() { cache = null; }

export async function cityWeather({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (cache && now - cache.at < (cache.ok ? WEATHER_CACHE_MS : WEATHER_FAIL_CACHE_MS)) return cache.value;
  let value; let ok = false;
  try {
    assertAllowedDataHost(WEATHER_URL);
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(WEATHER_TIMEOUT_MS) : undefined;
    const res = await fetchImpl(WEATHER_URL, { headers: { Accept: 'application/json', 'User-Agent': 'PG1-City/1.0' }, redirect: 'manual', signal });
    if (!res || !res.ok) throw new Error('status');
    value = weatherFromOpenMeteo(await res.json(), now);
    ok = value.source === 'open-meteo';
  } catch (e) {
    value = fallbackWeather(now);
  }
  cache = { at: now, ok, value };
  return value;
}
