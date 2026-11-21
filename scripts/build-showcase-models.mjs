#!/usr/bin/env node
// PG1 Showcase hero models, authored in code and exported as GLB
// (public/showcase/models/). Original PG1 work, released CC0
// (docs/assets-licences.md). Each under 2 MB. Used by the Showcase profile
// only (public/sandbox/showcase-look.js loadHero); the live tiers keep their
// own light models.
//
//   node scripts/build-showcase-models.mjs
//
//   canoe.glb  a carved dugout canoe (Benin–Warri c. 1610): one trunk, a
//              raised carved prow and stern, a rim, thwarts, and three
//              paddlers in wrappers with leaf-bladed paddles. Length along x
//              (7.4 m), waterline at y = 0. Nodes: hull, paddlers.
//   car.glb    a saloon car for PG1 City: body (vertex coloured: paint white
//              so the instance colour shows, tyres and trim dark), glass, lamps.
//              Length along z (4.5 m), ground at y = 0. Nodes: body, glass.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './showcase-render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'showcase', 'models');

// Runs in the page: builds the models and returns each GLB as base64.
const BUILD = async () => {
  const THREE = await import('/vendor/three/three.module.min.js');
  const { GLTFExporter } = await import('/vendor/three/addons/exporters/GLTFExporter.js');
  const { mergeGeometries } = await import('/vendor/three/addons/utils/BufferGeometryUtils.js');
  const colour = (g, c) => { const col = new THREE.Color(c); const n = g.attributes.position.count; const a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
  const prep = (g) => { const x = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(x.attributes)) if (!['position', 'normal', 'color', 'uv'].includes(k)) x.deleteAttribute(k); if (!x.attributes.uv) x.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(x.attributes.position.count * 2), 2)); x.computeVertexNormals(); return x; };
  const at = (g, x, y, z, rx = 0, ry = 0, rz = 0, s = null) => { if (s) g.scale(...s); g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz); g.translate(x, y, z); return g; };
  const merge = (list) => mergeGeometries(list.map(prep), false);
  // Wood grain as a small canvas texture (no external image).
  const woodTex = (() => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128; const g = c.getContext('2d');
    g.fillStyle = '#5e3f26'; g.fillRect(0, 0, 512, 128);
    let s = 7; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 220; i++) { const y = r() * 128; g.strokeStyle = `rgba(${30 + r() * 40},${18 + r() * 20},${8 + r() * 10},${0.25 + r() * 0.4})`; g.lineWidth = 0.5 + r() * 2.2; g.beginPath(); g.moveTo(0, y); for (let x = 0; x <= 512; x += 16) g.lineTo(x, y + Math.sin(x / 40 + i) * 2.5 + (r() - 0.5) * 1.5); g.stroke(); }
    for (let i = 0; i < 14; i++) { const x = r() * 512; const y = r() * 128; g.fillStyle = 'rgba(35,20,10,0.5)'; g.beginPath(); g.ellipse(x, y, 6 + r() * 8, 2 + r() * 2, 0, 0, Math.PI * 2); g.fill(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  })();

  // --- the canoe ---
  function hullGeometry() {
    // A dugout: U-shaped sections along x, widest amidships, the ends rising
    // into carved points; outside and inside surfaces, a rim between them.
    const N = 64; const M = 18; const L = 7.4;
    const pos = []; const uv = []; const idx = [];
    const section = (u, inner) => {
      const x = (u - 0.5) * L; const e = Math.abs(u - 0.5) * 2;
      const w = 0.56 * Math.pow(Math.max(0, 1 - Math.pow(e, 2.4)), 0.55) + 0.02;
      const depth = 0.62 * (1 - 0.35 * e * e); const rise = 0.42 * Math.pow(e, 4);
      const pts = [];
      for (let j = 0; j <= M; j++) { const a = Math.PI * (j / M); const k = inner ? 0.86 : 1; const sy = inner ? 0.08 : 0; pts.push([x, -Math.sin(a) * depth * k + rise + 0.62 + sy - (inner ? 0 : 0), Math.cos(a) * w * k]); }
      return pts;
    };
    for (const inner of [false, true]) {
      const base = pos.length / 3;
      for (let i = 0; i <= N; i++) { const s = section(i / N, inner); for (let j = 0; j <= M; j++) { pos.push(...s[j]); uv.push(i / N * 4, j / M); } }
      for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) { const a = base + i * (M + 1) + j; const b = a + M + 1; if (inner) idx.push(a, a + 1, b, b, a + 1, b + 1); else idx.push(a, b, a + 1, b, b + 1, a + 1); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.translate(0, -0.3, 0); g.computeVertexNormals();
    return g;
  }
  const hull = new THREE.Mesh(hullGeometry(), new THREE.MeshStandardMaterial({ map: woodTex, color: 0xffffff, roughness: 0.78, metalness: 0, side: THREE.DoubleSide }));
  hull.name = 'hull';
  // Carving: rings and a lug at the prow and stern, a rim, thwarts.
  const carve = [];
  for (const sx of [-1, 1]) {
    for (let r = 0; r < 4; r++) carve.push(colour(at(new THREE.TorusGeometry(0.1 + r * 0.02, 0.018, 6, 16), sx * (3.2 - r * 0.16), 0.62 + 0.08 * (3 - r), 0, 0, Math.PI / 2, 0), r % 2 ? '#3b2516' : '#7a5232'));
    carve.push(colour(at(new THREE.ConeGeometry(0.07, 0.4, 8), sx * 3.62, 0.98, 0, 0, 0, -sx * 0.5), '#3b2516'));
  }
  for (const z of [-1, 1]) carve.push(colour(at(new THREE.BoxGeometry(6.4, 0.05, 0.06), 0, 0.64, z * 0.5), '#3e2716'));
  for (const x of [-2.0, -0.4, 1.2, 2.5]) carve.push(colour(at(new THREE.BoxGeometry(0.14, 0.05, 1.0), x, 0.5, 0), '#7a5232'));
  const carving = new THREE.Mesh(mergeGeometries(carve.map(prep)), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }));
  carving.name = 'carving';
  // Paddlers: kneeling, paddle in the water on alternate sides.
  function paddler(x, side, wrap) {
    const skin = '#4a2e1f'; const p = [];
    p.push(colour(at(new THREE.CylinderGeometry(0.17, 0.2, 0.32, 12), x, 0.62, 0), wrap));                 // wrapper round the hips
    p.push(colour(at(new THREE.CapsuleGeometry(0.15, 0.34, 4, 10), x + 0.04, 0.98, 0, 0, 0, -0.15), skin)); // torso
    p.push(colour(at(new THREE.SphereGeometry(0.11, 12, 10), x + 0.1, 1.33, 0), skin));                      // head
    p.push(colour(at(new THREE.CapsuleGeometry(0.075, 0.42, 3, 8), x - 0.14, 0.5, side * 0.12, 0, 0, Math.PI / 2), wrap)); // legs, kneeling
    const ax = x + 0.2; const handY = 1.0;
    p.push(colour(at(new THREE.CapsuleGeometry(0.045, 0.34, 3, 6), ax, handY + 0.12, side * 0.18, side * 0.6, 0, 0.5), skin));
    p.push(colour(at(new THREE.CapsuleGeometry(0.045, 0.34, 3, 6), ax + 0.05, handY - 0.08, side * 0.3, side * 0.9, 0, 0.3), skin));
    // The paddle: a pole and a leaf blade dipping on this side.
    const pole = at(new THREE.CylinderGeometry(0.022, 0.022, 1.7, 6), 0, 0, 0); const blade = at(new THREE.SphereGeometry(0.14, 10, 8), 0, -0.95, 0, 0, 0, 0, [1, 2.3, 0.18]);
    const paddle = mergeGeometries([prep(colour(pole, '#8a6440')), prep(colour(blade, '#6d4a2c'))]);
    paddle.rotateX(side * 0.75); paddle.rotateZ(0.35); paddle.translate(ax + 0.1, 0.75, side * 0.55);
    p.push(paddle);
    return p;
  }
  const people = new THREE.Mesh(merge([...paddler(-1.6, 1, '#e8e0cc'), ...paddler(0.2, -1, '#2c3e6b'), ...paddler(1.9, 1, '#9b2c22')]), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
  people.name = 'paddlers';
  const canoe = new THREE.Group(); canoe.name = 'canoe'; canoe.add(hull, carving, people);

  // --- the car ---
  function carBody() {
    const s = new THREE.Shape();
    const P = [[-2.25, 0.32], [-2.3, 0.62], [-2.12, 0.86], [-1.2, 0.92], [1.6, 0.9], [2.2, 0.78], [2.28, 0.5], [2.22, 0.32]];
    s.moveTo(...P[0]); for (const p of P.slice(1)) s.lineTo(...p); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 1.74, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.07, bevelSegments: 3, curveSegments: 6 });
    g.translate(0, 0, -0.87); g.rotateY(-Math.PI / 2);
    const parts = [colour(g, '#ffffff')];
    for (const [x, z] of [[-0.86, -1.45], [0.86, -1.45], [-0.86, 1.4], [0.86, 1.4]]) { parts.push(colour(at(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 18), x, 0.34, z, 0, 0, Math.PI / 2), '#111214')); parts.push(colour(at(new THREE.CylinderGeometry(0.2, 0.2, 0.25, 12), x * 1.01, 0.34, z, 0, 0, Math.PI / 2), '#8d939b')); }
    parts.push(colour(at(new THREE.BoxGeometry(1.86, 0.12, 0.1), 0, 0.42, 2.3), '#1b1d20'));
    parts.push(colour(at(new THREE.BoxGeometry(1.86, 0.12, 0.1), 0, 0.42, -2.32), '#1b1d20'));
    return merge(parts);
  }
  function carGlass() {
    const s = new THREE.Shape(); const P = [[-1.25, 0.9], [-0.75, 1.42], [0.75, 1.44], [1.45, 0.9]];
    s.moveTo(...P[0]); for (const p of P.slice(1)) s.lineTo(...p); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 1.5, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2 });
    g.translate(0, 0, -0.75); g.rotateY(-Math.PI / 2); return prep(g);
  }
  const body = new THREE.Mesh(carBody(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.55 })); body.name = 'body';
  const glass = new THREE.Mesh(carGlass(), new THREE.MeshStandardMaterial({ color: 0x14191f, roughness: 0.06, metalness: 0.9 })); glass.name = 'glass';
  const car = new THREE.Group(); car.name = 'car'; car.add(body, glass);

  const exporter = new GLTFExporter();
  const out = {};
  for (const [name, obj] of [['canoe', canoe], ['car', car]]) {
    const buf = await exporter.parseAsync(obj, { binary: true, maxTextureSize: 512 });
    let bin = ''; const u8 = new Uint8Array(buf); for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    out[name] = btoa(bin);
  }
  return out;
};

export async function main() {
  const { chromium } = await import('playwright');
  let executablePath; if (!existsSync(chromium.executablePath()) && existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  const { server, origin } = await startServer({ feed: { events: [] }, worlds: {} });
  const browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/showcase/blank.html`);
    const out = await page.evaluate(BUILD);
    mkdirSync(OUT, { recursive: true });
    for (const [name, b64] of Object.entries(out)) {
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 2 * 1024 * 1024) throw new Error(`${name}.glb is over 2 MB`);
      writeFileSync(join(OUT, `${name}.glb`), buf);
      console.log(`[models] ${name}.glb ${buf.length} bytes`);
    }
  } finally { await browser.close(); server.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
