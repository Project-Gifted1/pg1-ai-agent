// PG1 Studio engine calls, reusing the providers PG1 already has:
//   stills and the reference   Replicate (REPLICATE_API_TOKEN), the same
//                              token and API as /image's tertiary engine
//   video clips                Replicate image-to-video, the same model and
//                              input as PG1 Motion's fallback
//                              (PG1_VIDEO_MODEL_REPLICATE_IMAGE)
//   music beds                 the router's music tier (lib/music/engines.mjs),
//                              Lyria on the paid Gemini key only
//                              (filmMusicExclude); ElevenLabs only with
//                              PG1_ELEVENLABS_FILM_RIGHTS=1, never Replicate
//   voiceover and transcript   Cartesia (CARTESIA_API_KEY), PG1's voice; a
//                              voiceover line that times out or fails is
//                              sent once more, then goes to ElevenLabs TTS
//                              (ELEVENLABS_API_KEY) for the rest of the
//                              stage (createFilmVoice)
//   storyboard, edits, checks  the AI router's heavy route on paid providers
//                              only (filmThink): Claude (ANTHROPIC_API_KEY),
//                              then the paid Gemini key (GEMINI_API_KEY_PAID),
//                              then OpenRouter (OPENROUTER_API_KEY)
//
// AI router (lib/aiRouter.mjs): each call is logged as one usage line
// (provider, model, task, tokens or units, estimated cost; never content)
// and refused once its provider is over PG1_DAILY_BUDGET_<PROVIDER>_USD on
// this worker. The film's own spending cap still applies first. A text
// engine that is out of credit, rate limited or down hands the call to the
// next one (isFallbackFailure); a refusal never does.
//
// Film content goes to paid providers only: the free Gemini key
// (GEMINI_API_KEY_FREE) and the old Gemini names are never used here, and
// the render worker is never given them (.github/workflows/film-render.yml).
//
// These names live only in this file, the error log and the PR notes:
// nothing here returns a provider or model name to a reply. An engine
// failure throws an EngineError whose `detail` (the engine's own words) is
// for pg1_errors only.

import { readSseResponse } from '../chatStream.mjs';
import { replicateToken, replicateVideoModel, replicateVideoInput, buildVideoRequestBody, videoFromInteraction, videoModel, videoDelivery, googleVideoFetch, engineErrorText, INTERACTIONS_URL } from '../videoJobs.mjs';
import { imageModels } from '../imageEngines.mjs';
import { providerErrorText } from '../upstreamFailure.mjs';
import {
  TASKS, DATA, budgetAllows, recordUsage, planRoute, runRoute, isFallbackFailure, isBillingFailure, estimateTokens,
  mediaFailureKind, retryAfterMs, sendWithThrottleRetry, THROTTLE_POLICY, failureClass, FAILURE
} from '../aiRouter.mjs';
import { chainPlan, emptyPlanReason } from '../router/chains.mjs';
import { clipCostOnUsd } from './cost.mjs';
import { engineCostUsd } from '../capabilities/registry.mjs';

function checkBudget(env, provider) {
  if (!budgetAllows(env, provider)) throw new EngineError('budget', "today's AI budget for this engine is reached", { notStarted: true, engine: provider, detail: `${provider} is over its daily budget` });
}

function replicateUnit(env, model) {
  const m = filmModels(env);
  return model === m.video ? 'video_replicate' : model === m.music ? 'music_replicate' : 'still_replicate';
}

export const REPLICATE_API = 'https://api.replicate.com/v1';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
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

