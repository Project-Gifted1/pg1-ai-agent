/**
 * Tests for operator usage stats: what lib/telemetry.mjs records on /api/mcp
 * (initialize + tools/call), /api/a2a, /api/playground and /api/ioc, how
 * lib/usageStats.mjs aggregates it, the operator-only get_usage_stats chat
 * tool (lib/chatTools.mjs), the /usage command (api/chat.mjs), and the
 * 90-day retention delete (api/errors/cleanup.mjs).
 *
 * Covered: aggregates on seeded data; fixtures excluded; no raw IP or
 * queried value is stored or returned; guests, the playground, MCP/A2A
 * callers and unauthenticated chat requests cannot reach get_usage_stats or
 * /usage; a failed read gives a neutral error with a request_id and no
 * numbers; retention deletion.
 *
 * Run with: node --test tests/usage-stats.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEMETRY_IP_SALT = 'test-salt-for-usage-stats';
delete process.env.X402_PAY_TO_ADDRESS;

const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
const { default: mcpHandler } = await import('../api/mcp.mjs');
const { default: a2aHandler } = await import('../api/a2a.mjs');
const { createPlaygroundHandler } = await import('../api/playground.mjs');
const { default: cleanupHandler } = await import('../api/errors/cleanup.mjs');
const { buildTelemetryRow, callerHash, sanitizeClientName, sanitizeClientVersion, purgeExpiredTelemetry, TELEMETRY_RETENTION_DAYS } = await import('../lib/telemetry.mjs');
const { aggregateUsage, getUsageStats, usagePeriodRange, distinctCallersText, UsageStatsUnavailableError } = await import('../lib/usageStats.mjs');
const {
  chatToolsForRole, createToolExecutor, toolDirective, summarizeOutcome, spokenSummary, unverifiedNote, usageReport,
  USAGE_STATS_TOOL, OPERATOR_ONLY_CHAT_TOOLS, CHAT_TOOL_ROLES
} = await import('../lib/chatTools.mjs');
const { chooseChatRoute } = await import('../lib/chatRoute.mjs');
const { createSseParser } = await import('../lib/chatStream.mjs');
const { TOOLS } = await import('../api/mcp.mjs');
const { FIXTURE_VALUES } = await import('../lib/fixtures.mjs');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase.test';

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.SUPABASE_URL = SUP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  process.env.TELEMETRY_IP_SALT = 'test-salt-for-usage-stats';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'CRON_SECRET', 'GITHUB_TOKEN', 'CARTESIA_API_KEY']) delete process.env[k];
}

// Between tests fetch refuses rather than going live: a fire-and-forget
// write started by one test (logApiError on a 401) can still be running
// after the next test's beforeEach, and must not reach the network.
const offlineFetch = async (url) => { throw new Error('Unexpected network call in test: ' + url); };

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
  globalThis.fetch = offlineFetch;
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

// Records every fetch; agent_telemetry POSTs go to `rows`. `routes` answers
// the rest by URL substring; anything unmatched is an empty PostgREST list.
function installFetch(routes = []) {
  const calls = [];
  const rows = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', headers: options.headers || {} });
    if (u.endsWith('/rest/v1/agent_telemetry') && options.method === 'POST') {
      rows.push(JSON.parse(options.body));
      return new Response(null, { status: 201 });
    }
    for (const [needle, handler] of routes) {
      if (u.includes(needle)) return handler(u, options);
    }
    if (u.includes('/rest/v1/')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error('Unexpected network call in test: ' + u);
  };
  return { calls, rows };
}

const settle = () => new Promise((r) => setImmediate(r));

function makeRes() {
  return {
    statusCode: null, headers: {}, body: null, jsonBody: null, chunks: [],
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; },
    end(payload) { if (typeof payload === 'string') { try { this.body = JSON.parse(payload); } catch { /* not JSON */ } } return this; },
    on() {}
  };
}

const CALLER_IP = '203.0.113.77';
const WALLET = '0x' + 'ab'.repeat(20);

// --- seeded aggregates -------------------------------------------------------

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const D0 = '2026-10-05T10:00:00Z';
const D1 = '2026-10-04T10:00:00Z';
const D6 = '2026-09-29T10:00:00Z';
const D7 = '2026-09-28T10:00:00Z';
const H = (c) => c.repeat(32);

