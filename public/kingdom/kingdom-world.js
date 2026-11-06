// PG1 City: the world, a near-future city at dusk built entirely in code
// (no downloaded models or textures; an original skyline, never a copy of
// a real building).
//
//   the PG1 Tower   a tall six-sided glass spire with a gold accent line, a
//                   lit crown, PG1's shield near the top, the Command Centre
//                   deck, the emblem ring and the beacon at the tip (PG1's
//                   real production state: setState)
//   the skyline     procedural architecture: glass curtain-wall towers with
//                   mullions and spandrels, stone and brick mid-rises,
//                   low-rise blocks along the river; podiums at street
//                   level, setbacks, tapered and twisted towers, angled
//                   crowns, rooftop plant, antennas, helipads and red
//                   aircraft lights. All instanced, one facade shader: lit
//                   windows with depth (a parallax interior), warm and cool,
//                   a few switching over time, anti-aliased (the pattern
//                   fades to its average where a pane gets smaller than a
//                   pixel, so it never shimmers)
//   the river       water with reflections (a mirror on Cinematic, the water
//                   shader on Balanced), light streaks from the banks, stone
//                   embankments with railings and lamps; a solid arched
//                   bridge (toll gantry and light barrier) and a second
//                   smaller bridge downstream; the harbour pier with moored
//                   boats
//   the streets     lane markings, street and traffic lights, car light
//                   trails, pedestrians as light dots, trees, parks, the
//                   plaza at the tower's foot
//   the sky         a dusk gradient from a warm horizon to deep blue, clouds
//                   catching the sunset; blue-hour height fog (kingdom-scene)
//   the shield      invisible until a gadget fires
//
// Coordinates: metres; north is -z, east is +x; the tower at the origin.
// Every mesh is named (the browser tests check there is no unnamed block and
// no island, wall or moat); `obstacles` holds every building's box, so the
// camera never goes inside one.

export const RIVER = Object.freeze({ z: 120, half: 45 });
export const PLAZA_R = 52;
export const CITY_R = 420;
export const SPIRE_H = 210;
export const PODIUM_H = 8;
export const DECK_Y = PODIUM_H + 150;
export const TOWER_TOP = PODIUM_H + SPIRE_H + 22;
export const GATE_BEARINGS = Object.freeze({ north: 0, east: Math.PI / 2, south: Math.PI, west: Math.PI * 1.5 });
export const STYLES = Object.freeze({ glass: 0, stone: 1, brick: 2, metal: 3 });
// The hero shot looks at the tower from this bearing (radians from +x towards
// +z), along the river. No building stands in that sightline.
export const HERO_BEARING = 0.16;
export function inHeroCorridor(x, z, margin = 0) {
  const dx = Math.cos(HERO_BEARING); const dz = Math.sin(HERO_BEARING);
  const along = x * dx + z * dz; const across = Math.abs(-x * dz + z * dx);
  return along > 30 && along < 1100 && across < 34 + along * 0.03 + margin;
}

export const at = (bearing, r, y = 0) => ({ x: Math.sin(bearing) * r, y, z: -Math.cos(bearing) * r });
export const inRiver = (z) => Math.abs(z - RIVER.z) < RIVER.half;

const GOLD = 0xf3c623;

function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// The buildings' boxes, for the camera: hit(x, y, z, margin) -> the box or
// null. A grid of 100 m cells keeps it cheap.
export function makeObstacleIndex(boxes, cell = 100) {
  const grid = new Map();
  const key = (i, j) => `${i},${j}`;
  for (const b of boxes) {
    const i0 = Math.floor((b.x - b.hw) / cell); const i1 = Math.floor((b.x + b.hw) / cell);
    const j0 = Math.floor((b.z - b.hd) / cell); const j1 = Math.floor((b.z + b.hd) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(b); }
  }
  return {
    boxes,
    hit(x, y, z, margin = 0) {
      const i = Math.floor(x / cell); const j = Math.floor(z / cell);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        for (const b of grid.get(key(i + di, j + dj)) || []) {
          if (Math.abs(x - b.x) <= b.hw + margin && Math.abs(z - b.z) <= b.hd + margin && y <= b.top + margin && y >= -5) return b;
        }
      }
      return null;
    }
  };
}

// The facade shader, added to a standard (PBR) material so glass keeps its
// reflections. Per building (instance attributes): aSeed picks lit floors
// and windows; aStyle picks the facade: glass curtain wall (narrow panes,
// mullions, spandrel bands), stone or brick (punched windows with deep
// reveals), metal and glass. Inside a lit pane, a parallax interior: the
// back wall sits behind the glass and slides with the view, so a window has
// depth. Anti-aliasing: with fwidth, where a cell gets near a pixel the
// pattern blends to its average, so it never turns to noise.
function facadeMaterial(THREE, { reflective }) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: reflective ? 0.12 : 0.5, metalness: reflective ? 0.7 : 0.15 });
  const uniforms = { uNight: { value: 0.6 }, uTime: { value: 0 }, uOffice: { value: 0.4 }, uHome: { value: 0.4 } };
  m.userData.windows = uniforms;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = 'attribute float aSeed;\nattribute float aStyle;\nvarying float vSeed;\nvarying float vStyle;\nvarying vec3 vWPos;\nvarying vec3 vWNorm;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      vec4 wp4 = vec4(transformed, 1.0);
      vec3 n0 = objectNormal;
      #ifdef USE_INSTANCING
        wp4 = instanceMatrix * wp4;
        n0 = mat3(instanceMatrix) * n0;
      #endif
      wp4 = modelMatrix * wp4;
      vWPos = wp4.xyz; vSeed = aSeed; vStyle = aStyle;
      vWNorm = normalize(mat3(modelMatrix) * n0);`);
    sh.fragmentShader = 'uniform float uNight;\nuniform float uTime;\nuniform float uOffice;\nuniform float uHome;\nvarying float vSeed;\nvarying float vStyle;\nvarying vec3 vWPos;\nvarying vec3 vWNorm;\nfloat wh(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }\nfloat box(vec2 f, vec2 lo, vec2 hi, vec2 aa){ vec2 a = smoothstep(lo - aa, lo + aa, f) * (1.0 - smoothstep(hi - aa, hi + aa, f)); return a.x * a.y; }\n'
      + sh.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
      // Seeds and styles are whole numbers: rounded, so interpolation error can never reach the hash (no speckle).
      float style = floor(vStyle + 0.5);
      float sd = mod(floor(vSeed + 0.5), 997.0);
      vec3 base = style < 0.5 ? vec3(0.13, 0.2, 0.28) : style < 1.5 ? vec3(0.55, 0.52, 0.47) : style < 2.5 ? vec3(0.45, 0.25, 0.18) : vec3(0.36, 0.38, 0.42);
      diffuseColor.rgb = base * mix(0.85, 1.12, wh(vec3(sd, 1.0, 2.0)));`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = style < 0.5 ? roughnessFactor : style > 2.5 ? 0.35 : 0.85;`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
      metalnessFactor = style < 0.5 ? metalnessFactor : style > 2.5 ? 0.6 : 0.0;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      if (abs(vWNorm.y) < 0.5) {
        bool alongZ = abs(vWNorm.x) > abs(vWNorm.z);
        float u = alongZ ? vWPos.z : vWPos.x;
        bool glass = style < 0.5 || style > 2.5;
        float cw = glass ? 1.6 : 3.2; float ch = glass ? 3.8 : 3.4;
        vec2 cell = vec2(u / cw, vWPos.y / ch);
        vec2 f = fract(cell); vec2 id = floor(cell);
        vec2 aa = fwidth(cell) * 0.75;
        float tiny = smoothstep(0.25, 0.6, max(aa.x, aa.y));
        // The pane (glass: mullions and a spandrel band; masonry: a punched window).
        vec2 lo = glass ? vec2(0.06, 0.3) : vec2(0.25, 0.22);
        vec2 hi = glass ? vec2(0.94, 0.94) : vec2(0.75, 0.8);
        float pane = mix(box(f, lo, hi, aa), (hi.x - lo.x) * (hi.y - lo.y), tiny);
        float bay = floor(id.x / (glass ? 3.0 : 1.0));
        float floorOn = step(0.15, wh(vec3(sd, id.y, 3.1)));
        float h = wh(vec3(sd, id.y, bay));
        float swap = step(0.992, wh(vec3(sd + bay, id.y, floor(uTime / 7.0 + h * 7.0))));
        // Offices (glass, metal) and homes (brick, stone) light up by the hour in Dublin.
        float ratio = glass ? uOffice : uHome;
        float lit = abs(step(h, ratio) * floorOn - swap);
        lit = mix(lit, ratio * 0.9, tiny);
        // The interior: a back wall behind the glass that moves with the view.
        vec3 vd = normalize(cameraPosition - vWPos);
        float tv = alongZ ? vd.z * sign(vWNorm.x) : -vd.x * sign(vWNorm.z);
        vec2 inner = f + vec2(tv, vd.y) * 0.35 / max(0.25, abs(dot(vd, vWNorm)));
        float back = box(inner, vec2(0.2, 0.25), vec2(0.8, 0.9), aa);
        float depth = mix(0.45 + 0.55 * back, 0.75, tiny);
        vec3 warm = vec3(1.0, 0.74, 0.44); vec3 cool = vec3(0.68, 0.84, 1.0);
        vec3 wc = mix(warm, cool, step(0.7, wh(vec3(bay, sd, 7.7))));
        totalEmissiveRadiance += wc * pane * lit * depth * uNight * (0.45 + 0.55 * wh(vec3(id.y, bay, sd)));
        // Shop fronts at street level spill warm light.
        if (vWPos.y > 0.4 && vWPos.y < 4.4) totalEmissiveRadiance += vec3(1.0, 0.8, 0.55) * (0.35 + 0.65 * step(0.4, wh(vec3(sd, floor(u / 6.0), 9.0)))) * uNight * 0.55 * (1.0 - tiny * 0.5);
        // Glass reflects between the lit panes; masonry is darker in its reveals.
        diffuseColor.rgb *= glass ? mix(1.0, 0.75, pane) : mix(1.0, 0.35, pane);
      }`);
  };
  m.customProgramCacheKey = () => `pg1-facade-${reflective ? 1 : 0}`;
  return m;
}

