/**
 * SealKeeper domain-claim proof for pg1-ai-agent.vercel.app. SealKeeper rereads
 * both the plain-text file and the agent-card extension daily, so they must stay
 * published and carry the same token. The token is a public proof of domain
 * control, not a secret.
 * Run with: node --test tests/sealkeeper-claim.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const TOKEN = '1rNWOUGu3zo6fixH3wDCsIXB_uCwRGNKVf_S3ON6RH0';
const claimPath = path.join(repoRoot, 'public/.well-known/sealkeeper-claim.txt');
const card = JSON.parse(fs.readFileSync(path.join(repoRoot, 'public/.well-known/agent-card.json'), 'utf8'));
const vercelConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'));

test('claim file exists and holds exactly the token (one line, no trailing newline)', () => {
  assert.ok(fs.existsSync(claimPath), 'public/.well-known/sealkeeper-claim.txt missing');
  assert.equal(fs.readFileSync(claimPath, 'utf8'), TOKEN);
});

test('agent card carries the SealKeeper claim extension with the same token', () => {
  const ext = card.capabilities.extensions.filter((e) => e.uri === 'https://sealkeeper.run/ext/claim');
  assert.equal(ext.length, 1);
  assert.deepEqual(ext[0], { uri: 'https://sealkeeper.run/ext/claim', params: { token: TOKEN } });
  assert.equal(ext[0].params.token, fs.readFileSync(claimPath, 'utf8'));
});

test('agent card keeps the existing extensions and every extension stays A2A-shaped', () => {
  const uris = card.capabilities.extensions.map((e) => e.uri);
  assert.ok(uris.some((u) => /a2a-x402/.test(u)), 'x402 extension kept');
  assert.ok(card.capabilities.extensions.some((e) => e.params && e.params.jwks_url), 'signing extension kept');
  for (const e of card.capabilities.extensions) {
    assert.equal(typeof e.uri, 'string');
    assert.doesNotThrow(() => new URL(e.uri));
    if ('params' in e) assert.equal(typeof e.params, 'object');
    if ('required' in e) assert.equal(typeof e.required, 'boolean');
  }
});

test('vercel.json neither rewrites nor redirects the claim path', () => {
  const p = '/.well-known/sealkeeper-claim.txt';
  for (const r of [...(vercelConfig.rewrites || []), ...(vercelConfig.redirects || [])]) {
    assert.notEqual(r.source, p);
    assert.ok(!/^\/\.well-known\/(\(\.\*\)|:path\*)/.test(r.source), `catch-all on /.well-known: ${r.source}`);
  }
});
