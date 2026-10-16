// PG1 Studio movies: the shot list, with coverage. Planned from the
// screenplay by rule (no engine call, nothing spent), so it is the same
// every time it is planned and can be priced before the shoot:
//
//   every scene   an establishing wide with a camera move
//   dialogue      over-the-shoulder and reverse shots as the speakers
//                 alternate, mediums, close-ups on key lines, and a reaction
//                 close-up on the listener after a key line; one line per
//                 shot, so each line is said on screen inside one take
//   action        cut on action: a long action is two shots, the second
//                 picking the movement up mid-way; real camera and subject
//                 motion
//   pacing        2–4 s average shot length; no static shot over STATIC_MAX_S
//                 (a longer shot always has a camera move)
//
// Each shot asks the picture engine for a clip a little longer than it
// will play (clipS), so the edit has handles for its J and L cuts and can
// fit every cut to the clip's real length without ever holding a frame.

import { allScenes, speechSeconds } from './screenplay.mjs';
import { NO_TEXT } from './bible.mjs';

export const STATIC_MAX_S = 4;
export const MIN_CLIP_S = 3;
export const MAX_CLIP_S = 8;
export const LINE_LEAD_S = 0.35;
export const LINE_TAIL_S = 0.35;
export const ESTABLISHING_S = 3;
export const ACTION_S = 3;
export const REACTION_S = 2;
const LONG_ACTION_WORDS = 16;

export const SHOT_SIZES = Object.freeze({
  wide: 'Wide establishing shot',
  medium: 'Medium shot',
  over_the_shoulder: 'Over-the-shoulder shot',
  reverse: 'Reverse over-the-shoulder shot',
  close_up: 'Close-up',
  reaction: 'Reaction close-up',
  insert: 'Insert detail shot',
  medium_wide: 'Medium-wide shot'
});

const MOVES = ['slow push in', 'slow dolly left', 'gentle crane down', 'slow dolly right', 'slow pull back'];
const r1 = (n) => Math.round(n * 10) / 10;
const clipFor = (playS) => Math.min(MAX_CLIP_S, Math.max(MIN_CLIP_S, Math.ceil(playS + 1)));

// The shot list for a screenplay: [shot], in screen order.
export function planShots(sp) {
  const shots = [];
  let moveN = 0;
  const nextMove = () => MOVES[moveN++ % MOVES.length];
  for (const scene of allScenes(sp)) {
    let n = 0;
    const sid = (tag) => `${scene.id}-${tag}${++n}`;
    const base = { sceneId: scene.id, act: scene.act, location: scene.location, needsText: scene.on_screen_text || null };
    shots.push({ ...base, id: sid('w'), kind: 'establishing', size: 'wide', camera: nextMove(), characters: [...scene.characters], durationS: ESTABLISHING_S, clipS: clipFor(ESTABLISHING_S), action: scene.elements.find((e) => e.type === 'action')?.text || null });
    let lastSpeaker = null;
    let lineN = 0;
    for (const e of scene.elements) {
      if (e.type === 'action') {
        const long = e.text.split(/\s+/).length > LONG_ACTION_WORDS;
        const first = { ...base, id: sid('a'), kind: 'action', size: long ? 'medium_wide' : 'medium', camera: e.motion === false ? 'subtle handheld' : 'tracking the movement', characters: [...scene.characters], durationS: ACTION_S, clipS: clipFor(ACTION_S + 0.5), action: e.text, sfx: e.sfx || null, motion: e.motion !== false };
        shots.push(first);
        if (long) shots.push({ ...first, id: sid('a'), size: 'close_up', camera: 'handheld, following the action', durationS: 2.5, clipS: clipFor(2.5), cutOnAction: true, sfx: null, action: `${e.text} (closer, picking the movement up mid-way)` });
        continue;
      }
      // Narration (only with --voice) is said off screen over the shot
      // before it.
      if (e.type === 'narration') { const last = shots[shots.length - 1]; last.narration = [...(last.narration || []), e.text]; continue; }
      if (e.type !== 'dialogue') continue;
      const others = scene.characters.filter((c) => c !== e.character);
      const listener = others[0] || null;
      const speech = speechSeconds(e.line);
      const play = r1(speech + LINE_LEAD_S + LINE_TAIL_S);
      let size;
      if (e.key) size = 'close_up';
      else if (!listener) size = lineN % 2 ? 'close_up' : 'medium';
      else if (lastSpeaker == null || lastSpeaker === e.character) size = lineN % 3 === 2 ? 'medium' : 'over_the_shoulder';
      else size = 'reverse';
      const camera = play > STATIC_MAX_S || e.key ? 'slow push in' : 'subtle handheld';
      shots.push({
        ...base, id: sid('d'), kind: 'dialogue', size, camera, characters: [...new Set([e.character, ...(size === 'over_the_shoulder' || size === 'reverse' ? [listener] : [])].filter(Boolean))],
        speaker: e.character, listener, line: e.line, parenthetical: e.parenthetical || null, key: !!e.key, speechS: speech, durationS: play, clipS: clipFor(play)
      });
      lastSpeaker = e.character;
      lineN++;
      if (e.key && listener) shots.push({ ...base, id: sid('r'), kind: 'reaction', size: 'reaction', camera: 'subtle handheld', characters: [listener], reactsTo: e.character, durationS: REACTION_S, clipS: clipFor(REACTION_S) });
    }
  }
  return shots;
}

