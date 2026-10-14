/**
 * PG1's HTTP 402 pattern, as described from the outside (Tom Smart, weekly
 * #14, checked on 26 Sep 2026): a 402 on GET and on POST that carries the
 * x402 v2 PaymentRequired object in the PAYMENT-REQUIRED header (base64 JSON)
 * AND the same object, mirrored, as the JSON response body, with identical
 * accepts. Clients that read only the header and clients that read only the
 * body must see the same challenge.
 *
 * Pinned on every HTTP route that answers 402 today: /api/ioc (when the feed
 * is paid, PG1_FEED_PAID=true) on GET and POST, /api/preflight on GET and
 * POST, /api/hosting-advisor (POST) and /api/watchlists (POST):
 *   - status 402, PAYMENT-REQUIRED present and decodable;
 *   - the body is exactly the decoded header (deep-equal);
 *   - the v2 fields and values below are present.
 * Future changes may only ADD fields, and an added field goes in both the
 * header and the body (the deep-equal keeps them mirrored). Removing or
 * renaming a pinned field, or changing a pinned value, fails here.
 * Run with: node --test tests/x402-header-body-mirror.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decodePaymentRequiredHeader } from '@x402/core/http';

const PAY_TO = '0x000000000000000000000000000000000000dEaD';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function throwawayCdpSecret() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return Buffer.concat([seed, pub]).toString('base64');
}

// Module-load configuration (api/chat.mjs builds its x402 middleware on import).
process.env.PG1_FEED_PAID = 'true';
process.env.X402_PAY_TO_ADDRESS = PAY_TO;
process.env.CDP_API_KEY_ID = 'test-key-id';
process.env.CDP_API_KEY_SECRET = throwawayCdpSecret();
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.PG1_WATCHLIST_SECRET = 'w'.repeat(40);
delete process.env.GUMROAD_PRODUCT_ID;

global.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith('/x402/supported')) {
    return new Response(JSON.stringify({ kinds: [{ x402Version: 2, network: 'eip155:8453', scheme: 'exact' }], extensions: [], signers: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
};

const { default: chatHandler } = await import('../api/chat.mjs');
const { default: preflightHandler } = await import('../api/preflight.mjs');
const { default: hostingHandler } = await import('../api/hosting-advisor.mjs');
const { default: watchlistsHandler, __setWatchlistDeps } = await import('../api/watchlists.mjs');
__setWatchlistDeps({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] });

function makeRes() {
  return {
    statusCode: null, body: null, headers: {}, done: false,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; this.done = true; return this; },
    send(p) { this.body = p; this.done = true; return this; },
    end(p) { if (p !== undefined) this.body = p; this.done = true; return this; }
  };
}

// The x402 middleware never calls next() on a 402, so wait for the write.
async function call(handler, req) {
  const res = makeRes();
  handler({ socket: { remoteAddress: '203.0.113.9' }, query: {}, ...req }, res);
  for (let i = 0; i < 300 && !res.done; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(res.done, 'no response written');
  return res;
}

// A scanner as an x402 catalogue probe sends it: no key, no payment, and the
// free tier declined (scanners by User-Agent are never given the free tier).
const PROBE = { host: 'pg1-ai-agent.vercel.app', 'user-agent': 'x402scan/1.0', 'x-free-tier': '0', 'content-type': 'application/json' };
const WALLET = '0x' + '11'.repeat(20);

const ROUTES = [
  ['GET /api/ioc', chatHandler, { method: 'GET', url: '/api/ioc', headers: PROBE }],
  ['POST /api/ioc', chatHandler, { method: 'POST', url: '/api/ioc', headers: PROBE, body: {} }],
  ['GET /api/preflight', preflightHandler, { method: 'GET', url: '/api/preflight', headers: PROBE, query: { action: 'pay', target: WALLET } }],
  ['POST /api/preflight', preflightHandler, { method: 'POST', url: '/api/preflight', headers: PROBE, body: { action: 'pay', target: WALLET } }],
  ['POST /api/hosting-advisor', hostingHandler, { method: 'POST', url: '/api/hosting-advisor', headers: PROBE, body: { workload_type: 'web_api', latency_regions: ['eu_central'] } }],
  ['POST /api/watchlists', watchlistsHandler, { method: 'POST', url: '/api/watchlists', headers: PROBE, body: { items: [{ kind: 'domain', target: 'example.com' }], webhook_url: 'https://hooks.example.com/x' } }]
];

for (const [name, handler, req] of ROUTES) {
  test(`${name}: 402 with the x402 v2 PAYMENT-REQUIRED header mirrored exactly in the body`, async () => {
    const res = await call(handler, req);
    assert.equal(res.statusCode, 402);

    const raw = res.headers['PAYMENT-REQUIRED'];
    assert.ok(typeof raw === 'string' && raw.length > 0, 'PAYMENT-REQUIRED header present');
    const header = decodePaymentRequiredHeader(raw);
    assert.deepEqual(JSON.parse(Buffer.from(raw, 'base64').toString('utf8')), header, 'the header is plain base64 JSON');

    const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    assert.deepEqual(body, header, 'the body is the decoded header, field for field');
    assert.deepEqual(body.accepts, header.accepts, 'identical accepts');

    // Pinned v2 fields: may be added to, never removed, renamed or changed.
    assert.equal(header.x402Version, 2);
    assert.equal(typeof header.error, 'string');
    assert.equal(typeof header.resource?.url, 'string');
    assert.ok(header.resource.url.startsWith('https://'), 'resource.url is absolute');
    assert.equal(typeof header.resource.description, 'string');
    assert.equal(typeof header.resource.mimeType, 'string');
    assert.ok(Array.isArray(header.accepts) && header.accepts.length >= 1, 'at least one accepts entry');
    const base = header.accepts.find((a) => a.network === 'eip155:8453');
    assert.ok(base, 'a Base mainnet accepts entry');
    assert.equal(base.scheme, 'exact');
    assert.equal(base.asset, BASE_USDC);
    assert.equal(base.payTo, PAY_TO);
    assert.match(base.amount, /^\d+$/, 'amount in atomic units, as a string');
    assert.equal(typeof base.maxTimeoutSeconds, 'number');
    assert.deepEqual({ name: base.extra?.name, version: base.extra?.version }, { name: 'USD Coin', version: '2' });
  });
}

test('the scanner probe of GET and POST /api/ioc gives the same accepts on both methods', async () => {
  const get = await call(chatHandler, ROUTES[0][2]);
  const post = await call(chatHandler, ROUTES[1][2]);
  assert.deepEqual(post.body.accepts, get.body.accepts);
  assert.deepEqual(post.body.resource, get.body.resource);
});
