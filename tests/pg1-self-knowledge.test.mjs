/**
 * What PG1 knows and says about itself (lib/identity.mjs, the system prompt
 * in api/chat.mjs, lib/chatStream.mjs):
 *  - its name is "PG1" and its only version is server.json's: no invented
 *    title, tier or version number ("PG1 Sovereign Core", "Version 10.0")
 *    in the prompt, the /help reply or the identity guard
 *  - its capabilities knowledge matches the current app: Send to Code
 *    (/code, the hand-off card, Hand-offs), the streamed reply with its
 *    live trace and "N steps" pill, spoken replies with the waveform that
 *    stops speech, and the icon-only message actions (Read aloud, Copy,
 *    Delete) — and no stale names such as a "SPEAK button"
 *  - it is told to say when it is unsure about its own internals
 *  - with spoken replies on (speak: true) it is told to keep the answer
 *    under about 80 words and offer more detail, on the streamed and the
 *    JSON path; never otherwise
 *  - step durations come from the server: every step_done carries `ms`
 *    measured between step() and stepDone() there
 *
 * Run with: node --test tests/pg1-self-knowledge.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { createChatStream, createSseParser, scrubIdentity } from '../lib/chatStream.mjs';
import { PG1_NAME, PG1_VERSION, SPOKEN_REPLY_WORD_LIMIT, describeVersion, identityDirective, spokenReplyDirective } from '../lib/identity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const html = readFileSync(join(root, 'public/index.html'), 'utf-8');
const chatSource = readFileSync(join(root, 'api/chat.mjs'), 'utf-8');
const serverJson = JSON.parse(readFileSync(join(root, 'server.json'), 'utf-8'));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY = 'stub-gemini-key';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'CARTESIA_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY']) delete process.env[k];
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.77.0.${++ipSeq}` }, body });
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

function eventsOf(res) {
  const out = [];
  const parser = createSseParser(({ data }) => out.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return out;
}

const sseBody = (objs) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');
const geminiChunk = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }] }, ...extra }] });

// Stubs every network call; the Gemini system prompt (JSON and streamed
// paths alike) is captured for the assertions.
function installFetch() {
  const seen = { prompts: [] };
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(options.body);
      seen.prompts.push(body.systemInstruction.parts[0].text);
      if (u.includes('streamGenerateContent')) {
        return new Response(sseBody([geminiChunk('Stubbed streamed reply.', { finishReason: 'STOP' })]));
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Stubbed model reply.' }] } }] }));
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return seen;
}

async function promptFor(body) {
  const seen = installFetch();
  const res = makeRes();
  await chatHandler(makeReq(authed(body)), res);
  assert.equal(seen.prompts.length, 1, 'one model call');
  return { prompt: seen.prompts[0], res };
}

// --- 1. name and version ------------------------------------------------------------

test('PG1 is told its name is PG1 and its only version is the one in server.json', async () => {
  assert.equal(PG1_NAME, 'PG1');
  assert.equal(PG1_VERSION, serverJson.version, 'the public version comes from server.json');
  assert.match(serverJson.version, /^\d+\.\d+\.\d+$/);
  const { prompt } = await promptFor({ prompt: 'who are you?' });
  assert.match(prompt, /^You are PG1, /, 'the prompt opens with the plain name');
  assert.ok(prompt.includes(`Your public version is ${serverJson.version} (from server.json); that is the only version number you have.`));
  assert.ok(prompt.includes('If asked directly what model or LLM you are, say only that you are PG1.'));
  assert.ok(prompt.includes('never add a title, tier, codename, edition or version of your own'));
});

test('no invented title or version survives anywhere PG1 describes itself', async () => {
  const { prompt } = await promptFor({ prompt: 'hello' });
  const stale = /PG1-AGENT|Version 10|Sovereign Core|elite autonomous intelligence|v\d+\.\d+ Sovereign/;
  // The directive quotes the banned phrases once, as examples of what not to say.
  const withoutExamples = prompt.replace(/\(not "Sovereign Core", not "Version 10\.0", not "v2", nothing like them\)/, '');
  assert.doesNotMatch(withoutExamples, stale, 'the system prompt gives PG1 no title or version of its own');
  assert.match(prompt, /PG1 Sovereign Threat Intelligence \(the MCP server and feeds\); that is the product name, not yours/);
  // The identity guard that rewrites a model's claim about what powers it.
  assert.equal(scrubIdentity('Hi, I am Gemini.'), 'Hi, I am PG1.');
  assert.equal(scrubIdentity("I'm powered by Google."), "I'm powered by PG1.");
  assert.doesNotMatch(scrubIdentity('I am Claude, built on Anthropic.'), /Sovereign|Core|Version/);
  // The one-shot help text.
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: '/help' })), res);
  assert.doesNotMatch(res.jsonBody.reply, stale);
  // Nothing in the handler source hands the model a title either.
  assert.doesNotMatch(chatSource, /You are PG1-AGENT|Version 10\.0 Sovereign Core|You are PG1 Sovereign Core/);
});

test('when server.json cannot be read the directive says the version is unknown instead of inventing one', () => {
  assert.equal(describeVersion(null), 'You cannot confirm your version here; say so if asked.');
  assert.doesNotMatch(identityDirective(null), /\d+\.\d+\.\d+/, 'no version number at all');
  assert.match(identityDirective('2.0.0'), /Your public version is 2\.0\.0 \(from server\.json\)/);
});

// --- 2. capabilities match the current app -------------------------------------------

test('capabilities: Send to Code, the live trace with its "N steps" pill, the waveform, and icon-only actions', async () => {
  const { prompt } = await promptFor({ prompt: 'what can you do?' });
  // Send to Code (/code, #228/#229)
  assert.match(prompt, /\/code plus a task is Send to Code/);
  assert.match(prompt, /- Send to Code: \/code plus a task .* drafts a hand-off card .* "Send to Code" with a PG1-TASK id/);
  assert.ok(prompt.includes('"Copy and open Code" (copies the prompt and opens claude.ai/code pre-filled with it and the repository) and "Copy only"'));
  assert.match(prompt, /Hand-offs list in the menu drawer .* \(Drafted, Sent, PR open, Merged, Closed\)/);
  assert.ok(prompt.includes('never touches the operator\'s Code credentials'));
  // Streamed chat with the live trace (#230/#232)
  assert.match(prompt, /- Live trace: a signed-in chat reply streams in\./);
  assert.ok(prompt.includes('fold into one "Writing · N steps" line'));
  assert.ok(prompt.includes('an "N steps" pill in its header ("PG1 · time · N steps") that opens the list, each row showing how long that step took on the server'));
  assert.ok(prompt.includes('Only steps that really ran are listed; a step never shows your reasoning or any prompt text.'));
  assert.ok(prompt.includes('The send button turns into Stop while a reply is in flight.'));
  // Streamed voice with the waveform (#231)
  assert.match(prompt, /- Voice: the "Spoken replies" switch in the menu drawer/);
  assert.ok(prompt.includes('a small animated waveform button appears in that message\'s header, and tapping the waveform stops the speech'));
  assert.ok(prompt.includes('spoken sentence by sentence while it is still being written'));
  // Icon-only message actions
  assert.match(prompt, /- Message actions: under every reply there are three icon-only buttons with no visible text, labelled for screen readers as Read aloud \(speaker icon\), Copy reply and Delete reply/);
  assert.ok(prompt.includes('Edit message, Copy message and Delete message'));
  assert.ok(prompt.includes('There is no button labelled SPEAK, COPY or DELETE, so never tell the operator to "tap SPEAK".'));
});

test('no stale UI names: nothing tells PG1 about a SPEAK button or a VOICE toggle in the header', async () => {
  const { prompt } = await promptFor({ prompt: 'how do I hear this?' });
  const stale = /SPEAK button|VOICE toggle|used for SPEAK|SPEAK and \/speak|header auto-speaks|its own SPEAK/;
  assert.doesNotMatch(prompt, stale);
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: '/help' })), res);
  assert.doesNotMatch(res.jsonBody.reply, /\bSPEAK\b/);
  assert.match(res.jsonBody.reply, /voice profile used for spoken replies and Read aloud/);
  assert.match(res.jsonBody.reply, /Send to Code, drafts a task prompt you copy into Code \(or open it pre-filled\) and tracks its PR under Hand-offs/);
});

test('the prompt describes the page as shipped: Read aloud / Copy / Delete are icon-only, the waveform stops speech, the switch is "Spoken replies"', () => {
  // Agent message actions: real buttons with an aria-label and an icon, no visible text.
  const actions = html.match(/: \[\['speakBubble', 'Read aloud', 'i-speaker', ''\], \['copyBubbleText', 'Copy reply', 'i-copy', ''\], \['deleteBubble', 'Delete reply', 'i-trash', ''\]\];/);
  assert.ok(actions, 'agent actions are Read aloud, Copy reply, Delete reply');
  assert.match(html, /\[\['editBubble', 'Edit message', 'i-edit', 40\], \['copyBubbleText', 'Copy message', 'i-copy', 40\], \['deleteBubble', 'Delete message', 'i-trash', 40\]\]/);
  const button = html.match(/return `<button type="button" class="msg-action" onclick="[^"]*" aria-label="\$\{label\}" title="\$\{label\}">(.*?)<\/button>`;/);
  assert.ok(button, 'one shared action button template');
  assert.doesNotMatch(button[1].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/\$\{done\}/, ''), /\S/, 'the button body is icons only (no visible text)');
  assert.doesNotMatch(html, /tap SPEAK|SPEAK button/i, 'the page never calls it SPEAK');
  // The waveform in the message header stops speech.
  assert.match(html, /const VOICE_WAVE_HTML = '<button type="button" class="voice-wave" aria-label="Stop speaking" title="Stop speaking" onclick="triggerHaptic\(30\); stopVoicePlayback\(\)">/);
  // The voice toggle is the "Spoken replies" switch in the drawer, not a header toggle.
  assert.match(html, /<span class="drawer-row-label" id="voice-label">[\s\S]*?Spoken replies<\/span>\s*<button type="button" id="voice-btn" class="switch" role="switch"/);
});

test('PG1 is told to say when it is unsure about its own internals instead of guessing', async () => {
  const { prompt } = await promptFor({ prompt: 'is there a settings page?' });
  assert.match(prompt, /- Your own internals: everything above is all you know about this app's interface and plumbing\./);
  assert.ok(prompt.includes('say you are not sure and that the operator should check the app or repository, rather than guessing or inventing one'));
  assert.ok(prompt.includes('Never describe a UI element by a name that is not used here.'));
});

// --- 3. spoken replies stay short ---------------------------------------------------------

test('with spoken replies on (speak: true) the prompt asks for under about 80 words and an offer of more detail', async () => {
  assert.equal(SPOKEN_REPLY_WORD_LIMIT, 80);
  const directive = spokenReplyDirective();
  assert.match(directive, /^\[SPOKEN REPLY\]: /);
  assert.ok(directive.includes('Keep it under about 80 words'));
  assert.ok(directive.includes('finish by offering more detail in one short sentence'));
  assert.ok(directive.includes('no headings, bullet lists, tables or code blocks unless they were asked for'));

  // Streamed path (the voice player is on; no TTS key here, so no audio, but the reply is still read aloud by the client).
  const streamed = await promptFor({ prompt: 'how is the vault?', stream: true, speak: true });
  assert.ok(streamed.prompt.includes(directive), 'streamed reply gets the directive');
  assert.ok(streamed.prompt.indexOf(directive) < streamed.prompt.indexOf('[CONTEXT]:'), 'the directive sits with the instructions, before [CONTEXT]');
  assert.ok(eventsOf(streamed.res).some((e) => e.type === 'done'));
  // JSON path (a retry without streaming, with the switch still on).
  const json = await promptFor({ prompt: 'how is the vault?', speak: true });
  assert.ok(json.prompt.includes(directive), 'JSON reply gets the directive');
  assert.equal(json.res.jsonBody.reply, 'Stubbed model reply.');
});

test('with spoken replies off there is no spoken-reply directive, and a non-boolean speak does not count', async () => {
  for (const body of [{ prompt: 'how is the vault?' }, { prompt: 'how is the vault?', stream: true }, { prompt: 'x', speak: 'true' }, { prompt: 'x', speak: 1 }]) {
    const { prompt } = await promptFor(body);
    assert.doesNotMatch(prompt, /\[SPOKEN REPLY\]|80 words/, `no directive for ${JSON.stringify(body)}`);
  }
});

test('the page tells the server the switch is on even for a reply it will not stream', () => {
  assert.match(html, /const voicePlayer = \(wantStream && voiceActive\) \? startVoicePlayer\(agentBubble\) : null;\s*if \(voicePlayer\) payload\.speak = true;[\s\S]{0,400}?else if \(voiceActive\) payload\.speak = true;/);
});

// --- 4. step durations are measured on the server -------------------------------------

function fakeRes() {
  const r = makeRes();
  r.on = () => {};
  return r;
}

test('step_done carries ms measured between step() and stepDone() on the server, per step', () => {
  let clock = 1000;
  const res = fakeRes();
  const stream = createChatStream(res, { requestId: 'req-1', now: () => clock });
  stream.start();
  stream.step('db', 'Checking the database connection');
  clock += 400;
  stream.step('memory', 'Loading memory');
  clock += 1234.4;
  stream.stepDone('db', { label: 'Checked the database', result: 'connected' });
  clock += 10;
  stream.stepDone('memory', { label: 'Loaded memory', result: '3 recent messages' });
  stream.done();
  const events = eventsOf(res);
  const done = Object.fromEntries(events.filter((e) => e.type === 'step_done').map((e) => [e.id, e]));
  assert.equal(done.db.ms, 1634, 'db ran from 1000 to 2634.4, rounded');
  assert.equal(done.memory.ms, 1244, 'memory is timed from its own start, not from db\'s');
  assert.ok(events.filter((e) => e.type === 'step').every((e) => !('ms' in e)), 'a step that just started has no duration');
});

test('a step closed as "did not finish" and the GitHub call step are timed too; a clock that goes backwards never yields a negative ms', () => {
  let clock = 50;
  const res = fakeRes();
  const stream = createChatStream(res, { requestId: 'req-2', now: () => clock });
  stream.start();
  const tracedFetch = stream.wrapFetch(async () => ({ ok: true }));
  stream.step('vault', 'Listing vault files');
  clock += 300;
  const call = tracedFetch('https://api.github.com/repos/x/y');
  clock += 2000;
  return call.then(() => {
    clock -= 5000; // the clock is monotonic in production; this is the guard for a test double that is not
    stream.stepDone('vault', { label: 'Listed vault files', result: '2 files' });
    clock = 5000;
    stream.step('model', 'Writing the reply');
    clock += 750;
    stream.error('boom'); // closes the open steps as "did not finish", timed like any other
    const events = eventsOf(res);
    const vault = events.find((e) => e.type === 'step_done' && e.id === 'vault');
    assert.equal(vault.ms, 0, 'never negative');
    const model = events.find((e) => e.type === 'step_done' && e.id === 'model');
    assert.equal(model.label, 'Stopped');
    assert.equal(model.result, 'did not finish');
    assert.equal(model.failed, true);
    assert.equal(model.ms, 750);
    const github = events.find((e) => e.type === 'step_done' && e.id === 'github');
    assert.equal(github.label, 'Called GitHub');
    assert.equal(github.ms, 5750 - 350, 'the GitHub step is timed from its first call to the stream closing it');
  });
});

test('every step_done in a real streamed chat reply carries a non-negative integer ms', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const ORIGINAL = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('streamGenerateContent')) return new Response(sseBody([geminiChunk('All clear.', { finishReason: 'STOP' })]));
    if (u.includes('/rest/v1/messages?select=id')) return new Response('[]');
    if (u.includes('/rest/v1/messages?select=role')) return new Response('[]');
    if (u.includes('/rest/v1/messages')) return new Response('[]', { status: 201 });
    if (u.includes('/storage/v1/object/list/pg1-vault')) return new Response('[]');
    if (u.includes('/rest/v1/pg1_errors')) return new Response('[]');
    throw new Error('Unexpected network call in test: ' + u);
  };
  try {
    const res = makeRes();
    await chatHandler(makeReq(authed({ prompt: 'hello there', stream: true })), res);
    const events = eventsOf(res);
    const done = events.filter((e) => e.type === 'step_done');
    assert.deepEqual(done.map((e) => e.id), ['db', 'memory', 'vault', 'errors', 'model']);
    for (const e of done) {
      assert.ok(Number.isInteger(e.ms) && e.ms >= 0, `${e.id} has an integer ms (${e.ms})`);
    }
  } finally {
    globalThis.fetch = ORIGINAL;
  }
});
