/**
 * PG1 voice, phase 1: low-latency streamed speech.
 *
 * Server (lib/voiceStream.mjs, the voice path in api/chat.mjs):
 *  - sentence splitting, the same for any chunking of the reply
 *  - speech text filtering: code blocks, full URLs, secrets, request/task
 *    IDs and key blocks are replaced with short placeholders
 *  - audio chunks go out numbered and in speaking order, then audio_end,
 *    then done
 *  - client disconnect / abort stops synthesis
 *  - nothing is stored: no pg1-vault upload on the streamed path
 *  - fallback: no speak flag, no TTS key or a TTS failure means no audio
 *    events (or audio_end ok:false), so the client speaks the old way
 *
 * Client (public/index.html): the Web Audio player plays chunks by seq,
 * Stop and a new message silence it at once, and the reply falls back to
 * speakMessage() when nothing was spoken from the stream.
 *
 * Every secret-shaped value comes from tests/fixtures/fake-secrets.mjs.
 *
 * Run with: node --test tests/voice-stream.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { createDocument } from './helpers/mini-dom.mjs';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { createSseParser, createChatStream } from '../lib/chatStream.mjs';
import {
  createSentenceSplitter, createSpeechSplitter, createSseSynth, createVoiceStream, speechSegments, toSpeechText,
  SPEECH_PLACEHOLDERS, VOICE_AUDIO_FORMAT, CARTESIA_SSE_URL
} from '../lib/voiceStream.mjs';
import { FAKE, bearerHeader, postgresUrl } from './fixtures/fake-secrets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '../public/index.html'), 'utf-8');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ALL_FAKES = Object.values(FAKE).concat([bearerHeader(), postgresUrl()]);
// The key-block body line is the part that would leak if the block were
// split; the markers themselves are not secret.
const FAKE_VALUES_TO_CHECK = ALL_FAKES.concat(['PG1TESTFIXTURE\n', FAKE.dbPassword]);

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY = 'stub-gemini-key';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'CARTESIA_API_KEY', 'CARTESIA_VOICE_ID',
    'CARTESIA_VOICE_ID_FIELD', 'CARTESIA_MODEL_ID', 'PG1_TEST_SECRET_TOKEN']) delete process.env[k];
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

const collect = (text, opts) => speechSegments(text, opts);

function assertNoSecrets(strings, label) {
  const joined = strings.join('\n');
  for (const v of FAKE_VALUES_TO_CHECK) {
    assert.ok(!joined.includes(v.trim()), `${label}: fake secret leaked: ${v.slice(0, 12)}…`);
  }
}

// --- sentence splitting -------------------------------------------------------------

test('sentences split on terminal punctuation and newlines, not on decimals, domains or abbreviations', () => {
  const units = [];
  const s = createSentenceSplitter((u) => units.push(u));
  s.push('Version 3.5 is live on example.com today. It works, e.g. on phones! Ready?\nNext line\n\nDr. Smith said hi');
  s.flush();
  assert.deepEqual(units.map((u) => u.text), [
    'Version 3.5 is live on example.com today.',
    'It works, e.g. on phones!',
    'Ready?',
    'Next line',
    'Dr. Smith said hi'
  ]);
});

test('a sentence is only emitted once it is complete, and the split is the same for any chunking', () => {
  const reply = 'The first sentence arrives fast. Then a second one, with a comma! And a "quoted" third? ' +
    'Here is code:\n```js\nconst a = 1. + 2;\nconsole.log(a);\n```\nAfter the code. Last words';
  const whole = collect(reply);
  for (const size of [1, 2, 3, 5, 7, 11, 64]) {
    const out = [];
    const sp = createSpeechSplitter((t) => out.push(t));
    for (let i = 0; i < reply.length; i += size) sp.push(reply.slice(i, i + size));
    sp.flush();
    assert.deepEqual(out, whole, `chunk size ${size}`);
  }
  // Nothing is emitted for an unfinished sentence until more text or flush.
  const early = [];
  const sp = createSpeechSplitter((t) => early.push(t));
  sp.push('The first sentence arrives fast. Then a sec');
  assert.deepEqual(early, ['The first sentence arrives fast.']);
  sp.push('ond.');
  assert.equal(early.length, 1, 'a sentence ending at the very end of the buffer waits for what follows');
  sp.flush();
  assert.deepEqual(early, ['The first sentence arrives fast.', 'Then a second.']);
});

test('an over-long sentence is cut at a clause or word boundary so speech can start', () => {
  const long = Array.from({ length: 80 }, (_, i) => `word${i % 10 ? '' : ','}`).join(' ');
  const out = collect(long, { maxSentenceChars: 120 });
  assert.ok(out.length > 1);
  for (const s of out) assert.ok(s.length <= 120, `segment too long: ${s.length}`);
  assert.equal(out.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '));
});

test('spoken text is capped, ending with a short pointer to the screen', () => {
  const reply = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const out = collect(reply);
  assert.equal(out[out.length - 1], SPEECH_PLACEHOLDERS.more);
  assert.ok(out.join(' ').length <= 3000 + SPEECH_PLACEHOLDERS.more.length + out.length);
});

// --- speech text filtering ---------------------------------------------------------

test('code blocks are never read out, only a placeholder, even split across chunks', () => {
  const reply = 'Run this:\n```bash\ncurl -H "x-api-key: abc" https://api.example.com/v1/run\nrm -rf build\n```\nThat is all.\n~~~\nmore code here\n~~~\nDone.';
  const out = collect(reply);
  assert.deepEqual(out, ['Run this:', SPEECH_PLACEHOLDERS.code, 'That is all.', SPEECH_PLACEHOLDERS.code, 'Done.']);
  const joined = out.join(' ');
  assert.doesNotMatch(joined, /curl|rm -rf|more code/);
  // Two code blocks in a row only say so once.
  assert.deepEqual(collect('```\na\n```\n```\nb\n```\nEnd.'), [SPEECH_PLACEHOLDERS.code, 'End.']);
  // An unclosed fence at the end of the reply is still not read.
  assert.deepEqual(collect('Look:\n```\nsecret_code()'), ['Look:', SPEECH_PLACEHOLDERS.code]);
});

test('URLs are never read in full: the host at most, never path, query or credentials', () => {
  const out = collect('Open https://github.com/Project-Gifted1/pg1-ai-agent/pull/230?tab=files#diff now. ' +
    'Docs at www.example.org/a/b. See [the guide](https://docs.example.net/very/long/path?x=1). ' +
    'Raw http://203.0.113.9:8080/admin too.');
  const joined = out.join(' ');
  assert.match(joined, /a link to github\.com/);
  assert.match(joined, /a link to example\.org/);
  assert.match(joined, /See the guide\./);
  assert.match(joined, /Raw a link too\./);
  assert.doesNotMatch(joined, /Project-Gifted1|pull|230|tab=|\/a\/b|very\/long|203\.0\.113|8080|https?:|www\./);
});

test('secrets are never spoken: every fake credential shape, and deployment env values', () => {
  const envSecret = FAKE.envSecretValue + '-deploy';
  const reply = [
    `Supabase JWT ${FAKE.supabaseJwt} here.`,
    `Keys: ${FAKE.supabaseSecretKey}, ${FAKE.googleKey}, ${FAKE.anthropicKey} and ${FAKE.openaiKey}.`,
    `GitHub: ${FAKE.githubPat} or ${FAKE.githubFineGrainedPat}.`,
    `AWS ${FAKE.awsAccessKeyId} is set.`,
    `Header ${bearerHeader()} is sent.`,
    `Database ${postgresUrl()} is up.`,
    `password: ${FAKE.dbPassword} and passkey = ${FAKE.passkey} ok.`,
    `MY_SERVICE_TOKEN=${FAKE.envSecretValue} was set.`,
    `Long ${FAKE.longToken} blob.`,
    'The key block:',
    FAKE.privateKeyBlock,
    `Deploy value ${envSecret} too.`
  ].join('\n');
  const envValues = [{ name: 'PG1_TEST_SECRET_TOKEN', value: envSecret }];
  const out = collect(reply, { envValues });
  assertNoSecrets(out, 'whole reply');
  assert.ok(!out.join(' ').includes(envSecret), 'deployment env value spoken');
  assert.ok(out.includes(SPEECH_PLACEHOLDERS.secretBlock), 'key block replaced with a placeholder');
  assert.match(out.join(' '), new RegExp(SPEECH_PLACEHOLDERS.secret));

  // The same holds when the reply arrives one character at a time.
  const pieces = [];
  const sp = createSpeechSplitter((t) => pieces.push(t), { envValues });
  for (const ch of reply) sp.push(ch);
  sp.flush();
  assertNoSecrets(pieces, 'char-by-char');
  assert.deepEqual(pieces, out);
});

test('request IDs, trace IDs, task IDs, UUIDs and hashes are replaced with a short placeholder', () => {
  const trace = 'k3j9x0ab';
  const out = collect(
    `Request ID: req_8f2k1m9x7q. The trace id is ${trace}. Task PG1-TASK-U5JQTK is open. ` +
    'Session 3c0f09d6-e0d7-499c-a594-70c5b7b93048 started. Commit 400a873f1e2d9c8b merged. ' +
    'x-request-id: 9a8b7c6d5e. Run run_01HZX9K2M4 done. A request id is not missing here.',
    { knownIds: [trace] }
  );
  const joined = out.join(' ');
  for (const leaked of [trace, 'req_8f2k1m9x7q', 'U5JQTK', '3c0f09d6', '400a873f1e2d9c8b', '9a8b7c6d5e', 'run_01HZX9K2M4']) {
    assert.ok(!joined.includes(leaked), `ID spoken: ${leaked}`);
  }
  assert.match(joined, /a request ID/);
  assert.match(joined, /a task ID/);
  assert.match(joined, /an ID/);
  assert.match(joined, /A request id is not missing here\./, 'plain words after "request id" are kept');
});

test('markdown furniture and emoji are not read as symbols; ordinary prose is untouched', () => {
  assert.equal(toSpeechText('### **Status**: all *green* ✅'), 'Status: all green');
  assert.equal(toSpeechText('- item one'), 'item one');
  assert.equal(toSpeechText('Use `npm test` to check.'), 'Use npm test to check.');
  assert.equal(toSpeechText('Call `fetchWithTimeout(url, opts, 10000)` first.'), `Call ${SPEECH_PLACEHOLDERS.inlineCode} first.`);
  assert.equal(toSpeechText('---'), '');
  assert.equal(toSpeechText('PG1 x402-compatible gateway, version 2.26.0.'), 'PG1 x402-compatible gateway, version 2.26.0.');
  assert.deepEqual(collect('| a | b |\n|---|---|\n| 1 | 2 |\nAfter.'), [SPEECH_PLACEHOLDERS.table, 'After.']);
});

// --- voice stream: ordering, abort, failure ----------------------------------------

function fakeSynth({ delays = {}, fail = {}, chunksPer = 2 } = {}) {
  const calls = [];
  const synth = async (text, { signal, onChunk }) => {
    const idx = calls.length;
    calls.push({ text, signal });
    for (let c = 0; c < chunksPer; c++) {
      await new Promise((r) => setTimeout(r, delays[idx] || 0));
      if (signal.aborted) return { ok: false, reason: 'aborted' };
      if (fail[idx] && c === fail[idx].afterChunks) return { ok: false, reason: fail[idx].reason || 'http_500' };
      onChunk(Buffer.from(`${idx}:${c}`).toString('base64'));
    }
    return { ok: true, chunks: chunksPer };
  };
  return { synth, calls };
}

test('audio chunks are numbered and emitted in speaking order, even when a later sentence would be faster', async () => {
  const events = [];
  // Sentence 0 is slow, 1 and 2 instant: synthesis is sequential, so the
  // order never depends on which request finishes first.
  const { synth, calls } = fakeSynth({ delays: { 0: 30 } });
  const voice = createVoiceStream({ emit: (type, p) => events.push({ type, ...p }), synth });
  voice.push('First sentence here. Second ');
  voice.push('one now. Third');
  const summary = await voice.finish();
  assert.deepEqual(calls.map((c) => c.text), ['First sentence here.', 'Second one now.', 'Third']);
  const audio = events.filter((e) => e.type === 'audio');
  assert.deepEqual(audio.map((e) => e.seq), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(audio.map((e) => Buffer.from(e.data, 'base64').toString()), ['0:0', '0:1', '1:0', '1:1', '2:0', '2:1']);
  assert.deepEqual(audio.map((e) => e.sentence), [0, 0, 1, 1, 2, 2]);
  for (const a of audio) {
    assert.equal(a.encoding, VOICE_AUDIO_FORMAT.encoding);
    assert.equal(a.sample_rate, VOICE_AUDIO_FORMAT.sample_rate);
  }
  assert.deepEqual(events[events.length - 1], { type: 'audio_end', ok: true, chunks: 6, sentences: 3, queued: 3 });
  assert.deepEqual(summary, { ok: true, chunks: 6, sentences: 3, queued: 3 });
});

test('abort stops synthesis at once: the in-flight request is cancelled and nothing more is emitted', async () => {
  const events = [];
  const outer = new AbortController();
  const { synth, calls } = fakeSynth({ delays: { 0: 20, 1: 20 } });
  const voice = createVoiceStream({ emit: (type, p) => events.push({ type, ...p }), synth, signal: outer.signal });
  voice.push('One sentence. Two sentence. Three sentence. ');
  setTimeout(() => outer.abort(), 30);
  const summary = await voice.finish();
  assert.equal(summary.ok, false);
  assert.equal(summary.reason, 'aborted');
  assert.ok(calls.length < 3, 'later sentences never requested');
  assert.ok(calls.every((c) => c.signal.aborted), 'in-flight request signalled');
  assert.equal(events.filter((e) => e.type === 'audio_end').length, 1);
  // Pushing after abort is a no-op.
  voice.push('Four sentence. ');
  assert.equal(calls.length < 3, true);
});

test('a TTS failure stops the rest of the reply and reports it in audio_end', async () => {
  const events = [];
  const { synth, calls } = fakeSynth({ fail: { 1: { afterChunks: 0, reason: 'http_401' } } });
  const voice = createVoiceStream({ emit: (type, p) => events.push({ type, ...p }), synth });
  voice.push('One. Two. Three. Four.');
  const summary = await voice.finish();
  assert.equal(calls.length, 2, 'no more requests after a failure');
  assert.deepEqual(summary, { ok: false, chunks: 2, sentences: 1, queued: 4, reason: 'http_401' });
});

test('the time budget ends speech rather than the function being killed mid-reply', async () => {
  const events = [];
  const { synth } = fakeSynth({ delays: { 0: 200 } });
  const voice = createVoiceStream({ emit: (type, p) => events.push({ type, ...p }), synth, deadlineTs: Date.now() + 40 });
  voice.push('Slow sentence. Another one.');
  const t0 = Date.now();
  const summary = await voice.finish();
  assert.ok(Date.now() - t0 < 190, 'finish() returned at the deadline');
  assert.equal(summary.ok, false);
  assert.equal(summary.reason, 'deadline');
});

// --- the SSE TTS client ------------------------------------------------------------

const sseBody = (objs) => objs.map((o) => `event: ${o.type || 'message'}\ndata: ${JSON.stringify(o)}\n\n`).join('');

test('createSseSynth posts one sentence with the key server-side and forwards each base64 chunk', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return new Response(sseBody([
      { type: 'chunk', data: 'AAEC', done: false },
      { type: 'chunk', data: 'AwQF', done: false },
      { type: 'done', done: true }
    ]));
  };
  const synth = createSseSynth({ apiKey: FAKE.longToken, modelId: 'model-x', voiceId: 'voice-1', fetchImpl });
  const chunks = [];
  const result = await synth('Hello there.', { onChunk: (c) => chunks.push(c) });
  assert.deepEqual(result, { ok: true, chunks: 2 });
  assert.deepEqual(chunks, ['AAEC', 'AwQF']);
  assert.equal(calls[0].url, CARTESIA_SSE_URL);
  assert.equal(calls[0].opts.headers['X-API-Key'], FAKE.longToken);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.transcript, 'Hello there.');
  assert.deepEqual(body.voice, { mode: 'id', id: 'voice-1' });
  assert.deepEqual(body.output_format, { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 });
});

test('createSseSynth reports failures by a short code, never the upstream error text', async () => {
  const leaky = `bad key ${FAKE.anthropicKey}`;
  const http = createSseSynth({ apiKey: 'k', modelId: 'm', voiceId: 'v', fetchImpl: async () => new Response(leaky, { status: 401 }) });
  assert.deepEqual(await http('Hi.', { onChunk: () => {} }), { ok: false, reason: 'http_401', chunks: 0 });
  const streamErr = createSseSynth({ apiKey: 'k', modelId: 'm', voiceId: 'v', fetchImpl: async () => new Response(sseBody([{ type: 'chunk', data: 'AAEC' }, { type: 'error', error: leaky }])) });
  assert.deepEqual(await streamErr('Hi.', { onChunk: () => {} }), { ok: false, reason: 'upstream_error', chunks: 1 });
  const net = createSseSynth({ apiKey: 'k', modelId: 'm', voiceId: 'v', fetchImpl: async () => { throw new Error(leaky); } });
  assert.deepEqual(await net('Hi.', { onChunk: () => {} }), { ok: false, reason: 'network', chunks: 0 });
  const empty = createSseSynth({ apiKey: 'k', modelId: 'm', voiceId: 'v', fetchImpl: async () => new Response(sseBody([{ type: 'done', done: true }])) });
  assert.deepEqual(await empty('Hi.', { onChunk: () => {} }), { ok: false, reason: 'no_audio', chunks: 0 });
});

test('the chat stream knows the audio event types and writes them in order', () => {
  const chunks = [];
  const res = { setHeader() {}, write: (c) => chunks.push(c), end() {} };
  const stream = createChatStream(res, { requestId: 'r1' });
  stream.start();
  stream.audio({ seq: 0, sentence: 0, data: 'AAEC', encoding: 'pcm_s16le', sample_rate: 24000 });
  stream.audioEnd({ ok: true, chunks: 1, sentences: 1 });
  stream.done();
  assert.deepEqual(stream.events.map((e) => e.type), ['audio', 'audio_end', 'done']);
  assert.match(chunks.join(''), /event: audio\ndata: \{"type":"audio","seq":0/);
});

// --- api/chat.mjs end to end ---------------------------------------------------------

let ipSeq = 0;
function makeReq(body) {
  return { method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.77.0.${++ipSeq}` }, body };
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
  const parser = createSseParser(({ data }) => out.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return out;
}

function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', body: options.body, headers: options.headers || {}, signal: options.signal });
    for (const [needle, handler] of routes) {
      if (u.includes(needle)) return handler(u, options);
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}

const geminiSse = (texts) => texts.map((t, i) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] }, ...(i === texts.length - 1 ? { finishReason: 'STOP' } : {}) }] })}\n\n`).join('');
const geminiRoute = (texts) => ['streamGenerateContent', () => new Response(geminiSse(texts))];
const supabaseRoutes = () => [
  ['/rest/v1/messages?select=id', () => new Response('[]')],
  ['/rest/v1/messages?select=role', () => new Response('[]')],
  ['/rest/v1/messages', () => new Response('[]', { status: 201 })],
  ['/storage/v1/object/list/pg1-vault', () => new Response('[]')],
  ['/rest/v1/pg1_errors', () => new Response('[]')],
  // Any upload is recorded by installFetch; the assertions below check none happened.
  ['/storage/v1/object/pg1-vault/', () => new Response('{}')]
];
let ttsSeq = 0;
const ttsRoute = (handler) => ['api.cartesia.ai/tts/sse', handler || (() => {
  const n = ttsSeq++;
  return new Response(sseBody([
    { type: 'chunk', data: Buffer.from(`pcm-${n}-a`).toString('base64') },
    { type: 'chunk', data: Buffer.from(`pcm-${n}-b`).toString('base64') },
    { type: 'done', done: true }
  ]));
})];

function useVoice() {
  process.env.CARTESIA_API_KEY = FAKE.longToken;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
}

const REPLY_WITH_EVERYTHING = [
  'Sure, here is the status. ',
  `The PR is at https://github.com/Project-Gifted1/pg1-ai-agent/pull/230 and your token ${FAKE.githubPat} is set.\n`,
  '```js\nconst key = "' + FAKE.anthropicKey + '";\n```\n',
  'Request ID: req_7h3k9q2m1x. All done!'
];

test('voice on: audio streams in order before done, the TTS key never leaves the server, nothing is stored', async () => {
  useVoice();
  const calls = installFetch([...supabaseRoutes(), geminiRoute(REPLY_WITH_EVERYTHING), ttsRoute()]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'status please', stream: true, speak: true })), res);
  const events = eventsOf(res);
  const types = events.map((e) => e.type);
  const audio = events.filter((e) => e.type === 'audio');
  assert.ok(audio.length >= 2, 'audio streamed');
  assert.deepEqual(audio.map((e) => e.seq), audio.map((_, i) => i), 'seq is 0..n in order');
  const endIdx = types.indexOf('audio_end');
  assert.ok(endIdx > types.lastIndexOf('audio'), 'audio_end after every audio chunk');
  assert.equal(types[types.length - 1], 'done');
  assert.ok(endIdx < types.length - 1);
  assert.equal(events[endIdx].ok, true);
  // The voice step is real: it only appears because TTS requests ran.
  assert.ok(events.some((e) => e.type === 'step' && e.id === 'voice'));
  assert.ok(!JSON.stringify(events.filter((e) => e.type.startsWith('step'))).match(/cartesia/i), 'no provider name in the trace');

  const ttsCalls = calls.filter((c) => c.url.includes('api.cartesia.ai'));
  const transcripts = ttsCalls.map((c) => JSON.parse(c.body).transcript);
  assert.deepEqual(transcripts, [
    'Sure, here is the status.',
    `The PR is at a link to github.com and your token ${SPEECH_PLACEHOLDERS.secret} is set.`,
    SPEECH_PLACEHOLDERS.code,
    SPEECH_PLACEHOLDERS.requestId,
    'All done!'
  ]);
  assertNoSecrets(transcripts, 'TTS transcripts');
  assert.ok(ttsCalls.every((c) => c.headers['X-API-Key'] === FAKE.longToken), 'key sent to the TTS provider only');
  assert.ok(!res.chunks.join('').includes(FAKE.longToken), 'TTS key never in the client stream');

  assert.ok(!calls.some((c) => /\/storage\/v1\/object\/pg1-vault\//.test(c.url) && c.method === 'POST'), 'no audio uploaded to pg1-vault');
  assert.ok(!calls.some((c) => c.url.includes('tts_')), 'no tts_ file written anywhere');
  // The reply text itself is unchanged by speech filtering.
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), REPLY_WITH_EVERYTHING.join(''));
});

test('voice off (no speak flag): no TTS calls and no audio events, exactly as before', async () => {
  useVoice();
  const calls = installFetch([...supabaseRoutes(), geminiRoute(['Hello there. Bye.']), ttsRoute()]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hi', stream: true })), res);
  const events = eventsOf(res);
  assert.ok(!events.some((e) => e.type === 'audio' || e.type === 'audio_end'));
  assert.ok(!calls.some((c) => c.url.includes('api.cartesia.ai')));
});

test('fallback: with no TTS key the stream carries no audio, so the client speaks the old way', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const calls = installFetch([...supabaseRoutes(), geminiRoute(['Hello there.'])]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hi', stream: true, speak: true })), res);
  const events = eventsOf(res);
  assert.ok(!events.some((e) => e.type === 'audio' || e.type === 'audio_end'));
  assert.equal(events[events.length - 1].type, 'done');
  assert.ok(!calls.some((c) => c.url.includes('api.cartesia.ai')));
});

test('fallback: a TTS error ends with audio_end ok:false and the reply still finishes', async () => {
  useVoice();
  installFetch([...supabaseRoutes(), geminiRoute(['Hello there. Bye now.']),
    ttsRoute(() => new Response(`denied ${FAKE.anthropicKey}`, { status: 402 }))]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'hi', stream: true, speak: true })), res);
  const events = eventsOf(res);
  const end = events.find((e) => e.type === 'audio_end');
  assert.deepEqual({ ok: end.ok, chunks: end.chunks, reason: end.reason }, { ok: false, chunks: 0, reason: 'http_402' });
  assert.equal(events[events.length - 1].type, 'done');
  assert.ok(!res.chunks.join('').includes(FAKE.anthropicKey), 'upstream error text never forwarded');
  const voiceDone = events.find((e) => e.type === 'step_done' && e.id === 'voice');
  assert.equal(voiceDone.failed, true);
});

test('Stop (client disconnect) mid-speech aborts the TTS request and writes nothing more', async () => {
  useVoice();
  let ttsSignal = null;
  installFetch([...supabaseRoutes(), geminiRoute(['First sentence is here. Second sentence is here.']),
    ttsRoute((u, opts) => {
      ttsSignal = opts.signal;
      const enc = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(sseBody([{ type: 'chunk', data: 'AAEC' }])));
          opts.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        }
      }));
    })]);
  const res = makeRes();
  res.onWrite = (c) => { if (c.includes('"type":"audio"')) setTimeout(() => res.emit('close'), 10); };
  await chatHandler(makeReq(authed({ prompt: 'hi', stream: true, speak: true })), res);
  assert.ok(ttsSignal && ttsSignal.aborted, 'TTS request aborted');
  const events = eventsOf(res);
  assert.equal(events.filter((e) => e.type === 'audio').length, 1);
  assert.ok(!events.some((e) => e.type === 'done' || e.type === 'error' || e.type === 'audio_end'), 'nothing written after the client left');
});

test('one-shot SPEAK also never sends code blocks, URLs or secrets to TTS', async () => {
  process.env.CARTESIA_API_KEY = FAKE.longToken;
  const calls = installFetch([['api.cartesia.ai/tts/bytes', () => new Response(new Uint8Array([1, 2, 3]))]]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ action: 'SPEAK', prompt: `See https://example.com/x?y=1 now.\n\`\`\`\nrm -rf /\n\`\`\`\nKey ${FAKE.openaiKey} ok.` })), res);
  assert.equal(res.statusCode, 200);
  const transcript = JSON.parse(calls.find((c) => c.url.includes('tts/bytes')).body).transcript;
  assert.doesNotMatch(transcript, /rm -rf|example\.com\/x|https?:/);
  assertNoSecrets([transcript], 'SPEAK transcript');
  assert.match(transcript, /Code block shown on screen/);
});

// --- client: Web Audio player --------------------------------------------------------

function extractFunction(name) {
  let start = html.indexOf(`async function ${name}(`);
  if (start === -1) start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found in public/index.html`);
  let depth = 0;
  let i = html.indexOf('{', html.indexOf(')', start));
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

const CLIENT_SOURCE = [
  html.match(/const VOICE_LEAD_SECONDS = [^\n]*;/)[0].replace(/^const /, 'var '),
  'var voiceAudioCtx = null; var activeVoicePlayer = null; var fallbackVoiceAudio = null; var voiceGeneration = 0; var voiceBubble = null;',
  html.match(/const VOICE_WAVE_HTML = [^\n]*;/)[0].replace(/^const /, 'var '),
  'var inFlightDirectives = new Set();',
  ...['getVoiceAudioContext', 'base64ToBytes', 'pcm16ToFloat32', 'createVoicePlayer', 'trackFallbackAudio', 'isVoicePlaying',
    'syncVoiceWave', 'syncVoiceUi', 'stopVoicePlayback', 'startVoicePlayer', 'stopDirectives', 'syncExecuteButton', 'speakMessage'].map(extractFunction)
].join('\n');

function makeAudioContext() {
  const ctx = {
    state: 'running',
    currentTime: 1,
    sources: [],
    destination: {},
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { duration: length / rate, length, sampleRate: rate, getChannelData: () => data };
    },
    createBufferSource() {
      const src = {
        buffer: null, startedAt: null, stopped: false, disconnected: false, onended: null,
        connect() {}, disconnect() { src.disconnected = true; },
        start(at) { src.startedAt = at; }, stop() { src.stopped = true; }
      };
      ctx.sources.push(src);
      return src;
    },
    resume: () => Promise.resolve()
  };
  return ctx;
}

function makeClient(overrides = {}) {
  const audioCtx = makeAudioContext();
  const log = { speak: [], played: [], syncs: 0 };
  const document = createDocument();
  const select = document.createElement('select');
  select.id = 'voice-profile-select';
  select.value = 'core';
  document.body.appendChild(select);
  const ctx = {
    log,
    audioCtx,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    window: { AudioContext: function () { return audioCtx; } },
    document,
    triggerHaptic: () => {},
    fetch: async () => new Response(JSON.stringify({ audio: 'aGVsbG8=', audioStatus: 'SUCCESS' })),
    playAudioResult: (data) => log.played.push(data),
    flashStatus: () => {},
    classifyFetchFailure: () => 'network',
    console,
    sessionUser: 'op',
    sessionPass: 'pw',
    Promise,
    ...overrides
  };
  vm.createContext(ctx);
  vm.runInContext(CLIENT_SOURCE, ctx);
  return ctx;
}

const pcm = (samples) => Buffer.from(new Int16Array(samples).buffer).toString('base64');
const audioEv = (seq, samples) => ({ type: 'audio', seq, sentence: 0, data: pcm(samples), encoding: 'pcm_s16le', sample_rate: 4 });

test('client: PCM16 chunks decode to the right samples, carrying an odd byte to the next chunk', () => {
  const c = makeClient();
  const bytes = new Uint8Array(Buffer.from(new Int16Array([0, 16384, -32768, 32767]).buffer));
  const first = c.pcm16ToFloat32(bytes.slice(0, 3), null);
  assert.deepEqual(Array.from(first.samples), [0]);
  assert.equal(first.carry.length, 1);
  const second = c.pcm16ToFloat32(bytes.slice(3), first.carry);
  assert.deepEqual(Array.from(second.samples), [0.5, -1, 32767 / 32768]);
  assert.equal(second.carry, null);
});

test('client: chunks play strictly by seq, back to back, whatever order they arrive in', () => {
  const c = makeClient();
  const player = c.startVoicePlayer();
  player.push(audioEv(2, [3, 3, 3, 3]));
  player.push(audioEv(1, [2, 2, 2, 2]));
  assert.equal(c.audioCtx.sources.length, 0, 'nothing plays before seq 0');
  player.push(audioEv(0, [1, 1, 1, 1, 1, 1, 1, 1]));
  player.push(audioEv(1, [9, 9]));
  const srcs = c.audioCtx.sources;
  assert.equal(srcs.length, 3, 'a duplicate seq is ignored');
  assert.deepEqual(srcs.map((s) => Math.round(s.buffer.getChannelData(0)[0] * 32768)), [1, 2, 3]);
  // 8 samples at 4 Hz = 2s, then 1s, 1s: each starts where the previous ends.
  const start0 = srcs[0].startedAt;
  assert.ok(start0 >= c.audioCtx.currentTime, 'first chunk starts promptly');
  assert.ok(start0 - c.audioCtx.currentTime < 0.2, 'first chunk is not held back');
  assert.deepEqual(srcs.map((s) => s.startedAt - start0), [0, 2, 3]);
  assert.equal(player.scheduledChunks, 3);
  assert.equal(c.isVoicePlaying(), true);
});

test('client: Stop silences every scheduled chunk at once and ignores chunks that arrive later', () => {
  const c = makeClient();
  const player = c.startVoicePlayer();
  player.push(audioEv(0, [1, 1]));
  player.push(audioEv(1, [1, 1]));
  c.stopDirectives();
  assert.ok(c.audioCtx.sources.every((s) => s.stopped && s.disconnected), 'all sources stopped');
  assert.equal(c.isVoicePlaying(), false);
  assert.equal(player.stopped, true);
  player.push(audioEv(2, [1, 1]));
  assert.equal(c.audioCtx.sources.length, 2, 'nothing scheduled after Stop');
  assert.equal(c.activeVoicePlayer, null);
});

test('client: Stop also pauses one-shot SPEAK audio, and a SPEAK reply arriving after Stop is dropped', async () => {
  let resolveFetch;
  const c = makeClient({ fetch: () => new Promise((r) => { resolveFetch = r; }) });
  const audio = { paused: false, ended: false, pause() { this.paused = true; }, addEventListener() {} };
  c.trackFallbackAudio(audio);
  assert.equal(c.isVoicePlaying(), true);
  const pending = c.speakMessage('Hello.');
  c.stopVoicePlayback();
  assert.equal(audio.paused, true);
  resolveFetch(new Response(JSON.stringify({ audio: 'aGVsbG8=', audioStatus: 'SUCCESS' })));
  await pending;
  assert.equal(c.log.played.length, 0, 'stale speech not played');
  // A request started after the stop does play.
  const c2 = makeClient();
  await c2.speakMessage('Hello.');
  assert.equal(c2.log.played.length, 1);
});

test('client: a new message stops speech first, and the reply falls back to speakMessage only when nothing streamed', () => {
  const src = extractFunction('submitDirective');
  const stopAt = src.indexOf('stopVoicePlayback();');
  assert.ok(stopAt !== -1 && stopAt < src.indexOf("await fetch('/api/chat'"), 'a new message stops audio before it is sent');
  assert.match(src, /const voicePlayer = \(wantStream && voiceActive\) \? startVoicePlayer\(agentBubble\) : null;\s*if \(voicePlayer\) payload\.speak = true;/);
  assert.match(src, /consumeDirectiveStream\(response, agentBubble, controller\.signal, voicePlayer\)/);
  assert.match(src, /const spokeFromStream = !!\(voicePlayer && voicePlayer\.scheduledChunks > 0\);/);
  assert.match(src, /if \(!spokeDirectly && voiceActive && data\.reply && !spokeFromStream && voiceGenerationAtSend === voiceGeneration\) \{\s*(?:\/\/[^\n]*\n\s*)?speakMessage\(data\.spokenSummary \|\| data\.reply, agentBubble\);/);
  assert.match(src, /if \(voicePlayer && !voicePlayer\.endInfo\) voicePlayer\.end\(\{ ok: false \}\);/, 'a stream that ends without audio_end closes the player');
  // The toggle still works: off stops audio, on warms the audio context in the tap.
  const toggle = extractFunction('toggleVoice');
  assert.match(toggle, /getVoiceAudioContext\(\);[\s\S]*speakMessage\(/);
  assert.match(toggle, /else \{\s*stopVoicePlayback\(\);/);
});

test('client: the Stop button stays available while streamed speech is still playing', () => {
  const classes = new Set();
  const btn = {
    classList: { contains: (k) => classes.has(k), toggle: (k, on) => (on ? classes.add(k) : classes.delete(k)) },
    setAttribute() {}, querySelector: () => ({ setAttribute() {} })
  };
  const c = makeClient({ document: { querySelector: () => btn, querySelectorAll: () => [], getElementById: () => ({ value: '' }) } });
  const player = c.startVoicePlayer();
  player.push(audioEv(0, [1, 1]));
  c.syncExecuteButton();
  assert.ok(classes.has('is-stop'), 'Stop shown with no request in flight but audio playing');
  c.audioCtx.sources[0].onended();
  player.end({ ok: true });
  c.syncExecuteButton();
  assert.ok(!classes.has('is-stop'), 'back to Execute once speech finished');
});

test('client: consumeDirectiveStream hands audio events to the player in arrival order', async () => {
  const src = extractFunction('consumeDirectiveStream');
  assert.match(src, /ev\.type === 'audio'\) \{ if \(voice\) voice\.push\(ev\); \}/);
  assert.match(src, /ev\.type === 'audio_end'\) \{ if \(voice\) voice\.end\(ev\); \}/);
  const types = html.match(/const TRACE_EVENT_TYPES = (\[[^\]]*\])/)[1];
  assert.match(types, /'audio', 'audio_end'/);
});

// --- existing tts_*.mp3 files: read-only count ---------------------------------------

test('scripts/count-tts-files.mjs pages through pg1-vault, counts only tts_*.mp3 and never deletes', async () => {
  const { countTtsFiles } = await import('../scripts/count-tts-files.mjs');
  const calls = [];
  const page1 = Array.from({ length: 1000 }, (_, i) => ({ name: `tts_${i}.mp3`, metadata: { size: 10 }, created_at: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}` }));
  const page2 = [{ name: 'tts_x.mp3', metadata: { size: 5 } }, { name: 'tts_notes.txt', metadata: { size: 99 } }, { name: 'vision_1.jpg', metadata: { size: 99 } }];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify(calls.length === 1 ? page1 : page2));
  };
  const out = await countTtsFiles({ supabaseUrl: 'https://example.supabase.co', supabaseKey: 'k', fetchImpl });
  assert.deepEqual(out, { count: 1001, bytes: 10005, oldest: '2026-01-01', newest: '2026-01-28' });
  assert.deepEqual(calls.map((c) => c.body.offset), [0, 1000]);
  assert.ok(calls.every((c) => c.url.endsWith('/storage/v1/object/list/pg1-vault') && c.method === 'POST'), 'list calls only');
});

// --- waveform beside the PG1 name ------------------------------------------------------

function makeBubble(c) {
  const bubble = c.document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = '<span class="msg-timestamp">06:22 PM</span><div class="message-text">Hi</div>';
  c.document.body.appendChild(bubble);
  return bubble;
}

test('waveform: shows in the reply header while it is spoken, labelled "Stop speaking", and goes when speech ends', () => {
  const c = makeClient();
  const bubble = makeBubble(c);
  const other = makeBubble(c);
  const player = c.startVoicePlayer(bubble);
  assert.equal(c.document.querySelectorAll('.voice-wave').length, 0, 'nothing before audio is scheduled');
  player.push(audioEv(0, [1, 1]));
  const header = bubble.querySelector('.msg-timestamp');
  const wave = header.querySelector('.voice-wave');
  assert.ok(wave, 'waveform in the header of the reply being spoken');
  assert.equal(header.firstElementChild, wave, 'right after the PG1 name');
  assert.equal(other.querySelector('.voice-wave'), null);
  assert.equal(wave.tagName, 'button');
  assert.equal(wave.getAttribute('type'), 'button');
  assert.equal(wave.getAttribute('aria-label'), 'Stop speaking');
  assert.equal(wave.querySelectorAll('.wave-bars i').length, 4);
  assert.equal(wave.querySelector('.wave-bars').getAttribute('aria-hidden'), 'true');
  assert.equal(wave.querySelector('use').getAttribute('href'), '#i-wave', 'static line icon for reduced motion');
  assert.match(wave.getAttribute('onclick'), /stopVoicePlayback\(\)/);

  // A gap between sentences (all scheduled audio played, more to come) keeps it.
  c.audioCtx.sources[0].onended();
  assert.ok(bubble.querySelector('.voice-wave'), 'no flicker between sentences');
  // The reply re-renders its header: the waveform comes back.
  player.push(audioEv(1, [1, 1]));
  bubble.innerHTML = '<span class="msg-timestamp has-trace">06:22 PM</span><div class="message-text">Hi</div>';
  c.syncVoiceWave();
  assert.ok(bubble.querySelector('.msg-timestamp .voice-wave'));
  // Speech finishes.
  player.end({ ok: true });
  c.audioCtx.sources[1].onended();
  assert.equal(c.document.querySelectorAll('.voice-wave').length, 0);
  assert.equal(c.isVoicePlaying(), false);
});

test('waveform: tapping it stops speech at once', () => {
  const c = makeClient();
  const bubble = makeBubble(c);
  const player = c.startVoicePlayer(bubble);
  player.push(audioEv(0, [1, 1]));
  player.push(audioEv(1, [1, 1]));
  // What its onclick does.
  vm.runInContext('stopVoicePlayback()', c);
  assert.ok(c.audioCtx.sources.every((s) => s.stopped), 'audio stopped');
  assert.equal(bubble.querySelector('.voice-wave'), null, 'waveform removed');
  assert.equal(c.voiceBubble, null);
});

test('waveform: one-shot speech (Read aloud, or the fallback) shows it on that reply too', () => {
  const c = makeClient();
  const bubble = makeBubble(c);
  const listeners = {};
  const audio = { paused: false, ended: false, pause() { this.paused = true; }, addEventListener(k, fn) { listeners[k] = fn; } };
  // What speakMessage(text, bubble) sets before playing.
  c.voiceBubble = bubble;
  c.trackFallbackAudio(audio);
  listeners.playing();
  assert.ok(bubble.querySelector('.voice-wave'));
  audio.ended = true;
  listeners.ended();
  assert.equal(bubble.querySelector('.voice-wave'), null);
  assert.match(extractFunction('speakBubble'), /speakMessage\(text, el\.closest\('\.message-bubble'\)\)/);
  assert.match(extractFunction('speakMessage'), /voiceBubble = bubble \|\| null;\s*playAudioResult\(data\);/);
});

test('waveform: never restored from saved history, and re-synced after the final render', () => {
  assert.match(html, /document\.querySelectorAll\('#chat-container \.voice-wave'\)\.forEach\(\(n\) => n\.remove\(\)\);/);
  const src = extractFunction('submitDirective');
  assert.match(src, /agentBubble\.innerHTML = contentHtml;\s*saveState\(\);[\s\S]{0,200}syncVoiceWave\(\);/);
  assert.match(extractFunction('renderStreamFailure'), /saveState\(\);\s*syncVoiceWave\(\);/);
  const css = html.slice(html.indexOf('/* live trace:'), html.indexOf('.stream-note {'));
  assert.match(css, /\.wave-bars i \{[^}]*animation: voice-wave/);
  assert.match(css, /\.voice-wave \{[^}]*color: var\(--gold\);/);
});
