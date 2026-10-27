// PG1 Sandbox viewer: the sound of a world, made in the browser (Web Audio,
// no recordings, nothing downloaded). Off until the person turns it on.
//
//   createSound() -> { on(), off(), music(on), volume(0..1), update(state), playing, musicOn }
//   state: { place: 'town' | 'sea' | 'land' | 'space' | 'alien', night: 0..1,
//            hour, seed, near: { traffic, people } }
//
// Beds, each faded in and out with where the camera is and the time of day:
//   wind      brown noise through a low-pass, swelling and falling
//   sea       waves: filtered noise in long, slow surges (coasts and islands)
//   town      a low rumble of traffic and voices, quieter at night
//   birds     short chirps by day; crickets at night
//   space     a deep, slow drone with a faint shimmer
//   alien     a stranger drone, and soft chimes
// Music (its own switch): a slow ambient score, chords from a pentatonic
// scale chosen by the world's seed, so each world has its own.
//
// Pure helpers (exported for tests): scaleFor(seed), chordAt(scale, n).

export const PENTATONIC = Object.freeze([0, 2, 4, 7, 9]);
export function scaleFor(seed = 1) {
  const roots = [196, 220, 246.94, 261.63, 293.66, 329.63];   // G3 .. E4
  const s = (Number(seed) >>> 0) || 1;
  const root = roots[s % roots.length];
  const minor = (s >> 3) % 2 === 1;
  const steps = minor ? [0, 3, 5, 7, 10] : PENTATONIC;
  return steps.map((st) => root * Math.pow(2, st / 12));
}
export function chordAt(scale, n) {
  const i = ((n * 3) % scale.length + scale.length) % scale.length;
  return [scale[i] / 2, scale[(i + 2) % scale.length], scale[(i + 4) % scale.length] * (i + 4 >= scale.length ? 2 : 1)];
}

function noiseBuffer(ctx, kind = 'brown', seconds = 4) {
  const n = Math.floor(ctx.sampleRate * seconds); const buf = ctx.createBuffer(1, n, ctx.sampleRate); const d = buf.getChannelData(0);
  let last = 0; let s = 12345;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
  for (let i = 0; i < n; i++) { const w = r(); if (kind === 'white') d[i] = w * 0.5; else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } }
  return buf;
}

