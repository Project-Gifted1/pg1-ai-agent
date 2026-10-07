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
// Synchronous render (the default). Since 2026-10-03 Google answers GET
// /v1beta/interactions/{id} with 400 "Multiple authentication credentials
// received" for background interactions on AQ.-prefix keys, while POST still
// works. So unless PG1_VIDEO_GOOGLE_ASYNC=1, nothing ever GETs an
// interaction:
//  1. the chat reserves the slot (one reservation, as before), stores any
//     starting frame in the vault, sets the row to 'queued' and answers at
//     once with the same "Rendering video…" card;
//  2. it dispatches a server-to-server POST to api/video-render.mjs (its
//     own invocation, maxDuration VIDEO_RENDER_MAX_DURATION_S), signed with
//     a short-lived HMAC token over the job id (signRenderToken);
//  3. the render claims the row atomically (queued -> rendering; a second
//     trigger finds nothing to claim and never calls Google), POSTs the
//     interaction with background: false, takes the clip from the POST's
//     own answer (inline, or by a delivery uri for a clip over 4 MB),
//     uploads it to pg1-vault/videos/ and sets the row to done, or to
//     failed with Google's error text in error_detail;
//  4. the card's status action (videoJobStatus) reads only the row, and
//     fails a job that has been rendering longer than maxDuration plus
//     VIDEO_RENDER_MARGIN_MS ("render timed out").
// PG1_VIDEO_GOOGLE_ASYNC=1 brings back background: true and the GET poll
// below, for when Google fixes the bug.
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

import crypto from 'node:crypto';
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
// A poll that Google answers with a request error (a 4xx that is not a
// content-safety refusal) is asked again on the next polls; the job fails
// only after this many such answers in a row. Each one is logged with
// Google's own text. The count lives in error_reason ("poll_error_<n>")
// while the job is still rendering.
export const VIDEO_POLL_ERROR_LIMIT = 3;
// The synchronous render (api/video-render.mjs). 800 s is the most a
// Vercel Pro function may run with Fluid compute (300 s without it); the
// function's config must say the same number (a test holds them equal).
export const VIDEO_RENDER_MAX_DURATION_S = 800;
// The status action fails a job still 'rendering' this long after the
// render claimed it: by then the function has certainly been stopped.
export const VIDEO_RENDER_MARGIN_MS = 60 * 1000;
export const VIDEO_RENDER_TIMEOUT_MS = VIDEO_RENDER_MAX_DURATION_S * 1000 + VIDEO_RENDER_MARGIN_MS;
// The render only claims a job queued less than this long ago, and the
// status action fails a job nobody claimed a little after it. Window plus
// maxDuration (890 s) stays inside the 15 minutes after which
// pg1_reserve_video_slot sweeps open jobs.
export const VIDEO_QUEUE_CLAIM_WINDOW_MS = 90 * 1000;
export const VIDEO_QUEUE_TIMEOUT_MS = VIDEO_QUEUE_CLAIM_WINDOW_MS + 30 * 1000;
// How long a render token is good for: it only has to reach the render.
export const VIDEO_RENDER_TOKEN_TTL_MS = 5 * 60 * 1000;
export const VIDEO_RENDER_TOKEN_HEADER = 'x-pg1-render-token';
// A clip expected to be larger than this is delivered by uri, not inline.
export const VIDEO_INLINE_MAX_BYTES = 4 * 1024 * 1024;
// Conservative bitrates (video and audio, bits per second) per Google
// resolution, for the size estimate that picks the delivery.
const CLIP_BITRATES = { '360p': 1500000, '720p': 5000000, '1080p': 10000000 };

export function videoResponseFormat(tier = DEFAULT_VIDEO_TIER, delivery = 'uri') {
  return { type: 'video', resolution: (VIDEO_TIER_SETTINGS[tier] || VIDEO_TIER_SETTINGS[DEFAULT_VIDEO_TIER]).googleResolution, aspect_ratio: '16:9', delivery: delivery === 'inline' ? 'inline' : 'uri' };
}

// The clip's expected size in bytes, from its resolution and length.
export function estimatedClipBytes(tier = DEFAULT_VIDEO_TIER, durationS = DEFAULT_VIDEO_DURATION_S) {
  const res = (VIDEO_TIER_SETTINGS[tier] || VIDEO_TIER_SETTINGS[DEFAULT_VIDEO_TIER]).googleResolution;
  return Math.ceil(((CLIP_BITRATES[res] || CLIP_BITRATES['1080p']) * (durationS === 10 ? 10 : 5)) / 8);
}

