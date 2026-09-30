/**
 * PG1 Sovereign Threat Intelligence — A2A (Agent2Agent) endpoint
 * Endpoint: /api/a2a
 * Protocol: Agent2Agent (A2A) JSON-RPC 2.0 transport
 *           (https://a2a-protocol.org/latest/specification/)
 *
 * Exposes ONLY the five always-free MCP tools as A2A skills:
 * check_wallet_sanctions, check_domain_age, check_hostname_reputation,
 * check_wallet_age, get_usage_status. Every tool implementation is imported
 * directly from api/mcp.mjs (no duplicated logic) — names, descriptions,
 * schemas, and rate limits (check_hostname_reputation and check_wallet_age:
 * 60/hour without a license key) are unchanged from the MCP server.
 *
 * Paid tools are deliberately NOT exposed here; they wait for the A2A
 * licensing/payment story to be worked out.
 *
 * Version negotiation (spec 3.6.2): the A2A-Version header, or the
 * A2A-Version query param if the header is absent/empty, selects the wire
 * shape. Missing/empty => "0.3" (default). "1.0" => "1.0". Any other value
 * is rejected with VersionNotSupportedError.
 *   - 1.0: method name "SendMessage". Parts carry no "kind" field; a data
 *     part is { data: {...}, mediaType: "application/json" }. Task states
 *     are "TASK_STATE_COMPLETED" / "TASK_STATE_FAILED". Roles are
 *     "ROLE_USER" / "ROLE_AGENT".
 *   - 0.3: method name "message/send". Parts use "kind": "data". Task
 *     states are "completed" / "failed". Roles are "user" / "agent". The
 *     Task carries "kind": "task" and messages carry "kind": "message".
 * "SendMessage" and "message/send" are both accepted as aliases regardless
 * of the negotiated version; only the response shape changes. Incoming
 * DataParts are accepted in either shape (with or without "kind"/"type"),
 * whatever version was negotiated.
 *
 * Request shape: params.message.parts must contain a DataPart carrying
 * { skill: "<tool name>", arguments: { ... } }.
 *
 * Response shape: a Task object with a "completed" artifact whose part is
 * a DataPart carrying the tool's JSON result, plus a history entry echoing
 * the inbound message.
 *
 * Methods with no server-side support are answered with the specific A2A
 * error the spec calls for (3.3.4), rather than a generic "not found":
 * streaming/subscription methods -> UnsupportedOperationError; push
 * notification config methods -> PushNotificationNotSupportedError;
 * GetExtendedAgentCard -> UnsupportedOperationError; GetTask/CancelTask ->
 * TaskNotFoundError (tasks are not persisted).
 */

import {
  TOOLS,
  handleUsageStatus,
  handleCheckWalletSanctions,
  handleCheckDomainAge,
  handleCheckHostnameReputation,
  handleCheckWalletAge,
  recordToolError
} from './mcp.mjs';
import { getRequestIdentifier } from '../lib/freeTier.mjs';
import { buildCheck, classifyToolErrorCheckResult, errorResponseMeta } from '../lib/responseMeta.mjs';

// Generic (never vendor-named) `checks[].source` labels for the 5 skills
// exposed here, keyed by skill name - same idea as api/mcp.mjs's
// TOOL_SOURCE_LABELS, used only when a skill call fails before producing a
// result (issue #215).
const SKILL_SOURCE_LABELS = {
  get_usage_status: 'usage records',
  check_wallet_sanctions: 'sanctions list',
  check_domain_age: 'domain registration records',
  check_hostname_reputation: 'phishing domain list',
  check_wallet_age: 'on-chain transfer history'
};

export const config = { maxDuration: 30 };

const A2A_SKILL_NAMES = ['check_wallet_sanctions', 'check_domain_age', 'check_hostname_reputation', 'check_wallet_age', 'get_usage_status'];

// Reused verbatim from api/mcp.mjs's TOOLS array — same descriptions/schemas.
export const A2A_SKILL_TOOLS = TOOLS.filter((tool) => A2A_SKILL_NAMES.includes(tool.name));

// A2A-specific JSON-RPC error codes (spec's reserved -32001..-32099 range).
const A2A_ERROR_CODES = {
  TaskNotFoundError: -32001,
  TaskNotCancelableError: -32002,
  PushNotificationNotSupportedError: -32003,
  UnsupportedOperationError: -32004,
  ContentTypeNotSupportedError: -32005,
  InvalidAgentResponseError: -32006,
  AuthenticatedExtendedCardNotConfiguredError: -32007,
  VersionNotSupportedError: -32008
};

// App-level (non-A2A) error code for an upstream outage, kept distinct from
// the A2A-reserved range above so it can never be mistaken for one of them.
const SERVICE_UNAVAILABLE_CODE = -32010;

