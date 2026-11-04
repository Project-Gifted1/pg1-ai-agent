// How a walker's legs swing for its speed, so its feet never slide.
//
// A leg of length L (the hip's height) swinging a radians either side of
// straight down puts the foot 2·L·sin(a) ahead of the other one: one step.
// The legs move through a whole sine cycle (phase 0..2π) every two steps,
// so at `rate` radians a second the walker covers rate/π steps a second:
// the swing keeps up with the ground exactly when
//   rate = π · speed / (2 · L · sin(a)).
// Walking (up to about 2.6 m/s) the swing grows with the speed, to 0.55 rad
// at a brisk walk; running it is wider (0.8 rad), so a runner's stride is
// longer as well as quicker. Pure, no imports (tests/sandbox-play.test.mjs).

export const RUN_FROM = 2.6;     // m/s: faster than this is a run

export function gait(speed, hip = 0.88) {
  const v = Math.max(0, Number(speed) || 0);
  const L = Math.max(0.15, Number(hip) || 0.88);
  if (v < 0.05) return { amp: 0, rate: 0, stepLength: 0, run: false };
  const run = v > RUN_FROM;
  const amp = run ? 0.8 : Math.min(0.55, 0.22 + v * 0.24);
  const stepLength = 2 * L * Math.sin(amp);
  return { amp, rate: (Math.PI * v) / stepLength, stepLength, run };
}

// The ground the feet cover in `seconds` at that gait (steps × step length):
// equal to speed × seconds when nothing slides.
export function groundCovered(g, seconds) {
  return g.rate ? ((g.rate * seconds) / Math.PI) * g.stepLength : 0;
}
