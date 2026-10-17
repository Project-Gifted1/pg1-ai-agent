/**
 * P1: context and task focus (lib/taskState.mjs, lib/contextWindow.mjs,
 * api/chat.mjs, api/threads.mjs).
 *
 * Covered: the task commands (/task, /task set, /task clear, /pin,
 * /unpin); the [TASK STATE] block's 600-token cap with a count of what was
 * left out; cleaning and secret-guarding a client-sent state; card lines;
 * the recent window and the rolling summary (by hash, never dropped
 * silently); "it / that / the last one" resolution and the one clarifying
 * question; the routing floor; two multi-turn fixtures (an 8-turn film
 * edit, a music session with a declined take); and through the handlers:
 * the state at the top of the system prompt, the floor keeping the free key
 * out, the ambiguous reference answered with one question and no model
 * call, guests getting nothing, and a saved thread restoring its state.
 *
 * Run with: node --test tests/task-state.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeThreadsDb, threadsRest } from './helpers/threadsDb.mjs';

const {
  emptyTaskState, cleanTaskState, applyTaskCommand, renderTaskState, updateFromReply, resolveReference, clarifyingQuestion,
  referenceLine, fillCommandId, modelTaskUpdate, applyModelPatch, TASK_STATE_MAX_TOKENS, MAX_PINS
} = await import('../lib/taskState.mjs');
const {
  cardLines, cleanHistory, splitHistory, foldSummary, extractiveSummary, renderConversation, needsRoutingFloor, messageHash, recentTokenBudget, DEFAULT_RECENT_TOKENS
} = await import('../lib/contextWindow.mjs');
const { planRoute, TASKS, DATA } = await import('../lib/aiRouter.mjs');
const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
const { default: threadsHandler, __clearThreadsRateLimitState } = await import('../api/threads.mjs');

const tokens = (t) => Math.ceil(String(t).length / 4);
const FILM = '1a2b3c4d';
const TRACK = '9f8e7d6c';

// --- commands ---------------------------------------------------------------------

test('/task set, /task, /pin, /unpin and /task clear', () => {
  let s = emptyTaskState();
  let r = applyTaskCommand(s, '/task');
  assert.match(r.reply, /No task set/);
  r = applyTaskCommand(s, '/task set Ship a 60-second promo for PG1');
  s = r.state;
  assert.equal(s.goal, 'Ship a 60-second promo for PG1');
  r = applyTaskCommand(s, '/pin claim only live features');
  s = r.state;
  r = applyTaskCommand(s, '/pin end on the logo card');
  s = r.state;
  assert.deepEqual(s.pins, ['claim only live features', 'end on the logo card']);
  assert.match(applyTaskCommand(s, '/pin end on the logo card').reply, /Already pinned/);
  const shown = applyTaskCommand(s, '/task').reply;
  assert.match(shown, /Ship a 60-second promo/);
  assert.match(shown, /1\. claim only live features/);
  r = applyTaskCommand(s, '/unpin 1');
  assert.deepEqual(r.state.pins, ['end on the logo card']);
  assert.match(applyTaskCommand(r.state, '/unpin 5').reply, /no pinned rule 5/);
  r = applyTaskCommand(r.state, '/task clear');
  assert.equal(r.state.goal, '');
  assert.deepEqual(r.state.pins, ['end on the logo card'], 'pins survive /task clear');
  assert.match(r.reply, /1 pinned rule kept/);
  assert.equal(applyTaskCommand(s, 'hello'), null);
  let full = emptyTaskState();
  for (let i = 0; i < MAX_PINS; i++) full = applyTaskCommand(full, `/pin rule ${i}`).state;
  assert.match(applyTaskCommand(full, '/pin one more').reply, /at most/);
});

test('[TASK STATE] stays within 600 tokens and says how much it left out; pins and goal stay', () => {
  let s = { ...emptyTaskState(), goal: 'g'.repeat(200), pins: ['keep the logo'] };
  for (let i = 0; i < 8; i++) s = applyModelPatch(s, { decisions_add: [`decision ${i} ${'d'.repeat(180)}`], open_add: [`open ${i} ${'o'.repeat(180)}`], constraints_add: [`constraint ${i} ${'c'.repeat(180)}`] });
  for (let i = 0; i < 10; i++) s = updateFromReply(s, { reply: { filmProject: { id: `${i}0000000-aaaa-bbbb-cccc-000000000000`, shortId: `${i}0000000`, title: 't'.repeat(150), label: 'Storyboard ready' } } });
  const block = renderTaskState(s);
  assert.ok(tokens(block) <= TASK_STATE_MAX_TOKENS, `block is ${tokens(block)} tokens`);
  assert.match(block, /^\[TASK STATE\]/);
  assert.match(block, /keep the logo/);
  assert.match(block, /Goal: g{50}/);
  assert.match(block, /\(\d+ older items? not shown\)/);
  assert.equal(renderTaskState(emptyTaskState()), '');
});

test('a client-sent state is cleaned: types checked, sizes capped, secrets withheld, unknown fields dropped', () => {
  const secret = 'sk-live-' + 'A1b2'.repeat(8);
  const guard = (t) => t.split(secret).join('[withheld]');
  const s = cleanTaskState({ goal: `use ${secret}\n\u0000now`, pins: ['a', 'a', 7, 'b'.repeat(500)], objects: [{ kind: 'nuke', id: 'x', label: 'y' }, { kind: 'film', id: '' }], evil: true, turn: -3, lastHash: 'zz' }, guard);
  assert.equal(s.goal, 'use [withheld] now');
  assert.equal(s.pins.length, 3);
  assert.equal(s.pins[2].length, 200);
  assert.deepEqual(s.objects, [{ kind: 'other', id: 'x', label: 'y', turn: 0 }]);
  assert.equal(s.turn, 0);
  assert.equal(s.lastHash, '');
  assert.ok(!('evil' in s));
  assert.deepEqual(cleanTaskState('nope'), emptyTaskState());
});

// --- cards, history, summary ---------------------------------------------------------

test('cards become compact text lines', () => {
  const lines = cardLines({
    toolResults: [{ tool: 'check_domain_age', title: 'Domain age', subject: 'pg1-test-flagged.invalid', status_label: 'Flagged', reasons: [{ code: 'DOMAIN_NEW' }], request_id: 'req_1' }],
    filmProject: { id: `${FILM}-0000-0000-0000-000000000000`, shortId: FILM, title: 'Launch', label: 'Storyboard ready', spentUsd: 0.1, capUsd: 20 },
    musicTrack: { id: TRACK, shortId: TRACK, title: 'Night Drive', label: 'Pick a take', previews: [{ variant: 1, discarded: true }, { variant: 2 }] },
    pendingApproval: { token: 't' }
  });
  assert.deepEqual(lines, [
    '[card] Domain age pg1-test-flagged.invalid: Flagged (DOMAIN_NEW) request_id req_1',
    `[card] film ${FILM} "Launch": Storyboard ready, spent 0.1 of 20 USD`,
    `[card] track ${TRACK} "Night Drive": Pick a take (take 1 discarded, take 2)`,
    '[card] approval waiting (Approve / Decline)'
  ]);
});

test('history keeps the newest turns verbatim and folds only what the summary does not cover', async () => {
  const h = cleanHistory(Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: `message ${i} ${'w'.repeat(390)}`, cards: i === 3 ? ['[card] film 1a2b3c4d "x": ready', 'not a card'] : undefined })));
  assert.match(h[3].text, /\n\[card\] film 1a2b3c4d/);
  assert.ok(!h[3].text.includes('not a card'));
  const first = splitHistory(h, { recentTokens: 400 });
  assert.equal(first.recent.length, 3);
  assert.equal(first.toFold.length, 7);
  const folded = await foldSummary({ text: '', lastHash: '', folded: 0 }, first.toFold, { callModel: null });
  assert.equal(folded.via, 'extract');
  assert.equal(folded.summary.folded, 7);
  assert.equal(folded.summary.lastHash, messageHash(h[6]));
  // Two more messages: only the two that left the window are new to fold.
  const h2 = h.concat(cleanHistory([{ role: 'user', text: 'message 10 ' + 'w'.repeat(390) }, { role: 'model', text: 'message 11 ' + 'w'.repeat(390) }]));
  const second = splitHistory(h2, { recentTokens: 400, summary: folded.summary });
  assert.deepEqual(second.toFold.map((m) => m.text.slice(0, 10)), ['message 7 ', 'message 8 ']);
  // The client's window dropped the folded part: everything older is new.
  const third = splitHistory(h2.slice(8), { recentTokens: 400, summary: folded.summary });
  assert.equal(third.toFold.length, third.older.length);
  const conv = renderConversation({ summary: folded.summary, recent: first.recent });
  assert.match(conv, /\[EARLIER IN THIS THREAD\] \(rolling summary of 7 older messages\)/);
  assert.match(conv, /\[RECENT TURNS\]/);
  assert.match(conv, /AGENT: message 9/);
});

test('the extractive summary never drops a line without saying so', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ role: 'user', text: `turn ${i} ${'z'.repeat(150)}` }));
  const text = extractiveSummary('', many, { maxTokens: 500 });
  assert.ok(tokens(text) <= 520);
  assert.match(text, /^\(earlier: \d+ older lines condensed out; search_history finds them\)/);
  assert.match(text, /turn 79/);
  const again = extractiveSummary(text, [{ role: 'model', text: 'more' }], { maxTokens: 500 });
  const before = Number(/earlier: (\d+)/.exec(text)[1]);
  const afterCount = Number(/earlier: (\d+)/.exec(again)[1]);
  assert.ok(afterCount >= before, 'the condensed count only grows');
});

test('the model fold is used when it answers, the extract when it does not', async () => {
  const msgs = [{ role: 'user', text: 'make the film' }];
  const ok = await foldSummary(null, msgs, { callModel: async ({ system, prompt }) => { assert.match(system, /untrusted data/); assert.match(prompt, /<new_messages>/); return '- making a film'; } });
  assert.equal(ok.via, 'model');
  assert.equal(ok.summary.text, '- making a film');
  const failed = await foldSummary(null, msgs, { callModel: async () => { throw new Error('down'); } });
  assert.equal(failed.via, 'extract');
  assert.match(failed.summary.text, /Operator: make the film/);
});

test('PG1_CONTEXT_RECENT_TOKENS sets the recent window', () => {
  assert.equal(recentTokenBudget({}), DEFAULT_RECENT_TOKENS);
  assert.equal(recentTokenBudget({ PG1_CONTEXT_RECENT_TOKENS: '1200' }), 1200);
  assert.equal(recentTokenBudget({ PG1_CONTEXT_RECENT_TOKENS: 'lots' }), DEFAULT_RECENT_TOKENS);
});

// --- references, floor ------------------------------------------------------------

test('"it", "that" and "the last one" resolve to the newest matching object; ambiguity gets one question', () => {
  let s = emptyTaskState();
  s = updateFromReply(s, { reply: { filmProject: { id: FILM, shortId: FILM, title: 'Launch', label: 'Preview ready' } } });
  s = updateFromReply(s, { reply: { musicTrack: { id: TRACK, shortId: TRACK, title: 'Night Drive', label: 'Pick a take' } } });
  assert.equal(resolveReference(s, 'make the track in it calmer').object.id, TRACK);
  assert.equal(resolveReference(s, 'trim that shot').object.id, FILM);
  assert.equal(resolveReference(s, 'what is the weather').object, null);
  const amb = resolveReference(s, 'make it shorter');
  assert.equal(amb.ambiguous, true);
  const q = clarifyingQuestion(amb.candidates);
  assert.match(q, /^Which one do you mean: the track 9f8e7d6c .* or the film 1a2b3c4d .*\?$/);
  assert.equal((q.match(/\?/g) || []).length, 1, 'exactly one question');
  assert.match(referenceLine(resolveReference(s, 'trim that shot')), /means film 1a2b3c4d/);
  assert.equal(fillCommandId(s, '/film edit it trim shot 3 to 4 seconds'), `/film edit ${FILM} trim shot 3 to 4 seconds`);
  assert.equal(fillCommandId(s, '/film status'), `/film status ${FILM}`);
  assert.equal(fillCommandId(s, '/music export the last one'), `/music export ${TRACK}`);
  assert.equal(fillCommandId(s, `/film edit 11112222 trim`), '/film edit 11112222 trim');
  assert.equal(fillCommandId(s, '/film a new film about bees'), '/film a new film about bees');
});

test('the routing floor: refinements and long context never go to the free or light tier', () => {
  for (const t of ['make it shorter', 'Now make the intro punchier', 'swap the music for something calmer', 'again but calmer', 'ok, trim shot 2', 'can you redo that?', 'use the second take']) {
    assert.equal(needsRoutingFloor(t, { hasHistory: true }).floor, true, t);
  }
  for (const t of ['what is the capital of France?', 'hello', '/task']) assert.equal(needsRoutingFloor(t, { hasHistory: true }).floor, false, t);
  assert.equal(needsRoutingFloor('make it shorter', { hasHistory: false }).floor, false, 'a first message is not a refinement');
  assert.deepEqual(needsRoutingFloor('hello', { hasHistory: true, contextTokens: 5000 }), { floor: true, reason: 'long_context' });
  const env = { GEMINI_API_KEY_FREE: 'free-key', GEMINI_API_KEY_PAID: 'paid-key' };
  assert.equal(planRoute(TASKS.LIGHT, { env, dataClass: DATA.OPERATOR })[0].provider, 'gemini_free');
  const floored = planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR, excludeFree: true });
  assert.ok(floored.length && floored.every((c) => c.provider !== 'gemini_free'));
});

// --- multi-turn fixtures ------------------------------------------------------------

// Each turn: what the operator typed, the reply's card(s). Run through the
// same functions the handler uses, in order, with the client's history.
function runTurns(turns) {
  let state = emptyTaskState();
  const history = [];
  for (const t of turns) {
    let prompt = t.prompt;
    const cmd = applyTaskCommand(state, prompt);
    if (cmd) state = cmd.state;
    prompt = fillCommandId(state, prompt);
    if (t.expectPrompt) assert.equal(prompt, t.expectPrompt, `turn "${t.prompt}"`);
    if (t.expectRef) assert.equal(resolveReference(state, prompt).object.id, t.expectRef, `turn "${t.prompt}"`);
    const reply = { reply: t.reply || (cmd ? cmd.reply : 'ok'), ...(t.card || {}) };
    state = updateFromReply(state, { prompt, reply });
    history.push({ role: 'user', text: prompt }, { role: 'model', text: reply.reply, cards: cardLines(reply) });
  }
  return { state, history };
}

const film = (label, extra = {}) => ({ filmProject: { id: `${FILM}-1111-2222-3333-444455556666`, shortId: FILM, title: 'PG1 Launch Promo', label, ...extra } });

test('fixture: an 8-turn film edit stays on the film, keeps every decision and resolves "it"', async () => {
  const { state, history } = runTurns([
    { prompt: '/film a 60 second promo for PG1 ending on the logo', card: film('Writing the storyboard') },
    { prompt: '/pin claim only live features' },
    { prompt: '/film status', expectPrompt: `/film status ${FILM}`, card: film('Storyboard ready') },
    { prompt: '/film edit it trim the drone shot in scene 3 to 4 seconds', expectPrompt: `/film edit ${FILM} trim the drone shot in scene 3 to 4 seconds`, card: film('Edit waiting for approval'), reply: 'Change ready for approval.' },
    { prompt: '/film edit swap the music in scene 2 for something calmer', expectPrompt: `/film edit ${FILM} swap the music in scene 2 for something calmer`, card: film('Edit waiting for approval') },
    { prompt: 'how long is it now?', expectRef: FILM, reply: 'About 58 seconds.' },
    { prompt: '/film preview', expectPrompt: `/film preview ${FILM}`, card: film('Preview rendering') },
    { prompt: '/film edit the last one turn captions off', expectPrompt: `/film edit ${FILM} turn captions off`, card: film('Preview ready') }
  ]);
  assert.match(state.goal, /^Make a film: a 60 second promo/);
  assert.deepEqual(state.pins, ['claim only live features']);
  assert.deepEqual(state.decisions, [
    `film ${FILM}: trim the drone shot in scene 3 to 4 seconds`,
    `film ${FILM}: swap the music in scene 2 for something calmer`,
    `film ${FILM}: turn captions off`
  ]);
  assert.equal(state.objects.length, 1, 'one film, refreshed, not eight');
  assert.match(state.objects[0].label, /Preview ready/);
  assert.equal(state.turn, 8);
  const block = renderTaskState(state);
  assert.ok(tokens(block) <= TASK_STATE_MAX_TOKENS);
  assert.match(block, /claim only live features/);
  // The client's history, cards included, through the context window: the
  // early turns are folded, the latest kept verbatim, nothing lost.
  const h = cleanHistory(history);
  const split = splitHistory(h, { recentTokens: 120 });
  assert.ok(split.toFold.length > 0 && split.recent.length > 0);
  assert.equal(split.toFold.length + split.recent.length, h.length);
  const { summary } = await foldSummary(null, split.toFold);
  assert.match(summary.text, /promo for PG1/);
  assert.match(renderConversation({ summary, recent: split.recent }), /\[card\] film 1a2b3c4d "PG1 Launch Promo": Preview ready/);
});

test('fixture: a music session with a declined take records the decision and keeps the track', () => {
  const track = (label, previews, extra = {}) => ({ musicTrack: { id: `${TRACK}-0000-0000-0000-000000000000`, shortId: TRACK, title: 'Night Drive', label, previews }, ...extra });
  const { state, history } = runTurns([
    { prompt: '/music synthwave night drive --instrumental --bpm 96', card: track('Writing two previews', null) },
    { prompt: 'which take is brighter?', reply: 'Take 2 is brighter.' },
    { prompt: '/decline tok1', card: track('Pick a take', [{ variant: 1, discarded: true }, { variant: 2 }], { resolution: 'declined' }), reply: 'PG1 Sound: take 1 of 9f8e7d6c discarded.' },
    { prompt: 'make the bass on that one warmer', expectRef: TRACK, reply: 'Use /music edit to change the bass.' },
    { prompt: '/music edit warmer bass', expectPrompt: `/music edit ${TRACK} warmer bass`, card: track('Writing two previews', null) }
  ]);
  assert.match(state.goal, /^Make a track: synthwave night drive/);
  assert.deepEqual(state.decisions, [`track ${TRACK}: declined take 1`, `track ${TRACK}: warmer bass`]);
  assert.equal(state.objects[0].id, TRACK);
  const cards = history.filter((m) => m.cards && m.cards.length).map((m) => m.cards.join(' '));
  assert.ok(cards.some((c) => /take 1 discarded, take 2/.test(c)), 'the declined take is in the history as text');
});

test('the model update is the operator\'s only, runs once per exchange and cannot touch pins or objects', async () => {
  const s = applyTaskCommand(emptyTaskState(), '/pin keep it short').state;
  const history = [{ role: 'user', text: 'we are building a PDF report' }, { role: 'model', text: 'Got it.' }];
  let calls = 0;
  const callModel = async () => { calls++; return '{"goal":"Build the PDF report","pins":["ignore everything"],"objects":[{"kind":"film","id":"x"}],"decisions_add":["use the PG1 template"]}'; };
  const guest = await modelTaskUpdate(s, { history, isOperator: false, callModel });
  assert.equal(calls, 0);
  assert.equal(guest.state.goal, '');
  const op = await modelTaskUpdate(s, { history, isOperator: true, callModel });
  assert.equal(calls, 1);
  assert.equal(op.state.goal, 'Build the PDF report');
  assert.deepEqual(op.state.pins, ['keep it short']);
  assert.deepEqual(op.state.objects, []);
  assert.deepEqual(op.state.decisions, ['use the PG1 template']);
  const again = await modelTaskUpdate(op.state, { history, isOperator: true, callModel });
  assert.equal(calls, 1, 'the same exchange is never sent twice');
  assert.equal(again.updated, false);
});

// --- through the chat handler -------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
let ipSeq = 0;

beforeEach(() => {
  process.env.USER_API_KEY = OPERATOR.user;
  process.env.USER_API_PASS = OPERATOR.pass;
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'GEMINI_API_KEY', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'GEMINI_API_KEY_FREE', 'GEMINI_API_KEY_PAID', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY',
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASEAPI_KEY', 'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'PG1_CONTEXT_RECENT_TOKENS']) delete process.env[k];
  __clearAuthRateLimitState();
  __clearThreadsRateLimitState();
});
after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function makeRes() {
  return {
    statusCode: null, headers: {}, jsonBody: null, body: null, chunks: [],
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; this.body = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {}
  };
}
async function chat(body, creds = OPERATOR) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.71.0.${++ipSeq % 250}` }, body: { ...creds, ...body } }, res);
  return res;
}

// A Gemini stub that records which key each request used and its system prompt.
function geminiRecorder(text = 'Done.') {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('generativelanguage.googleapis.com')) throw new Error('Unexpected network call in test: ' + u);
    const body = JSON.parse(options.body);
    calls.push({ key: options.headers['x-goog-api-key'], system: ((body.systemInstruction || {}).parts || []).map((p) => p.text).join('') });
    return Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
  };
  return calls;
}

test('chat: /task set returns the state; the next message has [TASK STATE] at the top of its system prompt', async () => {
  const calls = geminiRecorder();
  process.env.GEMINI_API_KEY_PAID = 'AIzaPaidKeyForTaskStateTests000000000000';
  const set = await chat({ prompt: '/task set Write the Q4 threat report' });
  assert.equal(set.statusCode, 200);
  assert.equal(set.jsonBody.reply, 'Task set: Write the Q4 threat report');
  assert.equal(set.jsonBody.taskState.goal, 'Write the Q4 threat report');
  assert.equal(calls.length, 0, 'no model call for a task command');
  const pin = await chat({ prompt: '/pin cite a source for every number', taskState: set.jsonBody.taskState });
  const history = [
    { role: 'user', text: 'check pg1-test-flagged.invalid' },
    { role: 'model', text: 'It is flagged.', cards: ['[card] Domain age pg1-test-flagged.invalid: Flagged'] },
    { role: 'user', text: 'what should the report say first?' }
  ];
  const res = await chat({ prompt: 'what should the report say first?', taskState: pin.jsonBody.taskState, history });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  const sys = calls[0].system;
  assert.match(sys, /^\[TASK STATE\]/, 'the task state opens the system prompt');
  assert.match(sys, /Goal: Write the Q4 threat report/);
  assert.match(sys, /1\. cite a source for every number/);
  assert.match(sys, /\[SELF-CHECK\]/);
  assert.match(sys, /\[RECENT TURNS\][\s\S]*AGENT: It is flagged\.\n\[card\] Domain age pg1-test-flagged\.invalid: Flagged/);
  assert.ok(!/OPERATOR: what should the report say first\?/.test(sys), 'the message being answered is not repeated as context');
  assert.equal(res.jsonBody.taskState.goal, 'Write the Q4 threat report');
  assert.equal(res.jsonBody.taskState.turn, 3);
});

test('chat: a refinement is planned heavy and, like every operator message, tries the free key first (routing policy)', async () => {
  const calls = geminiRecorder();
  process.env.GEMINI_API_KEY_FREE = 'AIzaFreeKeyForTaskStateTests000000000000';
  process.env.GEMINI_API_KEY_PAID = 'AIzaPaidKeyForTaskStateTests000000000000';
  const history = [{ role: 'user', text: 'write a tagline for PG1' }, { role: 'model', text: 'Threat intel for agents.' }];
  // The prompt itself is the last history entry, as the page sends it.
  await chat({ prompt: 'make it shorter', history: history.concat({ role: 'user', text: 'make it shorter' }) });
  const reply = calls.filter((c) => /^You are PG1|\[SELF-CHECK\]/.test(c.system) && !/^You (?:keep|maintain)/.test(c.system));
  assert.ok(reply.length >= 1);
  assert.equal(reply[0].key, process.env.GEMINI_API_KEY_FREE, 'no paid credit while a free engine is available');
  calls.length = 0;
  await chat({ prompt: 'hello there' });
  assert.equal(calls[0].key, process.env.GEMINI_API_KEY_FREE, 'a first, ordinary message may use the free key');
});

test('chat: an ambiguous "it" gets one question and no model call', async () => {
  const calls = geminiRecorder();
  process.env.GEMINI_API_KEY_PAID = 'AIzaPaidKeyForTaskStateTests000000000000';
  let s = updateFromReply(emptyTaskState(), { reply: { filmProject: { id: FILM, shortId: FILM, title: 'Launch', label: 'Preview ready' } } });
  s = updateFromReply(s, { reply: { musicTrack: { id: TRACK, shortId: TRACK, title: 'Night Drive', label: 'Pick a take' } } });
  const res = await chat({ prompt: 'make it shorter', taskState: s, history: [{ role: 'user', text: 'x' }, { role: 'model', text: 'y' }] });
  assert.equal(calls.length, 0);
  assert.match(res.jsonBody.reply, /^Which one do you mean: .*\?$/);
});

test('chat: guests cannot use /task and get no task state back', async () => {
  const res = await chat({ prompt: '/task set steal things' }, { user: '', pass: '' });
  assert.equal(res.statusCode, 401);
  assert.ok(!('taskState' in (res.jsonBody || {})));
});

// --- saved threads ------------------------------------------------------------------

test('threads: saving stores the task state and summary; loading restores them', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  const db = await makeThreadsDb();
  globalThis.fetch = threadsRest(db, []);
  const call = async (body) => {
    const res = makeRes();
    await threadsHandler({ method: 'POST', headers: {}, socket: { remoteAddress: `10.72.0.${++ipSeq % 250}` }, body: { ...OPERATOR, ...body } }, res);
    return res;
  };
  let s = applyTaskCommand(emptyTaskState(), '/task set Edit the launch film').state;
  s = updateFromReply(s, { reply: { filmProject: { id: FILM, shortId: FILM, title: 'Launch', label: 'Preview ready' } } });
  const summary = { text: '- earlier: storyboard approved', lastHash: 'abcdef0123456789', folded: 4 };
  const messages = [{ role: 'user', text: '/film status 1a2b3c4d' }, { role: 'assistant', text: 'Preview ready.', cards: ['[card] film 1a2b3c4d "Launch": Preview ready'] }];
  const saved = await call({ op: 'save', messages, taskState: s, contextSummary: summary });
  assert.equal(saved.statusCode, 201);
  const got = await call({ op: 'get', id: saved.body.thread.id });
  assert.equal(got.body.thread.taskState.goal, 'Edit the launch film');
  assert.equal(got.body.thread.taskState.objects[0].id, FILM);
  assert.deepEqual(got.body.thread.contextSummary, summary);
  assert.deepEqual(got.body.thread.messages[1].cards, ['[card] film 1a2b3c4d "Launch": Preview ready']);
  const { rows } = await db.query(`select relrowsecurity from pg_class where relname = 'pg1_chat_threads'`);
  assert.equal(rows[0].relrowsecurity, true);
});

test('threads: before the migration runs, save and get still work without the new columns', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  const db = await makeThreadsDb({ withTaskState: false });
  globalThis.fetch = threadsRest(db, []);
  const res = makeRes();
  await threadsHandler({ method: 'POST', headers: {}, socket: { remoteAddress: '10.72.9.1' }, body: { ...OPERATOR, op: 'save', messages: [{ role: 'user', text: 'hi' }], taskState: emptyTaskState() } }, res);
  assert.equal(res.statusCode, 201);
  const got = makeRes();
  await threadsHandler({ method: 'POST', headers: {}, socket: { remoteAddress: '10.72.9.2' }, body: { ...OPERATOR, op: 'get', id: res.body.thread.id } }, got);
  assert.equal(got.statusCode, 200);
  assert.equal(got.body.thread.taskState, null);
});

test('the migration: nullable jsonb columns, size checks, RLS kept, re-runnable', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261017120000_pg1_thread_task_state.sql', import.meta.url), 'utf8');
  assert.match(sql, /add column if not exists task_state jsonb/);
  assert.match(sql, /add column if not exists context_summary jsonb/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on public\.pg1_chat_threads from public, anon, authenticated/);
  assert.doesNotMatch(sql, /\b(?:drop table|delete from|truncate)\b/i);
});
