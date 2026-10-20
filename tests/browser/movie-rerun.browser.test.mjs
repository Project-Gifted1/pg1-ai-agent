/**
 * PG1 Studio movies in a real browser (Chromium via Playwright): a failed
 * movie's card has a Rerun button; tapping it sends "/movie rerun <id>",
 * whose reply carries Confirm / Cancel (nothing is spent before Confirm);
 * a paused movie's card has Resume instead ("/movie resume <id>"). No
 * engine name appears on the cards.
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

const FAILED = '6da446ca-6efe-4de1-8271-3d5dcb5bb021';
const PAUSED = '7eb557db-6efe-4de1-8271-3d5dcb5bb022';
const T_RERUN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const card = (id, extra) => ({ id, shortId: id.slice(0, 8), title: 'First Loaf', kind: 'movie', spentUsd: 18.6, capUsd: 60, engine: 'PG1 Studio', active: false, ...extra });

function startStubServer() {
  const log = { prompts: [] };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const stream = (res, text, result) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    for (const ev of [{ type: 'text', text }, { type: 'done', request_id: 'mov00001', result }]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.end();
  };
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
        if (p && typeof p.prompt === 'string') log.prompts.push(p.prompt);
        if (p && p.prompt === `/movie status ${FAILED.slice(0, 8)}`) {
          return stream(res, 'PG1 Studio · First Loaf (6da446ca) · The movie could not be finished', { filmProject: card(FAILED, { status: 'failed', label: 'The movie could not be finished', message: 'PG1 Studio stopped at the shoot: the picture engine is out of credit.', rerunCommand: `/movie rerun ${FAILED.slice(0, 8)}` }) });
        }
        if (p && p.prompt === `/movie status ${PAUSED.slice(0, 8)}`) {
          return stream(res, 'PG1 Studio · paused', { filmProject: card(PAUSED, { status: 'paused_budget', label: 'Paused before spending more: resume when ready', paused: true, resumeCommand: `/movie resume ${PAUSED.slice(0, 8)}` }) });
        }
        if (p && p.prompt === `/movie rerun ${FAILED.slice(0, 8)}`) {
          return stream(res, 'PG1 Studio: rerun movie 6da446ca from where it stopped. 12 of 31 shots are saved; the rerun continues from shot s3-w1. Confirm to rerun; nothing is spent before you do.', { pendingApproval: { token: T_RERUN, labels: { approve: 'Confirm', decline: 'Cancel' } } });
        }
        return stream(res, 'ok', {});
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

test('a failed movie has Rerun (Confirm / Cancel before anything is spent); a paused one has Resume', { skip, timeout: 120000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await routeReplyFont(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));

  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });

  await page.fill('#prompt-input', `/movie status ${FAILED.slice(0, 8)}`);
  await page.click('.execute-btn');
  const failed = page.locator(`#chat-container .film-card[data-film-id="${FAILED}"]`).first();
  await failed.waitFor({ timeout: 15000 });
  const rerun = failed.locator('.pg1-action.movie-rerun');
  assert.equal(await rerun.count(), 1);
  assert.equal((await rerun.textContent()).trim(), 'Rerun');
  assert.equal(await rerun.getAttribute('data-command'), '/movie rerun 6da446ca');
  await rerun.click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.approval-actions .approval-label')).some((e) => e.textContent === 'Confirm'), null, { timeout: 15000 });
  assert.ok(log.prompts.includes('/movie rerun 6da446ca'), log.prompts.join(' | '));
  const labels = await page.locator('.approval-actions').last().locator('.approval-label').allTextContents();
  assert.deepEqual(labels, ['Confirm', 'Cancel']);
  assert.match((await page.locator('#chat-container').textContent()).replace(/\s+/g, ' '), /continues from shot s3-w1/);

  await page.fill('#prompt-input', `/movie status ${PAUSED.slice(0, 8)}`);
  await page.click('.execute-btn');
  const paused = page.locator(`#chat-container .film-card[data-film-id="${PAUSED}"]`).first();
  await paused.waitFor({ timeout: 15000 });
  const resume = paused.locator('.pg1-action.movie-rerun');
  assert.equal((await resume.textContent()).trim(), 'Resume');
  assert.equal(await resume.getAttribute('data-command'), '/movie resume 7eb557db');

  for (const c of await page.locator('.film-card').allTextContents()) assert.doesNotMatch(c, UPSTREAM_BRAND_RE);
  assert.deepEqual(errors, []);
});
