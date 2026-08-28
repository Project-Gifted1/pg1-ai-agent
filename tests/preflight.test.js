/**
 * PG1 Sovereign Agent™ – Pre-flight Checks
 *
 * Validates:
 *  1. Greeting inputs are handled gracefully (no error/template response)
 *  2. Fallback text is contextual and non-generic for known request types
 *  3. Typo-tolerant matching (e.g., "lastest" → upgrade branch)
 *  4. Generic fallback includes the original prompt excerpt (not boilerplate)
 *  5. Static entrypoints load shared absolute backend wiring
 *  6. Static entrypoints expose mobile multimodal controls and quick chips
 *
 * Run with: node tests/preflight.test.js   (or: npm test)
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SelfHealingEngine = require('../api/lib/self-healing');

const engine = new SelfHealingEngine(null, null, null);
const FORBIDDEN_TEMPLATE = 'I encountered a challenge with this request';

function readRepoFile(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

const rootHtml = readRepoFile('index.html');
const publicHtml = readRepoFile('public/index.html');
const backendHelper = readRepoFile('backend-origin.js');
const uiScript = readRepoFile('static-chat-ui.js');
const uiStyles = readRepoFile('static-chat-ui.css');

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

// ── Static frontend checks ────────────────────────────────────────────────────

test('backend-origin helper defaults to the deployed PG1 Vercel origin', () => {
  assert.match(backendHelper, new RegExp("DEFAULT_ORIGIN\\s*=\\s*'https://pg1-ai-agent\\.vercel\\.app'"), 'Expected PG1 backend origin default not found');
  assert.ok(backendHelper.includes('PG1_CHAT_API_URL'), 'Shared chat API URL export missing');
});

test('static UI script sends chat requests through the shared absolute chat API URL', () => {
  assert.ok(uiScript.includes('window.PG1_CHAT_API_URL'), 'Shared PG1 chat API URL is not used');
  assert.ok(!uiScript.includes("fetch('/api/chat'"), 'Relative /api/chat call still present in shared UI script');
});

test('root entrypoint loads the shared backend helper and shared UI assets', () => {
  assert.ok(rootHtml.includes('./backend-origin.js'), 'Root backend-origin helper reference missing');
  assert.ok(rootHtml.includes('./static-chat-ui.js'), 'Root shared UI script reference missing');
  assert.ok(rootHtml.includes('./static-chat-ui.css'), 'Root shared UI stylesheet reference missing');
});

test('public entrypoint loads the shared backend helper and shared UI assets', () => {
  assert.ok(publicHtml.includes('../backend-origin.js'), 'Public backend-origin helper reference missing');
  assert.ok(publicHtml.includes('../static-chat-ui.js'), 'Public shared UI script reference missing');
  assert.ok(publicHtml.includes('../static-chat-ui.css'), 'Public shared UI stylesheet reference missing');
});

test('entrypoints no longer hardcode relative /api/chat assumptions', () => {
  assert.ok(!rootHtml.includes("fetch('/api/chat'"), 'Root entrypoint still contains a relative /api/chat call');
  assert.ok(!publicHtml.includes("fetch('/api/chat'"), 'Public entrypoint still contains a relative /api/chat call');
  assert.ok(!rootHtml.includes('Verify `/api/chat` is running'), 'Root entrypoint still references relative /api/chat troubleshooting');
});

test('composer placeholder stays friendly and assistant-like', () => {
  assert.ok(rootHtml.includes('Ask anything or add media context'), 'Expected friendly root placeholder not found');
  assert.ok(publicHtml.includes('Ask anything or add media context'), 'Expected friendly public placeholder not found');
});

test('quick-action chips remain wrapped for mobile scroll fade', () => {
  assert.ok(rootHtml.includes('action-row-wrap'), 'Root action-row-wrap wrapper not found');
  assert.ok(publicHtml.includes('action-row-wrap'), 'Public action-row-wrap wrapper not found');
  assert.ok(uiStyles.includes('action-row-wrap::after'), 'Scroll-fade CSS rule not found');
  assert.ok(uiStyles.includes('-webkit-overflow-scrolling'), 'iOS scroll hint missing from action row styles');
});

test('both entrypoints expose multimodal image, video, mic, and voice controls', () => {
  for (const html of [rootHtml, publicHtml]) {
    assert.ok(html.includes('id="imageBtn"'), 'Image button missing');
    assert.ok(html.includes('id="videoBtn"'), 'Video button missing');
    assert.ok(html.includes('id="micBtn"'), 'Microphone button missing');
    assert.ok(html.includes('id="voiceBtn"'), 'Voice button missing');
    assert.ok(html.includes('accept="image/*"'), 'Image file input missing');
    assert.ok(html.includes('accept="video/*"'), 'Video file input missing');
  }
});
