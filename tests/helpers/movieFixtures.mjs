// /movie test fixtures: a short screenplay and stand-in engines that make
// real media with ffmpeg (clips with a spoken line in their audio track,
// tones for the score, noise for the ambience), so the movie pipeline runs
// end to end on the real edit, mix, master and QC gate without network.

import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { run } from '../../lib/film/ffmpeg.mjs';
import { MOVIE_DAILIES_SYSTEM } from '../../lib/movie/qc.mjs';

export const SCREENPLAY = {
  title: 'First Loaf', logline: 'Two bakers race the dawn to open on time.', look: 'warm tungsten interiors, soft dawn exteriors, 35mm', grade: 'warm',
  characters: [
    { id: 'c1', name: 'Mara', age: 34, look: 'dark curly hair tied back, olive skin, slim', wardrobe: 'white apron over a green shirt', personality: 'calm, exacting', voice: 'female, thirties, British, warm' },
    { id: 'c2', name: 'Tom', age: 28, look: 'short red hair, freckles, tall', wardrobe: 'grey wool coat, flat cap', personality: 'eager, clumsy', voice: 'male, twenties, Irish, bright' }
  ],
  locations: [
    { id: 'l1', name: 'The bakery', description: 'small stone bakery, wood-fired oven, flour on every surface' },
    { id: 'l2', name: 'The street', description: 'wet cobbled street outside the bakery door at dawn' }
  ],
  acts: [
    { act: 1, scenes: [{ id: 's1', slugline: 'INT. BAKERY - NIGHT', location: 'l1', characters: ['c1', 'c2'], ambience: 'oven hum, rain on the window', score: 'gentle piano', bpm: 76, on_screen_text: null, elements: [
      { type: 'action', text: 'Mara slides a tray of loaves into the oven.', sfx: 'oven door clunk', motion: true },
      { type: 'dialogue', character: 'c1', parenthetical: 'quietly', line: 'We open in an hour.', key: false },
      { type: 'dialogue', character: 'Tom', parenthetical: null, line: 'Then we have an hour.', key: true }
    ] }] },
    { act: 2, scenes: [{ id: 's2', slugline: 'EXT. BAKERY DOOR - DAWN', location: 'l2', characters: ['c1', 'c2'], ambience: 'gulls, distant traffic', score: 'playful pizzicato', bpm: 104, elements: [
      { type: 'action', text: 'Tom hauls a heavy sack of flour across the wet cobbles, slips, and catches himself on the doorframe just in time.', sfx: 'flour sack thud', motion: true },
      { type: 'dialogue', character: 'c1', line: 'Careful with the flour.' },
      { type: 'dialogue', character: 'c2', line: 'Always.' }
    ] }] },
    { act: 3, scenes: [{ id: 's3', slugline: 'int. bakery - dawn', location: 'l1', characters: ['c1', 'c2'], ambience: 'crackling oven', score: 'warm strings, resolving', bpm: 80, elements: [
      { type: 'dialogue', character: 'c1', line: 'First loaf is yours.', key: true },
      { type: 'dialogue', character: 'c2', line: 'Deal.' }
    ] }] }
  ]
};

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// A take: colour bars at `width`x`height`, `seconds` long, with a tone where
// the line is spoken (from 0.6 s to 0.6 s before the end) and silence around it.
const cache = new Map();
export async function makeClip(dir, seconds, { width = 1280, height = 720 } = {}) {
  const key = `${seconds}-${width}x${height}`;
  if (cache.has(key) && existsSync(cache.get(key))) return readFile(cache.get(key));
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, `fake-clip-${key}.mp4`);
  const end = Math.max(0.9, seconds - 0.6).toFixed(2);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=24:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${seconds}`,
    '-filter_complex', `[1:a]volume=0.3,volume=enable='lt(t,0.6)+gt(t,${end})':volume=0[a]`, '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
  cache.set(key, out);
  return readFile(out);
}

async function makeAudio(dir, name, filter, seconds) {
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, `${name}.mp3`);
  if (!existsSync(out)) await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${filter}:d=${seconds}`, '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', out]);
  return readFile(out);
}

