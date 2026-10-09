/**
 * Image engines and system-text branding (lib/imageEngines.mjs, the
 * GENERATE_IMAGE path in api/chat.mjs):
 *  - no system-generated text (image reply, trace labels, status lines,
 *    failure messages) names a provider, model or engine, on the image path
 *    and every fallback, the vision path, the chat model fallback and TTS;
 *    model-written answers are out of scope (PG1 may still talk about Gemini)
 *  - each failed engine attempt lands in pg1_errors with provider, model,
 *    status, message and request_id, framed as untrusted data, and not in
 *    the reply
 *  - total failure is one neutral sentence plus the request ID
 *  - the circuit breaker skips an engine/key after a 404 or 429 for 15
 *    minutes, then tries it again
 *  - the image model IDs come from env vars with verified defaults
 *
 * Run with: node --test tests/image-engines-and-leaks.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { createSseParser } from '../lib/chatStream.mjs';
import { FAILURE_PREFIX } from '../lib/upstreamFailure.mjs';
import {
  generateImage, imageModels, isEngineSkipped, __resetImageBreaker,
  BREAKER_WINDOW_MS, DEFAULT_IMAGE_MODELS, ENGINE_LABELS
} from '../lib/imageEngines.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const chatSource = readFileSync(join(__dirname, '../api/chat.mjs'), 'utf-8');

// The names no system-generated string may carry.
const BRANDS_RE = /Replicate|Flux|Imagen|Nano Banana|Gemini|Google|Anthropic|Claude|OpenAI|ChatGPT|Cartesia|Sonic/i;

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CONSOLE_ERROR = console.error;

const KEY1 = 'stub-image-key-one-0123456789';
const KEY2 = 'stub-image-key-two-0123456789';
const TERTIARY_TOKEN = 'stub-tertiary-token-0123456789';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY1 = KEY1;
  process.env.GEMINI_API_KEY2 = KEY2;
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY',
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASEAPI_KEY', 'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'REPLICATE_KEY',
    'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'PG1_IMAGE_MODEL_PRIMARY', 'PG1_IMAGE_MODEL_SECONDARY', 'PG1_IMAGE_MODEL_TERTIARY']) delete process.env[k];
}

let consoleLines = [];
beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
  __resetImageBreaker();
  consoleLines = [];
  console.error = (...args) => { consoleLines.push(args.join(' ')); };
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  console.error = ORIGINAL_CONSOLE_ERROR;
});

function useSupabase() {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-0123456789';
}

let ipSeq = 0;
function makeReq(body) {
  return { method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.78.0.${++ipSeq}` }, body };
}
const authed = (extra) => ({ user: 'test-operator', pass: 'test-secret-pass', ...extra });

function makeRes() {
  const listeners = {};
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; },
    end() { this.ended = true; return this; },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev) { (listeners[ev] || []).forEach((fn) => fn()); }
  };
}

function eventsOf(res) {
  const out = [];
  const parser = createSseParser(({ data }) => out.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return out;
}

function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', body: options.body, headers: options.headers || {} });
    for (const [needle, handler] of routes) {
      if (u.includes(needle)) return handler(u, options);
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}

const supabaseRoutes = () => [
  ['/rest/v1/messages?select=id', () => new Response('[]')],
  ['/rest/v1/messages?select=role', () => new Response('[]')],
  ['/rest/v1/messages', () => new Response('[]', { status: 201 })],
  ['/storage/v1/object/list/pg1-vault', () => new Response('[]')],
  ['/storage/v1/object/pg1-vault/', () => new Response('{}', { status: 200 })],
  ['/rest/v1/threat_indicators', () => new Response('[]')],
  ['/rest/v1/pg1_errors', (u, o) => new Response(o.method === 'POST' ? '' : '[]', { status: o.method === 'POST' ? 201 : 200 })]
];

async function errorLogRows(calls, atLeast = 1) {
  let rows = [];
  for (let i = 0; i < 100; i++) {
    rows = calls.filter((c) => c.url.includes('/rest/v1/pg1_errors') && (c.method === 'POST' || c.method === 'PATCH'));
    if (rows.length >= atLeast) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  return rows.map((c) => JSON.parse(c.body));
}

// Upstream bodies carrying everything a reply must not show.
const NOT_FOUND = JSON.stringify({ error: { code: 404, message: 'models/imagen-4.0-generate-001 is not found for API version v1beta', status: 'NOT_FOUND' } });
const QUOTA = JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } });
const IMAGE_PART = JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_1X1 } }] } }] });

const keyOf = (o) => (o && o.headers && o.headers['x-goog-api-key']) || '';
const primaryUrl = '/models/gemini-3.1-flash-image:generateContent';
const secondaryUrl = '/models/gemini-3-pro-image:generateContent';
const tertiaryCreate = 'api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions';
const TERTIARY_OUT = 'https://delivery.example.test/out/abc.png';

// Every system-generated string a request produced: trace step labels,
// results and details, error messages, status fields, and (when the reply
// itself is system-generated) the reply text. Image URLs are not text.
function systemStrings(res, { includeReply }) {
  const out = [];
  if (res.jsonBody) {
    const { image, traceId, ...rest } = res.jsonBody;
    for (const [k, v] of Object.entries(rest)) {
      if (k === 'reply' && !includeReply) continue;
      if (typeof v === 'string') out.push(v);
    }
  }
  for (const e of eventsOf(res)) {
    if (e.type === 'text' && !includeReply) continue;
    for (const v of [e.label, e.result, e.message, e.text].concat(e.details || [])) {
      if (typeof v === 'string') out.push(v);
    }
    if (e.type === 'done' && e.result && typeof e.result === 'object') {
      for (const [k, v] of Object.entries(e.result)) if (k !== 'image' && typeof v === 'string') out.push(v);
    }
  }
  return out;
}

// `imagePath`: the image reply also drops the old [SYSTEM]/[DIAGNOSTIC]
// lines (SPEAK keeps its "[DIAGNOSTIC] Voice pipeline test" status line,
// which names nothing).
function assertNoBrands(strings, what, { imagePath = false } = {}) {
  assert.ok(strings.length > 0, `${what}: some system text was rendered`);
  for (const s of strings) {
    assert.doesNotMatch(s, BRANDS_RE, `${what} names a provider: ${s}`);
    // Status codes as whole words: the random request ID (e.g. "va2t4046")
    // can contain the digits without echoing anything.
    assert.doesNotMatch(s, /quota|not found for API|aborted|invalid API key|\b(?:429|404|401|529)\b/i, `${what} echoes an upstream error: ${s}`);
    if (imagePath) assert.doesNotMatch(s, /\[SYSTEM\]|\[DIAGNOSTIC\]/, `${what} carries a system/diagnostic line: ${s}`);
  }
}

async function runImage(routes, { stream = true } = {}) {
  const calls = installFetch(routes);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: '/image a gold shield on a dark background', stream })), res);
  return { calls, res };
}

// --- 1. one test over every path's system-generated strings ---------------------

test('no system-generated string names a provider, on every image engine, vision, chat fallback and TTS path', async () => {
  // image: primary
  let { res } = await runImage([[primaryUrl, () => new Response(IMAGE_PART)]]);
  let strings = systemStrings(res, { includeReply: true });
  assertNoBrands(strings, 'image primary', { imagePath: true });
  assert.ok(strings.includes('Generated the image') && strings.includes(ENGINE_LABELS.primary), 'the trace names the engine by its PG1 label');

  // image: secondary (primary 404 on both keys)
  __clearAuthRateLimitState(); __resetImageBreaker();
  ({ res } = await runImage([[primaryUrl, () => new Response(NOT_FOUND, { status: 404 })], [secondaryUrl, () => new Response(IMAGE_PART)]]));
  assertNoBrands(systemStrings(res, { includeReply: true }), 'image secondary', { imagePath: true });

  // image: tertiary (both keys fail on primary and secondary)
  __clearAuthRateLimitState(); __resetImageBreaker();
  process.env.REPLICATE_API_TOKEN = TERTIARY_TOKEN;
  ({ res } = await runImage([
    [primaryUrl, () => new Response(NOT_FOUND, { status: 404 })],
    [secondaryUrl, (u, o) => keyOf(o) === KEY2 ? new Response(QUOTA, { status: 429 }) : Promise.reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))],
    [tertiaryCreate, () => new Response(JSON.stringify({ status: 'succeeded', output: [TERTIARY_OUT] }), { status: 201 })],
    [TERTIARY_OUT, () => new Response(Buffer.from(PNG_1X1, 'base64'), { headers: { 'content-type': 'image/png' } })]
  ]));
  strings = systemStrings(res, { includeReply: true });
  assertNoBrands(strings, 'image tertiary', { imagePath: true });
  assert.ok(strings.includes(ENGINE_LABELS.tertiary), 'the trace names the tertiary engine by its PG1 label');
  const done = eventsOf(res).find((e) => e.type === 'done');
  assert.match(done.result.image, /^data:image\/png;base64,/, 'the tertiary output is re-hosted, not linked');

  // image: total failure, JSON path
  __clearAuthRateLimitState(); __resetImageBreaker();
  delete process.env.REPLICATE_API_TOKEN;
  ({ res } = await runImage([[primaryUrl, () => new Response(QUOTA, { status: 429 })], [secondaryUrl, () => new Response(NOT_FOUND, { status: 404 })]], { stream: false }));
  assertNoBrands(systemStrings(res, { includeReply: true }), 'image total failure', { imagePath: true });

  // vision: an attached image, model-written reply excluded
  __clearAuthRateLimitState();
  installFetch([['streamGenerateContent', () => new Response('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A small square.' }] } }] }) + '\n\n')]]);
  res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'what is in this picture?', stream: true, multiFiles: [{ inlineData: { mimeType: 'image/png', data: PNG_1X1 } }] })), res);
  strings = systemStrings(res, { includeReply: false });
  assertNoBrands(strings, 'vision');
  assert.ok(strings.some((s) => /Looked at 1 image/.test(s)), 'the vision step was rendered');

  // chat: the reasoning core fails, the main core answers
  __clearAuthRateLimitState();
  process.env.ANTHROPIC_API_KEY = 'stub-reasoning-key-0123456789';
  installFetch([
    ['api.anthropic.com', () => new Response('{"type":"error","error":{"type":"overloaded_error","message":"Anthropic API is overloaded"}}', { status: 529 })],
    ['streamGenerateContent', () => new Response('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Fine.' }] } }] }) + '\n\n')]
  ]);
  res = makeRes();
  await chatHandler(makeReq(authed({ prompt: '/core hello', stream: true })), res);
  strings = systemStrings(res, { includeReply: false });
  assertNoBrands(strings, 'chat model fallback');
  assert.ok(strings.some((s) => /Reasoning core unavailable/.test(s)), 'the fallback step was rendered');
  delete process.env.ANTHROPIC_API_KEY;

  // TTS: success and failure
  __clearAuthRateLimitState();
  process.env.CARTESIA_API_KEY = 'stub-voice-key-0123456789';
  installFetch([['/tts/bytes', () => new Response(new Uint8Array([1, 2, 3]))]]);
  res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'read this aloud', action: 'SPEAK' })), res);
  assert.equal(res.jsonBody.audioStatus, 'SUCCESS');
  assertNoBrands(systemStrings(res, { includeReply: true }), 'TTS success');
  __clearAuthRateLimitState();
  installFetch([['/tts/bytes', () => new Response('{"error":"Cartesia: invalid API key for sonic-3.6"}', { status: 401 })]]);
  res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'read this aloud', action: 'SPEAK' })), res);
  assertNoBrands(systemStrings(res, { includeReply: true }), 'TTS failure');
});

test('the check does not apply to model-written answers: PG1 may still talk about Gemini', async () => {
  installFetch([['generateContent', () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Yes, Gemini is a family of models made by Google.' }] } }] }))]]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'do you know Gemini?' })), res);
  assert.match(res.jsonBody.reply, /Gemini/);
});

// --- 2. the image reply itself -----------------------------------------------------

test('success: the reply is the image and a short neutral caption, nothing else', async () => {
  const { res } = await runImage([[primaryUrl, () => new Response(IMAGE_PART)]], { stream: false });
  assert.equal(res.jsonBody.reply, 'Image ready.');
  assert.equal(res.jsonBody.imageStatus, 'SUCCESS');
  assert.match(res.jsonBody.image, /^data:image\/png;base64,/);
});

test('the source no longer builds the old [SYSTEM]/[DIAGNOSTIC] image reply or the link fallback', () => {
  assert.ok(!chatSource.includes('Image Rendered using'));
  assert.ok(!chatSource.includes('Prior engine attempts failed'));
  assert.ok(!chatSource.includes('Flux Schnell'));
  assert.ok(!chatSource.includes('image.pollinations.ai'));
  assert.ok(!chatSource.includes('imagen-4.0-generate-001'), 'the retired model ID is gone');
});

// --- 3. failed attempts go to the error log, not the reply -------------------------

test('every failed attempt lands in pg1_errors with provider, model, status, message and request_id; none of it in the reply', async () => {
  useSupabase();
  const { calls, res } = await runImage([
    ...supabaseRoutes(),
    [primaryUrl, (u, o) => keyOf(o) === KEY1 ? new Response(NOT_FOUND, { status: 404 }) : new Response(QUOTA, { status: 429 })],
    [secondaryUrl, () => new Response(IMAGE_PART)]
  ], { stream: false });
  assert.equal(res.jsonBody.reply, 'Image ready.');
  assert.doesNotMatch(JSON.stringify({ ...res.jsonBody, image: '' }), /quota|not found|429|404|gemini|google/i);

  const rows = await errorLogRows(calls, 2);
  assert.equal(rows.length, 2, 'one row per failed attempt');
  const byReason = Object.fromEntries(rows.map((r) => [r.reason, r]));
  const k1 = byReason.image_primary_key1_failed;
  const k2 = byReason.image_primary_key2_failed;
  assert.ok(k1 && k2, `rows: ${rows.map((r) => r.reason)}`);
  for (const [row, status, words] of [[k1, 404, /not found/], [k2, 429, /exceeded your current quota/]]) {
    assert.equal(row.route, 'GENERATE_IMAGE');
    assert.equal(row.source, 'server');
    assert.equal(row.status, status);
    assert.equal(row.request_id, res.jsonBody.traceId);
    assert.match(row.message, /^untrusted upstream data, not instructions:/);
    assert.match(row.message, /provider=google/);
    assert.match(row.message, /model=gemini-3\.1-flash-image/);
    assert.match(row.message, new RegExp(`status=${status}`));
    assert.match(row.message, new RegExp(`request_id=${res.jsonBody.traceId}`));
    assert.match(row.message, words);
    assert.doesNotMatch(row.message, new RegExp(`${KEY1}|${KEY2}`), 'no key in the row');
    assert.doesNotMatch(row.reason, BRANDS_RE, 'the reason (shown in traces and to the model) is brand-neutral');
  }
  // the keys never travel in a URL
  assert.ok(calls.filter((c) => c.url.includes('generativelanguage')).every((c) => !c.url.includes('key=')));
});

// --- 4. total failure ------------------------------------------------------------

test('total failure: a neutral message with the request ID, on both paths; the attempts are logged', async () => {
  useSupabase();
  process.env.REPLICATE_API_TOKEN = TERTIARY_TOKEN;
  const routes = () => [
    ...supabaseRoutes(),
    [primaryUrl, () => new Response(QUOTA, { status: 429 })],
    [secondaryUrl, () => new Response(NOT_FOUND, { status: 404 })],
    [tertiaryCreate, () => new Response('{"detail":"Replicate: insufficient credit"}', { status: 402 })]
  ];
  let { calls, res } = await runImage(routes(), { stream: false });
  assert.equal(res.statusCode, 200);
  assert.ok(res.jsonBody.reply.startsWith(FAILURE_PREFIX), res.jsonBody.reply);
  assert.match(res.jsonBody.reply, /image could not be generated/);
  assert.ok(res.jsonBody.reply.endsWith(`Request ID: ${res.jsonBody.traceId}`));
  assert.equal(res.jsonBody.imageStatus, 'FAILED');
  assert.equal(res.jsonBody.image, null);
  const rows = await errorLogRows(calls, 5);
  assert.equal(rows.length, 5, 'two keys x two engines + the tertiary engine');
  assert.ok(rows.every((r) => r.request_id === res.jsonBody.traceId));
  assert.ok(rows.some((r) => /provider=replicate model=black-forest-labs\/flux-schnell/.test(r.message)));

  __clearAuthRateLimitState(); __resetImageBreaker();
  ({ calls, res } = await runImage(routes()));
  const events = eventsOf(res);
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done, 'the stream finishes');
  assert.ok(text.startsWith(FAILURE_PREFIX));
  assert.ok(text.endsWith(`Request ID: ${done.request_id}`));
  const step = events.find((e) => e.id === 'image' && e.failed);
  assert.ok(step, 'the image step is marked failed');
  assert.ok(!step.details || step.details.length === 0, 'no engine errors in the trace row');
});

// --- 5. circuit breaker --------------------------------------------------------------

test('breaker: a 404 or 429 skips that engine/key for 15 minutes, then it is tried again', async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const hits = [];
  const fetchImpl = async (url, o) => {
    hits.push(`${url.includes('gemini-3.1-flash-image') ? 'primary' : url.includes('gemini-3-pro-image') ? 'secondary' : 'other'}:${keyOf(o) === KEY1 ? 1 : 2}`);
    if (url.includes('gemini-3.1-flash-image')) {
      return keyOf(o) === KEY1 ? new Response(NOT_FOUND, { status: 404 }) : new Response(QUOTA, { status: 429 });
    }
    return new Response(IMAGE_PART);
  };
  const run = () => generateImage({ prompt: 'p', geminiKeys: [KEY1, KEY2], fetchImpl, now });

  let r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.label, ENGINE_LABELS.secondary);
  assert.deepEqual(hits, ['primary:1', 'primary:2', 'secondary:1']);
  assert.equal(isEngineSkipped('primary', DEFAULT_IMAGE_MODELS.primary, 1, clock), true);
  assert.equal(isEngineSkipped('primary', DEFAULT_IMAGE_MODELS.primary, 2, clock), true);

  // inside the window: straight to the engine that works
  hits.length = 0;
  clock += BREAKER_WINDOW_MS - 1;
  r = await run();
  assert.equal(r.label, ENGINE_LABELS.secondary);
  assert.deepEqual(hits, ['secondary:1']);

  // after the window: the primary engine is tried again
  hits.length = 0;
  clock += 2;
  r = await run();
  assert.deepEqual(hits, ['primary:1', 'primary:2', 'secondary:1']);
});

test('breaker: other failures (5xx, timeouts) do not trip it', async () => {
  const now = () => 5_000_000;
  let primaryCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('gemini-3.1-flash-image')) { primaryCalls++; return new Response('{"error":"internal"}', { status: 500 }); }
    return new Response(IMAGE_PART);
  };
  await generateImage({ prompt: 'p', geminiKeys: [KEY1], fetchImpl, now });
  await generateImage({ prompt: 'p', geminiKeys: [KEY1], fetchImpl, now });
  assert.equal(primaryCalls, 2);
  assert.equal(isEngineSkipped('primary', DEFAULT_IMAGE_MODELS.primary, 1, now()), false);
});

// --- 6. model IDs from env vars ---------------------------------------------------------

test('image model IDs come from env vars, with the verified defaults', async () => {
  assert.deepEqual(imageModels({}), {
    primary: 'gemini-3.1-flash-image', secondary: 'gemini-3-pro-image', tertiary: 'black-forest-labs/flux-schnell'
  });
  assert.deepEqual(imageModels({ PG1_IMAGE_MODEL_PRIMARY: ' custom-a ', PG1_IMAGE_MODEL_SECONDARY: '', PG1_IMAGE_MODEL_TERTIARY: 'owner/model' }), {
    primary: 'custom-a', secondary: 'gemini-3-pro-image', tertiary: 'owner/model'
  });

  // an imagen-* ID is still sent to :predict
  const urls = [];
  const r = await generateImage({
    prompt: 'p', geminiKeys: [KEY1], env: { PG1_IMAGE_MODEL_PRIMARY: 'imagen-9.0-generate-001' },
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ predictions: [{ mimeType: 'image/png', bytesBase64Encoded: PNG_1X1 }] }));
    }
  });
  assert.equal(r.ok, true);
  assert.match(urls[0], /\/models\/imagen-9\.0-generate-001:predict$/);
});
