// PG1 City: sound, off until the operator turns it on. Made in the browser
// with Web Audio (no files): a distant city (filtered noise and a low hum),
// traffic hum, rain that follows the real weather, the odd gull over the
// river, and a gentle chime when a real gadget fires. Ambient sound never
// stands for an event; nothing plays at all while the toggle is off.

export function createSound() {
  let ctx = null; let master = null; let on = false; let lastChime = 0;
  let rainGain = null; let trafficGain = null; let gullTimer = null; let weather = { rain: 0, wind: 0 };
  const noiseBuffer = (kind) => {
    const len = ctx.sampleRate * 2; const buf = ctx.createBuffer(1, len, ctx.sampleRate); const d = buf.getChannelData(0);
    let last = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; if (kind === 'white') d[i] = w * 0.5; else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3; } }
    return buf;
  };
  const gull = () => {
    if (!on || !ctx) return;
    const now = ctx.currentTime;
    for (let k = 0; k < 2 + Math.floor(Math.random() * 3); k++) {
      const o = ctx.createOscillator(); o.type = 'triangle';
      const t0 = now + k * 0.22; const f0 = 1400 + Math.random() * 300;
      o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f0 * 0.62, t0 + 0.18);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.025, t0 + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + 0.25);
    }
  };
  const start = () => {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.0; master.connect(ctx.destination);
    // Ambience: brown-ish noise through a low-pass, plus a quiet hum.
    const len = ctx.sampleRate * 2; const buf = ctx.createBuffer(1, len, ctx.sampleRate); const d = buf.getChannelData(0);
    let last = 0; for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3; }
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
    const ng = ctx.createGain(); ng.gain.value = 0.5;
    noise.connect(lp); lp.connect(ng); ng.connect(master); noise.start();
    const hum = ctx.createOscillator(); hum.frequency.value = 55; const hg = ctx.createGain(); hg.gain.value = 0.03; hum.connect(hg); hg.connect(master); hum.start();
    // Traffic: a band of brown noise round 120 Hz, gently swelling.
    const tr = ctx.createBufferSource(); tr.buffer = noiseBuffer('brown'); tr.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 140; bp.Q.value = 0.8;
    trafficGain = ctx.createGain(); trafficGain.gain.value = 0.35; tr.connect(bp); bp.connect(trafficGain); trafficGain.connect(master); tr.start();
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07; const lg = ctx.createGain(); lg.gain.value = 0.12; lfo.connect(lg); lg.connect(trafficGain.gain); lfo.start();
    // Rain: white noise through a high band, silent until it really rains.
    const rn = ctx.createBufferSource(); rn.buffer = noiseBuffer('white'); rn.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    rainGain = ctx.createGain(); rainGain.gain.value = 0; rn.connect(hp); hp.connect(rainGain); rainGain.connect(master); rn.start();
    gullTimer = setInterval(() => { if (Math.random() < 0.35) gull(); }, 5000);
    return true;
  };
  return {
    get on() { return on; },
    toggle() {
      on = !on;
      if (on && !ctx && !start()) { on = false; return on; }
      if (ctx) { if (on && ctx.state === 'suspended') ctx.resume(); master.gain.setTargetAtTime(on ? 0.12 : 0, ctx.currentTime, 0.4); }
      return on;
    },
    // The real weather (decoration): rain loudness follows it.
    setWeather({ rain = 0, wind = 0 } = {}) {
      weather = { rain, wind };
      if (ctx && rainGain) rainGain.gain.setTargetAtTime(Math.min(1, rain) * 0.9, ctx.currentTime, 1.5);
      if (ctx && trafficGain) trafficGain.gain.setTargetAtTime(0.35 + wind * 0.15, ctx.currentTime, 2);
    },
    get weather() { return { ...weather }; },
    // A real gadget fired: its own short cue (kingdom-sequences.js `cue`), at
    // most one every 1.5 s. Synthesised: a lens hum, a net's whoosh, a gate's
    // clang, a shield's thrum, a scanner's sweep, a repair's ratchet...
    alert(cue = 'chime') {
      if (!on || !ctx) return;
      const now = ctx.currentTime; if (now - lastChime < 1.5) return; lastChime = now;
      const tone = (f, at, dur, type = 'sine', peak = 0.16, glideTo = null) => {
        const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, now + at); if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, now + at + dur);
        const g = ctx.createGain(); g.gain.setValueAtTime(0, now + at); g.gain.linearRampToValueAtTime(peak, now + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
        o.connect(g); g.connect(master); o.start(now + at); o.stop(now + at + dur + 0.05);
      };
      const noise = (at, dur, freq, q = 1, peak = 0.2) => {
        const src = ctx.createBufferSource(); src.buffer = noiseBuffer('white');
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(freq, now + at); bp.frequency.exponentialRampToValueAtTime(freq * 3, now + at + dur); bp.Q.value = q;
        const g = ctx.createGain(); g.gain.setValueAtTime(0, now + at); g.gain.linearRampToValueAtTime(peak, now + at + dur * 0.3); g.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
        src.connect(bp); bp.connect(g); g.connect(master); src.start(now + at); src.stop(now + at + dur + 0.05);
      };
      switch (cue) {
        case 'lens': tone(220, 0, 1.2, 'sine', 0.12, 660); tone(880, 0.5, 0.6); break;
        case 'net': noise(0, 0.7, 400, 0.8, 0.25); tone(330, 0.35, 0.5, 'triangle', 0.1); break;
        case 'gate': tone(140, 0, 0.5, 'square', 0.08, 90); tone(1200, 0.02, 0.25, 'triangle', 0.08); break;
        case 'shield': tone(70, 0, 1.0, 'sawtooth', 0.06, 55); noise(0, 0.5, 900, 2, 0.12); break;
        case 'scanner': tone(500, 0, 0.8, 'sine', 0.1, 1500); tone(1500, 0.8, 0.15); break;
        case 'repair': for (let k = 0; k < 4; k++) noise(k * 0.09, 0.07, 2500, 4, 0.12); break;
        case 'vault': tone(110, 0, 0.6, 'square', 0.07, 70); break;
        case 'toll': tone(660, 0, 0.3); tone(660, 0.35, 0.3); break;
        case 'beacon': case 'welcome': tone(523, 0, 0.6); tone(784, 0.15, 0.7); break;
        default: tone(880, 0, 0.9); tone(1320, 0.12, 0.9);
      }
    },
    dispose() { if (gullTimer) clearInterval(gullTimer); gullTimer = null; if (ctx) ctx.close(); ctx = null; on = false; }
  };
}
