/**
 * PG1 Sound in a real browser (Chromium via Playwright): /music status
 * shows a track awaiting its choice, with a player and "use take N"
 * (Approve / Decline) per take. Declining take 1 updates the card in place
 * from the card the server sends back: take 1 reads "Discarded" with no
 * player and no "Approve to render", and only take 2 can be approved. The
 * header's status has no leading " · ", the take lengths are the stored
 * files' measured lengths (61.9 s reads 1:01), and the header gives the
 * measured length, not the 30 s asked for.
 *
 * The cards are built by lib/music/chat.mjs musicCard over a stand-in
 * store, so what is drawn is what the server sends. /api/chat is a stub.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: npm run test:browser
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAM_BRAND_RE } from '../../lib/upstreamFailure.mjs';
import { musicCard } from '../../lib/music/chat.mjs';
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
if (chromium && !existsSync(chromium.executablePath())) {
  skip = `Chromium is not installed at ${chromium.executablePath()} (npx playwright install chromium)`;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json' };

const TRACK = '11111111-2222-4333-8444-555555555555';
const T1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const T2 = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const VAULT = 'https://vault.example.test/storage/v1/object/sign/pg1-vault/';

// The track row and its previews, as the vault holds them.
const row = (choices) => ({
  id: TRACK, title: 'Neon Drive', status: 'awaiting_choice', version: 1, options: { instrumental: true, length: 'short' }, spent_usd: 0.08, cap_usd: 2, choices
});
const ASSETS = [
  { kind: 'preview', variant: 1, version: 1, status: 'ok', storage_path: `music/${TRACK}/preview/v1-take1.mp3`, duration_s: 30.2 },
  { kind: 'preview', variant: 2, version: 1, status: 'ok', storage_path: `music/${TRACK}/preview/v1-take2.mp3`, duration_s: 61.9 }
];
const store = { sign: async (p) => `${VAULT}${p}?token=t`, listAssets: async () => ASSETS };

async function startStubServer() {
  const log = { decisions: [] };
  const before = await musicCard(store, row([{ variant: 1, token: T1 }, { variant: 2, token: T2 }]));
  const after = await musicCard(store, row([{ variant: 1, token: T1, declined: true }, { variant: 2, token: T2 }]));
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let p = null;
      try { p = body ? JSON.parse(body) : null; } catch (e) { p = null; }
      if (url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
      if (url.pathname === '/api/errors') return json(res, 200, { errors: [], ok: true });
      if (url.pathname === '/api/handoffs') return json(res, 200, { handoffs: [] });
      if (url.pathname === '/api/watches') return json(res, 200, { ok: true, reports: [] });
      if (url.pathname === '/api/chat') {
        if (p && p.prompt === 'AUTH_VERIFY') return json(res, 200, { authenticated: true });
        if (p && p.action === 'CONFIRM_PENDING_ACTION') {
          log.decisions.push([p.token, p.decision]);
          return json(res, 200, { reply: 'PG1 Sound: take 1 of 11111111 discarded. Approve take 2, or change it with /music edit 11111111.', musicTrack: after });
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        for (const ev of [
          { type: 'text', text: 'PG1 Sound · Neon Drive (11111111) · Previews ready: approve the take to finish' },
          { type: 'done', request_id: 'mus00001', result: { musicTrack: before } }
        ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        return res.end();
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

test('declining a take updates the music card in place: "Discarded", no player, only the other take approvable', { skip, timeout: 120000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await routeReplyFont(context);
  await context.route('https://vault.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'audio/mpeg', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));

  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });

  await page.fill('#prompt-input', `/music status ${TRACK.slice(0, 8)}`);
  await page.click('.execute-btn');
  const card = page.locator(`#chat-container .music-card[data-music-id="${TRACK}"]`).first();
  await card.waitFor({ timeout: 15000 });

  // Before: two takes, each with a player and its approval.
  assert.equal(await card.locator('audio').count(), 2);
  assert.equal(await card.locator('.approval-actions').count(), 2);
  assert.equal((await card.locator('[data-music-take="2"] .music-take-label').textContent()).trim(), 'Take 2 · 1:01', 'the measured 61.9 s');
  const status = (await card.locator('.film-card-status').textContent()).trim();
  assert.equal(status, 'Previews ready: approve the take to finish', 'no leading " · "');
  assert.match(await card.locator('.music-card-meta').first().textContent(), /about 61 s$/, 'the header gives the measured length');

  await card.locator('[data-music-take="1"] .approval-btn.decline').click();
  await page.waitForSelector(`.music-card[data-music-id="${TRACK}"] [data-music-take="1"][data-music-discarded="1"]`, { timeout: 15000 });
  assert.deepEqual(log.decisions, [[T1, 'decline']]);

  // After: the same card, updated in place (no second card appended).
  assert.equal(await page.locator(`.music-card[data-music-id="${TRACK}"]`).count(), 1);
  const updated = page.locator(`.music-card[data-music-id="${TRACK}"]`);
  const take1 = updated.locator('[data-music-take="1"]');
  assert.equal((await take1.textContent()).trim(), 'Take 1 · Discarded');
  assert.equal(await take1.locator('audio').count(), 0);
  assert.equal(await take1.locator('.approval-actions').count(), 0);
  assert.equal(await updated.locator('audio').count(), 1);
  assert.equal(await updated.locator('.approval-actions').count(), 1);
  assert.equal(await updated.locator('[data-music-take="2"] .approval-btn.approve').count(), 1);
  const text = (await updated.textContent()).replace(/\s+/g, ' ');
  assert.equal((text.match(/Approve to render this take in full/g) || []).length, 1);
  assert.doesNotMatch(text, UPSTREAM_BRAND_RE);
  assert.deepEqual(errors, []);
});
