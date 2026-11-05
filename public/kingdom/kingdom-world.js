// PG1 City: the world, a near-future city at dusk built entirely in code
// (no downloaded models or textures; an original skyline, never a copy of
// a real building).
//
//   the PG1 Tower   a tall six-sided glass spire in the middle of the city,
//                   with PG1's shield near the top, the Command Centre deck,
//                   the emblem ring (real certifications) and the beacon at
//                   the tip (PG1's real production state: setState)
//   the skyline     glass and steel towers of many heights and shapes round
//                   the tower, lower blocks filling out to the haze; every
//                   building is instanced and shares one window shader:
//                   lit windows per floor, warm and cool, a few switching on
//                   and off over time, more of them as the light goes
//   the river       through the city, with an arched bridge (the toll gantry
//                   and the light barrier are on it), the harbour pier with
//                   its cargo scanner, embankment street lights
//   the roads       an avenue grid with moving car light trails
//   the sky         dusk by default (the hero look), or the live sun over
//                   Dublin; haze that fades the far city; layered clouds
//   the shield      over the centre, invisible until a gadget fires: then it
//                   ripples where the traffic hit, and thickens in a flood
//
// Coordinates: metres; north is -z, east is +x; the tower at the origin.
// Every mesh is named: tests/browser/kingdom.browser.test.mjs checks there
// is no unnamed (placeholder) block, and no island, wall or moat.

export const RIVER = Object.freeze({ z: 120, half: 45 });
export const PLAZA_R = 48;
export const CITY_R = 420;
export const SPIRE_H = 210;
export const PODIUM_H = 8;
export const DECK_Y = PODIUM_H + 150;
export const GATE_BEARINGS = Object.freeze({ north: 0, east: Math.PI / 2, south: Math.PI, west: Math.PI * 1.5 });

export const at = (bearing, r, y = 0) => ({ x: Math.sin(bearing) * r, y, z: -Math.cos(bearing) * r });
export const inRiver = (z) => Math.abs(z - RIVER.z) < RIVER.half;

const GOLD = 0xf3c623;

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

// A seeded random stream: the same city every time.
function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// The window shader, added to a standard (PBR) material so the glass keeps
// its reflections: aSeed (per building) picks which floors and windows are
// lit, warm or cool; a few switch every few seconds; uNight scales them.
function windowMaterial(THREE, { reflective }) {
  const m = new THREE.MeshStandardMaterial({ color: 0x23364a, roughness: reflective ? 0.14 : 0.5, metalness: reflective ? 0.75 : 0.2 });
  const uniforms = { uNight: { value: 0.6 }, uTime: { value: 0 } };
  m.userData.windows = uniforms;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = 'attribute float aSeed;\nvarying float vSeed;\nvarying vec3 vWPos;\nvarying vec3 vWNorm;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      vec4 wp4 = vec4(transformed, 1.0);
      vec3 n0 = objectNormal;
      #ifdef USE_INSTANCING
        wp4 = instanceMatrix * wp4;
        n0 = mat3(instanceMatrix) * n0;
      #endif
      wp4 = modelMatrix * wp4;
      vWPos = wp4.xyz; vSeed = aSeed;
      vWNorm = normalize(mat3(modelMatrix) * n0);`);
    sh.fragmentShader = 'uniform float uNight;\nuniform float uTime;\nvarying float vSeed;\nvarying vec3 vWPos;\nvarying vec3 vWNorm;\nfloat wh(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      if (abs(vWNorm.y) < 0.5) {
        float u = abs(vWNorm.x) > abs(vWNorm.z) ? vWPos.z : vWPos.x;
        float fl = floor(vWPos.y / 3.6);
        float col = floor(u / 3.2);
        vec2 f = vec2(fract(u / 3.2), fract(vWPos.y / 3.6));
        float pane = step(0.12, f.x) * step(f.x, 0.88) * step(0.2, f.y) * step(f.y, 0.82);
        float floorOn = step(0.18, wh(vec3(vSeed, fl, 3.1)));
        float h = wh(vec3(vSeed, fl, col));
        float swap = step(0.985, wh(vec3(vSeed + col, fl, floor(uTime / 6.0 + h * 6.0))));
        float lit = abs(step(h, 0.38) * floorOn - swap);
        vec3 wc = mix(vec3(1.0, 0.78, 0.48), vec3(0.72, 0.86, 1.0), step(0.72, wh(vec3(col, vSeed, 7.7))));
        totalEmissiveRadiance += wc * pane * lit * uNight * (0.35 + 0.65 * wh(vec3(fl, col, vSeed)));
        diffuseColor.rgb *= mix(0.45, 1.0, pane) * mix(0.8, 1.15, wh(vec3(vSeed, 1.0, 2.0)));
      }`);
  };
  m.customProgramCacheKey = () => `pg1-windows-${reflective ? 1 : 0}`;
  return m;
}

