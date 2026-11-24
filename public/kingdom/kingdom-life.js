// PG1 City: the city's own life. Decoration only: none of this is ever
// captioned, counted or shown as an event, and none of it uses the enemy
// palette (red is theirs; tail lights and stop lights here are deep amber).
// Real events stay the only source of attackers (kingdom-actors.js).
//
//   traffic     cars, taxis, delivery vans and buses from kingdom-traffic.js:
//               lanes both ways (Dublin drives on the left), following
//               distance, queues at red lights, junctions entered only on
//               green with the exit clear, never two in the same space, never
//               over the river (only the main bridge crosses); spray behind
//               them on wet roads
//   buses       stop at bus shelters; people get off and on
//   people      on the zebras in the pedestrian phase (some with dogs, with
//               umbrellas in the rain), on pavements, the plaza, the bridge
//               and the embankments; café tables and parasols on the plaza;
//               buskers near the tower plaza
//   cyclists    on the embankment cycle tracks
//   tram        two lines on the viaduct over the avenue at TRAM_Z, stopping
//               at stations
//   river       water taxis and ferries in lanes, keeping clear of each other
//               and of the boats real events bring; moored boats rocking
//   sky         aircraft high on approach, birds at dusk, gulls over the
//               river, pigeons on the rooftops
//   rooftops    steam from vents, a turning radar, a construction crane
//   street      lamp posts with warm light pools (on at sunset), pavements and
//               kerbs, zebras and stop lines, manholes; flags on the plaza
//               that blow in the real wind; shop signs off late at night
//
// Real-world scale: cars 4.5 m, buses 12 m, people 1.75 m, floors 3.6 m.
// Density follows the tier (settings.lifeScale): fewer of everything on
// the phone tiers, never none.

import { RIVER, PLAZA_R, inRiver } from './kingdom-world.js';
import { walkerGeometry, walkerMaterial, walkerAttributes, walkerLook, WALKER_RANGE, WALKER_CAP } from './kingdom-people.js';
import { createShops, plazaArcade, facadeUnits } from './kingdom-shops.js';
import { createTraffic, GRID, ROAD_W, STOP_BACK, JUNCTION_HALF, ZEBRA_IN, ZEBRA_W, signalFor, LANE_OFFSET } from './kingdom-traffic.js';

export const TRAM_Z = -200;
export { GRID };
// Every colour the life uses, for the tests (none may be the enemy red).
// A pedestrian: legs, a torso a little wider at the shoulders, arms and a
// head, about 1.75 m tall, merged into one geometry (one draw call for the
// whole crowd). Vertex colours: dark trousers and shoes, a skin-toned head
// aTint marks the clothes (1: the instance's colour) and the skin (2: the
// instance's aSkin tone; personMaterial). Low: fewer sides, no arms, about
// 50 triangles a figure (the whole crowd stays inside Low's budget).
const SKIN = [[0.55, 0.38, 0.27], [0.78, 0.6, 0.47], [0.36, 0.24, 0.17], [0.88, 0.72, 0.6]];
export function personGeometry(THREE, { low = false } = {}) {
  const sides = low ? 4 : 5; const parts = [];
  const add = (g, rgb, tint) => { const n = g.toNonIndexed(); g.dispose(); const c = new Float32Array(n.attributes.position.count * 3); const t = new Float32Array(n.attributes.position.count); for (let i = 0; i < t.length; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; t[i] = tint; } n.setAttribute('color', new THREE.BufferAttribute(c, 3)); n.setAttribute('aTint', new THREE.BufferAttribute(t, 1)); parts.push(n); };
  const trousers = [0.16, 0.17, 0.2];
  for (const x of [-0.1, 0.1]) { const l = new THREE.CylinderGeometry(0.075, 0.065, 0.86, sides, 1, true); l.translate(x, 0.45, 0); add(l, trousers, 0); }
  if (!low) for (const x of [-0.1, 0.1]) { const sh = new THREE.BoxGeometry(0.11, 0.07, 0.24); sh.translate(x, 0.035, 0.04); add(sh, [0.08, 0.08, 0.09], 0); }
  if (low) { const torso = new THREE.CylinderGeometry(0.21, 0.16, 0.62, sides, 1, false); torso.translate(0, 1.18, 0); add(torso, [1, 1, 1], 1); }
  else {
    // Hips, a torso with shoulders, a neck; arms with skin-toned hands; hair.
    const hips = new THREE.CylinderGeometry(0.17, 0.16, 0.16, 8, 1, false); hips.translate(0, 0.9, 0); add(hips, trousers, 0);
    const torso = new THREE.CylinderGeometry(0.22, 0.165, 0.56, 8, 1, false); torso.scale(1, 1, 0.72); torso.translate(0, 1.25, 0); add(torso, [1, 1, 1], 1);
    const shoulders = new THREE.SphereGeometry(0.22, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2); shoulders.scale(1, 0.35, 0.72); shoulders.translate(0, 1.52, 0); add(shoulders, [1, 1, 1], 1);
    const neck = new THREE.CylinderGeometry(0.05, 0.055, 0.09, 6, 1, true); neck.translate(0, 1.56, 0); add(neck, [1, 1, 1], 2);
    for (const x of [-0.255, 0.255]) {
      const a = new THREE.CylinderGeometry(0.058, 0.048, 0.56, 6, 1, true); a.rotateZ(x > 0 ? 0.08 : -0.08); a.translate(x, 1.23, 0); add(a, [1, 1, 1], 1);
      const h = new THREE.SphereGeometry(0.05, 5, 4); h.translate(x * 1.08, 0.92, 0); add(h, [1, 1, 1], 2);
    }
  }
  const head = new THREE.SphereGeometry(0.115, low ? 5 : 9, low ? 3 : 7); head.scale(1, 1.12, 1); head.translate(0, 1.7, 0); add(head, [1, 1, 1], 2);
  if (!low) { const hair = new THREE.SphereGeometry(0.122, 9, 4, 0, Math.PI * 2, 0, Math.PI * 0.55); hair.scale(1, 1.1, 1.04); hair.translate(0, 1.715, -0.012); add(hair, [0.1, 0.075, 0.06], 0); }
  const n = parts.reduce((k, g) => k + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['color', 3], ['aTint', 1]]) {
    const arr = new Float32Array(n * size); let o = 0;
    for (const g of parts) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  for (const g of parts) g.dispose();
  out.computeBoundingSphere();
  return out;
}
// The clothes take the instance's colour, the skin the instance's aSkin tone
// (personSkins); trousers and shoes keep their own.
export function personSkins(THREE, n) { const a = new Float32Array(n * 3); for (let i = 0; i < n; i++) a.set(SKIN[(i * 7 + 3) % SKIN.length], i * 3); return new THREE.InstancedBufferAttribute(a, 3); }
export function personMaterial(THREE) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aTint;\nattribute vec3 aSkin;')
      .replace('#include <color_vertex>', 'vColor = vec3(1.0);\n#ifdef USE_COLOR\n vColor *= color.xyz;\n#endif\n#ifdef USE_INSTANCING_COLOR\n if (aTint > 0.5 && aTint < 1.5) vColor *= instanceColor.xyz;\n#endif\n if (aTint > 1.5) vColor = aSkin;');
  };
  m.customProgramCacheKey = () => 'pg1-person';
  return m;
}

export const LIFE_COLOURS = Object.freeze({ head: 0xfff4d6, tail: 0xff9a2e, taxi: 0xf2c94c, bus: 0x2f6db5, busWin: 0xffe6b0, van: 0xe9edf1, stop: 0xff8c1a, go: 0x3ddc84, wait: 0xffc94d, strobe: 0xf5f7fa, nav: 0x3ddc84, roof: 0xffc070, tram: 0xd8dde3, tramWin: 0xffe2b0, steam: 0xc9ced6, lamp: 0xffcf8a, crane: 0xf3c623, figure: [0x2b3340, 0x4a3a6a, 0x44506a, 0xc8b89a, 0x5a4a3a, 0x2f5d8a, 0x36454f, 0xb8902c, 0x6b6f7a, 0x55703f, 0x3d5a4a, 0x2f6d6a, 0x8a6a3a], umbrella: [0x1f2a36, 0x2f4a6b, 0x3d5a4a, 0xf3c623, 0x6b6f7a], boat: 0xe9edf1, ferry: 0xf5f7fa, cabin: 0xffe2b0, bike: 0x2f6db5, parasol: 0xe8dcc0, gull: 0xf1f3f5, pigeon: 0x5a5f66, flag: 0x2f6db5, dog: 0x6b5a45, shelter: 0x8fb8d8 });

function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

