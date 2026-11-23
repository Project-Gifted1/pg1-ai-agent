#!/usr/bin/env node
// PG1 Showcase render: art-directed shots of PG1 City and PG1 Universe,
// rendered offline (not in real time) in headless Chromium and encoded with
// ffmpeg. Started by hand or by .github/workflows/showcase.yml.
//
//   node scripts/showcase-render.mjs [--shots city-night,city-rain,...]
//        [--size 1080x1920] [--out showcase-out] [--frames N] [--warmup 40]
//        [--gpu] [--keep-frames] [--jobs N] [--range FIRST:LAST]
//
// --range renders only those frames of one shot (numbered as in the whole
// shot, the clock moved on to the first), keeps them and does not encode:
// several processes can share a long shot, then ffmpeg encodes the folder.
//
// --jobs N renders N shots at once, each in its own browser (software 3D
// draws on one core per browser).
//
// How a shot is made:
//   - this script serves public/ on 127.0.0.1 with two bare pages: the City
//     scene (public/kingdom/kingdom-scene.js) or the Sandbox viewer's scene
//     (public/sandbox/sandbox-scene.js), each at the Showcase profile
//     (public/sandbox/quality.js SHOWCASE_SETTINGS: desktop only, never
//     chosen by Auto, the probe or the governor; a desktop viewport, no
//     touch, so never the phone settings);
//   - the page's clock is virtual: requestAnimationFrame, performance.now()
//     and Date.now() are stepped by this script exactly 1000/30 ms a frame,
//     however long the frame takes to draw (the same frames the viewer's
//     recorder, public/sandbox/capture.js, takes at CAPTURE_FPS);
//   - each frame the scripted camera's pose (lib/showcase/shots.mjs) is set,
//     the clock steps one frame, the frame is saved as a PNG;
//   - ffmpeg encodes the frames: H.264, -preset veryfast, CRF 18, yuv420p.
//
// Data (read only, real only):
//   PG1 City's events, beacons and state come from PG1's own database
//   (lib/defenseFeed.mjs, lib/defenseState.mjs) when SUPABASE_URL and
//   SUPABASE_SERVICE_ROLE_KEY are set; without them the city is shown calm
//   (nothing is staged: the City only ever shows real events). Payments are
//   never shown: no payment events, no toll gantry.
//   The first universe (lib/sandbox/first-universe.mjs) is read through a
//   store that refuses every write: it is never stepped, reset or changed.
//   Without the database it cannot be read, and the shot shows a new world
//   made from the same universe template (in memory), named as such in
//   manifest.json. Benin–Warri c. 1610 and the deep-space shot use worlds
//   made in memory from their templates (Benin–Warri at step 0: dawn).
//
// Out (in --out): <shot>.mp4, <shot>.png (a still from the shot),
// manifest.json (sizes, frames, the data each shot used). No secrets are
// written anywhere.

import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SHOTS, shotById as baseShotById, planShot, poseAt, frameCount, SHOWCASE_FPS, STILLS, stillById } from '../lib/showcase/shots.mjs';
import { REEL_ID, REEL_SHOTS, REEL_WINDOW_DAYS, reelShotById, planReelShot, followPose, pickReelEvents, reelCounts, pickWeatherChange, weatherFromRecord } from '../lib/showcase/reel.mjs';

// A Showcase shot or a reel shot (lib/showcase/reel.mjs), by id.
const shotById = (id) => baseShotById(id) || (reelShotById(id) ? { ...reelShotById(id), scene: 'city', reel: true } : null);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8', '.bin': 'application/octet-stream', '.ktx2': 'application/octet-stream' };

export function parseArgs(argv) {
  const o = { shots: SHOTS.map((s) => s.id), width: 1080, height: 1920, out: join(ROOT, 'showcase-out'), frames: null, warmup: 40, gpu: false, keepFrames: false, fps: SHOWCASE_FPS, jobs: 1, range: null, stills: null, reel: null, days: 1, epoch: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => argv[++i];
    if (a === '--shots') o.shots = v().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--size') { const m = /^(\d+)x(\d+)$/.exec(v()); if (!m) throw new Error('--size WxH'); o.width = Number(m[1]); o.height = Number(m[2]); }
    else if (a === '--out') o.out = resolve(v());
    else if (a === '--frames') o.frames = Math.max(1, Number(v()) | 0);
    else if (a === '--warmup') o.warmup = Math.max(0, Number(v()) | 0);
    else if (a === '--gpu') o.gpu = true;
    else if (a === '--stills') o.stills = v().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--jobs') o.jobs = Math.max(1, Number(v()) | 0);
    else if (a === '--range') { const m = /^(\d+):(\d+)$/.exec(v()); if (!m || Number(m[1]) < 1 || Number(m[2]) < Number(m[1])) throw new Error('--range FIRST:LAST (1-based)'); o.range = [Number(m[1]), Number(m[2])]; }
    else if (a === '--keep-frames') o.keepFrames = true;
    // --reel inside-city: the 24 Nov post's ten City shots, replaying the
    // defence feed's last 7 days (lib/showcase/reel.mjs).
    else if (a === '--reel') { const r = v(); if (r !== REEL_ID) throw new Error(`unknown reel ${r} (reels: ${REEL_ID})`); o.reel = r; o.days = REEL_WINDOW_DAYS; if (!argv.includes('--shots')) o.shots = REEL_SHOTS.map((x) => x.id); }
    else if (a === '--days') o.days = Math.max(1, Math.min(7, Number(v()) | 0));
    // --epoch ISO: the moment "now" is for the data (every parallel job reads the same window).
    else if (a === '--epoch') { const t = Date.parse(v()); if (!Number.isFinite(t)) throw new Error('--epoch ISO time'); o.epoch = t; }
    else throw new Error(`unknown option ${a}`);
  }
  if (o.reel && argv.includes('--shots')) for (const id of o.shots) if (!reelShotById(id)) throw new Error(`${id} is not a shot of the reel ${o.reel}`);
  if (o.stills) for (const id of o.stills) if (!stillById(id)) throw new Error(`unknown still ${id} (stills: ${STILLS.map((x) => x.id).join(', ')})`);
  for (const id of o.shots) if (!shotById(id)) throw new Error(`unknown shot ${id} (shots: ${SHOTS.map((s) => s.id).join(', ')})`);
  if (o.width % 2 || o.height % 2) throw new Error('--size must be even (yuv420p)');
  return o;
}

