/**
 * PG1 Studio, one film end to end on the real engines (network mocked):
 * storyboard -> stills -> clips -> voiceover -> music bed -> render, through
 * the render worker (scripts/film-render.mjs) stage by stage, with every
 * outbound call recorded and each step's engine checked against the
 * capability registry (lib/capabilities/registry.mjs).
 *
 * Also: the voiceover never fails a film on its own (Cartesia is sent once
 * more on a timeout, then ElevenLabs takes the rest of the stage, and the
 * lines Cartesia made are recorded again so the film has one voice), and a
 * Lyria 429 leaves the film finished without music, with a note.
 *
 * Run with: node --test tests/film-e2e-trace.test.mjs
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { __resetRouterState, ENGINE_LABELS } from '../lib/aiRouter.mjs';
import { capability } from '../lib/capabilities/registry.mjs';
import {
  REPLICATE_API, GEMINI_API, ANTHROPIC_URL, CARTESIA_TTS_SSE_URL, CARTESIA_STT_URL, ELEVENLABS_TTS_URL,
  createFilmVoice, newVoiceStage, synthesizeLine, wordsFromAlignment, isVoiceRetryable, EngineError, filmModels
} from '../lib/film/providers.mjs';
import { filmMusicPlan } from '../lib/music/engines.mjs';
import { filmMusicExclude } from '../lib/film/providers.mjs';
import { QC_SYSTEM } from '../lib/film/qc.mjs';
import { FILM_PRICES } from '../lib/film/cost.mjs';
import { createFilmStore } from '../lib/film/store.mjs';
import { signFilmToken } from '../lib/film/dispatch.mjs';
import { VOICE_LABELS } from '../lib/film/pipeline.mjs';
import { filmCard, handleFilmCommand } from '../lib/film/chat.mjs';
import { main as workerMain, realEngines } from '../scripts/film-render.mjs';
import { UPSTREAM_BRAND_RE } from '../lib/upstreamFailure.mjs';
import * as realFf from '../lib/film/ffmpeg.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch, json } from './helpers/filmDb.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase.test';
const SECRET = 'film-render-secret-0123456789abcdef';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const KEYS = {
  REPLICATE_API_TOKEN: 'r8_trace_stub_0123456789abcdef', GEMINI_API_KEY_PAID: 'AQ.trace-paid-0123456789', GEMINI_API_KEY_FREE: 'AIza-trace-free-0123456789',
  ANTHROPIC_API_KEY: 'sk-ant-trace-0123456789', CARTESIA_API_KEY: 'sk_car_trace_0123456789', ELEVENLABS_API_KEY: 'sk_el_trace_0123456789',
  PG1_VIDEO_MODEL_REPLICATE_IMAGE: 'kwaivgi/kling-v2.1', PG1_FILM_VOICE_TIMEOUT_MS: '40'
};

// A 20-second film: two scenes, four 5-second shots, three voiceover lines.
const LINES = ['The city wakes slowly.', 'Coffee steams on the counter.', 'And the day begins.'];
function storyboardJson() {
  return {
    title: 'Morning Shift', logline: 'A cafe opens at dawn.', tier: 'standard',
    style: { look: 'warm, soft light, 35mm', grade: 'warm', reference_prompt: 'Ana, a barista in a green apron' },
    characters: [{ id: 'c1', name: 'Ana', description: 'barista, green apron, short dark hair' }],
    captions: { enabled: true }, title_card: null, end_card: null,
    scenes: [
      { id: 's1', title: 'Street', music: { mood: 'soft piano', bpm: 84 }, shots: [
        { id: 's1-sh1', duration_s: 5, camera: 'drone_flyover', description: 'drone shot over the street', visual_prompt: 'Aerial shot of a quiet street at dawn', voiceover: LINES[0], transition: 'cut', characters: [] },
        { id: 's1-sh2', duration_s: 5, camera: 'push_in', description: 'Ana unlocks the cafe', visual_prompt: 'Ana unlocks the cafe door', voiceover: '', transition: 'dissolve', characters: ['c1'] }
      ] },
      { id: 's2', title: 'Counter', music: { mood: 'light jazz', bpm: 96 }, shots: [
        { id: 's2-sh1', duration_s: 5, camera: 'static', description: 'coffee machine', visual_prompt: 'Steam rises from a coffee machine', voiceover: LINES[1], transition: 'cut', characters: [] },
        { id: 's2-sh2', duration_s: 5, camera: 'tracking', description: 'Ana serves the first cup', visual_prompt: 'Ana hands over the first cup', voiceover: LINES[2], continuous: true, transition: 'cut', characters: ['c1'] }
      ] }
    ]
  };
}

function fakeFf() {
  const touch = async (f, what) => { await writeFile(f, what); return f; };
  return {
    FILM_SIZES: realFf.FILM_SIZES, TARGET_LUFS: realFf.TARGET_LUFS, buildAss: realFf.buildAss, writeText: realFf.writeText,
    probeDuration: async () => 5,
    extractFrame: (i, t, out) => touch(out, 'frame'),
    extractLastFrame: (i, out) => touch(out, 'last'),
    thumbnail: (i, t, out) => touch(out, 'thumb'),
    segmentFromStill: (s, o) => touch(o.out, 'still-seg'),
    segmentFromClip: (c, o) => touch(o.out, 'clip-seg'),
    segmentCard: (o) => touch(o.out, 'card'),
    joinSegments: (files, d, j, out) => touch(out, 'join'),
    mixAudio: async (o) => { mixes.push(o); return touch(o.out, 'mix'); },
    normaliseLoudness: async (i, out) => { await touch(out, 'loud'); return { file: out, measured: { input_i: '-22' }, after: { input_i: '-14.0' } }; },
    finalEncode: (o) => touch(o.out, 'final'),
    extractAudioForCheck: (i, out) => touch(out, 'wav')
  };
}
let mixes = [];

const sse = (events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const hang = (o) => new Promise((resolve, reject) => {
  const sig = o.signal;
  if (sig) sig.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
});
// A transcript of the narration as written.
const heard = () => LINES.join(' ');

// Every engine PG1 Studio calls, mocked. `trace` records each call as
// { step, provider, model }. Hooks in `st` change one engine's answers.
function engineRoutes(trace, st) {
  return [
    ['api.github.com', () => new Response(null, { status: 204 })],
    [ANTHROPIC_URL, (u, o, body) => {
      const qc = body.system === QC_SYSTEM;
      trace.push({ step: qc ? 'shot check' : 'storyboard', provider: 'anthropic', model: body.model });
      const text = qc ? '{"pass":true,"score":8,"issues":[],"best_start_s":0.5,"description":"as described"}' : JSON.stringify(storyboardJson());
      return json({ model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 } });
    }],
    [`${REPLICATE_API}/models/`, (u) => {
      const model = u.split('/models/')[1].split('/predictions')[0];
      const video = /kling|video/.test(model);
      trace.push({ step: video ? 'clip' : 'still', provider: 'replicate', model });
      if (st.replicate) { const r = st.replicate(trace.filter((t) => t.provider === 'replicate').length, model); if (r) return r; }
      return json({ id: `pred-${trace.length}`, status: 'succeeded', output: `https://replicate.delivery/out-${trace.length}.${video ? 'mp4' : 'png'}` }, 201);
    }],
    ['https://replicate.delivery/', () => new Response(Buffer.from('media-bytes'), { status: 200 })],
    [`${GEMINI_API}/`, (u) => {
      const model = decodeURIComponent(u.split('/models/')[1].split(':')[0]);
      if (/lyria/.test(model)) {
        trace.push({ step: 'music', provider: 'gemini_paid', model });
        if (st.lyria) { const r = st.lyria(model); if (r) return r; }
        return json({ candidates: [{ content: { parts: [{ text: 'instrumental' }, { inlineData: { mimeType: 'audio/mpeg', data: Buffer.from('lyria-mp3').toString('base64') } }] } }] });
      }
      trace.push({ step: 'still', provider: 'gemini_paid', model });
      return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] });
    }],
    [CARTESIA_TTS_SSE_URL, (u, o, body) => {
      trace.push({ step: 'voice', provider: 'cartesia', model: body.model_id, text: body.transcript });
      if (st.cartesia) { const r = st.cartesia(body.transcript, o); if (r) return r; }
      const words = body.transcript.split(/\s+/);
      return sse([
        { type: 'chunk', data: Buffer.alloc(4410 * 2).toString('base64') },
        { type: 'timestamps', word_timestamps: { words, start: words.map((w, i) => i * 0.3), end: words.map((w, i) => i * 0.3 + 0.25) } },
        { type: 'done' }
      ]);
    }],
    [CARTESIA_STT_URL, () => { trace.push({ step: 'transcript', provider: 'cartesia', model: 'ink-whisper' }); return json({ text: heard() }); }],
    [`${ELEVENLABS_TTS_URL}/`, (u, o, body) => {
      trace.push({ step: 'voice', provider: 'elevenlabs', model: body.model_id, text: body.text, format: new URL(u).searchParams.get('output_format') });
      const chars = [...body.text];
      return json({ audio_base64: Buffer.alloc(2400 * 2).toString('base64'), alignment: { characters: chars, character_start_times_seconds: chars.map((c, i) => i * 0.05), character_end_times_seconds: chars.map((c, i) => i * 0.05 + 0.04) } });
    }]
  ];
}

// The registry's model for a feature and provider (google -> the paid key).
const registryModel = (feature, provider, role = null) => {
  const p = { gemini_paid: 'google' }[provider] || provider;
  const m = capability(feature).models.find((x) => x.provider === p && (!role || x.role.startsWith(role)));
  return m ? m.model : null;
};

beforeEach(() => { __resetRouterState(); mixes = []; });
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

describe('one film end to end on the real engines', () => {
  let db;
  let store;
  let fetchImpl;
  let trace;
  let st;
  beforeEach(async () => {
    db = await makeFilmDb();
    trace = [];
    st = {};
    fetchImpl = routedFetch([...filmDbRoutes(db), ...engineRoutes(trace, st)]);
    store = createFilmStore({ supUrl: SUP_URL, supKey: 'service-key', fetchImpl });
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: SUP_URL, SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
    globalThis.fetch = fetchImpl;
  });

  const runStage = async (p, stage, queued) => {
    await store.updateProject(p.id, { status: queued });
    const env = { ...process.env, ...KEYS, PG1_VIDEO_RENDER_SECRET: SECRET, FILM_PROJECT_ID: p.id, FILM_STAGE: stage };
    env.FILM_TOKEN = signFilmToken(p.id, env);
    const logs = [];
    const engines = realEngines(env, { fetchImpl, log: (l) => logs.push(l), sleep: async () => {} });
    const code = await workerMain(env, { engines, fetchImpl, ffImpl: fakeFf(), log: (l) => logs.push(l) });
    return { code, logs, film: await store.getProject(p.id) };
  };

  test('storyboard -> stills -> clips -> voiceover -> music -> render: each step on the engine the registry names; Cartesia timing out never fails the film', async () => {
    const p = await store.createProject({ request: 'A cafe opening at dawn, 20 seconds', capUsd: 20, status: 'storyboard_queued' });
    // The second line times out on Cartesia twice: one retry, then ElevenLabs.
    st.cartesia = (text, o) => (text === LINES[1] ? hang(o) : null);

    // 1. Storyboard.
    let r = await runStage(p, 'storyboard', 'storyboard_queued');
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.status, 'awaiting_preview_approval');
    const sb = trace.filter((t) => t.step === 'storyboard');
    assert.deepEqual(sb.map((t) => `${t.provider}/${t.model}`), [`anthropic/${filmModels({}).claude}`], 'the heavy route: Claude first, on the paid key');

    // 2. Preview: reference + stills, voiceover, music, animatic.
    trace.length = 0;
    r = await runStage(p, 'preview', 'preview_queued');
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.status, 'preview_done');
    const stills = trace.filter((t) => t.step === 'still');
    assert.equal(stills.length, 1 + 4, 'the reference and one still per shot');
    assert.ok(stills.every((t) => t.provider === 'replicate' && t.model === registryModel('storyboard_keyframes', 'replicate', 'primary')), 'stills: the registry\'s primary (flux-kontext-pro on Replicate)');
    const voice = trace.filter((t) => t.step === 'voice');
    assert.deepEqual(voice.map((t) => `${t.provider}:${LINES.indexOf(t.text)}`), [
      'cartesia:0', // line 1 on Cartesia
      'cartesia:1', 'cartesia:1', // line 2 times out, is sent once more, times out again
      'elevenlabs:1', 'elevenlabs:2', // ElevenLabs from then on
      'elevenlabs:0' // line 1 recorded again, so the film has one voice
    ]);
    assert.equal(voice[0].model, registryModel('voiceover_single', 'cartesia'));
    assert.ok(voice.filter((t) => t.provider === 'elevenlabs').every((t) => t.model === registryModel('voiceover_single', 'elevenlabs') && t.format === 'pcm_24000'));
    const music = trace.filter((t) => t.step === 'music');
    assert.deepEqual(music.map((t) => t.model), [registryModel('film_music', 'gemini_paid', 'primary'), registryModel('film_music', 'gemini_paid', 'primary')], 'one Lyria 3.5 bed per scene, on the paid Gemini key');
    assert.ok(!trace.some((t) => t.provider === 'replicate' && /lyria|music/.test(t.model)), 'never Replicate\'s Lyria for a film');
    assert.ok(!trace.some((t) => t.step === 'clip'), 'no clips in the preview');

    let assets = await store.listAssets(p.id);
    const lines = assets.filter((a) => a.kind === 'voice' && a.status === 'ok');
    assert.equal(lines.length, 3);
    assert.ok(lines.every((a) => a.meta.engine === VOICE_LABELS.elevenlabs), 'one voice throughout');
    assert.ok(lines.every((a) => a.meta.words.length > 0), 'word timings for captions');
    const replaced = await store.listAssets(p.id, { kinds: ['voice'], status: 'superseded' });
    assert.deepEqual(replaced.map((a) => a.meta.engine), [VOICE_LABELS.cartesia], 'the Cartesia take of line 1 is replaced, never reused');
    assert.deepEqual(r.film.qc_report.voice, { engine: VOICE_LABELS.elevenlabs, retries: 1, rerecorded: 1, fallback: { from: VOICE_LABELS.cartesia, to: VOICE_LABELS.elevenlabs, reason: 'timeout' } });
    assert.equal(r.film.qc_report.music.unavailable, false);
    assert.ok(r.logs.some((l) => /voiceover: cartesia failed \(timeout/.test(l)));

    // 3. Full: clips, checks, edit, mix, transcript.
    trace.length = 0;
    r = await runStage(p, 'full', 'full_queued');
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.status, 'done');
    const clips = trace.filter((t) => t.step === 'clip');
    assert.equal(clips.length, 4, 'one clip per shot, every one passing its check');
    // The registry lists this model for clips, but as the fallback: film
    // shots go to Replicate first (lib/film/providers.mjs FILM_MEDIA_ENGINES),
    // the paid Gemini key only when Replicate is out of credit or throttled.
    assert.ok(clips.every((t) => t.provider === 'replicate' && t.model === registryModel('text_image_to_video', 'replicate')));
    assert.equal(trace.filter((t) => t.step === 'shot check').length, 4);
    assert.ok(trace.filter((t) => t.step === 'shot check').every((t) => t.provider === 'anthropic'));
    assert.ok(!trace.some((t) => t.step === 'voice' || t.step === 'music' || t.step === 'still'), 'voice, music and stills reused from the preview');
    assert.deepEqual(trace.filter((t) => t.step === 'transcript').map((t) => t.provider), ['cartesia']);
    assert.equal(r.film.qc_report.audio.ok, true, 'the voiceover was heard as written');
    assert.equal(r.film.qc_report.voice.engine, VOICE_LABELS.elevenlabs, 'the full render keeps the preview\'s voice');
    assert.equal(mixes.at(-1).music.length, 2, 'both music beds in the final mix');
    assert.equal(mixes.at(-1).voice.length, 3);

    // Never the free Gemini key, on any step.
    assert.ok(!fetchImpl.calls.some((c) => JSON.stringify(c.headers).includes(KEYS.GEMINI_API_KEY_FREE)));
    assets = await store.listAssets(p.id);
    assert.ok(assets.some((a) => a.kind === 'final'));
    // Every charge is an asset's cost, except the storyboard and the audio check.
    const assetUsd = assets.reduce((s, a) => s + Number(a.cost_usd || 0), 0);
    assert.ok(Number(r.film.spent_usd) >= assetUsd - 0.005, 'nothing made without being charged');
    assert.ok(Number(r.film.spent_usd) > 0 && Number(r.film.spent_usd) <= 20);
  });

  test('a still job that fails reading its reference from storage (run 17) is made once more, and the preview finishes', async () => {
    const p = await store.createProject({ request: 'A cafe opening at dawn', capUsd: 20, status: 'storyboard_queued' });
    assert.equal((await runStage(p, 'storyboard', 'storyboard_queued')).code, 0);
    // Replicate's own words from run 17, on the first shot still.
    st.replicate = (n) => (n === 2 ? json({ id: 'pred-x', status: 'failed', error: "HTTPSConnectionPool(host='x.supabase.co', port=443): Read timed out." }, 201) : null);
    trace.length = 0;
    const r = await runStage(p, 'preview', 'preview_queued');
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.status, 'preview_done');
    assert.equal(trace.filter((t) => t.step === 'still').length, 1 + 4 + 1, 'the reference, four stills and one second try');
    assert.ok(r.logs.some((l) => /making it once more/.test(l)));
  });

  test('Lyria rate limited (429) on both its models: the film still finishes, without music, and says so', async () => {
    const p = await store.createProject({ request: 'A cafe opening at dawn', capUsd: 20, status: 'storyboard_queued' });
    assert.equal((await runStage(p, 'storyboard', 'storyboard_queued')).code, 0);
    st.lyria = () => new Response(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }), { status: 429 });
    trace.length = 0;
    const r = await runStage(p, 'preview', 'preview_queued');
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.status, 'preview_done');
    const music = trace.filter((t) => t.step === 'music');
    assert.ok(music.length >= 2, 'Lyria 3.5 then the clip model were tried');
    assert.ok(music.some((t) => /clip/.test(t.model)));
    assert.ok(music.every((t) => t.provider === 'gemini_paid'));
    const perScene = new Set(music.map((t) => t.model));
    assert.equal(perScene.size, 2);
    assert.ok(!music.slice(music.findIndex((t) => /clip/.test(t.model)) + 1).some((t) => !/clip/.test(t.model)), 'the second scene was not tried once Lyria was throttled');
    assert.deepEqual(r.film.qc_report.music.scenes, [1, 2]);
    assert.equal(r.film.qc_report.music.reason, 'throttled');
    assert.equal(mixes.at(-1).music.length, 0, 'voice alone in the mix');
    assert.equal(mixes.at(-1).voice.length, 3);
    const assets = await store.listAssets(p.id);
    // Spent: the storyboard (no asset row) and what was made, nothing for music.
    assert.equal(Number(r.film.spent_usd).toFixed(2), (FILM_PRICES.storyboardUsd + assets.reduce((s, a) => s + Number(a.cost_usd || 0), 0)).toFixed(2), 'the music reservations were given back');
    const card = await filmCard(store, r.film);
    assert.match(card.checks.music.note, /^Music unavailable/);
    const status = await handleFilmCommand({ env: { ...process.env, ...KEYS, PG1_VIDEO_ENABLED: '1' }, supUrl: SUP_URL, supKey: 'service-key', fetchImpl, text: `/film status ${p.id.slice(0, 8)}`, isOperator: true });
    assert.match(status.reply, /Music unavailable/);
    assert.doesNotMatch(status.reply, UPSTREAM_BRAND_RE);
  });
});

describe('the voiceover engine', () => {
  const env = { CARTESIA_API_KEY: 'c', ELEVENLABS_API_KEY: 'e' };
  const cartesiaOk = () => sse([{ type: 'chunk', data: Buffer.alloc(100).toString('base64') }, { type: 'done' }]);
  const elOk = (text = 'hi there') => json({ audio_base64: Buffer.alloc(48).toString('base64'), alignment: { characters: [...text], character_start_times_seconds: [...text].map((c, i) => i / 10), character_end_times_seconds: [...text].map((c, i) => i / 10 + 0.05) } });
  const engineOf = (u) => (u.startsWith(CARTESIA_TTS_SSE_URL) ? 'cartesia' : 'elevenlabs');

  test('a Cartesia timeout is a timeout error, not a crash', async () => {
    await assert.rejects(synthesizeLine({ env, text: 'x', timeoutMs: 20, fetchImpl: (u, o) => hang(o) }), (e) => e instanceof EngineError && e.kind === 'timeout' && e.engine === 'cartesia');
  });

  test('one retry on a timeout or 5xx; a bad key goes straight to ElevenLabs', () => {
    assert.equal(isVoiceRetryable(new EngineError('timeout', 'x')), true);
    assert.equal(isVoiceRetryable(new EngineError('engine', 'x', { status: 503 })), true);
    assert.equal(isVoiceRetryable(new EngineError('engine', 'x', { status: 429 })), true);
    assert.equal(isVoiceRetryable(new EngineError('engine', 'x', { status: 401 })), false);
    assert.equal(isVoiceRetryable(new EngineError('engine', 'x', { status: 402 })), false);
  });

  test('a timeout then success stays on Cartesia', async () => {
    let n = 0;
    const calls = [];
    const voice = createFilmVoice({ env, timeoutMs: 20, sleep: async () => {}, log: () => {}, fetchImpl: (u, o) => { calls.push(engineOf(u)); return ++n === 1 ? hang(o) : cartesiaOk(); } });
    const stage = newVoiceStage();
    const line = await voice({ text: 'hello', stage });
    assert.equal(line.engine, 'cartesia');
    assert.deepEqual(calls, ['cartesia', 'cartesia']);
    assert.deepEqual(stage, { engine: 'cartesia', retries: 1, switched: null });
  });

  test('Cartesia down: ElevenLabs takes this line and the rest of the stage', async () => {
    const calls = [];
    const voice = createFilmVoice({ env, sleep: async () => {}, log: () => {}, fetchImpl: (u) => { calls.push(engineOf(u)); return engineOf(u) === 'cartesia' ? new Response('down', { status: 503 }) : elOk(); } });
    const stage = newVoiceStage();
    assert.equal((await voice({ text: 'hi there', stage })).engine, 'elevenlabs');
    assert.equal((await voice({ text: 'hi there', stage })).engine, 'elevenlabs');
    assert.deepEqual(calls, ['cartesia', 'cartesia', 'elevenlabs', 'elevenlabs'], 'Cartesia is not asked again this stage');
    assert.equal(stage.switched.from, 'cartesia');
    const r401 = [];
    const v2 = createFilmVoice({ env, sleep: async () => {}, log: () => {}, fetchImpl: (u) => { r401.push(engineOf(u)); return engineOf(u) === 'cartesia' ? new Response('bad key', { status: 401 }) : elOk(); } });
    await v2({ text: 'hi there' });
    assert.deepEqual(r401, ['cartesia', 'elevenlabs'], 'no retry on a bad key');
  });

  test('a stage on ElevenLabs falls back to Cartesia when ElevenLabs fails', async () => {
    const voice = createFilmVoice({ env, sleep: async () => {}, log: () => {}, fetchImpl: (u) => (engineOf(u) === 'cartesia' ? cartesiaOk() : new Response('quota', { status: 429 })) });
    const stage = { ...newVoiceStage(), engine: 'elevenlabs' };
    assert.equal((await voice({ text: 'x', stage })).engine, 'cartesia');
    assert.deepEqual(stage.switched && [stage.switched.from, stage.switched.to], ['elevenlabs', 'cartesia']);
  });

  test('both down, or no backup key: a clear error naming the fallback', async () => {
    const both = createFilmVoice({ env, sleep: async () => {}, log: () => {}, fetchImpl: () => new Response('down', { status: 503 }) });
    await assert.rejects(both({ text: 'x' }), (e) => e.engine === 'cartesia' && e.fallback.engine === 'elevenlabs' && e.fallback.outcome === 'failed');
    const alone = createFilmVoice({ env: { CARTESIA_API_KEY: 'c' }, sleep: async () => {}, log: () => {}, fetchImpl: () => new Response('down', { status: 503 }) });
    await assert.rejects(alone({ text: 'x' }), (e) => e.fallback.outcome === 'not_configured');
  });

  test('ElevenLabs character timings become words', () => {
    const t = 'Hi  there.';
    const words = wordsFromAlignment({ characters: [...t], character_start_times_seconds: [...t].map((c, i) => i), character_end_times_seconds: [...t].map((c, i) => i + 0.5) });
    assert.deepEqual(words, [{ word: 'Hi', start: 0, end: 1.5 }, { word: 'there.', start: 4, end: 9.5 }]);
    assert.deepEqual(wordsFromAlignment(null), []);
  });

  test('film beds: Lyria 3.5, then the clip model; never ElevenLabs or Replicate without film rights', () => {
    const plan = filmMusicPlan({ GEMINI_API_KEY_PAID: 'p', ELEVENLABS_API_KEY: 'e', REPLICATE_API_TOKEN: 'r' }, { exclude: filmMusicExclude({}) });
    assert.deepEqual(plan.map((c) => `${c.provider}:${c.models[0]}${c.clip ? ':clip' : ''}`), ['gemini_paid:lyria-3.5', 'gemini_paid:lyria-3-clip-preview:clip']);
    assert.deepEqual(plan.map((c) => c.models[0]), capability('film_music').models.map((m) => m.model), 'the registry\'s film_music order');
  });

  test('the PG1 labels never name a provider', () => {
    for (const l of Object.values(VOICE_LABELS)) assert.doesNotMatch(l, UPSTREAM_BRAND_RE);
    assert.equal(VOICE_LABELS.cartesia, ENGINE_LABELS.cartesia);
  });
});
