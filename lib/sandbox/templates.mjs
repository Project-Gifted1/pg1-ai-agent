// PG1 SANDBOX TEMPLATES: ready-made worlds as plain data. Built by a fixed
// generator (a seeded LCG over the template's own seed), so a template is
// the same JSON every time and is validated like any other world.
//
//   meadow    grass, rabbits and a fox (the first starter world)
//   town      a living town: roads, houses, shops, towers, a park, a lake
//             with boats, a farm, an airport and a launch pad; people walk
//             between buildings, cars, taxis, buses and bikes drive, planes
//             and a helicopter fly, and a rocket shuttles its crew between
//             the pad and a station in orbit
//   universe  the town, with a star, planets, moons and a shuttle in the
//             space above it
//
// Worlds are simulations: a template is a starting world, nothing more.

import { validateSpec, SANDBOX_LIMITS } from './engine.mjs';

export const TEMPLATE_NAMES = Object.freeze(['meadow', 'town', 'universe']);

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const r2 = (n) => Math.round(n * 100) / 100;

export function meadowSpec() {
  const ents = [];
  for (let i = 0; i < 10; i++) ents.push({ id: `grass-${i + 1}`, kind: 'grass', properties: { size: 2 }, position: { x: 10 + (i % 5) * 18, y: 20 + Math.floor(i / 5) * 40, z: 0 } });
  for (let i = 0; i < 6; i++) ents.push({ id: `rabbit-${i + 1}`, kind: 'rabbit', properties: { energy: 5 }, position: { x: 15 + i * 12, y: 50, z: 0 } });
  ents.push({ id: 'fox-1', kind: 'fox', properties: { energy: 8 }, position: { x: 80, y: 80, z: 0 } });
  return validateSpec({
    size: { x: 100, y: 100, z: 20 }, seed: 7, entities: ents,
    rules: [
      { id: 'rabbits-wander', type: 'move', kind: 'rabbit', wander: 1 },
      { id: 'grass-grows', type: 'grow', kind: 'grass', property: 'size', amount: 0.5, max: 5 },
      { id: 'rabbits-eat', type: 'interact', a: 'rabbit', b: 'grass', radius: 3, effect: { on: 'a', property: 'energy', delta: 1 } },
      { id: 'fox-hunts', type: 'attract', kind: 'fox', toward: 'rabbit', strength: 1, radius: 30 }
    ]
  });
}

