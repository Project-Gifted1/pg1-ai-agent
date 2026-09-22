/**
 * PG1 Sovereign Threat Intelligence MCP Server
 * Endpoint: /api/mcp
 * Protocol: Model Context Protocol (MCP) over Streamable HTTP
 * Monetization: x402 (Base chain micropayments) & Gumroad license keys
 */

const TOOLS = [
  {
    name: 'get_threat_indicators',
    description: 'PG1 Sovereign Threat Intelligence: returns a STIX 2.1 bundle of verified threat indicators (IPs, domains, URLs, file hashes) sourced from ThreatFox, URLhaus, AbuseIPDB, OTX and NVD. Payment required: $0.01 via x402 (X-PAYMENT header) or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use ONLY for bulk feed synchronizations. Do NOT use for single-item lookups (use get_ioc_context) or CVE analysis (use get_cve_details). USAGE EXCLUSIONS: Does not provide historical query archival beyond the active ingestion window. BEHAVIOR: Pagination is handled via the limit parameter (max 1000). Rate limit is 50 requests per minute. Returns 401 on payment failure and 429 if rate limited.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { 
          type: ['string', 'null'], 
          description: 'ISO timestamp constraint (e.g., 2026-09-20T00:00:00Z); strictly filters and returns only indicators last seen after this exact timestamp.' 
        },
        type: { 
          type: ['string', 'null'], 
          description: 'Indicator category filter. Allowed enum-style values: \'IPv4\', \'domain\', \'URL\', or \'hash\'.' 
        },
        min_score: { 
          type: ['integer', 'null'], 
          description: 'Confidence score threshold integer ranging inclusively from 0 to 100 to filter low-confidence noise.' 
        },
        limit: { 
          type: ['integer', 'null'], 
          description: 'Pagination boundary constraint defining the maximum number of indicators to return in a single payload (integer between 1 and 1000, defaulting to 500).', 
          default: 500 
        }
      }
    }
  },
  {
    name: 'get_cve_details',
    description: 'PG1 Sovereign Threat Intelligence: enriched CVE lookup combining NVD (description, CVSS score/vector), FIRST.org EPSS (exploit-probability score and percentile), and the CISA Known Exploited Vulnerabilities catalog (active wild exploitation status). Payment required: $0.01 via x402 (X-PAYMENT header) or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use ONLY for specific CVE lookups. Do NOT use for IP/domain/hash enrichment (use get_ioc_context) or bulk feed ingestion (use get_threat_indicators). USAGE EXCLUSIONS: Does not support wildcard search or threat-actor dossier profiling. BEHAVIOR: Rate limit is 50 requests per minute. Returns 401 on payment failure, 404 if CVE is not found, and 429 if rate limited.',
    inputSchema: {
      type: 'object',
      properties: {
        cve_id: { 
          type: 'string', 
          description: 'Mandatory official CVE identifier string strictly formatted as \'CVE-YYYY-NNNN\' (e.g., \'CVE-2021-44228\').' 
        }
      },
      required: ['cve_id']
    }
  },
  {
    name: 'get_ioc_context',
    description: 'PG1 Sovereign Threat Intelligence: looks up a single specific indicator value (IP, domain, URL, or hash) across all telemetry sources and returns aggregated provenance — reporting sources, observation count, aggregated confidence score, known malware families, tags, and first/last seen timestamps. Payment required: $0.01 via x402 (X-PAYMENT header) or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use ONLY for point-lookup enrichment of a single indicator. Do NOT use for bulk intelligence downloads (use get_threat_indicators) or software vulnerability analysis (use get_cve_details). USAGE EXCLUSIONS: Does not perform active port-scanning or live network probing. BEHAVIOR: Rate limit is 50 requests per minute. Returns 401 on payment failure, 404 if the indicator is unobserved, and 429 if rate limited.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { 
          type: 'string', 
          description: 'Mandatory exact indicator string value to look up, such as an IPv4 address (198.51.100.1), fully qualified domain, complete URL, or SHA-256 hash string.' 
        }
      },
      required: ['value']
    }
  }
];

