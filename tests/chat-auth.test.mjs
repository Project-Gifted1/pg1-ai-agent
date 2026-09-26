/**
 * Tests for api/chat.mjs auth hardening (issue #110):
 * - CHAT (and other paid/storage actions) require isAuthed, AUTH_VERIFY stays reachable
 * - per-IP lockout after 5 failed auth attempts in 15 minutes (429)
 * - GITHUB_TOKEN is no longer an accepted login credential
 * - /api/ioc and /api/mcp CORS headers are unchanged
 * Run with: node --test tests/chat-auth.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import mcpHandler from '../api/mcp.mjs';

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GITHUB_TOKEN = 'ghp_test_token_should_not_authenticate';
  delete process.env.USER_API_USER;
  delete process.env.USER_API_PASSS;
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
});

function makeReq(body, opts = {}) {
  return {
    method: 'POST',
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
    end() {
      return this;
    }
  };
  return res;
}

test('unauthenticated CHAT returns 401', async () => {
  const req = makeReq({ prompt: 'hello there' }, { ip: '10.0.0.1' });
  const res = makeRes();
  await chatHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('AUTH_VERIFY stays reachable and succeeds with correct USER_API_KEY/USER_API_PASS', async () => {
  const req = makeReq(
    { prompt: 'AUTH_VERIFY', user: 'test-operator', pass: 'test-secret-pass' },
    { ip: '10.0.0.2' }
  );
  const res = makeRes();
  await chatHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.authenticated, true);
});

test('GITHUB_TOKEN no longer authenticates (as pass, or as Bearer header)', async () => {
  const reqPass = makeReq(
    { prompt: 'AUTH_VERIFY', user: 'test-operator', pass: process.env.GITHUB_TOKEN },
    { ip: '10.0.0.3' }
  );
  const resPass = makeRes();
  await chatHandler(reqPass, resPass);
  assert.equal(resPass.statusCode, 401);

  __clearAuthRateLimitState();
  const reqBearer = makeReq(
    { prompt: 'AUTH_VERIFY' },
    { ip: '10.0.0.4', headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } }
  );
  const resBearer = makeRes();
  await chatHandler(reqBearer, resBearer);
  assert.equal(resBearer.statusCode, 401);
});

test('login lockout after 5 failed attempts in 15 minutes returns 429, even for correct credentials', async () => {
  const ip = '10.0.0.5';
  for (let i = 0; i < 5; i++) {
    const req = makeReq({ prompt: 'AUTH_VERIFY', user: 'test-operator', pass: 'wrong-pass' }, { ip });
    const res = makeRes();
    await chatHandler(req, res);
    assert.equal(res.statusCode, 401);
  }

  const lockedReq = makeReq(
    { prompt: 'AUTH_VERIFY', user: 'test-operator', pass: 'test-secret-pass' },
    { ip }
  );
  const lockedRes = makeRes();
  await chatHandler(lockedReq, lockedRes);
  assert.equal(lockedRes.statusCode, 429);
});

test('/api/ioc CORS headers are unchanged (wildcard origin, no auth required)', async () => {
  const req = makeReq({}, { ip: '10.0.0.6', url: '/api/ioc' });
  req.method = 'GET';
  const res = makeRes();
  await chatHandler(req, res);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('/api/mcp CORS headers are unchanged (wildcard origin)', async () => {
  const req = {
    method: 'GET',
    url: '/api/mcp',
    headers: {},
    socket: { remoteAddress: '10.0.0.7' }
  };
  const res = makeRes();
  await mcpHandler(req, res);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
});
