/**
 * PG1 Sovereign Threat Intelligence MCP Server
 * Endpoint: /api/mcp
 * Protocol: Model Context Protocol (MCP) over Streamable HTTP
 * Monetization: x402 (Base chain micropayments) & Gumroad license keys
 *
 * ---------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------
 * The version you had live (and that Gemini described as a completed,
 * legitimate 1.3.2 build) has two real problems this file fixes:
 *
 *   1. Every tool handler returned HARDCODED sample data regardless of
 *      the arguments passed in — get_cve_details always returned
 *      Log4Shell's numbers, get_ioc_context always returned "Mirai" and
 *      42 observations, get_threat_indicators always returned the same
 *      one fake indicator. No Supabase/NVD/EPSS/KEV calls existed at all.
 *
 *   2. verifyAuthorization() didn't verify anything — it checked
 *      `apiKey.length >= 8` and `xPayment.length > 10`. Any junk string
 *      of the right length was treated as a valid payment. That means
 *      the live endpoint has been giving away paid access for free.
 *
 * This file keeps your tool descriptions (they're good) and your
 * GET-health-check / notifications/initialized handling (also fine),
 * but replaces every handler with a real implementation and restores
 * real payment verification.
 *
 * ASSUMPTIONS — flagged inline, confirm against your actual setup:
 *   - Supabase table `threat_ioc_telemetry` has columns: value,
 *     indicator_type, confidence_score, verification_source,
 *     malware_family, tags, ingested_at, last_seen — matching what we
 *     confirmed populated correctly earlier in this project.
 *   - x402 verification needs your real Coinbase CDP facilitator setup
 *     (X402_PAY_TO_ADDRESS env var, @x402/express, @coinbase/cdp-sdk).
 *     If those aren't installed in THIS deployment, x402 will safely
 *     fall through to "not authorized" rather than silently accept
 *     anything — see the x402 section below for what to install.
 * ---------------------------------------------------------------------
 */

import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';

export const config = { maxDuration: 30 };

// ---------------------------------------------------------------------
// TOOLS — unchanged from what you pasted; descriptions were good
// ---------------------------------------------------------------------

const TOOLS = [
  {
    name: 'get_threat_indicators',
    description: 'PG1 Sovereign Threat Intelligence: returns a STIX 2.1 bundle of verified threat indicators (IPs, domains, URLs, file hashes) sourced from ThreatFox, URLhaus, AbuseIPDB, OTX and NVD. Payment required: $0.01 via x402 (X-PAYMENT header) or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use ONLY for bulk feed synchronizations. Do NOT use for single-item lookups (use get_ioc_context) or CVE analysis (use get_cve_details). USAGE EXCLUSIONS: Does not provide historical query archival beyond the active ingestion window. BEHAVIOR: Pagination is handled via the limit parameter (max 1000). Returns 401 on payment failure.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: ['string', 'null'], description: 'ISO timestamp constraint (e.g., 2026-09-20T00:00:00Z); strictly filters and returns only indicators last seen after this exact timestamp.' },
        type: { type: ['string', 'null'], description: "Indicator category filter. Allowed enum-style values: 'IPv4', 'domain', 'URL', or 'hash'." },
        min_score: { type: ['integer', 'null'], description: 'Confidence score threshold integer ranging inclusively from 0 to 100 to filter low-confidence noise.' },
        limit: { type: ['integer', 'null'], description: 'Pagination boundary constraint defining the maximum number of indicators to return in a single payload (integer between 1 and 1000, defaulting to 500).', default: 500 }
      }
    }
  },
  {
    name: 'get_cve_details',
    description: 'PG1 Sovereign Threat Intelligence: enriched CVE lookup combining NVD (description, CVSS score/vector), FIRST.org EPSS (exploit-probability score and percentile), and the CISA Known Exploited Vulnerabilities catalog (active wild exploitation status). Payment required: $0.01 via x402 (X-PAYMENT header) or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use ONLY for specific CVE lookups. Do NOT use for IP/domain/hash enrichment (use get_ioc_context) or bulk feed ingestion (use get_threat_indicators). USAGE EXCLUSIONS: Does not support wildcard search or threat-actor dossier profiling. BEHAVIOR: Returns 401 on payment failure, 404 if CVE is not found.',
    inputSchema: {
      type: 'object',
      properties: {
        cve_id: { type: 'string', description: "Mandatory official CVE identifier string strictly formatted as 'CVE-YYYY-NNNN' (e.g., 'CVE-2021-44228')." }
      },
      required: ['cve_id']
    }
  },
  {
    name: 'get_ioc_context',
    description: 'PG1 Sovereign Threat Intelligence: looks up a single specific indicator value (IP, domain, URL, or hash) across all telemetry sources and returns aggregated provenance — reporting sources, observation count, aggregated confidence score, known malware families, tags, and first/last seen timestamps. Payment required: $0.01 via x402 (X-PAYMENT header) or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use ONLY for point-lookup enrichment of a single indicator. Do NOT use for bulk intelligence downloads (use get_threat_indicators) or software vulnerability analysis (use get_cve_details). USAGE EXCLUSIONS: Does not perform active port-scanning or live network probing. BEHAVIOR: Returns 401 on payment failure, 404 if the indicator is unobserved.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'Mandatory exact indicator string value to look up, such as an IPv4 address (198.51.100.1), fully qualified domain, complete URL, or SHA-256 hash string.' }
      },
      required: ['value']
    }
  }
];

