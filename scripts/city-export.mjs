#!/usr/bin/env node
// PG1 City for an offline path-traced render (scripts/blender/city_cycles.py).
//
// Opens the Showcase City page as scripts/showcase-render.mjs does (headless
// Chromium, the same real data window, read only), poses one reel shot, and
// writes what Blender needs:
//
//   city.glb        every visible mesh baked to plain geometry in world space
//                   (instances merged per kind), with the shot's camera.
//                   Skyline meshes carry their facade seed and style in the
//                   vertex colour (r = seed / 997, g = style / 8) so Blender
//                   can draw its own windows.
//   city-shot.json  the shot, the camera (three.js units), fog colour and
//                   density, sun direction and light, and what was left out.
//
//   node scripts/city-export.mjs --shot crown-tower [--epoch ISO] [--t 0.66] [--out cycles-in]
//
// No caller hashes, IPs or payments are in the export (the page never has them).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { startServer, loadData, CLOCK_SCRIPT, dublinEpoch, REEL_LOOK } from './showcase-render.mjs';
import { REEL_WINDOW_DAYS, planReelShot, reelShotById, STILL_LOOK } from '../lib/showcase/reel.mjs';
import { poseAt } from '../lib/showcase/shots.mjs';

export function parseExportArgs(argv) {
  const o = { shot: 'crown-tower', epoch: null, t: null, out: resolve('cycles-in'), width: 1080, height: 1920 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => argv[++i];
    if (a === '--shot') o.shot = v();
    else if (a === '--epoch') { const t = Date.parse(v()); if (!Number.isFinite(t)) throw new Error('--epoch ISO time'); o.epoch = t; }
    else if (a === '--t') { o.t = Number(v()); if (!(o.t >= 0 && o.t <= 1)) throw new Error('--t 0..1'); }
    else if (a === '--out') o.out = resolve(v());
    else if (a === '--size') { const m = /^(\d+)x(\d+)$/.exec(v()); if (!m) throw new Error('--size WxH'); o.width = Number(m[1]); o.height = Number(m[2]); }
    else throw new Error(`unknown option ${a}`);
  }
  if (!reelShotById(o.shot)) throw new Error(`unknown reel shot ${o.shot}`);
  return o;
}

