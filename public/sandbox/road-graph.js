// PG1 Sandbox viewer: the road network (lib/sandbox/roads.mjs), drawn from
// the world's road data: asphalt ribbons for roads and driveways, light
// paths for footpaths, and a round patch at every junction so corners join.
// One merged mesh; rebuilt only when the roads or the ground change.
//
//   roadMesh(THREE, roads, size, heightAt, material) -> THREE.Mesh | null
//   roadCells(roads, size, cell) -> Set of "i,j" cells a road covers (so
//                                   grass and woods keep off the roads)
// Coordinates: world (x east, y north) in; scene (x, -z) out, as the scene.

export const FOOTPATH_WIDTH = 3.5;

export function roadCells(roads, size, cell = 20) {
  const out = new Set();
  if (!roads || !Array.isArray(roads.nodes)) return out;
  for (const [a, b, w] of roads.edges) {
    const A = roads.nodes[a]; const B = roads.nodes[b]; if (!A || !B) continue;
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]); const n = Math.max(1, Math.ceil(L / (cell / 2)));
    for (let i = 0; i <= n; i++) {
      const x = A[0] + ((B[0] - A[0]) * i) / n - size.x / 2; const z = -(A[1] + ((B[1] - A[1]) * i) / n - size.y / 2);
      const r = Math.ceil((w / 2 + 3) / cell);
      for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) out.add(`${Math.floor(x / cell) + di},${Math.floor(z / cell) + dj}`);
    }
  }
  return out;
}

export function roadMesh(THREE, roads, size, heightAt, material) {
  if (!roads || !Array.isArray(roads.nodes) || !roads.edges || !roads.edges.length) return null;
  const pos = []; const col = []; const idx = [];
  const asphalt = new THREE.Color('#3b3e44'); const drive = new THREE.Color('#55585e'); const path = new THREE.Color('#b9a782');
  const S = (p) => [p[0] - size.x / 2, -(p[1] - size.y / 2)];
  const deg = new Map(); const widest = new Map();
  for (const [a, b, w] of roads.edges) for (const k of [a, b]) { deg.set(k, (deg.get(k) || 0) + 1); widest.set(k, Math.max(widest.get(k) || 0, w)); }
  const y = (x, z, w) => (heightAt ? heightAt(x, z) : 0) + 0.06 + Math.min(0.06, w * 0.004);
  const quad = (x0, z0, x1, z1, w, c) => {
    const dx = x1 - x0; const dz = z1 - z0; const L = Math.hypot(dx, dz) || 1;
    const nx = (-dz / L) * (w / 2); const nz = (dx / L) * (w / 2);
    // Long stretches in pieces, so the ribbon follows the ground.
    const n = Math.max(1, Math.ceil(L / 40));
    for (let i = 0; i < n; i++) {
      const t0 = i / n; const t1 = (i + 1) / n;
      const ax = x0 + dx * t0; const az = z0 + dz * t0; const bx = x0 + dx * t1; const bz = z0 + dz * t1;
      const o = pos.length / 3;
      pos.push(ax + nx, y(ax, az, w), az + nz, ax - nx, y(ax, az, w), az - nz, bx + nx, y(bx, bz, w), bz + nz, bx - nx, y(bx, bz, w), bz - nz);
      for (let k = 0; k < 4; k++) col.push(c.r, c.g, c.b);
      idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
    }
  };
  for (const [a, b, w] of roads.edges) {
    const A = roads.nodes[a]; const B = roads.nodes[b]; if (!A || !B) continue;
    const [x0, z0] = S(A); const [x1, z1] = S(B);
    quad(x0, z0, x1, z1, w, w < FOOTPATH_WIDTH ? path : w < 6 ? drive : asphalt);
  }
  // Junctions and bends: a disc the width of the widest road there.
  roads.nodes.forEach((p, k) => {
    if (!deg.has(k)) return;
    const w = widest.get(k); const [cx, cz] = S(p); const c = w < FOOTPATH_WIDTH ? path : w < 6 ? drive : asphalt;
    const n = 12; const o = pos.length / 3; const yy = y(cx, cz, w) - 0.005;
    pos.push(cx, yy, cz); col.push(c.r, c.g, c.b);
    for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; pos.push(cx + Math.cos(t) * w / 2, yy, cz + Math.sin(t) * w / 2); col.push(c.r, c.g, c.b); }
    for (let i = 0; i < n; i++) idx.push(o, o + 1 + ((i + 1) % n), o + 1 + i);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, material);
  mesh.receiveShadow = true;
  mesh.userData.roads = true;
  return mesh;
}
