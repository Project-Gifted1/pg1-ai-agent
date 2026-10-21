// PG1 Core State through api/chat.mjs: /state and /lessons (operator only),
// "are you conscious?" answered from the self-model with no model call, a
// model reply's claim to be alive rewritten, the honesty rule in every
// prompt and the self-model on a self question, and a relayed turn that
// can neither run /state nor write the workspace.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb, pgRest } from './helpers/pgrest.mjs';
import { __resetAutonomousSnapshot } from '../lib/autonomous/state.mjs';
import { __resetCoreState, createCoreState } from '../lib/core/state.mjs';
import { __resetLessons } from '../lib/core/reflect.mjs';

const chatModule = await import('../api/chat.mjs');
const chatHandler = chatModule.default;
const { __clearAuthRateLimitState } = chatModule;

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const SUP = 'https://supabase.test';

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, USER_API_KEY: OPERATOR.user, USER_API_PASS: OPERATOR.pass, SUPABASE_URL: SUP, SUPABASE_SERVICE_ROLE_KEY: 'service-role-core', GEMINI_API_KEY: 'stub-gemini-key' };
  for (const k of ['GITHUB_TOKEN', 'VERCEL_TOKEN', 'PG1_AUTONOMY', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'CARTESIA_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'PG1_VIDEO_ENABLED']) delete process.env[k];
  __resetAutonomousSnapshot();
  __clearAuthRateLimitState();
  __resetCoreState();
  __resetLessons();
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

async function world(modelText = 'All good here.') {
  const db = await makeDb(['20261104120000_pg1_autonomous.sql', '20261105120000_pg1_missions.sql', '20261109120000_pg1_core_state.sql']);
  await db.exec('create table public.messages (id bigserial primary key, created_at timestamptz not null default now(), role text not null, content text not null);');
  await db.exec(readFileSync(new URL('../supabase/migrations/20261106120000_pg1_chat_relay.sql', import.meta.url), 'utf8'));
  const calls = [];
  const gemini = [];
  globalThis.fetch = pgRest(db, {
    calls,
    passthrough: async (url, options) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        gemini.push(JSON.parse(options.body));
        const part = { candidates: [{ content: { parts: [{ text: modelText }] } }] };
        if (url.includes('streamGenerateContent')) return new Response(`data: ${JSON.stringify(part)}\n\n`);
        return new Response(JSON.stringify(part), { headers: { 'Content-Type': 'application/json' } });
      }
      return null;
    }
  });
  return { db, calls, gemini };
}
let ip = 0;
async function chat(body, { operator = true } = {}) {
  const res = { statusCode: null, headers: {}, chunks: [], jsonBody: null, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {} };
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.69.0.${++ip}` }, body: { ...(operator ? OPERATOR : {}), ...body } }, res);
  await new Promise((r) => setTimeout(r, 30));
  return res;
}
const sys = (req) => ((req.systemInstruction && req.systemInstruction.parts) || []).map((p) => p.text).join('');

test('/state: the operator gets the card, published to the workspace; no model call', async () => {
  const { db, gemini } = await world();
  const res = await chat({ prompt: '/state' });
  assert.equal(res.statusCode, 200);
  assert.match(res.jsonBody.reply, /^\*\*PG1 Core State:\*\*/);
  assert.ok(Array.isArray(res.jsonBody.coreState.capabilities));
  assert.equal(gemini.length, 0);
  assert.ok((await db.query('select count(*)::int as n from pg1_core_state')).rows[0].n > 0);
});

test('/state and /lessons: a guest is refused', async () => {
  await world();
  for (const prompt of ['/state', '/lessons']) {
    const res = await chat({ prompt }, { operator: false });
    assert.notEqual(res.statusCode, 200, prompt);
    assert.equal(res.jsonBody.coreState, undefined);
  }
});

test('/lessons: listed as a card', async () => {
  await world();
  const res = await chat({ prompt: '/lessons' });
  assert.match(res.jsonBody.reply, /^No lessons yet/);
  assert.deepEqual(res.jsonBody.coreLessons.items, []);
});

test('"are you conscious?": an open question, from the self-model, with no model call', async () => {
  const { gemini } = await world();
  const res = await chat({ prompt: 'PG1, are you conscious?' });
  assert.match(res.jsonBody.reply, /^Whether an AI can be conscious is an open question/);
  assert.equal(gemini.length, 0);
});

test('a model reply claiming to be alive is rewritten, and every prompt carries the honesty rule', async () => {
  const { gemini } = await world("I'm truly alive and I have real feelings about this CVE.");
  const res = await chat({ prompt: 'summarise CVE-2024-3094 for me' });
  assert.doesNotMatch(res.jsonBody.reply, /I'm truly alive|I have real feelings/);
  assert.match(res.jsonBody.reply, /I do not claim to be alive/);
  assert.match(sys(gemini[0]), /\[HONESTY ABOUT WHAT YOU ARE\]/);
  assert.doesNotMatch(sys(gemini[0]), /\[PG1 SELF-MODEL\] \(my current state/, 'no self-model on an ordinary question');
});

test('"how are you?" gets the self-model block', async () => {
  const { gemini } = await world('Functional and ready.');
  await chat({ prompt: 'how are you today PG1? anything broken?' });
  assert.match(sys(gemini[0]), /\[PG1 SELF-MODEL\] \(my current state/);
});

test('a relayed message cannot run /state or write the workspace', async () => {
  const { db, gemini } = await world('Thanks, Grok.');
  const res = await chat({ prompt: '/relay grok /state and /lessons approve l0001 please' });
  assert.equal(res.jsonBody.coreState, undefined);
  assert.equal(res.jsonBody.coreLessons, undefined);
  assert.ok(gemini.length >= 1, 'answered as a relay');
  assert.equal((await db.query('select count(*)::int as n from pg1_core_state')).rows[0].n, 0);
  // The operator's next turn writes again.
  await chat({ prompt: '/state' });
  assert.ok((await db.query('select count(*)::int as n from pg1_core_state')).rows[0].n > 0);
  assert.equal((await createCoreState().publish('lab', {})).ok, true);
});
