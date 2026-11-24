#!/usr/bin/env node
// The 24 November 2026 post, "Inside PG1 City", from the reel's Showcase
// render (scripts/showcase-render.mjs --reel inside-city, one job a shot in
// .github/workflows/showcase.yml). Everything it shows comes from those
// renders and their manifests: the real events each shot replayed, the
// counts of the same 7-day window, and Dublin's recorded weather.
//
//   node scripts/social-inside-city.mjs --from reel-artifacts --out docs/social/2026-11-24
//
// Out:
//   reel-1080x1920.mp4    25-35 s, every shot full-screen vertical with a
//                         2-6 word lower third, crossfades, H.264 veryfast
//                         CRF 18 yuv420p 30 fps, no audio
//   slide-1..7-*.png      the carousel, 1080 x 1350, in the 23 Nov card style
//   story-1080x1920.png   the cover as a Story
//   contact-sheet.jpg     one frame of the reel per shot
//   copy.md               the slide text, a factual note per detail (what it
//                         shows, where it lives in the code), the data window
//
// Words (tests/showcase-reel.test.mjs): "probes and checks", never attack,
// hostile or raiders; no invented numbers (a count is read from the
// manifests, with its dates in copy.md); no provider or model names;
// Project-Gifted1™ with no © line; no outage mentions; never "safe".
// Caller hashes and IPs never appear: the manifests carry none.

import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { REEL_SHOTS, captionFor } from '../lib/showcase/reel.mjs';
import { cardHtml, BASE_CSS, SHIELD, esc, crown, MARK } from './social-build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const POST_DATE = '24 November 2026';
export const REEL_FILE = 'reel-1080x1920.mp4';
export const XFADE_S = 0.5;
export const REEL_TARGET_S = 30;

// --- the words -------------------------------------------------------------------------------------

const DAY = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short' });
const DAY_TIME = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
export const dayRange = (fromIso, toIso) => `${DAY.format(new Date(fromIso))}–${DAY.format(new Date(toIso))}`;
const flagOf = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');
const VERDICT = { UNKNOWN_TOOL: 'unknown tool probe', UNKNOWN_METHOD: 'unknown method probe', INVALID_JSON: 'malformed call', MALFORMED_REQUEST: 'malformed call', SIGNED: 'result signed', SEAL_VERIFIED: 'seal matched to the key' };
const GADGET = { gate_wardens: 'Gate Wardens', seal_forge: 'Seal Forge', truth_lens: 'Truth Lens', phishing_net: 'Phishing Net', rate_shield: 'Rate Shield', repo_scanner: 'Repo Trap Scanner', supply_inspector: 'Supply Inspector', preflight_ward: 'Preflight Array', repair_crews: 'Repair Crews', beacons: 'Watchtower Beacons', passkey_vault: 'Passkey Vault', sanctions_gate: 'Sanctions Gate', allies: 'Allies' };
// One real event as the reel's card shows it: no caller, no IP.
export function eventCardLine(e) {
  if (!e) return '';
  const what = `${GADGET[e.gadget] || e.gadget} · ${e.check}: ${VERDICT[e.verdict_code] || String(e.verdict_code || '').toLowerCase().replace(/_/g, ' ')}`;
  return `${e.country_code ? `${e.country_code} · ` : ''}${what}${e.count > 1 ? ` ×${e.count}` : ''}`;
}

