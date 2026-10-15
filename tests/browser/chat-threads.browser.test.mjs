/**
 * The new reply style, the /usage report and saved chats in a real browser
 * (Chromium via Playwright), light and dark, at phone width.
 *
 * The page is served from public/ as deployed. /api/chat is a stub that
 * answers with fixed replies; the /usage reply and its card are built by
 * lib/usageStats.mjs + lib/chatTools.mjs from seeded telemetry, so what is
 * drawn is what the server sends. /api/threads is the real handler
 * (api/threads.mjs) running against a real Postgres (PGlite) with the
 * migration applied.
 *
 * Asserts: replies use the serif at 17-18px with line-height 1.55, inline
 * code is a mono chip (radius 6px, 1px border), headings are the serif at
 * weight 600, the footnote is small muted sans, wide tables scroll inside
 * their panel and the page never scrolls sideways; the operator's own
 * messages and the app chrome keep the sans. Saved chats: the sheet starts
 * with "No saved chats yet" (no placeholders), save makes a thread titled
 * from the first message with a "Saved" toast and a pressed save button,
 * later messages update it automatically, rename, load restores the
 * conversation and continues it, delete asks first, and a guest cannot
 * save. Writes docs/screenshots/usage-report-412-*.png,
 * reply-style-412-*.png and threads-sheet-412-*.png for the PR.
 *
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { makeThreadsDb, threadsRest } from '../helpers/threadsDb.mjs';

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
if (chromium && !existsSync(chromium.executablePath())) {
  skip = `Chromium is not installed at ${chromium.executablePath()} (npx playwright install chromium)`;
}

process.env.USER_API_KEY = 'operator';
process.env.USER_API_PASS = 'passkey';
process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
const { default: threadsHandler, __clearThreadsRateLimitState } = await import('../../api/threads.mjs');
const { aggregateUsage } = await import('../../lib/usageStats.mjs');
const { createToolExecutor, summarizeOutcome, usageReport, USAGE_STATS_TOOL } = await import('../../lib/chatTools.mjs');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8'
};

// --- the /usage reply, from seeded telemetry -------------------------------------

const NOW = Date.UTC(2026, 9, 13, 15, 0, 0);
const H = (s) => (s.repeat(32)).slice(0, 32);
function seedTelemetry() {
  const rows = [];
  const at = (day, hour = 10) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
  const add = (day, caller, row) => rows.push({ created_at: at(day), is_fixture: false, endpoint: '/api/mcp', payment_type: 'none', status: 'ok', client_name: null, caller_hash: H(caller), ...row });
  const crawlers = [['1', 'glama'], ['2', 'mcpbeat'], ['3', 'AgentsJunction health checker'], ['4', 'agentrank-probe']];
  for (let day = 7; day <= 13; day++) {
    for (const [c, name] of crawlers) {
      const n = day === 10 ? 14 : 3;
      for (let i = 0; i < n; i++) {
        add(day, c, { event_type: 'initialize', client_name: name });
        add(day, c, { event_type: 'mcp_request', mcp_method: 'tools/list' });
      }
    }
    add(day, '5', { event_type: 'tool_call', tool_name: 'get_usage_status', payment_type: 'free' });
    add(day, 'a', { event_type: 'initialize', client_name: 'Claude Desktop' });
    add(day, 'a', { event_type: 'mcp_request', mcp_method: 'tools/list' });
    for (let i = 0; i < 3; i++) add(day, 'a', { event_type: 'tool_call', tool_name: 'check_domain_age', payment_type: 'free' });
    add(day, 'a', { event_type: 'tool_call', tool_name: 'check_wallet_sanctions', payment_type: 'free' });
    add(day, 'b', { event_type: 'initialize', client_name: 'cursor' });
    add(day, 'b', { event_type: 'tool_call', tool_name: 'check_package', payment_type: 'free' });
    if (day % 2) add(day, 'b', { event_type: 'tool_call', tool_name: 'get_cve_details', status: 'payment_required' });
    add(day, 'd', { event_type: 'tool_call', endpoint: '/api/a2a', tool_name: 'check_wallet_age', payment_type: 'free', status: day === 9 ? 'tool_error' : 'ok' });
  }
  add(11, 'b', { event_type: 'tool_call', tool_name: 'get_cve_details', payment_type: 'free_tier' });
  add(12, 'b', { event_type: 'tool_call', tool_name: 'get_cve_details', status: 'free_limit_reached' });
  for (const day of [12, 13]) {
    add(day, 'e', { event_type: 'initialize', client_name: 'Cline' });
    add(day, 'e', { event_type: 'tool_call', tool_name: 'get_cve_details', payment_type: 'x402' });
    add(day, 'e', { event_type: 'settlement', tool_name: 'get_cve_details', payment_type: 'x402', status: 'settled', amount_usd: 0.01 });
  }
  for (const name of ['get_weather', 'get_weather', 'search_cve', 'lookup']) add(13, 'f', { event_type: 'tool_call', tool_name: null, status: 'unknown_tool', requested_tool: name });
  return rows;
}

async function usageReply() {
  const stats = { ...aggregateUsage(seedTelemetry(), { period: '7d', now: NOW }), truncated: false, schema: 'current', generated_at: new Date(NOW).toISOString() };
  const outcome = await createToolExecutor({ role: 'operator', log: () => {}, record: () => {}, usageStats: async () => stats })({ id: 'usage', name: USAGE_STATS_TOOL, args: { period: '7d' } });
  return { reply: usageReport(outcome), toolResults: [summarizeOutcome(outcome)] };
}

const STYLE_REPLY = [
  '## Domain check',
  'Nothing was flagged for `pg1-test-clean.invalid`, which is not the same as safe. It was registered on 2000-01-01, well past the 30-day window.',
  '',
  '### What ran',
  '- `check_domain_age`: no flags',
  '- `check_hostname_reputation`: not listed',
  '',
  '| Check | Status | Source | Registered | Age (days) | Lookalike | Request id |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| check_domain_age | no_flags | domain registration records | 2000-01-01 | 9782 | none | 5f1c2b7e-0a7d-4e5b-9a51-3c1b8f0e2d44 |',
  '| check_hostname_reputation | no_flags | phishing domain list | - | - | none | 0c9a1f3b-77de-41aa-8e2e-6b0b9d5c1e10 |',
  '',
  '```bash',
  'curl -s https://pg1-ai-agent.vercel.app/api/mcp -d \'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\'',
  '```',
  '',
  '[^note]: Both results are test fixtures, so no upstream source was called.'
].join('\n');

// --- the server -------------------------------------------------------------------

async function startServer() {
  const db = await makeThreadsDb();
  const restCalls = [];
  globalThis.fetch = threadsRest(db, restCalls);
  __clearThreadsRateLimitState();
  const usage = await usageReply();
  const log = { requests: [], missing: [] };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      log.requests.push({ method: req.method, path: url.pathname, body: parsed });
      if (url.pathname === '/api/threads') {
        res.status = (c) => { res.statusCode = c; return res; };
        res.json = (b) => { if (!res.headersSent) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); return res; };
        return threadsHandler({ method: req.method, headers: req.headers, socket: { remoteAddress: '127.0.0.1' }, body: parsed }, res);
      }
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
        if (url.pathname === '/api/errors') return json(res, 200, { errors: [], ok: true });
        if (url.pathname === '/api/handoffs') return json(res, 200, { handoffs: [] });
        if (url.pathname === '/api/watches') return json(res, 200, { ok: true, reports: [] });
        if (url.pathname === '/api/chat') {
          const prompt = parsed && parsed.prompt;
          if (prompt === 'AUTH_VERIFY') return json(res, 200, { authenticated: parsed.user === 'operator' && parsed.pass === 'passkey' });
          if (prompt === '/usage') return json(res, 200, usage);
          if (/style/i.test(prompt || '')) return json(res, 200, { reply: STYLE_REPLY });
          return json(res, 200, { reply: `Noted: ${prompt}. There ${parsed.history ? `are ${parsed.history.length}` : 'are no'} earlier messages in this chat.` });
        }
        log.missing.push(url.pathname);
        return json(res, 404, { error: 'not stubbed' });
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = normalize(join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
        log.missing.push(url.pathname);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
      const data = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
      res.end(data);
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer({ server, log, db, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function openPage(browser, origin, theme) {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme });
  await routeReplyFont(context);
  await context.addInitScript((value) => { try { localStorage.setItem('pg1_theme', value); } catch (e) {} }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err && err.message || err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto(origin + '/', { waitUntil: 'load' });
  return { context, page, errors };
}

async function signIn(page) {
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
}

async function send(page, prompt) {
  const before = await page.locator('#chat-container .message-bubble:not(.user):not(.welcome)').count();
  await page.fill('#prompt-input', prompt);
  await page.click('.execute-btn');
  await page.waitForFunction((n) => {
    const bubbles = document.querySelectorAll('#chat-container .message-bubble:not(.user):not(.welcome)');
    const last = bubbles[bubbles.length - 1];
    return bubbles.length > n && last && !last.classList.contains('pending');
  }, before, { timeout: 30000 });
  return page.locator('#chat-container .message-bubble:not(.user):not(.welcome)').last();
}

const px = (v) => Number.parseFloat(v);

async function shoot(page, locator, file) {
  const box = await locator.boundingBox();
  await page.setViewportSize({ width: 412, height: Math.min(4000, Math.ceil(box.height + 260)) });
  await locator.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS_DIR, file) });
  await page.setViewportSize({ width: 412, height: 915 });
}

for (const theme of ['dark', 'light']) {
  test(`reply style and the /usage report in the browser (${theme})`, { skip, timeout: 180000 }, async (t) => {
    const { server, log, origin } = await startServer();
    const browser = await chromium.launch();
    t.after(async () => {
      await browser.close();
      await new Promise((r) => server.close(r));
    });
    const { page, errors } = await openPage(browser, origin, theme);
    await signIn(page);
    mkdirSync(SHOTS_DIR, { recursive: true });

    const report = await send(page, '/usage');
    const text = report.locator('.message-text').first();
    assert.equal(await text.locator('.md-h2').first().textContent(), 'Usage · the last 7 days');
    const headings = await text.locator('.md-h3').allTextContents();
    assert.deepEqual(headings, ['Summary', 'Traffic', 'Tools', 'Payments', 'Errors', 'Clients']);
    const body = await text.textContent();
    assert.match(body, /MCP requests: \d+ \(real \d+, probe \d+\)/);
    assert.match(body, /Tool calls: \d+ \(real \d+, probe \d+\)/);
    assert.match(body, /\(spike\)/);
    assert.equal(await text.locator('.md-foot').textContent(), 'Fixture calls excluded; distinct callers is an estimate from hashed IPs.');

    await page.waitForFunction(() => document.fonts.check('17px "Source Serif 4"'));
    const style = await text.evaluate((el) => {
      const cs = getComputedStyle(el);
      const chip = getComputedStyle(el.querySelector('.md-code-inline'));
      const h = getComputedStyle(el.querySelector('.md-h3'));
      const foot = getComputedStyle(el.querySelector('.md-foot'));
      const user = getComputedStyle(document.querySelector('#chat-container .message-bubble.user .message-text'));
      const header = getComputedStyle(document.querySelector('.drawer-item'));
      return {
        family: cs.fontFamily, size: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color,
        chip: { family: chip.fontFamily, size: chip.fontSize, radius: chip.borderTopLeftRadius, border: chip.borderTopWidth, color: chip.color, bg: chip.backgroundColor },
        heading: { family: h.fontFamily, weight: h.fontWeight },
        foot: { family: foot.fontFamily, size: foot.fontSize, color: foot.color },
        user: user.fontFamily, chrome: header.fontFamily
      };
    });
    assert.match(style.family, /^"Source Serif 4", Georgia, serif$/);
    assert.ok(px(style.size) >= 17 && px(style.size) <= 18, `reply size ${style.size}`);
    assert.ok(Math.abs(px(style.lineHeight) / px(style.size) - 1.55) < 0.01, `line-height ${style.lineHeight}`);
    assert.match(style.chip.family, /^"JetBrains Mono"/);
    assert.ok(Math.abs(px(style.chip.size) / px(style.size) - 0.9) < 0.02, `chip ${style.chip.size}`);
    assert.equal(style.chip.radius, '6px');
    assert.equal(style.chip.border, '1px');
    assert.match(style.heading.family, /Source Serif 4/);
    assert.equal(style.heading.weight, '600');
    assert.match(style.foot.family, /^Inter/);
    assert.ok(px(style.foot.size) <= 12.5, `footnote ${style.foot.size}`);
    assert.match(style.user, /^Inter/, 'the operator\'s own messages keep the sans');
    assert.match(style.chrome, /^Inter/, 'the app chrome keeps the sans');
    if (theme === 'dark') {
      assert.equal(style.color, 'rgb(235, 232, 225)', 'off-white text');
      assert.equal(style.chip.color, 'rgb(159, 208, 255)', 'light blue chip text');
      assert.equal(style.chip.bg, 'rgb(30, 32, 37)', 'dark grey chip');
    }

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, 'no horizontal page scroll');
    await shoot(page, text, `usage-report-412-${theme}.png`);

    // Code blocks and a wide table: dark panels, the table scrolls in place.
    await page.evaluate(() => { clearChat(); });
    const styled = await send(page, 'show me the reply style');
    const wrap = styled.locator('.md-table-wrap');
    const tableBox = await wrap.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, radius: getComputedStyle(el).borderTopLeftRadius, overflow: getComputedStyle(el).overflowX }));
    assert.ok(tableBox.scroll > tableBox.client, 'the wide table is wider than its panel');
    assert.equal(tableBox.overflow, 'auto');
    assert.equal(tableBox.radius, '6px');
    assert.equal(await styled.locator('.code-block').evaluate((el) => getComputedStyle(el).borderTopLeftRadius), '6px');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, 'the page itself never scrolls sideways');
    await shoot(page, styled, `reply-style-412-${theme}.png`);

    assert.deepEqual(errors, [], 'no page or console errors');
    assert.deepEqual(log.missing, [], 'nothing 404ed');
  });
}

test('saved chats in the browser: save, auto-update, rename, load and continue, delete with confirmation, guests blocked', { skip, timeout: 240000 }, async (t) => {
  const { server, log, db, origin } = await startServer();
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((r) => server.close(r));
  });
  mkdirSync(SHOTS_DIR, { recursive: true });

  // A guest (not signed in) cannot save: no request leaves the page.
  {
    const { page, context } = await openPage(browser, origin, 'dark');
    await page.evaluate(() => saveCurrentThread());
    assert.equal(log.requests.filter((r) => r.path === '/api/threads').length, 0);
    const guest = await page.evaluate(() => fetch('/api/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'list' }) }).then((r) => r.status));
    assert.equal(guest, 401, 'the API refuses a guest');
    await context.close();
  }

  const { page, errors } = await openPage(browser, origin, 'dark');
  await signIn(page);
  const saveBtn = page.locator('#save-thread-btn');
  const threadsCalls = (op) => log.requests.filter((r) => r.path === '/api/threads' && r.body && r.body.op === op);
  const openSheet = async () => {
    await page.evaluate(() => openThreadsModal());
    await page.waitForFunction(() => !/Loading/.test(document.getElementById('thread-list-container').textContent));
  };
  const toast = () => page.locator('#status-toast').textContent();

  // The sheet: real data only, empty to begin with.
  await openSheet();
  assert.equal((await page.locator('#thread-list-container').textContent()).trim(), 'No saved chats yet');
  assert.ok(!(await page.content()).includes('Node Scaling'));
  await page.evaluate(() => closeThreadsModal());

  // Save: titled from the first message, "Saved", button pressed.
  assert.equal(await saveBtn.getAttribute('aria-pressed'), 'false');
  await send(page, '/usage');
  await saveBtn.click();
  await page.waitForFunction(() => document.getElementById('save-thread-btn').getAttribute('aria-pressed') === 'true');
  assert.equal(await toast(), 'Saved');
  const saved = threadsCalls('save')[0];
  assert.equal(saved.body.id, undefined);
  assert.deepEqual(saved.body.messages.map((m) => m.role), ['user', 'assistant']);
  assert.match(saved.body.messages[1].text, /^## Usage · the last 7 days/, 'the markdown is saved, not the rendered text');
  let rows = (await db.query('select id, title, message_count from public.pg1_chat_threads')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '/usage');
  const id = rows[0].id;
  assert.match(await saveBtn.getAttribute('aria-label'), /^Saved chat: \/usage$/);

  // Auto-update: the next exchange lands in the same thread.
  await send(page, 'Which of those callers were probes?');
  await page.waitForFunction(() => !threadSyncTimer || true);
  await page.waitForTimeout(1600);
  await page.waitForFunction(() => !threadSyncRunning);
  rows = (await db.query('select id, message_count from public.pg1_chat_threads')).rows;
  assert.deepEqual(rows, [{ id, message_count: 4 }], 'same thread, updated');
  assert.ok(threadsCalls('save').slice(1).every((r) => r.body.id === id));

  // Rename from the sheet.
  await openSheet();
  const item = page.locator(`.thread-item[data-thread-id="${id}"]`);
  assert.match(await item.textContent(), /open now/);
  page.once('dialog', (d) => d.accept('Usage review'));
  await item.locator('[data-action="rename"]').click();
  await page.waitForFunction(() => /Usage review/.test(document.getElementById('thread-list-container').textContent));
  assert.equal((await db.query('select title from public.pg1_chat_threads')).rows[0].title, 'Usage review');
  assert.match(await saveBtn.getAttribute('aria-label'), /Usage review/);
  await page.locator('#threads-modal .matrix-card').screenshot({ path: join(SHOTS_DIR, 'threads-sheet-412-dark.png') });
  await page.evaluate(() => closeThreadsModal());

  // A new chat: the button goes back to unsaved.
  await page.evaluate(() => clearChat());
  await page.waitForTimeout(300);
  assert.equal(await saveBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#chat-container .message-bubble:not(.welcome)').count(), 0);

  // Load: the conversation comes back and carries on.
  await openSheet();
  await page.locator(`.thread-item[data-thread-id="${id}"] [data-action="load"]`).click();
  await page.waitForFunction(() => document.querySelectorAll('#chat-container .message-bubble:not(.welcome)').length === 4);
  assert.equal(await saveBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#chat-container .message-bubble:not(.user) .md-h3').first().textContent(), 'Summary', 'markdown re-rendered');
  const reply = await send(page, 'And this week compared to last?');
  assert.match(await reply.locator('.message-text').textContent(), /There are 5 earlier messages in this chat/, 'the server got the loaded history');
  await page.waitForTimeout(1600);
  await page.waitForFunction(() => !threadSyncRunning);
  assert.equal((await db.query('select message_count from public.pg1_chat_threads where id = $1', [id])).rows[0].message_count, 6);

  // Delete: asks first; dismissing keeps it, accepting removes it.
  await openSheet();
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await page.locator(`.thread-item[data-thread-id="${id}"] [data-action="delete"]`).click();
  await page.waitForTimeout(200);
  assert.match(asked, /Delete "Usage review"\? This cannot be undone\./);
  assert.equal((await db.query('select count(*)::int as n from public.pg1_chat_threads')).rows[0].n, 1, 'kept after Cancel');
  assert.equal(threadsCalls('delete').length, 0);
  page.once('dialog', (d) => d.accept());
  await page.locator(`.thread-item[data-thread-id="${id}"] [data-action="delete"]`).click();
  await page.waitForFunction(() => /No saved chats yet/.test(document.getElementById('thread-list-container').textContent));
  assert.equal((await db.query('select count(*)::int as n from public.pg1_chat_threads')).rows[0].n, 0);
  assert.equal(threadsCalls('delete')[0].body.confirm, true);
  assert.equal(await saveBtn.getAttribute('aria-pressed'), 'false', 'the open chat is no longer saved');
  await page.evaluate(() => closeThreadsModal());

  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.deepEqual(errors, [], 'no page or console errors');
  assert.deepEqual(log.missing, [], 'nothing 404ed');
});
