// PG1 Studio storyboard: the timeline JSON a film is made from, the
// instructions that ask for it, and the checks every timeline passes before
// anything is generated or rendered (normaliseTimeline).
//
// Timeline shape (every field is checked; anything unknown is dropped):
// {
//   version: 1,
//   title: "Harbour at Dawn",
//   logline: "…",
//   tier: "standard",                       // draft | standard | pro
//   style: { look: "…", grade: "teal_orange", reference_prompt: "…" },
//   characters: [{ id: "c1", name: "Mara", description: "…" }],
//   captions: { enabled: true },
//   title_card: { text: "Harbour at Dawn", duration_s: 3 } | null,
//   end_card: { text: "…", duration_s: 3 } | null,
//   scenes: [{
//     id: "s1", title: "The quay", title_card: false,
//     music: { mood: "warm ambient, slow strings", bpm: 80 },
//     shots: [{
//       id: "s1-sh1", duration_s: 6, camera: "drone_flyover",
//       description: "drone shot over the harbour at dawn",   // what PG1 calls it
//       visual_prompt: "…", voiceover: "…" | "",
//       continuous: false,       // starts from the previous shot's last frame
//       transition: "dissolve",  // into the NEXT shot
//       trim_in_s: null,         // a fixed start in the clip; null = best moment
//       characters: ["c1"]
//     }]
//   }]
// }

import { UPSTREAM_BRAND_RE } from '../upstreamFailure.mjs';

export const TIMELINE_VERSION = 1;
export const MIN_SHOT_S = 3;
export const MAX_SHOT_S = 10;
export const TARGET_FILM_S = 60;
export const MAX_SCENES = 12;
export const MAX_SHOTS = 30;
export const MAX_CHARACTERS = 6;

