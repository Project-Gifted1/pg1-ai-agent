/**
 * /keys and /pricing (1.23.0) in a real browser (Chromium via Playwright) at
 * phone width (360x800). Pages are served from public/ with the headers
 * vercel.json sets, so the Content-Security-Policy is enforced; /api/keys/*
 * go to the real handlers (lib/keysApi.mjs) with an in-memory key store.
 *
 * Asserts: /keys refuses without the consent box; with it, the key appears
 * once in the secret-once dialog (partly hidden, Copy and Close), never in
 * the page itself, and closing removes it; the same email again is refused;
 * rotating shows a new key and the old one stops working; deleting by email
 * clears the email's key; /pricing shows every tier and links to /keys;
 * neither page says "safe"; no sideways scroll at 360 px; no page errors,
 * console errors or CSP violations.
 *
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: npm run test:browser   (or: node --test tests/browser/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeysHandler, __resetKeyLimitsForTests } from '../../lib/keysApi.mjs';
import { createMemoryKeyStore, hashApiKey } from '../../lib/apiKeys.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');

let chromium = null;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  skip = 'playwright is not installed (npm install)';
}
// A Chromium at the pinned Playwright's own path, or else a preinstalled one
// (PG1_CHROMIUM_PATH, or /opt/pw-browsers/chromium in cloud sessions).
let executablePath;
if (chromium && !existsSync(chromium.executablePath())) {
  const fallback = [process.env.PG1_CHROMIUM_PATH, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));
  if (fallback) executablePath = fallback;
  else skip = `Chromium is not installed at ${chromium.executablePath()} (npx playwright install chromium)`;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const routeHeaders = (p) => {
  const out = {};
  for (const entry of vercel.headers) {
    const re = new RegExp('^' + entry.source.replace(/\(\.\*\)/g, '.*') + '$');
    if (re.test(p)) for (const h of entry.headers) out[h.key] = h.value;
  }
  return out;
};

function serve(store) {
  const handlers = Object.fromEntries(['signup', 'rotate', 'delete', 'team'].map((a) => [a, createKeysHandler(a, { store, env: {} })]));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const m = url.pathname.match(/^\/api\/keys\/(signup|rotate|delete|team)$/);
    if (m) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const shim = {
          statusCode: 200,
          headers: {},
          setHeader(k, v) { this.headers[k] = v; },
          status(c) { this.statusCode = c; return this; },
          json(body) { res.writeHead(this.statusCode, { ...this.headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return this; },
          end() { res.writeHead(this.statusCode, this.headers); res.end(); return this; }
        };
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
        handlers[m[1]]({ method: req.method, headers: { ...req.headers, 'x-forwarded-for': '203.0.113.9' }, body, query: Object.fromEntries(url.searchParams) }, shim);
      });
      return;
    }
    const rewrite = vercel.rewrites.find((r) => r.source === url.pathname);
    const file = normalize(join(PUBLIC_DIR, rewrite ? rewrite.destination : url.pathname));
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', ...routeHeaders(url.pathname) });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function newPhonePage(browser, problems) {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  return { context, page };
}

test('/keys and /pricing at phone width, in a real browser', { skip, timeout: 120000 }, async () => {
  const prevSalt = process.env.TELEMETRY_IP_SALT;
  process.env.TELEMETRY_IP_SALT = 'keys-browser-salt';
  __resetKeyLimitsForTests();
  const store = createMemoryKeyStore();
  const server = await serve(store);
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser = null;
  const problems = [];
  try {
    browser = await chromium.launch(executablePath ? { executablePath } : {});
    const { page } = await newPhonePage(browser, problems);
    await page.goto(`${base}/keys`);
    assert.match(await page.title(), /Free PG1 API key/);
    assert.ok(await page.isVisible('#privacy'));
    assert.equal(await page.isChecked('#marketing'), false, 'product news is not pre-ticked');

    // Without consent: refused, nothing created.
    await page.fill('#email', 'phone@example.com');
    await page.click('#signup-btn');
    await page.waitForFunction(() => /Tick the first box/.test(document.getElementById('signup-status').textContent));
    assert.equal(store.keys.length, 0);

    // With consent: the key in the secret-once dialog, never in the page.
    await page.check('#consent');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/keys/signup') && r.request().method() === 'POST');
    await page.click('#signup-btn');
    const key = (await (await created).json()).key;
    await page.waitForSelector('dialog.secret-once[open]');
    const mask = await page.textContent('.secret-once-mask');
    assert.ok(mask.startsWith(key.slice(0, 8)) && !mask.includes(key.slice(8)), 'only the first 8 characters are shown');
    assert.ok(!(await page.content()).includes(key), 'the full key is never in the page');
    assert.match(await page.textContent('#signup-status'), /shown once/);
    assert.equal(store.keys[0].key_hash, hashApiKey(key));
    const dlgBox = await page.locator('dialog.secret-once').boundingBox();
    assert.ok(dlgBox.width <= 360, 'the dialog fits the phone');
    await page.click('.secret-once [data-act="close"]');
    assert.equal(await page.locator('dialog.secret-once').count(), 0, 'closing removes the dialog');

    // The same email again: refused with a plain message.
    await page.fill('#email', 'phone@example.com');
    await page.check('#consent');
    await page.click('#signup-btn');
    await page.waitForFunction(() => /already has a free key/.test(document.getElementById('signup-status').textContent));

    // Rotate: a new key in the dialog, the old one revoked.
    await page.fill('#rotate-key', key);
    const rotated = page.waitForResponse((r) => r.url().endsWith('/api/keys/rotate'));
    await page.click('#rotate-form button[type="submit"]');
    const newKey = (await (await rotated).json()).key;
    await page.waitForSelector('dialog.secret-once[open]');
    assert.notEqual(newKey, key);
    assert.equal(await store.findActiveKey(hashApiKey(key)), null);
    await page.click('.secret-once [data-act="close"]');

    // Delete by email.
    await page.fill('#delete-value', 'phone@example.com');
    await page.click('#delete-form button[type="submit"]');
    await page.waitForFunction(() => /deleted/.test(document.getElementById('delete-status').textContent));
    assert.equal(store.keys.length, 0);

    const keysText = await page.textContent('body');
    assert.doesNotMatch(keysText.replace(/never “safe”/g, ''), /\bsafe\b/i);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 360, 'no sideways scroll on /keys');

    // /pricing.
    await page.goto(`${base}/pricing`);
    for (const id of ['plan-anonymous', 'plan-free', 'plan-builder', 'plan-team', 'plan-partner', 'plan-pay-per-check']) assert.ok(await page.isVisible(`#${id}`), id);
    const pricing = await page.textContent('main');
    for (const s of ['25 checks a day', '500 checks a day', '10,000 checks a month', '100,000 checks a month', '0.002 USD', 'no_findings']) assert.ok(pricing.includes(s), s);
    assert.doesNotMatch(pricing.replace(/never “safe”/g, ''), /\bsafe\b/i);
    assert.equal(await page.getAttribute('#plan-free a.cta', 'href'), '/keys');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 360, 'no sideways scroll on /pricing');
    await page.click('#plan-free a.cta');
    await page.waitForURL(/\/keys$/);

    // The one expected failed request: the duplicate-email signup (409).
    assert.deepEqual(problems.filter((p) => !/status of 409 \(Conflict\)/.test(p)), []);
    assert.equal(problems.length, 1);
  } finally {
    if (browser) await browser.close();
    server.close();
    if (prevSalt === undefined) delete process.env.TELEMETRY_IP_SALT; else process.env.TELEMETRY_IP_SALT = prevSalt;
  }
});
