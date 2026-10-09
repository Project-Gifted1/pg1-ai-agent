/**
 * The cost-saving AI router (lib/aiRouter.mjs, lib/ttsRouter.mjs) and its
 * wiring into api/chat.mjs:
 *   1. routing: which provider, key and model each task gets, in order;
 *   2. keys by role, and the old env var names kept as fallbacks;
 *   3. fallbacks on 429, quota, billing and 5xx, and none on a refusal;
 *   4. the privacy rule: the free Gemini key only ever gets operator content,
 *      and a guest or customer session is paid-only whatever it says;
 *   5. daily budgets per provider and the usage log (never content or keys);
 *   6. caching identical text and TTS requests, scoped to one user;
 *   7. the chat end to end: free key first, paid only for customer data,
 *      /core on the reasoning core, the /spend summary in PG1 labels.
 *
 * Run with: node --test tests/ai-router.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  TASKS, DATA, ENGINE_LABELS, resolveKeys, mediaGeminiKeys, classifyTask, dataClassFor, containsCustomerData, planRoute, runRoute,
  isFallbackFailure, tripBreaker, isTripped, recordUsage, dailyBudgetUsd, budgetAllows, estimateCost, createLruCache, cacheKey, cacheIdentity,
  textCache, ttsCache, spendSummary, memoryLedger, utcDay, routeModels, __resetRouterState, RATE_LIMIT_WINDOW_MS, BREAKER_WINDOW_MS
} from '../lib/aiRouter.mjs';
import { synthesizeSpeech, createRoutedSynth, geminiVoiceName } from '../lib/ttsRouter.mjs';
import chatHandler, { __clearAuthRateLimitState, __chatRoundPlan } from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const FREE = 'AIzaStub-free-key-0123456789abcdef';
const PAID = 'AQ.Stub-paid-key-0123456789abcdef';
const OLD1 = 'AIzaStub-old-key-one-0123456789';
const OLD2 = 'AIzaStub-old-key-two-0123456789';
const ANTHROPIC = 'sk-ant-stub-router-0123456789abcdef';
const quiet = () => {};

const ROUTER_ENV = ['GEMINI_API_KEY_FREE', 'GEMINI_API_KEY_PAID', 'GEMINI_API_KEY', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'ANTHROPIC_API_KEY',
  'ANTROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPEN_ROUTER_KEY', 'VERCEL_AI_API_KEY', 'AI_GATEWAY_API_KEY', 'REPLICATE_API_TOKEN',
  'REPLICATE_KEY', 'CARTESIA_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASEAPI_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY',
  'USER_API_USER', 'USER_API_PASSS', 'PG1_TTS_FREE_FIRST', 'PG1_TTS_GEMINI_VOICE'];

beforeEach(() => {
  __resetRouterState();
  __clearAuthRateLimitState();
  for (const k of Object.keys(process.env)) if (/^PG1_DAILY_BUDGET_/.test(k)) delete process.env[k];
  for (const k of ROUTER_ENV) delete process.env[k];
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  // The cache is off under the test runner unless asked for.
  process.env.PG1_AI_CACHE = '1';
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

const ids = (plan) => plan.map((c) => `${c.provider}:${c.key}`);
// Opt-in Gemini speech (PG1_TTS_FREE_FIRST=1 plus a named voice).
const TTS_FREE = { PG1_TTS_FREE_FIRST: '1', PG1_TTS_GEMINI_VOICE: 'Puck' };
const OP_ID = cacheIdentity({ isOperator: true, operatorId: 'test-operator' });
const GUEST_ID = cacheIdentity({ isOperator: false, clientId: '203.0.113.7' });

// --- 1. routing ------------------------------------------------------------------------

test('light: free Gemini key first for operator content, then the paid key, then the reasoning core and the backups', () => {
  const env = { GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC, VERCEL_AI_API_KEY: 'vck', OPENROUTER_API_KEY: 'or', OPENAI_API_KEY: 'oa' };
  const plan = planRoute(TASKS.LIGHT, { env, dataClass: DATA.OPERATOR });
  assert.deepEqual(plan.map((c) => c.provider), ['gemini_free', 'gemini_paid', 'anthropic', 'gateway', 'openrouter', 'openai']);
  assert.equal(plan[0].key, FREE);
  assert.deepEqual(plan[2].models, ['claude-haiku-5-5'], 'the cheapest reasoning model for light work');
  assert.deepEqual(plan[3].url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
});

test('heavy: the strongest reasoning model first, then the main core', () => {
  const env = { GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC };
  const plan = planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR });
  assert.deepEqual(plan.map((c) => c.provider), ['anthropic', 'gemini_paid', 'gemini_free']);
  assert.equal(plan[0].models[0], 'claude-opus-5-5');
});

test('a round with functions leaves out the OpenAI-compatible backups (they are called without functions)', () => {
  const env = { GEMINI_API_KEY_PAID: PAID, OPENROUTER_API_KEY: 'or' };
  assert.deepEqual(planRoute(TASKS.LIGHT, { env, dataClass: DATA.OPERATOR, withTools: true }).map((c) => c.provider), ['gemini_paid']);
});

test('tts: Cartesia only by default, even for operator content with the free key set', () => {
  const env = { GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY_PAID: PAID, CARTESIA_API_KEY: 'cart' };
  assert.deepEqual(planRoute(TASKS.TTS, { env, dataClass: DATA.OPERATOR }).map((c) => c.family), ['cartesia']);
  assert.deepEqual(planRoute(TASKS.TTS, { env, dataClass: DATA.CUSTOMER }).map((c) => c.family), ['cartesia']);
  assert.equal(resolveKeys(env).ttsGemini, '');
});

test('tts: PG1_TTS_FREE_FIRST=1 with a named voice puts the free key first for operator content only', () => {
  const env = { GEMINI_API_KEY_FREE: FREE, CARTESIA_API_KEY: 'cart', ...TTS_FREE };
  assert.deepEqual(planRoute(TASKS.TTS, { env, dataClass: DATA.OPERATOR }).map((c) => c.family), ['gemini_tts', 'cartesia']);
  assert.deepEqual(planRoute(TASKS.TTS, { env, dataClass: DATA.CUSTOMER }).map((c) => c.family), ['cartesia']);
  for (const v of ['0', 'true', 'yes', '']) {
    assert.deepEqual(planRoute(TASKS.TTS, { env: { ...env, PG1_TTS_FREE_FIRST: v }, dataClass: DATA.OPERATOR }).map((c) => c.family), ['cartesia'], `PG1_TTS_FREE_FIRST=${v}`);
  }
});

test('tts: no default Gemini voice (Kore is gone): the flag without PG1_TTS_GEMINI_VOICE stays on Cartesia', () => {
  const env = { GEMINI_API_KEY_FREE: FREE, CARTESIA_API_KEY: 'cart', PG1_TTS_FREE_FIRST: '1' };
  assert.equal(geminiVoiceName(env), '');
  assert.equal(geminiVoiceName({ PG1_TTS_GEMINI_VOICE: 'Puck' }), 'Puck');
  assert.deepEqual(planRoute(TASKS.TTS, { env, dataClass: DATA.OPERATOR }).map((c) => c.family), ['cartesia']);
});

test('tts never uses an old Gemini name: without GEMINI_API_KEY_FREE the voice stays on Cartesia as before', () => {
  const env = { GEMINI_API_KEY1: OLD1, CARTESIA_API_KEY: 'cart', ...TTS_FREE };
  assert.deepEqual(planRoute(TASKS.TTS, { env, dataClass: DATA.OPERATOR }).map((c) => c.family), ['cartesia']);
});

test('media: paid keys only (never the free one), with Replicate as the fallback', () => {
  const env = { GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY_PAID: PAID, REPLICATE_API_TOKEN: 'r8' };
  const plan = planRoute(TASKS.MEDIA, { env, dataClass: DATA.OPERATOR });
  assert.deepEqual(ids(plan), [`gemini_paid:${PAID}`, 'replicate:r8']);
  assert.deepEqual(mediaGeminiKeys(env), [PAID]);
});

test('model lists can be replaced per task and provider with an env var', () => {
  assert.deepEqual(routeModels({ PG1_LIGHT_GEMINI_MODELS: 'gemini-3.1-flash-lite, gemini-3.8-flash' }, 'light', 'gemini'), ['gemini-3.1-flash-lite', 'gemini-3.8-flash']);
  assert.deepEqual(routeModels({ PG1_HEAVY_ANTHROPIC_MODELS: 'bad model!' }, 'heavy', 'anthropic'), ['claude-opus-5-5', 'claude-sonnet-5-5'], 'an invalid list keeps the default');
});

test('classifyTask: security, code and analysis are heavy; summaries, formatting and short replies are light', () => {
  for (const t of ['/core what next', 'analyze this phishing kit', 'is CVE-2026-1234 exploitable here?', 'refactor this function', 'should we rotate the keys?', '```js\nx()\n```', 'x'.repeat(1600)]) {
    assert.equal(classifyTask(t), TASKS.HEAVY, t.slice(0, 30));
  }
  for (const t of ['hello', 'summarize this threat report for me', 'format this as a table', 'translate to French', 'thanks!', 'write a comprehensive report on our week']) {
    assert.equal(classifyTask(t), TASKS.LIGHT, t);
  }
});

// --- 2. keys by role and old names ---------------------------------------------------------------

test('old names are fallbacks only: with neither new name set, chat and media use GEMINI_API_KEY1/2 as paid keys', () => {
  const k = resolveKeys({ GEMINI_API_KEY1: OLD1, GEMINI_API_KEY2: OLD2 });
  assert.deepEqual(k.geminiFree, [], 'an old key is never assumed to be free');
  assert.deepEqual(k.geminiPaid, [OLD1, OLD2]);
  assert.equal(k.ttsGemini, '');
});

test('the new names win: GEMINI_API_KEY_PAID replaces the old keys, GEMINI_API_KEY_FREE fills the free role', () => {
  const k = resolveKeys({ GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY_PAID: PAID, GEMINI_API_KEY1: OLD1, GEMINI_API_KEY2: OLD2 });
  assert.deepEqual(k.geminiFree, [FREE]);
  assert.deepEqual(k.geminiPaid, [PAID]);
});

test('only the free key set: the old keys still serve the paid role', () => {
  const k = resolveKeys({ GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY1: OLD1 });
  assert.deepEqual(k.geminiPaid, [OLD1]);
});

test('an old key that holds the free key value is never used as a paid key', () => {
  const k = resolveKeys({ GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY1: FREE, GEMINI_API_KEY2: OLD2 });
  assert.deepEqual(k.geminiPaid, [OLD2]);
});

test('duplicate names: OPENROUTER_API_KEY before OPEN_ROUTER_KEY, REPLICATE_API_TOKEN before REPLICATE_KEY, and the rest', () => {
  assert.equal(resolveKeys({ OPEN_ROUTER_KEY: 'b' }).openrouter, 'b');
  assert.equal(resolveKeys({ OPENROUTER_API_KEY: 'a', OPEN_ROUTER_KEY: 'b' }).openrouter, 'a');
  assert.equal(resolveKeys({ REPLICATE_KEY: 'b' }).replicate, 'b');
  assert.equal(resolveKeys({ REPLICATE_API_TOKEN: 'a', REPLICATE_KEY: 'b' }).replicate, 'a');
  assert.equal(resolveKeys({ AI_GATEWAY_API_KEY: 'b' }).gateway, 'b');
  assert.equal(resolveKeys({ VERCEL_AI_API_KEY: 'a', AI_GATEWAY_API_KEY: 'b' }).gateway, 'a');
  assert.equal(resolveKeys({ ANTROPIC_API_KEY: 'b' }).anthropic, 'b');
  assert.equal(resolveKeys({ GEMINI_API_KEY_PAID: ' AQ.with spaces ' }).geminiPaid[0], 'AQ.withspaces', 'whitespace is stripped as before');
});

// --- 3. fallbacks ---------------------------------------------------------------------------------

test('isFallbackFailure: 429, 402, 5xx, timeouts and quota or billing text move on; a 400 or a refusal does not', () => {
  for (const [status, text] of [[429, ''], [402, ''], [500, ''], [503, ''], [null, 'timed out'], [403, 'billing account disabled'], [400, 'RESOURCE_EXHAUSTED: quota exceeded'], [401, ''], [404, '']]) {
    assert.equal(isFallbackFailure(status, text), true, `${status} ${text}`);
  }
  assert.equal(isFallbackFailure(400, 'Invalid JSON payload'), false);
  assert.equal(isFallbackFailure(400, 'blocked by the safety filter'), false);
});

test('runRoute: walks the plan on quota, billing and 5xx errors and records each attempt', async () => {
  const env = { GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC };
  const tried = [];
  const lines = [];
  const answers = { gemini_free: { ok: false, status: 429, detail: 'RESOURCE_EXHAUSTED' }, gemini_paid: { ok: false, status: 402, detail: 'prepaid credit exhausted' } };
  const r = await runRoute({
    task: TASKS.LIGHT, env, dataClass: DATA.OPERATOR, log: (l) => lines.push(l),
    attempt: async (c) => { tried.push(c.provider); return answers[c.provider] || { ok: true, value: 'answer', model: c.models[0], usage: { inputTokens: 100, outputTokens: 20 } }; }
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, 'answer');
  assert.deepEqual(tried, ['gemini_free', 'gemini_paid', 'anthropic']);
  assert.equal(r.failures.length, 2);
  assert.equal(lines.length, 3, 'one usage line per attempt');
  assert.match(lines[2], /"provider":"anthropic".*"fallback":2/);
});

test('runRoute: stops on a refusal and on a plain 400 instead of routing round it', async () => {
  const env = { GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC };
  for (const answer of [{ ok: false, status: 200, refused: true, detail: 'SAFETY' }, { ok: false, status: 400, detail: 'Invalid argument' }]) {
    const tried = [];
    const r = await runRoute({ task: TASKS.LIGHT, env, dataClass: DATA.CUSTOMER, log: quiet, attempt: async (c) => { tried.push(c.provider); return answer; } });
    assert.equal(r.ok, false);
    assert.deepEqual(tried, ['gemini_paid'], JSON.stringify(answer));
  }
});

test('the breaker: a drained prepaid key goes to the back for 15 minutes, a rate-limited one for a minute, and is still tried last', () => {
  const env = { GEMINI_API_KEY_PAID: PAID, REPLICATE_API_TOKEN: 'r8' };
  const now = Date.now();
  assert.equal(tripBreaker('gemini_paid#1', 429, 'RESOURCE_EXHAUSTED: quota exceeded for your prepaid credits', now), true);
  assert.ok(isTripped('gemini_paid#1', now + BREAKER_WINDOW_MS - 1000));
  assert.deepEqual(planRoute(TASKS.MEDIA, { env, now: now + 1000 }).map((c) => c.provider), ['replicate', 'gemini_paid']);
  assert.equal(isTripped('gemini_paid#1', now + BREAKER_WINDOW_MS + 1), false);
  tripBreaker('anthropic', 429, 'rate limited', now);
  assert.ok(isTripped('anthropic', now + RATE_LIMIT_WINDOW_MS - 1));
  assert.equal(isTripped('anthropic', now + RATE_LIMIT_WINDOW_MS + 1), false);
  assert.equal(tripBreaker('anthropic', 500, 'boom', now), false, 'a 5xx moves on but does not open the breaker');
});

// --- 4. privacy -------------------------------------------------------------------------------------

test('dataClassFor: operator content only when the operator is signed in and nothing carries customer data', () => {
  assert.equal(dataClassFor({ isOperator: true, texts: ['check this wallet 0xabc'] }), DATA.OPERATOR);
  assert.equal(dataClassFor({ isOperator: false, texts: ['hello'] }), DATA.CUSTOMER, 'a guest is customer data');
  assert.equal(dataClassFor({}), DATA.CUSTOMER, 'unknown defaults to customer');
  assert.equal(dataClassFor({ isOperator: true, texts: ['reply to jane.doe@example.com'] }), DATA.CUSTOMER, 'an email address');
  assert.equal(dataClassFor({ isOperator: true, texts: ['call +353 87 123 4567'] }), DATA.CUSTOMER, 'a phone number');
  assert.equal(dataClassFor({ isOperator: true, texts: ['- **Top MCP clients** (self-reported): claude (3)'] }), DATA.CUSTOMER, 'the usage card quoted from history');
  const turns = [{ role: 'model', calls: [{ name: 'get_usage_stats', args: {} }] }];
  assert.equal(dataClassFor({ isOperator: true, texts: ['how are we doing?'], turns }), DATA.CUSTOMER, 'a usage-stats result in the round');
  assert.equal(containsCustomerData('0x7067312d00000000000000000000000000000000'), false, 'a wallet address is not customer data');
});

test('a guest or customer session is customer data regardless of content; only isOperator === true counts', () => {
  for (const text of ['hello', 'good morning', 'what is a honeypot?', 'check this wallet 0x7067312d00000000000000000000000000000000', '']) {
    assert.equal(dataClassFor({ isOperator: false, texts: [text] }), DATA.CUSTOMER, `guest: ${text}`);
  }
  for (const flag of [undefined, null, 1, 'true', 'operator', {}]) {
    assert.equal(dataClassFor({ isOperator: flag, texts: ['hello'] }), DATA.CUSTOMER, `isOperator=${JSON.stringify(flag)}`);
  }
  const env = { GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC, CARTESIA_API_KEY: 'cart', ...TTS_FREE };
  for (const task of Object.values(TASKS)) {
    const plan = planRoute(task, { env, dataClass: dataClassFor({ isOperator: false, texts: ['hello'] }) });
    assert.ok(plan.every((c) => c.key !== FREE && c.provider !== 'gemini_free'), `${task}: paid only for a guest`);
  }
});

test('customer data never gets the free key, in any task', () => {
  const env = { GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY_PAID: PAID, GEMINI_API_KEY1: OLD1, ANTHROPIC_API_KEY: ANTHROPIC, CARTESIA_API_KEY: 'cart', REPLICATE_API_TOKEN: 'r8' };
  for (const task of Object.values(TASKS)) {
    for (const c of planRoute(task, { env, dataClass: DATA.CUSTOMER })) {
      assert.notEqual(c.key, FREE, `${task}: ${c.provider}`);
      assert.notEqual(c.provider, 'gemini_free', task);
    }
  }
});

// --- 5. budgets and the usage log ---------------------------------------------------------------------

test('a provider over its daily budget is left out of every plan until the day turns', () => {
  const env = { GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC, PG1_DAILY_BUDGET_ANTHROPIC_USD: '0.50' };
  assert.equal(dailyBudgetUsd(env, 'anthropic'), 0.5);
  assert.equal(dailyBudgetUsd(env, 'openai'), Infinity, 'unset: no cap');
  assert.equal(dailyBudgetUsd({ PG1_DAILY_BUDGET_OPENAI_USD: 'lots' }, 'openai'), Infinity, 'unreadable: no cap');
  assert.deepEqual(planRoute(TASKS.HEAVY, { env }).map((c) => c.provider), ['anthropic', 'gemini_paid']);
  // 30k in / 20k out on Opus 5.5 ($4 / $20 per 1M) = $0.52.
  recordUsage({ provider: 'anthropic', model: 'claude-opus-5-5', task: TASKS.HEAVY, inputTokens: 30000, outputTokens: 20000 }, { env, log: quiet });
  assert.equal(budgetAllows(env, 'anthropic'), false);
  assert.deepEqual(planRoute(TASKS.HEAVY, { env }).map((c) => c.provider), ['gemini_paid']);
  const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
  assert.equal(budgetAllows(env, 'anthropic', { now: tomorrow }), true, 'a new UTC day starts from zero');
});

test('estimated costs: the free key is free, Cartesia by characters, text by tokens, media by unit', () => {
  assert.equal(estimateCost({ provider: 'gemini_free', model: 'gemini-3.8-flash', inputTokens: 1e6, outputTokens: 1e6 }), 0);
  assert.equal(estimateCost({ provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 1e6, outputTokens: 1e6 }), 0.6);
  assert.equal(estimateCost({ provider: 'cartesia', chars: 1e6 }), 50);
  assert.equal(estimateCost({ provider: 'replicate', unit: 'image_replicate' }), 0.003);
  assert.equal(estimateCost({ env: { PG1_PRICE_CLAUDE_HAIKU_5_5: '1,2' }, provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 1e6, outputTokens: 1e6 }), 3, 'a price override');
});

test('the usage log and the ledger row carry provider, model, task, tokens and cost, never content or keys', () => {
  const lines = [];
  const row = recordUsage({ provider: 'gemini_paid', model: 'gemini-3.8-flash', task: TASKS.LIGHT, inputTokens: 10, outputTokens: 5, prompt: 'SECRET PROMPT', key: PAID, text: 'SECRET REPLY' }, { log: (l) => lines.push(l) });
  assert.deepEqual(Object.keys(row).sort(), ['cached', 'chars', 'cost_usd', 'data_class', 'day', 'fallback', 'input_tokens', 'model', 'ok', 'output_tokens', 'provider', 'request_id', 'status', 'task', 'unit'].sort());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[pg1-ai-usage\] \{/);
  for (const s of ['SECRET PROMPT', 'SECRET REPLY', PAID]) assert.ok(!lines[0].includes(s), s);
});

test('the shared ledger writes rows to pg1_ai_usage and reads the day\'s spend through pg1_ai_spend', async () => {
  const { createSupabaseLedger } = await import('../lib/aiRouter.mjs');
  const calls = [];
  const fetchImpl = async (u, o) => {
    calls.push({ u, body: o.body });
    if (u.endsWith('/rpc/pg1_ai_spend')) return Response.json([{ provider: 'anthropic', calls: 3, cost_usd: '4.20', cached: 1 }]);
    return new Response('', { status: 201 });
  };
  const ledger = createSupabaseLedger({ supUrl: 'https://db.test', supKey: 'service', fetchImpl });
  const day = utcDay();
  assert.deepEqual(await ledger.totals(day), { anthropic: { calls: 3, cost_usd: 4.2, cached: 1 } });
  assert.equal(ledger.spent(day, 'anthropic'), 4.2);
  assert.equal(budgetAllows({ PG1_DAILY_BUDGET_ANTHROPIC_USD: '4' }, 'anthropic', { ledger }), false, 'the other instances\' spend counts');
  recordUsage({ provider: 'anthropic', model: 'claude-haiku-5-5', task: TASKS.LIGHT, inputTokens: 1, outputTokens: 1 }, { ledger, log: quiet });
  await new Promise((r) => setTimeout(r, 5));
  const insert = calls.find((c) => c.u.endsWith('/rest/v1/pg1_ai_usage'));
  assert.ok(insert, 'the row was written');
  assert.equal(JSON.parse(insert.body).provider, 'anthropic');
});

test('/spend summary: PG1 engine labels only, with caps and the total', async () => {
  const env = { PG1_DAILY_BUDGET_GEMINI_PAID_USD: '2' };
  recordUsage({ provider: 'gemini_paid', model: 'gemini-3.8-flash', task: TASKS.LIGHT, inputTokens: 1e6, outputTokens: 0 }, { env, log: quiet });
  recordUsage({ provider: 'cartesia', model: 'sonic-3.6', task: TASKS.TTS, chars: 2000 }, { env, log: quiet });
  recordUsage({ provider: 'gemini_free', model: 'gemini-3.8-flash', task: TASKS.LIGHT, inputTokens: 5000, outputTokens: 500 }, { env, log: quiet });
  const text = await spendSummary({ env });
  assert.match(text, /AI SPEND/);
  assert.match(text, new RegExp(`${ENGINE_LABELS.gemini_paid}\\*\\*: \\$0\\.7500 over 1 calls · cap \\$2\\.00`));
  assert.match(text, /PG1 main core \(free tier\)\*\*: \$0\.0000 over 1 calls/);
  assert.match(text, /PG1 voice engine/);
  assert.match(text, /Total\*\*: \$0\.8500/);
  assert.doesNotMatch(text, /gemini|google|anthropic|claude|cartesia|replicate|openai|openrouter/i, 'no provider names');
  assert.ok(memoryLedger.rows(utcDay()).length === 3);
});

// --- 6. caching ---------------------------------------------------------------------------------------

test('runRoute answers an identical request from the cache, without calling a provider', async () => {
  const env = { GEMINI_API_KEY_PAID: PAID };
  const cache = createLruCache();
  let calls = 0;
  const lines = [];
  const go = () => runRoute({ task: TASKS.LIGHT, env: { ...env, PG1_AI_CACHE: '1' }, cache, key: cacheKey(OP_ID, 't', 'same prompt'), log: (l) => lines.push(l), attempt: async (c) => { calls++; return { ok: true, value: 'v', model: c.models[0] }; } });
  assert.equal((await go()).cached, false);
  const second = await go();
  assert.equal(second.cached, true);
  assert.equal(second.value, 'v');
  assert.equal(calls, 1);
  assert.match(lines[1], /"cached":true.*/);
  assert.match(lines[1], /"cost_usd":0/);
  // PG1_AI_CACHE=0 switches it off.
  await runRoute({ task: TASKS.LIGHT, env: { ...env, PG1_AI_CACHE: '0' }, cache, key: cacheKey(OP_ID, 't', 'same prompt'), log: quiet, attempt: async () => { calls++; return { ok: true, value: 'v' }; } });
  assert.equal(calls, 2);
});

