/**
 * Issue #197 Phase 1:
 *  - every 401 api/chat.mjs returns logs a short, secret-free reason
 *    (console.warn), so a 401 is never silent
 *  - SPEAK's real result (audioStatus/reason) is reported honestly — a
 *    successful synthesis is never reported for an unauthenticated request,
 *    and the "[DIAGNOSTIC]" reply always carries the real audioStatus
 *
 * Run with: node --test tests/chat-401-logging-and-speak.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_WARN = console.warn;

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  delete process.env.USER_API_USER;
  delete process.env.USER_API_PASSS;
  delete process.env.CARTESIA_API_KEY;
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  console.warn = ORIGINAL_WARN;
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

function captureWarnings() {
  const calls = [];
  console.warn = (...args) => { calls.push(args.join(' ')); };
  return calls;
}

test('unauthenticated SPEAK returns 401 and logs a reason (no secrets)', async () => {
  const warnings = captureWarnings();
  const req = makeReq({ prompt: 'hello', action: 'SPEAK' }, { ip: '10.3.0.1' });
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 401);
  assert.ok(warnings.some(w => w.includes('401') && w.includes('SPEAK')), 'expected a 401 log line naming the SPEAK route');
  for (const w of warnings) {
    assert.doesNotMatch(w, /test-secret-pass/, 'log line must never contain the password');
    assert.doesNotMatch(w, /hello/, 'log line must never contain the prompt/message content');
  }
});

test('unauthenticated CHAT returns 401 and logs a reason', async () => {
  const warnings = captureWarnings();
  const req = makeReq({ prompt: 'top secret message body' }, { ip: '10.3.0.2' });
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 401);
  assert.ok(warnings.some(w => w.includes('401') && w.includes('CHAT')), 'expected a 401 log line naming the CHAT route');
  for (const w of warnings) {
    assert.doesNotMatch(w, /top secret message body/, 'log line must never contain the prompt/message content');
  }
});

test('authenticated SPEAK with no TTS key configured reports SKIPPED_NO_KEY honestly, never SUCCESS', async () => {
  const req = makeReq(
    { prompt: 'read this aloud', action: 'SPEAK', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.3.0.3' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.audioStatus, 'SKIPPED_NO_KEY');
  assert.match(res.body.reply, /SKIPPED_NO_KEY/);
  assert.doesNotMatch(res.body.reply, /Status: SUCCESS/);
});
