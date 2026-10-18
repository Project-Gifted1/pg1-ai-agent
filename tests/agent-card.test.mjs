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
  assert.equal(card.version, '1.20.2');
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

test('agent card has exactly one skill per A2A skill (free and paid), matching api/a2a.mjs', () => {
  // A2A jobs (lib/a2aJobs, P7): submit_job and one job.* entry per job type are checked in tests/a2a-jobs.test.mjs.
  const cardSkillIds = card.skills.map((s) => s.id).filter((id) => id !== 'submit_job' && id !== 'build_tool' && !id.startsWith('job.')).sort();
  const exposedSkillIds = A2A_SKILL_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(cardSkillIds, exposedSkillIds);
  assert.deepEqual(cardSkillIds, ['check_agent_card', 'check_domain_age', 'check_hostname_reputation', 'check_ip_abuse', 'check_package', 'check_wallet_age', 'check_wallet_sanctions', 'check_x402_endpoint', 'get_cve_batch', 'get_cve_by_product', 'get_cve_details', 'get_threat_actor_profile', 'get_usage_status', 'hosting_advisor', 'preflight_check', 'verify_result']);
});

test('agent card: paid skills are tagged paid and name the price; the a2a-x402 extension is declared, not required', () => {
  const paid = ['preflight_check', 'hosting_advisor', 'get_cve_batch', 'get_cve_by_product', 'get_cve_details', 'get_threat_actor_profile'];
  for (const skill of card.skills.filter((s) => s.id !== 'submit_job' && s.id !== 'build_tool' && !s.id.startsWith('job.'))) {
    assert.equal(skill.tags.includes('paid'), paid.includes(skill.id), skill.id);
    if (paid.includes(skill.id)) assert.match(skill.description, /0\.01 USD via x402.*5\/day free tier \(automatic\)/, skill.id);
  }
  const ext = card.capabilities.extensions.find((e) => /a2a-x402/.test(e.uri));
  assert.ok(ext);
  assert.equal(ext.required, false);
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