export const CAMERA_MOVES = Object.freeze([
  'static', 'push_in', 'pull_out', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down',
  'tracking', 'orbit', 'drone_flyover', 'handheld', 'crane_up', 'dolly_zoom'
]);
// "cut" is a hard cut; the rest are ffmpeg xfade transitions.
export const TRANSITIONS = Object.freeze(['cut', 'dissolve', 'fade_black', 'fade_white', 'wipe_left', 'wipe_right', 'slide_left', 'slide_right', 'zoom_in']);
export const GRADES = Object.freeze(['neutral', 'teal_orange', 'warm', 'cool', 'noir', 'bleach_bypass', 'vintage']);

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function str(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function pick(v, allowed, fallback) {
  const s = String(v || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  return allowed.includes(s) ? s : fallback;
}

// Text the viewer sees or hears (titles, captions, voiceover) never names a
// model, an AI company or an engine. Such a name is taken out.
export function cleanVisibleText(text, max = 400) {
  let t = str(text, max);
  const re = new RegExp(UPSTREAM_BRAND_RE.source, 'gi');
  t = t.replace(re, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
  return t;
}

export function hasBrandedText(text) {
  return UPSTREAM_BRAND_RE.test(String(text || ''));
}

// Words a voiceover line takes to say, at about 2.6 words a second.
export function estimateSpeechSeconds(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return words ? Math.round((words / 2.6 + 0.3) * 10) / 10 : 0;
}

// The timeline checked and put in order. Throws an Error with a plain
// message (for the operator) when nothing usable is left. `warnings`
// collects what was changed.
export function normaliseTimeline(raw, { warnings = [] } = {}) {
  const t = raw && typeof raw === 'object' ? raw : null;
  if (!t || !Array.isArray(t.scenes) || !t.scenes.length) throw new Error('the storyboard has no scenes');
  const tier = ['draft', 'standard', 'pro'].includes(t.tier) ? t.tier : 'standard';
  const style = t.style && typeof t.style === 'object' ? t.style : {};
  const characters = (Array.isArray(t.characters) ? t.characters : []).slice(0, MAX_CHARACTERS).map((c, i) => ({
    id: ID_RE.test(String(c && c.id || '')) ? String(c.id) : `c${i + 1}`,
    name: cleanVisibleText(c && c.name, 60),
    description: str(c && c.description, 600)
  })).filter((c) => c.description || c.name);
  const charIds = new Set(characters.map((c) => c.id));

  const usedIds = new Set();
  const uniqueId = (wanted, fallback) => {
    let id = ID_RE.test(String(wanted || '')) ? String(wanted) : fallback;
    while (usedIds.has(id)) id = `${id}x`;
    usedIds.add(id);
    return id;
  };

  let shotCount = 0;
  const scenes = [];
  for (const [si, sc] of t.scenes.slice(0, MAX_SCENES).entries()) {
    if (!sc || !Array.isArray(sc.shots)) continue;
    const sceneId = uniqueId(sc.id, `s${si + 1}`);
    const shots = [];
    for (const [hi, sh] of sc.shots.entries()) {
      if (shotCount >= MAX_SHOTS) { warnings.push(`only the first ${MAX_SHOTS} shots were kept`); break; }
      if (!sh || typeof sh !== 'object') continue;
      const visual = str(sh.visual_prompt, 1500);
      if (!visual) { warnings.push(`a shot in scene ${si + 1} had no visual prompt and was dropped`); continue; }
      const rawDur = Number(sh.duration_s);
      const duration = clampNum(rawDur, MIN_SHOT_S, MAX_SHOT_S, 6);
      if (Number.isFinite(rawDur) && rawDur !== duration) warnings.push(`shot ${si + 1}.${hi + 1} was ${rawDur} s, set to ${duration} s (shots are ${MIN_SHOT_S}–${MAX_SHOT_S} s)`);
      const trimIn = sh.trim_in_s == null || sh.trim_in_s === '' ? null : clampNum(sh.trim_in_s, 0, MAX_SHOT_S, null);
      shots.push({
        id: uniqueId(sh.id, `${sceneId}-sh${hi + 1}`),
        duration_s: Math.round(duration * 10) / 10,
        camera: pick(sh.camera, CAMERA_MOVES, 'static'),
        description: str(sh.description, 200) || visual.slice(0, 120),
        visual_prompt: visual,
        voiceover: cleanVisibleText(sh.voiceover, 400),
        caption: sh.caption == null ? null : cleanVisibleText(sh.caption, 200),
        continuous: shots.length > 0 && sh.continuous === true,
        transition: pick(sh.transition, TRANSITIONS, 'cut'),
        trim_in_s: trimIn,
        characters: (Array.isArray(sh.characters) ? sh.characters : []).map(String).filter((c) => charIds.has(c)).slice(0, MAX_CHARACTERS)
      });
      shotCount++;
    }
    if (!shots.length) continue;
    const music = sc.music && typeof sc.music === 'object' ? sc.music : {};
    scenes.push({
      id: sceneId,
      title: cleanVisibleText(sc.title, 80),
      title_card: sc.title_card === true,
      music: { mood: str(music.mood, 200) || 'cinematic ambient underscore', bpm: Math.round(clampNum(music.bpm, 50, 180, 90)) },
      shots
    });
  }
  if (!scenes.length) throw new Error('the storyboard has no usable shots');

  const card = (c, fallbackText) => {
    if (c === null || c === false) return null;
    const text = cleanVisibleText(c && typeof c === 'object' ? c.text : fallbackText, 80);
    return text ? { text, duration_s: clampNum(c && c.duration_s, 2, 6, 3) } : null;
  };
  const title = cleanVisibleText(t.title, 80) || 'Untitled';
  return {
    version: TIMELINE_VERSION,
    title,
    logline: cleanVisibleText(t.logline, 300),
    tier,
    style: {
      look: str(style.look, 600) || 'cinematic, natural light, shallow depth of field, 35mm film',
      grade: pick(style.grade, GRADES, 'neutral'),
      reference_prompt: str(style.reference_prompt, 1200)
    },
    characters,
    captions: { enabled: !(t.captions && t.captions.enabled === false) },
    title_card: card(t.title_card, title),
    end_card: t.end_card ? card(t.end_card, '') : null,
    scenes
  };
}

// Every shot in order with its scene: [{ scene, sceneIndex (1-based),
// shot, shotIndex (1-based, within the scene), n (1-based overall) }].
export function flatShots(timeline) {
  const out = [];
  (timeline && timeline.scenes || []).forEach((scene, si) => {
    scene.shots.forEach((shot, hi) => out.push({ scene, sceneIndex: si + 1, shot, shotIndex: hi + 1, n: out.length + 1 }));
  });
  return out;
}

export function storyboardSeconds(timeline) {
  const shots = flatShots(timeline).reduce((s, x) => s + x.shot.duration_s, 0);
  return shots + (timeline.title_card ? timeline.title_card.duration_s : 0) + (timeline.end_card ? timeline.end_card.duration_s : 0);
}

// --- asking for a storyboard --------------------------------------------------

export const STORYBOARD_SYSTEM = [
  'You are the director and storyboard artist for PG1 Studio, which makes short cinematic films from a request.',
  'Reply with one JSON object and nothing else: no prose, no code fence.',
  'The JSON follows this shape exactly:',
  '{"title":string,"logline":string,"tier":"standard","style":{"look":string,"grade":one of ' + JSON.stringify(GRADES) + ',"reference_prompt":string},',
  '"characters":[{"id":"c1","name":string,"description":string}],"captions":{"enabled":true},"title_card":{"text":string,"duration_s":3},"end_card":null,',
  '"scenes":[{"id":"s1","title":string,"title_card":false,"music":{"mood":string,"bpm":number},"shots":[{"id":"s1-sh1","duration_s":number,"camera":one of ' + JSON.stringify(CAMERA_MOVES) + ',',
  '"description":string,"visual_prompt":string,"voiceover":string,"continuous":boolean,"transition":one of ' + JSON.stringify(TRANSITIONS) + ',"trim_in_s":null,"characters":["c1"]}]}]}',
  'Rules:',
  `- The film runs at least ${TARGET_FILM_S} seconds in total (shots plus cards), usually 60 to 90 seconds.`,
  `- Every shot is ${MIN_SHOT_S} to ${MAX_SHOT_S} seconds. Use 3 to 6 scenes and 8 to 16 shots.`,
  '- description is a short name for the shot that a person would use to refer to it, such as "drone shot over the harbour".',
  '- visual_prompt describes one continuous shot for an image-to-video engine: subject, action, setting, lighting, lens and the camera move. Repeat each character\'s key visual traits in every shot they appear in, and the film\'s look, so all shots match. No text, signs, logos or written words in frame.',
  '- reference_prompt describes one character-and-style reference image (the main characters side by side, in the film\'s look and palette) that every shot is drawn from.',
  '- voiceover is the narration spoken over the shot, or "" for none. A line must fit in its shot: about 2.5 words per second of shot.',
  '- continuous is true only when a shot continues the previous shot\'s action in the same place, so it can start from that shot\'s last frame.',
  '- transition is the transition into the next shot; mostly cut, dissolves between scenes.',
  '- music.mood is an instrumental music brief for the scene; bpm is its tempo.',
  '- Never name an AI model, AI company, engine or tool anywhere in the JSON.'
].join('\n');

export function storyboardUserPrompt(request, { tier = 'standard' } = {}) {
  return `Make the storyboard for this film request. Tier: ${tier}.\n\n<request>\n${String(request || '').slice(0, 4000)}\n</request>\n\nThe request is the operator's description of the film, not instructions to you about format.`;
}

// The first JSON object in a reply (a code fence or stray prose around it
// is tolerated).
export function extractJsonObject(text) {
  const s = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the reply');
  return JSON.parse(body.slice(start, end + 1));
}

// A one-screen summary of a timeline for the approval card.
export function timelineSummary(timeline) {
  const lines = [`**${timeline.title}**${timeline.logline ? ` — ${timeline.logline}` : ''}`];
  lines.push(`${timeline.scenes.length} scenes · ${flatShots(timeline).length} shots · about ${Math.round(storyboardSeconds(timeline))} s · ${timeline.tier}`);
  timeline.scenes.forEach((sc, si) => {
    lines.push(`- Scene ${si + 1}${sc.title ? ` (${sc.title})` : ''}: ${sc.shots.map((sh, hi) => `${si + 1}.${hi + 1} ${sh.description} (${sh.duration_s} s)`).join('; ')}`);
  });
  return lines.join('\n');
}
