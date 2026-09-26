/**
 * Tests for GET/HEAD /api/health (issue #119): a public, ungated uptime
 * health check that does a cheap HEAD-only Supabase reachability check,
 * caches the result in memory for 30s, and never applies license/free-tier/
 * x402 gating.
 * Run with: node --test tests/health.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { default: handler, __resetHealthCache } = await import('../api/health.mjs');

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  __resetHealthCache();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
});

function makeReq(method = 'GET', headers = {}) {
  return { method, url: '/api/health', headers };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end(payload) {
      if (payload !== undefined) this.body = payload;
      return this;
    }
  };
  return res;
}

test('healthy Supabase returns 200 with status ok', async () => {
  global.fetch = async () => ({ ok: true });

  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.checks.supabase, 'ok');
  assert.match(res.body.time, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('Supabase failure returns 503 with status degraded', async () => {
  global.fetch = async () => ({ ok: false });

  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'degraded');
  assert.equal(res.body.checks.supabase, 'unavailable');
});

test('Supabase timeout returns 503 with status degraded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  global.fetch = (url, opts) =>
    new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

  const req = makeReq();
  const res = makeRes();
  const pending = handler(req, res);
  t.mock.timers.tick(2000);
  await pending;

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'degraded');
  assert.equal(res.body.checks.supabase, 'unavailable');
});

test('cached result is reused within the TTL instead of re-querying Supabase', async () => {
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    return { ok: true };
  };

  const first = makeRes();
  await handler(makeReq(), first);
  const second = makeRes();
  await handler(makeReq(), second);

  assert.equal(callCount, 1, 'second request should be served from the in-memory cache');
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body, first.body);
});

test('POST is rejected with 405', async () => {
  global.fetch = async () => {
    throw new Error('Supabase should not be queried for a rejected method');
  };

  const req = makeReq('POST');
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Allow'], 'GET, HEAD');
});

test('HEAD is allowed and mirrors the GET status with no body', async () => {
  global.fetch = async () => ({ ok: true });

  const req = makeReq('HEAD');
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, null);
});

test('no gating applied: succeeds with no license key, free-tier header or payment signature', async () => {
  global.fetch = async () => ({ ok: true });

  const req = makeReq('GET', {});
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
});