// --- data, read only ----------------------------------------------------------------------------

// A store that only reads: any write throws, so the first universe can never
// be stepped, reset or changed from here.
const WRITE = /^(create|update|delete|insert|add|put|save|set|step|purge|prune|revoke|append|record)/i;
export function readOnlyStore(store) {
  return new Proxy(store, { get(t, k) { const v = t[k]; if (typeof v === 'function' && WRITE.test(String(k))) return () => { throw new Error(`showcase: read only (${String(k)} refused)`); }; return typeof v === 'function' ? v.bind(t) : v; } });
}

// Payments never appear in a showcase: no payment events of any kind.
export const isPaymentEvent = (e) => !!e && (e.gadget === 'toll_bridge' || /pay|settle|402|x402/i.test(`${e.kind || ''} ${e.verdict || ''} ${e.check || ''}`) || e.verdict === 'JOB_PAID');

export async function loadData(log, { days = 1, epoch = null } = {}) {
  const env = process.env;
  const now = Number.isFinite(epoch) ? epoch : Date.now();
  const supUrl = String(env.SUPABASE_URL || '').trim(); const supKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const live = !!(supUrl && supKey);
  const { createSandboxStore } = await import('../lib/sandbox/store.mjs');
  const { createWorld, observeWorld, pg1Principal } = await import('../lib/sandbox/worlds.mjs');
  const { FIRST_UNIVERSE_ID } = await import('../lib/sandbox/first-universe.mjs');
  const mem = createSandboxStore();
  const pg1 = pg1Principal();
  const worlds = {}; const sources = {};
  const view = async (store, id) => { const w = await store.getWorld(id); const v = await observeWorld(store, { owner: w.owner, quota: pg1.quota }, { world_id: w.id, events: 0 }); return { ...v, readOnly: true }; };
  // The first universe: read only, from PG1's database.
  let first = null;
  if (live) {
    try { const ro = readOnlyStore(createSandboxStore({ supUrl, supKey })); first = await view(ro, FIRST_UNIVERSE_ID); sources['first-universe'] = `PG1 first universe ${FIRST_UNIVERSE_ID} (read only, step ${first.tick})`; } catch (e) { log(`first universe not readable: ${e.message}`); first = null; }
  }
  if (!first) {
    const w = await createWorld(mem, pg1, { name: 'PG1 Universe', template: 'universe' });
    first = await view(mem, w.id);
    sources['first-universe'] = 'a new world from the universe template (in memory; the first universe needs the read-only database)';
  }
  worlds['first-universe'] = first;
  worlds.space = first;
  sources.space = sources['first-universe'];
  const benin = await createWorld(mem, pg1, { name: 'Benin–Warri c. 1610', template: 'benin-warri' });
  worlds['benin-warri'] = await view(mem, benin.id);
  sources['benin-warri'] = 'Benin–Warri c. 1610 template at step 0 (dawn), in memory';
  // PG1 City: the real 24 h feed and PG1's state, or calm.
  let feed = { ok: true, events: [], state: null, weather: null };
  sources.city = 'no database: a calm city (no events staged)';
  if (live) {
    try {
      const { buildDefenseFeed } = await import('../lib/defenseFeed.mjs');
      const { buildDefenseState } = await import('../lib/defenseState.mjs');
      feed = await buildDefenseFeed({ supUrl, supKey, env: {}, now, windowMs: days * 86400000, maxEvents: days > 1 ? 5000 : undefined });
      try { feed.state = await buildDefenseState({ env }); } catch (e) { feed.state = null; }
      const all = Array.isArray(feed.events) ? feed.events.length : 0;
      // Never a payment; never a caller: hashes are left out of what the page gets.
      feed.events = (feed.events || []).filter((e) => !isPaymentEvent(e)).map((e) => ({ ...e, caller_hash: null }));
      sources.city = `real PG1 events, last ${days > 1 ? `${days} days` : '24 h'} to ${new Date(now).toISOString()} (${feed.events.length} shown of ${all}; payments and caller hashes left out)`;
    } catch (e) { log(`feed not readable: ${e.message}`); }
  }
  // The reel: which real events each shot replays, the counts captions may
  // use, and Dublin's recorded weather (rain, then clearing).
  let reel = null;
  if (days > 1) {
    const picks = pickReelEvents(feed.events, now);
    const counts = reelCounts(feed.events, now);
    const weather = await recordedWeather(now, log);
    reel = { now: new Date(now).toISOString(), days, picks, counts, weather };
    log(`reel: probe ${picks.probe ? `${picks.probe.id} ${picks.probe.country_code}` : 'none'}, signed ${picks.signed ? picks.signed.id : 'none'}, director ${picks.director.length}, countries ${counts.countries}, weather ${weather ? `${weather.change.rain.time} -> ${weather.change.clear.time} (${weather.source})` : 'none'}`);
  }
  return { worlds, feed, sources, reel };
}

