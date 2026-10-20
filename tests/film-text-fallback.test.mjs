/**
 * PG1 Studio text calls through the AI router (lib/film/providers.mjs
 * filmThink): the storyboard, timeline edits and shot checks fall back
 * Claude -> the paid Gemini key (commercial_ok engines only, never
 * OpenRouter) when an engine is out of credit, rate limited or down; a
 * refusal never moves on; a key out of credit is left out for an hour. The storyboard
 * passes the same checks (normaliseTimeline) whichever engine writes it,
 * an unusable reply is asked for once more from the same engine before the
 * next one, and the worker log names the engine that wrote it. Film content
 * never reaches the free Gemini key or an old Gemini name.
 *
 * Run with: node --test tests/film-text-fallback.test.mjs
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { __resetRouterState, isTripped, isOutOfCredit } from '../lib/aiRouter.mjs';
import { filmThink, filmTextPlan, filmTextKeys, missingFilmConfig, imageBlock, ANTHROPIC_URL, GEMINI_API, OPENROUTER_URL } from '../lib/film/providers.mjs';
import { normaliseTimeline, extractJsonObject, STORYBOARD_SYSTEM } from '../lib/film/storyboard.mjs';
import { QC_SYSTEM } from '../lib/film/qc.mjs';
import { editOpsFrom } from '../lib/film/chat.mjs';
import { runStoryboard } from '../lib/film/pipeline.mjs';
import { createFilmStore } from '../lib/film/store.mjs';
import { realEngines } from '../scripts/film-render.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch, json } from './helpers/filmDb.mjs';

const ORIGINAL_ENV = { ...process.env };
const SUP_URL = 'https://supabase.test';
const ANTHROPIC = 'sk-ant-film-stub-0123456789abcdef';
const PAID = 'AQ.film-paid-stub-0123456789abcdef';
const FREE = 'AIza-film-free-stub-0123456789abcdef';
const OLD = 'AIza-film-old-name-stub-0123456789';
const OPENROUTER = 'sk-or-film-stub-0123456789abcdef';
const ENV = { ANTHROPIC_API_KEY: ANTHROPIC, GEMINI_API_KEY_PAID: PAID, OPENROUTER_API_KEY: OPENROUTER };

// Anthropic's exact answer for an account with no credit left.
const CREDIT_TOO_LOW = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' }, request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy' });

const STORYBOARD = {
  title: 'Harbour at Dawn', logline: 'A fisher sets out before sunrise.', tier: 'standard',
  style: { look: 'cinematic, cold dawn light, 35mm', grade: 'teal_orange', reference_prompt: 'Mara in a yellow coat' },
  characters: [{ id: 'c1', name: 'Mara', description: 'woman in a yellow oilskin coat' }],
  captions: { enabled: true }, title_card: { text: 'Harbour at Dawn', duration_s: 3 }, end_card: null,
  scenes: [
    { id: 's1', title: 'The quay', music: { mood: 'sparse piano', bpm: 80 }, shots: [
      { id: 's1-sh1', duration_s: 6, camera: 'drone_flyover', description: 'drone shot over the harbour', visual_prompt: 'Aerial flyover of a harbour at dawn', voiceover: 'Every morning starts in the dark.', transition: 'cut', characters: [] },
      { id: 's1-sh2', duration_s: 14, camera: 'push_in', description: 'Mara walks the quay', visual_prompt: 'Mara walks the quay carrying nets', voiceover: '', transition: 'dissolve', characters: ['c1'] }
    ] }
  ]
};

// Stand-in engines. Each answer is a function of the call number for that
// engine (1-based) returning a Response or the reply text.
function engines({ anthropic = () => 'unused', gemini = () => 'unused', openrouter = () => 'unused' } = {}, extra = []) {
  const n = { anthropic: 0, gemini: 0, openrouter: 0 };
  const seen = [];
  const answer = (out, wrap) => (out instanceof Response ? out : wrap(out));
  const fetchImpl = routedFetch([
    [ANTHROPIC_URL, (u, o, body) => {
      seen.push({ engine: 'anthropic', key: o.headers['x-api-key'], body });
      return answer(anthropic(++n.anthropic, body), (t) => json({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage: { input_tokens: 900, output_tokens: 300 } }));
    }],
    [GEMINI_API, (u, o, body) => {
      seen.push({ engine: 'gemini', key: o.headers['x-goog-api-key'], url: u, body });
      return answer(gemini(++n.gemini, body), (t) => json({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 250 } }));
    }],
    [OPENROUTER_URL, (u, o, body) => {
      seen.push({ engine: 'openrouter', key: o.headers.Authorization, body });
      return answer(openrouter(++n.openrouter, body), (t) => json({ choices: [{ message: { content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 700, completion_tokens: 200 } }));
    }],
    ...extra
  ]);
  return { fetchImpl, seen, engines: () => seen.map((s) => s.engine) };
}

const validateStoryboard = (text) => normaliseTimeline({ ...extractJsonObject(text), tier: 'standard' });
const quietLog = () => {};

beforeEach(() => { __resetRouterState(); });
after(() => { process.env = { ...ORIGINAL_ENV }; });

describe('the film text plan', () => {
  test('Claude, then the paid Gemini key; never OpenRouter, the free key or an old Gemini name', () => {
    const env = { ...ENV, GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY: OLD, GEMINI_API_KEY1: OLD, OPENAI_API_KEY: 'sk-openai', VERCEL_AI_API_KEY: 'gw' };
    const plan = filmTextPlan(env);
    assert.deepEqual(plan.map((c) => c.provider), ['anthropic', 'gemini_paid']);
    assert.deepEqual(plan.map((c) => c.key), [ANTHROPIC, PAID]);
    assert.deepEqual(plan[0].models, ['claude-opus-5-5']);
    assert.deepEqual(filmTextPlan({ ...env, PG1_FILM_CLAUDE_MODEL: 'claude-sonnet-5-5' })[0].models, ['claude-sonnet-5-5']);
  });

  test('a GEMINI_API_KEY_PAID that holds the free key is never used, and old names do not stand in for it', () => {
    assert.equal(filmTextKeys({ GEMINI_API_KEY_PAID: FREE, GEMINI_API_KEY_FREE: FREE }).geminiPaid, '');
    assert.deepEqual(filmTextPlan({ GEMINI_API_KEY_PAID: FREE, GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY1: OLD }), []);
    assert.deepEqual(filmTextPlan({ GEMINI_API_KEY_FREE: FREE }), []);
  });

  test('the worker is ready with any one paid text engine, and never with the free key alone', () => {
    const base = { REPLICATE_API_TOKEN: 'r8', CARTESIA_API_KEY: 'car', PG1_VIDEO_MODEL_REPLICATE_IMAGE: 'kwaivgi/kling-v2.1' };
    for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY_PAID']) assert.deepEqual(missingFilmConfig({ ...base, [k]: 'x' }), [], k);
    assert.deepEqual(missingFilmConfig({ ...base, GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY: OLD }), ['ANTHROPIC_API_KEY or GEMINI_API_KEY_PAID']);
    assert.deepEqual(missingFilmConfig({ ...base, OPENROUTER_API_KEY: 'x' }), ['ANTHROPIC_API_KEY or GEMINI_API_KEY_PAID'], 'OpenRouter is not a film text engine');
  });

  test('budgets apply: an engine over budget is left out', () => {
    assert.deepEqual(filmTextPlan({ ...ENV, PG1_DAILY_BUDGET_ANTHROPIC_USD: '0' }).map((c) => c.provider), ['gemini_paid']);
  });
});

describe('filmThink', () => {
  test('Claude out of credit (400 invalid_request_error): the paid Gemini key writes the storyboard, checked the same way', async () => {
    const lines = [];
    const e = engines({ anthropic: () => new Response(CREDIT_TOO_LOW, { status: 400 }), gemini: () => JSON.stringify(STORYBOARD) });
    // The paid fallback chain (an operator film's writing would try a free
    // key first: tests/free-chain-policy.test.mjs; this job has none).
    const r = await filmThink({ env: { ...ENV }, system: STORYBOARD_SYSTEM, content: 'a film', validate: validateStoryboard, purpose: 'storyboard', fetchImpl: e.fetchImpl, log: (l) => lines.push(l) });
    assert.deepEqual(e.engines(), ['anthropic', 'gemini']);
    assert.equal(e.seen[1].key, PAID, 'the paid key');
    assert.equal(e.seen[1].body.generationConfig.responseMimeType, 'application/json');
    assert.equal(r.provider, 'gemini_paid');
    assert.deepEqual(r.value, validateStoryboard(JSON.stringify(STORYBOARD)));
    assert.equal(r.value.scenes[0].shots[1].duration_s, 10, 'clamped by the same checks as a Claude storyboard');
    assert.ok(lines.some((l) => /\[film\] storyboard written by gemini_paid \(gemini-3\.8-flash\) after anthropic failed/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /\[pg1-ai-usage\].*"provider":"anthropic".*"ok":false.*"status":400/.test(l)));
    assert.ok(lines.every((l) => !l.includes(ANTHROPIC) && !l.includes(PAID)), 'no key in the log');
    assert.ok(isOutOfCredit('anthropic'), 'the drained account is known to be out of credit');
    assert.deepEqual(filmTextPlan(ENV).map((c) => c.provider), ['gemini_paid'], 'and left out of the next plans for an hour');
    assert.deepEqual(filmTextPlan(ENV, { now: Date.now() + 61 * 60 * 1000 }).map((c) => c.provider), ['anthropic', 'gemini_paid'], 'checked again after an hour');
  });

  test('an unusable storyboard is asked for once more from the same engine, with the reason, before any fallback', async () => {
    const lines = [];
    const e = engines({ anthropic: (n) => (n === 1 ? 'Here is your film! It has scenes.' : JSON.stringify(STORYBOARD)) });
    const r = await filmThink({ env: ENV, system: STORYBOARD_SYSTEM, content: 'a film', validate: validateStoryboard, purpose: 'storyboard', fetchImpl: e.fetchImpl, log: (l) => lines.push(l) });
    assert.deepEqual(e.engines(), ['anthropic', 'anthropic']);
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.value.title, 'Harbour at Dawn');
    assert.match(e.seen[1].body.messages[0].content, /Your last reply could not be used \(no JSON object in the reply\)/);
    assert.ok(lines.some((l) => /storyboard: anthropic .* unusable reply .* asking it once more/.test(l)));
    assert.equal(lines.filter((l) => /\[pg1-ai-usage\].*"provider":"anthropic".*"ok":true/.test(l)).length, 2, 'the discarded reply is counted too');
  });

  test('two unusable replies move on: the next engine writes it; a storyboard with no scenes counts as unusable', async () => {
    const lines = [];
    const e = engines({
      anthropic: () => '{"title":"x","scenes":[]}',
      gemini: () => '```json\n' + JSON.stringify(STORYBOARD) + '\n```',
      openrouter: () => { throw new Error('OpenRouter is never a film text engine'); }
    });
    const r = await filmThink({ env: ENV, system: STORYBOARD_SYSTEM, content: 'a film', validate: validateStoryboard, purpose: 'storyboard', fetchImpl: e.fetchImpl, log: (l) => lines.push(l) });
    assert.deepEqual(e.engines(), ['anthropic', 'anthropic', 'gemini']);
    assert.equal(r.provider, 'gemini_paid');
    assert.deepEqual(r.value, validateStoryboard(JSON.stringify(STORYBOARD)));
    assert.ok(lines.some((l) => /storyboard written by gemini_paid \(gemini-3\.8-flash\) after anthropic failed/.test(l)));
    assert.equal(isTripped('anthropic'), false, 'a bad reply is not a billing failure');
  });

  test('out-of-credit answers from every commercial_ok engine stop: never OpenRouter, and the next call stops before any engine', async () => {
    const e = engines({
      anthropic: () => new Response(CREDIT_TOO_LOW, { status: 400 }),
      gemini: () => new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.' } }), { status: 429 }),
      openrouter: () => new Response(JSON.stringify({ error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits' } }), { status: 402 })
    });
    await assert.rejects(filmThink({ env: ENV, system: 's', content: 'c', validate: JSON.parse, fetchImpl: e.fetchImpl, log: quietLog }), (err) => {
      assert.equal(err.kind, 'engine');
      assert.equal(err.refused, false);
      assert.match(err.detail, /anthropic: messages claude-opus-5-5 400 invalid_request_error: Your credit balance is too low/);
      assert.match(err.detail, /gemini_paid: .*429 RESOURCE_EXHAUSTED: Your prepayment credits are depleted/);
      assert.doesNotMatch(err.detail, /openrouter/);
      return true;
    });
    assert.deepEqual(e.engines(), ['anthropic', 'gemini'], 'a drained Gemini key is not retried on its second model; OpenRouter is never asked');
    for (const k of ['anthropic', 'gemini_paid#1']) assert.ok(isOutOfCredit(k), k);
    // Both known to be out of credit: the next call stops at once and says so.
    await assert.rejects(filmThink({ env: ENV, system: 's', content: 'c', validate: JSON.parse, fetchImpl: e.fetchImpl, log: quietLog }), (err) => {
      assert.equal(err.kind, 'billing');
      assert.match(err.detail, /out of credit/);
      return true;
    });
    assert.deepEqual(e.engines(), ['anthropic', 'gemini'], 'no engine called again');
  });

  test('a refusal never moves on to another engine', async () => {
    const e = engines({ anthropic: () => json({ model: 'claude-opus-5-5', stop_reason: 'refusal', content: [], stop_details: { category: 'x' } }) });
    await assert.rejects(filmThink({ env: ENV, system: 's', content: 'c', fetchImpl: e.fetchImpl, log: quietLog }), (err) => err.refused === true && err.kind === 'refused');
    assert.deepEqual(e.engines(), ['anthropic']);

    const g = engines({ anthropic: () => new Response(CREDIT_TOO_LOW, { status: 400 }), gemini: () => json({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }) });
    await assert.rejects(filmThink({ env: ENV, system: 's', content: 'c', fetchImpl: g.fetchImpl, log: quietLog }), (err) => err.refused === true);
    assert.deepEqual(g.engines(), ['anthropic', 'gemini']);
  });

  test('a plain 400 that is not about credit does not move on', async () => {
    const e = engines({ anthropic: () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 99999 > 32000' } }), { status: 400 }) });
    await assert.rejects(filmThink({ env: ENV, system: 's', content: 'c', fetchImpl: e.fetchImpl, log: quietLog }), (err) => err.kind === 'engine');
    assert.deepEqual(e.engines(), ['anthropic']);
  });

  test('shot checks carry their frames to every engine in its own image format', async () => {
    const content = [{ type: 'text', text: 'Frame at 1 s:' }, imageBlock(Buffer.from('jpeg-bytes')), { type: 'text', text: 'Shot 1.1: drone shot' }];
    const verdict = '{"pass":true,"score":8,"issues":[],"best_start_s":1,"description":"a harbour"}';
    const e = engines({
      anthropic: () => new Response(CREDIT_TOO_LOW, { status: 400 }),
      gemini: (n) => (n === 1 ? new Response('{"error":{"code":503,"status":"UNAVAILABLE"}}', { status: 503 }) : verdict)
    });
    const r = await filmThink({ env: ENV, system: QC_SYSTEM, content, maxTokens: 4000, effort: 'low', fetchImpl: e.fetchImpl, log: quietLog });
    assert.equal(r.text, verdict);
    assert.equal(e.seen[0].body.messages[0].content[1].type, 'image');
    const gParts = e.seen[1].body.contents[0].parts;
    assert.deepEqual(gParts[1], { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') } });
    assert.deepEqual(e.seen.filter((s) => s.engine === 'gemini').map((s) => s.url.split('/').pop()), ['gemini-3.8-flash:generateContent', 'gemini-3.6-flash:generateContent'], 'a 503 tries the next model');
    assert.ok(!e.engines().includes('openrouter'));
  });
});

describe('the film pipeline on the real engines', () => {
  let db;
  let store;
  beforeEach(async () => {
    db = await makeFilmDb();
    store = createFilmStore({ supUrl: SUP_URL, supKey: 'service-key', fetchImpl: routedFetch(filmDbRoutes(db)) });
  });
  const workdir = () => path.join(os.tmpdir(), `film-fallback-${Math.random().toString(36).slice(2)}`);

  test('runStoryboard: Claude out of credit, the paid Gemini key writes it, the worker log says so', async () => {
    const p = await store.createProject({ request: 'A fisher at dawn', capUsd: 10, status: 'storyboarding' });
    const e = engines({ anthropic: () => new Response(CREDIT_TOO_LOW, { status: 400 }), gemini: (n) => (n === 1 ? '{"title":' : JSON.stringify(STORYBOARD)) });
    const lines = [];
    const eng = realEngines({ ...ENV }, { fetchImpl: e.fetchImpl, log: (l) => lines.push(l) });
    const sb = await runStoryboard({ project: p, store, engines: eng, ff: {}, workdir: workdir(), log: (l) => lines.push(l) });
    assert.deepEqual(e.engines(), ['anthropic', 'gemini', 'gemini'], 'one retry on the bad JSON, on the same engine');
    assert.ok(e.seen.every((s) => s.key !== FREE));
    const saved = await store.getProject(p.id);
    assert.equal(saved.status, 'awaiting_preview_approval');
    assert.equal(saved.timeline.title, 'Harbour at Dawn');
    assert.ok(sb.warnings.some((w) => /was 14 s, set to 10 s/.test(w)), 'the warnings are the accepted storyboard\'s');
    assert.ok(lines.some((l) => /\[film [0-9a-f]{8}\] storyboard written by gemini_paid \(gemini-3\.8-flash\)/.test(l)), lines.join('\n'));
  });

  test('/film edit: plain words are read by the next engine when Claude is out of credit', async () => {
    const p = await store.createProject({ request: 'x', capUsd: 10 });
    const e = engines({ anthropic: () => new Response(CREDIT_TOO_LOW, { status: 400 }), gemini: () => '{"ops":[{"op":"trim","shot":"1.1","duration_s":4}]}' });
    const timeline = validateStoryboard(JSON.stringify(STORYBOARD));
    const out = await editOpsFrom('trim the drone shot to 4 seconds', timeline, { env: { ...ENV }, fetchImpl: e.fetchImpl, store, projectId: p.id });
    assert.deepEqual(out, { ops: [{ op: 'trim', shot: '1.1', duration_s: 4 }], interpreted: true });
    assert.deepEqual(e.engines(), ['anthropic', 'gemini']);
    assert.equal(e.seen[1].key, PAID);
  });
});
