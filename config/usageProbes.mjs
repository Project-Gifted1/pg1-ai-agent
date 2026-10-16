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
  'posthog-mcp-registry-probe',
  // MCP checkers that also call tools with their own probe names (below).
  'verifymcp',
  'mcpcheckup'
]);

// Tool names that only checkers send (an auth or reachability probe of a
// tool that does not exist). A caller that sent one is a probe, whatever
// else it called: these checkers also call a real tool to test the server.
// Matched against the requested name as stored (lib/telemetry.mjs reduces
// it, so a long random suffix may already be cut off).
export const PROBE_TOOL_NAME_PATTERNS = Object.freeze([
  /^_*verifymcp/i,
  /^_*mcpcheckup/i,
  /^__\w*probe/i
]);

// User-Agent words of our own checkers and of partner integrations we run
// with (matched case-insensitively as whole words): their traffic is ours
// (lib/ownTraffic.mjs), never real and never probe.
//   x402-endpoint-validator   .github/workflows/x402-validate.yml
//   pg1-payment-config-check  scripts/verify-payment-config.mjs
//   pg1-self-test             our own smoke tests against a deployment
//   x402-doctor               Frits's x402 Doctor integration
export const OWN_USER_AGENTS = Object.freeze([
  'x402-endpoint-validator',
  'pg1-payment-config-check',
  'pg1-self-test',
  'x402-doctor',
  'x402doctor'
]);

// MCP JSON-RPC methods that on their own never make a caller real.
// Any method that is not one of these and not tools/call is probe activity
// too (lib/usageStats.mjs): an unknown or unsupported method never makes a
// caller real.
export const PROBE_ONLY_METHODS = Object.freeze(['initialize', 'tools/list', 'notifications/initialized', 'ping', 'resources/list', 'resources/templates/list', 'prompts/list', 'invalid_json', 'batch', 'invalid_request', 'other']);

// User-Agent words of x402 discovery scanners, crawlers and health checks
// (matched case-insensitively as whole words, punctuation ignored). A
// request from one skips the automatic free tier (lib/freeTier.mjs) and
// gets the 402 payment challenge at once, which is what a scanner checks
// for when it lists a paid x402 resource. "X-Free-Tier: 0" does the same
// for any client.
export const FREE_TIER_SKIP_USER_AGENTS = Object.freeze([
  'x402scan', 'x402-scan', 'bazaar', 'x402-bazaar', 'x402-crawler',
  'bot', 'crawler', 'spider', 'probe', 'healthcheck', 'uptime', 'scanner'
]);

// Tools that on their own never make a caller real.
export const PROBE_ONLY_TOOLS = Object.freeze(['get_usage_status']);
