// PG1 Sandbox viewer: the surface of another world, to walk on once the
// inhabitants have reached it (the page decides when: a colony there, or
// first contact for a far world). Drawn by the viewer from what the world
// is (rocky and cratered, icy, an ocean world with land, or an alien
// world), like the scenery woods: nothing here is world data, and the
// viewer adds nothing to the world.
//
//   surfaceKind(entity)   'rocky' | 'ice' | 'ocean' | 'giant' (no surface) | 'alien' | null
//   buildSurface(THREE, { kind, name, color, seed, colony, city, model, coarse })
//     -> { scene, heightAt(x, z), sun, dispose() }
//   model(kind, props, id) -> an Object3D (the page's own model meshes)
//
// The ground is 4 km across, shaped by seeded noise; the sky is the world's
// air (or space, with stars, where it has none); its colony, if it has one,
// stands at the middle with astronauts and a rover; after first contact, a
// far world shows its people's city.

export function surfaceKind(e) {
  if (!e) return null;
  const k = e.base || e.kind;
  if (k === 'alien_world') return 'alien';
  if (k === 'moon' || k === 'asteroid') return 'rocky';
  if (k !== 'planet') return null;
  const p = e.props || e.properties || {};
  if (p.rings || (Number(p.size) || 0) >= 130) return 'giant';
  const c = String(p.color || '#888888').replace('#', '');
  const n = parseInt(c.length === 3 ? c.split('').map((x) => x + x).join('') : c, 16) || 0;
  const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
  if (b > r && b > g * 0.9) return p.clouds ? 'ocean' : (r + g + b) / 3 > 150 ? 'ice' : 'ocean';
  if ((r + g + b) / 3 > 170) return 'ice';
  return 'rocky';
}

const SKY = {
  rocky: { top: '#000004', horizon: '#14121a', air: false },
  ice: { top: '#0b1d3a', horizon: '#9fc4e8', air: true },
  ocean: { top: '#2a6fd6', horizon: '#bcd9f2', air: true },
  alien: { top: '#2b0f3a', horizon: '#d78ad0', air: true }
};

function noiseOf(seed) {
  const P = 256; const g = new Float32Array(P * P); let s = seed >>> 0 || 7;
  for (let i = 0; i < g.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; g[i] = s / 4294967296; }
  const at = (a, b) => g[(((b % P) + P) % P) * P + (((a % P) + P) % P)];
  const vn = (x, y) => { const xi = Math.floor(x); const yi = Math.floor(y); const u = x - xi; const v = y - yi; const su = u * u * (3 - 2 * u); const sv = v * v * (3 - 2 * v); return (at(xi, yi) * (1 - su) + at(xi + 1, yi) * su) * (1 - sv) + (at(xi, yi + 1) * (1 - su) + at(xi + 1, yi + 1) * su) * sv; };
  return (x, y, oct = 5) => { let t = 0; let a = 0.5; let f = 1; for (let o = 0; o < oct; o++) { t += a * vn(x * f, y * f); a *= 0.5; f *= 2.03; } return t; };
}

