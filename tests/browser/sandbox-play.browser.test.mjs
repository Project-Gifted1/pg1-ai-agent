/**
 * Play in a real browser (Chromium via Playwright), on both kinds of world
 * PG1 keeps: a universe (as Gift's first universe) and Benin–Warri c. 1610.
 * For each, at the Natural pace and at 10x: Play keeps stepping the world
 * (the step count goes up call after call, 1 step a call at Natural, 4 at
 * 10x with keyframes), the view keeps drawing, no quota banner, no page
 * error; Pause stops it. With PG1's changes all used up, Play still runs
 * (steps only); when the steps run out, the banner says which quota and when
 * it resets.
 *
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/sandbox-play.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { createSandboxStore, __resetSandboxMemory } from '../../lib/sandbox/store.mjs';
import { createWorld, pg1Principal, PG1_QUOTA } from '../../lib/sandbox/worlds.mjs';
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
        if (parsed && parsed.op === 'step') log.steps.push({ steps: parsed.steps, status: out.statusCode, tick: out.body && out.body.world && out.body.world.tick, keyframes: out.body && out.body.keyframes ? out.body.keyframes.length : 0 });
        return json(out.statusCode, out.body);
      }
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/chat' && parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: true });
        if (url.pathname === '/api/health') return json(200, { status: 'ok' });
        // The empty state's live text (api/home-context.mjs): none here, so the defaults stay.
        if (url.pathname === '/api/home-context') return json(200, { ok: true });
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
  await context.addInitScript((p) => { try { localStorage.setItem('pg1_theme', 'dark'); localStorage.setItem('pg1_sandbox_quality', 'low'); localStorage.setItem('pg1.sandbox.pace', String(p)); } catch (e) {} }, pace);
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

const tickOf = (page) => page.evaluate(() => (sandboxState.world ? sandboxState.world.tick : -1));
const framesOf = (page) => page.evaluate(() => Number(document.getElementById('sandbox-view').dataset.frames || 0));

for (const template of ['universe', 'benin-warri']) {
  test(`Play runs in the ${template} world, at Natural and at 10x; Pause stops it`, { skip, timeout: 900000 }, async (t) => {
    __resetSandboxMemory();
    const store = createSandboxStore();
    const w = await createWorld(store, pg1Principal(), { name: template === 'universe' ? 'Pg1-Universe' : 'Benin–Warri c. 1610', template });
    const { server, log, origin } = await startServer(store);
    const browser = await chromium.launch({ args: GL });
    t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
    for (const [pace, perCall] of [[1, 1], [10, 4]]) {
      const { page, errors, context } = await signedInPage(browser, origin, pace);
      await page.evaluate((id) => openSandboxScreen(id), w.id);
      await page.waitForFunction(() => /^Step \d+ · /.test(document.getElementById('sandbox-tick').textContent), null, { timeout: 120000 });
      assert.equal(await page.locator('#sandbox-speed').inputValue(), String(pace), 'the pace kept on the device');
      const t0 = await tickOf(page); const f0 = await framesOf(page);
      log.steps.length = 0;
      await page.click('#sandbox-play');
      assert.equal(await page.locator('#sandbox-play').getAttribute('aria-pressed'), 'true');
      // Three calls back, one after the other.
      await page.waitForFunction((n) => sandboxState.world && sandboxState.world.tick >= n, t0 + 3 * perCall, { timeout: 300000 });
      await page.click('#sandbox-play');
      assert.equal(await page.locator('#sandbox-play').textContent(), 'Play', 'Pause stops it');
      const t1 = await tickOf(page);
      assert.ok(t1 >= t0 + 3 * perCall, `${template} at ${pace}x: from step ${t0} to ${t1}`);
      assert.ok(log.steps.length >= 3 && log.steps.every((s) => s.status === 200 && s.steps === perCall), JSON.stringify(log.steps));
      if (perCall > 1) assert.ok(log.steps.every((s) => s.keyframes === perCall - 1), 'keyframes for each step but the last');
      assert.ok((await framesOf(page)) > f0, 'the view kept drawing');
      assert.equal(await page.locator('#sandbox-quota').isHidden(), true, 'no quota banner');
      // Paused: no more calls.
      const calls = log.steps.length;
      await page.waitForTimeout(3000);
      assert.ok(log.steps.length <= calls + 1, 'nothing more asked for once paused');
      assert.deepEqual(errors, [], `no page errors (${template}, ${pace}x)`);
      t.diagnostic(`${template} at ${pace}x: steps ${t0} -> ${t1} in ${log.steps.length} calls`);
      await context.close();
    }
  });
}

test('with PG1\'s changes used up Play still runs; out of steps, the banner names the quota and when it resets', { skip, timeout: 600000 }, async (t) => {
  __resetSandboxMemory();
  const store = createSandboxStore();
  const w = await createWorld(store, pg1Principal(), { name: 'Benin–Warri c. 1610', template: 'benin-warri' });
  for (let i = 0; i < PG1_QUOTA.max_actions_per_day; i++) await store.addAction('pg1');
  const { server, origin } = await startServer(store);
  const browser = await chromium.launch({ args: GL });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  const { page, errors, context } = await signedInPage(browser, origin, 10);
  await page.evaluate((id) => openSandboxScreen(id), w.id);
  await page.waitForFunction(() => /^Step \d+ · /.test(document.getElementById('sandbox-tick').textContent), null, { timeout: 120000 });
  const t0 = await tickOf(page);
  await page.click('#sandbox-play');
  await page.waitForFunction((n) => sandboxState.world && sandboxState.world.tick >= n, t0 + 4, { timeout: 300000 });
  // Now the steps run out.
  await store.addSteps('pg1', PG1_QUOTA.max_steps_per_day);
  await page.waitForSelector('#sandbox-quota:not([hidden])', { timeout: 120000 });
  const text = await page.locator('#sandbox-quota').innerText();
  assert.match(text, /Play stopped: quota used up/);
  assert.match(text, /PG1's daily steps quota \(5,000 steps a day\) is used up for today\. It resets at 00:00 UTC/);
  assert.equal(await page.locator('#sandbox-play').textContent(), 'Play', 'Play stopped');
  assert.deepEqual(errors, []);
  await context.close();
});
