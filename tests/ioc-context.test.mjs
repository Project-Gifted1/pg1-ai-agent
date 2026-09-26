/**
 * Tests for api/ioc/context.js — the REST mirror of get_ioc_context
 * (issue #117): a genuinely invalid/expired/refunded license key must keep
 * the existing 402 response, while a Gumroad-unreachable verification must
 * return a distinct, retry-able 503 with Retry-After: 5, and in neither case
 * fall through to the free tier or x402.
 *
 * Run with: node --test tests/ioc-context.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

process.env.ENABLE_REST_IOC_CONTEXT = 'true';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.X402_PAY_TO_ADDRESS;

// api/ioc/context.js reads ENABLE_REST_IOC_CONTEXT and constructs its x402
// gate at module load time, so env vars must be set before this import runs.
const { default: handler } = await import('../api/ioc/context.js');

beforeEach(() => {
  process.env.ENABLE_REST_IOC_CONTEXT = 'true';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
});

function makeReq(query, headers = {}) {
  const search = new URLSearchParams(query).toString();
  return {
    method: 'GET',
    url: `/api/ioc/context?${search}`,
    query,
    headers
  };
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
      this.body = payload;
      return this;
    }
  };
  return res;
}

// The route only reaches the license gate at all when the indicator is
// found — a found:false result is free and returned before any license
// check. All these tests need a "found" indicator.
function mockFetch({ gumroadSuccess, gumroadUnavailable } = {}) {
  return async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('threat_ioc_telemetry')) {
      return {
        ok: true,
        json: async () => [
          {
            indicator_type: 'IPv4',
            value: '198.51.100.23',
            confidence_score: 80,
            last_seen: '2026-09-24T12:00:00Z',
            ingested_at: '2026-09-20T00:00:00Z',
            verification_source: 'test-source'
          }
        ]
      };
    }
    if (urlStr.includes('api.gumroad.com')) {
      if (gumroadUnavailable) throw new Error('gumroad unreachable');
      return { ok: true, json: async () => (gumroadSuccess ? { success: true, purchase: {} } : { success: false }) };
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
}

test('a genuinely invalid license key on a found indicator returns 402, unchanged', async () => {
  global.fetch = mockFetch({ gumroadSuccess: false });
  const req = makeReq({ value: '198.51.100.23' }, { 'x-api-key': 'bad-license-key' });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 402);
  assert.match(res.body.error, /Payment Required/i);
  assert.equal(res.headers['Retry-After'], undefined);
});

test('issue #117: a Gumroad-unreachable verification on a found indicator returns 503 + Retry-After: 5, not 402', async () => {
  global.fetch = mockFetch({ gumroadUnavailable: true });
  const req = makeReq(
    { value: '198.51.100.23' },
    { 'x-api-key': 'some-license-key', 'x-free-tier': '1' }
  );
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Retry-After'], '5');
  assert.match(res.body.error, /temporarily unavailable/i);
});

test('a valid license key on a found indicator is authorized and returns 200', async () => {
  global.fetch = mockFetch({ gumroadSuccess: true });
  const req = makeReq({ value: '198.51.100.23' }, { 'x-api-key': 'valid-license-key' });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.found, true);
});