const tc = (created_at, endpoint, tool_name, status, caller, extra = {}) => ({ created_at, event_type: 'tool_call', endpoint, tool_name, status, caller_hash: H(caller), client_name: null, is_fixture: false, ...extra });
const SEED = [
  tc(D0, '/api/mcp', 'check_wallet_sanctions', 'ok', 'a'),
  tc(D0, '/api/mcp', 'check_wallet_sanctions', 'rate_limited', 'a'),
  tc(D1, '/api/mcp', 'get_cve_details', 'ok', 'b'),
  tc(D1, '/api/a2a', 'check_domain_age', 'tool_error', 'c'),
  tc(D6, '/api/playground', 'check_wallet_age', 'ok', 'b'),
  tc(D6, '/api/ioc', 'ioc_feed', 'payment_required', 'd'),
  tc(D0, '/api/ioc', 'ioc_feed', 'server_error', 'd'),
  tc(D0, '/api/mcp', 'check_wallet_sanctions', 'ok', 'e', { is_fixture: true }),
  tc(D7, '/api/mcp', 'check_domain_age', 'ok', 'f'),
  { created_at: D1, event_type: 'settlement', endpoint: '/api/mcp', tool_name: 'get_cve_details', status: 'settled', caller_hash: H('b'), is_fixture: false },
  { created_at: D1, event_type: 'settlement', endpoint: '/api/mcp', tool_name: 'get_cve_details', status: 'failed', caller_hash: H('b'), is_fixture: false },
  { created_at: D0, event_type: 'settlement', endpoint: '/api/mcp', tool_name: 'get_cve_details', status: 'settled', caller_hash: H('e'), is_fixture: true },
  { created_at: D0, event_type: 'initialize', endpoint: '/api/mcp', status: 'ok', client_name: 'Claude Desktop', caller_hash: H('a'), is_fixture: false },
  { created_at: D1, event_type: 'initialize', endpoint: '/api/mcp', status: 'ok', client_name: 'Claude Desktop', caller_hash: H('b'), is_fixture: false },
  { created_at: D1, event_type: 'initialize', endpoint: '/api/mcp', status: 'ok', client_name: 'cursor', caller_hash: H('c'), is_fixture: false },
  { created_at: D0, event_type: 'initialize', endpoint: '/api/mcp', status: 'ok', client_name: null, caller_hash: H('9'), is_fixture: false },
  { created_at: D0, event_type: 'initialize', endpoint: '/api/mcp', status: 'ok', client_name: 'fixture-client', caller_hash: H('e'), is_fixture: true }
];

test('aggregateUsage: 7d counts per tool, route and day, distinct callers, clients, errors, rate limits, settlements', () => {
  const s = aggregateUsage(SEED, { period: '7d', now: NOW });
  assert.equal(s.period, '7d');
  assert.equal(s.from, '2026-09-29T00:00:00.000Z');
  assert.equal(s.total_calls, 7);
  assert.deepEqual(s.calls_per_tool, [
    { tool: 'check_wallet_sanctions', calls: 2 }, { tool: 'ioc_feed', calls: 2 },
    { tool: 'check_domain_age', calls: 1 }, { tool: 'check_wallet_age', calls: 1 }, { tool: 'get_cve_details', calls: 1 }
  ]);
  assert.deepEqual(s.calls_per_route, [
    { route: '/api/mcp', calls: 3 }, { route: '/api/ioc', calls: 2 }, { route: '/api/a2a', calls: 1 }, { route: '/api/playground', calls: 1 }
  ]);
  assert.deepEqual(s.calls_per_day, [
    { day: '2026-09-29', calls: 2 }, { day: '2026-09-30', calls: 0 }, { day: '2026-10-01', calls: 0 }, { day: '2026-10-02', calls: 0 },
    { day: '2026-10-03', calls: 0 }, { day: '2026-10-04', calls: 2 }, { day: '2026-10-05', calls: 3 }
  ]);
  assert.equal(s.distinct_callers_estimate, 4);
  assert.match(s.distinct_callers_note, /estimate/);
  assert.match(s.distinct_callers_note, /not an exact count of agents/);
  assert.deepEqual(s.top_clients, [{ name: 'Claude Desktop', count: 2 }, { name: '(not given)', count: 1 }, { name: 'cursor', count: 1 }]);
  assert.equal(s.mcp_initializations, 4);
  assert.equal(s.errors, 2, 'tool_error + server_error; payment_required is not an error');
  assert.equal(s.rate_limited, 1);
  assert.equal(s.paid_settlements, 1);
  assert.equal(s.fixtures_excluded, true);
});

