// PG1 SANDBOX TEMPLATE benin-warri: Benin and Warri c. 1610, a simulation
// inspired by history. Its inhabitants are fictional. Every historical
// fact it uses is listed, with its source, in docs/sandbox-benin-warri.md
// (the keys B1, W4... below are that page's); anything that could not be
// sourced is left out.
//
//   Benin   inland, its capital in the forest behind the earthworks (the
//           walls and ditch, B1); the Oba's palace with its chiefs (B2), the
//           brass casters' and ivory carvers' workshops (B3), a palace
//           shrine (B4); Ughoton, the river port (B5), on a river to the coast
//   Warri   an island among the creeks and mangroves of the delta: the
//           capital, Ode-Itsekiri (W4, W5), the Olu's residence, homes and
//           canoe landings, fishing villages (W14), the royal burial grove
//           at Ijala (W3). No church and no resident priest (W8).
//   Urhobo  an inland, farming people (W14), with their landing on a creek
//   Ijaw    fishers and salt makers of the salt-water belt (N1), on an island
//   the Portuguese  a merchant ship anchoring offshore (W12); its traders are
//           visitors, not a country with a home here
//   Nok     one heritage site, far older than this world (D1)
//
// The world uses the engine, society and research modules as they are: a
// `life` rule with progress: false (technology stays at its time) and
// peaceful: true (no disputes or wars are invented). Period things only:
// walking, porters, canoes on the creeks and rivers, a sailing ship at
// sea; no cars, bikes, planes, rockets or space. Built the same way every
// time (a seeded generator), and validated like any other world.

import { validateSpec, SANDBOX_LIMITS } from './engine.mjs';
import { nameFor, familyName } from './society.mjs';
import { buildTerrain } from './terrain.mjs';

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const r2 = (n) => Math.round(n * 100) / 100;
const LANDING_GAP = 12;   // metres from a landing to the water
const VILLAGE_GAP = 35;   // from a fishing village to the water
const at = (c, a, d) => ({ x: c.x + Math.cos((a * Math.PI) / 180) * d, y: c.y + Math.sin((a * Math.PI) / 180) * d });

// The peoples, their land and their capitals (metres; x east, y north).
export const PEOPLES = Object.freeze([
  { code: 'benin', name: 'Benin', culture: 'edo', government: 'monarchy', title: 'Oba', climate: 'tropical', x: 8000, y: 5800, r: 1500, crafts: 'brass casting, ivory carving, cloth' },
  { code: 'warri', name: 'Warri', culture: 'itsekiri', government: 'monarchy', title: 'Olu', climate: 'tropical', x: 4300, y: 2800, r: 1000, crafts: 'fishing, trade by canoe' },
  { code: 'urhobo', name: 'Urhobo', culture: 'urhobo', government: 'council', title: 'Head of the elders', climate: 'tropical', x: 6000, y: 5400, r: 650, crafts: 'farming' },
  { code: 'ijaw', name: 'Ijaw', culture: 'ijaw', government: 'council', title: 'Head of the elders', climate: 'maritime', x: 2400, y: 1700, r: 600, crafts: 'fishing, salt making' }
]);
// The land behind the coast (forest), the mangroves, and the water that cuts them.
const FOREST = [[8600, 6000, 2400], [6000, 6500, 2000], [10500, 4200, 2300], [7000, 4200, 1500]];
const MANGROVE = [[3200, 4000, 450], [5400, 1700, 400], [3300, 1100, 350], [1500, 2800, 400]];
const RIVERS = [
  { id: 'river-ughoton', kind: 'river', from: [6911, 4711], to: [5600, 2950], width: 40, name: 'the river to the coast' },
  { id: 'creek-urhobo', kind: 'creek', from: [6000, 4700], to: [6124, 3654], width: 18, name: 'the creek to the Urhobo landing' },
  { id: 'creek-north', kind: 'creek', from: [2900, 3700], to: [3500, 4300], width: 14, name: 'a creek through the mangroves' },
  { id: 'creek-south', kind: 'creek', from: [5100, 1500], to: [5700, 2000], width: 14, name: 'a creek through the mangroves' }
];

