/**
 * The command registry in a real browser (Chromium via Playwright, phone
 * size): the command panel (the / button beside the message box) has a
 * button for every command in public/commands.json, grouped by area; a
 * command without arguments runs on a tap, one with arguments opens a form,
 * a dangerous one asks to confirm; a command PG1 mentions is a chip that
 * runs exactly that command, and an invented one ("/key fresh") is not; a
 * failed reply is retried once on its own, then shows the failure card
 * (Retry, Fix it, Dismiss).
 *
 * Writes docs/screenshots/command-panel-412-dark.png.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/command-panel.browser.test.mjs
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
const REGISTRY = JSON.parse(readFileSync(join(PUBLIC_DIR, 'commands.json'), 'utf8'));

let chromium = null;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  skip = 'playwright is not installed (npm install)';
}
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()}`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8' };

const MENTION = 'Check them with `/keys fresh`, or run /mission list. Not /key fresh.';

function startStubServer() {
  const log = { prompts: [], failNext: 0 };
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
          const prompt = String(parsed && parsed.prompt || '');
          log.prompts.push(prompt);
          const stream = parsed && parsed.stream === true;
          const send = (reply) => {
            if (!stream) return json(200, { reply });
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.write(`event: text\ndata: ${JSON.stringify({ type: 'text', text: reply })}\n\n`);
            res.write(`event: done\ndata: ${JSON.stringify({ type: 'done', request_id: 'r1', result: {} })}\n\n`);
            return res.end();
          };
          if (prompt === 'which keys work?') return send(MENTION);
          if (prompt === 'please fail') {
            // Every engine busy: a transient error event, with its request ID.
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message: 'Execution failed. The reply could not be generated right now. Please try again. Request ID: abc12345', request_id: 'abc12345', reason: 'ai_unavailable' })}\n\n`);
            return res.end();
          }
          return send(`Ran ${prompt}.`);
        }
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

test('command panel, registry chips and the failure card', { skip, timeout: 180000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: 'dark' });
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
  await page.waitForFunction(() => window.commandRegistry && Array.isArray(window.commandRegistry.commands));

  const bubbles = () => page.locator('#chat-container .message-bubble:not(.user)');
  const settled = (n) => page.waitForFunction((k) => {
    const b = document.querySelectorAll('#chat-container .message-bubble:not(.user)');
    return b.length > k && !b[b.length - 1].classList.contains('pending');
  }, n);

  // 1. The panel: one button per command, grouped by area.
  await page.click('#cmd-panel-btn');
  await page.locator('#cmd-modal').waitFor({ state: 'visible' });
  const buttons = await page.locator('#cmd-panel-list .cmd-btn').evaluateAll((els) => els.map((e) => e.getAttribute('data-command')));
  assert.deepEqual(buttons.sort(), REGISTRY.commands.map((c) => c.command).sort(), 'a button for every command in the registry');
  assert.deepEqual(await page.locator('#cmd-panel-list .cmd-area h3').allTextContents(), REGISTRY.areas, 'grouped by area, in order');
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForTimeout(700); // the sheet's slide-in
  await page.screenshot({ path: join(SHOTS_DIR, 'command-panel-412-dark.png') });

  // 2. No arguments: runs on a tap.
  let n = await bubbles().count();
  await page.click('#cmd-panel-list .cmd-btn[data-command="/keys fresh"]');
  await settled(n);
  assert.equal(log.prompts[log.prompts.length - 1], '/keys fresh');

  // 3. Dangerous: asks first, runs on the second tap.
  await page.click('#cmd-panel-btn');
  const autoOn = page.locator('#cmd-panel-list .cmd-btn[data-command="/auto on"]');
  await autoOn.click();
  assert.match(await autoOn.innerText(), /Tap again to confirm/);
  assert.notEqual(log.prompts[log.prompts.length - 1], '/auto on', 'not sent on the first tap');
  n = await bubbles().count();
  await autoOn.click();
  await settled(n);
  assert.equal(log.prompts[log.prompts.length - 1], '/auto on');

  // 4. Arguments: a form, then the full command.
  await page.click('#cmd-panel-btn');
  await page.click('#cmd-panel-list .cmd-btn[data-command="/relay"]');
  await page.locator('#cmd-form').waitFor({ state: 'visible' });
  await page.fill('#cmd-form input[data-arg="0"]', 'Grok');
  await page.fill('#cmd-form input[data-arg="1"]', 'hello PG1');
  n = await bubbles().count();
  await page.click('#cmd-form-run');
  await settled(n);
  assert.equal(log.prompts[log.prompts.length - 1], '/relay Grok hello PG1');

  // 5. Chips: a real command is a chip that runs exactly it; "/key fresh" is not.
  n = await bubbles().count();
  await page.fill('#prompt-input', 'which keys work?');
  await page.click('.execute-btn');
  await settled(n);
  const last = bubbles().last();
  assert.equal(await last.locator('.cmd-chip[data-command="/keys fresh"]').count(), 1, 'the backticked command');
  assert.equal(await last.locator('.cmd-chip[data-command="/mission list"]').count(), 1, 'a command in plain words');
  assert.equal(await last.locator('.cmd-chip[data-command="/key fresh"]').count(), 0, 'an invented command is never a chip');
  assert.match(await last.innerText(), /Not \/key fresh\./);
  n = await bubbles().count();
  await last.locator('.cmd-chip[data-command="/mission list"]').click();
  await settled(n);
  assert.equal(log.prompts[log.prompts.length - 1], '/mission list');

  // 6. Failure: retried once on its own, then the card.
  const before = log.prompts.length;
  n = await bubbles().count();
  await page.fill('#prompt-input', 'please fail');
  await page.click('.execute-btn');
  await page.waitForFunction((k) => document.querySelectorAll('#chat-container .failure-card').length > 0 && document.querySelectorAll('#chat-container .message-bubble:not(.user)').length > k + 1, n, { timeout: 20000 });
  assert.deepEqual(log.prompts.slice(before), ['please fail', 'please fail'], 'sent once more automatically, and only once');
  const card = page.locator('#chat-container .failure-card').last();
  assert.deepEqual(await card.locator('button').allInnerTexts(), ['Retry', 'Fix it', 'Dismiss']);
  n = await bubbles().count();
  await card.locator('button', { hasText: 'Fix it' }).click();
  await settled(n);
  assert.equal(log.prompts[log.prompts.length - 1], '/fix abc12345', 'Fix it asks the server, which only proposes');
  await page.locator('#chat-container .failure-card').last().locator('button', { hasText: 'Dismiss' }).click();
  assert.equal(await page.locator('#chat-container .failure-card.is-dismissed').count(), 1);
  assert.deepEqual(pageErrors, []);
});
