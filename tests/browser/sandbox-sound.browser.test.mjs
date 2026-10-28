/**
 * The Sandbox viewer's sound at 380 px (public/sandbox/sound.js, sound-ui.js):
 * off until turned on; Sound and Music switch; the volume is remembered.
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

async function openWorld(page, id, tick) {
  await page.evaluate((w) => openSandboxScreen(w), id);
  await page.waitForFunction((t) => new RegExp(`^Step ${t} · `).test(document.getElementById('sandbox-tick').textContent), tick, { timeout: 90000 });
}

test('sound: off until turned on; Sound plays the world, Music adds the score, the volume works and is remembered', { skip, timeout: 600000 }, async (t) => {
  __resetSandboxMemory();
  const store = createSandboxStore();
  const pg1 = pg1Principal();
  const uni = await createWorld(store, pg1, { name: 'Pg1-Universe', template: 'universe' });
  await stepWorldFor(store, pg1, { world_id: uni.id, steps: 10 });
  const { server, origin } = await startServer(store);
  const browser = await chromium.launch({ args: [...GL, '--autoplay-policy=no-user-gesture-required'] });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  const { page, errors } = await signedInPage(browser, origin, { tier: 'low' });
  await openWorld(page, uni.id, 10);
  const sound = page.locator('#sandbox-sound'); const music = page.locator('#sandbox-music');
  assert.equal(await sound.getAttribute('aria-pressed'), 'false', 'off at the start');
  assert.equal(await music.isDisabled(), true, 'no music before sound');
  assert.equal(await page.evaluate(() => !!(window.__sandboxSound && window.__sandboxSound())), false, 'nothing made until asked');
  await sound.click();
  await page.waitForFunction(() => document.getElementById('sandbox-sound').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.evaluate(() => window.__sandboxSound().playing), true);
  await music.click();
  assert.equal(await music.getAttribute('aria-pressed'), 'true');
  await page.locator('#sandbox-volume').fill('20');
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pg1_sandbox_sound')).volume), 0.2, 'the volume is remembered');
  await sound.click();
  assert.equal(await sound.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => window.__sandboxSound().playing), false);
  assert.deepEqual(errors, []);
});
