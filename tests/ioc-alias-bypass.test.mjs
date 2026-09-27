/**
 * Regression tests for issue #127: a request with NO headers and NO body to
 * https://pg1-ai-agent.vercel.app/api/feeds/ioc returned 200 with the full
 * STIX bundle, even though /api/ioc correctly returned 402.
 *
 * Root cause: api/chat.mjs treated '/api/ioc' and '/api/feeds/ioc' as
 * equivalent for its own method-allowlist/CORS logic, but the x402 payment
 * middleware it delegates to (see api/chat.mjs's X402 PAYMENT LAYER section)
 * only enforces its gate for requests whose exact "METHOD path" matches one
 * of the keys it was configured with - 'GET /api/ioc', 'POST /api/ioc',
 * 'HEAD /api/ioc'. A request to /api/feeds/ioc never matches any of those
 * keys, so the middleware treated the route as unprotected and called
 * next() with zero payment/license/free-tier checks, and the handler then
 * served the bundle unconditionally.
 *
 * The fix: /api/ioc is now the only path that ever reaches the gate/bundle
 * logic. Every known alias (api/feeds/ioc.js, listed in ALIAS_PATHS below)
 * is 308-redirected to /api/ioc - preserving the query string - before any
 * gate, CORS, or method-allowlist logic runs, for every HTTP method.
 *
 * Run with: node --test tests/ioc-alias-bypass.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

// Every URL path (besides the canonical /api/ioc) found in the codebase
// that delegates into api/chat.mjs's IOC handling - see api/feeds/ioc.js.
// vercel.json has no rewrites/routes section and there is no next.config.js,
// so this file-based route is the only alias into this handler.
const ALIAS_PATHS = ['/api/feeds/ioc'];
const CANONICAL_PATH = '/api/ioc';

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

const METHODS = ['GET', 'POST', 'HEAD'];
let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.9.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

for (const aliasPath of ALIAS_PATHS) {
  for (const method of METHODS) {
    test(`${method} ${aliasPath} with no headers is 308-redirected to ${CANONICAL_PATH}, never a 200 bundle`, async () => {
      installFetchMock();
      const res = makeRes();
      await chatHandler(makeReq({ method, url: aliasPath, ip: nextIp() }), res);

      assert.equal(res.statusCode, 308);
      assert.equal(res.headers['Location'], CANONICAL_PATH);
      assert.notEqual(res.statusCode, 200);
      assert.notEqual(res.body && res.body.type, 'bundle');
    });

    test(`${method} ${aliasPath}?since=2026-01-01 preserves the query string in the redirect`, async () => {
      installFetchMock();
      const res = makeRes();
      await chatHandler(
        makeReq({ method, url: `${aliasPath}?since=2026-01-01&limit=5`, ip: nextIp() }),
        res
      );

      assert.equal(res.statusCode, 308);
      assert.equal(res.headers['Location'], `${CANONICAL_PATH}?since=2026-01-01&limit=5`);
    });
  }
}

for (const method of METHODS) {
  test(`${method} ${CANONICAL_PATH} with no headers returns 402, never a 200 bundle`, async () => {
    installFetchMock();
    const res = makeRes();
    await chatHandler(makeReq({ method, url: CANONICAL_PATH, ip: nextIp() }), res);

    assert.equal(res.statusCode, 402);
    assert.notEqual(res.statusCode, 200);
    assert.notEqual(res.body && res.body.type, 'bundle');
  });
}