// A box tower twisted round its height (for the twisted towers).
function twistedBox(THREE, turns = 0.35) {
  const g = new THREE.BoxGeometry(1, 1, 1, 1, 24, 1);
  g.translate(0, 0.5, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i); const a = y * turns * Math.PI;
    const x = p.getX(i); const z = p.getZ(i);
    p.setXYZ(i, x * Math.cos(a) - z * Math.sin(a), y, x * Math.sin(a) + z * Math.cos(a));
  }
  g.computeVertexNormals();
  return g;
}

// An angled crown: a wedge whose top slopes.
function wedge(THREE) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0.5 && p.getZ(i) < 0) p.setY(i, 0.15);
  g.computeVertexNormals();
  return g;
}

// A soft light streak texture (reflections on the water, glows).
function streakTexture(THREE) {
  const cv = document.createElement('canvas'); cv.width = 32; cv.height = 128;
  const g = cv.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 128); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 128);
  const gx = g.getImageData(0, 0, 32, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 32; x++) { const k = 1 - Math.abs(x - 15.5) / 16; gx.data[(y * 32 + x) * 4 + 3] *= k * k; }
  g.putImageData(gx, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

import { buildEmblem, buildHologram, brandCanvas } from './kingdom-emblem.js';
import { billboardLines } from './kingdom-data.js';

export function buildWorld(THREE, scene, settings, { waterMaterial = null, Reflector = null, brand = null } = {}) {
  const phone = settings.tier === 'phone';
  const cinematic = settings.tier === 'cinematic';
  const reflective = !phone;
  const named = (o, name) => { o.name = name; return o; };
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...o });
  const mats = {
    concrete: std(0x575b62, { roughness: 0.9 }),
    stone: std(0x8a8378, { roughness: 0.92 }),
    plaza: std(0x8f9298, { roughness: 0.8 }),
    asphalt: std(0x24272c, { roughness: 0.95 }),
    grass: std(0x2e4a2a, { roughness: 1 }),
    leaf: std(0x2f5a32, { roughness: 0.9 }),
    trunk: std(0x4a3a2c, { roughness: 1 }),
    steel: std(0xd8dde3, { roughness: 0.3, metalness: phone ? 0.3 : 0.85 }),
    steelDark: std(0x2b2f36, { roughness: 0.4, metalness: phone ? 0.2 : 0.7 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x3a5a78, roughness: reflective ? 0.06 : 0.3, metalness: reflective ? 0.9 : 0.15, emissive: 0x0b2236, emissiveIntensity: 0.5 }),
    gold: std(GOLD, { roughness: 0.3, metalness: 0.9, emissive: GOLD, emissiveIntensity: 0.4 }),
    goldGlow: new THREE.MeshBasicMaterial({ color: 0xffd34d }),
    led: new THREE.MeshBasicMaterial({ color: 0x9fe6ff }),
    white: new THREE.MeshBasicMaterial({ color: 0xf5f7fa }),
    warmLamp: new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
    aircraft: new THREE.MeshBasicMaterial({ color: 0xffc070 }),
    marking: new THREE.MeshBasicMaterial({ color: 0xcfcab8 }),
    barrier: new THREE.MeshBasicMaterial({ color: 0xfff1b8, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
  };
  const facade = facadeMaterial(THREE, { reflective });
  const root = named(new THREE.Group(), 'pg1-city');
  scene.add(root);
  const shadowed = (o) => { o.traverse((m) => { if (m.isMesh) { m.castShadow = !!settings.shadows; m.receiveShadow = !!settings.shadows; } }); return o; };
  const dummy = new THREE.Object3D();
  const set = (mesh, i, x, y, z, sx = 1, sy = 1, sz = 1, ry = 0, rx = 0) => { dummy.position.set(x, y, z); dummy.rotation.set(rx, ry, 0); dummy.scale.set(sx, sy, sz); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); };
  const obstacles = [];

  // --- ground: both banks, the river between ---
  const north = 4500 + RIVER.z - RIVER.half; const south = 4500 - RIVER.z - RIVER.half;
  for (const [depth, cz] of [[north, (RIVER.z - RIVER.half - 4500) / 2], [south, (RIVER.z + RIVER.half + 4500) / 2]]) {
    const ground = named(new THREE.Mesh(new THREE.PlaneGeometry(9000, depth), mats.concrete), 'ground');
    ground.rotation.x = -Math.PI / 2; ground.position.z = cz; ground.receiveShadow = !!settings.shadows; root.add(ground);
  }
  const plaza = named(new THREE.Mesh(new THREE.CircleGeometry(PLAZA_R, 64), mats.plaza), 'plaza');
  plaza.rotation.x = -Math.PI / 2; plaza.position.y = 0.05; plaza.receiveShadow = !!settings.shadows; root.add(plaza);
  const fountain = named(new THREE.Mesh(new THREE.RingGeometry(36, 38, 64), mats.led), 'plaza-light-ring'); fountain.rotation.x = -Math.PI / 2; fountain.position.y = 0.12; root.add(fountain);
  // The shield inlaid in the plaza paving at the tower's foot, lit.
  let inlay = null;
  if (brand) {
    // Lit gold lines set into the stone, flat: the shield's outline and its "1".
    const tex = new THREE.CanvasTexture(brandCanvas(brand, 512, { outline: true })); tex.colorSpace = THREE.SRGBColorSpace;
    inlay = named(new THREE.Mesh(new THREE.PlaneGeometry(16, 16), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false })), 'pg1-emblem-plaza');
    inlay.rotation.x = -Math.PI / 2; inlay.position.set(0, 0.14, 41); root.add(inlay);
  }

  // --- the river: a mirror on Cinematic, the water shader on Balanced, plain on Phone ---
  let riverMat = waterMaterial;
  let mirror = null;
  if (cinematic && Reflector) {
    // The mirror takes the scene's fog like everything else (three's own
    // Reflector shader ignores fog, which left the far river as an unfogged
    // red-and-blue strip rising out of the haze).
    const base = Reflector.ReflectorShader;
    const foggedShader = {
      name: 'PG1FoggedReflector',
      uniforms: THREE.UniformsUtils.merge([base.uniforms, THREE.UniformsLib.fog]),
      vertexShader: base.vertexShader.replace('#include <logdepthbuf_pars_vertex>', '#include <logdepthbuf_pars_vertex>\n#include <fog_pars_vertex>').replace('gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );', 'vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );\n\t\t\tgl_Position = projectionMatrix * mvPosition;\n\t\t\t#include <fog_vertex>'),
      fragmentShader: base.fragmentShader.replace('#include <logdepthbuf_pars_fragment>', '#include <logdepthbuf_pars_fragment>\n#include <fog_pars_fragment>').replace('#include <colorspace_fragment>', '#include <colorspace_fragment>\n\t\t\t#include <fog_fragment>')
    };
    mirror = named(new Reflector(new THREE.PlaneGeometry(9000, RIVER.half * 2), { textureWidth: 1024, textureHeight: 512, color: 0x46546a, shader: foggedShader }), 'river-mirror');
    mirror.material.fog = true;
    mirror.rotation.x = -Math.PI / 2; mirror.position.set(0, -3.3, RIVER.z); root.add(mirror);
  }
  if (!riverMat) riverMat = new THREE.MeshStandardMaterial({ color: 0x2c4c6c, roughness: 0.25, metalness: 0.1, emissive: 0x16243a, emissiveIntensity: 0.6 });
  if (waterMaterial && waterMaterial.uniforms) { waterMaterial.uniforms.uIslandCount.value = 0; waterMaterial.uniforms.uFoam.value = 0; waterMaterial.uniforms.uDeep.value.set(0x0b1f33); waterMaterial.uniforms.uShallow.value.set(0x173e57); }
  const river = named(new THREE.Mesh(new THREE.PlaneGeometry(9000, RIVER.half * 2), riverMat), 'river');
  river.rotation.x = -Math.PI / 2; river.position.set(0, -3.2, RIVER.z);
  if (mirror) { river.material = riverMat.clone ? riverMat.clone() : riverMat; river.material.transparent = true; river.material.opacity = 0.45; river.material.depthWrite = false; if (river.material.uniforms) river.visible = false; }
  root.add(river);
  // Stone embankments with railings and lamps.
  for (const side of [-1, 1]) {
    const bank = named(new THREE.Mesh(new THREE.BoxGeometry(9000, 4.4, 2.4), mats.stone), 'embankment');
    bank.position.set(0, -2, RIVER.z + side * RIVER.half); root.add(bank);
    const rail = named(new THREE.Mesh(new THREE.BoxGeometry(9000, 0.12, 0.12), mats.steel), 'embankment-railing'); rail.position.set(0, 1.1, RIVER.z + side * (RIVER.half - 0.6)); root.add(rail);
  }
  const postN = phone ? 200 : 600;
  const posts = named(new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), mats.steel, postN), 'embankment-railing');
  for (let i = 0; i < postN; i++) set(posts, i, -1500 + (i >> 1) * (3000 / (postN / 2)), 0.55, RIVER.z + (i % 2 ? 1 : -1) * (RIVER.half - 0.6));
  root.add(posts);
  // Light streaks on the water: the banks' lights, stretched by the ripples.
  const streakTex = streakTexture(THREE);
  const streakN = phone ? 60 : 180;
  const streakMat = new THREE.MeshBasicMaterial({ map: streakTex, color: 0xffc888, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
  const streaks = named(new THREE.InstancedMesh(new THREE.PlaneGeometry(1.6, 1), streakMat, streakN), 'river-light-streaks');
  const streakSeeds = [];
  { const r = rng(91); for (let i = 0; i < streakN; i++) { const side = r() < 0.5 ? -1 : 1; const x = (r() - 0.5) * 2400; const len = 12 + r() * 26; streakSeeds.push({ x, side, len, ph: r() * 6 }); set(streaks, i, x, -3.0, RIVER.z + side * (RIVER.half - len / 2 - 1), 1 + r(), len, 1, 0, -Math.PI / 2); if (r() < 0.25) streaks.setColorAt(i, new THREE.Color(0x9fd2ff)); else streaks.setColorAt(i, new THREE.Color(0xffc888)); } }
  root.add(streaks);

  // --- roads: an avenue grid, lane markings, car light trails ---
  const GRID = 160; const ROAD_W = 16;
  for (let k = -12; k <= 12; k++) {
    // North-south avenues stop at the river (only the bridges cross it).
    for (const [len, cz] of [[4500 + RIVER.z - RIVER.half, (RIVER.z - RIVER.half - 4500) / 2], [4500 - RIVER.z - RIVER.half, (RIVER.z + RIVER.half + 4500) / 2]]) {
      const ns = named(new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, len), mats.asphalt), 'road');
      ns.rotation.x = -Math.PI / 2; ns.position.set(k * GRID, 0.03, cz); root.add(ns);
    }
    const z = k * GRID - 40;
    if (!inRiver(z)) { const ew = named(new THREE.Mesh(new THREE.PlaneGeometry(9000, ROAD_W), mats.asphalt), 'road'); ew.rotation.x = -Math.PI / 2; ew.position.set(0, 0.03, z); root.add(ew); }
  }
  const dashes = [];
  for (let k = -5; k <= 5; k++) for (let d = -800; d <= 800; d += 12) { if (!inRiver(d)) dashes.push([k * GRID, d, 0]); const z = k * GRID - 40; if (!inRiver(z)) dashes.push([d, z, Math.PI / 2]); }
  const dashMesh = named(new THREE.InstancedMesh(new THREE.PlaneGeometry(0.25, 4), mats.marking, dashes.length), 'lane-markings');
  dashes.forEach(([x, z, ry], i) => set(dashMesh, i, x, 0.06, z, 1, 1, 1, ry, -Math.PI / 2));
  root.add(dashMesh);
  // --- the skyline ---
  const r = rng(7);
  const lots = [];
  const nearN = phone ? 140 : 240; const midN = phone ? 90 : 200; const farN = phone ? 380 : 1300;
  const offRoad = (v, w, shift = 0) => { const m = ((((v + shift) % GRID) + GRID) % GRID); return m > ROAD_W / 2 + w / 2 + 2 && m < GRID - ROAD_W / 2 - w / 2 - 2; };
  const parks = [[-240, -200, 60], [300, -360, 70], [-420, 260, 60], [480, 300, 55]];
  const inPark = (x, z, w) => parks.some(([px, pz, pr]) => Math.hypot(x - px, z - pz) < pr + w);
  const tryLot = (l) => {
    const big = Math.max(l.w, l.d);
    if (Math.hypot(l.x, l.z) < PLAZA_R + big * 0.8 + 8) return false;
    if (Math.abs(l.z - RIVER.z) < RIVER.half + big * 0.6 + 8) return false;
    if (!offRoad(l.x, l.w) || !offRoad(l.z, l.d, 40)) return false;
    if (l.x > 150 && l.x < 270 && l.z > 10 && l.z < RIVER.z) return false;
    if (inPark(l.x, l.z, big)) return false;
    if (inHeroCorridor(l.x, l.z, big * 0.6)) return false;
    lots.push({ seed: r() * 1000, ...l });
    return true;
  };
  const pickShape = () => { const k = r(); return k < 0.32 ? 'box' : k < 0.48 ? 'round' : k < 0.62 ? 'taper' : k < 0.76 ? 'twist' : 'setback'; };
  for (let i = 0; i < nearN * 8 && lots.filter((l) => l.ring === 'near').length < nearN; i++) {
    const a = r() * Math.PI * 2; const d = 75 + Math.pow(r(), 0.8) * 430;
    const tall = Math.max(0.2, 1 - d / 600);
    tryLot({ ring: 'near', x: Math.sin(a) * d, z: -Math.cos(a) * d, w: 16 + r() * 16, d: 16 + r() * 16, h: Math.min(165, 40 + r() * 120 * tall), shape: pickShape(), style: r() < 0.82 ? STYLES.glass : STYLES.metal });
  }
  for (let i = 0; i < midN * 8 && lots.filter((l) => l.ring === 'mid').length < midN; i++) {
    const a = r() * Math.PI * 2; const d = 120 + r() * 700;
    tryLot({ ring: 'mid', x: Math.sin(a) * d, z: -Math.cos(a) * d, w: 18 + r() * 22, d: 18 + r() * 22, h: 20 + r() * 26, shape: 'box', style: r() < 0.5 ? STYLES.stone : STYLES.brick });
  }
  // Low-rise blocks along the river.
  for (let x = -1400; x <= 1400; x += 28) for (const side of [-1, 1]) {
    if (r() < 0.2 || Math.abs(x) < 40) continue;
    tryLot({ ring: 'river', x: x + (r() - 0.5) * 6, z: RIVER.z + side * (RIVER.half + 22 + r() * 10), w: 18 + r() * 6, d: 14 + r() * 6, h: 10 + r() * 12, shape: 'box', style: r() < 0.6 ? STYLES.brick : STYLES.stone });
  }
  for (let i = 0; i < farN * 4 && lots.filter((l) => l.ring === 'far').length < farN; i++) {
    const a = r() * Math.PI * 2; const d = 600 + Math.pow(r(), 0.7) * 2400;
    tryLot({ ring: 'far', x: Math.sin(a) * d, z: -Math.cos(a) * d, w: 18 + r() * 26, d: 18 + r() * 26, h: 12 + r() * (d < 1200 ? 70 : 40), shape: r() < 0.85 ? 'box' : 'round', style: r() < 0.6 ? STYLES.glass : r() < 0.5 ? STYLES.stone : STYLES.brick });
  }
  const geos = {
    box: (() => { const g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0); return g; })(),
    round: (() => { const g = new THREE.CylinderGeometry(0.5, 0.5, 1, phone ? 12 : 24); g.translate(0, 0.5, 0); return g; })(),
    taper: (() => { const g = new THREE.CylinderGeometry(0.4, 0.62, 1, 4, 1); g.rotateY(Math.PI / 4); g.translate(0, 0.5, 0); return g; })(),
    twist: twistedBox(THREE),
    crown: wedge(THREE)
  };
  const parts = { box: [], round: [], taper: [], twist: [], crown: [] };
  const roofSpots = [];
  for (const l of lots) {
    const ry = (l.seed % 1) * 0.3;
    const add = (kind, x, y, z, w, h, d, extra = {}) => { parts[kind].push({ x, y, z, w, h, d, ry, seed: l.seed + parts[kind].length * 0.01, style: l.style, ...extra }); obstacles.push({ x, z, hw: w * 0.5 + d * 0.08, hd: d * 0.5 + w * 0.08, top: y + h }); };
    // A podium at street level under the tall ones.
    let base = 0;
    if (l.ring === 'near' && l.h > 70) { add('box', l.x, 0, l.z, l.w * 1.35, 9, l.d * 1.35, { style: STYLES.stone }); base = 9; }
    const h = l.h - base;
    if (l.shape === 'setback') {
      add('box', l.x, base, l.z, l.w, h * 0.5, l.d);
      add('box', l.x, base + h * 0.5, l.z, l.w * 0.78, h * 0.3, l.d * 0.78);
      add('box', l.x, base + h * 0.8, l.z, l.w * 0.55, h * 0.2, l.d * 0.55);
    } else add(l.shape, l.x, base, l.z, l.w, h, l.d);
    const top = l.h;
    if (l.ring === 'near' && (l.shape === 'box' || l.shape === 'setback') && r() < 0.35) { const cw = l.w * (l.shape === 'setback' ? 0.55 : 1); parts.crown.push({ x: l.x, y: top, z: l.z, w: cw, h: 10 + r() * 10, d: l.d * (l.shape === 'setback' ? 0.55 : 1), ry, seed: l.seed + 9, style: STYLES.glass }); }
    if (top > 55 || l.ring === 'mid') roofSpots.push({ x: l.x, y: top, z: l.z, h: top, w: Math.min(l.w, l.d) * (l.shape === 'setback' ? 0.55 : l.shape === 'taper' ? 0.5 : 0.8), ring: l.ring });
  }
  for (const [kind, list] of Object.entries(parts)) {
    if (!list.length) continue;
    const geo = geos[kind].clone();
    const seeds = new Float32Array(list.length); const styles = new Float32Array(list.length);
    const mesh = named(new THREE.InstancedMesh(geo, facade, list.length), `skyline-${kind}`);
    list.forEach((b, i) => { set(mesh, i, b.x, b.y, b.z, b.w, b.h, b.d, b.ry); seeds[i] = Math.floor(b.seed * 100) % 997; styles[i] = b.style; });
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(styles, 1));
    mesh.castShadow = !!settings.shadows; mesh.receiveShadow = !!settings.shadows;
    root.add(mesh);
  }
  // Rooftops: plant, antennas, helipads, red aircraft lights on the tallest.
  roofSpots.sort((a, b) => b.h - a.h);
  const tall = roofSpots.filter((s) => s.ring !== 'mid').slice(0, phone ? 40 : 90);
  const plantSpots = roofSpots.slice(0, phone ? 120 : 320);
  const plant = named(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mats.steelDark, plantSpots.length * 2), 'rooftop-plant');
  plantSpots.forEach((t, i) => { set(plant, i * 2, t.x - t.w * 0.18, t.y + 1.6, t.z + t.w * 0.12, t.w * 0.3, 3.2, t.w * 0.22); set(plant, i * 2 + 1, t.x + t.w * 0.2, t.y + 1, t.z - t.w * 0.15, t.w * 0.18, 2, t.w * 0.3); });
  root.add(plant);
  const antennas = named(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.4, 14, 6), mats.steel, tall.length), 'rooftop-antennas');
  const roofLights = named(new THREE.InstancedMesh(new THREE.SphereGeometry(0.8, 8, 6), mats.aircraft, tall.length), 'aircraft-lights');
  tall.forEach((t, i) => { set(antennas, i, t.x + t.w * 0.25, t.y + 7, t.z); set(roofLights, i, t.x + t.w * 0.25, t.y + 14.6, t.z); });
  const pads = tall.filter((_, i) => i % 3 === 1);
  const padMesh = named(new THREE.InstancedMesh(new THREE.RingGeometry(4, 4.6, 32), mats.led, Math.max(1, pads.length)), 'helipads');
  padMesh.count = pads.length;
  pads.forEach((t, i) => set(padMesh, i, t.x - t.w * 0.15, t.y + 0.25, t.z, 1, 1, 1, 0, -Math.PI / 2));
  root.add(antennas); root.add(roofLights); root.add(padMesh);
  if (brand && pads[0]) {
    const tex = new THREE.CanvasTexture(brandCanvas(brand, 128)); tex.colorSpace = THREE.SRGBColorSpace;
    const hp = named(new THREE.Mesh(new THREE.PlaneGeometry(5, 5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })), 'pg1-emblem-helipad');
    hp.rotation.x = -Math.PI / 2; hp.position.set(pads[0].x - pads[0].w * 0.15, pads[0].y + 0.3, pads[0].z); root.add(hp);
  }

  // --- parks and trees ---
  for (const [px, pz, pr] of parks) { const g = named(new THREE.Mesh(new THREE.CircleGeometry(pr, 32), mats.grass), 'park'); g.rotation.x = -Math.PI / 2; g.position.set(px, 0.08, pz); root.add(g); }
  const treeSpots = [];
  { const tr = rng(17); for (const [px, pz, pr] of parks) for (let i = 0; i < (phone ? 14 : 30); i++) { const a = tr() * Math.PI * 2; const d = Math.sqrt(tr()) * pr * 0.9; treeSpots.push([px + Math.cos(a) * d, pz + Math.sin(a) * d]); }
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; treeSpots.push([Math.cos(a) * (PLAZA_R - 6), Math.sin(a) * (PLAZA_R - 6)]); }
    for (let x = -600; x <= 600; x += 22) for (const side of [-1, 1]) if (tr() < 0.8) treeSpots.push([x, RIVER.z + side * (RIVER.half + 6)]); }
  const trunks = named(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.35, 3, 6), mats.trunk, treeSpots.length), 'tree-trunks');
  const crowns = named(new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.2, 0), mats.leaf, treeSpots.length), 'tree-crowns');
  treeSpots.forEach(([x, z], i) => { set(trunks, i, x, 1.5, z); set(crowns, i, x, 4.4, z, 1, 1.2, 1, i); });
  root.add(trunks); root.add(crowns);

  // --- the PG1 Tower ---
  const keep = named(new THREE.Group(), 'pg1-tower');
  const podium = named(new THREE.Mesh(new THREE.CylinderGeometry(30, 32, PODIUM_H, 6), mats.steelDark), 'tower-podium'); podium.position.y = PODIUM_H / 2; podium.rotation.y = Math.PI / 6; keep.add(podium);
  const spireGeo = new THREE.CylinderGeometry(2.2, 24, SPIRE_H, 6, 1, true); spireGeo.translate(0, SPIRE_H / 2, 0);
  spireGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array([777]), 1));
  spireGeo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(new Float32Array([STYLES.glass]), 1));
  const spire = named(new THREE.InstancedMesh(spireGeo, facade, 1), 'tower-spire');
  set(spire, 0, 0, PODIUM_H, 0, 1, 1, 1, Math.PI / 6);
  keep.add(spire);
  obstacles.push({ x: 0, z: 0, hw: 30, hd: 30, top: PODIUM_H + 60 }, { x: 0, z: 0, hw: 20, hd: 20, top: PODIUM_H + 120 }, { x: 0, z: 0, hw: 12, hd: 12, top: TOWER_TOP });
  const radiusAt = (y) => 24 - (24 - 2.2) * ((y - PODIUM_H) / SPIRE_H);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const p0 = new THREE.Vector3(Math.cos(a) * 24, PODIUM_H, Math.sin(a) * 24); const p1 = new THREE.Vector3(Math.cos(a) * 2.2, PODIUM_H + SPIRE_H, Math.sin(a) * 2.2);
    // One edge is PG1's gold accent line, lit.
    const edge = named(new THREE.Mesh(new THREE.CylinderGeometry(k === 1 ? 0.4 : 0.3, k === 1 ? 0.55 : 0.45, p0.distanceTo(p1), 6), k === 1 ? mats.goldGlow : mats.steel), k === 1 ? 'tower-gold-accent' : 'tower-edge');
    edge.position.copy(p0).add(p1).multiplyScalar(0.5); edge.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize());
    keep.add(edge);
  }
  // The lit crown: rings of light near the top.
  for (const [y, rr] of [[PODIUM_H + SPIRE_H - 18, 1], [PODIUM_H + SPIRE_H - 10, 0.8], [PODIUM_H + SPIRE_H - 3, 0.6]]) {
    const ring = named(new THREE.Mesh(new THREE.TorusGeometry(radiusAt(y) * rr + 0.5, 0.22, 6, 36), mats.goldGlow), 'tower-crown-lights'); ring.rotation.x = Math.PI / 2; ring.position.y = y; keep.add(ring);
  }
  const tipY = PODIUM_H + SPIRE_H + 12;
  const mast = named(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.6, 22, 6), mats.steel), 'tower-mast'); mast.position.y = tipY - 11; keep.add(mast);
  const beaconMat = new THREE.MeshBasicMaterial({ color: GOLD });
  const tip = named(new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 12), beaconMat), 'tower-beacon'); tip.position.y = tipY; keep.add(tip);
  const tipHalo = named(new THREE.Mesh(new THREE.SphereGeometry(9, 16, 12), new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })), 'tower-beacon-halo'); tipHalo.position.y = tipY; keep.add(tipHalo);
  // PG1's emblem, from the brand asset (kingdom-emblem.js): a large 3D
  // shield on the crown facing east (the hero shot) and south, a hologram
  // above the beacon at night, and the shield projected softly on the glass.
  const emblemY = PODIUM_H + SPIRE_H - 36;
  const emblems3d = [];
  let hologram = null; let emblemGlow = null;
  const brandTex = brand ? new THREE.CanvasTexture(brandCanvas(brand, 256)) : null;
  if (brandTex) brandTex.colorSpace = THREE.SRGBColorSpace;
  if (brand) {
    // One emblem, high on the crown, facing the hero camera (HERO_BEARING).
    const e = buildEmblem(THREE, brand, { height: 28, phone });
    e.group.name = 'pg1-emblem-crown';
    const dx = Math.cos(HERO_BEARING); const dz = Math.sin(HERO_BEARING);
    const off = radiusAt(emblemY) + 1.6;
    e.group.position.set(dx * off, emblemY, dz * off);
    e.group.rotation.y = Math.atan2(dx, dz);
    keep.add(e.group);
    emblems3d.push(e);
    // A soft glow behind it (seen as bloom on Balanced and Cinematic, and on Phone too).
    const glowTex = (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,214,90,0.9)'); gr.addColorStop(1, 'rgba(255,214,90,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; })();
    emblemGlow = named(new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false })), 'pg1-emblem-glow');
    emblemGlow.scale.setScalar(52); emblemGlow.position.set(dx * (off - 1), emblemY, dz * (off - 1));
    keep.add(emblemGlow);
    hologram = buildHologram(THREE, brand, { height: 24 });
    hologram.mesh.position.y = PODIUM_H + SPIRE_H + 40;
    keep.add(hologram.mesh);
  }
  const deckR = radiusAt(DECK_Y) + 5;
  const deck = named(new THREE.Mesh(new THREE.CylinderGeometry(deckR, deckR - 1.5, 3, 6), new THREE.MeshStandardMaterial({ color: 0x2a4a68, roughness: 0.08, metalness: 0.6, emissive: 0x6fd8ff, emissiveIntensity: 0.6, transparent: true, opacity: 0.88 })), 'command-deck');
  deck.position.y = DECK_Y; deck.rotation.y = Math.PI / 6; keep.add(deck);
  const deckRing = named(new THREE.Mesh(new THREE.TorusGeometry(deckR + 0.2, 0.2, 6, 60), mats.led), 'command-deck-ring'); deckRing.rotation.x = Math.PI / 2; deckRing.position.y = DECK_Y + 1.6; keep.add(deckRing);
  const ringY = DECK_Y - 9; const er = radiusAt(ringY) + 1.4;
  const emblems = named(new THREE.Group(), 'emblem-ring'); emblems.position.y = ringY; keep.add(emblems);
  const sealColors = { bronze: 0xcd7f32, silver: 0xd8dde3, gold: GOLD, platinum: 0xe5f4ff };
  const sealMedal = named(new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.4, 28), new THREE.MeshStandardMaterial({ color: 0xcd7f32, metalness: 0.9, roughness: 0.3, emissive: 0xcd7f32, emissiveIntensity: 0.35 })), 'emblem-seal-tier');
  sealMedal.rotation.x = Math.PI / 2; sealMedal.position.set(0, 0, er); sealMedal.visible = false; emblems.add(sealMedal);
  const keyMat = new THREE.MeshBasicMaterial({ color: 0x6fd8ff });
  const key = named(new THREE.Group(), 'emblem-passkey');
  key.add(named(new THREE.Mesh(new THREE.TorusGeometry(1, 0.26, 8, 20), keyMat), 'emblem-passkey-bow'));
  const shaft = named(new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.4, 0.3), keyMat), 'emblem-passkey-shaft'); shaft.position.x = 2.2; key.add(shaft);
  const bit = named(new THREE.Mesh(new THREE.BoxGeometry(0.4, 1, 0.3), keyMat), 'emblem-passkey-bit'); bit.position.set(3.2, -0.6, 0); key.add(bit);
  key.position.set(er * 0.72, 0, er * 0.72); key.rotation.y = Math.PI / 4; key.visible = false; emblems.add(key);
  const edSeal = named(new THREE.Mesh(new THREE.TorusGeometry(1.8, 0.26, 8, 36), new THREE.MeshBasicMaterial({ color: 0xf5f7fa })), 'emblem-ed25519'); edSeal.position.set(-er * 0.72, 0, er * 0.72); edSeal.rotation.y = -Math.PI / 4; edSeal.visible = false; emblems.add(edSeal);
  const vaultDoors = [];
  for (let k = 0; k < 2; k++) {
    const d = named(new THREE.Mesh(new THREE.BoxGeometry(0.8, 7, 6), k ? mats.steelDark : mats.steel), k ? 'vault-second-door' : 'vault-door');
    d.position.set(k ? 26.2 : 27.4, 3.5, 0);
    d.userData = k ? { axis: 'x', up: 26.2, down: 28.4, goal: 26.2 } : { up: 3.5, down: 3.5, goal: 3.5 };
    d.visible = false;
    keep.add(d); vaultDoors.push(d);
  }
  root.add(shadowed(keep));

  // --- the plaza: the Seal Forge and the Preflight Array ---
  const forge = named(new THREE.Group(), 'seal-forge');
  forge.add(named(new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.5, 2, 16), mats.steelDark), 'seal-forge-base'));
  const sealMat = new THREE.MeshStandardMaterial({ color: 0x1b2b3a, emissive: 0x7cc4ff, emissiveIntensity: 0.25, roughness: 0.3, metalness: 0.6 });
  const sealRing = named(new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.2, 10, 48), sealMat), 'seal-forge-ring'); sealRing.rotation.x = -Math.PI / 2; sealRing.position.y = 2.4; forge.add(sealRing);
  forge.position.set(-40, 0, 24);
  root.add(shadowed(forge));
  const preflight = [];
  for (let k = 0; k < 6; k++) {
    const p = at((k / 6) * Math.PI * 2 + Math.PI / 6, 44);
    const pyl = named(new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.9, 6, 8), mats.steelDark), 'preflight-pylon'); pyl.position.set(p.x, 3, p.z); root.add(pyl);
    const capMat = new THREE.MeshBasicMaterial({ color: 0x3a3f46 });
    const capOrb = named(new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 10), capMat), 'preflight-light'); capOrb.position.set(p.x, 6.8, p.z); root.add(capOrb);
    preflight.push({ mat: capMat, until: 0 });
  }

  // --- the main bridge: solid arches, hangers, deck lights ---
  const bridge = named(new THREE.Group(), 'bridge');
  const deckLen = RIVER.half * 2 + 30;
  const archR = deckLen / 2 - 4;
  const bdeck = named(new THREE.Mesh(new THREE.BoxGeometry(20, 2.2, deckLen), mats.concrete), 'bridge-deck'); bdeck.position.set(0, 9, RIVER.z); bridge.add(bdeck);
  const blane = named(new THREE.Mesh(new THREE.PlaneGeometry(0.3, deckLen), mats.marking), 'bridge-lane'); blane.rotation.x = -Math.PI / 2; blane.position.set(0, 10.15, RIVER.z); bridge.add(blane);
  for (const sx of [-9.2, 9.2]) {
    const arch = named(new THREE.Mesh(new THREE.TorusGeometry(archR, 1.5, 14, 48, Math.PI), mats.steel), 'bridge-arch');
    arch.rotation.y = Math.PI / 2; arch.position.set(sx, 10, RIVER.z); arch.scale.set(1, 0.55, 1); bridge.add(arch);
    for (let k = 1; k < 14; k++) {
      const zz = RIVER.z - archR + k * ((archR * 2) / 14);
      const tt = (zz - RIVER.z) / archR;
      const hgt = Math.sqrt(Math.max(0, 1 - tt * tt)) * archR * 0.55;
      if (hgt < 2) continue;
      const cable = named(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, hgt, 5), mats.steel), 'bridge-hanger'); cable.position.set(sx, 10 + hgt / 2, zz); bridge.add(cable);
    }
    const rail = named(new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.2, deckLen), mats.glass), 'bridge-rail'); rail.position.set(sx, 10.8, RIVER.z); bridge.add(rail);
    const strip = named(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, deckLen), mats.warmLamp), 'bridge-deck-lights'); strip.position.set(sx * 1.1, 8, RIVER.z); bridge.add(strip);
  }
  for (const zz of [RIVER.z - RIVER.half - 4, RIVER.z + RIVER.half + 4]) { const ab = named(new THREE.Mesh(new THREE.BoxGeometry(16, 14, 6), mats.stone), 'bridge-abutment'); ab.position.set(0, 2, zz); bridge.add(ab); }
  root.add(shadowed(bridge));
  // A second, smaller bridge downstream (west).
  const bridge2 = named(new THREE.Group(), 'bridge-west');
  const d2 = named(new THREE.Mesh(new THREE.BoxGeometry(12, 1.8, deckLen), mats.concrete), 'bridge-west-deck'); d2.position.set(-560, 7, RIVER.z); bridge2.add(d2);
  for (const zz of [RIVER.z - 18, RIVER.z + 18]) { const pier = named(new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.8, 10, 12), mats.stone), 'bridge-west-pier'); pier.position.set(-560, 1, zz); bridge2.add(pier); }
  for (const sx of [-5.6, 5.6]) { const l = named(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, deckLen), mats.warmLamp), 'bridge-west-lights'); l.position.set(-560 + sx, 8.2, RIVER.z); bridge2.add(l); }
  root.add(shadowed(bridge2));
  obstacles.push({ x: -560, z: RIVER.z, hw: 7, hd: deckLen / 2, top: 9 }, { x: 0, z: RIVER.z, hw: 11, hd: deckLen / 2, top: 10 + archR * 0.55 + 2 });
  // The toll gantry (x402), lanterns on the bridge.
  const gantryZ = RIVER.z + RIVER.half + 10;
  const toll = named(new THREE.Group(), 'toll-gantry');
  for (const sx of [-10.5, 10.5]) { const leg = named(new THREE.Mesh(new THREE.BoxGeometry(0.8, 9, 0.8), mats.steel), 'toll-gantry-leg'); leg.position.set(sx, 4.5, 0); toll.add(leg); }
  const beam = named(new THREE.Mesh(new THREE.BoxGeometry(22, 1.2, 1.4), mats.steel), 'toll-gantry-beam'); beam.position.y = 9.2; toll.add(beam);
  const barrier = named(new THREE.Mesh(new THREE.BoxGeometry(17, 0.35, 0.35), new THREE.MeshStandardMaterial({ color: 0xf5f7fa, emissive: 0xffb300, emissiveIntensity: 0.25, roughness: 0.4 })), 'toll-barrier'); barrier.position.set(0, 1.6, 0); toll.add(barrier);
  toll.position.set(0, 0, gantryZ);
  root.add(shadowed(toll));
  const lanterns = [];
  const lanternGeo = new THREE.CylinderGeometry(0.22, 0.22, 1.4, 10);
  for (let k = 0; k < 12; k++) for (const sx of [-8.2, 8.2]) {
    const m = named(new THREE.Mesh(lanternGeo, new THREE.MeshStandardMaterial({ color: 0x22262c, emissive: GOLD, emissiveIntensity: 0, roughness: 0.4, metalness: 0.6 })), 'bridge-lantern');
    m.position.set(sx, 11, RIVER.z - deckLen / 2 + 8 + k * ((deckLen - 16) / 11));
    root.add(m); lanterns.push(m);
  }

  // --- checkpoints and the light barriers (Sanctions Gate) ---
  const gates = {};
  const portcullis = {};
  const barrierGate = (name, pos, w, h, rotY) => {
    const g = named(new THREE.Group(), 'light-barrier');
    g.add(named(new THREE.Mesh(new THREE.PlaneGeometry(w, h), mats.barrier), 'light-barrier-sheet'));
    const edge = named(new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, 0.3), mats.led), 'light-barrier-edge'); edge.position.y = -h / 2; g.add(edge);
    g.rotation.y = rotY; g.position.set(pos.x, pos.y + h + 40, pos.z);
    g.userData = { up: pos.y + h + 40, down: pos.y + h / 2, goal: pos.y + h + 40, name };
    g.visible = false;
    root.add(g); portcullis[name] = g;
  };
  for (const name of ['north', 'east', 'west']) {
    const b = GATE_BEARINGS[name];
    gates[name] = { bearing: b, inside: at(b, PLAZA_R + 20, 60), mouth: at(b, 150, 75) };
    barrierGate(name, { ...at(b, 140), y: 50 }, 60, 50, -b);
  }
  gates.south = { bearing: Math.PI, inside: { x: 0, y: 14, z: 40 }, mouth: { x: 0, y: 10, z: gantryZ + 8 } };
  barrierGate('south', { x: 0, y: -4, z: RIVER.z }, RIVER.half * 2, 13, Math.PI / 2);

  // --- the harbour pier, its cargo scanner and moored boats ---
  const pierX = 205;
  const harbourGroup = named(new THREE.Group(), 'harbour-pier');
  const pierDeck = named(new THREE.Mesh(new THREE.BoxGeometry(14, 1.4, 44), mats.stone), 'pier-deck'); pierDeck.position.set(pierX, -0.6, RIVER.z - RIVER.half + 20); harbourGroup.add(pierDeck);
  const pierLights = named(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 44), mats.warmLamp), 'pier-lights'); pierLights.position.set(pierX + 7.2, 0.3, RIVER.z - RIVER.half + 20); harbourGroup.add(pierLights);
  const crane = named(new THREE.Group(), 'cargo-scanner');
  const craneMast = named(new THREE.Mesh(new THREE.BoxGeometry(0.9, 20, 0.9), mats.steel), 'cargo-scanner-mast'); craneMast.position.y = 10; crane.add(craneMast);
  const jib = named(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 26), mats.steel), 'cargo-scanner-arm'); jib.position.set(0, 20, 8); crane.add(jib);
  const counter = named(new THREE.Mesh(new THREE.BoxGeometry(2.4, 2, 3), mats.steelDark), 'cargo-scanner-counterweight'); counter.position.set(0, 19.5, -6); crane.add(counter);
  const scanHead = named(new THREE.Mesh(new THREE.BoxGeometry(2, 0.6, 2), mats.goldGlow), 'cargo-scanner-head'); scanHead.position.set(0, 19.2, 20); crane.add(scanHead);
  crane.position.set(pierX + 4, 0, RIVER.z - RIVER.half + 6);
  harbourGroup.add(crane);
  const xray = named(new THREE.Mesh(new THREE.PlaneGeometry(10, 18), new THREE.MeshBasicMaterial({ color: 0x9be7ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })), 'cargo-scanner-xray');
  xray.position.set(0, 10, 20); crane.add(xray);
  root.add(shadowed(harbourGroup));
  obstacles.push({ x: pierX + 4, z: RIVER.z - RIVER.half + 14, hw: 6, hd: 16, top: 22 });
  const harbourPoint = { x: pierX, y: -3, z: RIVER.z - RIVER.half + 48 };

  // --- street lights along the embankments ---
  const lampN = phone ? 90 : 220;
  const lampPoles = named(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.2, 8, 6), mats.steelDark, lampN), 'street-light-poles');
  const lampMat = new THREE.MeshBasicMaterial({ color: 0x6a6252 });
  const lampHeads = named(new THREE.InstancedMesh(new THREE.SphereGeometry(0.55, 8, 6), lampMat, lampN), 'street-lights');
  for (let i = 0; i < lampN; i++) {
    const side = i % 2 ? 1 : -1; const x = -1600 + Math.floor(i / 2) * (3200 / (lampN / 2));
    set(lampPoles, i, x, 4, RIVER.z + side * (RIVER.half + 3)); set(lampHeads, i, x, 8.2, RIVER.z + side * (RIVER.half + 3));
  }
  root.add(lampPoles); root.add(lampHeads);

  // --- rooftop beacons (reports and approvals) on the twelve tallest towers ---
  const beacons = [];
  for (const spot of tall.slice(0, 12)) {
    const fire = named(new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 10), new THREE.MeshStandardMaterial({ color: 0x2a1a10, emissive: 0xffb300, emissiveIntensity: 0, roughness: 1 })), 'rooftop-beacon');
    fire.position.set(spot.x - spot.w * 0.2, spot.y + 3, spot.z + spot.w * 0.2);
    root.add(fire);
    beacons.push({ fire, bearing: Math.atan2(spot.x, -spot.z), lit: 0, goal: 0 });
  }

  // --- two digital billboards: real PG1 numbers from the feed, and the emblem ---
  const billboards = [];
  for (const [nm, x, y, z, ry] of [['east', 230, 34, 40, Math.PI / 2], ['river', 120, 26, RIVER.z - RIVER.half - 26, Math.PI / 2]]) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 256;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const frame = named(new THREE.Group(), `billboard-${nm}`);
    const screen = named(new THREE.Mesh(new THREE.PlaneGeometry(24, 12), new THREE.MeshBasicMaterial({ map: tex })), 'billboard-screen');
    const back = named(new THREE.Mesh(new THREE.BoxGeometry(25, 13, 0.6), mats.steelDark), 'billboard-frame'); back.position.z = -0.4;
    const pole = named(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, y, 8), mats.steelDark), 'billboard-pole'); pole.position.y = -y / 2;
    frame.add(screen); frame.add(back); frame.add(pole);
    frame.position.set(x, y, z); frame.rotation.y = ry;
    root.add(frame);
    obstacles.push({ x, z, hw: 13, hd: 13, top: y + 7 });
    billboards.push({ cv, tex, text: [] });
  }
  const drawBillboards = (stats) => {
    const lines = billboardLines(stats || {});
    for (const b of billboards) {
      const g = b.cv.getContext('2d');
      g.fillStyle = '#05080d'; g.fillRect(0, 0, 512, 256);
      if (brand) g.drawImage(brandCanvas(brand, 200), 16, 28);
      g.fillStyle = '#f3c623'; g.font = '700 30px Inter, system-ui, sans-serif'; g.fillText('PG1 · real defence events', 228, 52);
      g.fillStyle = '#ffffff'; g.font = '600 26px Inter, system-ui, sans-serif';
      lines.forEach((l, i) => g.fillText(l, 228, 104 + i * 48));
      b.tex.needsUpdate = true; b.text = lines;
    }
  };
  drawBillboards({});

  // --- the Rate Shield: invisible until a gadget fires ---
  const domeUniforms = { uThick: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color(0x9fe6ff) }, uHit: { value: new THREE.Vector3(1, 0, 0) }, uHitT: { value: 99 } };
  const dome = named(new THREE.Mesh(new THREE.SphereGeometry(CITY_R * 0.62, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.ShaderMaterial({
    uniforms: domeUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: 'varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); vP = position; gl_Position = projectionMatrix*mv; }',
    fragmentShader: 'uniform float uThick; uniform float uTime; uniform vec3 uColor; uniform vec3 uHit; uniform float uHitT; varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.5); float hex = 0.5 + 0.5 * sin(vP.x * 0.25 + uTime * 0.6) * sin(vP.y * 0.25) * sin(vP.z * 0.25 - uTime * 0.4); float d = acos(clamp(dot(normalize(vP), normalize(uHit)), -1.0, 1.0)) * 260.0; float ring = exp(-pow(d - uHitT * 90.0, 2.0) / 900.0) * max(0.0, 1.0 - uHitT / 2.8); float a = uThick * 0.3 * (f * 0.8 + 0.2) * (0.75 + 0.25 * hex) + ring * 0.4 * (0.4 + f); gl_FragColor = vec4(uColor, a); }'
  })), 'rate-shield');
  dome.visible = false; dome.renderOrder = 5;
  root.add(dome);

  // --- the fog bank: where callers with no country come from ---
  const fogBearing = Math.PI * 1.62;
  const fogTex = (() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const fog = named(new THREE.Group(), 'fog-bank');
  for (let k = 0; k < (phone ? 8 : 18); k++) {
    const s = named(new THREE.Sprite(new THREE.SpriteMaterial({ map: fogTex, color: 0x8c96aa, transparent: true, opacity: 0.3, depthWrite: false })), 'fog-puff');
    const p = at(fogBearing + (k / 18 - 0.5) * 0.5, 700 + (k % 3) * 60, 40 + (k % 4) * 14);
    s.position.set(p.x, p.y, p.z); s.scale.setScalar(140 + (k % 5) * 30);
    fog.add(s);
  }
  root.add(fog);

  // --- light ---
  const hemi = new THREE.HemisphereLight(0x8fa6d6, 0x2a2420, 0.5);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffc890, 2.2);
  if (settings.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(settings.shadows, settings.shadows);
    const cam = sun.shadow.camera; cam.left = -420; cam.right = 420; cam.top = 420; cam.bottom = -420; cam.near = 10; cam.far = 2200;
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 1.2; sun.shadow.radius = 3;
  }
  scene.add(sun); scene.add(sun.target);

  // --- the sky: a dusk gradient (warm horizon to deep blue) with a sun glow ---
  const gradU = { uFog: { value: new THREE.Color(0x2a3550) }, uTop: { value: new THREE.Color(0x0e1a36) }, uMid: { value: new THREE.Color(0x3a4f86) }, uHorizon: { value: new THREE.Color(0xf09a5a) }, uSunDir: { value: new THREE.Vector3(-1, 0.05, 0) }, uGlow: { value: new THREE.Color(0xffc27a) } };
  const sky = named(new THREE.Mesh(new THREE.SphereGeometry(7000, 32, 16), new THREE.ShaderMaterial({
    uniforms: gradU, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position.z = gl_Position.w; }',
    fragmentShader: 'uniform vec3 uFog; uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uGlow; varying vec3 vD; void main(){ float h = clamp(vD.y, 0.0, 1.0); float s = max(dot(vD, normalize(uSunDir)), 0.0); vec3 hor = mix(uMid, uHorizon, pow(max(dot(normalize(vD.xz), normalize(uSunDir.xz)) * 0.5 + 0.5, 0.0), 2.5)); vec3 c = mix(hor, uMid, smoothstep(0.0, 0.18, h)); c = mix(c, uTop, smoothstep(0.15, 0.7, h)); c += uGlow * (pow(s, 12.0) * 0.35 + pow(s, 260.0) * 1.4) * (1.0 - h); c = mix(uFog, c, smoothstep(-0.01, 0.07, vD.y)); gl_FragColor = vec4(c, 1.0); }'
  })), 'sky');
  scene.add(sky);

  // --- clouds: layered, catching the sunset on the side towards the sun ---
  const cloudLayers = [];
  for (const [y, scale, speed] of (phone ? [[520, 520, 1]] : [[520, 520, 1], [780, 950, 0.6]])) {
    const cu = { uTime: { value: 0 }, uCover: { value: 0.32 }, uDark: { value: 0 }, uLight: { value: 1 }, uWarm: { value: new THREE.Color(0xff9a5a) }, uSunXZ: { value: new THREE.Vector2(-1, 0) }, uScale: { value: scale }, uSpeed: { value: speed } };
    const c = named(new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.ShaderMaterial({
      uniforms: cu, transparent: true, depthWrite: false, fog: false,
      vertexShader: 'varying vec2 vU; void main(){ vU = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `uniform float uTime; uniform float uCover; uniform float uDark; uniform float uLight; uniform vec3 uWarm; uniform vec2 uSunXZ; uniform float uScale; uniform float uSpeed; varying vec2 vU;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p){ float t = 0.0; float a = 0.5; for (int i = 0; i < 5; i++){ t += a*n(p); p *= 2.03; a *= 0.5; } return t; }
        void main(){ vec2 p = vU / uScale + vec2(uTime*0.004, uTime*0.0025) * uSpeed; float d = fbm(p); float c = smoothstep(1.0 - uCover, 1.0 - uCover + 0.3, d); float edge = 1.0 - smoothstep(2500.0, 4200.0, length(vU));
          vec2 w = vec2(vU.x, -vU.y); float toward = smoothstep(-0.2, 0.9, dot(normalize(w + 1e-3), normalize(uSunXZ)));
          vec3 lit = mix(vec3(0.26, 0.28, 0.38), uWarm, toward * (1.0 - uDark) * (0.5 + 0.5 * (1.0 - d)));
          vec3 col = mix(lit, vec3(0.13, 0.14, 0.17), uDark) * (0.3 + 0.7 * uLight); gl_FragColor = vec4(col, c * edge * 0.85); }`
    })), 'clouds');
    c.rotation.x = Math.PI / 2; c.position.y = y; c.renderOrder = 2;
    scene.add(c); cloudLayers.push(cu);
  }

  const tmp = new THREE.Vector3();
  const cool = new THREE.Color(0x9fb8ff);
  const env = { night: 0 };
  let emblemPulse = 0;
  let cloudLag = 0;
  return {
    root, gates, portcullis, vaultDoors, beacons, lanterns, forge: { group: forge, seal: sealMat }, harbour: { bearing: Math.atan2(harbourPoint.x, -harbourPoint.z), point: harbourPoint },
    tollBarrier: barrier, toll, dome: domeUniforms, domeMesh: dome, preflight, crane, xray, deckY: DECK_Y, tip: tip.position, roofSpots,
    fogBearing, keep, sun, hemi, sky, windows: facade.userData.windows, env, buildingCount: lots.length,
    obstacles: makeObstacleIndex(obstacles), mirror, brandTex, emblemY,
    emblemMeshes: emblems3d.map((e) => e.group),
    setBillboards(stats) { drawBillboards(stats); },
    // Windows follow the hour in Dublin (kingdom-data.js windowRatios).
    setWindowRatios({ office, home }) { facade.userData.windows.uOffice.value = office; facade.userData.windows.uHome.value = home; },
    // Wet roads after rain: smoother, so they mirror the lights.
    setWet(wet) { mats.asphalt.roughness = wet ? 0.28 : 0.95; mats.asphalt.metalness = wet ? 0.35 : 0; mats.asphalt.color.setHex(wet ? 0x1a1c20 : 0x24272c); },
    get billboardText() { return billboards[0] ? billboards[0].text : []; },
    // A gadget fired: the emblem pulses once in gold; on a high-severity
    // event it brightens and the shield's ripple starts from it.
    pulseEmblem(high = false) {
      emblemPulse = high ? 1.6 : 1;
      if (high) { const p = new THREE.Vector3(0, emblemY, radiusAt(emblemY)).normalize(); domeUniforms.uHit.value.copy(p); domeUniforms.uHitT.value = 0; }
    },
    get emblemPulse() { return emblemPulse; },
    // How far the clouds still are from the storm level they ease toward.
    get cloudLag() { return cloudLag; },
    state: null,
    setState(st) {
      this.state = st;
      sealMedal.visible = !!st.seal; if (st.seal) { sealMedal.material.color.setHex(sealColors[st.seal]); sealMedal.material.emissive.setHex(sealColors[st.seal]); }
      key.visible = !!st.passkeys;
      edSeal.visible = !!st.signing;
      for (const d of vaultDoors) d.visible = !!st.passkeys;
      const n = Math.min(beacons.length, st.approvals || 0);
      beacons.forEach((b, i) => { b.approval = i < n; if (!b.until) b.goal = b.approval ? 1 : 0; });
      return n;
    },
    update(dt, t, { sunDir, light, storm, dusk = 0, fogColor = null }) {
      if (fogColor) gradU.uFog.value.copy(fogColor);
      env.night = 1 - light;
      const mode = this.state ? this.state.beacon : 'unknown';
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
      beaconMat.color.setHex(mode === 'gold' ? 0xffd84d : mode === 'amber' ? 0xffb300 : mode === 'dim' ? 0x5a5f66 : 0xd8dde3);
      tipHalo.material.color.copy(beaconMat.color);
      tipHalo.material.opacity = mode === 'gold' ? 0.5 : mode === 'amber' ? 0.15 + 0.35 * pulse : mode === 'dim' ? 0.03 : 0.12;
      tmp.copy(sunDir);
      sun.position.copy(tmp).multiplyScalar(900); if (sun.position.y < 70) sun.position.y = 70;
      sun.target.position.set(0, 0, 0);
      const moon = 1 - light;
      sun.intensity = 2.3 * light * (1 - storm * 0.55) + 0.25 * moon;
      sun.color.setRGB(1, 0.6 + 0.32 * (1 - dusk) * light, 0.36 + 0.52 * (1 - dusk) * light).lerp(cool, moon * 0.8);
      hemi.intensity = 0.2 + 0.45 * light * (1 - storm * 0.4);
      gradU.uSunDir.value.copy(tmp);
      gradU.uTop.value.setRGB(0.04 + 0.16 * light * (1 - dusk), 0.07 + 0.3 * light * (1 - dusk), 0.17 + 0.55 * light * (1 - dusk)).multiplyScalar(1 - storm * 0.5);
      gradU.uMid.value.setRGB(0.18 + 0.4 * light * (1 - dusk), 0.25 + 0.45 * light * (1 - dusk), 0.45 + 0.4 * light * (1 - dusk)).multiplyScalar(1 - storm * 0.45);
      gradU.uHorizon.value.setRGB(0.95, 0.55 + 0.35 * (1 - dusk), 0.32 + 0.55 * (1 - dusk)).multiplyScalar((0.25 + 0.75 * light) * (1 - storm * 0.5));
      gradU.uGlow.value.setRGB(1, 0.7, 0.4).multiplyScalar(Math.max(0.08, dusk) * (1 - storm));
      if (riverMat.uniforms) {
        riverMat.uniforms.uTime.value = t;
        riverMat.uniforms.uSunDir.value.copy(tmp);
        riverMat.uniforms.uSunColor.value.setRGB(1, 0.7, 0.45).multiplyScalar(Math.max(0.1, light) * (1 - storm * 0.6));
        riverMat.uniforms.uZenith.value.copy(gradU.uMid.value);
        riverMat.uniforms.uHorizon.value.copy(gradU.uHorizon.value);
      }
      cloudLag = 0;
      for (const cu of cloudLayers) {
        cu.uTime.value = t;
        cu.uCover.value += ((0.3 + storm * 0.5) - cu.uCover.value) * Math.min(1, dt * 0.3);
        cu.uDark.value += (storm - cu.uDark.value) * Math.min(1, dt * 0.3);
        cloudLag = Math.max(cloudLag, Math.abs((0.3 + storm * 0.5) - cu.uCover.value), Math.abs(storm - cu.uDark.value));
        cu.uLight.value = 0.2 + 0.8 * Math.max(light, dusk * 0.8);
        cu.uSunXZ.value.set(tmp.x, tmp.z);
        cu.uWarm.value.setRGB(1, 0.55 + 0.4 * (1 - dusk), 0.35 + 0.6 * (1 - dusk));
      }
      facade.userData.windows.uNight.value = 0.15 + 1.6 * Math.max(dusk * 0.8, moon);
      facade.userData.windows.uTime.value = t;
      lampMat.color.setHex(moon > 0.3 || dusk > 0.5 ? 0xffd9a0 : 0x6a6252);
      streakMat.opacity = 0.25 + 0.7 * Math.max(dusk, moon);
      // Streaks shimmer with the ripples.
      for (let i = 0; i < streakSeeds.length; i++) { const s = streakSeeds[i]; const w = 1 + 0.35 * Math.sin(t * 2.2 + s.ph); set(streaks, i, s.x + Math.sin(t * 0.8 + s.ph) * 0.6, -3.0, RIVER.z + s.side * (RIVER.half - s.len / 2 - 1), w * 1.2, s.len, 1, 0, -Math.PI / 2); }
      streaks.instanceMatrix.needsUpdate = true;
      // Rooftop lights blink, warm (red is the enemy's).
      mats.aircraft.color.setHex((t % 1.6) < 0.2 ? 0xffd9a0 : 0x6a5434);
      domeUniforms.uTime.value = t;
      domeUniforms.uHitT.value += dt;
      dome.visible = domeUniforms.uHitT.value < 2.8 || domeUniforms.uThick.value > 0.03;
      if (this.flashUntil && t < this.flashUntil) { beaconMat.color.setHex(this.flashColor); tipHalo.material.opacity = 0.5; }
      for (const p of preflight) { if (p.until && performance.now() > p.until) { p.until = 0; p.mat.color.setHex(0x3a3f46); } }
      xray.material.opacity = Math.max(0, xray.material.opacity - dt * 0.4);
      for (const pc of Object.values(portcullis)) { pc.position.y += (pc.userData.goal - pc.position.y) * Math.min(1, dt * (pc.userData.goal === pc.userData.down ? 6 : 1.2)); pc.visible = pc.position.y < pc.userData.up - 0.5; }
      for (const d of vaultDoors) { const ax = d.userData.axis || 'y'; d.position[ax] += (d.userData.goal - d.position[ax]) * Math.min(1, dt * (d.userData.goal === d.userData.down ? 8 : 1.2)); }
      for (const b of beacons) { b.lit += (b.goal - b.lit) * Math.min(1, dt * 1.5); b.fire.material.emissiveIntensity = b.lit * (2.6 + 0.25 * Math.sin(t * 5 + b.bearing * 3)); }
      sealMat.emissiveIntensity += (0.25 - sealMat.emissiveIntensity) * Math.min(1, dt * 1.2);
      // The emblem: its gold edge glows at dusk and night; a pulse when a gadget fires.
      emblemPulse = Math.max(0, emblemPulse - dt * 0.9);
      const dark = Math.max(dusk, moon);
      for (const e of emblems3d) { e.gold.emissiveIntensity = 0.12 + 0.35 * dark + 1.4 * emblemPulse; e.edge.opacity = Math.min(1, 0.35 + 0.65 * dark + emblemPulse); }
      if (hologram) { hologram.uniforms.uTime.value = t; hologram.uniforms.uAlpha.value = Math.max(0, moon - 0.35) * 1.4 + emblemPulse * 0.3; hologram.mesh.rotation.y = t * 0.15; hologram.mesh.visible = hologram.uniforms.uAlpha.value > 0.01; }
      if (emblemGlow) emblemGlow.material.opacity = 0.12 + 0.3 * dark + 0.4 * emblemPulse;
      if (inlay) inlay.material.opacity = 0.55 + 0.4 * dark;
    }
  };
}
