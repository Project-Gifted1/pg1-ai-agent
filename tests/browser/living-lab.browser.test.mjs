/**
 * The living lab (public/lab/living-lab.js) in a real browser (Chromium via
 * Playwright, phone-sized):
 *   - three.js is not loaded until the lab screen opens, and then only from
 *     this app (/vendor/three/): the lab fetches nothing from another host
 *     (the page's own reply font is the test helper's, routed locally);
 *   - the 3D scene renders (WebGL) and follows the server's state
 *     (/api/watches op lab_scene): its mode, one ring per experiment;
 *   - under prefers-reduced-motion the calm 2D drawing shows instead and
 *     three.js is never fetched;
 *   - closing the screen tears the scene down.
 * Writes docs/screenshots/living-lab-360-dark.png and
 * living-lab-reduced-360-dark.png. Skipped (not failed) when Playwright or
 * its Chromium is not installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';

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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8' };

const SCENE = {
  mode: 'running',
  experiments: [{ id8: 'a1b2c3d4', status: 'running' }, { id8: 'e5f6a7b8', status: 'queued' }, { id8: 'c9d0e1f2', status: 'done' }],
  events: [{ id: 'w-1', kind: 'webhook', at: new Date().toISOString() }, { id: 'a-1', kind: 'scan', at: new Date().toISOString() }, { id: 'f-1', kind: 'feed', at: new Date().toISOString() }]
};

function startStubServer() {
  const log = { paths: [], missing: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    log.paths.push(url.pathname);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      const json = (status, b) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health') return json(200, { status: 'ok' });
        if (url.pathname === '/api/errors') return json(200, { errors: [], ok: true });
        if (url.pathname === '/api/handoffs') return json(200, { handoffs: [] });
        if (url.pathname === '/api/threads') return json(200, { threads: [] });
        if (url.pathname === '/api/watches') {
          if (!parsed || parsed.user !== 'operator' || parsed.pass !== 'passkey') return json(401, { error: 'unauthorized' });
          if (parsed.op === 'lab_scene') return json(200, { ok: true, scene: SCENE });
          if (parsed.op === 'inbox') return json(200, { ok: true, reports: [] });
          return json(200, { ok: true });
        }
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: parsed.user === 'operator' && parsed.pass === 'passkey' });
          return json(200, { reply: 'ok' });
        }
        log.missing.push(url.pathname);
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

// The 3D scene renders in software (SwiftShader) on CI, alongside other
// browser test files: a small phone at pixel ratio 1 keeps its CPU use low,
// so timing-sensitive tests running at the same time are not starved.
async function openPhone(browser, origin, { reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion });
  await routeReplyFont(context);
  await context.addInitScript(() => { try { localStorage.setItem('pg1_theme', 'dark'); } catch (e) {} });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  const problems = [];
  page.on('pageerror', (err) => problems.push(String(err && err.message || err)));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  return { context, page, requests, problems };
}

async function openLab(page) {
  await page.click('#drawer-btn');
  await page.waitForFunction(() => document.body.classList.contains('drawer-open'));
  await page.click('#lab-drawer-item');
  await page.locator('#lab-screen').waitFor({ state: 'visible' });
}

const offOrigin = (requests, origin) => requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'));

test('living lab: three.js only on the lab screen and only from the app; the 3D scene renders the real state', { skip, timeout: 180000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, requests, problems } = await openPhone(browser, origin);
  assert.ok(!requests.some((u) => u.includes('/vendor/three/') || u.includes('/lab/living-lab.js')), 'nothing of the lab is loaded before the screen opens');

  // Everything the lab screen loads, from here on.
  const before = requests.length;
  await openLab(page);
  await page.waitForFunction(() => document.getElementById('living-lab').dataset.renderer, null, { timeout: 30000 });
  const renderer = await page.locator('#living-lab').getAttribute('data-renderer');
  assert.equal(renderer, 'webgl', 'the 3D scene (WebGL)');
  await page.waitForFunction(() => document.getElementById('living-lab').dataset.labMode === 'running');
  await page.waitForFunction(() => Number(document.getElementById('living-lab').dataset.frames || 0) > 5, null, { timeout: 30000 });
  assert.equal(await page.locator('#lab-mode').innerText(), 'Running');
  assert.match(await page.locator('#lab-legend-counts').innerText(), /3 experiments · 3 events in 2 h/);
  assert.match(await page.locator('#lab-screen-summary').textContent(), /2 experiments queued or running/);
  assert.ok(requests.some((u) => u === `${origin}/vendor/three/three.module.min.js`), 'three.js from the app itself');
  assert.deepEqual(offOrigin(requests.slice(before), origin), [], 'the lab fetches nothing from any other host');
  // The canvas draws something other than the background.
  mkdirSync(SHOTS_DIR, { recursive: true });
  const shot = await page.screenshot({ path: join(SHOTS_DIR, 'living-lab-360-dark.png') });
  assert.ok(shot.length > 20000, 'a drawn scene, not an empty screen');
  // The page underneath stays usable: closing tears the scene down.
  await page.click('#lab-screen [data-dialog-close]');
  await page.locator('#lab-screen').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#living-lab canvas').count(), 0);
  assert.deepEqual(problems.filter((p) => !/WebGL|GPU stall|swiftshader/i.test(p)), [], 'no page or console errors');
  assert.deepEqual(log.missing, []);
});

test('living lab: under prefers-reduced-motion the calm 2D drawing shows and three.js is never fetched', { skip, timeout: 180000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, requests, problems } = await openPhone(browser, origin, { reducedMotion: 'reduce' });
  const before = requests.length;
  await openLab(page);
  await page.waitForFunction(() => document.getElementById('living-lab').dataset.renderer === '2d');
  await page.waitForFunction(() => document.getElementById('living-lab').dataset.labMode === 'running');
  assert.equal(await page.locator('#living-lab canvas').count(), 1);
  assert.ok(!requests.some((u) => u.includes('/vendor/three/')), 'three.js is not loaded under reduced motion');
  assert.deepEqual(offOrigin(requests.slice(before), origin), [], 'the lab fetches nothing from any other host');
  assert.equal(await page.locator('#lab-mode').innerText(), 'Running');
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'living-lab-reduced-360-dark.png') });
  assert.deepEqual(problems, [], 'no page or console errors');
  assert.deepEqual(log.missing, []);
});
