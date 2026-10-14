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
 * skill has the same 60/hour anonymous limit; and (1.17.0) check_package,
 * the pre-install npm/PyPI package check, 60/hour anonymous like the other
 * free checks. Every tool implementation is imported
 * directly from api/mcp.mjs (no duplicated logic) — names, descriptions,
 * schemas, and rate limits (check_hostname_reputation and check_wallet_age:
 * 60/hour without a license key) are unchanged from the MCP server.
 * check_wallet_sanctions: 120/hour per IP without a license key
 * (WALLET_SANCTIONS_RATE_LIMIT_MAX), one counter shared with /api/mcp.
 *
 * Paid skills (Phase 2): get_cve_details, get_cve_batch, get_cve_by_product
 * and get_threat_actor_profile, the same handlers as /api/mcp, behind the
 * same gate (api/mcp.mjs resolvePaidAccess), in the same order:
 *   1. a Gumroad licence key (X-API-KEY header);
 *   2. an x402 v2 payment, sent the a2a-x402 extension way: the PaymentPayload
 *      in params.message.metadata["x402.payment.payload"] (the
 *      PAYMENT-SIGNATURE / X-Payment header is also read);
 *   3. the free tier, automatic unless the caller pays or sends
 *      X-Free-Tier: 0: ONE 5/day counter per caller, shared with /api/mcp
 *      and /api/ioc (lib/freeTier.mjs), spent before any payment challenge.
 * With none of them, the call answers with a Task in state input-required
 * whose status message carries "x402.payment.status": "payment-required"
 * and "x402.payment.required": the x402 v2 PaymentRequired object (the one
 * /api/mcp returns). A paid call is settled only after the skill succeeds;
 * the receipt is in "x402.payment.receipts". The indicator feed tools
 * (get_threat_indicators, get_ioc_context, get_ioc_batch) stay MCP-only.
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
  STANDARD_TOOL_HANDLERS,
  paidResponseOptions,
  resolvePaidAccess,
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
  requestCallerHash,
  runPricedX402Gate,
  runReadOnlyTool,
  internalRunTool
} from './mcp.mjs';
import { FOUNDRY_SKILL, submitBuild, payBuild, refreshBuild, foundryJobView, FoundryRefusal } from '../lib/foundry/jobs.mjs';
import { isFoundryToolName, callFoundryTool, FoundryCallError, TOOL_KEY_HEADER } from '../lib/foundry/tools.mjs';
import { createFoundryStore } from '../lib/foundry/store.mjs';
import { payerHash } from '../lib/a2aJobs/jobs.mjs';
import { signResult, A2A_SIGNATURE_META } from '../lib/signing.mjs';
import { waitUntil } from '@vercel/functions';
import { checkFreeTierAvailable, consumeFreeTier, freeTierWanted } from '../lib/freeTier.mjs';
import { getSupabaseCreds } from '../lib/supabase.mjs';
import { submitJob, payJob, runAcceptedJob, jobView, createJobStore, JobRefusal } from '../lib/a2aJobs/jobs.mjs';
import { JOB_TYPES } from '../lib/a2aJobs/catalogue.mjs';
import { getRequestIdentifier, setFreeTierHeaders } from '../lib/freeTier.mjs';
import { recordTelemetry, toolErrorTelemetryStatus } from '../lib/telemetry.mjs';
import { buildCheck, classifyToolErrorCheckResult, errorResponseMeta } from '../lib/responseMeta.mjs';
import { formatFixIt, invalidInputMessage } from '../lib/invalidInput.mjs';
import { ABUSEIPDB_KEY_HEADER, readCustomerKey } from '../lib/abuseIpdb.mjs';
import { suggestToolName } from '../lib/toolNames.mjs';
import { X402_PRICE, x402PriceUsd } from '../lib/x402Config.mjs';

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
  check_package: 'package registry',
  get_cve_details: 'vulnerability database',
  get_cve_batch: 'vulnerability database',
  get_cve_by_product: 'vulnerability database',
  get_threat_actor_profile: 'threat actor intelligence',
  preflight_check: 'PG1 preflight',
  check_x402_endpoint: 'x402 payment request',
  check_agent_card: 'agent card',
  verify_result: 'PG1 signing keys'
};

