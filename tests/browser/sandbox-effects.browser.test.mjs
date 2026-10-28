/**
 * What you see when something happens (public/sandbox/effects.js), at 380 px:
 * a meteorite striking the ground (streak, flash, shockwave, dust, the crater
 * that stays), one falling into the sea, sparks on a craft, a solar flare and
 * a battle in space. The events are handed to the viewer as the page would.
 * Writes docs/screenshots/sandbox-impact-*-380-dark.png.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
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
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');

let chromium = null;
let skip = false;
try { ({ chromium } = await import('playwright')); } catch (e) { skip = 'playwright is not installed (npm install)'; }
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()}`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8' };
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

function startServer(store) {
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
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

async function signedInPage(browser, origin, { tier = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 380, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await routeReplyFont(context);
  await context.addInitScript((t) => { try { localStorage.setItem('pg1_theme', 'dark'); if (t) localStorage.setItem('pg1_sandbox_quality', t); else localStorage.removeItem('pg1_sandbox_quality'); } catch (e) {} }, tier);
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

const framesNow = (page) => page.evaluate(() => Number(document.getElementById('sandbox-view').dataset.frames || 0));
async function frames(page, n) { const f0 = await framesNow(page); await page.waitForFunction(([a, k]) => Number(document.getElementById('sandbox-view').dataset.frames || 0) >= a + k, [f0, n], { timeout: 240000 }); }
async function openWorld(page, id, tick) {
  await page.evaluate((w) => openSandboxScreen(w), id);
  await page.waitForFunction((t) => new RegExp(`^Step ${t} · `).test(document.getElementById('sandbox-tick').textContent), tick, { timeout: 90000 });
}
async function shot(page, name) { await page.screenshot({ path: join(SHOTS_DIR, `sandbox-impact-${name}-380-dark.png`), clip: await page.locator('#sandbox-view').boundingBox(), timeout: 180000 }); }
// Hands the viewer the world with one more thing and one more event, as a step would.
const happen = (page, entity, ev) => page.evaluate(([en, e]) => {
  const w = JSON.parse(JSON.stringify(sandboxState.world));
  if (en) w.entities.push(en);
  w.recent_events = [...(w.recent_events || []), { ...e, tick: w.tick }];
  sandboxState.world = w; sandboxScene.update(w, { duration: 1200 });
}, [entity, ev]);

test('effects: a meteorite strike (streak, flash, shockwave, dust, a crater that stays), a splash, sparks, a flare and a battle in space', { skip, timeout: 1800000 }, async (t) => {
  __resetSandboxMemory();
  const store = createSandboxStore();
  const pg1 = pg1Principal();
  const uni = await createWorld(store, pg1, { name: 'Pg1-Universe', template: 'universe' });
  await stepWorldFor(store, pg1, { world_id: uni.id, steps: 20 });
  const { server, origin } = await startServer(store);
  const browser = await chromium.launch({ args: GL });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  // Medium: on a software-rendered GPU (CI) High draws about a frame a second,
  // and the dust takes some 450 frames to settle.
  const { page, errors } = await signedInPage(browser, origin, { tier: 'medium' });
  await openWorld(page, uni.id, 20);
  if (await page.locator('#sandbox-view').getAttribute('data-renderer') !== 'webgl') { t.skip('no WebGL'); return; }
  await frames(page, 4);
  // A field near the town, the camera looking at it.
  const spot = await page.evaluate(() => { const h = sandboxState.world.entities.find((e) => e.kind === 'house'); return { x: h.position.x + 120, y: h.position.y + 120 }; });
  const crater = { id: 'crater-test-1', kind: 'crater', position: { x: spot.x, y: spot.y, z: 0 }, properties: { name: 'a meteorite crater', radius: 14, fell: 20 } };
  await happen(page, null, { kind: 'noop', summary: 'x' });
  await page.evaluate((c) => { const w = JSON.parse(JSON.stringify(sandboxState.world)); w.entities.push(c); sandboxState.world = w; sandboxScene.update(w); }, crater);
  await page.evaluate(() => sandboxScene.select('crater-test-1'));
  await frames(page, 30);
  await page.evaluate(() => { const w = JSON.parse(JSON.stringify(sandboxState.world)); w.recent_events = [...(w.recent_events || []), { tick: w.tick, kind: 'impact', ref: 'crater-test-1', summary: 'A meteorite struck the ground' }]; sandboxState.world = w; sandboxScene.update(w); });
  await page.waitForFunction(() => Number(document.getElementById('sandbox-view').dataset.effects) > 0, null, { timeout: 60000 });
  await frames(page, 6); await shot(page, 'streak');
  await frames(page, 10); await shot(page, 'flash');
  await frames(page, 30); await shot(page, 'dust');
  await page.waitForFunction(() => Number(document.getElementById('sandbox-view').dataset.effects) === 0, null, { timeout: 600000 });
  await shot(page, 'crater');
  // Sparks on a craft, a splash at sea, a flare, a battle: each plays and ends.
  for (const [ent, ev] of [
    [null, { kind: 'meteoroid', ref: 'rocket-1', summary: 'struck by meteoroids' }],
    [{ id: 'crater-test-sea', kind: 'crater', position: { x: 300, y: 300, z: 0 }, properties: { sea: true, radius: 8, fell: 20 } }, { kind: 'impact', ref: 'crater-test-sea', summary: 'into the water' }],
    [null, { kind: 'flare', summary: 'A solar flare' }],
    [null, { kind: 'space_battle', summary: 'Ships clashed in space, far from anyone\'s home' }],
    [null, { kind: 'impact', ref: 'moon-1', summary: 'A meteorite struck Lune' }]
  ]) {
    await happen(page, ent, ev);
    await page.waitForFunction(() => Number(document.getElementById('sandbox-view').dataset.effects) > 0, null, { timeout: 60000 });
  }
  assert.deepEqual(errors, []);
});
