/**
 * Telemetry rows are no longer dropped on a slow database answer
 * (lib/telemetry.mjs; the ERROR LOG warning of 22 Nov 10:02 and 11 Nov 21:10,
 * "agent_telemetry insert got no answer (timeout); rows are being dropped").
 *   - a timeout, a network failure or a 5xx is retried with backoff in the
 *     background and the row is kept when a retry succeeds;
 *   - rows recorded together go out as one insert (up to 20), one insert per
 *     row shape; a single row is still sent as an object;
 *   - a 4xx is not retried; a row is dropped only after the last retry, and
 *     the warning names how many rows and over what period; each drop is
 *     written to pg1_telemetry_drops for the daily report;
 *   - a slow or hanging insert never delays a tool response.
 * Run with: node --test tests/telemetry-queue.test.mjs
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordTelemetry, readTelemetryDrops, telemetryDropStats, dropWarningText,
  __resetTelemetryQueueForTests, __resetTelemetryFailureLogForTests, __setTelemetryRetryDelaysForTests,
  TELEMETRY_BATCH_MAX, TELEMETRY_FAILURE_LOG_INTERVAL_MS, TELEMETRY_RETRY_DELAYS_MS, TELEMETRY_RETRY_BUDGET_MS, TELEMETRY_INSERT_TIMEOUT_MS
} from '../lib/telemetry.mjs';
import mcpHandler from '../api/mcp.mjs';
import { FIXTURE_VALUES } from '../lib/fixtures.mjs';

const SUP = 'https://telemetry-queue.supabase.test';
const TELEMETRY_URL = `${SUP}/rest/v1/agent_telemetry`;
const DROPS_URL = `${SUP}/rest/v1/pg1_telemetry_drops`;
const prev = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, fetch: globalThis.fetch };

const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

// A fetch that answers agent_telemetry inserts from a script (one answer per
// attempt: a status number, 'timeout', 'network' or 'hang'), and records the
// pg1_errors and pg1_telemetry_drops writes.
function installFetch(script = []) {
  const attempts = [];
  const errors = [];
  const drops = [];
  let i = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === TELEMETRY_URL) {
      attempts.push(JSON.parse(opts.body));
      const step = script[Math.min(i++, script.length - 1)] ?? 201;
      if (step === 'timeout') throw timeoutError();
      if (step === 'network') throw new TypeError('fetch failed');
      if (step === 'hang') return new Promise(() => {});
      return new Response(step === 400 ? JSON.stringify({ code: '23514' }) : null, { status: step, headers: { 'Content-Type': 'application/json' } });
    }
    if (u === DROPS_URL) { drops.push(JSON.parse(opts.body)); return new Response(null, { status: 201 }); }
    if (u.includes('/rest/v1/pg1_errors')) {
      if ((opts.method || 'GET') === 'GET') return Response.json([]);
      errors.push(JSON.parse(opts.body));
      return new Response(null, { status: 201 });
    }
    return Response.json([]);
  };
  return { attempts, errors, drops };
}

beforeEach(() => {
  process.env.SUPABASE_URL = SUP;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  __resetTelemetryQueueForTests();
  __resetTelemetryFailureLogForTests();
  __setTelemetryRetryDelaysForTests([5, 10]);
});
afterEach(() => {
  if (prev.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prev.url;
  if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
  globalThis.fetch = prev.fetch;
  __resetTelemetryQueueForTests();
  __setTelemetryRetryDelaysForTests(null);
});

test('the retry policy fits the invocation: backoff 0.5 s then 2 s, within an 8 s budget', () => {
  assert.deepEqual([...TELEMETRY_RETRY_DELAYS_MS], [500, 2000]);
  assert.equal(TELEMETRY_INSERT_TIMEOUT_MS, 3000);
  assert.ok(TELEMETRY_RETRY_BUDGET_MS <= 8000);
});

test('a timeout, then success on retry: the row is kept, nothing is logged or dropped', async () => {
  const { attempts, errors, drops } = installFetch(['timeout', 201]);
  await recordTelemetry({ endpoint: '/api/mcp', toolName: 'check_domain_age', status: 'ok' });
  assert.equal(attempts.length, 2, 'tried twice');
  assert.deepEqual(attempts[1], attempts[0], 'the same row was retried');
  assert.equal(attempts[1].tool_name, 'check_domain_age');
  assert.deepEqual(errors, []);
  assert.deepEqual(drops, []);
  assert.deepEqual(telemetryDropStats(), { window: null, pending: null });
});

test('a row keeps the fetch in place when it was recorded: retries and the failure report never use a fetch swapped in later', async () => {
  const { attempts, errors, drops } = installFetch(['network', 'network', 'network']);
  const done = recordTelemetry({ endpoint: '/api/mcp', toolName: 'check_domain_age', status: 'ok' });
  // The caller (a test's teardown, say) puts another fetch back while the retries wait.
  const later = [];
  globalThis.fetch = async (url) => { later.push(String(url)); return new Response(null, { status: 201 }); };
  await done;
  assert.equal(attempts.length, 3, 'every try went through the recording fetch');
  assert.equal(drops.length, 1, 'the drop record too');
  assert.equal(errors.length, 1, 'and the error-log write');
  assert.deepEqual(later, [], 'nothing reached the fetch swapped in later');
});

test('a network failure and a 503 are retried too; a 4xx is not', async () => {
  let f = installFetch(['network', 503, 201]);
  await recordTelemetry({ endpoint: '/api/mcp', status: 'ok' });
  assert.equal(f.attempts.length, 3);
  assert.deepEqual(f.errors, []);
  f = installFetch([400]);
  await recordTelemetry({ endpoint: '/api/mcp', status: 'ok' });
  assert.equal(f.attempts.length, 1, 'a refused row is not retried');
  assert.equal(f.drops[0].rows_dropped, 1);
});

test('batch flush: with an insert in flight, new rows wait and go out together (up to 20), one insert per row shape', async () => {
  const { attempts } = installFetch([201]);
  const pending = [];
  for (let i = 0; i < 5; i++) pending.push(recordTelemetry({ endpoint: '/api/mcp', toolName: 'check_domain_age', status: 'ok', latencyMs: i }));
  assert.equal(attempts.length, 1, 'the first row goes out at once, as before');
  assert.ok(!Array.isArray(attempts[0]), 'one row alone: an object');
  await Promise.all(pending);
  assert.equal(attempts.length, 2, 'the other four waited for it and went out as one insert');
  assert.deepEqual(attempts[1].map((r) => r.latency_ms), [1, 2, 3, 4]);

  attempts.length = 0;
  const many = [];
  for (let i = 0; i < 46; i++) many.push(recordTelemetry({ endpoint: '/api/mcp', status: 'ok' }));
  await Promise.all(many);
  assert.deepEqual(attempts.map((a) => (Array.isArray(a) ? a.length : 1)), [1, TELEMETRY_BATCH_MAX, TELEMETRY_BATCH_MAX, 5], '46 rows, 4 inserts');

  attempts.length = 0;
  // Different columns (a country): separate inserts, as PostgREST needs one shape.
  await Promise.all([
    recordTelemetry({ endpoint: '/api/mcp', status: 'ok' }),
    recordTelemetry({ endpoint: '/api/mcp', status: 'ok' }),
    recordTelemetry({ endpoint: '/api/mcp', status: 'ok' }),
    recordTelemetry({ endpoint: '/api/mcp', status: 'ok', countryCode: 'IE' })
  ]);
  assert.equal(attempts.length, 3, 'the first row, then one insert per shape');
  assert.ok(attempts.some((a) => !Array.isArray(a) && a.country_code === 'IE'));
  assert.ok(attempts.some((a) => Array.isArray(a) && a.length === 2));
});

test('a slow database gets fewer inserts: rows recorded during a slow insert share the next one', async () => {
  let release;
  const attempts = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url) !== TELEMETRY_URL) return Response.json([]);
    attempts.push(JSON.parse(opts.body));
    if (attempts.length === 1) await new Promise((r) => { release = r; });
    return new Response(null, { status: 201 });
  };
  const rows = [recordTelemetry({ endpoint: '/api/mcp', status: 'ok' })];
  for (let i = 0; i < 12; i++) rows.push(recordTelemetry({ endpoint: '/api/a2a', status: 'ok' }));
  assert.equal(attempts.length, 1, '12 rows wait for the slow insert');
  release();
  await Promise.all(rows);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].length, 12);
});

test('the dropped-row count: how many rows, over what period, in the ERROR LOG and the drop log', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 22, 10, 2, 0) });
  const { attempts, errors, drops } = installFetch(['timeout']);
  // Three rows: the first goes alone, the other two wait and go together.
  await Promise.all([1, 2, 3].map(() => recordTelemetry({ endpoint: '/api/mcp', status: 'ok' })));
  assert.equal(attempts.length, 6, 'two inserts, each tried 3 times');
  assert.deepEqual(drops.map((d) => d.rows_dropped), [1, 2], 'every dropped row recorded');
  assert.deepEqual(drops[0], { first_dropped_at: '2026-11-22T10:02:00.000Z', last_dropped_at: '2026-11-22T10:02:00.000Z', rows_dropped: 1, reason: 'telemetry_insert_timeout' });
  assert.equal(errors.length, 1, 'one warning per 15 minutes');
  assert.equal(errors[0].reason, 'telemetry_insert_timeout');
  assert.equal(errors[0].message, 'agent_telemetry insert got no answer (timeout) after 3 tries: 1 row dropped at 2026-11-22 10:02:00 UTC.');

  // Inside the window: no new warning, but every drop is recorded, and the
  // next warning covers all of them with their period.
  t.mock.timers.tick(60 * 1000);
  await recordTelemetry({ endpoint: '/api/mcp', status: 'ok' });
  t.mock.timers.tick(120 * 1000);
  await recordTelemetry({ endpoint: '/api/mcp', status: 'ok' });
  assert.equal(errors.length, 1);
  assert.equal(telemetryDropStats().window.rows, 4, '2 + 1 + 1 since the warning');
  t.mock.timers.tick(TELEMETRY_FAILURE_LOG_INTERVAL_MS);
  await recordTelemetry({ endpoint: '/api/mcp', status: 'ok' });
  assert.equal(errors.length, 2);
  assert.equal(errors[1].message, 'agent_telemetry insert got no answer (timeout) after 3 tries: 5 rows dropped between 2026-11-22 10:02:00 and 2026-11-22 10:20:00 UTC.');
  assert.equal(drops.reduce((n, d) => n + d.rows_dropped, 0), 6, 'the drop log has all 6 rows');
  assert.equal(telemetryDropStats().window, null, 'the window starts again after a warning');
});

test('a drop record that cannot be written is carried into the next one', async () => {
  const { drops } = installFetch(['network']);
  let dropsDown = true;
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url) === DROPS_URL && dropsDown ? new Response(null, { status: 503 }) : inner(url, opts));
  await Promise.all([1, 2].map(() => recordTelemetry({ endpoint: '/api/mcp', status: 'ok' })));
  assert.equal(telemetryDropStats().pending.rows, 2);
  dropsDown = false;
  await recordTelemetry({ endpoint: '/api/mcp', status: 'ok' });
  assert.equal(drops.length, 1);
  assert.equal(drops[0].rows_dropped, 3, '2 carried over + 1 new');
  assert.equal(telemetryDropStats().pending, null);
});

test('the warning text for a refused insert names the count and period too', () => {
  const at = Date.UTC(2026, 10, 22, 10, 2);
  assert.equal(dropWarningText({ rows: 7, first: at, last: at + 60000 }, { status: 400, code: '23514' }), 'agent_telemetry insert rejected (HTTP 400, 23514): 7 rows dropped between 2026-11-22 10:02:00 and 2026-11-22 10:03:00 UTC; rows are dropped until the table matches lib/telemetry.mjs.');
});

test('readTelemetryDrops sums the last 24 hours for the daily report; a missing table is "not set up"', async () => {
  const rows = [{ rows_dropped: 3, first_dropped_at: '2026-11-22T10:02:00Z', last_dropped_at: '2026-11-22T10:02:00Z' }, { rows_dropped: 2, first_dropped_at: '2026-11-22T10:05:00Z', last_dropped_at: '2026-11-22T10:06:00Z' }];
  const out = await readTelemetryDrops({ supUrl: SUP, supKey: 'k', sinceIso: '2026-11-21T10:00:00Z', fetchImpl: async () => Response.json(rows) });
  assert.deepEqual(out, { rows: 5, records: 2, first: '2026-11-22T10:02:00Z', last: '2026-11-22T10:06:00Z' });
  await assert.rejects(() => readTelemetryDrops({ supUrl: SUP, supKey: 'k', sinceIso: 'x', fetchImpl: async () => new Response('', { status: 404 }) }), (e) => /not set up/.test(e.reason));
});

test('a slow or hanging telemetry insert never delays a tool response', async () => {
  for (const step of ['hang', 'timeout']) {
    __resetTelemetryQueueForTests();
    __setTelemetryRetryDelaysForTests([5, 10]);
    const { attempts } = installFetch([step]);
    const res = { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } };
    const started = Date.now();
    await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.90' }, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_domain_age', arguments: { domain: FIXTURE_VALUES.domain.CLEAN } } } }, res);
    const ms = Date.now() - started;
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.result.isError);
    assert.ok(ms < 300, `${step}: answered in ${ms} ms, not held by telemetry`);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(attempts.length >= 1, `${step}: the row was still sent`);
  }
});

test('a metered row with a plan (1.23.0): before the plan migration it is retried once without the plan and kept', async () => {
  const attempts = []; const errors = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === TELEMETRY_URL) {
      const body = JSON.parse(opts.body); attempts.push(body);
      const rows = [].concat(body);
      if (rows.some((r) => 'plan' in r)) return new Response(JSON.stringify({ code: 'PGRST204', message: "Could not find the 'plan' column" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      return new Response(null, { status: 201 });
    }
    if (u.includes('/rest/v1/pg1_errors') && opts.method === 'POST') errors.push(JSON.parse(opts.body));
    return Response.json([]);
  };
  await recordTelemetry({ endpoint: '/api/mcp', toolName: 'check_agent_message', status: 'ok', paymentType: 'free', plan: 'free' });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].plan, 'free');
  assert.equal(attempts[1].plan, undefined, 'retried without the plan');
  assert.equal(attempts[1].tool_name, 'check_agent_message', 'the row is kept');
  assert.deepEqual(errors, [], 'not a failure');
  // For a while after, the plan is left off up front (one try, no 400).
  attempts.length = 0;
  await recordTelemetry({ endpoint: '/api/mcp', toolName: 'check_repo_trap', status: 'ok', plan: 'anonymous' });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].plan, undefined);
});