// 60 s: an accepted A2A job runs in the background (waitUntil) after the reply.
export const config = { maxDuration: 60 };

export const A2A_FREE_SKILL_NAMES = Object.freeze(['check_wallet_sanctions', 'check_domain_age', 'check_hostname_reputation', 'check_wallet_age', 'get_usage_status', 'check_ip_abuse', 'check_package', 'check_x402_endpoint', 'check_agent_card', 'verify_result']);
export const A2A_PAID_SKILL_NAMES = Object.freeze(['preflight_check', 'get_cve_details', 'get_cve_batch', 'get_cve_by_product', 'get_threat_actor_profile']);
const A2A_SKILL_NAMES = [...A2A_FREE_SKILL_NAMES, ...A2A_PAID_SKILL_NAMES];

// Message metadata keys of the a2a-x402 extension.
const X402_META = Object.freeze({
  status: 'x402.payment.status',
  required: 'x402.payment.required',
  payload: 'x402.payment.payload',
  receipts: 'x402.payment.receipts',
  error: 'x402.payment.error'
});
// App-level (non-A2A) code for a rejected licence key, next to -32010.
const LICENSE_REJECTED_CODE = -32011;

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
    case 'check_x402_endpoint':
    case 'check_agent_card':
    case 'verify_result':
      return runReadOnlyTool(skill, args, { identifier, licenseKey });
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
// resolves to "0.3"; anything besides "1.0", "0.3" and empty/missing is
// rejected.
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
  // An explicit "0.3" is as valid as leaving it out (supportedVersions).
  if (raw === '0.3') return { version: '0.3', requested: raw };
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
  if (version === '1.0') return { completed: 'TASK_STATE_COMPLETED', 'input-required': 'TASK_STATE_INPUT_REQUIRED', working: 'TASK_STATE_WORKING', canceled: 'TASK_STATE_CANCELED', submitted: 'TASK_STATE_SUBMITTED', rejected: 'TASK_STATE_REJECTED' }[state] || 'TASK_STATE_FAILED';
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

function buildMessage(role, data, version, { messageId, contextId, taskId, metadata }) {
  const message = {
    role: roleValue(role, version),
    parts: [buildDataPart(data, version)],
    messageId: messageId || crypto.randomUUID(),
    contextId,
    taskId
  };
  if (metadata) message.metadata = metadata;
  if (version === '0.3') message.kind = 'message';
  return message;
}

// The inbound message without the payment payload (a signed authorisation
// is never echoed back in history).
function historyMessageMetadata(inboundMessage) {
  const meta = inboundMessage && inboundMessage.metadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const { [X402_META.payload]: _payload, ...rest } = meta;
  return Object.keys(rest).length ? rest : undefined;
}

// A paid skill call that needs payment first (a2a-x402): an input-required
// Task whose status message carries the PaymentRequired object.
function paymentRequiredTask(skill, args, paymentRequired, version, inboundMessage, { failed = false } = {}) {
  const taskId = crypto.randomUUID();
  const contextId = (inboundMessage && inboundMessage.contextId) || crypto.randomUUID();
  const metadata = { [X402_META.status]: failed ? 'payment-failed' : 'payment-required', [X402_META.required]: paymentRequired };
  if (failed && paymentRequired && paymentRequired.error) metadata[X402_META.error] = paymentRequired.error;
  const note = {
    payment_required: true,
    skill,
    message: `${skill} is a paid skill and today's 5 free calls (shared across /api/mcp, /api/ioc and /api/a2a) are used up or were declined with X-Free-Tier: 0. Pay per call with x402 (the PaymentPayload in message.metadata["${X402_META.payload}"]) or send a Gumroad licence key in X-API-KEY.`
  };
  const status = { state: stateValue('input-required', version), timestamp: new Date().toISOString(), message: buildMessage('agent', note, version, { contextId, taskId, metadata }) };
  const task = {
    id: taskId,
    contextId,
    status,
    metadata,
    history: [buildMessage('user', { skill, arguments: args }, version, { messageId: inboundMessage && inboundMessage.messageId, contextId, taskId, metadata: historyMessageMetadata(inboundMessage) })]
  };
  if (version === '0.3') task.kind = 'task';
  return task;
}