test('cache keys are scoped to one user: different identities never share a key, and no identity means no cache', async () => {
  assert.ok(OP_ID && GUEST_ID);
  assert.notEqual(cacheKey(OP_ID, 'chat', 'same prompt'), cacheKey(GUEST_ID, 'chat', 'same prompt'));
  assert.notEqual(cacheKey(GUEST_ID, 'x'), cacheKey(cacheIdentity({ clientId: '203.0.113.8' }), 'x'), 'two guests differ');
  assert.equal(cacheKey('', 'chat', 'same prompt'), null);
  assert.equal(cacheKey(null, 'chat', 'same prompt'), null);
  assert.equal(cacheIdentity({ isOperator: false, clientId: 'unknown' }), '', 'no usable identity');
  assert.equal(cacheIdentity({ isOperator: 'true', operatorId: 'x', clientId: '' }), '', 'only isOperator === true is the operator');
  // runRoute with no key (no identity) calls the provider every time.
  let calls = 0;
  const cache = createLruCache();
  for (let i = 0; i < 2; i++) await runRoute({ task: TASKS.LIGHT, env: { GEMINI_API_KEY_PAID: PAID, PG1_AI_CACHE: '1' }, cache, key: cacheKey('', 'p'), log: quiet, attempt: async (c) => { calls++; return { ok: true, value: 'v', model: c.models[0] }; } });
  assert.equal(calls, 2);
  assert.equal(cache.size, 0);
});

