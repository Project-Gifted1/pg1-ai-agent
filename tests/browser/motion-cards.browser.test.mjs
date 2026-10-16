/**
 * Motion and polish in a real browser (Chromium via Playwright), phone-sized,
 * in dark and light:
 *   - the lab card (lib/lab/card.mjs) in each state: queued, running, done,
 *     failed, over_budget; the mascot's pose follows the status, the budget
 *     beaker fills toward the cap (red from 90%), the stage track has its
 *     dot on the real stage;
 *   - a lab watch report gets the same card, from the report's own fields;
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
 * the server sends. Writes docs/screenshots/lab-card-<state>-412-<theme>.png
 * and radar-card-412-<theme>.png. Skipped (not failed) when Playwright or
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
  failed: { id: id(4), kind: 'code', goal: 'Refactor the feed reader', status: 'failed', budget_usd: 2, spent_usd: 0.46, error: 'the runner returned no result' },
  over_budget: { id: id(5), kind: 'research', goal: 'Survey every public phishing list', status: 'over_budget', budget_usd: 2, spent_usd: 1.94 }
};
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
    { value: 'evil.example', indicator_type: 'domain', verification_source: 'NVD', ingested_at: iso(NOW - 1.8 * DAY) }
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
const RADAR = await buildThreatRadar({ supUrl: 'https://db.test', supKey: 'k', fetchImpl: radarFetch(), env: {}, now: NOW });
const REPORT_EXP = { ...EXPERIMENTS.done, candidate: { type: 'code', pr_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/7' } };
const builtReport = composeReport({ target_type: 'lab', target_id: REPORT_EXP.id }, { state: 'done', info: { exp: REPORT_EXP } });
const REPORT = { id: '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', created_at: new Date(NOW).toISOString(), origin_thread: null, target_type: 'lab', target_id: REPORT_EXP.id, state: 'done', title: builtReport.title, body: builtReport.body, actions: builtReport.actions };

function startServer({ radarDelayMs = 900, report = false } = {}) {
  let delivered = !report;
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
          if (p === '/threat-radar') {
            await new Promise((r) => setTimeout(r, radarDelayMs));
            return json(200, { reply: threatRadarLead(RADAR), threatRadar: RADAR });
          }
          if (p === '/usage') return json(200, { reply: 'Usage, last 7 days.', milestone: { kind: 'first_settled_payment', at: '2026-10-13T07:00:00Z' } });
          if (p === '/slow') { await new Promise((r) => setTimeout(r, 1500)); return json(200, { reply: 'ok' }); }
          return json(200, { reply: 'ok' });
        }
        if (url.pathname === '/api/watches') {
          if (parsed && parsed.op === 'inbox') { const out = delivered ? [] : [REPORT]; delivered = true; return json(200, { ok: true, reports: out }); }
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

async function openPage(t, { theme = 'dark', reducedMotion = 'no-preference', radarDelayMs, report } = {}) {
  const { server, origin } = await startServer({ radarDelayMs, report });
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
    const expectStage = { queued: ['current', 'todo', 'todo', 'todo'], running: ['current', 'todo', 'todo', 'todo'], done: ['done', 'done', 'done', 'done'], failed: ['failed', 'skipped', 'skipped', 'skipped'], over_budget: ['failed', 'skipped', 'skipped', 'skipped'] };
    for (const state of Object.keys(EXPERIMENTS)) {
      await send(page, `/lab report ${state}`);
      const card = page.locator(`#chat-container .lab-card[data-pose="${state}"]`).last();
      await card.waitFor();
      assert.equal(await card.getAttribute('data-pose'), state);
      assert.ok(await card.locator('.lab-bot').count(), 'the mascot is drawn');
      assert.deepEqual(await card.locator('.lab-track li').evaluateAll((els) => els.map((e) => e.dataset.state)), expectStage[state], `${state}: stage track`);
      // the pose's own props are the ones on screen
      const visible = await card.evaluate((el) => ['.p-clip', '.p-flask', '.p-up', '.p-smoke', '.p-coin'].filter((s) => getComputedStyle(el.querySelector(s)).display !== 'none'));
      assert.deepEqual(visible, { queued: ['.p-clip'], running: ['.p-flask'], done: ['.p-up'], failed: ['.p-smoke'], over_budget: ['.p-coin'] }[state]);
      // beaker: the fill is the real spend over the cap; red from 90%
      const e = EXPERIMENTS[state];
      assert.equal(await card.locator('.bk-liquid').evaluate((el) => el.style.getPropertyValue('--fill').trim()), (e.spent_usd / e.budget_usd).toFixed(3));
      assert.equal(await card.locator('.lab-beaker').evaluate((el) => el.classList.contains('is-high')), state === 'over_budget');
      const anims = await runningIn(card);
      if (state === 'queued') assert.ok(anims.includes('bot-tap'), 'queued: taps the clipboard');
      if (state === 'running') assert.ok(anims.includes('bot-stir') && anims.includes('bot-bubble') && anims.includes('dot-pulse'), 'running: stirs, bubbles, the current stage pulses');
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
    for (const st of ['flagged', 'unknown', 'no_flags']) assert.equal(await card.locator(`.blip.s-${st}`).count(), RADAR.counts[st], st);
    assert.ok(RADAR.counts.flagged >= 2 && RADAR.counts.unknown >= 1 && RADAR.counts.no_flags >= 1, 'the seed covers every status');
    assert.ok(await card.locator('.radar-find', { hasText: 'CVE-2026-40877' }).locator('.kev-badge').count(), 'an actively exploited CVE has the KEV badge');
    assert.match(await card.locator('.radar-asof').innerText(), /^Data as of 16 Oct 2026, 09:46 \(Ireland time\)$/);
    // Sparklines: one per feed that was read, 7 days each.
    assert.deepEqual(await card.locator('.radar-feed .radar-feed-name').allInnerTexts(), ['NVD', 'CISA KEV']);
    assert.equal(await card.locator('.spark-line').count(), 2);
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
  assert.deepEqual(await card.locator('.lab-track li').evaluateAll((els) => els.map((e) => e.dataset.state)), ['done', 'done', 'todo', 'todo'], 'built a candidate; the gate has not run yet');
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
  // The states are still readable without motion: smoke shows, the coin lies where it rolled.
  assert.equal(await page.locator('.lab-card[data-pose="failed"] .b-smk').first().evaluate((el) => getComputedStyle(el).opacity), '0.5');
  assert.equal(await page.locator('.lab-card[data-pose="over_budget"] .b-cn').evaluate((el) => getComputedStyle(el).transform), 'none', 'the coin rests where it rolled to');
  await send(page, '/usage');
  const toast = page.locator('.milestone');
  await toast.waitFor();
  assert.deepEqual(await toast.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.effect && a.effect.getComputedTiming().duration > 1).map((a) => a.animationName)), []);
  assert.deepEqual(problems, []);
});
