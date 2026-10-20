// REST mirror of the preflight_check MCP tool (lib/preflight.mjs).
//
//   POST /api/preflight  { action, target, chain?, ecosystem? }
//   GET  /api/preflight?action=...&target=...
//
// Paid like the other paid tools: 0.01 USD via x402 (PAYMENT-SIGNATURE),
// a Gumroad licence key (X-API-KEY), or the shared 5/day free tier first.
// An unpaid call gets 402 with the PAYMENT-REQUIRED header and the payment
// request as the body. A paid result carries a top-level `signature`
// (lib/signing.mjs); x402 settles only after the checks ran.

import crypto from 'node:crypto';
import { resolvePaidAccess, STANDARD_TOOL_HANDLERS, recordToolError, requestCallerHash } from './mcp.mjs';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { getRequestIdentifier, setFreeTierHeaders } from '../lib/freeTier.mjs';
import { PREFLIGHT_TOOL } from '../lib/preflight.mjs';
import { signResult } from '../lib/signing.mjs';
import { recordTelemetry } from '../lib/telemetry.mjs';
import { callerKindOf } from '../lib/ownTraffic.mjs';
import { X402_PRICE, x402PriceUsd } from '../lib/x402Config.mjs';
import { queryOf } from '../lib/requestQuery.mjs';

export const config = { maxDuration: 20 };

const ALLOW_HEADERS = 'Content-Type, Accept, x-api-key, PAYMENT-SIGNATURE, X-Payment, X-Free-Tier';

function preflightArgs(req) {
  const src = req.method === 'GET' ? queryOf(req) : (req.body && typeof req.body === 'object' ? req.body : {});
  const pick = (k) => (typeof src[k] === 'string' ? src[k] : undefined);
  const out = { action: pick('action'), target: pick('target') };
  if (pick('chain')) out.chain = pick('chain');
  if (pick('ecosystem')) out.ecosystem = pick('ecosystem');
  return out.action && out.target ? out : null;
}

// A paid REST endpoint for one PG1 tool: licence key, the shared free tier,
// then x402 (PAYMENT-SIGNATURE); 402 with PAYMENT-REQUIRED when unpaid;
// settled only after the tool ran; the result signed at the top level.
// argsFrom(req) returns the tool's arguments, or null for a 400 with `usage`.
export function makePaidRestHandler({ tool, endpoint, argsFrom, usage }) {
  return async function paidRestHandler(req, res) {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Free-Tier-Limit, X-Free-Tier-Remaining, X-Request-Id');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      return res.status(405).json({ error: 'method not allowed', request_id: requestId });
    }
    const args = argsFrom(req);
    if (!args) return res.status(400).json({ error: 'invalid_input', message: usage, request_id: requestId });

    const startedAt = Date.now();
    const telemetry = { status: 'ok', paymentType: 'none' };
    try {
      const licenseKey = req.headers['x-api-key'];
      const identifier = getRequestIdentifier(req);
      const gate = await resolvePaidAccess(req, { licenseKey, identifier, endpoint });
      telemetry.paymentType = !gate.authorized ? 'none' : gate.settle ? 'x402' : gate.consumeFreeTier ? 'free_tier' : 'license';
      if (gate.licenseUnavailable) {
        res.setHeader('Retry-After', '5');
        telemetry.status = 'server_error';
        return res.status(503).json({ error: 'license_verification_unavailable', message: 'Licence verification is temporarily unavailable, please retry.', request_id: requestId });
      }
      if (gate.payerRefused || gate.screeningUnavailable) {
        telemetry.status = gate.payerRefused ? 'payer_refused' : 'server_error';
        if (gate.screeningUnavailable) res.setHeader('Retry-After', '60');
        return res.status(gate.payerRefused ? 403 : 503).json({ error: gate.payerRefused ? 'payer_refused' : 'screening_unavailable', message: gate.message, request_id: requestId });
      }
      if (gate.freeTierRemaining !== undefined) setFreeTierHeaders(res, gate.freeTierRemaining);
      if (gate.licenseError) {
        telemetry.status = 'payment_required';
        return res.status(402).json({ error: 'payment_required', message: gate.licenseError, request_id: requestId });
      }
      if (!gate.authorized) {
        telemetry.status = gate.freeLimitReached ? 'free_limit_reached' : 'payment_required';
        res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(gate.paymentRequired));
        return res.status(402).json(gate.paymentRequired);
      }

      let result;
      try {
        result = await STANDARD_TOOL_HANDLERS[tool](args);
      } catch (err) {
        if (err && err.mcpToolError) {
          telemetry.status = 'client_error';
          return res.status(400).json({ error: err.code || 'invalid_input', message: err.message, request_id: requestId });
        }
        throw err;
      }
      result.request_id = requestId;

      if (gate.settle) {
        let settled = null;
        try { settled = await gate.settle(); } catch (e) { settled = null; }
        const ok = !!(settled && settled.success);
        recordTelemetry({ eventType: 'settlement', endpoint, toolName: tool, paymentType: 'x402', status: ok ? 'settled' : 'failed', latencyMs: Date.now() - startedAt, callerHash: requestCallerHash(req), callerKind: callerKindOf(req), amountUsd: ok ? x402PriceUsd(X402_PRICE) : null });
        if (!ok) {
          telemetry.status = 'settlement_failed';
          const paymentRequired = await gate.settlementFailurePaymentRequired((settled && (settled.errorMessage || settled.errorReason)) || 'Settlement failed');
          res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(paymentRequired));
          return res.status(402).json(paymentRequired);
        }
        res.setHeader('PAYMENT-RESPONSE', encodePaymentResponseHeader(settled));
      }
      if (gate.consumeFreeTier) await gate.consumeFreeTier();

      const signature = signResult({ tool, args, result });
      return res.status(200).json(signature ? { ...result, signature } : result);
    } catch (err) {
      console.error(`[${tool}] unhandled:`, err && err.message);
      recordToolError(endpoint, 500, 'unhandled_exception', 'js_error', requestId);
      telemetry.status = 'server_error';
      return res.status(500).json({ error: 'internal_error', request_id: requestId });
    } finally {
      recordTelemetry({ eventType: 'tool_call', endpoint, toolName: tool, paymentType: telemetry.paymentType, status: telemetry.status, latencyMs: Date.now() - startedAt, callerHash: requestCallerHash(req), callerKind: callerKindOf(req) });
    }
  };
}

export default makePaidRestHandler({
  tool: PREFLIGHT_TOOL,
  endpoint: '/api/preflight',
  argsFrom: preflightArgs,
  usage: 'action and target are required. Example: {"action":"pay","target":"0x...","chain":"base"}'
});
