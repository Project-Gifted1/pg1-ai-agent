/**
 * PG1 voice, phase 2: hands-free conversation with barge-in
 * (public/voice/conversation.js, wired up in public/index.html).
 *
 *  - VAD fallback: Silero unavailable -> the energy detector, and the
 *    energy detector itself tells speech from room noise
 *  - end of turn: about 800 ms of silence after speech, not sooner, and
 *    the transcript is then sent automatically
 *  - barge-in: while PG1 talks, only sustained (300 ms) confident speech
 *    interrupts; it stops playback, aborts the reply and restarts the
 *    recogniser so nothing heard from the speaker is kept
 *  - echo guard: a transcript of what PG1 just said is never sent
 *  - "April" / "a PG one" / "PG one" -> "PG1" at the start of an utterance
 *  - Android's recogniser re-sends the whole phrase on every update, repeats
 *    a final after a restart and delivers results after a send: one clean
 *    message per turn, in conversation mode and in dictation
 *  - exclusive mode: a session that ends with words in it keeps the turn
 *    open for the end-of-turn window (1.5 s there) and restarts at once
 *    (tests/voice-listener-accuracy.test.mjs covers revisions, pauses that
 *    split a sentence, the "send" keyword, the language setting and the log)
 *  - auto-off after two minutes of silence, and when the page is hidden
 *  - the server strips OPERATOR:/AGENT: transcript labels from a reply
 *  - the page: switch markup, announcer, reduced motion, no emoji
 *
 * The module is loaded in a vm context with no DOM; the controller gets
 * fake mic, recogniser, clock and timers. Secret-shaped values come from
 * tests/fixtures/fake-secrets.mjs.
 *
 * Run with: node --test tests/voice-conversation.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { FAKE, bearerHeader } from './fixtures/fake-secrets.mjs';
import { stripTranscriptLabels, createReplyScrubber } from '../lib/chatStream.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const moduleSrc = readFileSync(join(ROOT, 'public/voice/conversation.js'), 'utf-8');
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf-8');

function loadModule(extra = {}) {
  const ctx = { setTimeout, clearTimeout, Promise, BigInt, BigInt64Array, Float32Array, Uint16Array, Number, Math, ...extra };
  vm.createContext(ctx);
  vm.runInContext(moduleSrc, ctx);
  return ctx.PG1Voice;
}

const V = loadModule();
const { DEFAULTS } = V;

const settle = () => new Promise((r) => setImmediate(r));
// Values built inside the vm context have their own Array prototype.
const plain = (v) => JSON.parse(JSON.stringify(v));
const sine = (amp, n = DEFAULTS.frameSamples) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * amp);
const noise = (amp, n = DEFAULTS.frameSamples) => Float32Array.from({ length: n }, () => (Math.random() - 0.5) * 2 * amp);

// --- VAD and fallback ----------------------------------------------------------------

test('energy detector: quiet room scores near 0, a voice-level burst scores near 1', () => {
  const vad = V.createEnergyVad();
  let quiet = 0;
  for (let i = 0; i < 30; i++) quiet = vad.process(noise(0.003));
  assert.ok(quiet < 0.1, `quiet frame scored ${quiet}`);
  const loud = vad.process(sine(0.3));
  assert.ok(loud > 0.9, `loud frame scored ${loud}`);
  assert.equal(vad.process(new Float32Array(512)), 0, 'digital silence is never speech');
  vad.reset();
  assert.equal(vad.noiseFloor, null);
});

test('loadVad falls back to the energy detector when the runtime or model fails, and says why', async () => {
  const reasons = [];
  const vad = await V.loadVad({ loadRuntime: () => Promise.reject(new Error('script 404')), onFallback: (e) => reasons.push(e.message) });
  assert.equal(vad.name, 'energy');
  assert.deepEqual(reasons, ['script 404']);

  const badOrt = { InferenceSession: { create: async () => { throw new Error('model 404'); } }, Tensor: class {} };
  const vad2 = await V.loadVad({ loadRuntime: async () => badOrt, onFallback: (e) => reasons.push(e.message) });
  assert.equal(vad2.name, 'energy');
  assert.equal(reasons[1], 'model 404');

  const vad3 = await V.loadVad({ onFallback: (e) => reasons.push(e.message) });
  assert.equal(vad3.name, 'energy');
  assert.equal(reasons[2], 'no runtime loader');
});

test('loadVad does not hang on a runtime that never resolves', async () => {
  const vad = await V.loadVad({ loadRuntime: () => new Promise(() => {}), timeoutMs: 20, onFallback: () => {} });
  assert.equal(vad.name, 'energy');
});

test('Silero wrapper feeds 64 context samples plus the frame, keeps the state, and clamps the output', async () => {
  const runs = [];
  class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
  const ort = {
    Tensor,
    InferenceSession: { create: async () => ({ run: async (inputs) => { runs.push(inputs); return { output: { data: [1.7] }, stateN: new Tensor('float32', new Float32Array(256), [2, 1, 128]) }; }, release: async () => {} }) }
  };
  const vad = await V.createSileroVad(ort, { modelUrl: '/voice/silero_vad_v5.onnx' });
  assert.equal(vad.name, 'silero');
  const p = await vad.process(sine(0.1));
  assert.equal(p, 1, 'probability is clamped to [0, 1]');
  assert.deepEqual(plain(runs[0].input.dims), [1, 576]);
  assert.equal(runs[0].sr.type, 'int64');
  assert.deepEqual(plain(runs[0].state.dims), [2, 1, 128]);
  await vad.process(sine(0.1));
  assert.notEqual(runs[1].state, runs[0].state, 'stateN from the last run is the next state');
  assert.ok(runs[1].input.data.subarray(0, 64).every((v, i) => v === sine(0.1)[448 + i]), 'the context is the tail of the previous frame');
});

test('frame assembler resamples any input rate into 512-sample frames at 16 kHz', () => {
  const frames = [];
  const asm = V.createFrameAssembler(48000, (f) => frames.push(f));
  asm.push(new Float32Array(4800).fill(0.25));
  asm.push(new Float32Array(43200).fill(0.25));
  assert.equal(frames.length, 31, 'one second of 48 kHz audio is 31 full frames (16000 / 512)');
  assert.ok(frames.every((f) => f.length === 512 && f[0] === 0.25 && f[511] === 0.25));
  const same = [];
  const asm16 = V.createFrameAssembler(16000, (f) => same.push(f));
  asm16.push(new Float32Array(1024).fill(1));
  assert.equal(same.length, 2);
});

// --- turn tracker: end of turn, barge-in ---------------------------------------------

function run(tracker, probs, { playing = false, from = 0, step = 32 } = {}) {
  const events = [];
  let now = from;
  for (const p of probs) {
    now += step;
    for (const e of tracker.update({ prob: p, playing, now })) events.push({ e, at: now });
  }
  return { events, now };
}

test('end of turn: 800 ms of silence after speech, not a moment sooner', () => {
  const t = V.createTurnTracker();
  const speech = Array(10).fill(0.9);        // 320 ms of speech
  const silence = Array(40).fill(0.05);
  const { events } = run(t, [...speech, ...silence]);
  const start = events.find((x) => x.e === 'turn_start');
  const end = events.find((x) => x.e === 'turn_end');
  assert.ok(start, 'turn_start');
  assert.ok(end, 'turn_end');
  assert.equal(start.at, 32 * 6, 'a turn opens once 150 ms of speech has been heard, not on the first frame');
  const lastSpeechAt = 32 * 10;
  assert.ok(end.at - lastSpeechAt >= 800, `turn ended ${end.at - lastSpeechAt} ms after the last speech frame`);
  assert.ok(end.at - lastSpeechAt < 800 + 32, 'and on the first frame past 800 ms');
});

test('a short blip or a pause inside a sentence does not end the turn', () => {
  const t = V.createTurnTracker();
  // 64 ms blip: under minTurnSpeechMs, no turn
  assert.deepEqual(run(t, [0.9, 0.9, 0.1, 0.1, 0.1]).events, []);
  const t2 = V.createTurnTracker();
  const probs = [...Array(10).fill(0.9), ...Array(15).fill(0.1), ...Array(10).fill(0.9), ...Array(30).fill(0.1)];
  const { events } = run(t2, probs);
  assert.equal(events.filter((x) => x.e === 'turn_start').length, 1);
  assert.equal(events.filter((x) => x.e === 'turn_end').length, 1);
  assert.ok(events.find((x) => x.e === 'turn_end').at > 32 * 35, 'the 480 ms pause did not end it');
});

test('hysteresis: speech keeps a turn alive above the release threshold but needs the higher one to start', () => {
  const t = V.createTurnTracker();
  assert.deepEqual(run(t, Array(20).fill(0.4)).events, [], '0.4 never starts a turn');
  const t2 = V.createTurnTracker();
  const { events } = run(t2, [...Array(8).fill(0.9), ...Array(20).fill(0.4), ...Array(30).fill(0.05)]);
  const end = events.find((x) => x.e === 'turn_end');
  assert.ok(end.at >= 32 * 28 + 800, 'frames at 0.4 counted as speech once the turn was open');
});

test('barge-in: while PG1 talks, ordinary speech levels are ignored and 300 ms of confident speech interrupts', () => {
  const t = V.createTurnTracker();
  assert.deepEqual(run(t, Array(30).fill(0.7), { playing: true }).events, [], '0.7 (speaker bleed) never interrupts');
  const t2 = V.createTurnTracker();
  assert.deepEqual(run(t2, [...Array(8).fill(0.95), ...Array(10).fill(0.1)], { playing: true }).events, [], '256 ms is not enough');
  const t3 = V.createTurnTracker();
  const { events } = run(t3, Array(12).fill(0.95), { playing: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].e, 'barge_in');
  assert.equal(events[0].at, 32 * 11, 'first frame at or past 300 ms after the run started');
  assert.ok(t3.inTurn, 'the operator\'s turn is open from the barge-in');
});

test('barge-in: a gap longer than 100 ms restarts the 300 ms count; a shorter dip does not', () => {
  const t = V.createTurnTracker();
  const probs = [...Array(6).fill(0.95), ...Array(5).fill(0.2), ...Array(8).fill(0.95)];
  assert.deepEqual(run(t, probs, { playing: true }).events, [], 'a 160 ms gap reset the count');
  const t2 = V.createTurnTracker();
  const probs2 = [...Array(6).fill(0.95), 0.2, 0.2, ...Array(4).fill(0.95)];
  const { events } = run(t2, probs2, { playing: true });
  assert.equal(events.length, 1, 'a 64 ms dip was tolerated');
  assert.equal(events[0].e, 'barge_in');
});

test('noteSpeech opens a turn from the recogniser alone and idleMs tracks the last speech', () => {
  const t = V.createTurnTracker();
  t.reset(1000);
  assert.equal(t.idleMs(5000), 4000);
  assert.deepEqual(plain(t.noteSpeech(6000)), ['turn_start']);
  assert.equal(t.idleMs(6500), 500);
  assert.ok(t.endTurn());
  assert.ok(!t.inTurn);
});

// --- transcript hygiene -----------------------------------------------------------------

test('"Hey PG1" mishearings are normalised at the start of an utterance only', () => {
  const cases = [
    ['April what time is it', 'PG1 what time is it'],
    ['Hey April, status', 'Hey PG1, status'],
    ['hey april run the check', 'hey PG1 run the check'],
    ['a PG one status', 'PG1 status'],
    ['PG one hello', 'PG1 hello'],
    ['pg one, what is new', 'PG1, what is new'],
    ['okay PG 1 go', 'okay PG1 go'],
    ['Hi P.G. one', 'Hi PG1'],
    ['PG1 status', 'PG1 status'],
    ['April', 'PG1'],
    ['In April we ship', 'In April we ship'],
    ['Tell PG one about it', 'Tell PG one about it'],
    ['Apricot season', 'Apricot season'],
    ['', ''],
    [undefined, '']
  ];
  for (const [input, expected] of cases) assert.equal(V.normaliseWakeWord(input), expected, JSON.stringify(input));
});

test('echo guard: a transcript of what PG1 just said is recognised, a real question is not', () => {
  const spoken = ['The database is connected and three recent messages were loaded. Want the full details?'];
  assert.ok(V.isEchoOfSpoken('the database is connected and three recent messages were loaded', spoken));
  assert.ok(V.isEchoOfSpoken('database is connected and three recent messages loaded want the full details', spoken), 'a few dropped words still count');
  assert.ok(!V.isEchoOfSpoken('is the database connected to the vault today', spoken));
  assert.ok(!V.isEchoOfSpoken('what is the weather in London', spoken));
  // One or two words only match a whole spoken text, so "yes" to a long
  // sentence that contained "yes" still goes through.
  assert.ok(V.isEchoOfSpoken('yes', ['Yes.']));
  assert.ok(!V.isEchoOfSpoken('yes', ['Yes, the database is fine.']));
  assert.ok(!V.isEchoOfSpoken('', spoken));
  assert.ok(!V.isEchoOfSpoken('anything', []));
  assert.equal(V.echoSimilarity('a b c', 'x a y b z c'), 1);
  assert.equal(V.echoSimilarity('a b c d', 'a b'), 0.5);
});

test('echo guard: a spoken placeholder for a secret is matched too, and the spoken log keeps a few texts', () => {
  const log = V.createSpokenLog(2);
  log.add(`Your token is ${FAKE.bearerToken}, keep it private.`);
  log.add('Secret value not read aloud.');
  log.add('Secret value not read aloud.');
  assert.equal(log.texts.length, 2, 'repeats are not stored twice');
  assert.ok(V.isEchoOfSpoken('secret value not read aloud', log.texts));
  log.add('Third thing.');
  assert.deepEqual(plain(log.texts), ['Secret value not read aloud.', 'Third thing.'], 'oldest entry drops off');
  // A transcript that merely mentions the same header is the operator's.
  assert.ok(!V.isEchoOfSpoken(`send the ${bearerHeader()} to the vault`, log.texts));
  log.clear();
  assert.deepEqual(plain(log.texts), []);
});

// --- the controller, with fakes ---------------------------------------------------------

function makeFakes({ vadName = 'fake', recognitionAvailable = true, micFails = false, spokenLog = null, micMode = undefined } = {}) {
  const log = { sent: [], states: [], errors: [], stops: 0, aborts: 0, transcripts: [], statuses: [], diags: [], micOpens: 0 };
  let now = 100000;
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
    calls: [], running: false, onresult: null, onend: null, onerror: null, phrases: null,
    start() { rec.calls.push('start'); if (rec.running) throw new Error('already started'); rec.running = true; },
    finalOnStop: null,
    // The browser delivers the final result, then onend, after stop().
    stop() { rec.calls.push('stop'); if (!rec.running) return; setImmediate(() => { if (rec.finalOnStop) { rec.hear(rec.finalOnStop, { final: true }); rec.finalOnStop = null; } rec.running = false; if (rec.onend) rec.onend(); }); },
    abort() { rec.calls.push('abort'); if (!rec.running) return; rec.running = false; setImmediate(() => { if (rec.onend) rec.onend(); }); },
    // Simulates the recogniser: interim and final results.
    hear(text, { final = false, index = 0 } = {}) {
      const results = []; results[index] = { isFinal: final, 0: { transcript: text } };
      if (rec.onresult) rec.onresult({ resultIndex: index, results });
    },
    // Chrome reports an error, then ends the session.
    error(code) {
      if (rec.onerror) rec.onerror({ error: code });
      setImmediate(() => { if (!rec.running) return; rec.running = false; if (rec.onend) rec.onend(); });
    },
    // The session ends on its own (Android does this after each final).
    end() { if (!rec.running) return; rec.running = false; if (rec.onend) rec.onend(); }
  };
  let playing = false;
  let busy = false;
  const deps = {
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    createRecognition: () => (recognitionAvailable ? rec : null),
    openMic: async () => { if (micFails) throw new Error('Microphone is not available.'); log.micOpens++; mic.closed = false; return mic; },
    loadVad: async () => ({ name: vadName, process: async (frame) => frame[0] }),
    isPlaying: () => playing,
    isBusy: () => busy,
    stopPlayback: () => { log.stops++; playing = false; },
    abortRequests: () => { log.aborts++; busy = false; },
    send: (text) => { log.sent.push(text); busy = true; },
    spokenLog: spokenLog || undefined,
    onState: (s, d) => log.states.push(d ? `${s}:${d}` : s),
    onTranscript: (t) => log.transcripts.push(t),
    onStatus: (t) => log.statuses.push(t),
    onDiagnostics: (d) => log.diags.push(d),
    onError: (m) => log.errors.push(m)
  };
  const conv = V.createConversation(deps, micMode ? { micMode } : {});
  // Feeds `count` frames of probability p, 32 ms apart.
  async function frames(p, count) {
    for (let i = 0; i < count; i++) {
      await clock.advance(32);
      if (frameCb) frameCb(Float32Array.of(p));   // a closed mic delivers nothing
      await settle();
      await settle();
    }
  }
  return { conv, log, rec, mic, clock, frames, setPlaying: (v) => { playing = v; }, setBusy: (v) => { busy = v; } };
}

test('start opens the mic and the recogniser; a turn is sent 800 ms after the operator stops talking', async () => {
  const f = makeFakes();
  assert.ok(await f.conv.start());
  assert.ok(f.conv.on);
  assert.equal(f.conv.state, 'listening');
  assert.equal(f.log.states[0], 'listening:started');
  assert.ok(f.rec.continuous && f.rec.interimResults, 'shared: continuous recognition with interim results');
  assert.deepEqual(f.rec.calls, ['start']);

  await f.frames(0.9, 10);
  f.rec.hear('what is the', { index: 0 });
  f.rec.hear('what is the status', { index: 0 });
  assert.equal(f.log.transcripts.at(-1), 'what is the status', 'the live guess goes to the indicator');
  await f.frames(0.05, 24);                  // 768 ms: not yet
  assert.deepEqual(f.log.sent, []);
  f.rec.finalOnStop = 'what is the status';
  await f.frames(0.05, 2);                   // past 800 ms
  // Stopping the recogniser flushes the final text, then onend.
  assert.ok(f.rec.calls.includes('stop'), 'the recogniser is stopped to flush its final text');
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['what is the status']);
  assert.equal(f.log.transcripts.at(-1), '', 'the live guess is cleared once sent');
  assert.equal(f.conv.state, 'thinking');
  await f.clock.advance(100);
  assert.ok(f.rec.running, 'the recogniser is restarted for the next turn');
});

test('a turn with only interim text is still sent after the grace period, and an empty turn sends nothing', async () => {
  const f = makeFakes();
  await f.conv.start();
  await f.frames(0.9, 8);
  f.rec.hear('read the error log');
  await f.frames(0.05, 27);
  // The recogniser never finalises; onend arrives from stop() anyway.
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['read the error log']);

  await f.clock.advance(200);
  await f.frames(0.9, 8);
  await f.frames(0.05, 27);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['read the error log'], 'nothing heard, nothing sent');
  assert.deepEqual(f.log.errors, []);
});

test('barge-in: speaking over PG1 stops playback, aborts the reply, restarts the recogniser and captures the new turn', async () => {
  const f = makeFakes();
  await f.conv.start();
  f.setBusy(true);
  f.setPlaying(true);
  await f.frames(0.2, 2);
  assert.equal(f.conv.state, 'speaking');
  // Speaker bleed at ordinary levels, and a short burst, do nothing.
  await f.frames(0.7, 20);
  await f.frames(0.95, 8);
  await f.frames(0.1, 5);
  assert.equal(f.log.stops, 0);
  // Echo heard while PG1 talks is dropped, not buffered.
  f.rec.hear('three recent messages were loaded', { final: true });
  assert.equal(f.log.transcripts.at(-1), '');
  const callsBefore = f.rec.calls.length;
  await f.frames(0.95, 11);
  assert.equal(f.log.stops, 1, 'playback stopped');
  assert.equal(f.log.aborts, 1, 'the streaming reply was aborted');
  assert.ok(f.rec.calls.slice(callsBefore).includes('abort'), 'the recogniser was restarted clean');
  assert.equal(f.log.states.at(-1), 'listening:interrupted');
  await f.clock.advance(100);
  assert.ok(f.rec.running);
  // The new turn is captured and sent as usual.
  await f.frames(0.9, 6);
  f.rec.hear('no, show me the vault', { final: true });
  await f.frames(0.05, 27);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['no, show me the vault']);
});

test('echo guard in the controller: a transcript matching what PG1 just said is dropped, the next real one is sent', async () => {
  const spokenLog = V.createSpokenLog();
  // What PG1 said (the page records it when audio plays).
  spokenLog.add('The database is connected and three recent messages were loaded. Want the full details?');
  const h = makeFakes({ spokenLog });
  await h.conv.start();
  await h.frames(0.9, 8);
  h.rec.hear('the database is connected and three recent messages were loaded', { final: true });
  await h.frames(0.05, 27);
  await settle(); await settle();
  assert.deepEqual(h.log.sent, [], 'the echo was not sent');
  assert.equal(h.conv.state, 'listening');
  await h.clock.advance(200);
  await h.frames(0.9, 8);
  h.rec.hear('yes please, the full details', { final: true });
  await h.frames(0.05, 27);
  await settle(); await settle();
  assert.deepEqual(h.log.sent, ['yes please, the full details']);
});

test('after PG1 finishes talking uninterrupted, whatever the recogniser heard from the speaker is thrown away', async () => {
  const f = makeFakes();
  await f.conv.start();
  f.setPlaying(true);
  await f.frames(0.1, 3);
  f.rec.hear('want the full details', { final: true });
  f.setPlaying(false);
  const before = f.rec.calls.length;
  await f.frames(0.1, 2);
  assert.ok(f.rec.calls.slice(before).includes('abort'), 'recogniser restarted clean after playback');
  assert.equal(f.conv.state, 'listening');
});

test('the wake word is normalised in a conversation turn', async () => {
  const f = makeFakes();
  await f.conv.start();
  await f.frames(0.9, 8);
  f.rec.hear('April what is the status', { final: true });
  await f.frames(0.05, 27);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['PG1 what is the status']);
});

test('auto-off: two minutes without speech switches the conversation off and closes the mic', async () => {
  const f = makeFakes();
  await f.conv.start();
  await f.frames(0.9, 8);
  await f.frames(0.05, 27);
  await settle(); await settle();
  // 119 s of silence: still on.
  await f.clock.advance(119000 - 35 * 32);
  await f.frames(0.05, 1);
  assert.ok(f.conv.on);
  await f.clock.advance(1500);
  await f.frames(0.05, 1);
  assert.ok(!f.conv.on, 'off after two minutes of silence');
  assert.equal(f.conv.stopReason, 'silence');
  assert.equal(f.log.states.at(-1), 'off:silence');
  assert.ok(f.mic.closed, 'the mic is released');
  assert.ok(!f.rec.running, 'the recogniser is stopped');
});

test('speech resets the auto-off clock', async () => {
  const f = makeFakes();
  await f.conv.start();
  await f.clock.advance(100000);
  await f.frames(0.9, 8);      // speech at ~100 s
  await f.clock.advance(100000);
  await f.frames(0.05, 1);
  assert.ok(f.conv.on, 'only 100 s since the last speech');
});

test('a hidden page, dictation, or a tap stops it; a second start works; nothing is sent after stop', async () => {
  const f = makeFakes();
  await f.conv.start();
  await f.conv.stop('hidden');
  assert.ok(!f.conv.on);
  assert.equal(f.log.states.at(-1), 'off:hidden');
  assert.ok(f.mic.closed);
  f.mic.closed = false;
  assert.ok(await f.conv.start());
  await f.frames(0.9, 8);
  f.rec.hear('half a sentence', { final: true });
  await f.conv.stop('tap');
  await f.frames(0.05, 0);
  await f.clock.advance(3000);
  assert.deepEqual(f.log.sent, [], 'a turn cut off by stop is not sent');
  assert.equal(f.log.states.at(-1), 'off:tap');
});

// --- the module as a plain browser script (regression: "root is not defined") ------------

test('the browser helpers read the page globals through the wrapper\'s root, as a plain script with nothing else defined', async () => {
  // Chrome on a Pixel 9a: the factory took no argument, so every helper that
  // touched `root` threw "root is not defined" and the toast showed it.
  // A bare context: no navigator, no document, no Node globals.
  const bare = loadModule();
  await assert.rejects(bare.openMicrophone(), { message: 'Microphone is not available.' });
  await assert.rejects(bare.loadOnnxRuntime(), { message: 'no document' });

  // The wrapper's parameter is the only `root`: the factory names it too.
  assert.match(moduleSrc, /\(function \(root, factory\) \{\s*const api = factory\(root\);/);
  assert.match(moduleSrc, /\}\)\(typeof globalThis !== 'undefined' \? globalThis : [^,]+, function \(root\) \{/);
  // No Node-only or harness-only identifiers are needed to run it.
  assert.doesNotMatch(moduleSrc, /(?<![.\w])(?:require\s*\(|process\s*\.|Buffer\s*[.(]|__dirname|__filename|setImmediate)/, 'nothing Node-only');
  assert.match(moduleSrc, /if \(typeof module === 'object' && module\.exports\)/, 'module is only touched behind typeof');

  // With the page's globals in place the helpers use them: a fake
  // getUserMedia that is refused reaches the mic path, not a ReferenceError.
  const refused = new Error('Permission denied');
  const withNav = loadModule({ navigator: { mediaDevices: { getUserMedia: async () => { throw refused; } } } });
  await assert.rejects(withNav.openMicrophone(), refused);
  const withDoc = loadModule({
    WebAssembly: {},
    document: { createElement: () => ({}), head: { appendChild(s) { setTimeout(() => s.onerror(), 0); } } }
  });
  await assert.rejects(withDoc.loadOnnxRuntime(), { message: 'onnxruntime-web failed to load' });
});

test('phrase hints: with SpeechRecognitionPhrase on the page the recogniser gets "PG1" as a hint; without it, nothing breaks', async () => {
  class SpeechRecognitionPhrase { constructor(phrase, boost) { this.phrase = phrase; this.boost = boost; } }
  const W = loadModule({ SpeechRecognitionPhrase });
  const rec = { phrases: null, start() { rec.running = true; }, stop() {}, abort() {} };
  const conv = W.createConversation({
    createRecognition: () => rec,
    openMic: async () => ({ onFrame() {}, async close() {} }),
    loadVad: async () => ({ name: 'fake', process: async () => 0 }),
    onError: (m) => { throw new Error(m); }
  });
  assert.ok(await conv.start());
  assert.ok(Array.isArray(rec.phrases) && rec.phrases.length === 1);
  assert.equal(rec.phrases[0].phrase, 'PG1');
  assert.ok(rec.phrases[0] instanceof SpeechRecognitionPhrase);
  await conv.stop('tap');

  const rec2 = { start() {}, stop() {}, abort() {} };   // no `phrases` property: hints unsupported
  const conv2 = V.createConversation({ createRecognition: () => rec2, openMic: async () => ({ onFrame() {}, async close() {} }), loadVad: async () => ({ name: 'fake', process: async () => 0 }) });
  assert.ok(await conv2.start());
  assert.equal(rec2.phrases, undefined);
  await conv2.stop('tap');
});

test('start fails cleanly without a recogniser or a mic, and reports it', async () => {
  const f = makeFakes({ recognitionAvailable: false });
  assert.equal(await f.conv.start(), false);
  assert.ok(!f.conv.on);
  assert.match(f.log.errors[0], /Speech recognition is not available/);
  assert.equal(f.log.states.at(-1), 'off:error');

  const g = makeFakes({ micFails: true });
  assert.equal(await g.conv.start(), false);
  assert.match(g.log.errors[0], /Microphone is not available/);
});

test('the recogniser is restarted when it ends on its own, and a refused mic stops the conversation', async () => {
  const f = makeFakes();
  await f.conv.start();
  f.rec.running = false;
  f.rec.onend();
  await f.clock.advance(150);
  assert.ok(f.rec.running, 'restarted after an unprompted end');
  f.rec.onerror({ error: 'not-allowed' });
  await settle(); await settle();
  assert.ok(!f.conv.on);
  assert.equal(f.conv.stopReason, 'error');
  assert.match(f.log.errors[0], /Microphone access was refused/);
});

test('a frame the detector cannot score switches to the energy detector instead of going deaf', async () => {
  const f = makeFakes();
  let calls = 0;
  const broken = { name: 'silero', process: async () => { calls++; throw new Error('wasm trap'); } };
  const conv = V.createConversation({
    now: f.clock.now, setTimeout: f.clock.setTimeout, clearTimeout: f.clock.clearTimeout,
    createRecognition: () => f.rec, openMic: async () => f.mic, loadVad: async () => broken,
    isPlaying: () => false, isBusy: () => false, send: () => {}, onError: (m) => f.log.errors.push(m)
  });
  await conv.start();
  assert.equal(conv.vadName, 'silero');
  let cb; f.mic.onFrame = (c) => { cb = c; };
  conv.feedFrame(sine(0.2));
  await settle(); await settle();
  assert.equal(conv.vadName, 'energy');
  assert.equal(calls, 1);
  assert.match(f.log.errors[0], /basic detector/);
  void cb;
  await conv.stop('tap');
});

// --- the server: OPERATOR/AGENT transcript labels never reach a reply --------------------

test('stripTranscriptLabels drops OPERATOR: lines, removes AGENT: labels, leaves code and mid-sentence text alone', () => {
  assert.equal(stripTranscriptLabels('AGENT: All good.\nOPERATOR: what is up\nAGENT: Nothing new.'), 'All good.\nNothing new.');
  assert.equal(stripTranscriptLabels('OPERATOR: echo first\nReal answer.'), 'Real answer.');
  assert.equal(stripTranscriptLabels('**AGENT:** bold label\n- OPERATOR: list echo\n> AGENT: quoted'), 'bold label\n> quoted');
  assert.equal(stripTranscriptLabels('Plain reply with AGENT: inside a sentence.'), 'Plain reply with AGENT: inside a sentence.');
  assert.equal(stripTranscriptLabels('```\nAGENT: in code\n```', { inFence: true }), '```\nAGENT: in code\n```');
  assert.equal(stripTranscriptLabels('AGENT: continued', { lineStart: false }), 'AGENT: continued', 'mid-line text is not a label');
  const secretLine = `OPERATOR: my key is ${FAKE.googleKey}\nAGENT: I will not repeat that.`;
  assert.equal(stripTranscriptLabels(secretLine), 'I will not repeat that.');
});

test('the streaming scrubber strips labels even when a chunk boundary splits them', () => {
  let out = '';
  const sc = createReplyScrubber((c) => { out += c; });
  for (const ch of ['AGE', 'NT: Hello there.\n', 'OPERATOR: hi\nAG', 'ENT: And more text that is long enough to be released from the hold buffer, well beyond ninety six characters for sure.']) sc.push(ch);
  sc.flush();
  assert.equal(out, 'Hello there.\nAnd more text that is long enough to be released from the hold buffer, well beyond ninety six characters for sure.');
  assert.equal(sc.text, out);
});

test('the chat prompt tells the model the transcript lines are background only', () => {
  const chat = readFileSync(join(ROOT, 'api/chat.mjs'), 'utf-8');
  assert.match(chat, /\[CONTEXT\]: The OPERATOR: and AGENT: lines below are the recent conversation, for background only\. Never quote, repeat or continue them/);
  assert.match(chat, /stripTranscriptLabels\(scrubIdentity\(modelFetchResult\.text, \{ replacement: identityChoice\.reply \}\)\)/);
  assert.match(chat, /Conversation mode is the switch beside the mic/);
});

// --- the page ---------------------------------------------------------------------------

test('the page: switch beside the mic, status line with announcer, the module served from this app, no CDN', () => {
  assert.match(html, /<script src="\/voice\/conversation\.js"><\/script>/);
  assert.doesNotMatch(html, /https?:\/\/[^"']*(?:cdn|unpkg|jsdelivr|googleapis\.com\/js)/i, 'no third-party script host');
  assert.match(html, /<button type="button" id="converse-btn" class="icon-btn" role="switch" aria-checked="false" title="Conversation mode" aria-label="Conversation mode" aria-describedby="converse-hint"/);
  assert.match(html, /<div id="converse-status" class="converse-status" hidden><span class="converse-dot" aria-hidden="true"><\/span><span class="converse-label">Listening<\/span><span class="converse-live" aria-hidden="true"><\/span><span class="converse-countdown" aria-hidden="true"><\/span><\/div>/);
  assert.match(html, /<div id="converse-announcer" class="sr-only" role="status" aria-live="polite"><\/div>/);
  // Mic constraints and the self-hosted files.
  assert.match(moduleSrc, /echoCancellation: true, noiseSuppression: true, autoGainControl: true/);
  assert.match(moduleSrc, /'\/voice\/silero_vad_v5\.onnx'/);
  assert.match(moduleSrc, /'\/voice\/ort\.wasm\.min\.js'/);
  assert.doesNotMatch(moduleSrc, /https?:\/\//, 'the module never loads from a URL off this origin');
  for (const file of ['ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'silero_vad_v5.onnx', 'vad-worklet.js', 'LICENSE-onnxruntime.txt', 'LICENSE-silero-vad.txt']) {
    assert.ok(readFileSync(join(ROOT, 'public/voice', file)).length > 0, `public/voice/${file} is shipped`);
  }
});

test('deployment: the Silero files are served from /voice/ with explicit content types, and no CSP blocks wasm', () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf-8'));
  const byKey = (rule) => Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
  const rule = (source) => vercel.headers.find((h) => h.source === source);
  // The runtime asks for `${wasmPaths}ort-wasm-simd-threaded.{mjs,wasm}` with wasmPaths '/voice/'.
  assert.match(moduleSrc, /wasmPath = '\/voice\/'/);
  assert.match(moduleSrc, /ort\.env\.wasm\.wasmPaths = wasmPath/);
  assert.equal(byKey(rule('/voice/ort-wasm-simd-threaded.wasm'))['Content-Type'], 'application/wasm', 'streaming wasm compilation needs application/wasm');
  assert.match(byKey(rule('/voice/ort-wasm-simd-threaded.mjs'))['Content-Type'], /^(text|application)\/javascript/, 'the runtime import()s this module');
  assert.equal(byKey(rule('/voice/silero_vad_v5.onnx'))['Content-Type'], 'application/octet-stream');
  // No rewrite sends /voice/ anywhere else.
  assert.ok(!(vercel.rewrites || []).some((r) => /voice/.test(r.source)), 'no rewrite touches /voice/');
  // A Content-Security-Policy, if one is ever added, must let the wasm run.
  for (const h of vercel.headers) {
    const csp = byKey(h)['Content-Security-Policy'];
    if (csp) assert.match(csp, /'wasm-unsafe-eval'|'unsafe-eval'/, `${h.source}: CSP must allow wasm`);
  }
  const metaCsp = html.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*>/i);
  if (metaCsp) assert.match(metaCsp[0], /'wasm-unsafe-eval'|'unsafe-eval'/, 'page CSP must allow wasm');
});

test('the page: hidden page and dictation stop the conversation; Spoken replies off stops it; barge-in aborts with "Interrupted"', () => {
  assert.match(html, /if \(document\.visibilityState === 'hidden'\) \{[\s\S]{0,400}stopConversation\('hidden'\)/);
  assert.match(html, /stopConversation\('dictation'\);\s*recognition\.lang = speechLanguage\(\);\s*recognition\.start\(\);/);
  assert.match(html, /stopVoicePlayback\(\);\s*\/\/ Conversation mode needs spoken replies; off means off\.\s*stopConversation\('tap'\);/);
  assert.match(html, /function interruptDirectives\(\) \{\s*stopVoicePlayback\(\);\s*inFlightDirectives\.forEach\(\(stop\) => stop\('interrupted'\)\);/);
  assert.match(html, /note = streamed\.text \? 'Interrupted\. The reply above is incomplete\.' : 'Interrupted before a reply arrived\.';/);
  assert.match(html, /abortRequests: \(\) => interruptDirectives\(\)/);
  assert.match(moduleSrc, /autoOffSilenceMs: 120000/, 'auto-off is two minutes');
});

test('the page: calm style, both themes, reduced motion, screen-reader announcements, no emoji in new text', () => {
  const css = html.slice(html.indexOf('/* Conversation mode:'), html.indexOf('.execute-btn {'));
  assert.match(css, /\.converse-status \{[^}]*color: var\(--text-2\)/, 'status text uses the AA body colour');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.converse-dot::after \{ animation: none !important; opacity: 0; \}/);
  assert.match(css, /@media \(forced-colors: active\) \{\s*\.converse-dot \{ background: CanvasText !important; \}/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i, 'no hard-coded colours: tokens only, so light and dark both work');
  const glue = html.slice(html.indexOf('// CONVERSATION MODE (PG1 voice, phase 2)'), html.indexOf('function setVoiceActive('));
  assert.match(glue, /CONVERSATION_LABELS = \{ listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', starting: 'Starting', off: '' \}/);
  assert.match(glue, /'Conversation off after two minutes of silence\.'/);
  assert.match(glue, /'Conversation on\. Listening\.'/);
  // UI text: the page glue, the styles, the composer markup and every string literal in the module.
  const moduleStrings = (moduleSrc.match(/'[^'\\n]*'/g) || []).join(' ');
  const newText = glue + css + moduleStrings + html.slice(html.indexOf('id="converse-btn"'), html.indexOf('id="converse-btn"') + 600);
  assert.doesNotMatch(newText, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji');
  assert.doesNotMatch(newText, /\b(?:Google|Gemini|Anthropic|Claude|OpenAI|Microsoft|Silero|ONNX|Cartesia)\b/, 'no third-party branding in UI text or strings');
});

// --- Android: the recogniser and our mic stream cannot share the microphone -------------
//
// Pixel 9a, Chrome: the switch showed "Listening" and speaking did nothing.
// The system speech service and the page's getUserMedia stream both want the
// mic and the platform gives it to one of them. In exclusive mode no stream
// is held while recognising; the recogniser's own events drive the turn.

test('exclusive mode: no mic stream while recognising; the turn ends 1.5 s after the last result and is sent once', async () => {
  const f = makeFakes({ micMode: 'exclusive' });
  assert.ok(await f.conv.start());
  assert.equal(f.conv.micMode, 'exclusive');
  assert.equal(f.conv.endOfTurnMs, 1500, 'the recogniser-timed window is 1.5 s');
  assert.equal(f.log.micOpens, 0, 'no getUserMedia stream was opened');
  assert.equal(f.conv.micOpen, false);
  assert.ok(f.rec.running, 'the recogniser has the microphone to itself');
  assert.equal(f.rec.continuous, false, 'one utterance per session, restarted after each');
  assert.ok(f.rec.interimResults);
  assert.equal(f.conv.state, 'listening');

  // Interim results keep the turn open: each one restarts the 1.5 s.
  f.rec.onspeechstart();
  f.rec.hear('what is');
  await f.clock.advance(1200);
  f.rec.hear('what is the threat');
  await f.clock.advance(1200);
  assert.deepEqual(f.log.sent, [], '1200 ms after the latest result: not yet');
  assert.equal(f.log.transcripts.at(-1), 'what is the threat', 'the live guess goes to the indicator');
  f.rec.hear('what is the threat level', { final: true });
  f.rec.onspeechend();
  await f.clock.advance(1490);
  assert.deepEqual(f.log.sent, [], '1490 ms: not yet');
  await f.clock.advance(20);
  // The recogniser is stopped to flush, ends, and the turn is sent.
  assert.ok(f.rec.calls.includes('stop'));
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['what is the threat level']);
  assert.equal(f.conv.state, 'thinking');
  assert.equal(f.log.transcripts.at(-1), '');
  await f.clock.advance(100);
  assert.ok(f.rec.running, 'listening again for the next turn');
  await f.clock.advance(3000);
  assert.deepEqual(f.log.sent, ['what is the threat level'], 'sent exactly once');
  assert.equal(f.log.micOpens, 0, 'still no stream of our own');
});

test('exclusive mode: a session that ends on its own with a final result keeps the turn open for the window, restarts at once, then sends (Android ends one after each final)', async () => {
  const f = makeFakes({ micMode: 'exclusive' });
  await f.conv.start();
  f.rec.hear('read the error log', { final: true });
  f.rec.end();
  await settle(); await settle();
  assert.deepEqual(f.log.sent, [], 'the end of the session is not the end of the turn');
  await f.clock.advance(0);
  assert.ok(f.rec.running, 'the recogniser restarted at once');
  assert.equal(f.log.transcripts.at(-1), 'read the error log', 'the words stay on the indicator');
  await f.clock.advance(1490);
  assert.deepEqual(f.log.sent, [], 'inside the window: more could follow');
  await f.clock.advance(20);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['read the error log'], 'sent once the window closes with nothing more');
  await f.clock.advance(100);
  assert.ok(f.rec.running, 'restarted');
  // A session that ends with nothing in it just restarts.
  f.rec.end();
  await f.clock.advance(150);
  assert.ok(f.rec.running);
  assert.deepEqual(f.log.sent, ['read the error log']);
});

// --- Android's result pattern: the whole phrase re-sent on every update ------------------

test('transcript buffer: a re-sent phrase replaces the shorter one, a prefix or repeat is dropped, a new phrase is added', () => {
  const m = (phrases, text) => plain(V.mergePhrase(phrases, text));
  assert.deepEqual(m([], "what's"), ["what's"]);
  assert.deepEqual(m(["what's"], "what's in"), ["what's in"]);
  assert.deepEqual(m(["what's in"], "what's in my error log"), ["what's in my error log"]);
  assert.deepEqual(m(["what's in my error log"], "what's in"), ["what's in my error log"], 'a shorter version is dropped');
  assert.deepEqual(m(["what's in my error log"], "What's in my error log."), ["what's in my error log"], 'a repeat is dropped, whatever its case and punctuation');
  assert.deepEqual(m(['whats in'], "what's in my log"), ["what's in my log"], 'apostrophes do not tell phrases apart');
  assert.deepEqual(m(["what's in my error log"], 'and the vault'), ["what's in my error log", 'and the vault'], 'a new phrase is added');
  assert.deepEqual(m(["what's in my error log", 'and the'], 'and the vault'), ["what's in my error log", 'and the vault'], 'the last phrase grows');
  assert.deepEqual(m(['hello there', 'what is'], 'hello there what is in the log'), ['hello there what is in the log'], 'the whole turn re-sent with more words is the turn');
  assert.deepEqual(m(['hello there', 'what is in the log'], 'hello there what'), ['hello there', 'what is in the log'], 'a prefix of the whole turn is dropped');
  assert.deepEqual(m(['a'], '  '), ['a']);
  assert.deepEqual(m(['a'], '...'), ['a'], 'punctuation alone is nothing');
  assert.ok(V.isPhrasePrefix("what's", 'Whats in'));
  assert.ok(!V.isPhrasePrefix('what', "what's in"), 'a prefix ends at a word boundary');
  assert.ok(!V.isPhrasePrefix('', 'anything'));

  const b = V.createTranscriptBuffer();
  b.setInterim(["what's"]);
  b.setInterim(["what's in"]);
  assert.equal(b.text, "what's in", 'the preview is overwritten on each update');
  assert.equal(b.finalText, '');
  b.setInterim(["what's", "what's in my"]);          // cumulative interims in one event
  assert.equal(b.interimText, "what's in my");
  b.addFinal("what's");
  b.addFinal("what's in");
  b.addFinal("what's in my error log");
  b.setInterim([]);
  assert.equal(b.finalText, "what's in my error log", 'cumulative finals: the longest version, once');
  assert.equal(b.text, "what's in my error log");
  b.setInterim(["what's in my error log and"]);
  assert.equal(b.text, "what's in my error log and", 'the preview adds what lies beyond the finals');
  assert.equal(b.finalText, "what's in my error log", 'without joining them');
  b.setInterim(["what's in my error log"]);
  assert.equal(b.text, "what's in my error log", 'a preview that repeats the finals adds nothing');
  b.clear();
  assert.equal(b.text, '');
  assert.equal(b.interimText, '');
});

test('exclusive mode, Android pattern: cumulative interims and cumulative finals in one session are one clean message', async () => {
  const f = makeFakes({ micMode: 'exclusive' });
  await f.conv.start();
  assert.equal(f.rec.continuous, false);
  f.rec.onspeechstart();
  for (const t of ["what's", "what's in", "what's in my", "what's in my error"]) { f.rec.hear(t); await f.clock.advance(150); }
  assert.equal(f.log.transcripts.at(-1), "what's in my error", 'the live guess is overwritten, never appended');
  assert.equal(f.conv.diagnostics.interim, "what's in my error");
  for (const t of ["what's", "what's in", "what's in my error log"]) { f.rec.hear(t, { final: true }); await f.clock.advance(50); }
  assert.equal(f.log.transcripts.at(-1), "what's in my error log", 'each final replaces the shorter one');
  let d = f.conv.diagnostics;
  assert.equal(d.raw, "what's in my error log", 'what the recogniser last delivered');
  assert.equal(d.interim, "what's in my error log", 'and the cleaned turn');
  f.rec.onspeechend();
  f.rec.end();                                     // Android ends the session after the final
  await f.clock.advance(1500);                     // ...and the window closes with nothing more
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ["what's in my error log"], 'exactly one clean message');
  assert.ok(f.log.transcripts.every((t) => !/what's.+what's/.test(t)), 'no stacked text was ever shown');
  d = f.conv.diagnostics;
  assert.equal(d.interim, '', 'the buffer is empty once sent');
  assert.equal(d.raw, '');
  await f.clock.advance(3500);
  assert.deepEqual(f.log.sent, ["what's in my error log"], 'and nothing more came of it');

  // Cumulative finals that arrive as separate results of one event, from
  // resultIndex onward: the earlier results of the event are not re-read.
  const g = makeFakes({ micMode: 'exclusive' });
  await g.conv.start();
  g.rec.onresult({ resultIndex: 1, results: [{ isFinal: true, 0: { transcript: 'stale from before' } }, { isFinal: true, 0: { transcript: "what's" } }, { isFinal: true, 0: { transcript: "what's in my error log" } }] });
  assert.equal(g.conv.diagnostics.interim, "what's in my error log");
  g.rec.end();
  await g.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(g.log.sent, ["what's in my error log"]);
});

test('exclusive mode: the same final handed back after the restart, or a result arriving after the send, never becomes a second message', async () => {
  const f = makeFakes({ micMode: 'exclusive' });
  await f.conv.start();
  f.rec.hear("what's in my error log", { final: true });
  f.rec.end();
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ["what's in my error log"]);
  await f.clock.advance(100);
  assert.ok(f.rec.running, 'restarted for the next turn');
  // Android: the new session opens with the previous turn again.
  f.rec.hear("what's in my error log");
  assert.equal(f.log.transcripts.at(-1), '', 'not previewed');
  f.rec.hear("what's in my error log", { final: true });
  assert.equal(f.conv.diagnostics.lastEvent, 'result:stale');
  assert.equal(f.conv.diagnostics.raw, "what's in my error log", 'shown as heard in the diagnostics');
  assert.equal(f.conv.diagnostics.interim, '', 'but not in the turn');
  f.rec.end();
  await f.clock.advance(1000);
  assert.ok(f.rec.running);
  assert.deepEqual(f.log.sent, ["what's in my error log"], 'not sent again');
  // Part of it, late, is the same thing.
  f.rec.hear("what's in", { final: true });
  await f.clock.advance(900);
  assert.deepEqual(f.log.sent, ["what's in my error log"]);
  // The operator's next, different turn goes through, and it alone.
  f.rec.hear("what's in the vault", { final: true });
  f.rec.end();
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ["what's in my error log", "what's in the vault"]);
  // Well after a send, the same words again are the operator repeating them.
  await f.clock.advance(DEFAULTS.staleResultMs + 100);
  f.rec.hear("what's in the vault", { final: true });
  f.rec.end();
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ["what's in my error log", "what's in the vault", "what's in the vault"]);
});

test('exclusive mode: the buffer is emptied when PG1 starts talking and at the barge-in, so the next turn is only the new words', async () => {
  const f = makeFakes({ micMode: 'exclusive' });
  await f.conv.start();
  f.rec.hear('what is');
  assert.equal(f.conv.diagnostics.interim, 'what is');
  f.setBusy(true);
  f.setPlaying(true);
  await f.clock.advance(120);
  assert.equal(f.conv.state, 'speaking');
  assert.equal(f.conv.diagnostics.interim, '', 'emptied when the recogniser was paused for playback');
  assert.equal(f.log.transcripts.at(-1), '');
  await f.frames(0.95, 12);
  assert.equal(f.log.states.at(-1), 'listening:interrupted');
  assert.equal(f.conv.diagnostics.interim, '', 'and empty after the barge-in');
  await f.clock.advance(100);
  assert.ok(f.rec.running);
  f.rec.hear('no, the vault', { final: true });
  f.rec.end();
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['no, the vault']);
});

test('shared mode: cumulative finals are one message, and a late result after the send does not join the next turn', async () => {
  const f = makeFakes();
  await f.conv.start();
  await f.frames(0.9, 10);
  f.rec.hear("what's");
  f.rec.hear("what's in my");
  f.rec.hear("what's", { final: true });
  f.rec.hear("what's in", { final: true });
  assert.equal(f.log.transcripts.at(-1), "what's in");
  f.rec.finalOnStop = "what's in my error log";
  await f.frames(0.05, 26);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ["what's in my error log"]);
  await f.clock.advance(100);
  assert.ok(f.rec.running);
  // The recogniser delivers the turn again, late, into the new session.
  f.rec.hear("what's in my error log", { final: true });
  assert.equal(f.conv.diagnostics.interim, '', 'not the next turn');
  assert.ok(!f.conv.tracker.inTurn, 'and not speech');
  // The next turn is only what the operator says next.
  await f.frames(0.9, 10);
  f.rec.hear('and the vault');
  f.rec.finalOnStop = 'and the vault';
  await f.frames(0.05, 26);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ["what's in my error log", 'and the vault']);
  await f.clock.advance(3500);
  assert.deepEqual(f.log.sent, ["what's in my error log", 'and the vault'], 'one message per turn');
});

test('exclusive mode: while PG1 talks the recogniser is off and our stream is open for barge-in; speaking over PG1 interrupts', async () => {
  const f = makeFakes({ micMode: 'exclusive' });
  await f.conv.start();
  f.setBusy(true);
  f.setPlaying(true);
  await f.clock.advance(120);                   // one poll
  assert.equal(f.conv.state, 'speaking');
  assert.ok(!f.rec.running, 'the recogniser would only hear the speaker: stopped');
  assert.equal(f.log.micOpens, 1, 'our own stream is open for the detector');
  assert.ok(f.conv.micOpen);
  // Ordinary levels and a short burst do nothing.
  await f.frames(0.7, 20);
  await f.frames(0.95, 8);
  await f.frames(0.1, 5);
  assert.equal(f.log.stops, 0);
  await f.frames(0.95, 11);
  assert.equal(f.log.stops, 1, 'playback stopped');
  assert.equal(f.log.aborts, 1, 'the reply was abandoned');
  assert.ok(f.mic.closed, 'the stream is released so the recogniser can have the mic');
  assert.equal(f.log.states.at(-1), 'listening:interrupted');
  await f.clock.advance(100);
  assert.ok(f.rec.running, 'the recogniser is back');
  // The operator's new turn is captured from the recogniser.
  f.rec.hear('no, show me the vault', { final: true });
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['no, show me the vault']);
});

test('exclusive mode: when PG1 finishes uninterrupted the stream closes and the recogniser restarts; an unopenable stream only costs barge-in', async () => {
  const f = makeFakes({ micMode: 'exclusive' });
  await f.conv.start();
  f.setPlaying(true);
  await f.clock.advance(120);
  assert.equal(f.log.micOpens, 1);
  await f.frames(0.1, 3);
  f.setPlaying(false);
  await f.clock.advance(120);
  assert.ok(f.mic.closed, 'stream closed');
  await f.clock.advance(100);
  assert.ok(f.rec.running, 'recogniser restarted');
  assert.equal(f.conv.state, 'listening');
  await f.conv.stop('tap');

  const g = makeFakes({ micMode: 'exclusive', micFails: true });
  assert.ok(await g.conv.start(), 'starts without a stream of its own');
  g.setPlaying(true);
  await g.clock.advance(120);
  await settle();
  assert.equal(g.conv.state, 'speaking');
  assert.match(g.conv.diagnostics.lastError, /Microphone is not available/);
  g.setPlaying(false);
  await g.clock.advance(220);
  assert.ok(g.rec.running, 'still listening after playback');
  assert.deepEqual(g.log.errors, [], 'no toast: only barge-in was lost');
});

test('shared mode switches to exclusive on an audio-capture error: the stream closes and the next turn comes from the recogniser alone', async () => {
  const f = makeFakes();
  await f.conv.start();
  assert.equal(f.conv.micMode, 'shared');
  assert.equal(f.log.micOpens, 1);
  f.rec.error('audio-capture');
  await settle(); await settle();
  assert.equal(f.conv.micMode, 'exclusive');
  assert.ok(f.mic.closed, 'our stream was released');
  await f.clock.advance(100);
  assert.ok(f.rec.running, 'the recogniser was restarted with the mic to itself');
  assert.deepEqual(f.log.statuses, [], 'one switch is silent: nothing is wrong yet');
  assert.equal(f.conv.endOfTurnMs, 1500, 'the window follows the mode: recogniser-timed turns get 1.5 s');
  f.rec.hear('what is the threat level', { final: true });
  await f.clock.advance(1500);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['what is the threat level']);
  assert.ok(f.log.diags.some((d) => d.lastEvent === 'mic_contention:audio-capture'));
});

test('shared mode switches to exclusive on no-speech moments after a start, or on two detector turns the recogniser transcribed as nothing', async () => {
  const f = makeFakes();
  await f.conv.start();
  await f.clock.advance(2000);
  f.rec.error('no-speech');                      // 2 s in: desktop takes ~8 s
  await settle(); await settle();
  assert.equal(f.conv.micMode, 'exclusive');
  await f.conv.stop('tap');

  const g = makeFakes();
  await g.conv.start();
  await g.clock.advance(9000);
  g.rec.error('no-speech');                      // a quiet room: routine
  await settle(); await settle();
  assert.equal(g.conv.micMode, 'shared');
  await g.clock.advance(200);
  // The detector hears a turn, the recogniser says nothing. Twice.
  await g.frames(0.9, 8);
  await g.frames(0.05, 27);
  await settle(); await settle();
  assert.equal(g.conv.micMode, 'shared', 'once could be a cough');
  await g.clock.advance(200);
  await g.frames(0.9, 8);
  await g.frames(0.05, 27);
  await settle(); await settle();
  assert.equal(g.conv.micMode, 'exclusive');
  assert.ok(g.mic.closed);
  assert.deepEqual(g.log.sent, []);
  await g.clock.advance(100);
  assert.ok(g.rec.running);
});

test('a result in shared mode is what keeps it shared: an empty turn after a real one does not count twice', async () => {
  const f = makeFakes();
  await f.conv.start();
  await f.frames(0.9, 8);
  await f.frames(0.05, 27);
  await settle(); await settle();
  await f.clock.advance(200);
  await f.frames(0.9, 8);
  f.rec.hear('status please', { final: true });
  await f.frames(0.05, 27);
  await settle(); await settle();
  assert.deepEqual(f.log.sent, ['status please']);
  await f.clock.advance(200);
  await f.frames(0.9, 8);
  await f.frames(0.05, 27);
  await settle(); await settle();
  assert.equal(f.conv.micMode, 'shared');
});

test('the recogniser is restarted after every end with backoff (100, 200, 400 ... 5000 ms), reset by a result', async () => {
  const f = makeFakes();
  await f.conv.start();
  const gaps = [];
  for (let i = 0; i < 8; i++) {
    const endedAt = f.clock.now();
    f.rec.end();                                  // dies at once, no results
    let waited = 0;
    while (!f.rec.running && waited < 10000) { await f.clock.advance(10); waited += 10; }
    gaps.push(f.clock.now() - endedAt);
  }
  assert.deepEqual(gaps, [100, 200, 400, 800, 1600, 3200, 5000, 5000]);
  assert.ok(f.conv.on, 'still on, still retrying');
  assert.equal(f.log.statuses.at(-1), 'Speech recognition keeps stopping. Retrying.', 'the status line says so instead of a silent Listening');
  // A result clears the streak and the status line.
  f.rec.hear('hello');
  assert.equal(f.log.statuses.at(-1), '');
  f.rec.end();
  const endedAt = f.clock.now();
  await f.clock.advance(100);
  assert.ok(f.rec.running);
  assert.equal(f.clock.now() - endedAt, 100);
  // A long quiet session (no-speech after 8 s) is healthy too.
  await f.clock.advance(9000);
  f.rec.error('no-speech');
  await settle(); await settle();
  await f.clock.advance(100);
  assert.ok(f.rec.running);
  assert.equal(f.conv.diagnostics.failStreak, 0);
});

test('persistent recogniser errors reach the status line: audio-capture, network, no-speech; not-allowed stops the conversation', async () => {
  const f = makeFakes({ micMode: 'exclusive' });
  await f.conv.start();
  f.rec.error('audio-capture');
  await settle(); await settle();
  assert.deepEqual(f.log.statuses, [], 'one failure is retried quietly');
  await f.clock.advance(200);
  assert.ok(f.rec.running);
  f.rec.error('audio-capture');
  await settle(); await settle();
  assert.equal(f.log.statuses.at(-1), 'Speech recognition cannot reach the microphone. Retrying.');
  assert.ok(f.conv.on);
  await f.clock.advance(5000);
  assert.ok(f.rec.running, 'still retrying');
  f.rec.hear('back', { final: true });
  assert.equal(f.log.statuses.at(-1), '', 'cleared by a result');
  await f.clock.advance(1600); await settle(); await settle();
  assert.deepEqual(f.log.sent, ['back']);

  f.rec.error('network');
  await settle(); await settle();
  assert.equal(f.log.statuses.at(-1), 'Speech recognition needs a network connection. Retrying.');
  assert.deepEqual(f.log.errors, ['Speech recognition needs a network connection.'], 'toasted once');
  await f.clock.advance(5000);
  f.rec.error('network');
  await settle(); await settle();
  assert.equal(f.log.errors.length, 1, 'not toasted again');
  await f.clock.advance(300);                    // past the 200 ms backoff
  assert.ok(f.rec.running);
  f.rec.hear('ok', { final: true });
  assert.equal(f.log.statuses.at(-1), '', 'cleared by a result');
  await f.clock.advance(1600); await settle(); await settle();

  for (let i = 0; i < 2; i++) { await f.clock.advance(6000); f.rec.error('no-speech'); await settle(); await settle(); }
  assert.equal(f.log.statuses.at(-1), '', 'two quiet sessions are normal');
  await f.clock.advance(6000); f.rec.error('no-speech'); await settle(); await settle();
  assert.equal(f.log.statuses.at(-1), 'No speech heard. Check the microphone.');
  await f.clock.advance(5000);
  assert.ok(f.rec.running);

  f.rec.error('language-not-supported');
  await settle(); await settle();
  await f.clock.advance(5000);
  f.rec.error('language-not-supported');
  await settle(); await settle();
  assert.equal(f.log.statuses.at(-1), 'Speech recognition error: language-not-supported. Retrying.');

  f.rec.error('not-allowed');
  await settle(); await settle();
  assert.ok(!f.conv.on);
  assert.equal(f.conv.stopReason, 'error');
  assert.equal(f.log.errors.at(-1), 'Microphone access was refused.');
  assert.equal(f.log.statuses.at(-1), 'Microphone access was refused. Allow the microphone for this site and switch conversation mode on again.', 'the line outlives the indicator and says why');
  assert.ok(await f.conv.start());
  assert.equal(f.log.statuses.at(-1), '', 'cleared by the next start');
});

test('diagnostics: a live snapshot with recogniser state, last event, last error, interim text (40 chars), detector level and mic state', async () => {
  const f = makeFakes();
  await f.conv.start();
  let d = f.conv.diagnostics;
  assert.deepEqual(Object.keys(d).sort(), ['endOfTurnMs', 'failStreak', 'interim', 'lastError', 'lastEvent', 'micOpen', 'mode', 'raw', 'recogniser', 'session', 'state', 'status', 'vadLevel', 'watchingPlayback'].sort());
  assert.equal(d.mode, 'shared');
  assert.equal(d.session, 1, 'the first recogniser session');
  assert.equal(d.endOfTurnMs, 800, 'the detector-timed window');
  assert.equal(d.recogniser, 'running');
  assert.equal(d.lastEvent, 'start');
  assert.equal(d.lastError, '');
  assert.equal(d.micOpen, true);
  await f.frames(0.37, 1);
  f.rec.onspeechstart();
  f.rec.hear('a transcript that runs on well past the forty character mark');
  d = f.conv.diagnostics;
  assert.equal(d.vadLevel, 0.37);
  assert.equal(d.lastEvent, 'result');
  assert.equal(d.interim, 'a transcript that runs on well past the ');
  assert.equal(d.interim.length, 40);
  assert.equal(d.raw, 'a transcript that runs on well past the ', 'what the recogniser delivered, as it came');
  f.rec.hear('a transcript', { final: true });
  d = f.conv.diagnostics;
  assert.equal(d.raw, 'a transcript');
  assert.equal(d.interim, 'a transcript', 'a final replaces the live guess; the turn is what was finalised');
  f.rec.error('network');
  await settle(); await settle();
  d = f.conv.diagnostics;
  assert.equal(d.lastError, 'network');
  assert.equal(d.lastEvent, 'end');
  assert.equal(d.recogniser, 'restarting');
  assert.ok(f.log.diags.length > 0, 'the page is told on every change');
  await f.conv.stop('tap');
  assert.equal(f.conv.diagnostics.micOpen, false);
});

test('the page: Android starts exclusive, the status line and diagnostics are wired, the composer is blurred and never focused, nothing is stored', () => {
  const glue = html.slice(html.indexOf('// CONVERSATION MODE (PG1 voice, phase 2)'), html.indexOf('function setVoiceActive('));
  // Mode by platform.
  assert.match(glue, /function isAndroidBrowser\(\)/);
  assert.match(glue, /\/\\bAndroid\\b\/i\.test\(navigator\.userAgent/);
  assert.match(glue, /\}, \{ micMode: isAndroidBrowser\(\) \? 'exclusive' : 'shared', endOfTurnOverrideMs: endOfTurnSetting\(\) \}\);/);
  // Status line and diagnostics callbacks.
  assert.match(glue, /onStatus: renderConversationNote,/);
  assert.match(glue, /onDiagnostics: \(snap\) => \{ if \(voiceDiagnosticsOn\) renderConversationDiagnostics\(snap\); \}/);
  assert.match(html, /<div id="converse-note" class="converse-note" role="status" aria-live="polite" hidden><\/div>/);
  assert.match(html, /<div id="converse-diag" class="converse-diag" aria-hidden="true" hidden><\/div>/);
  // The drawer switch: off by default, in memory only.
  assert.match(html, /<span class="drawer-row-label" id="voice-diag-label">[\s\S]*?Voice diagnostics<\/span>\s*<button type="button" id="voice-diag-btn" class="switch" role="switch" aria-checked="false" aria-labelledby="voice-diag-label" onclick="triggerHaptic\(\); toggleVoiceDiagnostics\(\)"><\/button>/);
  assert.match(glue, /let voiceDiagnosticsOn = false;/);
  assert.doesNotMatch(glue, /localStorage|sessionStorage|document\.cookie|indexedDB/, 'diagnostics and the mode are never stored');
  assert.match(glue, /if \(!voiceDiagnosticsOn \|\| !snap \|\| snap\.state === 'off'\) \{ el\.hidden = true; el\.textContent = ''; return; \}/);
  for (const field of ["snap.mode + ' mic'", "'rec ' + snap.recogniser", "'last ' + (snap.lastEvent || '-')", "'err ' + (snap.lastError || 'none')", "'heard \"' + (snap.raw || '') + '\"'", "'turn \"' + (snap.interim || '') + '\"'", "'vad ' + (snap.micOpen ? snap.vadLevel.toFixed(2) : '-')", "'mic ' + (snap.micOpen ? 'open' : 'closed')"]) {
    assert.ok(glue.includes(field), `diagnostics line shows ${field}`);
  }
  // Hands off the composer.
  assert.match(glue, /function blurComposer\(\) \{\s*const input = document\.getElementById\('prompt-input'\);\s*if \(input && document\.activeElement === input\) input\.blur\(\);/);
  assert.match(glue, /if \(isRecording && recognition\) recognition\.stop\(\);\s*blurComposer\(\);/, 'blurred when the mode starts');
  assert.match(glue, /submitDirective\(\);\s*clearComposer\(\);\s*blurComposer\(\);/, 'and after a send');
  assert.doesNotMatch(glue, /\.focus\(\)/, 'conversation mode never focuses anything');
  const submit = html.slice(html.indexOf('async function submitDirective('), html.indexOf('async function submitDirective(') + 20000);
  assert.doesNotMatch(submit.slice(0, submit.indexOf('\n    }\n\n')), /prompt-input'\)\.focus\(\)|input\.focus\(\)/, 'submitDirective does not focus the composer');
});

test('the page: dictation and conversation turns never append to the composer; it is emptied at every turn boundary', () => {
  const dictation = html.slice(html.indexOf("if ('webkitSpeechRecognition' in window"), html.indexOf('function stopRecording('));
  assert.doesNotMatch(dictation, /input\.value \+ ' '|finalTranscript|\+= event\.results/, 'nothing is appended to the composer or across results');
  assert.match(dictation, /for \(let i = event\.resultIndex \|\| 0; i < results\.length; \+\+i\)/, "only this update's results");
  assert.match(dictation, /if \(res\.isFinal\) dictation\.addFinal\(text\);\s*else interims\.push\(text\);/);
  assert.match(dictation, /dictation\.setInterim\(interims\);\s*renderDictation\(\);/, 'the preview is overwritten on each update');
  assert.match(dictation, /dictationBase = document\.getElementById\('prompt-input'\)\.value\.trim\(\);\s*dictation = createDictationBuffer\(\);/, 'one buffer per press of the mic');
  assert.match(dictation, /if \(typeof PG1Voice !== 'undefined' && PG1Voice\.createTranscriptBuffer\) return PG1Voice\.createTranscriptBuffer\(\);/, 'the same buffer as conversation mode');
  assert.match(dictation, /input\.value = \[dictationBase, text\]\.filter\(Boolean\)\.join\(' '\);/, 'the composer is rewritten from the base and the buffer');
  assert.match(dictation, /if \(conversation && conversation\.on\) clearComposer\(\);\s*stopConversation\('dictation'\);/, "the conversation's composer is emptied before dictation takes over");
  assert.match(html, /isRecording = false;\s*dictation = null;/, 'the buffer is dropped when dictation ends');
  const glue = html.slice(html.indexOf('// CONVERSATION MODE (PG1 voice, phase 2)'), html.indexOf('function setVoiceActive('));
  assert.match(glue, /function clearComposer\(\) \{\s*const input = document\.getElementById\('prompt-input'\);\s*if \(!input\) return;\s*input\.value = '';/);
  assert.match(glue, /submitDirective\(\);\s*clearComposer\(\);\s*blurComposer\(\);/, 'emptied right after a send');
  assert.match(glue, /if \(detail === 'started' \|\| detail === 'interrupted' \|\| \(!isOn && detail !== 'dictation'\)\) clearComposer\(\);/, 'and when the mode starts, at a barge-in, and when it stops');
  assert.match(glue, /'heard "' \+ \(snap\.raw \|\| ''\) \+ '"',\s*'turn "' \+ \(snap\.interim \|\| ''\) \+ '"'/, 'the diagnostics line shows what was heard beside the cleaned turn');
});
