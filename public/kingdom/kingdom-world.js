// PG1 Kingdom Defence: the kingdom itself, a modern island city built in
// code (no downloaded models or textures): PG1's Command Centre (a tapering
// glass spire on a podium, with the shield), a ring of glass towers whose
// windows light up at dusk, the concrete perimeter with light strips,
// sensor towers with turning radars, four security gates with blast doors,
// the channel with arched bridges, the port with its cranes and
// containers, the roads, four beacon masts, the sea, the sky, the sun over
// Dublin and the weather. Everything that moves lives in kingdom-actors.js.
// (Internal names keep the kingdom words: "keep" is the HQ, "portcullis" a
// blast door, "moat" the channel.)
//
// Coordinates: metres; north is -z, east is +x. The keep is at the origin.
//
//   buildWorld(THREE, scene, settings, { normals, waterMaterial, Sky })
//     -> { gates, harbour, bridgeSouth, keepDoor, forge, beacons, towers,
//          portcullis, vaultDoors, dome, lantern slots, update(dt, t, env) }

export const ISLAND_R = 132;
export const WALL_R = 56;
export const MOAT_IN = 61;
export const MOAT_OUT = 70;
export const SHORE_R = 120;
export const GATE_BEARINGS = Object.freeze({ north: 0, east: Math.PI / 2, south: Math.PI, west: Math.PI * 1.5 });

export const at = (bearing, r, y = 0) => ({ x: Math.sin(bearing) * r, y, z: -Math.cos(bearing) * r });

const CONCRETE = 0xc4c2bc;
const CONCRETE_DARK = 0x6e7177;
const GOLD = 0xf3c623;

// PG1's shield with the "1" (public/brand/pg1-shield.svg), as a shape.
export function shieldShape(THREE) {
  const s = 1 / 100;
  const P = (x, y) => [(x - 221.76) * s, (50 - y) * s];
  const shape = new THREE.Shape();
  shape.moveTo(...P(221.76, 0)); shape.lineTo(...P(262.5, 15.2)); shape.lineTo(...P(262.5, 47.3));
  shape.bezierCurveTo(...P(262.5, 73.9), ...P(245.1, 91.85), ...P(221.76, 100));
  shape.bezierCurveTo(...P(198.4, 91.85), ...P(181, 73.9), ...P(181, 47.3));
  shape.lineTo(...P(181, 15.2)); shape.closePath();
  const one = new THREE.Path();
  one.moveTo(...P(220, 20)); one.lineTo(...P(233, 20)); one.lineTo(...P(233, 72)); one.lineTo(...P(220, 72));
  one.lineTo(...P(220, 37.5)); one.lineTo(...P(208.5, 43.5)); one.lineTo(...P(208.5, 31)); one.closePath();
  shape.holes.push(one);
  return shape;
}

// The island's height at a distance from the centre: a plateau for the
// citadel, a dip for the moat, meadows, then a beach into the sea.
export function islandHeight(r, n = 0) {
  if (r < MOAT_IN - 1) return 2.2;
  if (r < MOAT_OUT + 1) return -1.5;
  if (r < SHORE_R - 18) return 2.2 + n * 1.4 + Math.max(0, (r - 80) / 40) * 0.8;
  if (r < ISLAND_R) { const t = (r - (SHORE_R - 18)) / (ISLAND_R - SHORE_R + 18); return (3 + n) * (1 - t) - 1.2 * t; }
  return -3;
}

function noise2(x, z) {
  return Math.sin(x * 0.11 + Math.cos(z * 0.07) * 2) * 0.5 + Math.sin(z * 0.13 + x * 0.05) * 0.35 + Math.sin((x + z) * 0.31) * 0.15;
}

function std(THREE, color, { rough = 0.85, metal = 0, emissive = 0, emissiveIntensity = 1, flat = false, vertexColors = false } = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive, emissiveIntensity, flatShading: flat, vertexColors });
}

