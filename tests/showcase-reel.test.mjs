/**
 * "Inside PG1 City" (the 24 November 2026 post): lib/showcase/reel.mjs,
 * the reel's render path (scripts/showcase-render.mjs --reel) and its post
 * builder (scripts/social-inside-city.mjs).
 *   - real only: a shot replays an event of the feed's last 7 days, or is
 *     left out; never a payment; never a caller hash;
 *   - counts come from the same events, with their dates;
 *   - the weather shot replays a recorded rain hour, then clearing;
 *   - captions are 2-6 words; the slide text keeps the wording rules;
 *   - the reel's encoding (H.264 veryfast CRF 18, yuv420p, 30 fps) and length.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { REEL_SHOTS, REEL_WINDOW_DAYS, pickReelEvents, reelCounts, pickWeatherChange, weatherFromRecord, planReelShot, followPose, captionFor, isPaymentEvent } from '../lib/showcase/reel.mjs';
import { poseAt } from '../lib/showcase/shots.mjs';

const NOW = Date.parse('2026-11-23T20:00:00Z');
const ev = (o) => ({ id: Math.random().toString(16).slice(2, 18).padEnd(16, '0'), time: new Date(NOW - 3600000).toISOString(), last: new Date(NOW - 3600000).toISOString(), kind: 'probe', gadget: 'gate_wardens', role: 'attacker', severity: 'low', country_code: 'DE', caller_hash: 'abcdef12', check: 'mcp_router', verdict_code: 'UNKNOWN_METHOD', reasons: [], count: 3, ...o });

test('thirteen shots (day and night), 4-6 s each, each with a plan and a 2-6 word caption', () => {
  assert.equal(REEL_SHOTS.length, 13);
  for (const l of ['day', 'night-rain', 'day-to-night', 'recorded']) assert.ok(REEL_SHOTS.some((s) => s.light === l), l);
  const ctx = { landmarks: { deckY: 60, emblemY: 240, forge: [-40, 0, 24] }, junction: { x: 10, z: -40 } };
  for (const s of REEL_SHOTS) {
    assert.ok(s.seconds >= 4 && s.seconds <= 6, s.id);
    const words = captionFor(s, { countries: 12 }).split(/\s+/).filter(Boolean).length;
    assert.ok(words >= 2 && words <= 6, `${s.id}: ${words} words`);
    const plan = planReelShot(s.id, ctx);
    for (const t of [0, 0.5, 1]) { const p = poseAt(plan, t); assert.ok(p.dist > 0 && p.phi > 0.8 && p.phi < (p.free ? 1.75 : 1.6), `${s.id} ${t}`); } // eye-level (free) shots may look a little up at the tower
  }
  assert.equal(captionFor(REEL_SHOTS.find((s) => s.id === 'probe-arrives'), { countries: 12 }), 'Probes from 12 countries');
});

test('real events only: picks come from the window, never a payment, a probe needs its country', () => {
  const events = [
    ev({ id: 'aaaa000000000001', country_code: null }),
    ev({ id: 'aaaa000000000002', country_code: 'FR', last: new Date(NOW - 7200000).toISOString() }),
    ev({ id: 'aaaa000000000003', kind: 'payment_challenge', gadget: 'toll_bridge', verdict_code: 'PAYMENT_REQUIRED_402' }),
    ev({ id: 'aaaa000000000004', kind: 'signed_result', gadget: 'seal_forge', role: 'kingdom', verdict_code: 'SIGNED', country_code: null }),
    ev({ id: 'aaaa000000000005', country_code: 'JP', last: new Date(NOW - 9 * 86400000).toISOString(), time: new Date(NOW - 9 * 86400000).toISOString() }),
    ev({ id: 'aaaa000000000006', kind: 'rate_limited', gadget: 'rate_shield', severity: 'medium', country_code: 'US' })
  ];
  const p = pickReelEvents(events, NOW);
  assert.equal(p.probe.id, 'aaaa000000000002', 'the latest probe with a country, inside 7 days');
  assert.equal(p.signed.id, 'aaaa000000000004');
  assert.ok(!p.director.some(isPaymentEvent), 'never a payment');
  assert.ok(p.director.length >= 2 && new Set(p.director.map((e) => e.gadget)).size === p.director.length);
  const none = pickReelEvents([ev({ country_code: null })], NOW);
  assert.equal(none.probe, null); assert.equal(none.signed, null);
  const c = reelCounts(events, NOW);
  assert.deepEqual(c.country_codes, ['FR', 'US'], 'no payment, nothing outside the window, no fog');
  assert.equal(c.countries, 2);
  assert.equal(c.window.to, new Date(NOW).toISOString());
  assert.equal(Date.parse(c.window.to) - Date.parse(c.window.from), REEL_WINDOW_DAYS * 86400000);
});

test('recorded weather: the latest rain hour followed by a dry, clearer hour; none when there is none', () => {
  const hourly = { time: ['2026-11-22T10:00', '2026-11-22T11:00', '2026-11-22T12:00', '2026-11-23T04:00', '2026-11-23T05:00', '2026-11-23T06:00'], weather_code: [61, 3, 2, 3, 63, 1], cloud_cover: [100, 90, 60, 100, 100, 20], precipitation: [1.2, 0, 0, 0, 2.4, 0] };
  const w = pickWeatherChange(hourly);
  assert.equal(w.rain.time, '2026-11-23T05:00'); assert.equal(w.clear.time, '2026-11-23T06:00');
  assert.equal(weatherFromRecord(w.rain).state, 'heavy_rain');
  assert.equal(weatherFromRecord(w.clear).state, 'clear');
  assert.equal(pickWeatherChange({ time: ['a', 'b'], weather_code: [3, 1], cloud_cover: [90, 10], precipitation: [0, 0] }), null);
  assert.equal(pickWeatherChange({ time: ['a', 'b'], weather_code: [61, 61], cloud_cover: [90, 90], precipitation: [1, 1] }), null);
});

test('a follow shot eases onto its subject', () => {
  const pose = { target: [0, 30, 0], dist: 120, theta: 0, phi: 1.2 };
  assert.deepEqual(followPose(pose, null, 0.5), pose);
  assert.deepEqual(followPose(pose, { x: 100, y: 50, z: -20 }, 0).target, [0, 30, 0]);
  assert.deepEqual(followPose(pose, { x: 100, y: 50, z: -20 }, 0.5).target, [100, 50, -20]);
});

test('the render: --reel takes every shot over 7 days, read only; the page never gets a caller hash', async () => {
  const { parseArgs, publicEvent } = await import('../scripts/showcase-render.mjs');
  const o = parseArgs(['--reel', 'inside-city', '--epoch', '2026-11-23T20:00:00Z']);
  assert.equal(o.days, 7); assert.equal(o.shots.length, 13); assert.equal(o.epoch, NOW);
  assert.deepEqual(parseArgs(['--shots', 'seal-forge', '--reel', 'inside-city']).shots, ['seal-forge']);
  assert.throws(() => parseArgs(['--reel', 'other']));
  const pub = publicEvent(ev({}));
  assert.ok(!('caller_hash' in pub) && !JSON.stringify(pub).includes('abcdef12'));
  const src = readFileSync(new URL('../scripts/showcase-render.mjs', import.meta.url), 'utf8');
  assert.match(src, /caller_hash: null/, 'hashes are left out of what the page gets');
  assert.match(src, /windowMs: days \* 86400000/);
  const { buildDefenseFeed, MAX_WINDOW_MS } = await import('../lib/defenseFeed.mjs');
  assert.equal(MAX_WINDOW_MS, 7 * 86400000);
  const seen = [];
  const f = await buildDefenseFeed({ supUrl: 'https://db.test', supKey: 'k', env: {}, now: NOW, windowMs: 7 * 86400000, fetchImpl: async (u) => { seen.push(String(u)); return new Response('[]', { status: 200 }); } });
  assert.equal(f.window_hours, 168);
  assert.ok(seen.some((u) => u.includes(encodeURIComponent(new Date(NOW - 7 * 86400000).toISOString()).slice(0, 10)) || u.includes(new Date(NOW - 7 * 86400000).toISOString().slice(0, 10))), 'reads from 7 days back');
  assert.equal((await buildDefenseFeed({ supUrl: 'https://db.test', supKey: 'k', env: {}, now: NOW, fetchImpl: async () => new Response('[]') })).window_hours, 24, 'the City keeps 24 h');
});

test('the post: encoding, length, slide words', async () => {
  const b = await import('../scripts/social-inside-city.mjs');
  assert.deepEqual([...b.REEL_ENC], ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30']);
  for (const n of [6, 8, 10]) {
    const plan = b.segmentPlan(REEL_SHOTS.slice(0, n).map((s) => ({ id: s.id, clipSeconds: s.seconds })));
    const secs = b.reelSeconds(plan);
    if (n >= 8) assert.ok(secs >= 25 && secs <= 35, `${n} shots: ${secs} s`);
    for (const p of plan) assert.ok(p.seconds <= REEL_SHOTS.find((s) => s.id === p.id).seconds - 0.3 + 1e-9);
  }
  const sl = b.slides({ counts: { countries: 12, country_codes: ['DE', 'FR'], window: { from: '2026-11-16T20:00:00Z', to: '2026-11-23T20:00:00Z' } } });
  assert.equal(sl.length, 7);
  assert.equal(sl[0].title, 'Inside PG1 City'); assert.equal(sl[0].tag, '24 November 2026');
  assert.equal(sl[6].title, 'Link in bio'); assert.equal(sl[6].line, 'Free checks for AI agents.');
  assert.equal(sl[2].tag, 'From 12 countries · 16 Nov–23 Nov');
  const words = sl.map((h) => `${h.tag} ${h.title} ${h.line}`).join(' ') + REEL_SHOTS.map((s) => s.caption).join(' ');
  for (const bad of [/\battack/i, /\bhostile/i, /\braiders?\b/i, /\bsafe\b/i, /©/, /\boutage|\bdown\b/i, /\b(claude|anthropic|gemini|openai|gpt|llama|mistral|groq)\b/i]) assert.ok(!bad.test(words), String(bad));
  for (const h of sl.slice(1, 6)) { const n = h.line.split(/\s+/).length; assert.ok(n <= 42, `${h.id}: ${n} words`); assert.ok(h.line.split(/(?<=\.)\s/).length >= 2 && h.line.split(/(?<=\.)\s/).length <= 3, `${h.id}: 2-3 sentences`); }
  assert.match(b.eventCardLine({ country_code: 'DE', gadget: 'gate_wardens', check: 'mcp_router', verdict_code: 'UNKNOWN_METHOD', count: 3 }), /^DE · Gate Wardens · mcp_router: unknown method probe ×3$/);
});

test('the 24 Nov post, once built, keeps its rules', { skip: !existsSync(new URL('../docs/social/2026-11-24/copy.md', import.meta.url)) && 'not built yet' }, () => {
  const copy = readFileSync(new URL('../docs/social/2026-11-24/copy.md', import.meta.url), 'utf8');
  assert.ok(!/caller_hash|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(copy), 'no caller hash, no IP');
  assert.ok(!/\b(attack|hostile|raiders?|safe)\b/i.test(copy.replace(/`[^`]*`/g, '')), 'wording');
  assert.ok(!/©/.test(copy)); assert.match(copy, /Project-Gifted1™/);
});

test('an airliner crosses the view high and far, never beside a building', async () => {
  const { skyPoint } = await import('../scripts/showcase-render.mjs');
  const { cameraPosition } = await import('../lib/showcase/shots.mjs');
  for (const pose of [{ target: [0, 140, 0], dist: 180, theta: 0.3, phi: 1.38, fov: 36 }, { target: [240, 4, -82], dist: 40, theta: 1.7, phi: 1.53, fov: 50 }, { target: [0, 12, 120], dist: 250, theta: 0.08, phi: 1.51, fov: 37 }, { target: [-90, 65, 55], dist: 780, theta: 0.6, phi: 1.21, fov: 41 }]) {
    const p = skyPoint(pose); const c = cameraPosition(pose);
    assert.ok(p, JSON.stringify(pose));
    assert.ok(p[1] >= 230, `${p[1]} m up`);
    assert.ok(Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) >= 100, 'never at the camera');
  }
  assert.equal(skyPoint({ target: [0, 0, 0], dist: 100, theta: 0, phi: 0.6, fov: 40 }), null, 'a low camera looking down shows no sky');
});
