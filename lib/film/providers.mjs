// PG1 Studio engine calls, reusing the providers PG1 already has:
//   stills and the reference   Replicate (REPLICATE_API_TOKEN), the same
//                              token and API as /image's tertiary engine
//   video clips                Replicate image-to-video, the same model and
//                              input as PG1 Motion's fallback
//                              (PG1_VIDEO_MODEL_REPLICATE_IMAGE)
//   music beds                 Replicate
//   voiceover and transcript   Cartesia (CARTESIA_API_KEY), PG1's voice
//   storyboard, edits, checks  Claude (ANTHROPIC_API_KEY), as /core uses
//
// AI router (lib/aiRouter.mjs): each call is logged as one usage line
// (provider, model, task, tokens or units, estimated cost; never content)
// and refused once its provider is over PG1_DAILY_BUDGET_<PROVIDER>_USD on
// this worker. The film's own spending cap still applies first.
//
// These names live only in this file, the error log and the PR notes:
// nothing here returns a provider or model name to a reply. An engine
// failure throws an EngineError whose `detail` (the engine's own words) is
// for pg1_errors only.

import { readSseResponse } from '../chatStream.mjs';
import { replicateToken, replicateVideoModel, replicateVideoInput } from '../videoJobs.mjs';
import { TASKS, budgetAllows, recordUsage } from '../aiRouter.mjs';

function checkBudget(env, provider) {
  if (!budgetAllows(env, provider)) throw new EngineError('budget', "today's AI budget for this engine is reached", { detail: `${provider} is over its daily budget` });
}

function replicateUnit(env, model) {
  const m = filmModels(env);
  return model === m.video ? 'video_replicate' : model === m.music ? 'music_replicate' : 'still_replicate';
}

export const REPLICATE_API = 'https://api.replicate.com/v1';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const CARTESIA_TTS_SSE_URL = 'https://api.cartesia.ai/tts/sse';
export const CARTESIA_STT_URL = 'https://api.cartesia.ai/stt';
export const CARTESIA_TTS_VERSION = '2024-06-10';
export const CARTESIA_STT_VERSION = '2025-04-16';
export const DEFAULT_CARTESIA_VOICE = '3c0f09d6-e0d7-499c-a594-70c5b7b93048';

export const DEFAULT_FILM_MODELS = Object.freeze({
  still: 'black-forest-labs/flux-kontext-pro',
  music: 'google/lyria-2',
  claude: 'claude-opus-5-5',
  transcribe: 'ink-whisper'
});

const MODEL_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;

export class EngineError extends Error {
  constructor(kind, message, { status = null, detail = '', refused = false } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.detail = String(detail || message).slice(0, 500);
    this.refused = refused;
  }
}

export function filmModels(env = {}) {
  const pick = (name, fallback) => {
    const v = typeof env[name] === 'string' ? env[name].trim() : '';
    return v || fallback;
  };
  const still = pick('PG1_FILM_STILL_MODEL', DEFAULT_FILM_MODELS.still);
  const music = pick('PG1_FILM_MUSIC_MODEL', DEFAULT_FILM_MODELS.music);
  return {
    still: MODEL_RE.test(still) ? still : DEFAULT_FILM_MODELS.still,
    video: replicateVideoModel(env, { withImage: true }),
    music: MODEL_RE.test(music) ? music : DEFAULT_FILM_MODELS.music,
    claude: pick('PG1_FILM_CLAUDE_MODEL', DEFAULT_FILM_MODELS.claude),
    transcribe: pick('PG1_FILM_TRANSCRIBE_MODEL', DEFAULT_FILM_MODELS.transcribe)
  };
}

export function anthropicKey(env = {}) {
  return String(env.ANTHROPIC_API_KEY || env.ANTROPIC_API_KEY || '').replace(/\s+/g, '');
}

export function cartesiaConfig(env = {}) {
  return {
    apiKey: String(env.CARTESIA_API_KEY || '').replace(/\s+/g, ''),
    modelId: String(env.CARTESIA_MODEL_ID || '').trim() || 'sonic-3.6',
    voiceId: String(env.PG1_FILM_VOICE_ID || env.CARTESIA_VOICE_ID || '').trim() || DEFAULT_CARTESIA_VOICE
  };
}

