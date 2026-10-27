/**
 * The Sandbox viewer's look, in a real browser (Chromium via Playwright) at
 * 380 px, on the universe template:
 *
 *   1. five views at High: the overview, following a car, a plane coming
 *      in to land, the harbour, and the town at night (its street lamps
 *      lit); then Cinematic: its screenshot button gives a PNG stamped
 *      "Simulation". Writes docs/screenshots/sandbox-look-<view>-<tag>-380-dark.png
 *      (tag "after" by default; SANDBOX_LOOK_TAG=before on main made the
 *      "before" set).
 *   2. frame time on a throttled phone profile (4x slower CPU, 380 px,
 *      touch, Auto quality): the view keeps drawing, and either holds 30
 *      fps or the quality governor steps down until it does or reaches Low.
 *      The numbers are printed; this machine renders WebGL in software
 *      (SwiftShader), so they are far slower than a real phone's GPU.
 *
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/sandbox-look.browser.test.mjs
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
const TAG = process.env.SANDBOX_LOOK_TAG || 'after';

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

async function openWorld(page, id, tick) {
  await page.evaluate((w) => openSandboxScreen(w), id);
  await page.waitForFunction((t) => new RegExp(`^Step ${t} · `).test(document.getElementById('sandbox-tick').textContent), tick, { timeout: 90000 });
}
const framesNow = (page) => page.evaluate(() => Number(document.getElementById('sandbox-view').dataset.frames || 0));
async function settle(page, ms) {
  const f0 = await framesNow(page);
  await page.waitForFunction((n) => Number(document.getElementById('sandbox-view').dataset.frames || 0) > n + 3, f0, { timeout: 180000 });
  await page.waitForTimeout(ms);
}
// Waits for n more frames (the camera eases over a few dozen; frames are slow in software).
async function frames(page, n, extraMs = 500) {
  const f0 = await framesNow(page);
  await page.waitForFunction(([a, k]) => Number(document.getElementById('sandbox-view').dataset.frames || 0) >= a + k, [f0, n], { timeout: 240000 });
  await page.waitForTimeout(extraMs);
}
async function shot(page, name) {
  const view = page.locator('#sandbox-view');
  await page.screenshot({ path: join(SHOTS_DIR, `sandbox-look-${name}-${TAG}-380-dark.png`), clip: await view.boundingBox(), timeout: 180000 });
}

test('the look at 380 px: overview, following a car, a plane landing, the harbour, the town at night; Cinematic and its screenshot', { skip, timeout: 1500000 }, async (t) => {
  __resetSandboxMemory();
  const store = createSandboxStore();
  const pg1 = pg1Principal();
  const uni = await createWorld(store, pg1, { name: 'Pg1-Universe', template: 'universe' });
  await stepWorldFor(store, pg1, { world_id: uni.id, steps: 40 });
  const { server, origin } = await startServer(store);
  const browser = await chromium.launch({ args: GL });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });

  const { page, errors, context } = await signedInPage(browser, origin, { tier: 'high' });
  await openWorld(page, uni.id, 40);
  if (await page.locator('#sandbox-view').getAttribute('data-renderer') !== 'webgl') { await context.close(); t.skip('no WebGL in this browser'); return; }
  assert.equal((await page.locator('#sandbox-label').innerText()).trim(), 'Simulation');
  await settle(page, 3000);
  await page.evaluate(() => sandboxScene.setView('overview'));
  await frames(page, 30);
  await shot(page, 'overview');

  // Follow a car on its road.
  await page.evaluate(() => { const e = sandboxState.world.entities.find((x) => x.kind === 'car' && !(x.properties && x.properties.inside)) || sandboxState.world.entities.find((x) => /car|bus|taxi/.test(x.kind)); sandboxScene.select(e.id); });
  await frames(page, 40);
  await shot(page, 'car');

  // A plane low over its runway (the lowest plane in the sky, else one on the ground).
  await page.evaluate(() => {
    const planes = sandboxState.world.entities.filter((x) => ['plane', 'small_plane', 'jet'].includes(x.kind));
    const air = planes.filter((p) => p.position.z > 1).sort((a, b) => a.position.z - b.position.z);
    sandboxScene.select((air[0] || planes[0]).id);
  });
  await frames(page, 40);
  await shot(page, 'plane');

  // The harbour.
  await page.evaluate(() => { const e = sandboxState.world.entities.find((x) => x.kind === 'port') || sandboxState.world.entities.find((x) => /ferry|ship|boat/.test(x.kind)); sandboxScene.select(e.id); });
  await frames(page, 40);
  await shot(page, 'harbour');
  // Explore: at eye height on a lake's shore, looking over the water (new in this PR).
  if (TAG !== 'before') {
    await exploreShore(page);
    assert.equal(await page.locator('#sandbox-view').getAttribute('data-view'), 'explore');
    await shot(page, 'explore');
  }
  assert.deepEqual(errors, [], 'no page errors by day');
  await context.close();

  // Night: on to step 160 (22:00 in the world), the town with its lamps.
  await stepWorldFor(store, pg1, { world_id: uni.id, steps: 60 });
  await stepWorldFor(store, pg1, { world_id: uni.id, steps: 60 });
  const night = await signedInPage(browser, origin, { tier: 'high' });
  await openWorld(night.page, uni.id, 160);
  await settle(night.page, 2500);
  await night.page.evaluate(() => { const e = sandboxState.world.entities.find((x) => x.kind === 'tower') || sandboxState.world.entities.find((x) => x.kind === 'house'); sandboxScene.select(e.id); sandboxScene.setView('free'); });
  await frames(night.page, 40);
  await shot(night.page, 'night');
  assert.match(await night.page.locator('.sandbox-clock').innerText(), /^Simulation · day 1 · 2[12]:/);
  assert.deepEqual(night.errors, [], 'no page errors at night');
  await night.context.close();

  // Cinematic: picked by hand, never by Auto; its screenshot says "Simulation".
  if (TAG !== 'before') {
    const cin = await signedInPage(browser, origin, { tier: 'cinematic' });
    await openWorld(cin.page, uni.id, 160);
    assert.equal(await cin.page.locator('#sandbox-view').getAttribute('data-tier'), 'cinematic');
    assert.equal(await cin.page.locator('#sandbox-quality').inputValue(), 'cinematic');
    await settle(cin.page, 2000);
    assert.ok(Number(await cin.page.locator('#sandbox-view').getAttribute('data-lamps')) > 50, 'street lamps along the roads');
    await cin.page.evaluate(() => sandboxScene.setView('overview'));
    await frames(cin.page, 30);
    await expectShotButton(cin.page);
    await shot(cin.page, 'cinematic');
    // By day for the explore shot (that world is at night now): a second universe at step 20.
    assert.deepEqual(cin.errors, [], 'no page errors in Cinematic');
    await cin.context.close();
    const uni2 = await createWorld(store, pg1, { name: 'Pg1-Universe-2', template: 'universe' });
    await stepWorldFor(store, pg1, { world_id: uni2.id, steps: 20 });
    const cin2 = await signedInPage(browser, origin, { tier: 'cinematic' });
    await openWorld(cin2.page, uni2.id, 20);
    await settle(cin2.page, 1500);
    await exploreShore(cin2.page);
    await shot(cin2.page, 'explore-cinematic');
    assert.deepEqual(cin2.errors, [], 'no page errors exploring in Cinematic');
    await cin2.context.close();
  }
});

async function exploreShore(page) {
  await page.evaluate(() => {
    const lake = sandboxState.world.entities.find((x) => x.kind === 'lake');
    const r = Number(lake.properties.radius) || 100;
    sandboxScene.exploreAt(lake.position.x - r - 10, lake.position.y - 6, 8);
  });
  await frames(page, 25);
}

async function expectShotButton(page) {
  const btn = page.locator('#sandbox-shot');
  assert.equal(await btn.isVisible(), true, 'the screenshot button shows in 3D');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), btn.click()]);
  assert.match(download.suggestedFilename(), /^simulation-.+-step-\d+\.png$/);
  const stamped = await page.evaluate(() => {
    const url = sandboxScene.screenshot();
    return new Promise((r) => { const img = new Image(); img.onload = () => r({ w: img.width, h: img.height, png: url.startsWith('data:image/png') }); img.src = url; });
  });
  assert.ok(stamped.png && stamped.w > 300 && stamped.h > 200, 'a PNG of the view');
}

test('frame time on a throttled phone profile: 30 fps, or Auto steps the quality down', { skip: skip || TAG === 'before', timeout: 900000 }, async (t) => {
  __resetSandboxMemory();
  const store = createSandboxStore();
  const pg1 = pg1Principal();
  const uni = await createWorld(store, pg1, { name: 'Pg1-Universe', template: 'universe' });
  await stepWorldFor(store, pg1, { world_id: uni.id, steps: 40 });
  const { server, origin } = await startServer(store);
  const browser = await chromium.launch({ args: GL });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  const { page, errors, context } = await signedInPage(browser, origin);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await openWorld(page, uni.id, 40);
  if (await page.locator('#sandbox-view').getAttribute('data-renderer') !== 'webgl') { t.skip('no WebGL in this browser'); return; }
  const startTier = await page.locator('#sandbox-view').getAttribute('data-tier');
  await settle(page, 1000);
  const samples = [];
  let tier = startTier;
  for (let i = 0; i < 12; i++) {
    const f0 = await framesNow(page); const t0 = Date.now();
    await page.waitForTimeout(5000);
    const ms = (Date.now() - t0) / Math.max(1, (await framesNow(page)) - f0);
    tier = await page.locator('#sandbox-view').getAttribute('data-tier');
    samples.push({ tier, ms: Math.round(ms) });
    if (ms <= 34 || tier === 'low') break;
  }
  console.log(`# frame time (4x CPU throttle, 380 px, Auto from ${startTier}): ${samples.map((s) => `${s.tier} ${s.ms} ms`).join(', ')}`);
  const last = samples[samples.length - 1];
  assert.ok(last.ms <= 34 || last.tier === 'low', `holds 30 fps or steps down to Low (${JSON.stringify(samples)})`);
  assert.ok(samples.every((s) => s.ms < 60000), 'keeps drawing');
  assert.deepEqual(errors, []);
  await context.close();
});
