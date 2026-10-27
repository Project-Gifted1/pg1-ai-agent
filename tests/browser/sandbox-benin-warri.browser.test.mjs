/**
 * The Benin–Warri c. 1610 world in the viewer, in a real browser (Chromium
 * via Playwright) at 380 px: New universe can make it; the world is drawn
 * (3D at the Low tier, and the 2D map with reduced motion) and labelled
 * Simulation; its History panel shows the label "Simulation inspired by
 * history; inhabitants are fictional.", the sourced timeline and the hard
 * truth; another world has no History tab. Writes
 * docs/screenshots/sandbox-benin-warri-*-380-dark.png for the PR.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/sandbox-benin-warri.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { createSandboxStore } from '../../lib/sandbox/store.mjs';
import { createWorld, pg1Principal } from '../../lib/sandbox/worlds.mjs';
import sandboxViewer, { __setSandboxViewerStore } from '../../api/sandbox.mjs';
import { handleSandboxCommand } from '../../lib/sandbox/chat.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');

let chromium = null;
let skip = false;
try { ({ chromium } = await import('playwright')); } catch (e) { skip = 'playwright is not installed (npm install)'; }
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()}`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8' };

function startServer(store) {
  const log = { sandboxOps: [], missing: [], bodies: [] };
  process.env.USER_API_KEY = 'operator';
  process.env.USER_API_PASS = 'passkey';
  __setSandboxViewerStore(() => store);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed = null;
      if (body) log.bodies.push(body);
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      const json = (status, b) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (url.pathname === '/api/sandbox') {
        log.sandboxOps.push(parsed && parsed.op);
        const out = { statusCode: 200, body: null, setHeader() {}, getHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } };
        await sandboxViewer({ method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' }, body: parsed }, out);
        return json(out.statusCode, out.body);
      }
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health') return json(200, { status: 'ok' });
        if (url.pathname === '/api/errors') return json(200, { errors: [], ok: true });
        if (url.pathname === '/api/handoffs') return json(200, { handoffs: [] });
        if (url.pathname === '/api/threads') return json(200, { threads: [] });
        if (url.pathname === '/api/watches') return json(200, { ok: true, reports: [] });
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: true });
          if (parsed && parsed.action === 'SPEAK') return json(200, { reply: 'ok' });
          const out = await handleSandboxCommand({ text: String(parsed && parsed.prompt || ''), isOperator: true, store });
          return json(200, { reply: out.reply, ...(out.sandbox ? { sandbox: out.sandbox } : {}), ...(out.secretOnce ? { secretOnce: out.secretOnce } : {}), actions: [] });
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



async function signedInPage(browser, origin, { reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width: 380, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion });
  await routeReplyFont(context);
  await context.addInitScript(() => { try { localStorage.setItem('pg1_theme', 'dark'); localStorage.setItem('pg1_sandbox_quality', 'low'); } catch (e) {} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err && err.message || err) + ' @ ' + String(err && err.stack || '').split('\n').slice(1, 3).join(' | ')));
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  return { page, errors, context };
}

test('Benin–Warri c. 1610 in the viewer: made from New universe, labelled Simulation, with its sourced History panel', { skip, timeout: 300000 }, async (t) => {
  const store = createSandboxStore();
  const meadow = await createWorld(store, pg1Principal(), { name: 'Meadow', template: 'meadow' });
  const { server, log, origin } = await startServer(store);
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const { page, errors, context } = await signedInPage(browser, origin, { reducedMotion });
    await page.evaluate((id) => openSandboxScreen(id), meadow.id);
    await page.waitForSelector('#sandbox-screen.is-open');
    await page.waitForFunction(() => /^Step \d+ · \d+ entities/.test(document.getElementById('sandbox-tick').textContent));
    assert.equal(await page.locator('#sandbox-tab-history').isHidden(), true, 'no History tab for a world without history');
    if (reducedMotion === 'no-preference') {
      // New universe, with the template chosen.
      await page.selectOption('#sandbox-template', 'benin-warri');
      await page.click('#sandbox-new');
      assert.ok(log.bodies.some((b) => /"op":"create"/.test(b) && /"template":"benin-warri"/.test(b)));
    } else {
      const w = (await store.listWorlds({})).find((x) => x.name === 'Benin–Warri c. 1610');
      await page.evaluate((id) => selectSandboxWorld(id), w.id);
    }
    await page.waitForFunction(() => /^Step 0 · 3\d\d entities/.test(document.getElementById('sandbox-tick').textContent), null, { timeout: 60000 });
    assert.equal((await page.locator('#sandbox-label').innerText()).trim(), 'Simulation');
    await page.waitForSelector('#sandbox-tab-history:not([hidden])');
    await page.waitForTimeout(reducedMotion === 'reduce' ? 300 : 2500);
    mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: join(SHOTS_DIR, `sandbox-benin-warri-${reducedMotion === 'reduce' ? '2d' : 'low'}-380-dark.png`), timeout: 120000 });
    await page.click('#sandbox-tab-history');
    await page.waitForSelector('#sandbox-history-timeline li');
    const text = await page.locator('#sandbox-panel-history').textContent();
    assert.match(text, /Simulation inspired by history; inhabitants are fictional\./);
    assert.match(text, /History · Benin and Warri c\. 1610 \(Simulation\)/);
    for (const w of ['c. 1480', '1571–74', '1597', '1600–1611', '23 November 1607']) assert.ok(text.includes(w), w);
    assert.match(text, /City of Saint Augustine/);
    assert.match(text, /never models buying, selling or owning people/);
    assert.match(text, /Source: /);
    const ow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, width: window.innerWidth }));
    assert.ok(ow.page <= ow.width, `no horizontal overflow at 380 px: ${JSON.stringify(ow)}`);
    if (reducedMotion === 'reduce') await page.screenshot({ path: join(SHOTS_DIR, 'sandbox-benin-warri-history-380-dark.png'), timeout: 120000 });
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert.deepEqual(log.missing.filter((p) => !/^\/api\/(?:usage|state|lessons|autonomous|core)/.test(p)), []);
});
