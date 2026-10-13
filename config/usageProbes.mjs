// Probe vs real traffic for /usage (lib/usageStats.mjs). Edit this file to
// extend the lists; nothing else needs to change.
//
// A caller (one salted IP hash) is a probe when, in the report's period:
//   - an MCP initialize from it reported a clientInfo name in CLIENT_NAMES
//     (matched case-insensitively as whole words, punctuation ignored, so
//     "Glama/1.2" and "glama mcp client" both match "glama"), or
//   - everything it sent was PROBE_ONLY_METHODS requests and
//     PROBE_ONLY_TOOLS calls (a registry or health check that lists the
//     tools and maybe asks for its own quota, but never uses a tool).
// Every other caller is real.

export const PROBE_CLIENT_NAMES = Object.freeze([
  // Registry, ranking and health-check crawlers seen in the MCP initialize logs.
  'glimind-probe',
  'mcpbeat',
  'glama',
  'rokmcp-probe',
  'agentrank-probe',
  'mcp-server.io-healthcheck',
  'aisec-registry-probe',
  'ps-mcp-tools-probe',
  'AgentsJunction health checker',
  'posthog-mcp-registry-probe'
]);

// MCP JSON-RPC methods that on their own never make a caller real.
export const PROBE_ONLY_METHODS = Object.freeze(['initialize', 'tools/list', 'notifications/initialized', 'ping', 'resources/list', 'prompts/list', 'invalid_json', 'other']);

// Tools that on their own never make a caller real.
export const PROBE_ONLY_TOOLS = Object.freeze(['get_usage_status']);
