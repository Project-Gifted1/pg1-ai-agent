/**
 * Tests for api/mcp.mjs — check_hostname_reputation (issue #121): exact and
 * parent-domain blocklist hits, allowlist precedence, confusable/keyword
 * lookalike detection, brand-domain exclusion, input validation, Supabase
 * failure handling, result caching, and the shared rate-limit/license-key
 * exemption pattern from check_domain_age.
 * Run with: node --test tests/hostname-reputation.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/mcp.mjs';

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
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_hostname_reputation', arguments: args } }
  };
}

async function callTool(args, extraHeaders) {
  const req = makeReq(args, extraHeaders);
  const res = makeRes();
  await handler(req, res);
  return res;
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

const FUZZYLIST = ['metamask.io', 'amazon.com'];
const META = { source: 'MetaMask eth-phishing-detect', tolerance: 3, synced_at: '2026-01-01T00:00:00Z' };

// candidateRows: array of { domain, list_type, source, synced_at } returned
// verbatim for the single "in" filter query, regardless of which candidates
// were actually requested — each test supplies exactly the rows it needs.
function mockPhishingFetch({ candidateRows = [], fuzzylist = FUZZYLIST, meta = META, onCandidatesQuery } = {}) {
  return async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/phishing_list_meta')) {
      return { ok: true, json: async () => [meta] };
    }
    if (urlStr.includes('/phishing_domains') && urlStr.includes('list_type=eq.fuzzylist')) {
      return { ok: true, json: async () => fuzzylist.map((domain) => ({ domain })) };
    }
    if (urlStr.includes('/phishing_domains') && urlStr.includes('list_type=in.(blocklist,allowlist)')) {
      if (onCandidatesQuery) onCandidatesQuery(urlStr);
      return { ok: true, json: async () => candidateRows };
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
}

test('check_hostname_reputation: exact hostname blocklist hit returns verdict listed, match_type exact', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = mockPhishingFetch({
    candidateRows: [{ domain: 'evil-phish-exact.zzz', list_type: 'blocklist', source: 'eth-phishing-detect', synced_at: '2026-02-01T00:00:00Z' }]
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ hostname: 'evil-phish-exact.zzz' });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.verdict, 'listed');
  assert.equal(parsed.sources[0].match_type, 'exact');
  assert.equal(parsed.sources[0].name, 'MetaMask eth-phishing-detect');
  assert.equal(parsed.lookalike_of, null);
  assert.equal(res.body.result.structuredContent.verdict, 'listed');
});

test('check_hostname_reputation: subdomain of a blocklisted parent returns verdict listed, match_type parent_domain', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = mockPhishingFetch({
    candidateRows: [{ domain: 'evil-parent-phish.zzz', list_type: 'blocklist', source: 'eth-phishing-detect', synced_at: '2026-02-01T00:00:00Z' }]
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ hostname: 'login.evil-parent-phish.zzz' });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.verdict, 'listed');
  assert.equal(parsed.sources[0].match_type, 'parent_domain');
});

test('check_hostname_reputation: allowlist wins over blocklist for the same domain', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = mockPhishingFetch({
    candidateRows: [
      { domain: 'mixed-listed.zzz', list_type: 'blocklist', source: 'eth-phishing-detect', synced_at: '2026-02-01T00:00:00Z' },
      { domain: 'mixed-listed.zzz', list_type: 'allowlist', source: 'eth-phishing-detect', synced_at: '2026-02-02T00:00:00Z' }
    ]
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ hostname: 'mixed-listed.zzz' });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.verdict, 'allowlisted');
  assert.equal(parsed.sources[0].match_type, 'allowlist');
});

test('check_hostname_reputation: a confusable-character substitution is flagged as a lookalike', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = mockPhishingFetch({ candidateRows: [] });
  t.after(() => { global.fetch = originalFetch; });

  // "amaz0n.com" (zero for 'o') folds to "amazon.com" in the confusable
  // skeleton, matching the fuzzylist entry within the default tolerance.
  const res = await callTool({ hostname: 'amaz0n.com' });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.verdict, 'lookalike');
  assert.equal(parsed.lookalike_of, 'amazon.com');
  assert.equal(parsed.sources[0].match_type, 'confusable');
  assert.equal(parsed.sources[0].name, 'PG1 lookalike detection');
});

test('check_hostname_reputation: a brand keyword with extra words is flagged as a lookalike', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = mockPhishingFetch({ candidateRows: [] });
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ hostname: 'metamask-login.com' });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.verdict, 'lookalike');
  assert.equal(parsed.lookalike_of, 'metamask.io');
  assert.equal(parsed.sources[0].match_type, 'keyword');
});

test('check_hostname_reputation: the brand\'s own real domain (and a subdomain of it) is never flagged as its own lookalike', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = mockPhishingFetch({ candidateRows: [] });
  t.after(() => { global.fetch = originalFetch; });

  const direct = await callTool({ hostname: 'metamask.io' });
  const directParsed = JSON.parse(direct.body.result.content[0].text);
  assert.equal(directParsed.verdict, 'not_listed');
  assert.equal(directParsed.lookalike_of, null);

  const sub = await callTool({ hostname: 'app.metamask.io' });
  const subParsed = JSON.parse(sub.body.result.content[0].text);
  assert.equal(subParsed.verdict, 'not_listed');
  assert.equal(subParsed.lookalike_of, null);
});

test('check_hostname_reputation: rejects malformed input as invalid_hostname without querying Supabase', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => { throw new Error('unexpected fetch: ' + url); };
  try {
    const badInputs = [
      'https://example.com',
      'example.com/path',
      'example.com:8080',
      'exa mple.com',
      '*.example.com',
      ''
    ];
    for (const bad of badInputs) {
      const res = await callTool({ hostname: bad });
      assert.equal(res.statusCode, 200, `input ${JSON.stringify(bad)} should return 200`);
      assert.equal(res.body.result.isError, true, `input ${JSON.stringify(bad)} should be rejected`);
      const parsed = JSON.parse(res.body.result.content[0].text);
      assert.equal(parsed.code, 'invalid_hostname');
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test('check_hostname_reputation: returns a 503 error (never not_listed) when Supabase is unreachable', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/phishing_domains')) {
      throw new Error('supabase unreachable');
    }
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool({ hostname: 'supabase-outage-test.zzz' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.jsonrpc, '2.0');
  assert.equal(res.body.error.code, -32003);
  assert.match(res.body.error.message, /temporarily unavailable/i);
});

test('check_hostname_reputation: caches a result per normalised hostname for 1 hour', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  let candidateQueryCount = 0;
  global.fetch = mockPhishingFetch({
    candidateRows: [{ domain: 'cache-reuse-test.zzz', list_type: 'blocklist', source: 'eth-phishing-detect', synced_at: '2026-02-01T00:00:00Z' }],
    onCandidatesQuery: () => { candidateQueryCount += 1; }
  });
  t.after(() => { global.fetch = originalFetch; });

  const first = await callTool({ hostname: 'cache-reuse-test.zzz' });
  assert.equal(JSON.parse(first.body.result.content[0].text).verdict, 'listed');
  assert.equal(candidateQueryCount, 1);

  const second = await callTool({ hostname: 'CACHE-REUSE-TEST.zzz.' }); // same after normalization
  assert.equal(JSON.parse(second.body.result.content[0].text).verdict, 'listed');
  assert.equal(candidateQueryCount, 1, 'second call for the same normalised hostname should be served from cache');
});

function makeRateLimitReq(hostname, ip, licenseKey) {
  const headers = { 'x-forwarded-for': ip };
  if (licenseKey) headers['x-api-key'] = licenseKey;
  return {
    method: 'POST',
    headers,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_hostname_reputation', arguments: { hostname } } }
  };
}

test('check_hostname_reputation: rate-limits an unauthenticated caller to 60 calls/hour per IP', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = mockPhishingFetch({ candidateRows: [] });
  t.after(() => { global.fetch = originalFetch; });

  const ip = '198.51.100.30';
  for (let i = 0; i < 60; i++) {
    const res = makeRes();
    await handler(makeRateLimitReq(`rl-test-${i}.zzz`, ip), res);
    assert.equal(res.statusCode, 200);
    assert.notEqual(res.body.result.isError, true, `call ${i + 1} should not be rate-limited yet`);
  }

  const limitedRes = makeRes();
  await handler(makeRateLimitReq('rl-test-60.zzz', ip), limitedRes);
  assert.equal(limitedRes.statusCode, 200);
  assert.equal(limitedRes.body.result.isError, true);
  const parsed = JSON.parse(limitedRes.body.result.content[0].text);
  assert.equal(parsed.code, 'rate_limited');
});

test('check_hostname_reputation: a valid Gumroad license key exempts the caller from the per-IP rate limit', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  const phishingFetch = mockPhishingFetch({ candidateRows: [] });
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('api.gumroad.com/v2/licenses/verify')) {
      return { ok: true, json: async () => ({ success: true, purchase: {} }) };
    }
    return phishingFetch(url);
  };
  t.after(() => { global.fetch = originalFetch; });

  const ip = '198.51.100.31';
  for (let i = 0; i < 61; i++) {
    const res = makeRes();
    await handler(makeRateLimitReq(`rl-licensed-test-${i}.zzz`, ip, 'valid-license-key'), res);
    assert.equal(res.statusCode, 200);
    assert.notEqual(res.body.result.isError, true, `call ${i + 1} should not be rate-limited for a licensed caller`);
  }
});
