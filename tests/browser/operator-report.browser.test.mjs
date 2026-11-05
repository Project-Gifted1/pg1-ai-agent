/**
 * PG1's scheduled report (lib/operator) in a real browser (Chromium via
 * Playwright, phone-sized):
 *   - the daily report arrives in the chat on its own (auto_inbox) as a
 *     card: usage, payments, errors, deploys, what PG1 did, next;
 *   - each item waiting for approval shows its one-line reason and Approve
 *     / Decline; the decision goes to the server as the operator's
 *     (task_decide, with the item's source), and the answer shows under it;
 *   - an item that cannot be approved as it stands has no Approve button;
 *   - nothing scrolls sideways.
 * /api/watches and /api/chat are stubs answering as the server does.
 * Writes docs/screenshots/operator-report-412-dark.png.
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


const { buildDailyReport } = await import('../../lib/operator/reports.mjs');

const NOW = Date.UTC(2026, 10, 4, 7, 15);
const DATA = {
  kind: 'daily', now: NOW, from: new Date(NOW - 86400000).toISOString(), to: new Date(NOW).toISOString(), mode: 'on',
  usage: { ok: true, yesterday: { day: '2026-11-03', real: 126, probe: 40 }, previous: { day: '2026-11-02', real: 125, probe: 30 }, avg7: 90.9, avg7_days: 7 },
  last24: { ok: true, summary: { real_tool_calls: 126, distinct_real_callers_estimate: 3 }, payments: { payment_requests: 25, payments_settled: 0, revenue_usd: 0 }, errors: { by_fault: { pg1: 6, caller: 0, unclassified: 0 } }, own: {} },
  chain: { ok: false, reason: 'the chain check is not on this deployment' },
  deploys: { ok: true, list: [{ id: 'dpl_1', state: 'READY', created_at: new Date(NOW - 3600000).toISOString(), message: 'Fix wallet age errors (#410)' }] },
  autonomy: { ok: true, rows: [{ actor: 'pg1', action: 'code:merge_low_risk', decision: 'allowed' }, { actor: 'pg1', action: 'lab:dispatch', decision: 'allowed' }] },
  autonomous: { ok: true, rows: [{ type: 'lab_autopilot', status: 'done', result: 'started an experiment' }] },
  plans: { ok: true, tasks: [{ kind: 'fix', title: 'Fix check_wallet_age: 6 upstream_error errors', status: 'lab_running' }] },
  approvals: { ok: true, list: [
    { id: '11111111-1111-4111-8111-111111111111', source: 'task', kind: 'listing', title: 'MCP registry lists 1.20.0; live is 1.21.1', reason: 'Listing out of date: registry has 1.20.0, live is 1.21.1.', approvable: true },
    { id: '22222222-2222-4222-8222-222222222222', source: 'task', kind: 'pricing', title: '25 payment requests, none settled in 7 days: review the price', reason: 'worst-case cost per call is not known, so the 1.5x check cannot run', approvable: false },
    { id: '33333333-3333-4333-8333-333333333333', source: 'action', kind: 'self_heal', title: 'Self-heal draft PR #402', reason: 'CI run failed', approvable: true }
  ] }
};
const BUILT = buildDailyReport(DATA);

function startStubServer() {
  const log = { decisions: [], acks: [], missing: [] };
  let delivered = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      const json = (status, b) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/errors') return json(200, { errors: [], ok: true });
        if (url.pathname === '/api/health') return json(200, { status: 'ok' });
        // The empty state's live text (api/home-context.mjs): none here, so the defaults stay.
        if (url.pathname === '/api/home-context') return json(200, { ok: true });
        if (url.pathname === '/api/handoffs') return json(200, { handoffs: [] });
        if (url.pathname === '/api/threads') return json(200, { threads: [] });
        if (url.pathname === '/api/watches') {
          if (!parsed || parsed.user !== 'operator' || parsed.pass !== 'passkey') return json(401, { error: 'unauthorized' });
          if (parsed.op === 'auto_state') return json(200, { ok: true, autonomous: { enabled: true, available: true, todayCount: 2, pendingApprovals: 0 } });
          if (parsed.op === 'auto_inbox') return json(200, { ok: true, reports: delivered ? [] : [{ id: '44444444-4444-4444-8444-444444444444', at: new Date().toISOString(), kind: 'operator_report', title: BUILT.title, body: `${BUILT.title}\nThe full report is in the card below and in the media library as a PDF.`, card: BUILT.card }] });
          if (parsed.op === 'auto_ack') { delivered = true; log.acks.push(...parsed.ids); return json(200, { ok: true }); }
          if (parsed.op === 'task_decide') {
            log.decisions.push({ id: parsed.id, source: parsed.source, decision: parsed.decision });
            return json(200, { ok: true, decision: parsed.decision, message: parsed.decision === 'approve' ? 'Approved: PG1 started publish-mcp.yml. The next weekly report checks the registry version.' : 'Declined. Nothing was changed.' });
          }
          if (parsed.op === 'auto_log' || parsed.op === 'auto_approvals') return json(200, { ok: true, actions: [], approvals: [] });
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
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, log, origin: `http://127.0.0.1:${server.address().port}` })));
}

test('the daily report arrives as a card with Approve / Decline on each waiting item', { skip, timeout: 180000 }, async (t) => {
  const { server, log, origin } = await startStubServer();
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
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });

  const card = page.locator('#chat-container .is-report .usage-card');
  await card.waitFor();
  assert.deepEqual(log.acks, ['44444444-4444-4444-8444-444444444444']);
  assert.deepEqual(await card.locator('.usage-h').allTextContents(), ['Usage (real)', 'Payments (24 h)', 'Errors by fault (24 h)', 'Deploys (24 h)', 'PG1 on its own (24 h)', 'Next', 'Waiting for approval']);
  const text = await card.innerText();
  assert.match(text, /126/);
  assert.match(text, /not read/, 'the chain is named as not read, never estimated');
  assert.doesNotMatch(text, /\bsafe\b/i);

  const items = card.locator('.report-approval');
  assert.equal(await items.count(), 3);
  assert.match(await items.nth(0).innerText(), /Listing out of date: registry has 1\.20\.0, live is 1\.21\.1\./);
  assert.equal(await items.nth(1).locator('.report-approve').count(), 0, 'no Approve on an item whose check did not pass');
  assert.match(await items.nth(1).innerText(), /Cannot be approved as it stands/);

  mkdirSync(SHOTS_DIR, { recursive: true });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS_DIR, 'operator-report-412-dark.png'), fullPage: false });

  await items.nth(0).locator('.report-approve').click();
  await page.waitForFunction(() => /Approved: PG1 started publish-mcp\.yml/.test(document.querySelector('.report-approval').innerText));
  assert.equal(await items.nth(0).locator('.report-approve').isDisabled(), true);
  await items.nth(2).locator('.report-decline').click();
  await page.waitForFunction(() => /Declined\. Nothing was changed\./.test(document.querySelectorAll('.report-approval')[2].innerText));
  assert.deepEqual(log.decisions, [
    { id: '11111111-1111-4111-8111-111111111111', source: 'task', decision: 'approve' },
    { id: '33333333-3333-4333-8333-333333333333', source: 'action', decision: 'decline' }
  ]);

  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.deepEqual(problems, [], 'no page or console errors');
  assert.deepEqual(log.missing, []);
});
