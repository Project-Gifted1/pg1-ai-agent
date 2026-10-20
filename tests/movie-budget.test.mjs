/**
 * PG1 Studio movies: spending (20 Oct, movie 6da446ca: shots rejected by
 * the dailies were re-rendered three times each, 27 clips in 16 minutes for
 * ~12 shots, until the paid Gemini key ran out of credit; the dailies then
 * went to OpenRouter's free DeepSeek model and to a Claude key with no
 * credit).
 *
 *  - the retake cap stops a loop: at most PG1_MOVIE_MAX_RETAKES (default 1)
 *    retakes per shot, the better take kept, the QC gate never adds one;
 *  - the budget pauses the shoot before it overspends (paused_budget, not
 *    failed), and says what finishing needs;
 *  - a credit probe or a 402 pauses it too, before the next clip;
 *  - resume continues from the first missing shot and never re-renders a
 *    saved one;
 *  - customer data only reaches commercial_ok engines: never OpenRouter, a
 *    free engine or a DeepSeek model; a key known to be out of credit is
 *    skipped for an hour; the dailies use the cheapest commercial_ok model,
 *    once per take.
 *
 * No ffmpeg, no network: stand-in engines, ffmpeg and audio.
 * Run with: node --test tests/movie-budget.test.mjs
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { __resetRouterState, planRoute, TASKS, DATA, tripBreaker, isOutOfCredit, OPENROUTER_FREE_MODELS, openRouterFreeModels, routeModels } from '../lib/aiRouter.mjs';
import { parseScreenplay } from '../lib/movie/screenplay.mjs';
import { estimateMovie, maxRetakes, MAX_RETAKES } from '../lib/movie/cost.mjs';
import { runMovie, planMovie, MoviePaused } from '../lib/movie/pipeline.mjs';
import { MOVIE_DAILIES_SYSTEM } from '../lib/movie/qc.mjs';
import { handleMovieCommand, handleMovieApproval, movieCard, isResumable } from '../lib/movie/chat.mjs';
import { parseMovieCommand, isMoviePaused, moviePausedText, MOVIE_ACTIONS } from '../lib/movie/text.mjs';
import { movieCreditOk } from '../lib/movie/engines.mjs';
import { filmTextPlan, filmThink, ANTHROPIC_URL, GEMINI_API } from '../lib/film/providers.mjs';
import { createFilmStore } from '../lib/film/store.mjs';
import { namesProvider } from '../lib/whiteLabel.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch, json } from './helpers/filmDb.mjs';
import { SCREENPLAY, PNG } from './helpers/movieFixtures.mjs';

const SUP = 'https://supabase.test';
const clone = (v) => JSON.parse(JSON.stringify(v));
const SP = parseScreenplay(clone(SCREENPLAY), { minutes: 0.5 });
const BANNED = /(?<![a-z0-9])(?:eleven[\s_-]*labs|google|gemini|veo|lyria|replicate|kling|cartesia|flux|openrouter|openai|anthropic|claude|gpt|omni|deepseek)(?![a-z0-9])/i;
const assertWhite = (text, what) => { assert.ok(!namesProvider(text) && !BANNED.test(text), `${what} names a provider: ${String(text).match(BANNED)}`); };

// ffmpeg and audio stand-ins: every take is clipS long and its line spans
// most of it. The edit is never reached (assemble needs real ffmpeg): the
// tests stop at the shots, or after them on purpose.
const ff = {
  probeDuration: async () => 4,
  extractFrame: async (file, t, out) => { await writeFile(out, 'frame'); return out; },
  probeMedia: async () => ({ width: 640, height: 360 }),
  masterSizeFor: () => { throw new Error('edit reached'); }
};
const au = {
  extractTakeAudio: async (f, out) => { await writeFile(out, 'wav'); return out; },
  fitToLength: async (f, s, out) => { await writeFile(out, 'wav'); return { file: out, sourceS: s, convertedS: s, durationS: s, tempo: 1 }; },
  speechSpan: async () => ({ startS: 0.4, endS: 3.6 })
};

// Engines: every dailies verdict follows failPlan[shot][take - 1] ('fail' or
// 'pass', default pass); creditAfter: the credit probe says no after that
// many clips; billingAt: the clip call answers a 402 on that clip number.
function engines({ calls, failPlan = {}, creditAfter = Infinity, billingAt = Infinity } = {}) {
  let clips = 0;
  return {
    think: async ({ system, content, validate }) => {
      const blob = (Array.isArray(content) ? content : [content]).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (system !== MOVIE_DAILIES_SYSTEM) throw new Error('only the dailies think here');
      const m = /Shot (\S+) \(take (\d+)\)/.exec(blob);
      calls.push({ step: 'dailies', shot: m[1], take: Number(m[2]) });
      const v = (failPlan[m[1]] || [])[Number(m[2]) - 1] || 'pass';
      const text = JSON.stringify(v === 'fail' ? { pass: false, score: 3, issues: [{ type: 'character_mismatch', detail: 'wrong coat' }], best_start_s: 0.2, description: 'x' } : { pass: true, score: 8, issues: [], best_start_s: 0.2, description: 'ok' });
      return validate ? { value: validate(text), text } : { text };
    },
    image: () => ({ type: 'image' }),
    still: async () => { calls.push({ step: 'still' }); return { bytes: PNG }; },
    creditOk: async () => ({ ok: clips < creditAfter, detail: 'the picture engine is out of credit' }),
    dialogueClip: async ({ shot }) => {
      clips++;
      if (clips === billingAt) throw Object.assign(new Error('out of credit'), { kind: 'billing', notStarted: true, detail: 'gemini movie shot 402: Your prepayment credits are depleted' });
      calls.push({ step: 'clip', shot: shot.id });
      return { bytes: Buffer.from('clip') };
    },
    sts: async () => { calls.push({ step: 'sts' }); return { wav: Buffer.from('wav') }; },
    sfx: async () => { calls.push({ step: 'sfx' }); throw new Error('no sound in these tests'); },
    music: async () => { calls.push({ step: 'music' }); throw new Error('no sound in these tests'); },
    voiceFor: () => 'voice-x'
  };
}

async function setup({ capUsd = 60, director = {} } = {}) {
  const db = await makeFilmDb();
  const fetchImpl = routedFetch(filmDbRoutes(db));
  const store = createFilmStore({ supUrl: SUP, supKey: 'k', fetchImpl });
  const p = await store.createProject({ request: 'two bakers race the dawn', capUsd, status: 'directing' });
  const d = { kind: 'movie', minutes: 0.5, narration: false, screenplay: SP, approvals: { script: 'x', budget: 'y' }, ...director };
  const planned = planMovie(d);
  await store.updateProject(p.id, { mode: 'director', director: { ...d, bibles: planned.bibles, shots: planned.shots } });
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'mv-budget-'));
  return { db, store, fetchImpl, id: p.id, shots: planned.shots, workdir };
}
const run = (ctx, eng, env = {}) => runMovie({ project: ctx.storeProject, store: ctx.store, engines: eng, ff, au, env, workdir: ctx.workdir });
const clipsFor = (calls, id) => calls.filter((c) => c.step === 'clip' && c.shot === id).length;

beforeEach(() => __resetRouterState());

describe('the retake cap', () => {
  test('a shot that keeps failing its dailies gets one retake, keeps its better take and the shoot moves on', async () => {
    assert.equal(MAX_RETAKES, 1);
    assert.equal(maxRetakes({}), 1);
    assert.equal(maxRetakes({ PG1_MOVIE_MAX_RETAKES: '0' }), 0);
    assert.equal(maxRetakes({ PG1_MOVIE_MAX_RETAKES: '9' }), 1, 'not a digit 0-3: the default');
    const ctx = await setup();
    const calls = [];
    const failing = ctx.shots[1].id;
    ctx.storeProject = await ctx.store.getProject(ctx.id);
    await assert.rejects(run(ctx, engines({ calls, failPlan: { [failing]: ['fail', 'fail', 'fail', 'fail'] } })), /edit reached/);
    assert.equal(clipsFor(calls, failing), 2, 'the first take and one retake, never a third');
    for (const s of ctx.shots.filter((x) => x.id !== failing)) assert.equal(clipsFor(calls, s.id), 1, s.id);
    assert.equal(calls.filter((c) => c.step === 'dailies' && c.shot === failing).length, 2, 'each take reviewed once');
    const p = await ctx.store.getProject(ctx.id);
    assert.equal(p.director.takes[failing].attempts.length, 2);
    assert.equal(p.director.takes[failing].accepted.flagged, true, 'kept, flagged, moved on');
    assert.equal(Object.values(p.director.takes).filter((t) => t.accepted).length, ctx.shots.length, 'every shot accepted and saved');
  });

  test('PG1_MOVIE_MAX_RETAKES=0: one take per shot, whatever the dailies say', async () => {
    const ctx = await setup();
    const calls = [];
    ctx.storeProject = await ctx.store.getProject(ctx.id);
    await assert.rejects(run(ctx, engines({ calls, failPlan: Object.fromEntries(ctx.shots.map((s) => [s.id, ['fail', 'fail']])) }), { PG1_MOVIE_MAX_RETAKES: '0' }), /edit reached/);
    assert.equal(calls.filter((c) => c.step === 'clip').length, ctx.shots.length);
  });

  test('the estimate: worst case is every new shot on all its allowed takes', () => {
    const planned = planMovie({ screenplay: SP });
    const one = estimateMovie({ screenplay: SP, bibles: planned.bibles, shots: planned.shots, retakes: 1 });
    const two = estimateMovie({ screenplay: SP, bibles: planned.bibles, shots: planned.shots, retakes: 2 });
    const none = estimateMovie({ screenplay: SP, bibles: planned.bibles, shots: planned.shots, retakes: 0 });
    assert.equal(one.takesPerShot, 2);
    assert.ok(none.worstUsd < one.worstUsd && one.worstUsd < two.worstUsd);
    assert.equal(none.worstUsd, none.expectedUsd, 'no retakes: the worst case is the plan');
  });
});

describe('the budget pauses the shoot before it overspends', () => {
  test('the next clip would go over the cap: paused (not failed), nothing over the cap spent, the shots so far saved', async () => {
    // The references cost 8 x stills; the cap leaves room for a few shots.
    const ctx = await setup({ capUsd: 6 });
    const calls = [];
    ctx.storeProject = await ctx.store.getProject(ctx.id);
    const err = await run(ctx, engines({ calls })).then(() => null, (e) => e);
    assert.ok(err instanceof MoviePaused, String(err && err.stack));
    assert.equal(err.reason, 'budget');
    const p = await ctx.store.getProject(ctx.id);
    assert.ok(Number(p.spent_usd) <= 6 + 1e-9, `spent ${p.spent_usd} of a 6 USD cap`);
    const saved = Object.values(p.director.takes || {}).filter((t) => t.accepted).length;
    assert.ok(saved >= 1 && saved < ctx.shots.length, `saved ${saved}`);
    assert.equal(calls.filter((c) => c.step === 'clip').length, saved, 'no clip made that was not paid for and saved');
    assert.equal(err.shotsDone, saved);
    assert.ok(err.needUsd > 0 && err.worstUsd >= err.needUsd);
    const text = moviePausedText({ id: ctx.id, director: { ...p.director, pause: { reason: err.reason, needUsd: err.needUsd, worstUsd: err.worstUsd, shotsDone: err.shotsDone, shotsTotal: err.shotsTotal } } });
    assert.match(text, /paused before spending more/);
    assert.match(text, /To finish: about \d+\.\d\d USD/);
    assert.match(text, /\/movie resume [0-9a-f]{8}/);
    assertWhite(text, 'paused text');
  });

  test('the credit probe says no: paused before the next clip, nothing more spent', async () => {
    const ctx = await setup();
    const calls = [];
    ctx.storeProject = await ctx.store.getProject(ctx.id);
    const err = await run(ctx, engines({ calls, creditAfter: 2 })).then(() => null, (e) => e);
    assert.ok(err instanceof MoviePaused);
    assert.equal(err.reason, 'credit');
    assert.ok(calls.filter((c) => c.step === 'clip').length <= 3, 'at most the clips already started');
  });

  test('a 402 on a clip pauses the movie (credit), it does not fail it', async () => {
    const ctx = await setup();
    const calls = [];
    ctx.storeProject = await ctx.store.getProject(ctx.id);
    const err = await run(ctx, engines({ calls, billingAt: 3 })).then(() => null, (e) => e);
    assert.ok(err instanceof MoviePaused, String(err));
    assert.equal(err.reason, 'credit');
    assert.match(err.detail, /prepayment credits are depleted/);
  });

  test('the credit probe: a picture engine known to be out of credit is a no, with no paid call', async () => {
    const env = { GEMINI_API_KEY_PAID: 'AQ.paid-0123456789', ELEVENLABS_API_KEY: 'sk_el_0123456789' };
    assert.deepEqual(await movieCreditOk({ env, fetchImpl: async () => { throw new Error('no call'); } }), { ok: true });
    tripBreaker('gemini_paid', 402, 'Your prepayment credits are depleted');
    const r = await movieCreditOk({ env, fetchImpl: async () => { throw new Error('no call'); } });
    assert.equal(r.ok, false);
    assert.match(r.detail, /out of credit/);
  });
});

describe('resume never pays twice', () => {
  test('a paused movie resumes from the first missing shot; saved shots are never rendered again', async () => {
    const ctx = await setup({ capUsd: 6 });
    const calls = [];
    ctx.storeProject = await ctx.store.getProject(ctx.id);
    await assert.rejects(run(ctx, engines({ calls })), (e) => e instanceof MoviePaused);
    const before = await ctx.store.getProject(ctx.id);
    const savedIds = Object.entries(before.director.takes).filter(([, t]) => t.accepted).map(([k]) => k);
    const refsBefore = calls.filter((c) => c.step === 'still').length;
    await ctx.store.updateProject(ctx.id, { cap_usd: 60, status: 'directing' });
    const again = [];
    ctx.storeProject = await ctx.store.getProject(ctx.id);
    await assert.rejects(run(ctx, engines({ calls: again })), /edit reached/);
    for (const id of savedIds) assert.equal(clipsFor(again, id), 0, `${id} is saved: not made again`);
    assert.equal(again.filter((c) => c.step === 'clip').length, ctx.shots.length - savedIds.length, 'only the missing shots');
    assert.equal(again.filter((c) => c.step === 'still').length, 0, 'the bible references are reused');
    assert.ok(refsBefore > 0);
  });

  test('/movie resume: confirm a new cap for what is left, then the shoot is queued; paused stored as failed + paused_budget counts too', async () => {
    const db = await makeFilmDb();
    const dispatched = [];
    const fetchImpl = routedFetch([...filmDbRoutes(db), ['api.github.com', (u, o, body) => { dispatched.push(body); return new Response(null, { status: 204 }); }]]);
    const store = createFilmStore({ supUrl: SUP, supKey: 'k', fetchImpl });
    const env = { PG1_VIDEO_RENDER_SECRET: 'movie-secret-0123456789abcdef', GITHUB_TOKEN: 'gh-token' };
    const p = await store.createProject({ request: 'two bakers', capUsd: 6, status: 'directing' });
    const planned = planMovie({ screenplay: SP });
    const d = { kind: 'movie', minutes: 0.5, screenplay: SP, bibles: planned.bibles, shots: planned.shots, approvals: { script: 'x', budget: 'y' }, takes: { [planned.shots[0].id]: { attempts: [{ attempt: 1 }], accepted: { attempt: 1, clip: 'c' } } }, pause: { reason: 'budget', needUsd: 9, worstUsd: 12, shotsDone: 1, shotsTotal: planned.shots.length } };
    // Before the migration: failed + error_reason paused_budget.
    await store.updateProject(p.id, { mode: 'director', status: 'failed', error_reason: 'paused_budget', spent_usd: 5.5, director: d });
    const fresh = await store.getProject(p.id);
    assert.ok(isMoviePaused(fresh) && isResumable(fresh));
    const card = await movieCard(store, fresh);
    assert.equal(card.resumeCommand, `/movie resume ${p.id.slice(0, 8)}`);
    assert.match(card.message, /paused before spending more/);
    assertWhite(JSON.stringify({ ...card, previewUrl: null, finalUrl: null, posterUrl: null }), 'paused card');

    assert.equal(parseMovieCommand(`/movie resume ${p.id.slice(0, 8)} --budget 20`).budgetUsd, 20);
    const cmd = (text) => handleMovieCommand({ text, env, supUrl: SUP, supKey: 'k', isOperator: true, fetchImpl });
    const r = await cmd(`/movie resume ${p.id.slice(0, 8)} --budget 20`);
    assertWhite(r.reply, 'resume');
    assert.match(r.reply, /1 of \d+ shots are saved/);
    assert.deepEqual(r.pendingApproval.labels, { approve: 'Confirm', decline: 'Cancel' });
    assert.equal(dispatched.length, 0, 'nothing queued before Confirm');
    const row = (await db.query('select * from pending_actions where action_type = $1 order by created_at desc limit 1', [MOVIE_ACTIONS.retry])).rows[0];
    assert.equal(row.plan.capUsd, 25.5, 'what is spent plus the new budget');
    const ok = await handleMovieApproval({ row, decision: 'approve', env, supUrl: SUP, supKey: 'k', isOperator: true, fetchImpl });
    assertWhite(ok.reply, 'resume approved');
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].inputs.stage, 'movie');
    const q = await store.getProject(p.id);
    assert.equal(q.status, 'director_queued');
    assert.equal(Number(q.cap_usd), 25.5);
    assert.equal(q.director.pause, null);
    assert.deepEqual(q.director.takes[planned.shots[0].id].accepted, { attempt: 1, clip: 'c' }, 'the saved shot is kept');
    // A movie that is not paused has nothing to resume.
    const done = await cmd(`/movie resume ${p.id.slice(0, 8)}`);
    assert.match(done.reply, /not paused/);
  });

  test('Rerun: a failed movie\'s card has the button; /movie rerun continues from the step it failed at, after Confirm, with a cap for what is left', async () => {
    const db = await makeFilmDb();
    const dispatched = [];
    const fetchImpl = routedFetch([...filmDbRoutes(db), ['api.github.com', (u, o, body) => { dispatched.push(body); return new Response(null, { status: 204 }); }]]);
    const store = createFilmStore({ supUrl: SUP, supKey: 'k', fetchImpl });
    const env = { PG1_VIDEO_RENDER_SECRET: 'movie-secret-0123456789abcdef', GITHUB_TOKEN: 'gh-token' };
    const p = await store.createProject({ request: 'two bakers', capUsd: 6, status: 'directing' });
    const planned = planMovie({ screenplay: SP });
    const [first, second] = planned.shots;
    const d = { kind: 'movie', minutes: 0.5, screenplay: SP, bibles: planned.bibles, shots: planned.shots, approvals: { script: 'x', budget: 'y' }, takes: { [first.id]: { attempts: [{ attempt: 1 }], accepted: { attempt: 1, clip: 'c' } }, [second.id]: { attempts: [{ attempt: 1, error: 'engine_error' }] } } };
    // The 20 Oct movie: stopped out of credit at the shots.
    await store.updateProject(p.id, { mode: 'director', status: 'failed', error_reason: 'cap_reached', spent_usd: 6, failure: { stage: 'movie', step: 'shots' }, director: d });
    const card = await movieCard(store, await store.getProject(p.id));
    assert.equal(card.rerunCommand, `/movie rerun ${p.id.slice(0, 8)}`);
    assert.equal(card.resumeCommand, undefined);
    assert.match(card.message, /\/movie rerun [0-9a-f]{8} \(or the Rerun button\) continues from there/);
    assertWhite(JSON.stringify({ ...card, previewUrl: null, finalUrl: null, posterUrl: null }), 'failed card');
    assert.equal(parseMovieCommand(`/movie rerun ${p.id.slice(0, 8)}`).sub, 'rerun');

    const r = await handleMovieCommand({ text: `/movie rerun ${p.id.slice(0, 8)}`, env, supUrl: SUP, supKey: 'k', isOperator: true, fetchImpl });
    assertWhite(r.reply, 'rerun');
    assert.match(r.reply, new RegExp(`1 of ${planned.shots.length} shots are saved; the rerun continues from shot ${second.id}`));
    assert.match(r.reply, /Confirm to rerun; nothing is spent before you do/);
    assert.deepEqual(r.pendingApproval.labels, { approve: 'Confirm', decline: 'Cancel' });
    assert.equal(dispatched.length, 0, 'nothing queued before Confirm');
    const row = (await db.query('select * from pending_actions where action_type = $1 order by created_at desc limit 1', [MOVIE_ACTIONS.retry])).rows[0];
    assert.ok(row.plan.capUsd > 6, 'a movie stopped by its cap gets room for what is left');
    const ok = await handleMovieApproval({ row, decision: 'approve', env, supUrl: SUP, supKey: 'k', isOperator: true, fetchImpl });
    assertWhite(ok.reply, 'rerun approved');
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].inputs.stage, 'movie');
    const q = await store.getProject(p.id);
    assert.equal(q.status, 'director_queued');
    assert.equal(Number(q.cap_usd), row.plan.capUsd);
    assert.deepEqual(q.director.takes[first.id].accepted, { attempt: 1, clip: 'c' }, 'the saved shot is kept');
    assert.equal(q.director.takes[second.id].attempts.length, 1, 'the failed shot keeps its count: its cap still holds');
  });

  test('the paused_budget status itself (after the migration) is read the same way', async () => {
    const db = await makeFilmDb();
    const store = createFilmStore({ supUrl: SUP, supKey: 'k', fetchImpl: routedFetch(filmDbRoutes(db)) });
    const p = await store.createProject({ request: 'x', capUsd: 6, status: 'directing' });
    const rows = await store.updateProject(p.id, { mode: 'director', status: 'paused_budget', director: { kind: 'movie', approvals: { budget: 'y' } } });
    assert.equal(rows[0].status, 'paused_budget', 'the migration allows the status');
    assert.ok(isMoviePaused(rows[0]) && isResumable(rows[0]));
  });
});

describe('the budget checkpoint', () => {
  test('/movie --budget sets a hard cap; the budget proposal says Confirm / Cancel and the worst case', async () => {
    assert.equal(parseMovieCommand('/movie "two bakers" --length 0.5 --budget 12.5').budgetUsd, 12.5);
    assert.equal(parseMovieCommand('/movie "two bakers" --budget 12.5').idea, 'two bakers', '--budget is not part of the idea');
    assert.equal(parseMovieCommand('/movie "two bakers" --budget 0').budgetUsd, null);
    const db = await makeFilmDb();
    const dispatched = [];
    const fetchImpl = routedFetch([...filmDbRoutes(db), ['api.github.com', (u, o, body) => { dispatched.push(body); return new Response(null, { status: 204 }); }]]);
    const store = createFilmStore({ supUrl: SUP, supKey: 'k', fetchImpl });
    const env = { PG1_VIDEO_RENDER_SECRET: 'movie-secret-0123456789abcdef', GITHUB_TOKEN: 'gh-token' };
    for (const budget of [null, 12.5]) {
      const p = await store.createProject({ request: 'x', capUsd: 60, status: 'awaiting_preview_approval' });
      await store.updateProject(p.id, { mode: 'director', spent_usd: 0.15, director: { kind: 'movie', minutes: 0.5, screenplay: SP, approvals: {}, ...(budget ? { budgetUsd: budget } : {}) } });
      const token = `tok-${budget}`;
      await store.createPendingAction({ actionType: MOVIE_ACTIONS.script, plan: { projectId: p.id }, diffSummary: 'x', token });
      const row = (await db.query('select * from pending_actions where token = $1', [token])).rows[0];
      const a = await handleMovieApproval({ row, decision: 'approve', env, supUrl: SUP, supKey: 'k', isOperator: true, fetchImpl });
      assertWhite(a.reply, 'budget');
      assert.match(a.reply, /Confirm it to start the shoot; nothing is spent before you do/);
      assert.match(a.reply, /worst case \d+\.\d\d USD if every shot needs its retake \(2 takes per shot at most\)/);
      assert.deepEqual(a.pendingApproval.labels, { approve: 'Confirm', decline: 'Cancel' });
      const b = (await db.query('select * from pending_actions where action_type = $1 order by created_at desc limit 1', [MOVIE_ACTIONS.budget])).rows[0];
      const est = (await store.getProject(p.id)).director.estimate;
      assert.equal(b.plan.capUsd, Math.round((0.15 + (budget || est.worstUsd)) * 100) / 100);
      assert.equal(b.plan.maxRetakes, 1);
      await handleMovieApproval({ row: b, decision: 'approve', env, supUrl: SUP, supKey: 'k', isOperator: true, fetchImpl });
      const q = await store.getProject(p.id);
      assert.equal(q.status, 'director_queued');
      assert.equal(Number(q.cap_usd), b.plan.capUsd, 'the confirmed budget is the hard cap');
      assert.equal(q.director.maxRetakes, 1);
    }
  });
});

describe('customer data only reaches commercial_ok engines', () => {
  const ALL = { ANTHROPIC_API_KEY: 'sk-ant-x0123456789', GEMINI_API_KEY_PAID: 'AQ.paid-0123456789', GEMINI_API_KEY_FREE: 'AIza-free-0123456789', OPENROUTER_API_KEY: 'sk-or-0123456789', OPENAI_API_KEY: 'sk-openai-0123', VERCEL_AI_API_KEY: 'gw-0123', GROQ_API_KEY: 'gsk_0123', MISTRAL_API_KEY: 'mis_0123', GITHUB_MODELS_TOKEN: 'ghm_0123' };

  test('never OpenRouter, a free engine or DeepSeek; with no commercial_ok engine left the plan is empty', () => {
    for (const task of [TASKS.LIGHT, TASKS.HEAVY]) {
      const plan = planRoute(task, { env: ALL, dataClass: DATA.CUSTOMER });
      assert.deepEqual([...new Set(plan.map((c) => c.provider))].sort(), ['anthropic', 'gemini_paid'], task);
      assert.ok(plan.every((c) => c.models.every((m) => !/deepseek/i.test(m))));
    }
    assert.deepEqual(planRoute(TASKS.HEAVY, { env: { OPENROUTER_API_KEY: 'sk-or-0123456789', GROQ_API_KEY: 'gsk_0123' }, dataClass: DATA.CUSTOMER }), []);
    for (const purpose of ['movie dailies s1-w1', 'storyboard check', 'movie: screenplay']) {
      const plan = filmTextPlan(ALL, { writing: false });
      assert.ok(plan.every((c) => ['anthropic', 'gemini_paid'].includes(c.provider)), purpose);
    }
  });

  test('no DeepSeek model in any engine list, whatever an env list says', () => {
    assert.ok(OPENROUTER_FREE_MODELS.every((m) => !/deepseek/i.test(m)));
    assert.ok(openRouterFreeModels({ PG1_OPENROUTER_FREE_MODELS: 'deepseek/deepseek-chat-v3.1:free,qwen/qwen3-coder:free' }).every((m) => !/deepseek/i.test(m)));
    assert.deepEqual(routeModels({ PG1_HEAVY_OPENROUTER_MODELS: 'deepseek/deepseek-r1,openai/gpt-5' }, 'heavy', 'openrouter'), ['openai/gpt-5']);
  });

  test('a key known to be out of credit is skipped (not called every shot), and checked again after an hour', async () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-x0123456789', GEMINI_API_KEY_PAID: 'AQ.paid-0123456789' };
    const seen = [];
    const credit = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } });
    const verdict = '{"pass":true,"score":8,"issues":[],"best_start_s":0.2,"description":"ok"}';
    const fetchImpl = routedFetch([
      [ANTHROPIC_URL, (u, o, body) => { seen.push(`anthropic:${body.model}`); return new Response(credit, { status: 400 }); }],
      [GEMINI_API, (u) => { seen.push(`gemini:${u.split('/').pop().split(':')[0]}`); return json({ candidates: [{ content: { parts: [{ text: verdict }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }); }]
    ]);
    const call = () => filmThink({ env, system: MOVIE_DAILIES_SYSTEM, content: 'shot', validate: JSON.parse, purpose: 'movie dailies s1-w1', fetchImpl, log: () => {} });
    await call();
    assert.ok(isOutOfCredit('anthropic'));
    for (let i = 0; i < 5; i++) await call();
    assert.equal(seen.filter((s) => s.startsWith('anthropic')).length, 1, 'the out-of-credit key was called once, not every shot');
    assert.deepEqual(filmTextPlan(env, { cheapest: true, now: Date.now() + 61 * 60 * 1000 }).map((c) => c.provider), ['anthropic', 'gemini_paid'], 'back in the plan after an hour');
  });

  test('the dailies: the cheapest commercial_ok model first, and one review per take (an unusable verdict is not asked again)', async () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-x0123456789', GEMINI_API_KEY_PAID: 'AQ.paid-0123456789' };
    const plan = filmTextPlan(env, { cheapest: true });
    assert.equal(plan[0].provider, 'anthropic');
    assert.deepEqual(plan[0].models, ['claude-haiku-5-5']);
    assert.equal(plan[1].models[0], 'gemini-3.6-flash', 'the cheaper Gemini model first');
    const seen = [];
    const fetchImpl = routedFetch([
      [ANTHROPIC_URL, (u, o, body) => { seen.push(body.model); return json({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 10, output_tokens: 5 } }); }],
      [GEMINI_API, () => { seen.push('gemini'); return json({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }); }]
    ]);
    await assert.rejects(filmThink({ env, system: MOVIE_DAILIES_SYSTEM, content: 'shot', validate: JSON.parse, purpose: 'movie dailies s1-w1', fetchImpl, log: () => {} }));
    assert.deepEqual(seen, ['claude-haiku-5-5'], 'one review, on the cheapest model, never asked again or elsewhere');
  });
});
