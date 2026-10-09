// PG1 Studio timeline edits and what they make stale.
//
// PG1 edits a film by changing its timeline JSON, never the rendered file:
// applyTimelineEdits() takes a list of edit operations, checks every one
// and returns the new timeline (normalised again) and a line per change for
// the approval card. Nothing is stored until the operator approves.
//
// Fingerprints. assetFingerprints() gives every asset a film needs a short
// hash of exactly the inputs that make it: a keyframe its prompt and the
// shared reference, a clip its keyframe (or, for a continuous shot, the
// previous clip) and its prompt and length, a voice line its words, a music
// bed its mood. A render reuses any stored asset whose fingerprint still
// matches, so after an edit only the changed assets (and the ones that
// depend on them) are generated again; the edit itself (cuts, order,
// transitions, captions, cards) costs only the re-assembly.

import crypto from 'node:crypto';
import { normaliseTimeline, flatShots, estimateSpeechSeconds, CAMERA_MOVES, TRANSITIONS, GRADES, MIN_SHOT_S, MAX_SHOT_S } from './storyboard.mjs';

export const EDIT_OPS = Object.freeze([
  'trim', 'move', 'reorder', 'replace_shot', 'remove_shot', 'add_shot', 'set_voiceover', 'set_caption', 'captions',
  'set_music', 'set_transition', 'set_camera', 'set_title_card', 'set_end_card', 'set_grade'
]);
export const MAX_EDIT_OPS = 20;

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// A shot reference: its id ("s3-sh2"), "3.2" (scene 3, shot 2), or
// { scene: 3, shot: 2 }. Resolves to { sceneIdx, shotIdx } (0-based) or
// throws.
export function resolveShot(timeline, ref) {
  if (ref && typeof ref === 'object' && ref.scene != null) return resolveShot(timeline, `${ref.scene}.${ref.shot}`);
  const r = String(ref == null ? '' : ref).trim();
  const m = /^(\d{1,2})\.(\d{1,2})$/.exec(r);
  if (m) {
    const si = Number(m[1]) - 1;
    const hi = Number(m[2]) - 1;
    if (timeline.scenes[si] && timeline.scenes[si].shots[hi]) return { sceneIdx: si, shotIdx: hi };
    throw new Error(`there is no shot ${r}`);
  }
  for (let si = 0; si < timeline.scenes.length; si++) {
    const hi = timeline.scenes[si].shots.findIndex((s) => s.id === r);
    if (hi >= 0) return { sceneIdx: si, shotIdx: hi };
  }
  throw new Error(`there is no shot "${r.slice(0, 40)}"`);
}

export function resolveScene(timeline, ref) {
  const r = String(ref == null ? '' : ref).trim();
  if (/^\d{1,2}$/.test(r)) {
    const si = Number(r) - 1;
    if (timeline.scenes[si]) return si;
  } else {
    const si = timeline.scenes.findIndex((s) => s.id === r);
    if (si >= 0) return si;
  }
  throw new Error(`there is no scene "${r.slice(0, 40)}"`);
}

const label = (si, hi) => `${si + 1}.${hi + 1}`;

