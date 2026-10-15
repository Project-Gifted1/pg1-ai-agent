/**
 * The /usage card in a real browser (Chromium via Playwright), phone-sized,
 * in dark and light:
 *   - one card in six sections (period, calls and callers, revenue and
 *     402s, top tools, errors, storage), each a heading and two-column rows;
 *   - dates in Ireland time ("15 Oct 2026, 09:46", "9 Oct – 15 Oct 2026"),
 *     "Updated" with a relative hint; no ISO timestamp, UTC or raw JSON;
 *   - numbers with thousands separators, $0.00, one-decimal percentages;
 *   - storage as "used of limit" with a percentage and a bar;
 *   - long lists open with "Show N more"; nothing scrolls sideways.
 *
 * The reply is what api/chat.mjs sends for /usage, built with the same
 * modules (lib/usageStats.mjs, lib/chatTools.mjs, lib/usageCard.mjs) from
 * seeded telemetry, A2A jobs and storage figures; the page is served from
 * public/ as deployed. Writes docs/screenshots/usage-card-412-{dark,light}.png.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/usage-card.browser.test.mjs
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

const { aggregateUsage } = await import('../../lib/usageStats.mjs');
const { createToolExecutor, summarizeOutcome, USAGE_STATS_TOOL } = await import('../../lib/chatTools.mjs');
const { usageCardView, usageLead } = await import('../../lib/usageCard.mjs');
const { shapeStorageUsage } = await import('../../lib/storageUsage.mjs');
const { a2aJobsSummary } = await import('../../lib/a2aJobs/admin.mjs');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.css': 'text/css; charset=utf-8' };

// 15 Oct 2026, 09:46 in Ireland (IST, UTC+1).
const NOW = Date.UTC(2026, 9, 15, 8, 46, 0);
const H = (s) => s.repeat(32).slice(0, 32);

function seedTelemetry() {
  const rows = [];
  const at = (day, hour = 10) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
  const add = (day, caller, row, hour) => rows.push({ created_at: at(day, hour), is_fixture: false, endpoint: '/api/mcp', payment_type: 'none', status: 'ok', client_name: null, caller_hash: H(caller), ...row });
  const crawlers = [['1', 'glama'], ['2', 'mcpbeat'], ['3', 'AgentsJunction health checker'], ['4', 'agentrank-probe'], ['6', 'smithery-scan'], ['7', 'pulse-mcp']];
  for (let day = 9; day <= 15; day++) {
    const hour = day === 15 ? 7 : 10;
    for (const [c, name] of crawlers) {
      const n = day === 12 ? 140 : 30;
      for (let i = 0; i < n; i++) {
        add(day, c, { event_type: 'initialize', client_name: name }, hour);
        add(day, c, { event_type: 'mcp_request', mcp_method: 'tools/list' }, hour);
      }
    }
    add(day, 'a', { event_type: 'initialize', client_name: 'Claude Desktop' }, hour);
    for (let i = 0; i < 160; i++) add(day, 'a', { event_type: 'tool_call', tool_name: 'check_domain_age', payment_type: 'free' }, hour);
    for (let i = 0; i < 45; i++) add(day, 'a', { event_type: 'tool_call', tool_name: 'check_wallet_sanctions', payment_type: 'free' }, hour);
    add(day, 'b', { event_type: 'initialize', client_name: 'cursor' }, hour);
    for (let i = 0; i < 30; i++) add(day, 'b', { event_type: 'tool_call', tool_name: 'check_package', payment_type: 'free' }, hour);
    for (let i = 0; i < 4; i++) add(day, 'b', { event_type: 'tool_call', tool_name: 'get_cve_details', status: 'payment_required' }, hour);
    add(day, 'd', { event_type: 'tool_call', endpoint: '/api/a2a', tool_name: 'check_wallet_age', payment_type: 'free', status: day === 11 ? 'tool_error' : 'ok' }, hour);
    add(day, 'g', { event_type: 'tool_call', endpoint: '/api/ioc', tool_name: 'get_ioc_context', payment_type: 'free' }, hour);
  }
  for (const day of [13, 14, 15]) {
    add(day, 'e', { event_type: 'initialize', client_name: 'Cline' }, 7);
    for (let i = 0; i < 3; i++) {
      add(day, 'e', { event_type: 'tool_call', tool_name: 'get_cve_details', payment_type: 'x402' }, 7);
      add(day, 'e', { event_type: 'settlement', tool_name: 'get_cve_details', payment_type: 'x402', status: 'settled', amount_usd: 0.05 }, 7);
    }
  }
  add(14, 'b', { event_type: 'tool_call', tool_name: 'get_cve_details', status: 'invalid_input' }, 7);
  for (const name of ['get_weather', 'get_weather', 'search_cve', 'lookup']) add(15, 'f', { event_type: 'tool_call', tool_name: null, status: 'unknown_tool', requested_tool: name }, 7);
  return rows;
}

const JOBS = [
  ...Array.from({ length: 6 }, () => ({ job_type: 'batch_wallet_screen', status: 'completed', payment: 'x402', price_usd: 0.5, cost_usd: 0.04, credited_usd: 0 })),
  { job_type: 'batch_wallet_screen', status: 'failed', payment: 'x402', price_usd: 0.5, cost_usd: 0.01, credited_usd: 0.5 },
  ...Array.from({ length: 3 }, () => ({ job_type: 'cve_exposure_report', status: 'completed', payment: 'x402', price_usd: 2, cost_usd: 0.31, credited_usd: 0 })),
  { job_type: 'threat_writeup_pdf', status: 'completed', payment: 'free_tier', price_usd: 0, cost_usd: 0.02, credited_usd: 0 }
];

const STORAGE = shapeStorageUsage({ database_bytes: 187_400_000, buckets: [
  { name: 'pg1-media', bytes: 702_000_000, objects: 1284 }, { name: 'documents', bytes: 41_500_000, objects: 312 },
  { name: 'film-renders', bytes: 9_800_000, objects: 21 }, { name: 'music', bytes: 3_100_000, objects: 64 },
  { name: 'a2a', bytes: 640_000, objects: 18 }, { name: 'skills', bytes: 12_000, objects: 7 }, { name: 'voice', bytes: 900, objects: 2 }
] }, {});

async function usageResponse() {
  const stats = { ...aggregateUsage(seedTelemetry(), { period: '7d', now: NOW }), truncated: false, schema: 'current', generated_at: new Date(NOW).toISOString() };
  const outcome = await createToolExecutor({ role: 'operator', log: () => {}, record: () => {}, usageStats: async () => stats })({ id: 'usage', name: USAGE_STATS_TOOL, args: { period: '7d' } });
  const card = summarizeOutcome(outcome);
  card.usage = usageCardView(outcome.result, { now: NOW, jobs: { summary: a2aJobsSummary(JOBS) }, storage: STORAGE });
  return { reply: usageLead(outcome.result), toolResults: [card] };
}

async function startServer() {
  const usage = await usageResponse();
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
          if (parsed && parsed.prompt === '/usage') return json(200, usage);
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
  test(`usage card on a phone (${theme})`, { skip, timeout: 180000 }, async (t) => {
    const { server, origin } = await startServer();
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme });
    await routeReplyFont(context);
    await context.addInitScript((value) => { try { localStorage.setItem('pg1_theme', value); } catch (e) {} }, theme);
    const page = await context.newPage();
    // Two hours after the report was made, on this device's clock.
    await page.clock.setFixedTime(new Date(NOW + 2 * 3600 * 1000));
    const problems = [];
    page.on('pageerror', (err) => problems.push(String(err && err.message || err)));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.fill('#auth-user', 'operator');
    await page.fill('#auth-pass', 'passkey');
    await page.press('#auth-pass', 'Enter');
    await page.waitForSelector('#auth-modal', { state: 'hidden' });

    await page.fill('#prompt-input', '/usage');
    await page.click('.execute-btn');
    const card = page.locator('#chat-container .usage-card');
    await card.waitFor();
    const bubble = page.locator('#chat-container .message-bubble:not(.user):not(.welcome)').last();
    assert.match(await bubble.locator('.message-text').innerText(), /^Usage, last 7 days: 1,\d{3} real tool calls from about 5 distinct callers, \$0\.45 settled\. The full breakdown is in the card below\.$/);
    assert.equal(await bubble.locator('.tool-card').count(), 0, 'no generic tool card with fields or Raw JSON');

    // One card, six sections in order.
    assert.equal(await page.locator('#chat-container .usage-card').count(), 1);
    assert.deepEqual(await card.locator('.usage-h').allTextContents(), ['Period', 'Calls and callers', 'Revenue and 402s', 'Top tools', 'Errors', 'Storage']);
    const text = await card.innerText();
    const value = async (section, label) => {
      const r = card.locator(`.usage-sec[data-section="${section}"] .usage-row`).filter({ has: page.locator('.usage-label', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}`) }) }).first();
      return { value: (await r.locator('.usage-num').innerText()).trim(), sub: (await r.locator('.usage-row-sub').count()) ? (await r.locator('.usage-row-sub').innerText()).trim() : '' };
    };

    // Dates: Ireland time, one format; relative hint on Updated.
    assert.deepEqual(await value('period', 'Dates'), { value: '9 Oct – 15 Oct 2026', sub: '' });
    assert.deepEqual(await value('period', 'Updated'), { value: '15 Oct 2026, 09:46', sub: '2h ago' });
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}|UTC|Z\b|\.\d{3}\b|\{|\}|request_id|Raw JSON/, 'no ISO dates, UTC, milliseconds, JSON or debug text');

    // Numbers.
    assert.match((await value('calls', 'MCP requests')).value, /^\d{1,3}(,\d{3})+$/, 'thousands separators');
    assert.deepEqual(await value('revenue', 'Settled revenue'), { value: '$0.45', sub: '9 payments' });
    assert.match((await value('revenue', 'Paid after a 402')).value, /^\d+\.\d%$/);
    assert.equal((await value('errors', 'Rate limited')).value, '0');
    assert.match((await value('tools', 'check_domain_age')).sub, /^free · \d+\.\d% of real calls$/);
    assert.deepEqual(await value('revenue', 'Batch wallet screen'), { value: '$3.50', sub: '7 jobs · 85.7% success · margin $2.75' });
    assert.equal((await value('revenue', 'CVE exposure report')).value, '$6.00');
    assert.deepEqual(await value('period', 'Window'), { value: 'Last 7 days', sub: '' });

    // Storage: used of limit, percentage and bar.
    assert.deepEqual(await value('storage', 'Database'), { value: '178.7 MB', sub: 'of 500.0 MB · 35.7%' });
    assert.deepEqual(await value('storage', 'File storage'), { value: '722.0 MB', sub: 'of 1.0 GB · 70.5%' });
    const bars = card.locator('.usage-sec[data-section="storage"] .usage-bar > span');
    assert.equal(await bars.count(), 2);
    assert.equal(await bars.nth(1).evaluate((el) => el.style.width), '70.5%');

    // Long lists: five rows, then "Show N more".
    const more = card.locator('.usage-sec[data-section="storage"] .usage-more');
    assert.equal(await more.innerText(), 'Show 2 more');
    assert.equal(await card.locator('.usage-sec[data-section="storage"] .usage-rows[hidden]').count(), 1);
    await more.click();
    assert.equal(await more.innerText(), 'Show less');
    assert.equal(await card.locator('.usage-sec[data-section="storage"] .usage-rows[hidden]').count(), 0);
    assert.equal((await value('storage', 'voice')).value, '900 B');
    await more.click();

    // Fits the phone: no sideways scroll on the page or inside the card,
    // and every row's figure sits inside the card.
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    const fit = await card.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const out = [...el.querySelectorAll('.usage-num, .usage-label, .usage-row-sub')].filter((n) => { const b = n.getBoundingClientRect(); if (!b.width) return false; return b.right > box.right + 0.5 || b.left < box.left - 0.5; });
      return { scroll: el.scrollWidth > el.clientWidth, out: out.map((n) => n.textContent) };
    });
    assert.deepEqual(fit, { scroll: false, out: [] });
    // One hairline between sections, none doubled.
    const borders = await card.locator('.usage-sec').evaluateAll((els) => els.map((e) => getComputedStyle(e).borderTopWidth));
    assert.deepEqual(borders, ['0px', '1px', '1px', '1px', '1px', '1px']);
    // The theme's own colours.
    const colors = await card.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, num: getComputedStyle(el.querySelector('.usage-num')).color }));
    if (theme === 'dark') assert.equal(colors.num, 'rgb(255, 255, 255)');
    else assert.equal(colors.num, 'rgb(0, 0, 0)');

    // Motion: the card rises in, sections follow, bars fill; all of it
    // settles (nothing left running) before the screenshot.
    const names = await card.evaluate((el) => [...new Set(el.getAnimations({ subtree: true }).map((a) => a.animationName))].sort());
    for (const n of ['meter-fill', 'rise-in', 'usage-sec-in']) assert.ok(names.includes(n), `${n} runs`);
    await card.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    assert.equal(await card.evaluate((el) => getComputedStyle(el.querySelector('.usage-sec:last-of-type')).opacity), '1');

    // Screenshot: the whole card at phone width.
    mkdirSync(SHOTS_DIR, { recursive: true });
    const box = await bubble.boundingBox();
    await page.setViewportSize({ width: 412, height: Math.min(4000, Math.ceil(box.height + 260)) });
    await bubble.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS_DIR, `usage-card-412-${theme}.png`) });

    assert.deepEqual(problems, [], 'no page or console errors');
  });
}

test('reduced motion: the usage card and lab replies do not animate', { skip, timeout: 180000 }, async (t) => {
  const { server, origin } = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await routeReplyFont(context);
  const page = await context.newPage();
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  await page.fill('#prompt-input', '/usage');
  await page.click('.execute-btn');
  const card = page.locator('#chat-container .usage-card');
  await card.waitFor();
  assert.deepEqual(await card.evaluate((el) => el.getAnimations({ subtree: true }).map((a) => a.animationName)), []);
  const lab = await page.evaluate(() => { const d = document.createElement('div'); d.innerHTML = formatMarkdown('### [ LAB ]\n- e2981021 · code · running · $0.42 of $2.00 · compare feeds'); document.body.append(d); return d.getAnimations({ subtree: true }).length; });
  assert.equal(lab, 0);
});

const LAB_STATUS = [
  '### [ LAB ]',
  '- e2981021 · code · running · $0.42 of $2.00 · compare two CVE feeds for coverage',
  '- 7c1d22aa · research · queued · $0.00 of $1.00 · wallet screening sources',
  '- 3b9f0e11 · skill · done · $0.88 of $1.00 · draft a phishing triage skill · gate passed',
  '- 91aa0c4d · code · over_budget · $2.00 of $2.00 · rewrite the feed parser',
  '- 5e6f7a8b · research · stopped · $0.10 of $1.00 · hostname reputation',
  '',
  'Use `/lab report e2981021` for one.'
].join('\n');

for (const theme of ['dark', 'light']) {
  test(`lab replies: status chips (pulsing while active) and budget meters (${theme})`, { skip, timeout: 180000 }, async (t) => {
    const { server, origin } = await startServer();
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme });
    await routeReplyFont(context);
    await context.addInitScript((value) => { try { localStorage.setItem('pg1_theme', value); } catch (e) {} }, theme);
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (err) => problems.push(String(err && err.message || err)));
    await page.route('**/api/chat', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.prompt === 'AUTH_VERIFY') return route.fulfill({ json: { authenticated: true } });
      return route.fulfill({ json: { reply: body.prompt === '/lab status' ? LAB_STATUS : 'ok' } });
    });
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.fill('#auth-user', 'operator');
    await page.fill('#auth-pass', 'passkey');
    await page.press('#auth-pass', 'Enter');
    await page.waitForSelector('#auth-modal', { state: 'hidden' });
    await page.fill('#prompt-input', '/lab status');
    await page.click('.execute-btn');
    const chips = page.locator('#chat-container .lab-state');
    await chips.first().waitFor();
    assert.deepEqual(await chips.evaluateAll((els) => els.map((e) => [e.dataset.state, e.textContent])), [['running', 'running'], ['queued', 'queued'], ['done', 'done'], ['over_budget', 'over budget'], ['stopped', 'stopped']]);
    const pulse = await chips.evaluateAll((els) => els.map((e) => getComputedStyle(e, '::before').animationName));
    assert.deepEqual(pulse, ['lab-pulse', 'lab-pulse', 'none', 'none', 'none'], 'only running and queued pulse');
    const meters = page.locator('#chat-container .lab-meter-bar > span');
    assert.deepEqual(await meters.evaluateAll((els) => els.map((e) => e.style.width)), ['21%', '0%', '88%', '100%', '10%']);
    assert.equal(await page.locator('#chat-container .lab-meter-bar.is-high').count(), 1, 'a spent budget is marked');
    const text = await page.locator('#chat-container .message-bubble:not(.user):not(.welcome)').last().locator('.message-text').innerText();
    assert.match(text, /\$0\.42 of \$2\.00/, 'the figures stay as text');
    assert.equal(await page.locator('#chat-container .cmd-chip[data-command="/lab report e2981021"]').count(), 1, 'commands still become buttons');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    await page.waitForTimeout(1300);
    const bubble = page.locator('#chat-container .message-bubble:not(.user):not(.welcome)').last();
    await bubble.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(150);
    await bubble.screenshot({ path: join(SHOTS_DIR, `lab-status-412-${theme}.png`), animations: 'disabled' });
    assert.deepEqual(problems, []);
  });
}
