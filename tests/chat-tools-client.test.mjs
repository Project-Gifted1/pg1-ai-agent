/**
 * The result card under a reply that ran a check (public/index.html,
 * toolCardHtml / toolCardsHtml / copyToolRaw), rendered from the card data
 * lib/chatTools.mjs builds for a real fixture outcome:
 *  - tool name in plain words, the address shortened in the title (first 6,
 *    last 4) and shown in full in the Raw JSON expander
 *  - a status chip with the word on it (Flagged / No flags / Unknown /
 *    Failed), key fields, reasons, checks with data_as_of, request_id,
 *    duration, the fixture marker
 *  - the Raw JSON expander is collapsed, keyboard-operable (aria-expanded /
 *    aria-controls like the trace rows) and has a copy button
 *  - every string is escaped; no emoji; the card CSS lives outside the trace
 *    block and uses only design tokens
 *  - the consumeDirectiveStream path collects tool_result events into the
 *    outcome, and a JSON reply's toolResults render the same way
 *
 * Run with: node --test tests/chat-tools-client.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { createDocument } from './helpers/mini-dom.mjs';
import { createToolExecutor, summarizeOutcome } from '../lib/chatTools.mjs';
import { FIXTURE_VALUES } from '../lib/fixtures.mjs';

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

const FUNCS = ['escapeHTML', 'formatStepDuration', 'toggleTraceDetails', 'toolStatusLabel', 'toolDateText', 'checkCardStatus', 'checkRowTone', 'checkRawObject', 'checkSignature', 'toolCardHtml', 'toolCardsHtml', 'copyToolRaw', 'copyLabText',
  'formatMarkdown', 'renderDiffBlock', 'formatStreamingMarkdown', 'parseSseBuffer', 'parseTraceEvent', 'readChatStream', 'stepDurationMs', 'traceRowHtml', 'traceRunningRowHtml', 'stepCountText', 'agentTimestampHtml', 'createTraceView', 'consumeDirectiveStream'];
const SOURCE = [
  html.match(/const TRACE_EVENT_TYPES = [^\n]*;/)[0].replace(/^const/, 'var'),
  html.match(/const TOOL_STATUS_CLASS = [^\n]*;/)[0].replace(/^const/, 'var'),
  html.match(/const CHECK_STATUS_VIEW = \{[\s\S]*?\n    \};/)[0].replace(/^const/, 'var'),
  'var toolCardSeq = 0;',
  'var traceSeq = 0;',
  ...FUNCS.map(extractFunction)
].join('\n');

function makeContext(doc) {
  const clipboard = [];
  const ctx = {
    TextDecoder,
    setTimeout,
    window: {},
    document: doc,
    navigator: { onLine: true, clipboard: { writeText: (t) => { clipboard.push(t); return Promise.resolve(); } } },
    clipboard
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  return ctx;
}

const WALLET = FIXTURE_VALUES.wallet;
const DOMAIN = FIXTURE_VALUES.domain;
const execute = createToolExecutor({ role: 'operator', log: () => {} });

async function card(name, args) {
  return summarizeOutcome(await execute({ id: 'c', name, args }));
}

test('a flagged wallet card (Living lab style): the shortened target with copy, the large status badge, fields, reason chips, check rows, request_id, signed state, the actions, raw JSON with the full address', async () => {
  const doc = createDocument();
  const ctx = makeContext(doc);
  const data = await card('check_wallet_sanctions', { address: WALLET.FLAGGED });
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  el.innerHTML = ctx.toolCardsHtml([data]);
  const section = el.querySelector('.tool-card');
  assert.ok(section, 'a card');
  assert.ok(section.classList.contains('is-flagged'));
  assert.ok(section.classList.contains('lx-card'), 'built from the shared lab components');
  assert.equal(section.getAttribute('data-tone'), 'err');
  assert.equal(section.getAttribute('aria-label'), 'Wallet sanctions result');
  assert.equal(section.querySelector('.tool-card-title').textContent, 'Wallet sanctions');
  const target = section.querySelector('.tool-card-subject');
  assert.equal(target.textContent, '0x7067…0001', 'the target, shortened');
  assert.equal(target.getAttribute('title'), WALLET.FLAGGED, 'the full value is there for hover and screen readers');
  assert.equal(section.querySelector('.chk-target .lx-copy').getAttribute('data-copy'), WALLET.FLAGGED, 'Copy copies the full target');
  const badge = section.querySelector('.chk-status');
  assert.equal(badge.textContent, 'Flagged');
  assert.ok(badge.classList.contains('is-lg'), 'a large status badge');
  assert.match(section.querySelector('.tool-fixture').textContent, /Test fixture/);
  const fields = Array.from(section.querySelectorAll('.tool-field')).map((f) => [f.querySelector('dt').textContent, f.querySelector('dd').textContent]);
  assert.deepEqual(fields.slice(0, 2), [['Listed', 'yes'], ['Matches', '1']]);
  const reasons = Array.from(section.querySelectorAll('.tool-reasons li'));
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].querySelector('.lx-row-main').textContent, 'Address matches an entry on the sanctions list.');
  const chip = reasons[0].querySelector('a.lx-chip');
  assert.equal(chip.getAttribute('href'), '/docs/reason-codes#WALLET_SANCTIONED', 'the reason-code chip links to its documentation');
  assert.equal(chip.textContent, 'WALLET_SANCTIONED');
  const checks = Array.from(section.querySelectorAll('.tool-checks li'));
  assert.equal(checks.length, 1);
  assert.ok(checks[0].querySelector('.lx-dot'), 'each check has its own status dot');
  assert.match(checks[0].textContent, /fixture.*ok.*data as of \d{4}-\d{2}-\d{2}/);
  const meta = section.querySelector('.tool-meta').textContent;
  assert.ok(meta.includes(`request_id ${data.request_id}`));
  assert.ok(section.querySelector(`.tool-meta .lx-copy[data-copy="${data.request_id}"]`), 'request_id has a copy button');
  assert.equal(section.querySelector('.chk-signed').textContent, 'Unsigned', 'a chat check carries no signature');
  assert.deepEqual(Array.from(section.querySelectorAll('.chk-actions button')).map((b) => b.textContent), ['Verify', 'Run preflight', 'Re-check']);
  // The expander: collapsed, wired like the trace rows, full address inside, copy button.
  const toggle = section.querySelector('.tool-raw-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.match(toggle.textContent, /^Raw JSON/);
  const raw = doc.getElementById(toggle.getAttribute('aria-controls'));
  assert.ok(raw && raw.hidden, 'raw JSON hidden until asked');
  assert.equal(raw.querySelector('.tool-raw-full').textContent, WALLET.FLAGGED, 'the full address in the expander');
  assert.ok(raw.querySelector('.tool-raw-json').textContent.includes(WALLET.FLAGGED), 'the full JSON result in the expander');
  assert.ok(raw.querySelector('.tool-raw-json').classList.contains('lx-mono'), 'a monospace block');
  ctx.toggleTraceDetails(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(raw.hidden, false);
  ctx.copyToolRaw(raw.querySelector('.tool-copy'));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(ctx.clipboard[0].includes(WALLET.FLAGGED) && ctx.clipboard[0].includes('WALLET_SANCTIONED'), 'copy puts the raw JSON on the clipboard');
  assert.equal(raw.querySelector('.tool-copy-text').textContent, 'Copied');
  assert.doesNotMatch(el.innerHTML, /\p{Extended_Pictographic}/u, 'no emoji');
});

test('several checks are a stacked list: "No flags found", "Unknown", "Upstream unavailable"; never the word safe', async () => {
  const doc = createDocument();
  const ctx = makeContext(doc);
  const el = doc.createElement('div');
  el.innerHTML = ctx.toolCardsHtml([
    await card('check_domain_age', { domain: DOMAIN.CLEAN }),
    await card('check_domain_age', { domain: DOMAIN.UNKNOWN }),
    await card('check_wallet_age', { address: WALLET.UNKNOWN })
  ]);
  const items = el.querySelectorAll('.chk-stack .chk-item');
  assert.equal(items.length, 3, 'a compact stacked list');
  assert.deepEqual(Array.from(items).map((i) => i.getAttribute('data-status')), ['no_flags', 'unknown', 'upstream_unavailable']);
  const cards = el.querySelectorAll('.tool-card');
  assert.equal(cards.length, 3, 'each item opens to its full card');
  assert.equal(cards[0].querySelector('.chk-status').textContent, 'No flags found');
  assert.ok(cards[0].classList.contains('is-clear'));
  assert.equal(cards[0].getAttribute('data-tone'), 'ok');
  assert.match(cards[0].querySelector('.tool-note').textContent, /not a guarantee/);
  assert.equal(cards[1].querySelector('.chk-status').textContent, 'Unknown');
  assert.ok(Array.from(cards[1].querySelectorAll('.tool-field')).some((f) => f.querySelector('dt').textContent === 'Reason' && /^timeout/.test(f.querySelector('dd').textContent)));
  assert.equal(cards[2].querySelector('.chk-status').textContent, 'Upstream unavailable', 'a source that did not answer');
  assert.match(cards[2].querySelector('.tool-error').textContent, /timed out/);
  assert.ok(cards[2].querySelector('.tool-meta').textContent.includes('request_id'));
  assert.ok(cards[2].querySelector('.tool-checks li').classList.contains('is-incomplete'));
  assert.doesNotMatch(el.innerHTML, /\bsafe\b/i, 'no card ever says safe');
});

test('everything in a card is escaped, and a malformed card is skipped', () => {
  const doc = createDocument();
  const ctx = makeContext(doc);
  const el = doc.createElement('div');
  const hostile = '<img src=x onerror="alert(1)">';
  el.innerHTML = ctx.toolCardsHtml([
    { tool: 'check_domain_age', title: 'Domain age', subject: hostile, subject_short: hostile, status: 'flagged', fields: [{ label: hostile, value: hostile }], reasons: [{ code: hostile, message: hostile }], checks: [{ source: hostile, result: 'ok', data_as_of: hostile }], request_id: hostile, error: { code: 'x', message: hostile }, raw: hostile, input: { domain: hostile } },
    null, 'nope', { title: 'no tool name' }
  ]);
  assert.equal(el.querySelectorAll('.tool-card').length, 1);
  assert.ok(!el.innerHTML.includes('<img'), 'no tag survives');
  assert.ok(el.innerHTML.includes('&lt;img src=x'), 'shown as text');
  assert.equal(ctx.toolCardsHtml([]), '');
  assert.equal(ctx.toolCardsHtml(undefined), '');
});

test('consumeDirectiveStream collects tool_result events into the outcome, in order, and the done event carries the spoken summary', async () => {
  const doc = createDocument();
  const ctx = makeContext(doc);
  const bubble = doc.createElement('div');
  bubble.className = 'message-bubble pending';
  bubble.innerHTML = '<span class="msg-timestamp">now</span><div class="message-text pending-text">…</div>';
  doc.body.appendChild(bubble);
  const chat = doc.createElement('main');
  chat.id = 'chat-container';
  doc.body.appendChild(chat);
  const data = await card('check_wallet_age', { address: WALLET.CLEAN });
  const events = [
    { type: 'step', id: 'tool-1', label: 'Checking wallet age · 0x7067…0002' },
    { type: 'step_done', id: 'tool-1', label: 'Checked wallet age · 0x7067…0002', result: 'no flags', ms: 412 },
    { type: 'tool_result', ...data },
    { type: 'text', text: 'Active since 2023.' },
    { type: 'done', request_id: 'req1', spokenSummary: 'Wallet age for the wallet: no flags.' }
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const response = { body: null, text: async () => body };
  const outcome = await ctx.consumeDirectiveStream(response, bubble, null, null);
  assert.equal(outcome.toolResults.length, 1);
  assert.equal(outcome.toolResults[0].tool, 'check_wallet_age');
  assert.equal(outcome.data.toolResults.length, 1);
  assert.equal(outcome.data.spokenSummary, 'Wallet age for the wallet: no flags.');
  assert.equal(outcome.data.reply, 'Active since 2023.');
  assert.match(outcome.traceHtml, /Checked wallet age · 0x7067…0002/);
  assert.match(outcome.traceHtml, /0\.4s/, 'the server duration on the row');
});

test('card styling: tokens only, chips carry the word, the trace block is untouched, and the reply render includes the cards', () => {
  const css = html.slice(html.indexOf('/* CHAT TOOLS: one compact result card'), html.indexOf('/* failed directive / interrupted request */'));
  assert.match(css, /\.tool-card \{[^}]*background: var\(--surface-1\);[^}]*border: 1px solid var\(--border\);/);
  assert.match(css, /\.tool-chip\.is-flagged, \.tool-chip\.is-failed \{ color: var\(--danger-text\);/);
  assert.match(css, /\.tool-chip\.is-clear \{ color: var\(--ok\);/);
  assert.match(css, /\.tool-chip\.is-unknown \{ color: var\(--warn-text\);/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'no raw colours: light and dark come from the tokens');
  assert.doesNotMatch(css, /\p{Extended_Pictographic}/u);
  const trace = html.slice(html.indexOf('/* live trace:'), html.indexOf('.stream-note {'));
  assert.doesNotMatch(trace, /tool-card/, 'the trace block is unchanged');
  assert.match(extractFunction('submitDirective'), /\$\{toolCardsHtml\(data\.toolResults\)\}/, 'cards render under the reply text');
  assert.match(extractFunction('renderStreamFailure'), /toolCardsHtml\(streamed\.toolResults\)/, 'and under a partial reply');
  assert.match(extractFunction('submitDirective'), /speakMessage\(data\.spokenSummary \|\| data\.reply, agentBubble\)/, 'the one-shot voice path speaks the summary');
});
