/**
 * PG1 Motion in a real browser (Chromium via Playwright): a reply that
 * starts a clip shows the "Rendering video…" card at once; the page polls
 * /api/chat's VIDEO_STATUS action with the operator's session; the card
 * becomes the video player when the clip is ready, or the neutral failure
 * sentence when it failed. A card saved in the chat history picks up again
 * after a reload, once the operator signs in.
 *
 * /api/chat is a stub. Skipped (not failed) when Playwright or its Chromium
 * is not installed. Run with: npm run test:browser
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

const JOB_OK = '11111111-2222-4333-8444-555555555555';
const JOB_FAIL = '66666666-7777-4888-9999-000000000000';
const CLIP_URL = 'https://vault.example.test/storage/v1/object/sign/pg1-vault/videos/clip.mp4?token=t';
const FAIL_TEXT = 'Execution failed. The video could not be generated right now. Please try again. Request ID: abc12345';
const RECHECK_URL = 'https://vault.example.test/storage/v1/object/sign/pg1-vault/videos/recheck.mp4?token=t';
const OLD_JOB = '12121212-3434-4565-8787-909090909090';
const OLD_FAIL_TEXT = 'Execution failed. The video could not be generated right now. Please try again. Request ID: ehxj2xby';

function startStubServer() {
  const log = { polls: [] };
  const seen = new Map();
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
      if (url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
      if (url.pathname === '/api/errors') return json(res, 200, { errors: [], ok: true });
      if (url.pathname === '/api/handoffs') return json(res, 200, { handoffs: [] });
      if (url.pathname === '/api/chat') {
        if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(res, 200, { authenticated: true });
        if (parsed && parsed.action === 'VIDEO_STATUS') {
          log.polls.push({ jobId: parsed.jobId, user: parsed.user, pass: parsed.pass });
          if (!parsed.user || !parsed.pass) return json(res, 401, { reply: 'Authentication required.' });
          const n = (seen.get(parsed.jobId) || 0) + 1;
          seen.set(parsed.jobId, n);
          if (parsed.jobId === JOB_FAIL) return json(res, 200, { videoJob: { id: JOB_FAIL, status: 'failed', engine: 'PG1 Motion', message: FAIL_TEXT } });
          if (n === 1) return json(res, 200, { videoJob: { id: JOB_OK, status: 'rendering', engine: 'PG1 Motion' } });
          return json(res, 200, { videoJob: { id: JOB_OK, status: 'done', engine: 'PG1 Motion', url: CLIP_URL } });
        }
        const recheck = /^\/video recheck (\w+)$/.exec((parsed && parsed.prompt) || '');
        if (recheck) {
          const [jobId, url] = recheck[1] === 'abc12345' ? [JOB_FAIL, RECHECK_URL] : [OLD_JOB, RECHECK_URL + '&old=1'];
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
          for (const ev of [
            { type: 'text', text: `PG1 Motion found the clip for request ID ${recheck[1]}: it had finished rendering and is now in the vault.` },
            { type: 'done', request_id: 'rck00001', result: { videoJob: { id: jobId, status: 'done', url, engine: 'PG1 Motion', requestId: recheck[1] } } }
          ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
          return res.end();
        }
        const id = /storm/.test(parsed && parsed.prompt) ? JOB_FAIL : JOB_OK;
        const reply = `Rendering video… It appears here when it is ready, usually within a few minutes. ${id === JOB_OK ? 2 : 1} of 3 videos left today.`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.write(': pg1 trace\n\n');
        for (const ev of [
          { type: 'step', id: 'video', label: 'Starting the video' },
          { type: 'step_done', id: 'video', label: 'Started the video', result: 'PG1 Motion · 2 left today', ms: 420 },
          { type: 'text', text: reply },
          { type: 'done', request_id: 'abc12345', result: { videoJob: { id, status: 'rendering', engine: 'PG1 Motion' }, videosLeftToday: 2, videoDailyCap: 3 } }
        ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        return res.end();
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = normalize(join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
      const data = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
      res.end(data);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, log, origin: `http://127.0.0.1:${server.address().port}` })));
}

async function signIn(page) {
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
}

test('a video reply shows "Rendering video…", polls with the session, then shows the player or the neutral failure, and resumes after a reload', { skip, timeout: 120000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((r) => server.close(r));
  });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.route('https://vault.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));

  await page.goto(origin + '/', { waitUntil: 'load' });
  await signIn(page);
  for (const prompt of ['/video a lighthouse at dusk', '/video a storm over the sea']) {
    await page.fill('#prompt-input', prompt);
    await page.click('.execute-btn');
    await page.waitForFunction((n) => document.querySelectorAll('#chat-container .video-job.is-rendering').length === n, prompt.includes('storm') ? 2 : 1, { timeout: 15000 });
  }
  const card = page.locator('#chat-container .video-job').first();
  assert.equal((await card.textContent()).replace(/\s+/g, ' ').trim(), 'Rendering video… PG1 Motion');
  assert.equal(await card.getAttribute('role'), 'status');
  assert.equal(log.polls.length, 0, 'no poll before the first interval');

  // Reload while both are rendering: the cards come back from the saved
  // chat, and polling waits for the operator to sign in again.
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.locator('#chat-container .video-job.is-rendering').count(), 2, 'the cards survived the reload');
  await page.waitForTimeout(1500);
  assert.equal(log.polls.length, 0, 'no poll without a session');
  await signIn(page);

  await page.waitForSelector('#chat-container .video-job-failed', { timeout: 15000 });
  assert.equal(await page.locator('#chat-container .video-job-failed').textContent(), FAIL_TEXT);
  await page.waitForSelector('#chat-container .media-preview-container video', { timeout: 20000 });
  assert.equal(await page.locator('#chat-container .media-preview-container video').getAttribute('src'), CLIP_URL);
  assert.equal(await page.locator('#chat-container .video-job').count(), 0, 'no card left spinning');
  assert.ok(log.polls.length >= 3);
  for (const p of log.polls) assert.deepEqual([p.user, p.pass], ['operator', 'passkey'], 'every poll carries the session');

  // Settled cards are saved: a reload shows the player, and nothing polls.
  const before = log.polls.length;
  await page.reload({ waitUntil: 'load' });
  await signIn(page);
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('#chat-container .media-preview-container video').count(), 1);
  assert.equal(log.polls.length, before);
  assert.deepEqual(pageErrors, []);
});

test('/video recheck: a clip found later replaces its failed card, found by job id or, on an older card, by its request ID', { skip, timeout: 120000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((r) => server.close(r));
  });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.route('https://vault.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
  await page.goto(origin + '/', { waitUntil: 'load' });
  await signIn(page);

  await page.fill('#prompt-input', '/video a storm over the sea');
  await page.click('.execute-btn');
  await page.waitForSelector('#chat-container .video-job-failed', { timeout: 20000 });
  assert.equal(await page.locator('#chat-container .video-job-failed').getAttribute('data-video-job-failed'), JOB_FAIL, 'the failed card keeps its job id');

  // A failed card saved before it carried the job id (the #263 failure).
  await page.evaluate((text) => {
    const p = document.createElement('p');
    p.className = 'video-job-failed';
    p.textContent = text;
    document.querySelector('#chat-container').appendChild(p);
  }, OLD_FAIL_TEXT);

  for (const [rid, url] of [['abc12345', RECHECK_URL], ['ehxj2xby', RECHECK_URL + '&old=1']]) {
    await page.fill('#prompt-input', `/video recheck ${rid}`);
    await page.click('.execute-btn');
    await page.waitForFunction((u) => Array.from(document.querySelectorAll('#chat-container video')).some((v) => v.getAttribute('src') === u), url, { timeout: 15000 });
    assert.equal(await page.locator(`#chat-container video[src="${url}"]`).count(), 1, `${rid}: one player, in the old card's place`);
  }
  assert.equal(await page.locator('#chat-container .video-job-failed').count(), 0, 'no failed card left');
  assert.ok(log.polls.length >= 1);
  assert.deepEqual(pageErrors, []);
});