// The carousel: cover, five details, the end. Summaries: 2-3 sentences,
// at most ~40 words, accurate to the code (the note in copy.md says where).
export function slides(m) {
  const c = m.counts || {}; const range = c.window ? dayRange(c.window.from, c.window.to) : '';
  return [
    { id: 'cover', file: 'slide-1-cover.png', shot: 'city-wide', tag: POST_DATE, title: 'Inside PG1 City', line: "A tour of the live 3D city that shows PG1's real activity: probes, checks and signed results. Every event in it is real." },
    { id: 'tower', file: 'slide-2-crown-tower.png', shot: 'crown-tower', tag: 'The crown tower', title: 'The PG1 shield', line: "The tallest tower carries PG1's shield, drawn from the brand file itself. Its beacons follow PG1's real state: one lights when a report lands, and one stays lit for each approval waiting." },
    { id: 'events', file: 'slide-3-real-events.png', shot: 'probe-arrives', tag: Number.isFinite(c.countries) && c.countries > 0 ? `From ${c.countries} countries · ${range}` : 'Real events', title: 'Real probes and checks', line: 'Every arrival is one event PG1 logged: unknown tools and methods, malformed calls, flagged checks. Its origin country shows as a flag and an arc on the mini-globe, and the Gate Wardens turn probes back.', flags: (c.country_codes || []).slice(0, 8) },
    { id: 'signed', file: 'slide-4-signed-results.png', shot: 'seal-forge', fallbackShot: 'city-day', tag: 'Signed results', title: 'Every result signed', line: "When PG1 signs a tool result (Ed25519), the Seal Forge stamps a seal that rises into the tower. Anyone can check a result offline with PG1's public key, or with verify_result." },
    { id: 'traffic-weather', file: 'slide-5-traffic-weather.png', shot: 'street-level', fallbackShot: 'junction-traffic', tag: 'Traffic and weather', title: 'Lanes, rain and real weather', line: "Cars keep to their lanes, queue at red lights and clear on green. The sky follows Dublin's real weather and time of day; in rain the streets turn wet and mirror the lights." },
    { id: 'river-drones', file: 'slide-6-river-drones.png', shot: 'drone-patrol', tag: 'River and drones', title: 'The river and the patrols', line: "Boats pass under the arched bridge, with lamp pools along the promenade. PG1's drones patrol in rings round the tower, one for each live check, with navigation lights at night." },
    { id: 'end', file: 'slide-7-link-in-bio.png', shot: null, tag: '', title: 'Link in bio', line: 'Free checks for AI agents.' }
  ];
}

// Where each detail lives in the code, and what it shows (copy.md).
export const NOTES = Object.freeze({
  tower: 'The crown tower and its shield: public/kingdom/kingdom-world.js (the tower, emblemY) and public/kingdom/kingdom-emblem.js (the shield read from /brand/pg1-shield.svg at runtime). Beacons: lib/defenseState.mjs and the beacons gadget in lib/defenseFeed.mjs (report landed, approvals waiting).',
  events: 'Real events: lib/defenseFeed.mjs reads PG1\'s own logs (agent_telemetry, pg1_defense_events and more), groups them into waves and never carries an IP; the reel replays them read only (scripts/showcase-render.mjs --reel). Flags and arcs: public/kingdom/kingdom-globe.js and kingdom-data.js flagOf. Gate Wardens: the gate_wardens gadget (unknown-tool and unknown-method probes, malformed calls). Countries come from IP geolocation at the network edge and are approximate.',
  signed: 'The Seal Forge: public/kingdom/kingdom-actors.js (stageKingdom, case seal_forge) on signed_result events (lib/defenseFeed.mjs, while signing is on); signing is Ed25519 (lib/signing.mjs) and verify_result checks a result against PG1\'s public key.',
  'traffic-weather': 'Traffic: public/kingdom/kingdom-traffic.js (lanes, signal phases per junction, queues at the stop line). Weather: lib/cityWeather.mjs (Open-Meteo, Dublin, the sky only, never an event) and public/kingdom/kingdom-weather.js and kingdom-wet.js (rain, wet streets). The reel\'s weather shot replays Dublin\'s recorded hourly weather, dated below.',
  'river-drones': 'The river, bridges and promenade lamps: public/kingdom/kingdom-world.js; river life: public/kingdom/kingdom-life.js. Drones: public/kingdom/kingdom-actors.js (sentinels, one per live check from the MCP tool list; lit bodies, nav lights, strobe and night underglow since 23 Nov).'
});

// --- media ------------------------------------------------------------------------------------------

