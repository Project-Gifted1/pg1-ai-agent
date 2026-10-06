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
// Clips are 3 to 10 seconds; the prompt sets the length. The cost is
// counted as 10 s each, about VIDEO_COST_USD_PER_CLIP at 720p.
//
// Cap. PG1_VIDEO_DAILY_CAP clips per UTC day (default 3). The slot is
// reserved by the database function pg1_reserve_video_slot (an advisory
// lock per day, so two requests at once cannot both take the last slot)
// before the engine is called, and a clip that fails still used its slot.
//
// Switch. Nothing here runs unless PG1_VIDEO_ENABLED=1. Only the signed-in
// operator can ask for a clip; guests never can.
//
// Branding. The reply, the trace and the cards only ever say "PG1 Motion".
// The model, the provider and the engine's own error text go to pg1_errors
// under the request ID (onFailure), never into the reply.

import { VIDEO_ENGINE_LABEL, VIDEO_TOOL, MAX_VIDEO_PROMPT_CHARS, mentionsVideo, videosLeftText } from './videoText.mjs';

export { VIDEO_ENGINE_LABEL, VIDEO_TOOL, MAX_VIDEO_PROMPT_CHARS, mentionsVideo, videosLeftText };
export const DEFAULT_VIDEO_MODEL = 'gemini-omni-1.1-flash';
export const DEFAULT_VIDEO_DAILY_CAP = 3;
export const VIDEO_JOB_TIMEOUT_MS = 15 * 60 * 1000;
export const VIDEO_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;
export const VIDEO_COST_USD_PER_CLIP = 1.0;
export const VIDEO_ASSUMED_SECONDS = 10;
export const VIDEO_BUCKET = 'pg1-vault';
export const VIDEO_FOLDER = 'videos';
export const VIDEO_TABLE = 'pg1_video_jobs';
export const VIDEO_RESERVE_RPC = 'pg1_reserve_video_slot';
export const VIDEO_RESPONSE_FORMAT = Object.freeze({ type: 'video', resolution: '720p', aspect_ratio: '16:9', delivery: 'uri' });

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

