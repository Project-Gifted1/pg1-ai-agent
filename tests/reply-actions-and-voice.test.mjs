/**
 * Buttons instead of "run /command", spoken commands, and how PG1 talks:
 *
 *   lib/replyActions.mjs   every button is a real command with its
 *                          arguments; one that changes something confirms
 *   lib/voiceIntents.mjs   "PG1, lab status", "stop experiment e2981021",
 *                          "what did I spend today" run the real command;
 *                          a longer question still goes to the model
 *   lib/persona.mjs        the conversational standard in every prompt
 *
 * Run with: node --test tests/reply-actions-and-voice.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { replyActions, commandAction, mentionedCommands, MAX_ACTIONS } from '../lib/replyActions.mjs';
import { resolveIntent } from '../lib/voiceIntents.mjs';
import { PG1_VOICE_DIRECTIVE } from '../lib/persona.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
beforeEach(() => {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY = 'stub-gemini-key';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CARTESIA_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY']) delete process.env[k];
  __clearAuthRateLimitState();
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

let ipSeq = 0;
function makeRes() {
  return { statusCode: null, headers: {}, jsonBody: null, chunks: [], setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {} };
}
function stubModel(text) {
  const seen = { prompts: [], other: [] };
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('generativelanguage.googleapis.com')) { seen.other.push(u); throw new Error('Unexpected network call in test: ' + u); }
    seen.prompts.push(JSON.parse(options.body).systemInstruction.parts[0].text);
    return Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
  };
  return seen;
}
async function chat(body, creds = { user: 'test-operator', pass: 'test-secret-pass' }) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.78.0.${++ipSeq % 250}` }, body: { ...creds, ...body } }, res);
  return res;
}

// --- buttons ----------------------------------------------------------------------

test('a button only ever runs a real command, with its arguments; invented commands never become buttons', () => {
  assert.deepEqual(commandAction('/lab report e2981021'), { label: 'Lab report e2981021', command: '/lab report e2981021', confirm: false, kind: 'command' });
  assert.deepEqual(commandAction('/lab stop e2981021'), { label: 'Stop experiment e2981021', command: '/lab stop e2981021', confirm: true, kind: 'command' });
  assert.equal(commandAction('/lab report').label, 'Latest lab report');
  for (const bad of ['/lab nuke', '/deploy now', '/lab stop', '/lab report e298', '/promote skill:x; rm -rf', 'lab status', '/pdf write anything']) assert.equal(commandAction(bad), null, bad);
  assert.deepEqual(mentionedCommands('Run /lab report e2981021, or /lab nuke, or [ /lab status ].').map((a) => a.command), ['/lab report e2981021', '/lab status']);
});

test('/lab status gets a Report button per finished experiment and a confirming Stop per running one', () => {
  const reply = '### [ LAB ]\n- e2981021 · research · done · $0.01 of $2.00 · a\n- bbbbbbbb · code · failed · $0.20 of $2.00 · b\n- aaaaaaaa · code · running · $0.00 of $2.00 · c';
  assert.deepEqual(replyActions({ prompt: '/lab status', reply }).map((a) => [a.label, a.confirm]), [['Lab report e2981021', false], ['Lab report bbbbbbbb', false], ['Stop experiment aaaaaaaa', true]]);
  const running = replyActions({ prompt: '/lab report aaaaaaaa', reply: '### [ LAB aaaaaaaa · code · running ]\nGoal: x' });
  assert.deepEqual(running.map((a) => a.command), ['/lab stop aaaaaaaa', '/lab status']);
});

test('a long written answer offers "Make it a PDF"; a short one, a PDF reply or an approval card does not; never more than four', () => {
  const long = 'word '.repeat(130);
  assert.deepEqual(replyActions({ prompt: 'write the full breakdown', reply: long }).map((a) => a.command), ['/pdf this']);
  assert.deepEqual(replyActions({ prompt: 'hi', reply: 'Hello.' }), []);
  assert.deepEqual(replyActions({ prompt: 'make it a PDF', reply: long, hasPdf: true }), []);
  assert.deepEqual(replyActions({ prompt: 'x', reply: long, pendingApproval: true }), []);
  const many = ['/lab status', '/usage', '/spend', '/status', '/task', '/skills'].join(' then ');
  assert.equal(replyActions({ prompt: 'what can I check?', reply: many }).length, MAX_ACTIONS);
  // A command already shown as a chip in the text is not repeated as a button.
  assert.deepEqual(replyActions({ prompt: 'how?', reply: 'Use `/lab report e2981021`.' }), []);
});

// --- spoken (or typed) commands -------------------------------------------------------

test('short spoken requests map to real commands; risky ones are asked first; longer questions go to the model', () => {
  const cases = {
    'PG1, lab status': '/lab status',
    'Hey PG1 show me the lab status please': '/lab status',
    'show the latest lab report': '/lab report',
    'lab report for e2981021': '/lab report e2981021',
    'what did I spend today?': '/spend',
    'usage this week': '/usage 7d',
    'make the whole chat a PDF': '/pdf thread',
    'what is my task': '/task',
    'show me the feature flags': '/promote',
    'status.': '/status'
  };
  for (const [said, command] of Object.entries(cases)) assert.deepEqual(resolveIntent(said), { command }, said);
  const stop = resolveIntent('stop experiment e2981021 please');
  assert.equal(stop.command, '/lab stop e2981021');
  assert.equal(stop.question, 'Stop experiment e2981021? Tap the button or say "yes" to go ahead, or "no" to leave it.');
  assert.deepEqual(stop.action, { label: 'Stop experiment e2981021', command: '/lab stop e2981021', confirm: true, kind: 'confirm' });
  for (const q of ['why does the lab status say running for so long?', 'stop', 'tell me about the lab report format', 'what can you do', '/lab status', 'status of the wallet 0xabc']) assert.equal(resolveIntent(q), null, q);
});

test('through the chat: "PG1, lab status" runs the lab command (no model call); "stop experiment …" asks first and stops nothing', async () => {
  const seen = stubModel('should not be called');
  const res = await chat({ prompt: 'PG1, lab status' });
  assert.equal(seen.prompts.length, 0, 'no model call');
  assert.match(res.jsonBody.reply, /The lab needs the vault \(Supabase\)/, 'the /lab handler answered');
  const ask = await chat({ prompt: 'stop experiment e2981021' });
  assert.equal(ask.jsonBody.reply, 'Stop experiment e2981021? Tap the button or say "yes" to go ahead, or "no" to leave it.');
  assert.deepEqual(ask.jsonBody.actions, [{ label: 'Stop experiment e2981021', command: '/lab stop e2981021', confirm: true, kind: 'confirm' }]);
  assert.deepEqual(seen.other, [], 'nothing was called');
  // A guest's words are never turned into commands.
  const guest = await chat({ prompt: 'PG1, lab status' }, { user: '', pass: '' });
  assert.equal(guest.statusCode, 401);
  assert.equal(guest.jsonBody.reply, '[AGENT] Chat Aborted: Authentication required.');
});

test('through the chat: a model reply carries buttons for the real commands it mentions, and PG1\'s conversational standard is in the prompt', async () => {
  const seen = stubModel('The run finished: /lab report e2981021 has it. Also try /lab destroy.');
  const res = await chat({ prompt: 'is the experiment done?' });
  assert.deepEqual(res.jsonBody.actions, [{ label: 'Lab report e2981021', command: '/lab report e2981021', confirm: false, kind: 'command' }]);
  assert.ok(seen.prompts[0].includes(PG1_VOICE_DIRECTIVE));
  assert.ok(seen.prompts[0].indexOf(PG1_VOICE_DIRECTIVE) < seen.prompts[0].indexOf('[CONTEXT]:'));
  for (const rule of ['Answer first', 'No filler', '"As an AI"', 'Do things instead of describing how', 'ask one precise question', 'recommend one option']) assert.ok(PG1_VOICE_DIRECTIVE.includes(rule), rule);
  assert.match(seen.prompts[0], /never tell them to type or run a command/);
});
