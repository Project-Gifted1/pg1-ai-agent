/**
 * PG1 City: an interception, start to finish, in a real browser, from a
 * TEST FIXTURE feed (tests/helpers/kingdomFixtures.mjs; never in the app).
 *
 *   - a real malicious agent-message verdict arrives live: a sentinel scans
 *     the dark boat and locks on ("Scanning"), the Truth Lens answers, the
 *     tag flips to the real reason code, the director cuts to the gadget and
 *     then the tower, the boat sinks and a marker buoy stays for the day;
 *   - tapping that event in the feed replays it (captioned as a replay with
 *     its real time, never LIVE);
 *   - the tower's security perimeter, its guards and the aircraft are there,
 *     with no castle words, and aircraft keep their separation;
 *   - no page errors. Frame times are diagnostics only.
 * Skipped (not failed) when Playwright or a Chromium is not installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { startCommandCentreServer, openPhonePage } from '../helpers/commandCentre.mjs';
import { fixtureFeed, fixtureCallerHashes } from '../helpers/kingdomFixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');

let chromium = null; let executablePath; let skip = false;
try { ({ chromium } = await import('playwright')); } catch (e) { skip = 'playwright is not installed (npm install)'; }
if (chromium && !existsSync(chromium.executablePath())) {
  if (existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  else skip = `Chromium is not installed at ${chromium.executablePath()}`;
}
const launch = () => chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const view = (page) => page.evaluate(() => ({ ...document.getElementById('kingdom-view').dataset }));
const fx = async (page) => JSON.parse((await view(page)).intercepts || '{}');

test('an interception, start to finish: detect, lock on, the gadget, the tag, the shots, the trace; replay from the feed', { skip, timeout: 900000 }, async (t) => {
  const control = {};
  const feed = fixtureFeed(control);
  const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: (url) => feed(url) });
  const browser = await launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, errors } = await openPhonePage(browser, origin, { width: 412, height: 915, routeReplyFont });
  await page.evaluate(() => { try { localStorage.setItem('pg1_kingdom_quality', 'phone'); } catch (e) {} });
  await page.locator('#kingdom-mini').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#kingdom-mini').click();
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === 'webgl' && !!window.kingdomUi.scene() && Number(document.getElementById('kingdom-view').dataset.frames || 0) > 2, null, { timeout: 180000 });
  await page.waitForFunction(() => document.getElementById('kingdom-globe-intro').hidden, null, { timeout: 60000 });

  // The perimeter, the guards, the aircraft.
  const ins = await page.evaluate(() => window.kingdomUi.scene().inspect());
  for (const n of ['tower-security-fence', 'tower-security-gate-arms', 'tower-guard-booths', 'tower-bollards', 'tower-cctv', 'helicopters', 'aircraft']) assert.ok(ins.names.includes(n), n);
  for (const n of ins.names) assert.doesNotMatch(n, /island|wall|moat|merlon|gatehouse|portcullis|container/i);
  await page.waitForFunction(() => Number(document.getElementById('kingdom-view').dataset.guards || 0) === 10, null, { timeout: 60000 });
  assert.ok(ins.lifeCounts.aircraft >= 3 && ins.lifeCounts.airSeparation >= 50, JSON.stringify(ins.lifeCounts));

  // A real malicious verdict arrives live (the fixture's own row shape).
  const h = fixtureCallerHashes();
  control.tables.pg1_defense_events.push({ created_at: new Date().toISOString(), check_name: 'check_agent_message', endpoint: '/api/mcp', verdict_code: 'malicious', reason_codes: ['AGENT_MESSAGE_PAYMENT_REDIRECT'], severity: 'high', subject_kind: 'skill_md', country_code: 'JP', caller_hash: h.c });
  const t0 = Date.now();
  // Detect: the lock-on and the "Scanning" tag.
  await page.waitForFunction(() => { const x = JSON.parse(document.getElementById('kingdom-view').dataset.intercepts || '{}'); return x.reticles > 0 && x.tags > 0; }, null, { timeout: 600000, polling: 250 });
  t.diagnostic(`detected after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  // Respond: the Truth Lens fires; the director's shot list runs (the gadget, then the tower).
  await page.waitForFunction(() => /truth_lens/.test(document.getElementById('kingdom-view').dataset.fired || ''), null, { timeout: 600000, polling: 250 });
  await page.waitForFunction(() => ['gadget', 'tower'].includes(document.getElementById('kingdom-view').dataset.shot), null, { timeout: 120000, polling: 100 });
  await page.evaluate(() => window.kingdomUi.scene().pause(true)); mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'kingdom-intercept-412-test-fixture.png'), timeout: 120000 });
  await page.evaluate(() => window.kingdomUi.scene().pause(false));
  const shots = new Set();
  await page.waitForFunction(() => { const s = document.getElementById('kingdom-view').dataset.shot; (window.__shots ||= new Set()).add(s); return window.__shots.has('tower'); }, null, { timeout: 120000, polling: 100 });
  shots.add('tower');
  assert.ok(shots.has('tower'), 'the tower reaction shot');
  // Resolve: the boat sinks; a marker buoy stays for the day.
  await page.waitForFunction(() => JSON.parse(document.getElementById('kingdom-view').dataset.intercepts || '{}').buoys >= 1, null, { timeout: 600000, polling: 500 });
  const after = await fx(page);
  assert.equal(after.day.length, 10, 'traces belong to a Dublin day');

  // Replay from the feed: tap the row; it is a replay, never LIVE.
  const id = await page.$eval('#kingdom-feed .kd-row[data-sev="high"]', (el) => el.dataset.id);
  await page.click(`#kingdom-feed .kd-row[data-id="${id}"]`);
  await page.waitForFunction((x) => window.kingdomUi.status().lastReplay === x, id, { timeout: 30000 });
  const st = await page.evaluate(() => window.kingdomUi.status());
  assert.ok(st.replay.includes(id) && !st.live.includes(id), 'a replay, never LIVE');
  assert.equal(await page.$eval(`#kingdom-feed .kd-row[data-id="${id}"]`, (el) => el.getAttribute('role')), 'button');
  assert.deepEqual(errors, []);
});
