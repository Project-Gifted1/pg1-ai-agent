/**
 * PG1 Sound (/music: lib/music/*, scripts/music-render.mjs, api/chat.mjs):
 *
 *  - the AI router's music tier: ElevenLabs (only with its key) -> Lyria on
 *    the paid Gemini key -> Replicate; out of credit, still throttled after
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
import {
  generateMusic, musicPlan, musicPrompt, elevenLabsWav, lyriaRequestBody, LICENCE_NOTES, ELEVENLABS_MUSIC_URL, MUSIC_SAMPLE_RATE
} from '../lib/music/engines.mjs';
import { checkMusicRequest, lyricFingerprints, SAFETY_REFUSALS, REFUSAL_ALTERNATIVE } from '../lib/music/safety.mjs';
import { buildZip, readZip, runExport, exportReadme, STEMS } from '../lib/music/export.mjs';
import { parseMusicCommand, parseMusicFlags, normaliseKey, musicCapUsd, MUSIC_ACTIONS, isMusicCommand } from '../lib/music/text.mjs';
import { createMusicStore } from '../lib/music/store.mjs';
import { signMusicToken, verifyMusicToken, MUSIC_WORKFLOW } from '../lib/music/dispatch.mjs';
import { handleMusicCommand, handleMusicApproval, musicCard } from '../lib/music/chat.mjs';
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
  test('order: ElevenLabs (only with its key) -> Lyria on the paid Gemini key -> Replicate; never the free key', () => {
    const full = { ELEVENLABS_API_KEY: ELEVEN, GEMINI_API_KEY_PAID: PAID, GEMINI_API_KEY_FREE: FREE, REPLICATE_API_TOKEN: REPLICATE };
    const plan = planRoute(TASKS.MUSIC, { env: full, dataClass: DATA.OPERATOR });
    assert.deepEqual(plan.map((c) => c.provider), ['elevenlabs', 'gemini_paid', 'replicate']);
    assert.deepEqual(plan.map((c) => c.family), ['elevenlabs_music', 'lyria', 'replicate_music']);
    assert.equal(plan[1].key, PAID);
    assert.deepEqual(plan[1].models, ['lyria-3.5']);
    assert.ok(plan.every((c) => c.key !== FREE), 'the free Gemini key is never in the music plan, even for the operator');
    assert.equal(resolveKeys(full).elevenlabs, ELEVEN);
    assert.equal(ENGINE_LABELS.elevenlabs, 'PG1 music engine');

    assert.deepEqual(planRoute(TASKS.MUSIC, { env: { ...full, ELEVENLABS_API_KEY: '' } }).map((c) => c.provider), ['gemini_paid', 'replicate'], 'no ElevenLabs without its key');
    assert.deepEqual(musicPlan({ GEMINI_API_KEY_PAID: FREE, GEMINI_API_KEY_FREE: FREE, REPLICATE_API_TOKEN: REPLICATE }).map((c) => c.provider), ['replicate'], 'a paid key that holds the free key is not used');
    assert.deepEqual(musicPlan({ GEMINI_API_KEY: PAID, REPLICATE_API_TOKEN: REPLICATE }).map((c) => c.provider), ['replicate'], 'old Gemini names are never used for music');
    assert.deepEqual(musicPlan({ ...full, PG1_MUSIC_LYRIA_MODEL: 'lyria-3.6' })[1].models, ['lyria-3.6']);
    assert.deepEqual(musicPlan(full, { exclude: ['elevenlabs'] }).map((c) => c.provider), ['gemini_paid', 'replicate'], 'previews leave ElevenLabs out');
    assert.deepEqual(musicPlan({ ...full, PG1_DAILY_BUDGET_ELEVENLABS_USD: '0' }).map((c) => c.provider), ['gemini_paid', 'replicate'], 'over its daily budget');
  });

  test('ElevenLabs out of credit -> Lyria makes it; every call is a usage row', async () => {
    const state = { elevenlabs: () => new Response('{"detail":{"status":"quota_exceeded","message":"You have insufficient credits for this request"}}', { status: 401 }) };
    const ledger = memLedger();
    const env = { ELEVENLABS_API_KEY: ELEVEN, GEMINI_API_KEY_PAID: PAID, REPLICATE_API_TOKEN: REPLICATE };
    const out = await generateMusic({ env, spec: spec({ length: 'full' }), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet, ledger });
    assert.equal(out.ok, true);
    assert.equal(out.provider, 'gemini_paid');
    assert.equal(out.model, 'lyria-3.5');
    assert.equal(out.mime, 'audio/mpeg');
    assert.equal(out.ext, 'mp3');
    assert.equal(out.bytes.toString(), 'lyria-mp3-1');
    assert.equal(out.licenceNote, LICENCE_NOTES.gemini_paid);
    assert.match(out.licenceNote, /SynthID watermarked; commercial use under Gemini API terms; source MP3/);
    assert.equal(out.lyricsText, '[Verse] original words');
    assert.deepEqual(state.seen.map((s) => s.engine), ['elevenlabs', 'lyria']);
    // ElevenLabs was asked for lossless PCM; Lyria for audio and text.
    assert.match(state.seen[0].url, /\?output_format=pcm_44100$/);
    assert.equal(state.seen[0].key, ELEVEN);
    assert.equal(state.seen[0].body.force_instrumental, true);
    assert.equal(state.seen[0].body.music_length_ms, 150000);
    assert.deepEqual(state.seen[1].body.generationConfig, { responseModalities: ['AUDIO', 'TEXT'] });
    assert.equal(state.seen[1].key, PAID);
    assert.match(state.seen[1].url, /\/lyria-3\.5:generateContent$/);
    // Usage: the failed call and the track, task music, never content.
    assert.deepEqual(ledger.rows.map((r) => [r.provider, r.task, r.ok, r.unit]), [['elevenlabs', 'music', false, 'music_elevenlabs'], ['gemini_paid', 'music', true, 'music_lyria']]);
    assert.equal(ledger.rows[1].cost_usd, 0.08);
    assert.ok(!JSON.stringify(ledger.rows).includes('boom-bap'), 'no prompt in the usage rows');
    assert.ok(isTripped('elevenlabs'), 'the drained key waits out the breaker');
  });

  test('throttled: the same request is sent again; still throttled after the waits -> the next engine', async () => {
    const throttle = () => new Response('{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota). Please retry in 5s.","status":"RESOURCE_EXHAUSTED"}}', { status: 429, headers: { 'retry-after': '5' } });
    // Lyria throttled twice, then answers: no fallback.
    let state = { lyria: (n) => (n <= 2 ? throttle() : undefined) };
    const waits = [];
    const ledger = memLedger();
    let out = await generateMusic({ env: { GEMINI_API_KEY_PAID: PAID, REPLICATE_API_TOKEN: REPLICATE }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: async (ms) => { waits.push(ms); }, log: quiet, ledger });
    assert.equal(out.provider, 'gemini_paid');
    assert.equal(state.n.lyria, 3);
    assert.equal(state.n.replicate, 0);
    assert.deepEqual(waits, [5000, 5000], 'waits as the engine says');
    assert.equal(ledger.rows.filter((r) => r.status === 429).length, 2, 'each throttled send is logged');
    // Throttled to the end: Replicate makes it.
    __resetRouterState();
    state = { lyria: () => throttle() };
    out = await generateMusic({ env: { GEMINI_API_KEY_PAID: PAID, REPLICATE_API_TOKEN: REPLICATE }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(out.ok, true);
    assert.equal(out.provider, 'replicate');
    assert.equal(out.fallbacks, 1);
    assert.equal(state.n.lyria, 4, 'MUSIC_THROTTLE_POLICY: four sends');
    assert.equal(out.licenceNote, LICENCE_NOTES.replicate);
    assert.match(JSON.stringify(state.seen.find((s) => s.engine === 'replicate').body.input), /Instrumental only/);
  });

  test('Lyria out of credit -> Replicate; everything out of credit -> a clear billing failure', async () => {
    let state = { lyria: () => new Response('{"error":{"code":429,"message":"Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.","status":"RESOURCE_EXHAUSTED"}}', { status: 429 }) };
    let out = await generateMusic({ env: { GEMINI_API_KEY_PAID: PAID, REPLICATE_API_TOKEN: REPLICATE }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(out.provider, 'replicate');
    assert.equal(state.n.lyria, 1, 'a credit failure is not retried');
    __resetRouterState();
    state = { lyria: () => new Response(NO_CREDIT, { status: 402 }), replicate: () => new Response(NO_CREDIT, { status: 402 }) };
    out = await generateMusic({ env: { GEMINI_API_KEY_PAID: PAID, REPLICATE_API_TOKEN: REPLICATE }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(out.ok, false);
    assert.equal(out.kind, 'billing');
    assert.equal(out.refused, false);
    assert.deepEqual(out.failures.map((f) => f.provider), ['gemini_paid', 'replicate']);
  });

  test('a 5xx or a bad key moves on; a content refusal stops the route', async () => {
    let state = { elevenlabs: () => new Response('upstream error', { status: 503 }) };
    let out = await generateMusic({ env: { ELEVENLABS_API_KEY: ELEVEN, GEMINI_API_KEY_PAID: PAID }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(out.provider, 'gemini_paid');
    __resetRouterState();
    state = { lyria: () => json({ promptFeedback: { blockReason: 'SAFETY' } }) };
    out = await generateMusic({ env: { GEMINI_API_KEY_PAID: PAID, REPLICATE_API_TOKEN: REPLICATE }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(out.ok, false);
    assert.equal(out.refused, true);
    assert.equal(out.kind, 'refused');
    assert.equal(state.n.replicate, 0, 'a refusal is never routed round');
    __resetRouterState();
    state = { lyria: () => json({ candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }] }) };
    out = await generateMusic({ env: { GEMINI_API_KEY_PAID: PAID, REPLICATE_API_TOKEN: REPLICATE }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(out.kind, 'refused');
    __resetRouterState();
    state = { elevenlabs: () => new Response('{"detail":{"status":"bad_prompt","message":"The prompt contains copyrighted material"}}', { status: 400 }) };
    out = await generateMusic({ env: { ELEVENLABS_API_KEY: ELEVEN, GEMINI_API_KEY_PAID: PAID }, spec: spec(), fetchImpl: routedFetch(engineRoutes(state)), sleep: noSleep, log: quiet });
    assert.equal(out.kind, 'refused');
    assert.equal(state.n.lyria, 0);
    out = await generateMusic({ env: {}, spec: spec(), fetchImpl: routedFetch([]), log: quiet });
    assert.equal(out.kind, 'not_configured');
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

// --- 4. the export zip ---------------------------------------------------------------------

// A command runner standing in for ffmpeg and scripts/music_stems.py.
function fakeRun(calls) {
  return async (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'ffmpeg') { await writeFile(args[args.length - 1], Buffer.concat([WAV, Buffer.from('master')])); return { stdout: '', stderr: '' }; }
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

describe('export zip', () => {
  test('zip round trip: stored audio, deflated text, CRCs checked, readable by another zip reader', async () => {
    const zip = buildZip([{ name: 'a/README.txt', data: 'hello '.repeat(100) }, { name: 'a/x.wav', data: WAV }, { name: 'a/m.mid', data: Buffer.from([1, 2, 3]) }]);
    const back = readZip(zip);
    assert.deepEqual(back.map((e) => e.name), ['a/README.txt', 'a/x.wav', 'a/m.mid']);
    assert.equal(back[0].data.toString(), 'hello '.repeat(100));
    assert.deepEqual(back[1].data, WAV);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'music-zip-'));
    const file = path.join(dir, 't.zip');
    await writeFile(file, zip);
    let other = null;
    try { other = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip() or "ok"); print(",".join(z.namelist()))', file], { encoding: 'utf8' }); } catch (e) { other = null; }
    if (other !== null) assert.equal(other.trim(), 'ok\na/README.txt,a/x.wav,a/m.mid');
  });

  test('<title>_stems.zip: master WAV, four stems, MIDI per melodic stem, README with BPM, key, provider and licence', async () => {
    const vault = new Map([['music/t1/master/v1-master.mp3', Buffer.from('mp3')]]);
    const uploads = [];
    const store = {
      download: async (p) => vault.get(p),
      upload: async (p, bytes, mime) => { uploads.push({ p, bytes, mime }); return p; }
    };
    const calls = [];
    const track = {
      id: '11111111-2222-4333-8444-555555555555', title: 'Dusty Boom Bap Beat', version: 1, master_path: 'music/t1/master/v1-master.mp3',
      provider: 'gemini_paid', model: 'lyria-3.5', licence_note: LICENCE_NOTES.gemini_paid, duration_s: 31.2, options: { instrumental: true, bpm: 88, key: 'F minor' }
    };
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'music-export-'));
    const r = await runExport({ track, store, workdir, run: fakeRun(calls), now: new Date('2026-10-13T12:00:00Z') });
    assert.equal(r.name, 'Dusty_Boom_Bap_Beat_stems.zip');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].mime, 'application/zip');
    assert.match(uploads[0].p, /^music\/11111111-2222-4333-8444-555555555555\/export\/v1-Dusty_Boom_Bap_Beat_stems\.zip$/);
    const entries = readZip(uploads[0].bytes);
    const names = entries.map((e) => e.name);
    assert.deepEqual(names, [
      'Dusty_Boom_Bap_Beat_stems/README.txt',
      'Dusty_Boom_Bap_Beat_stems/Dusty_Boom_Bap_Beat_master.wav',
      'Dusty_Boom_Bap_Beat_stems/stems/Dusty_Boom_Bap_Beat_drums.wav',
      'Dusty_Boom_Bap_Beat_stems/stems/Dusty_Boom_Bap_Beat_bass.wav',
      'Dusty_Boom_Bap_Beat_stems/stems/Dusty_Boom_Bap_Beat_vocals.wav',
      'Dusty_Boom_Bap_Beat_stems/stems/Dusty_Boom_Bap_Beat_other.wav',
      'Dusty_Boom_Bap_Beat_stems/midi/Dusty_Boom_Bap_Beat_bass.mid',
      'Dusty_Boom_Bap_Beat_stems/midi/Dusty_Boom_Bap_Beat_other.mid'
    ], 'no vocals MIDI for an instrumental');
    for (const e of entries.filter((x) => x.name.endsWith('.wav'))) assert.equal(e.data.toString('ascii', 0, 4), 'RIFF', e.name);
    assert.equal(entries.find((e) => e.name.endsWith('_drums.wav')).data.toString().slice(-5), 'drums');
    const readme = entries[0].data.toString();
    assert.match(readme, /BPM: {8}87\.96 \(detected; asked for 88\)/);
    assert.match(readme, /Key: {8}F minor \(detected; asked for F minor\)/);
    assert.match(readme, /Provider: gemini_paid/);
    assert.match(readme, /Model: {4}lyria-3\.5/);
    assert.match(readme, /Licence: {2}SynthID watermarked; commercial use under Gemini API terms; source MP3/);
    assert.match(readme, /No exclusive copyright is claimed\s+or granted/);
    assert.doesNotMatch(readme, /(?<!no )exclusive copyright (?:is )?(?:owned|held|belongs)/i);
    assert.match(readme, /midi\/Dusty_Boom_Bap_Beat_bass\.mid/);
    // ffmpeg made a 44.1 kHz stereo 16-bit WAV; the stems script ran on it.
    assert.deepEqual(calls[0].slice(-8), ['-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', path.join(workdir, 'Dusty_Boom_Bap_Beat_master.wav')]);
    assert.equal(calls[1][1], 'scripts/music_stems.py');
    assert.ok(calls[1].includes('--no-vocals-midi'));
    assert.equal(r.bpm, 87.96);
    assert.equal(r.key, 'F minor');
  });

  test('the README states the licence and never claims exclusive copyright', () => {
    const r = exportReadme({ title: 'X', trackId: 'id', bpm: null, key: null, provider: 'elevenlabs', model: 'music_v1', licenceNote: LICENCE_NOTES.elevenlabs, files: ['README.txt'] });
    assert.match(r, /Licence: {2}commercial use per Eleven Music terms; lossless/);
    assert.match(r, /BPM: {8}not detected/);
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
    PG1_VIDEO_RENDER_SECRET: SECRET, GITHUB_TOKEN: 'gh-test', GEMINI_API_KEY_PAID: PAID, GEMINI_API_KEY_FREE: FREE, REPLICATE_API_TOKEN: REPLICATE,
    SUPABASE_URL: SUP_URL, SUPABASE_SERVICE_ROLE_KEY: 'service-key'
  };
  const cmd = (text, extra = {}) => handleMusicCommand({ text, env, supUrl: SUP_URL, supKey: 'service-key', isOperator: true, requestId: 'req12345', fetchImpl, ...extra });
  const approve = async (token, decision = 'approve', extra = {}) => {
    const row = (await db.query('select * from pending_actions where token = $1', [token])).rows[0];
    return handleMusicApproval({ row, decision, env, supUrl: SUP_URL, supKey: 'service-key', isOperator: true, fetchImpl, ...extra });
  };
  const runWorker = async (trackId, stage, extra = {}) => {
    const workerEnv = { ...env, MUSIC_TRACK_ID: trackId, MUSIC_STAGE: stage, MUSIC_TOKEN: signMusicToken(trackId, env), ...extra };
    return workerMain(workerEnv, { fetchImpl, log: quiet, sleep: noSleep, probe: async () => 30.5, run: fakeRun([]) });
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
    assert.match(out.reply, /PG1 Sound is making 2 previews of "Dusty Boom-bap Beat Vinyl Crackle Jazzy" \([0-9a-f]{8}; instrumental · 88 BPM · F minor · about 30 s\), about 0\.16 USD/);
    assert.match(out.reply, /Spending cap for this track: 2\.00 USD/);
    const id = out.musicTrack.id;
    let t = await track(id);
    assert.equal(t.status, 'preview_queued');
    assert.deepEqual(t.options, { instrumental: true, bpm: 88, key: 'F minor', length: 'short', lyrics: '' });
    assert.equal(github.length, 1);
    assert.match(github[0].url, new RegExp(`/actions/workflows/${MUSIC_WORKFLOW}/dispatches$`));
    assert.equal(github[0].body.inputs.stage, 'preview');
    assert.ok(verifyMusicToken(github[0].body.inputs.token, id, env).ok);
    assert.ok(!verifyMusicToken(github[0].body.inputs.token, '11111111-2222-4333-8444-555555555555', env).ok, 'a token is for one track');

    // The worker refuses a bad token and a stage the track is not queued for.
    assert.equal(await runWorker(id, 'preview', { MUSIC_TOKEN: 'nope' }), 2);
    assert.equal(await runWorker(id, 'final'), 0);
    assert.equal((await track(id)).status, 'preview_queued');

    // Previews: two Lyria takes (never ElevenLabs, never the free key).
    assert.equal(await runWorker(id, 'preview'), 0);
    t = await track(id);
    assert.equal(t.status, 'awaiting_choice');
    assert.equal(t.choices.length, 2);
    assert.deepEqual(state.seen.map((s) => [s.engine, s.key]), [['lyria', PAID], ['lyria', PAID]]);
    assert.match(JSON.stringify(state.seen[0].body), /Take 1: a faithful reading/);
    assert.match(JSON.stringify(state.seen[1].body), /Take 2: a contrasting arrangement/);
    let a = await assets(id);
    assert.deepEqual(a.map((x) => [x.kind, x.variant, x.provider, x.licence_note]), [['preview', 1, 'gemini_paid', LICENCE_NOTES.gemini_paid], ['preview', 2, 'gemini_paid', LICENCE_NOTES.gemini_paid]]);
    assert.equal(money(t.spent_usd), '0.16', 'two Lyria takes');
    const usage = (await db.query('select provider, task, ok, unit from pg1_ai_usage order by id')).rows;
    assert.deepEqual(usage.map((r) => [r.provider, r.task, r.ok, r.unit]), [['gemini_paid', 'music', true, 'music_lyria'], ['gemini_paid', 'music', true, 'music_lyria']], 'every call is a pg1_ai_usage row');

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

    // Final: ElevenLabs is out of credit, Lyria makes the full track.
    env.ELEVENLABS_API_KEY = ELEVEN;
    state.elevenlabs = () => new Response('{"detail":{"status":"quota_exceeded","message":"insufficient credits"}}', { status: 402 });
    try {
      assert.equal(await runWorker(id, 'final'), 0);
    } finally { delete env.ELEVENLABS_API_KEY; }
    t = await track(id);
    assert.equal(t.status, 'done');
    assert.equal(t.provider, 'gemini_paid');
    assert.equal(t.model, 'lyria-3.5');
    assert.equal(t.licence_note, LICENCE_NOTES.gemini_paid);
    assert.equal(t.master_mime, 'audio/mpeg');
    assert.match(t.master_path, /\/master\/v1-master\.mp3$/);
    assert.equal(Number(t.duration_s), 30.5);
    // Reserved the dearest engine (ElevenLabs, a short track: 0.20), got
    // back the difference to Lyria, which made it (0.08).
    a = await assets(id);
    const spentAssets = a.reduce((s, x) => s + Number(x.cost_usd), 0);
    assert.equal(money(t.spent_usd), money(spentAssets));
    assert.equal(money(t.spent_usd), '0.24');

    // /music status: the operator's reply carries the licence note.
    const st = await cmd(`/music status ${id.slice(0, 8)}`);
    assert.match(st.reply, /Licence \(operator only\): SynthID watermarked; commercial use under Gemini API terms; source MP3 \[gemini_paid \/ lyria-3\.5\]\. No exclusive copyright is claimed\./);
    card = st.musicTrack;
    assert.match(card.masterUrl, /^https:\/\//);
    assert.match(card.masterDownloadUrl, /download=Dusty_Boom_bap_Beat_Vinyl_Crackle_Jazzy\.mp3$/);
    assert.doesNotMatch(JSON.stringify(card), ALL_BRANDS_RE);

    // Export: no engine spend, the zip in the media library.
    const ex = await cmd(`/music export ${id.slice(0, 8)}`);
    assert.match(ex.reply, /exporting .* as Dusty_Boom_bap_Beat_Vinyl_Crackle_Jazzy_stems\.zip/);
    assert.equal((await track(id)).status, 'export_queued');
    assert.equal(await runWorker(id, 'export'), 0);
    t = await track(id);
    assert.equal(t.status, 'done');
    assert.match(t.stems_path, /\/export\/v1-Dusty_Boom_bap_Beat_Vinyl_Crackle_Jazzy_stems\.zip$/);
    assert.equal(Number(t.bpm), 87.96);
    assert.equal(t.musical_key, 'F minor');
    const names = readZip(vault.get(t.stems_path)).map((e) => e.name);
    assert.equal(names.length, 8);
    assert.ok(names.some((n) => /README\.txt$/.test(n)));
    assert.equal(money(t.spent_usd), '0.24', 'the export spends nothing');
    // The library lists it with a player and the stems.
    const lib = await cmd('/music list');
    assert.equal(lib.musicLibrary.length, 1);
    assert.match(lib.musicLibrary[0].url, /^https:\/\//);
    assert.match(lib.musicLibrary[0].stemsUrl, /download=Dusty_Boom_bap_Beat_Vinyl_Crackle_Jazzy_stems\.zip$/);
    assert.match(lib.reply, /stems ready/);
    assert.doesNotMatch(JSON.stringify(lib), ALL_BRANDS_RE);
  });

  test('the cap: a stage that does not fit is stopped and nothing is charged for it', async () => {
    const out = await cmd('/music ambient drones --instrumental', { env: { ...env, PG1_MUSIC_TRACK_CAP: '0.10' } });
    const id = out.musicTrack.id;
    assert.equal(await runWorker(id, 'preview'), 1);
    const t = await track(id);
    assert.equal(t.status, 'failed');
    assert.equal(t.error_reason, 'cap_reached');
    assert.equal(money(t.spent_usd), '0.08', 'take 1 fit, take 2 did not and was never sent');
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
    assert.equal(money(t.spent_usd), '0.16');
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
