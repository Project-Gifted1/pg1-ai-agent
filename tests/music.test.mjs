/**
 * PG1 Sound (/music: lib/music/*, scripts/music-render.mjs, api/chat.mjs):
 *
 *  - the AI router's music tier: Lyria on the paid Gemini key -> ElevenLabs
 *    (only with its key); out of credit, still throttled after
 *    the waits, down, or a bad key moves on; a content refusal stops; the
 *    free Gemini key never; every call is a pg1_ai_usage row;
 *  - the safety pre-filter: artist and band names, "in the voice/style of",
 *    song titles, pasted or borrowed lyrics, voice cloning; descriptive
 *    prompts pass; nothing is stored, charged or sent when it refuses;
 *  - the export zip: master WAV, four stems, MIDI per melodic stem and a
 *    README with BPM, key, provider and licence note, never claiming
 *    exclusive copyright;
 *  - the whole flow against a real Postgres: /music -> two previews ->
 *    approve one take (the other is declined) -> final render with its
 *    licence note -> /music export; charges and refunds against the
 *    per-track cap; /music retry and /music edit; operator only; no
 *    provider name on the card.
 *
 * Run with: node --test tests/music.test.mjs
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { TASKS, DATA, planRoute, resolveKeys, ENGINE_LABELS, __resetRouterState, isTripped } from '../lib/aiRouter.mjs';
import { UPSTREAM_BRAND_RE } from '../lib/upstreamFailure.mjs';
import { GEMINI_API, REPLICATE_API } from '../lib/film/providers.mjs';
import { estimateMusic } from '../lib/music/pipeline.mjs';
import {
  generateMusic, musicPlan, musicClipPlan, lyriaClipModel, musicCallUsd, musicPrompt, elevenLabsWav, lyriaRequestBody, LICENCE_NOTES, ELEVENLABS_MUSIC_URL, MUSIC_SAMPLE_RATE
} from '../lib/music/engines.mjs';
import { checkMusicRequest, lyricFingerprints, SAFETY_REFUSALS, REFUSAL_ALTERNATIVE } from '../lib/music/safety.mjs';
import { buildZip, readZip, runExport, exportReadme, STEMS, MB, StorageLimitError, guardedUpload, storageMaxBytes } from '../lib/music/export.mjs';
import { parseMusicCommand, parseMusicFlags, normaliseKey, musicCapUsd, MUSIC_ACTIONS, isMusicCommand } from '../lib/music/text.mjs';
import { createMusicStore } from '../lib/music/store.mjs';
import { signMusicToken, verifyMusicToken, MUSIC_WORKFLOW } from '../lib/music/dispatch.mjs';
import { handleMusicCommand, handleMusicApproval, confirmMusicBudget, musicCard } from '../lib/music/chat.mjs';
import { main as workerMain } from '../scripts/music-render.mjs';
import { routedFetch, json } from './helpers/filmDb.mjs';
import { makeMusicDb, musicDbRoutes } from './helpers/musicDb.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase.test';
const SECRET = 'music-render-secret-0123456789abcdef';
const PAID = 'paid-gemini-key-0123456789';
const FREE = 'free-gemini-key-0123456789';
const ELEVEN = 'eleven-key-0123456789';
const REPLICATE = 'r8_replicate-token-0123456789';
const NO_CREDIT = '{"detail":"You have insufficient credit to run this model. Go to https://replicate.com/account/billing#billing to purchase credit."}';
const ALL_BRANDS_RE = new RegExp(`${UPSTREAM_BRAND_RE.source}|demucs|basic-pitch|synthid`, 'i');

const quiet = () => {};
const noSleep = async () => {};
const WAV = Buffer.concat([Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE', 'latin1'), Buffer.alloc(64, 1)]);

// The three music engines, answering per state.<engine>(n, body, url) or
// with a finished track.
function engineRoutes(state) {
  state.seen = state.seen || [];
  state.n = state.n || { elevenlabs: 0, lyria: 0, replicate: 0 };
  return [
    [ELEVENLABS_MUSIC_URL, (u, o, body) => {
      const n = ++state.n.elevenlabs;
      state.seen.push({ engine: 'elevenlabs', url: u, body, key: o.headers['xi-api-key'] });
      return (state.elevenlabs && state.elevenlabs(n, body, u)) || new Response(WAV, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    }],
    [`${GEMINI_API}/`, (u, o, body) => {
      const n = ++state.n.lyria;
      state.seen.push({ engine: 'lyria', url: u, body, key: o.headers['x-goog-api-key'] });
      return (state.lyria && state.lyria(n, body, u)) || json({ candidates: [{ content: { parts: [{ text: '[Verse] original words' }, { inlineData: { mimeType: 'audio/mpeg', data: Buffer.from(`lyria-mp3-${n}`).toString('base64') } }] }, finishReason: 'STOP' }] });
    }],
    [`${REPLICATE_API}/models/`, (u, o, body) => {
      const n = ++state.n.replicate;
      state.seen.push({ engine: 'replicate', url: u, body, key: o.headers.Authorization });
      return (state.replicate && state.replicate(n, body, u)) || json({ id: `pred-${n}`, status: 'succeeded', output: `https://replicate.delivery/music-${n}.wav` }, 201);
    }],
    ['https://replicate.delivery/', () => new Response(WAV, { status: 200 })]
  ];
}

// A ledger that keeps the rows (the shared one writes them to pg1_ai_usage).
function memLedger() {
  const rows = [];
  return { rows, record(r) { rows.push(r); return Promise.resolve(); }, spent: () => null, totals: async () => null };
}

const spec = (extra = {}) => ({ prompt: 'dusty boom-bap beat, vinyl crackle, jazzy piano', instrumental: true, bpm: 88, key: 'F minor', length: 'short', lyrics: '', ...extra });

beforeEach(() => __resetRouterState());
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

// --- 1. the router's music tier ----------------------------------------------------------

describe('router: the music tier', () => {
  test('order (ROUTING_CHAINS.music): Lyria on the paid Gemini key -> ElevenLabs (only with its key); never Replicate, never the free key', () => {
    const full = { PG1_DAILY_SPEND_CAP_USD: '1000', ELEVENLABS_API_KEY: ELEVEN, GEMINI_API_KEY_PAID: PAID, GEMINI_API_KEY_FREE: FREE, REPLICATE_API_TOKEN: REPLICATE };
    const plan = planRoute(TASKS.MUSIC, { env: full, dataClass: DATA.OPERATOR });
    assert.deepEqual(plan.map((c) => c.provider), ['gemini_paid', 'elevenlabs']);
    assert.deepEqual(plan.map((c) => c.family), ['lyria', 'elevenlabs_music']);
    assert.equal(plan[0].key, PAID);
    assert.deepEqual(plan[0].models, ['lyria-3.5']);
    assert.deepEqual(plan[1].models, ['music_v2_5'], 'ElevenLabs default model');
    assert.ok(plan.every((c) => c.key !== FREE), 'the free Gemini key is never in the music plan, even for the operator');
    assert.ok(plan.every((c) => c.provider !== 'replicate'), 'Replicate\'s Lyria 2 is out of the chain (R1)');
    assert.equal(resolveKeys(full).elevenlabs, ELEVEN);
    assert.equal(ENGINE_LABELS.elevenlabs, 'PG1 music engine');

    assert.deepEqual(planRoute(TASKS.MUSIC, { env: { ...full, PG1_DAILY_SPEND_CAP_USD: '1000', ELEVENLABS_API_KEY: '' } }).map((c) => c.provider), ['gemini_paid'], 'no ElevenLabs without its key');
    assert.deepEqual(musicPlan({ PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: FREE, GEMINI_API_KEY_FREE: FREE, ELEVENLABS_API_KEY: ELEVEN }).map((c) => c.provider), ['elevenlabs'], 'a paid key that holds the free key is not used');
    assert.deepEqual(musicPlan({ PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY: PAID, ELEVENLABS_API_KEY: ELEVEN }).map((c) => c.provider), ['elevenlabs'], 'old Gemini names are never used for music');
    assert.deepEqual(musicPlan({ ...full, PG1_MUSIC_LYRIA_MODEL: 'lyria-3.6' })[0].models, ['lyria-3.6']);
    assert.deepEqual(musicPlan(full, { exclude: ['elevenlabs'] }).map((c) => c.provider), ['gemini_paid'], 'previews leave ElevenLabs out');
    assert.deepEqual(musicPlan({ ...full, PG1_DAILY_BUDGET_GEMINI_PAID_USD: '0' }).map((c) => c.provider), ['elevenlabs'], 'over its daily budget');
  });

  test('Lyria makes the track; Lyria out of credit -> ElevenLabs; every call is a usage row', async () => {
    let state = {};
    let ledger = memLedger();
    const env = { PG1_DAILY_SPEND_CAP_USD: '1000', ELEVENLABS_API_KEY: ELEVEN, GEMINI_API_KEY_PAID: PAID, REPLICATE_API_TOKEN: REPLICATE };
    let out = await generateMusic({ env, spec: spec({ length: 'full' }), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet, ledger });
    assert.equal(out.ok, true);
    assert.equal(out.provider, 'gemini_paid');
    assert.equal(out.model, 'lyria-3.5');
    assert.equal(out.mime, 'audio/mpeg');
    assert.equal(out.ext, 'mp3');
    assert.equal(out.bytes.toString(), 'lyria-mp3-1');
    assert.equal(out.licenceNote, LICENCE_NOTES.gemini_paid);
    assert.match(out.licenceNote, /SynthID watermarked; commercial use under Gemini API terms; source MP3/);
    assert.equal(out.lyricsText, '[Verse] original words');
    assert.deepEqual(state.seen[0].body.generationConfig, { responseModalities: ['AUDIO', 'TEXT'] });
    assert.equal(state.seen[0].key, PAID);
    assert.match(state.seen[0].url, /\/lyria-3\.5:generateContent$/);
    assert.equal(ledger.rows[0].cost_usd, 0.08);
    assert.ok(!JSON.stringify(ledger.rows).includes('boom-bap'), 'no prompt in the usage rows');

    __resetRouterState();
    state = { lyria: () => new Response(NO_CREDIT, { status: 402 }) };
    ledger = memLedger();
    out = await generateMusic({ env, spec: spec({ length: 'full' }), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet, ledger });
    assert.equal(out.provider, 'elevenlabs');
    assert.deepEqual(state.seen.map((s) => s.engine), ['lyria', 'elevenlabs']);
    // ElevenLabs is asked for lossless PCM.
    assert.match(state.seen[1].url, /\?output_format=mp3_44100_192$/);
    assert.equal(state.seen[1].key, ELEVEN);
    assert.equal(state.seen[1].body.force_instrumental, true);
    assert.equal(state.seen[1].body.music_length_ms, 150000);
    assert.deepEqual(ledger.rows.map((r) => [r.provider, r.task, r.ok, r.unit]), [['gemini_paid', 'music', false, 'music_lyria'], ['elevenlabs', 'music', true, 'music_elevenlabs']]);
    assert.ok(isTripped('gemini_paid#1'), 'the drained key waits out the breaker');
    assert.equal(state.n.replicate, 0);
  });

  test('throttled: the same request is sent again; still throttled after the waits -> the next engine', async () => {
    const throttle = () => new Response('{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota). Please retry in 5s.","status":"RESOURCE_EXHAUSTED"}}', { status: 429, headers: { 'retry-after': '5' } });
    // Lyria throttled twice, then answers: no fallback.
    let state = { lyria: (n) => (n <= 2 ? throttle() : undefined) };
    const waits = [];
    const ledger = memLedger();
    let out = await generateMusic({ env: { PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID, ELEVENLABS_API_KEY: ELEVEN }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: async (ms) => { waits.push(ms); }, log: quiet, ledger });
    assert.equal(out.provider, 'gemini_paid');
    assert.equal(state.n.lyria, 3);
    assert.equal(state.n.elevenlabs, 0);
    assert.deepEqual(waits, [5000, 5000], 'waits as the engine says');
    assert.equal(ledger.rows.filter((r) => r.status === 429).length, 2, 'each throttled send is logged');
    // Throttled to the end: ElevenLabs makes it.
    __resetRouterState();
    state = { lyria: () => throttle() };
    out = await generateMusic({ env: { PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID, ELEVENLABS_API_KEY: ELEVEN }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(out.ok, true);
    assert.equal(out.provider, 'elevenlabs');
    assert.equal(out.fallbacks, 1);
    assert.equal(state.n.lyria, 4, 'MUSIC_THROTTLE_POLICY: four sends');
    assert.equal(out.licenceNote, LICENCE_NOTES.elevenlabs);
  });

  test('everything out of credit -> a clear billing failure', async () => {
    const state = { lyria: () => new Response('{"error":{"code":429,"message":"Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.","status":"RESOURCE_EXHAUSTED"}}', { status: 429 }), elevenlabs: () => new Response('{"detail":{"status":"quota_exceeded","message":"You have insufficient credits for this request"}}', { status: 401 }) };
    const out = await generateMusic({ env: { PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID, ELEVENLABS_API_KEY: ELEVEN }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(state.n.lyria, 1, 'a credit failure is not retried');
    assert.equal(out.ok, false);
    assert.equal(out.kind, 'billing');
    assert.equal(out.refused, false);
    assert.deepEqual(out.failures.map((f) => f.provider), ['gemini_paid', 'elevenlabs']);
  });

  test('a 5xx or a bad key moves on; a content refusal stops the route', async () => {
    let state = { lyria: () => new Response('upstream error', { status: 503 }) };
    let out = await generateMusic({ env: { PG1_DAILY_SPEND_CAP_USD: '1000', ELEVENLABS_API_KEY: ELEVEN, GEMINI_API_KEY_PAID: PAID }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(out.provider, 'elevenlabs');
    __resetRouterState();
    state = { lyria: () => json({ promptFeedback: { blockReason: 'SAFETY' } }) };
    out = await generateMusic({ env: { PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID, ELEVENLABS_API_KEY: ELEVEN }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(out.ok, false);
    assert.equal(out.refused, true);
    assert.equal(out.kind, 'refused');
    assert.equal(state.n.elevenlabs, 0, 'a refusal is never routed round');
    __resetRouterState();
    state = { lyria: () => json({ candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }] }) };
    out = await generateMusic({ env: { PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID, ELEVENLABS_API_KEY: ELEVEN }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(out.kind, 'refused');
    assert.equal(state.n.elevenlabs, 0);
    __resetRouterState();
    state = { lyria: () => new Response('upstream error', { status: 503 }), elevenlabs: () => new Response('{"detail":{"status":"bad_prompt","message":"The prompt contains copyrighted material"}}', { status: 400 }) };
    out = await generateMusic({ env: { PG1_DAILY_SPEND_CAP_USD: '1000', ELEVENLABS_API_KEY: ELEVEN, GEMINI_API_KEY_PAID: PAID }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(out.kind, 'refused');
    out = await generateMusic({ env: { PG1_DAILY_SPEND_CAP_USD: '1000', REPLICATE_API_TOKEN: REPLICATE }, spec: spec(), fetchImpl: routedFetch([]), log: quiet });
    assert.equal(out.kind, 'not_configured', 'Replicate alone is no music engine now');
  });

  test('the Lyria 30-second clip model: its own plan, model id and price; estimates use it for previews and short tracks', async () => {
    const full = { PG1_DAILY_SPEND_CAP_USD: '1000', ELEVENLABS_API_KEY: ELEVEN, GEMINI_API_KEY_PAID: PAID, GEMINI_API_KEY_FREE: FREE, REPLICATE_API_TOKEN: REPLICATE };
    assert.equal(lyriaClipModel({}), 'lyria-3-clip-preview');
    assert.equal(lyriaClipModel({ PG1_MUSIC_LYRIA_CLIP_MODEL: 'lyria-3-clip' }), 'lyria-3-clip', 'PG1_MUSIC_LYRIA_CLIP_MODEL overrides it');
    assert.equal(lyriaClipModel({ PG1_MUSIC_LYRIA_CLIP_MODEL: 'bad model id!' }), 'lyria-3-clip-preview', 'a malformed override is ignored');
    const clip = musicClipPlan(full);
    assert.deepEqual(clip.map((c) => [c.provider, c.family, c.key, c.models, c.clip]), [['gemini_paid', 'lyria', PAID, ['lyria-3-clip-preview'], true]], 'the paid Gemini key only');
    assert.notEqual(clip[0].keyId, musicPlan(full)[0].keyId, 'its own breaker: a failing clip model never holds back lyria-3.5');
    assert.deepEqual(musicClipPlan({ PG1_DAILY_SPEND_CAP_USD: '1000', REPLICATE_API_TOKEN: REPLICATE, GEMINI_API_KEY_FREE: FREE }), [], 'no paid key, no clip (never the free key)');
    assert.equal(musicCallUsd('gemini_paid', 'short', { clip: true }), 0.04);
    assert.equal(musicCallUsd('gemini_paid', 'short'), 0.08, 'lyria-3.5 keeps its price');
    assert.equal(estimateMusic(full, 'preview'), 0.08, 'two clips');
    assert.equal(estimateMusic(full, 'final', 'short'), 0.04, 'a short final is a clip');
    assert.equal(estimateMusic(full, 'final', 'full'), 0.75, 'a full final keeps the full tier (5 minutes at 0.15 USD per minute, the registry price)');
    assert.equal(estimateMusic({ PG1_DAILY_SPEND_CAP_USD: '1000', REPLICATE_API_TOKEN: REPLICATE }, 'preview'), 0, 'Replicate alone is no music engine now');

    // A call on the clip plan: the clip model's URL, its unit and price in the usage row.
    const state = {};
    const ledger = memLedger();
    const env = { PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID, PG1_MUSIC_LYRIA_CLIP_MODEL: 'lyria-3-clip' };
    const out = await generateMusic({ env, spec: spec(), plan: musicClipPlan(env), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet, ledger });
    assert.equal(out.ok, true);
    assert.equal(out.clip, true);
    assert.equal(out.model, 'lyria-3-clip');
    assert.equal(out.costUsd, 0.04);
    assert.match(state.seen[0].url, /\/lyria-3-clip:generateContent$/);
    assert.deepEqual(ledger.rows.map((r) => [r.provider, r.model, r.ok, r.unit, r.cost_usd]), [['gemini_paid', 'lyria-3-clip', true, 'music_lyria_clip', 0.04]]);
  });

  test('prompt and request shapes; raw PCM becomes a WAV with the right channel count', () => {
    const p = musicPrompt(spec({ instrumental: false, lyrics: 'my own first line\nmy own second line', length: 'full', variant: 2 }));
    assert.match(p, /^Original composition\. dusty boom-bap beat/);
    assert.match(p, /Tempo: 88 BPM/);
    assert.match(p, /Key: F minor/);
    assert.match(p, /complete song of about 2\.5 minutes/);
    assert.match(p, /Sing these original lyrics, written for this track:\nmy own first line/);
    assert.match(p, /Take 2: a contrasting arrangement/);
    assert.deepEqual(lyriaRequestBody(spec()).generationConfig.responseModalities, ['AUDIO', 'TEXT']);
    const stereo = elevenLabsWav(Buffer.alloc(MUSIC_SAMPLE_RATE * 4 * 2), { seconds: 2 });
    assert.equal(stereo.toString('ascii', 0, 4), 'RIFF');
    assert.equal(stereo.readUInt16LE(22), 2);
    const mono = elevenLabsWav(Buffer.alloc(MUSIC_SAMPLE_RATE * 2 * 2), { seconds: 2 });
    assert.equal(mono.readUInt16LE(22), 1);
    assert.equal(elevenLabsWav(Buffer.alloc(MUSIC_SAMPLE_RATE * 2 * 2), { seconds: 2, env: { PG1_MUSIC_ELEVENLABS_CHANNELS: '2' } }).readUInt16LE(22), 2);
    assert.equal(elevenLabsWav(WAV, { seconds: 2 }), WAV, 'a WAV is kept as it is');
  });
});

// --- 2. the safety pre-filter --------------------------------------------------------------

describe('safety pre-filter', () => {
  const refused = (prompt, lyrics = '', env = {}) => checkMusicRequest({ prompt, lyrics, env });

  test('real artist and band names are refused, in any case, with a descriptive alternative', () => {
    for (const p of [
      'a song like Taylor Swift', 'sounds like coldplay with big drums', 'a track by Beyoncé', 'daft punk style house', 'rap like Drake over a trap beat',
      'BTS energy k-pop anthem', 'inspired by Hans Zimmer', 'a la Daft Punk', 'piano piece by The Midnight Riders', 'something Kendrick Lamar would rap on'
    ]) {
      const r = refused(p);
      assert.equal(r.ok, false, p);
      assert.match(r.reason, /^(?:artist|voice_of)$/, p);
      assert.ok(r.message.includes(REFUSAL_ALTERNATIVE), `${p}: offers genre, mood, instruments, era`);
      assert.ok(!/taylor|coldplay|beyonc|daft|drake|bts|zimmer|kendrick|midnight/i.test(r.message), `${p}: the refusal never repeats the name`);
    }
  });

  test('"in the voice / style of <person>" is refused; genre, mood, instruments and era pass', () => {
    for (const p of ['in the voice of Freddie Mercury', 'a ballad in the style of Adele', 'vocals of my neighbour Sam', 'in the voice of my grandmother', 'sung like Whitney Houston']) {
      const r = refused(p);
      assert.equal(r.ok, false, p);
      assert.equal(r.reason, 'voice_of', p);
    }
    for (const p of [
      'warm 70s soul, Rhodes piano, brushed drums, falsetto hook', 'in the style of 80s synthwave, driving bass', 'epic orchestral score for a space battle',
      'a drake swimming on a pond, playful woodwinds', 'the future of jazz, smooth sax', 'like a summer breeze, acoustic guitar', 'inspired by rainy nights in Tokyo',
      'the voice of an angel over cinematic strings', 'sounds like rain on a tin roof, ambient', 'style of 90s eurodance', 'lo-fi hip hop for studying, 72 BPM'
    ]) assert.deepEqual(refused(p), { ok: true }, p);
  });

  test('real song titles, covers and remixes are refused', () => {
    for (const p of ['a lo-fi version of Bohemian Rhapsody', 'cover of a famous song, acoustic', 'make the song called "Golden Hour" again', 'remix of Blinding Lights', 'Hotel California but techno']) {
      const r = refused(p);
      assert.equal(r.ok, false, p);
      assert.equal(r.reason, 'song_title', p);
    }
  });

  test('lyrics: only the operator\'s own (--lyrics) or PG1\'s; pasted or borrowed lyrics are refused', () => {
    assert.equal(refused('use the lyrics from Hey Jude').reason, 'lyrics');
    assert.equal(refused('sing the real lyrics of that hit, slower').reason, 'lyrics');
    assert.equal(refused('upbeat pop', 'and we danced all night\nsinging Bohemian Rhapsody').reason, 'lyrics', 'lyrics that name a known song');
    // A lyric block pasted into the description instead of --lyrics.
    const pasted = refused('upbeat pop song\nwalking down the empty road tonight\nevery light is fading out of sight\nholding on to what we had before\nnever coming back here anymore');
    assert.equal(pasted.reason, 'pasted_lyrics');
    assert.match(pasted.message, /--lyrics/);
    assert.equal(refused('Lyrics:\nmy words here today and more\nmore of them').reason, 'pasted_lyrics');
    assert.equal(refused('[Verse 1]\nsome words go here').reason, 'pasted_lyrics');
    // Lyrics the operator listed as off limits, by fingerprint only.
    const known = 'these are words from a song that someone else wrote long ago';
    const env = { PG1_MUSIC_LYRIC_FINGERPRINTS: [...lyricFingerprints(known)].slice(0, 2).join(',') };
    assert.equal(refused('acoustic ballad', `intro line\n${known.toUpperCase()}!`, env).reason, 'lyrics');
    // The operator's own lyrics pass.
    assert.deepEqual(refused('acoustic ballad, warm', 'the kettle sings at seven\nmy coat hangs by the door', env), { ok: true });
  });

  test('voice cloning of anyone (the operator included) is refused', () => {
    for (const p of ['clone my voice and sing a ballad', 'use the voice from this recording', 'a deepfake of a singer', 'voice conversion of my demo', 'train it on my vocals', 'make it sound exactly like the attached voice']) {
      const r = refused(p);
      assert.equal(r.ok, false, p);
      assert.equal(r.reason, 'voice_clone', p);
      assert.match(r.message, /does not clone or imitate anyone's voice, yours included/);
    }
  });

  test('a refused /music never reaches the vault, the cap or an engine', async () => {
    const fetchImpl = routedFetch([]);
    for (const text of ['/music a track by Beyoncé', '/music clone my voice --instrumental', '/music remix of Blinding Lights --bpm 120', '/music acoustic pop --lyrics "singing Bohemian Rhapsody all night"']) {
      const out = await handleMusicCommand({ text, env: { PG1_VIDEO_RENDER_SECRET: SECRET, GITHUB_TOKEN: 'gh' }, supUrl: SUP_URL, supKey: 'k', isOperator: true, fetchImpl });
      assert.ok(Object.values(SAFETY_REFUSALS).includes(out.reply), text);
      assert.ok(!out.musicTrack);
    }
    assert.equal(fetchImpl.calls.length, 0, 'no network call at all');
  });
});

// --- 3. commands and flags -----------------------------------------------------------------

describe('commands and flags', () => {
  test('parsing', () => {
    assert.ok(isMusicCommand('/music lo-fi'));
    assert.ok(!isMusicCommand('/musician'));
    assert.deepEqual(parseMusicCommand('/music'), { sub: 'help', id: null, rest: '' });
    assert.deepEqual(parseMusicCommand('/music status'), { sub: 'list', id: null, rest: '' });
    assert.deepEqual(parseMusicCommand('/music library'), { sub: 'list', id: null, rest: '' });
    assert.deepEqual(parseMusicCommand('/music export 1a2b3c4d'), { sub: 'export', id: '1a2b3c4d', rest: '' });
    assert.deepEqual(parseMusicCommand('/music edit 1a2b3c4d slower --bpm 80'), { sub: 'edit', id: '1a2b3c4d', rest: 'slower --bpm 80' });
    assert.equal(parseMusicCommand('/music dreamy synthwave --instrumental').sub, 'new');
    const f = parseMusicFlags('dreamy synthwave --bpm 104 --key F#m --length full --lyrics "neon on the water / we drive"');
    assert.equal(f.ok, true);
    assert.equal(f.prompt, 'dreamy synthwave');
    assert.deepEqual(f.spec, { instrumental: false, bpm: 104, key: 'F# minor', length: 'full', lyrics: 'neon on the water\nwe drive' });
    assert.deepEqual(parseMusicFlags('ambient --instrumental').spec.instrumental, true);
    assert.match(parseMusicFlags('x --bpm 900').message, /40 to 240/);
    assert.match(parseMusicFlags('x --key H').message, /--key takes a key/);
    assert.match(parseMusicFlags('x --length epic').message, /short .* or full/);
    assert.match(parseMusicFlags('x --tempo 3').message, /--tempo is not a \/music option/);
    assert.match(parseMusicFlags('x --instrumental --lyrics "a b c"').message, /cannot go together/);
    assert.equal(normaliseKey('Bb major'), 'Bb major');
    assert.equal(normaliseKey('am'), 'A minor');
    assert.equal(normaliseKey('C'), 'C major');
    assert.equal(musicCapUsd({}), 2);
    assert.equal(musicCapUsd({ PG1_MUSIC_TRACK_CAP: '3.50' }), 3.5);
    assert.equal(musicCapUsd({ PG1_MUSIC_TRACK_CAP: 'lots' }), 2);
  });

  test('guests cannot use /music or its approvals', async () => {
    const fetchImpl = routedFetch([]);
    const out = await handleMusicCommand({ text: '/music lo-fi beat', env: {}, supUrl: SUP_URL, supKey: 'k', isOperator: false, fetchImpl });
    assert.match(out.reply, /signed-in operator only/);
    const ap = await handleMusicApproval({ row: { action_type: MUSIC_ACTIONS.final, plan: {} }, decision: 'approve', supUrl: SUP_URL, supKey: 'k', isOperator: false, fetchImpl });
    assert.equal(ap.resolution, null);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

// --- 4. the export: FLAC files, one upload each, the zip when it fits -------------------

// A command runner standing in for ffmpeg and scripts/music_stems.py.
// `pad` makes an output bigger: { 'drums.flac': bytes }.
function fakeRun(calls, { pad = {} } = {}) {
  return async (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'ffmpeg') {
      const out = args[args.length - 1];
      const head = out.endsWith('.flac') ? Buffer.from(`fLaC-${path.basename(out, '.flac')}`) : Buffer.concat([WAV, Buffer.from('master')]);
      await writeFile(out, Buffer.concat([head, Buffer.alloc(pad[path.basename(out)] || 0, 7)]));
      return { stdout: '', stderr: '' };
    }
    const [, , outDir] = args;
    await mkdir(outDir, { recursive: true });
    const stems = {};
    for (const s of STEMS) { stems[s] = path.join(outDir, `${s}.wav`); await writeFile(stems[s], Buffer.concat([WAV, Buffer.from(s)])); }
    const midi = {};
    for (const s of ['bass', 'vocals', 'other']) {
      if (s === 'vocals' && args.includes('--no-vocals-midi')) continue;
      midi[s] = path.join(outDir, `${s}.mid`);
      await writeFile(midi[s], Buffer.from(`MThd-${s}`));
    }
    return { stdout: `[progress]\n${JSON.stringify({ stems, midi, bpm: 87.96, key: 'F minor' })}\n`, stderr: '' };
  };
}

function exportFixture() {
  const vault = new Map([['music/t1/master/v1-master.mp3', Buffer.from('mp3')]]);
  const uploads = [];
  const store = {
    download: async (p) => vault.get(p),
    upload: async (p, bytes, mime) => { uploads.push({ p, bytes: Buffer.from(bytes), mime }); return p; }
  };
  const track = {
    id: '11111111-2222-4333-8444-555555555555', title: 'Dusty Boom Bap Beat', version: 1, master_path: 'music/t1/master/v1-master.mp3',
    provider: 'gemini_paid', model: 'lyria-3.5', licence_note: LICENCE_NOTES.gemini_paid, duration_s: 31.2, options: { instrumental: true, bpm: 88, key: 'F minor' }
  };
  return { vault, uploads, store, track };
}

const EXPORT_DIR = 'music/11111111-2222-4333-8444-555555555555/export';
const PER_FILE = ['master.flac', 'drums.flac', 'bass.flac', 'vocals.flac', 'other.flac', 'midi-bass.mid', 'midi-other.mid', 'README.md'];

describe('export', () => {
  test('zip round trip: stored audio, deflated text, CRCs checked, readable by another zip reader', async () => {
    const zip = buildZip([{ name: 'a/README.md', data: 'hello '.repeat(100) }, { name: 'a/x.flac', data: WAV }, { name: 'a/m.mid', data: Buffer.from([1, 2, 3]) }]);
    const back = readZip(zip);
    assert.deepEqual(back.map((e) => e.name), ['a/README.md', 'a/x.flac', 'a/m.mid']);
    assert.equal(back[0].data.toString(), 'hello '.repeat(100));
    assert.deepEqual(back[1].data, WAV);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'music-zip-'));
    const file = path.join(dir, 't.zip');
    await writeFile(file, zip);
    let other = null;
    try { other = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip() or "ok"); print(",".join(z.namelist()))', file], { encoding: 'utf8' }); } catch (e) { other = null; }
    if (other !== null) assert.equal(other.trim(), 'ok\na/README.md,a/x.flac,a/m.mid');
  });

  test('every file is its own upload (FLAC master and stems, MIDI, README.md), then the zip when it fits', async () => {
    const { uploads, store, track } = exportFixture();
    const calls = [];
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'music-export-'));
    const r = await runExport({ track, store, workdir, maxBytes: 48 * MB, run: fakeRun(calls), now: new Date('2026-10-13T12:00:00Z') });
    assert.deepEqual(uploads.map((u) => u.p), [...PER_FILE.map((f) => `${EXPORT_DIR}/v1-${f}`), `${EXPORT_DIR}/v1-Dusty_Boom_Bap_Beat_stems.zip`]);
    assert.deepEqual(uploads.map((u) => u.mime), [...Array(5).fill('audio/flac'), 'audio/midi', 'audio/midi', 'text/markdown', 'application/zip']);
    assert.deepEqual(r.parts.map((p) => [p.part, p.stem || null]), [['master', null], ['drums', null], ['bass', null], ['vocals', null], ['other', null], ['midi', 'bass'], ['midi', 'other'], ['readme', null]], 'no vocals MIDI for an instrumental');
    assert.deepEqual(r.parts.map((p) => p.download).slice(0, 2), ['Dusty_Boom_Bap_Beat_master.flac', 'Dusty_Boom_Bap_Beat_drums.flac']);
    assert.equal(uploads[1].bytes.toString(), 'fLaC-drums');
    assert.deepEqual(r.zip, { name: 'Dusty_Boom_Bap_Beat_stems.zip', path: `${EXPORT_DIR}/v1-Dusty_Boom_Bap_Beat_stems.zip`, size: uploads[8].bytes.length });
    assert.equal(r.zipSkipped, null);
    const names = readZip(uploads[8].bytes).map((e) => e.name);
    assert.deepEqual(names, [
      'Dusty_Boom_Bap_Beat_stems/Dusty_Boom_Bap_Beat_master.flac',
      'Dusty_Boom_Bap_Beat_stems/stems/Dusty_Boom_Bap_Beat_drums.flac',
      'Dusty_Boom_Bap_Beat_stems/stems/Dusty_Boom_Bap_Beat_bass.flac',
      'Dusty_Boom_Bap_Beat_stems/stems/Dusty_Boom_Bap_Beat_vocals.flac',
      'Dusty_Boom_Bap_Beat_stems/stems/Dusty_Boom_Bap_Beat_other.flac',
      'Dusty_Boom_Bap_Beat_stems/midi/Dusty_Boom_Bap_Beat_bass.mid',
      'Dusty_Boom_Bap_Beat_stems/midi/Dusty_Boom_Bap_Beat_other.mid',
      'Dusty_Boom_Bap_Beat_stems/README.md'
    ]);
    // ffmpeg: the master to WAV for the separation, then FLAC for the master and each stem.
    assert.deepEqual(calls[0].slice(-8), ['-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', path.join(workdir, 'master.wav')]);
    assert.equal(calls[1][1], 'scripts/music_stems.py');
    assert.ok(calls[1].includes('--no-vocals-midi'));
    const flac = calls.filter((c) => c[0] === 'ffmpeg' && c[c.length - 1].endsWith('.flac'));
    assert.equal(flac.length, 5);
    assert.ok(flac.every((c) => c.includes('flac') && c.includes('s16') && c.includes('44100')));
    assert.equal(r.bpm, 87.96);
    assert.equal(r.key, 'F minor');

    const readme = uploads[7].bytes.toString();
    assert.match(readme, /^# Dusty Boom Bap Beat — stems export/);
    assert.match(readme, /- BPM: 87\.96 \(detected; asked for 88\)/);
    assert.match(readme, /- Key: F minor \(detected; asked for F minor\)/);
    assert.match(readme, /- Provider: gemini_paid/);
    assert.match(readme, /- Model: lyria-3\.5/);
    assert.match(readme, /- Licence: SynthID watermarked; commercial use under Gemini API terms; source MP3/);
    assert.match(readme, /The master and the stems are FLAC: lossless/);
    assert.match(readme, /Any DAW can import them as they are, or\s+convert them to WAV/);
    assert.match(readme, /No exclusive copyright is claimed\s+or granted/);
    assert.match(readme, /- midi\/bass\.mid/);
    assert.match(readme, /- stems\/drums\.flac/);
  });

  test('the zip over the storage limit is skipped; the separate files are still the export', async () => {
    const { uploads, store, track } = exportFixture();
    // Each file is ~900 bytes; together they are far over a 2 KB limit.
    const pad = Object.fromEntries(['master.flac', 'drums.flac', 'bass.flac', 'vocals.flac', 'other.flac'].map((f) => [f, 900]));
    const r = await runExport({ track, store, workdir: await mkdtemp(path.join(os.tmpdir(), 'music-export-')), maxBytes: 2048, run: fakeRun([], { pad }) });
    assert.equal(r.zip, null);
    assert.ok(r.zipSkipped.size > 2048);
    assert.deepEqual(uploads.map((u) => u.p), PER_FILE.map((f) => `${EXPORT_DIR}/v1-${f}`), 'every file, no zip');
    assert.ok(uploads.every((u) => u.bytes.length <= 2048));
  });

  test('size guard: one file over the limit stops the export before anything is uploaded', async () => {
    const { uploads, store, track } = exportFixture();
    const pad = { 'vocals.flac': 5000 };
    await assert.rejects(
      runExport({ track, store, workdir: await mkdtemp(path.join(os.tmpdir(), 'music-export-')), maxBytes: 4096, run: fakeRun([], { pad }) }),
      (e) => e instanceof StorageLimitError && e.code === 'file_too_large' && e.file === 'vocals.flac' && /^file too large for storage limit: vocals\.flac/.test(e.message)
    );
    assert.equal(uploads.length, 0, 'nothing half-stored');
    // guardedUpload: checked before every upload.
    const sent = [];
    await assert.rejects(guardedUpload({ upload: async (p) => { sent.push(p); return p; } }, 'music/x/master/v1-master.wav', Buffer.alloc(11), 'audio/wav', 10), StorageLimitError);
    assert.equal(sent.length, 0);
    assert.equal(await guardedUpload({ upload: async (p) => p }, 'a/b.flac', Buffer.alloc(10), 'audio/flac', 10), 'a/b.flac', 'exactly at the limit is allowed');
  });

  test('PG1_STORAGE_MAX_MB: default 48, decimals allowed, nonsense ignored', () => {
    assert.equal(storageMaxBytes({}), 48 * MB);
    assert.equal(storageMaxBytes({ PG1_STORAGE_MAX_MB: '20' }), 20 * MB);
    assert.equal(storageMaxBytes({ PG1_STORAGE_MAX_MB: '0.5' }), MB / 2);
    for (const bad of ['0', '-3', 'big', '']) assert.equal(storageMaxBytes({ PG1_STORAGE_MAX_MB: bad }), 48 * MB, bad);
  });

  test('the README states the licence and never claims exclusive copyright', () => {
    const r = exportReadme({ title: 'X', trackId: 'id', bpm: null, key: null, provider: 'elevenlabs', model: 'music_v2_5', licenceNote: LICENCE_NOTES.elevenlabs, files: ['README.md'] });
    assert.match(r, /- Licence: commercial use per Eleven Music terms; lossless/);
    assert.match(r, /- BPM: not detected/);
    assert.match(r, /No exclusive copyright is claimed/);
  });
});

// --- 5. the whole flow ---------------------------------------------------------------------

describe('/music end to end (real Postgres, stand-in engines and worker tools)', () => {
  let db;
  let vault;
  let state;
  let fetchImpl;
  let store;
  const github = [];
  const env = {
    PG1_DAILY_SPEND_CAP_USD: '1000', PG1_VIDEO_RENDER_SECRET: SECRET, GITHUB_TOKEN: 'gh-test', GEMINI_API_KEY_PAID: PAID, GEMINI_API_KEY_FREE: FREE, REPLICATE_API_TOKEN: REPLICATE,
    SUPABASE_URL: SUP_URL, SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    // Masters and exports are large media (lib/storage/largeMedia.mjs):
    // stored in the stand-in vault here.
    PG1_LARGE_MEDIA_IN_VAULT: '1'
  };
  const cmdOnce = (text, extra = {}) => handleMusicCommand({ text, env, supUrl: SUP_URL, supKey: 'service-key', isOperator: true, requestId: 'req12345', fetchImpl, ...extra });
  // A new track waits for Confirm on its budget (lib/mediaBudget.mjs;
  // tests/spend-gaps.test.mjs checks that step). These tests confirm the
  // per-track cap (PG1_MUSIC_TRACK_CAP, 2 USD by default) and go on.
  const cmd = async (text, extra = {}) => {
    const isNew = !/^\/music\s+(?:status|list|edit|retry|export|help)\b/i.test(text) && /^\/music\s+\S/i.test(text);
    const out = await cmdOnce(isNew && !/--budget/.test(text) ? `${text} --budget ${musicCapUsd(extra.env || env)}` : text, extra);
    if (!isNew || !out.mediaBudget) return out;
    const row = (await db.query('select * from pending_actions where token = $1', [out.pendingApproval.token])).rows[0];
    await db.query('delete from pending_actions where token = $1', [row.token]); // resolved by the chat's Confirm
    return confirmMusicBudget({ plan: row.plan, env, supUrl: SUP_URL, supKey: 'service-key', requestId: 'req12345', fetchImpl, ...extra });
  };
  const approve = async (token, decision = 'approve', extra = {}) => {
    const row = (await db.query('select * from pending_actions where token = $1', [token])).rows[0];
    return handleMusicApproval({ row, decision, env, supUrl: SUP_URL, supKey: 'service-key', isOperator: true, fetchImpl, ...extra });
  };
  const runWorker = async (trackId, stage, extra = {}, { pad = {}, probe = async () => 30.5, calls = [] } = {}) => {
    const workerEnv = { ...env, MUSIC_TRACK_ID: trackId, MUSIC_STAGE: stage, MUSIC_TOKEN: signMusicToken(trackId, env), ...extra };
    return workerMain(workerEnv, { fetchImpl, log: quiet, sleep: noSleep, probe, run: fakeRun(calls, { pad }) });
  };
  const track = async (id) => (await db.query('select * from pg1_music_tracks where id = $1', [id])).rows[0];
  const assets = async (id) => (await db.query('select * from pg1_music_assets where track_id = $1 order by created_at', [id])).rows;
  const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

  beforeEach(async () => {
    db = await makeMusicDb();
    vault = new Map();
    state = {};
    github.length = 0;
    fetchImpl = routedFetch([
      ['api.github.com', (u, o, body) => { github.push({ url: u, body }); return new Response(null, { status: 204 }); }],
      ...engineRoutes(state),
      ...musicDbRoutes(db, vault)
    ]);
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: SUP_URL, SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
    globalThis.fetch = fetchImpl; // the worker's error log uses the global fetch
    store = createMusicStore({ supUrl: SUP_URL, supKey: 'service-key', fetchImpl });
  });

  test('previews -> approve a take -> final render with its licence -> export; charged and refunded against the cap', async () => {
    const out = await cmd('/music dusty boom-bap beat, vinyl crackle, jazzy piano --instrumental --bpm 88 --key Fm');
    assert.match(out.reply, /PG1 Sound is making 2 previews of "Dusty Boom-bap Beat Vinyl Crackle Jazzy" \([0-9a-f]{8}; instrumental · 88 BPM · F minor · about 30 s\), about 0\.08 USD/, 'two clips at 0.04 each');
    assert.match(out.reply, /Confirmed budget for this track: 2\.00 USD/);
    const id = out.musicTrack.id;
    let t = await track(id);
    assert.equal(t.status, 'preview_queued');
    const { spend_confirmed: confirmed, ...spec } = t.options;
    assert.deepEqual(spec, { instrumental: true, bpm: 88, key: 'F minor', length: 'short', lyrics: '' });
    assert.equal(confirmed.cap_usd, 2, 'the confirmed budget is on the track');
    assert.equal(github.length, 1);
    assert.match(github[0].url, new RegExp(`/actions/workflows/${MUSIC_WORKFLOW}/dispatches$`));
    assert.equal(github[0].body.inputs.stage, 'preview');
    assert.ok(verifyMusicToken(github[0].body.inputs.token, id, env).ok);
    assert.ok(!verifyMusicToken(github[0].body.inputs.token, '11111111-2222-4333-8444-555555555555', env).ok, 'a token is for one track');

    // The worker refuses a bad token and a stage the track is not queued for.
    assert.equal(await runWorker(id, 'preview', { MUSIC_TOKEN: 'nope' }), 2);
    assert.equal(await runWorker(id, 'final'), 0);
    assert.equal((await track(id)).status, 'preview_queued');

    // Previews: two takes on the Lyria 30-second clip model (never
    // ElevenLabs, never the free key).
    assert.equal(await runWorker(id, 'preview'), 0);
    t = await track(id);
    assert.equal(t.status, 'awaiting_choice');
    assert.equal(t.choices.length, 2);
    assert.deepEqual(state.seen.map((s) => [s.engine, s.key]), [['lyria', PAID], ['lyria', PAID]]);
    assert.ok(state.seen.every((s) => /\/lyria-3-clip-preview:generateContent$/.test(s.url)), 'previews use the clip model');
    assert.match(JSON.stringify(state.seen[0].body), /Take 1: a faithful reading/);
    assert.match(JSON.stringify(state.seen[1].body), /Take 2: a contrasting arrangement/);
    let a = await assets(id);
    assert.deepEqual(a.map((x) => [x.kind, x.variant, x.provider, x.model, x.licence_note, money(x.cost_usd)]), [['preview', 1, 'gemini_paid', 'lyria-3-clip-preview', LICENCE_NOTES.gemini_paid, '0.04'], ['preview', 2, 'gemini_paid', 'lyria-3-clip-preview', LICENCE_NOTES.gemini_paid, '0.04']]);
    assert.equal(money(t.spent_usd), '0.08', 'two clips at their own price');
    const usage = (await db.query('select provider, model, task, ok, unit, cost_usd from pg1_ai_usage order by id')).rows;
    assert.deepEqual(usage.map((r) => [r.provider, r.model, r.task, r.ok, r.unit, money(r.cost_usd)]), [['gemini_paid', 'lyria-3-clip-preview', 'music', true, 'music_lyria_clip', '0.04'], ['gemini_paid', 'lyria-3-clip-preview', 'music', true, 'music_lyria_clip', '0.04']], 'every call is a pg1_ai_usage row, at the clip price');

    // The card: a player and "use take N" per preview, PG1 Sound only.
    let card = await musicCard(store, t);
    assert.equal(card.previews.length, 2);
    assert.ok(card.previews.every((p) => /^https:\/\/supabase\.test\/storage\/v1\/object\/sign\/pg1-vault\/music\//.test(p.url) && p.token));
    assert.doesNotMatch(JSON.stringify(card), ALL_BRANDS_RE, 'no provider name on the card');
    assert.doesNotMatch(JSON.stringify(card), /licen[cs]e|watermark/i, 'the licence note is not on the card');
    const proposals = (await db.query('select * from pending_actions order by created_at')).rows;
    assert.deepEqual(proposals.map((p) => [p.action_type, p.plan.variant]), [[MUSIC_ACTIONS.final, 1], [MUSIC_ACTIONS.final, 2]]);
    assert.match(proposals[1].diff_summary, /use take 2 of "Dusty Boom-bap Beat Vinyl Crackle Jazzy".*for the final render/);
    assert.doesNotMatch(proposals.map((p) => p.diff_summary).join('\n'), ALL_BRANDS_RE);

    // Approve take 2: the final render is queued, take 1 is declined.
    const ok = await approve(t.choices.find((c) => c.variant === 2).token);
    assert.equal(ok.resolution, 'approved');
    assert.match(ok.reply, /rendering take 2 .* in full/);
    t = await track(id);
    assert.equal(t.status, 'final_queued');
    assert.equal(t.chosen_variant, 2);
    assert.equal((await db.query('select status from pending_actions where token = $1', [t.choices.find((c) => c.variant === 1).token])).rows[0].status, 'declined');
    assert.equal(github[github.length - 1].body.inputs.stage, 'final');
    const again = await approve(t.choices.find((c) => c.variant === 1).token);
    assert.equal(again.resolution, 'declined', 'the other take has moved on');

    // Final of a --length short track: the clip model again (ElevenLabs,
    // though set, is not asked).
    env.ELEVENLABS_API_KEY = ELEVEN;
    try {
      assert.equal(await runWorker(id, 'final'), 0);
    } finally { delete env.ELEVENLABS_API_KEY; }
    assert.equal(state.n.elevenlabs, 0);
    t = await track(id);
    assert.equal(t.status, 'done');
    assert.equal(t.provider, 'gemini_paid');
    assert.equal(t.model, 'lyria-3-clip-preview');
    assert.equal(t.licence_note, LICENCE_NOTES.gemini_paid);
    assert.equal(t.master_mime, 'audio/mpeg');
    assert.match(t.master_path, /\/master\/v1-master\.mp3$/);
    assert.equal(Number(t.duration_s), 30.5);
    // Reserved and charged at the clip price (0.04).
    a = await assets(id);
    const spentAssets = a.reduce((s, x) => s + Number(x.cost_usd), 0);
    assert.equal(money(t.spent_usd), money(spentAssets));
    assert.equal(money(t.spent_usd), '0.12');

    // /music status: the operator's reply carries the licence note.
    const st = await cmd(`/music status ${id.slice(0, 8)}`);
    assert.match(st.reply, /Licence \(operator only\): SynthID watermarked; commercial use under Gemini API terms; source MP3 \[gemini_paid \/ lyria-3-clip-preview\]\. No exclusive copyright is claimed\./);
    card = st.musicTrack;
    assert.match(card.masterUrl, /^https:\/\//);
    assert.match(card.masterDownloadUrl, /download=Dusty_Boom_bap_Beat_Vinyl_Crackle_Jazzy\.mp3$/);
    assert.doesNotMatch(JSON.stringify(card), ALL_BRANDS_RE);

    // Export: no engine spend; each file in the media library, and the zip.
    const ex = await cmd(`/music export ${id.slice(0, 8)}`);
    assert.match(ex.reply, /exporting .* as FLAC \(lossless\).*plus Dusty_Boom_bap_Beat_Vinyl_Crackle_Jazzy_stems\.zip when it fits the storage limit/);
    assert.equal((await track(id)).status, 'export_queued');
    assert.equal(await runWorker(id, 'export'), 0);
    t = await track(id);
    assert.equal(t.status, 'done');
    assert.match(t.stems_path, /\/export\/v1-Dusty_Boom_bap_Beat_Vinyl_Crackle_Jazzy_stems\.zip$/);
    assert.equal(Number(t.bpm), 87.96);
    assert.equal(t.musical_key, 'F minor');
    const names = readZip(vault.get(t.stems_path)).map((e) => e.name);
    assert.equal(names.length, 8);
    assert.ok(names.some((n) => /README\.md$/.test(n)));
    // One stems_zip row per file, told apart by meta.part (the applied
    // migration's kinds are not changed).
    const parts = (await assets(id)).filter((x) => x.kind === 'stems_zip' && x.status === 'ok');
    assert.deepEqual(parts.map((x) => x.meta.part), ['master', 'drums', 'bass', 'vocals', 'other', 'midi', 'midi', 'readme', 'zip']);
    assert.ok(parts.every((x) => vault.has(x.storage_path)), 'each file uploaded on its own');
    assert.equal(money(t.spent_usd), '0.12', 'the export spends nothing');
    // The card: a download per file plus "Download all (zip)".
    card = (await cmd(`/music status ${id.slice(0, 8)}`)).musicTrack;
    assert.deepEqual(card.downloads.map((d) => d.label), ['Master (FLAC)', 'Drums stem (FLAC)', 'Bass stem (FLAC)', 'Vocals stem (FLAC)', 'Other stem (FLAC)', 'MIDI: bass', 'MIDI: other', 'README']);
    assert.match(card.downloads[1].url, /download=Dusty_Boom_bap_Beat_Vinyl_Crackle_Jazzy_drums\.flac$/);
    assert.match(card.zipUrl, /download=Dusty_Boom_bap_Beat_Vinyl_Crackle_Jazzy_stems\.zip$/);
    assert.doesNotMatch(JSON.stringify(card), ALL_BRANDS_RE);
    const again2 = await cmd(`/music export ${id.slice(0, 8)}`);
    assert.match(again2.reply, /already in the media library/);
    // The library lists it with a player and the same downloads.
    const lib = await cmd('/music list');
    assert.equal(lib.musicLibrary.length, 1);
    assert.match(lib.musicLibrary[0].url, /^https:\/\//);
    assert.equal(lib.musicLibrary[0].downloads.length, 8);
    assert.match(lib.musicLibrary[0].zipUrl, /download=Dusty_Boom_bap_Beat_Vinyl_Crackle_Jazzy_stems\.zip$/);
    assert.match(lib.reply, /stems ready \(zip too\)/);
    assert.doesNotMatch(JSON.stringify(lib), ALL_BRANDS_RE);
  });

  // A finished track, ready to export.
  const finishedTrack = async () => {
    const out = await cmd('/music warm lo-fi chords --instrumental');
    const id = out.musicTrack.id;
    assert.equal(await runWorker(id, 'preview'), 0);
    assert.equal((await approve((await track(id)).choices[0].token)).resolution, 'approved');
    assert.equal(await runWorker(id, 'final'), 0);
    return id;
  };

  test('storage limit: the zip is skipped when it is over PG1_STORAGE_MAX_MB; the card lists the separate files', async () => {
    const id = await finishedTrack();
    await cmd(`/music export ${id.slice(0, 8)}`);
    // ~2 KB: every file (1.5 KB stems, the README) fits, the zip of all of them does not.
    const pad = Object.fromEntries(['master.flac', 'drums.flac', 'bass.flac', 'vocals.flac', 'other.flac'].map((f) => [f, 1500]));
    assert.equal(await runWorker(id, 'export', { PG1_STORAGE_MAX_MB: '0.002' }, { pad }), 0);
    const t = await track(id);
    assert.equal(t.status, 'done');
    assert.equal(t.stems_path, null, 'no zip');
    const parts = (await assets(id)).filter((x) => x.kind === 'stems_zip' && x.status === 'ok').map((x) => x.meta.part);
    assert.deepEqual(parts, ['master', 'drums', 'bass', 'vocals', 'other', 'midi', 'midi', 'readme']);
    assert.ok([...vault.keys()].every((k) => !k.endsWith('.zip')));
    const card = await musicCard(store, t);
    assert.equal(card.downloads.length, 8);
    assert.equal(card.zipUrl, undefined);
  });

  test('storage limit: a file over it fails the stage clearly and its charge is given back', async () => {
    const out = await cmd('/music ambient pads --instrumental');
    const id = out.musicTrack.id;
    // A few bytes: every preview is over it.
    assert.equal(await runWorker(id, 'preview', { PG1_STORAGE_MAX_MB: '0.000005' }), 1);
    let t = await track(id);
    assert.equal(t.status, 'failed');
    assert.equal(t.error_reason, 'file_too_large');
    assert.match(t.error_detail, /^file too large for storage limit: v1-take1\.mp3 is/);
    assert.deepEqual(t.failure, { stage: 'preview', kind: 'storage' });
    assert.equal(money(t.spent_usd), '0.00', 'the made take is refunded');
    assert.equal([...vault.keys()].filter((k) => k.includes(id)).length, 0, 'nothing uploaded');
    const card = await musicCard(store, t);
    assert.match(card.message, /PG1 Sound stopped at the previews: file too large for storage limit/);
    assert.doesNotMatch(card.message, ALL_BRANDS_RE);

    // The export: a stem over the limit fails it the same way.
    const id2 = await finishedTrack();
    await cmd(`/music export ${id2.slice(0, 8)}`);
    const before = money((await track(id2)).spent_usd);
    assert.equal(await runWorker(id2, 'export', { PG1_STORAGE_MAX_MB: '0.00001' }), 1);
    t = await track(id2);
    assert.equal(t.error_reason, 'file_too_large');
    assert.deepEqual(t.failure, { stage: 'export', kind: 'storage' });
    assert.equal(money(t.spent_usd), before);
    assert.equal((await assets(id2)).filter((x) => x.kind === 'stems_zip').length, 0);
  });

  test('the cap: a stage that does not fit is stopped and nothing is charged for it', async () => {
    const out = await cmd('/music ambient drones --instrumental', { env: { ...env, PG1_MUSIC_TRACK_CAP: '0.05' } });
    const id = out.musicTrack.id;
    assert.equal(await runWorker(id, 'preview'), 1);
    const t = await track(id);
    assert.equal(t.status, 'failed');
    assert.equal(t.error_reason, 'cap_reached');
    assert.equal(money(t.spent_usd), '0.04', 'take 1 fit, take 2 did not and was never sent');
    assert.equal(state.n.lyria, 1);
  });

  test('every engine out of credit: the track fails, the charges are given back, /music retry restarts it', async () => {
    const out = await cmd('/music warm 70s soul, Rhodes piano --bpm 92');
    const id = out.musicTrack.id;
    state.lyria = () => new Response(NO_CREDIT, { status: 402 });
    state.replicate = () => new Response(NO_CREDIT, { status: 402 });
    assert.equal(await runWorker(id, 'preview'), 1);
    let t = await track(id);
    assert.equal(t.status, 'failed');
    assert.equal(t.error_reason, 'out_of_credit');
    assert.deepEqual(t.failure, { stage: 'preview', kind: 'billing' });
    assert.equal(money(t.spent_usd), '0.00', 'refused calls are given back');
    const card = await musicCard(store, t);
    assert.match(card.message, /PG1 Sound stopped at the previews: the music engines are out of credit\. .*\/music retry [0-9a-f]{8}/);
    assert.doesNotMatch(card.message, ALL_BRANDS_RE);

    const guest = await cmd(`/music retry ${id.slice(0, 8)}`, { isOperator: false });
    assert.match(guest.reply, /operator only/);
    const p = await cmd(`/music retry ${id.slice(0, 8)}`);
    assert.match(p.reply, /retry .* from the previews, where it stopped/);
    state.lyria = undefined;
    state.replicate = undefined;
    __resetRouterState();
    const ok = await approve(p.pendingApproval.token);
    assert.equal(ok.resolution, 'approved');
    assert.equal((await track(id)).status, 'preview_queued');
    assert.equal(await runWorker(id, 'preview'), 0);
    t = await track(id);
    assert.equal(t.status, 'awaiting_choice');
    assert.equal(money(t.spent_usd), '0.08');
  });

  test('/music edit: checked by the safety filter, proposed, then new previews of version 2', async () => {
    const out = await cmd('/music cinematic piano theme --instrumental');
    const id = out.musicTrack.id;
    assert.equal(await runWorker(id, 'preview'), 0);
    const bad = await cmd(`/music edit ${id.slice(0, 8)} make it sound like Coldplay`);
    assert.equal(bad.reply, SAFETY_REFUSALS.artist);
    assert.ok(!bad.pendingApproval);
    const p = await cmd(`/music edit ${id.slice(0, 8)} slower, add warm strings --bpm 72 --length full`);
    assert.match(p.reply, /version 1 → 2/);
    assert.match(p.reply, /- Description: slower, add warm strings/);
    assert.match(p.reply, /- BPM: 72/);
    assert.match(p.reply, /- Length: full/);
    const before = await track(id);
    const ok = await approve(p.pendingApproval.token);
    assert.equal(ok.resolution, 'approved');
    const t = await track(id);
    assert.equal(t.version, 2);
    assert.equal(t.status, 'preview_queued');
    assert.equal(t.options.bpm, 72);
    assert.equal(t.options.length, 'full');
    assert.match(t.prompt, /^cinematic piano theme\. Changes: slower, add warm strings$/);
    // The old takes' approvals are closed.
    for (const c of before.choices) assert.equal((await db.query('select status from pending_actions where token = $1', [c.token])).rows[0].status, 'declined');
    assert.equal(await runWorker(id, 'preview'), 0);
    const a = await assets(id);
    assert.deepEqual(a.map((x) => [x.version, x.status]), [[1, 'superseded'], [1, 'superseded'], [2, 'ok'], [2, 'ok']]);
  });

  // A probe for the stand-in files: the clip-free fallback made 62.04 s; a
  // file trimmed to 30 s measures 30.
  const probeTrim = async (file) => (/-30s\.[a-z0-9]+$/.test(file) ? 30 : 62.04);

  test('the clip model fails: lyria-3.5 as before, trimmed to 30 s with ffmpeg; each call billed at its own price', async () => {
    const out = await cmd('/music late-night synthwave, gated drums --instrumental');
    const id = out.musicTrack.id;
    state.lyria = (n, body, u) => (/lyria-3-clip-preview:/.test(u) ? new Response('{"error":{"code":404,"message":"models/lyria-3-clip-preview is not found","status":"NOT_FOUND"}}', { status: 404 }) : undefined);
    const calls = [];
    assert.equal(await runWorker(id, 'preview', {}, { probe: probeTrim, calls }), 0);
    const t = await track(id);
    assert.equal(t.status, 'awaiting_choice');
    assert.deepEqual(state.seen.map((s) => s.url.split('/').pop()), ['lyria-3-clip-preview:generateContent', 'lyria-3.5:generateContent', 'lyria-3-clip-preview:generateContent', 'lyria-3.5:generateContent']);
    // ffmpeg trimmed each take to 30 s; the stored file is the trimmed one.
    const trims = calls.filter((c) => c[0] === 'ffmpeg' && c.includes('-t'));
    assert.equal(trims.length, 2);
    assert.equal(trims[0][trims[0].indexOf('-t') + 1], '30');
    assert.match(trims[0][trims[0].length - 1], /preview-1-30s\.mp3$/);
    const a = (await assets(id)).filter((x) => x.kind === 'preview');
    assert.deepEqual(a.map((x) => [x.variant, x.model, Number(x.duration_s), x.meta.trimmedFromS, money(x.cost_usd)]), [[1, 'lyria-3.5', 30, 62.04, '0.08'], [2, 'lyria-3.5', 30, 62.04, '0.08']]);
    assert.ok(a.every((x) => !vault.get(x.storage_path).toString('latin1').includes('lyria-mp3')), 'the trimmed bytes were uploaded, not the 62 s take');
    // The failed clip call was given back; lyria-3.5 billed at its own price.
    assert.equal(money(t.spent_usd), '0.16');
    const usage = (await db.query('select model, ok, unit from pg1_ai_usage order by id')).rows;
    assert.deepEqual(usage.map((r) => [r.model, r.ok, r.unit]), [
      ['lyria-3-clip-preview', false, 'music_lyria_clip'], ['lyria-3.5', true, 'music_lyria'],
      ['lyria-3-clip-preview', false, 'music_lyria_clip'], ['lyria-3.5', true, 'music_lyria']
    ]);
    // The card's header gives the measured length.
    const card = await musicCard(store, t);
    assert.match(card.spec, /about 30 s$/);
  });

  test('--length full: previews are clips, the final keeps lyria-3.5 at full length (no trim)', async () => {
    const out = await cmd('/music slow-burn cinematic ballad, piano and strings --instrumental --length full');
    const id = out.musicTrack.id;
    assert.match(out.reply, /full length\), about 0\.08 USD/);
    assert.equal(await runWorker(id, 'preview'), 0);
    assert.equal((await approve((await track(id)).choices[0].token)).resolution, 'approved');
    const calls = [];
    assert.equal(await runWorker(id, 'final', {}, { probe: async () => 151.2, calls }), 0);
    const t = await track(id);
    assert.equal(t.model, 'lyria-3.5');
    assert.equal(Number(t.duration_s), 151.2);
    assert.equal(calls.filter((c) => c[0] === 'ffmpeg').length, 0, 'a full track is never trimmed');
    assert.deepEqual(state.seen.map((s) => s.url.split('/').pop()), ['lyria-3-clip-preview:generateContent', 'lyria-3-clip-preview:generateContent', 'lyria-3.5:generateContent']);
    assert.equal(money(t.spent_usd), '0.16', 'two clips (0.04) and one full track (0.08)');
  });

  test('a declined take is discarded on the card and in the library; only the other take stays approvable', async () => {
    const out = await cmd('/music warm 70s soul, Rhodes piano --instrumental');
    const id = out.musicTrack.id;
    // Take 2's stored file measures 61.4 s.
    assert.equal(await runWorker(id, 'preview', {}, { probe: async (file) => (/preview-2/.test(file) ? 61.4 : 30.2) }), 0);
    let t = await track(id);
    const [c1, c2] = t.choices;
    let card = await musicCard(store, t);
    assert.deepEqual(card.previews.map((p) => [p.variant, p.durationS]), [[1, 30.2], [2, 61.4]], 'each take carries its stored file\'s measured length');
    assert.match(card.spec, /about 61 s$/, 'the header uses the measured length once previews exist');

    const no = await approve(c1.token, 'decline');
    assert.equal(no.resolution, 'declined');
    assert.match(no.reply, /take 1 of [0-9a-f]{8} discarded\. Approve take 2, or change it with \/music edit/);
    t = await track(id);
    assert.equal(t.status, 'awaiting_choice');
    assert.deepEqual(t.choices.map((c) => [c.variant, !!c.declined]), [[1, true], [2, false]]);
    // The card in the reply: take 1 discarded (no player, no approval), take 2 approvable.
    card = no.musicTrack;
    assert.deepEqual(card.previews[0], { variant: 1, discarded: true });
    assert.equal(card.previews[1].token, c2.token);
    assert.match(card.previews[1].url, /^https:\/\//);
    assert.match(card.spec, /about 61 s$/);
    assert.deepEqual((await musicCard(store, t)).previews, card.previews, 'the same on the next status read');
    assert.doesNotMatch(JSON.stringify(card), ALL_BRANDS_RE);
    // The library: the same takes.
    const lib = await cmd('/music list');
    assert.deepEqual(lib.musicLibrary[0].previews.map((p) => [p.variant, !!p.discarded, !!p.token]), [[1, true, false], [2, false, true]]);
    assert.match(lib.reply, /take 1 discarded, take 2/);

    // Take 2 can still be approved.
    assert.equal((await approve(c2.token)).resolution, 'approved');
    assert.equal((await track(id)).chosen_variant, 2);

    // Both declined: nothing approvable, and the card says so.
    const out2 = await cmd('/music dusty lo-fi loop --instrumental');
    const id2 = out2.musicTrack.id;
    assert.equal(await runWorker(id2, 'preview'), 0);
    const t2 = await track(id2);
    await approve(t2.choices[0].token, 'decline');
    const last = await approve(t2.choices[1].token, 'decline');
    assert.match(last.reply, /No take is left to approve; change it with \/music edit/);
    assert.ok(last.musicTrack.previews.every((p) => p.discarded && !p.token && !p.url));
    assert.match(last.musicTrack.label, /Both takes discarded/);
  });

  test('a refusal by the engine stops the stage with a refusal, and is not routed round', async () => {
    const out = await cmd('/music festival edm drop --instrumental');
    const id = out.musicTrack.id;
    state.lyria = () => json({ promptFeedback: { blockReason: 'SAFETY' } });
    assert.equal(await runWorker(id, 'preview'), 1);
    const t = await track(id);
    assert.equal(t.error_reason, 'refused');
    assert.equal(state.n.replicate, 0);
    assert.equal(money(t.spent_usd), '0.00');
  });

  test('the migration: service-role only, no check constraints added to pending_actions', async () => {
    const grants = (await db.query("select grantee, privilege_type from information_schema.role_table_grants where table_name in ('pg1_music_tracks','pg1_music_assets') and grantee in ('anon','authenticated')")).rows;
    assert.deepEqual(grants, []);
    const rls = (await db.query("select relname, relrowsecurity from pg_class where relname in ('pg1_music_tracks','pg1_music_assets') order by relname")).rows;
    assert.ok(rls.every((r) => r.relrowsecurity));
    const pa = (await db.query("select conname from pg_constraint where conrelid = 'public.pending_actions'::regclass and contype = 'c'")).rows;
    assert.deepEqual(pa, []);
  });
});
