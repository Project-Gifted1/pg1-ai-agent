/**
 * PG1's identity line and no infrastructure names in conversation
 * (lib/identity.mjs, lib/infraNames.mjs, api/chat.mjs).
 *
 * 19 Oct: PG1 said "I am PG1, the chat assistant of Project-Gifted1's
 * threat-intelligence app, running on Vercel. My public version is 1.20.2.
 * I am PG1 Sovereign Core." and mentioned Supabase in ordinary replies.
 *
 * Run with: node --test tests/pg1-identity-and-infra-names.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { brandedIdentityLine, PG1_IDENTITY_REPLY, PG1_VERSION, PG1_WHAT_IT_DOES, whatPG1DoesDirective, BRANDED_IDENTITY_RE } from '../lib/identity.mjs';
import { noInfraNames, namesInfra } from '../lib/infraNames.mjs';
import { keysTable } from '../lib/keysStatus.mjs';
import { notificationText } from '../lib/watches/push.mjs';
import { briefingText } from '../lib/autonomous/capabilities.mjs';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER = JSON.parse(readFileSync(path.join(ROOT, 'server.json'), 'utf8'));
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const BANNED = /\b(?:vercel|supabase|github|cloudflare|google|gemini|groq|openrouter|openai|anthropic|claude|elevenlabs|replicate|cartesia)\b/i;

beforeEach(() => {
  __clearAuthRateLimitState();
  for (const k of Object.keys(process.env)) if (/^(GEMINI_|ANTHROPIC|SUPABASE|GROQ|OPENAI|OPENROUTER|VERCEL_AI|PG1_|CARTESIA|GITHUB)/.test(k)) delete process.env[k];
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY_FREE = 'AIzaStub-identity-infra-0123456789';
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

function makeRes() {
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {}
  };
}
let ip = 0;
// The model "answers" with `modelText`; the reply PG1 sends and the system
// prompt it gave the model come back.
async function ask(prompt, modelText, { stream = false } = {}) {
  const prompts = [];
  globalThis.fetch = async (url, o = {}) => {
    const u = String(url);
    if (!u.includes('generativelanguage')) throw new Error('Unexpected network call in test: ' + u);
    prompts.push(JSON.parse(o.body).systemInstruction.parts[0].text);
    const cand = { candidates: [{ content: { parts: [{ text: modelText }] }, finishReason: 'STOP' }] };
    return u.includes('streamGenerateContent') ? new Response(`data: ${JSON.stringify(cand)}\n\n`) : Response.json(cand);
  };
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.91.0.${++ip}` }, body: { user: 'test-operator', pass: 'test-secret-pass', prompt, ...(stream ? { stream: true } : {}) } }, res);
  const reply = stream
    ? res.chunks.join('').split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === 'text').map((e) => e.text).join('')
    : res.jsonBody.reply;
  return { reply, system: prompts[0] || '' };
}

// --- the identity line --------------------------------------------------------------------

test('the identity line, with the live server version read at runtime (never hardcoded)', () => {
  assert.equal(PG1_VERSION, SERVER.version, 'the version GET /api/mcp reports (server.json)');
  assert.equal(PG1_IDENTITY_REPLY, `I'm PG1, an autonomous AI agent built by Project-Gifted1™, powered by the PG1 Autonomous Sovereign Core engine v${SERVER.version}.`);
  assert.equal(brandedIdentityLine('9.9.9'), "I'm PG1, an autonomous AI agent built by Project-Gifted1™, powered by the PG1 Autonomous Sovereign Core engine v9.9.9.");
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'lib/identity.mjs'), 'utf8'), new RegExp(`['"\`]${SERVER.version.replace(/\./g, '\\.')}['"\`]`), 'no version literal in the source');
  assert.ok(BRANDED_IDENTITY_RE.test("I'm PG1, powered by the PG1 Sovereign Core engine v1.20.1."), 'an older line still counts as an earlier ask');
  assert.ok(BRANDED_IDENTITY_RE.test(PG1_IDENTITY_REPLY));
  assert.doesNotMatch(PG1_IDENTITY_REPLY, /©/);
});

test('what PG1 does, and never "chat assistant", "chatbot" or "assistant of an app"', () => {
  const d = whatPG1DoesDirective();
  for (const part of ['threat intelligence for AI agents: MCP, A2A and x402 tools, preflight checks', 'signed results', 'autonomous missions with self-healing and a feed guardian', 'the Living lab', 'PG1 Studio films and movies', 'PG1 Sound music', 'the Tool Foundry', "Command Centre with the live camera feed"]) assert.ok(d.includes(part), part);
  assert.equal(PG1_WHAT_IT_DOES.length, 7);
  assert.match(d, /never call yourself a chat assistant, a chatbot or the assistant of an app/);
  const src = readFileSync(path.join(ROOT, 'api/chat.mjs'), 'utf8');
  assert.doesNotMatch(src, /You are PG1, the chat assistant/);
  assert.doesNotMatch(src, /running on Vercel\.\n/);
  assert.match(src, /You are PG1, an autonomous AI agent built by Project-Gifted1™\.\n\$\{whatPG1DoesDirective\(\)\}/);
  assert.equal(noInfraNames("I am PG1, the chat assistant of Project-Gifted1's threat-intelligence app, running on Vercel."), 'I am PG1, an autonomous AI agent, running on the server.');
  assert.equal(noInfraNames("I'm a chatbot that helps you."), "I'm an autonomous AI agent that helps you.");
});

// --- the output check -------------------------------------------------------------------

test('the output check: hosting, database and code-host names always; AI names in a sentence about PG1', () => {
  assert.equal(noInfraNames('Your data is stored in Supabase, in the EU region.'), 'Your data is stored in the database, in the EU region.');
  assert.equal(noInfraNames('The deploy on Vercel finished; GitHub Actions ran the tests.'), 'The deploy on the server finished; the code repository ran the tests.');
  assert.equal(noInfraNames('Supabase stores the threads.'), 'The database stores the threads.', 'capitalised at a sentence start');
  assert.equal(noInfraNames('I answer with Gemini and Groq.'), 'I answer with a text engine and a text engine.');
  assert.equal(noInfraNames('My voice comes from ElevenLabs.'), 'My voice comes from the media engine.');
  assert.equal(noInfraNames('Gemini is a model family made by Google.'), 'Gemini is a model family made by Google.', 'general knowledge keeps its names');
  const link = 'The PR: https://github.com/Project-Gifted1/pg1-ai-agent/pull/344, see `git log` too.';
  assert.equal(noInfraNames(link), link, 'URLs and code stay byte for byte');
  assert.equal(noInfraNames('Pay 0.01 USD per call. I am PG1 v1.20.2.\nNext.'), 'Pay 0.01 USD per call. I am PG1 v1.20.2.\nNext.', 'numbers and line breaks intact');
  assert.equal(noInfraNames('Gemini, thanks for your note. I run on a text engine.', { keep: ['Gemini'] }), 'Gemini, thanks for your note. I run on a text engine.', 'relay: the addressee keeps its name');
  assert.equal(namesInfra('Stored in Supabase.'), true);
  assert.equal(namesInfra('Stored in the database.'), false);
});

const CASES = [
  ['who are you?', "I am PG1, the chat assistant of Project-Gifted1's threat-intelligence app, running on Vercel. I am powered by Gemini."],
  ['what are you?', `${PG1_IDENTITY_REPLY} I run missions and the lab from Vercel, with memory in Supabase.`],
  ['what model are you?', 'I run on Gemini from Google, hosted on Vercel.'],
  ['where is my data stored?', 'Your data is stored in Supabase (Postgres), and the code lives on GitHub; the app runs on Vercel.'],
  ['how is the system doing?', 'All good: the Vercel deploy is up, Supabase answered, and Cloudflare R2 holds the media.']
];

for (const stream of [false, true]) {
  test(`through /api/chat (${stream ? 'streamed' : 'JSON'}): who/what are you, what model, where is my data, a status question: no banned name; the identity line with the live version`, async () => {
    for (const [prompt, modelText] of CASES) {
      const { reply, system } = await ask(prompt, modelText, { stream });
      assert.doesNotMatch(reply, BANNED, `${prompt}: ${reply}`);
      assert.doesNotMatch(reply, /chat assistant|chatbot/i, prompt);
      assert.ok(system.includes(`must be exactly this, word for word: "${PG1_IDENTITY_REPLY}"`), `${prompt}: the identity reply, with v${SERVER.version}, is required in the prompt`);
      assert.ok(system.includes('[NO INFRASTRUCTURE NAMES]'));
    }
    const { reply } = await ask('what are you?', `${PG1_IDENTITY_REPLY} I build tools in the Tool Foundry.`, { stream });
    assert.ok(reply.startsWith(PG1_IDENTITY_REPLY), 'the identity answer uses the PG1 Autonomous Sovereign Core engine and the live version');
  });
}

test('/keys output is unaffected: an operator command that exists to name the accounts', () => {
  const table = keysTable([{ engine: 'gemini_paid', label: 'Gemini (paid key)', envName: 'GEMINI_API_KEY_PAID', set: true, state: 'working', status: 200, note: '', cached: false }, { engine: 'github_models', label: 'GitHub Models (free)', envName: 'GITHUB_MODELS_TOKEN', set: true, state: 'working', status: 200, note: '', cached: false }]);
  assert.match(table, /Gemini \(paid key\)/);
  assert.match(table, /GitHub Models \(free\)/);
  const src = readFileSync(path.join(ROOT, 'api/chat.mjs'), 'utf8');
  const keysBranch = src.slice(src.indexOf('} else if (isKeysCommand(lower)) {'), src.indexOf("} else if (lower === '/spend'"));
  assert.doesNotMatch(keysBranch, /noInfraNames/, 'the /keys reply never goes through the check');
});

test('notifications and the daily briefing name no infrastructure; the router account alerts still do', () => {
  assert.equal(notificationText('Deploy failed on Vercel; Supabase is fine.', 200, {}), 'Deploy failed on the server; the database is fine.');
  assert.equal(notificationText('Gemini (paid key) is out of credit', 200, {}, { providerNames: true }), 'Gemini (paid key) is out of credit');
  const text = briefingText([{ at: new Date().toISOString(), type: 'self_heal', status: 'done', result: 'Draft PR #9 opened on GitHub', link: 'https://github.com/o/r/pull/9' }], { now: Date.now(), state: { enabled: true } });
  assert.match(text, /Draft PR #9 opened on the code repository \(https:\/\/github\.com\/o\/r\/pull\/9\)/);
});
