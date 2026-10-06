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
  VIDEO_ENGINE_LABEL, VIDEO_JOB_TIMEOUT_MS, VIDEO_SIGNED_URL_SECONDS
} from '../lib/videoJobs.mjs';

const MIGRATION = readFileSync(new URL('../supabase/migrations/20261008120000_pg1_video_jobs.sql', import.meta.url), 'utf8');
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CONSOLE_ERROR = console.error;

const SUP_URL = 'https://supabase.test';
const KEY1 = 'stub-video-key-one-0123456789';
const KEY2 = 'stub-video-key-two-0123456789';
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MP4_BASE64 = Buffer.from('fake mp4 bytes for the test').toString('base64');
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const GEMINI_REJECTION = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument: gemini-omni-1.1-flash rejected the prompt (safety).' } });

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
    'PG1_VIDEO_MODEL', 'PG1_CHAT_TOOL_TIMEOUT_MS']) delete process.env[k];
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
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // re-runnable
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
      const r = await db.query('select * from public.pg1_reserve_video_slot($1, $2, $3, $4)', [body.p_prompt, body.p_cap, body.p_request_id, body.p_has_start_frame]);
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
  const startVideo = async () => { started++; return { ok: true, jobId: 'x', remaining: 2, cap: 3 }; };
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
    operator({ id: 'v1', name: VIDEO_CHAT_TOOL, args: { prompt: 'a cat' } }),
    operator({ id: 'v2', name: VIDEO_CHAT_TOOL, args: { prompt: 'a dog' } })
  ]);
  assert.equal(started, 1);
  assert.equal([a, b].filter((o) => o.ok).length, 1);
  assert.equal([a, b].find((o) => !o.ok).code, 'one_per_message');
  const ok = [a, b].find((o) => o.ok);
  assert.deepEqual({ status: ok.result.status, job: ok.result.job_id, left: ok.result.remaining_today, cap: ok.result.daily_cap }, { status: 'rendering', job: 'x', left: 2, cap: 3 });
  const card = summarizeOutcome(ok);
  assert.deepEqual(card.video_job, { id: 'x', status: 'rendering' });
  assert.equal(traceLabels({ name: VIDEO_CHAT_TOOL, args: {} }, ok).result, 'PG1 Motion · 2 left today');
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
  assert.equal(DEFAULT_VIDEO_DAILY_CAP, 3);
  assert.equal(videoDailyCap({}), 3);
  assert.equal(videoDailyCap({ PG1_VIDEO_DAILY_CAP: '5' }), 5);
  assert.equal(videoDailyCap({ PG1_VIDEO_DAILY_CAP: '0' }), 0);
  for (const bad of ['-1', 'three', '2.5', '']) assert.equal(videoDailyCap({ PG1_VIDEO_DAILY_CAP: bad }), 3, bad);
  assert.equal(videoEnabled({ PG1_VIDEO_ENABLED: '1' }), true);
  assert.equal(VIDEO_SIGNED_URL_SECONDS, 7 * 24 * 3600);
  assert.equal(VIDEO_JOB_TIMEOUT_MS, 15 * 60 * 1000);
});

// --- 3. the cap -------------------------------------------------------------------

