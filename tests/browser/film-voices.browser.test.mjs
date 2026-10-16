/**
 * /voices in a real browser (Chromium via Playwright), phone-sized:
 *   - typed /voices goes to the server (the client-side /voice profile
 *     switch never catches it) and the reply renders as a list: each voice
 *     with its short description and whether it is cleared for client work;
 *   - nothing on screen names a provider or model;
 *   - /voice is still the client-side profile switch (no server call).
 *
 * The reply is what api/chat.mjs sends for /voices, built with the real
 * handler (lib/film/voices.mjs) from a mocked voice list; the page is
 * served from public/ as deployed. Writes docs/screenshots/film-voices-412-dark.png.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/film-voices.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleVoicesCommand } from '../../lib/film/voices.mjs';
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
const BANNED = /(?<![a-z0-9])(?:eleven[\s_-]*labs|cartesia|google|gemini|replicate|claude|anthropic|openai|eleven_v3|eleven_multilingual(?:_v2)?|sonic)(?![a-z0-9])/i;

const VOICES = [
  { voice_id: 'premadeGeorge0001', name: 'George', category: 'premade', is_owner: false, labels: { accent: 'british', age: 'middle_aged', gender: 'male', use_case: 'narration' }, description: 'An ElevenLabs premade voice' },
  { voice_id: 'ownedCloneTom0005', name: 'Old Tom', category: 'cloned', is_owner: true, labels: { accent: 'british', age: 'old', gender: 'male' } },
  { voice_id: 'libraryGranny0008', name: 'Granny Rose', category: 'generated', is_owner: false, labels: { accent: 'british', gender: 'female', age: 'old' }, sharing: { status: 'copied', original_voice_id: 'orig' } }
];
const REPLY = (await handleVoicesCommand({ env: { ELEVENLABS_API_KEY: 'k' }, isOperator: true, fetchImpl: async () => new Response(JSON.stringify({ voices: VOICES }), { status: 200 }) })).reply;

function startStubServer() {
  const log = { chats: [], missing: [] };
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
          log.chats.push(parsed);
          if (parsed && parsed.prompt === '/voices') return json(200, { reply: REPLY });
          return json(200, { reply: `Ran ${parsed && parsed.prompt}.` });
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

test('/voices: sent to the server, shown as a list with client clearance, no provider names; /voice stays client-side', { skip, timeout: 180000 }, async (t) => {
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
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });

  const replies = page.locator('#chat-container .message-bubble:not(.user)');
  const send = async (text) => {
    const before = await replies.count();
    await page.fill('#prompt-input', text);
    await page.click('.execute-btn');
    await page.waitForFunction((n) => { const b = document.querySelectorAll('#chat-container .message-bubble:not(.user)'); return b.length > n && !b[b.length - 1].classList.contains('pending'); }, before);
    return replies.last();
  };

  const last = await send('/voices');
  assert.deepEqual(log.chats.map((c) => c.prompt), ['/voices'], 'the server answers /voices');
  const text = await last.innerText();
  assert.match(text, /PG1 VOICES/);
  assert.match(text, /George · british · middle aged · male · narration · client work: yes/);
  assert.match(text, /Old Tom · .* · client work: yes/);
  assert.match(text, /Granny Rose · .* · client work: no/);
  assert.equal(await last.locator('li').count(), 3, 'one list item per voice');
  assert.doesNotMatch(text, BANNED);
  assert.doesNotMatch(await page.locator('#chat-container').innerText(), BANNED);
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'film-voices-412-dark.png') });

  // /voice is still the profile switch, answered in the page.
  const profile = await send('/voice');
  assert.match(await profile.innerText(), /VOICE PROFILES/);
  assert.equal(log.chats.length, 1, '/voice made no server call');

  assert.deepEqual(problems, [], 'no page or console errors');
  assert.deepEqual(log.missing, []);
});
