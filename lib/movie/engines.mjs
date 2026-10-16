// PG1 Studio movies: the engine calls a movie adds to the film's.
//
//   dialogueClip     one shot from the picture engine that generates speech
//                    with the picture, lip-synced (ROUTING_CHAINS
//                    .movie_dialogue_clips: Gemini Omni 1.1 Flash on the paid
//                    Gemini key, commercial_ok under G1), at 1080p, with the
//                    shot's bible reference images after the prompt so every
//                    face, hair and wardrobe stays the same across shots
//   speechToSpeech   one take's audio into the speaking character's cast
//                    voice (ROUTING_CHAINS.speech_to_speech: ElevenLabs
//                    speech-to-speech, commercial_ok under E1); the output
//                    keeps the take's timing, so the lips stay in sync
//
// Chosen from the providers' current docs: Omni generates audio with the
// video, speech included, from a quoted line with a named speaker, and takes
// image references in the same request; lip sync holds best for one speaker
// and short lines (under about 6 s), which is why the coverage plans one
// line per shot (lib/movie/coverage.mjs). Kling (the film's clip fallback)
// makes no sound, so it is never used for a movie shot: with no engine left
// that can show a character speaking, the shoot stops (no_speech_engine)
// rather than deliver a silent movie.
//
// Client movies: only steps whose registry licence is commercial_ok
// (lib/router/chains.mjs chainPlan with clientWork), and only voices cleared
// for client work (lib/film/voices.mjs). Provider names stay in this file
// and in server logs.

import { chainPlan, emptyPlanReason } from '../router/chains.mjs';
import { EngineError, filmTextKeys, elevenLabsVoiceConfig, pcmToWav } from '../film/providers.mjs';
import { INTERACTIONS_URL, googleVideoFetch, videoFromInteraction, engineErrorText, videoModel } from '../videoJobs.mjs';
import { mediaFailureKind, retryAfterMs, sendWithThrottleRetry, recordUsage, TASKS, budgetAllows } from '../aiRouter.mjs';
import { providerErrorText } from '../upstreamFailure.mjs';
import { engineCostUsd } from '../capabilities/registry.mjs';

export const MOVIE_RESOLUTION = '1080p';
export const ELEVENLABS_STS_URL = 'https://api.elevenlabs.io/v1/speech-to-speech';
export const DEFAULT_STS_MODEL = 'eleven_multilingual_sts_v2';
// The Creator plan's speech format (pcm_44100 needs the Pro plan).
export const STS_FORMAT = 'pcm_24000';
export const STS_SAMPLE_RATE = 24000;
const SAFETY_RE = /\bnsfw\b|\bsafety\b|flagged|content\s+(?:policy|filter|moderation)|sensitive/i;

export function clipPerSecondUsd() {
  return engineCostUsd('video_gemini_1080', { seconds: 1 });
}

// The env a movie's chains are planned over (the paid Gemini key only, never
// the free one; ElevenLabs; PG1_* budgets).
function movieEnv(env = {}) {
  const routed = {};
  for (const [name, v] of Object.entries(env)) if (/^PG1_/.test(name)) routed[name] = v;
  return Object.assign(routed, { GEMINI_API_KEY_PAID: filmTextKeys(env).geminiPaid, ELEVENLABS_API_KEY: elevenLabsVoiceConfig(env).apiKey });
}

// The usable steps for a movie: { clips, sts } (each [{ provider, key,
// model, licence }]) and why a chain is empty, in PG1's words.
export function moviePlan(env = {}, { clientWork = false, now = Date.now() } = {}) {
  const e = movieEnv(env);
  const clips = chainPlan('movie_dialogue_clips', { env: e, clientWork, now });
  const sts = chainPlan('speech_to_speech', { env: e, clientWork, now });
  return {
    clips: clips.steps, sts: sts.steps,
    clipsWhy: emptyPlanReason(clips, { clientWork }), stsWhy: emptyPlanReason(sts, { clientWork })
  };
}

async function inline(link, fetchImpl) {
  const url = typeof link === 'function' ? await link() : link;
  if (!url) return null;
  const res = await fetchImpl(url);
  if (!res.ok) throw new EngineError('engine', 'a reference image could not be read', { detail: `reference download ${res.status}` });
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png';
  return { data: buf.toString('base64'), mime };
}

// The Interactions request for one movie shot: the prompt, the clip length,
// then each reference image after a line naming what it shows.
export function dialogueClipBody({ model, prompt, seconds, refs = [] }) {
  const input = [{ type: 'text', text: `${String(prompt).slice(0, 3800)}\n\nClip length: ${seconds} seconds.` }];
  for (const r of refs) {
    if (!r || !r.data) continue;
    input.push({ type: 'text', text: `Reference image (${r.label}): keep this exactly as shown.` }, { type: 'image', data: r.data, mime_type: r.mime });
  }
  return { model, input, response_format: { type: 'video', resolution: MOVIE_RESOLUTION, aspect_ratio: '16:9', delivery: 'uri' }, background: false };
}

