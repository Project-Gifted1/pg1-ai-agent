/**
 * People talking (lib/sandbox/society.mjs conversations), at 380 px: the
 * universe is stepped until two people are in a conversation; the viewer
 * follows one of them: they stand together facing each other, and what is
 * said shows over the speaker, with Names on and with Names off.
 * SOCIAL_TEMPLATE=<template> picks another world (default universe).
 * Writes docs/screenshots/sandbox-social-<template>-*-380-dark.png.
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
const TEMPLATE = process.env.SOCIAL_TEMPLATE || 'universe';
async function shot(page, name) { await page.screenshot({ path: join(SHOTS_DIR, `sandbox-social-${TEMPLATE}-${name}-380-dark.png`), clip: await page.locator('#sandbox-view').boundingBox(), timeout: 180000 }); }

test('conversations: two people stand together, face each other, and what is said shows over the speaker', { skip, timeout: 1800000 }, async (t) => {
  __resetSandboxMemory();
  const store = createSandboxStore();
  const pg1 = pg1Principal();
  const w = await createWorld(store, pg1, { name: 'Talk', template: TEMPLATE });
  // Step until two people outdoors (not at a building) are mid-conversation, one of them speaking.
  let pair = null; let tick = 0;
  for (let i = 0; i < 1500 && !pair; i++) {
    await stepWorldFor(store, pg1, { world_id: w.id, steps: 1 }); tick += 1;
    const st = (await store.getWorld(w.id)).state;
    const idx = new Map(st.entities.map((e) => [e.id, e]));
    for (const e of st.entities) {
      const o = e.properties.chat_with && idx.get(e.properties.chat_with);
      if (!o || !e.properties.saying || e.properties.talking_to !== o.id || e.properties.inside || o.properties.inside) continue;
      const at = e.properties.at && idx.get(e.properties.at);
      if (at && ['house', 'apartment', 'compound', 'hotel', 'palace', 'tower', 'school', 'hospital'].includes(at.kind)) continue;
      // In the open: no building within 40 m to come between them and the camera.
      const BUILT = ['house', 'cabin', 'apartment', 'compound', 'hotel', 'palace', 'tower', 'school', 'hospital', 'shop', 'cafe', 'factory', 'station', 'cinema', 'theatre', 'bar', 'police_station', 'prison', 'barracks', 'hangar', 'barn', 'terminal', 'brass_workshop', 'ivory_workshop', 'fishing_village'];
      if (st.entities.some((b) => BUILT.includes(b.kind) && Math.hypot(b.position.x - e.position.x, b.position.y - e.position.y) < 40)) continue;
      if (tick - (e.properties.chat_start || tick) < 2) continue;
      pair = [e.id, o.id]; break;
    }
  }
  assert.ok(pair, 'a conversation outdoors');
  const { server, origin } = await startServer(store);
  const browser = await chromium.launch({ args: GL });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  const { page, errors } = await signedInPage(browser, origin, { tier: 'high' });
  await openWorld(page, w.id, tick);
  if (await page.locator('#sandbox-view').getAttribute('data-renderer') !== 'webgl') { t.skip('no WebGL'); return; }
  await frames(page, 4);
  await page.evaluate(() => sandboxScene.setXray(true));   // buildings see-through, should one stand behind
  await page.evaluate((id) => sandboxScene.select(id), pair[1]);   // the listener (the selected one's own tag gives way to the selection label)
  await frames(page, 40);
  // Names off: only the words.
  if (await page.evaluate(() => sandboxScene.names())) await page.evaluate(() => sandboxScene.setNames(false));
  await frames(page, 6);
  const bubble = await page.evaluate(() => [...document.querySelectorAll('.sandbox-tag')].filter((d) => !d.hidden).map((d) => d.textContent));
  await shot(page, 'talk');
  await page.evaluate(() => sandboxScene.setNames(true));
  await frames(page, 6);
  await shot(page, 'talk-names');
  console.log('# pair', pair.join(' & '), 'bubbles:', JSON.stringify(bubble));
  assert.deepEqual(errors, []);
});
