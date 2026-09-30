/**
 * Issue #201 Phase 2b — /api/errors (api/errors.mjs):
 *  - OPTIONS/method gating, authentication, and per-IP rate limiting.
 *  - op:'ingest' stores only the fixed context/category string, never any
 *    free-text message - the whole point of keeping user message content
 *    and arbitrary client text out of anything logged.
 *  - op:'list' returns the pg1_errors rows for the ERROR LOG modal.
 *  - op:'resolve' marks exactly the given row resolved.
 *
 * Run with: node --test tests/errors-endpoint.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import errorsHandler, { __clearErrorsRateLimitState } from '../api/errors.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  delete process.env.USER_API_USER;
  delete process.env.USER_API_PASSS;
}

beforeEach(() => {
  resetEnv();
  __clearErrorsRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function makeReq(body, opts = {}) {
  return {
    method: opts.method || 'POST',
    headers: opts.headers || {},
    socket: { remoteAddress: opts.ip || '127.0.0.1' },
    body
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    getHeader(key) { return this.headers[key]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
  return res;
}

function installFetchMock(calls, { listRows = [] } = {}) {
  globalThis.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (urlStr.includes('/rest/v1/pg1_errors') && (!options.method || options.method === 'GET')) {
      if (urlStr.includes('order=last_seen.desc') && urlStr.includes('limit=100')) {
        return { ok: true, json: async () => listRows };
      }
      return { ok: true, json: async () => [] }; // logApiError's internal group lookup
    }
    return { ok: true, json: async () => ({}) };
  };
}

test('OPTIONS returns 204 with no auth required', async () => {
  installFetchMock([]);
  const res = makeRes();
  await errorsHandler(makeReq(null, { method: 'OPTIONS' }), res);
  assert.equal(res.statusCode, 204);
});

test('non-POST/OPTIONS method is rejected with 405', async () => {
  installFetchMock([]);
  const res = makeRes();
  await errorsHandler(makeReq(null, { method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
});

test('missing/invalid credentials are rejected with 401 and never touch Supabase', async () => {
  const calls = [];
  installFetchMock(calls);
  const res = makeRes();
  await errorsHandler(makeReq({ op: 'list', user: 'nope', pass: 'nope' }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test('per-IP rate limit kicks in after too many requests in the window', async () => {
  installFetchMock([], { listRows: [] });
  const ip = '10.9.0.1';
  let lastRes;
  for (let i = 0; i < 40; i++) {
    lastRes = makeRes();
    await errorsHandler(makeReq({ op: 'list', user: 'test-operator', pass: 'test-secret-pass' }, { ip }), lastRes);
  }
  assert.equal(lastRes.statusCode, 429);
});

test('op:ingest stores only the context/category, never a message field', async () => {
  const calls = [];
  installFetchMock(calls);
  const res = makeRes();
  await errorsHandler(makeReq({
    op: 'ingest', user: 'test-operator', pass: 'test-secret-pass',
    entries: [{ context: 'status', message: 'should never be stored: sk-secret-123' }]
  }, { ip: '10.9.0.2' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ingested, 1);
  const insertCall = calls.find((c) => c.method === 'POST' && c.url.includes('/rest/v1/pg1_errors') && !c.url.includes('?'));
  assert.ok(insertCall, 'expected an insert into pg1_errors');
  assert.equal(insertCall.body.source, 'client');
  assert.equal(insertCall.body.reason, 'status');
  assert.equal(insertCall.body.message, null, 'message text must never be stored for a client-ingested entry');
  for (const c of calls) {
    assert.ok(!JSON.stringify(c.body).includes('sk-secret-123'), 'the free-text message must never reach any Supabase call');
  }
});

test('op:ingest caps the number of entries processed per request', async () => {
  const calls = [];
  installFetchMock(calls);
  const res = makeRes();
  const entries = Array.from({ length: 30 }, (_, i) => ({ context: 'status' + i }));
  await errorsHandler(makeReq({ op: 'ingest', user: 'test-operator', pass: 'test-secret-pass', entries }, { ip: '10.9.0.3' }), res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.ingested <= 20, `expected at most 20 ingested, got ${res.body.ingested}`);
});

test('op:list returns the rows from pg1_errors', async () => {
  const rows = [{ id: 'a', source: 'server', route: 'CHAT', status: 401, reason: 'unauthenticated', message: null, count: 2, resolved: false, last_seen: '2026-09-30T12:00:00Z' }];
  installFetchMock([], { listRows: rows });
  const res = makeRes();
  await errorsHandler(makeReq({ op: 'list', user: 'test-operator', pass: 'test-secret-pass' }, { ip: '10.9.0.4' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.errors, rows);
});

test('op:resolve PATCHes the given row id to resolved:true', async () => {
  const calls = [];
  installFetchMock(calls);
  const res = makeRes();
  await errorsHandler(makeReq({ op: 'resolve', user: 'test-operator', pass: 'test-secret-pass', id: 'row-42' }, { ip: '10.9.0.5' }), res);
  assert.equal(res.statusCode, 200);
  const patchCall = calls.find((c) => c.method === 'PATCH');
  assert.ok(patchCall.url.includes('id=eq.row-42'));
  assert.equal(patchCall.body.resolved, true);
});

test('op:resolve without an id returns 400', async () => {
  installFetchMock([]);
  const res = makeRes();
  await errorsHandler(makeReq({ op: 'resolve', user: 'test-operator', pass: 'test-secret-pass' }, { ip: '10.9.0.6' }), res);
  assert.equal(res.statusCode, 400);
});

test('unknown op returns 400', async () => {
  installFetchMock([]);
  const res = makeRes();
  await errorsHandler(makeReq({ op: 'bogus', user: 'test-operator', pass: 'test-secret-pass' }, { ip: '10.9.0.7' }), res);
  assert.equal(res.statusCode, 400);
});
