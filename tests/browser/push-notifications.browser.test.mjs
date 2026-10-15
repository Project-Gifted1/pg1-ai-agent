/**
 * The Notifications section of the menu in a real browser (Chromium via
 * Playwright, phone-sized):
 *   - a guest never sees it, and the page sends no push request for one;
 *   - after sign-in the operator sees the switch with its state, turns it
 *     on (permission, /sw.js registered, subscribed with the server's VAPID
 *     public key, subscription stored) and sends a test notification;
 *   - with notifications blocked for the site, the state says so and the
 *     menu shows how to allow them in Chrome's site settings.
 *
 * The page is served from public/ as deployed; /api/chat and /api/watches
 * are stubs that answer the way the server does (401 for anyone but the
 * operator). Headless Chromium has no push service, so PushManager's
 * subscribe/getSubscription are replaced with a fake subscription; the
 * service worker registration itself is real.
 * Writes docs/screenshots/push-notifications-412-dark.png for the PR.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/push-notifications.browser.test.mjs
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.css': 'text/css; charset=utf-8' };

// A P-256 public key shape (65 bytes, base64url): what VAPID_PUBLIC_KEY holds.
const VAPID_PUBLIC = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i))).toString('base64url');
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const FAKE_ENDPOINT = 'https://push.example/fake-phone';

function startStubServer() {
  const log = { watches: [], missing: [] };
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
          if (!parsed || parsed.user !== 'operator' || parsed.pass !== 'passkey') return json(401, { error: 'unauthorized', message: 'Watches and reports are for the signed-in operator only.' });
          if (parsed.op === 'inbox') return json(200, { ok: true, reports: [] });
          if (parsed.op === 'vapid') return json(200, { ok: true, publicKey: VAPID_PUBLIC });
          if (parsed.op === 'subscribe') return json(200, { ok: true, subscribed: true });
          if (parsed.op === 'unsubscribe') return json(200, { ok: true, removed: 1 });
          if (parsed.op === 'test') return json(200, { ok: true, sent: parsed.subscription && parsed.subscription.endpoint === FAKE_ENDPOINT ? 1 : 0 });
          return json(200, { ok: true });
        }
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: parsed.user === 'operator' && parsed.pass === 'passkey' });
          return json(200, { reply: 'ok', actions: [] });
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

// Headless Chromium has no push service: a fake subscription stands in.
function fakePushManager(endpoint) {
  const store = { sub: null };
  const make = (key) => ({
    endpoint,
    options: { applicationServerKey: key ? key.buffer : null },
    toJSON() { return { endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }; },
    async unsubscribe() { store.sub = null; return true; }
  });
  PushManager.prototype.getSubscription = async function () { return store.sub; };
  PushManager.prototype.subscribe = async function (opts) {
    window.__pushSubscribeKeyLength = opts.applicationServerKey.length;
    store.sub = make(opts.applicationServerKey);
    return store.sub;
  };
}

async function newPhone(browser, origin, { blocked = false } = {}) {
  const context = await browser.newContext({ userAgent: ANDROID_CHROME, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await routeReplyFont(context);
  await context.addInitScript(() => { try { localStorage.setItem('pg1_theme', 'dark'); } catch (e) {} });
  await context.addInitScript(fakePushManager, FAKE_ENDPOINT);
  // Headless Chromium reports Notification.permission 'denied' even after
  // grantPermissions, so the prompt is simulated: 'default' until asked,
  // then the operator taps Allow (or the site is blocked).
  await context.grantPermissions(blocked ? [] : ['notifications'], { origin });
  await context.addInitScript((answer) => {
    let permission = answer === 'denied' ? 'denied' : 'default';
    Object.defineProperty(Notification, 'permission', { get: () => permission });
    Notification.requestPermission = async () => { window.__pushPermissionAsked = (window.__pushPermissionAsked || 0) + 1; permission = answer; return permission; };
  }, blocked ? 'denied' : 'granted');
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (err) => problems.push(String(err && err.message || err)));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  return { context, page, problems };
}

async function signIn(page) {
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
}

async function openMenu(page) {
  await page.click('#drawer-btn');
  await page.waitForFunction(() => document.body.classList.contains('drawer-open'));
}

test('notifications: guests never see the section; the operator turns it on, sees the state and sends a test', { skip, timeout: 180000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, problems } = await newPhone(browser, origin);

  // Guest: the section is not shown, and nothing asks for a key or registers.
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.evaluate(() => { document.getElementById('auth-modal').style.display = 'none'; });
  await openMenu(page);
  assert.equal(await page.locator('#push-panel').isVisible(), false, 'a guest does not see Notifications');
  assert.equal(await page.locator('#push-btn').isVisible(), false);
  assert.equal(await page.locator('#push-test-btn').isVisible(), false);
  await page.evaluate(() => togglePushNotifications());
  await page.evaluate(() => sendTestNotification());
  assert.deepEqual(log.watches.filter((w) => w && ['vapid', 'subscribe', 'test'].includes(w.op)), [], 'a guest sends no push request');
  // A wrong password does not reveal it either.
  await page.click('[data-drawer-close]');
  await page.evaluate(() => { document.getElementById('auth-modal').style.display = 'flex'; });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'wrong');
  page.once('dialog', (d) => d.dismiss());
  await page.press('#auth-pass', 'Enter');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#push-panel').isVisible(), false, 'a failed sign-in does not show it');

  // Operator: visible, Off, test disabled until it is on.
  await signIn(page);
  await openMenu(page);
  const sw = page.locator('#push-btn');
  await page.locator('#push-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#push-state').innerText(), 'Off on this device');
  assert.equal(await sw.getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#push-test-btn').isDisabled(), true);
  const box = await sw.boundingBox();
  assert.ok(box && box.y + box.height <= 915, 'the switch is on screen without scrolling the menu');

  // Turn it on: service worker registered, subscribed with the server key, stored.
  await sw.click();
  await page.waitForFunction(() => document.getElementById('push-btn').getAttribute('aria-checked') === 'true');
  assert.equal(await page.locator('#push-state').innerText(), 'On for this device');
  assert.match(await page.locator('#push-msg').innerText(), /Notifications are on for this device/);
  assert.equal(await page.evaluate(() => window.__pushPermissionAsked), 1, 'the browser permission prompt was shown');
  assert.equal(await page.evaluate(() => navigator.serviceWorker.getRegistration('/').then((r) => !!r && /\/sw\.js$/.test((r.active || r.waiting || r.installing).scriptURL))), true, '/sw.js is registered');
  assert.equal(await page.evaluate(() => window.__pushSubscribeKeyLength), 65, 'subscribed with the VAPID public key');
  const sub = log.watches.find((w) => w && w.op === 'subscribe');
  assert.equal(sub.subscription.endpoint, FAKE_ENDPOINT);
  assert.equal(sub.label, 'phone');

  // Send test notification.
  assert.equal(await page.locator('#push-test-btn').isDisabled(), false);
  await page.click('#push-test-btn');
  await page.waitForFunction(() => /Test sent/.test(document.getElementById('push-msg').innerText));
  const testReq = log.watches.find((w) => w && w.op === 'test');
  assert.equal(testReq.subscription.endpoint, FAKE_ENDPOINT, 'the test goes to this device');
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'push-notifications-412-dark.png') });

  // Turn it off.
  await sw.click();
  await page.waitForFunction(() => document.getElementById('push-btn').getAttribute('aria-checked') === 'false');
  assert.equal(await page.locator('#push-state').innerText(), 'Off on this device');
  assert.equal(log.watches.filter((w) => w && w.op === 'unsubscribe').length, 1);
  assert.equal(await page.locator('#push-test-btn').isDisabled(), true);

  assert.deepEqual(problems, [], 'no page or console errors');
  assert.deepEqual(log.missing, []);
});

test('notifications: blocked by the browser shows the state and how to allow it in Chrome site settings', { skip, timeout: 180000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, problems } = await newPhone(browser, origin, { blocked: true });
  await page.goto(origin + '/', { waitUntil: 'load' });
  await signIn(page);
  await openMenu(page);
  await page.locator('#push-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#push-state').innerText(), 'Blocked by the browser');
  const msg = page.locator('#push-msg');
  assert.equal(await msg.isVisible(), true);
  const text = await msg.innerText();
  assert.match(text, /Chrome is blocking notifications for 127\.0\.0\.1:\d+/);
  assert.match(text, /Site settings → Notifications/);
  assert.match(text, /Permissions → Notifications → Allow/);
  // Tapping the switch again still explains it, and stores nothing.
  await page.click('#push-btn');
  await page.waitForTimeout(200);
  assert.match(await msg.innerText(), /Site settings/);
  assert.equal(log.watches.filter((w) => w && w.op === 'subscribe').length, 0);
  assert.equal(await page.locator('#push-test-btn').isDisabled(), true);
  assert.deepEqual(problems, [], 'no page or console errors');
});
