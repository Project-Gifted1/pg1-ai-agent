// The /image engines, behind brand-neutral names.
//
// PG1 shows no third-party branding (lib/identity.mjs, lib/upstreamFailure.mjs),
// and the image path is no exception: whichever engine renders the picture,
// the reply and the live trace only ever say "PG1 Vision Primary",
// "Secondary" or "Tertiary". A failed attempt (provider, model, key slot,
// HTTP status, the provider's own words) goes to the operator's error log
// through `onAttemptFailed`, never into the reply or a trace row.
//
// Engines, tried in order, each across every configured key:
//   primary   PG1_IMAGE_MODEL_PRIMARY,   default gemini-3.1-flash-image
//   secondary PG1_IMAGE_MODEL_SECONDARY, default gemini-3-pro-image
//   tertiary  PG1_IMAGE_MODEL_TERTIARY,  default black-forest-labs/flux-schnell
// The first two are Gemini API models called through generateContent with
// an IMAGE response modality. Imagen 4 (imagen-4.0-*-001, the old primary,
// called through :predict) was shut down on the Gemini API on 2026-08-17,
// which is why every call to it now returns 404; gemini-3.1-flash-image is
// Google's listed replacement. A model ID starting with "imagen-" is still
// sent to :predict, so an operator can point an env var at one if Google
// ships another.
//
// Circuit breaker: a 404 (model gone) or 429 (quota) from an engine on a
// given key skips that engine/key pair for BREAKER_WINDOW_MS, so the next
// request goes straight to one that works instead of spending its time
// budget on known failures. The state is per server instance (module-level),
// which is all a short skip window needs.

export const ENGINE_LABELS = Object.freeze({
  primary: 'PG1 Vision Primary',
  secondary: 'PG1 Vision Secondary',
  tertiary: 'PG1 Vision Tertiary'
});

export const DEFAULT_IMAGE_MODELS = Object.freeze({
  primary: 'gemini-3.1-flash-image',
  secondary: 'gemini-3-pro-image',
  tertiary: 'black-forest-labs/flux-schnell'
});

export const BREAKER_WINDOW_MS = 15 * 60 * 1000;
export const BREAKER_STATUSES = Object.freeze([404, 429]);

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TERTIARY_API_BASE = 'https://api.replicate.com/v1/models';

// One image takes several seconds to render; the old 8 s cap aborted
// working requests ("This operation was aborted").
const GEMINI_ATTEMPT_TIMEOUT_MS = 25000;
const TERTIARY_CREATE_TIMEOUT_MS = 25000;

export function imageModels(env = {}) {
  const pick = (name, fallback) => {
    const v = typeof env[name] === 'string' ? env[name].trim() : '';
    return v || fallback;
  };
  return {
    primary: pick('PG1_IMAGE_MODEL_PRIMARY', DEFAULT_IMAGE_MODELS.primary),
    secondary: pick('PG1_IMAGE_MODEL_SECONDARY', DEFAULT_IMAGE_MODELS.secondary),
    tertiary: pick('PG1_IMAGE_MODEL_TERTIARY', DEFAULT_IMAGE_MODELS.tertiary)
  };
}

// --- circuit breaker -----------------------------------------------------------

const openUntil = new Map();

function breakerKey(slot, model, keyIndex) {
  return `${slot}|${model}|${keyIndex}`;
}

export function isEngineSkipped(slot, model, keyIndex, now = Date.now()) {
  const until = openUntil.get(breakerKey(slot, model, keyIndex));
  if (until === undefined) return false;
  if (now >= until) {
    openUntil.delete(breakerKey(slot, model, keyIndex));
    return false;
  }
  return true;
}

function tripIfNeeded(slot, model, keyIndex, status, now) {
  if (BREAKER_STATUSES.includes(status)) openUntil.set(breakerKey(slot, model, keyIndex), now + BREAKER_WINDOW_MS);
}

// Exposed for tests only, same reasoning as api/chat.mjs's
// __clearAuthRateLimitState.
export function __resetImageBreaker() {
  openUntil.clear();
}

// --- the engines ---------------------------------------------------------------

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
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch (e) {
    return { json: null, text };
  }
}

