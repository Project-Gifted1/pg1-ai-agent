/**
 * The camera live analysis in a real browser (Chromium via Playwright), with
 * a fake camera (--use-fake-device-for-media-stream: a moving test pattern)
 * and a stub /api that records what the page sends.
 *
 * Signed in, the operator turns the Vision feed on; the page must:
 *  - tell the server the session started (cameraEvent start);
 *  - send frames for analysis (cameraAnalyze) and show the description
 *    under the camera picture;
 *  - when the server says every engine is out (ai_unavailable), show
 *    "Camera analysis paused: AI credit unavailable" and stop sending until
 *    the pause is over;
 *  - turned off, tell the server the session stopped and hide the caption.
 * No page errors, no console errors. Gate timings are shortened through
 * window.PG1_CAMERA_OPTIONS so the test runs in seconds.
 *
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: npm run test:browser
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');

let chromium = null;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  skip = 'playwright is not installed (npm install)';
}
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()} (npx playwright install chromium)`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };

function startStubServer(state) {
  const log = { camera: [] };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
        if (url.pathname === '/api/errors') return json(res, 200, { errors: [], ok: true });
        if (url.pathname === '/api/handoffs') return json(res, 200, { handoffs: [] });
        if (url.pathname === '/api/watches') return json(res, 200, { ok: true, reports: [] });
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(res, 200, { authenticated: true });
          if (parsed && parsed.cameraEvent) { log.camera.push({ event: parsed.cameraEvent, source: parsed.source, signedIn: !!(parsed.user && parsed.pass) }); return json(res, 200, { ok: true }); }
          if (parsed && parsed.cameraAnalyze) {
            const frame = parsed.frame && parsed.frame.inlineData;
            log.camera.push({ analyze: true, mime: frame && frame.mimeType, bytes: frame ? frame.data.length : 0 });
            if (state.mode === 'out') return json(res, 200, { ok: false, throttled: false, reason: 'ai_unavailable', retryAfterMs: null });
            return json(res, 200, { ok: true, caption: 'A test pattern on a screen.' });
          }
          return json(res, 200, { reply: 'ok' });
        }
        return json(res, 404, { error: 'not stubbed' });
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

test('camera live analysis: start event, captions, "paused: AI credit unavailable", stop event', { skip }, async (t) => {
  const state = { mode: 'ok' };
  const { server, log, origin } = await startStubServer(state);
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
  await routeReplyFont(context);
  // Short gate timings for the test: a frame every 300 ms, no change needed.
  await context.addInitScript(() => { window.PG1_CAMERA_OPTIONS = { minIntervalMs: 300, diffThreshold: 0, pauseMs: 60000 }; });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  await page.goto(origin + '/', { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => typeof PG1Camera), 'object', 'public/camera/frame-gate.js loaded');
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });

  await page.evaluate(() => setVisionSource('camera'));
  await page.waitForFunction(() => { const v = document.getElementById('vision-pip'); return v && v.videoWidth > 0; });
  await page.waitForFunction(() => !document.getElementById('vision-caption').hidden, null, { timeout: 15000 });
  assert.equal(await page.textContent('#vision-caption'), 'A test pattern on a screen.');
  assert.deepEqual(log.camera[0], { event: 'start', source: 'camera', signedIn: true });
  const firstFrame = log.camera.find((e) => e.analyze);
  assert.equal(firstFrame.mime, 'image/jpeg');
  assert.ok(firstFrame.bytes > 100);

  // Every engine out: the paused message, and no more frames for the pause.
  state.mode = 'out';
  await page.waitForFunction(() => /Camera analysis paused: AI credit unavailable/.test(document.getElementById('vision-caption').textContent), null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => document.getElementById('vision-caption').classList.contains('is-paused')), true);
  const sentAtPause = log.camera.filter((e) => e.analyze).length;
  await page.waitForTimeout(2500);
  assert.equal(log.camera.filter((e) => e.analyze).length, sentAtPause, 'nothing sent while paused');

  await page.evaluate(() => setVisionSource('off'));
  await page.waitForFunction(() => document.getElementById('vision-caption').hidden);
  await page.waitForTimeout(200);
  assert.ok(log.camera.some((e) => e.event === 'stop'), 'the stop event');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors.filter((e) => !/favicon/.test(e)), []);
});
