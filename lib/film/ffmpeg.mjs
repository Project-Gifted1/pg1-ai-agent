// PG1 Studio assembly with ffmpeg. Runs only in the render worker
// (scripts/film-render.mjs on GitHub Actions), never in a Vercel function:
// a film takes minutes to encode and needs the ffmpeg binary.
//
// The steps, each its own ffmpeg run in one working folder:
//  1. one normalised video segment per shot (and per title or end card):
//     the clip trimmed to its best moment (or, for the preview, the still
//     with a camera move), scaled and cropped to the frame, 24 fps, the
//     film's colour grade, held on its last frame if the clip runs short;
//  2. the segments joined with their transitions (xfade, or a cut);
//  3. the audio: voiceover lines placed on their cues, a music bed per
//     scene faded in and out, ducked under the voice (sidechaincompress),
//     then normalised to about -14 LUFS (two-pass loudnorm);
//  4. the final encode: captions, scene titles and cards burned in (ASS),
//     H.264 + AAC, metadata stripped and replaced with PG1 Studio's own.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export const FPS = 24;
export const TARGET_LUFS = -14;
export const TARGET_TP = -1.0;
export const TARGET_LRA = 11;
export const FILM_SIZES = Object.freeze({
  preview: { width: 854, height: 480, crf: 30, preset: 'veryfast' },
  draft: { width: 1280, height: 720, crf: 23, preset: 'medium' },
  standard: { width: 1280, height: 720, crf: 19, preset: 'medium' },
  pro: { width: 1920, height: 1080, crf: 18, preset: 'slow' }
});

export const XFADE = Object.freeze({
  dissolve: 'fade', fade_black: 'fadeblack', fade_white: 'fadewhite', wipe_left: 'wipeleft', wipe_right: 'wiperight',
  slide_left: 'slideleft', slide_right: 'slideright', zoom_in: 'zoomin'
});

export const GRADE_FILTERS = Object.freeze({
  neutral: 'eq=contrast=1.03:saturation=1.03',
  teal_orange: 'colorbalance=rs=-0.06:bs=0.08:rh=0.08:bh=-0.06,eq=contrast=1.08:saturation=1.1,vignette=PI/6',
  warm: 'colorbalance=rm=0.05:bm=-0.05:rh=0.03,eq=saturation=1.06,vignette=PI/6',
  cool: 'colorbalance=rm=-0.04:bm=0.06,eq=contrast=1.04,vignette=PI/6',
  noir: 'hue=s=0,eq=contrast=1.25:brightness=-0.02,vignette=PI/5',
  bleach_bypass: 'eq=contrast=1.2:saturation=0.55,vignette=PI/6',
  vintage: 'curves=preset=vintage,eq=saturation=0.85,vignette=PI/5'
});

export function gradeFilter(grade) {
  return GRADE_FILTERS[grade] || GRADE_FILTERS.neutral;
}

