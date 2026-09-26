/**
 * Tests for lib/paymentGate.mjs's verifyGumroadLicense (issue #115): shared
 * Gumroad license verification used by api/chat.mjs, api/mcp.mjs and
 * api/ioc/context.js. Covers subscription-lapse handling, the
 * increment_uses_count=false request flag, the 10min success cache, and the
 * 2s timeout with cache fallback.
 * Run with: node --test tests/paymentGate.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyGumroadLicense } from '../lib/paymentGate.mjs';

function withMockFetch(t, impl) {
  const originalFetch = global.fetch;
  global.fetch = impl;
  t.after(() => {
    global.fetch = originalFetch;
  });
}

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

test('accepts an active membership', async (t) => {
  withMockFetch(t, async () => jsonResponse({ success: true, purchase: {} }));

  const result = await verifyGumroadLicense('active-membership-key');
  assert.equal(result.valid, true);
});

test('rejects a refunded purchase', async (t) => {
  withMockFetch(t, async () => jsonResponse({ success: true, purchase: { refunded: true } }));

  const result = await verifyGumroadLicense('refunded-key');
  assert.equal(result.valid, false);
});

test('rejects a chargebacked purchase', async (t) => {
  withMockFetch(t, async () => jsonResponse({ success: true, purchase: { chargebacked: true } }));

  const result = await verifyGumroadLicense('chargebacked-key');
  assert.equal(result.valid, false);
});

test('rejects an unsuccessful verify result', async (t) => {
  withMockFetch(t, async () => jsonResponse({ success: false }));

  const result = await verifyGumroadLicense('unsuccessful-key');
  assert.equal(result.valid, false);
});

test('rejects a subscription that has already ended', async (t) => {
  withMockFetch(t, async () => jsonResponse({
    success: true,
    purchase: { subscription_ended_at: new Date(Date.now() - 60_000).toISOString() }
  }));

  const result = await verifyGumroadLicense('ended-subscription-key');
  assert.equal(result.valid, false);
});

test('rejects a subscription cancelled at exactly now', async (t) => {
  withMockFetch(t, async () => jsonResponse({
    success: true,
    purchase: { subscription_cancelled_at: new Date(Date.now()).toISOString() }
  }));

  const result = await verifyGumroadLicense('cancelled-now-key');
  assert.equal(result.valid, false);
});

test('accepts a future-dated cancellation — stays valid until that time', async (t) => {
  withMockFetch(t, async () => jsonResponse({
    success: true,
    purchase: { subscription_cancelled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
  }));

  const result = await verifyGumroadLicense('future-cancellation-key');
  assert.equal(result.valid, true);
});

test('rejects a failed subscription payment', async (t) => {
  withMockFetch(t, async () => jsonResponse({
    success: true,
    purchase: { subscription_failed_at: new Date().toISOString() }
  }));

  const result = await verifyGumroadLicense('failed-payment-key');
  assert.equal(result.valid, false);
});

test('sends increment_uses_count=false on the verify request', async (t) => {
  let capturedBody = null;
  withMockFetch(t, async (url, options) => {
    capturedBody = options.body.toString();
    return jsonResponse({ success: true, purchase: {} });
  });

  await verifyGumroadLicense('increment-flag-key');
  assert.match(capturedBody, /increment_uses_count=false/);
});

test('reuses a cached successful verification instead of hitting Gumroad again', async (t) => {
  let callCount = 0;
  withMockFetch(t, async () => {
    callCount += 1;
    return jsonResponse({ success: true, purchase: {} });
  });

  const first = await verifyGumroadLicense('cached-key');
  const second = await verifyGumroadLicense('cached-key');
  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
  assert.equal(callCount, 1, 'second call should be served from cache, not hit Gumroad again');
});

test('does not cache a failed verification', async (t) => {
  let callCount = 0;
  withMockFetch(t, async () => {
    callCount += 1;
    return jsonResponse({ success: false });
  });

  await verifyGumroadLicense('uncached-failure-key');
  await verifyGumroadLicense('uncached-failure-key');
  assert.equal(callCount, 2, 'failures must not be cached — each call should hit Gumroad again');
});

test('falls back to a cached success when the Gumroad request times out', async (t) => {
  let callCount = 0;
  withMockFetch(t, async () => {
    callCount += 1;
    if (callCount === 1) {
      return jsonResponse({ success: true, purchase: {} });
    }
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });

  const first = await verifyGumroadLicense('timeout-with-cache-key');
  assert.equal(first.valid, true);

  const second = await verifyGumroadLicense('timeout-with-cache-key');
  assert.equal(second.valid, true, 'a timed-out request with a prior cached success should still resolve as valid');
});

test('returns a clear error when the Gumroad request times out with no cached success', async (t) => {
  withMockFetch(t, async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });

  const result = await verifyGumroadLicense('timeout-no-cache-key');
  assert.equal(result.valid, false);
  assert.match(result.error, /timed out/i);
});

test('issue #117: a timeout with no cached success is tagged reason: verification_unavailable, distinct from a bad key', async (t) => {
  withMockFetch(t, async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });

  const result = await verifyGumroadLicense('timeout-reason-key');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'verification_unavailable');
});

test('issue #117: a network/fetch error with no cached success is tagged reason: verification_unavailable', async (t) => {
  withMockFetch(t, async () => {
    throw new Error('getaddrinfo ENOTFOUND api.gumroad.com');
  });

  const result = await verifyGumroadLicense('network-error-key');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'verification_unavailable');
});

test('issue #117: a timeout that falls back to a cached success has no verification_unavailable reason', async (t) => {
  let callCount = 0;
  withMockFetch(t, async () => {
    callCount += 1;
    if (callCount === 1) {
      return jsonResponse({ success: true, purchase: {} });
    }
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });

  const first = await verifyGumroadLicense('timeout-cache-fallback-reason-key');
  assert.equal(first.valid, true);

  const second = await verifyGumroadLicense('timeout-cache-fallback-reason-key');
  assert.equal(second.valid, true);
  assert.equal(second.reason, undefined, 'a resolved cached success should not carry a verification_unavailable reason');
});

test('issue #117: a genuinely invalid key (Gumroad reachable, success:false) has no verification_unavailable reason', async (t) => {
  withMockFetch(t, async () => jsonResponse({ success: false }));

  const result = await verifyGumroadLicense('genuinely-invalid-key');
  assert.equal(result.valid, false);
  assert.notEqual(result.reason, 'verification_unavailable');
});

test('issue #117: a refunded purchase (Gumroad reachable) has no verification_unavailable reason', async (t) => {
  withMockFetch(t, async () => jsonResponse({ success: true, purchase: { refunded: true } }));

  const result = await verifyGumroadLicense('refunded-reason-key');
  assert.equal(result.valid, false);
  assert.notEqual(result.reason, 'verification_unavailable');
});

test('never echoes the raw license key back in an error result', async (t) => {
  const rawKey = 'super-secret-license-key-value';
  withMockFetch(t, async () => jsonResponse({ success: false }));

  const result = await verifyGumroadLicense(rawKey);
  assert.equal(result.valid, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(rawKey));
});
