/**
 * Tests for issue #110 follow-up: confirm the /api/chat auth hardening
 * (per-IP login lockout, USER_API_KEY/USER_API_PASS gating) does not leak
 * into the /api/ioc STIX feed, which is served by the same handler but is
 * meant to stay reachable via license key / free tier / x402 without ever
 * touching the login lockout counters.
 *
 * Run with: node --test tests/ioc-auth-isolation.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  delete process.env.USER_API_USER;
  delete process.env.USER_API_PASSS;
  delete process.env.X402_PAY_TO_ADDRESS;
  delete process.env.GUMROAD_PRODUCT_ID;
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
});

function makeReq(body, opts = {}) {
  return {
    method: opts.method || 'POST',
    url: opts.url || '/api/chat',
    headers: opts.headers || {},
    socket: { remoteAddress: opts.ip || '127.0.0.1' },
    body
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    rawBody: null,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    getHeader(key) {
      return this.headers[key];
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
      this.rawBody = payload;
      if (typeof payload === 'string') {
        try {
          this.body = JSON.parse(payload);
        } catch (e) {
          // not JSON, leave body as-is
        }
      }
      return this;
    }
  };
  return res;
}

// Mocks the two external services /api/ioc talks to: Gumroad (license
// verification) and Supabase (free_tier_usage counter + threat_ioc_telemetry
// + fire-and-forget api_access_logs). Routes purely on URL substring so it
// doesn't need to track call order.
function installFetchMock({ gumroadSuccess = true } = {}) {
  global.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    if (urlStr.includes('api.gumroad.com')) {
      return {
        ok: true,
        json: async () => (gumroadSuccess ? { success: true, purchase: {} } : { success: false })
      };
    }
    if (urlStr.includes('/rest/v1/free_tier_usage')) {
      if (!options.method || options.method === 'GET') {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => [] };
    }
    if (urlStr.includes('/rest/v1/threat_ioc_telemetry')) {
      return {
        ok: true,
        json: async () => [
          {
            indicator_type: 'IPv4',
            value: '198.51.100.23',
            confidence_score: 75,
            last_seen: '2026-09-24T12:00:00Z',
            ingested_at: '2026-09-20T00:00:00Z',
            verification_source: 'test-source'
          }
        ]
      };
    }
    if (urlStr.includes('/rest/v1/api_access_logs')) {
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  };
}

test('GET /api/ioc with no headers returns 402 (payment required), not 401', async () => {
  installFetchMock();
  const req = makeReq(null, { method: 'GET', url: '/api/ioc', ip: '10.1.0.1' });
  const res = makeRes();
  await chatHandler(req, res);
  assert.equal(res.statusCode, 402);
});

test('GET /api/ioc with x-free-tier: 1 returns 200 with a STIX bundle', async () => {
  installFetchMock();
  const req = makeReq(null, {
    method: 'GET',
    url: '/api/ioc',
    ip: '10.1.0.2',
    headers: { 'x-free-tier': '1' }
  });
  const res = makeRes();
  await chatHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.type, 'bundle');
  assert.ok(Array.isArray(res.body.objects) && res.body.objects.length > 0);
});

test('x-api-key (license) requests never count as failed login or trigger the 429 lockout', async () => {
  installFetchMock({ gumroadSuccess: false });
  const ip = '10.1.0.3';

  for (let i = 0; i < 10; i++) {
    const req = makeReq(null, {
      method: 'GET',
      url: '/api/ioc',
      ip,
      headers: { 'x-api-key': 'invalid-license-key' }
    });
    const res = makeRes();
    await chatHandler(req, res);
    // Invalid license -> 403, never 401/429, and never touches auth lockout.
    assert.equal(res.statusCode, 403);
  }

  // Same IP should still be able to log into /api/chat with correct
  // credentials right after - it must not have been locked out by the
  // 10 license attempts above.
  const loginReq = makeReq(
    { prompt: 'AUTH_VERIFY', user: 'test-operator', pass: 'test-secret-pass' },
    { ip }
  );
  const loginRes = makeRes();
  await chatHandler(loginReq, loginRes);
  assert.equal(loginRes.statusCode, 200);
  assert.equal(loginRes.body.authenticated, true);
});

test('an IP locked out on /api/chat is NOT blocked from /api/ioc or the free tier', async () => {
  installFetchMock();
  const ip = '10.1.0.4';

  for (let i = 0; i < 5; i++) {
    const req = makeReq({ prompt: 'AUTH_VERIFY', user: 'test-operator', pass: 'wrong-pass' }, { ip });
    const res = makeRes();
    await chatHandler(req, res);
    assert.equal(res.statusCode, 401);
  }

  // Confirm the lockout is actually in effect for /api/chat itself.
  const lockedChatReq = makeReq(
    { prompt: 'AUTH_VERIFY', user: 'test-operator', pass: 'test-secret-pass' },
    { ip }
  );
  const lockedChatRes = makeRes();
  await chatHandler(lockedChatReq, lockedChatRes);
  assert.equal(lockedChatRes.statusCode, 429);

  // /api/ioc with no headers should still get the normal 402, not 429.
  const iocReq = makeReq(null, { method: 'GET', url: '/api/ioc', ip });
  const iocRes = makeRes();
  await chatHandler(iocReq, iocRes);
  assert.equal(iocRes.statusCode, 402);

  // Free tier from the same IP should still be served, not blocked.
  const freeTierReq = makeReq(null, {
    method: 'GET',
    url: '/api/ioc',
    ip,
    headers: { 'x-free-tier': '1' }
  });
  const freeTierRes = makeRes();
  await chatHandler(freeTierReq, freeTierRes);
  assert.equal(freeTierRes.statusCode, 200);
});
