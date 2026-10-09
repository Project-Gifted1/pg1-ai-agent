/**
 * PG1 Studio in a real browser (Chromium via Playwright): /film shows the
 * film card at once; the page polls /api/chat's FILM_STATUS action with the
 * operator's session; when the storyboard is ready the card shows its
 * summary, cost and Approve / Decline; approving brings the preview's card,
 * which polls until the low-res preview plays, with the full render's
 * approval under it. No engine name appears anywhere on the card.
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
import { UPSTREAM_BRAND_RE } from '../../lib/upstreamFailure.mjs';

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

const FILM = '11111111-2222-4333-8444-555555555555';
const T_PREVIEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const T_FULL = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PREVIEW_URL = 'https://vault.example.test/storage/v1/object/sign/pg1-vault/films/preview.mp4?token=t';
const base = { id: FILM, shortId: FILM.slice(0, 8), title: 'Harbour at Dawn', spentUsd: 0.15, capUsd: 20, engine: 'PG1 Studio' };

function startStubServer() {
  const log = { polls: 0, approvals: [] };
  let stage = 'storyboard';
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
      if (url.pathname === '/api/chat') {
        if (p && p.prompt === 'AUTH_VERIFY') return json(res, 200, { authenticated: true });
        if (p && p.action === 'FILM_STATUS') {
          log.polls++;
          if (!p.user || !p.pass) return json(res, 401, { reply: 'Authentication required.' });
          if (stage === 'storyboard') {
            stage = 'storyboard_ready';
            return json(res, 200, { filmProject: { ...base, status: 'awaiting_preview_approval', label: 'Storyboard ready: approve the preview', active: false, estPreviewUsd: 0.62, pendingApproval: { token: T_PREVIEW }, summary: '**Harbour at Dawn** — A fisher sets out.\n- Scene 1 (The quay): 1.1 drone shot over the harbour (6 s)' } });
          }
          if (stage === 'preview_queued') {
            stage = 'preview_ready';
            return json(res, 200, { filmProject: { ...base, status: 'preview_rendering', label: 'Rendering the preview…', active: true, progress: { label: 'Still for shot 1.1', done: 2, total: 9 } } });
          }
          return json(res, 200, { filmProject: { ...base, status: 'preview_done', label: 'Preview ready: approve the full render', active: false, previewUrl: PREVIEW_URL, estFullUsd: 7.4, pendingApproval: { token: T_FULL }, spentUsd: 0.8 } });
        }
        if (p && p.action === 'CONFIRM_PENDING_ACTION') {
          log.approvals.push([p.token, p.decision]);
          stage = 'preview_queued';
          return json(res, 200, { reply: 'PG1 Studio: rendering the low-res preview for 11111111. It appears here when it is ready.', filmProject: { ...base, status: 'preview_queued', label: 'Rendering the preview…', active: true } });
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        for (const ev of [
          { type: 'text', text: 'PG1 Studio is writing the storyboard for film 11111111 (about 0.15 USD). Spending cap for this film: 20.00 USD.' },
          { type: 'done', request_id: 'flm00001', result: { filmProject: { ...base, status: 'storyboard_queued', label: 'Writing the storyboard…', active: true } } }
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

test('a film card follows the film from storyboard to preview, with its approvals', { skip, timeout: 120000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.route('https://vault.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));

  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });

  await page.fill('#prompt-input', '/film a one-minute film about a fisher at dawn');
  await page.click('.execute-btn');
  const card = page.locator(`#chat-container .film-card[data-film-id="${FILM}"]`).first();
  await card.waitFor({ timeout: 15000 });
  assert.equal(await card.getAttribute('data-film-active'), '1');
  assert.match(await card.textContent(), /PG1 Studio.*Writing the storyboard/s);

  // The poll turns it into the storyboard with its approval.
  await page.waitForSelector(`.film-card[data-film-id="${FILM}"] .approval-actions`, { timeout: 20000 });
  const text = (await card.textContent()).replace(/\s+/g, ' ');
  assert.match(text, /Storyboard ready/);
  assert.match(text, /drone shot over the harbour/);
  assert.match(text, /spent 0\.15 of 20\.00 USD · preview about 0\.62 USD/);

  await card.locator('.approval-btn.approve').click();
  await page.waitForFunction((id) => document.querySelectorAll(`.film-card[data-film-id="${id}"]`).length >= 1 && !!document.querySelector('.film-card video'), FILM, { timeout: 40000 });
  assert.deepEqual(log.approvals, [[T_PREVIEW, 'approve']]);
  const done = page.locator('.film-card video').locator('xpath=ancestor::div[contains(@class,"film-card")]');
  assert.equal(await page.locator('.film-card video').getAttribute('src'), PREVIEW_URL);
  const doneText = (await done.textContent()).replace(/\s+/g, ' ');
  assert.match(doneText, /Preview ready: approve the full render/);
  assert.match(doneText, /full render about 7\.40 USD/);
  assert.equal(await done.locator('.approval-actions').count(), 1);

  const allCards = await page.locator('.film-card').allTextContents();
  for (const c of allCards) assert.doesNotMatch(c, UPSTREAM_BRAND_RE);
  assert.ok(log.polls >= 3);
  assert.deepEqual(errors, []);
});
