// PG1 Motion: short video clips, rendered in the background.
//
// The operator asks for a clip ("make a video of...", /video <prompt>, or
// the operator-only generate_video chat tool). PG1 reserves one of today's
// slots in the database, starts the job on the video engine and answers at
// once with a "Rendering video…" card. The client then polls a short status
// action (VIDEO_STATUS on /api/chat); when the engine has finished, the clip
// is copied into the vault (pg1-vault/videos/<job id>.mp4) and shown in the
// chat's video player through a signed URL that lasts 7 days.
//
// Engine. gemini-omni-1.1-flash on the Gemini API's Interactions endpoint
// (PG1_VIDEO_MODEL overrides it). Veo is not used: every Veo 3.1 preview
// shuts down on 2026-10-22. The request is
//   POST /v1beta/interactions
//   { model, input, response_format: { type: "video", resolution: "720p",
//     aspect_ratio: "16:9", delivery: "uri" }, background: true }
// with the key in the x-goog-api-key header, never in the URL. background
// (CreateModelInteraction.background in the @google/genai types) makes the
// call return straight away with the interaction's id; GET
// /v1beta/interactions/{id} then reports its status and, once completed,
// the clip in steps[] -> model_output -> content[type=video] (data inline as
// base64, or a uri). input is the prompt text, or [text, image] when the
// operator attached an image to use as the starting frame. Text-to-video and
// a starting frame only: editing or extending an uploaded video is not
// offered (Google does not offer it in the EEA, Switzerland or the UK).
//
// Fallback. Every configured Gemini key in turn (GEMINI_API_KEY1, then
// GEMINI_API_KEY2, then GEMINI_API_KEY), then Replicate, the same order the
// /image engines follow. Only a provider failure moves on: 5xx, 429
// (quota), a timeout or network error, 401/402/403 (auth, billing) or 404
// (model gone). A content-safety refusal never does - another provider
// would route round Google's safety filter - and the operator is told no.
// Whichever provider renders the clip, it is one job row and one slot.
// The fallback is decided when the job starts; a job that fails while
// rendering is not restarted elsewhere.
//
// Tiers and length (lib/videoText.mjs). draft, standard (the default) or
// pro set Google's resolution (360p, 720p, 1080p) and Kling's mode
// (standard, standard, pro); short is 5 s, long is 10 s (default 5 s).
// Google's clip length is set by the prompt, so the length is written into
// it; Kling takes duration 5 or 10. No 4K.
//
// Budget. PG1_VIDEO_DAILY_BUDGET_USD of estimated spend per UTC day
// (default 5.00), plus PG1_VIDEO_DAILY_CAP clips as a hard limit (default
// 10). Before any provider is called, the database function
// pg1_reserve_video_slot reserves the clip's estimate (VIDEO_PRICES, the
// dearest provider that could make it) under an advisory lock per day, so
// two requests at once cannot both spend the last of the budget. A clip
// that fails keeps its reservation; a fallback updates the same row and
// never reserves twice.
//
// Switch. Nothing here runs unless PG1_VIDEO_ENABLED=1. Only the signed-in
// operator can ask for a clip; guests never can.
//
// Branding. The reply, the trace and the cards only ever say "PG1 Motion".
// The model, the provider and the engine's own error text go to pg1_errors
// under the request ID (onFailure), never into the reply.

import {
  VIDEO_ENGINE_LABEL, VIDEO_TOOL, MAX_VIDEO_PROMPT_CHARS, mentionsVideo, VIDEO_TIERS, VIDEO_TIER_LABELS, VIDEO_TIER_SETTINGS,
  VIDEO_PRICES, VIDEO_DURATIONS, DEFAULT_VIDEO_TIER, DEFAULT_VIDEO_DURATION_S, googleClipCost, klingClipCost, videoClipEstimate,
  parseVideoOptions, videoCostLine, videoOverBudgetText, videoClipLimitText, videoTiersText, cheaperVideoOptions, usd
} from './videoText.mjs';

export {
  VIDEO_ENGINE_LABEL, VIDEO_TOOL, MAX_VIDEO_PROMPT_CHARS, mentionsVideo, VIDEO_TIERS, VIDEO_TIER_LABELS, VIDEO_TIER_SETTINGS,
  VIDEO_PRICES, VIDEO_DURATIONS, DEFAULT_VIDEO_TIER, DEFAULT_VIDEO_DURATION_S, googleClipCost, klingClipCost, videoClipEstimate,
  parseVideoOptions, videoCostLine, videoOverBudgetText, videoClipLimitText, videoTiersText, cheaperVideoOptions, usd
};
export const DEFAULT_VIDEO_MODEL = 'gemini-omni-1.1-flash';
export const DEFAULT_VIDEO_DAILY_CAP = 10;
export const DEFAULT_VIDEO_DAILY_BUDGET_USD = 5.0;
export const DEFAULT_REPLICATE_IMAGE_MODEL = 'kwaivgi/kling-v2.1';
export const VIDEO_JOB_TIMEOUT_MS = 15 * 60 * 1000;
export const VIDEO_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;
export const VIDEO_FRAME_URL_SECONDS = 60 * 60;
export const VIDEO_BUCKET = 'pg1-vault';
export const VIDEO_FOLDER = 'videos';
export const VIDEO_TABLE = 'pg1_video_jobs';
export const VIDEO_RESERVE_RPC = 'pg1_reserve_video_slot';
export function videoResponseFormat(tier = DEFAULT_VIDEO_TIER) {
  return { type: 'video', resolution: (VIDEO_TIER_SETTINGS[tier] || VIDEO_TIER_SETTINGS[DEFAULT_VIDEO_TIER]).googleResolution, aspect_ratio: '16:9', delivery: 'uri' };
}

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GOOGLE_API_HOST = 'generativelanguage.googleapis.com';
const START_TIMEOUT_MS = 20000;
const POLL_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const UPLOAD_TIMEOUT_MS = 20000;
const START_FRAME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// Every key a request to the Interactions endpoint may carry, per object,
// from the @google/genai types (CreateModelInteraction, VideoResponseFormat,
// TextContent, ImageContent). The tests walk the real request body against
// this list, the same way #262 holds the function declarations to
// GEMINI_SCHEMA_KEYS: an unknown field is a 400 for the whole request.
export const INTERACTION_BODY_KEYS = Object.freeze({
  request: Object.freeze(['model', 'input', 'response_format', 'background']),
  response_format: Object.freeze(['type', 'resolution', 'aspect_ratio', 'delivery']),
  text: Object.freeze(['type', 'text']),
  image: Object.freeze(['type', 'data', 'mime_type'])
});

