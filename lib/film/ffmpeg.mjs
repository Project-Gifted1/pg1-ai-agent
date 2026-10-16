// PG1 Studio assembly with ffmpeg. Runs only in the render worker
// (scripts/film-render.mjs on GitHub Actions), never in a Vercel function:
// a film takes minutes to encode and needs the ffmpeg binary.
//
// The steps, each its own ffmpeg run in one working folder:
//  1. one normalised video segment per shot (and per title or end card):
//     the clip trimmed to its best moment (or, for the preview, the still
//     with a camera move), scaled and cropped to the frame, 24 fps, the
//     film's colour grade, held on its last frame if the clip runs short;
//     an attached image (segmentFromImage) is instead fitted whole into the
//     frame (letterboxed, never cropped or stretched), held or slowly
//     pushed in, with no grade, and checked against the source afterwards
//     (matchImageSegment);
//  2. the segments joined with their transitions (xfade, or a cut);
//  3. the audio: voiceover lines placed on their cues, a music bed per
//     scene faded in and out, ducked under the voice (sidechaincompress),
//     then normalised to about -14 LUFS (two-pass loudnorm);
//  4. the final encode: captions, scene titles and cards burned in (ASS),
//     H.264 + AAC, metadata stripped and replaced with PG1 Studio's own.

import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

export const FPS = 24;
export const TARGET_LUFS = -14;
export const TARGET_TP = -1.0;
export const TARGET_LRA = 11;
// The master spec every delivered film and movie is encoded to
// (lib/film/ffmpeg.mjs finalEncode; checked by qcGate): 1920x1080 when the
// sources deliver it, otherwise the sources' own resolution and never lower;
// 24 fps; H.264 High profile at CRF 18 with a bitrate floor (8 Mbps at
// 1080p, scaled by pixel count below it); AAC 256 kb/s stereo at 48 kHz.
//
// History: masters used to be encoded from a per-tier size table whose
// preview row was 854x480 at CRF 30 (veryfast) and whose standard row capped
// every film at 1280x720 whatever the clips delivered. The preview stage
// (stills with a camera move, three voice lines, no music) was handed to the
// operator as the film, so a 64 s "master" came out at 854x480 and about
// 69 kb/s (near-static frames at CRF 30), with held frames and a silent end.
export const MASTER = Object.freeze({
  width: 1920, height: 1080, fps: FPS, crf: 18, preset: 'medium', profile: 'high',
  audioCodec: 'aac', audioBitrate: '256k', audioKbps: 256, audioRate: 48000, channels: 2, minKbpsAt1080: 8000
});

// The master's frame for the sources a film is cut from ([{ width, height }],
// the probed clips; stills and cards count as 1080p): 1920x1080 when any
// source is 1080p or more, else the largest source's 16:9 frame. Never
// below a source, never above 1080p.
export function masterSizeFor(sources = []) {
  const heights = (sources || []).map((s) => Math.round(Number(s && s.height) || 0)).filter((h) => h > 0);
  const h = heights.length ? Math.min(MASTER.height, Math.max(...heights)) : MASTER.height;
  const height = Math.max(2, Math.floor(h / 2) * 2);
  const width = Math.max(2, Math.round((height * 16) / 9 / 2) * 2);
  return { width, height, crf: MASTER.crf, preset: MASTER.preset };
}

// The least video bitrate a master of this frame may have (kb/s).
export function minVideoKbps(size = MASTER) {
  return Math.round((MASTER.minKbpsAt1080 * (size.width * size.height)) / (1920 * 1080));
}

