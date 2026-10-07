/**
 * Tests for api/mcp.mjs — check_wallet_age's upstream timeout and retry:
 * the per-attempt upstream timeout is 5000ms by default (was 2500ms, which
 * a ~2.6s slow call tripped), configurable with WALLET_AGE_UPSTREAM_TIMEOUT_MS;
 * a transfer-history timeout gets at most ONE retry, only inside the total
 * budget (WALLET_AGE_TOTAL_BUDGET_MS, default 12000ms, under the 30s
 * maxDuration), and the retry's own timeout is cut to what is left of it;
 * a failure is still the same upstream_unavailable / status "unknown" error,
 * never a guessed age; and the MCP tool definitions are hash-identical to
 * the ones before this change.
 * Run with: node --test tests/wallet-age-timeout.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import handler, { TOOLS, config } from '../api/mcp.mjs';
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

test('wallet age timeout: a slow (2.6s) upstream succeeds under the default 5000ms timeout, with no retry', async (t) => {
  baseEnv(t);
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
  for (const [raw, expected] of [[undefined, 5000], ['abc', 5000], ['', 5000], ['-5', 100], ['999999', 10000], ['7000', 7000]]) {
    baseEnv(t, { WALLET_AGE_UPSTREAM_TIMEOUT_MS: raw });
    const { parsed } = await callTool({ address: FIXTURE_VALUES.wallet.UNKNOWN });
    assert.equal(parsed.message, `Wallet age lookup timed out after ${expected}ms.`, `env ${JSON.stringify(raw)}`);
    assert.equal(parsed.code, 'upstream_unavailable');
    assert.equal(parsed.status, 'unknown');
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
const TOOLS_SHA256 = '10c3d9969cf1c595717ed826a882c3b22c4b3c05938d2bb4158a0e3310c4855a';
const WALLET_AGE_TOOL_SHA256 = '16fafc99e96925c027cd660b9564e8fe5edffb5a512d504bf12bcc8cf312189d';

test('wallet age timeout: MCP tool definitions are hash-identical to before', async () => {
  const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
  assert.equal(sha(TOOLS), TOOLS_SHA256);
  assert.equal(sha(TOOLS.find((t) => t.name === 'check_wallet_age')), WALLET_AGE_TOOL_SHA256);
});