// The town, on a 4 km square. Coordinates are metres; x east, y north, z up.
function townEntities(rand) {
  const E = [];
  const add = (id, kind, x, y, z = 0, properties = {}) => { E.push({ id, kind, position: { x: r2(x), y: r2(y), z: r2(z) }, properties }); return id; };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const COLORS = ['#e8d9c4', '#d9a679', '#b8c7d9', '#f2e6b3', '#c9d9b8', '#e3b5a4', '#ffffff', '#c4b8d9'];
  const ROOFS = ['#8c3b2e', '#4a4f5c', '#6b4a2f', '#2f5c4a', '#7a2f3b'];

  // Roads: a grid downtown, one avenue to the airport, one to the pad.
  const roads = [];
  for (let i = 0; i < 4; i++) roads.push(add(`road-ew-${i + 1}`, 'road', 1700, 1500 + i * 250, 0, { length: 1200, width: 14, heading: 0 }));
  for (let i = 0; i < 4; i++) roads.push(add(`road-ns-${i + 1}`, 'road', 1300 + i * 260, 1875, 0, { length: 1000, width: 14, heading: 90 }));
  add('road-airport', 'road', 1100, 2750, 0, { length: 1500, width: 16, heading: 90 });
  add('road-pad', 'road', 2700, 2900, 0, { length: 1600, width: 12, heading: 35 });
  add('road-farm', 'road', 950, 1200, 0, { length: 900, width: 10, heading: 20 });

  // Downtown: towers, apartments and the town's services around the grid.
  const towers = [];
  [[1560, 1760], [1820, 1760], [1560, 2010], [1820, 2010]].forEach(([x, y], i) => towers.push(add(`tower-${i + 1}`, 'tower', x + 60, y - 60, 0, { floors: 22 + Math.round(rand() * 18), color: pick(['#9fb7c9', '#7f97ab', '#b9c4cc', '#6d8597']) })));
  const apartments = [];
  for (let i = 0; i < 6; i++) apartments.push(add(`apartment-${i + 1}`, 'apartment', 1380 + (i % 3) * 260 + 60, i < 3 ? 1620 : 2120, 0, { floors: 6 + Math.round(rand() * 5), color: pick(COLORS) }));
  const services = [
    add('school-1', 'school', 2140, 1620, 0, { color: '#d9b38c' }),
    add('hospital-1', 'hospital', 2140, 1880, 0, { color: '#f2f2f2' }),
    add('station-1', 'station', 2140, 2130, 0, { color: '#c9b8a4' }),
    add('factory-1', 'factory', 2500, 1300, 0, { color: '#9a8f86' })
  ];
  const shops = [];
  for (let i = 0; i < 6; i++) shops.push(add(`shop-${i + 1}`, i % 3 === 2 ? 'cafe' : 'shop', 1360 + i * 130, 1440, 0, { color: pick(COLORS), awning: pick(['#c0392b', '#2e86c1', '#27ae60', '#f39c12']) }));

  // Houses: three neighbourhoods of streets.
  const houses = [];
  const hood = (x0, y0, cols, rows, prefix) => {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      houses.push(add(`house-${prefix}${r * cols + c + 1}`, 'house', x0 + c * 70 + (rand() - 0.5) * 8, y0 + r * 80 + (rand() - 0.5) * 8, 0, { color: pick(COLORS), roof: pick(ROOFS), floors: rand() < 0.3 ? 2 : 1, heading: r % 2 ? 180 : 0 }));
    }
  };
  hood(2420, 1560, 5, 4, 'e');
  hood(820, 1700, 4, 4, 'w');
  hood(1500, 2420, 6, 2, 'n');

  // The park, with a fountain, flowers, benches of trees, and lamps.
  const fountain = add('fountain-1', 'fountain', 1690, 1880);
  for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; add(`flower-${i + 1}`, 'flower', 1690 + Math.cos(a) * 26, 1880 + Math.sin(a) * 26, 0, { color: pick(['#ff6b8b', '#ffd166', '#c77dff', '#ff9f43']) }); }
  for (let i = 0; i < 24; i++) add(`lamp-${i + 1}`, 'lamp', 1300 + (i % 6) * 200, 1500 + Math.floor(i / 6) * 250 + 10);

  // Trees: the park, the streets and a wood to the north-west.
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; add(`tree-park-${i + 1}`, 'tree', 1690 + Math.cos(a) * 70, 1880 + Math.sin(a) * 70, 0, { size: 0.8 + rand() * 0.6 }); }
  for (let i = 0; i < 40; i++) add(`pine-${i + 1}`, 'pine', 300 + rand() * 600, 2500 + rand() * 900, 0, { size: 0.8 + rand() * 0.8 });
  for (let i = 0; i < 20; i++) add(`tree-${i + 1}`, 'tree', 2400 + rand() * 450, 1500 + rand() * 380, 0, { size: 0.7 + rand() * 0.6 });
  for (let i = 0; i < 6; i++) add(`palm-${i + 1}`, 'palm', 2900 + Math.cos(i) * 300, 1400 + Math.sin(i) * 300);
  for (let i = 0; i < 8; i++) add(`rock-${i + 1}`, 'rock', 500 + rand() * 500, 2600 + rand() * 700, 0, { size: 1 + rand() * 3 });

  // The lake, with boats and a ship.
  const lake = add('lake-1', 'lake', 2950, 1400, 0, { radius: 320 });
  const docks = [add('dock-1', 'bridge', 2700, 1280, 0, { length: 90, width: 8, heading: 30 }), add('dock-2', 'bridge', 3200, 1560, 0, { length: 90, width: 8, heading: 200 })];

  // The farm.
  const barn = add('barn-1', 'barn', 800, 1150, 0, { color: '#9b2d20' });
  for (let i = 0; i < 6; i++) add(`crop-${i + 1}`, 'crop', 560 + i * 45, 950, 0, { length: 220, color: i % 2 ? '#c9a227' : '#6a9a3a' });
  for (let i = 0; i < 5; i++) add(`cow-${i + 1}`, 'cow', 950 + rand() * 120, 1000 + rand() * 100);
  add('tractor-1', 'tractor', 640, 1020, 0, { color: '#2e7d32' });
  add('horse-1', 'horse', 1000, 1060);
  add('fence-farm', 'fence', 1010, 1050, 0, { length: 220, heading: 0 });

  // The airport, west of town: a runway, a hangar and aircraft.
  const runway = add('runway-1', 'runway', 700, 3150, 0, { length: 1400, width: 45, heading: 90 });
  const runway2 = add('runway-2', 'runway', 3500, 600, 0, { length: 700, width: 30, heading: 0 });
  add('hangar-1', 'hangar', 900, 2950, 0, { color: '#b0b8c0' });

  // The launch pad, north-east, with its tower.
  const pad = add('launch_pad-1', 'launch_pad', 3400, 3400);
  add('tower-launch', 'tower', 3440, 3400, 0, { floors: 9, color: '#c0392b', lattice: true });

  const buildings = [...houses, ...apartments, ...towers, ...services, ...shops];
  const places = [...buildings, fountain];

  // People: walking between homes, shops, the park and work.
  for (let i = 0; i < 46; i++) {
    const homeId = pick(houses.concat(apartments));
    const home = E.find((e) => e.id === homeId);
    add(`person-${i + 1}`, i % 9 === 8 ? 'child' : 'person', home.position.x + 6, home.position.y - 6, 0, { home: home.id, shirt: pick(['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#ecf0f1', '#e67e22', '#1abc9c']), target: pick(places) });
  }
  for (let i = 0; i < 5; i++) add(`dog-${i + 1}`, 'dog', 1600 + rand() * 200, 1800 + rand() * 160, 0, { target: fountain });
  for (let i = 0; i < 3; i++) add(`cat-${i + 1}`, 'cat', 2450 + rand() * 300, 1600 + rand() * 260);
  for (let i = 0; i < 6; i++) add(`bird-${i + 1}`, 'bird', 1500 + rand() * 600, 1700 + rand() * 500, 25 + rand() * 30);

  // Vehicles on the roads.
  const CAR_COLORS = ['#c0392b', '#2c3e50', '#ecf0f1', '#2980b9', '#7f8c8d', '#16a085', '#8e44ad', '#d35400', '#111111'];
  for (let i = 0; i < 16; i++) { const roadId = pick(roads); const at = E.find((e) => e.id === roadId); add(`car-${i + 1}`, 'car', at.position.x + (rand() - 0.5) * 500, at.position.y, 0, { color: pick(CAR_COLORS), target: pick(buildings) }); }
  for (let i = 0; i < 4; i++) add(`taxi-${i + 1}`, 'taxi', 1300 + i * 260, 1500, 0, { target: pick(buildings) });
  add('police_car-1', 'police_car', 2140, 1880, 0, { target: pick(buildings) });
  for (let i = 0; i < 3; i++) add(`bus-${i + 1}`, 'bus', 1300 + i * 400, 1750, 0, { color: pick(['#f1c40f', '#c0392b', '#2980b9']), target: pick(services.concat(shops)) });
  for (let i = 0; i < 3; i++) add(`truck-${i + 1}`, 'truck', 2400 + i * 40, 1300, 0, { color: pick(['#ecf0f1', '#34495e', '#e67e22']), target: pick(shops.concat(services)) });
  for (let i = 0; i < 8; i++) add(`bike-${i + 1}`, 'bike', 1400 + rand() * 700, 1500 + rand() * 750, 0, { color: pick(CAR_COLORS), target: pick(places) });
  for (let i = 0; i < 3; i++) add(`motorbike-${i + 1}`, 'motorbike', 1500 + i * 300, 2000, 0, { color: pick(CAR_COLORS), target: pick(buildings) });

  // A few people are riding: a driver in some cars, passengers on a bus.
  const people = E.filter((e) => e.kind === 'person');
  ['car-1', 'car-2', 'car-3', 'taxi-1', 'bus-1', 'bus-1', 'bike-1', 'motorbike-1'].forEach((v, i) => { people[i].properties.inside = v; delete people[i].properties.target; });

  // On the water.
  for (let i = 0; i < 4; i++) add(`boat-${i + 1}`, 'boat', 2950 + Math.cos(i * 1.7) * 160, 1400 + Math.sin(i * 1.7) * 160, 0, { color: pick(['#ffffff', '#e74c3c', '#2980b9', '#f1c40f']), target: pick(docks) });
  add('ship-1', 'ship', 3050, 1330, 0, { color: '#2c3e50', target: docks[1] });

  // In the air.
  add('plane-1', 'plane', 700, 3150, 0, { color: '#ffffff', livery: '#2e86c1', target: runway2 });
  add('plane-2', 'plane', 3500, 600, 0, { color: '#ffffff', livery: '#c0392b', target: runway });
  add('small_plane-1', 'small_plane', 600, 3100, 0, { color: '#f1c40f', target: runway2 });
  add('helicopter-1', 'helicopter', 2140, 1880, 0, { color: '#c0392b', target: pad });
  add('hot_air_balloon-1', 'hot_air_balloon', 1200, 2600, 120, { color: '#e67e22', target_x: 2600, target_y: 2600, target_z: 180 });
  add('drone-1', 'drone', 1690, 1880, 30, { target: 'tower-1' });

  // The rocket on its pad, with a crew of three aboard.
  add('rocket-1', 'rocket', 3400, 3400, 0, { color: '#f5f5f5', stages: 2 });
  for (let i = 0; i < 3; i++) add(`astronaut-${i + 1}`, 'astronaut', 3400, 3400, 0, { inside: 'rocket-1' });
  return { E, ids: { pad, lake, barn, runway, runway2, fountain } };
}

