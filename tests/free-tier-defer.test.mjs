/**
 * Tests that the free tier (5 calls/day/IP, opt-in via "x-free-tier: 1") only
 * spends one of its daily calls once the request it gates actually succeeds
 * — a downstream failure (Supabase unreachable, upstream feed down, etc.)
 * must not burn a free-tier call for nothing. Covers both call sites that
 * share lib/freeTier.mjs's checkFreeTierAvailable/consumeFreeTier split:
 * api/chat.mjs's GET /api/ioc, and api/mcp.mjs's tools/call for a standard
 * paid tool (get_threat_indicators).
 *
 * Run with: node --test tests/free-tier-defer.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.USER_API_KEY = 'test-operator';
process.env.USER_API_PASS = 'test-secret-pass';
delete process.env.X402_PAY_TO_ADDRESS;
delete process.env.GUMROAD_PRODUCT_ID;

const { default: chatHandler } = await import('../api/chat.mjs');
const { default: mcpHandler } = await import('../api/mcp.mjs');

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    rawBody: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    getHeader(key) { return this.headers[key]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end(payload) {
      this.rawBody = payload;
      if (typeof payload === 'string') {
        try { this.body = JSON.parse(payload); } catch (e) {}
      }
      return this;
    }
  };
  return res;
}

// --- api/chat.mjs: GET /api/ioc ------------------------------------------

function installIocFetchMock(telemetryOk) {
  const freeTierWrites = [];
  global.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    if (urlStr.includes('/rest/v1/free_tier_usage')) {
      if (!options.method || options.method === 'GET') {
        return { ok: true, json: async () => [] };
      }
      freeTierWrites.push(options.method);
      return { ok: true, json: async () => ({}) };
    }
    if (urlStr.includes('/rest/v1/threat_ioc_telemetry')) {
      if (!telemetryOk) return { ok: false, status: 503, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ([{
          indicator_type: 'IPv4', value: '198.51.100.23', confidence_score: 75,
          last_seen: '2026-09-24T12:00:00Z', ingested_at: '2026-09-20T00:00:00Z', verification_source: 'test'
        }])
      };
    }
    if (urlStr.includes('/rest/v1/api_access_logs')) {
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  };
  return freeTierWrites;
}

test('/api/ioc free tier: a downstream failure does not consume a free-tier call', async (t) => {
  const originalFetch = global.fetch;
  const freeTierWrites = installIocFetchMock(false);
  t.after(() => { global.fetch = originalFetch; });

  const req = {
    method: 'GET', url: '/api/ioc', headers: { 'x-free-tier': '1' },
    socket: { remoteAddress: '10.2.0.1' }
  };
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 503);
  assert.deepEqual(freeTierWrites, [], 'no PATCH/POST to free_tier_usage on a failed bundle fetch');
});

test('/api/ioc free tier: a successful bundle consumes exactly one free-tier call', async (t) => {
  const originalFetch = global.fetch;
  const freeTierWrites = installIocFetchMock(true);
  t.after(() => { global.fetch = originalFetch; });

  const req = {
    method: 'GET', url: '/api/ioc', headers: { 'x-free-tier': '1' },
    socket: { remoteAddress: '10.2.0.2' }
  };
  const res = makeRes();
  await chatHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(freeTierWrites.length, 1, 'exactly one write to free_tier_usage on a successful bundle');
});

// --- api/mcp.mjs: tools/call (get_threat_indicators) ----------------------

function installMcpFetchMock(telemetryOk) {
  const freeTierWrites = [];
  global.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    if (urlStr.includes('/rest/v1/free_tier_usage')) {
      if (!options.method || options.method === 'GET') {
        return { ok: true, json: async () => [] };
      }
      freeTierWrites.push(options.method);
      return { ok: true, json: async () => ({}) };
    }
    if (urlStr.includes('/rest/v1/threat_ioc_telemetry')) {
      if (!telemetryOk) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, json: async () => ([]) };
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
  return freeTierWrites;
}

async function callFreeTierTool() {
  const req = {
    method: 'POST',
    headers: { 'x-free-tier': '1' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_threat_indicators', arguments: {} } }
  };
  const res = makeRes();
  await mcpHandler(req, res);
  return res;
}

test('/api/mcp free tier: a tool failure does not consume a free-tier call', async (t) => {
  const originalFetch = global.fetch;
  const freeTierWrites = installMcpFetchMock(false);
  t.after(() => { global.fetch = originalFetch; });

  const res = await callFreeTierTool();

  assert.equal(res.statusCode, 503);
  assert.deepEqual(freeTierWrites, [], 'no PATCH/POST to free_tier_usage when the gated tool call fails');
});

test('/api/mcp free tier: a successful tool call consumes exactly one free-tier call', async (t) => {
  const originalFetch = global.fetch;
  const freeTierWrites = installMcpFetchMock(true);
  t.after(() => { global.fetch = originalFetch; });

  const res = await callFreeTierTool();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, undefined);
  assert.equal(freeTierWrites.length, 1, 'exactly one write to free_tier_usage on a successful tool call');
});
