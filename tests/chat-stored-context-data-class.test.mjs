/**
 * 21 Oct, request 18pjehlf onwards: every chat reply failed with "No AI
 * engine is configured or within its daily budget". One saved message in
 * the last 12 (public.messages) held customer data (an email address), so
 * every later operator turn was classed "customer" and only the paid keys
 * were planned; both were out of credit, so the plan was empty. Failed turns
 * are not saved, so that message never scrolled out and the chat stayed
 * stuck.
 *
 * Now stored context (saved messages, the thread's earlier turns and
 * summary, the error log, the threat and vault blocks) is masked before it
 * reaches an engine or the privacy check (lib/aiRouter.mjs
 * redactCustomerData); only the new message decides the data class.
 *
 * Run with: node --test tests/chat-stored-context-data-class.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { redactCustomerData, redactCustomerBlock, containsCustomerData, dataClassFor, EMAIL_MASK, PHONE_MASK, USAGE_OMITTED, DATA, __resetRouterState } from '../lib/aiRouter.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const FREE_KEY = 'stub-free-key';
const PAID_KEY = 'stub-paid-key';
const SAVED_EMAIL = 'jane.customer@example.com';

let calls;
let savedMessages;

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY_FREE = FREE_KEY;
  process.env.GEMINI_API_KEY_PAID = PAID_KEY;
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GITHUB_MODELS_TOKEN', 'CLOUDFLARE_API_TOKEN', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'USER_API_USER']) delete process.env[k];
}

function geminiKeyOf(url, options) {
  const h = (options && options.headers) || {};
  return h['x-goog-api-key'] || h['X-Goog-Api-Key'] || new URL(String(url)).searchParams.get('key');
}

function installFetch() {
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      const key = geminiKeyOf(url, options);
      const body = options && typeof options.body === 'string' ? options.body : '';
      calls.push({ key, body });
      if (key === PAID_KEY) {
        const text = JSON.stringify({ error: { code: 402, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted.' } });
        return new Response(text, { status: 402, headers: { 'Content-Type': 'application/json' } });
      }
      const ok = { candidates: [{ content: { parts: [{ text: 'Free engine reply.' }] }, finishReason: 'STOP' }] };
      if (u.includes('streamGenerateContent')) return new Response(`data: ${JSON.stringify(ok)}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(JSON.stringify(ok), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/rest/v1/messages?select=role,content')) return new Response(JSON.stringify(savedMessages), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/rest/v1/')) return new Response(u.includes('method=') ? '' : '[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/storage/v1/')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
  if (typeof __resetRouterState === 'function') __resetRouterState();
  calls = [];
  savedMessages = [];
  installFetch();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; }, write() { return true; }
  };
}

async function ask(prompt, extra = {}) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: '10.9.0.1' }, body: { prompt, user: 'test-operator', pass: 'test-secret-pass', ...extra } }, res);
  return res;
}

test('redactCustomerData: emails and phone numbers masked, a usage report left out, plain text untouched', () => {
  assert.equal(redactCustomerData(`write to ${SAVED_EMAIL} today`), `write to ${EMAIL_MASK} today`);
  assert.equal(redactCustomerData('call +44 20 7946 0958 now'), `call ${PHONE_MASK} now`);
  assert.equal(redactCustomerData('### [USAGE] 7d\nTop MCP clients: a, b'), USAGE_OMITTED);
  assert.equal(redactCustomerData('the lab run finished at 18:45'), 'the lab run finished at 18:45');
  assert.equal(redactCustomerBlock(`row one\nfrom ${SAVED_EMAIL}\nrow three`), `row one\nfrom ${EMAIL_MASK}\nrow three`);
  for (const masked of [EMAIL_MASK, PHONE_MASK, USAGE_OMITTED]) assert.equal(containsCustomerData(masked), false, masked);
  // Masked stored context no longer makes the operator's turn customer data;
  // customer data in the new message still does.
  assert.equal(dataClassFor({ isOperator: true, texts: ['hello', redactCustomerData(`AGENT: sent to ${SAVED_EMAIL}`)] }), DATA.OPERATOR);
  assert.equal(dataClassFor({ isOperator: true, texts: [`email ${SAVED_EMAIL} the report`, ''] }), DATA.CUSTOMER);
  assert.equal(dataClassFor({ isOperator: false, texts: ['hello'] }), DATA.CUSTOMER);
});

test('an email in a saved message no longer stops the chat: the operator turn goes to the free key while the paid key is out of credit', async () => {
  savedMessages = [
    { role: 'model', content: `Done. I drafted the note for ${SAVED_EMAIL}.` },
    { role: 'user', content: 'thanks' }
  ];
  const res = await ask('how are you doing?');
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(String(res.body && res.body.reply), /Free engine reply\./);
  const freeCalls = calls.filter((c) => c.key === FREE_KEY);
  assert.ok(freeCalls.length >= 1, 'the free key answered');
  assert.equal(calls.filter((c) => c.key === PAID_KEY).length, 0, 'nothing went to the paid key');
  // The free engine never saw the saved email address.
  for (const c of calls) assert.ok(!c.body.includes(SAVED_EMAIL), 'the saved email address reached an engine');
  assert.ok(freeCalls.some((c) => c.body.includes(EMAIL_MASK)), 'the saved message reached the engine masked');
});

test('a usage report or phone number in the thread history does not stop the chat either, and never reaches the free engine', async () => {
  const history = [
    { role: 'user', text: 'show usage' },
    { role: 'assistant', text: '### [USAGE] 7 days\nDistinct callers: 12\nTop MCP clients: alpha-bot, beta-bot' },
    { role: 'user', text: 'call me on +44 20 7946 0958 later' },
    { role: 'assistant', text: 'Noted.' }
  ];
  const res = await ask('what should we work on next?', { history });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(String(res.body && res.body.reply), /Free engine reply\./);
  assert.equal(calls.filter((c) => c.key === PAID_KEY).length, 0);
  for (const c of calls) {
    assert.ok(!/alpha-bot|Distinct callers/i.test(c.body), 'the usage report reached an engine');
    assert.ok(!c.body.includes('7946 0958'), 'the phone number reached an engine');
  }
});

test('customer data in the new message itself still keeps it off the free key', async () => {
  const res = await ask(`draft a reply to ${SAVED_EMAIL} about the invoice`);
  assert.equal(calls.filter((c) => c.key === FREE_KEY).length, 0, 'the free key must not see a message with customer data');
  assert.ok(calls.some((c) => c.key === PAID_KEY), 'the paid key was tried');
  assert.notEqual(String(res.body && res.body.reply), 'Free engine reply.');
});

test('/export still shows the operator the saved messages as they are', async () => {
  savedMessages = [{ role: 'model', content: `Sent to ${SAVED_EMAIL}.` }];
  const res = await ask('/export');
  assert.equal(res.statusCode, 200);
  assert.ok(String(res.body.reply).includes(SAVED_EMAIL));
  assert.equal(calls.length, 0, 'a command reply calls no engine');
});
