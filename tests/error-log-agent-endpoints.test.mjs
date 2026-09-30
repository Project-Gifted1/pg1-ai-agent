/**
 * Issue #213: wires api/mcp.mjs and api/a2a.mjs into the existing error log
 * (lib/errorLog.mjs / pg1_errors), previously left out of Phase 2b. Covers:
 *
 *  - An upstream failure or timeout inside a tool/skill (e.g.
 *    check_wallet_age's WalletAgeUpstreamError, check_wallet_sanctions'
 *    serviceUnavailable) is logged with route "/api/mcp:<tool>" or
 *    "/api/a2a:<skill>" and category "upstream"/"timeout", and never changes
 *    the tool's own response.
 *  - An unhandled exception in either endpoint is logged (category
 *    js_error, status 500) without leaking the raw exception message into
 *    the response.
 *  - Normal, non-error outcomes are never logged: 402 (payment/license
 *    required), rate-limited ("429-equivalent"), invalid params/unknown
 *    method/parse errors (-32602/-32601/-32700), invalid address/chain
 *    (caller mistakes), and found:false.
 *  - Logging is fire-and-forget: a logger that hangs or throws never slows
 *    down or changes the response.
 *  - No caller input (the address/hostname/domain itself) ever reaches a
 *    logging call.
 *
 * Run with: node --test tests/error-log-agent-endpoints.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import mcpHandler from '../api/mcp.mjs';
import a2aHandler from '../api/a2a.mjs';

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
    end() {
      return this;
    }
  };
  return res;
}

function withEnv(t, vars) {
  const prev = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key]; else process.env[key] = vars[key];
  }
  t.after(() => {
    for (const key of Object.keys(vars)) {
      if (prev[key] === undefined) delete process.env[key]; else process.env[key] = prev[key];
    }
  });
}

function withSupabaseEnv(t) {
  withEnv(t, { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key' });
}

function withoutSupabaseEnv(t) {
  withEnv(t, { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
}

function withAlchemyEnv(t) {
  withEnv(t, { ALCHEMY_API_KEY: 'test-alchemy-key' });
}

function withoutAlchemyEnv(t) {
  withEnv(t, { ALCHEMY_API_KEY: undefined });
}

// Captures every fetch aimed at pg1_errors (the error log table) while
// dispatching everything else to `otherRoutes` (a url-substring -> responder
// map) - same layered-mock style as tests/wallet-age.test.mjs.
function installFetchMock(t, otherRoutes) {
  const errorLogCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    const method = options.method || 'GET';
    if (urlStr.includes('/rest/v1/pg1_errors')) {
      const body = options.body ? JSON.parse(options.body) : null;
      errorLogCalls.push({ url: urlStr, method, body });
      if (method === 'GET') return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({}) };
    }
    for (const [substr, responder] of otherRoutes) {
      if (urlStr.includes(substr)) return responder(urlStr, options);
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  return errorLogCalls;
}

const walletFirstSeenMiss = ['/rest/v1/wallet_first_seen', async () => ({ ok: true, json: async () => [] })];

function alchemyNotConfiguredRoutes() {
  return [walletFirstSeenMiss];
}

function alchemyHangRoute() {
  return ['.g.alchemy.com/v2/', async (url, options) => new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal) {
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    }
  })];
}

function alchemyFoundFalseRoute() {
  return ['.g.alchemy.com/v2/', async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === 'eth_getCode') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x' }) };
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { transfers: [] } }) };
  }];
}

function mcpReq(toolName, args, extraHeaders) {
  return {
    method: 'POST',
    headers: extraHeaders || {},
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }
  };
}

async function callMcpTool(toolName, args, extraHeaders) {
  const req = mcpReq(toolName, args, extraHeaders);
  const res = makeRes();
  await mcpHandler(req, res);
  return res;
}

function a2aReq(skill, args, extraHeaders) {
  return {
    method: 'POST',
    headers: extraHeaders || {},
    query: {},
    body: {
      jsonrpc: '2.0', id: 1, method: 'SendMessage',
      params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { skill, arguments: args } }] } }
    }
  };
}

async function callA2aSkill(skill, args, extraHeaders) {
  const req = a2aReq(skill, args, extraHeaders);
  const res = makeRes();
  await a2aHandler(req, res);
  return res;
}

const ADDRESS = '0x' + 'c'.repeat(40);

// recordToolError() is deliberately fire-and-forget (see api/mcp.mjs) - the
// handler's own promise resolves before logApiError's GET-then-POST/PATCH
// chain against pg1_errors finishes. Tests asserting a log call actually
// happened flush the microtask/macrotask queue once after awaiting the
// handler so that chain has a chance to run, without ever making the
// handler itself wait on it.
function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

function assertNoCallerInput(errorLogCalls, needle) {
  for (const call of errorLogCalls) {
    const haystack = call.url + JSON.stringify(call.body || {});
    assert.ok(!haystack.includes(needle), `expected no log call to contain caller input "${needle}", got: ${haystack}`);
  }
}

// --- upstream / timeout failures are logged, response unchanged ---

test('check_wallet_age: an upstream failure (Alchemy not configured) is logged once to /api/mcp:check_wallet_age, category upstream, and never changes the tool response', async (t) => {
  withSupabaseEnv(t);
  withoutAlchemyEnv(t);
  const errorLogCalls = installFetchMock(t, alchemyNotConfiguredRoutes());

  const res = await callMcpTool('check_wallet_age', { address: ADDRESS }, { 'x-forwarded-for': '203.0.113.11' });
  await flushAsync();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'upstream_unavailable');

  const inserts = errorLogCalls.filter((c) => c.method === 'POST');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].body.route, '/api/mcp:check_wallet_age');
  assert.equal(inserts[0].body.source, 'server');
  assert.equal(inserts[0].body.category, 'upstream');
  assertNoCallerInput(errorLogCalls, ADDRESS);
});

test('check_wallet_age: an upstream timeout is logged to /api/mcp:check_wallet_age with category timeout, and never changes the tool response', async (t) => {
  withSupabaseEnv(t);
  withAlchemyEnv(t);
  const errorLogCalls = installFetchMock(t, [alchemyHangRoute(), walletFirstSeenMiss]);

  const res = await callMcpTool('check_wallet_age', { address: ADDRESS }, { 'x-forwarded-for': '203.0.113.12' });
  await flushAsync();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'upstream_unavailable');
  assert.match(parsed.message, /timed out/i);

  const inserts = errorLogCalls.filter((c) => c.method === 'POST');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].body.route, '/api/mcp:check_wallet_age');
  assert.equal(inserts[0].body.category, 'timeout');
  assertNoCallerInput(errorLogCalls, ADDRESS);
});

test('a2a check_wallet_sanctions: an upstream (Supabase sanctions data) failure is logged to /api/a2a:check_wallet_sanctions, category upstream', async (t) => {
  withSupabaseEnv(t);
  const errorLogCalls = installFetchMock(t, [
    ['/rest/v1/sanctioned_wallets', async () => ({ ok: false, status: 503, json: async () => ({}) })]
  ]);

  const res = await callA2aSkill('check_wallet_sanctions', { address: ADDRESS });
  await flushAsync();

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.message, 'Sanctions data temporarily unavailable, please retry.');

  const inserts = errorLogCalls.filter((c) => c.method === 'POST');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].body.route, '/api/a2a:check_wallet_sanctions');
  assert.equal(inserts[0].body.category, 'upstream');
  assertNoCallerInput(errorLogCalls, ADDRESS);
});

// --- unhandled exceptions are logged (js_error / 500 / -32603) ---

test('api/mcp.mjs: an unhandled exception is logged (js_error, 500) without leaking the raw error into the response', async (t) => {
  withSupabaseEnv(t);
  const errorLogCalls = installFetchMock(t, []);

  const req = { method: 'POST', headers: undefined, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_usage_status', arguments: {} } } };
  const res = makeRes();
  await mcpHandler(req, res);
  await flushAsync();

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, -32603);
  assert.equal(res.body.error.message, 'Internal server error');

  const inserts = errorLogCalls.filter((c) => c.method === 'POST');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].body.route, '/api/mcp');
  assert.equal(inserts[0].body.category, 'js_error');
  assert.equal(inserts[0].body.status, 500);
});

test('api/a2a.mjs: an unhandled exception is logged (js_error, 500) without leaking the raw error into the response', async (t) => {
  withSupabaseEnv(t);
  const errorLogCalls = installFetchMock(t, []);

  const req = {
    method: 'POST',
    headers: undefined,
    query: {},
    body: {
      jsonrpc: '2.0', id: 1, method: 'SendMessage',
      params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { skill: 'get_usage_status', arguments: {} } }] } }
    }
  };
  const res = makeRes();
  await a2aHandler(req, res);
  await flushAsync();

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, -32603);
  assert.equal(res.body.error.message, 'Internal server error');

  const inserts = errorLogCalls.filter((c) => c.method === 'POST');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].body.route, '/api/a2a');
  assert.equal(inserts[0].body.category, 'js_error');
  assert.equal(inserts[0].body.status, 500);
});

// --- normal, non-error outcomes are never logged ---

test('check_wallet_age: 60 normal calls (found:false) plus a 61st rate-limited ("429-equivalent") call log nothing', async (t) => {
  withSupabaseEnv(t);
  withAlchemyEnv(t);
  const errorLogCalls = installFetchMock(t, [alchemyFoundFalseRoute(), walletFirstSeenMiss]);

  const headers = { 'x-forwarded-for': '203.0.113.50' };
  for (let i = 0; i < 60; i++) {
    const res = await callMcpTool('check_wallet_age', { address: ADDRESS }, headers);
    assert.equal(res.statusCode, 200);
    assert.notEqual(res.body.result.isError, true, `call ${i + 1} should not be rate-limited yet`);
  }

  const limited = await callMcpTool('check_wallet_age', { address: ADDRESS }, headers);
  assert.equal(limited.statusCode, 200);
  assert.equal(limited.body.result.isError, true);
  const parsed = JSON.parse(limited.body.result.content[0].text);
  assert.equal(parsed.code, 'rate_limited');

  assert.equal(errorLogCalls.length, 0, 'neither found:false nor a rate-limited result should ever be logged');
});

test('check_wallet_age: invalid_address and invalid_chain (caller mistakes) are not logged', async (t) => {
  withSupabaseEnv(t);
  const errorLogCalls = installFetchMock(t, [walletFirstSeenMiss]);

  const badAddress = await callMcpTool('check_wallet_age', { address: 'not-an-address' });
  assert.equal(JSON.parse(badAddress.body.result.content[0].text).code, 'invalid_address');

  const badChain = await callMcpTool('check_wallet_age', { address: ADDRESS, chain: 'solana' });
  assert.equal(JSON.parse(badChain.body.result.content[0].text).code, 'invalid_chain');

  assert.equal(errorLogCalls.length, 0);
});

test('a2a: an unknown skill (-32602), unsupported method (-32601), and a parse error (-32700) are not logged', async (t) => {
  withSupabaseEnv(t);
  const errorLogCalls = installFetchMock(t, []);

  const unknownSkill = await callA2aSkill('not_a_real_skill', {});
  assert.equal(unknownSkill.body.error.code, -32602);

  const unsupportedMethod = await a2aHandler(
    { method: 'POST', headers: {}, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} } },
    makeRes()
  );

  const parseError = makeRes();
  await a2aHandler({ method: 'POST', headers: {}, query: {}, body: 'not-json{' }, parseError);
  assert.equal(parseError.body.error.code, -32700);

  assert.equal(errorLogCalls.length, 0);
});

test('mcp: an unknown tool (-32602) and an unknown method (-32601) are not logged', async (t) => {
  withSupabaseEnv(t);
  const errorLogCalls = installFetchMock(t, []);

  const unknownTool = await callMcpTool('not_a_real_tool', {});
  assert.equal(unknownTool.body.error.code, -32602);

  const req = { method: 'POST', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'not/a/real/method', params: {} } };
  const res = makeRes();
  await mcpHandler(req, res);
  assert.equal(res.body.error.code, -32601);

  assert.equal(errorLogCalls.length, 0);
});

test('mcp: a 402 (missing license key on a license-only tool) is not logged', async (t) => {
  withSupabaseEnv(t);
  const errorLogCalls = installFetchMock(t, []);

  const res = await callMcpTool('subscribe_alerts', { webhook_url: 'https://example.com/hook' });
  assert.equal(res.statusCode, 402);
  assert.equal(errorLogCalls.length, 0);
});

// --- fire-and-forget: logging never slows down or changes the response ---

test('check_wallet_age: a logger whose fetch hangs forever does not delay or change the tool response', async (t) => {
  withSupabaseEnv(t);
  withoutAlchemyEnv(t);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/rest/v1/wallet_first_seen')) return { ok: true, json: async () => [] };
    if (urlStr.includes('/rest/v1/pg1_errors')) return new Promise(() => {}); // never resolves
    throw new Error('unexpected fetch: ' + urlStr);
  };
  t.after(() => { global.fetch = originalFetch; });

  const start = Date.now();
  const res = await callMcpTool('check_wallet_age', { address: ADDRESS }, { 'x-forwarded-for': '203.0.113.60' });
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < 500, `expected a near-instant response, took ${elapsedMs}ms`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  assert.equal(JSON.parse(res.body.result.content[0].text).code, 'upstream_unavailable');
});

test('check_wallet_age: a logger whose fetch throws synchronously does not affect the tool response', async (t) => {
  withSupabaseEnv(t);
  withoutAlchemyEnv(t);
  const originalFetch = global.fetch;
  global.fetch = (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/rest/v1/wallet_first_seen')) return Promise.resolve({ ok: true, json: async () => [] });
    if (urlStr.includes('/rest/v1/pg1_errors')) throw new Error('logger backend is down');
    throw new Error('unexpected fetch: ' + urlStr);
  };
  t.after(() => { global.fetch = originalFetch; });

  const res = await callMcpTool('check_wallet_age', { address: ADDRESS }, { 'x-forwarded-for': '203.0.113.61' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  assert.equal(JSON.parse(res.body.result.content[0].text).code, 'upstream_unavailable');
});