test('aggregateUsage: today and 30d windows', () => {
  const today = aggregateUsage(SEED, { period: 'today', now: NOW });
  assert.equal(today.total_calls, 3);
  assert.equal(today.distinct_callers_estimate, 2);
  assert.equal(today.paid_settlements, 0);
  assert.equal(today.mcp_initializations, 2);
  assert.deepEqual(today.calls_per_day, [{ day: '2026-10-05', calls: 3 }]);

  const month = aggregateUsage(SEED, { period: '30d', now: NOW });
  assert.equal(month.total_calls, 8);
  assert.equal(month.distinct_callers_estimate, 5);
  assert.equal(month.calls_per_day.length, 30);
  assert.equal(month.calls_per_day.reduce((n, d) => n + d.calls, 0), 8);

  assert.equal(aggregateUsage(SEED, { period: 'nonsense', now: NOW }).period, '7d', 'unknown period falls back to 7d');
});

test('fixtures are excluded: by the query filter and again in the aggregation', async () => {
  const fixturesOnly = SEED.filter((r) => r.is_fixture);
  const s = aggregateUsage(fixturesOnly, { period: '7d', now: NOW });
  assert.equal(s.total_calls, 0);
  assert.equal(s.distinct_callers_estimate, 0);
  assert.equal(s.paid_settlements, 0);
  assert.deepEqual(s.top_clients, []);

  const { calls } = installFetch([['/rest/v1/agent_telemetry', () => Response.json(SEED)]]);
  const stats = await getUsageStats({ period: '7d', now: NOW });
  const read = calls.find((c) => c.url.includes('/rest/v1/agent_telemetry'));
  assert.equal(read.method, 'GET');
  assert.match(read.url, /[?&]is_fixture=eq\.false(&|$)/);
  assert.ok(read.url.includes(`created_at=gte.${encodeURIComponent(usagePeriodRange('7d', NOW).from)}`));
  assert.equal(stats.total_calls, 7, 'a fixture row that slipped through is still skipped');
  assert.equal(stats.paid_settlements, 1);
});

test('getUsageStats pages through PostgREST with Range headers and flags nothing truncated under the cap', async () => {
  const page0 = Array.from({ length: 1000 }, () => tc(D0, '/api/mcp', 'check_domain_age', 'ok', '1'));
  const page1 = [tc(D0, '/api/a2a', 'check_domain_age', 'ok', '2')];
  const { calls } = installFetch([['/rest/v1/agent_telemetry', (u, o) => Response.json(o.headers.Range === '0-999' ? page0 : page1)]]);
  const stats = await getUsageStats({ period: 'today', now: NOW });
  const reads = calls.filter((c) => c.url.includes('/rest/v1/agent_telemetry'));
  assert.deepEqual(reads.map((c) => c.headers.Range), ['0-999', '1000-1999']);
  assert.equal(stats.total_calls, 1001);
  assert.equal(stats.distinct_callers_estimate, 2);
  assert.equal(stats.truncated, false);
});

test('getUsageStats throws UsageStatsUnavailableError (no numbers) when unconfigured, failing, or malformed', async () => {
  delete process.env.SUPABASE_URL;
  await assert.rejects(getUsageStats({ period: '7d' }), (e) => e instanceof UsageStatsUnavailableError && e.usageStatsUnavailable === true);
  resetEnv();
  for (const handler of [
    () => new Response('boom', { status: 500 }),
    () => Response.json({ not: 'a list' }),
    () => { throw new Error('ECONNRESET supabase.internal:5432'); }
  ]) {
    installFetch([['/rest/v1/agent_telemetry', handler]]);
    await assert.rejects(getUsageStats({ period: '7d' }), (e) => e instanceof UsageStatsUnavailableError && !/ECONNRESET|5432|boom/.test(e.message));
  }
});

