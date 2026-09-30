/**
 * Tests for vercel.json CORS scoping around the issue #201 error-log endpoints
 * (api/errors.mjs, api/errors/cleanup.mjs):
 * - /api/errors is restricted to the site origin, exactly like /api/chat
 *   (it was previously falling into the open "/api/*" wildcard rule)
 * - /api/errors/cleanup (Vercel cron only, gated by CRON_SECRET) carries no
 *   open Access-Control-Allow-Origin header at all
 * - the open wildcard rule no longer matches either path
 * Run with: node --test tests/errors-cors.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vercelConfig = JSON.parse(readFileSync(join(__dirname, '../vercel.json'), 'utf-8'));

function headersByKey(rule) {
  return Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
}

test('/api/errors is restricted to the site origin, matching /api/chat', () => {
  const chatRule = vercelConfig.headers.find((h) => h.source === '/api/chat');
  const errorsRule = vercelConfig.headers.find((h) => h.source === '/api/errors');
  assert.ok(chatRule, 'no header rule found for /api/chat');
  assert.ok(errorsRule, 'no header rule found for /api/errors');

  const chatOrigin = headersByKey(chatRule)['Access-Control-Allow-Origin'];
  const errorsOrigin = headersByKey(errorsRule)['Access-Control-Allow-Origin'];

  assert.notEqual(errorsOrigin, '*', '/api/errors must not allow every origin');
  assert.equal(errorsOrigin, chatOrigin, '/api/errors should be scoped to the same origin as /api/chat');
});

test('/api/errors/cleanup carries no open Access-Control-Allow-Origin (cron-only endpoint)', () => {
  const cleanupRule = vercelConfig.headers.find((h) => h.source === '/api/errors/cleanup');
  if (cleanupRule) {
    const origin = headersByKey(cleanupRule)['Access-Control-Allow-Origin'];
    assert.notEqual(origin, '*', '/api/errors/cleanup must not carry an open CORS header');
  }

  // Belt and suspenders: the handler itself must gate on CRON_SECRET so a
  // browser request (which never carries this header) is rejected even if
  // it somehow reached the function.
  const cleanupSrc = readFileSync(join(__dirname, '../api/errors/cleanup.mjs'), 'utf-8');
  assert.match(cleanupSrc, /CRON_SECRET/, 'api/errors/cleanup.mjs must check CRON_SECRET');
});

test('the open "/api/*" wildcard rule no longer matches /api/errors or /api/errors/cleanup', () => {
  const wildcardRule = vercelConfig.headers.find(
    (h) => h.source.startsWith('/api/:path(') && headersByKey(h)['Access-Control-Allow-Origin'] === '*'
  );
  assert.ok(wildcardRule, 'no open-CORS wildcard rule found');

  const match = wildcardRule.source.match(/^\/api\/:path\((.*)\)$/);
  assert.ok(match, `could not parse custom regex out of wildcard source "${wildcardRule.source}"`);
  const innerPattern = new RegExp(`^${match[1]}$`);

  assert.equal(innerPattern.test('chat'), false, 'wildcard must still exclude /api/chat');
  assert.equal(innerPattern.test('errors'), false, 'wildcard must exclude /api/errors');
  assert.equal(innerPattern.test('errors/cleanup'), false, 'wildcard must exclude /api/errors/cleanup');

  // Sanity check: other unrelated API routes must still fall through to the
  // open wildcard rule (this fix must not accidentally lock down everything).
  assert.equal(innerPattern.test('mcp'), true);
  assert.equal(innerPattern.test('heartbeat/pulse'), true);
});

test('vercel.json never pairs a wildcard Allow-Origin with Allow-Credentials on the new rules (issue #113 regression)', () => {
  for (const source of ['/api/errors', '/api/errors/cleanup']) {
    const rule = vercelConfig.headers.find((h) => h.source === source);
    if (!rule) continue;
    const byKey = headersByKey(rule);
    if (byKey['Access-Control-Allow-Origin'] === '*') {
      assert.equal(byKey['Access-Control-Allow-Credentials'], undefined);
    }
  }
});