// Kept for callers that still name a tier: every row is the master spec now
// (the frame itself comes from masterSizeFor and the probed sources).
export const FILM_SIZES = Object.freeze({
  preview: masterSizeFor([]),
  draft: masterSizeFor([{ height: 720 }]),
  standard: masterSizeFor([{ height: 720 }]),
  pro: masterSizeFor([{ height: 1080 }])
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
    // A slow drift, never a held frame (a static still would read as a freeze).
    static: `z='1.02+0.03*on/${N}':${centre}`,
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

// A clip's segment is never longer than the clip has from inS: a short
// clip is never padded with a held frame (the edit is fitted to real clip
// lengths instead, lib/film/cuts.mjs and lib/movie/edit.mjs).
export function clipSegmentSeconds({ inS = 0, durationS, clipS = null }) {
  if (clipS == null) return durationS;
  return Math.max(0.1, Math.min(durationS, clipS - inS));
}

export async function segmentFromClip(clip, { inS = 0, durationS, clipS = null, out, size, grade }) {
  const d = clipSegmentSeconds({ inS, durationS, clipS });
  const vf = [
    `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase`, `crop=${size.width}:${size.height}`,
    `fps=${FPS}`, 'setsar=1', gradeFilter(grade), 'format=yuv420p'
  ].join(',');
  await ffmpeg(['-loglevel', 'error', '-ss', fmt(inS), '-i', clip, '-t', fmt(d), '-vf', vf, '-r', String(FPS), ...encodeArgs(size), out]);
  return out;
}

// --- attached images (lib/film/attachments.mjs) ---------------------------------

// The most an attached image is zoomed by its push-in, at the shot's end.
export const PUSH_IN_MAX_ZOOM = 0.05;
// How alike a rendered frame and the source image (fitted the same way,
// zoomed as far as the push-in had got) must be: 0–1, 1 is identical.
export const IMAGE_MATCH_MIN = 0.97;
const MATCH_W = 32;
const MATCH_H = 18;

// The filtergraph that fits input 1 (the image) whole inside a black
// width×height frame (input 0): scaled down or up to fit, never cropped or
// stretched, centred, a transparent background on black.
export function fitImageGraph(width, height, { out = 'fit' } = {}) {
  return `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,format=rgba[img];`
    + `[0:v][img]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1:format=auto,setsar=1[${out}]`;
}

// Where an image sits in a width×height frame: { w, h, x, y } (letterbox
// bars above and below, or pillarbox bars to the sides).
export function letterboxFit(imgW, imgH, width, height) {
  const scale = Math.min(width / imgW, height / imgH);
  let w = Math.floor((imgW * scale) / 2) * 2;
  let h = Math.floor((imgH * scale) / 2) * 2;
  w = Math.max(2, Math.min(width, w));
  h = Math.max(2, Math.min(height, h));
  return { w, h, x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2) };
}

// The image goes to video colours the way every other shot's still or
// clip does (format=yuv420p, the same matrix and range), so it survives the
// join and the final encode with its colours as they are.
const TO_VIDEO = 'format=yuv420p';

// The video filter for an attached image's shot over `frames` frames: held
// still, or a push-in from 1× to 1 + PUSH_IN_MAX_ZOOM, centred. The fit is
// made at twice the size first so the slow zoom stays smooth. No grade.
export function imageShotGraph(mode, frames, size) {
  const { width, height } = size;
  if (mode === 'push_in') {
    const N = Math.max(1, frames - 1);
    return `${fitImageGraph(width * 2, height * 2, { out: 'big' })};[big]zoompan=z='1+${PUSH_IN_MAX_ZOOM}*on/${N}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${FPS},setsar=1,${TO_VIDEO}[vout]`;
  }
  return `${fitImageGraph(width, height, { out: 'fit' })};[fit]fps=${FPS},${TO_VIDEO}[vout]`;
}

export async function segmentFromImage(image, { mode = 'hold', durationS, out, size }) {
  const frames = Math.round(durationS * FPS);
  const push = mode === 'push_in';
  const canvas = push ? `color=c=black:s=${size.width * 2}x${size.height * 2}:r=${FPS}:d=1` : `color=c=black:s=${size.width}x${size.height}:r=${FPS}:d=${fmt(durationS + 0.5)}`;
  await ffmpeg([
    '-loglevel', 'error', '-f', 'lavfi', '-i', canvas, ...(push ? ['-i', image] : ['-loop', '1', '-framerate', String(FPS), '-i', image]),
    '-filter_complex', imageShotGraph(mode, frames, size), '-map', '[vout]', '-frames:v', String(frames), '-r', String(FPS), ...encodeArgs(size), out
  ]);
  return out;
}

// A tiny RGB copy (MATCH_W×MATCH_H, raw bytes) of a frame of `input` at
// `atS`, or of an image fitted into the frame as segmentFromImage fits it
// (`fitTo`, a size), zoomed in on its centre by `zoom`.
export async function matchPixels(input, out, { atS = null, fitTo = null, zoom = 1 } = {}) {
  // To RGB at full size first, so both sides are averaged the same way.
  const shrink = `format=rgb24,scale=${MATCH_W}:${MATCH_H}:flags=area,format=rgb24`;
  if (fitTo) {
    const z = zoom > 1 ? `crop=trunc(iw/${zoom.toFixed(4)}):trunc(ih/${zoom.toFixed(4)}),` : '';
    await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${fitTo.width}x${fitTo.height}:r=1:d=1`, '-i', input,
      '-filter_complex', `${fitImageGraph(fitTo.width, fitTo.height, { out: 'fit' })};[fit]${z}${shrink}[o]`, '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', out]);
  } else {
    await ffmpeg(['-loglevel', 'error', '-ss', fmt(Math.max(0, atS || 0)), '-i', input, '-frames:v', '1', '-vf', shrink, '-f', 'rawvideo', out]);
  }
  return readFile(out);
}

// 0–1: one minus the mean absolute difference of two same-size RGB byte
// buffers (1 is identical). A missing or mismatched buffer is 0.
export function pixelSimilarity(a, b) {
  if (!a || !b || !a.length || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return Math.round((1 - sum / (a.length * 255)) * 1000) / 1000;
}

// The frames sampled from an attached image's shot (the start, the middle
// and the end) and how far a push-in has zoomed at each.
export function imageMatchTimes(durationS, mode) {
  const d = Math.max(0.3, durationS);
  const N = Math.max(1, Math.round(d * FPS) - 1);
  return [0.1, d / 2, d - 0.15].map((t) => {
    const at = Math.round(Math.min(Math.max(0, t), d - 0.05) * 100) / 100;
    const zoom = mode === 'push_in' ? 1 + PUSH_IN_MAX_ZOOM * Math.min(1, Math.round(at * FPS) / N) : 1;
    return { t: at, zoom: Math.round(zoom * 10000) / 10000 };
  });
}

// Checks an attached image's rendered shot against the image itself.
// Resolves to { pass, similarity (the lowest), frames: [{ t, zoom,
// similarity }] }.
export async function matchImageSegment(segment, image, { mode = 'hold', durationS, size, workdir, name = 'img' }) {
  const frames = [];
  for (const [i, { t, zoom }] of imageMatchTimes(durationS, mode).entries()) {
    const ref = await matchPixels(image, path.join(workdir, `match-${name}-src-${i}.rgb`), { fitTo: size, zoom });
    const got = await matchPixels(segment, path.join(workdir, `match-${name}-${i}.rgb`), { atS: t });
    frames.push({ t, zoom, similarity: pixelSimilarity(ref, got) });
  }
  const similarity = Math.min(...frames.map((f) => f.similarity));
  return { pass: similarity >= IMAGE_MATCH_MIN, similarity, frames };
}

// A card's background: a dark gradient drifting slowly, so a title or a
// credit is never a frozen frame.
export function cardSource(size, durationS) {
  return `gradients=s=${size.width}x${size.height}:c0=0x1a1f28:c1=0x020304:nb_colors=2:speed=0.01:r=${FPS}:d=${fmt(durationS)}`;
}

export async function segmentCard({ durationS, out, size }) {
  await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', cardSource(size, durationS), '-vf', 'setsar=1,format=yuv420p', '-frames:v', String(Math.round(durationS * FPS)), ...encodeArgs(size), out]);
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
// sfx: [{ file, atS, durationS }] (Director Mode's cues): mixed in after
// the music is ducked under the voice, never ducked themselves.
export function mixFilter({ voice, music, sfx = [], totalS }) {
  const parts = [];
  const vIn = voice.map((_, i) => i);
  const mIn = music.map((_, i) => voice.length + i);
  const fIn = sfx.map((_, i) => voice.length + music.length + i);
  const toStereo = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  vIn.forEach((idx, i) => parts.push(`[${idx}:a]${toStereo},adelay=delays=${Math.round(voice[i].atS * 1000)}:all=1[v${i}]`));
  mIn.forEach((idx, i) => {
    const m = music[i];
    // A cue scored to its section. One that came back shorter than its
    // section is played again from its start to the section's end, so the
    // audio covers the whole runtime (the film never ends in silence).
    const len = Math.max(0.5, m.endS - m.startS);
    const bed = Number(m.bedS) > 0 ? Number(m.bedS) : Infinity;
    const loop = bed < len - 0.05 ? `aloop=loop=${Math.ceil(len / bed)}:size=${Math.round(bed * 48000)},` : '';
    const fadeOut = Math.min(1.5, len / 3);
    parts.push(`[${idx}:a]${toStereo},${loop}atrim=0:${fmt(len)},asetpts=N/SR/TB,afade=t=in:d=${fmt(Math.min(1, len / 3))},afade=t=out:st=${fmt(len - fadeOut)}:d=${fmt(fadeOut)},volume=${m.volume != null ? m.volume : 0.55},adelay=delays=${Math.round(m.startS * 1000)}:all=1[m${i}]`);
  });
  fIn.forEach((idx, i) => {
    const f = sfx[i];
    const len = Math.max(0.3, Number(f.durationS) || 3);
    const fadeOut = Math.min(0.5, len / 4);
    parts.push(`[${idx}:a]${toStereo},atrim=0:${fmt(len)},asetpts=N/SR/TB,afade=t=out:st=${fmt(len - fadeOut)}:d=${fmt(fadeOut)},volume=${f.volume != null ? f.volume : 0.8},adelay=delays=${Math.round(f.atS * 1000)}:all=1[f${i}]`);
  });
  // Timestamps from 0 first: amix starts its output at the earliest cue,
  // and apad would then stop short of the film's length (a silent tail).
  const end = `asetpts=N/SR/TB,apad=whole_dur=${fmt(totalS)},atrim=0:${fmt(totalS)}`;
  const group = (labels, name) => {
    if (labels.length === 1) { parts.push(`${labels[0]}anull[${name}]`); return; }
    parts.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[${name}]`);
  };
  const out = [];
  if (voice.length) group(vIn.map((_, i) => `[v${i}]`), 'vo');
  if (music.length) group(mIn.map((_, i) => `[m${i}]`), 'mus');
  if (sfx.length) group(fIn.map((_, i) => `[f${i}]`), 'fx');
  if (voice.length && music.length) {
    // The sidechain runs the whole length: sidechaincompress stops when
    // either input ends, which used to cut the music off after the last line.
    parts.push(`[vo]asetpts=N/SR/TB,apad=whole_dur=${fmt(totalS)},asplit=2[vo1][vosc]`);
    parts.push('[mus][vosc]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400:makeup=1[duck]');
    out.push('[duck]', '[vo1]');
  } else {
    if (voice.length) out.push('[vo]');
    if (music.length) out.push('[mus]');
  }
  if (sfx.length) out.push('[fx]');
  parts.push(out.length === 1 ? `${out[0]}${end}[aout]` : `${out.join('')}amix=inputs=${out.length}:normalize=0:duration=longest,${end}[aout]`);
  return parts.join(';');
}

