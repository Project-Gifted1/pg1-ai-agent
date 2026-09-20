// MCP (Model Context Protocol) server exposing PG1's STIX threat-intel feed
// as a callable tool for AI agents/clients. Implements the minimal JSON-RPC
// 2.0 surface MCP clients expect: initialize, tools/list, tools/call.
//
// Deliberately self-contained (no import from chat.mjs) so this endpoint
// stays independent of that file's current syntax issue.

export const config = {
  maxDuration: 30
};

function escapeStixValue(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id: id, result: result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id, error: { code: code, message: message } };
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
    description: 'PG1 Sovereign Threat Intelligence: returns a STIX 2.1 bundle of verified threat indicators (IPs, domains, URLs, file hashes) sourced from ThreatFox, URLhaus, AbuseIPDB, OTX and NVD.',
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json(jsonRpcError(null, -32600, 'Method Not Allowed'));
  }

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
        serverInfo: { name: 'pg1-threat-intel', version: '1.0.0' },
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

      var bundle = await fetchStixBundle(toolArgs);
      return res.status(200).json(jsonRpcResult(id, {
        content: [
          { type: 'text', text: JSON.stringify(bundle, null, 2) }
        ]
      }));
    }

    return res.status(200).json(jsonRpcError(id, -32601, `Unknown method: ${method}`));
  } catch (err) {
    return res.status(200).json(jsonRpcError(id, -32000, err.message));
  }
}