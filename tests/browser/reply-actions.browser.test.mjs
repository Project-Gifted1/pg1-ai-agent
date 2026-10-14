/**
 * Reply actions and spoken commands in a real browser (Chromium via
 * Playwright): buttons under a reply run the full command, a button that
 * changes something needs a second tap, a command in backticks is a
 * button, and a pending confirm can be answered with "yes" or "no".
 *
 * The page is served from public/ as deployed; /api/chat is a stub that
 * answers each prompt the way the server does (streamed or JSON), with the
 * actions lib/replyActions.mjs and lib/voiceIntents.mjs produce.
 *
 * Writes docs/screenshots/reply-actions-412-dark.png for the PR.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/reply-actions.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replyActions } from '../../lib/replyActions.mjs';
import { resolveIntent } from '../../lib/voiceIntents.mjs';
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

const HOWTO = 'The run finished. Open its report with `/lab report e2981021`; the other experiment is still running.';
const STATUS = '### [ LAB ]\n- e2981021 · research · done · $0.01 of $2.00 · agent auth scope preflight\n- aaaaaaaa · code · running · $0.00 of $2.00 · draft tool';

// What the server answers for each prompt (its own modules build the actions).
function answer(prompt) {
  const intent = resolveIntent(prompt);
  if (intent && intent.action) return { reply: intent.question, actions: [intent.action] };
  const p = intent ? intent.command : prompt;
  if (p === '/lab status') return { reply: STATUS, actions: replyActions({ prompt: p, reply: STATUS }) };
  if (/^\/lab (report|stop) /.test(p)) return { reply: `Ran ${p}.`, actions: [] };
  return { reply: HOWTO, actions: replyActions({ prompt: p, reply: HOWTO }) };
}

function startStubServer() {
  const log = { prompts: [], missing: [] };
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
          log.prompts.push(parsed && parsed.prompt);
          const a = answer(String(parsed && parsed.prompt || ''));
          if (parsed && parsed.stream === true) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.write(`event: text\ndata: ${JSON.stringify({ type: 'text', text: a.reply })}\n\n`);
            res.write(`event: done\ndata: ${JSON.stringify({ type: 'done', request_id: 'r1', result: { actions: a.actions } })}\n\n`);
            return res.end();
          }
          return json(200, { reply: a.reply, actions: a.actions });
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

test('reply actions and spoken commands: buttons run full commands, risky ones confirm, "yes"/"no" answer a confirm', { skip, timeout: 180000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
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

  const send = async (text) => {
    const before = await page.locator('#chat-container .message-bubble:not(.user)').count();
    await page.fill('#prompt-input', text);
    await page.click('.execute-btn');
    return before;
  };
  const settled = (before) => page.waitForFunction((n) => {
    const b = document.querySelectorAll('#chat-container .message-bubble:not(.user)');
    return b.length > n && !b[b.length - 1].classList.contains('pending');
  }, before);
  const lastReply = () => page.locator('#chat-container .message-bubble:not(.user)').last();

  // 1. A reply mentioning a command: the command is a chip with its id.
  await settled(await send('which one finished?'));
  assert.equal(await lastReply().locator('.cmd-chip[data-command="/lab report e2981021"]').count(), 1, 'the backticked command is a button with its argument');
  assert.equal(await lastReply().locator('.pg1-action').count(), 0, 'no second button for a command that is already a chip');
  const chip = page.locator('.cmd-chip[data-command="/lab report e2981021"]').first();

  // 2. "PG1, lab status" by voice or text: the server runs /lab status; its
  //    reply has a Report button and a Stop button that needs two taps.
  await settled(await send('PG1, lab status'));
  const actions = lastReply().locator('.pg1-action');
  assert.deepEqual(await actions.allTextContents(), ['Lab report e2981021', 'Stop experiment aaaaaaaa']);
  await page.waitForTimeout(400); // the buttons' entrance animation
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'reply-actions-412-dark.png') });

  const stop = actions.nth(1);
  const sentBefore = log.prompts.length;
  await stop.click();
  assert.equal(await stop.textContent(), 'Tap again to confirm');
  assert.equal(log.prompts.length, sentBefore, 'one tap sends nothing');
  let n = await page.locator('#chat-container .message-bubble:not(.user)').count();
  await stop.click();
  await settled(n);
  assert.equal(log.prompts[log.prompts.length - 1], '/lab stop aaaaaaaa');

  // 3. The chip from step 1 runs the full command.
  n = await page.locator('#chat-container .message-bubble:not(.user)').count();
  await chip.click();
  await settled(n);
  assert.equal(log.prompts[log.prompts.length - 1], '/lab report e2981021');

  // 4. "stop experiment e2981021": PG1 asks; "yes" sends the command.
  await settled(await send('stop experiment e2981021'));
  assert.match(await lastReply().innerText(), /Stop experiment e2981021\? Tap the button or say "yes"/);
  await settled(await send('yes'));
  assert.equal(log.prompts[log.prompts.length - 1], '/lab stop e2981021');

  // 5. ... and "no" leaves it, with no request.
  await settled(await send('stop experiment e2981021'));
  const asked = log.prompts.length;
  await send('no');
  await page.waitForFunction(() => /Left it as it is\./.test(document.querySelector('#chat-container').innerText));
  assert.equal(log.prompts.length, asked, '"no" is answered on the page');

  assert.deepEqual(pageErrors, []);
});
