// PG1 City: the globe. A small canvas globe (orthographic, drawn in code:
// a graticule and the country points PG1 knows, no map download) with arcs
// from the countries hostile traffic really came from, converging on PG1
// in Dublin. Flags only here, on arcs and in the HUD, never on a model.
//
//   createGlobe(canvas, { flagPx }) -> { draw({ origins, arcs, lon, lat, t }), flagPx }
//   origins: [[cc, count]] (the feed's 24 h origins); arcs: [{ cc, age }] live arcs (age 0..1)
//
// Used twice: the opening shot (full stage, turning to Dublin, then the
// dive into the city) and the picture-in-picture mini-globe in the city.

import { CENTRES, DUBLIN, flagOf } from './kingdom-data.js';

const RAD = Math.PI / 180;

// Orthographic projection: [x, y, visible] on a unit disc, centred on lat0/lon0.
export function project(lat, lon, lat0, lon0) {
  const p = lat * RAD; const l = (lon - lon0) * RAD; const p0 = lat0 * RAD;
  const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l);
  const x = Math.cos(p) * Math.sin(l);
  const y = Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l);
  return [x, -y, cosc >= 0];
}

// Points along the great circle from a to b (lat/lon degrees).
export function greatCircle(a, b, n = 32) {
  const toV = ([la, lo]) => [Math.cos(la * RAD) * Math.cos(lo * RAD), Math.cos(la * RAD) * Math.sin(lo * RAD), Math.sin(la * RAD)];
  const va = toV(a); const vb = toV(b);
  const d = Math.acos(Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]))) || 1e-6;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n; const s1 = Math.sin((1 - t) * d) / Math.sin(d); const s2 = Math.sin(t * d) / Math.sin(d);
    const v = [va[0] * s1 + vb[0] * s2, va[1] * s1 + vb[1] * s2, va[2] * s1 + vb[2] * s2];
    out.push([Math.asin(v[2]) / RAD, Math.atan2(v[1], v[0]) / RAD]);
  }
  return out;
}

export function createGlobe(canvas, { flagPx = 24, labels = true } = {}) {
  const g = canvas.getContext('2d');
  return {
    flagPx,
    draw({ origins = [], arcs = [], lon = DUBLIN.lon, lat = 38, t = 0, dpr = Math.min(2, globalThis.devicePixelRatio || 1) } = {}) {
      if (!g) return;
      const w = canvas.width; const h = canvas.height;
      const R = Math.min(w, h) * 0.44; const cx = w / 2; const cy = h / 2;
      g.clearRect(0, 0, w, h);
      const sea = g.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R);
      sea.addColorStop(0, '#1d3a5c'); sea.addColorStop(1, '#0a1626');
      g.fillStyle = sea; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(111,216,255,0.35)'; g.lineWidth = Math.max(1, dpr * 0.8); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
      // Graticule.
      g.strokeStyle = 'rgba(159,230,255,0.12)';
      for (let la = -60; la <= 60; la += 30) { g.beginPath(); let first = true; for (let lo = -180; lo <= 180; lo += 6) { const [x, y, v] = project(la, lo, lat, lon); if (!v) { first = true; continue; } if (first) g.moveTo(cx + x * R, cy + y * R); else g.lineTo(cx + x * R, cy + y * R); first = false; } g.stroke(); }
      for (let lo = -180; lo < 180; lo += 30) { g.beginPath(); let first = true; for (let la = -85; la <= 85; la += 5) { const [x, y, v] = project(la, lo, lat, lon); if (!v) { first = true; continue; } if (first) g.moveTo(cx + x * R, cy + y * R); else g.lineTo(cx + x * R, cy + y * R); first = false; } g.stroke(); }
      // The countries PG1 knows, as faint points.
      g.fillStyle = 'rgba(216,221,227,0.35)';
      for (const [la, lo] of Object.values(CENTRES)) { const [x, y, v] = project(la, lo, lat, lon); if (v) { g.beginPath(); g.arc(cx + x * R, cy + y * R, 1.4 * dpr, 0, Math.PI * 2); g.fill(); } }
      // PG1, in Dublin.
      const [dx, dy] = project(DUBLIN.lat, DUBLIN.lon, lat, lon);
      const pulse = 0.6 + 0.4 * Math.sin(t * 3);
      g.fillStyle = `rgba(243,198,35,${0.35 * pulse})`; g.beginPath(); g.arc(cx + dx * R, cy + dy * R, 9 * dpr, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f3c623'; g.beginPath(); g.arc(cx + dx * R, cy + dy * R, 4 * dpr, 0, Math.PI * 2); g.fill();
      // Arcs: every 24 h origin faintly, live ones bright (red: hostile traffic).
      const drawArc = (cc, strength, head = 1) => {
        const c = CENTRES[cc]; if (!c) return null;
        const pts = greatCircle(c, [DUBLIN.lat, DUBLIN.lon]);
        g.strokeStyle = `rgba(255,90,74,${strength})`; g.lineWidth = (1 + strength * 2) * dpr;
        g.beginPath(); let first = true;
        const last = Math.max(1, Math.round(pts.length * head));
        for (let i = 0; i < last; i++) {
          const [la, lo] = pts[i]; const [x, y, v] = project(la, lo, lat, lon);
          const lift = 1 + Math.sin((i / (pts.length - 1)) * Math.PI) * 0.12;
          if (!v) { first = true; continue; }
          if (first) g.moveTo(cx + x * R * lift, cy + y * R * lift); else g.lineTo(cx + x * R * lift, cy + y * R * lift);
          first = false;
        }
        g.stroke();
        const [ox, oy, ov] = project(c[0], c[1], lat, lon);
        return ov ? [cx + ox * R, cy + oy * R] : null;
      };
      const shown = [];
      for (const [cc] of origins.slice(0, 12)) { const p = drawArc(cc, 0.28); if (p) shown.push([cc, p, false]); }
      for (const a of arcs) { const p = drawArc(a.cc, 0.95 * (1 - a.age * 0.6), Math.min(1, 0.25 + a.age * 2)); if (p) shown.push([a.cc, p, true]); }
      // Flags at the origins (at least flagPx CSS pixels).
      if (labels) {
        g.textAlign = 'center'; g.textBaseline = 'middle';
        for (const [cc, [x, y], live] of shown) {
          g.font = `${Math.round(flagPx * dpr)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
          g.fillText(flagOf(cc), x, y - flagPx * dpr * 0.6);
          g.font = `600 ${Math.round(11 * dpr)}px Inter, system-ui, sans-serif`;
          g.fillStyle = live ? '#ffffff' : 'rgba(255,255,255,0.75)'; g.fillText(cc, x, y + 9 * dpr); g.fillStyle = 'rgba(216,221,227,0.35)';
        }
      }
      return { shown: shown.map(([cc]) => cc) };
    }
  };
}
