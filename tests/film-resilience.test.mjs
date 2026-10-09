/**
 * PG1 Studio surviving engine rate limits and outages.
 *
 *  - backoff: a throttled media request (429) waits as the engine says
 *    (Retry-After, or the reset time in its message), else backs off
 *    exponentially from 10 s, at most 5 sends and 3 minutes of waiting, and
 *    sends the same request again on the same engine;
 *  - concurrency: once a stage is throttled, it makes one clip at a time;
 *  - stage-level fallback: when Replicate is out of credit or still
 *    throttled, the REST of the stage goes to the paid Gemini key (never the
 *    free key), with the reference still and the previous shot's last frame;
 *    music, which has no Gemini equivalent, fails clearly; every asset and
 *    the QC report say which engine made it (PG1 labels);
 *  - no double charging: a call the engine refused is given back, throttled
 *    attempts never use up a shot's QC retries;
 *  - resume: /film retry (operator only, approve / decline) restarts a
 *    failed film at the stage it stopped and reuses every stored asset,
 *    including the best clip of a shot still being retried;
 *  - the film card names the stage and whether it was throttling or credit,
 *    with PG1's engine names only.
 *
 * Run with: node --test tests/film-resilience.test.mjs
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  mediaFailureKind, retryAfterMs, sendWithThrottleRetry, throttleWaitMs, THROTTLE_POLICY, ENGINE_LABELS, __resetRouterState
} from '../lib/aiRouter.mjs';
import { replicateRun, createFilmMedia, newMediaStage, filmMediaPlan, EngineError, REPLICATE_API, GEMINI_API } from '../lib/film/providers.mjs';
import { INTERACTIONS_URL } from '../lib/videoJobs.mjs';
import { normaliseTimeline } from '../lib/film/storyboard.mjs';
import { runRender } from '../lib/film/pipeline.mjs';
import { createFilmStore } from '../lib/film/store.mjs';
import { FILM_PRICES } from '../lib/film/cost.mjs';
import { parseFilmCommand, FILM_ACTIONS } from '../lib/film/text.mjs';
import { handleFilmCommand, handleFilmApproval, filmCard } from '../lib/film/chat.mjs';
import { normWords } from '../lib/film/qc.mjs';
import { signFilmToken } from '../lib/film/dispatch.mjs';
import { main as workerMain, realEngines } from '../scripts/film-render.mjs';
import { UPSTREAM_BRAND_RE } from '../lib/upstreamFailure.mjs';
import * as realFf from '../lib/film/ffmpeg.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch, json } from './helpers/filmDb.mjs';

const ORIGINAL_ENV = { ...process.env };
const SUP_URL = 'https://supabase.test';
const SECRET = 'film-render-secret-0123456789abcdef';
const REPLICATE = 'r8_film_stub_0123456789abcdef';
const PAID = 'AQ.film-paid-media-stub-0123456789';
const FREE = 'AIza-film-free-media-stub-0123456789';
const OLD = 'AIza-film-old-name-media-stub-012345';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// Replicate's own throttle message for an account with little credit.
const THROTTLED = (s) => JSON.stringify({ title: 'Request was throttled', detail: `Request was throttled. Your rate limit for prediction creation is reduced to 6 requests per minute with a burst of 1 requests while you have less than $5.0 in credit. Your rate limit resets in ~${s}s.`, status: 429 });
const NO_CREDIT = JSON.stringify({ title: 'Insufficient credit', detail: 'You have insufficient credit to run this model. Go to https://replicate.com/account/billing#billing to purchase credit. Once you purchase credit, please wait a few minutes before trying again.', status: 402 });

function storyboardJson() {
  return {
    title: 'Harbour at Dawn', logline: 'A fisher sets out before sunrise.', tier: 'standard',
    style: { look: 'cinematic, cold dawn light, 35mm', grade: 'teal_orange', reference_prompt: 'Mara, a fisher in a yellow coat, and her boat' },
    characters: [{ id: 'c1', name: 'Mara', description: 'woman in her forties, yellow oilskin coat, grey wool hat' }],
    captions: { enabled: true }, title_card: { text: 'Harbour at Dawn', duration_s: 3 }, end_card: null,
    scenes: [
      { id: 's1', title: 'The quay', music: { mood: 'sparse piano, cold', bpm: 80 }, shots: [
        { id: 's1-sh1', duration_s: 6, camera: 'drone_flyover', description: 'drone shot over the harbour', visual_prompt: 'Aerial flyover of a small harbour at dawn', voiceover: 'Every morning starts in the dark.', transition: 'cut', characters: [] },
        { id: 's1-sh2', duration_s: 5, camera: 'push_in', description: 'Mara walks the quay', visual_prompt: 'Mara walks along the quay carrying nets', voiceover: '', continuous: false, transition: 'dissolve', characters: ['c1'] }
      ] },
      { id: 's2', title: 'Out to sea', music: { mood: 'swelling strings', bpm: 96 }, shots: [
        { id: 's2-sh1', duration_s: 7, camera: 'tracking', description: 'boat leaves the harbour', visual_prompt: 'The boat pulls away from the quay', voiceover: 'She has done this for twenty years.', transition: 'cut', characters: ['c1'] },
        { id: 's2-sh2', duration_s: 5, camera: 'tracking', description: 'boat passes the lighthouse', visual_prompt: 'The boat passes the lighthouse', voiceover: '', continuous: true, transition: 'cut', characters: ['c1'] }
      ] },
      { id: 's3', title: 'Sunrise', music: { mood: 'warm, hopeful', bpm: 90 }, shots: [
        { id: 's3-sh1', duration_s: 8, camera: 'drone_flyover', description: 'drone shot of the boat at sunrise', visual_prompt: 'Aerial shot of the boat on a golden sea at sunrise', voiceover: 'And every morning, the sun finds her.', transition: 'cut', characters: ['c1'] }
      ] }
    ]
  };
}

function fakeFf() {
  const touch = async (f, what) => { await writeFile(f, what); return f; };
  return {
    FILM_SIZES: realFf.FILM_SIZES, TARGET_LUFS: realFf.TARGET_LUFS, buildAss: realFf.buildAss, writeText: realFf.writeText,
    probeDuration: async () => 10,
    extractFrame: (i, t, out) => touch(out, 'frame'),
    extractLastFrame: (i, out) => touch(out, 'last'),
    thumbnail: (i, t, out) => touch(out, 'thumb'),
    segmentFromStill: (s, o) => touch(o.out, 'still-seg'),
    segmentFromClip: (c, o) => touch(o.out, 'clip-seg'),
    segmentCard: (o) => touch(o.out, 'card'),
    joinSegments: (files, d, j, out) => touch(out, 'join'),
    mixAudio: (o) => touch(o.out, 'mix'),
    normaliseLoudness: async (i, out) => { await touch(out, 'loud'); return { file: out, measured: { input_i: '-22' }, after: { input_i: '-14.0' } }; },
    finalEncode: (o) => touch(o.out, 'final'),
    extractAudioForCheck: (i, out) => touch(out, 'wav')
  };
}

// Stand-ins for everything but the media engines: voice, shot checks
// (failing the shots in qcFail that many times), transcript.
function textAndVoice({ qcFail = {}, calls = [] } = {}) {
  const fails = { ...qcFail };
  return {
    voice: async ({ text }) => { calls.push(['voice', text]); return { wav: Buffer.from('wav'), durationS: 2, words: normWords(text).map((w, i) => ({ word: w, start: i * 0.3, end: i * 0.3 + 0.25 })) }; },
    image: (b) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(b).toString('base64') } }),
    think: async ({ content }) => {
      const m = /^Shot \d+\.\d+: (.+)$/m.exec(content[content.length - 1].text);
      const desc = m ? m[1] : '';
      calls.push(['qc', desc]);
      if (fails[desc] > 0) { fails[desc]--; return { text: '{"pass":false,"score":3,"issues":[{"type":"artifact","detail":"warped hands"}],"best_start_s":1,"description":"bad"}' }; }
      return { text: `{"pass":true,"score":8,"issues":[],"best_start_s":1.5,"description":"Clip of ${desc}"}` };
    },
    transcribe: async () => ({ text: '', words: [] })
  };
}

// Stand-in media engines (bytes, the primary engine's).
function fakeMedia({ calls = [], clip = null } = {}) {
  return {
    still: async ({ referenceUrl }) => { calls.push(['still', !!referenceUrl]); return Buffer.from('png'); },
    music: async ({ mood }) => { calls.push(['music', mood]); return { bytes: Buffer.from('wav'), ext: 'wav', mime: 'audio/wav' }; },
    clip: clip || (async ({ prompt }) => { calls.push(['clip', prompt.split('\n')[0]]); return Buffer.from('mp4'); })
  };
}

// A Replicate + paid Gemini stand-in. `replicate(n, body, url)` answers the
// n-th create call (a Response, or undefined for a finished prediction).
function mediaRoutes(state) {
  const seen = state.seen = state.seen || [];
  state.n = state.n || { replicate: 0 };
  return [
    [`${REPLICATE_API}/models/`, (u, o, body) => {
      const n = ++state.n.replicate;
      seen.push({ engine: 'replicate', url: u, body, key: o.headers.Authorization });
      const r = state.replicate ? state.replicate(n, body, u) : undefined;
      if (r) return r;
      const ext = /lyria|music/.test(u) ? 'wav' : /kling|video/.test(u) ? 'mp4' : 'png';
      return json({ id: `pred-${n}`, status: 'succeeded', output: `https://replicate.delivery/out-${n}.${ext}` }, 201);
    }],
    ['https://replicate.delivery/', () => new Response(Buffer.from('media-bytes'), { status: 200 })],
    [`${GEMINI_API}/`, (u, o, body) => {
      seen.push({ engine: 'gemini', url: u, body, key: o.headers['x-goog-api-key'] });
      return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] });
    }],
    [INTERACTIONS_URL, (u, o, body) => {
      seen.push({ engine: 'gemini_video', url: u, body, key: o.headers['x-goog-api-key'] });
      return json({ id: 'int-1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: Buffer.from('gemini-mp4').toString('base64'), mime_type: 'video/mp4' }] }] });
    }]
  ];
}

const inlineImages = (body) => JSON.stringify(body).match(/"(?:inlineData|mime_type)"/g) || [];
const tmp = () => path.join(os.tmpdir(), `film-res-${Math.random().toString(36).slice(2)}`);
const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);
const sum = (rows) => rows.reduce((s, a) => s + Number(a.cost_usd || 0), 0);
// The full render's transcript check of the final mix (pipeline.mjs).
const audioCheckUsd = (qc) => Math.round(Math.max(0.01, qc.durationS * FILM_PRICES.transcribePerSecondUsd) * 100) / 100;

beforeEach(() => __resetRouterState());
after(() => { process.env = { ...ORIGINAL_ENV }; });

// --- 1. backoff ------------------------------------------------------------------------

describe('throttling: wait, then the same request on the same engine', () => {
  test('a throttle is told from a credit failure, even when the throttle message mentions credit', () => {
    assert.equal(mediaFailureKind(429, THROTTLED(10)), 'throttled');
    assert.equal(mediaFailureKind(429, 'Too Many Requests'), 'throttled');
    assert.equal(mediaFailureKind(429, ''), 'throttled');
    assert.equal(mediaFailureKind(402, NO_CREDIT), 'billing');
    assert.equal(mediaFailureKind(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'), 'billing');
    assert.equal(mediaFailureKind(500, 'internal error'), 'error');
  });

  test('the wait comes from Retry-After or the reset time in the message', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    assert.equal(retryAfterMs({ headers: new Headers({ 'retry-after': '7' }) }), 7000);
    assert.equal(retryAfterMs({ headers: new Headers({ 'retry-after': 'Fri, 09 Oct 2026 12:00:30 GMT' }), now }), 30000);
    assert.equal(retryAfterMs({ headers: new Headers({ 'x-ratelimit-reset': String(now / 1000 + 12) }), now }), 12000);
    assert.equal(retryAfterMs({ text: THROTTLED(10) }), 10000);
    assert.equal(retryAfterMs({ text: 'Rate limited. Please try again in 1m30s.' }), 90000);
    assert.equal(retryAfterMs({ text: 'Request was throttled. Expected available in 2 minutes.' }), 120000);
    assert.equal(retryAfterMs({ text: 'Quota resets at 2026-10-09T12:00:45Z', now }), 45000);
    assert.equal(retryAfterMs({ text: 'Too Many Requests' }), null);
  });

  test('without a hint: exponential backoff from 10 s, at most 5 sends, 3 minutes of waiting in all', async () => {
    assert.deepEqual(THROTTLE_POLICY, { baseMs: 10000, maxAttempts: 5, maxTotalWaitMs: 180000 });
    assert.deepEqual([1, 2, 3, 4].map((n) => throttleWaitMs(n)), [10000, 20000, 40000, 80000]);
    const waits = [];
    let sends = 0;
    const r = await sendWithThrottleRetry(async () => { sends++; return { throttled: true }; }, { sleep: async (ms) => waits.push(ms) });
    assert.equal(sends, 5);
    assert.deepEqual(waits, [10000, 20000, 40000, 80000]);
    assert.ok(r.exhausted && r.waitedMs <= 180000);
    // A long hint stops before the cap is passed.
    const long = [];
    const r2 = await sendWithThrottleRetry(async () => ({ throttled: true, waitMs: 100000 }), { sleep: async (ms) => long.push(ms) });
    assert.deepEqual(long, [100000]);
    assert.ok(r2.exhausted);
  });

  test('replicateRun waits out 429s and sends the identical request again on the same model', async () => {
    const waits = [];
    const heard = [];
    const state = {
      replicate: (n) => (n === 1 ? new Response(THROTTLED(4), { status: 429, headers: { 'retry-after': '3' } })
        : n === 2 ? new Response(THROTTLED(5), { status: 429 }) : undefined)
    };
    const fetchImpl = routedFetch(mediaRoutes(state));
    const r = await replicateRun({ env: { REPLICATE_API_TOKEN: REPLICATE }, model: 'black-forest-labs/flux-kontext-pro', input: { prompt: 'a harbour' }, fetchImpl, sleep: async (ms) => waits.push(ms), onThrottle: (t) => heard.push(t.attempt) });
    assert.match(r.url, /out-3\.png$/);
    assert.deepEqual(waits, [3000, 5000], 'Retry-After first, then the reset time in the message');
    assert.deepEqual(heard, [1, 2]);
    const creates = state.seen.filter((s) => s.engine === 'replicate');
    assert.equal(creates.length, 3);
    assert.ok(creates.every((c) => c.url === creates[0].url && JSON.stringify(c.body) === JSON.stringify(creates[0].body)), 'same engine, same request');
  });

  test('still throttled after 5 sends: a throttled error, marked as never started (nothing billed)', async () => {
    const waits = [];
    const state = { replicate: () => new Response('Too Many Requests', { status: 429 }) };
    const err = await replicateRun({ env: { REPLICATE_API_TOKEN: REPLICATE }, model: 'a/b', input: {}, fetchImpl: routedFetch(mediaRoutes(state)), sleep: async (ms) => waits.push(ms) }).catch((e) => e);
    assert.ok(err instanceof EngineError);
    assert.equal(err.kind, 'throttled');
    assert.equal(err.notStarted, true);
    assert.deepEqual(waits, [10000, 20000, 40000, 80000]);
    assert.equal(state.n.replicate, 5);
    // Out of credit is not waited on.
    const s2 = { replicate: () => new Response(NO_CREDIT, { status: 402 }) };
    const e2 = await replicateRun({ env: { REPLICATE_API_TOKEN: REPLICATE }, model: 'a/b', input: {}, fetchImpl: routedFetch(mediaRoutes(s2)), sleep: async () => assert.fail('no wait on a credit failure') }).catch((e) => e);
    assert.equal(e2.kind, 'billing');
    assert.equal(e2.notStarted, true);
    assert.equal(s2.n.replicate, 1);
  });
});

// --- 3. the stage-level Gemini fallback (engines) -----------------------------------------------

describe('media fallback: the rest of the stage on the paid Gemini key', () => {
  const env = { REPLICATE_API_TOKEN: REPLICATE, GEMINI_API_KEY_PAID: PAID, GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY: OLD };
  const links = { referenceUrl: `${SUP_URL}/storage/v1/object/sign/pg1-vault/ref.png?token=t`, prevFrameUrl: `${SUP_URL}/storage/v1/object/sign/pg1-vault/prev.jpg?token=t` };
  const signed = ['/storage/v1/object/sign/pg1-vault/', () => new Response(PNG, { status: 200 })];

  test('the plan is Replicate then the paid key only', () => {
    assert.deepEqual(filmMediaPlan(env).map((c) => [c.provider, c.key]), [['replicate', REPLICATE], ['gemini_paid', PAID]]);
    assert.deepEqual(filmMediaPlan({ REPLICATE_API_TOKEN: REPLICATE, GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY: OLD }).map((c) => c.provider), ['replicate'], 'never the free key or an old Gemini name');
    assert.deepEqual(filmMediaPlan({ REPLICATE_API_TOKEN: REPLICATE, GEMINI_API_KEY_PAID: FREE, GEMINI_API_KEY_FREE: FREE }).map((c) => c.provider), ['replicate'], 'a paid key that is the free key is not used');
  });

  test('out of credit: this and every later still and clip go to the paid key, with the reference and the previous frame; music fails clearly', async () => {
    const state = { replicate: () => new Response(NO_CREDIT, { status: 402 }) };
    const fetchImpl = routedFetch([signed, ...mediaRoutes(state)]);
    const logs = [];
    const media = createFilmMedia({ env, fetchImpl, log: (l) => logs.push(l), sleep: async () => {} });
    const stage = newMediaStage();
    const a = await media.still({ prompt: 'shot one', ...links, stage });
    assert.equal(a.engine, 'gemini_paid');
    assert.deepEqual(stage.switched, { from: 'replicate', to: 'gemini_paid', kind: 'billing', what: 'still' });
    const b = await media.still({ prompt: 'shot two', ...links, stage });
    const c = await media.clip({ prompt: 'the boat leaves', startImageUrl: links.prevFrameUrl.replace('prev', 'start'), ...links, tier: 'standard', seconds: 5, stage });
    assert.equal(b.engine, 'gemini_paid');
    assert.equal(c.engine, 'gemini_paid');
    assert.equal(c.bytes.toString(), 'gemini-mp4');
    assert.equal(state.n.replicate, 1, 'Replicate is not asked again for the rest of the stage');
    const gem = state.seen.filter((s) => s.engine !== 'replicate');
    assert.equal(gem.length, 3);
    assert.ok(gem.every((g) => g.key === PAID), 'the paid key only');
    for (const g of gem.filter((x) => x.engine === 'gemini')) {
      assert.equal(inlineImages(g.body).length, 2, 'still: the reference and the previous frame');
      assert.match(JSON.stringify(g.body), /Character and style reference[\s\S]*Last frame of the previous shot/);
    }
    const v = gem.find((x) => x.engine === 'gemini_video').body;
    assert.equal(v.input.filter((p) => p.type === 'image').length, 3, 'clip: its start frame, the reference and the previous frame');
    assert.equal(v.background, false);
    await assert.rejects(media.music({ mood: 'piano', bpm: 80, stage }), (e) => e.kind === 'billing' && e.notStarted && e.fallback.outcome === 'unavailable' && /no music bed engine/.test(e.detail));
    assert.equal(state.n.replicate, 1, 'music is not sent anywhere once the stage has switched');
    assert.ok(logs.some((l) => /the rest of this stage goes to gemini_paid/.test(l)));
  });

  test('still throttled after the waits: the same switch; no paid key: a clear credit or throttle error', async () => {
    const state = { replicate: () => new Response(THROTTLED(1), { status: 429 }) };
    const stage = newMediaStage();
    const media = createFilmMedia({ env, fetchImpl: routedFetch([signed, ...mediaRoutes(state)]), log: () => {}, sleep: async () => {} });
    const out = await media.clip({ prompt: 'x', startImageUrl: links.referenceUrl, ...links, tier: 'standard', seconds: 5, stage });
    assert.equal(out.engine, 'gemini_paid');
    assert.equal(state.n.replicate, 5);
    assert.equal(stage.throttled, true);
    assert.equal(stage.throttles, 4, 'every throttle waited out is counted');
    assert.equal(stage.switched.kind, 'throttled');

    const s2 = { replicate: () => new Response(NO_CREDIT, { status: 402 }) };
    const lone = createFilmMedia({ env: { REPLICATE_API_TOKEN: REPLICATE, GEMINI_API_KEY_FREE: FREE }, fetchImpl: routedFetch([signed, ...mediaRoutes(s2)]), log: () => {} });
    await assert.rejects(lone.still({ prompt: 'x', ...links, stage: newMediaStage() }), (e) => e.kind === 'billing' && e.fallback.outcome === 'not_configured');
    assert.equal(s2.seen.filter((s) => s.engine !== 'replicate').length, 0, 'the free key is never used');
  });
});

// --- the pipeline ------------------------------------------------------------------------

describe('render stages under engine trouble', () => {
  let db;
  let fetchImpl;
  let store;
  let state;
  const env0 = { REPLICATE_API_TOKEN: REPLICATE, GEMINI_API_KEY_PAID: PAID, GEMINI_API_KEY_FREE: FREE };
  beforeEach(async () => {
    db = await makeFilmDb();
    state = {};
    fetchImpl = routedFetch([
      ['api.github.com', () => new Response(null, { status: 204 })],
      ...filmDbRoutes(db),
      ...mediaRoutes(state)
    ]);
    store = createFilmStore({ supUrl: SUP_URL, supKey: 'service-key', fetchImpl });
  });

  const newFilm = async (status, extra = {}) => {
    const p = await store.createProject({ request: 'A fisher at dawn', capUsd: 30, status });
    const rows = await store.updateProject(p.id, { timeline: normaliseTimeline(storyboardJson()), timeline_version: 1, title: 'Harbour at Dawn', ...extra });
    return rows[0];
  };

  // --- 2. concurrency ---
  test('once throttled, the stage makes one clip at a time', async () => {
    const run = async (throttle) => {
      const p = await newFilm('full_rendering');
      let inFlight = 0;
      let max = 0;
      const afterThrottle = [];
      const clip = async ({ stage }) => {
        if (stage.throttled) afterThrottle.push(inFlight);
        inFlight++;
        max = Math.max(max, inFlight);
        if (throttle && !stage.throttled) { stage.throttled = true; stage.throttles++; }
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        return Buffer.from('mp4');
      };
      const r = await runRender({ project: p, stage: 'full', store, engines: { ...fakeMedia({ clip }), ...textAndVoice() }, ff: fakeFf(), workdir: tmp(), env: { PG1_FILM_CONCURRENCY: '3' } });
      return { r, max, afterThrottle };
    };
    const free = await run(false);
    assert.ok(free.max > 1, `unthrottled shots render side by side (max ${free.max})`);
    assert.equal(free.r.qcReport.media.concurrency, 3);
    const t = await run(true);
    assert.ok(t.afterThrottle.length >= 1);
    assert.ok(t.afterThrottle.every((n) => n === 0), `every clip after the throttle starts alone: ${t.afterThrottle}`);
    assert.equal(t.r.qcReport.media.throttled, true);
    assert.equal(t.r.qcReport.media.concurrency, 1);
  });

  // --- 3 + 4 + 5 + resume: the preview ---
  test('preview: credit runs out mid-stills, the rest go to the paid key, music stops it clearly; /film retry reuses every still and pays once', async () => {
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: SUP_URL, SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
    const p = await newFilm('preview_queued');
    const workerEnv = { ...process.env, ...env0, PG1_VIDEO_RENDER_SECRET: SECRET, FILM_PROJECT_ID: p.id, FILM_STAGE: 'preview' };
    workerEnv.FILM_TOKEN = signFilmToken(p.id, workerEnv);
    // Reference and shot 1 made; then Replicate is out of credit.
    state.replicate = (n) => (n >= 3 ? new Response(NO_CREDIT, { status: 402 }) : undefined);
    const engines = () => ({ ...realEngines(workerEnv, { fetchImpl, log: () => {}, sleep: async () => {} }), ...textAndVoice() });
    const logs = [];
    assert.equal(await workerMain(workerEnv, { engines: engines(), fetchImpl, ffImpl: fakeFf(), log: (l) => logs.push(l) }), 1);

    let film = await store.getProject(p.id);
    assert.equal(film.status, 'failed');
    assert.equal(film.error_reason, 'out_of_credit');
    assert.equal(film.failure.stage, 'preview');
    assert.equal(film.failure.step, 'music');
    assert.deepEqual(film.failure.fallback, { engine: ENGINE_LABELS.gemini_paid, outcome: 'unavailable' });
    assert.equal(state.n.replicate, 3, 'Replicate was not asked again after it ran out of credit');
    const gem = state.seen.filter((s) => s.engine === 'gemini');
    assert.equal(gem.length, 4, 'shots 2 to 5 on the paid key');
    assert.ok(gem.every((g) => g.key === PAID && inlineImages(g.body).length === 2), 'each with the reference and the previous shot\'s frame');

    // The media library says which engine made each still.
    let assets = await store.listAssets(p.id);
    const stills = assets.filter((a) => a.kind === 'keyframe').sort((a, b) => a.scene - b.scene || a.shot - b.shot);
    assert.deepEqual(stills.map((a) => a.meta.engine), [ENGINE_LABELS.replicate, ...Array(4).fill(ENGINE_LABELS.gemini_paid)]);
    assert.equal(assets.find((a) => a.kind === 'reference').meta.engine, ENGINE_LABELS.replicate);
    assert.equal(assets.filter((a) => a.kind === 'music').length, 0);
    // Charged only for what was made: the refused music call was given back.
    assert.equal(money(film.spent_usd), money(sum(assets)));

    // The card names the stage, the step and that it was credit, PG1 names only.
    const card = await filmCard(store, film);
    assert.match(card.message, /PG1 Studio stopped at the preview \(the music beds\): the PG1 media engine is out of credit, and the PG1 main core cannot stand in for music/);
    assert.match(card.message, new RegExp(`/film retry ${p.id.slice(0, 8)}`));
    assert.doesNotMatch(card.message, UPSTREAM_BRAND_RE);
    assert.deepEqual(card.failure, { stage: 'preview', step: 'music', reason: 'out_of_credit' });

    // /film retry: operator only, through approve.
    const cmdOpts = { env: { ...workerEnv, PG1_VIDEO_ENABLED: '1', GITHUB_TOKEN: 'gh-test' }, supUrl: SUP_URL, supKey: 'service-key', fetchImpl };
    assert.deepEqual(parseFilmCommand(`/film retry ${p.id.slice(0, 8)}`), { sub: 'retry', id: p.id.slice(0, 8), rest: '' });
    const guest = await handleFilmCommand({ ...cmdOpts, text: `/film retry ${p.id.slice(0, 8)}`, isOperator: false });
    assert.match(guest.reply, /Only the signed-in operator/);
    const proposed = await handleFilmCommand({ ...cmdOpts, text: `/film retry ${p.id.slice(0, 8)}`, isOperator: true });
    assert.match(proposed.reply, /retry film .* from the preview, where it stopped/);
    assert.match(proposed.reply, /9 assets already made .* are reused, not made or paid for again/, 'the reference, 5 stills and 3 voice lines');
    assert.match(proposed.reply, /Music beds ×3/);
    assert.doesNotMatch(proposed.reply, /Shot stills|Reference still/, 'stills are not estimated again');
    assert.doesNotMatch(proposed.reply, UPSTREAM_BRAND_RE);
    const row = (await db.query('select * from pending_actions where token = $1', [proposed.pendingApproval.token])).rows[0];
    assert.equal(row.action_type, FILM_ACTIONS.retry);
    const notOp = await handleFilmApproval({ ...cmdOpts, row, decision: 'approve', isOperator: false });
    assert.equal(notOp.resolution, null);
    assert.equal((await store.getProject(p.id)).status, 'failed');
    const ok = await handleFilmApproval({ ...cmdOpts, row, decision: 'approve', isOperator: true });
    assert.equal(ok.resolution, 'approved');
    assert.match(ok.reply, /rendering the low-res preview .*reusing everything already made/);
    film = await store.getProject(p.id);
    assert.equal(film.status, 'preview_queued');
    assert.equal(film.failure, null);
    const dispatch = fetchImpl.calls.filter((c) => c.url.includes('api.github.com')).pop();
    assert.equal(dispatch.body.inputs.stage, 'preview');

    // The worker runs the stage again with credit back: no still is made
    // again, the music is, and everything is paid for once.
    state.replicate = undefined;
    const before = { replicate: state.n.replicate, gemini: state.seen.filter((s) => s.engine === 'gemini').length };
    workerEnv.FILM_TOKEN = signFilmToken(p.id, workerEnv);
    assert.equal(await workerMain(workerEnv, { engines: engines(), fetchImpl, ffImpl: fakeFf(), log: () => {} }), 0);
    film = await store.getProject(p.id);
    assert.equal(film.status, 'preview_done');
    assert.equal(state.n.replicate - before.replicate, 3, 'only the three music beds');
    assert.ok(state.seen.slice(-3).every((s) => /lyria/.test(s.url)));
    assert.equal(state.seen.filter((s) => s.engine === 'gemini').length, before.gemini);
    assets = await store.listAssets(p.id);
    assert.equal(assets.filter((a) => a.kind === 'keyframe').length, 5);
    assert.equal(assets.filter((a) => a.kind === 'reference').length, 1);
    assert.equal(money(film.spent_usd), money(sum(assets)), 'no double charge');
    assert.equal(film.qc_report.reused.keyframes, 5);
    assert.deepEqual(film.qc_report.engines, { [ENGINE_LABELS.replicate]: 3 }, 'this run made only the music, on the media engine');
  });

  // --- 3 + 4: the full render ---
  test('full render: throttled clips are waited out without using up QC retries, then the rest of the stage goes to the paid key; the QC report says which engine made each shot', async () => {
    const pre = await newFilm('preview_rendering');
    await runRender({ project: pre, stage: 'preview', store, engines: { ...fakeMedia(), ...textAndVoice() }, ff: fakeFf(), workdir: tmp() });
    const spentBefore = Number((await store.getProject(pre.id)).spent_usd);
    // Clip 1 throttled twice then made; clip 2 throttled to the end -> switch.
    state.n.replicate = 0;
    state.replicate = (n) => (n <= 2 || (n >= 4 && n <= 8) ? new Response(THROTTLED(2), { status: 429 }) : undefined);
    const calls = [];
    const engines = { ...realEngines(env0, { fetchImpl, log: () => {}, sleep: async () => {} }), ...textAndVoice({ calls }) };
    const p = await store.getProject(pre.id);
    const r = await runRender({ project: p, stage: 'full', store, engines, ff: fakeFf(), workdir: tmp(), env: { ...env0, PG1_FILM_CONCURRENCY: '1' } });
    assert.equal(state.n.replicate, 8, '3 sends for clip 1, 5 for clip 2');
    assert.equal(r.qcReport.generated.retries, 0, 'throttles never use up a QC retry');
    assert.ok(r.qcReport.shots.every((s) => s.attempts === 1));
    assert.deepEqual(r.qcReport.shots.map((s) => s.engine), [ENGINE_LABELS.replicate, ...Array(4).fill(ENGINE_LABELS.gemini_paid)]);
    assert.deepEqual(r.qcReport.engines, { [ENGINE_LABELS.replicate]: 1, [ENGINE_LABELS.gemini_paid]: 4 });
    assert.deepEqual(r.qcReport.media.fallback, { from: ENGINE_LABELS.replicate, to: ENGINE_LABELS.gemini_paid, reason: 'throttled', at: 'clip' });
    assert.equal(r.qcReport.media.concurrency, 1);
    assert.doesNotMatch(JSON.stringify(r.qcReport), UPSTREAM_BRAND_RE);
    const videos = state.seen.filter((s) => s.engine === 'gemini_video');
    assert.equal(videos.length, 4);
    for (const v of videos) assert.ok(v.body.input.filter((x) => x.type === 'image').length >= 2, 'a start frame plus the reference (and the previous frame when it differs)');
    const clips = (await store.listAssets(p.id)).filter((a) => a.kind === 'clip');
    // Charged each clip at its own engine's price plus its check: nothing for the refused sends.
    const spent = Number((await store.getProject(p.id)).spent_usd) - spentBefore;
    assert.equal(money(spent), money(sum(clips) + clips.length * FILM_PRICES.qcUsd + audioCheckUsd(r.qcReport)));
  });

  // --- 4 + resume: a stage stopped mid-retry ---
  test('a stage stopped mid-retry keeps the clip it paid for, gives back the refused call, and the retry starts from it', async () => {
    const pre = await newFilm('preview_rendering');
    await runRender({ project: pre, stage: 'preview', store, engines: { ...fakeMedia(), ...textAndVoice() }, ff: fakeFf(), workdir: tmp() });
    const spentBefore = Number((await store.getProject(pre.id)).spent_usd);
    let p = await store.getProject(pre.id);
    const made = [];
    let lighthouse = 0;
    const clip = async ({ prompt }) => {
      const desc = prompt.split('\n')[0];
      if (desc === 'The boat passes the lighthouse' && ++lighthouse === 2) throw new EngineError('billing', 'the engine is out of credit', { notStarted: true, engine: 'replicate', fallback: { engine: 'gemini_paid', outcome: 'not_configured' } });
      made.push(desc);
      return Buffer.from(`mp4-${made.length}`);
    };
    await assert.rejects(
      runRender({ project: p, stage: 'full', store, engines: { ...fakeMedia({ clip }), ...textAndVoice({ qcFail: { 'boat passes the lighthouse': 1 } }) }, ff: fakeFf(), workdir: tmp(), env: { PG1_FILM_CONCURRENCY: '1' } }),
      (e) => e.kind === 'billing' && e.step === 'clips'
    );
    const all = await db.query('select kind, status, shot_id, cost_usd, meta from pg1_film_assets where project_id = $1 and kind = $2', [p.id, 'clip']);
    const kept = all.rows.filter((a) => a.status === 'rejected');
    assert.equal(kept.length, 1, 'the lighthouse clip that failed its check is kept');
    assert.equal(kept[0].shot_id, 's2-sh2');
    assert.equal(kept[0].meta.attempts.length, 1);
    assert.equal(all.rows.filter((a) => a.status === 'ok').length, 3);
    let spent = Number((await store.getProject(p.id)).spent_usd) - spentBefore;
    assert.equal(money(spent), money(sum(all.rows) + made.length * FILM_PRICES.qcUsd), 'the refused call was given back');

    // The retry: only the lighthouse's next attempt and the last shot.
    made.length = 0;
    lighthouse = 10;
    p = await store.getProject(p.id);
    const r = await runRender({ project: p, stage: 'full', store, engines: { ...fakeMedia({ clip }), ...textAndVoice() }, ff: fakeFf(), workdir: tmp(), env: { PG1_FILM_CONCURRENCY: '1' } });
    assert.deepEqual(made, ['The boat passes the lighthouse', 'Aerial shot of the boat on a golden sea at sunrise']);
    assert.equal(r.qcReport.reused.clips, 3);
    assert.equal(r.qcReport.reused.candidates, 1);
    assert.equal(r.qcReport.shots.find((s) => s.shotId === 's2-sh2').attempts, 2, 'the kept attempt counts against the shot\'s retries');
    const after = await db.query('select status, shot_id, cost_usd from pg1_film_assets where project_id = $1 and kind = $2', [p.id, 'clip']);
    assert.equal(after.rows.filter((a) => a.status === 'ok').length, 5);
    assert.equal(after.rows.filter((a) => a.status === 'superseded').length, 1);
    spent = Number((await store.getProject(p.id)).spent_usd) - spentBefore;
    assert.equal(money(spent), money(sum(after.rows) + 6 * FILM_PRICES.qcUsd + audioCheckUsd(r.qcReport)), 'six clips made across both runs, each paid for once');
  });
});