// --- configuration -------------------------------------------------------------

export function videoEnabled(env = {}) {
  return String(env.PG1_VIDEO_ENABLED == null ? '' : env.PG1_VIDEO_ENABLED).trim() === '1';
}

export function videoModel(env = {}) {
  const v = typeof env.PG1_VIDEO_MODEL === 'string' ? env.PG1_VIDEO_MODEL.trim() : '';
  return v || DEFAULT_VIDEO_MODEL;
}

// The hard clip limit: a whole number of clips, 0 or more. Anything
// unreadable is the default.
export function videoDailyCap(env = {}) {
  const raw = String(env.PG1_VIDEO_DAILY_CAP == null ? '' : env.PG1_VIDEO_DAILY_CAP).trim();
  if (!/^\d{1,3}$/.test(raw)) return DEFAULT_VIDEO_DAILY_CAP;
  return Number(raw);
}

// The daily estimated-spend budget in USD, 0 or more, cents at most.
// Anything unreadable is the default.
export function videoDailyBudget(env = {}) {
  const raw = String(env.PG1_VIDEO_DAILY_BUDGET_USD == null ? '' : env.PG1_VIDEO_DAILY_BUDGET_USD).trim();
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(raw)) return DEFAULT_VIDEO_DAILY_BUDGET_USD;
  return Number(raw);
}

// --- recognising a request -----------------------------------------------------

// "make a video of...", "generate a short 10 second clip showing...",
// "animate this photo", "/video ...". Deliberately narrow: each match spends
// a paid slot. A bare "animate" (an animated discussion, inanimate, animate
// the CSS transition) is not a request, and nor is a question about making
// videos ("how do I make a video of my screen?") or another use of the word
// ("make the video player load faster", "summarise this video").
const VIDEO_VERB = '(?:make|create|generate|render|produce|film|shoot)';
const VIDEO_ADJ = '(?:short|long|longer|quick|draft|cheap|pro|high[- ]?quality|high|quality|full|hd|hq|720p|1080p|4k|little|brief|small|cinematic|slow[- ]?motion|realistic|animated|looping|cool|fun|new|simple|\\d{1,2}[- ]?(?:s|sec|secs|second|seconds))';
const VIDEO_NOUN = '(?:video|clip|animation)';
const VIDEO_REQUEST_RE = new RegExp(
  `\\b${VIDEO_VERB}\\s+(?:(?:me|us)\\s+)?(?:(?:a|an|one|another)\\s+)?(?:${VIDEO_ADJ}[\\s,]+){0,4}${VIDEO_NOUN}\\s*(?:$|[:\\-–—]|(?:of|showing|that\\s+shows|where|in\\s+which|with)\\b)`,
  'i'
);
const ANIMATE_IMAGE_RE = /\banimate\s+(?:this|the|my|that|an?|attached)\s+(?:(?:attached|uploaded)\s+)?(?:image|picture|photo|pic|frame|drawing|illustration|logo|still|screenshot)\b/i;
const IMAGE_TO_VIDEO_RE = /\b(?:turn|make)\s+(?:this|the|my|that)\s+(?:image|picture|photo|pic)\s+into\s+(?:a\s+)?(?:video|clip|animation)\b/i;
const HOW_TO_RE = /\bhow\s+(?:do|can|could|would|should|to|did)\b|\b(?:tutorial|guide|tips?|advice)\b/i;

export function isVideoCommand(text) {
  return /^\/video(?:\s|$)/i.test(String(text || '').trim());
}

export function isVideoRequest(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (isVideoCommand(t)) return true;
  if (HOW_TO_RE.test(t)) return false;
  return VIDEO_REQUEST_RE.test(t) || ANIMATE_IMAGE_RE.test(t) || IMAGE_TO_VIDEO_RE.test(t);
}

// The scene to render: the operator's words without the command or the
// request phrasing. '' when nothing is left.
export function cleanVideoPrompt(text) {
  let t = String(text || '').trim().replace(/^\/video\b[:\s]*/i, '');
  // The tier and length words go too: they are read by parseVideoOptions
  // and sent as settings (and, for Google, as "Clip length: N seconds").
  t = t.replace(new RegExp(`^(?:please\\s+|can\\s+you\\s+|could\\s+you\\s+|pg1,?\\s+)*${VIDEO_VERB}\\s+(?:(?:me|us)\\s+)?(?:(?:a|an|one|another)\\s+)?(?:${VIDEO_ADJ}[\\s,]+){0,4}${VIDEO_NOUN}\\s*(?:of|showing|that\\s+shows|where|in\\s+which|with)?[:\\s\\-–—]*`, 'i'), '');
  t = t.replace(/^(?:please\s+)?animate\s+(?:this|the|my|that|an?|attached)\s+(?:(?:attached|uploaded)\s+)?(?:image|picture|photo|pic|frame|drawing|illustration|logo|still|screenshot)\b[,:\s-]*/i, '');
  t = t.replace(/^(?:please\s+)?(?:turn|make)\s+(?:this|the|my|that)\s+(?:image|picture|photo|pic)\s+into\s+(?:a\s+)?(?:video|clip|animation)\b[,:\s-]*/i, '');
  t = t.replace(/[\s?!.]+$/, '').trim();
  return t.slice(0, MAX_VIDEO_PROMPT_CHARS);
}

