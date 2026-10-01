/**
 * Tests that MCP and A2A JSON-RPC responses keep a clean envelope: the top
 * level holds only jsonrpc, id and result (or error). The per-request
 * request_id lives inside result (and structuredContent) for successes,
 * inside error.data for errors, and always in the X-Request-Id header -
 * never at the top level of the envelope.
 * Run with: node --test tests/jsonrpc-envelope.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_VALUES } from '../lib/fixtures.mjs';

const { default: mcpHandler } = await import('../api/mcp.mjs');
const { default: a2aHandler } = await import('../api/a2a.mjs');

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
}

async function callMcp(body) {
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: {}, body }, res);
  return res;
}

async function callA2a(skill, args) {
  const res = makeRes();
  await a2aHandler({
    method: 'POST',
    headers: {},
    query: {},
    body: { jsonrpc: '2.0', id: 7, method: 'message/send', params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { skill, arguments: args } }] } } }
  }, res);
  return res;
}

// No call here should need the network; fail any fetch so nothing leaks out.
function blockFetch(t) {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('fetch blocked in envelope test'); };
  t.after(() => { global.fetch = original; });
}

function assertEnvelope(res, kind, label) {
  const requestId = res.headers['X-Request-Id'];
  assert.ok(requestId, `${label}: X-Request-Id header`);
  assert.deepEqual(Object.keys(res.body).sort(), ['id', 'jsonrpc', kind].sort(), `${label}: envelope keys`);
  if (kind === 'error') assert.equal(res.body.error.data.request_id, requestId, `${label}: error.data.request_id`);
  return requestId;
}

test('MCP: envelope contains only jsonrpc, id and result/error', async (t) => {
  blockFetch(t);

  assertEnvelope(await callMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), 'result', 'initialize');
  assertEnvelope(await callMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), 'result', 'tools/list');

  const ok = await callMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_domain_age', arguments: { domain: FIXTURE_VALUES.domain.FLAGGED } } });
  const okId = assertEnvelope(ok, 'result', 'tools/call result');
  assert.equal(ok.body.result.structuredContent.request_id, okId);
  assert.equal(JSON.parse(ok.body.result.content[0].text).request_id, okId);

  const isError = await callMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_wallet_age', arguments: { address: FIXTURE_VALUES.wallet.UNKNOWN } } });
  const isErrorId = assertEnvelope(isError, 'result', 'tools/call isError result');
  assert.equal(JSON.parse(isError.body.result.content[0].text).request_id, isErrorId);

  const unavailable = await callMcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'check_wallet_sanctions', arguments: { address: FIXTURE_VALUES.wallet.UNKNOWN } } });
  assert.equal(unavailable.statusCode, 503);
  assertEnvelope(unavailable, 'error', 'tools/call 503');
  assert.equal(unavailable.body.error.data.test_fixture, true);

  assertEnvelope(await callMcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }), 'error', 'unknown tool');
  assertEnvelope(await callMcp({ jsonrpc: '2.0', id: 7, method: 'no/such/method' }), 'error', 'method not found');

  const parse = makeRes();
  await mcpHandler({ method: 'POST', headers: {}, body: '{not json' }, parse);
  assertEnvelope(parse, 'error', 'parse error');
});

test('A2A: envelope contains only jsonrpc, id and result/error', async (t) => {
  blockFetch(t);

  const ok = await callA2a('check_domain_age', { domain: FIXTURE_VALUES.domain.FLAGGED });
  const okId = assertEnvelope(ok, 'result', 'message/send result');
  assert.equal(ok.body.result.artifacts[0].parts[0].data.request_id, okId);

  const toolError = await callA2a('check_wallet_age', { address: FIXTURE_VALUES.wallet.UNKNOWN });
  assertEnvelope(toolError, 'error', 'tool error');
  assert.equal(toolError.body.error.data.code, 'upstream_unavailable');

  const unavailable = await callA2a('check_wallet_sanctions', { address: FIXTURE_VALUES.wallet.UNKNOWN });
  assert.equal(unavailable.statusCode, 503);
  assertEnvelope(unavailable, 'error', '503');

  const res = makeRes();
  await a2aHandler({ method: 'POST', headers: {}, query: {}, body: { jsonrpc: '2.0', id: 9, method: 'no/such/method' } }, res);
  assertEnvelope(res, 'error', 'method not found');
});
