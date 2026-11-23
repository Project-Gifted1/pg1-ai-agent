#!/usr/bin/env node
// PG1 social visuals from a Showcase render (scripts/showcase-render.mjs):
// a nine-slide 1080 x 1350 carousel (and slide 1 at 1080 x 1920 for a Story), a 1200 x 675 cover, and highlights.mp4
// (1080 x 1920, about 27 s: the showcase shots cut together with clean
// text cards between them). No music track: music is added in the app.
//
//   node scripts/social-build.mjs --from showcase-out [--stills showcase-out/stills] --out docs/social/2026-11 [--no-video]
//
// --no-video: the slides, the Story and the cover only (highlights.mp4 is
// left as it is; it needs the shot clips from scripts/showcase-render.mjs).
//
// Stills needed (scripts/showcase-render.mjs --stills ...): every slide's at
// 1080x1350, the cover's at 1080x1920 (the Story) and 1920x1080 (cover-1200x675).
//
// Words: feature names and version numbers only (no figures of any other
// kind); white label (PG1, PG1 Studio, PG1 Sound); the mark is
// Project-Gifted1™. tests/social-copy.test.mjs checks the slides against
// those rules.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MARK = 'Project-Gifted1™';

// The carousel: eight 1080 x 1350 slides, each over a full-resolution
// showcase still (scripts/showcase-render.mjs --stills, at 1080 x 1350),
// and slide 1 again at 1080 x 1920 for a Story. still: the still's id.
export const SLIDES = Object.freeze([
  { id: 'cover', file: 'slide-1-cover.png', still: 'cover', tag: '23 November 2026', title: 'What PG1 shipped', line: 'PG1 City, PG1 Universe, and new free checks for agents.' },
  // The recap: every feature in one checklist (no still: the dark card with the shield).
  { id: 'recap', file: 'slide-2-whats-new.png', still: null, tag: '', title: "What's new", line: '', items: [
    { name: 'check_repo_trap', text: 'Checks a project before your agent runs it.' },
    { name: 'check_agent_message', text: 'Flags hidden instructions in agent messages.' },
    { name: 'A2A 1.0', text: 'Other AI agents can send PG1 tasks.' },
    { name: 'PG1 City', text: "PG1's real activity, live in a 3D city." },
    { name: 'PG1 Universe', text: 'Simulated worlds, including Benin–Warri c. 1610.' },
    { name: 'Passkey + signed results', text: 'Passkey sign-in; every tool result signed.' }
  ] },
  { id: 'check-repo-trap', file: 'slide-3-check-repo-trap.png', still: 'tower-cluster', tag: 'New free check · v1.22.0', title: 'check_repo_trap', line: "Checks a downloaded project's files before your coding agent runs anything from it: look-alike standard-library files, startup hooks, install scripts, executables and encoded payloads. For anyone letting an agent work on code they didn't write." },
  { id: 'check-agent-message', file: 'slide-4-check-agent-message.png', still: 'promenade', tag: 'Free check · v1.21', title: 'check_agent_message', line: 'Reads agent messages and skill.md files before your agent does. Flags hidden instructions and wallet or payment redirects aimed at the reader, and skips lines that only name, quote or negate a risk. Rule-based, no AI model.' },
  { id: 'a2a-1-0', file: 'slide-5-a2a-1-0.png', still: 'city-strip', tag: 'Standards', title: 'A2A 1.0', line: 'PG1 speaks A2A 1.0 and is tested with the official A2A SDK, so other AI agents can send it tasks using the standard protocol. Plain messages get a free reply.' },
  { id: 'pg1-city', file: 'slide-6-pg1-city.png', still: 'aerial-rain', tag: 'Live 3D', title: 'PG1 City', line: "A living 3D city that shows PG1's real activity as it happens: probes, checks and signed results, with the origin countries and real Dublin weather. Every event is real, never simulated." },
  { id: 'pg1-universe', file: 'slide-7-pg1-universe.png', still: 'deep-space', tag: 'Simulation', title: 'PG1 Universe', line: 'Simulated worlds with a living society, from orbit down to the ground, including Benin–Warri c. 1610: inspired by history, every fact sourced, its people fictional. With weather and day and night.' },
  { id: 'passkey-signed', file: 'slide-8-passkey-signed-results.png', still: 'city-night', tag: 'Trust', title: 'Passkey sign-in + signed results', line: "The operator signs in with a passkey; once one is set up, the password alone is refused. Every PG1 tool result is signed (Ed25519) and can be checked offline with PG1's public key." },
  { id: 'end', file: 'slide-9-link-in-bio.png', still: null, tag: '', title: 'Link in bio', line: 'Free checks for AI agents.' }
]);
export const STORY = Object.freeze({ file: 'story-1-cover-1080x1920.png', slide: 'cover' });
export const HIGHLIGHTS = SLIDES.filter((x) => x.still && x.id !== 'cover');
export const COVER = Object.freeze({ file: 'cover-1200x675.png', still: 'cover', tag: '23 November 2026', title: 'What PG1 shipped', line: 'PG1 City, PG1 Universe, and new free checks for agents.' });
// The post's date (the cover's label on the slide, the Story and the wide cover).
export const POST_DATE = '23 November 2026';

