// A reel shot for Blender Cycles, frame by frame (showcase-render --cycles DIR).
//
// While showcase-render steps the shot exactly as it does for the MP4 (same
// data window, events, run-up, camera), this records each frame's camera and
// the world matrices of everything that moves; at the end it writes:
//
//   <shot>/city.glb      what stays still (baked in world space) plus, for
//                        every moving mesh, its geometry once ('dyn~<id>~name')
//   <shot>/dyn.bin       Float32 world matrices, frame by frame, of every
//                        moving instance (layout in city-shot.json: dynamic)
//   <shot>/city-shot.json  the shot, frames (camera per frame), buildings
//                        (skyline records), fog, lights, the dynamic layout
//
// Skyline buildings go out as records (scripts/blender/pg1_buildings.py
// builds them in detail). Fake glows of the live view and labels stay out.

import { mkdirSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

// Page side: installed once, then called per frame.
const PAGE = () => {
  if (window.__cyc) return;
  const scene = window.__kingdomScene; const cam = window.__kingdomCamera;
  if (!scene || !cam) throw new Error('no scene (the page needs ?debug=1)');
  const SKIP = /^(sky|clouds|rain|rain-.*|stars|moon|pg1-debug.*)$/;
  const meshes = []; scene.traverse((o) => { if (o.isMesh && !SKIP.test(o.name || '')) meshes.push(o); });
  const visible = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  const slots = (o) => (o.isInstancedMesh ? o.instanceMatrix.array.length / 16 : 1);
  const m4 = new (cam.matrixWorld.constructor)();
  const read = (o, out, at) => {
    o.updateWorldMatrix(true, false);
    const vis = visible(o) ? 1 : 0;
    if (!o.isInstancedMesh) { const e = o.matrixWorld.elements; for (let k = 0; k < 16; k++) out[at + k] = vis ? e[k] : 0; return; }
    const n = slots(o);
    for (let i = 0; i < n; i++) {
      if (!vis || i >= o.count) { out.fill(0, at + i * 16, at + i * 16 + 16); continue; }
      o.getMatrixAt(i, m4); m4.premultiply(o.matrixWorld); const e = m4.elements;
      for (let k = 0; k < 16; k++) out[at + i * 16 + k] = e[k];
    }
  };
  const b64 = (f32) => { const b = new Uint8Array(f32.buffer); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  window.__cyc = {
    meshes,
    names: meshes.map((o) => o.name || o.type),
    // ids: which meshes to read (null = all); returns base64 Float32 of their slots, in order.
    frame(ids) {
      const list = ids || meshes.map((_, i) => i);
      const total = list.reduce((s, i) => s + slots(meshes[i]) * 16, 0);
      const out = new Float32Array(total); let at = 0;
      for (const i of list) { read(meshes[i], out, at); at += slots(meshes[i]) * 16; }
      cam.updateMatrixWorld(true);
      return { data: b64(out), camera: { matrix: Array.from(cam.matrixWorld.elements), fov: cam.fov, near: cam.near, far: cam.far } };
    },
    slots: () => meshes.map(slots)
  };
};

// Page side: bake and export the GLB. dyn: mesh indices that move.
const EXPORT = async (dyn) => {
  const THREE = await import('/vendor/three/three.module.min.js');
  const { GLTFExporter } = await import('/vendor/three/addons/exporters/GLTFExporter.js');
  const { mergeGeometries } = await import('/vendor/three/addons/utils/BufferGeometryUtils.js');
  const { meshes } = window.__cyc; const scene = window.__kingdomScene;
  scene.updateMatrixWorld(true);
  const dynSet = new Set(dyn); const left = {}; const buildings = [];
  const skip = (why) => { left[why] = (left[why] || 0) + 1; };
  const visible = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  const prep = (g, color) => {
    const x = g.clone();
    if (!x.index) { const n0 = x.attributes.position.count; const ix = new (n0 > 65535 ? Uint32Array : Uint16Array)(n0); for (let i = 0; i < n0; i++) ix[i] = i; x.setIndex(new THREE.BufferAttribute(ix, 1)); }
    for (const k of Object.keys(x.attributes)) if (!['position', 'normal', 'uv'].includes(k)) x.deleteAttribute(k);
    if (!x.attributes.normal) x.computeVertexNormals();
    if (!x.attributes.uv) x.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(x.attributes.position.count * 2), 2));
    const n = x.attributes.position.count; const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = color[0]; c[i * 3 + 1] = color[1]; c[i * 3 + 2] = color[2]; }
    x.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return x;
  };
  const exportMat = (m) => {
    const src = Array.isArray(m) ? m[0] : m;
    const out = new THREE.MeshStandardMaterial({ name: src.name || src.type });
    out.color.setRGB(1, 1, 1);
    if (src.emissive && (src.emissiveIntensity ?? 1) > 0 && (src.emissive.r + src.emissive.g + src.emissive.b) > 0.01) { out.emissive.copy(src.emissive); out.emissiveIntensity = src.emissiveIntensity ?? 1; }
    out.roughness = src.roughness ?? (src.type === 'MeshBasicMaterial' ? 1 : 0.6);
    out.metalness = src.metalness ?? 0;
    if (src.type === 'MeshBasicMaterial' && src.color) { out.emissive.copy(src.color); out.emissiveIntensity = 1; }
    if (src.map) { out.map = src.map; if (src.type === 'MeshBasicMaterial') out.emissiveMap = src.map; }
    if (src.emissiveMap && out.emissiveIntensity > 0 && (out.emissive.r + out.emissive.g + out.emissive.b) > 0.01) out.emissiveMap = src.emissiveMap;
    out.transparent = !!src.transparent; out.opacity = src.opacity ?? 1;
    return out;
  };
  const root = new THREE.Scene(); root.name = 'pg1-city';
  const dynamic = []; const m4 = new THREE.Matrix4(); const col = new THREE.Color();
  meshes.forEach((o, idx) => {
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const name = o.name || o.type;
    if (!mat || mat.visible === false || (mat.opacity === 0 && mat.transparent)) { skip('invisible material'); return; }
    const facade = typeof mat.customProgramCacheKey === 'function' && /pg1-facade/.test(String(mat.customProgramCacheKey()));
    if (mat.isShaderMaterial && !facade) { skip(`shader: ${name}`); return; }
    const base = facade ? null : (mat.color ? [mat.color.r, mat.color.g, mat.color.b] : [1, 1, 1]);
    if (dynSet.has(idx)) {
      // Geometry once, in its own space; the colour per instance (instanceColor) goes out as a list.
      const g = prep(o.geometry, base || [0.5, 0, 0]);
      const mesh = new THREE.Mesh(g, exportMat(o.material)); mesh.name = `dyn~${idx}~${name}`;
      root.add(mesh);
      const colours = [];
      if (o.isInstancedMesh && o.instanceColor) for (let i = 0; i < o.instanceMatrix.array.length / 16; i++) { o.getColorAt(i, col); colours.push([+(col.r * base[0]).toFixed(4), +(col.g * base[1]).toFixed(4), +(col.b * base[2]).toFixed(4)]); }
      dynamic.push({ mesh: idx, name, slots: o.isInstancedMesh ? o.instanceMatrix.array.length / 16 : 1, colours: colours.length ? colours : null, facade });
      return;
    }
    if (!visible(o)) { skip('hidden'); return; }
    const kindOf = /^skyline-(box|round|taper|twist)$/.exec(name);
    if (facade && o.isInstancedMesh && kindOf) {
      const seed = o.geometry.attributes.aSeed; const style = o.geometry.attributes.aStyle;
      const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const sc = new THREE.Vector3(); const e = new THREE.Euler();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m4); m4.premultiply(o.matrixWorld);
        if (!m4.elements.every(Number.isFinite) || Math.abs(m4.determinant()) < 1e-9) continue;
        m4.decompose(p, q, sc); e.setFromQuaternion(q, 'YXZ');
        buildings.push({ kind: kindOf[1], x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), w: +sc.x.toFixed(2), h: +sc.y.toFixed(2), d: +sc.z.toFixed(2), ry: +e.y.toFixed(4), seed: seed ? +seed.getX(i).toFixed(3) : 0, style: style ? style.getX(i) : 0 });
      }
      return;
    }
    const parts = [];
    if (o.isInstancedMesh) {
      const seed = o.geometry.attributes.aSeed; const style = o.geometry.attributes.aStyle;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m4); m4.premultiply(o.matrixWorld);
        if (!m4.elements.every(Number.isFinite) || Math.abs(m4.determinant()) < 1e-9) { skip('hidden instance'); continue; }
        let c = base || [0.5, 0, 0];
        if (facade && seed && style) c = [seed.getX(i) / 997, style.getX(i) / 8, 0];
        else if (!facade && o.instanceColor) { o.getColorAt(i, col); c = [col.r * base[0], col.g * base[1], col.b * base[2]]; }
        const g = prep(o.geometry, c); g.applyMatrix4(m4); parts.push(g);
      }
    } else { const g = prep(o.geometry, base || [0.5, 0, 0]); g.applyMatrix4(o.matrixWorld); parts.push(g); }
    for (let k = 0; k < parts.length; k += 400) {
      const merged = mergeGeometries(parts.slice(k, k + 400), false);
      if (!merged) { skip(`merge failed: ${name}`); continue; }
      const mesh = new THREE.Mesh(merged, exportMat(o.material));
      mesh.name = `${facade ? 'facade~' : ''}${name}${k ? `-${k / 400}` : ''}`;
      root.add(mesh);
    }
  });
  const lights = []; scene.traverse((o) => { if (o.isDirectionalLight && o.intensity > 0) lights.push({ name: o.name, dir: o.position.clone().sub(o.target ? o.target.position : new THREE.Vector3()).normalize().toArray(), color: o.color.toArray(), intensity: o.intensity }); });
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false });
  window.__cycGlb = new Uint8Array(glb);
  return { bytes: glb.byteLength, buildings, dynamic, left_out: left, lights, fog: scene.fog ? { color: scene.fog.color.toArray(), density: scene.fog.density } : null };
};

