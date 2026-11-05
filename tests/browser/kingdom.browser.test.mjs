/**
 * PG1 City (Kingdom Defence) in the Command Centre, in a real browser at
 * 412 px (the Pixel-class phone profile the viewer tests use), dark.
 *
 * The feed in these tests is a TEST FIXTURE (tests/helpers/kingdomFixtures.mjs),
 * built through the real lib/defenseFeed.mjs; screenshots made from it are
 * named *-test-fixture.png. The app never sees it.
 *
 *   - Fix 1: every rendered caller hash is the real per-caller short hash,
 *     never a placeholder; a 402-shaped row on a free tool never shows;
 *     the empty feed says "No defence events in the last 24 hours" and the
 *     city is calm with no gadget fired;
 *   - the city: no island, wall or moat, no unnamed (placeholder) block; the
 *     PG1 Tower, the river, the bridge and the pier are there; the shield is
 *     invisible until a gadget fires;
 *   - each gadget fires only on its own fixture events;
 *   - the tower and guardians follow PG1's state: sentinels = live checks,
 *     beacon gold (Ready), SEAL tier bronze, rooftop beacons = approvals,
 *     lanterns = payments settled today; no PG1 unit leaves the city;
 *   - three.js only from this app, only when the view opens; reduced motion:
 *     a still 2D picture and the text feed; /kingdom; recording.
 * Writes docs/screenshots/kingdom-city-*.png.
 * Skipped (not failed) when Playwright or a Chromium is not installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { startCommandCentreServer, openPhonePage } from '../helpers/commandCentre.mjs';
import { fixtureFeed, fixtureCallerHashes, FIXTURE_APPROVALS } from '../helpers/kingdomFixtures.mjs';
import { PLACEHOLDER_CALLER_HASHES } from '../../public/kingdom/kingdom-data.js';
import { CITY_R } from '../../public/kingdom/kingdom-world.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');

let chromium = null;
let executablePath;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  skip = 'playwright is not installed (npm install)';
}
if (chromium && !existsSync(chromium.executablePath())) {
  if (existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  else skip = `Chromium is not installed at ${chromium.executablePath()}`;
}
const launch = () => chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const view = (page) => page.evaluate(() => ({ ...document.getElementById('kingdom-view').dataset }));

test('PG1 City at 412 px: fixture events render with real per-caller hashes, gadgets fire only on their events, the tower follows PG1 state', { skip, timeout: 300000 }, async (t) => {
  const feed = fixtureFeed();
  const { server, log, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: (url) => feed(url) });
  const browser = await launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, errors } = await openPhonePage(browser, origin, { width: 412, height: 915, routeReplyFont });
  const mini = page.locator('#kingdom-mini');
  await mini.waitFor({ state: 'visible', timeout: 20000 });
  assert.ok(!log.paths.some((p) => p.startsWith('/vendor/three/') || p.startsWith('/kingdom/kingdom-scene')), 'no 3D before the view opens');
  assert.ok(log.feeds.every((f) => f.operator && !/user|pass/.test(f.query)), 'credentials in the body only');
  await mini.click();
  await page.locator('#kingdom-screen').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === 'webgl' && Number(document.getElementById('kingdom-view').dataset.frames || 0) > 3, null, { timeout: 90000 });
  assert.ok(log.paths.some((p) => p.startsWith('/vendor/three/')), 'three.js from this app');

  // Fix 1: caller hashes are the real per-caller short hashes, never a placeholder.
  const real = new Set(Object.values(fixtureCallerHashes()).map((h) => h.slice(0, 8)));
  const shown = await page.$$eval('#kingdom-feed .kd-row code', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(shown.length >= 6);
  for (const h of shown) {
    assert.ok(!PLACEHOLDER_CALLER_HASHES.includes(h), `placeholder hash ${h} rendered`);
    assert.ok(h === '—' || real.has(h), `${h} is no caller's real hash`);
  }
  assert.ok(new Set(shown.filter((h) => h !== '—')).size >= 4, 'different callers, different hashes');
  const text = await page.locator('#kingdom-feed').textContent();
  assert.ok(!/check_package · stopped at the toll/.test(text), 'a free tool never shows a 402');
  assert.match(text, /preflight_check · stopped at the toll \(402\)/);
  assert.match(text, /—/, 'a report has no caller: "—"');

  // The city: no island, wall or moat; no placeholder block; the landmarks.
  const inside = await page.evaluate(() => window.kingdomUi && window.kingdomUi.scene() && window.kingdomUi.scene().inspect());
  assert.ok(inside, 'inspect()');
  assert.equal(inside.unnamed, 0, 'no unnamed (placeholder) mesh');
  for (const n of inside.names) assert.ok(!/island|wall|moat|merlon|gatehouse|portcullis|container/i.test(n), n);
  for (const n of ['pg1-tower', 'tower-spire', 'tower-beacon', 'river', 'bridge-arch', 'pier-deck', 'skyline-box', 'street-lights', 'car-lights']) assert.ok(inside.names.includes(n), `${n} missing`);
  assert.ok(inside.buildings > 400, 'a city to the horizon');

  // PG1 state: sentinels = live checks, gold beacon, bronze SEAL, beacons = approvals.
  let d = await view(page);
  const { listedTools } = await import('../../api/mcp.mjs');
  assert.equal(Number(d.sentinels), listedTools({}).length, 'one sentinel per live check');
  assert.equal(d.beacon, 'gold');
  assert.equal(d.seal, 'bronze');
  assert.equal(d.passkeys, 'true');
  assert.equal(Number(d.beaconsLit), FIXTURE_APPROVALS);
  assert.equal(Number(d.lanterns), 1, 'one payment settled today: one lantern');
  assert.match(await page.locator('#kingdom-hud').textContent(), new RegExp(`Defences active: ${listedTools({}).length} checks live · \\d+ threats turned away today · 1 payments settled`));

  // Gadgets fire only on their own events (the recent fixture events).
  await page.waitForFunction(() => { const f = JSON.parse(document.getElementById('kingdom-view').dataset.fired || '{}'); return f.gate_wardens && f.toll_bridge && f.phishing_net && f.rate_shield; }, null, { timeout: 150000, polling: 500 })
    .catch(async (e) => { throw new Error(`${e.message} ${JSON.stringify(await view(page))}`); });
  d = await view(page);
  const fired = JSON.parse(d.fired);
  for (const g of ['truth_lens', 'sanctions_gate', 'supply_inspector', 'passkey_vault', 'preflight_ward', 'seal_forge', 'allies']) assert.ok(!fired[g], `${g} fired without its event`);
  assert.ok(Number(d.pg1MaxR) <= CITY_R + 1, `a PG1 unit left the city (${d.pg1MaxR} m)`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'kingdom-city-event-412-test-fixture.png') });

  // Record mode: a 9:16 clip, stopped early; saved on the device.
  await page.click('#kingdom-record-btn');
  await page.selectOption('#kingdom-record-aspect', '9:16');
  await page.click('#kingdom-record-go');
  await page.waitForFunction(() => /Recording/.test(document.getElementById('kingdom-record-status').textContent), null, { timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.click('#kingdom-record-go');
  await page.locator('#kingdom-record-file').waitFor({ state: 'visible', timeout: 30000 });
  assert.match(await page.locator('#kingdom-record-file').getAttribute('download'), /^pg1-kingdom-.*\.(mp4|webm)$/);
  await page.click('#kingdom-record-btn');
  await page.click('#kingdom-screen [data-dialog-close]');
  await page.locator('#kingdom-screen').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#kingdom-view canvas').count(), 0);
  await page.fill('#prompt-input', '/kingdom');
  await page.click('.execute-btn');
  await page.locator('#kingdom-screen').waitFor({ state: 'visible' });
  assert.ok(!log.prompts.includes('/kingdom'));
  assert.deepEqual(errors, []);
});

test('an empty feed: "No defence events in the last 24 hours", a calm city, the shield invisible, no gadget fired', { skip, timeout: 200000 }, async (t) => {
  const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR });
  const browser = await launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  for (const [w, h, name] of [[412, 915, '412'], [1280, 800, '1280']]) {
    const { page, context } = await openPhonePage(browser, origin, { width: w, height: h, routeReplyFont });
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('#kingdom-mini').isHidden(), true, 'no events, no mini-view');
    await page.fill('#prompt-input', '/kingdom');
    await page.click('.execute-btn');
    await page.waitForFunction(() => Number(document.getElementById('kingdom-view').dataset.frames || 0) > 12, null, { timeout: 120000 });
    const d = await view(page);
    assert.equal(d.attackers, '0');
    assert.equal(d.fired, '{}', 'no gadget fires on an empty feed');
    assert.equal(d.shield, 'hidden', 'the shield is invisible until a gadget fires');
    assert.equal(await page.locator('#kingdom-mode').getAttribute('data-mode'), 'calm');
    assert.match(await page.locator('#kingdom-feed').textContent(), /No defence events in the last 24 hours/);
    mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: join(SHOTS_DIR, `kingdom-city-default-${name}.png`) });
    await context.close();
  }
});

test('reduced motion: a still 2D picture and the text feed; three.js never fetched', { skip, timeout: 120000 }, async (t) => {
  const feed = fixtureFeed();
  const { server, log, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: (url) => feed(url) });
  const browser = await launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, errors } = await openPhonePage(browser, origin, { width: 412, height: 915, routeReplyFont, reducedMotion: 'reduce' });
  await page.locator('#kingdom-mini').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#kingdom-mini').click();
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === '2d', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#kingdom-feed .kd-row').length > 0);
  assert.ok(!log.paths.some((p) => p.startsWith('/vendor/three/')));
  assert.deepEqual(errors, []);
});
