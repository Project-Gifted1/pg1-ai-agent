/**
 * Issue #201 (bug fix, part 1):
 *  - A plain chat reply (no /speak, no SPEAK action) must never carry an
 *    audio/audioStatus/audioMimeType field. The client's playAudioResult()
 *    treats any present, non-"SUCCESS" audioStatus as a real TTS failure
 *    and flashes an error in the status bar. Before this fix, every plain
 *    reply carried a dead placeholder ("DECOUPLED_PENDING_ASYNC_CALL"),
 *    which is why an error flashed and disappeared on every single message
 *    regardless of whether VOICE was on, off, or whether TTS had run at all.
 *  - Because that placeholder also made playAudioResult() report "handled",
 *    it silently swallowed the VOICE:ON auto-speak follow-up request too —
 *    so this also verifies a reply that should auto-speak still gets a
 *    genuine opportunity to (audio-shaped fields absent -> client's own
 *    fallback fires exactly once, covered by the playAudioResult unit
 *    tests in voice-client-status-flash.test.mjs).
 *
 * Run with: node --test tests/voice-audio-status-regression.test.mjs
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

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
  globalThis.fetch = async (url) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
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

test('a plain authenticated chat reply carries no audio, audioStatus or audioMimeType field', async () => {
  const req = makeReq(
    { prompt: 'hello there', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.5.0.1' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reply, 'Stubbed model reply.');
  assert.equal('audio' in res.body, false, 'plain chat reply must not include an audio field');
  assert.equal('audioStatus' in res.body, false, 'plain chat reply must not include an audioStatus field');
  assert.equal('audioMimeType' in res.body, false, 'plain chat reply must not include an audioMimeType field');
});

test('a plain chat reply never carries the old DECOUPLED_PENDING_ASYNC_CALL placeholder', async () => {
  const req = makeReq(
    { prompt: 'what is the current status of things', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.5.0.2' }
  );
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.notEqual(res.body.audioStatus, 'DECOUPLED_PENDING_ASYNC_CALL');
});
