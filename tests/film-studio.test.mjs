/**
 * PG1 Studio (lib/film/*, scripts/film-render.mjs, api/chat.mjs /film):
 * storyboard checks, timeline edits and what they make stale, cost and the
 * per-film cap, cut planning, the self-checks, the media library, the
 * render worker's stages (with stand-in engines and a stand-in ffmpeg), and
 * the chat's /film commands and approvals against a real Postgres.
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { UPSTREAM_BRAND_RE } from '../lib/upstreamFailure.mjs';
import { normaliseTimeline, extractJsonObject, flatShots, storyboardSeconds, cleanVisibleText, STORYBOARD_SYSTEM } from '../lib/film/storyboard.mjs';
import { applyTimelineEdits, assetFingerprints, missingAssets, resolveShot, clipSecondsFor } from '../lib/film/timeline.mjs';
import { estimateStage, fitsCap, filmCapUsd, DEFAULT_FILM_CAP_USD, MAX_SHOT_RETRIES } from '../lib/film/cost.mjs';
import { planCuts, snapToBeat, captionChunks } from '../lib/film/cuts.mjs';
import { parseQcVerdict, checkTranscript, wordErrorRate, normWords, QC_SYSTEM, retryPrompt } from '../lib/film/qc.mjs';
import { rankFilmMedia, createFilmStore } from '../lib/film/store.mjs';
import { parseFilmCommand, isFilmCommand, FILM_ACTIONS } from '../lib/film/text.mjs';
import { signFilmToken, verifyFilmToken, dispatchFilmRender, FILM_WORKFLOW } from '../lib/film/dispatch.mjs';
import { runStoryboard, runRender, shotChains } from '../lib/film/pipeline.mjs';
import { buildAss, joinFilter, mixFilter, parseLoudnorm, kenBurns, gradeFilter } from '../lib/film/ffmpeg.mjs';
import * as realFf from '../lib/film/ffmpeg.mjs';
import { main as workerMain } from '../scripts/film-render.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch, json } from './helpers/filmDb.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase.test';
const SECRET = 'film-render-secret-0123456789abcdef';

function storyboardJson(extra = {}) {
  return {
    title: 'Harbour at Dawn', logline: 'A fisher sets out before sunrise.', tier: 'standard',
    style: { look: 'cinematic, cold dawn light, 35mm', grade: 'teal_orange', reference_prompt: 'Mara, a fisher in a yellow coat, and her boat' },
    characters: [{ id: 'c1', name: 'Mara', description: 'woman in her forties, yellow oilskin coat, grey wool hat' }],
    captions: { enabled: true }, title_card: { text: 'Harbour at Dawn', duration_s: 3 }, end_card: null,
    scenes: [
      { id: 's1', title: 'The quay', title_card: true, music: { mood: 'sparse piano, cold', bpm: 80 }, shots: [
        { id: 's1-sh1', duration_s: 6, camera: 'drone_flyover', description: 'drone shot over the harbour', visual_prompt: 'Aerial flyover of a small harbour at dawn', voiceover: 'Every morning starts in the dark.', transition: 'cut', characters: [] },
        { id: 's1-sh2', duration_s: 5, camera: 'push_in', description: 'Mara walks the quay', visual_prompt: 'Mara walks along the quay carrying nets', voiceover: '', continuous: false, transition: 'dissolve', characters: ['c1'] }
      ] },
      { id: 's2', title: 'Out to sea', music: { mood: 'swelling strings', bpm: 96 }, shots: [
        { id: 's2-sh1', duration_s: 7, camera: 'tracking', description: 'boat leaves the harbour', visual_prompt: 'The boat pulls away from the quay', voiceover: 'She has done this for twenty years.', transition: 'cut', characters: ['c1'] },
        { id: 's2-sh2', duration_s: 5, camera: 'tracking', description: 'boat passes the lighthouse', visual_prompt: 'The boat passes the lighthouse', voiceover: '', continuous: true, transition: 'cut', characters: ['c1'] }
      ] },
      { id: 's3', title: 'Sunrise', music: { mood: 'warm, hopeful', bpm: 90 }, shots: [
        { id: 's3-sh1', duration_s: 8, camera: 'drone_flyover', description: 'drone shot of the boat at sunrise', visual_prompt: 'Aerial shot of the boat on a golden sea at sunrise', voiceover: 'And every morning, the sun finds her.', transition: 'cut', characters: ['c1'] }
      ] }
    ],
    ...extra
  };
}

const TL = () => normaliseTimeline(storyboardJson());

// --- storyboard ----------------------------------------------------------------------

describe('storyboard', () => {
  test('a storyboard is checked: shot lengths clamped, unknown values defaulted, first shot never continuous', () => {
    const warnings = [];
    const t = normaliseTimeline(storyboardJson({ scenes: [{ music: {}, shots: [
      { visual_prompt: 'a', duration_s: 14, camera: 'spin', transition: 'teleport', continuous: true },
      { visual_prompt: 'b', duration_s: 1 },
      { duration_s: 5 }
    ] }] }), { warnings });
    const shots = flatShots(t);
    assert.equal(shots.length, 2);
    assert.equal(shots[0].shot.duration_s, 10);
    assert.equal(shots[1].shot.duration_s, 3);
    assert.equal(shots[0].shot.camera, 'static');
    assert.equal(shots[0].shot.transition, 'cut');
    assert.equal(shots[0].shot.continuous, false);
    assert.equal(t.scenes[0].music.bpm, 90);
    assert.ok(warnings.some((w) => /dropped/.test(w)));
    assert.throws(() => normaliseTimeline({ scenes: [] }), /no scenes/);
  });

  test('text the viewer sees or hears never names an engine or AI company', () => {
    const t = normaliseTimeline(storyboardJson({ title: 'Made with Claude and Kling', title_card: { text: 'A Gemini film' } }));
    assert.doesNotMatch(t.title, UPSTREAM_BRAND_RE);
    assert.doesNotMatch(t.title_card.text, UPSTREAM_BRAND_RE);
    assert.equal(cleanVisibleText('Narrated by Cartesia sonic voice.'), 'Narrated by voice.');
    assert.match(STORYBOARD_SYSTEM, /Never name an AI model/);
  });

  test('the JSON is read from a reply with a fence or prose round it, and the film runs a minute or more', () => {
    const j = extractJsonObject('Here you go:\n```json\n' + JSON.stringify(storyboardJson()) + '\n```');
    const t = normaliseTimeline(j);
    assert.equal(t.title, 'Harbour at Dawn');
    assert.ok(storyboardSeconds(t) >= 30);
    assert.throws(() => extractJsonObject('no json here'), /no JSON/);
  });
});

// --- timeline edits and fingerprints -------------------------------------------------

describe('timeline edits', () => {
  test('shots are found by id, by "scene.shot" and by object', () => {
    const t = TL();
    assert.deepEqual(resolveShot(t, '2.1'), { sceneIdx: 1, shotIdx: 0 });
    assert.deepEqual(resolveShot(t, 's3-sh1'), { sceneIdx: 2, shotIdx: 0 });
    assert.deepEqual(resolveShot(t, { scene: 1, shot: 2 }), { sceneIdx: 0, shotIdx: 1 });
    assert.throws(() => resolveShot(t, '9.9'), /no shot 9.9/);
  });

  test('trim, reorder, music, voice, captions and grade each change only what they say', () => {
    const t = TL();
    const { timeline, changes } = applyTimelineEdits(t, [
      { op: 'trim', shot: '3.1', duration_s: 4 },
      { op: 'reorder', scene: 1, shots: ['s1-sh2', 's1-sh1'] },
      { op: 'set_music', scene: 2, mood: 'calm ambient pads' },
      { op: 'set_voiceover', shot: '2.1', text: 'Twenty years, every day.' },
      { op: 'captions', enabled: false },
      { op: 'set_grade', grade: 'warm' }
    ]);
    assert.equal(timeline.scenes[2].shots[0].duration_s, 4);
    assert.deepEqual(timeline.scenes[0].shots.map((s) => s.id), ['s1-sh2', 's1-sh1']);
    assert.equal(timeline.scenes[1].music.mood, 'calm ambient pads');
    assert.equal(timeline.captions.enabled, false);
    assert.equal(timeline.style.grade, 'warm');
    assert.equal(changes.length, 6);
    assert.equal(t.scenes[2].shots[0].duration_s, 8, 'the original is untouched');
  });

  test('a bad change is refused with its number and reason', () => {
    assert.throws(() => applyTimelineEdits(TL(), [{ op: 'trim', shot: '1.1', duration_s: 30 }]), /change 1 \(trim\).*3–10 s/);
    assert.throws(() => applyTimelineEdits(TL(), [{ op: 'explode' }]), /unknown change/);
    assert.throws(() => applyTimelineEdits(TL(), []), /no changes/);
  });

  test('a re-render regenerates only what an edit changed (and the continuous shot after it)', () => {
    const t = TL();
    const fp = assetFingerprints(t, { voiceKey: 'v' });
    const stored = new Set([
      `reference:${fp.reference}`,
      ...Object.values(fp.keyframes).map((f) => `keyframe:${f}`),
      ...Object.values(fp.clips).map((f) => `clip:${f}`),
      ...Object.values(fp.voice).map((f) => `voice:${f}`),
      ...Object.values(fp.music).map((f) => `music:${f}`)
    ]);
    assert.deepEqual(missingAssets(t, stored, { stage: 'full', voiceKey: 'v' }), { reference: false, keyframes: [], clips: [], voice: [], music: [] });

    const replaced = applyTimelineEdits(t, [{ op: 'replace_shot', shot: '2.1', visual_prompt: 'The boat leaves in heavy rain' }]).timeline;
    const m1 = missingAssets(replaced, stored, { stage: 'full', voiceKey: 'v' });
    assert.deepEqual(m1.keyframes, ['s2-sh1']);
    assert.deepEqual(m1.clips, ['s2-sh1', 's2-sh2'], 'the continuous shot starts from the new clip');
    assert.deepEqual(m1.voice, []);
    assert.deepEqual(m1.music, []);

    const music = applyTimelineEdits(t, [{ op: 'set_music', scene: 3, mood: 'brass fanfare' }]).timeline;
    assert.deepEqual(missingAssets(music, stored, { stage: 'full', voiceKey: 'v' }), { reference: false, keyframes: [], clips: [], voice: [], music: ['s3'] });

    const order = applyTimelineEdits(t, [{ op: 'set_transition', shot: '1.1', transition: 'fade_black' }, { op: 'captions', enabled: false }]).timeline;
    const m3 = missingAssets(order, stored, { stage: 'full', voiceKey: 'v' });
    assert.equal(m3.clips.length + m3.keyframes.length + m3.voice.length + m3.music.length, 0, 'an edit-only change costs only the re-assembly');

    assert.deepEqual(missingAssets(t, stored, { stage: 'full', voiceKey: 'new-voice' }).voice.sort(), ['s1-sh1', 's2-sh1', 's3-sh1']);
  });

  test('clips are 5 s or 10 s, long enough for the shot and its line', () => {
    assert.equal(clipSecondsFor({ duration_s: 4, voiceover: '', trim_in_s: null }), 5);
    assert.equal(clipSecondsFor({ duration_s: 4, voiceover: 'one two three four five six seven eight nine ten eleven twelve thirteen', trim_in_s: null }), 10);
    assert.equal(clipSecondsFor({ duration_s: 7, voiceover: '', trim_in_s: null }), 10);
  });
});

// --- cost and cap ----------------------------------------------------------------------

describe('cost', () => {
  test('the estimate counts only what is not stored, with retries in the worst case', () => {
    const t = TL();
    const full = estimateStage(t, { stage: 'full', withStoryboard: true });
    const labels = full.lines.map((l) => l.label);
    for (const l of ['Storyboard', 'Reference still', 'Shot stills', 'Video clips', 'Shot checks', 'Voiceover lines', 'Music beds', 'Final audio check']) assert.ok(labels.includes(l), l);
    assert.equal(full.missing.clips.length, 5);
    assert.equal(full.missing.keyframes.length, 4, 'the continuous shot needs no still of its own');
    assert.ok(full.worstUsd > full.expectedUsd);
    const preview = estimateStage(t, { stage: 'preview' });
    assert.ok(preview.expectedUsd < 1, `preview is cheap: ${preview.expectedUsd}`);
    assert.ok(!preview.lines.some((l) => l.label === 'Video clips'));
    assert.equal(MAX_SHOT_RETRIES, 2);
  });

  test('the cap comes from PG1_FILM_MAX_USD and a stage must fit under what is left', () => {
    assert.equal(filmCapUsd({}), DEFAULT_FILM_CAP_USD);
    assert.equal(filmCapUsd({ PG1_FILM_MAX_USD: '35.5' }), 35.5);
    assert.equal(filmCapUsd({ PG1_FILM_MAX_USD: 'lots' }), DEFAULT_FILM_CAP_USD);
    assert.equal(fitsCap({ expectedUsd: 5 }, { capUsd: 10, spentUsd: 4 }), true);
    assert.equal(fitsCap({ expectedUsd: 7 }, { capUsd: 10, spentUsd: 4 }), false);
  });
});

// --- cuts --------------------------------------------------------------------------------

describe('cut planning', () => {
  test('a shot grows to fit its voiceover line and cuts land on the beat', () => {
    const t = TL();
    const voice = { 's1-sh1': { durationS: 7.4, words: [] } };
    const plan = planCuts(t, { voice });
    const sh = plan.segments.find((s) => s.shotId === 's1-sh1');
    assert.ok(sh.durationS >= 7.4 + 0.6 - 1e-9, `long enough for the line: ${sh.durationS}`);
    const beat = 60 / 80;
    assert.ok(Math.abs(sh.durationS / beat - Math.round(sh.durationS / beat)) < 1e-6, 'on the scene beat');
    assert.equal(snapToBeat(6.1, 120), 6);
    assert.equal(snapToBeat(6.3, 60, { floorS: 6.2 }), 6.3, 'never cuts into the line');
  });

  test('transitions overlap, voice lines never collide, captions follow the words', () => {
    const t = TL();
    const words = [{ word: 'Every', start: 0, end: 0.3 }, { word: 'morning', start: 0.35, end: 0.8 }, { word: 'starts', start: 0.85, end: 1.2 }, { word: 'in', start: 1.25, end: 1.35 }, { word: 'the', start: 1.4, end: 1.5 }, { word: 'dark.', start: 1.55, end: 2 }];
    const voice = { 's1-sh1': { durationS: 2.1, words }, 's2-sh1': { durationS: 2.5, words: [] }, 's3-sh1': { durationS: 2.4, words: [] } };
    const plan = planCuts(t, { voice, clips: { 's1-sh1': { durationS: 10, bestStartS: 2 }, 's1-sh2': { durationS: 5, bestStartS: 9 } } });
    const segs = plan.segments;
    assert.equal(segs[0].kind, 'card');
    for (let i = 1; i < segs.length; i++) assert.ok(Math.abs(segs[i].startS - (segs[i - 1].startS + segs[i - 1].durationS - plan.joins[i - 1].durationS)) < 1e-6);
    assert.equal(plan.joins[0].transition, 'fade_black');
    assert.equal(segs[1].inS, 2, 'trimmed to the best moment');
    assert.equal(segs[2].inS, 0, 'kept inside the clip');
    for (let i = 1; i < plan.voice.length; i++) assert.ok(plan.voice[i].atS >= plan.voice[i - 1].atS + plan.voice[i - 1].durationS);
    const first = plan.captions[0];
    assert.equal(first.text, 'Every morning starts in the dark.');
    assert.equal(first.startS, plan.voice[0].atS);
    assert.equal(plan.music.length, 3);
    assert.equal(plan.music[0].startS, 0);
    assert.equal(plan.music[2].endS, plan.totalS);
    assert.ok(plan.titles.some((x) => x.text === 'The quay' && x.style === 'Title'));
    assert.ok(plan.totalS >= 30);
  });

  test('long lines break into caption chunks; captions off means none', () => {
    const chunks = captionChunks(null, { atS: 1, text: 'one two three four five six seven eight nine ten', durationS: 5 });
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].startS, 1);
    const off = applyTimelineEdits(TL(), [{ op: 'captions', enabled: false }]).timeline;
    assert.equal(planCuts(off, { voice: { 's1-sh1': { durationS: 2, words: [] } } }).captions.length, 0);
  });
});

// --- ffmpeg graphs (no ffmpeg needed) ----------------------------------------------------

describe('ffmpeg graphs', () => {
  test('joins chain xfade and concat with the right offsets', () => {
    const { filter, lengthS } = joinFilter([3, 6, 5], [{ transition: 'fade_black', durationS: 0.5 }, { transition: 'cut', durationS: 0 }]);
    assert.match(filter, /\[s0\]\[s1\]xfade=transition=fadeblack:duration=0\.500:offset=2\.500,settb=1\/24\[j1\]/);
    assert.match(filter, /\[j1\]\[s2\]concat=n=2:v=1:a=0,settb=1\/24\[vout\]/);
    assert.equal(lengthS, 13.5);
  });

  test('the mix ducks music under the voice and pads to the film length', () => {
    const f = mixFilter({ voice: [{ file: 'a', atS: 1.5 }], music: [{ file: 'm', startS: 0, endS: 20 }], totalS: 20 });
    assert.match(f, /adelay=delays=1500:all=1/);
    assert.match(f, /sidechaincompress/);
    assert.match(f, /apad=whole_dur=20\.000,atrim=0:20\.000\[aout\]/);
  });

  test('loudness, captions, camera moves and grades', () => {
    const m = parseLoudnorm('[Parsed_loudnorm_0 @ 0x1]\n{\n"input_i" : "-23.10",\n"input_tp" : "-5.00",\n"input_lra" : "4.20",\n"input_thresh" : "-33.5",\n"target_offset" : "0.3"\n}\n');
    assert.equal(m.input_i, '-23.10');
    assert.throws(() => parseLoudnorm('nothing'), /no loudness/);
    const ass = buildAss({ width: 1280, height: 720, captions: [{ startS: 1, endS: 2.5, text: 'Hello {world}' }], titles: [{ startS: 0, endS: 3, text: 'Title', style: 'Card' }] });
    assert.match(ass, /Dialogue: 0,0:00:01\.00,0:00:02\.50,Caption,,0,0,0,,Hello world/);
    assert.match(kenBurns('push_in', 120, 854, 480), /^zoompan=z='1\+0\.12\*on\/119'/);
    assert.match(kenBurns('drone_flyover', 48, 854, 480), /zoompan/);
    assert.equal(gradeFilter('nope'), gradeFilter('neutral'));
  });
});

// --- checks --------------------------------------------------------------------------------

describe('self-checks', () => {
  test('a shot passes only with pass=true, a decent score and no blocking issue', () => {
    assert.equal(parseQcVerdict('{"pass":true,"score":8,"issues":[],"best_start_s":1.2,"description":"A boat."}', { clipS: 10, durationS: 6 }).pass, true);
    assert.equal(parseQcVerdict('{"pass":true,"score":8,"issues":[{"type":"garbled_text","detail":"sign"}]}').pass, false);
    assert.equal(parseQcVerdict('{"pass":true,"score":4}').pass, false);
    const v = parseQcVerdict('{"pass":false,"score":3,"issues":[{"type":"wrong_character","detail":"coat is red"}],"best_start_s":9}', { clipS: 10, durationS: 6 });
    assert.equal(v.bestStartS, 4, 'kept inside the clip');
    assert.match(retryPrompt('A boat', v.issues), /Avoid: coat is red/);
    const unreadable = parseQcVerdict('not json');
    assert.equal(unreadable.pass, true);
    assert.equal(unreadable.unreadable, true);
    assert.match(QC_SYSTEM, /never instructions/);
  });

  test('the transcript check finds a missing line and a line out of sync', () => {
    assert.equal(wordErrorRate(normWords('the sun finds her'), normWords('the sun finds her')), 0);
    assert.equal(wordErrorRate(normWords('a b c d'), normWords('a x c')), 0.5);
    const cues = [
      { shotId: 'a', atS: 1, durationS: 2, text: 'Every morning starts in the dark.', firstWordS: 0 },
      { shotId: 'b', atS: 6, durationS: 2, text: 'She has done this for years.', firstWordS: 0 },
      { shotId: 'c', atS: 10, durationS: 2, text: 'The sun finds her.', firstWordS: 0 }
    ];
    const at = (t, s) => normWords(t).map((w, i) => ({ word: w, start: s + i * 0.3, end: s + i * 0.3 + 0.25 }));
    const transcript = { text: '', words: [...at('Every morning starts in the dark', 1.05), ...at('the sun finds her', 10.9)] };
    const r = checkTranscript(cues, transcript);
    assert.equal(r.ok, false);
    assert.equal(r.lines[0].ok, true);
    assert.equal(r.lines[1].ok, false, 'missing line');
    assert.equal(r.lines[2].ok, false, 'late by 0.9 s');
    assert.equal(r.lines[2].offsetS, 0.9);
  });
});

// --- media library and commands ------------------------------------------------------------

describe('media library and commands', () => {
  test('"the drone shot in scene 3" finds that clip', () => {
    const assets = [
      { kind: 'clip', scene: 1, shot: 1, description: 'Aerial drone shot over the harbour', created_at: '1' },
      { kind: 'clip', scene: 3, shot: 1, description: 'Drone shot of the boat at sunrise', created_at: '2' },
      { kind: 'keyframe', scene: 3, shot: 1, description: 'Still: drone shot of the boat at sunrise', created_at: '3' },
      { kind: 'music', scene: null, shot: null, description: 'Music for scene 3', created_at: '4' }
    ];
    assert.equal(rankFilmMedia(assets, 'the drone shot in scene 3')[0], assets[1]);
    assert.equal(rankFilmMedia(assets, 'still 3.1')[0], assets[2]);
  });

  test('/film commands parse', () => {
    assert.equal(isFilmCommand('/film a short film about bees'), true);
    assert.equal(isFilmCommand('/filming'), false);
    assert.deepEqual(parseFilmCommand('/film'), { sub: 'help', id: null, rest: '' });
    assert.deepEqual(parseFilmCommand('/film a film about bees'), { sub: 'new', id: null, rest: 'a film about bees' });
    assert.deepEqual(parseFilmCommand('/film edit 1A2B3C4D trim shot 3.2 to 4 s'), { sub: 'edit', id: '1a2b3c4d', rest: 'trim shot 3.2 to 4 s' });
    assert.deepEqual(parseFilmCommand('/film status'), { sub: 'status', id: null, rest: '' });
  });

  test('the render token is the film id signed with the render secret, and only that film', () => {
    const env = { PG1_VIDEO_RENDER_SECRET: SECRET };
    const id = '11111111-2222-4333-8444-555555555555';
    const t0 = Date.parse('2026-10-09T12:00:00Z');
    const tok = signFilmToken(id, env, t0);
    assert.equal(verifyFilmToken(tok, id, env, t0 + 60 * 60 * 1000).ok, true, 'still good after an hour in the queue');
    assert.equal(verifyFilmToken(tok, '11111111-2222-4333-8444-666666666666', env, t0).reason, 'wrong_project');
    assert.equal(verifyFilmToken(tok, id, { PG1_VIDEO_RENDER_SECRET: 'another-secret-0123456789' }, t0).ok, false);
    assert.equal(verifyFilmToken(tok, id, env, t0 + 7 * 3600 * 1000).ok, false, 'expired');
  });

  test('the dispatch starts the workflow on main with the signed token, and says so when it cannot', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const fetchImpl = routedFetch([['api.github.com', () => new Response(null, { status: 204 })]]);
    const ok = await dispatchFilmRender({ env: { PG1_VIDEO_RENDER_SECRET: SECRET, GITHUB_TOKEN: 'gh-token' }, projectId: id, stage: 'preview', fetchImpl });
    assert.equal(ok.ok, true);
    const call = fetchImpl.calls[0];
    assert.equal(call.url, `https://api.github.com/repos/Project-Gifted1/pg1-ai-agent/actions/workflows/${FILM_WORKFLOW}/dispatches`);
    assert.equal(call.body.ref, 'main');
    assert.equal(call.body.inputs.stage, 'preview');
    assert.equal(verifyFilmToken(call.body.inputs.token, id, { PG1_VIDEO_RENDER_SECRET: SECRET }).ok, true);
    const missing = await dispatchFilmRender({ env: {}, projectId: id, stage: 'preview', fetchImpl });
    assert.match(missing.detail, /PG1_VIDEO_RENDER_SECRET and GITHUB_TOKEN/);
  });
});

// --- the worker's stages, with stand-ins -------------------------------------------------

// ffmpeg stand-in: every step writes a small file and returns its path.
function fakeFf(log = []) {
  const touch = async (f, what) => { log.push(what); await writeFile(f, what); return f; };
  return {
    FILM_SIZES: realFf.FILM_SIZES, TARGET_LUFS: realFf.TARGET_LUFS, buildAss: realFf.buildAss, writeText: realFf.writeText,
    probeDuration: async () => 10,
    extractFrame: (i, t, out) => touch(out, 'frame'),
    extractLastFrame: (i, out) => touch(out, 'last'),
    thumbnail: (i, t, out) => touch(out, 'thumb'),
    segmentFromStill: (s, o) => touch(o.out, `still-seg ${o.camera}`),
    segmentFromClip: (c, o) => touch(o.out, `clip-seg ${o.inS}`),
    segmentCard: (o) => touch(o.out, 'card'),
    joinSegments: (files, d, j, out) => touch(out, `join ${files.length}`),
    mixAudio: (o) => touch(o.out, `mix ${o.voice.length} ${o.music.length}`),
    normaliseLoudness: async (i, out) => { await touch(out, 'loud'); return { file: out, measured: { input_i: '-22' }, after: { input_i: '-14.0' } }; },
    finalEncode: (o) => touch(o.out, 'final'),
    extractAudioForCheck: (i, out) => touch(out, 'wav')
  };
}

// Engines stand-in. `qcFail` maps a shot description to how many attempts fail.
function fakeEngines({ qcFail = {}, calls = [] } = {}) {
  const fails = { ...qcFail };
  return {
    calls,
    still: async ({ prompt, referenceUrl }) => { calls.push(['still', !!referenceUrl]); return Buffer.from('png'); },
    clip: async ({ prompt, startImageUrl, seconds }) => { calls.push(['clip', prompt.split('\n')[0], seconds, startImageUrl]); return Buffer.from('mp4'); },
    music: async ({ mood }) => { calls.push(['music', mood]); return { bytes: Buffer.from('wav'), ext: 'wav', mime: 'audio/wav' }; },
    voice: async ({ text }) => { calls.push(['voice', text]); return { wav: Buffer.from('wav'), durationS: 2, words: normWords(text).map((w, i) => ({ word: w, start: i * 0.3, end: i * 0.3 + 0.25 })) }; },
    image: (b) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(b).toString('base64') } }),
    think: async ({ system, content }) => {
      if (system.includes('storyboard artist')) { calls.push(['storyboard']); return { text: JSON.stringify(storyboardJson()) }; }
      const text = content[content.length - 1].text;
      const m = /^Shot \d+\.\d+: (.+)$/m.exec(text);
      const desc = m ? m[1] : '';
      calls.push(['qc', desc]);
      if (fails[desc] > 0) { fails[desc]--; return { text: '{"pass":false,"score":3,"issues":[{"type":"artifact","detail":"warped hands"}],"best_start_s":1,"description":"bad"}' }; }
      return { text: `{"pass":true,"score":8,"issues":[],"best_start_s":1.5,"description":"Clip of ${desc}"}` };
    },
    transcribe: async () => ({ text: '', words: [] })
  };
}

describe('render worker', () => {
  let db;
  let vault;
  let fetchImpl;
  let store;
  beforeEach(async () => {
    db = await makeFilmDb();
    vault = new Map();
    fetchImpl = routedFetch(filmDbRoutes(db, vault));
    store = createFilmStore({ supUrl: SUP_URL, supKey: 'service-key', fetchImpl });
  });

  const workdir = () => path.join(os.tmpdir(), `film-test-${Math.random().toString(36).slice(2)}`);

  test('storyboard -> preview -> full: everything generated once, failed shots retried at most twice, assets in the library', async () => {
    let p = await store.createProject({ request: 'A fisher at dawn', capUsd: 30, status: 'storyboarding' });
    const engines = fakeEngines({ qcFail: { 'Mara walks the quay': 1, 'boat passes the lighthouse': 5 } });
    const sb = await runStoryboard({ project: p, store, engines, ff: fakeFf(), workdir: workdir() });
    p = await store.getProject(p.id);
    assert.equal(p.status, 'awaiting_preview_approval');
    assert.equal(p.timeline.title, 'Harbour at Dawn');
    assert.equal(p.pending_token, sb.token);
    const proposal = (await db.query('select * from pending_actions where token = $1', [sb.token])).rows[0];
    assert.equal(proposal.action_type, FILM_ACTIONS.preview);
    assert.match(proposal.diff_summary, /Estimate: about/);

    await store.updateProject(p.id, { status: 'preview_rendering' });
    p = await store.getProject(p.id);
    const ffLog = [];
    const pre = await runRender({ project: p, stage: 'preview', store, engines, ff: fakeFf(ffLog), workdir: workdir() });
    assert.ok(ffLog.some((l) => l.startsWith('still-seg')), 'the preview is stills with camera moves');
    assert.ok(!engines.calls.some((c) => c[0] === 'clip'), 'no clips in the preview');
    assert.equal(engines.calls.filter((c) => c[0] === 'still').length, 1 + 5, 'reference + every shot');
    assert.equal(engines.calls.filter((c) => c[0] === 'still' && c[1]).length, 5, 'every shot still uses the reference');
    assert.equal(engines.calls.filter((c) => c[0] === 'voice').length, 3);
    assert.equal(engines.calls.filter((c) => c[0] === 'music').length, 3);
    assert.match(pre.path, /^films\/.+\/preview\/v1-/);

    engines.calls.length = 0;
    await store.updateProject(p.id, { status: 'full_rendering' });
    p = await store.getProject(p.id);
    const full = await runRender({ project: p, stage: 'full', store, engines, ff: fakeFf(), workdir: workdir(), env: { PG1_FILM_CONCURRENCY: '1' } });
    assert.equal(engines.calls.filter((c) => c[0] === 'voice' || c[0] === 'music').length, 0, 'voice and music reused from the preview');
    const clipCalls = engines.calls.filter((c) => c[0] === 'clip');
    // 5 shots + 1 retry for the quay + 2 retries (the cap) for the lighthouse.
    assert.equal(clipCalls.length, 8);
    const lighthouse = clipCalls.filter((c) => c[1] === 'The boat passes the lighthouse');
    assert.equal(lighthouse.length, 1 + MAX_SHOT_RETRIES);
    assert.match(lighthouse[0][3], /films%2F|films\//, 'the continuous shot starts from a stored frame');
    assert.match(lighthouse[0][3], /\/frames\/start-s2-sh2/);
    assert.equal(full.qcReport.generated.retries, 3);
    assert.deepEqual(full.qcReport.flagged, ['s2-sh2'], 'the shot that never passed is flagged, best attempt kept');
    assert.equal(full.qcReport.loudness.after, -14);

    const assets = await store.listAssets(p.id);
    const clips = assets.filter((a) => a.kind === 'clip');
    assert.equal(clips.length, 5);
    assert.ok(clips.every((c) => c.description && c.thumb_path && c.fingerprint && c.scene && c.shot));
    assert.ok(assets.some((a) => a.kind === 'final'));
    assert.equal(assets.filter((a) => a.kind === 'frame').length, 10, 'a frame per shot from the preview and the film');
    assert.equal(rankFilmMedia(assets, 'the drone shot in scene 3')[0].scene, 3);
    const spent = Number((await store.getProject(p.id)).spent_usd);
    assert.ok(spent > 0 && spent <= 30);

    // An edit re-renders only what it changed.
    engines.calls.length = 0;
    const edited = applyTimelineEdits(p.timeline, [{ op: 'set_music', scene: 3, mood: 'brass' }, { op: 'trim', shot: '1.1', duration_s: 5 }]).timeline;
    await store.updateProject(p.id, { timeline: edited, timeline_version: 2 });
    p = await store.getProject(p.id);
    await runRender({ project: p, stage: 'full', store, engines, ff: fakeFf(), workdir: workdir() });
    assert.deepEqual(engines.calls.map((c) => c[0]), ['music'], 'only the changed music bed');
  });

  test('the cap stops a stage before a call it cannot pay for', async () => {
    let p = await store.createProject({ request: 'x', capUsd: 0.5, status: 'storyboarding' });
    const engines = fakeEngines();
    await runStoryboard({ project: p, store, engines, ff: fakeFf(), workdir: workdir() });
    p = await store.getProject(p.id);
    await assert.rejects(runRender({ project: p, stage: 'full', store, engines, ff: fakeFf(), workdir: workdir() }), (e) => e.code === 'cap_reached');
    const after = await store.getProject(p.id);
    assert.ok(Number(after.spent_usd) <= 0.5);
    assert.equal(engines.calls.filter((c) => c[0] === 'clip').length, 0);
  });

  test('two charges at once cannot both spend the last of the cap', async () => {
    const p = await store.createProject({ request: 'x', capUsd: 1 });
    const [a, b] = await Promise.all([store.charge(p.id, 0.6), store.charge(p.id, 0.6)]);
    assert.equal([a.charged, b.charged].filter(Boolean).length, 1);
    assert.equal(Number((await store.getProject(p.id)).spent_usd), 0.6);
  });

  test('shots render in chains: a continuous shot waits for the one before it', () => {
    assert.deepEqual(shotChains(TL()).map((c) => c.map((r) => r.shot.id)), [['s1-sh1'], ['s1-sh2'], ['s2-sh1', 's2-sh2'], ['s3-sh1']]);
  });

  test('the worker refuses a bad token and claims a stage only once', async () => {
    const p = await store.createProject({ request: 'x', capUsd: 5, status: 'storyboard_queued' });
    process.env.SUPABASE_URL = SUP_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    const env = { ...process.env, PG1_VIDEO_RENDER_SECRET: SECRET, FILM_PROJECT_ID: p.id, FILM_STAGE: 'storyboard' };
    const logs = [];
    assert.equal(await workerMain({ ...env, FILM_TOKEN: 'nope' }, { log: (l) => logs.push(l), engines: fakeEngines(), fetchImpl }), 2);
    const good = { ...env, FILM_TOKEN: signFilmToken(p.id, env) };
    assert.equal(await workerMain(good, { log: (l) => logs.push(l), engines: fakeEngines(), fetchImpl }), 0);
    assert.equal((await store.getProject(p.id)).status, 'awaiting_preview_approval');
    assert.equal(await workerMain(good, { log: (l) => logs.push(l), engines: fakeEngines(), fetchImpl }), 0);
    assert.ok(logs.some((l) => /nothing to do/.test(l)));
  });
});

// --- the chat ----------------------------------------------------------------------------

describe('/film in the chat', () => {
  let db;
  let calls;
  let ipSeq = 0;
  const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.83.0.${++ipSeq}` }, body });
  const makeRes = () => ({
    statusCode: null, headers: {}, jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; },
    write() { return true; }, end() { return this; }, on() {}
  });
  const chat = async (body) => { const res = makeRes(); await chatHandler(makeReq(body), res); return res; };
  const authed = (extra) => ({ user: 'test-operator', pass: 'test-secret-pass', ...extra });

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    process.env.USER_API_KEY = 'test-operator';
    process.env.USER_API_PASS = 'test-secret-pass';
    process.env.SUPABASE_URL = SUP_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-0123456789';
    process.env.PG1_VIDEO_ENABLED = '1';
    process.env.PG1_VIDEO_RENDER_SECRET = SECRET;
    process.env.GITHUB_TOKEN = 'gh-test-token';
    for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'PG1_FILM_MAX_USD']) delete process.env[k];
    __clearAuthRateLimitState();
    db = await makeFilmDb();
    calls = [];
    globalThis.fetch = routedFetch([
      ['api.github.com', () => new Response(null, { status: 204 })],
      ['/rest/v1/messages', (u, o) => (o.method === 'POST' ? new Response('', { status: 201 }) : json([]))],
      ['/storage/v1/object/list/pg1-vault', () => json([])],
      ['/rest/v1/threat_indicators', () => json([])],
      ...filmDbRoutes(db)
    ], calls);
  });

  after(() => {
    process.env = { ...ORIGINAL_ENV };
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test('guests cannot start a film or read its status', async () => {
    const res = await chat({ prompt: '/film a film about bees' });
    assert.equal(res.statusCode, 401);
    const st = await chat({ action: 'FILM_STATUS', filmId: '11111111-2222-4333-8444-555555555555' });
    assert.equal(st.statusCode, 401);
    assert.equal(calls.filter((c) => c.url.includes('pg1_film')).length, 0);
  });

  test('/film queues a storyboard on the worker, with the cap, and says only PG1 Studio', async () => {
    const res = await chat(authed({ prompt: '/film a one-minute film about a fisher at dawn' }));
    assert.equal(res.statusCode, 200);
    const body = res.jsonBody;
    assert.match(body.reply, /PG1 Studio is writing the storyboard/);
    assert.match(body.reply, /Spending cap for this film: 20\.00 USD/);
    assert.doesNotMatch(body.reply, UPSTREAM_BRAND_RE);
    assert.equal(body.filmProject.status, 'storyboard_queued');
    assert.equal(body.filmProject.active, true);
    const dispatch = calls.find((c) => c.url.includes('api.github.com'));
    assert.equal(dispatch.body.inputs.stage, 'storyboard');
    assert.equal(dispatch.body.inputs.project_id, body.filmProject.id);
    const st = await chat(authed({ action: 'FILM_STATUS', filmId: body.filmProject.id }));
    assert.equal(st.jsonBody.filmProject.label, 'Writing the storyboard…');
  });

  test('without the render secret or token nothing is created or spent', async () => {
    delete process.env.GITHUB_TOKEN;
    const res = await chat(authed({ prompt: '/film bees' }));
    assert.match(res.jsonBody.reply, /not set up on this deployment yet/);
    assert.equal((await db.query('select count(*)::int as n from pg1_film_projects')).rows[0].n, 0);
  });

  test('approving the preview queues it; declining cancels; an edit goes through approve and re-renders', async () => {
    const store = createFilmStore({ supUrl: SUP_URL, supKey: 'k', fetchImpl: globalThis.fetch });
    const p0 = await store.createProject({ request: 'fisher', capUsd: 20, status: 'storyboarding' });
    await runStoryboard({ project: p0, store, engines: fakeEngines(), ff: fakeFf(), workdir: path.join(os.tmpdir(), 'film-chat') });
    let p = await store.getProject(p0.id);

    const status = await chat(authed({ prompt: `/film status ${p.id.slice(0, 8)}` }));
    assert.match(status.jsonBody.reply, /Storyboard ready: approve the preview/);
    assert.equal(status.jsonBody.pendingApproval.token, p.pending_token);
    assert.match(status.jsonBody.filmProject.summary, /drone shot over the harbour/);

    const ok = await chat(authed({ action: 'CONFIRM_PENDING_ACTION', token: p.pending_token, decision: 'approve' }));
    assert.match(ok.jsonBody.reply, /rendering the low-res preview/);
    assert.equal(ok.jsonBody.filmProject.status, 'preview_queued');
    assert.equal(calls.filter((c) => c.url.includes('api.github.com')).pop().body.inputs.stage, 'preview');
    assert.equal((await db.query('select status from pending_actions where token = $1', [p.pending_token])).rows[0].status, 'approved');
    assert.doesNotMatch(ok.jsonBody.reply, /GitHub/);

    // The preview finished (as the worker would leave it).
    await store.updateProject(p.id, { status: 'preview_done', preview_path: `films/${p.id}/preview/v1.mp4` });
    const edit = await chat(authed({ prompt: `/film edit ${p.id.slice(0, 8)} [{"op":"trim","shot":"3.1","duration_s":4},{"op":"set_music","scene":2,"mood":"calm pads"}]` }));
    assert.match(edit.jsonBody.reply, /Shot 3\.1 \(drone shot of the boat at sunrise\): 8 s → 4 s/);
    assert.match(edit.jsonBody.reply, /Music beds( ×\d+)?: about/);
    assert.ok(edit.jsonBody.pendingApproval.token);
    p = await store.getProject(p.id);
    assert.equal(p.timeline_version, 1, 'nothing changes before approval');

    const applied = await chat(authed({ action: 'CONFIRM_PENDING_ACTION', token: edit.jsonBody.pendingApproval.token, decision: 'approve' }));
    assert.match(applied.jsonBody.reply, /change applied \(version 2\)/);
    p = await store.getProject(p.id);
    assert.equal(p.timeline_version, 2);
    assert.equal(p.timeline.scenes[2].shots[0].duration_s, 4);
    assert.equal(p.status, 'preview_queued');

    // A second film, declined at the preview.
    const p1 = await store.createProject({ request: 'other', capUsd: 20, status: 'storyboarding' });
    const sb = await runStoryboard({ project: p1, store, engines: fakeEngines(), ff: fakeFf(), workdir: path.join(os.tmpdir(), 'film-chat2') });
    const no = await chat(authed({ action: 'CONFIRM_PENDING_ACTION', token: sb.token, decision: 'decline' }));
    assert.match(no.jsonBody.reply, /cancelled/);
    assert.equal((await store.getProject(p1.id)).status, 'cancelled');
  });

  test('an approval that would go over the cap starts nothing', async () => {
    const store = createFilmStore({ supUrl: SUP_URL, supKey: 'k', fetchImpl: globalThis.fetch });
    const p0 = await store.createProject({ request: 'fisher', capUsd: 0.3, status: 'storyboarding' });
    const sb = await runStoryboard({ project: p0, store, engines: fakeEngines(), ff: fakeFf(), workdir: path.join(os.tmpdir(), 'film-chat3') });
    const res = await chat(authed({ action: 'CONFIRM_PENDING_ACTION', token: sb.token, decision: 'approve' }));
    assert.match(res.jsonBody.reply, /would go over film .* cap/);
    assert.equal((await store.getProject(p0.id)).status, 'awaiting_preview_approval');
    assert.equal(calls.filter((c) => c.url.includes('api.github.com')).length, 0);
  });

  test('/film media finds the drone shot in scene 3; /film alone lists the commands', async () => {
    const store = createFilmStore({ supUrl: SUP_URL, supKey: 'k', fetchImpl: globalThis.fetch });
    const p = await store.createProject({ request: 'fisher', capUsd: 20, status: 'done' });
    await store.insertAsset({ project_id: p.id, kind: 'clip', scene: 1, shot: 1, description: 'Aerial drone shot over the harbour', storage_path: 'films/a.mp4', duration_s: 6 });
    await store.insertAsset({ project_id: p.id, kind: 'clip', scene: 3, shot: 1, description: 'Drone shot of the boat at sunrise', storage_path: 'films/b.mp4', duration_s: 8 });
    const res = await chat(authed({ prompt: `/film media ${p.id.slice(0, 8)} the drone shot in scene 3` }));
    const first = res.jsonBody.reply.split('\n')[1];
    assert.match(first, /Shot 3\.1 clip: Drone shot of the boat at sunrise \(8\.0 s\)/);
    const help = await chat(authed({ prompt: '/film' }));
    assert.match(help.jsonBody.reply, /PG1 STUDIO/);
    assert.doesNotMatch(help.jsonBody.reply, UPSTREAM_BRAND_RE);
  });
});

test('no third-party engine name in the film UI', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('// PG1 STUDIO (lib/film/chat.mjs)');
  const block = html.slice(start, html.indexOf('document.addEventListener(\'visibilitychange\', () => { if (!document.hidden) pollFilmCardsSoon', start));
  assert.ok(block.length > 500);
  assert.doesNotMatch(block, UPSTREAM_BRAND_RE);
});
