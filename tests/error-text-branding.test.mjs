/**
 * Error text branding (lib/upstreamFailure.mjs, both reply paths and the
 * SPEAK path in api/chat.mjs):
 *  - a failed reply never shows the upstream provider or model name, nor
 *    the upstream service's own error text ("Execution failed. Model Err:
 *    [gemini-x] 429: ..." is gone)
 *  - what the operator sees is one short neutral sentence plus the request
 *    ID, the same ID the stream's "done"/"error" events and the JSON
 *    reply's traceId carry
 *  - the full upstream detail still reaches the error log, console and
 *    pg1_errors row, under that request ID, with secrets stripped
 *  - the handler's catch-all and the voice pipeline's status follow the
 *    same rule
 *
 * Every fake credential comes from tests/fixtures/fake-secrets.mjs or the
 * stub values below.
 *
 * Run with: node --test tests/error-text-branding.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { createSseParser } from '../lib/chatStream.mjs';
import {
  FAILURE_PREFIX, UPSTREAM_BRAND_RE, VOICE_FAILURE_STATUS, reportUpstreamFailure, userFacingFailure
} from '../lib/upstreamFailure.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const chatSource = readFileSync(join(__dirname, '../api/chat.mjs'), 'utf-8');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CONSOLE_ERROR = console.error;

const GEMINI_KEY = 'stub-gemini-key-0123456789';
const ANTHROPIC_KEY = 'stub-anthropic-key-0123456789';
const CARTESIA_KEY = 'stub-cartesia-key-0123456789';

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY',
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASEAPI_KEY', 'CARTESIA_API_KEY',
    'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'PG1_TEST_SECRET_TOKEN']) delete process.env[k];
}

let consoleLines = [];
beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
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
  return { method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.77.0.${++ipSeq}` }, body };
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

// Records every network call; `routes` answers by URL substring. Calls the
// test did not route fail loudly instead of hanging.
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
  ['/rest/v1/threat_indicators', () => new Response('[]')],
  // the error log: the pre-write lookup finds no open row, the POST succeeds
  ['/rest/v1/pg1_errors', (u, o) => new Response(o.method === 'POST' ? '' : '[]', { status: o.method === 'POST' ? 201 : 200 })]
];

// Waits for the fire-and-forget error-log write to land.
async function errorLogRows(calls) {
  for (let i = 0; i < 50; i++) {
    const rows = calls.filter((c) => c.url.includes('/rest/v1/pg1_errors') && (c.method === 'POST' || c.method === 'PATCH'));
    if (rows.length) return rows.map((c) => JSON.parse(c.body));
    await new Promise((r) => setTimeout(r, 5));
  }
  return [];
}

// Upstream error bodies that carry everything a reply must not: the
// provider, the model, the HTTP status, the provider's own words and the
// API key echoed back.
const GEMINI_429 = `{"error":{"code":429,"message":"Gemini API quota exceeded for model gemini-3.8-flash (key ${GEMINI_KEY}). Visit https://ai.google.dev to upgrade.","status":"RESOURCE_EXHAUSTED"}}`;
const ANTHROPIC_529 = '{"type":"error","error":{"type":"overloaded_error","message":"Anthropic API is overloaded; claude-sonnet-5 unavailable"}}';
const CARTESIA_401 = '{"error":"Cartesia: invalid API key for sonic-3.6"}';

const assertNeutral = (text, what) => {
  assert.equal(typeof text, 'string', `${what} is a string`);
  assert.ok(text.startsWith(FAILURE_PREFIX), `${what} keeps the "${FAILURE_PREFIX}" lead: ${text}`);
  assert.doesNotMatch(text, UPSTREAM_BRAND_RE, `${what} names a provider or model: ${text}`);
  assert.doesNotMatch(text, /Model Err|quota|RESOURCE_EXHAUSTED|overloaded|429|529|invalid API key|\[\w[\w.-]*\]/i, `${what} echoes upstream error text: ${text}`);
  assert.doesNotMatch(text, new RegExp(GEMINI_KEY), `${what} leaks a key: ${text}`);
};

// --- 1. the message builder -----------------------------------------------------------

test('userFacingFailure is one neutral sentence plus the request ID, for every kind', () => {
  for (const kind of ['reply', 'request', 'voice', 'something-unknown', undefined]) {
    const msg = userFacingFailure('abc12345', kind);
    assertNeutral(msg, `the ${kind} message`);
    assert.ok(msg.endsWith('Request ID: abc12345'), `ends with the request ID: ${msg}`);
    assert.ok(msg.length < 140, `short: ${msg}`);
  }
  assert.equal(userFacingFailure('abc12345'), userFacingFailure('abc12345', 'reply'));
  assert.notEqual(userFacingFailure('x', 'reply'), userFacingFailure('x', 'request'));
  // without an ID there is still a complete sentence and no dangling label
  assert.doesNotMatch(userFacingFailure(null), /Request ID/);
  assert.doesNotMatch(VOICE_FAILURE_STATUS, UPSTREAM_BRAND_RE);
});

test('UPSTREAM_BRAND_RE catches the names and model ids the old messages carried', () => {
  for (const s of ['Model Err: [gemini-3.8-flash on v1beta] 429', 'Anthropic API 529: overloaded', '[claude-sonnet-5] stream error',
    'Gemini call exceeded its time budget', 'CARTESIA_ERROR_401', 'EXCEPTION_Cartesia timed out', 'generativelanguage.googleapis.com', 'gpt-4o said no', 'sonic-3.6']) {
    assert.match(s, UPSTREAM_BRAND_RE, s);
  }
  assert.doesNotMatch('The reply could not be generated right now. Please try again. Request ID: k3j2h1', UPSTREAM_BRAND_RE);
  assert.doesNotMatch('[AGENT] Commit Aborted: Validation Failed.', UPSTREAM_BRAND_RE);
  // ordinary words that merely contain a name are not false positives
  assert.doesNotMatch('The egyptian claudication clinic opened.', UPSTREAM_BRAND_RE);
});

test('the source no longer builds a reply from the upstream error string', () => {
  assert.ok(!chatSource.includes('Model Err'), 'the "Model Err" fallback is gone');
  assert.ok(!chatSource.includes('reply: `Exception: ${err.message}`'), 'the raw "Exception:" JSON fallback is gone');
  assert.ok(!chatSource.includes('error(`Exception: ${err.message}`)'), 'the raw "Exception:" stream fallback is gone');
  assert.ok(!chatSource.includes('CARTESIA_ERROR_'), 'the voice status no longer names the provider');
});

// --- 2. the error log keeps the detail -----------------------------------------------------

test('reportUpstreamFailure writes the full detail to console and pg1_errors under the request ID, secrets stripped', async () => {
  const calls = installFetch(supabaseRoutes());
  const lines = [];
  const detail = `[gemini-3.8-flash on v1beta] 429: ${GEMINI_429}`;
  await reportUpstreamFailure({
    supUrl: 'https://example.supabase.co', supKey: 'k', route: 'CHAT', reason: 'model_failed', detail,
    requestId: 'req00001', envValues: [{ name: 'GEMINI_API_KEY', value: GEMINI_KEY }], log: (l) => lines.push(l)
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /model_failed/);
  assert.match(lines[0], /request_id=req00001/);
  assert.match(lines[0], /gemini-3\.8-flash/);
  assert.match(lines[0], /429/);
  assert.doesNotMatch(lines[0], new RegExp(GEMINI_KEY), 'the key is stripped from the console line');

  const [row] = await errorLogRows(calls);
  assert.ok(row, 'a pg1_errors row was written');
  assert.equal(row.source, 'server');
  assert.equal(row.route, 'CHAT');
  assert.equal(row.reason, 'model_failed');
  assert.equal(row.category, 'upstream');
  assert.equal(row.status, null);
  assert.equal(row.request_id, 'req00001');
  assert.match(row.message, /gemini-3\.8-flash/);
  assert.match(row.message, /quota exceeded/);
  assert.doesNotMatch(row.message, new RegExp(GEMINI_KEY), 'the key is stripped from the row');
  assert.ok(row.message.length <= 300);
});

test('reportUpstreamFailure without Supabase still logs to the console and never throws', async () => {
  const calls = installFetch([]);
  const lines = [];
  await reportUpstreamFailure({ route: 'CHAT', reason: 'model_failed', detail: 'x', requestId: 'r', log: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  assert.equal(calls.length, 0);
  await reportUpstreamFailure({ route: 'CHAT', reason: 'model_failed', detail: 'x', requestId: 'r', log: () => { throw new Error('console broke'); } });
});

// --- 3. the streamed reply ------------------------------------------------------------------

test('stream: a model failure is a neutral error event carrying the request ID; the detail goes to the error log', async () => {
  useSupabase();
  const calls = installFetch([...supabaseRoutes(), ['streamGenerateContent', () => new Response(GEMINI_429, { status: 429 })]]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hello', stream: true })), res);
  const events = eventsOf(res);
  const last = events[events.length - 1];
  assert.equal(last.type, 'error');
  assert.equal(last.partial, false);
  assertNeutral(last.message, 'the stream error message');
  assert.ok(last.request_id, 'the error event carries request_id');
  assert.ok(last.message.endsWith(`Request ID: ${last.request_id}`), 'the message shows the same request ID');
  // nothing else in the stream names the provider either
  for (const e of events) {
    for (const v of [e.label, e.result, e.message].concat(e.details || [])) {
      if (typeof v === 'string') assert.doesNotMatch(v, UPSTREAM_BRAND_RE, `event ${e.type}/${e.id} names a provider: ${v}`);
    }
  }
  assert.ok(!calls.some((c) => c.url.endsWith('/rest/v1/messages') && c.method === 'POST'), 'a failed reply is not saved to memory');

  const [row] = await errorLogRows(calls);
  assert.ok(row, 'the detail reached pg1_errors');
  assert.equal(row.request_id, last.request_id);
  assert.equal(row.reason, 'model_failed');
  assert.match(row.message, /gemini-3\.8-flash/);
  assert.match(row.message, /429/);
  assert.doesNotMatch(row.message, new RegExp(GEMINI_KEY));
  assert.ok(consoleLines.some((l) => l.includes(`request_id=${last.request_id}`) && l.includes('gemini-3.8-flash')), 'the console line has the detail');
});

test('stream: when the reasoning core and its fallback both fail, neither provider is named', async () => {
  process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
  useSupabase();
  const calls = installFetch([
    ...supabaseRoutes(),
    ['api.anthropic.com', () => new Response(ANTHROPIC_529, { status: 529 })],
    ['streamGenerateContent', () => new Response(GEMINI_429, { status: 429 })]
  ]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: '/claude hello', stream: true })), res);
  const last = eventsOf(res).at(-1);
  assert.equal(last.type, 'error');
  assertNeutral(last.message, 'the stream error message');
  assert.ok(calls.some((c) => c.url.includes('api.anthropic.com')), 'the reasoning core was tried');
  assert.ok(calls.some((c) => c.url.includes('streamGenerateContent')), 'the fallback was tried');
  const [row] = await errorLogRows(calls);
  assert.match(row.message, /Anthropic/);
  assert.match(row.message, /Gemini fallback/);
  assert.equal(row.request_id, last.request_id);
});

// --- 4. the JSON reply ------------------------------------------------------------------

test('json: a model failure is a neutral reply carrying the traceId; the detail goes to the error log', async () => {
  useSupabase();
  const calls = installFetch([...supabaseRoutes(), ['generateContent', () => new Response(GEMINI_429, { status: 429 })]]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hello' })), res);
  assert.equal(res.statusCode, 200);
  assertNeutral(res.jsonBody.reply, 'the JSON reply');
  assert.ok(res.jsonBody.traceId);
  assert.ok(res.jsonBody.reply.endsWith(`Request ID: ${res.jsonBody.traceId}`));
  assert.ok(!calls.some((c) => c.url.endsWith('/rest/v1/messages') && c.method === 'POST'), 'a failed reply is not saved to memory');
  const [row] = await errorLogRows(calls);
  assert.equal(row.request_id, res.jsonBody.traceId);
  assert.match(row.message, /gemini-3\.8-flash/);
  assert.doesNotMatch(row.message, new RegExp(GEMINI_KEY));
});

test('json: a successful reply is unchanged', async () => {
  installFetch([['generateContent', () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'All good.' }] } }] }))]]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hello' })), res);
  assert.equal(res.jsonBody.reply, 'All good.');
  assert.equal(consoleLines.length, 0);
});

// --- 5. the catch-all -------------------------------------------------------------------

test('an exception inside the handler is a neutral reply with the request ID, on both paths; the message is logged', async () => {
  useSupabase();
  // a null attachment makes the vault-upload loop throw (f.inlineData on null)
  const poison = { prompt: 'hello', multiFiles: [null] };

  let calls = installFetch(supabaseRoutes());
  let res = makeRes();
  await chatHandler(makeReq(authed(poison)), res);
  assert.equal(res.statusCode, 200);
  assertNeutral(res.jsonBody.reply, 'the JSON exception reply');
  assert.doesNotMatch(res.jsonBody.reply, /Cannot read|TypeError|null/i, 'the exception text is not shown');
  assert.ok(res.jsonBody.reply.endsWith(`Request ID: ${res.jsonBody.traceId}`));
  let [row] = await errorLogRows(calls);
  assert.equal(row.reason, 'chat_exception');
  assert.equal(row.category, 'js_error');
  assert.equal(row.request_id, res.jsonBody.traceId);
  assert.match(row.message, /TypeError|Cannot read/);

  __clearAuthRateLimitState();
  calls = installFetch(supabaseRoutes());
  res = makeRes();
  await chatHandler(makeReq(authed({ ...poison, stream: true })), res);
  const last = eventsOf(res).at(-1);
  assert.equal(last.type, 'error');
  assertNeutral(last.message, 'the stream exception message');
  assert.doesNotMatch(last.message, /Cannot read|TypeError/i);
  assert.ok(last.message.endsWith(`Request ID: ${last.request_id}`));
  [row] = await errorLogRows(calls);
  assert.equal(row.request_id, last.request_id);
});

// --- 6. the voice pipeline --------------------------------------------------------------

test('SPEAK: a synthesis failure reports a fixed status and a neutral note, never the provider; the detail is logged', async () => {
  process.env.CARTESIA_API_KEY = CARTESIA_KEY;
  useSupabase();
  const calls = installFetch([...supabaseRoutes(), ['api.cartesia.ai/tts/bytes', () => new Response(CARTESIA_401, { status: 401 })]]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'read this aloud', action: 'SPEAK' })), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.audioStatus, VOICE_FAILURE_STATUS);
  assert.notEqual(res.jsonBody.audioStatus, 'SUCCESS');
  assert.doesNotMatch(res.jsonBody.audioStatus, UPSTREAM_BRAND_RE);
  assert.doesNotMatch(res.jsonBody.reply, UPSTREAM_BRAND_RE, res.jsonBody.reply);
  assert.doesNotMatch(res.jsonBody.reply, /401|invalid API key/);
  assert.match(res.jsonBody.reply, new RegExp(`Status: ${VOICE_FAILURE_STATUS}`));
  assert.ok(res.jsonBody.reply.includes(`Request ID: ${res.jsonBody.traceId}`));
  const [row] = await errorLogRows(calls);
  assert.equal(row.reason, 'voice_synthesis_failed');
  assert.equal(row.request_id, res.jsonBody.traceId);
  assert.match(row.message, /401/);
  assert.match(row.message, /Cartesia/);
  assert.doesNotMatch(row.message, new RegExp(CARTESIA_KEY));
});
