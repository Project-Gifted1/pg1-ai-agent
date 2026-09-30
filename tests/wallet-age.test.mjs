/**
 * Tests for api/mcp.mjs — check_wallet_age (issue #209): earliest on-chain
 * transfer in/out resolution, no-history found:false, upstream
 * timeout/failure as isError (never found:false), input validation, the
 * permanent found-result cache and the 10-minute found:false cache TTL, the
 * uncached fallback when the wallet_first_seen table is missing, that no raw
 * upstream (Alchemy) fields ever leak into a response, and that the 13
 * pre-existing tool definitions are unchanged.
 * Run with: node --test tests/wallet-age.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler, { TOOLS } from '../api/mcp.mjs';

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

// Routes Alchemy JSON-RPC calls (alchemy_getAssetTransfers x2, eth_getCode)
// and Supabase wallet_first_seen reads/writes. `cacheRows` seeds the GET
// response; `onWrite` observes each upsert body; `tableMissing` simulates
// the cache table not existing yet.
function makeFetchMock({ outTransfers = [], inTransfers = [], code = '0x', cacheRows = [], tableMissing = false, onWrite, onAlchemyCall, hang = false } = {}) {
  return async (url, options = {}) => {
    const urlStr = String(url);

    if (urlStr.includes('.g.alchemy.com/v2/')) {
      if (onAlchemyCall) onAlchemyCall();
      if (hang) {
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
      const body = JSON.parse(options.body);
      if (body.method === 'eth_getCode') {
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: code }) };
      }
      if (body.method === 'alchemy_getAssetTransfers') {
        const params = body.params[0];
        const isOut = !!params.fromAddress;
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { transfers: isOut ? outTransfers : inTransfers } }) };
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

test('check_wallet_age: a found result is cached and a repeat call skips Alchemy entirely', async (t) => {
  withAlchemyEnv(t);
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  let storedRow = null;
  let alchemyCalls = 0;
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
      alchemyCalls += 1;
      const body = JSON.parse(options.body);
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
  const callsAfterFirst = alchemyCalls;
  assert.ok(callsAfterFirst > 0);

  const second = await callTool({ address: ADDRESS, chain: 'base' });
  const secondParsed = JSON.parse(second.body.result.content[0].text);
  assert.equal(secondParsed.found, true);
  assert.equal(secondParsed.cached, true);
  assert.equal(secondParsed.first_seen, '2022-02-02T00:00:00.000Z');
  assert.equal(alchemyCalls, callsAfterFirst, 'second call should be served from the permanent found-result cache, never hitting Alchemy again');
});

test('check_wallet_age: a found:false result is cached for 10 minutes, then re-queried', async (t) => {
  withAlchemyEnv(t);
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  let storedRow = { address: ADDRESS, chain: 'base', first_seen: null, first_seen_block: null, first_direction: null, is_contract: false, checked_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() };
  let alchemyCalls = 0;
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
      alchemyCalls += 1;
      const body = JSON.parse(options.body);
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
  assert.equal(alchemyCalls, 0, 'a not-found result within the 10-minute TTL must not re-query Alchemy');

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
    ['address', 'age_days', 'cached', 'chain', 'first_direction', 'first_seen', 'first_seen_block', 'found', 'is_contract', 'note', 'source'].sort()
  );
  assert.equal(res.body.result.structuredContent && Object.keys(res.body.result.structuredContent).some((k) =>
    ['uniqueId', 'hash', 'category', 'asset', 'rawContract', 'from', 'to', 'value'].includes(k)
  ), false);
});

test('check_wallet_age: is the 14th tool, and the 13 pre-existing tool definitions are byte-identical to before', () => {
  assert.equal(TOOLS.length, 14);
  const snapshotPath = path.join(__dirname, 'fixtures', 'existing-13-tools-snapshot.json');
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.equal(snapshot.length, 13);
  for (const expected of snapshot) {
    const actual = TOOLS.find((t) => t.name === expected.name);
    assert.ok(actual, `expected pre-existing tool '${expected.name}' to still be present`);
    assert.deepEqual(actual, expected, `tool '${expected.name}' definition drifted from before check_wallet_age was added`);
  }
});
