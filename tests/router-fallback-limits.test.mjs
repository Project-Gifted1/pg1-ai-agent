/**
 * Router fallback limits (lib/aiRouter.mjs, lib/router/freeLimiter.mjs,
 * lib/router/alerts.mjs, api/chat.mjs):
 *   - a 429 is waited out (Retry-After, Gemini's retryDelay, else 2 s, 5 s,
 *     10 s), at most 20 s for chat and 2 minutes for background jobs, then
 *     the call falls through to the next engine;
 *   - a 402 and an Anthropic 400 credit error fall through at once;
 *   - with checks on, the heavy chain keeps the OpenAI-compatible backups
 *     (tools off) after the engines that can run them, and the reply says
 *     live search was unavailable, naming no provider;
 *   - the free key's per-minute limiter queues bursts, chat ahead of
 *     background work, shared through pg1_rate_take;
 *   - the free key never gets client work or customer data;
 *   - every engine out: one operator push per hour naming the accounts.
 *
 * Run with: node --test tests/router-fallback-limits.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  TASKS, DATA, planRoute, runRoute, withThrottleRetry, isThrottle, textThrottleWaitMs, retryAfterMs, failureClass, FAILURE,
  CHAT_THROTTLE, BACKGROUND_THROTTLE, NO_THROTTLE_WAIT, __resetRouterState
} from '../lib/aiRouter.mjs';
import { createFreeLimiter, createLocalWindows, freeLimits, freeLimiterFor, freeLimiterEnabled, PRIORITY, WINDOW_MS, __resetFreeLimiters } from '../lib/router/freeLimiter.mjs';
import { allOutText, accountState, createAllOutAlert, __resetAlerts } from '../lib/router/alerts.mjs';
import { makeDb, pgRest } from './helpers/pgrest.mjs';
import chatHandler, { __clearAuthRateLimitState, __chatRoundPlan, TOOLS_OFF_NOTE } from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const FREE = 'AIzaStub-free-key-limits-0123456789';
const PAID = 'AQ.Stub-paid-key-limits-0123456789';
const ANTHROPIC = 'sk-ant-stub-limits-0123456789abcdef';
const GATEWAY = 'vck_stub_gateway_limits_0123456789';
const quiet = () => {};
const PROVIDER_NAMES = /gemini|google|anthropic|claude|openai|gpt|openrouter|gateway|vercel/i;

const ANTHROPIC_CREDIT = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } });
const GEMINI_402 = JSON.stringify({ error: { code: 402, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted.' } });
const GEMINI_429 = (secs = 3) => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `You exceeded your current quota. Please retry in ${secs}s.`, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${secs}s` }] } });

const ROUTER_ENV = ['GEMINI_API_KEY_FREE', 'GEMINI_API_KEY_PAID', 'GEMINI_API_KEY', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'ANTHROPIC_API_KEY',
  'ANTROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPEN_ROUTER_KEY', 'VERCEL_AI_API_KEY', 'AI_GATEWAY_API_KEY', 'REPLICATE_API_TOKEN',
  'REPLICATE_KEY', 'CARTESIA_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASEAPI_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'PG1_FREE_LIMITER'];

beforeEach(() => {
  __resetRouterState();
  __resetFreeLimiters();
  __resetAlerts();
  __clearAuthRateLimitState();
  for (const k of ROUTER_ENV) delete process.env[k];
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

// --- 1. rate limits: wait, then fall through -----------------------------------

test('a 429 is a throttle; a 402, a credit error or a daily quota is not', () => {
  assert.equal(isThrottle(429, GEMINI_429()), true);
  assert.equal(isThrottle(429, 'Too Many Requests'), true);
  assert.equal(isThrottle(402, GEMINI_402), false);
  assert.equal(isThrottle(429, 'insufficient_quota: You exceeded your current quota, please check your plan and billing details.'), false, 'OpenAI out of credit');
  assert.equal(isThrottle(429, 'Quota exceeded for metric generate_content_free_tier_requests per day'), false, 'a day\'s quota is not waited for');
  assert.equal(isThrottle(400, ANTHROPIC_CREDIT), false);
});

test('the wait is the engine\'s own (Retry-After, retryDelay, "retry in"), else 2 s, then 3 s for chat', () => {
  assert.equal(retryAfterMs({ text: GEMINI_429(7) }), 7000, 'Gemini RetryInfo');
  assert.equal(retryAfterMs({ headers: { 'retry-after': '4' } }), 4000, 'Retry-After header');
  assert.deepEqual([1, 2, 3, 4].map((n) => textThrottleWaitMs(n, null, CHAT_THROTTLE)), [2000, 3000, 3000, 3000]);
  assert.deepEqual([1, 2, 3, 4].map((n) => textThrottleWaitMs(n, null, BACKGROUND_THROTTLE)), [2000, 5000, 10000, 10000]);
  assert.equal(textThrottleWaitMs(1, 3000, CHAT_THROTTLE), 3000);
});

test('429 then success: the same engine is asked again after the wait', async () => {
  const waits = [];
  let n = 0;
  const out = await withThrottleRetry(async () => (++n === 1 ? { ok: false, status: 429, detail: 'Too Many Requests' } : { ok: true, value: 'answer' }), { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(out.result.ok, true);
  assert.equal(n, 2);
  assert.deepEqual(waits, [2000]);
});

test('429 exhausted: at most 5 s of waiting for chat, then the call falls through', async () => {
  const waits = [];
  const out = await withThrottleRetry(async () => ({ ok: false, status: 429, detail: 'Too Many Requests' }), { policy: CHAT_THROTTLE, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(out.result.status, 429);
  assert.deepEqual(waits, [2000, 3000], '5 s waited; another 3 s would pass the 5 s cap');
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 5000);
  const hinted = [];
  await withThrottleRetry(async () => ({ ok: false, status: 429, detail: GEMINI_429(6) }), { policy: CHAT_THROTTLE, sleep: async (ms) => { hinted.push(ms); } });
  assert.deepEqual(hinted, [], 'a 6 s retry hint is over chat\'s 5 s: no wait at all');
});

test('background jobs wait up to 2 minutes; an engine asking for longer than the cap is not waited for', async () => {
  const waits = [];
  await withThrottleRetry(async () => ({ ok: false, status: 429, detail: 'Too Many Requests' }), { policy: BACKGROUND_THROTTLE, sleep: async (ms) => { waits.push(ms); } });
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total > 20000 && total <= 120000, `background waited ${total} ms`);
  const long = [];
  await withThrottleRetry(async () => ({ ok: false, status: 429, detail: GEMINI_429(45) }), { policy: CHAT_THROTTLE, sleep: async (ms) => { long.push(ms); } });
  assert.deepEqual(long, [], 'a 45 s hint is over the chat cap: straight to the next engine');
  const none = [];
  await withThrottleRetry(async () => ({ ok: false, status: 429, detail: 'Too Many Requests' }), { policy: NO_THROTTLE_WAIT, sleep: async (ms) => { none.push(ms); } });
  assert.deepEqual(none, [], 'speech never waits');
});

test('the wait never runs past the caller\'s deadline', async () => {
  const waits = [];
  const t0 = 1_000_000;
  await withThrottleRetry(async () => ({ ok: false, status: 429, detail: 'Too Many Requests' }), { deadlineTs: t0 + 5500, reserveMs: 3000, now: () => t0, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [2000], 'a 3 s wait would leave less than the reserve');
});

test('runRoute: 429 retried then answered; 429 exhausted falls through; 402 and a 400 credit error fall through at once', async () => {
  const env = { GEMINI_API_KEY_FREE: FREE, PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };

  let tried = [];
  let freeCalls = 0;
  let r = await runRoute({
    task: TASKS.LIGHT, env, dataClass: DATA.OPERATOR, log: quiet, sleep,
    attempt: async (c) => { tried.push(c.provider); if (c.provider === 'gemini_free' && ++freeCalls === 1) return { ok: false, status: 429, detail: GEMINI_429(3) }; return { ok: true, value: c.provider, model: c.models[0] }; }
  });
  assert.equal(r.value, 'gemini_free', 'the free key answered after the 3 s it asked for');
  assert.deepEqual(sleeps, [3000]);

  __resetRouterState();
  tried = []; sleeps.length = 0;
  r = await runRoute({
    task: TASKS.LIGHT, env, dataClass: DATA.OPERATOR, log: quiet, sleep,
    attempt: async (c) => { tried.push(c.provider); if (c.provider === 'gemini_free') return { ok: false, status: 429, detail: 'Too Many Requests' }; if (c.provider === 'gemini_paid') return { ok: false, status: 402, detail: GEMINI_402 }; if (c.provider === 'anthropic') return { ok: false, status: 400, detail: ANTHROPIC_CREDIT }; return { ok: true, value: 'x' }; }
  });
  assert.equal(r.ok, false);
  assert.deepEqual(tried, ['gemini_free', 'gemini_free', 'gemini_free', 'gemini_paid', 'anthropic'], 'the free key three times (two waits within 5 s), the 402 and the credit error once each');
  assert.deepEqual(sleeps, [2000, 3000]);
  assert.equal(failureClass({ status: 402, text: GEMINI_402 }), FAILURE.CAPACITY);
  assert.equal(failureClass({ status: 400, text: ANTHROPIC_CREDIT }), FAILURE.CAPACITY);
});

// --- 2. the heavy chain keeps its tools-off backups ----------------------------------

test('with checks on, the OpenAI-compatible backups stay (tools off) after every engine that can run them; with an image they are left out', () => {
  const env = { GEMINI_API_KEY_FREE: FREE, PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC, VERCEL_AI_API_KEY: GATEWAY, OPENROUTER_API_KEY: 'sk-or-stub', OPENAI_API_KEY: 'sk-stub' };
  // Routing policy: operator content tries the free key first.
  const heavy = planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR, withTools: true });
  assert.deepEqual(heavy.map((c) => c.provider), ['gemini_free', 'anthropic', 'gemini_paid', 'openrouter', 'gateway', 'openai']);
  assert.deepEqual(heavy.filter((c) => c.toolsOff).map((c) => c.provider), ['openrouter', 'gateway', 'openai']);
  const media = planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR, withTools: true, withMedia: true });
  assert.deepEqual(media.map((c) => c.provider), ['gemini_free', 'anthropic', 'gemini_paid']);
  // The chat's own plan for a tools round, heavy (/core).
  const route = __chatRoundPlan({ env, isOperator: true, activeAction: 'CLAUDE_CHAT', promptText: 'check this domain' }, { tools: [{ name: 'check_domain_age' }], turns: [] });
  assert.deepEqual(route.plan.map((c) => c.provider), ['gemini_free', 'anthropic', 'gemini_paid', 'openrouter', 'gateway', 'openai']);
  // A free tools-off engine goes before the paid engines, unless the round
  // must run a check (a forced tool): then it cannot fit the round.
  const withGroq = { ...env, GROQ_API_KEY: 'gsk_stub' };
  assert.deepEqual(planRoute(TASKS.HEAVY, { env: withGroq, dataClass: DATA.OPERATOR, withTools: true }).map((c) => c.provider), ['gemini_free', 'groq', 'anthropic', 'gemini_paid', 'openrouter', 'gateway', 'openai']);
  assert.deepEqual(planRoute(TASKS.HEAVY, { env: withGroq, dataClass: DATA.OPERATOR, withTools: true, requiresTool: true }).map((c) => c.provider), ['gemini_free', 'anthropic', 'gemini_paid', 'groq', 'openrouter', 'gateway', 'openai']);
});

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.94.0.${++ipSeq}` }, body });
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

// Anthropic out of credit, paid Gemini 402, free Gemini rate limited; the
// gateway answers (or not).
function installEngines({ gateway = () => Response.json({ choices: [{ message: { content: 'Backup answer.' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) { calls.push('anthropic'); return new Response(ANTHROPIC_CREDIT, { status: 400 }); }
    if (u.includes('generativelanguage.googleapis.com')) {
      const key = options.headers['x-goog-api-key'];
      calls.push(key === FREE ? 'gemini_free' : 'gemini_paid');
      return key === FREE ? new Response(GEMINI_429(1), { status: 429 }) : new Response(GEMINI_402, { status: 402 });
    }
    if (u.includes('ai-gateway.vercel.sh')) { calls.push('gateway'); return gateway(JSON.parse(options.body)); }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}

test('heavy chat with checks: past the free key\'s 429 to the tools-off backup; no live-search footer on a tools-route reply, no provider name (JSON and streamed)', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  process.env.GEMINI_API_KEY_PAID = PAID;
  process.env.ANTHROPIC_API_KEY = ANTHROPIC;
  process.env.VERCEL_AI_API_KEY = GATEWAY;
  assert.doesNotMatch(TOOLS_OFF_NOTE, PROVIDER_NAMES);
  for (const stream of [false, true]) {
    __resetRouterState();
    const calls = installEngines();
    const res = await chat({ prompt: '/core is evil-example.invalid malicious?', ...(stream ? { stream: true } : {}) });
    const body = stream ? res.chunks.join('') : res.jsonBody.reply;
    assert.match(body, /Backup answer\./, stream ? 'streamed' : 'JSON');
    assert.ok(!body.includes('Live search was unavailable'), 'the footer is for search-route replies only');
    assert.ok(calls.includes('gateway'), 'the backup was reached');
    assert.ok(calls.indexOf('gateway') > calls.lastIndexOf('gemini_free'), 'after the free key');
    assert.ok(calls.filter((c) => c === 'gemini_free').length >= 2, 'the free key was asked again after its 429');
    assert.doesNotMatch(body.replace(/Backup answer\./g, ''), /credit balance|RESOURCE_EXHAUSTED|anthropic|claude|gemini|openai|gateway/i);
  }
});

test('search route, free key rate limited: at most ~5 s of waiting, then the backup answers with the footer exactly once (JSON and streamed)', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  process.env.VERCEL_AI_API_KEY = GATEWAY;
  for (const stream of [false, true]) {
    __resetRouterState();
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) { calls.push('gemini_free'); return new Response(GEMINI_429(30), { status: 429 }); }
      if (u.includes('ai-gateway.vercel.sh')) { calls.push('gateway'); return Response.json({ choices: [{ message: { content: 'Backup answer.' } }] }); }
      throw new Error('Unexpected network call in test: ' + u);
    };
    const res = await chat({ prompt: 'latest news on EIP-7702', ...(stream ? { stream: true } : {}) });
    const body = stream ? res.chunks.join('') : res.jsonBody.reply;
    assert.match(body, /Backup answer\./);
    assert.equal(body.split('Live search was unavailable for this answer.').length - 1, 1, 'the footer once');
    // A 30 s retry hint is longer than the search route's 5 s cap: no wait,
    // straight to the backup (one ask per Gemini model, no wait-and-retry).
    assert.ok(calls.filter((c) => c === 'gemini_free').length <= 2, 'no retry after the wait');
  }
});

test('plain chat (small talk): no search request and never the footer, even from a backup engine', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  process.env.VERCEL_AI_API_KEY = GATEWAY;
  for (const stream of [false, true]) {
    __resetRouterState();
    const bodies = [];
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) { bodies.push(JSON.parse(options.body)); return new Response(GEMINI_429(30), { status: 429 }); }
      if (u.includes('ai-gateway.vercel.sh')) return Response.json({ choices: [{ message: { content: 'Hi! All good here.' } }] });
      throw new Error('Unexpected network call in test: ' + u);
    };
    const res = await chat({ prompt: 'hello, how are you today?', ...(stream ? { stream: true } : {}) });
    const body = stream ? res.chunks.join('') : res.jsonBody.reply;
    assert.match(body, /All good here/);
    assert.ok(!body.includes('Live search was unavailable'), 'no footer on a chat-route reply');
    assert.ok(bodies.length >= 1 && bodies.every((b) => b.tools === undefined), 'no search asked for');
  }
});

// --- 3. the free key's per-minute limiter ------------------------------------------------

test('the limiter queues a burst into the next minute instead of failing, chat ahead of background', async () => {
  let t = 10 * WINDOW_MS + 5000;
  const sleeps = [];
  const limiter = createFreeLimiter({ env: { PG1_GEMINI_FREE_RPM: '3', PG1_GEMINI_FREE_CHAT_RESERVE: '1', PG1_FREE_BACKGROUND_SHARE: '1' }, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  assert.deepEqual(freeLimits({ PG1_GEMINI_FREE_RPM: '3', PG1_GEMINI_FREE_CHAT_RESERVE: '1' }), { rpm: 3, reserve: 1 });
  // Background may take 2 of the minute's 3 slots; the third is chat's.
  assert.equal((await limiter.acquire({ priority: PRIORITY.BACKGROUND, maxWaitMs: 0 })).granted, true);
  assert.equal((await limiter.acquire({ priority: PRIORITY.BACKGROUND, maxWaitMs: 0 })).granted, true);
  assert.equal((await limiter.acquire({ priority: PRIORITY.BACKGROUND, maxWaitMs: 0 })).granted, false, 'background stops at rpm - reserve');
  assert.equal((await limiter.acquire({ priority: PRIORITY.CHAT, maxWaitMs: 0 })).granted, true, 'chat still gets the reserved slot');
  // A chat burst now waits for the next minute rather than failing.
  const queued = await limiter.acquire({ priority: PRIORITY.CHAT, maxWaitMs: 60000 });
  assert.equal(queued.granted, true);
  assert.equal(queued.waitedMs, 55000, 'waited for the next minute');
  // While chat is active on the engine, background work yields at once;
  // once chat has been quiet for two minutes, a waiting background caller
  // still lets chat in first when the minute turns.
  t = 20 * WINDOW_MS + 50000;
  const bgSleeps = [];
  const two = createFreeLimiter({ env: { PG1_GEMINI_FREE_RPM: '2', PG1_GEMINI_FREE_CHAT_RESERVE: '0', PG1_FREE_BACKGROUND_SHARE: '1' }, now: () => t, sleep: async (ms) => { bgSleeps.push(ms); t += ms; } });
  await two.acquire({ priority: PRIORITY.CHAT, maxWaitMs: 0 });
  await two.acquire({ priority: PRIORITY.CHAT, maxWaitMs: 0 });
  assert.deepEqual(await two.acquire({ priority: PRIORITY.BACKGROUND, maxWaitMs: 120000 }), { granted: false, waitedMs: 0, reason: 'chat_active' });
  t = 30 * WINDOW_MS + 50000;
  const three = createFreeLimiter({ env: { PG1_GEMINI_FREE_RPM: '1', PG1_GEMINI_FREE_CHAT_RESERVE: '0', PG1_FREE_BACKGROUND_SHARE: '1' }, now: () => t, sleep: async (ms) => { bgSleeps.push(ms); t += ms; } });
  assert.equal((await three.acquire({ priority: PRIORITY.BACKGROUND, maxWaitMs: 0 })).granted, true);
  const bg = await three.acquire({ priority: PRIORITY.BACKGROUND, maxWaitMs: 120000 });
  assert.equal(bg.granted, true);
  assert.deepEqual(bgSleeps, [10000 + 1500], 'the rest of the minute plus a head start for chat');
});

test('the limiter is shared through pg1_rate_take (the real migration on Postgres): two instances share one minute', async () => {
  const db = await makeDb(['20261102120000_pg1_rate_windows.sql']);
  const rest = pgRest(db);
  const a = createFreeLimiter({ env: { PG1_GEMINI_FREE_RPM: '2', PG1_GEMINI_FREE_CHAT_RESERVE: '0' }, supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: rest });
  const b = createFreeLimiter({ env: { PG1_GEMINI_FREE_RPM: '2', PG1_GEMINI_FREE_CHAT_RESERVE: '0' }, supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: rest });
  assert.equal((await a.acquire({ maxWaitMs: 0 })).granted, true);
  assert.equal((await b.acquire({ maxWaitMs: 0 })).granted, true);
  const third = await a.acquire({ maxWaitMs: 0 });
  assert.equal(third.granted, false, 'the minute\'s two slots are taken across both instances');
  const { rows } = await db.query("select key, used from public.pg1_rate_windows");
  assert.deepEqual(rows.map((r) => [r.key, Number(r.used)]), [['gemini_free', 2]]);
  const res = await rest('https://supabase.test/rest/v1/rpc/pg1_rate_take', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_key: 'gemini_free', p_cap: 2, p_window_s: 60 }) });
  const out = await res.json();
  const row = Array.isArray(out) ? out[0] : out;
  assert.equal(row.granted, false);
  assert.ok(row.retry_ms > 0 && row.retry_ms <= 60000, 'says how long until the next minute');
});

test('the limiter in the chat: a burst over the free key\'s minute waits instead of failing (turned on for the test)', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  process.env.PG1_FREE_LIMITER = '1';
  process.env.PG1_GEMINI_FREE_RPM = '50';
  assert.equal(freeLimiterEnabled(process.env), true);
  let n = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('generativelanguage')) { n++; return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }); }
    throw new Error('Unexpected network call in test: ' + url);
  };
  const res = await chat({ prompt: 'good morning' });
  assert.match(res.jsonBody.reply, /ok/);
  assert.equal(n, 1);
  delete process.env.PG1_GEMINI_FREE_RPM;
  assert.equal(freeLimiterEnabled({}), false, 'off under the test runner unless asked for');
  assert.equal((await freeLimiterFor({ env: {} }).acquire({})).granted, true);
});

// --- 4. the free key never gets client work or customer data ----------------------------------

test('the free key is operator data only: never customer data, never client work, in any task', () => {
  const env = { GEMINI_API_KEY_FREE: FREE, PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC, VERCEL_AI_API_KEY: GATEWAY };
  for (const task of Object.values(TASKS)) {
    for (const opts of [{ dataClass: DATA.CUSTOMER }, { dataClass: DATA.OPERATOR, clientWork: true }, { dataClass: DATA.CUSTOMER, withTools: true }, { dataClass: DATA.CUSTOMER, withMedia: true }]) {
      const plan = planRoute(task, { env, ...opts });
      assert.ok(!plan.some((c) => c.provider === 'gemini_free' || c.key === FREE), `${task} ${JSON.stringify(opts)}`);
    }
  }
  assert.ok(planRoute(TASKS.LIGHT, { env, dataClass: DATA.OPERATOR }).some((c) => c.provider === 'gemini_free'), 'the operator\'s own content may use it');
  const guest = __chatRoundPlan({ env, isOperator: false, promptText: 'hello' }, null);
  assert.ok(!guest.plan.some((c) => c.provider === 'gemini_free'));
});

// --- 5. every engine out: one push per hour --------------------------------------------------

test('every engine out: the operator gets one push per hour naming each AI account and why', async () => {
  const pushes = [];
  let t = Date.parse('2026-10-17T08:45:00Z');
  const alert = createAllOutAlert({ env: { VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k' }, store: {}, now: () => t, push: async (m) => { pushes.push(m); return 1; } });
  const failures = [
    { provider: 'anthropic', status: 400, detail: 'Your credit balance is too low to access the Anthropic API.' },
    { provider: 'gemini_paid', status: 402, detail: GEMINI_402 },
    { provider: 'gemini_free', status: 429, detail: GEMINI_429(3) },
    { provider: 'gemini_free', status: 429, detail: 'again' }
  ];
  assert.equal((await alert(failures)).sent, 1);
  assert.equal((await alert(failures)).claimed, false, 'not again within the hour');
  t += 61 * 60 * 1000;
  assert.equal((await alert(failures)).sent, 1, 'again after the hour');
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].body, 'No AI engine could answer. Anthropic (Claude): out of credit (400); Gemini (paid key): out of credit (402); Gemini (free key): rate-limited (429).');
  assert.equal(accountState({ status: 401 }), 'key invalid');
  assert.equal(accountState({ status: null }), 'timed out');
  assert.match(allOutText([]).body, /No AI engine is configured/);
});

test('runRoute calls onAllOut only when every engine failed on capacity, not on a refusal', async () => {
  const env = { PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC };
  const seen = [];
  await runRoute({ task: TASKS.LIGHT, env, dataClass: DATA.CUSTOMER, log: quiet, sleep: async () => {}, onAllOut: (f) => seen.push(f.map((x) => x.provider)), attempt: async (c) => ({ ok: false, status: c.provider === 'anthropic' ? 400 : 402, detail: c.provider === 'anthropic' ? ANTHROPIC_CREDIT : GEMINI_402 }) });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [['gemini_paid', 'anthropic']]);
  seen.length = 0;
  __resetRouterState();
  await runRoute({ task: TASKS.LIGHT, env, dataClass: DATA.CUSTOMER, log: quiet, onAllOut: (f) => seen.push(f), attempt: async () => ({ ok: false, status: 400, detail: 'blocked by safety', refused: true }) });
  assert.deepEqual(seen, []);
});
