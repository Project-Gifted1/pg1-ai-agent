// PG1 Studio edit decisions: where every shot starts and ends on the final
// timeline, cut to the narration and the music's beat.
//
//  - A shot runs its storyboard length, or longer when its voiceover line
//    needs it (the line plus a breath either side), within 3–10 s.
//  - The cut is then moved to the nearest beat of the scene's tempo when
//    that is within BEAT_SNAP_S and still leaves the line room.
//  - Each clip is trimmed to its best moment: the shot's fixed trim_in_s,
//    or the start the shot check picked (bestStartS), kept inside the clip.
//  - Transitions overlap the shots either side (ffmpeg xfade), so a shot's
//    start is the previous start plus its length minus the overlap.
//  - Voiceover lines start just after their shot's transition settles and
//    never on top of the line before; captions come from the voice's word
//    timestamps, so they land on the words.

import { flatShots, MIN_SHOT_S, MAX_SHOT_S } from './storyboard.mjs';

export const TRANSITION_S = 0.6;
export const CARD_FADE_S = 0.5;
export const BEAT_SNAP_S = 0.35;
export const VO_LEAD_S = 0.25;
export const VO_TAIL_S = 0.35;
export const VO_GAP_S = 0.15;
export const CAPTION_MAX_WORDS = 7;
export const CAPTION_MAX_CHARS = 38;
export const SCENE_TITLE_S = 2.5;

const r3 = (n) => Math.round(n * 1000) / 1000;

export function snapToBeat(seconds, bpm, { minS = MIN_SHOT_S, maxS = MAX_SHOT_S, floorS = 0 } = {}) {
  if (!(bpm > 0)) return seconds;
  const beat = 60 / bpm;
  const candidates = [Math.floor(seconds / beat) * beat, Math.ceil(seconds / beat) * beat];
  let best = seconds;
  let bestDelta = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - seconds);
    if (d <= BEAT_SNAP_S && c >= Math.max(minS, floorS) && c <= maxS && d < bestDelta) { best = c; bestDelta = d; }
  }
  return r3(best);
}

// Caption lines from word timestamps (seconds, relative to the line's own
// start), offset by `atS`. Falls back to spreading the text evenly when the
// voice returned no timestamps.
export function captionChunks(words, { atS = 0, text = '', durationS = 0 } = {}) {
  let ws = Array.isArray(words) && words.length ? words : null;
  if (!ws) {
    const parts = String(text || '').split(/\s+/).filter(Boolean);
    const step = parts.length ? Math.max(0.2, durationS / parts.length) : 0;
    ws = parts.map((w, i) => ({ word: w, start: i * step, end: (i + 1) * step }));
  }
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ startS: r3(atS + cur[0].start), endS: r3(atS + cur[cur.length - 1].end + 0.15), text: cur.map((w) => w.word).join(' ') });
    cur = [];
  };
  for (const w of ws) {
    const next = [...cur, w];
    if (cur.length && (next.length > CAPTION_MAX_WORDS || next.map((x) => x.word).join(' ').length > CAPTION_MAX_CHARS)) flush();
    cur.push(w);
    if (/[.!?;:]$/.test(w.word)) flush();
  }
  flush();
  for (let i = 0; i < out.length - 1; i++) if (out[i].endS > out[i + 1].startS) out[i].endS = out[i + 1].startS;
  return out;
}

