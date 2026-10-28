// The sound of a world (public/sandbox/sound.js): the music's scale comes
// from the world's own seed, so each world has its own, the same every time.
// (The beds themselves need a browser: tests/browser/sandbox-sound.browser.test.mjs.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaleFor, chordAt, createSound } from '../public/sandbox/sound.js';

test('each world has its own scale, the same every time; chords stay in it', () => {
  assert.deepEqual(scaleFor(42), scaleFor(42));
  const scales = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => scaleFor(s).map((f) => f.toFixed(2)).join(',')));
  assert.ok(scales.size >= 4, `${scales.size} different scales`);
  const sc = scaleFor(7);
  for (let n = 0; n < 20; n++) for (const f of chordAt(sc, n)) assert.ok(sc.some((x) => Math.abs(Math.log2(f / x) - Math.round(Math.log2(f / x))) < 1e-9), `${f} is in the scale (any octave)`);
});

test('no sound without a browser: it stays off', () => {
  const s = createSound();
  assert.equal(s.playing, false);
  assert.equal(s.on(), false, 'nothing to play on');
  assert.equal(s.playing, false);
});