export async function mixAudio({ voice, music, sfx = [], totalS, out }) {
  if (!voice.length && !music.length && !sfx.length) {
    await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', fmt(totalS), '-c:a', 'pcm_s16le', ...AUDIO_METADATA, out]);
    return out;
  }
  // An entry with `lavfi` is a generated source (room tone), not a file.
  const input = (x) => (x.lavfi ? ['-f', 'lavfi', '-i', x.lavfi] : ['-i', x.file]);
  const inputs = [...voice.map(input), ...music.map(input), ...sfx.map(input)].flat();
  await ffmpeg(['-loglevel', 'error', ...inputs, '-filter_complex', mixFilter({ voice, music, sfx, totalS }), '-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '48000', ...AUDIO_METADATA, out]);
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

// crawl: { startS, endS, lines } rolls the end credits from below the frame
// to above it (Director Mode).
export function buildAss({ width, height, captions = [], titles = [], crawl = null }) {
  const cap = Math.round(height * 0.046);
  const title = Math.round(height * 0.075);
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,DejaVu Sans,${cap},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(cap / 14))},1,2,${Math.round(width * 0.08)},${Math.round(width * 0.08)},${Math.round(height * 0.07)},1`,
    `Style: Title,DejaVu Serif,${title},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,2,0,1,${Math.max(1, Math.round(title / 20))},0,8,40,40,${Math.round(height * 0.1)},1`,
    `Style: Card,DejaVu Serif,${title},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,3,0,1,0,0,5,40,40,0,1`,
    `Style: Crawl,DejaVu Serif,${cap},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,0,0,8,40,40,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  for (const t of titles) lines.push(`Dialogue: 1,${assTime(t.startS)},${assTime(t.endS)},${t.style || 'Title'},,0,0,0,,{\\fad(500,500)}${assEscape(t.text)}`);
  for (const c of captions) lines.push(`Dialogue: 0,${assTime(c.startS)},${assTime(c.endS)},Caption,,0,0,0,,${assEscape(c.text)}`);
  if (crawl && Array.isArray(crawl.lines) && crawl.lines.length) {
    const lineH = Math.round(cap * 1.6);
    const blockH = lineH * crawl.lines.length;
    const x = Math.round(width / 2);
    const t1 = Math.round((crawl.endS - crawl.startS) * 1000);
    lines.push(`Dialogue: 2,${assTime(crawl.startS)},${assTime(crawl.endS)},Crawl,,0,0,0,,{\\move(${x},${height},${x},${-blockH},0,${t1})}${crawl.lines.map(assEscape).join('\\N')}`);
  }
  return lines.join('\n') + '\n';
}

// The 9:16 social cut: the master fitted whole on a blurred fill of
// itself (nothing cropped out, captions kept), audio copied.
export const SOCIAL_SIZE = Object.freeze({ width: 1080, height: 1920 });
export function socialFilter({ width, height } = SOCIAL_SIZE) {
  return `[0:v]split=2[bgsrc][fgsrc];[bgsrc]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=20:2[bg];[fgsrc]scale=${width}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[vout]`;
}
export async function socialCut(input, out, size = SOCIAL_SIZE, { title = null } = {}) {
  await ffmpeg(['-loglevel', 'error', '-i', input, '-filter_complex', socialFilter(size), '-map', '[vout]', '-map', '0:a:0?', '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', String(MASTER.crf), '-r', String(FPS), '-c:a', 'copy', ...videoMetadata(title), '-movflags', '+faststart', out]);
  return out;
}

// Metadata every delivered file carries: the sources' stripped, the muxer's
// and encoder's own tags replaced (bitexact), and PG1 Studio's in their
// place, so no engine, library or model name is in the file.
export function videoMetadata(title = null) {
  return [
    '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
    '-metadata', `title=${String(title || 'PG1 Studio').slice(0, 80)}`, '-metadata', 'comment=PG1 Studio', '-metadata:s:v:0', 'encoder=PG1 Studio', '-metadata:s:a:0', 'encoder=PG1 Studio'
  ];
}
// Room tone under the whole runtime: a soft pink-noise floor (about
// -48 dBFS) that keeps a gap between lines and cues from reading as dead
// silence. Used by the QC gate's one fix when it finds a silence.
export function roomTone(totalS) {
  return { lavfi: `anoisesrc=color=pink:amplitude=0.008:r=48000:d=${fmt(totalS + 0.5)}`, atS: 0, durationS: totalS, volume: 1 };
}

export const AUDIO_METADATA = Object.freeze(['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact']);

// The master's encoder settings: H.264 High, CRF 18 (or, for the floor
// pass, a constant bitrate at the floor), 24 fps, AAC 256 kb/s stereo 48 kHz.
export function masterVideoArgs(size, { floorKbps = null } = {}) {
  const cap = `${Math.max(40000, minVideoKbps(size) * 5)}k`;
  const rate = floorKbps
    ? ['-b:v', `${floorKbps}k`, '-minrate', `${floorKbps}k`, '-maxrate', `${floorKbps}k`, '-bufsize', `${floorKbps}k`, '-x264-params', 'nal-hrd=cbr:force-cfr=1']
    : ['-crf', String(MASTER.crf), '-maxrate', cap, '-bufsize', cap];
  return ['-c:v', 'libx264', '-profile:v', MASTER.profile, '-preset', MASTER.preset, ...rate, '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS * 2)];
}
export const MASTER_AUDIO_ARGS = Object.freeze(['-c:a', MASTER.audioCodec, '-b:a', MASTER.audioBitrate, '-ar', String(MASTER.audioRate), '-ac', String(MASTER.channels)]);

// The final file: graded video + burned captions + normalised audio, with
// the source files' metadata stripped (no engine names in the file), to the
// master spec. A first pass at CRF 18; when its video comes in under the
// bitrate floor (a quiet, low-motion film), it is encoded again at the floor.
export async function finalEncode({ video, audio, ass = null, out, size, title, totalS, cwd, probe = probeMedia }) {
  const encode = (floorKbps) => ffmpeg([
    '-loglevel', 'error', '-i', video, '-i', audio,
    ...(ass ? ['-vf', `subtitles=${path.basename(ass)}`] : []), '-map', '0:v:0', '-map', '1:a:0', '-t', fmt(totalS),
    ...masterVideoArgs(size, { floorKbps }), ...MASTER_AUDIO_ARGS,
    ...videoMetadata(title),
    '-movflags', '+faststart', out
  ], { cwd });
  await encode(null);
  const floor = minVideoKbps(size);
  try {
    const p = await probe(cwd && !path.isAbsolute(out) ? path.join(cwd, out) : out);
    if (p.videoKbps != null && p.videoKbps < floor) await encode(Math.ceil(floor * 1.05));
  } catch (e) { /* the QC gate measures it again */ }
  return out;
}

// --- the QC gate before delivery (/film and /movie) -------------------------------

// ffprobe's view of a file: { width, height, fps, videoKbps, profile,
// codec, audioCodec, audioKbps, sampleRate, channels, durationS }.
export async function probeMedia(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,bit_rate:stream=codec_type,codec_name,profile,width,height,r_frame_rate,avg_frame_rate,bit_rate,sample_rate,channels', '-of', 'json', file]);
  return parseProbe(stdout);
}

export function parseProbe(stdout) {
  const j = JSON.parse(String(stdout || '{}'));
  const streams = Array.isArray(j.streams) ? j.streams : [];
  const v = streams.find((x) => x.codec_type === 'video') || {};
  const a = streams.find((x) => x.codec_type === 'audio') || {};
  const rate = (r) => { const [n, d] = String(r || '0/1').split('/').map(Number); return d ? Math.round((n / d) * 1000) / 1000 : 0; };
  const kbps = (b) => (Number(b) > 0 ? Math.round(Number(b) / 1000) : null);
  return {
    width: Number(v.width) || 0, height: Number(v.height) || 0, fps: rate(v.avg_frame_rate || v.r_frame_rate), videoKbps: kbps(v.bit_rate) || kbps(j.format && j.format.bit_rate),
    profile: v.profile || null, codec: v.codec_name || null, audioCodec: a.codec_name || null, audioKbps: kbps(a.bit_rate), sampleRate: Number(a.sample_rate) || 0,
    channels: Number(a.channels) || 0, durationS: Number(j.format && j.format.duration) || 0
  };
}

// One line in ffprobe's own terms, for the report.
export function probeLine(p) {
  return `${p.codec || '?'} (${p.profile || '?'}) ${p.width}x${p.height} ${p.fps} fps ${p.videoKbps == null ? '?' : p.videoKbps} kb/s; ${p.audioCodec || 'no audio'} ${p.audioKbps == null ? '?' : p.audioKbps} kb/s ${p.sampleRate} Hz ${p.channels === 2 ? 'stereo' : `${p.channels} ch`}; ${Math.round(p.durationS * 100) / 100} s`;
}

// The master spec held against a probe: [problem] (empty when it passes).
// `size` is the frame the master was meant to have (masterSizeFor).
export function checkMasterSpec(p, size) {
  const out = [];
  if (p.codec !== 'h264') out.push(`video is ${p.codec}, not H.264`);
  if (!/high/i.test(String(p.profile || ''))) out.push(`H.264 profile is ${p.profile}, not High`);
  if (p.width < size.width || p.height < size.height) out.push(`frame is ${p.width}x${p.height}, below ${size.width}x${size.height}`);
  if (Math.abs(p.fps - FPS) > 0.01) out.push(`frame rate is ${p.fps}, not ${FPS}`);
  // The floor of the frame the master should have (or has, if larger).
  const floor = minVideoKbps({ width: Math.max(p.width || 0, size.width), height: Math.max(p.height || 0, size.height) });
  if (!(p.videoKbps >= floor)) out.push(`video bitrate is ${p.videoKbps} kb/s, below ${floor} kb/s`);
  if (p.audioCodec !== 'aac') out.push(`audio is ${p.audioCodec || 'missing'}, not AAC`);
  if (!(p.audioKbps >= MASTER.audioKbps - 16)) out.push(`audio bitrate is ${p.audioKbps} kb/s, below ${MASTER.audioKbps} kb/s`);
  if (p.channels !== 2) out.push(`audio has ${p.channels} channel(s), not stereo`);
  return out;
}

export const FREEZE_MAX_S = 1;
export const SILENCE_MAX_S = 2;
export const SILENCE_NOISE_DB = -50;

// Spans ({ startS, endS, durationS }) from ffmpeg's freezedetect or
// silencedetect log. A span still open at the end runs to totalS.
export function parseDetectSpans(stderr, kind, totalS = null) {
  const s = String(stderr || '');
  const startRe = kind === 'freeze' ? /freeze_start:\s*([\d.]+)/g : /silence_start:\s*(-?[\d.]+)/g;
  const endRe = kind === 'freeze' ? /freeze_end:\s*([\d.]+)/g : /silence_end:\s*([\d.]+)/g;
  const starts = [...s.matchAll(startRe)].map((m) => Math.max(0, Number(m[1])));
  const ends = [...s.matchAll(endRe)].map((m) => Number(m[1]));
  return starts.map((startS, i) => {
    const endS = ends[i] != null ? ends[i] : totalS != null ? totalS : startS;
    return { startS: Math.round(startS * 1000) / 1000, endS: Math.round(endS * 1000) / 1000, durationS: Math.round((endS - startS) * 1000) / 1000 };
  });
}

// The detector's own log lines, for the report.
export function detectLines(spans, kind) {
  if (!spans.length) return [`no ${kind === 'freeze' ? 'freeze' : 'silence'} over ${kind === 'freeze' ? FREEZE_MAX_S : SILENCE_MAX_S} s`];
  return spans.map((sp) => `${kind}_start: ${sp.startS} | ${kind}_end: ${sp.endS} | ${kind}_duration: ${sp.durationS}`);
}

export async function detectFreezes(file, { totalS = null, minS = FREEZE_MAX_S } = {}) {
  const { stderr } = await ffmpeg(['-loglevel', 'info', '-i', file, '-map', '0:v:0', '-vf', `freezedetect=n=-60dB:d=${minS}`, '-f', 'null', '-']);
  return parseDetectSpans(stderr, 'freeze', totalS);
}

export async function detectSilences(file, { totalS = null, minS = SILENCE_MAX_S, noiseDb = SILENCE_NOISE_DB } = {}) {
  const { stderr } = await ffmpeg(['-loglevel', 'info', '-i', file, '-map', '0:a:0', '-af', `silencedetect=noise=${noiseDb}dB:d=${minS}`, '-f', 'null', '-']);
  return parseDetectSpans(stderr, 'silence', totalS);
}

// Spans not inside any allowed (scripted) span.
export function unscripted(spans, allowed = []) {
  return spans.filter((sp) => !allowed.some((a) => sp.startS >= a.startS - 0.05 && sp.endS <= a.endS + 0.05));
}

export const LOUDNESS_TOLERANCE_LU = 1;

// The whole gate on one delivered file. size: the frame it was meant to
// have; scripted: { freezes: [span], silences: [span] } that are meant to be
// there. Resolves to { pass, probe, probeLine, freezes, silences, loudness:
// { integrated, truePeak }, problems: [{ check, detail }] }.
export async function qcGate(file, { size, totalS = null, scripted = {}, deps = {} } = {}) {
  const d = { probe: probeMedia, freezes: detectFreezes, silences: detectSilences, loudness: measureLoudness, ...deps };
  const probe = await d.probe(file);
  const total = totalS || probe.durationS;
  const allFreezes = await d.freezes(file, { totalS: total });
  const allSilences = await d.silences(file, { totalS: total });
  const freezes = unscripted(allFreezes, scripted.freezes || []).filter((f) => f.durationS > FREEZE_MAX_S);
  const silences = unscripted(allSilences, scripted.silences || []).filter((f) => f.durationS > SILENCE_MAX_S);
  const m = await d.loudness(file);
  const loudness = { integrated: Number(m.input_i), truePeak: Number(m.input_tp), lra: Number(m.input_lra) };
  const problems = [
    ...checkMasterSpec(probe, size).map((detail) => ({ check: 'spec', detail })),
    ...freezes.map((f) => ({ check: 'freeze', detail: `held frame ${f.durationS} s at ${f.startS} s`, span: f })),
    ...silences.map((f) => ({ check: 'silence', detail: `silence ${f.durationS} s at ${f.startS} s`, span: f }))
  ];
  if (!(Math.abs(loudness.integrated - TARGET_LUFS) <= LOUDNESS_TOLERANCE_LU)) problems.push({ check: 'loudness', detail: `integrated loudness ${loudness.integrated} LUFS, target ${TARGET_LUFS}` });
  if (!(loudness.truePeak <= TARGET_TP + 0.05)) problems.push({ check: 'loudness', detail: `true peak ${loudness.truePeak} dBTP, above ${TARGET_TP}` });
  return {
    pass: !problems.length, probe, probeLine: probeLine(probe), freezes, silences, loudness, problems,
    freezeLines: detectLines(allFreezes, 'freeze'), silenceLines: detectLines(allSilences, 'silence')
  };
}

// A mix brought to the loudness target with its true peak held under the
// ceiling: two-pass loudnorm, then a limiter and one more pass when the
// true peak still comes out over it.
export async function masterLoudness(input, out) {
  const r = await normaliseLoudness(input, out);
  if (!r.after || Number(r.after.input_tp) <= TARGET_TP) return r;
  const limited = out.replace(/\.wav$/, '-lim.wav');
  await ffmpeg(['-loglevel', 'error', '-i', out, '-af', `alimiter=limit=${Math.pow(10, (TARGET_TP - 0.6) / 20).toFixed(4)}:level=false,aresample=48000`, '-c:a', 'pcm_s16le', limited]);
  const again = await normaliseLoudness(limited, out.replace(/\.wav$/, '-lim-norm.wav'));
  return { ...again, measured: r.measured };
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
