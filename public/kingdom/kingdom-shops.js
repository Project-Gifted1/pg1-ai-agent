// PG1 City: shop fronts modelled for close range (High, Cinematic and the
// Showcase only; a phone keeps the painted shop fronts of the facade
// shader). Each shop unit, 6 m wide: stone pilasters and a stall riser, a
// display window with a lit interior and goods on a plinth, a glazed door,
// a fascia with the shop's name (generic trades only: no real brands), a
// striped awning; benches and planters on the pavement in front. All
// instanced (about eight draw calls for every shop in the city), and hidden
// once the camera is further than SHOP_RANGE from every unit.
//
//   shopNames                       the trades on the fascias (pure, tests)
//   plazaArcade(plazaR)             the shop units round the plaza's edge
//   facadeUnits(podiums)            shop units along the retail podiums
//   createShops(THREE, root, units) the meshes; update(cam, shopsLit)

export const SHOP_W = 6;
export const SHOP_RANGE = 420;
export const shopNames = Object.freeze(['Bakery', 'Books', 'Flowers', 'Café', 'Grocer', 'Pharmacy', 'Shoes', 'Tailor', 'Hardware', 'Deli', 'Optician', 'Toys', 'Records', 'Bicycles', 'Newsagent', 'Gallery']);

// Units round the plaza (facing its centre), in two arcs either side of the
// avenue's line (x near 0 stays open).
export function plazaArcade(plazaR) {
  const R = plazaR + 7; const out = [];
  for (const [a0, a1] of [[0.62, 1.32], [1.82, 2.52]]) {
    const n = Math.floor(((a1 - a0) * R) / (SHOP_W + 0.4));
    for (let i = 0; i < n; i++) {
      const a = a0 + ((i + 0.5) / n) * (a1 - a0);
      // Local +z (the front) faces the centre: ry turns +z onto -(cos a, sin a).
      out.push({ x: Math.cos(a) * R, z: Math.sin(a) * R, ry: Math.atan2(-Math.cos(a), -Math.sin(a)), kiosk: true });
    }
  }
  return out;
}

// Units along both long faces of each retail podium { x, z, w, d, ry, shops }.
export function facadeUnits(podiums) {
  const out = [];
  for (const p of podiums) {
    const n = Math.max(1, Math.floor((p.w * 0.86) / SHOP_W));
    for (const side of [-1, 1]) for (let i = 0; i < n; i++) {
      const lx = (i - (n - 1) / 2) * SHOP_W; const lz = side * (p.d / 2 + 0.06);
      const ry = p.ry + (side > 0 ? 0 : Math.PI);
      out.push({ x: p.x + lx * Math.cos(p.ry) + lz * Math.sin(p.ry), z: p.z - lx * Math.sin(p.ry) + lz * Math.cos(p.ry), ry, kiosk: false });
    }
  }
  return out;
}

