// PG1 Sound engine calls: the AI router's music tier (lib/aiRouter.mjs
// TASKS.MUSIC), shared by /music and /film's music beds.
//
//   1. ElevenLabs Music (ELEVENLABS_API_KEY, only when set): lossless, asked
//      for as 44.1 kHz PCM and stored as WAV
//   2. Lyria on the paid Gemini key (GEMINI_API_KEY_PAID only, never the
//      free key or an old Gemini name), model PG1_MUSIC_LYRIA_MODEL
//      (default lyria-3.5): generateContent with AUDIO and TEXT out; the
//      audio comes back as MP3. Previews and short tracks go first to the
//      30-second clip model, PG1_MUSIC_LYRIA_CLIP_MODEL (default
//      lyria-3-clip-preview), on the same key (musicClipPlan), billed at
//      its own unit, music_lyria_clip
//   3. Replicate's music model (PG1_FILM_MUSIC_MODEL, the one /film has
//      always used): about 30 s, instrumental only
//
// The next engine is tried when one is out of credit (any status, the
// router's isBillingFailure), still throttled after its waits (the same
// request is sent again on the same engine first: sendWithThrottleRetry),
// down (5xx, timeout, network), or refuses the key (401/403) or the model
// (404). A content-safety refusal stops the route: another engine would
// only route round the first one's filter. lib/music/safety.mjs has
// already refused artist names, "in the voice of", song titles, pasted
// lyrics and voice cloning before any call is made here.
//
// Every call (success, failure, each throttled send) is one pg1_ai_usage
// row when a ledger is given (the render worker passes the shared one).
//
// Provider and model names stay in this file, the usage log, pg1_errors and
// the operator-only licence note: nothing here returns one to a reply.

import {
  TASKS, DATA, planRoute, routeModels, runRoute, recordUsage, mediaFailureKind, retryAfterMs, sendWithThrottleRetry, isFallbackFailure, MEDIA_UNIT_USD
} from '../aiRouter.mjs';
import { replicateToken } from '../videoJobs.mjs';
import { replicateRun, download, filmModels, filmTextKeys, EngineError, GEMINI_API, pcmToWav } from '../film/providers.mjs';

export const ELEVENLABS_MUSIC_URL = 'https://api.elevenlabs.io/v1/music';
export const ELEVENLABS_OUTPUT_FORMAT = 'pcm_44100';
export const MUSIC_SAMPLE_RATE = 44100;

// Seconds asked for by --length. Lyria and ElevenLabs make a full song at
// about this length; Replicate's model always makes about 30 s.
export const MUSIC_LENGTH_S = Object.freeze({ short: 30, full: 150 });

// What each engine's tracks may be used for, stored on every track and
// asset (operator-only: never in a reply, a card or the page source).
export const LICENCE_NOTES = Object.freeze({
  gemini_paid: 'SynthID watermarked; commercial use under Gemini API terms; source MP3',
  elevenlabs: 'commercial use per Eleven Music terms; lossless',
  replicate: 'commercial use per the Replicate model terms; source WAV'
});

// The clip model's length: it always makes about this many seconds.
export const LYRIA_CLIP_S = 30;

// The usage unit (lib/aiRouter.mjs MEDIA_UNIT_USD) for one call. `clip`:
// the call goes to the Lyria 30-second clip model.
export function musicUnit(provider, length = 'short', { clip = false } = {}) {
  if (provider === 'elevenlabs') return length === 'full' ? 'music_elevenlabs' : 'music_elevenlabs_short';
  if (provider === 'gemini_paid') return clip ? 'music_lyria_clip' : 'music_lyria';
  return 'music_replicate';
}

export function musicCallUsd(provider, length = 'short', { clip = false } = {}) {
  return MEDIA_UNIT_USD[musicUnit(provider, length, { clip })] || 0;
}

// The Lyria 30-second clip model (PG1_MUSIC_LYRIA_CLIP_MODEL).
export function lyriaClipModel(env = {}) {
  return routeModels(env, 'music', 'gemini_clip')[0] || 'lyria-3-clip-preview';
}

// The router's music plan over an env that holds only the music keys and
// PG1_* settings (budgets, models, prices): ElevenLabs, the paid Gemini key,
// Replicate. `exclude` leaves engines out (previews skip ElevenLabs; a film
// stage that switched away from Replicate leaves it out).
export function musicPlan(env = {}, { exclude = [], now = Date.now(), ledger = null } = {}) {
  const routed = {};
  for (const [name, v] of Object.entries(env)) if (/^PG1_/.test(name)) routed[name] = v;
  Object.assign(routed, {
    ELEVENLABS_API_KEY: String(env.ELEVENLABS_API_KEY || '').replace(/\s+/g, ''),
    GEMINI_API_KEY_PAID: filmTextKeys(env).geminiPaid,
    REPLICATE_API_TOKEN: replicateToken(env)
  });
  return planRoute(TASKS.MUSIC, { env: routed, dataClass: DATA.CUSTOMER, now, ledger }).filter((c) => !exclude.includes(c.provider));
}