export function beninWarriSpec() {
  const rand = lcg(1610);
  const E = [];
  const add = (id, kind, x, y, properties = {}, z = 0) => { E.push({ id, kind, position: { x: r2(x), y: r2(y), z: r2(z) }, properties }); return id; };
  const pick = (list) => list[Math.floor(rand() * list.length)];

  // What the viewer's History panel shows (public/sandbox/history.js).
  add('chronicle', 'chronicle', 1, 1, { history: 'benin-warri', label: 'Simulation inspired by history; inhabitants are fictional.' });
  // Land and water.
  FOREST.forEach(([x, y, r], i) => add(`forest-${i + 1}`, 'forest', x, y, { radius: r }));
  MANGROVE.forEach(([x, y, r], i) => add(`mangrove-${i + 1}`, 'mangrove', x, y, { radius: r }));
  for (const w of RIVERS) add(w.id, w.kind, w.from[0], w.from[1], { to_x: w.to[0], to_y: w.to[1], width: w.width, name: w.name });
  for (const p of PEOPLES) add(`island-${p.code}`, 'island', p.x, p.y, { country: p.code, name: p.name, culture: p.culture, government: p.government, ruler_title: p.title, climate: p.climate, radius: p.r, crafts: p.crafts });

  const B = PEOPLES[0]; const W = PEOPLES[1]; const U = PEOPLES[2]; const J = PEOPLES[3];
  const homes = { benin: [], warri: [], urhobo: [], ijaw: [] };
  // A landing stands at the water's edge, a fishing village just above it:
  // moved straight towards the nearest water (rivers, creeks, the sea) until
  // it is gap metres from it, by the world's own terrain.
  const waterMap = buildTerrain(E, { x: 12000, y: 8000 });
  const shore = (x, y, gap) => {
    const w = waterMap.nearestWater(x, y);
    const d = w ? Math.hypot(x - w.x, y - w.y) : 0;
    if (!(d > gap)) return { x, y };
    // Never in the water itself: step back towards where it was until on land.
    for (let g = gap; g < d; g += 2) { const q = { x: w.x + (x - w.x) * (g / d), y: w.y + (y - w.y) * (g / d) }; if (waterMap.isLand(q.x, q.y)) return q; }
    return { x, y };
  };
  // A landing's jetty (its model's length) points out over the water.
  const addShore = (id, kind, x, y, props, gap) => {
    const p = shore(x, y, gap);
    const w = waterMap.nearestWater(p.x, p.y);
    const heading = kind === 'canoe_landing' && w ? { heading: Math.round(((Math.atan2(w.y - p.y, w.x - p.x) * 180) / Math.PI + 360) % 360) } : {};
    return add(id, kind, p.x, p.y, { ...props, ...heading });
  };

  // Benin: the walls (B1) with their nine manned gates (B7), the palace (B2)
  // and its shrine (B4), the workshops (B3). The world is smaller than life:
  // the city's inner iya, 12-15 km round, is a ring 900 m across here.
  const WALL = 900; const GATES = 9;
  add('earthwork-benin', 'earthwork', B.x, B.y, { name: 'the walls of Benin', radius: WALL, gates: GATES, country: 'benin' });
  const gates = [];
  for (let g = 0; g < GATES; g++) { const a = (g / GATES) * 360; const p = at(B, a, WALL); gates.push(add(`gate-benin-${g + 1}`, 'gate', p.x, p.y, { name: `a gate of Benin (${g + 1} of ${GATES})`, heading: Math.round(a), country: 'benin' })); }
  add('palace-benin', 'palace', B.x, B.y, { name: 'the Oba\'s palace', country: 'benin' });
  add('shrine-benin', 'shrine', B.x - 70, B.y + 45, { name: 'the palace shrine', country: 'benin' });
  add('brass_workshop-benin', 'brass_workshop', B.x + 95, B.y - 70, { name: 'the brass casters\' quarter', country: 'benin' });
  add('ivory_workshop-benin', 'ivory_workshop', B.x - 95, B.y - 70, { name: 'the ivory carvers\' workshops', country: 'benin' });
  for (let i = 0; i < 22; i++) { const p = at(B, (i / 22) * 360 + 10, 260 + (i % 4) * 150); homes.benin.push(add(`compound-benin-${i + 1}`, 'compound', p.x, p.y, { country: 'benin', heading: Math.round((i / 22) * 360 + 190) % 360 })); }
  // The wider walls (B7): villages outside the city, each in an enclosure of
  // its own (rampart and ditch, smaller than the city's), with its farms,
  // joined to the city's walls and to each other by lines of earthwork.
  const VILLAGES = [15, 65, 115, 165, 290, 335]; const VD = 1230; const VR = 150;
  VILLAGES.forEach((a, v) => {
    const c = at(B, a, VD);
    add(`earthwork-benin-village-${v + 1}`, 'earthwork', c.x, c.y, { name: 'a village enclosure', radius: VR, gates: 2, size: 'small', country: 'benin' });
    for (let i = 0; i < 2; i++) { const p = at(c, a + 90 + i * 180, 55); homes.benin.push(add(`compound-benin-village-${v + 1}-${i + 1}`, 'compound', p.x, p.y, { country: 'benin', heading: Math.round(a + 180) % 360 })); }
    const f = at(c, a + 180, 70); add(`crop-benin-${v + 1}`, 'crop', f.x, f.y, { country: 'benin', length: 90, heading: Math.round(a + 90) % 360, color: v % 2 ? '#6a9a3a' : '#7da34a' });
    // A line out from the city's walls to the village.
    const r0 = WALL + 20; const r1 = VD - VR - 10; const m = at(B, a + 4, (r0 + r1) / 2);
    add(`earthwork-benin-line-${v + 1}`, 'earthwork', m.x, m.y, { name: 'a line of earthwork', shape: 'line', length: Math.round(r1 - r0), heading: Math.round(a + 4) % 360, size: 'small', country: 'benin' });
  });
  for (let v = 0; v + 1 < VILLAGES.length; v++) {
    if (VILLAGES[v + 1] - VILLAGES[v] > 60) continue;   // not across the way to the river
    const p = at(B, VILLAGES[v], VD); const q = at(B, VILLAGES[v + 1], VD);
    const d = Math.hypot(q.x - p.x, q.y - p.y); const head = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI;
    add(`earthwork-benin-link-${v + 1}`, 'earthwork', (p.x + q.x) / 2, (p.y + q.y) / 2, { name: 'a line of earthwork', shape: 'line', length: Math.round(d - 2 * VR - 20), heading: Math.round((head + 360) % 360), size: 'small', country: 'benin' });
  }
  // Ughoton (B5) at the river.
  const ughoton = at(B, 225, 1400);
  addShore('landing-ughoton', 'canoe_landing', ughoton.x, ughoton.y, { name: 'Ughoton, Benin\'s river port', country: 'benin' }, LANDING_GAP);

  // Warri: Ode-Itsekiri (W4, W5) with the Olu's residence, homes, landings;
  // fishing villages (W14); the royal burial grove at Ijala (W3).
  add('palace-warri', 'palace', W.x, W.y, { name: 'the Olu\'s residence, Ode-Itsekiri', country: 'warri', small: true });
  for (let i = 0; i < 10; i++) { const p = at(W, (i / 10) * 360 + 18, 220 + (i % 2) * 160); homes.warri.push(add(`compound-warri-${i + 1}`, 'compound', p.x, p.y, { country: 'warri', heading: Math.round((i / 10) * 360 + 198) % 360 })); }
  addShore('landing-warri-east', 'canoe_landing', W.x + 950, W.y + 50, { name: 'the east landing, Ode-Itsekiri', country: 'warri' }, LANDING_GAP);
  addShore('landing-warri-north', 'canoe_landing', W.x, W.y + 955, { name: 'the north landing, Ode-Itsekiri', country: 'warri' }, LANDING_GAP);
  addShore('landing-warri-west', 'canoe_landing', W.x - 940, W.y + 100, { name: 'the west landing, Ode-Itsekiri', country: 'warri' }, LANDING_GAP);
  homes.warri.push(addShore('fishing_village-warri-1', 'fishing_village', W.x - 860, W.y - 120, { name: 'a fishing village on the creek', country: 'warri' }, VILLAGE_GAP));
  homes.warri.push(addShore('fishing_village-warri-2', 'fishing_village', W.x + 100, W.y - 880, { name: 'a fishing village by the mangroves', country: 'warri' }, VILLAGE_GAP));
  add('royal_tomb-ijala', 'royal_tomb', W.x - 600, W.y + 700, { name: 'the royal burial grove at Ijala', country: 'warri' });

  // Urhobo: farms (W14) and their landing on the creek.
  for (let i = 0; i < 6; i++) { const p = at(U, (i / 6) * 360 + 30, 200 + (i % 2) * 120); homes.urhobo.push(add(`compound-urhobo-${i + 1}`, 'compound', p.x, p.y, { country: 'urhobo', heading: Math.round((i / 6) * 360 + 210) % 360 })); }
  for (let i = 0; i < 6; i++) { const p = at(U, 60 + i * 45, 470); add(`crop-urhobo-${i + 1}`, 'crop', p.x, p.y, { country: 'urhobo', length: 110, heading: (60 + i * 45 + 90) % 360, color: i % 2 ? '#6a9a3a' : '#8aa84a' }); }
  addShore('landing-urhobo', 'canoe_landing', U.x, U.y - 620, { name: 'the Urhobo landing', country: 'urhobo' }, LANDING_GAP);

  // Ijaw: fishers and salt makers (N1), on their island.
  homes.ijaw.push(addShore('fishing_village-ijaw-1', 'fishing_village', J.x - 150, J.y - 120, { name: 'a fishing village', country: 'ijaw' }, VILLAGE_GAP));
  homes.ijaw.push(addShore('fishing_village-ijaw-2', 'fishing_village', J.x + 200, J.y - 260, { name: 'a fishing and salt-making village', country: 'ijaw' }, VILLAGE_GAP));
  for (let i = 0; i < 3; i++) { const p = at(J, 120 + i * 60, 260); homes.ijaw.push(add(`compound-ijaw-${i + 1}`, 'compound', p.x, p.y, { country: 'ijaw', heading: (300 + i * 60) % 360 })); }
  addShore('landing-ijaw', 'canoe_landing', J.x + 400, J.y + 400, { name: 'the Ijaw landing', country: 'ijaw' }, LANDING_GAP);

  // Offshore: anchorages for the merchant ship (W12), off Warri and off the river mouth.
  add('anchorage-warri', 'anchorage', 2900, 2900, { name: 'the anchorage off Warri', country: 'warri', landing: 'landing-warri-west' });
  add('anchorage-river', 'anchorage', 5400, 2700, { name: 'the anchorage off the river mouth', country: 'benin', landing: 'landing-warri-east' });

  // Nok (D1): far older than this world; inhabitants of Benin can come upon it.
  add('heritage_site-nok', 'heritage_site', 10200, 6600, { name: 'an ancient site of the Nok culture', finds: 'pieces of fired-clay figures, made c. 1500 BCE to the last centuries BCE, far older than anyone here', reach: 'benin' });

  // Trees: the forest round Benin and the farms (on land only); palms on Warri and the Ijaw island.
  const land = buildTerrain(E, { x: 12000, y: 8000 });
  for (let i = 0, n = 0; i < 70; i++) { const p = at(B, rand() * 360, 1050 + rand() * 1200); const size = 1 + rand() * 0.8; if (land.coastDistance(p.x, p.y) >= 10) add(`tree-${++n}`, 'tree', p.x, p.y, { size }); }
  for (let i = 0; i < 18; i++) { const p = at(W, rand() * 360, 560 + rand() * 300); add(`palm-warri-${i + 1}`, 'palm', p.x, p.y, { size: 0.9 + rand() * 0.4 }); }
  for (let i = 0; i < 8; i++) { const p = at(J, rand() * 360, 300 + rand() * 200); add(`palm-ijaw-${i + 1}`, 'palm', p.x, p.y, { size: 0.9 + rand() * 0.4 }); }

  // The people: fictional, named in their own languages. Each kingdom has a royal house.
  const SHIRTS = { edo: ['#f5f0e6', '#c62828', '#e8d9c4'], itsekiri: ['#f5f0e6', '#1565c0', '#e8d9c4'], urhobo: ['#f5f0e6', '#6d4c41', '#c9a227'], ijaw: ['#f5f0e6', '#00838f', '#e8d9c4'] };
  const people = { benin: 64, warri: 30, urhobo: 16, ijaw: 12 };
  for (const p of PEOPLES) {
    const adults = [];
    const royalFamily = familyName(rand, p.culture);
    for (let i = 0; i < people[p.code]; i++) {
      const home = E.find((e) => e.id === homes[p.code][Math.floor(i / 3) % homes[p.code].length]);
      const sex = i % 2 ? 'male' : 'female';
      const royal = p.government === 'monarchy' && (i === 1 || i === 3);
      const e = { id: `person-${p.code}-${i + 1}`, kind: 'person', position: { x: r2(home.position.x + 6), y: r2(home.position.y - 6), z: 0 }, properties: { home: home.id, country: p.code, sex, name: nameFor(sex, rand, p.culture), family: royal ? royalFamily : familyName(rand, p.culture), age: Math.round(20 + rand() * 40), shirt: pick(SHIRTS[p.culture]), ...(royal ? { royal: true } : {}) } };
      E.push(e); adults.push(e);
    }
    for (let k = 0; k + 1 < adults.length && k < adults.length * 0.6; k += 2) { const a = adults[k]; const b = adults[k + 1]; a.properties.partner = b.id; b.properties.partner = a.id; b.properties.family = a.properties.family; b.properties.home = a.properties.home; b.position = { ...a.position }; }
    for (let k = 0; k < Math.floor(adults.length / 5); k++) {
      const mum = adults[k * 2]; const sex = rand() < 0.5 ? 'female' : 'male';
      add(`child-${p.code}-${k + 1}`, 'child', mum.position.x + 2, mum.position.y + 2, { home: mum.properties.home, country: p.code, sex, name: nameFor(sex, rand, p.culture), family: mum.properties.family, age: 4 + Math.round(rand() * 9), mother: mum.id, father: mum.properties.partner, shirt: pick(SHIRTS[p.culture]) });
    }
  }
  // A guard at each gate (B7: the gates were manned); fictional, of Benin.
  // A compound is known by the family who live in it (fictional families).
  for (const c of E.filter((e) => e.kind === 'compound')) {
    const who = E.find((e) => e.kind === 'person' && e.properties.home === c.id);
    c.properties.name = who ? `the ${who.properties.family} family compound` : 'a compound';
  }
  gates.forEach((g, i) => { const e = E.find((x) => x.id === g); add(`guard-benin-${i + 1}`, 'person', e.position.x, e.position.y, { country: 'benin', sex: 'male', name: nameFor('male', rand, 'edo'), family: familyName(rand, 'edo'), age: 22 + Math.round(rand() * 20), job: 'guard', work: g, home: homes.benin[i % 22], shirt: '#e8d9c4' }); });
  // Porters between the palace and Ughoton.
  for (let i = 0; i < 3; i++) add(`porter-benin-${i + 1}`, 'porter', B.x + 20 + i * 6, B.y - 30, { country: 'benin', name: nameFor('male', rand, 'edo'), from: 'palace-benin', to: 'landing-ughoton' });

  // Canoes on the water, each people's own, starting by its landings.
  const canoe = (id, country, x, y) => add(id, 'canoe', x, y, { country, color: pick(['#6d4c41', '#5d4037', '#795548']) });
  canoe('canoe-warri-1', 'warri', W.x + 1060, W.y + 50);
  canoe('canoe-warri-2', 'warri', W.x, W.y + 1070);
  canoe('canoe-warri-3', 'warri', W.x - 1060, W.y + 100);
  canoe('canoe-urhobo-1', 'urhobo', 6003, 4660);
  canoe('canoe-ijaw-1', 'ijaw', J.x + 470, J.y + 470);
  canoe('canoe-ijaw-2', 'ijaw', J.x + 520, J.y + 420);
  canoe('canoe-benin-1', 'benin', 6880, 4680);

  // The Portuguese merchant ship (W12), with its traders aboard (visitors),
  // and the fictional storyline (inspired by W10, W11): a prince of Warri
  // coming home from Lisbon with his wife. Both are invented people.
  add('carrack-1', 'carrack', 700, 3600, { name: 'a Portuguese merchant ship', color: '#5d4037', target: 'anchorage-warri' });
  for (let i = 0; i < 3; i++) add(`visitor-${i + 1}`, 'visitor', 700, 3600, { name: nameFor('male', rand, 'portuguese'), family: familyName(rand, 'portuguese'), role: 'merchant', inside: 'carrack-1' });
  add('person-warri-prince', 'person', 700, 3600, { name: 'Omagbitse', family: E.find((e) => e.id === 'person-warri-1').properties.family, sex: 'male', age: 26, country: 'warri', home: 'palace-warri', inside: 'carrack-1', storyline: 'return', label: 'fictional storyline', shirt: '#f5f0e6' });
  add('person-warri-wife', 'person', 700, 3600, { name: 'Leonor', family: 'Teixeira', sex: 'female', age: 22, country: 'warri', home: 'palace-warri', partner: 'person-warri-prince', inside: 'carrack-1', storyline: 'return', label: 'fictional storyline', shirt: '#1565c0' });
  E.find((e) => e.id === 'person-warri-prince').properties.partner = 'person-warri-wife';

  const rules = [
    { id: 'people-live', type: 'life', kind: 'person', child_kind: 'child', year_steps: 240, adult_age: 18, max_age: 70, meet_radius: 15, birth_chance: 0.015, home_kinds: ['compound', 'fishing_village', 'palace'], food_kinds: ['compound', 'fishing_village'], work_kinds: ['palace', 'brass_workshop', 'ivory_workshop', 'canoe_landing', 'crop', 'fishing_village', 'gate'], school_kinds: [], fun_kinds: ['canoe_landing', 'shrine'], progress: false, peaceful: true },
    { id: 'people-walk', type: 'travel', kind: 'person' },
    { id: 'children-walk', type: 'travel', kind: 'child' },
    { id: 'porters-carry', type: 'travel', kind: 'porter' },
    { id: 'canoes-paddle', type: 'travel', kind: 'canoe', roam: ['canoe_landing', 'anchorage'] },
    { id: 'ship-sails', type: 'travel', kind: 'carrack', roam: ['anchorage'] }
  ];
  if (E.length > SANDBOX_LIMITS.entities) throw new Error(`template has ${E.length} entities`);
  return validateSpec({ size: { x: 12000, y: 8000, z: 3000 }, seed: 1610, space_altitude: 2000, day_steps: 240, entities: E, rules });
}
