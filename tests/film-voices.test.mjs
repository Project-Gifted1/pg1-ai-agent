/**
 * PG1 Studio per-film voices (lib/film/voices.mjs):
 *
 *  - --voice "<name or id>" on /film and /film director: exact id, then the
 *    name (case-insensitive, trimmed); an unknown name gets the three
 *    closest and an ambiguous one lists the ids, both before anything is
 *    created or spent;
 *  - Director casting: the narrator and every speaking character cast from
 *    the account's voices to fit the script, saved as director.cast and
 *    reused by every retry and regeneration, never recast; a cast voice that
 *    left the account falls back for its role only and the film goes on;
 *  - client films: only cleared voices (premade, or owned by the account;
 *    never a Voice Library copy), refused before any spend;
 *  - the fallback chain: PG1_FILM_VOICE_ID while it is in the account, else
 *    the premade constant found by name;
 *  - one engine per stage (a fallback redoes the whole stage), never the
 *    second engine for a client film;
 *  - /voices (operator only) and white label everywhere a user reads.
 *
 * Network mocked; the worker, store and engines are the real ones.
 * Run with: node --test tests/film-voices.test.mjs
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { __resetRouterState } from '../lib/aiRouter.mjs';
import { REPLICATE_API, GEMINI_API, ANTHROPIC_URL, CARTESIA_STT_URL, ELEVENLABS_TTS_URL, ELEVENLABS_SFX_URL, ELEVENLABS_DIALOGUE_URL, createFilmVoice, newVoiceStage } from '../lib/film/providers.mjs';
import { INTERACTIONS_URL } from '../lib/videoJobs.mjs';
import { QC_SYSTEM, DAILIES_SYSTEM, STILL_CHECK_SYSTEM } from '../lib/film/qc.mjs';
import { WRITING_SYSTEM, creditLines, directorNotesBlocks } from '../lib/film/director.mjs';
import { createFilmStore } from '../lib/film/store.mjs';
import { signFilmToken } from '../lib/film/dispatch.mjs';
import { filmFailureMessage, FILM_HELP_TEXT } from '../lib/film/text.mjs';
import { handleFilmCommand } from '../lib/film/chat.mjs';
import { main as workerMain, realEngines } from '../scripts/film-render.mjs';
import { createCapacityAlerts, __resetAlerts } from '../lib/router/alerts.mjs';
import { isOperatorCommand } from '../api/chat.mjs';
import {
  VOICES_URL, VOICE_LIST_TTL_MS, FALLBACK_PREMADE_VOICE, OFFLINE_PREMADE_VOICE_ID, VOICE_TEXT, OPERATOR_REFUSAL,
  normaliseVoice, isClientCleared, isLibraryCopy, listAccountVoices, resolveVoiceRequest, takeVoiceFlag, fallbackVoice,
  castFilm, effectiveCast, handleVoicesCommand, voicesListText, isVoicesCommand, __resetVoiceCache
} from '../lib/film/voices.mjs';
import * as realFf from '../lib/film/ffmpeg.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch, json } from './helpers/filmDb.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase.test';
const SECRET = 'film-render-secret-0123456789abcdef';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// No PG1_FILM_VOICE_ID: films are cast, or take the premade constant.
const KEYS = {
  REPLICATE_API_TOKEN: 'r8_voice_stub_0123456789ab', GEMINI_API_KEY_PAID: 'AQ.voice-paid-0123456789', ANTHROPIC_API_KEY: 'sk-ant-voice-0123456789',
  CARTESIA_API_KEY: 'sk_car_voice_0123456789', ELEVENLABS_API_KEY: 'sk_el_voice_0123456789', PG1_VIDEO_MODEL_REPLICATE_IMAGE: 'kwaivgi/kling-v2.1'
};

// The account's voices, as GET /v1/voices returns them.
const V = {
  george: { voice_id: 'premadeGeorge0001', name: 'George', category: 'premade', is_owner: false, labels: { accent: 'british', age: 'middle_aged', gender: 'male', use_case: 'narration', description: 'warm' }, description: 'A warm ElevenLabs storyteller', sharing: null },
  alice: { voice_id: 'premadeAlice00002', name: 'Alice', category: 'premade', is_owner: false, labels: { accent: 'british', age: 'young', gender: 'female', use_case: 'news' }, sharing: null },
  charlie: { voice_id: 'premadeCharlie003', name: 'Charlie', category: 'premade', is_owner: false, labels: { accent: 'australian', age: 'young', gender: 'male', use_case: 'conversational' }, sharing: null },
  josh: { voice_id: 'premadeJosh000004', name: 'Josh', category: 'premade', is_owner: false, labels: { accent: 'american', age: 'young', gender: 'male', use_case: 'conversational' }, sharing: null },
  oldTom: { voice_id: 'ownedCloneTom0005', name: 'Old Tom', category: 'cloned', is_owner: true, labels: { accent: 'british', age: 'old', gender: 'male' }, sharing: null },
  designed: { voice_id: 'ownedDesign000006', name: 'Studio Narrator', category: 'generated', is_owner: true, labels: { accent: 'american', gender: 'female', age: 'middle_aged' }, sharing: { status: 'enabled', original_voice_id: 'ownedDesign000006', public_owner_id: 'us' } },
  // Voice Library voices added to the account: they share categories with our own.
  libLarry: { voice_id: 'libraryLarry00007', name: 'Library Larry', category: 'professional', is_owner: false, labels: { accent: 'american', gender: 'male', age: 'middle_aged' }, sharing: { status: 'copied', original_voice_id: 'origLarry', public_owner_id: 'someone' } },
  granny: { voice_id: 'libraryGranny0008', name: 'Granny Rose', category: 'generated', is_owner: false, labels: { accent: 'british', gender: 'female', age: 'old', description: 'gentle' }, sharing: { status: 'copied', original_voice_id: 'origGranny', public_owner_id: 'someone' } },
  sam1: { voice_id: 'premadeSamA000009', name: 'Sam', category: 'premade', is_owner: false, labels: { gender: 'male', accent: 'american' }, sharing: null },
  sam2: { voice_id: 'ownedSamB00000010', name: 'sam', category: 'cloned', is_owner: true, labels: { gender: 'male', accent: 'british' }, sharing: null },
  ghost: { voice_id: 'libraryGhost00011', name: 'Ghost', category: 'professional', is_owner: false, labels: {}, sharing: { status: 'copied_disabled', original_voice_id: 'origGhost' } }
};
const ALL = Object.values(V);
const listOf = (voices) => ({ ok: true, voices: voices.map(normaliseVoice) });

// Provider, company and model names a user may never read.
const BANNED = /(?<![a-z0-9])(?:eleven[\s_-]*labs|cartesia|google|gemini|replicate|kling|claude|anthropic|openai|openrouter|eleven_v3|eleven_multilingual(?:_v2)?|sonic(?:-[\d.]+)?|ink-whisper|lyria)(?![a-z0-9])/i;

const SCRIPT = {
  title: 'First Light', logline: 'A baker opens before the town wakes.', treatment: 'Dawn, flour and quiet. Mia, an old British grandmother, has baked here for fifty years; Tom, a young American, is her first customer.',
  look: 'soft window light, warm palette, 35mm', mood: 'tender, hopeful', runtime_s: 20,
  beats: [{ beat: 'Dark street', description: 'The town asleep', seconds: 5 }, { beat: 'The oven', description: 'Heat and flour', seconds: 10 }, { beat: 'First customer', description: 'A smile at the door', seconds: 5 }]
};
const dir = (size, intent) => ({ shot_size: size, lens: '35mm', lighting: 'soft window light', blocking: 'Mia at the bench', continuity: 'apron flour stays', intent });
const SHOTS = {
  title: 'First Light', logline: SCRIPT.logline, tier: 'standard',
  style: { look: SCRIPT.look, grade: 'warm', reference_prompt: 'Mia, a baker in a white apron' },
  characters: [{ id: 'c1', name: 'Mia', description: 'elderly baker, a grandmother in a white apron' }, { id: 'c2', name: 'Tom', description: 'a young man in a grey coat' }],
  captions: { enabled: true }, title_card: { text: 'First Light', duration_s: 3 }, end_card: null,
  scenes: [
    { id: 's1', title: 'Bakery', music: { mood: 'soft piano', bpm: 80 }, shots: [
      { id: 's1-sh1', duration_s: 5, camera: 'push_in', description: 'dark street', visual_prompt: 'A dark street before dawn', voiceover: 'Before the town wakes,', transition: 'cut', characters: [], direction: dir('wide', 'quiet'), sfx: '' },
      { id: 's1-sh2', duration_s: 5, camera: 'static', description: 'Mia at the oven', visual_prompt: 'Mia slides bread into the oven', voiceover: '', transition: 'cut', characters: ['c1'], direction: dir('medium_close', 'care'), sfx: '' }
    ] },
    { id: 's2', title: 'Door', music: { mood: 'warm strings', bpm: 92 }, shots: [
      { id: 's2-sh1', duration_s: 5, camera: 'tracking', description: 'Tom at the door', visual_prompt: 'Tom steps in out of the cold', voiceover: '', transition: 'cut', characters: ['c2'], direction: dir('medium', 'warmth'), dialogue: [{ character: 'c2', line: 'Am I too early?' }, { character: 'c1', line: 'Never.' }] },
      { id: 's2-sh2', duration_s: 5, camera: 'static', description: 'bread on the counter', visual_prompt: 'Fresh bread on the counter', voiceover: 'the day begins with bread.', transition: 'cut', characters: [], direction: dir('insert', 'reward') }
    ] }
  ]
};

function fakeFf() {
  const touch = async (f, what) => { await writeFile(f, what); return f; };
  return {
    FILM_SIZES: realFf.FILM_SIZES, TARGET_LUFS: realFf.TARGET_LUFS, buildAss: realFf.buildAss,
    writeText: (f, t) => touch(f, t), probeDuration: async () => 5,
    extractFrame: (i, t, out) => touch(out, 'frame'), extractLastFrame: (i, out) => touch(out, 'last'), thumbnail: (i, t, out) => touch(out, 'thumb'),
    segmentFromStill: (s, o) => touch(o.out, 'seg'), segmentFromClip: (c, o) => touch(o.out, 'seg'), segmentFromImage: (img, o) => touch(o.out, 'seg'), segmentCard: (o) => touch(o.out, 'card'),
    joinSegments: (files, d, j, out) => touch(out, 'join'), mixAudio: (o) => touch(o.out, 'mix'),
    normaliseLoudness: async (i, out) => { await touch(out, 'loud'); return { file: out, measured: { input_i: '-22' }, after: { input_i: '-14.0' } }; },
    finalEncode: (o) => touch(o.out, 'final'), socialCut: (i, out) => touch(out, 'social'), extractAudioForCheck: (i, out) => touch(out, 'wav')
  };
}

const sse = (events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
// st.voices: the account's voice list now; st.tts(body, n): a TTS reply to force.
function engineRoutes(trace, st) {
  const textReply = (sys, provider) => {
    const step = sys === WRITING_SYSTEM ? 'writing' : sys.startsWith(STILL_CHECK_SYSTEM.slice(0, 40)) ? 'still check' : sys === DAILIES_SYSTEM ? 'dailies' : sys === QC_SYSTEM ? 'shot check' : 'shot list';
    trace.push({ step, provider });
    if (step === 'writing') return JSON.stringify(SCRIPT);
    if (step === 'shot list') return JSON.stringify(SHOTS);
    return step === 'dailies' ? '{"pass":true,"score":8,"issues":[],"best_start_s":0,"description":"ok"}' : '{"pass":true,"score":8,"issues":[],"description":"ok"}';
  };
  return [
    ['api.github.com', (u, o, body) => { trace.push({ step: 'dispatch', body }); return new Response(null, { status: 204 }); }],
    [VOICES_URL, () => { trace.push({ step: 'voices' }); return json({ voices: st.voices || ALL }); }],
    [ANTHROPIC_URL, (u, o, body) => json({ model: body.model, content: [{ type: 'text', text: textReply(String(body.system), 'anthropic') }], stop_reason: 'end_turn', usage: { input_tokens: 800, output_tokens: 400 } })],
    [`${REPLICATE_API}/models/`, (u) => {
      const model = u.split('/models/')[1].split('/predictions')[0];
      trace.push({ step: /kling/.test(model) ? 'clip' : 'still', provider: 'replicate' });
      return json({ id: `p-${trace.length}`, status: 'succeeded', output: `https://replicate.delivery/o-${trace.length}.${/kling/.test(model) ? 'mp4' : 'png'}` }, 201);
    }],
    ['https://replicate.delivery/', () => new Response(Buffer.from('media'), { status: 200 })],
    [INTERACTIONS_URL, () => { trace.push({ step: 'clip', provider: 'gemini_paid' }); return json({ id: 'i', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: Buffer.from('mp4').toString('base64'), mime_type: 'video/mp4' }] }] }); }],
    [`${GEMINI_API}/`, (u, o, body) => {
      const model = decodeURIComponent(u.split('/models/')[1].split(':')[0]);
      if (!/lyria|image/.test(model)) {
        const sys = body.systemInstruction ? body.systemInstruction.parts.map((x) => x.text).join('') : '';
        return json({ candidates: [{ content: { parts: [{ text: textReply(sys, 'gemini_paid') }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 400 } });
      }
      trace.push({ step: /lyria/.test(model) ? 'music' : 'still', provider: 'gemini_paid' });
      if (/lyria/.test(model)) return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/mpeg', data: Buffer.from('mp3').toString('base64') } }] } }] });
      return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] });
    }],
    [ELEVENLABS_SFX_URL, () => new Response(Buffer.from('sfx'), { status: 200 })],
    [ELEVENLABS_DIALOGUE_URL, (u, o, body) => { trace.push({ step: 'dialogue', provider: 'elevenlabs', voices: body.inputs.map((i) => i.voice_id) }); return new Response(Buffer.alloc(24000 * 2), { status: 200 }); }],
    [`${ELEVENLABS_TTS_URL}/`, (u, o, body) => {
      const voiceId = decodeURIComponent(new URL(u).pathname.split('/')[3]);
      trace.push({ step: 'voice', provider: 'elevenlabs', text: body.text, voiceId });
      if (st.tts) { const r = st.tts(body); if (r) return r; }
      const chars = [...body.text];
      return json({ audio_base64: Buffer.alloc(2400 * 2).toString('base64'), alignment: { characters: chars, character_start_times_seconds: chars.map((c, i) => i * 0.05), character_end_times_seconds: chars.map((c, i) => i * 0.05 + 0.04) } });
    }],
    ['https://api.cartesia.ai/tts', (u, o, body) => { trace.push({ step: 'voice', provider: 'cartesia', text: body.transcript }); return sse([{ type: 'chunk', data: Buffer.alloc(2000).toString('base64') }, { type: 'done' }]); }],
    [CARTESIA_STT_URL, () => json({ text: 'Before the town wakes, Am I too early? Never. the day begins with bread.' })]
  ];
}

beforeEach(() => { __resetRouterState(); __resetAlerts(); __resetVoiceCache(); });
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

// --- unit -------------------------------------------------------------------------------------

describe('voice clearance and resolution', () => {
  test('isClientCleared: premade and our own voices yes; Voice Library copies never, whatever their category', () => {
    const n = (v) => normaliseVoice(v);
    assert.equal(isClientCleared(n(V.george)), true, 'premade');
    assert.equal(isClientCleared(n(V.oldTom)), true, 'cloned by us (is_owner)');
    assert.equal(isClientCleared(n(V.designed)), true, 'designed by us and shared out from our account');
    assert.equal(isClientCleared(n(V.libLarry)), false, 'library copy, category professional');
    assert.equal(isClientCleared(n(V.granny)), false, 'library copy, category generated (same as our own designed voice)');
    assert.equal(isLibraryCopy(n(V.granny)), true);
    // Ownership must be stated: a cloned voice with no is_owner is not cleared.
    assert.equal(isClientCleared(n({ ...V.oldTom, is_owner: undefined })), false);
    // A library copy whose sharing status is missing but which points at another original.
    assert.equal(isClientCleared(n({ ...V.oldTom, sharing: { original_voice_id: 'someoneElse' } })), false);
    assert.equal(isClientCleared(n(V.ghost)), false, 'disabled by its owner');
  });

  test('--voice resolution: exact id first, then the name case-insensitive and trimmed; whitespace collapsed', () => {
    const voices = listOf(ALL).voices;
    assert.equal(resolveVoiceRequest('premadeJosh000004', voices).voice.name, 'Josh');
    assert.equal(resolveVoiceRequest('  george  ', voices).voice.voice_id, V.george.voice_id);
    assert.equal(resolveVoiceRequest('GEORGE', voices).voice.voice_id, V.george.voice_id);
    assert.equal(resolveVoiceRequest(' old   TOM ', voices).voice.voice_id, V.oldTom.voice_id);
    // An id wins over a voice whose name looks like that id.
    const tricky = [...voices, normaliseVoice({ voice_id: 'zzz111222333', name: 'premadeJosh000004', category: 'premade' })];
    assert.equal(resolveVoiceRequest('premadeJosh000004', tricky).voice.name, 'Josh');
    // Newer premade names carry a tagline: "Roger - Laid-Back, Casual".
    const tagged = [normaliseVoice({ voice_id: 'rogerId0000001', name: 'Roger - Laid-Back, Casual', category: 'premade' })];
    assert.equal(resolveVoiceRequest('roger', tagged).voice.voice_id, 'rogerId0000001');
    assert.deepEqual(takeVoiceFlag('a harbour at dawn --voice "Old Tom" --seconds 20'), { rest: 'a harbour at dawn --seconds 20', voice: 'Old Tom' });
    assert.deepEqual(takeVoiceFlag("a harbour --voice 'george'"), { rest: 'a harbour', voice: 'george' });
    assert.deepEqual(takeVoiceFlag('--voice premadeJosh000004 a harbour'), { rest: 'a harbour', voice: 'premadeJosh000004' });
    assert.deepEqual(takeVoiceFlag('a harbour'), { rest: 'a harbour', voice: null });
  });

  test('unknown name: the three closest by name; ambiguous name: every match with its id', () => {
    const voices = listOf(ALL).voices;
    const r = resolveVoiceRequest('Gorge', voices);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unknown');
    assert.equal(r.suggestions.length, 3);
    assert.equal(r.suggestions[0].name, 'George');
    assert.match(r.message, /no voice called "Gorge"\. Closest: "George"/);
    assert.ok(!r.suggestions.some((v) => v.name === 'Ghost'), 'a disabled voice is never suggested');
    const a = resolveVoiceRequest('SAM', voices);
    assert.equal(a.code, 'ambiguous');
    assert.deepEqual(a.matches.map((v) => v.voice_id).sort(), [V.sam1.voice_id, V.sam2.voice_id].sort());
    assert.match(a.message, /premadeSamA000009/);
    assert.match(a.message, /ownedSamB00000010/);
  });

  test('a client film: a library voice is refused, a cleared one accepted', () => {
    const voices = listOf(ALL).voices;
    const r = resolveVoiceRequest('Library Larry', voices, { clientWork: true });
    assert.equal(r.code, 'not_cleared');
    assert.equal(r.message, "That voice isn't cleared for client work. Pick one marked cleared in /voices.");
    assert.equal(resolveVoiceRequest('Library Larry', voices).ok, true, 'fine for the operator\'s own film');
    assert.equal(resolveVoiceRequest('old tom', voices, { clientWork: true }).ok, true);
  });

  test('the voice list is cached for five minutes', async () => {
    let calls = 0;
    let t = 1000;
    const fetchImpl = async (u) => { calls++; assert.equal(u, VOICES_URL); return json({ voices: ALL }); };
    const env = { ELEVENLABS_API_KEY: 'k' };
    assert.equal((await listAccountVoices({ env, fetchImpl, now: () => t })).voices.length, ALL.length);
    t += VOICE_LIST_TTL_MS - 1;
    await listAccountVoices({ env, fetchImpl, now: () => t });
    assert.equal(calls, 1, 'one call for one film');
    t += 2;
    await listAccountVoices({ env, fetchImpl, now: () => t });
    assert.equal(calls, 2, 'asked again after five minutes');
    // Failures are not cached and never throw.
    __resetVoiceCache();
    const bad = await listAccountVoices({ env, fetchImpl: async () => new Response('{"detail":"elevenlabs is down"}', { status: 503 }) });
    assert.equal(bad.ok, false);
    assert.equal((await listAccountVoices({ env: {}, fetchImpl })).reason, 'not_configured');
  });
});

describe('the fallback chain', () => {
  const list = listOf(ALL);
  test('PG1_FILM_VOICE_ID set and still in the account: that voice', () => {
    const v = fallbackVoice({ env: { PG1_FILM_VOICE_ID: V.oldTom.voice_id }, list });
    assert.deepEqual([v.voice_id, v.source], [V.oldTom.voice_id, 'env']);
  });
  test('PG1_FILM_VOICE_ID unset: the premade constant, found by name', () => {
    assert.equal(FALLBACK_PREMADE_VOICE.name, 'George');
    assert.equal(FALLBACK_PREMADE_VOICE.gender, 'male');
    assert.equal(FALLBACK_PREMADE_VOICE.accent, 'british');
    const v = fallbackVoice({ env: {}, list });
    assert.deepEqual([v.voice_id, v.name, v.source], [V.george.voice_id, 'George', 'premade']);
  });
  test('PG1_FILM_VOICE_ID set but gone from the account: the premade constant', () => {
    const v = fallbackVoice({ env: { PG1_FILM_VOICE_ID: 'deletedVoice000' }, list });
    assert.deepEqual([v.voice_id, v.source], [V.george.voice_id, 'premade']);
    assert.match(v.note, /no longer in the account/);
  });
  test('a client film never falls back to a library voice set as PG1_FILM_VOICE_ID', () => {
    assert.equal(fallbackVoice({ env: { PG1_FILM_VOICE_ID: V.granny.voice_id }, list }).source, 'env');
    assert.equal(fallbackVoice({ env: { PG1_FILM_VOICE_ID: V.granny.voice_id }, list, clientWork: true }).voice_id, V.george.voice_id);
  });
  test('without a voice list a film still gets a voice', () => {
    assert.equal(fallbackVoice({ env: { PG1_FILM_VOICE_ID: 'brand0000001' }, list: { ok: false } }).voice_id, 'brand0000001');
    assert.equal(fallbackVoice({ env: {}, list: { ok: false } }).voice_id, OFFLINE_PREMADE_VOICE_ID);
    assert.equal(fallbackVoice({ env: { PG1_FILM_VOICE_ID: 'brand0000001' }, list: { ok: false }, clientWork: true }).voice_id, OFFLINE_PREMADE_VOICE_ID, 'an unverifiable voice is never used for a client');
  });
});

describe('Director casting', () => {
  const list = listOf(ALL);
  test('each role cast to fit the script: age, gender, accent; one voice per role; narrator the PG1 voice', () => {
    const cast = castFilm({ timeline: SHOTS, script: SCRIPT, list });
    assert.equal(cast.narrator.voice_id, V.george.voice_id, 'male British narrator');
    assert.equal(cast.characters.Mia.voice_id, V.granny.voice_id, 'old British woman');
    assert.equal(cast.characters.Tom.voice_id, V.josh.voice_id, 'young American man');
    const ids = [cast.narrator.voice_id, ...Object.values(cast.characters).map((c) => c.voice_id)];
    assert.equal(new Set(ids).size, ids.length, 'no two roles share a voice');
    assert.ok(cast.cast_at);
  });
  test('a client film casts only from cleared voices', () => {
    const cast = castFilm({ timeline: SHOTS, script: SCRIPT, list, clientWork: true });
    const voices = list.voices;
    for (const c of [cast.narrator, ...Object.values(cast.characters)]) assert.ok(isClientCleared(voices.find((v) => v.voice_id === c.voice_id)), `${c.name} is cleared`);
    assert.notEqual(cast.characters.Mia.voice_id, V.granny.voice_id, 'the best fit is a library voice, so never for a client');
    assert.equal(cast.characters.Mia.voice_id, V.alice.voice_id, 'the closest cleared voice: British woman');
  });
  test('a cast voice that left the account falls back for that role only', () => {
    const cast = castFilm({ timeline: SHOTS, script: SCRIPT, list });
    const logs = [];
    const eff = effectiveCast(cast, { list: listOf(ALL.filter((v) => v !== V.josh)), log: (l) => logs.push(l) });
    assert.deepEqual(eff.fallbacks, ['Tom']);
    assert.notEqual(eff.characters.Tom.voice_id, V.josh.voice_id);
    assert.equal(eff.characters.Mia.voice_id, cast.characters.Mia.voice_id, 'the other roles keep their voices');
    assert.equal(eff.narrator.voice_id, cast.narrator.voice_id);
    assert.ok(logs.some((l) => /premadeJosh000004 for Tom is gone/.test(l)));
    assert.equal(cast.characters.Tom.voice_id, V.josh.voice_id, 'the saved cast is not changed');
  });
});

// --- /voices ------------------------------------------------------------------------------------

describe('/voices', () => {
  test('lists every usable voice with a short description and whether it is cleared; no provider names', async () => {
    const out = await handleVoicesCommand({ env: { ELEVENLABS_API_KEY: 'k' }, isOperator: true, fetchImpl: async () => json({ voices: ALL }) });
    assert.equal(out.status, 200);
    assert.match(out.reply, /^### \[ PG1 VOICES \]/);
    assert.match(out.reply, /\*\*George\*\* · british · middle aged · male · narration · warm · client work: yes · `premadeGeorge0001`/);
    assert.match(out.reply, /\*\*Granny Rose\*\* · .* · client work: no/);
    assert.match(out.reply, /\*\*Old Tom\*\* · .* · client work: yes/);
    assert.doesNotMatch(out.reply, /Ghost/, 'a disabled voice is not usable');
    assert.doesNotMatch(out.reply, BANNED);
  });
  test('refuses anyone but the signed-in operator, with the same refusal as other operator commands', async () => {
    let called = false;
    const out = await handleVoicesCommand({ env: { ELEVENLABS_API_KEY: 'k' }, isOperator: false, fetchImpl: async () => { called = true; return json({ voices: ALL }); } });
    assert.deepEqual(out, { status: 401, reply: OPERATOR_REFUSAL });
    assert.equal(OPERATOR_REFUSAL, '[AGENT] Command Aborted: Authentication required.');
    assert.equal(called, false, 'nothing is fetched for a guest');
    assert.equal(isOperatorCommand('/voices'), true, 'the chat gate refuses /voices before any handler runs');
    assert.equal(isVoicesCommand('/voices'), true);
    assert.equal(isVoicesCommand('/voice'), false, '/voice (spoken reply profiles) is a different command');
  });
  test('a provider error becomes PG1 wording; the detail goes to the server log only', async () => {
    const failures = [];
    const out = await handleVoicesCommand({ env: { ELEVENLABS_API_KEY: 'k' }, isOperator: true, onFailure: (f) => failures.push(f), fetchImpl: async () => new Response('{"detail":{"status":"quota_exceeded","message":"ElevenLabs quota exceeded"}}', { status: 429 }) });
    assert.equal(out.reply, VOICE_TEXT.listUnavailable);
    assert.doesNotMatch(out.reply, BANNED);
    assert.match(failures[0].detail, /elevenlabs voices 429/, 'the server log keeps the provider detail');
  });
});

// --- chat and worker, end to end ------------------------------------------------------------

describe('per-film voices, end to end', () => {
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
  const cmdOpts = () => ({ env: { ...process.env, ...KEYS, PG1_VIDEO_ENABLED: '1', PG1_VIDEO_RENDER_SECRET: SECRET, GITHUB_TOKEN: 'gh' }, supUrl: SUP_URL, supKey: 'service-key', fetchImpl, onFailure: () => {} });
  // Every call that is not reading the voice list: database writes, the
  // render dispatch, any engine.
  const spendCalls = () => fetchImpl.calls.filter((c) => !c.url.startsWith(VOICES_URL));

  test('unknown --voice: the three closest, and nothing created, dispatched or generated', async () => {
    for (const text of ['/film a harbour at dawn --voice Gorge', '/film director a 20s film about a harbour --voice "Gorge"']) {
      fetchImpl.calls.length = 0;
      const out = await handleFilmCommand({ ...cmdOpts(), text, isOperator: true });
      assert.match(out.reply, /no voice called "Gorge"\. Closest: "George", /);
      assert.equal((out.reply.match(/"[^"]+"/g) || []).length, 4, 'the name and three suggestions');
      assert.deepEqual(spendCalls(), [], 'no paid or stored call at all');
      assert.doesNotMatch(out.reply, BANNED);
    }
    assert.equal((await db.query('select count(*)::int as n from pg1_film_projects')).rows[0].n, 0);
  });

  test('ambiguous --voice: every match with its id, nothing spent', async () => {
    const out = await handleFilmCommand({ ...cmdOpts(), text: '/film a harbour at dawn --voice sam', isOperator: true });
    assert.match(out.reply, /More than one voice is called "sam"/);
    assert.match(out.reply, /premadeSamA000009/);
    assert.match(out.reply, /ownedSamB00000010/);
    assert.deepEqual(spendCalls(), []);
  });

  test('client film + a Voice Library voice via --voice: refused before any spend', async () => {
    const out = await handleFilmCommand({ ...cmdOpts(), text: '/film director a 20s spot --client "Acme" --voice "Library Larry"', isOperator: true });
    assert.equal(out.reply, "That voice isn't cleared for client work. Pick one marked cleared in /voices.");
    assert.deepEqual(spendCalls(), []);
    assert.equal(out.pendingApproval, undefined);
  });

  test('the voice list unavailable: --voice stops with PG1 wording, nothing spent', async () => {
    const failing = routedFetch([[VOICES_URL, () => new Response('{"detail":"ElevenLabs internal error"}', { status: 500 })], ...filmDbRoutes(db), ...engineRoutes(trace, st)]);
    const out = await handleFilmCommand({ ...cmdOpts(), fetchImpl: failing, text: '/film a harbour at dawn --voice George', isOperator: true });
    assert.equal(out.reply, VOICE_TEXT.listUnavailable);
    assert.deepEqual(failing.calls.filter((c) => !c.url.startsWith(VOICES_URL)), []);
  });

  test('a chosen voice is saved on the film and read by every stage', async () => {
    const out = await handleFilmCommand({ ...cmdOpts(), text: '/film a harbour at dawn --voice "  old tom "', isOperator: true });
    assert.match(out.reply, /Voice: Old Tom\./);
    const film = await store.getProject(out.filmProject.id);
    assert.equal(film.request, 'a harbour at dawn', 'the flag is not part of the brief');
    assert.deepEqual([film.director.cast.narrator.voice_id, film.director.cast.source], [V.oldTom.voice_id, 'flag']);
    assert.match(FILM_HELP_TEXT, /--voice "<name or id>"/);
  });

  const newDirectorFilm = async ({ client = null, director = {} } = {}) => {
    const p = await store.createProject({ request: 'A 20s film about a baker at dawn', capUsd: 20, status: 'director_queued' });
    await store.updateProject(p.id, { mode: 'director', client, director: { stage: 'writing', done: [], seconds: 20, notes: [], regenerated: [], ...director } });
    return p;
  };
  const runDirector = async (p, { clientWork = false } = {}) => {
    const env = { ...process.env, ...KEYS, PG1_VIDEO_RENDER_SECRET: SECRET, FILM_PROJECT_ID: p.id, FILM_STAGE: 'director' };
    env.FILM_TOKEN = signFilmToken(p.id, env);
    const logs = [];
    const engines = realEngines(env, { fetchImpl, log: (l) => logs.push(l), sleep: async () => {}, clientWork, alert: createCapacityAlerts({ env, log: (l) => logs.push(l) }) });
    const code = await workerMain(env, { engines, fetchImpl, ffImpl: fakeFf(), log: (l) => logs.push(l), notify: async () => {} });
    return { code, logs, film: await store.getProject(p.id) };
  };
  // Back to production, as /film retry does after a stop; the dialogue
  // shot's take is dropped so it is regenerated.
  const backToProduction = async (p) => {
    const f = await store.getProject(p.id);
    await store.updateProject(p.id, { status: 'director_queued', director: { ...f.director, done: ['writing', 'shot_list', 'storyboard'], stage: 'production' } });
    await db.query("update pg1_film_assets set status = 'superseded' where project_id = $1 and kind = 'voice' and meta->>'dialogue' = 'true'", [p.id]);
    trace.length = 0;
    __resetRouterState();
    __resetVoiceCache();
  };

  test('Director casting saved in director.cast; a regeneration reuses the same voices without recasting', async () => {
    const p = await newDirectorFilm();
    let r = await runDirector(p);
    assert.equal(r.code, 0, r.logs.join('\n'));
    const cast = r.film.director.cast;
    assert.equal(cast.narrator.voice_id, V.george.voice_id);
    assert.deepEqual(Object.fromEntries(Object.entries(cast.characters).map(([k, c]) => [k, c.voice_id])), { Mia: V.granny.voice_id, Tom: V.josh.voice_id });
    assert.ok(cast.cast_at);
    // Every narrator line in the narrator's voice; the dialogue in the characters'.
    assert.ok(trace.filter((t) => t.step === 'voice').every((t) => t.voiceId === V.george.voice_id));
    assert.deepEqual(trace.find((t) => t.step === 'dialogue').voices, [V.josh.voice_id, V.granny.voice_id]);
    assert.equal(trace.filter((t) => t.step === 'voices').length, 1, 'the voice list is read once for the film');

    // A better fit for Tom joins the account: the film is not recast.
    st.voices = [...ALL, { voice_id: 'premadeNewTom0012', name: 'Young Yank', category: 'premade', labels: { accent: 'american', age: 'young', gender: 'male', use_case: 'young american man' } }];
    await backToProduction(p);
    r = await runDirector(p);
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.deepEqual(r.film.director.cast, cast, 'the saved cast is unchanged, cast_at included');
    assert.deepEqual(trace.find((t) => t.step === 'dialogue').voices, [V.josh.voice_id, V.granny.voice_id], 'the regenerated take uses the same voices');
  });

  test('a cast voice removed from the account: that role falls back, the film goes on', async () => {
    const p = await newDirectorFilm();
    let r = await runDirector(p);
    assert.equal(r.code, 0, r.logs.join('\n'));
    const cast = r.film.director.cast;
    st.voices = ALL.filter((v) => v !== V.josh);
    await backToProduction(p);
    r = await runDirector(p);
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.status, 'done');
    assert.deepEqual(r.film.director.cast, cast, 'never recast');
    const take = trace.find((t) => t.step === 'dialogue').voices;
    assert.notEqual(take[0], V.josh.voice_id, 'Tom falls back');
    assert.equal(take[1], V.granny.voice_id, 'Mia keeps her voice');
    assert.ok(r.logs.some((l) => /premadeJosh000004 for Tom is gone/.test(l)), r.logs.join('\n'));
  });

  test('--voice on a Director film is the narrator; the characters are still cast', async () => {
    const out = await handleFilmCommand({ ...cmdOpts(), text: '/film director a 20s film about a baker at dawn --voice "Old Tom"', isOperator: true });
    assert.match(out.reply, /Narrator: Old Tom; the characters are cast from the script\./);
    const film = await store.getProject(out.filmProject.id);
    trace.length = 0;
    const r = await runDirector(film);
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.director.cast.narrator.voice_id, V.oldTom.voice_id);
    assert.deepEqual(Object.keys(r.film.director.cast.characters).sort(), ['Mia', 'Tom']);
    assert.notEqual(r.film.director.cast.characters.Mia.voice_id, V.oldTom.voice_id);
    assert.ok(trace.filter((t) => t.step === 'voice').every((t) => t.voiceId === V.oldTom.voice_id));
  });

  test('a client Director film casts only cleared voices', async () => {
    const p = await newDirectorFilm({ client: { name: 'Acme Bakery', credit: true } });
    const r = await runDirector(p, { clientWork: true });
    assert.equal(r.code, 0, r.logs.join('\n'));
    const voices = listOf(ALL).voices;
    const cast = r.film.director.cast;
    for (const c of [cast.narrator, ...Object.values(cast.characters)]) assert.ok(isClientCleared(voices.find((v) => v.voice_id === c.voice_id)), `${c.name} is cleared`);
    const used = [...trace.filter((t) => t.step === 'voice').map((t) => t.voiceId), ...trace.filter((t) => t.step === 'dialogue').flatMap((t) => t.voices)];
    assert.ok(used.every((id) => isClientCleared(voices.find((v) => v.voice_id === id))), 'every line spoken in a cleared voice');
  });

  test('the voice falls back to the second engine: the whole stage is redone there, never mixed', async () => {
    const p = await newDirectorFilm();
    // The second narrator line cannot be recorded on the primary engine.
    st.tts = (body) => (/the day begins/.test(body.text) ? new Response('down', { status: 503 }) : null);
    const r = await runDirector(p);
    assert.equal(r.code, 0, r.logs.join('\n'));
    const narration = (await store.listAssets(p.id, { kinds: ['voice'] })).filter((a) => a.status === 'ok' && !(a.meta && a.meta.dialogue));
    assert.equal(narration.length, 2);
    assert.ok(narration.every((a) => a.meta.engine === narration[0].meta.engine), 'one engine for every narrator line in the stage');
    assert.ok(trace.some((t) => t.provider === 'cartesia' && /Before the town wakes/.test(t.text)), 'the line made before the switch was recorded again');
  });

  test('a client film never uses the second engine: the voice stage retries the primary, then fails cleanly in PG1 words', async () => {
    const p = await newDirectorFilm({ client: { name: 'Acme Bakery', credit: true } });
    st.tts = () => new Response('{"detail":"ElevenLabs service unavailable"}', { status: 503 });
    const r = await runDirector(p, { clientWork: true });
    assert.equal(r.code, 1);
    assert.equal(r.film.status, 'failed');
    assert.equal(trace.filter((t) => t.provider === 'cartesia').length, 0, 'never the second engine for a client');
    assert.equal(trace.filter((t) => t.step === 'voice').length, 2, 'the line was sent twice on the primary engine');
    const msg = filmFailureMessage(r.film);
    assert.doesNotMatch(msg, BANNED);
  });

  test('white label: notes PDF voices, credits and every voice message name no provider or model', () => {
    const cast = castFilm({ timeline: SHOTS, script: SCRIPT, list: listOf(ALL) });
    const blocks = directorNotesBlocks({ project: { client: null }, director: { script: SCRIPT, cast, notes: [] }, timeline: SHOTS, qcReport: null, plan: null });
    const text = JSON.stringify(blocks);
    assert.match(text, /"Voices"/);
    assert.match(text, /\["Narrator","George"\]/);
    assert.match(text, /\["Mia","Granny Rose"\]/);
    assert.doesNotMatch(text, BANNED);
    for (const l of creditLines({ title: 'First Light' })) assert.doesNotMatch(l, BANNED);
    for (const m of [VOICE_TEXT.listUnavailable, VOICE_TEXT.notCleared, VOICE_TEXT.noKey, VOICE_TEXT.unknown('x', ['a', 'b', 'c']), VOICE_TEXT.ambiguous('x', [{ name: 'x', voice_id: '1' }])]) assert.doesNotMatch(m, BANNED);
    assert.doesNotMatch(voicesListText(listOf(ALL).voices), BANNED);
  });
});

// --- engine rules, unit -----------------------------------------------------------------

describe('voice engine rules', () => {
  const elOk = (text) => json({ audio_base64: Buffer.alloc(480).toString('base64'), alignment: { characters: [...text], character_start_times_seconds: [...text].map((c, i) => i * 0.05), character_end_times_seconds: [...text].map((c, i) => i * 0.05 + 0.04) } });
  test('the film voice is the one passed in; pcm_24000 is kept', async () => {
    const urls = [];
    const voice = createFilmVoice({ env: { ELEVENLABS_API_KEY: 'k' }, voiceId: () => 'filmVoice00001', log: () => {}, fetchImpl: async (u) => { urls.push(u); return elOk('hi'); } });
    const line = await voice({ text: 'hi', stage: newVoiceStage() });
    assert.equal(line.voiceId, 'filmVoice00001');
    assert.match(urls[0], /\/filmVoice00001\/with-timestamps\?output_format=pcm_24000$/);
  });
  test('a client film\'s voice never reaches the second engine', async () => {
    const hosts = [];
    const voice = createFilmVoice({ env: { ELEVENLABS_API_KEY: 'k', CARTESIA_API_KEY: 'c' }, clientWork: true, sleep: async () => {}, log: () => {}, fetchImpl: async (u) => { hosts.push(new URL(u).hostname); return new Response('down', { status: 503 }); } });
    await assert.rejects(voice({ text: 'hi', stage: newVoiceStage() }), (e) => { assert.doesNotMatch(e.message, BANNED); return true; });
    assert.deepEqual(hosts, ['api.elevenlabs.io', 'api.elevenlabs.io'], 'retried on the primary engine, never anywhere else');
  });
});
