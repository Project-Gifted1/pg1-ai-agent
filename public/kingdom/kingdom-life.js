// PG1 City: the city's own life. Decoration only: none of this is ever
// captioned, counted or shown as an event, and none of it uses the enemy
// palette (red is theirs; tail lights and stop lights here are deep amber).
// Real events stay the only source of attackers (kingdom-actors.js).
//
//   traffic     cars (bodies, head and amber tail lights), buses and taxis on
//               the avenues and the bridge, stopping at the traffic lights
//   tram        an elevated line over the avenue at TRAM_Z, lit carriages
//   river       water taxis and ferries with wakes; moored boats rocking
//   sky         aircraft high on approach, blinking; birds at dusk
//   people      small figures on pavements, bridges and embankments,
//               busiest round the tower plaza
//   rooftops    steam from vents, a turning radar, a construction crane with
//               a blinking light, blinking rooftop lights
//   street      lamp posts with warm light pools, pavements and kerbs,
//               zebra crossings, manhole covers; plaza fountains and benches
//
// Real-world scale: cars 4.5 m, buses 12 m, people 1.75 m, floors 3.6 m.
// The Phone tier keeps fewer of everything (density), never the emblem.

import { RIVER, PLAZA_R, inRiver } from './kingdom-world.js';

export const TRAM_Z = -200;
export const GRID = 160;
const ROAD_W = 16;
// Every colour the life uses, for the tests (none may be the enemy red).
export const LIFE_COLOURS = Object.freeze({ head: 0xfff4d6, tail: 0xff9a2e, taxi: 0xf2c94c, bus: 0x2f6db5, busWin: 0xffe6b0, stop: 0xff8c1a, go: 0x3ddc84, wait: 0xffc94d, strobe: 0xf5f7fa, nav: 0x3ddc84, roof: 0xffc070, tram: 0xd8dde3, tramWin: 0xffe2b0, steam: 0xc9ced6, lamp: 0xffcf8a, crane: 0xf3c623, figure: [0x2b3340, 0x44506a, 0x5a4a3a, 0x36454f, 0x6b6f7a, 0x3d5a4a], boat: 0xe9edf1, ferry: 0xf5f7fa, cabin: 0xffe2b0 });

function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

