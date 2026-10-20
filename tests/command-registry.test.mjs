/**
 * One command registry (lib/commands/registry.mjs) for /help, the page's
 * command panel and chips (public/commands.json), the unknown-command
 * parser and PG1's system prompt; the reply redactor; failure -> retry
 * (lib/commands/retry.mjs) and "Fix it" (lib/commands/fixIt.mjs).
 *
 * Operator screenshot, 19 Oct: PG1 said to run "/key fresh" (the command is
 * /keys fresh); the redactor withheld the start of that sentence and added
 * the "looked like a secret" note; "/key fresh" then went to the model.
 *
 * Run with: node --test tests/command-registry.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  COMMANDS, COMMAND_AREAS, findCommand, closestCommand, unknownCommandReply, isKnownCommandWord, helpText, commandRegistryDirective, commandsForClient, usage
} from '../lib/commands/registry.mjs';
import { commandsJsonText, COMMANDS_JSON } from '../scripts/build-commands.mjs';
import { commandAction, mentionedCommands } from '../lib/replyActions.mjs';
import { createReplySecretGuard, isOrdinaryWordValue } from '../lib/secretGuard.mjs';
import { retryOnce, isTransientFailure } from '../lib/commands/retry.mjs';
import { handleFixCommand, handleFixApproval, isFixCommand, FIX_ACTION } from '../lib/commands/fixIt.mjs';
import { COMMAND_FORMS_DIRECTIVE } from '../lib/replyFacts.mjs';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  __clearAuthRateLimitState();
  for (const k of Object.keys(process.env)) if (/^(GEMINI_|ANTHROPIC|SUPABASE|GROQ|OPENAI|OPENROUTER|VERCEL_AI|PG1_)/.test(k)) delete process.env[k];
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

function makeRes() {
  return {
    statusCode: null, headers: {}, jsonBody: null, chunks: [],
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {}
  };
}
async function chat(body) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: { user: 'test-operator', pass: 'test-secret-pass', ...body } }, res);
  return res;
}

// --- the registry ---------------------------------------------------------------------

test('one registry: every command has a name, area, args, description and the two flags; /relay is in it', () => {
  const seen = new Set();
  for (const c of COMMANDS) {
    assert.match(c.command, /^\/[a-z0-9-]+(?: [a-z0-9-]+)?$/, c.command);
    assert.ok(!seen.has(c.command), `listed once: ${c.command}`);
    seen.add(c.command);
    assert.ok(COMMAND_AREAS.includes(c.area), `${c.command}: area ${c.area}`);
    assert.ok(c.description.length > 5);
    assert.equal(typeof c.operatorOnly, 'boolean');
    assert.equal(typeof c.dangerous, 'boolean');
    assert.ok(Array.isArray(c.args));
  }
  const relay = findCommand('/relay grok hello there');
  assert.equal(relay.command, '/relay');
  assert.deepEqual(relay.args.map((a) => a.name), ['name', 'text']);
  for (const d of ['/auto on', '/auto off', '/lab start', '/film', '/movie', '/music', '/image', '/video', '/approve']) assert.equal(findCommand(d).dangerous, true, `${d} confirms`);
  assert.equal(findCommand('/keys fresh').command, '/keys fresh', 'the longest command wins');
  assert.equal(findCommand('/keys').command, '/keys');
  assert.equal(findCommand('/key fresh'), null);
});

test('/help, the system prompt and public/commands.json are generated from the registry', () => {
  const help = helpText();
  for (const c of COMMANDS.filter((x) => !x.hidden)) assert.ok(help.includes(`\`${c.command}\``), `/help lists ${c.command}`);
  assert.ok(!help.includes('`/claude`'), 'hidden aliases are not shown');
  const directive = commandRegistryDirective();
  for (const c of COMMANDS.filter((x) => !x.hidden)) assert.ok(directive.includes(usage(c)), `the prompt lists ${usage(c)}`);
  assert.match(directive, /there is no \/key, only \/keys and \/keys fresh/);
  assert.match(COMMAND_FORMS_DIRECTIVE, /listed under \[COMMAND REGISTRY\]/);
  assert.equal(readFileSync(COMMANDS_JSON, 'utf8'), commandsJsonText(), 'public/commands.json is current: run npm run commands:build');
  const client = commandsForClient();
  assert.equal(client.commands.length, COMMANDS.filter((x) => !x.hidden).length, 'every visible command has a button in the panel');
  assert.ok(client.commands.some((c) => c.command === '/relay'));
});

test('the chat system prompt carries the registry block', () => {
  const src = readFileSync(path.join(ROOT, 'api/chat.mjs'), 'utf8');
  assert.match(src, /COMMAND_FORMS_DIRECTIVE \+ '\\n' \+ commandRegistryDirective\(\)/);
  assert.match(src, /reply: helpText\(\)/, '/help comes from the registry');
});

// --- unknown commands ------------------------------------------------------------------

test('an unknown command gets the closest real one: "/key fresh" -> "Did you mean /keys fresh?"', () => {
  assert.deepEqual(unknownCommandReply('/key fresh').reply, 'Unknown command /key. Did you mean /keys fresh?');
  assert.equal(unknownCommandReply('/key').reply, 'Unknown command /key. Did you mean /keys?');
  assert.equal(closestCommand('/relya grok hi').command, '/relay', 'a swapped pair of letters');
  assert.equal(closestCommand('/films').command, '/film');
  assert.equal(unknownCommandReply('/zzzzqqq').reply, 'Unknown command /zzzzqqq. /help lists every command.');
  assert.equal(isKnownCommandWord('/keys fresh'), true);
  assert.equal(isKnownCommandWord('/claude hi'), true, 'aliases still work');
  assert.equal(isKnownCommandWord('/key fresh'), false);
});

test('"/key fresh" in the chat never reaches the model: the reply suggests /keys fresh with a button for it', async () => {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('no network call expected: ' + url); };
  process.env.GEMINI_API_KEY_FREE = 'AIzaStub-unknown-command-0123456789';
  const res = await chat({ prompt: '/key fresh' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.reply, 'Unknown command /key. Did you mean /keys fresh?');
  assert.deepEqual(res.jsonBody.actions, [{ label: '/keys fresh', command: '/keys fresh', confirm: false, kind: 'command' }]);
  assert.equal(res.jsonBody.unknownCommand, true);
  assert.ok(!calls.some((u) => /generativelanguage|anthropic|groq|openai/.test(u)), 'no model call');
});

test('a dangerous suggestion keeps its confirm; a guest still gets the 401 first', async () => {
  globalThis.fetch = async (url) => { throw new Error('no network call expected: ' + url); };
  const on = await chat({ prompt: '/autoo on' });
  assert.equal(on.jsonBody.reply, 'Unknown command /autoo. Did you mean /auto on?');
  assert.equal(on.jsonBody.actions[0].confirm, true);
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: { 'x-forwarded-for': '203.0.113.10' }, body: { prompt: '/key fresh' } }, res);
  assert.equal(res.statusCode, 401);
});

test('relay rule kept: a slash command inside relayed text is never run or answered as a command', async () => {
  const src = readFileSync(path.join(ROOT, 'api/chat.mjs'), 'utf8');
  const block = src.slice(src.indexOf("if (activeAction === 'CHAT' && typeof promptText === 'string' && !relayTurn)"), src.indexOf('UNKNOWN COMMAND'));
  assert.ok(block.length > 0 && block.includes('!relayTurn'), 'the unknown-command check sits inside the dispatch that relayed text skips');
});

// --- buttons and chips ------------------------------------------------------------------

test('every registry command has a button: alone it is a reply button, a chip runs the exact command', () => {
  for (const c of COMMANDS.filter((x) => !x.hidden && !x.client && !x.args.some((g) => g.required) && x.command !== '/lab start')) {
    const a = commandAction(c.command);
    assert.ok(a, `${c.command} is a button`);
    assert.equal(a.command, c.command, 'it runs exactly that command');
    // A command with its own button (lib/replyActions.mjs COMMANDS) keeps
    // that button's label and confirm; any other confirms when dangerous.
    if (a.label === c.command) assert.equal(a.confirm, c.dangerous, `${c.command}: a dangerous one confirms`);
  }
  assert.equal(commandAction('/key fresh'), null, 'an invented command is never a button');
  assert.deepEqual(mentionedCommands('Run /keys fresh to check them, or /key fresh.').map((a) => a.command), ['/keys fresh']);
});

// --- the redactor -----------------------------------------------------------------------

test('the redactor: the "/keys fresh" sentence passes untouched; a real key value is still withheld', () => {
  const guard = createReplySecretGuard({
    envValues: [{ name: 'USER_API_PASS', value: 'Refresh' }, { name: 'GEMINI_API_KEY_PAID', value: 'AQ.Ab8RN6LiveKeyValue0123456789abcdef' }],
    env: {}
  });
  const sentence = 'Refresh with a fresh key: run /keys fresh to check every key now.';
  assert.deepEqual(guard(sentence), { text: sentence, removed: [] }, 'no [withheld], no note');
  const leak = guard('The paid key is AQ.Ab8RN6LiveKeyValue0123456789abcdef.');
  assert.equal(leak.text, 'The paid key is [withheld].');
  assert.deepEqual(leak.removed, ['value of GEMINI_API_KEY_PAID']);
  assert.match(guard('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123').text, /\[withheld\]/, 'key shapes still go');
  assert.equal(guard('set GEMINI_API_KEY_PAID in the settings').text, 'set [withheld] in the settings', 'configuration names still go');
  assert.equal(guard('Run `/auto off` now, then /lab status.').text, 'Run `/auto off` now, then /lab status.');
  assert.equal(isOrdinaryWordValue('Refresh'), true);
  assert.equal(isOrdinaryWordValue('Refresh123!'), false);
});

// --- failure -> retry ---------------------------------------------------------------------

test('retry once on a transient failure (429, timeout, 5xx), never on a final one', async () => {
  assert.equal(isTransientFailure(429), true);
  assert.equal(isTransientFailure(503), true);
  assert.equal(isTransientFailure(400), false);
  assert.equal(isTransientFailure({ status: 429, detail: 'Your project has exceeded its monthly spending cap' }), false, 'a spending cap is final');
  assert.equal(isTransientFailure({ code: 'upstream_unavailable' }), true);
  assert.equal(isTransientFailure(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  let n = 0;
  const twice = await retryOnce(async () => (++n === 1 ? { ok: false, status: 503 } : { ok: true }), { sleep: async () => {} });
  assert.deepEqual([n, twice.retried, twice.result.ok], [2, true, true], 'retried once, then it worked');
  n = 0;
  const still = await retryOnce(async () => { n++; return { ok: false, status: 502 }; }, { sleep: async () => {} });
  assert.deepEqual([n, still.result.ok], [2, false], 'only once: the second failure is final (the card shows)');
  n = 0;
  await retryOnce(async () => { n++; return { ok: false, status: 402 }; }, { sleep: async () => {} });
  assert.equal(n, 1, 'out of credit is never retried');
});

test('film and music dispatch retry once on a 5xx; the lab dispatch only on a 429 or a dropped connection', async () => {
  const { dispatchFilmRender } = await import('../lib/film/dispatch.mjs');
  const env = { PG1_VIDEO_RENDER_SECRET: 'film-secret-0123456789abcdef', GITHUB_TOKEN: 'gh-token' };
  let n = 0;
  const ok = await dispatchFilmRender({ env, projectId: '11111111-2222-4333-8444-555555555555', stage: 'storyboard', fetchImpl: async () => (++n === 1 ? new Response('busy', { status: 502 }) : new Response(null, { status: 204 })) });
  assert.deepEqual([ok.ok, n], [true, 2]);
  const { createLabGithub } = await import('../lib/lab/github.mjs');
  let m = 0;
  const gh = createLabGithub({ env: { GITHUB_TOKEN: 'gh' }, fetchImpl: async () => { m++; return new Response('err', { status: 500 }); } });
  const r = await gh.dispatch({ id: 'x', kind: 'research', goal: 'g', input: '', budgetUsd: 1, token: 't' });
  assert.deepEqual([r.ok, m], [false, 1], 'a 5xx may have started the run: not sent twice');
  let k = 0;
  const gh2 = createLabGithub({ env: { GITHUB_TOKEN: 'gh' }, fetchImpl: async () => (++k === 1 ? new Response('slow down', { status: 429 }) : new Response(null, { status: 204 })) });
  assert.deepEqual([(await gh2.dispatch({ id: 'x', kind: 'research', goal: 'g', input: '', budgetUsd: 1, token: 't' })).ok, k], [true, 2], 'a 429 is sent once more');
});

// --- "Fix it" --------------------------------------------------------------------------

test('"Fix it" asks first (an approval card), and approving opens a draft PR only', async () => {
  assert.equal(isFixCommand('/fix abc12345'), true);
  const stored = [];
  const fetchImpl = async (url) => {
    assert.match(String(url), /pg1_errors\?request_id=eq\.abc12345/);
    return Response.json([{ id: 'e1', route: 'CHAT', status: 500, reason: 'model_failed', category: 'upstream', message: 'every engine failed', count: 3 }]);
  };
  const out = await handleFixCommand({ text: '/fix abc12345', supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, storePending: async (plan, summary) => { stored.push({ plan, summary }); return { ok: true, token: 'tok-1', expiresAt: new Date(0) }; } });
  assert.match(out.reply, /^Fix request abc12345 \(CHAT 500 model_failed\)\?/);
  assert.match(out.reply, /\*\*draft\*\* pull request/);
  assert.match(out.reply, /PG1 never merges it/);
  assert.equal(out.pendingApproval.token, 'tok-1');
  assert.equal(stored[0].plan.ref, 'e1');
  assert.equal(FIX_ACTION, 'SELF_HEAL_FIX');
  const healed = [];
  const heal = async (args) => { healed.push(args); return { ok: true, result: 'Draft PR #9 opened with a proposed fix: x', link: 'https://github.com/o/r/pull/9' }; };
  const declined = await handleFixApproval({ row: { plan: stored[0].plan }, decision: 'decline', heal });
  assert.equal(declined.resolution, 'declined');
  assert.equal(healed.length, 0, 'decline runs nothing');
  const approved = await handleFixApproval({ row: { plan: stored[0].plan }, decision: 'approve', heal });
  assert.equal(healed.length, 1);
  assert.equal(healed[0].event.kind, 'runtime');
  assert.match(approved.reply, /Draft PR #9/);
  const caps = readFileSync(path.join(ROOT, 'lib/autonomous/capabilities.mjs'), 'utf8');
  assert.match(caps, /draft: true/, 'self-healing only ever opens a draft');
  assert.doesNotMatch(caps, /\/merge['"`]/, 'and never merges');
});