// Runs in the page: bakes the scene and returns { glb (base64), meta }.
const EXPORT = async () => {
  const THREE = await import('/vendor/three/three.module.min.js');
  const { GLTFExporter } = await import('/vendor/three/addons/exporters/GLTFExporter.js');
  const { mergeGeometries } = await import('/vendor/three/addons/utils/BufferGeometryUtils.js');
  const scene = window.__kingdomScene; const cam = window.__kingdomCamera;
  if (!scene || !cam) throw new Error('no scene (the page needs ?debug=1)');
  scene.updateMatrixWorld(true); cam.updateMatrixWorld(true);
  const SKIP = /^(sky|clouds|rain|rain-.*|stars|moon|pg1-debug.*)$/;
  const left = {};
  const skip = (o, why) => { left[why] = (left[why] || 0) + 1; };
  const visible = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  // Only position, normal, uv, color survive; a colour is always written so merges line up.
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
    // Plain PBR in, so the exporter keeps colour, roughness, metalness and emission.
    const src = Array.isArray(m) ? m[0] : m;
    const out = new THREE.MeshStandardMaterial({ name: src.name || src.type, vertexColors: false });
    // The colour is baked into the vertex colours (glTF multiplies them); the factor stays white.
    out.color.setRGB(1, 1, 1);
    if (src.emissive && (src.emissiveIntensity ?? 1) > 0 && (src.emissive.r + src.emissive.g + src.emissive.b) > 0.01) { out.emissive.copy(src.emissive); out.emissiveIntensity = src.emissiveIntensity ?? 1; }
    out.roughness = src.roughness ?? (src.type === 'MeshBasicMaterial' ? 1 : 0.6);
    out.metalness = src.metalness ?? 0;
    if (src.type === 'MeshBasicMaterial' && src.color) { out.emissive.copy(src.color); out.emissiveIntensity = 1; }
    if (src.map) { out.map = src.map; if (src.type === 'MeshBasicMaterial') out.emissiveMap = src.map; }
    if (src.emissiveMap && out.emissiveIntensity > 0 && (out.emissive.r + out.emissive.g + out.emissive.b) > 0.01) out.emissiveMap = src.emissiveMap;
    out.transparent = !!src.transparent; out.opacity = src.opacity ?? 1;
    out.userData.pg1 = { type: src.type, toneMapped: src.toneMapped !== false };
    return out;
  };
  const root = new THREE.Scene(); root.name = 'pg1-city';
  let meshes = 0; let tris = 0; const buildings = [];
  scene.traverse((o) => {
    if (!o.isMesh) { if (o.isPoints || o.isLine || o.isSprite) skip(o, o.type); return; }
    if (!visible(o) || SKIP.test(o.name || '')) { skip(o, SKIP.test(o.name || '') ? (o.name || 'sky') : 'hidden'); return; }
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!mat || mat.visible === false || (mat.opacity === 0 && mat.transparent)) { skip(o, 'invisible material'); return; }
    if (mat.isShaderMaterial && !/skyline/.test(o.name)) { skip(o, `shader: ${o.name || 'unnamed'}`); return; }
    const parts = [];
    // The facade material (skyline, crown tower): its windows are drawn in a shader, so Blender draws its own.
    const facade = typeof mat.customProgramCacheKey === 'function' && /pg1-facade/.test(String(mat.customProgramCacheKey()));
    const base = facade ? null : (mat.color ? [mat.color.r, mat.color.g, mat.color.b] : [1, 1, 1]);
    // Skyline buildings go out as records (kind, place, size, seed, style): Blender builds them in detail.
    const kindOf = /^skyline-(box|round|taper|twist)$/.exec(o.name || '');
    if (facade && o.isInstancedMesh && kindOf) {
      const seed = o.geometry.attributes.aSeed; const style = o.geometry.attributes.aStyle;
      const m4 = new THREE.Matrix4(); const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const sc = new THREE.Vector3(); const e = new THREE.Euler();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m4); m4.premultiply(o.matrixWorld);
        if (!m4.elements.every(Number.isFinite) || Math.abs(m4.determinant()) < 1e-9) continue;
        m4.decompose(p, q, sc); e.setFromQuaternion(q, 'YXZ');
        buildings.push({ kind: kindOf[1], x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), w: +sc.x.toFixed(2), h: +sc.y.toFixed(2), d: +sc.z.toFixed(2), ry: +e.y.toFixed(4), seed: seed ? +seed.getX(i).toFixed(3) : 0, style: style ? style.getX(i) : 0 });
      }
      return;
    }
    if (o.isInstancedMesh) {
      const seed = o.geometry.attributes.aSeed; const style = o.geometry.attributes.aStyle;
      const m4 = new THREE.Matrix4(); const col = new THREE.Color();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m4); m4.premultiply(o.matrixWorld);
        // Parked or hidden instances (zero scale, or not set) are left out.
        if (!m4.elements.every(Number.isFinite) || Math.abs(m4.determinant()) < 1e-9) { left['hidden instance'] = (left['hidden instance'] || 0) + 1; continue; }
        let c = base || [0.5, 0, 0];
        if (facade && seed && style) c = [seed.getX(i) / 997, style.getX(i) / 8, 0];
        else if (!facade && o.instanceColor) { o.getColorAt(i, col); c = [col.r * base[0], col.g * base[1], col.b * base[2]]; }
        const g = prep(o.geometry, c); g.applyMatrix4(m4); parts.push(g);
      }
    } else { const g = prep(o.geometry, base || [0.5, 0, 0]); g.applyMatrix4(o.matrixWorld); parts.push(g); }
    if (!parts.length) return;
    // Merge in chunks (large instanced sets), one mesh per chunk.
    for (let k = 0; k < parts.length; k += 400) {
      const merged = mergeGeometries(parts.slice(k, k + 400), false);
      if (!merged) { skip(o, `merge failed: ${o.name}`); continue; }
      const mesh = new THREE.Mesh(merged, exportMat(o.material));
      mesh.name = `${facade ? 'facade~' : ''}${o.name || o.type}${k ? `-${k / 400}` : ''}`;
      mesh.userData.pg1 = { source: o.name || '', instanced: !!o.isInstancedMesh, facade };
      root.add(mesh); meshes++; tris += (merged.index ? merged.index.count : merged.attributes.position.count) / 3;
    }
  });
  const camera = new THREE.PerspectiveCamera(cam.fov, cam.aspect, cam.near, cam.far);
  camera.name = 'shot-camera';
  camera.position.copy(cam.getWorldPosition(new THREE.Vector3())); camera.quaternion.copy(cam.getWorldQuaternion(new THREE.Quaternion()));
  root.add(camera);
  const sun = []; scene.traverse((o) => { if (o.isDirectionalLight && o.intensity > 0) sun.push({ name: o.name, dir: o.position.clone().sub(o.target ? o.target.position : new THREE.Vector3()).normalize().toArray(), color: o.color.toArray(), intensity: o.intensity }); });
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
  if (!(glb instanceof ArrayBuffer) || !glb.byteLength) throw new Error(`the exporter returned ${glb && glb.constructor && glb.constructor.name} (${glb && glb.byteLength} bytes)`);
  const heavy = root.children.filter((m) => m.isMesh).map((m) => [m.name, Math.round((m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3)]).sort((a, b) => b[1] - a[1]).slice(0, 15);
  // Read back in chunks (a GLB of hundreds of MB does not fit one reply).
  window.__cityGlb = new Uint8Array(glb);
  return {
    bytes: glb.byteLength,
    meta: {
      meshes, triangles: Math.round(tris), left_out: left, heaviest: heavy, buildings,
      camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: cam.fov, aspect: cam.aspect, near: cam.near, far: cam.far },
      fog: scene.fog ? { color: scene.fog.color.toArray(), density: scene.fog.density } : null,
      lights: sun,
      exposure: window.__kingdomRenderer ? window.__kingdomRenderer.toneMappingExposure : 1
    }
  };
};