// 'uri' for a clip expected over 4 MB, else 'inline' (the synchronous
// render; the background job always asks for a uri).
export function videoDelivery(tier = DEFAULT_VIDEO_TIER, durationS = DEFAULT_VIDEO_DURATION_S) {
  return estimatedClipBytes(tier, durationS) > VIDEO_INLINE_MAX_BYTES ? 'uri' : 'inline';
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

// PG1_VIDEO_GOOGLE_ASYNC=1: the old background job and GET poll. Off by
// default while Google's GET /interactions/{id} is broken.
export function videoGoogleAsync(env = {}) {
  return String(env.PG1_VIDEO_GOOGLE_ASYNC == null ? '' : env.PG1_VIDEO_GOOGLE_ASYNC).trim() === '1';
}

// A key's format for the logs: its well-known prefix only ("AQ." or
// "AIza"), never any other character of it.
export function keyFormat(key) {
  const k = String(key || '');
  return k.startsWith('AQ.') ? 'AQ.' : k.startsWith('AIza') ? 'AIza' : 'other';
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
// background is true for the background job (PG1_VIDEO_GOOGLE_ASYNC=1) and
// false for the synchronous render, which also picks the delivery.
export function buildVideoRequestBody({ model, prompt, image = null, tier = DEFAULT_VIDEO_TIER, durationS = DEFAULT_VIDEO_DURATION_S, background = true, delivery = 'uri' } = {}) {
  const text = `${String(prompt || '').slice(0, MAX_VIDEO_PROMPT_CHARS)}\n\nClip length: ${durationS === 10 ? 10 : 5} seconds.`;
  const frame = image && START_FRAME_TYPES.has(String(image.mimeType || '').toLowerCase()) && typeof image.data === 'string' && image.data
    ? { type: 'image', data: image.data, mime_type: String(image.mimeType).toLowerCase() }
    : null;
  return {
    model,
    input: frame ? [{ type: 'text', text }, frame] : text,
    response_format: videoResponseFormat(tier, delivery),
    background: background !== false
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

// --- Google requests: the key, exactly once -----------------------------------
//
// Google answers a request that carries more than one credential with
// "400 invalid_request Multiple authentication credentials received". So
// every Google request on the video path (start, poll, the download of a
// clip delivered by link) goes through googleVideoFetch, which sends the
// key once, in the x-goog-api-key header, and nowhere else:
//  - ?key= is taken out of every URL, including a link Google hands back
//    (a delivery uri) and the Location of a redirect;
//  - any Authorization or x-goog-api-key header the caller passed is
//    dropped, so the header is set exactly once, here;
//  - the header goes only to Google's own API host, and not even there
//    when the link already carries its own credential (a signed URL);
//  - redirects are followed by hand (at most 5), each hop decided again
//    by the same rules, because fetch would otherwise re-send our header
//    to a URL that may carry a credential of its own.
// Query parameters that are a credential in themselves: a signed link
// (V2 or V4) or an OAuth token.
const URL_CREDENTIAL_PARAMS = new Set(['access_token', 'x-goog-signature', 'x-goog-credential', 'googleaccessid', 'signature']);
const MAX_GOOGLE_REDIRECTS = 5;

// The URL with every ?key= removed (any case).
export function stripUrlKey(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return String(url); }
  for (const name of Array.from(u.searchParams.keys())) if (name.toLowerCase() === 'key') u.searchParams.delete(name);
  return u.toString();
}

function urlHasOwnCredential(u) {
  for (const name of u.searchParams.keys()) if (URL_CREDENTIAL_PARAMS.has(name.toLowerCase())) return true;
  return false;
}

// The headers and URL for one Google request: { url, headers }.
export function googleRequestParts(url, key, headers = {}) {
  const clean = stripUrlKey(url);
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (lower === 'authorization' || lower === 'x-goog-api-key') continue;
    out[name] = value;
  }
  let u = null;
  try { u = new URL(clean); } catch (e) { u = null; }
  if (key && u && u.protocol === 'https:' && u.hostname === GOOGLE_API_HOST && !urlHasOwnCredential(u)) out['x-goog-api-key'] = key;
  return { url: clean, headers: out };
}

// onSend (optional) sees each hop as it goes out: { method, url, headers }.
async function googleVideoFetch(fetchImpl, url, { key, headers = {}, onSend, ...options } = {}, timeoutMs) {
  let next = url;
  let method = options.method || 'GET';
  let body = options.body;
  for (let hop = 0; hop <= MAX_GOOGLE_REDIRECTS; hop++) {
    const parts = googleRequestParts(next, key, headers);
    if (onSend) { try { onSend({ method, url: parts.url, headers: parts.headers }); } catch (e) { /* never breaks the request */ } }
    const res = await fetchWithTimeout(fetchImpl, parts.url, { ...options, method, body, headers: parts.headers, redirect: 'manual' }, timeoutMs);
    const location = res.status >= 300 && res.status < 400 && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
    if (!location) return res;
    next = new URL(location, parts.url).toString();
    // 303, and 301/302 after a POST, become a GET without a body (fetch's rule).
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
  }
  throw new Error('too many redirects');
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
// `createdAfter` (an ISO time) only matches a job created after it.
export async function updateVideoJob({ supUrl, supKey, fetchImpl = globalThis.fetch, id, patch, onlyIfStatus = null, createdAfter = null }) {
  let url = `${supUrl}/rest/v1/${VIDEO_TABLE}?id=eq.${encodeURIComponent(id)}`;
  if (onlyIfStatus && onlyIfStatus.length) url += `&status=in.(${onlyIfStatus.map(encodeURIComponent).join(',')})`;
  if (createdAfter) url += `&created_at=gt.${encodeURIComponent(createdAfter)}`;
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
// "Multiple authentication credentials received" is Google's own fault on
// some keys since 2026-10-03 (a request that carries the key once still
// gets it), so it moves on to the next key too.
const PROVIDER_400_RE = /Multiple\s+authentication\s+credentials|API_KEY_INVALID|api\s+key\s+(?:not\s+valid|invalid|expired)|billing|quota|FAILED_PRECONDITION|location\s+is\s+not\s+supported/i;

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

// Uploads the starting frame to videos/frames/<job id>.<ext>; resolves to
// its path.
async function storeStartFrame({ supUrl, supKey, fetchImpl, jobId, image }) {
  const mime = String(image.mimeType || '').toLowerCase();
  if (!START_FRAME_TYPES.has(mime)) throw new Error(`unsupported frame type ${mime}`);
  const path = `${VIDEO_FOLDER}/frames/${jobId}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`;
  await uploadVideo({ supUrl, supKey, fetchImpl, path, bytes: new Uint8Array(Buffer.from(image.data, 'base64')), mimeType: mime });
  return path;
}

// Uploads the starting frame and returns a link to it that works for an
// hour, for Replicate to fetch.
async function frameUrlForReplicate({ supUrl, supKey, fetchImpl, jobId, image }) {
  const path = await storeStartFrame({ supUrl, supKey, fetchImpl, jobId, image });
  return signVideoUrl({ supUrl, supKey, fetchImpl, path, expiresIn: VIDEO_FRAME_URL_SECONDS });
}

// The starting frame the chat stored for the render: { mimeType, data }
// (base64).
async function readStartFrame({ supUrl, supKey, fetchImpl, path }) {
  const res = await fetchWithTimeout(fetchImpl, `${supUrl}/storage/v1/object/${VIDEO_BUCKET}/${path}`, {
    method: 'GET',
    headers: { apikey: supKey, Authorization: `Bearer ${supKey}` },
    cache: 'no-store'
  }, DOWNLOAD_TIMEOUT_MS);
  if (!res.ok) throw new Error(`frame read failed: ${res.status}`);
  const ext = String(path).split('.').pop().toLowerCase();
  const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  if (!START_FRAME_TYPES.has(mimeType)) throw new Error(`unsupported frame type ${mimeType}`);
  return { mimeType, data: Buffer.from(await res.arrayBuffer()).toString('base64') };
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
  const sync = !videoGoogleAsync(env);
  // The synchronous render needs its trigger: checked before anything is
  // reserved, so a clip that could never render costs nothing.
  if (sync && (!videoRenderSecret(env) || !videoRenderUrl(env))) {
    report('video_not_configured', null, `missing ${[!videoRenderSecret(env) ? 'render secret (PG1_VIDEO_RENDER_SECRET or CRON_SECRET)' : '', !videoRenderUrl(env) ? 'render URL' : ''].filter(Boolean).join(' and ')}`);
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
  if (sync) {
    // Queued for api/video-render.mjs, which the caller triggers
    // (dispatchVideoRender). No engine is called here, so the reply is
    // immediate; the render tries the keys and Replicate in the same order.
    let framePath = null;
    if (image) {
      try {
        framePath = await storeStartFrame({ supUrl, supKey, fetchImpl, jobId: slot.jobId, image });
      } catch (e) {
        report('video_store_failed', null, `request_id=${requestId} could not store the starting frame for the render: ${e && e.message}`);
        await markFailed('start_failed');
        return { ok: false, code: 'start_failed', ...cost };
      }
    }
    const provider = geminiKeys.length ? 'google' : 'replicate';
    try {
      const rows = await updateVideoJob({ supUrl, supKey, fetchImpl, id: slot.jobId, patch: { status: 'queued', provider, model: provider === 'google' ? model : repModel, start_frame_path: framePath }, onlyIfStatus: ['reserved'] });
      if (!rows.length) throw new Error('job was not reserved');
    } catch (e) {
      report('video_store_failed', null, `request_id=${requestId} could not queue the job: ${e && e.message}`);
      await markFailed('record_failed');
      return { ok: false, code: 'start_failed', ...cost };
    }
    return { ok: true, jobId: slot.jobId, provider, queued: true, ...cost };
  }

  const body = buildVideoRequestBody({ model, prompt: text, image, tier, durationS });
  for (let k = 0; k < geminiKeys.length; k++) {
    const who = `provider=google model=${model} key_slot=${k + 1} tier=${tier} duration_s=${durationS}`;
    let status = null;
    let json = null;
    let raw = '';
    let detail;
    try {
      const res = await googleVideoFetch(fetchImpl, INTERACTIONS_URL, {
        method: 'POST',
        key: geminiKeys[k],
        headers: { 'Content-Type': 'application/json' },
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

// TEMPORARY debug for the live "Multiple authentication credentials" poll:
// per hop, the header NAMES handed to fetch (never values), whether the
// URL contains "key=", and the key's format (its well-known prefix only:
// "AQ." or "AIza"; never any other character of it). fetch itself adds
// only accept, accept-language, sec-fetch-mode, user-agent, pragma,
// cache-control and accept-encoding, none of them a credential.
export function pollDebugText(sent, key) {
  const hops = (sent || []).map((r, i) => {
    let where = '';
    try { const u = new URL(r.url); where = `${u.hostname}${u.pathname}`; } catch (e) { where = 'unparsable-url'; }
    const names = Object.keys(r.headers || {}).map((n) => n.toLowerCase()).sort();
    return `hop${i + 1}: ${r.method} ${where} header_names=[${names.join(',')}] url_has_key=${/key=/i.test(String(r.url)) ? 'yes' : 'no'}`;
  });
  return `TEMP DEBUG poll request (names only, no values) key_format=${keyFormat(key)} hops=${hops.length} ${hops.join('; ') || 'none'}`;
}

// Resolves to { status: 'rendering' } | { status: 'done', url }
// | { status: 'failed', requestId } | { status: 'refused', requestId }
// | { status: 'not_found' }. Never throws. 'refused' is a content-safety
// refusal that arrived while the clip rendered.
//
// ignoreTimeout and pollErrorLimit are for recheckVideoJob: one more look
// at a job that already failed, past the 15-minute timeout.
export async function pollVideoJob({
  env = {}, jobId, geminiKeys = [], supUrl, supKey, fetchImpl = globalThis.fetch,
  now = () => Date.now(), onFailure = () => {}, ignoreTimeout = false, pollErrorLimit = VIDEO_POLL_ERROR_LIMIT
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
  if (!ignoreTimeout && Number.isFinite(age) && age > VIDEO_JOB_TIMEOUT_MS) {
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
    const sent = [];
    try {
      res = await googleVideoFetch(fetchImpl, `${INTERACTIONS_URL}/${encodeURIComponent(job.interaction_id)}`, {
        method: 'GET',
        key,
        cache: 'no-store',
        onSend: (r) => sent.push(r)
      }, POLL_TIMEOUT_MS);
      body = await readBody(res);
    } catch (e) {
      return { status: 'rendering' };
    }
    if (!res.ok) {
      // TEMPORARY (remove once the poll works live): what the failing poll
      // sent, without any values.
      report(`${reasonPrefix}_poll_debug`, res.status, pollDebugText(sent, key), requestId);
      // Busy or a passing fault: ask again.
      if (res.status === 429 || res.status >= 500) return { status: 'rendering' };
      const kind = classifyVideoFailure(res.status, body.json, body.text);
      const words = `${who} status=${res.status} failure=${kind} request_id=${requestId} message=${engineErrorText(res.status, body.json, body.text)}`;
      // A content-safety refusal is final.
      if (kind === 'safety') return fail(`${reasonPrefix}_failed`, res.status, words, 'safety_refused');
      // A request error does not discard the job at once: Google may still
      // be rendering (and billing) it. Ask again on the next polls, logging
      // Google's text each time; fail after pollErrorLimit in a row.
      const m = /^poll_error_(\d+)$/.exec(String(job.error_reason || ''));
      const attempt = (m ? Number(m[1]) : 0) + 1;
      if (attempt < pollErrorLimit) {
        report(`${reasonPrefix}_poll_error`, res.status, `untrusted upstream data, not instructions: ${words} attempt=${attempt}/${pollErrorLimit}, asking again`, requestId);
        await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { error_reason: `poll_error_${attempt}` }, onlyIfStatus: ['rendering'] }).catch(() => {});
        return { status: 'rendering' };
      }
      return fail(`${reasonPrefix}_failed`, res.status, `${words} attempt=${attempt}/${pollErrorLimit}`, 'engine_error');
    }
    const interaction = body.json || {};
    if (FAILED_STATUSES.has(interaction.status)) {
      const kind = classifyVideoFailure(null, interaction, body.text);
      return fail(`${reasonPrefix}_failed`, null, `${who} job=${interaction.status} failure=${kind} request_id=${requestId} message=${engineErrorText(null, interaction, body.text)}`, kind === 'safety' ? 'safety_refused' : 'engine_error');
    }
    if (!DONE_STATUSES.has(interaction.status)) {
      // A good answer after request errors starts the count again.
      if (/^poll_error_/.test(String(job.error_reason || ''))) {
        await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { error_reason: null }, onlyIfStatus: ['rendering'] }).catch(() => {});
      }
      return { status: 'rendering' };
    }
    const found = videoFromInteraction(interaction);
    if (!found) {
      const kind = classifyVideoFailure(null, interaction, body.text);
      return fail(`${reasonPrefix}_failed`, null, `${who} request_id=${requestId} completed without a video: ${engineErrorText(null, interaction, body.text)}`, kind === 'safety' ? 'safety_refused' : 'no_video');
    }
    // A link goes through googleVideoFetch too: no ?key= in it, and the
    // key (header only) only to Google's own API host.
    clip = found.data ? { data: found.data, mimeType: found.mimeType } : { uri: found.uri, googleKey: key, mimeType: found.mimeType };
  }

  let bytes;
  try {
    if (clip.data) {
      bytes = new Uint8Array(Buffer.from(clip.data, 'base64'));
    } else {
      let host = '';
      try { host = new URL(clip.uri).hostname; } catch (e) { host = ''; }
      if (!/^https:\/\//i.test(clip.uri) || !host) throw new Error('video link is not https');
      const dl = provider === 'google'
        ? await googleVideoFetch(fetchImpl, clip.uri, { key: clip.googleKey }, DOWNLOAD_TIMEOUT_MS)
        : await fetchWithTimeout(fetchImpl, clip.uri, { headers: clip.headers }, DOWNLOAD_TIMEOUT_MS);
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
    await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { status: 'done', storage_path: path, error_reason: null }, onlyIfStatus: ['rendering'] });
    return { status: 'done', url: await signVideoUrl({ supUrl, supKey, fetchImpl, path }) };
  } catch (e) {
    // Not stored yet: the next poll tries again, until the timeout.
    report('video_store_failed', null, `request_id=${requestId} could not store the finished clip: ${e && e.message}`, requestId);
    return { status: 'rendering' };
  }
}

// --- one more look at a failed job ------------------------------------------------

export async function getVideoJobByRequestId({ supUrl, supKey, fetchImpl = globalThis.fetch, requestId }) {
  const res = await fetchWithTimeout(fetchImpl, `${supUrl}/rest/v1/${VIDEO_TABLE}?request_id=eq.${encodeURIComponent(requestId)}&select=*&order=created_at.desc`, {
    method: 'GET',
    headers: dbHeaders(supKey),
    cache: 'no-store'
  }, 8000);
  if (!res.ok) throw new Error(`read failed: ${res.status}`);
  const { json } = await readBody(res);
  return Array.isArray(json) && json[0] ? json[0] : null;
}

export const VIDEO_REQUEST_ID_RE = /^[a-z0-9]{6,16}$/i;

// "/video recheck <request id>": asks the engine once more about a Google
// job that failed while it was polled (an error on our side of the poll,
// such as the double-credential 400), because Google may have rendered and
// billed the clip anyway. Only a job that has an interaction id and was not
// refused on content-safety grounds. If the clip is there it is stored and
// signed exactly as a normal poll would; if not, the job goes back to
// failed with its original reason.
// Resolves to { status: 'done', jobId, url } | { status: 'rendering', jobId }
// | { status: 'failed', jobId } | { status: 'not_recoverable', jobId }
// | { status: 'not_found' }. Never throws.
//
// While the render is synchronous (PG1_VIDEO_GOOGLE_ASYNC unset) it never
// asks Google: a failed job is 'not_recoverable', since there is no
// background interaction to look at.
export async function recheckVideoJob({
  env = {}, requestId, geminiKeys = [], supUrl, supKey, fetchImpl = globalThis.fetch, onFailure = () => {}
} = {}) {
  if (!requestId || !VIDEO_REQUEST_ID_RE.test(String(requestId)) || !supUrl || !supKey) return { status: 'not_found' };
  let job;
  try {
    job = await getVideoJobByRequestId({ supUrl, supKey, fetchImpl, requestId });
  } catch (e) {
    return { status: 'failed', jobId: null };
  }
  if (!job) return { status: 'not_found' };
  const jobId = job.id;
  if (job.status === 'done' && job.storage_path) {
    try {
      return { status: 'done', jobId, url: await signVideoUrl({ supUrl, supKey, fetchImpl, path: job.storage_path }) };
    } catch (e) {
      return { status: 'failed', jobId };
    }
  }
  if (job.status === 'reserved' || job.status === 'queued' || job.status === 'rendering') return { status: 'rendering', jobId };
  if (!videoGoogleAsync(env)) return { status: 'not_recoverable', jobId };
  if (job.provider === 'replicate' || !job.interaction_id || job.error_reason === 'safety_refused') return { status: 'not_recoverable', jobId };

  const before = job.error_reason || 'engine_error';
  try {
    const reopened = await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { status: 'rendering', error_reason: null }, onlyIfStatus: ['failed'] });
    if (!reopened.length) return { status: 'failed', jobId };
  } catch (e) {
    return { status: 'failed', jobId };
  }
  const polled = await pollVideoJob({ env, jobId, geminiKeys, supUrl, supKey, fetchImpl, onFailure, ignoreTimeout: true, pollErrorLimit: 1 });
  if (polled.status === 'done') return { status: 'done', jobId, url: polled.url };
  if (polled.status === 'refused') return { status: 'failed', jobId };
  if (polled.status === 'failed') return { status: 'failed', jobId };
  // Still rendering at Google (or no answer): back to failed with its
  // original reason, so the timeout sweep never sees it as open. The
  // operator can recheck again later.
  await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { status: 'failed', error_reason: before }, onlyIfStatus: ['rendering'] }).catch(() => {});
  return { status: 'rendering', jobId };
}

// --- the synchronous render ------------------------------------------------------
//
// Trigger. The chat (dispatchVideoRender, under waitUntil) POSTs to
// api/video-render.mjs with the header x-pg1-render-token:
//   <job id>.<expiry, ms since epoch>.<HMAC-SHA256, base64url>
// signed with PG1_VIDEO_RENDER_SECRET (or, when that is unset, CRON_SECRET)
// over "pg1-video-render.v1.<job id>.<expiry>". The render checks it in
// constant time and takes the job id from the token alone. No session,
// cookie or password is ever accepted there: a guest, a browser or anyone
// without a fresh token gets 401.

const RENDER_TOKEN_RE = /^([0-9a-f-]{36})\.(\d{13})\.([A-Za-z0-9_-]{43})$/;
const VIDEO_JOB_ID_RE = /^[0-9a-f-]{36}$/i;

export function videoRenderSecret(env = {}) {
  const v = String(env.PG1_VIDEO_RENDER_SECRET || env.CRON_SECRET || '').trim();
  return v.length >= 16 ? v : '';
}

// Where the render lives. PG1_VIDEO_RENDER_URL wins; otherwise the
// production domain in production (deployment protection never covers it)
// and this deployment's own URL elsewhere.
export function videoRenderUrl(env = {}) {
  const explicit = String(env.PG1_VIDEO_RENDER_URL || '').trim();
  if (explicit) return /^https:\/\/[^\s/]+\/\S*$/i.test(explicit) ? explicit : '';
  const host = String((env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL) || env.VERCEL_URL || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return host && /^[a-z0-9.-]+(?::\d+)?$/i.test(host) ? `https://${host}/api/video-render` : '';
}

function renderSignature(secret, jobId, exp) {
  return crypto.createHmac('sha256', secret).update(`pg1-video-render.v1.${jobId}.${exp}`).digest('base64url');
}

export function signRenderToken({ jobId, secret, now = Date.now(), ttlMs = VIDEO_RENDER_TOKEN_TTL_MS }) {
  if (!secret || !VIDEO_JOB_ID_RE.test(String(jobId || ''))) throw new Error('cannot sign a render token');
  const exp = Math.floor(now + ttlMs);
  return `${String(jobId).toLowerCase()}.${exp}.${renderSignature(secret, String(jobId).toLowerCase(), exp)}`;
}

// { ok: true, jobId } or { ok: false, reason }. Constant-time on the
// signature; an expired token, or one that claims to live longer than a
// token is ever signed for, is refused.
export function verifyRenderToken(token, { secret, now = Date.now(), ttlMs = VIDEO_RENDER_TOKEN_TTL_MS } = {}) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  const m = RENDER_TOKEN_RE.exec(String(token || '').trim());
  if (!m) return { ok: false, reason: 'malformed' };
  const [, jobId, expRaw, sig] = m;
  const exp = Number(expRaw);
  const expected = Buffer.from(renderSignature(secret, jobId, exp));
  const given = Buffer.from(sig);
  const match = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!match) return { ok: false, reason: 'bad_signature' };
  if (!(exp > now) || exp > now + ttlMs + 60 * 1000) return { ok: false, reason: 'expired' };
  return { ok: true, jobId };
}

// Sends the render request for a queued job and waits only for the
// render's answer to the claim (202, or 200 when there was nothing to
// claim). One retry on a network error or 5xx. If it never gets through,
// the queued job is failed at once (conditional on still being queued, so
// a render that did claim it is left alone). Resolves to { ok, status }.
export async function dispatchVideoRender({ env = {}, jobId, fetchImpl = globalThis.fetch, supUrl, supKey, now = () => Date.now(), onFailure = () => {}, requestId = null, timeoutMs = 15000 } = {}) {
  const report = (reason, status, detail) => {
    try { onFailure({ reason, status: status == null ? null : status, detail: String(detail || 'no detail') }); } catch (e) { /* never breaks the reply */ }
  };
  const url = videoRenderUrl(env);
  const secret = videoRenderSecret(env);
  let last = 'not configured';
  let lastStatus = null;
  if (url && secret) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const headers = { 'Content-Type': 'application/json', [VIDEO_RENDER_TOKEN_HEADER]: signRenderToken({ jobId, secret, now: now() }) };
      const bypass = String(env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
      if (bypass) headers['x-vercel-protection-bypass'] = bypass;
      try {
        const res = await fetchWithTimeout(fetchImpl, url, { method: 'POST', headers, body: JSON.stringify({ jobId }), cache: 'no-store' }, timeoutMs);
        lastStatus = res.status;
        if (res.status === 202 || res.status === 200) return { ok: true, status: res.status };
        last = `render answered ${res.status}`;
        if (res.status < 500) break;
      } catch (e) {
        last = e && e.name === 'AbortError' ? 'timed out' : String(e && e.message);
      }
    }
  }
  report('video_render_dispatch_failed', lastStatus, `request_id=${requestId} job=${jobId} could not trigger the render: ${last}`);
  if (supUrl && supKey) {
    await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { status: 'failed', error_reason: 'render_not_started', error_detail: `render trigger failed: ${last}` }, onlyIfStatus: ['queued'] }).catch(() => {});
  }
  return { ok: false, status: lastStatus };
}

