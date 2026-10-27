// PG1 SANDBOX TEMPLATES: ready-made worlds as plain data. Built by a fixed
// generator (a seeded LCG over the template's own seed), so a template is
// the same JSON every time and is validated like any other world.
//
//   meadow    grass, rabbits and a fox (the first starter world)
//   town      a living town: roads, houses, shops, towers, a park, a lake
//             with boats, a farm, an airport and a launch pad; its people
//             live (the life rule: they decide where to go from their
//             needs, make friends, pair up, have children, grow up and
//             grow old), cars, taxis, buses and bikes drive, planes
//             and a helicopter fly, and a rocket shuttles its crew between
//             the pad and a station in orbit
//   universe  Pg1-Universe: four countries on islands in a sea, each with
//             its own culture, government, climate and towns (the town
//             above is the first, Aurelia), beaches, hotels, ports and
//             ferries between them, entertainment; and the space above:
//             a star, planets, moons, a station, a shuttle, and two far
//             worlds of other civilisations, hard to reach
//
// Worlds are simulations: a template is a starting world, nothing more.

import { validateSpec, nameFor, familyName, SANDBOX_LIMITS } from './engine.mjs';
import { buildTerrain } from './terrain.mjs';
import { planRoads, stripOf } from './roads.mjs';

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
  add('road-farm', 'road', 1050, 1260, 0, { length: 800, width: 10, heading: 10 });

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
  // Each pair of rows faces a street between them, 40 m from each row.
  const houses = [];
  const streets = [];
  const STREET = ['Oak Street', 'Mill Lane', 'Elm Avenue', 'Cedar Row', 'Willow Close'];
  const hood = (x0, y0, cols, rows, prefix) => {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      houses.push(add(`house-${prefix}${r * cols + c + 1}`, 'house', x0 + c * 70 + (rand() - 0.5) * 8, y0 + r * 80 + (rand() - 0.5) * 8, 0, { color: pick(COLORS), roof: pick(ROOFS), floors: rand() < 0.3 ? 2 : 1, heading: r % 2 ? 270 : 90 }));
    }
    for (let r = 0; r + 1 < rows; r += 2) streets.push({ points: [[x0 - 45, y0 + r * 80 + 40], [x0 + (cols - 1) * 70 + 45, y0 + r * 80 + 40]], width: 9, name: STREET[streets.length % STREET.length] });
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
  // Clear of the houses to its west (the old lake reached into a garden).
  const lake = add('lake-1', 'lake', 3000, 1340, 0, { radius: 260 });
  const docks = [add('dock-1', 'bridge', 2700, 1280, 0, { length: 90, width: 8, heading: 30 }), add('dock-2', 'bridge', 3200, 1560, 0, { length: 90, width: 8, heading: 200 })];

  // The farm.
  const barn = add('barn-1', 'barn', 800, 1150, 0, { color: '#9b2d20' });
  for (let i = 0; i < 6; i++) add(`crop-${i + 1}`, 'crop', 560 + i * 45, 950, 0, { length: 220, color: i % 2 ? '#c9a227' : '#6a9a3a' });
  for (let i = 0; i < 5; i++) add(`cow-${i + 1}`, 'cow', 950 + rand() * 120, 1000 + rand() * 100);
  add('tractor-1', 'tractor', 640, 1020, 0, { color: '#2e7d32' });
  add('horse-1', 'horse', 1000, 1060);
  add('fence-farm', 'fence', 1010, 1050, 0, { length: 220, heading: 0 });

  // The airport, west of town: a runway, a hangar and aircraft.
  const runway = add('runway-1', 'runway', 700, 3150, 0, { name: 'Aurelia Airport', length: 1400, width: 45, heading: 90 });
  const runway2 = add('runway-2', 'runway', 3500, 600, 0, { length: 700, width: 30, heading: 0 });
  add('hangar-1', 'hangar', 900, 2950, 0, { color: '#b0b8c0' });

  // The launch pad, north-east, with its tower.
  const pad = add('launch_pad-1', 'launch_pad', 3400, 3400);
  add('tower-launch', 'tower', 3440, 3400, 0, { floors: 9, color: '#c0392b', lattice: true });

  const buildings = [...houses, ...apartments, ...towers, ...services, ...shops];
  const places = [...buildings, fountain];

  // People: who they are, where they live; some start as couples and
  // families. The life rule decides where each goes next.
  const SHIRTS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#ecf0f1', '#e67e22', '#1abc9c'];
  for (let i = 0; i < 40; i++) {
    const homeId = pick(houses.concat(apartments));
    const home = E.find((e) => e.id === homeId);
    const sex = i % 2 ? 'male' : 'female';
    add(`person-${i + 1}`, 'person', home.position.x + 6, home.position.y - 6, 0, { home: home.id, sex, name: nameFor(sex, rand), age: Math.round(19 + rand() * 45), shirt: pick(SHIRTS) });
  }
  // Twelve couples, sharing a home; four of them with children.
  const adults = E.filter((e) => e.kind === 'person');
  for (let c = 0; c < 12; c++) {
    const a = adults[c * 2]; const b = adults[c * 2 + 1];
    a.properties.partner = b.id; b.properties.partner = a.id;
    b.properties.home = a.properties.home; b.position = { ...a.position };
    a.properties.age = Math.min(a.properties.age, 40); b.properties.age = Math.min(b.properties.age, 42);
  }
  for (let c = 0; c < 4; c++) {
    const mum = adults[c * 2]; const dad = adults[c * 2 + 1];
    for (let k = 0; k < 2; k++) {
      const sex = rand() < 0.5 ? 'female' : 'male';
      add(`child-${c * 2 + k + 1}`, 'child', mum.position.x + 2, mum.position.y + 2 + k, 0, { home: mum.properties.home, sex, name: nameFor(sex, rand), age: 3 + Math.round(rand() * 10), mother: mum.id, father: dad.id, shirt: pick(SHIRTS) });
    }
    mum.properties.children = 2; dad.properties.children = 2;
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
  ['car-1', 'car-2', 'car-3', 'taxi-1', 'bus-1', 'bus-1', 'bike-1', 'motorbike-1'].forEach((v, i) => { const who = people[people.length - 1 - i]; who.properties.inside = v; delete who.properties.target; });

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
  return { E, streets, ids: { pad, lake, barn, runway, runway2, fountain } };
}

