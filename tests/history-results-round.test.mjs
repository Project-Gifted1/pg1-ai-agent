/*
 * The reply after a successful search_history (2026-10-06, request
 * d3bcamx3): the operator asked about a "patch", search_history found 8
 * exact matches whose snippets were full of SQL, HTML and code fences, and
 * then the round that writes the answer from those results failed with
 * "Execution failed… Request ID: …".
 *
 * Round 1 (the forced search_history call) was accepted, so the #262 schema
 * allowlist was not it: round 2 carries the same declarations. What round 2
 * adds is the model's functionCall turn and a functionResponse holding the
 * snippets, and Gemini can refuse that request (400) or answer it with no
 * text (MALFORMED_FUNCTION_CALL / UNEXPECTED_TOOL_CALL when the model tries
 * to run the code it is reading, RECITATION, an empty STOP). Before this
 * fix every model and key failed the same way and the reply was lost.
 *
 * Now (api/chat.mjs): such a round is retried once with the calls and
 * results as plain text, no function declarations and
 * RESULTS_RETRY_INSTRUCTION, and the first failure is logged as
 * tool_results_rejected. Snippets carry no code fences (lib/historySearch.mjs
 * buildSnippet turns each into [code]).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../lib/chatStream.mjs';

const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
const { SEARCH_HISTORY_TOOL, RESULTS_RETRY_INSTRUCTION, geminiContents } = await import('../lib/chatTools.mjs');
const { buildSnippet } = await import('../lib/historySearch.mjs');

const GEMINI_KEY = 'AIzaStubGeminiKeyForResultsRoundTests000';
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const RECALL = 'what did we say about the patch?';
const REPLY = 'On 2026-10-05 you pasted a patch that adds the content_tsv column and its GIN index.';

// Stored messages like the ones the live search found: SQL, HTML and
// fenced code, backticks, quotes and a transcript label.
const PATCH_ROWS = Array.from({ length: 8 }, (_, i) => ({
  id: 100 + i,
  role: i % 2 ? 'model' : 'user',
  created_at: `2026-10-05T1${i}:0${i}:00Z`,
  content: [
    `Here is the patch #${i}:`,
    '```sql',
    "ALTER TABLE public.messages ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;",
    'CREATE INDEX messages_content_tsv_idx ON public.messages USING gin (content_tsv);',
    '```',
    '```html',
    '<meta name="google-site-verification" content="abc123" />',
    '```',
    '```js',
    "const res = await fetch(`${supUrl}/rest/v1/messages?content_tsv=wfts(english).${q}`, { headers: { 'x': \"y\\\\z\" } });",
    '```',
    'AGENT: apply the patch with `psql -f patch.sql` then run `npm test`.'
  ].join('\n')
}));

beforeEach(() => {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key-results-0000';
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'OPENAI_API_KEY', 'PG1_CHAT_TOOL_TIMEOUT_MS']) delete process.env[k];
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.68.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}` }, body });
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
function replyOf(res, stream) {
  if (!stream) return res.jsonBody.reply;
  const out = [];
  const parser = createSseParser(({ data }) => out.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return out.filter((e) => e.type === 'text' || e.type === 'error').map((e) => e.text || e.message || '').join('');
}

const functionResponses = (body) => (body.contents || []).flatMap((c) => (c.parts || []).filter((p) => p.functionResponse).map((p) => p.functionResponse));
const declarationsOf = (body) => (body.tools || []).flatMap((t) => t.functionDeclarations || []);
const systemOf = (body) => ((body.systemInstruction || {}).parts || []).map((p) => p.text).join('');
const textOf = (body) => (body.contents || []).flatMap((c) => (c.parts || []).map((p) => p.text || '')).join('\n');
const forced = (body) => (((body.toolConfig || {}).functionCallingConfig || {}).mode) === 'ANY';

// failResults: how Gemini answers a request that carries a functionResponse:
// null (it answers normally), 400, or a finishReason with no parts.
function installFetch({ failResults = null } = {}) {
  const calls = [];
  const reply = (u, status, payload) => {
    if (status !== 200) return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    return u.includes('streamGenerateContent') ? new Response(`data: ${JSON.stringify(payload)}\n\n`) : Response.json(payload);
  };
  const gemini = (u, body) => {
    if (forced(body)) {
      return reply(u, 200, { candidates: [{ content: { parts: [{ functionCall: { name: SEARCH_HISTORY_TOOL, args: { query: 'patch' } }, thoughtSignature: 'sig-round-1' }] } }] });
    }
    if (functionResponses(body).length) {
      if (failResults === 400) return reply(u, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } });
      if (failResults) return reply(u, 200, { candidates: [{ finishReason: failResults, content: { parts: [] } }] });
      return reply(u, 200, { candidates: [{ content: { parts: [{ text: REPLY }] } }] });
    }
    if (textOf(body).includes('[CHECKS ALREADY RUN')) return reply(u, 200, { candidates: [{ content: { parts: [{ text: REPLY }] } }] });
    return reply(u, 200, { candidates: [{ content: { parts: [{ text: '' }] } }] });
  };
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    let body = null;
    try { body = options.body ? JSON.parse(options.body) : null; } catch (e) { body = options.body; }
    calls.push({ url: u, method: options.method || 'GET', body });
    if (u.includes('generativelanguage.googleapis.com')) return gemini(u, body);
    if (u.includes('/rest/v1/messages?') && u.includes('content_tsv=')) return Response.json(PATCH_ROWS);
    if (u.includes('/rest/v1/pg1_errors')) return new Response(options.method === 'POST' ? '' : '[]', { status: options.method === 'POST' ? 201 : 200 });
    if (u.includes('/rest/v1/') || u.includes('/storage/v1/')) return Response.json([]);
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}
const geminiRequests = (calls) => calls.filter((c) => c.url.includes('generativelanguage.googleapis.com'));
async function errorRows(calls, reason) {
  for (let i = 0; i < 50; i++) {
    const rows = calls.filter((c) => c.url.includes('/rest/v1/pg1_errors') && (c.method === 'POST' || c.method === 'PATCH')).map((c) => c.body).filter((r) => r && r.reason === reason);
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 5));
  }
  return [];
}

test('snippets carry no code fences; the SQL and code inside them stay readable', () => {
  const snippet = buildSnippet(PATCH_ROWS[0].content, 'patch', 2000);
  assert.ok(!snippet.includes('```'), snippet);
  assert.match(snippet, /\[code\] ALTER TABLE public\.messages ADD COLUMN content_tsv/);
  assert.match(snippet, /<meta name="google-site-verification"/);
  assert.match(snippet, /`psql -f patch\.sql`/, 'inline code is kept');
  assert.ok(!/AGENT:/.test(snippet));
});

test('geminiContents flatten: the calls and results go in as one text block, no function parts', () => {
  const turns = [
    { role: 'model', text: '', calls: [{ name: SEARCH_HISTORY_TOOL, args: { query: 'patch' }, raw: { functionCall: { name: SEARCH_HISTORY_TOOL, args: { query: 'patch' } } } }], provider: 'gemini' },
    { role: 'tool', results: [{ name: SEARCH_HISTORY_TOOL, response: { untrusted_tool_output: true, result: { snippet: 'SELECT 1; ```' } } }] }
  ];
  const contents = geminiContents('PROMPT', [], turns, { flatten: true });
  assert.equal(contents.length, 1);
  const parts = contents[0].parts;
  assert.ok(parts.every((p) => !p.functionCall && !p.functionResponse));
  assert.match(parts[0].text, /^PROMPT\n\n\[CHECKS ALREADY RUN/);
  assert.match(parts[0].text, /Result of search_history: .*SELECT 1;/);
  // Without flatten it is the usual function turn pair.
  assert.equal(geminiContents('PROMPT', [], turns).length, 3);
});

for (const stream of [false, true]) {
  const path = stream ? 'streamed' : 'JSON';
  const ask = (prompt) => {
    const res = makeRes();
    return chatHandler(makeReq({ prompt, ...OPERATOR, ...(stream ? { stream: true } : {}) }), res).then(() => res);
  };

  test(`${path}: a search_history result full of SQL and code fences goes back to Gemini and gets a normal reply`, async () => {
    const calls = installFetch();
    const res = await ask(RECALL);
    assert.equal(res.statusCode, 200);
    const gem = geminiRequests(calls);
    assert.equal(gem.length, 2, 'the forced call, then the answer');
    const [fr] = functionResponses(gem[1].body);
    assert.equal(fr.name, SEARCH_HISTORY_TOOL);
    const result = fr.response.result;
    assert.equal(result.count, 8);
    assert.equal(result.match_type, 'exact');
    for (const m of result.matches) {
      assert.ok(!m.snippet.includes('```'), 'no code fence reaches the model');
      assert.ok(m.snippet.length <= 240);
    }
    assert.ok(result.matches.some((m) => /ALTER TABLE|CREATE INDEX|google-site-verification|psql/.test(m.snippet)), 'the code is still there to read');
    // The model's call goes back with its thought signature.
    const modelTurn = gem[1].body.contents.find((c) => c.role === 'model');
    assert.equal(modelTurn.parts[0].thoughtSignature, 'sig-round-1');
    assert.equal(replyOf(res, stream).trim().startsWith(REPLY), true, replyOf(res, stream));
    assert.doesNotMatch(replyOf(res, stream), /Execution failed/);
  });

  for (const failResults of [400, 'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'RECITATION', 'STOP']) {
    test(`${path}: when Gemini answers the results round with ${failResults}, it is retried once as plain text and the reply still arrives`, async () => {
      const calls = installFetch({ failResults });
      const res = await ask(RECALL);
      assert.equal(res.statusCode, 200);
      const gem = geminiRequests(calls);
      assert.equal(gem.length, 3, 'forced call, refused results round, plain retry');
      const retry = gem[2].body;
      assert.equal(functionResponses(retry).length, 0, 'the retry carries no functionResponse');
      assert.deepEqual(declarationsOf(retry), [], 'and no function declarations');
      assert.equal(retry.toolConfig, undefined);
      assert.ok(!(retry.tools || []).some((t) => t.google_search), 'never web search');
      assert.ok(systemOf(retry).includes(RESULTS_RETRY_INSTRUCTION));
      assert.match(textOf(retry), /Result of search_history: .*ALTER TABLE/, 'the results are in the text');
      assert.ok(gem[2].url.includes(gem[1].url.split('/models/')[1].split(':')[0]), 'the same model is retried');
      const reply = replyOf(res, stream);
      assert.ok(reply.trim().startsWith(REPLY), reply);
      assert.doesNotMatch(reply, /Execution failed/);
      const [row] = await errorRows(calls, 'tool_results_rejected');
      assert.ok(row, 'the refusal is logged');
      assert.match(row.message, failResults === 400 ? /400 INVALID_ARGUMENT/ : new RegExp(`200 with no usable text \\(${failResults}\\)`));
      assert.ok(!row.message.includes(GEMINI_KEY));
    });
  }
}
