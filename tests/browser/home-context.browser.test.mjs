/**
 * The home screen's live text in a real browser (Chromium via Playwright,
 * phone-sized, 412 px):
 *   - a guest sees today's generic subtitle and the four default cards, and
 *     the page never asks for the home context;
 *   - after sign-in the defaults show first; the live subtitle and cards
 *     swap in with a short fade once /api/home-context answers: "2 approvals"
 *     and the "Review 2 approvals" card on /report today, with their digits;
 *     /help stays a card;
 *   - back in the foreground the page reads it again ("3 findings");
 *   - under prefers-reduced-motion the swap has no animation.
 * The page is served from public/ as deployed; /api/home-context is a stub
 * that answers 401 to anyone but the operator, like api/home-context.mjs.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()}`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8' };

const APPROVALS = {
  state: 'approvals',
  subtitle: '2 approvals are waiting for you.',
  cards: [
    { label: 'Review 2 approvals', command: '/report today', icon: 'i-check' },
    { label: 'See what PG1 did overnight', command: '/autonomy', icon: 'i-eye' },
    { label: 'Run a threat radar', command: '/threat-radar', icon: 'i-radar' },
    { label: 'See all commands', command: '/help', icon: 'i-help' }
  ]
};
const REPORT = {
  state: 'report',
  subtitle: "Last night's report is in, with 3 findings.",
  cards: [
    { label: "Read today's report", command: '/report today', icon: 'i-file' },
    { label: 'Check system status', command: '/status', icon: 'i-pulse' },
    { label: 'Review commerce', command: '/commerce-status', icon: 'i-cart' },
    { label: 'See all commands', command: '/help', icon: 'i-help' }
  ]
};

function startStubServer() {
  const log = { home: [], missing: [] };
  const state = { home: APPROVALS, delayMs: 900 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      const json = (status, b) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      const operator = parsed && parsed.user === 'operator' && parsed.pass === 'passkey';
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health') return json(200, { status: 'ok' });
        if (url.pathname === '/api/errors') return json(200, { errors: [], ok: true });
        if (url.pathname === '/api/handoffs') return json(200, { handoffs: [] });
        if (url.pathname === '/api/threads') return json(200, { threads: [] });
        if (url.pathname === '/api/home-context') {
          log.home.push(operator ? 'operator' : 'guest');
          if (!operator) return json(401, { error: 'unauthorized' });
          const home = state.home;
          return setTimeout(() => json(200, { ok: true, signals: {}, home }), state.delayMs);
        }
        // PG1 Kingdom Defence's feed: operator only, nothing logged here.
        if (url.pathname === '/api/defense-feed') return json(operator ? 200 : 401, operator ? { ok: true, events: [], today: {}, threat: { level: 'calm' }, gadgets: [] } : { error: 'unauthorized' });
        if (url.pathname === '/api/watches') {
          if (!operator) return json(401, { error: 'unauthorized' });
          if (parsed.op === 'auto_state') return json(200, { ok: true, autonomous: { enabled: false, available: true, todayCount: 0, pendingApprovals: 0 } });
          if (parsed.op === 'auto_inbox' || parsed.op === 'inbox') return json(200, { ok: true, reports: [] });
          return json(200, { ok: true });
        }
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: operator });
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

const SUBTITLE = '#chat-container .message-bubble.welcome .message-text';
const CARDS = '#chat-container .message-bubble.welcome .welcome-suggestions .suggestion';
const cardsOf = (page) => page.$$eval(CARDS, (els) => els.map((b) => ({ label: b.querySelector('strong').textContent, command: b.querySelector('small').textContent })));
const DEFAULTS = [
  { label: 'Run a threat radar', command: '/threat-radar' },
  { label: 'Check system status', command: '/status' },
  { label: 'Review commerce', command: '/commerce-status' },
  { label: 'See all commands', command: '/help' }
];
const GENERIC = 'PG1 is online. Ask anything, or pick a starting point.';

async function openPage(browser, { reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion });
  await routeReplyFont(context);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (err) => problems.push(String(err && err.message || err)));
  return { context, page, problems };
}

async function signIn(page) {
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
}

test('home screen on a phone: guests keep the defaults; the operator sees them swap to the live text with its digits', { skip, timeout: 120000 }, async (t) => {
  const { server, log, state, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, problems } = await openPage(browser);

  await page.goto(origin + '/', { waitUntil: 'load' });
  assert.equal((await page.locator(SUBTITLE).innerText()).trim(), GENERIC);
  assert.deepEqual(await cardsOf(page), DEFAULTS);
  await page.waitForTimeout(300);
  assert.deepEqual(log.home, [], 'a guest page never asks for the home context');

  // Sign in: the defaults show first, then the live text swaps in.
  await signIn(page);
  assert.equal((await page.locator(SUBTITLE).innerText()).trim(), GENERIC, 'defaults while the context loads');
  assert.deepEqual(await cardsOf(page), DEFAULTS);
  await page.waitForFunction((sel) => /approvals are waiting/.test(document.querySelector(sel).textContent), SUBTITLE);
  assert.equal((await page.locator(SUBTITLE).innerText()).trim(), '2 approvals are waiting for you.', 'the digit is shown');
  const cards = await cardsOf(page);
  assert.deepEqual(cards, APPROVALS.cards.map(({ label, command }) => ({ label, command })));
  assert.ok(cards.some((c) => c.command === '/help'));
  assert.ok(log.home.includes('operator'));
  // The short fade.
  assert.equal(await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).animationName, SUBTITLE), 'home-swap');
  // Fits the phone: no sideways scroll.
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  // Each card still runs its real command.
  assert.equal(await page.locator(CARDS).first().getAttribute('data-command'), '/report today');

  // Back in the foreground: read again.
  state.home = REPORT;
  state.delayMs = 0;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction((sel) => /3 findings/.test(document.querySelector(sel).textContent), SUBTITLE);
  assert.equal((await page.locator(SUBTITLE).innerText()).trim(), "Last night's report is in, with 3 findings.");
  assert.equal((await cardsOf(page))[0].label, "Read today's report");
  assert.deepEqual(problems, []);
});

test('home screen: under prefers-reduced-motion the swap has no animation', { skip, timeout: 120000 }, async (t) => {
  const { server, state, origin } = await startStubServer();
  state.delayMs = 200;
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, problems } = await openPage(browser, { reducedMotion: 'reduce' });
  await page.goto(origin + '/', { waitUntil: 'load' });
  await signIn(page);
  await page.waitForFunction((sel) => /approvals are waiting/.test(document.querySelector(sel).textContent), SUBTITLE);
  assert.equal(await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).animationName, SUBTITLE), 'none');
  assert.deepEqual(problems, []);
});
