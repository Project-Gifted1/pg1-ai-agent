/**
 * A message the server could not save (PR D: PostgREST refused the
 * messages insert with PGRST102): the reply bubble shows a "Not saved"
 * marker, a saved one shows none, and the marker survives a reload.
 *
 * The page is served from public/ as deployed; /api/chat is a stub that
 * answers the way api/chat.mjs does, with messageSaved: false on the done
 * event when the insert failed.
 *
 * Writes docs/screenshots/message-not-saved-380.png for the PR.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.css': 'text/css; charset=utf-8' };

function answer(prompt) {
  if (/unsaved/.test(prompt)) return { reply: 'Here is the summary you asked for.', result: { actions: [] }, unsaved: true };
  return { reply: 'Saved as usual.', result: { actions: [] } };
}

function startStubServer() {
  const log = { bodies: [], missing: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
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
        if (url.pathname === '/api/watches') return json(200, { ok: true, reports: [] });
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: true });
          if (parsed && parsed.action === 'SPEAK') return json(200, { reply: 'ok' });
          log.bodies.push(parsed);
          const a = answer(String(parsed && parsed.prompt || ''));
          // Like api/chat.mjs when the messages insert was refused.
          if (parsed && parsed.stream === true) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.write(`event: text\ndata: ${JSON.stringify({ type: 'text', text: a.reply })}\n\n`);
            res.write(`event: done\ndata: ${JSON.stringify({ type: 'done', request_id: 'r1', result: a.result, ...(a.unsaved ? { messageSaved: false } : {}) })}\n\n`);
            return res.end();
          }
          return json(200, { reply: a.reply, ...a.result, ...(a.unsaved ? { messageSaved: false } : {}) });
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

test('a reply whose exchange was not saved carries a "Not saved" marker; a saved one does not', { skip, timeout: 180000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 380, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await routeReplyFont(context);
  await context.addInitScript(() => { try { localStorage.setItem('pg1_theme', 'dark'); } catch (e) {} });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));

  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });

  const replies = () => page.locator('#chat-container .message-bubble:not(.user)');
  const send = async (text) => {
    const before = await replies().count();
    await page.fill('#prompt-input', text);
    await page.click('.execute-btn');
    await page.waitForFunction((n) => {
      const b = document.querySelectorAll('#chat-container .message-bubble:not(.user)');
      return b.length > n && !b[b.length - 1].classList.contains('pending');
    }, before);
    return replies().nth(before);
  };

  const saved = await send('A normal question.');
  assert.equal(await saved.locator('.msg-not-saved').count(), 0, 'a saved exchange has no marker');

  const unsaved = await send('Summarise this, unsaved please.');
  const marker = unsaved.locator('.msg-not-saved');
  assert.equal(await marker.count(), 1);
  assert.equal((await marker.innerText()).trim(), 'Not saved');
  assert.equal(await marker.getAttribute('role'), 'status');
  assert.match(await marker.getAttribute('title'), /not saved to your history/);
  assert.equal((await unsaved.locator('.message-text').first().innerText()).trim(), 'Here is the summary you asked for.', 'the reply itself is shown in full');
  // Fits the 380 px bubble.
  const box = await marker.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 380, 'inside the viewport');
  const [bg, fg] = await marker.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
  assert.notEqual(bg, fg);

  await page.waitForTimeout(300);
  mkdirSync(SHOTS_DIR, { recursive: true });
  await unsaved.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS_DIR, 'message-not-saved-380.png') });

  // A reload keeps the marker on that reply only.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#chat-container .msg-not-saved');
  assert.equal(await page.locator('#chat-container .msg-not-saved').count(), 1);

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(log.missing, []);
});
