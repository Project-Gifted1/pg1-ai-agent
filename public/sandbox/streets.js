// PG1 Sandbox viewer: streets drawn in detail (Medium and up; quality.js).
//
// From the world's road graph when it has one (world.roads: nodes [[x, y]],
// edges [[a, b, width, name]]), otherwise from its road strips (kind
// "road": a centre, a heading, a length and a width). Either way, in world
// metres, turned into:
//
//   asphalt          one ribbon per edge, a disc at every node so joins
//                    and junctions are seamless
//   markings         a dashed centre line and solid edge lines on roads
//                    7 m wide or more; none on lanes and footpaths
//   kerbs, pavements a raised kerb and a paved strip on each side of every
//                    road a vehicle can use, cut back at junctions
//   crossings        zebra stripes on each arm of a junction of three or
//                    more roads
//   street lamps     every ~36 m, alternating sides, instanced; their heads
//                    and the pools of light under them come on at night
//
// Footpaths (narrower than 3.5 m) are drawn as paving only. Everything here
// is geometry made in code (no downloaded assets).
//
//   roadSegments(world)                       [{ ax, ay, bx, by, w, a, b }] in world metres
//   buildStreets(THREE, world, { heightAt, setupMaterial, coarse, lamps })
//     -> { group, update(night), covers(x, z), dispose(), stats }
//   covers(x, z): true on a road, kerb or pavement (scene metres)

export const FOOTPATH_WIDTH = 3.5;
const PAVE = 2.2; const KERB = 0.25;
const LAMP_EVERY = 36; const MAX_LAMPS = 1600;

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// The road network as segments, from the graph if there is one, else from strips.
export function roadSegments(world) {
  const out = [];
  const r = world && world.roads;
  if (r && Array.isArray(r.nodes) && Array.isArray(r.edges) && r.edges.length) {
    for (const e of r.edges) {
      const A = r.nodes[e[0]]; const B = r.nodes[e[1]];
      if (!A || !B) continue;
      out.push({ ax: num(A[0], 0), ay: num(A[1], 0), bx: num(B[0], 0), by: num(B[1], 0), w: Math.max(1.5, Math.min(40, num(e[2], 8))), a: e[0], b: e[1] });
    }
    return out;
  }
  let n = 0;
  for (const e of (world && world.entities) || []) {
    if (e.base !== 'road') continue;
    const p = e.props || {};
    const len = Math.max(4, Math.min(4000, num(p.length, 100))); const w = Math.max(2, Math.min(40, num(p.width, 12)));
    const h = num(p.heading, 0) * Math.PI / 180;
    const dx = Math.cos(h) * len / 2; const dy = Math.sin(h) * len / 2;
    out.push({ ax: e.x - dx, ay: e.y - dy, bx: e.x + dx, by: e.y + dy, w, a: `s${n}a`, b: `s${n}b` });
    n++;
  }
  // Strips that meet end to end or cross share a node, so junctions are found.
  const key = (x, y) => `${Math.round(x / 6)}|${Math.round(y / 6)}`;
  const ids = new Map();
  for (const s of out) {
    for (const end of ['a', 'b']) {
      const x = end === 'a' ? s.ax : s.bx; const y = end === 'a' ? s.ay : s.by;
      const k = key(x, y);
      if (ids.has(k)) s[end] = ids.get(k); else ids.set(k, s[end]);
    }
  }
  return out;
}

// Vertex-coloured triangles, batched.
class Batch {
  constructor() { this.pos = []; this.col = []; }
  quad(p, c) { // p: four [x, y, z], counter-clockwise from above
    const [a, b, d, e] = p;
    // Wound so the faces look up (scene z runs opposite to world y).
    this.pos.push(...a, ...d, ...b, ...a, ...e, ...d);
    for (let i = 0; i < 6; i++) this.col.push(c[0], c[1], c[2]);
  }
  disc(x, y, z, r, c, seg = 14) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2; const a1 = ((i + 1) / seg) * Math.PI * 2;
      this.pos.push(x, y, z, x + Math.cos(a0) * r, y, z - Math.sin(a0) * r, x + Math.cos(a1) * r, y, z - Math.sin(a1) * r);
      for (let k = 0; k < 3; k++) this.col.push(c[0], c[1], c[2]);
    }
  }
  geometry(THREE) {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const rgb = (h) => { const n = parseInt(h.slice(1), 16); const f = (v) => Math.pow(v / 255, 2.2); return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]; };
const ASPHALT = rgb('#3a3d42'); const ASPHALT_B = rgb('#33363a'); const PAVING = rgb('#a9a59c'); const KERBC = rgb('#c9c6bf');
const PATH = rgb('#b9a98a'); const WHITE = rgb('#eceae4'); const YELLOW = rgb('#e8c547');