// A whole number of clips, 0 or more. Anything unreadable is the default.
export function videoDailyCap(env = {}) {
  const raw = String(env.PG1_VIDEO_DAILY_CAP == null ? '' : env.PG1_VIDEO_DAILY_CAP).trim();
  if (!/^\d{1,3}$/.test(raw)) return DEFAULT_VIDEO_DAILY_CAP;
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
const VIDEO_ADJ = '(?:short|quick|little|brief|small|cinematic|slow[- ]?motion|realistic|animated|looping|cool|fun|new|simple|hd|720p|\\d{1,2}[- ]?(?:s|sec|secs|second|seconds))';
const VIDEO_NOUN = '(?:video|clip|animation)';
const VIDEO_REQUEST_RE = new RegExp(
  `\\b${VIDEO_VERB}\\s+(?:(?:me|us)\\s+)?(?:(?:a|an|one|another)\\s+)?(?:${VIDEO_ADJ}[\\s,]+){0,3}${VIDEO_NOUN}\\s*(?:$|[:\\-–—]|(?:of|showing|that\\s+shows|where|in\\s+which|with)\\b)`,
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
  t = t.replace(new RegExp(`^(?:please\\s+|can\\s+you\\s+|could\\s+you\\s+|pg1,?\\s+)*${VIDEO_VERB}\\s+(?:(?:me|us)\\s+)?(?:(?:a|an|one|another)\\s+)?((?:${VIDEO_ADJ}[\\s,]+){0,3})${VIDEO_NOUN}\\s*(?:of|showing|that\\s+shows|where|in\\s+which|with)?[:\\s\\-–—]*`, 'i'), (m, adj) => {
    // Keep a stated length ("a 6 second video of..."): it sets the clip length.
    const length = String(adj || '').match(/\d{1,2}[- ]?(?:s|sec|secs|second|seconds)\b/i);
    return length ? `${length[0]} clip: ` : '';
  });
  t = t.replace(/^(?:please\s+)?animate\s+(?:this|the|my|that|an?|attached)\s+(?:(?:attached|uploaded)\s+)?(?:image|picture|photo|pic|frame|drawing|illustration|logo|still|screenshot)\b[,:\s-]*/i, '');
  t = t.replace(/^(?:please\s+)?(?:turn|make)\s+(?:this|the|my|that)\s+(?:image|picture|photo|pic)\s+into\s+(?:a\s+)?(?:video|clip|animation)\b[,:\s-]*/i, '');
  t = t.replace(/[\s?!.]+$/, '').trim();
  return t.slice(0, MAX_VIDEO_PROMPT_CHARS);
}

export const DEFAULT_START_FRAME_PROMPT = 'Bring this image to life with gentle, natural motion and a slow camera move.';

// --- the request ---------------------------------------------------------------

// The body PG1 sends to start a job. `image` is an optional starting frame:
// { mimeType, data } (base64), PNG, JPEG or WebP.
export function buildVideoRequestBody({ model, prompt, image = null } = {}) {
  const text = String(prompt || '').slice(0, MAX_VIDEO_PROMPT_CHARS);
  const frame = image && START_FRAME_TYPES.has(String(image.mimeType || '').toLowerCase()) && typeof image.data === 'string' && image.data
    ? { type: 'image', data: image.data, mime_type: String(image.mimeType).toLowerCase() }
    : null;
  return {
    model,
    input: frame ? [{ type: 'text', text }, frame] : text,
    response_format: { ...VIDEO_RESPONSE_FORMAT },
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

// Takes one of today's slots. Resolves to { reserved, jobId, used, cap }.
// Throws when the database cannot be reached: no slot, no engine call.
export async function reserveVideoSlot({ supUrl, supKey, fetchImpl = globalThis.fetch, prompt, cap, requestId = null, hasStartFrame = false }) {
  const res = await fetchWithTimeout(fetchImpl, `${supUrl}/rest/v1/rpc/${VIDEO_RESERVE_RPC}`, {
    method: 'POST',
    headers: dbHeaders(supKey),
    body: JSON.stringify({ p_prompt: String(prompt || '').slice(0, MAX_VIDEO_PROMPT_CHARS), p_cap: cap, p_request_id: requestId, p_has_start_frame: !!hasStartFrame }),
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
  return { reserved: row.reserved === true, jobId: row.job_id || null, used: Number(row.used) || 0, cap: Number(row.daily_cap != null ? row.daily_cap : cap) };
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
export async function videosUsedToday({ supUrl, supKey, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const day = new Date(now()).toISOString().slice(0, 10);
  const res = await fetchWithTimeout(fetchImpl, `${supUrl}/rest/v1/${VIDEO_TABLE}?day=eq.${day}&select=id`, {
    method: 'GET',
    headers: dbHeaders(supKey),
    cache: 'no-store'
  }, 8000);
  if (!res.ok) throw new Error(`count failed: ${res.status}`);
  const { json } = await readBody(res);
  return Array.isArray(json) ? json.length : 0;
}

export function videoStoragePath(jobId) {
  return `${VIDEO_FOLDER}/${jobId}.mp4`;
}

// A link to the stored clip that works for VIDEO_SIGNED_URL_SECONDS.
export async function signVideoUrl({ supUrl, supKey, fetchImpl = globalThis.fetch, path }) {
  const res = await fetchWithTimeout(fetchImpl, `${supUrl}/storage/v1/object/sign/${VIDEO_BUCKET}/${path}`, {
    method: 'POST',
    headers: dbHeaders(supKey),
    body: JSON.stringify({ expiresIn: VIDEO_SIGNED_URL_SECONDS }),
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

// --- starting a job ------------------------------------------------------------

// Resolves to one of
//   { ok: true, jobId, used, cap, remaining }
//   { ok: false, code: 'disabled' | 'not_configured' | 'empty_prompt'
//                    | 'cap_reached' | 'reserve_failed' | 'start_failed',
//     used?, cap?, remaining? }
// Never throws. Every failure after the slot was reserved still counts.
// onFailure({ reason, status, detail }) gets the operator-only detail (model,
// key slot, the engine's own error text) for pg1_errors.
export async function startVideoJob({
  env = {}, prompt, image = null, geminiKeys = [], supUrl, supKey, requestId = null,
  fetchImpl = globalThis.fetch, onFailure = () => {}, startTimeoutMs = START_TIMEOUT_MS
} = {}) {
  const report = (reason, status, detail) => {
    try { onFailure({ reason, status: status == null ? null : status, detail: String(detail || 'no detail') }); } catch (e) { /* logging never breaks the reply */ }
  };
  if (!videoEnabled(env)) return { ok: false, code: 'disabled' };
  const cap = videoDailyCap(env);
  const text = String(prompt || '').trim();
  if (!text) return { ok: false, code: 'empty_prompt', cap };
  if (!supUrl || !supKey || !geminiKeys.length) {
    report('video_not_configured', null, `missing ${[!supUrl || !supKey ? 'database' : '', !geminiKeys.length ? 'engine key' : ''].filter(Boolean).join(' and ')}`);
    return { ok: false, code: 'not_configured', cap };
  }

  let slot;
  try {
    slot = await reserveVideoSlot({ supUrl, supKey, fetchImpl, prompt: text, cap, requestId, hasStartFrame: !!image });
  } catch (e) {
    report('video_reserve_failed', e && e.status, e && e.message);
    return { ok: false, code: 'reserve_failed', cap };
  }
  const remaining = Math.max(0, slot.cap - slot.used);
  if (!slot.reserved || !slot.jobId) return { ok: false, code: 'cap_reached', used: slot.used, cap: slot.cap, remaining: 0 };

  const model = videoModel(env);
  const body = buildVideoRequestBody({ model, prompt: text, image });
  const markFailed = (reason) => updateVideoJob({ supUrl, supKey, fetchImpl, id: slot.jobId, patch: { status: 'failed', error_reason: reason }, onlyIfStatus: ['reserved'] }).catch(() => {});

  // Keys in order; only a key-specific refusal (401, 403, 429) moves on to
  // the next one. Anything else is the engine's answer for the job.
  let lastStatus = null;
  let lastDetail = '';
  for (let k = 0; k < geminiKeys.length; k++) {
    try {
      const res = await fetchWithTimeout(fetchImpl, INTERACTIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKeys[k] },
        body: JSON.stringify(body),
        cache: 'no-store'
      }, startTimeoutMs);
      const { json, text: raw } = await readBody(res);
      if (res.ok && json && typeof json.id === 'string' && json.id) {
        if (FAILED_STATUSES.has(json.status)) {
          lastStatus = res.status;
          lastDetail = `job ${json.status}: ${engineErrorText(null, json, raw)}`;
          break;
        }
        try {
          await updateVideoJob({ supUrl, supKey, fetchImpl, id: slot.jobId, patch: { status: 'rendering', interaction_id: json.id, key_slot: k + 1 }, onlyIfStatus: ['reserved'] });
        } catch (e) {
          // The engine is rendering but the row could not say so: the clip
          // cannot be collected. Fail it (it keeps its slot) and say so.
          report('video_store_failed', null, `provider=google model=${model} key_slot=${k + 1} request_id=${requestId} could not record the started job: ${e && e.message}`);
          await markFailed('record_failed');
          return { ok: false, code: 'start_failed', used: slot.used, cap: slot.cap, remaining };
        }
        return { ok: true, jobId: slot.jobId, used: slot.used, cap: slot.cap, remaining };
      }
      lastStatus = res.status;
      lastDetail = res.ok ? `no job id in response: ${String(raw).slice(0, 160)}` : engineErrorText(res.status, json, raw);
      if (![401, 403, 429].includes(res.status)) break;
    } catch (e) {
      lastStatus = null;
      lastDetail = e && e.name === 'AbortError' ? 'timed out starting the job' : String(e && e.message);
      break;
    }
  }
  report('video_start_failed', lastStatus, `provider=google model=${model} status=${lastStatus == null ? 'none' : lastStatus} request_id=${requestId} message=${lastDetail}`);
  await markFailed('start_failed');
  return { ok: false, code: 'start_failed', used: slot.used, cap: slot.cap, remaining };
}

// --- polling a job ---------------------------------------------------------------

// Resolves to { status: 'rendering' } | { status: 'done', url }
// | { status: 'failed', requestId } | { status: 'not_found' }. Never throws.
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
  const model = videoModel(env);

  if (job.status === 'done' && job.storage_path) {
    try {
      return { status: 'done', url: await signVideoUrl({ supUrl, supKey, fetchImpl, path: job.storage_path }) };
    } catch (e) {
      report('video_store_failed', null, `could not sign the stored clip: ${e && e.message}`, requestId);
      return { status: 'rendering' };
    }
  }
  if (job.status === 'failed') return { status: 'failed', requestId };

  const fail = async (reason, status, detail, errorReason) => {
    report(reason, status, detail, requestId);
    await updateVideoJob({ supUrl, supKey, fetchImpl, id: jobId, patch: { status: 'failed', error_reason: errorReason }, onlyIfStatus: ['reserved', 'rendering'] }).catch(() => {});
    return { status: 'failed', requestId };
  };

  const age = now() - Date.parse(job.created_at);
  if (Number.isFinite(age) && age > VIDEO_JOB_TIMEOUT_MS) {
    return fail('video_timeout', null, `provider=google model=${model} request_id=${requestId} job not finished after ${Math.round(VIDEO_JOB_TIMEOUT_MS / 60000)} minutes`, 'timeout');
  }
  if (job.status !== 'rendering' || !job.interaction_id) return { status: 'rendering' };

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
    return fail('video_render_failed', res.status, `provider=google model=${model} status=${res.status} request_id=${requestId} message=${engineErrorText(res.status, body.json, body.text)}`, 'engine_error');
  }
  const interaction = body.json || {};
  if (FAILED_STATUSES.has(interaction.status)) {
    return fail('video_render_failed', null, `provider=google model=${model} job=${interaction.status} request_id=${requestId} message=${engineErrorText(null, interaction, body.text)}`, 'engine_error');
  }
  if (!DONE_STATUSES.has(interaction.status)) return { status: 'rendering' };

  const clip = videoFromInteraction(interaction);
  if (!clip) {
    return fail('video_render_failed', null, `provider=google model=${model} request_id=${requestId} completed without a video: ${engineErrorText(null, interaction, body.text)}`, 'no_video');
  }

  let bytes;
  try {
    if (clip.data) {
      bytes = new Uint8Array(Buffer.from(clip.data, 'base64'));
    } else {
      // The key only ever goes to Google's own API host, never to a link on
      // any other host.
      let host = '';
      try { host = new URL(clip.uri).hostname; } catch (e) { host = ''; }
      if (!/^https:\/\//i.test(clip.uri) || !host) throw new Error('video link is not https');
      const dl = await fetchWithTimeout(fetchImpl, clip.uri, { headers: host === GOOGLE_API_HOST ? { 'x-goog-api-key': key } : {} }, DOWNLOAD_TIMEOUT_MS);
      if (!dl.ok) throw new Error(`download ${dl.status}`);
      bytes = new Uint8Array(await dl.arrayBuffer());
    }
    if (!bytes || !bytes.byteLength) throw new Error('empty video');
  } catch (e) {
    return fail('video_render_failed', null, `provider=google model=${model} request_id=${requestId} could not fetch the finished video: ${e && e.message}`, 'download_failed');
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
export const VIDEO_EMPTY_PROMPT_TEXT = 'Say what the video should show, for example: /video a gold shield turning slowly on a dark background.';

export function videoCapReachedText(cap) {
  return `Today's video limit is reached (${cap} of ${cap} used). It resets at midnight UTC.`;
}

export function videoRenderingText(remaining, cap) {
  return `Rendering video… It appears here when it is ready, usually within a few minutes. ${videosLeftText(remaining, cap)}`;
}