// Runs ffmpeg (or ffprobe). Resolves to { stdout, stderr }; rejects with
// the tail of stderr.
export function run(bin, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 1e6) stdout = stdout.slice(-1e6); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 1e6) stderr = stderr.slice(-1e6); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${bin} exited ${code}: ${stderr.slice(-800)}`))));
  });
}

const ffmpeg = (args, opts) => run('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], opts);

export async function hasFfmpeg() {
  try { await run('ffmpeg', ['-version']); return true; } catch (e) { return false; }
}

export async function probeDuration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = Number(String(stdout).trim());
  if (!Number.isFinite(d)) throw new Error(`could not read the duration of ${path.basename(file)}`);
  return d;
}

export async function extractFrame(input, atS, out, { width = 768 } = {}) {
  await ffmpeg(['-loglevel', 'error', '-ss', String(Math.max(0, atS)), '-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', out]);
  return out;
}

// The last frame of a clip, full size (the start image of a continuous shot).
export async function extractLastFrame(input, out) {
  await ffmpeg(['-loglevel', 'error', '-sseof', '-0.25', '-i', input, '-update', '1', '-frames:v', '1', '-q:v', '2', out]);
  return out;
}

const fmt = (n) => (Math.round(n * 1000) / 1000).toFixed(3);

// The zoompan expression for a still's camera move over n frames.
export function kenBurns(camera, frames, width, height) {
  const N = Math.max(1, frames - 1);
  const centre = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
  const moves = {
    static: `z='1.02':${centre}`,
    push_in: `z='1+0.12*on/${N}':${centre}`,
    pull_out: `z='1.12-0.12*on/${N}':${centre}`,
    pan_left: `z='1.12':x='(iw-iw/zoom)*(1-on/${N})':y='ih/2-(ih/zoom/2)'`,
    pan_right: `z='1.12':x='(iw-iw/zoom)*on/${N}':y='ih/2-(ih/zoom/2)'`,
    tilt_up: `z='1.12':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/${N})'`,
    tilt_down: `z='1.12':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/${N}'`
  };
  const fallback = { crane_up: 'tilt_up', tracking: 'pan_right', orbit: 'pan_left', drone_flyover: 'push_in', dolly_zoom: 'push_in', handheld: 'static' };
  const m = moves[camera] || moves[fallback[camera]] || moves.push_in;
  return `zoompan=${m}:d=${frames}:s=${width}x${height}:fps=${FPS}`;
}

function encodeArgs(size) {
  return ['-c:v', 'libx264', '-preset', size.preset === 'slow' ? 'medium' : 'veryfast', '-crf', String(Math.max(14, size.crf - 4)), '-pix_fmt', 'yuv420p', '-an'];
}

// 1. One segment per shot or card.
export async function segmentFromStill(still, { camera, durationS, out, size, grade }) {
  const frames = Math.round(durationS * FPS);
  const vf = `scale=${size.width * 2}:${size.height * 2}:force_original_aspect_ratio=increase,crop=${size.width * 2}:${size.height * 2},${kenBurns(camera, frames, size.width, size.height)},setsar=1,${gradeFilter(grade)},format=yuv420p`;
  await ffmpeg(['-loglevel', 'error', '-i', still, '-vf', vf, '-frames:v', String(frames), '-r', String(FPS), ...encodeArgs(size), out]);
  return out;
}

export async function segmentFromClip(clip, { inS = 0, durationS, clipS = null, out, size, grade }) {
  const pad = clipS != null ? Math.max(0, durationS - (clipS - inS)) : 0;
  const vf = [
    `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase`, `crop=${size.width}:${size.height}`,
    `fps=${FPS}`, 'setsar=1', ...(pad > 0.01 ? [`tpad=stop_mode=clone:stop_duration=${fmt(pad + 0.1)}`] : []), gradeFilter(grade), 'format=yuv420p'
  ].join(',');
  await ffmpeg(['-loglevel', 'error', '-ss', fmt(inS), '-i', clip, '-t', fmt(durationS), '-vf', vf, '-r', String(FPS), ...encodeArgs(size), out]);
  return out;
}

