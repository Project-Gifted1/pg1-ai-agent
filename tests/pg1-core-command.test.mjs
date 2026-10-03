/**
 * Follow-up to PR #244 (issue #245), FIX 2: /claude renamed to /core in
 * every user-visible place (api/chat.mjs: [HELP], [CAPABILITIES]; the error
 * log's FIX button in public/index.html), described only as deeper
 * reasoning for long or heavy tasks, never naming a provider. /claude keeps
 * working underneath as an undocumented alias. The image-generation engine
 * labels never name the real provider behind them either.
 *
 * Run with: node --test tests/pg1-core-command.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { FAKE } from './fixtures/fake-secrets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const html = readFileSync(join(root, 'public/index.html'), 'utf-8');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY = 'stub-gemini-key';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'CARTESIA_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY']) delete process.env[k];
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.93.0.${++ipSeq}` }, body });
const authed = (extra) => ({ user: 'test-operator', pass: 'test-secret-pass', ...extra });

function makeRes() {
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; },
    end() { this.ended = true; return this; },
    on() {}
  };
}

// --- 1. /help and [CAPABILITIES] show /core, never /claude -----------------------------

test('/help lists /core, described as deeper reasoning for long or heavy tasks, and never mentions /claude', async () => {
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: '/help' })), res);
  assert.match(res.jsonBody.reply, /\/core\*\* plus a question: deeper reasoning for long or heavy tasks/);
  assert.doesNotMatch(res.jsonBody.reply, /\/claude/);
});

test('[CAPABILITIES] describes /core as deeper reasoning for long or heavy tasks, names no provider, and never shows /claude', async () => {
  const seen = { prompt: null };
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      seen.prompt = JSON.parse(options.body).systemInstruction.parts[0].text;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Stubbed reply.' }] } }] }));
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'what can you do?' })), res);
  assert.ok(seen.prompt, 'the model was called');
  assert.match(seen.prompt, /\/core sends a question to the deeper reasoning core, for long or heavy tasks/);
  assert.ok(seen.prompt.includes('Never name, confirm, deny or hint at the model, company or technology behind /core or the main core'));
  // /claude is still named once, in the internal [IDENTITY] instruction that
  // tells the model never to mention it — it is not documented as a command.
  assert.doesNotMatch(seen.prompt, /\*\*\/claude\*\* plus a question|\/claude sends a question|\/claude plus a task/);
});

// --- 2. /core routes exactly like /claude did, and /claude still works as an alias ------

async function runCommand(command, { stream = false } = {}) {
  process.env.ANTHROPIC_API_KEY = FAKE.anthropicKey;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) {
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Reasoning-core reply.' }] }));
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: command, stream })), res);
  return res;
}

test('/core and /claude both reach the Anthropic reasoning core on the JSON path', async () => {
  const core = await runCommand('/core what is a buffer overflow?');
  assert.equal(core.statusCode, 200);
  assert.equal(core.jsonBody.reply, 'Reasoning-core reply.');
  const claude = await runCommand('/claude what is a buffer overflow?');
  assert.equal(claude.statusCode, 200);
  assert.equal(claude.jsonBody.reply, 'Reasoning-core reply.');
});

test('/core with no text after it gets the same greet-and-ask fallback /claude used to', async () => {
  process.env.ANTHROPIC_API_KEY = FAKE.anthropicKey;
  let sentText = null;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) {
      const body = JSON.parse(options.body);
      sentText = body.messages[0].content.find((b) => b.type === 'text').text;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hi!' }] }));
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: '/core' })), res);
  assert.match(sentText, /switched to your deeper reasoning core without typing a message/);
});

test('the error log FIX button composes a /core prompt, not /claude', () => {
  assert.match(html, /input\.value = '\/core A client-side or server-side error was captured/);
  assert.doesNotMatch(html, /input\.value = '\/claude/);
});

// --- 3. image generation never names the real provider behind an engine ----------------

test('GENERATE_IMAGE: the primary engine label never names Google or Gemini', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes(':predict')) {
      return new Response(JSON.stringify({ predictions: [{ mimeType: 'image/png', bytesBase64Encoded: 'ZmFrZQ==' }] }));
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: '/image a lighthouse' })), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.jsonBody.reply, /Image Rendered using \*\*PG1 Vision Primary/);
  assert.doesNotMatch(res.jsonBody.reply, /Google|Gemini/);
});

test('GENERATE_IMAGE: the secondary engine label never names Google or Gemini either, once the primary engine fails', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes(':predict')) return new Response(JSON.stringify({ error: 'quota' }), { status: 429 });
    if (u.includes(':generateContent')) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'ZmFrZQ==' } }] } }]
      }));
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: '/image a lighthouse' })), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.jsonBody.reply, /Image Rendered using \*\*PG1 Vision Secondary/);
  assert.doesNotMatch(res.jsonBody.reply, /Google|Gemini/);
});