function taskResult(skill, args, result, version, inboundMessage, { paymentMetadata } = {}) {
  const now = new Date().toISOString();
  const taskId = crypto.randomUUID();
  const contextId = (inboundMessage && inboundMessage.contextId) || crypto.randomUUID();
  const inboundData = { skill, arguments: args };
  // Signed results (lib/signing.mjs): metadata["pg1.signature"].
  const signature = signResult({ tool: skill, args, result });
  if (signature) paymentMetadata = { ...(paymentMetadata || {}), [A2A_SIGNATURE_META]: signature };

  const task = {
    id: taskId,
    contextId,
    status: { state: stateValue('completed', version), timestamp: now },
    ...(paymentMetadata ? { metadata: paymentMetadata } : {}),
    artifacts: [
      {
        artifactId: crypto.randomUUID(),
        name: skill,
        parts: [buildDataPart(result, version)]
      }
    ],
    history: [
      buildMessage('user', inboundData, version, { messageId: inboundMessage && inboundMessage.messageId, contextId, taskId, metadata: historyMessageMetadata(inboundMessage) }),
      buildMessage('agent', result, version, { contextId, taskId, metadata: paymentMetadata })
    ]
  };
  if (version === '0.3') task.kind = 'task';
  return task;
}

// Telemetry for one skill call (lib/telemetry.mjs): the skill name (always
// one of A2A_SKILL_NAMES), how it was paid for (free skills: 'free'; paid
// skills: license / free_tier / x402 / none), how it ended, and a salted
// hash of the caller IP. Never the arguments or the result. An unknown
// skill is recorded too, as unknown_tool with the name reduced in
// lib/telemetry.mjs (requested_tool), like /api/mcp.
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
      toolName: skillTelemetry.unknown ? null : skillTelemetry.skill,
      requestedTool: skillTelemetry.unknown ? skillTelemetry.skill : null,
      paymentType: skillTelemetry.paymentType || 'free',
      status: skillTelemetry.unknown ? 'unknown_tool' : (skillTelemetry.status || statusFromHttp(res.statusCode)),
      latencyMs: Date.now() - skillTelemetry.startedAt,
      callerHash: requestCallerHash(skillTelemetry.req),
      isFixture: skillTelemetry.isFixture === true
    });
  } catch {
    // Best-effort - telemetry never affects the response.
  }
}

// --- A2A jobs (lib/a2aJobs) ------------------------------------------------------
// submit_job -> quote (input-required with the x402 requirements at the
// job's price) -> payment on the task (message.taskId = job id) -> working
// -> completed with artifacts (JSON, PDF: signed links, 7 days) or failed
// (one retry, then a wallet credit; never an on-chain refund). GetTask
// reads a job's state; CancelTask cancels a quoted job.

export const JOB_SKILL = 'submit_job';
const JOB_STATE = { quoted: 'input-required', working: 'working', completed: 'completed', failed: 'failed', expired: 'canceled', cancelled: 'canceled', refused: 'failed' };

function buildFilePart(file, version) {
  if (version === '1.0') return { url: file.url, mediaType: file.mime_type, filename: file.name };
  return { kind: 'file', file: { uri: file.url, mimeType: file.mime_type, name: file.name } };
}

