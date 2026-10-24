// PG1 Sandbox viewer: the world around the entities: the sky with a sun
// and a day/night cycle, the ground (flat inside the world, hills beyond,
// curving away like a planet's surface), grass, lakes, clouds, the stars,
// and the black of space above the space altitude. None of this is world
// data: it is drawn from the world's size, seed and tick, the same way
// every time. The scenery forests are drawn the same way: they are not
// entities, nothing in the world can use them, and they stay clear of
// everything that is.

import { Kit } from './kit.js';

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

export function createEnvironment(THREE, scene, { coarse = false } = {}) {
  const env = { THREE };
  // The sky dome.
  const skyU = {
    uTop: { value: new THREE.Color('#2a6fd6') }, uHorizon: { value: new THREE.Color('#bcd9f2') }, uGround: { value: new THREE.Color('#5b6b52') },
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) }, uSunColor: { value: new THREE.Color('#fff2d6') }, uSpace: { value: 0 }
  };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: skyU, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }));
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  sky.scale.setScalar(1000);
  scene.add(sky);

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
  scene.add(stars);

  // Lights.
  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x4a5a3a, 0.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.4);
  sun.castShadow = !coarse;
  if (sun.castShadow) {
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.4;
  }
  scene.add(sun); scene.add(sun.target);
  const moonLight = new THREE.DirectionalLight(0x8fa8ff, 0.0);
  scene.add(moonLight);

  scene.fog = new THREE.FogExp2(0xbcd9f2, 0.00012);

  env.sky = sky; env.stars = stars; env.sun = sun; env.hemi = hemi; env.moonLight = moonLight; env.skyU = skyU;
  env.ground = null; env.lakes = []; env.clouds = null; env.grass = null; env.forest = null;

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
    for (const o of [env.ground, env.grass, env.clouds, env.forest, ...env.lakes]) if (o) { scene.remove(o); o.traverse((m) => { if (m.geometry) m.geometry.dispose(); if (m.material) [].concat(m.material).forEach((x) => x.dispose()); }); }
    env.lakes = [];
    const W = world.size.x; const D = world.size.y; const span = Math.max(W, D);
    const noise = makeNoise(world.seed || 1);
    const lakes = world.entities.filter((e) => e.base === 'lake');
    const roads = world.entities.filter((e) => e.base === 'road' || e.base === 'runway');
    // A disc reaching far past the world: flat inside, hills and then a
    // curve like a planet's horizon beyond.
    const R = Math.max(60000, span * 12);
    const rings = coarse ? 90 : 150; const segs = coarse ? 96 : 160;
    const pos = []; const colr = []; const idx = []; const uvs = [];
    const c = new THREE.Color();
    const grassA = new THREE.Color('#4a6a30'); const grassB = new THREE.Color('#678742'); const dry = new THREE.Color('#7d7646'); const sand = new THREE.Color('#d8c690');
    const rock = new THREE.Color('#7b7b70'); const snow = new THREE.Color('#f2f4f6'); const sea = new THREE.Color('#1d5d8c'); const far = new THREE.Color('#6f8f9f');
    const half = span / 2;
    // The terrain's height: flat inside the world, hills beyond, then the curve.
    const heightAt = (x, z) => {
      const ox = Math.max(0, Math.abs(x) - W / 2); const oz = Math.max(0, Math.abs(z) - D / 2);
      const out = Math.hypot(ox, oz); const rr = Math.hypot(x, z);
      const hills = smooth(span * 0.05, span * 0.6, out);
      const n = noise(x / 900, z / 900, 5);
      let y = hills * (Math.max(0, n + 0.25) * 900 + 60) * (1 - smooth(span * 3, span * 6, out));
      y -= (rr * rr) / (2 * 2.5e6) * smooth(span, span * 4, rr);
      return y;
    };
    env.heightAt = heightAt;
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
        const seaMix = smooth(span * 2.2, span * 3.4, out);
        if (seaMix > 0) c.lerp(sea, seaMix);
        c.lerp(far, smooth(span * 4, R, rr) * 0.7);
        for (const l of lakes) {
          const d = Math.hypot(x - l.sx, z - l.sz) - l.radius;
          if (d < 25) c.lerp(sand, smooth(25, 2, d));
        }
        colr.push(c.r, c.g, c.b);
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
    g.setIndex(idx);
    g.computeVertexNormals();
    const ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.95, metalness: 0 }));
    ground.receiveShadow = true;
    ground.position.y = -0.05;
    scene.add(ground);
    env.ground = ground;

    // Lakes: water with gentle waves.
    for (const l of lakes) {
      const lg = new THREE.CircleGeometry(l.radius, coarse ? 48 : 96, 0, Math.PI * 2);
      lg.rotateX(-Math.PI / 2);
      const water = new THREE.Mesh(lg, new THREE.MeshStandardMaterial({ color: 0x2f7fb0, roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.92 }));
      water.position.set(l.sx, 0.12, l.sz);
      water.receiveShadow = true;
      water.userData.base = lg.attributes.position.array.slice();
      scene.add(water);
      env.lakes.push(water);
    }

    // Grass tufts, scattered over the world (not on roads or water).
    const count = coarse ? 2500 : 7000;
    const tuft = new THREE.ConeGeometry(0.35, 1.1, 4);
    tuft.translate(0, 0.55, 0);
    const grass = new THREE.InstancedMesh(tuft, new THREE.MeshStandardMaterial({ color: 0x6f9a3f, roughness: 1 }), count);
    const m = new THREE.Matrix4(); const q = new THREE.Quaternion(); const sc3 = new THREE.Vector3(); const p3 = new THREE.Vector3(); const e = new THREE.Euler();
    let placed = 0; let tries = 0; let ss = (world.seed || 1) * 7919;
    const rr2 = () => { ss = (Math.imul(ss, 1664525) + 1013904223) >>> 0; return ss / 4294967296; };
    const onRoad = (x, z) => roads.some((rd) => { const dx = x - rd.sx; const dz = z - rd.sz; const h = -(rd.heading || 0) * Math.PI / 180; const lx = dx * Math.cos(h) - dz * Math.sin(h); const lz = dx * Math.sin(h) + dz * Math.cos(h); return Math.abs(lx) < rd.length / 2 && Math.abs(lz) < rd.width / 2 + 2; });
    while (placed < count && tries < count * 4) {
      tries++;
      const x = (rr2() - 0.5) * W; const z = (rr2() - 0.5) * D;
      if (lakes.some((l) => Math.hypot(x - l.sx, z - l.sz) < l.radius + 6) || onRoad(x, z)) continue;
      e.set(0, rr2() * Math.PI, (rr2() - 0.5) * 0.3);
      q.setFromEuler(e);
      const k = 0.6 + rr2() * 1.2;
      m.compose(p3.set(x, 0, z), q, sc3.set(k, k * (0.7 + rr2()), k));
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
    const forest = new THREE.Group();
    const fm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    const per = coarse ? 900 : 2600;
    kinds.forEach((geo, ki) => {
      const inst = new THREE.InstancedMesh(geo, fm, per);
      let n = 0; let tries2 = 0;
      while (n < per && tries2 < per * 12) {
        tries2++;
        const x = (rr2() - 0.5) * span * 2.2; const z = (rr2() - 0.5) * span * 2.2;
        const f = noise(x / 650 + 11, z / 650 - 7, 3) + (ki ? 0 : smooth(0, span * 0.5, Math.hypot(Math.max(0, Math.abs(x) - W / 2), Math.max(0, Math.abs(z) - D / 2))) * 0.25);
        if (f < 0.12) continue;
        const y = heightAt(x, z);
        if (y > 620) continue;
        if (lakes.some((l) => Math.hypot(x - l.sx, z - l.sz) < l.radius + 30) || onRoad(x, z) || near(x, z, 45)) continue;
        e.set(0, rr2() * Math.PI * 2, 0); q.setFromEuler(e);
        const k = 0.8 + rr2() * 0.9;
        m.compose(p3.set(x, y - 0.2, z), q, sc3.set(k, k * (0.85 + rr2() * 0.4), k));
        inst.setMatrixAt(n++, m);
      }
      inst.count = n;
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = !coarse; inst.receiveShadow = !coarse;
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
    stars.position.copy(camera.position);
    // Far beyond the terrain, so hills and the ground hide the stars behind them.
    stars.scale.setScalar(150000);
    starMat.opacity = Math.max(sp, smooth(0.35, 0.85, env.night)) * 0.95;
    sun.intensity = lerp(0.0, 2.1, day) * (1 - dusk * 0.35) + sp * 1.6;
    sun.color.setRGB(1, lerp(0.6, 0.96, day), lerp(0.4, 0.88, day));
    hemi.intensity = lerp(0.05, 0.62, day) + sp * 0.1;
    hemi.color.setRGB(lerp(0.25, 0.8, day), lerp(0.3, 0.9, day), lerp(0.6, 1, day));
    hemi.groundColor.setRGB(lerp(0.05, 0.29, day), lerp(0.06, 0.35, day), lerp(0.1, 0.23, day));
    moonLight.intensity = env.night * 0.16 * (1 - sp);
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
    if (scene.fog) {
      scene.fog.color.setRGB(lerp(0.04, 0.72, day) + dusk * 0.3, lerp(0.05, 0.82, day) + dusk * 0.1, lerp(0.09, 0.93, day));
      scene.fog.density = 0.00011 * (1 - sp) * (1 - smooth(800, 4000, cameraAlt) * 0.8) + 0.0000004;
    }
    // Water ripples and drifting clouds.
    const t = performance.now() / 1000;
    for (const w of env.lakes) {
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
    return { day, night: env.night, space: sp, sunDir };
  };

  env.dispose = () => {
    detail.dispose();
    for (const o of [sky, stars, env.ground, env.grass, env.clouds, env.forest, ...env.lakes]) if (o) o.traverse((m) => { if (m.geometry) m.geometry.dispose(); if (m.material) [].concat(m.material).forEach((x) => x.dispose()); });
  };
  return env;
}