// ---------------------------------------------------------------------
// SUPABASE HELPERS
// ---------------------------------------------------------------------

function getSupabaseCreds() {
  const supUrl = (process.env.SUPABASE_URL || '').replace(/\s+/g, '');
  const supKey = (process.env.SUPABASEAPI_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLEKEY || '').replace(/\s+/g, '');
  if (!supUrl || !supKey) throw new Error('Supabase not configured on this deployment.');
  return { supUrl, supKey };
}

// ---------------------------------------------------------------------
// REAL HANDLER: get_threat_indicators (was: hardcoded single fake IOC)
// ---------------------------------------------------------------------

async function handleThreatIndicators(args) {
  const { supUrl, supKey } = getSupabaseCreds();

  const minScore = args?.min_score ?? 0;
  const limit = Math.min(parseInt(args?.limit || 500, 10), 1000);
  const since = args?.since;
  const type = args?.type;

  const filters = [
    'select=*',
    `confidence_score=gte.${minScore}`,
    'order=last_seen.desc',
    `limit=${limit}`
  ];
  if (since) filters.push(`last_seen=gte.${since}`);
  if (type) filters.push(`indicator_type=eq.${type}`);

  const res = await fetch(`${supUrl}/rest/v1/threat_ioc_telemetry?${filters.join('&')}`, {
    headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }
  });
  const rows = res.ok ? await res.json() : [];

  const objects = rows.map((record) => {
    const safeValue = String(record.value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    let pattern = record.stix_pattern;
    if (!pattern) {
      if (record.indicator_type === 'IPv4') pattern = `[ipv4-addr:value = '${safeValue}']`;
      else if (record.indicator_type === 'domain') pattern = `[domain-name:value = '${safeValue}']`;
      else if (record.indicator_type === 'URL') pattern = `[url:value = '${safeValue}']`;
      else if (String(record.indicator_type).includes('Hash')) pattern = `[file:hashes.'SHA-256' = '${safeValue}']`;
      else pattern = `[custom-object:value = '${safeValue}']`;
    }
    return {
      type: 'indicator',
      spec_version: '2.1',
      id: `indicator--${crypto.randomUUID()}`,
      created: record.ingested_at || new Date().toISOString(),
      modified: record.last_seen || new Date().toISOString(),
      name: `${record.indicator_type} Threat Indicator - ${record.value}`,
      description: `Telemetry feed record verified via ${record.verification_source || 'PG1 Sovereign Engine'}.`,
      indicator_types: ['malicious-activity'],
      pattern,
      pattern_type: 'stix',
      valid_from: record.last_seen || new Date().toISOString(),
      confidence: parseInt(record.confidence_score, 10) || 50
    };
  });

  return {
    type: 'bundle',
    id: `bundle--${crypto.randomUUID()}`,
    spec_version: '2.1',
    objects
  };
}

// ---------------------------------------------------------------------
// REAL HANDLER: get_cve_details (was: hardcoded Log4Shell numbers always)
// ---------------------------------------------------------------------

var kevCache = null;
var kevCacheTime = 0;
const KEV_CACHE_TTL_MS = 60 * 60 * 1000;

