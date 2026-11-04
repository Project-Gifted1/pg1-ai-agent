// PG1 Sandbox viewer: recording a video of the 3D view in the browser
// itself (no screen recorder, nothing sent anywhere: the file is saved on
// this device). Every frame the view draws is copied once into the
// recording, with the "Simulation · day · time" stamp burnt in (a world is
// a simulation, and its videos say so), at a steady frame rate and a high
// bit rate.
//
//   pickMime(isSupported)  the best format this browser records: MP4 (H.264)
//                          where it can, else WebM (VP9, then VP8)
//   createCapture(canvas, { fps, bitsPerSecond, stamp })
//     -> { start(), frame(), stop() -> Promise<{ blob, mime, seconds, frames }>, recording }
//   frame() is called by the scene after each frame it draws; frames come
//   at most `fps` a second (a faster screen does not make a bigger file).

export const CAPTURE_FPS = 30;
export const CAPTURE_BITS = 16_000_000;   // 16 Mbit/s: crisp 1080p and above
export const MIMES = Object.freeze(['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']);

export function pickMime(isSupported = (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
  for (const m of MIMES) { try { if (isSupported(m)) return m; } catch (e) { /* not this one */ } }
  return null;
}

export function fileExtension(mime) {
  return /mp4/.test(String(mime)) ? 'mp4' : 'webm';
}

export function createCapture(canvas, { fps = CAPTURE_FPS, bitsPerSecond = CAPTURE_BITS, stamp = () => 'Simulation' } = {}) {
  const mime = pickMime();
  if (!mime || !canvas || typeof canvas.captureStream !== 'function') return null;
  // The recording's own canvas: the view, and the stamp in its corner.
  const out = document.createElement('canvas');
  const g = out.getContext('2d', { alpha: false });
  let stream = null; let rec = null; let chunks = []; let frames = 0; let started = 0; let lastAt = 0;
  const minGap = 1000 / fps - 2;
  const api = {
    get recording() { return !!rec; },
    mime,
    start() {
      out.width = canvas.width; out.height = canvas.height;
      stream = out.captureStream(0);
      chunks = []; frames = 0; started = performance.now(); lastAt = 0;
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitsPerSecond });
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.start(1000);
    },
    // One drawn frame into the recording (at most fps a second).
    frame() {
      if (!rec) return;
      const now = performance.now();
      if (now - lastAt < minGap) return;
      lastAt = now;
      if (out.width !== canvas.width || out.height !== canvas.height) { out.width = canvas.width; out.height = canvas.height; }
      g.drawImage(canvas, 0, 0);
      const text = stamp();
      const fs = Math.max(14, Math.round(out.height / 40));
      g.font = `600 ${fs}px system-ui, sans-serif`;
      const w = g.measureText(text).width;
      g.fillStyle = 'rgba(10,10,11,0.6)'; g.fillRect(fs * 0.6, out.height - fs * 2.4, w + fs * 1.2, fs * 1.8);
      g.fillStyle = '#ffffff'; g.fillText(text, fs * 1.2, out.height - fs * 1.05);
      const track = stream.getVideoTracks()[0];
      if (track && track.requestFrame) track.requestFrame();
      frames++;
    },
    stop() {
      if (!rec) return Promise.resolve(null);
      const r = rec; rec = null;
      return new Promise((resolve) => {
        r.onstop = () => { for (const t of stream.getTracks()) t.stop(); resolve({ blob: new Blob(chunks, { type: mime }), mime, seconds: (performance.now() - started) / 1000, frames }); };
        r.stop();
      });
    }
  };
  return api;
}
