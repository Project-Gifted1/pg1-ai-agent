/**
 * Navigating and recording the Sandbox in a real browser (Chromium via
 * Playwright), on the universe: keys work with focus anywhere on the page
 * but a text field; N and B follow the next and previous moving thing; T
 * runs the tour; V records a video of the view (made in the browser and
 * saved as a file), during which the quality tier never changes; Play keeps
 * running while recording, and stopping saves the video.
 *
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/sandbox-recording.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { createSandboxStore, __resetSandboxMemory } from '../../lib/sandbox/store.mjs';
import { createWorld, stepWorldFor, pg1Principal } from '../../lib/sandbox/worlds.mjs';
import sandboxViewer, { __setSandboxViewerStore } from '../../api/sandbox.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');

let chromium = null;
let skip = false;
try { ({ chromium } = await import('playwright')); } catch (e) { skip = 'playwright is not installed (npm install)'; }
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()}`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8' };
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

function startServer(store) {
  const log = { steps: [] };
  process.env.USER_API_KEY = 'operator';
  process.env.USER_API_PASS = 'passkey';
  __setSandboxViewerStore(() => store);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      const json = (status, b) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (url.pathname === '/api/sandbox') {
        const out = { statusCode: 200, body: null, setHeader() {}, getHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } };
        await sandboxViewer({ method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' }, body: parsed }, out);
        if (parsed && parsed.op === 'step') log.steps.push(out.statusCode);
        return json(out.statusCode, out.body);
      }
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/chat' && parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: true });
        if (url.pathname === '/api/health') return json(200, { status: 'ok' });
        if (url.pathname === '/api/errors') return json(200, { errors: [], ok: true });
        if (url.pathname === '/api/threads') return json(200, { threads: [] });
        if (url.pathname === '/api/handoffs') return json(200, { handoffs: [] });
        if (url.pathname === '/api/watches') return json(200, { ok: true, reports: [] });
        return json(404, { error: 'not stubbed' });
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = normalize(join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      const data = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
      res.end(data);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, log, origin: `http://127.0.0.1:${server.address().port}` })));
}

async function signedInPage(browser, origin, pace) {
  const context = await browser.newContext({ viewport: { width: 380, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await routeReplyFont(context);
  await context.addInitScript((p) => { try { localStorage.setItem('pg1_theme', 'dark'); localStorage.setItem('pg1_sandbox_quality', 'low'); } catch (e) {} }, pace);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err && err.message || err)));
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  return { page, errors, context };
}

const sel = (page) => page.evaluate(() => sandboxScene.inner && sandboxScene.inner.selected());

test('keys, Next and Previous, the tour, and a recording that saves a video without a quality change', { skip, timeout: 900000 }, async (t) => {
  __resetSandboxMemory();
  const store = createSandboxStore();
  const pg1 = pg1Principal();
  const w = await createWorld(store, pg1, { name: 'Pg1-Universe', template: 'universe' });
  await stepWorldFor(store, pg1, { world_id: w.id, steps: 20 });
  const { server, log, origin } = await startServer(store);
  const browser = await chromium.launch({ args: GL });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  const { page, errors, context } = await signedInPage(browser, origin, 10);
  await page.evaluate((id) => openSandboxScreen(id), w.id);
  await page.waitForFunction(() => /^Step \d+ · /.test(document.getElementById('sandbox-tick').textContent), null, { timeout: 120000 });
  if (await page.locator('#sandbox-view').getAttribute('data-renderer') !== 'webgl') { t.skip('no WebGL in this browser'); return; }
  // Focus on the page, not the canvas: the keys still work.
  await page.locator('#sandbox-world-line').click();
  await page.keyboard.press('n');
  const a = await sel(page);
  assert.ok(a, 'N follows something');
  assert.equal(await page.locator('#sandbox-view').getAttribute('data-view'), 'follow');
  await page.keyboard.press('n');
  const b = await sel(page);
  assert.ok(b && b !== a, 'N again: the next one');
  await page.keyboard.press('b');
  assert.equal(await sel(page), a, 'B: back to the one before');
  await page.click('#sandbox-next');
  assert.notEqual(await sel(page), a, 'the Next button');
  // On a phone, in full screen: the touch pad on the view.
  await page.evaluate(() => toggleSandboxFull());
  const pad = page.locator('#sandbox-pad');
  assert.equal(await pad.isVisible(), true, 'the pad shows in full screen');
  const box = await pad.locator('[data-pad="next"]').boundingBox();
  assert.ok(box.width >= 44 && box.height >= 44, 'thumb-sized');
  const before = await sel(page);
  await pad.locator('[data-pad="next"]').tap();
  assert.notEqual(await sel(page), before, 'tap ▶: the next one');
  const d0 = await page.evaluate(() => sandboxScene.inner.cameraState().dist);
  await pad.locator('[data-pad="in"]').tap();
  await page.waitForFunction((d) => sandboxScene.inner.cameraState().dist < d, d0, { timeout: 120000 });
  await page.tap('.sandbox-full-exit');
  // Held keys move the camera.
  const cam0 = await page.evaluate(() => sandboxScene.inner.cameraState().theta);
  // (Held until the camera has turned: frames are slow on a software GPU.)
  await page.keyboard.down('e');
  await page.waitForFunction((c) => sandboxScene.inner.cameraState().theta !== c, cam0, { timeout: 120000 });
  await page.keyboard.up('e');
  // Typing in a field is never taken as a key.
  const current = await sel(page);
  await page.focus('#sandbox-world');
  await page.keyboard.press('n');
  assert.equal(await sel(page), current, 'N in a field changes nothing');
  await page.locator('#sandbox-world-line').click();
  // The tour.
  await page.keyboard.press('t');
  assert.equal(await page.locator('#sandbox-view').getAttribute('data-view'), 'tour');
  // Record: V, with Play running.
  const tier = await page.locator('#sandbox-view').getAttribute('data-tier');
  await page.keyboard.press('v');
  assert.equal(await page.locator('#sandbox-view').getAttribute('data-recording'), '1');
  assert.equal(await page.locator('#sandbox-rec').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#sandbox-rec').innerText(), /^● Stop \d+:\d\d$/, 'the browser records the video itself');
  assert.equal(await page.evaluate(() => sandboxScene.inner.governor.auto), false, 'no automatic quality change while recording');
  await page.click('#sandbox-play');
  assert.equal(await page.locator('#sandbox-pad [data-pad="rec"]').innerText(), '■ Stop', 'Stop on the pad while recording');
  assert.equal(await page.locator('#sandbox-pad [data-pad="next"]').isVisible(), false, 'the rest of the pad steps aside');
  const steps0 = log.steps.length;
  await page.waitForFunction(() => Number(document.getElementById('sandbox-view').dataset.frames || 0) > 0);
  await page.waitForTimeout(6000);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.keyboard.press('v')]);
  assert.match(download.suggestedFilename(), /^simulation-pg1-universe-step-\d+\.(?:webm|mp4)$/);
  const file = await download.path();
  const { statSync } = await import('node:fs');
  assert.ok(statSync(file).size > 1000, `a video file (${statSync(file).size} bytes)`);
  assert.equal(await page.locator('#sandbox-view').getAttribute('data-tier'), tier, 'the tier never changed');
  assert.equal(await page.locator('#sandbox-view').getAttribute('data-recording'), '0');
  assert.ok(log.steps.length > steps0 && log.steps.every((s) => s === 200), 'Play kept running while recording');
  await page.click('#sandbox-play');
  assert.deepEqual(errors, []);
  t.diagnostic(`recorded ${statSync(file).size} bytes (${download.suggestedFilename()})`);
  await context.close();
});
