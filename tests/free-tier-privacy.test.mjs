/**
 * No raw IP address is written anywhere by the free tier (EU operator):
 * free_tier_usage is keyed by the caller IP's salted HMAC (lib/freeTier.mjs
 * freeTierKey = lib/telemetry.mjs callerHash), api_access_logs records a
 * free-tier caller by that hash, the settlement log line shows only a hash
 * prefix, and telemetry carries only caller_hash. Rows older than 7 days
 * are deleted by the daily cleanup cron.
 *
 * Every request leaving the process (URL and body) and every console line
 * is captured while a caller with a distinctive IP uses the free tier on
 * /api/mcp, /api/a2a and /api/ioc (up to and past the 5/day limit) and
 * asks get_usage_status; the IP must appear in none of them.
 *
 * Run with: node --test tests/free-tier-privacy.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import util from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function baseEnv() {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.TELEMETRY_IP_SALT = 'privacy-test-salt';
  process.env.CRON_SECRET = 'privacy-cron-secret';
  delete process.env.X402_PAY_TO_ADDRESS;
  delete process.env.GUMROAD_PRODUCT_ID;
}
baseEnv();

const { default: mcpHandler } = await import('../api/mcp.mjs');
const { default: a2aHandler } = await import('../api/a2a.mjs');
const { default: chatHandler } = await import('../api/chat.mjs');
const { default: cleanupHandler } = await import('../api/errors/cleanup.mjs');
const { FREE_TIER_DAILY_LIMIT, FREE_TIER_RETENTION_DAYS, freeTierKey, purgeExpiredFreeTierUsage } = await import('../lib/freeTier.mjs');
const { callerHash } = await import('../lib/telemetry.mjs');

const IP = '198.51.100.173';
const HASH = /^[0-9a-f]{32}$/;

let captured;
let counters;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function installFetch() {
  captured = [];
  counters = new Map();
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = (options.method || 'GET').toUpperCase();
    captured.push({ url: String(input), method, body: options.body == null ? '' : String(options.body) });
    if (url.hostname === 'services.nvd.nist.gov') return json({ vulnerabilities: [{ cve: { id: 'CVE-2021-44228', published: '2021-12-10T00:00:00Z', descriptions: [{ lang: 'en', value: 'x' }], metrics: {} } }] });
    if (url.hostname === 'www.cisa.gov') return json({ vulnerabilities: [] });
    if (url.pathname === '/rest/v1/free_tier_usage') {
      const id = (url.searchParams.get('identifier') || '').replace(/^eq\./, '');
      if (method === 'GET') return json(counters.has(id) ? [{ request_count: counters.get(id) }] : []);
      if (method === 'PATCH') { counters.set(id, JSON.parse(options.body).request_count); return new Response(null, { status: 204 }); }
      if (method === 'POST') { const b = JSON.parse(options.body); counters.set(b.identifier, b.request_count); return new Response(null, { status: 201 }); }
      if (method === 'DELETE') return new Response(null, { status: 204 });
    }
    if (url.pathname === '/rest/v1/threat_ioc_telemetry') return json([{ indicator_type: 'CVE', value: 'CVE-2021-44228', confidence_score: 90, last_seen: '2026-10-01T00:00:00Z', ingested_at: '2026-10-01T00:00:00Z', verification_source: 'NVD' }]);
    if (url.pathname.startsWith('/rest/v1/')) return method === 'GET' ? json([]) : new Response(null, { status: 201 });
    throw new Error(`unexpected fetch: ${url.hostname}${url.pathname}`);
  };
}

const logLines = [];
const originalConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
for (const level of Object.keys(originalConsole)) {
  console[level] = (...args) => { logLines.push(util.format(...args)); };
}

beforeEach(() => { baseEnv(); installFetch(); logLines.length = 0; });
after(() => {
  Object.assign(console, originalConsole);
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
});

function makeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    end(b) { if (typeof b === 'string') { try { this.body = JSON.parse(b); } catch { this.body = b; } } return this; }
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const mcp = (name, args) => mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': IP }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }, makeRes());
const a2a = () => a2aHandler({ method: 'POST', headers: { 'x-forwarded-for': `${IP}, 10.0.0.1` }, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm', parts: [{ kind: 'data', data: { skill: 'get_cve_details', arguments: { cve_id: 'CVE-2021-44228' } } }] } } } }, makeRes());
const ioc = () => chatHandler({ method: 'GET', url: '/api/ioc', headers: { 'x-forwarded-for': IP }, socket: { remoteAddress: IP }, body: null }, makeRes());

function assertNoRawIp(label) {
  for (const c of captured) {
    assert.ok(!c.url.includes(IP), `${label}: IP in a request URL: ${c.method} ${c.url}`);
    assert.ok(!c.body.includes(IP), `${label}: IP in a request body: ${c.method} ${c.url}`);
  }
  for (const line of logLines) assert.ok(!line.includes(IP), `${label}: IP in a log line: ${line}`);
}

test('freeTierKey is the telemetry caller hash: 32 hex, never the IP, none without an IP', () => {
  assert.match(freeTierKey(IP), HASH);
  assert.equal(freeTierKey(IP), callerHash(IP));
  assert.notEqual(freeTierKey(IP), IP);
  for (const none of ['', 'unknown', undefined, null]) assert.equal(freeTierKey(none), null, String(none));
});

test('a caller spending its free tier on MCP, A2A and /api/ioc, then hitting the limit, never has its IP written or logged', async () => {
  await mcp('get_cve_details', { cve_id: 'CVE-2021-44228' });
  await a2a();
  await ioc();
  await mcp('get_cve_details', { cve_id: 'CVE-2021-44228' });
  await a2a();
  // Past the limit, on every route.
  await mcp('get_cve_details', { cve_id: 'CVE-2021-44228' });
  await a2a();
  await ioc();
  await mcp('get_usage_status', {});
  await settle();

  const key = freeTierKey(IP);
  assert.equal(counters.get(key), FREE_TIER_DAILY_LIMIT, 'the counter is keyed by the hash');
  assert.deepEqual([...counters.keys()], [key]);

  const writes = captured.filter((c) => c.url.includes('/rest/v1/free_tier_usage') && c.method !== 'GET');
  assert.ok(writes.length >= FREE_TIER_DAILY_LIMIT);
  for (const w of writes) {
    if (w.method === 'POST') assert.match(JSON.parse(w.body).identifier, HASH);
    if (w.method === 'PATCH') assert.match(w.url, /identifier=eq\.[0-9a-f]{32}&/);
  }

  const accessLog = captured.find((c) => c.url.includes('/rest/v1/api_access_logs'));
  assert.ok(accessLog, '/api/ioc logged its free-tier access');
  assert.equal(JSON.parse(accessLog.body).license_key, `free-tier:${key}`);

  const telemetry = captured.filter((c) => c.url.includes('/rest/v1/agent_telemetry'));
  assert.ok(telemetry.length > 0);
  for (const t of telemetry) assert.match(JSON.parse(t.body).caller_hash, HASH);

  assert.ok(logLines.some((l) => l.includes('[X402_SETTLEMENT]') && l.includes(`caller=${key.slice(0, 12)}`)), 'the settlement line names the caller by a hash prefix');
  assertNoRawIp('free tier');
});

test('no IP at all: no free tier, and nothing written under a shared "unknown" key', async () => {
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_cve_details', arguments: { cve_id: 'CVE-2021-44228' } } } }, res);
  assert.equal(res.body.result.isError, true, 'payment challenge, not a free call');
  assert.equal(captured.filter((c) => c.url.includes('/rest/v1/free_tier_usage')).length, 0);
});

test(`rows older than ${FREE_TIER_RETENTION_DAYS} days are deleted by the daily cleanup cron`, async () => {
  const now = Date.parse('2026-10-16T03:00:00Z');
  const direct = await purgeExpiredFreeTierUsage({ now });
  assert.deepEqual(direct, { ok: true, cutoff: '2026-10-09' });
  assert.ok(captured.some((c) => c.method === 'DELETE' && c.url.endsWith('/rest/v1/free_tier_usage?usage_date=lt.2026-10-09')));

  captured.length = 0;
  const res = makeRes();
  await cleanupHandler({ method: 'GET', headers: { authorization: 'Bearer privacy-cron-secret' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.free_tier.ok, true);
  assert.ok(captured.some((c) => c.method === 'DELETE' && /\/rest\/v1\/free_tier_usage\?usage_date=lt\.\d{4}-\d{2}-\d{2}$/.test(c.url)));
});

test('the migration resets raw-IP rows and makes free_tier_usage accept only hashes', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261016120000_free_tier_usage_hashed.sql'), 'utf8');
  assert.match(sql, /delete from public\.free_tier_usage where identifier !~ '\^\[0-9a-f\]\{32\}\$';/);
  assert.match(sql, /add constraint free_tier_usage_identifier_hashed check \(identifier ~ '\^\[0-9a-f\]\{32\}\$'\)/);
  assert.match(sql, /delete from public\.api_access_logs\s+where license_key like 'free-tier:%'/);
});

test('no code path builds a free_tier_usage key or an api_access_logs free-tier label from the raw IP', () => {
  const freeTier = fs.readFileSync(path.join(ROOT, 'lib/freeTier.mjs'), 'utf8');
  assert.doesNotMatch(freeTier, /identifier: identifier/);
  assert.doesNotMatch(freeTier, /identifier=eq\.\$\{encodeURIComponent\(identifier\)\}/);
  const chat = fs.readFileSync(path.join(ROOT, 'api/chat.mjs'), 'utf8');
  assert.doesNotMatch(chat, /'free-tier:' \+ iocRequestIdentifier/);
  const mcpSrc = fs.readFileSync(path.join(ROOT, 'api/mcp.mjs'), 'utf8');
  assert.doesNotMatch(mcpSrc, /free_tier_usage\?identifier=eq\.\$\{encodeURIComponent\(identifier\)\}/);
});