export async function segmentCard({ durationS, out, size }) {
  await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${size.width}x${size.height}:r=${FPS}:d=${fmt(durationS)}`, '-vf', 'setsar=1,format=yuv420p', ...encodeArgs(size), out]);
  return out;
}

// 2. The filtergraph that joins segments with their transitions.
// Every input and every join is put on the same timebase (1/FPS): xfade
// refuses two inputs whose timebases differ, and concat changes it.
export function joinFilter(durations, joins) {
  const tb = `settb=1/${FPS}`;
  const parts = durations.map((_, i) => `[${i}:v]${tb},setpts=PTS-STARTPTS[s${i}]`);
  let label = '[s0]';
  let length = durations[0];
  for (let i = 1; i < durations.length; i++) {
    const j = joins[i - 1];
    const outLabel = i === durations.length - 1 ? '[vout]' : `[j${i}]`;
    if (!j || j.transition === 'cut' || !(j.durationS > 0)) {
      parts.push(`${label}[s${i}]concat=n=2:v=1:a=0,${tb}${outLabel}`);
      length += durations[i];
    } else {
      const offset = Math.max(0, length - j.durationS);
      parts.push(`${label}[s${i}]xfade=transition=${XFADE[j.transition] || 'fade'}:duration=${fmt(j.durationS)}:offset=${fmt(offset)},${tb}${outLabel}`);
      length += durations[i] - j.durationS;
    }
    label = outLabel;
  }
  return { filter: parts.join(';'), lengthS: length, single: durations.length === 1 };
}

export async function joinSegments(files, durations, joins, out, size) {
  if (files.length === 1) {
    await ffmpeg(['-loglevel', 'error', '-i', files[0], '-c', 'copy', out]);
    return out;
  }
  const { filter } = joinFilter(durations, joins);
  await ffmpeg(['-loglevel', 'error', ...files.flatMap((f) => ['-i', f]), '-filter_complex', filter, '-map', '[vout]', '-r', String(FPS), ...encodeArgs(size), out]);
  return out;
}

// 3. Audio. voice: [{ file, atS }], music: [{ file, startS, endS }].
export function mixFilter({ voice, music, totalS }) {
  const parts = [];
  const vIn = voice.map((_, i) => i);
  const mIn = music.map((_, i) => voice.length + i);
  const toStereo = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  vIn.forEach((idx, i) => parts.push(`[${idx}:a]${toStereo},adelay=delays=${Math.round(voice[i].atS * 1000)}:all=1[v${i}]`));
  mIn.forEach((idx, i) => {
    const m = music[i];
    const len = Math.max(0.5, m.endS - m.startS);
    const fadeOut = Math.min(1.5, len / 3);
    parts.push(`[${idx}:a]${toStereo},atrim=0:${fmt(len)},asetpts=N/SR/TB,afade=t=in:d=${fmt(Math.min(1, len / 3))},afade=t=out:st=${fmt(len - fadeOut)}:d=${fmt(fadeOut)},volume=0.55,adelay=delays=${Math.round(m.startS * 1000)}:all=1[m${i}]`);
  });
  const end = `apad=whole_dur=${fmt(totalS)},atrim=0:${fmt(totalS)}`;
  if (voice.length && music.length) {
    parts.push(`${vIn.map((_, i) => `[v${i}]`).join('')}amix=inputs=${voice.length}:normalize=0:duration=longest[vo]`);
    parts.push(`${mIn.map((_, i) => `[m${i}]`).join('')}amix=inputs=${music.length}:normalize=0:duration=longest[mus]`);
    parts.push('[vo]asplit=2[vo1][vosc]');
    parts.push('[mus][vosc]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400:makeup=1[duck]');
    parts.push(`[duck][vo1]amix=inputs=2:normalize=0:duration=longest,${end}[aout]`);
  } else if (voice.length) {
    parts.push(`${vIn.map((_, i) => `[v${i}]`).join('')}amix=inputs=${voice.length}:normalize=0:duration=longest,${end}[aout]`);
  } else if (music.length) {
    parts.push(`${mIn.map((_, i) => `[m${i}]`).join('')}amix=inputs=${music.length}:normalize=0:duration=longest,${end}[aout]`);
  }
  return parts.join(';');
}

export async function mixAudio({ voice, music, totalS, out }) {
  if (!voice.length && !music.length) {
    await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', fmt(totalS), '-c:a', 'pcm_s16le', out]);
    return out;
  }
  const inputs = [...voice.map((v) => ['-i', v.file]), ...music.map((m) => ['-stream_loop', '-1', '-i', m.file])].flat();
  await ffmpeg(['-loglevel', 'error', ...inputs, '-filter_complex', mixFilter({ voice, music, totalS }), '-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '48000', out]);
  return out;
}

// The loudnorm measurement JSON printed at the end of ffmpeg's log.
export function parseLoudnorm(stderr) {
  const s = String(stderr || '');
  const start = s.lastIndexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no loudness measurement');
  const j = JSON.parse(s.slice(start, end + 1));
  for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) if (!Number.isFinite(Number(j[k]))) throw new Error(`loudness measurement has no ${k}`);
  return j;
}

export async function measureLoudness(file) {
  const { stderr } = await ffmpeg(['-loglevel', 'info', '-i', file, '-af', `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json`, '-f', 'null', '-']);
  return parseLoudnorm(stderr);
}

// Two-pass loudnorm to TARGET_LUFS. Resolves to { file, measured, after }.
export async function normaliseLoudness(input, out) {
  const m = await measureLoudness(input);
  // Silence measures as -inf / -70: nothing to normalise.
  if (!(Number(m.input_i) > -60)) {
    await ffmpeg(['-loglevel', 'error', '-i', input, '-c:a', 'pcm_s16le', out]);
    return { file: out, measured: m, after: null };
  }
  const af = `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`;
  await ffmpeg(['-loglevel', 'error', '-i', input, '-af', af, '-c:a', 'pcm_s16le', '-ar', '48000', out]);
  const after = await measureLoudness(out);
  return { file: out, measured: m, after };
}

// 4. Captions, scene titles and cards as one ASS file.
function assTime(s) {
  const t = Math.max(0, s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

export function assEscape(text) {
  return String(text || '').replace(/[\r\n]+/g, ' ').replace(/\\/g, '').replace(/[{}]/g, '').trim();
}

export function buildAss({ width, height, captions = [], titles = [] }) {
  const cap = Math.round(height * 0.046);
  const title = Math.round(height * 0.075);
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,DejaVu Sans,${cap},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(cap / 14))},1,2,${Math.round(width * 0.08)},${Math.round(width * 0.08)},${Math.round(height * 0.07)},1`,
    `Style: Title,DejaVu Serif,${title},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,2,0,1,${Math.max(1, Math.round(title / 20))},0,8,40,40,${Math.round(height * 0.1)},1`,
    `Style: Card,DejaVu Serif,${title},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,3,0,1,0,0,5,40,40,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  for (const t of titles) lines.push(`Dialogue: 1,${assTime(t.startS)},${assTime(t.endS)},${t.style || 'Title'},,0,0,0,,{\\fad(500,500)}${assEscape(t.text)}`);
  for (const c of captions) lines.push(`Dialogue: 0,${assTime(c.startS)},${assTime(c.endS)},Caption,,0,0,0,,${assEscape(c.text)}`);
  return lines.join('\n') + '\n';
}

// The final file: graded video + burned captions + normalised audio, with
// the source files' metadata stripped (no engine names in the file).
export async function finalEncode({ video, audio, ass, out, size, title, totalS, cwd }) {
  const assName = path.basename(ass);
  const vf = `subtitles=${assName}`;
  await ffmpeg([
    '-loglevel', 'error', '-i', video, '-i', audio,
    '-vf', vf, '-map', '0:v:0', '-map', '1:a:0', '-t', fmt(totalS),
    '-c:v', 'libx264', '-preset', size.preset, '-crf', String(size.crf), '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
    '-metadata', `title=${String(title || 'PG1 Studio').slice(0, 80)}`, '-metadata', 'comment=PG1 Studio', '-metadata:s:v:0', 'encoder=PG1 Studio', '-metadata:s:a:0', 'encoder=PG1 Studio',
    '-movflags', '+faststart', out
  ], { cwd });
  return out;
}

export async function extractAudioForCheck(input, out) {
  await ffmpeg(['-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
  return out;
}

export async function thumbnail(input, atS, out, { width = 320 } = {}) {
  return extractFrame(input, atS, out, { width });
}

export async function writeText(file, text) {
  await writeFile(file, text, 'utf8');
  return file;
}
