/**
 * Drive PG1's /api/a2a with the official A2A JavaScript SDK (@a2a-js/sdk).
 * Not a dependency of this repo; install it next to this run, e.g.
 *   npm i --no-save @a2a-js/sdk@1.3.0
 * Usage: node tests/sdk/official-a2a-js-client.mjs <base-url> [1.0|0.3 ...]
 *
 * For each protocol version: the SDK's ClientFactory resolves the agent card,
 * keeping only that version's JSON-RPC interface, so the SDK's own transport
 * factory picks its v1.0 JSON-RPC transport or (legacyCompat) its v0.3 one.
 * Then the same four checks as tests/sdk/official_a2a_client.py: a plain text
 * message, a paid skill without payment, GetTask on an unknown id, and an
 * unknown skill. Prints a transcript and one JSON line {"ok": bool, ...};
 * exits 1 if any check fails.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AgentCard, SendMessageRequest, GetTaskRequest, TaskState } from '@a2a-js/sdk';
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from '@a2a-js/sdk/client';

const require = createRequire(import.meta.url);
// package.json is not in the package's exports map: read it beside the resolved entry point.
const sdkVersion = (() => {
  try {
    let dir = path.dirname(require.resolve('@a2a-js/sdk'));
    while (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch { return 'unknown'; }
})();

const base = process.argv[2];
const versions = process.argv.slice(3).length ? process.argv.slice(3) : ['1.0', '0.3'];

// Built from ProtoJSON with the SDK's own codecs.
const textMessage = (text) => SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }] } });
const skillMessage = (skill, args) => SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { skill, arguments: args }, mediaType: 'application/json' }] } });

const stateName = (state) => TaskState[state] || String(state);
const firstText = (task) => {
  const part = (task.status?.message?.parts || []).find((p) => p.content?.$case === 'text');
  return part ? part.content.value.split('\n')[0] : '';
};
const isTask = (result) => result && typeof result === 'object' && 'status' in result && 'id' in result;

async function runVersion(version) {
  const results = {};
  const raw = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
  const card = AgentCard.fromJSON(raw);
  console.log(`[${version}] card: ${card.name} v${card.version}; interfaces ${card.supportedInterfaces.map((i) => `${i.protocolBinding} ${i.protocolVersion}`).join(', ')}`);
  card.supportedInterfaces = card.supportedInterfaces.filter((i) => i.protocolVersion === version);
  const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({ legacyCompat: { enabled: true } })]
  }));
  const client = await factory.createFromAgentCard(card);
  console.log(`[${version}] SDK transport: ${client.transport.constructor.name} (A2A-Version ${client.protocolVersion})`);
  try {
    const plain = await client.sendMessage(textMessage('Hello, what can you do?'));
    const ok = isTask(plain) && stateName(plain.status.state) === 'TASK_STATE_COMPLETED';
    console.log(`[${version}] plain text -> ${isTask(plain) ? `Task ${plain.id} state=${stateName(plain.status.state)}; artifacts=${JSON.stringify(plain.artifacts.map((a) => a.name))}; reply="${firstText(plain)}"` : JSON.stringify(plain)}`);
    results.plain_text = ok && plain.artifacts.length > 0;

    const paid = await client.sendMessage(skillMessage('get_threat_actor_profile', { actor_name: 'APT29' }), { serviceParameters: { 'X-Free-Tier': '0' } });
    const meta = (isTask(paid) && paid.status.message && paid.status.message.metadata) || {};
    const required = meta['x402.payment.required'] || {};
    const accepts = (required.accepts || [])[0] || {};
    console.log(`[${version}] paid skill unpaid -> Task ${paid.id} state=${stateName(paid.status.state)}; x402.payment.status=${meta['x402.payment.status']}; x402Version=${required.x402Version}; accepts[0]={scheme: ${accepts.scheme}, network: ${accepts.network}, amount: ${accepts.amount}}`);
    results.paid_unpaid = isTask(paid) && stateName(paid.status.state) === 'TASK_STATE_INPUT_REQUIRED' && meta['x402.payment.status'] === 'payment-required' && !!accepts.payTo;

    try {
      await client.getTask(GetTaskRequest.fromJSON({ id: randomUUID() }));
      console.log(`[${version}] GetTask unknown id -> no error (unexpected)`);
      results.get_task_not_found = false;
    } catch (err) {
      console.log(`[${version}] GetTask unknown id -> ${err.constructor.name}: ${err.message}`);
      results.get_task_not_found = /TaskNotFound/.test(err.constructor.name);
    }

    try {
      await client.sendMessage(skillMessage('no_such_skill', {}));
      console.log(`[${version}] unknown skill -> no error (unexpected)`);
      results.unknown_skill_error = false;
    } catch (err) {
      console.log(`[${version}] unknown skill -> ${err.constructor.name}: ${String(err.message).slice(0, 160)}`);
      results.unknown_skill_error = true;
    }
  } catch (err) {
    console.log(`[${version}] FAILED: ${err.constructor.name}: ${err.message}`);
    results.exception = false;
  }
  return results;
}

console.log(`@a2a-js/sdk ${sdkVersion} (official A2A JavaScript SDK)`);
const summary = {};
for (const version of versions) summary[version] = await runVersion(version);
const ok = Object.values(summary).every((r) => Object.keys(r).length && Object.values(r).every(Boolean));
console.log(JSON.stringify({ ok, results: summary }));
process.exit(ok ? 0 : 1);
