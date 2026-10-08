/**
 * check_ip_abuse (1.16.0): bring-your-own-key AbuseIPDB lookups over
 * /api/mcp and /api/a2a (lib/abuseIpdb.mjs).
 *
 * The agreement with AbuseIPDB (2026-10-06) is tested as hard rules:
 * the customer's own key only, from the X-AbuseIPDB-Key header only (never
 * an env key, never a fallback, never a tool argument); results only to that
 * customer, with attribution; cache per key only, in memory, 15 minutes,
 * never holding a raw key; no header, no AbuseIPDB call. Plus: the 14
 * pre-existing tools are unchanged, the key never reaches logs, pg1_errors,
 * responses or traces, and results never reach the threat feed or any other
 * customer.
 *
 * Every AbuseIPDB response here is synthetic (stubbed global fetch). No test
 * ever contacts AbuseIPDB.
 *
 * Run with: node --test tests/check-ip-abuse.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.X402_PAY_TO_ADDRESS = '0x1111111111111111111111111111111111111111';
const mcp = await import('../api/mcp.mjs');
const { default: mcpHandler, TOOLS, __setX402FacilitatorForTests } = mcp;
const { default: a2aHandler, A2A_SKILL_TOOLS } = await import('../api/a2a.mjs');
const abuse = await import('../lib/abuseIpdb.mjs');
const { GEMINI_SCHEMA_KEYS, toGeminiSchema, chatToolsForRole, CHAT_TOOL_ROLES } = await import('../lib/chatTools.mjs');
const { PLAYGROUND_TOOLS } = await import('../lib/playground.mjs');
const { stripSecrets } = await import('../lib/handoff.mjs');
const { TEST_FIXTURES } = await import('../lib/fixtures.mjs');

let facilitatorCalls = 0;
__setX402FacilitatorForTests(() => {
  facilitatorCalls += 1;
  throw new Error('facilitator spy: payment gate reached');
});

// Synthetic keys in the 80-hex-character AbuseIPDB format, built at runtime.
const hex80 = (seed) => (crypto.createHash('sha256').update(`pg1-test-fixture-${seed}`).digest('hex') +
  crypto.createHash('sha256').update(`pg1-test-fixture-${seed}-2`).digest('hex')).slice(0, 80);
const KEY_A = hex80('customer-a');
const KEY_B = hex80('customer-b');

const PUBLIC_IP = '8.8.8.8';
const tool = TOOLS.find((t) => t.name === 'check_ip_abuse');

// Synthetic upstream body, labelled as such. Never real AbuseIPDB data.
function upstreamBody(overrides = {}) {
  return {
    data: {
      ipAddress: PUBLIC_IP, isPublic: true, ipVersion: 4, isWhitelisted: false,
      abuseConfidenceScore: 73, countryCode: 'ZZ', usageType: 'test_fixture usage', isp: 'test_fixture ISP',
      domain: 'pg1-test.invalid', hostnames: ['test-fixture.pg1-test.invalid'], isTor: false,
      totalReports: 12, numDistinctUsers: 5, lastReportedAt: '2026-10-01T12:00:00+00:00',
      reports: [{ comment: 'test_fixture upstream-only-marker' }],
      ...overrides
    }
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
}

let ipCounter = 0;
// Each test gets its own caller IP unless one is given, so the 60/hour limit
// never leaks between tests.
function freshCallerIp() {
  ipCounter += 1;
  return `100.${Math.floor(ipCounter / 250)}.${ipCounter % 250}.9`;
}

async function callMcp(args, { key, callerIp = freshCallerIp(), extraHeaders = {} } = {}) {
  const headers = { 'x-forwarded-for': callerIp, ...extraHeaders };
  if (key !== undefined) headers['x-abuseipdb-key'] = key;
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_ip_abuse', arguments: args } } }, res);
  return res;
}

async function callA2a(args, { key, callerIp = freshCallerIp() } = {}) {
  const headers = { 'x-forwarded-for': callerIp };
  if (key !== undefined) headers['x-abuseipdb-key'] = key;
  const res = makeRes();
  await a2aHandler({
    method: 'POST', headers, query: {},
    body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { skill: 'check_ip_abuse', arguments: args } }] } } }
  }, res);
  return res;
}

const mcpPayload = (res) => JSON.parse(res.body.result.content[0].text);
const a2aResult = (res) => res.body.result.artifacts[0].parts[0].data;

// Records every request (AbuseIPDB, Supabase tables, telemetry, error log)
// and answers AbuseIPDB with `upstream` (a function of the call).
function spyFetch(t, upstream = () => ({ status: 200, body: upstreamBody() })) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (u.startsWith('https://api.abuseipdb.com/')) {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const r = await upstream({ url: u, opts });
      if (r.throw) throw r.throw;
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: new Headers(r.headers || {}),
        json: async () => (r.rawText !== undefined ? JSON.parse(r.rawText) : r.body),
        text: async () => (r.rawText !== undefined ? r.rawText : JSON.stringify(r.body))
      };
    }
    if (u.includes('/rest/v1/pg1_errors')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (u.includes('/rest/v1/threat_ioc_telemetry')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (u.includes('api.gumroad.com')) {
      return { ok: true, status: 200, json: async () => ({ success: false, message: 'not a licence' }) };
    }
    return { ok: true, status: 201, json: async () => ({}), text: async () => '' };
  };
  t.after(() => { global.fetch = original; });
  const abuseCalls = () => calls.filter((c) => c.url.startsWith('https://api.abuseipdb.com/'));
  return { calls, abuseCalls };
}

function withEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

function withSupabase(t) {
  withEnv(t, { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key' });
}

// Captures everything written to the console while `fn` runs.
async function captureConsole(fn) {
  const lines = [];
  const saved = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[m] = console[m];
    console[m] = (...args) => { lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join('\n');
}

// Lets fire-and-forget writes (telemetry, pg1_errors) finish.
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  abuse.__clearAbuseIpdbCacheForTests();
  facilitatorCalls = 0;
});

// ---------------------------------------------------------------------
// Registry drift: the 14 pre-existing tools are unchanged
// ---------------------------------------------------------------------

test('the 14 pre-existing MCP tools are byte-identical to the 1.15.0 snapshot (names, descriptions, schemas, order)', () => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/existing-14-tools-snapshot.json'), 'utf8'));
  assert.equal(snapshot.length, 14);
  assert.deepEqual(TOOLS.slice(0, 14), snapshot);
  // 16 since check_package joined 1.16.0, after check_ip_abuse.
  assert.equal(TOOLS.length, 16);
  assert.equal(TOOLS[14].name, 'check_ip_abuse');
  assert.equal(TOOLS[15].name, 'check_package');
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length, 'no name clash');
  const sha = crypto.createHash('sha256').update(JSON.stringify(TOOLS.slice(0, 14))).digest('hex');
  assert.equal(sha, 'a177e3276b64a976e1b3a8412e77418e7846bf532379c8c9129882aff3488f06');
});

test('the 5 pre-existing A2A skills are unchanged; check_ip_abuse is added as the 6th, with the MCP definition', () => {
  const names = A2A_SKILL_TOOLS.map((t) => t.name);
  assert.deepEqual(names.filter((n) => n !== 'check_ip_abuse' && n !== 'check_package').sort(), ['check_domain_age', 'check_hostname_reputation', 'check_wallet_age', 'check_wallet_sanctions', 'get_usage_status']);
  assert.ok(names.includes('check_ip_abuse'));
  assert.equal(A2A_SKILL_TOOLS.find((t) => t.name === 'check_ip_abuse'), tool);
});

// ---------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------

test('definition: the key is never an argument; ip required, max_age_in_days optional 1-365', () => {
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['ip', 'max_age_in_days']);
  assert.deepEqual(tool.inputSchema.required, ['ip']);
  assert.equal(tool.inputSchema.properties.max_age_in_days.minimum, 1);
  assert.equal(tool.inputSchema.properties.max_age_in_days.maximum, 365);
  assert.doesNotMatch(JSON.stringify(tool.inputSchema), /key/i);
  assert.match(tool.description, /X-AbuseIPDB-Key/);
  assert.match(tool.description, /never as a tool argument/);
  for (const code of ['abuseipdb_key_required', 'invalid_abuseipdb_key', 'abuseipdb_rate_limited', 'upstream_unavailable', 'invalid_ip']) {
    assert.match(tool.description, new RegExp(code));
  }
});

test('outputSchema declares every agreed field, and attribution is required', () => {
  const props = tool.outputSchema.properties;
  for (const f of ['ip', 'abuse_confidence_score', 'total_reports', 'distinct_reporters', 'last_reported_at', 'country_code', 'usage_type', 'isp', 'domain', 'is_tor', 'is_whitelisted', 'status', 'reasons', 'checks', 'request_id', 'attribution']) {
    assert.ok(props[f], f);
  }
  assert.ok(tool.outputSchema.required.includes('attribution'));
  for (const f of ['status', 'reasons', 'checks', 'request_id', 'test_fixture']) assert.ok(!tool.outputSchema.required.includes(f), f);
});

// Every keyword in a schema, walking properties/items/anyOf (property names
// themselves are not keywords).
function schemaKeywords(schema, out = new Set()) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return out;
  for (const [k, v] of Object.entries(schema)) {
    out.add(k);
    if (k === 'properties') for (const p of Object.values(v)) schemaKeywords(p, out);
    else if (k === 'items') schemaKeywords(v, out);
    else if (k === 'anyOf') for (const p of v) schemaKeywords(p, out);
  }
  return out;
}

test('input and output schemas use only Gemini-allowlisted keywords (#262), so toGeminiSchema drops nothing', () => {
  for (const [label, schema] of [['inputSchema', tool.inputSchema], ['outputSchema', tool.outputSchema]]) {
    const unknown = [...schemaKeywords(schema)].filter((k) => !GEMINI_SCHEMA_KEYS.has(k));
    assert.deepEqual(unknown, [], `${label} keywords outside GEMINI_SCHEMA_KEYS`);
    const gem = toGeminiSchema(schema);
    assert.deepEqual(Object.keys(gem.properties), Object.keys(schema.properties), label);
    assert.deepEqual(gem.required, schema.required, label);
    assert.deepEqual(Object.keys(gem.properties.attribution?.properties || {}), Object.keys(schema.properties.attribution?.properties || {}), label);
    assert.ok(!JSON.stringify(gem).includes('"null"'), `${label}: no null type survives`);
  }
});

test('the chat (every role) and the playground never offer check_ip_abuse', () => {
  for (const role of [...Object.keys(CHAT_TOOL_ROLES), 'anything-else']) {
    assert.ok(!chatToolsForRole(role, { video: true }).some((t) => t.name === 'check_ip_abuse'), role);
  }
  assert.ok(!PLAYGROUND_TOOLS.includes('check_ip_abuse'));
  assert.ok(!Object.keys(mcp.READ_ONLY_TOOL_RUNNERS).includes('check_ip_abuse'));
});

// ---------------------------------------------------------------------
// Key supply: header only, no env key, no fallback
// ---------------------------------------------------------------------

test('no X-AbuseIPDB-Key header: abuseipdb_key_required, explains how to supply one, AbuseIPDB never contacted (MCP and A2A)', async (t) => {
  withSupabase(t);
  const { abuseCalls } = spyFetch(t);
  for (const missing of [undefined, '', '   ']) {
    const res = await callMcp({ ip: PUBLIC_IP }, { key: missing });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.result.isError, true);
    const p = mcpPayload(res);
    assert.equal(p.code, 'abuseipdb_key_required');
    assert.match(p.message, /X-AbuseIPDB-Key/);
    assert.match(p.message, /header/);
    assert.equal(p.status, 'unknown');
    assert.equal(p.checks[0].result, 'skipped');

    const a = await callA2a({ ip: PUBLIC_IP }, { key: missing });
    assert.equal(a.body.error.code, -32000);
    assert.equal(a.body.error.data.code, 'abuseipdb_key_required');
    assert.match(a.body.error.message, /X-AbuseIPDB-Key/);
  }
  assert.equal(abuseCalls().length, 0);
});

test('PG1 never uses an AbuseIPDB key from the environment, and a key in the arguments is ignored', async (t) => {
  withSupabase(t);
  withEnv(t, { ABUSEIPDB_API: KEY_B, ABUSEIPDB_API_KEY: KEY_B, ABUSEIPDB_KEY: KEY_B });
  const { abuseCalls } = spyFetch(t);
  const res = await callMcp({ ip: PUBLIC_IP, key: KEY_B, abuseipdb_key: KEY_B, api_key: KEY_B });
  assert.equal(mcpPayload(res).code, 'abuseipdb_key_required');
  assert.equal(abuseCalls().length, 0);
  // With a header, the header's key is the only one ever sent.
  await callMcp({ ip: PUBLIC_IP, key: KEY_B }, { key: KEY_A });
  assert.equal(abuseCalls().length, 1);
  assert.equal(abuseCalls()[0].opts.headers.Key, KEY_A);
  const src = fs.readFileSync(path.join(ROOT, 'lib/abuseIpdb.mjs'), 'utf8');
  assert.doesNotMatch(src, /process\.env/, 'lib/abuseIpdb.mjs never reads the environment');
});

test('a header value that cannot be a key is invalid_abuseipdb_key without calling AbuseIPDB', async (t) => {
  withSupabase(t);
  const { abuseCalls } = spyFetch(t);
  for (const bad of ['has space inside', 'x'.repeat(300), 'tab\there']) {
    const res = await callMcp({ ip: PUBLIC_IP }, { key: bad });
    assert.equal(mcpPayload(res).code, 'invalid_abuseipdb_key', JSON.stringify(bad).slice(0, 30));
  }
  assert.equal(abuseCalls().length, 0);
});

// ---------------------------------------------------------------------
// The call and the result
// ---------------------------------------------------------------------

test('calls GET /api/v2/check with Key + Accept headers, ipAddress and maxAgeInDays (default 90)', async (t) => {
  withSupabase(t);
  const { abuseCalls } = spyFetch(t);
  await callMcp({ ip: PUBLIC_IP }, { key: KEY_A });
  await callMcp({ ip: '2001:4860:4860::8888', max_age_in_days: 30 }, { key: KEY_A });
  const [first, second] = abuseCalls();
  const u1 = new URL(first.url);
  assert.equal(`${u1.origin}${u1.pathname}`, 'https://api.abuseipdb.com/api/v2/check');
  assert.equal(first.opts.method, 'GET');
  assert.deepEqual(first.opts.headers, { Key: KEY_A, Accept: 'application/json' });
  assert.deepEqual(Object.fromEntries(u1.searchParams), { ipAddress: PUBLIC_IP, maxAgeInDays: '90' });
  assert.deepEqual(Object.fromEntries(new URL(second.url).searchParams), { ipAddress: '2001:4860:4860::8888', maxAgeInDays: '30' });
  assert.ok(!first.url.includes(KEY_A), 'the key is never in the URL');
});

test('result: agreed fields, attribution with link, structuredContent, flagged on reports - never "safe" or "clean"', async (t) => {
  withSupabase(t);
  spyFetch(t);
  const res = await callMcp({ ip: PUBLIC_IP }, { key: KEY_A });
  assert.equal(res.body.result.isError, undefined);
  const p = mcpPayload(res);
  assert.deepEqual(res.body.result.structuredContent, p);
  assert.equal(p.ip, PUBLIC_IP);
  assert.equal(p.ip_version, 4);
  assert.equal(p.max_age_in_days, 90);
  assert.equal(p.abuse_confidence_score, 73);
  assert.equal(p.total_reports, 12);
  assert.equal(p.distinct_reporters, 5);
  assert.equal(p.last_reported_at, '2026-10-01T12:00:00.000Z');
  assert.equal(p.country_code, 'ZZ');
  assert.equal(p.usage_type, 'test_fixture usage');
  assert.equal(p.isp, 'test_fixture ISP');
  assert.equal(p.domain, 'pg1-test.invalid');
  assert.equal(p.is_tor, false);
  assert.equal(p.is_whitelisted, false);
  assert.equal(p.cached, false);
  assert.deepEqual(p.attribution, { text: 'Data from AbuseIPDB', url: 'https://www.abuseipdb.com/check/8.8.8.8' });
  assert.equal(p.status, 'flagged');
  assert.deepEqual(p.reasons.map((r) => r.code), ['IP_ABUSE_REPORTED']);
  assert.equal(p.checks.length, 1);
  assert.equal(p.checks[0].result, 'ok');
  assert.doesNotMatch(p.checks[0].source, /abuseipdb/i, 'checks[].source stays a generic label');
  assert.equal(p.request_id, res.headers['X-Request-Id']);
  // Upstream-only fields (hostnames, reports) are dropped.
  assert.ok(!JSON.stringify(p).includes('upstream-only-marker'));
  assert.equal(p.hostnames, undefined);
  for (const key of Object.keys(p)) assert.ok(key in tool.outputSchema.properties, `${key} is declared in outputSchema`);
  for (const key of tool.outputSchema.required) assert.ok(key in p, `${key} present`);
  assert.doesNotMatch(JSON.stringify(p), /\bsafe\b|\bclean\b/i);
});

const SCORE_NOTE = "abuse_confidence_score is AbuseIPDB's 0-100 confidence that the address is abusive. A score of 0 is not proof the address is harmless.";

test('no reports: status no_flags with the score note; a Tor exit is informational', async (t) => {
  withSupabase(t);
  spyFetch(t, () => ({ status: 200, body: upstreamBody({ abuseConfidenceScore: 0, totalReports: 0, numDistinctUsers: 0, lastReportedAt: null, isTor: true }) }));
  const p = mcpPayload(await callMcp({ ip: PUBLIC_IP }, { key: KEY_A }));
  assert.equal(p.status, 'no_flags');
  assert.deepEqual(p.reasons.map((r) => r.code), ['IP_TOR_EXIT_NODE']);
  assert.equal(p.last_reported_at, null);
  assert.equal(p.note, SCORE_NOTE);
  assert.doesNotMatch(JSON.stringify(p), /\bsafe\b|\bclean\b/i);
  assert.equal(p.attribution.text, 'Data from AbuseIPDB');
});

test('8.8.8.8 as AbuseIPDB returns it (score 0, 226 reports, whitelisted): no_flags with IP_WHITELISTED, never flagged', async (t) => {
  withSupabase(t);
  spyFetch(t, () => ({ status: 200, body: upstreamBody({ abuseConfidenceScore: 0, totalReports: 226, numDistinctUsers: 61, isWhitelisted: true, lastReportedAt: '2026-10-06T21:14:03+00:00' }) }));
  const p = mcpPayload(await callMcp({ ip: PUBLIC_IP }, { key: KEY_A }));
  assert.equal(p.abuse_confidence_score, 0);
  assert.equal(p.total_reports, 226);
  assert.equal(p.is_whitelisted, true);
  assert.equal(p.status, 'no_flags');
  assert.deepEqual(p.reasons.map((r) => r.code), ['IP_WHITELISTED']);
  assert.equal(p.reasons[0].message, 'AbuseIPDB marks this address as whitelisted; it has 226 report(s) in the last 90 day(s), which AbuseIPDB does not count against it.');
  assert.equal(p.note, SCORE_NOTE);
  assert.equal(p.checks[0].result, 'ok');
  assert.equal(p.checks[0].data_as_of, '2026-10-06T21:14:03.000Z');
  assert.doesNotMatch(JSON.stringify(p), /\bsafe\b|\bclean\b/i);
});

test('whitelisted wins over a score above 0: still no_flags with IP_WHITELISTED', async (t) => {
  withSupabase(t);
  spyFetch(t, () => ({ status: 200, body: upstreamBody({ abuseConfidenceScore: 40, isWhitelisted: true, isTor: true }) }));
  const p = mcpPayload(await callMcp({ ip: PUBLIC_IP }, { key: KEY_A }));
  assert.equal(p.status, 'no_flags');
  assert.deepEqual(p.reasons.map((r) => r.code), ['IP_WHITELISTED', 'IP_TOR_EXIT_NODE']);
});

test('score 75, not whitelisted: flagged, IP_ABUSE_REPORTED with score, report and reporter counts', async (t) => {
  withSupabase(t);
  spyFetch(t, () => ({ status: 200, body: upstreamBody({ abuseConfidenceScore: 75, totalReports: 30, numDistinctUsers: 9 }) }));
  const p = mcpPayload(await callMcp({ ip: PUBLIC_IP }, { key: KEY_A }));
  assert.equal(p.status, 'flagged');
  assert.deepEqual(p.reasons.map((r) => r.code), ['IP_ABUSE_REPORTED']);
  assert.equal(p.reasons[0].message, 'IP address has an abuse confidence score of 75, from 30 abuse report(s) by 9 distinct reporter(s) in the last 90 day(s).');
  assert.equal(p.note, SCORE_NOTE);
  assert.equal(p.checks[0].data_as_of, '2026-10-01T12:00:00.000Z');
});

test('score 0 with reports, not whitelisted: no_flags with informational IP_REPORTS_SCORED_ZERO', async (t) => {
  withSupabase(t);
  spyFetch(t, () => ({ status: 200, body: upstreamBody({ abuseConfidenceScore: 0, totalReports: 3, numDistinctUsers: 2 }) }));
  const p = mcpPayload(await callMcp({ ip: PUBLIC_IP }, { key: KEY_A }));
  assert.equal(p.status, 'no_flags');
  assert.deepEqual(p.reasons.map((r) => r.code), ['IP_REPORTS_SCORED_ZERO']);
  assert.equal(p.reasons[0].message, 'IP address has 3 abuse report(s) from 2 distinct reporter(s) in the last 90 day(s), but AbuseIPDB scores them 0, so it is not flagged.');
  assert.equal(p.note, SCORE_NOTE);
});

test('an answer missing the score or report count is status unknown, never no_flags', async (t) => {
  withSupabase(t);
  spyFetch(t, () => ({ status: 200, body: { data: { ipAddress: PUBLIC_IP } } }));
  const p = mcpPayload(await callMcp({ ip: PUBLIC_IP }, { key: KEY_A }));
  assert.equal(p.status, 'unknown');
  assert.equal(p.checks[0].result, 'error');
  assert.equal(p.abuse_confidence_score, null);
});

test('A2A: same result as a completed Task, with attribution', async (t) => {
  withSupabase(t);
  spyFetch(t);
  const res = await callA2a({ ip: PUBLIC_IP }, { key: KEY_A });
  assert.equal(res.statusCode, 200);
  const r = a2aResult(res);
  assert.equal(r.abuse_confidence_score, 73);
  assert.deepEqual(r.attribution, { text: 'Data from AbuseIPDB', url: 'https://www.abuseipdb.com/check/8.8.8.8' });
  assert.equal(r.request_id, res.headers['X-Request-Id']);
});

// ---------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------

const INVALID_IPS = [
  '10.0.0.1', '172.16.5.4', '192.168.1.1', '127.0.0.1', '0.0.0.0', '169.254.1.1', '100.64.0.1', '224.0.0.1',
  '255.255.255.255', '240.0.0.1', '198.18.0.1', '192.0.2.55', '198.51.100.77', '203.0.113.99', '192.0.0.8',
  '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::5', '::ffff:8.8.8.8', '64:ff9b::808:808',
  'fe80::1%eth0', '[2001:4860:4860::8888]', '8.8.8.8:53', '8.8.8.0/24', '8.8.8', '8.8.8.8.8', '999.1.1.1',
  'example.com', '', '   ', '8.8.8.8, 1.1.1.1', '8.8.8.8 1.1.1.1', 'x'.repeat(100)
];

test('private, reserved or malformed input is invalid_ip, never calls AbuseIPDB, never echoes the input', async (t) => {
  withSupabase(t);
  const { abuseCalls } = spyFetch(t);
  for (const ip of [...INVALID_IPS, 42, null, ['8.8.8.8']]) {
    const res = await callMcp({ ip }, { key: KEY_A });
    const p = mcpPayload(res);
    assert.equal(res.body.result.isError, true, String(ip));
    assert.equal(p.code, 'invalid_ip', String(ip));
    const withoutExample = p.message.replace('Example: 8.8.8.8.', '');
    if (typeof ip === 'string' && ip.trim().length > 3) assert.ok(!withoutExample.includes(ip.trim()), `echoed ${ip}`);
    assert.match(p.message, /Example: 8\.8\.8\.8/);
  }
  const a = await callA2a({ ip: '10.0.0.1' }, { key: KEY_A });
  assert.equal(a.body.error.data.code, 'invalid_ip');
  assert.equal(abuseCalls().length, 0);
});

test('public IPv4 and IPv6 addresses are accepted; IPv6 is canonicalised', () => {
  assert.deepEqual(abuse.normalizePublicIp(' 8.8.8.8 '), { ip: '8.8.8.8', version: 4 });
  assert.deepEqual(abuse.normalizePublicIp('1.1.1.1'), { ip: '1.1.1.1', version: 4 });
  assert.deepEqual(abuse.normalizePublicIp('2001:4860:4860:0000:0000:0000:0000:8888'), { ip: '2001:4860:4860::8888', version: 6 });
  assert.deepEqual(abuse.normalizePublicIp('2606:4700:4700::1111'), { ip: '2606:4700:4700::1111', version: 6 });
});

test('max_age_in_days outside 1-365 is invalid_max_age, without calling AbuseIPDB', async (t) => {
  withSupabase(t);
  const { abuseCalls } = spyFetch(t);
  for (const days of [0, 366, -1, 1.5, 'ninety', true]) {
    const p = mcpPayload(await callMcp({ ip: PUBLIC_IP, max_age_in_days: days }, { key: KEY_A }));
    assert.equal(p.code, 'invalid_max_age', String(days));
  }
  assert.equal(abuseCalls().length, 0);
  for (const days of [1, 365, null, undefined]) abuse.normalizeMaxAgeDays(days);
  assert.equal(abuse.normalizeMaxAgeDays(undefined), 90);
});

// ---------------------------------------------------------------------
// Upstream errors, and what reaches pg1_errors
// ---------------------------------------------------------------------

function errorLogRows(calls) {
  return calls
    .filter((c) => c.url.includes('/rest/v1/pg1_errors') && c.opts.body)
    .map((c) => JSON.parse(c.opts.body));
}

const ERROR_CASES = [
  { label: '401', upstream: { status: 401, body: { errors: [{ detail: 'Authentication failed. upstream-body-marker' }] } }, code: 'invalid_abuseipdb_key', logReason: 'check_ip_abuse_invalid_key' },
  { label: '403', upstream: { status: 403, body: { errors: [{ detail: 'upstream-body-marker' }] } }, code: 'invalid_abuseipdb_key', logReason: 'check_ip_abuse_invalid_key' },
  { label: '429', upstream: { status: 429, headers: { 'Retry-After': '3600' }, body: { errors: [{ detail: 'Daily rate limit exceeded upstream-body-marker' }] } }, code: 'abuseipdb_rate_limited', logReason: 'check_ip_abuse_upstream_rate_limited', retryAfter: 3600 },
  { label: '500', upstream: { status: 500, body: { errors: [{ detail: 'upstream-body-marker' }] } }, code: 'upstream_unavailable', logReason: 'check_ip_abuse_upstream_unavailable' },
  { label: '503', upstream: { status: 503, body: { html: '<html>upstream-body-marker</html>' } }, code: 'upstream_unavailable', logReason: 'check_ip_abuse_upstream_unavailable' },
  { label: 'bad JSON', upstream: { status: 200, rawText: '{not json upstream-body-marker' }, code: 'upstream_unavailable', logReason: 'check_ip_abuse_upstream_unavailable' },
  { label: 'network error', upstream: { throw: new Error('ECONNRESET upstream-body-marker') }, code: 'upstream_unavailable', logReason: 'check_ip_abuse_upstream_unavailable' }
];

for (const c of ERROR_CASES) {
  test(`AbuseIPDB ${c.label} -> ${c.code}; logged to pg1_errors without the key or the response body (MCP and A2A)`, async (t) => {
    withSupabase(t);
    const { calls } = spyFetch(t, () => c.upstream);
    let res, a;
    const consoleText = await captureConsole(async () => {
      res = await callMcp({ ip: PUBLIC_IP }, { key: KEY_A });
      a = await callA2a({ ip: PUBLIC_IP }, { key: KEY_A });
      await settle();
    });
    const p = mcpPayload(res);
    assert.equal(res.body.result.isError, true);
    assert.equal(p.code, c.code);
    assert.equal(p.status, 'unknown');
    assert.equal(a.body.error.data.code, c.code);
    if (c.retryAfter) {
      assert.equal(p.retry_after, c.retryAfter);
      assert.equal(res.headers['Retry-After'], String(c.retryAfter));
      assert.equal(a.body.error.data.retry_after, c.retryAfter);
      assert.equal(a.headers['Retry-After'], String(c.retryAfter));
    } else {
      assert.equal(p.retry_after, undefined);
    }
    const rows = errorLogRows(calls);
    assert.deepEqual(rows.map((r) => r.reason).sort(), [c.logReason, c.logReason]);
    assert.deepEqual(rows.map((r) => r.route).sort(), ['/api/a2a:check_ip_abuse', '/api/mcp:check_ip_abuse']);
    const everything = JSON.stringify({ rows, mcp: res.body, a2a: a.body, mcpHeaders: res.headers, a2aHeaders: a.headers, consoleText });
    assert.ok(!everything.includes(KEY_A), 'key leaked');
    assert.ok(!everything.includes('upstream-body-marker'), 'upstream body leaked');
    assert.ok(!JSON.stringify(rows).includes(PUBLIC_IP), 'caller input never in pg1_errors');
  });
}

test('a non-numeric Retry-After is dropped, never echoed', async (t) => {
  withSupabase(t);
  spyFetch(t, () => ({ status: 429, headers: { 'Retry-After': '<script>' }, body: {} }));
  const res = await callMcp({ ip: PUBLIC_IP }, { key: KEY_A });
  const p = mcpPayload(res);
  assert.equal(p.code, 'abuseipdb_rate_limited');
  assert.equal(p.retry_after, undefined);
  assert.equal(res.headers['Retry-After'], undefined);
});

test('AbuseIPDB timeout -> upstream_unavailable "timed out", logged as a timeout', async (t) => {
  withSupabase(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls } = spyFetch(t, ({ opts }) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const pending = callMcp({ ip: PUBLIC_IP }, { key: KEY_A });
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(abuse.ABUSEIPDB_TIMEOUT_MS);
  const res = await pending;
  t.mock.timers.reset();
  const p = mcpPayload(res);
  assert.equal(p.code, 'upstream_unavailable');
  assert.match(p.message, /timed out/);
  assert.equal(p.checks[0].result, 'timeout');
  await settle();
  assert.deepEqual(errorLogRows(calls).map((r) => [r.reason, r.category]), [['check_ip_abuse_timeout', 'timeout']]);
});

// ---------------------------------------------------------------------
// Cache: per key only, in memory, 15 minutes, no raw keys
// ---------------------------------------------------------------------

test('cache: same key + ip + max_age hits; another key, ip or max_age never does', async (t) => {
  withSupabase(t);
  const { abuseCalls } = spyFetch(t);
  const first = mcpPayload(await callMcp({ ip: PUBLIC_IP }, { key: KEY_A }));
  const again = mcpPayload(await callMcp({ ip: PUBLIC_IP }, { key: KEY_A }));
  assert.equal(abuseCalls().length, 1);
  assert.equal(first.cached, false);
  assert.equal(again.cached, true);
  assert.ok(again.checks[0].data_as_of, 'a cached answer says when it was fetched');
  assert.deepEqual(again.attribution, first.attribution);

  // Another customer, same IP: their own call, with their own key.
  const other = mcpPayload(await callMcp({ ip: PUBLIC_IP }, { key: KEY_B }));
  assert.equal(other.cached, false);
  assert.equal(abuseCalls().length, 2);
  assert.equal(abuseCalls()[1].opts.headers.Key, KEY_B);

  await callMcp({ ip: PUBLIC_IP, max_age_in_days: 30 }, { key: KEY_A });
  await callMcp({ ip: '1.1.1.1' }, { key: KEY_A });
  assert.equal(abuseCalls().length, 4);

  const keys = abuse.__cacheKeysForTests();
  assert.ok(keys.length >= 4);
  for (const k of keys) {
    assert.ok(!k.includes(KEY_A) && !k.includes(KEY_B), 'no raw key in the cache');
    assert.match(k, /^[0-9a-f]{64}\|/);
  }
  assert.ok(keys.includes(`${abuse.keyFingerprint(KEY_A)}|${PUBLIC_IP}|90`));
});

test('cache entries expire after 15 minutes', async (t) => {
  withSupabase(t);
  const { abuseCalls } = spyFetch(t);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  await callMcp({ ip: PUBLIC_IP }, { key: KEY_A });
  now += abuse.ABUSEIPDB_CACHE_TTL_MS - 1000;
  await callMcp({ ip: PUBLIC_IP }, { key: KEY_A });
  assert.equal(abuseCalls().length, 1);
  now += 2000;
  await callMcp({ ip: PUBLIC_IP }, { key: KEY_A });
  assert.equal(abuseCalls().length, 2);
  assert.equal(abuse.ABUSEIPDB_CACHE_TTL_MS, 15 * 60 * 1000);
});

test('errors are never cached', async (t) => {
  withSupabase(t);
  let status = 503;
  const { abuseCalls } = spyFetch(t, () => (status === 200 ? { status: 200, body: upstreamBody() } : { status }));
  assert.equal(mcpPayload(await callMcp({ ip: PUBLIC_IP }, { key: KEY_A })).code, 'upstream_unavailable');
  status = 200;
  assert.equal(mcpPayload(await callMcp({ ip: PUBLIC_IP }, { key: KEY_A })).cached, false);
  assert.equal(abuseCalls().length, 2);
});

test('nothing is stored in a database: the only Supabase writes are the usage telemetry row (no ip, no result, no key)', async (t) => {
  withSupabase(t);
  const { calls } = spyFetch(t);
  await callMcp({ ip: PUBLIC_IP }, { key: KEY_A });
  await callA2a({ ip: PUBLIC_IP }, { key: KEY_A });
  await settle();
  const supabase = calls.filter((c) => c.url.startsWith('https://example.supabase.co'));
  for (const c of supabase) {
    assert.match(c.url, /\/rest\/v1\/agent_telemetry$/, `unexpected Supabase request ${c.url}`);
    const body = String(c.opts.body || '');
    assert.doesNotMatch(body, /abuse_confidence_score|total_reports|pg1-test\.invalid|test_fixture ISP/);
    assert.ok(!body.includes(KEY_A));
    assert.ok(!body.includes(PUBLIC_IP));
  }
  assert.ok(supabase.length >= 2, 'one telemetry row per call');
});

// ---------------------------------------------------------------------
// Secrets: the key never appears anywhere but the AbuseIPDB request
// ---------------------------------------------------------------------

test('the key never appears in responses, response headers, console output, telemetry, pg1_errors or any other request', async (t) => {
  withSupabase(t);
  let mode = 'ok';
  const { calls } = spyFetch(t, () => (mode === 'ok' ? { status: 200, body: upstreamBody() } : { status: 401, body: { errors: [{ detail: KEY_A }] } }));
  const responses = [];
  const consoleText = await captureConsole(async () => {
    responses.push(await callMcp({ ip: PUBLIC_IP }, { key: KEY_A }));
    responses.push(await callA2a({ ip: '1.1.1.1' }, { key: KEY_A }));
    mode = 'bad';
    responses.push(await callMcp({ ip: '9.9.9.9' }, { key: KEY_A }));
    responses.push(await callA2a({ ip: '9.9.9.10' }, { key: KEY_A }));
    responses.push(await callMcp({ ip: '10.0.0.1' }, { key: KEY_A }));
    await settle();
  });
  for (const r of responses) {
    assert.ok(!JSON.stringify(r.body).includes(KEY_A), 'response body');
    assert.ok(!JSON.stringify(r.headers).includes(KEY_A), 'response headers');
  }
  assert.ok(!consoleText.includes(KEY_A), 'console');
  for (const c of calls) {
    const isAbuse = c.url.startsWith('https://api.abuseipdb.com/');
    assert.ok(!c.url.includes(KEY_A), `URL ${c.url}`);
    assert.ok(!String(c.opts.body || '').includes(KEY_A), `body to ${c.url}`);
    if (!isAbuse) assert.ok(!JSON.stringify(c.opts.headers || {}).includes(KEY_A), `headers to ${c.url}`);
  }
});

test('secrets guard: the AbuseIPDB key format and header are stripped; headers are redacted for logging', () => {
  const k = KEY_A;
  for (const text of [k, `X-AbuseIPDB-Key: ${k}`, `-H "X-AbuseIPDB-Key: ${k}"`, `x-abuseipdb-key=${k}`, `my abuseipdb api key: ${k}`]) {
    const { text: out, removed } = stripSecrets(text);
    assert.ok(!out.includes(k), text.slice(0, 20));
    assert.ok(removed.includes('AbuseIPDB key'));
  }
  // A non-hex header value is still stripped by the header rule.
  assert.ok(!stripSecrets('X-AbuseIPDB-Key: Some-Other-Format-Key-123').text.includes('Some-Other-Format-Key-123'));
  // Public hashes are left alone: SHA-256 (64) and SHA-512 (128) hex.
  const sha256 = 'a'.repeat(64);
  const sha512 = 'b'.repeat(128);
  assert.equal(stripSecrets(`${sha256} ${sha512}`).text, `${sha256} ${sha512}`);

  const redacted = abuse.redactRequestHeaders({ 'X-AbuseIPDB-Key': k, 'x-abuseipdb-key': k, 'content-type': 'application/json' });
  assert.ok(!JSON.stringify(redacted).includes(k));
  assert.equal(redacted['content-type'], 'application/json');
});

// ---------------------------------------------------------------------
// Isolation: never in the feed, other tools, or another customer's answer
// ---------------------------------------------------------------------

test('isolation: results never reach threat_ioc_telemetry, get_ioc_context, get_threat_indicators or another customer', async (t) => {
  withSupabase(t);
  const { calls, abuseCalls } = spyFetch(t);
  const ip = '45.33.32.156';
  const mine = mcpPayload(await callMcp({ ip }, { key: KEY_A, callerIp: '100.200.1.1' }));
  assert.equal(mine.abuse_confidence_score, 73);
  await settle();
  assert.ok(!calls.some((c) => c.url.includes('threat_ioc_telemetry')), 'check_ip_abuse never touches the feed table');
  assert.ok(!calls.some((c) => c.opts.method === 'POST' && /threat_ioc|ioc_|pipeline/.test(c.url)));

  // Another caller asks PG1's own tools about the same IP: nothing from the
  // first customer's lookup appears, and AbuseIPDB is not called for them.
  const before = abuseCalls().length;
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': '100.200.2.2', 'x-free-tier': '1' }, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_ioc_context', arguments: { value: ip } } } }, res);
  const ctx = JSON.parse(res.body.result.content[0].text);
  assert.equal(ctx.found, false);
  assert.doesNotMatch(JSON.stringify(res.body), /abuse_confidence_score|AbuseIPDB|test_fixture ISP|pg1-test\.invalid/i);

  // Another customer with no key gets the key error, not the cached answer.
  const noKey = mcpPayload(await callMcp({ ip }, { callerIp: '100.200.3.3' }));
  assert.equal(noKey.code, 'abuseipdb_key_required');
  assert.equal(noKey.abuse_confidence_score, undefined);
  assert.equal(abuseCalls().length, before);
});

test('isolation in source: lib/abuseIpdb.mjs and the handler never write anywhere', () => {
  const stripComments = (code) => code.replace(/^\s*\/\/.*$/gm, '');
  const lib = stripComments(fs.readFileSync(path.join(ROOT, 'lib/abuseIpdb.mjs'), 'utf8'));
  assert.doesNotMatch(lib, /supabase|threat_ioc_telemetry|rest\/v1|getSupabaseCreds/i);
  assert.doesNotMatch(lib, /method:\s*'(POST|PUT|PATCH|DELETE)'/);
  const src = fs.readFileSync(path.join(ROOT, 'api/mcp.mjs'), 'utf8');
  const start = src.indexOf('export async function handleCheckIpAbuse');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.doesNotMatch(body, /getSupabaseCreds|fetch\(|threat_ioc_telemetry/);
});

// ---------------------------------------------------------------------
// Pricing and rate limit
// ---------------------------------------------------------------------

test('free: no x402 challenge or payment-gate activity, even with no free-tier header', async (t) => {
  withSupabase(t);
  spyFetch(t);
  const res = await callMcp({ ip: PUBLIC_IP }, { key: KEY_A });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['PAYMENT-REQUIRED'], undefined);
  assert.equal(res.body.result._meta, undefined);
  assert.equal(facilitatorCalls, 0);
});

test('60 calls/hour per caller without a licence key (cached calls count); another caller is unaffected', async (t) => {
  withSupabase(t);
  const { abuseCalls } = spyFetch(t);
  const callerIp = '100.250.0.1';
  for (let i = 0; i < 60; i++) {
    const res = await callMcp({ ip: PUBLIC_IP }, { key: KEY_A, callerIp });
    assert.equal(res.body.result.isError, undefined, `call ${i + 1}`);
  }
  const over = mcpPayload(await callMcp({ ip: PUBLIC_IP }, { key: KEY_A, callerIp }));
  assert.equal(over.code, 'rate_limited');
  assert.match(over.message, /60 calls\/hour/);
  const overA2a = await callA2a({ ip: PUBLIC_IP }, { key: KEY_A, callerIp });
  assert.equal(overA2a.body.error.data.code, 'rate_limited');
  assert.equal(abuseCalls().length, 1, 'cached after the first call');
  const other = await callMcp({ ip: PUBLIC_IP }, { key: KEY_A, callerIp: '100.250.0.2' });
  assert.equal(other.body.result.isError, undefined);
});

// ---------------------------------------------------------------------
// Fixtures: synthetic, labelled, no key, never calling AbuseIPDB
// ---------------------------------------------------------------------

test('fixtures: FLAGGED/CLEAN/UNKNOWN, labelled test_fixture, synthetic attribution, no key needed, AbuseIPDB never called', async (t) => {
  withSupabase(t);
  const { calls, abuseCalls } = spyFetch(t);
  const fixtures = TEST_FIXTURES.filter((f) => f.tool === 'check_ip_abuse');
  assert.deepEqual(fixtures.map((f) => f.kind), ['FLAGGED', 'CLEAN', 'UNKNOWN']);
  for (const f of fixtures) {
    for (const key of [undefined, KEY_A]) {
      const res = await callMcp(f.arguments, { key });
      const p = mcpPayload(res);
      assert.equal(p.test_fixture, true, f.kind);
      assert.equal(p.status, f.expected.status, f.kind);
      if (f.expected.outcome === 'tool_error') {
        assert.equal(res.body.result.isError, true);
        assert.equal(p.code, 'upstream_unavailable');
        continue;
      }
      assert.deepEqual(p.reasons.map((r) => r.code), f.expected.reason_codes);
      assert.match(p.attribution.text, /synthetic data, not from AbuseIPDB/);
      assert.equal(p.attribution.url, `https://www.abuseipdb.com/check/${f.arguments.ip}`);
      assert.ok(p.checks.every((c) => c.source === 'fixture'));
      const a = await callA2a(f.arguments, { key });
      assert.equal(a2aResult(a).test_fixture, true);
    }
  }
  assert.equal(abuseCalls().length, 0);
  await settle();
  assert.ok(!calls.some((c) => c.url.includes('pg1_errors')), 'fixtures never log errors');
  // Fixture IPs are documentation addresses: the live path rejects them.
  for (const f of fixtures) assert.throws(() => abuse.normalizePublicIp(f.arguments.ip), /public/);
});

// ---------------------------------------------------------------------
// CORS and versions
// ---------------------------------------------------------------------

test('CORS: X-AbuseIPDB-Key is allowed on /api/mcp and /api/a2a only', async () => {
  for (const handler of [mcpHandler, a2aHandler]) {
    const res = makeRes();
    await handler({ method: 'OPTIONS', headers: {} }, res);
    assert.equal(res.statusCode, 204);
    assert.match(res.headers['Access-Control-Allow-Headers'], /(^|, )X-AbuseIPDB-Key(,|$)/);
  }
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const withHeader = vercel.headers.filter((rule) => rule.headers.some((h) => h.key === 'Access-Control-Allow-Headers' && /X-AbuseIPDB-Key/i.test(h.value)));
  assert.deepEqual(withHeader.map((r) => r.source).sort(), ['/api/a2a', '/api/mcp']);
  const chat = fs.readFileSync(path.join(ROOT, 'api/chat.mjs'), 'utf8');
  assert.doesNotMatch(chat, /X-AbuseIPDB-Key/i);
});

test('version 1.16.0 on /api/mcp (GET + serverInfo), /api/a2a GET, server.json, agent card, openapi', async () => {
  const get = makeRes();
  await mcpHandler({ method: 'GET', headers: {} }, get);
  assert.equal(get.body.version, '1.16.0');
  const init = makeRes();
  await mcpHandler({ method: 'POST', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } }, init);
  assert.equal(init.body.result.serverInfo.version, '1.16.0');
  const a2aGet = makeRes();
  await a2aHandler({ method: 'GET', headers: {}, query: {} }, a2aGet);
  assert.equal(a2aGet.body.version, '1.16.0');
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  assert.equal(read('server.json').version, '1.16.0');
  assert.equal(read('public/.well-known/agent-card.json').version, '1.16.0');
  assert.equal(read('public/openapi.json').info.version, '1.16.0');
});

test('docs: agent card skill, llms.txt and README carry the bring-your-own-key section with a header curl example', () => {
  const card = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/.well-known/agent-card.json'), 'utf8'));
  const skill = card.skills.find((s) => s.id === 'check_ip_abuse');
  assert.ok(skill);
  assert.match(skill.description, /X-AbuseIPDB-Key/);
  assert.match(skill.description, /Data from AbuseIPDB/);
  const llms = fs.readFileSync(path.join(ROOT, 'public/llms.txt'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const [label, text] of [['llms.txt', llms], ['README.md', readme]]) {
    assert.match(text, /^## Bring your own AbuseIPDB key$/m, label);
    assert.match(text, /curl [^\n]*(\\\n[^\n]*)*-H "X-AbuseIPDB-Key: [^"]+"[^\n]*(\\\n[^\n]*)*check_ip_abuse/, label);
    assert.doesNotMatch(text.slice(text.indexOf('## Bring your own AbuseIPDB key')), /\b[0-9a-f]{80}\b/, `${label}: no real-looking key`);
  }
});
