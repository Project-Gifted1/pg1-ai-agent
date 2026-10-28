/**
 * Emergencies and the beach in the viewer (lib/sandbox/emergency.mjs,
 * public/sandbox/rescue-models.js), at 380 px: a building on fire with the
 * fire engine there, lights flashing; the helicopter on the hospital's roof
 * pad; the beach with swimmers, sunbathers, a sandcastle, volleyball and the
 * lifeguard tower; an ambulance on a call.
 * Writes docs/screenshots/sandbox-rescue-*-380-dark.png.
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
async function shot(page, name) { await page.screenshot({ path: join(SHOTS_DIR, `sandbox-rescue-${name}-380-dark.png`), clip: await page.locator('#sandbox-view').boundingBox(), timeout: 180000 }); }
const viewerHas = (page, fn, arg) => page.evaluate(fn, arg);

test('emergencies and the beach: a fire and its engine, the helicopter on the roof, the beach, an ambulance', { skip, timeout: 2400000 }, async (t) => {
  __resetSandboxMemory();
  const store = createSandboxStore();
  const pg1 = pg1Principal();
  // The universe, with fires more likely so one is burning when we look.
  const uni = await createWorld(store, pg1, { name: 'Rescue', template: 'universe' });
  const w0 = await store.getWorld(uni.id);
  w0.spec.rules = w0.spec.rules.map((r) => (r.type === 'life' ? { ...r, fire_rate: 0.4 } : r));
  await store.updateWorld(uni.id, { spec: w0.spec });
  let fireAt = null; let tick = 0;
  for (let i = 0; i < 400 && !fireAt; i++) {
    await stepWorldFor(store, pg1, { world_id: uni.id, steps: 1 }); tick += 1;
    const st = (await store.getWorld(uni.id)).state;
    const engine = st.entities.find((e) => e.kind === 'fire_truck' && e.properties.call);
    const b = engine && st.entities.find((e) => e.id === engine.properties.call && e.properties.fire > 0);
    if (b && Math.hypot(engine.position.x - b.position.x, engine.position.y - b.position.y) < 150) fireAt = b.id;
  }
  assert.ok(fireAt, 'a fire with its engine there');
  const { server, origin } = await startServer(store);
  const browser = await chromium.launch({ args: GL });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  const { page, errors } = await signedInPage(browser, origin, { tier: 'high' });
  await openWorld(page, uni.id, tick);
  if (await page.locator('#sandbox-view').getAttribute('data-renderer') !== 'webgl') { t.skip('no WebGL'); return; }
  await frames(page, 4);
  await page.evaluate((id) => sandboxScene.select(id), fireAt);
  await frames(page, 40);
  await shot(page, 'fire');
  // The helicopter, on its pad or flying above the rooftops.
  await page.evaluate(() => sandboxScene.select('helicopter-1'));
  await frames(page, 40);
  await shot(page, 'helicopter');
  // The beach: people there as they are mid-activity (as the engine would set them).
  await page.evaluate(() => {
    const w = JSON.parse(JSON.stringify(sandboxState.world));
    const beach = w.entities.find((e) => e.id === 'beach-aurelia');
    const tower = w.entities.find((e) => e.kind === 'lifeguard_tower' && e.properties.beach === 'beach-aurelia');
    const dx = tower.position.x - beach.position.x; const dy = tower.position.y - beach.position.y; const d = Math.hypot(dx, dy) || 1;
    const ux = -dx / d; const uy = -dy / d;   // towards the water
    const people = w.entities.filter((e) => e.kind === 'person' && !e.properties.inside).slice(0, 9);
    const plan = [['swim', 26, -10], ['swim', 30, 6], ['swim', 24, 14], ['sunbathe', 2, -16], ['sunbathe', 2, -10], ['sandcastle', 8, 4], ['volleyball', -6, 20], ['volleyball', -6, 26], ['surf', 40, -4]];
    plan.forEach(([act, out, along], i) => { const p = people[i]; p.position = { x: tower.position.x + ux * out - uy * along, y: tower.position.y + uy * out + ux * along, z: 0 }; Object.assign(p.properties, { activity: act, swimming: act === 'swim' || act === 'surf', at: beach.id }); delete p.properties.target; });
    sandboxState.world = w; sandboxScene.update(w, { duration: 50 });
  });
  await frames(page, 4);
  await page.evaluate(() => sandboxScene.select(sandboxState.world.entities.find((e) => e.kind === 'lifeguard_tower' && e.properties.beach === 'beach-aurelia').id));
  await frames(page, 40);
  await shot(page, 'beach');
  // An ambulance on a call: lights flashing (buildings see-through, should one stand between).
  await page.evaluate(() => sandboxScene.setXray(true));
  await page.evaluate(() => { const w = JSON.parse(JSON.stringify(sandboxState.world)); const a = w.entities.find((e) => e.kind === 'ambulance'); a.properties.siren = true; a.properties.emergency = 'medical'; sandboxState.world = w; sandboxScene.update(w, { duration: 50 }); sandboxScene.select(a.id); });
  await frames(page, 40);
  await shot(page, 'ambulance');
  assert.deepEqual(errors, []);
});
