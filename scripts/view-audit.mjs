// Audit both 3D views in headless Chromium at a budget-Android phone viewport
// (360 x 800 CSS px, touch): screenshots at every quality tier and the
// numbers each tier draws (frame time, fps, draw calls, triangles), plus
// any console error. Software WebGL (SwiftShader): the frame times are this
// machine's CPU, not a phone's GPU; the draw calls and triangles are exact.
//
//   node scripts/view-audit.mjs <tag> [sandbox|city|all]
// writes docs/screenshots/audit/<tag>-*.png and docs/screenshots/audit/<tag>.json

import http from 'node:http';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { routeReplyFont } from '../tests/helpers/replyFont.mjs';
import { createSandboxStore, __resetSandboxMemory } from '../lib/sandbox/store.mjs';
import { createWorld, stepWorldFor, pg1Principal } from '../lib/sandbox/worlds.mjs';
import sandboxViewer, { __setSandboxViewerStore } from '../api/sandbox.mjs';
import { startCommandCentreServer, openPhonePage } from '../tests/helpers/commandCentre.mjs';
import { fixtureFeed } from '../tests/helpers/kingdomFixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const OUT = join(ROOT, 'docs', 'screenshots', 'audit');
const TAG = process.argv[2] || 'before';
const WHICH = process.argv[3] || 'all';
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const VIEWPORT = { width: 360, height: 800 };
const A07_UA = 'Mozilla/5.0 (Linux; Android 15; SM-A075F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8' };
mkdirSync(OUT, { recursive: true });
const report = { tag: TAG, at: new Date().toISOString(), renderer: 'SwiftShader (software)', viewport: VIEWPORT, sandbox: {}, city: {}, errors: [] };

function sandboxServer(store) {
  process.env.USER_API_KEY = 'operator'; process.env.USER_API_PASS = 'passkey';
  __setSandboxViewerStore(() => store);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'); let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed = null; try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      const json = (s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (url.pathname === '/api/sandbox') {
        const out = { statusCode: 200, body: null, setHeader() {}, getHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } };
        await sandboxViewer({ method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' }, body: parsed }, out);
        return json(out.statusCode, out.body);
      }
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/chat' && parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: true });
        if (url.pathname === '/api/defense-feed') return json(200, { ok: true, events: [], today: {}, threat: { level: 'calm' }, gadgets: [] });
        if (url.pathname === '/api/threads') return json(200, { threads: [] });
        if (url.pathname === '/api/handoffs') return json(200, { handoffs: [] });
        if (url.pathname === '/api/watches') return json(200, { ok: true, reports: [] });
        if (url.pathname === '/api/errors') return json(200, { errors: [], ok: true });
        return json(200, { ok: true });
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = normalize(join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      const data = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }); res.end(data);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}



// Every WebGL draw call, per animation frame (all render passes counted).
const GL_COUNT = () => {
  const st = window.__gl = { calls: 0, perFrame: [] };
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    for (const fn of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
      const orig = C.prototype[fn]; if (!orig) continue;
      C.prototype[fn] = function (...a) { st.calls++; return orig.apply(this, a); };
    }
  }
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { const before = st.calls; cb(t); const n = st.calls - before; if (n > 0) { st.perFrame.push(n); if (st.perFrame.length > 30) st.perFrame.shift(); } });
};
const glCalls = (page) => page.evaluate(() => { const p = (window.__gl && window.__gl.perFrame) || []; return p.length ? Math.round(p.slice().sort((a, b) => a - b)[Math.floor(p.length / 2)]) : null; });

async function measure(page, viewSel, n = 12) {
  // frame-to-frame times from the view's own frame counter
  const t = await page.evaluate(async ([sel, k]) => {
    const el = document.querySelector(sel);
    const f = () => Number(el.dataset.frames || 0);
    const f0 = f(); const t0 = performance.now();
    await new Promise((r) => { const tick = () => (f() >= f0 + k || performance.now() - t0 > 120000 ? r() : setTimeout(tick, 50)); tick(); });
    const dt = performance.now() - t0; const df = f() - f0;
    return { msPerFrame: df ? dt / df : null, fps: df ? (df * 1000) / dt : 0 };
  }, [viewSel, n]);
  return { msPerFrame: t.msPerFrame && Math.round(t.msPerFrame), fps: Math.round(t.fps * 10) / 10, glDrawCalls: await glCalls(page) };
}