// Stone with a little per-vertex variation (no texture download): blocks
// read as blocks from close up, and the base of every wall is darker
// (baked ambient occlusion, which is all the Phone tier gets).
function stoneGeometry(THREE, geo, { aoBase = 0, height = 1 } = {}) {
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
    const v = 0.88 + 0.12 * Math.sin(Math.floor(y * 1.6) * 7.1 + Math.floor((x + z) * 0.9) * 3.3);
    const ao = aoBase ? 1 - aoBase * Math.max(0, 1 - (y + height / 2) / (height * 0.5)) : 1;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v * ao;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// Lit windows (no download): a grid of panes, some warm and lit, drawn once
// into a canvas and used as the glass towers' emissive map; how bright it
// is follows the real dusk and night over Dublin.
function windowTexture(THREE) {
  const mk = () => { const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128; return cv; };
  const albedo = mk(); const lit = mk();
  const ga = albedo.getContext('2d'); const gl = lit.getContext('2d');
  ga.fillStyle = '#2c3540'; ga.fillRect(0, 0, 64, 128);
  gl.fillStyle = '#000'; gl.fillRect(0, 0, 64, 128);
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) {
    const sky = 150 + Math.round(rnd() * 50);
    ga.fillStyle = `rgb(${sky - 40},${sky - 10},${sky + 25})`;
    ga.fillRect(x * 8 + 1, y * 8 + 1, 7, 6);
    if (rnd() < 0.42) { gl.fillStyle = `rgb(255,${200 + Math.round(rnd() * 40)},${140 + Math.round(rnd() * 60)})`; gl.fillRect(x * 8 + 1, y * 8 + 1, 7, 6); }
  }
  const tex = (cv) => { const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  return { albedo: tex(albedo), lit: tex(lit) };
}

// Scale a geometry's texture coordinates so window panes keep their size.
function litUv(geo, u, v) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  return geo;
}

function shadowed(o, cast = true, receive = true) {
  o.traverse((m) => { if (m.isMesh) { m.castShadow = cast; m.receiveShadow = receive; } });
  return o;
}

// One sensor tower: a slim concrete shaft, a glazed observation ring with
// lit windows, an LED band, a flat cap and, on the tall ones, a turning
// radar and an antenna mast.
function tower(THREE, mats, r, h, { radar = true, radars = null } = {}) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(stoneGeometry(THREE, new THREE.CylinderGeometry(r * 0.8, r, h, 20, 4), { aoBase: 0.3, height: h }), mats.stone);
  body.position.y = h / 2;
  g.add(body);
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.25, r * 1.1, 2.4, 24), mats.glass);
  deck.position.y = h + 1.2;
  g.add(deck);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.27, r * 1.27, 0.18, 24, 1, true), mats.led);
  band.position.y = h + 0.1;
  g.add(band);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.3, r * 1.3, 0.4, 24), mats.steelDark);
  cap.position.y = h + 2.6;
  g.add(cap);
  if (radar) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 4, 6), mats.steel);
    mast.position.set(r * 0.6, h + 4.8, 0);
    g.add(mast);
    const dish = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(r * 1.6, 0.9, 0.12), mats.steel);
    plate.position.set(0, 0.6, 0.3);
    dish.add(plate);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 6), mats.steelDark);
    dish.add(post);
    dish.position.set(-r * 0.2, h + 3.2, 0);
    g.add(dish);
    if (radars) radars.push(dish);
  }
  return shadowed(g);
}

