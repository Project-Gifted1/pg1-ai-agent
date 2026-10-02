/**
 * Live progress trace for /api/chat, server side (lib/chatStream.mjs and the
 * streaming path in api/chat.mjs):
 *  - SSE parsing (and that the browser twin in public/index.html agrees)
 *  - only real steps: every step maps to a network call that really ran
 *  - secret redaction in step labels, results and details
 *  - no memory contents, system prompt or model thinking in the stream
 *  - client disconnect aborts the upstream call and writes nothing more
 *  - the non-streamed JSON path is unchanged
 *
 * Every fake credential comes from tests/fixtures/fake-secrets.mjs.
 *
 * Run with: node --test tests/chat-stream.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import {
  createChatStream, createSseParser, createReplyScrubber, redactTraceText, scrubIdentity, STREAM_EVENT_TYPES
} from '../lib/chatStream.mjs';
import { secretEnvValues } from '../lib/handoff.mjs';
import { FAKE, bearerHeader, postgresUrl } from './fixtures/fake-secrets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '../public/index.html'), 'utf-8');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const ALL_FAKES = Object.values(FAKE).concat([bearerHeader(), postgresUrl()]);

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY = 'stub-gemini-key';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'PG1_TEST_SECRET_TOKEN']) delete process.env[k];
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function useSupabase() {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
}

let ipSeq = 0;
function makeReq(body) {
  return { method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.42.0.${++ipSeq}` }, body };
}
const authed = (extra) => ({ user: 'test-operator', pass: 'test-secret-pass', ...extra });

function makeRes() {
  const listeners = {};
  return {
    statusCode: null,
    headers: {},
    chunks: [],
    jsonBody: null,
    ended: false,
    onWrite: null,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); if (this.onWrite) this.onWrite(String(c)); return true; },
    end() { this.ended = true; return this; },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev) { (listeners[ev] || []).forEach((fn) => fn()); }
  };
}

function eventsOf(res) {
  const out = [];
  const parser = createSseParser(({ event, data }) => {
    const ev = JSON.parse(data);
    assert.equal(ev.type, event, 'SSE event name matches the payload type');
    out.push(ev);
  });
  parser.push(res.chunks.join(''));
  parser.end();
  return out;
}

const sseBody = (objs) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');
const geminiChunk = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }] }, ...extra }] });

// Records every network call; `routes` answers by URL substring.
function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', body: options.body, signal: options.signal });
    for (const [needle, handler] of routes) {
      if (u.includes(needle)) return handler(u, options);
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}

const supabaseRoutes = (overrides = {}) => [
  ['/rest/v1/messages?select=id', () => new Response('[]')],
  ['/rest/v1/messages?select=role', () => new Response(JSON.stringify(overrides.memory || []))],
  ['/rest/v1/messages', () => new Response('[]', { status: 201 })],
  ['/storage/v1/object/list/pg1-vault', () => new Response(JSON.stringify(overrides.vault || []))],
  ['/rest/v1/threat_indicators', () => new Response(JSON.stringify(overrides.threats || []))],
  ['/rest/v1/pg1_errors', () => new Response(JSON.stringify(overrides.errors || []))]
];

const geminiRoute = (chunks) => ['streamGenerateContent', () => new Response(sseBody(chunks))];

// What has to have happened for each step id to be honest.
const STEP_EVIDENCE = {
  db: (c) => c.url.includes('/rest/v1/messages?select=id'),
  memory: (c) => c.url.includes('/rest/v1/messages?select=role'),
  vault: (c) => c.url.includes('/storage/v1/object/list/pg1-vault'),
  threats: (c) => c.url.includes('/rest/v1/threat_indicators'),
  errors: (c) => c.url.includes('/rest/v1/pg1_errors'),
  'vault-upload': (c) => c.url.includes('/storage/v1/object/pg1-vault/') && c.method === 'POST',
  model: (c) => c.url.includes('streamGenerateContent') || c.url.includes('api.anthropic.com'),
  'model-fallback': (c) => c.url.includes('streamGenerateContent'),
  search: (c) => c.url.includes('streamGenerateContent'),
  github: (c) => c.url.includes('api.github.com'),
  image: (c) => c.url.includes(':predict') || c.url.includes('replicate.com') || c.url.includes('generateContent')
};

function assertOnlyRealSteps(events, calls) {
  const opened = new Set();
  for (const ev of events) {
    if (ev.type === 'step') {
      assert.ok(STEP_EVIDENCE[ev.id], `step "${ev.id}" has no known code path`);
      assert.ok(calls.some(STEP_EVIDENCE[ev.id]), `step "${ev.id}" was emitted but its network call never ran`);
      assert.ok(!opened.has(ev.id), `step "${ev.id}" opened twice`);
      opened.add(ev.id);
    }
    if (ev.type === 'step_done') assert.ok(opened.has(ev.id), `step_done "${ev.id}" without a step`);
  }
  for (const ev of events) assert.ok(STREAM_EVENT_TYPES.includes(ev.type), `unknown event type ${ev.type}`);
}

const stepIds = (events) => events.filter((e) => e.type === 'step').map((e) => e.id);

// --- SSE parsing -------------------------------------------------------------------

const clientCtx = {};
vm.createContext(clientCtx);
vm.runInContext(`${html.match(/const TRACE_EVENT_TYPES = [^\n]*;/)[0].replace(/^const /, 'var ')}\n${extract('parseSseBuffer')}\n${extract('parseTraceEvent')}`, clientCtx);

function extract(name) {
  let start = html.indexOf(`async function ${name}(`);
  if (start === -1) start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found in public/index.html`);
  let depth = 0;
  let i = html.indexOf('{', html.indexOf(')', start));
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

const SAMPLE_STREAM = [
  ': pg1 trace\n\n',
  'event: step\ndata: {"type":"step","id":"memory","label":"Loading memory"}\n\n',
  'event: step_done\ndata: {"type":"step_done","id":"memory","label":"Loaded memory","result":"3 recent messages"}\n\n',
  'event: text\ndata: {"type":"text","text":"Line one\\nline two: with colon"}\n\n',
  'event: done\r\ndata: {"type":"done","request_id":"abc123"}\r\n\r\n'
].join('');

function parseServer(input, splits) {
  const out = [];
  const parser = createSseParser((e) => out.push(e));
  let last = 0;
  for (const at of splits) { parser.push(input.slice(last, at)); last = at; }
  parser.push(input.slice(last));
  parser.end();
  return out;
}

function parseClient(input, splits) {
  const out = [];
  let buffer = '';
  let last = 0;
  for (const at of [...splits, input.length]) {
    const r = clientCtx.parseSseBuffer(buffer + input.slice(last, at));
    buffer = r.rest;
    out.push(...r.events);
    last = at;
  }
  out.push(...clientCtx.parseSseBuffer(buffer + '\n\n').events);
  return out;
}

test('server and browser SSE parsers agree on every split of the same stream', () => {
  const whole = parseServer(SAMPLE_STREAM, []);
  assert.deepEqual(whole.map((e) => e.event), ['step', 'step_done', 'text', 'done']);
  assert.equal(JSON.parse(whole[2].data).text, 'Line one\nline two: with colon');
  for (let at = 1; at < SAMPLE_STREAM.length; at++) {
    // \r\n is normalized per chunk; a split between \r and \n is a different
    // (still valid) stream, so skip that one position.
    if (SAMPLE_STREAM[at - 1] === '\r' && SAMPLE_STREAM[at] === '\n') continue;
    assert.deepEqual(parseServer(SAMPLE_STREAM, [at]), whole, `server split at ${at}`);
    assert.deepEqual(JSON.parse(JSON.stringify(parseClient(SAMPLE_STREAM, [at]))), whole, `client split at ${at}`);
  }
});

test('parseTraceEvent keeps the known types and drops anything malformed or mislabelled', () => {
  const p = (event, data) => clientCtx.parseTraceEvent({ event, data });
  for (const type of STREAM_EVENT_TYPES) assert.equal(p(type, JSON.stringify({ type })).type, type);
  assert.deepEqual([...vm.runInContext('TRACE_EVENT_TYPES', clientCtx)], STREAM_EVENT_TYPES, 'client and server agree on event types');
  assert.equal(p('step', '{not json'), null);
  assert.equal(p('thinking', JSON.stringify({ type: 'thinking', text: 'x' })), null);
  assert.equal(p('step', JSON.stringify({ type: 'text', text: 'x' })), null, 'event name must match payload type');
  assert.equal(p('step', 'null'), null);
});

// --- only real steps ---------------------------------------------------------------

test('a plain chat streams the context steps that ran, the model step, text and done', async () => {
  useSupabase();
  const calls = installFetch([...supabaseRoutes({ errors: [{ route: 'CHAT', status: 500, reason: 'boom' }] }),
    geminiRoute([geminiChunk('Hello '), geminiChunk('operator, all clear.', { finishReason: 'STOP' })])]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hello there', stream: true })), res);

  assert.match(res.headers['Content-Type'], /^text\/event-stream/);
  assert.equal(res.jsonBody, null, 'no JSON body once streaming');
  assert.ok(res.ended);
  const events = eventsOf(res);
  assertOnlyRealSteps(events, calls);
  assert.deepEqual(stepIds(events), ['db', 'memory', 'vault', 'errors', 'model']);
  assert.ok(!stepIds(events).includes('threats'), 'no threat step when the threat table was never read');
  const errorsDone = events.find((e) => e.type === 'step_done' && e.id === 'errors');
  assert.equal(errorsDone.result, '1 unresolved');
  assert.deepEqual(errorsDone.details, ['CHAT 500 boom']);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hello operator, all clear.');
  const last = events[events.length - 1];
  assert.equal(last.type, 'done');
  assert.match(last.request_id, /^[a-z0-9]+$/);
  assert.ok(calls.some((c) => c.url.endsWith('/rest/v1/messages') && c.method === 'POST'), 'finished reply saved to memory');
});

test('the threat step appears only when the threat table is actually queried', async () => {
  useSupabase();
  const calls = installFetch([...supabaseRoutes({ threats: [{ indicator_type: 'IPv4', value: '198.51.100.7', confidence_score: 80 }] }),
    geminiRoute([geminiChunk('Two indicators.')])]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'any new threat indicators today?', stream: true })), res);
  const events = eventsOf(res);
  assertOnlyRealSteps(events, calls);
  assert.ok(stepIds(events).includes('threats'));
  assert.equal(events.find((e) => e.type === 'step_done' && e.id === 'threats').result, '1 record');
});

test('without Supabase there are no context steps, only the model step', async () => {
  const calls = installFetch([geminiRoute([geminiChunk('Reply.')])]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hello', stream: true })), res);
  const events = eventsOf(res);
  assertOnlyRealSteps(events, calls);
  assert.deepEqual(stepIds(events), ['model']);
});

test('web search is a step only when the model reports search queries', async () => {
  const calls = installFetch([geminiRoute([
    geminiChunk('Per today\'s news, '),
    geminiChunk('rates held.', { groundingMetadata: { webSearchQueries: ['central bank rate decision'] } })
  ])]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'what did the central bank do', stream: true })), res);
  const events = eventsOf(res);
  assertOnlyRealSteps(events, calls);
  const done = events.find((e) => e.type === 'step_done' && e.id === 'search');
  assert.equal(done.result, '1 query');
  assert.deepEqual(done.details, ['central bank rate decision']);
});

test('the main-core fallback step appears only after the reasoning core really failed', async () => {
  process.env.ANTHROPIC_API_KEY = FAKE.anthropicKey;
  const calls = installFetch([
    ['api.anthropic.com', () => new Response('{"error":"overloaded"}', { status: 529 })],
    geminiRoute([geminiChunk('Fallback reply.')])
  ]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: '/claude explain this', stream: true })), res);
  const events = eventsOf(res);
  assertOnlyRealSteps(events, calls);
  assert.deepEqual(stepIds(events), ['model', 'model-fallback']);
  const modelDone = events.find((e) => e.type === 'step_done' && e.id === 'model');
  assert.equal(modelDone.failed, true);
  assert.equal(calls.filter((c) => c.url.includes('api.anthropic.com')).length, 2, 'both reasoning models were tried');
});

test('a slash command still streams its context steps, then the same reply as text', async () => {
  useSupabase();
  const calls = installFetch(supabaseRoutes());
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: '/status', stream: true })), res);
  const events = eventsOf(res);
  assertOnlyRealSteps(events, calls);
  assert.ok(!stepIds(events).includes('model'), 'no model step: /status never calls a model');
  assert.match(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), /SYSTEM STATUS/);
  assert.equal(events[events.length - 1].type, 'done');
});

test('GitHub is a step only from the first real GitHub request, with the real count', async () => {
  const res = makeRes();
  const stream = createChatStream(res, { requestId: 'r1' });
  stream.start();
  let n = 0;
  const traced = stream.wrapFetch(async (url) => ({ ok: !String(url).includes('missing'), n: ++n }));
  await traced('https://example.supabase.co/rest/v1/x');
  assert.ok(!stream.events.some((e) => e.type === 'step'), 'non-GitHub call opens no step');
  await traced('https://api.github.com/repos/o/r/git/ref/heads/main');
  await traced('https://api.github.com/repos/o/r/contents/missing');
  stream.done();
  const ev = stream.events;
  assert.deepEqual(ev.filter((e) => e.type === 'step').map((e) => e.id), ['github']);
  const done = ev.find((e) => e.type === 'step_done');
  assert.equal(done.result, '2 requests · 1 failed');
  assert.equal(done.failed, true);
});

test('a patch request routed through chat counts every GitHub call, including path lookup', async () => {
  process.env.GITHUB_TOKEN = FAKE.githubPat;
  const calls = installFetch([
    ['/git/trees/main', () => new Response(JSON.stringify({ tree: [{ type: 'blob', path: 'README.md', sha: 'a' }] }))],
    ['/git/ref/heads/main', () => new Response('nope', { status: 404 })]
  ]);
  const res = makeRes();
  const patch = JSON.stringify({ actionType: 'APPLY_SURGICAL_PATCH', targetFile: 'README.md', search: 'a', replace: 'b', isAuthorizedAction: true });
  await chatHandler(makeReq(authed({ prompt: patch, stream: true })), res);
  const events = eventsOf(res);
  assertOnlyRealSteps(events, calls);
  const done = events.find((e) => e.type === 'step_done' && e.id === 'github');
  assert.equal(done.result, `${calls.filter((c) => c.url.includes('api.github.com')).length} requests · 1 failed`);
  assert.ok(!res.chunks.join('').includes(FAKE.githubPat), 'token never in the stream');
});

test('step_done cannot close a step that never opened, and a step cannot open twice', () => {
  const res = makeRes();
  const stream = createChatStream(res, { requestId: 'r2' });
  stream.start();
  assert.equal(stream.stepDone('ghost', { label: 'x' }), false);
  assert.equal(stream.step('a', 'A'), true);
  assert.equal(stream.step('a', 'A again'), false);
  assert.equal(stream.stepDone('a', { label: 'A done' }), true);
  assert.equal(stream.stepDone('a', { label: 'A done twice' }), false);
  assert.equal(stream.step('a', 'reopen'), false);
});

// --- redaction and what never goes into a step ----------------------------------------

test('redactTraceText strips every fake credential shape and deployment env values', () => {
  const envValues = secretEnvValues({ PG1_TEST_SECRET_TOKEN: FAKE.envSecretValue, DB_PASSWORD: FAKE.dbPassword });
  // Token-shaped values are caught on their own; bare passwords and generic
  // tokens only in context (a header, a URL, or a deployment env value),
  // the same rules as Send to Code (lib/handoff.mjs).
  const shaped = ['supabaseJwt', 'supabaseSecretKey', 'googleKey', 'anthropicKey', 'openaiKey', 'githubPat', 'githubFineGrainedPat', 'awsAccessKeyId', 'longToken'].map((k) => FAKE[k]);
  const cases = [
    ...shaped.map((v) => [v, v]),
    [FAKE.privateKeyBlock, 'PG1TESTFIXTURE'],
    [bearerHeader(), FAKE.bearerToken],
    [postgresUrl(), FAKE.dbPassword],
    [FAKE.envSecretValue, FAKE.envSecretValue],
    [FAKE.dbPassword, FAKE.dbPassword]
  ];
  for (const [input, secret] of cases) {
    const out = redactTraceText(`detail ${input} end`, envValues, 400);
    assert.ok(!out.includes(secret), `leaked a fake secret: ${out}`);
    assert.match(out, /\[removed\]/);
  }
  assert.equal(redactTraceText('x'.repeat(500)).length, 160);
  assert.doesNotMatch(redactTraceText('a\u0000b\nc'), /[\u0000\n]/);
});

test('secrets in vault file names, error rows and search queries never reach the stream', async () => {
  useSupabase();
  process.env.PG1_TEST_SECRET_TOKEN = FAKE.envSecretValue;
  installFetch([
    ...supabaseRoutes({
      vault: [{ name: `backup-${FAKE.githubPat}.txt` }, { name: `${FAKE.envSecretValue}.json` }],
      errors: [{ route: 'CHAT', status: 500, reason: `${bearerHeader()}` }, { route: postgresUrl(), status: 502, reason: FAKE.awsAccessKeyId }]
    }),
    geminiRoute([geminiChunk('ok', { groundingMetadata: { webSearchQueries: [`lookup ${FAKE.googleKey}`] } })])
  ]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hello', stream: true })), res);
  const raw = res.chunks.join('');
  for (const secret of [FAKE.githubPat, FAKE.envSecretValue, FAKE.bearerToken, FAKE.dbPassword, FAKE.awsAccessKeyId, FAKE.googleKey, process.env.SUPABASE_SERVICE_ROLE_KEY]) {
    assert.ok(!raw.includes(secret), 'a secret reached the stream');
  }
  assert.match(raw, /\[removed\]/, 'redaction marker shown instead');
});

test('memory contents, the system prompt and model thinking never appear in the stream', async () => {
  useSupabase();
  installFetch([
    ...supabaseRoutes({ memory: [{ role: 'user', content: 'MEMORY-CANARY-7731' }] }),
    ['streamGenerateContent', () => new Response(sseBody([
      { candidates: [{ content: { parts: [{ text: 'THINKING-CANARY plan the answer', thought: true }] } }] },
      geminiChunk('Visible answer.')
    ]))]
  ]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hello', stream: true })), res);
  const raw = res.chunks.join('');
  assert.ok(!raw.includes('MEMORY-CANARY'), 'memory contents leaked');
  assert.ok(!raw.includes('THINKING-CANARY'), 'thinking leaked');
  assert.ok(!raw.includes('STRICT DIRECTIVE') && !raw.includes('[CONTEXT]'), 'system prompt leaked');
  const memoryDone = eventsOf(res).find((e) => e.type === 'step_done' && e.id === 'memory');
  assert.equal(memoryDone.result, '1 recent message');
  assert.equal(memoryDone.details, undefined);
});

test('Anthropic thinking deltas are skipped; only text deltas stream', async () => {
  process.env.ANTHROPIC_API_KEY = FAKE.anthropicKey;
  const anthropicSse = [
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'THINKING-CANARY' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reasoned answer.' } }
  ].map((o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`).join('');
  installFetch([['api.anthropic.com', () => new Response(anthropicSse)]]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: '/claude think', stream: true })), res);
  const raw = res.chunks.join('');
  assert.ok(!raw.includes('THINKING-CANARY'));
  assert.equal(eventsOf(res).filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Reasoned answer.');
});

test('the identity guard holds when a claim is split across chunks', () => {
  const out = [];
  const s = createReplyScrubber((t) => out.push(t));
  for (const c of ['Hi! I am Gem', 'ini, and I', '’m powered by Goo', 'gle. ', 'x'.repeat(100)]) s.push(c);
  s.flush();
  const joined = out.join('');
  assert.equal(joined, scrubIdentity('Hi! I am Gemini, and I’m powered by Google. ' + 'x'.repeat(100)));
  assert.doesNotMatch(joined, /Gemini|Google/);
});

// --- abort and fallback ---------------------------------------------------------------

test('a client disconnect mid-reply aborts the model call, sends nothing more and saves nothing', async () => {
  useSupabase();
  let upstreamSignal = null;
  const calls = installFetch([
    ...supabaseRoutes(),
    ['streamGenerateContent', (u, opts) => {
      upstreamSignal = opts.signal;
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(sseBody([geminiChunk('First part of a long answer that keeps going and going. ')])));
          opts.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        }
      });
      return new Response(body);
    }]
  ]);
  const res = makeRes();
  res.onWrite = (c) => { if (c.includes('"type":"step","id":"model"')) setTimeout(() => res.emit('close'), 20); };
  await chatHandler(makeReq(authed({ prompt: 'hello', stream: true })), res);
  assert.ok(upstreamSignal && upstreamSignal.aborted, 'upstream request aborted');
  const events = eventsOf(res);
  assert.ok(!events.some((e) => e.type === 'done' || e.type === 'error'), 'nothing written after the client left');
  assert.ok(!calls.some((c) => c.url.endsWith('/rest/v1/messages') && c.method === 'POST'), 'a stopped reply is not saved to memory');
});

test('a model stream that breaks after some text ends with a partial error, not done', async () => {
  installFetch([['streamGenerateContent', () => {
    const enc = new TextEncoder();
    let pulls = 0;
    return new Response(new ReadableStream({
      pull(c) {
        if (pulls++ === 0) c.enqueue(enc.encode(sseBody([geminiChunk('Half of the answer is here and then the line goes quiet for good. ')])));
        else c.error(new Error('socket hang up'));
      }
    }));
  }]]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hello', stream: true })), res);
  const events = eventsOf(res);
  const last = events[events.length - 1];
  assert.equal(last.type, 'error');
  assert.equal(last.partial, true);
  assert.ok(events.some((e) => e.type === 'text'));
  assert.equal(events.find((e) => e.type === 'step_done' && e.id === 'model').failed, true);
});

test('a model failure before any text is an error event, retried across models first', async () => {
  const calls = installFetch([['streamGenerateContent', () => new Response('quota', { status: 429 })]]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hello', stream: true })), res);
  const last = eventsOf(res).at(-1);
  assert.equal(last.type, 'error');
  assert.equal(last.partial, false);
  assert.match(last.message, /Execution failed/);
  assert.equal(calls.filter((c) => c.url.includes('streamGenerateContent')).length, 2);
});

test('fallback: without stream: true the reply is the same JSON as before', async () => {
  installFetch([['generateContent', () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'JSON reply.' }] } }] }))]]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hello' })), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.reply, 'JSON reply.');
  assert.equal(res.chunks.length, 0);
});

test('fallback: an unauthenticated stream request gets the plain JSON 401', async () => {
  installFetch([]);
  const res = makeRes();
  await chatHandler(makeReq({ prompt: 'hello', stream: true }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.chunks.length, 0);
});