// The home island's coast and leisure (Pg1-Universe only): a port, a
// beach, a hotel, a cinema, a theatre, a bar, a stadium and a fair.
function homeExtras(E, rand) {
  const add = (id, kind, x, y, z = 0, properties = {}) => { E.push({ id, kind, position: { x: r2(x), y: r2(y), z: r2(z) }, properties }); return id; };
  add('port-aurelia', 'port', 4200, 2300, 0, { name: 'Aurelia Harbour', heading: 0 });
  add('beach-aurelia', 'beach', 3950, 1450, 0, { name: 'Gold Strand', length: 260, heading: 70 });
  add('hotel-aurelia', 'hotel', 3700, 1700, 0, { name: 'The Strand Hotel', floors: 7, color: '#f5f0e6' });
  add('cinema-1', 'cinema', 2320, 1440, 0, { name: 'Odeon', color: '#5c2a3d' });
  add('theatre-1', 'theatre', 2380, 2260, 0, { name: 'Royal Theatre', color: '#e8dcc4' });
  add('bar-1', 'bar', 2250, 2400, 0, { name: 'The Anchor', color: '#6d4c41' });
  add('stadium-1', 'stadium', 2750, 2750, 0, { name: 'Aurelia Stadium' });
  add('amusement-1', 'amusement', 1150, 1350, 0, { name: 'Summer Fair' });
  add('terminal-aurelia', 'terminal', 860, 3150, 0, { name: 'Aurelia Airport' });
}

