/**
 * PG1 Sovereign Threat Intelligence — A2A (Agent2Agent) endpoint
 * Endpoint: /api/a2a
 * Protocol: Agent2Agent (A2A) JSON-RPC 2.0 transport
 *           (https://a2a-protocol.org/latest/specification/)
 *
 * Exposes ONLY the seven always-free MCP tools as A2A skills:
 * check_wallet_sanctions, check_domain_age, check_hostname_reputation,
 * check_wallet_age, get_usage_status, and (1.16.0) check_ip_abuse, the
 * bring-your-own-key AbuseIPDB lookup: the caller's own key comes from the
 * X-AbuseIPDB-Key request header only, exactly as on /api/mcp, and the
 * skill has the same 60/hour anonymous limit; and (1.16.0) check_package,
 * the pre-install npm/PyPI package check, 60/hour anonymous like the other
 * free checks. Every tool implementation is imported
 * directly from api/mcp.mjs (no duplicated logic) — names, descriptions,
 * schemas, and rate limits (check_hostname_reputation and check_wallet_age:
 * 60/hour without a license key) are unchanged from the MCP server.
 * check_wallet_sanctions: 120/hour per IP without a license key
 * (WALLET_SANCTIONS_RATE_LIMIT_MAX), one counter shared with /api/mcp.
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
  enforceWalletSanctionsRateLimit,
  handleCheckDomainAge,
  handleCheckHostnameReputation,
  handleCheckWalletAge,
  handleCheckIpAbuse,
  handleCheckPackage,
  logPackageCheckFailures,
  recordToolError,
  resolveTestFixture,
  requestCallerHash
} from './mcp.mjs';
import { getRequestIdentifier } from '../lib/freeTier.mjs';
import { recordTelemetry } from '../lib/telemetry.mjs';
import { buildCheck, classifyToolErrorCheckResult, errorResponseMeta } from '../lib/responseMeta.mjs';
import { formatFixIt, invalidInputMessage } from '../lib/invalidInput.mjs';
import { ABUSEIPDB_KEY_HEADER, readCustomerKey } from '../lib/abuseIpdb.mjs';

// Generic (never vendor-named) `checks[].source` labels for the 6 skills
// exposed here, keyed by skill name - same idea as api/mcp.mjs's
// TOOL_SOURCE_LABELS, used only when a skill call fails before producing a
// result (issue #215).
const SKILL_SOURCE_LABELS = {
  get_usage_status: 'usage records',
  check_wallet_sanctions: 'sanctions list',
  check_domain_age: 'domain registration records',
  check_hostname_reputation: 'phishing domain list',
  check_wallet_age: 'on-chain transfer history',
  check_ip_abuse: 'IP abuse reports',
  check_package: 'package registry'
};

export const config = { maxDuration: 30 };

const A2A_SKILL_NAMES = ['check_wallet_sanctions', 'check_domain_age', 'check_hostname_reputation', 'check_wallet_age', 'get_usage_status', 'check_ip_abuse', 'check_package'];

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

async function runSkill(skill, args, identifier, licenseKey, req) {
  switch (skill) {
    case 'get_usage_status':
      return handleUsageStatus(args, identifier);
    case 'check_wallet_sanctions':
      await enforceWalletSanctionsRateLimit(identifier, licenseKey);
      return handleCheckWalletSanctions(args);
    case 'check_domain_age':
      return handleCheckDomainAge(args, identifier, licenseKey);
    case 'check_hostname_reputation':
      return handleCheckHostnameReputation(args, identifier, licenseKey);
    case 'check_wallet_age':
      return handleCheckWalletAge(args, identifier, licenseKey);
    case 'check_ip_abuse':
      return handleCheckIpAbuse(args, { identifier, licenseKey, abuseIpdbKey: readCustomerKey(req.headers) });
    case 'check_package':
      return handleCheckPackage(args, identifier, licenseKey);
    default:
      return undefined;
  }
}

function jsonRpcError(res, status, code, message, id, data, pg1RequestId) {
  // request_id lives in error.data (and the X-Request-Id header), never at
  // the top level of the JSON-RPC envelope.
  const error = { code, message, data: { ...(data || {}), request_id: pg1RequestId } };
  return res.status(status).json({ jsonrpc: '2.0', error, id: id === undefined ? null : id });
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

// Telemetry for one skill call (lib/telemetry.mjs): the skill name (always
// one of A2A_SKILL_NAMES), how it ended, and a salted hash of the caller IP.
// Every skill here is free. Never the arguments or the result.
function statusFromHttp(statusCode) {
  if (statusCode >= 200 && statusCode < 300) return 'ok';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode >= 400 && statusCode < 500) return 'client_error';
  if (statusCode >= 500) return 'server_error';
  return 'unknown';
}

function recordSkillTelemetry(skillTelemetry, res) {
  try {
    recordTelemetry({
      eventType: 'tool_call',
      endpoint: '/api/a2a',
      toolName: skillTelemetry.skill,
      paymentType: 'free',
      status: skillTelemetry.status || statusFromHttp(res.statusCode),
      latencyMs: Date.now() - skillTelemetry.startedAt,
      callerHash: requestCallerHash(skillTelemetry.req),
      isFixture: skillTelemetry.isFixture === true
    });
  } catch {
    // Best-effort - telemetry never affects the response.
  }
}

export default async function handler(req, res) {
  // A UUID unique to this request (issue #215), distinct from the JSON-RPC
  // `requestId` below (the caller's own `id` field, echoed back as-is).
  const pg1RequestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', pg1RequestId);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, Authorization, x-api-key, A2A-Version, ${ABUSEIPDB_KEY_HEADER}`);
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      name: 'pg1-a2a',
      version: '1.16.0',
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
  // Set once a call names a known skill; recorded in the finally below.
  let skillTelemetry = null;

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
        formatFixIt({
          problem: 'Invalid params: params.message.parts has no DataPart carrying a skill call',
          expected: 'params.message.parts to contain a DataPart of the form {"skill": "<skill name>", "arguments": {...}}',
          example: '{"kind": "data", "data": {"skill": "check_domain_age", "arguments": {"domain": "example.com"}}}'
        }, pg1RequestId),
        requestId, undefined, pg1RequestId
      );
    }

    const skill = data.skill;
    const args = (data.arguments && typeof data.arguments === 'object') ? data.arguments : {};

    if (typeof skill !== 'string' || !A2A_SKILL_NAMES.includes(skill)) {
      return jsonRpcError(res, 400, -32602, formatFixIt({
        problem: 'Unknown skill: the DataPart\'s "skill" is not one of this agent\'s skills',
        expected: `"skill" set to one of ${A2A_SKILL_NAMES.join(', ')}`,
        example: 'check_domain_age'
      }, pg1RequestId), requestId, undefined, pg1RequestId);
    }

    skillTelemetry = { skill, req, status: null, startedAt: Date.now() };

    // Integration test fixtures (issue #215 part B): answered before any
    // licence check, rate limit, cache, upstream call or error logging, in
    // exactly the shape a real result/failure takes on this endpoint.
    const fixtureOutcome = resolveTestFixture(skill, args);
    if (fixtureOutcome) {
      skillTelemetry.isFixture = true;
      if (fixtureOutcome.type === 'tool_error') skillTelemetry.status = 'tool_error';
      if (fixtureOutcome.type === 'service_unavailable') {
        return jsonRpcError(res, 503, SERVICE_UNAVAILABLE_CODE, fixtureOutcome.message, requestId, { test_fixture: true }, pg1RequestId);
      }
      if (fixtureOutcome.type === 'tool_error') {
        const errorData = { code: fixtureOutcome.code, ...errorResponseMeta(fixtureOutcome.checks, pg1RequestId), test_fixture: true };
        return jsonRpcError(res, 200, -32000, fixtureOutcome.message, requestId, errorData, pg1RequestId);
      }
      const fixtureResult = fixtureOutcome.result;
      fixtureResult.request_id = pg1RequestId;
      return res.status(200).json({ jsonrpc: '2.0', result: taskResult(skill, args, fixtureResult, version, inboundMessage), id: requestId });
    }

    const licenseKey = req.headers['x-api-key'];
    const identifier = getRequestIdentifier(req);

    let toolResult;
    try {
      toolResult = await runSkill(skill, args, identifier, licenseKey, req);
    } catch (err) {
      if (err.serviceUnavailable) {
        recordToolError(`/api/a2a:${skill}`, 503, `${skill}_upstream_unavailable`, 'upstream', pg1RequestId);
        return jsonRpcError(res, 503, SERVICE_UNAVAILABLE_CODE, err.message, requestId, undefined, pg1RequestId);
      }
      if (err.mcpToolError) {
        // Same distinction as api/mcp.mjs: only a genuine upstream outage or
        // timeout is a logged failure - invalid_address/invalid_chain/
        // invalid_hostname/rate_limited are normal, expected results.
        // check_ip_abuse's upstream failures carry their own fixed logReason
        // (lib/abuseIpdb.mjs) - never the key or the body.
        if (err.logReason) {
          recordToolError(`/api/a2a:${skill}`, err.logStatus ?? null, err.logReason, err.logCategory || 'upstream', pg1RequestId);
        } else if (err.code === 'upstream_unavailable') {
          const isTimeout = /timed out/i.test(err.message);
          recordToolError(`/api/a2a:${skill}`, null, `${skill}_${isTimeout ? 'timeout' : 'upstream_unavailable'}`, isTimeout ? 'timeout' : 'upstream', pg1RequestId);
        }
        skillTelemetry.status = err.code === 'rate_limited' ? 'rate_limited' : 'tool_error';
        const errorChecks = [buildCheck(SKILL_SOURCE_LABELS[skill] || skill, classifyToolErrorCheckResult(err))];
        const errorData = { code: err.code, ...errorResponseMeta(errorChecks, pg1RequestId) };
        if (err.retryAfter) {
          errorData.retry_after = err.retryAfter;
          res.setHeader('Retry-After', String(err.retryAfter));
        }
        return jsonRpcError(res, 200, -32000, invalidInputMessage(err, pg1RequestId), requestId, errorData, pg1RequestId);
      }
      return jsonRpcError(res, 400, -32602, invalidInputMessage(err, pg1RequestId), requestId, undefined, pg1RequestId);
    }
    toolResult.request_id = pg1RequestId;
    if (skill === 'check_package') logPackageCheckFailures('/api/a2a', toolResult, pg1RequestId);

    return res.status(200).json({ jsonrpc: '2.0', result: taskResult(skill, args, toolResult, version, inboundMessage), id: requestId });
  } catch (err) {
    // Catch-all for anything the specific handling above didn't already turn
    // into a sanitized message (a genuine bug, not an expected failure) -
    // err.message here can be a raw internal detail. Log it server-side only;
    // never echo it back into the response body.
    console.error('[A2A] unhandled exception:', err.message);
    recordToolError('/api/a2a', 500, 'unhandled_exception', 'js_error', pg1RequestId);
    return jsonRpcError(res, 500, -32603, 'Internal server error', requestId, undefined, pg1RequestId);
  } finally {
    if (skillTelemetry) recordSkillTelemetry(skillTelemetry, res);
  }
}
