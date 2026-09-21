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
var X402_PAY_TO = (process.env.X402_PAY_TO_ADDRESS || '').trim();
var x402Middleware = null;
var x402Server = null;
if (X402_PAY_TO) {
  try {
    var x402FacilitatorClient = createCdpFacilitatorClient();
    x402Server = new x402ResourceServer(x402FacilitatorClient).register('eip155:8453', new ExactEvmScheme());
    // syncFacilitatorOnStart=false: @x402/express would otherwise call
    // x402Server.initialize() itself (fetching supported payment kinds from
    // the facilitator) and, on failure, write its own raw 500 straight to
    // `res` - bypassing our JSON-RPC error format and never invoking the
    // next()-style callback we pass to x402Middleware below, which left the
    // request awaiting a promise that never settles. We drive
    // initialization ourselves via ensureX402Initialized() instead, with a
    // timeout, so a facilitator outage degrades to the generic
    // payment-required message rather than a 500/hang (issue #82).
    x402Middleware = paymentMiddleware(
      {
        'POST /api/mcp': {
          accepts: [{ scheme: 'exact', price: '$0.01', network: 'eip155:8453', payTo: X402_PAY_TO }],
          description: 'PG1 Sovereign Threat Intelligence MCP tool: get_threat_indicators (STIX 2.1 bundle).',
          mimeType: 'application/json'
        }
      },
      x402Server,
      undefined,
      undefined,
      false
    );
  } catch (e) {
    console.error('[X402] Setup failed on /api/mcp, payment path disabled for this invocation:', e.message);
    x402Middleware = null;
  }
} else {
  console.warn('[X402_DEBUG] X402_PAY_TO_ADDRESS is not set - x402 payment path is disabled for this lambda instance; all tools/call requests will fall through to the generic payment-required error regardless of X-PAYMENT header.');
}

// Cached across warm invocations of this lambda instance. On failure we
// clear the cache so the next request retries rather than sticking with a
// permanently-broken facilitator connection until a cold start.
var x402InitPromise = null;
var x402Initialized = false;
var X402_INIT_TIMEOUT_MS = 8000;

function ensureX402Initialized() {
  if (x402Initialized) return Promise.resolve(true);
  if (!x402Server) return Promise.resolve(false);
  if (!x402InitPromise) {
    x402InitPromise = Promise.race([
      x402Server.initialize(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('facilitator initialize() timed out after ' + X402_INIT_TIMEOUT_MS + 'ms')), X402_INIT_TIMEOUT_MS))
    ]).then(function () {
      x402Initialized = true;
      return true;
    }).catch(function (err) {
      console.error('[X402_DEBUG] facilitator initialize() failed, x402 payment path unavailable for this request:', err.message);
      x402InitPromise = null;
      return false;
    });
  }
  return x402InitPromise;
}

// TEMP DEBUG (issue #80): decode+parse the X-PAYMENT header ourselves, purely
// for diagnostics - the actual verification decode happens inside
// @x402/express, which we can't instrument directly.
function debugLogPaymentHeader(rawPaymentHeader) {
  if (!rawPaymentHeader) return;
  try {
    var decoded = Buffer.from(String(rawPaymentHeader), 'base64').toString('utf-8');
    var parsed = JSON.parse(decoded);
    console.log('[X402_DEBUG] x-payment header decoded+parsed OK. scheme=%s network=%s', parsed && parsed.scheme, parsed && parsed.network);
  } catch (decodeErr) {
    console.log('[X402_DEBUG] x-payment header failed to base64-decode/JSON-parse:', decodeErr.message);
  }
}

// @x402/express's ExpressAdapter assumes a real Express request (.header(),
// .path, .protocol, .originalUrl) - these are raw Vercel serverless request
// objects instead, so calling the middleware directly used to throw
// "this.req.header is not a function" whenever an X-PAYMENT header arrived.
function ensureExpressCompat(req) {
  if (typeof req.header !== 'function') {
    req.header = req.get = function (name) {
      var value = req.headers[String(name).toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    };
  }
  if (req.path === undefined) req.path = (req.url || '/').split('?')[0];
  if (req.originalUrl === undefined) req.originalUrl = req.url;
  if (req.protocol === undefined) {
    var forwardedProto = req.headers['x-forwarded-proto'];
    req.protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) || 'https';
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
      else if (String(record.indicator_type).includes('FileHash')) patternValue = `[file:hashes.'SHA-256' = '${safeValue}']`;
      else patternValue = `[custom-object:value = '${safeValue}']`;
    }
    return {
      type: 'indicator',
      spec_version: '2.1',
      id: `indicator--${crypto.randomUUID()}`,
      created: record.ingested_at || new Date().toISOString(),
      modified: record.last_seen || new Date().toISOString(),
      name: `${record.indicator_type} Threat Indicator - ${record.value}`,
      description: `Telemetry feed record verified via ${record.verification_source || 'Sovereign Engine'}.`,
      indicator_types: ['malicious-activity'],
      pattern: patternValue,
      pattern_type: 'stix',
      valid_from: record.last_seen || new Date().toISOString(),
      confidence: parseInt(record.confidence_score, 10) || 50
    };
  });

  return {
    type: 'bundle',
    id: `bundle--${crypto.randomUUID()}`,
    objects: stixObjects
  };
}

