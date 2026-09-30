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
