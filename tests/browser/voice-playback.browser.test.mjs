/**
 * Spoken-reply playback in a real browser audio engine (Chromium via
 * Playwright): the page's own player (createVoicePlayer and its helpers,
 * taken from public/index.html as deployed) renders a real spoken reply
 * (tests/fixtures/voice-reply-start.pcm, s16le 24 kHz, repeated to 1.2 s)
 * on an OfflineAudioContext at 48 kHz, a device rate. Chunks are handed to
 * it at set render times (ctx.suspend), the way a streamed reply arrives:
 * small chunks, a little faster than real time, with jitter, and odd byte
 * lengths.
 *
 * Before the fix this is where the start of every reply broke up: with
 * 80 ms of head start the player ran out of audio on the first syllables,
 * leaving silent gaps (hard cuts in the waveform). It asserts: no silent
 * gap anywhere in the reply, the first output sample is silence and the
 * reply ramps in, no sample-to-sample step larger than the source's own,
 * and the output is the source at the source rate (duration matches).
 *
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

let chromium = null;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  skip = 'playwright is not installed (npm install)';
}
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()}`;

const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found`);
  let depth = 0;
  let i = html.indexOf('{', html.indexOf(')', start));
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}
const PLAYER = [
  ...html.match(/const VOICE_[A-Z_]+ = [\d.]+;/g),
  ...['stripWavHeader', 'applyFadeIn', 'base64ToBytes', 'pcm16ToFloat32', 'createVoicePlayer'].map(extractFunction)
].join('\n');

const FIXTURE = readFileSync(new URL('../fixtures/voice-reply-start.pcm', import.meta.url));
const SOURCE = Buffer.concat([FIXTURE, FIXTURE, FIXTURE, FIXTURE]);

// Arrival plan: chunk sizes in bytes (odd ones included), each arriving
// after its audio time / speed, plus deterministic jitter; in order, as a
// single SSE stream delivers them.
function arrivals({ chunkMs, speed, jitterMs, odd }) {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = [];
  let t = 0.2;
  for (let o = 0, k = 0; o < SOURCE.length; k++) {
    const n = Math.min(SOURCE.length - o, Math.round(chunkMs * 24) * 2 + (odd ? (k % 2 ? 1 : -1) : 0));
    t += n / 2 / 24000 / speed + (k ? (rnd() - 0.5) * 2 * jitterMs / 1000 : 0);
    const at = Math.max(out.length ? out[out.length - 1].at : 0.2, t);
    out.push({ at, data: SOURCE.subarray(o, o + n).toString('base64') });
    o += n;
  }
  return out;
}

const SCENARIOS = [
  { name: 'steady, 3x real time', chunkMs: 40, speed: 3, jitterMs: 40 },
  { name: 'slow start, 1.5x real time', chunkMs: 20, speed: 1.5, jitterMs: 60 },
  { name: 'barely ahead, odd chunk sizes', chunkMs: 30, speed: 1.2, jitterMs: 80, odd: true }
];

test('a streamed reply plays without gaps, ramps in from silence and keeps the source rate (Chromium audio engine)', { skip, timeout: 120000 }, async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto('about:blank');
  const src = Array.from(new Int16Array(SOURCE.buffer.slice(SOURCE.byteOffset, SOURCE.byteOffset + SOURCE.length)));
  let srcMaxStep = 0;
  for (let i = 1; i < src.length; i++) srcMaxStep = Math.max(srcMaxStep, Math.abs(src[i] - src[i - 1]));
  for (const sc of SCENARIOS) {
    const plan = arrivals(sc);
    const r = await page.evaluate(async ({ code, plan }) => {
      const api = new Function(`${code}\nreturn { createVoicePlayer };`)();
      const sr = 48000;
      const end = plan[plan.length - 1].at;
      const ctx = new OfflineAudioContext(1, Math.ceil((end + 3) * sr), sr);
      const player = api.createVoicePlayer(ctx, () => {});
      const q = 128 / sr;
      const groups = new Map();
      plan.forEach((c, seq) => { const at = Math.ceil(c.at / q) * q; if (!groups.has(at)) groups.set(at, []); groups.get(at).push({ seq, sentence: 0, data: c.data, sample_rate: 24000 }); });
      const lastAt = Math.max(...groups.keys());
      for (const [at, evs] of groups) ctx.suspend(at).then(() => { evs.forEach((e) => player.push(e)); if (at === lastAt) player.end({ ok: true }); ctx.resume(); });
      const out = (await ctx.startRendering()).getChannelData(0);
      const on = out.findIndex((v) => v !== 0);
      let last = out.length - 1;
      while (last > 0 && out[last] === 0) last--;
      // Silent runs of 2 ms or more inside the speech.
      let gaps = 0;
      let run = 0;
      for (let i = on; i <= last; i++) { run = Math.abs(out[i]) < 1 / 32768 ? run + 1 : 0; if (run === 96) gaps++; }
      let maxStep = 0;
      for (let i = on; i <= last; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]) * 32768);
      return { on, gaps, maxStep, durationS: (last - on + 1) / sr, first: Array.from(out.slice(on - 1, on + 3), (v) => Math.round(v * 32768)), at10ms: Math.round(out[on + 480] * 32768) };
    }, { code: PLAYER, plan });
    assert.equal(r.gaps, 0, `${sc.name}: no silent gap`);
    assert.ok(Math.abs(r.first[0]) === 0 && Math.abs(r.first[1]) < 50, `${sc.name}: starts from silence (${r.first})`);
    assert.ok(r.maxStep <= srcMaxStep * 1.05, `${sc.name}: largest step ${Math.round(r.maxStep)} <= the source's ${srcMaxStep}`);
    assert.ok(Math.abs(r.durationS - src.length / 24000) < 0.01, `${sc.name}: plays at the source rate (${r.durationS}s for ${src.length / 24000}s)`);
  }
});
