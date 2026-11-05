/**
 * A2A Registry readiness (a2aregistry.org): the registry fetches
 * /.well-known/agent-card.json (reachable + schema-valid) and sends a plain
 * A2A message/send with no skill, no payment and no licence. That probe gets
 * a free, completed reply (protocol 0.3 and 1.0) describing PG1, its free
 * and paid skills and how to pay; never a 402 or payment request. The reply
 * is the same for every caller (no User-Agent special case). Paid skills
 * keep their x402 behaviour.
 * Run with: node --test tests/a2a-registry-probe.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { __setScreeningForTests } = await import('../lib/screening.mjs');
__setScreeningForTests(async () => ({ allowed: true, refused: false, unavailable: false, lists: [], cached: false }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: handler, A2A_FREE_SKILL_NAMES, A2A_PAID_SKILL_NAMES } = await import('../api/a2a.mjs');
const { validateAgentCard } = await import('../lib/agentChecks.mjs');

const CARD = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/.well-known/agent-card.json'), 'utf8'));

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; }
  };
}

async function send(message, headers = {}, method = 'message/send') {
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'x-forwarded-for': '198.51.100.44', ...headers }, query: {}, body: { jsonrpc: '2.0', id: 'probe-1', method, params: { message } } }, res);
  return res;
}

function withEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

function noNetwork(t) {
  const original = global.fetch;
  global.fetch = async (url) => { throw new Error('unexpected fetch: ' + url); };
  t.after(() => { global.fetch = original; });
}

function textOf(parts) {
  return parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n');
}

function assertFreeReply(res, version) {
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.jsonrpc, '2.0');
  assert.equal(res.body.id, 'probe-1');
  assert.equal(res.body.error, undefined, 'no JSON-RPC error');
  const task = res.body.result;
  const completed = version === '1.0' ? 'TASK_STATE_COMPLETED' : 'completed';
  assert.equal(task.status.state, completed);
  if (version === '0.3') {
    assert.equal(task.kind, 'task');
    assert.equal(task.status.message.kind, 'message');
    assert.equal(task.status.message.role, 'agent');
    assert.ok(task.status.message.parts.some((p) => p.kind === 'text'));
  } else {
    assert.equal(task.kind, undefined);
    assert.equal(task.status.message.role, 'ROLE_AGENT');
    assert.ok(task.status.message.parts.every((p) => p.kind === undefined));
  }
  const text = textOf(task.status.message.parts);
  assert.match(text, /PG1/);
  for (const name of [...A2A_FREE_SKILL_NAMES, ...A2A_PAID_SKILL_NAMES]) assert.ok(text.includes(name), name);
  assert.match(text, /x402/);
  assert.match(text, /X-API-KEY/);
  assert.ok(task.artifacts.length >= 1);
  // Never a payment request.
  const blob = JSON.stringify(res.body);
  assert.doesNotMatch(blob, /payment-required|input-required|TASK_STATE_INPUT_REQUIRED|"x402\.payment\.required"/);
  assert.equal(task.metadata, undefined);
}

test('agent card: provider and the /docs/agents documentationUrl; still validates', () => {
  assert.equal(CARD.documentationUrl, 'https://pg1-ai-agent.vercel.app/docs/agents');
  assert.deepEqual(CARD.provider, { organization: 'Project-Gifted1', url: 'https://pg1-ai-agent.vercel.app' });
  assert.deepEqual(validateAgentCard(CARD), []);
  assert.deepEqual(CARD.supportedInterfaces.map((i) => i.protocolVersion).sort(), ['0.3', '1.0']);
  assert.ok(fs.existsSync(path.join(ROOT, 'public/docs/agents/index.html')), 'the documentationUrl page exists');
});

test('plain text message/send on 0.3 (no skill, no payment, no licence) returns a completed free reply', async (t) => {
  withEnv(t, { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
  noNetwork(t);
  const res = await send({ role: 'user', messageId: 'm-03', kind: 'message', parts: [{ kind: 'text', text: 'Hello, what can you do?' }] }, { 'user-agent': 'A2A-Registry-TaskProbe/1.0' });
  assertFreeReply(res, '0.3');
  assert.equal(res.body.result.history[0].parts[0].text, 'Hello, what can you do?');
});

test('plain text SendMessage on 1.0 returns a completed free reply', async (t) => {
  withEnv(t, { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
  noNetwork(t);
  const res = await send({ role: 'ROLE_USER', messageId: 'm-10', parts: [{ text: 'Hello' }] }, { 'a2a-version': '1.0', 'user-agent': 'A2A-Registry-Smoke/1.0' }, 'SendMessage');
  assertFreeReply(res, '1.0');
});

test('message/send with A2A-Version 1.0 is the same free reply; the User-Agent makes no difference', async (t) => {
  withEnv(t, { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
  noNetwork(t);
  assertFreeReply(await send({ role: 'ROLE_USER', messageId: 'm-11', parts: [{ text: 'ping' }] }, { 'a2a-version': '1.0' }), '1.0');
  const plain = await send({ role: 'user', messageId: 'm-12', parts: [{ kind: 'text', text: 'ping' }] }, { 'user-agent': 'curl/8.0' });
  const probe = await send({ role: 'user', messageId: 'm-12', parts: [{ kind: 'text', text: 'ping' }] }, { 'user-agent': 'A2A-Registry-TaskProbe/1.0' });
  assertFreeReply(plain, '0.3');
  assertFreeReply(probe, '0.3');
  assert.equal(textOf(plain.body.result.status.message.parts), textOf(probe.body.result.status.message.parts));
});

test('a DataPart without "skill" gets the same free reply', async (t) => {
  withEnv(t, { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
  noNetwork(t);
  assertFreeReply(await send({ role: 'user', messageId: 'm-13', parts: [{ kind: 'data', data: { question: 'hi' } }] }), '0.3');
});

test('a paid skill without payment still asks for payment (x402, input-required)', async (t) => {
  withEnv(t, { X402_PAY_TO_ADDRESS: '0x000000000000000000000000000000000000dEaD', SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
  noNetwork(t);
  const res = await send({ role: 'user', messageId: 'm-paid', parts: [{ kind: 'data', data: { skill: 'get_threat_actor_profile', arguments: { actor_name: 'APT29' } } }] }, { 'x-free-tier': '0' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.status.state, 'input-required');
  assert.equal(res.body.result.metadata['x402.payment.status'], 'payment-required');
  assert.equal(res.body.result.metadata['x402.payment.required'].x402Version, 2);
});
