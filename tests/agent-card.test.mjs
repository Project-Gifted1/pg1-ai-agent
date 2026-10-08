/**
 * Tests for public/.well-known/agent-card.json (issue #150) — the static A2A
 * agent card, and the matching vercel.json header rule that serves it as
 * application/json with CORS enabled (mirroring /.well-known/x402).
 * Run with: node --test tests/agent-card.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { A2A_SKILL_TOOLS } from '../api/a2a.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const card = JSON.parse(fs.readFileSync(path.join(repoRoot, 'public/.well-known/agent-card.json'), 'utf8'));
const vercelConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'));

test('agent card has the required top-level identity fields', () => {
  assert.equal(card.name, 'PG1 Sovereign Threat Intelligence');
  assert.equal(card.version, '1.17.0');
  assert.equal(card.protocolVersion, '0.3.0');
  assert.equal(card.documentationUrl, 'https://pg1-ai-agent.vercel.app/docs/crypto-alert-bot');
  assert.equal(card.url, 'https://pg1-ai-agent.vercel.app/api/a2a');
  assert.equal(card.preferredTransport, 'JSONRPC');
});

test('agent card declares supportedInterfaces for both A2A versions at /api/a2a', () => {
  assert.ok(Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length === 2);
  for (const iface of card.supportedInterfaces) {
    assert.equal(iface.url, 'https://pg1-ai-agent.vercel.app/api/a2a');
    assert.equal(iface.protocolBinding, 'JSONRPC');
  }
  const versions = card.supportedInterfaces.map((i) => i.protocolVersion).sort();
  assert.deepEqual(versions, ['0.3', '1.0']);
});

test('agent card declares streaming, push notifications, and extended agent card as false', () => {
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.equal(card.capabilities.extendedAgentCard, false);
});

test('agent card: no card-wide security requirement; only check_ip_abuse declares the customer\'s own AbuseIPDB key header', () => {
  assert.equal(card.security, undefined);
  assert.deepEqual(Object.keys(card.securitySchemes), ['abuseipdbKey']);
  assert.equal(card.securitySchemes.abuseipdbKey.type, 'apiKey');
  assert.equal(card.securitySchemes.abuseipdbKey.in, 'header');
  assert.equal(card.securitySchemes.abuseipdbKey.name, 'X-AbuseIPDB-Key');
  for (const skill of card.skills) {
    if (skill.id === 'check_ip_abuse') assert.deepEqual(skill.security, [{ abuseipdbKey: [] }]);
    else assert.equal(skill.security, undefined, skill.id);
  }
});

test('agent card has exactly one skill per always-free tool, matching api/a2a.mjs', () => {
  const cardSkillIds = card.skills.map((s) => s.id).sort();
  const exposedSkillIds = A2A_SKILL_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(cardSkillIds, exposedSkillIds);
  assert.deepEqual(cardSkillIds, ['check_domain_age', 'check_hostname_reputation', 'check_ip_abuse', 'check_package', 'check_wallet_age', 'check_wallet_sanctions', 'get_usage_status']);
});

test('every skill declares input/output modes', () => {
  for (const skill of card.skills) {
    assert.ok(Array.isArray(skill.inputModes) && skill.inputModes.length > 0, `${skill.id} missing inputModes`);
    assert.ok(Array.isArray(skill.outputModes) && skill.outputModes.length > 0, `${skill.id} missing outputModes`);
  }
});

test('vercel.json serves /.well-known/agent-card.json as application/json with CORS, mirroring /.well-known/x402', () => {
  const rule = vercelConfig.headers.find((h) => h.source === '/.well-known/agent-card.json');
  assert.ok(rule, 'no header rule found for /.well-known/agent-card.json');
  const byKey = Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
  assert.equal(byKey['Content-Type'], 'application/json');
  assert.equal(byKey['Access-Control-Allow-Origin'], '*');
});
