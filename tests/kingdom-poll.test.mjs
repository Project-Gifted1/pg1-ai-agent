// PG1 City's feed polls on a fixed cadence (public/kingdom/kingdom-ui.js):
// the next poll comes KINGDOM_POLL_MS after the last one began, so a slow
// fetch never stretches the gap and a live event shows within one interval
// plus one fetch (the "in the scene within 10 s" rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPollDelay, KINGDOM_POLL_MS } from '../public/kingdom/kingdom-ui.js';

test('the next poll is timed from the start of the last one, never after a slow fetch', () => {
  assert.equal(KINGDOM_POLL_MS, 5000);
  assert.equal(nextPollDelay(0, 200), 4800, 'a quick fetch: the rest of the interval');
  assert.equal(nextPollDelay(0, 3000), 2000, 'a slow fetch does not add to the gap');
  assert.equal(nextPollDelay(0, 9000), 250, 'a fetch longer than the interval: poll again almost at once');
  assert.equal(nextPollDelay(1000, 500), 5000, 'a clock that steps back never waits longer than the interval');
  // Worst case for a live event: added just after a poll began, seen by the next one.
  const fetchMs = 3000; const worst = KINGDOM_POLL_MS + fetchMs;
  assert.ok(worst <= 10000, `${worst} ms`);
});

test('the badge says paused only when fetches fail, never because the page was late to poll', async () => {
  const { feedConnected, PAUSED_AFTER_FAILS, FEED_TIMEOUT_MS } = await import('../public/kingdom/kingdom-ui.js');
  const t0 = 1_000_000;
  assert.equal(feedConnected({ fails: 0, lastOkAt: 0, now: t0 }), false, 'nothing read yet');
  assert.equal(feedConnected({ fails: 0, lastOkAt: t0, lastAttemptAt: t0 - 100, now: t0 + 40000 }), true, 'a busy page: 40 s since the last poll, none of them failed');
  assert.equal(feedConnected({ fails: 0, lastOkAt: t0, lastAttemptAt: t0 + 1000, now: t0 + 5000 }), true, 'a poll in flight for 4 s');
  assert.equal(feedConnected({ fails: 0, lastOkAt: t0, lastAttemptAt: t0 + 1000, now: t0 + 17000 }), false, 'an attempt unanswered for 16 s');
  assert.equal(feedConnected({ fails: PAUSED_AFTER_FAILS, lastOkAt: t0, lastAttemptAt: t0, now: t0 + 1000 }), false, 'two failed fetches in a row');
  assert.ok(FEED_TIMEOUT_MS < 15000, 'a hung fetch fails before the 15 s rule');
});