// kind: 'throttled' (still rate limited after the waits) and 'billing'
// (out of credit) are media failures that stop a stage (see
// createFilmMedia); 'engine', 'timeout', 'budget', 'not_configured' and
// 'refused' as before. notStarted: the engine never accepted the call
// (nothing ran, nothing was billed), so the film's charge for it is given
// back. engine: the ledger name of the engine that failed; fallback: what
// happened when the stage tried the next one ({ engine, outcome:
// 'not_configured' | 'unavailable' | 'failed' }).
export class EngineError extends Error {
  constructor(kind, message, { status = null, detail = '', refused = false, notStarted = false, engine = null, fallback = null, exhausted = false, licence = false } = {}) {
    super(message);
    this.exhausted = exhausted;
    this.licence = licence;
    this.kind = kind;
    this.status = status;
    this.detail = String(detail || message).slice(0, 500);
    this.refused = refused;
    this.notStarted = notStarted;
    this.engine = engine;
    this.fallback = fallback;
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

// The music engines a film bed may not use. ElevenLabs' self-serve music
// licence excludes film, TV, radio and large studio games (Music Terms,
// Exhibit A), so film beds stay on Lyria through the Gemini API unless
// PG1_ELEVENLABS_FILM_RIGHTS=1 says the plan covers film. Replicate's
// google/lyria-2 is never used for a film bed.
export function filmMusicExclude(env = {}) {
  const filmRights = String(env.PG1_ELEVENLABS_FILM_RIGHTS || '').trim() === '1';
  return filmRights ? ['replicate'] : ['elevenlabs', 'replicate'];
}

export function anthropicKey(env = {}) {
  return String(env.ANTHROPIC_API_KEY || env.ANTROPIC_API_KEY || '').replace(/\s+/g, '');
}

export function cartesiaConfig(env = {}) {
  return {
    apiKey: String(env.CARTESIA_API_KEY || '').replace(/\s+/g, ''),
    modelId: String(env.CARTESIA_MODEL_ID || '').trim() || 'sonic-3.6',
    // PG1_FILM_VOICE_ID is the ElevenLabs brand voice; Cartesia's own voice
    // is CARTESIA_VOICE_ID.
    voiceId: String(env.CARTESIA_VOICE_ID || '').trim() || DEFAULT_CARTESIA_VOICE
  };
}

// The film voice: ElevenLabs TTS on the paid plan (E1, Creator:
// commercial_ok) in the brand voice, PG1_FILM_VOICE_ID (else
// PG1_FILM_ELEVENLABS_VOICE_ID, else a premade voice: brandVoice false). Raw
// PCM at 24 kHz, which every paid plan may ask for (44.1 kHz PCM needs a
// higher plan).
export const ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
export const DEFAULT_ELEVENLABS_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
export function elevenLabsVoiceConfig(env = {}) {
  const format = String(env.PG1_FILM_ELEVENLABS_FORMAT || '').trim();
  const m = /^pcm_(16000|22050|24000|44100)$/.exec(format);
  return {
    apiKey: String(env.ELEVENLABS_API_KEY || '').replace(/\s+/g, ''),
    modelId: String(env.PG1_FILM_ELEVENLABS_TTS_MODEL || '').trim() || 'eleven_multilingual_v2',
    voiceId: String(env.PG1_FILM_VOICE_ID || env.PG1_FILM_ELEVENLABS_VOICE_ID || '').trim() || DEFAULT_ELEVENLABS_VOICE,
    brandVoice: !!String(env.PG1_FILM_VOICE_ID || '').trim(),
    format: m ? format : 'pcm_24000',
    sampleRate: m ? Number(m[1]) : 24000
  };
}

// The keys film text calls may use: paid ones only. The paid Gemini key is
// GEMINI_API_KEY_PAID alone (never an old Gemini name, which could hold a
// free-tier key), and never when it holds the free key's value.
export function filmTextKeys(env = {}) {
  const clean = (v) => String(v || '').replace(/\s+/g, '');
  const free = clean(env.GEMINI_API_KEY_FREE);
  const paid = clean(env.GEMINI_API_KEY_PAID);
  return {
    anthropic: anthropicKey(env),
    geminiPaid: paid && paid !== free ? paid : '',
    openrouter: clean(env.OPENROUTER_API_KEY || env.OPEN_ROUTER_KEY)
  };
}

export function hasFilmTextEngine(env = {}) {
  const k = filmTextKeys(env);
  return !!(k.anthropic || k.geminiPaid || k.openrouter);
}

export const FILM_TEXT_KEY_NAMES = 'ANTHROPIC_API_KEY, GEMINI_API_KEY_PAID or OPENROUTER_API_KEY';

// What the worker needs before it may spend anything; [] when ready.
export function missingFilmConfig(env = {}) {
  const out = [];
  if (!replicateToken(env)) out.push('REPLICATE_API_TOKEN');
  if (!filmModels(env).video) out.push('PG1_VIDEO_MODEL_REPLICATE_IMAGE');
  if (!hasFilmTextEngine(env)) out.push(FILM_TEXT_KEY_NAMES);
  if (!cartesiaConfig(env).apiKey && !elevenLabsVoiceConfig(env).apiKey) out.push('CARTESIA_API_KEY or ELEVENLABS_API_KEY');
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
//
// Throttling: a 429 on the create call is waited out (Retry-After, or the
// reset time in Replicate's message, else exponential backoff from 10 s;
// THROTTLE_POLICY) and the same request is sent again, on the same model.
// onThrottle({ attempt, waitMs }) hears about each one. A refused create
// (throttled to the end, out of credit, any other non-2xx) throws with
// notStarted: true: Replicate ran nothing and billed nothing.
// `ledger` (lib/aiRouter.mjs sharedLedger) puts its usage rows in
// pg1_ai_usage too; recordSuccess: false leaves the success row to a caller
// that records it itself (runRoute, lib/music/engines.mjs).
export async function replicateRun({ env, model, input, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 15 * 60 * 1000, pollMs = 4000, now = () => Date.now(), onThrottle = () => {}, throttlePolicy = THROTTLE_POLICY, ledger = null, recordSuccess = true, unit = null, costUsd = null }) {
  const token = replicateToken(env);
  if (!token) throw new EngineError('not_configured', 'no engine token', { notStarted: true, engine: 'replicate' });
  checkBudget(env, 'replicate');
  const body = JSON.stringify({ input });
  const sent = await sendWithThrottleRetry(async () => {
    const res = await fetchWithTimeout(fetchImpl, `${REPLICATE_API}/models/${model}/predictions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body
    }, 30000);
    const r = { res, ...(await readJson(res)) };
    if (!res.ok && mediaFailureKind(res.status, r.text) === 'throttled') {
      recordUsage({ provider: 'replicate', model, task: unit ? TASKS.MUSIC : TASKS.MEDIA, dataClass: 'operator', ok: false, status: res.status, unit: unit || replicateUnit(env, model) }, { env, ledger, log: () => {} });
      return { throttled: true, waitMs: retryAfterMs({ headers: res.headers, text: r.text, now: now() }), detail: r.text, r };
    }
    return r;
  }, { policy: throttlePolicy, sleep, onThrottle });
  const { res, json, text } = sent.outcome.r || sent.outcome;
  if (sent.exhausted) {
    throw new EngineError('throttled', 'the engine is rate limited', { status: res.status, notStarted: true, engine: 'replicate', detail: `replicate ${model} 429 after ${sent.throttles} tries and ${Math.round(sent.waitedMs / 1000)} s of waiting: ${String(text).slice(0, 240)}` });
  }
  if (!res.ok || !json || !json.id) {
    const kind = res.ok ? 'engine' : mediaFailureKind(res.status, text);
    throw new EngineError(kind === 'billing' ? 'billing' : 'engine', kind === 'billing' ? 'the engine is out of credit' : 'the engine did not start the job', { status: res.status, notStarted: true, engine: 'replicate', detail: `replicate ${model} ${res.status}: ${String(text).slice(0, 300)}`, refused: SAFETY_RE.test(text) });
  }
  const deadline = now() + timeoutMs;
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
  if (recordSuccess) recordUsage({ provider: 'replicate', model, task: TASKS.MEDIA, dataClass: 'operator', unit: replicateUnit(env, model), ...(Number.isFinite(costUsd) ? { costUsd } : {}) }, { env, ledger });
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

// --- media through the fallback router -------------------------------------------------
//
// Stills and clips follow their chains in the capability registry
// (ROUTING_CHAINS.stills: FLUX Kontext Pro on Replicate, then the paid
// Gemini key's image model; .clips: Gemini Omni on the paid key, then Kling
// on Replicate), planned over an env that holds only Replicate's token, the
// paid Gemini key (never the free key or an old Gemini name: filmTextKeys)
// and PG1_* settings, so a provider over its daily budget is left out. A
// client film uses commercial_ok engines only (Kling is unclear, R1).
//
// The fallback is per STAGE and per kind, not per shot, so a film keeps one
// look: the pipeline hands every media call the stage's state
// (newMediaStage), and once an engine has a capacity failure (out of credit,
// throttled after its waits, down, timed out, no key) the rest of that
// stage's stills or clips go to the next engine, and the pipeline makes the
// earlier ones again on it. The fallback gets the shared character and style
// reference and the previous shot's last frame with every still and clip.
// A refusal stops; a job that ran and failed stays on its engine (the
// shot's retries). Music beds follow ROUTING_CHAINS.music_film instead.

// One render stage's media state, shared by every call in that stage:
//   engine    the engine the stage is on (null: the first in the plan)
//   throttled set once any call was throttled; the pipeline then runs one
//             clip at a time for the rest of the stage
//   throttles how many 429s the stage has waited out
//   switched  { from, to, kind: 'billing' | 'throttled', what } once the
//             stage moved to the fallback
//   kinds     per kind ('still', 'clip'): { engine, switched }, since stills
//             and clips have their own chains; switched is the kind's own
//             switch, and the stage's `switched` the last one of any kind
export function newMediaStage() {
  return { engine: null, throttled: false, throttles: 0, switched: null, kinds: {} };
}

export const MEDIA_CHAINS = Object.freeze({ still: 'stills', clip: 'clips' });

// The env a film's media chain is planned over: Replicate's token, the paid
// Gemini key only (filmTextKeys) and PG1_* settings.
function filmMediaEnv(env = {}) {
  const routed = {};
  for (const [name, v] of Object.entries(env)) if (/^PG1_/.test(name)) routed[name] = v;
  return Object.assign(routed, { REPLICATE_API_TOKEN: replicateToken(env), GEMINI_API_KEY_PAID: filmTextKeys(env).geminiPaid });
}

// A kind's chain (ROUTING_CHAINS.stills or .clips) on this deployment:
// [{ provider, key, model, licence }] in order. clientWork: commercial_ok
// engines only (Kling is unclear, R1).
export function filmMediaPlan(env = {}, { now = Date.now(), kind = 'still', clientWork = false } = {}) {
  return chainPlan(MEDIA_CHAINS[kind] || 'stills', { env: filmMediaEnv(env), clientWork, now }).steps;
}

function sniffImageMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 11 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/png';
}

// A signed link (or a function resolving to one) as inline image data.
async function inlineImage(link, fetchImpl) {
  const url = typeof link === 'function' ? await link() : link;
  if (!url) return null;
  const buf = await download(url, { fetchImpl, timeoutMs: 60000 });
  return { mimeType: sniffImageMime(buf), data: buf.toString('base64') };
}

const CONTINUITY_TEXT = {
  reference: 'Character and style reference: keep every character, costume, palette and lighting exactly as shown here.',
  previous: 'Last frame of the previous shot: continue from it so the cut is seamless (same characters, wardrobe, light and place).'
};

function geminiFailure(kind, status, text, what, model, extra = {}) {
  const k = mediaFailureKind(status, text);
  const errKind = k === 'throttled' ? 'throttled' : k === 'billing' ? 'billing' : 'engine';
  return new EngineError(errKind, errKind === 'billing' ? 'the engine is out of credit' : errKind === 'throttled' ? 'the engine is rate limited' : `the ${what} could not be made`, {
    status, engine: 'gemini_paid', refused: k === 'refused', notStarted: !!status && status >= 400, detail: `gemini ${model} ${kind} ${providerErrorText(status, text)}`, ...extra
  });
}

// One 16:9 still on the paid Gemini key (generateContent, IMAGE out), with
// the reference and the previous shot's frame as inline images. Resolves
// to the image bytes.
export async function geminiStill({ env, key, prompt, referenceUrl = null, prevFrameUrl = null, fetchImpl = globalThis.fetch, sleep, onThrottle, now = () => Date.now(), timeoutMs = 120000 }) {
  checkBudget(env, 'gemini_paid');
  const model = String(env.PG1_FILM_GEMINI_STILL_MODEL || '').trim() || imageModels(env).primary;
  const parts = [{ text: `${String(prompt).slice(0, 2000)}\nCinematic 16:9 film still, no text, no lettering.` }];
  const ref = await inlineImage(referenceUrl, fetchImpl);
  if (ref) parts.push({ text: CONTINUITY_TEXT.reference }, { inlineData: ref });
  const prev = await inlineImage(prevFrameUrl, fetchImpl);
  if (prev) parts.push({ text: CONTINUITY_TEXT.previous }, { inlineData: prev });
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } } });
  const sent = await sendWithThrottleRetry(async () => {
    const res = await fetchWithTimeout(fetchImpl, `${GEMINI_API}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body
    }, timeoutMs);
    const r = { res, ...(await readJson(res)) };
    if (!res.ok && mediaFailureKind(res.status, r.text) === 'throttled') return { throttled: true, waitMs: retryAfterMs({ headers: res.headers, text: r.text, now: now() }), r };
    return r;
  }, { sleep, onThrottle });
  const { res, json, text } = sent.outcome.r || sent.outcome;
  if (!res.ok) throw geminiFailure('still', res.status, text, 'still', model);
  const cand = json && Array.isArray(json.candidates) ? json.candidates[0] : null;
  const blocked = (json && json.promptFeedback && json.promptFeedback.blockReason) || (cand && GEMINI_BLOCKED.has(cand.finishReason) ? cand.finishReason : '');
  if (blocked) throw new EngineError('refused', 'the request was declined', { refused: true, engine: 'gemini_paid', detail: `gemini ${model} still blocked: ${blocked}` });
  const part = ((cand && cand.content && cand.content.parts) || []).find((p) => p && p.inlineData && p.inlineData.data);
  if (!part) throw new EngineError('engine', 'the engine returned no image', { engine: 'gemini_paid', detail: `gemini ${model} returned no image (${(cand && cand.finishReason) || 'no candidates'})` });
  recordUsage({ provider: 'gemini_paid', model, task: TASKS.MEDIA, dataClass: 'operator', unit: 'still_gemini' }, { env });
  return Buffer.from(part.inlineData.data, 'base64');
}

// One image-to-video clip on the paid Gemini key: PG1 Motion's own
// synchronous Interactions request (lib/videoJobs.mjs), starting from
// `startImageUrl`, with the reference and the previous shot's last frame
// after it. Resolves to the clip's bytes.
export async function geminiClip({ env, key, prompt, startImageUrl, referenceUrl = null, prevFrameUrl = null, tier = 'standard', seconds = 5, fetchImpl = globalThis.fetch, sleep, onThrottle, now = () => Date.now(), timeoutMs = 10 * 60 * 1000, costUsd = null }) {
  checkBudget(env, 'gemini_paid');
  const model = videoModel(env);
  const durationS = seconds === 10 ? 10 : 5;
  const t = tier === 'draft' ? 'standard' : tier;
  const start = await inlineImage(startImageUrl, fetchImpl);
  const prevUrl = typeof prevFrameUrl === 'function' ? await prevFrameUrl() : prevFrameUrl;
  const body = buildVideoRequestBody({ model, prompt: `${prompt}\nThe first image is this shot's opening frame.`, image: start, tier: t, durationS, background: false, delivery: videoDelivery(t, durationS) });
  const extra = [];
  const ref = await inlineImage(referenceUrl, fetchImpl);
  if (ref) extra.push({ type: 'text', text: CONTINUITY_TEXT.reference }, { type: 'image', data: ref.data, mime_type: ref.mimeType });
  const prev = prevUrl && prevUrl !== startImageUrl ? await inlineImage(prevUrl, fetchImpl) : null;
  if (prev) extra.push({ type: 'text', text: CONTINUITY_TEXT.previous }, { type: 'image', data: prev.data, mime_type: prev.mimeType });
  if (extra.length) body.input = [...(Array.isArray(body.input) ? body.input : [{ type: 'text', text: body.input }]), ...extra];
  const payload = JSON.stringify(body);
  const sent = await sendWithThrottleRetry(async () => {
    const res = await googleVideoFetch(fetchImpl, INTERACTIONS_URL, { method: 'POST', key, headers: { 'Content-Type': 'application/json' }, body: payload, cache: 'no-store' }, timeoutMs);
    const r = { res, ...(await readJson(res)) };
    if (!res.ok && mediaFailureKind(res.status, r.text) === 'throttled') return { throttled: true, waitMs: retryAfterMs({ headers: res.headers, text: r.text, now: now() }), r };
    return r;
  }, { sleep, onThrottle });
  const { res, json, text } = sent.outcome.r || sent.outcome;
  if (!res.ok) throw geminiFailure('clip', res.status, engineErrorText(res.status, json, text), 'clip', model);
  const found = videoFromInteraction(json);
  const st = json && json.status;
  if (!found || (st && st !== 'completed')) {
    const why = engineErrorText(null, json, text);
    throw new EngineError('engine', 'the clip could not be made', { engine: 'gemini_paid', refused: SAFETY_RE.test(why), detail: `gemini ${model} clip ${st || 'no video'}: ${why}` });
  }
  let bytes;
  if (found.data) bytes = Buffer.from(found.data, 'base64');
  else {
    const dl = await googleVideoFetch(fetchImpl, found.uri, { key }, 300000);
    if (!dl.ok) throw new EngineError('engine', 'the file could not be fetched', { engine: 'gemini_paid', status: dl.status, detail: `gemini clip download ${dl.status}` });
    bytes = Buffer.from(await dl.arrayBuffer());
  }
  if (!bytes.length) throw new EngineError('engine', 'the engine returned an empty file', { engine: 'gemini_paid', detail: 'gemini clip empty' });
  recordUsage({ provider: 'gemini_paid', model, task: TASKS.MEDIA, dataClass: 'operator', unit: 'video_gemini', ...(Number.isFinite(costUsd) ? { costUsd } : {}) }, { env });
  return bytes;
}

// A media failure that moves the stage to the next engine of its chain: a
// capacity failure (lib/aiRouter.mjs failureClass). A refusal, a bad request
// or a job that ran and failed stays on the engine (a shot's retries).
export function isMediaCapacityFailure(e) {
  return e instanceof EngineError && failureClass({ status: e.status, text: e.detail, refused: e.refused, kind: e.kind }) === FAILURE.CAPACITY;
}

const ENGINE_WORDS = { billing: 'is out of credit', throttled: 'is still throttled after its waits', timeout: 'timed out', network: 'could not be reached', not_configured: 'has no usable key', budget: "is over today's budget" };

// The film's media engines: { still, clip, music }, each taking the
// stage's state as `stage` (newMediaStage) and resolving to { bytes, engine,
// ... } where engine is the ledger name of the engine that made it.
//   clientWork  a client film: commercial_ok engines only (A3)
//   alert       the capacity alert (lib/router/alerts.mjs), once per engine
//               per hour
export function createFilmMedia({ env = {}, fetchImpl = globalThis.fetch, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), ledger = null, clientWork = false, alert = async () => {} } = {}) {
  const models = filmModels(env);
  const say = (line) => { try { log(`[film] ${line}`); } catch (e) { /* logging never breaks a render */ } };
  const throttleListener = (stage, what) => ({ attempt, waitMs }) => {
    stage.throttled = true;
    stage.throttles++;
    say(`${what}: throttled (try ${attempt}); sending the same request again in ${Math.round(waitMs / 1000)} s; one clip at a time for the rest of this stage`);
  };
  const raise = (engine, e, what, next) => alert({ engine, kind: e.kind, status: e.status, what, next }).catch(() => {});

  // The stage keeps one engine per kind (A4): once a kind switches, the
  // rest of the stage stays on the new engine (the pipeline makes the
  // earlier items again on it). calls: { replicate(step), gemini_paid(step) }.
  const route = async (what, stage, calls) => {
    const plural = what === 'clip' ? 'clips' : 'stills';
    stage.kinds = stage.kinds || {};
    const k = stage.kinds[what] = stage.kinds[what] || { engine: null, switched: null };
    const plan = filmMediaPlan(env, { now: now(), kind: what, clientWork });
    if (!plan.length) {
      const why = emptyPlanReason(chainPlan(MEDIA_CHAINS[what], { env: filmMediaEnv(env), clientWork, now: now() }), { clientWork });
      throw new EngineError('not_configured', `no engine can make the ${plural}`, { notStarted: true, licence: clientWork, detail: why });
    }
    let i = k.engine ? plan.findIndex((c) => c.provider === k.engine) : 0;
    // Pinned to the engine the stored items were made by, which has left the
    // chain since: start over on the chain (the pipeline makes the stored
    // items again on the new engine).
    if (i < 0 && k.pinned) {
      k.switched = { from: k.engine, to: plan[0].provider, kind: 'budget', what };
      stage.switched = { ...k.switched };
      k.engine = null;
      k.pinned = false;
      i = 0;
    }
    if (i < 0) throw new EngineError('budget', "today's AI budget for this engine is reached", { notStarted: true, engine: k.engine, detail: `${k.engine} left the ${plural} chain (over budget or unset) after the stage switched to it` });
    let first = null;
    for (; i < plan.length; i++) {
      const c = plan[i];
      const call = calls[c.provider];
      try {
        if (!call) throw new EngineError('not_configured', `${c.provider} has no ${what} engine`, { notStarted: true, engine: c.provider });
        const out = await call(c);
        if (!k.engine) k.engine = c.provider;
        return { ...out, engine: c.provider };
      } catch (e) {
        if (!isMediaCapacityFailure(e)) throw e;
        const next = plan[i + 1];
        raise(c.provider, e, plural, next ? next.provider : null);
        if (first) {
          throw new EngineError(first.kind, first.message, { status: first.status, notStarted: e.notStarted, engine: first.engine || plan[0].provider, exhausted: true, fallback: { engine: c.provider, outcome: 'failed', kind: e.kind }, detail: `${first.detail} | ${e.detail}` });
        }
        first = e;
        if (!e.engine) e.engine = c.provider;
        if (!next) {
          e.fallback = { engine: c.provider === 'gemini_paid' ? 'replicate' : 'gemini_paid', outcome: 'not_configured' };
          e.exhausted = true;
          // A client film: the rest of the chain was left out for its licence.
          e.licence = clientWork && chainPlan(MEDIA_CHAINS[what], { env: filmMediaEnv(env), clientWork, now: now() }).skipped.some((x) => x.reason === 'licence');
          throw e;
        }
        k.engine = next.provider;
        k.switched = { from: c.provider, to: next.provider, kind: e.kind, what };
        stage.engine = next.provider;
        stage.switched = { ...k.switched };
        say(`${what}: ${c.provider} ${ENGINE_WORDS[e.kind] || `failed (${e.status || e.kind})`}; the rest of this stage's ${plural} go to ${next.provider}`);
      }
    }
    throw new EngineError('engine', `the ${what} could not be made`, { notStarted: true, exhausted: true, detail: 'no engine left in the chain' });
  };

  return {
    still: ({ prompt, referenceUrl = null, prevFrameUrl = null, seed = null, stage = newMediaStage() }) => route('still', stage, {
      replicate: async () => {
        const r = await replicateRun({ env, model: models.still, input: stillInput(prompt, { referenceUrl, seed }), fetchImpl, sleep, now, onThrottle: throttleListener(stage, 'still') });
        return { bytes: await download(r.url, { fetchImpl }) };
      },
      gemini_paid: async (c) => ({ bytes: await geminiStill({ env, key: c.key, prompt, referenceUrl, prevFrameUrl, fetchImpl, sleep, now, onThrottle: throttleListener(stage, 'still') }) })
    }),
    // Each clip's usage row carries its real price on the engine that made
    // it (lib/film/cost.mjs), not the price table's worst case.
    clip: ({ prompt, startImageUrl, referenceUrl = null, prevFrameUrl = null, tier, seconds, stage = newMediaStage() }) => route('clip', stage, {
      replicate: async () => {
        const r = await replicateRun({ env, model: models.video, input: clipInput(models.video, { prompt, startImageUrl, tier, seconds }), fetchImpl, sleep, now, timeoutMs: 25 * 60 * 1000, onThrottle: throttleListener(stage, 'clip'), costUsd: clipCostOnUsd('replicate', tier, seconds) });
        return { bytes: await download(r.url, { fetchImpl, timeoutMs: 300000 }) };
      },
      gemini_paid: async (c) => ({ bytes: await geminiClip({ env, key: c.key, prompt, startImageUrl, referenceUrl, prevFrameUrl, tier, seconds, fetchImpl, sleep, now, onThrottle: throttleListener(stage, 'clip'), costUsd: clipCostOnUsd('gemini_paid', tier, seconds) }) })
    }),
    // Music beds follow ROUTING_CHAINS.music_film (lib/music/engines.mjs
    // filmMusicPlan): Lyria 3.5 on the paid Gemini key, then the Lyria clip
    // model; ElevenLabs only when the plan covers film
    // (filmMusicExclude), never Replicate. Each bed is scored to its scene:
    // `seconds` long, with a natural ending, never a loop.
    music: async ({ mood, bpm, seconds = null, stage = newMediaStage() }) => {
      void stage;
      const { generateMusic, filmMusicPlan } = await import('../music/engines.mjs');
      const exclude = filmMusicExclude(env);
      const spec = { prompt: `Instrumental film score cue: ${mood}. Mixes under narration and dialogue.`, instrumental: true, bpm, length: 'short', ...(seconds ? { seconds } : {}) };
      const plan = filmMusicPlan(env, { exclude, now: now(), ledger });
      const out = await generateMusic({ env, spec, exclude, plan, fetchImpl, sleep, now, log: () => {}, ledger });
      out.failures.forEach((f, i) => { if (f.status === 429 || f.status === 402 || f.status == null || f.status >= 500) raise(f.provider, { kind: null, status: f.status }, 'music beds', (out.failures[i + 1] || (out.ok ? { provider: out.provider } : {})).provider || null); });
      if (out.ok) {
        if (out.fallbacks) say(`music bed: made by ${out.provider} after ${out.failures.map((f) => f.provider).join(', ')} failed`);
        return { bytes: out.bytes, ext: out.ext, mime: out.mime, engine: out.provider, costUsd: out.costUsd, clip: !!out.clip };
      }
      if (out.kind === 'refused') throw new EngineError('refused', 'the request was declined', { refused: true, detail: out.detail });
      const failed = out.failures.map((f) => f.provider);
      const kind = out.kind;
      const fallback = failed.length > 1 ? { engine: failed[failed.length - 1], outcome: 'failed' } : { engine: 'gemini_paid', outcome: 'not_configured' };
      throw new EngineError(kind, kind === 'billing' ? 'the engine is out of credit' : kind === 'throttled' ? 'the engine is rate limited' : 'the music bed could not be made', { notStarted: kind !== 'engine', engine: failed[0] || 'gemini_paid', fallback, detail: out.detail || 'no music engine left' });
    }
  };
}

// --- text: storyboard, edits and shot checks, with fallback ----------------------------

// The router's plan for a film text call: its heavy route, planned as
// customer data so the free Gemini key can never be in it, over an env that
// holds only the paid film keys (filmTextKeys) and PG1_* settings (budgets,
// model lists, prices). So the order is Claude, the paid Gemini key, then
// OpenRouter, each skipped when unset, over budget or in its breaker
// window (then tried last). Claude runs PG1_FILM_CLAUDE_MODEL.
export function filmTextPlan(env = {}, { now = Date.now() } = {}) {
  const k = filmTextKeys(env);
  const routed = {};
  for (const [name, v] of Object.entries(env)) if (/^PG1_/.test(name)) routed[name] = v;
  Object.assign(routed, { ANTHROPIC_API_KEY: k.anthropic, GEMINI_API_KEY_PAID: k.geminiPaid, OPENROUTER_API_KEY: k.openrouter });
  return planRoute(TASKS.HEAVY, { env: routed, dataClass: DATA.CUSTOMER, now })
    .filter((c) => c.provider === 'anthropic' || c.provider === 'gemini_paid' || c.provider === 'openrouter')
    .map((c) => (c.provider === 'anthropic' ? { ...c, models: [filmModels(env).claude] } : c));
}

// `content` is Anthropic-shaped: a string, or text and base64 image blocks
// (imageBlock). These turn it into the other engines' shapes.
const blocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);

