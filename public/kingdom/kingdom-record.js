// PG1 Kingdom Defence: Record mode, a clip for posting, made in the
// browser (nothing is uploaded: the file is saved on this device).
//
//   createRecording(scene, { aspect, seconds, mode, caption, day, onTick })
// Clips use the dusk look and end on the tower with the day's counts.
//     -> { start(), stop() -> Promise<{ blob, mime, ext, seconds } | null> } | null
//
// The clip is the 3D view with the director camera, cropped to 16:9 or
// 9:16, with a caption of the event on screen (gadget, check, verdict,
// country), a small PG1 watermark and, always, the label "Real PG1
// events" ("Real PG1 events · last 24 h, time-lapse" for a replay, with
// each event's real Dublin time). Nothing in a clip is staged for it: a
// live clip shows what happens while it records (a calm kingdom says so),
// and a replay re-stages the day's real events in their real order
// (kingdom-data.js replaySchedule).
//
// The format is the Sandbox viewer's recorder's (public/sandbox/capture.js):
// MP4 (H.264) where the browser records it, else WebM.

import { pickMime, fileExtension } from '../sandbox/capture.js';
import { eventLine, dublinTime, BADGE, countriesText } from './kingdom-data.js';

export const RECORD_ASPECTS = Object.freeze({ '16:9': [16, 9], '9:16': [9, 16] });
export const RECORD_SECONDS = Object.freeze([30, 60]);
export const RECORD_FPS = 30;
export const RECORD_BITS = 10_000_000;

// The clip's size: the long edge at most maxEdge (1920; 1280 on a phone,
// whose encoder would otherwise drop frames), even numbers.
export function clipSize(aspect, maxEdge = 1920) {
  const [w, h] = RECORD_ASPECTS[aspect] || RECORD_ASPECTS['16:9'];
  const k = maxEdge / Math.max(w, h);
  return { w: Math.round((w * k) / 2) * 2, h: Math.round((h * k) / 2) * 2 };
}

// The part of the source (sw x sh) that fills the clip without stretching.
export function coverCrop(sw, sh, w, h) {
  const k = Math.max(w / sw, h / sh);
  const cw = w / k; const ch = h / k;
  return { sx: (sw - cw) / 2, sy: (sh - ch) / 2, sw: cw, sh: ch };
}

// The words on a clip. Exported for tests.
// The badge, in frame for the whole clip.
export function clipLabel(mode) {
  return mode === 'replay' ? BADGE.replay : BADGE.live;
}
export function clipCaption(e, mode) {
  if (!e) return mode === 'replay' ? 'No defence events in the last 24 hours. The kingdom was calm.' : 'No attack right now. The kingdom is calm.';
  return mode === 'replay' ? `${dublinTime(e.time)} · ${eventLine(e)}` : eventLine(e);
}

const SHIELD = 'M221.76 0L262.5 15.2V47.3C262.5 73.9 245.1 91.85 221.76 100C198.4 91.85 181 73.9 181 47.3V15.2Z';
const ONE = 'M220 20H233V72H220V37.5L208.5 43.5V31Z';

function wrap(g, text, maxW) {
  const words = String(text).split(' '); const lines = []; let line = '';
  for (const w of words) { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

// The end card: the day's counts, all from the data, and the footnote.
export const LOG_FOOTNOTE = "Visualised live from PG1's logs. Location = traffic origin (IP geolocation), not attacker identity.";
export const GEO_FOOTNOTE = 'Countries come from IP geolocation at the network edge and are approximate. No IP addresses are stored.';
const DATE_FMT = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'long', year: 'numeric' }) : null;
export function endCardLines(day, { n = 0, now = Date.now() } = {}) {
  const d = day || {};
  const t = Number(d.turned_away) || 0;
  const date = DATE_FMT ? DATE_FMT.format(new Date(now)) : new Date(now).toISOString().slice(0, 10);
  return [
    `Real PG1 events, ${date} — not a simulation · Hostile traffic from ${n} ${n === 1 ? 'country' : 'countries'} in 24 h`,
    `${t} ${t === 1 ? 'threat' : 'threats'} turned away today`,
    LOG_FOOTNOTE,
    GEO_FOOTNOTE
  ];
}
export const END_CARD_S = 3;

// What a clip records at: 720p 30 fps on the Legacy phone tier (and on any
// phone), 1080p 30 fps otherwise.
export function recordSpec({ coarse = false, legacy = false } = {}) {
  return { maxEdge: legacy || coarse ? 1280 : 1920, fps: RECORD_FPS };
}