// The atomic claim: queued -> rendering, only for a job queued within
// VIDEO_QUEUE_CLAIM_WINDOW_MS. Resolves to the claimed row or null (already
// claimed, finished, failed, too old or missing). Throws when the database
// cannot be reached.
export async function claimVideoJob({ supUrl, supKey, fetchImpl = globalThis.fetch, jobId, now = () => Date.now() }) {
  if (!VIDEO_JOB_ID_RE.test(String(jobId || ''))) return null;
  const rows = await updateVideoJob({
    supUrl, supKey, fetchImpl, id: jobId,
    patch: { status: 'rendering', render_started_at: new Date(now()).toISOString() },
    onlyIfStatus: ['queued'],
    createdAfter: new Date(now() - VIDEO_QUEUE_CLAIM_WINDOW_MS).toISOString()
  });
  return rows[0] || null;
}

// The engine's words, cut to size and with any configured key taken out,
// for error_detail.
function rowDetail(text, keys = []) {
  let t = String(text || '');
  for (const k of keys) if (k && k.length >= 8) t = t.split(k).join('[key]');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > 500 ? t.slice(0, 499) + '…' : t;
}

const REPLICATE_POLL_MS = 5000;
// Kept back from the deadline for the download, the upload and the row.
const RENDER_RESERVE_MS = 60 * 1000;
const MIN_ATTEMPT_MS = 20 * 1000;

