#!/usr/bin/env node
// pg1-guard as an MCP server (stdio). Any MCP client can ask it, before an
// action, whether the action may run:
//
//   check_action   { tool, args }  → { decision: allow | ask | block, reasons }
//   recent_actions { limit }       → the latest log entries, secrets withheld
//
// The policy is read from the file named by PG1_GUARD_POLICY (JSON), or the
// default policy. "ask" means: get a person's approval before running it.
// Run: npx pg1-guard-mcp   (or node sdk/guard/mcp.mjs)

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolvePolicy, evaluate, newState, record } from './policy.mjs';
import { createLog, jsonlSink } from './log.mjs';

const VERSION = '0.1.0';
const PROTOCOL = '2025-06-18';

export const TOOLS = [
  {
    name: 'check_action',
    description: 'Check one action against the guard policy before running it. Returns allow (run it), ask (get a person\'s approval first) or block (do not run it), with the reasons. Money never moves without approval.',
    inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'The name of the tool about to be called.' }, args: { type: 'object', description: 'The arguments it will be called with.' } }, required: ['tool'] }
  },
  {
    name: 'recent_actions',
    description: 'The latest actions the guard checked, newest last, with secrets withheld.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } }
  }
];

export function createServer({ policy = null, log = createLog(), clock = () => Date.now() } = {}) {
  const resolved = resolvePolicy(policy || {});
  const state = newState();
  let n = 0;
  const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
  const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj });

  return function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return msg && msg.id != null ? error(msg.id, -32600, 'invalid request') : null;
    const { id, method, params = {} } = msg;
    if (id == null) return null; // notifications need no reply
    if (method === 'initialize') return result(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'pg1-guard', version: VERSION } });
    if (method === 'ping') return result(id, {});
    if (method === 'tools/list') return result(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params.name;
      const args = params.arguments || {};
      if (name === 'check_action') {
        if (!args.tool || typeof args.tool !== 'string') return result(id, { ...text({ error: 'tool is required' }), isError: true });
        const action = { id: `act_${(++n).toString(36)}`, tool: args.tool, args: args.args && typeof args.args === 'object' ? args.args : {} };
        log.write('proposed', action);
        const d = evaluate(resolved, action, state, clock());
        log.write('decided', action, { decision: d.decision, reasons: d.reasons });
        if (d.decision === 'allow') record(state, action, d, clock());
        return result(id, text({ action_id: action.id, decision: d.decision, reasons: d.reasons.map((r) => r.detail), rules: d.reasons.map((r) => r.rule) }));
      }
      if (name === 'recent_actions') {
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 20));
        return result(id, text({ actions: log.entries().slice(-limit) }));
      }
      return error(id, -32602, `unknown tool ${name}`);
    }
    return error(id, -32601, `method not found: ${method}`);
  };
}

async function main() {
  const file = process.env.PG1_GUARD_POLICY;
  const policy = file ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const log = createLog({ sink: process.env.PG1_GUARD_LOG ? jsonlSink(process.env.PG1_GUARD_LOG) : null });
  const handle = createServer({ policy, log });
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let reply;
    try { reply = handle(JSON.parse(line)); } catch { reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }; }
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  }
}

if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].endsWith('pg1-guard-mcp'))) main();
