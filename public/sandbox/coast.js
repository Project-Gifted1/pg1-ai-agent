// PG1 Sandbox viewer: coasts (island worlds, Medium and up; quality.js).
//
//   rocks   boulders where the land meets the sea: scattered on rocky
//           stretches of every coast (more on cold and maritime islands,
//           fewer on tropical ones), half sunk in the shallows, instanced
//   stones  smooth, pale river stones round every lake and on the sea bed
//           in the shallows, seen through the clear water near the shore
//   surf    where the water shader is off (Medium), a soft white band of
//           surf along each coast that swells and fades; the water shader
//           (High and up) draws its own foam
//
// The coast is the islands' circles (centre and radius in scene metres),
// the same shapes the terrain and the water shader use. Nothing is
// downloaded.
//
//   buildCoast(THREE, islands, { seed, heightAt, setupMaterial, coarse, surf, lakes })
//     lakes: [{ sx, sz, r }]
//     -> { group, update(t, day), dispose(), stats }

const ROCKY = { cold: 0.75, maritime: 0.6, temperate: 0.35, tropical: 0.18 };

export function buildCoast(THREE, islands, { seed = 1, heightAt = () => 0, setupMaterial = (m) => m, coarse = false, surf = false, lakes = [] } = {}) {
  const group = new THREE.Group();
  group.name = 'coast';
  let s = (Math.imul(seed | 0, 2654435761) >>> 0) || 7;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  // Is (x, z) inside another island (so this stretch of coast is not a coast)?
  const inland = (x, z, self) => islands.some((o) => o !== self && Math.hypot(x - o.sx, z - o.sz) < o.r - 4);
  const spots = [];
  for (const isl of islands) {
    const n = Math.max(12, Math.round((2 * Math.PI * isl.r) / (coarse ? 26 : 16)));
    const rocky = ROCKY[isl.climate] ?? 0.35;
    // Rocky stretches come and go around the coast.
    const ph1 = rnd() * 6.28; const ph2 = rnd() * 6.28;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.02;
      const stretch = 0.5 + 0.5 * Math.sin(a * 3 + ph1) * Math.cos(a * 5 + ph2);
      if (rnd() > rocky * (0.35 + stretch)) continue;
      const rr = isl.r + (rnd() - 0.6) * 14;
      const x = isl.sx + Math.cos(a) * rr; const z = isl.sz + Math.sin(a) * rr;
      if (inland(x, z, isl)) continue;
      const k = 0.8 + rnd() * rnd() * 3.2;
      spots.push([x, z, k, rnd() * 6.28, rnd()]);
      // Small ones around a big one.
      if (k > 2.2) for (let j = 0; j < 3; j++) spots.push([x + (rnd() - 0.5) * 6, z + (rnd() - 0.5) * 6, 0.4 + rnd() * 0.7, rnd() * 6.28, rnd()]);
    }
  }
  let rocks = null;
  if (spots.length) {
    const geo = new THREE.DodecahedronGeometry(1, 0);
    // Flatter on top, like weathered stone.
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setY(i, y > 0 ? y * 0.6 : y); p.setX(i, p.getX(i) * (1 + Math.sin(i * 1.7) * 0.12)); }
    geo.computeVertexNormals();
    rocks = new THREE.InstancedMesh(geo, setupMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, flatShading: true })), spots.length);
    const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const e = new THREE.Euler(); const v = new THREE.Vector3(); const sc = new THREE.Vector3(); const c = new THREE.Color();
    spots.forEach(([x, z, k, yaw, t], i) => {
      e.set((t - 0.5) * 0.4, yaw, (t - 0.5) * 0.3); q.setFromEuler(e);
      const y = Math.max(-1.2, heightAt(x, z));
      m4.compose(v.set(x, y + k * 0.15, z), q, sc.set(k * 1.4, k, k * 1.2));
      rocks.setMatrixAt(i, m4);
      rocks.setColorAt(i, c.setHSL(0.08 + t * 0.05, 0.08 + t * 0.06, 0.28 + t * 0.16));
    });
    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    rocks.castShadow = !coarse; rocks.receiveShadow = !coarse;
    rocks.computeBoundingSphere();
    group.add(rocks);
  }
  // Stones: round each lake's rim and in its shallows, and on the sea bed near the shore.
  const pebbles = [];
  const dens = coarse ? 0.5 : 1;
  for (const l of lakes) {
    const n = Math.round(((2 * Math.PI * l.r) / 1.6) * dens);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2; const inward = rnd() * rnd() * Math.min(14, l.r * 0.4);
      const rr = l.r + 1.2 - inward;
      pebbles.push([l.sx + Math.cos(a) * rr, l.sz + Math.sin(a) * rr, 0.25 + rnd() * rnd() * 0.9, rnd() * 6.28, rnd(), 0.02]);
    }
  }
  for (const isl of islands) {
    const n = Math.round(((2 * Math.PI * isl.r) / 5) * dens);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2; const rr = isl.r + 1 + rnd() * 22;
      const x = isl.sx + Math.cos(a) * rr; const z = isl.sz + Math.sin(a) * rr;
      if (inland(x, z, isl)) continue;
      pebbles.push([x, z, 0.3 + rnd() * rnd() * 1.2, rnd() * 6.28, rnd(), null]);
    }
  }
  let stones = null;
  if (pebbles.length) {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setY(i, y * (y > 0 ? 0.45 : 0.25)); }
    geo.computeVertexNormals();
    stones = new THREE.InstancedMesh(geo, setupMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0 })), pebbles.length);
    const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const e = new THREE.Euler(); const v = new THREE.Vector3(); const sc = new THREE.Vector3(); const c = new THREE.Color();
    pebbles.forEach(([x, z, k, yaw, t, y0], i) => {
      e.set(0, yaw, (t - 0.5) * 0.2); q.setFromEuler(e);
      const y = y0 === null ? heightAt(x, z) : y0;
      m4.compose(v.set(x, y, z), q, sc.set(k * (1 + t * 0.6), k, k));
      stones.setMatrixAt(i, m4);
      stones.setColorAt(i, c.setHSL(0.09 + t * 0.04, 0.1 + t * 0.08, 0.42 + t * 0.22));
    });
    stones.instanceMatrix.needsUpdate = true;
    if (stones.instanceColor) stones.instanceColor.needsUpdate = true;
    stones.receiveShadow = !coarse; stones.castShadow = false;
    stones.computeBoundingSphere();
    group.add(stones);
  }
  // Surf: a ring just off each coast, its brightness breathing like waves.
  const surfMeshes = [];
  if (surf) {
    for (const isl of islands) {
      const g = new THREE.RingGeometry(isl.r + 1, isl.r + 12, Math.min(256, Math.max(48, Math.round(isl.r / 8))), 1);
      g.rotateX(-Math.PI / 2);
      const uv = g.attributes.uv; const pp = g.attributes.position;
      for (let i = 0; i < uv.count; i++) { const d = Math.hypot(pp.getX(i), pp.getZ(i)); uv.setXY(i, (d - isl.r - 1) / 11, 0.5); }
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: surfTexture(THREE), color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
      m.position.set(isl.sx, 0.06, isl.sz);
      m.renderOrder = 1;
      m.userData.phase = rnd() * 6.28;
      group.add(m);
      surfMeshes.push(m);
    }
  }
  return {
    group,
    stats: { rocks: spots.length, stones: pebbles.length, surf: surfMeshes.length },
    update(t, day = 1) {
      for (const m of surfMeshes) {
        const w = 0.5 + 0.5 * Math.sin(t * 0.9 + m.userData.phase);
        m.material.opacity = (0.18 + 0.3 * w) * (0.25 + 0.75 * day);
        m.scale.setScalar(1 + w * 0.004);
      }
    },
    dispose() { group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); }
  };
}

// Broken white along the ring (u runs from the shore outward).
function surfTexture(THREE) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 8;
  const g = c.getContext('2d');
  const r = g.createLinearGradient(0, 0, 64, 0);
  r.addColorStop(0, 'rgba(255,255,255,0.95)'); r.addColorStop(0.25, 'rgba(255,255,255,0.55)'); r.addColorStop(0.55, 'rgba(255,255,255,0.18)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