// --- what is stored: no raw IPs, no queried values ----------------------------

test('callerHash is a salted 32-hex HMAC, never the IP; no salt and no Supabase key means no hash', () => {
  const h = callerHash(CALLER_IP);
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.equal(callerHash(CALLER_IP), h, 'stable for one salt');
  assert.ok(!h.includes('203'));
  assert.equal(callerHash('unknown'), null);
  assert.equal(callerHash(''), null);
  process.env.TELEMETRY_IP_SALT = 'another-salt';
  assert.notEqual(callerHash(CALLER_IP), h, 'the salt changes the hash');
  delete process.env.TELEMETRY_IP_SALT;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.equal(callerHash(CALLER_IP), null, 'never an unsalted hash');
});

test('client name and version are sanitised and truncated; only initialize rows carry them; callerIp is never a column', () => {
  assert.equal(sanitizeClientName('Claude Desktop'), 'Claude Desktop');
  assert.equal(sanitizeClientName('evil <script>alert(1)</script>'), 'evil script alert(1) /script');
  assert.equal(sanitizeClientName(`agent ${WALLET} bot`), 'agent bot', 'no wallet address survives');
  assert.equal(sanitizeClientName('x'.repeat(500)), null, 'one long run is dropped whole');
  assert.equal(sanitizeClientName('ab '.repeat(100)).length <= 64, true);
  assert.equal(sanitizeClientName('\u0000\u0007'), null);
  assert.equal(sanitizeClientName(42), null);
  assert.equal(sanitizeClientVersion('1.2.3-beta+build; rm -rf /'), '1.2.3-beta+buildrm-rf');
  assert.equal(sanitizeClientVersion('9'.repeat(100)).length, 32);

  const init = buildTelemetryRow({ eventType: 'initialize', endpoint: '/api/mcp', status: 'ok', clientName: 'cursor', clientVersion: '0.4', callerIp: CALLER_IP });
  assert.equal(init.client_name, 'cursor');
  assert.equal(init.client_version, '0.4');
  assert.equal(init.caller_hash, callerHash(CALLER_IP));
  assert.ok(!('caller_ip' in init) && !JSON.stringify(init).includes(CALLER_IP));
  const call = buildTelemetryRow({ eventType: 'tool_call', clientName: 'cursor', callerHash: 'not-a-hash' });
  assert.equal(call.client_name, null, 'client name only on initialize rows');
  assert.equal(call.caller_hash, null, 'a malformed hash is dropped');
});