function ff(args) {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}
export const REEL_ENC = Object.freeze(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30']);
const probe = (f) => { const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', f], { encoding: 'utf8' }); const j = JSON.parse(r.stdout || '{}'); return { seconds: Number(j.format && j.format.duration) || 0, width: j.streams && j.streams[0] && j.streams[0].width, height: j.streams && j.streams[0] && j.streams[0].height }; };

// How long each shot plays in the reel: about REEL_TARGET_S in all, with
// crossfades, each within its own clip (after a 0.3 s lead-in).
export function segmentPlan(shots) {
  const n = shots.length; if (!n) return [];
  const each = (REEL_TARGET_S + (n - 1) * XFADE_S) / n;
  return shots.map((s) => ({ id: s.id, seconds: Math.max(2.5, Math.min(each * (s.id === 'director' ? 1.25 : 1), s.clipSeconds - 0.3)) }));
}
export const reelSeconds = (plan) => plan.reduce((t, p) => t + p.seconds, 0) - Math.max(0, plan.length - 1) * XFADE_S;

// All the artifacts' files, wherever they were unzipped.
function walk(dir, out = []) { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); } return out; }
export function readRenders(from) {
  const files = walk(from);
  const manifests = files.filter((f) => /manifest-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(f, 'utf8')));
  if (!manifests.length) throw new Error(`no reel manifests in ${from}`);
  const first = manifests[0];
  for (const m of manifests) if (!m.window || !first.window || m.window.now !== first.window.now) throw new Error('the renders read different data windows (run them as one workflow run)');
  const byId = new Map();
  for (const m of manifests) for (const s of m.shots) byId.set(s.id, s);
  const pick = (name) => files.find((f) => f.endsWith(`/${name}`));
  const shots = REEL_SHOTS.map((def) => { const s = byId.get(def.id); if (!s) return { id: def.id, missing: 'not rendered' }; if (s.skipped) return { id: def.id, missing: s.skipped }; const mp4 = pick(`${def.id}.mp4`); const png = pick(`${def.id}.png`); if (!mp4 || !png) return { id: def.id, missing: 'files not found' }; return { ...s, def, mp4, png, clipSeconds: probe(mp4).seconds }; });
  return { window: first.window, counts: first.counts, weather_record: first.weather_record, data: first.data, shots };
}

