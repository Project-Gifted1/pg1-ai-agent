// What the operator sees when something behind a reply fails, and where the
// real reason goes.
//
// PG1 shows no third-party branding of its own (lib/identity.mjs), and that
// includes its error messages: a failed reply used to read "Execution
// failed. Model Err: [gemini-x] 429: ..." or "Anthropic API 529: ...",
// naming the provider, the model and echoing whatever the upstream service
// said. Now every user-facing failure is one short, fixed, neutral sentence
// plus the request ID, and the full upstream detail (provider, model, HTTP
// status, response text) goes to the error log only - the console line and
// the pg1_errors row (lib/errorLog.mjs), both keyed by the same request ID,
// so the operator can look the failure up from the ERROR LOG panel ("req:"
// label) without the chat ever repeating it.

import { logApiError } from './errorLog.mjs';
import { redactTraceText } from './chatStream.mjs';

// The fixed sentences. `kind` picks one; anything unknown reads as 'reply'.
export const FAILURE_PREFIX = 'Execution failed.';

const FAILURE_TEXT = Object.freeze({
  // the model call behind a chat reply failed on every attempt
  reply: 'The reply could not be generated right now. Please try again.',
  // the handler itself threw (the old "Exception: <message>" fallback)
  request: 'Something went wrong while handling this request. Please try again.',
  // the one-shot voice pipeline (SPEAK) could not synthesize audio
  voice: 'The voice reply could not be generated right now.',
  // every /image engine failed (lib/imageEngines.mjs)
  image: 'The image could not be generated right now. Please try again.',
  // a PG1 Motion clip could not be started or did not finish (lib/videoJobs.mjs)
  video: 'The video could not be generated right now. Please try again.'
});

// A reply-sized neutral message: fixed text, then the request ID.
export function userFacingFailure(requestId, kind = 'reply') {
  const text = FAILURE_TEXT[kind] || FAILURE_TEXT.reply;
  const ref = requestId ? ` Request ID: ${requestId}` : '';
  return `${FAILURE_PREFIX} ${text}${ref}`;
}

// A status-token-sized neutral value for fields the client shows verbatim
// (SPEAK's audioStatus, which public/index.html flashes as "Voice
// unavailable (<status>)"). Fixed words only, never upstream text.
export const VOICE_FAILURE_STATUS = 'VOICE_ERROR';

// Names and hosts a user-facing message must never carry. Used by the tests
// and exported so a future message can be checked against the same list.
// The boundaries treat "_" as a separator too (so "CARTESIA_ERROR_401" is
// caught, which \b would miss), and a model id is caught by its vendor
// prefix ("gemini-3.8-flash", "claude-sonnet-5"), so a model bump never
// slips a new name through. The image engines' own names (imagen, flux,
// nano banana, pollinations) are on it too.
export const UPSTREAM_BRAND_RE = /(?<![a-z0-9])(?:gemini|google|googleapis|generativelanguage|anthropic|claude|openai|chatgpt|gpt|cartesia|replicate|vertex|bedrock|sonic|imagen|veo|flux|nano[\s_-]*banana|pollinations)(?![a-z0-9])/i;

// The provider's own reason out of a failed response body, for the error
// log: "400 INVALID_ARGUMENT: Invalid JSON payload received. Unknown name
// ..." rather than the first bytes of pretty-printed JSON, which used to
// cut off before the message. Reads Gemini's { error: { code, status,
// message } } and Anthropic's { error: { type, message } }; anything else
// is the raw text, flattened. Secrets are stripped later, in
// reportUpstreamFailure, like every other detail.
export function providerErrorText(status, body, max = 240) {
  const raw = String(body == null ? '' : body);
  let text = '';
  try {
    const err = JSON.parse(raw).error;
    if (err && typeof err === 'object' && typeof err.message === 'string') {
      const kind = err.status || err.type || '';
      text = `${status}${kind ? ' ' + kind : ''}: ${err.message}`;
    }
  } catch (e) {
    // not JSON: fall through to the raw text
  }
  if (!text) text = `${status}: ${raw}`;
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// Keeps the full detail where only the operator's error log can see it.
// `detail` is the raw upstream text (model, status, response body, exception
// message); secrets in it are stripped (API keys could echo back in an
// upstream error body) and it is flattened to one line before it is written
// anywhere. Fire-and-forget: a logging failure never touches the reply.
//
// `status` is the upstream HTTP status when there is one (the image engines
// pass it, so a 404 and a 429 land in separate rows); otherwise null.
export function reportUpstreamFailure({ supUrl, supKey, route, reason, detail, requestId, status = null, envValues = [], log = console.error } = {}) {
  const clean = redactTraceText(detail || 'no detail', envValues, 300);
  try {
    log(`[chat] ${reason} request_id=${requestId || '-'} route=${route || '-'} detail=${clean}`);
  } catch (e) {
    // a broken console must not break the reply
  }
  if (!supUrl || !supKey) return Promise.resolve();
  return logApiError(supUrl, supKey, {
    source: 'server',
    route,
    // The reply itself went out as 200 (or as a stream "error" event), so
    // unless the caller passes the upstream's status the row carries null,
    // same as api/mcp.mjs's upstream timeouts.
    status: typeof status === 'number' ? status : null,
    reason,
    message: clean,
    category: reason === 'chat_exception' ? 'js_error' : 'upstream',
    requestId
  }).catch(() => {});
}