// The numbers the shot list is held to.
export function shotListStats(shots) {
  const total = shots.reduce((s, x) => s + x.durationS, 0);
  const action = shots.filter((x) => x.kind !== 'dialogue');
  const staticLong = shots.filter((x) => /static|locked/.test(x.camera) && x.durationS > STATIC_MAX_S);
  return {
    shots: shots.length, seconds: r1(total), averageS: r1(total / Math.max(1, shots.length)),
    actionAverageS: r1(action.reduce((s, x) => s + x.durationS, 0) / Math.max(1, action.length)),
    dialogueShots: shots.filter((x) => x.kind === 'dialogue').length, staticOverMax: staticLong.length,
    clipSeconds: shots.reduce((s, x) => s + x.clipS, 0)
  };
}

const nameOf = (sp, cid) => (sp.characters.find((c) => c.id === cid) || {}).name || cid;

// The picture engine's prompt for one shot. The faces, hair and wardrobe
// come from the bible and its reference images; a dialogue shot names its
// one speaker and the exact line, so the speech is generated on screen with
// the lips in sync; every shot keeps the movie's one look.
export function shotPrompt(sp, bibles, shot, { avoid = [] } = {}) {
  const scene = allScenes(sp).find((s) => s.id === shot.sceneId);
  const loc = bibles.locations.find((l) => l.id === shot.location) || {};
  const cast = (shot.characters || []).map((cid) => bibles.characters.find((c) => c.id === cid)).filter(Boolean)
    .map((c) => `${c.name}: ${c.look}; wearing ${c.wardrobe}`);
  const parts = [
    `${SHOT_SIZES[shot.size] || 'Medium shot'}, ${shot.camera}. ${scene ? scene.slugline : ''}. ${loc.description || ''}`.trim(),
    cast.length ? `Characters (exactly as in the reference images; same face, hair and wardrobe): ${cast.join(' | ')}.` : 'No people in frame.'
  ];
  if (shot.kind === 'dialogue') {
    const who = nameOf(sp, shot.speaker);
    const frame = shot.size === 'over_the_shoulder' || shot.size === 'reverse' ? `framed over ${nameOf(sp, shot.listener)}'s shoulder, ${who} facing the camera` : `${who} facing the camera`;
    parts.push(`${frame}. ${who} says${shot.parenthetical ? ` (${shot.parenthetical})` : ''}: "${shot.line}"`);
    parts.push(`Only ${who} speaks, on screen, with the lips exactly in sync with the words; ${shot.listener ? `${nameOf(sp, shot.listener)} listens in silence` : 'nobody else speaks'}. Natural acting, small real movements.`);
  } else if (shot.kind === 'reaction') {
    parts.push(`${nameOf(sp, shot.characters[0])} listens to ${nameOf(sp, shot.reactsTo)} and reacts without speaking; a small, true reaction.`);
  } else if (shot.action) {
    parts.push(`${shot.action} Real movement: the subject moves and the camera follows.`);
  }
  parts.push('Sound: natural sound of the place only. No music, no narration, no subtitles.');
  parts.push(`Look: ${sp.look}. Cinematic, 16:9, 24 fps.`);
  parts.push(shot.needsText ? `The only readable text in frame is "${shot.needsText}", spelled exactly; no other signs, letters or text.` : NO_TEXT);
  if (avoid.length) parts.push(`Avoid: ${avoid.slice(0, 4).join('; ')}.`);
  return parts.join('\n');
}