// Renders a job the caller has claimed (claimVideoJob). Every Gemini key in
// turn, POST /v1beta/interactions with background: false, then Replicate
// (started and waited for here). Never a GET to /interactions/{id}. Only a
// provider failure moves on (classifyVideoFailure; "Multiple
// authentication credentials" counts as one). Each attempt logs the key's
// format, never the key. Works on the one row: no second reservation.
// Resolves to { status: 'done', path } | { status: 'failed', reason }
// | { status: 'refused' }. Never throws.
export async function renderVideoJob({
  env = {}, job, geminiKeys = [], supUrl, supKey, fetchImpl = globalThis.fetch,
  now = () => Date.now(), deadline = Date.now() + (VIDEO_RENDER_MAX_DURATION_S - 15) * 1000,
  onFailure = () => {}, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
} = {}) {
  const jobId = job && job.id;
  const requestId = (job && job.request_id) || null;
  const report = (reason, status, detail) => {
    try { onFailure({ reason, status: status == null ? null : status, detail: String(detail || 'no detail'), requestId }); } catch (e) { /* never breaks the render */ }
  };
  const say = (line) => { try { log(line); } catch (e) { /* never breaks the render */ } };
  const tier = VIDEO_TIERS.includes(job && job.tier) ? job.tier : DEFAULT_VIDEO_TIER;
  const durationS = job && Number(job.duration_s) === 10 ? 10 : 5;
  const fail = async (errorReason, detail) => {
    await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { status: 'failed', error_reason: errorReason, error_detail: rowDetail(detail, geminiKeys) }, onlyIfStatus: ['rendering'] }).catch(() => {});
    return errorReason === 'safety_refused' ? { status: 'refused' } : { status: 'failed', reason: errorReason };
  };
  if (!jobId || !supUrl || !supKey) return { status: 'failed', reason: 'not_configured' };

  let image = null;
  if (job.start_frame_path) {
    try {
      image = await readStartFrame({ supUrl, supKey, fetchImpl, path: job.start_frame_path });
    } catch (e) {
      report('video_store_failed', null, `request_id=${requestId} could not read the starting frame: ${e && e.message}`);
      return fail('start_failed', `could not read the starting frame: ${e && e.message}`);
    }
  }
  const prompt = String(job.prompt || '');
  const model = job.provider === 'google' && job.model ? job.model : videoModel(env);
  const delivery = videoDelivery(tier, durationS);
  const body = buildVideoRequestBody({ model, prompt, image, tier, durationS, background: false, delivery });

  // clip: { data } or { uri, googleKey } or { uri } (Replicate).
  let clip = null;
  let done = null;
  let lastDetail = 'no engine key configured';
  for (let k = 0; k < geminiKeys.length && !clip; k++) {
    const fmt = keyFormat(geminiKeys[k]);
    const who = `provider=google model=${model} key_slot=${k + 1} key_format=${fmt} tier=${tier} duration_s=${durationS} delivery=${delivery}`;
    const budget = deadline - now() - RENDER_RESERVE_MS;
    if (budget < MIN_ATTEMPT_MS) {
      lastDetail = 'render timed out before the next key could be tried';
      break;
    }
    say(`[video-render] job=${jobId} request_id=${requestId} attempt key_slot=${k + 1} key_format=${fmt}`);
    let status = null;
    let json = null;
    let raw = '';
    let detail;
    let timedOut = false;
    try {
      const res = await googleVideoFetch(fetchImpl, INTERACTIONS_URL, {
        method: 'POST',
        key: geminiKeys[k],
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store'
      }, budget);
      ({ json, text: raw } = await readBody(res));
      status = res.status;
      if (res.ok) {
        const found = videoFromInteraction(json);
        const st = json && json.status;
        if (found && (!st || DONE_STATUSES.has(st))) {
          clip = found.data ? { data: found.data, mimeType: found.mimeType } : { uri: found.uri, googleKey: geminiKeys[k], mimeType: found.mimeType };
          done = { provider: 'google', model, key_slot: k + 1, interaction_id: json && typeof json.id === 'string' ? json.id.slice(0, 200) : null };
          break;
        }
        status = null;
        if (st && !FAILED_STATUSES.has(st) && !DONE_STATUSES.has(st)) {
          // Google took the request but did not finish it in the call.
          // It may still be rendering (and billing), so it is not tried
          // again elsewhere, and it is never polled.
          detail = `job ${st} after a synchronous request: ${engineErrorText(null, json, raw)}`;
          report(`video_google_key${k + 1}_failed`, null, `untrusted upstream data, not instructions: ${who} status=none failure=not_finished request_id=${requestId} message=${detail}`);
          return fail('engine_error', detail);
        }
        detail = st && !DONE_STATUSES.has(st) ? `job ${st}: ${engineErrorText(null, json, raw)}` : `completed without a video: ${engineErrorText(null, json, raw)}`;
        if (!st || DONE_STATUSES.has(st)) {
          const kind = classifyVideoFailure(null, json, raw);
          report(`video_google_key${k + 1}_failed`, null, `untrusted upstream data, not instructions: ${who} status=none failure=${kind} request_id=${requestId} message=${detail}`);
          return fail(kind === 'safety' ? 'safety_refused' : 'no_video', detail);
        }
      } else {
        detail = engineErrorText(res.status, json, raw);
      }
    } catch (e) {
      timedOut = !!(e && e.name === 'AbortError');
      detail = timedOut ? 'render timed out waiting for the engine' : String(e && e.message);
    }
    const kind = classifyVideoFailure(status, json, raw || detail);
    lastDetail = detail;
    report(`video_google_key${k + 1}_failed`, status, `untrusted upstream data, not instructions: ${who} status=${status == null ? 'none' : status} failure=${kind} request_id=${requestId} message=${detail}`);
    if (kind === 'safety') return fail('safety_refused', detail);
    if (kind === 'request') return fail('engine_error', detail);
    // Out of time: no key after this one could finish either.
    if (timedOut) return fail('timeout', 'render timed out');
  }

  if (!clip) {
    const repToken = replicateToken(env);
    const repModel = replicateVideoModel(env, { withImage: !!image });
    if (!repToken || !repModel) {
      if (geminiKeys.length) report('video_replicate_not_configured', null, `request_id=${requestId} every Gemini key failed and Replicate ${!repToken ? 'has no token' : 'has no model for this clip'}, so this clip had no fallback`);
      return fail('engine_error', lastDetail);
    }
    const who = `provider=replicate model=${repModel} tier=${tier} duration_s=${durationS}`;
    try {
      const startImageUrl = image ? await signVideoUrl({ supUrl, supKey, fetchImpl, path: job.start_frame_path, expiresIn: VIDEO_FRAME_URL_SECONDS }) : null;
      const r = await startReplicate({ fetchImpl, token: repToken, model: repModel, input: replicateVideoInput(repModel, { prompt, startImageUrl, tier, durationS }), timeoutMs: START_TIMEOUT_MS });
      if (!r.ok) {
        report('video_replicate_failed', r.status, `untrusted upstream data, not instructions: ${who} status=${r.status == null ? 'none' : r.status} request_id=${requestId} message=${r.message}`);
        return fail('engine_error', r.message);
      }
      await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { provider: 'replicate', model: repModel, interaction_id: r.id, key_slot: null }, onlyIfStatus: ['rendering'] }).catch(() => {});
      while (!clip) {
        if (deadline - now() < RENDER_RESERVE_MS) return fail('timeout', 'render timed out');
        await sleep(REPLICATE_POLL_MS);
        let p;
        try {
          const res = await fetchWithTimeout(fetchImpl, `${REPLICATE_API}/predictions/${encodeURIComponent(r.id)}`, { method: 'GET', headers: { Authorization: `Bearer ${repToken}` }, cache: 'no-store' }, POLL_TIMEOUT_MS);
          const b = await readBody(res);
          if (!res.ok) {
            if (res.status === 429 || res.status >= 500) continue;
            report('video_replicate_failed', res.status, `untrusted upstream data, not instructions: ${who} status=${res.status} request_id=${requestId} message=${String(b.text).slice(0, 200)}`);
            return fail('engine_error', String(b.text).slice(0, 200));
          }
          p = b.json || {};
        } catch (e) {
          continue;
        }
        if (REPLICATE_FAILED.has(p.status)) {
          report('video_replicate_failed', null, `untrusted upstream data, not instructions: ${who} prediction=${p.status} request_id=${requestId} message=${String(p.error || '').slice(0, 200)}`);
          return fail('engine_error', `prediction ${p.status}: ${String(p.error || '').slice(0, 200)}`);
        }
        if (!REPLICATE_DONE.has(p.status)) continue;
        const out = Array.isArray(p.output) ? p.output.find((o) => typeof o === 'string') : p.output;
        if (typeof out !== 'string' || !/^https:\/\//i.test(out)) return fail('no_video', 'succeeded without a video link');
        clip = { uri: out, mimeType: 'video/mp4' };
        done = { provider: 'replicate', model: repModel, key_slot: null, interaction_id: r.id };
      }
    } catch (e) {
      report('video_replicate_failed', null, `untrusted upstream data, not instructions: ${who} status=none request_id=${requestId} message=${e && e.message}`);
      return fail('engine_error', String(e && e.message));
    }
  }

  let bytes;
  try {
    if (clip.data) {
      bytes = new Uint8Array(Buffer.from(clip.data, 'base64'));
    } else {
      let host = '';
      try { host = new URL(clip.uri).hostname; } catch (e) { host = ''; }
      if (!/^https:\/\//i.test(clip.uri) || !host) throw new Error('video link is not https');
      // A Google link goes through googleVideoFetch: no ?key= in it, the
      // key (header only) only to Google's own API host. It is the file's
      // link, never the interaction.
      const dl = done.provider === 'google'
        ? await googleVideoFetch(fetchImpl, clip.uri, { key: clip.googleKey }, DOWNLOAD_TIMEOUT_MS)
        : await fetchWithTimeout(fetchImpl, clip.uri, {}, DOWNLOAD_TIMEOUT_MS);
      if (!dl.ok) throw new Error(`download ${dl.status}`);
      bytes = new Uint8Array(await dl.arrayBuffer());
    }
    if (!bytes || !bytes.byteLength) throw new Error('empty video');
  } catch (e) {
    report(`video_${done.provider}_failed`, null, `request_id=${requestId} could not fetch the finished video: ${e && e.message}`);
    return fail('download_failed', `could not fetch the finished video: ${e && e.message}`);
  }

  const path = videoStoragePath(jobId);
  try {
    await uploadVideo({ supUrl, supKey, fetchImpl, path, bytes, mimeType: /^video\//.test(clip.mimeType) ? clip.mimeType : 'video/mp4' });
    const rows = await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { status: 'done', storage_path: path, error_reason: null, error_detail: null, ...done }, onlyIfStatus: ['rendering'] });
    if (!rows.length) throw new Error('job is no longer rendering');
  } catch (e) {
    report('video_store_failed', null, `request_id=${requestId} could not store the finished clip: ${e && e.message}`);
    return fail('store_failed', `could not store the finished clip: ${e && e.message}`);
  }
  say(`[video-render] job=${jobId} request_id=${requestId} done provider=${done.provider}${done.key_slot ? ` key_slot=${done.key_slot}` : ''}`);
  return { status: 'done', path };
}