// Dublin's recorded hourly weather for the window (Open-Meteo: the archive,
// then the forecast API's past days), and a rain hour followed by clearing.
// null when it cannot be read or holds no such change: the shot is left out.
export async function recordedWeather(now, log = () => {}, fetchImpl = globalThis.fetch) {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const q = 'latitude=53.3498&longitude=-6.2603&hourly=weather_code,cloud_cover,precipitation,is_day&timezone=Europe%2FDublin';
  const urls = [
    ['Open-Meteo archive (ERA5 reanalysis)', `https://archive-api.open-meteo.com/v1/archive?${q}&start_date=${day(now - REEL_WINDOW_DAYS * 86400000)}&end_date=${day(now)}`],
    ['Open-Meteo forecast API, past days', `https://api.open-meteo.com/v1/forecast?${q}&past_days=${REEL_WINDOW_DAYS}&forecast_days=1`]
  ];
  for (const [source, url] of urls) {
    for (let k = 0; k < 3; k++) {
      try {
        const r = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
        const j = await r.json();
        if (!r.ok || !j.hourly) throw new Error(j.reason || `HTTP ${r.status}`);
        // Only hours already past (a record, never a forecast).
        const cut = j.hourly.time.findIndex((t) => Date.parse(`${t}:00Z`) > now);
        const hourly = cut < 0 ? j.hourly : Object.fromEntries(Object.entries(j.hourly).map(([kk, v]) => [kk, v.slice(0, cut)]));
        const change = pickWeatherChange(hourly);
        if (!change) { log(`weather: ${source} has no rain followed by clearing in the window`); return null; }
        return { source, attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)', change, rain: weatherFromRecord(change.rain), clear: weatherFromRecord(change.clear) };
      } catch (e) { log(`weather: ${source} try ${k + 1}: ${e.message}`); await new Promise((res) => setTimeout(res, 2000 * (k + 1))); }
    }
  }
  return null;
}

// --- the pages ------------------------------------------------------------------------------------

// The virtual clock, before any page script: frames only when the script steps them.
export const CLOCK_SCRIPT = `(() => {
  let vt = 1000; let base = Date.now(); let q = []; let seq = 0; let free = null;
  const realDate = Date;
  performance.now = () => vt;
  Date.now = () => base + vt;
  window.requestAnimationFrame = (cb) => { const id = ++seq; q.push({ id, cb }); return id; };
  window.cancelAnimationFrame = (id) => { q = q.filter((x) => x.id !== id); };
  const advance = (ms) => { vt += ms; const run = q; q = []; for (const x of run) { try { x.cb(vt); } catch (e) { console.error(e); } } };
  // Until the script takes the clock, frames run on their own (loading).
  free = setInterval(() => advance(16), 16);
  // A desktop computer: no touch, 8 GB, 8 cores (never a phone's settings).
  try { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, configurable: true }); } catch (e) {}
  try { Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8, configurable: true }); } catch (e) {}
  try { Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 0, configurable: true }); } catch (e) {}
  window.__showcase = { advance, skip(ms) { vt += ms; }, lock() { clearInterval(free); free = null; }, setDate(ms) { base = ms - vt; }, now: () => vt, pending: () => q.length, realDate };
})();`;

const PAGE_CSS = `html,body{margin:0;height:100%;background:#000;overflow:hidden}#view{position:fixed;inset:0}#view canvas{display:block;width:100%!important;height:100%!important}
.sandbox-hud,.sandbox-world-badge,.debug-overlay{display:none!important}
#view>*:not(canvas):not(.sandbox-hud){display:none!important}`;

function cityPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>PG1 City · Showcase</title><style>${PAGE_CSS}</style></head><body><div id="view"></div>
<script type="module">
import { createKingdomScene } from '/kingdom/kingdom-scene.js';
import { createEventStore } from '/kingdom/kingdom-data.js';
const view = document.getElementById('view');
const feed = await (await fetch('/showcase/feed')).json();
const scene = await createKingdomScene(view, { coarse: false, showcase: true, tier: 'cinematic' });
const store = createEventStore({ max: 6000 });
store.merge(feed);
window.showcase = {
  scene,
  ready: () => view.dataset.renderer === 'webgl' && view.dataset.profile === 'showcase',
  setup({ light, weather, epoch }) {
    if (epoch) window.__showcase.setDate(epoch);
    scene.setLight(light === 'dusk' ? 'dusk' : 'live');
    scene.setWeather(weather ? { ...weather, source: 'showcase' } : null);
    if (feed.state) scene.setState(feed.state);
    scene.setThreat('calm');
    scene.setDirector(false);
    if (scene.settleWeather) scene.settleWeather();
    if (scene.setShowcaseLook) scene.setShowcaseLook({ mood: weather && /rain/.test(weather.state) ? 'rain' : 'night' });
  },
  // The last few real events of the day (never a payment), as the City replays them on open.
  stage() { const list = store.list().filter((e) => !(e.gadget === 'toll_bridge' || /pay|settle|402/i.test(String(e.kind) + String(e.verdict)))).slice(0, 6).reverse(); if (list.length) scene.ingest(list.map((e) => ({ event: e, delta: e.count }))); return list.length; },
  junction: () => (scene.busiestJunction ? scene.busiestJunction() : null),
  // The reel: replay exactly these real events (by id), follow them, set the clock and weather.
  play(ids) { const list = ids.map((id) => store.get(id)).filter(Boolean); if (list.length) scene.ingest(list.map((e) => ({ event: e, delta: e.count }))); return list.map((e) => e.id); },
  whereIs: (id) => scene.whereIs(id), eta: (id) => scene.eta(id), sealAt: () => scene.sealAt(), landmarks: () => scene.landmarks(),
  director: (on) => scene.setDirector(!!on), focusOf: () => view.dataset.focus || '',
  weatherNow: (w) => scene.setWeather(w ? { ...w, source: 'showcase' } : null),
  pose: (p) => scene.setShowcasePose(p),
  info: () => scene.showcaseInfo(),
  overlays: () => [...view.querySelectorAll('*')].filter((e) => e.tagName !== 'CANVAS' && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && (e.textContent || '').trim()).length,
  frames: () => Number(view.dataset.frames || 0)
};
</script></body></html>`;
}

function sandboxPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>PG1 Universe · Showcase</title><style>${PAGE_CSS}</style></head><body><div id="view"></div>
<script type="module">
import { createSandboxScene } from '/sandbox/sandbox-scene.js';
const view = document.getElementById('view');
const which = new URLSearchParams(location.search).get('world');
const data = await (await fetch('/showcase/world?which=' + encodeURIComponent(which))).json();
const scene = await createSandboxScene(view, { coarse: false, showcase: true });
scene.update(data.world, { duration: 1200 });
if (scene.setRecording) scene.setRecording(true);
window.showcase = {
  scene,
  ready: () => view.dataset.renderer === 'webgl' && view.dataset.profile === 'showcase',
  setup({ weather }) { scene.setWeather(weather || null); },
  find: (base) => scene.worldEntities(base),
  spaceAlt: () => scene.spaceAlt(),
  groundAt: (x, z) => scene.groundAt(x, z),
  pose: (p) => scene.setShowcasePose(p),
  info: () => scene.showcaseInfo(),
  overlays: () => [...view.querySelectorAll('*')].filter((e) => e.tagName !== 'CANVAS' && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && (e.textContent || '').trim()).length,
  frames: () => Number(view.dataset.frames || 0)
};
</script></body></html>`;
}

