/**
 * The spending default (operator decision, 20 Oct): PG1_DAILY_SPEND_CAP_USD
 * unset means $0, not "no cap".
 *
 *  - at $0 no paid AI call runs on its own: a paid chat call and a paid
 *    background call are refused (the free engines still run), and the lab
 *    starts nothing;
 *  - the one exception is a budget the operator confirmed for one /movie or
 *    /film stage: that job may spend up to the confirmed amount, and no
 *    more;
 *  - the per-provider daily caps (PG1_DAILY_CAP_ANTHROPIC_USD,
 *    PG1_DAILY_CAP_GEMINI_USD, PG1_DAILY_CAP_OPENROUTER_USD) are read
 *    against the shared ledger, which the GitHub Actions workers read too;
 *    background work stops at 25% of a cap.
 *
 * No network: stand-in fetches and ledgers.
 * Run with: node --test tests/spend-default.test.mjs
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetRouterState, planRoute, runRoute, TASKS, DATA, budgetAllows, spendCapAllows, dailySpendCapUsd, dailyBudgetUsd, recordUsage,
  withSpendAllowance, asBackgroundJob, grantSpendAllowance, spendContext, useProcessLedger, BACKGROUND_SHARE, PROVIDER_CAP_ENV
} from '../lib/aiRouter.mjs';
import { chainPlan } from '../lib/router/chains.mjs';
import { jobModel } from '../lib/a2aJobs/service.mjs';
import { runExperiment } from '../lib/lab/runner.mjs';
import { startLabExperiment } from '../lib/lab/chat.mjs';
import { labPaidOff } from '../lib/lab/policy.mjs';
import { startApprovalNeeded } from '../lib/film/director.mjs';
import { confirmedAllowanceUsd, spendConfirmation, signFilmToken } from '../lib/film/dispatch.mjs';
import { createFilmStore } from '../lib/film/store.mjs';
import { handleMovieApproval } from '../lib/movie/chat.mjs';
import { MOVIE_ACTIONS } from '../lib/movie/text.mjs';
import { parseScreenplay } from '../lib/movie/screenplay.mjs';
import { main as workerMain } from '../scripts/film-render.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch } from './helpers/filmDb.mjs';
import { SCREENPLAY } from './helpers/movieFixtures.mjs';

const KEYS = { ANTHROPIC_API_KEY: 'sk-ant-x0123456789', GEMINI_API_KEY_PAID: 'AQ.paid-0123456789', GEMINI_API_KEY_FREE: 'AIza-free-0123456789', OPENROUTER_API_KEY: 'sk-or-0123456789' };
const PAID = new Set(['anthropic', 'gemini_paid', 'openrouter', 'openai', 'gateway', 'replicate', 'elevenlabs']);
const spend = (provider, costUsd) => recordUsage({ provider, model: 'm', task: 'heavy', costUsd }, { log: () => {} });
const SUP = 'https://supabase.test';

beforeEach(() => { __resetRouterState(); });

describe('PG1_DAILY_SPEND_CAP_USD unset is $0', () => {
  test('unset, empty or unreadable is $0; a number is that number', () => {
    assert.equal(dailySpendCapUsd({}), 0);
    assert.equal(dailySpendCapUsd({ PG1_DAILY_SPEND_CAP_USD: '  ' }), 0);
    assert.equal(dailySpendCapUsd({ PG1_DAILY_SPEND_CAP_USD: 'lots' }), 0, 'fails closed');
    assert.equal(dailySpendCapUsd({ PG1_DAILY_SPEND_CAP_USD: '-3' }), 0);
    assert.equal(dailySpendCapUsd({ PG1_DAILY_SPEND_CAP_USD: '4.5' }), 4.5);
    for (const p of PAID) assert.equal(budgetAllows({}, p), false, `${p} is off at $0`);
    assert.equal(budgetAllows({}, 'gemini_free'), true, 'the free engines still run');
    assert.equal(budgetAllows({}, 'groq'), true);
  });

  test('a paid chat call is refused: customer chat has no engine, the operator\'s chat stays on the free engines', async () => {
    assert.deepEqual(planRoute(TASKS.HEAVY, { env: KEYS, dataClass: DATA.CUSTOMER }), [], 'customer data never goes to a free engine, and paid is off');
    const op = planRoute(TASKS.HEAVY, { env: KEYS, dataClass: DATA.OPERATOR });
    assert.ok(op.length > 0);
    assert.deepEqual([...new Set(op.map((c) => c.provider))], ['gemini_free'], 'free engines only');
    // runRoute on the customer plan: nothing is called.
    const tried = [];
    const out = await runRoute({ task: TASKS.HEAVY, env: KEYS, dataClass: DATA.CUSTOMER, plan: planRoute(TASKS.HEAVY, { env: KEYS, dataClass: DATA.CUSTOMER }), attempt: async (c) => { tried.push(c.provider); return { ok: true, text: 'x' }; }, log: () => {} });
    assert.equal(out.ok, false);
    assert.deepEqual(tried, []);
    // With a cap set, the same call is planned on the paid engines.
    assert.ok(planRoute(TASKS.HEAVY, { env: { ...KEYS, PG1_DAILY_SPEND_CAP_USD: '5' }, dataClass: DATA.CUSTOMER }).some((c) => c.provider === 'anthropic'));
  });

  test('a paid background call is refused: an A2A job write-up calls no engine, a background chain skips every paid step', async () => {
    const calls = [];
    const fetchImpl = async (u) => { calls.push(String(u)); return new Response(JSON.stringify({ content: [{ text: 'paid answer' }] }), { status: 200 }); };
    const m = jobModel({ env: KEYS, fetchImpl });
    assert.equal(await m.write({ system: 's', prompt: 'p' }), null);
    assert.deepEqual(calls, [], 'no paid call was made');
    assert.equal(m.spent(), 0);
    await asBackgroundJob(async () => {
      const plan = chainPlan('text', { env: KEYS, operator: true });
      assert.ok(plan.steps.every((s) => !PAID.has(s.provider)), JSON.stringify(plan.steps.map((s) => s.provider)));
      assert.ok(plan.skipped.some((s) => s.reason === 'budget'));
      assert.equal(budgetAllows(KEYS, 'gemini_paid'), false);
    });
  });

  test('the lab starts nothing and its runner calls no engine', async () => {
    assert.equal(labPaidOff({}), true);
    assert.equal(labPaidOff({ PG1_DAILY_SPEND_CAP_USD: '1' }), false);
    const calls = [];
    const r = await runExperiment({ id: '0d1a7e5f-9b2c-4c3d-8e4f-5a6b7c8d9e0f', kind: 'research', goal: 'x', env: { PG1_LAB_ANTHROPIC_API_KEY: 'k', PG1_LAB_GEMINI_API_KEY: 'g' }, budgetUsd: 1, fetchImpl: async (u) => { calls.push(String(u)); return new Response('{}'); } });
    assert.equal(r.status, 'failed');
    assert.match(r.error, /PG1_DAILY_SPEND_CAP_USD is \$0/);
    assert.equal(r.spent_usd, 0);
    assert.deepEqual(calls, []);
    const s = await startLabExperiment({ env: { PG1_AUTONOMY: 'on', PG1_LAB_DISPATCH_SECRET: 's' }, supUrl: SUP, supKey: 'k', fetchImpl: async (u) => { calls.push(String(u)); return new Response('[]', { status: 200 }); }, kind: 'research', goal: 'x' });
    assert.equal(s.ok, false);
    assert.match(s.reply, /Not started: paid AI is off/);
    assert.ok(!calls.some((u) => u.includes('api.github.com')), 'nothing dispatched');
  });

  test('Director Mode waits for Confirm at $0, even for the operator\'s own film', () => {
    assert.equal(startApprovalNeeded({}), true);
    assert.equal(startApprovalNeeded({ PG1_DAILY_SPEND_CAP_USD: '10' }), false);
  });
});

describe('a confirmed movie or film budget', () => {
  test('allows spending up to its amount and no more, for that job only', async () => {
    assert.equal(budgetAllows(KEYS, 'anthropic'), false);
    await withSpendAllowance({ job: 'movie-1', capUsd: 1 }, async () => {
      assert.ok(planRoute(TASKS.HEAVY, { env: KEYS, dataClass: DATA.CUSTOMER }).some((c) => c.provider === 'anthropic'), 'paid engines are planned');
      assert.equal(budgetAllows(KEYS, 'gemini_paid'), true);
      spend('gemini_paid', 0.6);
      await new Promise((r) => setTimeout(r, 1));
      assert.equal(budgetAllows(KEYS, 'gemini_paid'), true, '0.60 of 1.00');
      spend('replicate', 0.4);
      assert.equal(spendContext().allowance.spentUsd, 1);
      assert.equal(budgetAllows(KEYS, 'gemini_paid'), false, 'the confirmed 1.00 is spent: no more');
      assert.equal(budgetAllows(KEYS, 'anthropic'), false);
      assert.deepEqual(planRoute(TASKS.HEAVY, { env: KEYS, dataClass: DATA.CUSTOMER }), []);
      spend('gemini_free', 0);
      assert.equal(budgetAllows(KEYS, 'gemini_free'), true, 'the free engines are never cut');
    });
    // Another job, at the same time, has no allowance.
    assert.equal(budgetAllows(KEYS, 'anthropic'), false, 'outside the job: $0 again');
    await asBackgroundJob(async () => {
      assert.equal(budgetAllows(KEYS, 'anthropic'), false);
      assert.equal(grantSpendAllowance({ job: 'film-2', capUsd: 0.5 }), true);
      assert.equal(grantSpendAllowance({ job: 'film-2', capUsd: 50 }), false, 'once only');
      assert.equal(budgetAllows(KEYS, 'anthropic'), true);
      spend('anthropic', 0.5);
      assert.equal(budgetAllows(KEYS, 'anthropic'), false);
    });
    assert.equal(grantSpendAllowance({ job: 'x', capUsd: 5 }), false, 'never outside a background job (a chat request)');
    assert.equal(budgetAllows(KEYS, 'anthropic'), false);
  });

  test('a per-provider cap still holds inside a confirmed budget', async () => {
    const env = { ...KEYS, PG1_DAILY_CAP_GEMINI_USD: '0.5' };
    await withSpendAllowance({ capUsd: 10 }, async () => {
      spend('gemini_paid', 0.5);
      assert.equal(budgetAllows(env, 'gemini_paid'), false);
      assert.equal(budgetAllows(env, 'anthropic'), true);
    });
  });

  test('the movie\'s Confirm records the confirmed budget on its row; the worker turns it into the allowance', async () => {
    const db = await makeFilmDb();
    const fetchImpl = routedFetch([...filmDbRoutes(db), ['api.github.com', () => new Response(null, { status: 204 })]]);
    const store = createFilmStore({ supUrl: SUP, supKey: 'k', fetchImpl });
    const env = { PG1_VIDEO_RENDER_SECRET: 'movie-secret-0123456789abcdef', GITHUB_TOKEN: 'gh-token' };
    const p = await store.createProject({ request: 'x', capUsd: 60, status: 'awaiting_director_approval' });
    const sp = parseScreenplay(JSON.parse(JSON.stringify(SCREENPLAY)), { minutes: 0.5 });
    await store.updateProject(p.id, { mode: 'director', spent_usd: 0.15, director: { kind: 'movie', minutes: 0.5, screenplay: sp, approvals: { script: 'x' }, budgetUsd: 8 } });
    await store.createPendingAction({ actionType: MOVIE_ACTIONS.budget, plan: { projectId: p.id, estimateUsd: 5, capUsd: 8.15, maxRetakes: 1 }, diffSummary: 'x', token: 'tok-b' });
    const row = (await db.query('select * from pending_actions where token = $1', ['tok-b'])).rows[0];
    assert.equal(confirmedAllowanceUsd(await store.getProject(p.id), 'movie'), 0, 'nothing before Confirm');
    await handleMovieApproval({ row, decision: 'approve', env, supUrl: SUP, supKey: 'k', isOperator: true, fetchImpl });
    const q = await store.getProject(p.id);
    assert.equal(q.director.spend_confirmed.stage, 'movie');
    assert.equal(q.director.spend_confirmed.cap_usd, 8.15);
    assert.equal(confirmedAllowanceUsd(q, 'movie'), 8, 'the confirmed 8.00, less nothing spent since');
    assert.equal(confirmedAllowanceUsd({ ...q, spent_usd: 7.15 }), 0, 'another stage: none');
    assert.equal(confirmedAllowanceUsd({ ...q, spent_usd: 7.15 }, 'movie'), 1);
    assert.equal(confirmedAllowanceUsd({ ...q, cap_usd: 4 }, 'movie'), 3.85, 'never above the film\'s own cap');
    assert.deepEqual(Object.keys(spendConfirmation('preview', 2)).sort(), ['at', 'cap_usd', 'stage']);
  });

  test('the render worker: a confirmed stage may spend up to what is left of its budget; an unconfirmed one stays free', async () => {
    const db = await makeFilmDb();
    const fetchImpl = routedFetch(filmDbRoutes(db));
    const store = createFilmStore({ supUrl: SUP, supKey: 'k', fetchImpl });
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    process.env.SUPABASE_URL = SUP;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    try {
      const seen = [];
      // Stand-in engines: the first model call reads the budget and stops
      // the stage (nothing else is needed to see the scope).
      const engines = { think: async () => { seen.push({ paid: budgetAllows(KEYS, 'anthropic'), allowance: spendContext() && spendContext().allowance }); throw Object.assign(new Error('stop here'), { kind: 'not_configured' }); } };
      const run = async (director) => {
        const p = await store.createProject({ request: 'A cafe at dawn, 10 seconds', capUsd: 20, status: 'storyboard_queued' });
        await store.updateProject(p.id, { spent_usd: 1, ...(director ? { director } : {}) });
        const env = { ...KEYS, PG1_VIDEO_RENDER_SECRET: 'film-secret-0123456789abcdef', FILM_PROJECT_ID: p.id, FILM_STAGE: 'storyboard' };
        env.FILM_TOKEN = signFilmToken(p.id, env);
        const logs = [];
        await workerMain(env, { engines, fetchImpl, log: (l) => logs.push(l) });
        return logs;
      };
      const free = await run(null);
      assert.equal(seen[0].paid, false, 'a new storyboard (no Confirm) stays on the free engines');
      assert.equal(seen[0].allowance, null);
      assert.ok(free.some((l) => /no confirmed budget: free engines only/.test(l)), free.join('\n'));
      const paid = await run({ spend_confirmed: spendConfirmation('storyboard', 3) });
      assert.equal(seen[1].paid, true, 'a confirmed stage may spend');
      assert.equal(seen[1].allowance.capUsd, 2, 'the confirmed 3.00 less the 1.00 already spent');
      assert.ok(paid.some((l) => /confirmed budget, up to 2 USD of paid AI/.test(l)), paid.join('\n'));
      await run({ spend_confirmed: spendConfirmation('preview', 3) });
      assert.equal(seen[2].paid, false, 'a confirmation for another stage does not count');
      assert.equal(budgetAllows(KEYS, 'anthropic'), false, 'the worker\'s allowance ends with its job');
    } finally {
      process.env.SUPABASE_URL = saved.url;
      process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
      if (saved.url === undefined) delete process.env.SUPABASE_URL;
      if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
  });
});

describe('per-provider daily caps', () => {
  const env = { ...KEYS, PG1_DAILY_SPEND_CAP_USD: '100' };

  test('PG1_DAILY_CAP_ANTHROPIC_USD, PG1_DAILY_CAP_GEMINI_USD, PG1_DAILY_CAP_OPENROUTER_USD', () => {
    assert.deepEqual(PROVIDER_CAP_ENV, { anthropic: 'PG1_DAILY_CAP_ANTHROPIC_USD', gemini_paid: 'PG1_DAILY_CAP_GEMINI_USD', openrouter: 'PG1_DAILY_CAP_OPENROUTER_USD' });
    const capped = { ...env, PG1_DAILY_CAP_ANTHROPIC_USD: '1', PG1_DAILY_CAP_GEMINI_USD: '2', PG1_DAILY_CAP_OPENROUTER_USD: '0.5' };
    assert.equal(dailyBudgetUsd(capped, 'anthropic'), 1);
    assert.equal(dailyBudgetUsd(capped, 'gemini_paid'), 2);
    assert.equal(dailyBudgetUsd(capped, 'openrouter'), 0.5);
    assert.equal(dailyBudgetUsd(capped, 'replicate'), Infinity, 'no per-provider cap: the all-paid cap applies');
    assert.equal(dailyBudgetUsd({ PG1_DAILY_CAP_ANTHROPIC_USD: 'x' }, 'anthropic'), 0, 'unreadable fails closed');
    assert.equal(dailyBudgetUsd({ PG1_DAILY_CAP_ANTHROPIC_USD: '3', PG1_DAILY_BUDGET_ANTHROPIC_USD: '2' }, 'anthropic'), 2, 'the lower of the two names');
    spend('anthropic', 0.9);
    assert.equal(budgetAllows(capped, 'anthropic'), true);
    spend('anthropic', 0.1);
    assert.equal(budgetAllows(capped, 'anthropic'), false, 'at the cap');
    assert.equal(budgetAllows(capped, 'gemini_paid'), true, 'each provider on its own');
    spend('gemini_paid', 2);
    assert.equal(budgetAllows(capped, 'gemini_paid'), false);
    assert.ok(!planRoute(TASKS.HEAVY, { env: capped, dataClass: DATA.CUSTOMER }).length, 'both commercial engines at their caps');
  });

  test('background work stops at 25% of each cap (and of the all-paid cap)', async () => {
    assert.equal(BACKGROUND_SHARE, 0.25);
    const capped = { ...env, PG1_DAILY_CAP_GEMINI_USD: '4' };
    spend('gemini_paid', 0.9);
    await asBackgroundJob(async () => assert.equal(budgetAllows(capped, 'gemini_paid'), true, '0.90 of a 1.00 share'));
    assert.equal(budgetAllows(capped, 'gemini_paid', { background: true }), true);
    spend('gemini_paid', 0.1);
    await asBackgroundJob(async () => assert.equal(budgetAllows(capped, 'gemini_paid'), false, 'the background share is used'));
    assert.equal(budgetAllows(capped, 'gemini_paid', { background: true }), false);
    assert.equal(budgetAllows(capped, 'gemini_paid'), true, 'chat still has the rest of the cap');
    assert.ok(planRoute(TASKS.HEAVY, { env: capped, dataClass: DATA.CUSTOMER }).some((c) => c.provider === 'gemini_paid'));
    assert.ok(!planRoute(TASKS.HEAVY, { env: capped, dataClass: DATA.CUSTOMER, background: true }).some((c) => c.provider === 'gemini_paid'));
    // The all-paid cap: 25% of it for background work.
    __resetRouterState();
    const small = { ...KEYS, PG1_DAILY_SPEND_CAP_USD: '4' };
    spend('anthropic', 1);
    assert.equal(spendCapAllows(small), true);
    assert.equal(spendCapAllows(small, { background: true }), false);
    await asBackgroundJob(async () => assert.equal(budgetAllows(small, 'anthropic'), false));
  });

  test('the shared ledger: a GitHub Actions worker counts what Vercel spent today', () => {
    const capped = { ...env, PG1_DAILY_CAP_ANTHROPIC_USD: '1' };
    // The other instance (Vercel) spent 1.00 on Claude today; this
    // process has spent nothing.
    const ledger = { spent: (day, provider) => (provider === 'anthropic' ? 1 : 0), record() {} };
    assert.equal(budgetAllows(capped, 'anthropic'), true, 'this process alone has spent nothing');
    assert.equal(budgetAllows(capped, 'anthropic', { ledger }), false, 'with the ledger passed');
    useProcessLedger(ledger);
    assert.equal(budgetAllows(capped, 'anthropic'), false, 'the worker\'s every check reads it (scripts/film-render.mjs, music-render.mjs)');
    useProcessLedger(null);
  });
});
