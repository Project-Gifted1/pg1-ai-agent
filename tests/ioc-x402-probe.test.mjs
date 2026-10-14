/**
 * x402scan probe for GET /api/ioc: an unauthenticated scanner request with
 * no input must get the x402 v2 402 challenge (not a 400 or a free bundle),
 * with
 * accepts[].amount in USDC atomic units ($0.01 = "10000") and matching the
 * price advertised in lib/x402Config.mjs. Runs with PG1_FEED_PAID=true: by
 * default the feed is free and there is no challenge (tests/feed-pricing).
 *
 * Drives the real api/chat.mjs x402 setup. Only the network is stubbed: a
 * throwaway Ed25519 key stands in for the CDP API key (so JWT signing works
 * offline), and global.fetch answers the facilitator's /supported call.
 *
 * Run with: node --test tests/ioc-x402-probe.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decodePaymentRequiredHeader } from '@x402/core/http';

// These tests exercise the paid /api/ioc gate, so the feed is made paid
// (it is free by default while it holds no current data; tests/feed-pricing.test.mjs).
process.env.PG1_FEED_PAID = 'true';

const PAY_TO = '0x000000000000000000000000000000000000dEaD';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function throwawayCdpSecret() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return Buffer.concat([seed, pub]).toString('base64');
}

process.env.X402_PAY_TO_ADDRESS = PAY_TO;
process.env.CDP_API_KEY_ID = 'test-key-id';
process.env.CDP_API_KEY_SECRET = throwawayCdpSecret();
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.GUMROAD_PRODUCT_ID;

const fetchedUrls = [];
global.fetch = async (url) => {
  const u = String(url);
  fetchedUrls.push(u);
  if (u.endsWith('/x402/supported')) {
    return new Response(JSON.stringify({ kinds: [{ x402Version: 2, network: 'eip155:8453', scheme: 'exact' }], extensions: [], signers: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

// api/chat.mjs builds its x402 middleware at module load from the env above.
const { default: chatHandler } = await import('../api/chat.mjs');

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    getHeader(key) { return this.headers[key]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.done = true; return this; },
    send(payload) { this.body = payload; this.done = true; return this; },
    end(payload) { if (payload !== undefined) this.body = payload; this.done = true; return this; }
  };
}

// When the x402 middleware writes its 402 it never calls next(), so the
// handler's promise stays pending; wait for the response to be written.
async function probe(method, url) {
  const res = makeRes();
  // The free tier is automatic (lib/freeTier.mjs) except for scanners by
  // User-Agent, which must still see the challenge they list a resource by.
  chatHandler({ method, url, headers: { host: 'pg1-ai-agent.vercel.app', 'user-agent': 'x402scan/1.0' }, socket: { remoteAddress: '203.0.113.9' } }, res);
  for (let i = 0; i < 200 && !res.done; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(res.done, 'handler never wrote a response');
  return res;
}

// The advertised price. openapi.json carries no x-payment-info for /api/ioc
// while the feed is free, so the paid price comes from lib/x402Config.mjs,
// the single source every discovery file is checked against.
async function advertisedPriceUsd() {
  const { x402PriceUsd } = await import('../lib/x402Config.mjs');
  return x402PriceUsd();
}

for (const url of ['/api/ioc', '/api/ioc?limit=1']) {
  test(`unauthenticated GET ${url} returns the x402 v2 challenge, not a 400`, async () => {
    const res = await probe('GET', url);
    assert.equal(res.statusCode, 402);
    assert.equal(res.body.x402Version, 2);
    assert.equal(res.body.resource.url.split('?')[0], 'https://pg1-ai-agent.vercel.app/api/ioc');
    assert.ok(Array.isArray(res.body.accepts) && res.body.accepts.length === 1);
    assert.deepEqual(decodePaymentRequiredHeader(res.headers['PAYMENT-REQUIRED']), res.body);
  });
}

test('accepts[].amount is USDC atomic units ("10000" = $0.01) on Base, matching the advertised price', async () => {
  const res = await probe('GET', '/api/ioc');
  const [accept] = res.body.accepts;
  assert.equal(accept.scheme, 'exact');
  assert.equal(accept.network, 'eip155:8453');
  assert.equal(accept.asset, BASE_USDC);
  assert.equal(accept.payTo, PAY_TO);
  assert.equal(accept.amount, '10000');
  assert.match(accept.amount, /^\d+$/, 'amount must be an integer string, never decimal dollars');
  assert.equal(Math.round(Number(await advertisedPriceUsd()) * 1e6), Number(accept.amount));
});

test('the 402 probe never touches threat data or Gumroad', async () => {
  fetchedUrls.length = 0;
  await probe('GET', '/api/ioc');
  assert.ok(!fetchedUrls.some((u) => u.includes('threat_ioc_telemetry') || u.includes('gumroad')), fetchedUrls.join('\n'));
});