// Applies `ops` in order. Resolves to { timeline, changes: [string] } or
// throws an Error naming the op that could not be applied.
export function applyTimelineEdits(timeline, ops) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('no changes were given');
  if (ops.length > MAX_EDIT_OPS) throw new Error(`at most ${MAX_EDIT_OPS} changes at once`);
  const t = clone(timeline);
  const changes = [];
  ops.forEach((op, i) => {
    const kind = op && op.op;
    if (!EDIT_OPS.includes(kind)) throw new Error(`change ${i + 1}: unknown change "${String(kind).slice(0, 30)}"`);
    try {
      switch (kind) {
        case 'trim': {
          const { sceneIdx, shotIdx } = resolveShot(t, op.shot);
          const sh = t.scenes[sceneIdx].shots[shotIdx];
          if (op.duration_s != null) {
            const d = Number(op.duration_s);
            if (!(d >= MIN_SHOT_S && d <= MAX_SHOT_S)) throw new Error(`a shot is ${MIN_SHOT_S}–${MAX_SHOT_S} s`);
            changes.push(`Shot ${label(sceneIdx, shotIdx)} (${sh.description}): ${sh.duration_s} s → ${d} s`);
            sh.duration_s = d;
          }
          if (op.trim_in_s !== undefined) {
            sh.trim_in_s = op.trim_in_s == null ? null : Math.max(0, Number(op.trim_in_s) || 0);
            changes.push(`Shot ${label(sceneIdx, shotIdx)}: ${sh.trim_in_s == null ? 'starts at its best moment' : `starts ${sh.trim_in_s} s into the clip`}`);
          }
          if (op.duration_s == null && op.trim_in_s === undefined) throw new Error('give duration_s or trim_in_s');
          break;
        }
        case 'move': {
          const { sceneIdx, shotIdx } = resolveShot(t, op.shot);
          const [sh] = t.scenes[sceneIdx].shots.splice(shotIdx, 1);
          const toScene = op.to_scene != null ? resolveScene(t, op.to_scene) : sceneIdx;
          const list = t.scenes[toScene].shots;
          const at = Math.max(0, Math.min(list.length, (Number(op.to_index) || 1) - 1));
          list.splice(at, 0, sh);
          sh.continuous = false;
          changes.push(`Moved "${sh.description}" to scene ${toScene + 1}, position ${at + 1}`);
          break;
        }
        case 'reorder': {
          const si = resolveScene(t, op.scene);
          const ids = Array.isArray(op.shots) ? op.shots.map(String) : [];
          const shots = t.scenes[si].shots;
          if (ids.length !== shots.length || !ids.every((id) => shots.some((s) => s.id === id))) throw new Error('list every shot of the scene once');
          t.scenes[si].shots = ids.map((id) => shots.find((s) => s.id === id));
          t.scenes[si].shots.forEach((s, k) => { if (k === 0 || s.id !== shots[k].id) s.continuous = false; });
          changes.push(`Scene ${si + 1}: new shot order ${t.scenes[si].shots.map((s) => s.description).join(' → ')}`);
          break;
        }
        case 'replace_shot': {
          const { sceneIdx, shotIdx } = resolveShot(t, op.shot);
          const sh = t.scenes[sceneIdx].shots[shotIdx];
          if (!op.visual_prompt) throw new Error('give the new visual_prompt');
          sh.visual_prompt = String(op.visual_prompt);
          if (op.description) sh.description = String(op.description);
          if (op.camera) sh.camera = String(op.camera);
          if (op.continuous === false) sh.continuous = false;
          changes.push(`Shot ${label(sceneIdx, shotIdx)} replaced: ${sh.description}`);
          break;
        }
        case 'remove_shot': {
          const { sceneIdx, shotIdx } = resolveShot(t, op.shot);
          const shots = t.scenes[sceneIdx].shots;
          const [sh] = shots.splice(shotIdx, 1);
          if (shots[shotIdx]) shots[shotIdx].continuous = false;
          if (!shots.length) t.scenes.splice(sceneIdx, 1);
          changes.push(`Removed shot ${label(sceneIdx, shotIdx)} (${sh.description})`);
          break;
        }
        case 'add_shot': {
          const si = resolveScene(t, op.scene);
          const sh = op.shot && typeof op.shot === 'object' ? op.shot : null;
          if (!sh || !sh.visual_prompt) throw new Error('give the new shot with a visual_prompt');
          const shots = t.scenes[si].shots;
          let at = shots.length;
          if (op.after != null) at = resolveShot(t, op.after).shotIdx + 1;
          shots.splice(at, 0, { id: sh.id || `${t.scenes[si].id}-new${Date.now() % 100000}`, duration_s: 6, transition: 'cut', ...sh, continuous: false });
          changes.push(`Added a shot to scene ${si + 1}: ${sh.description || String(sh.visual_prompt).slice(0, 60)}`);
          break;
        }
        case 'set_voiceover': {
          const { sceneIdx, shotIdx } = resolveShot(t, op.shot);
          const sh = t.scenes[sceneIdx].shots[shotIdx];
          sh.voiceover = String(op.text || '');
          changes.push(`Shot ${label(sceneIdx, shotIdx)} voiceover: ${sh.voiceover ? `"${sh.voiceover}"` : 'none'}`);
          break;
        }
        case 'set_caption': {
          const { sceneIdx, shotIdx } = resolveShot(t, op.shot);
          t.scenes[sceneIdx].shots[shotIdx].caption = op.text == null ? null : String(op.text);
          changes.push(`Shot ${label(sceneIdx, shotIdx)} caption: ${op.text == null ? 'from the voiceover' : `"${op.text}"`}`);
          break;
        }
        case 'captions': {
          t.captions = { enabled: op.enabled !== false };
          changes.push(`Captions ${t.captions.enabled ? 'on' : 'off'}`);
          break;
        }
        case 'set_music': {
          const si = resolveScene(t, op.scene);
          const m = t.scenes[si].music;
          if (op.mood) m.mood = String(op.mood);
          if (op.bpm != null) m.bpm = Number(op.bpm);
          changes.push(`Scene ${si + 1} music: ${m.mood} (${m.bpm} bpm)`);
          break;
        }
        case 'set_transition': {
          const { sceneIdx, shotIdx } = resolveShot(t, op.shot);
          if (!TRANSITIONS.includes(op.transition)) throw new Error(`transition is one of ${TRANSITIONS.join(', ')}`);
          t.scenes[sceneIdx].shots[shotIdx].transition = op.transition;
          changes.push(`After shot ${label(sceneIdx, shotIdx)}: ${op.transition.replace(/_/g, ' ')}`);
          break;
        }
        case 'set_camera': {
          const { sceneIdx, shotIdx } = resolveShot(t, op.shot);
          if (!CAMERA_MOVES.includes(op.camera)) throw new Error(`camera is one of ${CAMERA_MOVES.join(', ')}`);
          t.scenes[sceneIdx].shots[shotIdx].camera = op.camera;
          changes.push(`Shot ${label(sceneIdx, shotIdx)} camera: ${op.camera.replace(/_/g, ' ')}`);
          break;
        }
        case 'set_title_card':
        case 'set_end_card': {
          const key = kind === 'set_title_card' ? 'title_card' : 'end_card';
          t[key] = op.text ? { text: String(op.text), duration_s: op.duration_s || 3 } : null;
          changes.push(`${key === 'title_card' ? 'Title' : 'End'} card: ${op.text ? `"${op.text}"` : 'none'}`);
          break;
        }
        case 'set_grade': {
          if (!GRADES.includes(op.grade)) throw new Error(`grade is one of ${GRADES.join(', ')}`);
          t.style.grade = op.grade;
          changes.push(`Colour grade: ${op.grade.replace(/_/g, ' ')}`);
          break;
        }
        default:
          break;
      }
    } catch (e) {
      throw new Error(`change ${i + 1} (${kind}): ${e.message}`);
    }
  });
  return { timeline: normaliseTimeline(t), changes };
}

