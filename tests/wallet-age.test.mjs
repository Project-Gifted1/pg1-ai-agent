/**
 * Tests for api/mcp.mjs — check_wallet_age (issue #209, plus the issue #211
 * parallel-lookup fix): earliest on-chain transfer in/out resolution,
 * no-history found:false, upstream timeout/failure as isError (never
 * found:false), input validation, the permanent found-result cache and the
 * 10-minute found:false cache TTL, the uncached fallback when the
 * wallet_first_seen table is missing, that no raw upstream (Alchemy) fields
 * ever leak into a response, that the 13 pre-existing tool definitions are
 * unchanged, that the non-internal and internal-inclusive lookups run in
 * parallel (taking the earliest of the two on success, falling back to
 * whichever one lands with a note if only one does, and never writing a
 * partial result to the permanent cache), and that cached and fresh
 * first_seen strings are byte-identical regardless of how Postgres
 * round-trips the timestamp.
 * Run with: node --test tests/wallet-age.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStatus } from '../lib/responseMeta.mjs';
import { INFORMATIONAL_REASON_CODES } from '../lib/reasonCodes.mjs';
import handler, { TOOLS, RESPONSE_META_OUTPUT_PROPERTIES, TEST_FIXTURE_OUTPUT_PROPERTIES, parseWalletDelegation } from '../api/mcp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function makeReq(args, extraHeaders) {
  return {
    method: 'POST',
    headers: extraHeaders || {},
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_wallet_age', arguments: args } }
  };
}

async function callTool(args, extraHeaders) {
  const req = makeReq(args, extraHeaders);
  const res = makeRes();
  await handler(req, res);
  return res;
}

function withAlchemyEnv(t) {
  const prev = process.env.ALCHEMY_API_KEY;
  process.env.ALCHEMY_API_KEY = 'test-alchemy-key';
  t.after(() => {
    if (prev === undefined) delete process.env.ALCHEMY_API_KEY; else process.env.ALCHEMY_API_KEY = prev;
  });
}

function withSupabaseEnv(t) {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  t.after(() => {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });
}

function withoutSupabaseEnv(t) {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });
}

const ADDRESS = '0x' + 'a'.repeat(40);

// The delegation check's JSON-RPC id (the age lookups use 1, 2 and 3).
const DELEGATION_RPC_ID = 4;
const DELEGATE = '0x' + '1234567890abcdef'.repeat(2) + '12345678';
const DELEGATED_CODE = '0xef0100' + DELEGATE.slice(2);

function hangUntilAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal) {
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    }
  });
}

// Routes Alchemy JSON-RPC calls (alchemy_getAssetTransfers x2, eth_getCode)
// and Supabase wallet_first_seen reads/writes. `cacheRows` seeds the GET
// response; `onWrite` observes each upsert body; `tableMissing` simulates
// the cache table not existing yet.
//
// On a chain in WALLET_AGE_INTERNAL_SUPPORTED_CHAINS, handleCheckWalletAge
// runs a non-internal ("plain") lookup and an internal-inclusive lookup in
// parallel. Given the implementation's fixed call order (plain out, plain
// in, plain eth_getCode, then internal out, internal in, internal
// eth_getCode), a getAssetTransfers call belongs to the internal arm once
// it's the 3rd/4th such call, and an eth_getCode call belongs to the
// internal arm once it's the 2nd such call — that's what `isInternalArm`
// below tracks. `internalOutTransfers`/`internalInTransfers` let a test give
// the internal arm a different (e.g. earlier) result than the plain arm's
// `outTransfers`/`inTransfers`; `hangInternal`/`hangPlain` make only that
// arm's calls hang until the AbortController fires; `rejectInternalCategory`
// simulates Alchemy rejecting the internal arm's category list outright;
// `failPlainTransfers` makes the plain arm's getAssetTransfers calls fail
// too, for exercising "both arms fail".
function makeFetchMock({
  outTransfers = [], inTransfers = [], code = '0x',
  internalOutTransfers, internalInTransfers, internalCode,
  cacheRows = [], tableMissing = false, onWrite, onAlchemyCall,
  hang = false, hangPlain = false, hangInternal = false,
  rejectInternalCategory = false, failPlainTransfers = false,
  delegationCode, delegationResponse, hangDelegation = false, onDelegationCall
} = {}) {
  let ethGetCodeCalls = 0;
  let transferCalls = 0;
  return async (url, options = {}) => {
    const urlStr = String(url);

    if (urlStr.includes('.g.alchemy.com/v2/')) {
      if (onAlchemyCall) onAlchemyCall();
      const body = JSON.parse(options.body);
      // The live EIP-7702 delegation check is its own eth_getCode with a
      // distinct JSON-RPC id, routed here before the plain/internal arm
      // counting below so it never shifts which arm a call belongs to.
      // `delegationCode` defaults to `code`; `delegationResponse` replaces
      // the whole response (for failures); `hangDelegation` hangs it until
      // the AbortController fires.
      if (body.method === 'eth_getCode' && body.id === DELEGATION_RPC_ID) {
        if (onDelegationCall) onDelegationCall(body, options);
        if (hang || hangDelegation) return hangUntilAbort(options.signal);
        if (delegationResponse) return delegationResponse;
        const useCode = delegationCode !== undefined ? delegationCode : code;
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: useCode }) };
      }
      const isEthGetCode = body.method === 'eth_getCode';
      let isInternalArm;
      if (isEthGetCode) {
        ethGetCodeCalls += 1;
        isInternalArm = ethGetCodeCalls > 1;
      } else {
        transferCalls += 1;
        isInternalArm = transferCalls > 2;
      }

      if (hang || (hangPlain && !isInternalArm) || (hangInternal && isInternalArm)) {
        return new Promise((resolve, reject) => {
          const signal = options.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }

      if (isEthGetCode) {
        const useCode = isInternalArm && internalCode !== undefined ? internalCode : code;
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: useCode }) };
      }
      if (body.method === 'alchemy_getAssetTransfers') {
        const params = body.params[0];
        const isOut = !!params.fromAddress;
        const categories = params.category || [];
        if (rejectInternalCategory && isInternalArm && categories.includes('internal')) {
          return {
            ok: true,
            json: async () => ({
              jsonrpc: '2.0', id: body.id,
              error: { code: -32602, message: "Categories ['internal'] are not supported for this network." }
            })
          };
        }
        if (failPlainTransfers && !isInternalArm) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        const outArr = isInternalArm && internalOutTransfers !== undefined ? internalOutTransfers : outTransfers;
        const inArr = isInternalArm && internalInTransfers !== undefined ? internalInTransfers : inTransfers;
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { transfers: isOut ? outArr : inArr } }) };
      }
      throw new Error('unexpected alchemy method: ' + body.method);
    }

    if (urlStr.includes('/rest/v1/wallet_first_seen')) {
      if (tableMissing) {
        return { ok: false, status: 404, json: async () => ({ message: 'relation "wallet_first_seen" does not exist' }) };
      }
      if (options.method === 'POST') {
        const parsed = JSON.parse(options.body);
        if (onWrite) onWrite(parsed);
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => cacheRows };
    }

    throw new Error('unexpected fetch: ' + urlStr);
  };
}

test('check_wallet_age: in-only transfer history resolves first_direction "in"', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({
    inTransfers: [{ metadata: { blockTimestamp: '2024-01-01T00:00:00.000Z' }, blockNum: '0x64' }],
    outTransfers: []
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ address: ADDRESS });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.found, true);
  assert.equal(parsed.first_direction, 'in');
  assert.equal(parsed.first_seen, '2024-01-01T00:00:00.000Z');
  assert.equal(parsed.first_seen_block, 100);
  assert.equal(parsed.is_contract, false);
  assert.equal(parsed.source, 'on-chain transfer history');
  assert.equal(parsed.cached, false);
  assert.ok(typeof parsed.age_days === 'number' && parsed.age_days >= 0);
});

test('check_wallet_age: out-only transfer history resolves first_direction "out"', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({
    outTransfers: [{ metadata: { blockTimestamp: '2023-05-05T00:00:00.000Z' }, blockNum: '0x1' }],
    inTransfers: [],
    code: '0x6080604052'
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ address: ADDRESS, chain: 'ethereum' });
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.found, true);
  assert.equal(parsed.first_direction, 'out');
  assert.equal(parsed.first_seen_block, 1);
  assert.equal(parsed.is_contract, true);
  assert.equal(parsed.chain, 'ethereum');
});

test('check_wallet_age: earliest of both in and out transfers wins', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({
    outTransfers: [{ metadata: { blockTimestamp: '2024-06-01T00:00:00.000Z' }, blockNum: '0x10' }],
    inTransfers: [{ metadata: { blockTimestamp: '2024-01-01T00:00:00.000Z' }, blockNum: '0x5' }]
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ address: ADDRESS });
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.first_direction, 'in');
  assert.equal(parsed.first_seen, '2024-01-01T00:00:00.000Z');
  assert.equal(parsed.first_seen_block, 5);
});

test('check_wallet_age: no transfers at all returns found:false, nulls, and a note — not an error', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({ outTransfers: [], inTransfers: [], code: '0x' });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ address: ADDRESS });
  assert.equal(res.statusCode, 200);
  assert.notEqual(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.found, false);
  assert.equal(parsed.first_seen, null);
  assert.equal(parsed.age_days, null);
  assert.equal(parsed.first_seen_block, null);
  assert.equal(parsed.first_direction, null);
  assert.equal(parsed.is_contract, false);
  assert.equal(typeof parsed.note, 'string');
  assert.match(parsed.note, /no transfer history/i);
});

test('check_wallet_age: upstream timeout returns an MCP isError result, never found:false', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({ hang: true });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ address: ADDRESS });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'upstream_unavailable');
  assert.notEqual(parsed.found, false);
});

test('check_wallet_age: invalid address is rejected with isError invalid_address', async (t) => {
  const res = await callTool({ address: 'not-an-address' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'invalid_address');
});

test('check_wallet_age: invalid chain is rejected with isError invalid_chain', async (t) => {
  const res = await callTool({ address: ADDRESS, chain: 'solana' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'invalid_chain');
});

test('check_wallet_age: a found result is cached and a repeat call skips the age lookups, but still runs a live delegation check', async (t) => {
  withAlchemyEnv(t);
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  let storedRow = null;
  let alchemyCalls = 0;
  let delegationCalls = 0;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (urlStr.includes('/rest/v1/wallet_first_seen') && (!options || options.method !== 'POST')) {
      return { ok: true, json: async () => (storedRow ? [storedRow] : []) };
    }
    if (urlStr.includes('/rest/v1/wallet_first_seen') && options.method === 'POST') {
      storedRow = JSON.parse(options.body);
      return { ok: true, json: async () => [] };
    }
    if (urlStr.includes('.g.alchemy.com/v2/')) {
      const body = JSON.parse(options.body);
      if (body.id === DELEGATION_RPC_ID) {
        delegationCalls += 1;
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: delegationCalls === 1 ? '0x' : DELEGATED_CODE }) };
      }
      alchemyCalls += 1;
      if (body.method === 'eth_getCode') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x' }) };
      const isOut = !!body.params[0].fromAddress;
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0', id: body.id,
          result: { transfers: isOut ? [] : [{ metadata: { blockTimestamp: '2022-02-02T00:00:00.000Z' }, blockNum: '0x2' }] }
        })
      };
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
  t.after(() => { global.fetch = originalFetch; });

  const first = await callTool({ address: ADDRESS, chain: 'base' });
  const firstParsed = JSON.parse(first.body.result.content[0].text);
  assert.equal(firstParsed.found, true);
  assert.equal(firstParsed.cached, false);
  assert.equal(firstParsed.delegated, false);
  const callsAfterFirst = alchemyCalls;
  assert.ok(callsAfterFirst > 0);
  assert.equal(delegationCalls, 1);
  assert.ok(!('delegated' in storedRow) && !('delegate_address' in storedRow), 'delegation must never be written to the cache');

  const second = await callTool({ address: ADDRESS, chain: 'base' });
  const secondParsed = JSON.parse(second.body.result.content[0].text);
  assert.equal(secondParsed.found, true);
  assert.equal(secondParsed.cached, true);
  assert.equal(secondParsed.first_seen, '2022-02-02T00:00:00.000Z');
  assert.equal(alchemyCalls, callsAfterFirst, 'second call should be served from the permanent found-result cache, never re-running the age lookups');
  // The owner added a delegation between the two calls: the cached age
  // answer must reflect it, because delegation is checked live every call.
  assert.equal(delegationCalls, 2, 'a cached age answer must still get a live delegation check');
  assert.equal(secondParsed.delegated, true);
  assert.equal(secondParsed.delegate_address, DELEGATE);
  assert.deepEqual(secondParsed.reasons.map((r) => r.code), ['WALLET_DELEGATED']);
});

test('check_wallet_age: a found:false result is cached for 10 minutes, then re-queried', async (t) => {
  withAlchemyEnv(t);
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  let storedRow = { address: ADDRESS, chain: 'base', first_seen: null, first_seen_block: null, first_direction: null, is_contract: false, checked_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() };
  let alchemyCalls = 0;
  let delegationCalls = 0;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (urlStr.includes('/rest/v1/wallet_first_seen') && (!options || options.method !== 'POST')) {
      return { ok: true, json: async () => [storedRow] };
    }
    if (urlStr.includes('/rest/v1/wallet_first_seen') && options.method === 'POST') {
      storedRow = JSON.parse(options.body);
      return { ok: true, json: async () => [] };
    }
    if (urlStr.includes('.g.alchemy.com/v2/')) {
      const body = JSON.parse(options.body);
      if (body.id === DELEGATION_RPC_ID) {
        delegationCalls += 1;
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x' }) };
      }
      alchemyCalls += 1;
      if (body.method === 'eth_getCode') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x' }) };
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { transfers: [] } }) };
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
  t.after(() => { global.fetch = originalFetch; });

  // Within the 10-minute TTL (checked_at 5 minutes ago): served from cache.
  const withinTtl = await callTool({ address: ADDRESS, chain: 'base' });
  const withinTtlParsed = JSON.parse(withinTtl.body.result.content[0].text);
  assert.equal(withinTtlParsed.found, false);
  assert.equal(withinTtlParsed.cached, true);
  assert.equal(alchemyCalls, 0, 'a not-found result within the 10-minute TTL must not re-run the age lookups');
  assert.equal(delegationCalls, 1, 'a cached not-found answer must still get a live delegation check');
  assert.equal(withinTtlParsed.delegated, false);

  // Expire the cached row (checked_at 11 minutes ago) and retry.
  storedRow = { ...storedRow, checked_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() };
  const expired = await callTool({ address: ADDRESS, chain: 'base' });
  const expiredParsed = JSON.parse(expired.body.result.content[0].text);
  assert.equal(expiredParsed.found, false);
  assert.equal(expiredParsed.cached, false);
  assert.ok(alchemyCalls > 0, 'an expired not-found cache entry must re-query Alchemy');
});

test('check_wallet_age: a missing wallet_first_seen table falls back to working uncached', async (t) => {
  withAlchemyEnv(t);
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({
    inTransfers: [{ metadata: { blockTimestamp: '2021-01-01T00:00:00.000Z' }, blockNum: '0x3' }],
    outTransfers: [],
    tableMissing: true
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ address: ADDRESS });
  assert.equal(res.statusCode, 200);
  assert.notEqual(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.found, true);
  assert.equal(parsed.cached, false);
});

test('check_wallet_age: response never leaks raw upstream fields', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({
    inTransfers: [{
      metadata: { blockTimestamp: '2024-03-03T00:00:00.000Z' },
      blockNum: '0x9',
      // Representative raw Alchemy fields that must never appear in the
      // tool's output — only PG1's own computed fields go out.
      uniqueId: 'abc:log:0', hash: '0xdeadbeef', category: 'external',
      asset: 'ETH', rawContract: { address: null, decimal: '0x12' },
      from: '0xsender', to: ADDRESS, value: 1.5
    }],
    outTransfers: [],
    code: '0x'
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ address: ADDRESS });
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.deepEqual(
    Object.keys(parsed).sort(),
    [
      'address', 'age_days', 'cached', 'chain', 'first_direction', 'first_seen', 'first_seen_block', 'found', 'is_contract', 'note', 'source',
      'delegated', 'delegate_address',
      'reasons', 'status', 'checks', 'request_id'
    ].sort()
  );
  assert.equal(res.body.result.structuredContent && Object.keys(res.body.result.structuredContent).some((k) =>
    ['uniqueId', 'hash', 'category', 'asset', 'rawContract', 'from', 'to', 'value'].includes(k)
  ), false);
});

test("check_wallet_age: requests the 'internal' transfer category on base, ethereum, and polygon, but not on arbitrum, optimism, or bsc", async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const expectations = { base: true, ethereum: true, polygon: true, arbitrum: false, optimism: false, bsc: false };

  for (const [chain, expectInternal] of Object.entries(expectations)) {
    let seenCategories = null;
    global.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('.g.alchemy.com/v2/')) {
        const body = JSON.parse(options.body);
        if (body.method === 'eth_getCode') {
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x' }) };
        }
        seenCategories = body.params[0].category;
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { transfers: [] } }) };
      }
      throw new Error('unexpected fetch: ' + urlStr);
    };

    const res = await callTool({ address: ADDRESS, chain });
    assert.notEqual(res.body.result.isError, true, `chain=${chain}`);
    assert.equal(seenCategories.includes('internal'), expectInternal, `chain=${chain} categories=${JSON.stringify(seenCategories)}`);
  }
});

test('check_wallet_age: on a chain supporting internal transfers, both lookups succeeding takes the earliest across them', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({
    // Plain (non-internal) arm finds a 2024 transfer.
    outTransfers: [{ metadata: { blockTimestamp: '2024-06-01T00:00:00.000Z' }, blockNum: '0x10' }],
    inTransfers: [],
    // Internal arm finds an earlier 2020 internal transfer — this is the one
    // that should win.
    internalOutTransfers: [],
    internalInTransfers: [{ metadata: { blockTimestamp: '2020-01-01T00:00:00.000Z' }, blockNum: '0x2' }]
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ address: ADDRESS, chain: 'base' });
  assert.notEqual(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.found, true);
  assert.equal(parsed.first_seen, '2020-01-01T00:00:00.000Z');
  assert.equal(parsed.first_seen_block, 2);
  assert.equal(parsed.first_direction, 'in');
  assert.equal(parsed.note, null);
  assert.equal(parsed.cached, false);
});

test("check_wallet_age: an internal-only timeout returns the non-internal result with a note, and skips the permanent cache write", async (t) => {
  withAlchemyEnv(t);
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  let wroteToCache = false;
  const alchemyMock = makeFetchMock({
    outTransfers: [],
    inTransfers: [{ metadata: { blockTimestamp: '2023-01-01T00:00:00.000Z' }, blockNum: '0x9' }],
    hangInternal: true
  });
  global.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    if (urlStr.includes('/rest/v1/wallet_first_seen')) {
      if (options.method === 'POST') {
        wroteToCache = true;
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => [] };
    }
    return alchemyMock(url, options);
  };
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ address: ADDRESS, chain: 'base' });
  assert.notEqual(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.found, true);
  assert.equal(parsed.first_seen, '2023-01-01T00:00:00.000Z');
  assert.equal(parsed.cached, false);
  assert.equal(parsed.note, 'Internal transfers were not checked in time; the wallet may be older than shown.');
  assert.equal(wroteToCache, false, 'a partial (internal-not-checked-in-time) result must never be written to the permanent cache');
});

test('check_wallet_age: an internal-category rejection falls back to the non-internal result with a note, not an error', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({
    inTransfers: [{ metadata: { blockTimestamp: '2022-07-07T00:00:00.000Z' }, blockNum: '0x7' }],
    outTransfers: [],
    rejectInternalCategory: true
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ address: ADDRESS, chain: 'base' });
  assert.notEqual(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.found, true);
  assert.equal(parsed.first_direction, 'in');
  assert.equal(parsed.first_seen, '2022-07-07T00:00:00.000Z');
  assert.equal(parsed.first_seen_block, 7);
  assert.match(parsed.note, /internal transfers were not checked/i);
});

test('check_wallet_age: both the non-internal and internal lookups failing returns an isError, never found:false', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({
    rejectInternalCategory: true,
    failPlainTransfers: true
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ address: ADDRESS, chain: 'base' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'upstream_unavailable');
  assert.notEqual(parsed.found, false);
});

test('check_wallet_age: cached and fresh first_seen strings are byte-identical for the same instant', async (t) => {
  withAlchemyEnv(t);
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  // arbitrum doesn't support 'internal', so this exercises the single-arm
  // path for both the fresh lookup and (separately) the cached read.
  global.fetch = makeFetchMock({
    inTransfers: [{ metadata: { blockTimestamp: '2021-03-03T00:00:00.000Z' }, blockNum: '0x3' }],
    outTransfers: []
  });
  const fresh = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  const freshParsed = JSON.parse(fresh.body.result.content[0].text);
  assert.equal(freshParsed.first_seen, '2021-03-03T00:00:00.000Z');

  // Simulate the same instant round-tripping through Postgres with a
  // "+00:00" offset instead of fresh path's ".000Z" suffix.
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (urlStr.includes('/rest/v1/wallet_first_seen') && (!options || options.method !== 'POST')) {
      return {
        ok: true,
        json: async () => [{
          address: ADDRESS, chain: 'arbitrum',
          first_seen: '2021-03-03T00:00:00+00:00',
          first_seen_block: 3, first_direction: 'in', is_contract: false,
          checked_at: new Date().toISOString()
        }]
      };
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
  t.after(() => { global.fetch = originalFetch; });

  const cached = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  const cachedParsed = JSON.parse(cached.body.result.content[0].text);
  assert.equal(cachedParsed.cached, true);
  assert.equal(cachedParsed.first_seen, freshParsed.first_seen, 'cached and fresh first_seen must be byte-identical for the same instant');
  assert.equal(cachedParsed.first_seen, '2021-03-03T00:00:00.000Z');
});

// issue #215, option A (agreed 2026-09-30): the 4 tools that already declare
// an outputSchema gained 4 new OPTIONAL outputSchema.properties entries
// (reasons/status/checks/request_id, shared as RESPONSE_META_OUTPUT_PROPERTIES
// in api/mcp.mjs) so every tool's JSON response can carry them. This is the
// one deliberate, agreed exception to "byte-identical" - everything else
// (name, description, inputSchema, pre-existing output properties, required,
// additionalProperties) must still match exactly, and the 4 new properties
// must never appear in `required`. tests/fixtures/existing-13-tools-snapshot.json
// was updated to bake these 4 properties into the 3 schema'd tools it covers
// (check_wallet_age, the 14th tool, isn't in that fixture at all - it's
// checked separately below against the same shared constant).
//
// issue #215 part B added exactly one more OPTIONAL property to the same 4
// outputSchemas: test_fixture (TEST_FIXTURE_OUTPUT_PROPERTIES), baked into
// the same fixture file. Nothing else in any tool definition may change.
// The two 1.14.0 additions to check_wallet_age's outputSchema, pinned here
// verbatim so any drift in their definition fails this test.
const WALLET_AGE_DELEGATION_OUTPUT_PROPERTIES = {
  delegated: { type: ['boolean', 'null'], description: 'true when the address currently has an EIP-7702 delegation on this chain (its code is exactly 0xef0100 followed by a 20-byte delegate address), false when it does not, null when the code check did not complete. Checked live on every call, never cached. is_contract is unchanged and is still true for a delegated address.' },
  delegate_address: { type: ['string', 'null'], description: 'The lowercased delegate contract address when delegated is true, otherwise null.' }
};

const SCHEMA_TOOLS_WITH_NEW_META = new Set(['check_wallet_sanctions', 'check_domain_age', 'check_hostname_reputation', 'check_wallet_age']);

test('check_wallet_age: is the 14th tool, and the 13 pre-existing tool definitions are unchanged except the agreed optional outputSchema additions', () => {
  assert.equal(TOOLS.length, 14);
  const snapshotPath = path.join(__dirname, 'fixtures', 'existing-13-tools-snapshot.json');
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.equal(snapshot.length, 13);

  for (const expected of snapshot) {
    const actual = TOOLS.find((t) => t.name === expected.name);
    assert.ok(actual, `expected pre-existing tool '${expected.name}' to still be present`);

    if (!SCHEMA_TOOLS_WITH_NEW_META.has(expected.name)) {
      // No outputSchema before, none now - fully byte-identical, no exceptions.
      assert.deepEqual(actual, expected, `tool '${expected.name}' definition drifted - it must stay byte-identical`);
      continue;
    }

    assert.deepEqual(actual.name, expected.name, `tool '${expected.name}' name must not change`);
    assert.deepEqual(actual.description, expected.description, `tool '${expected.name}' description must not change`);
    assert.deepEqual(actual.inputSchema, expected.inputSchema, `tool '${expected.name}' inputSchema must not change`);
    assert.deepEqual(actual.outputSchema.type, expected.outputSchema.type, `tool '${expected.name}' outputSchema.type must not change`);
    assert.deepEqual(actual.outputSchema.required, expected.outputSchema.required, `tool '${expected.name}' outputSchema.required must not change - the new properties must never become required`);
    assert.deepEqual(actual.outputSchema.additionalProperties, expected.outputSchema.additionalProperties, `tool '${expected.name}' outputSchema.additionalProperties must not change`);

    assert.deepEqual(
      Object.keys(actual.outputSchema.properties).sort(),
      Object.keys(expected.outputSchema.properties).sort(),
      `tool '${expected.name}' outputSchema.properties key set must exactly match the fixture (pre-existing properties plus reasons/status/checks/request_id/test_fixture)`
    );
    for (const key of Object.keys(expected.outputSchema.properties)) {
      assert.deepEqual(
        actual.outputSchema.properties[key], expected.outputSchema.properties[key],
        `tool '${expected.name}' outputSchema.properties.${key} drifted from the fixture`
      );
    }
    // Every one of the 4 new properties must match the single shared
    // definition used across all 4 tools, byte-for-byte.
    for (const key of Object.keys(RESPONSE_META_OUTPUT_PROPERTIES)) {
      assert.deepEqual(
        actual.outputSchema.properties[key], RESPONSE_META_OUTPUT_PROPERTIES[key],
        `tool '${expected.name}' outputSchema.properties.${key} doesn't match the shared reasons/status/checks/request_id definition`
      );
    }
    assert.deepEqual(actual.outputSchema.properties.test_fixture, TEST_FIXTURE_OUTPUT_PROPERTIES.test_fixture, `tool '${expected.name}' outputSchema.properties.test_fixture doesn't match the shared definition`);
  }

  // check_wallet_age (the 14th tool) isn't in the 13-tool snapshot fixture,
  // but it's one of the 4 schema'd tools and must carry the exact same 4
  // new optional properties, never in `required`.
  const walletAge = TOOLS.find((t) => t.name === 'check_wallet_age');
  const sharedOptional = { ...RESPONSE_META_OUTPUT_PROPERTIES, ...TEST_FIXTURE_OUTPUT_PROPERTIES };
  for (const key of Object.keys(sharedOptional)) {
    assert.deepEqual(walletAge.outputSchema.properties[key], sharedOptional[key]);
    assert.ok(!walletAge.outputSchema.required.includes(key), `check_wallet_age outputSchema.required must not include '${key}'`);
  }
  // check_wallet_age has no snapshot entry, so pin its exact property set
  // here: its own properties plus the shared optional ones, plus exactly the
  // two optional EIP-7702 delegation properties added in 1.14.0, nothing
  // else.
  assert.deepEqual(
    Object.keys(walletAge.outputSchema.properties).sort(),
    ['address', 'chain', 'found', 'first_seen', 'age_days', 'first_seen_block', 'first_direction', 'is_contract', 'note', 'source', 'cached', ...Object.keys(sharedOptional), ...Object.keys(WALLET_AGE_DELEGATION_OUTPUT_PROPERTIES)].sort()
  );
  for (const [key, schema] of Object.entries(WALLET_AGE_DELEGATION_OUTPUT_PROPERTIES)) {
    assert.deepEqual(walletAge.outputSchema.properties[key], schema, `check_wallet_age outputSchema.properties.${key} must be exactly the 1.14.0 definition`);
  }
  // Optional only: required, type and the pre-existing properties are
  // exactly as they were in 1.13.0 - in particular is_contract.
  assert.deepEqual(walletAge.outputSchema.required, ['address', 'chain', 'found', 'first_seen', 'age_days', 'first_seen_block', 'first_direction', 'is_contract', 'source', 'cached']);
  assert.deepEqual(walletAge.outputSchema.properties.is_contract, { type: 'boolean' });
  assert.equal(walletAge.outputSchema.additionalProperties, undefined);
});


// ---------------------------------------------------------------------
// 1.14.0: EIP-7702 delegation (delegated / delegate_address /
// WALLET_DELEGATED). A delegated EOA's code is exactly 23 bytes: 0xef0100
// followed by the 20-byte delegate address. The check is a live
// eth_getCode on the requested chain, in parallel with the age lookups and
// inside the same 2.5s budget, on every call (cached answers included), and
// never cached. A failed code check is delegated: null, never false, and
// never fails or changes the age answer.
// ---------------------------------------------------------------------

const OLD_IN_TRANSFER = [{ metadata: { blockTimestamp: '2022-02-02T00:00:00.000Z' }, blockNum: '0x2' }];

async function callParsed(args) {
  const res = await callTool(args);
  assert.equal(res.statusCode, 200);
  return { res, parsed: JSON.parse(res.body.result.content[0].text) };
}

test('check_wallet_age delegation: exact 23-byte 0xef0100 code reports delegated true with the delegate address', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({ inTransfers: OLD_IN_TRANSFER, code: DELEGATED_CODE.toUpperCase().replace('0X', '0x') });
  t.after(() => { global.fetch = originalFetch; });

  const { res, parsed } = await callParsed({ address: ADDRESS, chain: 'arbitrum' });
  assert.notEqual(res.body.result.isError, true);
  assert.equal(parsed.found, true);
  assert.equal(parsed.first_seen, '2022-02-02T00:00:00.000Z');
  assert.equal(parsed.delegated, true);
  assert.equal(parsed.delegate_address, DELEGATE, 'delegate address is the 20 bytes after 0xef0100, lowercased');
  assert.equal(parsed.is_contract, true, 'is_contract is unchanged: still true for a delegated wallet');
  assert.deepEqual(parsed.reasons.map((r) => r.code), ['WALLET_DELEGATED']);
  assert.equal(parsed.status, 'no_flags', 'WALLET_DELEGATED is informational and never flags on its own');
  assert.deepEqual(res.body.result.structuredContent.delegated, true);
  assert.deepEqual(res.body.result.structuredContent.delegate_address, DELEGATE);
});

test('check_wallet_age delegation: empty code reports delegated false', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({ inTransfers: OLD_IN_TRANSFER, code: '0x' });
  t.after(() => { global.fetch = originalFetch; });

  const { parsed } = await callParsed({ address: ADDRESS });
  assert.equal(parsed.delegated, false);
  assert.equal(parsed.delegate_address, null);
  assert.equal(parsed.is_contract, false);
  assert.deepEqual(parsed.reasons, []);
  assert.equal(parsed.status, 'no_flags');
  assert.equal(parsed.checks.length, 1, 'a completed delegation check adds no extra checks entry');
});

test('check_wallet_age delegation: ordinary contract code reports delegated false (is_contract still true)', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({ inTransfers: OLD_IN_TRANSFER, code: '0x6080604052348015600f57600080fd5b50' });
  t.after(() => { global.fetch = originalFetch; });

  const { parsed } = await callParsed({ address: ADDRESS, chain: 'optimism' });
  assert.equal(parsed.delegated, false);
  assert.equal(parsed.delegate_address, null);
  assert.equal(parsed.is_contract, true);
  assert.equal(parsed.status, 'no_flags');
});

test('check_wallet_age delegation: 0xef0100-prefixed code of the wrong length reports delegated false', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const wrongLength = [
    DELEGATED_CODE.slice(0, -2),          // 22 bytes
    DELEGATED_CODE + '00',                // 24 bytes
    '0xef0100',                           // prefix only
    DELEGATED_CODE + DELEGATE.slice(2),   // two addresses
    DELEGATED_CODE.slice(0, -1)           // odd number of hex digits
  ];
  for (const code of wrongLength) {
    global.fetch = makeFetchMock({ inTransfers: OLD_IN_TRANSFER, code });
    const { parsed } = await callParsed({ address: ADDRESS, chain: 'bsc' });
    assert.equal(parsed.delegated, false, `code ${code} must not be read as a delegation`);
    assert.equal(parsed.delegate_address, null);
    assert.equal(parsed.is_contract, true);
  }
});

test('check_wallet_age delegation: a getCode failure returns the age result with delegated null, never false', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const failures = {
    'HTTP 500': { ok: false, status: 500, json: async () => ({}) },
    'JSON-RPC error': { ok: true, json: async () => ({ jsonrpc: '2.0', id: DELEGATION_RPC_ID, error: { code: -32000, message: 'boom' } }) },
    'non-string result': { ok: true, json: async () => ({ jsonrpc: '2.0', id: DELEGATION_RPC_ID, result: null }) }
  };
  for (const [label, delegationResponse] of Object.entries(failures)) {
    global.fetch = makeFetchMock({ inTransfers: OLD_IN_TRANSFER, code: '0x', delegationResponse });
    const { res, parsed } = await callParsed({ address: ADDRESS, chain: 'arbitrum' });
    assert.notEqual(res.body.result.isError, true, label);
    assert.equal(parsed.found, true, `${label}: the age answer is still returned`);
    assert.equal(parsed.first_seen, '2022-02-02T00:00:00.000Z', label);
    assert.equal(parsed.is_contract, false, `${label}: is_contract still comes from the age lookups`);
    assert.equal(parsed.delegated, null, `${label}: an incomplete code check is null, never guessed false`);
    assert.equal(parsed.delegate_address, null, label);
    assert.deepEqual(parsed.reasons, [], label);
    assert.equal(parsed.status, 'unknown', `${label}: an incomplete answer is never a clean no_flags`);
    const delegationCheck = parsed.checks.find((c) => c.source === 'on-chain code (delegation)');
    assert.equal(delegationCheck?.result, 'error', label);
  }
});

test('check_wallet_age delegation: a hung getCode times out inside the same 2.5s budget, with the age still returned', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({ inTransfers: OLD_IN_TRANSFER, code: '0x', hangDelegation: true });
  t.after(() => { global.fetch = originalFetch; });

  const started = Date.now();
  const { parsed } = await callParsed({ address: ADDRESS, chain: 'arbitrum' });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3500, `must finish within the shared 2.5s budget (took ${elapsed}ms)`);
  assert.equal(parsed.found, true);
  assert.equal(parsed.delegated, null);
  assert.equal(parsed.checks.find((c) => c.source === 'on-chain code (delegation)')?.result, 'timeout');
});

test('check_wallet_age delegation: a getCode failure on a no-history address stays found:false with delegated null', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({ delegationResponse: { ok: false, status: 503, json: async () => ({}) } });
  t.after(() => { global.fetch = originalFetch; });

  const { parsed } = await callParsed({ address: ADDRESS, chain: 'arbitrum' });
  assert.equal(parsed.found, false);
  assert.equal(parsed.delegated, null);
  assert.deepEqual(parsed.reasons.map((r) => r.code), ['WALLET_NO_HISTORY']);
});

test('check_wallet_age delegation: an age-lookup failure is still an isError even when the code check succeeds - never found:false', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({ code: DELEGATED_CODE, failPlainTransfers: true });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ address: ADDRESS, chain: 'arbitrum' });
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'upstream_unavailable');
  assert.equal(parsed.found, undefined);
});

test('check_wallet_age delegation: runs on the requested chain, in parallel with the age lookups', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  const delegationUrls = [];
  let ageCallsBeforeDelegation = null;
  let signalAbortedAtDelegationCall = null;
  let ageCalls = 0;
  const mock = makeFetchMock({
    inTransfers: OLD_IN_TRANSFER,
    code: DELEGATED_CODE,
    hangPlain: true, // the age lookups hang until the budget fires...
    onDelegationCall: (body, options) => {
      ageCallsBeforeDelegation = ageCalls;
      signalAbortedAtDelegationCall = !!options.signal?.aborted;
    }
  });
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.id === DELEGATION_RPC_ID) delegationUrls.push(String(url)); else ageCalls += 1;
    return mock(url, options);
  };
  t.after(() => { global.fetch = originalFetch; });

  // ...so the delegation call can only have been made if it was issued
  // alongside them, not after them.
  const res = await callTool({ address: ADDRESS, chain: 'ethereum' });
  assert.equal(delegationUrls.length, 1);
  assert.ok(delegationUrls[0].startsWith('https://eth-mainnet.g.alchemy.com/v2/'), delegationUrls[0]);
  assert.ok(ageCallsBeforeDelegation > 0, 'the delegation call is issued while the age lookups are in flight');
  assert.equal(signalAbortedAtDelegationCall, false, 'the delegation call is issued before the shared 2.5s budget fires, not after the age lookups');
  // ethereum supports internal transfers, so the internal arm (not hung)
  // carries the age answer, and the delegation check completed.
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.found, true);
  assert.equal(parsed.delegated, true);
});

test('check_wallet_age delegation: never written to the cache, on a fresh call', async (t) => {
  withAlchemyEnv(t);
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  const writes = [];
  global.fetch = makeFetchMock({ inTransfers: OLD_IN_TRANSFER, code: DELEGATED_CODE, onWrite: (row) => writes.push(row) });
  t.after(() => { global.fetch = originalFetch; });

  const { parsed } = await callParsed({ address: ADDRESS, chain: 'arbitrum' });
  assert.equal(parsed.delegated, true);
  assert.equal(writes.length, 1);
  assert.ok(!('delegated' in writes[0]) && !('delegate_address' in writes[0]), 'only the age is cached');
  assert.equal(writes[0].is_contract, true);
});

test('check_wallet_age delegation: a cached age with a failing code check returns the cached age with delegated null', async (t) => {
  withAlchemyEnv(t);
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({
    cacheRows: [{ address: ADDRESS, chain: 'base', first_seen: '2020-01-01T00:00:00+00:00', first_seen_block: 7, first_direction: 'out', is_contract: false, checked_at: new Date().toISOString() }],
    hangDelegation: true
  });
  t.after(() => { global.fetch = originalFetch; });

  const { res, parsed } = await callParsed({ address: ADDRESS });
  assert.notEqual(res.body.result.isError, true);
  assert.equal(parsed.cached, true);
  assert.equal(parsed.found, true);
  assert.equal(parsed.first_seen, '2020-01-01T00:00:00.000Z');
  assert.equal(parsed.delegated, null);
  assert.equal(parsed.status, 'unknown');
  assert.equal(parsed.checks.find((c) => c.source === 'on-chain code (delegation)')?.result, 'timeout');
});

test('check_wallet_age delegation: a cached age with no upstream configured still returns, with delegated null', async (t) => {
  withSupabaseEnv(t);
  const prev = process.env.ALCHEMY_API_KEY;
  delete process.env.ALCHEMY_API_KEY;
  t.after(() => { if (prev !== undefined) process.env.ALCHEMY_API_KEY = prev; });
  const originalFetch = global.fetch;
  global.fetch = makeFetchMock({
    cacheRows: [{ address: ADDRESS, chain: 'base', first_seen: '2020-01-01T00:00:00.000Z', first_seen_block: 7, first_direction: 'out', is_contract: false, checked_at: new Date().toISOString() }],
    onAlchemyCall: () => { throw new Error('no upstream call is possible without a key'); }
  });
  t.after(() => { global.fetch = originalFetch; });

  const { parsed } = await callParsed({ address: ADDRESS });
  assert.equal(parsed.found, true);
  assert.equal(parsed.cached, true);
  assert.equal(parsed.delegated, null);
  assert.equal(parsed.delegate_address, null);
});

test('parseWalletDelegation: only an exact 23-byte 0xef0100 designator is a delegation', () => {
  assert.deepEqual(parseWalletDelegation(DELEGATED_CODE), { delegated: true, delegate_address: DELEGATE });
  assert.deepEqual(parseWalletDelegation('0xEF0100' + DELEGATE.slice(2).toUpperCase()), { delegated: true, delegate_address: DELEGATE });
  assert.deepEqual(parseWalletDelegation('0x'), { delegated: false, delegate_address: null });
  assert.deepEqual(parseWalletDelegation('0x6080604052'), { delegated: false, delegate_address: null });
  assert.deepEqual(parseWalletDelegation('0xef0101' + DELEGATE.slice(2)), { delegated: false, delegate_address: null }, 'wrong designator version');
  assert.deepEqual(parseWalletDelegation(DELEGATED_CODE.slice(0, -2)), { delegated: false, delegate_address: null });
  assert.deepEqual(parseWalletDelegation(DELEGATED_CODE + 'ab'), { delegated: false, delegate_address: null });
  assert.deepEqual(parseWalletDelegation(null), { delegated: null, delegate_address: null });
  assert.deepEqual(parseWalletDelegation(undefined), { delegated: null, delegate_address: null });
});

// delegated: true on its own never changes status: WALLET_DELEGATED is an
// informational reason code. Status is exactly what it would have been
// without the delegation, plus "unknown" when the code check didn't complete.
test('check_wallet_age delegation: delegated true never changes status on its own', async (t) => {
  withAlchemyEnv(t);
  withoutSupabaseEnv(t);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  // (a) an old delegated wallet vs (b) an old non-delegated wallet: same status.
  global.fetch = makeFetchMock({ inTransfers: OLD_IN_TRANSFER, code: DELEGATED_CODE });
  const { parsed: delegated } = await callParsed({ address: ADDRESS, chain: 'arbitrum' });
  global.fetch = makeFetchMock({ inTransfers: OLD_IN_TRANSFER, code: '0x' });
  const { parsed: plain } = await callParsed({ address: ADDRESS, chain: 'arbitrum' });
  assert.equal(delegated.status, 'no_flags');
  assert.deepEqual(delegated.reasons.map((r) => r.code), ['WALLET_DELEGATED']);
  assert.equal(plain.status, 'no_flags');
  assert.deepEqual(plain.reasons, []);

  // No history: flagged by WALLET_NO_HISTORY, exactly as before - delegation adds the fact, not the flag.
  global.fetch = makeFetchMock({ code: DELEGATED_CODE });
  const { parsed: newDelegated } = await callParsed({ address: ADDRESS, chain: 'arbitrum' });
  global.fetch = makeFetchMock({ code: '0x' });
  const { parsed: newPlain } = await callParsed({ address: ADDRESS, chain: 'arbitrum' });
  assert.equal(newDelegated.status, newPlain.status);
  assert.equal(newDelegated.status, 'flagged');
  assert.deepEqual(newDelegated.reasons.map((r) => r.code), ['WALLET_NO_HISTORY', 'WALLET_DELEGATED']);
  assert.deepEqual(newPlain.reasons.map((r) => r.code), ['WALLET_NO_HISTORY']);

  // Internal transfers not checked in time (base): WALLET_AGE_PARTIAL flags, as before.
  global.fetch = makeFetchMock({ inTransfers: OLD_IN_TRANSFER, code: DELEGATED_CODE, hangInternal: true });
  const { parsed: partialDelegated } = await callParsed({ address: ADDRESS, chain: 'base' });
  assert.equal(partialDelegated.status, 'flagged');
  assert.deepEqual(partialDelegated.reasons.map((r) => r.code), ['WALLET_AGE_PARTIAL', 'WALLET_DELEGATED']);
});

test('computeStatus: informational reason codes never flag on their own', () => {
  assert.deepEqual([...INFORMATIONAL_REASON_CODES], ['WALLET_DELEGATED']);
  const ok = [{ result: 'ok' }];
  assert.equal(computeStatus([{ code: 'WALLET_DELEGATED' }], ok), 'no_flags');
  assert.equal(computeStatus([{ code: 'WALLET_DELEGATED' }], [...ok, { result: 'timeout' }]), 'unknown');
  assert.equal(computeStatus([{ code: 'WALLET_DELEGATED' }, { code: 'WALLET_NO_HISTORY' }], ok), 'flagged');
  assert.equal(computeStatus([{ code: 'WALLET_SANCTIONED' }], ok), 'flagged');
  assert.equal(computeStatus([], ok), 'no_flags');
});

function cachedFoundFetch({ onDelegation } = {}) {
  return async (url, options = {}) => {
    const urlStr = String(url);
    if (urlStr.includes('api.gumroad.com/v2/licenses/verify')) {
      return { ok: true, json: async () => ({ success: true, purchase: {} }) };
    }
    if (urlStr.includes('/rest/v1/wallet_first_seen')) {
      return { ok: true, json: async () => [{ address: ADDRESS, chain: 'base', first_seen: '2020-01-01T00:00:00.000Z', first_seen_block: 7, first_direction: 'out', is_contract: false, checked_at: new Date().toISOString() }] };
    }
    if (urlStr.includes('.g.alchemy.com/v2/')) {
      const body = JSON.parse(options.body);
      assert.equal(body.id, DELEGATION_RPC_ID, 'a cached answer only makes the delegation call');
      if (onDelegation) onDelegation();
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x' }) };
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
}

test('check_wallet_age: cached answers count against the 60/hour rate limit (each makes a live delegation call)', async (t) => {
  withAlchemyEnv(t);
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  let delegationCalls = 0;
  global.fetch = cachedFoundFetch({ onDelegation: () => { delegationCalls += 1; } });
  t.after(() => { global.fetch = originalFetch; });

  const headers = { 'x-forwarded-for': '198.51.100.140' };
  for (let i = 0; i < 60; i++) {
    const res = await callTool({ address: ADDRESS }, headers);
    assert.notEqual(res.body.result.isError, true, `cached call ${i + 1} should not be rate-limited yet`);
    assert.equal(JSON.parse(res.body.result.content[0].text).cached, true);
  }
  assert.equal(delegationCalls, 60);
  const limited = await callTool({ address: ADDRESS }, headers);
  assert.equal(limited.body.result.isError, true);
  assert.equal(JSON.parse(limited.body.result.content[0].text).code, 'rate_limited');
  assert.equal(delegationCalls, 60, 'a rate-limited call makes no upstream call');
});

test('check_wallet_age: a valid licence key still exempts cached answers from the rate limit', async (t) => {
  withAlchemyEnv(t);
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = cachedFoundFetch();
  t.after(() => { global.fetch = originalFetch; });

  const headers = { 'x-forwarded-for': '198.51.100.141', 'x-api-key': 'valid-license-key' };
  for (let i = 0; i < 61; i++) {
    const res = await callTool({ address: ADDRESS }, headers);
    assert.notEqual(res.body.result.isError, true, `licensed cached call ${i + 1} must not be rate-limited`);
    assert.equal(JSON.parse(res.body.result.content[0].text).cached, true);
  }
});