export async function main(argv = process.argv.slice(2)) {
  const o = parseExportArgs(argv);
  const log = (m) => console.log(`[city-export] ${m}`);
  mkdirSync(o.out, { recursive: true });
  const shot = reelShotById(o.shot);
  const data = await loadData(log, { days: REEL_WINDOW_DAYS, epoch: o.epoch });
  const { server, origin } = await startServer(data);
  const { chromium } = await import('playwright');
  let executablePath;
  if (!existsSync(chromium.executablePath()) && existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: o.width / 2, height: o.height / 2 }, deviceScaleFactor: 1, colorScheme: 'dark' });
    await ctx.addInitScript(CLOCK_SCRIPT);
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await page.goto(`${origin}/showcase/city.html?debug=1`, { waitUntil: 'load', timeout: 180000 });
    for (const t0 = Date.now(); ;) {
      if (errors.length) throw new Error(`page error: ${errors[0]}`);
      if (await page.evaluate(() => !!(window.showcase && window.showcase.ready() && window.showcase.frames() > 2))) break;
      if (Date.now() - t0 > 600000) throw new Error('the scene was not ready in 10 minutes');
      await new Promise((r) => setTimeout(r, 250));
    }
    const epoch = shot.light === 'day' ? dublinEpoch(13, 0) : shot.light === 'night' ? dublinEpoch(23, 10) : dublinEpoch(22, 0);
    const weather = shot.light === 'recorded' ? null : shot.weather;
    await page.evaluate((x) => window.showcase.setup(x), { light: 'live', weather, epoch });
    await page.evaluate((look) => window.showcase.scene.setShowcaseLook(look), { ...REEL_LOOK, mood: shot.light === 'day' ? 'day' : 'night' });
    await page.evaluate(() => window.__showcase.lock());
    const { HERO_BEARING } = await import('../public/kingdom/kingdom-world.js').catch(() => ({ HERO_BEARING: 0.16 }));
    const plan = planReelShot(shot.id, { heroBearing: HERO_BEARING, landmarks: await page.evaluate(() => window.showcase.landmarks()), junction: await page.evaluate(() => window.showcase.junction()), trams: await page.evaluate(() => window.showcase.scene.trams()) });
    const t = o.t ?? ((plan.still && plan.still.t) || 0.66);
    const pose = plan.director ? null : plan.still && plan.still.pose && o.t === null ? plan.still.pose : poseAt(plan, t);
    if (pose) await page.evaluate((p) => window.showcase.pose(p), pose);
    for (let i = 0; i < 20; i++) await page.evaluate(() => window.__showcase.advance(100));
    // The camera's aspect: the output's, not the small page's.
    await page.evaluate(([w, h]) => { const c = window.__kingdomCamera; c.aspect = w / h; c.updateProjectionMatrix(); }, [o.width, o.height]);
    const { bytes, meta } = await page.evaluate(EXPORT);
    const CHUNK = 8 * 1024 * 1024; const parts = [];
    for (let at = 0; at < bytes; at += CHUNK) parts.push(Buffer.from(await page.evaluate(([a, n]) => { const b = window.__cityGlb.subarray(a, a + n); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }, [at, CHUNK]), 'base64'));
    const glb = Buffer.concat(parts);
    if (glb.length !== bytes) throw new Error(`read ${glb.length} of ${bytes} bytes`);
    writeFileSync(join(o.out, 'city.glb'), glb);
    const info = { shot: shot.id, title: shot.title, light: shot.light, weather: weather ? weather.state : null, t, size: [o.width, o.height], data: data.sources.city, window: data.reel ? { now: data.reel.now, days: data.reel.days } : null, ...meta };
    writeFileSync(join(o.out, 'city-shot.json'), JSON.stringify(info, null, 2) + '\n');
    log(`${shot.id}: ${meta.buildings.length} buildings, ${meta.meshes} meshes, ${meta.triangles} triangles, ${(glb.length / 1e6).toFixed(1)} MB; left out ${JSON.stringify(meta.left_out)}`);
    return info;
  } finally { await browser.close(); server.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
