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

function makeReq(method, params, extraHeaders, query) {
  return {
    method: 'POST',
    headers: extraHeaders || {},
    query: query || {},
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

async function callSkill(method, skill, args, extraHeaders, query) {
  const req = makeReq(method, sendMessageParams(skill, args), extraHeaders, query);
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
  assert.equal(res.body.protocol, 'Agent2Agent (A2A) over JSON-RPC 2.0');
  assert.deepEqual(res.body.supportedVersions, ['1.0', '0.3']);
});

test('unsupported HTTP method returns 405', async () => {
  const req = { method: 'PUT', headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test('unknown JSON-RPC method returns a -32601 error', async () => {
  const req = makeReq('tasks/frobnicate', {});
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
  assert.deepEqual(skillIds.sort(), ['check_domain_age', 'check_hostname_reputation', 'check_wallet_sanctions', 'check_wallet_age', 'get_usage_status', 'check_ip_abuse'].sort());

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

function withUsageStatusFetch(t) {
  withSupabaseEnv(t);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/free_tier_usage')) return { ok: true, json: async () => [] };
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => { global.fetch = originalFetch; });
}

test('version negotiation: missing A2A-Version defaults to 0.3 shape', async (t) => {
  withUsageStatusFetch(t);
  const res = await callSkill('SendMessage', 'get_usage_status', { identifier: 'v03-default' });
  assert.equal(res.statusCode, 200);
  const task = res.body.result;
  assert.equal(task.kind, 'task');
  assert.equal(task.status.state, 'completed');
  assert.equal(task.artifacts[0].parts[0].kind, 'data');
  assert.equal(task.history[0].role, 'user');
  assert.equal(task.history[0].kind, 'message');
  assert.equal(task.history[1].role, 'agent');
  assert.ok(task.id);
  assert.ok(task.contextId);
  assert.ok(task.artifacts[0].artifactId);
});

test('version negotiation: empty A2A-Version header also defaults to 0.3 shape', async (t) => {
  withUsageStatusFetch(t);
  const res = await callSkill('SendMessage', 'get_usage_status', { identifier: 'v03-empty' }, { 'a2a-version': '' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.kind, 'task');
  assert.equal(res.body.result.status.state, 'completed');
});

test('version negotiation: A2A-Version: 1.0 header switches to the 1.0 shape', async (t) => {
  withUsageStatusFetch(t);
  const res = await callSkill('SendMessage', 'get_usage_status', { identifier: 'v10' }, { 'a2a-version': '1.0' });
  assert.equal(res.statusCode, 200);
  const task = res.body.result;
  assert.equal(task.kind, undefined);
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  const part = task.artifacts[0].parts[0];
  assert.equal(part.kind, undefined);
  assert.equal(part.mediaType, 'application/json');
  assert.ok(part.data);
  assert.equal(task.history[0].role, 'ROLE_USER');
  assert.equal(task.history[0].kind, undefined);
  assert.equal(task.history[1].role, 'ROLE_AGENT');
});

test('version negotiation: A2A-Version query param is honored when the header is absent', async (t) => {
  withUsageStatusFetch(t);
  const res = await callSkill('SendMessage', 'get_usage_status', { identifier: 'v10-query' }, {}, { 'A2A-Version': '1.0' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.status.state, 'TASK_STATE_COMPLETED');
});

test('version negotiation: an unsupported A2A-Version returns VersionNotSupportedError', async (t) => {
  withUsageStatusFetch(t);
  const res = await callSkill('SendMessage', 'get_usage_status', { identifier: 'v99' }, { 'a2a-version': '2.0' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, -32008);
  assert.match(res.body.error.message, /Unsupported A2A-Version/);
});

test('SendMessage accepts a 1.0-shaped DataPart (no "kind", { data, mediaType }) regardless of negotiated version', async (t) => {
  withUsageStatusFetch(t);
  const req = makeReq('SendMessage', {
    message: {
      role: 'user',
      messageId: 'msg-1.0',
      parts: [{ data: { skill: 'get_usage_status', arguments: { identifier: 'v10-part' } }, mediaType: 'application/json' }]
    }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.status.state, 'completed');
});

test('contextId: a client-supplied contextId is preserved on the returned Task', async (t) => {
  withUsageStatusFetch(t);
  const req = makeReq('SendMessage', {
    message: {
      role: 'user',
      messageId: 'msg-ctx',
      contextId: 'client-context-123',
      parts: [{ kind: 'data', data: { skill: 'get_usage_status', arguments: { identifier: 'ctx-test' } } }]
    }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.contextId, 'client-context-123');
});

test('SendStreamingMessage / message/stream return UnsupportedOperationError', async () => {
  for (const method of ['SendStreamingMessage', 'message/stream']) {
    const req = makeReq(method, {});
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.body.error.code, -32004, `expected UnsupportedOperationError for ${method}`);
  }
});

test('SubscribeToTask / tasks/resubscribe return UnsupportedOperationError', async () => {
  for (const method of ['SubscribeToTask', 'tasks/resubscribe']) {
    const req = makeReq(method, {});
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.body.error.code, -32004, `expected UnsupportedOperationError for ${method}`);
  }
});

test('push notification config methods return PushNotificationNotSupportedError', async () => {
  const methods = [
    'SetTaskPushNotificationConfig', 'tasks/pushNotificationConfig/set',
    'GetTaskPushNotificationConfig', 'tasks/pushNotificationConfig/get',
    'ListTaskPushNotificationConfig', 'tasks/pushNotificationConfig/list',
    'DeleteTaskPushNotificationConfig', 'tasks/pushNotificationConfig/delete'
  ];
  for (const method of methods) {
    const req = makeReq(method, {});
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.body.error.code, -32003, `expected PushNotificationNotSupportedError for ${method}`);
  }
});

test('GetExtendedAgentCard returns UnsupportedOperationError', async () => {
  for (const method of ['GetExtendedAgentCard', 'agent/getAuthenticatedExtendedCard']) {
    const req = makeReq(method, {});
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.body.error.code, -32004, `expected UnsupportedOperationError for ${method}`);
  }
});

test('GetTask / CancelTask return TaskNotFoundError since tasks are not persisted', async () => {
  for (const method of ['GetTask', 'tasks/get', 'CancelTask', 'tasks/cancel']) {
    const req = makeReq(method, {});
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.body.error.code, -32001, `expected TaskNotFoundError for ${method}`);
  }
});
