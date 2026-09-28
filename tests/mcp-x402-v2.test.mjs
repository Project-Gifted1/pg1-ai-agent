/**
 * Tests for api/mcp.mjs's x402 v2 MCP transport support (issue #130):
 *
 *  (a) an unpaid call to a paid tool returns HTTP 200 with a normal
 *      JSON-RPC result — isError: true, structuredContent equal to the x402
 *      v2 PaymentRequired object, content[0].text parsing to that same
 *      object — plus the PAYMENT-REQUIRED header for backward compat;
 *  (b) a payment supplied via params._meta["x402/payment"] is verified and
 *      settled against a mocked facilitator, and result._meta
 *      ["x402/payment-response"] carries the settlement;
 *  (c) a payment supplied via the PAYMENT-SIGNATURE header still works;
 *  (d) licence key, free tier, free tools, and the 503 verification-
 *      unavailable path are unchanged by any of the above.
 *
 * The real facilitator (Coinbase CDP, real JWT signing, real network calls)
 * is swapped out via api/mcp.mjs's __setX402FacilitatorForTests seam, so
 * none of this needs real CDP credentials or network access.
 *
 * Run with: node --test tests/mcp-x402-v2.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';

const PAY_TO = '0x000000000000000000000000000000000000dEaD';

process.env.X402_PAY_TO_ADDRESS = PAY_TO;
delete process.env.CDP_API_KEY_ID;
delete process.env.CDP_API_KEY_SECRET;

// api/mcp.mjs reads X402_PAY_TO_ADDRESS at module load time to decide
// whether the x402 payment path exists at all, so it must be set before
// this import runs (see tests/ioc-context.test.mjs for the same pattern).
const { default: handler, __setX402FacilitatorForTests } = await import('../api/mcp.mjs');

function makeFakeFacilitator({ verify, settle } = {}) {
  return {
    getSupported: async () => ({ kinds: [{ x402Version: 2, network: 'eip155:8453', scheme: 'exact' }] }),
    verify: verify || (async () => ({ isValid: true })),
    settle: settle || (async () => ({ success: true, transaction: '0xFAKE_TX', network: 'eip155:8453', payer: '0xPayer' }))
  };
}

beforeEach(() => {
  __setX402FacilitatorForTests(() => makeFakeFacilitator());
});

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    getHeader(key) { return this.headers[key]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
  return res;
}

function makeReq(body, extraHeaders) {
  return { method: 'POST', headers: extraHeaders || {}, body };
}

async function callTool(name, args, { headers, meta } = {}) {
  const params = { name, arguments: args };
  if (meta) params._meta = meta;
  const req = makeReq({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }, headers);
  const res = makeRes();
  await handler(req, res);
  return res;
}

function mockAttackBundleFetch() {
  return async (url) => {
    if (String(url).includes('mitre/cti')) {
      return {
        ok: true,
        json: async () => ({
          objects: [
            { type: 'intrusion-set', id: 'intrusion-set--1', name: 'APT29', aliases: ['Cozy Bear'], external_references: [{ source_name: 'mitre-attack', external_id: 'G0016' }] }
          ]
        })
      };
    }
    throw new Error('unexpected fetch: ' + url);
  };
}

// --- (a) unpaid call -------------------------------------------------

test('unpaid call to a paid tool returns HTTP 200 with isError, structuredContent, content[0].text, and the PAYMENT-REQUIRED header', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = mockAttackBundleFetch();
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool('get_threat_actor_profile', { actor_name: 'APT29' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.jsonrpc, '2.0');
  assert.equal(res.body.result.isError, true);

  const structured = res.body.result.structuredContent;
  assert.equal(structured.x402Version, 2);
  assert.ok(structured.resource);
  assert.ok(Array.isArray(structured.accepts) && structured.accepts.length > 0);
  assert.equal(structured.accepts[0].payTo, PAY_TO);
  assert.ok(structured.error);

  assert.equal(res.body.result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(res.body.result.content[0].text), structured);

  const headerRequired = decodePaymentRequiredHeader(res.headers['PAYMENT-REQUIRED']);
  assert.deepEqual(headerRequired, structured);
});

// --- (b) params._meta["x402/payment"] ---------------------------------

test('a payment via params._meta["x402/payment"] is verified, the tool runs, settlement is attached to result._meta, and PAYMENT-RESPONSE is set', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = mockAttackBundleFetch();
  t.after(() => { global.fetch = originalFetch; });

  let verifyCalls = 0;
  let settleCalls = 0;
  __setX402FacilitatorForTests(() => makeFakeFacilitator({
    verify: async () => { verifyCalls += 1; return { isValid: true }; },
    settle: async () => { settleCalls += 1; return { success: true, transaction: '0xMETA_TX', network: 'eip155:8453', payer: '0xMetaPayer' }; }
  }));

  // Discover the accepted requirements shape the same way a real client
  // would: from an initial unpaid call's PaymentRequired.accepts.
  const unpaid = await callTool('get_threat_actor_profile', { actor_name: 'APT29' });
  const accepted = unpaid.body.result.structuredContent.accepts[0];

  const paymentPayload = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    accepted,
    payload: { signature: '0xsig', authorization: { from: '0xMetaPayer', to: accepted.payTo, value: accepted.amount } }
  };

  const res = await callTool('get_threat_actor_profile', { actor_name: 'APT29' }, { meta: { 'x402/payment': paymentPayload } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, undefined);
  assert.equal(res.body.result.content[0].type, 'text');
  assert.equal(JSON.parse(res.body.result.content[0].text).actor_name, 'APT29');
  assert.equal(verifyCalls, 1);
  assert.equal(settleCalls, 1);

  assert.deepEqual(res.body.result._meta['x402/payment-response'], { success: true, transaction: '0xMETA_TX', network: 'eip155:8453', payer: '0xMetaPayer' });

  const headerSettlement = decodePaymentResponseHeader(res.headers['PAYMENT-RESPONSE']);
  assert.deepEqual(headerSettlement, res.body.result._meta['x402/payment-response']);
});

test('when both _meta and a header payment are present, _meta is preferred (a garbage header does not block the call)', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = mockAttackBundleFetch();
  t.after(() => { global.fetch = originalFetch; });

  const unpaid = await callTool('get_threat_actor_profile', { actor_name: 'APT29' });
  const accepted = unpaid.body.result.structuredContent.accepts[0];
  const paymentPayload = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    accepted,
    payload: { signature: '0xsig', authorization: { from: '0xMetaPayer', to: accepted.payTo, value: accepted.amount } }
  };

  const res = await callTool('get_threat_actor_profile', { actor_name: 'APT29' }, {
    meta: { 'x402/payment': paymentPayload },
    headers: { 'payment-signature': 'not-valid-base64-json' }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, undefined);
});

// --- (c) PAYMENT-SIGNATURE header (existing mechanism) ------------------

test('a payment via the PAYMENT-SIGNATURE header still works and settles', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = mockAttackBundleFetch();
  t.after(() => { global.fetch = originalFetch; });

  const unpaid = await callTool('get_threat_actor_profile', { actor_name: 'APT29' });
  const accepted = unpaid.body.result.structuredContent.accepts[0];
  const paymentPayload = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    accepted,
    payload: { signature: '0xsig', authorization: { from: '0xHeaderPayer', to: accepted.payTo, value: accepted.amount } }
  };

  const res = await callTool('get_threat_actor_profile', { actor_name: 'APT29' }, {
    headers: { 'payment-signature': encodePaymentSignatureHeader(paymentPayload) }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, undefined);
  assert.ok(res.body.result._meta['x402/payment-response']);
  assert.ok(res.headers['PAYMENT-RESPONSE']);
});

// --- (4) verification / settlement failure -------------------------------

test('a verification failure returns the same payment-required tool result, HTTP 200, without running the tool', async (t) => {
  const originalFetch = global.fetch;
  let attackBundleFetched = false;
  global.fetch = async (url) => {
    if (String(url).includes('mitre/cti')) { attackBundleFetched = true; return { ok: true, json: async () => ({ objects: [] }) }; }
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => { global.fetch = originalFetch; });

  __setX402FacilitatorForTests(() => makeFakeFacilitator({
    verify: async () => ({ isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' })
  }));

  const unpaid = await callTool('get_threat_actor_profile', { actor_name: 'APT29' });
  const accepted = unpaid.body.result.structuredContent.accepts[0];
  const paymentPayload = { x402Version: 2, scheme: 'exact', network: 'eip155:8453', accepted, payload: { signature: '0xbad' } };

  const res = await callTool('get_threat_actor_profile', { actor_name: 'APT29' }, { meta: { 'x402/payment': paymentPayload } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.structuredContent.error, /invalid_exact_evm_payload_signature/);
  assert.equal(attackBundleFetched, false, 'tool must not run when verification fails');
});

test('a settlement failure (after the tool already succeeded) returns the same payment-required tool result, HTTP 200', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = mockAttackBundleFetch();
  t.after(() => { global.fetch = originalFetch; });

  __setX402FacilitatorForTests(() => makeFakeFacilitator({
    settle: async () => ({ success: false, errorReason: 'insufficient_funds', errorMessage: 'Insufficient USDC balance', network: 'eip155:8453' })
  }));

  const unpaid = await callTool('get_threat_actor_profile', { actor_name: 'APT29' });
  const accepted = unpaid.body.result.structuredContent.accepts[0];
  const paymentPayload = { x402Version: 2, scheme: 'exact', network: 'eip155:8453', accepted, payload: { signature: '0xsig' } };

  const res = await callTool('get_threat_actor_profile', { actor_name: 'APT29' }, { meta: { 'x402/payment': paymentPayload } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.structuredContent.error, /Insufficient USDC balance/);
  assert.equal(res.headers['PAYMENT-RESPONSE'], undefined);
});

// --- (d) unchanged behaviour ---------------------------------------------

test('unchanged: a genuinely invalid license key still returns a plain 402 JSON-RPC error, not the x402 v2 wrapped result', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.gumroad.com')) return { ok: true, json: async () => ({ success: false }) };
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => { global.fetch = originalFetch; });

  const req = makeReq(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_threat_actor_profile', arguments: { actor_name: 'APT29' } } },
    { 'x-api-key': 'bad-license-key' }
  );
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error.code, -32001);
  assert.equal(res.body.result, undefined);
});

test('unchanged: license verification unavailable still returns 503 + Retry-After: 5', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.gumroad.com')) throw new Error('gumroad unreachable');
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => { global.fetch = originalFetch; });

  const req = makeReq(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_threat_actor_profile', arguments: { actor_name: 'APT29' } } },
    { 'x-api-key': 'timeout-license-key' }
  );
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, -32003);
  assert.equal(res.headers['Retry-After'], '5');
});

test('unchanged: free tier still grants access with no payment or settlement metadata attached', async (t) => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  t.after(() => {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('free_tier_usage') && urlStr.includes('select=request_count')) {
      return { ok: true, json: async () => [] };
    }
    if (urlStr.includes('free_tier_usage')) {
      return { ok: true, json: async () => ([]) };
    }
    if (urlStr.includes('mitre/cti')) {
      return mockAttackBundleFetch()(url);
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool('get_threat_actor_profile', { actor_name: 'APT29' }, { headers: { 'x-free-tier': '1' } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, undefined);
  assert.equal(res.body.result._meta, undefined);
  assert.equal(res.headers['PAYMENT-RESPONSE'], undefined);
  assert.equal(res.headers['PAYMENT-REQUIRED'], undefined);
});

test('unchanged: always-free tools stay free with x402 configured', async (t) => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  t.after(() => {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('free_tier_usage')) return { ok: true, json: async () => [] };
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => { global.fetch = originalFetch; });

  const res = await callTool('get_usage_status', { identifier: 'someone' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, undefined);
  assert.equal(res.headers['PAYMENT-REQUIRED'], undefined);
});
