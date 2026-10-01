/**
 * Tests for the crawler/agent discovery files (issue #152): public/llms.txt,
 * public/openapi.json, and public/robots.txt.
 * Run with: node --test tests/discovery-files.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const publicDir = path.join(repoRoot, 'public');

test('openapi.json parses as valid JSON and documents /api/ioc and /api/health', () => {
  const raw = fs.readFileSync(path.join(publicDir, 'openapi.json'), 'utf8');
  const spec = JSON.parse(raw);
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/api/ioc'], 'expected /api/ioc to be documented');
  assert.ok(spec.paths['/api/health'], 'expected /api/health to be documented');
});

test('llms.txt exists, starts with an H1, and never mentions Gumroad', () => {
  const raw = fs.readFileSync(path.join(publicDir, 'llms.txt'), 'utf8');
  assert.ok(raw.startsWith('# '), 'expected llms.txt to start with an H1 title');
  assert.ok(!/gumroad/i.test(raw), 'llms.txt must not mention Gumroad (product page is unpublished)');
});

test('robots.txt exists and allows all crawlers', () => {
  const filePath = path.join(publicDir, 'robots.txt');
  assert.ok(fs.existsSync(filePath), 'expected public/robots.txt to exist');
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.match(raw, /User-agent:\s*\*/);
  assert.match(raw, /Allow:\s*\//);
});

// x402scan discovery (https://www.x402scan.com/resources/register): the
// OpenAPI document is the primary discovery source, so every paid operation
// needs an operationId, input + 200 output schemas, a 402 response, and
// x-payment-info; every free operation needs security: [].
// POST /api/ioc is listed too: the runtime answers POST with the same x402
// challenge, and x402scan's probe prefers a POST advisory over GET, so the
// POST operation must carry its own input schema (see the test below).
const PAID_OPERATIONS = [['/api/ioc', 'get', '0.01'], ['/api/ioc', 'post', '0.01']];
const FREE_OPERATIONS = [['/api/health', 'get']];

function loadSpec() {
  return JSON.parse(fs.readFileSync(path.join(publicDir, 'openapi.json'), 'utf8'));
}

test('openapi.json info.x-guidance tells an agent how to call and pay for the API', () => {
  const guidance = loadSpec().info['x-guidance'];
  assert.equal(typeof guidance, 'string');
  assert.match(guidance, /\/api\/ioc/);
  assert.match(guidance, /x402/);
  assert.match(guidance, /USDC/);
  assert.match(guidance, /Base/);
});

for (const [route, method, price] of PAID_OPERATIONS) {
  test(`openapi.json paid operation ${method.toUpperCase()} ${route} has everything x402scan needs`, () => {
    const op = loadSpec().paths[route][method];
    assert.ok(op, `expected ${method.toUpperCase()} ${route} to be documented`);
    assert.match(op.operationId || '', /^[A-Za-z][A-Za-z0-9_]*$/);
    assert.ok(op.summary);

    const queryParams = (op.parameters || []).filter((p) => p.in === 'query');
    assert.ok(queryParams.length > 0 || op.requestBody, 'expected an input schema (query parameters or requestBody)');
    for (const p of queryParams) assert.ok(p.schema && p.schema.type, `query parameter ${p.name} needs a typed schema`);
    // Every input stays optional: callers with no parameters must keep working.
    for (const p of op.parameters || []) assert.notEqual(p.required, true, `parameter ${p.name} must stay optional`);
    if (op.requestBody) assert.notEqual(op.requestBody.required, true, 'requestBody must stay optional');

    const ok = op.responses['200'];
    assert.ok(ok, 'expected a 200 response');
    const okSchemas = Object.values(ok.content || {}).map((c) => c.schema);
    assert.ok(okSchemas.length > 0 && okSchemas.every((s) => s && s.type === 'object' && s.properties));

    assert.ok(op.responses['402'], 'expected a 402 response');

    assert.deepEqual(op['x-payment-info'], {
      price: { mode: 'fixed', currency: 'USD', amount: price },
      protocols: [{ x402: {} }]
    });

    // Anonymous ({}) access must not be advertised: an unauthenticated,
    // unpaid request gets the 402 challenge.
    assert.ok(Array.isArray(op.security) && op.security.length > 0);
    assert.ok(op.security.every((req) => Object.keys(req).length > 0), 'paid operation must not list {} (anonymous) security');
  });
}

for (const [route, method] of FREE_OPERATIONS) {
  test(`openapi.json free operation ${method.toUpperCase()} ${route} declares security: []`, () => {
    const op = loadSpec().paths[route][method];
    assert.ok(op, `expected ${method.toUpperCase()} ${route} to be documented`);
    assert.deepEqual(op.security, []);
    assert.equal(op['x-payment-info'], undefined);
  });
}

test('openapi.json info.contact.email is set', () => {
  assert.equal(loadSpec().info.contact?.email, 'gikewun@gmail.com');
});

// Mirrors extractInputSchema() in @agentcash/discovery (used by x402scan): an
// operation has an input schema only if its own `parameters` array (not the
// path item's) is non-empty or it has a requestBody with a content schema.
// x402scan probes every method and prefers POST over GET, so every method the
// runtime gates with x402 needs one (HEAD is only picked if neither exists).
test('openapi.json gives every x402-gated /api/ioc method an operation-level input schema', () => {
  const item = loadSpec().paths['/api/ioc'];
  for (const method of ['get', 'post']) {
    const op = item[method];
    assert.ok(op, `expected ${method.toUpperCase()} /api/ioc to be documented`);
    const params = (op.parameters || []).filter((p) => p && typeof p === 'object');
    const body = Object.values(op.requestBody?.content || {}).some((c) => c && c.schema);
    assert.ok(params.length > 0 || body, `${method.toUpperCase()} /api/ioc needs parameters or a requestBody`);
  }
  assert.deepEqual(item.post.parameters, item.get.parameters, 'POST reads the same query string as GET');
  assert.deepEqual(item.post.responses, item.get.responses, 'POST returns the same responses as GET');
});

test('openapi.json lists every documented operation as either paid or free', () => {
  const spec = loadSpec();
  const known = new Set([...PAID_OPERATIONS, ...FREE_OPERATIONS].map(([r, m]) => `${m} ${r}`));
  for (const [route, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      assert.ok(known.has(`${method} ${route}`), `${method.toUpperCase()} ${route} must be classified as paid or free in this test`);
    }
  }
});
