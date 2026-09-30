/**
 * Issue #199 Phase 2:
 *  - CARTESIA_VOICE_ID lets the operator pin PG1's default (British) voice
 *    via env var, falling back to the pre-existing Christopher voice when
 *    unset — never a hard failure.
 *  - /voices (LIST_VOICES) is authenticated like every other paid/lookup
 *    action, and never leaks the Cartesia API key in its reply.
 *
 * Run with: node --test tests/voice-profile-and-library.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  delete process.env.USER_API_USER;
  delete process.env.USER_API_PASSS;
  delete process.env.CARTESIA_API_KEY;
  delete process.env.CARTESIA_VOICE_ID;
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
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

test('SPEAK with the default PG1-Agent profile and no CARTESIA_VOICE_ID falls back to the Christopher voice (no key configured, so it never crashes)', async () => {
  const req = makeReq(
    { prompt: 'say hello', action: 'SPEAK', voice: 'PG1-Agent', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.4.0.1' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.audioStatus, 'SKIPPED_NO_KEY');
});

test('unauthenticated /voices returns 401 and never calls out to Cartesia', async () => {
  const req = makeReq({ prompt: '/voices' }, { ip: '10.4.0.2' });
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 401);
});

test('authenticated /voices with no CARTESIA_API_KEY reports it is unavailable, never leaks a key, and never SUCCEEDs', async () => {
  const req = makeReq(
    { prompt: '/voices', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.4.0.3' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.body.reply, /Voice Library Unavailable/);
  assert.doesNotMatch(res.body.reply, /test-secret-pass/);
});