// The cut: [kind, what, seconds]. Shots run from their own start (the move
// eased in), cards fade in and out.
export const CUT = Object.freeze([
  ['title', null, 1.8],
  ['shot', 'city-night', 3.0, 'PG1 City · night'],
  ['card', 'pg1-city', 1.8],
  ['shot', 'city-rain', 2.6, 'PG1 City · Dublin rain'],
  ['card', 'check-repo-trap', 1.8],
  ['shot', 'first-universe', 3.4, 'PG1 Universe · Simulation'],
  ['card', 'pg1-universe', 1.8],
  ['shot', 'benin-warri', 2.8, 'Benin–Warri c. 1610 · Simulation'],
  ['card', 'check-agent-message', 1.8],
  ['shot', 'deep-space', 2.6, 'A planet and its star · Simulation'],
  ['card', 'a2a-1-0', 1.8],
  ['card', 'passkey-signed', 1.8],
  ['end', null, 1.6]
]);
export const cutSeconds = () => CUT.reduce((t, c) => t + c[2], 0);

const font = (w) => `data:font/woff2;base64,${readFileSync(join(ROOT, 'public', 'fonts', `inter-latin-${w}-normal.woff2`)).toString('base64')}`;
const SHIELD = readFileSync(join(ROOT, 'public', 'brand', 'pg1-shield.svg'), 'utf8').replace(/<title>.*?<\/title>/, '').replace(/width="104" height="104"/, 'width="100%" height="100%"');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BASE_CSS = () => `@font-face{font-family:I;font-weight:400;src:url(${font(400)})}@font-face{font-family:I;font-weight:600;src:url(${font(600)})}@font-face{font-family:I;font-weight:700;src:url(${font(700)})}
*{box-sizing:border-box;margin:0}html,body{width:100%;height:100%;background:#070708;color:#f4f4f6;font-family:I,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.mark{display:flex;align-items:center;gap:.5em;font-weight:600;letter-spacing:.02em;color:#e9e9ee}.mark i{display:block;width:1.6em;height:1.6em}
.tag{display:inline-block;font-weight:600;color:#f3c623;letter-spacing:.06em;text-transform:uppercase}
.title{font-weight:700;letter-spacing:-.02em;line-height:1.02}.line{font-weight:400;color:#d3d3da;line-height:1.3}.mono{font-feature-settings:"ss02"}`;
const crown = (cls = '') => `<i class="${cls}">${SHIELD}</i>`;
const isCode = (t) => /^[a-z_]+$/.test(t);

