/**
 * Autonomous mode's approval cards and daily briefing in a real browser
 * (Chromium via Playwright, phone-sized):
 *   - the count in the header shows how many cards wait for approval;
 *   - the timeline opens with the cards on top: a SQL proposal shows its
 *     SQL and Approve / Reject; approving records the decision and says
 *     PG1 changes no data; a promotion card sends the lab's own chat
 *     command (the operator still approves it there);
 *   - the daily briefing appears in the chat once, and is acknowledged.
 * /api/watches and /api/chat are stubs answering as the server does.
 * Writes docs/screenshots/autonomous-approvals-412-dark.png.
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
  const log = { ops: [], prompts: [], acks: [], missing: [] };
  const cards = [
    { id: '11111111-1111-4111-8111-111111111111', kind: 'sql_proposal', label: 'Feed guardian', title: 'Remove 2 placeholder indicator rows from the feed', detail: 'Dry run only: PG1 never changes data.', sql: "delete from public.threat_ioc_telemetry where value ~* 'example\\.com';" },
    { id: '22222222-2222-4222-8222-222222222222', kind: 'promote', label: 'Lab autopilot', title: 'Promote lab e2e2e2e2: a skill', detail: 'It passed its gate.', sql: null }
  ];
  let briefingShown = false;
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
          if (parsed.op === 'auto_state') return json(200, { ok: true, autonomous: { enabled: true, available: true, todayCount: 4, pendingApprovals: cards.length } });
          if (parsed.op === 'auto_approvals') return json(200, { ok: true, approvals: cards });
          if (parsed.op === 'auto_decide') {
            const i = cards.findIndex((c) => c.id === parsed.id);
            const c = cards.splice(i, 1)[0];
            if (c.kind === 'promote' && parsed.decision === 'approve') return json(200, { ok: true, decision: 'approved', command: '/lab report e2e2e2e2', message: "Opening the lab's own approval in chat." });
            return json(200, { ok: true, decision: parsed.decision === 'approve' ? 'approved' : 'rejected', message: parsed.decision === 'approve' ? 'Recorded. PG1 changes no data: run the SQL yourself in the Supabase SQL editor.' : 'Rejected. Nothing was changed.' });
          }
          if (parsed.op === 'auto_log') return json(200, { ok: true, actions: [] });
          if (parsed.op === 'auto_inbox') return json(200, { ok: true, reports: briefingShown ? [] : [{ id: '33333333-3333-4333-8333-333333333333', at: new Date().toISOString(), title: 'PG1 daily briefing', body: 'PG1 daily briefing · 2026-10-17\nAutonomous mode: ON. 4 actions today: 4 done.' }] });
          if (parsed.op === 'auto_ack') { briefingShown = true; log.acks.push(...parsed.ids); return json(200, { ok: true, acknowledged: parsed.ids.length }); }
          if (parsed.op === 'inbox') return json(200, { ok: true, reports: [] });
          return json(200, { ok: true });
        }
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: parsed.user === 'operator' && parsed.pass === 'passkey' });
          log.prompts.push(parsed && parsed.prompt);
          return json(200, { reply: 'Lab e2e2e2e2 report.' });
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

test('Autonomous mode: approval cards with Approve / Reject, and the daily briefing in chat once', { skip, timeout: 180000 }, async (t) => {
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

  // The briefing, once.
  const briefing = page.locator('#chat-container .is-report', { hasText: 'PG1 daily briefing' });
  await briefing.first().waitFor();
  await page.waitForFunction(() => document.getElementById('auto-count').dataset.approvals === '2');
  assert.deepEqual(log.acks, ['33333333-3333-4333-8333-333333333333']);
  await page.evaluate(() => refreshAutonomous());
  await page.waitForTimeout(300);
  assert.equal(await briefing.count(), 1, 'shown once');

  // The cards, on top of the timeline.
  await page.click('#auto-count');
  await page.locator('#auto-modal').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#auto-approvals .auto-card').length === 2);
  const sqlCard = page.locator('#auto-approvals .auto-card').first();
  assert.match(await sqlCard.locator('pre').innerText(), /^delete from public\.threat_ioc_telemetry/);
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'autonomous-approvals-412-dark.png') });
  await sqlCard.locator('button[data-decision="approve"]').click();
  await page.waitForFunction(() => /PG1 changes no data/.test(document.querySelector('#auto-approvals .auto-card').innerText));
  // A promotion: approving opens the lab's own approval in chat.
  await page.locator('#auto-approvals .auto-card').nth(1).locator('button[data-decision="approve"]').click();
  await page.locator('#auto-modal').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.body.innerText.includes('Lab e2e2e2e2 report.'));
  assert.ok(log.prompts.includes('/lab report e2e2e2e2'), 'the operator\'s own command, sent from their session');

  assert.deepEqual(problems, [], 'no page or console errors');
  assert.deepEqual(log.missing, []);
});