export const DEFAULT_START_FRAME_PROMPT = 'Bring this image to life with gentle, natural motion and a slow camera move.';

// --- the request ---------------------------------------------------------------

// The body PG1 sends to start a job. `image` is an optional starting frame:
// { mimeType, data } (base64), PNG, JPEG or WebP. The tier sets the
// resolution; the length goes into the prompt, which is what sets a
// Gemini clip's length.
export function buildVideoRequestBody({ model, prompt, image = null, tier = DEFAULT_VIDEO_TIER, durationS = DEFAULT_VIDEO_DURATION_S } = {}) {
  const text = `${String(prompt || '').slice(0, MAX_VIDEO_PROMPT_CHARS)}\n\nClip length: ${durationS === 10 ? 10 : 5} seconds.`;
  const frame = image && START_FRAME_TYPES.has(String(image.mimeType || '').toLowerCase()) && typeof image.data === 'string' && image.data
    ? { type: 'image', data: image.data, mime_type: String(image.mimeType).toLowerCase() }
    : null;
  return {
    model,
    input: frame ? [{ type: 'text', text }, frame] : text,
    response_format: videoResponseFormat(tier),
    background: true
  };
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

async function readBody(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch (e) {
    return { json: null, text };
  }
}

// The engine's own words for a failed request or job, for the error log.
export function engineErrorText(status, json, text) {
  const j = json && typeof json === 'object' ? json : null;
  const pieces = [];
  if (j && j.error && typeof j.error === 'object' && j.error.message) pieces.push(`${j.error.status || j.error.code || ''} ${j.error.message}`.trim());
  if (j && Array.isArray(j.errors)) for (const e of j.errors) if (e && e.message) pieces.push(`${e.code || ''} ${e.message}`.trim());
  if (j && Array.isArray(j.steps)) for (const s of j.steps) if (s && s.error && s.error.message) pieces.push(`${s.error.code || ''} ${s.error.message}`.trim());
  const body = pieces.length ? pieces.join('; ') : String(text || '').slice(0, 240);
  const flat = `${status == null ? '' : status + ': '}${body}`.replace(/\s+/g, ' ').trim();
  return flat.length > 240 ? flat.slice(0, 239) + '…' : flat;
}

// The clip in a finished interaction: { data, uri, mimeType } or null.
// Reads the REST shape (steps[] -> model_output -> content[type=video]) and
// the SDK's output_video convenience field.
export function videoFromInteraction(json) {
  if (!json || typeof json !== 'object') return null;
  const pick = (c) => (c && c.type === 'video' && (c.data || c.uri) ? { data: c.data || null, uri: c.uri || null, mimeType: c.mime_type || 'video/mp4' } : null);
  const steps = Array.isArray(json.steps) ? json.steps : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (!s || s.type !== 'model_output' || !Array.isArray(s.content)) continue;
    for (const c of s.content) {
      const v = pick(c);
      if (v) return v;
    }
  }
  if (json.output_video) return pick({ type: 'video', ...json.output_video });
  return null;
}

const DONE_STATUSES = new Set(['completed']);
const FAILED_STATUSES = new Set(['failed', 'cancelled', 'incomplete', 'budget_exceeded', 'requires_action']);

// --- the database (PostgREST, service role) ----------------------------------

function dbHeaders(supKey, extra = {}) {
  return { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra };
}