export function geminiParts(content) {
  return blocks(content).map((b) => (b && b.type === 'image' && b.source
    ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } }
    : { text: String(b && b.text || '') }));
}

export function openAiContent(content) {
  if (typeof content === 'string') return content;
  return blocks(content).map((b) => (b && b.type === 'image' && b.source
    ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
    : { type: 'text', text: String(b && b.text || '') }));
}

function textOf(content) {
  return blocks(content).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
}

// One Messages API call. Resolves to an attempt result for runRoute:
// { ok, status, model, text, usage, detail, refused }. Uses the server-side
// fallback beta so a policy decline on one model is retried on another
// inside the call; if the account does not accept that field, the call is
// made once more without it.
async function anthropicAttempt({ candidate, system, content, maxTokens, effort, fetchImpl, timeoutMs }) {
  const model = candidate.models[0];
  const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }], output_config: { effort } };
  const call = async (withFallback) => {
    const headers = { 'Content-Type': 'application/json', 'x-api-key': candidate.key, 'anthropic-version': '2023-06-01' };
    if (withFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    const res = await fetchWithTimeout(fetchImpl, ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(withFallback ? { ...body, fallbacks: 'default' } : body) }, timeoutMs);
    return { res, ...(await readJson(res)) };
  };
  let r = await call(true);
  if (r.res.status === 400 && /fallback/i.test(r.text) && !isBillingFailure(400, r.text)) r = await call(false);
  if (!r.res.ok) return { ok: false, status: r.res.status, model, detail: `messages ${model} ${providerErrorText(r.res.status, r.text)}` };
  const msg = r.json || {};
  if (msg.stop_reason === 'refusal') return { ok: false, status: r.res.status, model, refused: true, detail: `messages ${model} refusal: ${JSON.stringify(msg.stop_details || null).slice(0, 200)}` };
  const text = (Array.isArray(msg.content) ? msg.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  const u = msg.usage || {};
  const usage = { inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0 };
  if (!text) return { ok: false, status: null, model: msg.model || model, usage, detail: `messages ${model} stop=${msg.stop_reason}` };
  return { ok: true, status: r.res.status, model: msg.model || model, text, usage };
}

