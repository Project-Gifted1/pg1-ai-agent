/**
 * PG1 Sovereign Agent™ – Pre-flight Checks
 *
 * Validates:
 *  1. Greeting inputs are handled gracefully (no error/template response)
 *  2. Fallback text is contextual and non-generic for known request types
 *  3. Typo-tolerant matching (e.g., "lastest" → upgrade branch)
 *  4. Generic fallback includes the original prompt excerpt (not boilerplate)
 *  5. HTML: composer placeholder is friendly
 *  6. HTML: quick-action chips are wrapped for mobile scroll-fade
 *
 * Run with: node tests/preflight.test.js   (or: npm test)
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SelfHealingEngine = require('../api/lib/self-healing');
const frontendConfig = require('../frontend-config.js');

// Minimal stubs — we only test generateFallbackResponse here
const engine = new SelfHealingEngine(null, null, null);

const FORBIDDEN_TEMPLATE = 'I encountered a challenge with this request';

// ── Fallback response tests ───────────────────────────────────────────────────

test('greeting "Hi" does not trigger template fallback', () => {
  const reply = engine.generateFallbackResponse('Hi', {});
  assert.ok(!reply.includes(FORBIDDEN_TEMPLATE), `Got template response: ${reply}`);
});

test('greeting "Hello" returns a welcoming message', () => {
  const reply = engine.generateFallbackResponse('Hello', {});
  assert.ok(
    reply.toLowerCase().includes('hello') || reply.toLowerCase().includes('ready'),
    `Unexpected response: ${reply}`
  );
});

test('greeting "hey" (lowercase) is handled gracefully', () => {
  const reply = engine.generateFallbackResponse('hey', {});
  assert.ok(!reply.includes(FORBIDDEN_TEMPLATE), `Got template response: ${reply}`);
});

test('greeting with trailing words ("Hi there!") is handled gracefully', () => {
  const reply = engine.generateFallbackResponse('Hi there!', {});
  assert.ok(!reply.includes(FORBIDDEN_TEMPLATE), `Got template response: ${reply}`);
});

test('"Good morning" greeting is handled gracefully', () => {
  const reply = engine.generateFallbackResponse('Good morning', {});
  assert.ok(!reply.includes(FORBIDDEN_TEMPLATE), `Got template response: ${reply}`);
});

test('"What\'s your lastest upgrades" is routed to upgrade branch (typo-tolerant)', () => {
  const reply = engine.generateFallbackResponse("What's your lastest upgrades", {});
  assert.ok(
    reply.toLowerCase().includes('upgrade') || reply.toLowerCase().includes('self-healing'),
    `Expected upgrade info, got: ${reply}`
  );
});

test('"latest upgrades" routes to upgrade branch', () => {
  const reply = engine.generateFallbackResponse('What are your latest upgrades?', {});
  assert.ok(reply.toLowerCase().includes('upgrade'), `Expected upgrade info, got: ${reply}`);
});

test('generic fallback includes the original prompt excerpt', () => {
  const prompt = 'Something completely random that matches nothing';
  const reply = engine.generateFallbackResponse(prompt, {});
  assert.ok(reply.includes('Something completely random'), `Expected prompt excerpt, got: ${reply}`);
  assert.ok(!reply.includes(FORBIDDEN_TEMPLATE), 'Got template response');
});

test('create/generate request uses build-focused response', () => {
  const reply = engine.generateFallbackResponse('create a new module', {});
  assert.ok(reply.toLowerCase().includes('build') || reply.toLowerCase().includes('goal'), `Got: ${reply}`);
});

test('debug/fix request uses debug-focused response', () => {
  const reply = engine.generateFallbackResponse('fix this broken function', {});
  assert.ok(reply.toLowerCase().includes('error') || reply.toLowerCase().includes('root cause'), `Got: ${reply}`);
});

test('status request uses status-focused response', () => {
  const reply = engine.generateFallbackResponse('show system status', {});
  assert.ok(reply.toLowerCase().includes('operational') || reply.toLowerCase().includes('node'), `Got: ${reply}`);
});

// ── HTML checks ───────────────────────────────────────────────────────────────

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const publicHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

test('index.html keeps the mobile composer and voice controls', () => {
  assert.ok(html.includes('placeholder="Message PG1 Sovereign Agent™..."'), 'Expected chat composer placeholder not found');
  assert.ok(html.includes('id="micBtn"'), 'Voice input button missing from index.html');
});

test('index.html still exposes speech recognition wiring', () => {
  assert.ok(html.includes('SpeechRecognition'), 'Speech recognition wiring missing from index.html');
});

test('public/index.html keeps the mobile quick-action row', () => {
  assert.ok(publicHtml.includes('class="action-row"'), 'Quick-action row missing from public/index.html');
  assert.ok(publicHtml.includes('overflow-x: auto'), 'Quick-action row no longer scrolls horizontally');
});

test('public/index.html keeps the existing composer placeholder', () => {
  assert.ok(publicHtml.includes('placeholder="Initialize sequence..."'), 'Expected public composer placeholder not found');
});

test('frontend config builds an absolute backend chat URL', () => {
  const originalOverride = globalThis.PG1_BACKEND_ORIGIN;
  delete globalThis.PG1_BACKEND_ORIGIN;

  try {
    assert.equal(frontendConfig.defaultBackendOrigin, 'https://pg1-ai-agent.vercel.app');
    assert.equal(frontendConfig.backendOrigin, 'https://pg1-ai-agent.vercel.app');
    assert.equal(frontendConfig.buildApiUrl('/api/chat'), 'https://pg1-ai-agent.vercel.app/api/chat');
  } finally {
    if (typeof originalOverride === 'undefined') delete globalThis.PG1_BACKEND_ORIGIN;
    else globalThis.PG1_BACKEND_ORIGIN = originalOverride;
  }
});

test('index.html uses shared frontend config instead of relative /api/chat', () => {
  assert.ok(html.includes('frontend-config.js'), 'Shared frontend config script missing from index.html');
  assert.ok(!html.includes("fetch('/api/chat'"), 'index.html still uses relative /api/chat');
});

test('public/index.html uses shared frontend config instead of relative /api/chat', () => {
  assert.ok(publicHtml.includes('frontend-config.js'), 'Shared frontend config script missing from public/index.html');
  assert.ok(!publicHtml.includes("fetch('/api/chat'"), 'public/index.html still uses relative /api/chat');
});
