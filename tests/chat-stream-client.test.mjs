/**
 * Live progress trace in public/index.html, client side:
 *  - streamed reply text stays inert at every partial length (no XSS
 *    mid-stream), and an unclosed code fence renders as code
 *  - trace rows: escaped, keyboard-operable expanders, failed marks, no emoji
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
  'readChatStream', 'traceRowHtml', 'toggleTraceDetails', 'consumeDirectiveStream', 'syncExecuteButton',
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
  assert.match(plain, /<li class="trace-row"><div class="trace-line"><svg class="icon trace-mark" aria-hidden="true"><use href="#i-check"\/><\/svg><span class="trace-label">Loaded memory · 3 recent messages<\/span><\/div><\/li>/);
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

test('the trace markup: polite status line, rows kept out of the live log, collapse into "N steps"', () => {
  const src = extractFunction('createTraceView');
  assert.match(src, /class="trace-status" role="status" aria-live="polite"/);
  assert.match(src, /class="trace-steps"[^>]*aria-live="off"/);
  assert.match(src, /\$\{rows\} step\$\{rows === 1 \? '' : 's'\}/);
  assert.match(src, /class="trace-line trace-summary" aria-expanded="false" aria-controls="\$\{list\.id\}" onclick="toggleTraceDetails\(this\)"/);
  // Reply chunks are kept out of the log region until the final render.
  assert.match(extractFunction('consumeDirectiveStream'), /textEl\.setAttribute\('aria-live', 'off'\)/);
  // Reduced motion: the animated label becomes plain text.
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{\s*\.trace-live \{ animation: none; background: none; -webkit-text-fill-color: currentColor; \}/);
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
    finish: () => { trace.finished++; return '<div class="trace">2 steps</div>'; }
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
  assert.match(src, /const stopThis = \(\) => abortWith\('stopped'\);\s*inFlightDirectives\.add\(stopThis\);/);
  assert.match(src, /setTimeout\(\(\) => abortWith\('timeout'\), REQUEST_TIMEOUT_MS\)/);
  assert.match(src, /finally \{[\s\S]*inFlightDirectives\.delete\(stopThis\);\s*syncExecuteButton\(\);/);
  assert.match(src, /if \(abortReason === 'stopped'\) \{\s*renderStreamFailure/);
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