export function buildWorld(THREE, scene, settings, { normals = null, waterMaterial = null, Sky = null } = {}) {
  void normals;
  const phone = settings.tier === 'phone';
  const reflective = !phone;
  const named = (o, name) => { o.name = name; return o; };
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...o });
  const mats = {
    concrete: std(0x5c6068, { roughness: 0.9 }),
    plaza: std(0x9a9da3, { roughness: 0.85 }),
    asphalt: std(0x2a2d32, { roughness: 0.95 }),
    steel: std(0xd8dde3, { roughness: 0.28, metalness: phone ? 0.3 : 0.85 }),
    steelDark: std(0x2b2f36, { roughness: 0.4, metalness: phone ? 0.2 : 0.7 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x3a5a78, roughness: reflective ? 0.06 : 0.3, metalness: reflective ? 0.9 : 0.15, emissive: 0x0b2236, emissiveIntensity: 0.5 }),
    gold: std(GOLD, { roughness: 0.3, metalness: 0.9, emissive: GOLD, emissiveIntensity: 0.35 }),
    led: new THREE.MeshBasicMaterial({ color: 0x9fe6ff }),
    white: new THREE.MeshBasicMaterial({ color: 0xf5f7fa }),
    barrier: new THREE.MeshBasicMaterial({ color: 0xfff1b8, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
  };
  const windows = windowMaterial(THREE, { reflective });
  const root = named(new THREE.Group(), 'pg1-city');
  scene.add(root);
  const shadowed = (o) => { o.traverse((m) => { if (m.isMesh) { m.castShadow = !!settings.shadows; m.receiveShadow = !!settings.shadows; } }); return o; };
  const dummy = new THREE.Object3D();

  // --- the ground and the river ---
  // The ground on both banks (the river runs between them).
  const north = 4500 + RIVER.z - RIVER.half; const south = 4500 - RIVER.z - RIVER.half;
  for (const [depth, cz] of [[north, (RIVER.z - RIVER.half - 4500) / 2], [south, (RIVER.z + RIVER.half + 4500) / 2]]) {
    const ground = named(new THREE.Mesh(new THREE.PlaneGeometry(9000, depth), mats.concrete), 'ground');
    ground.rotation.x = -Math.PI / 2; ground.position.z = cz; ground.receiveShadow = !!settings.shadows; root.add(ground);
  }
  const plaza = named(new THREE.Mesh(new THREE.CircleGeometry(PLAZA_R, 48), mats.plaza), 'plaza');
  plaza.rotation.x = -Math.PI / 2; plaza.position.y = 0.05; plaza.receiveShadow = !!settings.shadows; root.add(plaza);
  const riverMat = waterMaterial || new THREE.MeshStandardMaterial({ color: 0x1a3550, roughness: 0.18, metalness: 0.4 });
  if (waterMaterial && waterMaterial.uniforms) { waterMaterial.uniforms.uIslandCount.value = 0; waterMaterial.uniforms.uFoam.value = 0; waterMaterial.uniforms.uDeep.value.set(0x0c2236); waterMaterial.uniforms.uShallow.value.set(0x1d4a63); }
  const river = named(new THREE.Mesh(new THREE.PlaneGeometry(9000, RIVER.half * 2), riverMat), 'river');
  river.rotation.x = -Math.PI / 2; river.position.set(0, -3.2, RIVER.z); root.add(river);
  for (const side of [-1, 1]) {
    const bank = named(new THREE.Mesh(new THREE.BoxGeometry(9000, 4, 2), mats.concrete), 'embankment');
    bank.position.set(0, -2, RIVER.z + side * RIVER.half); root.add(bank);
  }

  // --- roads: an avenue grid, and car light trails on them ---
  const GRID = 160; const ROAD_W = 16;
  for (let k = -12; k <= 12; k++) {
    const ns = named(new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, 9000), mats.asphalt), 'road');
    ns.rotation.x = -Math.PI / 2; ns.position.set(k * GRID, 0.03, 0); root.add(ns);
    const z = k * GRID - 40;
    if (!inRiver(z)) { const ew = named(new THREE.Mesh(new THREE.PlaneGeometry(9000, ROAD_W), mats.asphalt), 'road'); ew.rotation.x = -Math.PI / 2; ew.position.set(0, 0.03, z); root.add(ew); }
  }
  const carCount = phone ? 260 : 900;
  const carGeo = new THREE.BoxGeometry(0.9, 0.5, 3.4);
  const heads = named(new THREE.InstancedMesh(carGeo, new THREE.MeshBasicMaterial({ color: 0xfff4d6 }), carCount), 'car-lights');
  const tails = named(new THREE.InstancedMesh(carGeo, new THREE.MeshBasicMaterial({ color: 0xffa040 }), carCount), 'car-lights');
  const cars = [];
  { const r = rng(42); while (cars.length < carCount) { const alongX = r() < 0.5; const lane = (Math.floor(r() * 25) - 12) * GRID + (alongX ? -40 : 0); if (alongX && inRiver(lane)) continue; if (!alongX && lane !== 0 && r() < 0) continue; cars.push({ alongX, lane, pos: (r() - 0.5) * 5000, speed: 12 + r() * 10, dir: r() < 0.5 ? 1 : -1 }); } }
  root.add(heads); root.add(tails);

  // --- the skyline: instanced buildings sharing the window shader ---
  const r = rng(7);
  const lots = [];
  const nearN = phone ? 150 : 260; const farN = phone ? 420 : 1500;
  const offRoad = (v, w, shift = 0) => { const m = ((((v + shift) % GRID) + GRID) % GRID); return m > ROAD_W / 2 + w / 2 && m < GRID - ROAD_W / 2 - w / 2; };
  const tryLot = (x, z, w, d, h, kind) => {
    if (Math.hypot(x, z) < PLAZA_R + Math.max(w, d) * 0.7 + 6) return;
    if (Math.abs(z - RIVER.z) < RIVER.half + Math.max(w, d) * 0.6 + 6) return;
    if (!offRoad(x, w) || !offRoad(z, d, 40)) return;
    if (x > 150 && x < 270 && z > 10 && z < RIVER.z) return; // the pier's quay
    lots.push({ x, z, w, d, h, kind, seed: r() * 1000 });
  };
  for (let i = 0; i < nearN * 6 && lots.length < nearN; i++) {
    const a = r() * Math.PI * 2; const d = 70 + Math.pow(r(), 0.8) * 480;
    const tall = Math.max(0.15, 1 - d / 650);
    const k = r();
    tryLot(Math.sin(a) * d, -Math.cos(a) * d, 14 + r() * 18, 14 + r() * 18, Math.min(150, 25 + r() * 110 * tall + (r() < 0.12 ? 25 * tall : 0)), k < 0.55 ? 'box' : k < 0.75 ? 'round' : k < 0.9 ? 'taper' : 'step');
  }
  for (let i = 0; i < farN * 4 && lots.length < nearN + farN; i++) {
    const a = r() * Math.PI * 2; const d = 560 + Math.pow(r(), 0.7) * 2400;
    tryLot(Math.sin(a) * d, -Math.cos(a) * d, 18 + r() * 26, 18 + r() * 26, 10 + r() * 45, r() < 0.8 ? 'box' : 'round');
  }
  const geos = { box: new THREE.BoxGeometry(1, 1, 1), round: new THREE.CylinderGeometry(0.5, 0.5, 1, phone ? 10 : 18), taper: new THREE.CylinderGeometry(0.42, 0.62, 1, 4, 1) };
  geos.taper.rotateY(Math.PI / 4);
  for (const g of Object.values(geos)) g.translate(0, 0.5, 0);
  const byKind = { box: [], round: [], taper: [] };
  for (const l of lots) {
    if (l.kind === 'step') { byKind.box.push({ ...l, h: l.h * 0.6 }); byKind.box.push({ ...l, w: l.w * 0.62, d: l.d * 0.62, base: l.h * 0.6, h: l.h * 0.4, seed: l.seed + 1, top: true }); }
    else byKind[l.kind].push(l);
  }
  const roofSpots = [];
  for (const [kind, list] of Object.entries(byKind)) {
    if (!list.length) continue;
    const geo = geos[kind].clone();
    const seeds = new Float32Array(list.length);
    const mesh = named(new THREE.InstancedMesh(geo, windows, list.length), `skyline-${kind}`);
    list.forEach((l, i) => {
      dummy.position.set(l.x, l.base || 0, l.z); dummy.rotation.set(0, (l.seed % 1) * 0.3, 0); dummy.scale.set(l.w, l.h, l.d); dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix); seeds[i] = l.seed;
      const top = (l.base || 0) + l.h;
      if (top > 60 && (l.top || l.kind !== 'step')) roofSpots.push({ x: l.x, y: top, z: l.z, h: top, w: l.w * (kind === 'taper' ? 0.5 : 1) });
    });
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    mesh.castShadow = !!settings.shadows; mesh.receiveShadow = !!settings.shadows;
    root.add(mesh);
  }
  // Rooftop details: antennas, steady white aircraft lights, helipads.
  roofSpots.sort((a, b) => b.h - a.h);
  const tops = roofSpots.slice(0, phone ? 40 : 90);
  const antennas = named(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.4, 14, 6), mats.steel, tops.length), 'rooftop-antennas');
  const roofLights = named(new THREE.InstancedMesh(new THREE.SphereGeometry(0.7, 8, 6), mats.white, tops.length), 'rooftop-lights');
  const pads = tops.filter((_, i) => i % 3 === 0);
  const padMesh = named(new THREE.InstancedMesh(new THREE.RingGeometry(4, 4.6, 32), mats.led, Math.max(1, pads.length)), 'helipads');
  padMesh.count = pads.length;
  tops.forEach((t, i) => {
    dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
    dummy.position.set(t.x + t.w * 0.25, t.y + 7, t.z); dummy.updateMatrix(); antennas.setMatrixAt(i, dummy.matrix);
    dummy.position.set(t.x + t.w * 0.25, t.y + 14.5, t.z); dummy.updateMatrix(); roofLights.setMatrixAt(i, dummy.matrix);
  });
  pads.forEach((t, i) => { dummy.position.set(t.x - t.w * 0.15, t.y + 0.2, t.z); dummy.rotation.set(-Math.PI / 2, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); padMesh.setMatrixAt(i, dummy.matrix); });
  root.add(antennas); root.add(roofLights); root.add(padMesh);

  // --- the PG1 Tower ---
  const keep = named(new THREE.Group(), 'pg1-tower');
  const podium = named(new THREE.Mesh(new THREE.CylinderGeometry(30, 32, PODIUM_H, 6), mats.steelDark), 'tower-podium'); podium.position.y = PODIUM_H / 2; podium.rotation.y = Math.PI / 6; keep.add(podium);
  const spireGeo = new THREE.CylinderGeometry(2.2, 24, SPIRE_H, 6, 1, true); spireGeo.translate(0, SPIRE_H / 2, 0);
  spireGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array([777]), 1));
  const spire = named(new THREE.InstancedMesh(spireGeo, windows, 1), 'tower-spire');
  dummy.position.set(0, PODIUM_H, 0); dummy.rotation.set(0, Math.PI / 6, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); spire.setMatrixAt(0, dummy.matrix);
  keep.add(spire);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const p0 = new THREE.Vector3(Math.cos(a) * 24, PODIUM_H, Math.sin(a) * 24); const p1 = new THREE.Vector3(Math.cos(a) * 2.2, PODIUM_H + SPIRE_H, Math.sin(a) * 2.2);
    const edge = named(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, p0.distanceTo(p1), 6), mats.steel), 'tower-edge');
    edge.position.copy(p0).add(p1).multiplyScalar(0.5); edge.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize());
    keep.add(edge);
  }
  const radiusAt = (y) => 24 - (24 - 2.2) * ((y - PODIUM_H) / SPIRE_H);
  const tipY = PODIUM_H + SPIRE_H + 10;
  const mast = named(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.6, 20, 6), mats.steel), 'tower-mast'); mast.position.y = tipY - 10; keep.add(mast);
  const beaconMat = new THREE.MeshBasicMaterial({ color: GOLD });
  const tip = named(new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), beaconMat), 'tower-beacon'); tip.position.y = tipY; keep.add(tip);
  const tipHalo = named(new THREE.Mesh(new THREE.SphereGeometry(5, 16, 12), new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false })), 'tower-beacon-halo'); tipHalo.position.y = tipY; keep.add(tipHalo);
  // The shield near the top, subtle, on the south and east faces.
  const shieldY = PODIUM_H + 172;
  const faceR = radiusAt(shieldY) * Math.cos(Math.PI / 6) + 0.5;
  const shieldS = named(new THREE.Mesh(new THREE.ExtrudeGeometry(shieldShape(THREE), { depth: 0.3, bevelEnabled: false }), mats.gold), 'tower-shield');
  shieldS.scale.setScalar(4.2); shieldS.position.set(0, shieldY, faceR); keep.add(shieldS);
  const shieldE = named(shieldS.clone(), 'tower-shield'); shieldE.rotation.y = Math.PI / 2; shieldE.position.set(faceR, shieldY, 0); keep.add(shieldE);
  // The Command Centre deck, where the commander drone docks.
  const deckR = radiusAt(DECK_Y) + 5;
  const deck = named(new THREE.Mesh(new THREE.CylinderGeometry(deckR, deckR - 1.5, 3, 6), new THREE.MeshStandardMaterial({ color: 0x2a4a68, roughness: 0.08, metalness: 0.6, emissive: 0x6fd8ff, emissiveIntensity: 0.55, transparent: true, opacity: 0.88 })), 'command-deck');
  deck.position.y = DECK_Y; deck.rotation.y = Math.PI / 6; keep.add(deck);
  const deckRing = named(new THREE.Mesh(new THREE.TorusGeometry(deckR + 0.2, 0.18, 6, 60), mats.led), 'command-deck-ring'); deckRing.rotation.x = Math.PI / 2; deckRing.position.y = DECK_Y + 1.6; keep.add(deckRing);
  // The emblem ring under the deck: the real certifications (setState).
  const emblemY = DECK_Y - 9; const er = radiusAt(emblemY) + 1.4;
  const emblems = named(new THREE.Group(), 'emblem-ring'); emblems.position.y = emblemY; keep.add(emblems);
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
  // The vault (Passkey Vault) at the base, east face: only once passkeys exist.
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
  forge.position.set(-38, 0, 22);
  root.add(shadowed(forge));
  const preflight = [];
  for (let k = 0; k < 6; k++) {
    const p = at((k / 6) * Math.PI * 2 + Math.PI / 6, 42);
    const pyl = named(new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.9, 6, 8), mats.steelDark), 'preflight-pylon'); pyl.position.set(p.x, 3, p.z); root.add(pyl);
    const capMat = new THREE.MeshBasicMaterial({ color: 0x3a3f46 });
    const capOrb = named(new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 10), capMat), 'preflight-light'); capOrb.position.set(p.x, 6.8, p.z); root.add(capOrb);
    preflight.push({ mat: capMat, until: 0 });
  }

  // --- the arched bridge across the river at x = 0 ---
  const bridge = named(new THREE.Group(), 'bridge');
  const deckLen = RIVER.half * 2 + 30;
  const archR = deckLen / 2 - 6;
  const bdeck = named(new THREE.Mesh(new THREE.BoxGeometry(18, 1.6, deckLen), mats.concrete), 'bridge-deck'); bdeck.position.set(0, 9, RIVER.z); bridge.add(bdeck);
  for (const sx of [-8.6, 8.6]) {
    const arch = named(new THREE.Mesh(new THREE.TorusGeometry(archR, 0.7, 8, 40, Math.PI), mats.steel), 'bridge-arch');
    arch.rotation.y = Math.PI / 2; arch.position.set(sx, 9, RIVER.z); arch.scale.set(1, 0.62, 1); bridge.add(arch);
    for (let k = 1; k < 10; k++) {
      const zz = RIVER.z - archR + k * ((archR * 2) / 10);
      const tt = (zz - RIVER.z) / archR;
      const hgt = Math.sqrt(Math.max(0, 1 - tt * tt)) * archR * 0.62;
      const cable = named(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, hgt, 4), mats.steel), 'bridge-cable'); cable.position.set(sx, 9 + hgt / 2, zz); bridge.add(cable);
    }
    const rail = named(new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.2, deckLen), mats.glass), 'bridge-rail'); rail.position.set(sx, 10.4, RIVER.z); bridge.add(rail);
  }
  for (const zz of [RIVER.z - RIVER.half - 4, RIVER.z + RIVER.half + 4]) { const ab = named(new THREE.Mesh(new THREE.BoxGeometry(14, 14, 6), mats.concrete), 'bridge-abutment'); ab.position.set(0, 2, zz); bridge.add(ab); }
  root.add(shadowed(bridge));
  // The toll gantry (x402) at the bridge's south end, and the lanterns on the bridge.
  const gantryZ = RIVER.z + RIVER.half + 10;
  const toll = named(new THREE.Group(), 'toll-gantry');
  for (const sx of [-9.5, 9.5]) { const leg = named(new THREE.Mesh(new THREE.BoxGeometry(0.8, 9, 0.8), mats.steel), 'toll-gantry-leg'); leg.position.set(sx, 4.5, 0); toll.add(leg); }
  const beam = named(new THREE.Mesh(new THREE.BoxGeometry(20, 1.2, 1.4), mats.steel), 'toll-gantry-beam'); beam.position.y = 9.2; toll.add(beam);
  const barrier = named(new THREE.Mesh(new THREE.BoxGeometry(16, 0.35, 0.35), new THREE.MeshStandardMaterial({ color: 0xf5f7fa, emissive: 0xffb300, emissiveIntensity: 0.25, roughness: 0.4 })), 'toll-barrier'); barrier.position.set(0, 1.6, 0); toll.add(barrier);
  toll.position.set(0, 0, gantryZ);
  root.add(shadowed(toll));
  const lanterns = [];
  const lanternGeo = new THREE.CylinderGeometry(0.22, 0.22, 1.4, 10);
  for (let k = 0; k < 12; k++) for (const sx of [-7.6, 7.6]) {
    const m = named(new THREE.Mesh(lanternGeo, new THREE.MeshStandardMaterial({ color: 0x22262c, emissive: GOLD, emissiveIntensity: 0, roughness: 0.4, metalness: 0.6 })), 'bridge-lantern');
    m.position.set(sx, 10.6, RIVER.z - deckLen / 2 + 8 + k * ((deckLen - 16) / 11));
    root.add(m); lanterns.push(m);
  }

  // --- checkpoints, and the light barriers (Sanctions Gate) hidden above them ---
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
    gates[name] = { bearing: b, inside: at(b, PLAZA_R + 20, 60), mouth: at(b, 150, 55) };
    barrierGate(name, { ...at(b, 140), y: 30 }, 60, 50, -b);
  }
  // South is the bridge: boats stop at it on the river, road traffic at the gantry.
  gates.south = { bearing: Math.PI, inside: { x: 0, y: 14, z: 40 }, mouth: { x: 0, y: 10, z: gantryZ + 8 } };
  barrierGate('south', { x: 0, y: -4, z: RIVER.z }, RIVER.half * 2, 13, Math.PI / 2);

  // --- the harbour pier (north bank, east of the bridge) and its cargo scanner ---
  const pierX = 205;
  const harbourGroup = named(new THREE.Group(), 'harbour-pier');
  const pierDeck = named(new THREE.Mesh(new THREE.BoxGeometry(14, 1.4, 44), mats.concrete), 'pier-deck'); pierDeck.position.set(pierX, -0.6, RIVER.z - RIVER.half + 20); harbourGroup.add(pierDeck);
  const crane = named(new THREE.Group(), 'cargo-scanner');
  const craneMast = named(new THREE.Mesh(new THREE.BoxGeometry(0.9, 20, 0.9), mats.gold), 'cargo-scanner-mast'); craneMast.position.y = 10; crane.add(craneMast);
  const jib = named(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 26), mats.gold), 'cargo-scanner-arm'); jib.position.set(0, 20, 8); crane.add(jib);
  crane.position.set(pierX + 4, 0, RIVER.z - RIVER.half + 6);
  harbourGroup.add(crane);
  const xray = named(new THREE.Mesh(new THREE.PlaneGeometry(10, 18), new THREE.MeshBasicMaterial({ color: 0x9be7ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })), 'cargo-scanner-xray');
  xray.position.set(0, 10, 18); crane.add(xray);
  root.add(shadowed(harbourGroup));
  const harbourPoint = { x: pierX, y: -3, z: RIVER.z - RIVER.half + 48 };

  // --- street lights along the embankments ---
  const lampN = phone ? 80 : 200;
  const lampPoles = named(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.2, 8, 6), mats.steelDark, lampN), 'street-light-poles');
  const lampMat = new THREE.MeshBasicMaterial({ color: 0x6a6252 });
  const lampHeads = named(new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 8, 6), lampMat, lampN), 'street-lights');
  for (let i = 0; i < lampN; i++) {
    const side = i % 2 ? 1 : -1; const x = -2400 + Math.floor(i / 2) * (4800 / (lampN / 2));
    dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
    dummy.position.set(x, 4, RIVER.z + side * (RIVER.half + 4)); dummy.updateMatrix(); lampPoles.setMatrixAt(i, dummy.matrix);
    dummy.position.y = 8.2; dummy.updateMatrix(); lampHeads.setMatrixAt(i, dummy.matrix);
  }
  root.add(lampPoles); root.add(lampHeads);

  // --- rooftop beacons (reports and approvals) on the twelve tallest towers ---
  const beacons = [];
  for (const spot of roofSpots.slice(0, 12)) {
    const fire = named(new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 10), new THREE.MeshStandardMaterial({ color: 0x2a1a10, emissive: 0xffb300, emissiveIntensity: 0, roughness: 1 })), 'rooftop-beacon');
    fire.position.set(spot.x - spot.w * 0.2, spot.y + 3, spot.z + spot.w * 0.2);
    root.add(fire);
    beacons.push({ fire, bearing: Math.atan2(spot.x, -spot.z), lit: 0, goal: 0 });
  }

  // --- the Rate Shield: invisible until a gadget fires ---
  const domeUniforms = { uThick: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color(0x9fe6ff) }, uHit: { value: new THREE.Vector3(1, 0, 0) }, uHitT: { value: 99 } };
  const dome = named(new THREE.Mesh(new THREE.SphereGeometry(CITY_R * 0.62, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.ShaderMaterial({
    uniforms: domeUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: 'varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); vP = position; gl_Position = projectionMatrix*mv; }',
    fragmentShader: 'uniform float uThick; uniform float uTime; uniform vec3 uColor; uniform vec3 uHit; uniform float uHitT; varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.5); float hex = 0.5 + 0.5 * sin(vP.x * 0.25 + uTime * 0.6) * sin(vP.y * 0.25) * sin(vP.z * 0.25 - uTime * 0.4); float d = acos(clamp(dot(normalize(vP), normalize(uHit)), -1.0, 1.0)) * 260.0; float ring = exp(-pow(d - uHitT * 90.0, 2.0) / 900.0) * max(0.0, 1.0 - uHitT / 2.8); float a = uThick * 0.3 * (f * 0.8 + 0.2) * (0.75 + 0.25 * hex) + ring * 0.4 * (0.4 + f); gl_FragColor = vec4(uColor, a); }'
  })), 'rate-shield');
  dome.visible = false;
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
  const fog = named(new THREE.Group(), 'fog-bank');
  const puffs = phone ? 8 : 18;
  for (let k = 0; k < puffs; k++) {
    const s = named(new THREE.Sprite(new THREE.SpriteMaterial({ map: fogTex, color: 0xb8c0cc, transparent: true, opacity: 0.35, depthWrite: false })), 'fog-puff');
    const p = at(fogBearing + (k / puffs - 0.5) * 0.5, 700 + (k % 3) * 60, 40 + (k % 4) * 14);
    s.position.set(p.x, p.y, p.z); s.scale.setScalar(140 + (k % 5) * 30);
    fog.add(s);
  }
  root.add(fog);

  // --- light: the sun and the sky light ---
  const hemi = new THREE.HemisphereLight(0x9fb4d8, 0x2a2420, 0.55);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffd2a0, 2.2);
  if (settings.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(settings.shadows, settings.shadows);
    const cam = sun.shadow.camera; cam.left = -380; cam.right = 380; cam.top = 380; cam.bottom = -380; cam.near = 10; cam.far = 2000;
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 1.2;
  }
  scene.add(sun); scene.add(sun.target);

  // --- the sky: the physical sky (Balanced and up) or a dusk gradient (Phone) ---
  let sky = null; let skyUniforms = null;
  if (Sky && settings.sky === 'physical') {
    sky = new Sky(); sky.name = 'sky';
    sky.scale.setScalar(8000);
    skyUniforms = sky.material.uniforms;
    skyUniforms.turbidity.value = 8; skyUniforms.rayleigh.value = 3; skyUniforms.mieCoefficient.value = 0.008; skyUniforms.mieDirectionalG.value = 0.9;
    scene.add(sky);
  } else {
    const gradU = { uTop: { value: new THREE.Color(0x1b2a4a) }, uHorizon: { value: new THREE.Color(0xf09a5a) }, uSunDir: { value: new THREE.Vector3(-1, 0.05, 0) }, uGlow: { value: new THREE.Color(0xffc27a) } };
    sky = named(new THREE.Mesh(new THREE.SphereGeometry(7000, 32, 16), new THREE.ShaderMaterial({
      uniforms: gradU, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position.z = gl_Position.w; }',
      fragmentShader: 'uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uGlow; varying vec3 vD; void main(){ float h = clamp(vD.y, 0.0, 1.0); vec3 c = mix(uHorizon, uTop, pow(h, 0.45)); float s = max(dot(vD, normalize(uSunDir)), 0.0); c += uGlow * (pow(s, 8.0) * 0.6 + pow(s, 120.0) * 1.5) * (1.0 - h); gl_FragColor = vec4(c, 1.0); }'
    })), 'sky');
    skyUniforms = gradU;
    scene.add(sky);
  }

  // --- clouds: layered, lit warm from below at dusk; cover follows the threat ---
  const cloudLayers = [];
  for (const [y, scale, speed] of (phone ? [[520, 520, 1]] : [[520, 520, 1], [760, 900, 0.6]])) {
    const cu = { uTime: { value: 0 }, uCover: { value: 0.3 }, uDark: { value: 0 }, uLight: { value: 1 }, uWarm: { value: new THREE.Color(0xffb27a) }, uScale: { value: scale }, uSpeed: { value: speed } };
    const c = named(new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.ShaderMaterial({
      uniforms: cu, transparent: true, depthWrite: false, fog: false,
      vertexShader: 'varying vec2 vU; void main(){ vU = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `uniform float uTime; uniform float uCover; uniform float uDark; uniform float uLight; uniform vec3 uWarm; uniform float uScale; uniform float uSpeed; varying vec2 vU;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p){ float t = 0.0; float a = 0.5; for (int i = 0; i < 5; i++){ t += a*n(p); p *= 2.03; a *= 0.5; } return t; }
        void main(){ vec2 p = vU / uScale + vec2(uTime*0.004, uTime*0.0025) * uSpeed; float d = fbm(p); float c = smoothstep(1.0 - uCover, 1.0 - uCover + 0.3, d); float edge = 1.0 - smoothstep(2500.0, 4200.0, length(vU));
          vec3 col = mix(mix(vec3(0.42, 0.44, 0.52), uWarm, 0.55 * (1.0 - uDark)), vec3(0.16, 0.17, 0.2), uDark) * (0.2 + 0.8 * uLight); gl_FragColor = vec4(col, c * edge * 0.8); }`
    })), 'clouds');
    c.rotation.x = Math.PI / 2; c.position.y = y; c.renderOrder = 2;
    scene.add(c); cloudLayers.push(cu);
  }

  const tmp = new THREE.Vector3();
  const cool = new THREE.Color(0x9fb8ff);
  const env = { night: 0 };
  return {
    root, gates, portcullis, vaultDoors, beacons, lanterns, forge: { group: forge, seal: sealMat }, harbour: { bearing: Math.atan2(harbourPoint.x, -harbourPoint.z), point: harbourPoint },
    tollBarrier: barrier, toll, dome: domeUniforms, domeMesh: dome, preflight, crane, xray, deckY: DECK_Y, tip: tip.position, roofSpots,
    fogBearing, keep, sun, hemi, sky, windows: windows.userData.windows, env, buildingCount: lots.length,
    state: null,
    // PG1's real state (kingdom-data.js normalizeState): the beacon, the
    // emblems, the vault, and one rooftop beacon per approval waiting.
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
    // sunDir: unit vector to the sun; light 0 (night) .. 1 (day); storm 0..1; dusk 0..1 (golden light).
    update(dt, t, { sunDir, light, storm, dusk = 0 }) {
      env.night = 1 - light;
      const mode = this.state ? this.state.beacon : 'unknown';
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
      beaconMat.color.setHex(mode === 'gold' ? GOLD : mode === 'amber' ? 0xffb300 : mode === 'dim' ? 0x5a5f66 : 0xd8dde3);
      tipHalo.material.color.copy(beaconMat.color);
      tipHalo.material.opacity = mode === 'gold' ? 0.35 : mode === 'amber' ? 0.12 + 0.3 * pulse : mode === 'dim' ? 0.03 : 0.1;
      tmp.copy(sunDir);
      sun.position.copy(tmp).multiplyScalar(900);
      if (sun.position.y < 60) sun.position.y = 60;
      sun.target.position.set(0, 0, 0);
      const moon = 1 - light;
      sun.intensity = 2.4 * light * (1 - storm * 0.55) + 0.3 * moon;
      sun.color.setRGB(1, 0.62 + 0.3 * (1 - dusk) * light, 0.38 + 0.5 * (1 - dusk) * light).lerp(cool, moon * 0.8);
      hemi.intensity = 0.18 + 0.5 * light * (1 - storm * 0.4);
      if (skyUniforms && skyUniforms.sunPosition) {
        skyUniforms.sunPosition.value.copy(tmp);
        skyUniforms.turbidity.value = 6 + storm * 10;
      } else if (skyUniforms) {
        skyUniforms.uSunDir.value.copy(tmp);
        skyUniforms.uTop.value.setRGB(0.05 + 0.2 * light, 0.08 + 0.3 * light, 0.18 + 0.55 * light).multiplyScalar(1 - storm * 0.5);
        skyUniforms.uHorizon.value.setRGB(0.25 + 0.7 * light, 0.2 + 0.42 * light + 0.2 * (1 - dusk) * light, 0.25 + 0.15 * light + 0.45 * (1 - dusk) * light).multiplyScalar(1 - storm * 0.45);
        skyUniforms.uGlow.value.setRGB(1, 0.72, 0.42).multiplyScalar(Math.max(0.1, dusk) * (1 - storm));
      }
      if (riverMat.uniforms) {
        riverMat.uniforms.uTime.value = t;
        riverMat.uniforms.uSunDir.value.copy(tmp);
        riverMat.uniforms.uSunColor.value.setRGB(1, 0.75, 0.5).multiplyScalar(Math.max(0.1, light) * (1 - storm * 0.6));
        riverMat.uniforms.uZenith.value.setRGB(0.1, 0.2, 0.4).multiplyScalar(0.3 + light * 0.7);
        riverMat.uniforms.uHorizon.value.setRGB(0.95, 0.62, 0.42).multiplyScalar(0.25 + light * 0.75);
      }
      for (const cu of cloudLayers) {
        cu.uTime.value = t;
        cu.uCover.value += ((0.28 + storm * 0.5) - cu.uCover.value) * Math.min(1, dt * 0.3);
        cu.uDark.value += (storm - cu.uDark.value) * Math.min(1, dt * 0.3);
        cu.uLight.value = 0.15 + 0.85 * light;
        cu.uWarm.value.setRGB(1, 0.66 + 0.34 * (1 - dusk), 0.45 + 0.55 * (1 - dusk));
      }
      // The windows: from dusk on, more of the city lights up.
      windows.userData.windows.uNight.value = 0.15 + 1.5 * Math.max(dusk * 0.8, moon);
      windows.userData.windows.uTime.value = t;
      lampMat.color.setHex(moon > 0.3 || dusk > 0.5 ? 0xffd9a0 : 0x6a6252);
      // Car light trails along the avenues.
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        c.pos += c.speed * c.dir * dt; if (c.pos > 2500) c.pos -= 5000; if (c.pos < -2500) c.pos += 5000;
        const off = c.dir * 2.6;
        dummy.rotation.set(0, c.alongX ? Math.PI / 2 : 0, 0); dummy.scale.set(1, 1, 1);
        if (c.alongX) dummy.position.set(c.pos, 0.6, c.lane + off); else dummy.position.set(c.lane + off, c.lane === 0 && inRiver(c.pos) ? 10.6 : 0.6, c.pos);
        dummy.updateMatrix(); heads.setMatrixAt(i, dummy.matrix);
        if (c.alongX) dummy.position.x -= c.dir * 4; else dummy.position.z -= c.dir * 4;
        dummy.updateMatrix(); tails.setMatrixAt(i, dummy.matrix);
      }
      heads.instanceMatrix.needsUpdate = true; tails.instanceMatrix.needsUpdate = true;
      // The shield shows only while a gadget's ripple or a flood lasts.
      domeUniforms.uTime.value = t;
      domeUniforms.uHitT.value += dt;
      dome.visible = domeUniforms.uHitT.value < 2.8 || domeUniforms.uThick.value > 0.03;
      if (this.flashUntil && t < this.flashUntil) { beaconMat.color.setHex(this.flashColor); tipHalo.material.opacity = 0.4; }
      for (const p of preflight) { if (p.until && performance.now() > p.until) { p.until = 0; p.mat.color.setHex(0x3a3f46); } }
      xray.material.opacity = Math.max(0, xray.material.opacity - dt * 0.4);
      for (const pc of Object.values(portcullis)) { pc.position.y += (pc.userData.goal - pc.position.y) * Math.min(1, dt * (pc.userData.goal === pc.userData.down ? 6 : 1.2)); pc.visible = pc.position.y < pc.userData.up - 0.5; }
      for (const d of vaultDoors) { const ax = d.userData.axis || 'y'; d.position[ax] += (d.userData.goal - d.position[ax]) * Math.min(1, dt * (d.userData.goal === d.userData.down ? 8 : 1.2)); }
      for (const b of beacons) { b.lit += (b.goal - b.lit) * Math.min(1, dt * 1.5); b.fire.material.emissiveIntensity = b.lit * (2.6 + 0.25 * Math.sin(t * 5 + b.bearing * 3)); }
      sealMat.emissiveIntensity += (0.25 - sealMat.emissiveIntensity) * Math.min(1, dt * 1.2);
    }
  };
}