function signAtlas(THREE) {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 1024;
  const g = cv.getContext('2d'); const n = shopNames.length; const h = cv.height / n;
  const bgs = ['#1c3b2f', '#2b2f36', '#3a2a22', '#20324a', '#f1ece0', '#2f4a3a', '#4a2f3a', '#14161a'];
  shopNames.forEach((name, i) => {
    const bg = bgs[i % bgs.length]; const light = bg === '#f1ece0';
    g.fillStyle = bg; g.fillRect(0, i * h, cv.width, h);
    g.strokeStyle = light ? '#8a7a5a' : '#c8a85a'; g.lineWidth = 3; g.strokeRect(6, i * h + 6, cv.width - 12, h - 12);
    g.fillStyle = light ? '#2b2f36' : '#f6ecd2'; g.font = `600 ${Math.round(h * 0.52)}px Inter, Georgia, serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name.toUpperCase(), cv.width / 2, i * h + h * 0.54);
  });
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

// Several boxes merged with a colour per box (vertex colours).
function merged(THREE, boxes) {
  const geos = boxes.map(([w, h, d, x, y, z, rgb, rx = 0]) => { const g = new THREE.BoxGeometry(w, h, d).toNonIndexed(); if (rx) g.rotateX(rx); g.translate(x, y, z); const c = new Float32Array(g.attributes.position.count * 3); for (let i = 0; i < c.length; i += 3) c.set(rgb, i); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); g.deleteAttribute('uv'); return g; });
  const n = geos.reduce((k, g) => k + g.attributes.position.count, 0); const out = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['color', 3]]) { const arr = new Float32Array(n * size); let o = 0; for (const g of geos) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; g.dispose && 0; } out.setAttribute(name, new THREE.BufferAttribute(arr, size)); }
  for (const g of geos) g.dispose();
  out.computeBoundingSphere(); return out;
}

export function createShops(THREE, root, units) {
  const W = SHOP_W; const n = Math.max(1, units.length);
  const dummy = new THREE.Object3D();
  const place = (mesh, i, u, dy = 0) => { dummy.position.set(u.x, dy, u.z); dummy.rotation.set(0, u.ry, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); };
  const group = new THREE.Group(); group.name = 'shop-fronts'; root.add(group);
  const STONE = [0.62, 0.6, 0.57]; const DARK = [0.13, 0.14, 0.16]; const BRASS = [0.72, 0.58, 0.3];
  // Frame: pilasters, stall riser, transom, fascia backing, door frame, cornice.
  const frameGeo = merged(THREE, [
    [0.35, 4.6, 0.3, -W / 2 + 0.175, 2.3, 0.15, STONE], [0.35, 4.6, 0.3, W / 2 - 0.175, 2.3, 0.15, STONE],
    [W - 0.7, 0.55, 0.22, 0, 0.275, 0.11, STONE], [W - 0.7, 0.12, 0.2, 0, 3.45, 0.1, DARK],
    [W, 0.95, 0.34, 0, 4.1, 0.17, DARK], [W + 0.2, 0.16, 0.5, 0, 4.66, 0.25, STONE],
    [0.1, 3.0, 0.16, 1.1, 1.5, 0.08, DARK], [0.1, 3.0, 0.16, 2.6, 1.5, 0.08, DARK], [1.5, 0.1, 0.16, 1.85, 3.0, 0.08, DARK],
    [0.04, 0.5, 0.06, 2.35, 1.2, 0.2, BRASS],
    // Window mullions.
    [0.06, 2.85, 0.1, -1.15, 1.97, 0.06, DARK]
  ]);
  const frame = new THREE.InstancedMesh(frameGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.7, metalness: 0.1 }), n); frame.name = 'shop-frames';
  // The lit interior: back wall, floor, a counter, shelves, goods on a plinth, a mannequin.
  const goods = [];
  const GC = [[0.85, 0.42, 0.3], [0.3, 0.5, 0.75], [0.9, 0.78, 0.4], [0.35, 0.6, 0.4], [0.8, 0.8, 0.78], [0.6, 0.35, 0.55]];
  for (let k = 0; k < 9; k++) goods.push([0.28 + (k % 3) * 0.06, 0.25 + (k % 4) * 0.12, 0.28, -2.4 + k * 0.38, 0.9 + ((k % 4) * 0.12) / 2, -0.75 - (k % 2) * 0.25, GC[k % GC.length]]);
  for (let s = 0; s < 3; s++) for (let k = 0; k < 6; k++) goods.push([0.3, 0.22, 0.22, -2.3 + k * 0.62, 1.55 + s * 0.55, -1.75, GC[(k + s) % GC.length]]);
  const interiorGeo = merged(THREE, [
    [W - 0.7, 3.2, 0.1, 0, 1.7, -2.0, [0.52, 0.44, 0.36]], [W - 0.7, 0.05, 2.0, 0, 0.12, -1.0, [0.55, 0.45, 0.35]],
    [3.6, 0.5, 0.6, -1.0, 0.78, -0.75, [0.3, 0.25, 0.22]],
    [3.6, 0.05, 0.4, -1.0, 1.4, -1.8, [0.5, 0.42, 0.34]], [3.6, 0.05, 0.4, -1.0, 1.95, -1.8, [0.5, 0.42, 0.34]], [3.6, 0.05, 0.4, -1.0, 2.5, -1.8, [0.5, 0.42, 0.34]],
    [0.32, 1.1, 0.22, -2.45, 1.6, -0.55, [0.92, 0.9, 0.86]], [0.18, 0.2, 0.18, -2.45, 2.28, -0.55, [0.92, 0.9, 0.86]],
    [1.2, 0.9, 0.5, 1.85, 0.6, -1.3, [0.3, 0.25, 0.22]],
    ...goods
  ]);
  const interiorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8, emissive: 0xffd9a8, emissiveIntensity: 0.25 });
  const interior = new THREE.InstancedMesh(interiorGeo, interiorMat, n); interior.name = 'shop-interiors';
  // Glass: the display window and the door, faintly reflective.
  const glassGeo = merged(THREE, [[3.8, 2.85, 0.03, -1.05, 1.97, 0.04, [1, 1, 1]], [1.4, 2.85, 0.03, 1.85, 1.5, 0.04, [1, 1, 1]]]);
  // Clear shop glass: a faint tint and a little sheen, the lit display behind it shows.
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xbfd2dc, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.12, depthWrite: false, envMapIntensity: 0.3 });
  const glass = new THREE.InstancedMesh(glassGeo, glassMat, n); glass.name = 'shop-glass'; glass.renderOrder = 2;
  // Fascia sign: one of the trades from the atlas (aSign).
  const signGeo = new THREE.PlaneGeometry(W - 0.9, 0.72); signGeo.translate(0, 4.1, 0.35);
  const aSign = new Float32Array(n); for (let i = 0; i < n; i++) aSign[i] = (i * 7 + 3) % shopNames.length;
  signGeo.setAttribute('aSign', new THREE.InstancedBufferAttribute(aSign, 1));
  const signMat = new THREE.MeshStandardMaterial({ map: signAtlas(THREE), roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 0.0 });
  signMat.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSign;').replace('#include <uv_vertex>', `#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv.y = (vMapUv.y + ${shopNames.length - 1}.0 - aSign) / ${shopNames.length}.0;\n#endif`); sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= diffuseColor.rgb;'); };
  signMat.customProgramCacheKey = () => 'pg1-shop-sign';
  const signs = new THREE.InstancedMesh(signGeo, signMat, n); signs.name = 'shop-signs';
  // Awnings, striped (vertex colours), over the window.
  const awnBoxes = []; const stripeA = [[0.12, 0.3, 0.22], [0.42, 0.18, 0.16], [0.16, 0.24, 0.38], [0.2, 0.2, 0.22]];
  for (let k = 0; k < 10; k++) awnBoxes.push([0.4, 0.05, 1.5, -2.7 + k * 0.42 + 0.21, 3.3, 0.85, k % 2 ? [0.94, 0.92, 0.86] : stripeA[0], 0.38]);
  awnBoxes.push([4.3, 0.22, 0.05, -0.8, 2.98, 1.56, stripeA[0]]);
  const awningGeo = merged(THREE, awnBoxes);
  const awnings = new THREE.InstancedMesh(awningGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }), n); awnings.name = 'shop-awnings-striped';
  // Kiosks (the plaza's units): a body behind the front and a roof.
  const kiosks = units.filter((u) => u.kiosk);
  // Hollow at the front: the shop room (2.1 m deep) is open behind the glass,
  // walled at the sides and ceiled; the solid body starts behind its back wall.
  const bodyGeo = merged(THREE, [[W, 4.6, 2.3, 0, 2.3, -3.25, [0.7, 0.68, 0.64]], [0.3, 4.6, 2.1, -W / 2 + 0.15, 2.3, -1.05, [0.7, 0.68, 0.64]], [0.3, 4.6, 2.1, W / 2 - 0.15, 2.3, -1.05, [0.7, 0.68, 0.64]], [W, 0.3, 2.1, 0, 3.45, -1.05, [0.85, 0.83, 0.8]], [W + 0.6, 0.3, 5.2, 0, 4.85, -2.1, [0.3, 0.32, 0.35]]]);
  const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85 }), Math.max(1, kiosks.length)); bodies.name = 'shop-kiosks';
  // Benches and planters on the pavement in front of every other unit.
  const benchGeo = merged(THREE, [[1.8, 0.07, 0.45, 0, 0.45, 0, [0.45, 0.32, 0.2]], [1.8, 0.4, 0.06, 0, 0.7, -0.2, [0.45, 0.32, 0.2]], [0.06, 0.45, 0.45, -0.8, 0.22, 0, [0.12, 0.13, 0.14]], [0.06, 0.45, 0.45, 0.8, 0.22, 0, [0.12, 0.13, 0.14]]]);
  const plantGeo = (() => {
    const box = merged(THREE, [[0.9, 0.6, 0.9, 0, 0.3, 0, [0.35, 0.36, 0.38]], [0.8, 0.05, 0.8, 0, 0.6, 0, [0.22, 0.16, 0.1]]]);
    const leaf = new THREE.IcosahedronGeometry(0.55, 1).toNonIndexed(); leaf.scale(1, 0.9, 1); leaf.translate(0, 1.05, 0); leaf.deleteAttribute('uv');
    const c = new Float32Array(leaf.attributes.position.count * 3); for (let i = 0; i < c.length; i += 3) c.set([0.2, 0.38 + (i % 9) * 0.01, 0.2], i); leaf.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const out = new THREE.BufferGeometry(); for (const [name, size] of [['position', 3], ['normal', 3], ['color', 3]]) { const a = new Float32Array((box.attributes.position.count + leaf.attributes.position.count) * size); a.set(box.attributes[name].array, 0); a.set(leaf.attributes[name].array, box.attributes[name].array.length); out.setAttribute(name, new THREE.BufferAttribute(a, size)); }
    out.computeBoundingSphere(); return out;
  })();
  const furnMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8 });
  const benches = new THREE.InstancedMesh(benchGeo, furnMat, n); benches.name = 'shop-benches';
  const planters = new THREE.InstancedMesh(plantGeo, furnMat, n * 2); planters.name = 'shop-planters';
  const fwd = (u, d, side = 0) => ({ x: u.x + Math.sin(u.ry) * d + Math.cos(u.ry) * side, z: u.z + Math.cos(u.ry) * d - Math.sin(u.ry) * side, ry: u.ry });
  let bi = 0; let pi = 0; let ki = 0;
  units.forEach((u, i) => {
    for (const m of [frame, interior, glass, signs, awnings]) place(m, i, u);
    if (u.kiosk) place(bodies, ki++, u);
    if (i % 2 === 0) place(benches, bi++, fwd(u, 3.2, -0.8));
    place(planters, pi++, fwd(u, 3.0, i % 2 === 0 ? 1.9 : -2.4)); if (i % 3 === 0) place(planters, pi++, fwd(u, 3.0, 2.6));
  });
  benches.count = bi; planters.count = pi; bodies.count = ki;
  const meshes = [frame, interior, glass, signs, awnings, bodies, benches, planters];
  for (const m of meshes) { m.castShadow = m !== glass; m.receiveShadow = true; group.add(m); }
  const centres = units.map((u) => [u.x, u.z]);
  return {
    group, count: units.length, drawCalls: meshes.length,
    // Hidden beyond SHOP_RANGE (or high above the street); lit while the shops are open.
    update(cam, lit = 1, dark = 0) {
      let near = false;
      if (cam && cam.y < 260) for (const [x, z] of centres) if ((x - cam.x) ** 2 + (z - cam.z) ** 2 < SHOP_RANGE * SHOP_RANGE) { near = true; break; }
      group.visible = near;
      interiorMat.emissiveIntensity = (0.12 + 0.55 * dark) * (0.3 + 0.7 * lit);
      signMat.emissiveIntensity = (0.05 + 0.45 * dark) * lit;
    }
  };
}
