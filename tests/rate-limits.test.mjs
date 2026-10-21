/**
 * Heavy rate limiting on the AI keys (production, 19-20 Oct):
 *   - the free Gemini key answered 429 on almost every chat request (a
 *     daily quota), and chat still waited ~19 s before the next engine;
 *   - a light chat sent 10-13k input tokens;
 *   - Groq: "Rate limit reached for model openai/gpt-oss-20b ... tokens per
 *     minute (TPM): Limit 8000, Used 3769, Requested 4525";
 *   - Autonomous mode's background jobs shared the same free keys as chat.
 *
 * lib/router/quota.mjs (the 429's scope and the cool-downs),
 * lib/router/freeLimiter.mjs (tokens per minute and per day, the
 * background share), lib/aiRouter.mjs CHAT_THROTTLE (5 s), lib/promptBudget.mjs
 * (the prompt this turn needs), lib/keysStatus.mjs (/keys quotas).
 *
 * Run with: node --test tests/rate-limits.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { classify429, coolDown, isCooling, cooldownRows, noteRateHeaders, learnedLimits, parseDuration, QUOTA_STATES, __resetQuota } from '../lib/router/quota.mjs';
import { createFreeLimiter, tokenLimits, PRIORITY, WINDOW_MS, __resetFreeLimiters } from '../lib/router/freeLimiter.mjs';
import { withThrottleRetry, CHAT_THROTTLE, __resetRouterState } from '../lib/aiRouter.mjs';
import { turnNeeds, isSmallTalk, toolsForRoute } from '../lib/promptBudget.mjs';
import { quotaRows, quotaTable } from '../lib/keysStatus.mjs';
import { autonomousText } from '../lib/autonomous/freeText.mjs';
import { __resetAlerts } from '../lib/router/alerts.mjs';
import { makeDb, pgRest } from './helpers/pgrest.mjs';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const FREE = 'AIzaStub-rate-limits-free-0123456789';
const GATEWAY = 'vck_stub_rate_limits_gateway_0123456789';
const GEMINI_DAY = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 250\nPlease retry in 43.5s.', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '250' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '43s' }] } });
const GROQ_TPM = JSON.stringify({ error: { message: 'Rate limit reached for model `openai/gpt-oss-20b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 3769, Requested 4525. Please try again in 1.9s. Need more tokens? Upgrade to Dev Tier today.', type: 'tokens', code: 'rate_limit_exceeded' } });
const GROQ_TPD = JSON.stringify({ error: { message: 'Rate limit reached for model `llama-3.3-70b-versatile` on tokens per day (TPD): Limit 100000, Used 99500, Requested 1200. Please try again in 14m22.4s.', code: 'rate_limit_exceeded' } });

beforeEach(() => {
  __resetQuota();
  __resetFreeLimiters();
  __resetRouterState();
  __resetAlerts();
  __clearAuthRateLimitState();
  for (const k of Object.keys(process.env)) if (/^(GEMINI_|ANTHROPIC|SUPABASE|GROQ|OPENAI|OPENROUTER|VERCEL_AI|AI_GATEWAY|PG1_|MISTRAL|GITHUB_MODELS|CLOUDFLARE)/.test(k) && k !== 'PG1_DAILY_SPEND_CAP_USD') delete process.env[k];
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

// --- reading the 429 ----------------------------------------------------------------------

test('a 429 is read per engine: Gemini quotaId and RetryInfo, Groq TPM/TPD with limit, used and requested', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  const g = classify429({ provider: 'gemini_free', status: 429, text: GEMINI_DAY, now });
  assert.equal(g.scope, 'day', 'the daily quota, although the body also says "retry in 43.5s"');
  assert.equal(g.metric, 'GenerateRequestsPerDayPerProjectPerModel-FreeTier');
  assert.equal(g.limit, 250);
  assert.ok(g.resetAt > now + 3600000, 'cools until the Pacific midnight reset, not 43 s');
  const t = classify429({ provider: 'groq', status: 429, text: GROQ_TPM, now });
  assert.deepEqual({ scope: t.scope, metric: t.metric, limit: t.limit, used: t.used, requested: t.requested, retryAfterMs: t.retryAfterMs }, { scope: 'minute', metric: 'TPM', limit: 8000, used: 3769, requested: 4525, retryAfterMs: 1900 });
  const d = classify429({ provider: 'groq', status: 429, text: GROQ_TPD, now });
  assert.equal(d.scope, 'day');
  assert.equal(d.resetAt, now + (14 * 60 + 22.4) * 1000);
  assert.equal(classify429({ provider: 'gemini_paid', status: 429, text: 'Your project has exceeded its monthly spending cap.' }).scope, 'spend_cap');
  assert.equal(classify429({ provider: 'groq', status: 429, text: 'Rate limit reached on tokens per minute (TPM): Limit 8000, Used 0, Requested 12000' }).oversize, true, 'a request over the whole minute never fits');
  assert.equal(parseDuration('2m59.56s'), 179560);
  assert.equal(parseDuration('450ms'), 450);
});

test('the engine\'s own headers are kept: limit and remaining requests and tokens, and when they reset', () => {
  noteRateHeaders('groq', { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '812', 'x-ratelimit-limit-tokens': '6000', 'x-ratelimit-remaining-tokens': '2210', 'x-ratelimit-reset-tokens': '7.66s' }, 1000);
  assert.deepEqual(learnedLimits('groq'), { limitRequests: 1000, remainingRequests: 812, limitTokens: 6000, remainingTokens: 2210, at: 1000, resetTokensAt: 1000 + 7660 });
  assert.equal(tokenLimits({}, 'groq', learnedLimits('groq')).tpm, 6000, 'a tighter header limit wins');
});

// --- cool-downs: skipped at once ------------------------------------------------------------

test('a daily-quota 429 cools the engine+model until its reset; a long per-minute retry cools it for the hint; a short one does not', () => {
  const now = 1_800_000_000_000;
  coolDown('gemini_free', 'gemini-3.8-flash', classify429({ provider: 'gemini_free', status: 429, text: GEMINI_DAY, now }), now);
  assert.equal(isCooling('gemini_free', 'gemini-3.8-flash', now + 3600000), true);
  assert.equal(isCooling('gemini_free', 'gemini-3.6-flash', now), false, 'quotas are per model: the other model is still tried');
  coolDown('groq', 'openai/gpt-oss-20b', classify429({ provider: 'groq', status: 429, text: GROQ_TPM, now }), now);
  assert.equal(isCooling('groq', 'openai/gpt-oss-20b', now), false, 'a 1.9 s wait is the throttle\'s, not a cool-down');
  coolDown('groq', 'llama-3.1-8b-instant', { scope: 'minute', retryAfterMs: 30000 }, now);
  assert.deepEqual(cooldownRows(now).map((r) => [r.engine, r.model, r.state]), [['gemini_free', 'gemini-3.8-flash', QUOTA_STATES.DAY], ['groq', 'llama-3.1-8b-instant', QUOTA_STATES.MINUTE]]);
  assert.equal(isCooling('groq', 'llama-3.1-8b-instant', now + 29000), true);
  assert.equal(isCooling('groq', 'llama-3.1-8b-instant', now + 31000), false);
});

function chatRes() {
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {}
  };
}
let ip = 0;
async function chat(prompt) {
  const res = chatRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.92.0.${++ip}` }, body: { user: 'test-operator', pass: 'test-secret-pass', prompt } }, res);
  return res.jsonBody;
}

test('daily-quota 429 through /api/chat: no wait, the backup answers; the next message skips the cooled models without calling them', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  process.env.VERCEL_AI_API_KEY = GATEWAY;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('generativelanguage')) { calls.push(u.match(/models\/([^:]+)/)[1]); return new Response(GEMINI_DAY, { status: 429 }); }
    if (u.includes('ai-gateway.vercel.sh')) { calls.push('gateway'); return Response.json({ choices: [{ message: { content: 'Backup here.' } }] }); }
    throw new Error('Unexpected network call: ' + u);
  };
  const t0 = Date.now();
  const first = await chat('hello there');
  assert.match(first.reply, /Backup here/);
  assert.deepEqual(calls, ['gemini-3.8-flash', 'gemini-3.6-flash', 'gateway'], 'each Gemini model once, no retry of the same model');
  assert.ok(Date.now() - t0 < 4000, 'no waiting');
  calls.length = 0;
  const second = await chat('thanks!');
  assert.match(second.reply, /Backup here/);
  assert.deepEqual(calls, ['gateway'], 'both cooled models are skipped at once');
});

test('per-minute 429 with a long retry falls through at once for chat; a short one is waited for (at most 5 s)', async () => {
  const long = [];
  await withThrottleRetry(async () => ({ ok: false, status: 429, detail: 'Please try again in 12s.' }), { policy: CHAT_THROTTLE, sleep: async (ms) => { long.push(ms); } });
  assert.deepEqual(long, [], '12 s > 5 s: no wait');
  const short = [];
  let n = 0;
  const out = await withThrottleRetry(async () => (++n === 1 ? { ok: false, status: 429, detail: 'Please try again in 1.9s.' } : { ok: true }), { policy: CHAT_THROTTLE, sleep: async (ms) => { short.push(ms); } });
  assert.equal(out.result.ok, true);
  assert.deepEqual(short, [1900]);
  assert.equal(CHAT_THROTTLE.maxTotalWaitMs, 5000);
});

// --- the token-aware limiter ----------------------------------------------------------------

test('the limiter refuses a call that would pass the engine\'s tokens per minute, and a day\'s budget at once', async () => {
  let t = 10 * WINDOW_MS;
  const limiter = createFreeLimiter({ env: {}, key: 'groq', now: () => t, sleep: async (ms) => { t += ms; } });
  assert.deepEqual(await limiter.acquire({ tokens: 9000, maxWaitMs: 60000 }), { granted: false, waitedMs: 0, reason: 'tpm' }, 'bigger than Groq\'s 8000 TPM: never fits, no wait');
  assert.equal((await limiter.acquire({ tokens: 5000, maxWaitMs: 0 })).granted, true);
  assert.deepEqual(await limiter.acquire({ tokens: 4525, maxWaitMs: 0 }), { granted: false, waitedMs: 0, reason: 'tpm' }, '5000 + 4525 > 8000 this minute');
  const waited = await limiter.acquire({ tokens: 4525, maxWaitMs: 60000 });
  assert.equal(waited.granted, true, 'the next minute has room');
  const day = createFreeLimiter({ env: { PG1_GITHUB_MODELS_RPD: '2' }, key: 'github_models', now: () => t, sleep: async (ms) => { t += ms; } });
  await day.acquire({ maxWaitMs: 0 });
  await day.acquire({ maxWaitMs: 0 });
  assert.deepEqual(await day.acquire({ maxWaitMs: 60000 }), { granted: false, waitedMs: 0, reason: 'rpd' }, 'a day\'s budget is never waited for');
});

test('pg1_rate_take_n (the new migration, on Postgres): tokens shared across instances, a read with n = 0', async () => {
  const db = await makeDb(['20261102120000_pg1_rate_windows.sql', '20261107120000_pg1_rate_tokens.sql']);
  const rest = pgRest(db);
  const a = createFreeLimiter({ env: {}, key: 'groq', supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: rest });
  const b = createFreeLimiter({ env: {}, key: 'groq', supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: rest });
  assert.equal((await a.acquire({ tokens: 5000, maxWaitMs: 0 })).granted, true);
  assert.deepEqual(await b.acquire({ tokens: 4000, maxWaitMs: 0 }), { granted: false, waitedMs: 0, reason: 'tpm' }, 'the other instance sees the 5000 tokens');
  const { rows } = await db.query("select key, used from public.pg1_rate_windows where key like 'groq:%' order by key");
  assert.deepEqual(rows.map((r) => [r.key, Number(r.used)]), [['groq:chat', 2], ['groq:rpd', 2], ['groq:tpd', 9000], ['groq:tpm', 5000]]);
  const read = await (await rest('https://supabase.test/rest/v1/rpc/pg1_rate_take_n', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_key: 'groq:tpm', p_cap: 8000, p_window_s: 60, p_n: 0 }) })).json();
  assert.equal(Number((Array.isArray(read) ? read[0] : read).used), 5000);
});

// --- background work ----------------------------------------------------------------------

test('background jobs get the smaller share and yield to chat', async () => {
  let t = 10 * WINDOW_MS;
  const limiter = createFreeLimiter({ env: { PG1_GROQ_RPD: '10' }, key: 'groq', now: () => t, sleep: async (ms) => { t += ms; } });
  for (let i = 0; i < 5; i++) assert.equal((await limiter.acquire({ priority: PRIORITY.BACKGROUND, maxWaitMs: 0, tokens: 10 })).granted, true, `background ${i + 1} of its 5`);
  assert.deepEqual(await limiter.acquire({ priority: PRIORITY.BACKGROUND, maxWaitMs: 0, tokens: 10 }), { granted: false, waitedMs: 0, reason: 'rpd' }, 'half of the day\'s 10 requests');
  assert.equal((await limiter.acquire({ priority: PRIORITY.CHAT, maxWaitMs: 0, tokens: 10 })).granted, true, 'chat still has its share');
  t += 30 * 1000;
  const other = createFreeLimiter({ env: {}, key: 'groq', now: () => t, sleep: async () => {} });
  await other.acquire({ priority: PRIORITY.CHAT, maxWaitMs: 0, tokens: 10 });
  assert.deepEqual(await other.acquire({ priority: PRIORITY.BACKGROUND, maxWaitMs: 60000, tokens: 10 }), { granted: false, waitedMs: 0, reason: 'chat_active' });
});

test('autonomous work pauses with one notice (not one per job) when every free engine refuses', async () => {
  process.env.PG1_FREE_LIMITER = '1';
  process.env.GROQ_API_KEY = 'gsk_stub_rate_limits_0123456789';
  // Chat used Groq just now: background work yields.
  const { freeLimiterFor } = await import('../lib/router/freeLimiter.mjs');
  await freeLimiterFor({ env: process.env, engine: 'groq' }).acquire({ priority: PRIORITY.CHAT, maxWaitMs: 0 });
  globalThis.fetch = async (url) => { throw new Error('no engine should be called: ' + url); };
  const notices = [];
  const first = await autonomousText({ env: process.env, system: 'plan', prompt: 'a mission', notify: async (line) => notices.push(line) });
  const second = await autonomousText({ env: process.env, system: 'plan', prompt: 'another mission', notify: async (line) => notices.push(line) });
  assert.equal(first.ok, false);
  assert.equal(first.paused, true);
  assert.equal(second.paused, true);
  assert.equal(notices.length, 1, 'one notice');
  assert.match(notices[0], /Autonomous mode paused its AI work/);
});

// --- the prompt ---------------------------------------------------------------------------

test('prompt size: small talk stays under ~3,000 input tokens, normal operator chat under ~6,000; each turn logs its tokens', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  const sent = [];
  globalThis.fetch = async (url, o = {}) => {
    const b = JSON.parse(o.body);
    sent.push(Math.ceil((b.systemInstruction.parts[0].text.length + JSON.stringify(b.contents).length + JSON.stringify(b.tools || []).length) / 4));
    return Response.json({ candidates: [{ content: { parts: [{ text: 'Hi!' }] } }] });
  };
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    await chat('hello');
    await chat('thanks, how are you?');
    await chat('can you explain how x402 payments work for agents?');
    await chat('what should we focus on this week for the pricing page?');
  } finally { console.log = orig; }
  assert.ok(sent[0] < 3000 && sent[1] < 3000, `small talk: ${sent.slice(0, 2)}`);
  assert.ok(sent[2] < 6000 && sent[3] < 6000, `operator chat: ${sent.slice(2)}`);
  const logged = lines.filter((l) => l.startsWith('[chat] prompt route='));
  assert.equal(logged.length, 4);
  assert.match(logged[0], /tier=small_talk input_tokens~\d+/);
  assert.equal(isSmallTalk('hey PG1, how are you?'), true);
  assert.equal(isSmallTalk('check 0x1234'), false);
  assert.equal(turnNeeds('what model are you?').identity, true, 'identity turns keep the full identity rules');
  assert.equal(turnNeeds('summarise the meeting').voice, false);
});

test('the tools route sends only the schemas it needs', () => {
  const tools = ['check_wallet_sanctions', 'check_domain_age', 'check_hostname_reputation', 'check_wallet_age', 'check_package', 'get_ioc_context', 'get_ioc_batch', 'get_cve_details', 'get_cve_batch', 'get_cve_by_product', 'get_threat_actor_profile', 'get_usage_stats', 'search_history'].map((name) => ({ name }));
  assert.deepEqual(toolsForRoute(tools, { route: 'tools', reason: 'wallet_address' }, 'check 0xabc').map((t) => t.name), ['check_wallet_sanctions', 'check_wallet_age']);
  assert.deepEqual(toolsForRoute(tools, { route: 'tools', reason: 'hostname' }, 'how old is example.com').map((t) => t.name), ['check_domain_age', 'check_hostname_reputation', 'get_ioc_context']);
  assert.deepEqual(toolsForRoute(tools, { route: 'tools', reason: 'history' }, 'what did we say about the wallet').map((t) => t.name), ['search_history']);
  assert.equal(toolsForRoute(tools, { route: 'tools', reason: 'check_name' }, 'use check_domain_age').length, tools.length, 'a named check keeps them all');
});

// --- /keys ----------------------------------------------------------------------------------

test('/keys and /usage: per engine, its state, what is left where known, and the reset time', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  coolDown('gemini_free', 'gemini-3.8-flash', classify429({ provider: 'gemini_free', status: 429, text: GEMINI_DAY, now }), now);
  coolDown('gemini_paid', '*', { scope: 'spend_cap', resetAt: now + 86400000 }, now);
  noteRateHeaders('groq', { 'x-ratelimit-remaining-requests': '812', 'x-ratelimit-remaining-tokens': '2210', 'x-ratelimit-reset-requests': '2m59.56s' }, now);
  const rows = quotaRows({ env: {}, now, usage: () => ({ tpm: 0, rpd: 40, tpd: 0 }) });
  const gem = rows.find((r) => r.engine === 'gemini_free');
  assert.equal(gem.state, QUOTA_STATES.DAY);
  assert.deepEqual(gem.models, ['gemini-3.8-flash: daily quota used']);
  assert.ok(gem.resetAt > now);
  assert.equal(rows.find((r) => r.engine === 'groq').remaining, '812 requests, 2210 tokens');
  assert.equal(rows.find((r) => r.engine === 'github_models').remaining, '110 of 150 requests today');
  const table = quotaTable(rows);
  assert.match(table, /\| Gemini \(free key\) \| daily quota used \|/);
  assert.match(table, /\| Groq \(free\) \| ok \| 812 requests, 2210 tokens \| 2026-10-20 10:02 UTC \|/);
});