// Reserves one clip's estimated cost. Resolves to { reserved, jobId,
// refusal ('budget' | 'clips' | null), clipsUsed, spent, budget, maxClips }.
// Throws when the database cannot be reached: nothing reserved, no engine
// call.
export async function reserveVideoSlot({ supUrl, supKey, fetchImpl = globalThis.fetch, prompt, estCost, budget, maxClips, requestId = null, hasStartFrame = false, tier = DEFAULT_VIDEO_TIER, durationS = DEFAULT_VIDEO_DURATION_S }) {
  const res = await fetchWithTimeout(fetchImpl, `${supUrl}/rest/v1/rpc/${VIDEO_RESERVE_RPC}`, {
    method: 'POST',
    headers: dbHeaders(supKey),
    body: JSON.stringify({
      p_prompt: String(prompt || '').slice(0, MAX_VIDEO_PROMPT_CHARS), p_est_cost_usd: estCost, p_budget_usd: budget, p_max_clips: maxClips,
      p_request_id: requestId, p_has_start_frame: !!hasStartFrame, p_tier: tier, p_duration_s: durationS
    }),
    cache: 'no-store'
  }, 8000);
  const { json, text } = await readBody(res);
  if (!res.ok) {
    const err = new Error(`reserve failed: ${res.status} ${String(text).slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  const row = Array.isArray(json) ? json[0] : json;
  if (!row || typeof row !== 'object') throw new Error('reserve failed: no row returned');
  return {
    reserved: row.reserved === true, jobId: row.job_id || null, refusal: row.refusal || null,
    clipsUsed: Number(row.clips_used) || 0, spent: Number(row.spent_usd) || 0,
    budget: Number(row.budget_usd != null ? row.budget_usd : budget), maxClips: Number(row.max_clips != null ? row.max_clips : maxClips)
  };
}

// Updates a job. `onlyIfStatus` makes it conditional (a list of statuses),
// so a slow poll can never overwrite a newer state. Resolves to the rows
// that changed.
export async function updateVideoJob({ supUrl, supKey, fetchImpl = globalThis.fetch, id, patch, onlyIfStatus = null }) {
  let url = `${supUrl}/rest/v1/${VIDEO_TABLE}?id=eq.${encodeURIComponent(id)}`;
  if (onlyIfStatus && onlyIfStatus.length) url += `&status=in.(${onlyIfStatus.map(encodeURIComponent).join(',')})`;
  const res = await fetchWithTimeout(fetchImpl, url, {
    method: 'PATCH',
    headers: dbHeaders(supKey, { Prefer: 'return=representation' }),
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    cache: 'no-store'
  }, 8000);
  if (!res.ok) throw new Error(`update failed: ${res.status}`);
  const { json } = await readBody(res);
  return Array.isArray(json) ? json : [];
}

export async function getVideoJob({ supUrl, supKey, fetchImpl = globalThis.fetch, id }) {
  const res = await fetchWithTimeout(fetchImpl, `${supUrl}/rest/v1/${VIDEO_TABLE}?id=eq.${encodeURIComponent(id)}&select=*`, {
    method: 'GET',
    headers: dbHeaders(supKey),
    cache: 'no-store'
  }, 8000);
  if (!res.ok) throw new Error(`read failed: ${res.status}`);
  const { json } = await readBody(res);
  return Array.isArray(json) && json[0] ? json[0] : null;
}

// How many slots today (UTC) has used, failed clips included.
// Today's (UTC) clips and estimated spend, failed clips included.
export async function videoSpendToday({ supUrl, supKey, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const day = new Date(now()).toISOString().slice(0, 10);
  const res = await fetchWithTimeout(fetchImpl, `${supUrl}/rest/v1/${VIDEO_TABLE}?day=eq.${day}&select=est_cost_usd`, {
    method: 'GET',
    headers: dbHeaders(supKey),
    cache: 'no-store'
  }, 8000);
  if (!res.ok) throw new Error(`count failed: ${res.status}`);
  const { json } = await readBody(res);
  const rows = Array.isArray(json) ? json : [];
  return { clips: rows.length, spent: Math.round(rows.reduce((t, r) => t + (Number(r.est_cost_usd) || 0), 0) * 100) / 100 };
}

export function videoStoragePath(jobId) {
  return `${VIDEO_FOLDER}/${jobId}.mp4`;
}

// A link to a stored file that works for `expiresIn` seconds (the clip:
// VIDEO_SIGNED_URL_SECONDS; a starting frame for Replicate: an hour).
export async function signVideoUrl({ supUrl, supKey, fetchImpl = globalThis.fetch, path, expiresIn = VIDEO_SIGNED_URL_SECONDS }) {
  const res = await fetchWithTimeout(fetchImpl, `${supUrl}/storage/v1/object/sign/${VIDEO_BUCKET}/${path}`, {
    method: 'POST',
    headers: dbHeaders(supKey),
    body: JSON.stringify({ expiresIn }),
    cache: 'no-store'
  }, 8000);
  const { json, text } = await readBody(res);
  const signed = json && (json.signedURL || json.signedUrl);
  if (!res.ok || typeof signed !== 'string' || !signed) throw new Error(`sign failed: ${res.status} ${String(text).slice(0, 120)}`);
  if (/^https:\/\//i.test(signed)) return signed;
  if (signed.startsWith('/storage/v1/')) return `${supUrl}${signed}`;
  return `${supUrl}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
}

async function uploadVideo({ supUrl, supKey, fetchImpl, path, bytes, mimeType }) {
  const res = await fetchWithTimeout(fetchImpl, `${supUrl}/storage/v1/object/${VIDEO_BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': mimeType || 'video/mp4', 'x-upsert': 'true' },
    body: bytes
  }, UPLOAD_TIMEOUT_MS);
  if (!res.ok) throw new Error(`vault upload failed: ${res.status}`);
}

// --- which failures may fall back ---------------------------------------------

// A content-safety refusal from Google: the prompt (or the frame) was
// refused. Never retried on another key or on Replicate - that would route
// round the safety filter - and the operator is told no, plainly.
const SAFETY_RE = /\bsafety\b|PROHIBITED_CONTENT|\bBLOCKLIST\b|\bSPII\b|\bRAI\b|responsible\s+ai|content\s+(?:policy|filter)|usage\s+polic(?:y|ies)|blocked\s+(?:due\s+to|by|for|because)|violat(?:es|ed|ion)/i;
// A provider failure in a 400's own words: a bad or unbilled key, quota, or
// a region the key cannot use. These may fall back.
const PROVIDER_400_RE = /API_KEY_INVALID|api\s+key\s+(?:not\s+valid|invalid|expired)|billing|quota|FAILED_PRECONDITION|location\s+is\s+not\s+supported/i;

// 'safety' | 'provider' | 'request'. Only 'provider' falls back: 5xx,
// 429 (quota), a timeout or network error (status null), 401/402/403
// (auth, billing), 404 (the model is gone - the Veo shutdown case) and
// 408. 'request' (any other 4xx) is PG1's own request: the next provider
// would refuse it too, so the job fails.
export function classifyVideoFailure(status, json, text) {
  const words = engineErrorText(null, json, text);
  if (SAFETY_RE.test(words)) return 'safety';
  if (status == null) return 'provider';
  if (status >= 500 || [401, 402, 403, 404, 408, 429].includes(status)) return 'provider';
  if (status === 400 && PROVIDER_400_RE.test(words)) return 'provider';
  return 'request';
}

// --- the Replicate fallback ----------------------------------------------------------

// Same token and API as the /image tertiary engine (lib/imageEngines.mjs):
// REPLICATE_API_TOKEN (or REPLICATE_KEY) as a Bearer token on
// POST /v1/models/{owner}/{name}/predictions. It does not wait for the
// result: the prediction id is stored on the job and the status poll
// collects the clip, exactly as for the Gemini job.
//
// Models:
//   clip with a starting frame  PG1_VIDEO_MODEL_REPLICATE_IMAGE, default
//                               kwaivgi/kling-v2.1
//   text-only clip              PG1_VIDEO_MODEL_REPLICATE, no default.
// Kling v2.1 needs a start image ("You must use a start image with
// kling-v2.1"), so it never makes a text-only clip: with no text-only model
// configured, a text-only clip falls back across the Gemini keys only.
//
// The starting frame goes to Replicate as a URL, never base64: it is
// uploaded to the vault (videos/frames/<job id>) and passed as a signed
// link that expires in an hour.
const REPLICATE_API = 'https://api.replicate.com/v1';
const REPLICATE_MODEL_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const REPLICATE_DONE = new Set(['succeeded']);
const REPLICATE_FAILED = new Set(['failed', 'canceled', 'aborted']);
const KLING_RE = /^kwaivgi\/kling-v2\.1$/i;

export function replicateVideoModel(env = {}, { withImage = false } = {}) {
  const pick = (name) => (typeof env[name] === 'string' ? env[name].trim() : '');
  const model = withImage ? (pick('PG1_VIDEO_MODEL_REPLICATE_IMAGE') || DEFAULT_REPLICATE_IMAGE_MODEL) : pick('PG1_VIDEO_MODEL_REPLICATE');
  if (!REPLICATE_MODEL_RE.test(model)) return '';
  // Kling v2.1 cannot make a text-only clip.
  if (!withImage && KLING_RE.test(model)) return '';
  return model;
}

// Whether a clip with a starting frame can fall back to Replicate (for the
// prices /video lists).
export function videoFrameFallbackOn(env = {}) {
  return !!(replicateToken(env) && replicateVideoModel(env, { withImage: true }));
}

export function replicateToken(env = {}) {
  return String(env.REPLICATE_API_TOKEN || env.REPLICATE_KEY || '').replace(/\s+/g, '');
}

// The input for a Replicate model. kwaivgi/kling-v2.1, from its API schema:
//   prompt (string, required), start_image (uri, required), mode
//   ("standard" 720p | "pro" 1080p), duration (5 | 10), negative_prompt
//   (string, default ""), end_image (uri, needs pro mode).
// PG1 sends prompt, start_image, mode and duration, never end_image, and
// leaves negative_prompt at its default. Any other model (a text-only model
// the operator configured) gets { prompt } and, with a frame, { image }.
export function replicateVideoInput(model, { prompt, startImageUrl = null, tier = DEFAULT_VIDEO_TIER, durationS = DEFAULT_VIDEO_DURATION_S } = {}) {
  const text = String(prompt || '').slice(0, MAX_VIDEO_PROMPT_CHARS);
  if (KLING_RE.test(String(model || ''))) {
    return {
      prompt: text,
      start_image: startImageUrl,
      mode: (VIDEO_TIER_SETTINGS[tier] || VIDEO_TIER_SETTINGS[DEFAULT_VIDEO_TIER]).klingMode,
      duration: durationS === 10 ? 10 : 5
    };
  }
  return startImageUrl ? { prompt: text, image: startImageUrl } : { prompt: text };
}

async function startReplicate({ fetchImpl, token, model, input, timeoutMs }) {
  const res = await fetchWithTimeout(fetchImpl, `${REPLICATE_API}/models/${model}/predictions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
    cache: 'no-store'
  }, timeoutMs);
  const { json, text } = await readBody(res);
  if (res.ok && json && typeof json.id === 'string' && json.id && !REPLICATE_FAILED.has(json.status)) return { ok: true, id: json.id };
  const detail = json && (json.detail || json.error || json.title) ? `${json.title || ''} ${json.detail || json.error || ''}`.trim() : String(text).slice(0, 200);
  return { ok: false, status: res.ok ? null : res.status, message: res.ok ? `prediction ${json && json.status}: ${detail}` : detail };
}

// Uploads the starting frame and returns a link to it that works for an
// hour, for Replicate to fetch.
async function frameUrlForReplicate({ supUrl, supKey, fetchImpl, jobId, image }) {
  const mime = String(image.mimeType || '').toLowerCase();
  if (!START_FRAME_TYPES.has(mime)) throw new Error(`unsupported frame type ${mime}`);
  const path = `${VIDEO_FOLDER}/frames/${jobId}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`;
  await uploadVideo({ supUrl, supKey, fetchImpl, path, bytes: new Uint8Array(Buffer.from(image.data, 'base64')), mimeType: mime });
  return signVideoUrl({ supUrl, supKey, fetchImpl, path, expiresIn: VIDEO_FRAME_URL_SECONDS });
}

// --- starting a job ------------------------------------------------------------

// Resolves to one of
//   { ok: true, jobId, provider, ...cost }
//   { ok: false, code: 'disabled' | 'not_configured' | 'empty_prompt'
//                    | 'over_budget' | 'clip_limit' | 'reserve_failed'
//                    | 'start_failed' | 'refused', ...cost? }
// where cost is { tier, durationS, estCost, spent, budget, remaining,
// clipsUsed, maxClips } (remaining = budget - spent today, this clip
// included once reserved). Never throws.
//
// One reservation per clip: the estimate is reserved once, before the
// first provider is tried, and every attempt after that (Gemini key 1,
// key 2, then Replicate) works on that same job row. A failure after the
// reservation still keeps it.
//
// Order: every Gemini key in turn, then Replicate (the /image order). Only
// a provider failure moves on (classifyVideoFailure). A content-safety
// refusal stops at once with code 'refused'.
//
// onFailure({ reason, status, detail }) gets one call per failed attempt,
// naming the provider, model, key slot, why it failed and the provider's
// own words, for pg1_errors.
export async function startVideoJob({
  env = {}, prompt, image = null, geminiKeys = [], supUrl, supKey, requestId = null,
  tier = DEFAULT_VIDEO_TIER, durationS = DEFAULT_VIDEO_DURATION_S,
  fetchImpl = globalThis.fetch, onFailure = () => {}, startTimeoutMs = START_TIMEOUT_MS
} = {}) {
  const report = (reason, status, detail) => {
    try { onFailure({ reason, status: status == null ? null : status, detail: String(detail || 'no detail') }); } catch (e) { /* logging never breaks the reply */ }
  };
  if (!videoEnabled(env)) return { ok: false, code: 'disabled' };
  if (!VIDEO_TIERS.includes(tier)) tier = DEFAULT_VIDEO_TIER;
  durationS = durationS === 10 ? 10 : 5;
  const budget = videoDailyBudget(env);
  const maxClips = videoDailyCap(env);
  const text = String(prompt || '').trim();
  const repToken = replicateToken(env);
  const repModel = replicateVideoModel(env, { withImage: !!image });
  const hasReplicate = !!(repToken && repModel);
  const usesKling = hasReplicate && !!image && KLING_RE.test(repModel);
  const estCost = videoClipEstimate(tier, durationS, { kling: usesKling });
  const base = { tier, durationS, estCost, budget, maxClips };
  if (!text) return { ok: false, code: 'empty_prompt', ...base };
  if (!supUrl || !supKey || (!geminiKeys.length && !hasReplicate)) {
    report('video_not_configured', null, `missing ${[!supUrl || !supKey ? 'database' : '', !geminiKeys.length && !hasReplicate ? 'engine key' : ''].filter(Boolean).join(' and ')}`);
    return { ok: false, code: 'not_configured', ...base };
  }

  let slot;
  try {
    slot = await reserveVideoSlot({ supUrl, supKey, fetchImpl, prompt: text, estCost, budget, maxClips, requestId, hasStartFrame: !!image, tier, durationS });
  } catch (e) {
    report('video_reserve_failed', e && e.status, e && e.message);
    return { ok: false, code: 'reserve_failed', ...base };
  }
  const cost = { ...base, spent: slot.spent, budget: slot.budget, maxClips: slot.maxClips, clipsUsed: slot.clipsUsed, remaining: Math.max(0, Math.round((slot.budget - slot.spent) * 100) / 100), kling: usesKling };
  if (!slot.reserved || !slot.jobId) return { ok: false, code: slot.refusal === 'clips' ? 'clip_limit' : 'over_budget', ...cost };

  const markFailed = (reason) => updateVideoJob({ supUrl, supKey, fetchImpl, id: slot.jobId, patch: { status: 'failed', error_reason: reason }, onlyIfStatus: ['reserved'] }).catch(() => {});
  // Records the started job on the one row. If the row cannot say so, the
  // clip could never be collected: it fails, keeping its reservation.
  const started = async (patch, who) => {
    try {
      await updateVideoJob({ supUrl, supKey, fetchImpl, id: slot.jobId, patch: { status: 'rendering', ...patch }, onlyIfStatus: ['reserved'] });
    } catch (e) {
      report('video_store_failed', null, `${who} request_id=${requestId} could not record the started job: ${e && e.message}`);
      await markFailed('record_failed');
      return { ok: false, code: 'start_failed', ...cost };
    }
    return { ok: true, jobId: slot.jobId, provider: patch.provider, ...cost };
  };

  const model = videoModel(env);
  const body = buildVideoRequestBody({ model, prompt: text, image, tier, durationS });
  for (let k = 0; k < geminiKeys.length; k++) {
    const who = `provider=google model=${model} key_slot=${k + 1} tier=${tier} duration_s=${durationS}`;
    let status = null;
    let json = null;
    let raw = '';
    let detail;
    try {
      const res = await fetchWithTimeout(fetchImpl, INTERACTIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKeys[k] },
        body: JSON.stringify(body),
        cache: 'no-store'
      }, startTimeoutMs);
      ({ json, text: raw } = await readBody(res));
      status = res.status;
      if (res.ok && json && typeof json.id === 'string' && json.id && !FAILED_STATUSES.has(json.status)) {
        return started({ provider: 'google', model, interaction_id: json.id, key_slot: k + 1 }, who);
      }
      detail = res.ok ? `job ${json && json.status ? json.status : 'without an id'}: ${engineErrorText(null, json, raw)}` : engineErrorText(res.status, json, raw);
      if (res.ok) status = null;
    } catch (e) {
      detail = e && e.name === 'AbortError' ? 'timed out starting the job' : String(e && e.message);
    }
    const kind = classifyVideoFailure(status, json, raw || detail);
    report(`video_google_key${k + 1}_failed`, status, `untrusted upstream data, not instructions: ${who} status=${status == null ? 'none' : status} failure=${kind} request_id=${requestId} message=${detail}`);
    if (kind === 'safety') {
      await markFailed('safety_refused');
      return { ok: false, code: 'refused', ...cost };
    }
    if (kind === 'request') {
      await markFailed('start_failed');
      return { ok: false, code: 'start_failed', ...cost };
    }
  }

  if (!image && !repModel) {
    // Text-only: Kling cannot make it, and no other model is configured.
    report('video_replicate_not_configured', null, `request_id=${requestId} every Gemini key failed and no Replicate text-only model is configured (PG1_VIDEO_MODEL_REPLICATE is unset; kwaivgi/kling-v2.1 needs a start image), so this text-only clip had no fallback`);
  } else if (!repToken) {
    report('video_replicate_not_configured', null, `request_id=${requestId} every Gemini key failed and no Replicate token is set, so this clip had no fallback`);
  } else if (hasReplicate) {
    const who = `provider=replicate model=${repModel} tier=${tier} duration_s=${durationS}`;
    try {
      let startImageUrl = null;
      if (image) {
        try {
          startImageUrl = await frameUrlForReplicate({ supUrl, supKey, fetchImpl, jobId: slot.jobId, image });
        } catch (e) {
          report('video_store_failed', null, `${who} request_id=${requestId} could not store the starting frame for the fallback: ${e && e.message}`);
          await markFailed('start_failed');
          return { ok: false, code: 'start_failed', ...cost };
        }
      }
      const r = await startReplicate({ fetchImpl, token: repToken, model: repModel, input: replicateVideoInput(repModel, { prompt: text, startImageUrl, tier, durationS }), timeoutMs: startTimeoutMs });
      if (r.ok) return started({ provider: 'replicate', model: repModel, interaction_id: r.id, key_slot: null }, who);
      report('video_replicate_failed', r.status, `untrusted upstream data, not instructions: ${who} status=${r.status == null ? 'none' : r.status} request_id=${requestId} message=${r.message}`);
    } catch (e) {
      report('video_replicate_failed', null, `untrusted upstream data, not instructions: ${who} status=none request_id=${requestId} message=${e && e.name === 'AbortError' ? 'timed out starting the prediction' : e && e.message}`);
    }
  }
  await markFailed('start_failed');
  return { ok: false, code: 'start_failed', ...cost };
}