async function getKevCatalog() {
  const now = Date.now();
  if (kevCache && (now - kevCacheTime) < KEV_CACHE_TTL_MS) return kevCache;
  const res = await fetch('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json');
  if (!res.ok) {
    if (kevCache) return kevCache;
    throw new Error('CISA KEV feed fetch failed: ' + res.status);
  }
  const data = await res.json();
  const map = {};
  (data.vulnerabilities || []).forEach((v) => { map[v.cveID] = v; });
  kevCache = map;
  kevCacheTime = now;
  return kevCache;
}

async function fetchEpssScore(cveId) {
  const res = await fetch(`https://api.first.org/data/v1/epss?cve=${encodeURIComponent(cveId)}`);
  if (!res.ok) return null;
  const data = await res.json();
  const record = data.data && data.data[0];
  if (!record) return null;
  return { epss_score: parseFloat(record.epss), epss_percentile: parseFloat(record.percentile) };
}

async function fetchNvdCveDetails(cveId) {
  const headers = {};
  if (process.env.NVD_API_KEY) headers.apiKey = process.env.NVD_API_KEY;
  const res = await fetch(`https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(cveId)}`, { headers });
  if (!res.ok) throw new Error('NVD lookup failed: ' + res.status);
  const data = await res.json();
  const vuln = data.vulnerabilities?.[0]?.cve;
  if (!vuln) return null;

  const enDesc = (vuln.descriptions || []).find((d) => d.lang === 'en');
  const metrics = vuln.metrics || {};
  let cvssData = null, cvssVersion = null;
  if (metrics.cvssMetricV31?.[0]) { cvssData = metrics.cvssMetricV31[0].cvssData; cvssVersion = '3.1'; }
  else if (metrics.cvssMetricV30?.[0]) { cvssData = metrics.cvssMetricV30[0].cvssData; cvssVersion = '3.0'; }
  else if (metrics.cvssMetricV2?.[0]) { cvssData = metrics.cvssMetricV2[0].cvssData; cvssVersion = '2.0'; }

  return {
    description: enDesc ? enDesc.value : null,
    published: vuln.published,
    last_modified: vuln.lastModified,
    cvss_version: cvssVersion,
    cvss_score: cvssData ? cvssData.baseScore : null,
    cvss_severity: cvssData ? cvssData.baseSeverity : null,
    cvss_vector: cvssData ? cvssData.vectorString : null
  };
}

async function handleCveDetails(args) {
  const cveId = args?.cve_id;
  if (!cveId || !/^CVE-\d{4}-\d{4,}$/i.test(String(cveId))) {
    const err = new Error("cve_id is required and must match the format 'CVE-YYYY-NNNN'.");
    err.notFound = true;
    throw err;
  }
  const normalizedId = String(cveId).toUpperCase();

  const [nvd, epss, kevCatalog] = await Promise.all([
    fetchNvdCveDetails(normalizedId).catch((e) => ({ error: e.message })),
    fetchEpssScore(normalizedId).catch(() => null),
    getKevCatalog().catch(() => ({}))
  ]);

  if (!nvd || nvd.error) {
    const err = new Error(`CVE not found or NVD lookup failed for ${normalizedId}.`);
    err.notFound = true;
    throw err;
  }

  const kevEntry = kevCatalog[normalizedId];

  return {
    cve_id: normalizedId,
    nvd: {
      description: nvd.description,
      cvss_v3_score: nvd.cvss_score,
      cvss_vector: nvd.cvss_vector,
      severity: nvd.cvss_severity,
      published: nvd.published,
      last_modified: nvd.last_modified
    },
    epss: epss ? { score: epss.epss_score, percentile: epss.epss_percentile } : null,
    cisa_kev: {
      is_known_exploited: !!kevEntry,
      date_added: kevEntry ? kevEntry.dateAdded : null,
      required_action: kevEntry ? kevEntry.requiredAction : null,
      due_date: kevEntry ? kevEntry.dueDate : null
    }
  };
}

// ---------------------------------------------------------------------
// REAL HANDLER: get_ioc_context (was: hardcoded "Mirai" + 42 always)
// ---------------------------------------------------------------------