// The clip plan: the paid Gemini key's candidates, on the clip model only.
// Empty without GEMINI_API_KEY_PAID. Its own key id, so a clip model that
// fails does not hold back the full model on the same key.
export function musicClipPlan(env = {}, { now = Date.now(), ledger = null } = {}) {
  const model = lyriaClipModel(env);
  return musicPlan(env, { now, ledger }).filter((c) => c.provider === 'gemini_paid')
    .map((c) => ({ ...c, keyId: `${c.keyId}:clip`, models: [model], clip: true }));
}

// --- the prompt ------------------------------------------------------------------------

// One text prompt for every engine, from the operator's words and flags.
// spec: { prompt, instrumental, bpm, key, length, lyrics, variant }
export function musicPrompt(spec = {}) {
  const parts = [`Original composition. ${String(spec.prompt || '').trim().slice(0, 1500)}`.trim()];
  if (spec.variant) parts.push(`Take ${spec.variant}: ${spec.variant === 1 ? 'a faithful reading of the brief' : 'a contrasting arrangement of the same brief'}.`);
  if (spec.bpm) parts.push(`Tempo: ${spec.bpm} BPM, steady.`);
  if (spec.key) parts.push(`Key: ${spec.key}.`);
  const seconds = MUSIC_LENGTH_S[spec.length] || MUSIC_LENGTH_S.short;
  parts.push(spec.length === 'full' ? `A complete song of about ${Math.round(seconds / 60 * 10) / 10} minutes with an intro, development and an ending.` : `About ${seconds} seconds long.`);
  if (spec.instrumental) parts.push('Instrumental only: no vocals, no singing, no speech.');
  else if (spec.lyrics) parts.push(`Sing these original lyrics, written for this track:\n${String(spec.lyrics).slice(0, 3000)}`);
  else parts.push('If it has vocals, write new original lyrics for it.');
  return parts.join('\n');
}

// --- shared bits -----------------------------------------------------------------------

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetchImpl(url, { ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function readBody(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, text: buf.length < 64 * 1024 ? buf.toString('utf8') : '' };
}

const GEMINI_BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);
const SAFETY_RE = /\bnsfw\b|\bsafety\b|flagged|content\s+(?:policy|filter|moderation)|copyright|recitation|\bbad[_ ]prompt\b|prompt[_ ]rejected/i;

// The throttle policy for one music request: up to 4 sends and 2 minutes of
// waiting on the same engine before the next one is tried.
export const MUSIC_THROTTLE_POLICY = Object.freeze({ baseMs: 10000, maxAttempts: 4, maxTotalWaitMs: 2 * 60 * 1000 });

// Sends `send()` (resolving to a Response) until it is not throttled.
// Resolves to { res, buf, text, throttles } for the last answer.
async function sendMusic(send, { provider, model, unit, env, ledger, sleep, now, policy }) {
  const sent = await sendWithThrottleRetry(async () => {
    const res = await send();
    const body = res.ok ? { buf: null, text: '' } : await readBody(res);
    if (!res.ok && mediaFailureKind(res.status, body.text) === 'throttled') {
      recordUsage({ provider, model, task: TASKS.MUSIC, dataClass: DATA.OPERATOR, ok: false, status: res.status, unit }, { env, ledger, log: () => {} });
      return { throttled: true, waitMs: retryAfterMs({ headers: res.headers, text: body.text, now: now() }), r: { res, ...body } };
    }
    return { res, ...body };
  }, { policy, sleep });
  return { ...(sent.outcome.r || sent.outcome), throttles: sent.throttles, exhausted: sent.exhausted };
}

function failure(provider, model, res, text, exhausted, unit) {
  const status = res ? res.status : null;
  if (exhausted) return { ok: false, status: 429, model, usage: { unit }, detail: `${provider} ${model} 429 still throttled after its waits: ${String(text).slice(0, 200)}` };
  const kind = mediaFailureKind(status, text);
  // A 400 that names copyright or a rejected prompt is the engine's own
  // content check: it stops the route like any other refusal.
  const refused = kind === 'refused' || (status === 400 && !isFallbackFailure(status, text) && SAFETY_RE.test(text));
  return { ok: false, status, model, refused, usage: { unit }, detail: `${provider} ${model} ${status}: ${String(text).slice(0, 300)}` };
}

// --- 1. ElevenLabs Music ------------------------------------------------------------------

