/**
 * PG1 Sovereign Threat Intelligence — A2A (Agent2Agent) endpoint
 * Endpoint: /api/a2a
 * Protocol: Agent2Agent (A2A), spec v1.0.0, JSON-RPC 2.0 transport
 *           (https://a2a-protocol.org/latest/specification/)
 *
 * Exposes ONLY the four always-free MCP tools as A2A skills:
 * check_wallet_sanctions, check_domain_age, check_hostname_reputation,
 * get_usage_status. Every tool implementation is imported directly from
 * api/mcp.mjs (no duplicated logic) — names, descriptions, schemas, and
 * rate limits (check_hostname_reputation: 60/hour without a license key)
 * are unchanged from the MCP server.
 *
 * Paid tools are deliberately NOT exposed here; they wait for the A2A
 * licensing/payment story to be worked out.
 *
 * Method names: "SendMessage" (this spec's primary method) and "message/send"
 * (the v0.3 name) are accepted as aliases of the same behavior.
 *
 * Request shape: params.message.parts must contain a DataPart —
 * { kind: "data", data: { skill: "<tool name>", arguments: { ... } } }.
 *
 * Response shape: a Task object with status.state "completed" and a single
 * artifact whose part is a DataPart carrying the tool's JSON result.
 */

import {
  TOOLS,
  handleUsageStatus,
  handleCheckWalletSanctions,
  handleCheckDomainAge,
  handleCheckHostnameReputation
} from './mcp.mjs';
import { getRequestIdentifier } from '../lib/freeTier.mjs';

export const config = { maxDuration: 30 };

const A2A_SKILL_NAMES = ['check_wallet_sanctions', 'check_domain_age', 'check_hostname_reputation', 'get_usage_status'];

// Reused verbatim from api/mcp.mjs's TOOLS array — same descriptions/schemas.
export const A2A_SKILL_TOOLS = TOOLS.filter((tool) => A2A_SKILL_NAMES.includes(tool.name));

async function runSkill(skill, args, identifier, licenseKey) {
  switch (skill) {
    case 'get_usage_status':
      return handleUsageStatus(args, identifier);
    case 'check_wallet_sanctions':
      return handleCheckWalletSanctions(args);
    case 'check_domain_age':
      return handleCheckDomainAge(args, identifier, licenseKey);
    case 'check_hostname_reputation':
      return handleCheckHostnameReputation(args, identifier, licenseKey);
    default:
      return undefined;
  }
}

function jsonRpcError(res, status, code, message, id, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return res.status(status).json({ jsonrpc: '2.0', error, id: id === undefined ? null : id });
}

function extractDataPart(message) {
  const parts = message && message.parts;
  if (!Array.isArray(parts)) return null;
  const dataPart = parts.find((p) => p && (p.kind === 'data' || p.type === 'data') && p.data && typeof p.data === 'object');
  return dataPart ? dataPart.data : null;
}

function taskResult(skill, data) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    contextId: crypto.randomUUID(),
    status: { state: 'completed', timestamp: now },
    artifacts: [
      {
        artifactId: crypto.randomUUID(),
        name: skill,
        parts: [{ kind: 'data', data }]
      }
    ],
    kind: 'task'
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      name: 'pg1-a2a',
      version: '1.12.0',
      protocol: 'Agent2Agent (A2A) v1.0.0 over JSON-RPC 2.0',
      agentCard: 'https://pg1-ai-agent.vercel.app/.well-known/agent-card.json'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST for A2A JSON-RPC requests.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return jsonRpcError(res, 400, -32700, 'Parse error: Invalid JSON', '1');
  }

  const { id, method, params } = body;
  const requestId = (id !== undefined && id !== null) ? id : '1';

  if (method !== 'SendMessage' && method !== 'message/send') {
    return jsonRpcError(res, 200, -32601, `Method not found: ${method || 'unknown'}`, requestId);
  }

  const data = extractDataPart(params && params.message);
  if (!data) {
    return jsonRpcError(
      res, 400, -32602,
      'Invalid params: expected params.message.parts to contain a DataPart of the form {"skill": "<tool name>", "arguments": {...}}.',
      requestId
    );
  }

  const skill = data.skill;
  const args = (data.arguments && typeof data.arguments === 'object') ? data.arguments : {};

  if (typeof skill !== 'string' || !A2A_SKILL_NAMES.includes(skill)) {
    return jsonRpcError(res, 400, -32602, `Unknown skill: '${skill}'. Available skills: ${A2A_SKILL_NAMES.join(', ')}.`, requestId);
  }

  const licenseKey = req.headers['x-api-key'];
  const identifier = getRequestIdentifier(req);

  let toolResult;
  try {
    toolResult = await runSkill(skill, args, identifier, licenseKey);
  } catch (err) {
    if (err.serviceUnavailable) {
      return jsonRpcError(res, 503, -32003, err.message, requestId);
    }
    if (err.mcpToolError) {
      return jsonRpcError(res, 200, -32000, err.message, requestId, { code: err.code });
    }
    return jsonRpcError(res, 400, -32602, err.message, requestId);
  }

  return res.status(200).json({ jsonrpc: '2.0', result: taskResult(skill, toolResult), id: requestId });
}