test('MCP initialize + tools/call store the client name and a hashed IP - never the IP or the queried value', async () => {
  const { rows } = installFetch([['/rest/v1/free_tier_usage', () => Response.json([{ request_count: 1 }])]]);
  const headers = { 'x-forwarded-for': `${CALLER_IP}, 10.0.0.1` };

  await mcpHandler({ method: 'POST', headers, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: `Claude Desktop ${WALLET}`, version: '1.0.0;drop' } } } }, makeRes());
  await mcpHandler({ method: 'POST', headers, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_usage_status', arguments: { identifier: WALLET } } } }, makeRes());
  await mcpHandler({ method: 'POST', headers, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_domain_age', arguments: { domain: FIXTURE_VALUES.domain.FLAGGED } } } }, makeRes());
  await settle();

  assert.equal(rows.length, 3);
  const [init, call, fixture] = rows;
  assert.equal(init.event_type, 'initialize');
  assert.equal(init.client_name, 'Claude Desktop');
  assert.equal(init.client_version, '1.0.0drop');
  assert.equal(call.tool_name, 'get_usage_status');
  assert.equal(call.is_fixture, false);
  assert.equal(fixture.tool_name, 'check_domain_age');
  assert.equal(fixture.is_fixture, true);
  for (const r of rows) {
    assert.equal(r.caller_hash, callerHash(CALLER_IP));
    const text = JSON.stringify(r);
    assert.ok(!text.includes(CALLER_IP) && !text.includes('10.0.0.1'), 'no raw IP stored');
    assert.ok(!text.toLowerCase().includes(WALLET.slice(2, 12)), 'no wallet address stored');
    assert.ok(!text.includes(FIXTURE_VALUES.domain.FLAGGED), 'no queried domain stored');
  }
});

test('MCP rate-limited free tool call is recorded as rate_limited', async () => {
  const { rows } = installFetch();
  const headers = { 'x-forwarded-for': '198.51.100.250' };
  let limited = null;
  for (let i = 0; i < 130 && !limited; i++) {
    const res = makeRes();
    await mcpHandler({ method: 'POST', headers, body: { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'check_wallet_sanctions', arguments: { address: '0x' + String(i).padStart(40, '0') } } } }, res);
    const text = res.body && res.body.result && res.body.result.content && res.body.result.content[0].text;
    if (text && JSON.parse(text).code === 'rate_limited') limited = res;
  }
  await settle();
  assert.ok(limited, 'the anonymous hourly limit was reached');
  assert.equal(rows[rows.length - 1].status, 'rate_limited');
  assert.ok(rows.every((r) => !JSON.stringify(r).includes('198.51.100.250')));
});

test('A2A and the playground record the skill/tool, fixture flag and a hashed IP only', async () => {
  const { rows } = installFetch();
  const res = makeRes();
  await a2aHandler({
    method: 'POST', headers: { 'x-forwarded-for': CALLER_IP }, query: {},
    body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { skill: 'check_domain_age', arguments: { domain: FIXTURE_VALUES.domain.FLAGGED } } }] } } }
  }, res);
  await settle();
  assert.equal(rows.length, 1);
  assert.deepEqual({ endpoint: rows[0].endpoint, tool_name: rows[0].tool_name, is_fixture: rows[0].is_fixture, payment_type: rows[0].payment_type },
    { endpoint: '/api/a2a', tool_name: 'check_domain_age', is_fixture: true, payment_type: 'free' });
  assert.equal(rows[0].caller_hash, callerHash(CALLER_IP));

  const captured = [];
  const pg = createPlaygroundHandler({
    record: () => {},
    telemetry: (e) => captured.push(buildTelemetryRow(e)),
    executorOptions: { log: () => {}, fixtures: () => null, run: async () => ({ status: 'no_flags', reasons: [], checks: [] }) }
  });
  const pgRes = makeRes();
  await pg({ method: 'POST', headers: { 'x-forwarded-for': CALLER_IP }, body: { tool: 'check_domain_age', input: 'example.com' } }, pgRes);
  assert.equal(pgRes.statusCode, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].endpoint, '/api/playground');
  assert.equal(captured[0].tool_name, 'check_domain_age');
  assert.equal(captured[0].status, 'ok');
  assert.equal(captured[0].is_fixture, false);
  assert.ok(!JSON.stringify(captured[0]).includes('example.com') && !JSON.stringify(captured[0]).includes(CALLER_IP));
});

test('/api/ioc records one ioc_feed row with how it ended, never the query or the IP', async () => {
  delete process.env.X402_PAY_TO_ADDRESS;
  const { rows } = installFetch();
  const res = makeRes();
  await chatHandler({ method: 'GET', url: '/api/ioc?type=ipv4&min_score=90', headers: { 'x-forwarded-for': CALLER_IP }, socket: { remoteAddress: CALLER_IP }, body: null }, res);
  await settle();
  assert.equal(res.statusCode, 402);
  const ioc = rows.filter((r) => r.endpoint === '/api/ioc');
  assert.equal(ioc.length, 1);
  assert.equal(ioc[0].tool_name, 'ioc_feed');
  assert.equal(ioc[0].status, 'payment_required');
  assert.equal(ioc[0].caller_hash, callerHash(CALLER_IP));
  assert.ok(!JSON.stringify(ioc[0]).includes('ipv4') && !JSON.stringify(ioc[0]).includes(CALLER_IP));
});

// --- get_usage_stats: operator only ------------------------------------------

