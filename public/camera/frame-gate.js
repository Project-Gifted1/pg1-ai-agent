// PG1 camera live analysis: which frames of the operator's camera are sent.
//
// With the Vision feed on (the camera or a shared screen), public/index.html
// grabs a small frame from the <video> every few seconds and asks this gate
// whether to send it for analysis (/api/chat, cameraAnalyze). The gate keeps
// the feed inside the free engine's per-minute limit:
//
//   - at most one frame every minIntervalMs (default 10 s)
//   - a frame that looks the same as the last one sent (a 16x12 grey
//     thumbnail, mean difference under diffThreshold) is skipped
//   - after a rate limit (429) or "no engine available" the gate pauses:
//     the wait the server gave, else 30 s, doubling to 5 minutes; a frame
//     that is answered resets the back-off
//
// No DOM and no browser globals, so tests drive it with fake pixels and a
// fake clock (tests/camera-feed.test.mjs). No frame is kept: only the last
// thumbnail's 192 grey values, to compare the next one with.

(function (root, factory) {
  const api = factory();
  root.PG1Camera = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  const DEFAULTS = Object.freeze({
    minIntervalMs: 10000,
    diffThreshold: 6,
    pauseMs: 30000,
    maxPauseMs: 5 * 60 * 1000,
    thumbWidth: 16,
    thumbHeight: 12
  });

  // Shown on screen while analysis is paused because no engine can take it.
  const PAUSED_TEXT = 'Camera analysis paused: AI credit unavailable';
  const THROTTLED_TEXT = 'Camera analysis paused for a moment: rate limit reached';

  // A 16x12 grey thumbnail from RGBA pixels (a canvas ImageData's data).
  function signature(rgba, width, height, opts = {}) {
    const tw = opts.thumbWidth || DEFAULTS.thumbWidth;
    const th = opts.thumbHeight || DEFAULTS.thumbHeight;
    const out = new Array(tw * th).fill(0);
    const counts = new Array(tw * th).fill(0);
    for (let y = 0; y < height; y++) {
      const ty = Math.min(th - 1, Math.floor((y * th) / height));
      for (let x = 0; x < width; x++) {
        const tx = Math.min(tw - 1, Math.floor((x * tw) / width));
        const i = (y * width + x) * 4;
        out[ty * tw + tx] += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
        counts[ty * tw + tx]++;
      }
    }
    return out.map((v, i) => (counts[i] ? v / counts[i] : 0));
  }

  // Mean absolute difference of two thumbnails (0-255), Infinity if either
  // is missing.
  function difference(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  }

  function createFrameGate(options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    const now = options.now || (() => Date.now());
    let lastSentAt = -Infinity;
    let lastSig = null;
    let pausedUntil = 0;
    let pauseReason = null;
    let nextPauseMs = cfg.pauseMs;
    let inFlight = false;

    return {
      // 'send' | 'busy' | 'paused' | 'too_soon' | 'unchanged'
      decide(sig) {
        const t = now();
        if (inFlight) return 'busy';
        if (t < pausedUntil) return 'paused';
        if (pauseReason) { pauseReason = null; }
        if (t - lastSentAt < cfg.minIntervalMs) return 'too_soon';
        if (lastSig && difference(sig, lastSig) < cfg.diffThreshold) return 'unchanged';
        return 'send';
      },
      // Call when a frame is sent.
      sent(sig) {
        lastSentAt = now();
        lastSig = sig;
        inFlight = true;
      },
      // Call with the server's answer: { ok } or { status, reason, retryAfterMs }.
      // Resolves to what the screen shows: { text, paused }.
      result(r = {}) {
        inFlight = false;
        if (r.ok) {
          nextPauseMs = cfg.pauseMs;
          pauseReason = null;
          pausedUntil = 0;
          return { paused: false, text: null };
        }
        const limited = r.status === 429 || r.reason === 'ai_unavailable';
        if (!limited) {
          // Any other failure: try again at the next interval, unchanged
          // frames or not.
          lastSig = null;
          return { paused: false, text: null };
        }
        const hinted = Number.isFinite(r.retryAfterMs) && r.retryAfterMs > 0 ? r.retryAfterMs : null;
        const wait = Math.min(cfg.maxPauseMs, hinted || nextPauseMs);
        nextPauseMs = Math.min(cfg.maxPauseMs, nextPauseMs * 2);
        pausedUntil = now() + wait;
        pauseReason = r.reason === 'ai_unavailable' ? 'ai_unavailable' : 'throttled';
        lastSig = null;
        return { paused: true, text: pauseReason === 'ai_unavailable' ? PAUSED_TEXT : THROTTLED_TEXT, waitMs: wait };
      },
      state() {
        return { pausedUntil, pauseReason, lastSentAt, inFlight };
      },
      reset() {
        lastSentAt = -Infinity;
        lastSig = null;
        pausedUntil = 0;
        pauseReason = null;
        nextPauseMs = cfg.pauseMs;
        inFlight = false;
      }
    };
  }

  return { DEFAULTS, PAUSED_TEXT, THROTTLED_TEXT, signature, difference, createFrameGate };
});
