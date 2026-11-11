/**
 * PG1 City quality pass in a real browser: the Legacy phone tier on an
 * iPhone 8 profile, its budgets, WebGL context loss, a drop to Legacy, the
 * real weather (and its fallback) and the traffic, all from a test fixture
 * feed (tests/helpers/kingdomFixtures.mjs). Frame times are logged as
 * diagnostics, never asserted (CI draws 3D in software).
 *
 *   - an iPhone 8 user agent (iOS 16, 375 x 667) starts on Legacy phone;
 *   - Legacy budgets, measured on the drawn frame: under 150 draw calls,
 *     under 150k triangles, no texture over 1024 px, an estimated GPU
 *     memory well under 300 MB, 30 fps target, pixel ratio 1;
 *   - losing the WebGL context shows the still map (the text feed stays),
 *     and the city comes back when the context does; no page error;
 *   - choosing Legacy phone rebuilds the city on that tier (the same path
 *     the automatic drop takes);
 *   - the feed's weather drives the sky (rain at night: wet roads, rain
 *     streaks) and never the counts; with no weather, a calm clear evening;
 *   - the traffic never overlaps.
 * Skipped (not failed) when Playwright or a Chromium is not installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { startCommandCentreServer, openPhonePage } from '../helpers/commandCentre.mjs';
import { fixtureFeed } from '../helpers/kingdomFixtures.mjs';
import { LEGACY_BUDGET } from '../../public/kingdom/kingdom-scene.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');
const IPHONE8 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

let chromium = null; let executablePath; let skip = false;
try { ({ chromium } = await import('playwright')); } catch (e) { skip = 'playwright is not installed (npm install)'; }
if (chromium && !existsSync(chromium.executablePath())) {
  if (existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  else skip = `Chromium is not installed at ${chromium.executablePath()}`;
}
const launch = () => chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const view = (page) => page.evaluate(() => ({ ...document.getElementById('kingdom-view').dataset }));
const frameCount = (page) => page.evaluate(() => Number(document.getElementById('kingdom-view').dataset.frames || 0));
const frames = async (page, n) => { const f0 = await frameCount(page); await page.waitForFunction((k) => Number(document.getElementById('kingdom-view').dataset.frames || 0) >= k, f0 + n, { timeout: 300000, polling: 200 }); };
const shot = async (page, name) => { mkdirSync(SHOTS_DIR, { recursive: true }); await page.evaluate(() => window.kingdomUi.scene().pause(true)); await page.screenshot({ path: join(SHOTS_DIR, name), timeout: 120000 }); await page.evaluate(() => window.kingdomUi.scene().pause(false)); };

async function openCity(t, { weather = null, userAgent, width = 375, height = 667, tier = null } = {}) {
  const control = {};
  const feed = fixtureFeed(control);
  let wx = weather;
  const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: async (url) => { const f = await feed(url); if (!url.searchParams.get('since')) f.weather = wx; return f; } });
  const browser = await launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, errors } = await openPhonePage(browser, origin, { width, height, routeReplyFont, userAgent });
  if (tier) await page.evaluate((x) => { try { localStorage.setItem('pg1_kingdom_quality', x); } catch (e) {} }, tier);
  await page.locator('#kingdom-mini').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#kingdom-mini').click();
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === 'webgl' && !!window.kingdomUi.scene() && Number(document.getElementById('kingdom-view').dataset.frames || 0) > 0, null, { timeout: 180000 });
  await page.waitForFunction(() => document.getElementById('kingdom-globe-intro').hidden, null, { timeout: 60000 }).catch(() => {});
  return { page, errors, control, setWeather: (w) => { wx = w; } };
}

test('an iPhone 8 starts on Legacy phone, within its budgets; the traffic never overlaps', { skip, timeout: 600000 }, async (t) => {
  const { page, errors } = await openCity(t, { userAgent: IPHONE8, weather: { state: 'clear', source: 'open-meteo', cloud: 0.1 } });
  assert.equal((await view(page)).tier, 'legacy', 'auto-selected for the iPhone 8 profile');
  await frames(page, 6);
  const a = await page.evaluate(() => ({ f: Number(document.getElementById('kingdom-view').dataset.frames), t: performance.now() }));
  await frames(page, 10);
  const b = await page.evaluate(() => ({ f: Number(document.getElementById('kingdom-view').dataset.frames), t: performance.now() }));
  const st = await page.evaluate(() => window.kingdomUi.scene().stats());
  t.diagnostic(`Legacy phone at 375 x 667: ${((b.t - a.t) / (b.f - a.f)).toFixed(0)} ms per frame (software 3D), ${st.calls} draw calls, ${st.triangles} triangles, max texture ${st.maxTexture} px, ~${st.gpuMemoryMB} MB`);
  assert.ok(st.calls > 0 && st.calls < LEGACY_BUDGET.drawCalls, `${st.calls} draw calls`);
  assert.ok(st.triangles > 0 && st.triangles < LEGACY_BUDGET.triangles, `${st.triangles} triangles`);
  assert.ok(st.maxTexture <= LEGACY_BUDGET.maxTexture, `texture ${st.maxTexture} px`);
  assert.ok(st.gpuMemoryMB < LEGACY_BUDGET.gpuMemoryMB / 2, `${st.gpuMemoryMB} MB`);
  assert.equal(st.targetFps, 30);
  assert.equal(st.pixelRatio, 1);
  assert.equal(st.life.overlaps, 0, 'no two vehicles in the same space');
  assert.ok(st.life.vehicles > 20 && st.life.people > 100, 'still a living city');
  await shot(page, 'kingdom-city-legacy-412-test-fixture.png');
  assert.deepEqual(errors, []);
});

test('losing the WebGL context shows the still map with the feed, and the city comes back', { skip, timeout: 600000 }, async (t) => {
  const { page, errors } = await openCity(t, { tier: 'legacy' });
  await frames(page, 3);
  const ok = await page.evaluate(() => { window.__lost = window.kingdomUi.scene().loseContext(); return !!window.__lost; });
  assert.ok(ok, 'WEBGL_lose_context is available');
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.contextLost === 'yes', null, { timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === 'webgl-lost', null, { timeout: 30000 });
  assert.ok(await page.locator('#kingdom-view canvas').count() >= 1);
  assert.ok(await page.locator('#kingdom-feed .kd-row').count() > 0, 'the text feed stays');
  assert.ok(await page.locator('#kingdom-feed').isVisible());
  await page.evaluate(() => window.__lost.restoreContext());
  await page.waitForFunction(() => Number(document.getElementById('kingdom-view').dataset.rebuilds || 0) >= 1, null, { timeout: 180000 });
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === 'webgl', null, { timeout: 60000 });
  await frames(page, 3);
  assert.equal((await view(page)).tier, 'legacy', 'one tier lower, and Legacy is the floor');
  assert.deepEqual(errors, [], 'never a crash');
});

test('choosing Legacy phone rebuilds the city on that tier (the automatic drop takes the same path)', { skip, timeout: 600000 }, async (t) => {
  const { page, errors } = await openCity(t, { tier: 'phone', width: 412, height: 915 });
  assert.equal((await view(page)).tier, 'phone');
  await frames(page, 2);
  const before = await page.evaluate(() => window.kingdomUi.scene().stats());
  await page.evaluate(() => window.kingdomUi.setQuality('legacy'));
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.tier === 'legacy' && Number(document.getElementById('kingdom-view').dataset.rebuilds || 0) >= 1, null, { timeout: 180000 });
  await frames(page, 3);
  const after = await page.evaluate(() => window.kingdomUi.scene().stats());
  t.diagnostic(`Phone ${before.calls} calls / ${before.triangles} triangles -> Legacy ${after.calls} / ${after.triangles}`);
  assert.ok(after.calls < before.calls && after.triangles < before.triangles);
  assert.deepEqual(errors, []);
});

test('the real weather drives the sky (rain at night: wet roads, streaks), never the counts; no weather: a calm clear evening', { skip, timeout: 600000 }, async (t) => {
  const { page, errors } = await openCity(t, { tier: 'legacy', weather: null });
  await frames(page, 3);
  let v = await view(page);
  assert.equal(v.weather, 'clear'); assert.equal(v.weatherSource, 'fallback');
  const counts = await page.evaluate(() => ({ hud: document.getElementById('kingdom-hud') ? document.getElementById('kingdom-hud').textContent : '', countries: document.getElementById('kingdom-countries-text').textContent }));
  await page.evaluate(() => window.kingdomUi.scene().setWeather({ state: 'heavy_rain', rain: 1, wind: 0.6, is_day: false, source: 'open-meteo' }));
  await page.waitForFunction(() => Number(document.getElementById('kingdom-view').dataset.wet || 0) > 0.05, null, { timeout: 300000, polling: 250 });
  v = await view(page);
  assert.equal(v.weather, 'heavy_rain');
  const names = (await page.evaluate(() => window.kingdomUi.scene().inspect())).names;
  for (const n of ['rain-streaks', 'rain-ripples', 'puddles', 'umbrellas', 'road-spray']) assert.ok(names.includes(n), n);
  assert.deepEqual(await page.evaluate(() => ({ hud: document.getElementById('kingdom-hud') ? document.getElementById('kingdom-hud').textContent : '', countries: document.getElementById('kingdom-countries-text').textContent })), counts, 'the weather changes no count');
  assert.equal((await view(page)).threat, v.threat);
  assert.deepEqual(errors, []);
});