export function createSound() {
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  let ctx = null; let master = null; let beds = null; let musicBus = null;
  let playing = false; let musicOn = false; let vol = 0.5; let chordN = 0; let nextChord = 0; let nextChirp = 0;
  let state = { place: 'land', night: 0, seed: 1, near: { traffic: 0, people: 0 } };

  function build() {
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    const brown = noiseBuffer(ctx, 'brown'); const white = noiseBuffer(ctx, 'white', 2);
    const loop = (buf) => { const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.start(); return src; };
    const bed = (src, type, freq, q = 0.7) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; src.connect(f); f.connect(g); g.connect(master); return { f, g }; };
    beds = {
      wind: bed(loop(brown), 'lowpass', 420),
      sea: bed(loop(brown), 'lowpass', 900),
      town: bed(loop(brown), 'lowpass', 220),
      crickets: bed(loop(white), 'bandpass', 4600, 12),
      space: (() => { const g = ctx.createGain(); g.gain.value = 0; g.connect(master); for (const [f, d] of [[55, 0], [82.4, 3], [110.2, -4]]) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.detune.value = d; const og = ctx.createGain(); og.gain.value = 0.25; o.connect(og); og.connect(g); o.start(); } const sh = bed(loop(white), 'highpass', 6000); sh.g.disconnect(); sh.g.connect(g); sh.g.gain.value = 0.05; return { g }; })(),
      alien: (() => { const g = ctx.createGain(); g.gain.value = 0; g.connect(master); for (const [f, t] of [[73.4, 'triangle'], [77.8, 'sine']]) { const o = ctx.createOscillator(); o.type = t; o.frequency.value = f; const og = ctx.createGain(); og.gain.value = 0.2; o.connect(og); og.connect(g); o.start(); } return { g }; })()
    };
    // The waves' surge and the wind's gusts: slow gain oscillators.
    for (const [b, rate, depth] of [[beds.sea, 0.12, 0.6], [beds.wind, 0.07, 0.4], [beds.crickets, 9, 0.8]]) { const l = ctx.createOscillator(); l.frequency.value = rate; const lg = ctx.createGain(); lg.gain.value = depth; l.connect(lg); const sum = ctx.createGain(); sum.gain.value = 1; b.g.disconnect(); b.g.connect(sum); sum.connect(master); lg.connect(sum.gain); l.start(); }
    musicBus = ctx.createGain(); musicBus.gain.value = 0;
    const delay = ctx.createDelay(2); delay.delayTime.value = 0.55; const fb = ctx.createGain(); fb.gain.value = 0.35; const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
    musicBus.connect(lp); lp.connect(master); lp.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(master);
  }
  const ramp = (param, v, t = 1.5) => { if (!ctx) return; param.cancelScheduledValues(ctx.currentTime); param.setTargetAtTime(v, ctx.currentTime, t / 3); };
  function note(freq, at, dur, gain = 0.06, type = 'sine', bus = musicBus) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gain, at + Math.min(1.5, dur * 0.3)); g.gain.linearRampToValueAtTime(0, at + dur);
    o.connect(g); g.connect(bus); o.start(at); o.stop(at + dur + 0.1);
  }
  function chirp(at) { const o = ctx.createOscillator(); o.type = 'sine'; const f0 = 2600 + Math.random() * 1800; o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(f0 * (1.3 + Math.random() * 0.5), at + 0.08); const g = ctx.createGain(); g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.025, at + 0.01); g.gain.linearRampToValueAtTime(0, at + 0.12); o.connect(g); g.connect(master); o.start(at); o.stop(at + 0.15); }

  // Every half second: each bed towards its level for where the camera is.
  function mix() {
    if (!ctx || !playing) return;
    const { place, night } = state; const day = 1 - night;
    const outdoors = place === 'town' || place === 'sea' || place === 'land';
    ramp(beds.wind.g.gain, outdoors ? 0.18 : place === 'alien' ? 0.1 : 0);
    ramp(beds.sea.g.gain, place === 'sea' ? 0.22 : place === 'town' ? 0.04 : 0);
    ramp(beds.town.g.gain, place === 'town' ? 0.1 + 0.15 * Math.min(1, state.near.traffic / 6) * (0.4 + 0.6 * day) : 0);
    ramp(beds.crickets.g.gain, outdoors ? 0.012 * night : 0);
    ramp(beds.space.g.gain, place === 'space' ? 0.35 : 0, 3);
    ramp(beds.alien.g.gain, place === 'alien' ? 0.25 : 0, 3);
    const t = ctx.currentTime;
    if (outdoors && day > 0.4 && t > nextChirp) { const k = 1 + Math.floor(Math.random() * 3); for (let i = 0; i < k; i++) chirp(t + i * 0.18); nextChirp = t + 2 + Math.random() * 6; }
    if (musicOn && t > nextChord) {
      const scale = scaleFor(state.seed); const ch = chordAt(scale, chordN++);
      const dur = place === 'space' ? 12 : 8;
      ch.forEach((f, i) => note(f, t + i * 0.25, dur, place === 'space' ? 0.035 : 0.045, i ? 'sine' : 'triangle'));
      if (chordN % 2 === 0) note(scale[(chordN * 2) % scale.length] * 2, t + dur * 0.5, dur * 0.4, 0.03);
      nextChord = t + dur * 0.85;
    }
  }
  let timer = null;
  const vis = () => { if (!ctx) return; if (document.hidden) ctx.suspend(); else if (playing) ctx.resume(); };

  return {
    get playing() { return playing; },
    get musicOn() { return musicOn; },
    // Only from a tap (browsers allow sound to start only then).
    on() {
      if (!AC) return false;
      if (!ctx) build();
      ctx.resume(); playing = true;
      ramp(master.gain, vol, 0.8);
      if (!timer) { timer = setInterval(mix, 500); document.addEventListener('visibilitychange', vis); }
      mix();
      return true;
    },
    off() {
      playing = false;
      if (ctx) { ramp(master.gain, 0, 0.5); setTimeout(() => { if (!playing && ctx) ctx.suspend(); }, 700); }
    },
    music(on) { musicOn = !!on; if (ctx) ramp(musicBus.gain, musicOn ? 1 : 0, 1.5); nextChord = 0; },
    volume(v) { vol = Math.max(0, Math.min(1, Number(v) || 0)); if (ctx && playing) ramp(master.gain, vol, 0.3); },
    update(s) { state = { ...state, ...s, near: { ...state.near, ...(s && s.near) } }; },
    destroy() { clearInterval(timer); timer = null; document.removeEventListener('visibilitychange', vis); if (ctx) ctx.close(); ctx = null; playing = false; }
  };
}