export function buildStreets(THREE, world, { heightAt = () => 0, setupMaterial = (m) => m, coarse = false, lamps = true } = {}) {
  const segs = roadSegments(world);
  const W = world.size.x; const D = world.size.y;
  const sx = (x) => x - W / 2; const sz = (y) => -(y - D / 2);
  const groundY = (x, y) => Math.max(0, heightAt(sx(x), sz(y)));
  // Node degree and the widest road at each node (junction size).
  const deg = new Map(); const widest = new Map(); const pos = new Map();
  for (const s of segs) for (const [n, x, y] of [[s.a, s.ax, s.ay], [s.b, s.bx, s.by]]) {
    deg.set(n, (deg.get(n) || 0) + 1);
    widest.set(n, Math.max(widest.get(n) || 0, s.w));
    pos.set(n, [x, y]);
  }
  // A grid of the segments, for covers().
  const GRID = 40; const grid = new Map();
  for (const s of segs) {
    const pad = s.w / 2 + (s.w < FOOTPATH_WIDTH ? 0.3 : KERB + PAVE);
    const x0 = Math.min(s.ax, s.bx) - pad; const x1 = Math.max(s.ax, s.bx) + pad; const y0 = Math.min(s.ay, s.by) - pad; const y1 = Math.max(s.ay, s.by) + pad;
    for (let gx = Math.floor(x0 / GRID); gx <= Math.floor(x1 / GRID); gx++) for (let gy = Math.floor(y0 / GRID); gy <= Math.floor(y1 / GRID); gy++) {
      const k = `${gx}|${gy}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push([s, pad]);
    }
  }
  const covers = (x, z) => {
    const wx = x + W / 2; const wy = D / 2 - z;
    const list = grid.get(`${Math.floor(wx / GRID)}|${Math.floor(wy / GRID)}`);
    if (!list) return false;
    for (const [s, pad] of list) {
      const dx = s.bx - s.ax; const dy = s.by - s.ay; const L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((wx - s.ax) * dx + (wy - s.ay) * dy) / L2));
      if (Math.hypot(wx - s.ax - dx * t, wy - s.ay - dy * t) < pad) return true;
    }
    return false;
  };
  const ground = new Batch(); const marks = new Batch();
  const lampSpots = [];
  const Y_ROAD = 0.09; const Y_PAVE = 0.16; const Y_MARK = 0.11;
  for (const s of segs) {
    const dx = s.bx - s.ax; const dy = s.by - s.ay; const L = Math.hypot(dx, dy);
    if (L < 0.5) continue;
    const ux = dx / L; const uy = dy / L; const nx = -uy; const ny = ux;
    const path = s.w < FOOTPATH_WIDTH;
    // Offsets along the edge: (t metres from A, o metres to the left) -> scene point.
    const P = (t, o, lift) => { const x = s.ax + ux * t + nx * o; const y = s.ay + uy * t + ny * o; return [sx(x), groundY(x, y) + lift, sz(y)]; };
    // Long edges are split so the surface follows the ground (island worlds dip at the coast).
    const pieces = Math.max(1, Math.ceil(L / 60));
    const strip = (t0, t1, o0, o1, lift, c, into = ground) => {
      const n = Math.max(1, Math.ceil(((t1 - t0) / L) * pieces));
      for (let i = 0; i < n; i++) {
        const a = t0 + ((t1 - t0) * i) / n; const b = t0 + ((t1 - t0) * (i + 1)) / n;
        into.quad([P(a, o0, lift), P(a, o1, lift), P(b, o1, lift), P(b, o0, lift)], c);
      }
    };
    const half = s.w / 2;
    strip(0, L, -half, half, Y_ROAD, path ? PATH : ((Math.round(s.ax + s.ay) & 1) ? ASPHALT : ASPHALT_B));
    if (path) continue;
    // Cut back at junctions (and at dead ends, a little, so kerbs do not poke out).
    const cutA = (deg.get(s.a) || 0) >= 2 ? Math.min(L / 2, (widest.get(s.a) || s.w) / 2 + PAVE + 1) : 0;
    const cutB = (deg.get(s.b) || 0) >= 2 ? Math.min(L / 2, (widest.get(s.b) || s.w) / 2 + PAVE + 1) : 0;
    const t0 = cutA; const t1 = L - cutB;
    if (t1 > t0 + 1) {
      for (const side of [-1, 1]) {
        strip(t0, t1, side * half, side * (half + KERB), Y_PAVE + 0.02, KERBC);
        strip(t0, t1, side * (half + KERB), side * (half + KERB + PAVE), Y_PAVE, PAVING);
      }
      // Markings: a dashed centre line, solid edge lines (7 m and wider).
      if (s.w >= 7) {
        const centre = s.w >= 12 ? YELLOW : WHITE;
        for (let t = t0 + 2; t + 3 < t1; t += 9) strip(t, t + 3, -0.08, 0.08, Y_MARK, centre, marks);
        for (const side of [-1, 1]) strip(t0, t1, side * (half - 0.45), side * (half - 0.3), Y_MARK, WHITE, marks);
      }
      if (lamps) {
        let i = 0;
        for (let t = t0 + 6; t < t1 - 3; t += LAMP_EVERY) {
          const side = i++ % 2 ? 1 : -1;
          const x = s.ax + ux * t + nx * side * (half + KERB + 0.5); const y = s.ay + uy * t + ny * side * (half + KERB + 0.5);
          lampSpots.push([x, y, Math.atan2(-ny * side, -nx * side), s.w]);
        }
      }
    }
    // Zebra crossings on each arm of a junction of three or more roads.
    for (const [node, atA] of [[s.a, true], [s.b, false]]) {
      if ((deg.get(node) || 0) < 3 || s.w < 6 || L < 20) continue;
      const base = (widest.get(node) || s.w) / 2 + PAVE + 2;
      const t = atA ? base : L - base - 3;
      if (t < 0 || t + 3 > L) continue;
      for (let o = -half + 0.6; o + 0.5 < half - 0.3; o += 1.1) strip(t, t + 3, o, o + 0.5, Y_MARK + 0.005, WHITE, marks);
    }
  }
  // Junction and joint discs.
  for (const [n, d] of deg) {
    const [x, y] = pos.get(n); const w = widest.get(n);
    if (d >= 2 || w >= FOOTPATH_WIDTH) ground.disc(sx(x), groundY(x, y) + Y_ROAD - 0.004, sz(y), w / 2 + (d >= 3 ? 0.6 : 0), w < FOOTPATH_WIDTH ? PATH : ASPHALT, d >= 3 ? 20 : 12);
  }

  const group = new THREE.Group();
  group.name = 'streets';
  const surf = setupMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  const paint = setupMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
  const gg = ground.geometry(THREE); const mg = marks.geometry(THREE);
  if (gg) { const m = new THREE.Mesh(gg, surf); m.receiveShadow = !coarse; group.add(m); }
  if (mg) { const m = new THREE.Mesh(mg, paint); m.receiveShadow = !coarse; group.add(m); }

  // Street lamps: a pole and arm (lit), a head (glows at night), a pool of light on the road.
  let heads = null; let pools = null; let poles = null;
  const lampN = Math.min(MAX_LAMPS, lampSpots.length);
  if (lampN) {
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 7, 6); poleGeo.translate(0, 3.5, 0);
    const arm = new THREE.BoxGeometry(1.6, 0.1, 0.1); arm.translate(0.75, 6.95, 0);
    const pg = mergeTwo(THREE, poleGeo, arm);
    poles = new THREE.InstancedMesh(pg, setupMaterial(new THREE.MeshStandardMaterial({ color: 0x4a4f55, roughness: 0.5, metalness: 0.6 })), lampN);
    const headGeo = new THREE.BoxGeometry(0.7, 0.16, 0.34); headGeo.translate(1.45, 6.85, 0);
    const headMat = new THREE.MeshBasicMaterial({ color: 0x2a2a2a, toneMapped: false });
    heads = new THREE.InstancedMesh(headGeo, headMat, lampN);
    const poolGeo = new THREE.CircleGeometry(7, 20); poolGeo.rotateX(-Math.PI / 2); poolGeo.translate(1.45, 0.14, 0);
    const poolMat = new THREE.MeshBasicMaterial({ map: poolTexture(THREE), color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12 });
    pools = new THREE.InstancedMesh(poolGeo, poolMat, lampN);
    const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const p = new THREE.Vector3(); const one = new THREE.Vector3(1, 1, 1); const up = new THREE.Vector3(0, 1, 0);
    // Evenly thinned when there are more than the cap.
    const step = lampSpots.length / lampN;
    for (let i = 0; i < lampN; i++) {
      const [x, y, yaw] = lampSpots[Math.floor(i * step)];
      q.setFromAxisAngle(up, yaw);
      m4.compose(p.set(sx(x), groundY(x, y) + Y_PAVE, sz(y)), q, one);
      poles.setMatrixAt(i, m4); heads.setMatrixAt(i, m4); pools.setMatrixAt(i, m4);
    }
    for (const o of [poles, heads, pools]) { o.instanceMatrix.needsUpdate = true; o.computeBoundingSphere(); group.add(o); }
    poles.castShadow = !coarse;
    pools.renderOrder = 2;
  }
  return {
    group,
    covers,
    stats: { segments: segs.length, lamps: lampN, junctions: [...deg.values()].filter((d) => d >= 3).length },
    // 0 by day, 1 at night: the lamps come on at dusk.
    update(night) {
      if (!heads) return;
      const on = Math.max(0, Math.min(1, (night - 0.35) / 0.3));
      heads.material.color.setRGB(0.16 + on * 2.4, 0.16 + on * 1.9, 0.16 + on * 1.2);
      pools.material.opacity = on * 0.55;
      pools.visible = on > 0.01;
    },
    dispose() { group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); }
  };
}

function mergeTwo(THREE, a, b) {
  const A = a.index ? a.toNonIndexed() : a; const B = b.index ? b.toNonIndexed() : b;
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const x = A.attributes[name].array; const y = B.attributes[name].array;
    const z = new Float32Array(x.length + y.length); z.set(x); z.set(y, x.length);
    g.setAttribute(name, new THREE.BufferAttribute(z, 3));
  }
  for (const o of [a, b, A, B]) o.dispose();
  return g;
}

// A soft round gradient for the pools of lamplight.
function poolTexture(THREE) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.5, 'rgba(255,255,255,0.45)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
