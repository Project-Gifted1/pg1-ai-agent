/**
 * agent_telemetry: the code and the database must agree, and a mismatch
 * must never break a request or go unnoticed.
 *
 * 1. Schema match. The supabase/migrations files that touch agent_telemetry
 *    are applied, in order, to a real Postgres (PGlite) starting from:
 *    no table, the live hand-made shape (id, created_at, endpoint,
 *    tool_name, payment_type, status + one extra NOT NULL column, no checks),
 *    and the part-1 shape. Then every row lib/telemetry.mjs can build is
 *    inserted with exactly its own keys, the way PostgREST does it, and the
 *    columns lib/usageStats.mjs selects and purgeExpiredTelemetry filters on
 *    must exist. RLS on, nothing for anon/authenticated, re-runnable.
 * 2. Failure logging. A failed insert writes one pg1_errors row (fixed text,
 *    PostgREST code only, never the row), at most once per 15 minutes.
 * 3. No route breaks or slows down because an insert fails or hangs:
 *    /api/mcp, /api/a2a, /api/playground, /api/ioc and the chat answer
 *    exactly as they do when the insert succeeds.
 *
 * Run with: node --test tests/telemetry-schema.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

process.env.TELEMETRY_IP_SALT = 'schema-test-salt';
delete process.env.X402_PAY_TO_ADDRESS;

const telemetry = await import('../lib/telemetry.mjs');
const { buildTelemetryRow, recordTelemetry, __resetTelemetryFailureLogForTests, TELEMETRY_FAILURE_LOG_INTERVAL_MS, TELEMETRY_FAILURE_ROUTE } = telemetry;
const { default: mcpHandler } = await import('../api/mcp.mjs');
const { default: a2aHandler } = await import('../api/a2a.mjs');
const { createPlaygroundHandler } = await import('../api/playground.mjs');
const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
const { FIXTURE_VALUES } = await import('../lib/fixtures.mjs');

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url);
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase.test';
const TELEMETRY_URL = `${SUP_URL}/rest/v1/agent_telemetry`;

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

// --- 1. schema match ------------------------------------------------------------

// Every migration that mentions agent_telemetry, in filename (= apply) order.
function telemetryMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ file: f, sql: fs.readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8') }))
    .filter((m) => m.sql.includes('agent_telemetry'));
}

const STARTING_SHAPES = {
  'no table': '',
  // What the live database has: the part-1 columns minus event_type and
  // latency_ms, one extra column, no check constraints, anon grants.
  'live hand-made shape': `
    create table public.agent_telemetry (
      id bigint generated always as identity primary key,
      created_at timestamptz not null default now(),
      endpoint text, tool_name text, payment_type text, status text,
      source text not null
    );
    grant all on public.agent_telemetry to anon, authenticated;`,
  'live shape, uuid id and varchar columns': `
    create table public.agent_telemetry (
      id uuid primary key default gen_random_uuid(),
      created_at timestamp default now(),
      endpoint varchar(255), tool_name varchar(100), payment_type varchar(20), status varchar(40),
      metadata jsonb
    );`
};

async function databaseFrom(shapeSql) {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  if (shapeSql) await db.exec(shapeSql);
  const migrations = telemetryMigrations();
  for (const m of migrations) await db.exec(m.sql);
  // Re-runnable: the whole set again is a no-op, not an error.
  for (const m of migrations) await db.exec(m.sql);
  return db;
}

async function columnsOf(db) {
  const { rows } = await db.query(`
    select column_name, data_type, is_nullable, column_default, is_identity
      from information_schema.columns
     where table_schema = 'public' and table_name = 'agent_telemetry'`);
  return new Map(rows.map((r) => [r.column_name, r]));
}

// One row per event type and edge case lib/telemetry.mjs can produce.
function everyRowShape() {
  return [
    buildTelemetryRow({ eventType: 'tool_call', endpoint: '/api/mcp', toolName: 'check_domain_age', paymentType: 'free', status: 'ok', latencyMs: 12.4, callerIp: '203.0.113.7' }),
    buildTelemetryRow({ eventType: 'tool_call', endpoint: '/api/a2a', toolName: 'check_wallet_age', paymentType: 'free', status: 'rate_limited', latencyMs: 0, isFixture: true }),
    buildTelemetryRow({ eventType: 'tool_call', endpoint: '/api/ioc', toolName: 'ioc_feed', paymentType: 'x402', status: 'payment_required' }),
    buildTelemetryRow({ eventType: 'settlement', endpoint: '/api/mcp', toolName: 'get_cve_details', paymentType: 'x402', status: 'settled', latencyMs: 812, callerHash: 'a'.repeat(32) }),
    buildTelemetryRow({ eventType: 'initialize', endpoint: '/api/mcp', status: 'ok', clientName: 'Claude Desktop '.repeat(20), clientVersion: '1.'.repeat(40), callerIp: '2001:db8::1' }),
    buildTelemetryRow({ eventType: 'initialize', endpoint: '/api/mcp', status: 'ok', clientName: `bot 0x${'ab'.repeat(20)}`, clientVersion: null }),
    buildTelemetryRow({ eventType: 'bogus', paymentType: 'bitcoin', latencyMs: -5, toolName: 'x'.repeat(500), status: 's'.repeat(500) }),
    buildTelemetryRow({})
  ];
}

// Inserts a row with exactly its own keys - what PostgREST does with the
// JSON body lib/telemetry.mjs posts.
async function insertLikePostgrest(db, row) {
  const keys = Object.keys(row);
  const sql = `insert into public.agent_telemetry (${keys.map((k) => `"${k}"`).join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`;
  await db.query(sql, keys.map((k) => row[k]));
}

const USAGE_SELECT_COLUMNS = ['created_at', 'event_type', 'endpoint', 'tool_name', 'status', 'client_name', 'caller_hash', 'is_fixture'];

for (const [label, shapeSql] of Object.entries(STARTING_SHAPES)) {
  test(`schema: from "${label}", the migrations give the table lib/telemetry.mjs writes and lib/usageStats.mjs reads`, async () => {
    const db = await databaseFrom(shapeSql);
    const columns = await columnsOf(db);
    const rows = everyRowShape();
    const written = new Set(rows.flatMap((r) => Object.keys(r)));

    for (const key of written) assert.ok(columns.has(key), `column ${key} exists (written by buildTelemetryRow)`);
    for (const key of USAGE_SELECT_COLUMNS) assert.ok(columns.has(key), `column ${key} exists (read by lib/usageStats.mjs)`);
    assert.ok(columns.has('id'), 'id exists (the stats read orders by it)');
    assert.equal(columns.get('created_at').data_type, 'timestamp with time zone', 'created_at is what the retention delete compares');

    // Nothing the code leaves out may be NOT NULL without a default.
    for (const [name, col] of columns) {
      if (written.has(name)) continue;
      const fillsItself = col.column_default != null || col.is_identity === 'YES';
      assert.ok(col.is_nullable === 'YES' || fillsItself, `${name} is not written by the code, so it must be nullable or default itself`);
    }

    for (const row of rows) await insertLikePostgrest(db, row);
    const { rows: [{ n }] } = await db.query('select count(*)::int as n from public.agent_telemetry');
    assert.equal(n, rows.length, 'every row lib/telemetry.mjs can build is accepted');

    // The constraints are there: a row the code would never build is refused.
    for (const bad of [
      { endpoint: '/x', status: 'ok', event_type: 'bogus' },
      { endpoint: '/x', status: 'ok', payment_type: 'bitcoin' },
      { endpoint: '/x', status: 'ok', latency_ms: -1 },
      { endpoint: '/x', status: 'ok', caller_hash: '203.0.113.7' },
      { endpoint: '/x', status: 'ok', client_name: 'a'.repeat(65) },
      { endpoint: '/x', status: 'ok', client_version: '1'.repeat(33) },
      { status: 'ok' }
    ]) {
      await assert.rejects(insertLikePostgrest(db, bad), `refused: ${JSON.stringify(bad).slice(0, 60)}`);
    }

    const { rows: [rls] } = await db.query(`select relrowsecurity from pg_class where oid = 'public.agent_telemetry'::regclass`);
    assert.equal(rls.relrowsecurity, true, 'RLS is on');
    const { rows: grants } = await db.query(`
      select grantee, privilege_type from information_schema.role_table_grants
       where table_name = 'agent_telemetry' and grantee in ('anon', 'authenticated', 'PUBLIC')`);
    assert.deepEqual(grants, [], 'nothing granted to anon, authenticated or public');

    const { rows: idx } = await db.query(`select indexname from pg_indexes where tablename = 'agent_telemetry' order by indexname`);
    for (const name of ['agent_telemetry_created_at_idx', 'agent_telemetry_tool_created_at_idx', 'agent_telemetry_fixture_created_at_idx']) {
      assert.ok(idx.some((i) => i.indexname === name), `index ${name}`);
    }
    await db.close();
  });
}

test('schema: the row lib/telemetry.mjs builds has exactly the expected keys', () => {
  assert.deepEqual(Object.keys(buildTelemetryRow({})).sort(), [
    'caller_hash', 'client_name', 'client_version', 'endpoint', 'event_type', 'is_fixture', 'latency_ms', 'payment_type', 'status', 'tool_name'
  ]);
});

// --- 2. failure logging -----------------------------------------------------------

function useSupabase() {
  process.env.SUPABASE_URL = SUP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
}

// `insert` answers the telemetry POST; pg1_errors reads/writes are recorded.
function installFetch(insert) {
  const errorWrites = [];
  const inserts = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === TELEMETRY_URL && opts.method === 'POST') {
      inserts.push({ body: JSON.parse(opts.body), signal: opts.signal });
      return insert(opts);
    }
    if (u.includes('/rest/v1/pg1_errors')) {
      if ((opts.method || 'GET') === 'GET') return Response.json([]);
      errorWrites.push({ method: opts.method, body: JSON.parse(opts.body) });
      return new Response(null, { status: 201 });
    }
    return Response.json([]);
  };
  return { errorWrites, inserts };
}

// The real live failure: PostgREST cannot find a column the row names.
const pgrst204 = () => new Response(JSON.stringify({
  code: 'PGRST204',
  message: "Could not find the 'event_type' column of 'agent_telemetry' in the schema cache",
  details: 'row: /api/mcp check_domain_age 203.0.113.7', hint: null
}), { status: 400, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  useSupabase();
  __resetTelemetryFailureLogForTests();
  __clearAuthRateLimitState();
});

test('a rejected insert writes one pg1_errors row: fixed text, PostgREST code only, never the row', async () => {
  const { errorWrites, inserts } = installFetch(pgrst204);
  await recordTelemetry({ endpoint: '/api/mcp', toolName: 'check_domain_age', status: 'ok', callerIp: '203.0.113.7' });

  assert.equal(inserts.length, 1);
  assert.ok(inserts[0].signal instanceof AbortSignal, 'the insert has a timeout signal');
  assert.equal(errorWrites.length, 1);
  const row = errorWrites[0].body;
  assert.equal(row.source, 'server');
  assert.equal(row.route, TELEMETRY_FAILURE_ROUTE);
  assert.equal(row.status, 400);
  assert.equal(row.reason, 'telemetry_insert_failed');
  assert.equal(row.category, 'http_4xx');
  assert.equal(row.message, 'agent_telemetry insert rejected (HTTP 400, PGRST204); rows are being dropped until the table matches lib/telemetry.mjs.');
  const text = JSON.stringify(row);
  for (const leaked of ['check_domain_age', '203.0.113.7', 'event_type', inserts[0].body.caller_hash]) {
    assert.ok(!text.includes(leaked), `pg1_errors row does not carry ${leaked}`);
  }
});

test('the failure log is rate-limited: one row per 15 minutes per instance, then again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 6, 12) });
  const { errorWrites } = installFetch(pgrst204);
  for (let i = 0; i < 25; i++) await recordTelemetry({ endpoint: '/api/mcp', status: 'ok' });
  assert.equal(errorWrites.length, 1, '25 failures, one row');

  t.mock.timers.tick(TELEMETRY_FAILURE_LOG_INTERVAL_MS - 1);
  await recordTelemetry({ endpoint: '/api/mcp', status: 'ok' });
  assert.equal(errorWrites.length, 1, 'still inside the interval');

  t.mock.timers.tick(1);
  await recordTelemetry({ endpoint: '/api/mcp', status: 'ok' });
  assert.equal(errorWrites.length, 2, 'next interval, next row');
});

test('no answer: unreachable and timeout are logged with their own reason and category', async () => {
  let { errorWrites } = installFetch(async () => { throw new TypeError('fetch failed'); });
  await recordTelemetry({ endpoint: '/api/a2a', status: 'ok' });
  assert.equal(errorWrites.length, 1);
  assert.equal(errorWrites[0].body.reason, 'telemetry_insert_unreachable');
  assert.equal(errorWrites[0].body.category, 'network');
  assert.equal(errorWrites[0].body.status, null);

  __resetTelemetryFailureLogForTests();
  ({ errorWrites } = installFetch(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }));
  await recordTelemetry({ endpoint: '/api/a2a', status: 'ok' });
  assert.equal(errorWrites[0].body.reason, 'telemetry_insert_timeout');
  assert.equal(errorWrites[0].body.category, 'timeout');
});

test('a successful insert logs nothing; a failing failure-log write is swallowed too', async () => {
  const ok = installFetch(() => new Response(null, { status: 201 }));
  await recordTelemetry({ endpoint: '/api/mcp', status: 'ok' });
  assert.equal(ok.errorWrites.length, 0);

  globalThis.fetch = async (url) => {
    if (String(url) === TELEMETRY_URL) return pgrst204();
    throw new Error('pg1_errors unreachable too');
  };
  await assert.doesNotReject(recordTelemetry({ endpoint: '/api/mcp', status: 'ok' }));
});

test('unconfigured Supabase: no insert, no failure log, no throw', async () => {
  delete process.env.SUPABASE_URL;
  const { errorWrites, inserts } = installFetch(pgrst204);
  await assert.doesNotReject(recordTelemetry({ endpoint: '/api/mcp', status: 'ok' }));
  assert.equal(inserts.length + errorWrites.length, 0);
});

// --- 3. no route breaks or slows down -------------------------------------------------

function makeRes() {
  return {
    statusCode: null, headers: {}, body: null, chunks: [],
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; },
    end(p) { if (typeof p === 'string') { try { this.body = JSON.parse(p); } catch { /* not JSON */ } } return this; },
    on() {}
  };
}

