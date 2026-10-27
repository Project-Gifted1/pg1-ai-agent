// PG1 Sandbox viewer: close-up foliage (Medium and up; quality.js).
//
// Dense grass and wild flowers around wherever the camera looks, so that a
// walk at eye height (the Explore view) is through a meadow, not over a
// painted floor. Tufts of blades, each tuft one instance, scattered cell by
// cell (16 m) in a circle round the camera's target; a cell's tufts come from
// its own seed, so the same place always grows the same grass. The circle
// moves with the camera; its edge thins out so it never shows. Blades sway
// in the wind in the vertex shader. Nothing is downloaded.
//
//   createFoliage(THREE, { density, radius, setupMaterial, coarse })
//     -> { group, place({ cx, cz, heightAt, blocked }), update(t, camDist, day), dispose(), count }
//
// `blocked(x, z)` is true where nothing grows (water, roads, pavements).

const CELL = 16;

function bladeTuft(THREE, rnd, blades = 6) {
  const pos = []; const col = []; const idx = [];
  const base = new THREE.Color('#2f4a1c'); const tip = new THREE.Color('#9dbb52'); const c = new THREE.Color();
  for (let b = 0; b < blades; b++) {
    const a = rnd() * Math.PI * 2; const r = rnd() * 0.25;
    const ox = Math.cos(a) * r; const oz = Math.sin(a) * r;
    const h = 0.22 + rnd() * 0.33; const w = 0.03 + rnd() * 0.025;
    const lean = (rnd() - 0.5) * 0.5; const dir = rnd() * Math.PI * 2;
    const dx = Math.cos(dir); const dz = Math.sin(dir);
    const start = pos.length / 3;
    const segs = 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs; const y = t * h; const bend = lean * t * t * h;
      const ww = w * (1 - t * 0.92);
      // across the blade: perpendicular to its lean direction
      pos.push(ox + dx * bend - dz * ww, y, oz + dz * bend + dx * ww, ox + dx * bend + dz * ww, y, oz + dz * bend - dx * ww);
      c.copy(base).lerp(tip, Math.pow(t, 0.8)).offsetHSL((rnd() - 0.5) * 0.02, 0, (rnd() - 0.5) * 0.04);
      col.push(c.r, c.g, c.b, c.r * 0.92, c.g * 0.92, c.b * 0.92);
    }
    for (let i = 0; i < segs; i++) { const a0 = start + i * 2; idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Grass is lit from above more than from its sides: normals lean up.
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) { const v = new THREE.Vector3(n.getX(i), n.getY(i) + 1.6, n.getZ(i)).normalize(); n.setXYZ(i, v.x, v.y, v.z); }
  return g;
}

