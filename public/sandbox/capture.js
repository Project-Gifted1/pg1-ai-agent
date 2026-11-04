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
export const CAPTURE_BITS = 12_000_000;   // 12 Mbit/s: crisp 1080p, and a phone's encoder keeps up
// The video's long edge at most (a phone's screen is 2.5 to 3 times its CSS
// size: recorded at full size, the encoder would fall behind and drop frames).
export const CAPTURE_MAX_EDGE = 1920;
// The video's size for a canvas: the same shape, the long edge at most maxEdge, even numbers.
export function captureSize(w, h, maxEdge = CAPTURE_MAX_EDGE) {
  const k = Math.min(1, maxEdge / Math.max(1, w, h));
  return { w: Math.max(2, Math.round((w * k) / 2) * 2), h: Math.max(2, Math.round((h * k) / 2) * 2) };
}
export const MIMES = Object.freeze(['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']);

export function pickMime(isSupported = (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
  for (const m of MIMES) { try { if (isSupported(m)) return m; } catch (e) { /* not this one */ } }
  return null;
}

export function fileExtension(mime) {
  return /mp4/.test(String(mime)) ? 'mp4' : 'webm';
}

export function createCapture(canvas, { fps = CAPTURE_FPS, bitsPerSecond = CAPTURE_BITS, maxEdge = CAPTURE_MAX_EDGE, stamp = () => 'Simulation' } = {}) {
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
      ({ w: out.width, h: out.height } = captureSize(canvas.width, canvas.height, maxEdge));
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
      // The video keeps the size it started with (an encoder fails if it
      // changes mid-stream); a view drawn with fewer pixels is scaled into it.
      g.drawImage(canvas, 0, 0, out.width, out.height);
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
        let done = false;
        const finish = () => { if (done) return; done = true; for (const t of stream.getTracks()) t.stop(); resolve({ blob: new Blob(chunks, { type: mime }), mime, seconds: (performance.now() - started) / 1000, frames }); };
        r.onstop = finish;
        r.onerror = finish;
        // Whatever happens, Stop ends within a few seconds with what was recorded.
        setTimeout(finish, 5000);
        try { if (r.state !== 'inactive') r.stop(); else finish(); } catch (e) { finish(); }
      });
    }
  };
  return api;
}