const GEMINI_BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'RECITATION']);

// One generateContent call on the paid Gemini key, each of the candidate's
// models in turn while a model fails in a way the next might not. JSON
// replies are asked for with responseMimeType; no sampling parameters
// (tests/gemini-no-sampling-params.test.mjs).
async function geminiAttempt({ candidate, system, content, maxTokens, json, fetchImpl, timeoutMs }) {
  let last = { ok: false, status: null, model: '', detail: 'no model configured' };
  for (const model of candidate.models) {
    try {
      const res = await fetchWithTimeout(fetchImpl, `${GEMINI_API}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': candidate.key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: geminiParts(content) }],
          generationConfig: { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) }
        })
      }, timeoutMs);
      const r = await readJson(res);
      if (!res.ok) {
        last = { ok: false, status: res.status, model, detail: `gemini ${model} ${providerErrorText(res.status, r.text)}` };
        if (isBillingFailure(res.status, r.text) || !isFallbackFailure(res.status, r.text)) return last;
        continue;
      }
      const j = r.json || {};
      const cand = Array.isArray(j.candidates) ? j.candidates[0] : null;
      const blocked = (j.promptFeedback && j.promptFeedback.blockReason) || (cand && GEMINI_BLOCKED.has(cand.finishReason) ? cand.finishReason : '');
      if (blocked) return { ok: false, status: res.status, model, refused: true, detail: `gemini ${model} blocked: ${blocked}` };
      const text = ((cand && cand.content && cand.content.parts) || []).filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
      const um = j.usageMetadata || {};
      const usage = { inputTokens: um.promptTokenCount || estimateTokens(system + textOf(content)), outputTokens: um.candidatesTokenCount || estimateTokens(text) };
      if (text) return { ok: true, status: res.status, model, text, usage };
      last = { ok: false, status: null, model, usage, detail: `gemini ${model} returned no text (${(cand && cand.finishReason) || 'no candidates'})` };
    } catch (e) {
      last = { ok: false, status: null, model, detail: `gemini ${model}: ${e && e.name === 'AbortError' ? 'timed out' : e && e.message}` };
    }
  }
  return last;
}

// One chat-completions call on OpenRouter, each of the candidate's models
// in turn, the same way.
async function openRouterAttempt({ candidate, system, content, maxTokens, fetchImpl, timeoutMs }) {
  let last = { ok: false, status: null, model: '', detail: 'no model configured' };
  for (const model of candidate.models) {
    try {
      const res = await fetchWithTimeout(fetchImpl, OPENROUTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.key}` },
        body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: openAiContent(content) }] })
      }, timeoutMs);
      const r = await readJson(res);
      if (!res.ok) {
        last = { ok: false, status: res.status, model, detail: `openrouter ${model} ${providerErrorText(res.status, r.text)}` };
        if (isBillingFailure(res.status, r.text) || !isFallbackFailure(res.status, r.text)) return last;
        continue;
      }
      const choice = r.json && Array.isArray(r.json.choices) ? r.json.choices[0] : null;
      if (choice && choice.finish_reason === 'content_filter') return { ok: false, status: res.status, model, refused: true, detail: `openrouter ${model} content_filter` };
      const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
      const u = (r.json && r.json.usage) || {};
      const usage = { inputTokens: u.prompt_tokens || estimateTokens(system + textOf(content)), outputTokens: u.completion_tokens || estimateTokens(text) };
      if (text) return { ok: true, status: res.status, model, text, usage };
      last = { ok: false, status: null, model, usage, detail: `openrouter ${model} returned no text` };
    } catch (e) {
      last = { ok: false, status: null, model, detail: `openrouter ${model}: ${e && e.name === 'AbortError' ? 'timed out' : e && e.message}` };
    }
  }
  return last;
}