function townRules() {
  const BUILD = ['house', 'apartment', 'shop', 'cafe', 'tower', 'school', 'hospital', 'station', 'fountain'];
  return [
    { id: 'people-go-about', type: 'travel', kind: 'person', roam: BUILD },
    { id: 'children-play', type: 'travel', kind: 'child', roam: ['house', 'school', 'fountain'] },
    { id: 'dogs-run', type: 'travel', kind: 'dog', roam: ['fountain', 'house', 'tree'] },
    { id: 'cats-wander', type: 'move', kind: 'cat', wander: 3 },
    { id: 'cows-graze', type: 'move', kind: 'cow', wander: 1.5 },
    { id: 'horse-walks', type: 'move', kind: 'horse', wander: 3 },
    { id: 'birds-fly', type: 'move', kind: 'bird', wander: 10 },
    { id: 'cars-drive', type: 'travel', kind: 'car', roam: ['house', 'apartment', 'shop', 'tower', 'school', 'hospital', 'station', 'factory'] },
    { id: 'taxis-drive', type: 'travel', kind: 'taxi', roam: ['house', 'apartment', 'station', 'tower', 'hospital'] },
    { id: 'police-patrol', type: 'travel', kind: 'police_car', roam: ['tower', 'school', 'station', 'house'] },
    { id: 'buses-run', type: 'travel', kind: 'bus', roam: ['station', 'school', 'hospital', 'shop'] },
    { id: 'trucks-deliver', type: 'travel', kind: 'truck', roam: ['factory', 'shop', 'cafe', 'barn'] },
    { id: 'bikes-ride', type: 'travel', kind: 'bike', roam: ['house', 'shop', 'cafe', 'fountain', 'school'] },
    { id: 'motorbikes-ride', type: 'travel', kind: 'motorbike', roam: ['house', 'shop', 'tower', 'factory'] },
    { id: 'tractor-works', type: 'travel', kind: 'tractor', roam: ['crop', 'barn'] },
    { id: 'boats-sail', type: 'travel', kind: 'boat', roam: ['bridge'] },
    { id: 'ship-sails', type: 'travel', kind: 'ship', roam: ['bridge'] },
    { id: 'planes-fly', type: 'travel', kind: 'plane', roam: ['runway'] },
    { id: 'small-plane-flies', type: 'travel', kind: 'small_plane', roam: ['runway', 'barn'] },
    { id: 'helicopter-flies', type: 'travel', kind: 'helicopter', roam: ['hospital', 'launch_pad', 'tower'] },
    { id: 'balloon-drifts', type: 'travel', kind: 'hot_air_balloon' },
    { id: 'drone-hovers', type: 'travel', kind: 'drone', roam: ['tower', 'fountain', 'school'] },
    { id: 'rocket-shuttles', type: 'travel', kind: 'rocket', roam: ['space_station', 'launch_pad'] },
    { id: 'station-orbits', type: 'orbit', kind: 'space_station' },
    { id: 'satellites-orbit', type: 'orbit', kind: 'satellite' }
  ];
}

