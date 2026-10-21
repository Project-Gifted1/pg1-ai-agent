/**
 * The threat radar, full screen (public/lab/threat-radar-scene.js), in a
 * real browser at phone width (380 px, dark), in the Living Lab's style:
 *   - opened from the radar card's Open button; three.js is fetched only
 *     then, and only from this app (/vendor/three/);
 *   - the 3D scene renders (WebGL) with one blip per finding the card
 *     shows, and its state follows the card: flagged findings -> "Flagged
 *     findings" (never the word safe);
 *   - under prefers-reduced-motion a still 2D drawing shows instead and
 *     three.js is never fetched;
 *   - closing the screen tears the scene down.
 * Writes docs/screenshots/threat-radar-screen-380-dark.png and
 * threat-radar-screen-reduced-380-dark.png.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/threat-radar-screen.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { startCommandCentreServer, openPhonePage, sendAndSettle, radarView } from '../helpers/commandCentre.mjs';
import { normalizeRadarView } from '../../public/lab/threat-radar-scene.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');

let chromium = null;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  skip = 'playwright is not installed (npm install)';
}
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()}`;

test('normalizeRadarView: the state from the counts, blips clamped, never more than 60', () => {
  assert.equal(normalizeRadarView(null).state, 'empty');
  assert.equal(normalizeRadarView({ findings: [{ status: 'no_flags' }], counts: { no_flags: 1 } }).state, 'clear');
  assert.equal(normalizeRadarView({ findings: [{ status: 'unknown' }], counts: { unknown: 1 } }).state, 'watch');
  assert.equal(normalizeRadarView({ findings: [{ status: 'flagged', kev: true }], counts: { flagged: 1 } }).state, 'alert');
  const d = normalizeRadarView({ findings: Array.from({ length: 80 }, () => ({ status: 'odd', ring: 9, angle: -30 })), counts: {} });
  assert.equal(d.findings.length, 60);
  assert.deepEqual([d.findings[0].status, d.findings[0].ring, d.findings[0].angle], ['unknown', 0.96, 330]);
});

for (const motion of ['no-preference', 'reduce']) {
  test(`the full-screen threat radar (${motion === 'reduce' ? 'reduced motion: 2D' : '3D'}) at 380 px`, { skip, timeout: 120000 }, async (t) => {
    const radar = await radarView();
    const { server, log, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, radar });
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
    const { page, errors } = await openPhonePage(browser, origin, { routeReplyFont, reducedMotion: motion });
    const reply = await sendAndSettle(page, '/threat-radar');
    assert.ok(!log.paths.some((p) => p.startsWith('/vendor/three/')), 'three.js is not loaded before the screen opens');
    await reply.locator('.radar-open').click();
    const screen = page.locator('#radar-screen');
    await screen.waitFor({ state: 'visible' });
    const holder = page.locator('#radar-scene');
    await page.waitForFunction(() => document.querySelector('#radar-scene').dataset.radarState);
    const expected = radar.findings.length;
    assert.equal(Number(await holder.getAttribute('data-blips')), expected, 'one blip per finding on the card');
    assert.equal(await holder.getAttribute('data-radar-state'), 'alert');
    assert.equal(await page.locator('#radar-mode').innerText(), 'Flagged findings');
    assert.match(await page.locator('#radar-legend-counts').innerText(), new RegExp(`${expected} findings · ${radar.counts.flagged} flagged`));
    assert.match(await page.locator('#radar-screen-summary').textContent(), /recent findings/);
    if (motion === 'reduce') {
      assert.equal(await holder.getAttribute('data-renderer'), '2d', 'the still drawing');
      await page.waitForTimeout(300);
      assert.equal(await holder.getAttribute('data-frames'), null, 'nothing animates');
      assert.ok(!log.paths.some((p) => p.startsWith('/vendor/three/')), 'three.js never fetched');
    } else {
      assert.equal(await holder.getAttribute('data-renderer'), 'webgl');
      await page.waitForFunction(() => Number(document.querySelector('#radar-scene').dataset.frames) > 10, null, { timeout: 20000 });
      assert.ok(log.paths.some((p) => p.startsWith('/vendor/three/')), 'three.js from this app');
    }
    assert.doesNotMatch(await screen.innerText(), /\bsafe\b/i);
    mkdirSync(SHOTS_DIR, { recursive: true });
    await page.waitForTimeout(motion === 'reduce' ? 200 : 1500);
    await page.screenshot({ path: join(SHOTS_DIR, `threat-radar-screen${motion === 'reduce' ? '-reduced' : ''}-380-dark.png`) });
    // Close: the scene is torn down.
    await page.locator('#radar-screen [data-dialog-close]').click();
    await screen.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#radar-scene canvas').count(), 0);
    // After a reload the card comes back from the saved chat, and its Open
    // still works from the card's own data.
    await page.reload({ waitUntil: 'load' });
    if (await page.locator('#auth-modal').isVisible()) {
      await page.fill('#auth-user', 'operator');
      await page.fill('#auth-pass', 'passkey');
      await page.press('#auth-pass', 'Enter');
      await page.waitForSelector('#auth-modal', { state: 'hidden' });
    }
    const restored = page.locator('#chat-container .radar-card .radar-open').last();
    await restored.waitFor({ state: 'visible' });
    await restored.click();
    await screen.waitFor({ state: 'visible' });
    await page.waitForFunction(() => Number(document.querySelector('#radar-scene').dataset.blips) > 0);
    assert.equal(Number(await holder.getAttribute('data-blips')), expected, 'the restored card opens with the same findings');
    assert.equal(await page.locator('#radar-mode').innerText(), 'Flagged findings');
    await page.locator('#radar-screen [data-dialog-close]').click();
    assert.deepEqual(errors, []);
  });
}
