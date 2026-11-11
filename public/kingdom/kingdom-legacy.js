// PG1 City on the Legacy phone tier (an iPhone 8: A11 GPU, ~2 GB RAM, iOS 16
// Safari): the cheap tricks that keep it under its budgets (kingdom-scene.js
// LEGACY_BUDGET: under 150 draw calls, under 150k triangles, textures at most
// 1024 px, well under 300 MB of GPU memory, a steady 30 fps).
//
//   mergeStatic(THREE, scene)       every static mesh with a shared material
//                                   becomes one mesh per material (roads,
//                                   bridges, embankments, pylons...): one
//                                   draw call each instead of dozens
//   simplifyInstances(THREE, scene) instanced small things drawn with many
//                                   triangles (people, lamps, signal heads,
//                                   balcony rails...) get a box the same size:
//                                   at phone distances nobody can tell
//
// Nothing here changes what happens in the city, only how it is drawn.

// Static scenery: these named meshes never move, hide or change shape.
export const STATIC_NAMES = Object.freeze(['road', 'bridge-hanger', 'park', 'embankment', 'embankment-railing', 'bridge-arch', 'bridge-rail', 'bridge-deck-lights', 'bridge-abutment', 'bridge-west-pier', 'bridge-west-lights', 'bridge-west-deck', 'bridge-deck', 'bridge-lane', 'ground', 'billboard-pole', 'billboard-frame', 'plaza-fountain', 'plaza-fountain-water', 'tower-edge', 'preflight-pylon', 'toll-gantry-leg', 'tram-viaduct', 'busker-case', 'tower-podium', 'bridge-lantern']);

function toNonIndexed(g) { return g.index ? g.toNonIndexed() : g.clone(); }

// Merges meshes (already in world space) into one geometry: position,
// normal and uv where every part has them.
export function mergeGeometries(THREE, geos) {
  const parts = geos.map(toNonIndexed);
  const names = ['position', 'normal', 'uv'].filter((n) => parts.every((g) => g.attributes[n]));
  const out = new THREE.BufferGeometry();
  for (const n of names) {
    const size = parts[0].attributes[n].itemSize;
    const total = parts.reduce((s, g) => s + g.attributes[n].count, 0);
    const arr = new Float32Array(total * size);
    let o = 0; for (const g of parts) { arr.set(g.attributes[n].array, o); o += g.attributes[n].array.length; }
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  for (const g of parts) g.dispose();
  out.computeBoundingSphere();
  return out;
}

// Static instanced scenery that is expanded into plain geometry and merged too.
export const STATIC_INSTANCED = Object.freeze(['street-lamp-posts', 'street-light-poles', 'street-lamps', 'street-lights', 'street-light-pools', 'tram-pillars', 'embankment-railing', 'lane-markings', 'kerbs', 'pavements', 'zebra-crossings', 'stop-lines', 'manhole-covers', 'rooftop-plant', 'rooftop-antennas', 'helipads', 'bus-shelters', 'tram-platforms', 'cafe-tables', 'cafe-parasols', 'flag-poles', 'traffic-light-poles', 'tree-trunks', 'plaza-benches', 'moored-boats-none']);

// Two materials that draw the same (type, colours, finish, maps, blending).
function materialKey(m) {
  const c = (x) => (x && x.getHexString ? x.getHexString() : '');
  return [m.type, c(m.color), c(m.emissive), m.emissiveIntensity, m.roughness, m.metalness, m.transparent, m.opacity, m.side, m.blending, m.depthWrite, m.fog, m.map ? m.map.uuid : '', m.emissiveMap ? m.emissiveMap.uuid : '', m.envMap ? m.envMap.uuid : '', m.onBeforeCompile && m.onBeforeCompile.toString().length > 30 ? m.uuid : ''].join('|');
}

export function mergeStatic(THREE, scene, names = STATIC_NAMES, instanced = STATIC_INSTANCED, { shadows = false } = {}) {
  scene.updateMatrixWorld(true);
  const groups = new Map();
  const m4 = new THREE.Matrix4();
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || Array.isArray(o.material)) return;
    const inst = o.isInstancedMesh;
    if (inst ? (!instanced.includes(o.name) || o.instanceColor) : !names.includes(o.name)) return;
    let visible = true; for (let p = o; p; p = p.parent) if (!p.visible) { visible = false; break; }
    if (!visible) return;
    const key = materialKey(o.material);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  });
  let removed = 0; let added = 0;
  for (const list of groups.values()) {
    const pieces = list.reduce((n, m) => n + (m.isInstancedMesh ? 2 : 1), 0);
    if (pieces < 2) continue;
    const geos = [];
    for (const m of list) {
      const base = m.geometry.clone();
      for (const k of Object.keys(base.attributes)) if (base.attributes[k].isInstancedBufferAttribute) base.deleteAttribute(k);
      if (m.isInstancedMesh) for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, m4); const g = base.clone(); g.applyMatrix4(m4.premultiply(m.matrixWorld)); geos.push(g); }
      else { const g = base.clone(); g.applyMatrix4(m.matrixWorld); geos.push(g); }
      base.dispose();
    }
    if (!geos.length) continue;
    const merged = new THREE.Mesh(mergeGeometries(THREE, geos), list[0].material);
    for (const g of geos) g.dispose();
    merged.name = `${list[0].name}-merged`;
    merged.matrixAutoUpdate = false;
    merged.castShadow = shadows && list.some((m) => m.castShadow); merged.receiveShadow = shadows && list.some((m) => m.receiveShadow);
    for (const m of list) { m.parent.remove(m); removed++; }
    scene.add(merged); added++;
  }
  return { removed, added };
}

