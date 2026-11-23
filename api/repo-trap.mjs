// REST mirror of the check_repo_trap tool (lib/repoTrap.mjs, 1.22.0).
//
//   POST /api/repo-trap  { files: [{ path, size?, executable?, magic_hex?, text? }], name? }
//
// Metered like the MCP tool and the A2A skill (lib/plans.mjs, 1.23.0): the
// caller's plan from X-API-KEY (a free key, a licence or none), the shared
// quota with check_agent_message, 60/hour per caller without a key. With
// PG1_PAID_CHECKS on, a caller over its free limit gets HTTP 402 with an x402
// challenge at 0.002 USD (PAYMENT-REQUIRED header), and a request carrying
// PAYMENT-SIGNATURE / X-Payment pays per check. The result is signed at
// the top level (`signature`, lib/signing.mjs). PG1 never fetches, decodes or
// runs anything from the project and stores nothing: telemetry records the
// call's status, and the Kingdom's defence recorder the verdict and reason
// codes only, never a path or any file content.

import crypto from 'node:crypto';
import { runReadOnlyTool, recordToolError, requestCallerHash, runPricedX402Gate, screenPaymentPayer, payPerCheckDescription, withPlanLinks } from './mcp.mjs';
import { isPaidChecksOn, PAY_PER_CHECK_USD, limitLinks } from '../lib/plans.mjs';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { getRequestIdentifier } from '../lib/freeTier.mjs';
import { REPO_TRAP_TOOL } from '../lib/repoTrap.mjs';
import { signResult, addJwksLink } from '../lib/signing.mjs';
import { recordTelemetry, toolErrorTelemetryStatus } from '../lib/telemetry.mjs';
import { requestCountry, recordDefenseEvent } from '../lib/defenseEvents.mjs';
import { callerKindOf } from '../lib/ownTraffic.mjs';
import { invalidInputMessage } from '../lib/invalidInput.mjs';

export const config = { maxDuration: 10 };

const ENDPOINT = '/api/repo-trap';
export const REPO_TRAP_USAGE = 'POST a JSON body with files: [{ path, size?, executable?, magic_hex?, text? }] (up to 2000 files, 16 KB of text per file, 256 KB in all) and optionally name. Example: {"files":[{"path":"README.md","text":"# Tool"},{"path":"struct.py","size":900},{"path":"data.bin","size":40960,"magic_hex":"789c"}]}';

