// PG1 Studio movies: the sound, with ffmpeg on the render worker.
//
// Three stems, each as long as the movie:
//   dialogue   every line, converted into its character's cast voice,
//              placed where its picture plays (with the J and L cuts), and
//              the narration when there is any
//   effects    each scene's ambience under the whole scene, plus a sound
//              effect on each action shot that has one
//   score      PG1 Sound's cue per scene, scored to the scene's length (the
//              last one runs under the credits)
// The mix ducks the score under the dialogue and is mastered to -14 LUFS
// integrated with the true peak under -1 dBTP (lib/film/ffmpeg.mjs
// masterLoudness). A bed or cue shorter than its span is played again from
// its start, so nothing falls silent before the picture ends.
//
// A take's line: its audio is converted with speech-to-speech
// (lib/movie/engines.mjs) and fitted back to the take's exact length
// (fitToLength), so the words land where the lips move.

import { run, probeDuration, parseDetectSpans, roomTone, AUDIO_METADATA } from '../film/ffmpeg.mjs';
import { speechFromSilences } from './qc.mjs';

const ffmpeg = (args, opts) => run('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], opts);
const fmt = (n) => (Math.round(n * 1000) / 1000).toFixed(3);
export const SR = 48000;
export const TIMING_TOLERANCE_S = 0.03;
const STEREO = `aresample=${SR},aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo`;

// The take's own audio, mono, for speech-to-speech.
export async function extractTakeAudio(clip, out, { sampleRate = 24000 } = {}) {
  await ffmpeg(['-loglevel', 'error', '-i', clip, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', ...AUDIO_METADATA, out]);
  return out;
}

// The tempo change that brings `fromS` of audio to `toS` (atempo takes
// 0.5–2 per stage), or null when it is already within the tolerance.
export function tempoFor(fromS, toS) {
  if (!(fromS > 0) || !(toS > 0) || Math.abs(fromS - toS) <= TIMING_TOLERANCE_S) return null;
  return Math.min(2, Math.max(0.5, fromS / toS));
}

// A converted line fitted to the take's exact length. Resolves to { file,
// sourceS, convertedS, durationS, tempo }.
export async function fitToLength(input, targetS, out) {
  const convertedS = await probeDuration(input);
  const tempo = tempoFor(convertedS, targetS);
  const af = [...(tempo ? [`atempo=${tempo.toFixed(5)}`] : []), `apad=whole_dur=${fmt(targetS)}`, `atrim=0:${fmt(targetS)}`].join(',');
  await ffmpeg(['-loglevel', 'error', '-i', input, '-af', af, '-c:a', 'pcm_s16le', ...AUDIO_METADATA, out]);
  return { file: out, sourceS: targetS, convertedS, durationS: await probeDuration(out), tempo };
}

// Where the speech is in a converted line ({ startS, endS } or null).
export async function speechSpan(file, durationS = null) {
  const d = durationS || await probeDuration(file);
  const { stderr } = await ffmpeg(['-loglevel', 'info', '-i', file, '-af', 'silencedetect=noise=-35dB:d=0.2', '-f', 'null', '-']);
  return speechFromSilences(parseDetectSpans(stderr, 'silence', d), d);
}

// One stem's filtergraph. entries: [{ file | lavfi, atS, durationS,
// srcInS?, bedS?, loop?, volume?, fadeS? }]: a clip is cut from srcInS; a
// bed (loop: true) is played again from its start when it is shorter than
// its span. Every entry is placed at atS; the stem is exactly totalS long.
export function stemFilter(entries, totalS) {
  const parts = [];
  entries.forEach((e, i) => {
    const len = Math.max(0.05, e.durationS);
    const bed = Number(e.bedS) > 0 ? Number(e.bedS) : Infinity;
    const loop = e.loop && bed < len - 0.05 ? `aloop=loop=${Math.ceil(len / bed)}:size=${Math.round(bed * SR)},` : '';
    const from = Number(e.srcInS) > 0 ? Number(e.srcInS) : 0;
    const fade = Math.min(e.fadeS != null ? e.fadeS : 0.05, len / 3);
    parts.push(`[${i}:a]${STEREO},${loop}atrim=${fmt(from)}:${fmt(from + len)},asetpts=N/SR/TB,afade=t=in:d=${fmt(fade)},afade=t=out:st=${fmt(len - fade)}:d=${fmt(fade)},volume=${e.volume != null ? e.volume : 1},adelay=delays=${Math.max(0, Math.round(e.atS * 1000))}:all=1[e${i}]`);
  });
  // Timestamps from 0 first: amix starts its output at the earliest cue,
  // and apad would then stop short of the runtime.
  const end = `asetpts=N/SR/TB,apad=whole_dur=${fmt(totalS)},atrim=0:${fmt(totalS)}`;
  if (entries.length === 1) parts.push(`[e0]${end}[aout]`);
  else parts.push(`${entries.map((_, i) => `[e${i}]`).join('')}amix=inputs=${entries.length}:normalize=0:duration=longest,${end}[aout]`);
  return parts.join(';');
}

export async function renderStem(entries, totalS, out) {
  if (!entries.length) {
    await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=${SR}:cl=stereo`, '-t', fmt(totalS), '-c:a', 'pcm_s16le', ...AUDIO_METADATA, out]);
    return out;
  }
  const inputs = entries.flatMap((e) => (e.lavfi ? ['-f', 'lavfi', '-i', e.lavfi] : ['-i', e.file]));
  await ffmpeg(['-loglevel', 'error', ...inputs, '-filter_complex', stemFilter(entries, totalS), '-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', String(SR), ...AUDIO_METADATA, out]);
  return out;
}

// The three stems mixed: the score ducked under the dialogue.
export const MIX_FILTER = '[0:a]asplit=2[dlg][dsc];[2:a][dsc]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350:makeup=1[duck];[dlg][1:a][duck]amix=inputs=3:normalize=0:duration=longest[aout]';
export async function mixStems({ dialogue, effects, score, out }) {
  await ffmpeg(['-loglevel', 'error', '-i', dialogue, '-i', effects, '-i', score, '-filter_complex', MIX_FILTER, '-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', String(SR), ...AUDIO_METADATA, out]);
  return out;
}

// The stems' entries from the edit plan and the files on the worker.
//   files: { dialogue: { shotId: file }, narration: [{ file, durationS }],
//            ambience: { sceneId: { file, durationS } },
//            effects: { shotId: { file, durationS } },
//            score: { sceneId: { file, durationS } } }
// fix.roomTone: room tone under the effects stem (the QC gate's fix for a
// silence). A scene whose score cue could not be made is covered by its
// neighbour's cue; one whose ambience could not be made gets room tone.
export function stemEntries(plan, files, { roomTone: withTone = false } = {}) {
  const dialogue = [
    ...plan.dialogue.filter((c) => files.dialogue[c.shotId]).map((c) => ({ file: files.dialogue[c.shotId], srcInS: c.srcInS, atS: c.atS, durationS: c.durationS, fadeS: 0.06 })),
    ...plan.narration.map((n, i) => ({ ...files.narration[i], atS: n.atS, fadeS: 0.05 })).filter((n) => n.file)
  ];
  const effects = [];
  let missingAmbience = false;
  for (const sc of plan.scenes) {
    const a = files.ambience[sc.sceneId];
    if (a) effects.push({ file: a.file, atS: sc.startS, durationS: sc.endS - sc.startS, bedS: a.durationS, loop: true, volume: 0.6, fadeS: 0.4 });
    else missingAmbience = true;
  }
  for (const fx of plan.effects) { const f = files.effects[fx.shotId]; if (f) effects.push({ file: f.file, atS: fx.atS, durationS: Math.min(fx.durationS, f.durationS || fx.durationS), volume: 0.8, fadeS: 0.1 }); }
  if (missingAmbience || withTone) effects.push(roomTone(plan.totalS));
  const score = [];
  const have = plan.scenes.filter((sc) => files.score[sc.sceneId]).map((sc) => ({ ...sc }));
  for (const sc of plan.scenes) {
    if (files.score[sc.sceneId]) continue;
    // The nearest scene with a cue (before it, else after) plays on over it.
    const near = [...have].reverse().find((h) => h.startS < sc.startS) || have[0];
    if (near) { near.endS = Math.max(near.endS, sc.endS); near.startS = Math.min(near.startS, sc.startS); }
  }
  for (const sc of have) {
    const c = files.score[sc.sceneId];
    score.push({ file: c.file, atS: sc.startS, durationS: sc.endS - sc.startS, bedS: c.durationS, loop: true, volume: 0.5, fadeS: 1 });
  }
  return { dialogue, effects, score };
}