// Instanced meshes worth simplifying: at least `minTris` triangles each and
// `minTotal` in all. Skyline and terrain are left alone (their shaders need
// the real faces), and so are the PG1 tower and emblem.
export function simplifyInstances(THREE, scene, { minTris = 24, minTotal = 2500, exclude = /^(?:skyline|pg1-|tower|emblem|tree-crowns)/ } = {}) {
  const box = new THREE.Box3(); const size = new THREE.Vector3(); const centre = new THREE.Vector3();
  let saved = 0;
  scene.traverse((o) => {
    if (!o.isInstancedMesh || exclude.test(o.name || '')) return;
    const g = o.geometry; const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    if (n < minTris || n * o.count < minTotal) return;
    g.computeBoundingBox(); box.copy(g.boundingBox); box.getSize(size); box.getCenter(centre);
    const flat = Math.min(size.x, size.y, size.z) < 1e-3;
    const nb = flat ? new THREE.PlaneGeometry(Math.max(size.x, 1e-3), Math.max(size.z, size.y, 1e-3)) : new THREE.BoxGeometry(size.x, size.y, size.z);
    if (flat) nb.rotateX(-Math.PI / 2);
    nb.translate(centre.x, centre.y, centre.z);
    for (const [k, v] of Object.entries(g.attributes)) if (v.isInstancedBufferAttribute) nb.setAttribute(k, v);
    const before = n * o.count; o.geometry = nb; g.dispose();
    saved += before - (nb.index ? nb.index.count / 3 : nb.attributes.position.count / 3) * o.count;
  });
  return { saved: Math.round(saved) };
}

// The automatic drop to Legacy phone: frames that stay slow (over `ms`) for
// `frames` frames in a row (a fast frame forgives two slow ones). sample(ms)
// returns true once, when it is time to drop.
export function createLegacyWatch({ ms = 1000 / 30 * 1.6, frames = 90 } = {}) {
  let slow = 0; let fired = false;
  return {
    sample(frameMs) {
      if (fired || !(frameMs >= 0)) return false;
      slow = frameMs > ms ? slow + 1 : Math.max(0, slow - 2);
      if (slow >= frames) { fired = true; return true; }
      return false;
    },
    get slow() { return slow; },
    reset() { slow = 0; fired = false; }
  };
}
