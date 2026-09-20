// MCP (Model Context Protocol) server exposing PG1's STIX threat-intel feed
// as a callable tool for AI agents/clients. Implements the minimal JSON-RPC
// 2.0 surface MCP clients expect: initialize, tools/list, tools/call.
//
// Deliberately self-contained (no import from chat.mjs) so this endpoint
// stays independent of that file's build status.
//
// MONETIZATION: tools/call requires payment via ONE of:
//   1. x402 (X-PAYMENT header) - agent-native, pay-per-call, no signup
//   2. Gumroad license key (X-API-KEY header) - static key, human/dev friendly
// tools/list and initialize remain free so agents can discover and price
// the tool before committing to pay.

import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';

export const config = {
  maxDuration: 30
};

// ---------------------------------------------------------------------
// X402 PAYMENT LAYER
// ---------------------------------------------------------------------
// Built once at module load, same pattern as chat.mjs's x402 setup, but
// fully independent - a failure here never touches that file or vice versa.
var X402_PAY_TO = (process.env.X402_PAY_TO_ADDRESS || '').trim();
var x402Middleware = null;
if (X402_PAY_TO) {
  try {
    var x402FacilitatorClient = createCdpFacilitatorClient();
    var x402Server = new x402ResourceServer(x402FacilitatorClient).register('eip155:8453', new ExactEvmScheme());
    x402Middleware = paymentMiddleware(
      {
        'POST /api/mcp': {
          accepts: [{ scheme: 'exact', price: '$0.01', network: 'eip155:8453', payTo: X402_PAY_TO }],
          description: 'PG1 Sovereign Threat Intelligence MCP tool: get_threat_indicators (STIX 2.1 bundle).',
          mimeType: 'application/json'
        }
      },
      x402Server
    );
  } catch (e) {
    console.error('[X402] Setup failed on /api/mcp, payment path disabled for this invocation:', e.message);
    x402Middleware = null;
  }
}

function escapeStixValue(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id: id, result: result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id, error: { code: code, message: message } };
}

async function verifyGumroadLicense(licenseKey) {
  if (!licenseKey) return { valid: false, error: 'No license key provided.' };
  try {
    var gumroadRes = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ product_id: process.env.GUMROAD_PRODUCT_ID, license_key: licenseKey })
    });
    var gumroadData = await gumroadRes.json();
    if (!gumroadData.success || (gumroadData.purchase && (gumroadData.purchase.refunded || gumroadData.purchase.chargebacked))) {
      return { valid: false, error: 'Invalid, expired, or refunded license key.' };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, error: 'License verification failed: ' + e.message };
  }
}

async function fetchStixBundle(params) {
  var supUrl = (process.env.SUPABASE_URL || '').replace(/\s+/g, '');
  var supKey = (process.env.SUPABASEAPI_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLEKEY || '').replace(/\s+/g, '');

  if (!supUrl || !supKey) {
    throw new Error('Supabase not configured on this deployment.');
  }

  var minScore = params && params.min_score ? params.min_score : '0';
  var limit = Math.min(parseInt((params && params.limit) || '500', 10), 1000);
  var since = params && params.since;
  var type = params && params.type;

  var queryFilters = [
    'select=*',
    `confidence_score=gte.${minScore}`,
    'order=last_seen.desc',
    `limit=${limit}`
  ];
  if (since) queryFilters.push(`last_seen=gte.${since}`);
  if (type) queryFilters.push(`indicator_type=eq.${type}`);

  var threatRes = await fetch(`${supUrl}/rest/v1/threat_ioc_telemetry?${queryFilters.join('&')}`, {
    headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }
  });
  var rawTelemetry = threatRes.ok ? await threatRes.json() : [];

  var stixObjects = rawTelemetry.map(function (record) {
    var patternValue = record.stix_pattern;
    if (!patternValue) {
      var safeValue = escapeStixValue(record.value);
      if (record.indicator_type === 'IPv4') patternValue = `[ipv4-addr:value = '${safeValue}']`;
      else if (record.indicator_type === 'domain') patternValue = `[domain-name:value = '${safeValue}']`;
      else if (record.indicator_type === 'URL') patternValue = `[url:value = '${safeValue}']`;
      else if (String(record.indicator_type).includes('FileHash')) patternValue = `[file:hashes.'SHA-256'