var TOOLS = [
  {
    name: 'get_threat_indicators',
    description: 'PG1 Sovereign Threat Intelligence: returns a STIX 2.1 bundle of verified threat indicators (IPs, domains, URLs, file hashes) sourced from ThreatFox, URLhaus, AbuseIPDB, OTX and NVD. Payment required: $0.01 via x402 (X-PAYMENT header) or a valid Gumroad license key (X-API-KEY header).',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO timestamp; only return indicators last seen after this time.' },
        type: { type: 'string', description: "Filter by indicator_type, e.g. 'IPv4', 'domain', 'URL'." },
        min_score: { type: 'string', description: 'Minimum confidence score (0-100).' },
        limit: { type: 'string', description: 'Max indicators to return (default 500, max 1000).' }
      }
    }
  }
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-PAYMENT');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json(jsonRpcError(null, -32600, 'Method Not Allowed'));
  }

  var getHeader = (name) => req.headers[String(name).toLowerCase()];

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  var id = body.id != null ? body.id : null;
  var method = body.method;
  var params = body.params || {};

  try {
    if (method === 'initialize') {
      return res.status(200).json(jsonRpcResult(id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'pg1-threat-intel', version: '1.1.0' },
        capabilities: { tools: {} }
      }));
    }

    if (method === 'tools/list') {
      return res.status(200).json(jsonRpcResult(id, { tools: TOOLS }));
    }

    if (method === 'tools/call') {
      var toolName = params.name;
      var toolArgs = params.arguments || {};

      if (toolName !== 'get_threat_indicators') {
        return res.status(200).json(jsonRpcError(id, -32601, `Unknown tool: ${toolName}`));
      }

      var rawPaymentHeader = getHeader('x-payment');
      var hasPaymentHeader = !!rawPaymentHeader;
      var licenseKey = getHeader('x-api-key');

      console.log('[X402_DEBUG] x-payment header present:', hasPaymentHeader, '| length:', rawPaymentHeader ? String(rawPaymentHeader).length : 0);
      console.log('[X402_DEBUG] x402Middleware configured:', !!x402Middleware, '| X402_PAY_TO set:', !!X402_PAY_TO);
      debugLogPaymentHeader(rawPaymentHeader);

      if (x402Middleware && hasPaymentHeader) {
        var facilitatorReady = await ensureX402Initialized();
        if (!facilitatorReady) {
          return res.status(200).json(jsonRpcError(id, -32004,
            'x402 payment path is temporarily unavailable (facilitator unreachable). Please retry shortly, or provide a valid Gumroad license key in an X-API-KEY header.'));
        }
        ensureExpressCompat(req);
        console.log('[X402_DEBUG] post-shim route match check: method=%s path=%s (registered route is "POST /api/mcp")', req.method, req.path);
        var x402Paid = false;
        try {
          await new Promise((resolve, reject) => {
            x402Middleware(req, res, function (err) {
              if (err) { reject(err); return; }
              x402Paid = true;
              resolve();
            });
          });
        } catch (x402Err) {
          if (!res.headersSent) {
            return res.status(402).json(jsonRpcError(id, -32001, 'Payment verification failed: ' + x402Err.message));
          }
          return;
        }
        if (!x402Paid) {
          return;
        }
        var bundle = await fetchStixBundle(toolArgs);
        return res.status(200).json(jsonRpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(bundle, null, 2) }]
        }));
      }

      if (licenseKey) {
        var licenseCheck = await verifyGumroadLicense(licenseKey);
        if (!licenseCheck.valid) {
          return res.status(200).json(jsonRpcError(id, -32002, 'Payment required: ' + licenseCheck.error));
        }
        var bundle2 = await fetchStixBundle(toolArgs);
        return res.status(200).json(jsonRpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(bundle2, null, 2) }]
        }));
      }

      console.log('[X402_DEBUG] falling through to generic payment-required error. hasPaymentHeader=%s x402Middleware configured=%s licenseKeyPresent=%s', hasPaymentHeader, !!x402Middleware, !!licenseKey);
      return res.status(200).json(jsonRpcError(id, -32003,
        'Payment required. Pay $0.01 via x402 (send an X-PAYMENT header) or provide a valid Gumroad license key in an X-API-KEY header.'));
    }

    return res.status(200).json(jsonRpcError(id, -32601, `Unknown method: ${method}`));
  } catch (err) {
    return res.status(200).json(jsonRpcError(id, -32000, err.message));
  }
}