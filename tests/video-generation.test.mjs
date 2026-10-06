/**
 * PG1 Motion video clips (lib/videoJobs.mjs, the GENERATE_VIDEO and
 * VIDEO_STATUS paths in api/chat.mjs, the generate_video chat tool):
 *  - role gating: only the signed-in operator; a guest never reaches the
 *    engine, the status poll or the tool
 *  - the switch: nothing runs unless PG1_VIDEO_ENABLED=1, and "off" is said
 *    plainly
 *  - the daily cap: the slot is reserved in the database before the engine
 *    is called, two simultaneous requests cannot both take the last slot,
 *    and a failed clip still uses its slot
 *  - the poll: rendering -> done (copied to pg1-vault/videos/, signed link)
 *    and a job older than 15 minutes is marked failed
 *  - identity: only "PG1 Motion" is ever shown; the model name is swapped
 *    in error summaries; the engine's real error text goes to pg1_errors
 *  - the final request bodies carry no key the API does not accept
 *  - the narrowed request match ("animate" alone is not a request)
 *
 * The database is a real Postgres (PGlite) with the migration applied,
 * behind a small PostgREST stand-in, so the cap is the real SQL function.
 *
 * Run with: node --test tests/video-generation.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { createSseParser } from '../lib/chatStream.mjs';
import { FAILURE_PREFIX, UPSTREAM_BRAND_RE } from '../lib/upstreamFailure.mjs';
import { createReplySecretGuard, neutralErrorReason } from '../lib/secretGuard.mjs';
import {
  chatToolsForRole, createToolExecutor, toGeminiFunctionDeclarations, GEMINI_SCHEMA_KEYS, summarizeOutcome,
  traceLabels, OPERATOR_ONLY_CHAT_TOOLS, READ_ONLY_CHAT_TOOLS, VIDEO_CHAT_TOOL
} from '../lib/chatTools.mjs';
import { chooseChatRoute } from '../lib/chatRoute.mjs';
import {
  buildVideoRequestBody, cleanVideoPrompt, isVideoRequest, startVideoJob, videoDailyCap, videoEnabled, videoModel,
  videoFromInteraction, DEFAULT_VIDEO_MODEL, DEFAULT_VIDEO_DAILY_CAP, INTERACTION_BODY_KEYS, VIDEO_DISABLED_TEXT,
  VIDEO_ENGINE_LABEL, VIDEO_JOB_TIMEOUT_MS, VIDEO_SIGNED_URL_SECONDS, VIDEO_REFUSED_TEXT, classifyVideoFailure, replicateVideoInput,
  videoDailyBudget, parseVideoOptions, VIDEO_PRICES, videoClipEstimate, replicateVideoModel, googleRequestParts, stripUrlKey,
  VIDEO_POLL_ERROR_LIMIT
} from '../lib/videoJobs.mjs';

const MIGRATIONS = ['20261008120000_pg1_video_jobs.sql', '20261009120000_pg1_video_budget.sql']
  .map((f) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'));
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CONSOLE_ERROR = console.error;

const SUP_URL = 'https://supabase.test';
const KEY1 = 'stub-video-key-one-0123456789';
const KEY2 = 'stub-video-key-two-0123456789';
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MP4_BASE64 = Buffer.from('fake mp4 bytes for the test').toString('base64');
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const GEMINI_REJECTION = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument: gemini-omni-1.1-flash cannot use response_format.resolution "720p" here.' } });
const GEMINI_SAFETY = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The prompt was blocked due to safety reasons (PROHIBITED_CONTENT).' } });

// Names no system-generated string on the video path may carry.
const BRANDS_RE = /Gemini|Google|Veo|Omni|Anthropic|Claude|OpenAI|googleapis|interactions/i;

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY1 = KEY1;
  process.env.GEMINI_API_KEY2 = KEY2;
  process.env.SUPABASE_URL = SUP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-0123456789';
  process.env.PG1_VIDEO_ENABLED = '1';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'SUPABASEAPI_KEY',
    'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'REPLICATE_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'PG1_VIDEO_DAILY_CAP',
    'PG1_VIDEO_MODEL', 'PG1_CHAT_TOOL_TIMEOUT_MS', 'PG1_VIDEO_MODEL_REPLICATE', 'PG1_VIDEO_MODEL_REPLICATE_IMAGE', 'PG1_VIDEO_DAILY_BUDGET_USD']) delete process.env[k];
}

let consoleLines = [];
beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
  consoleLines = [];
  console.error = (...args) => { consoleLines.push(args.join(' ')); };
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  console.error = ORIGINAL_CONSOLE_ERROR;
});

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.81.0.${++ipSeq}` }, body });
const authed = (extra) => ({ user: 'test-operator', pass: 'test-secret-pass', ...extra });

function makeRes() {
  const listeners = {};
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; },
    end() { this.ended = true; return this; },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev) { (listeners[ev] || []).forEach((fn) => fn()); }
  };
}

function eventsOf(res) {
  const out = [];
  const parser = createSseParser(({ data }) => out.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return out;
}

async function run(body) {
  const res = makeRes();
  await chatHandler(makeReq(body), res);
  return res;
}

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

// --- a real database behind a PostgREST stand-in --------------------------------------

async function makeDb() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  for (const m of MIGRATIONS) await db.exec(m);
  for (const m of MIGRATIONS) await db.exec(m); // re-runnable
  return db;
}

function filters(url) {
  const where = [];
  const vals = [];
  for (const [k, v] of new URL(url).searchParams) {
    if (k === 'select') continue;
    assert.match(k, /^[a-z_]+$/);
    if (v.startsWith('eq.')) { vals.push(v.slice(3)); where.push(`${k} = $${vals.length}`); } else if (v.startsWith('in.(')) {
      const ph = v.slice(4, -1).split(',').map((x) => { vals.push(x); return `$${vals.length}`; });
      where.push(`${k} in (${ph.join(', ')})`);
    }
  }
  return { where: where.length ? where.join(' and ') : 'true', vals };
}

function dbRoutes(db) {
  return [
    ['/rest/v1/rpc/pg1_reserve_video_slot', async (u, o, body) => {
      const keys = ['p_prompt', 'p_est_cost_usd', 'p_budget_usd', 'p_max_clips', 'p_request_id', 'p_has_start_frame', 'p_tier', 'p_duration_s'];
      assert.deepEqual(Object.keys(body).sort(), keys.slice().sort(), 'the RPC is called with exactly the new signature');
      const r = await db.query('select * from public.pg1_reserve_video_slot($1, $2, $3, $4, $5, $6, $7, $8)', keys.map((k) => body[k]));
      return json(r.rows);
    }],
    ['/rest/v1/pg1_video_jobs', async (u, o, body) => {
      const { where, vals } = filters(u);
      if (o.method === 'PATCH') {
        const sets = Object.entries(body).map(([k, v]) => { vals.push(v); return `${k} = $${vals.length}`; });
        const r = await db.query(`update public.pg1_video_jobs set ${sets.join(', ')} where ${where} returning *`, vals);
        return json(r.rows);
      }
      const r = await db.query(`select * from public.pg1_video_jobs where ${where}`, vals);
      return json(r.rows);
    }]
  ];
}

// The chat's own Supabase reads before routing, the vault and the error log.
const supabaseRoutes = () => [
  ['/rest/v1/messages', (u, o) => (o.method === 'POST' ? new Response('', { status: 201 }) : json([]))],
  ['/storage/v1/object/list/pg1-vault', () => json([])],
  ['/storage/v1/object/sign/pg1-vault/', (u) => json({ signedURL: `/object/sign/pg1-vault/${u.split('/pg1-vault/')[1]}?token=signed-token` })],
  ['/storage/v1/object/pg1-vault/', () => json({ Key: 'ok' })],
  ['/rest/v1/threat_indicators', () => json([])],
  ['/rest/v1/pg1_errors', (u, o) => (o.method === 'POST' || o.method === 'PATCH' ? new Response('', { status: 201 }) : json([]))]
];

function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    let body = null;
    if (typeof options.body === 'string') { try { body = JSON.parse(options.body); } catch (e) { body = options.body; } } else if (options.body) body = options.body;
    calls.push({ url: u, method: options.method || 'GET', body, headers: options.headers || {} });
    for (const [needle, handler] of routes) {
      if (u.includes(needle)) return handler(u, options, body);
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}

// The video engine: POST starts a job, GET reports it.
function engineRoutes({ start = () => json({ id: 'int-123', status: 'in_progress' }), poll = () => json({ id: 'int-123', status: 'in_progress' }) } = {}) {
  return [
    [INTERACTIONS, (u, o, body) => (o.method === 'POST' ? start(body, o) : poll(u, o))]
  ];
}

const startCalls = (calls) => calls.filter((c) => c.url === INTERACTIONS && c.method === 'POST');
const engineCalls = (calls) => calls.filter((c) => c.url.startsWith(INTERACTIONS));

async function errorRows(calls, atLeast = 1) {
  let rows = [];
  for (let i = 0; i < 100; i++) {
    rows = calls.filter((c) => c.url.includes('/rest/v1/pg1_errors') && c.method === 'POST');
    if (rows.length >= atLeast) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  return rows.map((c) => c.body);
}

// --- 1. role gating -------------------------------------------------------------

test('a guest never gets a video: /video, a plain request and the status poll are refused before the database or the engine', async () => {
  const db = await makeDb();
  const calls = installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  for (const prompt of ['/video a gold shield turning', 'make a video of a gold shield turning']) {
    const res = await run({ prompt });
    assert.equal(res.statusCode, 401, prompt);
    assert.doesNotMatch(JSON.stringify(res.jsonBody), /Rendering video/);
  }
  const wrong = await run({ prompt: 'make a video of a cat', user: 'test-operator', pass: 'wrong' });
  assert.equal(wrong.statusCode, 401, 'wrong credentials are a guest');
  const poll = await run({ action: 'VIDEO_STATUS', jobId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(poll.statusCode, 401);
  assert.equal(engineCalls(calls).length, 0, 'the engine was never called');
  assert.equal(calls.filter((c) => c.url.includes('pg1_reserve_video_slot') || c.url.includes('/rest/v1/pg1_video_jobs')).length, 0, 'no slot reserved, no job read');
  assert.equal((await db.query('select count(*)::int as n from public.pg1_video_jobs')).rows[0].n, 0);
});

test('generate_video is the operator\'s alone, only when switched on, and a guest executor cannot run it', async () => {
  const names = (role, opts) => chatToolsForRole(role, opts).map((t) => t.name);
  assert.ok(names('operator', { video: true }).includes(VIDEO_CHAT_TOOL));
  assert.ok(!names('operator').includes(VIDEO_CHAT_TOOL), 'not offered when the switch is off');
  assert.ok(!names('guest', { video: true }).includes(VIDEO_CHAT_TOOL));
  assert.ok(!names('nobody', { video: true }).includes(VIDEO_CHAT_TOOL));
  assert.ok(!OPERATOR_ONLY_CHAT_TOOLS.includes(VIDEO_CHAT_TOOL), 'not part of the always-on operator tools');

  let started = 0;
  const asked = [];
  const startVideo = async (a) => { started++; asked.push(a); return { ok: true, jobId: 'x', tier: a.tier, durationS: a.durationS, estCost: 1.5, spent: 1.5, remaining: 3.5, budget: 5 }; };
  const guest = createToolExecutor({ role: 'guest', startVideo, log: () => {} });
  const refused = await guest({ id: 'c1', name: VIDEO_CHAT_TOOL, args: { prompt: 'a cat' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'not_available');
  const noRole = await createToolExecutor({ startVideo, log: () => {} })({ id: 'c2', name: VIDEO_CHAT_TOOL, args: { prompt: 'a cat' } });
  assert.equal(noRole.code, 'not_available', 'a missing role is the least-privileged one');
  assert.equal(started, 0);

  // The operator: one clip per message, whatever the model asks for.
  const operator = createToolExecutor({ role: 'operator', startVideo, log: () => {} });
  const [a, b] = await Promise.all([
    operator({ id: 'v1', name: VIDEO_CHAT_TOOL, args: { prompt: 'a cat', tier: 'pro', length: 'long' } }),
    operator({ id: 'v2', name: VIDEO_CHAT_TOOL, args: { prompt: 'a dog', tier: 'pro', length: 'long' } })
  ]);
  assert.equal(started, 1);
  assert.equal([a, b].filter((o) => o.ok).length, 1);
  assert.equal([a, b].find((o) => !o.ok).code, 'one_per_message');
  const ok = [a, b].find((o) => o.ok);
  assert.deepEqual(asked[0], { prompt: asked[0].prompt, tier: 'pro', durationS: 10 }, 'the tool passes the tier and length');
  assert.equal(ok.result.status, 'rendering');
  assert.equal(ok.result.job_id, 'x');
  assert.equal(ok.result.cost_line, 'PG1 Motion · Pro · 10 s · about 1.50 USD · 3.50 USD left today');
  const card = summarizeOutcome(ok);
  assert.deepEqual(card.video_job, { id: 'x', status: 'rendering' });
  assert.equal(traceLabels({ name: VIDEO_CHAT_TOOL, args: {} }, ok).result, 'PG1 Motion · Pro · 10 s');
});

// --- 2. the switch ----------------------------------------------------------------

test('switched off (unset, 0, true or yes): the reply says so plainly and nothing is reserved or called', async () => {
  const db = await makeDb();
  for (const value of [undefined, '0', 'true', 'yes', '']) {
    if (value === undefined) delete process.env.PG1_VIDEO_ENABLED; else process.env.PG1_VIDEO_ENABLED = value;
    assert.equal(videoEnabled(process.env), false, String(value));
    const calls = installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
    for (const prompt of ['/video a gold shield turning', 'make a video of a gold shield turning']) {
      const res = await run(authed({ prompt }));
      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonBody.reply, VIDEO_DISABLED_TEXT, `${value}: ${prompt}`);
      assert.equal(res.jsonBody.videoJob, undefined);
    }
    assert.equal(engineCalls(calls).length, 0);
    assert.equal(calls.filter((c) => c.url.includes('pg1_reserve_video_slot')).length, 0);
  }
  assert.equal(VIDEO_DISABLED_TEXT, 'Video generation is switched off.');
  assert.equal((await db.query('select count(*)::int as n from public.pg1_video_jobs')).rows[0].n, 0);
  // and the tool path: not offered, so the model cannot start one
  const off = await startVideoJob({ env: {}, prompt: 'a cat', geminiKeys: [KEY1], supUrl: SUP_URL, supKey: 'k', fetchImpl: () => { throw new Error('no call'); } });
  assert.deepEqual(off, { ok: false, code: 'disabled' });
});

test('configuration: model, cap and switch come from env with the documented defaults', () => {
  assert.equal(DEFAULT_VIDEO_MODEL, 'gemini-omni-1.1-flash');
  assert.equal(videoModel({}), 'gemini-omni-1.1-flash');
  assert.equal(videoModel({ PG1_VIDEO_MODEL: '  another-video-model ' }), 'another-video-model');
  assert.doesNotMatch(videoModel({}), /veo/i, 'never Veo: its previews shut down on 2026-10-22');
  assert.equal(DEFAULT_VIDEO_DAILY_CAP, 10, 'the clip count is now only a hard limit');
  assert.equal(videoDailyCap({}), 10);
  assert.equal(videoDailyCap({ PG1_VIDEO_DAILY_CAP: '5' }), 5);
  assert.equal(videoDailyCap({ PG1_VIDEO_DAILY_CAP: '0' }), 0);
  for (const bad of ['-1', 'three', '2.5', '']) assert.equal(videoDailyCap({ PG1_VIDEO_DAILY_CAP: bad }), 10, bad);
  assert.equal(videoDailyBudget({}), 5);
  assert.equal(videoDailyBudget({ PG1_VIDEO_DAILY_BUDGET_USD: '12.50' }), 12.5);
  assert.equal(videoDailyBudget({ PG1_VIDEO_DAILY_BUDGET_USD: '0' }), 0);
  for (const bad of ['-1', 'five', '1.234', '']) assert.equal(videoDailyBudget({ PG1_VIDEO_DAILY_BUDGET_USD: bad }), 5, bad);
  assert.equal(videoEnabled({ PG1_VIDEO_ENABLED: '1' }), true);
  assert.equal(VIDEO_SIGNED_URL_SECONDS, 7 * 24 * 3600);
  assert.equal(VIDEO_JOB_TIMEOUT_MS, 15 * 60 * 1000);
});

// --- 3. the budget -------------------------------------------------------------------

test('the budget holds under two simultaneous requests: one clip is reserved, the other is told it would go over and offered a cheaper choice', async () => {
  process.env.PG1_VIDEO_DAILY_BUDGET_USD = '0.75';
  const db = await makeDb();
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = installFetch([
    ...engineRoutes({ start: async () => { await gate; return json({ id: 'int-123', status: 'in_progress' }); } }),
    ...dbRoutes(db), ...supabaseRoutes()
  ]);
  const both = Promise.all([run(authed({ prompt: '/video a red fox in snow' })), run(authed({ prompt: 'make a video of a blue whale' }))]);
  setTimeout(release, 20);
  const [r1, r2] = await both;
  const replies = [r1.jsonBody, r2.jsonBody];
  const started = replies.filter((b) => b.videoJob);
  const refused = replies.filter((b) => !b.videoJob);
  assert.equal(started.length, 1, 'exactly one clip reserved');
  assert.equal(refused.length, 1);
  assert.equal(started[0].reply, 'Rendering video… It appears here when it is ready, usually within a few minutes.\nPG1 Motion · Standard · 5 s · about 0.50 USD · 0.25 USD left today');
  assert.equal(refused[0].reply, "That clip (Standard · 5 s, about 0.50 USD) would go over today's video budget: 0.25 USD left of 0.75 USD. Try Draft · 5 s, about 0.15 USD (/video draft …).");
  assert.equal(startCalls(calls).length, 1, 'the engine was called once');
  const rows = (await db.query('select status, tier, duration_s, est_cost_usd from public.pg1_video_jobs')).rows;
  assert.deepEqual(rows, [{ status: 'rendering', tier: 'standard', duration_s: 5, est_cost_usd: '0.50' }]);

  // The estimate is reserved before the engine is called.
  const reserveAt = calls.findIndex((c) => c.url.includes('pg1_reserve_video_slot'));
  const startAt = calls.findIndex((c) => c.url === INTERACTIONS && c.method === 'POST');
  assert.ok(reserveAt >= 0 && reserveAt < startAt);
  assert.equal(calls[reserveAt].body.p_est_cost_usd, 0.5);

  // Nothing fits: no suggestion, just when it resets.
  process.env.PG1_VIDEO_DAILY_BUDGET_USD = '0.60';
  const none = await run(authed({ prompt: '/video pro long a storm' }));
  assert.equal(none.jsonBody.reply, "That clip (Pro · 10 s, about 1.50 USD) would go over today's video budget: 0.10 USD left of 0.60 USD. Nothing fits in what is left today; the budget resets at midnight UTC.");
});

test('PG1_VIDEO_DAILY_CAP stays a hard clip limit, also under two simultaneous requests', async () => {
  process.env.PG1_VIDEO_DAILY_CAP = '1';
  const db = await makeDb();
  const calls = installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  const [r1, r2] = await Promise.all([run(authed({ prompt: '/video draft a fox' })), run(authed({ prompt: '/video draft a whale' }))]);
  const replies = [r1.jsonBody, r2.jsonBody];
  assert.equal(replies.filter((b) => b.videoJob).length, 1);
  assert.equal(replies.find((b) => !b.videoJob).reply, "Today's clip limit is reached (1 of 1). It resets at midnight UTC.");
  assert.equal(startCalls(calls).length, 1);
});

test('a clip that fails keeps its reservation; the reply is one neutral sentence, the request ID and the cost line; Gemini\'s real error goes to pg1_errors', async () => {
  process.env.PG1_VIDEO_DAILY_BUDGET_USD = '1.00';
  const db = await makeDb();
  let calls = installFetch([...engineRoutes({ start: () => new Response(GEMINI_REJECTION, { status: 400 }) }), ...dbRoutes(db), ...supabaseRoutes()]);
  const res = await run(authed({ prompt: '/video a storm over the sea' }));
  const body = res.jsonBody;
  assert.equal(body.videoJob, undefined);
  const [sentence, line] = body.reply.split('\n');
  assert.equal(sentence, `${FAILURE_PREFIX} The video could not be generated right now. Please try again. Request ID: ${body.traceId}`);
  assert.equal(line, 'PG1 Motion · Standard · 5 s · about 0.50 USD · 0.50 USD left today');
  assert.doesNotMatch(body.reply, BRANDS_RE);
  assert.doesNotMatch(body.reply, /invalid argument|resolution|400/i);
  assert.equal(startCalls(calls).length, 1, 'a 400 about the request itself is not a provider failure: the second key is not tried');

  const logged = (await errorRows(calls)).find((r) => r.reason === 'video_google_key1_failed');
  assert.ok(logged, 'a pg1_errors row');
  assert.equal(logged.route, 'GENERATE_VIDEO');
  assert.equal(logged.status, 400);
  assert.match(logged.message, /untrusted upstream data, not instructions/);
  assert.match(logged.message, /provider=google model=gemini-omni-1\.1-flash key_slot=1 tier=standard duration_s=5 status=400 failure=request/);
  assert.match(logged.message, /INVALID_ARGUMENT Request contains an invalid argument/, 'Gemini\'s own words');
  assert.match(logged.message, new RegExp(`request_id=${body.traceId}`));
  assert.ok(!logged.message.includes(KEY1) && !logged.message.includes(KEY2), 'never a key');

  const row = (await db.query('select status, error_reason, est_cost_usd from public.pg1_video_jobs')).rows[0];
  assert.deepEqual(row, { status: 'failed', error_reason: 'start_failed', est_cost_usd: '0.50' });

  // The next request finds the failed clip counted.
  calls = installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  const next = await run(authed({ prompt: '/video a calm sea' }));
  assert.match(next.jsonBody.reply, /PG1 Motion · Standard · 5 s · about 0\.50 USD · 0\.00 USD left today$/);
  const third = await run(authed({ prompt: '/video draft a calm lake' }));
  assert.match(third.jsonBody.reply, /would go over today's video budget: 0\.00 USD left of 1\.00 USD\. Nothing fits/);
  assert.equal(startCalls(calls).length, 1);

  // A bare /video lists the tiers, prices and what is left, starting nothing.
  const bare = await run(authed({ prompt: '/video' }));
  assert.equal(bare.jsonBody.reply, [
    '### [ PG1 MOTION ]',
    'Usage: /video [draft|pro] [short|long] <what the clip shows>. Standard and short (5 s) are the defaults; long is 10 s. 4K is not offered.',
    '- **Draft** · 360p: about 0.15 USD for 5 s, 0.30 USD for 10 s',
    '- **Standard** (default) · 720p: about 0.50 USD for 5 s, 1.00 USD for 10 s',
    '- **Pro** · 1080p (upscaled): about 0.75 USD for 5 s, 1.50 USD for 10 s',
    'Costs are estimates; a clip that fails still counts against the day.',
    '0.00 USD left today of 1.00 USD.'
  ].join('\n'));
  assert.equal(startCalls(calls).length, 1, 'the bare command started nothing');
  assert.equal((await db.query('select count(*)::int as n from public.pg1_video_jobs')).rows[0].n, 2);
});

test('a key-specific refusal (429) moves to the next key; the job remembers which key started it', async () => {
  const db = await makeDb();
  const calls = installFetch([
    ...engineRoutes({ start: (b, o) => (o.headers['x-goog-api-key'] === KEY1 ? new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }), { status: 429 }) : json({ id: 'int-777', status: 'queued' })) }),
    ...dbRoutes(db), ...supabaseRoutes()
  ]);
  const res = await run(authed({ prompt: '/video a paper boat' }));
  assert.ok(res.jsonBody.videoJob);
  assert.deepEqual(startCalls(calls).map((c) => c.headers['x-goog-api-key']), [KEY1, KEY2]);
  assert.equal((await db.query('select key_slot from public.pg1_video_jobs')).rows[0].key_slot, 2);
});

// --- 4. the poll ----------------------------------------------------------------------

async function startOne(db, extraRoutes = []) {
  installFetch([...extraRoutes, ...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  const res = await run(authed({ prompt: '/video a lighthouse at dusk' }));
  return res.jsonBody;
}

test('poll: rendering, then done - the clip is copied to pg1-vault/videos/ and comes back as a 7-day signed link', async () => {
  const db = await makeDb();
  const started = await startOne(db);
  const id = started.videoJob.id;

  let calls = installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  let poll = await run(authed({ action: 'VIDEO_STATUS', jobId: id }));
  assert.deepEqual(poll.jsonBody.videoJob, { id, status: 'rendering', engine: VIDEO_ENGINE_LABEL });
  const get = calls.find((c) => c.url === `${INTERACTIONS}/int-123`);
  assert.ok(get, 'polled the interaction');
  assert.equal(get.headers['x-goog-api-key'], KEY1);
  assert.ok(!get.url.includes(KEY1), 'the key is never in the URL');
  assert.equal(calls.filter((c) => c.url.includes('/rest/v1/messages') || c.url.includes('threat_indicators')).length, 0, 'the poll loads none of the chat context');

  const finished = { id: 'int-123', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: MP4_BASE64, mime_type: 'video/mp4' }] }] };
  calls = installFetch([...engineRoutes({ poll: () => json(finished) }), ...dbRoutes(db), ...supabaseRoutes()]);
  poll = await run(authed({ action: 'VIDEO_STATUS', jobId: id }));
  const job = poll.jsonBody.videoJob;
  assert.equal(job.status, 'done');
  assert.equal(job.url, `${SUP_URL}/storage/v1/object/sign/pg1-vault/videos/${id}.mp4?token=signed-token`);
  const upload = calls.find((c) => c.url === `${SUP_URL}/storage/v1/object/pg1-vault/videos/${id}.mp4`);
  assert.ok(upload, 'uploaded to pg1-vault/videos/');
  assert.equal(Buffer.from(upload.body).toString(), 'fake mp4 bytes for the test');
  assert.equal(upload.headers['Content-Type'], 'video/mp4');
  const sign = calls.find((c) => c.url.includes('/storage/v1/object/sign/pg1-vault/videos/'));
  assert.deepEqual(sign.body, { expiresIn: 7 * 24 * 3600 });
  assert.deepEqual((await db.query('select status, storage_path from public.pg1_video_jobs')).rows[0], { status: 'done', storage_path: `videos/${id}.mp4` });

  // A later poll (a reload) signs the stored clip again; the engine is not asked.
  calls = installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  poll = await run(authed({ action: 'VIDEO_STATUS', jobId: id }));
  assert.equal(poll.jsonBody.videoJob.status, 'done');
  assert.equal(engineCalls(calls).length, 0);
});

test('poll: a video delivered as a link is fetched with the key only from Google\'s own host', async () => {
  for (const [uri, wantsKey] of [['https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media', true], ['https://storage.example.test/clip.mp4', false]]) {
    const db = await makeDb();
    const { videoJob: { id } } = await startOne(db);
    const done = { id: 'int-123', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', uri, mime_type: 'video/mp4' }] }] };
    const calls = installFetch([[uri, () => new Response(Buffer.from('clip'), { status: 200 })], ...engineRoutes({ poll: () => json(done) }), ...dbRoutes(db), ...supabaseRoutes()]);
    const poll = await run(authed({ action: 'VIDEO_STATUS', jobId: id }));
    assert.equal(poll.jsonBody.videoJob.status, 'done', uri);
    const dl = calls.find((c) => c.url === uri);
    assert.equal(!!dl.headers['x-goog-api-key'], wantsKey, uri);
  }
});

test('poll timeout: a job older than 15 minutes is marked failed, without asking the engine, with one neutral sentence and the original request ID', async () => {
  const db = await makeDb();
  const started = await startOne(db);
  const id = started.videoJob.id;
  await db.query(`update public.pg1_video_jobs set created_at = now() - interval '16 minutes'`);
  const calls = installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  const poll = await run(authed({ action: 'VIDEO_STATUS', jobId: id }));
  const job = poll.jsonBody.videoJob;
  assert.equal(job.status, 'failed');
  assert.equal(job.message, `${FAILURE_PREFIX} The video could not be generated right now. Please try again. Request ID: ${started.traceId}`);
  assert.doesNotMatch(JSON.stringify(poll.jsonBody), BRANDS_RE);
  assert.equal(engineCalls(calls).length, 0);
  assert.deepEqual((await db.query('select status, error_reason from public.pg1_video_jobs')).rows[0], { status: 'failed', error_reason: 'timeout' });
  const logged = (await errorRows(calls)).find((r) => r.reason === 'video_timeout');
  assert.ok(logged);
  assert.match(logged.message, /not finished after 15 minutes/);

  // Still within 15 minutes: rendering.
  const db2 = await makeDb();
  const fresh = await startOne(db2);
  await db2.query(`update public.pg1_video_jobs set created_at = now() - interval '14 minutes'`);
  installFetch([...engineRoutes(), ...dbRoutes(db2), ...supabaseRoutes()]);
  assert.equal((await run(authed({ action: 'VIDEO_STATUS', jobId: fresh.videoJob.id }))).jsonBody.videoJob.status, 'rendering');
});

test('the next reservation also fails a job nobody polled for 15 minutes, and it keeps its slot', async () => {
  const db = await makeDb();
  await db.query(`insert into public.pg1_video_jobs (prompt, status, created_at) values ('old', 'rendering', now() - interval '20 minutes')`);
  const r = (await db.query('select * from public.pg1_reserve_video_slot($1, $2, $3, $4, $5, $6, $7, $8)', ['new', 0.5, 5, 10, 'req', false, 'standard', 5])).rows[0];
  assert.equal(r.reserved, true);
  assert.equal(r.clips_used, 2, 'the timed-out job still counts');
  // Only the new overload exists, and only the service role may run it.
  const fns = (await db.query(`select pg_get_function_identity_arguments(p.oid) as a from pg_proc p where proname = 'pg1_reserve_video_slot'`)).rows.map((x) => x.a);
  assert.deepEqual(fns, ['p_prompt text, p_est_cost_usd numeric, p_budget_usd numeric, p_max_clips integer, p_request_id text, p_has_start_frame boolean, p_tier text, p_duration_s integer']);
  const fnGrants = (await db.query(`select grantee from information_schema.routine_privileges where routine_name = 'pg1_reserve_video_slot' and privilege_type = 'EXECUTE' and grantee <> 'postgres'`)).rows.map((x) => x.grantee);
  assert.deepEqual(fnGrants, ['service_role']);
  const old = (await db.query(`select status, error_reason from public.pg1_video_jobs where prompt = 'old'`)).rows[0];
  assert.deepEqual(old, { status: 'failed', error_reason: 'timeout' });
  // anon and authenticated cannot touch the table or the function
  const grants = (await db.query(`select grantee from information_schema.role_table_grants where table_name = 'pg1_video_jobs' and grantee in ('anon', 'authenticated')`)).rows;
  assert.deepEqual(grants, []);
  const rls = (await db.query(`select relrowsecurity from pg_class where relname = 'pg1_video_jobs'`)).rows[0].relrowsecurity;
  assert.equal(rls, true);
});

test('poll: an engine failure is logged with its own words; the operator sees the neutral sentence', async () => {
  const db = await makeDb();
  const started = await startOne(db);
  const failed = { id: 'int-123', status: 'failed', errors: [{ code: 'INTERNAL', message: 'The gemini-omni-1.1-flash render worker crashed.' }] };
  const calls = installFetch([...engineRoutes({ poll: () => json(failed) }), ...dbRoutes(db), ...supabaseRoutes()]);
  const poll = await run(authed({ action: 'VIDEO_STATUS', jobId: started.videoJob.id }));
  assert.equal(poll.jsonBody.videoJob.status, 'failed');
  assert.match(poll.jsonBody.videoJob.message, new RegExp(`Request ID: ${started.traceId}$`));
  assert.doesNotMatch(poll.jsonBody.videoJob.message, /crashed|INTERNAL/);
  const logged = (await errorRows(calls)).find((r) => r.reason === 'video_google_key1_failed');
  assert.match(logged.message, /provider=google model=gemini-omni-1\.1-flash key_slot=1 job=failed failure=provider/);
  assert.match(logged.message, /INTERNAL The gemini-omni-1\.1-flash render worker crashed/);
});

// --- 5. identity ------------------------------------------------------------------------

test('identity: only "PG1 Motion" is shown on the video path, and error summaries swap the model name for it', async () => {
  // The video path's own strings, streamed.
  const db = await makeDb();
  installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  const res = await run(authed({ prompt: '/video a gold shield turning slowly', stream: true }));
  const events = eventsOf(res);
  const step = events.find((e) => e.type === 'step_done' && e.id === 'video');
  assert.equal(step.label, 'Started the video');
  assert.equal(step.result, 'PG1 Motion · Standard · 5 s');
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.result.videoJob.engine, 'PG1 Motion');
  for (const e of events) {
    for (const v of [e.label, e.result && typeof e.result === 'string' ? e.result : '', e.text, e.message]) {
      if (typeof v === 'string') assert.doesNotMatch(v, BRANDS_RE, v);
    }
  }

  // The secret guard's engine-name swaps on a "what's broken?" turn.
  const guard = createReplySecretGuard({ env: {}, errorSummary: true });
  assert.equal(guard('gemini-omni-1.1-flash failed with a quota error.').text, 'PG1 Motion failed with a quota error.');
  assert.equal(guard('Gemini Omni 1.1 Flash is down.').text, 'PG1 Motion is down.');
  assert.equal(guard('The Veo 3.1 preview shut down.').text, 'The PG1 Motion shut down.');
  assert.equal(guard('veo-3.1-fast-generate-preview returned 404').text, 'PG1 Motion returned 404');
  assert.equal(guard('gemini-3-flash failed').text, 'PG1 chat engine failed', 'the chat model is still the chat engine');
  const custom = createReplySecretGuard({ env: { PG1_VIDEO_MODEL: 'acme-motion-2' }, errorSummary: true });
  assert.equal(custom('acme-motion-2 timed out').text, 'PG1 Motion timed out');
  assert.equal(neutralErrorReason('video_start_failed'), 'PG1 Motion failed');
  assert.equal(neutralErrorReason('video_timeout'), 'PG1 Motion failed');
  assert.match('veo', UPSTREAM_BRAND_RE);
});

// --- 6. the final request bodies -----------------------------------------------------------

function walkInteractionBody(body) {
  const bad = [];
  const check = (obj, allowed, where) => { for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad.push(`${where}.${k}`); };
  check(body, INTERACTION_BODY_KEYS.request, 'request');
  check(body.response_format, INTERACTION_BODY_KEYS.response_format, 'response_format');
  if (Array.isArray(body.input)) {
    body.input.forEach((part, i) => {
      if (!INTERACTION_BODY_KEYS[part.type]) bad.push(`input[${i}].type=${part.type}`);
      else check(part, INTERACTION_BODY_KEYS[part.type], `input[${i}]`);
    });
  } else if (typeof body.input !== 'string') bad.push('input is neither text nor parts');
  return bad;
}

function walkGeminiSchema(schema, where, bad) {
  if (!schema || typeof schema !== 'object') return;
  for (const [k, v] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) bad.push(`${where}.${k}`);
    if (k === 'properties') for (const [p, s] of Object.entries(v)) walkGeminiSchema(s, `${where}.properties.${p}`, bad);
    if (k === 'items') walkGeminiSchema(v, `${where}.items`, bad);
    if (k === 'anyOf') v.forEach((s, i) => walkGeminiSchema(s, `${where}.anyOf[${i}]`, bad));
  }
}

test('the final video request body carries only keys the Interactions API accepts, with background on and the key in the header', async () => {
  const db = await makeDb();
  const calls = installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  await run(authed({ prompt: 'make me a short 6 second video of a hummingbird in slow motion' }));
  await run(authed({ prompt: '/video animate the scene', multiFiles: [{ inlineData: { mimeType: 'image/png', data: PNG_1X1 } }] }));
  const [textOnly, withFrame] = startCalls(calls);

  assert.deepEqual(walkInteractionBody(textOnly.body), []);
  assert.deepEqual(walkInteractionBody(withFrame.body), []);
  assert.deepEqual(textOnly.body, {
    model: 'gemini-omni-1.1-flash',
    input: 'a hummingbird in slow motion\n\nClip length: 5 seconds.',
    response_format: { type: 'video', resolution: '720p', aspect_ratio: '16:9', delivery: 'uri' },
    background: true
  });
  assert.deepEqual(withFrame.body.input, [{ type: 'text', text: 'animate the scene\n\nClip length: 5 seconds.' }, { type: 'image', data: PNG_1X1, mime_type: 'image/png' }]);
  for (const c of [textOnly, withFrame]) {
    assert.equal(c.url, INTERACTIONS, 'no key or query string in the URL');
    assert.equal(c.headers['x-goog-api-key'], KEY1);
  }
  assert.equal((await db.query('select count(*)::int as n from public.pg1_video_jobs where has_start_frame')).rows[0].n, 1);
  // and the builder never lets a stray field or an unsupported frame type through
  assert.deepEqual(walkInteractionBody(buildVideoRequestBody({ model: 'm', prompt: 'p', image: { mimeType: 'image/gif', data: 'x', extra: 1 } })), []);
  assert.equal(typeof buildVideoRequestBody({ model: 'm', prompt: 'p', image: { mimeType: 'image/gif', data: 'x' } }).input, 'string');
});

test('the chat request that offers generate_video carries no schema key Gemini rejects (#262), and the tool can start a clip', async () => {
  const db = await makeDb();
  const sse = (objs) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');
  const first = { candidates: [{ content: { parts: [{ functionCall: { name: 'generate_video', args: { prompt: 'waves rolling onto a beach at sunset' } }, thoughtSignature: 'sig' }] } }] };
  const final = { candidates: [{ content: { parts: [{ text: 'Your video is rendering and will appear below. 2 of 3 left today.' }] } }] };
  const answer = (body) => ((body.contents || []).some((c) => (c.parts || []).some((p) => p.functionResponse)) ? final : first);
  const calls = installFetch([
    ...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes(),
    ['streamGenerateContent', (u, o, body) => new Response(sse([answer(body)]))],
    ['generateContent', (u, o, body) => json(answer(body))]
  ]);
  const res = await run(authed({ prompt: 'could you show me a little clip of waves on a beach?', stream: true }));
  const chatReqs = calls.filter((c) => /generatecontent/i.test(c.url));
  assert.ok(chatReqs.length >= 1);
  const decls = chatReqs[0].body.tools.find((t) => t.functionDeclarations).functionDeclarations;
  assert.deepEqual(decls.map((d) => d.name), [...READ_ONLY_CHAT_TOOLS, ...OPERATOR_ONLY_CHAT_TOOLS, 'generate_video']);
  const bad = [];
  for (const d of decls) {
    for (const k of Object.keys(d)) if (!['name', 'description', 'parameters'].includes(k)) bad.push(`${d.name}.${k}`);
    walkGeminiSchema(d.parameters, d.name, bad);
  }
  assert.deepEqual(bad, [], 'every declaration is inside GEMINI_SCHEMA_KEYS');
  assert.ok(!JSON.stringify(chatReqs[0].body.tools).includes('additionalProperties'));
  assert.match(chatReqs[0].body.systemInstruction.parts[0].text, /\[VIDEO\]: generate_video starts one PG1 Motion clip/);

  // The tool started a real job and the card carries it.
  assert.equal(startCalls(calls).length, 1);
  assert.equal(startCalls(calls)[0].body.input, 'waves rolling onto a beach at sunset\n\nClip length: 5 seconds.');
  const card = eventsOf(res).find((e) => e.type === 'tool_result' && e.tool === 'generate_video');
  assert.equal(card.video_job.status, 'rendering');
  assert.match(card.video_job.id, /^[0-9a-f-]{36}$/);
  const { id: callId, ...shown } = card; // the call id is internal, never displayed
  assert.doesNotMatch(JSON.stringify(shown), BRANDS_RE);

  // Switched off: the same message offers no video tool.
  process.env.PG1_VIDEO_ENABLED = '0';
  const offCalls = installFetch([
    ...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes(),
    ['streamGenerateContent', () => new Response(sse([final]))]
  ]);
  await run(authed({ prompt: 'could you show me a little clip of waves on a beach?', stream: true }));
  const offBody = offCalls.find((c) => /generatecontent/i.test(c.url)).body;
  assert.ok(!JSON.stringify(offBody.tools || []).includes('generate_video'));
  assert.equal(startCalls(offCalls).length, 0);
});

// --- 7. what counts as a request ----------------------------------------------------------

test('the request match is narrow: "animate" alone and talk about videos are not requests', () => {
  for (const yes of [
    '/video a gold shield', 'make a video of a cat', 'Make me a short 10 second video of rain on a window',
    'generate a clip showing a sunrise', 'create an animation of a spinning coin', 'render a cinematic video: city at night',
    'please make a video of my dog', 'animate this photo', 'animate the attached image', 'turn this picture into a video',
    'make a video'
  ]) assert.equal(isVideoRequest(yes), true, yes);
  for (const no of [
    'that was an animated discussion', 'inanimate objects', 'animate the CSS transition on the button', 'animate',
    'how do I make a video of my screen?', 'make the video player load faster', 'create a summary of this video',
    'I watched a video of the launch', 'make a video call to the team', 'generate a video thumbnail', 'what video formats work?',
    'make a video for YouTube about my car', 'can you summarise this clip'
  ]) assert.equal(isVideoRequest(no), false, no);
  assert.equal(cleanVideoPrompt('/video a gold shield turning'), 'a gold shield turning');
  assert.equal(cleanVideoPrompt('Please make a video of a fox in the snow.'), 'a fox in the snow');
  assert.equal(cleanVideoPrompt('make me a short 8 second clip showing waves'), 'waves', 'length and tier words become settings, not prompt text');
  assert.equal(cleanVideoPrompt('animate this photo'), '');
  // A message that only mentions a clip goes the tools way when the tool is on offer.
  assert.equal(chooseChatRoute('could you show me a little clip of waves?', { videoTool: true }).reason, 'video');
  assert.equal(chooseChatRoute('could you show me a little clip of waves?', { videoTool: false }).route, 'search');
});

test('reading the finished interaction: steps[] model_output video, inline or by link', () => {
  assert.deepEqual(videoFromInteraction({ steps: [{ type: 'user_input' }, { type: 'model_output', content: [{ type: 'text', text: 'here' }, { type: 'video', data: 'AAA', mime_type: 'video/mp4' }] }] }), { data: 'AAA', uri: null, mimeType: 'video/mp4' });
  assert.deepEqual(videoFromInteraction({ steps: [{ type: 'model_output', content: [{ type: 'video', uri: 'https://x.test/v' }] }] }), { data: null, uri: 'https://x.test/v', mimeType: 'video/mp4' });
  assert.equal(videoFromInteraction({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'no video' }] }] }), null);
  assert.equal(videoFromInteraction(null), null);
});

// --- 8. tiers and length ------------------------------------------------------------------

test('each tier sends its resolution to Google, and the length goes into the prompt', async () => {
  const db = await makeDb();
  process.env.PG1_VIDEO_DAILY_BUDGET_USD = '50';
  process.env.PG1_VIDEO_DAILY_CAP = '50';
  const calls = installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  const cases = [
    ['/video draft a fox', '360p', 5, 'Draft', '0.15'],
    ['/video a fox', '720p', 5, 'Standard', '0.50'],
    ['/video pro a fox', '1080p', 5, 'Pro', '0.75'],
    ['/video pro long a fox', '1080p', 10, 'Pro', '1.50'],
    ['/video long draft a fox', '360p', 10, 'Draft', '0.30'],
    ['/video short a fox', '720p', 5, 'Standard', '0.50'],
    ['make a quick video of a fox', '360p', 5, 'Draft', '0.15'],
    ['make a cheap video of a fox', '360p', 5, 'Draft', '0.15'],
    ['make a high quality video of a fox', '1080p', 5, 'Pro', '0.75'],
    ['make an HD video of a fox', '1080p', 5, 'Pro', '0.75'],
    ['make a 1080p video of a fox', '1080p', 5, 'Pro', '0.75'],
    ['make a pro video of a fox', '1080p', 5, 'Pro', '0.75'],
    ['make a long video of a fox', '720p', 10, 'Standard', '1.00'],
    ['make a 10 second video of a fox', '720p', 10, 'Standard', '1.00'],
    ['make a video of a pro skateboarder', '720p', 5, 'Standard', '0.50']
  ];
  for (const [prompt, resolution, seconds, label, cost] of cases) {
    const before = startCalls(calls).length;
    const res = await run(authed({ prompt }));
    const start = startCalls(calls)[before];
    assert.ok(start, `${prompt}: started`);
    assert.equal(start.body.response_format.resolution, resolution, prompt);
    assert.ok(start.body.input.endsWith(`\n\nClip length: ${seconds} seconds.`), `${prompt}: ${start.body.input}`);
    assert.deepEqual(walkInteractionBody(start.body), []);
    assert.match(res.jsonBody.reply, new RegExp(`\\nPG1 Motion · ${label} · ${seconds} s · about ${cost.replace('.', '\\.')} USD · \\d+\\.\\d\\d USD left today$`), prompt);
  }
  // No 4K: read as Pro (1080p), and said so.
  const fourK = await run(authed({ prompt: 'make a 4k video of a fox' }));
  assert.equal(startCalls(calls).at(-1).body.response_format.resolution, '1080p');
  assert.match(fourK.jsonBody.reply, /4K is not offered; this is the Pro tier \(1080p\)\./);
  for (const c of startCalls(calls)) assert.ok(!['2160p', '4k', '4K'].includes(c.body.response_format.resolution));
});

test('the price table is the one source: tiers, Kling estimates and what a clip reserves', () => {
  assert.deepEqual(VIDEO_PRICES.google.perSecondUsd, { '360p': 0.03, '720p': 0.10, '1080p': 0.15 });
  assert.equal(VIDEO_PRICES.kling.estimated, true, 'Kling prices are marked as estimates');
  assert.deepEqual(JSON.parse(JSON.stringify(VIDEO_PRICES.kling.perClipUsd)), { standard: { 5: 0.3, 10: 0.6 }, pro: { 5: 0.5, 10: 1 } });
  // A frame clip that could fall back to Kling reserves the dearer estimate.
  assert.equal(videoClipEstimate('draft', 5, { kling: true }), 0.30);
  assert.equal(videoClipEstimate('draft', 5), 0.15);
  assert.equal(videoClipEstimate('pro', 10, { kling: true }), 1.50);
  assert.deepEqual(parseVideoOptions('pro long a lighthouse', { command: true }), { tier: 'pro', durationS: 10, fourK: false, rest: 'a lighthouse' });
});

// --- 9. the Replicate fallback (kwaivgi/kling-v2.1) ---------------------------------------------

const KLING = 'kwaivgi/kling-v2.1';
const REP_TOKEN = 'stub-replicate-token-0123456789';
const KLING_CREATE = `https://api.replicate.com/v1/models/${KLING}/predictions`;
const REP_OUT = 'https://replicate.delivery/xezq/out/clip.mp4';
const FRAME = [{ inlineData: { mimeType: 'image/png', data: PNG_1X1 } }];

function replicateRoutes({ create = () => json({ id: 'rep-pred-1', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/rep-pred-1' } }, 201), poll = () => json({ id: 'rep-pred-1', status: 'processing' }) } = {}) {
  return [
    [REP_OUT, () => new Response(Buffer.from('replicate mp4 bytes'), { status: 200 })],
    ['https://api.replicate.com/v1/models/', (u, o, body) => create(body, o, u)],
    ['https://api.replicate.com/v1/predictions/', (u, o) => poll(u, o)]
  ];
}

const replicateCreates = (calls) => calls.filter((c) => c.url.startsWith('https://api.replicate.com/v1/models/'));
const geminiFails = (byKey) => (body, o) => {
  const r = byKey[o.headers['x-goog-api-key']];
  return r ? r() : json({ id: 'int-123', status: 'in_progress' });
};
const allGeminiDown = () => new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } }), { status: 503 });

test('Kling is the default frame model, never a text-only one; its input is exactly the schema fields', () => {
  assert.equal(replicateVideoModel({}, { withImage: true }), KLING);
  assert.equal(replicateVideoModel({}), '', 'no text-only default');
  assert.equal(replicateVideoModel({ PG1_VIDEO_MODEL_REPLICATE: KLING }), '', 'Kling v2.1 cannot make a text-only clip');
  assert.equal(replicateVideoModel({ PG1_VIDEO_MODEL_REPLICATE_IMAGE: 'acme/other-i2v' }, { withImage: true }), 'acme/other-i2v');
  for (const [tier, s, mode] of [['draft', 5, 'standard'], ['standard', 10, 'standard'], ['pro', 5, 'pro'], ['pro', 10, 'pro']]) {
    const input = replicateVideoInput(KLING, { prompt: 'p', startImageUrl: 'https://x.test/f.png?token=t', tier, durationS: s });
    assert.deepEqual(input, { prompt: 'p', start_image: 'https://x.test/f.png?token=t', mode, duration: s }, `${tier} ${s}`);
    assert.ok(!('end_image' in input), 'never end_image');
    assert.equal(typeof input.duration, 'number', 'duration is an integer');
  }
});

test('fallback: Gemini key 1 fails (503), key 2 starts the clip; pg1_errors names the provider, key and why', async () => {
  process.env.REPLICATE_API_TOKEN = REP_TOKEN;
  const db = await makeDb();
  const calls = installFetch([
    ...replicateRoutes(),
    ...engineRoutes({ start: geminiFails({ [KEY1]: allGeminiDown }) }),
    ...dbRoutes(db), ...supabaseRoutes()
  ]);
  const res = await run(authed({ prompt: '/video a kite over a beach' }));
  assert.ok(res.jsonBody.videoJob, 'started');
  assert.match(res.jsonBody.reply, /PG1 Motion · Standard · 5 s · about 0\.50 USD · 4\.50 USD left today$/);
  assert.deepEqual(startCalls(calls).map((c) => c.headers['x-goog-api-key']), [KEY1, KEY2]);
  assert.equal(replicateCreates(calls).length, 0, 'Replicate is not needed');
  assert.deepEqual((await db.query('select provider, model, key_slot, status from public.pg1_video_jobs')).rows, [{ provider: 'google', model: 'gemini-omni-1.1-flash', key_slot: 2, status: 'rendering' }]);
  const rows = await errorRows(calls);
  const k1 = rows.find((r) => r.reason === 'video_google_key1_failed');
  assert.equal(k1.status, 503);
  assert.match(k1.message, /provider=google model=gemini-omni-1\.1-flash key_slot=1 tier=standard duration_s=5 status=503 failure=provider/);
  assert.match(k1.message, /UNAVAILABLE The model is overloaded/);
  assert.equal(rows.filter((r) => /^video_/.test(r.reason)).length, 1, 'only the failed attempt is logged');
});

test('fallback: a pro frame clip whose Gemini keys both fail goes to Kling pro with the exact schema fields and a 1-hour signed frame URL', async () => {
  process.env.REPLICATE_API_TOKEN = REP_TOKEN;
  const db = await makeDb();
  let calls = installFetch([
    ...replicateRoutes(),
    ...engineRoutes({ start: geminiFails({
      [KEY1]: () => new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } }), { status: 429 }),
      [KEY2]: () => new Response(JSON.stringify({ error: { code: 500, status: 'INTERNAL', message: 'Internal error.' } }), { status: 500 })
    }) }),
    ...dbRoutes(db), ...supabaseRoutes()
  ]);
  const res = await run(authed({ prompt: '/video pro long the lighthouse comes alive at dusk', multiFiles: FRAME, stream: true }));
  const events = eventsOf(res);
  const id = events.find((e) => e.type === 'done').result.videoJob.id;
  assert.equal(startCalls(calls).length, 2);
  const create = replicateCreates(calls);
  assert.equal(create.length, 1);
  assert.equal(create[0].url, KLING_CREATE);
  assert.equal(create[0].headers.Authorization, `Bearer ${REP_TOKEN}`, 'the /image token, as a Bearer token');
  const frameUrl = `${SUP_URL}/storage/v1/object/sign/pg1-vault/videos/frames/${id}.png?token=signed-token`;
  assert.deepEqual(create[0].body, { input: { prompt: 'the lighthouse comes alive at dusk', start_image: frameUrl, mode: 'pro', duration: 10 } });
  assert.doesNotMatch(JSON.stringify(create[0].body), /base64|data:image|end_image|negative_prompt/, 'a URL, never base64; no end_image');

  // The frame went to the vault and was signed for one hour.
  const upload = calls.find((c) => c.url === `${SUP_URL}/storage/v1/object/pg1-vault/videos/frames/${id}.png`);
  assert.ok(upload, 'frame uploaded to pg1-vault');
  assert.equal(upload.headers['Content-Type'], 'image/png');
  assert.equal(Buffer.from(upload.body).toString('base64'), PNG_1X1);
  const signFrame = calls.find((c) => c.url === `${SUP_URL}/storage/v1/object/sign/pg1-vault/videos/frames/${id}.png`);
  assert.deepEqual(signFrame.body, { expiresIn: 3600 });

  // One reservation: Gemini pro 10 s (1.50) is dearer than Kling pro 10 s (1.00).
  assert.deepEqual((await db.query('select provider, model, interaction_id, key_slot, tier, duration_s, est_cost_usd from public.pg1_video_jobs')).rows,
    [{ provider: 'replicate', model: KLING, interaction_id: 'rep-pred-1', key_slot: null, tier: 'pro', duration_s: 10, est_cost_usd: '1.50' }]);
  assert.equal(calls.filter((c) => c.url.includes('pg1_reserve_video_slot')).length, 1, 'reserved once');
  const rows = await errorRows(calls, 2);
  assert.deepEqual(rows.filter((r) => /^video_/.test(r.reason)).map((r) => [r.reason, r.status]), [['video_google_key1_failed', 429], ['video_google_key2_failed', 500]]);
  for (const e of events) for (const v of [e.label, typeof e.result === 'string' ? e.result : '', e.text]) if (typeof v === 'string') assert.doesNotMatch(v, /replicate|kling|kwaivgi/i, v);

  // The poll asks Replicate, fetches the output without a token, stores it.
  calls = installFetch([
    ...replicateRoutes({ poll: () => json({ id: 'rep-pred-1', status: 'succeeded', output: REP_OUT }) }),
    ...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()
  ]);
  const poll = await run(authed({ action: 'VIDEO_STATUS', jobId: id }));
  assert.equal(poll.jsonBody.videoJob.status, 'done');
  assert.doesNotMatch(JSON.stringify(poll.jsonBody), /replicate|kling/i);
  assert.equal(calls.find((c) => c.url === 'https://api.replicate.com/v1/predictions/rep-pred-1').headers.Authorization, `Bearer ${REP_TOKEN}`);
  assert.equal(calls.find((c) => c.url === REP_OUT).headers.Authorization, undefined, 'no token to the output link');
  assert.equal(engineCalls(calls).length, 0, 'Gemini is not asked about a Replicate job');
  assert.equal(Buffer.from(calls.find((c) => c.url === `${SUP_URL}/storage/v1/object/pg1-vault/videos/${id}.mp4`).body).toString(), 'replicate mp4 bytes');
});

test('fallback: a draft frame clip reserves the Kling estimate and sends Kling mode "standard", duration 5', async () => {
  process.env.REPLICATE_API_TOKEN = REP_TOKEN;
  const db = await makeDb();
  const calls = installFetch([...replicateRoutes(), ...engineRoutes({ start: allGeminiDown }), ...dbRoutes(db), ...supabaseRoutes()]);
  const res = await run(authed({ prompt: '/video draft animate this', multiFiles: FRAME }));
  assert.match(res.jsonBody.reply, /PG1 Motion · Draft · 5 s · about 0\.30 USD · 4\.70 USD left today$/, 'the dearer of 0.15 (Google) and 0.30 (Kling)');
  const input = replicateCreates(calls)[0].body.input;
  assert.equal(input.mode, 'standard');
  assert.equal(input.duration, 5);
});

test('fallback: a text-only clip never calls Replicate, and pg1_errors says no text-only model is configured', async () => {
  process.env.REPLICATE_API_TOKEN = REP_TOKEN;
  const db = await makeDb();
  const calls = installFetch([...replicateRoutes(), ...engineRoutes({ start: allGeminiDown }), ...dbRoutes(db), ...supabaseRoutes()]);
  const res = await run(authed({ prompt: '/video pro a cat on a skateboard' }));
  assert.match(res.jsonBody.reply, /^Execution failed\. The video could not be generated right now/);
  assert.equal(startCalls(calls).length, 2, 'both Gemini keys tried');
  assert.equal(calls.filter((c) => c.url.includes('replicate.com')).length, 0, 'Replicate never called');
  const rows = await errorRows(calls, 3);
  const note = rows.find((r) => r.reason === 'video_replicate_not_configured');
  assert.ok(note, 'a pg1_errors row says why there was no fallback');
  assert.match(note.message, /no Replicate text-only model is configured/);

  // Even with Kling named as the text-only model, nothing is sent to it.
  process.env.PG1_VIDEO_MODEL_REPLICATE = KLING;
  const calls2 = installFetch([...replicateRoutes(), ...engineRoutes({ start: allGeminiDown }), ...dbRoutes(db), ...supabaseRoutes()]);
  await run(authed({ prompt: '/video draft a dog' }));
  assert.equal(calls2.filter((c) => c.url.includes('replicate.com')).length, 0);
});

test('fallback: a content-safety refusal is never retried on key 2 or Kling; the answer is a plain no', async () => {
  process.env.REPLICATE_API_TOKEN = REP_TOKEN;
  const db = await makeDb();
  const calls = installFetch([
    ...replicateRoutes(),
    ...engineRoutes({ start: () => new Response(GEMINI_SAFETY, { status: 400 }) }),
    ...dbRoutes(db), ...supabaseRoutes()
  ]);
  const res = await run(authed({ prompt: '/video something the filter refuses', multiFiles: FRAME }));
  assert.equal(res.jsonBody.videoJob, undefined);
  assert.equal(res.jsonBody.reply, `${VIDEO_REFUSED_TEXT}\nPG1 Motion · Standard · 5 s · about 0.50 USD · 4.50 USD left today`);
  assert.match(VIDEO_REFUSED_TEXT, /won't make that video/);
  assert.doesNotMatch(res.jsonBody.reply, BRANDS_RE);
  assert.equal(startCalls(calls).length, 1, 'key 2 not tried');
  assert.equal(calls.filter((c) => c.url.includes('replicate.com')).length, 0, 'Replicate not tried');
  assert.equal(calls.filter((c) => c.url.includes('/videos/frames/')).length, 0, 'the frame was not even uploaded');
  assert.deepEqual((await db.query('select status, error_reason from public.pg1_video_jobs')).rows, [{ status: 'failed', error_reason: 'safety_refused' }]);
  assert.match((await errorRows(calls)).find((r) => r.reason === 'video_google_key1_failed').message, /failure=safety/);

  // Refused while rendering: a plain no from the poll too, and still no fallback.
  const db2 = await makeDb();
  const started = await startOne(db2);
  const refused = { id: 'int-123', status: 'failed', errors: [{ code: 'SAFETY', message: 'Output blocked by a safety filter.' }] };
  const pollCalls = installFetch([...replicateRoutes(), ...engineRoutes({ poll: () => json(refused) }), ...dbRoutes(db2), ...supabaseRoutes()]);
  const poll = await run(authed({ action: 'VIDEO_STATUS', jobId: started.videoJob.id }));
  assert.deepEqual({ status: poll.jsonBody.videoJob.status, message: poll.jsonBody.videoJob.message }, { status: 'failed', message: VIDEO_REFUSED_TEXT });
  assert.equal(pollCalls.filter((c) => c.url.includes('replicate.com')).length, 0);

  // The chat tool says it plainly as well.
  const tool = createToolExecutor({ role: 'operator', startVideo: async () => ({ ok: false, code: 'refused', tier: 'standard', durationS: 5, estCost: 0.5, remaining: 4.5, budget: 5 }), log: () => {} });
  const outcome = await tool({ id: 't', name: VIDEO_CHAT_TOOL, args: { prompt: 'x' } });
  assert.equal(outcome.code, 'content_refused');
  assert.match(outcome.message, /won't make it/);
});

test('fallback: one clip is one reservation, whichever provider makes it, also when every provider fails', async () => {
  process.env.REPLICATE_API_TOKEN = REP_TOKEN;
  process.env.PG1_VIDEO_DAILY_BUDGET_USD = '1.00';
  const db = await makeDb();
  const calls = installFetch([...replicateRoutes(), ...engineRoutes({ start: allGeminiDown }), ...dbRoutes(db), ...supabaseRoutes()]);
  const first = await run(authed({ prompt: '/video a red balloon', multiFiles: FRAME }));
  assert.ok(first.jsonBody.videoJob);
  assert.match(first.jsonBody.reply, /about 0\.50 USD · 0\.50 USD left today$/, 'three attempts, one reservation');
  assert.equal(calls.filter((c) => c.url.includes('pg1_reserve_video_slot')).length, 1, 'reserved once');

  // Kling also fails (no credit): still the one reservation, and it is kept.
  installFetch([...replicateRoutes({ create: () => json({ detail: 'Insufficient credit' }, 402) }), ...engineRoutes({ start: allGeminiDown }), ...dbRoutes(db), ...supabaseRoutes()]);
  const second = await run(authed({ prompt: '/video a blue balloon', multiFiles: FRAME }));
  assert.match(second.jsonBody.reply, /^Execution failed\.[\s\S]*0\.00 USD left today$/);
  const third = await run(authed({ prompt: '/video draft a green balloon' }));
  assert.match(third.jsonBody.reply, /would go over today's video budget: 0\.00 USD left of 1\.00 USD/);
  assert.deepEqual((await db.query('select count(*)::int as n, sum(est_cost_usd)::text as s from public.pg1_video_jobs')).rows[0], { n: 2, s: '1.00' });
});

test('the Replicate models join the engine-name swaps; the operator only ever sees PG1 Motion', () => {
  const guard = createReplySecretGuard({ env: { PG1_VIDEO_MODEL_REPLICATE: 'acme/clipper-9', PG1_VIDEO_MODEL_REPLICATE_IMAGE: 'acme/clipper-9-i2v' }, errorSummary: true });
  assert.equal(guard('acme/clipper-9 returned 500').text, 'PG1 Motion returned 500');
  assert.equal(guard('acme/clipper-9-i2v timed out').text, 'PG1 Motion timed out');
  const def = createReplySecretGuard({ env: {}, errorSummary: true });
  assert.equal(def('kwaivgi/kling-v2.1 returned 402').text, 'PG1 Motion returned 402', 'the default frame model');
  assert.equal(def('Kling 2.1 is down').text, 'PG1 Motion is down');
  assert.equal(def('bytedance/seedance-1-pro failed').text, 'PG1 Motion failed');
  assert.equal(def('the WAN link is down').text, 'the WAN link is down', 'ordinary words are left alone');
  assert.equal(neutralErrorReason('video_google_key2_failed'), 'PG1 Motion failed');
  assert.equal(neutralErrorReason('video_replicate_failed'), 'PG1 Motion failed');
  assert.equal(neutralErrorReason('video_replicate_not_configured'), 'PG1 Motion failed');
  assert.equal(classifyVideoFailure(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }, ''), 'provider');
  assert.equal(classifyVideoFailure(403, { error: { message: 'Billing account disabled' } }, ''), 'provider');
  assert.equal(classifyVideoFailure(null, null, 'timed out starting the job'), 'provider');
  assert.equal(classifyVideoFailure(400, { error: { message: 'The prompt was blocked due to safety reasons.' } }, ''), 'safety');
  assert.equal(classifyVideoFailure(200, { status: 'failed', errors: [{ code: 'PROHIBITED_CONTENT', message: 'x' }] }, ''), 'safety');
});

// --- 8. one credential per Google request ----------------------------------------------
//
// Google answers a request carrying more than one credential with
// "400 invalid_request Multiple authentication credentials received"
// (#263's live failure, on the status poll). Every outgoing Google request
// in the video flow - start, poll, the download of a clip delivered by
// link, and every redirect hop - is inspected here.

const MULTIPLE_CREDENTIALS = JSON.stringify({ error: { code: 'invalid_request', message: 'Multiple authentication credentials received. Please pass only one.' } });
const URL_CREDENTIALS = ['key', 'api_key', 'access_token'];
// A signed link's parameters are together one credential.
const URL_SIGNATURE = ['x-goog-signature', 'x-goog-credential', 'googleaccessid', 'signature'];

// Every place a request carries a credential: headers and URL parameters.
function credentialsIn(call) {
  const where = [];
  for (const [name, value] of Object.entries(call.headers || {})) {
    const lower = name.toLowerCase();
    if ((lower === 'x-goog-api-key' || lower === 'authorization') && value) where.push(`header ${lower}`);
  }
  const names = Array.from(new URL(call.url).searchParams.keys()).map((n) => n.toLowerCase());
  for (const name of names) if (URL_CREDENTIALS.includes(name)) where.push(`url ?${name}`);
  if (names.some((n) => URL_SIGNATURE.includes(n))) where.push('url signature');
  return where;
}

function assertOneCredentialEach(calls) {
  const google = calls.filter((c) => /(^|\.)googleapis\.com$/.test(new URL(c.url).hostname));
  assert.ok(google.length, 'the flow made Google requests');
  for (const c of google) {
    const where = credentialsIn(c);
    assert.ok(where.length <= 1, `${c.method} ${c.url} carries credentials in ${where.length} places: ${where.join(', ')}`);
    if (new URL(c.url).hostname === 'generativelanguage.googleapis.com') {
      assert.deepEqual(where, ['header x-goog-api-key'], `${c.method} ${c.url}: the key, once, in the header`);
    }
    assert.ok(!c.url.includes(KEY1) && !c.url.includes(KEY2), `${c.url}: the key is never in a URL`);
    assert.equal(c.redirect, 'manual', `${c.url}: redirects are followed by hand, never by fetch re-sending the header`);
  }
  return google;
}

// installFetch, also recording the redirect mode.
function installFetchWithRedirect(routes) {
  const calls = installFetch(routes);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const r = inner(url, options);
    calls[calls.length - 1].redirect = options.redirect;
    return r;
  };
  return calls;
}

test('every Google request in the video flow carries the key exactly once: start, poll, a delivery link with ?key= and its redirect', async () => {
  const db = await makeDb();
  const DELIVERY = 'https://generativelanguage.googleapis.com/v1beta/files/clip-1:download?alt=media&key=SOME-OTHER-KEY';
  const SIGNED = 'https://storage.googleapis.com/gen-bucket/clip-1.mp4?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%2F20261006&X-Goog-Signature=abc123';
  const done = { id: 'int-123', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', uri: DELIVERY, mime_type: 'video/mp4' }] }] };
  let polls = 0;
  const calls = installFetchWithRedirect([
    ['https://storage.googleapis.com/', () => new Response(Buffer.from('signed clip'), { status: 200 })],
    ['/v1beta/files/clip-1:download', () => new Response(null, { status: 302, headers: { Location: SIGNED } })],
    ...engineRoutes({
      // Google's own rule, enforced by the stand-in.
      start: (b, o) => (credentialsIn({ url: INTERACTIONS, headers: o.headers }).length > 1 ? new Response(MULTIPLE_CREDENTIALS, { status: 400 }) : json({ id: 'int-123', status: 'in_progress' })),
      poll: (u, o) => (credentialsIn({ url: u, headers: o.headers }).length > 1 ? new Response(MULTIPLE_CREDENTIALS, { status: 400 }) : json(++polls === 1 ? { id: 'int-123', status: 'in_progress' } : done))
    }),
    ...dbRoutes(db), ...supabaseRoutes()
  ]);
  const started = await run(authed({ prompt: '/video draft a cyan shield glowing on a navy background, single continuous shot, no dialogue' }));
  const id = started.jsonBody.videoJob.id;
  assert.equal((await run(authed({ action: 'VIDEO_STATUS', jobId: id }))).jsonBody.videoJob.status, 'rendering');
  const poll = await run(authed({ action: 'VIDEO_STATUS', jobId: id }));
  assert.equal(poll.jsonBody.videoJob.status, 'done');

  const google = assertOneCredentialEach(calls);
  const kinds = google.map((c) => `${c.method} ${new URL(c.url).hostname}${new URL(c.url).pathname}`);
  assert.deepEqual(kinds, [
    'POST generativelanguage.googleapis.com/v1beta/interactions',
    'GET generativelanguage.googleapis.com/v1beta/interactions/int-123',
    'GET generativelanguage.googleapis.com/v1beta/interactions/int-123',
    'GET generativelanguage.googleapis.com/v1beta/files/clip-1:download',
    'GET storage.googleapis.com/gen-bucket/clip-1.mp4'
  ]);
  const download = google[3];
  assert.ok(!new URL(download.url).searchParams.has('key'), 'the ?key= Google put in the delivery link is taken out');
  assert.equal(new URL(download.url).searchParams.get('alt'), 'media', 'the rest of the link is kept');
  assert.deepEqual(credentialsIn(google[4]), ['url signature'], 'a signed link carries only its own signature: no key, no Authorization header');
  const upload = calls.find((c) => c.url === `${SUP_URL}/storage/v1/object/pg1-vault/videos/${id}.mp4`);
  assert.equal(Buffer.from(upload.body).toString(), 'signed clip');
});

test('the credential checker itself: two credentials on one Google request fail the check', () => {
  const twice = [
    { url: `${INTERACTIONS}/int-1?key=${KEY1}`, method: 'GET', headers: { 'x-goog-api-key': KEY1 }, redirect: 'manual' },
    { url: `${INTERACTIONS}/int-1`, method: 'GET', headers: { 'x-goog-api-key': KEY1, Authorization: 'Bearer ya29.token' }, redirect: 'manual' },
    { url: `${INTERACTIONS}/int-1`, method: 'GET', headers: { 'x-goog-api-key': KEY1 } }
  ];
  for (const c of twice) assert.throws(() => assertOneCredentialEach([c]), assert.AssertionError, c.url);
  assert.doesNotThrow(() => assertOneCredentialEach([{ url: `${INTERACTIONS}/int-1`, method: 'GET', headers: { 'x-goog-api-key': KEY1 }, redirect: 'manual' }]));
});

test('googleRequestParts: ?key= is removed, a passed Authorization or second key header is dropped, the key goes only to Google\'s API host', () => {
  const p = googleRequestParts(`${INTERACTIONS}/int-1?key=abc&Key=def&alt=sse`, KEY1, { Authorization: 'Bearer x', 'X-Goog-Api-Key': KEY2, Accept: 'application/json' });
  assert.equal(p.url, `${INTERACTIONS}/int-1?alt=sse`);
  assert.deepEqual(p.headers, { Accept: 'application/json', 'x-goog-api-key': KEY1 });
  assert.equal(stripUrlKey('https://example.test/a?key=1&b=2'), 'https://example.test/a?b=2');
  assert.deepEqual(googleRequestParts('https://storage.example.test/clip.mp4?key=1', KEY1).headers, {}, 'another host: no key');
  assert.deepEqual(googleRequestParts('http://generativelanguage.googleapis.com/x', KEY1).headers, {}, 'never over plain http');
  assert.deepEqual(googleRequestParts(`${INTERACTIONS}/x?access_token=t`, KEY1).headers, {}, 'a link with its own credential: no key');
});

// --- 9. a poll that gets a request error -------------------------------------------------

test('poll: a request error (the live 400) does not discard the job; the poll is asked again, logging Google\'s text each time, and fails after the limit', async () => {
  const db = await makeDb();
  const started = await startOne(db);
  const id = started.videoJob.id;
  const calls = installFetch([...engineRoutes({ poll: () => new Response(MULTIPLE_CREDENTIALS, { status: 400 }) }), ...dbRoutes(db), ...supabaseRoutes()]);
  for (let n = 1; n < VIDEO_POLL_ERROR_LIMIT; n++) {
    const poll = await run(authed({ action: 'VIDEO_STATUS', jobId: id }));
    assert.equal(poll.jsonBody.videoJob.status, 'rendering', `poll ${n}: still rendering`);
    assert.deepEqual((await db.query('select status, error_reason from public.pg1_video_jobs')).rows[0], { status: 'rendering', error_reason: `poll_error_${n}` });
  }
  const last = await run(authed({ action: 'VIDEO_STATUS', jobId: id }));
  assert.equal(last.jsonBody.videoJob.status, 'failed');
  assert.deepEqual((await db.query('select status, error_reason from public.pg1_video_jobs')).rows[0], { status: 'failed', error_reason: 'engine_error' });
  const rows = await errorRows(calls, VIDEO_POLL_ERROR_LIMIT);
  const retries = rows.filter((r) => r.reason === 'video_google_key1_poll_error');
  assert.equal(retries.length, VIDEO_POLL_ERROR_LIMIT - 1);
  for (const [i, r] of retries.entries()) {
    assert.match(r.message, /Multiple authentication credentials received\. Please pass only one\./);
    assert.match(r.message, new RegExp(`attempt=${i + 1}/${VIDEO_POLL_ERROR_LIMIT}, asking again`));
  }
  const final = rows.find((r) => r.reason === 'video_google_key1_failed');
  assert.match(final.message, /status=400 failure=request .*Multiple authentication credentials received.*attempt=3\/3/);
});

test('poll: a good answer after a request error starts the count again; a safety refusal is still final at once', async () => {
  const db = await makeDb();
  const { videoJob: { id } } = await startOne(db);
  installFetch([...engineRoutes({ poll: () => new Response(MULTIPLE_CREDENTIALS, { status: 400 }) }), ...dbRoutes(db), ...supabaseRoutes()]);
  await run(authed({ action: 'VIDEO_STATUS', jobId: id }));
  installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  assert.equal((await run(authed({ action: 'VIDEO_STATUS', jobId: id }))).jsonBody.videoJob.status, 'rendering');
  assert.equal((await db.query('select error_reason from public.pg1_video_jobs')).rows[0].error_reason, null);

  const db2 = await makeDb();
  const { videoJob: { id: id2 } } = await startOne(db2);
  installFetch([...engineRoutes({ poll: () => new Response(GEMINI_SAFETY, { status: 400 }) }), ...dbRoutes(db2), ...supabaseRoutes()]);
  const refused = await run(authed({ action: 'VIDEO_STATUS', jobId: id2 }));
  assert.equal(refused.jsonBody.videoJob.status, 'failed');
  assert.equal(refused.jsonBody.videoJob.message, VIDEO_REFUSED_TEXT);
  assert.equal((await db2.query('select error_reason from public.pg1_video_jobs')).rows[0].error_reason, 'safety_refused');
});

// --- 10. /video recheck <request id> ------------------------------------------------------

async function failedJob(db) {
  const started = await startOne(db);
  await db.query(`update public.pg1_video_jobs set status = 'failed', error_reason = 'engine_error', created_at = now() - interval '2 hours'`);
  return started;
}

test('/video recheck: a job whose poll failed is asked once more; a clip Google finished is stored and goes to its card', async () => {
  const db = await makeDb();
  const started = await failedJob(db);
  const requestId = started.traceId;
  const finished = { id: 'int-123', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: MP4_BASE64, mime_type: 'video/mp4' }] }] };
  const calls = installFetchWithRedirect([...engineRoutes({ poll: () => json(finished) }), ...dbRoutes(db), ...supabaseRoutes()]);
  const res = await run(authed({ prompt: `/video recheck ${requestId}` }));
  assert.equal(res.jsonBody.reply, `PG1 Motion found the clip for request ID ${requestId}: it had finished rendering and is now in the vault.`);
  const id = started.videoJob.id;
  assert.deepEqual(res.jsonBody.videoJob, { id, status: 'done', url: `${SUP_URL}/storage/v1/object/sign/pg1-vault/videos/${id}.mp4?token=signed-token`, engine: VIDEO_ENGINE_LABEL, requestId });
  assert.deepEqual((await db.query('select status, storage_path, error_reason from public.pg1_video_jobs')).rows[0], { status: 'done', storage_path: `videos/${id}.mp4`, error_reason: null });
  assertOneCredentialEach(calls);
  assert.equal(calls.filter((c) => c.url.includes('pg1_reserve_video_slot')).length, 0, 'a recheck reserves nothing');
  assert.doesNotMatch(JSON.stringify(res.jsonBody), BRANDS_RE);
});

test('/video recheck: still not ready, unknown, refused, and a guest', async () => {
  const db = await makeDb();
  const started = await failedJob(db);
  installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  const notYet = await run(authed({ prompt: `/video recheck ${started.traceId}` }));
  assert.equal(notYet.jsonBody.reply, `The clip for request ID ${started.traceId} is not ready yet. Try /video recheck ${started.traceId} again in a few minutes.`);
  assert.deepEqual((await db.query('select status, error_reason from public.pg1_video_jobs')).rows[0], { status: 'failed', error_reason: 'engine_error' }, 'back to failed, its reason kept');

  installFetch([...engineRoutes({ poll: () => new Response(MULTIPLE_CREDENTIALS, { status: 400 }) }), ...dbRoutes(db), ...supabaseRoutes()]);
  const stillBad = await run(authed({ prompt: `/video recheck ${started.traceId}` }));
  assert.match(stillBad.jsonBody.reply, /^PG1 Motion has no clip for request ID \w+: it did not finish rendering\. Nothing new was reserved\.$/);
  assert.equal((await db.query('select status from public.pg1_video_jobs')).rows[0].status, 'failed');

  installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  assert.equal((await run(authed({ prompt: '/video recheck zz999999' }))).jsonBody.reply, 'No video has request ID zz999999.');
  await db.query(`update public.pg1_video_jobs set error_reason = 'safety_refused'`);
  const calls = installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  assert.match((await run(authed({ prompt: `/video recheck ${started.traceId}` }))).jsonBody.reply, /cannot be checked again/);
  assert.equal(engineCalls(calls).length, 0, 'a refused clip is never asked about again');

  const guest = await run({ prompt: `/video recheck ${started.traceId}` });
  assert.equal(guest.statusCode, 401);
});
