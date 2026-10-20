/**
 * PG1 camera live analysis (public/camera/frame-gate.js, lib/cameraFeed.mjs,
 * the cameraEvent / cameraAnalyze branch of api/chat.mjs):
 *   - the gate sends at most one frame every 10 s, skips unchanged frames,
 *     and pauses after a 429 or "no engine" (backing off), showing
 *     "Camera analysis paused: AI credit unavailable";
 *   - a frame goes to the free Gemini key when the paid key is out of
 *     credit, for the operator only, at background priority (chat first);
 *   - every session start, stop, error, frame and failure is logged by
 *     event and size, never the image or the description.
 *
 * Run with: node --test tests/camera-feed.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCameraFrame, cameraEventLine, CAMERA_PROMPT } from '../lib/cameraFeed.mjs';
import { createFreeLimiter, PRIORITY } from '../lib/router/freeLimiter.mjs';
import { __resetRouterState } from '../lib/aiRouter.mjs';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const gateSrc = readFileSync(join(ROOT, 'public/camera/frame-gate.js'), 'utf8');
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
function loadGate() {
  const ctx = { Array, Math, Number, Infinity, Object };
  vm.createContext(ctx);
  vm.runInContext(gateSrc, ctx);
  return ctx.PG1Camera;
}
const C = loadGate();

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const FREE = 'AIzaStub-free-key-camera-0123456789';
const PAID = 'AQ.Stub-paid-key-camera-0123456789';
const ANTHROPIC = 'sk-ant-stub-camera-0123456789abcdef';
// A 1x1 JPEG's worth of base64 (the content is never looked at by the stubs).
const FRAME = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP' + 'A'.repeat(200);
const GEMINI_402 = JSON.stringify({ error: { code: 402, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted.' } });
const ANTHROPIC_CREDIT = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } });

beforeEach(() => {
  __resetRouterState();
  __clearAuthRateLimitState();
  for (const k of ['GEMINI_API_KEY_FREE', 'GEMINI_API_KEY_PAID', 'GEMINI_API_KEY', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASEAPI_KEY', 'VERCEL_AI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

// --- the frame gate -----------------------------------------------------------------

const flat = (v) => Array.from({ length: 16 * 12 }, () => v);

test('the gate: one frame every 10 s at most, unchanged frames skipped', () => {
  let t = 0;
  const gate = C.createFrameGate({ now: () => t });
  assert.equal(gate.decide(flat(100)), 'send');
  gate.sent(flat(100));
  assert.equal(gate.decide(flat(100)), 'busy', 'one frame in flight at a time');
  gate.result({ ok: true });
  t = 4000;
  assert.equal(gate.decide(flat(180)), 'too_soon');
  t = 10000;
  assert.equal(gate.decide(flat(102)), 'unchanged', 'nearly the same picture');
  assert.equal(gate.decide(flat(140)), 'send', 'a changed picture');
});

test('the gate: a 429 pauses (the server\'s wait, else 30 s doubling); "no engine" shows the paused message', () => {
  let t = 0;
  const gate = C.createFrameGate({ now: () => t });
  gate.sent(flat(10));
  const throttled = gate.result({ status: 429, retryAfterMs: 20000 });
  assert.equal(throttled.paused, true);
  assert.equal(throttled.waitMs, 20000);
  assert.match(throttled.text, /rate limit/);
  t = 15000;
  assert.equal(gate.decide(flat(200)), 'paused');
  t = 25000;
  assert.equal(gate.decide(flat(200)), 'send');
  gate.sent(flat(200));
  const out = gate.result({ status: 503, reason: 'ai_unavailable' });
  assert.equal(out.text, 'Camera analysis paused: AI credit unavailable');
  assert.equal(out.waitMs, 60000, 'the back-off doubled');
  gate.sent(flat(50));
  gate.result({ ok: true });
  assert.equal(gate.state().pauseReason, null, 'an answer resets the back-off');
});

test('the gate\'s thumbnail tells a changed picture from the same one', () => {
  const px = (v) => { const a = new Uint8ClampedArray(64 * 48 * 4); for (let i = 0; i < a.length; i += 4) { a[i] = v; a[i + 1] = v; a[i + 2] = v; a[i + 3] = 255; } return a; };
  const a = C.signature(px(100), 64, 48);
  assert.equal(a.length, 192);
  assert.ok(C.difference(a, C.signature(px(101), 64, 48)) < 6);
  assert.ok(C.difference(a, C.signature(px(160), 64, 48)) > 6);
});

test('the page wires the gate, the session events and the paused message', () => {
  assert.match(html, /<script src="\/camera\/frame-gate\.js"><\/script>/);
  assert.match(html, /cameraEvent\('start'\)/);
  assert.match(html, /cameraEvent\('stop'\)/);
  assert.match(html, /cameraEvent\('error', \{ code: cameraErrorCode\(err\) \}\)/);
  assert.match(html, /ev\.reason === 'ai_unavailable'.*PAUSED_TEXT/);
  assert.match(html, /id="vision-caption" role="status" aria-live="polite"/);
});

// --- analysing one frame --------------------------------------------------------------

function engines({ free = 'A desk with a laptop.', paid = () => new Response(GEMINI_402, { status: 402 }), anthropic = () => new Response(ANTHROPIC_CREDIT, { status: 400 }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      const key = options.headers['x-goog-api-key'];
      const body = JSON.parse(options.body);
      calls.push({ engine: key === FREE ? 'gemini_free' : 'gemini_paid', body });
      if (key === FREE) return typeof free === 'function' ? free() : Response.json({ candidates: [{ content: { parts: [{ text: free }] } }] });
      return paid();
    }
    if (u.includes('api.anthropic.com')) { calls.push({ engine: 'anthropic' }); return anthropic(); }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return { calls, fetchImpl };
}

test('a frame goes to the free key when the paid key is out of credit, for the operator, with no tools and no search', async () => {
  const env = { GEMINI_API_KEY_FREE: FREE, PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC };
  const { calls, fetchImpl } = engines({ paid: () => new Response(GEMINI_402, { status: 402 }) });
  const lines = [];
  // The paid key first for this test (the free key normally leads the light chain).
  const out = await analyzeCameraFrame({ image: { mimeType: 'image/jpeg', data: FRAME }, env, isOperator: true, fetchImpl, log: (l) => lines.push(l), requestId: 'cam00001' });
  assert.equal(out.ok, true);
  assert.equal(out.caption, 'A desk with a laptop.');
  const free = calls.find((c) => c.engine === 'gemini_free');
  assert.ok(free, 'the free key answered');
  assert.equal(free.body.tools, undefined, 'no tools or web search on a camera frame');
  assert.ok(free.body.contents[0].parts.some((p) => p.inlineData && p.inlineData.data === FRAME));
  assert.ok(free.body.contents[0].parts.some((p) => p.text === CAMERA_PROMPT));
  assert.ok(lines.every((l) => !l.includes(FRAME) && !l.includes('desk')), 'no image or description in the logs');
});

test('the free key is skipped for a guest; with the free key rate limited the camera backs off (429)', async () => {
  const env = { GEMINI_API_KEY_FREE: FREE, PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID };
  const guest = await analyzeCameraFrame({ image: { mimeType: 'image/jpeg', data: FRAME }, env, isOperator: false, fetchImpl: async () => { throw new Error('no call'); } });
  assert.equal(guest.status, 401);
  const { fetchImpl } = engines({ free: () => new Response('{"error":{"code":429,"message":"Please retry in 30s."}}', { status: 429 }), paid: () => new Response('{"error":{"code":429,"message":"Too many requests"}}', { status: 429 }) });
  const out = await analyzeCameraFrame({ image: { mimeType: 'image/jpeg', data: FRAME }, env: { GEMINI_API_KEY_FREE: FREE, PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID }, isOperator: true, fetchImpl, log: () => {}, sleep: async () => {} });
  assert.equal(out.ok, false);
  assert.equal(out.status, 429);
  assert.equal(out.reason, undefined, 'a rate limit is a pause, not "no credit"');
  assert.equal(out.retryAfterMs, 30000);
});

test('every engine out: ai_unavailable, the all-out alert, and a failure log line', async () => {
  const env = { GEMINI_API_KEY_FREE: FREE, PG1_DAILY_SPEND_CAP_USD: '1000', GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC };
  const { fetchImpl } = engines({ free: () => new Response(GEMINI_402, { status: 402 }) });
  const lines = [];
  const alerted = [];
  const out = await analyzeCameraFrame({ image: { mimeType: 'image/jpeg', data: FRAME }, env, isOperator: true, fetchImpl, log: (l) => lines.push(l), onAllOut: (f) => alerted.push(f.map((x) => x.provider)), requestId: 'cam00002' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'ai_unavailable');
  assert.equal(out.status, 503);
  assert.deepEqual(alerted, [['gemini_free', 'gemini_paid', 'anthropic']]);
  assert.ok(lines.some((l) => /^\[camera\] analysis_failed request_id=cam00002 reason=ai_unavailable engines=3$/.test(l)), lines.join('\n'));
});

test('the camera takes the free key\'s slot at background priority, so chat goes first', async () => {
  let t = 5 * 60000 + 1000;
  const limiter = createFreeLimiter({ env: { PG1_GEMINI_FREE_RPM: '2', PG1_GEMINI_FREE_CHAT_RESERVE: '1' }, now: () => t, sleep: async (ms) => { t += ms; } });
  await limiter.acquire({ priority: PRIORITY.BACKGROUND, maxWaitMs: 0 });
  const { calls, fetchImpl } = engines();
  const out = await analyzeCameraFrame({ image: { mimeType: 'image/jpeg', data: FRAME }, env: { GEMINI_API_KEY_FREE: FREE }, isOperator: true, limiter, fetchImpl, log: () => {} });
  assert.equal(out.ok, false, 'the last slot is chat\'s, and the camera waits at most 8 s');
  assert.equal(calls.length, 0);
  assert.equal((await limiter.acquire({ priority: PRIORITY.CHAT, maxWaitMs: 0 })).granted, true, 'chat still gets in');
});

// --- the chat branch ---------------------------------------------------------------------

let ipSeq = 0;
function makeRes() {
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {}
  };
}
async function post(body, signedIn = true) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.95.0.${++ipSeq}` }, body: { ...(signedIn ? { user: 'test-operator', pass: 'test-secret-pass' } : {}), ...body } }, res);
  return res;
}
function captureLogs() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  return { lines, restore: () => { console.log = orig; } };
}

test('/api/chat camera branch: session events and frames are logged by event and size; guests are refused', async () => {
  const cap = captureLogs();
  try {
    const start = await post({ cameraEvent: 'start', source: 'camera' });
    assert.equal(start.jsonBody.ok, true);
    await post({ cameraEvent: 'error', source: 'camera', code: 'permission_denied' });
    await post({ cameraEvent: 'error', code: '<script>alert(1)</script>' });
    const guest = await post({ cameraEvent: 'start' }, false);
    assert.equal(guest.statusCode, 401);
  } finally {
    cap.restore();
  }
  assert.ok(cap.lines.some((l) => /^\[camera\] session_start request_id=\w+ source=camera$/.test(l)), cap.lines.join('\n'));
  assert.ok(cap.lines.some((l) => /^\[camera\] session_error request_id=\w+ source=camera code=permission_denied$/.test(l)));
  assert.ok(cap.lines.some((l) => /session_error .*code=other$/.test(l)), 'an unknown code is logged as other');
  assert.equal(cameraEventLine({ event: 'start', source: 'screen', requestId: 'r1' }), '[camera] session_start request_id=r1 source=screen');
});

test('/api/chat camera branch: no engine left answers ai_unavailable; an answer comes back white-labelled', async () => {
  process.env.GEMINI_API_KEY_PAID = PAID;
  process.env.ANTHROPIC_API_KEY = ANTHROPIC;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('generativelanguage')) return new Response(GEMINI_402, { status: 402 });
    if (u.includes('anthropic')) return new Response(ANTHROPIC_CREDIT, { status: 400 });
    throw new Error('Unexpected network call in test: ' + u);
  };
  const cap = captureLogs();
  let res;
  try {
    res = await post({ cameraAnalyze: true, source: 'camera', frame: { inlineData: { mimeType: 'image/jpeg', data: FRAME } } });
  } finally { cap.restore(); }
  assert.equal(res.statusCode, 200, 'a handled outcome');
  assert.deepEqual(res.jsonBody, { ok: false, throttled: false, reason: 'ai_unavailable', retryAfterMs: null });
  assert.ok(cap.lines.some((l) => /^\[camera\] frame request_id=\w+ source=camera bytes=\d+$/.test(l)));
  assert.ok(cap.lines.every((l) => !l.includes(FRAME)), 'the image is never logged');

  // Both keys answered "out of credit": they are left out for an hour.
  const skipped = await post({ cameraAnalyze: true, frame: { inlineData: { mimeType: 'image/jpeg', data: FRAME } } });
  assert.equal(skipped.jsonBody.reason, 'ai_unavailable', 'not called again within the hour');
  // An hour later (or topped up and the worker restarted) they are tried again.
  __resetRouterState();
  globalThis.fetch = async (url) => (String(url).includes('generativelanguage') ? Response.json({ candidates: [{ content: { parts: [{ text: 'A phone showing an error page.' }] } }] }) : new Response('', { status: 500 }));
  res = await post({ cameraAnalyze: true, frame: { inlineData: { mimeType: 'image/jpeg', data: FRAME } } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.caption, 'A phone showing an error page.');
  const bad = await post({ cameraAnalyze: true, frame: { inlineData: { mimeType: 'text/plain', data: 'aGk=' } } });
  assert.equal(bad.statusCode, 400);
});
