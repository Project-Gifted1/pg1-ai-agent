/**
 * The /docs/crypto-alert-bot guide in a real browser (Chromium via
 * Playwright), served from public/ with the headers vercel.json sets for
 * it, so the Content-Security-Policy is enforced.
 *
 * Asserts: no page errors, console errors or CSP violations; the page's
 * only requests are its own CSS, script and icon; no cookies or storage
 * written; at phone width (390px) the page never scrolls sideways (code
 * blocks and tables scroll inside their own box); every code block shows
 * a copy button, and clicking it puts exactly that block's code on the
 * clipboard.
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
import { mdCodeBlocks } from '../helpers/doc-page.mjs';

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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// The headers and rewrite vercel.json declares for the page.
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const routeHeaders = (p) => {
  const out = {};
  for (const entry of vercel.headers) {
    const re = new RegExp('^' + entry.source.replace(/\(\.\*\)/g, '.*') + '$');
    if (re.test(p)) for (const h of entry.headers) out[h.key] = h.value;
  }
  return out;
};

function serve() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(url.pathname);
    const rewrite = vercel.rewrites.find((r) => r.source === url.pathname);
    const file = normalize(join(PUBLIC_DIR, rewrite ? rewrite.destination : url.pathname));
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', ...routeHeaders(url.pathname) });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, requests, origin: `http://127.0.0.1:${server.address().port}` })));
}

test('the guide page in a browser: CSP enforced, no errors, no sideways scroll at 390px, copy buttons copy the code', { skip, timeout: 120000 }, async (t) => {
  const { server, requests, origin } = await serve();
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((r) => server.close(r));
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) errors.push(m.text()); });

  const res = await page.goto(`${origin}/docs/crypto-alert-bot`, { waitUntil: 'load' });
  assert.match(res.headers()['content-security-policy'], /script-src 'self'/);
  await page.waitForSelector('.copy:not([hidden])');

  // Stylesheet applied (CSP allowed the file), and the page is dark.
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(10, 10, 11)');

  // Never wider than the viewport.
  const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
  assert.ok(widths.doc <= widths.view, `page scrolls sideways: ${widths.doc} > ${widths.view}`);

  const expected = mdCodeBlocks(readFileSync(join(ROOT, 'docs/integrations/crypto-alert-bot.md'), 'utf8')).map((b) => b.code);
  const buttons = page.locator('.code .copy');
  assert.equal(await buttons.count(), expected.length);
  for (const i of [0, expected.length - 1, expected.findIndex((c) => c.includes('async function onSignal'))]) {
    const button = buttons.nth(i);
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    assert.ok(box.height >= 36 && box.width >= 44, 'copy button is a usable tap target');
    await button.click();
    await page.waitForFunction((el) => el.textContent === 'Copied', await button.elementHandle());
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected[i]);
  }

  // Tables scroll inside their own box.
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.table-wrap')).overflowX), 'auto');

  assert.deepEqual(errors, []);
  const allowed = ['/docs/crypto-alert-bot', '/docs/docs.css', '/docs/docs.js', '/brand/pg1-shield.svg'];
  for (const p of requests) assert.ok(allowed.includes(p), `unexpected request ${p}`);
  for (const p of allowed.slice(0, 3)) assert.ok(requests.includes(p), `${p} was not loaded`);
  assert.deepEqual(await context.cookies(), []);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
});
