// How long a City browser test may wait for something the page does on its
// own clock (a feed poll, the next frames drawing it), from the frame time
// measured on this machine (tests/browser/kingdom.browser.test.mjs).
//
// Fast frames (a GPU, or software 3D on an idle machine): the product's own
// rule applies unchanged (a live event within 10 s). Slow frames (CI draws
// 3D in software beside other browser files, 600-1700 ms a frame): every
// long frame delays the page's timers and the drawing of what arrived, so
// the wait grows with the frame time, up to a cap. The product rule itself
// ("within one poll interval plus one fetch") is asserted where it can be,
// without a renderer: tests/kingdom-poll.test.mjs.
export const FAST_FRAME_MS = 250;
export const MAX_SCALE = 6;
export function scaledWait(msPerFrame, baseMs = 10000) {
  const ms = Number(msPerFrame);
  if (!Number.isFinite(ms) || ms <= FAST_FRAME_MS) return baseMs;
  return Math.round(baseMs * Math.min(MAX_SCALE, ms / FAST_FRAME_MS));
}
export const framesAreFast = (msPerFrame) => Number.isFinite(Number(msPerFrame)) && Number(msPerFrame) <= FAST_FRAME_MS;
