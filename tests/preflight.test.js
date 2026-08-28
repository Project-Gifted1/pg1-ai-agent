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
const backendOriginScript = fs.readFileSync(path.resolve(__dirname, '../backend-origin.js'), 'utf8');

test('composer placeholder stays friendly and PG1-branded', () => {
  assert.ok(!html.includes('Execute directive or query agent'), 'Old placeholder still present');
  assert.ok(html.includes('Message PG1 Sovereign Agent™...'), 'Expected current placeholder not found');
});

test('mobile layout keeps the small-screen media rule', () => {
  assert.ok(html.includes('@media (max-width: 390px)'), 'Small-screen media rule missing');
});

test('mobile composer keeps the voice input control', () => {
  assert.ok(html.includes('id="micBtn"'), 'Voice input button missing from composer');
});

test('mobile composer keeps the send control', () => {
  assert.ok(html.includes('id="sendBtn"'), 'Send button missing from composer');
});

test('root entrypoint loads the shared backend origin helper', () => {
  assert.ok(html.includes('<script src="./backend-origin.js"></script>'), 'Root helper script tag missing');
  assert.ok(html.includes('fetch(window.PG1_CHAT_API_URL'), 'Root entrypoint is not using shared chat API URL');
});

test('public entrypoint loads the shared backend origin helper', () => {
  assert.ok(publicHtml.includes('<script src="../backend-origin.js"></script>'), 'Public helper script tag missing');
  assert.ok(publicHtml.includes('fetch(window.PG1_CHAT_API_URL'), 'Public entrypoint is not using shared chat API URL');
});

test('static entrypoints no longer call relative /api/chat directly', () => {
  assert.ok(!html.includes("fetch('/api/chat'"), 'Root entrypoint still fetches relative /api/chat');
  assert.ok(!publicHtml.includes("fetch('/api/chat'"), 'Public entrypoint still fetches relative /api/chat');
});

test('backend origin helper defaults to the Vercel API origin', () => {
  assert.ok(backendOriginScript.includes("const DEFAULT_BACKEND_ORIGIN = 'https://pg1-ai-agent.vercel.app';"), 'Default backend origin mismatch');
  assert.ok(backendOriginScript.includes("window.PG1_CHAT_API_URL = resolveBackendUrl('/api/chat');"), 'Chat API URL helper missing');
});