function serve() {
  const PUB = join(ROOT, 'public');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/page') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(serve.html || ''); }
    const file = normalize(join(PUB, decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUB) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

// A shot's overlay (transparent 1080 x 1920): the lower third, and for the
// event shots the real event's card (and the mini-globe's arc for a probe).
function overlayHtml(shot, m) {
  const caption = captionFor(shot.def, m.counts);
  const ev = shot.replayed && shot.replayed[0];
  const card = shot.id === 'probe-arrives' || shot.id === 'seal-forge' ? `<div class="ev"><div class="evk">Real event · ${esc(DAY_TIME.format(new Date(ev.last || ev.time)))}</div><div class="evl">${ev.country_code ? `<span class="fl">${flagOf(ev.country_code)}</span>` : ''}${esc(eventCardLine(ev))}</div></div>`
    : shot.id === 'dublin-weather' && shot.weather ? `<div class="ev"><div class="evk">Recorded Dublin weather · not live</div><div class="evl">${esc(DAY_TIME.format(new Date(`${shot.weather.rain.time}:00Z`)))} rain → ${esc(DAY_TIME.format(new Date(`${shot.weather.clear.time}:00Z`)).split(', ').pop())} clearing</div></div>`
    : shot.id === 'director' ? `<div class="ev"><div class="evk">Director mode · real events</div><div class="evl">${(shot.replayed || []).map((e) => esc(GADGET[e.gadget] || e.gadget)).join(' · ')}</div></div>` : '';
  const globe = shot.id === 'probe-arrives' && ev && ev.country_code ? `<canvas id="g" width="300" height="300"></canvas><script type="module">import { createGlobe } from '/kingdom/kingdom-globe.js'; const g = createGlobe(document.getElementById('g'), { flagPx: 30 }); g.draw({ origins: [], arcs: [{ cc: ${JSON.stringify(ev.country_code)}, age: 0.45 }], dpr: 1, t: 1 }); document.body.dataset.ready = '1';</script>` : '<script>document.body.dataset.ready = "1"</script>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS()}
html,body{background:transparent}
.l{position:absolute;left:72px;right:72px;bottom:210px;display:flex;align-items:center;gap:22px;font-size:54px;font-weight:700;letter-spacing:-.01em;color:#fff;text-shadow:0 2px 22px rgba(0,0,0,.7)}.l i{display:block;width:64px;height:64px;flex:none}
.m{position:absolute;right:72px;top:84px;font-size:26px;font-weight:600;color:rgba(255,255,255,.82);text-shadow:0 2px 12px rgba(0,0,0,.6)}
.ev{position:absolute;left:72px;right:72px;bottom:330px;padding:22px 28px;border-radius:24px;background:rgba(7,7,8,.62);border:1px solid rgba(243,198,35,.35)}
.evk{font-size:26px;font-weight:600;color:#f3c623;letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px}.evl{font-size:34px;color:#f4f4f6;line-height:1.25}.fl{font-family:"Noto Color Emoji";margin-right:14px}
#g{position:absolute;right:56px;top:150px;width:300px;height:300px;border-radius:50%}
</style></head><body><div class="m">${MARK}</div>${card}<div class="l">${crown()}<span>${esc(caption)}</span></div>${globe}</body></html>`;
}

const crop1350 = (png, out) => ff(['-i', png, '-vf', 'crop=1080:1350:0:300', out]);
const dataUrl = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;

export async function build({ from, out }) {
  const m = readRenders(from);
  const ready = m.shots.filter((s) => !s.missing);
  if (!ready.length) throw new Error('no shot was rendered');
  const tmp = join(os.tmpdir(), `pg1-inside-city-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true }); mkdirSync(out, { recursive: true });
  const { chromium } = await import('playwright');
  let executablePath; if (!existsSync(chromium.executablePath()) && existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({ executablePath });
  const { server, origin } = await serve();
  const shoot = async (html, w, h, path, transparent = false) => {
    serve.html = html;
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.goto(`${origin}/page`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => !document.body.dataset || document.body.dataset.ready !== undefined || !document.querySelector('script'), null, { timeout: 15000 }).catch(() => {});
    await page.screenshot({ path, omitBackground: transparent });
    await page.close();
  };
  try {
    // The reel.
    const plan = segmentPlan(ready);
    const segs = [];
    for (const [i, s] of ready.entries()) {
      const ov = join(tmp, `ov-${i}.png`); await shoot(overlayHtml(s, m), 1080, 1920, ov, true);
      const seg = join(tmp, `seg-${i}.mp4`);
      ff(['-ss', '0.3', '-t', plan[i].seconds.toFixed(3), '-i', s.mp4, '-loop', '1', '-i', ov, '-filter_complex', '[0:v]scale=1080:1920,setsar=1,fps=30[v];[v][1:v]overlay=0:0:shortest=1,format=yuv420p', '-t', plan[i].seconds.toFixed(3), ...REEL_ENC, '-an', seg]);
      segs.push(seg);
    }
    const reel = join(out, REEL_FILE);
    if (segs.length === 1) ff(['-i', segs[0], ...REEL_ENC, '-an', '-movflags', '+faststart', reel]);
    else {
      let chain = ''; let off = 0; let prev = '[0:v]';
      for (let k = 1; k < segs.length; k++) { off += plan[k - 1].seconds - XFADE_S; const lab = k === segs.length - 1 ? '[vout]' : `[x${k}]`; chain += `${prev}[${k}:v]xfade=transition=fade:duration=${XFADE_S}:offset=${off.toFixed(3)}${lab};`; prev = lab; }
      ff([...segs.flatMap((f) => ['-i', f]), '-filter_complex', chain.replace(/;$/, ''), '-map', '[vout]', ...REEL_ENC, '-an', '-movflags', '+faststart', reel]);
    }
    const info = probe(reel);
    if (info.width !== 1080 || info.height !== 1920) throw new Error(`reel is ${info.width}x${info.height}`);
    // The contact sheet: one frame of the reel per shot (mid-segment).
    let t = 0; const frames = [];
    for (const [i, p] of plan.entries()) { const f = join(tmp, `cs-${i}.png`); ff(['-ss', (t + p.seconds / 2).toFixed(2), '-i', reel, '-frames:v', '1', '-vf', 'scale=270:480', f]); frames.push(f); t += p.seconds - XFADE_S; }
    const cols = Math.min(5, frames.length);
    ff([...frames.flatMap((f) => ['-i', f]), '-filter_complex', `${frames.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${frames.length}:layout=${frames.map((_, i) => `${(i % cols) * 270}_${Math.floor(i / cols) * 480}`).join('|')}:fill=black`, '-frames:v', '1', '-q:v', '3', join(out, 'contact-sheet.jpg')]);
    // The carousel and the Story.
    const sl = slides(m);
    const still = (id) => (ready.find((s) => s.id === id) || {}).png || null;
    const used = {};
    for (const h of sl) {
      const src = h.shot ? still(h.shot) || still(h.fallbackShot) : null;
      used[h.id] = h.shot ? (still(h.shot) ? h.shot : h.fallbackShot) : null;
      let bg = null; if (src) { const c = join(tmp, `bg-${h.id}.png`); crop1350(src, c); bg = dataUrl(c); }
      let html = cardHtml(h, bg);
      if (h.flags && h.flags.length) html = html.replace('<div class="body">', `<div class="body"><div class="flags">${h.flags.map(flagOf).join(' ')}</div>`).replace('</style>', '.flags{font-family:"Noto Color Emoji";font-size:54px;letter-spacing:.08em;margin-bottom:24px}</style>');
      await shoot(html, 1080, 1350, join(out, h.file));
    }
    const coverBg = still('city-wide') || still('crown-tower');
    await shoot(cardHtml(sl[0], coverBg ? dataUrl(coverBg) : null, { hgt: 1920 }), 1080, 1920, join(out, 'story-1080x1920.png'));
    writeFileSync(join(out, 'copy.md'), copyMd(m, sl, plan, used, info));
    return { reel: info, plan, missing: m.shots.filter((s) => s.missing).map((s) => ({ id: s.id, why: s.missing })) };
  } finally { await browser.close(); server.close(); rmSync(tmp, { recursive: true, force: true }); }
}

export function copyMd(m, sl, plan, used, info) {
  const c = m.counts || {}; const w = m.weather_record;
  const shotRows = REEL_SHOTS.map((def) => { const s = m.shots.find((x) => x.id === def.id) || {}; const p = plan.find((x) => x.id === def.id); return `| ${def.title} | ${s.missing ? `left out: ${s.missing}` : `"${captionFor(def, c)}"`} | ${p ? `${p.seconds.toFixed(1)} s` : '-'} | ${(s.replayed || []).map((e) => `${e.kind} ${e.country_code || ''} ${e.check} ${e.verdict_code} (${DAY_TIME.format(new Date(e.last || e.time))})`.replace(/\s+/g, ' ')).join('; ') || (def.id === 'dublin-weather' && w ? `recorded weather ${w.rain.time} → ${w.clear.time}` : 'none (no event staged)')} |`; });
  return `# Inside PG1 City · ${POST_DATE}

Built by \`scripts/social-inside-city.mjs\` from the Showcase render (\`scripts/showcase-render.mjs --reel inside-city\`: desktop profile, showcase quality, render scale 1.0, no UI overlays, no clock or debug labels).

## Data

- **Window:** the defence feed's last ${m.window ? m.window.days : 7} days, read only, up to ${m.window ? m.window.now : ''} (UTC).
- **Events:** ${m.data || 'not recorded'}.
- **Counts shown:** ${Number.isFinite(c.countries) ? `probes and checks from ${c.countries} countries (${(c.country_codes || []).join(', ')}), events dated ${c.from ? DAY_TIME.format(new Date(c.from)) : '-'} to ${c.to ? DAY_TIME.format(new Date(c.to)) : '-'}` : 'none'}. Countries come from IP geolocation and are approximate. No payment figure is shown anywhere.
- **Weather:** ${w ? `Dublin, recorded (${w.source}): ${w.rain.time} ${w.rain.code} (rain) then ${w.clear.time} ${w.clear.code} (clearing), Europe/Dublin time. ${w.attribution}. Not live.` : 'no recorded rain-then-clearing could be read; the weather shot is left out.'}
- **Privacy:** no caller hash, IP or anything identifying a caller is in the renders, the reel or this file.

## Reel (\`${REEL_FILE}\`)

${info.seconds.toFixed(1)} s, ${info.width} x ${info.height}, H.264 (libx264 -preset veryfast -crf 18), yuv420p, 30 fps, ${XFADE_S} s crossfades, no audio.

| Shot | Lower third | In the reel | Real data replayed |
|---|---|---|---|
${shotRows.join('\n')}

## Carousel (1080 x 1350) and Story

${sl.map((h, i) => `### ${i + 1}. ${h.title}${h.tag ? ` · ${h.tag}` : ''}\n\n${h.line}${used[h.id] ? `\n\n_Image: the "${used[h.id]}" shot._` : ''}${NOTES[h.id] ? `\n\n**Note:** ${NOTES[h.id]}` : ''}`).join('\n\n')}

Story: \`story-1080x1920.png\` (the cover at 1080 x 1920). Footer on every slide: ${MARK}.
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2); const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  build({ from: resolve(get('--from', 'reel-artifacts')), out: resolve(get('--out', join(ROOT, 'docs', 'social', '2026-11-24'))) })
    .then((r) => console.log(`[social] reel ${r.reel.seconds.toFixed(1)} s; left out: ${r.missing.map((x) => `${x.id} (${x.why})`).join(', ') || 'none'}`), (e) => { console.error(`[social] ${e && e.stack || e}`); process.exit(1); });
}
