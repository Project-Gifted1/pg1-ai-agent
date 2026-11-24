#!/usr/bin/env node
// A post's contact sheet, for the quality check before it is committed: a
// frame of the reel every `every` seconds (in order, ten to a row), then
// every slide and the Story on a last row. With --frames DIR the same
// frames are also written there at full size (1080 x 1920), to look at one
// by one.
//
//   node scripts/contact-sheet.mjs --reel reel.mp4 --stills a.png,b.png --out sheet.jpg [--every 0.5] [--frames DIR]

import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const ff = (args) => { const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' }); if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`); };
const seconds = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout) || 0;

export const COLS = 10; export const TW = 216; export const TH = 384;

// The times sampled: 0, every, 2 * every, ... up to the reel's end.
export const sampleTimes = (duration, every = 0.5) => { const out = []; for (let t = 0; t <= duration - 0.02 + 1e-9; t += every) out.push(Number(t.toFixed(3))); return out; };

export function contactSheet({ reel, stills = [], out, every = 0.5, frames = null }) {
  const tmp = join(os.tmpdir(), `pg1-sheet-${process.pid}`); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
  try {
    const times = sampleTimes(seconds(reel), every);
    if (frames) { mkdirSync(frames, { recursive: true }); times.forEach((t, i) => ff(['-ss', t.toFixed(3), '-i', reel, '-frames:v', '1', join(frames, `reel-${String(i).padStart(3, '0')}-${t.toFixed(1)}s.png`)])); }
    const thumbs = times.map((t, i) => { const f = join(tmp, `t${String(i).padStart(3, '0')}.png`); ff(['-ss', t.toFixed(3), '-i', reel, '-frames:v', '1', '-vf', `scale=${TW}:${TH}:flags=lanczos`, f]); return f; });
    for (const [k, s] of stills.entries()) { const f = join(tmp, `s${k}.png`); ff(['-i', s, '-vf', `scale=${TW}:-2:flags=lanczos,pad=${TW}:${TH}:0:(oh-ih)/2:black`, f]); thumbs.push(f); }
    // Reel frames in rows of COLS; the stills start a new row.
    const reelRows = Math.ceil(times.length / COLS); const stillRows = Math.ceil(stills.length / COLS);
    const cells = [...times.map((_, i) => [i % COLS, Math.floor(i / COLS)]), ...stills.map((_, k) => [k % COLS, reelRows + Math.floor(k / COLS)])];
    ff([...thumbs.flatMap((f) => ['-i', f]), '-filter_complex', `${thumbs.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${thumbs.length}:layout=${cells.map(([c, r]) => `${c * TW}_${r * TH}`).join('|')}:fill=black,scale=${COLS * TW}:${(reelRows + stillRows) * TH}`, '-frames:v', '1', '-q:v', '3', out]);
    return { frames: times.length, stills: stills.length };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2); const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const r = contactSheet({ reel: resolve(get('--reel')), stills: (get('--stills', '') || '').split(',').filter(Boolean).map((s) => resolve(s)), out: resolve(get('--out', 'contact-sheet.jpg')), every: Number(get('--every', 0.5)), frames: get('--frames', null) && resolve(get('--frames')) });
  console.log(`[sheet] ${r.frames} reel frames, ${r.stills} stills`);
}
