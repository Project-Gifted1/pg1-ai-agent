// /api/sandbox/mcp: the PG1 Sandbox's MCP server (JSON-RPC over HTTP POST),
// separate from /api/mcp so the public tool list there is unchanged. By
// invitation only: every request needs a sandbox key (Authorization: Bearer
// <key>, or X-PG1-Sandbox-Key) whose row carries the "sandbox" scope; any
// other key, a licence key included, is refused before any tool runs.
// Quotas (worlds, steps a day, storage) come with clear errors.
// Worlds are data, never code (lib/sandbox/engine.mjs); they are simulations.

import crypto from 'node:crypto';
import { defaultSandboxStore } from '../../lib/sandbox/store.mjs';
import { resolveSandboxKey, keyFromRequest, SandboxError } from '../../lib/sandbox/worlds.mjs';
import { SANDBOX_TOOLS, callSandboxTool } from '../../lib/sandbox/mcp.mjs';

export const config = { maxDuration: 15 };
export const SANDBOX_SERVER_INFO = Object.freeze({ name: 'pg1-sandbox', version: '1.0.0' });

let storeFactory = () => defaultSandboxStore();
export function __setSandboxStore(f) { storeFactory = f || (() => defaultSandboxStore()); }

const rpc = (res, status, id, body) => res.status(status).json({ jsonrpc: '2.0', id: id === undefined ? null : id, ...body });

export default async function handler(req, res) {
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ ...SANDBOX_SERVER_INFO, status: 'invitation only', protocol: 'Model Context Protocol (JSON-RPC over HTTP POST)', note: 'Every request needs a PG1 sandbox key. Worlds are simulations.', request_id: requestId });
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed', request_id: requestId }); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return rpc(res, 400, null, { error: { code: -32700, message: 'Parse error: send one JSON-RPC request', data: { request_id: requestId } } });
  const { id, method, params } = body;
  if (typeof method !== 'string') return rpc(res, 400, id, { error: { code: -32600, message: 'Invalid Request', data: { request_id: requestId } } });
  if (id === undefined || method.startsWith('notifications/')) return res.status(202).end();

  // Every method, initialize included, is behind the key: nothing about the
  // sandbox is served to anyone not invited.
  const store = storeFactory();
  let who;
  try {
    who = await resolveSandboxKey(store, keyFromRequest(req));
  } catch (e) {
    if (e instanceof SandboxError) return rpc(res, e.status, id, { error: { code: -32001, message: e.message, data: { code: e.code, request_id: requestId } } });
    return rpc(res, 503, id, { error: { code: -32003, message: 'Sandbox access could not be checked; retry shortly.', data: { request_id: requestId } } });
  }

  try {
    if (method === 'initialize') return rpc(res, 200, id, { result: { protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(params && params.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: SANDBOX_SERVER_INFO, instructions: 'PG1 Sandbox. Worlds are JSON data stepped by a deterministic engine; they are simulations, never real events.' } });
    if (method === 'ping') return rpc(res, 200, id, { result: {} });
    if (method === 'tools/list') return rpc(res, 200, id, { result: { tools: SANDBOX_TOOLS } });
    if (method === 'tools/call') {
      const out = await callSandboxTool(store, who, params && params.name, params && params.arguments);
      if (out.error) {
        if (out.error.code === 'unknown_tool') return rpc(res, 200, id, { error: { code: -32602, message: out.error.message, data: { request_id: requestId } } });
        return rpc(res, 200, id, { result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: true, code: out.error.code, message: out.error.message, request_id: requestId }) }] } });
      }
      const result = { ...out.result, request_id: requestId };
      return rpc(res, 200, id, { result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } });
    }
    return rpc(res, 200, id, { error: { code: -32601, message: `Method not found: ${method}`, data: { request_id: requestId } } });
  } catch (e) {
    console.error('[sandbox] unhandled:', e && e.message);
    return rpc(res, 500, id, { error: { code: -32603, message: 'Internal error', data: { request_id: requestId } } });
  }
}
