/**
 * Free chain, routing policy and the threat feed in chat (request sjv9vnbs,
 * 17 Oct: anthropic 400 -> gemini_paid 402 -> gemini_free 429 with no wait
 * -> groq 404/413 -> github_models 200 with no text -> cloudflare ok).
 *
 *   1  Gemini's 429 says "check your plan and billing details" even for a
 *      per-minute limit: no longer read as billing; per-minute waits when
 *      the wait fits, a daily quota falls through at once
 *   2  free engines' models come from their own lists (cached a day), from
 *      a preference list, never one hard-coded id; a 404 drops a model
 *   3  a free engine's failure is logged with the provider's own message
 *   4  per-engine input limits; the request is trimmed to fit (oldest
 *      memory, then tool output) or the engine is skipped
 *   5  text: free engines first, paid only after; the daily spend cap
 *   6  client work: commercial_ok engines only, never free; none -> stop
 *   7  paid credit left per account and text vs media spend
 *   8  a film checks its media engines' credit before it starts
 *   9  the chat's threat read applies the /api/ioc source policy; locked
 *      sources only for the operator, labelled
 *  10  today's feed by Ireland date, counts by source, none -> latest
 *  11  placeholder indicators are left out
 *  12  a default confidence on every row is not presented
 *
 * Run with: node --test tests/free-chain-policy.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  TASKS, DATA, planRoute, isBillingFailure, isThrottle, geminiQuotaInfo, quotaScope, withThrottleRetry, tripBreaker, isTripped,
  nextDailyResetMs, callOpenAiCompat, recordUsage, spendCapAllows, budgetAllows, freeFirst, routeModels, __resetRouterState, memoryLedger, utcDay
} from '../lib/aiRouter.mjs';
import { ENGINE_MAX_INPUT_TOKENS } from '../lib/capabilities/registry.mjs';
import {
  refreshCatalog, catalogModels, catalogModelIds, markModelGone, orderForFit, bestListed, selectedModels, modelInputLimit, PARSERS, __resetModelCatalog, MODEL_PREFERENCES
} from '../lib/router/modelCatalog.mjs';
import { fitRequest, tokensOf } from '../lib/router/fit.mjs';
import { filmTextPlan, isWritingPurpose, filmThink } from '../lib/film/providers.mjs';
import { filmMediaCredit, mediaCreditText } from '../lib/film/mediaCredit.mjs';
import { creditReport, creditRows, creditSection, kindOf, spendByKind } from '../lib/creditReport.mjs';
import { STATES } from '../lib/keysStatus.mjs';
import {
  loadChatThreatFeed, isPlaceholderIndicator, PLACEHOLDER_PATTERNS, irelandDay, irelandDayStart, confidenceIsReal, isThreatFeedQuestion, asksForToday
} from '../lib/chatThreatFeed.mjs';
import { UPSTREAM_BRAND_RE } from '../lib/upstreamFailure.mjs';

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => { __resetRouterState(); __resetModelCatalog(); });
after(() => { process.env = { ...ORIGINAL_ENV }; });

// Google's real 429 bodies (shape as the API sends them).
const gemini429 = ({ quotaId = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', retry = '3s' } = {}) => JSON.stringify({
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10\nPlease retry in 3.2s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId, quotaValue: '10' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: retry }
    ]
  }
});

// --- 1. the free key's 429 -------------------------------------------------------

test('1: Google\'s "check your plan and billing details" on a 429 is not a billing failure; a prepaid key that ran out still is', () => {
  const minute = gemini429();
  assert.equal(isBillingFailure(429, minute), false, 'the root cause of sjv9vnbs: every Google 429 carries that sentence');
  assert.equal(isThrottle(429, minute), true);
  assert.equal(isBillingFailure(429, JSON.stringify({ error: { code: 429, message: 'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.' } })), true);
  assert.equal(isBillingFailure(429, 'insufficient_quota: You exceeded your current quota, please check your plan and billing details.'), true, 'OpenAI out of credit still is');
});

test('1: the quota scope and the wait come from the body\'s details (per minute vs per day)', () => {
  assert.deepEqual(geminiQuotaInfo(gemini429()), { scope: 'minute', retryAfterMs: 3000 });
  const day = geminiQuotaInfo(gemini429({ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', retry: '41s' }));
  assert.deepEqual(day, { scope: 'day', retryAfterMs: 41000 });
  assert.equal(isThrottle(429, 'x', 'day'), false);
  assert.equal(isThrottle(429, 'x', 'minute'), true);
  assert.equal(quotaScope('Rate limit reached on tokens per minute (TPM): Limit 8000'), 'minute');
  assert.equal(quotaScope('requests per day (RPD)'), 'day');
});

test('1: per minute and the wait fits: waited, then the same engine answers; daily: falls through at once; a wait over the budget falls through', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let n = 0;
  const minute = await withThrottleRetry(async () => (++n === 1 ? { ok: false, status: 429, detail: 'quota (per minute)', quotaScope: 'minute', retryAfterMs: 3000 } : { ok: true, text: 'hi' }), { sleep });
  assert.equal(minute.result.text, 'hi');
  assert.deepEqual(waits, [3000]);
  waits.length = 0; n = 0;
  const daily = await withThrottleRetry(async () => { n++; return { ok: false, status: 429, detail: 'quota', quotaScope: 'day', retryAfterMs: 3000 }; }, { sleep });
  assert.equal(n, 1, 'a daily quota is not sent again');
  assert.deepEqual(waits, []);
  n = 0;
  const long = await withThrottleRetry(async () => { n++; return { ok: false, status: 429, detail: 'quota', quotaScope: 'minute', retryAfterMs: 41000 }; }, { sleep });
  assert.equal(n, 1, 'a 41 s wait does not fit chat\'s 20 s: the next engine');
  assert.equal(long.waitedMs, 0);
});

test('1: the breaker: a per-minute 429 for its own wait, a daily quota until the daily reset', () => {
  const t = Date.UTC(2026, 9, 17, 17, 22);
  tripBreaker('gemini_free#1', 429, gemini429(), t, { scope: 'minute', retryAfterMs: 3000 });
  assert.equal(isTripped('gemini_free#1', t + 59000), true);
  assert.equal(isTripped('gemini_free#1', t + 61000), false, 'not 15 minutes as a billing failure');
  tripBreaker('gemini_free#2', 429, 'x', t, { scope: 'day' });
  assert.equal(isTripped('gemini_free#2', t + 3 * 3600000), true);
  assert.ok(nextDailyResetMs(t) > t && nextDailyResetMs(t) <= t + 86400000);
});

// --- 2. free engines' models ---------------------------------------------------------

const GROQ_LIST = { data: [
  { id: 'openai/gpt-oss-120b', active: true, context_window: 131072 },
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct', active: true, context_window: 131072 },
  { id: 'llama-3.3-70b-versatile', active: true, context_window: 131072 },
  { id: 'whisper-large-v3', active: true },
  { id: 'llama-3.1-8b-instant', active: true, context_window: 131072 }
] };

test('2: the engine\'s list narrows the preference list; a retired id is never used; 404 drops a model until the next read', async () => {
  const calls = [];
  const fetchImpl = async (url, o) => { calls.push({ url, auth: o.headers.Authorization }); return new Response(JSON.stringify(GROQ_LIST), { status: 200 }); };
  await refreshCatalog('groq', { key: 'gsk_x', fetchImpl });
  await refreshCatalog('groq', { key: 'gsk_x', fetchImpl });
  assert.equal(calls.length, 1, 'cached for the day');
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/models');
  const ids = catalogModelIds('groq', 'heavy');
  assert.ok(!ids.includes('qwen/qwen3-32b'), 'the retired model of sjv9vnbs is gone');
  assert.deepEqual(ids, ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.1-8b-instant']);
  assert.deepEqual(routeModels({}, TASKS.HEAVY, 'groq'), ids, 'the router uses it');
  assert.deepEqual(routeModels({ PG1_HEAVY_GROQ_MODELS: 'llama-3.1-8b-instant' }, TASKS.HEAVY, 'groq'), ['llama-3.1-8b-instant'], 'the env override still wins');
  markModelGone('groq', 'openai/gpt-oss-120b');
  assert.ok(!catalogModelIds('groq', 'heavy').includes('openai/gpt-oss-120b'));
  assert.equal(selectedModels('heavy').groq, 'llama-3.3-70b-versatile');
});

test('2: no catalog yet: several preferred ids, never one; nothing preferred listed: the best chat model listed', () => {
  assert.ok(catalogModelIds('cloudflare', 'heavy').length > 1);
  assert.ok(catalogModelIds('github_models', 'heavy').length > 1);
  assert.deepEqual(bestListed('groq', [{ id: 'whisper-large-v3' }, { id: 'acme-8b-chat' }, { id: 'acme-70b-chat' }, { id: 'qwen-72b' }]), ['acme-70b-chat', 'acme-8b-chat'], 'no speech model, no excluded family');
});

test('2: list parsers for Cloudflare and GitHub Models', () => {
  const cf = PARSERS.cloudflare({ result: [{ name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', task: { name: 'Text Generation' }, properties: [{ property_id: 'context_window', value: '24000' }] }, { name: '@cf/x/flux', task: { name: 'Text-to-Image' } }] });
  assert.deepEqual(cf, [{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', maxInputTokens: 24000 }]);
  const gh = PARSERS.github_models([{ id: 'openai/gpt-4.1', rate_limit_tier: 'high', limits: { max_input_tokens: 1048576 }, supported_input_modalities: ['text', 'image'], supported_output_modalities: ['text'] }, { id: 'openai/text-embedding-3-small', supported_output_modalities: ['embeddings'] }]);
  assert.deepEqual(gh, [{ id: 'openai/gpt-4.1', maxInputTokens: 1048576, tier: 'high' }]);
  assert.equal(modelInputLimit('github_models', 'openai/gpt-4.1', gh[0]), 8000, 'the free tier\'s 8,000 per request, not the model\'s million');
});

test('2: a ~10k-token request goes to the model whose free limit takes it (Groq: Scout before gpt-oss-120b at 8,000 TPM)', async () => {
  await refreshCatalog('groq', { key: 'gsk_x', fetchImpl: async () => new Response(JSON.stringify(GROQ_LIST)) });
  // The request's size as the chat counts it: a 10% margin, plus the reply's
  // tokens, which Groq counts into the same per-minute budget.
  const ordered = orderForFit(catalogModels('groq', 'heavy'), Math.ceil(10368 / 0.9) + 1024).map((m) => m.id);
  assert.equal(ordered[0], 'meta-llama/llama-4-scout-17b-16e-instruct');
});

// --- 3. failures logged with the provider's message ---------------------------------------

test('3: a 200 that carries an error, or a stream with no text, logs the provider\'s own words (no key)', async () => {
  const KEY = 'github_pat_secret_value_0123456789';
  const logs = [];
  const candidate = { provider: 'github_models', key: KEY, url: 'https://models.github.ai/inference/chat/completions' };
  const body = JSON.stringify({ error: { code: 'tokens_limit_reached', message: `Request body too large for gpt-4.1 model. Max size: 8000 tokens. key ${KEY}` } });
  const r = await callOpenAiCompat({ candidate, model: 'openai/gpt-4.1', system: 's', prompt: 'p', log: (l) => logs.push(l), fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /tokens_limit_reached: Request body too large/);
  assert.match(logs[0], /ok=false .*detail=tokens_limit_reached: Request body too large for gpt-4\.1 model\. Max size: 8000 tokens/);
  assert.ok(!logs.join('').includes(KEY), 'never the key');
  const sse = 'data: {"choices":[],"prompt_filter_results":[{"prompt_index":0}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
  const r2 = await callOpenAiCompat({ candidate, model: 'openai/gpt-4.1', system: 's', prompt: 'p', log: (l) => logs.push(l), fetchImpl: async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  assert.match(r2.detail, /no text in the answer \(finish_reason=length; stream: data: \{"choices":\[\],"prompt_filter_results"/);
  const filtered = 'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n';
  const r3 = await callOpenAiCompat({ candidate, model: 'openai/gpt-4.1', system: 's', prompt: 'p', log: () => {}, fetchImpl: async () => new Response(filtered, { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(r3.refused, true, 'a safety refusal: never retried on another engine');
});

// --- 4. fit to each engine --------------------------------------------------------------------

test('4: the registry has each engine\'s input limit', () => {
  for (const p of ['gemini_free', 'groq', 'mistral', 'github_models', 'cloudflare']) assert.ok(Number.isFinite(ENGINE_MAX_INPUT_TOKENS[p]) && ENGINE_MAX_INPUT_TOKENS[p] > 0, p);
  assert.equal(ENGINE_MAX_INPUT_TOKENS.github_models, 8000);
});

test('4: trimming drops the oldest memory first, then tool output; the operator\'s message is never cut', () => {
  const turns = Array.from({ length: 30 }, (_, i) => `${i % 2 ? 'AGENT' : 'OPERATOR'}: turn ${i} ${'x'.repeat(400)}`).join('\n');
  const tool = `[LIVE THREAT TELEMETRY (5 Records)]:\n${'• row '.repeat(800)}`;
  const system = `You are PG1.\n[CAPABILITIES — what you can and cannot do]:\n- short\n\n[CONTEXT]: background\n[RECENT TURNS] (oldest first):\n${turns}\n\n${tool}`;
  const prompt = 'What changed today?';
  const before = tokensOf(system) + tokensOf(prompt);
  const a = fitRequest({ system, prompt, maxInputTokens: Math.floor(before * 0.9) });
  assert.equal(a.fits, true);
  assert.deepEqual(a.trimmed, ['memory']);
  assert.ok(!a.system.includes('turn 0 '), 'the oldest turn went first');
  assert.ok(a.system.includes('turn 29 '), 'the newest stays');
  assert.ok(a.system.includes('[LIVE THREAT TELEMETRY'), 'tool output only after memory');
  const b = fitRequest({ system, prompt, maxInputTokens: 400 });
  assert.deepEqual(b.trimmed, ['memory', 'tool_output']);
  assert.ok(!b.system.includes('[LIVE THREAT TELEMETRY'));
  assert.equal(b.prompt, prompt);
  const c = fitRequest({ system: 'y'.repeat(40000), prompt, maxInputTokens: 1000 });
  assert.equal(c.fits, false, 'cannot fit: the engine is skipped, nothing is cut mid-instruction');
});

// --- 5 and 6. routing policy ----------------------------------------------------------------

const ALL_KEYS = {
  GEMINI_API_KEY_FREE: 'AIza-free-0123456789', GEMINI_API_KEY_PAID: 'AQ.paid-0123456789', ANTHROPIC_API_KEY: 'sk-ant-0123456789',
  OPENROUTER_API_KEY: 'sk-or-0123456789', VERCEL_AI_API_KEY: 'vck_0123456789', OPENAI_API_KEY: 'sk-0123456789',
  GROQ_API_KEY: 'gsk_0123456789', MISTRAL_API_KEY: 'mis_0123456789', GITHUB_MODELS_TOKEN: 'github_pat_0123456789',
  CLOUDFLARE_AI_TOKEN: 'cf_0123456789', CLOUDFLARE_ACCOUNT_ID: 'f4ca340d9bcbeeab89bba95915dd072e'
};
const FREE_SET = new Set(['gemini_free', 'groq', 'mistral', 'github_models', 'cloudflare']);

test('5: every text task tries every free engine before any paid one (light and heavy)', () => {
  for (const task of [TASKS.LIGHT, TASKS.HEAVY]) {
    const plan = planRoute(task, { env: ALL_KEYS, dataClass: DATA.OPERATOR }).map((c) => c.provider);
    const firstPaid = plan.findIndex((p) => !FREE_SET.has(p));
    assert.ok(plan.slice(firstPaid).every((p) => !FREE_SET.has(p)), `${task}: ${plan.join(',')}`);
    assert.equal(firstPaid, 5, 'all five free engines first');
  }
});

test('5: paid text counts against PG1_DAILY_SPEND_CAP_USD: at the cap every paid engine is left out, the free ones stay', () => {
  const env = { ...ALL_KEYS, PG1_DAILY_SPEND_CAP_USD: '1' };
  assert.equal(spendCapAllows(env), true);
  recordUsage({ provider: 'anthropic', model: 'claude-opus-5-5', task: 'heavy', inputTokens: 100000, outputTokens: 50000 }, { env, log: () => {} });
  assert.equal(spendCapAllows(env), false);
  assert.equal(budgetAllows(env, 'replicate'), false, 'media counts against the same cap');
  assert.equal(budgetAllows(env, 'groq'), true);
  assert.deepEqual(planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR }).map((c) => c.provider), ['gemini_free', 'groq', 'mistral', 'github_models', 'cloudflare']);
});

test('5: operator films\' writing stages go free first; checks and client films do not', () => {
  const plan = filmTextPlan(ALL_KEYS, { writing: true }).map((c) => c.provider);
  assert.deepEqual(plan.slice(0, 5), ['gemini_free', 'groq', 'mistral', 'github_models', 'cloudflare']);
  assert.ok(!filmTextPlan(ALL_KEYS, { writing: false }).some((c) => FREE_SET.has(c.provider)), 'a shot check keeps the paid order');
  assert.ok(!filmTextPlan(ALL_KEYS, { writing: true, clientWork: true }).some((c) => FREE_SET.has(c.provider)), 'never a client film');
  assert.deepEqual(filmTextPlan(ALL_KEYS, { writing: true, withMedia: true }).map((c) => c.provider).slice(0, 1), ['gemini_free'], 'images: only engines that can see them');
  for (const p of ['storyboard', 'director: treatment and script', 'director: shot list', 'movie: screenplay']) assert.equal(isWritingPurpose(p), true, p);
  // The dailies are a check on the cheapest commercial_ok engine, never a
  // writing stage (so never a free engine).
  for (const p of ['shot check s1', 'storyboard check s1', 'dailies s1', 'movie dailies s2']) assert.equal(isWritingPurpose(p), false, p);
});

test('6: client work stays on commercial_ok engines (Claude, the paid Gemini key); with neither, the job stops with a message', async () => {
  for (const task of [TASKS.LIGHT, TASKS.HEAVY]) {
    const plan = planRoute(task, { env: ALL_KEYS, dataClass: DATA.OPERATOR, clientWork: true }).map((c) => c.provider);
    assert.deepEqual([...plan].sort(), ['anthropic', 'gemini_paid'], `${task}: ${plan}`);
  }
  const freeOnly = { GEMINI_API_KEY_FREE: ALL_KEYS.GEMINI_API_KEY_FREE, GROQ_API_KEY: ALL_KEYS.GROQ_API_KEY, OPENROUTER_API_KEY: ALL_KEYS.OPENROUTER_API_KEY };
  assert.deepEqual(filmTextPlan(freeOnly, { writing: true, clientWork: true }), []);
  await assert.rejects(filmThink({ env: freeOnly, system: 's', content: 'c', clientWork: true, purpose: 'storyboard', fetchImpl: async () => { throw new Error('no call may be made'); } }), (e) => e.kind === 'not_configured' && /client film/.test(e.detail));
});

test('5: freeFirst keeps each group\'s order', () => {
  const plan = [{ provider: 'anthropic' }, { provider: 'gemini_free' }, { provider: 'gemini_paid' }, { provider: 'groq', toolsOff: true }];
  assert.deepEqual(freeFirst(plan).map((c) => c.provider), ['gemini_free', 'groq', 'anthropic', 'gemini_paid']);
  assert.deepEqual(freeFirst(plan, { requiresTool: true }).map((c) => c.provider), ['gemini_free', 'anthropic', 'gemini_paid', 'groq']);
});

// --- 7. paid credit --------------------------------------------------------------------------

test('7: credit left per account (live balance, estimate from a top-up, or unknown) and spend by text vs media', async () => {
  assert.equal(kindOf({ task: 'heavy', unit: null }), 'text');
  assert.equal(kindOf({ task: 'media', unit: 'video_gemini' }), 'media');
  assert.equal(kindOf({ task: 'music', unit: 'music_lyria' }), 'media');
  assert.equal(kindOf({ task: 'tts', unit: null }), 'voice');
  const fetchImpl = async (url, o) => {
    assert.match(url, /\/rest\/v1\/rpc\/pg1_ai_spend_by_kind$/);
    assert.match(JSON.parse(o.body).p_since, /^\d{4}-\d{2}-\d{2}$/);
    return new Response(JSON.stringify([
      { provider: 'gemini_paid', kind: 'media', calls: 4, cost_usd: 2.0 },
      { provider: 'gemini_paid', kind: 'text', calls: 2, cost_usd: 0.25 },
      { provider: 'anthropic', kind: 'text', calls: 1, cost_usd: 0.5 }
    ]));
  };
  const env = { PG1_CREDIT_GEMINI_PAID_USD: '10', PG1_CREDIT_GEMINI_PAID_SINCE: '2026-10-01' };
  const keyRows = [{ engine: 'gemini_paid', set: true, state: STATES.WORKING }, { engine: 'openrouter', set: true, state: STATES.WORKING, balanceUsd: 1.5 }, { engine: 'anthropic', set: true, state: STATES.NO_CREDIT }];
  const out = await creditReport({ env, keyRows, supUrl: 'https://db.test', supKey: 'k', fetchImpl });
  const g = out.rows.find((r) => r.account === 'gemini_paid');
  assert.equal(g.left, '$7.75');
  assert.equal(g.leftKind, 'estimated');
  assert.deepEqual(g.spent, { text: 0.25, media: 2, voice: 0 });
  assert.equal(out.rows.find((r) => r.account === 'openrouter').left, '$1.50');
  assert.match(out.markdown, /\| Gemini \(paid key\) \| \$7\.75 \(estimated\) \| \$0\.25 \| \$2\.00 \| \$0\.00 \|/);
  assert.match(out.markdown, /\$0\.75 of text reached a paid account/);
  const offline = await spendByKind({ since: utcDay() });
  assert.equal(offline.scope, 'instance');
  assert.match(creditSection(creditRows({ keyRows: [{ engine: 'openrouter', set: true, state: 'not checked' }], spend: offline }), offline), /not read yet \(\/keys reads it\)/);
});

// --- 8. film media credit ---------------------------------------------------------------------

test('8: a film whose clips engines are all out of credit stops before anything is spent, naming them in PG1 words', async () => {
  const env = { GEMINI_API_KEY_PAID: 'AQ.paid-0123456789', REPLICATE_API_TOKEN: 'r8_0123456789' };
  const rows = [{ engine: 'gemini_paid', set: true, state: STATES.NO_CREDIT }, { engine: 'replicate', set: true, state: STATES.INVALID }];
  const check = await filmMediaCredit({ env, rows });
  assert.equal(check.ok, false);
  assert.deepEqual(check.out.map((k) => k.kind).sort(), ['clips', 'music', 'stills']);
  const text = mediaCreditText(check);
  assert.match(text, /Nothing was spent, not even on the writing/);
  assert.match(text, /video clips: PG1 Studio main media engine out of credit; PG1 Studio media fallback key not accepted/);
  assert.doesNotMatch(text, UPSTREAM_BRAND_RE);
  assert.doesNotMatch(text, /replicate/i);
  const ok = await filmMediaCredit({ env, rows: [{ engine: 'gemini_paid', set: true, state: STATES.NO_CREDIT }, { engine: 'replicate', set: true, state: STATES.WORKING }] });
  assert.equal(ok.out.some((k) => k.kind === 'clips'), false, 'one working engine is enough for clips');
});

// --- 9-12. the threat feed in chat ----------------------------------------------------------------

const NOW = Date.UTC(2026, 9, 17, 23, 30); // 00:30 on 18 Oct in Ireland (IST, UTC+1)
const rowsDb = (rows) => async (url) => {
  const u = decodeURIComponent(url);
  const since = /ingested_at=gte\.([^&]+)/.exec(u);
  let out = rows.filter((r) => !since || r.ingested_at >= since[1]);
  const lockedOnly = /or=\(verification_source\.ilike/.test(u);
  if (lockedOnly) out = out.filter((r) => !r.verification_source || /otx|alienvault|abuse|threatfox|urlhaus|Sovereign-Engine/i.test(r.verification_source));
  out = [...out].sort((a, b) => b.ingested_at.localeCompare(a.ingested_at));
  return new Response(JSON.stringify(out));
};
const TODAY = '2026-10-17T23:10:00Z';
const YESTERDAY = '2026-10-17T22:50:00Z'; // 23:50 on 17 Oct in Ireland
const FEED = [
  { value: 'CVE-2026-1001', indicator_type: 'cve', verification_source: 'NVD-CVE-API', confidence_score: 70, ingested_at: TODAY },
  { value: 'CVE-2026-1002', indicator_type: 'cve', verification_source: 'NVD-CVE-API', confidence_score: 70, ingested_at: TODAY },
  { value: 'CVE-0000-0001', indicator_type: 'cve', verification_source: 'NVD-CVE-API', confidence_score: 70, ingested_at: TODAY },
  { value: 'bad-actor.ru', indicator_type: 'domain', verification_source: 'AlienVault OTX', confidence_score: 70, ingested_at: TODAY },
  { value: 'CVE-2026-0999', indicator_type: 'cve', verification_source: 'NVD-CVE-API', confidence_score: 70, ingested_at: YESTERDAY }
];

test('9: the chat\'s read goes through the /api/ioc source policy; locked sources reach only the operator, labelled', async () => {
  const urls = [];
  const fetchImpl = async (u, o) => { urls.push(u); return rowsDb(FEED)(u, o); };
  const guest = await loadChatThreatFeed({ supUrl: 'https://db.test', supKey: 'k', fetchImpl, env: {}, isOperator: false, prompt: "today's threat feed", now: NOW });
  assert.ok(urls[0].includes('/rest/v1/threat_ioc_telemetry?'));
  assert.ok(urls[0].includes('and='), 'the source policy\'s own filter (disabledSourceQueryParams)');
  assert.ok(!guest.block.includes('bad-actor.ru'), 'OTX never for anyone but the operator');
  assert.ok(!/threat_indicators/.test(urls.join(' ')), 'not the old unfiltered table');
  const op = await loadChatThreatFeed({ supUrl: 'https://db.test', supKey: 'k', fetchImpl: rowsDb(FEED), env: {}, isOperator: true, prompt: "today's threat feed", now: NOW });
  assert.match(op.block, /bad-actor\.ru · source: AlienVault OTX · LOCKED SOURCE: not licensed, operator view only/);
});

test('10: today is the Ireland calendar day; the count by source; none today -> says so and offers the latest', async () => {
  assert.equal(irelandDay(NOW), '2026-10-18');
  assert.equal(new Date(irelandDayStart(NOW)).toISOString(), '2026-10-17T23:00:00.000Z');
  const op = await loadChatThreatFeed({ supUrl: 'https://db.test', supKey: 'k', fetchImpl: rowsDb(FEED), env: {}, isOperator: true, prompt: "what's in today's threat feed", now: NOW });
  assert.equal(op.totalToday, 3, 'two NVD and one OTX added today; yesterday\'s and the placeholder left out');
  assert.match(op.block, /\[TODAY'S THREAT FEED \(Ireland time, 2026-10-18\)\]: 3 records added today: NVD 2, AlienVault OTX 1 \(locked source, operator view only\); 1 placeholder or example indicator left out/);
  const none = await loadChatThreatFeed({ supUrl: 'https://db.test', supKey: 'k', fetchImpl: rowsDb(FEED.filter((r) => r.ingested_at === YESTERDAY)), env: {}, isOperator: true, prompt: "today's feed", now: NOW });
  assert.equal(none.latestInstead, true);
  assert.match(none.block, /No records were added today\. Say so plainly and offer the latest records below/);
  assert.match(none.block, /CVE-2026-0999/);
  assert.equal(isThreatFeedQuestion("what's in today's threat feed?"), true);
  assert.equal(asksForToday("today's feed"), true);
});

test('11: placeholder and example indicators never reach the reply', () => {
  for (const v of ['contoso.com', 'evil.contoso.com', 'example.com', 'https://www.example.org/x', 'example.net', 'maliciousdomain.com', 'malicious-domain.net', 'test.com', 'sample-domain.org', 'placeholder.io', 'dummy123.org', 'yourdomain.com', 'foo.test', '192.0.2.10', '1.2.3.4', '0.0.0.0', 'd41d8cd98f00b204e9800998ecf8427e', '0'.repeat(64), 'placeholder', 'CVE-0000-0001']) {
    assert.equal(isPlaceholderIndicator(v), true, v);
  }
  for (const v of ['CVE-2026-1001', 'bad-actor.ru', 'login-microsoft-verify.com', '45.133.1.20', 'latestnews.com', 'contest-results.com']) {
    assert.equal(isPlaceholderIndicator(v), false, v);
  }
  assert.ok(PLACEHOLDER_PATTERNS.length >= 6 && PLACEHOLDER_PATTERNS.every((p) => p.id && p.example));
});

test('12: a confidence every row of a source shares is a default, not a score: not shown; scores that differ are', async () => {
  const op = await loadChatThreatFeed({ supUrl: 'https://db.test', supKey: 'k', fetchImpl: rowsDb(FEED), env: {}, isOperator: true, prompt: "today's threat feed", now: NOW });
  assert.doesNotMatch(op.block, /confidence 70/);
  const varied = FEED.map((r, i) => ({ ...r, confidence_score: 50 + i }));
  const v = await loadChatThreatFeed({ supUrl: 'https://db.test', supKey: 'k', fetchImpl: rowsDb(varied), env: {}, isOperator: true, prompt: "today's threat feed", now: NOW });
  assert.match(v.block, /CVE-2026-1001 · source: NVD · confidence 50 \(from the source\)/);
  assert.equal(confidenceIsReal([{ source: 'nvd', confidence_score: 70 }, { source: 'nvd', confidence_score: 70 }], 'nvd'), false);
  assert.match(op.block, /"no flags found", never "safe"/);
});

// --- the chat, end to end (request sjv9vnbs replayed) ------------------------------------------

import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

let ipSeq = 0;
const ROUTER_ENV = ['GEMINI_API_KEY_FREE', 'GEMINI_API_KEY_PAID', 'GEMINI_API_KEY', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPEN_ROUTER_KEY', 'VERCEL_AI_API_KEY', 'AI_GATEWAY_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GITHUB_MODELS_TOKEN', 'CLOUDFLARE_AI_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASEAPI_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'PG1_FREE_LIMITER', 'REPLICATE_API_TOKEN', 'CARTESIA_API_KEY'];
async function chat(prompt) {
  __clearAuthRateLimitState();
  const res = {
    statusCode: null, headers: {}, chunks: [], jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {}
  };
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.95.0.${++ipSeq}` }, body: { user: 'test-operator', pass: 'test-secret-pass', prompt } }, res);
  return res;
}
function sjvEngines({ free }) {
  for (const k of ROUTER_ENV) delete process.env[k];
  Object.assign(process.env, { USER_API_KEY: 'test-operator', USER_API_PASS: 'test-secret-pass', GEMINI_API_KEY_FREE: 'AIza-free-sjv-0123456789', GEMINI_API_KEY_PAID: 'AQ.paid-sjv-0123456789', ANTHROPIC_API_KEY: 'sk-ant-sjv-0123456789', GROQ_API_KEY: 'gsk_sjv_0123456789' });
  const calls = [];
  let freeN = 0;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) { calls.push('anthropic'); return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }), { status: 400 }); }
    if (u.includes('generativelanguage.googleapis.com')) {
      const paid = options.headers['x-goog-api-key'] === process.env.GEMINI_API_KEY_PAID;
      calls.push(paid ? 'gemini_paid' : 'gemini_free');
      if (paid) return new Response(JSON.stringify({ error: { code: 402, message: 'Your prepayment credits are depleted.' } }), { status: 402 });
      return free(++freeN);
    }
    if (u === 'https://api.groq.com/openai/v1/models') { calls.push('groq:models'); return new Response(JSON.stringify(GROQ_LIST)); }
    if (u.includes('api.groq.com')) { calls.push(`groq:${JSON.parse(options.body).model}`); return Response.json({ choices: [{ message: { content: 'Second free answer.' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }); }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}
const geminiOk = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } }));

test('chat: the free key\'s per-minute 429 is waited out and the free key answers; no paid engine is called', async () => {
  const calls = sjvEngines({ free: (n) => (n === 1 ? new Response(gemini429({ retry: '1s' }), { status: 429 }) : geminiOk('Free answer.')) });
  const res = await chat('summarise what an x402 facilitator does');
  assert.match(res.jsonBody.reply, /Free answer\./);
  assert.deepEqual(calls.filter((c) => !c.startsWith('groq:models')), ['gemini_free', 'gemini_free'], 'waited, asked again, no paid engine');
});

test('chat: the free key\'s daily quota falls through at once to the next free engine (not a paid one), on a model Groq still lists', async () => {
  const calls = sjvEngines({ free: () => new Response(gemini429({ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', retry: '30s' }), { status: 429 }) });
  const res = await chat('summarise what an x402 facilitator does');
  assert.match(res.jsonBody.reply, /Second free answer\./);
  const engines = calls.filter((c) => c !== 'groq:models');
  assert.equal(engines.filter((c) => c === 'gemini_free').length, 1, 'a day\'s quota is not asked again');
  assert.ok(!engines.includes('anthropic') && !engines.includes('gemini_paid'), 'no paid credit while a free engine answers');
  assert.ok(!engines.includes('groq:qwen/qwen3-32b'));
  assert.doesNotMatch(res.jsonBody.reply, /groq|gemini|google|anthropic|claude/i);
});