export function buildWorld(THREE, scene, settings, { normals = null, waterMaterial = null, Sky = null } = {}) {
  const mats = {
    stone: std(THREE, CONCRETE, { rough: 0.88, vertexColors: true }),
    stoneDark: std(THREE, CONCRETE_DARK, { rough: 0.8 }),
    steel: std(THREE, 0x9aa1aa, { rough: 0.32, metal: 0.85 }),
    steelDark: std(THREE, 0x2b2f36, { rough: 0.4, metal: 0.7 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x1c3a58, roughness: 0.06, metalness: 0.9, emissive: 0x0b2236, emissiveIntensity: 0.6 }),
    led: new THREE.MeshBasicMaterial({ color: 0x6fd8ff }),
    gold: std(THREE, GOLD, { rough: 0.3, metal: 0.9, emissive: GOLD, emissiveIntensity: 0.35 }),
    path: std(THREE, 0x34373c, { rough: 0.9 })
  };
  // Glass: by day the panes carry the sky's blue (and, from Balanced up,
  // reflect the sky's light); after dusk the lit ones glow.
  const winTex = windowTexture(THREE);
  const reflective = settings.tier !== 'phone';
  mats.windows = new THREE.MeshStandardMaterial({ color: 0xffffff, map: winTex.albedo, roughness: reflective ? 0.12 : 0.35, metalness: reflective ? 0.55 : 0.1, emissive: 0xffe2b0, emissiveMap: winTex.lit, emissiveIntensity: 0, side: THREE.DoubleSide });
  if (!reflective) { mats.glass.metalness = 0.15; mats.glass.roughness = 0.3; mats.glass.color.set(0x4d6f8f); mats.steel.metalness = 0.3; mats.steelDark.metalness = 0.2; }
  const radars = [];
  const root = new THREE.Group();
  root.name = 'kingdom';
  scene.add(root);

  // --- the island ---
  const segs = settings.tier === 'phone' ? 72 : 128;
  // Rings, so the channel and the beach have vertices of their own.
  const ring = new THREE.RingGeometry(0.01, ISLAND_R + 30, segs, settings.tier === 'phone' ? 40 : 80);
  ring.rotateX(-Math.PI / 2);
  const pos = ring.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const grass = new THREE.Color(0x4f7d3a); const meadow = new THREE.Color(0x6b9844); const sand = new THREE.Color(0xd8cfae); const rock = new THREE.Color(0x5d6066); const paving = new THREE.Color(0x8b8f95);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i); const z = pos.getZ(i); const r = Math.hypot(x, z);
    const n = noise2(x, z);
    pos.setY(i, islandHeight(r, n));
    // The plaza: large pale slabs on a grid.
    if (r < MOAT_IN - 1) c.copy(paving).multiplyScalar((Math.abs(x % 8) < 0.25 || Math.abs(z % 8) < 0.25) ? 0.8 : 1);
    else if (r < MOAT_OUT + 1) c.copy(rock);
    else if (r < SHORE_R - 14) c.copy(grass).lerp(meadow, 0.5 + n * 0.5);
    else c.copy(meadow).lerp(sand, Math.min(1, (r - (SHORE_R - 14)) / 12));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  ring.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  ring.computeVertexNormals();
  const island = new THREE.Mesh(ring, std(THREE, 0xffffff, { rough: 0.95, vertexColors: true }));
  island.receiveShadow = true;
  root.add(island);

  // --- the sea and the channel round the perimeter ---
  const seaMat = waterMaterial || new THREE.MeshStandardMaterial({ color: 0x1d5470, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.92 });
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000, 1, 1), seaMat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = 0;
  root.add(sea);
  const moatMat = waterMaterial ? waterMaterial.clone() : seaMat;
  if (waterMaterial) { moatMat.uniforms.uNormals.value = normals; moatMat.uniforms.uIslandCount.value = 0; moatMat.uniforms.uFoam.value = 0; }
  const moat = new THREE.Mesh(new THREE.RingGeometry(MOAT_IN - 0.5, MOAT_OUT + 0.5, segs), moatMat);
  moat.rotation.x = -Math.PI / 2;
  moat.position.y = 0.35;
  root.add(moat);

  // --- the perimeter: eight concrete wall sections with a light strip,
  // eight sensor towers, four security gates with blast doors ---
  const towers = [];
  const gates = {};
  const portcullis = {};
  const wallH = 8;
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const p = at(a0, WALL_R);
    const t = tower(THREE, mats, 2.6, wallH + 8, { radars });
    t.position.set(p.x, 2.2, p.z);
    root.add(t);
    towers.push(t);
  }
  const segLen = 2 * WALL_R * Math.sin(Math.PI / 8);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const p = at(a, WALL_R * Math.cos(Math.PI / 8));
    const isGate = i % 2 === 0;
    const g = new THREE.Group();
    g.position.set(p.x, 2.2, p.z);
    g.rotation.y = -a;
    const len = isGate ? (segLen - 9) / 2 : segLen;
    const offs = isGate ? [-(len / 2 + 4.5), len / 2 + 4.5] : [0];
    for (const o of offs) {
      const w = new THREE.Mesh(stoneGeometry(THREE, new THREE.BoxGeometry(len, wallH, 2.4, Math.ceil(len / 4), 2, 1), { aoBase: 0.35, height: wallH }), mats.stone);
      w.position.set(o, wallH / 2, 0);
      g.add(w);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(len, 0.16, 0.1), mats.led);
      strip.position.set(o, wallH - 0.6, -1.25);
      g.add(strip);
      const coping = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, 2.8), mats.steelDark);
      coping.position.set(o, wallH + 0.15, 0);
      g.add(coping);
    }
    if (isGate) {
      const name = ['north', 'east', 'south', 'west'][i / 2];
      // The security gate: two pylons, a steel beam and the blast door (the Sanctions Gate).
      for (const s of [-1, 1]) {
        const py = new THREE.Mesh(new THREE.BoxGeometry(2.6, wallH + 3, 3.4), mats.stoneDark); py.position.set(s * 4.4, (wallH + 3) / 2, 0); g.add(py);
        const lit = new THREE.Mesh(new THREE.BoxGeometry(0.14, wallH + 1, 0.1), mats.led); lit.position.set(s * 3.1, (wallH + 3) / 2, -1.72); g.add(lit);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(6.2, 1.2, 3), mats.steelDark);
      beam.position.set(0, wallH + 1.6, 0);
      g.add(beam);
      const pc = new THREE.Group();
      const slab = new THREE.Mesh(new THREE.BoxGeometry(6, 7.4, 0.5), mats.steel); pc.add(slab);
      const warn = new THREE.Mesh(new THREE.BoxGeometry(6, 0.4, 0.54), new THREE.MeshBasicMaterial({ color: 0xff5c5c })); warn.position.y = -3.4; pc.add(warn);
      pc.position.set(0, wallH + 5.4, -1.9);
      pc.userData = { up: wallH + 5.4, down: 3.7, goal: wallH + 5.4 };
      g.add(pc);
      portcullis[name] = pc;
      gates[name] = { bearing: a, inside: at(a, WALL_R - 6, 2.2), mouth: at(a, MOAT_OUT + 3, 2.2), bridge: at(a, (MOAT_IN + MOAT_OUT) / 2, 2.6) };
      // The bridge over the channel: a concrete deck with glass rails.
      const bridge = new THREE.Group();
      const deck = new THREE.Mesh(new THREE.BoxGeometry(6, 0.8, MOAT_OUT - MOAT_IN + 6), mats.stoneDark); bridge.add(deck);
      for (const s of [-1, 1]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, MOAT_OUT - MOAT_IN + 6), mats.glass); rail.position.set(s * 2.9, 0.95, 0); bridge.add(rail); }
      const arch = new THREE.Mesh(new THREE.TorusGeometry((MOAT_OUT - MOAT_IN) / 2 + 1.5, 0.35, 8, 24, Math.PI), mats.steelDark);
      arch.rotation.y = Math.PI / 2; arch.position.y = -2.4; arch.scale.set(1, 0.55, 1);
      for (const sx of [-2.6, 2.6]) { const a2 = arch.clone(); a2.position.x = sx; bridge.add(a2); }
      const bp = at(a, (MOAT_IN + MOAT_OUT) / 2);
      bridge.position.set(bp.x, 2.2, bp.z);
      bridge.rotation.y = -a;
      root.add(shadowed(bridge));
    }
    root.add(shadowed(g));
  }

  // --- roads: from each gate out to the shore (the MCP traffic's way in) ---
  for (const name of Object.keys(gates)) {
    const a = gates[name].bearing;
    const len = SHORE_R - MOAT_OUT - 4;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(6, len), mats.path);
    const mid = at(a, MOAT_OUT + 3 + len / 2);
    road.rotation.x = -Math.PI / 2;
    road.rotation.z = -a;
    road.position.set(mid.x, islandHeight(MOAT_OUT + 10) + 0.9, mid.z);
    road.receiveShadow = true;
    root.add(road);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.2, len), new THREE.MeshBasicMaterial({ color: 0xe8e2c8 }));
    line.rotation.copy(road.rotation);
    line.position.set(mid.x, road.position.y + 0.02, mid.z);
    root.add(line);
  }

  // --- the toll on the south bridge (x402): a glass booth, a boom barrier, light bollards ---
  const south = gates.south;
  const toll = new THREE.Group();
  const booth = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.8, 2.4), mats.glass); booth.position.set(-4.6, 1.4, 0); toll.add(booth);
  const boothRoof = new THREE.Mesh(new THREE.BoxGeometry(3, 0.25, 3), mats.steelDark); boothRoof.position.set(-4.6, 2.95, 0); toll.add(boothRoof);
  const barrier = new THREE.Mesh(new THREE.BoxGeometry(6, 0.22, 0.22), std(THREE, 0xe8473a, { emissive: 0x501010 })); barrier.position.set(-0.4, 1.4, 0); toll.add(barrier);
  toll.position.set(south.mouth.x, 2.2, south.mouth.z + 2);
  root.add(shadowed(toll));
  const lanterns = [];
  const lanternGeo = new THREE.CylinderGeometry(0.16, 0.16, 1.1, 10);
  for (let k = 0; k < 12; k++) {
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(lanternGeo, new THREE.MeshStandardMaterial({ color: 0x22262c, emissive: GOLD, emissiveIntensity: 0, roughness: 0.4, metalness: 0.6 }));
      const p = at(Math.PI, MOAT_IN - 2 + k * ((MOAT_OUT - MOAT_IN + 8) / 11));
      m.position.set(p.x + s * 3.4, 3.15, p.z);
      root.add(m);
      lanterns.push(m);
    }
  }

  // --- the Command Centre: PG1's glass headquarters, with the shield,
  // the vault and a rooftop deck for the commander ---
  const keep = new THREE.Group();
  const podium = new THREE.Mesh(stoneGeometry(THREE, new THREE.BoxGeometry(24, 7, 24, 6, 2, 6), { aoBase: 0.3, height: 7 }), mats.stone);
  podium.position.y = 3.5;
  keep.add(podium);
  // The spire: a tapering six-sided glass tower with lit floors and a split
  // crown, PG1's own shape (not any real building).
  const spireGeo = litUv(new THREE.CylinderGeometry(1.6, 11.5, 92, 6, 1, true), 14, 30);
  const spire = new THREE.Mesh(spireGeo, mats.windows);
  spire.position.y = 7 + 46;
  spire.rotation.y = Math.PI / 6;
  keep.add(spire);
  for (const s of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 16, 2.2), mats.glass);
    fin.position.set(s * 1.1, 7 + 99, 0); fin.rotation.z = s * 0.06;
    keep.add(fin);
  }
  const crown = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.12, 8, 30), mats.led); crown.rotation.x = Math.PI / 2; crown.position.y = 7 + 92; keep.add(crown);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff4d4d })); tip.position.y = 7 + 108; keep.add(tip);
  const pad = new THREE.Mesh(new THREE.RingGeometry(2.6, 2.9, 40), mats.led); pad.rotation.x = -Math.PI / 2; pad.position.set(-8, 7.05, 8); keep.add(pad);
  const shield = new THREE.Mesh(new THREE.ExtrudeGeometry(shieldShape(THREE), { depth: 0.4, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08, bevelSegments: 2 }), mats.gold);
  shield.scale.setScalar(5.2);
  shield.position.set(0, 3.6, 12.1);
  keep.add(shield);
  const shieldE = shield.clone(); shieldE.rotation.y = Math.PI / 2; shieldE.position.set(12.1, 3.6, 5.5); keep.add(shieldE);
  // The vault (Passkey Vault): a steel door in the podium's east face, and
  // the blast shutter that slides out in front of it on a lockout.
  const vaultDoors = [];
  for (let k = 0; k < 2; k++) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.5, 5.5, 4.4), k ? mats.steelDark : mats.steel);
    d.position.set(k ? 10.6 : 12.05, 2.75, 0);
    d.userData = k ? { axis: 'x', up: 10.6, down: 12.6, goal: 10.6 } : { up: 2.75, down: 2.75, goal: 2.75 };
    keep.add(d);
    vaultDoors.push(d);
  }
  keep.position.y = 2.2;
  root.add(shadowed(keep));

  // --- the city inside the perimeter: glass towers of many heights, lit at night ---
  const city = new THREE.Group();
  const nTowers = settings.tier === 'phone' ? 12 : 22;
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const clear = [[-20, 18, 6], [18, 20, 7], [0, 0, 17]];
  for (let k = 0, tries = 0; k < nTowers && tries < 400; tries++) {
    const ang = rnd() * Math.PI * 2; const r = 22 + rnd() * 24;
    // Keep the four gate avenues and the plaza open.
    if (Object.values(GATE_BEARINGS).some((b) => Math.abs(((ang - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.2)) continue;
    const x = Math.sin(ang) * r; const z = -Math.cos(ang) * r;
    if (clear.some(([cx, cz, cr]) => Math.hypot(x - cx, z - cz) < cr + 5)) continue;
    const w = 5 + rnd() * 4; const d = 5 + rnd() * 4; const h = 14 + rnd() * (r < 34 ? 46 : 26);
    const round = rnd() < 0.3;
    const geo = round ? litUv(new THREE.CylinderGeometry(w * 0.55, w * 0.62, h, 18, 1), 9, h / 4) : litUv(new THREE.BoxGeometry(w, h, d), 1, 1);
    if (!round) { const uv = geo.attributes.uv; const nrm = geo.attributes.normal; for (let i = 0; i < uv.count; i++) { const side = Math.abs(nrm.getX(i)) > 0.5 ? d : w; if (Math.abs(nrm.getY(i)) > 0.5) uv.setXY(i, 0, 0); else uv.setXY(i, uv.getX(i) * side / 4, uv.getY(i) * h / 4); } }
    const t = new THREE.Mesh(geo, mats.windows);
    t.position.set(x, 2.2 + h / 2, z);
    t.rotation.y = rnd() * Math.PI;
    city.add(t);
    const capm = new THREE.Mesh(round ? new THREE.CylinderGeometry(w * 0.56, w * 0.56, 0.4, 18) : new THREE.BoxGeometry(w + 0.2, 0.4, d + 0.2), mats.steelDark);
    capm.position.set(x, 2.2 + h + 0.2, z); capm.rotation.y = t.rotation.y;
    city.add(capm);
    if (rnd() < 0.4) { const light = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff4d4d })); light.position.set(x, 2.2 + h + 1, z); city.add(light); }
    k++;
  }
  root.add(shadowed(city));

  // --- the plaza: the operations table and the Seal Forge (a signing pedestal) ---
  const forge = new THREE.Group();
  const anvil = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 1.2, 16), mats.steelDark); anvil.position.y = 0.6; forge.add(anvil);
  const sealMat = new THREE.MeshStandardMaterial({ color: 0x1b2b3a, emissive: 0x7cc4ff, emissiveIntensity: 0.2, roughness: 0.3, metalness: 0.6 });
  const seal = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.12, 10, 48), sealMat); seal.rotation.x = -Math.PI / 2; seal.position.y = 1.6; forge.add(seal);
  forge.position.set(-20, 2.2, 18);
  root.add(shadowed(forge));
  const table = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 0.3, 32), mats.steelDark); top.position.y = 1.1; table.add(top);
  const map = new THREE.Mesh(new THREE.CircleGeometry(3.7, 40), new THREE.MeshStandardMaterial({ color: 0x0c1a24, emissive: 0x6fd8ff, emissiveIntensity: 0.25 })); map.rotation.x = -Math.PI / 2; map.position.y = 1.27; table.add(map);
  table.position.set(18, 2.2, 20);
  root.add(shadowed(table));

  // --- the port (A2A agents and allies arrive here), south-east ---
  const harbourBearing = Math.PI * 0.78;
  const hp = at(harbourBearing, ISLAND_R - 4);
  const harbour = new THREE.Group();
  for (let k = 0; k < 3; k++) { const pier = new THREE.Mesh(new THREE.BoxGeometry(4, 0.8, 28), mats.stoneDark); pier.position.set(-9 + k * 9, 0.9, 10); harbour.add(pier); }
  const crane = new THREE.Group();
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.6, 16, 0.6), std(THREE, 0xe0a030, { rough: 0.5, metal: 0.4 })); leg.position.y = 8; crane.add(leg);
  const jib = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 18), std(THREE, 0xe0a030, { rough: 0.5, metal: 0.4 })); jib.position.set(0, 16, 5); crane.add(jib);
  crane.position.set(9, 1, 2);
  harbour.add(crane);
  harbour.position.set(hp.x, 0, hp.z);
  harbour.rotation.y = -harbourBearing + Math.PI;
  root.add(shadowed(harbour));
  const crates = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 2.6, 6), std(THREE, 0xffffff, { rough: 0.6, metal: 0.3 }), 16);
  const dummy = new THREE.Object3D();
  for (let k = 0; k < 16; k++) { const p = at(harbourBearing + (k % 4 - 1.5) * 0.04, ISLAND_R - 20 - Math.floor(k / 4) * 1.6); dummy.position.set(p.x, islandHeight(ISLAND_R - 20) + 1.3 + (k % 3 === 0 ? 2.6 : 0), p.z); dummy.rotation.y = -harbourBearing; dummy.updateMatrix(); crates.setMatrixAt(k, dummy.matrix); crates.setColorAt(k, new THREE.Color([0x2f6db5, 0xc0392b, 0x2e8b57, 0xe0a030][k % 4])); }
  crates.castShadow = true;
  root.add(crates);

  // --- four watchtowers at the edge, each with a beacon ---
  const beacons = [];
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const p = at(a, SHORE_R - 22);
    const t = tower(THREE, mats, 2.4, 18, { radars });
    t.position.set(p.x, islandHeight(SHORE_R - 22), p.z);
    root.add(t);
    const fire = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 10), new THREE.MeshStandardMaterial({ color: 0x2a1a10, emissive: 0xffa53a, emissiveIntensity: 0, roughness: 1 }));
    fire.position.set(p.x, t.position.y + 22.4, p.z);
    root.add(fire);
    beacons.push({ fire, bearing: a, lit: 0, goal: 0 });
  }

  // --- reserved: decoy towers (honeypot) and ramparts (firewall), idle and dim ---
  const reserved = new THREE.Group();
  for (const a of [Math.PI * 1.15, Math.PI * 1.85]) { const t = tower(THREE, { ...mats, stone: std(THREE, 0x55555c, { vertexColors: true }) }, 1.8, 9); const p = at(a, SHORE_R - 8); t.position.set(p.x, islandHeight(SHORE_R - 8), p.z); reserved.add(t); }
  reserved.visible = true;
  root.add(reserved);

  // --- the Rate Shield: a dome over the citadel, thicker under floods ---
  const domeUniforms = { uThick: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color(0x5ab0ff) } };
  const dome = new THREE.Mesh(new THREE.SphereGeometry(WALL_R + 12, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.ShaderMaterial({
    uniforms: domeUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: 'varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); vP = position; gl_Position = projectionMatrix*mv; }',
    fragmentShader: 'uniform float uThick; uniform float uTime; uniform vec3 uColor; varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.5); float hex = 0.5 + 0.5 * sin(vP.x * 0.9 + uTime * 0.6) * sin(vP.y * 0.9) * sin(vP.z * 0.9 - uTime * 0.4); float a = (0.025 + uThick * 0.35) * (f * 0.8 + 0.2) * (0.75 + 0.25 * hex); gl_FragColor = vec4(uColor, a); }'
  }));
  dome.position.y = 2.2;
  dome.renderOrder = 5;
  root.add(dome);

  // --- the fog bank (Fog Wall): where callers with no country come from ---
  const fogBearing = Math.PI * 1.62;
  const fogTex = (() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const fog = new THREE.Group();
  const puffs = settings.tier === 'phone' ? 10 : 22;
  for (let k = 0; k < puffs; k++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: fogTex, color: 0xc8ccd4, transparent: true, opacity: 0.45, depthWrite: false }));
    const p = at(fogBearing + (k / puffs - 0.5) * 0.7, ISLAND_R + 20 + (k % 3) * 14, 6 + (k % 4) * 2);
    s.position.set(p.x, p.y, p.z);
    s.scale.setScalar(26 + (k % 5) * 6);
    fog.add(s);
  }
  root.add(fog);

  // --- light: the sun (over Dublin), the sky light, and the torches at night ---
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x3a4a2a, 0.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(120, 200, 80);
  if (settings.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(settings.shadows, settings.shadows);
    const cam = sun.shadow.camera; cam.left = -150; cam.right = 150; cam.top = 150; cam.bottom = -150; cam.near = 10; cam.far = 600;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
  }
  scene.add(sun);
  scene.add(sun.target);
  const torchGeo = new THREE.SphereGeometry(0.35, 8, 6);
  const torchMat = new THREE.MeshStandardMaterial({ color: 0x15181c, emissive: 0xcfe8ff, emissiveIntensity: 0 });
  const torches = new THREE.InstancedMesh(torchGeo, torchMat, 16);
  for (let k = 0; k < 16; k++) { const p = at((k / 16) * Math.PI * 2, WALL_R + 1.8, 2.2 + wallH - 1.5); dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); torches.setMatrixAt(k, dummy.matrix); }
  root.add(torches);

  // --- the sky ---
  let sky = null;
  let skyUniforms = null;
  if (Sky && settings.sky === 'physical') {
    sky = new Sky();
    sky.scale.setScalar(4500);
    skyUniforms = sky.material.uniforms;
    skyUniforms.turbidity.value = 4; skyUniforms.rayleigh.value = 1.4; skyUniforms.mieCoefficient.value = 0.004; skyUniforms.mieDirectionalG.value = 0.8;
    scene.add(sky);
  } else {
    const gradU = { uTop: { value: new THREE.Color(0x2a6fd6) }, uHorizon: { value: new THREE.Color(0xbcd9f2) } };
    sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 24, 12), new THREE.ShaderMaterial({
      uniforms: gradU, side: THREE.BackSide, depthWrite: false,
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position.z = gl_Position.w; }',
      fragmentShader: 'uniform vec3 uTop; uniform vec3 uHorizon; varying vec3 vD; void main(){ gl_FragColor = vec4(mix(uHorizon, uTop, pow(clamp(vD.y,0.0,1.0),0.5)), 1.0); }'
    }));
    skyUniforms = gradU;
    scene.add(sky);
  }

  // --- clouds: one layer whose cover follows the threat (clear when calm) ---
  const cloudU = { uTime: { value: 0 }, uCover: { value: 0.15 }, uDark: { value: 0 }, uLight: { value: 1 } };
  const clouds = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.ShaderMaterial({
    uniforms: cloudU, transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 vU; void main(){ vU = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `uniform float uTime; uniform float uCover; uniform float uDark; uniform float uLight; varying vec2 vU;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      float fbm(vec2 p){ float t = 0.0; float a = 0.5; for (int i = 0; i < 5; i++){ t += a*n(p); p *= 2.03; a *= 0.5; } return t; }
      void main(){ vec2 p = vU / 380.0 + vec2(uTime*0.004, uTime*0.0025); float d = fbm(p); float c = smoothstep(1.0 - uCover, 1.0 - uCover + 0.25, d); float edge = 1.0 - smoothstep(900.0, 1500.0, length(vU));
        vec3 col = mix(vec3(1.0), vec3(0.22, 0.24, 0.28), uDark) * (0.25 + 0.75 * uLight); gl_FragColor = vec4(col, c * edge * (0.65 + 0.3 * uDark)); }`
  }));
  clouds.rotation.x = Math.PI / 2;
  clouds.position.y = 260;
  clouds.renderOrder = 2;
  scene.add(clouds);

  // --- light shafts (Cinematic): soft cones from the beacons and down onto the keep ---
  const shafts = [];
  if (settings.shafts) {
    const shaftMat = (color) => new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: 'varying float vY; varying vec3 vN; varying vec3 vV; void main(){ vY = uv.y; vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
      fragmentShader: 'uniform vec3 uColor; uniform float uStrength; varying float vY; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(abs(dot(vN, vV)), 1.5); gl_FragColor = vec4(uColor, uStrength * f * vY * 0.35); }'
    });
    const keepShaft = new THREE.Mesh(new THREE.CylinderGeometry(4, 22, 120, 24, 1, true), shaftMat(0xfff1dc));
    keepShaft.position.set(0, 90, 0);
    root.add(keepShaft);
    shafts.push({ mesh: keepShaft, kind: 'sun' });
    for (const b of beacons) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(9, 1.2, 60, 16, 1, true), shaftMat(0xffa53a));
      s.position.set(b.fire.position.x, b.fire.position.y + 30, b.fire.position.z);
      root.add(s);
      shafts.push({ mesh: s, kind: 'beacon', beacon: b });
    }
  }

  const tmpSun = new THREE.Vector3();
  const env = { night: 0 };
  return {
    root, gates, portcullis, vaultDoors, beacons, towers, lanterns, forge: { group: forge, seal: sealMat }, harbour: { bearing: harbourBearing, point: at(harbourBearing, ISLAND_R - 18, islandHeight(ISLAND_R - 18)) },
    tollBarrier: barrier, toll, dome: domeUniforms, fogBearing, keep, sun, hemi, sky, clouds: cloudU, torches: torchMat, crates, env,
    // sunDir: unit vector to the sun; light 0 (night) .. 1 (day); storm 0..1.
    update(dt, t, { sunDir, light, storm }) {
      env.night = 1 - light;
      tmpSun.copy(sunDir);
      sun.position.copy(tmpSun).multiplyScalar(300);
      sun.target.position.set(0, 0, 0);
      const moonlit = 1 - light;
      sun.intensity = 2.6 * light * (1 - storm * 0.55) + 0.25 * moonlit;
      sun.color.setHSL(light > 0.6 ? 0.1 : 0.07, light > 0.6 ? 0.3 : 0.6, 0.85).lerp(new THREE.Color(0x9fb8ff), moonlit);
      if (sunDir.y < 0) sun.position.set(-tmpSun.x * 300, Math.max(60, -tmpSun.y * 300), -tmpSun.z * 300);
      hemi.intensity = 0.15 + 0.55 * light * (1 - storm * 0.4);
      if (skyUniforms && skyUniforms.sunPosition) {
        skyUniforms.sunPosition.value.copy(tmpSun);
        skyUniforms.turbidity.value = 4 + storm * 12;
        skyUniforms.rayleigh.value = 1.4 + storm * 1.5;
      } else if (skyUniforms) {
        skyUniforms.uTop.value.setRGB(0.16 * light + 0.01, 0.43 * light + 0.02, 0.84 * light + 0.06).multiplyScalar(1 - storm * 0.5);
        skyUniforms.uHorizon.value.setRGB(0.74 * light + 0.05, 0.85 * light + 0.06, 0.95 * light + 0.1).multiplyScalar(1 - storm * 0.45);
      }
      if (waterMaterial && waterMaterial.uniforms) {
        for (const m of [seaMat, moatMat]) {
          if (!m.uniforms) continue;
          m.uniforms.uTime.value = t;
          m.uniforms.uSunDir.value.copy(tmpSun);
          m.uniforms.uSunColor.value.setRGB(1, 0.96, 0.9).multiplyScalar(Math.max(0.08, light) * (1 - storm * 0.6));
          m.uniforms.uZenith.value.setRGB(0.16, 0.43, 0.84).multiplyScalar(0.1 + light * 0.9).multiplyScalar(1 - storm * 0.5);
          m.uniforms.uHorizon.value.setRGB(0.74, 0.85, 0.95).multiplyScalar(0.08 + light * 0.92).multiplyScalar(1 - storm * 0.45);
        }
      }
      cloudU.uTime.value = t;
      cloudU.uCover.value += ((0.12 + storm * 0.62) - cloudU.uCover.value) * Math.min(1, dt * 0.3);
      cloudU.uDark.value += (storm - cloudU.uDark.value) * Math.min(1, dt * 0.3);
      cloudU.uLight.value = 0.15 + 0.85 * light;
      torchMat.emissiveIntensity = 0.3 + 2.2 * moonlit;
      domeUniforms.uTime.value = t;
      // Doors and portcullises ease towards where they should be.
      for (const pc of Object.values(this.portcullis)) pc.position.y += (pc.userData.goal - pc.position.y) * Math.min(1, dt * (pc.userData.goal === pc.userData.down ? 9 : 1.5));
      for (const d of vaultDoors) { const ax = d.userData.axis || 'y'; d.position[ax] += (d.userData.goal - d.position[ax]) * Math.min(1, dt * (d.userData.goal === d.userData.down ? 8 : 1.2)); }
      for (const b of beacons) { b.lit += (b.goal - b.lit) * Math.min(1, dt * 1.5); b.fire.material.emissiveIntensity = b.lit * (2.4 + 0.25 * Math.sin(t * 5 + b.bearing * 3)); }
      for (const s of shafts) s.mesh.material.uniforms.uStrength.value = s.kind === 'sun' ? light * (1 - storm) * 0.5 : s.beacon.lit * (0.4 + moonlit * 0.6);
      sealMat.emissiveIntensity += (0.2 - sealMat.emissiveIntensity) * Math.min(1, dt * 1.2);
    mats.windows.emissiveIntensity = 1.6 * Math.max(0, moonlit - 0.15) / 0.85;
    for (const r of radars) r.rotation.y += dt * 0.9;
    }
  };
}
