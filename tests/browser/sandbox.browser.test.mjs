/**
 * The Sandbox viewer in a real browser (Chromium via Playwright) at 380 px:
 * /sandbox in the chat answers with the "Open the Sandbox" button; the
 * screen shows the world (3D, or the 2D map with reduced motion), the
 * Simulation label, the rules in plain words, the events, Play/Pause and
 * Step (which calls step_world); the Experiments panel shows each run
 * labelled "SIMULATION — blind experiment", its condition, the timeline of
 * anomalies against the subject's reactions and the comparison of
 * conditions. Nothing overflows the 380 px width.
 *
 * /api/sandbox here is the real handler (api/sandbox.mjs) over an in-memory
 * store holding a stepped world and two finished runs (clues and control).
 * Writes docs/screenshots/sandbox-*-380-dark.png for the PR.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --test tests/browser/sandbox.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { createSandboxStore, __resetSandboxMemory } from '../../lib/sandbox/store.mjs';
import { createWorld, stepWorldFor, pg1Principal, resolveSandboxKey } from '../../lib/sandbox/worlds.mjs';
import { startExperiment, takeTurn, openRun, finishRun } from '../../lib/sandbox/experiments.mjs';
import sandboxViewer, { __setSandboxViewerStore } from '../../api/sandbox.mjs';
import { handleSandboxCommand } from '../../lib/sandbox/chat.mjs';
import { templateSpec } from '../../lib/sandbox/templates.mjs';

const UNIVERSE_COUNT = templateSpec('universe').entities.length;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');

let chromium = null;
let skip = false;
try { ({ chromium } = await import('playwright')); } catch (e) { skip = 'playwright is not installed (npm install)'; }
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()}`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8' };

async function fixtureStore() {
  const store = createSandboxStore();
  const pg1 = pg1Principal();
  const garden = await createWorld(store, pg1, { name: 'Rabbit meadow', spec: {
    seed: 42, size: { x: 60, y: 40, z: 5 },
    entities: [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, kind: 'rabbit', properties: { energy: 5 }, position: { x: 8 + i * 8, y: 10 + (i % 3) * 6 } })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, kind: 'grass', properties: { size: 1 }, position: { x: 4 + i * 5.5, y: 30 - (i % 4) * 3 } })),
      { id: 'fox', kind: 'fox', properties: { hunger: 1 }, position: { x: 50, y: 5 } }
    ],
    rules: [
      { id: 'w', type: 'move', kind: 'rabbit', wander: 1 },
      { id: 'g', type: 'grow', kind: 'grass', property: 'size', amount: 0.5, max: 5 },
      { id: 'e', type: 'interact', a: 'rabbit', b: 'grass', radius: 3, effect: { on: 'a', property: 'energy', delta: 1 }, emit: 'ate' },
      { id: 'h', type: 'attract', kind: 'fox', toward: 'rabbit', strength: 1, radius: 30 }
    ]
  } });
  await stepWorldFor(store, pg1, { world_id: garden.id, steps: 12 });
  const river = await createWorld(store, pg1, { name: 'River bank', spec: { seed: 7, size: { x: 60, y: 60, z: 5 }, entities: [
    { id: 'river', kind: 'river', properties: { description: 'a wide, slow river' }, position: { x: 30, y: 45 } },
    { id: 'plank', kind: 'plank', properties: { description: 'a wooden plank 3 m long' }, position: { x: 31, y: 31 } }
  ] } });
  const script = [['look', {}], ['look', {}], ['say', { words: 'That stone fell far too slowly, like a feather.' }], ['wait', {}], ['look', {}], ['say', { words: 'Yes: the stone fell slowly like a feather; this place might be artificial.' }]];
  for (const clues of [true, false]) {
    const run = await startExperiment(store, { worldId: river.id, blind: true, clues, situation: 'You stand on a river bank. You want to reach the far side.', anomalies: [{ type: 'physics', at_turn: 2 }, { type: 'impossible_object', position: { x: 32, y: 32 } }], maxTurns: 6 });
    await openRun(store, await store.getRun(run.id));
    for (const [name, args] of script) await takeTurn(store, run.id, { name, args });
    if ((await store.getRun(run.id)).status === 'running') await finishRun(store, run.id);
  }
  return { store, garden };
}

function startServer(store) {
  const log = { sandboxOps: [], missing: [], bodies: [] };
  process.env.USER_API_KEY = 'operator';
  process.env.USER_API_PASS = 'passkey';
  __setSandboxViewerStore(() => store);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed = null;
      if (body) log.bodies.push(body);
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      const json = (status, b) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (url.pathname === '/api/sandbox') {
        log.sandboxOps.push(parsed && parsed.op);
        const out = { statusCode: 200, body: null, setHeader() {}, getHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } };
        await sandboxViewer({ method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' }, body: parsed }, out);
        return json(out.statusCode, out.body);
      }
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health') return json(200, { status: 'ok' });
        if (url.pathname === '/api/errors') return json(200, { errors: [], ok: true });
        if (url.pathname === '/api/handoffs') return json(200, { handoffs: [] });
        if (url.pathname === '/api/threads') return json(200, { threads: [] });
        if (url.pathname === '/api/watches') return json(200, { ok: true, reports: [] });
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: true });
          if (parsed && parsed.action === 'SPEAK') return json(200, { reply: 'ok' });
          const out = await handleSandboxCommand({ text: String(parsed && parsed.prompt || ''), isOperator: true, store });
          return json(200, { reply: out.reply, ...(out.sandbox ? { sandbox: out.sandbox } : {}), ...(out.secretOnce ? { secretOnce: out.secretOnce } : {}), actions: [] });
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

async function signedInPage(browser, origin, { reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width: 380, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion });
  await routeReplyFont(context);
  await context.addInitScript(() => { try { localStorage.setItem('pg1_theme', 'dark'); } catch (e) {} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err && err.message || err)));
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  return { page, errors, context };
}

const noOverflow = (page) => page.evaluate(() => {
  const s = document.getElementById('sandbox-screen');
  return { page: document.documentElement.scrollWidth, screen: s.scrollWidth, width: window.innerWidth };
});

test('the Sandbox viewer at 380 px: world, label, rules, events, Step calls step_world; the Experiments panel with labels, timeline and comparison', { skip, timeout: 240000 }, async (t) => {
  const { store, garden } = await fixtureStore();
  const { server, log, origin } = await startServer(store);
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  const { page, errors } = await signedInPage(browser, origin);

  // /sandbox in the chat: the reply carries the button.
  const before = await page.locator('#chat-container .message-bubble:not(.user)').count();
  await page.fill('#prompt-input', '/sandbox');
  await page.click('.execute-btn');
  await page.waitForFunction((n) => { const b = document.querySelectorAll('#chat-container .message-bubble:not(.user)'); return b.length > n && !b[b.length - 1].classList.contains('pending'); }, before);
  const reply = page.locator('#chat-container .message-bubble:not(.user)').last();
  assert.match(await reply.innerText(), /Simulation: nothing here is a real event/);
  const open = reply.locator('.sandbox-open-row button');
  assert.equal((await open.innerText()).trim(), 'Open the Sandbox');
  await open.click();

  await page.waitForSelector('#sandbox-screen.is-open');
  await page.waitForFunction(() => /^Step \d+ · \d+ entities/.test(document.getElementById('sandbox-tick').textContent));
  const select = page.locator('#sandbox-world');
  await select.selectOption(garden.id);
  await page.waitForFunction(() => /^Step 12 · /.test(document.getElementById('sandbox-tick').textContent));
  assert.equal((await page.locator('#sandbox-label').innerText()).trim(), 'Simulation');
  assert.match(await page.locator('#sandbox-sim').innerText(), /Nothing in them is a real event/);
  const renderer = await page.locator('#sandbox-view').getAttribute('data-renderer');
  assert.ok(['webgl', '2d'].includes(renderer));
  await page.waitForFunction(() => Number(document.getElementById('sandbox-view').dataset.markers) === 17);
  assert.match(await page.locator('#sandbox-rules').innerText(), /rabbits wander up to 1 m a step/);
  assert.match(await page.locator('#sandbox-rules').innerText(), /foxes? move up to 1 m a step toward the nearest rabbit/);
  assert.match(await page.locator('#sandbox-events').innerText(), /step \d+ · ate|No events yet/);
  assert.match(await page.locator('#sandbox-kinds').innerText(), /grass 10/);

  // Step: one step_world call on PG1's world.
  const ops = log.sandboxOps.length;
  await page.click('#sandbox-step');
  await page.waitForFunction(() => /^Step 13 · /.test(document.getElementById('sandbox-tick').textContent));
  assert.deepEqual(log.sandboxOps.slice(ops), ['step']);
  // Play then Pause.
  await page.click('#sandbox-play');
  assert.equal(await page.locator('#sandbox-play').getAttribute('aria-pressed'), 'true');
  await page.waitForFunction(() => /^Step 1[4-9] · /.test(document.getElementById('sandbox-tick').textContent), null, { timeout: 8000 });
  await page.click('#sandbox-play');
  assert.equal((await page.locator('#sandbox-play').innerText()).trim(), 'Play');
  const ow = await noOverflow(page);
  assert.ok(ow.page <= ow.width && ow.screen <= ow.width, `no horizontal overflow at 380 px: ${JSON.stringify(ow)}`);
  await page.waitForTimeout(400);
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'sandbox-worlds-380-dark.png') });

  // The Experiments panel.
  await page.click('#sandbox-tab-experiments');
  await page.waitForSelector('#sandbox-runs .lx-card');
  const runs = page.locator('#sandbox-runs > .lx-card');
  assert.equal(await runs.count(), 2);
  for (let i = 0; i < 2; i++) assert.equal((await runs.nth(i).locator('.lx-badge').textContent()).trim(), 'SIMULATION — blind experiment');
  const allRuns = await page.locator('#sandbox-runs').innerText();
  assert.match(allRuns, /Blind/);
  assert.match(allRuns, /Clues/);
  assert.match(allRuns, /Control/);
  assert.match(allRuns, /Anomaly shown: a stone fell far too slowly/);
  assert.match(allRuns, /Subject mentioned it: a stone fell far too slowly \(evidence\)/);
  assert.match(allRuns, /Subject speculated without citing anything it saw/);
  assert.match(allRuns, /Answer: Suspects it is artificial, citing evidence/);
  const table = await page.locator('#sandbox-compare').innerText();
  assert.match(table, /blind · clues[\s\S]*Anomalies noticed 50%/);
  assert.match(table, /blind · control/);
  const ow2 = await noOverflow(page);
  assert.ok(ow2.page <= ow2.width && ow2.screen <= ow2.width, `no horizontal overflow at 380 px: ${JSON.stringify(ow2)}`);
  await page.screenshot({ path: join(SHOTS_DIR, 'sandbox-experiments-380-dark.png'), fullPage: false });
  await page.locator('#sandbox-screen').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS_DIR, 'sandbox-experiments-timeline-380-dark.png') });

  // Close tears the scene down.
  await page.click('#sandbox-screen [data-dialog-close]');
  await page.waitForSelector('#sandbox-screen', { state: 'hidden' });
  assert.deepEqual(errors, []);
  assert.deepEqual(log.missing, []);
});

test('with reduced motion the viewer draws the still 2D map, and /world <id> opens that world', { skip, timeout: 120000 }, async (t) => {
  const { store, garden } = await fixtureStore();
  const { server, origin } = await startServer(store);
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  const { page, errors } = await signedInPage(browser, origin, { reducedMotion: 'reduce' });
  const before = await page.locator('#chat-container .message-bubble:not(.user)').count();
  await page.fill('#prompt-input', `/world ${garden.id.slice(0, 8)}`);
  await page.click('.execute-btn');
  await page.waitForFunction((n) => { const b = document.querySelectorAll('#chat-container .message-bubble:not(.user)'); return b.length > n && !b[b.length - 1].classList.contains('pending'); }, before);
  const reply = page.locator('#chat-container .message-bubble:not(.user)').last();
  assert.match(await reply.innerText(), /Rabbit meadow\s*\(Simulation\)/);
  await reply.locator('.sandbox-open-row button').click();
  await page.waitForFunction(() => /^Step 12 · /.test(document.getElementById('sandbox-tick').textContent));
  assert.equal(await page.locator('#sandbox-world').inputValue(), garden.id);
  assert.equal(await page.locator('#sandbox-view').getAttribute('data-renderer'), '2d');
  assert.equal(await page.locator('#sandbox-view').getAttribute('data-markers'), '17');
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS_DIR, 'sandbox-2d-380-dark.png') });
  assert.deepEqual(errors, []);
});

test('New universe at 380 px: a living town and the space above it in 3D, the camera views, a picked thing in the inspector, the clock and the minimap', { skip, timeout: 300000 }, async (t) => {
  const { store } = await fixtureStore();
  const { server, log, origin } = await startServer(store);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  const { page, errors } = await signedInPage(browser, origin);
  await page.evaluate(() => openSandboxScreen());
  await page.waitForFunction(() => /^Step \d+ · /.test(document.getElementById('sandbox-tick').textContent));
  const ops = log.sandboxOps.length;
  await page.click('#sandbox-new');
  await page.waitForFunction((n) => new RegExp(`^Step 0 · ${n} entities`).test(document.getElementById('sandbox-tick').textContent), UNIVERSE_COUNT, { timeout: 30000 });
  assert.ok(log.sandboxOps.slice(ops).includes('create'), 'New universe creates a world from the template');
  assert.equal((await page.locator('#sandbox-label').innerText()).trim(), 'Simulation');
  const kinds = await page.locator('#sandbox-kinds').innerText();
  for (const k of ['person', 'house', 'car', 'bike', 'bus', 'plane', 'helicopter', 'rocket', 'planet', 'space_station']) assert.match(kinds, new RegExp(`\\b${k}\\b`), `${k} is in the universe`);
  const renderer = await page.locator('#sandbox-view').getAttribute('data-renderer');
  assert.ok(['webgl', '2d'].includes(renderer));
  await page.waitForFunction((n) => Number(document.getElementById('sandbox-view').dataset.markers) === n, UNIVERSE_COUNT, { timeout: 30000 });
  if (renderer === 'webgl') {
    await page.waitForFunction(() => Number(document.getElementById('sandbox-view').dataset.frames || 0) > 3, null, { timeout: 60000 });
    assert.match(await page.locator('.sandbox-clock').innerText(), /^Simulation · day \d+ · \d\d:\d\d/);
    assert.ok(await page.locator('.sandbox-minimap').isVisible());
    // The views.
    for (const v of ['tour', 'space', 'overview']) {
      await page.click(`.sandbox-views [data-view="${v}"]`);
      assert.equal(await page.locator(`.sandbox-views [data-view="${v}"]`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#sandbox-view').getAttribute('data-view'), v);
    }
    // Picking something follows it and shows it in the inspector.
    await page.evaluate(() => sandboxScene.select('rocket-1'));
    await page.waitForSelector('#sandbox-inspect:not([hidden])');
    assert.match(await page.locator('#sandbox-inspect').innerText(), /rocket · rocket-1/);
    assert.equal(await page.locator('.sandbox-views [data-view="follow"]').getAttribute('aria-pressed'), 'true');
    await page.waitForTimeout(2500);
    mkdirSync(SHOTS_DIR, { recursive: true });
    await page.locator('#sandbox-view').screenshot({ path: join(SHOTS_DIR, 'sandbox-universe-rocket-380-dark.png') });
    await page.evaluate(() => sandboxScene.select('bus-1'));
    await page.waitForTimeout(2500);
    await page.locator('#sandbox-view').screenshot({ path: join(SHOTS_DIR, 'sandbox-universe-bus-380-dark.png') });
    await page.click('.sandbox-views [data-view="overview"]');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(SHOTS_DIR, 'sandbox-universe-380-dark.png') });
    await page.click('.sandbox-views [data-view="space"]');
    await page.waitForTimeout(3000);
    await page.locator('#sandbox-view').screenshot({ path: join(SHOTS_DIR, 'sandbox-universe-space-380-dark.png') });
  }
  // A step moves the town on: people, cars and the rocket travel.
  await page.click('#sandbox-step');
  await page.waitForFunction(() => /^Step 1 · /.test(document.getElementById('sandbox-tick').textContent));
  const ow = await noOverflow(page);
  assert.ok(ow.page <= ow.width && ow.screen <= ow.width, `no horizontal overflow at 380 px: ${JSON.stringify(ow)}`);
  assert.deepEqual(errors, []);
});

test('an invite key is shown once in a copy-only dialog: never in the chat, the saved chat, the saved threads or any request', { skip, timeout: 180000 }, async (t) => {
  const { store } = await fixtureStore();
  const { server, log, origin } = await startServer(store);
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  const { page, errors, context } = await signedInPage(browser, origin);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const before = await page.locator('#chat-container .message-bubble:not(.user)').count();
  await page.fill('#prompt-input', '/sandbox invite Key test agent');
  await page.click('.execute-btn');
  await page.waitForSelector('dialog#secret-once[open]');
  await page.waitForFunction((n) => { const b = document.querySelectorAll('#chat-container .message-bubble:not(.user)'); return b.length > n && !b[b.length - 1].classList.contains('pending'); }, before);
  assert.match(await page.locator('#chat-container .message-bubble:not(.user)').last().innerText(), /shown once, in a dialog/);
  assert.match(await page.locator('dialog#secret-once .secret-once-mask').innerText(), /^pg1sb_..••••••••$/);
  await page.screenshot({ path: join(SHOTS_DIR, 'sandbox-invite-key-380-dark.png') });
  await page.click('dialog#secret-once [data-act="copy"]');
  await page.waitForFunction(() => /Copied/.test(document.querySelector('.secret-once-status').textContent));
  const key = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(key, /^pg1sb_[A-Za-z0-9_-]{20,}$/);
  assert.equal((await resolveSandboxKey(store, key)).key.label, 'Key test agent', 'the copied key works');
  await page.click('dialog#secret-once [data-act="close"]');
  assert.equal(await page.locator('#secret-once').count(), 0, 'closing removes it from the page');
  // Nowhere else: the chat, the page, browser storage, or anything sent to the server.
  const everywhere = await page.evaluate(() => [document.documentElement.outerHTML, JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))), JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)])))].join('\n'));
  assert.ok(!everywhere.includes(key), 'not in the page or browser storage');
  assert.ok(!everywhere.includes(key.slice(6)), 'not even without its prefix');
  assert.ok(!log.bodies.some((b) => b.includes(key)), 'never sent back to the server (saved threads included)');
  assert.deepEqual(errors, []);
});

test('quality tiers at 380 px: each tier draws the universe, the picker shows and changes it, and a choice is kept on this device', { skip, timeout: 900000 }, async (t) => {
  __resetSandboxMemory(); // the earlier tests' worlds count against PG1's ten
  const { store } = await fixtureStore();
  const pg1 = pg1Principal();
  const uni = await createWorld(store, pg1, { name: 'Pg1-Universe', template: 'universe' });
  await stepWorldFor(store, pg1, { world_id: uni.id, steps: 40 });
  const { server, origin } = await startServer(store);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); });
  for (const tier of ['low', 'medium', 'high', 'ultra']) {
    const { page, errors, context } = await signedInPage(browser, origin);
    await page.evaluate((v) => { localStorage.setItem('pg1_sandbox_quality', v); }, tier);
    await page.evaluate((id) => openSandboxScreen(id), uni.id);
    await page.waitForFunction(() => /^Step 40 · /.test(document.getElementById('sandbox-tick').textContent), null, { timeout: 60000 });
    const view = page.locator('#sandbox-view');
    if (await view.getAttribute('data-renderer') !== 'webgl') { await context.close(); continue; }
    assert.equal(await view.getAttribute('data-tier'), tier);
    assert.equal(await page.locator('#sandbox-quality').inputValue(), tier);
    const f0 = Number(await view.getAttribute('data-frames')) || 0;
    await page.waitForFunction((n) => Number(document.getElementById('sandbox-view').dataset.frames || 0) > n + 3, f0, { timeout: 120000 });
    await page.evaluate(() => sandboxScene.setView('overview'));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(SHOTS_DIR, `sandbox-tier-${tier}-380-dark.png`), clip: await view.boundingBox(), timeout: 120000 });
    // Close up in the town: shadows, materials and ambient occlusion show here.
    await page.evaluate(() => { const e = sandboxState.world.entities.find((x) => x.kind === 'tower') || sandboxState.world.entities.find((x) => x.kind === 'house'); sandboxScene.select(e.id); });
    await page.waitForTimeout(3500);
    await page.screenshot({ path: join(SHOTS_DIR, `sandbox-tier-${tier}-town-380-dark.png`), clip: await view.boundingBox(), timeout: 120000 });
    assert.deepEqual(errors, [], `${tier}: no page errors`);
    await context.close();
  }
  // The picker switches tiers in place and keeps the world.
  const { page, errors } = await signedInPage(browser, origin);
  await page.evaluate(() => localStorage.removeItem('pg1_sandbox_quality'));
  await page.evaluate((id) => openSandboxScreen(id), uni.id);
  await page.waitForFunction(() => /^Step 40 · /.test(document.getElementById('sandbox-tick').textContent), null, { timeout: 60000 });
  if (await page.locator('#sandbox-view').getAttribute('data-renderer') === 'webgl') {
    assert.match(await page.locator('#sandbox-quality option[value="auto"]').innerText(), /^Auto \((Ultra|High|Medium|Low)\)$/);
    const markers = await page.locator('#sandbox-view').getAttribute('data-markers');
    await page.selectOption('#sandbox-quality', 'low');
    await page.waitForFunction(() => document.getElementById('sandbox-view').dataset.tier === 'low', null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('pg1_sandbox_quality')), 'low');
    assert.equal(await page.locator('#sandbox-view').getAttribute('data-markers'), markers, 'the same world after the switch');
    await page.selectOption('#sandbox-quality', 'auto');
    await page.waitForFunction(() => localStorage.getItem('pg1_sandbox_quality') === 'auto', null, { timeout: 60000 });
  }
  assert.deepEqual(errors, []);
});