const ATTEMPTS = { anthropic: anthropicAttempt, gemini: geminiAttempt, openai_compat: openRouterAttempt };

function withRetryNote(content, why) {
  const note = `Your last reply could not be used (${why}). Reply with the JSON object only, following the shape above exactly.`;
  return typeof content === 'string' ? `${content}\n\n${note}` : [...blocks(content), { type: 'text', text: note }];
}

// One film text call through the router: Claude, then the paid Gemini key,
// then OpenRouter (filmTextPlan). With `validate(text)` (which throws on a
// reply it cannot use and returns the checked value otherwise), a reply
// that fails it is asked for once more from the same engine, with the
// reason; a second bad reply moves on to the next engine. Resolves to
// { text, value, provider, model, usage, fallbacks }; logs which engine
// answered (worker log only, never a reply). Throws an EngineError
// (refused: true on a refusal, which never moves on).
export async function filmThink({ env = {}, system, content, maxTokens = 16000, effort = 'medium', validate = null, json = !!validate, purpose = 'text', fetchImpl = globalThis.fetch, timeoutMs = 10 * 60 * 1000, log = console.log, plan = null, alert = null }) {
  const candidates = plan || filmTextPlan(env);
  if (!candidates.length) throw new EngineError('not_configured', 'no reasoning engine is configured', { detail: `none of ${FILM_TEXT_KEY_NAMES} is set (or all are over budget)` });
  const say = (line) => { try { log(`[film] ${line}`); } catch (e) { /* logging never breaks a render */ } };
  const attempt = async (c) => {
    const call = (body) => ATTEMPTS[c.family]({ candidate: c, system, content: body, maxTokens, effort, json, fetchImpl, timeoutMs });
    const r = await call(content);
    const done = (x, value) => ({ ...x, value: { text: x.text, value, usage: x.usage || null } });
    if (!r.ok || !validate) return done(r, r.text);
    try {
      return done(r, validate(r.text));
    } catch (e) {
      const why = String(e && e.message || e).slice(0, 120);
      say(`${purpose}: ${c.provider} (${r.model}) wrote an unusable reply (${why}); asking it once more`);
      // The discarded reply was paid for: its own usage row.
      recordUsage({ provider: c.provider, model: r.model, task: TASKS.HEAVY, dataClass: DATA.CUSTOMER, inputTokens: r.usage && r.usage.inputTokens, outputTokens: r.usage && r.usage.outputTokens }, { env, log });
      const again = await call(withRetryNote(content, why));
      if (!again.ok) return again;
      try {
        return done(again, validate(again.text));
      } catch (e2) {
        const why2 = String(e2 && e2.message || e2).slice(0, 120);
        recordUsage({ provider: c.provider, model: again.model, task: TASKS.HEAVY, dataClass: DATA.CUSTOMER, inputTokens: again.usage && again.usage.inputTokens, outputTokens: again.usage && again.usage.outputTokens }, { env, log });
        return { ok: false, status: again.status, model: again.model, invalid: true, detail: `${c.provider} ${again.model}: unusable reply twice (${why2})` };
      }
    }
  };
  const out = await runRoute({ task: TASKS.HEAVY, env, dataClass: DATA.CUSTOMER, plan: candidates, attempt, log, onCapacity: alert ? (a) => alert({ ...a, what: purpose }) : null });
  // One short line per engine that failed, for pg1_errors (EngineError keeps 500 characters).
  const summary = out.failures.map((f) => `${f.provider}: ${String(f.detail || f.status).slice(0, 150)}`).join(' | ');
  if (out.ok) {
    say(`${purpose} written by ${out.candidate.provider} (${out.model})${out.failures.length ? ` after ${out.failures.map((f) => f.provider).join(', ')} failed` : ''}`);
    return { text: out.value.text, value: out.value.value, provider: out.candidate.provider, model: out.model, usage: out.value.usage, fallbacks: out.failures.length };
  }
  const last = out.failures[out.failures.length - 1] || {};
  if (last.refused) throw new EngineError('refused', 'the request was declined', { refused: true, detail: summary });
  throw new EngineError('engine', 'the reasoning step failed', { status: last.status == null ? null : last.status, detail: summary });
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
  if (!apiKey) throw new EngineError('not_configured', 'no voice key', { notStarted: true, engine: 'cartesia' });
  checkBudget(env, 'cartesia');
  const chunks = [];
  const words = [];
  let error = '';
  // The whole line, stream included, has timeoutMs: a stalled stream is a
  // timeout like a stalled request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetchImpl(CARTESIA_TTS_SSE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Cartesia-Version': CARTESIA_TTS_VERSION, 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: modelId,
        transcript: String(text).slice(0, 1000),
        voice: { mode: 'id', id: voiceId },
        language: 'en',
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: TTS_SAMPLE_RATE },
        add_timestamps: true
      })
    });
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 200); } catch (e) { body = ''; }
      throw new EngineError('engine', 'the voiceover could not be recorded', { status: res.status, engine: 'cartesia', notStarted: true, detail: `tts ${res.status}: ${body}` });
    }
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
  } catch (e) {
    if (e instanceof EngineError) throw e;
    const timedOut = controller.signal.aborted || (e && (e.name === 'AbortError' || e.name === 'TimeoutError'));
    throw new EngineError(timedOut ? 'timeout' : 'network', timedOut ? 'the voiceover timed out' : 'the voiceover could not be recorded', { engine: 'cartesia', detail: `tts ${timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `network: ${e && e.message}`}` });
  } finally {
    clearTimeout(timer);
  }
  if (error) throw new EngineError('engine', 'the voiceover could not be recorded', { engine: 'cartesia', detail: `tts stream error: ${error}` });
  const pcm = Buffer.concat(chunks);
  if (!pcm.length) throw new EngineError('engine', 'the voiceover came back empty', { engine: 'cartesia', detail: 'tts returned no audio' });
  recordUsage({ provider: 'cartesia', model: modelId, task: TASKS.TTS, dataClass: 'operator', chars: String(text).slice(0, 1000).length }, { env });
  return { pcm, sampleRate: TTS_SAMPLE_RATE, durationS: pcm.length / 2 / TTS_SAMPLE_RATE, words };
}

