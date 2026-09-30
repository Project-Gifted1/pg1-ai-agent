/**
 * Issue #199 Phase 2:
 *  - Voice profiles are a fixed server-side allow-list (core/classic/field).
 *    The browser only ever sends the profile name, never a provider voice
 *    ID; the server rejects anything not in the allow-list.
 *  - A missing profile falls back to "core" rather than failing.
 *  - No third-party (voice provider) names appear in any user-facing reply.
 *
 * Run with: node --test tests/voice-profile-and-library.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };

const THIRD_PARTY_NAMES = /cartesia|benedict|christopher|archie/i;

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  delete process.env.USER_API_USER;
  delete process.env.USER_API_PASSS;
  delete process.env.CARTESIA_API_KEY;
  delete process.env.CARTESIA_VOICE_ID;
  delete process.env.CARTESIA_VOICE_ID_FIELD;
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

test('SPEAK with an unknown voice profile is rejected, not silently substituted', async () => {
  const req = makeReq(
    { prompt: 'say hello', action: 'SPEAK', voice: 'not-a-real-profile', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.4.0.1' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.body.reply, /Unknown voice profile/);
  assert.equal(res.body.audioStatus, undefined);
});

test('SPEAK with no voice field falls back to the PG1 Core profile (no key configured, so it never crashes)', async () => {
  const req = makeReq(
    { prompt: 'say hello', action: 'SPEAK', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.4.0.2' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.audioStatus, 'SKIPPED_NO_KEY');
});

test('SPEAK accepts the "core" profile explicitly', async () => {
  const req = makeReq(
    { prompt: 'say hello', action: 'SPEAK', voice: 'core', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.4.0.3' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.audioStatus, 'SKIPPED_NO_KEY');
});

test('SPEAK with the "field" profile reports not-configured when CARTESIA_VOICE_ID_FIELD is unset', async () => {
  const req = makeReq(
    { prompt: 'say hello', action: 'SPEAK', voice: 'field', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.4.0.4' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.body.reply, /not configured/);
});

test('unauthenticated SPEAK is still rejected before any profile check', async () => {
  const req = makeReq({ prompt: 'say hello', action: 'SPEAK', voice: 'core' }, { ip: '10.4.0.5' });
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 401);
});

test('the /voices command no longer exists', async () => {
  const req = makeReq(
    { prompt: '/voices', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.4.0.6' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body.reply, /voice library/i);
});

test('/help never names a third-party voice provider or a specific voice', async () => {
  const req = makeReq({ prompt: '/help' }, { ip: '10.4.0.7' });
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body.reply, THIRD_PARTY_NAMES);
  assert.doesNotMatch(res.body.reply, /\/voices/);
});

test('unknown and not-configured voice-profile replies never name a third-party voice provider', async () => {
  const unknownReq = makeReq(
    { prompt: 'say hello', action: 'SPEAK', voice: 'nope', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.4.0.8' }
  );
  const unknownRes = makeRes();
  await chatHandler(unknownReq, unknownRes);
  assert.doesNotMatch(unknownRes.body.reply, THIRD_PARTY_NAMES);

  const fieldReq = makeReq(
    { prompt: 'say hello', action: 'SPEAK', voice: 'field', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.4.0.9' }
  );
  const fieldRes = makeRes();
  await chatHandler(fieldReq, fieldRes);
  assert.doesNotMatch(fieldRes.body.reply, THIRD_PARTY_NAMES);
});
