/**
 * Follow-up to PR #244 (issue #245): the identity reply is for identity
 * questions about PG1 itself only.
 *  - "are you powered by Claude", "do any of these models power you", "are
 *    you Gemini?" ask what PG1 runs on: identity questions, [IDENTITY REPLY]
 *  - "do you know Gemini", "what is ChatGPT", "who makes X", "compare X and
 *    Y", "news about X" ask about the third-party model or company on its
 *    own: general knowledge, a normal factual answer, never the identity
 *    reply, and naming the model in that answer is not a claim about PG1
 *  - a factual answer about a third-party model never mentions PG1's own
 *    commands, routing, fallbacks or engines (lib/identity.mjs,
 *    tests/pg1-identity-guard.test.mjs has the reply-guard half of this)
 *
 * Run with: node --test tests/pg1-identity-scope.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { PG1_IDENTITY_REPLY, identityDirective } from '../lib/identity.mjs';
import { scrubIdentity, createReplyScrubber } from '../lib/chatStream.mjs';

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
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.91.0.${++ipSeq}` }, body });
const authed = (extra) => ({ user: 'test-operator', pass: 'test-secret-pass', ...extra });

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

function stubModel(text) {
  const seen = { prompts: [] };
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      seen.prompts.push(JSON.parse(options.body).systemInstruction.parts[0].text);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return seen;
}

async function ask(prompt, modelText) {
  const seen = stubModel(modelText);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt })), res);
  return { prompt: seen.prompts[0], reply: res.jsonBody.reply };
}

// --- 1. the directive states the distinction, with the issue's own examples ------------

test('the directive tells apart an identity question from a general-knowledge question about a model', () => {
  const d = identityDirective();
  assert.ok(d.includes('A general-knowledge question about an AI model, company or product is not an identity question'));
  for (const example of ['"do you know Gemini"', '"what is Gemini"', '"who makes ChatGPT"', '"compare Claude and Gemini"', '"news about OpenAI"']) {
    assert.ok(d.includes(example), `directive gives the example ${example}`);
  }
  for (const example of ['"are you powered by Claude"', '"do any of these models power you"', '"are you Gemini?"']) {
    assert.ok(d.includes(example), `directive gives the identity-question example ${example}`);
  }
  assert.ok(d.includes('The test is whether the question makes a claim about PG1 itself'));
  assert.ok(d.includes('do not count as an identity ask'));
});

test('the directive forbids mentioning PG1\'s own commands or internals when discussing a third-party model', () => {
  const d = identityDirective();
  assert.ok(d.includes("Never mention PG1's own commands, slash commands, routing, fallbacks, engines or any other internal mechanism while discussing a third-party AI model, provider or company"));
  assert.ok(d.includes('/core'));
});

// --- 2. end to end: a general-knowledge question gets a normal answer, untouched -------

test('through /api/chat: "do you know Gemini" and "what is ChatGPT" get the model\'s factual answer, not the identity reply', async () => {
  for (const prompt of ['Do you know Gemini', 'do you know Gemini?', 'what is ChatGPT']) {
    const modelText = 'Gemini is a family of multimodal AI models made by Google.';
    const { reply } = await ask(prompt, prompt.toLowerCase().includes('chatgpt') ? 'ChatGPT is a conversational AI product made by OpenAI.' : modelText);
    assert.doesNotMatch(reply, /I'm PG1, powered by/, `${JSON.stringify(prompt)} must not get the identity reply`);
  }
});

test('through /api/chat: identity questions still get the branded reply', async () => {
  for (const prompt of ['Are you powered by Claude or Gemini or chat gpt', 'Do any of these models power you', 'are you Gemini?']) {
    const { reply } = await ask(prompt, 'I am Gemini.');
    assert.match(reply, /^I'm PG1, powered by the PG1 Sovereign Core engine/, `${JSON.stringify(prompt)} must get the identity reply`);
  }
});

test('a factual answer naming a model is not rewritten by the reply guard just because it names the model', async () => {
  const { reply } = await ask('Do you know Claude', "Claude is a family of large language models made by Anthropic, known for long context windows and careful instruction following.");
  assert.match(reply, /Anthropic/, 'the factual answer survives whole');
  assert.doesNotMatch(reply, /\/claude|\/core|reasoning core|main core/i, 'no PG1 internals leak into a factual answer about a model');
});

// A correct factual answer that calls the third-party model proprietary or
// in-house ("It is a proprietary model developed by Google.") is about that
// model, not a yes to "is that your own model?": the guard leaves it whole.
const PROPRIETARY_FACTS = [
  'Gemini is Google DeepMind\'s family of large language models. It is a proprietary model developed by Google.',
  "Gemini is Google's AI. It's a proprietary large language model that competes with GPT-5.",
  "Gemini is Google's model. That's a proprietary model, so its weights aren't public.",
  'Yes! Gemini was trained by Google DeepMind. It is an in-house model at Google.'
];

test('the reply guard leaves a factual answer calling a third-party model proprietary untouched, JSON and streamed', () => {
  for (const fact of PROPRIETARY_FACTS) {
    assert.equal(scrubIdentity(fact), fact, `rewritten: ${JSON.stringify(fact)}`);
    let streamed = '';
    const s = createReplyScrubber((t) => { streamed += t; });
    for (let i = 0; i < fact.length; i += 5) s.push(fact.slice(i, i + 5));
    s.flush();
    assert.equal(streamed, fact, `rewritten when streamed: ${JSON.stringify(fact)}`);
  }
  // the model was named in text already released before the claim's chunk
  const long = 'Gemini is the family of large language models that Google DeepMind announced in December 2023 and has updated many times since. It is a proprietary model developed by Google.';
  let streamed = '';
  const s = createReplyScrubber((t) => { streamed += t; });
  for (let i = 0; i < long.length; i += 7) s.push(long.slice(i, i + 7));
  s.flush();
  assert.equal(streamed, long);
});

test('the reply guard still rewrites PG1 claiming a model of its own, even next to a third-party name', () => {
  for (const claim of ["Yes, it's our own model.", 'Yes. That is a proprietary model.', 'Unlike ChatGPT, it is a proprietary model.',
    "I'm not ChatGPT or Gemini. It's a proprietary model.", 'Gemini is great. Yes, it is our own proprietary model.',
    'Gemini is great. PG1 Sovereign Core is a proprietary LLM.']) {
    const out = scrubIdentity(claim);
    assert.ok(out.includes(PG1_IDENTITY_REPLY), `not rewritten: ${JSON.stringify(claim)}`);
    assert.doesNotMatch(out, /proprietary|own model|\byes\b/i, `claim survives: ${JSON.stringify(claim)} -> ${out}`);
  }
});

test('through /api/chat: "Do you know Gemini" answered "It is a proprietary model developed by Google" is not replaced by the identity reply', async () => {
  for (const fact of PROPRIETARY_FACTS) {
    const { reply } = await ask('Do you know Gemini', fact);
    assert.equal(reply, fact);
    assert.doesNotMatch(reply, /I'm PG1, powered by/);
  }
});

// --- 3. only a real identity reply counts towards the escalation threshold --------------

test('through /api/chat: general-knowledge answers about a model never count towards the escalation threshold', async () => {
  let history = [];
  for (let i = 0; i < 6; i++) {
    stubModel('Gemini is a family of multimodal AI models made by Google.');
    const res = makeRes();
    await chatHandler(makeReq(authed({ prompt: 'do you know Gemini', history })), res);
    assert.doesNotMatch(res.jsonBody.reply, /I'm PG1, powered by/, `ask ${i + 1} is general knowledge, not identity`);
    history.push({ role: 'user', text: 'do you know Gemini' }, { role: 'model', text: res.jsonBody.reply });
  }
  // Six general-knowledge answers later, a real identity question still gets
  // reply A (ask 1): none of the above were real identity replies.
  stubModel('I am Gemini.');
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'are you Gemini?', history })), res);
  assert.equal(res.jsonBody.reply, PG1_IDENTITY_REPLY, 'reply A, not escalated: the prior general-knowledge answers were never counted');
});
