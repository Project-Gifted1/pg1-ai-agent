/**
 * 23 Oct, requests nl6x72uy, zl6i1wj5, bk4iys6w and others: every chat reply
 * failed. The free Gemini key stalled before its first byte and was allowed
 * most of the 50 s budget; the backups then had ~10 s between them. GitHub
 * Models answered 200 with a bare "OK" body on every call, and Cloudflare
 * timed out on what was left.
 *
 * Now each engine gets a share (api/chat.mjs CHAT_ENGINE_FIRST_BYTE_MS,
 * CHAT_ENGINE_TOTAL_MS): a stalled engine is dropped after its share and the
 * next one answers. An engine that answers 200 with no usable body is
 * skipped for 15 minutes (EMPTY_ANSWER_COOL_MS) instead of on every message.
 *
 * Run with: node --test tests/chat-engine-share.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState, CHAT_ENGINE_FIRST_BYTE_MS, CHAT_ENGINE_TOTAL_MS, EMPTY_ANSWER_COOL_MS } from '../api/chat.mjs';
import { __resetRouterState } from '../lib/aiRouter.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
let calls;

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY_FREE = 'stub-free-key';
  process.env.GITHUB_MODELS_TOKEN = 'stub-gh-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
  process.env.CLOUDFLARE_AI_TOKEN = 'stub-cf-token';
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
  // A short share so the stall costs the test well under a second.
  process.env.PG1_CHAT_ENGINE_FIRST_BYTE_MS = '300';
  process.env.PG1_CHAT_ENGINE_TOTAL_MS = '300';
  for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEY_PAID', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'USER_API_USER']) delete process.env[k];
}

const sse = (obj) => new Response(`data: ${JSON.stringify(obj)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

function installFetch() {
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      calls.push('gemini');
      // Stalls: no byte until the caller gives up.
      return new Promise((_, reject) => {
        const sig = options && options.signal;
        if (sig) sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }
    if (u.includes('models.github.ai')) { calls.push('github_models'); return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } }); }
    if (u.includes('api.cloudflare.com')) {
      calls.push('cloudflare');
      return sse({ choices: [{ delta: { content: 'Backup engine reply.' }, finish_reason: 'stop' }] });
    }
    if (u.includes('/rest/v1/')) return new Response(u.includes('method=') ? '' : '[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
  if (typeof __resetRouterState === 'function') __resetRouterState();
  calls = [];
  installFetch();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; }, write() { return true; }
  };
}

async function ask(prompt) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: '10.9.0.2' }, body: { prompt, user: 'test-operator', pass: 'test-secret-pass' } }, res);
  return res;
}

test('the shares leave the backups most of the 50 s budget', () => {
  assert.ok(CHAT_ENGINE_FIRST_BYTE_MS <= 15000);
  assert.ok(CHAT_ENGINE_TOTAL_MS <= 30000);
  assert.ok(EMPTY_ANSWER_COOL_MS >= 10 * 60 * 1000);
});

test('a stalled free Gemini key and an empty GitHub Models answer no longer stop the chat: the next engine answers', async () => {
  const t0 = Date.now();
  const res = await ask('how are you doing?');
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(String(res.body && res.body.reply), /Backup engine reply\./, JSON.stringify(res.body));
  assert.ok(calls.includes('gemini'), 'the free key was tried first');
  assert.ok(Date.now() - t0 < 10000, 'the stall was dropped after its share');
});

test('an engine that answered 200 with no usable body is skipped on the next message', async () => {
  await ask('first message');
  const firstGh = calls.filter((c) => c === 'github_models').length;
  calls = [];
  const res = await ask('second message');
  assert.match(String(res.body && res.body.reply), /Backup engine reply\./);
  if (firstGh) assert.equal(calls.filter((c) => c === 'github_models').length, 0, 'GitHub Models is cooling down');
});
