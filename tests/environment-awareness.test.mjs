/**
 * Issue #201 Phase 2 — environment awareness:
 *  - When the client sends a `clientEnv` object with the chat request, the
 *    system prompt sent to the model gains a [CLIENT ENVIRONMENT] block
 *    listing only the self-reported fields it received, each labelled as
 *    self-reported and not independently verified.
 *  - When no `clientEnv` is sent (or it's empty/malformed), no such block
 *    appears at all — the model must never invent environment details.
 *  - Every field is capped in length so a malicious/huge value can't bloat
 *    or corrupt the prompt.
 *
 * Run with: node --test tests/environment-awareness.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY = 'stub-gemini-key';
  delete process.env.USER_API_USER;
  delete process.env.USER_API_PASSS;
  delete process.env.GEMINI_API_KEY1;
  delete process.env.GEMINI_API_KEY2;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTROPIC_API_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.CARTESIA_API_KEY;
}

let capturedSystemInstruction = null;

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
  capturedSystemInstruction = null;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      if (options && typeof options.body === 'string') {
        try {
          const parsedBody = JSON.parse(options.body);
          capturedSystemInstruction = parsedBody.systemInstruction && parsedBody.systemInstruction.parts && parsedBody.systemInstruction.parts[0] && parsedBody.systemInstruction.parts[0].text;
        } catch (e) { /* ignore */ }
      }
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Stubbed model reply.' }] } }]
        })
      };
    }
    throw new Error('Unexpected network call in test: ' + url);
  };
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function makeReq(body, opts = {}) {
  return {
    method: 'POST',
    url: opts.url || '/api/chat',
    headers: opts.headers || {},
    socket: { remoteAddress: opts.ip || '127.0.0.1' },
    body
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    getHeader(key) { return this.headers[key]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
  return res;
}

// The static CAPABILITIES text always mentions "[CLIENT ENVIRONMENT]" by name
// (describing when it *would* appear), so asserting its absence has to look
// only at the actual [CONTEXT] section the request data lands in, not the
// whole system prompt.
function contextSection(systemInstruction) {
  const marker = '[CONTEXT]:';
  const idx = systemInstruction.indexOf(marker);
  return idx === -1 ? '' : systemInstruction.slice(idx);
}

test('a clientEnv payload surfaces as a labelled, self-reported block in the system prompt', async () => {
  const req = makeReq({
    prompt: 'what timezone am I in',
    user: 'test-operator',
    pass: 'test-secret-pass',
    clientEnv: {
      timezone: 'Europe/London',
      language: 'en-GB',
      platform: 'Linux x86_64',
      viewportWidth: 412,
      viewportHeight: 915,
      online: true,
      localTime: 'Wed Sep 30 2026 15:00:00 GMT+0100'
    }
  }, { ip: '10.6.0.1' });
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(capturedSystemInstruction, 'expected the system instruction to be captured');
  assert.match(capturedSystemInstruction, /\[CLIENT ENVIRONMENT \(self-reported by the browser, not independently verified\)\]/);
  assert.match(capturedSystemInstruction, /Timezone: Europe\/London/);
  assert.match(capturedSystemInstruction, /Language: en-GB/);
  assert.match(capturedSystemInstruction, /Platform: Linux x86_64/);
  assert.match(capturedSystemInstruction, /Viewport: 412x915/);
  assert.match(capturedSystemInstruction, /Network: online/);
});

test('no clientEnv sent means no [CLIENT ENVIRONMENT] block at all', async () => {
  const req = makeReq(
    { prompt: 'hello', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.6.0.2' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(capturedSystemInstruction);
  assert.doesNotMatch(contextSection(capturedSystemInstruction), /\[CLIENT ENVIRONMENT/);
});

test('a malformed/non-object clientEnv is ignored rather than erroring', async () => {
  const req = makeReq(
    { prompt: 'hello', user: 'test-operator', pass: 'test-secret-pass', clientEnv: 'not-an-object' },
    { ip: '10.6.0.3' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(capturedSystemInstruction);
  assert.doesNotMatch(contextSection(capturedSystemInstruction), /\[CLIENT ENVIRONMENT/);
});

test('an empty clientEnv object produces no block (nothing usable to report)', async () => {
  const req = makeReq(
    { prompt: 'hello', user: 'test-operator', pass: 'test-secret-pass', clientEnv: {} },
    { ip: '10.6.0.4' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(contextSection(capturedSystemInstruction), /\[CLIENT ENVIRONMENT/);
});

test('an oversized clientEnv field is capped rather than bloating the prompt', async () => {
  const req = makeReq(
    { prompt: 'hello', user: 'test-operator', pass: 'test-secret-pass', clientEnv: { timezone: 'x'.repeat(5000) } },
    { ip: '10.6.0.5' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  const match = capturedSystemInstruction.match(/Timezone: (x+)/);
  assert.ok(match, 'expected a capped Timezone line');
  assert.ok(match[1].length <= 60, `expected capped length <= 60, got ${match[1].length}`);
});

test('/help names the three PG1 voice profiles and the error log FIX flow', async () => {
  const req = makeReq({ prompt: '/help' }, { ip: '10.6.0.6' });
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.body.reply, /PG1 Core, PG1 Classic or PG1 Field/);
  assert.match(res.body.reply, /ERROR LOG/);
  assert.doesNotMatch(res.body.reply, /cartesia/i);
});
