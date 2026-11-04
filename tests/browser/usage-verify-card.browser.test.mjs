/**
 * The /usage verify card in a real browser (Chromium via Playwright),
 * phone-sized, in dark and light:
 *   - the verdict line first in the reply ("Does not match: ..."), then one
 *     card: Verdict, Telemetry vs server, Revenue vs chain, Licence revenue
 *   - a flagged day reads "telemetry may be dropping rows"
 *   - each on-chain transfer links to its transaction on the Base
 *     explorer; any other href is not drawn as a link
 *   - no "safe" wording, nothing scrolls sideways
 *
 * The reply is what api/chat.mjs sends for /usage verify, built with
 * lib/usageVerify.mjs from seeded telemetry, server counts and chain
 * transfers. Writes docs/screenshots/usage-verify-card-412-{dark,light}.png.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/usage-verify-card.browser.test.mjs
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

const { verifyUsage, verifyLead, verifyCardView, verifyContextLines } = await import('../../lib/usageVerify.mjs');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.css': 'text/css; charset=utf-8' };

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const PAY_TO = '0x' + 'ab'.repeat(20);
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const at = (day, hour = 10, min = 0) => new Date(Date.UTC(2026, 9, 29 + day, hour, min)).toISOString();
const DAYS = ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'];

async function verifyResponse() {
  const tele = [80, 76, 60, 81, 79, 85, 40];
  const server = [80, 76, 81, 81, 79, 85, 40];
  const requestRows = tele.flatMap((n, d) => Array.from({ length: n }, (_, i) => ({ created_at: at(d, 9, i % 60), event_type: 'tool_call', endpoint: '/api/mcp' })));
  const settled = [{ created_at: at(1, 14), endpoint: '/api/mcp', tool_name: 'get_cve_details', amount_usd: 0.01 }, { created_at: at(2, 10), endpoint: '/api/mcp', tool_name: 'get_cve_details', amount_usd: 0.01 }];
  const transfers = [{ at: at(1, 14, 1), usd: 0.01, block: 900, hash: hash(1) }, { at: at(4, 16), usd: 2, block: 950, hash: hash(3) }];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/agent_telemetry')) {
      const offset = Number(String((opts.headers && opts.headers.Range) || '0-').split('-')[0]);
      return Response.json((u.includes('event_type=eq.settlement') ? settled : requestRows).slice(offset, offset + 1000));
    }
    if (u.includes('/rest/v1/pg1_errors')) return Response.json([{ reason: 'telemetry_insert_failed', count: 2, first_seen: at(2, 8), last_seen: at(2, 9) }]);
    if (u.includes('/v2/observability/query')) return Response.json({ data: server.map((n, d) => ({ timestamp: `${DAYS[d]}T00:00:00.000Z`, request_path: '/api/mcp', request_method: 'POST', vercel_request_count_sum: n })) });
    if (u.includes('alchemy.com')) {
      const req = JSON.parse(opts.body);
      if (req.method === 'eth_getBlockByNumber') return Response.json({ result: { number: '0x3e8' } });
      return Response.json({ result: { transfers: transfers.slice().reverse().map((t) => ({ blockNum: '0x' + t.block.toString(16), hash: t.hash, rawContract: { value: '0x' + Math.round(t.usd * 1e6).toString(16), address: USDC.toLowerCase() }, metadata: { blockTimestamp: t.at } })) } });
    }
    throw new Error(`unexpected ${u}`);
  };
  const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k', VERCEL_TOKEN: 't', VERCEL_TEAM_ID: 'team_X1', PG1_VERCEL_PROJECT_ID: 'prj_X1', X402_PAY_TO_ADDRESS: PAY_TO, ALCHEMY_API_KEY: 'a' };
  const r = await verifyUsage({ env, now: NOW, fetchImpl });
  const view = verifyCardView(r);
  // A row whose href is not a transaction page is never drawn as a link.
  view.sections[0].groups[0].rows.push({ label: 'Probe', value: 'not a link', href: 'javascript:alert(1)' });
  const card = { id: 'usage-verify', tool: 'usage_verify', title: 'Usage verify', status: 'report', status_label: 'Report', fields: [], reasons: [], checks: [], usage: view };
  return { reply: verifyLead(r), toolResults: [card], cards: verifyContextLines(r) };
}

async function startServer() {
  const verify = await verifyResponse();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      const json = (status, b) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: true });
          if (parsed && parsed.prompt === '/usage verify') return json(200, verify);
          return json(200, { reply: 'ok' });
        }
        if (url.pathname === '/api/watches') return json(200, { ok: true, reports: [] });
        if (url.pathname === '/api/errors') return json(200, { errors: [], ok: true });
        if (url.pathname === '/api/handoffs') return json(200, { handoffs: [] });
        if (url.pathname === '/api/threads') return json(200, { threads: [] });
        return json(200, { status: 'ok' });
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = normalize(join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      const data = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
      res.end(data);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

for (const theme of ['dark', 'light']) {
  test(`usage verify card on a phone (${theme})`, { skip, timeout: 180000 }, async (t) => {
    const { server, origin } = await startServer();
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme });
    await routeReplyFont(context);
    await context.addInitScript((value) => { try { localStorage.setItem('pg1_theme', value); } catch (e) {} }, theme);
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (err) => problems.push(String(err && err.message || err)));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.fill('#auth-user', 'operator');
    await page.fill('#auth-pass', 'passkey');
    await page.press('#auth-pass', 'Enter');
    await page.waitForSelector('#auth-modal', { state: 'hidden' });

    await page.fill('#prompt-input', '/usage verify');
    await page.click('.execute-btn');
    const card = page.locator('#chat-container .usage-card');
    await card.waitFor();
    const bubble = page.locator('#chat-container .message-bubble:not(.user):not(.welcome)').last();
    const text = await bubble.locator('.message-text').innerText();
    assert.match(text, /^Does not match: Traffic: telemetry and server counts differ by more than 5% on 31 Oct/);
    assert.match(text, /Traffic, last 7 days: telemetry 501, server 522 \(gap 4\.0%\)/);
    assert.match(text, /Read-only: nothing was paid or spent\./);
    assert.doesNotMatch(text + await card.innerText(), /\bsafe\b/i);

    assert.deepEqual(await card.locator('.usage-h').allTextContents(), ['Verdict', 'Telemetry vs server', 'Revenue vs chain (USDC on Base)', 'Licence revenue']);
    const flagged = card.locator('.usage-sec[data-section="traffic"] .usage-row').filter({ hasText: '31 Oct' });
    assert.equal((await flagged.locator('.usage-num').innerText()).trim(), '60 / 81');
    assert.match(await flagged.locator('.usage-row-sub').innerText(), /telemetry may be dropping rows/);

    // Transactions link to the explorer; nothing else is a link.
    const links = card.locator('a.usage-link');
    assert.equal(await links.count(), 2);
    assert.deepEqual((await links.evaluateAll((els) => els.map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]))).sort(), [
      [`https://basescan.org/tx/${hash(1)}`, '_blank', 'noopener noreferrer'],
      [`https://basescan.org/tx/${hash(3)}`, '_blank', 'noopener noreferrer']
    ]);
    assert.equal(await card.locator('a[href^="javascript"]').count(), 0);
    const unmatched = card.locator('.usage-sec[data-section="revenue"] .usage-row').filter({ hasText: '2.00 USD' });
    assert.match(await unmatched.locator('.usage-row-sub').innerText(), /no settled row/);

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    const fit = await card.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const out = [...el.querySelectorAll('.usage-num, .usage-label, .usage-row-sub')].filter((n) => { const b = n.getBoundingClientRect(); if (!b.width) return false; return b.right > box.right + 0.5 || b.left < box.left - 0.5; });
      return { scroll: el.scrollWidth > el.clientWidth, out: out.map((n) => n.textContent) };
    });
    assert.deepEqual(fit, { scroll: false, out: [] });

    await card.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    mkdirSync(SHOTS_DIR, { recursive: true });
    const box = await bubble.boundingBox();
    await page.setViewportSize({ width: 412, height: Math.min(5000, Math.ceil(box.height + 260)) });
    await bubble.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS_DIR, `usage-verify-card-412-${theme}.png`) });
    assert.deepEqual(problems, [], 'no page or console errors');
  });
}
