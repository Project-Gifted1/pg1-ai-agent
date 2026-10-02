/**
 * Live progress trace in public/index.html, client side:
 *  - streamed reply text stays inert at every partial length (no XSS
 *    mid-stream), and an unclosed code fence renders as code
 *  - trace rows: escaped, keyboard-operable expanders, failed marks, no emoji
 *  - the live trace view (run for real on tests/helpers/mini-dom.mjs): a
 *    gold dot on the running step, rows joined by a timeline, the fold into
 *    "Writing · N steps" when text starts, the "N steps" header pill with
 *    durations (the server's own ms on step_done, not the browser clock)
 *    when it is done, and no row for the voice step
 *  - readChatStream / consumeDirectiveStream over a chunked body, including
 *    the Stop button aborting mid-stream and a dropped connection
 *  - the fallback path: JSON replies still go through the old code, and a
 *    dropped stream offers a retry that asks for the JSON reply
 *
 * Same approach as handoff-ui.test.mjs: the functions are pulled out of the
 * shipped HTML and run in a vm context with small stand-ins for the DOM.
 *
 * Run with: node --test tests/chat-stream-client.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { createDocument } from './helpers/mini-dom.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '../public/index.html'), 'utf-8');

function extractFunction(name) {
  let start = html.indexOf(`async function ${name}(`);
  if (start === -1) start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found in public/index.html`);
  let depth = 0;
  let i = html.indexOf('{', html.indexOf(')', start));
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

const FUNCS = [
  'escapeHTML', 'formatMarkdown', 'renderDiffBlock', 'formatStreamingMarkdown', 'parseSseBuffer', 'parseTraceEvent',
  'readChatStream', 'formatStepDuration', 'stepDurationMs', 'traceRowHtml', 'traceRunningRowHtml', 'stepCountText', 'agentTimestampHtml',
  'toggleTraceDetails', 'createTraceView', 'consumeDirectiveStream', 'syncExecuteButton',
  'onExecuteClick', 'stopDirectives', 'retryButtonHtml', 'retryDirective', 'renderStreamFailure'
];
const SOURCE = [
  html.match(/const TRACE_EVENT_TYPES = [^\n]*;/)[0],
  'var traceSeq = 0;',
  'var inFlightDirectives = new Set();',
  'var REQUEST_TIMEOUT_MS = 75000;',
  ...FUNCS.map(extractFunction)
].join('\n').replace(/^const TRACE/m, 'var TRACE');

function makeContext(overrides = {}) {
  const log = { submits: [], errors: [], saves: 0, haptics: 0 };
  const ctx = {
    log,
    TextDecoder,
    navigator: { onLine: true },
    window: {},
    setTimeout,
    document: { getElementById: () => null, querySelector: () => null, createElement: () => ({}) },
    triggerHaptic: () => { log.haptics++; },
    logError: (msg, where, category) => log.errors.push({ msg, where, category }),
    saveState: () => { log.saves++; },
    messageActionsHtml: () => '<div class="message-actions"></div>',
    submitDirective: (opts) => log.submits.push(opts || {}),
    isVoicePlaying: () => false,
    stopVoicePlayback: () => { log.voiceStops = (log.voiceStops || 0) + 1; },
    syncVoiceWave: () => {},
    ...overrides
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  return ctx;
}

// --- streamed markdown --------------------------------------------------------------

function assertInert(out, label) {
  assert.doesNotMatch(out, /<script/i, `${label}: <script> tag leaked`);
  assert.doesNotMatch(out, /<img(?![^>]*src="(?:https?:|data:image\/))/i, `${label}: unsafe <img> leaked`);
  assert.doesNotMatch(out, /<iframe|<svg[^>]*onload|<object|<embed/i, `${label}: active element leaked`);
  // formatMarkdown's own handlers are the only ones allowed: code-copy and
  // slash-command chips.
  const handlers = out.match(/\son[a-z]+\s*=\s*"[^"]*"/gi) || [];
  for (const h of handlers) assert.match(h, /^ onclick="(copyCodeBlock\(this\)|triggerHaptic\(30\); document\.getElementById\('prompt-input'\)\.value='\/[a-zA-Z0-9_-]+')/, `${label}: unexpected handler ${h}`);
  assert.doesNotMatch(out, /href\s*=\s*["']?\s*(javascript|data|vbscript):/i, `${label}: script URL leaked`);
}

const HOSTILE = [
  'Before <script>alert(1)</script> after',
  'Pic: <img src=x onerror="alert(1)"> done',
  '[click](javascript:alert(1)) and ![x](javascript:alert(2))',
  '```html\n<svg onload=alert(1)></svg>\n```\nthen <iframe src="javascript:alert(3)"></iframe>',
  '| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | ok |',
  'https://example.com/"onmouseover="alert(1) and `<b>code</b>` and **<i>bold</i>**',
  '- item <a href="javascript:alert(1)">x</a>\n# <script>h</script>',
  '[ /status ] and [ /x" onclick="alert(1) ]'
];

test('every partial prefix of a hostile reply renders inert mid-stream', () => {
  const { formatStreamingMarkdown } = makeContext();
  for (const reply of HOSTILE) {
    for (let n = 0; n <= reply.length; n++) {
      assertInert(formatStreamingMarkdown(reply.slice(0, n)), `prefix ${n} of ${JSON.stringify(reply)}`);
    }
  }
});

test('an unclosed code fence mid-stream renders as an escaped code block', () => {
  const { formatStreamingMarkdown, formatMarkdown } = makeContext();
  const partial = 'Here:\n```js\nconst a = "<b>";\nconsole.log(a';
  const out = formatStreamingMarkdown(partial);
  assert.match(out, /<pre class="md-pre"><code>const a = &quot;&lt;b&gt;&quot;;\nconsole\.log\(a<\/code><\/pre>/);
  // Closed fences and plain text render exactly like the final pass.
  assert.equal(formatStreamingMarkdown('a **b** c'), formatMarkdown('a **b** c'));
  assert.equal(formatStreamingMarkdown(''), '');
});

// --- trace rows ---------------------------------------------------------------------

test('a finished step is a compact row; details make it a keyboard button with aria-expanded', () => {
  const { traceRowHtml } = makeContext();
  const plain = traceRowHtml({ id: 'memory', label: 'Loaded memory', result: '3 recent messages' }, 'u1');
  assert.match(plain, /<li class="trace-row"><div class="trace-line"><svg class="icon trace-mark" aria-hidden="true"><use href="#i-check"\/><\/svg><span class="trace-label">Loaded memory<span class="trace-result"> · 3 recent messages<\/span><\/span><\/div><\/li>/);
  assert.doesNotMatch(plain, /trace-dur/, 'no duration when none was measured');
  const timed = traceRowHtml({ id: 'memory', label: 'Loaded memory' }, 'u1', 1234);
  assert.match(timed, /<span class="trace-dur"><span class="sr-only">took <\/span>1\.2s<\/span><\/div>/);
  assert.doesNotMatch(plain, /<button/);

  const withDetails = traceRowHtml({ id: 'errors', label: 'Checked error log', result: '3 new', details: ['CHAT 500 <b>boom</b>', 42, ''] }, 'u2');
  assert.match(withDetails, /<button type="button" class="trace-line trace-toggle" aria-expanded="false" aria-controls="trace-d-u2" onclick="toggleTraceDetails\(this\)">/);
  assert.match(withDetails, /<ul class="trace-details" id="trace-d-u2" hidden><li>CHAT 500 &lt;b&gt;boom&lt;\/b&gt;<\/li><\/ul>/, 'details escaped; non-strings dropped');
  assert.match(withDetails, /href="#i-chevron"/);

  const failed = traceRowHtml({ id: 'db', label: 'Checked the database', result: 'unreachable', failed: true }, 'u3');
  assert.match(failed, /class="trace-row is-failed"/);
  assert.match(failed, /href="#i-x"/);
  assert.match(failed, /<span class="sr-only"> \(failed\)<\/span>/);

  const hostile = traceRowHtml({ label: '<img src=x onerror=alert(1)>', result: '"><script>' }, 'u4');
  assert.doesNotMatch(hostile, /<img|<script/);
  for (const out of [plain, withDetails, failed]) assert.doesNotMatch(out, /\p{Extended_Pictographic}/u, 'no emoji');
});

test('toggleTraceDetails flips aria-expanded and the hidden state of its target', () => {
  const target = { hidden: true };
  const ctx = makeContext({ document: { getElementById: (id) => (id === 'trace-d-u2' ? target : null) } });
  const attrs = { 'aria-controls': 'trace-d-u2', 'aria-expanded': 'false' };
  const btn = { getAttribute: (k) => attrs[k], setAttribute: (k, v) => { attrs[k] = v; } };
  ctx.toggleTraceDetails(btn);
  assert.equal(attrs['aria-expanded'], 'true');
  assert.equal(target.hidden, false);
  ctx.toggleTraceDetails(btn);
  assert.equal(attrs['aria-expanded'], 'false');
  assert.equal(target.hidden, true);
});

test('step durations read as <0.1s, 0.4s, 1.2s, 12s', () => {
  const { formatStepDuration } = makeContext();
  assert.equal(formatStepDuration(30), '<0.1s');
  assert.equal(formatStepDuration(400), '0.4s');
  assert.equal(formatStepDuration(1234), '1.2s');
  assert.equal(formatStepDuration(9960), '10.0s');
  assert.equal(formatStepDuration(12400), '12s');
  assert.equal(formatStepDuration(undefined), '');
  assert.equal(formatStepDuration(-5), '');
});

test('a finished row shows the server\'s own timing (ms on step_done), never the browser clock', () => {
  const { stepDurationMs } = makeContext();
  assert.equal(stepDurationMs({ ms: 3400 }, 50), 3400, 'server timing wins');
  assert.equal(stepDurationMs({ ms: 0 }, 50), 0, 'a zero from the server is still the server\'s answer');
  assert.equal(stepDurationMs({}, 1200), 1200, 'an older server that sends no ms: how long the row was shown as running');
  assert.equal(stepDurationMs({ ms: '3400' }, 1200), 1200, 'a non-number is ignored');
  assert.equal(stepDurationMs({ ms: -1 }, 1200), 1200, 'a negative one is ignored');
  assert.equal(stepDurationMs({ ms: Infinity }, 1200), 1200);
  assert.equal(stepDurationMs(null, 1200), 1200);
});

// The real createTraceView on a tiny DOM, with a controllable clock.
function makeTraceHarness() {
  const document = createDocument();
  let clock = 1000;
  const ctx = makeContext({ document, performance: { now: () => clock } });
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble pending';
  bubble.innerHTML = '<span class="msg-timestamp">06:22 PM</span><div class="message-text pending-text">Running directive…</div>';
  document.body.appendChild(bubble);
  const view = ctx.createTraceView(bubble);
  const trace = bubble.querySelector('.trace');
  return { ctx, document, bubble, view, trace, tick: (ms) => { clock += ms; } };
}

test('working: each step is a row as it starts, the running one with a gold dot, then a muted tick and result', () => {
  const { view, trace, tick } = makeTraceHarness();
  const status = trace.querySelector('.trace-status');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.ok(status.classList.contains('sr-only'), 'the status line is for screen readers only');
  assert.equal(trace.querySelector('.trace-steps').getAttribute('aria-live'), 'off', 'rows are kept out of the live log');

  view.step({ id: 'db', label: 'Checking the database connection' });
  view.step({ id: 'memory', label: 'Loading memory' });
  let rows = trace.querySelectorAll('.trace-row');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.classList.contains('is-running') && r.querySelector('.trace-dot')), 'running rows have the gold dot');
  assert.equal(status.textContent, 'Loading memory');

  tick(1234);
  view.stepDone({ id: 'db', label: 'Checked the database', result: 'connected' });
  rows = trace.querySelectorAll('.trace-row');
  assert.equal(rows.length, 2, 'the row is replaced in place, not appended');
  assert.ok(!rows[0].classList.contains('is-running'));
  assert.ok(rows[0].querySelector('.trace-mark'), 'finished row has a tick');
  assert.equal(rows[0].querySelector('.trace-result').textContent, ' · connected');
  assert.equal(rows[0].querySelector('.trace-dur').textContent, 'took 1.2s');
  assert.ok(rows[1].classList.contains('is-running'), 'order is kept: memory still running below');
  view.stepDone({ id: 'memory', label: 'Loaded memory', result: 'unavailable', failed: true });
  assert.ok(trace.querySelectorAll('.trace-row')[1].classList.contains('is-failed'));
  assert.equal(status.textContent, 'Working');
  // A step_done for something never started changes nothing.
  view.stepDone({ id: 'nope', label: 'x' });
  assert.equal(trace.querySelectorAll('.trace-row').length, 2);
});

test('writing: the first reply text folds the steps into one live "Writing · N steps" line that keeps counting', () => {
  const { view, trace } = makeTraceHarness();
  view.step({ id: 'db', label: 'Checking the database connection' });
  view.stepDone({ id: 'db', label: 'Checked the database', result: 'connected' });
  view.step({ id: 'model', label: 'Writing the reply' });
  const line = trace.querySelector('.trace-writing');
  assert.ok(line.hidden, 'no live line before text');
  view.writing();
  assert.ok(!line.hidden);
  assert.ok(trace.querySelector('.trace-steps').hidden, 'rows folded away');
  assert.ok(trace.classList.contains('is-writing'));
  assert.equal(line.textContent.replace(/\s+/g, ' ').trim(), 'Writing · 2 steps');
  assert.ok(line.querySelector('.trace-dot'), 'gold dot on the live line');
  assert.equal(line.tagName, 'button');
  assert.equal(line.getAttribute('aria-expanded'), 'false');
  assert.equal(line.getAttribute('aria-controls'), trace.querySelector('.trace-steps').id);
  view.step({ id: 'search', label: 'Searching the web' });
  assert.equal(trace.querySelector('.trace-count').textContent, '3 steps', 'count updates while writing');
  view.writing();
  assert.equal(trace.querySelectorAll('.trace-writing').length, 1);
});

test('rows show the step\'s server-side duration: a step that arrived 50ms apart but took 3.4s on the server reads "took 3.4s"', () => {
  const { view, trace, tick } = makeTraceHarness();
  view.step({ id: 'db', label: 'Checking the database connection' });
  view.step({ id: 'memory', label: 'Loading memory' });
  tick(50);
  view.stepDone({ id: 'db', label: 'Checked the database', result: 'connected', ms: 3400 });
  // An event from an older server without ms: the row was running here for 1.2s.
  tick(1150);
  view.stepDone({ id: 'memory', label: 'Loaded memory', result: '2 recent messages' });
  const durs = trace.querySelectorAll('.trace-dur').map((d) => d.textContent);
  assert.deepEqual(durs, ['took 3.4s', 'took 1.2s']);
});

test('consumeDirectiveStream: the finished list carries the server durations', async () => {
  const document = createDocument();
  const ctx = makeContext({ document, window: { requestAnimationFrame: (fn) => fn() }, performance: { now: () => 0 } });
  const chat = document.createElement('div');
  chat.id = 'chat-container';
  document.body.appendChild(chat);
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble pending';
  bubble.innerHTML = '<span class="msg-timestamp">06:22 PM</span><div class="message-text pending-text">Running directive…</div>';
  chat.appendChild(bubble);
  const stream = [
    ev({ type: 'step', id: 'db', label: 'Checking the database connection' }),
    ev({ type: 'step', id: 'model', label: 'Writing the reply' }),
    ev({ type: 'step_done', id: 'db', label: 'Checked the database', result: 'connected', ms: 412 }),
    ev({ type: 'text', text: 'Hi' }),
    ev({ type: 'step_done', id: 'model', label: 'Wrote the reply', result: '1 word', ms: 12400 }),
    ev({ type: 'done', request_id: 'r1' })
  ].join('');
  const out = await ctx.consumeDirectiveStream(chunkedResponse(stream, [1e6]), bubble, new AbortController().signal);
  assert.equal(out.data.reply, 'Hi');
  const holder = document.createElement('div');
  holder.innerHTML = out.traceHtml;
  assert.deepEqual(holder.querySelectorAll('.trace-dur').map((d) => d.textContent), ['took 0.4s', 'took 12s'], 'the browser clock never moved; these are the server\'s numbers');
});

test('consumeDirectiveStream folds the trace on the first text chunk and places the reply right under it', async () => {
  const document = createDocument();
  const ctx = makeContext({ document, window: { requestAnimationFrame: (fn) => fn() } });
  const chat = document.createElement('div');
  chat.id = 'chat-container';
  document.body.appendChild(chat);
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble pending';
  bubble.innerHTML = '<span class="msg-timestamp">06:22 PM</span><div class="message-text pending-text">Running directive…</div>';
  chat.appendChild(bubble);
  let foldedAtText = null;
  const stream = [
    ev({ type: 'step', id: 'memory', label: 'Loading memory' }),
    ev({ type: 'step_done', id: 'memory', label: 'Loaded memory', result: '2 recent messages' }),
    ev({ type: 'step', id: 'model', label: 'Writing the reply' }),
    ev({ type: 'text', text: 'Hello' }),
    ev({ type: 'step', id: 'voice', label: 'Speaking the reply' }),
    ev({ type: 'step_done', id: 'voice', label: 'Spoke the reply', result: '1 sentence' }),
    ev({ type: 'step_done', id: 'model', label: 'Wrote the reply', result: '1 word' }),
    ev({ type: 'done', request_id: 'r1' })
  ].join('');
  const res = chunkedResponse(stream, [1e6]);
  const origRead = res.body.getReader;
  res.body.getReader = () => {
    const r = origRead();
    return { read: async () => { const out = await r.read(); return out; } };
  };
  const realFold = ctx.createTraceView;
  ctx.createTraceView = (b) => {
    const view = realFold(b);
    const writing = view.writing;
    view.writing = () => { writing(); foldedAtText = b.innerHTML; };
    return view;
  };
  const out = await ctx.consumeDirectiveStream(res, bubble, new AbortController().signal);
  assert.ok(foldedAtText, 'folded when text arrived');
  const order = bubble.children.map((c) => c.className.split(' ')[0]);
  assert.deepEqual(order, ['msg-timestamp', 'trace', 'message-text'], 'reply text sits directly under the trace');
  assert.equal(out.data.reply, 'Hello');
  assert.match(out.tracePill, /^<button type="button" class="trace-pill" aria-expanded="false" aria-controls="trace-s-[^"]+" onclick="toggleTraceDetails\(this\)">2 steps<svg class="icon" aria-hidden="true"><use href="#i-chevron"\/><\/svg><\/button>$/);
  assert.doesNotMatch(out.traceHtml, /Speaking the reply|Spoke the reply/, 'no voice row: speech shows as the header waveform');
  assert.doesNotMatch(out.traceHtml, /trace-writing|trace-status|trace-dot/, 'live-only parts are gone when finished');
  assert.match(out.traceHtml, /^<div class="trace is-done"><ol class="trace-steps" id="trace-s-[^"]+" aria-label="Steps" hidden>/);
});

test('finished: the header reads "PG1 · time · N steps ›" and the pill opens the list (with durations) under it', () => {
  const { ctx, document, bubble, view, tick } = makeTraceHarness();
  view.step({ id: 'db', label: 'Checking the database connection' });
  tick(400);
  view.stepDone({ id: 'db', label: 'Checked the database', result: 'connected' });
  view.step({ id: 'model', label: 'Writing the reply' });
  tick(2600);
  view.stepDone({ id: 'model', label: 'Wrote the reply', result: '40 words' });
  const { html, pill } = view.finish();
  bubble.innerHTML = `${ctx.agentTimestampHtml('06:22 PM', pill)}${html}<div class="message-text">Hi</div>`;
  const header = bubble.querySelector('.msg-timestamp');
  assert.ok(header.classList.contains('has-trace'));
  assert.equal(header.textContent, '·06:22 PM·2 steps', 'PG1 (CSS) · time · N steps');
  assert.deepEqual(header.querySelectorAll('.ts-sep').map((n) => n.getAttribute('aria-hidden')), ['true', 'true']);
  const btn = header.querySelector('.trace-pill');
  const list = document.getElementById(btn.getAttribute('aria-controls'));
  assert.ok(list && list.hidden, 'list starts closed');
  assert.equal(list.closest('.trace').parentNode, bubble);
  ctx.toggleTraceDetails(btn);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.ok(!list.hidden);
  assert.deepEqual(list.querySelectorAll('.trace-dur').map((d) => d.textContent), ['took 0.4s', 'took 2.6s']);
  ctx.toggleTraceDetails(btn);
  assert.ok(list.hidden);
  // A reply with no steps keeps the plain header.
  assert.equal(ctx.agentTimestampHtml('06:22 PM', ''), '<span class="msg-timestamp">06:22 PM</span>');
});

test('finish: a step cut off mid-way is marked as not finished, and no steps means no trace at all', () => {
  const a = makeTraceHarness();
  a.view.step({ id: 'db', label: 'Checking the database connection' });
  const { html } = a.view.finish();
  assert.match(html, /class="trace-row is-failed"/);
  assert.match(html, /Checking the database connection<span class="trace-result"> · did not finish/);
  assert.doesNotMatch(html, /is-running/);
  const b = makeTraceHarness();
  assert.deepEqual(JSON.parse(JSON.stringify(b.view.finish())), { html: '', pill: '' });
  assert.equal(b.bubble.querySelector('.trace'), null);
});

test('trace styling: 14px muted rows ~28px high, muted ticks, gold pulsing dot, timeline, red failures, reduced motion', () => {
  const css = html.slice(html.indexOf('/* live trace:'), html.indexOf('.stream-note {'));
  assert.match(css, /\.trace \{ margin: 0 0 var\(--sp-3\); font-size: var\(--fs-sm\);[^}]*color: var\(--text-2\); \}/);
  assert.match(html, /--fs-sm: 0\.875rem;/, '14px');
  assert.match(css, /\.trace-line \{[^}]*min-height: 28px;/);
  assert.match(css, /\.trace-mark \{ color: var\(--text-3\); \}/, 'ticks muted, not green');
  assert.doesNotMatch(css, /var\(--ok\)/, 'no green anywhere in the trace');
  assert.match(css, /\.trace-result, \.trace-meta \{ color: var\(--text-3\); \}/);
  assert.match(css, /\.trace-row\.is-failed, \.trace-row\.is-failed \.trace-mark, \.trace-row\.is-failed \.trace-result \{ color: var\(--danger\); \}/);
  assert.match(css, /\.trace-row:not\(:last-child\)::before \{[^}]*width: 1px;[^}]*background: var\(--border-strong\);/);
  assert.match(css, /\.trace-dot::before, \.trace-dot::after \{[^}]*background: var\(--gold\);/);
  assert.match(css, /\.trace-dot::after \{ animation: trace-pulse/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.trace-dot::after \{ animation: none; opacity: 0; \}\s*\.wave-bars \{ display: none; \}\s*\.voice-wave \.icon \{ display: block; \}/);
  assert.match(css, /\.trace\.is-live \.trace-dur \{ display: none; \}/, 'durations only in the finished list');
  assert.doesNotMatch(css + extractFunction('createTraceView') + extractFunction('traceRowHtml'), /\p{Extended_Pictographic}/u, 'no emoji');
  // Reply chunks are kept out of the log region until the final render.
  assert.match(extractFunction('consumeDirectiveStream'), /textEl\.setAttribute\('aria-live', 'off'\)/);
});

// --- reading a stream ---------------------------------------------------------------

const enc = new TextEncoder();
function chunkedResponse(text, sizes, { failAfter = false, signal } = {}) {
  const bytes = enc.encode(text);
  const parts = [];
  let i = 0;
  let k = 0;
  while (i < bytes.length) { const n = sizes[k++ % sizes.length]; parts.push(bytes.slice(i, i + n)); i += n; }
  return {
    headers: { get: () => 'text/event-stream; charset=utf-8' },
    body: {
      getReader() {
        return {
          read: async () => {
            if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            if (parts.length) return { value: parts.shift(), done: false };
            if (failAfter) throw new TypeError('network error');
            return { value: undefined, done: true };
          }
        };
      }
    }
  };
}

const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const FULL_STREAM = [
  ': pg1 trace\n\n',
  ev({ type: 'step', id: 'memory', label: 'Loading memory' }),
  ev({ type: 'step_done', id: 'memory', label: 'Loaded memory', result: '2 recent messages' }),
  ev({ type: 'step', id: 'model', label: 'Writing the reply' }),
  ev({ type: 'text', text: 'Héllo — ' }),
  ev({ type: 'text', text: 'world <b>x</b>' }),
  ev({ type: 'step_done', id: 'model', label: 'Wrote the reply', result: '3 words' }),
  ev({ type: 'done', request_id: 'req123', telemetry: {} })
].join('');

test('readChatStream yields the same events for any chunking, including split multi-byte characters', async () => {
  const ctx = makeContext();
  const collect = async (sizes) => { const out = []; await ctx.readChatStream(chunkedResponse(FULL_STREAM, sizes), (e) => out.push(e)); return JSON.parse(JSON.stringify(out)); };
  const whole = await collect([1e6]);
  assert.deepEqual(whole.map((e) => e.type), ['step', 'step_done', 'step', 'text', 'text', 'step_done', 'done']);
  for (const sizes of [[1], [2, 3], [7], [13, 1, 5]]) assert.deepEqual(await collect(sizes), whole, `chunk sizes ${sizes}`);
});

// Stand-ins for the bubble consumeDirectiveStream works in. createTraceView
// is replaced with a recorder (its markup is checked above).
function makeStreamHarness(overrides = {}) {
  const trace = { steps: [], dones: [], finished: 0 };
  const textEl = { attrs: {}, innerHTML: '', className: '', setAttribute(k, v) { this.attrs[k] = v; } };
  const bubble = {
    querySelector(sel) {
      if (sel === '.pending-text') return null;
      if (sel === '.trace') return { after: () => {} };
      return null;
    }
  };
  const ctx = makeContext({
    document: {
      createElement: () => textEl,
      getElementById: () => ({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 })
    },
    window: { requestAnimationFrame: (fn) => fn() },
    ...overrides
  });
  ctx.createTraceView = () => ({
    step: (e) => trace.steps.push(e.id),
    stepDone: (e) => trace.dones.push(e.id),
    writing: () => { trace.writes = (trace.writes || 0) + 1; },
    finish: () => { trace.finished++; return { html: '<div class="trace">2 steps</div>', pill: '<button class="trace-pill">2 steps</button>' }; }
  });
  return { ctx, trace, textEl, bubble };
}

test('consumeDirectiveStream renders text as it arrives and returns the finished reply', async () => {
  const { ctx, trace, textEl, bubble } = makeStreamHarness();
  const out = await ctx.consumeDirectiveStream(chunkedResponse(FULL_STREAM, [9]), bubble, new AbortController().signal);
  assert.equal(out.failed, undefined);
  assert.equal(out.data.reply, 'Héllo — world <b>x</b>');
  assert.equal(out.data.traceId, 'req123');
  assert.deepEqual(trace.steps, ['memory', 'model']);
  assert.deepEqual(trace.dones, ['memory', 'model']);
  assert.equal(trace.finished, 1, 'trace collapsed once');
  assert.equal(out.traceHtml, '<div class="trace">2 steps</div>');
  assert.equal(out.tracePill, '<button class="trace-pill">2 steps</button>');
  assert.equal(trace.writes, 2, 'writing() on each text chunk (it is idempotent)');
  assert.equal(textEl.attrs['aria-live'], 'off');
  assert.match(textEl.innerHTML, /world &lt;b&gt;x&lt;\/b&gt;/, 'streamed text escaped');
});

test('Stop mid-stream aborts cleanly and keeps what arrived', async () => {
  const { ctx, bubble } = makeStreamHarness();
  const controller = new AbortController();
  const cut = FULL_STREAM.indexOf('event: text', FULL_STREAM.indexOf('event: text') + 1);
  const res = chunkedResponse(FULL_STREAM.slice(0, cut), [1e6], { signal: controller.signal });
  const origRead = res.body.getReader;
  res.body.getReader = () => { const r = origRead(); let n = 0; return { read: async () => { if (n++ === 1) controller.abort(); return r.read(); } }; };
  const out = await ctx.consumeDirectiveStream(res, bubble, controller.signal);
  assert.equal(out.failed, 'aborted');
  assert.equal(out.text, 'Héllo — ');
});

test('the Stop button: execute becomes Stop while a directive is in flight and the box is empty', () => {
  const useAttrs = {};
  const btnAttrs = {};
  const classes = new Set();
  const btn = {
    classList: { contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    setAttribute: (k, v) => { btnAttrs[k] = v; },
    querySelector: () => ({ setAttribute: (k, v) => { useAttrs[k] = v; } })
  };
  const input = { value: '' };
  const ctx = makeContext({ document: { querySelector: () => btn, getElementById: () => input } });
  ctx.syncExecuteButton();
  assert.ok(!classes.has('is-stop'));
  let stopped = 0;
  ctx.inFlightDirectives.add(() => { stopped++; });
  ctx.syncExecuteButton();
  assert.ok(classes.has('is-stop'));
  assert.equal(btnAttrs['aria-label'], 'Stop');
  assert.equal(useAttrs.href, '#i-stop');
  ctx.onExecuteClick();
  assert.equal(stopped, 1, 'Stop aborts the in-flight directive');
  assert.equal(ctx.log.submits.length, 0, 'Stop does not send');
  input.value = 'next question';
  ctx.syncExecuteButton();
  assert.ok(!classes.has('is-stop'), 'typing a new directive turns it back into Execute');
  assert.equal(btnAttrs['aria-label'], 'Execute');
  ctx.onExecuteClick();
  assert.equal(ctx.log.submits.length, 1);
});

test('submitDirective wires Stop and the timeout to the same controller, and always clears it', () => {
  const src = extractFunction('submitDirective');
  assert.match(src, /const stopThis = \(reason\) => abortWith\(reason === 'interrupted' \? 'interrupted' : 'stopped'\);\s*inFlightDirectives\.add\(stopThis\);/);
  assert.match(src, /setTimeout\(\(\) => abortWith\('timeout'\), REQUEST_TIMEOUT_MS\)/);
  assert.match(src, /finally \{[\s\S]*inFlightDirectives\.delete\(stopThis\);\s*syncExecuteButton\(\);/);
  assert.match(src, /if \(abortReason === 'stopped' \|\| abortReason === 'interrupted'\) \{\s*renderStreamFailure/);
});

// --- failure and fallback ----------------------------------------------------------

test('a dropped connection keeps the partial reply and offers a retry that asks for JSON', async () => {
  const { ctx, bubble: streamBubble } = makeStreamHarness();
  const cut = FULL_STREAM.indexOf('event: step_done', FULL_STREAM.indexOf('event: text'));
  const out = await ctx.consumeDirectiveStream(chunkedResponse(FULL_STREAM.slice(0, cut), [20], { failAfter: true }), streamBubble, new AbortController().signal);
  assert.equal(out.failed, 'dropped');

  const classes = new Set(['pending']);
  const bubble = { innerHTML: '', classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  ctx.renderStreamFailure(bubble, out, 'tell me "more" <now>', null);
  assert.ok(!classes.has('pending'));
  assert.ok(!classes.has('error'), 'partial text is not shown as an error bubble');
  assert.match(bubble.innerHTML, /<div class="message-text">Héllo — world &lt;b&gt;x&lt;\/b&gt;<\/div>/);
  assert.match(bubble.innerHTML, /The connection dropped before the reply finished\./);
  assert.match(bubble.innerHTML, /<button type="button" class="retry-btn" data-prompt="tell me &quot;more&quot; &lt;now&gt;" data-fallback="1"/);
  assert.equal(ctx.log.errors[0].category, 'network');

  const btn = { disabled: false, getAttribute: (k) => ({ 'data-prompt': 'tell me "more" <now>', 'data-fallback': '1' })[k] };
  ctx.retryDirective(btn);
  assert.ok(btn.disabled);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.log.submits[0])), { retryText: 'tell me "more" <now>', noStream: true });
});

test('Stop shows a quiet note, not an error, and logs nothing', () => {
  const ctx = makeContext();
  const classes = new Set(['pending']);
  const bubble = { innerHTML: '', classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  ctx.renderStreamFailure(bubble, { failed: 'aborted', text: '', traceHtml: '' }, 'hi', 'stopped');
  assert.ok(!classes.has('error'));
  assert.match(bubble.innerHTML, /Stopped before a reply arrived\./);
  assert.equal(ctx.log.errors.length, 0);
});

test('a server error event is shown escaped, with a plain retry', () => {
  const ctx = makeContext();
  const classes = new Set(['pending']);
  const bubble = { innerHTML: '', classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  ctx.renderStreamFailure(bubble, { failed: 'error', message: 'Execution failed. <img src=x onerror=alert(1)>', text: '', traceHtml: '' }, 'hi', null);
  assert.ok(classes.has('error'));
  assert.doesNotMatch(bubble.innerHTML, /<img/);
  assert.match(bubble.innerHTML, /class="retry-btn" data-prompt="hi" onclick/, 'no JSON fallback flag for a reported error');
});

test('fallback: a non-event-stream response still goes through the original JSON path', () => {
  const src = extractFunction('submitDirective');
  assert.match(src, /const isEventStream = \/\^text\\\/event-stream\/i\.test\(response\.headers\.get\('Content-Type'\) \|\| ''\);/);
  const jsonBranch = src.slice(src.indexOf('} else {', src.indexOf('isEventStream')));
  assert.match(jsonBranch, /data = JSON\.parse\(responseText\);/);
  assert.match(jsonBranch, /Server returned non-JSON response/);
  assert.match(src, /const wantStream = !options\.noStream && !!\(sessionUser && sessionPass\);/);
  assert.match(src, /if \(wantStream\) payload\.stream = true;/);
});