const METHODS = {
  sendMessage: ['SendMessage', 'message/send'],
  sendStreamingMessage: ['SendStreamingMessage', 'message/stream'],
  subscribeToTask: ['SubscribeToTask', 'tasks/resubscribe'],
  getTask: ['GetTask', 'tasks/get'],
  cancelTask: ['CancelTask', 'tasks/cancel'],
  getExtendedAgentCard: ['GetExtendedAgentCard', 'agent/getAuthenticatedExtendedCard'],
  pushNotificationConfig: [
    'SetTaskPushNotificationConfig', 'tasks/pushNotificationConfig/set',
    'GetTaskPushNotificationConfig', 'tasks/pushNotificationConfig/get',
    'ListTaskPushNotificationConfig', 'tasks/pushNotificationConfig/list',
    'DeleteTaskPushNotificationConfig', 'tasks/pushNotificationConfig/delete'
  ]
};

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
    case 'check_wallet_age':
      return handleCheckWalletAge(args, identifier, licenseKey);
    default:
      return undefined;
  }
}

function jsonRpcError(res, status, code, message, id, data, pg1RequestId) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return res.status(status).json({ jsonrpc: '2.0', error, id: id === undefined ? null : id, request_id: pg1RequestId });
}

// Spec 3.6.2: header takes precedence over the query param; missing/empty
// resolves to "0.3"; anything besides "1.0" and empty/missing is rejected.
function resolveVersion(req) {
  let raw = req.headers && req.headers['a2a-version'];
  if (raw === undefined || raw === '') {
    const query = req.query || {};
    raw = query['A2A-Version'];
    if (raw === undefined || raw === '') raw = query['a2a-version'];
  }
  if (Array.isArray(raw)) raw = raw[0];
  if (raw === undefined || raw === null || raw === '') return { version: '0.3', requested: raw };
  if (raw === '1.0') return { version: '1.0', requested: raw };
  return { version: null, requested: raw };
}

function extractDataPart(message) {
  const parts = message && message.parts;
  if (!Array.isArray(parts)) return null;
  // Accepts both the 0.3 shape ({ kind: "data", data }) and the 1.0 shape
  // ({ data, mediaType }, no "kind"/"type" field at all).
  const dataPart = parts.find((p) => (
    p && p.data && typeof p.data === 'object' &&
    (p.kind === undefined || p.kind === 'data') &&
    (p.type === undefined || p.type === 'data')
  ));
  return dataPart ? dataPart.data : null;
}

function stateValue(state, version) {
  if (version === '1.0') return state === 'completed' ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED';
  return state;
}

function roleValue(role, version) {
  if (version === '1.0') return role === 'agent' ? 'ROLE_AGENT' : 'ROLE_USER';
  return role === 'agent' ? 'agent' : 'user';
}

function buildDataPart(data, version) {
  if (version === '1.0') return { data, mediaType: 'application/json' };
  return { kind: 'data', data };
}

function buildMessage(role, data, version, { messageId, contextId, taskId }) {
  const message = {
    role: roleValue(role, version),
    parts: [buildDataPart(data, version)],
    messageId: messageId || crypto.randomUUID(),
    contextId,
    taskId
  };
  if (version === '0.3') message.kind = 'message';
  return message;
}

function taskResult(skill, args, result, version, inboundMessage) {
  const now = new Date().toISOString();
  const taskId = crypto.randomUUID();
  const contextId = (inboundMessage && inboundMessage.contextId) || crypto.randomUUID();
  const inboundData = { skill, arguments: args };

  const task = {
    id: taskId,
    contextId,
    status: { state: stateValue('completed', version), timestamp: now },
    artifacts: [
      {
        artifactId: crypto.randomUUID(),
        name: skill,
        parts: [buildDataPart(result, version)]
      }
    ],
    history: [
      buildMessage('user', inboundData, version, { messageId: inboundMessage && inboundMessage.messageId, contextId, taskId }),
      buildMessage('agent', result, version, { contextId, taskId })
    ]
  };
  if (version === '0.3') task.kind = 'task';
  return task;
}

