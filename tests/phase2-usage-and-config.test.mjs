/**
 * Phase 2: /usage probe classification and error breakdown, and the
 * read-only payment configuration checks (lib/paymentConfigCheck.mjs).
 *
 * Run with: node --test tests/phase2-usage-and-config.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateUsage, ERROR_FAULT, ERROR_STATUSES } from '../lib/usageStats.mjs';
import { formatUsageReport } from '../lib/usageReport.mjs';
import { toolErrorTelemetryStatus } from '../lib/telemetry.mjs';
import { expectedAccepts, livePaymentChecks, staticPaymentChecks } from '../lib/paymentConfigCheck.mjs';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const at = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const hash = (c) => c.repeat(32);
const call = (caller, fields) => ({ created_at: at(1), event_type: 'tool_call', endpoint: '/api/mcp', payment_type: 'free', status: 'ok', caller_hash: hash(caller), is_fixture: false, ...fields });

// ---------------------------------------------------------------------
// Error statuses at the source
// ---------------------------------------------------------------------

test('toolErrorTelemetryStatus splits caller mistakes from PG1 failures', () => {
  assert.equal(toolErrorTelemetryStatus({ code: 'invalid_address' }), 'invalid_input');
  assert.equal(toolErrorTelemetryStatus({ code: 'abuseipdb_key_required' }), 'invalid_input');
  assert.equal(toolErrorTelemetryStatus({ code: 'upstream_unavailable' }), 'upstream_error');
  assert.equal(toolErrorTelemetryStatus({ code: 'rate_limited' }), 'rate_limited');
  assert.equal(toolErrorTelemetryStatus({ code: 'something_new' }), 'tool_error');
});

test('every error status has a fault; unknown_tool is not an error', () => {
  for (const s of ERROR_STATUSES) assert.ok(ERROR_FAULT[s], s);
  assert.ok(!ERROR_STATUSES.includes('unknown_tool'));
});

// ---------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------

const ROWS = [
  // a: a real caller with a caller mistake and a PG1 failure.
  call('a', { tool_name: 'check_domain_age' }),
  call('a', { tool_name: 'check_wallet_age', status: 'invalid_input' }),
  call('a', { tool_name: 'check_wallet_age', status: 'upstream_error' }),
  call('a', { tool_name: 'check_domain_age', status: 'tool_error' }),
  // b: a scanner that only tried tools we don't have.
  { created_at: at(2), event_type: 'mcp_request', endpoint: '/api/mcp', mcp_method: 'tools/list', status: 'ok', caller_hash: hash('b'), payment_type: 'none' },
  call('b', { tool_name: null, requested_tool: 'execute_command', status: 'unknown_tool', payment_type: 'none' }),
  call('b', { tool_name: null, requested_tool: 'read_file', status: 'unknown_tool', payment_type: 'none' }),
  // c: a real caller who mistyped once.
  call('c', { tool_name: 'check_domain_age' }),
  call('c', { tool_name: null, requested_tool: 'check_domain', status: 'unknown_tool', payment_type: 'none' }),
  // d: shown a payment challenge, never served (drop-off).
  call('d', { tool_name: 'get_cve_details', status: 'payment_required', payment_type: 'none' }),
  // e: challenged, then used the free tier on A2A.
  call('e', { tool_name: 'get_cve_details', status: 'payment_required', payment_type: 'none' }),
  call('e', { tool_name: 'get_cve_details', status: 'ok', payment_type: 'free_tier', endpoint: '/api/a2a' }),
  call('e', { tool_name: 'get_cve_batch', status: 'ok', payment_type: 'free_tier' })
];

test('a caller that only tried unknown tools (and listing) is a probe: unknown_tools_only', () => {
  const r = aggregateUsage(ROWS, { period: '24h', now: NOW });
  assert.equal(r.traffic.probe_callers_by_reason.unknown_tools_only, 1);
  assert.equal(r.traffic.distinct_callers_estimate.probe, 1);
  assert.equal(r.traffic.distinct_callers_estimate.real, 4);
});

test('unknown tools are counted on their own, never as errors', () => {
  const r = aggregateUsage(ROWS, { period: '24h', now: NOW });
  assert.deepEqual(r.errors.unknown_tool_calls, { total: 3, real: 1, probe: 2 });
  assert.equal(r.errors.total, 3);
  assert.ok(!r.errors.by_type.some((t) => t.type === 'unknown_tool'));
  assert.deepEqual(r.errors.unrecognised_tools.map((u) => u.name).sort(), ['check_domain', 'execute_command', 'read_file']);
});

test('errors are broken down by fault and by tool x type x caller class', () => {
  const r = aggregateUsage(ROWS, { period: '24h', now: NOW });
  // tool_error counts as PG1's or its source's fault, never unclassified.
  assert.deepEqual(r.errors.by_fault, { caller: 1, pg1: 2, unclassified: 0 });
  const cell = r.errors.breakdown.find((c) => c.tool === 'check_wallet_age' && c.type === 'upstream_error');
  assert.deepEqual({ fault: cell.fault, errors: cell.errors, real: cell.real, probe: cell.probe }, { fault: 'pg1', errors: 1, real: 1, probe: 0 });
});

test('funnel: callers shown a payment request and never served, and free tier by route', () => {
  const r = aggregateUsage(ROWS, { period: '24h', now: NOW });
  assert.equal(r.payments.callers_challenged_never_served, 1);
  assert.equal(r.payments.free_tier_calls, 2);
  assert.deepEqual(r.payments.free_tier_calls_by_route, [{ route: '/api/a2a', calls: 1 }, { route: '/api/mcp', calls: 1 }]);
});

test('the /usage text shows probe reasons, fault split, unknown tools and the drop-off', () => {
  const text = formatUsageReport(aggregateUsage(ROWS, { period: '24h', now: NOW }));
  assert.match(text, /Probe callers: unknown tools only 1/);
  assert.match(text, /Whose fault: PG1 or its sources 2 · caller input 1$/m);
  assert.match(text, /Unknown tools asked for \(caller mistakes, not errors\): 3 \(real 1, probe 2\)/);
  assert.match(text, /Shown a payment request, never served: 1 caller/);
  assert.match(text, /Free tier by route \(one 5\/day counter\): \/api\/a2a 1 · \/api\/mcp 1/);
});

// ---------------------------------------------------------------------
// Payment configuration checks
// ---------------------------------------------------------------------

test('the repo agrees with itself on price, network, asset, payee and the free-tier limit', () => {
  for (const r of staticPaymentChecks({ env: {} })) assert.ok(r.ok, `${r.name}: ${r.detail}`);
  assert.deepEqual(expectedAccepts(), { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '10000' });
});

test('the static check ties /api/ioc in /.well-known/x402 to PG1_FEED_PAID: not listed while the feed is free', () => {
  const feedRow = (env) => staticPaymentChecks({ env }).find((r) => r.name.includes('/api/ioc'));
  assert.equal(feedRow({}).ok, true, 'default: the free feed is not listed as paid');
  // Turning the switch on without restoring the /api/ioc resource is caught.
  assert.equal(feedRow({ PG1_FEED_PAID: 'true' }).ok, false);
});

function mockDeployment({ payTo = '0x897583A6da146826ecA90e5c24158bC226C29d53', a2aState = 'input-required', feed = 'free' } = {}) {
  const accept = { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo };
  const pr = { x402Version: 2, error: 'Payment required', resource: {}, accepts: [accept] };
  const header = Buffer.from(JSON.stringify(pr)).toString('base64');
  const res = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  return async (url, options = {}) => {
    const u = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    if (u.pathname === '/.well-known/x402') return res(200, { x402Version: 2, resources: [{ resource: `${u.origin}/api/mcp`, accepts: [accept] }] });
    if (u.pathname === '/api/ioc' && feed === 'free') return res(200, { type: 'bundle', id: 'bundle--x', objects: [] });
    if (u.pathname === '/api/ioc' && feed === 'paid') return res(402, pr, { 'payment-required': header });
    if (u.pathname === '/api/ioc') return res(500, { error: 'down' });
    if (u.pathname === '/api/mcp' && body.params.name === 'get_usage_status') return res(200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify({ free_tier_daily_limit: 5 }) }] } });
    if (u.pathname === '/api/mcp') return res(200, { jsonrpc: '2.0', result: { isError: true, structuredContent: pr, content: [{ type: 'text', text: JSON.stringify(pr) }] } }, { 'payment-required': header });
    if (u.pathname === '/api/a2a') return res(200, { jsonrpc: '2.0', result: { status: { state: a2aState, message: { metadata: { 'x402.payment.status': 'payment-required', 'x402.payment.required': pr } } } } });
    throw new Error(`unexpected ${url}`);
  };
}

test('live checks pass against a deployment that answers with the published terms', async () => {
  const results = await livePaymentChecks('https://deploy.example', { fetchImpl: mockDeployment() });
  for (const r of results) assert.ok(r.ok, `${r.name}: ${r.detail}`);
  assert.equal(results.length, 6);
  assert.match(results.find((r) => r.name.startsWith('/api/ioc')).detail, /free \(200 bundle\)/);
  const paidFeed = await livePaymentChecks('https://deploy.example', { fetchImpl: mockDeployment({ feed: 'paid' }) });
  for (const r of paidFeed) assert.ok(r.ok, `${r.name}: ${r.detail}`);
  const brokenFeed = await livePaymentChecks('https://deploy.example', { fetchImpl: mockDeployment({ feed: 'broken' }) });
  assert.ok(brokenFeed.some((r) => !r.ok && r.name.startsWith('/api/ioc')));
});

test('live checks catch a deployment paying a different address, or an A2A gate that does not ask for payment', async () => {
  const wrongPayee = await livePaymentChecks('https://deploy.example', { fetchImpl: mockDeployment({ payTo: '0x000000000000000000000000000000000000bEEF', feed: 'paid' }) });
  assert.ok(wrongPayee.filter((r) => !r.ok).length >= 4);
  assert.ok(wrongPayee.some((r) => !r.ok && /payTo/.test(r.detail)));
  const openA2a = await livePaymentChecks('https://deploy.example', { fetchImpl: mockDeployment({ a2aState: 'completed' }) });
  assert.ok(openA2a.some((r) => !r.ok && r.name.startsWith('/api/a2a')));
});