// Another country: an island town of its own, built from its climate.
const CLIMATES = {
  tropical: { walls: ['#ffd1dc', '#b5ead7', '#ffdac1', '#e2f0cb', '#c7ceea', '#fff1a8'], roofs: ['#e07a5f', '#3d405b', '#81b29a'], tree: 'palm' },
  cold: { walls: ['#8d6e63', '#a1887f', '#6d4c41', '#bcaaa4', '#d7ccc8'], roofs: ['#263238', '#37474f', '#4e342e'], tree: 'pine' },
  maritime: { walls: ['#fafafa', '#eceff1', '#cfd8dc', '#e0e0e0'], roofs: ['#455a64', '#5d4037', '#37474f'], tree: 'bush' },
  temperate: { walls: ['#e8d9c4', '#d9a679', '#b8c7d9'], roofs: ['#8c3b2e', '#4a4f5c'], tree: 'tree' }
};
function countryEntities(E, rand, c) {
  const add = (id, kind, x, y, z = 0, properties = {}) => { E.push({ id, kind, position: { x: r2(x), y: r2(y), z: r2(z) }, properties }); return id; };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const cl = CLIMATES[c.climate] || CLIMATES.temperate;
  const P = (dx, dy) => ({ x: c.x + dx, y: c.y + dy });
  add(`island-${c.code}`, 'island', c.x, c.y, 0, { country: c.code, name: c.name, culture: c.culture, government: c.government, climate: c.climate, radius: c.r });
  // The town: houses in rows, a high street, a school, a hotel by the beach.
  // Houses in rows along the High Street (east and west) and the Avenue
  // (north and south), set back 26 m and facing the street.
  const houses = [];
  for (let i = 0; i < c.houses; i++) {
    const arm = i % 4; const rank = Math.floor(i / 4); const side = rank % 2 ? -1 : 1;
    const along = 130 + 70 * Math.floor(rank / 2) + (rank % 2) * 35;
    const [dx, dy, heading] = arm === 0 ? [along, 26 * side, side > 0 ? 270 : 90] : arm === 1 ? [-along, 26 * side, side > 0 ? 270 : 90] : arm === 2 ? [26 * side, along, side > 0 ? 180 : 0] : [26 * side, -along, side > 0 ? 180 : 0];
    const p = P(dx, dy);
    houses.push(add(`house-${c.code}-${i + 1}`, c.climate === 'cold' ? 'cabin' : 'house', p.x, p.y, 0, { color: pick(cl.walls), roof: pick(cl.roofs), floors: rand() < 0.3 ? 2 : 1, heading }));
  }
  add(`road-${c.code}-1`, 'road', c.x, c.y, 0, { name: `${c.name} High Street`, length: c.r * 1.2, width: 12, heading: 0 });
  add(`road-${c.code}-2`, 'road', c.x, c.y, 0, { name: `${c.name} Avenue`, length: c.r * 1.0, width: 10, heading: 90 });
  add(`shop-${c.code}-1`, 'shop', c.x + 60, c.y + 30, 0, { color: pick(cl.walls), awning: pick(['#e07a5f', '#2e86c1', '#27ae60']) });
  add(`cafe-${c.code}-1`, 'cafe', c.x - 70, c.y + 30, 0, { color: pick(cl.walls), awning: '#f39c12' });
  add(`shop-${c.code}-2`, 'shop', c.x + 150, c.y - 40, 0, { color: pick(cl.walls) });
  add(`school-${c.code}`, 'school', c.x - 200, c.y - 160, 0, { color: pick(cl.walls) });
  add(`factory-${c.code}`, c.climate === 'tropical' ? 'barn' : 'factory', c.x + 260, c.y + 200, 0, { color: '#9a8f86' });
  add(`fountain-${c.code}`, 'fountain', c.x - 75, c.y - 75);
  // The coast: a port facing the home island, beaches and hotels.
  const toHome = Math.atan2(2200 - c.y, 2000 - c.x);
  const coast = (ang, inset = 60) => P(Math.cos(ang) * (c.r - inset), Math.sin(ang) * (c.r - inset));
  const port = coast(toHome, 50);
  add(`port-${c.code}`, 'port', port.x, port.y, 0, { name: `${c.name} Harbour`, heading: Math.round((toHome * 180) / Math.PI) });
  for (let b = 0; b < c.beaches; b++) { const ang = toHome + Math.PI * (0.5 + b * 0.6); const bp = coast(ang, 40); add(`beach-${c.code}-${b + 1}`, 'beach', bp.x, bp.y, 0, { name: `${pick(['Coral', 'Silver', 'Long', 'Palm', 'Seal', 'Amber'])} Beach`, length: 220, heading: Math.round(((ang + Math.PI / 2) * 180) / Math.PI) }); const hp = coast(ang, 160); add(`hotel-${c.code}-${b + 1}`, 'hotel', hp.x, hp.y, 0, { name: `${pick(['Grand', 'Seaview', 'Royal', 'Lagoon', 'Harbour'])} Hotel`, floors: 4 + Math.floor(rand() * 6), color: pick(cl.walls) }); }
  const offStreet = (d) => (Math.abs(d) < 60 ? (d < 0 ? -60 : 60) : d);
  for (const v of c.venues) { const vp = P(offStreet((rand() - 0.5) * c.r * 0.6), offStreet((rand() - 0.5) * c.r * 0.6)); add(`${v}-${c.code}`, v, vp.x, vp.y, 0, { name: `${c.name} ${v === 'stadium' ? 'Arena' : v === 'bar' ? 'Tavern' : v[0].toUpperCase() + v.slice(1)}`, color: pick(cl.walls) }); }
  // Every country has a runway (Saltreach, the smallest, an airstrip).
  if (c.runway) { add(`runway-${c.code}`, 'runway', c.x + c.r * 0.45, c.y - c.r * 0.35, 0, { name: `${c.name} Airport`, length: 900, width: 35, heading: 0 }); add(`terminal-${c.code}`, 'terminal', c.x + c.r * 0.45 - 60, c.y - c.r * 0.35 + 50, 0, { name: `${c.name} Airport` }); }
  else { add(`runway-${c.code}`, 'runway', c.x + c.r * 0.05, c.y - c.r * 0.6, 0, { name: `${c.name} Airstrip`, length: 640, width: 25, heading: 0 }); }
  // Its trees.
  for (let i = 0; i < c.trees; i++) { const a = rand() * Math.PI * 2; const d = c.r * (0.4 + rand() * 0.5); const tp = P(Math.cos(a) * d, Math.sin(a) * d); add(`${cl.tree}-${c.code}-${i + 1}`, cl.tree, tp.x, tp.y, 0, { size: 0.8 + rand() * 0.6 }); }
  // Its people: couples sharing a home, some with children.
  const SHIRTS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#ecf0f1'];
  const adults = [];
  for (let i = 0; i < c.people; i++) {
    const homeId = houses[Math.floor(i / 2) % houses.length];
    const h = E.find((e) => e.id === homeId);
    const sex = i % 2 ? 'male' : 'female';
    adults.push(E[E.push({ id: `person-${c.code}-${i + 1}`, kind: 'person', position: { x: r2(h.position.x + 5), y: r2(h.position.y - 5), z: 0 }, properties: { home: homeId, country: c.code, sex, name: nameFor(sex, rand, c.culture), family: familyName(rand, c.culture), age: Math.round(20 + rand() * 40), shirt: pick(SHIRTS) } }) - 1]);
  }
  for (let k = 0; k + 1 < adults.length && k < c.people * 0.6; k += 2) { const a = adults[k]; const b = adults[k + 1]; a.properties.partner = b.id; b.properties.partner = a.id; b.properties.family = a.properties.family; b.properties.age = Math.min(b.properties.age, 42); a.properties.age = Math.min(a.properties.age, 40); }
  for (let k = 0; k < Math.floor(c.people / 6); k++) {
    const mum = adults[k * 2]; const sex = rand() < 0.5 ? 'female' : 'male';
    add(`child-${c.code}-${k + 1}`, 'child', mum.position.x + 2, mum.position.y + 2, 0, { home: mum.properties.home, country: c.code, sex, name: nameFor(sex, rand, c.culture), family: mum.properties.family, age: 4 + Math.round(rand() * 9), mother: mum.id, father: mum.properties.partner, shirt: pick(SHIRTS) });
  }
  // Boats in its waters.
  for (let i = 0; i < 2; i++) { const bp = coast(toHome + (i ? 0.4 : -0.4), -60); add(`boat-${c.code}-${i + 1}`, 'boat', bp.x, bp.y, 0, { color: pick(['#ffffff', '#e74c3c', '#2980b9']), target: `port-${c.code}` }); }
}