export function startServer(data) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (b) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (url.pathname === '/showcase/city.html') { res.writeHead(200, { 'Content-Type': MIME['.html'] }); return res.end(cityPage()); }
    if (url.pathname === '/showcase/sandbox.html') { res.writeHead(200, { 'Content-Type': MIME['.html'] }); return res.end(sandboxPage()); }
    if (url.pathname === '/showcase/blank.html') { res.writeHead(200, { 'Content-Type': MIME['.html'] }); return res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'); }
    if (url.pathname === '/showcase/feed') return json(data.feed);
    if (url.pathname === '/showcase/world') { const w = data.worlds[url.searchParams.get('which')]; if (!w) { res.writeHead(404); return res.end(); } return json({ world: w }); }
    if (url.pathname.startsWith('/api/')) return json({ ok: true });
    const file = normalize(join(PUBLIC_DIR, url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

// What a showcase frame must be drawn with; throws if it is anything else
// (a phone's settings, fewer pixels than the output, another tier).
export function checkShowcaseFrame(info, { width, height }) {
  const bad = [];
  if (!info) bad.push('no scene information');
  else {
    if (info.coarse) bad.push('coarse=true (phone settings)');
    if (!(info.renderScale >= 1)) bad.push(`render scale ${info.renderScale}`);
    if (info.tier !== 'showcase' || info.profile !== 'showcase') bad.push(`tier ${info.tier} (profile ${info.profile})`);
    if (info.governor !== 'off') bad.push('the governor is on');
    if (info.probe !== 'off') bad.push('the probe is on');
    if (info.touchPoints) bad.push('touch');
    if (!(info.deviceMemory >= 8)) bad.push(`deviceMemory ${info.deviceMemory}`);
    const [cw, ch] = info.drawingBuffer || info.canvas || [];
    if (cw !== width || ch !== height) bad.push(`drawn at ${cw} x ${ch}, not ${width} x ${height}`);
    if (!info.css || Math.round(info.css[0] * info.dpr) !== width || Math.round(info.css[1] * info.dpr) !== height) bad.push(`viewport ${info.css} at DPR ${info.dpr} is not ${width} x ${height}`);
  }
  if (bad.length) throw new Error(`showcase frame refused: ${bad.join('; ')}`);
  return true;
}

// --- one shot -------------------------------------------------------------------------------------

// A Dublin evening for the City's light: 23:10 tonight (night), 21:05 (rain at dusk).
export function dublinEpoch(hh, mm, now = Date.now()) {
  const d = new Date(now); const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  // Dublin is UTC in winter and UTC+1 in summer (IST): good enough for the light.
  const m = d.getUTCMonth(); const summer = m >= 3 && m <= 9;
  return day + ((hh - (summer ? 1 : 0)) * 60 + mm) * 60000;
}

async function contextFor(ctx, shot, opts) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  return { page, errors };
}

const nearest = (list, p) => list.reduce((b, e) => { const d = Math.hypot(e.scene[0] - p[0], e.scene[2] - p[2]); return !b || d < b.d ? { e, d } : b; }, null);

async function sceneContext(page, shot) {
  if (shot.scene === 'city') {
    const j = await page.evaluate(() => window.showcase.junction());
    const { HERO_BEARING } = await import('../public/kingdom/kingdom-world.js').catch(() => ({ HERO_BEARING: 0.16 }));
    return { heroBearing: HERO_BEARING, junction: j };
  }
  const find = (b) => page.evaluate((x) => window.showcase.find(x), b);
  if (shot.id === 'first-universe') {
    const spaceAlt = await page.evaluate(() => window.showcase.spaceAlt());
    // People in a town square: the person nearest a fountain (or a cafe).
    const squares = [...await find('fountain'), ...await find('cafe'), ...await find('hotel')];
    const sq = squares[0] ? squares[0].scene : [0, 0, 0];
    const blocks = [...await find('house'), ...await find('apartment'), ...await find('hotel'), ...await find('shop'), ...await find('cafe'), ...await find('school'), ...await find('tower'), ...await find('office'), ...await find('cabin'), ...await find('hospital'), ...await find('station')];
    // Someone outdoors (not inside a building or a vehicle), well clear of buildings, nearest the square.
    const outdoors = (await find('person')).filter((p) => p.z < 5 && !p.inside && !blocks.some((b) => Math.hypot(b.scene[0] - p.scene[0], b.scene[2] - p.scene[2]) < 22));
    const who = outdoors.length ? nearest(outdoors, sq) : null;
    const g = who ? who.e.scene : sq;
    // The closing angle with a clear line to them: no building between the camera and the person.
    let endTheta = 1.05; let best = -1;
    for (let k = 0; k < 24; k++) {
      const th = (k / 24) * Math.PI * 2; let clear = Infinity;
      for (let d = 4; d <= 40; d += 3) { const px = g[0] + Math.sin(1.3) * Math.cos(th) * d; const pz = g[2] + Math.sin(1.3) * Math.sin(th) * d; for (const b of blocks) clear = Math.min(clear, Math.hypot(b.scene[0] - px, b.scene[2] - pz) - (b.size || 10) * 0.6); }
      if (clear > best) { best = clear; endTheta = th; }
    }
    return { spaceAlt, endTheta, ground: [g[0], Math.max(0, await page.evaluate(([x, z]) => window.showcase.groundAt(x, z), [g[0], g[2]])), g[2]] };
  }
  if (shot.id === 'benin-warri') {
    // The canoe nearest the walls of Benin (the earthwork ring), and the gate nearest it.
    const canoes = await find('canoe'); const walls = await find('earthwork'); const gates = await find('gate');
    const ring = walls.find((e) => e.id === 'earthwork-benin') || walls[0] || null;
    const n = ring && canoes.length ? nearest(canoes, ring.scene) : null;
    const canoe = n ? n.e.scene : canoes[0] ? canoes[0].scene : null;
    const g = canoe && gates.length ? nearest(gates, canoe) : null;
    return { canoe, walls: g ? g.e.scene : ring ? ring.scene : null };
  }
  if (shot.id === 'deep-space') {
    const planets = await find('planet'); const stars = await find('star');
    const p = planets[0]; const s = stars[0];
    return p ? { planet: p.scene, planetSize: p.size || 80, star: s ? s.scene : null } : {};
  }
  return {};
}

async function renderShot(browser, origin, shot, opts, log) {
  const dir = join(opts.out, shot.id); const framesDir = join(dir, 'frames');
  if (!opts.range) rmSync(dir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  // A desktop viewport (fine pointer, no touch): never the phone settings.
  const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, colorScheme: 'dark', reducedMotion: 'no-preference' });
  await ctx.addInitScript(CLOCK_SCRIPT);
  const { page, errors } = await contextFor(ctx, shot, opts);
  const url = shot.scene === 'city' ? `${origin}/showcase/city.html` : `${origin}/showcase/sandbox.html?world=${encodeURIComponent(shot.world)}`;
  await page.goto(url, { waitUntil: 'load', timeout: 180000 });
  // Ready, or fail at once on a page error (never a ten-minute wait on a broken page).
  for (const t0 = Date.now(); ;) {
    if (errors.length) throw new Error(`${shot.id}: page error: ${errors[0]}`);
    if (await page.evaluate(() => !!(window.showcase && window.showcase.ready() && window.showcase.frames() > 2))) break;
    if (Date.now() - t0 > 600000) throw new Error(`${shot.id}: the scene was not ready in 10 minutes`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const epoch = shot.light === 'night' ? dublinEpoch(23, 10) : shot.light === 'night-rain' ? dublinEpoch(22, 0) : null;
  await page.evaluate((o) => window.showcase.setup(o), { light: shot.light, weather: shot.weather || null, epoch });
  await page.evaluate(() => window.__showcase.lock());
  const ctxS = await sceneContext(page, shot);
  const plan = planShot(shot.id, ctxS);
  // The shot's look (showcase-look.js): light, grade, ripples, mist, hero models.
  if (shot.scene === 'sandbox') {
    const look = { ...(shot.look || {}) };
    if (look.hdri === 'by-hour') { const h = Number((await page.evaluate(() => window.showcase.scene.clock())).hh); Object.assign(look, h >= 5 && h < 9 ? { hdri: 'misty_dawn', mood: 'dawn', hdriIntensity: 0.55 } : h >= 9 && h < 18 ? { hdri: 'kloofendal_48d_partly_cloudy_puresky', mood: 'day', hdriIntensity: 0.6 } : { hdri: null, mood: 'night' }); }
    if (look.mist && ctxS.canoe) look.mist = { centre: ctxS.canoe, radius: 700 };
    await page.evaluate((o) => window.showcase.scene.setShowcaseLook(o), look);
  }
  const total = opts.frames || frameCount(shot.seconds, opts.fps);
  const step = 1000 / opts.fps;
  const pose0 = poseAt(plan, 0);
  // Warm-up (not saved): the first pose held while the sky, weather, water
  // and easing settle (larger steps; the scene caps each at 0.1 s).
  await page.evaluate((p) => window.showcase.pose(p), pose0);
  // Shaders and textures first: frames until the compiled programs and
  // loaded textures stop changing (at least the warm-up, at most 200).
  let stable = 0; let last = '';
  for (let i = 0; i < 200 && (i < opts.warmup || stable < 5); i++) {
    const k = await page.evaluate(() => { window.__showcase.advance(100); const x = window.showcase.info(); return `${x.programs}|${x.textures}`; });
    stable = k === last ? stable + 1 : 0; last = k;
  }
  const overlays = await page.evaluate(() => window.showcase.overlays());
  if (overlays) throw new Error(`${shot.id}: ${overlays} overlay element(s) visible`);
  if (shot.scene === 'city') { const n = await page.evaluate(() => window.showcase.stage()); log(`${shot.id}: ${n} real event(s) staged`); }
  const t0 = Date.now(); const infos = {};
  const [first, lastF] = opts.range ? [opts.range[0] - 1, Math.min(total, opts.range[1]) - 1] : [0, total - 1];
  // A range starts where the whole shot would be at its first frame.
  if (first > 0) await page.evaluate((ms) => window.__showcase.skip(ms), first * step);
  for (let i = first; i <= lastF; i++) {
    const t = total > 1 ? i / (total - 1) : 0;
    await page.evaluate(([p, ms]) => { window.showcase.pose(p); window.__showcase.advance(ms); }, [poseAt(plan, t), step]);
    await page.screenshot({ path: join(framesDir, `${String(i + 1).padStart(5, '0')}.png`), type: 'png', timeout: 600000 });
    // Every frame's settings are checked; the first and lastF are kept for the record.
    const info = await page.evaluate(() => window.showcase.info());
    checkShowcaseFrame(info, opts);
    if (i === first) { infos.first = info; log(`${shot.id}: ${diagLine(info)}`); }
    if (i === lastF) infos.last = info;
    if (i === first || (i + 1) % 15 === 0 || i === lastF) log(`${shot.id}: frame ${i + 1}/${total} (${((Date.now() - t0) / 1000 / (i - first + 1)).toFixed(1)} s a frame)`);
  }
  await ctx.close();
  if (opts.range) return { id: shot.id, title: shot.title, frames: lastF - first + 1, seconds: (lastF - first + 1) / opts.fps, mp4: null, still: null, errors, plan: { move: shot.move }, diagnostics: infos, range: [first + 1, lastF + 1] };
  // The still: two thirds into the shot (the move well under way).
  const stillIdx = Math.min(total, Math.max(1, Math.round(total * 0.66)));
  const still = join(opts.out, `${shot.id}.png`);
  writeFileSync(still, readFileSync(join(framesDir, `${String(stillIdx).padStart(5, '0')}.png`)));
  const mp4 = join(opts.out, `${shot.id}.mp4`);
  encode(framesDir, mp4, opts.fps);
  if (!opts.keepFrames) rmSync(framesDir, { recursive: true, force: true });
  return { id: shot.id, title: shot.title, frames: total, seconds: total / opts.fps, mp4, still, errors, plan: { move: shot.move }, diagnostics: infos };
}

// --- a reel shot (lib/showcase/reel.mjs) -----------------------------------------------------------

// The public part of a real event, for the reel's captions and copy: never a
// caller hash, an IP or anything else that identifies a caller.
export const publicEvent = (e) => (e ? { id: e.id, time: e.time, last: e.last, kind: e.kind, gadget: e.gadget, role: e.role, severity: e.severity, country_code: e.country_code || null, check: e.check, verdict_code: e.verdict_code, reasons: (e.reasons || []).slice(0, 2), count: e.count } : null);
const recordedMs = (iso) => Date.parse(`${iso}:00Z`); // Open-Meteo local time; Dublin is on GMT in November

export async function renderReelShot(browser, origin, shot, opts, data, log) {
  const reel = data.reel || {}; const picks = reel.picks || {}; const wx = reel.weather;
  const need = { probe: picks.probe, signed: picks.signed, director: picks.director && picks.director.length >= 2 ? picks.director : null }[shot.replay];
  if (shot.replay && !need) return { id: shot.id, title: shot.title, skipped: `no real ${shot.replay === 'signed' ? 'signed result' : shot.replay === 'probe' ? 'probe with a country' : 'events for the director'} in the last ${reel.days} days` };
  if (shot.light === 'recorded' && !wx) return { id: shot.id, title: shot.title, skipped: 'no recorded Dublin rain followed by clearing could be read for the window' };
  const dir = join(opts.out, shot.id); const framesDir = join(dir, 'frames');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(framesDir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, colorScheme: 'dark', reducedMotion: 'no-preference' });
  await ctx.addInitScript(CLOCK_SCRIPT);
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto(`${origin}/showcase/city.html`, { waitUntil: 'load', timeout: 180000 });
  for (const t0 = Date.now(); ;) {
    if (errors.length) throw new Error(`${shot.id}: page error: ${errors[0]}`);
    if (await page.evaluate(() => !!(window.showcase && window.showcase.ready() && window.showcase.frames() > 2))) break;
    if (Date.now() - t0 > 600000) throw new Error(`${shot.id}: the scene was not ready in 10 minutes`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const dayNight = shot.light === 'day-to-night' ? [dublinEpoch(15, 50), dublinEpoch(17, 25)] : null;
  const epoch = dayNight ? dayNight[0] : shot.light === 'recorded' ? recordedMs(wx.change.rain.time) : shot.light === 'night' ? dublinEpoch(23, 10) : dublinEpoch(22, 0);
  const weather = shot.light === 'recorded' ? wx.rain : shot.weather;
  await page.evaluate((o) => window.showcase.setup(o), { light: 'live', weather, epoch });
  await page.evaluate(() => window.__showcase.lock());
  const { HERO_BEARING } = await import('../public/kingdom/kingdom-world.js').catch(() => ({ HERO_BEARING: 0.16 }));
  const plan = planReelShot(shot.id, { heroBearing: HERO_BEARING, landmarks: await page.evaluate(() => window.showcase.landmarks()), junction: await page.evaluate(() => window.showcase.junction()) });
  const total = opts.frames || frameCount(shot.seconds, opts.fps);
  const step = 1000 / opts.fps;
  if (!plan.director) await page.evaluate((p) => window.showcase.pose(p), poseAt(plan, 0));
  let stable = 0; let last = '';
  for (let i = 0; i < 200 && (i < opts.warmup || stable < 5); i++) {
    const k = await page.evaluate(() => { window.__showcase.advance(100); const x = window.showcase.info(); return `${x.programs}|${x.textures}`; });
    stable = k === last ? stable + 1 : 0; last = k;
  }
  const overlays = await page.evaluate(() => window.showcase.overlays());
  if (overlays) throw new Error(`${shot.id}: ${overlays} overlay element(s) visible`);
  // The real events this shot replays, and the run-up so the moment lands in the shot.
  const ids = shot.replay === 'director' ? need.map((e) => e.id) : need ? [need.id] : [];
  const played = ids.length ? await page.evaluate((x) => window.showcase.play(x), ids) : [];
  if (ids.length && played.length !== ids.length) throw new Error(`${shot.id}: ${ids.length - played.length} real event(s) not in the page's store`);
  // The run-up: the actors move on without drawing (scene.runActors), then
  // a few frames settle before the first saved one.
  const settle = () => page.evaluate(() => { for (let i = 0; i < 3; i++) window.__showcase.advance(1000 / 30); });
  // A probe: from its origin until it is 2.2 s from the gate (the shot sees it arrive and the Gate Wardens turn it back).
  if (shot.replay === 'probe') { const left = await page.evaluate((id) => { for (let i = 0; i < 600; i++) { const eta = window.showcase.eta(id); if (eta == null || eta <= 2.2) return eta; window.showcase.scene.runActors(0.1); } return window.showcase.eta(id); }, ids[0]); log(`${shot.id}: run-up done, ${left == null ? 'no group' : `${left.toFixed(1)} s to the gate`}`); await settle(); }
  if (shot.replay === 'signed') await page.evaluate(() => { for (let i = 0; i < 4; i++) window.__showcase.advance(100); });
  // Director: on, its first cut at once; 5 s on (clock and actors) the next cut lands 1.5 s into the shot.
  if (plan.director) { await page.evaluate(() => { window.showcase.pose(null); window.showcase.director(true); window.__showcase.advance(100); window.__showcase.skip(5000); window.showcase.scene.runActors(5); }); await settle(); }
  const focuses = new Set(); const t0 = Date.now(); const infos = {}; let cleared = false;
  for (let i = 0; i < total; i++) {
    const t = total > 1 ? i / (total - 1) : 0;
    let pose = plan.director ? null : poseAt(plan, t);
    if (pose && plan.follow === 'event') pose = followPose(pose, await page.evaluate((id) => window.showcase.whereIs(id), ids[0]), t);
    if (pose && plan.follow === 'seal') pose = followPose(pose, await page.evaluate(() => window.showcase.sealAt()), t);
    if (dayNight) await page.evaluate((ms) => window.__showcase.setDate(ms), dayNight[0] + (dayNight[1] - dayNight[0]) * t);
    if (shot.light === 'recorded' && !cleared && t >= 0.42) { cleared = true; await page.evaluate((w) => window.showcase.weatherNow(w), wx.clear); }
    await page.evaluate(([p, ms]) => { if (p) window.showcase.pose(p); window.__showcase.advance(ms); }, [pose, step]);
    await page.screenshot({ path: join(framesDir, `${String(i + 1).padStart(5, '0')}.png`), type: 'png', timeout: 600000 });
    const info = await page.evaluate(() => window.showcase.info());
    checkShowcaseFrame(info, opts);
    if (plan.director) focuses.add(await page.evaluate(() => window.showcase.focusOf()));
    if (i === 0) { infos.first = info; log(`${shot.id}: ${diagLine(info)}`); }
    if (i === total - 1) infos.last = info;
    if (i === 0 || (i + 1) % 15 === 0 || i === total - 1) log(`${shot.id}: frame ${i + 1}/${total} (${((Date.now() - t0) / 1000 / (i + 1)).toFixed(1)} s a frame)`);
  }
  await ctx.close();
  const stillIdx = Math.min(total, Math.max(1, Math.round(total * 0.66)));
  const still = join(opts.out, `${shot.id}.png`);
  writeFileSync(still, readFileSync(join(framesDir, `${String(stillIdx).padStart(5, '0')}.png`)));
  const mp4 = join(opts.out, `${shot.id}.mp4`);
  encode(framesDir, mp4, opts.fps);
  if (!opts.keepFrames) rmSync(framesDir, { recursive: true, force: true });
  const replayed = ids.map((id) => publicEvent((data.feed.events || []).find((e) => e.id === id)));
  return { id: shot.id, title: shot.title, frames: total, seconds: total / opts.fps, mp4, still, errors, plan: { move: shot.move }, diagnostics: infos, replayed, director_cuts: plan.director ? [...focuses].filter(Boolean).length : undefined, light: shot.light, weather: shot.light === 'recorded' ? { ...wx.change, source: wx.source, attribution: wx.attribution } : weather };
}

export const diagLine = (x) => `canvas ${x.canvas.join('x')}, CSS ${x.css.join('x')} at DPR ${x.dpr}, tier ${x.tier} (source ${x.tierSource}), render scale ${x.renderScale}, settings.pixelRatio ${x.settingsPixelRatio}, governor ${x.governor}, probe ${x.probe}, coarse ${x.coarse}, deviceMemory ${x.deviceMemory}, WebGL ${x.webglRenderer}`;

// One still at full resolution: the scene set up as for its shot, the pose
// held while the light, weather and textures settle, then one frame.
async function renderStill(browser, origin, still, opts, log) {
  const dir = join(opts.out, 'stills'); mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, colorScheme: 'dark', reducedMotion: 'no-preference' });
  await ctx.addInitScript(CLOCK_SCRIPT);
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto(still.scene === 'city' ? `${origin}/showcase/city.html` : `${origin}/showcase/sandbox.html?world=${encodeURIComponent(still.world)}`, { waitUntil: 'load', timeout: 180000 });
  for (const t0 = Date.now(); ;) {
    if (errors.length) throw new Error(`${still.id}: page error: ${errors[0]}`);
    if (await page.evaluate(() => !!(window.showcase && window.showcase.ready() && window.showcase.frames() > 2))) break;
    if (Date.now() - t0 > 600000) throw new Error(`${still.id}: not ready in 10 minutes`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const epoch = still.light === 'night' ? dublinEpoch(23, 10) : still.light === 'night-rain' ? dublinEpoch(22, 0) : null;
  await page.evaluate((o) => window.showcase.setup(o), { light: still.light, weather: still.weather || null, epoch });
  await page.evaluate(() => window.__showcase.lock());
  let pose = still.pose ? { fov: 40, focus: still.pose.dist, ...still.pose } : null;
  const shot = still.shot ? shotById(still.shot) : null;
  if (shot) pose = poseAt(planShot(shot.id, await sceneContext(page, shot)), still.t ?? 0.66);
  if (still.entity) {
    const e = (await page.evaluate(() => window.showcase.find(null))).find((x) => x.id === still.entity);
    if (!e) throw new Error(`${still.id}: no entity ${still.entity} in this world`);
    pose = { target: [e.scene[0], e.scene[1] + 2, e.scene[2]], dist: still.dist, theta: still.theta, phi: still.phi, fov: 40, focus: still.dist };
  }
  if (still.scene === 'sandbox') {
    const look = { ...(still.look || (shot && shot.look) || {}) };
    if (look.hdri === 'by-hour') { const h = Number((await page.evaluate(() => window.showcase.scene.clock())).hh); Object.assign(look, h >= 5 && h < 9 ? { hdri: 'misty_dawn', mood: 'dawn', hdriIntensity: 0.55 } : h >= 9 && h < 18 ? { hdri: 'kloofendal_48d_partly_cloudy_puresky', mood: 'day', hdriIntensity: 0.6 } : { hdri: null, mood: 'night' }); }
    if (look.mist) delete look.mist;
    await page.evaluate((o) => window.showcase.scene.setShowcaseLook(o), look);
  }
  await page.evaluate((p) => window.showcase.pose(p), pose);
  let stable = 0; let last = '';
  for (let i = 0; i < 200 && (i < Math.max(20, opts.warmup) || stable < 5); i++) {
    const k = await page.evaluate(() => { window.__showcase.advance(100); const x = window.showcase.info(); return `${x.programs}|${x.textures}`; });
    stable = k === last ? stable + 1 : 0; last = k;
  }
  const overlays = await page.evaluate(() => window.showcase.overlays());
  if (overlays) throw new Error(`${still.id}: ${overlays} overlay element(s) visible`);
  await page.evaluate(() => window.__showcase.advance(1000 / 30));
  const file = join(dir, `${still.id}-${opts.width}x${opts.height}.png`);
  await page.screenshot({ path: file, type: 'png', timeout: 600000 });
  const info = await page.evaluate(() => window.showcase.info());
  checkShowcaseFrame(info, opts);
  log(`still ${still.id}: ${diagLine(info)}`);
  await ctx.close();
  return { id: still.id, title: still.title, file: file.slice(opts.out.length + 1), diagnostics: info, page_errors: errors };
}

export function ffmpegArgs(framesDir, out, fps) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', join(framesDir, '%05d.png'), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
}
function encode(framesDir, out, fps) {
  const r = spawnSync('ffmpeg', ffmpegArgs(framesDir, out, fps), { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${out}`);
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const log = (m) => console.log(`[showcase] ${m}`);
  mkdirSync(opts.out, { recursive: true });
  const { chromium } = await import('playwright');
  const data = await loadData(log, { days: opts.days, epoch: opts.epoch });
  for (const [k, v] of Object.entries(data.sources)) log(`${k}: ${v}`);
  const { server, origin } = await startServer(data);
  let executablePath;
  if (!existsSync(chromium.executablePath()) && existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  // Software 3D (SwiftShader) unless --gpu; either way never the phone path.
  const args = opts.gpu ? ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=default'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  if (opts.stills) {
    const out = []; const q = [...opts.stills];
    const w = async () => { const b = await chromium.launch({ executablePath, args }); try { for (let id = q.shift(); id; id = q.shift()) out.push(await renderStill(b, origin, stillById(id), opts, log)); } finally { await b.close(); } };
    try { await Promise.all(Array.from({ length: Math.min(opts.jobs, opts.stills.length) }, w)); } finally { server.close(); }
    writeFileSync(join(opts.out, `stills-${opts.width}x${opts.height}.json`), JSON.stringify({ generated_at: new Date().toISOString(), profile: 'showcase', stills: out }, null, 2) + '\n');
    return { stills: out };
  }
  const results = new Array(opts.shots.length);
  const queue = opts.shots.map((id, i) => ({ id, i }));
  const worker = async () => {
    const browser = await chromium.launch({ executablePath, args });
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        log(`${job.id}: rendering at ${opts.width} x ${opts.height}, ${opts.fps} fps`);
        const sh = shotById(job.id);
        results[job.i] = sh.reel ? await renderReelShot(browser, origin, sh, opts, data, log) : await renderShot(browser, origin, sh, opts, log);
        if (results[job.i].skipped) log(`${job.id}: left out: ${results[job.i].skipped}`);
      }
    } finally { await browser.close(); }
  };
  try { await Promise.all(Array.from({ length: Math.min(opts.jobs, opts.shots.length) }, worker)); } finally { server.close(); }
  const manifest = { generated_at: new Date().toISOString(), size: `${opts.width}x${opts.height}`, fps: opts.fps, profile: 'showcase', render_scale: 1, encoder: 'H.264 (libx264), -preset veryfast, CRF 18, yuv420p', ...(opts.reel ? { reel: opts.reel, data: data.sources.city, window: data.reel ? { now: data.reel.now, days: data.reel.days } : null, counts: data.reel ? data.reel.counts : null, weather_record: data.reel && data.reel.weather ? { ...data.reel.weather.change, source: data.reel.weather.source, attribution: data.reel.weather.attribution } : null } : {}), shots: results.map((r) => (r.skipped ? { id: r.id, title: r.title, skipped: r.skipped } : { id: r.id, title: r.title, frames: r.frames, seconds: r.seconds, move: r.plan.move, data: r.replayed ? data.sources.city : data.sources[r.id === 'city-night' || r.id === 'city-rain' ? 'city' : r.id === 'deep-space' ? 'space' : r.id], mp4: r.mp4 && r.mp4.slice(opts.out.length + 1), still: r.still && r.still.slice(opts.out.length + 1), range: r.range || null, page_errors: r.errors, diagnostics: r.diagnostics, ...(r.replayed ? { replayed: r.replayed } : {}), ...(r.director_cuts !== undefined ? { director_cuts: r.director_cuts } : {}), ...(r.weather ? { weather: r.weather } : {}) })) };
  writeFileSync(join(opts.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (opts.reel) writeFileSync(join(opts.out, `manifest-${opts.shots.join('+')}.json`), JSON.stringify(manifest, null, 2) + '\n');
  log(`done: ${readdirSync(opts.out).filter((f) => /\.(mp4|png)$/.test(f)).join(', ')}`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[showcase] ${e && e.stack || e}`); process.exit(1); });
}
