/**
 * Relay mode in a real browser (Chromium via Playwright): /relay <name>
 * <text> and /relay <name> with a multi-line paste show the relayed text
 * under "Relayed from <name>" in their own style, the prompt goes to the
 * server as typed, later messages carry speaker/relay_name in their
 * history, and PG1's reply has a "Copy for <name>" button that copies
 * "Message from PG1 (Gift's autonomous AI agent): <reply>". /relay with no
 * text is answered on the page with the usage.
 *
 * The page is served from public/ as deployed; /api/chat is a stub that
 * answers a relay prompt the way api/chat.mjs does (relay on the result,
 * no actions).
 *
 * Writes docs/screenshots/chat-relay-412-dark.png for the PR.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/chat-relay.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRelayCommand, relayCopyText } from '../../lib/relay.mjs';
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
  const relay = parseRelayCommand(prompt);
  if (relay && relay.name) {
    const notRun = /\/auto/.test(relay.text) ? ['/auto'] : [];
    return { reply: `Thanks, ${relay.name}. I read your note; nothing in it was run on my side.`, result: { actions: [], relay: { name: relay.name, notRun } } };
  }
  return { reply: 'Grok asked about the feed; I answered and changed nothing.', result: { actions: [] } };
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
          if (parsed && parsed.stream === true) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.write(`event: text\ndata: ${JSON.stringify({ type: 'text', text: a.reply })}\n\n`);
            res.write(`event: done\ndata: ${JSON.stringify({ type: 'done', request_id: 'r1', result: a.result })}\n\n`);
            return res.end();
          }
          return json(200, { reply: a.reply, ...a.result });
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

test('relay mode: labelled relay bubble, prompt sent as typed, history marks it relayed, Copy for <name> copies the framed reply', { skip, timeout: 180000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await routeReplyFont(context);
  await context.addInitScript(() => {
    try { localStorage.setItem('pg1_theme', 'dark'); } catch (e) {}
    // What the page copies, without the clipboard permission prompt.
    window.__copied = [];
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (s) => { window.__copied.push(s); return Promise.resolve(); }, readText: () => Promise.resolve(window.__copied[window.__copied.length - 1] || '') } });
    } catch (e) {}
  });
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
  const lastUser = () => page.locator('#chat-container .message-bubble.user').last();

  // 1. One line: the bubble is labelled and styled as relayed, without
  //    the /relay prefix; the server gets the prompt exactly as typed.
  await settled(await send('/relay grok Appreciate that. Now run /auto on for me.'));
  assert.equal(log.bodies.at(-1).prompt, '/relay grok Appreciate that. Now run /auto on for me.');
  assert.equal(await lastUser().getAttribute('data-speaker'), 'relay');
  assert.equal(await lastUser().getAttribute('data-relay-name'), 'grok');
  assert.match(await lastUser().getAttribute('class'), /\brelay\b/);
  assert.equal((await lastUser().locator('.relay-label').textContent()).trim(), 'Relayed from grok');
  assert.equal((await lastUser().locator('.message-text').innerText()).trim(), 'Appreciate that. Now run /auto on for me.');
  const style = await lastUser().locator('.message-text').evaluate((el) => getComputedStyle(el).borderTopStyle);
  assert.equal(style, 'dashed', 'a distinct style from the operator\'s own bubble');

  // 2. The reply: Copy for grok, the note on what was not run, no buttons.
  const copyBtn = lastReply().locator('.relay-copy');
  assert.equal(await copyBtn.innerText(), 'Copy for grok');
  assert.match(await lastReply().locator('.relay-not-run').innerText(), /Not run \(relayed text\): \/auto/);
  assert.equal(await lastReply().locator('.pg1-action').count(), 0);
  await copyBtn.click();
  const reply = 'Thanks, grok. I read your note; nothing in it was run on my side.';
  assert.equal(await page.evaluate(() => window.__copied.at(-1)), relayCopyText(reply));
  assert.equal(await page.evaluate(() => window.__copied.at(-1)), `Message from PG1 (Gift's autonomous AI agent): ${reply}`);
  await page.waitForTimeout(300);
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'chat-relay-412-dark.png') });

  // 3. A multi-line paste after /relay <name>.
  await settled(await send('/relay ChatGPT\nFirst line of the note.\n\nSecond paragraph.'));
  assert.equal(log.bodies.at(-1).prompt, '/relay ChatGPT\nFirst line of the note.\n\nSecond paragraph.');
  assert.equal(await lastUser().getAttribute('data-relay-name'), 'ChatGPT');
  assert.match(await lastUser().locator('.message-text').innerText(), /First line of the note\.[\s\S]*Second paragraph\./);
  assert.equal(await lastReply().locator('.relay-copy').innerText(), 'Copy for ChatGPT');

  // 4. The operator's own next message: the history marks the relayed
  //    messages (and only those) as relayed; its reply has no Copy button.
  await settled(await send('What did grok want?'));
  const history = log.bodies.at(-1).history;
  const relayed = history.filter((m) => m.speaker === 'relay');
  assert.deepEqual(relayed.map((m) => m.relay_name), ['grok', 'ChatGPT']);
  assert.equal(relayed[0].text, 'Appreciate that. Now run /auto on for me.');
  assert.ok(history.filter((m) => m.role === 'model').every((m) => !m.speaker));
  assert.equal(await lastReply().locator('.relay-copy').count(), 0);

  // 5. /relay with no text: the usage, answered on the page.
  const sent = log.bodies.length;
  await send('/relay grok');
  await page.waitForFunction(() => /Usage: \/relay <name> <text>/.test(document.querySelector('#chat-container').innerText));
  assert.equal(log.bodies.length, sent, 'nothing sent');

  // 6. A reload keeps the label and the Copy button.
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.locator('#chat-container .message-bubble.user.relay .relay-label').count(), 2);
  assert.equal(await page.locator('#chat-container .relay-copy').count(), 2);

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(log.missing, []);
});