// The card's status action while the render is synchronous: reads only the
// pg1_video_jobs row (and signs the stored clip), never the engine.
// Resolves like pollVideoJob: { status: 'rendering' } | { status: 'done',
// url } | { status: 'failed', requestId } | { status: 'refused', requestId }
// | { status: 'not_found' }. Never throws.
export async function videoJobStatus({ jobId, supUrl, supKey, fetchImpl = globalThis.fetch, now = () => Date.now(), onFailure = () => {} } = {}) {
  const report = (reason, status, detail, requestId) => {
    try { onFailure({ reason, status: status == null ? null : status, detail: String(detail || 'no detail'), requestId }); } catch (e) { /* never breaks the poll */ }
  };
  if (!jobId || !VIDEO_JOB_ID_RE.test(String(jobId))) return { status: 'not_found' };
  if (!supUrl || !supKey) return { status: 'failed', requestId: null };
  let job;
  try {
    job = await getVideoJob({ supUrl, supKey, fetchImpl, id: jobId });
  } catch (e) {
    return { status: 'rendering' };
  }
  if (!job) return { status: 'not_found' };
  const requestId = job.request_id || null;
  if (job.status === 'done' && job.storage_path) {
    try {
      return { status: 'done', url: await signVideoUrl({ supUrl, supKey, fetchImpl, path: job.storage_path }) };
    } catch (e) {
      report('video_store_failed', null, `could not sign the stored clip: ${e && e.message}`, requestId);
      return { status: 'rendering' };
    }
  }
  if (job.status === 'failed') return { status: job.error_reason === 'safety_refused' ? 'refused' : 'failed', requestId };

  const expire = async (fromStatus, errorReason, detail) => {
    report('video_timeout', null, `request_id=${requestId} job=${jobId} ${detail}`, requestId);
    const rows = await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { status: 'failed', error_reason: errorReason, error_detail: detail }, onlyIfStatus: [fromStatus] }).catch(() => null);
    // Changed meanwhile (the render finished or claimed it): ask again.
    if (Array.isArray(rows) && !rows.length) return { status: 'rendering' };
    return { status: 'failed', requestId };
  };
  const t = now();
  const age = t - Date.parse(job.created_at);
  if (job.status === 'rendering' && job.render_started_at) {
    const rendering = t - Date.parse(job.render_started_at);
    if (Number.isFinite(rendering) && rendering > VIDEO_RENDER_TIMEOUT_MS) return expire('rendering', 'timeout', 'render timed out');
    return { status: 'rendering' };
  }
  if (job.status === 'queued') {
    if (Number.isFinite(age) && age > VIDEO_QUEUE_TIMEOUT_MS) return expire('queued', 'render_not_started', 'render never started');
    return { status: 'rendering' };
  }
  if (Number.isFinite(age) && age > VIDEO_JOB_TIMEOUT_MS) return expire(job.status, 'timeout', 'render timed out');
  return { status: 'rendering' };
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