test('get_usage_stats is offered to the operator role only, and is not an MCP tool', () => {
  assert.ok(chatToolsForRole('operator').some((t) => t.name === USAGE_STATS_TOOL));
  assert.ok(!chatToolsForRole('guest').some((t) => t.name === USAGE_STATS_TOOL));
  for (const role of ['public', undefined, null, '', 'constructor', 'OPERATOR']) {
    assert.ok(!chatToolsForRole(role).some((t) => t.name === USAGE_STATS_TOOL), String(role));
  }
  assert.ok(!CHAT_TOOL_ROLES.guest.tools.some((n) => OPERATOR_ONLY_CHAT_TOOLS.includes(n)));
  assert.ok(!TOOLS.some((t) => t.name === USAGE_STATS_TOOL), 'the MCP tool list is unchanged');
});

test('guest and unknown roles cannot run get_usage_stats; the stats reader is never called', async () => {
  let reads = 0;
  for (const role of ['guest', 'public', null, '']) {
    const execute = createToolExecutor({ role, log: () => {}, record: () => {}, usageStats: async () => { reads++; return {}; } });
    const out = await execute({ id: 'x', name: USAGE_STATS_TOOL, args: { period: '7d' } });
    assert.equal(out.ok, false, String(role));
    assert.equal(out.code, 'not_available');
  }
  assert.equal(reads, 0);
});

