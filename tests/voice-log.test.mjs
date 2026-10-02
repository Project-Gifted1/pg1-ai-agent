/**
 * Voice log (public/voice/conversation.js, wired up in public/index.html):
 *  - the conversation keeps its last 200 events in memory: recogniser
 *    events, state changes, status changes, each with the diagnostics
 *    snapshot at that moment; a repeat with nothing changed is kept once
 *  - formatVoiceLog(): one line per event, oldest first, the last 30 by
 *    default, with the clock time, event, state, mic mode, recogniser,
 *    error, and what was heard (40 characters) when there was one
 *  - the page: "Copy voice log" and "Send to PG1" sit under the Voice
 *    diagnostics switch; Send to PG1 puts "Diagnose this voice log" and the
 *    log in a text fence into the prompt box and sends nothing itself; with
 *    no events it says so instead; nothing about the log is ever stored
 *
 * Run with: node --test tests/voice-log.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { createDocument } from './helpers/mini-dom.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const moduleSrc = readFileSync(join(ROOT, 'public/voice/conversation.js'), 'utf-8');
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf-8');

function loadModule() {
  const ctx = { setTimeout, clearTimeout, Promise, BigInt, BigInt64Array, Float32Array, Uint16Array, Number, Math, Date };
  vm.createContext(ctx);
  vm.runInContext(moduleSrc, ctx);
  return ctx.PG1Voice;
}
const V = loadModule();
const plain = (v) => JSON.parse(JSON.stringify(v));

// A conversation on fakes: a recogniser the test speaks through, a mic that
// opens, a clock the test moves. Same shape as tests/voice-conversation.test.mjs.
function fixture() {
  let t = 1_700_000_000_000;
  const timers = [];
  const recognisers = [];
  const log = { states: [], errors: [], sent: [] };
  class FakeRecognition {
    constructor() { this.running = false; recognisers.push(this); }
    start() { this.running = true; if (this.onstart) this.onstart(); }
    stop() { this.running = false; if (this.onend) this.onend(); }
    abort() { this.running = false; if (this.onend) this.onend(); }
    hear(text, isFinal) {
      const alt = [{ transcript: text, confidence: 0.9 }];
      alt.isFinal = !!isFinal;
      this.onresult({ resultIndex: 0, results: [alt] });
    }
  }
  const conv = V.createConversation({
    now: () => t,
    setTimeout: (fn, ms) => { const id = { fn, at: t + ms }; timers.push(id); return id; },
    clearTimeout: (id) => { const i = timers.indexOf(id); if (i !== -1) timers.splice(i, 1); },
    createRecognition: () => new FakeRecognition(),
    openMic: async () => ({ onFrame: () => {}, sampleRate: 16000, stream: { getTracks: () => [] }, close: async () => {} }),
    loadVad: async () => V.createEnergyVad(),
    isPlaying: () => false,
    isBusy: () => false,
    stopPlayback() {},
    abortRequests() {},
    send: (text) => log.sent.push(text),
    onState: (s, d) => log.states.push(s + (d ? '/' + d : '')),
    onError: (m) => log.errors.push(m)
  }, { micMode: 'exclusive' });
  const advance = (ms) => {
    const until = t + ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      t = due.at;
      due.fn();
    }
    t = until;
  };
  return { conv, log, advance, recognisers, get now() { return t; } };
}

// --- the module ----------------------------------------------------------------------

test('createEventLog keeps the last N entries, stamps them, and folds a repeat with nothing changed', () => {
  let t = 1000;
  const logA = V.createEventLog(3, () => t);
  logA.add({ event: 'a', state: 'listening' });
  t = 1001;
  logA.add({ event: 'a', state: 'listening' });
  assert.equal(logA.size, 1, 'the same event with the same snapshot is kept once');
  logA.add({ event: 'a', state: 'thinking' });
  assert.equal(logA.size, 2, 'the same event with a changed field is a new entry');
  logA.add({ event: 'b' });
  logA.add({ event: 'c' });
  assert.equal(logA.size, 3, 'capped at N');
  assert.deepEqual(plain(logA.entries.map((e) => e.event)), ['a', 'b', 'c'], 'the oldest entry went');
  assert.equal(logA.entries[0].at, 1001);
  logA.add(null);
  logA.add({ state: 'off' });
  assert.equal(logA.size, 3, 'an entry without an event is ignored');
  logA.clear();
  assert.equal(logA.size, 0);
  logA.add({ event: 'z' });
  logA.entries.push({ event: 'not really' });
  assert.equal(logA.size, 1, 'entries is a copy');
});

test('a conversation records recogniser events, state changes and status changes with the snapshot at that moment', async () => {
  const f = fixture();
  await f.conv.start();
  const r = f.recognisers[f.recognisers.length - 1];
  r.hear('what is the threat', false);
  r.hear('what is the threat level', true);
  f.advance(V.DEFAULTS.exclusiveTurnEndMs || 1500);
  const events = f.conv.eventLog.entries.map((e) => e.event);
  assert.ok(events.includes('state:listening/started'), `state changes are logged with their detail (${events})`);
  assert.ok(events.includes('started'), 'the recogniser start is logged');
  assert.ok(events.includes('result'), 'a recogniser result is logged');
  const result = f.conv.eventLog.entries.find((e) => e.event === 'result');
  assert.equal(result.state, 'listening');
  assert.equal(result.mode, 'exclusive');
  assert.equal(result.recogniser, 'running');
  assert.equal(result.lastError, '');
  assert.equal(result.raw, 'what is the threat', 'what was heard, as the recogniser gave it');
  assert.equal(typeof result.at, 'number');
  await f.conv.stop('tap');
  const after = f.conv.eventLog.entries.map((e) => e.event);
  assert.ok(after.includes('state:off/tap'), `stopping is logged (${after})`);
  // Diagnostics for the page are unchanged: lastEvent is still the recogniser's.
  assert.doesNotMatch(f.conv.diagnostics.lastEvent, /^state:/, 'state changes never become the diagnostics line\'s last event');
});

test('an error session is logged with its code', async () => {
  const f = fixture();
  await f.conv.start();
  const r = f.recognisers[f.recognisers.length - 1];
  r.onerror({ error: 'network', message: 'Network error' });
  const entry = f.conv.eventLog.entries.find((e) => e.event === 'error:network');
  assert.ok(entry, 'the error event is logged');
  assert.equal(entry.lastError, 'network');
});

test('formatVoiceLog: one line per entry, the last 30 by default, oldest first, nothing beyond the fields', () => {
  const entries = [];
  for (let i = 0; i < 45; i++) {
    entries.push({ at: Date.UTC(2026, 9, 2, 12, 3, 45, 120) + i * 1000, event: 'result', state: 'listening', mode: 'shared', recogniser: 'running', lastError: '', status: '', micOpen: true, raw: i === 44 ? 'what is the threat level today, and what else is happening' : '' });
  }
  const text = V.formatVoiceLog(entries);
  const lines = text.split('\n');
  assert.equal(lines.length, 30, 'the last 30 entries');
  assert.equal(lines[0], '12:04:00.120 result | listening | shared mic | rec running | err none', 'entry 15 comes first');
  assert.equal(lines[29], '12:04:29.120 result | listening | shared mic | rec running | err none | heard "what is the threat level today, and what"', 'the heard text is capped at 40 characters');
  assert.equal(V.formatVoiceLog(entries, { limit: 2 }).split('\n').length, 2);
  assert.equal(V.formatVoiceLog([]), '');
  assert.equal(V.formatVoiceLog(null), '');
  const withStatus = V.formatVoiceLog([{ at: 0, event: 'status', state: 'listening', mode: 'exclusive', recogniser: 'stopped', lastError: 'audio-capture', status: 'Microphone is busy in another app.', micOpen: false }]);
  assert.equal(withStatus, '00:00:00.000 status | listening | exclusive mic | rec stopped | err audio-capture | status "Microphone is busy in another app."');
});

// --- the page ----------------------------------------------------------------------

function extract(name) {
  let start = html.indexOf(`async function ${name}(`);
  if (start === -1) start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found in public/index.html`);
  let depth = 0;
  let i = html.indexOf('{', html.indexOf(')', start));
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

function pageContext(entries, { clipboard = true } = {}) {
  const doc = createDocument();
  doc.body.innerHTML = '<textarea id="prompt-input"></textarea><div id="status-toast" class="toast"></div><aside id="app-drawer"></aside>';
  const calls = { copied: [], toasts: [], resized: 0, synced: 0, closedDrawer: 0, focused: 0, fetches: 0 };
  const input = doc.getElementById('prompt-input');
  input.value = '';
  input.focus = () => { calls.focused++; };
  input.setSelectionRange = () => {};
  const ctx = {
    document: doc,
    PG1Voice: V,
    conversation: entries === null ? null : { eventLog: { get entries() { return entries; } } },
    navigator: { clipboard: clipboard ? { writeText: async (t) => { calls.copied.push(t); } } : undefined },
    autoResize: () => { calls.resized++; },
    syncExecuteButton: () => { calls.synced++; },
    closeDrawer: () => { calls.closedDrawer++; },
    flashStatus: (msg, isError) => { calls.toasts.push({ msg, isError }); },
    fetch: async () => { calls.fetches++; throw new Error('no network in this test'); },
    console
  };
  vm.createContext(ctx);
  const src = [
    html.match(/const VOICE_LOG_SEND_LIMIT = \d+;/)[0],
    html.match(/const VOICE_LOG_PROMPT = '[^']+';/)[0],
    extract('voiceLogEntries'), extract('voiceLogText'), extract('voiceLogMessage'), extract('copyVoiceLog'), extract('sendVoiceLogToPG1')
  ].join('\n');
  vm.runInContext(src, ctx);
  return { ctx, doc, input, calls };
}

const sampleEntries = (n) => Array.from({ length: n }, (_, i) => ({ at: Date.UTC(2026, 9, 2, 9, 0, i), event: i % 2 ? 'result' : 'soundstart', state: 'listening', mode: 'shared', recogniser: 'running', lastError: '', status: '', micOpen: true, raw: i % 2 ? 'hey pg1' : '' }));

test('Send to PG1 puts "Diagnose this voice log" and the last 30 events in a text fence into the prompt box, and sends nothing', () => {
  const { ctx, input, calls } = pageContext(sampleEntries(40));
  ctx.sendVoiceLogToPG1();
  const value = input.value;
  assert.ok(value.startsWith('Diagnose this voice log\n\n```text\n'), `fixed first line and fence: ${JSON.stringify(value.slice(0, 40))}`);
  assert.ok(value.endsWith('\n```'), 'the fence is closed');
  const body = value.slice('Diagnose this voice log\n\n```text\n'.length, -'\n```'.length);
  const lines = body.split('\n');
  assert.equal(lines.length, 30, 'the last 30 events');
  assert.equal(lines[0], '09:00:10.000 soundstart | listening | shared mic | rec running | err none');
  assert.equal(lines[29], '09:00:39.000 result | listening | shared mic | rec running | err none | heard "hey pg1"');
  assert.equal(body, V.formatVoiceLog(sampleEntries(40)), 'the same text Copy voice log copies');
  assert.equal(calls.fetches, 0, 'nothing was sent');
  assert.equal(calls.resized, 1, 'the composer grew to fit');
  assert.equal(calls.synced, 1);
  assert.equal(calls.closedDrawer, 1, 'the drawer closed so the operator sees the message');
  assert.equal(calls.focused, 1, 'the composer took focus for review');
  assert.deepEqual(calls.toasts, [{ msg: 'Voice log added to your message. Look it over, then send.', isError: false }]);
});

test('Send to PG1 appends to a message already being written, after a blank line', () => {
  const { ctx, input } = pageContext(sampleEntries(3));
  input.value = 'The mic kept dropping on my phone.  ';
  ctx.sendVoiceLogToPG1();
  assert.ok(input.value.startsWith('The mic kept dropping on my phone.\n\nDiagnose this voice log\n\n```text\n'), JSON.stringify(input.value.slice(0, 80)));
});

test('with no events, Copy and Send say so and leave the prompt box alone', () => {
  for (const entries of [[], null]) {
    const { ctx, input, calls } = pageContext(entries);
    ctx.sendVoiceLogToPG1();
    assert.equal(input.value, '');
    ctx.copyVoiceLog();
    assert.equal(calls.copied.length, 0);
    assert.deepEqual(calls.toasts.map((t) => t.msg), ['No voice events yet. Switch Conversation mode on first.', 'No voice events yet. Switch Conversation mode on first.']);
    assert.ok(calls.toasts.every((t) => t.isError === false), 'an empty log is not an error');
  }
});

test('Copy voice log copies the formatted log and reports it; a clipboard failure is a plain message, not an error', async () => {
  const { ctx, calls } = pageContext(sampleEntries(5));
  await ctx.copyVoiceLog();
  assert.deepEqual(calls.copied, [V.formatVoiceLog(sampleEntries(5))]);
  assert.deepEqual(calls.toasts, [{ msg: 'Voice log copied.', isError: false }]);
  const noClip = pageContext(sampleEntries(5), { clipboard: false });
  await noClip.ctx.copyVoiceLog();
  assert.deepEqual(noClip.calls.toasts, [{ msg: 'Could not copy the voice log. Use Send to PG1 instead.', isError: false }]);
});

test('the page: the two buttons sit under the Voice diagnostics switch, record every event, and store nothing', () => {
  assert.match(html, /id="voice-diag-btn"[^>]*><\/button>\s*<\/div>\s*<!--[\s\S]*?-->\s*<div class="drawer-row drawer-row-actions" role="group" aria-label="Voice log">\s*<button type="button" id="voice-log-copy" class="handoff-btn" onclick="triggerHaptic\(\); copyVoiceLog\(\)">[\s\S]*?Copy voice log<\/button>\s*<button type="button" id="voice-log-send" class="handoff-btn is-primary" onclick="triggerHaptic\(\); sendVoiceLogToPG1\(\)">[\s\S]*?Send to PG1<\/button>\s*<\/div>/, 'Copy voice log then Send to PG1, under the diagnostics row');
  const fns = [extract('voiceLogEntries'), extract('voiceLogText'), extract('voiceLogMessage'), extract('copyVoiceLog'), extract('sendVoiceLogToPG1')].join('\n');
  assert.doesNotMatch(fns, /localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(/, 'the voice log is never stored or sent by the page');
  assert.match(fns, /conversation\.eventLog\) \? conversation\.eventLog\.entries : \[\]/, 'the log is the module\'s in-memory one');
  // The module records whether or not the diagnostics line is switched on.
  assert.match(moduleSrc, /function emitDiag\(event, extra\) \{\s*if \(event\) lastEvent = event;\s*if \(deps\.onDiagnostics\) deps\.onDiagnostics\(snapshot\(\)\);\s*if \(event\) logEvent\(event, extra\);/);
  assert.doesNotMatch(moduleSrc.slice(moduleSrc.indexOf('function createEventLog'), moduleSrc.indexOf('function formatVoiceLog')), /localStorage|sessionStorage|indexedDB/);
  // PG1 knows about it.
  const chat = readFileSync(join(ROOT, 'api/chat.mjs'), 'utf-8');
  assert.match(chat, /"Copy voice log" copies the last 30 events as text and "Send to PG1" puts them into the prompt box as a fenced text block under the line "Diagnose this voice log"/);
  assert.match(chat, /nothing is sent automatically/);
});

test('the formatted log and the message stay identical between the module and the page constants', () => {
  assert.equal(html.match(/const VOICE_LOG_SEND_LIMIT = (\d+);/)[1], '30');
  assert.equal(html.match(/const VOICE_LOG_PROMPT = '([^']+)';/)[1], 'Diagnose this voice log');
  assert.deepEqual(plain(Object.keys(V).filter((k) => /EventLog|VoiceLog/.test(k)).sort()), ['createEventLog', 'formatVoiceLog']);
});
