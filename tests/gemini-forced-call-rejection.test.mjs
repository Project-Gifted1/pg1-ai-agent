/*
 * Recall questions failing live after #261: "do you remember Blanco Ekama?"
 * returned "Execution failed... Request ID: ..." with model_failed in the
 * error log, while non-recall chat and web search still worked.
 *
 * The cause: Gemini's function declaration schema accepts a fixed set of
 * keywords, and an unknown one fails the whole request with 400
 * INVALID_ARGUMENT. The operator-only get_usage_stats and search_history
 * schemas carry additionalProperties: false, so every operator tools
 * request was rejected. Before #261 that was hidden: a tools round that
 * wrote nothing fell through to the web-search request, which carries no
 * declarations. #261 rightly stopped recall questions from falling through,
 * so the rejection reached the operator. The stub models in
 * recall-routing.test.mjs accepted any schema, so they could not see it.
 *
 * tests/fixtures/gemini-400-unknown-schema-field.json is that 400 in the
 * Gemini API's error format ({ error: { code, message, status, details } }).
 * The stub below validates declarations the way the API does and answers
 * with it, so a schema keyword Gemini does not accept fails these tests.
 *
 * Covered here:
 *   - the declarations sent to Gemini carry only keywords it accepts;
 *   - if the forced request is still rejected, the round is retried once
 *     with search_history offered but not forced, plus the recall
 *     instruction, never with web search;
 *   - the provider's error text (not the first bytes of its JSON) lands in
 *     the pg1_errors row, secrets stripped.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSseParser } from '../lib/chatStream.mjs';

const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
const { chatToolsForRole, toGeminiFunctionDeclarations, GEMINI_SCHEMA_KEYS, SEARCH_HISTORY_TOOL, USAGE_STATS_TOOL, RECALL_RETRY_INSTRUCTION } = await import('../lib/chatTools.mjs');
const { providerErrorText } = await import('../lib/upstreamFailure.mjs');

const GEMINI_400 = readFileSync(new URL('./fixtures/gemini-400-unknown-schema-field.json', import.meta.url), 'utf8');
const GEMINI_KEY = 'AIzaStubGeminiKeyForForcedCallTests0000000';
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const RECALL = 'do you remember Blanco Ekama?';
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const BLANKO_ROWS = [
  { id: 7, role: 'user', content: 'Blanko Ekama is sending the contract on Monday.', created_at: '2026-09-24T09:15:00Z', match_type: 'any_word', score: 0.5 }
];

beforeEach(() => {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key-forced-0000';
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'OPENAI_API_KEY', 'PG1_CHAT_TOOL_TIMEOUT_MS']) delete process.env[k];
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

// Every schema keyword outside what Gemini accepts, with where it sits, the
// way the API reports it ('tools[0].function_declarations[N].parameters').
function unknownSchemaFields(declarations) {
  const found = [];
  const walk = (schema, at) => {
    if (!schema || typeof schema !== 'object') return;
    for (const [key, value] of Object.entries(schema)) {
      if (!GEMINI_SCHEMA_KEYS.has(key)) found.push(`${key} at ${at}`);
      else if (key === 'properties') for (const [name, sub] of Object.entries(value || {})) walk(sub, `${at}.properties.${name}`);
      else if (key === 'items') walk(value, `${at}.items`);
      else if (key === 'anyOf') (value || []).forEach((sub, i) => walk(sub, `${at}.anyOf[${i}]`));
    }
  };
  (declarations || []).forEach((d, i) => walk(d.parameters, `tools[0].function_declarations[${i}].parameters`));
  return found;
}

// --- the declarations ------------------------------------------------------------

test('the operator declarations sent to Gemini carry only schema keywords it accepts', () => {
  const tools = chatToolsForRole('operator');
  // The source schemas do use additionalProperties (Anthropic and MCP keep it).
  assert.equal(tools.find((t) => t.name === SEARCH_HISTORY_TOOL).inputSchema.additionalProperties, false);
  assert.equal(tools.find((t) => t.name === USAGE_STATS_TOOL).inputSchema.additionalProperties, false);
  const declarations = toGeminiFunctionDeclarations(tools);
  assert.deepEqual(unknownSchemaFields(declarations), []);
  const history = declarations.find((d) => d.name === SEARCH_HISTORY_TOOL);
  assert.deepEqual(history.parameters.required, ['query']);
  assert.deepEqual(Object.keys(history.parameters.properties).sort(), ['from', 'query', 'to']);
  // The source schemas as they are: `default` was always dropped, but the
  // two additionalProperties are the fields the API's 400 names.
  const raw = tools.map((t) => ({ name: t.name, parameters: t.inputSchema }));
  assert.deepEqual(unknownSchemaFields(raw), [
    'default at tools[0].function_declarations[3].parameters.properties.chain',
    // check_package (1.16.0) is the 5th read-only tool, so the two
    // operator-only tools moved up one place.
    'additionalProperties at tools[0].function_declarations[11].parameters',
    'additionalProperties at tools[0].function_declarations[12].parameters'
  ]);
});

test('providerErrorText reads the reason out of the Gemini error body', () => {
  const text = providerErrorText(400, GEMINI_400);
  assert.match(text, /^400 INVALID_ARGUMENT: Invalid JSON payload received\. Unknown name "additionalProperties" at 'tools\[0\]\.function_declarations\[10\]\.parameters': Cannot find field\./);
  assert.ok(!/[\n{]/.test(text), 'one line, no JSON');
  assert.ok(text.length <= 240);
  assert.equal(providerErrorText(503, 'upstream connect error'), '503: upstream connect error');
  assert.equal(providerErrorText(529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), '529 overloaded_error: Overloaded');
});

// --- through the chat handler ----------------------------------------------------

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.67.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}` }, body });
function makeRes() {
  return {
    statusCode: null, headers: {}, jsonBody: null, chunks: [],
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; },
    end() { return this; },
    on() {}
  };
}
async function chat(body) {
  const res = makeRes();
  await chatHandler(makeReq(body), res);
  return res;
}
function replyOf(res, stream) {
  if (!stream) return res.jsonBody.reply;
  const out = [];
  const parser = createSseParser(({ data }) => out.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return out.filter((e) => e.type === 'text' || e.type === 'error').map((e) => e.text || e.message || '').join('');
}

const hasSearch = (body) => (body.tools || []).some((t) => t.google_search);
const declarationsOf = (body) => (body.tools || []).flatMap((t) => t.functionDeclarations || []);
const hasResponses = (body) => (body.contents || []).some((c) => (c.parts || []).some((p) => p.functionResponse));
const systemOf = (body) => ((body.systemInstruction || {}).parts || []).map((p) => p.text).join('');
const modeOf = (body) => ((body.toolConfig || {}).functionCallingConfig || {}).mode;
const forced = (body) => modeOf(body) === 'ANY' && (((body.toolConfig || {}).functionCallingConfig || {}).allowedFunctionNames || []).includes(SEARCH_HISTORY_TOOL);

// A Gemini stub that checks requests the way the API does: an unknown schema
// keyword is a 400 with the fixture body. `rejectForced` also answers every
// forced request with that 400 (a model that will not take mode ANY).
// Otherwise it behaves like the live model: on AUTO it calls search_history
// only when the system prompt carries the recall instruction, forced it
// calls it, and given the results it answers from them.
function installFetch({ rejectForced = false, rejectAll = false } = {}) {
  const calls = [];
  const reply = (u, status, payload) => {
    if (status !== 200) return new Response(payload, { status, headers: { 'Content-Type': 'application/json' } });
    return u.includes('streamGenerateContent') ? new Response(`data: ${JSON.stringify(payload)}\n\n`) : Response.json(payload);
  };
  const gemini = (u, body) => {
    if (rejectAll || unknownSchemaFields(declarationsOf(body)).length || (rejectForced && forced(body))) return reply(u, 400, GEMINI_400);
    if (hasSearch(body)) return reply(u, 200, { candidates: [{ content: { parts: [{ text: 'According to search results, Blanko Ekama is an independent musical artist.' }] } }] });
    if (hasResponses(body)) return reply(u, 200, { candidates: [{ content: { parts: [{ text: "I found a close match: on 2026-09-24 you said 'Blanko Ekama is sending the contract on Monday.' - is that who you mean?" }] } }] });
    const call = forced(body) || (modeOf(body) === 'AUTO' && systemOf(body).includes(RECALL_RETRY_INSTRUCTION));
    if (call) return reply(u, 200, { candidates: [{ content: { parts: [{ functionCall: { name: SEARCH_HISTORY_TOOL, args: { query: 'Blanco Ekama' } } }] } }] });
    return reply(u, 200, { candidates: [{ content: { parts: [{ text: '' }] } }] });
  };
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    let body = null;
    try { body = options.body ? JSON.parse(options.body) : null; } catch (e) { body = options.body; }
    calls.push({ url: u, method: options.method || 'GET', body });
    if (u.includes('generativelanguage.googleapis.com')) return gemini(u, body);
    if (u.includes('/rest/v1/messages?') && u.includes('content_tsv=')) return Response.json([]);
    if (u.includes('/rest/v1/rpc/search_messages_fallback')) return Response.json(BLANKO_ROWS);
    if (u.includes('/rest/v1/pg1_errors')) return new Response(options.method === 'POST' ? '' : '[]', { status: options.method === 'POST' ? 201 : 200 });
    if (u.includes('/rest/v1/') || u.includes('/storage/v1/')) return Response.json([]);
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}
const geminiRequests = (calls) => calls.filter((c) => c.url.includes('generativelanguage.googleapis.com'));

// The fire-and-forget pg1_errors writes, once they land.
async function errorRows(calls, reason) {
  for (let i = 0; i < 50; i++) {
    const rows = calls.filter((c) => c.url.includes('/rest/v1/pg1_errors') && (c.method === 'POST' || c.method === 'PATCH')).map((c) => c.body);
    const match = rows.filter((r) => r.reason === reason);
    if (match.length) return match;
    await new Promise((r) => setTimeout(r, 5));
  }
  return [];
}

for (const stream of [false, true]) {
  const path = stream ? 'streamed' : 'JSON';
  const ask = (prompt) => chat({ prompt, ...OPERATOR, ...(stream ? { stream: true } : {}) });

  test(`${path}: the forced search_history request is accepted by a Gemini that validates the schema`, async () => {
    const calls = installFetch();
    const res = await ask(RECALL);
    assert.equal(res.statusCode, 200);
    const gem = geminiRequests(calls);
    assert.ok(forced(gem[0].body), 'round 1 requires search_history');
    assert.deepEqual(unknownSchemaFields(declarationsOf(gem[0].body)), []);
    assert.ok(gem.every((c) => !hasSearch(c.body)), 'no web search');
    assert.ok(calls.some((c) => c.url.includes('search_messages_fallback')), 'the history was searched');
    assert.match(replyOf(res, stream), /Blanko Ekama is sending the contract/);
    assert.doesNotMatch(replyOf(res, stream), /Execution failed|musical artist/);
  });

  test(`${path}: when the forced request is rejected, the round is retried once unforced with the recall instruction, never with web search`, async () => {
    const calls = installFetch({ rejectForced: true });
    const res = await ask(RECALL);
    assert.equal(res.statusCode, 200);
    const gem = geminiRequests(calls);
    assert.ok(forced(gem[0].body), 'the first attempt is forced');
    const retry = gem[1].body;
    assert.equal(modeOf(retry), 'AUTO', 'the retry is not forced');
    assert.ok(declarationsOf(retry).some((d) => d.name === SEARCH_HISTORY_TOOL), 'search_history still offered');
    assert.ok(systemOf(retry).includes(RECALL_RETRY_INSTRUCTION), 'with the recall instruction');
    assert.ok(!systemOf(gem[0].body).includes(RECALL_RETRY_INSTRUCTION), 'which the forced request did not need');
    assert.equal(gem.filter((c) => forced(c.body)).length, 1, 'forcing is dropped after one rejection');
    assert.ok(gem.every((c) => !hasSearch(c.body)), 'no web search at any point');
    assert.ok(calls.some((c) => c.url.includes('search_messages_fallback')), 'the history was searched');
    assert.match(replyOf(res, stream), /Blanko Ekama is sending the contract/);
    // The rejection is still logged, with Gemini's own reason.
    const [row] = await errorRows(calls, 'forced_tool_rejected');
    assert.ok(row, 'a forced_tool_rejected row');
    assert.match(row.message, /400 INVALID_ARGUMENT: Invalid JSON payload received\. Unknown name "additionalProperties"/);
    assert.ok(!row.message.includes(GEMINI_KEY));
  });

  test(`${path}: when every request is rejected, the reply fails plainly and pg1_errors carries Gemini's reason`, async () => {
    const calls = installFetch({ rejectAll: true });
    const res = await ask(RECALL);
    assert.equal(res.statusCode, 200);
    const gem = geminiRequests(calls);
    assert.ok(gem.every((c) => !hasSearch(c.body)), 'no web-search fallback');
    assert.equal(gem.filter((c) => forced(c.body)).length, 1, 'one forced attempt, then unforced');
    assert.match(replyOf(res, stream), /Execution failed\./);
    assert.doesNotMatch(replyOf(res, stream), /INVALID_ARGUMENT|additionalProperties/, 'the operator sees no provider text');
    const [row] = await errorRows(calls, 'model_failed');
    assert.ok(row, 'a model_failed row');
    assert.equal(row.route, 'CHAT');
    assert.match(row.message, /^required search_history call rejected: \[gemini-[^\]]+\] 400 INVALID_ARGUMENT: Invalid JSON payload received\. Unknown name "additionalProperties" at 'tools\[0\]\.function_declarations\[10\]\.parameters': Cannot find field\./);
    assert.ok(row.message.length <= 300);
    assert.ok(!row.message.includes(GEMINI_KEY), 'no API key');
  });
}
