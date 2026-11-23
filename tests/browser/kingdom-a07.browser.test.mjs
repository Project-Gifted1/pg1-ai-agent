/**
 * PG1 City on a Galaxy A07 profile (1.23, public/kingdom/kingdom-look.js), in
 * a real browser: 360 x 800 at device pixel ratio 2, touch, 4 GB of memory,
 * an Android Chrome user agent, a Dublin night in the rain (the fixture
 * feed's weather).
 *   - the A07's default tier (Medium) within its budget: under 150 draw calls
 *     and under 400k triangles, at night in rain and in clear weather;
 *   - Medium draws at 0.8 of the screen or more and is upscaled and
 *     sharpened to it (the final pass is on);
 *   - the foreground stays clear of fog;
 *   - with frames forced slow, the render scale never goes below 0.8;
 *   - the quality menu says Cinematic may look softer on this phone;
 *   - no page errors.
 * Frame times are not asserted (CI draws 3D in software); draw calls and
 * triangles are the same on any GPU.
 * Skipped (not failed) when Playwright or a Chromium is not installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { startCommandCentreServer } from '../helpers/commandCentre.mjs';
import { fixtureFeed } from '../helpers/kingdomFixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const A07_UA = 'Mozilla/5.0 (Linux; Android 15; SM-A075F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const NIGHT = Date.UTC(2026, 10, 22, 23, 30);

let chromium = null; let executablePath; let skip = false;
try { ({ chromium } = await import('playwright')); } catch (e) { skip = 'playwright is not installed (npm install)'; }
if (chromium && !existsSync(chromium.executablePath())) {
  if (existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  else skip = `Chromium is not installed at ${chromium.executablePath()}`;
}

async function openA07(t, { tier, weather }) {
  const feed = fixtureFeed({});
  const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: async (url) => { const f = await feed(url); if (!url.searchParams.get('since')) f.weather = weather; return f; } });
  const browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, screen: { width: 360, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', userAgent: A07_UA });
  await routeReplyFont(context);
  await context.addInitScript(({ at, tier }) => {
    try { localStorage.setItem('pg1_theme', 'dark'); localStorage.setItem('pg1_kingdom_quality', tier); } catch (e) { /* private */ }
    try { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 4, configurable: true }); } catch (e) { /* read-only */ }
    const real = Date.now.bind(Date); const off = at - real(); Date.now = () => real() + off;
  }, { at: NIGHT, tier });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String((err && err.message) || err)));
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  await page.locator('#kingdom-mini').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('#kingdom-mini').click();
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === 'webgl' && Number(document.getElementById('kingdom-view').dataset.frames || 0) > 0, null, { timeout: 300000 });
  await page.waitForFunction(() => { const cv = document.getElementById('kingdom-globe-intro'); return cv && cv.classList.contains('is-done') && cv.hidden; }, null, { timeout: 180000, polling: 200 }).catch(() => {});
  return { page, errors };
}
const frames = async (page, n) => { const f0 = await page.evaluate(() => Number(document.getElementById('kingdom-view').dataset.frames || 0)); await page.waitForFunction((k) => Number(document.getElementById('kingdom-view').dataset.frames || 0) >= k, f0 + n, { timeout: 600000, polling: 100 }); };

for (const [name, weather] of [['night, rain', { state: 'rain', source: 'open-meteo', cloud: 0.95 }], ['night, clear', { state: 'clear', source: 'open-meteo', cloud: 0.05 }]]) {
  test(`Galaxy A07 profile, Medium (the default), ${name}: under 150 draw calls and 400k triangles, sharp, clear foreground`, { skip, timeout: 900000 }, async (t) => {
    const { page, errors } = await openA07(t, { tier: 'phone', weather });
    await page.evaluate(() => { const s = window.kingdomUi.scene(); s.home(); s.settleWeather(); });
    await frames(page, 4);
    const st = await page.evaluate(() => window.kingdomUi.scene().stats());
    const d = await page.evaluate(() => ({ ...document.getElementById('kingdom-view').dataset }));
    t.diagnostic(`A07 Medium (${name}): ${st.calls} draw calls, ${st.triangles} triangles, render pixels ${d.renderPixels}, sharpen ${d.sharpen}, fog at 400 m ${st.fogAt400}`);
    assert.equal(st.tier, 'phone');
    assert.ok(st.calls > 0 && st.calls < 150, `${st.calls} draw calls`);
    assert.ok(st.triangles > 0 && st.triangles < 400000, `${st.triangles} triangles`);
    assert.ok(Number(d.renderPixels) >= 0.8, `drawn at ${d.renderPixels} of the screen`);
    assert.equal(d.finish, 'on');
    assert.ok(Number(d.sharpen) > 0, 'sharpened after the upscale');
    assert.equal(st.fogAt400, 0, 'the first 400 m stay clear');
    assert.equal(st.targetFps, 30);
    const opt = await page.locator('#kingdom-quality option[value="cinematic"]').textContent();
    assert.equal(opt, 'Cinematic (may look softer on this phone)');
    assert.deepEqual(errors, []);
  });
}

test('Galaxy A07 profile, Cinematic with slow frames: effects go first, and the render scale never drops below 0.8', { skip, timeout: 900000 }, async (t) => {
  const { page, errors } = await openA07(t, { tier: 'cinematic', weather: { state: 'rain', source: 'open-meteo', cloud: 0.95 } });
  // Software 3D is far slower than 30 fps: let the ladder and the scale run to their floors.
  await frames(page, 140);
  const st = await page.evaluate(() => window.kingdomUi.scene().stats());
  const d = await page.evaluate(() => ({ ...document.getElementById('kingdom-view').dataset }));
  t.diagnostic(`A07 Cinematic, slow: scale ${st.renderScale}, effects given up: ${st.ladder.join(', ') || 'none'}`);
  assert.equal(st.minScale, 0.8);
  assert.ok(st.renderScale >= 0.8, `render scale ${st.renderScale}`);
  assert.ok(st.ladder.length >= 3, 'effects were given up before the resolution');
  assert.ok(Number(d.renderPixels) >= 0.8 * 0.8 - 1e-9, `render pixels ${d.renderPixels}`);
  assert.deepEqual(errors, []);
});