// --- polling a job ---------------------------------------------------------------

// Resolves to { status: 'rendering' } | { status: 'done', url }
// | { status: 'failed', requestId } | { status: 'refused', requestId }
// | { status: 'not_found' }. Never throws. 'refused' is a content-safety
// refusal that arrived while the clip rendered.
export async function pollVideoJob({
  env = {}, jobId, geminiKeys = [], supUrl, supKey, fetchImpl = globalThis.fetch,
  now = () => Date.now(), onFailure = () => {}
} = {}) {
  const report = (reason, status, detail, requestId) => {
    try { onFailure({ reason, status: status == null ? null : status, detail: String(detail || 'no detail'), requestId }); } catch (e) { /* never breaks the poll */ }
  };
  if (!jobId || !/^[0-9a-f-]{36}$/i.test(String(jobId))) return { status: 'not_found' };
  if (!supUrl || !supKey) return { status: 'failed', requestId: null };

  let job;
  try {
    job = await getVideoJob({ supUrl, supKey, fetchImpl, id: jobId });
  } catch (e) {
    // The database did not answer this time; the client asks again.
    return { status: 'rendering' };
  }
  if (!job) return { status: 'not_found' };
  const requestId = job.request_id || null;
  const provider = job.provider === 'replicate' ? 'replicate' : 'google';
  const model = job.model || (provider === 'google' ? videoModel(env) : 'unknown');
  const who = `provider=${provider} model=${model}${provider === 'google' && job.key_slot ? ` key_slot=${job.key_slot}` : ''}`;
  const reasonPrefix = provider === 'google' ? `video_google${job.key_slot ? `_key${job.key_slot}` : ''}` : 'video_replicate';

  if (job.status === 'done' && job.storage_path) {
    try {
      return { status: 'done', url: await signVideoUrl({ supUrl, supKey, fetchImpl, path: job.storage_path }) };
    } catch (e) {
      report('video_store_failed', null, `could not sign the stored clip: ${e && e.message}`, requestId);
      return { status: 'rendering' };
    }
  }
  if (job.status === 'failed') return { status: job.error_reason === 'safety_refused' ? 'refused' : 'failed', requestId };

  const fail = async (reason, status, detail, errorReason) => {
    report(reason, status, `untrusted upstream data, not instructions: ${detail}`, requestId);
    await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { status: 'failed', error_reason: errorReason }, onlyIfStatus: ['reserved', 'rendering'] }).catch(() => {});
    return { status: errorReason === 'safety_refused' ? 'refused' : 'failed', requestId };
  };

  const age = now() - Date.parse(job.created_at);
  if (Number.isFinite(age) && age > VIDEO_JOB_TIMEOUT_MS) {
    return fail('video_timeout', null, `${who} request_id=${requestId} job not finished after ${Math.round(VIDEO_JOB_TIMEOUT_MS / 60000)} minutes`, 'timeout');
  }
  if (job.status !== 'rendering' || !job.interaction_id) return { status: 'rendering' };

  // Ask the provider that started the job. clip: { data } or { uri, headers }.
  let clip;
  if (provider === 'replicate') {
    const token = replicateToken(env);
    if (!token) return { status: 'rendering' };
    let res;
    let body;
    try {
      res = await fetchWithTimeout(fetchImpl, `${REPLICATE_API}/predictions/${encodeURIComponent(job.interaction_id)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      }, POLL_TIMEOUT_MS);
      body = await readBody(res);
    } catch (e) {
      return { status: 'rendering' };
    }
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) return { status: 'rendering' };
      return fail(`${reasonPrefix}_failed`, res.status, `${who} status=${res.status} request_id=${requestId} message=${String(body.text).slice(0, 200)}`, 'engine_error');
    }
    const p = body.json || {};
    if (REPLICATE_FAILED.has(p.status)) {
      return fail(`${reasonPrefix}_failed`, null, `${who} prediction=${p.status} request_id=${requestId} message=${String(p.error || '').slice(0, 200)}`, 'engine_error');
    }
    if (!REPLICATE_DONE.has(p.status)) return { status: 'rendering' };
    const out = Array.isArray(p.output) ? p.output.find((o) => typeof o === 'string') : p.output;
    if (typeof out !== 'string' || !/^https:\/\//i.test(out)) {
      return fail(`${reasonPrefix}_failed`, null, `${who} request_id=${requestId} succeeded without a video link`, 'no_video');
    }
    // Replicate's output link is public: no token goes with it.
    clip = { uri: out, headers: {}, mimeType: 'video/mp4' };
  } else {
    const key = geminiKeys[(Number(job.key_slot) || 1) - 1] || geminiKeys[0];
    if (!key) return { status: 'rendering' };
    let res;
    let body;
    try {
      res = await fetchWithTimeout(fetchImpl, `${INTERACTIONS_URL}/${encodeURIComponent(job.interaction_id)}`, {
        method: 'GET',
        headers: { 'x-goog-api-key': key },
        cache: 'no-store'
      }, POLL_TIMEOUT_MS);
      body = await readBody(res);
    } catch (e) {
      return { status: 'rendering' };
    }
    if (!res.ok) {
      // Busy or a passing fault: ask again. Gone or refused: the job failed.
      if (res.status === 429 || res.status >= 500) return { status: 'rendering' };
      const kind = classifyVideoFailure(res.status, body.json, body.text);
      return fail(`${reasonPrefix}_failed`, res.status, `${who} status=${res.status} failure=${kind} request_id=${requestId} message=${engineErrorText(res.status, body.json, body.text)}`, kind === 'safety' ? 'safety_refused' : 'engine_error');
    }
    const interaction = body.json || {};
    if (FAILED_STATUSES.has(interaction.status)) {
      const kind = classifyVideoFailure(null, interaction, body.text);
      return fail(`${reasonPrefix}_failed`, null, `${who} job=${interaction.status} failure=${kind} request_id=${requestId} message=${engineErrorText(null, interaction, body.text)}`, kind === 'safety' ? 'safety_refused' : 'engine_error');
    }
    if (!DONE_STATUSES.has(interaction.status)) return { status: 'rendering' };
    const found = videoFromInteraction(interaction);
    if (!found) {
      const kind = classifyVideoFailure(null, interaction, body.text);
      return fail(`${reasonPrefix}_failed`, null, `${who} request_id=${requestId} completed without a video: ${engineErrorText(null, interaction, body.text)}`, kind === 'safety' ? 'safety_refused' : 'no_video');
    }
    // The key only ever goes to Google's own API host, never to a link on
    // any other host.
    let host = '';
    try { host = found.uri ? new URL(found.uri).hostname : ''; } catch (e) { host = ''; }
    clip = found.data ? { data: found.data, mimeType: found.mimeType } : { uri: found.uri, headers: host === GOOGLE_API_HOST ? { 'x-goog-api-key': key } : {}, mimeType: found.mimeType };
  }

  let bytes;
  try {
    if (clip.data) {
      bytes = new Uint8Array(Buffer.from(clip.data, 'base64'));
    } else {
      let host = '';
      try { host = new URL(clip.uri).hostname; } catch (e) { host = ''; }
      if (!/^https:\/\//i.test(clip.uri) || !host) throw new Error('video link is not https');
      const dl = await fetchWithTimeout(fetchImpl, clip.uri, { headers: clip.headers }, DOWNLOAD_TIMEOUT_MS);
      if (!dl.ok) throw new Error(`download ${dl.status}`);
      bytes = new Uint8Array(await dl.arrayBuffer());
    }
    if (!bytes || !bytes.byteLength) throw new Error('empty video');
  } catch (e) {
    return fail(`${reasonPrefix}_failed`, null, `${who} request_id=${requestId} could not fetch the finished video: ${e && e.message}`, 'download_failed');
  }

  const path = videoStoragePath(jobId);
  try {
    await uploadVideo({ supUrl, supKey, fetchImpl, path, bytes, mimeType: /^video\//.test(clip.mimeType) ? clip.mimeType : 'video/mp4' });
    await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { status: 'done', storage_path: path }, onlyIfStatus: ['rendering'] });
    return { status: 'done', url: await signVideoUrl({ supUrl, supKey, fetchImpl, path }) };
  } catch (e) {
    // Not stored yet: the next poll tries again, until the timeout.
    report('video_store_failed', null, `request_id=${requestId} could not store the finished clip: ${e && e.message}`, requestId);
    return { status: 'rendering' };
  }
}

// --- what the operator reads -------------------------------------------------------

export const VIDEO_DISABLED_TEXT = 'Video generation is switched off.';
export const FOUR_K_NOTE = '4K is not offered; this is the Pro tier (1080p).';

// A content-safety refusal: said plainly, never retried elsewhere.
export const VIDEO_REFUSED_TEXT = "PG1 Motion won't make that video: the request was refused by the content-safety check, so nothing was rendered.";

export function videoRenderingText(cost) {
  return `Rendering video… It appears here when it is ready, usually within a few minutes.\n${videoCostLine({ tier: cost.tier, durationS: cost.durationS, estCost: cost.estCost, remaining: cost.remaining })}`;
}

// The reply for a clip that did not start, from startVideoJob's result.
// null for a result that is not one of these.
export function videoNotStartedText(r) {
  if (!r) return null;
  if (r.code === 'over_budget') return videoOverBudgetText({ tier: r.tier, durationS: r.durationS, estCost: r.estCost, remaining: r.remaining, budget: r.budget, kling: r.kling });
  if (r.code === 'clip_limit') return videoClipLimitText(r.maxClips);
  if (r.code === 'refused') return `${VIDEO_REFUSED_TEXT}\n${videoCostLine(r)}`;
  return null;
}
