/**
 * PG1 Kingdom Defence in the Command Centre, in a real browser at 412 px
 * (the Pixel-class phone profile the viewer tests use), dark:
 *   - signed in, the mini-view in the thread feed shows the latest real
 *     event in one line; tapping it opens the full view;
 *   - three.js is fetched only when the view opens, and only from this app;
 *   - the scene renders (WebGL) and stages figures for the recent events,
 *     the text feed lists the same events (time, country, check, verdict,
 *     count) and the legend lists every gadget with today's count;
 *   - the view polls /api/defense-feed with ?since while open, with the
 *     credentials in the body only;
 *   - /kingdom opens it too; closing tears the scene down;
 *   - under prefers-reduced-motion: the still 2D map and the text feed,
 *     three.js never fetched;
 *   - an empty feed: the kingdom is calm, nothing is staged.
 * The feed is built by the real lib/defenseFeed.mjs from seeded rows.
 * Writes docs/screenshots/kingdom-412-dark.png and kingdom-reduced-412-dark.png.
 * Skipped (not failed) when Playwright or a Chromium is not installed.
 * Run with: node --test tests/browser/kingdom.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { startCommandCentreServer, openPhonePage } from '../helpers/commandCentre.mjs';
import { buildDefenseFeed } from '../../lib/defenseFeed.mjs';

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
// Playwright's own Chromium, else the one this machine has.
if (chromium && !existsSync(chromium.executablePath())) {
  if (existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  else skip = `Chromium is not installed at ${chromium.executablePath()}`;
}

const HASH = 'c0ffee00' + 'a'.repeat(24);
function seededFeed() {
  return async (url) => {
    const now = Date.now();
    const iso = (ms) => new Date(now - ms).toISOString();
    const tables = {
      agent_telemetry: [
        ...Array.from({ length: 30 }, () => ({ created_at: iso(40000), event_type: 'tool_call', endpoint: '/api/mcp', status: 'unknown_tool', caller_hash: HASH, country_code: 'CN' })),
        { created_at: iso(70000), event_type: 'tool_call', endpoint: '/api/mcp', status: 'payment_required', tool_name: 'check_package', caller_hash: HASH, country_code: 'US' },
        { created_at: iso(90000), event_type: 'settlement', endpoint: '/api/mcp', status: 'settled', tool_name: 'check_package', caller_hash: HASH, country_code: 'DE' },
        ...Array.from({ length: 12 }, () => ({ created_at: iso(50000), event_type: 'tool_call', endpoint: '/api/a2a', status: 'rate_limited', caller_hash: HASH, country_code: null })),
        { created_at: iso(5 * 3600e3), event_type: 'tool_call', endpoint: '/api/mcp', status: 'server_error', tool_name: 'check_domain_age', caller_hash: HASH, country_code: 'IE' }
      ],
      pg1_defense_events: [{ created_at: iso(20000), check_name: 'check_agent_message', endpoint: '/api/mcp', verdict_code: 'malicious', reason_codes: ['AGENT_MESSAGE_PAYMENT_REDIRECT'], severity: 'high', subject_kind: 'skill_md', country_code: 'NL', caller_hash: HASH }],
      pg1_operator_reports: [{ created_at: iso(3 * 3600e3), kind: 'daily' }]
    };
    const fetchImpl = async (u) => new Response(JSON.stringify(tables[new URL(String(u)).pathname.split('/').pop()] || []), { status: 200 });
    const since = Number(url.searchParams.get('since')) || null;
    return buildDefenseFeed({ supUrl: 'https://db.test', supKey: 'k', fetchImpl, now, since, env: {} });
  };
}

async function launch() {
  return chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
}

test('the Kingdom view at 412 px: the mini-view, the 3D scene, the text feed and the legend, from real events only', { skip, timeout: 240000 }, async (t) => {
  const feed = seededFeed();
  const { server, log, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: (url) => feed(url) });
  const browser = await launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, errors } = await openPhonePage(browser, origin, { width: 412, height: 915, routeReplyFont });
  // Feeds are async (buildDefenseFeed): the stub answers a promise.
  const mini = page.locator('#kingdom-mini');
  await mini.waitFor({ state: 'visible', timeout: 20000 });
  assert.match(await page.locator('#kingdom-mini-line').textContent(), /Truth Lens: skill\.md from NL, malicious, PAYMENT_REDIRECT/);
  assert.ok(!log.paths.some((p) => p.startsWith('/vendor/three/') || p.startsWith('/kingdom/kingdom-scene')), 'no 3D before the view opens');
  assert.ok(log.feeds.every((f) => f.operator && !/user|pass/.test(f.query)), 'credentials in the body only');

  await mini.click();
  const screen = page.locator('#kingdom-screen');
  await screen.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer, null, { timeout: 60000 });
  assert.equal(await page.locator('#kingdom-view').getAttribute('data-renderer'), 'webgl');
  assert.ok(log.paths.some((p) => p.startsWith('/vendor/three/')), 'three.js from this app');
  await page.waitForFunction(() => Number(document.getElementById('kingdom-view').dataset.attackers || 0) > 0, null, { timeout: 60000 });
  assert.equal(await page.locator('#kingdom-view').getAttribute('data-tier'), 'phone', 'a phone starts on the Phone tier');
  // The text feed: the same events, readable.
  const rows = page.locator('#kingdom-feed .kd-row');
  assert.ok(await rows.count() >= 6);
  const text = await page.locator('#kingdom-feed').textContent();
  assert.match(text, /NL/); assert.match(text, /check_agent_message/); assert.match(text, /×30/); assert.match(text, /fog/); assert.match(text, /PG1 took a hit \(PG1 fault\)/);
  assert.ok(!text.includes(HASH), 'never the full caller hash');
  assert.equal(await page.locator('#kingdom-feed').getAttribute('role'), 'log');
  // The legend: every gadget with today's count, the reserved two idle.
  assert.equal(await page.locator('#kingdom-legend li').count(), 15);
  assert.equal(await page.locator('#kingdom-legend li[data-reserved="true"]').count(), 2);
  assert.equal((await page.locator('#kingdom-legend li[data-gadget="gate_wardens"] .kd-gcount').textContent()).trim(), '30');
  assert.equal(await page.locator('#kingdom-mode').getAttribute('data-mode'), 'watch');
  // The poll, with ?since.
  await page.waitForTimeout(6500);
  assert.ok(log.feeds.some((f) => f.since), 'polled with ?since while open');
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'kingdom-412-dark.png') });
  // Record mode: a 9:16 replay of the day's real events, stopped early; the clip is saved on the device.
  await page.click('#kingdom-record-btn');
  await page.selectOption('#kingdom-record-aspect', '9:16');
  await page.selectOption('#kingdom-record-mode', 'replay');
  await page.click('#kingdom-record-go');
  await page.waitForFunction(() => /Recording/.test(document.getElementById('kingdom-record-status').textContent), null, { timeout: 20000 });
  assert.equal(await page.locator('#kingdom-director').getAttribute('aria-pressed'), 'true', 'the director camera records');
  await page.waitForTimeout(4000);
  await page.click('#kingdom-record-go');
  await page.locator('#kingdom-record-file').waitFor({ state: 'visible', timeout: 20000 });
  assert.match(await page.locator('#kingdom-record-file').getAttribute('download'), /^pg1-kingdom-.*\.(mp4|webm)$/);
  assert.ok(await page.evaluate(async () => (await (await fetch(document.getElementById('kingdom-record-file').href)).blob()).size > 1000), 'a real clip');
  assert.match(await page.locator('#kingdom-record-status').textContent(), /real PG1 events/);
  await page.click('#kingdom-record-btn');
  // Close: torn down, the mini-view back.
  await page.click('#kingdom-screen [data-dialog-close]');
  await screen.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#kingdom-view canvas').count(), 0);
  // /kingdom opens it again.
  await page.fill('#prompt-input', '/kingdom');
  await page.click('.execute-btn');
  await screen.waitFor({ state: 'visible' });
  assert.ok(!log.prompts.includes('/kingdom'), '/kingdom is handled by the page');
  assert.deepEqual(errors, []);
});

test('reduced motion: the still 2D map and the text feed; three.js never fetched', { skip, timeout: 120000 }, async (t) => {
  const feed = seededFeed();
  const { server, log, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: (url) => feed(url) });
  const browser = await launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, errors } = await openPhonePage(browser, origin, { width: 412, height: 915, routeReplyFont, reducedMotion: 'reduce' });
  await page.locator('#kingdom-mini').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#kingdom-mini').click();
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === '2d', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#kingdom-feed .kd-row').length > 0);
  assert.ok(!log.paths.some((p) => p.startsWith('/vendor/three/')));
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'kingdom-reduced-412-dark.png') });
  assert.deepEqual(errors, []);
});

test('an empty feed: the kingdom is calm and nothing is staged', { skip, timeout: 120000 }, async (t) => {
  const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR });
  const browser = await launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page } = await openPhonePage(browser, origin, { width: 412, height: 915, routeReplyFont });
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('#kingdom-mini').isHidden(), true, 'no events, no mini-view');
  await page.fill('#prompt-input', '/kingdom');
  await page.click('.execute-btn');
  await page.waitForFunction(() => Number(document.getElementById('kingdom-view').dataset.frames || 0) > 2, null, { timeout: 60000 });
  assert.equal(await page.locator('#kingdom-view').getAttribute('data-attackers'), '0');
  assert.equal(await page.locator('#kingdom-mode').getAttribute('data-mode'), 'calm');
  assert.match(await page.locator('#kingdom-feed').textContent(), /calm/);
});