async function jobTask(job, version, inboundMessage, { paymentRequired = null, signArtifact = null, settlement = null } = {}) {
  const view = await jobView(job, { signArtifact });
  const contextId = (inboundMessage && inboundMessage.contextId) || job.id;
  const state = JOB_STATE[job.status] || 'failed';
  let metadata;
  if (job.status === 'quoted' && paymentRequired) metadata = { [X402_META.status]: 'payment-required', [X402_META.required]: paymentRequired };
  if (settlement && settlement.success) metadata = { [X402_META.status]: 'payment-completed', [X402_META.receipts]: [settlement] };
  const task = {
    id: job.id,
    contextId,
    status: { state: stateValue(state, version), timestamp: new Date().toISOString(), message: buildMessage('agent', view, version, { contextId, taskId: job.id, metadata }) },
    ...(metadata ? { metadata } : {})
  };
  if (job.status === 'completed') {
    const files = (view.artifacts || []).filter((a) => a.url);
    task.artifacts = [{ artifactId: `${job.id}-result`, name: job.job_type, parts: [buildDataPart(job.result || {}, version), ...files.map((f) => buildFilePart(f, version))] }];
  }
  if (version === '0.3') task.kind = 'task';
  return task;
}

// --- Tool Foundry ---------------------------------------------------------------
// build_tool: submit a spec (screened, then quoted, counter-offered, sent to
// review or refused); pay the build fee on the job (arguments.job_id plus the
// x402 payment in message.metadata); read the job's state (job_id alone).
const FOUNDRY_STATE = { review: 'submitted', refused: 'rejected', infeasible: 'rejected', quoted: 'input-required', counter_offer: 'input-required', expired: 'canceled', building: 'working', awaiting_approval: 'working', deployed: 'completed', rejected: 'failed', build_failed: 'failed' };

function foundryTask(job, version, inboundMessage, { paymentRequired = null, settlement = null } = {}) {
  const view = foundryJobView(job);
  const contextId = (inboundMessage && inboundMessage.contextId) || job.id;
  let metadata;
  if (paymentRequired && ['quoted', 'counter_offer'].includes(job.status)) metadata = { [X402_META.status]: 'payment-required', [X402_META.required]: paymentRequired };
  if (settlement && settlement.success) metadata = { [X402_META.status]: 'payment-completed', [X402_META.receipts]: [settlement] };
  const task = { id: job.id, contextId, status: { state: stateValue(FOUNDRY_STATE[job.status] || 'failed', version), timestamp: new Date().toISOString(), message: buildMessage('agent', view, version, { contextId, taskId: job.id, metadata }) }, ...(metadata ? { metadata } : {}) };
  if (version === '0.3') task.kind = 'task';
  return task;
}

// The lab and classifier code is loaded only when a build request comes in.
const defaultFoundryDeps = async (req, { supUrl, supKey }) => (await import('../lib/foundry/service.mjs')).foundryDeps({ supUrl, supKey, callerHash: requestCallerHash(req) });
let foundryDepsFactory = defaultFoundryDeps;
export function __setFoundryDeps(factory) {
  foundryDepsFactory = factory || defaultFoundryDeps;
}

// The job runner's model, PDF and storage code is loaded only when a job
// needs it, so the A2A check path itself never reaches model code.
const loadJobService = () => import('../lib/a2aJobs/service.mjs');

function jobDeps(req, { supUrl, supKey }) {
  const store = createJobStore({ supUrl, supKey });
  const outputs = {
    sign: async (a) => (await loadJobService()).outputStorage({ supUrl, supKey }).sign(a),
    makePdf: async (doc) => (await loadJobService()).outputStorage({ supUrl, supKey }).makePdf(doc),
    storeOutputs: async (j, out) => (await loadJobService()).outputStorage({ supUrl, supKey }).storeOutputs(j, out)
  };
  const identifier = getRequestIdentifier(req);
  const audit = { supUrl, supKey };
  const startRun = (job, { onSuccess = null } = {}) => {
    const run = loadJobService().then((svc) => {
      const model = svc.jobModel({});
      return runAcceptedJob(job, {
        store, audit, onSuccess,
        execDeps: { runTool: svc.runJobTool, guard: svc.jobGuard(), makePdf: (doc) => outputs.makePdf(doc), writeModel: (m) => model.write(m), spentUsd: () => model.spent() },
        storeOutputs: (j, out) => outputs.storeOutputs(j, out)
      });
    }).catch((e) => console.error('[A2A_JOB] run failed:', e && e.message));
    try { waitUntil(run); } catch (e) { /* outside Vercel the promise still runs */ }
    return run;
  };
  return {
    store, outputs, audit, startRun, callerId: identifier,
    freeTier: { wanted: freeTierWanted(req.headers), check: () => checkFreeTierAvailable(supUrl, supKey, identifier), consume: (avail) => consumeFreeTier(supUrl, supKey, identifier, avail) },
    gate: (job, payment) => runPricedX402Gate(req, { payment, priceUsd: Number(job.price_usd), description: `PG1 A2A job ${job.job_type} (${job.items} item${job.items === 1 ? '' : 's'})` }),
    screen: null
  };
}