export function townSpec({ withSpace = false } = {}) {
  const rand = lcg(withSpace ? 4041 : 2024);
  const { E, ids } = townEntities(rand);
  // The station and satellites circle above the town, in space.
  E.push({ id: 'space_station-1', kind: 'space_station', position: { x: 2000, y: 2000, z: 2600 }, properties: { orbits: 'fountain-1', orbit_radius: 900, orbit_period: 160, orbit_altitude: 2600 } });
  for (let i = 0; i < 3; i++) E.push({ id: `satellite-${i + 1}`, kind: 'satellite', position: { x: 2000, y: 2000, z: 3200 }, properties: { orbits: ids.fountain, orbit_radius: 1300 + i * 200, orbit_period: 90 + i * 25, orbit_phase: i / 3, orbit_altitude: 3000 + i * 300 } });
  const rules = townRules();
  if (withSpace) {
    // The space above: a star, planets, moons, asteroids and a shuttle.
    E.push({ id: 'star-1', kind: 'star', position: { x: 2000, y: 2000, z: 8200 }, properties: { name: 'Helion', color: '#ffd27a' } });
    const planets = [
      { id: 'planet-1', name: 'Ferra', r: 520, p: 120, color: '#c1440e', size: 60 },
      { id: 'planet-2', name: 'Thalassa', r: 860, p: 210, color: '#2e86c1', size: 90, clouds: true },
      { id: 'planet-3', name: 'Zephyr', r: 1300, p: 340, color: '#d4ac6e', size: 150, rings: true },
      { id: 'planet-4', name: 'Glacia', r: 1750, p: 520, color: '#a9d6e5', size: 80 }
    ];
    planets.forEach((p, i) => E.push({ id: p.id, kind: 'planet', position: { x: 2000 + p.r, y: 2000, z: 8200 }, properties: { name: p.name, color: p.color, size: p.size, orbits: 'star-1', orbit_radius: p.r, orbit_period: p.p, orbit_phase: i * 0.27, ...(p.rings ? { rings: true } : {}), ...(p.clouds ? { clouds: true } : {}) } }));
    E.push({ id: 'moon-1', kind: 'moon', position: { x: 2000, y: 2000, z: 8200 }, properties: { name: 'Lune', color: '#cfcfcf', size: 22, orbits: 'planet-2', orbit_radius: 150, orbit_period: 30 } });
    E.push({ id: 'moon-2', kind: 'moon', position: { x: 2000, y: 2000, z: 8200 }, properties: { name: 'Io-b', color: '#e6d48a', size: 18, orbits: 'planet-3', orbit_radius: 230, orbit_period: 45, orbit_phase: 0.4 } });
    for (let i = 0; i < 12; i++) E.push({ id: `asteroid-${i + 1}`, kind: 'asteroid', position: { x: 2000, y: 2000, z: 8200 }, properties: { size: 4 + rand() * 8, orbits: 'star-1', orbit_radius: 1530 + rand() * 80, orbit_period: 420 + rand() * 60, orbit_phase: i / 12 } });
    E.push({ id: 'shuttle-1', kind: 'shuttle', position: { x: 2000, y: 2000, z: 2600 }, properties: { color: '#ecf0f1', target: 'planet-2' } });
    E.push({ id: 'astronaut-4', kind: 'astronaut', position: { x: 2000, y: 2000, z: 2600 }, properties: { inside: 'shuttle-1' } });
    rules.push(
      { id: 'planets-orbit', type: 'orbit', kind: 'planet' },
      { id: 'moons-orbit', type: 'orbit', kind: 'moon' },
      { id: 'asteroids-orbit', type: 'orbit', kind: 'asteroid' },
      { id: 'shuttle-explores', type: 'travel', kind: 'shuttle', roam: ['space_station', 'planet', 'moon'] }
    );
  }
  if (E.length > SANDBOX_LIMITS.entities) throw new Error(`template has ${E.length} entities`);
  return validateSpec({ size: { x: 4000, y: 4000, z: 10000 }, seed: withSpace ? 4041 : 2024, space_altitude: 2000, day_steps: 240, entities: E, rules });
}

// A template's spec by name, or null.
export function templateSpec(name) {
  if (name === 'meadow') return meadowSpec();
  if (name === 'town') return townSpec();
  if (name === 'universe') return townSpec({ withSpace: true });
  return null;
}
