/**
 * /state and /lessons in a real browser (Chromium via Playwright), at
 * 380 px: the Core State card (capabilities with status, reason and fix,
 * focus, spend, open problems, events) and the lessons card (Approve on a
 * proposed lesson moves it to approved; Retire stops it), both in the
 * Living lab style (public/lab/lab-ui.css).
 *
 * The page is served from public/ as deployed; /api/chat answers /state
 * and /lessons with the real handlers (lib/core/chat.mjs) on this process's
 * in-memory workspace.
 *
 * Writes docs/screenshots/core-state-380-dark.png and
 * docs/screenshots/core-lessons-380-dark.png.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCommandCentreServer, openPhonePage, sendAndSettle } from '../helpers/commandCentre.mjs';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { handleStateCommand, handleLessonsCommand } from '../../lib/core/chat.mjs';
import { createCoreState, __resetCoreState } from '../../lib/core/state.mjs';
import { createLessonStore, __resetLessons } from '../../lib/core/reflect.mjs';
import { tripBreaker, __resetRouterState } from '../../lib/aiRouter.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');

let chromium = null;
let skip = false;
try { ({ chromium } = await import('playwright')); } catch (e) { skip = 'playwright is not installed (npm install)'; }
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()}`;

test('/state and /lessons cards at 380 px: statuses with reasons and fixes, Approve and Retire', { skip, timeout: 180000 }, async (t) => {
  __resetCoreState();
  __resetLessons();
  // A workspace with something to show: the media engine out of credit,
  // a lab run going, two repeated failures to reflect on.
  __resetRouterState();
  tripBreaker('replicate', 402, 'insufficient credit');
  const core = createCoreState();
  await core.event('media', { kind: 'out_of_credit', severity: 'error', summary: 'Film stage 2 stopped: the media engine is out of credit' });
  await core.event('media', { kind: 'out_of_credit', severity: 'error', summary: 'Film stage 3 stopped: the media engine is out of credit' });
  // A daily cap set, so the media engine's credit is what stops films.
  const env = { GEMINI_API_KEY_FREE: 'k', REPLICATE_API_TOKEN: 'r', PG1_LAB_DISPATCH_SECRET: 's', PG1_DAILY_SPEND_CAP_USD: '5' };
  const answers = async (prompt) => {
    if (prompt === '/state') return handleStateCommand({ env, isOperator: true });
    if (/^\/lessons\b/.test(prompt)) return handleLessonsCommand({ text: prompt, isOperator: true });
    return null;
  };
  const { server, log, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, answers });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __resetRouterState(); });
  const { page, errors } = await openPhonePage(browser, origin, { width: 380, routeReplyFont });

  // /state
  const stateReply = await sendAndSettle(page, '/state');
  const card = stateReply.locator('.core-state-card');
  await card.waitFor();
  assert.equal(await card.getAttribute('data-tone'), 'err', 'something is unavailable');
  const films = card.locator('.core-caps .lx-row[data-cap="films"]');
  assert.equal(await films.getAttribute('data-tone'), 'err');
  assert.match(await films.innerText(), /Films[\s\S]*unavailable[\s\S]*the media engine is out of credit[\s\S]*Fix:[\s\S]*add credit/i);
  assert.match(await card.locator('.core-focus').innerText(), /^Idle: waiting for your next request/);
  assert.match(await card.locator('.core-problems').innerText(), /Films unavailable: the media engine is out of credit/);
  assert.match(await card.locator('details.lx-details').innerText(), /Latest events \(2\)/);
  assert.equal(await card.locator('.core-caps .lx-row').count(), 16);
  const text = await card.innerText();
  assert.doesNotMatch(text, /gemini|google|replicate|anthropic|openai|groq|mistral|cartesia|elevenlabs/i, 'no engine names');
  assert.doesNotMatch(text, /\bsafe\b/i);
  const box = await card.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 380, 'fits 380 px');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
  mkdirSync(SHOTS_DIR, { recursive: true });
  // The card's top just under the header.
  await card.evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    const scroller = document.getElementById('chat-container');
    const header = document.querySelector('header');
    if (scroller) scroller.scrollTop -= (header ? header.getBoundingClientRect().height : 60) + 8;
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS_DIR, 'core-state-380-dark.png'), fullPage: false });

  // /lessons reflect -> a proposed lesson with Approve
  const reflectReply = await sendAndSettle(page, '/lessons reflect');
  const lessonsCard = reflectReply.locator('.core-lessons-card');
  await lessonsCard.waitFor();
  assert.match(await lessonsCard.innerText(), /What PG1 reflected on \(1\)[\s\S]*2 × out of credit in media/);
  const proposed = lessonsCard.locator('.core-lesson[data-tone="think"]');
  assert.equal(await proposed.count(), 1);
  await proposed.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS_DIR, 'core-lessons-380-dark.png'), fullPage: false });

  // Approve: the lesson acts (approved), and its Retire button is there.
  const id = await proposed.getAttribute('data-lesson');
  const approveReply = await sendAndSettleClick(page, proposed.locator('button', { hasText: 'Approve' }));
  assert.equal(log.prompts.at(-1), `/lessons approve ${id}`);
  assert.match(await approveReply.innerText(), /It acts from now on, as a hint only/);
  const approved = approveReply.locator(`.core-lesson[data-lesson="${id}"]`);
  assert.equal(await approved.getAttribute('data-tone'), 'ok');
  assert.equal(await createLessonStore().list({ status: 'approved' }).then((l) => l.length), 1);

  // Retire it.
  const retireReply = await sendAndSettleClick(page, approved.locator('button', { hasText: 'Retire' }));
  assert.match(await retireReply.innerText(), /It no longer acts/);
  assert.equal(await createLessonStore().list({ status: 'approved' }).then((l) => l.length), 0);

  assert.deepEqual(errors, []);
});

async function sendAndSettleClick(page, button) {
  const n = await page.locator('#chat-container .message-bubble:not(.user)').count();
  await button.click();
  await page.waitForFunction((k) => {
    const b = document.querySelectorAll('#chat-container .message-bubble:not(.user)');
    return b.length > k && !b[b.length - 1].classList.contains('pending');
  }, n);
  return page.locator('#chat-container .message-bubble:not(.user)').nth(n);
}
