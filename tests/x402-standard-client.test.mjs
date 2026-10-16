/**
 * Can a standard x402 client pay PG1's MCP payment challenge? End to end,
 * with the official client libraries and no network:
 *   1. an unpaid get_cve_details call returns the x402 v2 PaymentRequired
 *      (isError tool result, structuredContent, PAYMENT-REQUIRED header);
 *   2. @x402/core's x402Client with @x402/evm's exact scheme (what x402
 *      MCP clients use) builds and signs a payment from it with a throwaway
 *      key, picking PG1's only offer (exact, Base, USDC, 0.01 USD to payTo);
 *   3. the payment goes back in params._meta["x402/payment"]; the stand-in
 *      facilitator checks the EIP-3009 authorisation signature for real
 *      (viem verifyTypedData) against the offer before saying it is valid;
 *   4. the tool then runs and the settlement comes back in
 *      result._meta["x402/payment-response"].
 * Only the on-chain settlement itself is stood in for.
 *
 * Run with: node --test tests/x402-standard-client.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { verifyTypedData, getAddress } from 'viem';

const { __setScreeningForTests } = await import('../lib/screening.mjs');
__setScreeningForTests(async () => ({ allowed: true, refused: false, unavailable: false, lists: [], cached: false }));

const PAY_TO = '0x000000000000000000000000000000000000dEaD';
process.env.X402_PAY_TO_ADDRESS = PAY_TO;
delete process.env.CDP_API_KEY_ID;
delete process.env.CDP_API_KEY_SECRET;
delete process.env.PG1_LARGE_MEDIA_IN_VAULT;

const { default: handler, __setX402FacilitatorForTests } = await import('../api/mcp.mjs');

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; }
  };
}

const CVE = { cve: { id: 'CVE-2024-3094', descriptions: [{ lang: 'en', value: 'xz backdoor (test fixture text)' }], metrics: {} } };

test('a standard x402 client pays the MCP 402 challenge and the paid tool then runs', async () => {
  const verified = [];
  __setX402FacilitatorForTests(() => ({
    getSupported: async () => ({ kinds: [{ x402Version: 2, network: 'eip155:8453', scheme: 'exact' }] }),
    async verify(payload, requirements) {
      const auth = payload.payload.authorization;
      const ok = await verifyTypedData({
        address: auth.from,
        domain: { name: requirements.extra.name, version: requirements.extra.version, chainId: 8453, verifyingContract: getAddress(requirements.asset) },
        types: { TransferWithAuthorization: [
          { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
        ] },
        primaryType: 'TransferWithAuthorization',
        message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
        signature: payload.payload.signature
      });
      const matches = getAddress(auth.to) === getAddress(requirements.payTo) && auth.value === requirements.amount;
      verified.push({ ok, matches });
      return ok && matches ? { isValid: true, payer: auth.from } : { isValid: false, invalidReason: 'bad_signature' };
    },
    settle: async (payload) => ({ success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:8453', payer: payload.payload.authorization.from })
  }));
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('services.nvd.nist.gov')) return Response.json({ vulnerabilities: [CVE] });
    if (u.includes('/rest/v1/')) return Response.json([]);
    return Response.json({});
  };

  // 1. the challenge
  const params = { name: 'get_cve_details', arguments: { cve_id: 'CVE-2024-3094' } };
  const headers = { host: 'pg1-ai-agent.vercel.app', 'x-forwarded-for': '203.0.113.50', 'x-free-tier': '0' };
  const unpaid = makeRes();
  await handler({ method: 'POST', url: '/api/mcp', headers, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params } }, unpaid);
  const challenge = unpaid.body.result.structuredContent;
  assert.equal(unpaid.body.result.isError, true);
  assert.equal(challenge.x402Version, 2);
  assert.equal(challenge.accepts.length, 1);
  const offer = challenge.accepts[0];
  assert.deepEqual([offer.scheme, offer.network, offer.amount, getAddress(offer.payTo)], ['exact', 'eip155:8453', '10000', getAddress(PAY_TO)]);
  assert.ok(unpaid.headers['PAYMENT-REQUIRED'], 'the header form is there for HTTP clients');

  // 2. a standard client signs it
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
  const payment = await client.createPaymentPayload(challenge);
  assert.equal(payment.x402Version, 2);

  // 3-4. paid call
  const paid = makeRes();
  await handler({ method: 'POST', url: '/api/mcp', headers, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { ...params, _meta: { 'x402/payment': payment } } } }, paid);
  assert.deepEqual(verified, [{ ok: true, matches: true }], 'the signature is a real EIP-3009 authorisation for the offer');
  assert.ok(!paid.body.result.isError, JSON.stringify(paid.body).slice(0, 300));
  assert.equal(paid.body.result._meta['x402/payment-response'].success, true);
  assert.match(paid.body.result.content[0].text, /CVE-2024-3094/);
});