function jobRefusalResponse(res, err, requestId, pg1RequestId) {
  if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
  return jsonRpcError(res, err.status, err.rpcCode, err.message, requestId, err.data, pg1RequestId);
}

// Test hook: the job dependencies are swapped in by tests/a2a-jobs.test.mjs.
let jobDepsFactory = jobDeps;
export function __setJobDeps(factory) {
  jobDepsFactory = factory || jobDeps;
}

export default async function handler(req, res) {
  // A UUID unique to this request (issue #215), distinct from the JSON-RPC
  // `requestId` below (the caller's own `id` field, echoed back as-is).
  const pg1RequestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', pg1RequestId);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, Authorization, x-api-key, A2A-Version, X-A2A-Extensions, X-Free-Tier, PAYMENT-SIGNATURE, X-Payment, ${ABUSEIPDB_KEY_HEADER}`);
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After, X-Free-Tier-Limit, X-Free-Tier-Remaining');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      name: 'pg1-a2a',
      version: '1.18.0',
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

    if ((METHODS.getTask.includes(method) || METHODS.cancelTask.includes(method)) && params && typeof params.id === 'string' && /^[0-9a-f-]{36}$/i.test(params.id)) {
      let creds = null;
      try { creds = getSupabaseCreds(); } catch (e) { creds = null; }
      const deps = creds ? jobDepsFactory(req, creds) : null;
      const job = deps ? await deps.store.get(params.id).catch(() => null) : null;
      if (job) {
        if (METHODS.cancelTask.includes(method)) {
          if (job.status !== 'quoted') return jsonRpcError(res, 200, A2A_ERROR_CODES.TaskNotCancelableError, `Task ${job.id} is ${job.status} and cannot be canceled.`, requestId, undefined, pg1RequestId);
          const rows = await deps.store.update(job.id, { status: 'cancelled' }, { onlyIfStatus: 'quoted' });
          return res.status(200).json({ jsonrpc: '2.0', result: await jobTask(rows[0] || { ...job, status: 'cancelled' }, version, null), id: requestId });
        }
        return res.status(200).json({ jsonrpc: '2.0', result: await jobTask(job, version, null, { signArtifact: (a) => deps.outputs.sign(a) }), id: requestId });
      }
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
    // A2A jobs, step 2: a payment sent on a job's task.
    const jobPayment = inboundMessage && inboundMessage.metadata && inboundMessage.metadata[X402_META.payload];
    if (inboundMessage && typeof inboundMessage.taskId === 'string' && /^[0-9a-f-]{36}$/i.test(inboundMessage.taskId) && jobPayment) {
      skillTelemetry = { skill: JOB_SKILL, req, status: null, startedAt: Date.now(), paymentType: 'x402' };
      let creds;
      try { creds = getSupabaseCreds(); } catch (e) { return jsonRpcError(res, 503, SERVICE_UNAVAILABLE_CODE, 'Jobs are not available on this deployment.', requestId, undefined, pg1RequestId); }
      const deps = jobDepsFactory(req, creds);
      try {
        const paid = await payJob({ jobId: inboundMessage.taskId, deps: { ...deps, gate: (job) => deps.gate(job, jobPayment) } });
        if (paid.paymentRequired) {
          skillTelemetry.status = 'payment_required';
          return res.status(200).json({ jsonrpc: '2.0', result: await jobTask(paid.job, version, inboundMessage, { paymentRequired: paid.paymentRequired }), id: requestId });
        }
        if (paid.accepted && paid.settlement) recordTelemetry({ eventType: 'settlement', endpoint: '/api/a2a', toolName: `job.${paid.job.job_type}`.slice(0, 64), paymentType: 'x402', status: 'settled', callerHash: requestCallerHash(req), amountUsd: Number(paid.job.price_usd) });
        skillTelemetry.status = 'ok';
        return res.status(200).json({ jsonrpc: '2.0', result: await jobTask(paid.job, version, inboundMessage, { settlement: paid.settlement, signArtifact: (a) => deps.outputs.sign(a) }), id: requestId });
      } catch (err) {
        if (err && err.jobRefusal) {
          skillTelemetry.status = err.status === 503 ? 'server_error' : err.status === 429 ? 'rate_limited' : 'client_error';
          return jobRefusalResponse(res, err, requestId, pg1RequestId);
        }
        throw err;
      }
    }
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

    // A2A jobs, step 1: submit -> validated quote (or accepted on the free tier).
    if (skill === JOB_SKILL) {
      skillTelemetry = { skill: JOB_SKILL, req, status: null, startedAt: Date.now(), paymentType: 'none' };
      let creds;
      try { creds = getSupabaseCreds(); } catch (e) { return jsonRpcError(res, 503, SERVICE_UNAVAILABLE_CODE, 'Jobs are not available on this deployment.', requestId, undefined, pg1RequestId); }
      const deps = jobDepsFactory(req, creds);
      try {
        const submitted = await submitJob({ jobType: String(args.job_type || ''), input: args.input, deps });
        if (submitted.accepted) {
          skillTelemetry.paymentType = 'free_tier';
          skillTelemetry.status = 'ok';
          return res.status(200).json({ jsonrpc: '2.0', result: await jobTask(submitted.job, version, inboundMessage), id: requestId });
        }
        const gate = await deps.gate(submitted.job, undefined);
        skillTelemetry.status = 'payment_required';
        return res.status(200).json({ jsonrpc: '2.0', result: await jobTask(submitted.job, version, inboundMessage, { paymentRequired: gate.paymentRequired }), id: requestId });
      } catch (err) {
        if (err && err.jobRefusal) {
          skillTelemetry.status = err.status === 503 ? 'server_error' : 'invalid_input';
          return jobRefusalResponse(res, err, requestId, pg1RequestId);
        }
        throw err;
      }
    }

    // Tool Foundry (lib/foundry): build_tool requests and commissioned ft_* tools.
    if (skill === FOUNDRY_SKILL || isFoundryToolName(skill)) {
      skillTelemetry = { skill, req, status: null, startedAt: Date.now(), paymentType: 'none' };
      let creds;
      try { creds = getSupabaseCreds(); } catch (e) { return jsonRpcError(res, 503, SERVICE_UNAVAILABLE_CODE, 'The Foundry is not available on this deployment.', requestId, undefined, pg1RequestId); }
      const metaPayment = inboundMessage && inboundMessage.metadata && inboundMessage.metadata[X402_META.payload];
      try {
        if (skill === FOUNDRY_SKILL) {
          const deps = await foundryDepsFactory(req, creds);
          let out;
          if (typeof args.job_id === 'string') {
            if (metaPayment) {
              out = await payBuild(args.job_id, { ...deps, gate: (job) => runPricedX402Gate(req, { payment: metaPayment, priceUsd: Number(job.build_fee_usd), description: `PG1 Foundry build fee: ft_${job.spec.name}` }), subscriberHash: payerHash });
              if (out.settlement) skillTelemetry.paymentType = 'x402';
            } else {
              const job = await deps.store.getJob(args.job_id);
              if (!job) throw new FoundryRefusal('No such Foundry job.', { status: 404, code: 'not_found' });
              out = { job: await refreshBuild(job, deps) };
              if (['quoted', 'counter_offer'].includes(out.job.status)) out.paymentRequired = (await runPricedX402Gate(req, { priceUsd: Number(out.job.build_fee_usd), description: `PG1 Foundry build fee: ft_${out.job.spec.name}` })).paymentRequired;
            }
          } else {
            const job = await submitBuild({ spec: args.spec, offer: args.offer, visibility: args.visibility || 'private' }, deps);
            out = { job };
            if (['quoted', 'counter_offer'].includes(job.status)) out.paymentRequired = (await runPricedX402Gate(req, { priceUsd: Number(job.build_fee_usd), description: `PG1 Foundry build fee: ft_${job.spec.name}` })).paymentRequired;
          }
          skillTelemetry.status = 'ok';
          return res.status(200).json({ jsonrpc: '2.0', result: foundryTask(out.job, version, inboundMessage, { paymentRequired: out.paymentRequired, settlement: out.settlement, tool: out.tool }), id: requestId });
        }
        const store = createFoundryStore({ supUrl: creds.supUrl, supKey: creds.supKey });
        const called = await callFoundryTool({ name: skill, args, toolKey: req.headers[TOOL_KEY_HEADER] || null }, {
          store,
          gate: (priceUsd, description) => runPricedX402Gate(req, { payment: metaPayment || undefined, priceUsd, description }),
          paymentOffered: !!(metaPayment || req.headers['payment-signature'] || req.headers['x-payment']),
          subscriberHash: payerHash,
          runTool: internalRunTool,
          screen: null
        });
        if (called.paymentRequired) {
          skillTelemetry.status = 'payment_required';
          return res.status(200).json({ jsonrpc: '2.0', result: paymentRequiredTask(skill, args, called.paymentRequired, version, inboundMessage), id: requestId });
        }
        skillTelemetry.paymentType = 'x402';
        skillTelemetry.status = called.result.status === 'unknown' && called.result.checks.some((c) => c.result !== 'ok') ? 'upstream_error' : 'ok';
        const paymentMetadata = called.settlement ? { [X402_META.status]: 'payment-completed', [X402_META.receipts]: [called.settlement] } : undefined;
        return res.status(200).json({ jsonrpc: '2.0', result: taskResult(skill, args, { ...called.result, request_id: pg1RequestId }, version, inboundMessage, { paymentMetadata }), id: requestId });
      } catch (err) {
        if (err && (err.foundryRefusal || err.foundryCall)) {
          skillTelemetry.status = err.status >= 500 ? 'server_error' : 'invalid_input';
          return jsonRpcError(res, 200, err.status === 404 ? A2A_ERROR_CODES.TaskNotFoundError : -32602, err.message, requestId, { code: err.code, ...(err.data || {}) }, pg1RequestId);
        }
        if (err && err.mcpToolError) {
          skillTelemetry.status = 'invalid_input';
          return jsonRpcError(res, 200, -32602, err.message, requestId, { code: err.code }, pg1RequestId);
        }
        throw err;
      }
    }

    if (typeof skill !== 'string' || !A2A_SKILL_NAMES.includes(skill)) {
      if (typeof skill === 'string' && skill) skillTelemetry = { skill, req, unknown: true, startedAt: Date.now() };
      const suggestion = typeof skill === 'string' ? suggestToolName(skill, A2A_SKILL_NAMES) : null;
      return jsonRpcError(res, 400, -32602, formatFixIt({
        problem: `Unknown skill: the DataPart's "skill" is not one of this agent's skills${suggestion ? `. Did you mean ${suggestion}?` : ''}`,
        expected: `"skill" set to one of ${A2A_SKILL_NAMES.join(', ')}`,
        example: suggestion || 'check_domain_age'
      }, pg1RequestId), requestId, { unknown_skill: true, suggestion }, pg1RequestId);
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

    // Paid skills: the shared gate first (api/mcp.mjs resolvePaidAccess).
    let gate = null;
    if (A2A_PAID_SKILL_NAMES.includes(skill)) {
      const metaPayment = inboundMessage && inboundMessage.metadata && inboundMessage.metadata[X402_META.payload];
      gate = await resolvePaidAccess(req, { licenseKey, identifier, payment: metaPayment || undefined, endpoint: '/api/a2a' });
      skillTelemetry.paymentType = !gate.authorized ? 'none' : gate.settle ? 'x402' : gate.consumeFreeTier ? 'free_tier' : 'license';
      if (gate.licenseUnavailable) {
        res.setHeader('Retry-After', '5');
        recordToolError(`/api/a2a:${skill}`, 503, `${skill}_license_verification_unavailable`, 'upstream', pg1RequestId);
        return jsonRpcError(res, 503, SERVICE_UNAVAILABLE_CODE, 'License verification temporarily unavailable, please retry.', requestId, undefined, pg1RequestId);
      }
      if (gate.freeTierRemaining !== undefined) setFreeTierHeaders(res, gate.freeTierRemaining);
      if (gate.licenseError) {
        skillTelemetry.status = 'payment_required';
        return jsonRpcError(res, 200, LICENSE_REJECTED_CODE, 'Payment Required: ' + gate.licenseError, requestId, { payment_required: true }, pg1RequestId);
      }
      if (!gate.authorized) {
        skillTelemetry.status = gate.freeLimitReached ? 'free_limit_reached' : 'payment_required';
        return res.status(200).json({ jsonrpc: '2.0', result: paymentRequiredTask(skill, args, gate.paymentRequired, version, inboundMessage), id: requestId });
      }
    }

    let toolResult;
    try {
      toolResult = gate
        ? await STANDARD_TOOL_HANDLERS[skill](args, paidResponseOptions())
        : await runSkill(skill, args, identifier, licenseKey, req);
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
        skillTelemetry.status = toolErrorTelemetryStatus(err);
        const errorChecks = [buildCheck(SKILL_SOURCE_LABELS[skill] || skill, classifyToolErrorCheckResult(err))];
        const errorData = { code: err.code, ...errorResponseMeta(errorChecks, pg1RequestId) };
        if (err.retryAfter) {
          errorData.retry_after = err.retryAfter;
          res.setHeader('Retry-After', String(err.retryAfter));
        }
        return jsonRpcError(res, 200, -32000, invalidInputMessage(err, pg1RequestId), requestId, errorData, pg1RequestId);
      }
      return jsonRpcError(res, 400, err.notFound ? -32004 : -32602, invalidInputMessage(err, pg1RequestId), requestId, undefined, pg1RequestId);
    }
    toolResult.request_id = pg1RequestId;
    if (skill === 'check_package') logPackageCheckFailures('/api/a2a', toolResult, pg1RequestId);

    let paymentMetadata;
    if (gate && gate.settle) {
      // Settled only now, after the skill succeeded (x402: never before).
      const settleStartedAt = Date.now();
      let settled = null;
      let failure = 'Settlement failed';
      try {
        settled = await gate.settle();
        if (!settled || !settled.success) failure = (settled && (settled.errorMessage || settled.errorReason)) || failure;
      } catch (e) {
        failure = 'Settlement failed: ' + e.message;
      }
      const ok = !!(settled && settled.success);
      recordTelemetry({ eventType: 'settlement', endpoint: '/api/a2a', toolName: skill, paymentType: 'x402', status: ok ? 'settled' : 'failed', latencyMs: Date.now() - settleStartedAt, callerHash: requestCallerHash(req), amountUsd: ok ? x402PriceUsd(X402_PRICE) : null });
      if (!ok) {
        skillTelemetry.status = 'settlement_failed';
        const paymentRequired = await gate.settlementFailurePaymentRequired(failure);
        return res.status(200).json({ jsonrpc: '2.0', result: paymentRequiredTask(skill, args, paymentRequired, version, inboundMessage, { failed: true }), id: requestId });
      }
      paymentMetadata = { [X402_META.status]: 'payment-completed', [X402_META.receipts]: [settled] };
    }
    if (gate && gate.consumeFreeTier) await gate.consumeFreeTier();

    return res.status(200).json({ jsonrpc: '2.0', result: taskResult(skill, args, toolResult, version, inboundMessage, { paymentMetadata }), id: requestId });
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
