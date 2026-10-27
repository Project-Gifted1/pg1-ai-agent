// PG1 Sandbox viewer: rivers, creeks and mangroves (the benin-warri
// template; the terrain is lib/sandbox/terrain.mjs). Rivers and creeks are
// strips of water from an entity's position to (to_x, to_y), width wide,
// drawn as ribbons just above the ground; mangroves as low, dense green
// growth over their disc. One group, rebuilt when the world's waterways change.
//
//   buildWaterways(THREE, world, setupMaterial) -> THREE.Group | null
// world: normalizeWorld's (x east, y north; the scene's x, -z).

export function waterwaysSignature(world) {
  return world.entities.filter((e) => ['river', 'creek', 'mangrove'].includes(e.base)).map((e) => `${e.id}:${e.x}:${e.y}:${e.props.to_x}:${e.props.to_y}:${e.props.width}:${e.props.radius}`).join(',');
}

export function buildWaterways(THREE, world, setupMaterial = (m) => m) {
  const strips = world.entities.filter((e) => e.base === 'river' || e.base === 'creek');
  const mangroves = world.entities.filter((e) => e.base === 'mangrove');
  if (!strips.length && !mangroves.length) return null;
  const S = (x, y) => [x - world.size.x / 2, -(y - world.size.y / 2)];
  const group = new THREE.Group();
  if (strips.length) {
    const pos = []; const idx = [];
    for (const e of strips) {
      const w = Number(e.props.width) || (e.base === 'river' ? 30 : 14);
      const [x0, z0] = S(e.x, e.y); const [x1, z1] = S(Number(e.props.to_x) || e.x, Number(e.props.to_y) || e.y);
      const dx = x1 - x0; const dz = z1 - z0; const L = Math.hypot(dx, dz) || 1;
      const nx = (-dz / L) * (w / 2); const nz = (dx / L) * (w / 2);
      // Rounded ends, so joined strips meet cleanly.
      const ex = (dx / L) * (w / 2); const ez = (dz / L) * (w / 2);
      const o = pos.length / 3;
      pos.push(x0 + nx - ex, 0.18, z0 + nz - ez, x0 - nx - ex, 0.18, z0 - nz - ez, x1 + nx + ex, 0.18, z1 + nz + ez, x1 - nx + ex, 0.18, z1 - nz + ez);
      idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const water = new THREE.Mesh(g, setupMaterial(new THREE.MeshStandardMaterial({ color: 0x2a6f8a, roughness: 0.15, metalness: 0.3, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })));
    water.receiveShadow = true;
    group.add(water);
  }
  if (mangroves.length) {
    // Low, dense growth: instanced clumps over each disc, the same every time.
    const clump = new THREE.IcosahedronGeometry(1, 0);
    let total = 0; for (const m of mangroves) total += Math.min(900, Math.round(((Number(m.props.radius) || 200) ** 2) / 900));
    const inst = new THREE.InstancedMesh(clump, setupMaterial(new THREE.MeshStandardMaterial({ color: 0x2f4f2a, roughness: 0.95, flatShading: true })), Math.max(1, total));
    const mat = new THREE.Matrix4(); const q = new THREE.Quaternion(); const p = new THREE.Vector3(); const sc = new THREE.Vector3();
    let n = 0; let s = 2027;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (const m of mangroves) {
      const R = Number(m.props.radius) || 200; const count = Math.min(900, Math.round((R * R) / 900));
      const [cx, cz] = S(m.x, m.y);
      for (let i = 0; i < count; i++) {
        const a = rnd() * Math.PI * 2; const d = Math.sqrt(rnd()) * R * 0.97;
        const k = 2.5 + rnd() * 3;
        mat.compose(p.set(cx + Math.cos(a) * d, k * 0.45, cz + Math.sin(a) * d), q, sc.set(k * 1.6, k, k * 1.6));
        inst.setMatrixAt(n++, mat);
      }
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true; inst.receiveShadow = true;
    group.add(inst);
  }
  return group;
}
