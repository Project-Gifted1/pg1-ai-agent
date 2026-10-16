// Spoken replies, start to finish: the bytes from the TTS engine (Cartesia,
// or Gemini as the fallback engine) through the server's aligner
// (lib/voiceStream.mjs createPcmAligner) to the page's player
// (public/index.html createVoicePlayer), checked sample by sample.
//
// The distortion at the start of every spoken reply came from the player:
// it started the first 20-40 ms chunk with only 80 ms of head start, so a
// chunk arriving a little late left a silent gap, a hard cut in the
// waveform, on the first syllables; and the reply started on a non-zero
// sample with no fade. These tests pin the fixes and the safety nets:
// no header is ever played, playback uses the source rate (24 kHz) from
// the first buffer, odd chunk boundaries keep 16-bit alignment, the first
// samples fade in, and nothing plays before the head start is buffered.
//
// tests/fixtures/voice-reply-start.pcm: the first 300 ms of a real spoken
// reply (s16le, 24 kHz, mono), cut to start mid-vowel at sample value 6271,
// as a TTS chunk can.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createPcmAligner, stripWavHeader, createVoiceStream, VOICE_AUDIO_FORMAT } from '../lib/voiceStream.mjs';
import { createRoutedSynth, pcmToWav } from '../lib/ttsRouter.mjs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const FIXTURE = readFileSync(new URL('./fixtures/voice-reply-start.pcm', import.meta.url));
const fixtureSamples = () => Array.from(new Int16Array(FIXTURE.buffer.slice(FIXTURE.byteOffset, FIXTURE.byteOffset + FIXTURE.length)));
const SOURCE_MAX_STEP = (() => { const s = fixtureSamples(); let m = 0; for (let i = 1; i < s.length; i++) m = Math.max(m, Math.abs(s[i] - s[i - 1])); return m; })();

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found in public/index.html`);
  let depth = 0;
  let i = html.indexOf('{', html.indexOf(')', start));
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

const CLIENT = [
  ...html.match(/const VOICE_[A-Z_]+ = [\d.]+;/g).map((l) => l.replace(/^const /, 'var ')),
  'var voiceAudioCtx = null;',
  ...['getVoiceAudioContext', 'primeVoiceOutput', 'stripWavHeader', 'applyFadeIn', 'base64ToBytes', 'pcm16ToFloat32', 'createVoicePlayer'].map(extractFunction)
].join('\n');

// A Web Audio stand-in that records what is scheduled; the clock is moved
// by hand, timers run when the test says.
function makeWorld({ rate = 48000 } = {}) {
  const timers = [];
  const log = { buffers: [], sources: [], gain: [], primed: 0 };
  const audioCtx = {
    state: 'running', currentTime: 1, sampleRate: rate, destination: { id: 'out' },
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      const b = { duration: length / sampleRate, length, sampleRate, getChannelData: () => data };
      log.buffers.push(b);
      return b;
    },
    createBufferSource() {
      const src = { buffer: null, connect(to) { src.to = to; }, disconnect() {}, start(at) { src.startedAt = at; if (src.buffer.getChannelData(0).every((v) => v === 0) && at === 0) log.primed++; else log.sources.push(src); }, stop() {} };
      return src;
    },
    createGain() {
      const g = { gain: { value: 1, setValueAtTime(v, t) { log.gain.push(['set', v, t]); }, linearRampToValueAtTime(v, t) { log.gain.push(['ramp', v, t]); }, cancelScheduledValues() {} }, connect(to) { g.to = to; }, disconnect() {} };
      return g;
    },
    resume: () => Promise.resolve()
  };
  const ctx = {
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    window: { AudioContext: function () { return audioCtx; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    Math, Number, String, Uint8Array, Float32Array, Map, Set, Promise
  };
  vm.createContext(ctx);
  vm.runInContext(CLIENT, ctx);
  const runTimers = () => { for (const t of timers.splice(0)) if (t.fn) t.fn(); };
  // Every scheduled sample, in play order, as 16-bit values.
  const played = () => log.sources.slice().sort((a, b) => a.startedAt - b.startedAt).flatMap((s) => Array.from(s.buffer.getChannelData(0), (v) => Math.round(v * 32768)));
  return { ctx, audioCtx, log, runTimers, played };
}

const ev = (seq, bytes, extra = {}) => ({ seq, sentence: 0, data: Buffer.from(bytes).toString('base64'), encoding: 'pcm_s16le', sample_rate: 24000, ...extra });
const wavWrap = (pcm, rate = 24000) => Buffer.from(pcmToWav(Buffer.from(pcm), rate));
const cut = (buf, sizes) => { const out = []; let o = 0; let i = 0; while (o < buf.length) { const n = sizes[i++ % sizes.length]; out.push(buf.subarray(o, o + n)); o += n; } return out; };

// --- the server's aligner ---------------------------------------------------------------

test('server: a WAV header never reaches the stream, however the chunks split it; the PCM after it is exact', () => {
  const wav = wavWrap(FIXTURE);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  for (const sizes of [[wav.length], [3, 41, 1000], [1], [43, 2], [7, 13, 501]]) {
    const a = createPcmAligner();
    const out = Buffer.concat(cut(wav, sizes).map((c) => Buffer.from(a.push(c.toString('base64')), 'base64')));
    assert.equal(a.end(), 0, String(sizes));
    assert.ok(out.equals(FIXTURE), `header stripped, samples exact (${sizes})`);
    assert.notEqual(out.subarray(0, 4).toString('latin1'), 'RIFF');
  }
  assert.deepEqual(stripWavHeader(new Uint8Array(wav)).sampleRate, 24000);
  assert.equal(stripWavHeader(new Uint8Array(FIXTURE)).header, false, 'raw PCM is left alone');
});

test('server: odd-length chunk boundaries never split a 16-bit sample; a stray byte at a sentence end is dropped', () => {
  for (const sizes of [[1], [3], [999, 1], [7, 2, 5], [2401]]) {
    const a = createPcmAligner();
    const chunks = cut(FIXTURE, sizes).map((c) => a.push(c.toString('base64'))).filter(Boolean).map((b) => Buffer.from(b, 'base64'));
    assert.ok(chunks.every((c) => c.length % 2 === 0), `every emitted chunk is whole samples (${sizes})`);
    assert.ok(Buffer.concat(chunks).equals(FIXTURE));
  }
  const a = createPcmAligner();
  assert.equal(Buffer.from(a.push(Buffer.from([1, 2, 3]).toString('base64')), 'base64').length, 2);
  assert.equal(a.end(), 1, 'the odd byte does not carry into the next sentence');
});

test('server: the voice stream emits aligned, header-free chunks for every sentence', async () => {
  const events = [];
  const synth = async (text, { onChunk }) => {
    // Sentence 2 comes wrapped in WAV and cut at odd sizes.
    const bytes = text.startsWith('Second') ? wavWrap(FIXTURE) : FIXTURE;
    for (const c of cut(bytes, [333, 1001, 7])) onChunk(c.toString('base64'));
    return { ok: true, chunks: 3 };
  };
  const voice = createVoiceStream({ emit: (type, p) => events.push({ type, ...p }), synth });
  voice.push('First one. Second one.');
  await voice.finish();
  const audio = events.filter((e) => e.type === 'audio');
  for (const s of [0, 1]) {
    const bytes = Buffer.concat(audio.filter((e) => e.sentence === s).map((e) => Buffer.from(e.data, 'base64')));
    assert.ok(bytes.equals(FIXTURE), `sentence ${s}: exactly the PCM`);
  }
  assert.ok(audio.every((e) => Buffer.from(e.data, 'base64').length % 2 === 0));
  assert.ok(audio.every((e) => e.sample_rate === 24000 && e.encoding === 'pcm_s16le'));
  assert.deepEqual(VOICE_AUDIO_FORMAT, { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 });
});

test('fallback engine: Gemini audio (raw or WAV-wrapped) reaches the player as header-free 24 kHz PCM; SPEAK gets one header', async () => {
  for (const wrapped of [false, true]) {
    const payload = wrapped ? wavWrap(FIXTURE) : FIXTURE;
    const fetchImpl = async (url) => {
      assert.match(String(url), /generativelanguage\.googleapis\.com/);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: wrapped ? 'audio/wav' : 'audio/L16;codec=pcm;rate=24000', data: payload.toString('base64') } }] } }], usageMetadata: {} }), { status: 200 });
    };
    const env = { GEMINI_API_KEY_FREE: 'g', PG1_TTS_FREE_FIRST: '1', PG1_TTS_GEMINI_VOICE: 'Kore', PG1_AI_CACHE: '0' };
    const synth = createRoutedSynth({ env, dataClass: 'operator', fetchImpl, log: () => {} });
    const events = [];
    const voice = createVoiceStream({ emit: (type, p) => events.push({ type, ...p }), synth });
    voice.push('Hello there.');
    const summary = await voice.finish();
    assert.equal(summary.ok, true, JSON.stringify(summary));
    const bytes = Buffer.concat(events.filter((e) => e.type === 'audio').map((e) => Buffer.from(e.data, 'base64')));
    assert.ok(bytes.equals(FIXTURE), `${wrapped ? 'WAV' : 'raw'}: exactly the PCM, no header`);
  }
  const wav = Buffer.from(pcmToWav(FIXTURE));
  assert.equal(wav.indexOf('RIFF', 4), -1, 'the one-shot WAV has a single header');
});

// --- the page's player ---------------------------------------------------------------

test('player: a WAV header that reaches the page is still not played', () => {
  const w = makeWorld();
  const p = w.ctx.createVoicePlayer(w.audioCtx, () => {});
  p.push(ev(0, wavWrap(FIXTURE)));
  p.end({ ok: true });
  const out = w.played();
  assert.equal(out.length, FIXTURE.length / 2, 'only the samples are played');
  const src = fixtureSamples();
  assert.deepEqual(out.slice(400), src.slice(400), 'after the fade, sample for sample');
});

test('player: every buffer is created at the source rate (24000), from the very first one', () => {
  const w = makeWorld({ rate: 48000 });
  const p = w.ctx.createVoicePlayer(w.audioCtx, () => {});
  cut(FIXTURE, [960]).forEach((c, i) => p.push(ev(i, c)));
  p.end({ ok: true });
  assert.ok(w.log.sources.length > 0);
  assert.deepEqual([...new Set(w.log.sources.map((s) => s.buffer.sampleRate))], [24000], 'never the device rate');
  assert.equal(w.log.sources[0].buffer.sampleRate, 24000);
  // A header's own rate wins for its sentence.
  const w2 = makeWorld();
  const p2 = w2.ctx.createVoicePlayer(w2.audioCtx, () => {});
  p2.push(ev(0, wavWrap(FIXTURE, 24000), { sample_rate: 16000 }));
  p2.end({ ok: true });
  assert.equal(w2.log.sources[0].buffer.sampleRate, 24000);
});

test('player: odd-length chunks keep 16-bit alignment; a new sentence starts aligned', () => {
  const w = makeWorld();
  const p = w.ctx.createVoicePlayer(w.audioCtx, () => {});
  const chunks = cut(FIXTURE, [1, 999, 3, 1497]);
  chunks.forEach((c, i) => p.push(ev(i, c)));
  // Sentence 1 after a stray odd byte at the end of sentence 0.
  p.push(ev(chunks.length, Buffer.from([0x55])));
  p.push(ev(chunks.length + 1, FIXTURE.subarray(0, 4800), { sentence: 1 }));
  p.end({ ok: true });
  const out = w.played();
  const src = fixtureSamples();
  assert.equal(out.length, src.length + 2400);
  assert.deepEqual(out.slice(400, src.length), src.slice(400), 'sentence 0 exact after the fade');
  assert.deepEqual(out.slice(src.length), src.slice(0, 2400), 'sentence 1 not shifted by the stray byte');
});

test('player: the reply fades in over its first 15 ms (and out at the end); no jump from silence to the first sample', () => {
  const w = makeWorld();
  const p = w.ctx.createVoicePlayer(w.audioCtx, () => {});
  cut(FIXTURE, [960]).forEach((c, i) => p.push(ev(i, c)));
  p.end({ ok: true });
  const out = w.played();
  const src = fixtureSamples();
  assert.equal(src[0], 6271, 'the fixture starts mid-vowel');
  assert.equal(out[0], 0, 'the first played sample is silence');
  const fade = Math.floor(24000 * 0.015);
  for (let i = 0; i < fade; i++) assert.ok(Math.abs(out[i]) <= Math.abs(src[i]) * (i / fade) + 1, `sample ${i} is ramped`);
  assert.deepEqual(out.slice(fade), src.slice(fade), 'untouched after the fade');
  // Sample 0 to the following samples: never a step larger than the
  // source's own largest step.
  let maxStep = Math.abs(out[0]);
  for (let i = 1; i < 480; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
  assert.ok(maxStep <= SOURCE_MAX_STEP, `largest step in the first 20 ms ${maxStep} <= ${SOURCE_MAX_STEP}`);
  // Fade-out: the gain ramps to 0 where the audio ends.
  const ramp = w.log.gain.find((g) => g[0] === 'ramp');
  assert.ok(ramp && ramp[1] === 0);
  const last = w.log.sources[w.log.sources.length - 1];
  assert.ok(Math.abs(ramp[2] - (last.startedAt + last.buffer.duration)) < 1e-9, 'the fade-out ends with the last sample');
  assert.ok(w.log.sources.every((s) => s.to && s.to.gain), 'everything goes through the reply\'s gain');
});

test('player: nothing plays until 250 ms is buffered (or 400 ms passed, or the reply ended); then back to back from one start', () => {
  const w = makeWorld();
  const p = w.ctx.createVoicePlayer(w.audioCtx, () => {});
  const chunks = cut(FIXTURE, [960]); // 20 ms each
  for (let i = 0; i < 12; i++) p.push(ev(i, chunks[i]));
  assert.equal(w.log.sources.length, 0, '240 ms buffered: still waiting');
  assert.equal(p.scheduledChunks, 12, 'held audio counts as spoken (no one-shot repeat)');
  assert.equal(p.speaking, true);
  p.push(ev(12, chunks[12]));
  assert.equal(w.log.sources.length, 13, '260 ms buffered: all of it is scheduled');
  const starts = w.log.sources.map((s) => s.startedAt);
  for (let i = 1; i < starts.length; i++) assert.ok(Math.abs(starts[i] - (starts[i - 1] + 0.02)) < 1e-9, 'back to back');
  // A slow start: the timer releases what arrived.
  const w2 = makeWorld();
  const p2 = w2.ctx.createVoicePlayer(w2.audioCtx, () => {});
  p2.push(ev(0, chunks[0]));
  assert.equal(w2.log.sources.length, 0);
  w2.runTimers();
  assert.equal(w2.log.sources.length, 1, 'released after the wait');
  // A reply shorter than the head start plays when it ends.
  const w3 = makeWorld();
  const p3 = w3.ctx.createVoicePlayer(w3.audioCtx, () => {});
  p3.push(ev(0, chunks[0]));
  p3.end({ ok: true });
  assert.equal(w3.log.sources.length, 1);
});

test('player: a gap (audio ran out) fades the next chunk in instead of a hard restart', () => {
  const w = makeWorld();
  const p = w.ctx.createVoicePlayer(w.audioCtx, () => {});
  const chunks = cut(FIXTURE, [6000]);
  p.push(ev(0, chunks[0])); // 125 ms: below the head start
  w.runTimers();
  const first = w.log.sources[0];
  w.audioCtx.currentTime = first.startedAt + first.buffer.duration + 0.05; // it has run out
  p.push(ev(1, chunks[1]));
  const second = w.log.sources[1].buffer.getChannelData(0);
  assert.equal(Math.round(second[0] * 32768), 0, 'the chunk after a gap starts from silence');
  const n = Math.floor(24000 * 0.005);
  const src = fixtureSamples().slice(3000);
  assert.equal(Math.round(second[n] * 32768), src[n], 'and is untouched after 5 ms');
});

test('output is primed inside the tap: a silent buffer wakes the device before the first chunk', () => {
  const w = makeWorld();
  const ctx = w.ctx.getVoiceAudioContext();
  assert.equal(ctx, w.audioCtx);
  assert.equal(w.log.primed, 1, 'a fresh context plays a moment of silence');
  w.ctx.getVoiceAudioContext();
  assert.equal(w.log.primed, 1, 'a running context is not primed again');
  w.audioCtx.state = 'suspended';
  w.ctx.getVoiceAudioContext();
  assert.equal(w.log.primed, 2, 'a suspended one is resumed and primed');
});
