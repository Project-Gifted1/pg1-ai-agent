/**
 * Tests for api/a2a.mjs — the A2A (Agent2Agent) JSON-RPC endpoint (issue #150).
 * Covers: SendMessage / message/send aliasing, DataPart extraction, the four
 * always-free skills (reused from api/mcp.mjs, not duplicated), unknown
 * skill / bad argument errors, and that paid MCP tools are not reachable here.
 * Run with: node --test tests/a2a.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { A2A_SKILL_TOOLS } from '../api/a2a.mjs';

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    }
  };
  return res;
}

function makeReq(method, params, extraHeaders) {
  return {
    method: 'POST',
    headers: extraHeaders || {},
    body: { jsonrpc: '2.0', id: 1, method, params }
  };
}

function sendMessageParams(skill, args) {
  return {
    message: {
      role: 'user',
      messageId: 'msg-1',
      parts: [{ kind: 'data', data: { skill, arguments: args } }]
    }
  };
}

async function callSkill(method, skill, args, extraHeaders) {
  const req = makeReq(method, sendMessageParams(skill, args), extraHeaders);
  const res = makeRes();
  await handler(req, res);
  return res;
}

function withSupabaseEnv(t) {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  t.after(() => {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });
}

test('OPTIONS returns 204 with CORS headers', async () => {
  const req = { method: 'OPTIONS', headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('GET returns basic service info', async () => {
  const req = { method: 'GET', headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.protocol, 'Agent2Agent (A2A) v1.0.0 over JSON-RPC 2.0');
});

test('unsupported HTTP method returns 405', async () => {
  const req = { method: 'PUT', headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test('unknown JSON-RPC method returns a -32601 error', async () => {
  const req = makeReq('tasks/get', {});
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.body.jsonrpc, '2.0');
  assert.equal(res.body.error.code, -32601);
});

test('"message/send" (v0.3 name) behaves identically to "SendMessage"', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/free_tier_usage')) return { ok: true, json: async () => [] };
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => { global.fetch = originalFetch; });

  const viaAlias = await callSkill('message/send', 'get_usage_status', { identifier: 'test-caller' });
  const viaPrimary = await callSkill('SendMessage', 'get_usage_status', { identifier: 'test-caller' });

  assert.equal(viaAlias.statusCode, 200);
  assert.equal(viaPrimary.statusCode, 200);
  assert.equal(viaAlias.body.result.status.state, 'completed');
  assert.equal(viaPrimary.body.result.status.state, 'completed');
});

test('missing DataPart returns a clear -32602 error', async () => {
  const req = makeReq('SendMessage', { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, -32602);
  assert.match(res.body.error.message, /DataPart/);
});

test('unknown skill returns a clear -32602 error listing available skills', async () => {
  const res = await callSkill('SendMessage', 'get_threat_indicators', {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, -32602);
  assert.match(res.body.error.message, /Unknown skill/);
  assert.match(res.body.error.message, /check_wallet_sanctions/);
});

test('paid MCP tools are not reachable via A2A', async () => {
  const skillIds = A2A_SKILL_TOOLS.map((t) => t.name);
  assert.deepEqual(skillIds.sort(), ['check_domain_age', 'check_hostname_reputation', 'check_wallet_sanctions', 'get_usage_status'].sort());

  const res = await callSkill('SendMessage', 'subscribe_alerts', { webhook_url: 'https://example.com/hook' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, -32602);
});

test('get_usage_status: returns a completed Task with the tool result as a DataPart', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/free_tier_usage')) {
      return { ok: true, json: async () => [{ request_count: 2 }] };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => { global.fetch = originalFetch; });

  const res = await callSkill('SendMessage', 'get_usage_status', { identifier: 'caller-abc' });
  assert.equal(res.statusCode, 200);
  const task = res.body.result;
  assert.equal(task.kind, 'task');
  assert.equal(task.status.state, 'completed');
  const part = task.artifacts[0].parts[0];
  assert.equal(part.kind, 'data');
  assert.equal(part.data.identifier, 'caller-abc');
  assert.equal(part.data.free_tier_calls_used_today, 2);
});

test('check_wallet_sanctions: malformed address returns an mcpToolError as a JSON-RPC error with code invalid_address', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/sanctioned_wallets')) {
      if (String(url).includes('order=updated_at.desc')) {
        return { ok: true, json: async () => [{ updated_at: '2026-01-01T00:00:00Z' }] };
      }
      return { ok: true, json: async () => [] };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => { global.fetch = originalFetch; });

  const res = await callSkill('SendMessage', 'check_wallet_sanctions', { address: 'not-a-real-address' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.jsonrpc, '2.0');
  assert.equal(res.body.error.code, -32000);
  assert.equal(res.body.error.data.code, 'invalid_address');
});

test('check_wallet_sanctions: a recognised but unlisted address returns listed:false in the completed Task', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/sanctioned_wallets')) {
      if (String(url).includes('order=updated_at.desc')) {
        return { ok: true, json: async () => [{ updated_at: '2026-01-01T00:00:00Z' }] };
      }
      return { ok: true, json: async () => [] };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => { global.fetch = originalFetch; });

  const res = await callSkill('SendMessage', 'check_wallet_sanctions', { address: '0x' + '0'.repeat(40) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.status.state, 'completed');
  assert.equal(res.body.result.artifacts[0].parts[0].data.listed, false);
});

test('check_domain_age: RDAP lookup happy path is returned as a completed Task DataPart', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('data.iana.org/rdap/dns.json')) {
      return { ok: true, json: async () => ({ services: [[['zzz'], ['https://rdap.example/']]] }) };
    }
    if (urlStr.includes('rdap.example')) {
      return {
        ok: true,
        json: async () => ({
          events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }],
          entities: []
        })
      };
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
  t.after(() => { global.fetch = originalFetch; });

  const res = await callSkill('SendMessage', 'check_domain_age', { domain: 'a2a-endpoint-test.zzz' });
  assert.equal(res.statusCode, 200);
  const data = res.body.result.artifacts[0].parts[0].data;
  assert.equal(data.found, true);
  assert.equal(data.domain, 'a2a-endpoint-test.zzz');
});

test('check_hostname_reputation: not_listed hostname is returned as a completed Task DataPart', async (t) => {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/phishing_list_meta')) {
      return { ok: true, json: async () => [{ source: 'MetaMask eth-phishing-detect', tolerance: 3, synced_at: '2026-01-01T00:00:00Z' }] };
    }
    if (urlStr.includes('/phishing_domains') && urlStr.includes('list_type=eq.fuzzylist')) {
      return { ok: true, json: async () => [] };
    }
    if (urlStr.includes('/phishing_domains') && urlStr.includes('list_type=in.(blocklist,allowlist)')) {
      return { ok: true, json: async () => [] };
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
  t.after(() => { global.fetch = originalFetch; });

  const res = await callSkill('SendMessage', 'check_hostname_reputation', { hostname: 'a2a-hostname-test.zzz' });
  assert.equal(res.statusCode, 200);
  const data = res.body.result.artifacts[0].parts[0].data;
  assert.equal(data.verdict, 'not_listed');
  assert.equal(data.hostname, 'a2a-hostname-test.zzz');
});