// voice: { shotId: { durationS, words } } (lines recorded so far)
// clips: { shotId: { durationS, bestStartS } } (full render) or null for
//        the preview, where every shot is a still with a camera move.
// Resolves to the plan the assembler renders.
export function planCuts(timeline, { voice = {}, clips = null } = {}) {
  const segments = [];
  const joins = [];
  if (timeline.title_card) segments.push({ kind: 'card', text: timeline.title_card.text, durationS: timeline.title_card.duration_s });

  const shots = flatShots(timeline);
  shots.forEach(({ scene, sceneIndex, shot, shotIndex }, i) => {
    const vo = voice[shot.id];
    const need = vo && vo.durationS ? vo.durationS + VO_LEAD_S + VO_TAIL_S : 0;
    let dur = Math.min(MAX_SHOT_S, Math.max(MIN_SHOT_S, shot.duration_s, need));
    dur = snapToBeat(dur, scene.music.bpm, { floorS: Math.min(need, MAX_SHOT_S) });
    let inS = 0;
    let clipS = null;
    if (clips) {
      const c = clips[shot.id] || {};
      clipS = Number(c.durationS) || dur;
      inS = shot.trim_in_s != null ? shot.trim_in_s : Number(c.bestStartS) || 0;
      inS = r3(Math.max(0, Math.min(inS, clipS - Math.min(dur, clipS))));
    }
    if (segments.length) {
      const prev = segments[segments.length - 1];
      const transition = prev.kind === 'card' ? 'fade_black' : prev.transition;
      joins.push({ transition, durationS: transition === 'cut' ? 0 : prev.kind === 'card' ? CARD_FADE_S : TRANSITION_S });
    }
    segments.push({
      kind: 'shot', shotId: shot.id, scene: sceneIndex, shot: shotIndex, sceneId: scene.id, camera: shot.camera,
      durationS: r3(dur), inS, clipS, transition: i === shots.length - 1 ? 'cut' : shot.transition,
      sceneTitle: shotIndex === 1 && scene.title_card && scene.title ? scene.title : null
    });
  });
  if (timeline.end_card) {
    joins.push({ transition: 'fade_black', durationS: CARD_FADE_S });
    segments.push({ kind: 'card', text: timeline.end_card.text, durationS: timeline.end_card.duration_s });
  }

  // Where each segment starts once the transitions overlap.
  let t = 0;
  segments.forEach((s, i) => {
    if (i > 0) t = t + segments[i - 1].durationS - joins[i - 1].durationS;
    s.startS = r3(t);
  });
  const last = segments[segments.length - 1];
  const totalS = r3(last.startS + last.durationS);

  const voiceCues = [];
  const captions = [];
  const titles = [];
  let prevVoEnd = 0;
  segments.forEach((s, i) => {
    if (s.kind === 'card') {
      titles.push({ startS: s.startS, endS: r3(s.startS + s.durationS), text: s.text, style: 'Card' });
      return;
    }
    const shot = shots.find((x) => x.shot.id === s.shotId).shot;
    if (s.sceneTitle) titles.push({ startS: r3(s.startS + 0.3), endS: r3(s.startS + 0.3 + SCENE_TITLE_S), text: s.sceneTitle, style: 'Title' });
    const vo = voice[s.shotId];
    const inOverlap = i > 0 ? joins[i - 1].durationS : 0;
    if (vo && vo.durationS) {
      const atS = r3(Math.max(s.startS + inOverlap * 0.5 + VO_LEAD_S, prevVoEnd + VO_GAP_S));
      voiceCues.push({ shotId: s.shotId, atS, durationS: vo.durationS });
      prevVoEnd = atS + vo.durationS;
      if (timeline.captions.enabled) {
        if (shot.caption) captions.push({ startS: atS, endS: r3(atS + vo.durationS), text: shot.caption });
        else captions.push(...captionChunks(vo.words, { atS, text: shot.voiceover, durationS: vo.durationS }));
      }
    } else if (timeline.captions.enabled && shot.caption) {
      captions.push({ startS: r3(s.startS + inOverlap), endS: r3(s.startS + s.durationS), text: shot.caption });
    }
  });

  // One music bed per scene, from the scene's first shot (the title card
  // belongs to the first scene, the end card to the last) to its last.
  const music = [];
  for (const scene of timeline.scenes) {
    const segs = segments.filter((s) => s.sceneId === scene.id);
    if (!segs.length) continue;
    const first = segments.indexOf(segs[0]);
    const lastSeg = segs[segs.length - 1];
    const startS = first === 1 && segments[0].kind === 'card' ? 0 : segs[0].startS;
    let endS = lastSeg.startS + lastSeg.durationS;
    if (scene === timeline.scenes[timeline.scenes.length - 1]) endS = totalS;
    music.push({ sceneId: scene.id, startS: r3(startS), endS: r3(endS) });
  }

  return { segments, joins, totalS, voice: voiceCues, captions, titles, music };
}
