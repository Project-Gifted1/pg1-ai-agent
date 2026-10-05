// POST /api/playground {tool, input, chain?} - the public tools playground.
//
// Runs one always-free check (lib/playground.mjs PLAYGROUND_TOOLS) through
// the shared read-only tool runner and answers with the result card the
// page renders. No chat, no model, no sign-in, no cookies: the only thing
// kept about a caller is the rate-limit counter (lib/playground.mjs).
//
// Responses (JSON, every one with a request_id):
//   200 { ok: true, card }
//   400 { ok: false, error: { code: 'invalid_input' | 'not_available', message }, request_id }
//   405 { ok: false, error: { code: 'method_not_allowed', message }, request_id }
//   429 { ok: false, error: { code: 'rate_limited', message, retry_after_seconds }, request_id }
//   500 { ok: false, error: { code: 'unavailable', message }, request_id }
// Messages are fixed, neutral sentences: never the input, a provider or
// model name, or an upstream error. Failures are written to pg1_errors
// under the request_id only.
//
// Usage telemetry (lib/telemetry.mjs): one agent_telemetry row per check
// that got past validation - the tool name, how it ended (ok, tool_error,
// rate_limited, server_error), whether it was a fixture, and a salted hash
// of the caller IP. Never the input.

import crypto from 'node:crypto';
import { recordToolError } from './mcp.mjs';
import { createToolExecutor } from '../lib/chatTools.mjs';
import { getRequestIdentifier } from '../lib/freeTier.mjs';
import { recordTelemetry, callerHash } from '../lib/telemetry.mjs';
import { resolveEnsName } from '../lib/ens.mjs';
import {
  validatePlaygroundRequest, toolArgs, createPlaygroundLimiter, limitMessage, playgroundCard, MESSAGES
} from '../lib/playground.mjs';

export const config = { maxDuration: 30 };

const ROUTE = '/api/playground';

function send(res, status, payload, requestId) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (requestId) res.setHeader('X-Request-Id', requestId);
  return res.status(status).json(payload);
}

function parseBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string' && b.length <= 4096) {
    try { return JSON.parse(b); } catch { return null; }
  }
  return null;
}

// createPlaygroundHandler({ limiter, resolveEns, executorOptions, record, telemetry })
// Everything injectable is for tests; the default export uses the real ones.
export function createPlaygroundHandler({
  limiter = createPlaygroundLimiter(),
  resolveEns = resolveEnsName,
  executorOptions = {},
  record = recordToolError,
  telemetry = recordTelemetry
} = {}) {
  function track(tool, ip, startedAt, status, isFixture) {
    try {
      telemetry({ eventType: 'tool_call', endpoint: ROUTE, toolName: tool, paymentType: 'free', status, latencyMs: Date.now() - startedAt, callerHash: callerHash(ip), isFixture: isFixture === true });
    } catch {
      // Best-effort - telemetry never affects the response.
    }
  }

  return async function handler(req, res) {
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return res.status(204).end();
    }
    if (req.method !== 'POST') {
      const requestId = crypto.randomUUID();
      res.setHeader('Allow', 'POST, OPTIONS');
      return send(res, 405, { ok: false, error: { code: 'method_not_allowed', message: MESSAGES.bad_request }, request_id: requestId }, requestId);
    }

    const valid = validatePlaygroundRequest(parseBody(req));
    if (!valid.ok) {
      const requestId = crypto.randomUUID();
      const code = valid.message === MESSAGES.not_available ? 'not_available' : 'invalid_input';
      return send(res, 400, { ok: false, error: { code, message: valid.message }, request_id: requestId }, requestId);
    }

    const ip = getRequestIdentifier(req);
    const startedAt = Date.now();
    const allowed = limiter.take(valid.tool, ip);
    if (!allowed.ok) {
      track(valid.tool, ip, startedAt, 'rate_limited', false);
      const requestId = crypto.randomUUID();
      const retry = Math.max(1, Math.ceil(allowed.retryMs / 1000));
      res.setHeader('Retry-After', String(retry));
      return send(res, 429, { ok: false, error: { code: 'rate_limited', message: limitMessage(allowed.scope, allowed.retryMs), retry_after_seconds: retry }, request_id: requestId }, requestId);
    }

    try {
      // The visitor key, never the raw IP, is what the tool's own limiter
      // and log see. An ENS name is resolved inside the executor, with the
      // same lookup the chat uses (lib/ens.mjs).
      const execute = createToolExecutor({ role: 'guest', identifier: `playground:${limiter.visitorKey(ip)}`, route: ROUTE, record, resolveEns, ...executorOptions });
      const outcome = await execute({ id: null, name: valid.tool, args: toolArgs(valid) });
      const card = playgroundCard(outcome);
      track(valid.tool, ip, startedAt, outcome.ok ? 'ok' : outcome.code === 'rate_limited' ? 'rate_limited' : 'tool_error', outcome.test_fixture === true);
      return send(res, 200, { ok: true, card }, card.request_id);
    } catch (err) {
      const requestId = crypto.randomUUID();
      track(valid.tool, ip, startedAt, 'server_error', false);
      record(ROUTE, 500, 'playground_unhandled_error', 'js_error', requestId);
      return send(res, 500, { ok: false, error: { code: 'unavailable', message: 'The check could not be completed right now.' }, request_id: requestId }, requestId);
    }
  };
}

export default createPlaygroundHandler();
