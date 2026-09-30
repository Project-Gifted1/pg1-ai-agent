/**
 * Issue #201 Phase 2b:
 *  - [DEPLOYMENT] is always present in the system prompt's [CONTEXT] section
 *    (VERCEL_ENV, short commit SHA, branch, region when set; server UTC time
 *    always), stated as fact (unlike [CLIENT ENVIRONMENT], which is always
 *    hedged as browser-reported).
 *  - [UNRESOLVED ERRORS] appears (capped at 5, last 24h) when Supabase has
 *    unresolved pg1_errors rows, and is absent when there are none/Supabase
 *    isn't configured.
 *
 * Run with: node --test tests/deployment-and-unresolved-errors.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY = 'stub-gemini-key';
  delete process.env.USER_API_USER;
  delete process.env.USER_API_PASSS;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTROPIC_API_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.VERCEL_GIT_COMMIT_REF;
  delete process.env.VERCEL_REGION;
}

let capturedSystemInstruction = null;

function installGeminiMock() {
  globalThis.fetch = async (url, options) => {
    const urlStr = String(url);
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      if (options && typeof options.body === 'string') {
        try {
          const parsedBody = JSON.parse(options.body);
          capturedSystemInstruction = parsedBody.systemInstruction && parsedBody.systemInstruction.parts && parsedBody.systemInstruction.parts[0] && parsedBody.systemInstruction.parts[0].text;
        } catch (e) { /* ignore */ }
      }
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Stubbed model reply.' }] } }] }) };
    }
    if (urlStr.includes('/rest/v1/pg1_errors')) {
      return { ok: true, json: async () => (globalThis.__mockUnresolvedErrors || []) };
    }
    if (urlStr.includes('/rest/v1/messages') || urlStr.includes('/storage/v1/object/list')) {
      return { ok: true, json: async () => [] };
    }
    throw new Error('Unexpected network call in test: ' + urlStr);
  };
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
  capturedSystemInstruction = null;
  globalThis.__mockUnresolvedErrors = [];
  installGeminiMock();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
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
    setHeader(key, value) { this.headers[key] = value; },
    getHeader(key) { return this.headers[key]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
  return res;
}

// The static CAPABILITIES text always mentions "[UNRESOLVED ERRORS]" by name
// (describing when it *would* appear), so asserting its absence has to look
// only at the actual [CONTEXT] section, same as environment-awareness.test.mjs.
function contextSection(systemInstruction) {
  const marker = '[CONTEXT]:';
  const idx = systemInstruction.indexOf(marker);
  return idx === -1 ? '' : systemInstruction.slice(idx);
}

test('[DEPLOYMENT] is present even with no VERCEL_* env vars set (server UTC time alone)', async () => {
  const req = makeReq({ prompt: 'hello', user: 'test-operator', pass: 'test-secret-pass' }, { ip: '10.7.0.1' });
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(capturedSystemInstruction, /\[DEPLOYMENT\]/);
  assert.match(capturedSystemInstruction, /Server UTC time: \d{4}-\d{2}-\d{2}T/);
});

test('[DEPLOYMENT] surfaces VERCEL_ENV, short commit SHA, branch and region when set', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890';
  process.env.VERCEL_GIT_COMMIT_REF = 'main';
  process.env.VERCEL_REGION = 'lhr1';

  const req = makeReq({ prompt: 'hello', user: 'test-operator', pass: 'test-secret-pass' }, { ip: '10.7.0.2' });
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(capturedSystemInstruction, /Deploy target: production/);
  assert.match(capturedSystemInstruction, /Commit: abcdef1/);
  assert.doesNotMatch(capturedSystemInstruction, /Commit: abcdef1234567890/);
  assert.match(capturedSystemInstruction, /Branch: main/);
  assert.match(capturedSystemInstruction, /Region: lhr1/);
});

test('[UNRESOLVED ERRORS] is absent when Supabase is not configured', async () => {
  const req = makeReq({ prompt: 'what is broken', user: 'test-operator', pass: 'test-secret-pass' }, { ip: '10.7.0.3' });
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(contextSection(capturedSystemInstruction), /\[UNRESOLVED ERRORS/);
});

test('[UNRESOLVED ERRORS] lists real rows, capped and labelled by source, when Supabase has unresolved errors', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  globalThis.__mockUnresolvedErrors = [
    { source: 'server', route: 'CHAT', status: 500, reason: 'stix_bundle_exception', count: 3, last_seen: '2026-09-30T10:00:00Z' },
    { source: 'client', route: 'client', status: null, reason: 'window', count: 1, last_seen: '2026-09-30T09:00:00Z' }
  ];

  const req = makeReq({ prompt: 'what is broken', user: 'test-operator', pass: 'test-secret-pass' }, { ip: '10.7.0.4' });
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(capturedSystemInstruction, /\[UNRESOLVED ERRORS \(last 24h, max 5\)\]/);
  // No `category` field on these rows (older-row shape) - the bracket must
  // render exactly as it always did, with nothing inserted.
  assert.match(capturedSystemInstruction, /\[server\] CHAT 500: stix_bundle_exception \(x3\)/);
  assert.match(capturedSystemInstruction, /\[client\].*window/);
});

test('[UNRESOLVED ERRORS] appends the reason category to the bracket label when present (issue #201 error-log polish)', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  globalThis.__mockUnresolvedErrors = [
    { source: 'server', route: 'CHAT', status: 500, reason: 'stix_bundle_exception', category: 'http_5xx', count: 3, last_seen: '2026-09-30T10:00:00Z' },
    { source: 'client', route: 'client', status: null, reason: 'submitDirective', category: 'offline', count: 2, last_seen: '2026-09-30T09:00:00Z' }
  ];

  const req = makeReq({ prompt: 'what is broken', user: 'test-operator', pass: 'test-secret-pass' }, { ip: '10.7.0.5' });
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(capturedSystemInstruction, /\[server\/http_5xx\] CHAT 500: stix_bundle_exception \(x3\)/);
  assert.match(capturedSystemInstruction, /\[client\/offline\].*submitDirective/);
});