export function createLife(THREE, scene, world, settings) {
  const phone = settings.tier === 'phone';
  const k = phone ? 0.35 : 1;
  const root = new THREE.Group(); root.name = 'city-life'; scene.add(root);
  const named = (o, n) => { o.name = n; return o; };
  const dummy = new THREE.Object3D();
  const set = (mesh, i, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) => { dummy.position.set(x, y, z); dummy.rotation.set(rx, ry, rz); dummy.scale.set(sx, sy, sz); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); };
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, ...o });
  const basic = (color, o = {}) => new THREE.MeshBasicMaterial({ color, ...o });
  const r = rng(77);
  const softTex = (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; })();

  // --- traffic: cars, taxis, buses; they stop at the lights ---
  const nCars = Math.round(800 * k); const nTaxi = Math.round(90 * k); const nBus = Math.round(40 * k);
  const vehicles = [];
  while (vehicles.length < nCars + nTaxi + nBus) {
    const i = vehicles.length;
    const type = i < nCars ? 'car' : i < nCars + nTaxi ? 'taxi' : 'bus';
    const alongX = r() < 0.5;
    const lane = (Math.floor(r() * 13) - 6) * GRID + (alongX ? -40 : 0);
    if (alongX && inRiver(lane)) continue;
    if (!alongX && lane !== 0 && r() < 0.15) continue;
    vehicles.push({ type, alongX, lane, pos: (r() - 0.5) * 2000, speed: type === 'bus' ? 9 : 11 + r() * 7, dir: r() < 0.5 ? 1 : -1, v: 0, len: type === 'bus' ? 12 : 4.5 });
  }
  const bodyGeo = new THREE.BoxGeometry(1.8, 1.4, 4.5); bodyGeo.translate(0, 0.7, 0);
  const busGeo = new THREE.BoxGeometry(2.5, 3.1, 12); busGeo.translate(0, 1.55, 0);
  const carBodies = named(new THREE.InstancedMesh(bodyGeo, std(0xffffff, { metalness: 0.6, roughness: 0.35 }), nCars + nTaxi), 'car-bodies');
  const buses = named(new THREE.InstancedMesh(busGeo, std(LIFE_COLOURS.bus, { emissive: LIFE_COLOURS.busWin, emissiveIntensity: 0.25 }), Math.max(1, nBus)), 'buses');
  const lightGeo = new THREE.BoxGeometry(1.5, 0.25, 0.1);
  const heads = named(new THREE.InstancedMesh(lightGeo, basic(LIFE_COLOURS.head), vehicles.length), 'car-lights');
  const tails = named(new THREE.InstancedMesh(lightGeo, basic(LIFE_COLOURS.tail), vehicles.length), 'car-lights');
  const carPalette = [0x1f2a36, 0x8a9099, 0xd8dde3, 0x2f4a6b, 0x3a3f46, 0x6b5a45, 0x1c3b2f];
  vehicles.forEach((v, i) => { if (v.type !== 'bus') carBodies.setColorAt(vehicles.filter((x, j) => j < i && x.type !== 'bus').length, new THREE.Color(v.type === 'taxi' ? LIFE_COLOURS.taxi : carPalette[i % carPalette.length])); });
  for (const m of [carBodies, buses, heads, tails]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); root.add(m); }

  // Traffic lights at the central crossings: the two directions alternate.
  const crossings = [];
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) { const z = j * GRID - 40; if (!inRiver(z) && Math.hypot(i * GRID, z) > PLAZA_R + 10) crossings.push([i * GRID, z]); }
  const tlPoles = named(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.15, 5, 6), std(0x2b2f36), crossings.length * 2), 'traffic-light-poles');
  const tlLights = named(new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 8, 6), basic(0xffffff), crossings.length * 2), 'traffic-lights');
  crossings.forEach(([x, z], i) => { for (let s = 0; s < 2; s++) { const o = (s ? 1 : -1) * (ROAD_W / 2 + 1); set(tlPoles, i * 2 + s, x + o, 2.5, z + o); set(tlLights, i * 2 + s, x + o, 5.2, z + o); } });
  root.add(tlPoles); root.add(tlLights);
  const CYCLE = 16; // seconds: x green 7, amber 1, z green 7, amber 1
  const lightState = (t, alongX) => { const p = t % CYCLE; const xg = p < 7; const xa = p >= 7 && p < 8; const zg = p >= 8 && p < 15; const za = p >= 15; return alongX ? (xg ? 'go' : xa ? 'wait' : 'stop') : (zg ? 'go' : za ? 'wait' : 'stop'); };
  const nearCentral = (x, z) => Math.abs(x) <= 3 * GRID + 1 && Math.abs(z + 40) <= 3 * GRID + 1;

  // --- the elevated tram over the avenue at TRAM_Z ---
  const viaLen = 2400;
  const via = named(new THREE.Mesh(new THREE.BoxGeometry(viaLen, 1.2, 8), std(0x9a9da3, { roughness: 0.8 })), 'tram-viaduct'); via.position.set(0, 15, TRAM_Z); root.add(via);
  const nPil = Math.round(viaLen / 40) + 1;
  const pillars = named(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.9, 1.1, 15, 10), std(0x8d9096, { roughness: 0.85 }), nPil), 'tram-pillars');
  for (let i = 0; i < nPil; i++) set(pillars, i, -viaLen / 2 + i * 40, 7.5, TRAM_Z);
  root.add(pillars);
  const tramTex = (() => { const cv = document.createElement('canvas'); cv.width = 128; cv.height = 32; const g = cv.getContext('2d'); g.fillStyle = '#20262e'; g.fillRect(0, 0, 128, 32); g.fillStyle = '#ffe2b0'; for (let x = 6; x < 128; x += 16) g.fillRect(x, 9, 10, 12); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const carriages = named(new THREE.InstancedMesh(new THREE.BoxGeometry(18, 3.4, 2.8), new THREE.MeshStandardMaterial({ color: LIFE_COLOURS.tram, emissive: 0xffffff, emissiveMap: tramTex, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.5 }), 5), 'tram');
  root.add(carriages);
  const tram = { x: -900, dir: 1, speed: 16 };

  // --- the river: water taxis and ferries with wakes; moored boats rocking ---
  const wakeTex = (() => { const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128; const g = cv.getContext('2d'); for (let y = 0; y < 128; y++) { const kk = 1 - y / 128; const half = 4 + (y / 128) * 26; g.fillStyle = `rgba(255,255,255,${0.5 * kk})`; g.fillRect(32 - half, y, 3, 1); g.fillRect(32 + half - 3, y, 3, 1); } const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const wakeMat = new THREE.MeshBasicMaterial({ map: wakeTex, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
  const boats = [];
  for (let i = 0; i < (phone ? 3 : 7); i++) boats.push({ ferry: i % 3 === 0, x: (r() - 0.5) * 2000, lane: RIVER.z + (i % 2 ? 14 : -14) + (r() - 0.5) * 6, dir: i % 2 ? 1 : -1, speed: i % 3 === 0 ? 5 : 9 });
  const boatHull = named(new THREE.InstancedMesh(new THREE.BoxGeometry(5, 2, 18), std(LIFE_COLOURS.boat), boats.length), 'water-taxis-and-ferries');
  const boatCabin = named(new THREE.InstancedMesh(new THREE.BoxGeometry(4, 2, 8), std(0x2a4a68, { emissive: LIFE_COLOURS.cabin, emissiveIntensity: 0.8 }), boats.length), 'boat-cabins');
  const wakeGeo = new THREE.PlaneGeometry(10, 34); wakeGeo.rotateX(-Math.PI / 2); wakeGeo.translate(0, 0, -24);
  const wakes = named(new THREE.InstancedMesh(wakeGeo, wakeMat, boats.length), 'boat-wakes');
  root.add(boatHull); root.add(boatCabin); root.add(wakes);
  const moored = named(new THREE.InstancedMesh(new THREE.BoxGeometry(3.6, 1.6, 13), std(LIFE_COLOURS.boat, { roughness: 0.4 }), 4), 'moored-boats');
  const pierX = 205; root.add(moored);

  // --- the sky: aircraft on approach (white strobe, green light), birds at dusk ---
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

  // --- people: small figures, busiest round the plaza ---
  const nPeople = Math.round(1400 * k);
  const people = [];
  for (let i = 0; i < nPeople; i++) {
    const kind = r();
    if (kind < 0.35) people.push({ ring: PLAZA_R - 2 - r() * 10, a: r() * Math.PI * 2, speed: (0.02 + r() * 0.02) * (r() < 0.5 ? 1 : -1) });
    else if (kind < 0.5) people.push({ bank: r() < 0.5 ? -1 : 1, pos: (r() - 0.5) * 1400, speed: (0.9 + r() * 0.6) * (r() < 0.5 ? 1 : -1) });
    else if (kind < 0.56) people.push({ bridge: true, pos: RIVER.z + (r() - 0.5) * 100, speed: (0.9 + r() * 0.5) * (r() < 0.5 ? 1 : -1), side: r() < 0.5 ? -7.5 : 7.5 });
    else { const alongX = r() < 0.5; const lane = (Math.floor(r() * 11) - 5) * GRID + (alongX ? -40 : 0) + (r() < 0.5 ? -1 : 1) * (ROAD_W / 2 + 2); if (alongX && inRiver(lane)) { i--; continue; } people.push({ alongX, lane, pos: (r() - 0.5) * 1600, speed: (0.9 + r() * 0.6) * (r() < 0.5 ? 1 : -1) }); }
  }
  const personGeo = new THREE.CapsuleGeometry(0.24, 1.25, 3, 6); personGeo.translate(0, 0.87, 0);
  const figures = named(new THREE.InstancedMesh(personGeo, std(0xffffff, { roughness: 0.9 }), people.length), 'pedestrians');
  people.forEach((_, i) => figures.setColorAt(i, new THREE.Color(LIFE_COLOURS.figure[i % LIFE_COLOURS.figure.length])));
  figures.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(figures);

  // --- rooftops: steam, a radar, a crane ---
  const spots = (world.roofSpots || []).filter((s) => Math.hypot(s.x, s.z) < 700);
  const vents = spots.slice(4, phone ? 10 : 20);
  const steamMat = new THREE.SpriteMaterial({ map: softTex, color: LIFE_COLOURS.steam, transparent: true, opacity: 0.25, depthWrite: false });
  const steam = [];
  for (const v of vents) for (let j = 0; j < 3; j++) { const sp = named(new THREE.Sprite(steamMat.clone()), 'rooftop-steam'); sp.position.set(v.x, v.y + 2, v.z); root.add(sp); steam.push({ sp, base: v, ph: j / 3 }); }
  let radar = null;
  if (spots[2]) {
    radar = named(new THREE.Group(), 'rooftop-radar');
    const dish = named(new THREE.Mesh(new THREE.BoxGeometry(9, 2.2, 0.4), std(0xd8dde3, { metalness: 0.7 })), 'rooftop-radar-dish'); dish.position.y = 3; radar.add(dish);
    const post = named(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 3, 8), std(0x2b2f36)), 'rooftop-radar-post'); post.position.y = 1.5; radar.add(post);
    radar.position.set(spots[2].x, spots[2].y, spots[2].z - spots[2].w * 0.2); root.add(radar);
  }
  let craneLight = null;
  const cs = spots.find((s) => s.ring === 'near' && s.h < 110) || spots[6];
  if (cs) {
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
  const pave = named(new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), paveMat, segs.length), 'pavements');
  const kerb = named(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.18, 0.25), kerbMat, segs.length), 'kerbs');
  segs.forEach(([dir, c, a, b], i) => { const len = b - a; const mid = (a + b) / 2; if (dir === 'ns') { set(pave, i, c, 0.07, mid, 0, 3.5, len, 1, -Math.PI / 2); set(kerb, i, c - Math.sign(c || 1) * 0, 0.09, mid, Math.PI / 2, len, 1, 1); } else { set(pave, i, mid, 0.07, c, Math.PI / 2, 3.5, len, 1, -Math.PI / 2, 0); set(kerb, i, mid, 0.09, c, 0, len, 1, 1); } });
  root.add(pave); root.add(kerb);
  const stripes = [];
  for (const [x, z] of crossings) for (let s = -3; s <= 3; s++) { stripes.push([x + s * 2, z + ROAD_W / 2 + 3, 0]); stripes.push([x + ROAD_W / 2 + 3, z + s * 2, Math.PI / 2]); }
  const zebra = named(new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 4), basic(0xcfcab8), stripes.length), 'zebra-crossings');
  stripes.forEach(([x, z, ry], i) => set(zebra, i, x, 0.08, z, ry, 1, 1, 1, -Math.PI / 2));
  root.add(zebra);
  const manholes = named(new THREE.InstancedMesh(new THREE.CircleGeometry(0.4, 12), std(0x202328, { metalness: 0.6, roughness: 0.4 }), crossings.length), 'manhole-covers');
  crossings.forEach(([x, z], i) => set(manholes, i, x + 4, 0.07, z - 5, 0, 1, 1, 1, -Math.PI / 2));
  root.add(manholes);
  // Plaza: two fountains and benches.
  const fountainMat = new THREE.MeshStandardMaterial({ color: 0x2c5a7a, roughness: 0.1, metalness: 0.3, emissive: 0x16304a, emissiveIntensity: 0.6 });
  const sprays = [];
  for (const fx of [-22, 22]) {
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

  const colourOf = () => [LIFE_COLOURS.head, LIFE_COLOURS.tail, LIFE_COLOURS.taxi, LIFE_COLOURS.bus, LIFE_COLOURS.stop, LIFE_COLOURS.go, LIFE_COLOURS.wait, LIFE_COLOURS.strobe, LIFE_COLOURS.nav, LIFE_COLOURS.roof, LIFE_COLOURS.tram, LIFE_COLOURS.steam, LIFE_COLOURS.lamp, LIFE_COLOURS.crane, ...LIFE_COLOURS.figure, LIFE_COLOURS.boat, LIFE_COLOURS.ferry, LIFE_COLOURS.cabin, ...carPalette];
  const tlColour = { go: new THREE.Color(LIFE_COLOURS.go), wait: new THREE.Color(LIFE_COLOURS.wait), stop: new THREE.Color(LIFE_COLOURS.stop) };
  let lastTl = '';

  return {
    root,
    // For the tests: every colour the city's life uses.
    colours: colourOf,
    counts: () => ({ vehicles: vehicles.length, people: people.length, boats: boats.length, planes: planes.length, birds: nBirds }),
    update(dt, t, { dark = 0, dusk = 0, light = 1 } = {}) {
      // Traffic lights, and traffic that waits for them.
      const xs = lightState(t, true); const zs = lightState(t, false);
      if (xs + zs !== lastTl) { lastTl = xs + zs; crossings.forEach((_, i) => { tlLights.setColorAt(i * 2, tlColour[xs]); tlLights.setColorAt(i * 2 + 1, tlColour[zs]); }); tlLights.instanceColor.needsUpdate = true; }
      let ci = 0; let bi = 0;
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        const state = v.alongX ? xs : zs;
        let target = v.speed;
        if (state !== 'go') {
          // The next crossing ahead: stop short of it.
          const cross = v.alongX ? (Math.round((v.pos + v.dir * GRID / 2) / GRID) * GRID) : (Math.round((v.pos + 40 + v.dir * GRID / 2) / GRID) * GRID - 40);
          const ahead = (cross - v.pos) * v.dir;
          const atX = v.alongX ? cross : v.lane; const atZ = v.alongX ? v.lane : cross;
          if (nearCentral(atX, atZ) && ahead > ROAD_W / 2 && ahead < ROAD_W / 2 + 10 + v.len) target = 0;
        }
        v.v += (target - v.v) * Math.min(1, dt * (target ? 0.8 : 2.5));
        v.pos += v.v * v.dir * dt; if (v.pos > 1000) v.pos -= 2000; if (v.pos < -1000) v.pos += 2000;
        const off = v.dir * (v.type === 'bus' ? 5.5 : 2.6);
        const onBridge = !v.alongX && inRiver(v.pos);
        const y = onBridge ? (v.lane === 0 ? 10.3 : -80) : 0.02;
        const x = v.alongX ? v.pos : v.lane + off; const z = v.alongX ? v.lane + off : v.pos;
        const ry = v.alongX ? (v.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (v.dir > 0 ? 0 : Math.PI);
        if (v.type === 'bus') set(buses, bi++, x, y, z, ry); else set(carBodies, ci++, x, y, z, ry);
        const fx = v.alongX ? v.dir * v.len / 2 : 0; const fz = v.alongX ? 0 : v.dir * v.len / 2;
        set(heads, i, x + fx, y + 0.8, z + fz, ry);
        set(tails, i, x - fx, y + 0.9, z - fz, ry);
      }
      for (const m of [carBodies, buses, heads, tails]) m.instanceMatrix.needsUpdate = true;
      // The tram.
      tram.x += tram.speed * tram.dir * dt; if (Math.abs(tram.x) > viaLen / 2 - 60) tram.dir *= -1;
      for (let i = 0; i < 5; i++) set(carriages, i, tram.x - tram.dir * i * 18.6, 17.4, TRAM_Z);
      carriages.instanceMatrix.needsUpdate = true;
      carriages.material.emissiveIntensity = 0.3 + 0.9 * dark;
      // Boats on the river, and moored ones rocking.
      boats.forEach((b, i) => {
        b.x += b.speed * b.dir * dt; if (b.x > 1300) b.x -= 2600; if (b.x < -1300) b.x += 2600;
        const ry = b.dir > 0 ? Math.PI / 2 : -Math.PI / 2; const sc = b.ferry ? 1.4 : 0.8;
        set(boatHull, i, b.x, -2.8, b.lane, ry, sc, 1, sc); set(boatCabin, i, b.x, -0.9, b.lane, ry, sc, 1, sc * 0.9); set(wakes, i, b.x, -3.05, b.lane, ry, sc, 1, sc);
      });
      boatHull.instanceMatrix.needsUpdate = true; boatCabin.instanceMatrix.needsUpdate = true; wakes.instanceMatrix.needsUpdate = true;
      for (let j = 0; j < 4; j++) set(moored, j, pierX + (j % 2 ? 11 : -11), -2.9 + Math.sin(t * 0.9 + j) * 0.12, RIVER.z - RIVER.half + 10 + Math.floor(j / 2) * 18, 0, 1, 1, 1, Math.sin(t * 0.7 + j * 2) * 0.03, Math.sin(t * 0.8 + j) * 0.05);
      moored.instanceMatrix.needsUpdate = true;
      // Aircraft blinking high on approach.
      planes.forEach((p, i) => { p.a += p.speed * dt; const x = Math.cos(p.a) * p.rad; const z = Math.sin(p.a) * p.rad; const ry = -p.a; set(planeBody, i, x, p.alt, z, ry); set(planeWing, i, x, p.alt, z, ry); set(strobes, i, x, p.alt - 2, z, ry, 1, 1, 1); });
      planeBody.instanceMatrix.needsUpdate = true; planeWing.instanceMatrix.needsUpdate = true; strobes.instanceMatrix.needsUpdate = true;
      strobeMat.opacity = (t % 1.4) < 0.12 ? 1 : 0.15;
      // Birds at dusk.
      birdPts.material.opacity = Math.min(0.8, dusk * 1.2 + light * 0.2);
      birds.forEach((b, i) => { b.a += b.speed * dt; birdPos[i * 3] = Math.cos(b.a) * b.rad + Math.sin(t + b.ph) * 6; birdPos[i * 3 + 1] = b.alt + Math.sin(t * 2 + b.ph) * 3; birdPos[i * 3 + 2] = Math.sin(b.a) * b.rad - 60; });
      birdGeo.attributes.position.needsUpdate = true;
      // People.
      people.forEach((p, i) => {
        let x; let z; let y = 0.05; let ry = 0;
        if (p.ring) { p.a += p.speed * dt; x = Math.cos(p.a) * p.ring; z = Math.sin(p.a) * p.ring; ry = -p.a; }
        else if (p.bank) { p.pos += p.speed * dt; if (p.pos > 700) p.pos -= 1400; if (p.pos < -700) p.pos += 1400; x = p.pos; z = RIVER.z + p.bank * (RIVER.half + 2); ry = p.speed > 0 ? Math.PI / 2 : -Math.PI / 2; }
        else if (p.bridge) { p.pos += p.speed * dt; if (p.pos > RIVER.z + 55) p.pos = RIVER.z - 55; if (p.pos < RIVER.z - 55) p.pos = RIVER.z + 55; x = p.side; z = p.pos; y = 10.05; ry = p.speed > 0 ? 0 : Math.PI; }
        else { p.pos += p.speed * dt; if (p.pos > 800) p.pos -= 1600; if (p.pos < -800) p.pos += 1600; if (p.alongX) { x = p.pos; z = p.lane; ry = p.speed > 0 ? Math.PI / 2 : -Math.PI / 2; } else { x = p.lane; z = inRiver(p.pos) ? RIVER.z + RIVER.half + 3 : p.pos; ry = p.speed > 0 ? 0 : Math.PI; } }
        set(figures, i, x, y + Math.abs(Math.sin(t * 6 + i)) * 0.05, z, ry);
      });
      figures.instanceMatrix.needsUpdate = true;
      // Rooftops.
      for (const s of steam) { const kk = (t * 0.12 + s.ph) % 1; s.sp.position.set(s.base.x + kk * 4, s.base.y + 2 + kk * 14, s.base.z); s.sp.scale.setScalar(3 + kk * 9); s.sp.material.opacity = 0.28 * (1 - kk) * (0.4 + 0.6 * dark); }
      if (radar) radar.rotation.y = t * 0.8;
      if (craneLight) craneLight.material.color.setHex((t % 2) < 0.25 ? LIFE_COLOURS.strobe : 0x4a4a4a);
      // Street light: lamps on and their pools from dusk.
      lampHeadMat.color.setHex(dark > 0.35 ? LIFE_COLOURS.lamp : 0x6a6252);
      poolMat.opacity = Math.max(0, dark - 0.25) * 0.55;
      // Fountains.
      for (const f of sprays) { for (let i = 0; i < f.n; i++) { const ph = (t * 0.8 + i / f.n) % 1; const a = i * 2.39; const rr = ph * 2.4; f.p[i * 3] = f.fx + Math.cos(a) * rr; f.p[i * 3 + 1] = 0.9 + 4 * ph * (1 - ph) * 3; f.p[i * 3 + 2] = 32 + Math.sin(a) * rr; } f.geo.attributes.position.needsUpdate = true; }
    },
    dispose() { scene.remove(root); root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); }); }
  };
}