// --- ElevenLabs: the voiceover fallback --------------------------------------------

// ElevenLabs' character alignment as words with start and end times, in
// the shape Cartesia's word timestamps have (captions and the transcript
// check use them).
export function wordsFromAlignment(al) {
  const chars = al && Array.isArray(al.characters) ? al.characters : [];
  const st = (al && al.character_start_times_seconds) || [];
  const en = (al && al.character_end_times_seconds) || [];
  const words = [];
  let cur = null;
  chars.forEach((ch, i) => {
    if (/\s/.test(String(ch))) { if (cur) { words.push(cur); cur = null; } return; }
    if (!cur) cur = { word: '', start: Number(st[i]) || 0, end: Number(en[i]) || 0 };
    cur.word += ch;
    cur.end = Number(en[i]) || cur.end;
  });
  if (cur) words.push(cur);
  return words;
}

// One voiceover line on ElevenLabs (text to speech with timestamps).
// Resolves to the same shape as synthesizeLine.
export async function synthesizeLineElevenLabs({ env, text, fetchImpl = globalThis.fetch, timeoutMs = 60000, voiceId: voiceOverride = null }) {
  const cfg = elevenLabsVoiceConfig(env);
  const { apiKey, modelId, format, sampleRate } = cfg;
  const voiceId = voiceOverride || cfg.voiceId;
  if (!apiKey) throw new EngineError('not_configured', 'no backup voice key', { notStarted: true, engine: 'elevenlabs' });
  checkBudget(env, 'elevenlabs');
  const transcript = String(text).slice(0, 1000);
  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, `${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${format}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ text: transcript, model_id: modelId })
    }, timeoutMs);
  } catch (e) {
    const timedOut = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    throw new EngineError(timedOut ? 'timeout' : 'network', timedOut ? 'the voiceover timed out' : 'the voiceover could not be recorded', { engine: 'elevenlabs', detail: `elevenlabs tts ${timedOut ? 'timed out' : `network: ${e && e.message}`}` });
  }
  const { json, text: body } = await readJson(res);
  if (!res.ok) {
    const k = mediaFailureKind(res.status, body);
    throw new EngineError(k === 'billing' ? 'billing' : k === 'throttled' ? 'throttled' : 'engine', 'the voiceover could not be recorded', { status: res.status, engine: 'elevenlabs', notStarted: true, detail: `elevenlabs tts ${providerErrorText(res.status, body)}` });
  }
  const pcm = json && typeof json.audio_base64 === 'string' ? Buffer.from(json.audio_base64, 'base64') : Buffer.alloc(0);
  if (!pcm.length) throw new EngineError('engine', 'the voiceover came back empty', { engine: 'elevenlabs', detail: 'elevenlabs tts returned no audio' });
  const words = wordsFromAlignment(json.alignment || json.normalized_alignment);
  recordUsage({ provider: 'elevenlabs', model: modelId, task: TASKS.TTS, dataClass: 'operator', chars: transcript.length }, { env });
  return { pcm, sampleRate, durationS: pcm.length / 2 / sampleRate, words };
}

// Cartesia failures worth one more send: a timeout, a network error, 408,
// 429 or a 5xx. Anything else (a bad key, no credit) goes straight to the
// fallback.
export function isVoiceRetryable(e) {
  if (!(e instanceof EngineError)) return true;
  if (e.kind === 'timeout' || e.kind === 'network') return true;
  if (e.kind !== 'engine') return false;
  return e.status == null || e.status === 408 || e.status === 429 || e.status >= 500;
}

export const VOICE_RETRY_WAIT_MS = 2000;

// One render stage's voice state, shared by every line in it:
//   engine    'cartesia' (null: the first configured) or 'elevenlabs'
//   retries   how many lines needed Cartesia's second send
//   switched  { from, to, kind, detail } once the stage moved to ElevenLabs
export function newVoiceStage() {
  return { engine: null, retries: 0, switched: null };
}

// The film's voiceover engine: Cartesia, sent once more on a timeout or
// outage, then ElevenLabs for this line and the rest of the stage, so a
// film keeps one voice from then on and never fails on Cartesia alone.
// voice({ text, stage }) resolves to { pcm, sampleRate, durationS, words,
// engine } and throws only when both engines failed (or neither is set).
export function createFilmVoice({ env = {}, fetchImpl = globalThis.fetch, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 60000, clientWork = false, alert = async () => {} } = {}) {
  const say = (line) => { try { log(`[film] ${line}`); } catch (e) { /* logging never breaks a render */ } };
  const asEngineError = (e, engine) => (e instanceof EngineError ? e : new EngineError('engine', 'the voiceover could not be recorded', { engine, detail: String(e && e.message || e) }));
  const synth = {
    cartesia: (text) => synthesizeLine({ env, text, fetchImpl, timeoutMs }),
    elevenlabs: (text) => synthesizeLineElevenLabs({ env, text, fetchImpl, timeoutMs })
  };
  // One engine: a second send after a timeout or outage (Cartesia timed out
  // six times in one week).
  const once = async (engine, text, stage) => {
    let last = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return { ...(await synth[engine](text)), engine };
      } catch (e) {
        last = asEngineError(e, engine);
        if (attempt === 2 || !isVoiceRetryable(last)) break;
        stage.retries++;
        say(`voiceover: ${engine} ${last.kind} (${last.detail}); sending the line once more in ${VOICE_RETRY_WAIT_MS / 1000} s`);
        await sleep(VOICE_RETRY_WAIT_MS);
      }
    }
    throw last;
  };
  return async ({ text, stage = newVoiceStage() }) => {
    // ROUTING_CHAINS.voice: the ElevenLabs brand voice, then Cartesia
    // (never for a client film: C1).
    const order = chainPlan('voice', { env, clientWork }).steps.map((s) => s.provider);
    if (!order.length) throw new EngineError('not_configured', 'no voice engine', { notStarted: true, engine: 'elevenlabs', licence: clientWork, fallback: { engine: 'cartesia', outcome: 'not_configured' }, detail: clientWork ? 'a client film needs ELEVENLABS_API_KEY (Cartesia is not cleared for client work, C1)' : 'neither ELEVENLABS_API_KEY nor CARTESIA_API_KEY is set' });
    // The stage's engine first (A4), then the rest of the chain in order.
    if (stage.engine && order.includes(stage.engine)) order.unshift(...order.splice(order.indexOf(stage.engine), 1));
    let first = null;
    for (let i = 0; i < order.length; i++) {
      const engine = order[i];
      try {
        const line = await once(engine, text, stage);
        if (first) {
          // The rest of the stage stays on this engine (A4).
          stage.switched = { from: first.engine, to: engine, kind: first.kind, detail: first.detail };
        }
        stage.engine = engine;
        return line;
      } catch (e) {
        if (failureClass({ status: e.status, text: e.detail, refused: e.refused, kind: e.kind }) !== FAILURE.CAPACITY) throw e;
        const next = order[i + 1] || null;
        alert({ engine, kind: e.kind, status: e.status, what: 'the voice-over', next }).catch(() => {});
        if (!next) {
          if (!first) { e.fallback = { engine: engine === 'cartesia' ? 'elevenlabs' : 'cartesia', outcome: 'not_configured' }; throw e; }
          throw new EngineError(e.kind, 'the voiceover could not be recorded', { status: e.status, engine: first.engine, notStarted: !!(first.notStarted && e.notStarted), fallback: { engine, outcome: 'failed' }, detail: `${first.detail} | ${e.detail}` });
        }
        if (!first) first = Object.assign(e, { engine });
        say(`voiceover: ${engine} failed (${e.kind}: ${e.detail}); the rest of this stage goes to ${next}`);
      }
    }
    throw new EngineError('engine', 'the voiceover could not be recorded', { detail: 'no voice engine left' });
  };
}

// --- Director Mode: sound effects and dialogue (ROUTING_CHAINS.sfx, .dialogue) ---------

export const ELEVENLABS_SFX_URL = 'https://api.elevenlabs.io/v1/sound-generation';
export const ELEVENLABS_DIALOGUE_URL = 'https://api.elevenlabs.io/v1/text-to-dialogue';

// One sound effect (ElevenLabs text to sound, 0.5 to 30 s). Resolves to
// { bytes, ext: 'mp3', mime, durationS, engine }.
export async function soundEffect({ env, text, seconds = 3, fetchImpl = globalThis.fetch, timeoutMs = 60000 }) {
  const { apiKey } = elevenLabsVoiceConfig(env);
  if (!apiKey) throw new EngineError('not_configured', 'no sound effects key', { notStarted: true, engine: 'elevenlabs' });
  checkBudget(env, 'elevenlabs');
  const durationS = Math.min(30, Math.max(0.5, Math.round(Number(seconds) * 10) / 10 || 3));
  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, `${ELEVENLABS_SFX_URL}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, 450), duration_seconds: durationS, prompt_influence: 0.4 })
    }, timeoutMs);
  } catch (e) {
    const timedOut = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    throw new EngineError(timedOut ? 'timeout' : 'network', 'the sound effect could not be made', { engine: 'elevenlabs', detail: `elevenlabs sfx ${timedOut ? 'timed out' : `network: ${e && e.message}`}` });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const k = mediaFailureKind(res.status, body);
    throw new EngineError(k === 'billing' ? 'billing' : k === 'throttled' ? 'throttled' : k === 'refused' ? 'refused' : 'engine', 'the sound effect could not be made', { status: res.status, engine: 'elevenlabs', notStarted: true, refused: k === 'refused', detail: `elevenlabs sfx ${providerErrorText(res.status, body)}` });
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new EngineError('engine', 'the sound effect came back empty', { engine: 'elevenlabs', detail: 'elevenlabs sfx returned no audio' });
  recordUsage({ provider: 'elevenlabs', model: 'eleven_text_to_sound_v2', task: TASKS.TTS, dataClass: 'operator', unit: 'sfx_elevenlabs', costUsd: engineCostUsd('sfx_elevenlabs', { seconds: durationS }) }, { env });
  return { bytes, ext: 'mp3', mime: 'audio/mpeg', durationS, engine: 'elevenlabs' };
}

