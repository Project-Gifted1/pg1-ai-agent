/**
 * The STIX feed (MCP get_threat_indicators and GET/POST/HEAD /api/ioc) is
 * FREE while it holds no current data: no 402, no licence key, and it does
 * not use the 5 free calls a day, whatever headers are sent. PG1_FEED_PAID
 * (lib/x402Config.mjs, default off) makes it paid again; then the normal
 * gate applies. Every other paid tool keeps its price.
 *
 * Also: api_access_logs never stores a raw Gumroad licence key, only
 * "license:<HMAC>" (lib/telemetry.mjs licenceKeyHash, salt TELEMETRY_IP_SALT).
 *
 * Run with: node --test tests/feed-pricing.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RAW_LICENCE = 'RAWKEY-1234-ABCD-5678';

function baseEnv() {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.TELEMETRY_IP_SALT = 'feed-pricing-salt';
  process.env.GUMROAD_PRODUCT_ID = 'test-product';
  delete process.env.X402_PAY_TO_ADDRESS;
  delete process.env.PG1_FEED_PAID;
}
baseEnv();

const { default: mcpHandler, TOOLS } = await import('../api/mcp.mjs');
const { default: chatHandler } = await import('../api/chat.mjs');
const { isFeedPaid } = await import('../lib/x402Config.mjs');
const { licenceKeyHash, callerHash } = await import('../lib/telemetry.mjs');

let captured;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function installFetch() {
  captured = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = (options.method || 'GET').toUpperCase();
    captured.push({ url: String(input), method, body: options.body == null ? '' : String(options.body) });
    if (url.hostname === 'api.gumroad.com') return json({ success: true, purchase: { refunded: false, chargebacked: false } });
    if (url.pathname === '/rest/v1/free_tier_usage') return method === 'GET' ? json([]) : new Response(null, { status: 201 });
    if (url.pathname === '/rest/v1/threat_ioc_telemetry') return json([{ indicator_type: 'CVE', value: 'CVE-2021-44228', confidence_score: 90, last_seen: '2026-10-01T00:00:00Z', ingested_at: '2026-10-01T00:00:00Z', verification_source: 'NVD' }]);
    if (url.pathname.startsWith('/rest/v1/')) return method === 'GET' ? json([]) : new Response(null, { status: 201 });
    if (url.hostname === 'services.nvd.nist.gov') return json({ vulnerabilities: [] });
    if (url.hostname === 'www.cisa.gov') return json({ vulnerabilities: [] });
    throw new Error(`unexpected fetch: ${url.hostname}${url.pathname}`);
  };
}

beforeEach(() => { baseEnv(); installFetch(); });
after(() => { process.env = { ...ORIGINAL_ENV }; global.fetch = ORIGINAL_FETCH; });

function makeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    end(b) { if (typeof b === 'string') { try { this.body = JSON.parse(b); } catch { this.body = b; } } return this; }
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const IP = '203.0.113.77';

async function ioc(method = 'GET', headers = {}) {
  const res = makeRes();
  await chatHandler({ method, url: '/api/ioc', headers: { 'x-forwarded-for': IP, ...headers }, socket: { remoteAddress: IP }, body: null }, res);
  await settle();
  return res;
}

async function mcpCall(name, args, headers = { 'x-forwarded-for': IP }) {
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }, res);
  await settle();
  return res.body.result;
}

const freeTierWrites = () => captured.filter((c) => c.url.includes('/rest/v1/free_tier_usage'));
const accessLogs = () => captured.filter((c) => c.url.includes('/rest/v1/api_access_logs')).map((c) => JSON.parse(c.body));

test('PG1_FEED_PAID is off by default and only true/1/yes/on turn it on', () => {
  assert.equal(isFeedPaid({}), false);
  for (const v of ['true', '1', 'yes', 'on', 'TRUE']) assert.equal(isFeedPaid({ PG1_FEED_PAID: v }), true, v);
  for (const v of ['', 'false', '0', 'off', 'paid']) assert.equal(isFeedPaid({ PG1_FEED_PAID: v }), false, v);
});

test('free feed: /api/ioc serves the bundle with no 402 whatever the headers, and never touches the free tier, Gumroad or x402', async () => {
  const cases = [
    ['GET', {}],
    ['GET', { 'x-free-tier': '0' }],
    ['GET', { 'payment-signature': 'not-a-real-payment' }],
    ['GET', { 'x-api-key': RAW_LICENCE }],
    ['GET', { 'user-agent': 'x402scan/1.0' }],
    ['POST', {}],
    ['HEAD', {}]
  ];
  for (const [method, headers] of cases) {
    const res = await ioc(method, headers);
    const label = `${method} ${JSON.stringify(headers)}`;
    assert.equal(res.statusCode, 200, label);
    assert.equal(res.headers['PAYMENT-REQUIRED'], undefined, label);
    if (method !== 'HEAD') assert.equal(res.body.type, 'bundle', label);
  }
  // Seven calls, more than the 5/day free tier, and none of them counted.
  assert.equal(freeTierWrites().length, 0, 'the free tier is never read or written');
  assert.ok(!captured.some((c) => c.url.includes('api.gumroad.com')), 'no licence check');
  const logs = accessLogs();
  assert.ok(logs.length > 0);
  for (const row of logs) assert.equal(row.license_key, 'free-feed');
  assert.ok(!captured.some((c) => c.body.includes(RAW_LICENCE)), 'the raw licence key is never written');
});

test('free feed: MCP get_threat_indicators is served six times running, even with X-Free-Tier: 0 or no IP', async () => {
  for (let i = 0; i < 6; i++) {
    const result = await mcpCall('get_threat_indicators', { limit: 1 }, { 'x-forwarded-for': IP, 'x-free-tier': '0' });
    assert.notEqual(result.isError, true, `call ${i + 1}`);
  }
  const noIp = await mcpCall('get_threat_indicators', { limit: 1 }, {});
  assert.notEqual(noIp.isError, true, 'served without an IP too');
  assert.equal(freeTierWrites().length, 0, 'the free tier is never read or written');
});

test('free feed: the other paid tools keep their price (get_cve_details still asks for payment)', async () => {
  const result = await mcpCall('get_cve_details', { cve_id: 'CVE-2021-44228' }, { 'x-forwarded-for': IP, 'x-free-tier': '0' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.x402Version, 2);
});

test('paid feed (PG1_FEED_PAID=true): /api/ioc and get_threat_indicators answer an unpaid caller with the payment challenge again', async () => {
  process.env.PG1_FEED_PAID = 'true';
  const res = await ioc('GET', { 'x-free-tier': '0' });
  assert.equal(res.statusCode, 402);
  const result = await mcpCall('get_threat_indicators', { limit: 1 }, { 'x-forwarded-for': IP, 'x-free-tier': '0' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.x402Version, 2);
});

test('paid feed: a free-tier call is counted under the caller hash', async () => {
  process.env.PG1_FEED_PAID = 'true';
  const res = await ioc('GET');
  assert.equal(res.statusCode, 200);
  assert.ok(freeTierWrites().some((c) => c.method !== 'GET'), 'the free tier was spent');
  assert.deepEqual(accessLogs().map((r) => r.license_key), [`free-tier:${callerHash(IP)}`]);
});

test('paid feed: a licence-key call logs license:<32 hex HMAC>, never the raw key', async () => {
  process.env.PG1_FEED_PAID = 'true';
  const res = await ioc('GET', { 'x-api-key': RAW_LICENCE });
  assert.equal(res.statusCode, 200);
  const [row] = accessLogs();
  assert.match(row.license_key, /^license:[0-9a-f]{32}$/);
  assert.equal(row.license_key, `license:${licenceKeyHash(RAW_LICENCE)}`);
  for (const c of captured.filter((x) => x.url.includes('example.supabase.co'))) {
    assert.ok(!c.url.includes(RAW_LICENCE) && !c.body.includes(RAW_LICENCE), `raw key written: ${c.method} ${c.url}`);
  }
});

test('licenceKeyHash: salted, domain-separated from the IP hash, none without a key or salt', () => {
  const h = licenceKeyHash(RAW_LICENCE);
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.equal(licenceKeyHash(` ${RAW_LICENCE} `), h, 'trimmed');
  assert.notEqual(h, callerHash(RAW_LICENCE), 'a licence-key hash never equals the IP hash of the same string');
  process.env.TELEMETRY_IP_SALT = 'another-salt';
  assert.notEqual(licenceKeyHash(RAW_LICENCE), h, 'depends on the salt');
  for (const none of ['', '   ', undefined, null]) assert.equal(licenceKeyHash(none), null, String(none));
});

test('tool description: get_threat_indicators says FREE by default and carries the payment sentence only when paid at start', () => {
  const free = TOOLS.find((t) => t.name === 'get_threat_indicators').description;
  assert.match(free, /FREE while this feed holds no current data: no payment, no licence key, and it does not use the 5 free calls a day/);
  assert.doesNotMatch(free, /Payment required/);
  const paid = execFileSync(process.execPath, ['--input-type=module', '-e',
    "const { TOOLS } = await import('./api/mcp.mjs'); process.stdout.write(TOOLS.find((t) => t.name === 'get_threat_indicators').description);"
  ], { cwd: ROOT, env: { ...process.env, PG1_FEED_PAID: 'true', X402_PAY_TO_ADDRESS: '' }, encoding: 'utf8' });
  assert.match(paid, /Payment required: \$0\.01 via x402/);
  assert.doesNotMatch(paid, /FREE while this feed/);
});

test('discovery and docs: the feed is not advertised as paid, and every doc says it is free', () => {
  const wellKnown = JSON.parse(read('public/.well-known/x402'));
  assert.ok(!wellKnown.resources.some((r) => r.resource.endsWith('/api/ioc')), '/.well-known/x402 lists no /api/ioc');
  const openapi = JSON.parse(read('public/openapi.json'));
  for (const method of ['get', 'post']) {
    const op = openapi.paths['/api/ioc'][method];
    assert.equal(op['x-payment-info'], undefined, method);
    assert.deepEqual(op.security, [], method);
    assert.match(op.description, /FREE while the feed holds no current data/, method);
  }
  for (const rel of ['README.md', 'public/llms.txt', 'public/docs/agents/index.html', 'public/about/index.html', 'docs/payment-test-plan.md']) {
    assert.match(read(rel), /PG1_FEED_PAID/, `${rel} names the switch`);
    assert.match(read(rel), /free while (it|the feed) holds no current data/i, `${rel} says the feed is free`);
  }
});