test('the LRU cache expires entries and keeps within its byte cap', () => {
  const c = createLruCache({ maxEntries: 2, maxBytes: 1000, ttlMs: 50 });
  const t0 = 1000;
  c.set('a', 'x', { now: t0 }); c.set('b', 'y', { now: t0 }); c.set('c', 'z', { now: t0 });
  assert.equal(c.get('a', t0), undefined, 'evicted, oldest first');
  assert.equal(c.get('c', t0), 'z');
  assert.equal(c.get('c', t0 + 51), undefined, 'expired');
  c.set('big', new Uint8Array(2000), { now: t0 });
  assert.equal(c.get('big', t0), undefined, 'too big to keep');
});

const pcmAnswer = (bytes = 9600) => Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(bytes, 1).toString('base64') } }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 100 } });

test('TTS: /speak is Cartesia by default, even for the operator with the free key set', async () => {
  const seen = [];
  const fetchImpl = async (u) => { seen.push(new URL(u).hostname); return new Response(new Uint8Array([0xff, 0xfb, 1, 2])); };
  const env = { GEMINI_API_KEY_FREE: FREE, CARTESIA_API_KEY: 'cart' };
  const a = await synthesizeSpeech({ env, text: 'Vault is green.', dataClass: DATA.OPERATOR, identity: OP_ID, cartesia: { voiceId: 'v' }, fetchImpl, log: quiet });
  assert.equal(a.ok, true);
  assert.equal(a.mimeType, 'audio/mp3');
  assert.deepEqual(seen, ['api.cartesia.ai']);
});

