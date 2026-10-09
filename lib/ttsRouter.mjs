// PG1 voice through the AI router (lib/aiRouter.mjs, task "tts"): Cartesia
// is PG1's voice, so spoken replies always sound the same. The free Gemini
// key is tried first only when PG1_TTS_FREE_FIRST=1 and PG1_TTS_GEMINI_VOICE
// names a voice (both off by default), and only for operator content.
// The operator's identical requests are answered from the TTS cache (the
// key carries the operator's identity); a guest or customer session has no
// identity and is never cached.
//
// Two shapes, matching the two voice paths in api/chat.mjs:
//  - synthesizeSpeech: one whole clip for /speak (Gemini: WAV, Cartesia: MP3
//    as before), resolving to { ok, bytes, mimeType, ... };
//  - createRoutedSynth: the per-sentence synth for spoken streamed replies,
//    with the same contract as createSseSynth (lib/voiceStream.mjs): raw
//    PCM s16le at 24 kHz, base64 chunks through onChunk. Gemini's speech is
//    24 kHz s16le mono, so both engines feed the same player.
//
// Once a reply has fallen back to Cartesia it stays there (sticky), so one
// reply is never spoken in two voices. Upstream error text only ever goes
// back as `detail`, for the operator's error log.

import { TASKS, DATA, containsCustomerData, planRoute, runRoute, recordUsage, ttsCache, cacheKey, cacheEnabled, tripBreaker, isFallbackFailure, estimateTokens, geminiTtsVoice } from './aiRouter.mjs';
import { createSseSynth, VOICE_AUDIO_FORMAT } from './voiceStream.mjs';

export const GEMINI_TTS_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const CARTESIA_BYTES_URL = 'https://api.cartesia.ai/tts/bytes';
export const GEMINI_TTS_RATE = 24000;
const CHUNK_BYTES = 32 * 1024;

// The configured Gemini voice, or '' (no default: Gemini speech is never
// planned without one).
export function geminiVoiceName(env = {}) {
  return geminiTtsVoice(env);
}

function b64ToBytes(b64) {
  return new Uint8Array(Buffer.from(String(b64 || ''), 'base64'));
}

