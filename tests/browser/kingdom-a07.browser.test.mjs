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
 *   - the quality menu shows "Cinematic (manual)" whole (its title says it
 *     may look softer on this phone);
 *   - the banner at 360 px never leaves a word alone on its last line;
 *   - the drones on Low (no environment map) have a light, lit body, nav
 *     lights and a strobe, and an underglow at night only;
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

async function openA07(t, { tier, weather, at = NIGHT }) {
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
  }, { at, tier });
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
    assert.equal(opt, 'Cinematic (manual)');
    assert.equal(await page.locator('#kingdom-quality option[value="cinematic"]').getAttribute('title'), 'Chosen by hand: may look softer on this phone');
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

// The words of the banner's last line, from the text's own line boxes.
async function bannerLines(page) {
  return page.evaluate(() => {
    const el = document.getElementById('kingdom-countries-text');
    const node = el.firstChild; const text = node.textContent; const r = document.createRange();
    const lines = []; let top = null; let cur = '';
    for (let i = 0; i < text.length; i++) {
      r.setStart(node, i); r.setEnd(node, i + 1);
      const rect = [...r.getClientRects()].find((x) => x.width > 0);
      if (rect && top !== null && rect.top > top + 4) { lines.push(cur); cur = ''; }
      if (rect && (top === null || rect.top > top + 4)) top = rect.top;
      cur += text[i];
    }
    lines.push(cur);
    return { lines: lines.map((l) => l.trim()), width: el.getBoundingClientRect().width };
  });
}

test('Galaxy A07 profile, 360 px: the banner never leaves a word alone on its last line; the quality menu shows its whole label', { skip, timeout: 900000 }, async (t) => {
  const { page, errors } = await openA07(t, { tier: 'phone', weather: { state: 'clear', source: 'open-meteo', cloud: 0.1 } });
  await page.waitForFunction(() => /countries|country/.test(document.getElementById('kingdom-countries-text').textContent) && document.getElementById('kingdom-countries').dataset.n !== '0', null, { timeout: 60000 }).catch(() => {});
  const { lines } = await bannerLines(page);
  t.diagnostic(`banner lines at 360 px: ${JSON.stringify(lines)}`);
  const last = lines[lines.length - 1];
  assert.ok(last.split(/[\s\u00a0]+/).filter(Boolean).length >= 2, `a word alone on the last line: ${JSON.stringify(lines)}`);
  assert.match(last.replace(/\u00a0/g, ' '), /last 24 h$/);
  assert.match(lines.join(' ').replace(/\u00a0/g, ' '), /^Probes and checks from \d+ countr(y|ies) · last 24 h$/);
  // The quality menu: wide enough for its widest label, so a choice is never cut off.
  const q = await page.evaluate(() => {
    const sel = document.getElementById('kingdom-quality');
    const cs = getComputedStyle(sel);
    const span = document.createElement('span'); span.style.font = cs.font; span.style.whiteSpace = 'pre'; span.style.position = 'absolute'; span.style.visibility = 'hidden'; document.body.appendChild(span);
    const widths = [...sel.options].filter((o) => !o.hidden).map((o) => { span.textContent = o.textContent; return { text: o.textContent, w: span.getBoundingClientRect().width }; });
    span.remove();
    const inner = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { widths, inner, right: sel.getBoundingClientRect().right, vw: innerWidth };
  });
  t.diagnostic(`quality menu: inner ${Math.round(q.inner)} px; labels ${q.widths.map((w) => `${w.text} ${Math.round(w.w)}`).join(', ')}`);
  for (const w of q.widths) assert.ok(w.w <= q.inner + 0.5, `"${w.text}" (${w.w} px) is cut off in ${q.inner} px`);
  assert.ok(q.widths.some((w) => w.text === 'Cinematic (manual)'));
  assert.ok(q.right <= q.vw, 'the menu stays on screen');
  assert.deepEqual(errors, []);
});

for (const [name, at] of [['night', NIGHT], ['day', Date.UTC(2026, 10, 23, 12, 30)]]) {
  test(`Galaxy A07 profile, Low (no environment map), ${name}: drones have a light lit body, nav lights and a strobe; underglow at night only`, { skip, timeout: 900000 }, async (t) => {
    const { page, errors } = await openA07(t, { tier: 'legacy', at, weather: { state: 'clear', source: 'open-meteo', cloud: 0.1 } });
    await frames(page, 3);
    const look = await page.evaluate(() => window.kingdomUi.scene().droneLook());
    t.diagnostic(`Low ${name}: environment map ${look.environment}, night ${look.night}, ${look.crowds.length} drone kinds`);
    assert.equal(look.environment, false, 'Low draws with no environment map');
    for (const c of look.crowds) {
      const r = (c.body >> 16) & 255; const g = (c.body >> 8) & 255; const b = c.body & 255;
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      assert.ok(lum >= 0.5, `body #${c.body.toString(16)} is too dark (${lum.toFixed(2)})`);
      assert.ok(c.metalness <= 0.3, `metalness ${c.metalness}: a metal body is black with no environment map`);
      assert.ok(c.emissive > 0, 'the body has a little light of its own');
      assert.equal(c.nav, 3, 'nav lights, strobe and underglow');
      if (name === 'night') assert.ok(c.underglow > 0 && c.underglow <= 0.3, `underglow ${c.underglow}`); else assert.equal(c.underglow, 0);
    }
    assert.deepEqual(errors, []);
  });
}
