/**
 * Issue #201 Phase 2b — lib/errorLog.mjs:
 *  - logApiError() never writes for a 402 (paywall responses are expected,
 *    not errors).
 *  - a new (source, route, status, reason) group inserts a fresh row.
 *  - a repeat of the same group PATCHes the existing row (increments count,
 *    bumps last_seen/time) instead of inserting a new one.
 *  - message/reason are capped in length.
 *  - a Supabase failure never throws (best-effort, fire-and-forget caller).
 *
 * Run with: node --test tests/error-log-lib.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { logApiError } from '../lib/errorLog.mjs';

const ORIGINAL_FETCH = globalThis.fetch;

after(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function installFetchMock(calls, { existingRow = null } = {}) {
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if ((options.method || 'GET') === 'GET') {
      return { ok: true, json: async () => (existingRow ? [existingRow] : []) };
    }
    return { ok: true, json: async () => ({}) };
  };
}

test('does nothing when supUrl/supKey are missing', async () => {
  const calls = [];
  installFetchMock(calls);
  await logApiError('', '', { source: 'server', route: 'CHAT', status: 500, reason: 'x' });
  assert.equal(calls.length, 0);
});

test('never writes anything for a 402 (paywall) response', async () => {
  const calls = [];
  installFetchMock(calls);
  await logApiError('https://example.supabase.co', 'key', { source: 'server', route: 'IOC', status: 402, reason: 'payment_required' });
  assert.equal(calls.length, 0);
});

test('inserts a new row when no matching group exists', async () => {
  const calls = [];
  installFetchMock(calls, { existingRow: null });
  await logApiError('https://example.supabase.co', 'key', { source: 'server', route: 'CHAT', status: 401, reason: 'unauthenticated', message: 'unauthenticated' });

  const getCall = calls.find((c) => c.method === 'GET');
  const postCall = calls.find((c) => c.method === 'POST');
  assert.ok(getCall, 'expected a lookup GET');
  assert.ok(getCall.url.includes('resolved=eq.false'));
  assert.ok(postCall, 'expected an insert POST');
  assert.equal(postCall.body.source, 'server');
  assert.equal(postCall.body.route, 'CHAT');
  assert.equal(postCall.body.status, 401);
  assert.equal(postCall.body.reason, 'unauthenticated');
  assert.equal(postCall.body.count, 1);
  assert.equal(postCall.body.resolved, false);
});

test('patches (increments count) an existing unresolved group instead of inserting', async () => {
  const calls = [];
  installFetchMock(calls, { existingRow: { id: 'row-1', count: 3 } });
  await logApiError('https://example.supabase.co', 'key', { source: 'server', route: 'CHAT', status: 500, reason: 'exception' });

  const patchCall = calls.find((c) => c.method === 'PATCH');
  const postCall = calls.find((c) => c.method === 'POST');
  assert.ok(patchCall, 'expected a PATCH to the existing row');
  assert.ok(patchCall.url.includes('id=eq.row-1'));
  assert.equal(patchCall.body.count, 4);
  assert.ok(!postCall, 'must not also insert a new row');
});

test('caps message and reason length rather than storing them unbounded', async () => {
  const calls = [];
  installFetchMock(calls, { existingRow: null });
  await logApiError('https://example.supabase.co', 'key', {
    source: 'server', route: 'CHAT', status: 500,
    reason: 'r'.repeat(1000), message: 'm'.repeat(1000)
  });
  const postCall = calls.find((c) => c.method === 'POST');
  assert.ok(postCall.body.reason.length <= 120);
  assert.ok(postCall.body.message.length <= 300);
});

test('a Supabase/network failure is swallowed, never thrown', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  await assert.doesNotReject(
    logApiError('https://example.supabase.co', 'key', { source: 'server', route: 'CHAT', status: 500, reason: 'x' })
  );
});