export default async function handler(req, res) {
  // A UUID unique to this request (issue #215), distinct from the JSON-RPC
  // `requestId` below (the caller's own `id` field, echoed back as-is).
  const pg1RequestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', pg1RequestId);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, A2A-Version');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      name: 'pg1-a2a',
      version: '1.13.0',
      protocol: 'Agent2Agent (A2A) over JSON-RPC 2.0',
      supportedVersions: ['1.0', '0.3'],
      agentCard: 'https://pg1-ai-agent.vercel.app/.well-known/agent-card.json',
      request_id: pg1RequestId
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST for A2A JSON-RPC requests.', request_id: pg1RequestId });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return jsonRpcError(res, 400, -32700, 'Parse error: Invalid JSON', '1', undefined, pg1RequestId);
  }

  const { id, method, params } = body;
  const requestId = (id !== undefined && id !== null) ? id : '1';

  try {
    const { version, requested } = resolveVersion(req);
    if (version === null) {
      return jsonRpcError(
        res, 400, A2A_ERROR_CODES.VersionNotSupportedError,
        `Unsupported A2A-Version: '${requested}'. Supported versions: '1.0', '0.3' (default).`,
        requestId, undefined, pg1RequestId
      );
    }

    if (METHODS.sendStreamingMessage.includes(method) || METHODS.subscribeToTask.includes(method)) {
      return jsonRpcError(
        res, 200, A2A_ERROR_CODES.UnsupportedOperationError,
        `Method not supported: ${method}. This agent does not support streaming or task subscriptions.`,
        requestId, undefined, pg1RequestId
      );
    }

    if (METHODS.pushNotificationConfig.includes(method)) {
      return jsonRpcError(
        res, 200, A2A_ERROR_CODES.PushNotificationNotSupportedError,
        `Method not supported: ${method}. This agent does not support push notifications.`,
        requestId, undefined, pg1RequestId
      );
    }

    if (METHODS.getExtendedAgentCard.includes(method)) {
      return jsonRpcError(
        res, 200, A2A_ERROR_CODES.UnsupportedOperationError,
        `Method not supported: ${method}. This agent has no authenticated extended agent card.`,
        requestId, undefined, pg1RequestId
      );
    }

    if (METHODS.getTask.includes(method) || METHODS.cancelTask.includes(method)) {
      return jsonRpcError(
        res, 200, A2A_ERROR_CODES.TaskNotFoundError,
        `Task not found. This agent does not persist tasks; every ${METHODS.sendMessage[0]} call resolves synchronously.`,
        requestId, undefined, pg1RequestId
      );
    }

    if (!METHODS.sendMessage.includes(method)) {
      return jsonRpcError(res, 200, -32601, `Method not found: ${method || 'unknown'}`, requestId, undefined, pg1RequestId);
    }

    const inboundMessage = params && params.message;
    const data = extractDataPart(inboundMessage);
    if (!data) {
      return jsonRpcError(
        res, 400, -32602,
        'Invalid params: expected params.message.parts to contain a DataPart of the form {"skill": "<tool name>", "arguments": {...}}.',
        requestId, undefined, pg1RequestId
      );
    }

    const skill = data.skill;
    const args = (data.arguments && typeof data.arguments === 'object') ? data.arguments : {};

    if (typeof skill !== 'string' || !A2A_SKILL_NAMES.includes(skill)) {
      return jsonRpcError(res, 400, -32602, `Unknown skill: '${skill}'. Available skills: ${A2A_SKILL_NAMES.join(', ')}.`, requestId, undefined, pg1RequestId);
    }

    const licenseKey = req.headers['x-api-key'];
    const identifier = getRequestIdentifier(req);

    let toolResult;
    try {
      toolResult = await runSkill(skill, args, identifier, licenseKey);
    } catch (err) {
      if (err.serviceUnavailable) {
        recordToolError(`/api/a2a:${skill}`, 503, `${skill}_upstream_unavailable`, 'upstream', pg1RequestId);
        return jsonRpcError(res, 503, SERVICE_UNAVAILABLE_CODE, err.message, requestId, undefined, pg1RequestId);
      }
      if (err.mcpToolError) {
        // Same distinction as api/mcp.mjs: only a genuine upstream outage or
        // timeout is a logged failure - invalid_address/invalid_chain/
        // invalid_hostname/rate_limited are normal, expected results.
        if (err.code === 'upstream_unavailable') {
          const isTimeout = /timed out/i.test(err.message);
          recordToolError(`/api/a2a:${skill}`, null, `${skill}_${isTimeout ? 'timeout' : 'upstream_unavailable'}`, isTimeout ? 'timeout' : 'upstream', pg1RequestId);
        }
        const errorChecks = [buildCheck(SKILL_SOURCE_LABELS[skill] || skill, classifyToolErrorCheckResult(err))];
        const errorData = { code: err.code, ...errorResponseMeta(errorChecks, pg1RequestId) };
        return jsonRpcError(res, 200, -32000, err.message, requestId, errorData, pg1RequestId);
      }
      return jsonRpcError(res, 400, -32602, err.message, requestId, undefined, pg1RequestId);
    }
    toolResult.request_id = pg1RequestId;

    return res.status(200).json({ jsonrpc: '2.0', result: taskResult(skill, args, toolResult, version, inboundMessage), id: requestId, request_id: pg1RequestId });
  } catch (err) {
    // Catch-all for anything the specific handling above didn't already turn
    // into a sanitized message (a genuine bug, not an expected failure) -
    // err.message here can be a raw internal detail. Log it server-side only;
    // never echo it back into the response body.
    console.error('[A2A] unhandled exception:', err.message);
    recordToolError('/api/a2a', 500, 'unhandled_exception', 'js_error', pg1RequestId);
    return jsonRpcError(res, 500, -32603, 'Internal server error', requestId, undefined, pg1RequestId);
  }
}
