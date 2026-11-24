/**
 * PG1 City around sunrise and sunset, drawn (24 Nov 2026, Dublin time, the
 * High tier at 1280 x 720): the sky's phase, exposure, lamps and the night
 * environment as the scene sets them (kingdom-data.js skyState), and a
 * screenshot of each moment (docs/screenshots/kingdom-city-twilight-*.png):
 *   07:00 night · 07:45 civil twilight · 08:18 sunrise · 12:00 day ·
 *   12:00 in rain (still day) · 16:30 just after sunset · 17:30 night.
 * One page load: the page's clock is moved from moment to moment (the
 * scene reads Date.now each frame), so the test costs one City, not seven
 * (CI runs browser files side by side).
 * Skipped (not failed) when Playwright or a Chromium is not installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { startCommandCentreServer } from '../helpers/commandCentre.mjs';
import { fixtureFeed } from '../helpers/kingdomFixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');

let chromium = null; let executablePath; let skip = false;
try { ({ chromium } = await import('playwright')); } catch (e) { skip = 'playwright is not installed (npm install)'; }
if (chromium && !existsSync(chromium.executablePath())) {
  if (existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  else skip = `Chromium is not installed at ${chromium.executablePath()}`;
}

// The tier: High locally (the screenshots); the Phone tier in CI, where 3D is
// drawn in software beside the other City test files, and High's close-range
// detail (walkers, shop fronts, boats) would slow them all. The sky's rules
// (phase, exposure, lamps, grade, no night environment by day) are the same
// on every tier.
const TWILIGHT_TIER = process.env.CI ? 'phone' : 'balanced';
// 24 Nov 2026: Dublin is on GMT, so wall-clock time is UTC.
const MOMENTS = [
  { name: '0700', at: Date.UTC(2026, 10, 24, 7, 0), phase: ['night', 'nautical'], night: true },
  { name: '0745', at: Date.UTC(2026, 10, 24, 7, 45), phase: ['civil'], night: false, minExposure: 0.82 },
  { name: '0818', at: Date.UTC(2026, 10, 24, 8, 18), phase: ['golden'], night: false, minExposure: 0.9, shot: true },
  { name: '1200', at: Date.UTC(2026, 10, 24, 12, 0), phase: ['day'], night: false, minExposure: 0.9, shot: true },
  { name: '1200-rain', at: Date.UTC(2026, 10, 24, 12, 0), weather: { state: 'rain', source: 'open-meteo', cloud: 1, rain: 0.8, is_day: true }, phase: ['day'], night: false, minExposure: 0.9, grade: 'day', shot: true },
  { name: '1630', at: Date.UTC(2026, 10, 24, 16, 30), phase: ['civil'], night: false, minExposure: 0.82, lamps: true, shot: true },
  { name: '1730', at: Date.UTC(2026, 10, 24, 17, 30), phase: ['night', 'nautical'], night: true }
];
MOMENTS[1].shot = true;

async function openCity(t) {
  const feed = fixtureFeed({});
  let weather = { state: 'clear', source: 'open-meteo', cloud: 0.1, is_day: true };
  const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: async (url) => { const f = await feed(url); if (!url.searchParams.get('since')) f.weather = weather; return f; } });
  const browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await routeReplyFont(context);
  // The page's clock, movable: Date.now runs from the moment set by window.__pg1At.
  await context.addInitScript(({ at, tier }) => {
    try { localStorage.setItem('pg1_theme', 'dark'); localStorage.setItem('pg1_kingdom_quality', tier); } catch (e) { /* private */ }
    const real = Date.now.bind(Date); let off = at - real();
    Date.now = () => real() + off;
    window.__pg1At = (ms) => { off = ms - real(); };
  }, { at: MOMENTS[0].at, tier: TWILIGHT_TIER });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String((err && err.message) || err)));
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator'); await page.fill('#auth-pass', 'passkey'); await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  await page.locator('#kingdom-mini').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('#kingdom-mini').click();
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === 'webgl' && !!document.getElementById('kingdom-view').dataset.skyPhase, null, { timeout: 300000, polling: 250 });
  await page.waitForFunction(() => { const cv = document.getElementById('kingdom-globe-intro'); return !cv || (cv.classList.contains('is-done') && cv.hidden); }, null, { timeout: 180000, polling: 250 }).catch(() => {});
  await page.evaluate(() => window.kingdomUi.scene().home());
  return { page, errors, setWeather: (w) => { weather = w; } };
}

// Moves the clock (and the weather), then waits for the scene to show it:
// enough frames for the grade (checked every 30 frames) and one sky reading.
async function goTo(page, m) {
  await page.evaluate(([at, w]) => { window.__pg1At(at); window.kingdomUi.scene().setWeather(w); if (window.kingdomUi.scene().settleWeather) window.kingdomUi.scene().settleWeather(); }, [m.at, m.weather || { state: 'clear', source: 'open-meteo', cloud: 0.1, is_day: true }]);
  const f0 = await page.evaluate(() => Number(document.getElementById('kingdom-view').dataset.frames || 0));
  await page.waitForFunction((k) => Number(document.getElementById('kingdom-view').dataset.frames || 0) > k + 32, f0, { timeout: 600000, polling: 250 });
  await page.waitForTimeout(5500);
}

test('PG1 City on 24 Nov 2026, Dublin time: night, civil twilight, sunrise, day, rain by day, after sunset, night', { skip, timeout: 1800000 }, async (t) => {
  const { page, errors, setWeather } = await openCity(t);
  for (const m of MOMENTS) {
    // The feed serves the moment's weather too (it is re-read every poll).
    setWeather(m.weather || { state: 'clear', source: 'open-meteo', cloud: 0.1, is_day: true });
    await t.test(`${m.name.replace(/^(\d\d)(\d\d)/, '$1:$2')}: ${m.phase.join('/')}${m.night ? ' (night)' : ''}`, async (st) => {
      await goTo(page, m);
      const d = await page.evaluate(() => ({ ...document.getElementById('kingdom-view').dataset }));
      st.diagnostic(`${m.name}: phase ${d.skyPhase}, light ${d.skyLight}, night ${d.skyNight}, exposure ${d.exposure}, lamps ${d.lamps}, night environment ${d.nightEnv}, grade ${d.grade}, weather ${d.weather}`);
      assert.ok(m.phase.includes(d.skyPhase), `phase ${d.skyPhase}`);
      if (m.night) { assert.ok(Number(d.skyNight) > 0.5); assert.ok(Number(d.exposure) <= 0.75); }
      else {
        assert.ok(Number(d.skyNight) <= 0.5, 'not night');
        assert.notEqual(d.nightEnv, 'yes', 'no night environment while the sun is up or in civil twilight');
        assert.ok(!/^(night|rain)$/.test(d.grade || ''), `no night grade (${d.grade})`);
        assert.ok(Number(d.exposure) >= m.minExposure, `exposure ${d.exposure}`);
      }
      // Tiers without the grade pass report none; where it is drawn, rain by day keeps the day grade.
      if (m.grade && d.grade) assert.equal(d.grade, m.grade);
      if (m.lamps) assert.ok(Number(d.lamps) > 0.9, 'lamps on after sunset');
      if (m.shot) {
        mkdirSync(SHOTS_DIR, { recursive: true });
        await page.evaluate(() => window.kingdomUi.scene().pause(true));
        await page.locator('#kingdom-view').screenshot({ path: join(SHOTS_DIR, `kingdom-city-twilight-${m.name}.png`), timeout: 120000 });
        await page.evaluate(() => window.kingdomUi.scene().pause(false));
      }
    });
  }
  assert.deepEqual(errors, []);
});
