// The frame-rate overlay, shown only with ?debug=1 in the address: frames a
// second, frame time (average and the slowest 5%), draw calls, triangles,
// the tier and how it was chosen. Shared by the Sandbox viewer and PG1 City.
// Fed from the view's own frame loop (no timer, no network); the text is
// rewritten twice a second.
//
//   createDebugOverlay(container, { enabled }) -> { frame(now, info), destroy() } | null
//     info: { calls, triangles, tier, source, probeMs, scale }

import { debugOn } from './tier-probe.js';

export function frameSummary(times) {
  if (!times.length) return { fps: 0, avgMs: 0, p95Ms: 0 };
  const s = times.slice().sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const avg = sum / s.length;
  return { fps: Math.round((1000 / avg) * 10) / 10, avgMs: Math.round(avg * 10) / 10, p95Ms: Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] * 10) / 10 };
}

export function createDebugOverlay(container, { enabled = debugOn(typeof location !== 'undefined' ? location.search : '') } = {}) {
  if (!enabled || !container || typeof document === 'undefined') return null;
  const el = document.createElement('div');
  el.className = 'pg1-debug-overlay';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:absolute;left:8px;top:44px;z-index:9;pointer-events:none;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,0.72);color:#d7ffd9;font:600 11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;font-variant-numeric:tabular-nums;';
  container.appendChild(el);
  const times = []; let last = 0; let shown = 0;
  return {
    el,
    frame(now, info = {}) {
      if (last) { times.push(now - last); if (times.length > 120) times.shift(); }
      last = now;
      if (now - shown < 500) return;
      shown = now;
      const f = frameSummary(times);
      const lines = [
        `${f.fps.toFixed(1)} fps  ${f.avgMs.toFixed(1)} ms (p95 ${f.p95Ms.toFixed(1)})`,
        `${info.calls ?? '-'} draws  ${info.triangles != null ? `${Math.round(info.triangles / 1000)}k tris` : ''}`,
        `tier ${info.tier || '-'}${info.source ? ` (${info.source})` : ''}${info.probeMs ? `  probe ${info.probeMs} ms` : ''}${info.scale && info.scale !== 1 ? `  scale ${info.scale}` : ''}`
      ];
      el.textContent = lines.join('\n');
      container.dataset.debugFps = String(f.fps);
    },
    // A paused view (hidden tab): the next frame starts a fresh interval.
    reset() { last = 0; },
    destroy() { el.remove(); }
  };
}
