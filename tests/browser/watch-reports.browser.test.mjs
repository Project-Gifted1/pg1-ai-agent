/**
 * Watch reports and honest actions in a real browser (Chromium via
 * Playwright):
 *   - every message carries the thread key (this screen's own, until the
 *     chat is saved), so a report finds its way back;
 *   - after sign-in the page asks /api/watches for undelivered reports,
 *     shows each one once as a reply with its buttons (an "Open PR" link
 *     opens GitHub in a new tab) and marks it shown;
 *   - a reply's Start experiment button (lib/honestActions.mjs) sends the
 *     real /lab start command;
 *   - the menu has the Notifications switch.
 *
 * The page is served from public/ as deployed; /api/chat and /api/watches
 * are stubs that answer the way the server does.
 * Writes docs/screenshots/watch-report-412-dark.png for the PR.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/watch-reports.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeReport } from '../../lib/watches/report.mjs';
import { honestReply } from '../../lib/honestActions.mjs';
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

const REPO = 'Project-Gifted1/pg1-ai-agent';
// The report the server would write for a merged PR (lib/watches/report.mjs).
const built = composeReport({ target_type: 'pr', target_id: `${REPO}#42` }, { state: 'merged', info: { title: 'Fix the footer', url: `https://github.com/${REPO}/pull/42` } });
const REPORT = { id: '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', created_at: new Date().toISOString(), origin_thread: null, target_type: 'pr', target_id: `${REPO}#42`, state: 'merged', title: built.title, body: built.body, actions: built.actions };
const HONEST = honestReply('Got it. Starting the experiment now.', { prompt: 'start an experiment to compare two CVE feeds', isOperator: true });

function startStubServer() {
  const log = { chats: [], watches: [], missing: [] };
  let delivered = false;
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
        if (url.pathname === '/api/watches') {
          log.watches.push(parsed);
          if (!parsed || parsed.user !== 'operator') return json(401, { error: 'unauthorized' });
          if (parsed.op === 'inbox') return json(200, { ok: true, reports: delivered ? [] : [REPORT] });
          if (parsed.op === 'ack') { delivered = true; return json(200, { ok: true, acknowledged: parsed.ids.length }); }
          return json(200, { ok: true });
        }
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: true });
          log.chats.push(parsed);
          if (/^start an experiment/.test(parsed.prompt)) return json(200, { reply: HONEST.text, actions: HONEST.actions });
          return json(200, { reply: `Ran ${parsed.prompt}.`, actions: [] });
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

test('watch reports: shown once in the chat with their buttons; the Start experiment button sends the real /lab start; messages carry the thread key', { skip, timeout: 180000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await routeReplyFont(context);
  await context.addInitScript(() => { try { localStorage.setItem('pg1_theme', 'dark'); } catch (e) {} });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (err) => problems.push(String(err && err.message || err)));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });

  await page.goto(origin + '/', { waitUntil: 'load' });
  assert.equal(await page.locator('#push-btn[role="switch"]').count(), 1, 'the Notifications switch is in the menu');
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });

  // The report arrives after sign-in, once.
  const report = page.locator('#chat-container .message-bubble.is-report');
  await report.waitFor();
  assert.match(await report.innerText(), /PR #42 in Project-Gifted1\/pg1-ai-agent \(Fix the footer\) was merged\./);
  const link = report.locator('a.pg1-action');
  assert.equal(await link.getAttribute('href'), `https://github.com/${REPO}/pull/42`);
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  await page.waitForFunction(() => true);
  await page.waitForTimeout(300);
  const acks = log.watches.filter((w) => w && w.op === 'ack');
  assert.deepEqual(acks.map((a) => a.ids), [[REPORT.id]]);
  const inbox = log.watches.find((w) => w && w.op === 'inbox');
  assert.equal(inbox.threadKeys.length, 1);
  assert.match(inbox.threadKeys[0], /^[0-9a-f-]{36}$/, 'the screen\'s own key');
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'watch-report-412-dark.png') });

  // Polling again shows nothing twice.
  await page.evaluate(() => pollReports());
  await page.waitForTimeout(200);
  assert.equal(await report.count(), 1);

  // A false "starting it now": the reply says nothing started and offers
  // the real command as a button; tapping it sends /lab start.
  const before = await page.locator('#chat-container .message-bubble:not(.user)').count();
  await page.fill('#prompt-input', 'start an experiment to compare two CVE feeds');
  await page.click('.execute-btn');
  await page.waitForFunction((n) => { const b = document.querySelectorAll('#chat-container .message-bubble:not(.user)'); return b.length > n && !b[b.length - 1].classList.contains('pending'); }, before);
  const last = page.locator('#chat-container .message-bubble:not(.user)').last();
  assert.match(await last.innerText(), /I have not started anything/);
  assert.equal(log.chats[0].threadKey, inbox.threadKeys[0], 'the message carries the same thread key');
  const startBtn = last.locator('.pg1-action', { hasText: 'Start experiment' });
  await startBtn.click();
  await page.waitForFunction(() => /Ran \/lab start/.test(document.querySelector('#chat-container').innerText));
  assert.equal(log.chats[1].prompt, '/lab start compare two cve feeds');

  assert.deepEqual(problems, [], 'no page or console errors');
  assert.deepEqual(log.missing, []);
});
