/**
 * PG1 Studio, one film end to end on the real engines (network mocked):
 * storyboard -> stills -> clips -> voiceover -> music bed -> render, through
 * the render worker (scripts/film-render.mjs) stage by stage, with every
 * outbound call recorded and each step's engine checked against the
 * capability registry (lib/capabilities/registry.mjs).
 *
 * Also: the voiceover never fails a film on its own (the ElevenLabs brand
 * voice is sent once more on a timeout, then Cartesia takes the rest of the
 * stage, and the lines made before are recorded again so the film has one
 * voice); a clip engine that runs out mid-stage hands the rest to the next
 * one and the earlier clips are made again (one clip style); a client film
 * uses licensed engines only; a Lyria 429 leaves the film finished without
 * music, with a note.
 *
 * Run with: node --test tests/film-e2e-trace.test.mjs
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { __resetRouterState, ENGINE_LABELS, memoryLedger, utcDay } from '../lib/aiRouter.mjs';
import { INTERACTIONS_URL } from '../lib/videoJobs.mjs';
import { clipCostOnUsd } from '../lib/film/cost.mjs';
import { createCapacityAlerts, __resetAlerts } from '../lib/router/alerts.mjs';
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
  PG1_VIDEO_MODEL_REPLICATE_IMAGE: 'kwaivgi/kling-v2.1', PG1_FILM_VOICE_TIMEOUT_MS: '40', PG1_FILM_VOICE_ID: 'brandVoice0123456789'
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
    [INTERACTIONS_URL, (u, o, body) => {
      trace.push({ step: 'clip', provider: 'gemini_paid', model: body.model });
      if (st.omni) { const r = st.omni(trace.filter((t) => t.step === 'clip' && t.provider === 'gemini_paid').length); if (r) return r; }
      return json({ id: 'int-1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: Buffer.from('omni-mp4').toString('base64'), mime_type: 'video/mp4' }] }] });
    }],
    [`${GEMINI_API}/`, (u, o, body) => {
      const model = decodeURIComponent(u.split('/models/')[1].split(':')[0]);
      if (/lyria/.test(model)) {
        trace.push({ step: 'music', provider: 'gemini_paid', model, prompt: body.contents[0].parts[0].text });
        if (st.lyria) { const r = st.lyria(model); if (r) return r; }
        return json({ candidates: [{ content: { parts: [{ text: 'instrumental' }, { inlineData: { mimeType: 'audio/mpeg', data: Buffer.from('lyria-mp3').toString('base64') } }] } }] });
      }
      // Text on the paid key (a client film's text runs here alone, T1).
      if (!/image/.test(model)) {
        const sys = body.systemInstruction && body.systemInstruction.parts ? body.systemInstruction.parts.map((x) => x.text).join('') : '';
        const qc = sys === QC_SYSTEM;
        const freeKey = o && o.headers && o.headers['x-goog-api-key'] === KEYS.GEMINI_API_KEY_FREE;
        trace.push({ step: qc ? 'shot check' : 'storyboard', provider: freeKey ? 'gemini_free' : 'gemini_paid', model });
        const text = qc ? '{"pass":true,"score":8,"issues":[],"best_start_s":0.5,"description":"as described"}' : JSON.stringify(storyboardJson());
        return json({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 } });
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
      trace.push({ step: 'voice', provider: 'elevenlabs', model: body.model_id, text: body.text, format: new URL(u).searchParams.get('output_format'), voiceId: decodeURIComponent(new URL(u).pathname.split('/')[3]) });
      if (st.elevenlabs) { const r = st.elevenlabs(body.text, o); if (r) return r; }
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

beforeEach(() => { __resetRouterState(); __resetAlerts(); mixes = []; });
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

  const runStage = async (p, stage, queued, { clientWork = false } = {}) => {
    await store.updateProject(p.id, { status: queued });
    const env = { ...process.env, ...KEYS, PG1_VIDEO_RENDER_SECRET: SECRET, FILM_PROJECT_ID: p.id, FILM_STAGE: stage };
    env.FILM_TOKEN = signFilmToken(p.id, env);
    const logs = [];
    const alert = createCapacityAlerts({ env, store: null, log: (l) => logs.push(l) });
    const engines = realEngines(env, { fetchImpl, log: (l) => logs.push(l), sleep: async () => {}, clientWork, alert });
    const code = await workerMain(env, { engines, fetchImpl, ffImpl: fakeFf(), log: (l) => logs.push(l) });
    return { code, logs, film: await store.getProject(p.id) };
  };

  test('storyboard -> stills -> clips -> voiceover -> music -> render: each step on the engine the registry names; the brand voice timing out never fails the film', async () => {
    const p = await store.createProject({ request: 'A cafe opening at dawn, 20 seconds', capUsd: 20, status: 'storyboard_queued' });
    // The second line times out on ElevenLabs twice: one retry, then Cartesia.
    st.elevenlabs = (text, o) => (text === LINES[1] ? hang(o) : null);

    // 1. Storyboard.
    let r = await runStage(p, 'storyboard', 'storyboard_queued');
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.status, 'awaiting_preview_approval');
    const sb = trace.filter((t) => t.step === 'storyboard');
    // Routing policy: an operator film's writing goes to the free engines
    // first (here the free Gemini key, the only free key this job has).
    assert.deepEqual(sb.map((t) => t.provider), ['gemini_free'], 'the writing stage: free first');

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
      'elevenlabs:0', // line 1 in the brand voice
      'elevenlabs:1', 'elevenlabs:1', // line 2 times out, is sent once more, times out again
      'cartesia:1', 'cartesia:2', // Cartesia from then on
      'cartesia:0' // line 1 recorded again, so the film has one voice
    ]);
    assert.equal(voice[0].model, registryModel('voiceover_single', 'elevenlabs', 'primary'));
    assert.equal(voice[0].voiceId, KEYS.PG1_FILM_VOICE_ID, 'the brand voice (PG1_FILM_VOICE_ID)');
    assert.ok(voice.filter((t) => t.provider === 'elevenlabs').every((t) => t.format === 'pcm_24000'));
    assert.ok(voice.filter((t) => t.provider === 'cartesia').every((t) => t.model === registryModel('voiceover_single', 'cartesia', 'fallback')));
    const music = trace.filter((t) => t.step === 'music');
    assert.deepEqual(music.map((t) => t.model), [registryModel('film_music', 'gemini_paid', 'primary'), registryModel('film_music', 'gemini_paid', 'primary')], 'one Lyria 3.5 bed per scene, on the paid Gemini key');
    // Each cue is scored to its scene, never a loop.
    assert.ok(music.every((t) => /Exactly \d+ seconds long: a cue scored to that length[^\n]*Not a loop\./.test(t.prompt)), music.map((t) => t.prompt).join(' | '));
    assert.ok(!trace.some((t) => t.provider === 'replicate' && /lyria|music/.test(t.model)), 'never Replicate\'s Lyria for a film');
    assert.ok(!trace.some((t) => t.step === 'clip'), 'no clips in the preview');

    let assets = await store.listAssets(p.id);
    const lines = assets.filter((a) => a.kind === 'voice' && a.status === 'ok');
    assert.equal(lines.length, 3);
    assert.ok(lines.every((a) => a.meta.engine === VOICE_LABELS.cartesia), 'one voice throughout');
    assert.ok(lines.every((a) => a.meta.words.length > 0), 'word timings for captions');
    const replaced = await store.listAssets(p.id, { kinds: ['voice'], status: 'superseded' });
    assert.deepEqual(replaced.map((a) => a.meta.engine), [VOICE_LABELS.elevenlabs], 'the first take of line 1 is replaced, never reused');
    assert.deepEqual(r.film.qc_report.voice, { engine: VOICE_LABELS.cartesia, retries: 1, rerecorded: 1, fallback: { from: VOICE_LABELS.elevenlabs, to: VOICE_LABELS.cartesia, reason: 'timeout' } });
    assert.deepEqual(r.film.qc_report.regenerated.map((x) => `${x.what}:${x.shotId}`), ['voice:s1-sh1']);
    assert.equal(r.film.qc_report.music.unavailable, false);
    assert.ok(r.logs.some((l) => /voiceover: elevenlabs failed \(timeout/.test(l)));

    // 3. Full: clips, checks, edit, mix, transcript.
    trace.length = 0;
    r = await runStage(p, 'full', 'full_queued');
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.status, 'done');
    const clips = trace.filter((t) => t.step === 'clip');
    assert.equal(clips.length, 4, 'one clip per shot, every one passing its check');
    assert.ok(clips.every((t) => t.provider === 'gemini_paid' && t.model === registryModel('text_image_to_video', 'gemini_paid', 'primary')), 'clips: Gemini Omni first');
    // The usage ledger records each clip at its real price, not the worst case.
    const clipRows = memoryLedger.rows(utcDay()).filter((x) => x.unit === 'video_gemini' && x.ok);
    assert.ok(clipRows.length >= 4);
    assert.ok(clipRows.every((x) => x.cost_usd === clipCostOnUsd('gemini_paid', 'standard', 5)), JSON.stringify(clipRows.map((x) => x.cost_usd)));
    assert.equal(trace.filter((t) => t.step === 'shot check').length, 4);
    assert.ok(trace.filter((t) => t.step === 'shot check').every((t) => t.provider === 'anthropic'));
    assert.ok(!trace.some((t) => t.step === 'voice' || t.step === 'music' || t.step === 'still'), 'voice, music and stills reused from the preview');
    assert.deepEqual(trace.filter((t) => t.step === 'transcript').map((t) => t.provider), ['cartesia']);
    assert.equal(r.film.qc_report.audio.ok, true, 'the voiceover was heard as written');
    assert.equal(r.film.qc_report.voice.engine, VOICE_LABELS.cartesia, 'the full render keeps the preview\'s voice');
    assert.equal(mixes.at(-1).music.length, 2, 'both music beds in the final mix');
    assert.equal(mixes.at(-1).voice.length, 3);

    // The free Gemini key: the storyboard only, never a check, a still, a
    // clip or music.
    assert.ok(!fetchImpl.calls.some((c) => JSON.stringify(c.headers).includes(KEYS.GEMINI_API_KEY_FREE) && (/image|lyria|omni|interactions/i.test(c.url) || !c.url.includes('generativelanguage'))), 'no media call on the free key');
    assert.ok(trace.filter((t) => t.provider === 'gemini_free').every((t) => t.step === 'storyboard'));
    assets = await store.listAssets(p.id);
    assert.ok(assets.some((a) => a.kind === 'final'));
    // Every charge is an asset's cost, except the storyboard and the audio check.
    const assetUsd = assets.reduce((s, a) => s + Number(a.cost_usd || 0), 0);
    assert.ok(Number(r.film.spent_usd) >= assetUsd - 0.005, 'nothing made without being charged');
    assert.ok(Number(r.film.spent_usd) > 0 && Number(r.film.spent_usd) <= 20);
  });

  test('Gemini Omni out of credit at the third clip: Kling makes the rest, and the first two are made again on Kling (one clip style); one alert per engine', async () => {
    const p = await store.createProject({ request: 'A cafe opening at dawn', capUsd: 20, status: 'storyboard_queued' });
    assert.equal((await runStage(p, 'storyboard', 'storyboard_queued')).code, 0);
    assert.equal((await runStage(p, 'preview', 'preview_queued')).code, 0);
    st.omni = (n) => (n >= 3 ? new Response(JSON.stringify({ error: { code: 429, message: 'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.', status: 'RESOURCE_EXHAUSTED' } }), { status: 429 }) : null);
    trace.length = 0;
    const r = await runStage(p, 'full', 'full_queued');
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.status, 'done');
    const clips = trace.filter((t) => t.step === 'clip');
    // Omni: shots 1 and 2, then refused for credit (once: no retry on a credit
    // failure); Kling: shots 3 and 4, then 1 and 2 again.
    assert.deepEqual(clips.map((t) => t.provider), ['gemini_paid', 'gemini_paid', 'gemini_paid', 'replicate', 'replicate', 'replicate', 'replicate']);
    assert.ok(clips.filter((t) => t.provider === 'replicate').every((t) => t.model === registryModel('text_image_to_video', 'replicate')));
    const ok = await store.listAssets(p.id, { kinds: ['clip'] });
    assert.equal(ok.length, 4);
    assert.ok(ok.every((a) => a.meta.engine === ENGINE_LABELS.replicate), 'every clip in the film from one engine');
    assert.equal((await store.listAssets(p.id, { kinds: ['clip'], status: 'superseded' })).length, 2, 'the Omni clips are replaced, never reused');
    assert.deepEqual(r.film.qc_report.regenerated.filter((x) => x.what === 'clip').map((x) => x.shotId).sort(), ['s1-sh1', 's1-sh2']);
    assert.deepEqual(r.film.qc_report.media.fallback, { from: ENGINE_LABELS.gemini_paid, to: ENGINE_LABELS.replicate, reason: 'billing', at: 'clip' });
    assert.ok(r.logs.some((l) => /\[router\] alert: PG1 router: Gemini \(paid key\) is out of credit \(429\); clips moved to Replicate\./.test(l)), r.logs.filter((l) => /router/.test(l)).join('\n'));
  });

  test('a client film uses licensed engines only: no Kling, no Cartesia; Omni out of credit stops it with a clear message', async () => {
    const p = await store.createProject({ request: 'A cafe opening at dawn', capUsd: 20, status: 'storyboard_queued' });
    await store.updateProject(p.id, { client: { name: 'Acme Coffee', credit: false } });
    assert.equal((await runStage(p, 'storyboard', 'storyboard_queued', { clientWork: true })).code, 0);
    // Even with the brand voice timing out, Cartesia is never used for a client.
    st.elevenlabs = (text, o) => (text === LINES[1] && !st.once ? ((st.once = true), new Response('{"detail":"internal"}', { status: 500 })) : null);
    trace.length = 0;
    let r = await runStage(p, 'preview', 'preview_queued', { clientWork: true });
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.ok(trace.filter((t) => t.step === 'voice').every((t) => t.provider === 'elevenlabs'), 'never Cartesia for a client film (C1)');
    // Stills become the keyframes clips are made from: a client film's come from Gemini image alone, never FLUX.
    const stills = trace.filter((t) => t.step === 'still');
    assert.ok(stills.length >= 2, `${stills.length} stills`);
    assert.ok(stills.every((t) => t.provider === 'gemini_paid'), stills.map((t) => `${t.provider}:${t.model}`).join(', '));
    assert.ok(!trace.some((t) => t.provider === 'replicate'), 'no Replicate call at all for a client film');
    st.omni = () => new Response('{"error":{"code":402,"message":"billing: insufficient credit"}}', { status: 402 });
    trace.length = 0;
    r = await runStage(p, 'full', 'full_queued', { clientWork: true });
    assert.equal(r.code, 1);
    assert.equal(r.film.status, 'failed');
    assert.equal(r.film.error_reason, 'out_of_credit');
    assert.ok(!trace.some((t) => t.provider === 'replicate' && t.step === 'clip'), 'Kling (R1) is never asked for a client film');
    const card = await filmCard(store, r.film);
    assert.match(card.message, /no other engine cleared for client work can take over/);
    assert.doesNotMatch(card.message, UPSTREAM_BRAND_RE);
  });

  test('a priced client film keeps the 1.5x floor: a fallback that would pass price / 1.5 stops with a clear message', async () => {
    const p = await store.createProject({ request: 'A cafe opening at dawn', capUsd: 20, status: 'storyboard_queued' });
    // A 1.20 USD package: spend may not pass 0.80 USD; the storyboard and the
    // preview fit, the clips do not.
    await store.updateProject(p.id, { price_usd: 1.2 });
    assert.equal((await runStage(p, 'storyboard', 'storyboard_queued')).code, 0);
    assert.equal((await runStage(p, 'preview', 'preview_queued')).code, 0);
    trace.length = 0;
    const r = await runStage(p, 'full', 'full_queued');
    assert.equal(r.code, 1);
    assert.equal(r.film.error_reason, 'price_floor');
    assert.ok(Number(r.film.spent_usd) <= 0.8 + 1e-9, `spent ${r.film.spent_usd}`);
    const card = await filmCard(store, r.film);
    assert.match(card.message, /no engine fits the budget: the next step would take spend past the package price \/ 1\.5/);
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

  test('one retry on a timeout, a network error or a 5xx; a bad key goes straight to the next engine', () => {
    assert.equal(isVoiceRetryable(new EngineError('timeout', 'x')), true);
    assert.equal(isVoiceRetryable(new EngineError('network', 'x')), true);
    assert.equal(isVoiceRetryable(new EngineError('engine', 'x', { status: 503 })), true);
    assert.equal(isVoiceRetryable(new EngineError('engine', 'x', { status: 429 })), true);
    assert.equal(isVoiceRetryable(new EngineError('engine', 'x', { status: 401 })), false);
    assert.equal(isVoiceRetryable(new EngineError('engine', 'x', { status: 402 })), false);
  });

  test('ROUTING_CHAINS.voice: the brand voice first; a timeout then success stays on it', async () => {
    let n = 0;
    const calls = [];
    const voice = createFilmVoice({ env, timeoutMs: 20, sleep: async () => {}, log: () => {}, fetchImpl: (u, o) => { calls.push(engineOf(u)); return ++n === 1 ? hang(o) : elOk('hello'); } });
    const stage = newVoiceStage();
    const line = await voice({ text: 'hello', stage });
    assert.equal(line.engine, 'elevenlabs');
    assert.deepEqual(calls, ['elevenlabs', 'elevenlabs']);
    assert.deepEqual(stage, { engine: 'elevenlabs', retries: 1, switched: null });
  });

  test('the brand voice down: Cartesia takes this line and the rest of the stage; a bad key is not retried', async () => {
    const calls = [];
    const alerts = [];
    const voice = createFilmVoice({ env, sleep: async () => {}, log: () => {}, alert: async (a) => { alerts.push(a); }, fetchImpl: (u) => { calls.push(engineOf(u)); return engineOf(u) === 'elevenlabs' ? new Response('down', { status: 503 }) : cartesiaOk(); } });
    const stage = newVoiceStage();
    assert.equal((await voice({ text: 'hi there', stage })).engine, 'cartesia');
    assert.equal((await voice({ text: 'hi there', stage })).engine, 'cartesia');
    assert.deepEqual(calls, ['elevenlabs', 'elevenlabs', 'cartesia', 'cartesia'], 'ElevenLabs is not asked again this stage');
    assert.deepEqual([stage.switched.from, stage.switched.to], ['elevenlabs', 'cartesia']);
    assert.deepEqual(alerts.map((a) => [a.engine, a.next]), [['elevenlabs', 'cartesia']], 'the capacity alert names the engine and what took over');
    const r401 = [];
    const v2 = createFilmVoice({ env, sleep: async () => {}, log: () => {}, fetchImpl: (u) => { r401.push(engineOf(u)); return engineOf(u) === 'elevenlabs' ? new Response('bad key', { status: 401 }) : cartesiaOk(); } });
    await v2({ text: 'hi there' });
    assert.deepEqual(r401, ['elevenlabs', 'cartesia'], 'no retry on a bad key');
  });

  test('a refusal stops: the other voice engine is never asked', async () => {
    const calls = [];
    const voice = createFilmVoice({ env, sleep: async () => {}, log: () => {}, fetchImpl: (u) => { calls.push(engineOf(u)); return new Response('{"detail":{"status":"content_policy_violation","message":"blocked by safety filter"}}', { status: 400 }); } });
    await assert.rejects(voice({ text: 'x' }));
    assert.deepEqual(calls, ['elevenlabs']);
  });

  test('a stage on Cartesia (stored lines) stays there; Cartesia failing falls back to the brand voice', async () => {
    const voice = createFilmVoice({ env, sleep: async () => {}, log: () => {}, fetchImpl: (u) => (engineOf(u) === 'elevenlabs' ? elOk('x') : new Response('quota', { status: 429 })) });
    const stage = { ...newVoiceStage(), engine: 'cartesia' };
    assert.equal((await voice({ text: 'x', stage })).engine, 'elevenlabs');
    assert.deepEqual(stage.switched && [stage.switched.from, stage.switched.to], ['cartesia', 'elevenlabs']);
  });

  test('both down, no key at all, or a client film without the brand voice: a clear error', async () => {
    const both = createFilmVoice({ env, sleep: async () => {}, log: () => {}, fetchImpl: () => new Response('down', { status: 503 }) });
    await assert.rejects(both({ text: 'x' }), (e) => e.engine === 'elevenlabs' && e.fallback.engine === 'cartesia' && e.fallback.outcome === 'failed');
    const alone = createFilmVoice({ env: { ELEVENLABS_API_KEY: 'e' }, sleep: async () => {}, log: () => {}, fetchImpl: () => new Response('down', { status: 503 }) });
    await assert.rejects(alone({ text: 'x' }), (e) => e.fallback.outcome === 'not_configured');
    const client = createFilmVoice({ env: { CARTESIA_API_KEY: 'c' }, clientWork: true, log: () => {}, fetchImpl: () => cartesiaOk() });
    await assert.rejects(client({ text: 'x' }), (e) => e.kind === 'not_configured' && e.licence && /Cartesia is not cleared for client work/.test(e.detail));
  });

  test('the voice check: one line in the brand voice, a WAV and a one-line verdict; no film, no database', async () => {
    const { voiceCheck, VOICE_CHECK_LINE } = await import('../scripts/film-render.mjs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { readFile } = await import('node:fs/promises');
    const out = path.join(os.tmpdir(), `voice-check-${Date.now()}.wav`);
    const calls = [];
    const logs = [];
    const code = await voiceCheck({ ELEVENLABS_API_KEY: 'e', PG1_FILM_VOICE_ID: 'brand123', VOICE_CHECK_OUT: out, FILM_STAGE: 'voice_check' }, { fetchImpl: (u, o) => { calls.push({ u, body: JSON.parse(o.body) }); return elOk(VOICE_CHECK_LINE); }, log: (l) => logs.push(l) });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0].u, /\/text-to-speech\/brand123\/with-timestamps\?output_format=pcm_24000$/);
    assert.equal(calls[0].body.text, VOICE_CHECK_LINE);
    assert.equal((await readFile(out)).toString('ascii', 0, 4), 'RIFF');
    assert.match(logs[0], /^\[voice-check\] ok: the brand voice \(PG1_FILM_VOICE_ID\); model eleven_multilingual_v2; 24000 Hz/);
    assert.equal(await voiceCheck({}, { log: (l) => logs.push(l) }), 2, 'no key: a clear failure');
    assert.match(logs.at(-1), /ELEVENLABS_API_KEY is not set/);
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
