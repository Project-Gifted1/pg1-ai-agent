/**
 * The Command Centre surfaces in the Living lab style (PR A), in a real
 * browser at phone width (380 px, dark):
 *  1. /help is the command panel: every command in the registry is a card
 *     with a working Run button (no-arg commands run on a tap, commands
 *     with arguments open a form, dangerous ones ask to confirm); search
 *     filters by name or description; the groups fold, the most used first.
 *     The same panel opens from the / button and the ➕ menu.
 *  2. The error log is a timeline of cards: severity, area, a plain
 *     summary, details with request_id; repeats grouped ("×12 in the last
 *     hour"); FIX never on a network entry; Copy details; Dismiss; the
 *     filter row; Clear dismissed; no secret is ever shown.
 *  3. The check result card: the target with copy, a large status badge
 *     ("No flags found", never the word safe), reason-code chips linking
 *     to /docs/reason-codes, sub-check rows, request_id, Verify, Run
 *     preflight, Re-check, Raw JSON; "Test fixture" on fixture results;
 *     several checks as a stacked list.
 *  Reduced motion: no animation, the same layout.
 *
 * Writes docs/screenshots/cc-*-380-dark.png.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/command-centre.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { startCommandCentreServer, openPhonePage, sendAndSettle, checkCards, errorRows, radarView } from '../helpers/commandCentre.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');
const REGISTRY = JSON.parse(readFileSync(join(PUBLIC_DIR, 'commands.json'), 'utf8'));

let chromium = null;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  skip = 'playwright is not installed (npm install)';
}
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()}`;

test('Command Centre: /help panel, error log timeline and check result card at 380 px', { skip, timeout: 240000 }, async (t) => {
  const { server, log, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, cards: await checkCards(), errors: errorRows(), radar: await radarView() });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, errors } = await openPhonePage(browser, origin, { routeReplyFont });
  await page.waitForFunction(() => window.commandRegistry && Array.isArray(window.commandRegistry.commands));
  mkdirSync(SHOTS_DIR, { recursive: true });

  // --- 1. /help: the command panel ------------------------------------------------
  const help = await sendAndSettle(page, '/help');
  const panel = help.locator('.cmd-panel');
  assert.equal(await panel.count(), 1, '/help answers with the panel');
  assert.doesNotMatch(await help.locator('.message-content, .markdown-body').first().innerText().catch(() => ''), /^- `\//m, 'no bullet list');
  const cards = await panel.locator('.cmd-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-command')));
  assert.deepEqual([...cards].sort(), REGISTRY.commands.map((c) => c.command).sort(), 'a card for every command in the registry');
  assert.equal(await panel.locator('.cmd-card .cmd-run').count(), REGISTRY.commands.length, 'every card has a Run button');
  assert.deepEqual(await panel.locator('.cmd-group > summary > span:first-child').allTextContents(), REGISTRY.areas, 'grouped by area, in registry order before any use');
  assert.equal(await panel.locator('.cmd-group[open]').count(), 1, 'one group open');
  assert.equal(await panel.locator('.cmd-card[data-command="/auto on"] .lx-badge', { hasText: 'Confirms' }).count(), 1, 'dangerous badge');
  assert.equal(await panel.locator('.cmd-card[data-command="/keys"] .lx-badge', { hasText: 'Operator' }).count(), 1, 'operator-only badge');
  await help.locator('.cmd-group[open] .cmd-card').nth(2).scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS_DIR, 'cc-help-panel-380-dark.png') });

  // Search: by name or by description.
  await panel.locator('.cmd-search').fill('kill switch');
  assert.deepEqual(await panel.locator('.cmd-card:visible').evaluateAll((els) => els.map((e) => e.getAttribute('data-command'))), ['/auto off', '/autonomy'], 'found by description');
  await panel.locator('.cmd-search').fill('/keys');
  assert.deepEqual((await panel.locator('.cmd-card:visible').evaluateAll((els) => els.map((e) => e.getAttribute('data-command')))).sort(), ['/keys', '/keys fresh']);
  await panel.locator('.cmd-search').fill('zzzz-nothing');
  assert.equal(await panel.locator('.cmd-none').isVisible(), true);
  await panel.locator('.cmd-search').fill('');

  // A no-arg command runs on a tap.
  let before = log.prompts.length;
  await panel.locator('.cmd-group[data-area="Keys & usage"]').evaluate((d) => { d.open = true; });
  await panel.locator('.cmd-card[data-command="/keys fresh"] .cmd-run').click();
  await page.waitForFunction((k) => document.querySelectorAll('#chat-container .message-bubble:not(.user)').length > k && !document.querySelector('#chat-container .message-bubble.pending'), 1);
  assert.deepEqual(log.prompts.slice(before), ['/keys fresh']);

  // The most used group comes first and open.
  await page.click('#cmd-panel-btn');
  const sheet = page.locator('#cmd-panel-list .cmd-panel');
  await sheet.waitFor({ state: 'visible' });
  assert.equal(await sheet.locator('.cmd-group').first().getAttribute('data-area'), 'Keys & usage', 'most used first');
  assert.equal(await sheet.locator('.cmd-group').first().evaluate((d) => d.open), true);

  // Dangerous: asks first, runs on the second tap.
  await sheet.locator('.cmd-search').fill('/auto on');
  const autoOn = sheet.locator('.cmd-card[data-command="/auto on"] .cmd-run');
  before = log.prompts.length;
  await autoOn.click();
  assert.match(await autoOn.innerText(), /Tap again to confirm/);
  assert.equal(log.prompts.length, before, 'not sent on the first tap');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS_DIR, 'cc-command-sheet-380-dark.png') });
  await autoOn.click();
  await page.waitForFunction((k) => document.querySelectorAll('#chat-container .message-bubble:not(.user)').length > k && !document.querySelector('#chat-container .message-bubble.pending'), 2);
  assert.equal(log.prompts[log.prompts.length - 1], '/auto on');

  // Arguments: a form inside the card, then the full command.
  await page.click('#cmd-panel-btn');
  await sheet.locator('.cmd-search').fill('relay');
  await sheet.locator('.cmd-card[data-command="/relay"] .cmd-run').click();
  const form = sheet.locator('.cmd-card[data-command="/relay"] .cmd-form');
  await form.waitFor({ state: 'visible' });
  await form.locator('[data-arg="0"]').fill('Grok');
  await form.locator('[data-arg="1"]').fill('hello PG1');
  before = log.prompts.length;
  await form.locator('.cmd-form-run').click();
  await page.waitForFunction((k) => document.querySelectorAll('#chat-container .message-bubble:not(.user)').length > k && !document.querySelector('#chat-container .message-bubble.pending'), 3);
  assert.equal(log.prompts[log.prompts.length - 1], '/relay Grok hello PG1');

  // The ➕ menu opens the same panel.
  await page.click('#quick-menu-btn');
  await page.click('#cmd-menu-item');
  await sheet.waitFor({ state: 'visible' });
  await page.click('#cmd-modal .modal-close');

  // EVERY command: its Run button works (runs, opens its form, or asks to
  // confirm and then runs). The send is captured so nothing is sent.
  const results = await page.evaluate(async () => {
    const sent = [];
    const realSend = window.sendCommand;
    const realQuick = window.runQuick;
    const realSubmit = window.submitDirective;
    window.sendCommand = (c) => sent.push(c);
    window.runQuick = (c) => sent.push(c);
    window.submitDirective = () => sent.push(document.getElementById('prompt-input').value);
    const out = [];
    try {
      for (const c of window.commandRegistry.commands) {
        await openCommandPanel();
        const card = document.querySelector(`#cmd-panel-list .cmd-card[data-command="${CSS.escape(c.command)}"]`);
        const btn = card && card.querySelector('.cmd-run');
        if (!btn) { out.push({ command: c.command, problem: 'no card or no Run button' }); continue; }
        const n = sent.length;
        if (c.args.length) {
          btn.click();
          const form = card.querySelector('.cmd-form');
          if (!form || form.hidden) { out.push({ command: c.command, problem: 'Run did not open the form' }); continue; }
          form.querySelectorAll('[data-arg]').forEach((f, i) => { if (f.tagName === 'SELECT') f.value = f.options[f.options.length - 1].value; else f.value = c.args[i].required ? 'x1' : ''; });
          const run = form.querySelector('.cmd-form-run');
          run.click();
          if (c.dangerous) {
            if (sent.length !== n) { out.push({ command: c.command, problem: 'dangerous ran without confirming' }); continue; }
            run.click();
          }
        } else {
          btn.click();
          if (c.dangerous) {
            if (sent.length !== n) { out.push({ command: c.command, problem: 'dangerous ran without confirming' }); continue; }
            btn.click();
          }
        }
        const got = sent[sent.length - 1];
        if (sent.length !== n + 1 || !String(got).startsWith(c.command)) out.push({ command: c.command, problem: `sent ${JSON.stringify(sent.slice(n))}` });
      }
    } finally {
      window.sendCommand = realSend; window.runQuick = realQuick; window.submitDirective = realSubmit;
      closeCommandPanel();
    }
    return out;
  });
  assert.deepEqual(results, [], 'every registry command has a card whose Run button works');

  // --- 2. The error log --------------------------------------------------------
  await page.evaluate(() => { localStorage.setItem('pg1_error_log', JSON.stringify([{ time: new Date().toISOString(), message: 'Offline: message not sent. Check your connection and try again.', context: 'submitDirective', category: 'offline', retryText: 'how are the feeds today?' }])); });
  await page.click('#quick-menu-btn');
  await page.locator('#quick-menu .quick-chip', { hasText: 'Error log' }).click();
  const list = page.locator('#error-log-list');
  await list.locator('.err-card').first().waitFor();
  const cardsEl = list.locator('.err-card');
  assert.equal(await cardsEl.count(), 5, 'four server rows and the retryable local entry');
  assert.equal(await cardsEl.first().getAttribute('data-category'), 'offline', 'newest first');
  const first = list.locator('.err-card[data-area="router"]');
  assert.equal(await first.getAttribute('data-severity'), 'error');
  assert.match(await first.locator('.err-repeat').innerText(), /×12 in the last hour/);
  assert.equal(await list.locator('.err-card[data-area="tool"]').count(), 1);
  assert.equal(await list.locator('.err-card[data-area="film"]').count(), 1);
  const allText = await list.innerText();
  assert.doesNotMatch(allText, /sk-ant-api03|SECRETSECRET/, 'no secret on screen');
  await first.locator('.err-details > summary').click();
  assert.match(await first.locator('.err-details').innerText(), /req7f3a91c2/);
  assert.match(await first.locator('.err-details').innerText(), /\[secret withheld\]/);
  // FIX: never on network/offline entries; on the code bug.
  for (const area of ['router', 'film']) assert.equal(await list.locator(`.err-card[data-area="${area}"] button`, { hasText: 'FIX' }).count(), 1, `FIX on the ${area} bug`);
  assert.equal(await list.locator('.err-card[data-category="upstream"] button', { hasText: 'FIX' }).count(), 0, 'no FIX on an upstream source that did not answer');
  assert.equal(await list.locator('.err-card[data-category="network"] button', { hasText: 'FIX' }).count(), 0, 'no FIX on a network entry');
  assert.equal(await list.locator('.err-card[data-category="offline"] button', { hasText: 'FIX' }).count(), 0, 'no FIX on an offline entry');
  assert.equal(await list.locator('.err-card[data-category="offline"] button', { hasText: 'Retry' }).count(), 1, 'Retry on a failed message from this device');
  for (const c of await cardsEl.all()) assert.equal(await c.locator('button', { hasText: 'Copy details' }).count(), 1);
  await page.waitForTimeout(400);
  await page.locator('#error-log-modal .modal-head').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS_DIR, 'cc-error-log-380-dark.png') });
  // Copy details never copies a secret.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await first.locator('button', { hasText: 'Copy details' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /request_id: req7f3a91c2/);
  assert.doesNotMatch(copied, /sk-ant|SECRETSECRET/);
  // Filters.
  await page.click('#error-log-filter button[data-filter="warnings"]');
  assert.deepEqual(await list.locator('.err-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-severity'))), ['warning']);
  await page.click('#error-log-filter button[data-filter="fixable"]');
  assert.equal(await list.locator('.err-card').count(), 2, 'the router and film entries are fixable');
  await page.click('#error-log-filter button[data-filter="errors"]');
  assert.equal(await list.locator('.err-card').count(), 2);
  await page.click('#error-log-filter button[data-filter="all"]');
  // Dismiss, then Clear dismissed.
  await list.locator('.err-card[data-area="film"] button', { hasText: 'Dismiss' }).click();
  await page.waitForFunction(() => document.querySelector('#error-log-list .err-card[data-area="film"].is-muted'));
  assert.ok(log.resolved.includes('e3'), 'a server entry is marked resolved');
  await page.click('#error-clear-dismissed');
  assert.equal(await list.locator('.err-card[data-area="film"]').count(), 0);
  await page.click('#error-log-modal .modal-close');

  // --- 3. The check result card ------------------------------------------------
  const one = await sendAndSettle(page, 'check that wallet');
  const card = one.locator('.chk-card');
  assert.equal(await card.count(), 1);
  assert.equal(await card.getAttribute('data-status'), 'flagged');
  assert.equal(await card.locator('.chk-top .lx-pill.is-lg').innerText(), 'Flagged');
  assert.equal(await card.locator('.lx-badge', { hasText: 'Test fixture' }).count(), 1);
  assert.match(await card.locator('.chk-target code').innerText(), /^0x7067…/);
  assert.equal(await card.locator('a.lx-chip[href^="/docs/reason-codes#"]').count() > 0, true, 'reason-code chips link to the docs');
  assert.ok(await card.locator('.tool-checks .lx-row').count() > 0, 'sub-check rows');
  assert.equal(await card.locator('.chk-signed').textContent(), 'Unsigned');
  for (const label of ['Verify', 'Run preflight', 'Re-check']) assert.equal(await card.locator('.chk-actions button', { hasText: label }).count(), 1, label);
  assert.match(await card.locator('.tool-meta').innerText(), /request_id/);
  await card.locator('.chk-verify').click();
  assert.match(await card.locator('.chk-verify-note').innerText(), /Not signed/);
  await card.locator('.tool-raw-toggle').click();
  assert.equal(await card.locator('.tool-raw-json').isVisible(), true);
  await card.locator('.tool-raw-toggle').click();
  await one.locator('.chk-card').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await one.locator('.chk-card').screenshot({ path: join(SHOTS_DIR, 'cc-check-card-380-dark.png') });

  const many = await sendAndSettle(page, 'check these three');
  const items = many.locator('.chk-stack .chk-item');
  assert.equal(await items.count(), 3, 'a stacked list');
  assert.deepEqual(await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-status'))), ['no_flags', 'flagged', 'upstream_unavailable']);
  assert.deepEqual(await items.locator('summary .lx-pill').allInnerTexts(), ['No flags found', 'Flagged', 'Upstream unavailable']);
  await items.nth(1).locator('summary').click();
  assert.equal(await items.nth(1).locator('.chk-card').isVisible(), true, 'expands per item');
  await many.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await many.screenshot({ path: join(SHOTS_DIR, 'cc-check-stack-380-dark.png') });
  // Re-check sends a free check as a message.
  before = log.prompts.length;
  await card.locator('.chk-recheck').click();
  await page.waitForFunction((k) => document.querySelectorAll('#chat-container .message-bubble:not(.user)').length > k && !document.querySelector('#chat-container .message-bubble.pending'), 6);
  assert.match(log.prompts[before], /^Check 0x7067312d/);

  // --- 4. The threat radar (operator videos, 20 Oct) -----------------------------
  // The radar card in the lab style: its tone, status pills; never stuck on
  // "Reading the feeds…".
  const radarReply = await sendAndSettle(page, '/threat-radar');
  const radar = radarReply.locator('.radar-card');
  assert.equal(await radar.count(), 1, 'the radar card, not a typed-out table');
  assert.equal(await radarReply.locator('.radar-card.is-loading').count(), 0, 'not stuck loading');
  assert.ok(await radar.evaluate((el) => el.classList.contains('lx-card')), 'built from the shared lab components');
  assert.equal(await radar.getAttribute('data-tone'), 'err', 'actively exploited findings: the red edge');
  assert.ok((await radar.locator('.radar-status[data-tone="err"]').count()) >= 1);
  // The whole card in one shot: the viewport grown, then back to the phone.
  await page.setViewportSize({ width: 380, height: 1700 });
  await radarReply.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(800);
  await radar.screenshot({ path: join(SHOTS_DIR, 'cc-threat-radar-380-dark.png') });
  await page.setViewportSize({ width: 380, height: 844 });

  // Never the word "safe" on any of the three surfaces.
  const words = await page.evaluate(() => [document.querySelector('#chat-container').innerText, document.querySelector('#cmd-modal').innerText, document.querySelector('#error-log-modal').innerText].join('\n'));
  assert.doesNotMatch(words, /\bsafe\b/i);
  assert.deepEqual(errors, []);
});

test('Command Centre with reduced motion: no animation, same layout', { skip, timeout: 120000 }, async (t) => {
  const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, cards: await checkCards(), errors: errorRows() });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const boxes = {};
  for (const motion of ['no-preference', 'reduce']) {
    const { page, context, errors } = await openPhonePage(browser, origin, { routeReplyFont, reducedMotion: motion });
    await page.waitForFunction(() => window.commandRegistry && Array.isArray(window.commandRegistry.commands));
    const reply = await sendAndSettle(page, 'check that wallet');
    await page.waitForTimeout(800);
    const anim = await reply.evaluate((el) => Array.from(el.querySelectorAll('.lx-card, .lx-pill, .lx-btn')).map((n) => getComputedStyle(n).animationName).filter((a) => a && a !== 'none'));
    if (motion === 'reduce') assert.deepEqual(anim, [], 'nothing animates');
    else assert.ok(anim.length > 0, 'the card rises in');
    boxes[motion] = await reply.locator('.chk-card').evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert.deepEqual(boxes.reduce, boxes['no-preference'], 'the same layout');
});