async function sandboxPage(browser, origin, tier) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', userAgent: A07_UA });
  await routeReplyFont(context);
  await context.addInitScript(GL_COUNT);
  await context.addInitScript((t) => { try { localStorage.setItem('pg1_theme', 'dark'); localStorage.setItem('pg1_sandbox_quality', t); } catch (e) {} }, tier);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (res) => { if (res.status() >= 400) errors.push(`http ${res.status()}: ${new URL(res.url()).pathname}`); });
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator'); await page.fill('#auth-pass', 'passkey'); await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  return { page, errors, context };
}
const sFrames = (page) => page.evaluate(() => Number(document.getElementById('sandbox-view').dataset.frames || 0));
async function sWait(page, n) { const f0 = await sFrames(page); await page.waitForFunction(([a, k]) => Number(document.getElementById('sandbox-view').dataset.frames || 0) >= a + k, [f0, n], { timeout: 600000 }); }
async function sStats(page) {
  return page.evaluate(() => {
    const s = window.sandboxScene;
    if (s && typeof s.stats === 'function') return s.stats();
    return {};
  });
}
async function sShot(page, name) {
  await page.evaluate(() => document.getElementById('sandbox-view').scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(OUT, `${TAG}-sandbox-${name}.png`), clip: await page.locator('#sandbox-view').boundingBox(), timeout: 300000 });
}

