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

const backendOrigin = require('../backend-origin.js');
const chatHandler = require('../api/chat.js');
const SelfHealingEngine = require('../api/lib/self-healing');
const MemorySystem = require('../api/lib/memory-system');
const { PG1CostTracker } = require('../lib/costTracker');

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
const deployWorkflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/deploy.yml'), 'utf8');

test('root composer keeps the existing PG1-branded placeholder', () => {
  assert.ok(!html.includes('Execute directive or query agent'), 'Old placeholder still present');
  assert.ok(html.includes('Message PG1 Sovereign Agent™...'), 'Expected root composer placeholder not found');
});

test('root composer keeps voice input controls', () => {
  assert.ok(html.includes('id="micBtn"'), 'Voice input button missing from root entrypoint');
  assert.ok(html.includes('SpeechRecognition'), 'Speech recognition wiring missing from root entrypoint');
});

test('public entrypoint keeps quick-action buttons', () => {
  assert.ok(publicHtml.includes('class="action-row"'), 'Quick-action row missing from public entrypoint');
  assert.ok(publicHtml.includes('Status Report'), 'Expected quick-action label missing from public entrypoint');
});

test('public composer keeps the streamlined placeholder', () => {
  assert.ok(publicHtml.includes('placeholder="Initialize sequence..."'), 'Expected public composer placeholder not found');
});

test('static entrypoints load the shared backend origin helper', () => {
  assert.ok(html.includes('<script src="./backend-origin.js"></script>'), 'Root entrypoint helper missing');
  assert.ok(publicHtml.includes('<script src="../backend-origin.js"></script>'), 'Public entrypoint helper missing');
});

test('static entrypoints build chat requests from the shared backend origin helper', () => {
  assert.ok(html.includes("window.PG1_BUILD_BACKEND_URL('/api/chat')"), 'Root entrypoint is not using the shared backend origin helper');
  assert.ok(publicHtml.includes("window.PG1_BUILD_BACKEND_URL('/api/chat')"), 'Public entrypoint is not using the shared backend origin helper');
  assert.ok(!html.includes("fetch('/api/chat'"), 'Root entrypoint still uses a relative /api/chat request');
  assert.ok(!publicHtml.includes("fetch('/api/chat'"), 'Public entrypoint still uses a relative /api/chat request');
});

test('backend origin helper defaults to the production backend and builds absolute API URLs', () => {
  delete globalThis.PG1_BACKEND_ORIGIN;
  assert.equal(backendOrigin.defaultBackendOrigin, 'https://pg1-ai-agent.vercel.app');
  assert.equal(backendOrigin.backendOrigin, 'https://pg1-ai-agent.vercel.app');
  assert.equal(backendOrigin.buildApiUrl('/api/chat'), 'https://pg1-ai-agent.vercel.app/api/chat');
});

test('backend origin helper accepts a runtime override', () => {
  const original = globalThis.PG1_BACKEND_ORIGIN;
  globalThis.PG1_BACKEND_ORIGIN = 'https://example.com/custom/path';

  try {
    assert.equal(backendOrigin.backendOrigin, 'https://example.com');
    assert.equal(backendOrigin.buildApiUrl('api/media/voice'), 'https://example.com/api/media/voice');
  } finally {
    if (typeof original === 'undefined') delete globalThis.PG1_BACKEND_ORIGIN;
    else globalThis.PG1_BACKEND_ORIGIN = original;
  }
});

test('memory and voice cost logs use tmp-backed writable paths by default', () => {
  delete process.env.PG1_MEMORY_FILE;
  delete process.env.PG1_VOICE_LOG_FILE;

  const memorySystem = new MemorySystem();
  const costTracker = new PG1CostTracker();

  assert.equal(memorySystem.memoryFile, path.join('/tmp', '.pg1-memory.json'));
  assert.equal(costTracker.logFile, path.join('/tmp', 'voice-generation-logs.jsonl'));
});

test('deploy workflow uses a unique Pages artifact name to avoid collisions', () => {
  assert.ok(deployWorkflow.includes('name: github-pages-${{ github.run_id }}-${{ github.run_attempt }}'), 'Unique Pages artifact name missing');
  assert.ok(deployWorkflow.includes('artifact_name: github-pages-${{ github.run_id }}-${{ github.run_attempt }}'), 'Deploy step is not pinned to the unique artifact name');
});

test('chat handler accepts the static frontend send payload and applies allowed-origin CORS', async () => {
  const originalFetch = global.fetch;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalGeminiKey1 = process.env.GEMINI_API_KEY1;
  const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;
  process.env.GEMINI_API_KEY = '';
  process.env.GEMINI_API_KEY1 = 'test-key';
  process.env.ALLOWED_ORIGINS = 'https://project-gifted1.github.io';

  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      text: async () => JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'Acknowledged.' }]
            }
          }
        ]
      })
    };
  };

  const req = {
    method: 'POST',
    headers: { origin: 'https://project-gifted1.github.io' },
    body: { message: 'Hello from Pages' }
  };
  const res = createMockResponse();

  try {
    await chatHandler(req, res);
  } finally {
    global.fetch = originalFetch;
    restoreEnv('GEMINI_API_KEY', originalGeminiKey);
    restoreEnv('GEMINI_API_KEY1', originalGeminiKey1);
    restoreEnv('ALLOWED_ORIGINS', originalAllowedOrigins);
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://project-gifted1.github.io');
  assert.equal(res.body.reply, 'Acknowledged.');
  assert.equal(new URL(fetchCalls[0].url).hostname, 'generativelanguage.googleapis.com');
  assert.equal(JSON.parse(fetchCalls[0].options.body).contents[0].parts[0].text, 'Hello from Pages');
});

test('chat handler rejects oversize payloads before contacting the upstream model', async () => {
  const originalFetch = global.fetch;
  const originalMaxLength = process.env.MAX_MESSAGE_LENGTH;
  const originalGeminiKey = process.env.GEMINI_API_KEY1;
  process.env.MAX_MESSAGE_LENGTH = '4';
  process.env.GEMINI_API_KEY1 = 'test-key';
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called');
  };

  const req = {
    method: 'POST',
    headers: {},
    body: { message: '12345' }
  };
  const res = createMockResponse();

  try {
    await chatHandler(req, res);
  } finally {
    global.fetch = originalFetch;
    restoreEnv('MAX_MESSAGE_LENGTH', originalMaxLength);
    restoreEnv('GEMINI_API_KEY1', originalGeminiKey);
  }

  assert.equal(res.statusCode, 413);
  assert.equal(fetchCalled, false);
});

function createMockResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
}

function restoreEnv(key, value) {
  if (typeof value === 'undefined') delete process.env[key];
  else process.env[key] = value;
}