function detectIndicatorType(value) {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return 'IPv4';
  if (/^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$/.test(value)) return 'hash';
  if (/^https?:\/\//i.test(value)) return 'URL';
  return 'domain';
}

async function handleIocContext(args) {
  const value = args?.value?.trim();
  if (!value) {
    throw new Error('value is required.');
  }

  const { supUrl, supKey } = getSupabaseCreds();

  const res = await fetch(
    `${supUrl}/rest/v1/threat_ioc_telemetry?value=eq.${encodeURIComponent(value)}&select=*&order=last_seen.desc`,
    { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } }
  );
  const rows = res.ok ? await res.json() : [];

  if (!rows.length) {
    const err = new Error(`Indicator '${value}' has no recorded observations.`);
    err.notFound = true;
    throw err;
  }

  const sources = rows.map((r) => ({
    source: r.verification_source || 'unknown',
    confidence: parseInt(r.confidence_score, 10) || 0,
    first_seen: r.ingested_at || null,
    last_seen: r.last_seen || null,
    malware_family: r.malware_family || null,
    tags: r.tags || []
  }));

  const confidences = sources.map((s) => s.confidence).filter((c) => c > 0);
  const avgConfidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  const agreementBoost = Math.min(20, Math.max(0, sources.length - 1) * 7);
  const aggregateConfidence = Math.round(Math.min(100, avgConfidence + agreementBoost));

  const malwareFamilies = [...new Set(sources.map((s) => s.malware_family).filter(Boolean))];
  const tags = [...new Set(sources.flatMap((s) => s.tags || []))];

  const firstSeenTimes = sources.map((s) => s.first_seen).filter(Boolean).map((t) => new Date(t).getTime()).filter((t) => !isNaN(t));
  const lastSeenTimes = sources.map((s) => s.last_seen).filter(Boolean).map((t) => new Date(t).getTime()).filter((t) => !isNaN(t));

  return {
    indicator: value,
    indicator_type: rows[0].indicator_type || detectIndicatorType(value),
    provenance: {
      sources: [...new Set(sources.map((s) => s.source))],
      observation_count: rows.length,
      confidence_score: aggregateConfidence,
      malware_families: malwareFamilies,
      tags,
      first_seen: firstSeenTimes.length ? new Date(Math.min(...firstSeenTimes)).toISOString() : null,
      last_seen: lastSeenTimes.length ? new Date(Math.max(...lastSeenTimes)).toISOString() : null
    }
  };
}

// ---------------------------------------------------------------------
// REAL AUTHORIZATION (was: apiKey.length >= 8, xPayment.length > 10)
// ---------------------------------------------------------------------

async function verifyGumroadLicense(licenseKey) {
  if (!licenseKey) return { valid: false, error: 'No license key provided.' };
  try {
    const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ product_id: process.env.GUMROAD_PRODUCT_ID, license_key: licenseKey })
    });
    const data = await res.json();
    if (!data.success || (data.purchase && (data.purchase.refunded || data.purchase.chargebacked))) {
      return { valid: false, error: 'Invalid, expired, or refunded license key.' };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, error: 'License verification failed: ' + e.message };
  }
}

// x402 — real facilitator-backed verification. If X402_PAY_TO_ADDRESS
// isn't set on this deployment, the x402 path is disabled rather than
// silently accepting anything (unlike the stub's `length > 10` check).
const X402_PAY_TO = (process.env.X402_PAY_TO_ADDRESS || '').trim();
let x402Middleware = null;
let x402Server = null;
if (X402_PAY_TO) {
  try {
    const facilitatorClient = createCdpFacilitatorClient();
    x402Server = new x402ResourceServer(facilitatorClient).register('eip155:8453', new ExactEvmScheme());
    x402Middleware = paymentMiddleware(
      {
        'POST /api/mcp': {
          accepts: [{ scheme: 'exact', price: '$0.01', network: 'eip155:8453', payTo: X402_PAY_TO }],
          description: 'PG1 Sovereign Threat Intelligence MCP tools.',
          mimeType: 'application/json'
        }
      },
      x402Server,
      undefined,
      undefined,
      false
    );
  } catch (e) {
    console.error('[X402] Setup failed, payment path disabled:', e.message);
    x402Middleware = null;
  }
} else {
  console.warn('[X402] X402_PAY_TO_ADDRESS not set — x402 payment path disabled on this deployment.');
}

let x402InitPromise = null;
let x402Initialized = false;

