/**
 * Chat reply rules from the short-form video pricing thread (14 Oct):
 *
 *   A2  a request for a full, detailed or complete breakdown gets the full
 *       written form, even with spoken replies on
 *   A3  figures in a web-search reply come with the search's sources, or
 *       are labelled as PG1's own proposal; never "based on web search
 *       data" with nothing behind it
 *   A4  figures PG1 proposes go into the thread's task state; a later reply
 *       that changes one without saying so gets a note naming the change
 *   A5  command forms PG1 suggests are real ones (/lab report <id>)
 *   A6  the prompt describes the lab as it really works (Vercel pulls the
 *       result from GitHub; the runner never writes to Supabase)
 *
 * Run with: node --test tests/chat-figures-and-detail.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { createSseParser } from '../lib/chatStream.mjs';
import { wantsDetail, DETAIL_DIRECTIVE, extractFigures, figureChanges, figureChangeNote, mergeFigures, sourcesNote, groundingSources, SOURCED_FIGURES_DIRECTIVE, COMMAND_FORMS_DIRECTIVE } from '../lib/replyFacts.mjs';
import { cleanTaskState, renderTaskState, updateFromReply, emptyTaskState } from '../lib/taskState.mjs';
import { LAB_ARCHITECTURE_TEXT } from '../lib/lab/chat.mjs';

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
function eventsOf(res) {
  const out = [];
  const parser = createSseParser(({ data }) => out.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return out;
}
const sse = (objs) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');

// One stubbed Gemini reply (JSON and streamed); the system prompt is kept.
function stubModel(text, groundingMetadata = null) {
  const seen = { prompts: [] };
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('generativelanguage.googleapis.com')) throw new Error('Unexpected network call in test: ' + u);
    seen.prompts.push(JSON.parse(options.body).systemInstruction.parts[0].text);
    const cand = { content: { parts: [{ text }] }, finishReason: 'STOP', ...(groundingMetadata ? { groundingMetadata } : {}) };
    if (u.includes('streamGenerateContent')) return new Response(sse([{ candidates: [cand] }]));
    return Response.json({ candidates: [cand] });
  };
  return seen;
}
async function chat(body) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.79.0.${++ipSeq % 250}` }, body: { user: 'test-operator', pass: 'test-secret-pass', ...body } }, res);
  return res;
}

const FIRST = '## Packages\n| Tier | Price | Includes |\n|---|---|---|\n| Starter | $25/month | 4 clips |\n| Creator | $45/month | 8 clips |\n| Studio | $80/month | 16 clips |';
const SECOND = 'Updated packages:\n- Starter: $25/month\n- Creator: $65/month\n- Studio: $120/month';

// --- A2 -------------------------------------------------------------------------

test('A2: "full", "detailed" or "complete" breakdowns are detail requests; a plain question is not', () => {
  for (const t of ['Give me the full breakdown', 'a detailed breakdown of each tier please', 'can I have the complete pricing list?', 'break it down in full detail']) assert.equal(wantsDetail(t), true, t);
  for (const t of ['how much is Creator?', 'thanks', '/lab report', 'full stop.']) assert.equal(wantsDetail(t), false, t);
  assert.match(DETAIL_DIRECTIVE, /headings, a Markdown table for anything with tiers, prices or options, and a short description of each tier/);
});

test('A2: with spoken replies on, a detail request gets the full written form, not the short spoken style', async () => {
  for (const stream of [false, true]) {
    const seen = stubModel('ok');
    await chat({ prompt: 'Give me the full detailed breakdown of each package', speak: true, stream });
    assert.ok(seen.prompts[0].includes(DETAIL_DIRECTIVE), `detail directive (stream ${stream})`);
    assert.doesNotMatch(seen.prompts[0], /\[SPOKEN REPLY\]/, `no spoken brevity (stream ${stream})`);
  }
  const seen = stubModel('ok');
  await chat({ prompt: 'how much is Creator?', speak: true });
  assert.match(seen.prompts[0], /\[SPOKEN REPLY\]/, 'a plain spoken question is still short');
});

// --- A3 -------------------------------------------------------------------------

test('A3: figures from a search turn come with its sources; with none, they are labelled PG1\'s own proposal', () => {
  const sources = groundingSources({ groundingChunks: [{ web: { uri: 'https://example.org/rates', title: 'example.org' } }, { web: { uri: 'http://insecure.example/x', title: 'x' } }, { web: { uri: 'https://example.org/rates', title: 'dup' } }] });
  assert.deepEqual(sources, [{ url: 'https://example.org/rates', title: 'example.org' }]);
  assert.match(sourcesNote({ text: SECOND, sources }), /^\*\*Sources \(this reply's web search\):\*\*\n1\. \[example\.org\]\(https:\/\/example\.org\/rates\)/);
  assert.match(sourcesNote({ text: `Based on web search data:\n${SECOND}`, sources: [] }), /no source for the figures above, so they are PG1's own estimates, not market data/);
  // Item 5 (Studio + Sound brief): figures in no cited source are labelled
  // PG1's estimate, even with no search claim.
  assert.equal(sourcesNote({ text: SECOND, sources: [] }), '**Note:** the prices above are PG1\'s own estimates, not figures from a cited source.');
  assert.equal(sourcesNote({ text: 'No numbers here.', sources }), '');
  assert.match(SOURCED_FIGURES_DIRECTIVE, /Never write "based on web search data"/);
});

test('A3: through the chat, a priced reply shows the search sources (streamed); "based on web search data" with no source is labelled (JSON)', async () => {
  stubModel(SECOND, { groundingChunks: [{ web: { uri: 'https://rates.example/video', title: 'rates.example' } }], webSearchQueries: ['video editing rates'] });
  const streamed = await chat({ prompt: 'what should the packages cost?', stream: true });
  const text = eventsOf(streamed).filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.match(text, /\*\*Sources \(this reply's web search\):\*\*\n1\. \[rates\.example\]\(https:\/\/rates\.example\/video\)/);
  const seen = stubModel(`Based on web search data:\n${SECOND}`);
  const json = await chat({ prompt: 'what should the packages cost?' });
  assert.ok(seen.prompts[0].includes(SOURCED_FIGURES_DIRECTIVE));
  assert.match(json.jsonBody.reply, /they are PG1's own estimates, not market data/);
});

// --- A4 -------------------------------------------------------------------------

test('A4: proposed figures go into the task state and its [TASK STATE] block', () => {
  assert.deepEqual(extractFigures(FIRST).map((f) => `${f.label}=${f.value}`), ['Starter=$25/month', 'Creator=$45/month', 'Studio=$80/month']);
  const s = updateFromReply(emptyTaskState(), { prompt: 'price the packages', reply: { reply: FIRST } });
  assert.deepEqual(s.figures.map((f) => f.value), ['$25/month', '$45/month', '$80/month']);
  assert.match(renderTaskState(s), /Figures PG1 already proposed in this thread \(keep them, or say which one changes, old → new, and why\):\n {2}- Starter: \$25\/month\n {2}- Creator: \$45\/month/);
  // The client sends it back; it survives cleaning.
  assert.deepEqual(cleanTaskState(JSON.parse(JSON.stringify(s))).figures.map((f) => f.key), ['starter', 'creator', 'studio']);
  // A slash command's output never adds figures.
  assert.deepEqual(updateFromReply(emptyTaskState(), { prompt: '/spend', reply: { reply: 'Creator: $45' } }).figures, []);
});

test('A4: a reply that changes figures without saying so gets a note naming each change; an explained change does not', () => {
  const prev = mergeFigures([], FIRST, 1);
  const silent = figureChanges(prev, SECOND);
  assert.deepEqual(silent.map((c) => [c.label, c.from, c.to, c.explained]), [['Creator', '$45/month', '$65/month', false], ['Studio', '$80/month', '$120/month', false]]);
  assert.equal(figureChangeNote(silent), '**Changed from earlier in this thread:** Creator $45/month → $65/month; Studio $80/month → $120/month. The reply above did not explain these changes; ask PG1 why before relying on the new figures.');
  const explained = figureChanges(prev, '- Creator: $65/month (up from $45, because each clip now includes captions)\n- Studio: $120/month, raised from $80 for the extra revisions');
  assert.ok(explained.every((c) => c.explained));
  assert.equal(figureChangeNote(explained), '');
});

test('A4: through the chat, the thread\'s earlier figures reach the prompt and an unexplained change is flagged', async () => {
  const taskState = updateFromReply(emptyTaskState(), { prompt: 'price it', reply: { reply: FIRST } });
  const seen = stubModel(SECOND);
  const res = await chat({ prompt: 'can you redo the packages?', taskState });
  assert.match(seen.prompts[0], /- Creator: \$45\/month/);
  assert.match(res.jsonBody.reply, /\*\*Changed from earlier in this thread:\*\* Creator \$45\/month → \$65\/month; Studio \$80\/month → \$120\/month\./);
  assert.equal(res.jsonBody.taskState.figures.find((f) => f.key === 'creator').value, '$65/month', 'the new figure is now the thread\'s figure');
});

// --- A5 / A6 --------------------------------------------------------------------

test('A5/A6: the prompt lists only real lab command forms and describes the real lab flow', async () => {
  const seen = stubModel('ok');
  await chat({ prompt: 'how does the lab work?' });
  const p = seen.prompts[0];
  assert.ok(p.includes(COMMAND_FORMS_DIRECTIVE));
  assert.match(COMMAND_FORMS_DIRECTIVE, /`\/lab report e2981021`/);
  assert.ok(p.includes('/lab report <id> shows one experiment\'s report and cost (/lab report alone shows the latest one)'));
  assert.ok(p.includes(LAB_ARCHITECTURE_TEXT));
  assert.match(LAB_ARCHITECTURE_TEXT, /The runner on GitHub never touches Supabase or this server/);
  assert.match(LAB_ARCHITECTURE_TEXT, /This server \(Vercel\) then pulls that artifact from GitHub/);
  assert.doesNotMatch(p, /runner[^.]{0,80}(?:uploads|syncs)[^.]{0,40}Supabase/i, 'never says the runner syncs to Supabase');
});
