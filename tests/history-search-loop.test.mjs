/*
 * The history search loop (2026-10-07, request 0blvr268, after #269): the
 * operator asked "what was the verification HTML tag we discussed?", the
 * message routed to search_history (reason=history), and the model called
 * search_history five times in a row, each with results (the 5 Oct
 * playground / Search Console messages). The round after the five-call
 * budget offered no tools (mode NONE) and Gemini returned yet another
 * function call with no text; the loop dropped it and the reply failed as
 * model_failed with "no detail".
 *
 * Now (lib/chatTools.mjs runToolLoop, api/chat.mjs):
 *   - the required search_history call is forced on round 1 only, on every
 *     path (JSON, streamed, the #269 retries, the Anthropic /core path);
 *   - at most CHAT_HISTORY_MAX_SEARCHES searches run per message, and the
 *     round after a search that found matches, or after the cap, offers no
 *     tools; a function call returned on such a round is never run and
 *     counts as no usable text (so the plain results retry applies);
 *   - a loop that still ends with no text answers from the results it has
 *     and logs tool_loop_limit with the round count, never model_failed
 *     with no detail.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../lib/chatStream.mjs';

const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
const { runToolLoop, resultsFallbackText, SEARCH_HISTORY_TOOL, CHAT_HISTORY_MAX_SEARCHES, CHAT_TOOL_MAX_CALLS, SEARCH_HISTORY_DIRECTIVE } = await import('../lib/chatTools.mjs');
const { chooseChatRoute, requiredFirstTool } = await import('../lib/chatRoute.mjs');

const GEMINI_KEY = 'AIzaStubGeminiKeyForHistoryLoopTests0000';
const ANTHROPIC_KEY = 'sk-ant-stub-history-loop-tests-000000000000';
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const ASK = 'what was the verification HTML tag we discussed?';
const REPLY = 'On 2026-10-05 you pasted the Search Console tag <meta name="google-site-verification" content="abc123" /> for the playground.';

// The 5 Oct playground / Search Console messages the live search found.
const VERIFICATION_ROWS = [
  { id: 501, role: 'user', created_at: '2026-10-05T18:02:00Z', content: 'Add this to the playground head for Search Console: <meta name="google-site-verification" content="abc123" />' },
  { id: 502, role: 'model', created_at: '2026-10-05T18:03:00Z', content: 'Added the google-site-verification meta tag to public/playground/index.html.' },
  { id: 503, role: 'user', created_at: '2026-10-05T18:20:00Z', content: 'Search Console says the playground is verified now.' }
];

// ---------------------------------------------------------------------------
// The loop on its own: a fake model that never stops calling search_history.

const HISTORY_RESULT = { found: true, match_type: 'exact', close_match: false, count: 2, matches: [
  { at: '2026-10-05T18:02:00.000Z', date: '2026-10-05', time_utc: '18:02', speaker: 'operator', match: 'exact', snippet: 'Add this to the playground head for Search Console: <meta name="google-site-verification" content="abc123" />' },
  { at: '2026-10-05T18:03:00.000Z', date: '2026-10-05', time_utc: '18:03', speaker: 'PG1', match: 'exact', snippet: 'Added the google-site-verification meta tag to public/playground/index.html.' }
] };
const NO_MATCHES = { found: false, match_type: 'none', close_match: false, count: 0, matches: [] };

function stubbornModel({ answerWhenToolsOff = false } = {}) {
  const seen = [];
  let n = 0;
  const callModel = async (turns, info) => {
    seen.push({ ...info, turns: turns.length });
    if (!info.toolsEnabled && answerWhenToolsOff) return { text: REPLY, calls: [], provider: 'gemini', error: null };
    // Always another search, whatever the round offers, and never any text.
    return { text: '', calls: [{ id: `c${++n}`, name: SEARCH_HISTORY_TOOL, args: { query: `verification ${n}` } }], provider: 'gemini', error: null };
  };
  return { callModel, seen };
}

function historyExecutor(result) {
  const ran = [];
  return { ran, executeTool: async (call) => { ran.push(call); return { id: call.id, name: call.name, args: call.args, ok: true, status: 'report', result: typeof result === 'function' ? result(ran.length) : result, checks: [], request_id: null, ms: 1 }; } };
}

test('runToolLoop: a model that keeps calling search_history is cut off after a search with matches and still answers from the results', async () => {
  const { callModel, seen } = stubbornModel();
  const { ran, executeTool } = historyExecutor(HISTORY_RESULT);
  const limits = [];
  const r = await runToolLoop({ callModel, executeTool, onLimit: (l) => limits.push(l) });
  assert.equal(ran.length, 1, 'one search ran');
  assert.equal(seen.length, 2, 'the search round, then one round with no tools');
  assert.equal(seen[1].toolsEnabled, false);
  assert.ok(r.text, 'never an empty reply');
  assert.equal(r.error, null);
  assert.equal(r.fallback, true);
  assert.match(r.text, /google-site-verification/);
  assert.match(r.text, /2026-10-05 18:02 UTC, you:/);
  assert.equal(limits.length, 1, 'logged once');
  assert.equal(limits[0].reason, 'tool_loop_limit');
  assert.equal(limits[0].rounds, 2);
  assert.match(limits[0].detail, /rounds=2 .*history_searches=1/);
  assert.match(limits[0].detail, /still called search_history \(dropped\)/);
});

test(`runToolLoop: searches that find nothing stop at ${CHAT_HISTORY_MAX_SEARCHES}, then the model must answer with no tools`, async () => {
  assert.equal(CHAT_HISTORY_MAX_SEARCHES, 3);
  assert.ok(CHAT_HISTORY_MAX_SEARCHES < CHAT_TOOL_MAX_CALLS, 'the history cap bites before the check budget');
  const { callModel, seen } = stubbornModel({ answerWhenToolsOff: true });
  const { ran, executeTool } = historyExecutor(NO_MATCHES);
  const limits = [];
  const r = await runToolLoop({ callModel, executeTool, onLimit: (l) => limits.push(l) });
  assert.equal(ran.length, CHAT_HISTORY_MAX_SEARCHES);
  assert.deepEqual(seen.map((s) => s.toolsEnabled), [true, true, true, false]);
  assert.equal(r.text, REPLY);
  assert.equal(limits.length, 0, 'a model that answers when told to is not a limit hit');
});

test('runToolLoop: a stubborn model past the cap with no results ends with a reason, never an empty error', async () => {
  const { callModel, seen } = stubbornModel();
  const { executeTool } = historyExecutor(NO_MATCHES);
  const limits = [];
  const r = await runToolLoop({ callModel, executeTool, onLimit: (l) => limits.push(l) });
  assert.equal(seen.length, CHAT_HISTORY_MAX_SEARCHES + 1);
  assert.equal(r.text, '');
  assert.ok(r.error && /tools/.test(r.error), r.error);
  assert.equal(limits[0].reason, 'tool_loop_limit');
  assert.equal(limits[0].rounds, CHAT_HISTORY_MAX_SEARCHES + 1);
});

test('runToolLoop: parallel search_history calls past the cap are refused, not run', async () => {
  let round = 0;
  const callModel = async (turns, info) => {
    round++;
    if (!info.toolsEnabled) return { text: REPLY, calls: [] };
    return { text: '', calls: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: SEARCH_HISTORY_TOOL, args: { query: `q${i}` } })) };
  };
  const { ran, executeTool } = historyExecutor(NO_MATCHES);
  const limits = [];
  const r = await runToolLoop({ callModel, executeTool, onLimit: (l) => limits.push(l) });
  assert.equal(ran.length, CHAT_HISTORY_MAX_SEARCHES);
  const refused = r.outcomes.filter((o) => o.refused);
  assert.equal(refused.length, 2);
  assert.match(refused[0].message, /limit of 3 history searches/);
  assert.equal(round, 2);
  assert.equal(r.text, REPLY);
  assert.equal(limits[0].reason, 'tool_loop_limit');
});

test('runToolLoop: force is offered on round 1 only', async () => {
  const { callModel, seen } = stubbornModel({ answerWhenToolsOff: true });
  const { executeTool } = historyExecutor(NO_MATCHES);
  await runToolLoop({ callModel, executeTool });
  assert.deepEqual(seen.map((s) => s.force), [true, false, false, false]);
});

test('resultsFallbackText: lists the matches with date, time and speaker; nothing for no results', () => {
  const text = resultsFallbackText([{ ok: true, name: SEARCH_HISTORY_TOOL, result: HISTORY_RESULT }, { ok: true, name: SEARCH_HISTORY_TOOL, result: HISTORY_RESULT }]);
  assert.equal(text.split('\n').length, 3, 'heading plus two matches, duplicates once');
  assert.match(text, /2026-10-05 18:03 UTC, PG1: Added the google-site-verification/);
  assert.equal(resultsFallbackText([{ ok: true, name: SEARCH_HISTORY_TOOL, result: NO_MATCHES }]), '');
});

test('the history directive tells the model the cap', () => {
  assert.match(SEARCH_HISTORY_DIRECTIVE, /At most 3 searches run per message/);
});

test('the exact live message routes to search_history and requires it', () => {
  const route = chooseChatRoute(ASK, { hasTools: true, historySearch: true, videoTool: false });
  assert.equal(route.route, 'tools');
  assert.equal(route.reason, 'history');
  assert.equal(requiredFirstTool(route), SEARCH_HISTORY_TOOL);
});

// ---------------------------------------------------------------------------
// Through the handler: JSON and streamed, Gemini and the Anthropic /core.

beforeEach(() => {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key-loop-00000000';
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'OPENAI_API_KEY', 'PG1_CHAT_TOOL_TIMEOUT_MS']) delete process.env[k];
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.69.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}` }, body });
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

const declarationsOf = (body) => (body.tools || []).flatMap((t) => t.functionDeclarations || []);
const modeOf = (body) => (((body && body.toolConfig) || {}).functionCallingConfig || {}).mode || null;
const isPlain = (body) => !declarationsOf(body).length && !body.toolConfig;

// model: 'stubborn' returns a search_history call on every request that
// carries declarations, whatever toolConfig says (even NONE), and text only
// on a plain request; 'silent' never returns text at all; 'obedient' obeys
// NONE and answers.
function installFetch({ model = 'stubborn', anthropic = false } = {}) {
  const calls = [];
  let n = 0;
  const reply = (u, payload) => (u.includes('streamGenerateContent') ? new Response(`data: ${JSON.stringify(payload)}\n\n`) : Response.json(payload));
  const callPart = () => ({ functionCall: { name: SEARCH_HISTORY_TOOL, args: { query: `verification OR "meta tag" ${++n}` } } });
  const gemini = (u, body) => {
    if (model === 'silent' && !(declarationsOf(body).length && modeOf(body) !== 'NONE')) return reply(u, { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] });
    if (isPlain(body) || (model === 'obedient' && modeOf(body) === 'NONE')) return reply(u, { candidates: [{ content: { parts: [{ text: REPLY }] } }] });
    return reply(u, { candidates: [{ content: { parts: [callPart()] } }] });
  };
  const claude = (body, stream) => {
    // A stubborn Claude: a tool_use whatever tool_choice says, text only
    // when tool_choice is none and it decides to behave (never here).
    const content = [{ type: 'tool_use', id: `tu${++n}`, name: SEARCH_HISTORY_TOOL, input: { query: 'verification' } }];
    if (!stream) return Response.json({ content, stop_reason: 'tool_use' });
    const ev = [
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: content[0].id, name: SEARCH_HISTORY_TOOL, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(content[0].input) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' }
    ];
    return new Response(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  };
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    let body = null;
    try { body = options.body ? JSON.parse(options.body) : null; } catch (e) { body = options.body; }
    calls.push({ url: u, method: options.method || 'GET', body });
    if (u.includes('generativelanguage.googleapis.com')) return gemini(u, body);
    if (anthropic && u.includes('api.anthropic.com')) return claude(body, !!(body && body.stream));
    if (u.includes('/rest/v1/messages?') && u.includes('content_tsv=')) return Response.json(VERIFICATION_ROWS);
    if (u.includes('/rest/v1/pg1_errors')) return new Response(options.method === 'POST' ? '' : '[]', { status: options.method === 'POST' ? 201 : 200 });
    if (u.includes('/rest/v1/') || u.includes('/storage/v1/')) return Response.json([]);
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}
const geminiRequests = (calls) => calls.filter((c) => c.url.includes('generativelanguage.googleapis.com'));
const anthropicRequests = (calls) => calls.filter((c) => c.url.includes('api.anthropic.com'));
const historySearches = (calls) => calls.filter((c) => c.url.includes('/rest/v1/messages?') && c.url.includes('content_tsv='));
const errorRowsNow = (calls) => calls.filter((c) => c.url.includes('/rest/v1/pg1_errors') && (c.method === 'POST' || c.method === 'PATCH')).map((c) => c.body).filter(Boolean);
async function settle() { await new Promise((r) => setTimeout(r, 30)); }

for (const stream of [false, true]) {
  const path = stream ? 'streamed' : 'JSON';
  const ask = (prompt, extra = {}) => {
    const res = makeRes();
    return chatHandler(makeReq({ prompt, ...OPERATOR, ...(stream ? { stream: true } : {}), ...extra }), res).then(() => res);
  };

  test(`${path}: the live message gets one search and a normal reply, even from a model that ignores mode NONE`, async () => {
    const calls = installFetch({ model: 'stubborn' });
    const res = await ask(ASK);
    assert.equal(res.statusCode, 200);
    const gem = geminiRequests(calls);
    assert.equal(historySearches(calls).length, 1, 'one search_history call ran');
    assert.equal(modeOf(gem[0].body), 'ANY', 'round 1 forces search_history');
    assert.deepEqual(gem[0].body.toolConfig.functionCallingConfig.allowedFunctionNames, [SEARCH_HISTORY_TOOL]);
    assert.equal(modeOf(gem[1].body), 'NONE', 'the round after matches offers no tools');
    for (const g of gem.slice(1)) assert.notEqual(modeOf(g.body), 'ANY', 'never forced after round 1');
    assert.ok(isPlain(gem[2].body), 'the function call on the NONE round sends it to the plain retry');
    assert.equal(gem.length, 3);
    const reply = replyOf(res, stream);
    assert.ok(reply.trim().startsWith(REPLY), reply);
    await settle();
    const rows = errorRowsNow(calls);
    assert.ok(!rows.some((r) => r.reason === 'model_failed'), JSON.stringify(rows));
    const rejected = rows.find((r) => r.reason === 'tool_results_rejected');
    assert.ok(rejected, 'the dropped call is logged');
    assert.match(rejected.message, /function call search_history on a round with tools off/);
  });

  test(`${path}: a model that obeys mode NONE answers on round 2 with no retry`, async () => {
    const calls = installFetch({ model: 'obedient' });
    const res = await ask(ASK);
    const gem = geminiRequests(calls);
    assert.equal(gem.length, 2);
    assert.equal(historySearches(calls).length, 1);
    assert.deepEqual(gem.map((g) => modeOf(g.body)), ['ANY', 'NONE']);
    assert.ok(replyOf(res, stream).trim().startsWith(REPLY));
    await settle();
    assert.deepEqual(errorRowsNow(calls).map((r) => r.reason), []);
  });

  test(`${path}: when no round writes any text, the reply comes from the results and tool_loop_limit is logged, not model_failed`, async () => {
    const calls = installFetch({ model: 'silent' });
    const res = await ask(ASK);
    assert.equal(res.statusCode, 200);
    assert.equal(historySearches(calls).length, 1);
    const gem = geminiRequests(calls);
    assert.equal(modeOf(gem[0].body), 'ANY');
    for (const g of gem.slice(1)) assert.notEqual(modeOf(g.body), 'ANY');
    const reply = replyOf(res, stream);
    assert.match(reply, /I found these messages in our chat history/);
    assert.match(reply, /2026-10-05 18:02 UTC, you: .*google-site-verification/);
    assert.doesNotMatch(reply, /Execution failed|Request ID/i);
    await settle();
    const rows = errorRowsNow(calls);
    assert.ok(!rows.some((r) => r.reason === 'model_failed'), JSON.stringify(rows.map((r) => r.reason)));
    const limit = rows.find((r) => r.reason === 'tool_loop_limit');
    assert.ok(limit, 'tool_loop_limit is logged');
    assert.match(limit.message, /rounds=2 /);
    assert.match(limit.message, /answered from the results/);
    assert.ok(!limit.message.includes(GEMINI_KEY));
  });

  test(`${path}: on the /core (Anthropic) path only round 1 forces search_history, and a stubborn model still gets an answer`, async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
    const calls = installFetch({ model: 'obedient', anthropic: true });
    const res = await ask(ASK, { action: 'CLAUDE_CHAT' });
    assert.equal(res.statusCode, 200);
    const claude = anthropicRequests(calls);
    assert.ok(claude.length >= 2, `${claude.length} Anthropic requests`);
    // Opus 5.5 (the router's first heavy model) answers a forced
    // tool_choice with a 400, so it gets auto plus the required-step line.
    if (/^claude-(?:opus-5-5|sonnet-5-5)\b/.test(claude[0].body.model)) {
      assert.equal(claude[0].body.tool_choice, undefined, 'round 1 is not forced by tool_choice on this model');
      assert.match(claude[0].body.system, new RegExp(`\\[REQUIRED FIRST STEP\\]: Call ${SEARCH_HISTORY_TOOL}`), 'round 1 requires the tool in words');
    } else {
      assert.deepEqual(claude[0].body.tool_choice, { type: 'tool', name: SEARCH_HISTORY_TOOL }, 'round 1 is forced');
    }
    for (const c of claude.slice(1)) assert.deepEqual(c.body.tool_choice, { type: 'none' }, 'later rounds offer no tool');
    assert.equal(historySearches(calls).length, 1);
    // Claude kept calling, so round 2 fell back to the main core, which obeys NONE.
    for (const g of geminiRequests(calls)) assert.notEqual(modeOf(g.body), 'ANY');
    assert.ok(replyOf(res, stream).trim().startsWith(REPLY), replyOf(res, stream));
    await settle();
    assert.ok(!errorRowsNow(calls).some((r) => r.reason === 'model_failed'));
  });
}