function recapHtml(h) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS()}
body{position:relative;overflow:hidden;background:radial-gradient(120% 70% at 50% 30%,#17140a 0%,#0b0b0d 45%,#070708 100%)}
.top{position:absolute;left:84px;top:78px;font-size:34px}.c{position:absolute;right:84px;top:64px;width:120px;height:120px}
.title{position:absolute;left:84px;top:190px;font-size:88px}
ul{position:absolute;left:84px;right:84px;top:330px;list-style:none;padding:0;display:flex;flex-direction:column;gap:18px}
li{display:flex;gap:26px;align-items:flex-start;padding:16px 24px;border:1px solid rgba(243,198,35,.22);border-radius:22px;background:rgba(255,255,255,.035)}
.k{flex:none;width:46px;height:46px;border-radius:50%;background:#f3c623;color:#070708;font-weight:700;font-size:30px;display:flex;align-items:center;justify-content:center;margin-top:4px}
.n{font-weight:700;font-size:34px;color:#fff;line-height:1.15}.t{font-size:30px;color:#d3d3da;line-height:1.3;margin-top:4px;white-space:nowrap}
.foot{position:absolute;left:84px;right:84px;bottom:66px;display:flex;justify-content:space-between;font-size:26px;color:#a9a9b3}
</style></head><body><div class="top mark">${crown()}PG1</div><div class="c">${SHIELD}</div><div class="title">${esc(h.title)}</div>
<ul>${h.items.map((it) => `<li><span class="k">✓</span><div><div class="n">${esc(it.name)}</div><div class="t">${esc(it.text)}</div></div></li>`).join('')}</ul>
<div class="foot"><span>${MARK}</span><span>PG1</span></div></body></html>`;
}

function cardHtml(h, bg, { hgt = 1350 } = {}) {
  if (h.items) return recapHtml(h);
  const big = isCode(h.title) ? 84 : h.title.length > 24 ? 80 : 108;
  // A summary of more than one line is set a little smaller (never under 30 px).
  const lineSize = h.line.length > 120 ? 34 : 40;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS()}
body{position:relative;overflow:hidden}.bg{position:absolute;inset:0;background:${bg ? `url(${bg}) center/cover` : 'radial-gradient(120% 70% at 50% 40%,#17140a 0%,#0b0b0d 45%,#070708 100%)'}}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(7,7,8,.55) 0%,rgba(7,7,8,0) 18%,rgba(7,7,8,0) ${hgt > 1500 ? 50 : 40}%,rgba(7,7,8,.82) ${hgt > 1500 ? 68 : 62}%,#070708 100%)}
.top{position:absolute;left:84px;top:${hgt > 1500 ? 120 : 78}px;font-size:34px}.body{position:absolute;left:84px;right:84px;bottom:${hgt > 1500 ? 260 : 150}px}

.tag{font-size:30px;margin-bottom:28px}.title{font-size:${big}px;margin-bottom:30px;text-shadow:0 2px 24px rgba(0,0,0,.5)}.line{font-size:${lineSize}px;max-width:912px;text-shadow:0 2px 16px rgba(0,0,0,.6)}
.foot{position:absolute;left:84px;right:84px;bottom:${hgt > 1500 ? 150 : 66}px;display:flex;justify-content:space-between;font-size:26px;color:#a9a9b3}
.endc{position:absolute;left:0;right:0;top:${Math.round(hgt * 0.24)}px;display:flex;justify-content:center}.endc i{display:block;width:240px;height:240px}
.end .body{left:84px;right:84px;bottom:auto;top:${Math.round(hgt * 0.24) + 320}px;text-align:center}.end .line{margin:0 auto}
</style></head><body class="${bg ? '' : 'end'}"><div class="bg"></div>${bg ? '<div class="shade"></div>' : ''}
${bg ? `<div class="top mark">${crown()}PG1</div>` : `<div class="endc">${crown()}</div>`}
<div class="body">${h.tag ? `<div class="tag">${esc(h.tag)}</div>` : ''}<div class="title">${esc(h.title)}</div><div class="line">${esc(h.line)}</div></div>
<div class="foot"><span>${MARK}</span><span>PG1</span></div></body></html>`;
}

function coverHtml(bg) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS()}
body{position:relative;overflow:hidden}.bg{position:absolute;inset:0;background:url(${bg}) center 38%/cover}
.shade{position:absolute;inset:0;background:linear-gradient(90deg,#070708 0%,rgba(7,7,8,.88) 34%,rgba(7,7,8,.2) 70%,rgba(7,7,8,.1) 100%)}
.c{position:absolute;left:72px;top:72px;width:110px;height:110px}.body{position:absolute;left:72px;bottom:120px;width:640px}
.tag{font-size:24px;margin-bottom:18px}.title{font-size:76px;margin-bottom:22px}.line{font-size:28px}.foot{position:absolute;left:72px;bottom:52px;font-size:22px;color:#a9a9b3}
</style></head><body><div class="bg"></div><div class="shade"></div><div class="c">${SHIELD}</div>
<div class="body"><div class="tag">${esc(COVER.tag)}</div><div class="title">${esc(COVER.title)}</div><div class="line">${esc(COVER.line)}</div></div><div class="foot">${MARK}</div></body></html>`;
}

// A full-screen text card for the vertical video.
function storyCardHtml(h) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS()}
body{background:radial-gradient(120% 70% at 50% 30%,#17140a 0%,#0b0b0d 45%,#070708 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 96px}
.c{width:150px;height:150px;margin-bottom:72px}.tag{font-size:32px;margin-bottom:36px}.title{font-size:${isCode(h.title) ? 84 : h.title.length > 24 ? 82 : 112}px;margin-bottom:40px}.line{font-size:44px;max-width:880px}
.foot{position:absolute;bottom:110px;left:0;right:0;font-size:28px;color:#8e8e98}
</style></head><body><div class="c">${SHIELD}</div><div class="tag">${esc(h.tag)}</div><div class="title">${esc(h.title)}</div><div class="line">${esc(h.line)}</div><div class="foot">${MARK}</div></body></html>`;
}
const titleCard = () => storyCardHtml({ tag: 'November 2026', title: 'What PG1 shipped', line: 'PG1 City, PG1 Universe, and new free checks for agents.' });
const endCard = () => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS()}
body{background:radial-gradient(120% 70% at 50% 42%,#17140a 0%,#0b0b0d 45%,#070708 100%);display:flex;flex-direction:column;align-items:center;justify-content:center}
.c{width:220px;height:220px;margin-bottom:56px}.m{font-size:52px;font-weight:700;letter-spacing:-.01em}.s{font-size:32px;color:#a9a9b3;margin-top:22px}
</style></head><body><div class="c">${SHIELD}</div><div class="m">${MARK}</div><div class="s">PG1</div></body></html>`;
// The lower-third label over a shot (transparent).
const labelHtml = (text) => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS()}
html,body{background:transparent}.l{position:absolute;left:72px;right:72px;bottom:190px;display:flex;align-items:center;gap:22px;font-size:40px;font-weight:600;color:#fff;text-shadow:0 2px 18px rgba(0,0,0,.65)}.l i{display:block;width:58px;height:58px;flex:none}
.m{position:absolute;right:72px;top:84px;font-size:26px;font-weight:600;color:rgba(255,255,255,.82);text-shadow:0 2px 12px rgba(0,0,0,.6)}
</style></head><body><div class="l">${crown()}<span>${esc(text)}</span></div><div class="m">${MARK}</div></body></html>`;

function ff(args) {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30'];

export async function build({ from, out, stills, video = true }) {
  const tmp = join(os.tmpdir(), `pg1-social-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true }); mkdirSync(out, { recursive: true });
  const shotMp4 = (id) => { const f = join(from, `${id}.mp4`); if (!existsSync(f)) throw new Error(`missing ${f} (run scripts/showcase-render.mjs first)`); return f; };
  // A full-resolution still (scripts/showcase-render.mjs --stills), as a data URL.
  const still = (id, size) => { const f = join(stills, `${id}-${size}.png`); if (!existsSync(f)) throw new Error(`missing ${f} (render it with --stills ${id} --size ${size})`); return `data:image/png;base64,${readFileSync(f).toString('base64')}`; };
  const { chromium } = await import('playwright');
  let executablePath;
  if (!existsSync(chromium.executablePath()) && existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({ executablePath });
  const shoot = async (html, w, h, path, transparent = false) => {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path, omitBackground: transparent });
    await page.close();
  };
  try {
    for (const h of SLIDES) await shoot(cardHtml(h, h.still ? still(h.still, '1080x1350') : null), 1080, 1350, join(out, h.file));
    const s1 = SLIDES.find((x) => x.id === STORY.slide);
    await shoot(cardHtml(s1, still(s1.still, '1080x1920'), { hgt: 1920 }), 1080, 1920, join(out, STORY.file));
    await shoot(coverHtml(still(COVER.still, '1920x1080')), 1200, 675, join(out, COVER.file));
    if (!video) return;
    // The vertical cut.
    const parts = [];
    for (const [i, [kind, what, sec, label]] of CUT.entries()) {
      const part = join(tmp, `part-${String(i).padStart(2, '0')}.mp4`);
      const fade = `fade=t=in:st=0:d=0.3,fade=t=out:st=${(sec - 0.3).toFixed(2)}:d=0.3`;
      if (kind === 'shot') {
        const lab = join(tmp, `label-${i}.png`);
        await shoot(labelHtml(label), 1080, 1920, lab, true);
        ff(['-i', shotMp4(what), '-loop', '1', '-i', lab, '-filter_complex', `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v];[v][1:v]overlay=0:0:shortest=1,${fade}`, '-t', String(sec), ...ENC, '-an', part]);
      } else {
        const png = join(tmp, `card-${i}.png`);
        await shoot(kind === 'title' ? titleCard() : kind === 'end' ? endCard() : storyCardHtml(SLIDES.find((h) => h.id === what)), 1080, 1920, png);
        ff(['-loop', '1', '-i', png, '-vf', `${fade},format=yuv420p`, '-t', String(sec), ...ENC, '-an', part]);
      }
      parts.push(part);
    }
    const list = join(tmp, 'list.txt');
    writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n') + '\n');
    ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', join(out, 'highlights.mp4')]);
  } finally { await browser.close(); rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2); const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  build({ from: resolve(get('--from', join(ROOT, 'showcase-out'))), stills: resolve(get('--stills', join(get('--from', join(ROOT, 'showcase-out')), 'stills'))), out: resolve(get('--out', join(ROOT, 'docs', 'social', '2026-11'))), video: !a.includes('--no-video') })
    .then(() => console.log('[social] done'), (e) => { console.error(`[social] ${e && e.stack || e}`); process.exit(1); });
}