test('TTS: with PG1_TTS_FREE_FIRST=1 /speak uses the free key and the named voice, then answers the same text from the cache', async () => {
  const seen = [];
  const fetchImpl = async (u, o) => { seen.push({ u, key: o.headers['x-goog-api-key'], voice: JSON.parse(o.body).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName }); return pcmAnswer(); };
  const env = { GEMINI_API_KEY_FREE: FREE, CARTESIA_API_KEY: 'cart', PG1_AI_CACHE: '1', ...TTS_FREE };
  const a = await synthesizeSpeech({ env, text: 'Vault is green.', dataClass: DATA.OPERATOR, identity: OP_ID, cartesia: { voiceId: 'v' }, fetchImpl, log: quiet });
  assert.equal(a.ok, true);
  assert.equal(a.mimeType, 'audio/wav');
  assert.equal(Buffer.from(a.bytes.subarray(0, 4)).toString(), 'RIFF');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, FREE);
  assert.equal(seen[0].voice, 'Puck');
  assert.ok(!seen[0].u.includes('key='), 'the key is never in the URL');
  const b = await synthesizeSpeech({ env, text: 'Vault is green.', dataClass: DATA.OPERATOR, identity: OP_ID, cartesia: { voiceId: 'v' }, fetchImpl, log: quiet });
  assert.equal(b.cached, true);
  assert.equal(seen.length, 1, 'no second call');
});

