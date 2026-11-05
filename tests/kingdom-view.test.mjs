/**
 * PG1 Kingdom Defence, the view's logic (public/kingdom/kingdom-data.js)
 * and the ground rules in its code:
 *   - events are checked on the way in; a wave that grows arrives as its
 *     difference only (no figure is staged twice);
 *   - the caption reads "Truth Lens: skill.md from NL, malicious, PAYMENT_REDIRECT";
 *     no country is "the fog";
 *   - the director prefers severe, big and recent events;
 *   - the sun follows Dublin's (high at midsummer noon, down at night);
 *   - the replay keeps the real order and fits the clip;
 *   - PG1 only defends: the view's code only ever fetches /api/defense-feed,
 *     loads three.js from this site only, and stages figures only from
 *     events it was given.
 * Run with: node --test tests/kingdom-view.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeEvent, createEventStore, eventLine, importance, pickDirectorEvent, dublinSun, daylight, replaySchedule, countryBearing, reasonLabel } from '../public/kingdom/kingdom-data.js';
import { kingdomTierOf, kingdomSettings, KINGDOM_TIERS } from '../public/kingdom/kingdom-scene.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-11-05T14:00:00Z');
const ev = (id, o = {}) => ({ id, time: new Date(NOW - 60000).toISOString(), last: new Date(NOW - 30000).toISOString(), kind: 'probe', gadget: 'gate_wardens', role: 'attacker', severity: 'low', country_code: 'CN', caller_hash: 'abcdef12', check: 'tool_router', verdict_code: 'UNKNOWN_TOOL', reasons: [], count: 1, ...o });

test('events are checked on the way in', () => {
  assert.equal(normalizeEvent(ev('zz')), null, 'a bad id');
  assert.equal(normalizeEvent(ev('abcdef0123456789', { gadget: 'catapult' })), null, 'an unknown gadget');
  const e = normalizeEvent(ev('abcdef0123456789', { country_code: 'nl<script>', caller_hash: '1234567890abcdef', reasons: ['A<b>', 'AGENT_MESSAGE_PAYMENT_REDIRECT'] }));
  assert.equal(e.country, null);
  assert.equal(e.caller, null, 'only a short hash');
  assert.deepEqual(e.reasons, ['AGENT_MESSAGE_PAYMENT_REDIRECT']);
});

test('a wave that grows arrives as its difference; counts follow', () => {
  const store = createEventStore();
  const first = store.merge({ today: { gate_wardens: 40 }, threat: { level: 'watch' }, events: [ev('abcdef0123456789', { count: 40 })] });
  assert.deepEqual(first.fresh.map((f) => f.delta), [40]);
  assert.equal(first.level, 'watch');
  const again = store.merge({ events: [ev('abcdef0123456789', { count: 40 })] });
  assert.equal(again.fresh.length, 0, 'nothing new, nothing staged');
  const grew = store.merge({ events: [ev('abcdef0123456789', { count: 55 }), ev('abcdef0123456780', { country_code: null })] });
  assert.deepEqual(grew.fresh.map((f) => f.delta).sort(), [1, 15]);
  assert.equal(store.today.gate_wardens, 56);
  assert.equal(store.today.fog_wall, 1);
  assert.equal(createEventStore().merge({ events: [] }).fresh.length, 0, 'an empty feed stages nothing: the kingdom is calm');
});

test('the caption line', () => {
  const lens = normalizeEvent(ev('abcdef0123456789', { gadget: 'truth_lens', kind: 'check_verdict', check: 'check_agent_message', verdict_code: 'malicious', subject: 'skill_md', country_code: 'NL', reasons: ['AGENT_MESSAGE_PAYMENT_REDIRECT'] }));
  assert.equal(eventLine(lens), 'Truth Lens: skill.md from NL, malicious, PAYMENT_REDIRECT');
  assert.equal(eventLine(normalizeEvent(ev('abcdef0123456781', { country_code: null, count: 300 }))), 'Gate Wardens: tool_router from the fog, unknown tool probe ×300');
  assert.equal(eventLine(normalizeEvent(ev('abcdef0123456782', { gadget: 'toll_bridge', role: 'ally', verdict_code: 'SETTLED', check: 'get_cve_details', country_code: 'IE' }))), 'Toll Gantry: get_cve_details from IE, paid and crossed');
  assert.equal(reasonLabel('HOSTNAME_LOOKALIKE'), 'LOOKALIKE');
});

test('the director prefers severe, big and recent', () => {
  const small = normalizeEvent(ev('abcdef0123456789'));
  const big = normalizeEvent(ev('abcdef0123456788', { count: 300 }));
  const high = normalizeEvent(ev('abcdef0123456787', { severity: 'high' }));
  const old = normalizeEvent(ev('abcdef0123456786', { severity: 'high', last: new Date(NOW - 3 * 3600e3).toISOString(), time: new Date(NOW - 3 * 3600e3).toISOString() }));
  assert.ok(importance(big, NOW) > importance(small, NOW));
  assert.ok(importance(high, NOW) > importance(old, NOW));
  assert.equal(pickDirectorEvent([small, big, high, old], NOW).id, high.id, 'one high-severity event outranks a wave of probes');
  assert.equal(pickDirectorEvent([small, big, old], NOW).id, big.id);
  assert.equal(pickDirectorEvent([], NOW), null);
});

test('the sun over Dublin', () => {
  const noon = dublinSun(Date.parse('2026-06-21T12:30:00Z'));
  assert.ok(Math.abs(noon.elevation * 180 / Math.PI - 60) < 1.5, String(noon.elevation));
  assert.ok(dublinSun(Date.parse('2026-11-05T23:00:00Z')).elevation < 0);
  assert.equal(daylight(-0.5), 0);
  assert.equal(daylight(0.6), 1);
});

test('the replay: the real order, inside the clip', () => {
  const events = Array.from({ length: 50 }, (_, i) => normalizeEvent(ev(`abcdef01234567${String(i).padStart(2, '0')}`, { time: new Date(NOW - (i + 1) * 1700e3).toISOString(), last: new Date(NOW - (i + 1) * 1700e3).toISOString() })));
  const plan = replaySchedule(events, 30000, { now: NOW });
  assert.equal(plan.length, 50);
  for (let i = 1; i < plan.length; i++) { assert.ok(plan[i].at >= plan[i - 1].at); assert.ok(plan[i].event.time >= plan[i - 1].event.time); }
  assert.ok(plan[plan.length - 1].at <= 28500);
  assert.equal(replaySchedule([], 30000, { now: NOW }).length, 0, 'no events: an empty replay, never a made-up one');
});

test('bearings: from Dublin, stable', () => {
  const us = countryBearing('US') * 180 / Math.PI; const cn = countryBearing('CN') * 180 / Math.PI;
  assert.ok(us > 270 && us < 320, String(us));
  assert.ok(cn > 30 && cn < 80, String(cn));
  assert.equal(countryBearing('ZW'), countryBearing('ZW'));
});

test('tiers: the viewer\'s tiers map onto Phone, Balanced and Cinematic', () => {
  assert.deepEqual(['low', 'medium', 'high', 'ultra', 'cinematic'].map(kingdomTierOf), ['phone', 'phone', 'balanced', 'cinematic', 'cinematic']);
  const phone = kingdomSettings('phone');
  assert.equal(phone.shadows, 0, 'baked shadows only');
  assert.equal(phone.post, null, 'no post-processing');
  assert.equal(phone.shafts, false, 'no volumetrics');
  assert.equal(phone.targetFps, 30);
  assert.ok(kingdomSettings('cinematic').post.gtao && kingdomSettings('cinematic').shafts);
  assert.deepEqual(KINGDOM_TIERS, ['phone', 'balanced', 'cinematic']);
});

function files(dir) {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });
}

test('ground rules in the code: defend only, real events only, one 3D stack', () => {
  const src = files(join(ROOT, 'public/kingdom')).filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(f, 'utf8')]);
  for (const [f, s] of src) {
    const fetches = [...s.matchAll(/fetch(?:Impl)?\(\s*([^,)]+)/g)].map((m) => m[1].trim());
    // The defence feed, and PG1's own brand asset (same origin): nothing else.
    for (const target of fetches) assert.ok(/defense-feed|^url$|^\.\.\.a$|^BRAND_SVG_URL$/.test(target), `${f} fetches ${target}`);
    assert.ok(!/https?:\/\/(?!threejs\.org)/.test(s.replace(/\/\/.*$/gm, '')), `${f} names no outside URL`);
    assert.ok(!/from ['"]three['"]|unpkg|jsdelivr|cdnjs/.test(s), `${f} uses the app's own three.js`);
    assert.ok(!/demo|simulat(?:e|ed|ion)\s+attack|fake\s+event/i.test(s.replace(/\/\/.*$/gm, '')), `${f} has no demo or simulated attacks`);
    assert.ok(!/\bWebSocket\b|sendBeacon|XMLHttpRequest/.test(s), `${f} opens no other connection`);
  }
  const actors = readFileSync(join(ROOT, 'public/kingdom/kingdom-actors.js'), 'utf8');
  const scene = readFileSync(join(ROOT, 'public/kingdom/kingdom-scene.js'), 'utf8');
  assert.equal((scene.match(/actors\.stage\(/g) || []).length, 1, 'figures are staged in one place: ingest(fresh events)');
  assert.ok(/ingest\(fresh/.test(scene));
  assert.ok(/from '\.\.\/sandbox\/quality\.js'/.test(scene) && /from '\.\.\/sandbox\/post\.js'/.test(scene), 'reuses the viewer engine');
  assert.ok(!/stage\(\{|stage\(\s*\[/.test(actors), 'no literal event is staged');
});

test('Record mode: the clip\'s size, crop and words', async () => {
  const { clipSize, coverCrop, clipLabel, clipCaption } = await import('../public/kingdom/kingdom-record.js');
  assert.deepEqual(clipSize('16:9'), { w: 1920, h: 1080 });
  assert.deepEqual(clipSize('9:16', 1280), { w: 720, h: 1280 });
  const c = coverCrop(1000, 1000, 1080, 1920);
  assert.ok(Math.abs(c.sw / c.sh - 1080 / 1920) < 1e-9 && c.sy === 0);
  assert.match(clipCaption(null, 'live'), /calm/, 'a quiet clip says so; nothing is staged for it');
  const lens = normalizeEvent(ev('abcdef0123456789', { gadget: 'truth_lens', check: 'check_agent_message', verdict_code: 'malicious', subject: 'skill_md', country_code: 'NL', reasons: ['AGENT_MESSAGE_PAYMENT_REDIRECT'] }));
  assert.match(clipCaption(lens, 'replay'), /^\d\d:\d\d · Truth Lens: skill\.md from NL, malicious, PAYMENT_REDIRECT$/);
});

test('Fix 1: the app carries no fixture events; placeholder caller hashes never render; no caller shows "—"', async () => {
  const { PLACEHOLDER_CALLER_HASHES } = await import('../public/kingdom/kingdom-data.js');
  const { feedRowHtml } = await import('../public/kingdom/kingdom-ui.js');
  const appFiles = [...files(join(ROOT, 'public')), ...files(join(ROOT, 'api')), ...files(join(ROOT, 'lib'))].filter((f) => /\.(m?js|html|json)$/.test(f));
  for (const f of appFiles) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!/kingdomFixtures|tests\/helpers|seededFeed|fixtureFeed/.test(s), `${f} reaches test fixtures`);
    assert.ok(!/caller_hash['"]?\s*:\s*['"][0-9a-f]{8,32}['"]/.test(s), `${f} carries a literal caller hash`);
    if (!f.endsWith('kingdom-data.js')) for (const h of PLACEHOLDER_CALLER_HASHES) assert.ok(!new RegExp(`\\b${h}\\b`).test(s) || !/kingdom|defen[sc]e/i.test(f), `${f} carries ${h}`);
  }
  for (const h of PLACEHOLDER_CALLER_HASHES) assert.equal(normalizeEvent(ev('abcdef0123456789', { caller_hash: h })).caller, null, h);
  const noCaller = feedRowHtml(normalizeEvent(ev('abcdef0123456789', { caller_hash: null })));
  assert.match(noCaller, />—</);
  assert.match(feedRowHtml(normalizeEvent(ev('abcdef0123456789', { caller_hash: '6ee6f69f' }))), />6ee6f69f</);
  const ui = readFileSync(join(ROOT, 'public/kingdom/kingdom-ui.js'), 'utf8');
  assert.match(ui, /No defence events in the last 24 hours/);
});

test('HUD: loading, "not read", and plurals', async () => {
  const { hudText, flagStrip } = await import('../public/kingdom/kingdom-ui.js');
  assert.equal(hudText(null, null, { loaded: false }), 'Defences: loading…');
  assert.equal(hudText({ checks: null }, { turned_away: 0, settled: 0 }), 'Defences active: checks live: not read · 0 threats turned away today');
  assert.equal(hudText({ checks: 1 }, { turned_away: 1, settled: 1 }), 'Defences active: 1 check live · 1 threat turned away today');
  assert.equal(hudText({ checks: 21 }, { turned_away: 67, settled: 2 }), 'Defences active: 21 checks live · 67 threats turned away today');
  assert.ok(!/payment/.test(hudText({ checks: 2 }, { turned_away: 2, settled: 5 })), 'threats only');
  assert.equal(flagStrip([['CN', 3], ['FR', 1]]), '🇨🇳🇫🇷');
  assert.match(flagStrip(['CN', 'FR', 'DE', 'US', 'BR', 'IN', 'JP'].map((c) => [c, 1])), / \+2$/);
});

test('captions, ticker and the claim: flags and ISO codes, LIVE only for live arrivals', async () => {
  const { flagOf, originTag, whenLabel, captionLine, tickerLine, countriesText, BADGE, FEED_HEADING } = await import('../public/kingdom/kingdom-data.js');
  const lens = normalizeEvent(ev('abcdef0123456789', { gadget: 'phishing_net', kind: 'check_verdict', check: 'check_hostname_reputation', verdict_code: 'flagged', country_code: 'FR', reasons: ['HOSTNAME_LOOKALIKE'] }));
  assert.equal(flagOf('FR'), '🇫🇷');
  assert.equal(captionLine(lens), '🇫🇷 FR · Phishing Net · check_hostname_reputation: flagged (LOOKALIKE)');
  assert.equal(originTag(normalizeEvent(ev('abcdef0123456781', { country_code: null }))), 'fog');
  assert.equal(whenLabel(lens, { now: lens.last + 12000 }), 'LIVE · 12 s ago');
  assert.match(whenLabel(lens, { replay: true }), /^Earlier today · \d\d:\d\d$/);
  assert.ok(!/LIVE/.test(whenLabel(lens, { replay: true })), 'a replay is never LIVE');
  assert.equal(tickerLine(lens), '🇫🇷 FR · Mimic boat · check_hostname_reputation: flagged');
  assert.equal(countriesText(1), 'Hostile traffic from 1 country · last 24 h');
  assert.equal(countriesText(5), 'Hostile traffic from 5 countries · last 24 h');
  assert.equal(BADGE.live, '● LIVE · Real PG1 events — not a simulation');
  assert.equal(BADGE.paused, 'Feed paused — showing last real events');
  assert.equal(BADGE.replay, 'Real PG1 events — time-lapsed replay, not a simulation');
  assert.equal(FEED_HEADING, 'Last 24 hours · Real PG1 events — not a simulation');
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  assert.ok(html.includes(FEED_HEADING));
});

test('Record mode: the badge and the end card (date, N, both footnotes); replays say time-lapsed', async () => {
  const { clipLabel, endCardLines, LOG_FOOTNOTE } = await import('../public/kingdom/kingdom-record.js');
  assert.equal(clipLabel('live'), '● LIVE · Real PG1 events — not a simulation');
  assert.equal(clipLabel('replay'), 'Real PG1 events — time-lapsed replay, not a simulation');
  const lines = endCardLines({ turned_away: 1, settled: 1 }, { n: 5, now: Date.parse('2026-11-05T20:00:00Z') });
  assert.equal(lines[0], 'Real PG1 events, 5 November 2026 — not a simulation · Hostile traffic from 5 countries in 24 h');
  assert.equal(lines[1], '1 threat turned away today');
  assert.ok(!lines.some((l) => /payment/.test(l)), 'threats only');
  assert.equal(lines[2], "Visualised live from PG1's logs. Location = traffic origin (IP geolocation), not attacker identity.");
  assert.equal(lines[2], LOG_FOOTNOTE);
  assert.match(lines[3], /IP geolocation/);
});

test('the camera never ends up inside a building', async () => {
  const { makeObstacleIndex } = await import('../public/kingdom/kingdom-world.js');
  const { clearCamera } = await import('../public/kingdom/kingdom-scene.js');
  const idx = makeObstacleIndex([{ x: 100, z: 0, hw: 15, hd: 15, top: 120 }, { x: 0, z: 0, hw: 30, hd: 30, top: 230 }]);
  assert.ok(idx.hit(100, 50, 5));
  assert.equal(idx.hit(100, 140, 5), null);
  assert.equal(idx.hit(300, 10, 300), null);
  // A camera inside a tower is lifted above it; one whose view line crosses a tower too.
  const y1 = clearCamera({ x: 100, y: 60, z: 0 }, { x: 60, y: 40, z: 0 }, idx);
  assert.ok(y1 > 120 && !idx.hit(100, y1, 0, 0), String(y1));
  const y2 = clearCamera({ x: 200, y: 60, z: 0 }, { x: 40, y: 40, z: 0 }, idx);
  assert.ok(y2 > 60);
  assert.equal(clearCamera({ x: 600, y: 300, z: 600 }, { x: 500, y: 60, z: 500 }, idx), 300, 'a clear view is left alone');
});

test('the globe: projection and arcs', async () => {
  const { project, greatCircle } = await import('../public/kingdom/kingdom-globe.js');
  const [x, y, v] = project(53.35, -6.26, 53.35, -6.26);
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9 && v, 'the centre projects to the middle');
  assert.equal(project(-53, 174, 53, -6)[2], false, 'the far side is hidden');
  const arc = greatCircle([35, 103], [53.35, -6.26], 10);
  assert.equal(arc.length, 11);
  assert.ok(Math.abs(arc[10][0] - 53.35) < 1e-6 && Math.abs(arc[10][1] + 6.26) < 1e-6, 'arcs end at PG1 in Dublin');
});

test('the emblem is the brand asset: same paths and colours, never redrawn', async () => {
  const { parseBrandSvg, BRAND_SVG_URL, pathCommands } = await import('../public/kingdom/kingdom-emblem.js');
  assert.equal(BRAND_SVG_URL, '/brand/pg1-shield.svg');
  const svg = readFileSync(join(ROOT, 'public/brand/pg1-shield.svg'), 'utf8');
  const b = parseBrandSvg(svg);
  assert.deepEqual(b.paths.map((p) => p.fill), ['#f3c623', '#0a0a0b'], 'gold shield, black "1"');
  assert.equal(pathCommands(b.paths[0].d).filter((c) => c[0] === 'C').length, 2);
  const mark = readFileSync(join(ROOT, 'public/brand/pg1-mark.svg'), 'utf8');
  for (const p of b.paths) assert.ok(mark.includes(p.d), 'the same shield as the PG1 wordmark');
  const src = ['kingdom-world.js', 'kingdom-actors.js', 'kingdom-scene.js'].map((f) => readFileSync(join(ROOT, 'public/kingdom', f), 'utf8')).join('\n');
  assert.ok(!/M221\.76 0L262\.5/.test(src) && !/shieldShape\(/.test(src.replace(/export function shieldShape[\s\S]*?\n}\n/, '')), 'the 3D scene builds the emblem from the brand file, not a copy');
});

test('the city\'s own life: windows follow Dublin time, weather by day, billboards only from the feed, no enemy red', async () => {
  const { windowRatios, dublinHour, dayWeather, billboardLines, isEnemyColour, ENEMY_COLORS, PG1_COLORS } = await import('../public/kingdom/kingdom-data.js');
  assert.ok(windowRatios(19).office > windowRatios(2).office, 'offices lit in the evening, dim late');
  assert.ok(windowRatios(22).home > windowRatios(22).office, 'homes later than offices');
  assert.ok(windowRatios(3).home < windowRatios(21).home);
  const h = dublinHour(Date.parse('2026-07-01T12:00:00Z'));
  assert.equal(Math.floor(h), 13, 'Dublin summer time');
  assert.equal(Math.floor(dublinHour(Date.parse('2026-12-01T12:00:00Z'))), 12);
  assert.equal(dayWeather(Date.parse('2026-11-05T08:00:00Z')), dayWeather(Date.parse('2026-11-05T22:00:00Z')), 'one weather per Dublin day');
  assert.deepEqual(billboardLines({ countries: 5, threats: 31, checks: 21 }), ['5 countries · hostile traffic, last 24 h', '31 threats turned away today', '21 checks live']);
  assert.deepEqual(billboardLines({}), ['not read countries · hostile traffic, last 24 h', 'not read threats turned away today', 'not read checks live']);
  assert.ok(!billboardLines({ countries: 1, threats: 1, checks: 1 }).some((l) => /payment/.test(l)));
  for (const c of Object.values(ENEMY_COLORS)) if (c !== ENEMY_COLORS.shadow) assert.ok(isEnemyColour(c), c.toString(16));
  for (const c of Object.values(PG1_COLORS)) assert.ok(!isEnemyColour(c), c.toString(16));
});
