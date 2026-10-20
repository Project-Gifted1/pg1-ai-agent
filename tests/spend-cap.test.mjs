/**
 * Gemini's monthly spending cap, its own code spend_cap_reached
 * (lib/aiRouter.mjs isSpendCapFailure), apart from rate_limited and
 * out_of_credit: the chat router and its alerts, /keys, the film and movie
 * pre-spend check (lib/film/mediaCredit.mjs) and the film / movie failure
 * text.
 *
 * Self-heal report docs/self-heal/2026-10-19-78e001fc.md: "gemini
 * gemini-omni-1.1-flash movie shot 429: too_many_requests Your project has
 * exceeded its monthly spending cap." and "movie failed: out_of_credit at
 * shots".
 *
 * Run with: node --test tests/spend-cap.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isSpendCapFailure, isThrottle, mediaFailureKind, failureClass, FAILURE, SPEND_CAP_CODE } from '../lib/aiRouter.mjs';
import { accountState, alertText } from '../lib/router/alerts.mjs';
import { keysStatus, keysTable, stateFor, STATES, __resetKeysCache } from '../lib/keysStatus.mjs';
import { filmMediaCredit, mediaCreditText, SPEND_CAP_OPERATOR_TEXT } from '../lib/film/mediaCredit.mjs';
import { filmFailureMessage, filmFailureText } from '../lib/film/text.mjs';
import { MOVIE_FAILURE_TEXT } from '../lib/movie/text.mjs';
import { handleMovieCommand } from '../lib/movie/chat.mjs';
import { handleFilmCommand } from '../lib/film/chat.mjs';
import { EngineError, isMediaCapacityFailure } from '../lib/film/providers.mjs';
import { namesProvider } from '../lib/whiteLabel.mjs';

const CAP_TEXT = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap.' } });
const RATE_TEXT = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Please retry in 7s.' } });
const CREDIT_TEXT = JSON.stringify({ error: { code: 402, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted.' } });
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => __resetKeysCache());

// --- the code -------------------------------------------------------------------------

test('the spending-cap 429 is its own code: not a rate limit (never waited for), not out of credit', () => {
  assert.equal(SPEND_CAP_CODE, 'spend_cap_reached');
  assert.equal(isSpendCapFailure(429, CAP_TEXT), true);
  assert.equal(isSpendCapFailure(429, RATE_TEXT), false);
  assert.equal(isSpendCapFailure(402, CREDIT_TEXT), false);
  assert.equal(isSpendCapFailure(503, CAP_TEXT), false, 'a 5xx is an outage');
  assert.equal(isThrottle(429, CAP_TEXT), false, 'no waiting: it does not lift in seconds');
  assert.equal(mediaFailureKind(429, CAP_TEXT), 'spend_cap');
  assert.equal(mediaFailureKind(429, RATE_TEXT), 'throttled');
  assert.equal(mediaFailureKind(402, CREDIT_TEXT), 'billing');
  assert.equal(failureClass({ kind: 'spend_cap' }), FAILURE.CAPACITY, 'the next engine is tried');
  assert.equal(isMediaCapacityFailure(new EngineError('spend_cap', 'x', { status: 429 })), true);
});

// --- the chat router ------------------------------------------------------------------

test('router alerts: a capped paid Gemini says "reached its monthly spending cap", not "out of credit"', () => {
  assert.equal(accountState({ status: 429, detail: CAP_TEXT }), 'spend cap reached');
  assert.equal(accountState({ status: 402, detail: CREDIT_TEXT }), 'out of credit');
  assert.equal(accountState({ status: 429, detail: RATE_TEXT }), 'rate-limited');
  const t = alertText({ engine: 'gemini_paid', status: 429, detail: CAP_TEXT, what: 'chat replies', next: 'anthropic' });
  assert.equal(t.kind, 'spend_cap');
  assert.equal(t.title, 'Gemini (paid key) reached its monthly spending cap');
  assert.doesNotMatch(t.body, /out of credit|rate limited/);
});

// --- /keys ------------------------------------------------------------------------------

test('/keys: a capped paid Gemini shows "spend cap reached" with where to raise it; a drained one still shows out of credit', async () => {
  assert.equal(stateFor(429, CAP_TEXT), STATES.SPEND_CAP);
  assert.equal(stateFor(402, CREDIT_TEXT), STATES.NO_CREDIT);
  const env = { GEMINI_API_KEY_PAID: 'AQ.paid-SECRET-0123456789', GEMINI_API_KEY_FREE: 'AIza-free-SECRET-0123' };
  const rows = await keysStatus({ env, fresh: true, fetchImpl: async (u, o) => (o.headers['x-goog-api-key'] === env.GEMINI_API_KEY_PAID ? json(CAP_TEXT, 429) : json(RATE_TEXT, 429)) });
  const paid = rows.find((r) => r.engine === 'gemini_paid');
  assert.equal(paid.state, STATES.SPEND_CAP);
  assert.equal(paid.note, 'monthly spending cap reached; raise it at https://ai.studio/spend');
  assert.equal(rows.find((r) => r.engine === 'gemini_free').state, STATES.RATE_LIMITED);
  const table = keysTable(rows);
  assert.match(table, /\| Gemini \(paid key\) \| set \| SPEND CAP REACHED \| 429 \| monthly spending cap reached; raise it at https:\/\/ai\.studio\/spend \|/);
  assert.doesNotMatch(table.split('\n').find((l) => l.includes('Gemini (paid key)')), /OUT OF CREDIT/);
  assert.ok(!table.includes('SECRET'));
});

// --- film and movie: the pre-spend probe -------------------------------------------------

test('the pre-film check stops on the cap with the operator-only message, whatever the other engines say', async () => {
  const env = { GEMINI_API_KEY_PAID: 'AQ.paid-0123456789', REPLICATE_API_TOKEN: 'r8_0123456789' };
  const check = await filmMediaCredit({ env, rows: [{ engine: 'gemini_paid', set: true, state: STATES.SPEND_CAP }, { engine: 'replicate', set: true, state: STATES.WORKING }] });
  assert.equal(check.ok, false);
  assert.equal(check.spendCap, true);
  assert.equal(check.code, 'spend_cap_reached');
  assert.equal(SPEND_CAP_OPERATOR_TEXT, 'Gemini monthly spending cap reached — raise it at https://ai.studio/spend, then rerun.');
  const text = mediaCreditText(check, 'PG1 Studio');
  assert.equal(text, `PG1 Studio did not start this film. Nothing was spent.\n${SPEND_CAP_OPERATOR_TEXT}`);
  assert.match(mediaCreditText(check, 'PG1 Studio', 'movie'), /did not start this movie/);
  const fine = await filmMediaCredit({ env, rows: [{ engine: 'gemini_paid', set: true, state: STATES.WORKING }, { engine: 'replicate', set: true, state: STATES.WORKING }] });
  assert.equal(fine.ok, true);
  assert.equal(fine.spendCap, false);
});

// Every call the command makes; anything but the /keys probe would be spend
// (the database, the render dispatch, a voice lookup) and fails the test.
function probeOnly(state) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, o = {}) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('generativelanguage.googleapis.com')) return state === 'cap' ? json(CAP_TEXT, 429) : json({ candidates: [{ content: { parts: [{ text: '.' }] } }] });
      if (u.includes('api.replicate.com/v1/account')) return json({ username: 'x' });
      throw new Error('spent or wrote before the credit check: ' + u);
    }
  };
}
const STUDIO_ENV = { PG1_FILM_CREDIT_CHECK: '1', PG1_VIDEO_ENABLED: '1', PG1_VIDEO_RENDER_SECRET: 'film-secret-0123456789abcdef', GITHUB_TOKEN: 'gh-token', GEMINI_API_KEY_PAID: 'AQ.paid-0123456789', REPLICATE_API_TOKEN: 'r8_0123456789' };

test('/movie: a capped Gemini project stops before the screenplay, with the operator-only spend-cap line', async () => {
  const { calls, fetchImpl } = probeOnly('cap');
  const failures = [];
  const out = await handleMovieCommand({ text: '/movie "two bakers share an oven" --length 1', env: STUDIO_ENV, supUrl: 'https://supabase.test', supKey: 'k', isOperator: true, fetchImpl, requestId: 'req-cap', onFailure: (f) => failures.push(f) });
  assert.equal(out.reply, `PG1 Studio did not start this movie. Nothing was spent.\n${SPEND_CAP_OPERATOR_TEXT}`);
  assert.ok(calls.every((u) => /generativelanguage|replicate\.com\/v1\/account/.test(u)), 'only the /keys probe ran');
  assert.deepEqual(failures.map((f) => f.reason), ['spend_cap_reached']);
});

test('/film: a capped Gemini project stops before the storyboard, with the operator-only spend-cap line', async () => {
  const { calls, fetchImpl } = probeOnly('cap');
  const failures = [];
  const out = await handleFilmCommand({ text: '/film a harbour at dawn', env: STUDIO_ENV, supUrl: 'https://supabase.test', supKey: 'k', isOperator: true, fetchImpl, requestId: 'req-cap', onFailure: (f) => failures.push(f) });
  assert.equal(out.reply, `PG1 Studio did not start this film. Nothing was spent.\n${SPEND_CAP_OPERATOR_TEXT}`);
  assert.ok(calls.every((u) => /generativelanguage|replicate\.com\/v1\/account/.test(u)), 'only the /keys probe ran');
  assert.ok(failures.some((f) => f.reason === 'spend_cap_reached'));
});

test('a film or movie that hits the cap mid-render says so in PG1 words (white label), never "out of credit"', () => {
  const film = filmFailureMessage({ id: 'baf90f8a-6266-4f4c-9e2f-ecd564811dbb', error_reason: 'spend_cap_reached', mode: 'director', failure: { stage: 'director', step: 'clips', engine: 'gemini_paid' } });
  assert.match(film, /monthly spending cap is reached/);
  assert.doesNotMatch(film, /out of credit/);
  assert.equal(namesProvider(film), false, 'client-facing: no provider name');
  assert.match(filmFailureText('spend_cap_reached'), /monthly spending cap/);
  assert.match(MOVIE_FAILURE_TEXT.spend_cap_reached, /monthly spending cap/);
  assert.equal(namesProvider(MOVIE_FAILURE_TEXT.spend_cap_reached), false);
});
