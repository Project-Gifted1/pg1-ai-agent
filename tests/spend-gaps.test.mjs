/**
 * Four gaps in the $0 spending default (follow-up to #356): with
 * PG1_DAILY_SPEND_CAP_USD unset ($0) nothing paid runs unless it is inside
 * a confirmed, job-scoped budget.
 *  1. The Living lab runs on the free engines at $0 and records $0; a step
 *     only a paid engine can do (web search) is skipped with a plain reason,
 *     never a failed run.
 *  2. A paid A2A job gets an allowance of price / 1.5 from its own payment,
 *     on commercial_ok engines only; a job that cannot be done within it is
 *     refused BEFORE the payment is settled; the allowance never leaks to
 *     chat or another job.
 *  3. /image, /video and /music show their worst-case cost with Confirm /
 *     Cancel (and --budget); nothing spends before Confirm; Confirm grants
 *     an allowance of the confirmed amount.
 *  4. Speech (Cartesia) is counted and held to the cap like every paid
 *     engine.
 *
 * Every test sets its own PG1_DAILY_SPEND_CAP_USD (the suite's preload sets
 * 1000 for the other files). No network.
 *
 * Run with: node --test tests/spend-gaps.test.mjs
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetRouterState, budgetAllows, planRoute, TASKS, DATA, withSpendAllowance, spendContext, allowanceRemainingUsd, recordUsage, paidSpentToday, SPEND_CAP_ENV
} from '../lib/aiRouter.mjs';
import { runExperiment } from '../lib/lab/runner.mjs';
import { startLabExperiment } from '../lib/lab/chat.mjs';
import { LAB_SEARCH_SKIPPED, createLabFetch } from '../lib/lab/policy.mjs';
import { paidJobAllowanceUsd, paidJobRunnable, runWithJobAllowance, jobModel, JOB_ALLOWANCE_DIVISOR } from '../lib/a2aJobs/service.mjs';
import { submitJob, payJob } from '../lib/a2aJobs/jobs.mjs';
import { JOB_TYPES } from '../lib/a2aJobs/catalogue.mjs';
import { parseBudgetFlag, MEDIA_BUDGET_ACTION, confirmedMediaAllowanceUsd, mediaSpendConfirmation } from '../lib/mediaBudget.mjs';
import { makeLabWorld } from './helpers/labWorld.mjs';
import { pgRest } from './helpers/pgrest.mjs';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP = 'https://supabase.test';
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const PAID_HOSTS = /api\.anthropic\.com|generativelanguage\.googleapis\.com\/v1beta\/models\/(?!gemini-free)|api\.replicate\.com|api\.cartesia\.ai|api\.elevenlabs\.io|openrouter\.ai/;
let ip = 0;

beforeEach(() => {
  __resetRouterState();
  __clearAuthRateLimitState();
  for (const k of Object.keys(process.env)) if (/^(GEMINI_|ANTHROPIC|GROQ|MISTRAL|OPENAI|OPENROUTER|REPLICATE|CARTESIA|ELEVENLABS|PG1_|GITHUB_MODELS|CLOUDFLARE_)/.test(k)) delete process.env[k];
  delete process.env[SPEND_CAP_ENV];
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; __resetRouterState(); });

const groqReply = (text) => Response.json({ choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 50, completion_tokens: 200 } });

// --- 1. the lab at $0 -------------------------------------------------------------------

describe('the Living lab at $0', () => {
  test('a research run at $0 runs on the free engines only, records $0, and skips web search with a plain reason', async () => {
    const calls = [];
    const findings = '## Findings\nNVD publishes CVE records under a public-domain notice; resale terms cite the NVD terms page.\n## Sources and licences\nresale terms not found\n## Open questions\nnone';
    const fetchImpl = async (u, o = {}) => {
      calls.push(String(u));
      if (String(u).startsWith('https://api.groq.com/')) return groqReply(findings);
      return new Response('{}', { status: 500 });
    };
    // The lab's own keys are paid; GROQ_API_KEY is a free engine.
    const env = { PG1_LAB_ANTHROPIC_API_KEY: 'paid-a', PG1_LAB_GEMINI_API_KEY: 'paid-g', GROQ_API_KEY: 'free-groq' };
    const r = await runExperiment({ id: '0d1a7e5f-9b2c-4c3d-8e4f-5a6b7c8d9e0f', kind: 'research', goal: 'Which CVE feeds can PG1 resell?', env, budgetUsd: 2, fetchImpl });
    assert.equal(r.status, 'done', r.error);
    assert.equal(r.spent_usd, 0, 'free engines cost nothing');
    assert.ok(r.calls >= 1);
    assert.equal(r.engines, 'free');
    assert.ok(calls.some((u) => u.startsWith('https://api.groq.com/')), 'a free engine answered');
    assert.ok(!calls.some((u) => PAID_HOSTS.test(u)), `no paid engine was called: ${calls.join(', ')}`);
    assert.deepEqual(r.skipped.map((s) => s.step), ['web search'], 'the paid-only step is skipped, not failed');
    assert.equal(r.skipped[0].reason, LAB_SEARCH_SKIPPED);
    assert.match(r.report_markdown, /_Skipped: web search \(web search needs a paid engine/);
  });

  test('a paid step at $0 is skipped, the rest of a code run goes on; the lab fetch may POST to the free engines only at $0', async () => {
    const fetchImpl = async (u) => {
      if (String(u).startsWith('https://api.groq.com/')) return groqReply(calls++ === 0 ? '## Findings\nThe change needs a size check before the batch loop and a test for the limit, nothing else touches it.\n## Sources\nnone' : JSON.stringify({ summary: 'size check', files: [{ path: 'lib/sizeCheck.mjs', content: 'export const MAX = 10;\n' }], tests: 'a unit test' }));
      return new Response('{}', { status: 500 });
    };
    let calls = 0;
    const r = await runExperiment({ id: '1d1a7e5f-9b2c-4c3d-8e4f-5a6b7c8d9e0f', kind: 'code', goal: 'add a batch size check', env: { PG1_LAB_GEMINI_API_KEY: 'paid-g', GROQ_API_KEY: 'free-groq' }, budgetUsd: 2, fetchImpl });
    assert.equal(r.status, 'done', r.error);
    assert.equal(r.spent_usd, 0);
    assert.equal(r.stages.build.ok, true);
    assert.equal(r.skipped[0].step, 'web search');
    const free = createLabFetch({ fetchImpl: async () => new Response('ok'), allowFree: true });
    assert.equal((await free('https://api.groq.com/openai/v1/chat/completions', { method: 'POST' })).status, 200);
    const paidOnly = createLabFetch({ fetchImpl: async () => new Response('ok') });
    await assert.rejects(() => paidOnly('https://api.groq.com/openai/v1/chat/completions', { method: 'POST' }), /may not POST/);
  });

  test('/lab start at $0 is queued (free engines), not refused with "paid AI is off"', async () => {
    const { gh, fetchImpl } = await makeLabWorld(['20261019120000_pg1_skills.sql', '20261020120000_pg1_lab_and_flags.sql']);
    const s = await startLabExperiment({ env: { PG1_AUTONOMY: 'on', PG1_LAB_DISPATCH_SECRET: 's'.repeat(32), GITHUB_TOKEN: 'gh-test-token' }, supUrl: SUP, supKey: 'k', fetchImpl, kind: 'research', goal: 'which feeds can PG1 resell' });
    assert.equal(s.ok, true, s.reply);
    assert.equal(s.free, true);
    assert.match(s.reply, /queued \(research\) on the free engines only/);
    assert.match(s.reply, /spends \$0/);
    assert.doesNotMatch(s.reply, /paid AI is off/);
    assert.equal(gh.dispatches.length, 1);
  });
});

// --- 2. paid A2A jobs ----------------------------------------------------------------------

describe('paid A2A jobs: an allowance from their own payment', () => {
  const KEYS = { ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY_PAID: 'paid-gemini', GROQ_API_KEY: 'free-groq' };
  const writeup = (n = 3) => ({ id: 'a1b2c3d4-0000-4000-8000-000000000001', job_type: 'threat_writeup_pdf', price_usd: JOB_TYPES.threat_writeup_pdf.priceUsd(n), payment: 'x402' });

  test('the allowance is price / 1.5; a paid job spends up to it and no more, on commercial engines only', async () => {
    const job = writeup();
    assert.equal(JOB_ALLOWANCE_DIVISOR, 1.5);
    assert.ok(Math.abs(paidJobAllowanceUsd(job) - job.price_usd / 1.5) < 1e-6);
    const calls = [];
    const fetchImpl = async (u) => {
      calls.push(String(u));
      if (String(u).startsWith('https://api.anthropic.com/')) return Response.json({ content: [{ type: 'text', text: '## Summary\nok' }], usage: { input_tokens: 4000, output_tokens: 1500 } });
      return new Response('{}', { status: 500 });
    };
    let seen = null;
    const text = await runWithJobAllowance(job, async () => {
      seen = { ...spendContext().allowance };
      const m = jobModel({ env: KEYS, fetchImpl });
      const out = await m.write({ system: 's', prompt: 'p'.repeat(2000) });
      const left = allowanceRemainingUsd();
      assert.ok(left >= 0 && left < paidJobAllowanceUsd(job), 'the call was counted against the allowance');
      assert.ok(m.spent() <= paidJobAllowanceUsd(job));
      return out;
    });
    assert.match(text, /Summary/);
    assert.equal(seen.capUsd, paidJobAllowanceUsd(job));
    assert.ok(!calls.some((u) => /api\.groq\.com|openrouter|models\.github/.test(u)), 'customer data never goes to a free engine');
    // A second call whose worst case would go over what is left is not made.
    const tiny = { ...job, price_usd: 0.003 };
    const calls2 = [];
    const out2 = await runWithJobAllowance(tiny, () => jobModel({ env: KEYS, fetchImpl: async (u) => { calls2.push(u); return new Response('{}'); } }).write({ system: 's', prompt: 'p'.repeat(40000) }));
    assert.equal(out2, null);
    assert.deepEqual(calls2, [], 'no call whose worst case is over the allowance');
  });

  test('the allowance never leaks: outside the run there is none; two jobs have their own', async () => {
    assert.equal(spendContext(), null);
    assert.equal(budgetAllows({}, 'anthropic'), false, 'chat at $0: no paid engine');
    const a = writeup(1);
    const b = { ...writeup(20), id: 'b1b2c3d4-0000-4000-8000-000000000002' };
    const caps = await Promise.all([a, b].map((j) => runWithJobAllowance(j, async () => { await new Promise((r) => setTimeout(r, 5)); return spendContext().allowance.capUsd; })));
    assert.deepEqual(caps, [paidJobAllowanceUsd(a), paidJobAllowanceUsd(b)]);
    assert.equal(spendContext(), null, 'nothing left behind for chat');
    assert.equal(budgetAllows({}, 'anthropic'), false);
    // A free-tier job keeps the current behaviour: no allowance.
    assert.equal(await runWithJobAllowance({ ...a, payment: 'free_tier' }, () => spendContext()), null);
  });

  test('a job with no commercial engine available is refused before it is quoted or charged', async () => {
    const job = writeup();
    assert.equal(paidJobRunnable(job, { env: KEYS }).ok, true);
    const none = paidJobRunnable(job, { env: { GROQ_API_KEY: 'free-groq' } });
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'no_engine');
    // Through the lifecycle: refused at payment, settle never called.
    const rows = new Map([[job.id, { ...job, status: 'quoted', payment: null, quote_expires_at: new Date(Date.now() + 600000).toISOString(), items: 3 }]]);
    let settled = 0;
    let credited = 0;
    const store = {
      get: async (id) => rows.get(id), update: async (id, patch) => { const r = { ...rows.get(id), ...patch }; rows.set(id, r); return [r]; },
      acceptedForPayerSince: async () => 0, activeForPayer: async () => 0, useCredit: async () => { credited++; return false; },
      activeCount: async () => 0, health: async () => ({ ok: true })
    };
    const deps = {
      store, env: { PG1_AUTONOMY: 'on' },
      gate: async () => ({ authorized: true, payer: '0x' + '1'.repeat(40), settle: async () => { settled++; return { success: true }; } }),
      runnable: async (j) => paidJobRunnable(j, { env: { GROQ_API_KEY: 'free-groq' } }),
      startRun: () => { throw new Error('must not run'); }
    };
    await assert.rejects(() => payJob({ jobId: job.id, deps }), (e) => e.jobRefusal && e.data.reason === 'no_engine' && e.data.charged === false && /No payment was taken/.test(e.message));
    assert.equal(settled, 0, 'never settled');
    assert.equal(credited, 0, 'no credit used');
    // And at submit: no quote is made at all.
    const created = [];
    await assert.rejects(() => submitJob({ jobType: 'threat_writeup_pdf', input: { subjects: [{ type: 'domain', value: 'example.com' }] }, deps: { ...deps, store: { ...store, create: async (r) => { created.push(r); return r; } } } }), (e) => e.jobRefusal && e.data.reason === 'no_engine');
    assert.deepEqual(created, [], 'no quote recorded');
  });
});

// --- 3. confirm a budget for /image, /video and /music ---------------------------------------

function makeRes() {
  return {
    statusCode: null, headers: {}, jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write() { return true; }, end() { return this; }, on() {}
  };
}
async function chat(body) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.85.0.${++ip % 250}` }, body: { ...OPERATOR, ...body } }, res);
  return res;
}

async function mediaWorld({ engine } = {}) {
  const { db } = await makeLabWorld(['20261014120000_pg1_music.sql']);
  const log = { engine: [], dispatches: [], allowances: [] };
  globalThis.fetch = pgRest(db, {
    passthrough: async (u, o = {}) => {
      if (u.startsWith('https://api.github.com/')) { log.dispatches.push({ url: u, body: JSON.parse(o.body || '{}') }); return new Response(null, { status: 204 }); }
      if (u.includes('/storage/v1/')) return Response.json({ Key: 'x' });
      if (PAID_HOSTS.test(u) || u.includes('generativelanguage')) {
        log.engine.push(u);
        const ctx = spendContext();
        log.allowances.push(ctx && ctx.allowance ? { ...ctx.allowance } : null);
        return engine ? engine(u, o) : new Response('{"error":{"message":"unavailable"}}', { status: 503 });
      }
      return null;
    }
  });
  return { db, log };
}
const pending = async (db) => (await db.query('select token, action_type, plan, status from public.pending_actions order by created_at')).rows;

describe('confirm a budget: /image, /video, /music', () => {
  beforeEach(() => {
    process.env.USER_API_KEY = OPERATOR.user;
    process.env.USER_API_PASS = OPERATOR.pass;
    process.env.SUPABASE_URL = SUP;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-media-test';
    process.env.GEMINI_API_KEY_PAID = 'paid-gemini-media';
    process.env.REPLICATE_API_TOKEN = 'r8_test';
    process.env.PG1_VIDEO_RENDER_SECRET = 'v'.repeat(40);
    process.env.GITHUB_TOKEN = 'gh-test-token';
  });

  test('--budget is parsed, a bad one is an error', () => {
    assert.deepEqual(parseBudgetFlag('a red fox --budget 0.50 at dusk'), { text: 'a red fox at dusk', budgetUsd: 0.5 });
    assert.deepEqual(parseBudgetFlag('a fox'), { text: 'a fox', budgetUsd: null });
    assert.match(parseBudgetFlag('a fox --budget lots').error, /above 0/);
    assert.equal(confirmedMediaAllowanceUsd(mediaSpendConfirmation(2), 0.5), 1.5);
    assert.equal(confirmedMediaAllowanceUsd(null, 0), 0);
  });

  test('/image: the worst case with Confirm / Cancel, nothing spent; Cancel spends nothing; Confirm runs inside the confirmed allowance', async () => {
    const { db, log } = await mediaWorld();
    const res = await chat({ prompt: '/image a lighthouse in a storm --budget 0.10' });
    assert.match(res.jsonBody.reply, /PG1 Vision: confirm the budget for this image\. Nothing is spent before you do\./);
    assert.match(res.jsonBody.reply, /Worst-case cost: 0\.05 USD/);
    assert.match(res.jsonBody.reply, /Hard cap: 0\.10 USD \(your --budget\)/);
    assert.deepEqual(res.jsonBody.pendingApproval.labels, { approve: 'Confirm', decline: 'Cancel' });
    assert.deepEqual(log.engine, [], 'nothing spent before Confirm');
    const [row] = await pending(db);
    assert.equal(row.action_type, MEDIA_BUDGET_ACTION);
    assert.equal(row.plan.kind, 'image');
    assert.equal(row.plan.capUsd, 0.1);
    // Cancel.
    const cancel = await chat({ prompt: `/decline ${row.token}` });
    assert.match(cancel.jsonBody.reply, /cancelled\. Nothing was started and nothing was spent/);
    assert.deepEqual(log.engine, []);
    // A new one, confirmed: the engine is called inside a 0.05 USD allowance.
    await chat({ prompt: '/image a lighthouse in a storm' });
    const fresh = (await pending(db)).find((r) => r.status === 'pending');
    const done = await chat({ prompt: `/approve ${fresh.token}` });
    assert.ok(log.engine.length >= 1, 'the image engine ran after Confirm');
    assert.ok(log.allowances.every((a) => a && a.capUsd === 0.05), JSON.stringify(log.allowances));
    assert.ok(['FAILED', 'SUCCESS'].includes(done.jsonBody.imageStatus));
    assert.equal(spendContext(), null, 'the allowance ended with the job');
    // Confirming twice runs nothing more.
    const again = await chat({ prompt: `/approve ${fresh.token}` });
    assert.match(again.jsonBody.reply, /already 'approved'/);
  });

  test('/video: a proposal with the worst case; nothing reserved before Confirm; the model\'s video tool never starts a clip', async () => {
    process.env.PG1_VIDEO_ENABLED = '1';
    const { db, log } = await mediaWorld();
    const res = await chat({ prompt: '/video a drone shot over a harbour' });
    assert.match(res.jsonBody.reply, /PG1 Motion: confirm the budget for this clip/);
    assert.match(res.jsonBody.reply, /Worst-case cost: \d+\.\d\d USD/);
    assert.deepEqual(res.jsonBody.pendingApproval.labels, { approve: 'Confirm', decline: 'Cancel' });
    assert.equal((await db.query('select count(*)::int as n from public.pg1_video_jobs').catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n, 0, 'no clip reserved');
    assert.deepEqual(log.engine, []);
    const { createToolExecutor } = await import('../lib/chatTools.mjs');
    const exec = createToolExecutor({ role: 'operator', startVideo: () => ({ ok: false, code: 'needs_confirm' }), log: () => {} });
    const out = await exec({ id: 'v', name: 'generate_video', args: { prompt: 'a harbour' } });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'needs_confirm');
    assert.match(out.message, /only after the operator confirms its budget/);
  });

  test('/music: the track\'s worst case waits for Confirm; Confirm stores the track with its confirmed cap and spend confirmation and starts the previews', async () => {
    const { db, log } = await mediaWorld();
    const res = await chat({ prompt: '/music dusty boom-bap beat, vinyl crackle --instrumental --budget 1.50' });
    assert.match(res.jsonBody.reply, /PG1 Sound: confirm the budget for this track/);
    assert.match(res.jsonBody.reply, /Hard cap: 1\.50 USD \(your --budget\)/);
    assert.equal((await db.query('select count(*)::int as n from public.pg1_music_tracks')).rows[0].n, 0, 'no track before Confirm');
    assert.equal(log.dispatches.length, 0, 'nothing dispatched before Confirm');
    const [row] = await pending(db);
    const done = await chat({ prompt: `/approve ${row.token}` });
    assert.match(done.jsonBody.reply, /Confirmed budget for this track: 1\.50 USD/);
    const t = (await db.query('select cap_usd, options from public.pg1_music_tracks')).rows[0];
    assert.equal(Number(t.cap_usd), 1.5);
    assert.equal(t.options.spend_confirmed.cap_usd, 1.5);
    assert.equal(t.options.instrumental, true);
    assert.equal(log.dispatches.length, 1, 'the previews were dispatched');
    assert.equal(confirmedMediaAllowanceUsd(t.options.spend_confirmed, 0), 1.5, 'the worker grants this allowance');
  });
});

// --- 4. speech under the cap ----------------------------------------------------------------

describe('Cartesia speech is counted and held to the cap', () => {
  test('at $0 it is off; inside a confirmed budget it runs; its spend counts', async () => {
    const env = { CARTESIA_API_KEY: 'cartesia-test' };
    assert.equal(budgetAllows(env, 'cartesia'), false, 'fail closed at $0');
    assert.ok(!planRoute(TASKS.TTS, { env, dataClass: DATA.OPERATOR }).some((c) => c.provider === 'cartesia'), 'not planned at $0');
    assert.equal(withSpendAllowance({ job: 'film', capUsd: 1 }, () => budgetAllows(env, 'cartesia')), true, 'inside a confirmed budget');
    assert.equal(budgetAllows({ ...env, [SPEND_CAP_ENV]: '5' }, 'cartesia'), true, 'with a cap set by the operator');
    const before = paidSpentToday();
    recordUsage({ provider: 'cartesia', model: 'sonic', task: TASKS.TTS, dataClass: 'operator', chars: 20000 }, { env: { ...env, [SPEND_CAP_ENV]: '5' }, log: () => {} });
    assert.ok(paidSpentToday() > before, 'counted in the paid spend');
  });
});
