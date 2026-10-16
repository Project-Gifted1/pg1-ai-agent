/**
 * The /usage root causes from the 10-16 Oct 2026 report:
 *   - MCP: prompts/list, resources/list (and resources/templates/list)
 *     answered with empty lists and declared in initialize; ping answered;
 *     notifications never answered with an error; other methods recorded by
 *     name (reduced) and listed in the report; batches;
 *   - probe names (__verifymcp_auth_probe_*, __mcpcheckup_probe_*) make a
 *     caller a probe;
 *   - one /api/ioc request is one tool call (ioc_feed), never two;
 *   - tool errors are PG1's or its sources' fault, never the caller's;
 *   - unknown tool names are always recorded (truncated, sanitised);
 *   - own and test traffic is never real;
 *   - get_usage_status polling per caller, the busiest day's callers, 402s
 *     by tool;
 *   - the storage warning at 80%;
 *   - indicator lookups normalised; a non-string value is the caller's
 *     mistake, not a 500;
 *   - large media goes to R2, and nothing that makes it starts without R2.
 *
 * Run with: node --test tests/usage-root-causes.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEMETRY_IP_SALT = 'test-salt-for-root-causes';
delete process.env.X402_PAY_TO_ADDRESS;
delete process.env.VERCEL_ENV;

const { aggregateUsage, isProbeToolName, POLL_LOOP_MIN_CALLS } = await import('../lib/usageStats.mjs');
const { formatUsageReport } = await import('../lib/usageReport.mjs');
const { usageCardView, usageLead, storageWarnings, STORAGE_WARN_PERCENT } = await import('../lib/usageCard.mjs');
const { shapeStorageUsage } = await import('../lib/storageUsage.mjs');
const { buildTelemetryRow, callerHash, sanitizeRequestedTool, sanitizeMcpMethod, toolErrorTelemetryStatus, outcomeTelemetryStatus } = await import('../lib/telemetry.mjs');
const { callerKindOf, ownCallerHashes, isOwnHash } = await import('../lib/ownTraffic.mjs');
const { normalizeIndicator } = await import('../lib/iocContext.mjs');
const { fetchAbuseIpdbCheck } = await import('../lib/abuseIpdb.mjs');
const { isLargeMediaPath, largeMediaStorageMissing } = await import('../lib/storage/largeMedia.mjs');
const { startVideoJob } = await import('../lib/videoJobs.mjs');
const { createMusicStore, musicPath } = await import('../lib/music/store.mjs');
const { folderOf, vaultReport } = await import('../scripts/move-large-media-to-r2.mjs');
const { default: mcpHandler, MCP_SERVER_CAPABILITIES } = await import('../api/mcp.mjs');
const { default: chatHandler } = await import('../api/chat.mjs');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase.test';
const IP = '198.51.100.77';
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

beforeEach(() => {
  process.env.SUPABASE_URL = SUP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  process.env.TELEMETRY_IP_SALT = 'test-salt-for-root-causes';
  for (const k of ['X402_PAY_TO_ADDRESS', 'VERCEL_ENV', 'PG1_OWN_IPS', 'PG1_OWN_CALLER_HASHES', 'PG1_TEST_TRAFFIC_TOKEN', 'PG1_FEED_PAID']) delete process.env[k];
  globalThis.fetch = async (url) => { throw new Error('Unexpected network call in test: ' + url); };
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function installFetch(routes = []) {
  const rows = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.endsWith('/rest/v1/agent_telemetry') && options.method === 'POST') {
      rows.push(JSON.parse(options.body));
      return new Response(null, { status: 201 });
    }
    for (const [needle, handler] of routes) if (u.includes(needle)) return handler(u, options);
    if (u.includes('/rest/v1/')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error('Unexpected network call in test: ' + u);
  };
  return { rows };
}

const settle = () => new Promise((r) => setImmediate(r));

function makeRes() {
  return {
    statusCode: null, headers: {}, body: undefined, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { this.ended = true; return this; },
    write() { return true; }
  };
}

const post = async (body, headers = {}) => {
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': IP, ...headers }, body }, res);
  return res;
};

// --- rows for aggregateUsage --------------------------------------------------
const at = (h = 10, day = 16) => new Date(Date.UTC(2026, 9, day, h, 0, 0)).toISOString();
const { createHash } = await import('node:crypto');
const H = (c) => createHash('md5').update(String(c)).digest('hex');
const init = (c, name, extra = {}) => ({ created_at: at(), event_type: 'initialize', endpoint: '/api/mcp', status: 'ok', client_name: name, caller_hash: H(c), is_fixture: false, ...extra });
const call = (c, tool, status = 'ok', extra = {}) => ({ created_at: at(), event_type: 'tool_call', endpoint: '/api/mcp', tool_name: tool, payment_type: 'free', status, caller_hash: H(c), is_fixture: false, ...extra });
const req = (c, method, status = 'ok', extra = {}) => ({ created_at: at(), event_type: 'mcp_request', endpoint: '/api/mcp', mcp_method: method, status, caller_hash: H(c), is_fixture: false, ...extra });

// --- 1. MCP protocol -----------------------------------------------------------

test('initialize declares tools, prompts and resources; prompts/list, resources/list and resources/templates/list return empty lists', async () => {
  installFetch();
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' } } });
  assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { subscribe: false, listChanged: false } });
  assert.deepEqual(init.body.result.capabilities, MCP_SERVER_CAPABILITIES);
  for (const [method, key] of [['prompts/list', 'prompts'], ['resources/list', 'resources'], ['resources/templates/list', 'resourceTemplates']]) {
    const res = await post({ jsonrpc: '2.0', id: 7, method });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { jsonrpc: '2.0', result: { [key]: [] }, id: 7 }, method);
  }
  const ping = await post({ jsonrpc: '2.0', id: 8, method: 'ping' });
  assert.deepEqual(ping.body, { jsonrpc: '2.0', result: {}, id: 8 });
});

test('notifications never get an error: 202 with no body, recorded as ok, for every notifications/* method and any message without an id', async () => {
  const { rows } = installFetch();
  for (const body of [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } },
    { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } },
    { jsonrpc: '2.0', method: 'notifications/roots/list_changed' },
    { jsonrpc: '2.0', method: 'something/unknown' }
  ]) {
    const res = await post(body);
    assert.equal(res.statusCode, 202, body.method);
    assert.equal(res.body, undefined, `${body.method} gets no body`);
  }
  await settle();
  assert.deepEqual(rows.map((r) => [r.mcp_method, r.status]), [
    ['notifications/initialized', 'ok'], ['notifications/cancelled', 'ok'], ['notifications/progress', 'ok'],
    ['notifications/roots/list_changed', 'ok'], ['something/unknown', 'ok']
  ]);
  assert.ok(rows.every((r) => r.status !== 'method_not_found'));
});

test('an unknown method is recorded by its name (reduced), and the report lists the methods not found', async () => {
  const { rows } = installFetch();
  const res = await post({ jsonrpc: '2.0', id: 4, method: 'completion/complete' });
  assert.equal(res.body.error.code, -32601);
  await post({ jsonrpc: '2.0', id: 5, method: `logging/setLevel ${'0x' + 'ab'.repeat(20)} <b>` });
  await settle();
  assert.deepEqual(rows.map((r) => [r.mcp_method, r.status]), [['completion/complete', 'method_not_found'], ['logging/setLevel', 'method_not_found']]);
  assert.equal(sanitizeMcpMethod('x'.repeat(80)), 'other', 'a long run is removed');
  assert.ok(sanitizeMcpMethod('tools/' + 'a'.repeat(10)).length <= 40);

  const report = aggregateUsage([init('r', 'Claude'), call('r', 'check_domain_age'), req('r', 'completion/complete', 'method_not_found'), req('p', 'resources/read', 'method_not_found'), req('p', 'completion/complete', 'method_not_found')], { period: '24h', now: NOW, ownHashes: new Set() });
  assert.deepEqual(report.errors.methods_not_found, [
    { method: 'completion/complete', total: 2, real: 1, probe: 1 },
    { method: 'resources/read', total: 1, real: 0, probe: 1 }
  ]);
  assert.match(formatUsageReport(report), /^Methods not found: `completion\/complete` 2 \(real 1\) · `resources\/read` 1 \(real 0\)$/m);
});

test('a JSON-RPC batch is answered as an array without the notifications; a missing method is -32600', async () => {
  installFetch();
  const res = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'prompts/list' }]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [{ jsonrpc: '2.0', result: {}, id: 1 }, { jsonrpc: '2.0', result: { prompts: [] }, id: 2 }]);
  const onlyNotes = await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.equal(onlyNotes.statusCode, 202);
  const bad = await post({ jsonrpc: '2.0', id: 3 });
  assert.equal(bad.body.error.code, -32600);
});

// --- 3. report accuracy ------------------------------------------------------------

test('probe names: a caller that called __verifymcp_auth_probe_* or __mcpcheckup_probe_* is a probe, even with a real tool call', () => {
  assert.ok(isProbeToolName('__verifymcp_auth_probe_'));
  assert.ok(isProbeToolName('__verifymcp_auth_probe_7f3a'));
  assert.ok(isProbeToolName('__mcpcheckup_probe_x'));
  assert.ok(!isProbeToolName('check_domain_age'));
  const unknown = (c, name) => call(c, null, 'unknown_tool', { requested_tool: sanitizeRequestedTool(name) });
  const rows = [
    unknown('v', `__verifymcp_auth_probe_${'f'.repeat(32)}`), call('v', 'check_domain_age'),
    unknown('m', '__mcpcheckup_probe_1'), call('m', 'check_wallet_sanctions'),
    init('r', 'Claude'), call('r', 'check_domain_age')
  ];
  const s = aggregateUsage(rows, { period: '24h', now: NOW, ownHashes: new Set() });
  assert.equal(s.summary.real_tool_calls, 1, 'only r is real');
  assert.equal(s.traffic.probe_callers_by_reason.probe_tool_name, 2);
  assert.equal(s.traffic.distinct_callers_estimate.real, 1);
});

test('no double counting: one /api/ioc request writes one tool_call row (ioc_feed), and /usage counts it once', async () => {
  const { rows } = installFetch([['/rest/v1/threat_ioc_telemetry', () => Response.json([])], ['/rest/v1/api_access_logs', () => new Response(null, { status: 201 })]]);
  const res = makeRes();
  await chatHandler({ method: 'GET', url: '/api/ioc', headers: { 'x-forwarded-for': IP }, socket: { remoteAddress: IP }, body: null }, res);
  await settle();
  const toolRows = rows.filter((r) => r.event_type === 'tool_call');
  assert.equal(toolRows.length, 1);
  assert.equal(toolRows[0].tool_name, 'ioc_feed');
  assert.equal(toolRows[0].endpoint, '/api/ioc');
  const s = aggregateUsage(toolRows.map((r) => ({ ...r, created_at: at() })), { period: '24h', now: NOW, ownHashes: new Set() });
  assert.equal(s.traffic.tool_calls.total, 1);
  assert.deepEqual(s.tools.map((t) => [t.tool, t.calls]), [['ioc_feed', 1]], 'never also get_threat_indicators');
});

test('tool errors are PG1 or source fault: an AbuseIPDB 429 or 401 and an isError tool_error count as PG1, bad arguments as caller', async () => {
  for (const [status, code] of [[429, 'abuseipdb_rate_limited'], [401, 'invalid_abuseipdb_key'], [503, 'upstream_unavailable']]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ detail: 'x' }] }), { status, headers: { 'Content-Type': 'application/json' } });
    const err = await fetchAbuseIpdbCheck('k'.repeat(40), '8.8.8.8', 90).then(() => null, (e) => e);
    assert.ok(err, `AbuseIPDB ${status} is an error`);
    assert.equal(err.code, code);
    assert.equal(toolErrorTelemetryStatus(err), 'upstream_error', `AbuseIPDB ${status} is the source's fault`);
  }
  assert.equal(toolErrorTelemetryStatus({ code: 'invalid_ip' }), 'invalid_input');
  assert.equal(toolErrorTelemetryStatus({ code: 'something_broke' }), 'tool_error');
  assert.equal(outcomeTelemetryStatus({ ok: false, code: 'upstream_unavailable', category: 'upstream' }), 'upstream_error');
  assert.equal(outcomeTelemetryStatus({ ok: false, code: 'invalid_ip' }), 'invalid_input');
  assert.equal(outcomeTelemetryStatus({ ok: false, code: 'not_found' }), 'not_found');

  const rows = [init('r', 'Claude'), call('r', 'check_ip_abuse', 'tool_error'), call('r', 'check_ip_abuse', 'tool_error'), call('r', 'check_ip_abuse', 'upstream_error'), call('r', 'check_ip_abuse', 'invalid_input')];
  const e = aggregateUsage(rows, { period: '24h', now: NOW, ownHashes: new Set() }).errors;
  assert.deepEqual(e.by_fault, { caller: 1, pg1: 3, unclassified: 0 });
  assert.ok(e.breakdown.filter((c) => c.type === 'tool_error').every((c) => c.fault === 'pg1'));
});

test('unknown tool names are always recorded, truncated and sanitised; never "(not recorded)" for a new row', async () => {
  assert.equal(sanitizeRequestedTool(undefined), '(missing)');
  assert.equal(sanitizeRequestedTool(''), '(missing)');
  assert.equal(sanitizeRequestedTool({ a: 1 }), '(not a string)');
  assert.equal(sanitizeRequestedTool('<<<>>>'), '(unprintable)');
  assert.ok(sanitizeRequestedTool('t'.repeat(10) + '_'.repeat(100)).length <= 64);
  const { rows } = installFetch();
  await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { arguments: {} } });
  await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 42 } });
  await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: '__verifymcp_auth_probe_0123456789abcdef0123456789abcdef' } });
  await settle();
  const names = rows.filter((r) => r.status === 'unknown_tool').map((r) => r.requested_tool);
  assert.deepEqual(names, ['(missing)', '(not a string)', '__verifymcp_auth_probe_']);
  const s = aggregateUsage(rows.map((r) => ({ ...r, created_at: at() })), { period: '24h', now: NOW, ownHashes: new Set() });
  assert.ok(!s.errors.unrecognised_tools.some((u) => u.name === '(not recorded)'));
});

test('own and test traffic is never real: caller_kind rows, PG1_OWN_IPS, PG1_OWN_CALLER_HASHES prefixes, previews, our User-Agents, X-PG1-Test', () => {
  const env = { PG1_OWN_IPS: '203.0.113.9', PG1_TEST_TRAFFIC_TOKEN: 'tok-123' };
  assert.equal(callerKindOf({ headers: { 'x-forwarded-for': '203.0.113.9' } }, env), 'internal');
  assert.equal(callerKindOf({ headers: { 'user-agent': 'x402-endpoint-validator/1.0' } }, {}), 'internal');
  assert.equal(callerKindOf({ headers: { 'user-agent': 'pg1-payment-config-check' } }, {}), 'internal');
  assert.equal(callerKindOf({ headers: { 'user-agent': 'x402-doctor (render)' } }, {}), 'internal');
  assert.equal(callerKindOf({ headers: { 'x-pg1-test': 'tok-123' } }, env), 'test');
  assert.equal(callerKindOf({ headers: { 'x-pg1-test': 'wrong' } }, env), null);
  assert.equal(callerKindOf({ headers: {} }, { VERCEL_ENV: 'preview' }), 'test');
  assert.equal(callerKindOf({ headers: { 'user-agent': 'Claude-User' } }, { VERCEL_ENV: 'production' }), null);
  assert.equal(buildTelemetryRow({ eventType: 'tool_call', status: 'ok', callerKind: 'internal' }).caller_kind, 'internal');
  assert.equal('caller_kind' in buildTelemetryRow({ eventType: 'tool_call', status: 'ok', callerKind: 'someone' }), false);

  process.env.PG1_OWN_IPS = '203.0.113.9';
  const ownHash = callerHash('203.0.113.9');
  const own = ownCallerHashes({ PG1_OWN_IPS: '203.0.113.9', PG1_OWN_CALLER_HASHES: 'abcdef12' });
  assert.ok(own.has(ownHash));
  assert.ok(isOwnHash('abcdef12' + '0'.repeat(24), own), 'an 8-character prefix as /usage shows it');

  const rows = [
    init('r', 'Claude'), call('r', 'check_domain_age'),
    { ...call('i', 'check_domain_age'), caller_kind: 'internal' }, call('i', 'get_cve_details'), // all of i's rows are own traffic
    { ...call('x', 'check_domain_age'), caller_hash: ownHash },
    { ...call('t', 'check_wallet_age'), caller_kind: 'test' },
    { ...call('y', 'check_domain_age'), caller_hash: 'abcdef12' + '0'.repeat(24) }
  ];
  const s = aggregateUsage(rows, { period: '24h', now: NOW, ownHashes: own });
  assert.equal(s.summary.real_tool_calls, 1);
  assert.equal(s.summary.distinct_real_callers_estimate, 1);
  assert.equal(s.traffic.tool_calls.total, 1, 'own traffic is not probe either');
  assert.equal(s.own_traffic.tool_calls, 5);
  assert.deepEqual(s.own_traffic.by_kind, { internal: 1, test: 1, listed: 3 });
  assert.match(formatUsageReport(s), /^Own and test traffic, left out of every count: 5 requests from 4 callers/m);
});

test('/api/mcp marks a preview deployment\'s calls as test traffic', async () => {
  const { rows } = installFetch();
  process.env.VERCEL_ENV = 'preview';
  await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await settle();
  assert.equal(rows[0].caller_kind, 'test');
});

test('get_usage_status: calls per caller, with a caller polling in a loop shown', () => {
  const rows = [init('a', 'Claude'), call('a', 'check_domain_age'), init('b', 'Cursor'), call('b', 'check_domain_age'), call('b', 'get_usage_status')];
  for (let i = 0; i < POLL_LOOP_MIN_CALLS + 2; i++) rows.push(call('a', 'get_usage_status', 'ok', { created_at: new Date(Date.UTC(2026, 9, 16, 9, i, 0)).toISOString() }));
  const s = aggregateUsage(rows, { period: '24h', now: NOW, ownHashes: new Set() });
  const p = s.usage_status_polling;
  assert.equal(p.total, POLL_LOOP_MIN_CALLS + 3);
  assert.equal(p.callers_count, 2);
  assert.equal(p.callers[0].calls, POLL_LOOP_MIN_CALLS + 2);
  assert.equal(p.callers[0].median_gap_s, 60);
  assert.equal(p.callers[0].looping, true);
  assert.equal(p.callers[1].looping, false);
  assert.deepEqual(p.looping, [p.callers[0].caller]);
  assert.match(p.callers[0].caller, /^caller [0-9a-f]{8}$/);
  assert.match(formatUsageReport(s), /get_usage_status: 13 real calls from 2 callers; top `caller [0-9a-f]{8}` 12 \(.*median gap 60 s\) · polling in a loop/);
  const card = usageCardView(s, { now: NOW });
  const g = card.sections.find((x) => x.id === 'tools').groups.find((x) => x.title === 'get_usage_status by caller');
  assert.equal(g.rows[0].tag, 'loop');
});

test('the busiest day lists its callers; 402s are listed by tool with the number of callers', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(call('big', 'check_domain_age', 'ok', { created_at: at(8 + i, 11) }));
  rows.push(init('big', 'Bot/1', { created_at: at(7, 11) }), call('small', 'check_wallet_age', 'ok', { created_at: at(9, 12) }), init('small', 'Claude', { created_at: at(8, 12) }));
  rows.push(call('small', 'get_cve_details', 'payment_required', { created_at: at(10, 12) }), call('small', 'get_cve_details', 'payment_required', { created_at: at(11, 12) }), call('big', 'hosting_advisor', 'free_limit_reached', { created_at: at(12, 11) }));
  const s = aggregateUsage(rows, { period: '7d', now: NOW, ownHashes: new Set() });
  assert.equal(s.traffic.busiest_day, '2026-10-11');
  const day = s.traffic.day_callers.find((d) => d.day === '2026-10-11');
  assert.equal(day.callers[0].requests, 8);
  assert.equal(day.callers[0].client, 'Bot/1');
  assert.equal(day.callers[0].top[0].name, 'check_domain_age');
  assert.deepEqual(s.payments.payment_requests_by_tool.map((t) => [t.tool, t.requests, t.callers]), [['get_cve_details', 2, 1], ['hosting_advisor', 1, 1]]);
  assert.equal(s.payments.payment_requests_callers, 2);
  const text = formatUsageReport(s);
  assert.match(text, /^Busiest day Sun 11 Oct: 8 real \+ 0 probe · `caller [0-9a-f]{8}` 8 \(real, `Bot\/1`; check_domain_age 6/m);
  assert.match(text, /^402s by tool: `get_cve_details` 2 · `hosting_advisor` 1 \(2 callers\)$/m);
});

// --- 4. threat coverage ---------------------------------------------------------------

test('indicator lookups are normalised (case, refanging), and a non-string value is the caller\'s mistake, not a 500', async () => {
  assert.equal(normalizeIndicator('cve-2024-3094'), 'CVE-2024-3094');
  assert.equal(normalizeIndicator('Example.COM.'), 'example.com');
  assert.equal(normalizeIndicator('hxxps://Evil[.]com/A'), 'https://evil.com/A');
  assert.equal(normalizeIndicator('D41D8CD98F00B204E9800998ECF8427E'), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(normalizeIndicator('1.2.3.4'), '1.2.3.4');

  const seen = [];
  const { rows } = installFetch([['/rest/v1/threat_ioc_telemetry', (u) => { seen.push(decodeURIComponent(u)); return Response.json([]); }]]);
  const lookup = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_ioc_context', arguments: { value: 'cve-2024-3094' } } });
  assert.equal(lookup.statusCode, 200);
  assert.ok(seen.some((u) => u.includes('"cve-2024-3094"') && u.includes('"CVE-2024-3094"')), 'both the given and the stored form are looked up');
  const bad = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_ioc_context', arguments: { value: 12345 } } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error.code, -32602);
  await settle();
  assert.equal(rows.filter((r) => r.tool_name === 'get_ioc_context').at(-1).status, 'invalid_input');
});

// --- 5. storage ------------------------------------------------------------------------

test('storage warning at 80%: none at 79.9%, a warning at 80% and above, in the card and the lead line', () => {
  const MB = 1024 * 1024;
  const at799 = shapeStorageUsage({ database_bytes: MB, buckets: [{ name: 'pg1-vault', bytes: Math.floor(1024 * MB * 0.799), objects: 700 }] }, {});
  const at80 = shapeStorageUsage({ database_bytes: MB, buckets: [{ name: 'pg1-vault', bytes: Math.ceil(1024 * MB * 0.8), objects: 709 }], folders: [{ name: 'pg1-vault:films/*/final', bytes: 500 * MB, objects: 12 }] }, {});
  assert.equal(STORAGE_WARN_PERCENT, 80);
  assert.deepEqual(storageWarnings(at799), []);
  const w = storageWarnings(at80);
  assert.equal(w.length, 1);
  assert.equal(w[0].label, 'File storage');
  assert.match(w[0].text, /80\.0% of 1\.0 GB \(warning at 80%\)/);
  const r = aggregateUsage([], { period: '7d', now: NOW, ownHashes: new Set() });
  const storage = usageCardView(r, { now: NOW, storage: at80 }).sections.find((s) => s.id === 'storage');
  assert.equal(storage.groups[0].title, 'Warning');
  assert.equal(storage.groups.find((g) => g.title === 'Largest folders').rows[0].label, 'pg1-vault:films/*/final');
  assert.equal(usageCardView(r, { now: NOW, storage: at799 }).sections.find((s) => s.id === 'storage').groups[0].title, undefined);
  assert.match(usageLead(r, { storage: at80 }), /\*\*Storage warning:\*\* File storage is at 80\.0%/);
  assert.doesNotMatch(usageLead(r, { storage: at799 }), /Storage warning/);
});

