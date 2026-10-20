/**
 * Step 3: /keys (lib/keysStatus.mjs), the no-card free engines (Groq,
 * Mistral, GitHub Models, Cloudflare Workers AI), the OpenRouter balance
 * guard (lib/router/openrouterGuard.mjs) and streamed OpenAI-compatible
 * calls with a first-token timeout (lib/aiRouter.mjs callOpenAiCompat).
 *
 * Run with: node --test tests/keys-and-free-engines.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  TASKS, DATA, planRoute, runRoute, callOpenAiCompat, __resetRouterState, setOpenRouterState, FREE_COMPAT_PROVIDERS, OPENAI_COMPAT_URLS
} from '../lib/aiRouter.mjs';
import { keysStatus, handleKeysCommand, stateFor, STATES, __resetKeysCache, KEYS_CACHE_MS } from '../lib/keysStatus.mjs';
import { ensureOpenRouterState, readOpenRouter, __resetOpenRouterGuard, GUARD_TTL_MS } from '../lib/router/openrouterGuard.mjs';
import { createFreeLimiter, freeLimits, ENGINE_RPM, PRIORITY } from '../lib/router/freeLimiter.mjs';
import { __resetAlerts } from '../lib/router/alerts.mjs';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const KEYS = {
  PG1_DAILY_SPEND_CAP_USD: '1000', ANTHROPIC_API_KEY: 'sk-ant-keys-SECRET-0123456789', GEMINI_API_KEY_PAID: 'AQ.keys-paid-SECRET-0123456789', GEMINI_API_KEY_FREE: 'AIza-keys-free-SECRET-0123',
  OPENROUTER_API_KEY: 'sk-or-keys-SECRET-0123456789', VERCEL_AI_API_KEY: 'vck-keys-SECRET-0123456789', OPENAI_API_KEY: 'sk-proj-keys-SECRET-0123456789',
  GROQ_API_KEY: 'gsk_keys_SECRET_0123456789', MISTRAL_API_KEY: 'mistral-keys-SECRET-0123456789', GITHUB_MODELS_TOKEN: 'github_pat_keys_SECRET_0123456789',
  CLOUDFLARE_AI_TOKEN: 'cf-keys-SECRET-0123456789', CLOUDFLARE_ACCOUNT_ID: 'f4ca340d9bcbeeab89bba95915dd072e',
  ELEVENLABS_API_KEY: 'sk_el_keys_SECRET_0123456789', CARTESIA_API_KEY: 'sk_car_keys_SECRET_0123456789', REPLICATE_API_TOKEN: 'r8_keys_SECRET_0123456789'
};
const SECRET_VALUES = Object.entries(KEYS).filter(([k]) => k !== 'CLOUDFLARE_ACCOUNT_ID').map(([, v]) => v);
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

beforeEach(() => {
  __resetRouterState();
  __resetKeysCache();
  __resetOpenRouterGuard();
  __resetAlerts();
  __clearAuthRateLimitState();
  for (const k of [...Object.keys(KEYS), 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASEAPI_KEY', 'PG1_OPENROUTER_GUARD']) delete process.env[k];
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; setOpenRouterState(null); });

// One answer per engine check.
function keyChecks(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    calls.push(u);
    for (const [part, fn] of Object.entries(overrides)) if (u.includes(part)) return fn(u, options);
    if (u.includes('api.anthropic.com')) return json({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 400);
    if (u.includes('generativelanguage')) return options.headers['x-goog-api-key'] === KEYS.GEMINI_API_KEY_FREE ? json({ error: { code: 429, message: 'Please retry in 20s.' } }, 429) : json({ error: { code: 402, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted.' } }, 402);
    if (u.endsWith('/api/v1/key')) return json({ data: { usage: 0.03, usage_daily: 0, is_free_tier: true, limit_remaining: null } });
    if (u.endsWith('/api/v1/credits')) return json({ data: { total_credits: 0, total_usage: 0.03 } });
    if (u.includes('ai-gateway.vercel.sh/v1/credits')) return json({ balance: '0.00', total_used: '4.10' });
    if (u.includes('api.openai.com')) return json({ error: { message: 'Incorrect API key provided' } }, 401);
    if (u.includes('elevenlabs')) return json({ character_count: 1200, character_limit: 100000, tier: 'creator' });
    if (u.includes('cartesia')) return json({ data: [] });
    if (u.includes('replicate')) return json({ username: 'x' });
    if (u.includes('api.groq.com') || u.includes('api.mistral.ai') || u.includes('models.github.ai') || u.includes('api.cloudflare.com')) return json({ data: [] });
    throw new Error('Unexpected network call in test: ' + u);
  };
  return { calls, fetchImpl };
}

// --- /keys ------------------------------------------------------------------------------

test('/keys: each state mapped from the cheapest check, and never a key value', async () => {
  const { fetchImpl } = keyChecks();
  const { rows, reply } = await handleKeysCommand({ env: KEYS, fetchImpl });
  const by = Object.fromEntries(rows.map((r) => [r.engine, r]));
  assert.equal(by.anthropic.state, STATES.NO_CREDIT, 'Anthropic 400 credit');
  assert.equal(by.gemini_paid.state, STATES.NO_CREDIT, 'Gemini 402');
  assert.equal(by.gemini_free.state, STATES.RATE_LIMITED, 'Gemini free 429');
  assert.equal(by.openrouter.state, STATES.NO_CREDIT, 'OpenRouter at -$0.03');
  assert.match(by.openrouter.note, /balance -\$0\.03; today \$0\.00; free tier 50 free-model requests\/day; dormant until above \$0/);
  assert.equal(by.gateway.state, STATES.NO_CREDIT, 'gateway balance 0');
  assert.equal(by.openai.state, STATES.INVALID, 'OpenAI 401');
  assert.equal(by.elevenlabs.state, STATES.WORKING);
  for (const e of ['groq', 'mistral', 'github_models', 'cloudflare', 'cartesia', 'replicate']) assert.equal(by[e].state, STATES.WORKING, e);
  for (const v of SECRET_VALUES) assert.ok(!reply.includes(v), 'no key value in the reply');
  assert.ok(!JSON.stringify(rows).includes('SECRET'), 'no key value in the rows either');
  assert.match(reply, /\| Anthropic \(Claude\) \| set \| OUT OF CREDIT \| 400 \|/);

  const missing = await keysStatus({ env: {}, fetchImpl: async () => { throw new Error('no call for a missing key'); } });
  assert.ok(missing.every((r) => r.state === STATES.MISSING && r.set === false));
});

test('stateFor: working / out of credit / rate-limited / invalid / unreachable', () => {
  assert.equal(stateFor(200), STATES.WORKING);
  assert.equal(stateFor(402), STATES.NO_CREDIT);
  assert.equal(stateFor(400, 'Your credit balance is too low'), STATES.NO_CREDIT);
  assert.equal(stateFor(429, 'insufficient_quota'), STATES.NO_CREDIT, 'OpenAI out of credit');
  assert.equal(stateFor(429, 'Too Many Requests'), STATES.RATE_LIMITED);
  assert.equal(stateFor(401), STATES.INVALID);
  assert.equal(stateFor(403), STATES.INVALID);
  assert.equal(stateFor(null), STATES.UNREACHABLE);
  assert.equal(stateFor(500), 'error (500)');
});

test('/keys results are cached for 5 minutes; /keys fresh checks again', async () => {
  let t = 1_000_000;
  const { calls, fetchImpl } = keyChecks();
  await keysStatus({ env: { GROQ_API_KEY: KEYS.GROQ_API_KEY }, fetchImpl, now: () => t });
  const second = await keysStatus({ env: { GROQ_API_KEY: KEYS.GROQ_API_KEY }, fetchImpl, now: () => t + 60000 });
  assert.equal(calls.length, 1);
  assert.equal(second.find((r) => r.engine === 'groq').cached, true);
  await keysStatus({ env: { GROQ_API_KEY: KEYS.GROQ_API_KEY }, fetchImpl, now: () => t + KEYS_CACHE_MS + 1 });
  assert.equal(calls.length, 2, 'after 5 minutes');
  await keysStatus({ env: { GROQ_API_KEY: KEYS.GROQ_API_KEY }, fetchImpl, now: () => t + KEYS_CACHE_MS + 2, fresh: true });
  assert.equal(calls.length, 3, 'fresh');
});

let ipSeq = 0;
function makeRes() {
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {}
  };
}
async function chat(body, signedIn = true) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.96.0.${++ipSeq}` }, body: { ...(signedIn ? { user: 'test-operator', pass: 'test-secret-pass' } : {}), ...body } }, res);
  return res;
}

test('/keys in the chat: operator only, and the reply carries no key value', async () => {
  Object.assign(process.env, KEYS);
  globalThis.fetch = keyChecks().fetchImpl;
  const res = await chat({ prompt: '/keys' });
  assert.equal(res.statusCode, 200);
  assert.match(res.jsonBody.reply, /\[ AI KEYS \]/);
  for (const v of SECRET_VALUES) assert.ok(!res.jsonBody.reply.includes(v));
  const guest = await chat({ prompt: '/keys' }, false);
  assert.equal(guest.statusCode, 401);
  assert.doesNotMatch(JSON.stringify(guest.jsonBody), /AI KEYS/);
});

// --- the no-card free engines ------------------------------------------------------------

test('the free engines: after the free Gemini key and before every paid engine, operator content only, skipped when their key is missing', () => {
  const env = { ...KEYS };
  const heavy = planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR }).map((c) => c.provider);
  assert.deepEqual(heavy, ['gemini_free', 'groq', 'mistral', 'github_models', 'cloudflare', 'anthropic', 'gemini_paid', 'openrouter', 'gateway', 'openai']);
  const light = planRoute(TASKS.LIGHT, { env, dataClass: DATA.OPERATOR }).map((c) => c.provider);
  assert.deepEqual(light.slice(0, 5), ['gemini_free', 'groq', 'mistral', 'github_models', 'cloudflare']);
  for (const task of Object.values(TASKS)) {
    assert.ok(!planRoute(task, { env, dataClass: DATA.CUSTOMER }).some((c) => FREE_COMPAT_PROVIDERS.includes(c.provider)), `${task}: customer data`);
    assert.ok(!planRoute(task, { env, dataClass: DATA.OPERATOR, clientWork: true }).some((c) => FREE_COMPAT_PROVIDERS.includes(c.provider)), `${task}: client work`);
    assert.ok(!planRoute(task, { env, dataClass: DATA.OPERATOR, excludeFree: true }).some((c) => FREE_COMPAT_PROVIDERS.includes(c.provider)), `${task}: routing floor`);
  }
  // Missing keys: skipped. Cloudflare needs its account id too.
  const some = planRoute(TASKS.HEAVY, { env: { GROQ_API_KEY: KEYS.GROQ_API_KEY, CLOUDFLARE_AI_TOKEN: KEYS.CLOUDFLARE_AI_TOKEN }, dataClass: DATA.OPERATOR }).map((c) => c.provider);
  assert.deepEqual(some, ['groq']);
  const cf = planRoute(TASKS.HEAVY, { env: { CLOUDFLARE_AI_TOKEN: KEYS.CLOUDFLARE_AI_TOKEN, CLOUDFLARE_ACCOUNT_ID: KEYS.CLOUDFLARE_ACCOUNT_ID }, dataClass: DATA.OPERATOR })[0];
  assert.equal(cf.url, 'https://api.cloudflare.com/client/v4/accounts/f4ca340d9bcbeeab89bba95915dd072e/ai/v1/chat/completions');
  assert.ok(Object.values(OPENAI_COMPAT_URLS).every((u) => !/deepseek\.com/.test(u)), 'never DeepSeek\'s own API');
});

test('each free engine has its own per-minute pace', async () => {
  assert.deepEqual(ENGINE_RPM, { gemini_free: 10, groq: 30, mistral: 60, github_models: 10, cloudflare: 30 });
  assert.equal(freeLimits({ PG1_GROQ_RPM: '5' }, 'groq').rpm, 5);
  const t = 10 * 60000;
  const a = createFreeLimiter({ env: { PG1_GITHUB_MODELS_RPM: '1', PG1_GEMINI_FREE_CHAT_RESERVE: '0' }, key: 'github_models', now: () => t });
  const b = createFreeLimiter({ env: {}, key: 'groq', now: () => t });
  assert.equal((await a.acquire({ priority: PRIORITY.CHAT, maxWaitMs: 0 })).granted, true);
  assert.equal((await a.acquire({ priority: PRIORITY.CHAT, maxWaitMs: 0 })).granted, false, 'GitHub Models at its 1 a minute');
  assert.equal((await b.acquire({ priority: PRIORITY.CHAT, maxWaitMs: 0 })).granted, true, 'Groq has its own minute');
});

test('a 402 from a free engine falls through to the next one at once', async () => {
  const env = { GROQ_API_KEY: KEYS.GROQ_API_KEY, MISTRAL_API_KEY: KEYS.MISTRAL_API_KEY };
  const tried = [];
  const sleeps = [];
  const r = await runRoute({
    task: TASKS.LIGHT, env, dataClass: DATA.OPERATOR, log: () => {}, sleep: async (ms) => { sleeps.push(ms); },
    attempt: async (c) => { tried.push(c.provider); return c.provider === 'groq' ? { ok: false, status: 402, detail: 'Payment Required' } : { ok: true, value: 'from mistral' }; }
  });
  assert.equal(r.value, 'from mistral');
  assert.deepEqual(tried, ['groq', 'mistral']);
  assert.deepEqual(sleeps, []);
});

// --- the OpenRouter guard ----------------------------------------------------------------

function openRouterAt(balance, { freeTier = true, usageDaily = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/v1/key')) return json({ data: { usage: 1, usage_daily: usageDaily, is_free_tier: freeTier, limit_remaining: null } });
    if (String(url).endsWith('/api/v1/credits')) return json({ data: { total_credits: balance >= 0 ? balance + 1 : 0, total_usage: balance >= 0 ? 1 : -balance } });
    throw new Error('unexpected ' + url);
  };
  return { calls, fetchImpl };
}

test('OpenRouter: dormant at a balance of 0 or below, back on its own above 0, checked at most every 10 minutes', async () => {
  const env = { PG1_DAILY_SPEND_CAP_USD: '1000', OPENROUTER_API_KEY: KEYS.OPENROUTER_API_KEY, PG1_OPENROUTER_GUARD: '1' };
  let t = 5_000_000;
  let or = openRouterAt(-0.03);
  const s1 = await ensureOpenRouterState({ env, fetchImpl: or.fetchImpl, now: () => t });
  assert.equal(s1.balanceUsd, -0.03);
  assert.equal(s1.freeDailyRequests, 50);
  assert.ok(!planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR }).some((c) => c.provider === 'openrouter'), 'skipped entirely');
  // Within 10 minutes: no new check, still dormant even if it was topped up.
  or = openRouterAt(5);
  await ensureOpenRouterState({ env, fetchImpl: or.fetchImpl, now: () => t + 60000 });
  assert.equal(or.calls.length, 0, 'cached');
  assert.ok(!planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR }).some((c) => c.provider === 'openrouter'));
  // After 10 minutes the next check finds $5: back, free models first, then paid.
  t += GUARD_TTL_MS + 1;
  const s2 = await ensureOpenRouterState({ env, fetchImpl: or.fetchImpl, now: () => t });
  assert.equal(s2.balanceUsd, 5);
  const c = planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR }).find((x) => x.provider === 'openrouter');
  assert.ok(c, 're-enabled');
  assert.equal(c.freeModels.length, 2);
  assert.ok(c.freeModels.every((m) => !/deepseek/i.test(m)), 'never a DeepSeek model');
  assert.ok(c.freeModels.every((m) => m.endsWith(':free')));
  assert.deepEqual(c.models, ['openai/gpt-5'], 'paid models above $2');
});

test('OpenRouter paid models: blocked below $2 (one push per day) and never for background jobs', async () => {
  const env = { PG1_DAILY_SPEND_CAP_USD: '1000', OPENROUTER_API_KEY: KEYS.OPENROUTER_API_KEY, PG1_OPENROUTER_GUARD: '1', VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k' };
  let t = 9_000_000;
  const pushes = [];
  const push = async (m) => { pushes.push(m); return 1; };
  await ensureOpenRouterState({ env, fetchImpl: openRouterAt(1.5).fetchImpl, now: () => t, store: {}, push });
  const c = planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR }).find((x) => x.provider === 'openrouter');
  assert.deepEqual(c.models, [], 'no paid models at $1.50');
  assert.equal(c.freeModels.length, 2, 'free models still used');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].body, /balance is \$1\.50: paid models are off until it is above \$2/);
  t += GUARD_TTL_MS + 1;
  await ensureOpenRouterState({ env, fetchImpl: openRouterAt(1.4).fetchImpl, now: () => t, store: {}, push });
  assert.equal(pushes.length, 1, 'one push per day');
  // Background work: free models only whatever the balance.
  t += GUARD_TTL_MS + 1;
  await ensureOpenRouterState({ env, fetchImpl: openRouterAt(50).fetchImpl, now: () => t, store: {}, push });
  assert.deepEqual(planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR }).find((x) => x.provider === 'openrouter').models, ['openai/gpt-5']);
  assert.deepEqual(planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR, background: true }).find((x) => x.provider === 'openrouter').models, [], 'never paid for background');
});

test('readOpenRouter reads the balance, usage today and free-tier level; a bad key is invalid', async () => {
  const ok = await readOpenRouter({ key: 'k', fetchImpl: openRouterAt(12, { freeTier: false, usageDaily: 0.4 }).fetchImpl });
  assert.equal(ok.balanceUsd, 12);
  assert.equal(ok.usageDailyUsd, 0.4);
  assert.equal(ok.freeDailyRequests, 1000);
  const bad = await readOpenRouter({ key: 'k', fetchImpl: async () => json({ error: 'no' }, 401) });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
});

// --- streamed calls and their timeouts ---------------------------------------------------------

function sse(chunks, { delayMs = 0, firstDelayMs = 0, headers = {} } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      await new Promise((r) => setTimeout(r, firstDelayMs));
      for (const c of chunks) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', ...headers } });
}
const delta = (t, extra = {}) => ({ id: 'gen-abc123', model: 'deepseek/deepseek-chat-v3.1:free', choices: [{ delta: { content: t } }], ...extra });
const CANDIDATE = { provider: 'openrouter', key: 'k', url: OPENAI_COMPAT_URLS.openrouter, ignoreProviders: ['DeepSeek'] };

test('streaming: the first token is proof of life; a reply that keeps coming is kept past the first-token limit', async () => {
  const lines = [];
  let sent = null;
  const fetchImpl = async (u, o) => { sent = JSON.parse(o.body); return sse([delta('Hello'), delta(' there'), delta(' again', { usage: { prompt_tokens: 10, completion_tokens: 3 } })], { delayMs: 40 }); };
  const r = await callOpenAiCompat({ candidate: CANDIDATE, model: ['deepseek/deepseek-chat-v3.1:free', 'qwen/qwen3-235b-a22b:free'], system: 's', prompt: 'p', fetchImpl, firstTokenMs: 60, timeoutMs: 5000, log: (l) => lines.push(l) });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.text, 'Hello there again');
  assert.equal(r.generationId, 'gen-abc123');
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.models, ['deepseek/deepseek-chat-v3.1:free', 'qwen/qwen3-235b-a22b:free']);
  assert.deepEqual(sent.provider, { ignore: ['DeepSeek'] });
  assert.ok(lines.some((l) => /^\[pg1-compat\] provider=openrouter .*ok=true id=gen-abc123$/.test(l)), lines.join('\n'));
});

test('streaming: no token within the first-token limit times out (and the request id is still logged)', async () => {
  const lines = [];
  const fetchImpl = async () => sse([delta('late')], { firstDelayMs: 300, headers: { 'x-request-id': 'req-xyz' } });
  const r = await callOpenAiCompat({ candidate: CANDIDATE, model: 'x', system: 's', prompt: 'p', fetchImpl, firstTokenMs: 50, timeoutMs: 5000, log: (l) => lines.push(l) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /no token/);
  assert.ok(lines.some((l) => /ok=false id=req-xyz/.test(l)), lines.join('\n'));
});

test('a non-streamed JSON answer still works; a 402 comes back as a 402', async () => {
  const r = await callOpenAiCompat({ candidate: { provider: 'groq', key: 'k', url: OPENAI_COMPAT_URLS.groq }, model: 'openai/gpt-oss-120b', system: 's', prompt: 'p', log: () => {}, fetchImpl: async (u, o) => { assert.equal(JSON.parse(o.body).max_tokens, 4096, 'Groq takes max_tokens'); return json({ id: 'chatcmpl-1', choices: [{ message: { content: 'ok' } }] }); } });
  assert.equal(r.ok, true);
  assert.equal(r.generationId, 'chatcmpl-1');
  const p = await callOpenAiCompat({ candidate: CANDIDATE, model: 'x', system: 's', prompt: 'p', log: () => {}, fetchImpl: async () => json({ error: { code: 402, message: 'Insufficient credits' } }, 402) });
  assert.equal(p.status, 402);
});