export function createRecording(scene, { aspect = '16:9', seconds = 30, mode = 'live', coarse = false, legacy = false, caption = () => null, captionText = null, countries = () => ({ n: 0, strip: '' }), day = () => null, onTick = () => {}, onDone = () => {} } = {}) {
  const mime = pickMime();
  if (!mime || !scene || !scene.canvas || typeof scene.onFrame !== 'function') return null;
  const spec = recordSpec({ coarse, legacy });
  const { w, h } = clipSize(aspect, spec.maxEdge);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const g = out.getContext('2d', { alpha: false });
  const shield = new Path2D(SHIELD); const one = new Path2D(ONE);
  let lastTexts = [];
  let stream = null; let rec = null; let chunks = []; let off = null; let started = 0; let lastAt = 0; let timer = null; let stopping = null;
  const minGap = 1000 / RECORD_FPS - 2;

  const draw = (src) => {
    const now = performance.now();
    if (!rec || now - lastAt < minGap) return;
    lastAt = now;
    const c = coverCrop(src.width, src.height, w, h);
    g.drawImage(src, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
    const u = Math.round(Math.min(w, h) / 36);
    // Watermark: the PG1 shield and name, top left.
    g.save(); g.translate(u, u); g.scale(u * 1.8 / 100, u * 1.8 / 100); g.translate(-181, 0); g.globalAlpha = 0.9; g.fillStyle = '#f3c623'; g.fill(shield); g.fillStyle = '#0a0a0b'; g.fill(one); g.restore();
    g.font = `700 ${Math.round(u * 1.1)}px Inter, system-ui, sans-serif`; g.fillStyle = 'rgba(255,255,255,0.92)'; g.textBaseline = 'middle';
    g.fillText('PG1', u * 3.1, u * 1.9);
    const texts = [];
    // The country counter, top centre.
    const cc = countries() || { n: 0, strip: "" };
    const ct = `${cc.strip ? `${cc.strip}  ` : ''}${countriesText(cc.n)}`;
    g.font = `700 ${Math.round(u * 0.95)}px Inter, system-ui, "Noto Color Emoji", sans-serif`;
    const cw = g.measureText(ct).width;
    g.fillStyle = 'rgba(10,10,11,0.6)'; g.fillRect((w - cw) / 2 - u * 0.6, u * 3.2, cw + u * 1.2, u * 1.7);
    g.fillStyle = '#ffffff'; g.fillText(ct, (w - cw) / 2, u * 4.05); texts.push(ct);
    // The badge: always on.
    const label = clipLabel(mode); texts.push(label);
    g.font = `600 ${Math.round(u * 0.8)}px Inter, system-ui, sans-serif`;
    const lw = g.measureText(label).width;
    g.fillStyle = 'rgba(10,10,11,0.6)'; g.fillRect(w - lw - u * 2.2, u * 0.9, lw + u * 1.4, u * 1.6);
    g.fillStyle = '#ffffff'; g.fillText(label, w - lw - u * 1.5, u * 1.7);
    // The caption: what is happening, from the event itself.
    const text = captionText && caption() ? captionText() : clipCaption(caption(), mode); texts.push(text);
    g.font = `600 ${Math.round(u * 1.05)}px Inter, system-ui, sans-serif`;
    const lines = wrap(g, text, w - u * 4);
    const bh = lines.length * u * 1.5 + u * 1.2;
    g.fillStyle = 'rgba(10,10,11,0.7)'; g.fillRect(u, h - bh - u, w - u * 2, bh);
    g.fillStyle = '#ffffff';
    lines.forEach((l, i) => g.fillText(l, u * 2, h - bh - u + u * 1.35 + i * u * 1.5));
    // The last seconds: the tower and the day's counts.
    if ((now - started) / 1000 > seconds - END_CARD_S) {
      g.fillStyle = 'rgba(10,10,11,0.55)'; g.fillRect(0, h * 0.3, w, h * 0.4);
      g.fillStyle = '#f3c623'; g.font = `700 ${Math.round(u * 1.5)}px Inter, system-ui, sans-serif`;
      const [l1, l2, f1, f2] = endCardLines(day(), { n: cc.n });
      g.font = `700 ${Math.round(u * 1.05)}px Inter, system-ui, sans-serif`;
      let y = h * 0.36;
      for (const l of wrap(g, l1, w - u * 4)) { g.fillText(l, (w - g.measureText(l).width) / 2, y); y += u * 1.4; }
      g.fillStyle = '#3ddc84'; g.fillText(l2, (w - g.measureText(l2).width) / 2, y + u * 0.4); y += u * 2;
      g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = `500 ${Math.round(u * 0.62)}px Inter, system-ui, sans-serif`;
      for (const l of [...wrap(g, f1, w - u * 6), ...wrap(g, f2, w - u * 6)]) { g.fillText(l, (w - g.measureText(l).width) / 2, y); y += u * 0.95; }
      texts.push(l1, l2, f1, f2);
    }
    const track = stream && stream.getVideoTracks()[0];
    if (track && track.requestFrame) track.requestFrame();
    lastTexts = texts;
    onTick(Math.min(seconds, (now - started) / 1000));
  };

  const api = {
    mime, ext: fileExtension(mime), size: { w, h }, fps: spec.fps,
    get recording() { return !!rec; },
    // For the tests: the words drawn on the last frame.
    get texts() { return lastTexts.slice(); },
    start() {
      if (scene.setLight) scene.setLight('dusk');
      stream = out.captureStream(0);
      chunks = [];
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: RECORD_BITS });
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.start(1000);
      started = performance.now(); lastAt = 0;
      off = scene.onFrame(draw);
      timer = setTimeout(() => { api.stop().then(onDone); }, seconds * 1000);
    },
    stop() {
      if (stopping) return stopping;
      if (!rec) return Promise.resolve(null);
      const r = rec; rec = null;
      if (timer) { clearTimeout(timer); timer = null; }
      if (off) { off(); off = null; }
      stopping = new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; for (const t of stream.getTracks()) t.stop(); resolve(chunks.length ? { blob: new Blob(chunks, { type: mime }), mime, ext: fileExtension(mime), seconds: (performance.now() - started) / 1000 } : null); };
        r.onstop = finish; r.onerror = finish;
        setTimeout(finish, 5000);
        try { if (r.state !== 'inactive') r.stop(); else finish(); } catch (e) { finish(); }
      });
      return stopping;
    }
  };
  return api;
}