// Gemini API model (generateContent) or, for an imagen-* ID, :predict. The
// key goes in the x-goog-api-key header rather than the URL, so it can never
// echo back inside an exception message that quotes the URL.
async function callGeminiImage(fetchImpl, model, key, prompt, timeoutMs) {
  const isPredict = /^imagen-/i.test(model);
  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:${isPredict ? 'predict' : 'generateContent'}`;
  const body = isPredict
    ? { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '16:9' } }
    : {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } }
    };
  const res = await fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    cache: 'no-store'
  }, timeoutMs);
  const { json, text } = await readBody(res);
  if (res.ok && json) {
    if (isPredict) {
      const p = Array.isArray(json.predictions) && json.predictions[0];
      if (p && p.bytesBase64Encoded) return { ok: true, mime: p.mimeType || 'image/png', base64: p.bytesBase64Encoded };
    } else {
      const parts = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
      const part = Array.isArray(parts) && parts.find((p) => p && p.inlineData && p.inlineData.data);
      if (part) return { ok: true, mime: part.inlineData.mimeType || 'image/png', base64: part.inlineData.data };
    }
    return { ok: false, status: res.status, message: `no image in response: ${text.slice(0, 200)}` };
  }
  return { ok: false, status: res.status, message: text.slice(0, 200) };
}

// Hosted model (create a prediction, then poll its status URL).
async function callTertiary(fetchImpl, model, token, prompt, deadlineTs, sleep) {
  const remainingS = Math.floor((deadlineTs - Date.now()) / 1000);
  const waitS = Math.max(1, Math.min(20, remainingS - 2));
  const createRes = await fetchWithTimeout(fetchImpl, `${TERTIARY_API_BASE}/${model}/predictions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Prefer': `wait=${waitS}` },
    body: JSON.stringify({ input: { prompt } })
  }, Math.min(TERTIARY_CREATE_TIMEOUT_MS, deadlineTs - Date.now()));
  const { json: created, text } = await readBody(createRes);
  if (!createRes.ok || !created) return { ok: false, status: createRes.status, message: text.slice(0, 200) };

  let prediction = created;
  const pollUrl = created.urls && created.urls.get;
  while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled') {
    if (!pollUrl || Date.now() >= deadlineTs - 1500) {
      return { ok: false, status: null, message: 'timed out waiting for the prediction' };
    }
    await sleep(1500);
    const pollRes = await fetchWithTimeout(fetchImpl, pollUrl, { headers: { 'Authorization': `Bearer ${token}` } }, Math.min(8000, deadlineTs - Date.now()));
    const polled = await readBody(pollRes);
    if (!pollRes.ok || !polled.json) return { ok: false, status: pollRes.status, message: polled.text.slice(0, 200) };
    prediction = polled.json;
  }
  if (prediction.status !== 'succeeded') {
    return { ok: false, status: null, message: `${prediction.status}: ${JSON.stringify(prediction.error || '').slice(0, 180)}` };
  }
  const out = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (typeof out !== 'string' || !/^https:\/\//.test(out)) return { ok: false, status: null, message: 'no image URL in output' };
  return { ok: true, remoteUrl: out };
}

const PROVIDER = { primary: 'google', secondary: 'google', tertiary: 'replicate' };

// Runs the engines in order until one returns an image.
//
//   prompt          the text sent to the engine
//   geminiKeys      keys for the primary/secondary engines, in order
//   tertiaryToken   token for the tertiary engine ('' skips it)
//   env             process.env (model IDs)
//   fetchImpl       fetch to use
//   storeImage      async ({ mime, base64 }) => url to show; called with the
//                   rendered bytes (the handler uploads them to the vault)
//   storeRemote     async (url) => url to show; called with the tertiary
//                   engine's output URL (the handler re-hosts it)
//   onAttemptFailed ({ slot, provider, model, keyIndex, status, message })
//                   - operator-only detail, for the error log
//   budgetMs        total time budget
//
// Resolves to { ok: true, url, slot, label } or { ok: false, attempts }.
// Never throws: an exception inside an attempt is that attempt's failure.
export async function generateImage({
  prompt, geminiKeys = [], tertiaryToken = '', env = {}, fetchImpl = globalThis.fetch,
  storeImage, storeRemote, onAttemptFailed = () => {}, budgetMs = 45000,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms))
} = {}) {
  const models = imageModels(env);
  const deadlineTs = Date.now() + budgetMs;
  let attempts = 0;

  const fail = (slot, model, keyIndex, status, message) => {
    tripIfNeeded(slot, model, keyIndex, status, now());
    try {
      onAttemptFailed({ slot, provider: PROVIDER[slot], model, keyIndex, status: status == null ? null : status, message: String(message || 'no detail') });
    } catch (e) {
      // logging never breaks the image path
    }
  };

  for (const slot of ['primary', 'secondary']) {
    const model = models[slot];
    for (let k = 0; k < geminiKeys.length; k++) {
      if (Date.now() >= deadlineTs - 1000) break;
      if (isEngineSkipped(slot, model, k + 1, now())) continue;
      attempts++;
      try {
        const r = await callGeminiImage(fetchImpl, model, geminiKeys[k], prompt, Math.min(GEMINI_ATTEMPT_TIMEOUT_MS, deadlineTs - Date.now()));
        if (r.ok) {
          const url = storeImage ? await storeImage({ mime: r.mime, base64: r.base64 }) : `data:${r.mime};base64,${r.base64}`;
          return { ok: true, url, slot, label: ENGINE_LABELS[slot] };
        }
        fail(slot, model, k + 1, r.status, r.message);
      } catch (e) {
        fail(slot, model, k + 1, null, (e && e.name === 'AbortError') ? 'timed out' : (e && e.message));
      }
    }
  }

  const tertiaryModel = models.tertiary;
  if (tertiaryToken && Date.now() < deadlineTs - 2000 && !isEngineSkipped('tertiary', tertiaryModel, 1, now())) {
    attempts++;
    try {
      const r = await callTertiary(fetchImpl, tertiaryModel, tertiaryToken, prompt, deadlineTs, sleep);
      if (r.ok) {
        const url = storeRemote ? await storeRemote(r.remoteUrl) : r.remoteUrl;
        return { ok: true, url, slot: 'tertiary', label: ENGINE_LABELS.tertiary };
      }
      fail('tertiary', tertiaryModel, 1, r.status, r.message);
    } catch (e) {
      fail('tertiary', tertiaryModel, 1, null, (e && e.name === 'AbortError') ? 'timed out' : (e && e.message));
    }
  }

  return { ok: false, attempts };
}
