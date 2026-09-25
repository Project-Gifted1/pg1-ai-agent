/**
 * Tests for api/mcp.mjs — check_wallet_sanctions and check_domain_age
 * tools/call behavior (issue #106): invalid-address MCP tool errors,
 * check_domain_age found/available/reason_code fields.
 * Run with: node --test tests/mcp-tools.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/mcp.mjs';

function makeReq(body) {
  return { method: 'POST', headers: {}, body };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    setHeader() {},
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

async function callTool(name, args) {
  const req = makeReq({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const res = makeRes();
  await handler(req, res);
  return res;
}

// check_wallet_sanctions now queries public.sanctioned_wallets *before*
// applying the format heuristic (issue #106 follow-up), so any test that
// exercises a lookup — as opposed to the empty-string short-circuit — needs
// Supabase creds present and fetch mocked.
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

function mockSanctionsFetch(matchRows) {
  return async (url) => {
    const urlStr = String(url);
    if (!urlStr.includes('/sanctioned_wallets')) throw new Error('unexpected fetch: ' + urlStr);
    if (urlStr.includes('select=updated_at')) {
      return { ok: true, json: async () => [{ updated_at: '2026-01-01T00:00:00Z' }] };
    }
    return { ok: true, json: async () => matchRows };
  };
}

test('check_wallet_sanctions: rejects "hello" as invalid_address when it has no match in the sanctions table', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = mockSanctionsFetch([]);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await callTool('check_wallet_sanctions', { address: 'hello' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'invalid_address');
  assert.equal(parsed.listed, undefined);
});

test('check_wallet_sanctions: rejects empty string as invalid_address before querying Supabase', async () => {
  const res = await callTool('check_wallet_sanctions', { address: '' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'invalid_address');
});

test('check_wallet_sanctions: rejects a 0x address with the wrong hex length when it has no match in the sanctions table', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = mockSanctionsFetch([]);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await callTool('check_wallet_sanctions', { address: '0x1234' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'invalid_address');
});

test('check_wallet_sanctions: a stored address that fails the format validator still returns listed:true', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = mockSanctionsFetch([
    { sdn_name: 'Test Entity', currency: 'ETH', programs: ['SDN'], sdn_uid: '12345' }
  ]);
  t.after(() => {
    global.fetch = originalFetch;
  });

  // "hello" fails isRecognizedWalletAddress, but a live-table match must win
  // over the format heuristic regardless.
  const res = await callTool('check_wallet_sanctions', { address: 'hello' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, undefined);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.listed, true);
  assert.equal(parsed.matches.length, 1);
  assert.equal(parsed.matches[0].sdn_name, 'Test Entity');
});

test('check_domain_age: unsupported TLD returns found:false, available:false, reason_code unsupported_tld', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('data.iana.org/rdap/dns.json')) {
      return { ok: true, json: async () => ({ services: [[['com'], ['https://rdap.example/com/']]] }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await callTool('check_domain_age', { domain: 'example.doesnotexisttld' });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.found, false);
  assert.equal(parsed.available, false);
  assert.equal(parsed.reason_code, 'unsupported_tld');
  assert.equal(res.body.result.structuredContent.reason_code, 'unsupported_tld');
});

test('check_domain_age: successful RDAP lookup returns found:true and available:true', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('data.iana.org/rdap/dns.json')) {
      return { ok: true, json: async () => ({ services: [[['com'], ['https://rdap.example/com/']]] }) };
    }
    if (String(url).startsWith('https://rdap.example/com/domain/')) {
      return {
        ok: true,
        json: async () => ({
          events: [
            { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
            { eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' }
          ],
          entities: []
        })
      };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await callTool('check_domain_age', { domain: 'example.com' });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.found, true);
  assert.equal(parsed.available, true);
  assert.equal(parsed.reason_code, undefined);
  assert.equal(res.body.result.structuredContent.found, true);
});

test('check_domain_age: caches a successful RDAP lookup per registrable domain for 24h', async (t) => {
  const originalFetch = global.fetch;
  let domainLookupCount = 0;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('data.iana.org/rdap/dns.json')) {
      return { ok: true, json: async () => ({ services: [[['com'], ['https://rdap.example/com/']]] }) };
    }
    if (urlStr.startsWith('https://rdap.example/com/domain/')) {
      domainLookupCount += 1;
      return {
        ok: true,
        json: async () => ({
          events: [{ eventAction: 'registration', eventDate: '2021-06-01T00:00:00Z' }],
          entities: []
        })
      };
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const domain = 'rdap-cache-test-example.com';
  const first = await callTool('check_domain_age', { domain });
  assert.equal(JSON.parse(first.body.result.content[0].text).found, true);
  assert.equal(domainLookupCount, 1);

  const second = await callTool('check_domain_age', { domain });
  assert.equal(JSON.parse(second.body.result.content[0].text).found, true);
  assert.equal(domainLookupCount, 1, 'second lookup for the same domain should be served from the 24h cache, not hit RDAP again');
});

// Failed lookups (e.g. unsupported TLD) are deliberately not cached, so
// repeated calls with the same unresolvable domain keep exercising the
// per-IP rate limit path below rather than short-circuiting via the cache.
function makeRateLimitReq(ip, licenseKey) {
  const headers = { 'x-forwarded-for': ip };
  if (licenseKey) headers['x-api-key'] = licenseKey;
  return {
    method: 'POST',
    headers,
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'check_domain_age', arguments: { domain: 'example.doesnotexisttld' } }
    }
  };
}

test('check_domain_age: rate-limits an unauthenticated caller to 60 calls/hour per IP', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('data.iana.org/rdap/dns.json')) {
      return { ok: true, json: async () => ({ services: [[['com'], ['https://rdap.example/com/']]] }) };
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const req = makeRateLimitReq('198.51.100.10');
  for (let i = 0; i < 60; i++) {
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.notEqual(res.body.result.isError, true, `call ${i + 1} should not be rate-limited yet`);
  }

  const limitedRes = makeRes();
  await handler(req, limitedRes);
  assert.equal(limitedRes.statusCode, 200);
  assert.equal(limitedRes.body.result.isError, true);
  const parsed = JSON.parse(limitedRes.body.result.content[0].text);
  assert.equal(parsed.code, 'rate_limited');
});

test('check_domain_age: a valid Gumroad license key exempts the caller from the per-IP rate limit', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('data.iana.org/rdap/dns.json')) {
      return { ok: true, json: async () => ({ services: [[['com'], ['https://rdap.example/com/']]] }) };
    }
    if (urlStr.includes('api.gumroad.com/v2/licenses/verify')) {
      return { ok: true, json: async () => ({ success: true, purchase: {} }) };
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const req = makeRateLimitReq('198.51.100.20', 'valid-license-key');
  for (let i = 0; i < 61; i++) {
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.notEqual(res.body.result.isError, true, `call ${i + 1} should not be rate-limited for a licensed caller`);
  }
});