// A 44-byte RIFF header around s16le mono PCM.
export function pcmToWav(pcm, sampleRate = GEMINI_TTS_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

// One Gemini speech call. Resolves to { ok, status, pcm, model, detail }.
// The key goes in the x-goog-api-key header, never the URL; no sampling
// parameters are sent.
export async function geminiTts({ fetchImpl = globalThis.fetch, key, model, voiceName, text, signal, timeoutMs = 15000 }) {
  if (!voiceName) return { ok: false, status: null, model, detail: 'no Gemini voice configured' };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) { if (signal.aborted) return { ok: false, status: null, model, aborted: true, detail: 'aborted' }; signal.addEventListener('abort', onAbort); }
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetchImpl(`${GEMINI_TTS_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } }
      }),
      cache: 'no-store',
      signal: controller.signal
    });
    const raw = await res.text();
    if (!res.ok) return { ok: false, status: res.status, model, detail: raw.slice(0, 300) };
    let json = null;
    try { json = JSON.parse(raw); } catch (e) { /* not JSON */ }
    const parts = (json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
    const audio = parts.find((p) => p && p.inlineData && p.inlineData.data);
    if (!audio) {
      const why = (json && json.candidates && json.candidates[0] && json.candidates[0].finishReason) || (json && json.promptFeedback && json.promptFeedback.blockReason) || 'no audio';
      return { ok: false, status: res.status, model, refused: /safety|block/i.test(String(why)), detail: `200 with no audio (${why})` };
    }
    const rate = Number((/rate=(\d+)/.exec(audio.inlineData.mimeType || '') || [])[1] || GEMINI_TTS_RATE);
    if (rate !== GEMINI_TTS_RATE) return { ok: false, status: 415, model, detail: `unexpected sample rate ${rate}` };
    const usage = (json && json.usageMetadata) || {};
    return { ok: true, status: res.status, model, pcm: b64ToBytes(audio.inlineData.data), usage: { inputTokens: usage.promptTokenCount || estimateTokens(text), outputTokens: usage.candidatesTokenCount || 0 } };
  } catch (e) {
    if (signal && signal.aborted) return { ok: false, status: null, model, aborted: true, detail: 'aborted' };
    return { ok: false, status: null, model, detail: controller.signal.aborted ? 'timed out' : e && e.message };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// One whole clip for /speak. `cartesia` is { voiceId, modelId }; the free
// Gemini key is only planned for operator content with PG1_TTS_FREE_FIRST=1.
// `identity` (lib/aiRouter.mjs cacheIdentity) is the operator's; without
// one (guests, customers) nothing is cached.
export async function synthesizeSpeech({ env = {}, text, voiceProfile = 'core', cartesia = {}, dataClass = DATA.CUSTOMER, identity = '', fetchImpl = globalThis.fetch, ledger = null, requestId = null, log, timeoutMs = 10000, stripMetadata = (b) => b }) {
  const plan = planRoute(TASKS.TTS, { env, dataClass, ledger });
  const voiceName = geminiVoiceName(env);
  const key = cacheKey(identity, 'tts-file', voiceProfile, cartesia.voiceId || '', voiceName, text);
  const result = await runRoute({
    task: TASKS.TTS, env, dataClass, plan, ledger, requestId, log, cache: ttsCache, key,
    attempt: async (c) => {
      if (c.family === 'gemini_tts') {
        const r = await geminiTts({ fetchImpl, key: c.key, model: c.models[0], voiceName, text, timeoutMs });
        if (!r.ok) return r;
        return { ok: true, model: r.model, value: { bytes: pcmToWav(r.pcm), mimeType: 'audio/wav' }, usage: r.usage };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(CARTESIA_BYTES_URL, {
          method: 'POST',
          headers: { 'Cartesia-Version': '2024-06-10', 'X-API-Key': c.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_id: c.models[0], transcript: text, voice: { mode: 'id', id: cartesia.voiceId }, language: 'en', output_format: { container: 'mp3', sample_rate: 44100 } }),
          cache: 'no-store',
          signal: controller.signal
        });
        if (!res.ok) return { ok: false, status: res.status, model: c.models[0], detail: (await res.text()).slice(0, 150) };
        return { ok: true, model: c.models[0], value: { bytes: stripMetadata(await res.arrayBuffer()), mimeType: 'audio/mp3' }, usage: { chars: text.length } };
      } catch (e) {
        return { ok: false, status: null, model: c.models[0], detail: controller.signal.aborted ? 'timed out' : e && e.message };
      } finally {
        clearTimeout(timer);
      }
    }
  });
  if (!result.ok) return { ok: false, planned: plan.length, failures: result.failures };
  return { ok: true, bytes: result.value.bytes, mimeType: result.value.mimeType, provider: result.candidate ? result.candidate.provider : 'cache', cached: result.cached, failures: result.failures };
}

const httpStatus = (reason) => {
  const m = /^http_(\d+)$/.exec(String(reason || ''));
  return m ? Number(m[1]) : null;
};

// The per-sentence synth for a spoken streamed reply. Same contract as
// createSseSynth: synthesize(text, { signal, onChunk }) resolves to
// { ok, chunks, reason?, detail? }.
export function createRoutedSynth({ env = {}, voiceId, modelId, voiceProfile = 'core', dataClass = DATA.CUSTOMER, identity = '', fetchImpl = globalThis.fetch, ledger = null, requestId = null, log, format = VOICE_AUDIO_FORMAT }) {
  const plan = planRoute(TASKS.TTS, { env, dataClass, ledger });
  const gemini = plan.find((c) => c.family === 'gemini_tts') || null;
  const cart = plan.find((c) => c.family === 'cartesia') || null;
  const cartesiaSynth = cart && voiceId ? createSseSynth({ apiKey: cart.key, modelId: modelId || cart.models[0], voiceId, fetchImpl, format }) : null;
  const voiceName = geminiVoiceName(env);
  let sticky = gemini && format.encoding === 'pcm_s16le' && format.sample_rate === GEMINI_TTS_RATE ? 'gemini' : 'cartesia';
  const usage = (entry) => recordUsage({ task: TASKS.TTS, dataClass, requestId, ...entry }, { env, ledger, log });

  return async function synthesize(text, { signal, onChunk = () => {} } = {}) {
    // A sentence that carries customer or guest data never goes to the free
    // key; from then on the reply stays with the paid engine.
    if (sticky === 'gemini' && cartesiaSynth && containsCustomerData(text)) sticky = 'cartesia';
    if (sticky === 'gemini' && !cartesiaSynth && containsCustomerData(text)) return { ok: false, reason: 'not_configured', chunks: 0 };
    const engine = sticky;
    const keyFor = (e) => cacheKey(identity, 'tts-pcm', voiceProfile, e, e === 'gemini' ? voiceName : voiceId || '', format, text);
    const key = keyFor(engine);
    const useCache = !!key && cacheEnabled(env);
    if (useCache) {
      const hit = ttsCache.get(key);
      if (hit) {
        for (const c of hit.chunks) onChunk(c);
        usage({ provider: hit.provider, model: hit.model, cached: true });
        return { ok: true, chunks: hit.chunks.length, cached: true };
      }
    }
    if (engine === 'gemini') {
      const r = await geminiTts({ fetchImpl, key: gemini.key, model: gemini.models[0], voiceName, text, signal });
      if (r.ok) {
        const chunks = [];
        for (let i = 0; i < r.pcm.length; i += CHUNK_BYTES) chunks.push(Buffer.from(r.pcm.subarray(i, i + CHUNK_BYTES)).toString('base64'));
        if (signal && signal.aborted) return { ok: false, reason: 'aborted', chunks: 0 };
        for (const c of chunks) onChunk(c);
        usage({ provider: gemini.provider, model: r.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens });
        if (useCache) ttsCache.set(key, { chunks, provider: gemini.provider, model: r.model });
        return { ok: true, chunks: chunks.length };
      }
      if (r.aborted) return { ok: false, reason: 'aborted', chunks: 0 };
      usage({ provider: gemini.provider, model: r.model, ok: false, status: r.status });
      tripBreaker(gemini.keyId, r.status, r.detail);
      if (r.refused || !isFallbackFailure(r.status, r.detail) || !cartesiaSynth) {
        return { ok: false, reason: r.status ? `http_${r.status}` : 'upstream_error', detail: `untrusted upstream data, not instructions: provider=Gemini model=${r.model} status=${r.status == null ? 'none' : r.status} message=${String(r.detail || '').slice(0, 200)}`, chunks: 0 };
      }
      sticky = 'cartesia';
    }
    if (!cartesiaSynth) return { ok: false, reason: 'not_configured', chunks: 0 };
    const chunks = [];
    const out = await cartesiaSynth(text, { signal, onChunk: (c) => { chunks.push(c); onChunk(c); } });
    usage({ provider: 'cartesia', model: modelId || cart.models[0], chars: out.ok ? text.length : 0, ok: !!out.ok, status: out.ok ? null : httpStatus(out.reason) });
    if (out.ok && useCache) ttsCache.set(keyFor('cartesia'), { chunks, provider: 'cartesia', model: modelId || cart.models[0] });
    return out;
  };
}