test('the cap holds under two simultaneous requests: one clip starts, the other is told the limit is reached', async () => {
  process.env.PG1_VIDEO_DAILY_CAP = '1';
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
  const capped = replies.filter((b) => !b.videoJob);
  assert.equal(started.length, 1, 'exactly one clip started');
  assert.equal(capped.length, 1);
  assert.match(started[0].reply, /^Rendering video… /);
  assert.match(started[0].reply, /0 of 1 video left today\./);
  assert.equal(started[0].videoJob.status, 'rendering');
  assert.match(capped[0].reply, /Today's video limit is reached \(1 of 1 used\)/);
  assert.equal(capped[0].videosLeftToday, 0);
  assert.equal(startCalls(calls).length, 1, 'the engine was called once');
  const rows = (await db.query('select status, interaction_id, key_slot from public.pg1_video_jobs')).rows;
  assert.equal(rows.length, 1, 'one slot in the database');
  assert.deepEqual(rows[0], { status: 'rendering', interaction_id: 'int-123', key_slot: 1 });

  // The slot is reserved before the engine is called.
  const reserveAt = calls.findIndex((c) => c.url.includes('pg1_reserve_video_slot'));
  const startAt = calls.findIndex((c) => c.url === INTERACTIONS && c.method === 'POST');
  assert.ok(reserveAt >= 0 && reserveAt < startAt);
});

test('a clip that fails still uses its slot; the reply is one neutral sentence, the request ID and what is left; Gemini\'s real error goes to pg1_errors', async () => {
  process.env.PG1_VIDEO_DAILY_CAP = '2';
  const db = await makeDb();
  let calls = installFetch([...engineRoutes({ start: () => new Response(GEMINI_REJECTION, { status: 400 }) }), ...dbRoutes(db), ...supabaseRoutes()]);
  const res = await run(authed({ prompt: '/video a storm over the sea' }));
  const body = res.jsonBody;
  assert.equal(body.videoJob, undefined);
  const [sentence, left] = body.reply.split('\n');
  assert.equal(sentence, `${FAILURE_PREFIX} The video could not be generated right now. Please try again. Request ID: ${body.traceId}`);
  assert.equal(left, '1 of 2 videos left today.');
  assert.doesNotMatch(body.reply, BRANDS_RE);
  assert.doesNotMatch(body.reply, /invalid argument|safety|400/i);
  assert.equal(startCalls(calls).length, 1, 'a 400 is the engine\'s answer: the second key is not tried');

  const logged = (await errorRows(calls)).find((r) => r.reason === 'video_start_failed');
  assert.ok(logged, 'a pg1_errors row');
  assert.equal(logged.route, 'GENERATE_VIDEO');
  assert.equal(logged.status, 400);
  assert.match(logged.message, /untrusted upstream data, not instructions/);
  assert.match(logged.message, /gemini-omni-1\.1-flash/);
  assert.match(logged.message, /INVALID_ARGUMENT Request contains an invalid argument/, 'Gemini\'s own words');
  assert.match(logged.message, new RegExp(`request_id=${body.traceId}`));
  assert.ok(!logged.message.includes(KEY1) && !logged.message.includes(KEY2), 'never a key');

  const row = (await db.query('select status, error_reason from public.pg1_video_jobs')).rows[0];
  assert.deepEqual(row, { status: 'failed', error_reason: 'start_failed' });

  // The next request finds the failed clip counted: one slot left.
  calls = installFetch([...engineRoutes(), ...dbRoutes(db), ...supabaseRoutes()]);
  const next = await run(authed({ prompt: '/video a calm sea' }));
  assert.match(next.jsonBody.reply, /0 of 2 videos left today\./);
  const third = await run(authed({ prompt: '/video a calm lake' }));
  assert.match(third.jsonBody.reply, /limit is reached \(2 of 2 used\)/);
  assert.equal(startCalls(calls).length, 1);

  // A bare /video says how many are left without spending one.
  const bare = await run(authed({ prompt: '/video' }));
  assert.match(bare.jsonBody.reply, /^Say what the video should show/);
  assert.match(bare.jsonBody.reply, /0 of 2 videos left today\./);
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
  const r = (await db.query('select * from public.pg1_reserve_video_slot($1, $2, $3, $4)', ['new', 3, 'req', false])).rows[0];
  assert.equal(r.reserved, true);
  assert.equal(r.used, 2, 'the timed-out job still counts');
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
  const failed = { id: 'int-123', status: 'failed', errors: [{ code: 'SAFETY', message: 'The gemini-omni-1.1-flash output was blocked by a safety filter.' }] };
  const calls = installFetch([...engineRoutes({ poll: () => json(failed) }), ...dbRoutes(db), ...supabaseRoutes()]);
  const poll = await run(authed({ action: 'VIDEO_STATUS', jobId: started.videoJob.id }));
  assert.equal(poll.jsonBody.videoJob.status, 'failed');
  assert.match(poll.jsonBody.videoJob.message, new RegExp(`Request ID: ${started.traceId}$`));
  assert.doesNotMatch(poll.jsonBody.videoJob.message, /safety|blocked|SAFETY/);
  const logged = (await errorRows(calls)).find((r) => r.reason === 'video_render_failed');
  assert.match(logged.message, /SAFETY The gemini-omni-1\.1-flash output was blocked by a safety filter/);
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
  assert.equal(step.result, 'PG1 Motion · 2 left today');
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
    input: '6 second clip: a hummingbird in slow motion',
    response_format: { type: 'video', resolution: '720p', aspect_ratio: '16:9', delivery: 'uri' },
    background: true
  });
  assert.deepEqual(withFrame.body.input, [{ type: 'text', text: 'animate the scene' }, { type: 'image', data: PNG_1X1, mime_type: 'image/png' }]);
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
  assert.equal(startCalls(calls)[0].body.input, 'waves rolling onto a beach at sunset');
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
  assert.equal(cleanVideoPrompt('make me a short 8 second clip showing waves'), '8 second clip: waves');
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