async function auditSandbox(browser) {
  __resetSandboxMemory();
  const store = createSandboxStore(); const pg1 = pg1Principal();
  const uni = await createWorld(store, pg1, { name: 'Pg1-Universe', template: 'universe' });
  await stepWorldFor(store, pg1, { world_id: uni.id, steps: 40 });
  const uniNight = await createWorld(store, pg1, { name: 'Pg1-Universe night', template: 'universe' });
  for (let i = 0; i < 2; i++) await stepWorldFor(store, pg1, { world_id: uniNight.id, steps: 60 });
  await stepWorldFor(store, pg1, { world_id: uniNight.id, steps: 40 });
  const bw = await createWorld(store, pg1, { name: 'Benin–Warri c. 1610', template: 'benin-warri' });
  await stepWorldFor(store, pg1, { world_id: bw.id, steps: 30 });
  const ticks = {};
  for (const w of [uni, uniNight, bw]) ticks[w.id] = (await store.getWorld(w.id)).tick;
  const { server, origin } = await sandboxServer(store);
  try {
    // Auto: no tier kept, the A07 profile; which tier the probe picks (after only: main has no probe).
    if (TAG !== 'before') {
      const { page, errors, context } = await sandboxPage(browser, origin, 'auto');
      await page.evaluate((w) => openSandboxScreen(w), uni.id);
      await page.waitForFunction(() => !!document.getElementById('sandbox-view').dataset.probePick, null, { timeout: 600000 }).catch(() => {});
      await sWait(page, 10);
      report.sandbox.auto = { ...(await page.evaluate(() => ({ ...document.getElementById('sandbox-view').dataset }))), errors };
      report.sandbox.auto = Object.fromEntries(Object.entries(report.sandbox.auto).filter(([k]) => ['tier', 'tierSource', 'probeMs', 'probePick', 'renderScale', 'errors'].includes(k)));
      console.log('sandbox auto', JSON.stringify(report.sandbox.auto));
      await context.close();
    }
    for (const tier of ['low', 'medium', 'high']) {
      const r = report.sandbox[tier] = {};
      const { page, errors, context } = await sandboxPage(browser, origin, tier);
      const open = async (id) => { await page.evaluate((w) => openSandboxScreen(w), id); await page.waitForFunction((t) => new RegExp(`^Step ${t} · `).test(document.getElementById('sandbox-tick').textContent), ticks[id], { timeout: 120000 }); await sWait(page, 4); };
      await open(uni.id);
      if (await page.locator('#sandbox-view').getAttribute('data-renderer') !== 'webgl') { r.skipped = 'no webgl'; await context.close(); continue; }
      r.tierShown = await page.locator('#sandbox-view').getAttribute('data-tier');
      // overview (day)
      await page.evaluate(() => sandboxScene.setView('overview')); await sWait(page, 30);
      r.overview = { ...(await measure(page, '#sandbox-view')), ...(await sStats(page)) }; await sShot(page, `${tier}-overview-day`);
      // space
      await page.evaluate(() => sandboxScene.setView('space')); await sWait(page, 40);
      r.space = { ...(await measure(page, '#sandbox-view')), ...(await sStats(page)) }; await sShot(page, `${tier}-space`);
      // planet approach: follow the nearest planet with a surface
      await page.evaluate(() => { const p = sandboxState.world.entities.find((x) => x.kind === 'planet' && /earth|terra|blue|green/i.test(JSON.stringify(x.properties))) || sandboxState.world.entities.find((x) => x.kind === 'planet'); sandboxScene.select(p.id); });
      await sWait(page, 40);
      r.planet = { ...(await measure(page, '#sandbox-view')), ...(await sStats(page)) }; await sShot(page, `${tier}-planet-approach`);
      // space -> ground: mid-transition frame
      await page.evaluate(() => { sandboxScene.select(null); sandboxScene.setView('overview'); }); await sWait(page, 6); await sShot(page, `${tier}-space-to-ground`); await sWait(page, 40);
      // ground level, by a lake
      await page.evaluate(() => { const lake = sandboxState.world.entities.find((x) => x.kind === 'lake'); const rr = Number(lake.properties.radius) || 100; sandboxScene.exploreAt(lake.position.x - rr - 16, lake.position.y - 6, 8); });
      await sWait(page, 25);
      r.ground = { ...(await measure(page, '#sandbox-view')), ...(await sStats(page)) }; await sShot(page, `${tier}-ground-day`);
      // following a person (walk cycle)
      await page.evaluate(() => { const e = sandboxState.world.entities.find((x) => x.kind === 'person' && !(x.properties && x.properties.inside)); if (e) sandboxScene.select(e.id); });
      await sWait(page, 30); await sShot(page, `${tier}-person`);
      // night
      await open(uniNight.id);
      await page.evaluate(() => { const e = sandboxState.world.entities.find((x) => x.kind === 'tower') || sandboxState.world.entities.find((x) => x.kind === 'house'); sandboxScene.select(e.id); sandboxScene.setView('free'); });
      await sWait(page, 30);
      r.night = { ...(await measure(page, '#sandbox-view')), ...(await sStats(page)) }; await sShot(page, `${tier}-ground-night`);
      // Benin–Warri
      await open(bw.id);
      await page.evaluate(() => sandboxScene.setView('overview')); await sWait(page, 30);
      r.beninOverview = { ...(await measure(page, '#sandbox-view')), ...(await sStats(page)) }; await sShot(page, `${tier}-benin-overview`);
      await page.evaluate(() => { const e = sandboxState.world.entities.find((x) => x.id === 'market-benin-1') || sandboxState.world.entities.find((x) => x.kind === 'market'); sandboxScene.select(e.id); });
      await sWait(page, 30); await sShot(page, `${tier}-benin-market`);
      await page.evaluate(() => { const e = sandboxState.world.entities.find((x) => x.kind === 'person'); sandboxScene.select(e.id); });
      await sWait(page, 30); await sShot(page, `${tier}-benin-person`);
      await page.evaluate(() => { const e = sandboxState.world.entities.find((x) => /canoe|boat/.test(x.kind)); if (e) sandboxScene.select(e.id); });
      await sWait(page, 30); await sShot(page, `${tier}-benin-canoe`);
      r.ui = await page.evaluate(() => ({ overflowX: document.documentElement.scrollWidth > window.innerWidth }));
      await page.screenshot({ path: join(OUT, `${TAG}-sandbox-${tier}-screen.png`), timeout: 300000 });
      r.errors = errors;
      report.errors.push(...errors.map((e) => `sandbox ${tier}: ${e}`));
      await context.close();
      console.log('sandbox', tier, JSON.stringify(r));
    }
  } finally { await new Promise((r) => server.close(r)); __setSandboxViewerStore(null); }
}

