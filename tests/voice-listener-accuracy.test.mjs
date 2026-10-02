/**
 * Voice listener accuracy and stacking (public/voice/conversation.js, wired
 * up in public/index.html), after PRs #239 and #240, Pixel 9a Chrome:
 *
 *  - stacking: results are compared word by word (case, punctuation and
 *    apostrophes aside); a result whose opening words substantially overlap
 *    the latest phrase, or that contains it, is a revision and replaces it
 *    ("whats in" then "what's in my error log"; "check my wallet" then
 *    "check my wallet age"; a word changed mid-phrase); a repeat or a part
 *    is dropped; the phrase a restarted session hands back is a repeat
 *  - pauses: in exclusive (Android) mode a session that ends with words in
 *    it keeps the turn open; the recogniser restarts at once and the next
 *    utterance inside the end-of-turn window joins the turn, so a sentence
 *    split over two sessions is one message
 *  - the end-of-turn window is a setting: 1.5 s in exclusive mode, 0.8 s
 *    with the detector, or the operator's choice in both; the page is told
 *    the countdown for the Listening indicator
 *  - "send" or "over" at the end of a final sends at once, without the word
 *  - accuracy: the Speech language setting (English Ireland by default) is
 *    read at every session start for the mic button and conversation mode;
 *    the recogniser is asked for 3 alternatives and the most confident is
 *    used; PG1 phrase hints and the wake-word normalisation stay
 *  - late results after a send never join the next turn
 *  - the voice log: every result carries the session number, isFinal,
 *    resultIndex, confidence and text, beside the turn after it
 *
 * Run with: node --test tests/voice-listener-accuracy.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const moduleSrc = readFileSync(join(ROOT, 'public/voice/conversation.js'), 'utf-8');
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf-8');

function loadModule() {
  const ctx = { setTimeout, clearTimeout, Promise, BigInt, BigInt64Array, Float32Array, Uint16Array, Number, Math, Date, Set };
  vm.createContext(ctx);
  vm.runInContext(moduleSrc, ctx);
  return ctx.PG1Voice;
}
const V = loadModule();
const settle = () => new Promise((r) => setImmediate(r));
const plain = (v) => JSON.parse(JSON.stringify(v));

// A conversation on fakes: a session-aware recogniser the test speaks
// through (alternatives with confidence, lang and maxAlternatives recorded
// per session), a mic, a clock the test moves.
function fixture({ micMode = 'exclusive', opts = {}, deps: extraDeps = {} } = {}) {
  const log = { sent: [], states: [], errors: [], transcripts: [], statuses: [], countdowns: [] };
  let now = 1_000_000;
  const timers = [];
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        now = next.at;
        next.fn();
        await settle();
      }
      now = target;
      await settle();
    }
  };
  let frameCb = null;
  const mic = { closed: false, onFrame(cb) { frameCb = cb; }, async close() { mic.closed = true; frameCb = null; } };
  const rec = {
    calls: [], running: false, lang: '', maxAlternatives: 1, sessions: 0, langs: [],
    onresult: null, onend: null, onerror: null, onspeechstart: null, onspeechend: null,
    start() { rec.calls.push('start'); if (rec.running) throw new Error('already started'); rec.running = true; rec.sessions++; rec.langs.push(rec.lang); },
    finalOnStop: null,
    // The browser delivers the final result, then onend, after stop().
    stop() { rec.calls.push('stop'); if (!rec.running) return; setImmediate(() => { if (rec.finalOnStop) { rec.hear(rec.finalOnStop, { final: true }); rec.finalOnStop = null; } rec.running = false; if (rec.onend) rec.onend(); }); },
    abort() { rec.calls.push('abort'); if (!rec.running) return; rec.running = false; setImmediate(() => { if (rec.onend) rec.onend(); }); },
    // One result with one alternative (confidence when given).
    hear(text, { final = false, index = 0, confidence } = {}) {
      const alt = { transcript: text };
      if (confidence !== undefined) alt.confidence = confidence;
      rec.hearAlts([alt], { final, index });
    },
    // One result with several alternatives, as the recogniser lists them.
    hearAlts(alts, { final = false, index = 0 } = {}) {
      const res = { isFinal: final, length: alts.length };
      alts.forEach((a, i) => { res[i] = a; });
      const results = []; results[index] = res;
      if (rec.onresult) rec.onresult({ resultIndex: index, results });
    },
    error(code) { if (rec.onerror) rec.onerror({ error: code }); setImmediate(() => { if (!rec.running) return; rec.running = false; if (rec.onend) rec.onend(); }); },
    // The session ends on its own (Android does this after each final, and at a pause).
    end() { if (!rec.running) return; rec.running = false; if (rec.onend) rec.onend(); }
  };
  let playing = false;
  const deps = {
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    createRecognition: () => rec,
    openMic: async () => { mic.closed = false; return mic; },
    loadVad: async () => ({ name: 'fake', process: async (frame) => frame[0] }),
    isPlaying: () => playing,
    isBusy: () => false,
    stopPlayback: () => { playing = false; },
    abortRequests: () => {},
    send: (text) => log.sent.push(text),
    onState: (s, d) => log.states.push(d ? `${s}:${d}` : s),
    onTranscript: (t) => log.transcripts.push(t),
    onCountdown: (ms) => log.countdowns.push(ms),
    onStatus: (t) => log.statuses.push(t),
    onError: (m) => log.errors.push(m),
    ...extraDeps
  };
  const conv = V.createConversation(deps, { micMode, ...opts });
  async function frames(p, count) {
    for (let i = 0; i < count; i++) {
      await clock.advance(32);
      if (frameCb) frameCb(Float32Array.of(p));
      await settle(); await settle();
    }
  }
  return { conv, log, rec, mic, clock, frames, setPlaying: (v) => { playing = v; } };
}

// --- stacking: word-level revisions -------------------------------------------------------

test('revision patterns: a result that extends, rewords or contains the latest phrase replaces it; a repeat or a part is dropped; new words are added', () => {
  const m = (phrases, text) => plain(V.mergePhrase(phrases, text));
  // "whats in" then "what's in my error log": apostrophes and case do not tell them apart.
  assert.deepEqual(m(['whats in'], "what's in my error log"), ["what's in my error log"]);
  assert.deepEqual(m(["What's In"], 'whats in my error log'), ['whats in my error log']);
  // "check my wallet" then "check my wallet age".
  assert.deepEqual(m(['check my wallet'], 'check my wallet age'), ['check my wallet age']);
  // A word changed mid-phrase.
  assert.deepEqual(m(["what's in my error log"], "what's in my arrow log"), ["what's in my arrow log"]);
  assert.deepEqual(m(['check my wallet age'], 'check my wallet aged'), ['check my wallet aged']);
  assert.deepEqual(m(['check my wallet age'], 'check the wallet age please'), ['check the wallet age please']);
  // The whole previous phrase found anywhere in the new result.
  assert.deepEqual(m(['in my error log'], "what's in my error log"), ["what's in my error log"]);
  assert.deepEqual(m(['error log'], 'so the error log, then'), ['so the error log, then']);
  // A repeat, with any punctuation, or a part of it: dropped.
  assert.deepEqual(m(["what's in my error log"], "What's in my error log?"), ["what's in my error log"]);
  assert.deepEqual(m(["what's in my error log"], 'in my error'), ["what's in my error log"]);
  assert.deepEqual(m(["what's in my error log"], "what's in"), ["what's in my error log"]);
  // Same length, a small edit: the newer spelling; fewer words: an older guess.
  assert.deepEqual(m(["what's in my error log"], "what's in my error logs"), ["what's in my error logs"]);
  assert.deepEqual(m(["what's in my error logs"], "what's in my errors"), ["what's in my error logs"]);
  // A small edit on a one-word opening.
  assert.deepEqual(m(['what'], "what's in my"), ["what's in my"]);
  // Something else is a new phrase.
  assert.deepEqual(m(['check my wallet age'], 'and the error log'), ['check my wallet age', 'and the error log']);
  assert.deepEqual(m(['yes'], 'no'), ['yes', 'no']);
  // Across phrases: the last one grows, the whole turn re-sent is the turn, a prefix of the whole is dropped.
  assert.deepEqual(m(['check my wallet', 'and the'], 'and the error log'), ['check my wallet', 'and the error log']);
  assert.deepEqual(m(['check my wallet', 'and the'], 'check my wallet and the error log'), ['check my wallet and the error log']);
  assert.deepEqual(m(['check my wallet', 'and the error log'], 'check my wallet and'), ['check my wallet', 'and the error log']);
  assert.deepEqual(m(['a'], '...'), ['a']);
  assert.deepEqual(m([], '  Hello  there '), ['Hello there']);

  // The rule itself: 60% of the shorter phrase's words, in order, among the longer one's opening words, or a small edit.
  assert.ok(V.isPhraseRevision('check my wallet', 'check my email'), '2 of 3 words');
  assert.ok(!V.isPhraseRevision('what is the threat level', 'show me the vault now'), '1 of 5 words is no revision');
  assert.ok(V.isPhraseRevision('what', "what's"), 'one character apart');
  assert.ok(!V.isPhraseRevision('yes', 'no'));
  assert.ok(!V.isPhraseRevision('', 'anything'));
  assert.ok(V.isPhraseContained('my error', "what's in my error log"));
  assert.ok(!V.isPhraseContained('error my', "what's in my error log"), 'order matters');
  assert.ok(!V.isPhraseContained('', 'x'));
  assert.deepEqual(plain(V.phraseWords("What's  in, my ERROR log!")), ['whats', 'in', 'my', 'error', 'log']);
  assert.ok(V.isPhrasePrefix("what's", 'Whats in my log'));
  assert.ok(!V.isPhrasePrefix('what', "what's in"));
});

test('transcript buffer: the Android pattern with revisions is one phrase; settle() keeps an unfinalised preview when a session ends', () => {
  const b = V.createTranscriptBuffer();
  b.setInterim(['whats']);
  b.setInterim(['whats in']);
  b.addFinal('whats in');
  b.setInterim([]);
  assert.equal(b.text, 'whats in');
  b.addFinal("what's in my error log");
  assert.equal(b.finalText, "what's in my error log", 'the revised final replaced the earlier one');
  b.setInterim(["what's in my error log"]);
  assert.equal(b.text, "what's in my error log", 'a repeat in the preview adds nothing');
  b.settle();
  assert.equal(b.interimText, '');
  b.setInterim(['and the']);
  assert.equal(b.text, "what's in my error log and the");
  b.settle();
  assert.equal(b.finalText, "what's in my error log and the", 'the session ended: the preview is kept as said');
  b.addFinal('and the vault');
  assert.equal(b.text, "what's in my error log and the vault", 'and the next session revises it');
});

test('alternatives: the most confident alternative with words in it is used; without confidence the recogniser\'s order stands', () => {
  const pick = V.pickAlternative;
  assert.deepEqual(plain(pick([{ transcript: 'check my wallet', confidence: 0.61 }, { transcript: 'check my wallet age', confidence: 0.84 }, { transcript: 'chuck my wallet', confidence: 0.3 }])),
    { text: 'check my wallet age', confidence: 0.84, index: 1, alternatives: 3 });
  assert.equal(pick([{ transcript: 'first' }, { transcript: 'second' }]).text, 'first', 'interims carry no confidence: the first alternative');
  assert.equal(pick([{ transcript: '  ', confidence: 0.9 }, { transcript: 'real words', confidence: 0.2 }]).text, 'real words', 'an empty alternative is skipped');
  assert.equal(pick([{ transcript: 'Hello,  there ', confidence: 0.5 }, { transcript: 'hello there', confidence: 0.5 }]).text, 'Hello, there', 'a tie keeps the order; whitespace is tidied');
  assert.equal(pick({ 0: { transcript: 'no length' } }).text, 'no length', 'an array-like without length works');
  assert.equal(pick(null), null);
  assert.equal(pick([]), null);
  assert.equal(pick([{ transcript: '...' }]), null, 'punctuation alone is nothing');
});

test('the send keyword: "send" or "over" at the end is recognised and removed, with the comma or full stop around it; elsewhere it is left alone', () => {
  const s = (text) => plain(V.stripSendKeyword(text));
  assert.deepEqual(s("what's in my error log, over."), { text: "what's in my error log", send: true });
  assert.deepEqual(s('check my wallet age send'), { text: 'check my wallet age', send: true });
  assert.deepEqual(s('Check my wallet. Send!'), { text: 'Check my wallet', send: true }, 'the punctuation around the word goes with it');
  assert.deepEqual(s('over'), { text: '', send: true });
  assert.deepEqual(s('Send'), { text: '', send: true });
  assert.deepEqual(s('the server is over there'), { text: 'the server is over there', send: false });
  assert.deepEqual(s('send it'), { text: 'send it', send: false });
  assert.deepEqual(s('overdue'), { text: 'overdue', send: false });
  assert.deepEqual(s(''), { text: '', send: false });
});

// --- the controller, exclusive (Android) mode ----------------------------------------------

test('restart replay: a session that ends mid-turn restarts at once; the phrase the new session hands back is a repeat and its continuation a revision: one message', async () => {
  const f = fixture();
  await f.conv.start();
  assert.equal(f.rec.sessions, 1);
  assert.equal(f.conv.session, 1);
  f.rec.hear("what's in my", { final: true });
  f.rec.end();                                      // Android ends the session after the final
  await f.clock.advance(0);
  assert.equal(f.rec.sessions, 2, 'the recogniser restarted at once');
  assert.deepEqual(f.log.sent, [], 'the turn is still open');
  assert.equal(f.log.countdowns.at(-1), 1500, 'the window runs from the end of the session');
  assert.equal(f.conv.diagnostics.interim, "what's in my", 'the words are kept');
  await f.clock.advance(400);
  f.rec.hear("what's in my");                       // the new session hands the phrase back...
  assert.equal(f.conv.diagnostics.interim, "what's in my");
  f.rec.hear("what's in my error log");             // ...then revises it with more words
  assert.equal(f.conv.diagnostics.interim, "what's in my error log");
  f.rec.hear("what's in my error log", { final: true });
  f.rec.end();
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ["what's in my error log"], 'exactly one clean message');
  assert.ok(f.log.transcripts.every((t) => !/my.*what's/.test(t)), 'nothing stacked was ever shown');
  await f.clock.advance(4000);
  assert.deepEqual(f.log.sent, ["what's in my error log"]);
});

test('a pause mid-sentence: the sentence split over two recogniser sessions is one message; a pause longer than the window is two', async () => {
  const f = fixture();
  await f.conv.start();
  f.rec.onspeechstart();
  f.rec.hear('check my');
  f.rec.hear('check my wallet', { final: true });
  f.rec.onspeechend();
  f.rec.end();
  await f.clock.advance(0);
  assert.equal(f.rec.sessions, 2);
  await f.clock.advance(900);                       // the operator breathes
  assert.deepEqual(f.log.sent, []);
  assert.equal(f.log.countdowns.at(-1), 1500);
  f.rec.onspeechstart();
  assert.equal(f.log.countdowns.at(-1), 0, 'speech again: the countdown stops');
  f.rec.hear('age');
  f.rec.hear('age please', { final: true });
  f.rec.onspeechend();
  f.rec.end();
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['check my wallet age please'], 'one message from two sessions');
  assert.equal(f.log.transcripts.at(-1), '');
  assert.equal(f.log.countdowns.at(-1), 0);

  // A pause longer than the window: the next words are the next turn.
  await f.clock.advance(100);
  assert.ok(f.rec.running);
  f.rec.hear('and the vault', { final: true });
  f.rec.end();
  await f.clock.advance(1500);
  await settle(); await settle();
  await f.clock.advance(1000);
  f.rec.hear('thanks', { final: true });
  f.rec.end();
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['check my wallet age please', 'and the vault', 'thanks']);
});

test('a session that ends with words in it but then fails to restart still sends when the window closes', async () => {
  const f = fixture();
  await f.conv.start();
  f.rec.hear('read the error log', { final: true });
  f.rec.end();
  await f.clock.advance(0);
  assert.equal(f.rec.sessions, 2);
  f.rec.error('no-speech');                         // the new session dies at once
  await settle(); await settle();
  assert.equal(f.conv.diagnostics.recogniser, 'restarting', 'retried with backoff');
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['read the error log'], 'the window sends the turn whatever the restart does');
});

test('"send" or "over" at the end of a final sends at once without the word; an interim "over" does not; the word alone sends what was said', async () => {
  const f = fixture();
  await f.conv.start();
  f.rec.hear('check my wallet, over');              // an interim: "over" may still be "over there"
  await f.clock.advance(300);
  assert.deepEqual(f.log.sent, []);
  f.rec.hear('check my wallet age, over.', { final: true });
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['check my wallet age'], 'sent at once, keyword and punctuation gone');
  assert.ok(f.log.states.includes('thinking:check my wallet age'));
  assert.ok(f.rec.calls.includes('stop'), 'the recogniser was flushed as for any turn');
  // "send" as its own final after the phrase.
  await f.clock.advance(100);
  assert.ok(f.rec.running);
  f.rec.hear("what's in the vault", { final: true });
  await f.clock.advance(500);
  assert.deepEqual(f.log.sent, ['check my wallet age']);
  f.rec.hear('Send', { final: true });
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['check my wallet age', "what's in the vault"]);
  // The word alone with nothing said: nothing.
  await f.clock.advance(100);
  f.rec.hear('over', { final: true });
  await f.clock.advance(2000);
  await settle();
  assert.deepEqual(f.log.sent, ['check my wallet age', "what's in the vault"]);
  // "over there" inside a sentence is left alone and waits for the window.
  f.rec.hear('the server is over there', { final: true });
  await f.clock.advance(1400);
  assert.equal(f.log.sent.length, 2);
  await f.clock.advance(100);
  await settle(); await settle();
  assert.equal(f.log.sent.at(-1), 'the server is over there');
  // Shared mode, the same.
  const g = fixture({ micMode: 'shared' });
  await g.conv.start();
  await g.frames(0.9, 8);
  g.rec.hear('read the error log over', { final: true });
  await settle(); await settle();
  assert.deepEqual(g.log.sent, ['read the error log']);
});

test('late results after a send: a final arriving during the flush joins the turn, anything handed back after it is dropped, and the next turn is only new words', async () => {
  const f = fixture();
  await f.conv.start();
  f.rec.hear('read the error');
  f.rec.finalOnStop = 'read the error log';         // the flush brings the final
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['read the error log']);
  await f.clock.advance(100);
  assert.ok(f.rec.running);
  f.rec.hear('read the error log', { final: true });   // handed back after the restart
  f.rec.hear('Read the error log.', { final: true });
  f.rec.hear('read the error logs', { final: true });  // a respelt repeat
  f.rec.hear('the error log');                         // a part of it
  assert.equal(f.conv.diagnostics.lastEvent, 'result:stale');
  assert.equal(f.conv.diagnostics.interim, '');
  assert.equal(f.log.transcripts.at(-1), '');
  f.rec.end();
  await f.clock.advance(2000);
  assert.deepEqual(f.log.sent, ['read the error log'], 'nothing more was sent');
  f.rec.hear('and the vault', { final: true });
  f.rec.end();
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['read the error log', 'and the vault'], 'the next turn is only what came next');
  // Well inside the stale window, a result with more words is the operator, whole.
  await f.clock.advance(100);
  f.rec.hear('and the vault balance', { final: true });
  f.rec.end();
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['read the error log', 'and the vault', 'and the vault balance']);
});

test('the controller takes the most confident alternative of each result', async () => {
  const f = fixture();
  await f.conv.start();
  f.rec.hearAlts([{ transcript: 'check my while it', confidence: 0.42 }, { transcript: 'check my wallet', confidence: 0.88 }, { transcript: 'check my wall it', confidence: 0.5 }], { final: true });
  assert.equal(f.conv.diagnostics.interim, 'check my wallet');
  assert.equal(f.conv.diagnostics.raw, 'check my wallet');
  f.rec.end();
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['check my wallet']);
});

// --- language and the end-of-turn setting ------------------------------------------------

test('the speech language is read at every session start, from a function or configure(); the recogniser is asked for 3 alternatives', async () => {
  let lang = 'en-IE';
  const f = fixture({ deps: { language: () => lang } });
  await f.conv.start();
  assert.equal(f.rec.maxAlternatives, 3);
  assert.deepEqual(plain(f.rec.langs), ['en-IE']);
  assert.equal(f.conv.language, 'en-IE');
  lang = 'en-NG';
  f.rec.end();
  await f.clock.advance(200);
  assert.deepEqual(plain(f.rec.langs), ['en-IE', 'en-NG'], 'the next session has the new language');
  f.conv.configure({ language: 'en-US' });
  f.rec.end();
  await f.clock.advance(500);
  assert.equal(f.rec.langs.at(-1), 'en-US');
  assert.equal(f.conv.language, 'en-US');
  f.conv.configure({ language: '' });
  assert.equal(f.conv.language, 'en-NG', 'an empty override falls back to the page\'s setting');
  // Shared mode: a change between turns restarts the session for it.
  const g = fixture({ micMode: 'shared', deps: { language: 'en-GB' } });
  await g.conv.start();
  assert.equal(g.rec.lang, 'en-GB');
  const calls = g.rec.calls.length;
  g.conv.configure({ language: 'en-US' });
  assert.ok(g.rec.calls.slice(calls).includes('abort'), 'restarted clean between turns');
  await g.clock.advance(100);
  assert.equal(g.rec.langs.at(-1), 'en-US');
  // No language at all leaves the recogniser's own default alone.
  const h = fixture();
  await h.conv.start();
  assert.equal(h.rec.lang, '');
});

test('the end-of-turn window: 1.5 s in exclusive mode, 0.8 s with the detector, or the operator\'s setting in both; a change applies to the next silence', async () => {
  assert.equal(V.DEFAULTS.exclusiveEndOfTurnSilenceMs, 1500);
  assert.equal(V.DEFAULTS.endOfTurnSilenceMs, 800);
  assert.equal(V.DEFAULTS.endOfTurnOverrideMs, null);
  const f = fixture({ opts: { endOfTurnOverrideMs: 2000 } });
  await f.conv.start();
  assert.equal(f.conv.endOfTurnMs, 2000);
  f.rec.hear('hello there', { final: true });
  assert.equal(f.log.countdowns.at(-1), 2000);
  await f.clock.advance(1900);
  assert.deepEqual(f.log.sent, []);
  await f.clock.advance(100);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['hello there']);
  f.conv.configure({ endOfTurnMs: null });
  assert.equal(f.conv.endOfTurnMs, 1500, 'Auto again');
  f.conv.configure({ endOfTurnMs: 1000 });
  assert.equal(f.conv.diagnostics.endOfTurnMs, 1000);
  await f.clock.advance(100);
  f.rec.hear('again', { final: true });
  assert.equal(f.log.countdowns.at(-1), 1000);
  await f.clock.advance(1000);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['hello there', 'again']);
  // Shared: the detector's clock follows the setting.
  const g = fixture({ micMode: 'shared' });
  await g.conv.start();
  assert.equal(g.conv.endOfTurnMs, 800);
  g.conv.configure({ endOfTurnMs: 1500 });
  assert.equal(g.conv.endOfTurnMs, 1500);
  await g.frames(0.9, 10);
  g.rec.hear('status please', { final: true });
  g.rec.finalOnStop = 'status please';
  await g.frames(0.05, 40);                         // 1280 ms of silence
  assert.deepEqual(g.log.sent, [], 'not yet: the window is 1.5 s now');
  const first = g.log.countdowns.find((ms) => ms > 0);
  assert.ok(first > 1400 && first <= 1500, `the countdown was told the window (${first})`);
  await g.frames(0.05, 8);
  await settle(); await settle();
  assert.deepEqual(g.log.sent, ['status please']);
  assert.equal(g.log.countdowns.at(-1), 0);
});

test('the countdown: told the window when the operator goes quiet with words buffered, 0 when they speak again, the turn is sent or the mode stops', async () => {
  const f = fixture();
  await f.conv.start();
  f.rec.onspeechstart();
  assert.deepEqual(f.log.countdowns, [], 'nothing buffered: no countdown');
  f.rec.hear('what is');
  assert.deepEqual(plain(f.log.countdowns), [1500]);
  f.rec.hear('what is the');
  assert.deepEqual(plain(f.log.countdowns), [1500, 0, 1500], 'each result restarts it');
  f.rec.onspeechstart();
  assert.equal(f.log.countdowns.at(-1), 0, 'speech: it stops');
  f.rec.hear('what is the vault', { final: true });
  f.rec.onspeechend();
  assert.equal(f.log.countdowns.at(-1), 1500);
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['what is the vault']);
  assert.equal(f.log.countdowns.at(-1), 0, 'gone with the send');
  await f.clock.advance(100);
  f.rec.hear('more', { final: true });
  assert.equal(f.log.countdowns.at(-1), 1500);
  await f.conv.stop('tap');
  assert.equal(f.log.countdowns.at(-1), 0, 'and when the mode stops');
  assert.deepEqual(f.log.sent, ['what is the vault'], 'a turn cut off by stop is not sent');
});

// --- the voice log ------------------------------------------------------------------------

test('the voice log: every result carries the session number, final, resultIndex, confidence and text beside the turn after it; sessions count across restarts', async () => {
  const f = fixture();
  await f.conv.start();
  f.rec.hearAlts([{ transcript: 'whats in', confidence: 0.5 }, { transcript: "what's in", confidence: 0.7 }]);
  f.rec.hear("what's in my error log", { final: true, confidence: 0.91 });
  f.rec.end();
  await f.clock.advance(0);
  f.rec.hear("what's in my error log", { final: true, confidence: 0.88 });   // handed back by session 2
  const results = f.conv.eventLog.entries.filter((e) => /^result/.test(e.event));
  assert.deepEqual(plain(results.map((e) => [e.event, e.session, e.final, e.resultIndex, e.confidence, e.text, e.turn])), [
    ['result', 1, false, 0, 0.7, "what's in", "what's in"],
    ['result', 1, true, 0, 0.91, "what's in my error log", "what's in my error log"],
    ['result', 2, true, 0, 0.88, "what's in my error log", "what's in my error log"]
  ]);
  const starts = f.conv.eventLog.entries.filter((e) => e.event === 'start').map((e) => e.session);
  assert.deepEqual(plain(starts), [1, 2]);
  const ends = f.conv.eventLog.entries.filter((e) => e.event === 'end').map((e) => e.session);
  assert.deepEqual(plain(ends), [1]);
  let lines = V.formatVoiceLog(f.conv.eventLog.entries).split('\n');
  assert.ok(lines.some((l) => / result \| listening \| exclusive mic \| rec running \| err none \| s1 \| interim #0 0\.70 \| heard "what's in" \| turn "what's in"$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => / result \| listening \| exclusive mic \| rec running \| err none \| s2 \| final #0 0\.88 \| heard "what's in my error log" \| turn "what's in my error log"$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => / start \| listening \| exclusive mic \| rec running \| err none \| s2 \| heard "what's in my error log"$/.test(l)), 'the second session start, with what was last heard\n' + lines.join('\n'));
  await f.clock.advance(1500);
  await settle(); await settle();
  const sent = f.conv.eventLog.entries.find((e) => e.event === 'sent');
  assert.equal(sent.text, "what's in my error log");
  assert.equal(sent.session, 2);
  // After the send: a stale repeat is logged as such, with the empty turn.
  await f.clock.advance(100);
  f.rec.hear("what's in my error log", { final: true, confidence: 0.6 });
  const stale = f.conv.eventLog.entries.at(-1);
  assert.equal(stale.event, 'result:stale');
  assert.equal(stale.session, 3);
  assert.equal(stale.text, "what's in my error log");
  assert.equal(stale.turn, '');
  lines = V.formatVoiceLog(f.conv.eventLog.entries, { limit: 1 }).split('\n');
  assert.match(lines[0], / result:stale \| listening \| exclusive mic \| rec running \| err none \| s3 \| final #0 0\.60 \| heard "what's in my error log"$/);
  // A multi-result event: one line per result; the text is shown when it differs from what was heard.
  f.rec.onresult({ resultIndex: 1, results: [{ isFinal: true, length: 1, 0: { transcript: 'older', confidence: 0.9 } }, { isFinal: true, length: 1, 0: { transcript: 'and the', confidence: 0.4 } }, { isFinal: true, length: 1, 0: { transcript: 'and the vault', confidence: 0.8 } }] });
  const two = f.conv.eventLog.entries.slice(-2);
  assert.deepEqual(plain(two.map((e) => [e.resultIndex, e.confidence, e.text, e.raw, e.turn])), [[1, 0.4, 'and the', 'and the and the vault', 'and the vault'], [2, 0.8, 'and the vault', 'and the and the vault', 'and the vault']]);
  const formatted = V.formatVoiceLog(two);
  assert.match(formatted, /final #1 0\.40 \| heard "and the and the vault" \| text "and the" \| turn "and the vault"/);
  assert.match(formatted, /final #2 0\.80 \| heard "and the and the vault" \| text "and the vault" \| turn "and the vault"/);
  // A consecutive repeat with nothing changed is kept once; a changed confidence is a new entry.
  f.rec.hear('and the vault', { final: true, confidence: 0.8 });
  const size = f.conv.eventLog.size;
  f.rec.hear('and the vault', { final: true, confidence: 0.8 });
  assert.equal(f.conv.eventLog.size, size, 'the same result again adds nothing');
  f.rec.hear('and the vault', { final: true, confidence: 0.81 });
  assert.equal(f.conv.eventLog.size, size + 1, 'a different confidence is a different event');
});

// --- the page -----------------------------------------------------------------------------

test('the page: Speech language and End of turn in the drawer under Voice, remembered on this device, applied to the mic button and conversation mode', () => {
  assert.match(html, /<label class="drawer-row-label" for="speech-lang-select">[\s\S]*?Speech language<\/label>\s*<select id="speech-lang-select" class="select" onchange="triggerHaptic\(30\); setSpeechLanguage\(this\.value\)">\s*<option value="en-IE">English \(Ireland\)<\/option>\s*<option value="en-GB">English \(UK\)<\/option>\s*<option value="en-US">English \(US\)<\/option>\s*<option value="en-NG">English \(Nigeria\)<\/option>\s*<\/select>/);
  assert.match(html, /<label class="drawer-row-label" for="end-of-turn-select">[\s\S]*?End of turn<\/label>\s*<select id="end-of-turn-select" class="select" onchange="triggerHaptic\(30\); setEndOfTurnSetting\(this\.value\)">\s*<option value="">Auto<\/option>\s*<option value="800">0\.8 s<\/option>\s*<option value="1000">1 s<\/option>\s*<option value="1500">1\.5 s<\/option>\s*<option value="2000">2 s<\/option>\s*<option value="3000">3 s<\/option>\s*<\/select>/);
  const voice = html.slice(html.indexOf('<div class="drawer-section" role="group" aria-label="Voice">'), html.indexOf('aria-labelledby="appearance-label"'));
  assert.ok(voice.indexOf('id="voice-profile-select"') < voice.indexOf('id="speech-lang-select"') && voice.indexOf('id="speech-lang-select"') < voice.indexOf('id="end-of-turn-select"'), 'under the voice profile, in the Voice section');
  const settings = html.slice(html.indexOf('// SPEECH SETTINGS (drawer, under Voice)'), html.indexOf('// CONVERSATION MODE (PG1 voice, phase 2)'));
  assert.match(settings, /const SPEECH_LANG_KEY = 'pg1_speech_lang';/);
  assert.match(settings, /const END_OF_TURN_KEY = 'pg1_end_of_turn_ms';/);
  assert.match(settings, /const SPEECH_LANGUAGES = \['en-IE', 'en-GB', 'en-US', 'en-NG'\];/);
  assert.match(settings, /const DEFAULT_SPEECH_LANGUAGE = 'en-IE';/);
  assert.match(settings, /return SPEECH_LANGUAGES\.includes\(v\) \? v : DEFAULT_SPEECH_LANGUAGE;/, 'an unknown stored value falls back to English (Ireland)');
  assert.match(settings, /localStorage\.setItem\(SPEECH_LANG_KEY, v\)/);
  assert.match(settings, /if \(conversation\) conversation\.configure\(\{ language: v \}\);/);
  assert.match(settings, /if \(conversation\) conversation\.configure\(\{ endOfTurnMs: v \}\);/);
  assert.match(settings, /'Auto \(' \+ \(isAndroidBrowser\(\) \? '1\.5' : '0\.8'\) \+ ' s\)'/);
  assert.match(html, /window\.onload = \(\) => \{\s*initSpeechSettings\(\);/);
  // The mic button.
  const dictation = html.slice(html.indexOf("if ('webkitSpeechRecognition' in window"), html.indexOf('function stopRecording('));
  assert.match(dictation, /recognition\.maxAlternatives = 3;/);
  assert.match(dictation, /recognition\.lang = speechLanguage\(\);\s*recognition\.start\(\);/, 'the language is set at every start');
  assert.match(dictation, /PG1Voice\.pickAlternative\(res\)/);
  assert.match(dictation, /recognition\.phrases = \[new SpeechRecognitionPhrase\('PG1', 5\.0\)\]/, 'the phrase hints stay');
  assert.match(dictation, /PG1Voice\.normaliseWakeWord\(text\)/, 'and the wake-word normalisation');
  // Conversation mode.
  const glue = html.slice(html.indexOf('// CONVERSATION MODE (PG1 voice, phase 2)'), html.indexOf('function setVoiceActive('));
  assert.match(glue, /language: \(\) => speechLanguage\(\),/);
  assert.doesNotMatch(glue, /navigator\.language/, 'the browser language no longer decides');
  assert.match(glue, /onCountdown: renderConversationCountdown,/);
  assert.match(glue, /\{ micMode: isAndroidBrowser\(\) \? 'exclusive' : 'shared', endOfTurnOverrideMs: endOfTurnSetting\(\) \}/);
  assert.match(glue, /'session ' \+ \(snap\.session \|\| 0\),\s*'end ' \+ \(snap\.endOfTurnMs \/ 1000\) \+ 's'/, 'the diagnostics line shows the session and the window');
  assert.doesNotMatch(glue, /localStorage|sessionStorage|document\.cookie|indexedDB/, 'the glue itself still stores nothing');
  // The module keeps the hints and the wake word.
  assert.match(moduleSrc, /new root\.SpeechRecognitionPhrase\('PG1', 5\.0\)/);
  assert.match(moduleSrc, /let text = normaliseWakeWord\(heard\)\.trim\(\);/);
  assert.match(moduleSrc, /r\.maxAlternatives = o\.maxAlternatives;/);
  // PG1 knows about the settings and the keyword.
  const chat = readFileSync(join(ROOT, 'api/chat.mjs'), 'utf-8');
  assert.match(chat, /The "Speech language" setting \(same place\) picks the recogniser's language for the mic button and conversation mode: English \(Ireland\) by default, or UK, US or Nigeria\./);
  assert.match(chat, /saying "send" or "over" at the end sends at once and the word is left out of the message/);
  assert.match(chat, /"End of turn" setting in the drawer under Voice: Auto is 1\.5 s on Android and 0\.8 s elsewhere/);
});

test('the page: the Listening indicator carries the countdown bar, driven by the module, hidden with the indicator, still under reduced motion', () => {
  assert.match(html, /<div id="converse-status" class="converse-status" hidden><span class="converse-dot" aria-hidden="true"><\/span><span class="converse-label">Listening<\/span><span class="converse-live" aria-hidden="true"><\/span><span class="converse-countdown" aria-hidden="true"><\/span><\/div>/);
  const css = html.slice(html.indexOf('/* Conversation mode:'), html.indexOf('.execute-btn {'));
  assert.match(css, /\.converse-status \{\s*position: relative;/);
  assert.match(css, /\.converse-countdown \{[^}]*height: 2px;[^}]*background: var\(--ok\);[^}]*opacity: 0;[^}]*transform: scaleX\(0\);[^}]*transform-origin: left center;/);
  assert.match(css, /\.converse-countdown\.is-active \{ opacity: 0\.55; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.converse-countdown\.is-active \{ transition: none !important; transform: scaleX\(0\.5\) !important; \}/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i, 'tokens only');
  const glue = html.slice(html.indexOf('// CONVERSATION MODE (PG1 voice, phase 2)'), html.indexOf('function setVoiceActive('));
  assert.match(glue, /function renderConversationCountdown\(ms\) \{\s*const bar = document\.querySelector\('#converse-status \.converse-countdown'\);/);
  assert.match(glue, /bar\.style\.transform = 'scaleX\(1\)';\s*bar\.classList\.add\('is-active'\);\s*void bar\.offsetWidth;/, 'reset to full, then run down');
  assert.match(glue, /bar\.style\.transition = 'transform ' \+ Math\.round\(ms\) \+ 'ms linear';\s*bar\.style\.transform = 'scaleX\(0\)';/);
  assert.match(glue, /if \(!isOn\) \{ renderConversationNote\(''\); renderConversationCountdown\(0\); \}/);
  assert.doesNotMatch(glue, /setInterval/, 'nothing is polled for the countdown');
});