export function createLife(THREE, scene, world, settings) {
  const phone = settings.tier === 'phone' || settings.tier === 'legacy';
  const k = settings.lifeScale != null ? settings.lifeScale : phone ? 0.35 : 1;
  const root = new THREE.Group(); root.name = 'city-life'; scene.add(root);
  const named = (o, n) => { o.name = n; return o; };
  const dummy = new THREE.Object3D();
  const set = (mesh, i, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) => { dummy.position.set(x, y, z); dummy.rotation.set(rx, ry, rz); dummy.scale.set(sx, sy, sz); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); };
  const hide = (mesh, i) => { dummy.position.set(0, -500, 0); dummy.rotation.set(0, 0, 0); dummy.scale.set(0.0001, 0.0001, 0.0001); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); };
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, ...o });
  const basic = (color, o = {}) => new THREE.MeshBasicMaterial({ color, ...o });
  const dyn = (m) => { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); return m; };
  const r = rng(77);
  // The close-range detail (walkers, shop fronts, modelled boats): High, Cinematic and the Showcase on a computer only.
  const detailed = !phone && !settings.coarse && !settings.legacy && !settings.leanCity && !settings.lowFigures;
  const softTex = (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; })();

  // --- traffic: the lane simulation, drawn ---
  const traffic = createTraffic({ density: k, cols: phone ? 4 : 6, rowsNorth: phone ? 3 : 4, rowsSouth: phone ? 3 : 4, tramZ: TRAM_Z, pedestrians: Math.max(0.35, k) });
  const CAP = traffic.target + 40;
  // Vehicle models (1.24 look): shaped from their side profiles, not boxes.
  // One geometry per kind with per-vertex colour: paint (white, so the
  // instance colour shows), dark glass, black tyres and grey rims. The
  // instance colour multiplies it, so glass and tyres stay dark on every car.
  const lowPoly = !!(settings.legacy);
  const WHITE = [1, 1, 1]; const GLASS = [0.07, 0.09, 0.12]; const TYRE = [0.035, 0.035, 0.04]; const RIM = [0.55, 0.57, 0.6]; const TRIM = [0.16, 0.17, 0.19];
  // A side profile [[z, y], ...] (z forward) extruded across the width, centred.
  const profile = (pts, width, col) => { const sh = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y))); const g = new THREE.ExtrudeGeometry(sh, { depth: width, bevelEnabled: !lowPoly, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 1, curveSegments: 1 }); g.translate(0, 0, -width / 2); g.rotateY(-Math.PI / 2); return { g, col }; };
  const wheels = (axles, track, r) => axles.flatMap((z) => [-1, 1].flatMap((side) => { const t = new THREE.CylinderGeometry(r, r, 0.26, lowPoly ? 6 : 12); t.rotateZ(Math.PI / 2); t.translate(side * track, r, z); const h = new THREE.CylinderGeometry(r * 0.55, r * 0.55, 0.28, lowPoly ? 6 : 10); h.rotateZ(Math.PI / 2); h.translate(side * (track + 0.01), r, z); return [{ g: t, col: TYRE }, { g: h, col: RIM }]; }));
  const vehicleGeo = (parts) => { const gs = parts.map(({ g, col, glow = 0 }) => { const n = g.index ? g.toNonIndexed() : g; const c = new Float32Array(n.attributes.position.count * 3); const w = new Float32Array(n.attributes.position.count * 3); for (let i = 0; i < c.length; i += 3) { c[i] = col[0]; c[i + 1] = col[1]; c[i + 2] = col[2]; w[i] = glow; w[i + 1] = glow * 0.78; w[i + 2] = glow * 0.5; } n.setAttribute('color', new THREE.BufferAttribute(c, 3)); n.setAttribute('aGlow', new THREE.BufferAttribute(w, 3)); n.deleteAttribute('uv'); return n; }); const total = gs.reduce((a, g) => a + g.attributes.position.count, 0); const out = new THREE.BufferGeometry(); for (const name of ['position', 'normal', 'color', 'aGlow']) { const arr = new Float32Array(total * 3); let o = 0; for (const g of gs) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; } out.setAttribute(name, new THREE.BufferAttribute(arr, 3)); } gs.forEach((g) => g.dispose()); return out; };
  // A car (4.5 m): bumpers, bonnet, raked windscreen, glass house, boot; the glass a little narrower than the body.
  const carBodyGeo = vehicleGeo([
    profile([[-2.25, 0.32], [2.25, 0.32], [2.32, 0.55], [2.2, 0.82], [1.15, 0.95], [-1.85, 0.95], [-2.25, 0.82], [-2.3, 0.5]], 1.86, WHITE),
    profile([[1.2, 0.95], [0.25, 1.5], [-1.0, 1.52], [-1.8, 1.0], [-1.85, 0.95]], 1.66, GLASS),
    profile([[0.27, 1.5], [-0.99, 1.52], [-0.98, 1.57], [0.2, 1.56]], 1.52, WHITE),
    profile([[2.3, 0.32], [2.33, 0.45], [2.34, 0.45], [2.31, 0.32]], 1.7, TRIM), profile([[-2.31, 0.32], [-2.34, 0.48], [-2.33, 0.48], [-2.3, 0.32]], 1.7, TRIM),
    ...wheels([1.42, -1.42], 0.86, 0.34)
  ]);
  const carCabGeo = new THREE.BoxGeometry(0.01, 0.01, 0.01);
  // A van (5.8 m): sloped cab, tall cargo box, a glass windscreen and side windows in the cab.
  const vanGeo = vehicleGeo([
    profile([[-2.9, 0.35], [2.9, 0.35], [2.95, 0.7], [2.75, 1.05], [2.1, 2.05], [-2.9, 2.35]], 2.06, WHITE),
    profile([[2.72, 1.08], [2.12, 1.98], [1.6, 2.0], [1.6, 1.1]], 2.08, GLASS),
    ...wheels([1.9, -1.9], 0.94, 0.38)
  ]);
  // A bus (12 m): rounded nose, a long band of windows both sides, a windscreen, a destination sign.
  const busGeo = vehicleGeo([
    profile([[-6, 0.35], [6, 0.35], [6.05, 2.7], [5.85, 3.15], [-5.9, 3.15], [-6.02, 2.8]], 2.5, WHITE),
    { ...profile([[5.0, 1.25], [5.0, 2.65], [-5.6, 2.65], [-5.6, 1.25]], 2.54, GLASS), glow: 1 },
    profile([[6.06, 1.0], [6.06, 2.6], [5.96, 2.6], [5.96, 1.0]], 2.3, GLASS),
    { ...profile([[6.07, 2.68], [6.07, 3.0], [6.0, 3.0], [6.0, 2.68]], 1.6, [1.0, 0.72, 0.25]), glow: 1.6 },
    ...wheels([4.1, -3.6], 1.1, 0.48)
  ]);
  // Real-world car colours (white, silver, greys, black, blues, a copper, a green, a bronze, a burgundy, a teal). Never
  // the other side's red (isEnemyColour): red is theirs alone, so lamps and paint stay amber-red at most.
  const carPalette = [0xeef0f2, 0xb9bec4, 0x8a9099, 0x4a4f56, 0x16181c, 0x1f2a36, 0x2f4a6b, 0x5b7fa6, 0xc0601e, 0x1c3b2f, 0x6b5a45, 0x5a1f2a, 0x2a5a5c, 0xc7c9cc];
  // Body types, so no two streets of cars look alike: [length, height, width] scales of the base car.
  const CAR_KINDS = [[0.86, 1.02, 0.94], [1, 1, 1], [1.08, 0.98, 1], [1.04, 1.28, 1.08], [0.96, 0.86, 1.02], [1.12, 1.06, 1.04]];
  const carBodies = dyn(named(new THREE.InstancedMesh(carBodyGeo, std(0xffffff, { metalness: 0.55, roughness: 0.32, vertexColors: true }), CAP), 'car-bodies'));
  const carCabs = dyn(named(new THREE.InstancedMesh(carCabGeo, std(0x1a2129, { metalness: 0.8, roughness: 0.12 }), CAP), 'car-cabins'));
  const vans = dyn(named(new THREE.InstancedMesh(vanGeo, std(LIFE_COLOURS.van, { roughness: 0.45, vertexColors: true }), Math.max(1, Math.ceil(CAP * 0.15))), 'delivery-vans'));
  // Only the windows and the destination sign glow after dark (aGlow), never the paint.
  const busMat = std(LIFE_COLOURS.bus, { roughness: 0.4, vertexColors: true }); const busLit = { value: 0 };
  busMat.onBeforeCompile = (sh) => { sh.uniforms.uLit = busLit; sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aGlow;\nvarying vec3 vGlow;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;'); sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGlow;\nuniform float uLit;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow * uLit;'); };
  busMat.customProgramCacheKey = () => 'pg1-bus-windows';
  const buses = dyn(named(new THREE.InstancedMesh(busGeo, busMat, Math.max(1, Math.ceil(CAP * 0.12))), 'buses'));
  // Lights (1.24 look): a pair of lamps each end (one draw call each, as
  // before), brighter than white after dark so the glow pass takes them;
  // tail lamps flare to brake red when a vehicle slows or waits.
  const lampPair = (w, h, gap) => { const a = new THREE.BoxGeometry(w, h, 0.12); a.translate(-gap, 0, 0); const b = new THREE.BoxGeometry(w, h, 0.12); b.translate(gap, 0, 0); const ga = a.toNonIndexed(); const gb = b.toNonIndexed(); const n = ga.attributes.position.count + gb.attributes.position.count; const pos = new Float32Array(n * 3); const nor = new Float32Array(n * 3); pos.set(ga.attributes.position.array, 0); pos.set(gb.attributes.position.array, ga.attributes.position.count * 3); nor.set(ga.attributes.normal.array, 0); nor.set(gb.attributes.normal.array, ga.attributes.position.count * 3); const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); return g; };
  const headMat = basic(LIFE_COLOURS.head); const tailMat = basic(0xffffff);
  const heads = dyn(named(new THREE.InstancedMesh(lampPair(0.42, 0.24, 0.62), headMat, CAP), 'car-lights'));
  const tails = dyn(named(new THREE.InstancedMesh(lampPair(0.36, 0.2, 0.68), tailMat, CAP), 'car-lights'));
  const TAIL_RUN = new THREE.Color(0xa8420a); const TAIL_BRAKE = new THREE.Color(0xff6418);
  for (let i = 0; i < CAP; i++) tails.setColorAt(i, TAIL_RUN);
  // Desktop tiers: red tail reflections on wet streets, lit taxi roof signs.
  const richLights = !phone && !settings.legacy && !settings.leanCity;
  const tailGlareGeo = new THREE.PlaneGeometry(2.2, 9); tailGlareGeo.rotateX(-Math.PI / 2); tailGlareGeo.translate(0, 0.07, -5.5);
  const tailGlareMat = new THREE.MeshBasicMaterial({ map: softTex, color: 0xff6a20, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const tailGlare = richLights ? dyn(named(new THREE.InstancedMesh(tailGlareGeo, tailGlareMat, CAP), 'wet-road-tail-glare')) : null;
  const taxiSignGeo = new THREE.BoxGeometry(0.7, 0.22, 0.28); taxiSignGeo.translate(0, 1.6, -0.3);
  const TAXI_CAP = Math.max(1, Math.ceil(CAP * 0.2));
  const taxiSigns = richLights ? dyn(named(new THREE.InstancedMesh(taxiSignGeo, basic(LIFE_COLOURS.roof), TAXI_CAP), 'taxi-roof-signs')) : null;
  if (tailGlare) { tailGlare.frustumCulled = false; root.add(tailGlare); } if (taxiSigns) { taxiSigns.frustumCulled = false; root.add(taxiSigns); }
  const sprayGeo = new THREE.PlaneGeometry(2.2, 3.5); sprayGeo.rotateX(-Math.PI / 2); sprayGeo.translate(0, 0.5, -1.75);
  const sprayMat = new THREE.MeshBasicMaterial({ map: softTex, color: 0xc9d3dd, transparent: true, opacity: 0, depthWrite: false });
  const spray = dyn(named(new THREE.InstancedMesh(sprayGeo, sprayMat, CAP), 'road-spray'));
  // After dark headlights light the road ahead; on a wet night it is a glossy streak (one draw call).
  const glareGeo = new THREE.PlaneGeometry(2.4, 14); glareGeo.rotateX(-Math.PI / 2); glareGeo.translate(0, 0.07, 9);
  const glareMat = new THREE.MeshBasicMaterial({ map: softTex, color: LIFE_COLOURS.head, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const glare = dyn(named(new THREE.InstancedMesh(glareGeo, glareMat, CAP), 'wet-road-glare'));
  root.add(glare);
  for (let i = 0; i < CAP; i++) carBodies.setColorAt(i, new THREE.Color(carPalette[i % carPalette.length]));
  for (const m of [carBodies, carCabs, vans, buses, heads, tails, spray]) root.add(m);
  carCabs.visible = false; // the glass house is part of the car's own model now (one draw call)

  // Signals at every junction of the simulated network: one head per approach.
  const juncs = traffic.net.junctions.filter((j) => !j.edge);
  const approaches = [];
  for (const j of juncs) for (const l of j.in) approaches.push({ j, l });
  const tlPoles = named(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.15, 5, 6), std(0x2b2f36), approaches.length), 'traffic-light-poles');
  const tlLights = named(new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 8, 6), basic(0xffffff), approaches.length), 'traffic-lights');
  approaches.forEach(({ j, l }, i) => {
    // On the kerb at the stop line, to the left of the approaching lane.
    const s = l.stopAt; const x = l.from.x + l.dx * s + l.lx / LANE_OFFSET * (ROAD_W / 2 + 0.8); const z = l.from.z + l.dz * s + l.lz / LANE_OFFSET * (ROAD_W / 2 + 0.8);
    set(tlPoles, i, x, 2.5, z); set(tlLights, i, x, 5.2, z);
  });
  root.add(tlPoles); root.add(tlLights);
  const crossings = juncs.map((j) => [j.x, j.z]);

  // Bus shelters at the bus stops, on the pavement by the lane.
  const stops = traffic.net.links.filter((l) => l.busStop && !l.from.edge);
  const shelterGeo = new THREE.BoxGeometry(1.6, 2.6, 4); shelterGeo.translate(0, 1.3, 0);
  const shelters = named(new THREE.InstancedMesh(shelterGeo, std(LIFE_COLOURS.shelter, { transparent: true, opacity: 0.55, metalness: 0.4, roughness: 0.1 }), Math.max(1, stops.length)), 'bus-shelters');
  const stopPeople = [];
  stops.forEach((l, i) => {
    const ox = l.lx / LANE_OFFSET * (ROAD_W / 2 + 2.2); const oz = l.lz / LANE_OFFSET * (ROAD_W / 2 + 2.2);
    const x = l.from.x + l.dx * l.busStop.s + ox; const z = l.from.z + l.dz * l.busStop.s + oz;
    set(shelters, i, x, 0, z, l.dx ? Math.PI / 2 : 0);
    for (let p = 0; p < l.busStop.people; p++) stopPeople.push({ link: l, home: { x: x + (l.dx ? (p - 2) * 0.9 : 0), z: z + (l.dz ? (p - 2) * 0.9 : 0) }, x, z, board: 0, kerb: { x: l.from.x + l.dx * (l.busStop.s - 4) + ox * 0.82, z: l.from.z + l.dz * (l.busStop.s - 4) + oz * 0.82 } });
  });
  shelters.count = stops.length; root.add(shelters);

  // --- the tram: two lines on the viaduct, stations ---
  const viaLen = 2400;
  const via = named(new THREE.Mesh(new THREE.BoxGeometry(viaLen, 1.2, 9), std(0x9a9da3, { roughness: 0.8 })), 'tram-viaduct'); via.position.set(0, 15, TRAM_Z); root.add(via);
  const nPil = Math.round(viaLen / 40) + 1;
  const pillars = named(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.9, 1.1, 15, 10), std(0x8d9096, { roughness: 0.85 }), nPil), 'tram-pillars');
  for (let i = 0; i < nPil; i++) set(pillars, i, -viaLen / 2 + i * 40, 7.5, TRAM_Z);
  root.add(pillars);
  const platforms = named(new THREE.InstancedMesh(new THREE.BoxGeometry(100, 0.6, 3), std(0xb7babf, { roughness: 0.7 }), traffic.stations.length * 2), 'tram-platforms');
  traffic.stations.forEach((x, i) => { set(platforms, i * 2, x, 15.9, TRAM_Z - 6); set(platforms, i * 2 + 1, x, 15.9, TRAM_Z + 6); });
  root.add(platforms);
  // The tram (1.24 look): one model of the whole five-car set, not boxes.
  // Articulated cars with bellows between them, a raked cab nose with a
  // windscreen at each end (it runs both ways), a glazed window band and
  // glazed doors that light up after dark, a livery stripe, bogies, roof
  // equipment and a pantograph on alternate cars. One instance a tram, one
  // draw call. Built along z (cars 18 m, 0.6 m bellows), floor at y 0.
  const TRAM_CAR = 18; const TRAM_GAP = 0.6; const TRAM_SET = 5 * TRAM_CAR + 4 * TRAM_GAP;
  const rect = (z0, z1, y0, y1, w, col, glow = 0) => ({ ...profile([[z0, y0], [z1, y0], [z1, y1], [z0, y1]], w, col), glow });
  const LIVERY = [0.18, 0.43, 0.71]; const SHELL = [0.93, 0.94, 0.95]; const ROOFGREY = [0.42, 0.44, 0.47]; const BOGIE = [0.1, 0.1, 0.11]; const LAMP = [1, 0.97, 0.9];
  const tramParts = [];
  for (let c = 0; c < 5; c++) {
    const z0 = -TRAM_SET / 2 + c * (TRAM_CAR + TRAM_GAP); const z1 = z0 + TRAM_CAR; const zc = (z0 + z1) / 2;
    tramParts.push(
      rect(z0, z1, 0.35, 3.2, 2.62, SHELL),                                   // the body shell
      rect(z0 + 0.8, z1 - 0.8, 1.3, 2.7, 2.66, GLASS, 1),                     // the window band, lit inside after dark
      rect(zc - 5.4, zc - 3.8, 0.45, 2.75, 2.68, [0.12, 0.15, 0.18], 0.7),    // glazed doors, two a side
      rect(zc + 3.8, zc + 5.4, 0.45, 2.75, 2.68, [0.12, 0.15, 0.18], 0.7),
      rect(z0, z1, 0.62, 0.95, 2.67, LIVERY),                                 // the livery stripe
      rect(z0, z1, 2.82, 2.95, 2.67, LIVERY),                                 // and the cant rail
      ({ ...profile([[z0 + 0.3, 3.2], [z1 - 0.3, 3.2], [z1 - 0.6, 3.42], [z0 + 0.6, 3.42]], 2.3, SHELL) }), // the roof's curve
      rect(zc - 3.2, zc + 3.2, 3.42, 3.75, 1.5, ROOFGREY),                    // roof equipment
      rect(z0 + 2.2, z0 + 4.6, 0, 0.42, 2.2, BOGIE), rect(z1 - 4.6, z1 - 2.2, 0, 0.42, 2.2, BOGIE)
    );
    if (c % 2 === 0) tramParts.push(rect(zc - 0.1, zc + 0.1, 3.75, 4.6, 1.6, ROOFGREY), rect(zc - 0.7, zc + 0.7, 4.55, 4.65, 1.7, ROOFGREY)); // pantograph
    // Window mullions and the door seals (desktop tiers): the glass reads as windows, not a band.
    if (detailed) { for (let zz = z0 + 1.6; zz < z1 - 1.0; zz += 1.55) if (Math.abs(zz - (zc - 4.6)) > 1.0 && Math.abs(zz - (zc + 4.6)) > 1.0) tramParts.push(rect(zz - 0.07, zz + 0.07, 1.3, 2.7, 2.7, [0.2, 0.22, 0.25])); for (const dz of [-4.6, 4.6]) tramParts.push(rect(zc + dz - 0.04, zc + dz + 0.04, 0.45, 2.75, 2.71, [0.35, 0.37, 0.4])); }
    if (detailed && c % 2 === 0) tramParts.push(rect(zc - 0.9, zc + 0.9, 4.05, 4.15, 0.12, ROOFGREY), rect(zc - 0.5, zc + 0.5, 4.3, 4.4, 0.12, ROOFGREY)); // pantograph arms
    if (c < 4) tramParts.push(rect(z1, z1 + TRAM_GAP, 0.5, 3.0, 2.3, BOGIE));  // bellows
  }
  for (const s of [-1, 1]) {
    const e = s * TRAM_SET / 2; const f = (dz) => e + s * dz; const nose = (pts) => (s > 0 ? pts : pts.slice().reverse()).map(([dz, y]) => [f(dz), y]);
    tramParts.push(
      profile(nose([[0, 0.35], [0.9, 0.45], [1.25, 1.2], [1.1, 2.9], [0.6, 3.38], [0, 3.42]]), 2.5, SHELL),   // the raked cab nose
      { ...profile(nose([[0.05, 1.3], [1.28, 1.3], [1.13, 2.85], [0.62, 3.2], [0.05, 3.2]]), 2.2, GLASS), glow: 0.25 }, // windscreen
      rect(Math.min(f(0.9), f(1.27)), Math.max(f(0.9), f(1.27)), 0.6, 0.95, 2.52, LIVERY),
      ...[-0.85, 0.85].map((x) => { const l = rect(Math.min(f(1.0), f(1.3)), Math.max(f(1.0), f(1.3)), 0.75, 0.92, 0.4, LAMP, 2.4); l.g.translate(x, 0, 0); return l; }), // headlamps at the corners
      { ...rect(Math.min(f(0.7), f(1.0)), Math.max(f(0.7), f(1.0)), 2.95, 3.2, 1.3, [1, 0.72, 0.25]), glow: 1.6 } // destination sign
    );
  }
  const tramGeo = vehicleGeo(tramParts);
  const tramMat = std(0xffffff, { roughness: 0.38, metalness: 0.35, vertexColors: true }); const tramLit = { value: 0.2 };
  tramMat.onBeforeCompile = (sh) => { sh.uniforms.uLit = tramLit; sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aGlow;\nvarying vec3 vGlow;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;'); sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGlow;\nuniform float uLit;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow * uLit;'); };
  tramMat.customProgramCacheKey = () => 'pg1-tram-windows';
  const carriages = dyn(named(new THREE.InstancedMesh(tramGeo, tramMat, 2), 'tram'));
  root.add(carriages);

  // --- the river: boats in lanes, with wakes; moored boats rocking ---
  const wakeTex = (() => { const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128; const g = cv.getContext('2d'); for (let y = 0; y < 128; y++) { const kk = 1 - y / 128; const half = 4 + (y / 128) * 26; g.fillStyle = `rgba(255,255,255,${0.5 * kk})`; g.fillRect(32 - half, y, 3, 1); g.fillRect(32 + half - 3, y, 3, 1); } const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const wakeMat = new THREE.MeshBasicMaterial({ map: wakeTex, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
  const boats = traffic.boats;
  // Desktop tiers: modelled boats (in the same unit space as the boxes they
  // replace: 1 wide, 1 long, 2 high, scaled per boat): a hull with a pointed
  // bow, a dark bottom and white topsides, a teak gunwale; a cabin with a
  // lit window band between mullions, an overhanging roof and a mast.
  const boatGeos = detailed ? (() => {
    const plan = (inset = 0) => { const sh = new THREE.Shape(); const w = 0.5 - inset; sh.moveTo(-w, 0.5 - inset * 0.4); sh.lineTo(w, 0.5 - inset * 0.4); sh.lineTo(w, -0.12); sh.lineTo(w * 0.55, -0.4); sh.lineTo(0, -0.5 + inset * 0.6); sh.lineTo(-w * 0.55, -0.4); sh.lineTo(-w, -0.12); return sh; }; // closed by the shape itself (a repeated point makes zero-area faces: NaN normals)
    const layer = (y0, y1, inset, col) => { const g = new THREE.ExtrudeGeometry(plan(inset), { depth: y1 - y0, bevelEnabled: false, curveSegments: 1 }); g.rotateX(-Math.PI / 2); g.translate(0, y0, 0); return { g, col }; };
    const hull = vehicleGeo([layer(-1, -0.35, 0.04, [0.09, 0.13, 0.2]), layer(-0.35, 0.8, 0, [0.92, 0.93, 0.94]), layer(0.8, 0.98, -0.015, [0.45, 0.3, 0.18]), layer(0.98, 1.0, 0.05, [0.7, 0.66, 0.6])]);
    const box = (x0, x1, y0, y1, z0, z1, col, glow = 0) => { const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0); g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); return { g, col, glow }; };
    const cab = [box(-0.5, 0.5, -1, -0.25, -0.5, 0.5, [0.94, 0.95, 0.96]), box(-0.49, 0.49, -0.25, 0.5, -0.49, 0.49, [0.16, 0.2, 0.24], 1), box(-0.55, 0.55, 0.5, 0.68, -0.56, 0.56, [0.9, 0.91, 0.92]), box(-0.03, 0.03, 0.68, 1.5, 0.2, 0.26, [0.75, 0.76, 0.78])];
    for (let k = -3; k <= 3; k++) cab.push(box(-0.505, 0.505, -0.25, 0.5, k * 0.14 - 0.012, k * 0.14 + 0.012, [0.9, 0.91, 0.92]));
    return { hull, cabin: vehicleGeo(cab) };
  })() : null;
  const boatCabMat = std(0x2a4a68, { emissive: LIFE_COLOURS.cabin, emissiveIntensity: 0.8 });
  const boatLit = { value: 0.3 };
  if (boatGeos) { boatCabMat.color.setHex(0xffffff); boatCabMat.vertexColors = true; boatCabMat.emissive.setHex(0x000000); boatCabMat.onBeforeCompile = (sh) => { sh.uniforms.uLit = boatLit; sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aGlow;\nvarying vec3 vGlow;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;'); sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGlow;\nuniform float uLit;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow * uLit;'); }; boatCabMat.customProgramCacheKey = () => 'pg1-boat-cabin'; }
  const boatHull = dyn(named(new THREE.InstancedMesh(boatGeos ? boatGeos.hull : new THREE.BoxGeometry(1, 2, 1), boatGeos ? std(0xffffff, { vertexColors: true, roughness: 0.35 }) : std(LIFE_COLOURS.boat), Math.max(1, boats.length)), 'water-taxis-and-ferries'));
  const boatCabin = dyn(named(new THREE.InstancedMesh(boatGeos ? boatGeos.cabin : new THREE.BoxGeometry(1, 2, 1), boatCabMat, Math.max(1, boats.length)), 'boat-cabins'));
  const wakeGeo = new THREE.PlaneGeometry(10, 34); wakeGeo.rotateX(-Math.PI / 2); wakeGeo.translate(0, 0, -24);
  const wakes = dyn(named(new THREE.InstancedMesh(wakeGeo, wakeMat, Math.max(1, boats.length)), 'boat-wakes'));
  root.add(boatHull); root.add(boatCabin); root.add(wakes);
  // Desktop tiers: a soft pool of the boat's light on the water after dark.
  const boatPoolGeo = new THREE.PlaneGeometry(12, 26); boatPoolGeo.rotateX(-Math.PI / 2);
  const boatPoolMat = new THREE.MeshBasicMaterial({ map: softTex, color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const boatPools = !phone && !settings.legacy && !settings.leanCity ? dyn(named(new THREE.InstancedMesh(boatPoolGeo, boatPoolMat, Math.max(1, boats.length)), 'boat-light-pools')) : null;
  if (boatPools) { boatPools.frustumCulled = false; root.add(boatPools); }
  const moored = named(new THREE.InstancedMesh(new THREE.BoxGeometry(3.6, 1.6, 13), std(LIFE_COLOURS.boat, { roughness: 0.4 }), 4), 'moored-boats');
  const pierX = 205; root.add(moored);

  // --- the sky: airliners on approach and departure over the skyline (one
  // mesh each: fuselage, wings, tailplane and fin), a helicopter along the
  // river (not on a phone), birds at dusk, gulls, pigeons. Ambient: never an
  // event, never counted or captioned. Their lights (red left, green right,
  // a white tail strobe, landing lights at night) share one instanced mesh.
  const merged = (parts) => { const gs = parts.map((g) => g.toNonIndexed()); const n = gs.reduce((a, g) => a + g.attributes.position.count, 0); const pos = new Float32Array(n * 3); const nor = new Float32Array(n * 3); let o = 0; for (const g of gs) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; g.dispose(); } const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); return out; };
  const box = (w, h, d, x = 0, y = 0, z = 0) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g; };
  const airlinerGeo = merged([box(4, 3.6, 38), box(36, 0.6, 6, 0, -0.6, 1), box(13, 0.4, 3.2, 0, 0.8, -16.5), box(0.5, 6, 4.5, 0, 3.6, -16.5), box(2.2, 2.2, 4, 7, -1.8, 2), box(2.2, 2.2, 4, -7, -1.8, 2)]);
  // Straight flight lines across the view of the city (x east, z south,
  // metres), looping: [from, to, speed m/s]. Altitudes descend on approach
  // and climb on departure.
  const ROUTES = [
    { from: [3200, 700, -1500], to: [-3200, 260, 700], v: 72 },
    { from: [-3000, 230, 500], to: [3000, 950, -1700], v: 80 },
    { from: [-3400, 1150, -2600], to: [3400, 1050, -900], v: 110 }
  ];
  const planes = ROUTES.slice(0, phone ? 2 : 3).map((rt, i) => {
    const d = [rt.to[0] - rt.from[0], rt.to[2] - rt.from[2]]; const len = Math.hypot(d[0], d[1]);
    return { o: [rt.from[0], rt.from[2]], dir: [d[0] / len, d[1] / len], len, alt0: rt.from[1], alt1: rt.to[1], v: rt.v, s: (0.2 + i * 0.33) * len, gap: 0 };
  });
  // Lift a flight line until it clears every roof under it (PG1's tower included) by 80 m.
  const TOWER_CLEAR = (world.tip && world.tip.y ? world.tip.y : 320) + 80;
  const clearRoute = (p) => {
    let lift = 0;
    for (let s2 = 0; s2 <= p.len; s2 += 40) {
      const x = p.o[0] + p.dir[0] * s2; const z = p.o[1] + p.dir[1] * s2; const y = p.alt0 + (p.alt1 - p.alt0) * (s2 / p.len);
      const top = Math.max(world.obstacles && world.obstacles.topAt ? world.obstacles.topAt(x, z, 40) : 0, Math.hypot(x, z) < 120 ? TOWER_CLEAR - 80 : 0);
      if (top > 0) lift = Math.max(lift, top + 80 - y);
    }
    if (lift > 0) { p.alt0 += lift; p.alt1 += lift; }
    return p;
  };
  planes.forEach(clearRoute);
  const planeAt = (p) => { const k2 = p.s / p.len; return { x: p.o[0] + p.dir[0] * p.s, y: p.alt0 + (p.alt1 - p.alt0) * k2, z: p.o[1] + p.dir[1] * p.s, heading: Math.atan2(p.dir[0], p.dir[1]), pitch: -Math.atan2(p.alt1 - p.alt0, p.len) }; };
  const planeBody = named(new THREE.InstancedMesh(airlinerGeo, std(0xe4e8ec, { roughness: 0.35, emissive: 0x9aa3ad, emissiveIntensity: 0.3 }), planes.length), 'aircraft');
  // The helicopter's loop along the river, at least 30 m over the tallest roof under it.
  const heliPath = (a) => [Math.cos(a) * 468, 120 + Math.sin(a) * 80];
  let heliAlt = 160; if (world.obstacles && world.obstacles.topAt) for (let k = 0; k < 96; k++) { const [hx, hz] = heliPath((k / 96) * Math.PI * 2); heliAlt = Math.max(heliAlt, world.obstacles.topAt(hx, hz, 20) + 30); }
  const heli = !phone && !settings.leanCity ? { a: 0, alt: heliAlt, v: 0.11 } : null;
  const heliBody = heli ? named(new THREE.InstancedMesh(merged([box(3, 3, 9), box(0.8, 0.8, 9, 0, 0.6, -8), box(0.3, 2.4, 1.6, 0, 1.6, -12.4)]), std(0x2f4a6b, { roughness: 0.4, emissive: 0x1a2a3a, emissiveIntensity: 0.2 }), 1), 'helicopter') : null;
  const heliRotor = heli ? named(new THREE.InstancedMesh(box(22, 0.15, 0.8), basic(0x9aa3ad, { transparent: true, opacity: 0.55 }), 2), 'helicopter-rotor') : null;
  const LIGHTS_PER_PLANE = 5; // red, green, strobe, two landing lights
  const nLights = planes.length * LIGHTS_PER_PLANE + (heli ? 3 : 0);
  const strobeMat = basic(0xffffff, { transparent: true, opacity: 1 });
  const strobes = named(new THREE.InstancedMesh(new THREE.SphereGeometry(1.6, 8, 6), strobeMat, nLights), 'aircraft-strobes');
  const lightCol = new THREE.Color();
  for (let i = 0; i < nLights; i++) { const kind = i < planes.length * LIGHTS_PER_PLANE ? i % LIGHTS_PER_PLANE : (i - planes.length * LIGHTS_PER_PLANE); strobes.setColorAt(i, lightCol.setHex(kind === 0 ? 0xff6a20 : kind === 1 ? 0x30ff6a : kind === 2 ? 0xffffff : 0xfff3d6)); }
  strobes.name = 'aircraft-lights';
  root.add(planeBody); root.add(strobes); if (heli) { root.add(heliBody); root.add(heliRotor); }
  // They move far from where they started: never culled by stale bounds.
  for (const m of [planeBody, strobes, heliBody, heliRotor]) if (m) m.frustumCulled = false;
  // The lights of every boat on the river (not on a phone's lean city):
  // a white masthead, red on the left, green on the right; one mesh.
  const boatLights = !phone && !settings.leanCity ? named(new THREE.InstancedMesh(new THREE.SphereGeometry(detailed ? 0.28 : 0.45, 8, 6), basic(0xffffff), Math.max(1, boats.length * 3)), 'boat-lights') : null;
  if (boatLights) boatLights.frustumCulled = false;
  if (boatLights) { for (let i = 0; i < boats.length * 3; i++) boatLights.setColorAt(i, lightCol.setHex(i % 3 === 0 ? 0xfff3d6 : i % 3 === 1 ? 0xff6a20 : 0x30ff6a)); root.add(boatLights); }
  const nBirds = phone ? 24 : 60;
  const birdPos = new Float32Array(nBirds * 3); const birds = [];
  for (let i = 0; i < nBirds; i++) birds.push({ a: r() * Math.PI * 2, rad: 160 + r() * 260, alt: 60 + r() * 70, speed: 0.04 + r() * 0.03, ph: r() * 6 });
  const birdGeo = new THREE.BufferGeometry(); birdGeo.setAttribute('position', new THREE.BufferAttribute(birdPos, 3));
  const birdPts = named(new THREE.Points(birdGeo, new THREE.PointsMaterial({ color: 0x1a1d22, size: 1.6, transparent: true, opacity: 0, depthWrite: false })), 'birds');
  root.add(birdPts);
  // Gulls: two wings each, gliding and flapping over the river.
  const nGulls = Math.round(28 * Math.max(0.4, k));
  const gulls = []; for (let i = 0; i < nGulls; i++) gulls.push({ x: (r() - 0.5) * 900, z: RIVER.z + (r() - 0.5) * 70, y: 14 + r() * 30, a: r() * 6.28, turn: (r() - 0.5) * 0.4, speed: 7 + r() * 4, ph: r() * 6 });
  const wingGeo = new THREE.PlaneGeometry(0.9, 0.35); wingGeo.rotateX(-Math.PI / 2); wingGeo.translate(0.45, 0, 0);
  // Both wings in one instanced mesh (one draw call): wing i*2 and i*2+1.
  const gullWings = dyn(named(new THREE.InstancedMesh(wingGeo, basic(LIFE_COLOURS.gull, { side: THREE.DoubleSide }), nGulls * 2), 'seagulls'));
  root.add(gullWings);
  // Pigeons on rooftop edges, now and then hopping.
  const roofs = (world.roofSpots || []).filter((s) => Math.hypot(s.x, s.z) < 600).slice(0, phone ? 12 : 40);
  const pigeons = []; for (const s of roofs) for (let j = 0; j < 3; j++) pigeons.push({ x: s.x + (r() - 0.5) * s.w * 0.8, y: s.y + 0.2, z: s.z + s.w * 0.4 * (r() < 0.5 ? -1 : 1), ph: r() * 20 });
  const pigeonGeo = new THREE.SphereGeometry(0.22, 6, 4); pigeonGeo.scale(1, 0.8, 1.5);
  const pigeonMesh = dyn(named(new THREE.InstancedMesh(pigeonGeo, std(LIFE_COLOURS.pigeon), Math.max(1, pigeons.length)), 'rooftop-pigeons'));
  root.add(pigeonMesh);

  // --- people ---
  const nWalk = Math.round(1100 * k);
  const people = [];
  for (let i = 0; i < nWalk; i++) {
    const kind = r();
    if (kind < 0.3) people.push({ ring: PLAZA_R - 2 - r() * 10, a: r() * Math.PI * 2, speed: (0.02 + r() * 0.02) * (r() < 0.5 ? 1 : -1) });
    else if (kind < 0.45) people.push({ bank: r() < 0.5 ? -1 : 1, pos: (r() - 0.5) * 1400, speed: (0.9 + r() * 0.6) * (r() < 0.5 ? 1 : -1) });
    else if (kind < 0.51) people.push({ bridge: true, pos: RIVER.z + (r() - 0.5) * 100, speed: (0.9 + r() * 0.5) * (r() < 0.5 ? 1 : -1), side: r() < 0.5 ? -9.2 : 9.2 });
    else { const alongX = r() < 0.5; const lane = (Math.floor(r() * 11) - 5) * GRID + (alongX ? -40 : 0) + (r() < 0.5 ? -1 : 1) * (ROAD_W / 2 + 2); if (alongX && inRiver(lane)) { i--; continue; } people.push({ alongX, lane, pos: (r() - 0.5) * 1600, speed: (0.9 + r() * 0.6) * (r() < 0.5 ? 1 : -1) }); }
  }
  // The café tables and the buskers are people too.
  const cafes = []; for (let i = 0; i < (phone ? 6 : 14); i++) { const a = 0.6 + (i / 14) * 1.9; cafes.push({ x: Math.cos(a) * (PLAZA_R - 14), z: Math.sin(a) * (PLAZA_R - 14) }); }
  const buskers = [{ x: -12, z: 46 }, { x: -10.6, z: 47.2 }, { x: 14, z: 47 }];
  const zebraPeds = traffic.peds;
  const nFig = people.length + zebraPeds.length + stopPeople.length + cafes.length * 2 + buskers.length + 4;
  // Low-poly figures on Low and on a phone's Medium (settings.lowFigures).
  const personGeo = personGeometry(THREE, { low: !!settings.legacy || !!settings.lowFigures });
  personGeo.setAttribute('aSkin', personSkins(THREE, nFig));
  const figures = dyn(named(new THREE.InstancedMesh(personGeo, personMaterial(THREE), nFig), 'pedestrians'));
  for (let i = 0; i < nFig; i++) figures.setColorAt(i, new THREE.Color(LIFE_COLOURS.figure[i % LIFE_COLOURS.figure.length]));
  root.add(figures);
  // Near the camera, on the High, Cinematic and Showcase tiers only: the
  // detailed walkers (kingdom-people.js: limbs with a walk cycle, varied
  // clothes, heights and bags). A phone keeps the light figures alone.
  const walkCap = !detailed ? 0 : settings.profile === 'showcase' ? WALKER_CAP.showcase : settings.tier === 'cinematic' ? WALKER_CAP.cinematic : WALKER_CAP.balanced;
  let walkers = null; let walkAttr = null;
  if (walkCap) {
    const wg = walkerGeometry(THREE); walkAttr = walkerAttributes(THREE, walkCap);
    wg.setAttribute('aWalk', walkAttr.walk); wg.setAttribute('aLegs', walkAttr.legs); wg.setAttribute('aSkin', walkAttr.skin); wg.setAttribute('aHair', walkAttr.hair);
    walkers = dyn(named(new THREE.InstancedMesh(wg, walkerMaterial(THREE), walkCap), 'pedestrians-near'));
    walkers.count = 0; walkers.frustumCulled = false; walkers.castShadow = true;
    walkers.setColorAt(0, new THREE.Color(0xffffff)); root.add(walkers);
  }
  const walkCol = new THREE.Color();
  // Modelled shop fronts (kingdom-shops.js) on the same tiers: round the
  // plaza's edge, the shopping centre, the shop parade and the podiums near the centre.
  const shops = detailed ? createShops(THREE, root, [...plazaArcade(PLAZA_R), ...facadeUnits((world.retail || []).filter((p) => p.kind || Math.hypot(p.x, p.z) < 460))]) : null;
  const umbGeo = new THREE.ConeGeometry(0.55, 0.3, 8); umbGeo.translate(0, 2.05, 0);
  const umbrellas = dyn(named(new THREE.InstancedMesh(umbGeo, std(0xffffff, { roughness: 0.6 }), nFig), 'umbrellas'));
  for (let i = 0; i < nFig; i++) umbrellas.setColorAt(i, new THREE.Color(LIFE_COLOURS.umbrella[i % LIFE_COLOURS.umbrella.length]));
  root.add(umbrellas);
  const dogGeo = new THREE.BoxGeometry(0.22, 0.3, 0.6); dogGeo.translate(0, 0.3, 0);
  const dogs = dyn(named(new THREE.InstancedMesh(dogGeo, std(LIFE_COLOURS.dog), Math.max(1, zebraPeds.filter((p) => p.dog).length + 6)), 'dogs-on-leads'));
  root.add(dogs);
  // Café tables and parasols; the buskers' instrument cases.
  const tables = named(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.5, 0.75, 10), std(0x3a3f46, { metalness: 0.5 }), cafes.length), 'cafe-tables');
  const parasolGeo = new THREE.ConeGeometry(1.6, 0.5, 10); parasolGeo.translate(0, 2.4, 0);
  const parasols = named(new THREE.InstancedMesh(parasolGeo, std(LIFE_COLOURS.parasol, { roughness: 0.8 }), cafes.length), 'cafe-parasols');
  cafes.forEach((c, i) => { set(tables, i, c.x, 0.4, c.z); set(parasols, i, c.x, 0, c.z); });
  root.add(tables); root.add(parasols);
  const cases = named(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.15, 0.35), std(0x1f2a36)), 'busker-case'); cases.position.set(-11.2, 0.1, 45); root.add(cases);
  // Cyclists on the embankment cycle tracks.
  const nBikes = Math.round(40 * Math.max(0.3, k));
  const bikes = []; for (let i = 0; i < nBikes; i++) { const north = i % 2 === 0; bikes.push({ z: north ? RIVER.z - RIVER.half - 4.2 : RIVER.z + RIVER.half + 4.2, dir: north ? 1 : -1, x: -700 + (i >> 1) * (1400 / (nBikes / 2)), v: 4.5 + r() * 2, v0: 4.5 + r() * 2 }); }
  const bikeGeo = new THREE.BoxGeometry(0.12, 0.7, 1.7); bikeGeo.translate(0, 0.45, 0);
  const bikeMesh = dyn(named(new THREE.InstancedMesh(bikeGeo, std(LIFE_COLOURS.bike, { metalness: 0.6 }), nBikes), 'cyclists'));
  const riderGeo = new THREE.CapsuleGeometry(0.24, 0.8, 3, 6); riderGeo.translate(0, 1.35, 0.1);
  const riders = dyn(named(new THREE.InstancedMesh(riderGeo, std(0x36454f, { roughness: 0.9 }), nBikes), 'cyclists-riders'));
  root.add(bikeMesh); root.add(riders);
  // Flags on the plaza that blow in the wind.
  const flagN = 6;
  const flagPoles = named(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.1, 12, 6), std(0xd8dde3, { metalness: 0.7 }), flagN), 'flag-poles');
  const flagGeo = new THREE.PlaneGeometry(2.6, 1.6, 6, 1); flagGeo.translate(1.3, 0, 0);
  const flagMat = std(LIFE_COLOURS.flag, { side: THREE.DoubleSide, roughness: 0.8 });
  const flagWind = { uTime: { value: 0 }, uWind: { value: 0 } };
  flagMat.onBeforeCompile = (sh) => { Object.assign(sh.uniforms, flagWind); sh.vertexShader = 'uniform float uTime;\nuniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  float fx = position.x / 2.6;\n  transformed.z += sin(uTime * (2.0 + uWind * 6.0) - position.x * 2.2) * fx * (0.12 + uWind * 0.55);\n  transformed.y -= fx * (1.0 - min(1.0, 0.2 + uWind * 1.6)) * 0.9;'); };
  flagMat.customProgramCacheKey = () => 'pg1-flag-wind';
  const flags = named(new THREE.InstancedMesh(flagGeo, flagMat, flagN), 'plaza-flags');
  for (let i = 0; i < flagN; i++) { const a = -0.5 + i * 0.2; const x = Math.sin(a) * (PLAZA_R + 3); const z = Math.cos(a) * (PLAZA_R + 3); set(flagPoles, i, x, 6, z); set(flags, i, x, 11, z); }
  root.add(flagPoles); root.add(flags);

  // --- rooftops: steam, a radar, a crane ---
  const spots = (world.roofSpots || []).filter((s) => Math.hypot(s.x, s.z) < 700);
  // No steam sprites on a phone's Medium (settings.ambientSprites false): 18 draw calls.
  const vents = settings.legacy || settings.ambientSprites === false ? [] : spots.slice(4, phone ? 10 : 20);
  const steamMat = new THREE.SpriteMaterial({ map: softTex, color: LIFE_COLOURS.steam, transparent: true, opacity: 0.25, depthWrite: false });
  const steam = [];
  for (const v of vents) for (let j = 0; j < 3; j++) { const sp = named(new THREE.Sprite(steamMat.clone()), 'rooftop-steam'); sp.position.set(v.x, v.y + 2, v.z); root.add(sp); steam.push({ sp, base: v, ph: j / 3 }); }
  let radar = null;
  if (spots[2] && !settings.legacy && !settings.leanCity) {
    radar = named(new THREE.Group(), 'rooftop-radar');
    const dish = named(new THREE.Mesh(new THREE.BoxGeometry(9, 2.2, 0.4), std(0xd8dde3, { metalness: 0.7 })), 'rooftop-radar-dish'); dish.position.y = 3; radar.add(dish);
    const post = named(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 3, 8), std(0x2b2f36)), 'rooftop-radar-post'); post.position.y = 1.5; radar.add(post);
    radar.position.set(spots[2].x, spots[2].y, spots[2].z - spots[2].w * 0.2); root.add(radar);
  }
  let craneLight = null;
  const cs = spots.find((s) => s.ring === 'near' && s.h < 110) || spots[6];
  if (cs && !settings.legacy && !settings.leanCity) {
    const crane = named(new THREE.Group(), 'construction-crane');
    const cm = std(LIFE_COLOURS.crane, { metalness: 0.4 });
    const mast = named(new THREE.Mesh(new THREE.BoxGeometry(1.4, 46, 1.4), cm), 'construction-crane-mast'); mast.position.y = 23; crane.add(mast);
    const jib = named(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 48), cm), 'construction-crane-jib'); jib.position.set(0, 46, 12); crane.add(jib);
    const cw = named(new THREE.Mesh(new THREE.BoxGeometry(2.5, 2, 3), std(0x2b2f36)), 'construction-crane-weight'); cw.position.set(0, 45, -10); crane.add(cw);
    craneLight = named(new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6), basic(LIFE_COLOURS.strobe)), 'construction-crane-light'); craneLight.position.y = 47.5; crane.add(craneLight);
    crane.position.set(cs.x + cs.w * 0.25, cs.y, cs.z); crane.rotation.y = 0.6; root.add(crane);
  }

  // --- street: lamps with light pools, pavements and kerbs, crossings, manholes ---
  const lampSpots = [];
  for (let i = -4; i <= 4; i++) for (let d = -640; d <= 640; d += 40) { const x = i * GRID + ROAD_W / 2 + 1.5; if (!inRiver(d) && Math.hypot(x, d) > PLAZA_R + 6) lampSpots.push([x, d]); const z = i * GRID - 40 + ROAD_W / 2 + 1.5; if (!inRiver(z)) lampSpots.push([d, z]); }
  const lampsN = Math.round(lampSpots.length * (phone ? 0.4 : 1));
  const lampPoles = named(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.16, 8, 6), std(0x2b2f36), lampsN), 'street-lamp-posts');
  const lampHeadMat = basic(0x6a6252);
  const lampHeads = named(new THREE.InstancedMesh(new THREE.SphereGeometry(0.45, 8, 6), lampHeadMat, lampsN), 'street-lamps');
  const poolMat = new THREE.MeshBasicMaterial({ map: softTex, color: LIFE_COLOURS.lamp, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const pools = named(new THREE.InstancedMesh(new THREE.PlaneGeometry(14, 14), poolMat, lampsN), 'street-light-pools');
  for (let i = 0; i < lampsN; i++) { const [x, z] = lampSpots[Math.floor(i * lampSpots.length / lampsN)]; set(lampPoles, i, x, 4, z); set(lampHeads, i, x, 8.1, z); set(pools, i, x - 2, 0.09, z, 0, 1, 1, 1, -Math.PI / 2); }
  root.add(lampPoles); root.add(lampHeads); root.add(pools);
  const paveMat = std(0x7d8086, { roughness: 0.9 }); const kerbMat = std(0xa7aaaf, { roughness: 0.8 });
  const segs = [];
  for (let i = -5; i <= 5; i++) { for (const s of [-1, 1]) { const x = i * GRID + s * (ROAD_W / 2 + 1.75); segs.push(['ns', x, -840 + 0, RIVER.z - RIVER.half - 2]); segs.push(['ns', x, RIVER.z + RIVER.half + 2, 840]); const z = i * GRID - 40 + s * (ROAD_W / 2 + 1.75); if (!inRiver(z)) segs.push(['ew', z, -840, 840]); } }
  const paveGeo = new THREE.PlaneGeometry(1, 1); paveGeo.rotateX(-Math.PI / 2);
  const pave = named(new THREE.InstancedMesh(paveGeo, paveMat, segs.length), 'pavements');
  const kerb = named(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.18, 0.25), kerbMat, segs.length), 'kerbs');
  segs.forEach(([dir, c, a, b], i) => { const len = b - a; const mid = (a + b) / 2; if (dir === 'ns') { set(pave, i, c, 0.07, mid, 0, 3.5, 1, len); set(kerb, i, c - Math.sign(c || 1) * 0, 0.09, mid, Math.PI / 2, len, 1, 1); } else { set(pave, i, mid, 0.07, c, 0, len, 1, 3.5); set(kerb, i, mid, 0.09, c, 0, len, 1, 1); } });
  root.add(pave); root.add(kerb);
  // Zebras on every arm of every junction (where the pedestrian phase
  // crosses), and the stop lines behind them.
  const stripes = [];
  for (const z of traffic.zebras) {
    const R = z.rect;
    for (let s = -3; s <= 3; s++) {
      // [x, z, size along x, size along z]: stripes run with the traffic.
      if (z.arm.dx) stripes.push([(R.minX + R.maxX) / 2, z.j.z + s * 2.1, ZEBRA_W, 1]);
      else stripes.push([z.j.x + s * 2.1, (R.minZ + R.maxZ) / 2, 1, ZEBRA_W]);
    }
  }
  const flatGeo = new THREE.PlaneGeometry(1, 1); flatGeo.rotateX(-Math.PI / 2);
  const zebra = named(new THREE.InstancedMesh(flatGeo, basic(0xcfcab8), Math.max(1, stripes.length)), 'zebra-crossings');
  stripes.forEach(([x, z, sx, sz], i) => set(zebra, i, x, 0.08, z, 0, sx, 1, sz));
  root.add(zebra);
  const stopLines = named(new THREE.InstancedMesh(flatGeo, basic(0xe4e0d2), Math.max(1, approaches.length)), 'stop-lines');
  approaches.forEach(({ l }, i) => { const s = l.stopAt; const x = l.from.x + l.dx * s + l.lx * (ROAD_W / 4) / LANE_OFFSET; const z = l.from.z + l.dz * s + l.lz * (ROAD_W / 4) / LANE_OFFSET; set(stopLines, i, x, 0.085, z, 0, l.dx ? 0.4 : ROAD_W / 2 - 0.4, 1, l.dx ? ROAD_W / 2 - 0.4 : 0.4); });
  root.add(stopLines);
  const manholes = named(new THREE.InstancedMesh(new THREE.CircleGeometry(0.4, 12), std(0x202328, { metalness: 0.6, roughness: 0.4 }), crossings.length), 'manhole-covers');
  crossings.forEach(([x, z], i) => set(manholes, i, x + 4, 0.07, z - 5, 0, 1, 1, 1, -Math.PI / 2));
  root.add(manholes);
  // Plaza: two fountains and benches.
  const fountainMat = new THREE.MeshStandardMaterial({ color: 0x2c5a7a, roughness: 0.1, metalness: 0.3, emissive: 0x16304a, emissiveIntensity: 0.6 });
  const sprays = [];
  for (const fx of (settings.legacy || settings.leanCity ? [-22] : [-22, 22])) {
    const basin = named(new THREE.Mesh(new THREE.CylinderGeometry(5, 5.3, 0.8, 24), std(0x9a9da3)), 'plaza-fountain'); basin.position.set(fx, 0.4, 32); root.add(basin);
    const water = named(new THREE.Mesh(new THREE.CircleGeometry(4.6, 24), fountainMat), 'plaza-fountain-water'); water.rotation.x = -Math.PI / 2; water.position.set(fx, 0.82, 32); root.add(water);
    const n = phone ? 40 : 120; const p = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const pts = named(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xcfe8ff, size: 0.25, transparent: true, opacity: 0.8, depthWrite: false })), 'plaza-fountain-spray'); root.add(pts);
    sprays.push({ fx, p, geo, n });
  }
  const benchN = 16;
  const benches = named(new THREE.InstancedMesh(new THREE.BoxGeometry(2, 0.5, 0.6), std(0x6b5a45), benchN), 'plaza-benches');
  for (let i = 0; i < benchN; i++) { const a = (i / benchN) * Math.PI * 2; set(benches, i, Math.cos(a) * (PLAZA_R - 4), 0.45, Math.sin(a) * (PLAZA_R - 4), -a + Math.PI / 2); }
  root.add(benches);


  const colourOf = () => [LIFE_COLOURS.head, LIFE_COLOURS.tail, LIFE_COLOURS.taxi, LIFE_COLOURS.bus, LIFE_COLOURS.van, LIFE_COLOURS.stop, LIFE_COLOURS.go, LIFE_COLOURS.wait, LIFE_COLOURS.strobe, LIFE_COLOURS.nav, LIFE_COLOURS.roof, LIFE_COLOURS.tram, LIFE_COLOURS.steam, LIFE_COLOURS.lamp, LIFE_COLOURS.crane, ...LIFE_COLOURS.figure, ...LIFE_COLOURS.umbrella, LIFE_COLOURS.boat, LIFE_COLOURS.ferry, LIFE_COLOURS.cabin, LIFE_COLOURS.bike, LIFE_COLOURS.parasol, LIFE_COLOURS.gull, LIFE_COLOURS.pigeon, LIFE_COLOURS.flag, LIFE_COLOURS.dog, LIFE_COLOURS.shelter, ...carPalette];
  const tlColour = { go: new THREE.Color(LIFE_COLOURS.go), wait: new THREE.Color(LIFE_COLOURS.wait), stop: new THREE.Color(LIFE_COLOURS.stop) };
  const lastSig = new Array(approaches.length).fill('');
  const tc = new THREE.Color();

  let density = 1;
  return {
    root,
    traffic,
    // Ambient people only (decoration): 1 all, less while frames run slow.
    setDensity(k) { density = Math.max(0.2, Math.min(1, Number(k) || 1)); },
    get density() { return density; },
    // For the tests: every colour the city's life uses.
    colours: colourOf,
    // Showcase (ambient only): put airliner `i` on a line through `point` that
    // reaches it in `inSeconds`; move boats to sail past `x` on both lanes.
    aircraftThrough(point, inSeconds = 2, i = 0) {
      const p = planes[i % planes.length]; if (!p) return null;
      const mid = p.len / 2; p.o = [point[0] - p.dir[0] * mid, point[2] - p.dir[1] * mid];
      const yMid = (p.alt0 + p.alt1) / 2; const dy = point[1] - yMid; p.alt0 += dy; p.alt1 += dy;
      clearRoute(p);
      p.s = Math.max(0, mid - p.v * inSeconds); return planeAt(p);
    },
    aircraft: () => planes.map(planeAt),
    // Showcase: where the trams are (the carriages run at 17.4 m on the elevated line).
    trams: () => traffic.trams.map((tr) => ({ x: tr.x, y: 17.4, z: tr.z, dir: tr.dir, v: tr.v })),
    vehicles: (n = 40) => traffic.vehicles.slice(0, n).map((v) => ({ x: v.x, y: v.y, z: v.z, heading: v.heading, type: v.type, id: v.id })),
    boatsPast(x, spread = 140) {
      const lanes = new Map(); for (const b of boats) { const l = lanes.get(b.lane) || []; l.push(b); lanes.set(b.lane, l); }
      for (const [lane, list] of lanes) list.slice(0, 3).forEach((b, k) => { b.x = x - lane.dir * (k * spread + 40); });
      return boats.filter((b) => Math.abs(b.x - x) < spread * 3).length;
    },
    counts: () => ({ walkersNear: walkers ? walkers.count : 0, shopUnits: shops ? shops.count : 0, vehicles: traffic.vehicles.length, people: people.length + zebraPeds.length + stopPeople.length + cafes.length * 2 + buskers.length, boats: traffic.boats.length, planes: planes.length, birds: nBirds, gulls: nGulls, cyclists: nBikes, trams: traffic.trams.length, overlaps: traffic.overlaps().length }),
    update(dt, t, { dark = 0, dusk = 0, light = 1, hour = 19.5, wet = 0, rain = 0, wind = 0, external = [], cam = null } = {}) {
      traffic.step(Math.min(dt, 0.1), { external });
      // Signal heads.
      let sigDirty = false;
      approaches.forEach(({ j, l }, i) => { const s = signalFor(j, l.axis, traffic.time); if (s !== lastSig[i]) { lastSig[i] = s; tlLights.setColorAt(i, tlColour[s]); sigDirty = true; } });
      if (sigDirty && tlLights.instanceColor) tlLights.instanceColor.needsUpdate = true;
      // Vehicles.
      let ci = 0; let vi = 0; let bi = 0; let si = 0; let gi = 0;
      const wetNight = wet > 0.3 && dark > 0.4;
      const nightRoad = dark > 0.4; let ti = 0;
      const vs = traffic.vehicles;
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        const { x, y, z, heading: ry } = v;
        if (v.type === 'bus') set(buses, bi++, x, y, z, ry);
        else if (v.type === 'van') set(vans, vi++, x, y, z, ry);
        else {
          // Compact, saloon, estate, SUV, a low sporty one, a big saloon: from the car's own id.
          const kk = CAR_KINDS[(v.id * 7 + 3) % CAR_KINDS.length]; set(carBodies, ci, x, y, z, ry, kk[2], kk[1], kk[0]); set(carCabs, ci, x, y, z, ry, kk[2] * 0.98, kk[1], kk[0] * (kk === CAR_KINDS[2] ? 1.18 : 1));
          if (v.type === 'taxi') carBodies.setColorAt(ci, tc.setHex(LIFE_COLOURS.taxi)); else carBodies.setColorAt(ci, tc.setHex(carPalette[v.id % carPalette.length]));
          ci++;
        }
        const fx = Math.sin(ry) * v.len / 2; const fz = Math.cos(ry) * v.len / 2;
        const lampY = v.type === 'bus' ? 1.1 : v.type === 'van' ? 1.0 : 0.75;
        set(heads, i, x + fx, y + lampY, z + fz, ry); set(tails, i, x - fx, y + lampY + 0.1, z - fz, ry);
        // Brake red while slowing or waiting at a light.
        const braking = v.v < 1.5 || (v._pv != null && v.v < v._pv - 0.02); v._pv = v.v;
        tails.setColorAt(i, braking ? TAIL_BRAKE : TAIL_RUN);
        // Spray off the tyres on a wet road, more the faster it goes.
        if (wet > 0.3 && v.v > 4) set(spray, si++, x - fx, y, z - fz, ry, 1, 1, Math.min(1.6, v.v / 8));
        if (nightRoad) { set(glare, gi, x + fx, y, z + fz, ry); if (tailGlare && wetNight) set(tailGlare, gi, x - fx, y, z - fz, ry); gi++; }
        if (taxiSigns && v.type === 'taxi' && ti < TAXI_CAP) set(taxiSigns, ti++, x, y, z, ry);
      }
      if (tails.instanceColor) tails.instanceColor.needsUpdate = true;
      // Lamp brightness: above white after dark (bloom), plain by day.
      headMat.color.setHex(LIFE_COLOURS.head).multiplyScalar(1 + 2.2 * dark); tailMat.color.setRGB(1, 1, 1).multiplyScalar(1 + 1.8 * dark);
      // Bus interiors lit after dark: the window band and the destination sign glow warm.
      busLit.value = 0.55 * Math.max(0, dark - 0.15);
      if (taxiSigns) { taxiSigns.count = ti; taxiSigns.material.color.setHex(LIFE_COLOURS.roof).multiplyScalar(1 + 1.5 * dark); taxiSigns.instanceMatrix.needsUpdate = true; }
      if (tailGlare) { tailGlare.count = wetNight ? gi : 0; tailGlare.visible = wetNight && gi > 0; tailGlareMat.opacity = wetNight ? 0.3 * Math.min(1, wet) * Math.min(1, dark) : 0; tailGlare.instanceMatrix.needsUpdate = true; }
      carBodies.count = carCabs.count = ci; vans.count = vi; buses.count = bi; heads.count = tails.count = vs.length; spray.count = si; glare.count = gi; glare.visible = gi > 0;
      glareMat.opacity = nightRoad ? (wetNight ? 0.38 * Math.min(1, wet) : 0.16) * Math.min(1, dark) : 0; glare.instanceMatrix.needsUpdate = true;
      sprayMat.opacity = Math.max(0, wet - 0.3) * 0.5 * (0.6 + rain * 0.4);
      if (carBodies.instanceColor) carBodies.instanceColor.needsUpdate = true;
      for (const m of [carBodies, carCabs, vans, buses, heads, tails, spray]) m.instanceMatrix.needsUpdate = true;
      // The trams.
      // One set a tram, its front at tr.x, floor on the viaduct deck (15.7 m); built along z, turned onto the line.
      traffic.trams.forEach((tr, n) => set(carriages, n, tr.x - tr.dir * (TRAM_SET / 2), 15.7, tr.z, Math.PI / 2));
      carriages.count = Math.min(2, traffic.trams.length); carriages.instanceMatrix.needsUpdate = true;
      tramLit.value = 0.02 + 0.85 * dark;
      // Boats on the river, and moored ones rocking.
      boats.forEach((b, i) => {
        const sc = b.len / 18;
        set(boatHull, i, b.x, -2.8, b.z, b.heading, b.wid, 1, b.len); set(boatCabin, i, b.x, -0.9, b.z, b.heading, b.wid * 0.8, 1, b.len * 0.42); set(wakes, i, b.x, -3.05, b.z, b.heading, sc, 1, sc * Math.min(1.2, 0.3 + b.v / 6));
      });
      boatHull.instanceMatrix.needsUpdate = true; boatCabin.instanceMatrix.needsUpdate = true; wakes.instanceMatrix.needsUpdate = true;
      if (boatGeos) boatLit.value = 0.2 + 0.75 * dark; else boatCabin.material.emissiveIntensity = 0.35 + 1.4 * dark;
      if (boatPools) { boats.forEach((b, i) => set(boatPools, i, b.x, -3.0, b.z, b.heading, b.wid / 6, 1, b.len / 18)); boatPools.instanceMatrix.needsUpdate = true; boatPoolMat.opacity = 0.22 * Math.max(0, dark - 0.2); boatPools.visible = dark > 0.25; }
      if (boatLights) {
        // Bright enough to read as lamps, never a blob of glow (the Showcase's bloom starts above 1).
        boatLights.material.color.setRGB(1, 1, 1).multiplyScalar(detailed ? 1 + 0.5 * dark : 1 + 2 * dark);
        boats.forEach((b, i) => { const s = Math.sin(b.heading); const c = Math.cos(b.heading); const side = b.wid * 0.52; set(boatLights, i * 3, b.x + s * b.len * 0.1, 1.6, b.z + c * b.len * 0.1); set(boatLights, i * 3 + 1, b.x + c * side, -0.6, b.z - s * side); set(boatLights, i * 3 + 2, b.x - c * side, -0.6, b.z + s * side); });
        boatLights.instanceMatrix.needsUpdate = true; boatLights.visible = dark > 0.25;
      }
      for (let j = 0; j < 4; j++) set(moored, j, pierX + (j % 2 ? 11 : -11), -2.9 + Math.sin(t * 0.9 + j) * 0.12, RIVER.z - RIVER.half + 10 + Math.floor(j / 2) * 18, 0, 1, 1, 1, Math.sin(t * 0.7 + j * 2) * 0.03, Math.sin(t * 0.8 + j) * 0.05);
      moored.instanceMatrix.needsUpdate = true;
      // Airliners along their flight lines (looping), and the helicopter along the river.
      const nightLights = dark > 0.35;
      planes.forEach((p, i) => {
        p.s += p.v * dt; if (p.s > p.len) p.s -= p.len;
        const q = planeAt(p); const s = Math.sin(q.heading); const c = Math.cos(q.heading);
        set(planeBody, i, q.x, q.y, q.z, q.heading, 1, 1, 1, q.pitch);
        const L = i * LIGHTS_PER_PLANE; const wing = 18; const blink = (t * 1.1 + i * 0.37) % 1 < 0.08;
        set(strobes, L, q.x + c * wing, q.y - 0.6, q.z - s * wing, 0, 0.45, 0.45, 0.45); set(strobes, L + 1, q.x - c * wing, q.y - 0.6, q.z + s * wing, 0, 0.45, 0.45, 0.45);
        set(strobes, L + 2, q.x - s * 19, q.y + 5, q.z - c * 19, 0, blink ? 0.7 : 0.0001, blink ? 0.7 : 0.0001, blink ? 0.7 : 0.0001);
        // Landing lights on approach (descending) after dark: bright, ahead of the wings.
        const land = nightLights && p.alt1 < p.alt0 ? 0.75 : 0.0001;
        set(strobes, L + 3, q.x + s * 19 + c * 4, q.y - 1.5, q.z + c * 19 - s * 4, 0, land, land, land); set(strobes, L + 4, q.x + s * 19 - c * 4, q.y - 1.5, q.z + c * 19 + s * 4, 0, land, land, land);
      });
      if (heli) {
        heli.a += heli.v * dt; const [hx, hz] = heliPath(heli.a); const hh = -heli.a + Math.PI;
        set(heliBody, 0, hx, heli.alt, hz, hh); set(heliRotor, 0, hx, heli.alt + 2.6, hz, t * 25); set(heliRotor, 1, hx, heli.alt + 2.6, hz, t * 25 + Math.PI / 2);
        const L = planes.length * LIGHTS_PER_PLANE; const blink = (t * 1.3) % 1 < 0.1 ? 1 : 0.0001;
        set(strobes, L, hx, heli.alt - 1.8, hz, 0, blink, blink, blink); set(strobes, L + 1, hx, heli.alt + 1.5, hz, 0, 0.6, 0.6, 0.6); set(strobes, L + 2, hx, heli.alt - 1.5, hz, 0, 0.6, 0.6, 0.6);
        heliBody.instanceMatrix.needsUpdate = true; heliRotor.instanceMatrix.needsUpdate = true;
      }
      planeBody.instanceMatrix.needsUpdate = true; strobes.instanceMatrix.needsUpdate = true;
      // Birds at dusk; gulls over the river; pigeons on the roofs.
      birdPts.material.opacity = Math.min(0.8, dusk * 1.2 + light * 0.2);
      birds.forEach((b, i) => { b.a += b.speed * dt; birdPos[i * 3] = Math.cos(b.a) * b.rad + Math.sin(t + b.ph) * 6; birdPos[i * 3 + 1] = b.alt + Math.sin(t * 2 + b.ph) * 3; birdPos[i * 3 + 2] = Math.sin(b.a) * b.rad - 60; });
      birdGeo.attributes.position.needsUpdate = true;
      gulls.forEach((g, i) => {
        g.a += (g.turn + Math.sin(t * 0.2 + g.ph) * 0.15) * dt; g.x += Math.sin(g.a) * (g.speed + wind * 5) * dt; g.z += Math.cos(g.a) * g.speed * dt;
        if (Math.abs(g.z - RIVER.z) > 50) g.a = Math.atan2(Math.sin(g.a), -Math.cos(g.a)); if (Math.abs(g.x) > 600) g.a = Math.atan2(-Math.sin(g.a), Math.cos(g.a));
        const flap = Math.sin(t * 7 + g.ph) * (Math.sin(t * 0.5 + g.ph) > 0.3 ? 0.6 : 0.08); const y = g.y + Math.sin(t * 0.6 + g.ph) * 2;
        set(gullWings, i * 2, g.x, y, g.z, g.a + Math.PI / 2, 1, 1, 1, 0, flap); set(gullWings, i * 2 + 1, g.x, y, g.z, g.a - Math.PI / 2, 1, 1, 1, 0, -flap);
      });
      gullWings.instanceMatrix.needsUpdate = true;
      pigeons.forEach((p, i) => { const hop = ((t + p.ph) % 9) < 0.35 ? Math.sin(((t + p.ph) % 9) / 0.35 * Math.PI) * 0.4 : 0; set(pigeonMesh, i, p.x, p.y + hop, p.z, p.ph); });
      pigeonMesh.instanceMatrix.needsUpdate = true;
      // People. Index fi runs over every figure; umbrellas follow some in the rain.
      let fi = 0; let di = 0;
      const umbShare = Math.min(0.85, rain * 1.2 + (wet > 0.5 ? 0.15 : 0));
      let ni = 0; const R2 = WALKER_RANGE * WALKER_RANGE;
      // stride: 1 walking, 0 standing, -1 never detailed (seated at a café).
      const put = (x, y, z, ry, seed, stride = 1) => {
        // A step: the stride's phase from the distance walked (about 0.75 m a
        // step), so a walker rises a little mid-stride and sways side to side
        // in time with their pace, and someone standing still stands still.
        const ph = (Math.abs(x) + Math.abs(z)) * (Math.PI / 0.75) + seed;
        const bob = Math.abs(Math.sin(ph)) * 0.045 * Math.max(0, stride);
        const umb = ((seed * 2654435761) >>> 0) / 4294967296 < umbShare;
        if (walkers && stride >= 0 && cam && ni < walkCap && (x - cam.x) ** 2 + (z - cam.z) ** 2 < R2) {
          // Near: a detailed walker in place of the light figure.
          const lk = walkerLook(seed); const hgt = lk.height;
          set(walkers, ni, x, y + bob * 0.6, z, ry, lk.build, hgt, lk.build);
          walkAttr.walk.setXYZW(ni, ph, stride, umb ? 0 : lk.bag, lk.coat);
          walkAttr.legs.setXYZ(ni, ...lk.trousers); walkAttr.skin.setXYZ(ni, ...lk.skin); walkAttr.hair.setXYZ(ni, ...lk.hair);
          walkers.setColorAt(ni, walkCol.setHex(lk.top));
          ni++; hide(figures, fi);
          if (umb) set(umbrellas, fi, x, y + (hgt - 1) * 1.75, z, ry); else hide(umbrellas, fi);
        } else {
          set(figures, fi, x, y + bob, z, ry, 1, 1, 1, 0, Math.sin(ph) * 0.035 * Math.max(0, stride));
          if (umb) set(umbrellas, fi, x, y, z, ry); else hide(umbrellas, fi);
        }
        fi++;
      };
      people.forEach((p, i) => {
        let x; let z; let y = 0.05; let ry = 0;
        if (p.ring) { p.a += p.speed * dt; x = Math.cos(p.a) * p.ring; z = Math.sin(p.a) * p.ring; ry = -p.a; }
        else if (p.bank) { p.pos += p.speed * dt; if (p.pos > 700) p.pos -= 1400; if (p.pos < -700) p.pos += 1400; x = p.pos; z = RIVER.z + p.bank * (RIVER.half + 2); ry = p.speed > 0 ? Math.PI / 2 : -Math.PI / 2; }
        else if (p.bridge) { p.pos += p.speed * dt; if (p.pos > RIVER.z + 55) p.pos = RIVER.z - 55; if (p.pos < RIVER.z - 55) p.pos = RIVER.z + 55; x = p.side; z = p.pos; y = 10.05; ry = p.speed > 0 ? 0 : Math.PI; }
        else { p.pos += p.speed * dt; if (p.pos > 800) p.pos -= 1600; if (p.pos < -800) p.pos += 1600; if (p.alongX) { x = p.pos; z = p.lane; ry = p.speed > 0 ? Math.PI / 2 : -Math.PI / 2; } else { x = p.lane; z = inRiver(p.pos) ? RIVER.z + RIVER.half + 3 : p.pos; ry = p.speed > 0 ? 0 : Math.PI; } }
        put(x, y + Math.abs(Math.sin(t * 6 + i)) * 0.05, z, ry, i);
      });
      zebraPeds.forEach((p, i) => {
        put(p.x, 0.05 + (p.state === 'cross' ? Math.abs(Math.sin(t * 7 + i)) * 0.05 : 0), p.z, p.heading, i + 7919, p.state === 'cross' ? 1 : 0);
        if (p.dog) { set(dogs, di++, p.x + Math.cos(p.heading) * 0.8, 0.02, p.z - Math.sin(p.heading) * 0.8, p.heading); }
      });
      // People at bus stops: off and on while a bus waits at their stop.
      const dwelling = new Set(traffic.vehicles.filter((v) => v.type === 'bus' && v.dwell > 0).map((v) => v.link));
      stopPeople.forEach((p, i) => {
        const goal = dwelling.has(p.link) ? 1 : 0; p.board += (goal - p.board) * Math.min(1, dt * 0.6);
        p.x = p.home.x + (p.kerb.x - p.home.x) * p.board; p.z = p.home.z + (p.kerb.z - p.home.z) * p.board;
        put(p.x, 0.05, p.z, 0, i + 104729, p.board > 0.02 && p.board < 0.98 ? 1 : 0);
      });
      // Café tables (two seated each) and the buskers, swaying.
      cafes.forEach((c, i) => { put(c.x + 0.8, -0.3, c.z, Math.PI / 2, i * 3 + 11, -1); put(c.x - 0.8, -0.3, c.z, -Math.PI / 2, i * 3 + 12, -1); });
      buskers.forEach((b, i) => { set(figures, fi, b.x, 0.05, b.z, Math.PI + Math.sin(t * 2.2 + i) * 0.15, 1, 1, 1, Math.sin(t * 2.2 + i * 1.7) * 0.06, 0); hide(umbrellas, fi); fi++; });
      // A few dogs on leads along the embankment.
      for (let n = 0; n < 6; n++) { const pos = ((t * 1.2 + n * 230) % 1400) - 700; set(dogs, di++, pos, 0.02, RIVER.z - RIVER.half - 1.4, Math.PI / 2); put(pos - 1.2, 0.05, RIVER.z - RIVER.half - 2, Math.PI / 2, n + 31); }
      dogs.count = di;
      // Fewer figures while frames run slow (setDensity; the frame-time ladder).
      const shown = density < 1 ? Math.floor(fi * density) : fi;
      figures.count = shown; umbrellas.count = shown; umbrellas.visible = umbShare > 0.01; dogs.visible = di > 0 && density >= 1;
      figures.instanceMatrix.needsUpdate = true; umbrellas.instanceMatrix.needsUpdate = true; dogs.instanceMatrix.needsUpdate = true;
      if (shops) shops.update(cam, hour >= 8 && hour < 21.5 ? 1 : 0.15, dark);
      if (walkers) { walkers.count = density < 1 ? Math.floor(ni * density) : ni; walkers.instanceMatrix.needsUpdate = true; if (walkers.instanceColor) walkers.instanceColor.needsUpdate = true; for (const a of Object.values(walkAttr)) a.needsUpdate = true; }
      // Cyclists: ordered along their track, never through each other.
      for (const north of [true, false]) {
        const lane = bikes.filter((b) => (b.dir > 0) === north).sort((a, b) => (b.x - a.x) * (north ? 1 : -1));
        lane.forEach((b, i) => { const ahead = lane[i - 1]; const gap = ahead ? (ahead.x - b.x) * b.dir - 2.4 : Infinity; b.v += ((gap < 4 ? Math.max(0, gap - 1) : b.v0) - b.v) * Math.min(1, dt * 1.5); b.x += b.v * b.dir * dt; if (b.x * b.dir > 750) b.x -= 1500 * b.dir; });
      }
      bikes.forEach((b, i) => { const ry = b.dir > 0 ? Math.PI / 2 : -Math.PI / 2; set(bikeMesh, i, b.x, 0, b.z, ry); set(riders, i, b.x, 0, b.z, ry); });
      bikeMesh.instanceMatrix.needsUpdate = true; riders.instanceMatrix.needsUpdate = true;
      // Flags in the wind.
      flagWind.uTime.value = t; flagWind.uWind.value += (wind - flagWind.uWind.value) * Math.min(1, dt);
      // Rooftops.
      for (const s of steam) { const kk = (t * 0.12 + s.ph) % 1; s.sp.position.set(s.base.x + kk * (4 + wind * 14), s.base.y + 2 + kk * 14, s.base.z); s.sp.scale.setScalar(3 + kk * 9); s.sp.material.opacity = 0.28 * (1 - kk) * (0.4 + 0.6 * dark); }
      if (radar) radar.rotation.y = t * 0.8;
      if (craneLight) craneLight.material.color.setHex((t % 2) < 0.25 ? LIFE_COLOURS.strobe : 0x4a4a4a);
      // Street lights come on at sunset; their pools on the (wet) road.
      lampHeadMat.color.setHex(dark > 0.35 ? LIFE_COLOURS.lamp : 0x6a6252);
      // Wet roads mirror the lamps: the pools brighten (the merged mesh shares this material).
      // Desktop detail: softer pools (the wet streets and bloom already carry the lamps).
      poolMat.opacity = Math.max(0, dark - 0.25) * (0.55 + 0.6 * wet) * (detailed ? 0.5 : 1);
      // Shop signs: lit from opening to late evening (world.setShopLights).
      if (world.setShopLights) world.setShopLights(hour >= 7.5 && hour < 23.5 ? 1 : hour >= 23.5 || hour < 1 ? 0.25 : 0);
      // Fountains.
      for (const f of sprays) { for (let i = 0; i < f.n; i++) { const ph = (t * 0.8 + i / f.n) % 1; const a = i * 2.39; const rr = ph * 2.4; f.p[i * 3] = f.fx + Math.cos(a) * rr + wind * ph * 1.5; f.p[i * 3 + 1] = 0.9 + 4 * ph * (1 - ph) * 3; f.p[i * 3 + 2] = 32 + Math.sin(a) * rr; } f.geo.attributes.position.needsUpdate = true; }
    },
    dispose() { scene.remove(root); root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); }); }
  };
}
