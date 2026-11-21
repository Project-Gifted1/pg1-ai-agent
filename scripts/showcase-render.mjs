#!/usr/bin/env node
// PG1 Showcase render: art-directed shots of PG1 City and PG1 Universe,
// rendered offline (not in real time) in headless Chromium and encoded with
// ffmpeg. Started by hand or by .github/workflows/showcase.yml.
//
//   node scripts/showcase-render.mjs [--shots city-night,city-rain,...]
//        [--size 1080x1920] [--out showcase-out] [--frames N] [--warmup 40]
//        [--gpu] [--keep-frames] [--jobs N]
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
import { SHOTS, shotById, planShot, poseAt, frameCount, SHOWCASE_FPS } from '../lib/showcase/shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8', '.bin': 'application/octet-stream', '.ktx2': 'application/octet-stream' };

export function parseArgs(argv) {
  const o = { shots: SHOTS.map((s) => s.id), width: 1080, height: 1920, out: join(ROOT, 'showcase-out'), frames: null, warmup: 40, gpu: false, keepFrames: false, fps: SHOWCASE_FPS, jobs: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => argv[++i];
    if (a === '--shots') o.shots = v().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--size') { const m = /^(\d+)x(\d+)$/.exec(v()); if (!m) throw new Error('--size WxH'); o.width = Number(m[1]); o.height = Number(m[2]); }
    else if (a === '--out') o.out = resolve(v());
    else if (a === '--frames') o.frames = Math.max(1, Number(v()) | 0);
    else if (a === '--warmup') o.warmup = Math.max(0, Number(v()) | 0);
    else if (a === '--gpu') o.gpu = true;
    else if (a === '--jobs') o.jobs = Math.max(1, Number(v()) | 0);
    else if (a === '--keep-frames') o.keepFrames = true;
    else throw new Error(`unknown option ${a}`);
  }
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

export async function loadData(log) {
  const env = process.env;
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
      feed = await buildDefenseFeed({ supUrl, supKey, env: {}, now: Date.now() });
      try { feed.state = await buildDefenseState({ env }); } catch (e) { feed.state = null; }
      const all = Array.isArray(feed.events) ? feed.events.length : 0;
      feed.events = (feed.events || []).filter((e) => !isPaymentEvent(e));
      sources.city = `real PG1 events, last 24 h (${feed.events.length} shown of ${all}; payments left out)`;
    } catch (e) { log(`feed not readable: ${e.message}`); }
  }
  return { worlds, feed, sources };
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
  window.__showcase = { advance, lock() { clearInterval(free); free = null; }, setDate(ms) { base = ms - vt; }, now: () => vt, pending: () => q.length, realDate };
})();`;

const PAGE_CSS = `html,body{margin:0;height:100%;background:#000;overflow:hidden}#view{position:fixed;inset:0}#view canvas{display:block;width:100%!important;height:100%!important}
.sandbox-hud{position:absolute;inset:0;pointer-events:none}.sandbox-hud>:not(.sandbox-clock){display:none!important}
.sandbox-clock{position:absolute;left:3vmin;bottom:3vmin;font:600 max(14px,1.6vmin)/1 Inter,system-ui,sans-serif;color:#fff;background:rgba(10,10,11,.55);padding:.55em .8em;border-radius:.5em;letter-spacing:.01em}
#view>*:not(canvas):not(.sandbox-hud){display:none!important}`;

function cityPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>PG1 City · Showcase</title><style>${PAGE_CSS}</style></head><body><div id="view"></div>
<script type="module">
import { createKingdomScene } from '/kingdom/kingdom-scene.js';
import { createEventStore } from '/kingdom/kingdom-data.js';
const view = document.getElementById('view');
const feed = await (await fetch('/showcase/feed')).json();
const scene = await createKingdomScene(view, { coarse: false, showcase: true, tier: 'cinematic' });
const store = createEventStore();
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
  },
  // The last few real events of the day (never a payment), as the City replays them on open.
  stage() { const list = store.list().filter((e) => !(e.gadget === 'toll_bridge' || /pay|settle|402/i.test(String(e.kind) + String(e.verdict)))).slice(0, 6).reverse(); if (list.length) scene.ingest(list.map((e) => ({ event: e, delta: e.count }))); return list.length; },
  junction: () => (scene.busiestJunction ? scene.busiestJunction() : null),
  pose: (p) => scene.setShowcasePose(p),
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
    const squares = [...await find('fountain'), ...await find('stadium'), ...await find('hotel')];
    const g = squares[0] ? squares[0].scene : [0, 0, 0];
    return { spaceAlt, ground: [g[0], Math.max(0, await page.evaluate(([x, z]) => window.showcase.groundAt(x, z), [g[0], g[2]])), g[2]] };
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
  rmSync(dir, { recursive: true, force: true }); mkdirSync(framesDir, { recursive: true });
  // A desktop viewport (fine pointer, no touch): never the phone settings.
  const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, colorScheme: 'dark', reducedMotion: 'no-preference' });
  await ctx.addInitScript(CLOCK_SCRIPT);
  const { page, errors } = await contextFor(ctx, shot, opts);
  const url = shot.scene === 'city' ? `${origin}/showcase/city.html` : `${origin}/showcase/sandbox.html?world=${encodeURIComponent(shot.world)}`;
  await page.goto(url, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.showcase && window.showcase.ready() && window.showcase.frames() > 2, null, { timeout: 600000, polling: 250 });
  const epoch = shot.light === 'night' ? dublinEpoch(23, 10) : shot.light === 'night-rain' ? dublinEpoch(22, 0) : null;
  await page.evaluate((o) => window.showcase.setup(o), { light: shot.light, weather: shot.weather || null, epoch });
  await page.evaluate(() => window.__showcase.lock());
  const plan = planShot(shot.id, await sceneContext(page, shot));
  const total = opts.frames || frameCount(shot.seconds, opts.fps);
  const step = 1000 / opts.fps;
  const pose0 = poseAt(plan, 0);
  // Warm-up (not saved): the first pose held while the sky, weather, water
  // and easing settle (larger steps; the scene caps each at 0.1 s).
  await page.evaluate((p) => window.showcase.pose(p), pose0);
  for (let i = 0; i < opts.warmup; i++) await page.evaluate(() => window.__showcase.advance(100));
  if (shot.scene === 'city') { const n = await page.evaluate(() => window.showcase.stage()); log(`${shot.id}: ${n} real event(s) staged`); }
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const t = total > 1 ? i / (total - 1) : 0;
    await page.evaluate(([p, ms]) => { window.showcase.pose(p); window.__showcase.advance(ms); }, [poseAt(plan, t), step]);
    await page.screenshot({ path: join(framesDir, `${String(i + 1).padStart(5, '0')}.png`), type: 'png', timeout: 600000 });
    if (i === 0 || (i + 1) % 15 === 0 || i === total - 1) log(`${shot.id}: frame ${i + 1}/${total} (${((Date.now() - t0) / 1000 / (i + 1)).toFixed(1)} s a frame)`);
  }
  await ctx.close();
  // The still: two thirds into the shot (the move well under way).
  const stillIdx = Math.min(total, Math.max(1, Math.round(total * 0.66)));
  const still = join(opts.out, `${shot.id}.png`);
  writeFileSync(still, readFileSync(join(framesDir, `${String(stillIdx).padStart(5, '0')}.png`)));
  const mp4 = join(opts.out, `${shot.id}.mp4`);
  encode(framesDir, mp4, opts.fps);
  if (!opts.keepFrames) rmSync(framesDir, { recursive: true, force: true });
  return { id: shot.id, title: shot.title, frames: total, seconds: total / opts.fps, mp4, still, errors, plan: { move: shot.move } };
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
  const data = await loadData(log);
  for (const [k, v] of Object.entries(data.sources)) log(`${k}: ${v}`);
  const { server, origin } = await startServer(data);
  let executablePath;
  if (!existsSync(chromium.executablePath()) && existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  const args = opts.gpu ? ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const results = new Array(opts.shots.length);
  const queue = opts.shots.map((id, i) => ({ id, i }));
  const worker = async () => {
    const browser = await chromium.launch({ executablePath, args });
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        log(`${job.id}: rendering at ${opts.width} x ${opts.height}, ${opts.fps} fps`);
        results[job.i] = await renderShot(browser, origin, shotById(job.id), opts, log);
      }
    } finally { await browser.close(); }
  };
  try { await Promise.all(Array.from({ length: Math.min(opts.jobs, opts.shots.length) }, worker)); } finally { server.close(); }
  const manifest = { generated_at: new Date().toISOString(), size: `${opts.width}x${opts.height}`, fps: opts.fps, profile: 'showcase', encoder: 'H.264 (libx264), -preset veryfast, CRF 18, yuv420p', shots: results.map((r) => ({ id: r.id, title: r.title, frames: r.frames, seconds: r.seconds, move: r.plan.move, data: data.sources[r.id === 'city-night' || r.id === 'city-rain' ? 'city' : r.id === 'deep-space' ? 'space' : r.id], mp4: r.mp4.slice(opts.out.length + 1), still: r.still.slice(opts.out.length + 1), page_errors: r.errors })) };
  writeFileSync(join(opts.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`done: ${readdirSync(opts.out).filter((f) => /\.(mp4|png)$/.test(f)).join(', ')}`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[showcase] ${e && e.stack || e}`); process.exit(1); });
}
