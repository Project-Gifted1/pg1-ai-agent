#!/usr/bin/env node
/**
 * PG1 City on a Galaxy A07 profile: measure each quality tier (and each
 * effect on its own), and take screenshots.
 *
 *   node scripts/city-measure.mjs --out docs/perf/city-a07-after.json \
 *        [--shots docs/screenshots/city-a07/after] [--fx] [--frames 12]
 *
 * The profile: 360 x 800 CSS px at device pixel ratio 2 (a 720 x 1600
 * screen), touch (coarse pointer), navigator.deviceMemory 4, an Android
 * Chrome user agent, ?debug=1. The clock is set to a Dublin night
 * (23:30) or day (12:30); the weather comes from the fixture feed
 * (tests/helpers/kingdomFixtures.mjs): rain or clear.
 *
 * What it records per tier and condition: the tier, the render scale, the
 * draw calls and triangles of a drawn frame (exact), and the time per frame.
 * The time is measured in this browser: in CI and cloud sessions that is
 * SwiftShader, 3D drawn on the CPU, so the milliseconds show how costs
 * compare (an effect's share of the frame), not the A07's frame rate. The
 * draw calls and triangles are the same on any GPU.
 *
 * --fx also measures Cinematic (night, rain) with each effect switched off
 * on its own (?fx=-name, read only with ?debug=1; kingdom-look.js
 * applyFxParam): the difference is that effect's cost.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCommandCentreServer } from '../tests/helpers/commandCentre.mjs';
import { fixtureFeed } from '../tests/helpers/kingdomFixtures.mjs';
import { routeReplyFont } from '../tests/helpers/replyFont.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : dflt; };
const OUT = arg('out', 'docs/perf/city-a07.json');
const SHOTS = arg('shots', null);
const FX = !!arg('fx', false);
const FRAMES = Number(arg('frames', 10));
const PUBLIC_DIR = resolve(arg('public', join(ROOT, 'public')));
const TIERS = (arg('tiers', 'legacy,phone,balanced,cinematic')).split(',');
const CONDITIONS = (arg('conditions', 'night-rain,night-clear,day-clear')).split(',');
const COSTS = !!arg('costs', false);

export const A07 = Object.freeze({ width: 360, height: 800, deviceScaleFactor: 2, memory: 4, userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-A075F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' });
const WHEN = { night: Date.UTC(2026, 10, 22, 23, 30), day: Date.UTC(2026, 10, 22, 12, 30) };
const WEATHER = { rain: { state: 'rain', source: 'open-meteo', cloud: 0.95 }, clear: { state: 'clear', source: 'open-meteo', cloud: 0.05 } };
export const EFFECTS = Object.freeze(['gtao', 'shadows', 'bloom', 'water', 'fog', 'crowds', 'drones', 'grade', 'sharpen', 'hdri', 'wet', 'facade']);

let chromium;
try { ({ chromium } = await import('playwright')); } catch (e) { console.error('playwright is not installed'); process.exit(1); }
const executablePath = existsSync(chromium.executablePath()) ? undefined : '/opt/pw-browsers/chromium';

async function openCity(browser, origin, { tier, when, fx = '' }) {
  const context = await browser.newContext({ viewport: { width: A07.width, height: A07.height }, screen: { width: A07.width, height: A07.height }, deviceScaleFactor: A07.deviceScaleFactor, isMobile: true, hasTouch: true, colorScheme: 'dark', userAgent: A07.userAgent });
  await routeReplyFont(context);
  await context.addInitScript(({ at, memory, tier }) => {
    try { localStorage.setItem('pg1_theme', 'dark'); if (tier) localStorage.setItem('pg1_kingdom_quality', tier); } catch (e) { /* private */ }
    try { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => memory, configurable: true }); } catch (e) { /* read-only */ }
    const real = Date.now.bind(Date); const off = at - real();
    Date.now = () => real() + off;
  }, { at: when, memory: A07.memory, tier });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String((err && err.message) || err)));
  await page.goto(`${origin}/?debug=1${fx ? `&fx=${encodeURIComponent(fx)}` : ''}`, { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  await page.locator('#kingdom-mini').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('#kingdom-mini').click();
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === 'webgl' && !!window.kingdomUi.scene() && Number(document.getElementById('kingdom-view').dataset.frames || 0) > 0, null, { timeout: 300000 });
  // The globe intro plays over the city first (kingdom-ui.js playIntro): wait until it has finished and gone.
  await page.waitForFunction(() => { const cv = document.getElementById('kingdom-globe-intro'); return cv && cv.classList.contains('is-done') && cv.hidden; }, null, { timeout: 180000, polling: 200 }).catch(() => {});
  return { context, page, errors };
}