function flowerHead(THREE) {
  const stem = new THREE.CylinderGeometry(0.01, 0.012, 0.45, 4); stem.translate(0, 0.225, 0);
  const head = new THREE.IcosahedronGeometry(0.05, 0); head.translate(0, 0.47, 0);
  const g = new THREE.BufferGeometry();
  const parts = [stem.toNonIndexed(), head.toNonIndexed()];
  const cols = [[0.18, 0.32, 0.1], [1, 1, 1]];
  const pos = []; const nor = []; const col = [];
  parts.forEach((p, k) => { pos.push(...p.attributes.position.array); nor.push(...p.attributes.normal.array); for (let i = 0; i < p.attributes.position.count; i++) col.push(...cols[k]); p.dispose(); });
  stem.dispose(); head.dispose();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// Wind: the higher up a blade, the further it sways; gusts roll across.
function addWind(material, uniforms) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    shader.uniforms.uWind = uniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec2 wp = instanceMatrix[3].xz;
#else
  vec2 wp = vec2(0.0);
#endif
  float gust = 0.55 + 0.45 * sin(uWind * 0.7 + wp.x * 0.05 + wp.y * 0.03);
  float sway = sin(uWind * 2.1 + wp.x * 0.35 + wp.y * 0.27) * 0.12 * gust;
  transformed.x += sway * transformed.y * transformed.y;
  transformed.z += sway * 0.4 * transformed.y * transformed.y;`);
  };
  const key = material.customProgramCacheKey ? material.customProgramCacheKey.bind(material) : () => '';
  material.customProgramCacheKey = () => `${key()}|wind`;
}

export function createFoliage(THREE, { density = 20000, radius = 90, setupMaterial = (m) => m, coarse = false } = {}) {
  const group = new THREE.Group();
  group.name = 'foliage';
  let s = 1234567;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const uniforms = { uWind: { value: 0 } };
  const grassMat = setupMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }));
  addWind(grassMat, uniforms);
  const tufts = [bladeTuft(THREE, rnd, 7), bladeTuft(THREE, rnd, 5), bladeTuft(THREE, rnd, 9)];
  const perKind = Math.max(1, Math.round(density / tufts.length));
  const grass = tufts.map((g) => { const m = new THREE.InstancedMesh(g, grassMat, perKind); m.count = 0; m.frustumCulled = false; m.receiveShadow = !coarse; group.add(m); return m; });
  const flowerMat = setupMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 }));
  addWind(flowerMat, uniforms);
  const nFlowers = Math.max(1, Math.round(density * 0.04));
  const flowers = new THREE.InstancedMesh(flowerHead(THREE), flowerMat, nFlowers);
  flowers.count = 0; flowers.frustumCulled = false;
  group.add(flowers);
  const PETALS = ['#f4f1e8', '#f2d64b', '#c84b8f', '#7f6ad6', '#e8743b'].map((h) => new THREE.Color(h));

  const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const p = new THREE.Vector3(); const sc = new THREE.Vector3(); const up = new THREE.Vector3(0, 1, 0);
  let at = null;
  const api = {
    group,
    get count() { return grass.reduce((n, g) => n + g.count, 0); },
    // Scatter round (cx, cz) in scene metres, if the camera has moved to another cell.
    place({ cx, cz, heightAt = () => 0, blocked = () => false, force = false }) {
      const key = `${Math.floor(cx / CELL)}|${Math.floor(cz / CELL)}`;
      if (!force && key === at) return;
      at = key;
      const counts = grass.map(() => 0); let nf = 0;
      const cells = Math.ceil(radius / CELL);
      const perCell = Math.max(1, Math.round(density / (Math.PI * cells * cells)));
      const ccx = Math.floor(cx / CELL); const ccz = Math.floor(cz / CELL);
      for (let i = -cells; i <= cells; i++) for (let j = -cells; j <= cells; j++) {
        const gx = ccx + i; const gz = ccz + j;
        // The cell's own seed: the same grass grows in the same place.
        let cs = (Math.imul(gx, 73856093) ^ Math.imul(gz, 19349663)) >>> 0 || 1;
        const r = () => { cs = (Math.imul(cs, 1664525) + 1013904223) >>> 0; return cs / 4294967296; };
        // Patchy meadows: some cells lush, some thin.
        const lush = 0.35 + 0.65 * r();
        for (let k = 0; k < perCell; k++) {
          const x = (gx + r()) * CELL; const z = (gz + r()) * CELL;
          const kind = Math.floor(r() * grass.length); const yaw = r() * Math.PI * 2; const sz = 0.75 + r() * 0.5; const flower = r() < 0.05;
          if (r() > lush) continue;
          const d = Math.hypot(x - cx, z - cz);
          if (d > radius) continue;
          if (blocked(x, z)) continue;
          const y = heightAt(x, z);
          const edge = 1 - Math.pow(d / radius, 4);          // thins out at the rim
          q.setFromAxisAngle(up, yaw);
          if (flower && nf < nFlowers) {
            m4.compose(p.set(x, y, z), q, sc.set(1, sz * edge, 1));
            flowers.setMatrixAt(nf, m4); flowers.setColorAt(nf, PETALS[Math.floor(r() * PETALS.length)]); nf++;
            continue;
          }
          if (counts[kind] >= perKind) continue;
          m4.compose(p.set(x, y - 0.02, z), q, sc.set(sz, sz * edge * (0.8 + lush * 0.6), sz));
          grass[kind].setMatrixAt(counts[kind]++, m4);
        }
      }
      grass.forEach((g, k) => { g.count = counts[k]; g.instanceMatrix.needsUpdate = true; });
      flowers.count = nf; flowers.instanceMatrix.needsUpdate = true;
      if (flowers.instanceColor) flowers.instanceColor.needsUpdate = true;
    },
    // Grass shows only close up (from above, the ground's own texture reads as grass).
    update(t, camDist) {
      uniforms.uWind.value = t;
      group.visible = camDist < radius * 3;
    },
    dispose() { group.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); grassMat.dispose(); flowerMat.dispose(); for (const g of grass) g.dispose(); flowers.dispose(); }
  };
  return api;
}
