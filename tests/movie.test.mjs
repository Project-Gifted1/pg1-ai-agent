/**
 * PG1 Studio movies (/movie, lib/movie): characters who act and speak on
 * screen.
 *
 *  - the screenplay: three acts, sluglines, short speakable lines; saved and
 *    reused, never written twice;
 *  - bibles: fixed reference images per character and location, passed to
 *    every shot; coverage (establishing, OTS, reverse, close-ups, reactions,
 *    cut on action, 2–4 s average, no long static shot);
 *  - takes: the dailies critic, automatic retakes (at most 2), the best take
 *    kept and flagged; speech-to-speech into the cast voice keeps the line's
 *    timing; the cast is reused on retry;
 *  - the edit never holds a frame, J and L cuts, audio covering the runtime,
 *    the master spec and the QC gate (ffprobe, freezedetect, silencedetect,
 *    loudness, critic), fixed and re-rendered once;
 *  - both approval checkpoints block spending; client movies use only
 *    commercial_ok engines and cleared voices; white label everywhere.
 *
 * End to end on real ffmpeg with stand-in engines; no network.
 * Run with: node --test tests/movie.test.mjs
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { __resetRouterState } from '../lib/aiRouter.mjs';
import * as ff from '../lib/film/ffmpeg.mjs';
import * as au from '../lib/movie/audio.mjs';
import { parseScreenplay, screenplayText, splitLine, normaliseSlugline, MAX_LINE_WORDS, speakingCharacters } from '../lib/movie/screenplay.mjs';
import { buildBibles, allRefs, shotRefKeys, CHARACTER_VIEWS, NO_TEXT } from '../lib/movie/bible.mjs';
import { planShots, shotListStats, shotPrompt, STATIC_MAX_S } from '../lib/movie/coverage.mjs';
import { estimateMovie, estimateMovieText, MAX_RETAKES } from '../lib/movie/cost.mjs';
import { planMovieEdit, noPadding, movieCredits } from '../lib/movie/edit.mjs';
import { parseTakeVerdict, withSpeechCheck, speechFromSilences, betterTake } from '../lib/movie/qc.mjs';
import { dialogueClipBody, moviePlan, dialogueClip, speechToSpeech, ELEVENLABS_STS_URL, STS_FORMAT } from '../lib/movie/engines.mjs';
import { runMovieScript, runMovie, planMovie, savedSets, gateFixes, consistencyPass } from '../lib/movie/pipeline.mjs';
import { handleMovieCommand, handleMovieApproval } from '../lib/movie/chat.mjs';
import { parseMovieCommand, isMovieCommand, MOVIE_ACTIONS, MOVIE_HELP_TEXT, MOVIE_FAILURE_TEXT, movieFailureMessage, sayMovie, MOVIE_STATUS_LABELS } from '../lib/movie/text.mjs';
import { FILM_STAGES, filmRenderRef } from '../lib/film/dispatch.mjs';
import { createFilmStore } from '../lib/film/store.mjs';
import { namesProvider, STUDIO_LABEL, SOUND_LABEL, TRADEMARK } from '../lib/whiteLabel.mjs';
import { INTERACTIONS_URL } from '../lib/videoJobs.mjs';
import { VOICES_URL, __resetVoiceCache } from '../lib/film/voices.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch, json } from './helpers/filmDb.mjs';
import { SCREENPLAY, fakeMovieEngines, PNG } from './helpers/movieFixtures.mjs';

const SUP = 'https://supabase.test';
const HAS_FFMPEG = await ff.hasFfmpeg();
const NO_FF = HAS_FFMPEG ? false : 'ffmpeg is not installed';
const clone = (v) => JSON.parse(JSON.stringify(v));
const SP = parseScreenplay(clone(SCREENPLAY), { minutes: 0.5 });
const BANNED = /(?<![a-z0-9])(?:eleven[\s_-]*labs|google|gemini|veo|lyria|replicate|kling|kwaivgi|cartesia|flux|kontext|openrouter|openai|anthropic|claude|gpt|omni|imagen|eleven_[a-z0-9_]+)(?![a-z0-9])/i;
const assertWhite = (text, what) => { assert.ok(!namesProvider(text) && !BANNED.test(text), `${what} names a provider: ${String(text).match(BANNED)}`); };

after(() => __resetRouterState());

// --- the screenplay --------------------------------------------------------------------

describe('screenplay', () => {
  test('three acts, sluglines, short speakable lines; characters by id or name', () => {
    assert.equal(SP.acts.length, 3);
    const scenes = SP.acts.flatMap((a) => a.scenes);
    assert.deepEqual(scenes.map((s) => s.slugline), ['INT. BAKERY - NIGHT', 'EXT. BAKERY DOOR - DAWN', 'INT. BAKERY - DAWN']);
    const lines = scenes.flatMap((s) => s.elements).filter((e) => e.type === 'dialogue');
    assert.ok(lines.every((l) => l.line.split(/\s+/).length <= MAX_LINE_WORDS));
    assert.equal(lines[1].character, 'c2', 'a line given by name is the character id');
    assert.deepEqual(speakingCharacters(SP).map((c) => c.name), ['Mara', 'Tom']);
    const text = screenplayText(SP);
    assert.match(text, /^FIRST LOAF/);
    assert.match(text, /ACT ONE\n\nINT\. BAKERY - NIGHT/);
    assert.match(text, / {20}MARA\n {15}\(quietly\)\n {10}We open in an hour\./);
  });

  test('rules: exactly three acts, real sluglines, no line too long for one shot, nobody speaks = no movie', () => {
    const bad = (mut, re) => { const j = clone(SCREENPLAY); mut(j); assert.throws(() => parseScreenplay(j, { minutes: 0.5 }), re); };
    bad((j) => j.acts.pop(), /exactly 3 acts/);
    bad((j) => { j.acts[0].scenes[0].slugline = 'The bakery at night'; }, /slugline/);
    bad((j) => { j.acts[0].scenes[0].elements[1].line = 'I have been thinking for a very long time about whether we should really open the bakery at all this morning'; }, /too long for one shot/);
    bad((j) => { for (const a of j.acts) for (const s of a.scenes) s.elements = s.elements.filter((e) => e.type !== 'dialogue').concat(s.elements.length ? [] : []); for (const a of j.acts) for (const s of a.scenes) if (!s.elements.length) s.elements.push({ type: 'action', text: 'Silence.' }); }, /nobody speaks/);
    bad((j) => { j.acts[0].scenes[0].elements[1].character = 'Ghost'; }, /not in the character list/);
    assert.equal(normaliseSlugline('ext bakery door – dawn'), 'EXT. BAKERY DOOR - DAWN');
    // A long line of two sentences is split, one per shot.
    assert.deepEqual(splitLine('We open in an hour and the oven is still cold. Get the flour from the cellar right now.'), ['We open in an hour and the oven is still cold.', 'Get the flour from the cellar right now.']);
    const w = [];
    const narr = clone(SCREENPLAY);
    narr.acts[0].scenes[0].elements.push({ type: 'narration', text: 'It was the longest night.' });
    const sp = parseScreenplay(narr, { minutes: 0.5, warnings: w });
    assert.ok(!sp.acts[0].scenes[0].elements.some((e) => e.type === 'narration'), 'narration is off by default');
    assert.match(w.join(' '), /narration is off/);
    assert.ok(parseScreenplay(clone(narr), { minutes: 0.5, narration: true }).acts[0].scenes[0].elements.some((e) => e.type === 'narration'));
    assert.throws(() => parseScreenplay(clone(SCREENPLAY), { minutes: 4 }), /should run about 240 s/);
  });
});

// --- bibles and coverage ------------------------------------------------------------------

describe('bibles and coverage', () => {
  const bibles = buildBibles(SP);
  const shots = planShots(SP);

  test('every character has a fixed set of reference images; every location one; one look', () => {
    for (const c of bibles.characters) assert.deepEqual(c.refs.map((r) => r.view), CHARACTER_VIEWS.map((v) => v.view));
    assert.equal(allRefs(bibles).length, 2 * 3 + 2);
    assert.deepEqual(bibles.look, { grade: 'warm', look: SP.look });
    assert.ok(allRefs(bibles).every((r) => r.prompt.includes(NO_TEXT)));
    assert.equal(buildBibles(SP).characters[0].refs[0].fingerprint, bibles.characters[0].refs[0].fingerprint, 'stable fingerprints');
  });

  test('coverage: establishing wides, OTS and reverse, close-ups on key lines, reactions, cut on action, pacing', () => {
    const scenes = SP.acts.flatMap((a) => a.scenes);
    for (const sc of scenes) assert.equal(shots.find((s) => s.sceneId === sc.id).kind, 'establishing', `${sc.id} opens on a wide`);
    const s1 = shots.filter((s) => s.sceneId === 's1');
    assert.deepEqual(s1.map((s) => s.size), ['wide', 'medium', 'over_the_shoulder', 'close_up', 'reaction']);
    const s2 = shots.filter((s) => s.sceneId === 's2');
    assert.deepEqual(s2.map((s) => s.size), ['wide', 'medium_wide', 'close_up', 'over_the_shoulder', 'reverse']);
    assert.ok(s2[2].cutOnAction, 'a long action is cut on action');
    const st = shotListStats(shots);
    assert.ok(st.actionAverageS >= 2 && st.actionAverageS <= 4, `action ASL ${st.actionAverageS}`);
    assert.ok(st.averageS >= 2 && st.averageS <= 4, `ASL ${st.averageS}`);
    assert.equal(st.staticOverMax, 0);
    for (const s of shots.filter((x) => x.durationS > STATIC_MAX_S)) assert.doesNotMatch(s.camera, /static|locked/);
    // One line per dialogue shot, and it fits inside the clip asked for.
    for (const s of shots.filter((x) => x.kind === 'dialogue')) assert.ok(s.clipS >= s.durationS + 0.5 && s.clipS <= 8, s.id);
  });

  test('every shot is conditioned on its characters\' reference images, the speaker first', () => {
    for (const s of shots) {
      const keys = shotRefKeys(s);
      for (const c of s.characters) assert.ok(keys.includes(`${c}:front`), `${s.id} carries ${c}`);
      if (s.speaker) assert.equal(keys[0], `${s.speaker}:front`);
      if (!s.characters.length) assert.ok(keys.includes(`${s.location}:establishing`));
    }
  });

  test('prompts: the exact line, one speaker, lip sync, the bible look; no readable text unless scripted', () => {
    const d = shots.find((s) => s.kind === 'dialogue' && s.speaker === 'c2');
    const p = shotPrompt(SP, bibles, d);
    assert.match(p, /Tom says: "Then we have an hour\."/);
    assert.match(p, /Only Tom speaks, on screen, with the lips exactly in sync/);
    assert.match(p, /grey wool coat/);
    assert.ok(p.includes(NO_TEXT));
    const withText = shotPrompt(SP, bibles, { ...d, needsText: 'OPEN' });
    assert.match(withText, /The only readable text in frame is "OPEN"/);
    assert.ok(!withText.includes(NO_TEXT));
  });
});

// --- cost -------------------------------------------------------------------------------

describe('cost estimate', () => {
  test('per stage and total; what is saved is not priced again', () => {
    const bibles = buildBibles(SP);
    const shots = planShots(SP);
    const est = estimateMovie({ screenplay: SP, bibles, shots });
    assert.deepEqual(est.stages.map((s) => s.stage), ['bibles', 'shots', 'dailies', 'voices', 'effects', 'score', 'edit', 'retakes']);
    assert.ok(est.expectedUsd > 0 && est.worstUsd > est.expectedUsd);
    const saved = { refs: new Set(allRefs(bibles).map((r) => r.key)), takes: new Set(shots.map((s) => s.id)), voiced: new Set(shots.map((s) => s.id)), ambience: new Set(['s1', 's2', 's3']), effects: new Set(shots.map((s) => s.id)), score: new Set(['s1', 's2', 's3']) };
    assert.equal(estimateMovie({ screenplay: SP, bibles, shots, saved }).expectedUsd, 0, 'a fully saved movie costs nothing to re-cut');
    const text = estimateMovieText(est, { capUsd: 60, spentUsd: 0.15 });
    assert.match(text, /Total: about \d+\.\d\d USD \(up to \d+\.\d\d USD/);
    assertWhite(text, 'the estimate');
  });
});

// --- the edit ------------------------------------------------------------------------------

describe('the edit', () => {
  const shots = planShots(SP);
  const takesFor = (over = {}) => Object.fromEntries(shots.map((s) => [s.id, { clipS: s.clipS, speech: s.kind === 'dialogue' ? { startS: 0.5, endS: s.clipS - 0.5 } : null, bestStartS: 0.2, ...(over[s.id] || {}) }]));

  test('never pads: a short take shortens its shot; every shot plays inside its take', () => {
    const shortId = shots.find((s) => s.kind === 'action').id;
    const plan = planMovieEdit({ title: 'T', shots, takes: takesFor({ [shortId]: { clipS: 1.6, bestStartS: 0.2 } }), credits: ['x'] });
    assert.ok(noPadding(plan));
    const seg = plan.segments.find((s) => s.shotId === shortId);
    assert.equal(seg.inS, 0);
    assert.equal(seg.durationS, 1.6, 'played for what the take has (3 s planned), never held');
  });

  test('dialogue plays its whole line; J and L cuts as speakers alternate; cut on action; audio spans cover the runtime', () => {
    const plan = planMovieEdit({ title: 'T', shots, takes: takesFor(), credits: ['x', 'y'] });
    for (const c of plan.dialogue) {
      const seg = plan.segments.find((s) => s.shotId === c.shotId);
      assert.ok(seg.inS <= 0.5 - 0.3 && seg.inS + seg.durationS >= seg.clipS - 0.5, `${c.shotId} carries its whole line`);
    }
    assert.ok(plan.jl.length >= 2, JSON.stringify(plan.jl));
    for (const j of plan.jl) {
      const cue = plan.dialogue.find((c) => c.shotId === (j.kind === 'L' ? j.from : j.to));
      if (j.kind === 'L') assert.ok(cue.atS + cue.durationS > j.cutS + 0.1, 'L: the line runs on under the next picture');
      else assert.ok(cue.atS < j.cutS - 0.1, 'J: the line starts before its picture');
    }
    assert.ok(plan.joins.some((j) => j.cutOnAction));
    assert.equal(plan.scenes[0].startS, 0);
    assert.equal(plan.scenes[plan.scenes.length - 1].endS, plan.totalS, 'the last scene\'s sound runs under the credits');
    for (let i = 1; i < plan.scenes.length; i++) assert.ok(Math.abs(plan.scenes[i].startS - plan.scenes[i - 1].endS) < 1e-6, 'no gap between scenes');
    assert.equal(plan.segments[0].kind, 'card');
    assert.equal(plan.segments[plan.segments.length - 1].kind, 'crawl');
  });

  test('credits: white label, characters and voice names, no copyright line', () => {
    const lines = movieCredits({ sp: SP, cast: { characters: { Mara: { name: 'Alice' }, Tom: { name: 'Callum' } } }, labels: { studio: STUDIO_LABEL, sound: SOUND_LABEL, trademark: TRADEMARK } });
    assert.ok(lines.includes('Mara · voice Alice') && lines.includes('Tom · voice Callum'));
    assertWhite(lines.join('\n'), 'credits');
    assert.ok(!lines.some((l) => /©|copyright/i.test(l)));
  });
});

// --- takes, critic and voices ------------------------------------------------------------

describe('takes and the critic', () => {
  test('the verdict: blocking issues fail a take; a dialogue take with no speech fails; the critic is white-labelled', () => {
    const v = parseTakeVerdict('{"pass":true,"score":9,"issues":[{"type":"lip_sync","detail":"mouth closed; a Veo-like artefact from gemini-omni-1.1-flash"}],"best_start_s":0.4}', { clipS: 5 });
    assert.equal(v.pass, false);
    assertWhite(v.issues[0].detail, 'critic detail');
    assert.equal(parseTakeVerdict('{"pass":true,"score":8,"issues":[]}').pass, true);
    assert.equal(parseTakeVerdict('not json').unreadable, true);
    const ok = parseTakeVerdict('{"pass":true,"score":8,"issues":[]}');
    assert.equal(withSpeechCheck(ok, { kind: 'dialogue' }, null).pass, false);
    assert.equal(withSpeechCheck(ok, { kind: 'action' }, null).pass, true);
    const a = { verdict: { pass: false, score: 7 } };
    const b = { verdict: { pass: true, score: 5 } };
    assert.equal(betterTake(a, b), b, 'a pass beats a higher-scoring fail');
    assert.deepEqual(speechFromSilences([{ startS: 0, endS: 0.6 }, { startS: 4.4, endS: 5 }], 5), { startS: 0.6, endS: 4.4 });
    assert.equal(speechFromSilences([{ startS: 0, endS: 5 }], 5), null);
  });

  test('speech-to-speech keeps the line\'s timing: the converted line is fitted back to the take', { skip: NO_FF }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-sts-'));
    try {
      const take = path.join(dir, 'take.wav');
      await ff.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=24000:duration=4', '-af', "volume=enable='lt(t,1)+gt(t,3)':volume=0", take]);
      const longer = path.join(dir, 'conv.wav');
      await ff.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', take, '-af', 'atempo=0.94', longer]);
      assert.ok(Math.abs((await ff.probeDuration(longer)) - 4.255) < 0.05);
      const fit = await au.fitToLength(longer, 4, path.join(dir, 'fit.wav'));
      assert.ok(Math.abs(fit.durationS - 4) < 0.02, `fitted to the take: ${fit.durationS}`);
      assert.ok(fit.tempo > 1.05 && fit.tempo < 1.07);
      const span = await au.speechSpan(fit.file, 4);
      assert.ok(Math.abs(span.startS - 1) < 0.1 && Math.abs(span.endS - 3) < 0.1, `the words stay where the lips move: ${JSON.stringify(span)}`);
      assert.equal(au.tempoFor(4.01, 4), null, 'within tolerance: untouched');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// --- engines: client licences, references, speech-to-speech ---------------------------------

describe('engines', () => {
  const ENV = { GEMINI_API_KEY_PAID: 'AQ.paid-0123456789', ELEVENLABS_API_KEY: 'sk_el_0123456789', REPLICATE_API_TOKEN: 'r8_0123456789' };

  test('client movies only use commercial_ok engines; no speech engine means no movie, never a silent one', () => {
    __resetRouterState();
    const plan = moviePlan(ENV, { clientWork: true });
    assert.deepEqual(plan.clips.map((s) => [s.provider, s.licence]), [['gemini_paid', 'commercial_ok']]);
    assert.deepEqual(plan.sts.map((s) => [s.provider, s.licence]), [['elevenlabs', 'commercial_ok']]);
    assert.equal(moviePlan({ REPLICATE_API_TOKEN: 'r8_x' }, { clientWork: false }).clips.length, 0, 'the silent clip engine is never a movie engine');
  });

  test('the shot request: 1080p, the prompt and length, each bible reference after its label', async () => {
    const body = dialogueClipBody({ model: 'm', prompt: 'P', seconds: 5, refs: [{ label: 'c1, front', data: 'AAA', mime: 'image/png' }, { label: 'l1, establishing', data: 'BBB', mime: 'image/png' }] });
    assert.equal(body.response_format.resolution, '1080p');
    assert.match(body.input[0].text, /Clip length: 5 seconds\./);
    assert.deepEqual(body.input.slice(1).map((x) => x.type), ['text', 'image', 'text', 'image']);
    assert.match(body.input[1].text, /Reference image \(c1, front\)/);
    __resetRouterState();
    const calls = [];
    const fetchImpl = routedFetch([
      ['https://refs.test/', () => new Response(PNG, { status: 200 })],
      [INTERACTIONS_URL, () => json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: Buffer.from('mp4').toString('base64') }] }] })]
    ], calls);
    const out = await dialogueClip({ env: ENV, prompt: 'Mara says "hi"', seconds: 4, refs: [{ label: 'c1, front', url: 'https://refs.test/a.png' }], clientWork: true, fetchImpl });
    assert.equal(out.bytes.toString(), 'mp4');
    const sent = calls.find((c) => c.url === INTERACTIONS_URL).body;
    assert.equal(sent.input.filter((x) => x.type === 'image').length, 1);
    await assert.rejects(dialogueClip({ env: { REPLICATE_API_TOKEN: 'r8' }, prompt: 'x', seconds: 3, fetchImpl }), (e) => e.code === 'no_speech_engine');
  });

  test('speech-to-speech: the cast voice, the take\'s audio, the plan\'s speech format', async () => {
    __resetRouterState();
    const calls = [];
    const fetchImpl = routedFetch([[ELEVENLABS_STS_URL, () => new Response(Buffer.alloc(24000 * 2), { status: 200 })]], calls);
    const out = await speechToSpeech({ env: ENV, audio: Buffer.from('RIFF'), voiceId: 'voice-mara', seconds: 1, clientWork: true, fetchImpl });
    assert.equal(calls[0].url, `${ELEVENLABS_STS_URL}/voice-mara?output_format=${STS_FORMAT}`);
    assert.ok(calls[0].body instanceof FormData);
    assert.equal(calls[0].body.get('model_id'), 'eleven_multilingual_sts_v2');
    assert.equal(out.wav.toString('ascii', 0, 4), 'RIFF');
    await assert.rejects(speechToSpeech({ env: ENV, audio: Buffer.from('x'), voiceId: null, fetchImpl }), /no cast voice/);
  });
});

// --- the chat: commands, both checkpoints, client voices, white label ------------------------

describe('/movie in the chat', () => {
  let db;
  let store;
  let fetchImpl;
  let dispatched;
  const ENV = { PG1_VIDEO_RENDER_SECRET: 'movie-secret-0123456789abcdef', GITHUB_TOKEN: 'gh-token', ELEVENLABS_API_KEY: 'sk_el_0123456789' };
  const VOICES = { voices: [
    { voice_id: 'premade1', name: 'George', category: 'premade', labels: { gender: 'male', accent: 'british' } },
    { voice_id: 'lib1', name: 'Library Lou', category: 'professional', sharing: { status: 'copied', original_voice_id: 'zzz' } }
  ] };
  before(async () => {
    db = await makeFilmDb();
    dispatched = [];
    fetchImpl = routedFetch([...filmDbRoutes(db), ['api.github.com', (u, o, body) => { dispatched.push(body); return new Response(null, { status: 204 }); }], [VOICES_URL, () => json(VOICES)]]);
    store = createFilmStore({ supUrl: SUP, supKey: 'k', fetchImpl });
  });
  const cmd = (text, isOperator = true) => handleMovieCommand({ text, env: ENV, supUrl: SUP, supKey: 'k', isOperator, fetchImpl, requestId: 'req-1' });
  const decide = (row, decision = 'approve') => handleMovieApproval({ row, decision, env: ENV, supUrl: SUP, supKey: 'k', isOperator: true, fetchImpl });
  const pending = async (type) => (await db.query('select * from pending_actions where action_type = $1 order by created_at desc limit 1', [type])).rows[0];

  test('parsing: idea, --length, --voice (narration only then), --client', () => {
    assert.ok(isMovieCommand('/movie "x"') && !isMovieCommand('/movies'));
    assert.deepEqual(parseMovieCommand('/movie "two bakers share an oven" --length 1'), { sub: 'new', id: null, rest: '', idea: 'two bakers share an oven', minutes: 1, voice: null, client: null });
    const p = parseMovieCommand('/movie "a heist" --voice "George" --client "Acme Films"');
    assert.equal(p.minutes, 2, 'two minutes by default');
    assert.equal(p.voice, 'George');
    assert.deepEqual(p.client, { name: 'Acme Films', credit: true });
    assert.equal(parseMovieCommand('/movie status 1a2b3c4d').sub, 'status');
    assert.ok(FILM_STAGES.includes('movie_script') && FILM_STAGES.includes('movie'));
    assert.equal(filmRenderRef({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'claude/movie-x' }), 'claude/movie-x', 'a preview renders with its own branch');
    assert.equal(filmRenderRef({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' }), 'main');
  });

  test('operator only; a client movie only uses cleared voices', async () => {
    const r = await cmd('/movie "x"', false);
    assert.equal(r.status, 401);
    __resetVoiceCache();
    const refused = await cmd('/movie "a client spot" --voice "Library Lou" --client "Acme"');
    assert.match(refused.reply, /isn't cleared for client work/);
    assert.equal((await db.query('select count(*)::int as n from pg1_film_projects')).rows[0].n, 0, 'nothing created');
  });

  test('both checkpoints block spending: nothing is shot before the screenplay and the estimate are approved', async () => {
    const r = await cmd('/movie "two bakers race the dawn" --length 0.5');
    assertWhite(r.reply, '/movie reply');
    assert.match(r.reply, /No narration: the story is told by the characters on screen/);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].inputs.stage, 'movie_script');
    const id = dispatched[0].inputs.project_id;
    let p = await store.getProject(id);
    assert.equal(p.mode, 'director');
    assert.equal(p.director.kind, 'movie');
    assert.equal(p.status, 'storyboard_queued');

    // The worker writes the screenplay and casts; checkpoint (a).
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mv-chat-'));
    const calls = [];
    const engines = fakeMovieEngines({ dir, calls });
    await store.updateProject(id, { status: 'storyboarding' });
    const s = await runMovieScript({ project: await store.getProject(id), store, engines, workdir: dir });
    assertWhite(s.text, 'MOVIE_SCRIPT');
    assert.match(s.text, /INT\. BAKERY - NIGHT/);
    assert.match(s.text, /- Mara: Alice\n- Tom: Callum/);
    p = await store.getProject(id);
    assert.equal(p.status, 'awaiting_preview_approval');
    assert.equal(Number(p.spent_usd), 0.15, 'only the screenplay was spent on');
    // The shoot cannot run yet.
    await store.updateProject(id, { status: 'directing' });
    await assert.rejects(runMovie({ project: await store.getProject(id), store, engines, workdir: dir }), /not been approved/);
    await store.updateProject(id, { status: 'awaiting_preview_approval' });
    assert.ok(!calls.some((c) => ['still', 'clip', 'sts', 'sfx', 'music'].includes(c.step)), 'no media before both approvals');

    // Checkpoint (a) approved: priced here, no engine call, no dispatch.
    const a = await decide(await pending(MOVIE_ACTIONS.script));
    assertWhite(a.reply, 'MOVIE_BUDGET');
    assert.match(a.reply, /Approve it to start the shoot; nothing is spent before you do/);
    assert.match(a.reply, /Shots with on-screen speech, 1080p/);
    assert.equal(dispatched.length, 1, 'still nothing queued');
    p = await store.getProject(id);
    assert.equal(p.status, 'awaiting_director_approval');
    assert.ok(p.director.approvals.script && !p.director.approvals.budget);
    await store.updateProject(id, { status: 'directing' });
    await assert.rejects(runMovie({ project: await store.getProject(id), store, engines, workdir: dir }), /not been approved/);
    await store.updateProject(id, { status: 'awaiting_director_approval' });
    assert.equal(Number((await store.getProject(id)).spent_usd), 0.15);

    // Checkpoint (b) approved: the shoot is queued.
    const b = await decide(await pending(MOVIE_ACTIONS.budget));
    assertWhite(b.reply, 'budget approved');
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[1].inputs.stage, 'movie');
    p = await store.getProject(id);
    assert.equal(p.status, 'director_queued');
    assert.ok(p.director.approvals.budget);
    // Declining a fresh movie's screenplay cancels it.
    const r2 = await cmd('/movie "another idea" --length 0.5');
    const id2 = dispatched[2].inputs.project_id;
    await store.updateProject(id2, { status: 'storyboarding' });
    await runMovieScript({ project: await store.getProject(id2), store, engines: fakeMovieEngines({ dir, calls: [] }), workdir: dir });
    const dec = await decide(await pending(MOVIE_ACTIONS.script), 'decline');
    assert.match(dec.reply, /cancelled/);
    assertWhite(r2.reply + dec.reply, 'decline');
    assert.equal((await store.getProject(id2)).status, 'cancelled');
    await rm(dir, { recursive: true, force: true });
  });

  test('status, list, screenplay, retake and retry: white label; a retake resets only the named shots', async () => {
    const id = dispatched[0].inputs.project_id;
    const sid = id.slice(0, 8);
    await store.updateProject(id, { status: 'done' });
    for (const t of [`/movie status ${sid}`, '/movie list', `/movie screenplay ${sid}`, '/movie', `/movie retake ${sid} nope`]) {
      const r = await cmd(t);
      assertWhite(r.reply, t);
      if (r.filmProject) assertWhite(JSON.stringify({ ...r.filmProject, previewUrl: null, finalUrl: null, posterUrl: null }), `${t} card`);
    }
    assert.match((await cmd(`/movie screenplay ${sid}`)).reply, /EXT\. BAKERY DOOR - DAWN/);
    assert.match((await cmd(`/movie status ${sid}`)).reply, /Approved cost estimate:\n- Character and location bibles[\s\S]*Total: about \d+\.\d\d USD/);
    const p0 = await store.getProject(id);
    await store.updateProject(id, { director: { ...p0.director, takes: { 's1-d3': { accepted: { clip: 'x' }, attempts: [{ attempt: 1 }] }, 's1-w1': { accepted: { clip: 'w' }, attempts: [{ attempt: 1 }] } } } });
    const r = await cmd(`/movie retake ${sid} s1-d3`);
    assertWhite(r.reply, 'retake');
    assert.match(r.reply, /a new take of s1-d3/);
    const before = dispatched.length;
    const ok = await decide(await pending(MOVIE_ACTIONS.retry));
    assertWhite(ok.reply, 'retake approved');
    assert.equal(dispatched.length, before + 1);
    assert.equal(dispatched[before].inputs.stage, 'movie');
    const p = await store.getProject(id);
    assert.deepEqual(p.director.takes['s1-d3'].attempts, []);
    assert.equal(p.director.takes['s1-d3'].accepted, undefined, 'the named shot gets a new take');
    assert.deepEqual(p.director.takes['s1-w1'].accepted, { clip: 'w' }, 'every other take is kept');
    // A stopped movie: retry from where it stopped.
    await store.updateProject(id, { status: 'failed', error_reason: 'throttled', failure: { stage: 'movie' } });
    const retry = await cmd(`/movie retry ${sid}`);
    assertWhite(retry.reply, 'retry');
    assert.match(retry.reply, /picture engine kept rate-limiting/);
    assert.match(retry.reply, /reused, never made or paid for again/);
  });

  test('help, status, failure and gate wording name no provider or model', () => {
    assertWhite(MOVIE_HELP_TEXT, 'help');
    for (const k of Object.keys(MOVIE_FAILURE_TEXT)) assertWhite(movieFailureMessage({ id: 'abcdef12-0000-0000-0000-000000000000', error_reason: k }), k);
    for (const l of Object.values(MOVIE_STATUS_LABELS)) assertWhite(l, 'status');
    assertWhite(sayMovie('the Gemini Omni engine on Replicate via ElevenLabs'), 'sayMovie');
  });
});

// --- end to end on real ffmpeg ---------------------------------------------------------------

describe('a movie end to end (real edit, mix, master and QC gate)', { skip: NO_FF }, () => {
  let db;
  let store;
  let fetchImpl;
  let dir;
  let calls;
  let id;
  let out;
  let pushes;
  // s1-d3 fails its first take; s2-a2 fails all three takes (kept, flagged),
  // then passes on the QC gate's one extra take.
  const failPlan = { 's1-d3': ['fail', 'pass'], 's2-a2': ['fail', 'fail', 'fail', 'pass'] };

  before(async () => {
    __resetRouterState();
    db = await makeFilmDb();
    fetchImpl = routedFetch(filmDbRoutes(db));
    store = createFilmStore({ supUrl: SUP, supKey: 'k', fetchImpl });
    dir = await mkdtemp(path.join(os.tmpdir(), 'mv-e2e-'));
    calls = [];
    pushes = [];
    const engines = fakeMovieEngines({ dir: path.join(dir, 'fx'), calls, failPlan, clipSize: { width: 640, height: 360 } });
    const p = await store.createProject({ request: 'two bakers race the dawn', capUsd: 60, status: 'storyboarding' });
    id = p.id;
    await store.updateProject(id, { mode: 'director', director: { kind: 'movie', minutes: 0.5, narration: false, approvals: {} } });
    await runMovieScript({ project: await store.getProject(id), store, engines, workdir: path.join(dir, 'w0') });
    const planned = planMovie((await store.getProject(id)).director);
    const d = (await store.getProject(id)).director;
    await store.updateProject(id, { status: 'directing', director: { ...d, bibles: planned.bibles, shots: planned.shots, approvals: { script: 'x', budget: 'y' } } });
    out = await runMovie({ project: await store.getProject(id), store, engines, workdir: path.join(dir, 'w1'), notify: async (n) => pushes.push(n) });
  });
  after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  test('character bible references are passed to every shot', async () => {
    const shots = (await store.getProject(id)).director.shots;
    const clips = calls.filter((c) => c.step === 'clip');
    assert.ok(clips.length >= shots.length);
    for (const c of clips) {
      const shot = shots.find((s) => s.id === c.shot);
      for (const ch of shot.characters) assert.ok(c.refs.includes(`${ch}, front`), `${c.shot} take ${c.take} carries ${ch}`);
      assert.ok(c.prompt.includes(NO_TEXT));
    }
    // The three-quarter and full views are drawn from the front view.
    const stills = calls.filter((c) => c.step === 'still');
    assert.equal(stills.length, 8);
    assert.equal(stills.filter((s) => s.referenceUrl).length, 4);
    // The critic saw the bible for everyone in the shot.
    for (const q of calls.filter((c) => c.step === 'dailies')) {
      const shot = shots.find((s) => s.id === q.shot);
      for (const ch of shot.characters) assert.ok(q.refs.includes(`Bible reference ${ch}:front:`), `${q.shot}`);
    }
  });

  test('retake loop: a failing shot is retaken, at most twice, then the best take is kept and flagged; the gate fixes it once', () => {
    const takes = (s) => calls.filter((c) => c.step === 'clip' && c.shot === s).length;
    assert.equal(takes('s1-d3'), 2, 'one retake, then it passed');
    assert.equal(takes('s2-a2'), 1 + MAX_RETAKES + 1, 'two retakes, flagged, then the QC gate\'s one extra take');
    assert.equal(takes('s1-w1'), 1);
    assert.deepEqual(out.report.gate.firstProblems, ['shot s2-a2 still flagged by the dailies']);
    assert.equal(out.report.gate.fixedOnce, true);
    assert.deepEqual(out.report.flagged, []);
    // Each line in its character's cast voice.
    const sts = calls.filter((c) => c.step === 'sts');
    assert.ok(sts.length >= 6);
    assert.ok(sts.every((c) => ['voice-mara', 'voice-tom'].includes(c.voiceId)));
  });

  test('the master meets the spec; no freeze; no silence; -14 LUFS; the critic passed', () => {
    const g = out.gate;
    assert.equal(g.pass, true, JSON.stringify(g.problems));
    assert.match(g.probeLine, /^h264 \(High\) 640x360 24 fps \d+ kb\/s; aac \d+ kb\/s 48000 Hz stereo/);
    assert.equal(g.probe.width, 640, 'the takes\' own frame, never lower');
    assert.ok(g.probe.videoKbps >= ff.minVideoKbps({ width: 640, height: 360 }));
    assert.deepEqual(g.freezes, []);
    assert.deepEqual(g.silences, []);
    assert.ok(Math.abs(g.loudness.integrated - -14) <= 1, `${g.loudness.integrated}`);
    assert.ok(g.loudness.truePeak <= -1);
    assert.equal(g.consistency.pass, true);
    assert.ok(noPadding(out.plan));
    assert.ok(out.plan.jl.length >= 1, 'J and L cuts on dialogue');
    assertWhite(out.report.gate.text, 'gate text');
    assertWhite(JSON.stringify(pushes), 'push');
  });

  test('audio covers the runtime: three stems, each as long as the picture', async () => {
    const p = await store.getProject(id);
    assert.equal(p.status, 'done');
    assert.deepEqual(Object.keys(p.qc_report.stems).sort(), ['dialogue', 'effects', 'score']);
    const probe = await ff.probeMedia(path.join(dir, 'w1', 'movie-v2.mp4'));
    assert.ok(Math.abs(probe.durationS - out.plan.totalS) < 0.1);
    for (const f of ['dialogue', 'effects', 'score']) {
      const s = path.join(dir, 'w1', `v2-stem-${f}.wav`);
      assert.ok(Math.abs((await ff.probeDuration(s)) - out.plan.totalS) < 0.05, f);
    }
    // The score cues came back 6 s long; they still play to the end, and the
    // last one runs under the credits.
    const sil = await ff.detectSilences(path.join(dir, 'w1', 'v2-stem-score.wav'), { totalS: out.plan.totalS, minS: 1.5 });
    assert.deepEqual(sil, []);
  });

  test('saved and reused: a retry re-cuts from what is saved, with no new screenplay, cast, reference or take', async () => {
    const before = calls.length;
    const engines = fakeMovieEngines({ dir: path.join(dir, 'fx'), calls });
    await store.updateProject(id, { status: 'storyboarding' });
    await runMovieScript({ project: await store.getProject(id), store, engines, workdir: path.join(dir, 'w2') });
    await store.updateProject(id, { status: 'directing' });
    const again = await runMovie({ project: await store.getProject(id), store, engines, workdir: path.join(dir, 'w3') });
    const newCalls = calls.slice(before);
    assert.deepEqual(newCalls.filter((c) => c.step === 'think' && c.purpose === 'movie: screenplay'), [], 'the screenplay is reused');
    assert.ok(newCalls.filter((c) => c.step === 'cast').every((c) => c.reused), 'the cast is reused');
    assert.deepEqual(newCalls.filter((c) => ['still', 'clip', 'sts', 'sfx', 'music'].includes(c.step)), [], 'nothing approved is made again');
    assert.equal(again.gate.pass, true);
    const sets = savedSets((await store.getProject(id)).director);
    assert.equal(sets.takes.size, (await store.getProject(id)).director.shots.length);
  });
});

// --- the gate's fixes and the critic pass (no ffmpeg) -------------------------------------------

describe('QC gate fixes', () => {
  test('a held frame shortens its shot; a silence adds room tone; flagged shots get one more take', () => {
    const plan = { segments: [{ kind: 'card', startS: 0, durationS: 3 }, { kind: 'shot', shotId: 'a', startS: 2.5, durationS: 4 }, { kind: 'shot', shotId: 'b', startS: 6.5, durationS: 3 }] };
    const gate = { problems: [{ check: 'freeze', span: { startS: 7, endS: 8.5 } }, { check: 'silence', span: { startS: 1, endS: 4 } }] };
    const fix = gateFixes(gate, plan, consistencyPass({ a: { flagged: true }, b: { flagged: false } }, [{ id: 'a' }, { id: 'b' }]));
    assert.deepEqual(fix, { trims: { b: 1.5 }, roomTone: true, retake: ['a'] });
  });
});

describe('budget gate on the worker side', () => {
  test('a movie approved for its screenplay but not its estimate never reaches an engine', async () => {
    const calls = [];
    const engines = fakeMovieEngines({ dir: os.tmpdir(), calls });
    const project = { id: '00000000-0000-0000-0000-000000000001', director: { kind: 'movie', screenplay: SP, approvals: { script: 'x' } }, request: 'x' };
    const store = { updateProject: async () => [], getProject: async () => project };
    await assert.rejects(runMovie({ project, store, engines, workdir: path.join(os.tmpdir(), 'mv-none') }), (e) => e.code === 'not_approved');
    assert.deepEqual(calls, []);
  });
});

// keep imports used
void readFile; void writeFile;

// --- the render worker's movie stages ----------------------------------------------------------

describe('render worker: movie stages', () => {
  const SECRET = 'movie-worker-secret-0123456789abcdef';
  test('movie_script claims the queued movie, writes and casts, pushes; a shoot with no speech engine stops with a PG1 reason', async () => {
    const { main: workerMain } = await import('../scripts/film-render.mjs');
    const { signFilmToken } = await import('../lib/film/dispatch.mjs');
    const db = await makeFilmDb();
    const fetchImpl = routedFetch(filmDbRoutes(db));
    const store = createFilmStore({ supUrl: SUP, supKey: 'k', fetchImpl });
    const saved = { ...process.env };
    process.env.SUPABASE_URL = SUP;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    try {
      const p = await store.createProject({ request: 'two bakers', capUsd: 60, status: 'storyboard_queued' });
      await store.updateProject(p.id, { mode: 'director', director: { kind: 'movie', minutes: 0.5, narration: false, approvals: {} } });
      const env = { ...process.env, PG1_VIDEO_RENDER_SECRET: SECRET, FILM_PROJECT_ID: p.id, FILM_STAGE: 'movie_script' };
      env.FILM_TOKEN = signFilmToken(p.id, env);
      const pushes = [];
      const engines = fakeMovieEngines({ dir: os.tmpdir(), calls: [] });
      const logs = [];
      assert.equal(await workerMain(env, { engines, fetchImpl, ffImpl: ff, log: (l) => logs.push(l), notify: async (n) => pushes.push(n) }), 0, logs.join('\n'));
      const after1 = await store.getProject(p.id);
      assert.equal(after1.status, 'awaiting_preview_approval');
      assert.ok(after1.pending_token);
      assert.equal(pushes.length, 1);
      assertWhite(JSON.stringify(pushes), 'push');
      // The shoot, approved, on a deployment whose only clip engine makes no sound.
      await store.updateProject(p.id, { status: 'director_queued', director: { ...after1.director, approvals: { script: 'x', budget: 'y' } } });
      const env2 = { ...env, FILM_STAGE: 'movie' };
      const silent = { ...engines, dialogueClip: async () => { const { dialogueClip: real } = await import('../lib/movie/engines.mjs'); return real({ env: { REPLICATE_API_TOKEN: 'r8' }, prompt: 'x', seconds: 3, fetchImpl }); } };
      assert.equal(await workerMain(env2, { engines: silent, fetchImpl, ffImpl: ff, log: (l) => logs.push(l), notify: async () => {} }), 1);
      const stopped = await store.getProject(p.id);
      assert.equal(stopped.status, 'failed');
      assert.equal(stopped.error_reason, 'no_speech_engine');
      assertWhite(movieFailureMessage(stopped), 'failure message');
      assert.match(movieFailureMessage(stopped), /no picture engine that can show characters speaking/);
    } finally {
      process.env = saved;
    }
  });
});