// Raw 16-bit PCM back from ElevenLabs as WAV. The channel count is not in
// the stream, so it is read from the length asked for (stereo when the
// bytes fit two channels of that length best), unless
// PG1_MUSIC_ELEVENLABS_CHANNELS says. A body that is already a WAV is kept.
export function elevenLabsWav(buf, { seconds, env = {} } = {}) {
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return buf;
  const forced = Number(env.PG1_MUSIC_ELEVENLABS_CHANNELS);
  let channels = forced === 1 || forced === 2 ? forced : 2;
  if (!(forced === 1 || forced === 2) && seconds > 0) {
    const asStereo = buf.length / (MUSIC_SAMPLE_RATE * 4);
    const asMono = buf.length / (MUSIC_SAMPLE_RATE * 2);
    channels = Math.abs(asStereo - seconds) <= Math.abs(asMono - seconds) ? 2 : 1;
  }
  const pcm = buf.length % (2 * channels) ? buf.subarray(0, buf.length - (buf.length % (2 * channels))) : buf;
  return pcmToWav(pcm, MUSIC_SAMPLE_RATE, channels);
}

async function elevenLabsAttempt({ candidate, spec, env, fetchImpl, sleep, now, ledger, policy, timeoutMs }) {
  const model = candidate.models[0] || 'music_v2_5';
  const seconds = MUSIC_LENGTH_S[spec.length] || MUSIC_LENGTH_S.short;
  const body = JSON.stringify({ prompt: musicPrompt(spec), music_length_ms: seconds * 1000, model_id: model, ...(spec.instrumental ? { force_instrumental: true } : {}) });
  const unit = musicUnit('elevenlabs', spec.length);
  const r = await sendMusic(() => fetchWithTimeout(fetchImpl, `${ELEVENLABS_MUSIC_URL}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'xi-api-key': candidate.key }, body
  }, timeoutMs), { provider: 'elevenlabs', model, unit, env, ledger, sleep, now, policy });
  if (!r.res.ok || r.exhausted) return failure('elevenlabs', model, r.res, r.text, r.exhausted, unit);
  const buf = Buffer.from(await r.res.arrayBuffer());
  if (!buf.length) return { ok: false, status: null, model, detail: 'elevenlabs returned no audio' };
  return { ok: true, status: r.res.status, model, usage: { unit }, value: { bytes: elevenLabsWav(buf, { seconds, env }), ext: 'wav', mime: 'audio/wav', lyricsText: '' } };
}

// --- 2. Lyria on the paid Gemini key -----------------------------------------------------

// generateContent with AUDIO and TEXT out (the text part carries the
// lyrics or a description of the track). The audio is MP3 unless the
// engine says otherwise in inlineData.mimeType.
export function lyriaRequestBody(spec) {
  return { contents: [{ role: 'user', parts: [{ text: musicPrompt(spec) }] }], generationConfig: { responseModalities: ['AUDIO', 'TEXT'] } };
}

const AUDIO_EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'm4a' };

async function lyriaAttempt({ candidate, spec, env, fetchImpl, sleep, now, ledger, policy, timeoutMs }) {
  const model = candidate.models[0] || (candidate.clip ? 'lyria-3-clip-preview' : 'lyria-3.5');
  const unit = musicUnit('gemini_paid', spec.length, { clip: !!candidate.clip });
  const body = JSON.stringify(lyriaRequestBody(spec));
  const r = await sendMusic(() => fetchWithTimeout(fetchImpl, `${GEMINI_API}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': candidate.key }, body
  }, timeoutMs), { provider: 'gemini_paid', model, unit, env, ledger, sleep, now, policy });
  if (!r.res.ok || r.exhausted) return failure('gemini', model, r.res, r.text, r.exhausted, unit);
  let json = null;
  try { json = JSON.parse(Buffer.from(await r.res.arrayBuffer()).toString('utf8')); } catch (e) { json = null; }
  const cand = json && Array.isArray(json.candidates) ? json.candidates[0] : null;
  const blocked = (json && json.promptFeedback && json.promptFeedback.blockReason) || (cand && GEMINI_BLOCKED.has(cand.finishReason) ? cand.finishReason : '');
  if (blocked) return { ok: false, status: r.res.status, model, refused: true, detail: `gemini ${model} music blocked: ${blocked}` };
  const parts = (cand && cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
  const audio = parts.find((p) => p && p.inlineData && typeof p.inlineData.data === 'string' && /^audio\//i.test(String(p.inlineData.mimeType || '')));
  if (!audio) return { ok: false, status: null, model, detail: `gemini ${model} returned no audio (${(cand && cand.finishReason) || 'no candidates'})` };
  const mime = String(audio.inlineData.mimeType).toLowerCase().split(';')[0];
  const bytes = Buffer.from(audio.inlineData.data, 'base64');
  if (!bytes.length) return { ok: false, status: null, model, detail: `gemini ${model} returned an empty track` };
  const lyricsText = parts.filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('\n').slice(0, 4000);
  return { ok: true, status: r.res.status, model, usage: { unit }, value: { bytes, ext: AUDIO_EXT[mime] || 'mp3', mime: AUDIO_EXT[mime] ? mime : 'audio/mpeg', lyricsText, clip: !!candidate.clip } };
}

// --- 3. Replicate ------------------------------------------------------------------------

export function replicateMusicInput(spec) {
  return { prompt: musicPrompt({ ...spec, instrumental: true, lyrics: '' }).slice(0, 2000), negative_prompt: 'vocals, singing, speech, lyrics' };
}

async function replicateAttempt({ spec, env, fetchImpl, sleep, now, ledger, policy }) {
  const model = filmModels(env).music;
  const unit = musicUnit('replicate');
  try {
    const run = await replicateRun({ env, model, input: replicateMusicInput(spec), fetchImpl, sleep, now, throttlePolicy: policy, ledger, recordSuccess: false, unit });
    const ext = ((/\.(wav|mp3|flac|ogg|m4a)(?:\?|$)/i.exec(run.url) || [])[1] || 'wav').toLowerCase();
    const mime = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4' }[ext];
    const bytes = await download(run.url, { fetchImpl });
    return { ok: true, status: 201, model, usage: { unit }, value: { bytes, ext, mime, lyricsText: '', instrumentalOnly: !spec.instrumental } };
  } catch (e) {
    if (!(e instanceof EngineError)) return { ok: false, status: null, model, detail: `replicate ${model}: ${e && e.message}` };
    // A throttle that outlasted the waits or a credit failure moves on (as a
    // 429 or a 402); a refusal stops; a job that ran and failed moves on.
    const status = e.kind === 'throttled' ? 429 : e.kind === 'billing' ? 402 : e.kind === 'budget' ? 402 : e.status != null ? e.status : null;
    return { ok: false, status, model, refused: !!e.refused, usage: { unit }, detail: e.detail || e.message };
  }
}

const ATTEMPTS = { elevenlabs_music: elevenLabsAttempt, lyria: lyriaAttempt, replicate_music: replicateAttempt };

// --- the route -----------------------------------------------------------------------------

// One track through the music tier. Resolves to
//   { ok: true, bytes, ext, mime, provider, model, licenceNote, lyricsText,
//     instrumentalOnly, clip, costUsd, fallbacks, failures } (clip: made by
//     the 30-second clip model, billed at its own price)
// or { ok: false, refused, kind: 'billing' | 'throttled' | 'refused' |
//   'engine' | 'not_configured', failures, detail }. Never throws.
export async function generateMusic({
  env = {}, spec, exclude = [], plan = null, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(), log = console.log, ledger = null, requestId = null, policy = MUSIC_THROTTLE_POLICY, timeoutMs = 10 * 60 * 1000
}) {
  const candidates = plan || musicPlan(env, { exclude, now: now(), ledger });
  if (!candidates.length) return { ok: false, kind: 'not_configured', refused: false, failures: [], detail: 'no music engine is configured (or all are over their daily budget)' };
  const attempt = (c) => ATTEMPTS[c.family]({ candidate: c, spec, env, fetchImpl, sleep, now, ledger, policy, timeoutMs });
  const out = await runRoute({ task: TASKS.MUSIC, env, dataClass: DATA.OPERATOR, plan: candidates, attempt, ledger, requestId, log: (line) => { try { log(line); } catch (e) { /* logging never breaks a render */ } }, now });
  if (out.ok) {
    const provider = out.candidate.provider;
    return {
      ok: true, ...out.value, clip: !!out.candidate.clip, provider, model: out.model, licenceNote: LICENCE_NOTES[provider] || '', costUsd: musicCallUsd(provider, spec.length, { clip: !!out.candidate.clip }),
      fallbacks: out.failures.length, failures: out.failures
    };
  }
  const last = out.failures[out.failures.length - 1] || {};
  const first = out.failures[0] || {};
  const kindOf = (f) => (f.refused ? 'refused' : f.status === 429 ? 'throttled' : mediaFailureKind(f.status, f.detail) === 'billing' ? 'billing' : 'engine');
  return {
    ok: false, refused: !!last.refused, kind: last.refused ? 'refused' : kindOf(first), failures: out.failures,
    detail: out.failures.map((f) => `${f.provider}: ${String(f.detail || f.status).slice(0, 160)}`).join(' | ')
  };
}
