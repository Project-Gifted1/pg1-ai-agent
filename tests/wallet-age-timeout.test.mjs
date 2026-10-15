/**
 * Tests for api/mcp.mjs — check_wallet_age's upstream timeout and retry:
 * the per-attempt upstream timeout is 5000ms by default, configurable with
 * WALLET_AGE_UPSTREAM_TIMEOUT_MS; every upstream timer is cut to the total
 * budget (WALLET_AGE_TOTAL_BUDGET_MS, default 2500ms, under the 30s
 * maxDuration); a transfer-history timeout gets at most ONE retry, only
 * inside that budget, and the retry's own timeout is cut to what is left of
 * it; when the budget runs out, whatever part of the transfer history did
 * answer is returned as a partial age (WALLET_AGE_PARTIAL, status
 * "unknown", never cached), otherwise the same upstream_unavailable /
 * status "unknown" error, never a guessed age; and the MCP tool definitions
 * are hash-identical to the ones before this change.
 * Run with: node --test tests/wallet-age-timeout.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// Definition drift is checked on TOOL_DEFINITIONS (every defined tool, switched
// off or not): a tool hidden by a flag (PG1_ALERTS) keeps its definition.
import handler, { TOOL_DEFINITIONS as TOOLS, config } from '../api/mcp.mjs';
import { FIXTURE_VALUES } from '../lib/fixtures.mjs';

const ADDRESS = '0x' + 'b'.repeat(40);
const OLD_IN_TRANSFER = [{ metadata: { blockTimestamp: '2022-02-02T00:00:00.000Z' }, blockNum: '0x2' }];
const DELEGATION_RPC_ID = 4;

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
}

async function callTool(args) {
  const res = makeRes();
  await handler({
    method: 'POST',
    headers: {},
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_wallet_age', arguments: args } }
  }, res);
  assert.equal(res.statusCode, 200);
  return { res, parsed: JSON.parse(res.body.result.content[0].text) };
}

// Sets env vars for one test, restoring them afterwards.
function withEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

function baseEnv(t, extra = {}) {
  withEnv(t, {
    ALCHEMY_API_KEY: 'test-alchemy-key',
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    WALLET_AGE_UPSTREAM_TIMEOUT_MS: undefined,
    WALLET_AGE_TOTAL_BUDGET_MS: undefined,
    ...extra
  });
}

function abortable(signal, delayMs, value) {
  return new Promise((resolve, reject) => {
    const timer = delayMs === Infinity ? null : setTimeout(() => resolve(value), delayMs);
    signal?.addEventListener('abort', () => {
      if (timer) clearTimeout(timer);
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

// Alchemy mock. An "attempt" is one round of transfer-history lookups,
// counted by its plain-arm outbound getAssetTransfers call (the first call
// of every attempt). `historyDelay(attempt, isInternal)` gives the delay in
// ms before a transfer-history call (getAssetTransfers or the id-3
// getCode) answers, Infinity to hang until aborted; `historyError(attempt)`
// makes that attempt's plain arm fail with an HTTP 500 instead.
// `delegationDelay` does the same for the id-4 delegation getCode.
function mockAlchemy(t, { historyDelay = () => 0, historyError = () => false, delegationDelay = 0 } = {}) {
  const state = { attempts: 0, attemptAbortedAt: [], startedAt: Date.now() };
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    if (body.method === 'eth_getCode' && body.id === DELEGATION_RPC_ID) {
      return abortable(options.signal, delegationDelay, { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x' }) });
    }
    const params = body.method === 'alchemy_getAssetTransfers' ? body.params[0] : null;
    const isInternal = !!params && params.category.includes('internal');
    if (params && params.fromAddress && !isInternal) {
      state.attempts += 1;
      const n = state.attempts;
      options.signal?.addEventListener('abort', () => { state.attemptAbortedAt[n] = Date.now() - state.startedAt; });
    }
    const attempt = state.attempts;
    if (!isInternal && historyError(attempt)) return { ok: false, status: 500, json: async () => ({}) };
    let result;
    if (body.method === 'eth_getCode') result = '0x';
    else result = { transfers: params.fromAddress ? [] : OLD_IN_TRANSFER };
    return abortable(options.signal, historyDelay(attempt, isInternal), { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) });
  };
  t.after(() => { global.fetch = original; });
  return state;
}

function assertUnknownTimeout(res, parsed, ms) {
  assert.equal(res.body.result.isError, true);
  assert.equal(parsed.code, 'upstream_unavailable');
  assert.equal(parsed.message, `Wallet age lookup timed out after ${ms}ms.`);
  assert.equal(parsed.status, 'unknown');
  assert.deepEqual(parsed.reasons, []);
  assert.equal(parsed.checks.length, 1);
  assert.equal(parsed.checks[0].result, 'timeout');
  // Never a guessed age.
  for (const key of ['found', 'first_seen', 'age_days', 'first_seen_block', 'first_direction']) {
    assert.equal(parsed[key], undefined, `${key} must not appear on a failed lookup`);
  }
}

test('wallet age timeout: a slow (2.6s) upstream succeeds when the budget is raised above the 2500ms default, with no retry', async (t) => {
  baseEnv(t, { WALLET_AGE_TOTAL_BUDGET_MS: '12000' });
  const state = mockAlchemy(t, { historyDelay: () => 2600 });
  const started = Date.now();
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  const elapsed = Date.now() - started;
  assert.notEqual(res.body.result.isError, true);
  assert.equal(parsed.found, true);
  assert.equal(parsed.first_seen, '2022-02-02T00:00:00.000Z');
  assert.equal(parsed.delegated, false);
  assert.equal(state.attempts, 1);
  assert.ok(elapsed >= 2600 && elapsed < 4000, `took ${elapsed}ms`);
});

test('wallet age timeout: a hung upstream still returns upstream_unavailable / status "unknown", timed out at the default 5000ms', async (t) => {
  // A budget too small for a retry after the first 5000ms attempt.
  baseEnv(t, { WALLET_AGE_TOTAL_BUDGET_MS: '5500' });
  const state = mockAlchemy(t, { historyDelay: () => Infinity, delegationDelay: Infinity });
  const started = Date.now();
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  const elapsed = Date.now() - started;
  assertUnknownTimeout(res, parsed, 5000);
  assert.equal(state.attempts, 1, 'no retry when the remaining budget is under the minimum');
  assert.ok(state.attemptAbortedAt[1] >= 4900 && state.attemptAbortedAt[1] < 5400, `first attempt aborted at ${state.attemptAbortedAt[1]}ms`);
  assert.ok(elapsed < 6000, `took ${elapsed}ms`);
});

test('wallet age timeout: WALLET_AGE_UPSTREAM_TIMEOUT_MS overrides the timeout, and a first-attempt timeout is retried once and can succeed', async (t) => {
  baseEnv(t, { WALLET_AGE_UPSTREAM_TIMEOUT_MS: '300', WALLET_AGE_TOTAL_BUDGET_MS: '2000' });
  const state = mockAlchemy(t, { historyDelay: (attempt) => (attempt === 1 ? Infinity : 20) });
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  assert.notEqual(res.body.result.isError, true);
  assert.equal(parsed.found, true);
  assert.equal(parsed.first_seen, '2022-02-02T00:00:00.000Z');
  assert.equal(state.attempts, 2);
  assert.ok(state.attemptAbortedAt[1] >= 280 && state.attemptAbortedAt[1] < 700, `first attempt aborted at ${state.attemptAbortedAt[1]}ms`);
});

test('wallet age timeout: at most ONE retry - a second timeout returns status "unknown", never a third attempt', async (t) => {
  // Budget of 5000ms would fit many 300ms attempts; only one retry is allowed.
  baseEnv(t, { WALLET_AGE_UPSTREAM_TIMEOUT_MS: '300', WALLET_AGE_TOTAL_BUDGET_MS: '5000' });
  const state = mockAlchemy(t, { historyDelay: () => Infinity });
  const started = Date.now();
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  const elapsed = Date.now() - started;
  assertUnknownTimeout(res, parsed, 300);
  assert.equal(state.attempts, 2);
  assert.ok(elapsed < 1500, `took ${elapsed}ms`);
});

test('wallet age timeout: at most one retry on an internal-supporting chain too (both arms timing out)', async (t) => {
  baseEnv(t, { WALLET_AGE_UPSTREAM_TIMEOUT_MS: '300', WALLET_AGE_TOTAL_BUDGET_MS: '5000' });
  const state = mockAlchemy(t, { historyDelay: () => Infinity });
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'base' });
  assertUnknownTimeout(res, parsed, 300);
  assert.equal(state.attempts, 2);
});

test('wallet age timeout: no retry when the remaining budget is too small', async (t) => {
  baseEnv(t, { WALLET_AGE_UPSTREAM_TIMEOUT_MS: '300', WALLET_AGE_TOTAL_BUDGET_MS: '450' });
  const state = mockAlchemy(t, { historyDelay: () => Infinity });
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  assertUnknownTimeout(res, parsed, 300);
  assert.equal(state.attempts, 1);
});

test('wallet age timeout: the retry is cut to the remaining budget and never runs past it', async (t) => {
  // First attempt 1500ms, leaving ~1300ms (>= the 1000ms minimum): the
  // retry gets ~1300ms, not a full 1500ms, so the call ends at the budget.
  baseEnv(t, { WALLET_AGE_UPSTREAM_TIMEOUT_MS: '1500', WALLET_AGE_TOTAL_BUDGET_MS: '2800' });
  const state = mockAlchemy(t, { historyDelay: () => Infinity });
  const started = Date.now();
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  const elapsed = Date.now() - started;
  assertUnknownTimeout(res, parsed, 1500);
  assert.equal(state.attempts, 2);
  assert.ok(state.attemptAbortedAt[2] <= 2800 + 100, `retry aborted at ${state.attemptAbortedAt[2]}ms, past the 2800ms budget`);
  assert.ok(elapsed < 2800 + 200, `took ${elapsed}ms`);
});

test('wallet age timeout: an upstream error (not a timeout) is never retried', async (t) => {
  baseEnv(t, { WALLET_AGE_UPSTREAM_TIMEOUT_MS: '300', WALLET_AGE_TOTAL_BUDGET_MS: '5000' });
  const state = mockAlchemy(t, { historyError: () => true });
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  assert.equal(res.body.result.isError, true);
  assert.equal(parsed.code, 'upstream_unavailable');
  assert.equal(parsed.message, 'Wallet age lookup failed: upstream on-chain data source unavailable.');
  assert.equal(parsed.status, 'unknown');
  assert.equal(state.attempts, 1);
});

test('wallet age timeout: an internal-only timeout keeps the partial answer with its note, with no retry', async (t) => {
  baseEnv(t, { WALLET_AGE_UPSTREAM_TIMEOUT_MS: '300', WALLET_AGE_TOTAL_BUDGET_MS: '5000' });
  const state = mockAlchemy(t, { historyDelay: (attempt, isInternal) => (isInternal ? Infinity : 0) });
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'base' });
  assert.notEqual(res.body.result.isError, true);
  assert.equal(parsed.found, true);
  assert.equal(parsed.note, 'Internal transfers were not checked in time; the wallet may be older than shown.');
  assert.equal(state.attempts, 1);
});

test('wallet age timeout: a delegation-check timeout is never retried and never fails the age answer', async (t) => {
  baseEnv(t, { WALLET_AGE_UPSTREAM_TIMEOUT_MS: '300', WALLET_AGE_TOTAL_BUDGET_MS: '5000' });
  const state = mockAlchemy(t, { delegationDelay: Infinity });
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  assert.notEqual(res.body.result.isError, true);
  assert.equal(parsed.found, true);
  assert.equal(parsed.delegated, null);
  assert.equal(parsed.checks.find((c) => c.source === 'on-chain code')?.result, 'timeout');
  assert.equal(state.attempts, 1);
});

test('wallet age timeout: an invalid or out-of-range env value falls back to / clamps within safe limits', async (t) => {
  // The UNKNOWN fixture reports the configured timeout in its message
  // without any upstream call.
  // A budget above the 10000ms clamp, so the per-attempt figure shows through.
  for (const [raw, expected] of [[undefined, 5000], ['abc', 5000], ['', 5000], ['-5', 100], ['999999', 10000], ['7000', 7000]]) {
    baseEnv(t, { WALLET_AGE_UPSTREAM_TIMEOUT_MS: raw, WALLET_AGE_TOTAL_BUDGET_MS: '20000' });
    const { parsed } = await callTool({ address: FIXTURE_VALUES.wallet.UNKNOWN });
    assert.equal(parsed.message, `Wallet age lookup timed out after ${expected}ms.`, `env ${JSON.stringify(raw)}`);
    assert.equal(parsed.code, 'upstream_unavailable');
    assert.equal(parsed.status, 'unknown');
  }
});

test('wallet age timeout: the reported timeout is the per-attempt timeout cut to the total budget', async (t) => {
  for (const [timeout, budget, expected] of [[undefined, undefined, 2500], ['1000', undefined, 1000], [undefined, '4000', 4000], [undefined, 'abc', 2500], [undefined, '99999', 5000]]) {
    baseEnv(t, { WALLET_AGE_UPSTREAM_TIMEOUT_MS: timeout, WALLET_AGE_TOTAL_BUDGET_MS: budget });
    const { parsed } = await callTool({ address: FIXTURE_VALUES.wallet.UNKNOWN });
    assert.equal(parsed.message, `Wallet age lookup timed out after ${expected}ms.`, `timeout ${timeout}, budget ${budget}`);
  }
});

test('wallet age timeout: the function limit still leaves 10s+ of margin over the 20000ms budget cap', () => {
  // WALLET_AGE_TOTAL_BUDGET_MS defaults to 12000ms and is clamped to 20000ms
  // in api/mcp.mjs; that only holds as margin while maxDuration stays 30s.
  assert.ok(config.maxDuration >= 30, `maxDuration is ${config.maxDuration}s`);
});

// SHA-256 of JSON.stringify(TOOLS) and of the check_wallet_age entry, taken
// from api/mcp.mjs before this change: field names, descriptions and the
// MCP tool definitions must stay byte-identical.
const TOOLS_SHA256 = '9785649dc3f438b3e4bcd06b63b123b28288b4312562c5e81c02d4f613f13837';
const WALLET_AGE_TOOL_SHA256 = '16fafc99e96925c027cd660b9564e8fe5edffb5a512d504bf12bcc8cf312189d';

test('wallet age timeout: MCP tool definitions are hash-identical to before', async () => {
  const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
  // check_package (1.17.0) was added after this pin, at the end of the list.
  // Moved again by Phase 2's EPSS switch (the three CVE descriptions, see
  // tests/source-policy.test.mjs EPSS_DESCRIPTION_EDITS), and by the free
  // feed (get_threat_indicators, FREE_FEED_EDITS there).
  assert.equal(sha(TOOLS.filter((t) => t.name !== 'check_package' && !['preflight_check', 'check_x402_endpoint', 'check_agent_card', 'verify_result', 'hosting_advisor'].includes(t.name))), TOOLS_SHA256);
  assert.equal(sha(TOOLS.find((t) => t.name === 'check_wallet_age')), WALLET_AGE_TOOL_SHA256);
});

// ---------------------------------------------------------------------
// 2.5s default budget and the partial age fallback
// ---------------------------------------------------------------------

// Per-call Alchemy mock: `delays` gives ms (Infinity hangs until aborted)
// for each call kind - 'out' / 'in' (getAssetTransfers by direction, with a
// `-internal` suffix for the internal-inclusive arm, which falls back to
// the plain kind's entry when not given), 'code' (id-3
// getCode, `code-internal` likewise) and 'delegation' (id-4 getCode).
// `results` overrides a call's result. Supabase cache traffic is recorded.
function mockPerCall(t, { delays = {}, results = {} } = {}) {
  const state = { calls: [], cacheWrites: 0 };
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes('/rest/v1/wallet_first_seen')) {
      if (options.method === 'POST') state.cacheWrites += 1;
      return { ok: true, json: async () => [] };
    }
    const body = JSON.parse(options.body);
    let kind;
    if (body.method === 'eth_getCode') kind = body.id === DELEGATION_RPC_ID ? 'delegation' : 'code';
    else kind = body.params[0].fromAddress ? 'out' : 'in';
    const internal = body.method === 'alchemy_getAssetTransfers' && body.params[0].category.includes('internal');
    // Which arm a getCode belongs to is not visible in the request; both
    // arms share the 'code' delay unless `code-internal` is given.
    const key = internal ? `${kind}-internal` : kind;
    state.calls.push(key);
    let result = results[key] ?? results[kind];
    if (result === undefined) {
      if (kind === 'out') result = { transfers: [] };
      else if (kind === 'in') result = { transfers: OLD_IN_TRANSFER };
      else result = '0x';
    }
    return abortable(options.signal, delays[key] ?? delays[kind] ?? 0, { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) });
  };
  t.after(() => { global.fetch = original; });
  return state;
}

test('wallet age budget: a hung upstream times out at the 2500ms default budget, with no retry', async (t) => {
  baseEnv(t);
  const state = mockAlchemy(t, { historyDelay: () => Infinity, delegationDelay: Infinity });
  const started = Date.now();
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  const elapsed = Date.now() - started;
  assertUnknownTimeout(res, parsed, 2500);
  assert.equal(state.attempts, 1);
  assert.ok(state.attemptAbortedAt[1] >= 2400 && state.attemptAbortedAt[1] < 2800, `aborted at ${state.attemptAbortedAt[1]}ms`);
  assert.ok(elapsed < 3000, `took ${elapsed}ms`);
});

test('wallet age budget: a normal (~1s) upstream still answers in full under the default budget', async (t) => {
  baseEnv(t);
  const state = mockPerCall(t, { delays: { out: 1000, in: 1000, code: 1000, delegation: 1000 } });
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  assert.notEqual(res.body.result.isError, true);
  assert.equal(parsed.found, true);
  assert.equal(parsed.note, null);
  assert.equal(parsed.status, 'no_flags');
  assert.deepEqual(parsed.reasons, []);
  assert.equal(state.calls.filter((c) => c === 'out').length, 1);
});

test('wallet age budget: partial fallback - one direction answered with a transfer, the other ran out of budget', async (t) => {
  baseEnv(t, { WALLET_AGE_TOTAL_BUDGET_MS: '400' });
  mockPerCall(t, { delays: { out: Infinity } });
  const started = Date.now();
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  const elapsed = Date.now() - started;
  assert.notEqual(res.body.result.isError, true);
  assert.equal(parsed.found, true);
  assert.equal(parsed.first_seen, '2022-02-02T00:00:00.000Z');
  assert.equal(parsed.first_direction, 'in');
  assert.equal(parsed.first_seen_block, 2);
  assert.equal(parsed.is_contract, false);
  assert.equal(parsed.cached, false);
  assert.equal(parsed.note, 'Part of the transfer history was not checked in time; the wallet may be older than shown.');
  assert.equal(parsed.status, 'unknown');
  assert.deepEqual(parsed.reasons, [{ code: 'WALLET_AGE_PARTIAL', message: 'Part of the transfer history was not checked in time; the wallet may be older than shown.' }]);
  assert.deepEqual(parsed.checks.map((c) => [c.source, c.result]), [
    ['on-chain transfer history', 'ok'],
    ['on-chain transfer history (remaining lookups)', 'timeout'],
    ['on-chain code', 'ok']
  ]);
  assert.ok(elapsed < 700, `took ${elapsed}ms`);
});

test('wallet age budget: a partial age is never written to the permanent cache', async (t) => {
  baseEnv(t, { WALLET_AGE_TOTAL_BUDGET_MS: '400', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key' });
  const state = mockPerCall(t, { delays: { out: Infinity } });
  const { parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  assert.equal(parsed.found, true);
  assert.equal(state.cacheWrites, 0);
});

test('wallet age budget: partial fallback across both arms on an internal-supporting chain picks the earliest answered transfer', async (t) => {
  baseEnv(t, { WALLET_AGE_TOTAL_BUDGET_MS: '400' });
  const earlier = [{ metadata: { blockTimestamp: '2020-01-01T00:00:00.000Z' }, blockNum: '0x1' }];
  mockPerCall(t, {
    delays: { in: Infinity, 'in-internal': 0, 'out-internal': Infinity },
    results: { out: { transfers: [] }, 'in-internal': { transfers: earlier } }
  });
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'base' });
  assert.notEqual(res.body.result.isError, true);
  assert.equal(parsed.found, true);
  assert.equal(parsed.first_seen, '2020-01-01T00:00:00.000Z');
  assert.equal(parsed.first_direction, 'in');
  assert.equal(parsed.status, 'unknown');
  assert.deepEqual(parsed.reasons.map((r) => r.code), ['WALLET_AGE_PARTIAL']);
});

test('wallet age budget: no partial fallback when the answered part found no transfer - never found:false on a timeout', async (t) => {
  baseEnv(t, { WALLET_AGE_TOTAL_BUDGET_MS: '400' });
  mockPerCall(t, { delays: { in: Infinity }, results: { out: { transfers: [] } } });
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  assertUnknownTimeout(res, parsed, 400);
});

test('wallet age budget: no partial fallback when is_contract did not answer - never guessed', async (t) => {
  baseEnv(t, { WALLET_AGE_TOTAL_BUDGET_MS: '400' });
  mockPerCall(t, { delays: { out: Infinity, code: Infinity } });
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  assertUnknownTimeout(res, parsed, 400);
});

test('wallet age budget: no partial fallback on an upstream error (only on running out of time)', async (t) => {
  baseEnv(t, { WALLET_AGE_TOTAL_BUDGET_MS: '400' });
  mockPerCall(t, { results: { out: null } });
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    if (body.method === 'alchemy_getAssetTransfers' && body.params[0].fromAddress) return { ok: false, status: 500, json: async () => ({}) };
    return original(url, options);
  };
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  assert.equal(res.body.result.isError, true);
  assert.equal(parsed.code, 'upstream_unavailable');
  assert.equal(parsed.message, 'Wallet age lookup failed: upstream on-chain data source unavailable.');
});

test('wallet age budget: an upstream error still fails at once, not after waiting out the budget', async (t) => {
  baseEnv(t, { WALLET_AGE_TOTAL_BUDGET_MS: '2000' });
  mockPerCall(t, { delays: { in: Infinity, code: Infinity } });
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    if (body.method === 'alchemy_getAssetTransfers' && body.params[0].fromAddress) return { ok: false, status: 500, json: async () => ({}) };
    return original(url, options);
  };
  const started = Date.now();
  const { res, parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  const elapsed = Date.now() - started;
  assert.equal(res.body.result.isError, true);
  assert.equal(parsed.message, 'Wallet age lookup failed: upstream on-chain data source unavailable.');
  // The other two calls hang; the arm must not wait for them.
  assert.ok(elapsed < 500, `took ${elapsed}ms`);
});

test('wallet age budget: the partial fallback keeps a completed delegation check', async (t) => {
  baseEnv(t, { WALLET_AGE_TOTAL_BUDGET_MS: '400' });
  mockPerCall(t, { delays: { out: Infinity }, results: { delegation: '0xef0100' + 'c'.repeat(40) } });
  const { parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  assert.equal(parsed.found, true);
  assert.equal(parsed.delegated, true);
  assert.deepEqual(parsed.reasons.map((r) => r.code), ['WALLET_AGE_PARTIAL', 'WALLET_DELEGATED']);
});

test('wallet age budget: a cached answer\'s delegation check is cut to the remaining budget', async (t) => {
  baseEnv(t, { WALLET_AGE_TOTAL_BUDGET_MS: '300', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key' });
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes('/rest/v1/wallet_first_seen')) {
      return { ok: true, json: async () => [{ address: ADDRESS, chain: 'arbitrum', first_seen: '2022-02-02T00:00:00+00:00', first_seen_block: 2, first_direction: 'in', is_contract: false, checked_at: '2026-01-01T00:00:00+00:00' }] };
    }
    return abortable(options.signal, Infinity);
  };
  t.after(() => { global.fetch = original; });
  const started = Date.now();
  const { parsed } = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  const elapsed = Date.now() - started;
  assert.equal(parsed.cached, true);
  assert.equal(parsed.delegated, null);
  assert.ok(elapsed < 700, `took ${elapsed}ms (the 5000ms per-attempt timeout would have run past the budget)`);
});
