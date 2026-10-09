/**
 * Cron routes fail closed, and the unauthenticated leftovers are gone.
 *
 * Covered:
 *   - lib/cronAuth.mjs: 403 when CRON_SECRET is unset or blank, 401 for a
 *     missing, wrong, shorter, longer or differently cased header, ok only
 *     for exactly `Bearer <CRON_SECRET>` (what Vercel cron sends); the
 *     comparison goes through crypto.timingSafeEqual;
 *   - /api/heartbeat/pulse and /api/errors/cleanup use it: 403 with no
 *     secret configured (and cleanup never reaches Supabase), 401 on a
 *     wrong header, 200 with the right one;
 *   - every cron path in vercel.json is gated by checkCronAuth;
 *   - app/api/generate/image/route.ts, app/client.tsx, api/vault-auth.js
 *     and the three U+2060-named routes are deleted, and no file name in
 *     the repository carries U+2060 under api/ (app/'s last one goes with
 *     the ingestor removal).
 *
 * Run with: node --test tests/cron-auth-and-removed-routes.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WJ = '⁠';
const SECRET = 'test-cron-secret-0123456789';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const { checkCronAuth } = await import('../lib/cronAuth.mjs');
const { default: pulse } = await import('../api/heartbeat/pulse.js');
const { default: cleanup } = await import('../api/errors/cleanup.mjs');

let fetchCalls;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.CRON_SECRET;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  fetchCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: opts.method || 'GET' });
    return new Response(null, { status: 204 });
  };
});

after(() => {
  process.env = ORIGINAL_ENV;
  globalThis.fetch = ORIGINAL_FETCH;
});

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() {},
    end() { return this; }
  };
}

const req = (authorization) => ({ method: 'GET', headers: authorization === undefined ? {} : { authorization } });

test('checkCronAuth: 403 when CRON_SECRET is unset or blank, whatever the request sends', () => {
  for (const env of [{}, { CRON_SECRET: '' }, { CRON_SECRET: '   ' }]) {
    for (const h of [undefined, '', 'Bearer ', 'Bearer undefined', `Bearer ${SECRET}`]) {
      const out = checkCronAuth(req(h), env);
      assert.equal(out.ok, false);
      assert.equal(out.status, 403, `env ${JSON.stringify(env)} header ${JSON.stringify(h)}`);
    }
  }
});

test('checkCronAuth: only the exact Bearer header passes', () => {
  const env = { CRON_SECRET: SECRET };
  assert.deepEqual(checkCronAuth(req(`Bearer ${SECRET}`), env), { ok: true });
  for (const h of [undefined, '', SECRET, `bearer ${SECRET}`, `Bearer  ${SECRET}`, `Bearer ${SECRET} `,
    `Bearer ${SECRET.slice(0, -1)}`, `Bearer ${SECRET}x`, `Basic ${SECRET}`, 'Bearer wrong']) {
    const out = checkCronAuth(req(h), env);
    assert.equal(out.ok, false, JSON.stringify(h));
    assert.equal(out.status, 401, JSON.stringify(h));
  }
  assert.equal(checkCronAuth({ headers: { authorization: ['Bearer', SECRET] } }, env).status, 401, 'non-string header');
  assert.equal(checkCronAuth({}, env).status, 401, 'no headers object');
});

test('checkCronAuth compares in constant time', () => {
  const src = readFileSync(join(ROOT, 'lib/cronAuth.mjs'), 'utf8');
  assert.match(src, /crypto\.timingSafeEqual\(/);
  assert.doesNotMatch(src, /[!=]==?\s*`Bearer/, 'no plain string comparison of the header');
});

test('pulse: 403 with no CRON_SECRET, 401 on a wrong header, 200 with the right one', async () => {
  let res = makeRes();
  await pulse(req(`Bearer ${SECRET}`), res);
  assert.equal(res.statusCode, 403);
  assert.ok(!('status' in res.body) || res.body.status !== 'HEARTBEAT_ACTIVE');

  process.env.CRON_SECRET = SECRET;
  res = makeRes();
  await pulse(req('Bearer wrong'), res);
  assert.equal(res.statusCode, 401);
  res = makeRes();
  await pulse(req(), res);
  assert.equal(res.statusCode, 401);

  res = makeRes();
  await pulse(req(`Bearer ${SECRET}`), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'HEARTBEAT_ACTIVE');
});

test('cleanup: 403 with no CRON_SECRET and no Supabase call; 401 on a wrong header; 200 with the right one', async () => {
  let res = makeRes();
  await cleanup(req(`Bearer ${SECRET}`), res);
  assert.equal(res.statusCode, 403);
  assert.equal(fetchCalls.length, 0, 'nothing deleted without a configured secret');

  process.env.CRON_SECRET = SECRET;
  res = makeRes();
  await cleanup(req('Bearer nope'), res);
  assert.equal(res.statusCode, 401);
  assert.equal(fetchCalls.length, 0);

  res = makeRes();
  await cleanup(req(`Bearer ${SECRET}`), res);
  assert.equal(res.statusCode, 200);
  assert.ok(fetchCalls.some((c) => c.method === 'DELETE' && c.url.includes('/rest/v1/pg1_errors')));
});

test('every cron path in vercel.json is gated by checkCronAuth', () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const paths = (vercel.crons || []).map((c) => c.path);
  assert.deepEqual(paths.sort(), ['/api/errors/cleanup', '/api/heartbeat/pulse']);
  for (const p of paths) {
    const base = join(ROOT, p.slice(1));
    const file = ['.js', '.mjs'].map((ext) => base + ext).find((f) => existsSync(f));
    assert.ok(file, `${p} has a handler file`);
    assert.match(readFileSync(file, 'utf8'), /checkCronAuth\(req\)/, `${p} calls checkCronAuth`);
  }
});

test('the image route, client.tsx, vault-auth and the U+2060 routes are deleted', () => {
  for (const p of ['app/api/generate/image/route.ts', 'app/client.tsx', 'api/vault-auth.js',
    `api/memory/consolidate.js${WJ}`, `api/memory/recall.js${WJ}`, `api/skills/synthesize.js${WJ}`]) {
    assert.equal(existsSync(join(ROOT, p)), false, `${JSON.stringify(p)} must be deleted`);
  }
  const named = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.name.includes(WJ)) named.push(relative(ROOT, full));
      if (e.isDirectory()) walk(full);
    }
  })(join(ROOT, 'api'));
  assert.deepEqual(named, [], 'no U+2060 in any file name under api/');
});
