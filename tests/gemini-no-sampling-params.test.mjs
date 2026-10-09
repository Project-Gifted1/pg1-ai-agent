/**
 * No sampling parameters and no thinking budget in any Gemini request.
 *
 * Google AI Studio notice, 2026-10-07: since Gemini 3.6 Flash the sampling
 * parameters (temperature, topP, topK) are ignored, and on Google's
 * upcoming models a request carrying them, or thinkingBudget, is refused
 * with 400 INVALID_ARGUMENT. PG1 sends none of them: the model's own
 * defaults apply, thinking level included.
 *
 * Same approach as #262 (gemini-forced-call-rejection.test.mjs): a Gemini
 * stub checks every outgoing request body the way those models will, walks
 * it at every depth for temperature, topP, topK, top_p, top_k,
 * thinkingBudget and thinking_budget, and answers any hit with a 400
 * INVALID_ARGUMENT naming the field. The tests drive every Gemini call path
 * through it:
 *   - chat, JSON and streamed, including the retry without Google Search;
 *   - a recall question's forced search_history round, its unforced retry
 *     (#262), the results round and its plain-text retry (#269);
 *   - /core falling back to the main core when Anthropic is down;
 *   - /image (generateContent with responseModalities);
 *   - PG1 voice on the free Gemini key (lib/ttsRouter.mjs);
 *   - video: the Interactions API start (async) and the sync render;
 *   - the legacy GeminiClient (both methods) and SelfHealingEngine's
 *     recovery attempts, which used to pass temperature/topP;
 *   - the root index.js worker;
 *   - PG1 Studio's film text calls on the paid key (lib/film/providers.mjs
 *     filmThink): the storyboard and a shot check with images;
 *   - PG1 Studio's media fallback on the paid key (geminiStill, geminiClip):
 *     a still and an image-to-video clip with the reference and the
 *     previous shot's last frame.
 * A last test pins the set of source files that call Gemini, so a new call
 * site has to be added here before it can ship.
 *
 * Run with: node --test tests/gemini-no-sampling-params.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { createSseParser } from '../lib/chatStream.mjs';
import { SEARCH_HISTORY_TOOL, RECALL_RETRY_INSTRUCTION, RESULTS_RETRY_INSTRUCTION } from '../lib/chatTools.mjs';
import { __resetImageBreaker } from '../lib/imageEngines.mjs';
import { startVideoJob, renderVideoJob } from '../lib/videoJobs.mjs';
import { synthesizeSpeech } from '../lib/ttsRouter.mjs';
import worker from '../index.js';
import { filmThink, imageBlock, geminiStill, geminiClip } from '../lib/film/providers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const KEY1 = 'AIzaStub-sampling-key-one-0123456789';
const KEY2 = 'AIzaStub-sampling-key-two-0123456789';
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const SUP_URL = 'https://supabase.test';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };

// camelCase and snake_case: the API accepts both spellings of a field.
const FORBIDDEN = new Set(['temperature', 'topP', 'topK', 'top_p', 'top_k', 'thinkingBudget', 'thinking_budget']);

// Every forbidden field in a request body, with where it sits, at any depth.
function forbiddenFields(value, at = '') {
  const found = [];
  if (Array.isArray(value)) value.forEach((v, i) => found.push(...forbiddenFields(v, `${at}[${i}]`)));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      const path = at ? `${at}.${key}` : key;
      if (FORBIDDEN.has(key)) found.push(path);
      found.push(...forbiddenFields(v, path));
    }
  }
  return found;
}

beforeEach(() => {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY1 = KEY1;
  process.env.GEMINI_API_KEY2 = KEY2;
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASEAPI_KEY', 'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'REPLICATE_KEY', 'GITHUB_TOKEN',
    'GITHUB_OWNER_KEY', 'OPENAI_API_KEY', 'PG1_CHAT_TOOL_TIMEOUT_MS']) delete process.env[k];
  __clearAuthRateLimitState();
  __resetImageBreaker();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

// A Gemini that refuses the forbidden fields the way Google's upcoming
// models do. `answer(url, body)` handles a clean request; `other(url,
// options)` any non-Gemini request (default: fail the test).
function geminiStub(answer, other = null) {
  const requests = [];
  const violations = [];
  const fetch = async (url, options = {}) => {
    const u = String(url);
    const host = (() => { try { return new URL(u).hostname; } catch (e) { return ''; } })();
    if (host !== GEMINI_HOST) {
      if (other) return other(u, options);
      throw new Error('Unexpected network call in test: ' + u);
    }
    let body = null;
    try { body = typeof options.body === 'string' ? JSON.parse(options.body) : null; } catch (e) { body = null; }
    requests.push({ url: u, body });
    const bad = forbiddenFields(body);
    if (bad.length) {
      violations.push(`${u.split('/v1beta/')[1]}: ${bad.join(', ')}`);
      return new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: `Invalid JSON payload received. Unknown name "${bad[0].split('.').pop()}" at '${bad[0]}': Cannot find field.` } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return answer(u, body);
  };
  return { fetch, requests, violations };
}

function assertClean(stub, what, min = 1) {
  assert.ok(stub.requests.length >= min, `${what}: made at least ${min} Gemini request(s), made ${stub.requests.length}`);
  for (const r of stub.requests) assert.ok(r.body && typeof r.body === 'object', `${what}: every request has a JSON body (${r.url})`);
  assert.deepEqual(stub.violations, [], `${what}: no sampling parameter or thinking budget in any Gemini request`);
}

const text = (t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });
const reply = (u, status, payload) => {
  if (status !== 200) return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  return u.includes(':streamGenerateContent') ? new Response(`data: ${JSON.stringify(payload)}\n\n`) : Response.json(payload);
};

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.94.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}` }, body });
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
  await chatHandler(makeReq({ ...OPERATOR, ...body }), res);
  return res;
}
function replyOf(res, stream) {
  if (!stream) return res.jsonBody.reply;
  const out = [];
  const parser = createSseParser(({ data }) => out.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return out.filter((e) => e.type === 'text' || e.type === 'error').map((e) => e.text || e.message || '').join('');
}

const hasSearch = (body) => (body.tools || []).some((t) => t.google_search);
const hasResponses = (body) => (body.contents || []).some((c) => (c.parts || []).some((p) => p.functionResponse));
const systemOf = (body) => ((body.systemInstruction || {}).parts || []).map((p) => p.text).join('');
const modeOf = (body) => ((body.toolConfig || {}).functionCallingConfig || {}).mode;

// --- the walker itself -------------------------------------------------------------

test('the stub finds every forbidden field at any depth, in either spelling, and refuses the old chat body', async () => {
  assert.deepEqual(forbiddenFields({
    generationConfig: { maxOutputTokens: 4096, temperature: 0.7, topP: 0.95, topK: 40, thinkingConfig: { thinkingBudget: 0 } },
    generation_config: { top_p: 1, top_k: 1, thinking_config: { thinking_budget: 1024 } },
    contents: [{ parts: [{ text: 'temperature' }, { deep: [{ topK: 3 }] }] }]
  }).sort(), [
    'contents[0].parts[1].deep[0].topK',
    'generationConfig.temperature', 'generationConfig.thinkingConfig.thinkingBudget', 'generationConfig.topK', 'generationConfig.topP',
    'generation_config.thinking_config.thinking_budget', 'generation_config.top_k', 'generation_config.top_p'
  ].sort());
  assert.deepEqual(forbiddenFields({ generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'low' } } }), []);

  const stub = geminiStub(() => Response.json(text('ok')));
  const res = await stub.fetch(`https://${GEMINI_HOST}/v1beta/models/gemini-3.8-flash:generateContent`, {
    method: 'POST', body: JSON.stringify({ contents: [], generationConfig: { maxOutputTokens: 4096, temperature: 0.7 } })
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Unknown name "temperature" at 'generationConfig\.temperature'/);
  assert.equal(stub.violations.length, 1);
});

// --- chat ---------------------------------------------------------------------------

for (const stream of [false, true]) {
  const path = stream ? 'streamed' : 'JSON';

  test(`${path} chat, and its retry without Google Search, send no sampling parameters`, async () => {
    let searchRefused = false;
    const stub = geminiStub((u, body) => {
      if (hasSearch(body) && !searchRefused) {
        searchRefused = true;
        return reply(u, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Search grounding is not supported for this request.' } });
      }
      return reply(u, 200, text('Hello from the stub.'));
    });
    globalThis.fetch = stub.fetch;
    const res = await chat({ prompt: 'hello there', ...(stream ? { stream: true } : {}) });
    assert.match(replyOf(res, stream), /Hello from the stub/);
    assert.ok(stub.requests.some((r) => hasSearch(r.body)) && stub.requests.some((r) => !hasSearch(r.body)), 'the search request and its retry without search');
    assert.ok(stub.requests.every((r) => r.body.generationConfig && r.body.generationConfig.maxOutputTokens === 4096), 'maxOutputTokens is still sent');
    assert.ok(stub.requests.every((r) => !('thinkingConfig' in r.body.generationConfig)), 'no thinkingConfig: the model default applies');
    assertClean(stub, `${path} chat`, 2);
  });

  test(`${path} recall: the forced round, its unforced retry (#262), the results round and its plain retry (#269) send no sampling parameters`, async () => {
    process.env.SUPABASE_URL = SUP_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key-sampling-0000';
    const rows = [{ id: 7, role: 'user', content: 'The patch adds the content_tsv column.', created_at: '2026-10-05T09:15:00Z', match_type: 'all_words', score: 1 }];
    const stub = geminiStub((u, body) => {
      if (modeOf(body) === 'ANY') return reply(u, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } });
      if (hasResponses(body)) return reply(u, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } });
      if (systemOf(body).includes(RESULTS_RETRY_INSTRUCTION)) return reply(u, 200, text('On 2026-10-05 you pasted the content_tsv patch.'));
      if (modeOf(body) === 'AUTO' && systemOf(body).includes(RECALL_RETRY_INSTRUCTION)) {
        return reply(u, 200, { candidates: [{ content: { parts: [{ functionCall: { name: SEARCH_HISTORY_TOOL, args: { query: 'patch' } } }] } }] });
      }
      return reply(u, 200, text(''));
    }, (u, options) => {
      if (u.includes('/rest/v1/messages?') && u.includes('content_tsv=')) return Response.json(rows);
      if (u.includes('/rest/v1/rpc/search_messages_fallback')) return Response.json(rows);
      if (u.includes('/rest/v1/pg1_errors')) return new Response(options.method === 'POST' ? '' : '[]', { status: options.method === 'POST' ? 201 : 200 });
      if (u.includes('/rest/v1/') || u.includes('/storage/v1/')) return Response.json([]);
      throw new Error('Unexpected network call in test: ' + u);
    });
    globalThis.fetch = stub.fetch;
    const res = await chat({ prompt: 'what did we say about the patch?', ...(stream ? { stream: true } : {}) });
    assert.match(replyOf(res, stream), /content_tsv patch/);
    const bodies = stub.requests.map((r) => r.body);
    assert.ok(bodies.some((b) => modeOf(b) === 'ANY'), 'the forced search_history round');
    assert.ok(bodies.some((b) => modeOf(b) === 'AUTO' && systemOf(b).includes(RECALL_RETRY_INSTRUCTION)), 'its unforced retry');
    assert.ok(bodies.some(hasResponses), 'the results round');
    assert.ok(bodies.some((b) => systemOf(b).includes(RESULTS_RETRY_INSTRUCTION) && !b.tools), 'its plain-text retry');
    assertClean(stub, `${path} recall`, 4);
  });
}

test('/core falling back to the main core when Anthropic is down sends no sampling parameters to Gemini', async () => {
  process.env.ANTHROPIC_API_KEY = 'stub-anthropic-key-0123456789';
  const anthropic = [];
  const stub = geminiStub((u) => reply(u, 200, text('Hello from the main core.')), (u, options) => {
    if (u.includes('api.anthropic.com')) {
      anthropic.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529 });
    }
    throw new Error('Unexpected network call in test: ' + u);
  });
  globalThis.fetch = stub.fetch;
  const res = await chat({ prompt: '/core explain this' });
  assert.match(res.jsonBody.reply, /Hello from the main core/);
  assert.ok(anthropic.length > 0, 'Anthropic was tried first');
  // Models whose thinking is always on (Opus 5.5, the router's first heavy
  // model) share max_tokens with it, so they get 16000; older ones 4096.
  assert.ok(anthropic.every((b) => b.max_tokens === (/^claude-(?:opus-5|sonnet-5-5|haiku-5-5)/.test(b.model) ? 16000 : 4096) && !('temperature' in b)), 'the Anthropic request carries no sampling parameters');
  assertClean(stub, '/core fallback');
});

test('/image sends only responseModalities and imageConfig in generationConfig', async () => {
  const stub = geminiStub(() => Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_1X1 } }] } }] }));
  globalThis.fetch = stub.fetch;
  const res = await chat({ prompt: '/image a gold shield' });
  assert.equal(res.jsonBody.imageStatus, 'SUCCESS');
  for (const r of stub.requests) assert.deepEqual(Object.keys(r.body.generationConfig).sort(), ['imageConfig', 'responseModalities']);
  assertClean(stub, '/image');
});

test('PG1 voice on the free Gemini key (lib/ttsRouter.mjs) sends only responseModalities and speechConfig', async () => {
  const pcm = Buffer.alloc(4800).toString('base64');
  const stub = geminiStub(() => Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm } }] } }] }));
  const spoken = await synthesizeSpeech({ env: { GEMINI_API_KEY_FREE: KEY1, PG1_TTS_FREE_FIRST: '1', PG1_TTS_GEMINI_VOICE: 'Puck' }, text: 'hello there', dataClass: 'operator', fetchImpl: stub.fetch, log: () => {} });
  assert.equal(spoken.ok, true);
  assert.equal(spoken.mimeType, 'audio/wav');
  for (const r of stub.requests) assert.deepEqual(Object.keys(r.body.generationConfig).sort(), ['responseModalities', 'speechConfig']);
  assertClean(stub, 'voice');
});

// --- video (Interactions API) ---------------------------------------------------------

test('video: the Interactions start and the sync render send no sampling parameters', async () => {
  const JOB_ID = '4f6c2a5e-1b7d-4c39-9a8e-0d2b3c4e5f60';
  const db = (u, options) => {
    if (u.includes('/rest/v1/rpc/pg1_reserve_video_slot')) return Response.json([{ reserved: true, job_id: JOB_ID, clips_used: 0, spent_usd: 0, budget_usd: 5, max_clips: 10 }]);
    if (u.includes('/rest/v1/pg1_video_jobs') && options.method === 'PATCH') return Response.json([{ id: JOB_ID }]);
    if (u.startsWith(SUP_URL)) return Response.json([]);
    throw new Error('Unexpected network call in test: ' + u);
  };
  const env = { PG1_VIDEO_ENABLED: '1', PG1_VIDEO_GOOGLE_ASYNC: '1' };

  const start = geminiStub(() => Response.json({ id: 'v1_interaction_start', status: 'in_progress' }), db);
  const started = await startVideoJob({ env, prompt: 'a gold shield turning slowly', geminiKeys: [KEY1, KEY2], supUrl: SUP_URL, supKey: 'service-role', fetchImpl: start.fetch });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.ok(start.requests.every((r) => r.url.endsWith('/v1beta/interactions')));
  assertClean(start, 'video start');

  const render = geminiStub(() => new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'try later' } }), { status: 503 }), db);
  await renderVideoJob({
    env: { PG1_VIDEO_ENABLED: '1' }, job: { id: JOB_ID, request_id: 'abc123', prompt: 'a gold shield turning slowly', tier: 'standard', duration_s: 5, provider: 'google', model: null },
    geminiKeys: [KEY1, KEY2], supUrl: SUP_URL, supKey: 'service-role', fetchImpl: render.fetch, sleep: async () => {}
  });
  assert.ok(render.requests.every((r) => r.url.endsWith('/v1beta/interactions') && r.body.background === false));
  assertClean(render, 'video render');
});

// --- the legacy client, the self-healing engine and the root worker ------------------

function loadCommonJs(file, sandbox) {
  const mod = { exports: {} };
  vm.runInNewContext(readFileSync(join(ROOT, file), 'utf8'), { ...sandbox, module: mod, exports: mod.exports });
  return mod.exports;
}

test('the legacy GeminiClient sends no sampling parameters, even when a caller passes them', async () => {
  const stub = geminiStub(() => Response.json(text('ok')));
  const GeminiClient = loadCommonJs('api/lib/gemini-client.js', { fetch: stub.fetch, console });
  const c = new GeminiClient(KEY1);
  const old = { temperature: 0.9, topP: 1.0, topK: 40, thinkingBudget: 0 };
  await c.sendRequest('hi', 'system', [], old);
  await c.continueWithFunctionResponse('hi', 'system', [], { name: 'f', response: {} }, [], old);
  assert.equal(stub.requests.length, 2);
  for (const r of stub.requests) assert.deepEqual(r.body.generationConfig, { maxOutputTokens: 4096 });
  assertClean(stub, 'GeminiClient', 2);
});

test("SelfHealingEngine's three recovery attempts send no sampling parameters", async () => {
  const stub = geminiStub(() => Response.json(text('')));
  const quiet = { error() {}, log() {} };
  const GeminiClient = loadCommonJs('api/lib/gemini-client.js', { fetch: stub.fetch, console: quiet });
  const SelfHealingEngine = loadCommonJs('api/lib/self-healing.js', { console: quiet, setTimeout: (fn) => fn() });
  const engine = new SelfHealingEngine(new GeminiClient(KEY1), null, null);
  for (const attempt of [1, 2, 3]) await engine.attemptRecovery(new Error('x'), 'prompt', 'system', [], attempt);
  assertClean(stub, 'SelfHealingEngine', 3);
});

test('the root index.js worker sends no sampling parameters', async () => {
  const stub = geminiStub(() => Response.json(text('worker ok')));
  globalThis.fetch = stub.fetch;
  const res = await worker.fetch(new Request('https://worker.test/', { method: 'POST', body: JSON.stringify({ command: 'hi' }) }), { GEMINI_API_KEY: KEY2 });
  assert.equal((await res.json()).response, 'worker ok');
  assertClean(stub, 'index.js worker');
});

test('PG1 Studio text calls on the paid key send only maxOutputTokens and responseMimeType in generationConfig', async () => {
  const stub = geminiStub(() => Response.json(text('{"ok":true}')));
  const env = { GEMINI_API_KEY_PAID: KEY2 };
  const r = await filmThink({ env, system: 'storyboard', content: 'a film', validate: JSON.parse, fetchImpl: stub.fetch, log: () => {} });
  assert.deepEqual(r.value, { ok: true });
  await filmThink({ env, system: 'check', content: [{ type: 'text', text: 'Frame:' }, imageBlock(Buffer.from('jpeg'))], maxTokens: 4000, fetchImpl: stub.fetch, log: () => {} });
  assertClean(stub, 'film text', 2);
  for (const req of stub.requests) assert.deepEqual(Object.keys(req.body.generationConfig).sort().filter((k) => k !== 'responseMimeType'), ['maxOutputTokens']);
});

test('PG1 Studio media fallback stills and clips on the paid key send no sampling parameters', async () => {
  const frame = Buffer.from(PNG_1X1, 'base64');
  const stub = geminiStub((u) => (u.includes('/interactions')
    ? Response.json({ id: 'int-1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: Buffer.from('mp4').toString('base64'), mime_type: 'video/mp4' }] }] })
    : Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_1X1 } }] } }] })),
  (u) => (u.startsWith(`${SUP_URL}/`) ? new Response(frame, { status: 200 }) : Promise.reject(new Error('Unexpected network call in test: ' + u))));
  const env = { GEMINI_API_KEY_PAID: KEY2 };
  const links = { referenceUrl: `${SUP_URL}/ref.png`, prevFrameUrl: `${SUP_URL}/prev.jpg` };
  await geminiStill({ env, key: KEY2, prompt: 'a harbour at dawn', ...links, fetchImpl: stub.fetch, sleep: async () => {} });
  await geminiClip({ env, key: KEY2, prompt: 'the boat leaves', startImageUrl: `${SUP_URL}/start.png`, ...links, fetchImpl: stub.fetch, sleep: async () => {} });
  assertClean(stub, 'film media', 2);
});

// --- every call site is covered ------------------------------------------------------

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'tests' || name === '.next') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(?:m?js|cjs|ts|tsx|py|html)$/.test(name)) out.push(p);
  }
  return out;
}

test('every source file that calls Gemini is one these tests drive', () => {
  const callers = sourceFiles(ROOT)
    .filter((f) => readFileSync(f, 'utf8').includes(GEMINI_HOST))
    .map((f) => f.slice(ROOT.length + 1))
    .sort();
  assert.deepEqual(callers, ['api/chat.mjs', 'api/lib/gemini-client.js', 'index.js', 'lib/film/providers.mjs', 'lib/imageEngines.mjs', 'lib/ttsRouter.mjs', 'lib/videoJobs.mjs'],
    'a new Gemini call site: drive it through geminiStub above');
});