// The voices characters speak in: PG1_DIRECTOR_VOICES ("Ana=voiceId;Ben=
// voiceId"), else premade voices in a fixed order, so one character keeps
// one voice for the whole film. The narrator is the brand voice.
export const DEFAULT_CHARACTER_VOICES = Object.freeze(['21m00Tcm4TlvDq8ikWAM', 'pNInz6obpgDQGcFmaJgB', 'EXAVITQu4vr4xnSDxMaL', 'TxGEqnHWrfWFTfGW9XjX', 'MF3mGyEYCl7XYWbV9V6O', 'VR6AewLTigWG4xSOukaG']);
export function characterVoice(env = {}, character, index = 0) {
  const map = {};
  for (const pair of String(env.PG1_DIRECTOR_VOICES || '').split(/[;,]/)) {
    const m = /^\s*([^=]{1,60})=\s*([A-Za-z0-9]{8,40})\s*$/.exec(pair);
    if (m) map[m[1].trim().toLowerCase()] = m[2];
  }
  const name = String(character || '').trim().toLowerCase();
  if (name && map[name]) return map[name];
  if (/^narrator$/.test(name)) return elevenLabsVoiceConfig(env).voiceId;
  return DEFAULT_CHARACTER_VOICES[Math.abs(index) % DEFAULT_CHARACTER_VOICES.length];
}

