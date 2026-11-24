/**
 * PG1 City's light follows the real sky over Dublin around sunrise and
 * sunset (public/kingdom/kingdom-data.js skyState, on the real twilight
 * bands: civil -6 deg, nautical -12 deg):
 *   - 24 Nov 2026: 07:00 night, 07:45 civil twilight (light, blue), 08:18
 *     sunrise light (daytime exposure, no night HDRI or grade), 12:00 full
 *     day, 16:30 just after sunset, 17:30 night;
 *   - 21 Jun 2026 (sunrise about 04:57, sunset about 21:58, Irish summer time):
 *     the same steps at its own hours;
 *   - the golden hour is a tint near the horizon, dawn in the morning and
 *     dusk in the evening, never a darkening;
 *   - lamps and home windows follow the sun, shops their opening hours;
 *   - a rainy day greys the sky but stays daytime.
 * The drawn City is checked in tests/browser/kingdom-twilight.browser.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dublinSun, skyState, daylight, windowRatios, weatherLook, normalizeWeather } from '../public/kingdom/kingdom-data.js';
import { liveMood } from '../public/kingdom/kingdom-look.js';
import { greyed } from '../public/kingdom/kingdom-world.js';

// A Dublin wall-clock time (GMT in November, IST = UTC+1 in June).
const at = (y, mo, d, hh, mm) => { const summer = mo >= 3 && mo <= 9; return Date.UTC(y, mo, d, hh - (summer ? 1 : 0), mm); };
const sky = (ms) => { const s = dublinSun(ms); return { ...skyState(s.elevation, { morning: s.azimuth < Math.PI }), sun: s }; };
// What the scene does with it (kingdom-scene.js): the night HDRI and grade only when night > 0.5.
const nightHdri = (k) => k.night > 0.5;

function assertNight(k, when) {
  assert.ok(k.deg < -6, `${when}: the sun is below -6 deg (${k.deg.toFixed(1)})`);
  assert.ok(nightHdri(k), `${when}: night environment`);
  assert.equal(liveMood({ light: k.light, dusk: k.golden, rain: 0, night: k.night }), 'night', `${when}: night grade`);
  assert.ok(k.exposure <= 0.75, `${when}: night exposure`);
  assert.equal(k.lamps, 1, `${when}: lamps on`);
}
function assertCivil(k, when) {
  assert.equal(k.phase, 'civil', `${when}: civil twilight (${k.deg.toFixed(1)} deg)`);
  assert.ok(k.light >= 0.25, `${when}: already light (${k.light.toFixed(2)})`);
  assert.ok(!nightHdri(k), `${when}: no night HDRI`);
  assert.notEqual(liveMood({ light: k.light, dusk: k.golden, night: k.night }), 'night', `${when}: no night grade`);
  assert.ok(k.exposure >= 0.82, `${when}: no night-level exposure (${k.exposure.toFixed(2)})`);
}
function assertSunrise(k, when) {
  assert.ok(k.deg > 0 && k.deg < 6, `${when}: the sun just up (${k.deg.toFixed(1)})`);
  assert.equal(k.phase, 'golden');
  assert.ok(k.light >= 0.75, `${when}: daytime light (${k.light.toFixed(2)})`);
  assert.ok(k.exposure >= 0.9, `${when}: daytime exposure (${k.exposure.toFixed(2)})`);
  assert.ok(!nightHdri(k), `${when}: no night HDRI`);
  assert.equal(k.night, 0);
  assert.ok(k.golden > 0.5, `${when}: golden-hour tint`);
  assert.notEqual(liveMood({ light: k.light, dusk: k.golden, night: k.night }), 'night');
}
function assertDay(k, when) {
  assert.equal(k.phase, 'day', when); assert.equal(k.light, 1); assert.equal(k.golden, 0); assert.equal(k.lamps, 0);
  assert.equal(liveMood({ light: k.light, dusk: k.golden, night: k.night }), 'day');
}

test('24 Nov 2026 in Dublin: 07:00 night, 07:45 civil twilight, 08:18 sunrise light, 12:00 day, 16:30 sunset, 17:30 night', () => {
  assertNight(sky(at(2026, 10, 24, 7, 0)), '07:00');
  const c = sky(at(2026, 10, 24, 7, 45)); assertCivil(c, '07:45'); assert.equal(c.tint, 'dawn');
  const r = sky(at(2026, 10, 24, 8, 18)); assertSunrise(r, '08:18'); assert.equal(r.tint, 'dawn');
  assertDay(sky(at(2026, 10, 24, 12, 0)), '12:00');
  const s = sky(at(2026, 10, 24, 16, 30));
  assert.ok(s.deg < 0 && s.deg > -6, `16:30: just after sunset (${s.deg.toFixed(1)})`);
  assertCivil(s, '16:30'); assert.equal(s.tint, 'dusk'); assert.equal(s.lamps, 1, '16:30: lamps on after sunset');
  assertNight(sky(at(2026, 10, 24, 17, 30)), '17:30');
});

test('21 Jun 2026 in Dublin: sunrise about 04:57, sunset about 21:58, the same steps at its hours', () => {
  const crossing = (from, to, up) => { for (let t = from; t < to; t += 60000) { const a = dublinSun(t - 60000).elevation; const b = dublinSun(t).elevation; if (up ? a < -0.0145 && b >= -0.0145 : a >= -0.0145 && b < -0.0145) return t; } return null; };
  const rise = crossing(at(2026, 5, 21, 3, 0), at(2026, 5, 21, 7, 0), true);
  const set = crossing(at(2026, 5, 21, 20, 0), at(2026, 5, 21, 23, 59), false);
  assert.ok(Math.abs(rise - at(2026, 5, 21, 5, 0)) < 10 * 60000, 'sunrise about 05:00');
  assert.ok(Math.abs(set - at(2026, 5, 21, 21, 55)) < 10 * 60000, 'sunset about 21:55');
  assertNight(sky(at(2026, 5, 21, 1, 30)), '01:30');
  assertCivil(sky(at(2026, 5, 21, 4, 30)), '04:30');
  assertSunrise(sky(at(2026, 5, 21, 5, 10)), '05:10');
  assertDay(sky(at(2026, 5, 21, 13, 0)), '13:00');
  const s = sky(at(2026, 5, 21, 22, 15)); assertCivil(s, '22:15'); assert.equal(s.tint, 'dusk');
  assertNight(sky(at(2026, 5, 21, 23, 30)), '23:30');
});

test('the bands: dark only below -6 deg, light from civil dawn, near full day from +6; no dip after sunrise', () => {
  const R = Math.PI / 180;
  let prev = -1;
  for (let d = -18; d <= 30; d += 0.25) { const k = skyState(d * R); assert.ok(k.light >= prev - 1e-9, `light never drops as the sun rises (${d})`); prev = k.light; assert.ok(k.exposure >= 0.7 && k.exposure <= 0.92); if (d >= -6) assert.ok(k.night <= 0.5, `${d}: not night`); if (d < -6.5) assert.ok(k.night > 0.5, `${d}: night`); if (d > 4) assert.equal(k.lamps, 0); if (d < -2) assert.equal(k.lamps, 1); if (d > 10 || d < -4) assert.equal(k.golden, 0); }
  assert.ok(skyState(6 * R).light > 0.99);
  assert.equal(daylight(10 * R), 1);
});

test('lamps and home windows follow the sun; offices and shops keep their hours', () => {
  const day = windowRatios(12, 0); const dusk = windowRatios(16.5, 1); const late = windowRatios(23.5, 1);
  assert.ok(dusk.home > day.home + 0.3, 'homes light up at dusk (16:30 in November)');
  const juneEvening = windowRatios(20.5, 0);
  assert.ok(juneEvening.home < 0.15, 'a bright June evening: homes not lit yet');
  assert.ok(late.office < dusk.office, 'offices close');
  assert.deepEqual(windowRatios(12), windowRatios(12, null), 'without the sun, the old hours');
});

test('a rainy day greys the sky and stays daytime', () => {
  const look = weatherLook(normalizeWeather({ state: 'rain', cloud: 1, rain: 0.8, source: 'open-meteo' }));
  const k = sky(at(2026, 10, 24, 12, 0));
  assert.equal(liveMood({ light: k.light, dusk: k.golden, rain: look.rain, night: k.night }), 'day', 'not the rain-at-night grade');
  assert.ok(!nightHdri(k));
  // The zenith colour of a clear day, greyed by the storm: still bright, now neutral.
  const c = { r: 0.2, g: 0.37, b: 0.72, multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; } };
  greyed(c, look.dark, k.light);
  const lum = (c.r + c.g + c.b) / 3; const spread = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  assert.ok(lum > 0.3, `still a day sky (${lum.toFixed(2)})`);
  assert.ok(spread < 0.52 * 0.6, 'greyer (lower saturation)');
  // At night the same storm darkens more.
  const n = { r: 0.04, g: 0.07, b: 0.17, multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; } };
  greyed(n, look.dark, 0);
  assert.ok((n.r + n.g + n.b) / 3 < 0.09);
});