// One shot. refs: [{ label, url }] (signed links to the bible's reference
// images). Resolves to { bytes, engine, costUsd }.
export async function dialogueClip({ env = {}, prompt, seconds, refs = [], clientWork = false, fetchImpl = globalThis.fetch, sleep, onThrottle, now = () => Date.now(), timeoutMs = 10 * 60 * 1000 }) {
  const plan = moviePlan(env, { clientWork, now: now() });
  const step = plan.clips[0];
  if (!step) throw Object.assign(new EngineError('not_configured', 'no engine can show characters speaking', { notStarted: true, licence: clientWork, detail: plan.clipsWhy }), { code: 'no_speech_engine' });
  if (!budgetAllows(env, step.provider)) throw new EngineError('budget', "today's AI budget for this engine is reached", { notStarted: true, engine: step.provider });
  const model = videoModel(env);
  const images = [];
  for (const r of refs) images.push({ label: r.label, ...(await inline(r.url, fetchImpl)) });
  const payload = JSON.stringify(dialogueClipBody({ model, prompt, seconds, refs: images }));
  const sent = await sendWithThrottleRetry(async () => {
    const res = await googleVideoFetch(fetchImpl, INTERACTIONS_URL, { method: 'POST', key: step.key, headers: { 'Content-Type': 'application/json' }, body: payload, cache: 'no-store' }, timeoutMs);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    const r = { res, json, text };
    if (!res.ok && mediaFailureKind(res.status, text) === 'throttled') return { throttled: true, waitMs: retryAfterMs({ headers: res.headers, text, now: now() }), r };
    return r;
  }, { ...(sleep ? { sleep } : {}), ...(onThrottle ? { onThrottle } : {}) });
  const { res, json, text } = sent.outcome.r || sent.outcome;
  if (!res.ok) {
    const k = mediaFailureKind(res.status, text);
    throw new EngineError(k === 'throttled' ? 'throttled' : k === 'billing' ? 'billing' : 'engine', 'the shot could not be made', { status: res.status, engine: 'gemini_paid', refused: k === 'refused', notStarted: true, detail: `gemini ${model} movie shot ${engineErrorText(res.status, json, text)}` });
  }
  const found = videoFromInteraction(json);
  if (!found || (json && json.status && json.status !== 'completed')) {
    const why = engineErrorText(null, json, text);
    throw new EngineError('engine', 'the shot could not be made', { engine: 'gemini_paid', refused: SAFETY_RE.test(why), detail: `gemini ${model} movie shot ${(json && json.status) || 'no video'}: ${why}` });
  }
  let bytes;
  if (found.data) bytes = Buffer.from(found.data, 'base64');
  else {
    const dl = await googleVideoFetch(fetchImpl, found.uri, { key: step.key }, 300000);
    if (!dl.ok) throw new EngineError('engine', 'the shot could not be fetched', { engine: 'gemini_paid', status: dl.status, detail: `gemini movie shot download ${dl.status}` });
    bytes = Buffer.from(await dl.arrayBuffer());
  }
  if (!bytes.length) throw new EngineError('engine', 'the shot came back empty', { engine: 'gemini_paid', detail: 'gemini movie shot empty' });
  const costUsd = engineCostUsd('video_gemini_1080', { seconds });
  recordUsage({ provider: 'gemini_paid', model, task: TASKS.MEDIA, dataClass: clientWork ? 'customer' : 'operator', unit: 'video_gemini_1080', costUsd }, { env });
  return { bytes, engine: 'gemini_paid', costUsd };
}

// One take's audio (a WAV) in the cast voice. Resolves to { wav, engine,
// costUsd, sampleRate }: the converted speech, as long as the take's audio.
export async function speechToSpeech({ env = {}, audio, voiceId, seconds = null, clientWork = false, fetchImpl = globalThis.fetch, timeoutMs = 120000 }) {
  const plan = moviePlan(env, { clientWork });
  const step = plan.sts[0];
  if (!step) throw new EngineError('not_configured', 'no voice engine is cleared for this movie', { notStarted: true, engine: 'elevenlabs', licence: clientWork, detail: plan.stsWhy });
  if (!voiceId) throw new EngineError('engine', 'the character has no cast voice', { notStarted: true, engine: 'elevenlabs', detail: 'speech-to-speech without a voice id' });
  const model = String(env.PG1_MOVIE_STS_MODEL || '').trim() || DEFAULT_STS_MODEL;
  const form = new FormData();
  form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'take.wav');
  form.append('model_id', model);
  form.append('remove_background_noise', 'true');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  let res;
  try {
    res = await fetchImpl(`${ELEVENLABS_STS_URL}/${encodeURIComponent(voiceId)}?output_format=${STS_FORMAT}`, { method: 'POST', headers: { 'xi-api-key': step.key }, body: form, signal: controller.signal });
  } catch (e) {
    throw new EngineError(controller.signal.aborted ? 'timeout' : 'network', 'the line could not be voiced', { engine: 'elevenlabs', detail: `elevenlabs sts ${controller.signal.aborted ? 'timed out' : `network: ${e && e.message}`}` });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const k = mediaFailureKind(res.status, body);
    throw new EngineError(k === 'billing' ? 'billing' : k === 'throttled' ? 'throttled' : k === 'refused' ? 'refused' : 'engine', 'the line could not be voiced', { status: res.status, engine: 'elevenlabs', notStarted: true, refused: k === 'refused', detail: `elevenlabs sts ${providerErrorText(res.status, body)}` });
  }
  const pcm = Buffer.from(await res.arrayBuffer());
  if (!pcm.length) throw new EngineError('engine', 'the line came back empty', { engine: 'elevenlabs', detail: 'elevenlabs sts returned no audio' });
  const costUsd = engineCostUsd('sts_elevenlabs', { seconds: seconds || pcm.length / 2 / STS_SAMPLE_RATE });
  recordUsage({ provider: 'elevenlabs', model, task: TASKS.TTS, dataClass: clientWork ? 'customer' : 'operator', unit: 'sts_elevenlabs', costUsd }, { env });
  return { wav: pcmToWav(pcm, STS_SAMPLE_RATE), engine: 'elevenlabs', costUsd, sampleRate: STS_SAMPLE_RATE };
}
