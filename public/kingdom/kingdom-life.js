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
import { createTraffic, GRID, ROAD_W, STOP_BACK, JUNCTION_HALF, ZEBRA_IN, ZEBRA_W, signalFor, LANE_OFFSET } from './kingdom-traffic.js';

export const TRAM_Z = -200;
export { GRID };
// Every colour the life uses, for the tests (none may be the enemy red).
export const LIFE_COLOURS = Object.freeze({ head: 0xfff4d6, tail: 0xff9a2e, taxi: 0xf2c94c, bus: 0x2f6db5, busWin: 0xffe6b0, van: 0xe9edf1, stop: 0xff8c1a, go: 0x3ddc84, wait: 0xffc94d, strobe: 0xf5f7fa, nav: 0x3ddc84, roof: 0xffc070, tram: 0xd8dde3, tramWin: 0xffe2b0, steam: 0xc9ced6, lamp: 0xffcf8a, crane: 0xf3c623, figure: [0x2b3340, 0x44506a, 0x5a4a3a, 0x36454f, 0x6b6f7a, 0x3d5a4a], umbrella: [0x1f2a36, 0x2f4a6b, 0x3d5a4a, 0xf3c623, 0x6b6f7a], boat: 0xe9edf1, ferry: 0xf5f7fa, cabin: 0xffe2b0, bike: 0x2f6db5, parasol: 0xe8dcc0, gull: 0xf1f3f5, pigeon: 0x5a5f66, flag: 0x2f6db5, dog: 0x6b5a45, shelter: 0x8fb8d8 });

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
  const softTex = (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; })();

  // --- traffic: the lane simulation, drawn ---
  const traffic = createTraffic({ density: k, cols: phone ? 4 : 6, rowsNorth: phone ? 3 : 4, rowsSouth: phone ? 3 : 4, tramZ: TRAM_Z, pedestrians: Math.max(0.35, k) });
  const CAP = traffic.target + 40;
  const carBodyGeo = new THREE.BoxGeometry(1.9, 0.8, 4.5); carBodyGeo.translate(0, 0.55, 0);
  const carCabGeo = new THREE.BoxGeometry(1.7, 0.6, 2.3); carCabGeo.translate(0, 1.25, -0.25);
  const vanGeo = new THREE.BoxGeometry(2.1, 2.3, 5.8); vanGeo.translate(0, 1.3, 0);
  const busGeo = new THREE.BoxGeometry(2.5, 3.1, 12); busGeo.translate(0, 1.7, 0);
  const carPalette = [0x1f2a36, 0x8a9099, 0xd8dde3, 0x2f4a6b, 0x3a3f46, 0x6b5a45, 0x1c3b2f];
  const carBodies = dyn(named(new THREE.InstancedMesh(carBodyGeo, std(0xffffff, { metalness: 0.6, roughness: 0.3 }), CAP), 'car-bodies'));
  const carCabs = dyn(named(new THREE.InstancedMesh(carCabGeo, std(0x1a2129, { metalness: 0.8, roughness: 0.12 }), CAP), 'car-cabins'));
  const vans = dyn(named(new THREE.InstancedMesh(vanGeo, std(LIFE_COLOURS.van, { roughness: 0.45 }), Math.max(1, Math.ceil(CAP * 0.15))), 'delivery-vans'));
  const buses = dyn(named(new THREE.InstancedMesh(busGeo, std(LIFE_COLOURS.bus, { emissive: LIFE_COLOURS.busWin, emissiveIntensity: 0.25 }), Math.max(1, Math.ceil(CAP * 0.12))), 'buses'));
  const lightGeo = new THREE.BoxGeometry(1.5, 0.25, 0.1);
  const heads = dyn(named(new THREE.InstancedMesh(lightGeo, basic(LIFE_COLOURS.head), CAP), 'car-lights'));
  const tails = dyn(named(new THREE.InstancedMesh(lightGeo, basic(LIFE_COLOURS.tail), CAP), 'car-lights'));
  const sprayGeo = new THREE.PlaneGeometry(2.2, 3.5); sprayGeo.rotateX(-Math.PI / 2); sprayGeo.translate(0, 0.5, -1.75);
  const sprayMat = new THREE.MeshBasicMaterial({ map: softTex, color: 0xc9d3dd, transparent: true, opacity: 0, depthWrite: false });
  const spray = dyn(named(new THREE.InstancedMesh(sprayGeo, sprayMat, CAP), 'road-spray'));
  for (let i = 0; i < CAP; i++) carBodies.setColorAt(i, new THREE.Color(carPalette[i % carPalette.length]));
  for (const m of [carBodies, carCabs, vans, buses, heads, tails, spray]) root.add(m);
  if (settings.legacy) carCabs.visible = false; // the cabin is the body's darker top on Legacy phone

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
  const tramTex = (() => { const cv = document.createElement('canvas'); cv.width = 128; cv.height = 32; const g = cv.getContext('2d'); g.fillStyle = '#20262e'; g.fillRect(0, 0, 128, 32); g.fillStyle = '#ffe2b0'; for (let x = 6; x < 128; x += 16) g.fillRect(x, 9, 10, 12); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const carriages = dyn(named(new THREE.InstancedMesh(new THREE.BoxGeometry(18, 3.4, 2.8), new THREE.MeshStandardMaterial({ color: LIFE_COLOURS.tram, emissive: 0xffffff, emissiveMap: tramTex, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.5 }), 10), 'tram'));
  root.add(carriages);

  // --- the river: boats in lanes, with wakes; moored boats rocking ---
  const wakeTex = (() => { const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128; const g = cv.getContext('2d'); for (let y = 0; y < 128; y++) { const kk = 1 - y / 128; const half = 4 + (y / 128) * 26; g.fillStyle = `rgba(255,255,255,${0.5 * kk})`; g.fillRect(32 - half, y, 3, 1); g.fillRect(32 + half - 3, y, 3, 1); } const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const wakeMat = new THREE.MeshBasicMaterial({ map: wakeTex, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
  const boats = traffic.boats;
  const boatHull = dyn(named(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 2, 1), std(LIFE_COLOURS.boat), Math.max(1, boats.length)), 'water-taxis-and-ferries'));
  const boatCabin = dyn(named(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 2, 1), std(0x2a4a68, { emissive: LIFE_COLOURS.cabin, emissiveIntensity: 0.8 }), Math.max(1, boats.length)), 'boat-cabins'));
  const wakeGeo = new THREE.PlaneGeometry(10, 34); wakeGeo.rotateX(-Math.PI / 2); wakeGeo.translate(0, 0, -24);
  const wakes = dyn(named(new THREE.InstancedMesh(wakeGeo, wakeMat, Math.max(1, boats.length)), 'boat-wakes'));
  root.add(boatHull); root.add(boatCabin); root.add(wakes);
  const moored = named(new THREE.InstancedMesh(new THREE.BoxGeometry(3.6, 1.6, 13), std(LIFE_COLOURS.boat, { roughness: 0.4 }), 4), 'moored-boats');
  const pierX = 205; root.add(moored);

  // --- the sky: aircraft on approach, birds at dusk, gulls, pigeons ---
  const planes = []; for (let i = 0; i < 3; i++) planes.push({ a: r() * Math.PI * 2, rad: 1600 + i * 500, alt: 900 + i * 220, speed: 0.012 + r() * 0.006 });
  const planeBody = named(new THREE.InstancedMesh(new THREE.BoxGeometry(4, 3, 38), std(0xd8dde3), planes.length), 'aircraft');
  const planeWing = named(new THREE.InstancedMesh(new THREE.BoxGeometry(34, 0.6, 5), std(0xd8dde3), planes.length), 'aircraft-wings');
  const strobeMat = basic(LIFE_COLOURS.strobe, { transparent: true, opacity: 1 });
  const strobes = named(new THREE.InstancedMesh(new THREE.SphereGeometry(2.4, 8, 6), strobeMat, planes.length), 'aircraft-strobes');
  root.add(planeBody); root.add(planeWing); root.add(strobes);
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
  const personGeo = new THREE.CapsuleGeometry(0.24, 1.25, 3, 6); personGeo.translate(0, 0.87, 0);
  const figures = dyn(named(new THREE.InstancedMesh(personGeo, std(0xffffff, { roughness: 0.9 }), nFig), 'pedestrians'));
  for (let i = 0; i < nFig; i++) figures.setColorAt(i, new THREE.Color(LIFE_COLOURS.figure[i % LIFE_COLOURS.figure.length]));
  root.add(figures);
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
  const vents = settings.legacy ? [] : spots.slice(4, phone ? 10 : 20);
  const steamMat = new THREE.SpriteMaterial({ map: softTex, color: LIFE_COLOURS.steam, transparent: true, opacity: 0.25, depthWrite: false });
  const steam = [];
  for (const v of vents) for (let j = 0; j < 3; j++) { const sp = named(new THREE.Sprite(steamMat.clone()), 'rooftop-steam'); sp.position.set(v.x, v.y + 2, v.z); root.add(sp); steam.push({ sp, base: v, ph: j / 3 }); }
  let radar = null;
  if (spots[2] && !settings.legacy) {
    radar = named(new THREE.Group(), 'rooftop-radar');
    const dish = named(new THREE.Mesh(new THREE.BoxGeometry(9, 2.2, 0.4), std(0xd8dde3, { metalness: 0.7 })), 'rooftop-radar-dish'); dish.position.y = 3; radar.add(dish);
    const post = named(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 3, 8), std(0x2b2f36)), 'rooftop-radar-post'); post.position.y = 1.5; radar.add(post);
    radar.position.set(spots[2].x, spots[2].y, spots[2].z - spots[2].w * 0.2); root.add(radar);
  }
  let craneLight = null;
  const cs = spots.find((s) => s.ring === 'near' && s.h < 110) || spots[6];
  if (cs && !settings.legacy) {
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
  for (const fx of (settings.legacy ? [-22] : [-22, 22])) {
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

  return {
    root,
    traffic,
    // For the tests: every colour the city's life uses.
    colours: colourOf,
    counts: () => ({ vehicles: traffic.vehicles.length, people: people.length + zebraPeds.length + stopPeople.length + cafes.length * 2 + buskers.length, boats: traffic.boats.length, planes: planes.length, birds: nBirds, gulls: nGulls, cyclists: nBikes, trams: traffic.trams.length, overlaps: traffic.overlaps().length }),
    update(dt, t, { dark = 0, dusk = 0, light = 1, hour = 19.5, wet = 0, rain = 0, wind = 0, external = [] } = {}) {
      traffic.step(Math.min(dt, 0.1), { external });
      // Signal heads.
      let sigDirty = false;
      approaches.forEach(({ j, l }, i) => { const s = signalFor(j, l.axis, traffic.time); if (s !== lastSig[i]) { lastSig[i] = s; tlLights.setColorAt(i, tlColour[s]); sigDirty = true; } });
      if (sigDirty && tlLights.instanceColor) tlLights.instanceColor.needsUpdate = true;
      // Vehicles.
      let ci = 0; let vi = 0; let bi = 0; let si = 0;
      const vs = traffic.vehicles;
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        const { x, y, z, heading: ry } = v;
        if (v.type === 'bus') set(buses, bi++, x, y, z, ry);
        else if (v.type === 'van') set(vans, vi++, x, y, z, ry);
        else {
          set(carBodies, ci, x, y, z, ry); set(carCabs, ci, x, y, z, ry);
          if (v.type === 'taxi') carBodies.setColorAt(ci, tc.setHex(LIFE_COLOURS.taxi)); else carBodies.setColorAt(ci, tc.setHex(carPalette[v.id % carPalette.length]));
          ci++;
        }
        const fx = Math.sin(ry) * v.len / 2; const fz = Math.cos(ry) * v.len / 2;
        set(heads, i, x + fx, y + 0.8, z + fz, ry); set(tails, i, x - fx, y + 0.9, z - fz, ry);
        // Spray off the tyres on a wet road, more the faster it goes.
        if (wet > 0.3 && v.v > 4) set(spray, si++, x - fx, y, z - fz, ry, 1, 1, Math.min(1.6, v.v / 8));
      }
      carBodies.count = carCabs.count = ci; vans.count = vi; buses.count = bi; heads.count = tails.count = vs.length; spray.count = si;
      sprayMat.opacity = Math.max(0, wet - 0.3) * 0.5 * (0.6 + rain * 0.4);
      if (carBodies.instanceColor) carBodies.instanceColor.needsUpdate = true;
      for (const m of [carBodies, carCabs, vans, buses, heads, tails, spray]) m.instanceMatrix.needsUpdate = true;
      // The trams.
      traffic.trams.forEach((tr, n) => { for (let i = 0; i < 5; i++) set(carriages, n * 5 + i, tr.x - tr.dir * (i * 18.6 + 9), 17.4, tr.z); });
      carriages.count = traffic.trams.length * 5; carriages.instanceMatrix.needsUpdate = true;
      carriages.material.emissiveIntensity = 0.3 + 0.9 * dark;
      // Boats on the river, and moored ones rocking.
      boats.forEach((b, i) => {
        const sc = b.len / 18;
        set(boatHull, i, b.x, -2.8, b.z, b.heading, b.wid, 1, b.len); set(boatCabin, i, b.x, -0.9, b.z, b.heading, b.wid * 0.8, 1, b.len * 0.42); set(wakes, i, b.x, -3.05, b.z, b.heading, sc, 1, sc * Math.min(1.2, 0.3 + b.v / 6));
      });
      boatHull.instanceMatrix.needsUpdate = true; boatCabin.instanceMatrix.needsUpdate = true; wakes.instanceMatrix.needsUpdate = true;
      for (let j = 0; j < 4; j++) set(moored, j, pierX + (j % 2 ? 11 : -11), -2.9 + Math.sin(t * 0.9 + j) * 0.12, RIVER.z - RIVER.half + 10 + Math.floor(j / 2) * 18, 0, 1, 1, 1, Math.sin(t * 0.7 + j * 2) * 0.03, Math.sin(t * 0.8 + j) * 0.05);
      moored.instanceMatrix.needsUpdate = true;
      // Aircraft blinking high on approach.
      planes.forEach((p, i) => { p.a += p.speed * dt; const x = Math.cos(p.a) * p.rad; const z = Math.sin(p.a) * p.rad; const ry = -p.a; set(planeBody, i, x, p.alt, z, ry); set(planeWing, i, x, p.alt, z, ry); set(strobes, i, x, p.alt - 2, z, ry, 1, 1, 1); });
      planeBody.instanceMatrix.needsUpdate = true; planeWing.instanceMatrix.needsUpdate = true; strobes.instanceMatrix.needsUpdate = true;
      strobeMat.opacity = (t % 1.4) < 0.12 ? 1 : 0.15;
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
      const put = (x, y, z, ry, seed) => {
        set(figures, fi, x, y, z, ry);
        if (((seed * 2654435761) >>> 0) / 4294967296 < umbShare) set(umbrellas, fi, x, y, z, ry); else hide(umbrellas, fi);
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
        put(p.x, 0.05 + (p.state === 'cross' ? Math.abs(Math.sin(t * 7 + i)) * 0.05 : 0), p.z, p.heading, i + 7919);
        if (p.dog) { set(dogs, di++, p.x + Math.cos(p.heading) * 0.8, 0.02, p.z - Math.sin(p.heading) * 0.8, p.heading); }
      });
      // People at bus stops: off and on while a bus waits at their stop.
      const dwelling = new Set(traffic.vehicles.filter((v) => v.type === 'bus' && v.dwell > 0).map((v) => v.link));
      stopPeople.forEach((p, i) => {
        const goal = dwelling.has(p.link) ? 1 : 0; p.board += (goal - p.board) * Math.min(1, dt * 0.6);
        p.x = p.home.x + (p.kerb.x - p.home.x) * p.board; p.z = p.home.z + (p.kerb.z - p.home.z) * p.board;
        put(p.x, 0.05, p.z, 0, i + 104729);
      });
      // Café tables (two seated each) and the buskers, swaying.
      cafes.forEach((c, i) => { put(c.x + 0.8, -0.3, c.z, Math.PI / 2, i * 3 + 11); put(c.x - 0.8, -0.3, c.z, -Math.PI / 2, i * 3 + 12); });
      buskers.forEach((b, i) => { set(figures, fi, b.x, 0.05, b.z, Math.PI + Math.sin(t * 2.2 + i) * 0.15, 1, 1, 1, Math.sin(t * 2.2 + i * 1.7) * 0.06, 0); hide(umbrellas, fi); fi++; });
      // A few dogs on leads along the embankment.
      for (let n = 0; n < 6; n++) { const pos = ((t * 1.2 + n * 230) % 1400) - 700; set(dogs, di++, pos, 0.02, RIVER.z - RIVER.half - 1.4, Math.PI / 2); put(pos - 1.2, 0.05, RIVER.z - RIVER.half - 2, Math.PI / 2, n + 31); }
      dogs.count = di;
      figures.count = fi; umbrellas.count = fi; umbrellas.visible = umbShare > 0.01; dogs.visible = di > 0;
      figures.instanceMatrix.needsUpdate = true; umbrellas.instanceMatrix.needsUpdate = true; dogs.instanceMatrix.needsUpdate = true;
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
      poolMat.opacity = Math.max(0, dark - 0.25) * (0.55 + 0.35 * wet);
      // Shop signs: lit from opening to late evening (world.setShopLights).
      if (world.setShopLights) world.setShopLights(hour >= 7.5 && hour < 23.5 ? 1 : hour >= 23.5 || hour < 1 ? 0.25 : 0);
      // Fountains.
      for (const f of sprays) { for (let i = 0; i < f.n; i++) { const ph = (t * 0.8 + i / f.n) % 1; const a = i * 2.39; const rr = ph * 2.4; f.p[i * 3] = f.fx + Math.cos(a) * rr + wind * ph * 1.5; f.p[i * 3 + 1] = 0.9 + 4 * ph * (1 - ph) * 3; f.p[i * 3 + 2] = 32 + Math.sin(a) * rr; } f.geo.attributes.position.needsUpdate = true; }
    },
    dispose() { scene.remove(root); root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); }); }
  };
}