// Stand-in engines. failPlan: { shotId: [verdicts per take: 'pass' | 'fail'] }.
// calls records every engine call.
export function fakeMovieEngines({ dir, calls = [], failPlan = {}, clipSize = { width: 1280, height: 720 }, stsStretch = 1.05, screenplay = SCREENPLAY } = {}) {
  const takeCount = {};
  return {
    calls,
    think: async ({ system, content, validate, purpose }) => {
      calls.push({ step: 'think', purpose });
      let text;
      if (system === MOVIE_DAILIES_SYSTEM) {
        const blob = (Array.isArray(content) ? content : [content]).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        const shot = /Shot (\S+) \(take (\d+)\)/.exec(blob);
        const id = shot[1];
        const n = Number(shot[2]);
        calls.push({ step: 'dailies', shot: id, take: n, refs: blob.match(/Bible reference (\S+):/g) || [] });
        const plan = failPlan[id] || [];
        const v = plan[n - 1] || 'pass';
        text = v === 'fail'
          ? JSON.stringify({ pass: false, score: 3, issues: [{ type: 'character_mismatch', detail: "Tom's coat is blue, not grey; a typical Kling artefact from gemini-omni-1.1-flash" }], best_start_s: 0.2, description: 'wrong coat' })
          : JSON.stringify({ pass: true, score: 8, issues: [], best_start_s: 0.2, description: 'as intended' });
      } else {
        text = JSON.stringify(screenplay);
      }
      return validate ? { value: validate(text), text } : { text };
    },
    image: (bytes) => ({ type: 'image', bytes: bytes.length }),
    still: async ({ prompt, referenceUrl }) => { calls.push({ step: 'still', prompt, referenceUrl }); return { bytes: PNG, engine: 'gemini_paid' }; },
    dialogueClip: async ({ prompt, seconds, refs, shot }) => {
      takeCount[shot.id] = (takeCount[shot.id] || 0) + 1;
      calls.push({ step: 'clip', shot: shot.id, prompt, seconds, refs: refs.map((r) => r.label), take: takeCount[shot.id] });
      return { bytes: await makeClip(dir, seconds, clipSize), engine: 'gemini_paid', costUsd: 0.15 * seconds };
    },
    // The converted line comes back a little longer than the take (the
    // pipeline fits it back to the take's length).
    sts: async ({ audio, voiceId, seconds }) => {
      calls.push({ step: 'sts', voiceId, seconds });
      const inF = path.join(dir, `sts-in-${calls.length}.wav`);
      const outF = path.join(dir, `sts-out-${calls.length}.wav`);
      await (await import('node:fs/promises')).writeFile(inF, audio);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inF, '-af', `atempo=${(1 / stsStretch).toFixed(4)}`, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', outF]);
      return { wav: await readFile(outF), costUsd: 0.01 };
    },
    sfx: async ({ text, seconds }) => { calls.push({ step: 'sfx', text, seconds }); return { bytes: await makeAudio(dir, `sfx-${Math.round(seconds)}`, 'anoisesrc=color=pink:amplitude=0.05', seconds), ext: 'mp3', mime: 'audio/mpeg', durationS: seconds }; },
    // Score cues come back shorter than asked (at most 6 s): the mix loops them to cover.
    music: async ({ mood, seconds }) => { calls.push({ step: 'music', mood, seconds }); return { bytes: await makeAudio(dir, `score-${Math.min(6, seconds)}`, 'sine=frequency=330', Math.min(6, seconds)), ext: 'mp3', mime: 'audio/mpeg', costUsd: 0.08 }; },
    voice: async ({ text }) => { calls.push({ step: 'narration', text }); throw new Error('no narration expected'); },
    prepareVoices: async ({ project, save }) => {
      const had = project.director && project.director.cast;
      calls.push({ step: 'cast', reused: !!had });
      const cast = had || { narrator: { voice_id: 'narr', name: 'George' }, characters: { Mara: { voice_id: 'voice-mara', name: 'Alice' }, Tom: { voice_id: 'voice-tom', name: 'Callum' } }, cast_at: new Date().toISOString(), source: 'cast' };
      if (!had) await save(cast);
      return { cast, effective: cast };
    },
    voiceFor: (name) => ({ mara: 'voice-mara', tom: 'voice-tom' })[String(name).toLowerCase()] || null
  };
}