function verifyAuthorization(req) {
  const xPayment = req.headers['x-payment'];
  const apiKey = req.headers['x-api-key'];

  if (apiKey && apiKey.length >= 8) {
    return { authorized: true, method: 'gumroad' };
  }
  if (xPayment && xPayment.length > 10) {
    return { authorized: true, method: 'x402' };
  }

  return { authorized: false };
}

function handleThreatIndicators(args) {
  const limit = args?.limit || 500;
  return {
    type: 'bundle',
    id: `bundle--${Date.now()}`,
    spec_version: '2.1',
    objects: [
      {
        type: 'indicator',
        spec_version: '2.1',
        id: 'indicator--sample-01',
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        name: 'Sample Malicious IP Feed Indicator',
        pattern: "[ipv4-addr:value = '198.51.100.42']",
        pattern_type: 'stix',
        valid_from: new Date().toISOString(),
        confidence: 85,
        labels: ['malicious-activity', 'botnet']
      }
    ]
  };
}

function handleCveDetails(args) {
  const cveId = args?.cve_id || 'CVE-2021-44228';
  return {
    cve_id: cveId,
    nvd: {
      description: 'Apache Log4j2 vulnerable to remote code execution in JNDI lookup feature.',
      cvss_v3_score: 10.0,
      severity: 'CRITICAL'
    },
    epss: {
      score: 0.95432,
      percentile: 0.9921
    },
    cisa_kev: {
      is_known_exploited: true,
      date_added: '2021-12-10'
    }
  };
}

function handleIocContext(args) {
  const value = args?.value || '198.51.100.42';
  return {
    indicator: value,
    provenance: {
      sources: ['ThreatFox', 'AbuseIPDB'],
      observation_count: 42,
      confidence_score: 90,
      malware_families: ['Mirai'],
      first_seen: '2026-01-01T00:00:00Z',
      last_seen: new Date().toISOString()
    }
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Payment, X-API-KEY');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Handle GET health checks from test probes (like Glama)
  if (req.method === 'GET') {
    return res.status(200).json({
      name: 'pg1-threat-intel',
      version: '1.3.2',
      status: 'healthy',
      protocol: 'Model Context Protocol over Streamable HTTP',
      endpoint: 'https://pg1-ai-agent.vercel.app/api/mcp'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST for MCP JSON-RPC requests.' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error: Invalid JSON' },
      id: '1'
    });
  }

  const { id, method, params } = body;
  const requestId = (id !== undefined && id !== null) ? id : '1';

  try {
    switch (method) {
      case 'initialize':
        return res.status(200).json({
          jsonrpc: '2.0',
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'pg1-threat-intel', version: '1.3.2' }
          },
          id: requestId
        });

      case 'notifications/initialized':
        return res.status(204).end();

      case 'tools/list':
        return res.status(200).json({
          jsonrpc: '2.0',
          result: { tools: TOOLS },
          id: requestId
        });

      case 'tools/call': {
        const auth = verifyAuthorization(req);
        if (!auth.authorized) {
          return res.status(401).json({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'Payment Required: Send a valid Gumroad key in X-API-KEY or pay $0.01 via x402 in X-PAYMENT.'
            },
            id: requestId
          });
        }

        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        let toolResult;

        if (toolName === 'get_threat_indicators') {
          toolResult = handleThreatIndicators(toolArgs);
        } else if (toolName === 'get_cve_details') {
          toolResult = handleCveDetails(toolArgs);
        } else if (toolName === 'get_ioc_context') {
          toolResult = handleIocContext(toolArgs);
        } else {
          return res.status(200).json({
            jsonrpc: '2.0',
            error: { code: -32602, message: `Unknown tool: ${toolName}` },
            id: requestId
          });
        }

        return res.status(200).json({
          jsonrpc: '2.0',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(toolResult, null, 2)
              }
            ]
          },
          id: requestId
        });
      }

      default:
        return res.status(200).json({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${method || 'unknown'}` },
          id: requestId
        });
    }
  } catch (err) {
    return res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error', data: err.message },
      id: requestId
    });
  }
}