// What the worker needs before it may spend anything; [] when ready.
export function missingFilmConfig(env = {}) {
  const out = [];
  if (!replicateToken(env)) out.push('REPLICATE_API_TOKEN');
  if (!filmModels(env).video) out.push('PG1_VIDEO_MODEL_REPLICATE_IMAGE');
  if (!anthropicKey(env)) out.push('ANTHROPIC_API_KEY');
  if (!cartesiaConfig(env).apiKey) out.push('CARTESIA_API_KEY');
  return out;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetchImpl(url, { ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function readJson(res) {
  const text = await res.text();
  try { return { json: JSON.parse(text), text }; } catch (e) { return { json: null, text }; }
}

// --- Replicate ---------------------------------------------------------------------

const REPLICATE_DONE = new Set(['succeeded']);
const REPLICATE_FAILED = new Set(['failed', 'canceled', 'aborted']);
const SAFETY_RE = /\bnsfw\b|\bsafety\b|flagged|content\s+(?:policy|filter|moderation)|sensitive/i;

export function firstOutputUrl(output) {
  if (typeof output === 'string') return /^https:\/\//i.test(output) ? output : null;
  if (Array.isArray(output)) {
    for (const o of output) { const u = firstOutputUrl(o); if (u) return u; }
    return null;
  }
  if (output && typeof output === 'object') {
    for (const k of ['video', 'audio', 'image', 'url', 'output']) { const u = firstOutputUrl(output[k]); if (u) return u; }
  }
  return null;
}

// Runs one prediction to the end. Resolves to { id, url } (the output
// link, which expires within the hour: the caller downloads it at once).
export async function replicateRun({ env, model, input, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 15 * 60 * 1000, pollMs = 4000, now = () => Date.now() }) {
  const token = replicateToken(env);
  if (!token) throw new EngineError('not_configured', 'no engine token');
  checkBudget(env, 'replicate');
  const deadline = now() + timeoutMs;
  const res = await fetchWithTimeout(fetchImpl, `${REPLICATE_API}/models/${model}/predictions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input })
  }, 30000);
  const { json, text } = await readJson(res);
  if (!res.ok || !json || !json.id) {
    throw new EngineError('engine', 'the engine did not start the job', { status: res.status, detail: `replicate ${model} ${res.status}: ${String(text).slice(0, 300)}`, refused: SAFETY_RE.test(text) });
  }
  let p = json;
  while (!REPLICATE_DONE.has(p.status)) {
    if (REPLICATE_FAILED.has(p.status)) {
      const err = String(p.error || '');
      throw new EngineError('engine', 'the engine job failed', { detail: `replicate ${model} ${p.status}: ${err.slice(0, 300)}`, refused: SAFETY_RE.test(err) });
    }
    if (now() > deadline) throw new EngineError('timeout', 'the engine job timed out', { detail: `replicate ${model} prediction ${json.id} still ${p.status}` });
    await sleep(pollMs);
    try {
      const r = await fetchWithTimeout(fetchImpl, `${REPLICATE_API}/predictions/${encodeURIComponent(json.id)}`, { headers: { Authorization: `Bearer ${token}` } }, 20000);
      if (r.status === 429 || r.status >= 500) continue;
      const b = await readJson(r);
      if (!r.ok) throw new EngineError('engine', 'the engine job could not be read', { status: r.status, detail: `replicate poll ${r.status}: ${String(b.text).slice(0, 200)}` });
      p = b.json || p;
    } catch (e) {
      if (e instanceof EngineError) throw e;
      // A network blip: ask again on the next round.
    }
  }
  const url = firstOutputUrl(p.output);
  if (!url) throw new EngineError('engine', 'the engine returned no file', { detail: `replicate ${model} succeeded without an output link` });
  recordUsage({ provider: 'replicate', model, task: TASKS.MEDIA, dataClass: 'operator', unit: replicateUnit(env, model) }, { env });
  return { id: json.id, url };
}

export async function download(url, { fetchImpl = globalThis.fetch, timeoutMs = 120000 } = {}) {
  if (!/^https:\/\//i.test(String(url))) throw new EngineError('engine', 'the engine returned no file', { detail: 'output link is not https' });
  const res = await fetchWithTimeout(fetchImpl, url, {}, timeoutMs);
  if (!res.ok) throw new EngineError('engine', 'the file could not be fetched', { status: res.status, detail: `download ${res.status}` });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new EngineError('engine', 'the engine returned an empty file', { detail: 'empty download' });
  return buf;
}

// A 16:9 still. `referenceUrl` (a signed link to the shared reference
// still) keeps characters and style the same in every shot.
export function stillInput(prompt, { referenceUrl = null, seed = null } = {}) {
  const input = { prompt: String(prompt).slice(0, 2000), aspect_ratio: '16:9', output_format: 'png', safety_tolerance: 2 };
  if (referenceUrl) input.input_image = referenceUrl;
  if (Number.isInteger(seed)) input.seed = seed;
  return input;
}

export const NEGATIVE_VIDEO_PROMPT = 'text, captions, subtitles, watermark, logo, signage, letters, distorted faces, extra limbs, warped hands, flicker';

// The image-to-video input: PG1 Motion's own (replicateVideoInput) plus a
// negative prompt for the engine that takes one.
export function clipInput(model, { prompt, startImageUrl, tier, seconds }) {
  const input = replicateVideoInput(model, { prompt, startImageUrl, tier: tier === 'draft' ? 'standard' : tier, durationS: seconds === 10 ? 10 : 5 });
  if (/kling/i.test(model)) input.negative_prompt = NEGATIVE_VIDEO_PROMPT;
  return input;
}

export function musicInput(mood, bpm) {
  return { prompt: `Instrumental film score bed, ${mood}, around ${bpm} BPM, steady tempo, no vocals, loopable, mixes under narration.`, negative_prompt: 'vocals, singing, speech, lyrics' };
}

// --- Claude ---------------------------------------------------------------------------

// One Messages API call. `content` is the user turn's content blocks (or a
// string). Resolves to { text, usage }. Uses the server-side fallback beta
// so a policy decline on one model is retried on another inside the call;
// if the account does not accept that field, the call is made once more
// without it.
export async function claudeMessage({ env, system, content, maxTokens = 16000, effort = 'medium', fetchImpl = globalThis.fetch, timeoutMs = 10 * 60 * 1000 }) {
  const key = anthropicKey(env);
  if (!key) throw new EngineError('not_configured', 'no reasoning key');
  checkBudget(env, 'anthropic');
  const model = filmModels(env).claude;
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
    output_config: { effort }
  };
  const call = async (withFallback) => {
    const headers = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    if (withFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    const res = await fetchWithTimeout(fetchImpl, ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(withFallback ? { ...body, fallbacks: 'default' } : body) }, timeoutMs);
    return { res, ...(await readJson(res)) };
  };
  let r = await call(true);
  if (r.res.status === 400 && /fallback/i.test(r.text)) r = await call(false);
  if (!r.res.ok) throw new EngineError('engine', 'the reasoning step failed', { status: r.res.status, detail: `messages ${model} ${r.res.status}: ${String(r.text).slice(0, 300)}` });
  const msg = r.json || {};
  if (msg.stop_reason === 'refusal') {
    throw new EngineError('refused', 'the request was declined', { refused: true, detail: `messages ${model} refusal: ${JSON.stringify(msg.stop_details || null).slice(0, 200)}` });
  }
  const text = (Array.isArray(msg.content) ? msg.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  const u = msg.usage || {};
  recordUsage({ provider: 'anthropic', model: msg.model || model, task: TASKS.HEAVY, dataClass: 'operator', inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0 }, { env });
  if (!text) throw new EngineError('engine', 'the reasoning step returned nothing', { detail: `messages ${model} stop=${msg.stop_reason}` });
  return { text, usage: msg.usage || null, stopReason: msg.stop_reason };
}

export function imageBlock(jpegBuffer, mediaType = 'image/jpeg') {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: Buffer.from(jpegBuffer).toString('base64') } };
}

// --- Cartesia: voiceover with word timestamps ----------------------------------------

export const TTS_SAMPLE_RATE = 44100;

// One voiceover line. Resolves to { pcm (s16le mono Buffer), sampleRate,
// durationS, words: [{ word, start, end }] } with times in seconds from
// the start of the line.
export async function synthesizeLine({ env, text, fetchImpl = globalThis.fetch, timeoutMs = 60000 }) {
  const { apiKey, modelId, voiceId } = cartesiaConfig(env);
  if (!apiKey) throw new EngineError('not_configured', 'no voice key');
  checkBudget(env, 'cartesia');
  const res = await fetchWithTimeout(fetchImpl, CARTESIA_TTS_SSE_URL, {
    method: 'POST',
    headers: { 'Cartesia-Version': CARTESIA_TTS_VERSION, 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: modelId,
      transcript: String(text).slice(0, 1000),
      voice: { mode: 'id', id: voiceId },
      language: 'en',
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: TTS_SAMPLE_RATE },
      add_timestamps: true
    })
  }, timeoutMs);
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch (e) { body = ''; }
    throw new EngineError('engine', 'the voiceover could not be recorded', { status: res.status, detail: `tts ${res.status}: ${body}` });
  }
  const chunks = [];
  const words = [];
  let error = '';
  await readSseResponse(res, (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'error' || msg.error) { error = String(evt.data).slice(0, 200); return; }
    if (msg.type === 'chunk' && typeof msg.data === 'string') chunks.push(Buffer.from(msg.data, 'base64'));
    const wt = msg.word_timestamps;
    if (msg.type === 'timestamps' && wt && Array.isArray(wt.words)) {
      wt.words.forEach((w, i) => words.push({ word: String(w), start: Number(wt.start[i]) || 0, end: Number(wt.end[i]) || 0 }));
    }
  });
  if (error) throw new EngineError('engine', 'the voiceover could not be recorded', { detail: `tts stream error: ${error}` });
  const pcm = Buffer.concat(chunks);
  if (!pcm.length) throw new EngineError('engine', 'the voiceover came back empty', { detail: 'tts returned no audio' });
  recordUsage({ provider: 'cartesia', model: modelId, task: TASKS.TTS, dataClass: 'operator', chars: String(text).slice(0, 1000).length }, { env });
  return { pcm, sampleRate: TTS_SAMPLE_RATE, durationS: pcm.length / 2 / TTS_SAMPLE_RATE, words };
}

// 16-bit PCM to a WAV file.
export function pcmToWav(pcm, sampleRate = TTS_SAMPLE_RATE, channels = 1) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// --- Cartesia: transcript of the final mix -------------------------------------------

// Resolves to { text, words: [{ word, start, end }] } (words may be empty
// when the engine returns text only).
export async function transcribe({ env, audio, mimeType = 'audio/wav', fetchImpl = globalThis.fetch, timeoutMs = 5 * 60 * 1000 }) {
  const { apiKey } = cartesiaConfig(env);
  if (!apiKey) throw new EngineError('not_configured', 'no voice key');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType }), 'mix.wav');
  form.append('model', filmModels(env).transcribe);
  form.append('language', 'en');
  form.append('timestamp_granularities[]', 'word');
  const res = await fetchWithTimeout(fetchImpl, CARTESIA_STT_URL, {
    method: 'POST',
    headers: { 'Cartesia-Version': CARTESIA_STT_VERSION, 'X-API-Key': apiKey },
    body: form
  }, timeoutMs);
  const { json, text } = await readJson(res);
  if (!res.ok || !json) throw new EngineError('engine', 'the audio check could not run', { status: res.status, detail: `stt ${res.status}: ${String(text).slice(0, 200)}` });
  const words = (Array.isArray(json.words) ? json.words : [])
    .map((w) => ({ word: String(w.word || w.text || ''), start: Number(w.start) || 0, end: Number(w.end) || 0 }))
    .filter((w) => w.word);
  return { text: String(json.text || words.map((w) => w.word).join(' ')), words };
}
