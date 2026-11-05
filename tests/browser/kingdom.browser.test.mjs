/**
 * PG1 City (Kingdom Defence) in the Command Centre, in a real browser at
 * 412 px (the Pixel-class phone profile the viewer tests use), dark, and on
 * a desktop at the Cinematic tier.
 *
 * The feed in these tests is a TEST FIXTURE (tests/helpers/kingdomFixtures.mjs),
 * built through the real lib/defenseFeed.mjs; screenshots made from it are
 * named *-test-fixture.png. The app never sees it.
 *
 *   - real, not a simulation: the badge and the country counter are in the
 *     view from the start; N matches the feed; flags are at least 24 px;
 *   - live: events present when the view opens are replayed as "Earlier
 *     today", never "LIVE"; a row added to the feed appears in the scene
 *     within 10 s captioned "LIVE", in the ticker in order, and a burst
 *     grows with its running count; with the feed down the badge says
 *     "Feed paused" and nothing new plays; an empty feed plays nothing;
 *   - Fix 1: caller hashes are the real per-caller short hashes; a free tool
 *     never shows a 402; a source with no caller shows "—";
 *   - the city: no island, wall, moat or unnamed block; the shield invisible
 *     until a gadget fires; the camera never inside a building; the window
 *     pattern does not alias into noise (close, mid and far);
 *   - the tower and guardians follow PG1's state; no PG1 unit leaves the city;
 *   - Record mode: the badge and counter in every frame of 16:9 and 9:16
 *     clips; replay clips say time-lapsed; the end card has the date, N and
 *     both footnotes.
 * Skipped (not failed) when Playwright or a Chromium is not installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { startCommandCentreServer, openPhonePage } from '../helpers/commandCentre.mjs';
import { fixtureFeed, fixtureCallerHashes, FIXTURE_APPROVALS } from '../helpers/kingdomFixtures.mjs';
import { PLACEHOLDER_CALLER_HASHES, BADGE, billboardLines, isEnemyColour, dublinHour } from '../../public/kingdom/kingdom-data.js';
import { parseBrandSvg } from '../../public/kingdom/kingdom-emblem.js';
import { readFileSync } from 'node:fs';
import { CITY_R } from '../../public/kingdom/kingdom-world.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');

let chromium = null;
let executablePath;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  skip = 'playwright is not installed (npm install)';
}
if (chromium && !existsSync(chromium.executablePath())) {
  if (existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  else skip = `Chromium is not installed at ${chromium.executablePath()}`;
}
const launch = () => chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const view = (page) => page.evaluate(() => ({ ...document.getElementById('kingdom-view').dataset }));
const status = (page) => page.evaluate(() => window.kingdomUi.status());
const shot = async (page, name) => { mkdirSync(SHOTS_DIR, { recursive: true }); await page.screenshot({ path: join(SHOTS_DIR, name) }); };
const frames = (page, n, timeout = 120000) => page.waitForFunction((k) => Number(document.getElementById('kingdom-view').dataset.frames || 0) > k, n, { timeout });
const realN = async () => { const f = await fixtureFeed()(new URL('http://x/api/defense-feed')); return f.origins.length; };

test('PG1 City at 412 px: real-not-simulated claim, live arrivals, replays, Fix 1, the city and Record mode', { skip, timeout: 600000 }, async (t) => {
  const control = {};
  const feed = fixtureFeed(control);
  const { server, log, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: (url) => feed(url) });
  const browser = await launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, errors } = await openPhonePage(browser, origin, { width: 412, height: 915, routeReplyFont });
  await page.locator('#kingdom-mini').waitFor({ state: 'visible', timeout: 20000 });
  assert.ok(!log.paths.some((p) => p.startsWith('/vendor/three/')), 'no 3D before the view opens');
  assert.ok(log.feeds.every((f) => f.operator && !/user|pass/.test(f.query)), 'credentials in the body only');
  await page.locator('#kingdom-mini').click();
  await page.locator('#kingdom-screen').waitFor({ state: 'visible' });

  // The claim and the countries, from the start (the globe opening plays over the city).
  await page.waitForFunction((txt) => document.getElementById('kingdom-badge').textContent === txt, BADGE.live, { timeout: 30000 });
  const N = await realN();
  assert.equal(Number(await page.locator('#kingdom-countries').getAttribute('data-n')), N, 'N matches the feed');
  assert.equal(await page.locator('#kingdom-countries-text').textContent(), `Hostile traffic from ${N} countries · last 24 h`);
  const flagBox = await page.locator('#kingdom-flags').boundingBox();
  assert.ok(flagBox && flagBox.height >= 24, `flags ${flagBox && flagBox.height}px`);
  await page.waitForFunction(() => document.getElementById('kingdom-globe-intro').dataset.shown, null, { timeout: 30000 });
  assert.ok(Number(await page.locator('#kingdom-globe-intro').getAttribute('data-flag-px')) >= 24, 'globe flags at least 24 px');
  assert.equal(await page.locator('#kingdom-feed-title').textContent(), 'Last 24 hours · Real PG1 events — not a simulation');
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === 'webgl', null, { timeout: 90000 });
  await frames(page, 4);
  await page.waitForFunction(() => document.getElementById('kingdom-globe-intro').hidden, null, { timeout: 30000 });
  await shot(page, 'kingdom-city-hero-412-test-fixture.png');

  // Replays on open are "Earlier today", never LIVE.
  let st = await status(page);
  assert.ok(st.replay.length > 0, 'the last real events of the day replay on open');
  assert.equal(st.live.length, 0);
  await page.locator('#kingdom-caption').waitFor({ state: 'visible', timeout: 30000 });
  assert.match(await page.locator('#kingdom-caption .kd-cap-when').textContent(), /^Earlier today · \d\d:\d\d$/);

  // Fix 1: real per-caller hashes, no placeholder, no 402 on a free tool, "—" for no caller.
  const real = new Set(Object.values(fixtureCallerHashes()).map((x) => x.slice(0, 8)));
  const shown = await page.$$eval('#kingdom-feed .kd-row code', (els) => els.map((e) => e.textContent.trim()));
  for (const x of shown) { assert.ok(!PLACEHOLDER_CALLER_HASHES.includes(x), x); assert.ok(x === '—' || real.has(x), x); }
  const text = await page.locator('#kingdom-feed').textContent();
  assert.ok(!/check_package · stopped at the toll/.test(text));
  assert.match(text, /🇫🇷 FR/, 'flag and ISO code in the feed');
  assert.match(text, /—/);

  // The city.
  const inside = await page.evaluate(() => window.kingdomUi.scene().inspect());
  assert.equal(inside.unnamed, 0, 'no unnamed (placeholder) mesh');
  for (const n of inside.names) assert.ok(!/island|wall|moat|merlon|gatehouse|portcullis|container/i.test(n), n);
  // The emblem is the brand asset (paths and colours), on the crown.
  const brandFills = parseBrandSvg(readFileSync(join(ROOT, 'public/brand/pg1-shield.svg'), 'utf8')).paths.map((p) => p.fill);
  assert.equal(inside.emblemSource, '/brand/pg1-shield.svg');
  assert.deepEqual([...inside.brandFills].sort(), [...brandFills].sort());
  for (const n of ['pg1-emblem-crown-east', 'pg1-emblem-hologram', 'pg1-emblem-plaza', 'pg1-emblem-projection', 'billboard-east']) assert.ok(inside.names.includes(n), `${n} missing`);
  // The city's own life: there, and never in the enemy palette.
  assert.ok(inside.lifeCounts.vehicles > 50 && inside.lifeCounts.people > 100 && inside.lifeCounts.boats > 0);
  for (const c of inside.lifeColours) assert.ok(!isEnemyColour(c), `ambient colour ${c.toString(16)} is enemy red`);
  for (const n of ['car-bodies', 'buses', 'tram', 'water-taxis-and-ferries', 'aircraft', 'birds', 'rooftop-steam', 'rooftop-radar', 'construction-crane', 'street-light-pools', 'zebra-crossings', 'manhole-covers', 'plaza-fountain', 'plaza-benches', 'pavements', 'kerbs']) assert.ok(inside.names.includes(n), `${n} missing`);
  for (const n of ['pg1-tower', 'tower-gold-accent', 'tower-crown-lights', 'river', 'bridge-arch', 'bridge-west', 'moored-boats', 'pier-deck', 'skyline-twist', 'skyline-crown', 'rooftop-plant', 'aircraft-lights', 'lane-markings', 'traffic-lights', 'pedestrians', 'tree-crowns', 'river-light-streaks', 'embankment-railing']) assert.ok(inside.names.includes(n), `${n} missing`);

  // PG1 state and the HUD (plurals).
  let d = await view(page);
  const { listedTools } = await import('../../api/mcp.mjs');
  assert.equal(Number(d.sentinels), listedTools({}).length);
  assert.equal(d.beacon, 'gold'); assert.equal(d.seal, 'bronze');
  assert.equal(Number(d.beaconsLit), FIXTURE_APPROVALS);
  assert.match(await page.locator('#kingdom-hud').textContent(), new RegExp(`^Defences active: ${listedTools({}).length} checks live · \\d+ threats turned away today$`));

  // The billboards: real numbers from the feed only (threats, no payments).
  await page.waitForFunction(() => /checks live/.test(document.getElementById('kingdom-view').dataset.billboard || ''), null, { timeout: 15000 });
  const day = await page.evaluate(() => window.kingdomUi.store.day.turned_away);
  assert.equal((await view(page)).billboard, billboardLines({ countries: N, threats: day, checks: listedTools({}).length }).join(' | '));
  assert.ok(!/payment/.test((await view(page)).billboard));
  // Windows follow the hour in Dublin (Dublin time by default; dusk is 19:30).
  assert.equal((await view(page)).light, 'live');
  assert.equal(Number((await view(page)).windowHour), Math.floor(dublinHour(Date.now())));
  await page.selectOption('#kingdom-light', 'dusk');
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.windowHour === '19', null, { timeout: 15000 });
  // The emblem in the hero shot, readable at 412 px.
  await page.evaluate(() => { const s = window.kingdomUi.scene(); s.setDirector(false); s.focus(null); });
  await page.waitForTimeout(6000);
  const em = await page.evaluate(() => window.kingdomUi.scene().emblemScreen());
  assert.ok(em && em.inView && em.height >= 24, `emblem ${JSON.stringify(em)}`);
  await shot(page, 'kingdom-city-hero-dusk-412.png');
  await page.evaluate(() => window.kingdomUi.scene().debugView({ target: [6, 186, 0], dist: 70, theta: 0.15, phi: 1.45 }));
  await page.waitForTimeout(5000);
  await shot(page, 'kingdom-city-emblem-412.png');
  await page.evaluate(() => window.kingdomUi.scene().debugView({ target: [160, 4, -120], dist: 70, theta: Math.PI / 2, phi: 1.38 }));
  await page.waitForTimeout(5000);
  await shot(page, 'kingdom-city-street-412.png');
  await page.evaluate(() => window.kingdomUi.scene().debugView({ target: [260, 0, 120], dist: 160, theta: 0.5, phi: 1.2 }));
  await page.waitForTimeout(5000);
  await shot(page, 'kingdom-city-river-boats-412.png');
  await page.evaluate(() => { const s = window.kingdomUi.scene(); s.debugView({ target: [-40, 95, 70], dist: 700 }); s.setDirector(true); });

  // A live arrival: in the scene within 10 s, captioned LIVE, at the top of the ticker.
  const before = Number((await view(page)).attackers);
  const h = fixtureCallerHashes();
  const t0 = Date.now();
  control.addTelemetry({ event_type: 'tool_call', endpoint: '/api/mcp', status: 'unknown_tool', caller_hash: h.c, country_code: 'JP' });
  await page.waitForFunction(() => window.kingdomUi.status().live.length > 0, null, { timeout: 10000, polling: 200 });
  assert.ok(Date.now() - t0 <= 10000, 'within 10 s');
  await page.waitForFunction((b) => Number(document.getElementById('kingdom-view').dataset.attackers || 0) > b, before, { timeout: 10000 });
  await page.waitForFunction(() => /^LIVE · \d+ s ago$/.test(document.querySelector('#kingdom-caption .kd-cap-when').textContent), null, { timeout: 10000 });
  await page.waitForFunction(() => /JP · Raiders · tool_router: unknown tool probe/.test(document.querySelector('#kingdom-ticker li').textContent), null, { timeout: 5000 }).catch(async () => { throw new Error(JSON.stringify({ st: await status(page), html: await page.locator('#kingdom-ticker').innerHTML(), errors })); });
  // The burst grows: a second real row, the running count.
  control.addTelemetry({ event_type: 'tool_call', endpoint: '/api/mcp', status: 'unknown_tool', caller_hash: h.c, country_code: 'JP' });
  await page.waitForFunction(() => /×2/.test(document.querySelector('#kingdom-ticker li').textContent), null, { timeout: 12000 });
  // A second country, in order on the ticker.
  control.addTelemetry({ event_type: 'tool_call', endpoint: '/api/a2a', status: 'rate_limited', tool_name: 'get_cve_batch', caller_hash: h.d, country_code: 'KR' });
  await page.waitForFunction(() => /KR/.test(document.querySelector('#kingdom-ticker li').textContent), null, { timeout: 12000 });
  const tick = await page.$$eval('#kingdom-ticker li', (els) => els.map((e) => e.textContent));
  assert.match(tick[0], /KR/); assert.match(tick[1], /JP/);
  st = await status(page);
  for (const id of st.live) assert.ok(!st.replay.includes(id), 'a live event is never a replay');
  await shot(page, 'kingdom-city-live-event-412-test-fixture.png');

  // The camera, and gadgets only on their own events.
  await page.waitForFunction(() => { const f = JSON.parse(document.getElementById('kingdom-view').dataset.fired || '{}'); return f.gate_wardens && f.rate_shield; }, null, { timeout: 200000, polling: 500 });
  d = await view(page);
  const fired = JSON.parse(d.fired);
  for (const g of ['truth_lens', 'sanctions_gate', 'supply_inspector', 'passkey_vault', 'preflight_ward', 'allies']) assert.ok(!fired[g], `${g} fired without its event`);
  assert.equal(d.camInside, '0', 'the camera was never inside a building');
  assert.ok(Number(d.pg1MaxR) <= CITY_R + 1);

  // The window pattern never aliases into noise: close, mid and far.
  for (const [name, dist] of [['close', 70], ['mid', 320], ['far', 1300]]) {
    await page.evaluate((k) => window.kingdomUi.scene().debugView({ target: [120, 60, -120], dist: k, theta: 0.6, phi: 1.25 }), dist);
    await page.waitForTimeout(4000);
    const m = await page.evaluate(() => window.kingdomUi.scene().sampleNoise());
    assert.ok(m.rel < 0.3, `${name}: noise ${m.rel.toFixed(3)}`);
    if (name === 'close') await shot(page, 'kingdom-city-facade-412.png');
  }
  await page.evaluate(() => window.kingdomUi.scene().debugView({ target: [0, 10, 120], dist: 260, theta: 0.9, phi: 1.2 }));
  await page.waitForTimeout(4000);
  await shot(page, 'kingdom-city-river-bridge-412.png');
  assert.equal((await view(page)).camInside, '0');

  // Record mode: the badge and the counter in frame; a 16:9 live clip, then a 30 s 9:16 replay to its end card.
  await page.click('#kingdom-record-btn');
  await page.click('#kingdom-record-go');
  await page.waitForFunction(() => window.kingdomUi.status().recTexts.length > 0, null, { timeout: 30000 });
  let texts = (await status(page)).recTexts;
  assert.ok(texts.includes(BADGE.live), texts.join(' | '));
  const nNow = Number(await page.locator('#kingdom-countries').getAttribute('data-n'));
  assert.ok(texts.some((x) => x.includes(`Hostile traffic from ${nNow} countries`)), texts.join(' | '));
  await page.waitForTimeout(3000);
  await page.click('#kingdom-record-go');
  await page.locator('#kingdom-record-file').waitFor({ state: 'visible', timeout: 30000 });
  await page.selectOption('#kingdom-record-aspect', '9:16');
  await page.selectOption('#kingdom-record-mode', 'replay');
  await page.click('#kingdom-record-go');
  await page.waitForFunction(() => /time-lapsed/.test(window.kingdomUi.status().recTexts.join('|')), null, { timeout: 30000 });
  assert.equal(await page.locator('#kingdom-badge').textContent(), BADGE.replay);
  await page.waitForFunction(() => /not a simulation · Hostile traffic from/.test(window.kingdomUi.status().recTexts.join('|')), null, { timeout: 60000, polling: 250 });
  texts = (await status(page)).recTexts;
  assert.ok(texts.some((x) => /^Real PG1 events, \d{1,2} \w+ \d{4} — not a simulation · Hostile traffic from \d+ countr(y|ies) in 24 h$/.test(x)), texts.join(' | '));
  assert.ok(texts.includes("Visualised live from PG1's logs. Location = traffic origin (IP geolocation), not attacker identity."));
  assert.ok(texts.some((x) => /IP geolocation at the network edge/.test(x)));
  assert.ok(texts.includes(BADGE.replay), 'the badge stays in frame on the end card');
  await page.locator('#kingdom-record-file').waitFor({ state: 'visible', timeout: 30000 });

  // The feed disconnects: the badge says so and nothing new plays.
  control.down = true;
  await page.waitForFunction((txt) => document.getElementById('kingdom-badge').textContent === txt, BADGE.paused, { timeout: 30000 });
  assert.equal((await view(page)).feedPaused, 'yes');
  const liveBefore = (await status(page)).live.length;
  control.addTelemetry({ event_type: 'tool_call', endpoint: '/api/mcp', status: 'unknown_tool', caller_hash: h.f, country_code: 'BR' });
  await page.waitForTimeout(11000);
  assert.equal((await status(page)).live.length, liveBefore, 'no new animation while the feed is paused');
  control.down = false;
  await page.waitForFunction((txt) => document.getElementById('kingdom-badge').textContent === txt, BADGE.live, { timeout: 30000 });
  assert.deepEqual(errors, []);
});

test('an empty feed: the claim and the counter are there, nothing plays, the ticker says quiet', { skip, timeout: 240000 }, async (t) => {
  const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR });
  const browser = await launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  for (const [w, h, name] of [[412, 915, '412'], [1280, 800, '1280']]) {
    const { page, context } = await openPhonePage(browser, origin, { width: w, height: h, routeReplyFont });
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('#kingdom-mini').isHidden(), true, 'no events, no mini-view');
    await page.fill('#prompt-input', '/kingdom');
    await page.click('.execute-btn');
    await frames(page, 12);
    await page.waitForTimeout(6000);
    const d = await view(page);
    assert.equal(d.attackers, '0');
    assert.equal(d.fired, '{}', 'no gadget fires on an empty feed');
    assert.equal(d.shield, 'hidden', 'the shield is invisible until a gadget fires');
    assert.equal((await status(page)).live.length, 0, 'nothing is generated for a quiet period');
    assert.equal(await page.locator('#kingdom-badge').textContent(), BADGE.live);
    assert.equal(await page.locator('#kingdom-countries-text').textContent(), 'Hostile traffic from 0 countries · last 24 h');
    assert.match(await page.locator('#kingdom-ticker').textContent(), /^Quiet · /);
    assert.match(await page.locator('#kingdom-feed').textContent(), /No defence events in the last 24 hours/);
    // The city's life runs, and is never captioned or counted as a defence or an attack.
    const ins = await page.evaluate(() => window.kingdomUi.scene().inspect());
    assert.ok(ins.lifeCounts.vehicles > 50 && ins.lifeCounts.people > 100);
    assert.equal(await page.locator('#kingdom-caption').isHidden(), true, 'no caption without an event');
    assert.equal((await view(page)).billboard, '0 countries · hostile traffic, last 24 h | 0 threats turned away today | not read checks live');
    await shot(page, `kingdom-city-default-${name}.png`);
    await context.close();
  }
});

test('desktop, Cinematic: the hero shot, a facade, the river and bridge, a live event', { skip, timeout: 900000 }, async (t) => {
  const control = {};
  const feed = fixtureFeed(control);
  const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: (url) => feed(url) });
  const browser = await launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await routeReplyFont(context);
  await context.addInitScript(() => { try { localStorage.setItem('pg1_theme', 'dark'); localStorage.setItem('pg1_kingdom_quality', 'cinematic'); } catch (e) {} });
  const page = await context.newPage();
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator'); await page.fill('#auth-pass', 'passkey'); await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  await page.fill('#prompt-input', '/kingdom');
  await page.click('.execute-btn');
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.tier === 'cinematic', null, { timeout: 120000 });
  await frames(page, 3, 300000);
  await page.waitForFunction(() => document.getElementById('kingdom-globe-intro').hidden, null, { timeout: 60000 });
  await page.selectOption('#kingdom-light', 'dusk');
  await page.evaluate(() => { const s = window.kingdomUi.scene(); s.setDirector(false); s.focus(null); });
  await page.waitForTimeout(10000);
  await shot(page, 'kingdom-city-hero-1280-cinematic-test-fixture.png');
  await page.evaluate(() => window.kingdomUi.scene().debugView({ target: [6, 186, 0], dist: 70, theta: 0.15, phi: 1.45 }));
  await page.waitForTimeout(10000);
  await shot(page, 'kingdom-city-emblem-1280-cinematic.png');
  await page.evaluate(() => window.kingdomUi.scene().debugView({ target: [160, 4, -120], dist: 70, theta: Math.PI / 2, phi: 1.38 }));
  await page.waitForTimeout(10000);
  await shot(page, 'kingdom-city-street-1280-cinematic.png');
  await page.evaluate(() => window.kingdomUi.scene().debugView({ target: [260, 0, 120], dist: 160, theta: 0.5, phi: 1.2 }));
  await page.waitForTimeout(10000);
  await shot(page, 'kingdom-city-river-boats-1280-cinematic.png');
  await page.evaluate(() => window.kingdomUi.scene().debugView({ target: [120, 60, -120], dist: 90, theta: 0.6, phi: 1.25 }));
  await page.waitForTimeout(10000);
  await shot(page, 'kingdom-city-facade-1280-cinematic.png');
  await page.evaluate(() => window.kingdomUi.scene().debugView({ target: [0, 10, 120], dist: 300, theta: 0.9, phi: 1.2 }));
  await page.waitForTimeout(10000);
  await shot(page, 'kingdom-city-river-bridge-1280-cinematic.png');
  const h = fixtureCallerHashes();
  await page.evaluate(() => window.kingdomUi.scene().setDirector(true));
  for (let i = 0; i < 6; i++) control.addTelemetry({ event_type: 'tool_call', endpoint: '/api/a2a', status: 'rate_limited', tool_name: 'get_cve_batch', caller_hash: h.d, country_code: 'KR' });
  await page.waitForFunction(() => window.kingdomUi.status().live.length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(20000);
  await shot(page, 'kingdom-city-live-event-1280-cinematic-test-fixture.png');
  assert.equal((await view(page)).camInside, '0');
});

test('reduced motion: a still 2D picture and the text feed; three.js never fetched', { skip, timeout: 120000 }, async (t) => {
  const feed = fixtureFeed();
  const { server, log, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: (url) => feed(url) });
  const browser = await launch();
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, errors } = await openPhonePage(browser, origin, { width: 412, height: 915, routeReplyFont, reducedMotion: 'reduce' });
  await page.locator('#kingdom-mini').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#kingdom-mini').click();
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === '2d', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#kingdom-feed .kd-row').length > 0);
  assert.ok(!log.paths.some((p) => p.startsWith('/vendor/three/')));
  assert.equal(await page.locator('#kingdom-badge').textContent(), BADGE.live);
  assert.deepEqual(errors, []);
});
