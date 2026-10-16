/**
 * Motion and polish in a real browser (Chromium via Playwright), phone-sized,
 * in dark and light:
 *   - the lab card (lib/lab/card.mjs) in each state: queued, running, done,
 *     failed, over_budget; the mascot's pose follows the status, the budget
 *     beaker fills toward the cap (red from 90%), the stage track agrees
 *     with the status (queued: no active stage; not-reached stages are the
 *     same solid empty dots in both themes, never cut by the track line); a
 *     stop under the budget reads "near budget" with its threshold, and no
 *     coin sits beside the mascot;
 *   - the lab list (/lab status): one card per lab, keyed, each with its own
 *     Report button; a later card for the same lab replaces the earlier one
 *     (a watch report's card is the server's, with its title), so each lab
 *     is on screen exactly once; no serif text list repeats the cards;
 *   - a lab watch report gets the same card, built by the server;
 *   - the threat radar (lib/threatRadar.mjs, built here from seeded feed
 *     rows and a seeded known exploited catalog): one blip per finding the
 *     server returned, coloured by status, a KEV badge, per-feed sparklines,
 *     "data as of" in Ireland time; the sweep turns only while the data
 *     loads, then rests; findings newer than the last visit pulse;
 *   - PG1's shield is the thinking indicator, with shimmer placeholders;
 *   - the first settled paid call is celebrated once, never twice;
 *   - with prefers-reduced-motion every animation is off.
 *
 * The page is served from public/ as deployed; /api/chat answers with what
 * the server sends. Writes docs/screenshots/lab-card-<state>-412-<theme>.png,
 * lab-list-412-<theme>.png and radar-card-412-<theme>.png. Skipped (not failed) when Playwright or
 * its Chromium is not installed.
 * Run with: node --test tests/browser/motion-cards.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { labCardView } from '../../lib/lab/card.mjs';
import { statusSummary } from '../../lib/lab/chat.mjs';
import { buildThreatRadar, threatRadarLead, KEV_URL } from '../../lib/threatRadar.mjs';
import { composeReport } from '../../lib/watches/report.mjs';

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

// 16 Oct 2026, 09:46 in Ireland (IST, UTC+1).
const NOW = Date.UTC(2026, 9, 16, 8, 46, 0);
const DAY = 86400000;

const id = (n) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const EXPERIMENTS = {
  queued: { id: id(1), kind: 'research', goal: 'Compare two public CVE feeds for freshness', status: 'queued', budget_usd: 2, spent_usd: 0 },
  running: { id: id(2), kind: 'code', goal: 'Add a CVE batch size check to the playground', status: 'running', budget_usd: 2, spent_usd: 0.84, run_id: 991 },
  done: { id: id(3), kind: 'skill', goal: 'Draft a skill that explains a KEV entry in plain words', status: 'done', budget_usd: 2, spent_usd: 1.12, candidate: { type: 'skill' }, gate: { pass: true, checks: [{ name: 'evals', ok: true }] } },
  failed: { id: id(4), kind: 'code', goal: 'Refactor the feed reader', status: 'failed', budget_usd: 2, spent_usd: 0.46, error: 'build: the model proposed no usable change' },
  over_budget: { id: id(5), kind: 'research', goal: 'Survey every public phishing list', status: 'over_budget', budget_usd: 2, spent_usd: 1.94, error: 'research: the next call could cost up to $0.0700', budget_stop: { spent_usd: 1.94, next_call_worst_usd: 0.07, threshold_usd: 1.93, budget_usd: 2 } }
};
// /lab status: one card per lab, with its buttons, under a short summary.
const LIST = Object.values(EXPERIMENTS);
const statusReply = () => ({ reply: statusSummary(LIST), labCards: LIST.map((e) => labCardView(e, { actions: true })) });
const labReply = (e) => ({ reply: `### [ LAB ${e.id.slice(0, 8)} · ${e.kind} · ${e.status} ]\nGoal: ${e.goal}\nSpent $${e.spent_usd.toFixed(2)} of $${e.budget_usd.toFixed(2)}.\n\nNo report.`, labCards: [labCardView(e)] });

// Seeded feed rows (NVD, servable) and the known exploited catalog.
function radarFetch() {
  const iso = (ms) => new Date(ms).toISOString();
  const rows = [
    { value: 'CVE-2026-41001', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(NOW - 2 * 3600e3) },
    { value: 'CVE-2026-40877', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(NOW - 9 * 3600e3) },
    { value: 'CVE-2026-40512', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(NOW - 1.3 * DAY) },
    { value: 'CVE-2026-39990', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(NOW - 2.2 * DAY) },
    { value: 'CVE-2026-39101', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(NOW - 3.5 * DAY) },
    { value: 'CVE-2026-38420', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(NOW - 4.1 * DAY) },
    { value: 'CVE-2026-37007', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(NOW - 5.6 * DAY) },
    { value: 'CVE-2026-36666', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(NOW - 6.2 * DAY) },
    // a test fixture labelled NVD: never shown (reserved domain, and NVD
    // publishes CVE records only)
    { value: 'evil.example', indicator_type: 'domain', verification_source: 'NVD', ingested_at: iso(NOW - 1.8 * DAY) },
    // a real non-CVE feed (switched on below): its indicators are "unknown"
    { value: '198.18.0.44', indicator_type: 'IPv4', verification_source: 'Blocklist.de', ingested_at: iso(NOW - 1.8 * DAY) }
  ];
  const kev = { vulnerabilities: [
    { cveID: 'CVE-2026-40877', dateAdded: '2026-10-15' },
    { cveID: 'CVE-2026-38420', dateAdded: '2026-10-12' },
    { cveID: 'CVE-2026-35550', dateAdded: '2026-10-11' },
    { cveID: 'CVE-2019-0001', dateAdded: '2021-11-03' }
  ] };
  return async (url) => {
    const u = String(url);
    if (u === KEV_URL) return new Response(JSON.stringify(kev), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/rest/v1/threat_ioc_telemetry')) return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('[]', { status: 404 });
  };
}
const RADAR = await buildThreatRadar({ supUrl: 'https://db.test', supKey: 'k', fetchImpl: radarFetch(), env: { SOURCE_BLOCKLIST_DE_ENABLED: 'true' }, now: NOW });
const REPORT_EXP = { ...EXPERIMENTS.done, kind: 'code', candidate: { type: 'code', pr_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/7' } };
const builtReport = composeReport({ target_type: 'lab', target_id: REPORT_EXP.id }, { state: 'done', info: { exp: REPORT_EXP } });
const REPORT = { id: '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', created_at: new Date(NOW).toISOString(), origin_thread: null, target_type: 'lab', target_id: REPORT_EXP.id, state: 'done', title: builtReport.title, body: builtReport.body, actions: builtReport.actions };

function startServer({ radarDelayMs = 900, report = false, reportAfterStatus = false } = {}) {
  let delivered = !report;
  let released = !reportAfterStatus;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      const json = (status, b) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/chat') {
          const p = parsed && parsed.prompt;
          if (p === 'AUTH_VERIFY') return json(200, { authenticated: true });
          const lab = /^\/lab report (\w+)$/.exec(p || '');
          if (lab && EXPERIMENTS[lab[1]]) return json(200, labReply(EXPERIMENTS[lab[1]]));
          if (p === '/lab status') return json(200, statusReply());
          // a stale, title-less copy of a lab next to its real card: drawn once
          if (p === '/lab status twice') { const r = statusReply(); return json(200, { ...r, labCards: [{ ...r.labCards[2], goal: '', stages: r.labCards[2].stages.map((x, i) => ({ ...x, state: i < 2 ? 'done' : 'todo' })) }, ...r.labCards] }); }
          if (p === '/threat-radar') {
            await new Promise((r) => setTimeout(r, radarDelayMs));
            return json(200, { reply: threatRadarLead(RADAR), threatRadar: RADAR });
          }
          if (p === '/usage') return json(200, { reply: 'Usage, last 7 days.', milestone: { kind: 'first_settled_payment', at: '2026-10-13T07:00:00Z' } });
          if (p === '/slow') { await new Promise((r) => setTimeout(r, 1500)); return json(200, { reply: 'ok' }); }
          return json(200, { reply: 'ok' });
        }
        if (url.pathname === '/api/test-release-report') { released = true; return json(200, { ok: true }); }
        if (url.pathname === '/api/watches') {
          if (parsed && parsed.op === 'inbox') { if (!released) return json(200, { ok: true, reports: [] }); const out = delivered ? [] : [REPORT]; delivered = true; return json(200, { ok: true, reports: out }); }
          return json(200, { ok: true });
        }
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

async function openPage(t, { theme = 'dark', reducedMotion = 'no-preference', radarDelayMs, report, reportAfterStatus } = {}) {
  const { server, origin } = await startServer({ radarDelayMs, report, reportAfterStatus });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme, reducedMotion });
  await routeReplyFont(context);
  await context.addInitScript((value) => { try { localStorage.setItem('pg1_theme', value); } catch (e) {} }, theme);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (err) => problems.push(String(err && err.message || err)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) problems.push(m.text()); });
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  return { page, problems };
}

async function send(page, prompt) {
  await page.fill('#prompt-input', prompt);
  await page.click('.execute-btn');
}

// Running animations inside one element (CSS animations on it and below).
const runningIn = (locator) => locator.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').map((a) => a.animationName || a.id));

for (const theme of ['dark', 'light']) {
  test(`lab card in each state on a phone (${theme})`, { skip, timeout: 240000 }, async (t) => {
    const { page, problems } = await openPage(t, { theme });
    mkdirSync(SHOTS_DIR, { recursive: true });
    // queued: no active stage; failed / stopped short: the stage it stopped
    // at, the rest not reached; a stage the kind does not use: skipped
    const expectStage = { queued: ['todo', 'skipped', 'skipped', 'skipped'], running: ['current', 'todo', 'todo', 'todo'], done: ['skipped', 'done', 'done', 'done'], failed: ['done', 'failed', 'todo', 'todo'], over_budget: ['failed', 'skipped', 'skipped', 'skipped'] };
    for (const state of Object.keys(EXPERIMENTS)) {
      await send(page, `/lab report ${state}`);
      const card = page.locator(`#chat-container .lab-card[data-pose="${state}"]`).last();
      await card.waitFor();
      assert.equal(await card.getAttribute('data-pose'), state);
      assert.ok(await card.locator('.lab-bot').count(), 'the mascot is drawn');
      assert.deepEqual(await card.locator('.lab-track li').evaluateAll((els) => els.map((e) => e.dataset.state)), expectStage[state], `${state}: stage track`);
      // the pose's own props are the ones on screen
      const visible = await card.evaluate((el) => ['.p-clip', '.p-flask', '.p-up', '.p-smoke', '.p-pocket'].filter((s) => getComputedStyle(el.querySelector(s)).display !== 'none'));
      assert.deepEqual(visible, { queued: ['.p-clip'], running: ['.p-flask'], done: ['.p-up'], failed: ['.p-smoke'], over_budget: ['.p-pocket'] }[state]);
      assert.equal(await card.locator('.p-coin, .b-coin, .b-cn').count(), 0, 'no coin (the stray yellow dot) beside the mascot');
      // The status words: "near budget" (with its threshold) for a stop
      // under the budget, never "over budget".
      const chip = (await card.locator('.lab-state').innerText()).trim();
      assert.equal(chip, { queued: 'queued', running: 'running', done: 'done', failed: 'failed', over_budget: 'near budget' }[state]);
      if (state === 'over_budget') assert.match(await card.locator('.lab-card-kind').innerText(), /stopped at its \$1\.93 threshold/);
      // Queued: nothing is highlighted as running.
      if (state === 'queued') assert.equal(await card.locator('.lab-track li[data-state="current"]').count(), 0);
      // Every marker is a solid dot drawn above the track line: nothing
      // is see-through or shrunk, and the dot itself is what sits at its
      // centre and at its right edge (where the next stage's line runs).
      const dots = await card.locator('.lab-track li').evaluateAll((lis) => lis.map((li) => {
        const dot = li.querySelector('.dot');
        const r = dot.getBoundingClientRect();
        const hit = (x, y) => document.elementFromPoint(x, y) === dot;
        const cs = getComputedStyle(dot);
        return { state: li.dataset.state, opacity: getComputedStyle(li).opacity, transform: cs.transform, round: cs.borderRadius, solid: hit(r.left + r.width / 2, r.top + r.height / 2) && hit(r.right - 2, r.top + r.height / 2) && hit(r.left + 2, r.top + r.height / 2), bg: cs.backgroundColor, border: `${cs.borderTopStyle} ${cs.borderTopColor}` };
      }));
      for (const d of dots) {
        assert.equal(d.opacity, '1', `${state} ${d.state}: not see-through`);
        assert.equal(d.transform, 'none', `${state} ${d.state}: not shrunk`);
        assert.equal(d.solid, true, `${state} ${d.state}: a whole dot, not cut by the track line`);
      }
      const empty = dots.filter((d) => d.state === 'todo' || d.state === 'skipped');
      assert.equal(new Set(empty.map((d) => `${d.bg}|${d.border}`)).size <= 1, true, 'not-reached and not-used markers are all the same solid empty dot');
      assert.ok(empty.every((d) => d.border.startsWith('solid')), 'no dashed or broken outline');
      // beaker: the fill is the real spend over the cap; red from 90%
      const e = EXPERIMENTS[state];
      assert.equal(await card.locator('.bk-liquid').evaluate((el) => el.style.getPropertyValue('--fill').trim()), (e.spent_usd / e.budget_usd).toFixed(3));
      assert.equal(await card.locator('.lab-beaker').evaluate((el) => el.classList.contains('is-high')), state === 'over_budget');
      // A /lab report card carries no buttons of its own (the reply has them).
      assert.equal(await card.locator('.lab-card-actions').count(), 0);
      const anims = await runningIn(card);
      if (state === 'queued') assert.ok(anims.includes('bot-tap'), 'queued: taps the clipboard');
      if (state === 'running') assert.ok(anims.includes('bot-stir') && anims.includes('bot-bubble') && anims.includes('dot-pulse'), 'running: stirs, bubbles, the current stage pulses');
      if (state === 'done') assert.ok(anims.includes('meter-fill'), 'done: the stage line draws in up to the stage reached');
      await page.waitForTimeout(2600);
      if (['done', 'failed', 'over_budget'].includes(state)) {
        const left = (await runningIn(card)).filter((n) => !/^lab-pulse$/.test(n));
        assert.deepEqual(left, [], `${state}: a finished experiment's animation plays once, then rests`);
      }
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: join(SHOTS_DIR, `lab-card-${state}-412-${theme}.png`), animations: 'allow' });
    }
    // Nothing scrolls sideways at phone width.
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    assert.deepEqual(problems, []);
  });

  test(`lab list: each lab once, keyed, with its own Report button (${theme})`, { skip, timeout: 180000 }, async (t) => {
    const { page, problems } = await openPage(t, { theme, report: true, reportAfterStatus: true });
    mkdirSync(SHOTS_DIR, { recursive: true });
    // A stale, title-less copy of lab 33333333 arrives with its real card:
    // drawn once, with its title, its stages agreeing with "done".
    await send(page, '/lab status twice');
    const msg = page.locator('#chat-container .message-bubble:not(.user):not(.is-report)').filter({ has: page.locator('.lab-card') }).last();
    await msg.locator('.lab-card').first().waitFor();
    const ids = Object.values(EXPERIMENTS).map((e) => e.id.slice(0, 8));
    const onScreen = () => page.locator('#chat-container .lab-card').evaluateAll((els) => els.map((e) => e.dataset.labId));
    assert.deepEqual(await onScreen(), ids, 'every lab exactly once, 11111111 included, in order');
    const done = page.locator('#chat-container .lab-card[data-lab-id="33333333"]');
    assert.equal(await done.locator('.lab-card-goal').innerText(), EXPERIMENTS.done.goal);
    assert.deepEqual(await done.locator('.lab-track li').evaluateAll((els) => els.map((e) => e.dataset.state)), ['skipped', 'done', 'done', 'done']);
    // One Report button per lab, on its own card; Stop only while it runs.
    for (const id8 of ids) {
      const card = page.locator(`#chat-container .lab-card[data-lab-id="${id8}"]`);
      assert.deepEqual(await card.locator('.lab-card-actions .pg1-action[data-command^="/lab report"]').evaluateAll((els) => els.map((e) => e.dataset.command)), [`/lab report ${id8}`], id8);
      assert.equal(await card.locator('.pg1-action[data-command^="/lab stop"]').count(), ['11111111', '22222222'].includes(id8) ? 1 : 0, id8);
    }
    // The words above the cards: the app's font, no list repeating the labs.
    const fonts = await msg.evaluate((el) => ({ card: getComputedStyle(el.querySelector('.lab-card')).fontFamily, body: getComputedStyle(document.body).fontFamily, lists: el.querySelectorAll('.md-block ul, ul:not(.radar-feeds):not(.radar-finds):not(.radar-counts)').length }));
    assert.equal(fonts.card, fonts.body, 'the lab cards use the app font');
    assert.equal(fonts.lists, 0, 'no text list repeats the cards');
    assert.doesNotMatch(await msg.innerText(), /^- [0-9a-f]{8} · /m);
    await page.waitForTimeout(1200);
    // The whole list in one picture: a viewport tall enough to hold it.
    const h = await msg.evaluate((el) => Math.ceil(el.getBoundingClientRect().height));
    await page.setViewportSize({ width: 412, height: Math.max(915, h + 400) });
    await msg.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await msg.screenshot({ path: join(SHOTS_DIR, `lab-list-412-${theme}.png`), animations: 'allow' });
    await page.setViewportSize({ width: 412, height: 915 });
    // A watch report for lab 33333333 arrives later: its (server-built) card
    // replaces the earlier one, so the lab is still on screen once.
    await page.evaluate(async () => { await fetch('/api/test-release-report', { method: 'POST' }); await pollReports(); });
    await page.locator('#chat-container .message-bubble.is-report .lab-card').waitFor({ timeout: 20000 });
    assert.equal(await page.locator('#chat-container .lab-card[data-lab-id="33333333"]').count(), 1);
    assert.equal(await page.locator('#chat-container .message-bubble.is-report .lab-card[data-lab-id="33333333"]').count(), 1);
    assert.equal((await onScreen()).length, ids.length);
    // Tapping a card's Report button runs that lab's report.
    await page.locator('#chat-container .lab-card[data-lab-id="55555555"] .pg1-action').click();
    await page.locator('#chat-container .lab-card[data-pose="over_budget"]').last().waitFor();
    assert.deepEqual(problems, []);
  });

  test(`threat radar card on a phone (${theme})`, { skip, timeout: 180000 }, async (t) => {
    const { page, problems } = await openPage(t, { theme });
    // A previous visit two days ago: findings since then are "new".
    await page.evaluate((ms) => localStorage.setItem('pg1_radar_last_visit', String(ms)), NOW - 2 * DAY);
    await send(page, '/threat-radar');
    // While the data loads: the shield thinks, the sweep turns.
    const loading = page.locator('#chat-container .message-bubble.pending .radar-card.is-loading');
    await loading.waitFor();
    assert.ok(await page.locator('#chat-container .message-bubble.pending .thinking-shield').count(), 'the shield is the thinking indicator');
    assert.ok((await runningIn(loading)).includes('radar-spin'), 'the sweep turns while loading');
    const card = page.locator('#chat-container .radar-card:not(.is-loading)').last();
    await card.waitFor();
    // One blip per finding returned, coloured by status.
    assert.equal(await card.locator('.blip').count(), RADAR.findings.length);
    assert.ok((await runningIn(card)).includes('rise-in'), 'the findings slide in');
    for (const st of ['flagged', 'unknown', 'no_flags']) assert.equal(await card.locator(`.blip.s-${st}`).count(), RADAR.counts[st], st);
    assert.ok(RADAR.counts.flagged >= 2 && RADAR.counts.unknown >= 1 && RADAR.counts.no_flags >= 1, 'the seed covers every status');
    assert.ok(await card.locator('.radar-find', { hasText: 'CVE-2026-40877' }).locator('.kev-badge').count(), 'an actively exploited CVE has the KEV badge');
    assert.match(await card.locator('.radar-asof').innerText(), /^Data as of 16 Oct 2026, 09:46 \(Ireland time\)$/);
    // Sparklines: one per feed that was read, 7 days each.
    assert.deepEqual(await card.locator('.radar-feed .radar-feed-name').allInnerTexts(), ['NVD', 'Blocklist.de', 'CISA KEV']);
    assert.equal(await card.locator('.spark-line').count(), 3);
    // No test fixture among the findings; each source is the real feed.
    assert.doesNotMatch(await card.innerText(), /evil\.example|\.example\b/);
    const metas = await card.locator('.radar-find-meta').allInnerTexts();
    for (const f of RADAR.findings) assert.ok(metas.some((m) => m.includes(f.source)), f.value);
    assert.ok(RADAR.findings.every((f) => f.type === 'CVE' || f.source !== 'NVD'), 'only CVE records are NVD\'s');
    // The feeds' totals and the findings reconcile on the card.
    assert.equal(await card.locator('.radar-tally').innerText(), RADAR.tally_text);
    // NVD 8 + Blocklist.de 1 + CISA KEV 3 = 12 feed items; two KEV entries
    // are NVD CVEs too, so 10 findings.
    assert.equal(RADAR.tally_text, '12 new items in the feeds, 10 unique: 2 were in more than one feed.');
    assert.equal(RADAR.findings.length, 10);
    assert.match(await card.locator('.spark-line').first().getAttribute('aria-label'), /^New per day, last 7 days: (\d+, ){6}\d+$/);
    // New since the last visit: pulses (findings seen in the last 2 days only).
    const newOnes = RADAR.findings.filter((f) => Date.parse(f.seen_at) > NOW - 2 * DAY).length;
    assert.ok(newOnes > 0);
    assert.equal(await card.locator('.blip-ring').count(), newOnes);
    // The sweep makes its pass, then rests; the counts reached their figures.
    await page.waitForTimeout(2600);
    assert.ok(!(await runningIn(card.locator('.r-sweep'))).length, 'the sweep rests once the data is in');
    assert.equal(await card.locator('.radar-counts .s-flagged .n').innerText(), String(RADAR.counts.flagged));
    await page.waitForTimeout(5000);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: join(SHOTS_DIR, `radar-card-412-${theme}.png`), animations: 'allow' });
    // Refresh: the sweep turns again only while the new read is in flight.
    await card.locator('.radar-refresh').click();
    await page.locator('#chat-container .radar-card.is-loading').waitFor();
    await page.locator('#chat-container .radar-card.is-loading').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#chat-container .radar-card').count(), 1, 'refreshed in place');
    assert.equal(await page.locator('#chat-container .blip-ring').count(), 0, 'nothing is new since the read a moment ago');
    // No world map, no provider names.
    assert.doesNotMatch(await page.locator('#chat-container .radar-card').innerText(), /map|Supabase|Vercel|Google|Anthropic/i);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    assert.deepEqual(problems, []);
  });
}

test('a lab watch report carries the lab card', { skip, timeout: 120000 }, async (t) => {
  const { page, problems } = await openPage(t, { report: true });
  const card = page.locator('#chat-container .message-bubble.is-report .lab-card');
  await card.waitFor({ timeout: 20000 });
  assert.equal(await card.getAttribute('data-pose'), 'done');
  assert.deepEqual(await card.locator('.lab-track li').evaluateAll((els) => els.map((e) => e.dataset.state)), ['done', 'done', 'done', 'done'], 'done: every stage a code experiment requires passed');
  assert.equal(await card.locator('.lab-card-goal').innerText(), REPORT_EXP.goal, 'the server\'s card keeps the title');
  assert.match(await card.locator('figcaption').innerText(), /\$1\.12\s+of \$2\.00/);
  assert.deepEqual(problems, []);
});

test('thinking shield, shimmer, one celebration, and restored cards stay still', { skip, timeout: 120000 }, async (t) => {
  const { page, problems } = await openPage(t, {});
  await send(page, '/slow');
  const pending = page.locator('#chat-container .message-bubble.pending');
  await pending.waitFor();
  assert.ok(await pending.locator('.thinking-shield svg .ts-body').count());
  assert.equal(await pending.locator('.shimmer-block > span').count(), 2);
  assert.ok((await runningIn(pending)).includes('ts-breathe'));
  await pending.waitFor({ state: 'detached' });

  await send(page, '/usage');
  const toast = page.locator('.milestone');
  await toast.waitFor();
  assert.match(await toast.innerText(), /First paid call settled[\s\S]*13 Oct 2026/);
  await toast.click();
  await toast.waitFor({ state: 'detached' });
  await send(page, '/usage');
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.milestone').count(), 0, 'shown once');

  // A card restored from a saved chat keeps its state without motion.
  await send(page, '/lab report running');
  await page.locator('#chat-container .lab-card[data-pose="running"]').waitFor();
  await page.reload({ waitUntil: 'load' });
  const restored = page.locator('#chat-container .lab-card[data-pose="running"]');
  await restored.waitFor();
  assert.equal(await restored.evaluate((el) => el.classList.contains('is-live')), false);
  assert.deepEqual(await runningIn(restored), []);
  assert.deepEqual(problems, []);
});

test('prefers-reduced-motion turns every animation off', { skip, timeout: 180000 }, async (t) => {
  const { page, problems } = await openPage(t, { reducedMotion: 'reduce' });
  await page.evaluate((ms) => localStorage.setItem('pg1_radar_last_visit', String(ms)), NOW - 2 * DAY);
  await send(page, '/threat-radar');
  const loading = page.locator('#chat-container .radar-card.is-loading');
  await loading.waitFor();
  const pendingBubble = page.locator('#chat-container .message-bubble.pending');
  const duringLoad = await pendingBubble.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.effect && a.effect.getComputedTiming().duration > 1).map((a) => a.animationName));
  assert.deepEqual(duringLoad, [], 'no thinking, shimmer or sweep animation while loading');
  const card = page.locator('#chat-container .radar-card:not(.is-loading)').last();
  await card.waitFor();
  // Figures are final at once: no count-up.
  assert.equal(await card.locator('.radar-counts .s-flagged .n').innerText(), String(RADAR.counts.flagged));
  for (const state of Object.keys(EXPERIMENTS)) {
    await send(page, `/lab report ${state}`);
    await page.locator(`#chat-container .lab-card[data-pose="${state}"]`).waitFor();
  }
  await page.waitForTimeout(300);
  const all = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && (a.effect && a.effect.getComputedTiming().duration > 1)).map((a) => `${a.animationName || a.transitionProperty}@${a.effect.target && a.effect.target.getAttribute('class')}`));
  assert.deepEqual(all, [], 'nothing on the page is animating');
  // The states are still readable without motion: smoke shows, the pocket is turned out.
  assert.equal(await page.locator('.lab-card[data-pose="failed"] .b-smk').first().evaluate((el) => getComputedStyle(el).opacity), '0.5');
  assert.equal(await page.locator('.lab-card[data-pose="over_budget"] .b-lining').evaluate((el) => getComputedStyle(el).transform), 'none', 'the pocket lining rests turned out');
  await send(page, '/usage');
  const toast = page.locator('.milestone');
  await toast.waitFor();
  assert.deepEqual(await toast.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.effect && a.effect.getComputedTiming().duration > 1).map((a) => a.animationName)), []);
  assert.deepEqual(problems, []);
});
