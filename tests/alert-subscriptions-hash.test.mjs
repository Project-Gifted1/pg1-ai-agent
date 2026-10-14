/**
 * subscribe_alerts stores the licence key only as its salted HMAC
 * (licenceKeyHash, the same hash api_access_logs uses): the writer never
 * sends the plain key to the database, refuses when no salt is configured,
 * the migration adds the hash column without touching the plain one, and
 * the backfill fills hashes without ever changing or printing a key.
 *
 * Run with: node --test tests/alert-subscriptions-hash.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const { default: mcpHandler } = await import('../api/mcp.mjs');
const { licenceKeyHash } = await import('../lib/telemetry.mjs');
const { backfillAlertSubscriptionHashes } = await import('../lib/alertSubscriptionsBackfill.mjs');

const LICENCE = ['alert', 'test', 'licence'].join('-');
let ip = 0;

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; }
  };
}
async function subscribe(args) {
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': `198.51.100.${++ip % 250}`, 'x-api-key': LICENCE }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'subscribe_alerts', arguments: args } } }, res);
  return res;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, TELEMETRY_IP_SALT: 'alert-hash-test-salt', SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  globalThis.fetch = ORIGINAL_FETCH;
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

test('subscribe_alerts writes license_key_hash and never the plain key', async () => {
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.gumroad.com/')) return new Response(JSON.stringify({ success: true, purchase: {} }));
    if (u.includes('/rest/v1/alert_subscriptions')) {
      writes.push(String(init.body || ''));
      return new Response(JSON.stringify([{ id: 7, created_at: '2026-10-14T00:00:00Z' }]), { status: 201 });
    }
    return new Response('[]');
  };
  const res = await subscribe({ webhook_url: 'https://hooks.example.com/pg1' });
  assert.equal(writes.length, 1);
  const row = JSON.parse(writes[0]);
  assert.equal(row.license_key_hash, licenceKeyHash(LICENCE));
  assert.match(row.license_key_hash, /^[0-9a-f]{32}$/);
  assert.ok(!('license_key' in row));
  assert.ok(!writes[0].includes(LICENCE), 'the plain key never reaches the database');
  assert.equal(JSON.parse(res.body.result.content[0].text).subscription_id, 7);
});

test('with no salt at all, subscribe_alerts refuses rather than store an unhashed key', async () => {
  for (const k of ['TELEMETRY_IP_SALT', 'SUPABASEAPI_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLEKEY']) delete process.env[k];
  const writes = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.gumroad.com/')) return new Response(JSON.stringify({ success: true, purchase: {} }));
    if (u.includes('alert_subscriptions')) writes.push(u);
    return new Response('[]');
  };
  await subscribe({ webhook_url: 'https://hooks.example.com/pg1' });
  assert.equal(writes.length, 0);
});

test('the migration adds the hash column, keeps every plain key, and allows new rows without one', async () => {
  const db = new PGlite();
  await db.exec(`create table public.alert_subscriptions (id bigserial primary key, webhook_url text not null, filter jsonb, license_key text not null, created_at timestamptz default now());
    insert into public.alert_subscriptions (webhook_url, license_key) values ('https://a.example/h', 'plain-1'), ('https://b.example/h', 'plain-2');`);
  const sql = readFileSync(new URL('../supabase/migrations/20261028120000_alert_subscriptions_hashed_key.sql', import.meta.url), 'utf8');
  await db.exec(sql);
  await db.exec(sql); // idempotent
  const { rows } = await db.query('select license_key, license_key_hash from public.alert_subscriptions order by id');
  assert.deepEqual(rows, [{ license_key: 'plain-1', license_key_hash: null }, { license_key: 'plain-2', license_key_hash: null }]);
  await db.query('insert into public.alert_subscriptions (webhook_url, license_key_hash) values ($1, $2)', ['https://c.example/h', 'a'.repeat(32)]);
  await assert.rejects(db.query('insert into public.alert_subscriptions (webhook_url, license_key_hash) values ($1, $2)', ['https://d.example/h', 'not-a-hash']));
  const code = sql.split('\n').map((l) => l.split('--')[0]).join('\n').toLowerCase();
  for (const w of ['delete ', 'truncate', 'drop column', 'drop table', 'update ']) assert.ok(!code.includes(w), w);
  await db.close();
});

test('the backfill hashes only rows without a hash, never changes or prints a key', async () => {
  const rows = [{ id: 1, license_key: 'plain-1' }, { id: 2, license_key: 'plain-2' }];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    if ((init.method || 'GET') === 'GET') return new Response(JSON.stringify(String(url).includes('id=gt.') ? [] : rows));
    return new Response(null, { status: 204 });
  };
  const dry = await backfillAlertSubscriptionHashes({ supUrl: 'https://supabase.test', supKey: 'k', fetchImpl });
  assert.deepEqual(dry, { scanned: 2, hashed: 2, skipped_no_salt: 0, failed: 0, applied: false });
  assert.ok(calls.every((c) => c.method === 'GET'), 'a dry run writes nothing');
  assert.match(calls[0].url, /license_key_hash=is\.null/);

  calls.length = 0;
  const done = await backfillAlertSubscriptionHashes({ supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, apply: true });
  assert.equal(done.hashed, 2);
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.deepEqual(patches.map((p) => JSON.parse(p.body)), [{ license_key_hash: licenceKeyHash('plain-1') }, { license_key_hash: licenceKeyHash('plain-2') }]);
  assert.ok(patches.every((p) => /license_key_hash=is\.null/.test(p.url) && !p.body.includes('plain-')));
  assert.ok(!JSON.stringify(done).includes('plain-'));
});
