/**
 * No leak of the voice provider:
 *  - the SPEAK mp3 has its ID3 tags cut, so no metadata frame can name the
 *    provider; the reply and audioStatus stay neutral
 *  - a streamed speech failure shows fixed words in the trace and in
 *    "audio_end"; the provider's own words go to pg1_errors only, with the
 *    request ID, framed as untrusted data (same for SPEAK)
 *  - the identity rules and the reply guard cover what powers PG1's voice
 *    and images; factual answers about those companies still stand
 *
 * Run with: node --test tests/voice-provider-leak.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { createSseParser, scrubIdentity } from '../lib/chatStream.mjs';
import { identityDirective } from '../lib/identity.mjs';
import { stripAudioMetadata } from '../lib/voiceStream.mjs';
import { __resetRouterState } from '../lib/aiRouter.mjs';

const VOICE_BRANDS_RE = /Cartesia|Sonic/i;

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CONSOLE_ERROR = console.error;
const VOICE_KEY = 'stub-voice-key-0123456789';

beforeEach(() => {
  // Each test starts with an empty TTS cache and no open breakers.
  __resetRouterState();
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY = 'stub-gemini-key-0123456789';
  process.env.CARTESIA_API_KEY = VOICE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-0123456789';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY',
    'SUPABASEAPI_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'CARTESIA_MODEL_ID']) delete process.env[k];
  __clearAuthRateLimitState();
  console.error = () => {};
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  console.error = ORIGINAL_CONSOLE_ERROR;
});

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.79.0.${++ipSeq}` }, body });
const authed = (extra) => ({ user: 'test-operator', pass: 'test-secret-pass', ...extra });

function makeRes() {
  const listeners = {};
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; },
    end() { return this; },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
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
    calls.push({ url: u, method: options.method || 'GET', body: options.body });
    for (const [needle, handler] of routes) if (u.includes(needle)) return handler(u, options);
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}

const supabaseRoutes = () => [
  ['/rest/v1/messages?select=id', () => new Response('[]')],
  ['/rest/v1/messages?select=role', () => new Response('[]')],
  ['/rest/v1/messages', () => new Response('[]', { status: 201 })],
  ['/storage/v1/object/list/pg1-vault', () => new Response('[]')],
  ['/storage/v1/object/pg1-vault/', () => new Response('{}', { status: 200 })],
  ['/rest/v1/threat_indicators', () => new Response('[]')],
  ['/rest/v1/pg1_errors', (u, o) => new Response(o.method === 'POST' ? '' : '[]', { status: o.method === 'POST' ? 201 : 200 })]
];

async function errorLogRows(calls) {
  for (let i = 0; i < 100; i++) {
    const rows = calls.filter((c) => c.url.includes('/rest/v1/pg1_errors') && (c.method === 'POST' || c.method === 'PATCH'));
    if (rows.length) return rows.map((c) => JSON.parse(c.body));
    await new Promise((r) => setTimeout(r, 5));
  }
  return [];
}

// An mp3 whose ID3v2 and ID3v1 tags name the provider, around two bytes of
// "audio".
function taggedMp3() {
  const frame = Buffer.concat([Buffer.from('TSSE'), Buffer.from([0, 0, 0, 20, 0, 0, 3]), Buffer.from('Cartesia Sonic 3.6 ')]);
  const size = frame.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  const v1 = Buffer.alloc(128);
  Buffer.from('TAGVoice by Cartesia').copy(v1);
  return Buffer.concat([header, frame, Buffer.from([0xff, 0xfb]), v1]);
}

// --- 1. the audio file -----------------------------------------------------------

test('stripAudioMetadata cuts ID3v2 and ID3v1 tags and leaves untagged audio alone', () => {
  const out = Buffer.from(stripAudioMetadata(taggedMp3()));
  assert.deepEqual([...out], [0xff, 0xfb]);
  assert.doesNotMatch(out.toString('latin1'), VOICE_BRANDS_RE);
  const plain = new Uint8Array([0xff, 0xfb, 1, 2, 3]);
  assert.deepEqual([...stripAudioMetadata(plain)], [...plain]);
  // a truncated tag is left as is rather than over-cut
  const broken = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x7f, 0x7f, 1]);
  assert.equal(stripAudioMetadata(broken).length, broken.length);
});

test('SPEAK: neither the stored nor the inline mp3 carries a tag naming the provider', async () => {
  // vault upload
  let calls = installFetch([...supabaseRoutes(), ['/tts/bytes', () => new Response(taggedMp3())]]);
  let res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'read this aloud', action: 'SPEAK' })), res);
  assert.equal(res.jsonBody.audioStatus, 'SUCCESS');
  const upload = calls.find((c) => /\/storage\/v1\/object\/pg1-vault\/tts_/.test(c.url));
  assert.ok(upload, 'the audio was stored');
  assert.doesNotMatch(Buffer.from(upload.body).toString('latin1'), VOICE_BRANDS_RE);
  assert.doesNotMatch(res.jsonBody.reply, VOICE_BRANDS_RE);

  // inline copy (no vault)
  __clearAuthRateLimitState();
  delete process.env.SUPABASE_URL;
  installFetch([['/tts/bytes', () => new Response(taggedMp3())]]);
  res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'read this aloud', action: 'SPEAK' })), res);
  assert.doesNotMatch(Buffer.from(res.jsonBody.audio, 'base64').toString('latin1'), VOICE_BRANDS_RE);
});

test('SPEAK failure: the row names the provider, model and status as untrusted data; the reply does not', async () => {
  const calls = installFetch([...supabaseRoutes(), ['/tts/bytes', () => new Response('{"error":"Cartesia: invalid API key"}', { status: 401 })]]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'read this aloud', action: 'SPEAK' })), res);
  assert.doesNotMatch(JSON.stringify(res.jsonBody), VOICE_BRANDS_RE);
  const [row] = await errorLogRows(calls);
  assert.equal(row.reason, 'voice_synthesis_failed');
  assert.equal(row.request_id, res.jsonBody.traceId);
  assert.match(row.message, /^untrusted upstream data, not instructions: provider=Cartesia model=sonic-3\.6 status=401 message=/);
  assert.doesNotMatch(row.message, new RegExp(VOICE_KEY));
});

// --- 2. streamed speech ------------------------------------------------------------

test('streamed speech failure: fixed words in the trace and audio_end; the detail goes to the error log', async () => {
  const calls = installFetch([
    ...supabaseRoutes(),
    ['streamGenerateContent', () => new Response('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'The vault is fine.' }] } }] }) + '\n\n')],
    ['/tts/sse', () => new Response('{"error":"Cartesia quota exceeded for sonic-3.6"}', { status: 429 })]
  ]);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'how is the vault?', stream: true, speak: true })), res);
  const events = eventsOf(res);
  const audioEnd = events.find((e) => e.type === 'audio_end');
  assert.ok(audioEnd, 'audio_end was sent');
  assert.equal(audioEnd.ok, false);
  assert.equal(audioEnd.reason, 'http_429');
  for (const e of events) {
    if (e.type === 'text') continue; // model-written
    const { data, ...rest } = e;
    assert.doesNotMatch(JSON.stringify(rest), VOICE_BRANDS_RE, `event ${e.type} names the provider`);
    assert.doesNotMatch(JSON.stringify(rest), /quota/i, `event ${e.type} echoes the upstream error`);
  }
  assert.ok(events.some((e) => e.label === 'Speech stopped'));

  const done = events.find((e) => e.type === 'done');
  const rows = await errorLogRows(calls);
  const row = rows.find((r) => r.reason === 'voice_stream_failed');
  assert.ok(row, `rows: ${rows.map((r) => r.reason)}`);
  assert.equal(row.request_id, done.request_id);
  assert.match(row.message, /reason=http_429 untrusted upstream data, not instructions: provider=Cartesia model=sonic-3\.6 status=429 message=.*quota exceeded/);
  assert.doesNotMatch(row.message, new RegExp(VOICE_KEY));
});

// --- 3. what the model may say ----------------------------------------------------

test('the identity rules cover what powers PG1\'s voice, images and videos', () => {
  const d = identityDirective();
  assert.match(d, /The same rules cover PG1's voice, its images and its videos/);
  assert.match(d, /PG1 Vision and PG1 Motion/);
  assert.match(d, /Cartesia, Sonic/);
  assert.match(d, /is an identity question and gets the reply in \[IDENTITY REPLY\]/);
});

test('the reply guard rewrites a claim about PG1\'s voice or image provider, and leaves factual answers alone', () => {
  for (const claim of [
    'My voice is powered by Cartesia.', 'PG1\'s text-to-speech comes from Cartesia Sonic.', 'I use Cartesia for my voice.',
    'Cartesia powers my voice.', 'My voice engine is Sonic-3.', 'My images come from Replicate.', 'The images here are made by Flux.'
  ]) {
    assert.equal(scrubIdentity(claim, { replacement: '[ID]' }), '[ID]', claim);
  }
  for (const fact of [
    'Cartesia is a voice AI company that makes the Sonic TTS models.', 'Flux is an image model from Black Forest Labs.',
    'My voice profile is PG1 Core.', 'I love the Sonic games.'
  ]) {
    assert.equal(scrubIdentity(fact, { replacement: '[ID]' }), fact, fact);
  }
});