test('TTS: when the free key is out of quota, Cartesia speaks; customer content goes straight to Cartesia', async () => {
  const seen = [];
  const fetchImpl = async (u) => {
    seen.push(u);
    if (u.includes('generativelanguage')) return new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', { status: 429 });
    return new Response(new Uint8Array([0xff, 0xfb, 1, 2]));
  };
  const env = { GEMINI_API_KEY_FREE: FREE, CARTESIA_API_KEY: 'cart', ...TTS_FREE };
  const a = await synthesizeSpeech({ env, text: 'Quota test.', dataClass: DATA.OPERATOR, cartesia: { voiceId: 'v' }, fetchImpl, log: quiet });
  assert.equal(a.ok, true);
  assert.equal(a.mimeType, 'audio/mp3');
  assert.deepEqual(seen.map((u) => new URL(u).hostname), ['generativelanguage.googleapis.com', 'api.cartesia.ai']);
  seen.length = 0;
  await synthesizeSpeech({ env, text: 'Customer line.', dataClass: DATA.CUSTOMER, cartesia: { voiceId: 'v' }, fetchImpl, log: quiet });
  assert.deepEqual(seen.map((u) => new URL(u).hostname), ['api.cartesia.ai']);
});

test('TTS streamed: sentences on the free key, cached repeats, a customer sentence moves the reply to Cartesia for good', async () => {
  const seen = [];
  const fetchImpl = async (u) => {
    seen.push(new URL(u).hostname);
    if (u.includes('generativelanguage')) return pcmAnswer(70000);
    return new Response(`data: ${JSON.stringify({ type: 'chunk', data: 'AAAA' })}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n`);
  };
  const synth = createRoutedSynth({ env: { GEMINI_API_KEY_FREE: FREE, CARTESIA_API_KEY: 'cart', PG1_AI_CACHE: '1', ...TTS_FREE }, voiceId: 'v', modelId: 'sonic-3.6', dataClass: DATA.OPERATOR, identity: OP_ID, fetchImpl, log: quiet });
  const chunks = [];
  const r1 = await synth('First sentence.', { onChunk: (c) => chunks.push(c) });
  assert.equal(r1.ok, true);
  assert.equal(r1.chunks, 3, '70 kB of PCM in 32 kB chunks');
  const r2 = await synth('First sentence.', { onChunk: (c) => chunks.push(c) });
  assert.equal(r2.cached, true);
  assert.deepEqual(seen, ['generativelanguage.googleapis.com']);
  await synth('Mail jane.doe@example.com today.', { onChunk: () => {} });
  await synth('Back to plain words.', { onChunk: () => {} });
  assert.deepEqual(seen.slice(1), ['api.cartesia.ai', 'api.cartesia.ai'], 'sticky: one reply, one voice');
});

