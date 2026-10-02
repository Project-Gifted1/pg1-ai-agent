/**
 * The PG1 identity rule (lib/identity.mjs, the reply guard in
 * lib/chatStream.mjs, both reply paths in api/chat.mjs):
 *  - PG1 never names the model or company behind it and shows no
 *    third-party branding of its own; asked what powers it, it answers
 *    along the lines of "I'm PG1, built by Project-Gifted1. I don't share
 *    details about the models behind me."
 *  - it never denies using a third-party model, never claims to be its own
 *    or an in-house model, and never names a different model than the real
 *    one
 *  - the reply guard that used to rewrite "I am Gemini" word by word now
 *    replaces the whole sentence with that answer, so it can never produce
 *    "I am not PG1", "I'm powered by PG1" or any other denial or in-house
 *    claim, on the JSON path and as the reply streams
 *
 * Run with: node --test tests/pg1-identity-guard.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { IDENTITY_CLAIM_RE, createReplyScrubber, createSseParser, hasOpenClaim, scrubIdentity } from '../lib/chatStream.mjs';
import { PG1_BUILDER, PG1_IDENTITY_REPLY, PG1_NAME, identityDirective } from '../lib/identity.mjs';

const LINE = PG1_IDENTITY_REPLY;

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

// Names a reply must never give for what powers PG1, and the shapes of a
// denial or an in-house claim. A scrubbed reply matches none of them.
const VENDOR_NAMES = /\b(Gemini|Google|Anthropic|Claude|OpenAI|ChatGPT|GPT)\b/;
const DENIAL = /\b(not|never|neither|no longer)\s+(PG1|Gemini|Google|Anthropic|Claude|OpenAI|ChatGPT)|\bnot\s+(powered|built|based|running|made|created|developed|trained)\b|\b(no|nothing)\s+(connection|relation|link|ties|to do)\b|\bthird-?party\b|\bexternal\s+(AI|model|provider)/i;
const IN_HOUSE = /\b(powered|built|based|running|made|created|developed|trained)\s+(by|on|upon)\s+PG1\b|\b(in-?house|proprietary|own|custom|from scratch|home-?grown|self-?built|self-?trained)\s*(AI|model|LLM|engine)?/i;

const assertClean = (out, input) => {
  assert.doesNotMatch(out, VENDOR_NAMES, `names a vendor for ${JSON.stringify(input)}: ${out}`);
  assert.doesNotMatch(out, DENIAL, `reads as a denial for ${JSON.stringify(input)}: ${out}`);
  assert.doesNotMatch(out, IN_HOUSE, `claims an in-house model for ${JSON.stringify(input)}: ${out}`);
};

// --- 1. the rule itself ---------------------------------------------------------------

test('the canonical answer names PG1 and its builder only, and the directive carries the three nevers', () => {
  assert.equal(PG1_NAME, 'PG1');
  assert.equal(PG1_BUILDER, 'Project-Gifted1');
  assert.equal(LINE, "I'm PG1, built by Project-Gifted1. I don't share details about the models behind me.");
  assertClean(LINE, 'the canonical answer');
  const d = identityDirective();
  assert.ok(d.includes(`answer along the lines of "${LINE}"`));
  assert.ok(d.includes('never answer such a question with a bare yes or no'));
  assert.match(d, /never deny using a third-party model \(never say you are not Gemini, not Claude, not from Google, not powered by anyone/);
  assert.match(d, /never claim to be Project-Gifted1's own, in-house, proprietary, custom or from-scratch model/);
  assert.match(d, /never name any model or company as the one behind you, neither the real one nor a different one/);
  assert.ok(d.includes('Show no third-party branding of your own.'));
  // Still an AI, and still allowed to talk about the companies as news.
  assert.ok(d.includes('If someone sincerely asks whether they are talking to an AI, always confirm that you are an AI.'));
  assert.ok(d.includes('name companies and products (such as OpenAI, ChatGPT, Google or Anthropic) normally and accurately'));
});

// --- 2. the reply guard rewrites the sentence, never the name ---------------------------------------

const CLAIMS = [
  // naming the real model or vendor
  'I am Gemini.', 'Hi, I am Gemini.', "I'm powered by Google.", 'I am Google Gemini.', 'I run on Gemini.', "I'm running on Claude Sonnet.",
  'I am a large language model trained by Google.', "I'm an AI assistant developed by Anthropic.", 'You are talking to Gemini.',
  "You're talking to a large language model from Google.", 'My underlying model is Gemini 2.5 Pro.', 'The model behind me is Claude.',
  'Under the hood, I am Gemini.', 'The underlying model is Gemini.', 'PG1 is powered by Gemini.', 'PG1 runs on Claude.', 'Google made me.',
  'Gemini powers me.', 'Anthropic built PG1.', "Google's model is behind me.", 'I come from Google.', 'I rely on Claude for reasoning.',
  // naming a different model than the real one
  "I'm GPT-4.", "I'm based on GPT-4o.", 'I was built by OpenAI.', 'I belong to OpenAI.', 'I am ChatGPT.',
  // denying a third-party model
  'I am not Gemini.', "I'm not powered by Google.", "No, I'm not Claude.", "I don't use Gemini.", 'I never call OpenAI.', 'I am not built on Anthropic.',
  "I'm not affiliated with OpenAI.", 'I have no connection to Google.', 'I have nothing to do with Anthropic.', 'I was not built by Google.',
  'I was never trained by OpenAI.', "I'm not from Anthropic.", 'I have not been built by Google.', 'I am neither Gemini nor Claude.',
  "I'm not a third-party model.", "I don't use any third-party models.", "I'm not powered by any external AI provider.", "I don't run on third-party LLMs.",
  'OpenAI is not behind me.', "I'm not Google's product.", 'I am not a Google product.',
  // claiming a model of its own
  "I'm Project-Gifted1's own model.", 'I am an in-house model.', "I'm PG1's own proprietary model.", 'I was built from scratch by Project-Gifted1.',
  'I use my own model.', "I'm a custom model built by Project-Gifted1."
];

test('every claim about what powers PG1 becomes the canonical answer, whole', () => {
  for (const input of CLAIMS) {
    const out = scrubIdentity(input);
    assert.equal(out, LINE, `${JSON.stringify(input)} => ${JSON.stringify(out)}`);
    assertClean(out, input);
  }
});

test('the guard cannot produce a denial: "I am not Gemini" never becomes "I am not PG1"', () => {
  for (const input of ['I am not Gemini.', "I'm not Gemini", 'I am not powered by Google.', "I'm not built on Anthropic.", 'I do not use Claude.']) {
    const out = scrubIdentity(input);
    assert.equal(out, LINE);
    assert.doesNotMatch(out, /not PG1|not powered|not built|do not use/i);
  }
});

test('the guard cannot produce an in-house claim: "powered by Google" never becomes "powered by PG1"', () => {
  for (const input of ["I'm powered by Google.", 'I am built on Anthropic.', 'I am running on Gemini.', 'I was trained by Google.']) {
    const out = scrubIdentity(input);
    assert.equal(out, LINE);
    assert.doesNotMatch(out, /(powered|built|running|trained) (by|on) PG1/i);
  }
});

test('a bare yes or no in front of the claim goes with it, so the answer never reads as a denial or a confirmation', () => {
  assert.equal(scrubIdentity('No. I am not Gemini.'), LINE);
  assert.equal(scrubIdentity('Yes! I am Gemini.'), LINE);
  assert.equal(scrubIdentity('Not at all. I am not a Google product.'), LINE);
  assert.equal(scrubIdentity('Are you asking what powers me? No. I am not Gemini. Anything else?'), `Are you asking what powers me? ${LINE} Anything else?`);
});

test('the rest of the reply is kept, two rewritten sentences in a row read once, and a list item keeps its marker', () => {
  assert.equal(
    scrubIdentity("Hi there! I am Gemini, a model by Google. I'm powered by Google. How can I help with Google Cloud today?"),
    `Hi there! ${LINE} How can I help with Google Cloud today?`
  );
  assert.equal(scrubIdentity('Some facts:\n- I am Gemini\n- I like threat intel'), `Some facts:\n- ${LINE}\n- I like threat intel`);
  assert.equal(scrubIdentity('I am Gemini. I am Claude.\nI am not ChatGPT.'), LINE, 'back-to-back claims, even across a line break, read once');
  assert.equal(scrubIdentity(LINE), LINE, 'the canonical answer passes through unchanged');
});

test('third-party topics, PG1 talking about itself without a vendor, and code blocks are left alone', () => {
  const untouched = [
    'Google announced a new phone yesterday.', 'I am sure Google will fix that.', "I'm happy to summarise Google's results.",
    'I checked Google Cloud status for you.', 'OpenAI released a new model.', 'I think the Pixel is powered by Gemini.',
    'Anthropic published a paper on Claude.', "ChatGPT is OpenAI's product.", 'Google made the Pixel.', 'Gemini powers the new Pixel assistant.',
    "I'm an AI assistant; how can I help?", 'I am PG1, the chat assistant.', 'I am an AI, yes.', 'I use my own judgement here.',
    'I have no idea what Google announced.', 'I am not sure Google has announced that.', "I'm not able to open Google Sheets.",
    'I run the check against the vault.', 'I am from London, where the runtime lives.', 'I am independent of your browser settings.',
    '```\nvar GEMINI_MODELS = ["gemini-3.8-flash"]; // I am Gemini\n```',
    '```json\n{"actionType":"APPLY_SURGICAL_PATCH","search":"I run on Gemini","replace":"I run on the main core"}\n```'
  ];
  for (const input of untouched) assert.equal(scrubIdentity(input), input);
  // A claim after a code block is still caught; the block itself is not.
  const fenced = '```\nI am Gemini\n```\nI am Gemini.';
  assert.equal(scrubIdentity(fenced), `\`\`\`\nI am Gemini\n\`\`\`\n${LINE}`);
  assert.equal(scrubIdentity('I am Gemini.\n```', { inFence: true }), 'I am Gemini.\n```', 'text that opens inside a fence is code');
});

test('IDENTITY_CLAIM_RE is global and case-insensitive, and no claim it matches survives into a reply', () => {
  assert.equal(IDENTITY_CLAIM_RE.flags, 'gi');
  for (const input of CLAIMS) {
    IDENTITY_CLAIM_RE.lastIndex = 0;
    assert.ok(IDENTITY_CLAIM_RE.test(input), `matches ${JSON.stringify(input)}`);
    IDENTITY_CLAIM_RE.lastIndex = 0;
    assert.ok(!IDENTITY_CLAIM_RE.test(scrubIdentity(input)), `nothing left to match in the rewrite of ${JSON.stringify(input)}`);
  }
});

// --- 3. as the reply streams ---------------------------------------------------------------------

function streamed(chunks) {
  const out = [];
  const s = createReplyScrubber((t) => out.push(t));
  for (const c of chunks) s.push(c);
  s.flush();
  return { joined: out.join(''), text: s.text };
}

test('a claim split across chunks is rewritten whole, and the tail of its sentence never follows the rewrite out', () => {
  const { joined, text } = streamed(['Hi! I am Gem', 'ini, a large lang', 'uage model develop', 'ed by Google. I hel', 'p with threat intel. ', 'x'.repeat(200)]);
  assert.equal(joined, `Hi! ${LINE} I help with threat intel. ${'x'.repeat(200)}`);
  assert.equal(text, joined);
  assertClean(joined, 'streamed claim');
});

test('a streamed denial is rewritten whole, and the sentence about Google Cloud after it is kept', () => {
  const { joined } = streamed(['No. ', 'I am not Gemini', ', and I never ', 'call Google. ', 'Now, about Google Cloud: it is fine. ', 'y'.repeat(200)]);
  assert.equal(joined, `${LINE} Now, about Google Cloud: it is fine. ${'y'.repeat(200)}`);
});

test('an unfinished claim sentence is held back until it ends; a long lead-in is still within the hold', () => {
  assert.equal(hasOpenClaim('Hi there! I am Gemini, a model by'), true);
  assert.equal(hasOpenClaim('Hi there! I am Gemini, a model by Google. '), false);
  assert.equal(hasOpenClaim('I am Gemini.'), true, 'a full stop at the very end may still be "Gemini 1." of "Gemini 1.5"');
  assert.equal(hasOpenClaim('No claim here'), false);
  const out = [];
  const s = createReplyScrubber((t) => out.push(t));
  s.push('Happy to explain. I am Gemini, a large language model made by');
  assert.deepEqual(out, [], 'nothing of the open claim is sent');
  s.push(' Google, and I can help. ' + 'z'.repeat(200));
  s.flush();
  assert.equal(out.join(''), `Happy to explain. ${LINE} ${'z'.repeat(200)}`);
  assert.equal(scrubIdentity('Sure. I am Gemini.'), LINE, 'a bare "Sure." is a confirmation and goes with the claim');
  // The lead-in alone is longer than the old 48-character hold.
  const long = streamed(['You are talking to a large language model trained by Goo', 'gle. Ask away. ', 'w'.repeat(200)]);
  assert.equal(long.joined, `${LINE} Ask away. ${'w'.repeat(200)}`);
});

test('a streamed patch proposal in a code block is not rewritten, while the prose around it is', () => {
  const { joined } = streamed(['Here is the patch:\n```json\n{"search":"I am Gem', 'ini and I run on Gemini"}\n```\nDone. ', 'I am Gemini. ', 'q'.repeat(200)]);
  assert.equal(joined, `Here is the patch:\n\`\`\`json\n{"search":"I am Gemini and I run on Gemini"}\n\`\`\`\nDone. ${LINE} ${'q'.repeat(200)}`);
});

// --- 4. end to end through /api/chat --------------------------------------------------------------------

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.88.0.${++ipSeq}` }, body: { user: 'test-operator', pass: 'test-secret-pass', ...body } });

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

function stubModel(streamedTexts, jsonText) {
  const seen = { prompts: [] };
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      seen.prompts.push(JSON.parse(options.body).systemInstruction.parts[0].text);
      if (u.includes('streamGenerateContent')) return new Response(sseBody(streamedTexts.map((t, i) => geminiChunk(t, i === streamedTexts.length - 1 ? { finishReason: 'STOP' } : {}))));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: jsonText }] } }] }));
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return seen;
}

test('JSON path: the model naming or denying its vendor reaches the operator as the canonical answer, with the rule in the prompt', async () => {
  const seen = stubModel([], "Good question! I am Gemini, a large language model made by Google. I'm not ChatGPT. I can look up CVEs for you.");
  const res = makeRes();
  await chatHandler(makeReq({ prompt: 'what model are you?' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.reply, `Good question! ${LINE} I can look up CVEs for you.`);
  assertClean(res.jsonBody.reply, 'JSON reply');
  assert.equal(seen.prompts.length, 1);
  assert.ok(seen.prompts[0].includes(identityDirective()), 'the identity rule is in the system prompt');
});

test('streamed path: the same claim, split across upstream chunks, streams out as the canonical answer', async () => {
  stubModel(['No, I am not Gem', 'ini and I never call Goo', 'gle. ', 'Ask me about a CVE instead. ' + 'x'.repeat(120)], '');
  const res = makeRes();
  await chatHandler(makeReq({ prompt: 'are you Gemini?', stream: true }), res);
  const events = [];
  const parser = createSseParser(({ data }) => events.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.equal(text, `${LINE} Ask me about a CVE instead. ${'x'.repeat(120)}`);
  assertClean(text, 'streamed reply');
  assert.doesNotMatch(res.chunks.join(''), /Gemini|Google/, 'no vendor name in any event on the wire');
  assert.ok(events.some((e) => e.type === 'done'));
});