// --- fingerprints ---------------------------------------------------------------

export function hash(...parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

// The clip length a shot asks the video engine for: 5 or 10 s, long enough
// for the shot (and its voiceover line).
export function clipSecondsFor(shot) {
  const need = Math.max(shot.duration_s, estimateSpeechSeconds(shot.voiceover) + 0.4) + (shot.trim_in_s || 0);
  return need <= 5 ? 5 : 10;
}

// { reference, keyframes: {shotId: fp}, clips: {shotId: fp},
//   voice: {shotId: fp}, music: {sceneId: fp} }. `voiceKey` names the voice
// (the voice id and model), so a new voice re-records every line.
export function assetFingerprints(timeline, { voiceKey = '' } = {}) {
  const chars = timeline.characters.map((c) => [c.id, c.name, c.description]);
  const reference = hash('ref', timeline.style.look, timeline.style.reference_prompt, chars);
  const keyframes = {};
  const clips = {};
  const voice = {};
  const music = {};
  let prevClip = null;
  for (const { scene, shot } of flatShots(timeline)) {
    keyframes[shot.id] = hash('key', reference, shot.visual_prompt, shot.characters, timeline.style.look);
    const start = shot.continuous && prevClip ? ['after', prevClip] : ['key', keyframes[shot.id]];
    // "<what the clip shows>.<its length>": a stored 10 s clip also serves
    // a shot that now needs only 5 s (clipFingerprints), so trimming a shot
    // never regenerates it.
    const identity = hash('clip', start, shot.visual_prompt, shot.camera, timeline.tier);
    clips[shot.id] = `${identity}.${clipSecondsFor(shot)}`;
    if (shot.voiceover) voice[shot.id] = hash('vo', shot.voiceover, voiceKey);
    prevClip = identity;
    if (!music[scene.id]) music[scene.id] = hash('music', scene.music.mood, scene.music.bpm);
  }
  return { reference, keyframes, clips, voice, music };
}

// The stored clip fingerprints that satisfy `fp`: itself, and for a 5 s
// need the same clip at 10 s.
export function clipFingerprints(fp) {
  const [identity, seconds] = String(fp).split('.');
  return seconds === '5' ? [fp, `${identity}.10`] : [fp];
}

// What a render would have to generate, given the fingerprints already
// stored (a Set of "kind:fp"). { reference: bool, keyframes: [shotId],
// clips: [shotId], voice: [shotId], music: [sceneId] }.
// `stage` 'preview' needs stills, voice and music; 'full' needs clips too
// (and the stills only for shots that do not start from the previous clip).
export function missingAssets(timeline, stored, { stage = 'full', voiceKey = '' } = {}) {
  const fp = assetFingerprints(timeline, { voiceKey });
  const has = (kind, f) => stored.has(`${kind}:${f}`);
  const shots = flatShots(timeline);
  const out = { reference: !has('reference', fp.reference), keyframes: [], clips: [], voice: [], music: [] };
  for (const { shot, shotIndex } of shots) {
    const needsStill = stage === 'preview' || !(shot.continuous && shotIndex > 1);
    if (needsStill && !has('keyframe', fp.keyframes[shot.id])) out.keyframes.push(shot.id);
    if (stage === 'full' && !clipFingerprints(fp.clips[shot.id]).some((f) => has('clip', f))) out.clips.push(shot.id);
    if (fp.voice[shot.id] && !has('voice', fp.voice[shot.id])) out.voice.push(shot.id);
  }
  for (const [sceneId, f] of Object.entries(fp.music)) if (!has('music', f)) out.music.push(sceneId);
  // A reference is only needed when some still is.
  if (!out.keyframes.length) out.reference = false;
  return out;
}
