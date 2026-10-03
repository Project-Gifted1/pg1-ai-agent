/**
 * A check from chat in a real browser (Chromium via Playwright): the live
 * trace rows per call, the result cards under the reply, light and dark.
 *
 * The page is served from public/ as deployed; /api/chat is a stub that
 * answers a streamed request with the exact events the server sends for a
 * fixture check. The card data is not hand-written: it comes from
 * lib/chatTools.mjs running the real fixture outcomes through
 * createToolExecutor + summarizeOutcome + traceLabels, so what is drawn
 * here is what the server produces.
 *
 * Asserts: no page or console errors, one trace row per call with its
 * duration, a card per call with the status chip, the shortened address
 * in the title and the full one in the Raw JSON expander, the copy button,
 * and that the chip text is readable in both themes (AA). Writes the
 * 412px screenshots under docs/screenshots/ (tool-wallet-412-*.png,
 * tool-domain-412-*.png) for the PR.
 *
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: npm run test:browser   (or: node --test tests/browser/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolExecutor, summarizeOutcome, traceLabels, spokenSummary } from '../../lib/chatTools.mjs';
import { FIXTURE_VALUES } from '../../lib/fixtures.mjs';

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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8'
};

const WALLET = FIXTURE_VALUES.wallet;
const DOMAIN = FIXTURE_VALUES.domain;

// What the server streams for each demo: built from the real outcomes.
async function buildScenario(name) {
  const execute = createToolExecutor({ role: 'operator', log: () => {} });
  const calls = name === 'wallet'
    ? [{ id: 'c1', name: 'check_wallet_sanctions', args: { address: WALLET.FLAGGED } }, { id: 'c2', name: 'check_wallet_age', args: { address: WALLET.FLAGGED } }]
    : [{ id: 'c1', name: 'check_domain_age', args: { domain: DOMAIN.CLEAN } }, { id: 'c2', name: 'check_hostname_reputation', args: { hostname: DOMAIN.CLEAN } }];
  const outcomes = [];
  for (const call of calls) outcomes.push(await execute(call));
  const durations = [412, 287];
  const events = [
    { type: 'step', id: 'db', label: 'Checking the database connection' },
    { type: 'step_done', id: 'db', label: 'Checked the database', result: 'connected', ms: 61 },
    { type: 'step', id: 'model', label: 'Writing the reply' },
    { type: 'step_done', id: 'model', label: `Chose ${calls.length} checks`, result: calls.map((c) => traceLabels(c).running.replace(/^Checking /, '').replace(/ · .*$/, '')).join(', '), ms: 1480 }
  ];
  calls.forEach((call) => events.push({ type: 'step', id: `tool-${call.id}`, label: traceLabels(call).running }));
  outcomes.forEach((o, i) => {
    const labels = traceLabels(calls[i], o);
    const done = { type: 'step_done', id: `tool-${calls[i].id}`, label: labels.label, result: labels.result, ms: durations[i] };
    if (labels.failed) done.failed = true;
    events.push(done);
    events.push({ type: 'tool_result', ...summarizeOutcome({ ...o, ms: durations[i] }) });
  });
  events.push({ type: 'step', id: 'model-2', label: 'Writing the reply from the results' });
  const reply = name === 'wallet'
    ? `Both checks are **flagged** for this wallet.\n\n- Wallet sanctions: status "flagged", reason WALLET_SANCTIONED. The address matches an entry on the sanctions list.\n- Wallet age: status "flagged", reason WALLET_NO_HISTORY. No transfer history on base, so it has never been used there.\n\nDo not transact with it. Both results are test fixtures, so no upstream source was called.`
    : `Nothing was flagged for this domain, which is not the same as safe.\n\n- Domain age: status "no_flags". Registered on 2000-01-01, so it is well past the 30-day window used as a phishing signal.\n- Hostname reputation: status "no_flags", verdict not_listed: it is not on the phishing list, and it is not a lookalike of a known brand.\n\nBoth results are test fixtures, so no upstream source was called.`;
  for (const chunk of reply.match(/[\s\S]{1,40}/g)) events.push({ type: 'text', text: chunk });
  const words = reply.split(/\s+/).filter(Boolean).length;
  events.push({ type: 'step_done', id: 'model-2', label: 'Wrote the reply', result: `${words} words`, ms: 2210 });
  events.push({ type: 'done', request_id: 'demo-request', spokenSummary: spokenSummary(outcomes) + ' The full result is on screen.' });
  return { events, outcomes, calls };
}

function startStubServer(scenarios) {
  const log = { requests: [], missing: [] };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      log.requests.push({ method: req.method, path: url.pathname, body: parsed });
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
        if (url.pathname === '/api/errors') return json(res, 200, { errors: [], ok: true });
        if (url.pathname === '/api/handoffs') return json(res, 200, { handoffs: [] });
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(res, 200, { authenticated: true });
          if (parsed && parsed.stream === true) {
            const which = /0x/.test(parsed.prompt) ? 'wallet' : 'domain';
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.write(': pg1 trace\n\n');
            const events = scenarios[which].events;
            let i = 0;
            const tick = () => {
              if (i >= events.length) return res.end();
              const ev = events[i++];
              res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
              setTimeout(tick, 15);
            };
            tick();
            return;
          }
          return json(res, 200, { reply: 'Plain reply.' });
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
    server.listen(0, '127.0.0.1', () => resolveServer({ server, log, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

// WCAG contrast of two sRGB colours.
function luminance([r, g, b]) {
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
const parseRgb = (s) => { const m = String(s).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/); return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null; };
// Composites a translucent chip background over the card surface.
function over(fg, bg) {
  const a = fg[3];
  return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a)));
}

for (const theme of ['light', 'dark']) {
  test(`a wallet check and a domain check in the browser (${theme}): trace rows, cards, AA chips, screenshots`, { skip, timeout: 180000 }, async (t) => {
    const scenarios = { wallet: await buildScenario('wallet'), domain: await buildScenario('domain') };
    const { server, log, origin } = await startStubServer(scenarios);
    const browser = await chromium.launch();
    t.after(async () => {
      await browser.close();
      await new Promise((r) => server.close(r));
    });
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme });
    await context.addInitScript((value) => { try { localStorage.setItem('pg1_theme', value); } catch (e) {} }, theme);
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(origin + '/', { waitUntil: 'load' });
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), theme);
    await page.fill('#auth-user', 'operator');
    await page.fill('#auth-pass', 'passkey');
    await page.press('#auth-pass', 'Enter');
    await page.waitForSelector('#auth-modal', { state: 'hidden' });
    mkdirSync(SHOTS_DIR, { recursive: true });

    for (const [which, prompt] of [['wallet', `check this wallet ${WALLET.FLAGGED}`], ['domain', `how old is ${DOMAIN.CLEAN}`]]) {
      const scenario = scenarios[which];
      // A fresh conversation for each shot.
      await page.evaluate(() => { clearChat(); });
      await page.fill('#prompt-input', prompt);
      await page.click('.execute-btn');
      await page.waitForFunction(() => {
        const bubbles = document.querySelectorAll('#chat-container .message-bubble:not(.user):not(.welcome)');
        const last = bubbles[bubbles.length - 1];
        return last && !last.classList.contains('pending') && last.querySelectorAll('.tool-card').length === 2;
      }, null, { timeout: 30000 });
      const sent = log.requests.filter((r) => r.path === '/api/chat' && r.body && r.body.prompt === prompt);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].body.stream, true, 'the signed-in page asked for a stream');

      const bubble = page.locator('#chat-container .message-bubble:not(.user):not(.welcome)').last();
      // The header pill opens the trace: one row per call with the server's duration.
      await bubble.locator('.trace-pill').click();
      const rows = await bubble.locator('.trace-steps .trace-row').evaluateAll((els) => els.map((el) => ({ text: el.textContent.replace(/\s+/g, ' ').trim(), failed: el.classList.contains('is-failed') })));
      assert.equal(rows.length, 5, 'db, the round that chose the checks, one row per call, the answer round');
      for (const [i, call] of scenario.calls.entries()) {
        const labels = traceLabels(call, scenario.outcomes[i]);
        const row = rows.find((r) => r.text.includes(labels.label));
        assert.ok(row, `a row for ${labels.label}`);
        assert.ok(row.text.includes(labels.result), `row carries "${labels.result}"`);
        assert.equal(row.failed, !!labels.failed);
        assert.ok(/took 0\.[34]s|0\.[34]s/.test(row.text), `the server duration is shown: ${row.text}`);
      }

      // The cards.
      const cards = bubble.locator('.tool-card');
      assert.equal(await cards.count(), 2);
      for (const [i, outcome] of scenario.outcomes.entries()) {
        const expected = summarizeOutcome(outcome);
        const card = cards.nth(i);
        assert.match(await card.locator('.tool-card-title').textContent(), new RegExp(`^${expected.title} · ${expected.subject_short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
        assert.equal(await card.locator('.tool-chip').textContent(), expected.status_label);
        const raw = card.locator('.tool-raw');
        assert.equal(await raw.isHidden(), true, 'raw JSON collapsed');
        await card.locator('.tool-raw-toggle').click();
        assert.equal(await raw.isVisible(), true);
        assert.equal(await raw.locator('.tool-raw-full').first().textContent(), expected.subject, 'the full value in the expander');
        assert.ok((await raw.locator('.tool-raw-json').textContent()).includes(expected.request_id));
        assert.equal(await card.locator('.tool-copy').count(), 1);
        if (i === 1 || which === 'wallet') await card.locator('.tool-raw-toggle').click();
        // Chip contrast: text over the composited chip background, AA (4.5:1).
        const colours = await card.locator('.tool-chip').evaluate((el) => {
          const cs = getComputedStyle(el);
          const surface = getComputedStyle(el.closest('.tool-card')).backgroundColor;
          return { color: cs.color, background: cs.backgroundColor, surface };
        });
        const fg = parseRgb(colours.color);
        const bg = over(parseRgb(colours.background), parseRgb(colours.surface));
        const ratio = contrast(fg.slice(0, 3), bg);
        assert.ok(ratio >= 4.5, `${theme} ${expected.status_label} chip contrast ${ratio.toFixed(2)}:1`);
      }
      // (The first card's raw JSON stays open on the domain shot, closed on the wallet shot.)

      // No horizontal overflow at 412px.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(overflow, false, 'no horizontal page scroll');

      // The screenshot: the viewport grown to show the whole reply.
      const box = await bubble.boundingBox();
      const header = await page.evaluate(() => (document.querySelector('header') || document.body).getBoundingClientRect().height);
      await page.setViewportSize({ width: 412, height: Math.min(4000, Math.ceil(box.height + header + 220)) });
      await bubble.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(150);
      await page.screenshot({ path: join(SHOTS_DIR, `tool-${which}-412-${theme}.png`) });
      await page.setViewportSize({ width: 412, height: 915 });
    }

    assert.deepEqual(pageErrors, [], 'no page errors');
    assert.deepEqual(consoleErrors, [], 'no console errors');
    assert.deepEqual(log.missing, [], 'nothing 404ed');
  });
}
