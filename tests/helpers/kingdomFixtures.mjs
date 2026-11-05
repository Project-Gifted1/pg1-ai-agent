// TEST FIXTURES ONLY for PG1 Kingdom Defence (tests/browser/kingdom*.mjs).
// Never imported by the app: tests/kingdom-view.test.mjs fails if anything
// under public/, api/ or lib/ imports this file or carries its values.
//
// Rows shaped like the real tables, built the way production builds them:
// each caller's hash is the real salted callerHash (lib/telemetry.mjs) of a
// documentation-range address (RFC 5737), so every caller has its own
// short hash; times spread over the day; only paid skills ever get a 402
// (check_package and the other free tools never do).

import { callerHash } from '../../lib/telemetry.mjs';
import { buildDefenseFeed } from '../../lib/defenseFeed.mjs';
import { buildDefenseState } from '../../lib/defenseState.mjs';

// PG1's state for the tower: production Ready, two approvals waiting, a passkey; the real MCP tool count.
export const FIXTURE_APPROVALS = 2;

export const FIXTURE_SALT = 'kingdom-browser-test-salt';
const CALLERS = { a: '192.0.2.11', b: '192.0.2.37', c: '198.51.100.4', d: '198.51.100.90', e: '203.0.113.15', f: '203.0.113.200' };

export function fixtureCallerHashes() {
  const saved = process.env.TELEMETRY_IP_SALT;
  process.env.TELEMETRY_IP_SALT = FIXTURE_SALT;
  try { return Object.fromEntries(Object.entries(CALLERS).map(([k, ip]) => [k, callerHash(ip)])); } finally { if (saved === undefined) delete process.env.TELEMETRY_IP_SALT; else process.env.TELEMETRY_IP_SALT = saved; }
}

export function fixtureTables(now = Date.now()) {
  const h = fixtureCallerHashes();
  const iso = (ms) => new Date(now - ms).toISOString();
  const M = 60000; const H = 3600000;
  return {
    agent_telemetry: [
      ...Array.from({ length: 18 }, (_, i) => ({ created_at: iso(40000 + i * 1500), event_type: 'tool_call', endpoint: '/api/mcp', status: 'unknown_tool', caller_hash: h.a, country_code: 'SG' })),
      { created_at: iso(75000), event_type: 'tool_call', endpoint: '/api/a2a', status: 'payment_required', tool_name: 'preflight_check', caller_hash: h.b, country_code: 'US' },
      { created_at: iso(95000), event_type: 'settlement', endpoint: '/api/mcp', status: 'settled', tool_name: 'get_cve_details', caller_hash: h.c, country_code: 'DE' },
      ...Array.from({ length: 9 }, (_, i) => ({ created_at: iso(50000 + i * 900), event_type: 'tool_call', endpoint: '/api/a2a', status: 'rate_limited', tool_name: 'get_cve_batch', caller_hash: h.d, country_code: null })),
      { created_at: iso(3 * H + 12 * M), event_type: 'tool_call', endpoint: '/api/mcp', status: 'server_error', tool_name: 'check_domain_age', caller_hash: h.e, country_code: 'IE' },
      { created_at: iso(7 * H + 41 * M), event_type: 'mcp_request', endpoint: '/api/mcp', status: 'method_not_found', mcp_method: 'admin/exec', caller_hash: h.f, country_code: 'BR' },
      // A 402-shaped row on a free tool: impossible in production, and never a Toll Gantry event.
      { created_at: iso(5 * M), event_type: 'tool_call', endpoint: '/api/mcp', status: 'payment_required', tool_name: 'check_package', caller_hash: h.f, country_code: 'BR' }
    ],
    pg1_defense_events: [
      { created_at: iso(25000), check_name: 'check_hostname_reputation', endpoint: '/api/mcp', verdict_code: 'flagged', reason_codes: ['HOSTNAME_LOOKALIKE'], severity: 'medium', subject_kind: null, country_code: 'FR', caller_hash: h.e },
      { created_at: iso(11 * H + 3 * M), check_name: 'check_agent_message', endpoint: '/api/a2a', verdict_code: 'suspicious', reason_codes: ['AGENT_MESSAGE_ENCODED_BLOB'], severity: 'medium', subject_kind: 'message', country_code: 'PL', caller_hash: h.b }
    ],
    pg1_operator_reports: [{ created_at: iso(6 * H + 30 * M), kind: 'daily' }]
  };
}

// A feed handler for the Command Centre stub server, through the real lib/defenseFeed.mjs.
export function fixtureFeed() {
  // The rows are fixed when the feed is made (like rows in a database);
  // each poll reads them at its own "now".
  const tables = fixtureTables(Date.now());
  return async (url) => {
    const now = Date.now();
    const fetchImpl = async (u) => new Response(JSON.stringify(tables[new URL(String(u)).pathname.split('/').pop()] || []), { status: 200 });
    const since = Number(url.searchParams.get('since')) || null;
    const feed = await buildDefenseFeed({ supUrl: 'https://db.test', supKey: 'k', fetchImpl, now, since, env: {} });
    if (!since) feed.state = await buildDefenseState({ env: {}, deps: { home: async () => ({ deploy: { state: 'READY', failed: false }, approvals: { total: FIXTURE_APPROVALS } }), passkeys: async () => true } });
    return feed;
  };
}