test('TTS cache: the operator and a guest never share an entry, whole clips or streamed sentences', async () => {
  const seen = [];
  const fetchImpl = async (u) => { seen.push(new URL(u).hostname); return u.includes('/tts/bytes') ? new Response(new Uint8Array([0xff, 0xfb, 1, 2])) : new Response(`data: ${JSON.stringify({ type: 'chunk', data: 'AAAA' })}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n`); };
  const env = { CARTESIA_API_KEY: 'cart', PG1_AI_CACHE: '1' };
  const speak = (identity, dataClass) => synthesizeSpeech({ env, text: 'Same words.', dataClass, identity, cartesia: { voiceId: 'v' }, fetchImpl, log: quiet });
  assert.equal((await speak(OP_ID, DATA.OPERATOR)).cached, false);
  assert.equal((await speak(GUEST_ID, DATA.CUSTOMER)).cached, false, 'the guest does not get the operator\'s clip');
  assert.equal((await speak(OP_ID, DATA.OPERATOR)).cached, true);
  assert.equal((await speak(GUEST_ID, DATA.CUSTOMER)).cached, true);
  assert.equal((await speak('', DATA.CUSTOMER)).cached, false, 'no identity, no cache');
  assert.equal((await speak('', DATA.CUSTOMER)).cached, false);
  assert.equal(seen.length, 4);

  seen.length = 0;
  ttsCache.clear();
  const op = createRoutedSynth({ env, voiceId: 'v', modelId: 'sonic-3.6', dataClass: DATA.OPERATOR, identity: OP_ID, fetchImpl, log: quiet });
  const guest = createRoutedSynth({ env, voiceId: 'v', modelId: 'sonic-3.6', dataClass: DATA.CUSTOMER, identity: GUEST_ID, fetchImpl, log: quiet });
  assert.notEqual((await op('One sentence.')).cached, true);
  assert.notEqual((await guest('One sentence.')).cached, true, 'the guest does not get the operator\'s audio');
  assert.equal((await op('One sentence.')).cached, true);
  assert.equal((await guest('One sentence.')).cached, true);
  assert.equal(seen.length, 2);
});

