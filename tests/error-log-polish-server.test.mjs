/**
 * Issue #201 "Error-log polish" (server side):
 *
 *  1. The client's real occurrence time (`entry.time`) is used for
 *     first_seen/last_seen instead of the server's ingest-time "now" -
 *     found in a live test where a message sent offline and synced two
 *     minutes later showed the sync time, not when it actually failed.
 *  2. A reason category (offline/network/timeout/http_4xx/http_5xx/js_error)
 *     is stored alongside each row - explicit for client rows (validated
 *     against a fixed allow-list), derived from `status` for server rows.
 *
 * Run with: node --test tests/error-log-polish-server.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { logApiError, VALID_CLIENT_ERROR_CATEGORIES } from '../lib/errorLog.mjs';
import errorsHandler, { __clearErrorsRateLimitState } from '../api/errors.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

after(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...ORIGINAL_ENV };
});

function installFetchMock(calls, { existingRow = null } = {}) {
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if ((options.method || 'GET') === 'GET') {
      return { ok: true, json: async () => (existingRow ? [existingRow] : []) };
    }
    return { ok: true, json: async () => ({}) };
  };
}

test('VALID_CLIENT_ERROR_CATEGORIES contains exactly the documented set', () => {
  assert.deepEqual(
    [...VALID_CLIENT_ERROR_CATEGORIES].sort(),
    ['http_4xx', 'http_5xx', 'js_error', 'network', 'offline', 'timeout']
  );
});

test('logApiError uses the client-reported occurredAt for first_seen/last_seen on insert', async () => {
  const calls = [];
  installFetchMock(calls, { existingRow: null });
  await logApiError('https://example.supabase.co', 'key', {
    source: 'client', route: 'client', status: null, reason: 'status',
    category: 'offline', occurredAt: '2026-09-30T05:06:00.000Z'
  });

  const postCall = calls.find((c) => c.method === 'POST');
  assert.ok(postCall);
  assert.equal(postCall.body.first_seen, '2026-09-30T05:06:00.000Z');
  assert.equal(postCall.body.last_seen, '2026-09-30T05:06:00.000Z');
  assert.equal(postCall.body.category, 'offline');
});

test('logApiError uses occurredAt for last_seen (not first_seen) when patching an existing group', async () => {
  const calls = [];
  installFetchMock(calls, { existingRow: { id: 'row-1', count: 1 } });
  await logApiError('https://example.supabase.co', 'key', {
    source: 'client', route: 'client', status: null, reason: 'status',
    category: 'network', occurredAt: '2026-09-30T05:06:00.000Z'
  });

  const patchCall = calls.find((c) => c.method === 'PATCH');
  assert.ok(patchCall);
  assert.equal(patchCall.body.last_seen, '2026-09-30T05:06:00.000Z');
  assert.equal(patchCall.body.category, 'network');
  assert.ok(!('first_seen' in patchCall.body), 'PATCH must never touch first_seen - it stays the original occurrence');
});

test('logApiError falls back to server time when occurredAt is missing or unparsable', async () => {
  const calls = [];
  installFetchMock(calls, { existingRow: null });
  const before = Date.now();
  await logApiError('https://example.supabase.co', 'key', {
    source: 'client', route: 'client', status: null, reason: 'status', category: 'js_error', occurredAt: 'not-a-date'
  });
  const after = Date.now();

  const postCall = calls.find((c) => c.method === 'POST');
  const storedTime = new Date(postCall.body.last_seen).getTime();
  assert.ok(storedTime >= before && storedTime <= after, 'expected a fresh server timestamp as fallback');
});

test('logApiError clamps a future occurredAt to now instead of trusting it', async () => {
  const calls = [];
  installFetchMock(calls, { existingRow: null });
  const farFuture = new Date(Date.now() + 100000000).toISOString();
  await logApiError('https://example.supabase.co', 'key', {
    source: 'client', route: 'client', status: null, reason: 'status', category: 'js_error', occurredAt: farFuture
  });

  const postCall = calls.find((c) => c.method === 'POST');
  assert.notEqual(postCall.body.last_seen, farFuture);
  assert.ok(new Date(postCall.body.last_seen).getTime() <= Date.now() + 1000);
});

test('logApiError derives http_5xx/http_4xx from status for server rows with no explicit category', async () => {
  const calls = [];
  installFetchMock(calls, { existingRow: null });
  await logApiError('https://example.supabase.co', 'key', { source: 'server', route: 'CHAT', status: 503, reason: 'x' });
  let postCall = calls.find((c) => c.method === 'POST');
  assert.equal(postCall.body.category, 'http_5xx');

  calls.length = 0;
  await logApiError('https://example.supabase.co', 'key', { source: 'server', route: 'CHAT', status: 401, reason: 'y' });
  postCall = calls.find((c) => c.method === 'POST');
  assert.equal(postCall.body.category, 'http_4xx');
});

test('logApiError leaves category null for a server row with no status and no explicit category', async () => {
  const calls = [];
  installFetchMock(calls, { existingRow: null });
  await logApiError('https://example.supabase.co', 'key', { source: 'server', route: 'CHAT', status: null, reason: 'x' });
  const postCall = calls.find((c) => c.method === 'POST');
  assert.equal(postCall.body.category, null);
});

// --- api/errors.mjs: passes time/category through to logApiError ---

function resetErrorsEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  delete process.env.USER_API_USER;
  delete process.env.USER_API_PASSS;
}

beforeEach(() => {
  resetErrorsEnv();
  __clearErrorsRateLimitState();
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

function installErrorsFetchMock(calls) {
  globalThis.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (urlStr.includes('/rest/v1/pg1_errors') && (!options.method || options.method === 'GET')) {
      return { ok: true, json: async () => [] }; // logApiError's internal group lookup: always "new row"
    }
    return { ok: true, json: async () => ({}) };
  };
}

test('op:ingest passes the client-reported time and a valid category through to the stored row', async () => {
  const calls = [];
  installErrorsFetchMock(calls);
  const res = makeRes();
  await errorsHandler(makeReq({
    op: 'ingest', user: 'test-operator', pass: 'test-secret-pass',
    entries: [{ context: 'submitDirective', category: 'offline', time: '2026-09-30T05:06:00.000Z' }]
  }, { ip: '10.9.1.1' }), res);

  assert.equal(res.statusCode, 200);
  const insertCall = calls.find((c) => c.method === 'POST' && c.url.includes('/rest/v1/pg1_errors') && !c.url.includes('?'));
  assert.ok(insertCall);
  assert.equal(insertCall.body.category, 'offline');
  assert.equal(insertCall.body.first_seen, '2026-09-30T05:06:00.000Z');
  assert.equal(insertCall.body.last_seen, '2026-09-30T05:06:00.000Z');
});

test('op:ingest drops an unrecognized category instead of storing arbitrary text', async () => {
  const calls = [];
  installErrorsFetchMock(calls);
  const res = makeRes();
  await errorsHandler(makeReq({
    op: 'ingest', user: 'test-operator', pass: 'test-secret-pass',
    entries: [{ context: 'status', category: 'literally-anything', time: '2026-09-30T05:06:00.000Z' }]
  }, { ip: '10.9.1.2' }), res);

  const insertCall = calls.find((c) => c.method === 'POST' && c.url.includes('/rest/v1/pg1_errors') && !c.url.includes('?'));
  assert.equal(insertCall.body.category, null);
});

test('op:ingest tolerates a missing time/category (falls back to server time, null category)', async () => {
  const calls = [];
  installErrorsFetchMock(calls);
  const res = makeRes();
  await errorsHandler(makeReq({
    op: 'ingest', user: 'test-operator', pass: 'test-secret-pass',
    entries: [{ context: 'status' }]
  }, { ip: '10.9.1.3' }), res);

  assert.equal(res.statusCode, 200);
  const insertCall = calls.find((c) => c.method === 'POST' && c.url.includes('/rest/v1/pg1_errors') && !c.url.includes('?'));
  assert.equal(insertCall.body.category, null);
  assert.ok(insertCall.body.first_seen);
});

test('op:ingest processes a batch oldest-first so last_seen ends up as the newest occurrence, not the oldest', async () => {
  // The browser's local log is newest-first (unshift), so a batch of two
  // occurrences of the *same* group arrives as [newer, older].
  const rows = []; // simulates the pg1_errors table across sequential GET/POST/PATCH calls
  globalThis.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    const method = options.method || 'GET';
    if (urlStr.includes('/rest/v1/pg1_errors') && method === 'GET') {
      return { ok: true, json: async () => (rows.length ? [{ id: 'row-1', count: rows.length }] : []) };
    }
    if (method === 'POST') {
      const body = JSON.parse(options.body);
      rows.push(body);
      return { ok: true, json: async () => ({}) };
    }
    if (method === 'PATCH') {
      const body = JSON.parse(options.body);
      rows.push(body);
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  };

  const res = makeRes();
  await errorsHandler(makeReq({
    op: 'ingest', user: 'test-operator', pass: 'test-secret-pass',
    entries: [
      { context: 'submitDirective', category: 'offline', time: '2026-09-30T05:08:00.000Z' },
      { context: 'submitDirective', category: 'offline', time: '2026-09-30T05:06:00.000Z' }
    ]
  }, { ip: '10.9.1.4' }), res);

  assert.equal(res.statusCode, 200);
  const lastWrite = rows[rows.length - 1];
  assert.equal(lastWrite.last_seen, '2026-09-30T05:08:00.000Z', 'last_seen must be the newest of the batch, not whichever was processed last by array order');
});
