/**
 * Image attachments in a real browser (Chromium via Playwright).
 *
 * The Node tests in tests/vision-attachments.test.mjs cover the server and
 * the page's pure functions; decoding and resizing an image needs a real
 * canvas. This test loads the actual page from public/ over HTTP with a
 * stub /api that signs the operator in and records what gets sent, then:
 *
 *  - attaches a 3200x1800 PNG drawn in the page: the chip appears, the
 *    message is sent with one inlineData part, PNG, 1600x900 (the IHDR of
 *    the bytes the server received says so), and the operator's bubble
 *    notes one image;
 *  - a JPEG that already fits (800x600) is sent as it is, byte for byte;
 *  - a fifth image is refused with an alert, four go;
 *  - a text file still attaches as a plain file beside an image;
 *  - the remove button clears everything, including the image count.
 *
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: npm run test:browser   (or: node --test tests/browser/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');

let chromium = null;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  skip = 'playwright is not installed (npm install)';
}
if (chromium && !existsSync(chromium.executablePath())) {
  skip = `Chromium is not installed at ${chromium.executablePath()} (npx playwright install chromium)`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8'
};

// Serves public/ and stubs the API; every /api/chat body is kept.
function startStubServer() {
  const log = { requests: [], missing: [] };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      log.requests.push({ method: req.method, path: url.pathname, body: parsed });
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
        if (url.pathname === '/api/errors') return json(res, 200, { errors: [], ok: true });
        if (url.pathname === '/api/handoffs') return json(res, 200, { handoffs: [] });
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(res, 200, { authenticated: true });
          const n = parsed && Array.isArray(parsed.multiFiles) ? parsed.multiFiles.length : 0;
          return json(res, 200, { reply: n ? `I looked at ${n} attachment(s).` : 'No attachment came with that.' });
        }
        log.missing.push(url.pathname);
        return json(res, 404, { error: 'not stubbed' });
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = normalize(join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
        log.missing.push(url.pathname);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
      const data = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
      res.end(data);
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ server, log, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// Width and height from a PNG's IHDR chunk.
function pngSize(base64) {
  const buf = Buffer.from(base64, 'base64');
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'a PNG signature');
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Draws an image of the given size in the page and attaches it through the
// real file input (a File in a DataTransfer, then the change event the
// input's onchange handler listens for). Returns the file's bytes as the
// page saw them, for the byte-for-byte check. Passed to page.evaluate as a
// function (a string would be evaluated as an expression, not called).
const ATTACH_IMAGE = async ({ width, height, type, name }) => {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fedcba'; ctx.fillRect(width / 4, height / 4, width / 2, height / 2);
  const blob = await new Promise((r) => canvas.toBlob(r, type, 0.9));
  const file = new File([blob], name, { type });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return { base64: btoa(bin), size: blob.size };
};

const ATTACH_TEXT = (name) => {
  const file = new File(['hello from a text file'], name, { type: 'text/plain' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

test('an attached image is resized to 1600 px and sent to the server as image input', { skip, timeout: 120000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((r) => server.close(r));
  });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const alerts = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('dialog', async (d) => { alerts.push(d.message()); await d.dismiss(); });

  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });

  const directives = () => log.requests.filter((r) => r.path === '/api/chat' && r.body && r.body.prompt !== 'AUTH_VERIFY');

  // 1. A large PNG screenshot: resized, then sent.
  await page.evaluate(ATTACH_IMAGE, { width: 3200, height: 1800, type: 'image/png', name: 'big-screenshot.png' });
  await page.waitForSelector('#attach-chips .attach-chip.is-image');
  assert.equal(await page.locator('#attach-chips .attach-chip.is-image .attach-name').textContent(), 'big-screenshot.png');
  assert.match(await page.locator('#attach-chips .attach-chip.is-image').getAttribute('title'), /^Image, 1600×900, PG1 will look at it$/, 'the chip says the size it will be sent at');
  await page.fill('#prompt-input', 'what does this screenshot show?');
  await page.click('.execute-btn');
  await page.waitForFunction(() => !document.querySelector('#chat-container .message-bubble.pending'));
  assert.equal(directives().length, 1, 'one message was sent');
  const sent = directives()[0].body;
  assert.equal(sent.prompt, 'what does this screenshot show?');
  assert.equal(sent.multiFiles.length, 1, 'one attachment');
  assert.equal(sent.multiFiles[0].inlineData.mimeType, 'image/png', 'a PNG stays a PNG');
  assert.deepEqual(pngSize(sent.multiFiles[0].inlineData.data), { width: 1600, height: 900 }, 'resized to 1600 px on the long edge, aspect kept');
  const bytes = Buffer.from(sent.multiFiles[0].inlineData.data, 'base64').length;
  assert.ok(bytes < 4 * 1024 * 1024 && bytes > 100, `a real image of ${bytes} bytes`);
  const bubbles = await page.evaluate(() => Array.from(document.querySelectorAll('#chat-container .message-bubble.user .message-text')).map((b) => b.textContent.trim()));
  assert.deepEqual(bubbles, ['what does this screenshot show? [1 image(s) attached]']);
  assert.equal(await page.locator('#attach-chips').isHidden(), true, 'the chips are gone after the send');
  assert.equal(await page.evaluate(() => attachedImages), 0, 'the image count was reset');

  // 2. A JPEG that already fits goes as it is.
  const small = await page.evaluate(ATTACH_IMAGE, { width: 800, height: 600, type: 'image/jpeg', name: 'photo.jpg' });
  await page.waitForSelector('#attach-chips .attach-chip.is-image');
  await page.fill('#prompt-input', 'and this photo');
  await page.click('.execute-btn');
  await page.waitForFunction(() => !document.querySelector('#chat-container .message-bubble.pending'));
  assert.equal(directives().length, 2);
  const sentJpeg = directives()[1].body.multiFiles[0].inlineData;
  assert.equal(sentJpeg.mimeType, 'image/jpeg');
  assert.equal(sentJpeg.data, small.base64, 'byte for byte: no re-encoding of an image within the limit');

  // 3. Five images: four attach, the fifth is refused with an alert; a text
  //    file rides along as a plain file.
  for (let i = 1; i <= 5; i++) {
    await page.evaluate(ATTACH_IMAGE, { width: 200, height: 100, type: 'image/webp', name: `shot-${i}.webp` });
    await page.waitForFunction((n) => document.querySelectorAll('#attach-chips .attach-chip.is-image').length === n, Math.min(i, 4));
  }
  assert.equal(await page.locator('#attach-chips .attach-chip.is-image').count(), 4);
  assert.deepEqual(alerts, ['Up to 4 images per message. None of these were attached.'], 'the fifth was refused with a reason');
  await page.evaluate(ATTACH_TEXT, 'notes.txt');
  await page.waitForFunction(() => document.querySelectorAll('#attach-chips .attach-chip:not(.is-image)').length === 1);
  assert.equal(await page.locator('#attach-chips .attach-chip:not(.is-image) .attach-name').textContent(), 'notes.txt');
  await page.fill('#prompt-input', 'all of these');
  await page.click('.execute-btn');
  await page.waitForFunction(() => !document.querySelector('#chat-container .message-bubble.pending'));
  const third = directives()[2].body;
  assert.equal(third.multiFiles.length, 5, 'four images and the text file');
  assert.deepEqual(third.multiFiles.map((f) => f.inlineData.mimeType), ['image/webp', 'image/webp', 'image/webp', 'image/webp', 'text/plain']);
  const thirdBubble = await page.evaluate(() => Array.from(document.querySelectorAll('#chat-container .message-bubble.user .message-text')).pop().textContent.trim());
  assert.equal(thirdBubble, 'all of these [4 image(s) attached] [1 File(s) Attached]');

  // 4. Remove clears everything.
  await page.evaluate(ATTACH_IMAGE, { width: 200, height: 100, type: 'image/png', name: 'gone.png' });
  await page.waitForSelector('#attach-chips .attach-chip.is-image');
  await page.click('#attach-chips .attach-clear');
  assert.equal(await page.locator('#attach-chips').isHidden(), true);
  assert.deepEqual(await page.evaluate(() => [attachedImages, attachedFilesPayload.length, attachedBytes]), [0, 0, 0]);

  assert.deepEqual(pageErrors, [], 'no page errors');
  assert.deepEqual(consoleErrors, [], 'no console errors');
  assert.deepEqual(log.missing, [], 'every URL the page asked for exists');
  assert.deepEqual(await page.evaluate(() => getErrorLog().map((e) => e.message)), [], 'the page recorded no errors');
});
