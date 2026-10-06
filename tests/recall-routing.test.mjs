/*
 * Recall questions ("do you remember Blanco Ekama?") for the operator.
 *
 * Live bug after #260: the operator asked "do you remember Blanco Ekama?"
 * and PG1 answered "I can't search our past chat history right now because
 * the history tool isn't available ... According to search results, Blanko
 * Ekama ... is an independent musical artist". The router did pick the
 * tools route, but nothing made the model call search_history; when it
 * skipped the call, the message fell through to the web-search request,
 * whose system prompt still described search_history. So the model told the
 * operator a tool it had not been handed was "not available", and mixed web
 * results into a question about our past conversations.
 *
 * Now (lib/chatRoute.mjs, api/chat.mjs):
 *   - recall phrasing routes to tools for the operator ahead of every other
 *     signal, and its first round must call search_history (Gemini
 *     functionCallingConfig ANY / Anthropic tool_choice);
 *   - a recall question never gets the web-search call afterwards;
 *   - a search request's system prompt describes no function at all;
 *   - a guest is never offered search_history, and ordinary news questions
 *     still go to web search.
 * The stub model below behaves like the live one: on AUTO it skips the tool
 * and writes nothing; it calls search_history only when it is required to.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../lib/chatStream.mjs';

const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
const { CHAT_ROUTES, chooseChatRoute, requiredFirstTool, searchAfterTools, asksAboutHistory, HISTORY_ROUTE_REASON } = await import('../lib/chatRoute.mjs');
const { chatToolsForRole, toolDirective, SEARCH_HISTORY_TOOL, SEARCH_HISTORY_DIRECTIVE } = await import('../lib/chatTools.mjs');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase.test';
const RECALL = 'do you remember Blanco Ekama?';

beforeEach(() => {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.SUPABASE_URL = SUP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key-recall-0000';
  process.env.GEMINI_API_KEY = 'AIzaStubGeminiKeyForRecallTests00000000';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'OPENAI_API_KEY', 'PG1_CHAT_TOOL_TIMEOUT_MS']) delete process.env[k];
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

const operatorTools = () => chatToolsForRole('operator');
const guestTools = () => chatToolsForRole('guest');
const routeFor = (text, tools) => chooseChatRoute(text, { hasTools: tools.length > 0, historySearch: tools.some((t) => t.name === SEARCH_HISTORY_TOOL) });

// --- the router ------------------------------------------------------------------

test('operator: "do you remember Blanco Ekama?" goes to tools and must call search_history first', () => {
  const route = routeFor(RECALL, operatorTools());
  assert.deepEqual(route, { route: CHAT_ROUTES.TOOLS, reason: HISTORY_ROUTE_REASON });
  assert.equal(requiredFirstTool(route), SEARCH_HISTORY_TOOL);
});

test('operator: every recall phrasing routes to tools, and wins over web-search signals in the same message', () => {
  const recall = [
    RECALL, 'Do you remember Blanco Ekama', 'do u remember blanco ekama', 'can you recall Blanco Ekama?',
    'what did we say about Blanco Ekama?', 'what did we say about the latest Bitcoin price?',
    'last time we spoke, who was Blanco Ekama?', 'did we talk about Blanco Ekama?', 'did we ever talk about the news today?',
    'remind me what Blanco Ekama does', 'remind me who Blanco Ekama is',
    'do you remember who won the match yesterday?', 'do you remember the latest headlines about Blanco Ekama in 2026?',
    'do you remember what I said about example.com?'
  ];
  for (const q of recall) {
    assert.ok(asksAboutHistory(q), q);
    const route = routeFor(q, operatorTools());
    assert.deepEqual(route, { route: CHAT_ROUTES.TOOLS, reason: HISTORY_ROUTE_REASON }, q);
    assert.equal(requiredFirstTool(route), SEARCH_HISTORY_TOOL, q);
    // Never the web-search call afterwards, even with "latest", "today",
    // "who won" in it, and even when the tools round wrote nothing.
    assert.equal(searchAfterTools(q, { text: '', outcomes: [] }, route), false, q);
    assert.equal(searchAfterTools(q, { text: 'x', outcomes: [] }, route), false, q);
  }
});

test('guest: the same message never offers search_history and goes to web search', () => {
  assert.ok(!guestTools().some((t) => t.name === SEARCH_HISTORY_TOOL), 'not in the guest tools');
  assert.ok(!toolDirective(guestTools()).includes(SEARCH_HISTORY_TOOL), 'not in the guest directive');
  assert.ok(!toolDirective(guestTools()).includes('[HISTORY SEARCH]'));
  for (const q of [RECALL, 'what did we say about Blanco Ekama?', 'did we talk about Blanco Ekama?']) {
    const route = routeFor(q, guestTools());
    assert.deepEqual(route, { route: CHAT_ROUTES.SEARCH, reason: 'default' }, q);
    assert.equal(requiredFirstTool(route), null, q);
  }
  // A role with no tools at all is always search.
  assert.equal(chooseChatRoute(RECALL, { hasTools: false, historySearch: true }).route, CHAT_ROUTES.SEARCH);
});

test('operator: ordinary news and people questions still go to web search', () => {
  for (const q of [
    'what is the latest news about Bitcoin today?', 'who is Blanco Ekama?', 'who won the match yesterday?',
    'any breaking headlines this week?', 'what is the weather in London right now?', 'tell me about Blanko Ekama the musician',
    'remember to buy milk'
  ]) {
    const route = routeFor(q, operatorTools());
    assert.deepEqual(route, { route: CHAT_ROUTES.SEARCH, reason: 'default' }, q);
    assert.equal(requiredFirstTool(route), null, q);
  }
  // A non-recall tools-route message keeps its search call after a round
  // that ran no check.
  const wallet = routeFor('check 0x7067312d00000000000000000000000000000001 and the latest news', operatorTools());
  assert.equal(wallet.route, CHAT_ROUTES.TOOLS);
  assert.notEqual(wallet.reason, HISTORY_ROUTE_REASON);
  assert.equal(searchAfterTools('the latest news', { text: 'x', outcomes: [] }, wallet), true);
});

test('the directive: never claim the history tool is unavailable unless a call failed; a web search is only offered, never mixed in', () => {
  assert.match(SEARCH_HISTORY_DIRECTIVE, /search_history is attached to this message: never say the history tool, history search or chat history is unavailable/);
  assert.match(SEARCH_HISTORY_DIRECTIVE, /unless a search_history call actually failed or was refused/);
  assert.match(SEARCH_HISTORY_DIRECTIVE, /You may then offer, in one short line, to search the web/);
  assert.match(SEARCH_HISTORY_DIRECTIVE, /never put web results, search findings or general knowledge about the name into an answer to a question about our past conversations/);
  assert.ok(toolDirective(operatorTools()).includes(SEARCH_HISTORY_DIRECTIVE));
});

// --- through the chat handler ----------------------------------------------------

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.66.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}` }, body });
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
function eventsOf(res) {
  const out = [];
  const parser = createSseParser(({ data }) => out.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return out;
}
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const BLANKO_ROWS = [
  { id: 7, role: 'user', content: 'Blanko Ekama is sending the contract on Monday.', created_at: '2026-09-24T09:15:00Z', match_type: 'any_word', score: 0.5 }
];

const hasSearch = (body) => (body.tools || []).some((t) => t.google_search);
const declsOf = (body) => (body.tools || []).flatMap((t) => t.functionDeclarations || []).map((d) => d.name);
const hasResponses = (body) => (body.contents || []).some((c) => (c.parts || []).some((p) => p.functionResponse));
const systemOf = (body) => ((body.systemInstruction || {}).parts || []).map((p) => p.text).join('');
const forced = (body) => {
  const cfg = (body.toolConfig || {}).functionCallingConfig || {};
  return cfg.mode === 'ANY' && Array.isArray(cfg.allowedFunctionNames) && cfg.allowedFunctionNames.includes(SEARCH_HISTORY_TOOL);
};

// The live model's behaviour: on AUTO it skips search_history and writes
// nothing; required to call it, it does; given the results it answers. A
// search request answers with web results and the bad sentence, so a test
// that ever reaches it shows the bug.
const WEB_ANSWER = "I can't search our past chat history right now because the history tool isn't available. According to search results, Blanko Ekama is an independent musical artist.";
function installFetch({ historyRows = [], fallbackRows = BLANKO_ROWS, finalText = "I found a close match: on 2026-09-24 you said 'Blanko Ekama is sending the contract on Monday.' - is that who you mean?" } = {}) {
  const calls = [];
  const modelPayload = (body) => {
    assert.ok(!(hasSearch(body) && declsOf(body).length), 'never search and functions together');
    if (hasSearch(body)) return { candidates: [{ content: { parts: [{ text: WEB_ANSWER }] }, groundingMetadata: { webSearchQueries: ['Blanco Ekama'] } }] };
    if (hasResponses(body)) return { candidates: [{ content: { parts: [{ text: finalText }] } }] };
    if (forced(body)) return { candidates: [{ content: { parts: [{ functionCall: { name: SEARCH_HISTORY_TOOL, args: { query: 'Blanco Ekama' } } }] } }] };
    return { candidates: [{ content: { parts: [{ text: '' }] } }] };
  };
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    let body = null;
    try { body = options.body ? JSON.parse(options.body) : null; } catch (e) { body = options.body; }
    calls.push({ url: u, method: options.method || 'GET', body });
    if (u.includes('/rest/v1/messages?') && u.includes('content_tsv=')) return Response.json(historyRows);
    if (u.includes('/rest/v1/rpc/search_messages_fallback')) return Response.json(fallbackRows);
    if (u.includes('streamGenerateContent')) return new Response(`data: ${JSON.stringify(modelPayload(body))}\n\n`);
    if (u.includes('generativelanguage.googleapis.com')) return Response.json(modelPayload(body));
    if (u.includes('/rest/v1/') || u.includes('/storage/v1/')) return Response.json([]);
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}
const geminiRequests = (calls) => calls.filter((c) => c.url.includes('generativelanguage.googleapis.com'));

for (const stream of [false, true]) {
  const path = stream ? 'streamed' : 'JSON';

  test(`${path}: operator "do you remember Blanco Ekama?" calls search_history and never searches the web`, async () => {
    const calls = installFetch();
    const res = await chat({ prompt: RECALL, ...OPERATOR, ...(stream ? { stream: true } : {}) });
    assert.equal(res.statusCode, 200);
    const gem = geminiRequests(calls);
    assert.ok(gem.length >= 2, 'a tools round and the answer round');
    assert.ok(gem.every((c) => !hasSearch(c.body)), 'no web-search request at all');
    assert.ok(declsOf(gem[0].body).includes(SEARCH_HISTORY_TOOL), 'search_history offered on the first request');
    assert.ok(forced(gem[0].body), 'the first round must call search_history');
    assert.ok(gem.slice(1).every((c) => !forced(c.body)), 'only the first round is forced');
    assert.match(systemOf(gem[0].body), /\[HISTORY SEARCH\]/, 'the tools request describes the tool it carries');
    assert.ok(calls.some((c) => c.url.includes('content_tsv=')), 'the history was searched');
    assert.ok(calls.some((c) => c.url.includes('search_messages_fallback')), 'and the close-match fallback ran');
    const reply = stream ? eventsOf(res).filter((e) => e.type === 'text').map((e) => e.text).join('') : res.jsonBody.reply;
    assert.match(reply, /Blanko Ekama is sending the contract/);
    assert.doesNotMatch(reply, /isn't available|not available|search results|musical artist/i);
  });

  test(`${path}: a recall question whose tools round writes nothing gets no web-search call`, async () => {
    // A model that ignores even the required call: the reply fails plainly
    // rather than turning into a web answer.
    const calls = installFetch();
    globalThis.fetch = (orig => async (url, options = {}) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        calls.push({ url: u, method: 'POST', body: JSON.parse(options.body) });
        const payload = { candidates: [{ content: { parts: [{ text: '' }] } }] };
        return u.includes('streamGenerateContent') ? new Response(`data: ${JSON.stringify(payload)}\n\n`) : Response.json(payload);
      }
      return orig(url, options);
    })(globalThis.fetch);
    const res = await chat({ prompt: RECALL, ...OPERATOR, ...(stream ? { stream: true } : {}) });
    assert.equal(res.statusCode, 200);
    assert.ok(geminiRequests(calls).every((c) => !hasSearch(c.body)), 'no web-search request');
    const out = stream ? eventsOf(res).filter((e) => e.type === 'text').map((e) => e.text).join('') : res.jsonBody.reply;
    assert.doesNotMatch(out, /musical artist|history tool isn't available/i);
  });

  test(`${path}: an operator news question goes to web search, and that request describes no function`, async () => {
    const calls = installFetch();
    const res = await chat({ prompt: 'what is the latest news about Bitcoin today?', ...OPERATOR, ...(stream ? { stream: true } : {}) });
    assert.equal(res.statusCode, 200);
    const gem = geminiRequests(calls);
    assert.equal(gem.length, 1);
    assert.ok(hasSearch(gem[0].body), 'web search');
    assert.equal(declsOf(gem[0].body).length, 0, 'no functions');
    const sys = systemOf(gem[0].body);
    assert.ok(sys.includes('You are PG1'), 'the rest of the prompt is intact');
    assert.ok(!sys.includes(SEARCH_HISTORY_TOOL), 'the search prompt never names search_history');
    assert.ok(!sys.includes('[HISTORY SEARCH]'));
    assert.ok(!sys.includes('[TOOLS - checks you can run yourself]'), 'nor describes functions it does not carry');
    assert.ok(!calls.some((c) => c.url.includes('content_tsv=')), 'no history read');
  });
}