function ensureX402Initialized() {
  if (x402Initialized) return Promise.resolve(true);
  if (!x402Server) return Promise.resolve(false);
  if (!x402InitPromise) {
    x402InitPromise = Promise.race([
      x402Server.initialize(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('facilitator init timeout')), 8000))
    ]).then(() => { x402Initialized = true; return true; })
      .catch((err) => { console.error('[X402] init failed:', err.message); x402InitPromise = null; return false; });
  }
  return x402InitPromise;
}

function ensureExpressCompat(req) {
  if (typeof req.header !== 'function') {
    req.header = req.get = (name) => {
      const v = req.headers[String(name).toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
  }
  if (req.path === undefined) req.path = (req.url || '/').split('?')[0];
  if (req.originalUrl === undefined) req.originalUrl = req.url;
  if (req.protocol === undefined) {
    const fp = req.headers['x-forwarded-proto'];
    req.protocol = (Array.isArray(fp) ? fp[0] : fp) || 'https';
  }
}

const TOOL_HANDLERS = {
  get_threat_indicators: handleThreatIndicators,
  get_cve_details: handleCveDetails,
  get_ioc_context: handleIocContext
};

// ---------------------------------------------------------------------
// HTTP HANDLER
// ---------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Payment, X-API-KEY');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      name: 'pg1-threat-intel',
      version: '1.4.0',
      status: 'healthy',
      protocol: 'Model Context Protocol over Streamable HTTP',
      endpoint: 'https://pg1-ai-agent.vercel.app/api/mcp'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST for MCP JSON-RPC requests.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: '1' });
  }

  const { id, method, params } = body;
  const requestId = (id !== undefined && id !== null) ? id : '1';

  try {
    if (method === 'initialize') {
      return res.status(200).json({
        jsonrpc: '2.0',
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'pg1-threat-intel', version: '1.4.0' } },
        id: requestId
      });
    }

    if (method === 'notifications/initialized') {
      return res.status(204).end();
    }

    if (method === 'tools/list') {
      return res.status(200).json({ jsonrpc: '2.0', result: { tools: TOOLS }, id: requestId });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const toolHandler = TOOL_HANDLERS[toolName];

      if (!toolHandler) {
        return res.status(200).json({ jsonrpc: '2.0', error: { code: -32602, message: `Unknown tool: ${toolName}` }, id: requestId });
      }

      const licenseKey = req.headers['x-api-key'];
      const rawPayment = req.headers['x-payment'];

      let authorized = false;

      // 1. Gumroad license — real verification, not a length check.
      if (licenseKey) {
        const check = await verifyGumroadLicense(licenseKey);
        if (check.valid) authorized = true;
        else {
          return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Payment Required: ' + check.error }, id: requestId });
        }
      }

      // 2. x402 — real facilitator verification, only if configured.
      if (!authorized && rawPayment && x402Middleware) {
        const ready = await ensureX402Initialized();
        if (!ready) {
          return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'x402 payment path temporarily unavailable. Retry, or use a Gumroad license key.' }, id: requestId });
        }
        ensureExpressCompat(req);
        try {
          await new Promise((resolve, reject) => {
            x402Middleware(req, res, (err) => (err ? reject(err) : (authorized = true, resolve())));
          });
        } catch (x402Err) {
          if (!res.headersSent) {
            return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Payment verification failed: ' + x402Err.message }, id: requestId });
          }
          return;
        }
        if (!authorized) return; // middleware already wrote the response
      }

      if (!authorized) {
        return res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Payment Required: Send a valid Gumroad key in X-API-KEY or pay $0.01 via x402 in X-PAYMENT.' },
          id: requestId
        });
      }

      let toolResult;
      try {
        toolResult = await toolHandler(toolArgs);
      } catch (toolErr) {
        const code = toolErr.notFound ? 404 : 400;
        return res.status(code).json({ jsonrpc: '2.0', error: { code: toolErr.notFound ? -32004 : -32602, message: toolErr.message }, id: requestId });
      }

      return res.status(200).json({
        jsonrpc: '2.0',
        result: { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] },
        id: requestId
      });
    }

    return res.status(200).json({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${method || 'unknown'}` }, id: requestId });
  } catch (err) {
    return res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error', data: err.message }, id: requestId });
  }
}