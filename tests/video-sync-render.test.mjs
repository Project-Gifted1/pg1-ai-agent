/**
 * PG1 Motion's synchronous render (the default while Google's GET
 * /v1beta/interactions/{id} answers 400 "Multiple authentication
 * credentials received"): api/video-render.mjs and the sync paths in
 * lib/videoJobs.mjs and api/chat.mjs.
 *  - end to end with a fake Google: the chat answers at once with the
 *    "Rendering video…" card, dispatches the render, the render POSTs with
 *    background: false (inline delivery, or uri for a clip over 4 MB),
 *    uploads the clip to pg1-vault/videos/ and sets the row to done; the
 *    card's status action then returns the signed link
 *  - no GET to /interactions/{id} anywhere while PG1_VIDEO_GOOGLE_ASYNC is off
 *  - the render rejects unauthenticated and guest calls (401)
 *  - a render that outlives maxDuration plus the margin is marked failed
 *  - a duplicate trigger never renders twice
 *  - "Multiple authentication credentials" falls through to the next key,
 *    on one reservation
 *
 * The database is a real Postgres (PGlite) with the migrations applied,
 * behind a small PostgREST stand-in.
 *
 * Run with: node --test tests/video-sync-render.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { createVideoRenderHandler, config as renderConfig } from '../api/video-render.mjs';
import { FAILURE_PREFIX } from '../lib/upstreamFailure.mjs';
import {
  buildVideoRequestBody, classifyVideoFailure, estimatedClipBytes, keyFormat, signRenderToken, verifyRenderToken, videoDelivery,
  videoGoogleAsync, videoRenderUrl, INTERACTION_BODY_KEYS, VIDEO_INLINE_MAX_BYTES, VIDEO_QUEUE_TIMEOUT_MS, VIDEO_RENDER_MARGIN_MS,
  VIDEO_RENDER_MAX_DURATION_S, VIDEO_RENDER_TIMEOUT_MS, VIDEO_RENDER_TOKEN_HEADER
} from '../lib/videoJobs.mjs';

const MIGRATIONS = ['20261008120000_pg1_video_jobs.sql', '20261009120000_pg1_video_budget.sql', '20261010120000_pg1_video_sync_render.sql']
  .map((f) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'));
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CONSOLE_ERROR = console.error;

const SUP_URL = 'https://supabase.test';
const KEY1 = 'AQ.stub-video-key-one-0123456789';
const KEY2 = 'AIzaStub-video-key-two-0123456789';
const RENDER_SECRET = 'render-secret-for-tests-0123456789';
const RENDER_URL = 'https://pg1.test/api/video-render';
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const CLIP_URI = 'https://generativelanguage.googleapis.com/v1beta/files/clip-9:download?alt=media';
const MP4 = Buffer.from('fake mp4 bytes for the sync test');
const URI_MP4 = Buffer.from('fake mp4 bytes delivered by uri');
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const MULTI_CRED = JSON.stringify({ error: { code: 400, status: 'invalid_request', message: 'Multiple authentication credentials received. Please pass only one.' } });

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY1 = KEY1;
  process.env.GEMINI_API_KEY2 = KEY2;
  process.env.SUPABASE_URL = SUP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-0123456789';
  process.env.PG1_VIDEO_ENABLED = '1';
  process.env.PG1_VIDEO_RENDER_SECRET = RENDER_SECRET;
  process.env.PG1_VIDEO_RENDER_URL = RENDER_URL;
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'SUPABASEAPI_KEY',
    'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'REPLICATE_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'PG1_VIDEO_DAILY_CAP',
    'PG1_VIDEO_MODEL', 'PG1_VIDEO_MODEL_REPLICATE', 'PG1_VIDEO_MODEL_REPLICATE_IMAGE', 'PG1_VIDEO_DAILY_BUDGET_USD',
    'PG1_VIDEO_GOOGLE_ASYNC', 'CRON_SECRET', 'VERCEL_URL', 'VERCEL_ENV', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_AUTOMATION_BYPASS_SECRET']) delete process.env[k];
}

let consoleLines = [];
let logLines = [];
beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
  consoleLines = [];
  logLines = [];
  console.error = (...args) => { consoleLines.push(args.join(' ')); };
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  console.error = ORIGINAL_CONSOLE_ERROR;
});

let ipSeq = 0;
const makeReq = (body, { headers = {}, method = 'POST', url = '/api/chat' } = {}) => ({ method, url, headers, socket: { remoteAddress: `10.82.0.${++ipSeq}` }, body });
const authed = (extra) => ({ user: 'test-operator', pass: 'test-secret-pass', ...extra });

function makeRes() {
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; },
    end() { this.ended = true; return this; },
    on() {}
  };
}

async function chat(body) {
  const res = makeRes();
  await chatHandler(makeReq(body), res);
  return res;
}

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

async function waitFor(check, what) {
  for (let i = 0; i < 400; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

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
    if (k === 'select' || k === 'order') continue;
    assert.match(k, /^[a-z_]+$/);
    if (v.startsWith('eq.')) { vals.push(v.slice(3)); where.push(`${k} = $${vals.length}`); } else if (v.startsWith('gt.')) {
      vals.push(v.slice(3)); where.push(`${k} > $${vals.length}`);
    } else if (v.startsWith('in.(')) {
      const ph = v.slice(4, -1).split(',').map((x) => { vals.push(x); return `$${vals.length}`; });
      where.push(`${k} in (${ph.join(', ')})`);
    } else throw new Error(`unsupported filter ${k}=${v}`);
  }
  return { where: where.length ? where.join(' and ') : 'true', vals };
}

function dbRoutes(db) {
  return [
    ['/rest/v1/rpc/pg1_reserve_video_slot', async (u, o, body) => {
      const keys = ['p_prompt', 'p_est_cost_usd', 'p_budget_usd', 'p_max_clips', 'p_request_id', 'p_has_start_frame', 'p_tier', 'p_duration_s'];
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

// The vault (a Map of path -> bytes), the chat's own reads and the error log.
function supabaseRoutes(vault) {
  return [
    ['/rest/v1/messages', (u, o) => (o.method === 'POST' ? new Response('', { status: 201 }) : json([]))],
    ['/storage/v1/object/list/pg1-vault', () => json([])],
    ['/storage/v1/object/sign/pg1-vault/', (u) => json({ signedURL: `/object/sign/pg1-vault/${u.split('/pg1-vault/')[1]}?token=signed-token` })],
    ['/storage/v1/object/pg1-vault/', async (u, o) => {
      const path = u.split('/storage/v1/object/pg1-vault/')[1];
      if (o.method === 'POST') { vault.set(path, Buffer.from(o.body)); return json({ Key: path }); }
      return vault.has(path) ? new Response(vault.get(path), { status: 200 }) : new Response('not found', { status: 404 });
    }],
    ['/rest/v1/threat_indicators', () => json([])],
    ['/rest/v1/pg1_errors', (u, o) => (o.method === 'POST' || o.method === 'PATCH' ? new Response('', { status: 201 }) : json([]))]
  ];
}

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

// The render, reached through the fake network at PG1_VIDEO_RENDER_URL. Each
// dispatch's render is recorded so a test can wait for it to finish.
function renderRoute(renders, opts = {}) {
  const handler = createVideoRenderHandler({ fetchImpl: (u, o) => globalThis.fetch(u, o), sleep: async () => {}, log: (l) => logLines.push(l), ...opts });
  return [RENDER_URL, async (u, o) => {
    const res = makeRes();
    const headers = {};
    for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = v;
    const done = handler(makeReq(typeof o.body === 'string' ? JSON.parse(o.body) : o.body, { headers, url: '/api/video-render', method: o.method || 'GET' }), res);
    renders.push({ res, done });
    // The handler answers 202 at once and keeps rendering.
    await waitFor(() => res.statusCode != null, 'the render to answer');
    return json(res.jsonBody, res.statusCode);
  }];
}

// The fake Google: POST /v1beta/interactions answers synchronously; GET of a
// file link (delivery uri) serves the clip. Any GET of an interaction is a
// test failure on its own.
function googleRoutes({ post = () => json({ id: 'int-sync-1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: MP4.toString('base64'), mime_type: 'video/mp4' }] }] }) } = {}) {
  return [
    [CLIP_URI.split('?')[0], () => new Response(URI_MP4, { status: 200, headers: { 'Content-Type': 'video/mp4' } })],
    [INTERACTIONS, (u, o, body) => {
      if (o.method !== 'POST') throw new Error(`GET of an interaction: ${u}`);
      return post(body, o);
    }]
  ];
}

const googlePosts = (calls) => calls.filter((c) => c.url === INTERACTIONS && c.method === 'POST');
const interactionGets = (calls) => calls.filter((c) => c.url.startsWith(INTERACTIONS) && c.method !== 'POST');
const jobRow = async (db) => (await db.query('select * from public.pg1_video_jobs')).rows;

// --- 1. end to end ------------------------------------------------------------------

test('sync, end to end: the card comes back at once, the render POSTs with background false and inline delivery, stores the clip and the status action returns it', async () => {
  assert.equal(videoGoogleAsync(process.env), false, 'synchronous is the default');
  const db = await makeDb();
  const vault = new Map();
  const renders = [];
  let releaseGoogle;
  const googleGate = new Promise((r) => { releaseGoogle = r; });
  const calls = installFetch([
    renderRoute(renders),
    ...googleRoutes({ post: async (body) => { await googleGate; return json({ id: 'int-sync-1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: MP4.toString('base64'), mime_type: 'video/mp4' }] }] }); } }),
    ...dbRoutes(db), ...supabaseRoutes(vault)
  ]);

  // The reply does not wait for the engine.
  const res = await chat(authed({ prompt: '/video a red fox in snow' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.reply, 'Rendering video… It appears here when it is ready, usually within a few minutes.\nPG1 Motion · Standard · 5 s · about 0.50 USD · 4.50 USD left today');
  const jobId = res.jsonBody.videoJob.id;
  assert.deepEqual(res.jsonBody.videoJob, { id: jobId, status: 'rendering', engine: 'PG1 Motion' });

  // While Google is still working the card says rendering, from the row alone.
  const render = await waitFor(() => renders[0], 'the render to be dispatched');
  await waitFor(() => googlePosts(calls).length === 1, 'the engine call');
  const mid = await chat(authed({ action: 'VIDEO_STATUS', jobId }));
  assert.deepEqual(mid.jsonBody.videoJob, { id: jobId, status: 'rendering', engine: 'PG1 Motion' });
  assert.equal(render.res.statusCode, 202, 'the render answered as soon as it claimed the job');
  assert.equal((await jobRow(db))[0].status, 'rendering');

  releaseGoogle();
  assert.equal((await render.done).status, 'done');

  // The trigger: one signed POST, token for this job only.
  const dispatch = calls.filter((c) => c.url === RENDER_URL);
  assert.equal(dispatch.length, 1);
  assert.equal(dispatch[0].method, 'POST');
  const token = dispatch[0].headers[VIDEO_RENDER_TOKEN_HEADER];
  assert.deepEqual(verifyRenderToken(token, { secret: RENDER_SECRET }), { ok: true, jobId });

  // The engine request.
  const [post] = googlePosts(calls);
  assert.equal(post.body.background, false);
  assert.deepEqual(post.body.response_format, { type: 'video', resolution: '720p', aspect_ratio: '16:9', delivery: 'inline' });
  assert.equal(post.body.input, 'a red fox in snow\n\nClip length: 5 seconds.');
  assert.deepEqual(Object.keys(post.body).sort(), INTERACTION_BODY_KEYS.request.slice().sort());
  assert.equal(post.headers['x-goog-api-key'], KEY1);
  assert.ok(!post.url.includes('key='));

  // The vault and the row.
  assert.deepEqual(vault.get(`videos/${jobId}.mp4`), MP4);
  const [row] = await jobRow(db);
  assert.equal(row.status, 'done');
  assert.equal(row.storage_path, `videos/${jobId}.mp4`);
  assert.equal(row.provider, 'google');
  assert.equal(row.key_slot, 1);
  assert.equal(row.interaction_id, 'int-sync-1');
  assert.equal(row.est_cost_usd, '0.50');

  const fin = await chat(authed({ action: 'VIDEO_STATUS', jobId }));
  assert.equal(fin.jsonBody.videoJob.status, 'done');
  assert.equal(fin.jsonBody.videoJob.url, `${SUP_URL}/storage/v1/object/sign/pg1-vault/videos/${jobId}.mp4?token=signed-token`);
  assert.equal(interactionGets(calls).length, 0, 'never a GET of the interaction');
  assert.equal(calls.filter((c) => c.url.includes('pg1_reserve_video_slot')).length, 1, 'one reservation');
});

test('sync: a clip over 4 MB is asked for by uri, downloaded from the file link with the key in the header only, and stored', async () => {
  assert.equal(videoDelivery('standard', 5), 'inline');
  assert.equal(videoDelivery('draft', 10), 'inline');
  assert.equal(videoDelivery('standard', 10), 'uri');
  assert.equal(videoDelivery('pro', 5), 'uri');
  assert.ok(estimatedClipBytes('pro', 5) > VIDEO_INLINE_MAX_BYTES && estimatedClipBytes('standard', 5) <= VIDEO_INLINE_MAX_BYTES);

  const db = await makeDb();
  const vault = new Map();
  const renders = [];
  const calls = installFetch([
    renderRoute(renders),
    ...googleRoutes({ post: () => json({ id: 'int-sync-2', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', uri: CLIP_URI, mime_type: 'video/mp4' }] }] }) }),
    ...dbRoutes(db), ...supabaseRoutes(vault)
  ]);
  const res = await chat(authed({ prompt: '/video pro a storm over the sea', multiFiles: [{ inlineData: { mimeType: 'image/png', data: PNG_1X1 } }] }));
  const jobId = res.jsonBody.videoJob.id;
  const render = await waitFor(() => renders[0], 'the render');
  assert.equal((await render.done).status, 'done');

  const [post] = googlePosts(calls);
  assert.equal(post.body.background, false);
  assert.deepEqual(post.body.response_format, { type: 'video', resolution: '1080p', aspect_ratio: '16:9', delivery: 'uri' });
  // The starting frame went through the vault to the render.
  assert.ok(Array.isArray(post.body.input), 'text and the starting frame');
  assert.deepEqual(post.body.input[1], { type: 'image', data: PNG_1X1, mime_type: 'image/png' }, 'the same frame, byte for byte');
  assert.equal((await jobRow(db))[0].start_frame_path, `videos/frames/${jobId}.png`);

  const dl = calls.find((c) => c.url.startsWith(CLIP_URI.split('?')[0]));
  assert.equal(dl.method, 'GET');
  assert.equal(dl.headers['x-goog-api-key'], KEY1);
  assert.ok(!dl.url.includes('key='));
  assert.deepEqual(vault.get(`videos/${jobId}.mp4`), URI_MP4);
  assert.equal((await jobRow(db))[0].status, 'done');
  assert.equal(interactionGets(calls).length, 0);
});

// --- 2. no GET of an interaction --------------------------------------------------

test('PG1_VIDEO_GOOGLE_ASYNC off: no request ever GETs /interactions/{id} - not the start, the render, the status polls nor /video recheck', async () => {
  for (const off of [undefined, '0', 'true', '']) {
    resetEnv();
    if (off !== undefined) process.env.PG1_VIDEO_GOOGLE_ASYNC = off;
    assert.equal(videoGoogleAsync(process.env), false, String(off));
    const db = await makeDb();
    const vault = new Map();
    const renders = [];
    const calls = installFetch([renderRoute(renders), ...googleRoutes(), ...dbRoutes(db), ...supabaseRoutes(vault)]);
    const res = await chat(authed({ prompt: 'make a video of a paper boat' }));
    const jobId = res.jsonBody.videoJob.id;
    for (let i = 0; i < 3; i++) await chat(authed({ action: 'VIDEO_STATUS', jobId }));
    await (await waitFor(() => renders[0], 'the render')).done;
    for (let i = 0; i < 3; i++) await chat(authed({ action: 'VIDEO_STATUS', jobId }));
    const requestId = (await jobRow(db))[0].request_id;
    await chat(authed({ prompt: `/video recheck ${requestId}` }));
    assert.equal(googlePosts(calls).length, 1);
    assert.equal(interactionGets(calls).length, 0, `${off}: no GET of an interaction`);
    assert.equal(calls.filter((c) => c.url.includes('generativelanguage.googleapis.com') && c.method === 'GET').length, 0, 'no GET to Google at all (inline delivery)');
  }
  // And a failed job is never rechecked against Google.
  const db = await makeDb();
  const calls = installFetch([...googleRoutes(), ...dbRoutes(db), ...supabaseRoutes(new Map())]);
  await db.query(`insert into public.pg1_video_jobs (prompt, request_id, status, provider, interaction_id, error_reason) values ('x', 'reqfailed1', 'failed', 'google', 'int-old', 'engine_error')`);
  const recheck = await chat(authed({ prompt: '/video recheck reqfailed1' }));
  assert.match(recheck.jsonBody.reply, /cannot be checked again/);
  assert.equal(interactionGets(calls).length, 0);
});

// --- 3. auth ------------------------------------------------------------------------

test('the render rejects unauthenticated, guest and forged calls with 401, before the database or the engine', async () => {
  const db = await makeDb();
  await db.query(`insert into public.pg1_video_jobs (id, prompt, status, provider) values ('11111111-1111-4111-8111-111111111111', 'a fox', 'queued', 'google')`);
  const jobId = '11111111-1111-4111-8111-111111111111';
  const calls = installFetch([...googleRoutes(), ...dbRoutes(db), ...supabaseRoutes(new Map())]);
  const handler = createVideoRenderHandler({ fetchImpl: (u, o) => globalThis.fetch(u, o), sleep: async () => {}, log: () => {} });
  const call = async (headers, body = { jobId }, method = 'POST') => {
    const res = makeRes();
    await handler(makeReq(body, { headers, method, url: '/api/video-render' }), res);
    return res;
  };
  const now = Date.now();
  const good = signRenderToken({ jobId, secret: RENDER_SECRET, now });
  const [id, exp, sig] = good.split('.');
  const flip = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  const cases = {
    'no credentials at all': [{}],
    'a guest (wrong operator password in the body)': [{}, { jobId, user: 'test-operator', pass: 'wrong' }],
    'the operator\'s own credentials, but no token': [{}, { jobId, user: 'test-operator', pass: 'test-secret-pass' }],
    'a browser with cookies and an origin': [{ cookie: 'pg1_session=abc', origin: 'https://pg1-ai-agent.vercel.app' }],
    'the secret itself as a bearer token': [{ authorization: `Bearer ${RENDER_SECRET}` }],
    'the secret itself as the token': [{ [VIDEO_RENDER_TOKEN_HEADER]: RENDER_SECRET }],
    'a token signed with another secret': [{ [VIDEO_RENDER_TOKEN_HEADER]: signRenderToken({ jobId, secret: 'some-other-secret-0123456789', now }) }],
    'a tampered signature': [{ [VIDEO_RENDER_TOKEN_HEADER]: `${id}.${exp}.${flip}` }],
    'a token moved to another job': [{ [VIDEO_RENDER_TOKEN_HEADER]: `22222222-2222-4222-8222-222222222222.${exp}.${sig}` }],
    'a longer expiry on a good signature': [{ [VIDEO_RENDER_TOKEN_HEADER]: `${id}.${Number(exp) + 1000}.${sig}` }],
    'an expired token': [{ [VIDEO_RENDER_TOKEN_HEADER]: signRenderToken({ jobId, secret: RENDER_SECRET, now: now - 10 * 60 * 1000 }) }],
    'a GET without a token': [{}, null, 'GET']
  };
  for (const [name, [headers, body, method]] of Object.entries(cases)) {
    const res = await call(headers, body === undefined ? { jobId } : body, method);
    assert.equal(res.statusCode, 401, name);
    assert.deepEqual(res.jsonBody, { error: 'Unauthorized' }, name);
  }
  assert.equal(calls.length, 0, 'no database, vault or engine call for any of them');
  assert.equal((await jobRow(db))[0].status, 'queued', 'the job was not claimed');

  // Without a configured secret nothing is accepted, not even a token
  // signed with an empty or short one.
  delete process.env.PG1_VIDEO_RENDER_SECRET;
  process.env.CRON_SECRET = 'short';
  assert.equal((await call({ [VIDEO_RENDER_TOKEN_HEADER]: good })).statusCode, 401);
  assert.equal(calls.length, 0);

  // CRON_SECRET (16+ characters) stands in for PG1_VIDEO_RENDER_SECRET, but
  // only as the HMAC key: the raw value is still refused.
  process.env.CRON_SECRET = RENDER_SECRET;
  assert.equal((await call({ authorization: `Bearer ${RENDER_SECRET}` })).statusCode, 401);
  const ok = await call({ [VIDEO_RENDER_TOKEN_HEADER]: good });
  assert.equal(ok.statusCode, 202, 'a valid token is accepted');
});

// --- 4. timeouts -----------------------------------------------------------------

test('a render that outlives maxDuration plus the margin is marked failed ("render timed out"); a queued job nobody claimed fails too', async () => {
  assert.equal(VIDEO_RENDER_TIMEOUT_MS, VIDEO_RENDER_MAX_DURATION_S * 1000 + VIDEO_RENDER_MARGIN_MS);
  const db = await makeDb();
  const calls = installFetch([...googleRoutes(), ...dbRoutes(db), ...supabaseRoutes(new Map())]);
  const overS = Math.ceil(VIDEO_RENDER_TIMEOUT_MS / 1000) + 5;
  const underS = VIDEO_RENDER_MAX_DURATION_S - 60;
  const queuedOverS = Math.ceil(VIDEO_QUEUE_TIMEOUT_MS / 1000) + 5;
  await db.query(`insert into public.pg1_video_jobs (id, prompt, request_id, status, provider, render_started_at, created_at) values
    ('33333333-3333-4333-8333-333333333333', 'a', 'reqtimeout1', 'rendering', 'google', now() - interval '${overS} seconds', now() - interval '${overS + 3} seconds'),
    ('44444444-4444-4444-8444-444444444444', 'b', 'reqrunning1', 'rendering', 'google', now() - interval '${underS} seconds', now() - interval '${underS + 3} seconds'),
    ('55555555-5555-4555-8555-555555555555', 'c', 'reqqueued01', 'queued', 'google', null, now() - interval '${queuedOverS} seconds')`);

  const timedOut = await chat(authed({ action: 'VIDEO_STATUS', jobId: '33333333-3333-4333-8333-333333333333' }));
  assert.equal(timedOut.jsonBody.videoJob.status, 'failed');
  assert.equal(timedOut.jsonBody.videoJob.message, `${FAILURE_PREFIX} The video could not be generated right now. Please try again. Request ID: reqtimeout1`);
  const running = await chat(authed({ action: 'VIDEO_STATUS', jobId: '44444444-4444-4444-8444-444444444444' }));
  assert.equal(running.jsonBody.videoJob.status, 'rendering', 'inside maxDuration it is still rendering');
  const queued = await chat(authed({ action: 'VIDEO_STATUS', jobId: '55555555-5555-4555-8555-555555555555' }));
  assert.equal(queued.jsonBody.videoJob.status, 'failed');

  const rows = Object.fromEntries((await db.query('select request_id, status, error_reason, error_detail from public.pg1_video_jobs')).rows.map((r) => [r.request_id, r]));
  assert.deepEqual(rows.reqtimeout1, { request_id: 'reqtimeout1', status: 'failed', error_reason: 'timeout', error_detail: 'render timed out' });
  assert.equal(rows.reqrunning1.status, 'rendering');
  assert.deepEqual(rows.reqqueued01, { request_id: 'reqqueued01', status: 'failed', error_reason: 'render_not_started', error_detail: 'render never started' });
  assert.equal(calls.filter((c) => c.url.includes('googleapis')).length, 0, 'the status action never asks Google');

  // A queued job past the claim window can no longer be claimed.
  await db.query(`insert into public.pg1_video_jobs (id, prompt, status, provider, created_at) values ('66666666-6666-4666-8666-666666666666', 'd', 'queued', 'google', now() - interval '100 seconds')`);
  const res = makeRes();
  await createVideoRenderHandler({ fetchImpl: (u, o) => globalThis.fetch(u, o), log: () => {} })(makeReq({}, { headers: { [VIDEO_RENDER_TOKEN_HEADER]: signRenderToken({ jobId: '66666666-6666-4666-8666-666666666666', secret: RENDER_SECRET }) }, url: '/api/video-render' }), res);
  assert.deepEqual([res.statusCode, res.jsonBody], [200, { claimed: false }]);
  assert.equal(googlePosts(calls).length, 0);
});

test('the render\'s config: maxDuration 800 s (Vercel Pro with Fluid compute) and the same number in the timeout; the route is not under the open CORS rule', () => {
  assert.equal(renderConfig.maxDuration, VIDEO_RENDER_MAX_DURATION_S);
  assert.equal(VIDEO_RENDER_MAX_DURATION_S, 800);
  const src = readFileSync(new URL('../api/video-render.mjs', import.meta.url), 'utf8');
  assert.match(src, /export const config = \{ maxDuration: 800 \};/, 'a literal, for Vercel\'s static analysis');
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const open = vercel.headers.find((h) => h.source.startsWith('/api/:path('));
  assert.match(open.source, /video-render\$/, 'no Access-Control-Allow-Origin: * on the render');
  // Where the trigger goes.
  assert.equal(videoRenderUrl({ PG1_VIDEO_RENDER_URL: 'https://x.test/api/video-render' }), 'https://x.test/api/video-render');
  assert.equal(videoRenderUrl({ PG1_VIDEO_RENDER_URL: 'http://x.test/api/video-render' }), '', 'https only');
  assert.equal(videoRenderUrl({ VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'pg1-ai-agent.vercel.app', VERCEL_URL: 'pg1-abc.vercel.app' }), 'https://pg1-ai-agent.vercel.app/api/video-render');
  assert.equal(videoRenderUrl({ VERCEL_ENV: 'preview', VERCEL_URL: 'pg1-abc.vercel.app' }), 'https://pg1-abc.vercel.app/api/video-render');
  assert.equal(videoRenderUrl({}), '');
  // The synchronous body only differs in background and delivery.
  const body = buildVideoRequestBody({ model: 'm', prompt: 'p', background: false, delivery: 'inline' });
  assert.equal(body.background, false);
  assert.equal(body.response_format.delivery, 'inline');
  assert.equal(buildVideoRequestBody({ model: 'm', prompt: 'p' }).background, true, 'the async default is unchanged');
});

test('sync without a render secret: nothing is reserved and the operator gets the neutral failure', async () => {
  delete process.env.PG1_VIDEO_RENDER_SECRET;
  const db = await makeDb();
  const calls = installFetch([...googleRoutes(), ...dbRoutes(db), ...supabaseRoutes(new Map())]);
  const res = await chat(authed({ prompt: '/video a fox' }));
  assert.equal(res.jsonBody.videoJob, undefined);
  assert.match(res.jsonBody.reply, /could not be generated right now/);
  assert.equal(calls.filter((c) => c.url.includes('pg1_reserve_video_slot')).length, 0);
  assert.equal(googlePosts(calls).length, 0);
});

test('a render trigger that never gets through fails the queued job at once, keeping its one reservation', async () => {
  const db = await makeDb();
  const calls = installFetch([[RENDER_URL, () => new Response('down', { status: 503 })], ...googleRoutes(), ...dbRoutes(db), ...supabaseRoutes(new Map())]);
  const res = await chat(authed({ prompt: '/video a fox' }));
  const jobId = res.jsonBody.videoJob.id;
  await waitFor(async () => (await jobRow(db))[0].status === 'failed', 'the job to fail');
  assert.equal(calls.filter((c) => c.url === RENDER_URL).length, 2, 'one retry on a 5xx');
  const [row] = await jobRow(db);
  assert.equal(row.error_reason, 'render_not_started');
  assert.equal(row.est_cost_usd, '0.50');
  const status = await chat(authed({ action: 'VIDEO_STATUS', jobId }));
  assert.equal(status.jsonBody.videoJob.status, 'failed');
  assert.equal(googlePosts(calls).length, 0);
});

// --- 5. idempotency ------------------------------------------------------------------

test('a duplicate trigger never renders twice: two at once claim the job once, and a late one after it finished does nothing', async () => {
  const db = await makeDb();
  const vault = new Map();
  const renders = [];
  const calls = installFetch([renderRoute(renders), ...googleRoutes(), ...dbRoutes(db), ...supabaseRoutes(vault)]);
  const res = await chat(authed({ prompt: '/video a lighthouse at dusk' }));
  const jobId = res.jsonBody.videoJob.id;
  await (await waitFor(() => renders[0], 'the first render')).done;

  // The same token, replayed twice at once, then once more.
  const token = calls.find((c) => c.url === RENDER_URL).headers[VIDEO_RENDER_TOKEN_HEADER];
  const fire = () => globalThis.fetch(RENDER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', [VIDEO_RENDER_TOKEN_HEADER]: token }, body: JSON.stringify({ jobId }) });
  const answers = await Promise.all([fire(), fire(), fire()]);
  for (const a of answers) assert.deepEqual([a.status, await a.json()], [200, { claimed: false }]);
  assert.equal(googlePosts(calls).length, 1, 'Google was asked once');

  // Two triggers racing for a fresh queued job: exactly one claim.
  const db2 = await makeDb();
  const renders2 = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls2 = installFetch([renderRoute(renders2), ...googleRoutes({ post: async () => { await gate; return json({ id: 'int-x', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: MP4.toString('base64') }] }] }); } }), ...dbRoutes(db2), ...supabaseRoutes(new Map())]);
  await db2.query(`insert into public.pg1_video_jobs (id, prompt, status, provider, tier, duration_s) values ('77777777-7777-4777-8777-777777777777', 'a fox', 'queued', 'google', 'draft', 5)`);
  const t2 = signRenderToken({ jobId: '77777777-7777-4777-8777-777777777777', secret: RENDER_SECRET });
  const race = await Promise.all([1, 2].map(() => globalThis.fetch(RENDER_URL, { method: 'POST', headers: { [VIDEO_RENDER_TOKEN_HEADER]: t2 } })));
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 202]);
  release();
  await Promise.all(renders2.map((r) => r.done));
  assert.equal(googlePosts(calls2).length, 1);
  assert.equal((await jobRow(db2))[0].status, 'done');
});

// --- 6. "Multiple authentication credentials" -----------------------------------------

test('"Multiple authentication credentials" falls through to the next key on one reservation; each key\'s format is logged, never its value', async () => {
  assert.equal(classifyVideoFailure(400, JSON.parse(MULTI_CRED), MULTI_CRED), 'provider');
  assert.deepEqual([keyFormat(KEY1), keyFormat(KEY2), keyFormat('sk-other')], ['AQ.', 'AIza', 'other']);
  const db = await makeDb();
  const vault = new Map();
  const renders = [];
  const calls = installFetch([
    renderRoute(renders),
    ...googleRoutes({ post: (b, o) => (o.headers['x-goog-api-key'] === KEY1 ? new Response(MULTI_CRED, { status: 400 }) : json({ id: 'int-key2', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: MP4.toString('base64'), mime_type: 'video/mp4' }] }] })) }),
    ...dbRoutes(db), ...supabaseRoutes(vault)
  ]);
  const res = await chat(authed({ prompt: '/video a paper boat on a pond' }));
  const jobId = res.jsonBody.videoJob.id;
  assert.equal((await (await waitFor(() => renders[0], 'the render')).done).status, 'done');

  const posts = googlePosts(calls);
  assert.deepEqual(posts.map((p) => p.headers['x-goog-api-key']), [KEY1, KEY2], 'key 1, then key 2');
  for (const p of posts) assert.equal(Object.keys(p.headers).filter((h) => /^(x-goog-api-key|authorization)$/i.test(h)).length, 1, 'one credential per request');
  assert.equal(calls.filter((c) => c.url.includes('pg1_reserve_video_slot')).length, 1, 'one reservation');
  const rows = await jobRow(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[0].key_slot, 2);
  assert.equal(rows[0].est_cost_usd, '0.50', 'charged once');
  assert.equal((await db.query("select coalesce(sum(est_cost_usd), 0)::text as s from public.pg1_video_jobs")).rows[0].s, '0.50');

  // Logged: each attempt's key format, and key 1's failure as a provider
  // failure with Google's words - never a key.
  assert.ok(logLines.some((l) => /key_slot=1 key_format=AQ\./.test(l)), 'key 1 is AQ.');
  assert.ok(logLines.some((l) => /key_slot=2 key_format=AIza/.test(l)), 'key 2 is AIza');
  const failure = consoleLines.find((l) => /video_google_key1_failed/.test(l));
  assert.match(failure, /key_format=AQ\./);
  assert.match(failure, /status=400 failure=provider/);
  assert.match(failure, /Multiple authentication credentials received/);
  for (const l of [...logLines, ...consoleLines]) assert.ok(!l.includes(KEY1) && !l.includes(KEY2), 'never a key value');

  const fin = await chat(authed({ action: 'VIDEO_STATUS', jobId }));
  assert.equal(fin.jsonBody.videoJob.status, 'done');
});

test('every key failing: the job is failed with Google\'s error text, the reservation is kept once, and the card shows the neutral failure', async () => {
  const db = await makeDb();
  const renders = [];
  const calls = installFetch([renderRoute(renders), ...googleRoutes({ post: () => new Response(MULTI_CRED, { status: 400 }) }), ...dbRoutes(db), ...supabaseRoutes(new Map())]);
  const res = await chat(authed({ prompt: '/video a paper boat' }));
  const jobId = res.jsonBody.videoJob.id;
  assert.equal((await (await waitFor(() => renders[0], 'the render')).done).status, 'failed');
  assert.equal(googlePosts(calls).length, 2);
  const [row] = await jobRow(db);
  assert.equal(row.status, 'failed');
  assert.equal(row.error_reason, 'engine_error');
  assert.equal(row.error_detail, '400: invalid_request Multiple authentication credentials received. Please pass only one.');
  assert.equal(row.est_cost_usd, '0.50');
  const status = await chat(authed({ action: 'VIDEO_STATUS', jobId }));
  assert.equal(status.jsonBody.videoJob.status, 'failed');
  assert.equal(status.jsonBody.videoJob.message, `${FAILURE_PREFIX} The video could not be generated right now. Please try again. Request ID: ${row.request_id}`);
  assert.doesNotMatch(JSON.stringify(status.jsonBody), /Multiple|Google|Gemini/);
});

test('a content-safety refusal from the synchronous call stops at once: no second key, the card says refused', async () => {
  const db = await makeDb();
  const renders = [];
  const safety = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The prompt was blocked due to safety reasons (PROHIBITED_CONTENT).' } });
  const calls = installFetch([renderRoute(renders), ...googleRoutes({ post: () => new Response(safety, { status: 400 }) }), ...dbRoutes(db), ...supabaseRoutes(new Map())]);
  const res = await chat(authed({ prompt: '/video something refused' }));
  const jobId = res.jsonBody.videoJob.id;
  assert.equal((await (await waitFor(() => renders[0], 'the render')).done).status, 'refused');
  assert.equal(googlePosts(calls).length, 1);
  assert.equal((await jobRow(db))[0].error_reason, 'safety_refused');
  const status = await chat(authed({ action: 'VIDEO_STATUS', jobId }));
  assert.equal(status.jsonBody.videoJob.status, 'failed');
  assert.match(status.jsonBody.videoJob.message, /content-safety check/);
});
