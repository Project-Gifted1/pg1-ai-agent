/**
 * Issue #201 (bug fix, part 1):
 *  - playAudioResult() (public/index.html) is the single place that decides
 *    whether a reply's audio-shaped fields warrant a status-bar error. It
 *    must stay silent (return false, no flashStatus call) when neither
 *    `audio` nor a non-"SUCCESS" `audioStatus` is present — that is exactly
 *    the shape of a plain chat reply, and treating it as a failure was the
 *    root cause of the error that flashed and disappeared on every reply.
 *  - It must still flash a real error when audioStatus reports a genuine
 *    synthesis failure (e.g. no TTS key configured, or a provider error).
 *
 * This extracts the exact shipped function source from public/index.html
 * (rather than re-implementing the logic) so the test fails if the guarded
 * behavior regresses, however the surrounding markup changes.
 *
 * Run with: node --test tests/voice-client-status-flash.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '../public/index.html'), 'utf-8');

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in public/index.html`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error(`could not find end of function ${name}`);
  return source.slice(start, end);
}

const playAudioResultSource = extractFunction(html, 'playAudioResult');

function loadPlayAudioResult({ onFlashStatus, onShowTapToPlay, playImpl } = {}) {
  const AudioStub = function (src) {
    this.src = src;
    this.play = playImpl || (() => Promise.resolve());
  };
  const factory = new Function(
    'Audio', 'console', 'showTapToPlay', 'flashStatus',
    `${playAudioResultSource}\nreturn playAudioResult;`
  );
  return factory(
    AudioStub,
    console,
    onShowTapToPlay || (() => {}),
    onFlashStatus || (() => {})
  );
}

test('a reply with no audio-shaped fields is not treated as a failure', () => {
  const flashCalls = [];
  const playAudioResult = loadPlayAudioResult({ onFlashStatus: (msg) => flashCalls.push(msg) });

  const attempted = playAudioResult({ reply: 'just text, no audio fields at all' });

  assert.equal(attempted, false);
  assert.deepEqual(flashCalls, []);
});

test('the old dead placeholder status, if it ever reappeared, would still be treated as audio-shaped (regression guard)', () => {
  // This documents *why* the server-side fix matters: playAudioResult() has
  // no way to tell a real failure apart from a placeholder that merely LOOKS
  // like one. The server must simply never send audioStatus on a reply that
  // never attempted synthesis (see api/chat.mjs) — this test just confirms
  // playAudioResult()'s contract hasn't silently changed to compensate.
  const flashCalls = [];
  const playAudioResult = loadPlayAudioResult({ onFlashStatus: (msg) => flashCalls.push(msg) });

  const attempted = playAudioResult({ audioStatus: 'DECOUPLED_PENDING_ASYNC_CALL' });

  assert.equal(attempted, true);
  assert.equal(flashCalls.length, 1);
});

test('a genuine synthesis failure still flashes an error', () => {
  const flashCalls = [];
  const playAudioResult = loadPlayAudioResult({ onFlashStatus: (msg) => flashCalls.push(msg) });

  const attempted = playAudioResult({ audioStatus: 'SKIPPED_NO_KEY' });

  assert.equal(attempted, true);
  assert.equal(flashCalls.length, 1);
  assert.match(flashCalls[0], /SKIPPED_NO_KEY/);
});

test('a successful audioStatus with no audio payload is not flashed as an error', () => {
  const flashCalls = [];
  const playAudioResult = loadPlayAudioResult({ onFlashStatus: (msg) => flashCalls.push(msg) });

  const attempted = playAudioResult({ audioStatus: 'SUCCESS' });

  assert.equal(attempted, false);
  assert.deepEqual(flashCalls, []);
});

test('a reply carrying real audio plays it and does not flash an error', () => {
  const flashCalls = [];
  const playAudioResult = loadPlayAudioResult({ onFlashStatus: (msg) => flashCalls.push(msg) });

  const attempted = playAudioResult({ audio: 'aGVsbG8=', audioMimeType: 'audio/mp3', audioStatus: 'SUCCESS' });

  assert.equal(attempted, true);
  assert.deepEqual(flashCalls, []);
});