test('large media is R2 only: what counts as large media, and Motion does not start (nothing reserved) without R2', async () => {
  for (const p of ['films/abc/final/v1.mp4', 'films/abc/stems/v1-dialogue.wav', 'films/abc/clip/s1.mp4', 'films/abc/social/v1-9x16.mp4', 'music/t1/master/v1-master.wav', 'music/t1/export/v1.zip', 'videos/job.mp4']) assert.ok(isLargeMediaPath(p), p);
  for (const p of ['films/abc/stills/s1.png', 'films/abc/posters/final-v1.jpg', 'videos/frames/x.png', 'tts_1.mp3', 'r2:films/abc/final/v1.mp4']) assert.ok(!isLargeMediaPath(p), p);
  assert.deepEqual(largeMediaStorageMissing({}), ['large-file storage (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)']);
  assert.deepEqual(largeMediaStorageMissing({ R2_ACCOUNT_ID: 'a'.repeat(32), R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' }), []);
  assert.deepEqual(largeMediaStorageMissing({ PG1_LARGE_MEDIA_IN_VAULT: '1' }), []);

  const calls = [];
  const reasons = [];
  const out = await startVideoJob({ env: { PG1_VIDEO_ENABLED: '1', PG1_VIDEO_GOOGLE_ASYNC: '1' }, prompt: 'a shield', geminiKeys: ['k1'], supUrl: SUP_URL, supKey: 'x', fetchImpl: async (u) => { calls.push(u); return Response.json([]); }, onFailure: (f) => reasons.push(f) });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'not_configured');
  assert.equal(calls.length, 0, 'nothing reserved, no engine called');
  assert.match(reasons[0].detail, /R2_ACCOUNT_ID/);
});

test('a music master goes to R2 when it is set up; a small file stays in the vault', async () => {
  const puts = [];
  const fetchImpl = async (u, o = {}) => { puts.push({ url: String(u), method: o.method }); return new Response(null, { status: 200 }); };
  const store = createMusicStore({ supUrl: SUP_URL, supKey: 'x', fetchImpl, r2: { accountId: 'a'.repeat(32), accessKeyId: 'k', secretAccessKey: 's', bucket: 'pg1-storage', host: `${'a'.repeat(32)}.r2.cloudflarestorage.com`, region: 'auto' } });
  const stored = await store.upload(musicPath('t1', 'master', 'v1-master.wav'), Buffer.from('x'), 'audio/wav');
  assert.equal(stored, 'r2:music/t1/master/v1-master.wav');
  assert.ok(puts[0].url.startsWith('https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com/pg1-storage/music/t1/master/'));
  const small = await store.upload(musicPath('t1', 'cover', 'c.png'), Buffer.from('x'), 'image/png');
  assert.equal(small, 'music/t1/cover/c.png');
  assert.ok(puts[1].url.startsWith(`${SUP_URL}/storage/v1/object/pg1-vault/`));
});

test('the vault report groups files by folder (ids folded) and adds up the large media', () => {
  assert.equal(folderOf('films/0b1c/final/v1.mp4'), 'films/*/final');
  assert.equal(folderOf('videos/j.mp4'), 'videos');
  assert.equal(folderOf('tts_123.mp3'), '(root) .mp3');
  const r = vaultReport([
    { name: 'films/a/final/v1.mp4', bytes: 300 }, { name: 'films/b/final/v1.mp4', bytes: 200 },
    { name: 'films/a/stills/s.png', bytes: 10 }, { name: 'tts_1.mp3', bytes: 5 }
  ]);
  assert.equal(r.bytes, 515);
  assert.deepEqual(r.large_media, { files: 2, bytes: 500 });
  assert.deepEqual(r.folders[0], { folder: 'films/*/final', bytes: 500, files: 2, large: true });
});