export default async function repoTrapHandler(req, res) {
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, x-api-key, PAYMENT-SIGNATURE, X-Payment');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After, Link, PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PG1-Plan, X-PG1-Quota, X-PG1-Quota-Remaining, X-PG1-Quota-Reset');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed', message: REPO_TRAP_USAGE, request_id: requestId });
  }
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) return res.status(400).json({ error: 'invalid_input', message: REPO_TRAP_USAGE, request_id: requestId });

  const startedAt = Date.now();
  const telemetry = { status: 'ok', paymentType: 'free' };
  const meterOut = {};
  const applyMeter = () => {
    if (meterOut.tier) telemetry.plan = meterOut.tier;
    for (const [k, v] of Object.entries(meterOut.headers || {})) res.setHeader(k, v);
  };
  const challenge = async (meterErr) => {
    const gate = await runPricedX402Gate(req, { priceUsd: PAY_PER_CHECK_USD, description: payPerCheckDescription(REPO_TRAP_TOOL) });
    const pr = withPlanLinks(gate.paymentRequired, meterErr);
    try { res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(pr)); } catch (e) { /* header is optional */ }
    return res.status(402).json({ error: 'payment_required', message: pr.error, ...limitLinks(), pay_per_check_usd: PAY_PER_CHECK_USD, ...(meterErr && meterErr.meter ? { plan: meterErr.meter.plan, quota: meterErr.meter.quota, resets_at: meterErr.meter.resets_at } : {}), x402: pr, request_id: requestId });
  };
  try {
    let checkGate = null;
    if (isPaidChecksOn() && (req.headers['payment-signature'] || req.headers['x-payment'])) {
      checkGate = await runPricedX402Gate(req, { priceUsd: PAY_PER_CHECK_USD, description: payPerCheckDescription(REPO_TRAP_TOOL) });
      if (!checkGate.authorized) {
        telemetry.status = 'payment_required';
        const pr = withPlanLinks(checkGate.paymentRequired);
        try { res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(pr)); } catch (e) { /* optional */ }
        return res.status(402).json({ error: 'payment_required', message: pr.error, ...limitLinks(), pay_per_check_usd: PAY_PER_CHECK_USD, x402: pr, request_id: requestId });
      }
      const screened = await screenPaymentPayer(checkGate.payer, 'per-check /api/repo-trap');
      if (!screened.allowed) {
        telemetry.status = screened.refused ? 'payer_refused' : 'server_error';
        if (screened.unavailable) res.setHeader('Retry-After', '60');
        return res.status(screened.refused ? 403 : 503).json({ error: screened.refused ? 'payer_refused' : 'screening_unavailable', message: screened.message, request_id: requestId });
      }
    }
    let result;
    try {
      result = await runReadOnlyTool(REPO_TRAP_TOOL, body, { identifier: getRequestIdentifier(req), licenseKey: req.headers['x-api-key'], metered: true, paid: !!checkGate, meterOut });
    } catch (err) {
      applyMeter();
      if (err && err.code === 'payment_required' && err.meter) {
        telemetry.status = 'free_limit_reached';
        return await challenge(err);
      }
      if (err && err.mcpToolError) {
        telemetry.status = toolErrorTelemetryStatus(err);
        if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
        const status = err.code === 'rate_limited' || err.code === 'quota_exceeded' ? 429 : err.code === 'too_large' ? 413 : 400;
        return res.status(status).json({ error: err.code || 'invalid_input', message: invalidInputMessage(err, requestId), ...(err.meter || {}), request_id: requestId });
      }
      throw err;
    }
    applyMeter();
    result.request_id = requestId;
    if (checkGate && checkGate.settle) {
      telemetry.paymentType = 'x402';
      let settled = null;
      try { settled = await checkGate.settle(); } catch (e) { settled = null; }
      recordTelemetry({ eventType: 'settlement', endpoint: ENDPOINT, toolName: REPO_TRAP_TOOL, paymentType: 'x402', status: settled && settled.success ? 'settled' : 'failed', callerHash: requestCallerHash(req), countryCode: requestCountry(req), callerKind: callerKindOf(req), plan: telemetry.plan, amountUsd: settled && settled.success ? PAY_PER_CHECK_USD : null });
      if (!settled || !settled.success) {
        telemetry.status = 'settlement_failed';
        const pr = withPlanLinks(await checkGate.settlementFailurePaymentRequired((settled && (settled.errorMessage || settled.errorReason)) || 'Settlement failed'));
        try { res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(pr)); } catch (e) { /* optional */ }
        return res.status(402).json({ error: 'payment_required', message: pr.error, ...limitLinks(), x402: pr, request_id: requestId });
      }
      try { res.setHeader('PAYMENT-RESPONSE', encodePaymentResponseHeader(settled)); } catch (e) { /* optional */ }
    }
    recordDefenseEvent({ toolName: REPO_TRAP_TOOL, endpoint: ENDPOINT, result, country: requestCountry(req), callerHash: requestCallerHash(req), callerKind: callerKindOf(req) });
    const signature = signResult({ tool: REPO_TRAP_TOOL, args: body, result });
    if (signature) addJwksLink(res);
    return res.status(200).json(signature ? { ...result, signature } : result);
  } catch (err) {
    console.error('[check_repo_trap] unhandled:', err && err.message);
    recordToolError(ENDPOINT, 500, 'unhandled_exception', 'js_error', requestId);
    telemetry.status = 'server_error';
    return res.status(500).json({ error: 'internal_error', request_id: requestId });
  } finally {
    recordTelemetry({ eventType: 'tool_call', endpoint: ENDPOINT, toolName: REPO_TRAP_TOOL, paymentType: telemetry.paymentType, status: telemetry.status, latencyMs: Date.now() - startedAt, callerHash: requestCallerHash(req), countryCode: requestCountry(req), callerKind: callerKindOf(req), plan: telemetry.plan });
  }
}
