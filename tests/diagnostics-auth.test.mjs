/**
 * /api/diagnostics/system-status-check is operator-only (it reads raw rows
 * of threat_indicators, threat_logs, telemetry_stream, nodes, system_events
 * and api_usage with the service-role key).
 *
 * Covered:
 *   - no credentials, wrong credentials, credentials in the query string,
 *     a body claiming role 'operator', and a server with no operator
 *     credentials configured all get a 401 with no rows, no environment
 *     summary and no table list, before Supabase is ever called;
 *   - nothing about the request is logged on a 401;
 *   - five wrong attempts lock the IP out (429), as for operator commands;
 *   - the operator still gets rows, by GET with Basic auth and by POST.
 *
 * Run with: node --test tests/diagnostics-auth.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const { default: handler } = await import('../api/diagnostics/system-status-check.js');
const { __clearAuthRateLimitState } = await import('../api/chat.mjs');

const OPERATOR = 'diag-operator';
const PASS = 'diag-secret-pass';
const ROW_MARKER = 'ROW-MARKER-5512';
const ROWS = [
  { id: 1, verification_source: 'AlienVault-OTX', value: '198.51.100.7', note: ROW_MARKER },
  { id: 2, verification_source: 'NVD', value: 'CVE-2026-0007', note: ROW_MARKER }
];

let supabaseCalls;
let ipCounter = 0;

function installFetch() {
  supabaseCalls = [];
  globalThis.fetch = async (url) => {
    supabaseCalls.push(String(url));
    return new Response(JSON.stringify(ROWS), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-range': `0-${ROWS.length - 1}/${ROWS.length}` }
    });
  };
}

beforeEach(() => {
  process.env.USER_API_KEY = OPERATOR;
  process.env.USER_API_PASS = PASS;
  delete process.env.USER_API_USER;
  delete process.env.USER_API_PASSS;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key-test';
  __clearAuthRateLimitState();
  installFetch();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
}

const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

// A fresh IP per request unless one is given, so the lockout only shows up
// in the test about it.
async function call({ method = 'GET', headers = {}, query, body, ip } = {}) {
  const res = makeRes();
  const req = {
    method,
    headers: { 'x-forwarded-for': ip || `203.0.113.${++ipCounter % 250}`, ...headers },
    query: query || {},
    body
  };
  const logged = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => logged.push(args.map(String).join(' '));
  }
  try {
    await handler(req, res);
  } finally {
    Object.assign(console, originals);
  }
  return { res, logged };
}

function assertRejected(res, logged, status = 401) {
  assert.equal(res.statusCode, status, JSON.stringify(res.body));
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes(ROW_MARKER), 'no row content');
  for (const key of ['records', 'sampleRecords', 'rowCount', 'totalRowCount', 'environment', 'supportedTables', 'system']) {
    assert.ok(!(key in res.body), `no ${key} in a rejected response`);
  }
  assert.deepEqual(supabaseCalls, [], 'Supabase never called');
  assert.deepEqual(logged, [], 'nothing logged');
}

const RECORDS = { table: 'threat_indicators', metric: 'records', limit: '5' };

test('no credentials: 401, no rows', async () => {
  for (const query of [{}, RECORDS, { table: 'api_usage', metric: 'count' }, { table: 'nodes' }]) {
    const { res, logged } = await call({ query });
    assertRejected(res, logged);
    assert.match(res.headers['WWW-Authenticate'], /^Basic /);
  }
});

test('wrong credentials: 401, no rows, the password is not echoed or logged', async () => {
  const cases = [
    { headers: { authorization: basic(OPERATOR, 'wrong-pass-9931') } },
    { headers: { authorization: basic('wrong-pass-9931', PASS) } },
    { headers: { authorization: 'Bearer ' + PASS } },
    { headers: { authorization: 'Basic not-base64!!' } },
    { method: 'POST', body: { user: OPERATOR, pass: 'wrong-pass-9931', ...RECORDS } },
    { method: 'POST', body: JSON.stringify({ user: OPERATOR, pass: 'wrong-pass-9931', ...RECORDS }) }
  ];
  for (const c of cases) {
    const { res, logged } = await call({ query: RECORDS, ...c });
    assertRejected(res, logged);
    assert.ok(!JSON.stringify(res.body).includes('wrong-pass-9931'));
  }
});

test('credentials in the query string are ignored', async () => {
  const { res, logged } = await call({ query: { ...RECORDS, user: OPERATOR, pass: PASS } });
  assertRejected(res, logged);
});

test('a request cannot claim the operator role', async () => {
  for (const body of [{ role: 'operator', ...RECORDS }, { sessionRole: 'operator', isOperator: true, ...RECORDS }]) {
    const { res, logged } = await call({ method: 'POST', body, headers: { 'x-pg1-role': 'operator' } });
    assertRejected(res, logged);
  }
});

test('no operator credentials configured: everyone gets 401, even with empty credentials', async () => {
  delete process.env.USER_API_KEY;
  delete process.env.USER_API_PASS;
  for (const c of [{}, { headers: { authorization: basic('', '') } }, { method: 'POST', body: { user: '', pass: '', ...RECORDS } }]) {
    const { res, logged } = await call({ query: RECORDS, ...c });
    assertRejected(res, logged);
  }
});

test('repeated wrong credentials lock the IP out, as for operator commands', async () => {
  const ip = '198.51.100.250';
  for (let i = 0; i < 5; i++) {
    const { res } = await call({ ip, query: RECORDS, headers: { authorization: basic(OPERATOR, 'nope') } });
    assert.equal(res.statusCode, 401);
  }
  const locked = await call({ ip, query: RECORDS, headers: { authorization: basic(OPERATOR, PASS) } });
  assertRejected(locked.res, locked.logged, 429);
});

test('other methods are still 405', async () => {
  const { res } = await call({ method: 'DELETE' });
  assert.equal(res.statusCode, 405);
  assert.deepEqual(supabaseCalls, []);
});

test('operator (GET + Basic auth) still gets rows', async () => {
  const { res } = await call({ query: RECORDS, headers: { authorization: basic(OPERATOR, PASS) } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.mode, 'LIVE_RECORDS');
  assert.equal(res.body.records.length, 2);
  assert.ok(JSON.stringify(res.body.records).includes(ROW_MARKER));
  assert.ok(supabaseCalls.some((u) => u.includes('/rest/v1/threat_indicators')));
});

test('operator (POST body) still gets the summary, counts and rows', async () => {
  const summary = await call({ method: 'POST', body: { user: OPERATOR, pass: PASS } });
  assert.equal(summary.res.statusCode, 200);
  assert.equal(summary.res.body.mode, 'SYSTEM_AUDIT');

  const count = await call({ method: 'POST', body: { user: OPERATOR, pass: PASS, table: 'api_usage', metric: 'count' } });
  assert.equal(count.res.statusCode, 200, JSON.stringify(count.res.body));
  assert.equal(count.res.body.mode, 'LIVE_COUNT');

  const records = await call({ method: 'POST', body: JSON.stringify({ user: OPERATOR, pass: PASS, ...RECORDS }) });
  assert.equal(records.res.statusCode, 200, JSON.stringify(records.res.body));
  assert.equal(records.res.body.records.length, 2);
});

test('operator with a table outside the allow-list still gets 400', async () => {
  const { res } = await call({ query: { table: 'pg1_errors' }, headers: { authorization: basic(OPERATOR, PASS) } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(supabaseCalls, []);
});