// Things that move: always recorded (some only start moving mid-shot), plus
// anything whose matrices change between the first two frames.
const MOVERS = /car|van|bus|taxi|pedestrian|umbrella|cyclist|dog|^tram$|boat|ferr|drone|aircraft|helicopter|seagull|pigeon|crowd|rotor|scanner|crane-jib|probe|patrol|courier|warden|seal-forge|preflight|flag/;

export function cyclesDump(outDir, log) {
  mkdirSync(outDir, { recursive: true });
  let names = null; let slotsAll = null; let dyn = null; let first = null; let fd = null; let frames = []; let floatsPerFrame = 0;
  const decode = (b64) => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
  return {
    async frame(page, i) {
      if (!names) { await page.evaluate(PAGE); names = await page.evaluate(() => window.__cyc.names); slotsAll = await page.evaluate(() => window.__cyc.slots()); }
      if (!dyn) {
        const r = await page.evaluate(() => window.__cyc.frame(null));
        if (!first) { first = { data: Float32Array.from(decode(r.data)), camera: r.camera }; frames.push(r.camera); return; }
        // Second frame: decide what moves, then write both frames for those.
        const now = decode(r.data); dyn = []; let at = 0;
        names.forEach((n, k) => { const len = slotsAll[k] * 16; let moved = MOVERS.test(n); if (!moved) for (let j = at; j < at + len; j++) if (Math.abs(now[j] - first.data[j]) > 1e-4) { moved = true; break; } if (moved) dyn.push(k); at += len; });
        const offs = []; at = 0; names.forEach((_, k) => { offs.push(at); at += slotsAll[k] * 16; });
        floatsPerFrame = dyn.reduce((s, k) => s + slotsAll[k] * 16, 0);
        fd = openSync(join(outDir, 'dyn.bin'), 'w');
        for (const src of [first.data, now]) { const out = new Float32Array(floatsPerFrame); let o = 0; for (const k of dyn) { out.set(src.subarray(offs[k], offs[k] + slotsAll[k] * 16), o); o += slotsAll[k] * 16; } writeSync(fd, Buffer.from(out.buffer)); }
        frames.push(r.camera); first = null;
        log(`cycles: ${dyn.length} moving meshes (${floatsPerFrame / 16} instances) of ${names.length}`);
        return;
      }
      const r = await page.evaluate((ids) => window.__cyc.frame(ids), dyn);
      const f = decode(r.data); if (f.length !== floatsPerFrame) throw new Error(`cycles: frame ${i} has ${f.length} floats, expected ${floatsPerFrame}`);
      writeSync(fd, Buffer.from(f.buffer, f.byteOffset, f.byteLength)); frames.push(r.camera);
    },
    async finish(page, info) {
      if (fd) closeSync(fd);
      const meta = await page.evaluate(EXPORT, dyn || []);
      const CHUNK = 8 * 1024 * 1024; const parts = [];
      for (let at = 0; at < meta.bytes; at += CHUNK) parts.push(Buffer.from(await page.evaluate(([a, n]) => { const b = window.__cycGlb.subarray(a, a + n); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }, [at, CHUNK]), 'base64'));
      const glb = Buffer.concat(parts); if (glb.length !== meta.bytes) throw new Error(`cycles: read ${glb.length} of ${meta.bytes} bytes`);
      writeFileSync(join(outDir, 'city.glb'), glb);
      // Offsets follow dyn.bin's order (every moving mesh, exported or not).
      const offset = new Map(); let o = 0; for (const k of dyn || []) { offset.set(k, o); o += slotsAll[k] * 16; }
      const layout = meta.dynamic.map((d) => ({ ...d, offset: offset.get(d.mesh) }));
      const out = { ...info, frames, floats_per_frame: floatsPerFrame, dynamic: layout, buildings: meta.buildings, left_out: meta.left_out, lights: meta.lights, fog: meta.fog };
      writeFileSync(join(outDir, 'city-shot.json'), JSON.stringify(out) + '\n');
      log(`cycles: ${frames.length} frames, ${meta.buildings.length} buildings, ${(glb.length / 1e6).toFixed(0)} MB GLB, ${meta.dynamic.length} moving meshes`);
    }
  };
}
