/**
 * No Gemini API key in a request URL.
 *
 * A key in the query string (?key=...) can show up in Vercel's External
 * APIs logs, in proxy logs and in error text that quotes the URL. Every
 * Gemini call sends it in the x-goog-api-key header instead. This test:
 *  1. drives every Gemini call path (chat streamed and JSON, /core's
 *     fallback to the main core, /image, the legacy GeminiClient and the
 *     root index.js worker) through a fetch spy that fails on any request to
 *     generativelanguage.googleapis.com whose URL contains "key=", and
 *     checks the key arrived in the header instead;
 *  2. scans the source for a Gemini URL built with key= so a new call site
 *     cannot bring it back unnoticed.
 *
 * Run with: node --test tests/gemini-key-header.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { __resetImageBreaker } from '../lib/imageEngines.mjs';
import worker from '../index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const KEY1 = 'stub-header-key-one-0123456789';
const KEY2 = 'stub-header-key-two-0123456789';
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

beforeEach(() => {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY1 = KEY1;
  process.env.GEMINI_API_KEY2 = KEY2;
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASEAPI_KEY', 'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'REPLICATE_KEY', 'GITHUB_TOKEN',
    'GITHUB_OWNER_KEY']) delete process.env[k];
  __clearAuthRateLimitState();
  __resetImageBreaker();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

// Every Gemini request goes through here. A key in the URL is a failure,
// whatever else the request does.
function geminiSpy(answer) {
  const seen = [];
  const spy = async (url, options = {}) => {
    const u = String(url);
    const host = (() => { try { return new URL(u).hostname; } catch (e) { return ''; } })();
    if (host !== GEMINI_HOST) throw new Error('Unexpected network call in test: ' + u);
    assert.ok(!u.includes('key='), `a Gemini request URL carries key=: ${u}`);
    const headers = options.headers || {};
    seen.push({ url: u, key: headers['x-goog-api-key'] || (typeof headers.get === 'function' ? headers.get('x-goog-api-key') : undefined) });
    return answer(u, options);
  };
  return { spy, seen };
}

const text = (t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });
const sse = (objs) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');
const chatAnswer = (u) => (u.includes(':streamGenerateContent')
  ? new Response(sse([text('Hello from the stub.')]))
  : new Response(JSON.stringify(text('Hello from the stub.')), { headers: { 'Content-Type': 'application/json' } }));

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.92.0.${++ipSeq}` }, body });
function makeRes() {
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {}
  };
}
async function chat(body) {
  const res = makeRes();
  await chatHandler(makeReq({ user: 'test-operator', pass: 'test-secret-pass', ...body }), res);
  return res;
}

function assertHeaderKeys(seen, what, keys = [KEY1, KEY2]) {
  assert.ok(seen.length > 0, `${what}: made a Gemini request`);
  for (const s of seen) assert.ok(keys.includes(s.key), `${what}: the key is in x-goog-api-key (${s.url})`);
}

test('chat, streamed and JSON: the key is in the header, never the URL', async () => {
  let { spy, seen } = geminiSpy(chatAnswer);
  globalThis.fetch = spy;
  const streamed = await chat({ prompt: 'hello there', stream: true });
  assert.match(streamed.chunks.join(''), /Hello from the stub/);
  assert.ok(seen.some((s) => s.url.includes(':streamGenerateContent?alt=sse')), 'the streamed endpoint, with only alt=sse in the query');
  assertHeaderKeys(seen, 'streamed chat');

  ({ spy, seen } = geminiSpy(chatAnswer));
  globalThis.fetch = spy;
  const json = await chat({ prompt: 'hello there' });
  assert.match(json.jsonBody.reply, /Hello from the stub/);
  assert.ok(seen.every((s) => /:generateContent$/.test(s.url)), 'the JSON endpoint has no query string at all');
  assertHeaderKeys(seen, 'JSON chat');
});

test('chat: when key 1 fails, key 2 is tried, also in the header', async () => {
  const { spy, seen } = geminiSpy((u, o) => (o.headers['x-goog-api-key'] === KEY1
    ? new Response(JSON.stringify({ error: { code: 429, message: 'quota' } }), { status: 429 })
    : chatAnswer(u)));
  globalThis.fetch = spy;
  const res = await chat({ prompt: 'hello again' });
  assert.match(res.jsonBody.reply, /Hello from the stub/);
  assert.ok(seen.some((s) => s.key === KEY1) && seen.some((s) => s.key === KEY2), 'both keys used');
  assertHeaderKeys(seen, 'key fallback');
});

test('/core falling back to the main core, and /image: the key is in the header, never the URL', async () => {
  process.env.ANTHROPIC_API_KEY = 'stub-anthropic-key-0123456789';
  const anthropicDown = async (url, options) => {
    if (String(url).includes('api.anthropic.com')) return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 529 });
    return gem.spy(url, options);
  };
  const gem = geminiSpy(chatAnswer);
  globalThis.fetch = anthropicDown;
  const core = await chat({ prompt: '/core explain this' });
  assert.match(core.jsonBody.reply, /Hello from the stub/);
  assertHeaderKeys(gem.seen, '/core fallback');
  delete process.env.ANTHROPIC_API_KEY;

  const img = geminiSpy(() => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_1X1 } }] } }] })));
  globalThis.fetch = img.spy;
  const image = await chat({ prompt: '/image a gold shield' });
  assert.equal(image.jsonBody.imageStatus, 'SUCCESS');
  assertHeaderKeys(img.seen, '/image');
});

test('the legacy GeminiClient and the root worker send the key in the header', async () => {
  const client = geminiSpy(() => new Response(JSON.stringify(text('ok'))));
  const sandbox = { module: { exports: {} }, fetch: client.spy, console };
  vm.runInNewContext(readFileSync(join(ROOT, 'api/lib/gemini-client.js'), 'utf8'), sandbox);
  const GeminiClient = sandbox.module.exports;
  const c = new GeminiClient(KEY1);
  await c.sendRequest('hi', 'system');
  await c.continueWithFunctionResponse('hi', 'system', [], { name: 'f', response: {} });
  assert.equal(client.seen.length, 2);
  assertHeaderKeys(client.seen, 'GeminiClient', [KEY1]);

  const w = geminiSpy(() => new Response(JSON.stringify(text('worker ok'))));
  globalThis.fetch = w.spy;
  const res = await worker.fetch(new Request('https://worker.test/', { method: 'POST', body: JSON.stringify({ command: 'hi' }) }), { GEMINI_API_KEY: KEY2 });
  assert.equal((await res.json()).response, 'worker ok');
  assertHeaderKeys(w.seen, 'index.js worker', [KEY2]);
});

// --- the source itself ----------------------------------------------------------------

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'tests' || name === '.next') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(?:m?js|cjs|ts|tsx|py|html)$/.test(name)) out.push(p);
  }
  return out;
}

test('no source file builds a Gemini URL with key= in it', () => {
  const offenders = [];
  for (const file of sourceFiles(ROOT)) {
    const src = readFileSync(file, 'utf8');
    if (!/generativelanguage\.googleapis\.com|baseUrl|GEMINI/i.test(src)) continue;
    src.split('\n').forEach((line, i) => {
      if (/[?&]key=/.test(line) && /generativelanguage|:generateContent|:streamGenerateContent|baseUrl|gemini/i.test(line)) offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(offenders, [], 'send the key in the x-goog-api-key header instead');
});