// --- 7. the chat end to end ---------------------------------------------------------------------------------

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.93.0.${++ipSeq}` }, body });
function makeRes() {
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {}
  };
}
async function chat(body) {
  const res = makeRes();
  await chatHandler(makeReq({ user: 'test-operator', pass: 'test-secret-pass', ...body }), res);
  return res;
}
// A guest (no credentials) from a fixed address, so its cache identity holds
// across requests.
async function guestChat(body, ip = '203.0.113.7') {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: ip }, body }, res);
  return res;
}

// Gemini and Anthropic stubs that note which key or provider each call used.
function installProviders({ gemini = () => 'From the main core.', anthropic = () => 'From the reasoning core.' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      calls.push({ provider: 'gemini', key: options.headers['x-goog-api-key'], body: JSON.parse(options.body) });
      const out = gemini(options.headers['x-goog-api-key']);
      if (out instanceof Response) return out;
      return u.includes(':streamGenerateContent')
        ? new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20 } })}\n\n`)
        : Response.json({ candidates: [{ content: { parts: [{ text: out }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20 } });
    }
    if (u.includes('api.anthropic.com')) {
      const body = JSON.parse(options.body);
      calls.push({ provider: 'anthropic', model: body.model, body });
      const out = anthropic(body);
      if (out instanceof Response) return out;
      return Response.json({ content: [{ type: 'text', text: out }], usage: { input_tokens: 1000, output_tokens: 50 } });
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}

test('chat: an operator message goes to the free key first; when it is out of quota the paid key answers', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  process.env.GEMINI_API_KEY_PAID = PAID;
  let calls = installProviders();
  let res = await chat({ prompt: 'good morning' });
  assert.match(res.jsonBody.reply, /From the main core/);
  assert.deepEqual([...new Set(calls.map((c) => c.key))], [FREE]);

  calls = installProviders({ gemini: (key) => (key === FREE ? new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', { status: 429 }) : 'Paid answer.') });
  res = await chat({ prompt: 'good evening' });
  assert.match(res.jsonBody.reply, /Paid answer/);
  assert.equal(calls[0].key, FREE);
  assert.equal(calls.at(-1).key, PAID);
});

test('chat privacy: an operator threat check (tools route) still uses the free key; the tool descriptions are not customer data', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  process.env.GEMINI_API_KEY_PAID = PAID;
  const calls = installProviders();
  await chat({ prompt: 'check this wallet 0x7067312d00000000000000000000000000000000' });
  assert.ok(calls.length > 0);
  assert.ok(calls[0].body.tools, 'the round carried the functions');
  assert.equal(calls[0].key, FREE);
});

test('chat privacy: a message with customer data never reaches the free key', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  process.env.GEMINI_API_KEY_PAID = PAID;
  for (const stream of [false, true]) {
    __resetRouterState();
    const calls = installProviders();
    const res = await chat({ prompt: 'draft a reply to customer jane.doe@example.com about her invoice', ...(stream ? { stream: true } : {}) });
    assert.equal(res.statusCode, 200);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => c.key !== FREE), `${stream ? 'streamed' : 'JSON'}: only the paid key`);
  }
});

test('chat privacy: with only the free key configured, customer data gets no Gemini call at all', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  const calls = installProviders();
  const res = await chat({ prompt: 'what did +44 7700 900123 order?' });
  assert.equal(calls.length, 0);
  assert.match(res.jsonBody.reply, /could not be generated|Request ID/i, 'a neutral failure, no provider named');
});

test('chat privacy: a guest session never reaches a model on /api/chat (JSON and streamed), so never the free key', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  process.env.GEMINI_API_KEY_PAID = PAID;
  for (const body of [{ prompt: 'good morning' }, { prompt: 'good morning', stream: true }, { prompt: 'good morning', user: 'test-operator', pass: 'wrong-pass' }]) {
    __clearAuthRateLimitState();
    const calls = installProviders();
    const res = await guestChat(body);
    assert.equal(res.statusCode, 401, JSON.stringify(body));
    assert.equal(calls.length, 0, `${JSON.stringify(body)}: no provider call`);
  }
});

test('chat privacy: a guest round is planned on paid providers only, whatever it says, with or without tools', () => {
  const env = { GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC, OPENAI_API_KEY: 'sk-stub' };
  const prompts = ['good morning', 'what is a honeypot?', 'summarize this', 'check this wallet 0x7067312d00000000000000000000000000000000'];
  for (const isOperator of [false, undefined, 'true', 1]) {
    for (const activeAction of ['CHAT', 'CLAUDE_CHAT']) {
      for (const promptText of prompts) {
        for (const toolOpts of [null, { tools: [{ name: 'check_wallet' }] }]) {
          const route = __chatRoundPlan({ env, isOperator, activeAction, promptText, sysInstruction: 'sys', contextText: '' }, toolOpts);
          assert.equal(route.dataClass, DATA.CUSTOMER, `isOperator=${JSON.stringify(isOperator)} "${promptText}"`);
          assert.ok(route.plan.length > 0);
          assert.ok(route.plan.every((c) => c.key !== FREE && c.provider !== 'gemini_free'), `isOperator=${JSON.stringify(isOperator)} ${activeAction} "${promptText}": paid only`);
        }
      }
    }
  }
  // The same plain message from the operator does get the free key first.
  const op = __chatRoundPlan({ env, isOperator: true, activeAction: 'CHAT', promptText: 'good morning', sysInstruction: 'sys', contextText: '' }, null);
  assert.equal(op.plan[0].key, FREE);
});

test('chat: /core goes to the strongest reasoning model; a heavy security question too; a summary stays light', async () => {
  process.env.GEMINI_API_KEY_PAID = PAID;
  process.env.ANTHROPIC_API_KEY = ANTHROPIC;
  let calls = installProviders();
  await chat({ prompt: '/core plan the incident response' });
  assert.equal(calls[0].provider, 'anthropic');
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.equal(calls[0].body.max_tokens, 16000, 'room for always-on thinking');

  calls = installProviders();
  await chat({ prompt: 'is this phishing kit an exploit risk for us?' });
  assert.equal(calls[0].provider, 'anthropic');

  calls = installProviders();
  await chat({ prompt: 'summarize this report: ' + 'it was a quiet week. '.repeat(30) });
  assert.equal(calls[0].provider, 'gemini', 'a long summary is no longer sent to the reasoning core');
});

