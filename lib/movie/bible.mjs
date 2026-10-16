// PG1 Studio movies: the bibles. Built once from the screenplay and saved
// on the movie (director.bibles), so every shot, retry and retake works
// from the same faces, wardrobe, places and look.
//
//   characters  name, age, look, wardrobe, personality and a fixed set of
//               reference images (CHARACTER_VIEWS): every shot a character
//               is in is conditioned on them, so the face and the wardrobe
//               stay identical across shots
//   locations   description and one reference image each
//   look        one colour grade and one look for the whole movie
//
// A reference's fingerprint is the hash of exactly what it shows, so a
// stored reference is reused as long as its bible entry is unchanged.

import { hash } from '../film/timeline.mjs';

export const CHARACTER_VIEWS = Object.freeze([
  { view: 'front', words: 'head-and-shoulders portrait, facing the camera, neutral expression' },
  { view: 'three_quarter', words: 'three-quarter view portrait, head and shoulders' },
  { view: 'full', words: 'full-length standing, showing the whole wardrobe' }
]);
// The most reference images one shot is sent (the speaker's face first).
export const MAX_SHOT_REFS = 3;
export const NO_TEXT = 'No readable signs, letters or text anywhere in frame.';

export function buildBibles(sp) {
  const look = { grade: sp.grade, look: sp.look };
  const characters = sp.characters.map((c) => ({
    id: c.id, name: c.name, age: c.age, look: c.look, wardrobe: c.wardrobe, personality: c.personality,
    refs: CHARACTER_VIEWS.map((v) => ({ key: `${c.id}:${v.view}`, view: v.view, prompt: characterRefPrompt(c, v, look), fingerprint: hash('movie-char-ref', c.look, c.wardrobe, c.age, v.view, look.look) }))
  }));
  const locations = sp.locations.map((l) => ({
    id: l.id, name: l.name, description: l.description,
    refs: [{ key: `${l.id}:establishing`, view: 'establishing', prompt: locationRefPrompt(l, look), fingerprint: hash('movie-loc-ref', l.description, look.look) }]
  }));
  return { look, characters, locations };
}

export function characterRefPrompt(c, v, look) {
  return `Character reference for a film: ${c.name}${c.age ? `, ${c.age} years old` : ''}. ${c.look}. Wardrobe: ${c.wardrobe}. ${v.words}. Plain neutral background, soft even light, photorealistic, ${look.look}. One person only. ${NO_TEXT}`;
}

export function locationRefPrompt(l, look) {
  return `Location reference for a film: ${l.name}. ${l.description}. Wide establishing view, no people, ${look.look}, 16:9. ${NO_TEXT}`;
}

// Every reference the bibles need: [{ key, prompt, fingerprint, kind }].
export function allRefs(bibles) {
  return [
    ...bibles.characters.flatMap((c) => c.refs.map((r) => ({ ...r, kind: 'character', owner: c.id }))),
    ...bibles.locations.flatMap((l) => l.refs.map((r) => ({ ...r, kind: 'location', owner: l.id })))
  ];
}

// The reference keys one shot is conditioned on, in order: the speaker's
// front and three-quarter views, the front of each other character in the
// shot, then the location; at most MAX_SHOT_REFS. Every character in the
// shot always has at least their front view.
export function shotRefKeys(shot, { max = MAX_SHOT_REFS } = {}) {
  const keys = [];
  const chars = [...new Set([shot.speaker, ...(shot.characters || [])].filter(Boolean))];
  for (const c of chars) keys.push(`${c}:front`);
  if (shot.speaker && keys.length < max) keys.push(`${shot.speaker}:three_quarter`);
  if (!chars.length || shot.kind === 'establishing') keys.push(`${shot.location}:establishing`);
  else if (keys.length < max) keys.push(`${shot.location}:establishing`);
  // The faces always go; the extras fill what is left.
  const faces = keys.filter((k) => k.endsWith(':front'));
  const rest = keys.filter((k) => !k.endsWith(':front'));
  return [...faces, ...rest].slice(0, Math.max(max, faces.length));
}
