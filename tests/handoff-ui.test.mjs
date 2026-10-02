/**
 * Send to Code in public/index.html: /code parsing, the hand-off card
 * markup, the clipboard path and its fallback, the drawer Hand-offs list,
 * and the operator-only gate on the client side.
 *
 * Same approach as approval-diff-render.test.mjs: the functions are pulled
 * out of the shipped HTML and run in a vm context with small stand-ins for
 * the DOM objects they touch.
 *
 * Run with: node --test tests/handoff-ui.test.mjs
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

function extractConst(name) {
  const m = html.match(new RegExp(`const ${name} = [^\\n]*;`));
  assert.ok(m, `const ${name} not found`);
  return m[0].replace(/^const /, 'var ');
}

const FUNCS = [
  'escapeHTML', 'parseCodeCommand', 'isLikelyCodeChangeRequest', 'stripSecretsClient', 'buildCodeUrl',
  'renderHandoffCardHtml', 'renderHandoffOfferHtml', 'renderHandoffListHtml', 'refreshHandoffList',
  'handleCodeCommand', 'proposeHandoff', 'writeClipboard', 'setHandoffStatus', 'codeLinkHtml',
  'showClipboardFallback', 'markHandoffSent', 'copyHandoffPrompt', 'handoffManualCopy'
];
const SOURCE = ['CODE_URL', 'CODE_URL_MAX', 'HANDOFF_STATUS_LABELS'].map(extractConst).join('\n') + '\n' + FUNCS.map(extractFunction).join('\n');

function makeContext(overrides = {}) {
  const log = { fetches: [], opened: [], haptics: 0, local: [], drafts: [], flashes: [] };
  const ctx = {
    sessionUser: 'operator', sessionPass: 'pass',
    log,
    navigator: { clipboard: { writeText: async (t) => { log.clipboard = t; } } },
    document: { execCommand: () => false, getElementById: () => null },
    window: { open: (url) => { log.opened.push(url); return {}; } },
    fetch: (url, opts) => { log.fetches.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true, status: 200, json: async () => ({}) }); },
    triggerHaptic: () => { log.haptics++; },
    appendLocalExchange: (u, r) => log.local.push([u, r]),
    startHandoffDraft: (task, userText) => log.drafts.push([task, userText]),
    flashStatus: (m) => log.flashes.push(m),
    saveState: () => {},
    ...overrides
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  // Let the functions under test see stubs set on ctx after load.
  for (const k of ['startHandoffDraft']) if (overrides[k] === undefined) vm.runInContext(`startHandoffDraft = (t, u) => log.drafts.push([t, u]);`, ctx);
  return ctx;
}

// Minimal stand-ins for the card's DOM.
function makeCard({ prompt, taskId = 'PG1-TASK-ABC234', repo = 'Project-Gifted1/pg1-ai-agent' }) {
  const calls = [];
  const status = { attrs: {}, innerHTML: '', setAttribute(k, v) { this.attrs[k] = v; } };
  const card = {
    attrs: { 'data-task-id': taskId, 'data-repo': repo },
    getAttribute(k) { return this.attrs[k]; },
    querySelector(sel) { return sel === '.handoff-prompt' ? ta : sel === '.handoff-status' ? status : null; }
  };
  const ta = {
    value: prompt, dataset: {}, selectionStart: 0, selectionEnd: 0,
    focus() { calls.push('focus'); }, select() { calls.push('select'); this.selectionEnd = this.value.length; },
    closest() { return card; }
  };
  const btn = { closest: () => card };
  return { card, ta, status, btn, calls };
}

const PROMPT = 'Task ID: PG1-TASK-ABC234\n\nTask\nAdd a toggle\n\nRepository\nProject-Gifted1/pg1-ai-agent';

// --- /code parsing & offer heuristic ---------------------------------------------

test('/code is parsed case-insensitively and only as its own command', () => {
  const { parseCodeCommand } = makeContext();
  assert.equal(parseCodeCommand('/code add a toggle'), 'add a toggle');
  assert.equal(parseCodeCommand('/CODE   multi\nline task '), 'multi\nline task');
  assert.equal(parseCodeCommand('/code'), '');
  assert.equal(parseCodeCommand('/codex add'), null);
  assert.equal(parseCodeCommand('please /code this'), null);
});

test('the hand-off offer only appears for requests that are clearly code changes', () => {
  const { isLikelyCodeChangeRequest: yes } = makeContext();
  assert.ok(yes('Fix the bug in api/errors.mjs where resolved rows come back'));
  assert.ok(yes('Add a refresh button to the drawer'));
  assert.ok(yes('please rename the handler in chat.mjs'));
  assert.ok(!yes('What does the error log endpoint do?'));
  assert.ok(!yes('How do I add a test?'));
  assert.ok(!yes('/status'));
  assert.ok(!yes('check wallet 0xabc for sanctions'));
  assert.ok(!yes('add milk to the shopping list'));
});

test('submitDirective handles /code locally before any network call, and offers hand-offs to the operator only', () => {
  const src = extractFunction('submitDirective');
  const codeIdx = src.indexOf('parseCodeCommand(text)');
  assert.ok(codeIdx !== -1 && codeIdx < src.indexOf("fetch('/api/chat'"), '/code never reaches /api/chat');
  assert.match(src, /!data\.pendingApproval && !isSuggestFixRequest && sessionUser && sessionPass && isLikelyCodeChangeRequest\(text\)/);
});

// --- card rendering -----------------------------------------------------------------

test('the card shows an editable, escaped prompt and the two PG1-branded buttons', () => {
  const { renderHandoffCardHtml } = makeContext();
  const out = renderHandoffCardHtml({ taskId: 'PG1-TASK-ABC234', repo: 'Project-Gifted1/pg1-ai-agent', prompt: 'Task <script>alert(1)</script> & "q"', removed: [] });
  assert.match(out, /<span class="handoff-title">Send to Code<\/span>/);
  assert.match(out, /<span class="handoff-id">PG1-TASK-ABC234<\/span>/);
  assert.match(out, /<textarea class="handoff-prompt" id="handoff-prompt-PG1-TASK-ABC234"[^>]*>Task &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;q&quot;<\/textarea>/);
  assert.match(out, /<label class="sr-only" for="handoff-prompt-PG1-TASK-ABC234">/);
  assert.match(out, /class="handoff-btn is-primary" onclick="copyHandoffPrompt\(this, true\)"><svg class="icon" aria-hidden="true"><use href="#i-external"\/><\/svg>Copy and open Code<\/button>/);
  assert.match(out, /class="handoff-btn" onclick="copyHandoffPrompt\(this, false\)"><svg class="icon" aria-hidden="true"><use href="#i-copy"\/><\/svg>Copy only<\/button>/);
  assert.match(out, /class="handoff-status" role="status" aria-live="polite"/);
  assert.doesNotMatch(out, /<script>/);
  assert.doesNotMatch(out, /<img|\.png|\.svg"|logo/i, 'no third-party logos');
  assert.doesNotMatch(out, /\p{Extended_Pictographic}/u, 'no emoji');
  assert.doesNotMatch(out, /approval-btn|resolveApproval|CONFIRM_PENDING_ACTION/, 'not routed through Approve');
  assert.doesNotMatch(out, /handoff-warn/, 'no warning when nothing was removed');
});

test('the card tells the operator when something that looked like a secret was removed', () => {
  const { renderHandoffCardHtml } = makeContext();
  const out = renderHandoffCardHtml({ taskId: 'PG1-TASK-ABC234', repo: 'r', prompt: 'p', removed: ['API key', 'password or passkey'] });
  assert.match(out, /<p class="handoff-warn" role="note"><svg class="icon" aria-hidden="true"><use href="#i-alert"\/><\/svg><span>Removed before drafting: API key, password or passkey\./);
});

test('the offer row carries the original text safely in an attribute', () => {
  const { renderHandoffOfferHtml } = makeContext();
  const out = renderHandoffOfferHtml('fix "x" <b> in a.js');
  assert.match(out, /data-task="fix &quot;x&quot; &lt;b&gt; in a\.js"/);
  assert.match(out, /onclick="proposeHandoff\(this\)">Draft hand-off<\/button>/);
});

test('new icons are line icons in the shared sprite', () => {
  assert.match(html, /<symbol id="i-code" viewBox="0 0 24 24"><path [^>]*\/>/);
  assert.match(html, /<symbol id="i-external" viewBox="0 0 24 24"><path [^>]*\/>/);
});

// --- Code URL ---------------------------------------------------------------------

test('Code opens with the documented prompt and repositories parameters', () => {
  const { buildCodeUrl } = makeContext();
  assert.equal(buildCodeUrl('Fix it & ship', 'Project-Gifted1/pg1-ai-agent'),
    'https://claude.ai/code?prompt=Fix%20it%20%26%20ship&repositories=Project-Gifted1%2Fpg1-ai-agent');
  const long = buildCodeUrl('x'.repeat(9000), 'Project-Gifted1/pg1-ai-agent');
  assert.equal(long, 'https://claude.ai/code?repositories=Project-Gifted1%2Fpg1-ai-agent', 'too long: prompt stays on the clipboard only');
});

// --- clipboard ---------------------------------------------------------------------

test('Copy and open Code: copies first, then opens Code with the prompt, and marks the hand-off sent', async () => {
  const ctx = makeContext();
  const { btn, status } = makeCard({ prompt: PROMPT });
  await ctx.copyHandoffPrompt(btn, true);
  assert.equal(ctx.log.clipboard, PROMPT);
  assert.equal(ctx.log.opened.length, 1);
  assert.ok(ctx.log.opened[0].startsWith('https://claude.ai/code?prompt=Task%20ID%3A%20PG1-TASK-ABC234'));
  assert.ok(ctx.log.opened[0].endsWith('&repositories=Project-Gifted1%2Fpg1-ai-agent'));
  assert.equal(status.attrs['data-tone'], 'ok');
  assert.match(status.innerHTML, /Copied, and Code opened in a new tab/);
  assert.equal(ctx.log.fetches.length, 1);
  assert.deepEqual(ctx.log.fetches[0].body, { op: 'sent', taskId: 'PG1-TASK-ABC234', prompt: PROMPT, user: 'operator', pass: 'pass' });
});

test('Copy only copies and does not open anything', async () => {
  const ctx = makeContext();
  const { btn, status } = makeCard({ prompt: PROMPT });
  await ctx.copyHandoffPrompt(btn, false);
  assert.equal(ctx.log.clipboard, PROMPT);
  assert.equal(ctx.log.opened.length, 0);
  assert.match(status.innerHTML, /^<span>Copied to clipboard\. <\/span>$/);
});

test('clipboard blocked: the whole prompt is selected for a manual copy, nothing opens, nothing is marked sent', async () => {
  const ctx = makeContext({
    navigator: { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } },
    document: { execCommand: () => false, getElementById: () => null }
  });
  const { btn, status, calls, ta } = makeCard({ prompt: PROMPT });
  await ctx.copyHandoffPrompt(btn, true);
  assert.deepEqual(calls.slice(-2), ['focus', 'select']);
  assert.equal(ta.selectionEnd, PROMPT.length);
  assert.equal(status.attrs['data-tone'], 'warn');
  assert.match(status.innerHTML, /Clipboard access is blocked here\. The whole prompt is selected/);
  assert.match(status.innerHTML, /<a class="md-link" href="https:\/\/claude\.ai\/code\?prompt=[^"]+" target="_blank" rel="noopener noreferrer"[^>]*>Then open Code/);
  assert.equal(ctx.log.opened.length, 0);
  assert.equal(ctx.log.fetches.length, 0);
  assert.equal(ta.dataset.programmaticCopy, undefined, 'flag is cleared afterwards');
});

test('no Clipboard API: the legacy copy command is used when it works', async () => {
  const ctx = makeContext({ navigator: {}, document: { execCommand: (c) => c === 'copy', getElementById: () => null } });
  const { btn, status } = makeCard({ prompt: PROMPT });
  await ctx.copyHandoffPrompt(btn, false);
  assert.equal(status.attrs['data-tone'], 'ok');
  assert.equal(ctx.log.fetches.length, 1);
});

test('a blocked new tab still leaves an Open Code link', async () => {
  const ctx = makeContext({ window: { open: () => null } });
  const { btn, status } = makeCard({ prompt: PROMPT });
  await ctx.copyHandoffPrompt(btn, true);
  assert.match(status.innerHTML, /Your browser blocked the new tab/);
  assert.match(status.innerHTML, />Open Code<svg/);
});

test('secrets typed into the card are stripped before copying, and the operator is told', async () => {
  const ctx = makeContext();
  const { btn, status, ta } = makeCard({ prompt: PROMPT + '\nkey: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' });
  await ctx.copyHandoffPrompt(btn, false);
  assert.doesNotMatch(ctx.log.clipboard, /sk-ant/);
  assert.doesNotMatch(ta.value, /sk-ant/);
  assert.equal(status.attrs['data-tone'], 'warn');
  assert.match(status.innerHTML, /Removed before copying: API key\./);
});

test('removing the task ID line warns that the PR cannot be tracked', async () => {
  const ctx = makeContext();
  const { btn, status } = makeCard({ prompt: 'Task\nAdd a toggle' });
  await ctx.copyHandoffPrompt(btn, false);
  assert.match(status.innerHTML, /The task ID PG1-TASK-ABC234 is no longer in the prompt/);
});

test('a manual copy after the fallback is stripped too, and marks the hand-off sent', () => {
  const ctx = makeContext();
  const { ta, status } = makeCard({ prompt: PROMPT + '\nAuthorization: Bearer abcdefghijklmnop0123456789' });
  ta.selectionStart = 0; ta.selectionEnd = ta.value.length;
  let prevented = false; let data = null;
  ctx.handoffManualCopy(ta, { preventDefault() { prevented = true; }, clipboardData: { setData(_t, v) { data = v; } } });
  assert.ok(prevented);
  assert.match(data, /Bearer \[removed\]/);
  assert.match(status.innerHTML, /Removed before copying: bearer token/);
  assert.equal(ctx.log.fetches.length, 1);
  assert.doesNotMatch(ctx.log.fetches[0].body.prompt, /abcdefghijklmnop0123456789/);
});

// --- drawer list --------------------------------------------------------------------

test('the drawer lists hand-offs with status and a GitHub link only for real PR URLs', () => {
  const { renderHandoffListHtml } = makeContext();
  const out = renderHandoffListHtml([
    { task_id: 'PG1-TASK-AAAAAA', task: 'add <b>x</b>', status: 'pr_open', pr_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/8' },
    { task_id: 'PG1-TASK-BBBBBB', task: 'y', status: 'merged', pr_url: 'javascript:alert(1)' },
    { task_id: 'PG1-TASK-CCCCCC', task: 'z', status: 'drafted', pr_url: null }
  ]);
  assert.match(out, /<span class="handoff-pill" data-status="pr_open">PR open<\/span>/);
  assert.match(out, /<span class="handoff-pill" data-status="merged">Merged<\/span>/);
  assert.match(out, /<span class="handoff-pill" data-status="drafted">Drafted<\/span>/);
  assert.match(out, /<a class="handoff-pr-link" href="https:\/\/github\.com\/Project-Gifted1\/pg1-ai-agent\/pull\/8" target="_blank" rel="noopener noreferrer">View PR on GitHub/);
  assert.equal((out.match(/handoff-pr-link/g) || []).length, 1);
  assert.doesNotMatch(out, /javascript:|<b>/);
  assert.doesNotMatch(out, /approval-btn|resolveApproval/);
  assert.match(renderHandoffListHtml([]), /No hand-offs yet/);
});

test('the drawer has a Hand-offs section that refreshes when the drawer opens', () => {
  assert.match(html, /<span class="drawer-label" id="handoffs-label">Hand-offs<\/span>\s*<div id="handoff-list" class="handoff-list" aria-live="polite">/);
  assert.match(extractFunction('openDrawer'), /refreshHandoffList\(\);/);
});

// --- operator only ------------------------------------------------------------------

test('signed out: /code drafts nothing and asks the operator to sign in', () => {
  const input = { value: '/code x', style: {} };
  const ctx = makeContext({ sessionUser: '', sessionPass: '', document: { getElementById: () => input, execCommand: () => false } });
  ctx.handleCodeCommand('/code add a toggle', 'add a toggle');
  assert.equal(ctx.log.drafts.length, 0);
  assert.equal(ctx.log.fetches.length, 0);
  assert.match(ctx.log.local[0][1], /for the signed-in operator\. Sign in first/);
  assert.equal(input.value, '');
});

test('signed in: /code drafts; bare /code shows usage', () => {
  const input = { value: '', style: {} };
  const ctx = makeContext({ document: { getElementById: () => input, execCommand: () => false } });
  ctx.handleCodeCommand('/code add a toggle', 'add a toggle');
  assert.equal(JSON.stringify(ctx.log.drafts), JSON.stringify([['add a toggle', '/code add a toggle']]));
  ctx.handleCodeCommand('/code', '');
  assert.match(ctx.log.local[0][1], /^Usage: \*\*\/code\*\* plus a task/);
});

test('signed out: the offer button and the drawer list do nothing over the network', async () => {
  const list = { innerHTML: '' };
  const ctx = makeContext({ sessionUser: '', sessionPass: '', document: { getElementById: (id) => (id === 'handoff-list' ? list : null), execCommand: () => false } });
  const offer = { getAttribute: () => 'fix the bug', remove() { this.removed = true; } };
  ctx.proposeHandoff({ closest: () => offer });
  assert.equal(ctx.log.drafts.length, 0);
  assert.ok(!offer.removed);
  assert.deepEqual(ctx.log.flashes, ['Sign in to use Send to Code']);
  await ctx.refreshHandoffList();
  assert.match(list.innerHTML, /Sign in to see hand-offs/);
  assert.equal(ctx.log.fetches.length, 0);
});

test('signed out: copying never reports a sent hand-off to the server', async () => {
  const ctx = makeContext({ sessionUser: '', sessionPass: '' });
  const { btn } = makeCard({ prompt: PROMPT });
  await ctx.copyHandoffPrompt(btn, false);
  assert.equal(ctx.log.fetches.length, 0);
});