export const COUNTRIES = Object.freeze([
  { code: 'maravia', name: 'Maravia', culture: 'maravian', government: 'council', climate: 'tropical', x: 8200, y: 2300, r: 1500, houses: 16, people: 26, trees: 30, beaches: 3, venues: ['bar', 'amusement', 'stadium'], runway: true },
  { code: 'nordheim', name: 'Nordheim', culture: 'nordic', government: 'monarchy', climate: 'cold', x: 6200, y: 6300, r: 1300, houses: 14, people: 22, trees: 36, beaches: 1, venues: ['theatre', 'bar'], runway: true },
  { code: 'saltreach', name: 'Saltreach', culture: 'saltreach', government: 'democracy', climate: 'maritime', x: 10600, y: 6400, r: 800, houses: 8, people: 12, trees: 12, beaches: 2, venues: ['bar'], runway: false }
]);

function townRules() {
  return [
    { id: 'people-live', type: 'life', kind: 'person', child_kind: 'child', year_steps: 240, adult_age: 18, max_age: 85, meet_radius: 15, birth_chance: 0.02 },
    { id: 'people-walk', type: 'travel', kind: 'person' },
    { id: 'children-walk', type: 'travel', kind: 'child' },
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
    { id: 'small-plane-flies', type: 'travel', kind: 'small_plane', roam: ['runway'] },
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
  const { E, streets, ids } = townEntities(rand);
  // The station and satellites circle above the town, in space.
  E.push({ id: 'space_station-1', kind: 'space_station', position: { x: 2000, y: 2000, z: 2600 }, properties: { orbits: 'fountain-1', orbit_radius: 900, orbit_period: 160, orbit_altitude: 2600 } });
  for (let i = 0; i < 3; i++) E.push({ id: `satellite-${i + 1}`, kind: 'satellite', position: { x: 2000, y: 2000, z: 3200 }, properties: { orbits: ids.fountain, orbit_radius: 1300 + i * 200, orbit_period: 90 + i * 25, orbit_phase: i / 3, orbit_altitude: 3000 + i * 300 } });
  const rules = townRules();
  if (withSpace) {
    // Pg1-Universe: the town is Aurelia, one of four countries on islands.
    E.push({ id: 'island-aurelia', kind: 'island', position: { x: 2000, y: 2200, z: 0 }, properties: { country: 'aurelia', name: 'Aurelia', culture: 'aurelian', government: 'democracy', climate: 'temperate', radius: 2300 } });
    homeExtras(E, rand);
    for (const c of COUNTRIES) countryEntities(E, rand, c);
    const ports = ['port-aurelia', ...COUNTRIES.map((c) => `port-${c.code}`)];
    const ferries = [['Sea Swallow', 'port-aurelia'], ['Northern Star', 'port-nordheim'], ['Coral Queen', 'port-maravia']];
    // Each ferry starts at its harbour's water side.
    const sea = buildTerrain(E, { x: 12000, y: 8000 });
    for (const [i, [name, at]] of ferries.entries()) { const p0 = E.find((e) => e.id === at).position; const p = sea.nearestWater(p0.x, p0.y, { margin: 8 }) || p0; E.push({ id: `ferry-${i + 1}`, kind: 'ferry', position: { x: r2(p.x), y: r2(p.y), z: 0 }, properties: { name, color: ['#ffffff', '#1565c0', '#c62828'][i], target: ports[(ports.indexOf(at) + 1) % ports.length] } }); }
    rules.push({ id: 'ferries-sail', type: 'travel', kind: 'ferry', roam: ['port'] });
    E.push({ id: 'plane-3', kind: 'plane', position: { x: 8200 + 675, y: 2300 - 525, z: 0 }, properties: { name: 'Maravia Air 7', color: '#ffffff', livery: '#e07a5f', target: 'runway-1' } });
    rules.push({ id: 'army-trucks', type: 'travel', kind: 'army_truck', roam: ['barracks', 'port', 'police_station'] }, { id: 'patrols', type: 'travel', kind: 'patrol_boat', roam: ['port'] });
  }
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
    // Others out there: two far worlds with their own civilisations.
    // Far out, at the very edge of the sky: hard to reach.
    E.push({ id: 'alien_world-1', kind: 'alien_world', position: { x: 11900, y: 7900, z: 9950 }, properties: { name: 'the Vel', color: '#7e57c2', size: 110 } });
    E.push({ id: 'alien_world-2', kind: 'alien_world', position: { x: 11800, y: 150, z: 9900 }, properties: { name: 'the Oru', color: '#26a69a', size: 90, rings: true } });
    E.push({ id: 'shuttle-1', kind: 'shuttle', position: { x: 2000, y: 2000, z: 2600 }, properties: { color: '#ecf0f1', target: 'planet-2' } });
    E.push({ id: 'astronaut-4', kind: 'astronaut', position: { x: 2000, y: 2000, z: 2600 }, properties: { inside: 'shuttle-1' } });
    rules.push(
      { id: 'planets-orbit', type: 'orbit', kind: 'planet' },
      { id: 'moons-orbit', type: 'orbit', kind: 'moon' },
      { id: 'asteroids-orbit', type: 'orbit', kind: 'asteroid' },
      { id: 'shuttle-explores', type: 'travel', kind: 'shuttle', roam: ['space_station', 'planet', 'moon'] },
      { id: 'visitors-fly', type: 'travel', kind: 'alien_ship' },
      { id: 'visitors-walk', type: 'move', kind: 'alien', wander: 3 }
    );
  }
  if (E.length > SANDBOX_LIMITS.entities) throw new Error(`template has ${E.length} entities`);
  const size = withSpace ? { x: 12000, y: 8000, z: 10000 } : { x: 4000, y: 4000, z: 10000 };
  // The roads (lib/sandbox/roads.mjs): the streets above and the road strips,
  // a ring road (round each island, or round the town), and a way in to every place.
  const strips = E.filter((e) => e.kind === 'road').map((e) => { const st = stripOf(e); return { points: [[st.ax, st.ay], [st.bx, st.by]], width: st.w, name: st.name }; });
  const roads = planRoads(E, buildTerrain(E, size), { size, streets: [...strips, ...streets], townRing: { name: 'Ring Road', points: [[460, 820], [3760, 820], [3760, 3940], [460, 3940]] } });
  return validateSpec({ size, seed: withSpace ? 4041 : 2024, space_altitude: 2000, day_steps: 240, entities: E, rules, roads });
}

// A template's spec by name, or null.
export function templateSpec(name) {
  if (name === 'meadow') return meadowSpec();
  if (name === 'town') return townSpec();
  if (name === 'universe') return townSpec({ withSpace: true });
  return null;
}
