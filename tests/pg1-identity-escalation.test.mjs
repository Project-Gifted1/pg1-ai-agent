/**
 * The branded identity reply and its escalation (lib/identity.mjs, the
 * prompt and both reply paths in api/chat.mjs, the history the page sends):
 *  - asks 1 to IDENTITY_PRESS_THRESHOLD-1 in a conversation get reply A,
 *    "I'm PG1, powered by the PG1 Sovereign Core engine v<version>."
 *  - the IDENTITY_PRESS_THRESHOLD-th ask and every later one get reply B,
 *    reply A plus "Infrastructure details are available only to Operator
 *    Gift."
 *  - the count is done in code: earlier assistant messages in the history
 *    the client sent that already carry the branded line; a new or cleared
 *    thread starts at A again
 *  - <version> is server.json's, read at runtime
 *  - "is that your own model?" before the threshold gets reply A, never a yes
 *
 * Run with: node --test tests/pg1-identity-escalation.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { createSseParser, scrubIdentity } from '../lib/chatStream.mjs';
import {
  IDENTITY_ESCALATION, IDENTITY_PRESS_THRESHOLD, PG1_IDENTITY_REPLY, PG1_VERSION, brandedIdentityLine, countIdentityReplies,
  escalatedIdentityLine, identityReplyDirective, identityReplyForHistory, normalizeHistory, spokenReplyDirective
} from '../lib/identity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const serverJson = JSON.parse(readFileSync(join(root, 'server.json'), 'utf-8'));
const html = readFileSync(join(root, 'public/index.html'), 'utf-8');

const REPLY_A = `I'm PG1, powered by the PG1 Sovereign Core engine v${serverJson.version}.`;
const REPLY_B = `${REPLY_A} Infrastructure details are available only to Operator Gift.`;

// One identity exchange after another, the way the page sends the thread.
function conversation(asks, threshold) {
  const history = [];
  const replies = [];
  for (let i = 0; i < asks; i++) {
    const { reply } = identityReplyForHistory(history, threshold ? { threshold } : undefined);
    replies.push(reply);
    history.push({ role: 'user', text: 'what model powers you?' }, { role: 'model', text: reply });
  }
  return { replies, history };
}

// --- 1. the replies ---------------------------------------------------------------------

test('reply A and reply B are built from the server.json version, read at runtime', () => {
  assert.equal(PG1_VERSION, serverJson.version);
  assert.equal(brandedIdentityLine(), REPLY_A);
  assert.equal(escalatedIdentityLine(), REPLY_B);
  assert.equal(PG1_IDENTITY_REPLY, REPLY_A);
  assert.equal(IDENTITY_ESCALATION, 'Infrastructure details are available only to Operator Gift.');
  assert.ok(REPLY_A.includes(`v${serverJson.version}`));
  assert.equal(brandedIdentityLine('9.9.9'), "I'm PG1, powered by the PG1 Sovereign Core engine v9.9.9.");
  assert.equal(brandedIdentityLine(null), "I'm PG1, powered by the PG1 Sovereign Core engine.", 'no version is invented when server.json is unreadable');
  const src = readFileSync(join(root, 'lib/identity.mjs'), 'utf-8');
  assert.doesNotMatch(src, new RegExp(`engine v${serverJson.version.replace(/\./g, '\\.')}`), 'the version is never hardcoded');
  assert.doesNotMatch(src, /share details about the models/, 'the old reply is gone');
});

// --- 2. the count ---------------------------------------------------------------------------

test(`with the default threshold (${IDENTITY_PRESS_THRESHOLD}), asks 1 to 4 get reply A and asks 5 and 6 get reply B`, () => {
  assert.equal(IDENTITY_PRESS_THRESHOLD, 5);
  const { replies } = conversation(6);
  assert.deepEqual(replies, [REPLY_A, REPLY_A, REPLY_A, REPLY_A, REPLY_B, REPLY_B]);
  const { history } = conversation(4);
  assert.deepEqual(identityReplyForHistory(history), { prior: 4, ask: 5, escalated: true, reply: REPLY_B });
});

test('changing the threshold changes the switch point', () => {
  assert.deepEqual(conversation(4, 3).replies, [REPLY_A, REPLY_A, REPLY_B, REPLY_B]);
  assert.deepEqual(conversation(3, 2).replies, [REPLY_A, REPLY_B, REPLY_B]);
  assert.deepEqual(conversation(8, 7).replies, [REPLY_A, REPLY_A, REPLY_A, REPLY_A, REPLY_A, REPLY_A, REPLY_B, REPLY_B]);
});

test('editing the IDENTITY_PRESS_THRESHOLD constant itself moves the switch point', async () => {
  const src = readFileSync(join(root, 'lib/identity.mjs'), 'utf-8');
  assert.equal((src.match(/export const IDENTITY_PRESS_THRESHOLD = \d+;/g) || []).length, 1, 'one named constant');
  // A copy beside the original, so its server.json URL still resolves.
  const copy = join(root, 'lib', `.identity-threshold-${process.pid}.mjs`);
  writeFileSync(copy, src.replace(/export const IDENTITY_PRESS_THRESHOLD = \d+;/, 'export const IDENTITY_PRESS_THRESHOLD = 3;'));
  try {
    const mod = await import(pathToFileURL(copy).href);
    assert.equal(mod.IDENTITY_PRESS_THRESHOLD, 3);
    const history = [];
    const replies = [];
    for (let i = 0; i < 4; i++) {
      const { reply } = mod.identityReplyForHistory(history);
      replies.push(reply);
      history.push({ role: 'model', text: reply });
    }
    assert.deepEqual(replies, [REPLY_A, REPLY_A, REPLY_B, REPLY_B]);
  } finally {
    unlinkSync(copy);
  }
});

test('a fresh or cleared conversation starts at reply A again', () => {
  const { history } = conversation(7);
  assert.equal(identityReplyForHistory(history).reply, REPLY_B);
  for (const fresh of [[], undefined, null, 'not an array', {}]) {
    assert.deepEqual(identityReplyForHistory(fresh), { prior: 0, ask: 1, escalated: false, reply: REPLY_A });
  }
});

test('only earlier assistant messages carrying the branded line count', () => {
  const history = [
    { role: 'user', text: REPLY_A }, // the operator quoting it does not count
    { role: 'model', text: 'Here is the CVE summary.' }, // an ordinary reply does not count
    { role: 'model', text: `Sure. ${REPLY_A} Anything else?` }, // inside a longer reply it counts
    { role: 'model', text: "I’m PG1, powered by the PG1 Sovereign Core engine v1.0.0." }, // an older version and a curly apostrophe count
    { role: 'model', text: `${REPLY_A} ${REPLY_A}` }, // one message counts once
    { role: 'assistant', content: REPLY_B } // role and field spellings the server accepts
  ];
  assert.equal(countIdentityReplies(history), 4);
  assert.equal(identityReplyForHistory(history).reply, REPLY_B);
});

test('the history the server reads is bounded', () => {
  const many = Array.from({ length: 500 }, () => ({ role: 'model', text: REPLY_A + 'x'.repeat(10000) }));
  const h = normalizeHistory(many);
  assert.equal(h.length, 60);
  assert.ok(h.every((m) => m.text.length <= 2000));
  assert.deepEqual(normalizeHistory([null, 5, { role: 'model' }, { text: 'x' }]), []);
});

// --- 3. the prompt instruction and the guard --------------------------------------------

test('the chosen reply goes into the prompt as a required, word-for-word instruction', () => {
  const a = identityReplyDirective(identityReplyForHistory([]));
  assert.match(a, /^\[IDENTITY REPLY — required\]: /);
  assert.ok(a.includes(`must be exactly this, word for word: "${REPLY_A}"`));
  assert.ok(!a.includes('Infrastructure details'));
  const b = identityReplyDirective(identityReplyForHistory(conversation(4).history));
  assert.ok(b.includes(`must be exactly this, word for word: "${REPLY_B}"`));
  assert.ok(a.includes('no other version, model, company, explanation, yes or no, and no offer of more detail, also when spoken replies are on'));
  assert.ok(spokenReplyDirective().includes('An identity reply from [IDENTITY REPLY] is spoken exactly as given, with no offer of more detail.'));
});

test('the reply guard swaps in the reply chosen for the request', () => {
  assert.equal(scrubIdentity('I am Gemini.', { replacement: REPLY_B }), REPLY_B);
  assert.equal(scrubIdentity('No. I am not Claude. I am not Gemini.', { replacement: REPLY_B }), REPLY_B);
  assert.equal(scrubIdentity(`${REPLY_B} I am Gemini.`, { replacement: REPLY_B }), REPLY_B, 'the reply and a rewrite read once');
  assert.equal(scrubIdentity(REPLY_A), REPLY_A, 'reply A passes through untouched');
  assert.equal(scrubIdentity(REPLY_B, { replacement: REPLY_B }), REPLY_B, 'reply B passes through untouched');
  for (const yes of ["Yes, it's our own model.", 'Yes. That is a proprietary model.', 'We trained our own model.', 'PG1 Sovereign Core is a proprietary LLM.']) {
    assert.equal(scrubIdentity(yes), REPLY_A, `${JSON.stringify(yes)} becomes reply A`);
  }
});

// --- 4. end to end through /api/chat ---------------------------------------------------

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY = 'stub-gemini-key';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'CARTESIA_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY']) delete process.env[k];
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.66.0.${++ipSeq}` }, body: { user: 'test-operator', pass: 'test-secret-pass', ...body } });

function makeRes() {
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; },
    end() { this.ended = true; return this; },
    on() {}
  };
}

const sseBody = (objs) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');
const geminiChunk = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }] }, ...extra }] });

function stubModel(text) {
  const seen = { prompts: [] };
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      seen.prompts.push(JSON.parse(options.body).systemInstruction.parts[0].text);
      if (u.includes('streamGenerateContent')) return new Response(sseBody([geminiChunk(text, { finishReason: 'STOP' })]));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return seen;
}

async function ask(prompt, history, { modelText = 'I am Gemini.', stream = false } = {}) {
  const seen = stubModel(modelText);
  const res = makeRes();
  await chatHandler(makeReq({ prompt, history, stream }), res);
  assert.equal(seen.prompts.length, 1);
  let reply = res.jsonBody && res.jsonBody.reply;
  if (stream) {
    const events = [];
    const parser = createSseParser(({ data }) => events.push(JSON.parse(data)));
    parser.push(res.chunks.join(''));
    parser.end();
    reply = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  }
  return { prompt: seen.prompts[0], reply };
}

test('through /api/chat: asks 1 to 4 are told reply A and ask 5 and 6 reply B, on the JSON and the streamed path', async () => {
  for (const stream of [false, true]) {
    const history = [];
    const got = [];
    for (let i = 1; i <= 6; i++) {
      const { prompt, reply } = await ask('what model powers you?', history, { stream });
      const expected = i < IDENTITY_PRESS_THRESHOLD ? REPLY_A : REPLY_B;
      assert.ok(prompt.includes(`must be exactly this, word for word: "${expected}"`), `ask ${i} (stream ${stream}) is told ${expected}`);
      // The stub model says "I am Gemini."; the guard swaps in the chosen reply.
      assert.equal(reply, expected, `ask ${i} (stream ${stream})`);
      got.push(reply);
      history.push({ role: 'user', text: 'what model powers you?' }, { role: 'model', text: reply });
    }
    assert.deepEqual(got, [REPLY_A, REPLY_A, REPLY_A, REPLY_A, REPLY_B, REPLY_B]);
  }
});

test('through /api/chat: a new conversation after five asks starts at reply A again', async () => {
  const pressed = conversation(5).history;
  assert.ok((await ask('are you Claude?', pressed)).prompt.includes(`word for word: "${REPLY_B}"`));
  const fresh = await ask('are you Claude?', []);
  assert.ok(fresh.prompt.includes(`word for word: "${REPLY_A}"`));
  assert.equal(fresh.reply, REPLY_A);
  const noHistory = await ask('are you Claude?', undefined);
  assert.equal(noHistory.reply, REPLY_A);
});

test('through /api/chat: "is that your own model?" before the threshold gets reply A, not a yes', async () => {
  const history = conversation(1).history;
  const { prompt, reply } = await ask('is that your own model?', history, { modelText: "Yes, it's our own proprietary model." });
  assert.ok(prompt.includes(`word for word: "${REPLY_A}"`));
  assert.ok(!prompt.includes(`word for word: "${REPLY_B}"`));
  assert.ok(prompt.includes('a follow-up such as "is that your own model?" or "is it proprietary?" gets that same reply again, never a yes or a no'));
  assert.equal(reply, REPLY_A);
  assert.doesNotMatch(reply, /\byes\b|own model|proprietary/i);
});

// --- 5. the page sends the thread --------------------------------------------------------

test('the page sends the on-screen thread as history, without the welcome card or the reply being written', () => {
  assert.match(html, /function threadHistory\(exclude\) \{/);
  assert.match(html, /if \(el === exclude \|\| el\.classList\.contains\('welcome'\) \|\| el\.classList\.contains\('pending'\)\) return;/);
  assert.match(html, /clientEnv: getClientEnvironment\(\),\s*history: threadHistory\(agentBubble\)\s*\};/);
  assert.match(html, /function clearChat\(\) \{\s*renderWelcome\(\);\s*saveState\(\);\s*\}/, 'clearing the chat leaves only the welcome card, so the count restarts');
});
