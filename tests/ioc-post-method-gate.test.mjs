/**
 * Regression tests for issue #125: a POST to /api/ioc with no recognized
 * chat action fell through to serving the full STIX bundle for free,
 * bypassing the license/free-tier/x402 payment gate that GET already
 * enforced.
 *
 * Root cause (confirmed by reading @x402/core's x402HTTPResourceServer):
 * paymentMiddleware() only treats a request as payment-protected when its
 * exact "METHOD path" matches a key in the routes config passed to it.
 * api/chat.mjs only ever registered 'GET /api/ioc', so for a POST request
 * `requiresPayment()` returned false and the middleware called next()
 * immediately with zero payment/license/free-tier checks performed - the
 * handler then ran buildAndServeStixBundle() unconditionally. The license
 * and free-tier tiers ahead of it in the gate are method-agnostic (they only
 * look at headers), so neither one caught this either.
 *
 * The `ioc-x402-route-registration` block below reproduces that exact
 * mechanism directly against the real @x402/express + @x402/core + EVM
 * scheme packages (the same ones api/chat.mjs uses), with only the
 * facilitator's network calls stubbed out - proving both the bug (GET-only
 * registration) and the fix (GET+POST+HEAD registration, as now shipped in
 * api/chat.mjs) at the library level, without needing live network access.
 *
 * The other tests drive the real handler end-to-end (X402_PAY_TO_ADDRESS
 * unset, so api/chat.mjs's own x402 setup is skipped and every /api/ioc
 * request falls to its generic-402 branch, or 200s via not needing to reach
 * that branch at all) to confirm GET/POST/HEAD parity and the 405 method
 * allowlist added directly in the handler.
 *
 * Run with: node --test tests/ioc-post-method-gate.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler from '../api/chat.mjs';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function resetEnv() {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  delete process.env.USER_API_KEY;
  delete process.env.USER_API_PASS;
  delete process.env.X402_PAY_TO_ADDRESS;
  delete process.env.GUMROAD_PRODUCT_ID;
}

test.beforeEach(() => {
  resetEnv();
});

test.after(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
});

function makeReq(opts = {}) {
  return {
    method: opts.method || 'GET',
    url: opts.url || '/api/ioc',
    headers: opts.headers || {},
    socket: { remoteAddress: opts.ip || '127.0.0.1' },
    body: opts.body ?? null
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

function installFetchMock() {
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/rest/v1/free_tier_usage')) return { ok: true, json: async () => [] };
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
    if (urlStr.includes('/rest/v1/api_access_logs')) return { ok: true, json: async () => ({}) };
    if (urlStr.includes('api.gumroad.com')) return { ok: true, json: async () => ({ success: true, purchase: {} }) };
    return { ok: true, json: async () => ({}) };
  };
}

// --- End-to-end parity: X402_PAY_TO_ADDRESS unset, so both GET and POST run
// through api/chat.mjs's own tiers and converge on the exact same generic-402
// (tier 4) or 200 (tier 1/2) code paths. This directly exercises the new
// method allowlist and confirms POST/HEAD now behave identically to GET.

test('POST /api/ioc with no headers and no body returns a 402 identical to GET', async () => {
  installFetchMock();

  const getRes = makeRes();
  await chatHandler(makeReq({ method: 'GET', ip: '10.2.0.1' }), getRes);

  const postRes = makeRes();
  await chatHandler(makeReq({ method: 'POST', ip: '10.2.0.1' }), postRes);

  assert.equal(getRes.statusCode, 402);
  assert.equal(postRes.statusCode, 402);
  assert.deepEqual(postRes.body, getRes.body);
});

test('HEAD /api/ioc with no headers returns 402, same as GET', async () => {
  installFetchMock();
  const res = makeRes();
  await chatHandler(makeReq({ method: 'HEAD', ip: '10.2.0.2' }), res);
  assert.equal(res.statusCode, 402);
});

test('POST /api/ioc with x-free-tier: 1 returns 200 with a STIX bundle, same as GET', async () => {
  installFetchMock();
  const res = makeRes();
  await chatHandler(
    makeReq({ method: 'POST', ip: '10.2.0.3', headers: { 'x-free-tier': '1' } }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.type, 'bundle');
  assert.ok(Array.isArray(res.body.objects) && res.body.objects.length > 0);
});

test('POST /api/ioc with a valid license key returns 200 with a STIX bundle, same as GET', async () => {
  installFetchMock();
  const res = makeRes();
  await chatHandler(
    makeReq({ method: 'POST', ip: '10.2.0.4', headers: { 'x-api-key': 'valid-key' } }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.type, 'bundle');
});

test('POST /api/ioc with a license key gets 503 + Retry-After: 5 when Gumroad is unreachable, same as GET', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('api.gumroad.com')) throw new Error('gumroad unreachable');
    return { ok: true, json: async () => ({}) };
  };
  const res = makeRes();
  await chatHandler(
    makeReq({ method: 'POST', ip: '10.2.0.5', headers: { 'x-api-key': 'some-key' } }),
    res
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Retry-After'], '5');
});

test('PUT /api/ioc returns 405 with an Allow header and never serves the bundle', async () => {
  installFetchMock();
  const res = makeRes();
  await chatHandler(makeReq({ method: 'PUT', ip: '10.2.0.6' }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Allow'], 'GET, POST, HEAD, OPTIONS');
  assert.notEqual(res.body && res.body.type, 'bundle');
});

test('DELETE /api/ioc returns 405 with an Allow header and never serves the bundle', async () => {
  installFetchMock();
  const res = makeRes();
  await chatHandler(makeReq({ method: 'DELETE', ip: '10.2.0.7' }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Allow'], 'GET, POST, HEAD, OPTIONS');
});

test('PUT /api/feeds/ioc (the alias route) also returns 405 with an Allow header', async () => {
  installFetchMock();
  const res = makeRes();
  await chatHandler(makeReq({ method: 'PUT', url: '/api/feeds/ioc', ip: '10.2.0.8' }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Allow'], 'GET, POST, HEAD, OPTIONS');
});

// --- Library-level proof of the root cause and the fix: the x402 payment
// middleware only gates requests whose "METHOD path" was registered with it.
// This drives the real @x402/express + @x402/core + ExactEvmScheme code
// (the same dependency chain api/chat.mjs uses), stubbing out only the
// facilitator's own network calls (getSupported), so no live network or CDP
// credentials are required.

function makeStubFacilitator() {
  return {
    getSupported: async () => ({
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: 'eip155:8453',
          extra: { name: 'USDC', version: '2', decimals: 6, feePayer: '0x0000000000000000000000000000000000000000' }
        }
      ]
    })
  };
}

function makeExpressLikeReq(method) {
  return {
    method,
    url: '/api/ioc',
    path: '/api/ioc',
    originalUrl: '/api/ioc',
    protocol: 'https',
    headers: { host: 'example.com' },
    header(name) { return this.headers[String(name).toLowerCase()]; },
    get(name) { return this.header(name); },
    query: {}
  };
}

function makeExpressLikeRes() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    setHeader(k, v) { headers[k] = v; },
    getHeader(k) { return headers[k]; },
    getHeaders() { return headers; },
    removeHeader(k) { delete headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    end(b) { this.body = b; return this; },
    write() {},
    writeHead() {},
    flushHeaders() {}
  };
}

async function runMiddleware(mw, method) {
  const req = makeExpressLikeReq(method);
  const res = makeExpressLikeRes();
  let calledNext = false;
  // The middleware only calls next() when the route is unprotected (the bug)
  // or payment succeeds; on a 402 challenge it writes directly to res and
  // never calls next() at all, so this can't resolve on next() alone.
  const originalJson = res.json.bind(res);
  await new Promise((resolve) => {
    res.json = function (body) {
      const out = originalJson(body);
      resolve();
      return out;
    };
    mw(req, res, () => { calledNext = true; resolve(); });
  });
  return { req, res, calledNext };
}

test('root cause: registering only GET /api/ioc lets an unpaid POST bypass the x402 gate entirely', async () => {
  const server = new x402ResourceServer(makeStubFacilitator()).register('eip155:8453', new ExactEvmScheme());
  await server.initialize();
  const cfg = {
    accepts: [{ scheme: 'exact', price: '$0.01', network: 'eip155:8453', payTo: '0x000000000000000000000000000000000000dEaD' }],
    description: 'test',
    mimeType: 'application/stix+json'
  };
  // This mirrors the pre-fix api/chat.mjs config: only 'GET /api/ioc' registered.
  const mw = paymentMiddleware({ 'GET /api/ioc': cfg }, server, undefined, undefined, false);

  const get = await runMiddleware(mw, 'GET');
  assert.equal(get.calledNext, false);
  assert.equal(get.res.statusCode, 402);

  const post = await runMiddleware(mw, 'POST');
  assert.equal(post.calledNext, true, 'BUG: an unpaid POST was waved through with no payment check');
  assert.notEqual(post.res.statusCode, 402);
});

test('fix: registering GET/POST/HEAD /api/ioc against the same config gates every method identically', async () => {
  const server = new x402ResourceServer(makeStubFacilitator()).register('eip155:8453', new ExactEvmScheme());
  await server.initialize();
  const cfg = {
    accepts: [{ scheme: 'exact', price: '$0.01', network: 'eip155:8453', payTo: '0x000000000000000000000000000000000000dEaD' }],
    description: 'test',
    mimeType: 'application/stix+json'
  };
  // Mirrors the fixed api/chat.mjs config: same route config under all three keys.
  const mw = paymentMiddleware(
    { 'GET /api/ioc': cfg, 'POST /api/ioc': cfg, 'HEAD /api/ioc': cfg },
    server,
    undefined,
    undefined,
    false
  );

  for (const method of ['GET', 'POST', 'HEAD']) {
    const result = await runMiddleware(mw, method);
    assert.equal(result.calledNext, false, `${method} should not bypass the gate`);
    assert.equal(result.res.statusCode, 402, `${method} should get the same 402 challenge as GET`);
  }
});