const frameCount = (page) => page.evaluate(() => Number(document.getElementById('kingdom-view').dataset.frames || 0));
async function measure(page, n) {
  await page.evaluate(() => { const s = window.kingdomUi.scene(); s.home(); s.settleWeather(); });
  const f0 = await frameCount(page);
  await page.waitForFunction((k) => Number(document.getElementById('kingdom-view').dataset.frames || 0) >= k, f0 + 3, { timeout: 600000, polling: 100 });
  const a = await page.evaluate(() => ({ f: Number(document.getElementById('kingdom-view').dataset.frames), t: performance.now() }));
  await page.waitForFunction((k) => Number(document.getElementById('kingdom-view').dataset.frames || 0) >= k, a.f + n, { timeout: 900000, polling: 100 });
  const b = await page.evaluate(() => ({ f: Number(document.getElementById('kingdom-view').dataset.frames), t: performance.now() }));
  const st = await page.evaluate(() => { const s = window.kingdomUi.scene(); const x = s.stats(); const d = document.getElementById('kingdom-view').dataset; return { tier: x.tier, label: x.label, calls: x.calls, triangles: x.triangles, pixelRatio: x.pixelRatio, renderScale: Number(d.renderScale || 1), look: x.look || null, fogAt400: x.fogAt400 ?? null }; });
  return { ...st, msPerFrame: Math.round((b.t - a.t) / (b.f - a.f)) };
}

const control = {};
const feed = fixtureFeed(control);
let weatherNow = null;
const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: async (url) => { const f = await feed(url); if (!url.searchParams.get('since')) f.weather = weatherNow; return f; } });
const browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const rows = [];
try {
  for (const cond of CONDITIONS) {
    const [time, wx] = cond.split('-');
    weatherNow = WEATHER[wx];
    for (const tier of TIERS) {
      const { context, page, errors } = await openCity(browser, origin, { tier, when: WHEN[time] });
      const m = await measure(page, FRAMES);
      rows.push({ condition: cond, ...m, errors: errors.length });
      if (COSTS) rows[rows.length - 1].costs = await page.evaluate(() => window.kingdomUi.scene().costs());
      console.log(JSON.stringify(rows[rows.length - 1]));
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await page.evaluate(() => window.kingdomUi.scene().pause(true));
        await page.screenshot({ path: join(SHOTS, `city-a07-${cond}-${tier}.jpg`), type: 'jpeg', quality: 82, timeout: 180000 });
      }
      await context.close();
    }
  }
  if (FX) {
    weatherNow = WEATHER.rain;
    const tier = 'cinematic';
    const base = rows.find((r) => r.condition === 'night-rain' && r.tier === tier);
    for (const fx of EFFECTS) {
      const { context, page } = await openCity(browser, origin, { tier, when: WHEN.night, fx: `-${fx}` });
      const m = await measure(page, FRAMES);
      rows.push({ condition: 'night-rain', effectOff: fx, ...m, savedMs: base ? base.msPerFrame - m.msPerFrame : null, savedCalls: base ? base.calls - m.calls : null, savedTriangles: base ? base.triangles - m.triangles : null });
      console.log(JSON.stringify(rows[rows.length - 1]));
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(OUT, JSON.stringify({ profile: A07, renderer: 'SwiftShader (CPU): milliseconds compare costs; draw calls and triangles are exact', frames: FRAMES, rows }, null, 2) + '\n');
console.log(`wrote ${OUT}`);