test('MCP and A2A callers cannot reach get_usage_stats', async () => {
  const { calls } = installFetch();
  const mcpRes = makeRes();
  await mcpHandler({ method: 'POST', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_usage_stats', arguments: { period: '7d' } } } }, mcpRes);
  assert.equal(mcpRes.body.error.code, -32602);
  const a2aRes = makeRes();
  await a2aHandler({ method: 'POST', headers: {}, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm', parts: [{ kind: 'data', data: { skill: 'get_usage_stats', arguments: {} } }] } } } }, a2aRes);
  assert.equal(a2aRes.statusCode, 400);
  await settle();
  assert.ok(!calls.some((c) => c.url.includes('/rest/v1/agent_telemetry') && c.method === 'GET'), 'no stats read');
});

test('the public playground refuses get_usage_stats', async () => {
  let telemetryCalls = 0;
  const pg = createPlaygroundHandler({ record: () => {}, telemetry: () => { telemetryCalls++; } });
  const res = makeRes();
  await pg({ method: 'POST', headers: {}, body: { tool: 'get_usage_stats', input: '7d' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'not_available');
  assert.equal(telemetryCalls, 0);
});

test('operator get_usage_stats returns aggregates only, a "report" card and "about N" wording', async () => {
  const stats = { ...aggregateUsage(SEED, { period: '7d', now: NOW }), truncated: false, generated_at: new Date(NOW).toISOString() };
  const execute = createToolExecutor({ role: 'operator', log: () => {}, record: () => {}, usageStats: async ({ period }) => { assert.equal(period, '7d'); return stats; } });
  const out = await execute({ id: 'u1', name: USAGE_STATS_TOOL, args: { period: 'bogus' } });
  assert.equal(out.ok, true);
  assert.equal(out.result.distinct_callers_text, 'about 4 distinct callers (estimated from hashed IP addresses)');
  assert.match(out.request_id, /^[0-9a-f-]{36}$/);
  const text = JSON.stringify(out.result);
  for (const c of ['a', 'b', 'c', 'd']) assert.ok(!text.includes(H(c)), 'no caller hash is returned');

  const card = summarizeOutcome(out);
  assert.equal(card.status, 'report');
  assert.equal(card.status_label, 'Report');
  assert.equal(card.title, 'Usage stats');
  const fields = Object.fromEntries(card.fields.map((f) => [f.label, f.value]));
  assert.equal(fields['Distinct callers'], 'about 4 (estimate, hashed IPs)');
  assert.equal(fields['Tool calls'], '7');
  assert.equal(fields.Fixtures, 'excluded');
  assert.equal(fields['Paid settlements'], '1');
  assert.equal(unverifiedNote([out]), '', 'a completed report is not "unverified"');
  assert.match(spokenSummary([out]), /about 4 distinct callers/);
  assert.match(usageReport(out), /from about 4 distinct callers/);
  assert.doesNotMatch(usageReport(out), /\b4 agents\b/);

  const directive = toolDirective(chatToolsForRole('operator'));
  assert.match(directive, /about N distinct callers/);
  assert.match(directive, /never "N agents"/);
  assert.match(directive, /never estimate, recall or invent a number/);
  assert.doesNotMatch(toolDirective(chatToolsForRole('guest')), /get_usage_stats/);
});

test('a failed stats read is a neutral error with the request_id and no figures', async () => {
  const recorded = [];
  const execute = createToolExecutor({ role: 'operator', log: () => {}, record: (...a) => recorded.push(a), usageStats: async () => { throw new UsageStatsUnavailableError(); } });
  const out = await execute({ id: 'u2', name: USAGE_STATS_TOOL, args: { period: '30d' } });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'usage_unavailable');
  assert.equal(out.message, `Usage stats could not be read right now (request_id ${out.request_id}). No figures are available.`);
  assert.deepEqual(recorded[0], ['/api/chat:get_usage_stats', null, 'usage_stats_unavailable', 'upstream', out.request_id]);
  assert.match(unverifiedNote([out]), new RegExp(`usage stats.*failed, request_id ${out.request_id}`));
  const report = usageReport(out);
  assert.match(report, /could not be read right now/);
  assert.ok(report.includes(out.request_id));
  assert.doesNotMatch(report.replace(out.request_id, ''), /\d/, 'no number in the failure reply besides the request_id');
  assert.equal(summarizeOutcome(out).status, 'failed');
});

test('usage questions go the tools route so the operator\'s model gets get_usage_stats', () => {
  assert.equal(chooseChatRoute('how many agents used our tools this week?').reason, 'usage_stats');
  assert.equal(chooseChatRoute('show me tool usage for the last 30 days').route, 'tools');
  assert.equal(chooseChatRoute('how many people live in Paris?').route, 'search');
});

// --- /usage command ----------------------------------------------------------

let ipSeq = 0;
const chatReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.77.0.${++ipSeq}` }, body });

test('/usage without sign-in is a 401 and never reads the telemetry table', async () => {
  for (const body of [{ prompt: '/usage' }, { prompt: '/usage 30d', user: 'test-operator', pass: 'wrong' }]) {
    const { calls } = installFetch();
    const res = makeRes();
    await chatHandler(chatReq(body), res);
    assert.equal(res.statusCode, 401);
    assert.match(res.jsonBody.reply, /Authentication required/);
    assert.equal(res.jsonBody.toolResults, undefined);
    assert.ok(!calls.some((c) => c.url.includes('/rest/v1/agent_telemetry')), 'no stats read');
  }
});

test('/usage for the signed-in operator answers with the report and the card', async () => {
  const { calls } = installFetch([['/rest/v1/agent_telemetry', () => Response.json(SEED.filter((r) => !r.is_fixture).map((r) => ({ ...r, created_at: new Date().toISOString() })))]]);
  const res = makeRes();
  await chatHandler(chatReq({ prompt: '/usage 30d', user: 'test-operator', pass: 'test-secret-pass' }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.jsonBody.reply, /USAGE · the last 30 days/);
  assert.match(res.jsonBody.reply, /from about 5 distinct callers/);
  assert.match(res.jsonBody.reply, /Fixture calls are excluded/);
  assert.equal(res.jsonBody.toolResults.length, 1);
  assert.equal(res.jsonBody.toolResults[0].tool, 'get_usage_stats');
  assert.equal(res.jsonBody.toolResults[0].status, 'report');
  const read = calls.find((c) => c.url.includes('/rest/v1/agent_telemetry') && c.method === 'GET');
  assert.ok(read && /is_fixture=eq\.false/.test(read.url));
  assert.ok(!JSON.stringify(res.jsonBody).includes(H('a')), 'no caller hash in the reply');
});

test('/usage on the streamed chat path sends the card as a tool_result event', async () => {
  installFetch([['/rest/v1/agent_telemetry', () => Response.json([])]]);
  const res = makeRes();
  await chatHandler(chatReq({ prompt: '/usage today', user: 'test-operator', pass: 'test-secret-pass', stream: true }), res);
  const events = [];
  const parser = createSseParser(({ data }) => events.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  const card = events.find((e) => e.type === 'tool_result');
  assert.ok(card, 'a tool_result event');
  assert.equal(card.tool, 'get_usage_stats');
  assert.equal(card.status, 'report');
  assert.ok(events.some((e) => e.type === 'text' && /about 0 distinct callers/.test(e.text || e.delta || JSON.stringify(e))));
  assert.equal(events[events.length - 1].type, 'done');
});

test('/usage when the read fails: neutral error with request_id, failed card, no numbers', async () => {
  installFetch([['/rest/v1/agent_telemetry', () => new Response('db down', { status: 503 })]]);
  const res = makeRes();
  await chatHandler(chatReq({ prompt: '/usage', user: 'test-operator', pass: 'test-secret-pass' }), res);
  assert.equal(res.statusCode, 200);
  const card = res.jsonBody.toolResults[0];
  assert.equal(card.status, 'failed');
  assert.match(card.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(res.jsonBody.reply, `### [ USAGE ]\nUsage stats could not be read right now (request_id \`${card.request_id}\`). No figures are available.`);
  assert.ok(!res.jsonBody.reply.includes('db down'));
});

// --- retention ---------------------------------------------------------------

test('purgeExpiredTelemetry deletes rows older than 90 days', async () => {
  assert.equal(TELEMETRY_RETENTION_DAYS, 90);
  const seen = [];
  const out = await purgeExpiredTelemetry({ now: NOW, fetchImpl: async (url, opts) => { seen.push({ url, opts }); return { ok: true, status: 204 }; } });
  const cutoff = new Date(NOW - 90 * 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(out, { ok: true, cutoff });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].opts.method, 'DELETE');
  assert.equal(seen[0].url, `${SUP_URL}/rest/v1/agent_telemetry?created_at=lt.${encodeURIComponent(cutoff)}`);
  assert.equal(seen[0].opts.headers.apikey, 'service-role-test');

  assert.deepEqual(await purgeExpiredTelemetry({ now: NOW, fetchImpl: async () => ({ ok: false, status: 500 }) }), { ok: false, cutoff, status: 500 });
  assert.deepEqual(await purgeExpiredTelemetry({ now: NOW, fetchImpl: async () => { throw new Error('down'); } }), { ok: false, cutoff });
});

test('the daily cleanup cron runs the telemetry retention delete alongside pg1_errors', async () => {
  process.env.CRON_SECRET = 'cron-secret';
  const { calls } = installFetch([
    ['/rest/v1/agent_telemetry', () => new Response(null, { status: 204 })],
    ['/rest/v1/pg1_errors', () => new Response(null, { status: 204 })]
  ]);
  const denied = makeRes();
  await cleanupHandler({ method: 'GET', headers: {} }, denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(calls.length, 0, 'no delete without the cron secret');

  const res = makeRes();
  await cleanupHandler({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.telemetry.ok, true);
  const del = calls.find((c) => c.url.includes('/rest/v1/agent_telemetry'));
  assert.equal(del.method, 'DELETE');
  const cutoff = Date.parse(decodeURIComponent(del.url.split('created_at=lt.')[1]));
  const days = (Date.now() - cutoff) / (24 * 60 * 60 * 1000);
  assert.ok(days > 89.99 && days < 90.01, `cutoff is 90 days back (${days})`);
  assert.ok(calls.some((c) => c.url.includes('/rest/v1/pg1_errors') && c.method === 'DELETE'));

  installFetch([
    ['/rest/v1/agent_telemetry', () => new Response(null, { status: 500 })],
    ['/rest/v1/pg1_errors', () => new Response(null, { status: 204 })]
  ]);
  const failed = makeRes();
  await cleanupHandler({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, failed);
  assert.equal(failed.statusCode, 502, 'a failed retention delete is visible to the cron');
});

test('distinctCallersText always says "about"', () => {
  assert.equal(distinctCallersText(1), 'about 1 distinct caller (estimated from hashed IP addresses)');
  assert.equal(distinctCallersText(0), 'about 0 distinct callers (estimated from hashed IP addresses)');
});