test('chat streamed: the reasoning core failing falls back to the main core, and the trace names cores, never providers', async () => {
  process.env.GEMINI_API_KEY_PAID = PAID;
  process.env.ANTHROPIC_API_KEY = ANTHROPIC;
  installProviders({ anthropic: () => new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 529 }) });
  const res = await chat({ prompt: '/core review this design', stream: true });
  const body = res.chunks.join('');
  assert.match(body, /From the main core/);
  assert.match(body, /Reasoning core unavailable/);
  assert.match(body, /switching to the main core/);
  assert.doesNotMatch(body.replace(/From the main core\./g, ''), /gemini|anthropic|claude|google/i);
});

test('chat: an identical request inside the TTL is answered from the text cache', async () => {
  process.env.GEMINI_API_KEY_PAID = PAID;
  textCache.clear();
  let calls = installProviders();
  const first = await chat({ prompt: 'what is a honeypot?' });
  const n = calls.length;
  assert.ok(n > 0);
  calls = installProviders();
  const second = await chat({ prompt: 'what is a honeypot?' });
  assert.equal(second.jsonBody.reply, first.jsonBody.reply);
  assert.equal(calls.length, 0, 'served from the cache');
});

test('chat cache: the operator and a guest sending the identical message never share a cache entry', async () => {
  process.env.GEMINI_API_KEY_PAID = PAID;
  const env = { ...process.env, PG1_AI_CACHE: '1' };
  const base = { env, activeAction: 'CHAT', promptText: 'what is a honeypot?', sysInstruction: 'sys', contextText: '' };
  const opRoute = __chatRoundPlan({ ...base, isOperator: true, cacheIdentity: OP_ID }, null);
  const guestRoute = __chatRoundPlan({ ...base, isOperator: false, cacheIdentity: GUEST_ID }, null);
  const otherGuest = __chatRoundPlan({ ...base, isOperator: false, cacheIdentity: cacheIdentity({ clientId: '203.0.113.99' }) }, null);
  assert.ok(opRoute.cacheKey && guestRoute.cacheKey && otherGuest.cacheKey);
  assert.equal(new Set([opRoute.cacheKey, guestRoute.cacheKey, otherGuest.cacheKey]).size, 3, 'one entry per user');
  assert.equal(__chatRoundPlan({ ...base, isOperator: false }, null).cacheKey, null, 'no identity: not cached');

  // End to end: the operator's reply is cached under the operator's key
  // only; the guest's key for the identical message finds nothing.
  textCache.clear();
  let calls = installProviders({ gemini: () => 'Operator answer.' });
  const first = await chat({ prompt: 'what is a honeypot?' });
  assert.match(first.jsonBody.reply, /Operator answer/);
  assert.equal(textCache.size, 1);
  const n = calls.length;
  calls = installProviders();
  const second = await chat({ prompt: 'what is a honeypot?' });
  assert.equal(second.jsonBody.reply, first.jsonBody.reply);
  assert.equal(calls.length, 0, 'the operator is served the operator\'s entry');
  assert.ok(n > 0);
  // The identical request (same system prompt, same message) stored under
  // the operator's key is never found under a guest's.
  textCache.clear();
  textCache.set(opRoute.cacheKey, { text: 'Operator only.', provider: 'gemini_paid', family: 'gemini', model: 'm' });
  assert.equal(textCache.get(opRoute.cacheKey).text, 'Operator only.');
  assert.equal(textCache.get(guestRoute.cacheKey), undefined);
  assert.equal(textCache.get(otherGuest.cacheKey), undefined);
});

test('chat: a provider over its daily budget is skipped', async () => {
  process.env.GEMINI_API_KEY_PAID = PAID;
  process.env.ANTHROPIC_API_KEY = ANTHROPIC;
  process.env.PG1_DAILY_BUDGET_ANTHROPIC_USD = '0';
  const calls = installProviders();
  const res = await chat({ prompt: '/core plan the incident response' });
  assert.match(res.jsonBody.reply, /From the main core/);
  assert.ok(calls.every((c) => c.provider === 'gemini'));
});

test('/spend: operator only, PG1 labels only', async () => {
  process.env.GEMINI_API_KEY_PAID = PAID;
  installProviders();
  await chat({ prompt: 'hello router' });
  const res = await chat({ prompt: '/spend' });
  assert.match(res.jsonBody.reply, /AI SPEND/);
  assert.match(res.jsonBody.reply, /PG1 main core\*\*: \$0\.\d+ over 1 calls/);
  assert.doesNotMatch(res.jsonBody.reply, /gemini|google|anthropic/i);
  const guest = makeRes();
  await chatHandler(makeReq({ prompt: '/spend' }), guest);
  assert.equal(guest.statusCode, 401);
});

test('heartbeat: the first pulse after 00:00 UTC logs yesterday\'s spend summary; other hours log nothing', async () => {
  const { logDailySpend } = await import('../api/heartbeat/pulse.js');
  const lines = [];
  const yesterdayNoon = Date.UTC(2026, 9, 8, 12, 0, 0);
  recordUsage({ provider: 'anthropic', model: 'claude-opus-5-5', task: TASKS.HEAVY, inputTokens: 1e5, outputTokens: 1e4 }, { log: quiet, now: yesterdayNoon });
  assert.equal(await logDailySpend(Date.UTC(2026, 9, 9, 13, 0, 0), (l) => lines.push(l)), null);
  const summary = await logDailySpend(Date.UTC(2026, 9, 9, 0, 0, 30), (l) => lines.push(l));
  assert.match(summary, /AI SPEND · 2026-10-08 UTC/);
  assert.match(summary, /PG1 reasoning core\*\*: \$0\.6000 over 1 calls/);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[PG1-AGENT:SPEND\] /);
});