async function auditCity(browser) {
  const control = {}; const feed = fixtureFeed(control);
  const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: async (url) => { const f = await feed(url); if (!url.searchParams.get('since')) f.weather = { state: 'partly_cloudy', source: 'open-meteo', cloud: 0.4, wind: 0.2 }; return f; } });
  try {
    const TIERS = await (async () => { const m = await import('../public/kingdom/kingdom-scene.js'); return m.KINGDOM_TIERS.filter((t) => t !== 'cinematic'); })();
    // The city's light follows real Dublin time: shift the page clock to 13:00 and 22:30 (UTC = Dublin time in winter).
    const shiftTo = (h, m) => { const d = new Date(); d.setUTCHours(h, m, 0, 0); return d.getTime() - Date.now(); };
    for (const tier of (TAG !== 'before' ? ['auto'] : []).concat(TIERS)) {
      const r = report.city[tier] = {};
      for (const [when, offset] of [['day', shiftTo(13, 0)], ['night', shiftTo(22, 30)]]) {
        const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', userAgent: A07_UA });
        await routeReplyFont(ctx);
        await ctx.addInitScript(GL_COUNT);
        await ctx.addInitScript(([off, t]) => { const n = Date.now; Date.now = () => n() + off; const D = Date; window.Date = class extends D { constructor(...a) { if (a.length) super(...a); else super(n() + off); } static now() { return n() + off; } }; try { localStorage.setItem('pg1_theme', 'dark'); if (t !== 'auto') localStorage.setItem('pg1_kingdom_quality', t); } catch (e) {} }, [offset, tier]);
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (res) => { if (res.status() >= 400) errors.push(`http ${res.status()}: ${new URL(res.url()).pathname}`); });
        await page.goto(origin + '/', { waitUntil: 'load' });
        await page.fill('#auth-user', 'operator').catch(() => {}); await page.fill('#auth-pass', 'passkey').catch(() => {}); await page.press('#auth-pass', 'Enter').catch(() => {});
        await page.locator('#kingdom-mini').waitFor({ state: 'visible', timeout: 60000 });
        const t0 = Date.now();
        await page.locator('#kingdom-mini').click();
        await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === 'webgl' && !!window.kingdomUi.scene() && Number(document.getElementById('kingdom-view').dataset.frames || 0) > 0, null, { timeout: 300000 });
        const firstFrameMs = Date.now() - t0;
        await page.waitForFunction(() => { const c = document.getElementById('kingdom-globe-intro'); return c.classList.contains('is-done') && c.hidden; }, null, { timeout: 120000 }).catch(() => {});
        const shot = async (name) => { await page.evaluate(() => window.kingdomUi.scene().pause(true)); await page.screenshot({ path: join(OUT, `${TAG}-city-${tier}-${name}.png`), timeout: 300000 }); await page.evaluate(() => window.kingdomUi.scene().pause(false)); };
        const wait = async (n) => { const f0 = await page.evaluate(() => Number(document.getElementById('kingdom-view').dataset.frames || 0)); await page.waitForFunction((k) => Number(document.getElementById('kingdom-view').dataset.frames || 0) >= k, f0 + n, { timeout: 300000 }); };
        await wait(8);
        if (tier === 'auto') await page.waitForFunction(() => !!document.getElementById('kingdom-view').dataset.probePick || document.getElementById('kingdom-view').dataset.tierSource !== 'probe', null, { timeout: 300000 }).catch(() => {});
        r[when] = { tierSource: await page.evaluate(() => document.getElementById('kingdom-view').dataset.tierSource), probeMs: await page.evaluate(() => document.getElementById('kingdom-view').dataset.probeMs || null), probePick: await page.evaluate(() => document.getElementById('kingdom-view').dataset.probePick || null), firstFrameMs, tierShown: await page.evaluate(() => document.getElementById('kingdom-view').dataset.tier), ...(await measure(page, '#kingdom-view', 10)), ...(await page.evaluate(() => { const s = window.kingdomUi.scene().stats(); return { calls: s.calls, triangles: s.triangles, gpuMemoryMB: s.gpuMemoryMB, vehicles: s.life.vehicles, people: s.life.people, overlaps: s.life.overlaps }; })) };
        await shot(when);
        if (when === 'day') {
          await page.evaluate(() => window.kingdomUi.scene().debugView({ target: [0, 2, 40], dist: 60, phi: 1.3 })); await wait(6); await shot('street');
          await page.screenshot({ path: join(OUT, `${TAG}-city-${tier}-screen.png`), timeout: 300000 });
        }
        r[when].overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        r[when].errors = errors;
        report.errors.push(...errors.map((e) => `city ${tier} ${when}: ${e}`));
        await ctx.close();
      }
      console.log('city', tier, JSON.stringify(r));
    }
  } finally { await new Promise((r) => server.close(r)); }
}

const executablePath = existsSync(chromium.executablePath()) ? undefined : '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath, args: GL });
try {
  if (WHICH === 'all' || WHICH === 'sandbox') await auditSandbox(browser);
  if (WHICH === 'all' || WHICH === 'city') await auditCity(browser);
} finally { await browser.close(); }
writeFileSync(join(OUT, `${TAG}-${WHICH}.json`), JSON.stringify(report, null, 2));
console.log('done', join(OUT, `${TAG}-${WHICH}.json`));
