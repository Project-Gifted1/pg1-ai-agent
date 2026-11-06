/**
 * A2A 1.0 conformance of /api/a2a (A2A Registry, 6 Nov 2026: the official
 * SDK could not parse a bare Task as the SendMessage result).
 *
 * 1.0 (A2A-Version: 1.0) replies follow the 1.0 ProtoJSON schema the
 * official SDKs (a2a-sdk, @a2a-js/sdk) parse:
 *   - SendMessage -> SendMessageResponse { task } (never a bare Task);
 *   - no "kind" discriminator anywhere; TASK_STATE_* / ROLE_* enum names;
 *     every Part holds exactly one of text / raw / url / data;
 *   - errors: HTTP 200, error.data = [google.rpc.ErrorInfo] with string
 *     metadata, 1.0 codes (VersionNotSupportedError -32009).
 * 0.3 replies are unchanged: the Task itself with "kind": "task".
 * The official Python SDK run is in tests/a2a-official-sdk.test.mjs.
 * Run with: node --test tests/a2a-v1-conformance.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
// No database, no network: telemetry and error logs are no-ops, and any
// outbound call fails the test.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.X402_PAY_TO_ADDRESS = '0x000000000000000000000000000000000000dEaD';

const mcp = await import('../api/mcp.mjs');
const { default: handler } = await import('../api/a2a.mjs');
const { FIXTURE_VALUES } = await import('../lib/fixtures.mjs');

before(() => {
  global.fetch = async (url) => { throw new Error('unexpected fetch: ' + url); };
  mcp.__setX402FacilitatorForTests(() => ({
    getSupported: async () => ({ kinds: [{ x402Version: 2, network: 'eip155:8453', scheme: 'exact' }] }),
    verify: async () => ({ isValid: false }),
    settle: async () => ({ success: false })
  }));
});
after(() => {
  global.fetch = ORIGINAL_FETCH;
  mcp.__setX402FacilitatorForTests(null);
  process.env = { ...ORIGINAL_ENV };
});

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }
  };
}

async function rpc(method, params, headers = {}, body) {
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'x-forwarded-for': '198.51.100.40', ...headers }, query: {}, body: body !== undefined ? body : { jsonrpc: '2.0', id: 'c-1', method, params } }, res);
  return res;
}

const V1 = { 'a2a-version': '1.0' };
const textMessage = (text, extra = {}) => ({ message: { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text }], ...extra } });
const skillMessage = (skill, args) => ({ message: { messageId: 'm-2', role: 'ROLE_USER', parts: [{ data: { skill, arguments: args }, mediaType: 'application/json' }] } });

const TASK_STATES = new Set(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED']);
const FIELDS = {
  Task: ['id', 'contextId', 'status', 'artifacts', 'history', 'metadata'],
  TaskStatus: ['state', 'message', 'timestamp'],
  Message: ['messageId', 'contextId', 'taskId', 'role', 'parts', 'metadata', 'extensions', 'referenceTaskIds'],
  Part: ['text', 'raw', 'url', 'data', 'metadata', 'filename', 'mediaType'],
  Artifact: ['artifactId', 'name', 'description', 'parts', 'metadata', 'extensions']
};

function onlyFields(obj, type, where) {
  for (const key of Object.keys(obj)) assert.ok(FIELDS[type].includes(key), `${where}: "${key}" is not a 1.0 ${type} field`);
}

function assertV1Part(part, where) {
  onlyFields(part, 'Part', where);
  const content = ['text', 'raw', 'url', 'data'].filter((k) => part[k] !== undefined);
  assert.equal(content.length, 1, `${where}: exactly one of text/raw/url/data`);
}

function assertV1Message(message, where) {
  onlyFields(message, 'Message', where);
  assert.equal(typeof message.messageId, 'string', `${where}.messageId`);
  assert.ok(['ROLE_USER', 'ROLE_AGENT'].includes(message.role), `${where}.role ${message.role}`);
  assert.ok(Array.isArray(message.parts) && message.parts.length > 0, `${where}.parts`);
  message.parts.forEach((p, i) => assertV1Part(p, `${where}.parts[${i}]`));
}

// A 1.0 Task, field by field (unknown fields would be dropped by a lenient
// parser and rejected by a strict one).
function assertV1Task(task) {
  onlyFields(task, 'Task', 'task');
  assert.equal(typeof task.id, 'string');
  assert.equal(typeof task.contextId, 'string');
  onlyFields(task.status, 'TaskStatus', 'task.status');
  assert.ok(TASK_STATES.has(task.status.state), `task.status.state ${task.status.state}`);
  assert.ok(!Number.isNaN(Date.parse(task.status.timestamp)), 'task.status.timestamp is RFC 3339');
  if (task.status.message) assertV1Message(task.status.message, 'task.status.message');
  (task.history || []).forEach((m, i) => assertV1Message(m, `task.history[${i}]`));
  (task.artifacts || []).forEach((a, i) => {
    onlyFields(a, 'Artifact', `task.artifacts[${i}]`);
    assert.equal(typeof a.artifactId, 'string');
    a.parts.forEach((p, j) => assertV1Part(p, `task.artifacts[${i}].parts[${j}]`));
  });
  assert.doesNotMatch(JSON.stringify({ ...task, metadata: undefined }), /"kind":/, 'no "kind" discriminator in a 1.0 Task');
}

function assertSendMessageResponse(res) {
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.jsonrpc, '2.0');
  assert.equal(res.body.error, undefined);
  assert.deepEqual(Object.keys(res.body.result), ['task'], 'SendMessageResponse holds "task" (never a bare Task)');
  assertV1Task(res.body.result.task);
  return res.body.result.task;
}

// --- 1.0 success shapes ----------------------------------------------------------

test('1.0 plain text SendMessage returns a SendMessageResponse with a completed task', async () => {
  const res = await rpc('SendMessage', textMessage('Hello, what can you do?'), V1);
  const task = assertSendMessageResponse(res);
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.status.message.role, 'ROLE_AGENT');
  assert.match(task.status.message.parts[0].text, /^PG1 Sovereign Threat Intelligence/);
  assert.equal(task.artifacts[0].name, 'about_pg1');
  assert.deepEqual(task.history[0].parts, [{ text: 'Hello, what can you do?' }]);
});

test('1.0 accepts the patch form of the version ("1.0.0") and the query param', async () => {
  assertSendMessageResponse(await rpc('SendMessage', textMessage('hi'), { 'a2a-version': '1.0.0' }));
  const res = makeRes();
  await handler({ method: 'POST', headers: {}, query: { 'A2A-Version': '1.0' }, body: { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: textMessage('hi') } }, res);
  assertSendMessageResponse(res);
});

test('1.0 echoes a 0.3-shaped inbound part in history as a 1.0 Part (no "kind")', async () => {
  const res = await rpc('SendMessage', { message: { messageId: 'm-9', role: 'user', kind: 'message', parts: [{ kind: 'text', text: 'hi' }, { kind: 'file', file: { uri: 'https://example.com/a.pdf', mimeType: 'application/pdf', name: 'a.pdf' } }] } }, V1);
  const task = assertSendMessageResponse(res);
  assert.deepEqual(task.history[0].parts, [{ text: 'hi' }, { url: 'https://example.com/a.pdf', filename: 'a.pdf', mediaType: 'application/pdf' }]);
  assert.equal(task.history[0].role, 'ROLE_USER');
});

test('1.0 skill result (documented fixture) is a SendMessageResponse with a completed task and a data artifact', async () => {
  const res = await rpc('SendMessage', skillMessage('check_wallet_sanctions', { address: FIXTURE_VALUES.wallet.FLAGGED }), V1);
  const task = assertSendMessageResponse(res);
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.artifacts[0].parts[0].mediaType, 'application/json');
  assert.equal(task.artifacts[0].parts[0].data.status, 'flagged');
  assert.deepEqual(task.history.map((m) => m.role), ['ROLE_USER', 'ROLE_AGENT']);
});

test('1.0 paid skill without payment: SendMessageResponse with an input-required task carrying the x402 PaymentRequired', async () => {
  const res = await rpc('SendMessage', skillMessage('get_threat_actor_profile', { actor_name: 'APT29' }), { ...V1, 'x-free-tier': '0' });
  const task = assertSendMessageResponse(res);
  assert.equal(task.status.state, 'TASK_STATE_INPUT_REQUIRED');
  const meta = task.status.message.metadata;
  assert.equal(meta['x402.payment.status'], 'payment-required');
  assert.equal(meta['x402.payment.required'].x402Version, 2);
  assert.equal(meta['x402.payment.required'].accepts[0].network, 'eip155:8453');
  assert.equal(task.artifacts, undefined);
});

// --- 0.3 unchanged ------------------------------------------------------------------

test('0.3 (no header, or A2A-Version: 0.3) is unchanged: the Task itself with "kind": "task"', async () => {
  for (const headers of [{}, { 'a2a-version': '0.3' }]) {
    const res = await rpc('message/send', { message: { messageId: 'm-3', role: 'user', kind: 'message', parts: [{ kind: 'text', text: 'hi' }] } }, headers);
    assert.equal(res.statusCode, 200);
    const task = res.body.result;
    assert.equal(task.kind, 'task');
    assert.equal(task.task, undefined, 'not wrapped');
    assert.equal(task.status.state, 'completed');
    assert.equal(task.status.message.kind, 'message');
    assert.equal(task.status.message.role, 'agent');
    assert.ok(task.status.message.parts.every((p) => typeof p.kind === 'string'));
  }
});

test('0.3 errors are unchanged: the HTTP status and an object error.data', async () => {
  const res = await rpc('message/send', { message: { messageId: 'm-4', role: 'user', parts: [{ kind: 'data', data: { skill: 'no_such_skill', arguments: {} } }] } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, -32602);
  assert.equal(typeof res.body.error.data.request_id, 'string');
  assert.equal(res.body.error.data.unknown_skill, true);
});

// --- 1.0 errors ----------------------------------------------------------------------

function assertV1Error(res, code, reason, domain = 'a2a-protocol.org') {
  assert.equal(res.statusCode, 200, 'a 1.0 JSON-RPC error is HTTP 200');
  assert.equal(res.body.jsonrpc, '2.0');
  assert.equal(res.body.result, undefined);
  const { error } = res.body;
  assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
  assert.ok(Array.isArray(error.data) && error.data.length === 1, 'error.data is an array of typed details');
  const info = error.data[0];
  assert.deepEqual(Object.keys(info).sort(), ['@type', 'domain', 'metadata', 'reason']);
  assert.equal(info['@type'], 'type.googleapis.com/google.rpc.ErrorInfo');
  assert.equal(info.reason, reason);
  assert.equal(info.domain, domain);
  for (const [k, v] of Object.entries(info.metadata)) assert.equal(typeof v, 'string', `metadata.${k} is a string (map<string, string>)`);
  assert.match(info.metadata.request_id, /^[0-9a-f-]{36}$/);
  return info;
}

test('1.0 errors: HTTP 200, 1.0 codes, data = [google.rpc.ErrorInfo] with string metadata', async () => {
  assertV1Error(await rpc('GetTask', { id: 'unknown' }, V1), -32001, 'TASK_NOT_FOUND');
  assertV1Error(await rpc('CancelTask', { id: 'unknown' }, V1), -32001, 'TASK_NOT_FOUND');
  assertV1Error(await rpc('SendStreamingMessage', textMessage('hi'), V1), -32004, 'UNSUPPORTED_OPERATION');
  assertV1Error(await rpc('SubscribeToTask', { id: 'x' }, V1), -32004, 'UNSUPPORTED_OPERATION');
  assertV1Error(await rpc('ListTasks', {}, V1), -32004, 'UNSUPPORTED_OPERATION');
  assertV1Error(await rpc('GetExtendedAgentCard', {}, V1), -32004, 'UNSUPPORTED_OPERATION');
  for (const m of ['CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig']) {
    assertV1Error(await rpc(m, {}, V1), -32003, 'PUSH_NOTIFICATION_NOT_SUPPORTED');
  }
  assertV1Error(await rpc('NoSuchMethod', {}, V1), -32601, 'METHOD_NOT_FOUND');
  const unknown = assertV1Error(await rpc('SendMessage', skillMessage('no_such_skill', {}), V1), -32602, 'INVALID_PARAMS');
  assert.equal(unknown.metadata.unknown_skill, 'true');
  assertV1Error(await rpc('SendMessage', undefined, V1, 'not json {'), -32700, 'PARSE_ERROR');
});

test('1.0 errors: PG1 codes carry PG1\'s domain; nested details are JSON strings', async () => {
  const outage = assertV1Error(await rpc('SendMessage', skillMessage('check_wallet_sanctions', { address: FIXTURE_VALUES.wallet.UNKNOWN }), V1), -32010, 'SERVICE_UNAVAILABLE', 'pg1-ai-agent.vercel.app');
  assert.equal(outage.metadata.test_fixture, 'true');
  const toolError = assertV1Error(await rpc('SendMessage', skillMessage('check_wallet_age', { address: FIXTURE_VALUES.wallet.UNKNOWN }), V1), -32000, 'TOOL_ERROR', 'pg1-ai-agent.vercel.app');
  assert.equal(toolError.metadata.code, 'upstream_unavailable');
  assert.ok(Array.isArray(JSON.parse(toolError.metadata.checks)), 'checks kept, as a JSON string');
});

test('an unsupported A2A-Version answers VersionNotSupportedError (-32009) in the 1.0 shape', async () => {
  for (const v of ['2.0', '0.2', 'latest']) {
    const res = await rpc('SendMessage', textMessage('hi'), { 'a2a-version': v });
    assertV1Error(res, -32009, 'VERSION_NOT_SUPPORTED');
    assert.match(res.body.error.message, /Unsupported A2A-Version/);
  }
});
