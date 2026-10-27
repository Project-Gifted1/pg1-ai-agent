// PG1 Sandbox viewer: the world around the entities: the sky with a sun
// and a day/night cycle, the ground (flat inside the world, hills beyond,
// curving away like a planet's surface), grass, lakes, clouds, the stars,
// and the black of space above the space altitude. None of this is world
// data: it is drawn from the world's size, seed and tick, the same way
// every time. The scenery forests are drawn the same way: they are not
// entities, nothing in the world can use them, and they stay clear of
// everything that is.
//
// By quality tier (quality.js): a physically based sky (Preetham, three's
// Sky) that fades into the black of space, cascaded soft shadows (three's
// CSM) for the sun, a water shader on the sea and lakes (water.js, with a
// generated normal map), and how dense the grass and woods are. Low keeps
// the gradient sky, no shadows and the plain sea.

import { Kit } from './kit.js';
import { createWaterMaterial } from './water.js';
import { applyTerrain } from './materials.js';
import { roadMesh, roadCells } from './road-graph.js';

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // always behind everything
}`;
const SKY_FRAG = `
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uSpace;
varying vec3 vDir;
void main() {
  float h = vDir.y;
  vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(uHorizon, uGround, pow(clamp(-h, 0.0, 1.0), 0.4));
  float s = max(dot(vDir, normalize(uSunDir)), 0.0);
  col += uSunColor * (pow(s, 900.0) * 6.0 + pow(s, 24.0) * 0.35 + pow(s, 4.0) * 0.12);
  col = mix(col, vec3(0.0, 0.0, 0.004) + uSunColor * pow(s, 1200.0) * 8.0, uSpace);
  gl_FragColor = vec4(col, 1.0);
}`;

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Value noise, seeded, for the ground's colours and the hills.
export function makeNoise(seed) {
  const perm = new Uint8Array(512);
  let s = (seed >>> 0) || 1;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = (h, x, y) => ((h & 1) ? x : -x) + ((h & 2) ? y : -y);
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const n2 = (x, y) => {
    const X = Math.floor(x) & 255; const Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x); const v = fade(y);
    const a = perm[X] + Y; const b = perm[X + 1] + Y;
    return lerp(lerp(grad(perm[a], x, y), grad(perm[b], x - 1, y), u), lerp(grad(perm[a + 1], x, y - 1), grad(perm[b + 1], x - 1, y - 1), u), v);
  };
  return (x, y, oct = 4) => { let t = 0; let amp = 0.5; let f = 1; for (let i = 0; i < oct; i++) { t += amp * n2(x * f, y * f); amp *= 0.5; f *= 2.03; } return t; };
}

// A tileable normal map for the water shader, from a sum of waves (no
// download: the CSP allows only this site's scripts and images anyway).
function waterNormals(THREE) {
  const N = 256; const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'); const img = g.createImageData(N, N);
  const waves = [[1, 0, 1.0], [0, 2, 0.7], [3, 1, 0.45], [-2, 3, 0.35], [5, -3, 0.2], [-6, -5, 0.15], [9, 4, 0.08]];
  const h = (x, y) => waves.reduce((t, [a, b, k]) => t + k * Math.sin((a * x + b * y) * Math.PI * 2 / N + a * 1.3 + b * 0.7), 0);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = h(x + 1, y) - h(x - 1, y); const dy = h(x, y + 1) - h(x, y - 1);
    const nx = -dx * 2; const ny = -dy * 2; const nz = 1; const l = Math.hypot(nx, ny, nz);
    const i = (y * N + x) * 4;
    img.data[i] = Math.round((nx / l * 0.5 + 0.5) * 255); img.data[i + 1] = Math.round((ny / l * 0.5 + 0.5) * 255); img.data[i + 2] = Math.round((nz / l * 0.5 + 0.5) * 255); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function createEnvironment(THREE, scene, { coarse = false, quality = null, addons = {}, camera = null, renderer = null } = {}) {
  const env = { THREE };
  const qual = quality || { cascades: coarse ? 0 : 1, shadowMapSize: 2048, water: false, sky: 'gradient', grass: 1, forest: 1 };
  env.quality = qual;
  // The sky dome.
  const skyU = {
    uTop: { value: new THREE.Color('#2a6fd6') }, uHorizon: { value: new THREE.Color('#bcd9f2') }, uGround: { value: new THREE.Color('#5b6b52') },
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) }, uSunColor: { value: new THREE.Color('#fff2d6') }, uSpace: { value: 0 }
  };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: skyU, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }));
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  sky.scale.setScalar(1000);
  sky.onBeforeRender = (r, sc, cam) => { sky.position.copy(cam.position); sky.updateMatrixWorld(); };
  scene.add(sky);

  // The physically based sky (Preetham), fading into space like the gradient does.
  let sky2 = null;
  if (qual.sky === 'physical' && addons.Sky) {
    sky2 = new addons.Sky();
    sky2.material.uniforms.uSpace = { value: 0 };
    sky2.material.fragmentShader = sky2.material.fragmentShader
      .replace('uniform vec3 up;', 'uniform vec3 up;\nuniform float uSpace;')
      .replace('gl_FragColor = vec4( retColor, 1.0 );', 'gl_FragColor = vec4( mix( retColor, vec3( 0.0, 0.0, 0.004 ), uSpace ), 1.0 );');
    const u = sky2.material.uniforms;
    u.turbidity.value = 2.6; u.rayleigh.value = 1.4; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82;
    sky2.material.depthWrite = false;
    sky2.frustumCulled = false;
    sky2.renderOrder = -10;
    sky2.scale.setScalar(100000);
    // Centred on whichever camera draws it (the water's reflection camera too).
    sky2.onBeforeRender = (r, sc, cam) => { sky2.position.copy(cam.position); sky2.updateMatrixWorld(); };
    scene.add(sky2);
    sky.visible = false;
  }

  // Stars: visible at night and in space.
  const starGeo = new THREE.BufferGeometry();
  const N = coarse ? 1500 : 3500;
  const sp = new Float32Array(N * 3); const sc = new Float32Array(N * 3);
  let s = 12345;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < N; i++) {
    const u = r() * 2 - 1; const a = r() * Math.PI * 2; const q = Math.sqrt(1 - u * u);
    sp[i * 3] = q * Math.cos(a); sp[i * 3 + 1] = u; sp[i * 3 + 2] = q * Math.sin(a);
    const t = r(); const c = new THREE.Color().setHSL(0.55 + t * 0.15, 0.4 * t, 0.7 + r() * 0.3);
    sc[i * 3] = c.r; sc[i * 3 + 1] = c.g; sc[i * 3 + 2] = c.b;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(sc, 3));
  const starMat = new THREE.PointsMaterial({ size: coarse ? 2 : 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -9;
  stars.onBeforeRender = (r, sc, cam) => { stars.position.copy(cam.position); stars.updateMatrixWorld(); };
  scene.add(stars);

  // The galaxy: a band of many faint stars across the sky (tilted, like the
  // Milky Way), with soft glowing clouds of dust and gas along it. Seen at
  // night and in space, with the stars.
  const galaxy = new THREE.Group();
  {
    const n = coarse ? 5000 : 12000;
    const gp = new Float32Array(n * 3); const gc = new Float32Array(n * 3);
    const tilt = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(1.05, 0.4, 0.2));
    const v = new THREE.Vector3(); const col = new THREE.Color();
    const gauss = () => (r() + r() + r() + r() - 2) / 2;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2; const lat = gauss() * (0.06 + 0.1 * Math.abs(Math.cos(a * 0.5)));   // fuller towards the centre
      v.set(Math.cos(a) * Math.cos(lat), Math.sin(lat), Math.sin(a) * Math.cos(lat)).applyMatrix4(tilt);
      gp[i * 3] = v.x; gp[i * 3 + 1] = v.y; gp[i * 3 + 2] = v.z;
      col.setHSL(0.08 + r() * 0.55, 0.25 + r() * 0.25, 0.55 + r() * 0.35);
      gc[i * 3] = col.r; gc[i * 3 + 1] = col.g; gc[i * 3 + 2] = col.b;
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(gp, 3)); gg.setAttribute('color', new THREE.BufferAttribute(gc, 3));
    const band = new THREE.Points(gg, new THREE.PointsMaterial({ size: 1.1, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    band.frustumCulled = false;
    galaxy.add(band);
    // Nebulae: soft sprites along the band.
    const tex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.3)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
    const hues = ['#6a4cff', '#ff5ea8', '#4cc9ff', '#ffb35e', '#8affc1'];
    for (let i = 0; i < 14; i++) {
      const a = r() * Math.PI * 2;
      v.set(Math.cos(a), gauss() * 0.08, Math.sin(a)).normalize().applyMatrix4(tilt);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: hues[i % hues.length], transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      sp.position.copy(v); sp.scale.setScalar(0.18 + r() * 0.3); sp.userData.k = 0.12 + r() * 0.12;
      galaxy.add(sp);
    }
    galaxy.userData.tex = tex;
  }
  galaxy.renderOrder = -9;
  scene.add(galaxy);
  env.galaxy = galaxy;

  // Lights.
  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x4a5a3a, 0.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.4);
  // Cascaded shadows replace the single shadow map where the tier allows.
  let csm = null;
  if (qual.cascades > 0 && addons.CSM && camera) {
    csm = new addons.CSM({ camera, parent: scene, cascades: qual.cascades, maxFar: 3000, mode: 'practical', shadowMapSize: qual.shadowMapSize || 2048, shadowBias: -0.0002, lightDirection: new THREE.Vector3(-0.5, -1, -0.3).normalize(), lightIntensity: 2.4, lightNear: 1, lightFar: 8000, lightMargin: 600 });
    for (const l of csm.lights) l.shadow.normalBias = 0.3;
  }
  env.csm = csm;
  env.setupMaterial = (m) => { if (csm && m && !m.userData.csm) { csm.setupMaterial(m); m.userData.csm = true; } return m; };
  sun.castShadow = !coarse && !csm && qual.cascades > 0;
  if (sun.castShadow) {
    sun.shadow.mapSize.set(qual.shadowMapSize || 2048, qual.shadowMapSize || 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.4;
  }
  scene.add(sun); scene.add(sun.target);
  const moonLight = new THREE.DirectionalLight(0x8fa8ff, 0.0);
  scene.add(moonLight);

  scene.fog = new THREE.FogExp2(0xbcd9f2, 0.00012);

  // Image-based light (Medium and up): the sky, prefiltered into an
  // environment map that every PBR material reflects and is lit by. Made
  // again when the sun has moved or the camera has gone up into space,
  // at most once a second.
  let pmrem = null; let envRT = null; let iblAt = -1e9; const iblSun = new THREE.Vector3(0, -2, 0); let iblSpace = -1;
  const iblScene = new THREE.Scene();
  if (qual.ibl && renderer) {
    pmrem = new THREE.PMREMGenerator(renderer);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: skyU, side: THREE.BackSide, depthWrite: false, depthTest: false }));
    iblScene.add(dome);
    scene.environmentIntensity = 0.55;
  }
  env.ibl = () => !!envRT;
  const updateIbl = (sunDir, space) => {
    if (!pmrem) return;
    const now = performance.now();
    if (envRT && now - iblAt < 1000) return;
    if (envRT && iblSun.angleTo(sunDir) < 0.03 && Math.abs(space - iblSpace) < 0.05) return;
    iblAt = now; iblSun.copy(sunDir); iblSpace = space;
    const next = pmrem.fromScene(iblScene, 0, 0.1, 100, { size: coarse ? 64 : 128 });
    if (envRT) envRT.dispose();
    envRT = next;
    scene.environment = envRT.texture;
  };

  // A true mirror in the water (Cinematic): the scene drawn once more from
  // below the sea, half size, into a texture the water shader reads.
  let reflector = null;
  if (qual.reflect === 'planar' && addons.Reflector && renderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    reflector = new addons.Reflector(new THREE.PlaneGeometry(1, 1), { textureWidth: Math.max(256, Math.round(size.x / 2)), textureHeight: Math.max(256, Math.round(size.y / 2)), clipBias: 0.02 });
    reflector.rotation.x = -Math.PI / 2;
    reflector.updateMatrixWorld();
    reflector.forceUpdate = true;
  }
  const reflectInv = new THREE.Matrix4();
  // Before each frame: the mirror image (only while some water is in use).
  env.beforeRender = (cam) => {
    if (!reflector) return;
    const waters = env.lakes.filter((w) => w.userData.water);
    if (!waters.length) return;
    for (const w of waters) w.visible = false;
    reflector.onBeforeRender(renderer, scene, cam);
    for (const w of waters) w.visible = true;
    reflectInv.copy(reflector.matrixWorld).invert();
    for (const w of waters) {
      const u = w.material.uniforms;
      u.uReflect.value = 0.85; u.tReflect.value = reflector.getRenderTarget().texture;
      u.uReflectMatrix.value.copy(reflector.material.uniforms.textureMatrix.value).multiply(reflectInv);
    }
  };

  env.sky = sky; env.sky2 = sky2; env.stars = stars; env.sun = sun; env.hemi = hemi; env.moonLight = moonLight; env.skyU = skyU;
  env.ground = null; env.lakes = []; env.clouds = null; env.grass = null; env.forest = null; env.roads = null;

  // A tile of grass detail, multiplied over the ground's colours.
  const detail = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#c8c8c8'; g.fillRect(0, 0, 256, 256);
    let q = 99; const rq = () => { q = (Math.imul(q, 1664525) + 1013904223) >>> 0; return q / 4294967296; };
    for (let i = 0; i < 9000; i++) { const v = 150 + Math.floor(rq() * 105); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(rq() * 256, rq() * 256, 1 + rq() * 2, 2 + rq() * 4); }
    for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(255,255,255,${0.05 + rq() * 0.08})`; g.beginPath(); g.arc(rq() * 256, rq() * 256, 8 + rq() * 30, 0, 7); g.fill(); }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  })();
  env.night = 0; env.space = 0;

  // The ground for a world: rebuilt when the world's size, seed or lakes change.
  env.buildGround = (world) => {
    for (const o of [env.ground, env.grass, env.clouds, env.forest, env.roads, ...env.lakes]) if (o) { scene.remove(o); o.traverse((m) => { if (m.geometry) m.geometry.dispose(); if (m.material) [].concat(m.material).forEach((x) => x.dispose()); }); }
    env.lakes = []; env.roads = null;
    const W = world.size.x; const D = world.size.y; const span = Math.max(W, D);
    const noise = makeNoise(world.seed || 1);
    const lakes = world.entities.filter((e) => e.base === 'lake');
    const roads = world.entities.filter((e) => e.base === 'road' || e.base === 'runway');
    // A disc reaching far past the world: flat inside, hills and then a
    // curve like a planet's horizon beyond.
    const R = Math.max(60000, span * 12);
    const isl0 = (world.islands || []).length > 0;
    const rings = coarse ? 90 : 150; const segs = coarse ? 96 : 160;
    const pos = []; const colr = []; const idx = []; const uvs = [];
    const c = new THREE.Color();
    const grassA = new THREE.Color('#4a6a30'); const grassB = new THREE.Color('#678742'); const dry = new THREE.Color('#7d7646'); const sand = new THREE.Color('#d8c690');
    const rock = new THREE.Color('#7b7b70');
    const tropical = new THREE.Color('#4f9a3a'); const coldGrass = new THREE.Color('#5f6f55'); const maritime = new THREE.Color('#567a45');
    const pebbles = new THREE.Color('#9e9a90'); const seabed = new THREE.Color('#c9b98a'); const deep = new THREE.Color('#1c3d52'); const snow = new THREE.Color('#f2f4f6'); const sea = new THREE.Color('#1d5d8c'); const wetSand = new THREE.Color('#8f7f58'); const far = new THREE.Color('#6f8f9f');
    const half = span / 2;
    // The terrain's height: flat inside the world, hills beyond, then the curve.
    // Islands (countries): land inside each, beaches at the shore, the sea
    // everywhere else, deepening away from the coast.
    const islands = world.islands || [];
    // The coast is the world's own (terrain.js, the engine's terrain.mjs to
    // the byte): the distance to it decides land, beach and sea.
    const T = world.terrain || null;
    const landEdge = (x, z) => { let best = -Infinity; let isl = null; for (const i of islands) { const e = i.r - Math.hypot(x - i.sx, z - i.sz); if (e > best) { best = e; isl = i; } } if (T) best = T.coastDistance(x + W / 2, -z + D / 2); return { edge: best, isl }; };
    env.landEdge = landEdge;
    // Lakes have a bed: the ground dips under the water over the last 8 m of
    // shore. In island worlds only a little, so the bed stays above the sea's
    // level and the sea never shows through the land round a lake.
    const bedDepth = (world.islands || []).length ? 0.14 : 1.2;
    const lakeDip = (x, z) => { let dip = 0; for (const l of lakes) { const d = Math.hypot(x - l.sx, z - l.sz) - l.radius; if (d < 0) dip = Math.max(dip, smooth(0, -8, d) * bedDepth); } return dip; };
    const heightAt = (x, z) => baseHeightAt(x, z) - (lakes.length ? lakeDip(x, z) : 0);
    const baseHeightAt = (x, z) => {
      if (islands.length) {
        const { edge } = landEdge(x, z);
        const rr = Math.hypot(x, z);
        const curve = (rr * rr) / (2 * 2.5e6) * smooth(span, span * 4, rr);
        if (edge >= 60) return 0.2 - curve;   // flat where things stand
        if (edge >= 0) return 0.2 * (edge / 60) - curve;
        return Math.max(-14, edge * 0.08) - curve;
      }
      const ox = Math.max(0, Math.abs(x) - W / 2); const oz = Math.max(0, Math.abs(z) - D / 2);
      const out = Math.hypot(ox, oz); const rr = Math.hypot(x, z);
      const hills = smooth(span * 0.05, span * 0.6, out);
      const n = noise(x / 900, z / 900, 5);
      let y = hills * (Math.max(0, n + 0.25) * 900 + 60) * (1 - smooth(span * 3, span * 6, out));
      y -= (rr * rr) / (2 * 2.5e6) * smooth(span, span * 4, rr);
      return y;
    };
    env.heightAt = heightAt;
    // Water at (x, z): the sea round the islands, and the lakes.
    env.waterAt = (x, z) => (islands.length > 0 && heightAt(x, z) < 0.12) || lakes.some((l) => Math.hypot(x - l.sx, z - l.sz) < l.radius + 1.5);
    env.lakeList = lakes.map((l) => ({ sx: l.sx, sz: l.sz, r: l.radius }));
    // Splat weights for the textured ground: grass, sand, rock, snow.
    const splatOf = (x, z, y, edge, cl, snowAmt) => {
      let ws = 0; let wr = smooth(500, 750, y); let wn = Math.max(smooth(800, 950, y), snowAmt);
      if (edge !== null && edge < 45) { if (cl === 'cold') { wr = Math.max(wr, 0.6); ws = 0.4; } else ws = 1; wn = 0; }
      for (const l of lakes) { const d = Math.hypot(x - l.sx, z - l.sz) - l.radius; if (d < 25) ws = Math.max(ws, smooth(25, 2, d)); }
      ws = Math.min(1, ws); wr = Math.min(1 - ws, wr); wn = Math.min(1 - ws - wr, wn);
      return [Math.max(0, 1 - ws - wr - wn), ws, wr, wn];
    };
    const splats = [];
    const ringR = (i) => (i === 0 ? 0 : half * 0.02 * Math.pow(R / (half * 0.02), i / rings));
    for (let i = 0; i <= rings; i++) {
      const rr = ringR(i);
      for (let j = 0; j < (i === 0 ? 1 : segs); j++) {
        const a = (j / segs) * Math.PI * 2;
        const x = Math.cos(a) * rr; const z = Math.sin(a) * rr;
        // Distance outside the world's square (0 inside).
        const ox = Math.max(0, Math.abs(x) - W / 2); const oz = Math.max(0, Math.abs(z) - D / 2);
        const out = Math.hypot(ox, oz);
        const y = heightAt(x, z);
        pos.push(x, y, z);
        uvs.push(x / 7, z / 7);
        const v = noise(x / 160 + 30, z / 160, 3);
        c.copy(grassA).lerp(grassB, Math.min(1, Math.max(0, v + 0.5))).lerp(dry, Math.max(0, noise(x / 700, z / 700, 2)) * 0.6);
        if (y > 500) c.lerp(rock, smooth(500, 750, y));
        if (y > 800) c.lerp(snow, smooth(800, 950, y));
        const seaMix = islands.length ? 0 : smooth(span * 2.2, span * 3.4, out);
        if (seaMix > 0) c.lerp(sea, seaMix);
        let sEdge = null; let sCl = 'temperate'; let sSnow = 0;
        if (islands.length) {
          const { edge, isl } = landEdge(x, z);
          const cl = isl ? isl.climate : 'temperate';
          sEdge = edge; sCl = cl;
          if (cl === 'tropical') c.lerp(tropical, 0.55);
          if (cl === 'cold') { c.lerp(coldGrass, 0.6); if (noise(x / 90, z / 90, 2) > 0.15) { c.lerp(snow, 0.7); sSnow = 0.7; } }
          if (cl === 'maritime') c.lerp(maritime, 0.5);
          if (edge < 45) c.copy(sand).lerp(cl === 'cold' ? pebbles : sand, 0.6);
          if (edge < -2) c.copy(seabed).lerp(deep, Math.min(1, -edge / 400));
        }
        c.lerp(far, smooth(span * 4, R, rr) * 0.7);
        for (const l of lakes) {
          const d = Math.hypot(x - l.sx, z - l.sz) - l.radius;
          if (d < 25) c.lerp(sand, smooth(25, 2, d));
        }
        colr.push(c.r, c.g, c.b);
        splats.push(...splatOf(x, z, y, sEdge, sCl, sSnow));
      }
    }
    for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
    for (let i = 1; i < rings; i++) {
      const a0 = 1 + (i - 1) * segs; const a1 = 1 + i * segs;
      for (let j = 0; j < segs; j++) {
        const j1 = (j + 1) % segs;
        idx.push(a0 + j, a0 + j1, a1 + j, a0 + j1, a1 + j1, a1 + j);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('splat', new THREE.Float32BufferAttribute(splats, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    // With the PBR textures (Medium and up) the ground blends grass, sand,
    // rock and snow by the splat weights below; without them, the old detail tile.
    const groundMat = env.setupMaterial(new THREE.MeshStandardMaterial(env.textures ? { vertexColors: true, roughness: 1, metalness: 0 } : { vertexColors: true, map: detail, roughness: 0.95, metalness: 0 }));
    if (env.textures) applyTerrain(groundMat, env.textures);
    const ground = new THREE.Mesh(g, groundMat);
    ground.receiveShadow = true;
    ground.position.y = isl0 ? -3 : -0.05;
    scene.add(ground);
    env.ground = ground;
    // Island worlds: a fine, even grid over the world itself (about 40 m), so
    // coasts, beaches and snow read cleanly; the disc above is the far sea.
    if (isl0) {
      const M = 600;
      const nx = Math.min(coarse ? 220 : 380, Math.ceil((W + 2 * M) / 40)); const nz = Math.min(coarse ? 150 : 260, Math.ceil((D + 2 * M) / 40));
      const pg = new THREE.PlaneGeometry(W + 2 * M, D + 2 * M, nx, nz);
      pg.rotateX(-Math.PI / 2);
      const pp = pg.attributes.position; const cols = new Float32Array(pp.count * 3); const uv2 = pg.attributes.uv; const spl = new Float32Array(pp.count * 4);
      const tmpC = new THREE.Color();
      for (let i = 0; i < pp.count; i++) {
        const x = pp.getX(i); const z = pp.getZ(i);
        pp.setY(i, heightAt(x, z));
        uv2.setXY(i, x / 7, z / 7);
        const { edge, isl } = landEdge(x, z);
        const v = noise(x / 160 + 30, z / 160, 3);
        tmpC.copy(grassA).lerp(grassB, Math.min(1, Math.max(0, v + 0.5))).lerp(dry, Math.max(0, noise(x / 700, z / 700, 2)) * 0.6);
        const cl = isl ? isl.climate : 'temperate';
        if (cl === 'tropical') tmpC.lerp(tropical, 0.55);
        let sSnow = 0;
        if (cl === 'cold') { tmpC.lerp(coldGrass, 0.6); const n2 = noise(x / 140, z / 140, 3); if (n2 > 0.08) { sSnow = Math.min(0.85, (n2 - 0.08) * 5); tmpC.lerp(snow, sSnow); } }
        if (cl === 'maritime') tmpC.lerp(maritime, 0.5);
        if (edge < 45) tmpC.copy(sand).lerp(cl === 'cold' ? pebbles : sand, 0.6);
        // Wet sand at the waterline, darker where the waves reach.
        if (edge < 7 && edge > -2) tmpC.lerp(wetSand, smooth(7, 0, edge) * 0.65);
        if (edge < -2) tmpC.copy(seabed).lerp(deep, Math.min(1, -edge / 400));
        for (const l of lakes) { const d = Math.hypot(x - l.sx, z - l.sz) - l.radius; if (d < 25) tmpC.lerp(sand, smooth(25, 2, d)); }
        cols[i * 3] = tmpC.r; cols[i * 3 + 1] = tmpC.g; cols[i * 3 + 2] = tmpC.b;
        spl.set(splatOf(x, z, pp.getY(i), edge, cl, sSnow), i * 4);
      }
      pg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      pg.setAttribute('splat', new THREE.BufferAttribute(spl, 4));
      pg.computeVertexNormals();
      const fine = new THREE.Mesh(pg, groundMat);
      fine.receiveShadow = true;
      fine.position.y = -0.05;
      ground.add(fine);
      fine.position.y = 3 - 0.05;   // undo the disc's lowering
    }
    // The sea: one wide plane at sea level, over everything below it.
    if (islands.length) {
      const sg = new THREE.CircleGeometry(R * 0.6, 96);
      sg.rotateX(-Math.PI / 2);
      let seaMesh;
      if (qual.water) {
        // The water shader: waves, the sky's reflection, the sun's glitter, shallows and foam.
        seaMesh = new THREE.Mesh(sg, createWaterMaterial(THREE, env.normals || (env.normals = waterNormals(THREE)), islands));
        seaMesh.userData.water = true;
      } else {
        seaMesh = new THREE.Mesh(sg, env.setupMaterial(new THREE.MeshStandardMaterial({ color: 0x1f6f9a, roughness: 0.12, metalness: 0.3, transparent: true, opacity: 0.88, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 8 })));
        seaMesh.receiveShadow = true;
      }
      seaMesh.position.y = 0;
      seaMesh.userData.sea = true;
      scene.add(seaMesh);
      env.lakes.push(seaMesh);
    }

    // Lakes: water with gentle waves.
    for (const l of lakes) {
      const lg = new THREE.CircleGeometry(l.radius, coarse ? 48 : 96, 0, Math.PI * 2);
      lg.rotateX(-Math.PI / 2);
      const water = qual.water
        ? new THREE.Mesh(lg, createWaterMaterial(THREE, env.normals || (env.normals = waterNormals(THREE)), [{ sx: l.sx, sz: l.sz, r: -l.radius }], { offset: false }))
        : new THREE.Mesh(lg, env.setupMaterial(new THREE.MeshStandardMaterial({ color: 0x2f7fb0, roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.92 })));
      water.position.set(l.sx, 0.12, l.sz);
      water.receiveShadow = true;
      if (qual.water) { water.userData.water = true; water.userData.sea = true; }
      water.userData.base = lg.attributes.position.array.slice();
      scene.add(water);
      env.lakes.push(water);
    }

    // The road network (road-graph.js), unless a more detailed street layer draws it.
    if (world.roads && !env.detailedRoads) {
      const rm = roadMesh(THREE, world.roads, world.size, islands.length ? heightAt : null, env.setupMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
      if (rm) { scene.add(rm); env.roads = rm; }
    }

    // Grass tufts, scattered over the world (not on roads or water).
    const count = Math.round((coarse ? 2500 : 7000) * (qual.grass ?? 1));
    const tuft = new THREE.ConeGeometry(0.35, 1.1, 4);
    tuft.translate(0, 0.55, 0);
    const grass = new THREE.InstancedMesh(tuft, env.setupMaterial(new THREE.MeshStandardMaterial({ color: 0x6f9a3f, roughness: 1 })), Math.max(1, count));
    const m = new THREE.Matrix4(); const q = new THREE.Quaternion(); const sc3 = new THREE.Vector3(); const p3 = new THREE.Vector3(); const e = new THREE.Euler();
    let placed = 0; let tries = 0; let ss = (world.seed || 1) * 7919;
    const rr2 = () => { ss = (Math.imul(ss, 1664525) + 1013904223) >>> 0; return ss / 4294967296; };
    const rcells = roadCells(world.roads, world.size, 20);
    const onRoad = (x, z) => rcells.has(`${Math.floor(x / 20)},${Math.floor(z / 20)}`) || roads.some((rd) => { const dx = x - rd.sx; const dz = z - rd.sz; const h = -(rd.heading || 0) * Math.PI / 180; const lx = dx * Math.cos(h) - dz * Math.sin(h); const lz = dx * Math.sin(h) + dz * Math.cos(h); return Math.abs(lx) < rd.length / 2 && Math.abs(lz) < rd.width / 2 + 2; });
    while (placed < count && tries < count * 4) {
      tries++;
      const x = (rr2() - 0.5) * W; const z = (rr2() - 0.5) * D;
      if (lakes.some((l) => Math.hypot(x - l.sx, z - l.sz) < l.radius + 6) || onRoad(x, z) || (islands.length && heightAt(x, z) < 0.1)) continue;
      e.set(0, rr2() * Math.PI, (rr2() - 0.5) * 0.3);
      q.setFromEuler(e);
      const k = 0.6 + rr2() * 1.2;
      m.compose(p3.set(x, islands.length ? heightAt(x, z) : 0, z), q, sc3.set(k, k * (0.7 + rr2()), k));
      grass.setMatrixAt(placed, m);
      grass.setColorAt(placed, new THREE.Color().setHSL(0.22 + rr2() * 0.06, 0.45, 0.28 + rr2() * 0.12));
      placed++;
    }
    grass.count = placed;
    grass.instanceMatrix.needsUpdate = true;
    if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
    grass.receiveShadow = true;
    scene.add(grass);
    env.grass = grass;

    // Scenery forests: woods on the open land and up the hills, kept well
    // clear of every entity, road and lake.
    const avoid = world.avoid || [];
    const cell = 80; const grid = new Map();
    for (const a of avoid) { const key = `${Math.floor(a.x / cell)},${Math.floor(a.z / cell)}`; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(a); }
    const near = (x, z, r) => { const cx = Math.floor(x / cell); const cz = Math.floor(z / cell); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const l = grid.get(`${cx + i},${cz + j}`); if (l && l.some((a) => Math.hypot(a.x - x, a.z - z) < r + (a.r || 0))) return true; } return false; };
    const kinds = [];
    { const k = new Kit(THREE); k.cyl(0.25, 0.4, 3, 6, '#5d4037', 0, 1.5, 0); for (let i = 0; i < 4; i++) k.cone(2.6 - i * 0.55, 3, 8, '#1f4f2a', 0, 3 + i * 1.9, 0, { jitter: 0.3, ry: i }); kinds.push(k.build().body); }
    { const k = new Kit(THREE); k.cyl(0.3, 0.45, 3.5, 6, '#6d4c2f', 0, 1.75, 0); k.ico(2.4, 1, '#2f6b2a', 0, 4.6, 0, { jitter: 0.35 }); k.ico(1.8, 1, '#3c7a30', 0.8, 5.8, 0.4, { jitter: 0.35 }); k.ico(1.6, 1, '#356f2c', -0.7, 5.5, -0.5, { jitter: 0.35 }); kinds.push(k.build().body); }
    // Medium and up: birches (white bark, light leaves) and broad oaks.
    if (!coarse && qual.textures) {
      { const k = new Kit(THREE); k.cyl(0.14, 0.2, 7, 6, '#e8e4dc', 0, 3.5, 0); for (let i = 0; i < 5; i++) k.box(0.3, 0.05, 0.05, '#3e3e3e', 0.12, 1 + i * 1.2, 0, { ry: i }); for (const [x, y, z, r2] of [[0, 6.5, 0, 1.5], [0.7, 5.6, 0.4, 1.1], [-0.6, 5.2, -0.3, 1.0], [0.2, 7.6, 0.1, 1.0]]) k.ico(r2, 1, '#7cb342', x, y, z, { jitter: 0.3 }); kinds.push(k.build().body); }
      { const k = new Kit(THREE); k.cyl(0.45, 0.7, 3, 7, '#5d4037', 0, 1.5, 0); for (const [x, z] of [[1, 0], [-0.8, 0.6], [0, -0.9]]) k.cyl(0.15, 0.25, 2.2, 5, '#5d4037', x * 0.6, 3.4, z * 0.6, { rz: -x * 0.5, rx: z * 0.5 }); for (const [x, y, z, r2] of [[0, 5.6, 0, 3.0], [1.8, 5.0, 0.8, 2.2], [-1.7, 5.2, -0.6, 2.2], [0.4, 6.8, -1.2, 2.0], [-0.5, 6.4, 1.4, 1.9]]) k.ico(r2, 1, '#2e5e1f', x, y, z, { jitter: 0.35 }); kinds.push(k.build().body); }
    }
    const forest = new THREE.Group();
    const fm = env.setupMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
    const per = Math.max(1, Math.round(((coarse ? 900 : 2600) * 2 / kinds.length) * (qual.forest ?? 1)));   // the same number of trees, shared between the species
    kinds.forEach((geo, ki) => {
      const inst = new THREE.InstancedMesh(geo, fm, per);
      let n = 0; let tries2 = 0;
      while (n < per && tries2 < per * 12) {
        tries2++;
        const x = (rr2() - 0.5) * span * 2.2; const z = (rr2() - 0.5) * span * 2.2;
        const f = noise(x / 650 + 11, z / 650 - 7, 3) + (ki ? 0 : smooth(0, span * 0.5, Math.hypot(Math.max(0, Math.abs(x) - W / 2), Math.max(0, Math.abs(z) - D / 2))) * 0.25);
        if (f < 0.12) continue;
        const y = heightAt(x, z);
        if (y > 620 || (islands.length && (y < 0.15 || landEdge(x, z).edge < 70))) continue;
        if (lakes.some((l) => Math.hypot(x - l.sx, z - l.sz) < l.radius + 30) || onRoad(x, z) || near(x, z, 45)) continue;
        e.set(0, rr2() * Math.PI * 2, 0); q.setFromEuler(e);
        const k = 0.8 + rr2() * 0.9;
        m.compose(p3.set(x, y - 0.2, z), q, sc3.set(k, k * (0.85 + rr2() * 0.4), k));
        inst.setMatrixAt(n++, m);
      }
      inst.count = n;
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = !coarse && qual.cascades > 0; inst.receiveShadow = !coarse && qual.cascades > 0;
      forest.add(inst);
    });
    scene.add(forest);
    env.forest = forest;

    // Clouds: soft clusters drifting high over the world.
    const clouds = new THREE.Group();
    const cm = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.9, flatShading: true });
    const puff = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < (coarse ? 14 : 26); i++) {
      const cl = new THREE.Group();
      const n = 5 + Math.floor(rr2() * 5);
      for (let k = 0; k < n; k++) {
        const pm = new THREE.Mesh(puff, cm);
        const sz = 40 + rr2() * 70;
        pm.scale.set(sz * 1.4, sz * 0.7, sz);
        pm.position.set((k - n / 2) * 55 + rr2() * 30, rr2() * 25, (rr2() - 0.5) * 60);
        cl.add(pm);
      }
      cl.position.set((rr2() - 0.5) * span * 2, 700 + rr2() * 500, (rr2() - 0.5) * span * 2);
      cl.userData.speed = 2 + rr2() * 3;
      clouds.add(cl);
    }
    scene.add(clouds);
    env.clouds = clouds;
    env.span = span;
  };

  // Time of day (0..1, 0.5 is noon) and the camera's altitude in metres
  // with the space altitude: sets the sky, lights, fog and stars.
  const tmp = new THREE.Vector3();
  env.update = ({ dayFraction, cameraAlt, spaceAlt, camera, target, shadowSpan, dt }) => {
    const a = (dayFraction - 0.25) * Math.PI * 2;                    // sunrise at 0.25
    const sunDir = tmp.set(Math.cos(a) * 0.9, Math.sin(a), 0.35).normalize();
    const elev = sunDir.y;
    const day = smooth(-0.12, 0.25, elev);
    const dusk = 1 - Math.abs(smooth(-0.25, 0.25, elev) * 2 - 1);
    env.night = 1 - day;
    env.space = smooth(spaceAlt * 0.45, spaceAlt * 1.05, cameraAlt);
    const sp = env.space;
    skyU.uSunDir.value.copy(sunDir);
    skyU.uTop.value.setRGB(lerp(0.01, 0.16, day), lerp(0.02, 0.42, day), lerp(0.06, 0.86, day));
    skyU.uHorizon.value.setRGB(lerp(0.05, 0.74, day) + dusk * 0.5, lerp(0.07, 0.85, day) + dusk * 0.18, lerp(0.14, 0.95, day) - dusk * 0.1);
    skyU.uGround.value.setRGB(lerp(0.02, 0.36, day), lerp(0.03, 0.42, day), lerp(0.04, 0.32, day));
    skyU.uSunColor.value.setRGB(1, lerp(0.55, 0.95, day * (1 - dusk * 0.5)), lerp(0.3, 0.84, day * (1 - dusk * 0.6)));
    skyU.uSpace.value = sp;
    sky.position.copy(camera.position);
    if (sky2) {
      sky2.position.copy(camera.position);
      sky2.material.uniforms.sunPosition.value.copy(sunDir).multiplyScalar(450000);
      sky2.material.uniforms.uSpace.value = sp;
    }
    stars.position.copy(camera.position);
    // Far beyond the terrain, so hills and the ground hide the stars behind them.
    stars.scale.setScalar(150000);
    starMat.opacity = Math.max(sp, smooth(0.35, 0.85, env.night)) * 0.95;
    galaxy.position.copy(camera.position); galaxy.scale.setScalar(140000);
    for (const o of galaxy.children) o.material.opacity = starMat.opacity * (o.isPoints ? 0.85 : o.userData.k);
    galaxy.visible = starMat.opacity > 0.01;
    sun.intensity = lerp(0.0, 2.1, day) * (1 - dusk * 0.35) + sp * 1.6;
    sun.color.setRGB(1, lerp(0.6, 0.96, day), lerp(0.4, 0.88, day));
    hemi.intensity = lerp(0.12, 0.62, day) + sp * 0.1;
    hemi.color.setRGB(lerp(0.25, 0.8, day), lerp(0.3, 0.9, day), lerp(0.6, 1, day));
    hemi.groundColor.setRGB(lerp(0.05, 0.29, day), lerp(0.06, 0.35, day), lerp(0.1, 0.23, day));
    moonLight.intensity = env.night * 0.3 * (1 - sp);
    if (csm) {
      // The cascades carry the sunlight; the plain sun stays dark.
      csm.lightDirection.copy(sunDir).negate();
      for (const l of csm.lights) { l.intensity = sun.intensity; l.color.copy(sun.color); }
      sun.intensity = 0;
    }
    moonLight.position.set(-sunDir.x, Math.abs(sunDir.y) + 0.4, -sunDir.z).multiplyScalar(1000).add(target);
    moonLight.target.position.copy(target);
    // The sun follows the camera's target so shadows stay sharp where you look.
    const span = Math.max(80, Math.min(2500, shadowSpan));
    sun.position.copy(sunDir).multiplyScalar(span * 3).add(target);
    sun.target.position.copy(target);
    if (sun.castShadow) {
      const cam = sun.shadow.camera;
      cam.left = -span; cam.right = span; cam.top = span; cam.bottom = -span; cam.near = 1; cam.far = span * 7;
      cam.updateProjectionMatrix();
    }
    if (csm) csm.update();
    if (scene.fog) {
      scene.fog.color.setRGB(lerp(0.04, 0.72, day) + dusk * 0.3, lerp(0.05, 0.82, day) + dusk * 0.1, lerp(0.09, 0.93, day));
      // Haze thins as the camera climbs (its real height: a high overview of
      // the islands should read clearly, not through a wall of fog).
      scene.fog.density = 0.00009 * (1 - sp) * (1 - smooth(300, 5000, Math.max(cameraAlt, camera.position.y)) * 0.85) + 0.0000004;
    }
    // Water ripples and drifting clouds.
    const t = performance.now() / 1000;
    for (const w of env.lakes) {
      if (w.userData.water) {
        const u = w.material.uniforms;
        u.uTime.value = t;
        u.uSunDir.value.copy(sunDir);
        u.uSunColor.value.setRGB(lerp(0.05, 1, day), lerp(0.05, 0.95, day * (1 - dusk * 0.4)), lerp(0.08, 0.88, day * (1 - dusk * 0.6)));
        u.uZenith.value.copy(skyU.uTop.value); u.uHorizon.value.copy(skyU.uHorizon.value);
        u.uDeep.value.setRGB(lerp(0.005, 0.03, day), lerp(0.01, 0.17, day), lerp(0.03, 0.27, day));
        u.uShallow.value.setRGB(lerp(0.01, 0.12, day), lerp(0.03, 0.58, day), lerp(0.05, 0.6, day));
        continue;
      }
      if (w.userData.sea) { w.material.color.setRGB(lerp(0.03, 0.12, day), lerp(0.07, 0.43, day), lerp(0.14, 0.62, day)); continue; }
      const p = w.geometry.attributes.position; const b = w.userData.base;
      for (let i = 0; i < p.count; i++) p.array[i * 3 + 1] = Math.sin(b[i * 3] * 0.05 + t * 1.3) * 0.12 + Math.cos(b[i * 3 + 2] * 0.07 + t) * 0.1;
      p.needsUpdate = true;
      w.material.color.setRGB(lerp(0.03, 0.18, day), lerp(0.08, 0.5, day), lerp(0.15, 0.69, day));
    }
    if (env.clouds) {
      for (const cl of env.clouds.children) { cl.position.x += cl.userData.speed * dt; if (cl.position.x > env.span * 1.2) cl.position.x = -env.span * 1.2; }
      const cm = env.clouds.children[0] && env.clouds.children[0].children[0] && env.clouds.children[0].children[0].material;
      if (cm) { cm.color.setRGB(lerp(0.2, 1, day) + dusk * 0.2, lerp(0.22, 1, day), lerp(0.3, 1, day) - dusk * 0.1); cm.opacity = 0.9 * (1 - sp); }
    }
    updateIbl(sunDir, sp);
    // With the sky's own light in the materials, the flat fill light is halved.
    if (envRT) hemi.intensity *= 0.5;
    return { day, night: env.night, space: sp, sunDir };
  };

  env.dispose = () => {
    detail.dispose();
    if (env.normals) env.normals.dispose();
    if (csm) { csm.remove(); csm.dispose(); }
    if (sky2) { sky2.geometry.dispose(); sky2.material.dispose(); }
    if (envRT) envRT.dispose(); if (pmrem) pmrem.dispose(); iblScene.traverse((m) => { if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); }); scene.environment = null;
    if (reflector) reflector.dispose();
    galaxy.userData.tex.dispose();
    for (const o of [sky, stars, galaxy, env.ground, env.grass, env.clouds, env.forest, env.roads, ...env.lakes]) if (o) o.traverse((m) => { if (m.geometry) m.geometry.dispose(); if (m.material) [].concat(m.material).forEach((x) => x.dispose()); });
  };
  return env;
}