// Words spread evenly over a take (Text to Dialogue returns no timings).
function evenWords(text, startS, durationS) {
  const ws = String(text).split(/\s+/).filter(Boolean);
  const step = ws.length ? durationS / ws.length : 0;
  return ws.map((w, i) => ({ word: w, start: Math.round((startS + i * step) * 1000) / 1000, end: Math.round((startS + (i + 1) * step - 0.02) * 1000) / 1000 }));
}

// A shot's dialogue: lines [{ character, line }] spoken by their
// characters. ROUTING_CHAINS.dialogue: one Text to Dialogue take (eleven_v3),
// then the same voices line by line; the stage keeps the mode it switched
// to. Resolves to { pcm, sampleRate, durationS, words, engine }.
export function createFilmDialogue({ env = {}, fetchImpl = globalThis.fetch, log = console.log, timeoutMs = 90000, alert = async () => {}, characters = [] } = {}) {
  const say = (line) => { try { log(`[film] ${line}`); } catch (e) { /* logging never breaks a render */ } };
  let cast = characters;
  const voiceOf = (c) => characterVoice(env, c, Math.max(0, cast.findIndex((x) => String(x).toLowerCase() === String(c).toLowerCase())));
  const { sampleRate, format } = elevenLabsVoiceConfig(env);
  const oneTake = async (lines) => {
    const { apiKey } = elevenLabsVoiceConfig(env);
    if (!apiKey) throw new EngineError('not_configured', 'no dialogue key', { notStarted: true, engine: 'elevenlabs' });
    checkBudget(env, 'elevenlabs');
    let res;
    try {
      res = await fetchWithTimeout(fetchImpl, `${ELEVENLABS_DIALOGUE_URL}?output_format=${format}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: 'eleven_v3', inputs: lines.map((l) => ({ text: String(l.line).slice(0, 500), voice_id: voiceOf(l.character) })) })
      }, timeoutMs);
    } catch (e) {
      const timedOut = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
      throw new EngineError(timedOut ? 'timeout' : 'network', 'the dialogue could not be recorded', { engine: 'elevenlabs', detail: `elevenlabs dialogue ${timedOut ? 'timed out' : `network: ${e && e.message}`}` });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const k = mediaFailureKind(res.status, body);
      throw new EngineError(k === 'billing' ? 'billing' : k === 'throttled' ? 'throttled' : k === 'refused' ? 'refused' : 'engine', 'the dialogue could not be recorded', { status: res.status, engine: 'elevenlabs', notStarted: true, refused: k === 'refused', detail: `elevenlabs dialogue ${providerErrorText(res.status, body)}` });
    }
    const pcm = Buffer.from(await res.arrayBuffer());
    if (!pcm.length) throw new EngineError('engine', 'the dialogue came back empty', { engine: 'elevenlabs', detail: 'elevenlabs dialogue returned no audio' });
    const text = lines.map((l) => l.line).join(' ');
    const durationS = pcm.length / 2 / sampleRate;
    recordUsage({ provider: 'elevenlabs', model: 'eleven_v3', task: TASKS.TTS, dataClass: 'operator', chars: text.length }, { env });
    return { pcm, sampleRate, durationS, words: evenWords(text, 0, durationS), engine: 'elevenlabs' };
  };
  const lineByLine = async (lines) => {
    const gap = Buffer.alloc(Math.round(sampleRate * 0.3) * 2);
    const parts = [];
    const words = [];
    let t = 0;
    for (const l of lines) {
      const take = await synthesizeLineElevenLabs({ env, text: l.line, fetchImpl, timeoutMs, voiceId: voiceOf(l.character) });
      for (const w of take.words) words.push({ word: w.word, start: Math.round((w.start + t) * 1000) / 1000, end: Math.round((w.end + t) * 1000) / 1000 });
      parts.push(take.pcm, gap);
      t += take.durationS + 0.3;
    }
    const pcm = Buffer.concat(parts.slice(0, -1));
    return { pcm, sampleRate, durationS: pcm.length / 2 / sampleRate, words, engine: 'elevenlabs' };
  };
  // characters: the film's cast in order (each keeps one voice all film).
  return async ({ lines, stage, characters: filmCast = null }) => {
    if (Array.isArray(filmCast) && filmCast.length) cast = filmCast;
    const st = stage || {};
    if (st.dialogueMode !== 'lines') {
      try {
        return await oneTake(lines);
      } catch (e) {
        if (failureClass({ status: e.status, text: e.detail, refused: e.refused, kind: e.kind }) !== FAILURE.CAPACITY) throw e;
        alert({ engine: 'elevenlabs', kind: e.kind, status: e.status, what: 'dialogue (one take)', next: 'elevenlabs' }).catch(() => {});
        st.dialogueMode = 'lines';
        say(`dialogue: one take failed (${e.kind}: ${e.detail}); the rest of this stage records line by line in the same voices`);
      }
    }
    return lineByLine(lines);
  };
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