const IP = { 'x-forwarded-for': '198.51.100.44' };
const playground = createPlaygroundHandler({
  record: () => {},
  executorOptions: { log: () => {}, fixtures: () => null, run: async () => ({ status: 'no_flags', reasons: [], checks: [] }) }
});

// One request per route the telemetry is wired into.
const ROUTE_CALLS = {
  'MCP initialize': (res) => mcpHandler({ method: 'POST', headers: IP, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'probe', version: '1' } } } }, res),
  'MCP tools/call (fixture)': (res) => mcpHandler({ method: 'POST', headers: IP, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_domain_age', arguments: { domain: FIXTURE_VALUES.domain.CLEAN } } } }, res),
  'MCP tools/call (paid, unpaid)': (res) => mcpHandler({ method: 'POST', headers: IP, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_cve_details', arguments: { cve_id: 'CVE-2024-3094' } } } }, res),
  'MCP tools/call (unknown tool)': (res) => mcpHandler({ method: 'POST', headers: IP, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } } }, res),
  'A2A message/send (fixture)': (res) => a2aHandler({ method: 'POST', headers: IP, query: {}, body: { jsonrpc: '2.0', id: 5, method: 'message/send', params: { message: { role: 'user', messageId: 'm', parts: [{ kind: 'data', data: { skill: 'check_domain_age', arguments: { domain: FIXTURE_VALUES.domain.FLAGGED } } }] } } } }, res),
  'playground check': (res) => playground({ method: 'POST', headers: IP, body: { tool: 'check_domain_age', input: 'example.com' } }, res),
  '/api/ioc (unpaid)': (res) => chatHandler({ method: 'GET', url: '/api/ioc', headers: IP, socket: { remoteAddress: '198.51.100.44' }, body: null }, res),
  'chat /help': (res) => chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: '10.88.0.1' }, body: { prompt: '/help' } }, res)
};