export function buildSurface(THREE, { kind, name = 'a world', color = '#888888', seed = 1, colony = null, city = null, model = null, coarse = false } = {}) {
  const scene = new THREE.Scene();
  const sky = SKY[kind] || SKY.rocky;
  const noise = noiseOf(seed);
  const base = new THREE.Color(color);
  // The lie of the land: rolling ground; craters on airless worlds; the sea
  // at 0 on ocean worlds; a flat clearing at the middle for the colony.
  let rr = seed * 7919 >>> 0;
  const rnd = () => { rr = (Math.imul(rr, 1664525) + 1013904223) >>> 0; return rr / 4294967296; };
  const craters = kind === 'rocky' ? Array.from({ length: 40 }, () => ({ x: (rnd() - 0.5) * 3600, z: (rnd() - 0.5) * 3600, r: 15 + rnd() * rnd() * 220 })) : [];
  const heightAt = (x, z) => {
    let h = (noise(x / 500 + 3, z / 500 - 2) - 0.5) * (kind === 'ice' ? 26 : 60) + (noise(x / 60, z / 60, 3) - 0.5) * 3;
    if (kind === 'ocean') h += 6;
    for (const c of craters) { const d = Math.hypot(x - c.x, z - c.z) / c.r; if (d < 1.25) h += d < 1 ? -c.r * 0.12 * (1 - d * d) : c.r * 0.1 * Math.sin((d - 1) * Math.PI * 4); }
    const mid = Math.hypot(x, z);
    const flat = Math.min(1, Math.max(0, (mid - 60) / 140));
    return h * flat + (kind === 'ocean' ? 4 : 0) * (1 - flat);
  };
  const N = coarse ? 110 : 180; const S = 4000;
  const geo = new THREE.PlaneGeometry(S, S, N, N); geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position; const cols = new Float32Array(pos.count * 3); const c = new THREE.Color();
  const sand = new THREE.Color('#c9b98a'); const grass = new THREE.Color('#4f7d3a'); const snow = new THREE.Color('#eef4fb'); const glow = new THREE.Color('#5ef2c8');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i); const z = pos.getZ(i); const h = heightAt(x, z); pos.setY(i, h);
    const n = noise(x / 90 + 11, z / 90 - 7, 3);
    if (kind === 'ocean') c.copy(h < 1.5 ? sand : grass).lerp(new THREE.Color('#7d6b4a'), Math.max(0, Math.min(1, (h - 18) / 20))).offsetHSL(0, 0, (n - 0.5) * 0.12);
    else if (kind === 'ice') c.copy(snow).lerp(base, 0.25 + (n - 0.5) * 0.4);
    else if (kind === 'alien') c.copy(base).offsetHSL((n - 0.5) * 0.1, 0, (n - 0.5) * 0.3 - 0.15).lerp(glow, n > 0.66 ? 0.35 : 0);
    else c.copy(base).offsetHSL(0, -0.1, (n - 0.5) * 0.3 - 0.05);
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: kind === 'ice' ? 0.35 : 0.95, metalness: 0, flatShading: kind === 'rocky' }));
  ground.receiveShadow = true;
  scene.add(ground);
  if (kind === 'ocean') { const sea = new THREE.Mesh(new THREE.CircleGeometry(S * 0.75, 64), new THREE.MeshStandardMaterial({ color: base, roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.85 })); sea.rotation.x = -Math.PI / 2; sea.position.y = 0.5; scene.add(sea); }

  // The sky: a dome of the world's air, or the black of space with stars.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(30000, 32, 16), new THREE.ShaderMaterial({
    uniforms: { uTop: { value: new THREE.Color(sky.top) }, uHor: { value: new THREE.Color(sky.horizon) } },
    vertexShader: 'varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uTop; uniform vec3 uHor; varying vec3 vP; void main() { gl_FragColor = vec4(mix(uHor, uTop, pow(clamp(vP.y, 0.0, 1.0), 0.45)), 1.0); }',
    side: THREE.BackSide, depthWrite: false, fog: false
  }));
  scene.add(dome);
  if (!sky.air || kind === 'alien') {
    const n = coarse ? 1500 : 4000; const sp = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const u = rnd() * 2 - 1; const a = rnd() * Math.PI * 2; const q = Math.sqrt(1 - u * u); sp[i * 3] = q * Math.cos(a) * 25000; sp[i * 3 + 1] = Math.abs(u) * 25000; sp[i * 3 + 2] = q * Math.sin(a) * 25000; }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, transparent: true, opacity: sky.air ? 0.35 : 0.9, depthWrite: false, fog: false })));
  }
  if (sky.air) scene.fog = new THREE.FogExp2(new THREE.Color(sky.horizon), kind === 'alien' ? 0.00035 : 0.00022);

  // Light: their star, and the sky's.
  const sun = new THREE.DirectionalLight(kind === 'alien' ? 0xffd6f0 : 0xfff2d6, sky.air ? 2.2 : 2.8);
  sun.position.set(800, 1200, 500); sun.castShadow = !coarse;
  if (sun.castShadow) { sun.shadow.mapSize.set(2048, 2048); const sc = sun.shadow.camera; sc.left = -250; sc.right = 250; sc.top = 250; sc.bottom = -250; sc.far = 4000; sun.shadow.bias = -0.0004; }
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(new THREE.Color(sky.horizon), new THREE.Color(color).multiplyScalar(0.4), sky.air ? 0.7 : 0.15));
  const disc = new THREE.Mesh(new THREE.SphereGeometry(sky.air ? 300 : 220, 24, 12), new THREE.MeshBasicMaterial({ color: 0xfff1c4, fog: false }));
  disc.position.set(8000, 12000, 5000); scene.add(disc);

  // Rocks and boulders, instanced; on the alien world, glowing plants too.
  const rock = new THREE.DodecahedronGeometry(1, 1);
  const rocks = new THREE.InstancedMesh(rock, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), coarse ? 400 : 1200);
  const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const e3 = new THREE.Euler(); const v = new THREE.Vector3(); const s3 = new THREE.Vector3();
  let placed = 0;
  for (let i = 0; i < rocks.count * 3 && placed < rocks.count; i++) {
    const x = (rnd() - 0.5) * 2400; const z = (rnd() - 0.5) * 2400; if (Math.hypot(x, z) < 70) continue;
    const h = heightAt(x, z); if (kind === 'ocean' && h < 1.5) continue;
    const k = 0.3 + rnd() * rnd() * 4; e3.set(rnd() * 3, rnd() * 3, rnd() * 3); q.setFromEuler(e3);
    m4.compose(v.set(x, h + k * 0.3, z), q, s3.set(k * (1 + rnd() * 0.5), k * 0.7, k));
    rocks.setMatrixAt(placed, m4); rocks.setColorAt(placed, c.copy(kind === 'ice' ? snow : base).offsetHSL(0, -0.1, (rnd() - 0.5) * 0.2 - 0.1)); placed++;
  }
  rocks.count = placed; rocks.castShadow = !coarse; rocks.receiveShadow = true;
  scene.add(rocks);
  if (kind === 'alien') {
    const stalk = new THREE.ConeGeometry(0.4, 6, 6); stalk.translate(0, 3, 0);
    const plants = new THREE.InstancedMesh(stalk, new THREE.MeshStandardMaterial({ color: 0x3fe0c0, emissive: 0x1a8f7a, emissiveIntensity: 0.8, roughness: 0.5 }), 500);
    let n = 0; for (let i = 0; i < 1500 && n < 500; i++) { const x = (rnd() - 0.5) * 1600; const z = (rnd() - 0.5) * 1600; if (Math.hypot(x, z) < 120) continue; const k = 0.5 + rnd() * 1.5; m4.compose(v.set(x, heightAt(x, z), z), q.identity(), s3.set(k, k * (0.6 + rnd()), k)); plants.setMatrixAt(n++, m4); }
    plants.count = n; scene.add(plants);
  }

  // Their colony at the middle: its domes, astronauts out walking, a rover.
  const things = new THREE.Group(); scene.add(things);
  const put = (kind2, props, id, x, z, yaw = 0) => { if (!model) return; const o = model(kind2, props, id); if (!o) return; o.position.set(x, heightAt(x, z), z); o.rotation.y = yaw; things.add(o); };
  if (colony) {
    put('colony', colony.props || {}, colony.id, 0, 0);
    for (let i = 0; i < 5; i++) put('astronaut', {}, `${colony.id}-walker-${i}`, Math.cos(i * 1.3) * (26 + i * 3), Math.sin(i * 1.3) * (26 + i * 3), i);
    for (let i = 0; i < 3; i++) put('satellite', {}, `${colony.id}-mast-${i}`, -40 + i * 6, 34, 0);
  }
  // A far world's city, once they have met: towers and domes of their own.
  if (city) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2; const R = 110 + (i % 3) * 40; const x = Math.cos(a) * R; const z = Math.sin(a) * R; const h = 30 + ((i * 37) % 60);
      const spire = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 6, h, 8), new THREE.MeshStandardMaterial({ color: 0xb59ad8, roughness: 0.3, metalness: 0.6, emissive: 0x2b1240 }));
      spire.position.set(x, heightAt(x, z) + h / 2, z); spire.castShadow = !coarse; things.add(spire);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd6ff })); tip.position.set(x, heightAt(x, z) + h + 1, z); things.add(tip);
      if (i % 2) { const dome2 = new THREE.Mesh(new THREE.SphereGeometry(14, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9fe8ff, roughness: 0.1, metalness: 0.4, transparent: true, opacity: 0.55 })); dome2.position.set(x * 0.6, heightAt(x * 0.6, z * 0.6), z * 0.6); things.add(dome2); }
    }
    for (let i = 0; i < 6; i++) put('alien', { civ: city }, `${city}-${i}`, Math.cos(i) * 40, Math.sin(i) * 40, i);
    put('alien_ship', {}, `${city}-ship`, 70, -60, 0.6);
  }
  return {
    scene, heightAt, sun, name, kind,
    dispose() { scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); }); }
  };
}
