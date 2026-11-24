// The City browser tests' waits (tests/helpers/kingdomWaits.mjs): the 10 s
// rule unchanged when frames are fast; scaled to the frame time, and capped,
// on a slow software renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaledWait, framesAreFast, FAST_FRAME_MS, MAX_SCALE } from './helpers/kingdomWaits.mjs';

test('fast frames keep the 10 s rule; slow frames scale it, up to a cap', () => {
  assert.equal(scaledWait(40), 10000, 'a GPU');
  assert.equal(scaledWait(FAST_FRAME_MS), 10000, 'the boundary');
  assert.equal(framesAreFast(150), true);
  assert.equal(scaledWait(600), 24000, 'CI at 600 ms a frame');
  assert.equal(framesAreFast(600), false);
  assert.equal(scaledWait(1700), 10000 * MAX_SCALE, 'CI at 1.7 s a frame: capped');
  assert.equal(scaledWait(NaN), 10000, 'no measurement: the rule as written');
  assert.equal(scaledWait(500, 5000), 10000);
});