// What a caller sees, minus per-request ids, timestamps and durations.
function visible(res) {
  const strip = (v) => JSON.parse(JSON.stringify(v ?? null).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>').replace(/"traceId":"[^"]*"/g, '"traceId":"<id>"').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<t>').replace(/"(ms|latency_ms|executionTimeMs)":\d+/g, '"$1":0').replace(/"(?:messageId|contextId|taskId|id)":"[^"]*"/g, '"id":"<id>"'));
  return { status: res.statusCode, body: strip(res.body) };
}

async function runRoute(call) {
  const res = makeRes();
  const started = Date.now();
  await call(res);
  return { res, ms: Date.now() - started };
}

test('every route answers exactly the same when the insert is rejected (the live PGRST204) or hangs, without waiting for it', async () => {
  const baseline = {};
  installFetch(() => new Response(null, { status: 201 }));
  for (const [name, call] of Object.entries(ROUTE_CALLS)) baseline[name] = visible((await runRoute(call)).res);

  for (const [mode, insert] of [
    ['rejected (400 PGRST204)', pgrst204],
    ['unreachable', async () => { throw new TypeError('fetch failed'); }],
    ['hanging', () => new Promise(() => {})]
  ]) {
    __clearAuthRateLimitState();
    const { inserts } = installFetch(insert);
    for (const [name, call] of Object.entries(ROUTE_CALLS)) {
      const before = inserts.length;
      const { res, ms } = await runRoute(call);
      assert.deepEqual(visible(res), baseline[name], `${name} (${mode}): same status and body`);
      assert.ok(ms < 1000, `${name} (${mode}): answered in ${ms}ms, not held by the insert`);
      if (name !== 'chat /help') assert.equal(inserts.length - before, 1, `${name} (${mode}): one insert attempted`);
    }
  }
});
