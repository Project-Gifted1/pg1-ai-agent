/**
 * PG1 City around sunrise and sunset, drawn (24 Nov 2026, Dublin time, the
 * High tier at 1280 x 720): the sky's phase, exposure, lamps and the night
 * environment as the scene sets them (kingdom-data.js skyState), and a
 * screenshot of each moment (docs/screenshots/kingdom-city-twilight-*.png):
 *   07:00 night · 07:45 civil twilight · 08:18 sunrise · 12:00 day ·
 *   12:00 in rain (still day) · 16:30 just after sunset · 17:30 night.
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

async function openAt(t, { at, weather = { state: 'clear', source: 'open-meteo', cloud: 0.1, is_day: true } }) {
  const feed = fixtureFeed({});
  const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: async (url) => { const f = await feed(url); if (!url.searchParams.get('since')) f.weather = weather; return f; } });
  const browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await routeReplyFont(context);
  await context.addInitScript(({ at }) => {
    try { localStorage.setItem('pg1_theme', 'dark'); localStorage.setItem('pg1_kingdom_quality', 'balanced'); } catch (e) { /* private */ }
    const real = Date.now.bind(Date); const off = at - real(); Date.now = () => real() + off;
  }, { at });
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
  // The weather settles and the lazy night environment (if any) loads.
  await page.waitForFunction(() => Number(document.getElementById('kingdom-view').dataset.frames || 0) > 40, null, { timeout: 600000, polling: 250 });
  await page.waitForTimeout(5500);
  return { page, errors };
}

for (const m of MOMENTS) {
  test(`24 Nov 2026, ${m.name.replace(/^(\d\d)(\d\d)/, '$1:$2')} Dublin: ${m.phase.join('/')}${m.night ? ' (night)' : ''}`, { skip, timeout: 900000 }, async (t) => {
    const { page, errors } = await openAt(t, { at: m.at, ...(m.weather ? { weather: m.weather } : {}) });
    const d = await page.evaluate(() => ({ ...document.getElementById('kingdom-view').dataset }));
    t.diagnostic(`${m.name}: phase ${d.skyPhase}, light ${d.skyLight}, night ${d.skyNight}, exposure ${d.exposure}, lamps ${d.lamps}, night environment ${d.nightEnv}, grade ${d.grade}, weather ${d.weather}`);
    assert.ok(m.phase.includes(d.skyPhase), `phase ${d.skyPhase}`);
    if (m.night) { assert.ok(Number(d.skyNight) > 0.5); assert.ok(Number(d.exposure) <= 0.75); }
    else {
      assert.ok(Number(d.skyNight) <= 0.5, 'not night');
      assert.notEqual(d.nightEnv, 'yes', 'no night environment while the sun is up or in civil twilight');
      assert.ok(!/^(night|rain)$/.test(d.grade || ''), `no night grade (${d.grade})`);
      assert.ok(Number(d.exposure) >= m.minExposure, `exposure ${d.exposure}`);
    }
    if (m.grade) assert.equal(d.grade, m.grade);
    if (m.lamps) assert.ok(Number(d.lamps) > 0.9, 'lamps on after sunset');
    if (m.shot) {
      // The same view for every moment: the hero shot.
      await page.evaluate(() => window.kingdomUi.scene().home());
      const f0 = await page.evaluate(() => Number(document.getElementById('kingdom-view').dataset.frames));
      await page.waitForFunction((k) => Number(document.getElementById('kingdom-view').dataset.frames) > k + 8, f0, { timeout: 600000, polling: 250 });
      mkdirSync(SHOTS_DIR, { recursive: true }); await page.evaluate(() => window.kingdomUi.scene().pause(true)); await page.locator('#kingdom-view').screenshot({ path: join(SHOTS_DIR, `kingdom-city-twilight-${m.name}.png`), timeout: 120000 });
    }
    assert.deepEqual(errors, []);
  });
}
