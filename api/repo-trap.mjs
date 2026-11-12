// REST mirror of the check_repo_trap tool (lib/repoTrap.mjs, 1.22.0).
//
//   POST /api/repo-trap  { files: [{ path, size?, executable?, magic_hex?, text? }], name? }
//
// Always free, 60/hour per caller (a Gumroad licence key in X-API-KEY lifts
// the limit), like the MCP tool and the A2A skill. The result is signed at
// the top level (`signature`, lib/signing.mjs). PG1 never fetches, decodes or
// runs anything from the project and stores nothing: telemetry records the
// call's status, and the Kingdom's defence recorder the verdict and reason
// codes only, never a path or any file content.

import crypto from 'node:crypto';
import { runReadOnlyTool, recordToolError, requestCallerHash } from './mcp.mjs';
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, x-api-key');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After, Link');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed', message: REPO_TRAP_USAGE, request_id: requestId });
  }
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) return res.status(400).json({ error: 'invalid_input', message: REPO_TRAP_USAGE, request_id: requestId });

  const startedAt = Date.now();
  const telemetry = { status: 'ok', paymentType: 'free' };
  try {
    let result;
    try {
      result = await runReadOnlyTool(REPO_TRAP_TOOL, body, { identifier: getRequestIdentifier(req), licenseKey: req.headers['x-api-key'] });
    } catch (err) {
      if (err && err.mcpToolError) {
        telemetry.status = toolErrorTelemetryStatus(err);
        if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
        const status = err.code === 'rate_limited' ? 429 : err.code === 'too_large' ? 413 : 400;
        return res.status(status).json({ error: err.code || 'invalid_input', message: invalidInputMessage(err, requestId), request_id: requestId });
      }
      throw err;
    }
    result.request_id = requestId;
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
    recordTelemetry({ eventType: 'tool_call', endpoint: ENDPOINT, toolName: REPO_TRAP_TOOL, paymentType: telemetry.paymentType, status: telemetry.status, latencyMs: Date.now() - startedAt, callerHash: requestCallerHash(req), countryCode: requestCountry(req), callerKind: callerKindOf(req) });
  }
}
