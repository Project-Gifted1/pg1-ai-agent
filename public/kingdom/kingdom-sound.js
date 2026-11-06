// PG1 City: sound, off until the operator turns it on. Made in the browser
// with Web Audio (no files): a soft city ambience (filtered noise and a low
// hum) and a gentle chime when a real gadget fires. Nothing plays for
// ambient life, and nothing plays at all while the toggle is off.

export function createSound() {
  let ctx = null; let master = null; let on = false; let lastChime = 0;
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
    // A real gadget fired: one soft two-note chime (at most every 1.5 s).
    alert() {
      if (!on || !ctx) return;
      const now = ctx.currentTime; if (now - lastChime < 1.5) return; lastChime = now;
      for (const [f, dt] of [[880, 0], [1320, 0.12]]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const g = ctx.createGain(); g.gain.setValueAtTime(0, now + dt); g.gain.linearRampToValueAtTime(0.18, now + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, now + dt + 0.9);
        o.connect(g); g.connect(master); o.start(now + dt); o.stop(now + dt + 1);
      }
    },
    dispose() { if (ctx) ctx.close(); ctx = null; on = false; }
  };
}
