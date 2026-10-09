/**
 * The unverified Gumroad webhooks and the Crypto Threat Signals ingestors
 * are gone, and nothing points at them any more.
 *
 * Covered:
 *   - api/webhook.js and api/webhooks/gumroad.js are deleted (sales are
 *     paused, no Ping URL is set, and nothing reads sales_ledger; a
 *     verified webhook comes back in its own change before sales reopen);
 *   - no route under api/ or app/ writes to sales_ledger;
 *   - the three crypto-threat-ingestor routes and
 *     api/diagnostics/crypto-feed-audit.js are deleted, and no source
 *     calls the Crypto Threat Signals API except the operator-only /smoke
 *     chat command (api/chat.mjs, key from SMOKETEST_API_KEY, out of scope
 *     here);
 *   - no file in the repository carries a cts_ key (failure messages name
 *     the file only, never the matched text);
 *   - vercel.json and .env.example no longer reference any of them.
 *
 * Run with: node --test tests/removed-ingestors-and-webhooks.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WJ = '⁠';

const REMOVED = [
  'api/webhook.js',
  'api/webhooks/gumroad.js',
  'api/crypto-threat-ingestor.js',
  'api/workers/crypto-threat-ingestor.js',
  `app/api/crypto-threat-ingestor/route.js${WJ}`,
  'api/diagnostics/crypto-feed-audit.js'
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.vercel']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const rel = (p) => relative(ROOT, p);

test('the Gumroad webhooks, ingestors and crypto feed audit are deleted', () => {
  for (const p of REMOVED) assert.equal(existsSync(join(ROOT, p)), false, `${JSON.stringify(p)} must be deleted`);
  assert.equal(existsSync(join(ROOT, 'app/api/crypto-threat-ingestor')), false, 'the empty ingestor route folder is gone too');
});

test('no route writes to sales_ledger', () => {
  const routes = [...walk(join(ROOT, 'api')), ...walk(join(ROOT, 'app'))];
  const writers = routes.filter((p) => readFileSync(p, 'latin1').includes('sales_ledger')).map(rel);
  assert.deepEqual(writers, []);
});

test('no source calls the Crypto Threat Signals API (bar the operator /smoke command)', () => {
  const sources = ['api', 'app', 'lib', 'src', 'workers', 'components', 'public']
    .flatMap((d) => walk(join(ROOT, d)))
    .filter((p) => /\.(?:m?[jt]sx?|json|html)$/.test(p));
  const callers = sources.filter((p) => readFileSync(p, 'latin1').includes('crypto-threat-signals-api')).map(rel);
  assert.deepEqual(callers, ['api/chat.mjs']);
});

test('no file carries a cts_ key (file names only in the message)', () => {
  const keyShape = /cts_[A-Za-z0-9_-]{12,}/;
  const hits = walk(ROOT).filter((p) => keyShape.test(readFileSync(p, 'latin1'))).map(rel);
  assert.deepEqual(hits, [], 'files with a cts_ key-shaped string (contents not shown)');
});

test('vercel.json and .env.example no longer reference the removed routes', () => {
  const vercel = readFileSync(join(ROOT, 'vercel.json'), 'utf8');
  for (const needle of ['webhook', 'gumroad', 'crypto-threat-ingestor', 'crypto-feed-audit']) {
    assert.ok(!vercel.toLowerCase().includes(needle), `vercel.json must not mention ${needle}`);
  }
  const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
  assert.doesNotMatch(envExample, /CRYPTO_THREAT_SIGNALS_API_KEY|crypto-threat-ingestor/);
});
