/**
 * Honest actions (lib/honestActions.mjs): PG1 never says it started,
 * stopped, watched or changed something unless that action ran.
 *
 * The case from the operator's thread: asked to start an experiment, the
 * reply said "Starting the experiment now." with no tool behind it. Now:
 *   - the system prompt says a reply cannot start anything and names the
 *     real command;
 *   - a JSON reply's false claim is replaced by what is true, and a streamed
 *     reply (already on screen) gets a correction after it;
 *   - either way the reply carries a real, operator-confirmed Start
 *     experiment button, which runs /lab start, so the autonomy policy, the
 *     lab budgets and the kill switch apply;
 *   - a claim backed by an action that did run is left alone.
 *
 * Run with: node --test tests/honest-actions.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeDb, pgRest } from './helpers/pgrest.mjs';
import { createSseParser } from '../lib/chatStream.mjs';

const { findFalseClaims, honestReply, goalFromPrompt, ranKinds, HONEST_ACTIONS_DIRECTIVE } = await import('../lib/honestActions.mjs');
const { commandAction, mentionedCommands } = await import('../lib/replyActions.mjs');
const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const SECRET = `lab-${crypto.randomBytes(8).toString('hex')}`; // test-only HMAC key

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.USER_API_KEY = OPERATOR.user;
  process.env.USER_API_PASS = OPERATOR.pass;
  process.env.GEMINI_API_KEY = 'stub-gemini-key';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CARTESIA_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'PG1_AUTONOMY', 'PG1_LAB_DISPATCH_SECRET']) delete process.env[k];
  __clearAuthRateLimitState();
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

const CLAIMS = [
  ['Starting the experiment now.', 'start'],
  ['Got it. Starting the experiment now.', 'start'],
  ['I\'ve started the lab experiment.', 'start'],
  ['I am kicking off a research run for you.', 'start'],
  ['OK, launching the workflow.', 'start'],
  ['I stopped the experiment.', 'stop'],
  ['I\'ll let you know when it\'s done.', 'watch'],
  ['I will report back once the run finishes.', 'watch'],
  ['I\'m monitoring the deploy.', 'watch'],
  ['I have deployed the change to production.', 'change'],
  ['I\'ve opened a pull request with the fix.', 'change']
];
const NOT_CLAIMS = [
  'You can start it with /lab start x.',
  'Shall I start the experiment?',
  'I can\'t start experiments from here.',
  'Nothing was started.',
  'The experiment started yesterday and finished.',
  'Send `/lab start compare feeds` to start it.',
  'I\'ll let you know if you need anything else.',
  'Earlier I started experiment e2981021.',
  'I checked the wallet: no flags.',
  'Here is the updated summary of the plan.',
  'I ran the checks on the wallet.'
];

test('claims of starting, stopping, watching or changing are found; offers, questions, instructions and denials are not', () => {
  for (const [text, kind] of CLAIMS) {
    const found = findFalseClaims(text);
    assert.equal(found.length, 1, text);
    assert.equal(found[0].kind, kind, text);
  }
  for (const text of NOT_CLAIMS) assert.deepEqual(findFalseClaims(text), [], text);
  // A claim backed by an action that ran is true.
  assert.deepEqual(findFalseClaims('Starting the video render now.', { ran: ranKinds([{ tool: 'generate_video', ok: true }]) }), []);
  assert.equal(findFalseClaims('Starting the video render now.', { ran: ranKinds([{ tool: 'generate_video', ok: false }]) }).length, 0, 'a video is not an experiment, run, build or deploy');
});

test('honestReply replaces the false sentence with what is true and offers a real, confirmable Start experiment', () => {
  const r = honestReply('Got it. Starting the experiment now. I will report back when it finishes.\n\nThe plan has three steps.', { prompt: 'PG1, start an experiment to compare NVD and OSV licence terms', isOperator: true });
  assert.doesNotMatch(r.text, /Starting the experiment now|report back/);
  assert.match(r.text, /^Got it\.\n\nThe plan has three steps\.\n\nI have not started anything: a reply cannot start a lab experiment\. Tap \*\*Start experiment\*\* below to confirm it, or send `\/lab start <goal>`\. I am not watching this yet\./);
  assert.match(r.note, /^\*\*Correction\*\*: I have not started anything/);
  assert.deepEqual(r.actions, [{ label: 'Start experiment', command: '/lab start compare nvd and osv licence terms', confirm: true, kind: 'confirm' }]);
  assert.deepEqual(honestReply('Starting it.', { prompt: 'start an experiment on x', isOperator: false }).actions, [], 'a guest gets no button');
  assert.deepEqual(honestReply('The lab is quiet today.', { prompt: 'how is the lab?' }), { text: 'The lab is quiet today.', note: '', actions: [], claims: [] });
  assert.equal(goalFromPrompt('can you run a lab experiment about pricing of CVE feeds?'), 'pricing of CVE feeds');
  assert.equal(goalFromPrompt('/lab status'), '');
  assert.match(honestReply('Starting the experiment now.', { prompt: 'start an experiment to draft a skill for pdf reports', isOperator: true }).actions[0].command, /^\/lab start --kind skill draft a skill for pdf reports$/);
});

test('the Start experiment button is a real command; a goal cut out of a reply never becomes one', () => {
  assert.equal(commandAction('/lab start compare two feeds').confirm, true);
  assert.equal(commandAction('/lab start --kind code fix the footer').command, '/lab start --kind code fix the footer');
  assert.equal(commandAction('/lab start /etc'), null);
  assert.equal(commandAction(`/lab start ${'x'.repeat(260)}`), null);
  assert.deepEqual(mentionedCommands('Send /lab start compare feeds to begin.'), [], 'only the operator\'s own words make a start button');
  assert.match(HONEST_ACTIONS_DIRECTIVE, /cannot start, stop, cancel, watch, monitor, deploy, merge, push or change anything/);
});

// --- through the chat --------------------------------------------------------------

const sse = (objs) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');
function makeRes() {
  return { statusCode: null, headers: {}, jsonBody: null, chunks: [], setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {} };
}
function eventsOf(res) {
  const out = [];
  const parser = createSseParser(({ data }) => out.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return out;
}
let ip = 0;
async function chat(body) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.87.0.${++ip % 250}` }, body: { ...OPERATOR, ...body } }, res);
  return res;
}

// The model says it is starting the experiment; the lab (Supabase and a
// GitHub Actions stand-in) is behind the same fetch.
async function world(modelText) {
  const db = await makeDb(['20261019120000_pg1_skills.sql', '20261020120000_pg1_lab_and_flags.sql', '20261028120000_pg1_watches.sql']);
  await db.exec(`create table public.pg1_ai_usage (id bigint generated always as identity primary key, at timestamptz not null default now(), day date not null default current_date, provider text not null, model text, task text, data_class text, input_tokens integer default 0, output_tokens integer default 0, chars integer default 0, unit text, cost_usd numeric not null default 0, cached boolean default false, ok boolean default true, status integer, fallback integer default 0, request_id text);`);
  const seen = { prompts: [], dispatches: [] };
  globalThis.fetch = pgRest(db, {
    passthrough: async (u, o) => {
      if (u.includes('generativelanguage.googleapis.com')) {
        const body = JSON.parse(o.body);
        if (body.systemInstruction) seen.prompts.push(body.systemInstruction.parts[0].text);
        const cand = { content: { parts: [{ text: modelText }] }, finishReason: 'STOP' };
        return u.includes('streamGenerateContent') ? new Response(sse([{ candidates: [cand] }])) : Response.json({ candidates: [cand] });
      }
      if (u.endsWith('/actions/workflows/lab.yml/dispatches')) { seen.dispatches.push(JSON.parse(o.body)); return new Response(null, { status: 204 }); }
      if (u.includes('/storage/v1/')) return Response.json([]);
      if (u.startsWith('https://supabase.test/rest/v1/')) return null;
      return Response.json([]);
    }
  });
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-honest-test';
  return { db, seen };
}

const PROMPT = 'PG1, start an experiment to compare NVD and OSV licence terms';
const MODEL = 'Got it. Starting the experiment now. I will report back when it finishes.';

test('chat (JSON): "Starting the experiment now" with nothing started is replaced, and the reply carries the Start experiment button; nothing was dispatched', async () => {
  const { seen } = await world(MODEL);
  const res = await chat({ prompt: PROMPT });
  const reply = res.jsonBody.reply;
  assert.doesNotMatch(reply, /Starting the experiment now|report back/);
  assert.match(reply, /I have not started anything: a reply cannot start a lab experiment\./);
  assert.match(reply, /I am not watching this yet\./);
  assert.deepEqual(res.jsonBody.actions[0], { label: 'Start experiment', command: '/lab start compare nvd and osv licence terms', confirm: true, kind: 'confirm' });
  assert.equal(res.jsonBody.honestActions, undefined, 'internal field not sent');
  assert.equal(seen.dispatches.length, 0, 'the reply started nothing');
  assert.ok(seen.prompts.some((p) => p.includes(HONEST_ACTIONS_DIRECTIVE)), 'the model is told it cannot start anything');
});

test('chat (stream): the reply already on screen gets a correction, and the done event carries the Start experiment button', async () => {
  await world(MODEL);
  const res = await chat({ prompt: PROMPT, stream: true });
  const events = eventsOf(res);
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.match(text, /\*\*Correction\*\*: I have not started anything/);
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.result.actions[0].label, 'Start experiment');
  assert.equal(done.result.actions[0].kind, 'confirm');
});

test('the Start experiment button runs /lab start for real: the autonomy policy, the lab budget and the kill switch apply', async () => {
  const { seen } = await world(MODEL);
  const button = (await chat({ prompt: PROMPT })).jsonBody.actions[0];
  // Not set up: says so, starts nothing.
  assert.match((await chat({ prompt: button.command })).jsonBody.reply, /not set up on this deployment[\s\S]*Nothing was started/);
  process.env.PG1_LAB_DISPATCH_SECRET = SECRET;
  process.env.GITHUB_TOKEN = ['gh', 'p_', 'honesttoken'.padEnd(36, '0')].join(''); // fake, built at runtime
  // Kill switch off: refused, nothing dispatched.
  process.env.PG1_AUTONOMY = 'off';
  assert.match((await chat({ prompt: button.command })).jsonBody.reply, /^Not started: autonomy is off/);
  assert.equal(seen.dispatches.length, 0);
  // Default (lab): dispatched with the signed budget.
  delete process.env.PG1_AUTONOMY;
  const started = await chat({ prompt: button.command });
  assert.match(started.jsonBody.reply, /^Lab experiment [0-9a-f]{8} queued \(research, budget \$2\.00/);
  assert.equal(seen.dispatches.length, 1);
  assert.equal(seen.dispatches[0].inputs.goal, 'compare nvd and osv licence terms');
  // Over the daily budget: refused.
  process.env.PG1_LAB_DAILY_USD = '1';
  assert.match((await chat({ prompt: button.command })).jsonBody.reply, /^Not started: today's lab budget is \$1\.00/);
  assert.equal(seen.dispatches.length, 1);
});
