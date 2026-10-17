/**
 * The Autonomous mode switch in the Command Centre header, in a real browser
 * (Chromium via Playwright, phone-sized):
 *   - a guest never sees it and the page asks nothing about it;
 *   - after sign-in the operator sees it in the header (OFF), turns it ON
 *     (pulsing dot, today's count), opens the timeline from the count, and
 *     turns it OFF again; the server is told each time (auto_set);
 *   - the state comes from the server (another device switched it on: the
 *     page shows ON after its next read).
 * The page is served from public/ as deployed; /api/watches is a stub that
 * answers the auto_* ops the way api/watches.mjs does (401 for anyone but
 * the operator).
 * Writes docs/screenshots/autonomous-switch-412-dark.png.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
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

let chromium = null;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  skip = 'playwright is not installed (npm install)';
}
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()}`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8' };

function startStubServer() {
  const log = { ops: [], missing: [] };
  const state = { enabled: false, todayCount: 0 };
  const actions = [
    { id: 'a1', at: new Date(Date.now() - 60000).toISOString(), type: 'feed_guardian', label: 'Feed guardian', reason: 'scheduled', inputs_summary: null, status: 'done', result: 'Feed healthy: no anomaly found.', cost_usd: 0, link: null },
    { id: 'a2', at: new Date(Date.now() - 120000).toISOString(), type: 'self_heal', label: 'Self-healing ops (draft PR only)', reason: 'deploy failed', inputs_summary: 'deploy dpl_abc', status: 'done', result: 'Draft PR #401 opened (report only)', cost_usd: 0, link: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/401' }
  ];
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
          log.ops.push(parsed && parsed.op);
          if (!parsed || parsed.user !== 'operator' || parsed.pass !== 'passkey') return json(401, { error: 'unauthorized' });
          if (parsed.op === 'auto_state') return json(200, { ok: true, autonomous: { ...state, available: true, pendingApprovals: 0 } });
          if (parsed.op === 'auto_set') { state.enabled = parsed.enabled === true; if (state.enabled) state.todayCount = 2; return json(200, { ok: true, autonomous: { enabled: state.enabled } }); }
          if (parsed.op === 'auto_log') return json(200, { ok: true, actions });
          if (parsed.op === 'inbox') return json(200, { ok: true, reports: [] });
          return json(200, { ok: true });
        }
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: parsed.user === 'operator' && parsed.pass === 'passkey' });
          return json(200, { reply: 'ok' });
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
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, log, state, origin: `http://127.0.0.1:${server.address().port}` })));
}

test('Autonomous mode: hidden for guests; the operator switches it on and off from the header and opens the timeline', { skip, timeout: 180000 }, async (t) => {
  const { server, log, state, origin } = await startStubServer();
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
  assert.equal(await page.locator('#auto-wrap').isVisible(), false, 'a guest does not see the switch');
  assert.ok(!log.ops.some((o) => String(o).startsWith('auto_')), 'a guest page asks nothing about it');

  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  const sw = page.locator('#auto-toggle');
  await sw.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('auto-word').textContent === 'AUTO OFF');
  assert.equal(await sw.getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#auto-count').isVisible(), false, 'no count while OFF');
  const box = await sw.boundingBox();
  assert.ok(box && box.y + box.height <= 80, 'always visible in the header');

  // ON: pulsing dot and today's count.
  await sw.click();
  await page.waitForFunction(() => document.getElementById('auto-toggle').getAttribute('aria-checked') === 'true');
  assert.equal(await page.locator('#auto-word').innerText(), 'AUTO ON');
  await page.waitForFunction(() => document.getElementById('auto-count').textContent === '2');
  assert.equal(await page.locator('#auto-count').isVisible(), true);
  const anim = await page.evaluate(() => getComputedStyle(document.querySelector('#auto-toggle .auto-dot')).animationName);
  assert.equal(anim, 'auto-pulse', 'the ON indicator pulses');
  assert.ok(log.ops.includes('auto_set'));

  // The timeline, from the count.
  await page.click('#auto-count');
  await page.locator('#auto-modal').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#auto-timeline li[data-status]').length === 2);
  const text = await page.locator('#auto-timeline').innerText();
  assert.match(text, /Feed guardian/);
  assert.match(text, /Draft PR #401 opened/);
  assert.equal(await page.locator('#auto-timeline a').getAttribute('href'), 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/401');
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'autonomous-switch-412-dark.png') });
  await page.click('#auto-modal [data-dialog-close]');

  // OFF: instant on screen, and the server is told.
  const before = log.ops.filter((o) => o === 'auto_set').length;
  await sw.click();
  await page.waitForFunction(() => document.getElementById('auto-toggle').getAttribute('aria-checked') === 'false');
  assert.equal(state.enabled, false);
  assert.equal(log.ops.filter((o) => o === 'auto_set').length, before + 1);

  // Another device switched it on: the next read shows it.
  state.enabled = true;
  await page.evaluate(() => refreshAutonomous());
  await page.waitForFunction(() => document.getElementById('auto-toggle').getAttribute('aria-checked') === 'true');

  // Reduced motion: no pulse.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#auto-toggle .auto-dot')).animationName), 'none');

  assert.deepEqual(problems, [], 'no page or console errors');
  assert.deepEqual(log.missing, []);
});
