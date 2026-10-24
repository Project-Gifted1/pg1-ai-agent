// Makes the Sandbox viewer's PBR textures: public/sandbox/textures/*.png.
//
//   node scripts/make-sandbox-textures.mjs
//
// Five tileable 256 px materials (grass, sand, rock, snow, plaster), each
// two images: <name>_albedo.png (colour, sRGB) and <name>_nr.png (the
// normal's x and y in red and green, roughness in blue). Generated here
// from seeded, periodic noise, the same bytes every run, with no download
// and no dependency (a small PNG writer below). They are released under
// CC0 1.0 (public/sandbox/textures/LICENSE.txt): procedural, not
// photo-scanned.

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const N = 256;
const OUT = new URL('../public/sandbox/textures/', import.meta.url);

// --- a minimal PNG writer (RGB, 8 bit) --------------------------------------------------------
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgb) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(N * (N * 3 + 1));
  for (let y = 0; y < N; y++) { raw[y * (N * 3 + 1)] = 0; rgb.copy(raw, y * (N * 3 + 1) + 1, y * N * 3, (y + 1) * N * 3); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// --- seeded, periodic noise (tiles at N) -----------------------------------------------------
function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function periodicNoise(seed, cells) {
  const r = rng(seed); const g = Float32Array.from({ length: cells * cells }, r);
  const fade = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = (x / N) * cells; const fy = (y / N) * cells;
    const x0 = Math.floor(fx); const y0 = Math.floor(fy); const tx = fade(fx - x0); const ty = fade(fy - y0);
    const at = (i, j) => g[((j % cells) + cells) % cells * cells + (((i % cells) + cells) % cells)];
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx; const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  };
}
function fbm(seed, base = 4, octaves = 5) {
  const layers = Array.from({ length: octaves }, (_, i) => periodicNoise(seed + i * 101, base << i));
  return (x, y) => { let t = 0; let amp = 0.5; let tot = 0; for (const l of layers) { t += l(x, y) * amp; tot += amp; amp *= 0.5; } return t / tot; };
}
// Cellular (Worley) distance, periodic: cracks and pebbles.
function cells(seed, count) {
  const r = rng(seed); const pts = Array.from({ length: count }, () => [r() * N, r() * N]);
  return (x, y) => {
    let d1 = 1e9; let d2 = 1e9;
    for (const [px, py] of pts) for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const d = Math.hypot(x - (px + ox * N), y - (py + oy * N));
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
    return { d1, d2 };
  };
}

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;

// material(x, y) -> { r, g, b (0..1, linear-ish sRGB), h (height 0..1), rough (0..1) }
const MATERIALS = {
  grass: (() => {
    const n = fbm(11, 8, 5); const blades = periodicNoise(12, 64); const tint = fbm(13, 2, 3);
    return (x, y) => {
      const b = blades(x, y * 0.35); const t = tint(x, y); const h = clamp(n(x, y) * 0.5 + b * 0.5);
      return { r: mix(0.17, 0.33, h) * mix(0.85, 1.1, t), g: mix(0.30, 0.52, h), b: mix(0.09, 0.18, h) * mix(0.9, 1.1, t), h, rough: mix(0.95, 0.8, b) };
    };
  })(),
  sand: (() => {
    const grain = periodicNoise(21, 128); const ripple = fbm(22, 3, 3); const big = fbm(23, 2, 3);
    return (x, y) => {
      const w = Math.sin((y / N) * Math.PI * 2 * 9 + ripple(x, y) * 6) * 0.5 + 0.5;
      const h = clamp(w * 0.55 + grain(x, y) * 0.45); const k = mix(0.9, 1.08, big(x, y));
      return { r: mix(0.70, 0.86, h) * k, g: mix(0.61, 0.76, h) * k, b: mix(0.44, 0.56, h) * k, h, rough: 0.92 };
    };
  })(),
  rock: (() => {
    const n = fbm(31, 4, 6); const c = cells(32, 28); const fine = periodicNoise(33, 128);
    return (x, y) => {
      const { d1, d2 } = c(x, y); const crack = clamp((d2 - d1) / 10);
      const h = clamp(n(x, y) * 0.7 + crack * 0.3 - (1 - crack) * 0.2 + fine(x, y) * 0.1);
      const v = mix(0.32, 0.56, h);
      return { r: v * 1.02, g: v, b: v * 0.95, h, rough: mix(0.75, 0.95, 1 - crack) };
    };
  })(),
  snow: (() => {
    const n = fbm(41, 3, 5); const sparkle = rng(42); const sp = Float32Array.from({ length: N * N }, () => (sparkle() > 0.995 ? 1 : 0));
    return (x, y) => {
      const h = n(x, y); const s = sp[(y % N) * N + (x % N)];
      return { r: mix(0.86, 0.96, h), g: mix(0.89, 0.97, h), b: mix(0.93, 1, h), h, rough: s ? 0.25 : mix(0.75, 0.6, h) };
    };
  })(),
  plaster: (() => {
    const n = fbm(51, 6, 5); const fine = periodicNoise(52, 128);
    return (x, y) => {
      const h = clamp(n(x, y) * 0.8 + fine(x, y) * 0.2); const v = mix(0.72, 0.86, h);
      return { r: v, g: v, b: v * 0.98, h, rough: mix(0.9, 0.7, h) };
    };
  })()
};

mkdirSync(OUT, { recursive: true });
const toByte = (v) => Math.round(clamp(v) * 255);
for (const [name, mat] of Object.entries(MATERIALS)) {
  const albedo = Buffer.alloc(N * N * 3); const nr = Buffer.alloc(N * N * 3); const H = new Float32Array(N * N); const R = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const m = mat(x, y); const i = y * N + x;
    albedo[i * 3] = toByte(m.r); albedo[i * 3 + 1] = toByte(m.g); albedo[i * 3 + 2] = toByte(m.b);
    H[i] = m.h; R[i] = m.rough;
  }
  const at = (x, y) => H[((y + N) % N) * N + ((x + N) % N)];
  const k = name === 'snow' ? 1.2 : name === 'sand' ? 2 : 4;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * k; const dy = (at(x, y + 1) - at(x, y - 1)) * k;
    const l = Math.hypot(dx, dy, 1); const i = y * N + x;
    nr[i * 3] = toByte(-dx / l * 0.5 + 0.5); nr[i * 3 + 1] = toByte(-dy / l * 0.5 + 0.5); nr[i * 3 + 2] = toByte(R[i]);
  }
  writeFileSync(new URL(`${name}_albedo.png`, OUT), png(albedo));
  writeFileSync(new URL(`${name}_nr.png`, OUT), png(nr));
  console.log(`${name}: written`);
}
writeFileSync(new URL('LICENSE.txt', OUT), `The textures in this folder were generated by scripts/make-sandbox-textures.mjs
(seeded, periodic noise; procedural, not photo-scanned) and are dedicated to the
public domain under CC0 1.0 Universal:
https://creativecommons.org/publicdomain/zero/1.0/

  <name>_albedo.png  colour (sRGB)
  <name>_nr.png      normal x (red) and y (green), roughness (blue)
`);
