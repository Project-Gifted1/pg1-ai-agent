// PG1 Sandbox viewer: every kind of thing, modelled in code (no downloaded
// assets). Units are metres; a model faces +x and stands on y = 0.
//
//   buildModel(THREE, kind, props) -> {
//     body, glow, glass,                    merged geometries (see kit.js)
//     parts: [{ geo, pivot [x,y,z], role }] moving parts: wheels, rotors,
//                                            propellers, legs, arms, wings, flame
//     size: metres across (for the camera), cls, upright?
//   }
//
// Models are cached per kind and colours, so a hundred houses share a
// handful of geometries.

import { Kit } from './kit.js';

// The viewer's copy of the catalogue's classes (lib/sandbox/catalog.mjs).
export const KIND_CLASS = {
  person: 'person', child: 'person', astronaut: 'person', alien: 'person',
  dog: 'animal', cat: 'animal', rabbit: 'animal', fox: 'animal', deer: 'animal', horse: 'animal', cow: 'animal', bird: 'animal', fish: 'animal',
  grass: 'plant', flower: 'plant', bush: 'plant', tree: 'plant', pine: 'plant', palm: 'plant', crop: 'plant',
  police_station: 'building', prison: 'building', hotel: 'building', cinema: 'building', theatre: 'building', bar: 'building', stadium: 'building',
  beach: 'structure', amusement: 'structure', port: 'structure', monument: 'structure', island: 'structure', ferry: 'vehicle',
  terminal: 'building', barracks: 'building', army_truck: 'vehicle', patrol_boat: 'vehicle',
  house: 'building', cabin: 'building', apartment: 'building', tower: 'building', shop: 'building', cafe: 'building', school: 'building', hospital: 'building', factory: 'building', barn: 'building', hangar: 'building', station: 'building',
  road: 'structure', bridge: 'structure', runway: 'structure', launch_pad: 'structure', lake: 'structure', rock: 'structure', fence: 'structure', lamp: 'structure', fountain: 'structure',
  bike: 'vehicle', motorbike: 'vehicle', car: 'vehicle', taxi: 'vehicle', police_car: 'vehicle', bus: 'vehicle', truck: 'vehicle', tractor: 'vehicle', train: 'vehicle', boat: 'vehicle', ship: 'vehicle', plane: 'vehicle', small_plane: 'vehicle', jet: 'vehicle', helicopter: 'vehicle', drone: 'vehicle', hot_air_balloon: 'vehicle', rocket: 'vehicle', shuttle: 'vehicle',
  space_station: 'space', satellite: 'space', colony: 'space', star: 'celestial', planet: 'celestial', moon: 'celestial', asteroid: 'celestial',
  alien_world: 'celestial', alien_ship: 'vehicle'
};
export const FIXED_KINDS = new Set(['grass', 'flower', 'bush', 'tree', 'pine', 'palm', 'crop', 'house', 'cabin', 'apartment', 'tower', 'shop', 'cafe', 'school', 'hospital', 'factory', 'barn', 'hangar', 'station', 'police_station', 'prison', 'hotel', 'cinema', 'theatre', 'bar', 'stadium', 'beach', 'amusement', 'port', 'monument', 'terminal', 'barracks', 'road', 'bridge', 'runway', 'launch_pad', 'rock', 'fence', 'lamp', 'fountain']);
export const AIR_KINDS = new Set(['bird', 'plane', 'small_plane', 'jet', 'helicopter', 'drone', 'hot_air_balloon', 'rocket', 'shuttle', 'space_station', 'satellite', 'colony', 'star', 'planet', 'moon', 'asteroid', 'alien_world', 'alien_ship']);
// Homes whose insides the viewer furnishes (see furnitureFor).
export const HOME_KINDS = new Set(['house', 'cabin', 'apartment']);
// Where a meteorite struck (lib/sandbox/cosmos.mjs).
KIND_CLASS.crater = 'structure'; FIXED_KINDS.add('crater');

// "car_red" and "house-2" are a car and a house.
export function baseKind(kind) {
  const k = String(kind || '');
  if (KIND_CLASS[k]) return k;
  const b = k.replace(/[_-][a-z0-9]+$/, '');
  return KIND_CLASS[b] ? b : k;
}
export const classOf = (kind) => KIND_CLASS[baseKind(kind)] || 'thing';

const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a0522d'];
const HAIR = ['#2b1d14', '#4a3123', '#0f0f0f', '#a0522d', '#d6b370', '#6b4423'];
const hashOf = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
const pickBy = (seed, list) => list[seed % list.length];
const col = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : d);

function out(k, extra = {}) { return { ...k.build(), parts: [], ...extra }; }
function partOf(THREE, fill, pivot, role) {
  const k = new Kit(THREE);
  fill(k);
  return { geo: k.build(), pivot, role };
}

// --- people ---------------------------------------------------------------------------

function person(T, p, seed, { child = false, astronaut = false } = {}) {
  const s = child ? 0.7 : 1;
  const skin = pickBy(seed, SKIN); const hair = pickBy(seed >> 3, HAIR);
  const shirt = astronaut ? '#f4f4f4' : col(p.shirt, pickBy(seed >> 5, ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#ecf0f1']));
  const pants = astronaut ? '#e8e8e8' : pickBy(seed >> 7, ['#2c3e50', '#34495e', '#1f2a44', '#5d4037', '#212121']);
  const k = new Kit(T);
  k.box(0.26 * s, 0.6 * s, 0.42 * s, shirt, 0, 1.18 * s, 0);                 // torso
  k.box(0.27 * s, 0.14 * s, 0.43 * s, pants, 0, 0.86 * s, 0);                // belt line
  k.cyl(0.05 * s, 0.06 * s, 0.1 * s, 8, skin, 0, 1.52 * s, 0);               // neck
  if (astronaut) {
    k.sphere(0.2 * s, '#f4f4f4', 0, 1.7 * s, 0);
    k.sphere(0.15 * s, '#1b2a3a', 0.08 * s, 1.71 * s, 0, { sx: 0.8, sy: 0.75, layer: 'glass' });
    k.box(0.18 * s, 0.4 * s, 0.34 * s, '#d0d0d0', -0.2 * s, 1.2 * s, 0);    // pack
  } else {
    k.sphere(0.12 * s, skin, 0, 1.68 * s, 0, { sy: 1.1 });
    k.sphere(0.125 * s, hair, -0.02 * s, 1.73 * s, 0, { sy: 0.7, sx: 1.02 });
    k.box(0.02, 0.02 * s, 0.03 * s, '#111', 0.115 * s, 1.7 * s, 0.04 * s);  // eyes
    k.box(0.02, 0.02 * s, 0.03 * s, '#111', 0.115 * s, 1.7 * s, -0.04 * s);
  }
  const leg = (z) => partOf(T, (q) => { q.box(0.15 * s, 0.8 * s, 0.16 * s, pants, 0, -0.42 * s, 0); q.box(0.24 * s, 0.08 * s, 0.15 * s, astronaut ? '#bbbbbb' : '#1a1a1a', 0.04 * s, -0.84 * s, 0); }, [0, 0.88 * s, z], z > 0 ? 'legL' : 'legR');
  const arm = (z) => partOf(T, (q) => { q.box(0.11 * s, 0.56 * s, 0.11 * s, shirt, 0, -0.27 * s, 0); q.sphere(0.055 * s, astronaut ? '#dddddd' : skin, 0, -0.58 * s, 0); }, [0, 1.44 * s, z], z > 0 ? 'armL' : 'armR');
  return { ...k.build(), parts: [leg(0.1 * s), leg(-0.1 * s), arm(0.27 * s), arm(-0.27 * s)], size: 1.8 * s };
}

// --- animals --------------------------------------------------------------------------

function quadruped(T, o) {
  const k = new Kit(T);
  const { len, h, w, color, belly = color, head = color, ear = null, tail = null, legColor = color } = o;
  k.capsule(w / 2, len - w, color, 0, h, 0, { rz: Math.PI / 2 });
  k.box(len * 0.6, w * 0.4, w * 0.8, belly, 0, h - w * 0.35, 0);
  k.sphere(w * 0.55, head, len / 2 + w * 0.15, h + w * 0.45, 0, { sx: 1.25 });
  k.cone(w * 0.22, w * 0.5, 8, head, len / 2 + w * 0.75, h + w * 0.38, 0, { rz: -Math.PI / 2 });    // snout
  k.sphere(w * 0.08, '#111', len / 2 + w * 0.42, h + w * 0.6, w * 0.25);
  k.sphere(w * 0.08, '#111', len / 2 + w * 0.42, h + w * 0.6, -w * 0.25);
  if (ear === 'long') { k.box(w * 0.15, w * 1.1, w * 0.3, head, len / 2, h + w * 1.3, w * 0.18, { rz: 0.15 }); k.box(w * 0.15, w * 1.1, w * 0.3, head, len / 2, h + w * 1.3, -w * 0.18, { rz: 0.15 }); }
  else if (ear === 'antlers') { for (const z of [w * 0.25, -w * 0.25]) { k.cyl(0.03, 0.04, w * 1.4, 6, '#6d4c2f', len / 2 + w * 0.1, h + w * 1.5, z, { rx: z > 0 ? -0.35 : 0.35 }); k.cyl(0.02, 0.03, w * 0.6, 6, '#6d4c2f', len / 2 + w * 0.3, h + w * 1.6, z * 1.6, { rz: -0.8 }); } }
  else if (ear) { k.cone(w * 0.16, w * 0.35, 6, ear, len / 2 + w * 0.05, h + w * 0.95, w * 0.28); k.cone(w * 0.16, w * 0.35, 6, ear, len / 2 + w * 0.05, h + w * 0.95, -w * 0.28); }
  if (tail) k.cone(w * 0.2, len * 0.45, 8, tail, -len / 2 - len * 0.15, h + w * 0.1, 0, { rz: Math.PI / 2 + 0.5 });
  if (o.spots) for (let i = 0; i < 5; i++) k.sphere(w * 0.32, o.spots, (i - 2) * len * 0.18, h + w * 0.35, (i % 2 ? 1 : -1) * w * 0.33, { sy: 0.7, sz: 0.4 });
  const legs = [];
  for (const [x, z, role] of [[len * 0.36, w * 0.3, 'legL'], [len * 0.36, -w * 0.3, 'legR'], [-len * 0.36, w * 0.3, 'legR'], [-len * 0.36, -w * 0.3, 'legL']]) {
    legs.push(partOf(T, (q) => { q.cyl(w * 0.13, w * 0.1, h, 6, legColor, 0, -h / 2, 0); q.box(w * 0.24, h * 0.08, w * 0.22, '#2a1d14', w * 0.04, -h, 0); }, [x, h, z], role));
  }
  return { ...k.build(), parts: legs, size: len * 1.4 };
}

function bird(T, p, seed) {
  const k = new Kit(T);
  const c = col(p.color, pickBy(seed, ['#37474f', '#5d4037', '#eceff1', '#1565c0']));
  k.sphere(0.12, c, 0, 0, 0, { sx: 1.8 });
  k.sphere(0.08, c, 0.2, 0.05, 0);
  k.cone(0.03, 0.08, 6, '#f9a825', 0.3, 0.05, 0, { rz: -Math.PI / 2 });
  k.box(0.18, 0.02, 0.12, c, -0.25, 0.02, 0);
  const wing = (z) => partOf(T, (q) => q.box(0.18, 0.02, 0.38, c, 0, 0, z > 0 ? 0.19 : -0.19), [0, 0.03, z], z > 0 ? 'wingL' : 'wingR');
  return { ...k.build(), parts: [wing(0.05), wing(-0.05)], size: 0.6 };
}

// --- plants ---------------------------------------------------------------------------

function tree(T, p, seed) {
  const s = Math.max(0.4, Math.min(2.5, Number(p.size) || 1));
  const k = new Kit(T);
  k.cyl(0.25 * s, 0.4 * s, 4 * s, 7, '#6d4c2f', 0, 2 * s, 0, { jitter: 0.2 });
  const greens = ['#2e7d32', '#388e3c', '#43a047', '#558b2f', '#33691e'];
  const g = pickBy(seed, greens);
  k.ico(2.4 * s, 1, g, 0, 5 * s, 0, { jitter: 0.35 });
  k.ico(1.9 * s, 1, pickBy(seed >> 2, greens), 0.9 * s, 6.3 * s, 0.5 * s, { jitter: 0.35 });
  k.ico(1.7 * s, 1, pickBy(seed >> 4, greens), -0.8 * s, 6 * s, -0.6 * s, { jitter: 0.35 });
  k.ico(1.4 * s, 1, g, 0, 7.4 * s, 0, { jitter: 0.35 });
  return out(k, { size: 6 * s });
}
function pine(T, p, seed) {
  const s = Math.max(0.4, Math.min(2.5, Number(p.size) || 1));
  const k = new Kit(T);
  k.cyl(0.2 * s, 0.35 * s, 3 * s, 6, '#5d4037', 0, 1.5 * s, 0);
  const g = pickBy(seed, ['#1b5e20', '#2e5e3a', '#24492f', '#14532d']);
  for (let i = 0; i < 4; i++) k.cone((2.8 - i * 0.6) * s, 3.2 * s, 9, g, 0, (3 + i * 2) * s, 0, { jitter: 0.25, ry: i * 0.4 });
  return out(k, { size: 5 * s });
}
function palm(T, p) {
  const k = new Kit(T);
  for (let i = 0; i < 8; i++) k.cyl(0.22 - i * 0.012, 0.25 - i * 0.012, 1.1, 7, i % 2 ? '#8d6e63' : '#795548', i * i * 0.025, 0.55 + i * 1.05, 0, { rz: -i * 0.03 });
  for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; k.box(3.2, 0.06, 0.7, '#388e3c', 1.6 + Math.cos(a) * 1.5, 8.6, Math.sin(a) * 1.5, { ry: -a, rz: -0.45 }); }
  k.sphere(0.35, '#6d4c41', 1.6, 8.5, 0.2); k.sphere(0.3, '#6d4c41', 1.4, 8.4, -0.3);
  return out(k, { size: 8 });
}
function bush(T, p, seed) {
  const k = new Kit(T);
  const g = pickBy(seed, ['#2e7d32', '#4caf50', '#33691e']);
  k.ico(1, 1, g, 0, 0.7, 0, { jitter: 0.3, sy: 0.75 }); k.ico(0.7, 1, g, 0.7, 0.5, 0.3, { jitter: 0.3 }); k.ico(0.6, 1, g, -0.6, 0.45, -0.3, { jitter: 0.3 });
  return out(k, { size: 2 });
}
function flower(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#ff6b8b');
  for (let i = 0; i < 7; i++) {
    const a = i * 2.39; const r = 0.3 + (i % 3) * 0.25;
    k.cyl(0.02, 0.02, 0.5, 4, '#2e7d32', Math.cos(a) * r, 0.25, Math.sin(a) * r);
    k.sphere(0.12, c, Math.cos(a) * r, 0.52, Math.sin(a) * r, { sy: 0.5, seg: 8, rings: 5 });
    k.sphere(0.05, '#ffeb3b', Math.cos(a) * r, 0.56, Math.sin(a) * r, { seg: 6, rings: 4 });
  }
  return out(k, { size: 1.5 });
}
function grass(T) {
  const k = new Kit(T);
  for (let i = 0; i < 9; i++) { const a = i * 2.4; k.cone(0.08, 0.6 + (i % 3) * 0.2, 4, i % 2 ? '#7cb342' : '#558b2f', Math.cos(a) * 0.4, 0.35, Math.sin(a) * 0.4, { rz: Math.cos(a) * 0.3 }); }
  return out(k, { size: 1 });
}
function crop(T, p) {
  const len = Math.max(10, Math.min(400, Number(p.length) || 100));
  const k = new Kit(T);
  k.box(len, 0.3, 4, '#5d4037', 0, 0.15, 0);
  const c = col(p.color, '#6a9a3a');
  const n = Math.min(60, Math.round(len / 4));
  for (let i = 0; i < n; i++) k.cone(0.8, 1.4, 5, c, -len / 2 + (i + 0.5) * (len / n), 0.9, (i % 2 ? 0.8 : -0.8), { jitter: 0.25 });
  return out(k, { size: len });
}

// --- buildings ------------------------------------------------------------------------

function windowsRow(k, w, d, y, h, count, sides = 'all') {
  const glow = '#ffd98a';
  for (let i = 0; i < count; i++) {
    const t = -w / 2 + (i + 0.5) * (w / count);
    if (sides !== 'sides') { k.box(w / count * 0.5, h, 0.08, glow, t, y, d / 2 + 0.03, { layer: 'glow' }); k.box(w / count * 0.5, h, 0.08, glow, t, y, -d / 2 - 0.03, { layer: 'glow' }); }
  }
  const m = Math.max(1, Math.round(count * d / w));
  for (let i = 0; i < m; i++) {
    const t = -d / 2 + (i + 0.5) * (d / m);
    k.box(0.08, h, d / m * 0.5, glow, w / 2 + 0.03, y, t, { layer: 'glow' }); k.box(0.08, h, d / m * 0.5, glow, -w / 2 - 0.03, y, t, { layer: 'glow' });
  }
}

function house(T, p, seed, { cabin = false } = {}) {
  const floors = Math.max(1, Math.min(3, Math.round(Number(p.floors) || 1)));
  const wall = cabin ? '#8d6e63' : col(p.color, '#e8d9c4');
  const roof = cabin ? '#4e342e' : col(p.roof, '#8c3b2e');
  const W = cabin ? 8 : 11; const D = cabin ? 7 : 9; const H = 3.1 * floors;
  const k = new Kit(T);
  k.box(W + 0.6, 0.4, D + 0.6, '#9e9e9e', 0, 0.2, 0);                          // base
  k.box(W, H, D, wall, 0, 0.4 + H / 2, 0, { jitter: cabin ? 0.15 : 0.03 });
  k.prism([[-D / 2 - 0.6, 0], [D / 2 + 0.6, 0], [0, D * 0.45]], W + 0.8, roof, 0, 0.4 + H, 0, { ry: Math.PI / 2 });
  k.box(1.2, 4, 1.2, '#795548', W * 0.25, 0.4 + H + 2, D * 0.18);              // chimney
  k.box(0.1, 2.1, 1.1, '#5d4037', W / 2 + 0.05, 1.45, 0);                      // door
  k.box(0.6, 0.2, 1.6, '#9e9e9e', W / 2 + 0.4, 0.3, 0);                        // step
  for (let f = 0; f < floors; f++) windowsRow(k, W, D, 0.4 + 1.7 + f * 3.1, 1.1, 3);
  // A small garden: a hedge and a path.
  k.box(0.8, 0.9, D + 4, '#2e7d32', W / 2 + 4, 0.45, 0, { jitter: 0.3 });
  k.box(4, 0.05, 1.2, '#bdbdbd', W / 2 + 2, 0.03, 0);
  return out(k, { size: Math.max(W, D) + 4 });
}

function facadeBlock(k, W, D, floors, color, { floorH = 3.2, glass = false } = {}) {
  const H = floors * floorH;
  k.box(W, H, D, color, 0, H / 2, 0, { layer: glass ? 'glass' : 'body' });
  for (let f = 0; f < floors; f++) {
    const y = f * floorH + floorH * 0.55;
    if (glass) { if (f % 2 === 0) windowsRow(k, W, D, y, floorH * 0.55, Math.max(3, Math.round(W / 3))); }
    else windowsRow(k, W, D, y, floorH * 0.45, Math.max(3, Math.round(W / 3.5)));
    if (!glass) k.box(W + 0.15, 0.18, D + 0.15, '#d7ccc8', 0, f * floorH, 0);
  }
  return H;
}

function apartment(T, p) {
  const floors = Math.max(3, Math.min(14, Math.round(Number(p.floors) || 7)));
  const k = new Kit(T);
  const H = facadeBlock(k, 22, 16, floors, col(p.color, '#d9c7b0'));
  k.box(23, 0.8, 17, '#757575', 0, H + 0.4, 0);
  k.box(4, 2.5, 4, '#9e9e9e', 4, H + 2, 3);
  for (let f = 1; f < floors; f++) k.box(1.6, 0.15, 12, '#bdbdbd', 11.8, f * 3.2, 0);   // balconies
  return out(k, { size: 26 });
}

function tower(T, p) {
  const floors = Math.max(6, Math.min(60, Math.round(Number(p.floors) || 30)));
  const k = new Kit(T);
  if (p.lattice) {
    const H = floors * 6;
    for (const [x, z] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) k.box(0.5, H, 0.5, '#c0392b', x, H / 2, z);
    for (let y = 4; y < H; y += 6) { k.box(6.5, 0.3, 0.3, '#c0392b', 0, y, 3); k.box(6.5, 0.3, 0.3, '#c0392b', 0, y, -3); k.box(0.3, 0.3, 6.5, '#c0392b', 3, y, 0); k.box(0.3, 0.3, 6.5, '#c0392b', -3, y, 0); }
    k.box(8, 1, 3, '#b71c1c', -6, H * 0.8, 0);
    k.sphere(0.6, '#ff5252', 0, H + 1, 0, { layer: 'glow' });
    return out(k, { size: 12 });
  }
  const c = col(p.color, '#9fb7c9');
  const H = facadeBlock(k, 26, 26, floors, c, { glass: true, floorH: 3.6 });
  for (const [x, z] of [[-13, -13], [13, -13], [-13, 13], [13, 13]]) k.box(1, H, 1, '#cfd8dc', x, H / 2, z);
  k.box(20, 4, 20, '#b0bec5', 0, H + 2, 0);
  k.box(10, 3, 10, '#90a4ae', 0, H + 5.5, 0);
  k.cyl(0.3, 0.4, 18, 6, '#eceff1', 0, H + 16, 0);
  k.sphere(0.6, '#ff5252', 0, H + 25, 0, { layer: 'glow' });
  k.box(30, 0.6, 30, '#9e9e9e', 0, 0.3, 0);
  return out(k, { size: 32 });
}

function shop(T, p, { cafe = false } = {}) {
  const k = new Kit(T);
  const c = col(p.color, '#f2e6b3');
  k.box(16, 6, 12, c, 0, 3, 0);
  k.box(0.1, 3, 12, '#ffd98a', 8.05, 2, 0, { layer: 'glow' });               // shop window
  k.box(0.12, 2.6, 1.6, '#4e342e', 8.07, 1.3, 4);
  k.box(3, 0.25, 13, col(p.awning, '#c0392b'), 9.4, 4.4, 0, { rz: -0.35 });
  k.box(0.3, 1.2, 8, cafe ? '#6d4c41' : '#263238', 8.2, 5.4, 0);                // sign
  k.box(16.5, 0.5, 12.5, '#8d6e63', 0, 6.25, 0);
  if (cafe) for (const z of [-3.5, 0, 3.5]) { k.cyl(0.6, 0.6, 0.06, 12, '#fafafa', 12, 1, z); k.cyl(0.05, 0.05, 1, 6, '#424242', 12, 0.5, z); k.cone(1.5, 1, 10, '#e53935', 12, 2.6, z); k.cyl(0.04, 0.04, 2.4, 5, '#bdbdbd', 12, 1.3, z); }
  return out(k, { size: 18 });
}

function school(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#d9b38c');
  facadeBlock(k, 40, 14, 2, c, { floorH: 4 });
  k.box(14, 8, 26, c, -13, 4, 20);
  windowsRow(k, 14, 26, 5, 1.6, 3, 'sides');
  k.box(42, 0.6, 15, '#6d4c41', 0, 8.3, 0);
  k.cyl(0.12, 0.12, 14, 6, '#eceff1', 24, 7, -8);
  k.box(0.05, 1.6, 2.6, '#1e88e5', 24, 13, -6.7);
  k.box(30, 0.05, 20, '#c62828', 8, 0.03, 22);                                  // sports court
  return out(k, { size: 46 });
}

function hospital(T, p) {
  const k = new Kit(T);
  const H = facadeBlock(k, 34, 22, 5, col(p.color, '#f2f2f2'));
  k.box(10, 2.5, 2.5, '#e53935', 0, H + 2, 0); k.box(2.5, 2.5, 10, '#e53935', 0, H + 2, 0);
  k.box(0.2, 6, 2, '#e53935', 17.1, H - 4, 0); k.box(0.2, 2, 6, '#e53935', 17.1, H - 4, 0);
  k.cyl(7, 7, 0.4, 24, '#455a64', -6, H + 0.2, 0);
  k.box(4, 0.1, 0.8, '#fafafa', -6, H + 0.45, 0); k.box(0.8, 0.1, 4, '#fafafa', -7.5, H + 0.45, 0); k.box(0.8, 0.1, 4, '#fafafa', -4.5, H + 0.45, 0);
  k.box(6, 4, 8, '#e0e0e0', 19, 2, 0); k.box(0.1, 2.5, 6, '#ffd98a', 22.05, 1.5, 0, { layer: 'glow' });
  return out(k, { size: 40 });
}

function station(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#c9b8a4');
  k.box(50, 7, 18, c, 0, 3.5, 0);
  windowsRow(k, 50, 18, 3.5, 2.5, 10);
  k.cyl(9.5, 9.5, 52, 20, '#78909c', 0, 7, 0, { rz: Math.PI / 2, sz: 0.5, sx: 1 });
  k.box(4, 9, 4, c, 26, 4.5, -7);
  k.cyl(1.6, 1.6, 0.3, 16, '#fafafa', 28.1, 7, -7, { rz: Math.PI / 2 });       // clock
  k.box(60, 0.3, 6, '#9e9e9e', 0, 1, 14);                                       // platform
  return out(k, { size: 60 });
}

function factory(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#9a8f86');
  k.box(40, 10, 26, c, 0, 5, 0);
  for (let i = 0; i < 4; i++) k.prism([[-6.5, 0], [6.5, 0], [-6.5, 4]], 26, '#78909c', -15 + i * 10, 10, 0, { ry: Math.PI / 2 });
  windowsRow(k, 40, 26, 6, 1.4, 8);
  k.cyl(1.5, 2, 26, 12, '#8d6e63', 14, 13, 8); k.cyl(1.2, 1.6, 22, 12, '#8d6e63', 18, 11, 8);
  k.box(0.1, 6, 8, '#455a64', 20.05, 3, -4);
  return out(k, { size: 44, smoke: [[14, 26.5, 8], [18, 22.5, 8]] });
}

function barn(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#9b2d20');
  k.box(18, 8, 12, c, 0, 4, 0, { jitter: 0.08 });
  k.prism([[-6.5, 0], [6.5, 0], [4.5, 3], [0, 5], [-4.5, 3]], 18.6, '#4e342e', 0, 8, 0, { ry: Math.PI / 2 });
  k.box(0.2, 5, 5, '#fafafa', 9.05, 2.6, 0); k.box(0.22, 4.6, 0.3, '#fafafa', 9.07, 2.6, 0, { rx: 0.8 }); k.box(0.22, 4.6, 0.3, '#fafafa', 9.07, 2.6, 0, { rx: -0.8 });
  k.cyl(2.2, 2.2, 12, 14, '#b0bec5', -6, 6, -9); k.sphere(2.2, '#90a4ae', -6, 12, -9, { sy: 0.6 });
  return out(k, { size: 22 });
}

function hangar(T, p) {
  const k = new Kit(T);
  k.cyl(14, 14, 40, 24, col(p.color, '#b0b8c0'), 0, 0, 0, { rx: Math.PI / 2, open: false });
  k.box(30, 0.3, 40, '#9e9e9e', 0, 0.15, 0);
  k.box(0.2, 11, 20, '#455a64', 14.1, 5.5, 0);
  return out(k, { size: 42 });
}

// --- structures -----------------------------------------------------------------------

function road(T, p, { runway = false, bridge = false } = {}) {
  const len = Math.max(4, Math.min(4000, Number(p.length) || 100));
  const w = Math.max(2, Math.min(120, Number(p.width) || (runway ? 45 : 12)));
  const k = new Kit(T);
  if (bridge) {
    k.box(len, 0.5, w, '#8d6e63', 0, 1.2, 0, { jitter: 0.2 });
    for (let x = -len / 2 + 2; x < len / 2; x += 8) for (const z of [-w / 2 + 0.3, w / 2 - 0.3]) { k.cyl(0.25, 0.25, 3, 6, '#5d4037', x, 0, z); k.box(0.15, 1, 0.15, '#5d4037', x, 1.9, z); }
    k.box(len, 0.12, 0.15, '#6d4c41', 0, 2.3, w / 2 - 0.3); k.box(len, 0.12, 0.15, '#6d4c41', 0, 2.3, -w / 2 + 0.3);
    return out(k, { size: len });
  }
  k.box(len, 0.12, w, runway ? '#37393d' : '#3c3f44', 0, 0.06, 0);
  k.box(len, 0.1, 1.2, '#9e9e9e', 0, 0.08, w / 2 + 0.6); k.box(len, 0.1, 1.2, '#9e9e9e', 0, 0.08, -w / 2 - 0.6);   // kerbs / shoulders
  const dash = runway ? 30 : 6; const gap = runway ? 20 : 6;
  for (let x = -len / 2 + gap; x < len / 2 - dash; x += dash + gap) k.box(dash, 0.02, runway ? 1 : 0.25, '#f5f5f5', x + dash / 2, 0.13, 0);
  if (runway) {
    for (const end of [-1, 1]) for (let i = -4; i <= 4; i++) if (i) k.box(20, 0.02, 1.6, '#f5f5f5', end * (len / 2 - 20), 0.13, i * 4.2);
    for (let x = -len / 2; x <= len / 2; x += 40) { k.sphere(0.35, '#ffd54f', x, 0.3, w / 2 + 1.5, { layer: 'glow', seg: 6, rings: 4 }); k.sphere(0.35, '#ffd54f', x, 0.3, -w / 2 - 1.5, { layer: 'glow', seg: 6, rings: 4 }); }
  } else {
    for (let x = -len / 2 + 12; x < len / 2; x += 40) k.box(0.1, 0.02, w * 0.8, '#f5f5f5', x, 0.13, 0);
  }
  return out(k, { size: len, flat: true });
}

function launchPad(T) {
  const k = new Kit(T);
  k.cyl(30, 32, 1.5, 32, '#9e9e9e', 0, 0.75, 0);
  k.box(14, 0.4, 40, '#424242', 0, 1.6, 0);
  k.box(6, 6, 6, '#757575', 0, 3, 0);
  for (const [x, z] of [[-24, 0], [24, 0], [0, 24], [0, -24]]) { k.cyl(1, 1, 18, 8, '#bdbdbd', x, 9, z); k.sphere(0.8, '#fff59d', x, 18.5, z, { layer: 'glow' }); }
  return out(k, { size: 64 });
}

function rock(T, p, seed) {
  const s = Math.max(0.3, Math.min(20, Number(p.size) || 2));
  const k = new Kit(T);
  k.add(new T.DodecahedronGeometry(s, 0), pickBy(seed, ['#757575', '#8d8d8d', '#6d6d6d']), 0, s * 0.5, 0, { sy: 0.7, ry: seed % 6, jitter: 0.3 });
  k.add(new T.DodecahedronGeometry(s * 0.5, 0), '#9e9e9e', s * 0.8, s * 0.25, s * 0.3, { jitter: 0.3 });
  return out(k, { size: s * 2.5 });
}
function fence(T, p) {
  const len = Math.max(2, Math.min(500, Number(p.length) || 20));
  const k = new Kit(T);
  for (let x = -len / 2; x <= len / 2; x += 2.5) k.box(0.15, 1.3, 0.15, '#8d6e63', x, 0.65, 0);
  k.box(len, 0.12, 0.08, '#a1887f', 0, 1.05, 0); k.box(len, 0.12, 0.08, '#a1887f', 0, 0.55, 0);
  return out(k, { size: len });
}
function lamp(T) {
  const k = new Kit(T);
  k.cyl(0.1, 0.15, 7, 6, '#37474f', 0, 3.5, 0);
  k.box(1.6, 0.12, 0.12, '#37474f', 0.7, 7, 0);
  k.box(0.7, 0.25, 0.45, '#263238', 1.4, 6.9, 0);
  k.box(0.6, 0.06, 0.35, '#fff3c4', 1.4, 6.75, 0, { layer: 'glow' });
  return out(k, { size: 2, lamp: [1.4, 6.6, 0] });
}
function fountain(T) {
  const k = new Kit(T);
  k.cyl(7, 7.5, 1, 32, '#bdbdbd', 0, 0.5, 0);
  k.cyl(6.3, 6.3, 0.2, 32, '#4fc3f7', 0, 0.95, 0, { layer: 'glass' });
  k.cyl(0.6, 0.9, 3, 12, '#9e9e9e', 0, 2, 0);
  k.cyl(2.2, 1.6, 0.4, 20, '#bdbdbd', 0, 3.5, 0);
  k.cone(0.5, 2.2, 10, '#b3e5fc', 0, 4.8, 0, { layer: 'glass' });
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; k.cone(0.15, 1.2, 6, '#b3e5fc', Math.cos(a) * 1.7, 4, Math.sin(a) * 1.7, { rz: Math.cos(a) * 0.6, rx: -Math.sin(a) * 0.6, layer: 'glass' }); }
  return out(k, { size: 16 });
}

// --- vehicles -------------------------------------------------------------------------

function wheelPair(T, x, y, z, r, w, color = '#1a1a1a') {
  return partOf(T, (q) => { for (const s of [1, -1]) { q.cyl(r, r, w, 14, color, 0, 0, s * z, { rx: Math.PI / 2 }); q.cyl(r * 0.55, r * 0.55, w + 0.02, 10, '#bdbdbd', 0, 0, s * z, { rx: Math.PI / 2 }); } }, [x, y, 0], 'wheel');
}

function car(T, p, seed, variant = 'car') {
  const k = new Kit(T);
  const paint = variant === 'taxi' ? '#f6c90e' : variant === 'police' ? '#f5f5f5' : col(p.color, pickBy(seed, ['#c0392b', '#2c3e50', '#ecf0f1', '#2980b9', '#16a085']));
  k.box(4.4, 0.7, 1.85, paint, 0, 0.62, 0);
  k.box(4.2, 0.3, 1.8, '#222', 0, 0.35, 0);
  k.box(2.3, 0.62, 1.66, paint, -0.25, 1.28, 0);
  k.box(2.1, 0.5, 1.7, '#22313f', -0.25, 1.3, 0, { layer: 'glass' });
  k.box(0.05, 0.5, 1.5, '#22313f', 0.92, 1.25, 0, { layer: 'glass', rz: -0.6 });
  k.box(0.1, 0.18, 0.4, '#fff8e1', 2.2, 0.75, 0.6, { layer: 'glow' }); k.box(0.1, 0.18, 0.4, '#fff8e1', 2.2, 0.75, -0.6, { layer: 'glow' });
  k.box(0.1, 0.16, 0.4, '#ff1744', -2.2, 0.8, 0.62, { layer: 'glow' }); k.box(0.1, 0.16, 0.4, '#ff1744', -2.2, 0.8, -0.62, { layer: 'glow' });
  k.box(0.3, 0.12, 0.08, '#111', 0.6, 1.1, 0.95); k.box(0.3, 0.12, 0.08, '#111', 0.6, 1.1, -0.95);   // mirrors
  if (variant === 'taxi') { k.box(0.8, 0.28, 0.35, '#212121', -0.25, 1.73, 0); k.box(0.7, 0.2, 0.37, '#fff59d', -0.25, 1.74, 0, { layer: 'glow' }); k.box(4.42, 0.1, 1.87, '#212121', 0, 0.85, 0); }
  if (variant === 'police') { k.box(4.42, 0.3, 1.87, '#1a237e', 0, 0.7, 0); k.box(0.4, 0.18, 1.2, '#212121', -0.25, 1.68, 0); k.box(0.38, 0.16, 0.5, '#ff1744', -0.25, 1.7, 0.3, { layer: 'glow' }); k.box(0.38, 0.16, 0.5, '#2979ff', -0.25, 1.7, -0.3, { layer: 'glow' }); }
  return { ...k.build(), parts: [wheelPair(T, 1.35, 0.36, 0.86, 0.36, 0.26), wheelPair(T, -1.35, 0.36, 0.86, 0.36, 0.26)], size: 5 };
}

function bus(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#f1c40f');
  k.box(12, 2.6, 2.55, c, 0, 1.75, 0);
  k.box(11.6, 0.9, 2.6, '#22313f', -0.2, 2.25, 0, { layer: 'glass' });
  k.box(0.1, 1.4, 2.3, '#22313f', 6.02, 2.1, 0, { layer: 'glass' });
  k.box(12.05, 0.25, 2.6, '#37474f', 0, 0.55, 0);
  k.box(0.1, 0.4, 1.6, '#263238', 6.03, 3.05, 0); k.box(0.1, 0.25, 1.4, '#ff9800', 6.06, 3.05, 0, { layer: 'glow' });
  k.box(0.08, 0.2, 0.4, '#fff8e1', 6.03, 0.8, 0.9, { layer: 'glow' }); k.box(0.08, 0.2, 0.4, '#fff8e1', 6.03, 0.8, -0.9, { layer: 'glow' });
  for (let i = 0; i < 6; i++) k.box(1.4, 0.75, 0.05, '#ffe082', -4.5 + i * 1.8, 2.25, 1.3, { layer: 'glow' });
  return { ...k.build(), parts: [wheelPair(T, 4, 0.5, 1.15, 0.5, 0.35), wheelPair(T, -3.6, 0.5, 1.15, 0.5, 0.35)], size: 13 };
}
function truck(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#ecf0f1');
  k.box(2.4, 2.4, 2.4, '#c62828', 3.3, 1.7, 0);
  k.box(0.1, 1, 2.1, '#22313f', 4.52, 2.2, 0, { layer: 'glass' });
  k.box(6.4, 3, 2.5, c, -1.3, 2.1, 0);
  k.box(9, 0.35, 2.3, '#263238', 0.3, 0.6, 0);
  k.box(0.08, 0.2, 0.4, '#fff8e1', 4.53, 1, 0.9, { layer: 'glow' }); k.box(0.08, 0.2, 0.4, '#fff8e1', 4.53, 1, -0.9, { layer: 'glow' });
  return { ...k.build(), parts: [wheelPair(T, 3.2, 0.5, 1.1, 0.5, 0.35), wheelPair(T, -2.8, 0.5, 1.1, 0.5, 0.35)], size: 10 };
}
function tractor(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#2e7d32');
  k.box(2.4, 1, 1.2, c, 0.5, 1.3, 0);
  k.box(1.4, 1.6, 1.4, c, -0.8, 2, 0);
  k.box(1.3, 1.1, 1.3, '#22313f', -0.8, 2.4, 0, { layer: 'glass' });
  k.cyl(0.08, 0.08, 1.2, 6, '#212121', 1.2, 2.2, 0.3);
  return { ...k.build(), parts: [wheelPair(T, 1.2, 0.45, 0.6, 0.45, 0.3), wheelPair(T, -0.9, 0.85, 0.75, 0.85, 0.5)], size: 4 };
}

function bike(T, p, seed, { motor = false } = {}) {
  const k = new Kit(T);
  const c = col(p.color, pickBy(seed, ['#c0392b', '#2980b9', '#27ae60', '#212121']));
  if (motor) {
    k.box(1.1, 0.45, 0.4, c, 0.05, 0.75, 0);
    k.box(0.7, 0.18, 0.32, '#212121', -0.4, 0.98, 0);
    k.box(0.5, 0.4, 0.35, '#616161', 0, 0.45, 0);
    k.cyl(0.05, 0.05, 0.75, 6, '#9e9e9e', 0.65, 0.75, 0, { rz: -0.4 });
    k.box(0.08, 0.06, 0.7, '#212121', 0.78, 1.12, 0);
    k.box(0.06, 0.12, 0.15, '#fff8e1', 0.85, 0.95, 0, { layer: 'glow' });
  } else {
    k.cyl(0.03, 0.03, 0.9, 6, c, 0.15, 0.62, 0, { rz: 1.0 });
    k.cyl(0.03, 0.03, 0.75, 6, c, -0.18, 0.6, 0, { rz: -0.45 });
    k.cyl(0.03, 0.03, 0.8, 6, c, 0.05, 0.85, 0, { rz: Math.PI / 2 });
    k.box(0.25, 0.06, 0.12, '#212121', -0.33, 0.96, 0);
    k.cyl(0.025, 0.025, 0.5, 6, '#9e9e9e', 0.5, 0.85, 0, { rz: -0.3 });
    k.box(0.05, 0.04, 0.55, '#212121', 0.55, 1.08, 0);
  }
  const r = motor ? 0.32 : 0.34;
  const wheel = (x) => partOf(T, (q) => { q.torus(r, motor ? 0.08 : 0.03, '#1a1a1a', 0, 0, 0, { tseg: 18 }); q.cyl(0.04, 0.04, 0.06, 6, '#bdbdbd', 0, 0, 0, { rx: Math.PI / 2 }); if (!motor) for (let i = 0; i < 4; i++) q.box(0.01, r * 2, 0.01, '#bdbdbd', 0, 0, 0, { rz: i * Math.PI / 4 }); }, [x, r, 0], 'wheel');
  return { ...k.build(), parts: [wheel(motor ? 0.7 : 0.55), wheel(motor ? -0.7 : -0.5)], size: 2, seat: [motor ? -0.3 : -0.33, motor ? 1.0 : 0.98, 0] };
}

function train(T) {
  const k = new Kit(T);
  for (let i = 0; i < 4; i++) {
    const x = -i * 22;
    k.box(20, 3.6, 3, i ? '#eceff1' : '#c62828', x, 2.6, 0);
    k.box(19, 0.9, 3.05, '#22313f', x, 3, 0, { layer: 'glass' });
    k.box(20, 0.5, 2.8, '#37474f', x, 0.6, 0);
  }
  k.box(1.5, 2, 3, '#c62828', 10.5, 2, 0, { rz: 0.4 });
  return out(k, { size: 90 });
}

function boat(T, p, { ship = false } = {}) {
  const k = new Kit(T);
  const c = col(p.color, ship ? '#2c3e50' : '#ffffff');
  const L = ship ? 60 : 7; const W = ship ? 11 : 2.6; const H = ship ? 7 : 1.2;
  k.prism([[-L / 2, H], [L / 2 + L * 0.12, H], [L / 2, 0], [-L / 2 + L * 0.05, 0]], W, c, 0, -H * 0.35, 0);
  k.box(L * 1.05, H * 0.08, W * 1.02, '#c62828', 0, -H * 0.3, 0);
  k.box(L, 0.15, W * 0.94, '#d7ccc8', 0, H * 0.66, 0);
  if (ship) {
    k.box(16, 8, 9, '#fafafa', -14, H * 0.66 + 4, 0);
    windowsRow(k, 16, 9, H * 0.66 + 6, 1.2, 6);
    k.box(10, 3.5, 8, '#fafafa', -14, H * 0.66 + 9.7, 0);
    k.cyl(1.8, 2.2, 7, 12, '#c62828', -22, H * 0.66 + 11, 0);
    for (let i = 0; i < 4; i++) k.box(7, 4, 8, ['#e65100', '#1565c0', '#2e7d32', '#f9a825'][i], 4 + i * 7.5, H * 0.66 + 2, 0);
  } else {
    k.box(2.2, 1.2, 1.8, '#fafafa', -0.6, H * 0.66 + 0.6, 0);
    k.box(0.08, 0.7, 1.6, '#22313f', 0.52, H * 0.66 + 0.9, 0, { layer: 'glass', rz: -0.5 });
    k.cyl(0.04, 0.04, 2.5, 5, '#bdbdbd', -1.2, H * 0.66 + 1.8, 0);
  }
  return out(k, { size: L, wake: true });
}

function plane(T, p, { small = false, jet = false } = {}) {
  const k = new Kit(T);
  const c = col(p.color, '#ffffff'); const liv = col(p.livery, small ? '#1565c0' : '#2e86c1');
  if (small) {
    k.capsule(0.7, 6, c, 0, 1.4, 0, { rz: Math.PI / 2 });
    k.box(1.6, 0.12, 11, c, 0.4, 2.2, 0);
    k.box(1.4, 0.7, 0.9, '#22313f', 1.4, 1.95, 0, { layer: 'glass' });
    k.box(1.2, 1.6, 0.12, liv, -3.6, 2.4, 0);
    k.box(1, 0.1, 3.4, c, -3.7, 1.6, 0);
    k.box(7, 0.15, 1.42, liv, 0, 1.4, 0);
    k.cyl(0.05, 0.05, 1.1, 5, '#424242', 0.8, 0.55, 0.9); k.cyl(0.05, 0.05, 1.1, 5, '#424242', 0.8, 0.55, -0.9);
    const prop = partOf(T, (q) => { q.box(0.06, 2.2, 0.18, '#212121', 0, 0, 0); q.cone(0.2, 0.4, 8, liv, 0.15, 0, 0, { rz: -Math.PI / 2 }); }, [3.9, 1.4, 0], 'propX');
    return { ...k.build(), parts: [prop, wheelPair(T, 0.8, 0.25, 0.9, 0.25, 0.12)], size: 11 };
  }
  if (jet) {
    k.capsule(0.8, 12, '#78909c', 0, 1.8, 0, { rz: Math.PI / 2 });
    k.cone(0.8, 3, 12, '#607d8b', 8.4, 1.8, 0, { rz: -Math.PI / 2 });
    k.prism([[4, 0], [-5, 4.8], [-6, 4.8], [-5, 0]], 0.2, '#78909c', 0, 1.7, 0, { rx: Math.PI / 2 });
    k.prism([[4, 0], [-5, 4.8], [-6, 4.8], [-5, 0]], 0.2, '#78909c', 0, 1.7, 0, { rx: -Math.PI / 2 });
    k.box(2, 2.4, 0.15, '#607d8b', -5.5, 3.2, 0, { rz: 0.4 });
    k.box(1.6, 0.6, 0.9, '#263238', 4.2, 2.55, 0, { layer: 'glass' });
    k.cone(0.55, 1.2, 10, '#ff9100', -7.2, 1.8, 0, { rz: Math.PI / 2, layer: 'glow' });
    return out(k, { size: 15 });
  }
  // A twin-engine airliner, about 38 m long.
  k.capsule(2, 30, c, 0, 4, 0, { rz: Math.PI / 2 });
  k.cone(2, 6, 16, c, -18, 4.6, 0, { rz: Math.PI / 2, sy: 1 });
  k.box(30, 0.6, 4.05, liv, 0, 3.2, 0);
  for (let i = 0; i < 22; i++) for (const z of [2.0, -2.0]) k.box(0.35, 0.45, 0.06, '#ffe9a8', -12 + i * 1.15, 4.8, z, { layer: 'glow' });
  k.box(1.6, 0.8, 3.2, '#22313f', 16.2, 5, 0, { layer: 'glass', rz: -0.45 });
  for (const s of [1, -1]) {
    k.prism([[5, 0], [-2, 17], [-5, 17], [-4, 0]], 0.5, c, 1, 3.4, 0, { rx: s * Math.PI / 2 });
    k.cyl(1.1, 1.1, 4.4, 14, '#cfd8dc', 3.5, 2.2, s * 6.5, { rz: Math.PI / 2 });
    k.cyl(0.8, 0.8, 0.1, 14, '#37474f', 5.75, 2.2, s * 6.5, { rz: Math.PI / 2 });
    k.prism([[1, 0], [-3, 6], [-5, 6], [-4, 0]], 0.35, c, -14, 5, 0, { rx: s * Math.PI / 2 });
    k.sphere(0.25, s > 0 ? '#00e676' : '#ff1744', -3, 3.4, s * 17.5, { layer: 'glow', seg: 6, rings: 4 });
  }
  k.prism([[0, 0], [-6, 8], [-9, 8], [-7, 0]], 0.4, liv, -12, 5.5, 0);
  return { ...k.build(), parts: [wheelPair(T, 12, 0.6, 0.01, 0.55, 0.4), wheelPair(T, -1, 0.6, 2.5, 0.6, 0.5)], size: 38 };
}

function helicopter(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#c0392b');
  k.sphere(1.6, c, 0, 2.3, 0, { sx: 1.6, sy: 1, sz: 1 });
  k.sphere(1.25, '#22313f', 1.05, 2.5, 0, { sx: 1.1, sy: 0.8, sz: 0.95, layer: 'glass' });
  k.cyl(0.35, 0.18, 6.5, 8, c, -4.5, 2.6, 0, { rz: Math.PI / 2 + 0.06 });
  k.box(1.2, 1.6, 0.15, c, -7.6, 3.4, 0);
  for (const s of [1, -1]) { k.box(4.2, 0.12, 0.12, '#424242', 0, 0.35, s * 1.1); k.box(0.12, 0.8, 0.12, '#424242', 0.8, 0.75, s * 1.0); k.box(0.12, 0.8, 0.12, '#424242', -0.8, 0.75, s * 1.0); }
  k.cyl(0.18, 0.18, 0.6, 8, '#424242', 0, 4.0, 0);
  const rotor = partOf(T, (q) => { q.box(11, 0.06, 0.4, '#212121', 0, 0, 0); q.box(0.4, 0.06, 11, '#212121', 0, 0, 0); }, [0, 4.35, 0], 'rotorY');
  const tail = partOf(T, (q) => q.box(0.06, 1.8, 0.2, '#212121', 0, 0, 0), [-7.6, 3.6, 0.2], 'rotorZ');
  return { ...k.build(), parts: [rotor, tail], size: 12 };
}

function drone(T) {
  const k = new Kit(T);
  k.box(0.35, 0.12, 0.35, '#263238', 0, 0, 0);
  k.box(1.1, 0.05, 0.06, '#37474f', 0, 0, 0, { ry: Math.PI / 4 }); k.box(1.1, 0.05, 0.06, '#37474f', 0, 0, 0, { ry: -Math.PI / 4 });
  k.sphere(0.04, '#00e676', 0.2, 0, 0, { layer: 'glow', seg: 6, rings: 4 });
  const parts = [[0.39, 0.39], [0.39, -0.39], [-0.39, 0.39], [-0.39, -0.39]].map(([x, z]) => partOf(T, (q) => q.box(0.42, 0.01, 0.05, '#b0bec5', 0, 0, 0), [x, 0.06, z], 'rotorY'));
  return { ...k.build(), parts, size: 1.2 };
}

function balloon(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#e67e22');
  for (let i = 0; i < 12; i++) k.add(new T.SphereGeometry(9, 4, 14, (i / 12) * Math.PI * 2, Math.PI * 2 / 12), i % 2 ? c : '#fdd835', 0, 16, 0, { sy: 1.2 });
  k.cone(4, 5, 12, c, 0, 4.6, 0, { rx: Math.PI });
  k.box(1.6, 1.1, 1.6, '#8d6e63', 0, 0.55, 0);
  for (const [x, z] of [[0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) k.cyl(0.02, 0.02, 6, 4, '#5d4037', x * 2, 4, z * 2, { rz: -x * 0.4, rx: z * 0.4 });
  k.cone(0.4, 1.2, 8, '#ffab40', 0, 2.2, 0, { layer: 'glow' });
  return out(k, { size: 22 });
}

function rocket(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#f5f5f5');
  k.cyl(2.2, 2.2, 30, 20, c, 0, 15, 0);
  k.cyl(2.25, 2.25, 1, 20, '#212121', 0, 10, 0);
  k.cyl(1.9, 2.2, 14, 20, c, 0, 37, 0);
  k.cyl(1.95, 1.95, 0.6, 20, '#212121', 0, 30.3, 0);
  k.cone(1.9, 7, 20, '#eceff1', 0, 47.5, 0);
  k.cyl(0.9, 1.4, 2.4, 14, '#424242', 0, -1.2, 0, { open: true });
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; k.prism([[0, 0], [3.2, -1.5], [3.2, 2], [0, 6]], 0.25, '#c62828', Math.cos(a) * 2, 1, Math.sin(a) * 2, { ry: -a }); }
  k.box(0.1, 6, 1.2, '#1565c0', 2.21, 22, 0);
  for (let i = 0; i < 3; i++) k.sphere(0.25, '#22313f', 1.92, 38 + i * 1.2, 0, { layer: 'glass', seg: 8, rings: 6 });
  const flame = partOf(T, (q) => { q.cone(1.3, 9, 14, '#ff9100', 0, -4.5, 0, { rx: Math.PI, layer: 'glow' }); q.cone(0.7, 5, 12, '#fff59d', 0, -2.5, 0, { rx: Math.PI, layer: 'glow' }); }, [0, -2.4, 0], 'flame');
  return { ...k.build(), parts: [flame], size: 52, upright: true };
}

function shuttle(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#ecf0f1');
  k.capsule(1.8, 16, c, 0, 2.5, 0, { rz: Math.PI / 2 });
  k.box(18, 0.5, 3.4, '#263238', -0.5, 1.2, 0);
  for (const s of [1, -1]) k.prism([[6, 0], [-8, 8], [-10, 8], [-9, 0]], 0.5, c, 0, 1.6, 0, { rx: s * Math.PI / 2 });
  k.prism([[0, 0], [-4, 6], [-6, 6], [-5, 0]], 0.4, c, -6, 3.8, 0);
  k.box(1.4, 0.8, 2.4, '#22313f', 8.4, 3.4, 0, { layer: 'glass', rz: -0.5 });
  for (const z of [0.9, -0.9]) k.cyl(0.6, 0.8, 1.2, 10, '#424242', -10.5, 2.6, z, { rz: Math.PI / 2 });
  const flame = partOf(T, (q) => { q.cone(0.7, 5, 12, '#82b1ff', -2.5, 0, 0.9, { rz: Math.PI / 2, layer: 'glow' }); q.cone(0.7, 5, 12, '#82b1ff', -2.5, 0, -0.9, { rz: Math.PI / 2, layer: 'glow' }); }, [-11, 2.6, 0], 'flame');
  return { ...k.build(), parts: [flame], size: 22 };
}

// --- space ----------------------------------------------------------------------------

function spaceStation(T) {
  const k = new Kit(T);
  k.cyl(3, 3, 40, 16, '#eceff1', 0, 0, 0, { rz: Math.PI / 2 });
  for (const x of [-12, 0, 12]) k.cyl(4, 4, 6, 16, '#cfd8dc', x, 0, 0, { rz: Math.PI / 2 });
  k.cyl(2.5, 2.5, 26, 12, '#b0bec5', 0, 0, 0, { rx: Math.PI / 2 });
  for (const z of [-22, -16, 16, 22]) { k.box(26, 0.3, 5.5, '#1a237e', 0, 0, z); for (let x = -12; x <= 12; x += 4) k.box(0.15, 0.32, 5.6, '#90a4ae', x, 0, z); }
  k.torus(18, 1.2, '#eceff1', 0, 0, 0, { rx: Math.PI / 2, rseg: 8, tseg: 48 });
  for (let i = 0; i < 4; i++) k.cyl(0.4, 0.4, 18, 6, '#b0bec5', Math.cos(i * Math.PI / 2) * 9, 0, Math.sin(i * Math.PI / 2) * 9, { rz: Math.PI / 2, ry: i * Math.PI / 2 });
  for (let i = 0; i < 8; i++) k.box(0.6, 0.6, 0.6, '#fff59d', Math.cos(i * Math.PI / 4) * 18, 0, Math.sin(i * Math.PI / 4) * 18, { layer: 'glow' });
  return out(k, { size: 60, spin: 0.05 });
}
function satellite(T) {
  const k = new Kit(T);
  k.box(2, 2, 2, '#ffd54f', 0, 0, 0);
  k.box(7, 0.08, 2, '#1a237e', 4.6, 0, 0); k.box(7, 0.08, 2, '#1a237e', -4.6, 0, 0);
  k.cyl(0.05, 0.05, 1.6, 4, '#bdbdbd', 0, 1.6, 0); k.cone(0.9, 0.6, 12, '#eceff1', 0, -1.4, 0, { rx: Math.PI });
  return out(k, { size: 16, spin: 0.3 });
}

// A meteorite's crater: a raised rim of thrown-up earth, a dark scorched
// bowl, blocks of rock scattered round it (at sea, nothing stays to see).
function crater(T, p, seed) {
  const k = new Kit(T);
  if (p.sea) return { body: null, glow: null, glass: null, parts: [], size: 1 };
  const R = Math.max(3, Math.min(60, Number(p.radius) || 10));
  k.torus(R, R * 0.18, '#6b5a45', 0, R * 0.05, 0, { rx: Math.PI / 2, rseg: 10, tseg: 40, sz: 0.5, jitter: 0.08 });
  k.cyl(R * 0.95, R * 0.7, 0.3, 32, '#2e2620', 0, 0.05, 0);
  k.cyl(R * 0.45, R * 0.3, 0.35, 24, '#1c1714', 0, 0.08, 0);
  k.cyl(R * 1.6, R * 1.25, 0.12, 32, '#7d6a52', 0, 0.02, 0);
  let s = seed || 3; const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 14; i++) { const a = r() * Math.PI * 2; const d = R * (1.1 + r() * 0.9); k.ico(0.4 + r() * R * 0.08, 0, '#5d4f42', Math.cos(a) * d, 0.2, Math.sin(a) * d, { jitter: 0.3 }); }
  return out(k, { size: R * 3.2 });
}

// Planets, moons and stars are spheres with painted textures (see the scene).
export function celestialSize(kind, p) {
  const b = baseKind(kind);
  const d = b === 'star' ? 140 : b === 'planet' ? 80 : b === 'moon' ? 20 : 6;
  return Math.max(2, Math.min(1000, Number(p && p.size) || d));
}
function asteroid(T, p, seed) {
  const s = celestialSize('asteroid', p);
  const k = new Kit(T);
  k.add(new T.IcosahedronGeometry(s, 1), pickBy(seed, ['#6d6d6d', '#7b6f63', '#5d5d5d']), 0, 0, 0, { sx: 1.3, sz: 0.8, jitter: 0.5 });
  return out(k, { size: s * 2.6, spin: 0.4 });
}

// --- society: law and order, the visitors, space settlements ------------------------------

function policeStation(T) {
  const k = new Kit(T);
  facadeBlock(k, 24, 16, 2, '#cfd8dc', { floorH: 4 });
  k.box(25, 0.8, 17, '#1a237e', 0, 8.4, 0);
  k.box(0.2, 1.4, 10, '#1a237e', 12.1, 6.6, 0);
  k.box(0.22, 0.9, 7, '#fafafa', 12.15, 6.6, 0, { layer: 'glow' });
  k.box(1.2, 0.6, 1.2, '#2979ff', 8, 9.2, 5, { layer: 'glow' });
  for (let i = 0; i < 3; i++) k.box(5, 0.05, 2.6, '#fafafa', 16 + i * 0.1, 0.04, -5 + i * 4);   // parking
  return out(k, { size: 30 });
}

function prison(T) {
  const k = new Kit(T);
  const W = 60; const D = 44;
  for (const [x, z, w, d] of [[0, D / 2, W, 1], [0, -D / 2, W, 1], [W / 2, 0, 1, D], [-W / 2, 0, 1, D]]) k.box(w, 7, d, '#9e9e9e', x, 3.5, z);
  for (const [x, z] of [[W / 2, D / 2], [-W / 2, D / 2], [W / 2, -D / 2], [-W / 2, -D / 2]]) { k.box(3, 12, 3, '#757575', x, 6, z); k.box(3.6, 0.6, 3.6, '#424242', x, 12.3, z); k.sphere(0.4, '#fff59d', x, 12.8, z, { layer: 'glow' }); }
  facadeBlock(k, 34, 16, 3, '#bdbdbd', { floorH: 3.4 });
  k.box(35, 0.8, 17, '#616161', 0, 10.6, 0);
  k.box(16, 0.05, 10, '#8d8d8d', 0, 0.03, -14);                                  // the yard
  k.box(4, 5, 1.2, '#455a64', W / 2 + 0.2, 2.5, 0);                             // the gate
  return out(k, { size: 66 });
}

function colony(T) {
  const k = new Kit(T);
  k.cyl(14, 16, 2, 24, '#78909c', 0, 0, 0);
  for (const [x, z, r] of [[0, 0, 7], [9, 4, 4.5], [-8, 5, 4], [3, -9, 5]]) { k.sphere(r, '#b3e5fc', x, 1, z, { layer: 'glass', sy: 0.7 }); k.cyl(r * 0.4, r * 0.4, r * 0.8, 10, '#eceff1', x, r * 0.5, z); }
  k.cyl(0.6, 0.8, 16, 8, '#cfd8dc', -11, 8, -6);
  for (let i = 0; i < 10; i++) k.sphere(0.35, '#ffe082', Math.cos(i) * 12, 1.6, Math.sin(i) * 12, { layer: 'glow', seg: 6, rings: 4 });
  return out(k, { size: 36 });
}

function alienShip(T) {
  const k = new Kit(T);
  k.lathe([[0, -1.6], [6, -0.4], [12, 0], [6, 0.8], [3, 2.2], [0, 2.6]], 40, '#b0bec5', 0, 0, 0);
  k.sphere(3.2, '#80deea', 0, 2, 0, { layer: 'glass', sy: 0.6 });
  for (let i = 0; i < 12; i++) k.sphere(0.45, '#69f0ae', Math.cos(i * Math.PI / 6) * 10.5, 0.1, Math.sin(i * Math.PI / 6) * 10.5, { layer: 'glow', seg: 6, rings: 4 });
  return out(k, { size: 26, spin: 0.6 });
}

function alienVisitor(T, p, seed) {
  const k = new Kit(T);
  const skin = pickBy(seed, ['#9ccc65', '#b39ddb', '#80cbc4']);
  k.capsule(0.18, 1.1, '#cfd8dc', 0, 1.4, 0);
  k.sphere(0.24, skin, 0, 2.3, 0, { sy: 1.35 });
  k.sphere(0.07, '#111', 0.17, 2.36, 0.09, { sx: 0.6, sy: 1.4 }); k.sphere(0.07, '#111', 0.17, 2.36, -0.09, { sx: 0.6, sy: 1.4 });
  const leg = (z) => partOf(T, (q) => q.cyl(0.06, 0.05, 1, 6, '#cfd8dc', 0, -0.5, 0), [0, 0.95, z], z > 0 ? 'legL' : 'legR');
  const arm = (z) => partOf(T, (q) => q.cyl(0.04, 0.03, 0.95, 6, skin, 0, -0.45, 0), [0, 1.85, z], z > 0 ? 'armL' : 'armR');
  return { ...k.build(), parts: [leg(0.09), leg(-0.09), arm(0.24), arm(-0.24)], size: 2.6 };
}

// A building going up: footings and scaffolding, rising with the work done.
export function scaffold(T, kind, progress) {
  const k = new Kit(T);
  const size = { house: [11, 9, 4], prison: [40, 30, 10], police_station: [24, 16, 8], hospital: [34, 22, 16], school: [40, 14, 8], road: [200, 12, 0.2], cafe: [16, 12, 6], fountain: [14, 14, 3], hangar: [30, 40, 14] }[kind] || [14, 12, 8];
  const [W, D, H] = size;
  const h = Math.max(0.6, H * Math.min(1, progress / 100));
  k.box(W + 2, 0.3, D + 2, '#9e9e9e', 0, 0.15, 0);
  if (kind === 'road') { k.box(W * Math.min(1, progress / 100), 0.15, D, '#5d5d5d', -W / 2 + (W * Math.min(1, progress / 100)) / 2, 0.08, 0); return out(k, { size: W }); }
  k.box(W * 0.9, h, D * 0.9, '#bcaaa4', 0, h / 2, 0, { jitter: 0.1 });
  for (let x = -W / 2; x <= W / 2; x += W / 4) for (const z of [-D / 2 - 0.6, D / 2 + 0.6]) k.box(0.12, h + 1.5, 0.12, '#ffb300', x, (h + 1.5) / 2, z);
  for (let y = 1.5; y < h + 1.5; y += 2) { k.box(W + 1.2, 0.1, 0.1, '#ffb300', 0, y, D / 2 + 0.6); k.box(W + 1.2, 0.1, 0.1, '#ffb300', 0, y, -D / 2 - 0.6); }
  k.box(0.4, h + 8, 0.4, '#f9a825', W / 2 + 3, (h + 8) / 2, 0);                  // the crane
  k.box(12, 0.4, 0.4, '#f9a825', W / 2 - 2, h + 8, 0);
  return out(k, { size: Math.max(W, D) + 6 });
}

// The inside of a home: the basics every home has (a bed, a table, a
// kitchen, a shower) and what its people bought (properties.furniture).
// Drawn only with "See inside" on.
export function furnitureFor(T, kind, count = 0) {
  const k = new Kit(T);
  const W = kind === 'cabin' ? 8 : kind === 'apartment' ? 20 : 11; const D = kind === 'cabin' ? 7 : kind === 'apartment' ? 14 : 9;
  const y0 = 0.4;
  k.box(W - 0.4, 0.05, D - 0.4, '#a1887f', 0, y0 + 0.03, 0);                     // floor
  k.box(0.1, 2.6, D * 0.45, '#efebe9', -W * 0.1, y0 + 1.3, -D * 0.27);            // an inner wall
  // Bedroom: the bed.
  k.box(2.1, 0.45, 1.6, '#5d4037', -W / 2 + 1.4, y0 + 0.25, -D / 2 + 1.2); k.box(2, 0.2, 1.5, '#e3f2fd', -W / 2 + 1.4, y0 + 0.55, -D / 2 + 1.2); k.box(0.5, 0.15, 1.4, '#fafafa', -W / 2 + 0.6, y0 + 0.7, -D / 2 + 1.2);
  // Bathroom: the shower, glass-walled.
  k.box(1.1, 0.1, 1.1, '#eceff1', W / 2 - 0.8, y0 + 0.08, -D / 2 + 0.8); k.box(1.1, 2.2, 0.05, '#b3e5fc', W / 2 - 0.8, y0 + 1.1, -D / 2 + 1.35, { layer: 'glass' }); k.cyl(0.03, 0.03, 0.4, 6, '#9e9e9e', W / 2 - 0.8, y0 + 2.1, -D / 2 + 0.5, { rx: 1.2 });
  // Kitchen: a counter, a stove, a fridge.
  k.box(3, 0.9, 0.6, '#eceff1', W / 2 - 2.2, y0 + 0.45, D / 2 - 0.5); k.box(0.6, 0.05, 0.5, '#212121', W / 2 - 1.4, y0 + 0.92, D / 2 - 0.5); k.box(0.7, 1.8, 0.7, '#cfd8dc', W / 2 - 4.1, y0 + 0.9, D / 2 - 0.5);
  // The table and chairs.
  k.box(1.6, 0.06, 0.9, '#8d6e63', 0.8, y0 + 0.75, 0.6); for (const [x, z] of [[0.2, 0], [1.4, 0], [0.2, 1.2], [1.4, 1.2]]) k.box(0.4, 0.45, 0.4, '#6d4c41', x, y0 + 0.23, z);
  // What they bought, in the order it came.
  const extras = [
    () => k.box(2.2, 0.5, 0.9, '#3949ab', -W / 2 + 1.5, y0 + 0.3, D / 2 - 0.7),                         // sofa
    () => k.box(1.2, 2, 0.6, '#795548', -W / 2 + 0.4, y0 + 1, 0.4),                                      // wardrobe
    () => k.box(0.3, 1.8, 1.2, '#6d4c41', W * 0.05, y0 + 0.9, -D / 2 + 0.3),                             // bookshelf
    () => k.box(2.4, 0.02, 1.6, '#c62828', -1, y0 + 0.07, 1.6),                                          // rug
    () => { k.cyl(0.03, 0.03, 1.5, 6, '#424242', -W / 2 + 2.9, y0 + 0.75, D / 2 - 0.5); k.cone(0.25, 0.3, 10, '#fff8e1', -W / 2 + 2.9, y0 + 1.55, D / 2 - 0.5, { layer: 'glow' }); },
    () => { k.box(1.2, 0.05, 0.6, '#5d4037', -W * 0.05, y0 + 0.75, -D / 2 + 1.4); k.box(0.45, 0.45, 0.45, '#424242', -W * 0.05, y0 + 0.23, -D / 2 + 2); },  // desk
    () => { k.box(1.4, 0.8, 0.06, '#111', -W / 2 + 1.5, y0 + 1.2, D / 2 - 0.1); k.box(1.3, 0.7, 0.02, '#37474f', -W / 2 + 1.5, y0 + 1.2, D / 2 - 0.15, { layer: 'glow' }); },  // television
    () => k.box(2, 0.06, 1, '#a1887f', 2.6, y0 + 0.75, -1.4),                                            // dining set
    () => { k.cyl(0.25, 0.2, 0.4, 8, '#8d6e63', W / 2 - 0.5, y0 + 0.2, 0.6); k.ico(0.45, 1, '#43a047', W / 2 - 0.5, y0 + 0.8, 0.6); },  // plant
    () => k.box(0.05, 1.2, 0.6, '#b3e5fc', -W / 2 + 0.25, y0 + 1.3, -1.2, { layer: 'glass' })           // mirror
  ];
  for (let i = 0; i < Math.min(extras.length, Math.max(0, count)); i++) extras[i]();
  return k.build();
}

// --- leisure, the coast ----------------------------------------------------------------------

function hotel(T, p) {
  const floors = Math.max(3, Math.min(16, Math.round(Number(p.floors) || 7)));
  const k = new Kit(T);
  const H = facadeBlock(k, 30, 16, floors, col(p.color, '#f5f0e6'));
  for (let f = 1; f < floors; f++) for (const x of [-10, 0, 10]) k.box(5, 0.15, 1.6, '#eceff1', x, f * 3.2, 8.8);   // balconies
  k.box(31, 0.8, 17, '#90a4ae', 0, H + 0.4, 0);
  k.box(14, 2.2, 0.3, '#263238', 0, H + 2, 0); k.box(13, 1.6, 0.32, '#ffe082', 0, H + 2, 0.02, { layer: 'glow' });       // its sign
  k.box(16, 0.4, 9, '#4fc3f7', 0, 0.25, 15, { layer: 'glass' }); k.box(17, 0.3, 10, '#eceff1', 0, 0.1, 15);              // the pool
  for (const x of [-6, -2, 2, 6]) { k.cone(1.4, 0.8, 10, '#ff7043', x, 2.4, 20.5); k.cyl(0.04, 0.04, 2.2, 5, '#bdbdbd', x, 1.1, 20.5); }
  return out(k, { size: 34 });
}
function cinema(T, p) {
  const k = new Kit(T);
  k.box(26, 11, 20, col(p.color, '#5c2a3d'), 0, 5.5, 0);
  k.box(1.6, 3, 22, '#212121', 13.6, 7, 0); k.box(1.62, 2.4, 21, '#fff176', 13.62, 7, 0, { layer: 'glow' });             // the marquee
  for (const z of [-6, 0, 6]) k.box(0.1, 3.4, 2.4, '#ef5350', 13.1, 3, z, { layer: 'glow' });                            // posters
  k.box(0.1, 3, 6, '#ffd98a', 13.06, 1.6, 0, { layer: 'glow' });
  return out(k, { size: 30 });
}
function theatre(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#e8dcc4');
  k.box(28, 14, 22, c, -2, 7, 0);
  k.box(6, 1, 22, c, 14, 0.5, 0);
  for (let i = 0; i < 6; i++) k.cyl(0.6, 0.7, 10, 12, '#fafafa', 14, 6, -9 + i * 3.6);
  k.prism([[-11.5, 0], [11.5, 0], [0, 4]], 6.5, c, 14, 11, 0, { ry: Math.PI / 2 });
  k.box(0.1, 4, 8, '#ffd98a', 12.05, 2.4, 0, { layer: 'glow' });
  return out(k, { size: 34 });
}
function bar(T, p) {
  const k = new Kit(T);
  k.box(12, 5, 10, col(p.color, '#6d4c41'), 0, 2.5, 0);
  k.box(0.1, 2, 7, '#ffcc80', 6.05, 2, 0, { layer: 'glow' });
  k.box(0.3, 1, 4, '#212121', 6.3, 4.4, 0); k.box(0.32, 0.7, 3.4, '#ff8a65', 6.35, 4.4, 0, { layer: 'glow' });
  for (const z of [-3, 0, 3]) { k.cyl(0.5, 0.5, 0.05, 10, '#8d6e63', 8.5, 1, z); k.cyl(0.05, 0.05, 1, 5, '#424242', 8.5, 0.5, z); }
  return out(k, { size: 14 });
}
function stadium(T) {
  const k = new Kit(T);
  k.lathe([[46, 0], [52, 0], [56, 14], [55, 14.5], [44, 2]], 48, '#b0bec5', 0, 0, 0, { sz: 0.7 });
  k.cyl(44, 44, 0.3, 48, '#43a047', 0, 0.2, 0, { sz: 0.7 });
  for (let i = -3; i <= 3; i++) k.box(0.3, 0.32, 60, '#fafafa', i * 12, 0.36, 0);
  for (const [x, z] of [[50, 30], [-50, 30], [50, -30], [-50, -30]]) { k.cyl(0.4, 0.5, 30, 6, '#9e9e9e', x, 15, z); k.box(5, 2, 1, '#fffde7', x, 30, z, { layer: 'glow' }); }
  return out(k, { size: 110 });
}
function beach(T, p, seed) {
  const len = Math.max(40, Math.min(600, Number(p.length) || 220));
  const k = new Kit(T);
  k.box(len, 0.25, 34, '#f2e2b0', 0, 0.12, 0, { jitter: 0.05 });
  const n = Math.round(len / 14);
  for (let i = 0; i < n; i++) {
    const x = -len / 2 + 7 + i * 14; const z = ((i * 7) % 3) * 6 - 6;
    k.cyl(0.05, 0.05, 2.4, 5, '#eceff1', x, 1.2, z); k.cone(1.6, 0.7, 10, pickBy(seed + i, ['#e53935', '#1e88e5', '#fdd835', '#43a047', '#fb8c00']), x, 2.5, z);
    k.box(1.8, 0.05, 0.9, pickBy(seed + i * 3, ['#f06292', '#4dd0e1', '#fff176']), x + 1.6, 0.27, z + 1);
  }
  k.box(1.6, 0.3, 1.6, '#d32f2f', len / 2 - 10, 3.5, -10); for (const [x, z] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) k.cyl(0.08, 0.08, 3.5, 5, '#fafafa', len / 2 - 10 + x, 1.75, -10 + z);
  return out(k, { size: len, flat: true });
}
function amusement(T) {
  const k = new Kit(T);
  k.torus(14, 0.5, '#e91e63', 0, 16, 0, { rseg: 6, tseg: 40 });
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; k.cyl(0.15, 0.15, 14, 5, '#f8bbd0', Math.cos(a) * 7, 16 + Math.sin(a) * 7, 0, { rz: a + Math.PI / 2 }); k.box(1.6, 1.4, 1.6, pickBy(i, ['#ffeb3b', '#03a9f4', '#8bc34a', '#ff5722']), Math.cos(a) * 14, 16 + Math.sin(a) * 14 - 1, 0); k.sphere(0.3, '#fff59d', Math.cos(a) * 14, 16 + Math.sin(a) * 14, 0.6, { layer: 'glow', seg: 6, rings: 4 }); }
  k.box(1, 17, 1, '#9e9e9e', 0, 8, 2.5, { rz: 0.35 }); k.box(1, 17, 1, '#9e9e9e', 0, 8, 2.5, { rz: -0.35 });
  k.cyl(7, 7, 0.6, 24, '#ffca28', 22, 0.3, 6); k.cone(8, 3, 24, '#e53935', 22, 5.5, 6); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; k.box(0.8, 1.4, 1.6, '#fafafa', 22 + Math.cos(a) * 5, 1.4, 6 + Math.sin(a) * 5); }
  return out(k, { size: 46 });
}
function port(T) {
  const k = new Kit(T);
  k.box(120, 1.6, 14, '#8d8d8d', 60, 0.6, 0);
  for (let x = 6; x < 120; x += 12) { k.cyl(0.4, 0.4, 1.2, 6, '#424242', x, 1.9, 6.4); k.cyl(0.4, 0.4, 1.2, 6, '#424242', x, 1.9, -6.4); }
  k.box(24, 10, 16, '#90a4ae', -14, 5, 0);
  k.box(1, 26, 1, '#f9a825', 90, 13, -4); k.box(24, 1, 1, '#f9a825', 84, 25.5, -4);
  k.sphere(0.6, '#ff5252', 120, 4, 0, { layer: 'glow' }); k.cyl(0.4, 0.4, 3, 6, '#fafafa', 120, 2.2, 0);
  return out(k, { size: 130 });
}
function monument(T, p) {
  const k = new Kit(T);
  k.box(6, 1, 6, '#9e9e9e', 0, 0.5, 0);
  k.prism([[-1.4, 0], [1.4, 0], [1, 14], [0, 16], [-1, 14]], 2.8, '#bcaaa4', 0, 1, 0);
  for (let i = 0; i < 6; i++) k.box(2.4, 0.18, 2.9, '#80deea', 0, 3 + i * 1.6, 0, { layer: 'glow' });
  return out(k, { size: 10 });
}
function ferry(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#ffffff');
  k.prism([[-20, 5], [24, 5], [20, 0], [-19, 0]], 9, c, 0, -1.6, 0);
  k.box(42, 0.6, 9.2, '#1565c0', 0, -1.2, 0);
  k.box(28, 3.2, 8, '#fafafa', -2, 5, 0); windowsRow(k, 28, 8, 5.2, 1.2, 10);
  k.box(18, 2.8, 7, '#fafafa', -4, 8, 0); windowsRow(k, 18, 7, 8.2, 1, 7);
  k.cyl(1.1, 1.3, 4, 12, '#c62828', -12, 11, 0);
  return out(k, { size: 46, wake: true });
}

function terminal(T) {
  const k = new Kit(T);
  k.box(60, 9, 24, '#cfd8dc', 0, 4.5, 0, { layer: 'glass' });
  k.box(62, 1, 26, '#eceff1', 0, 9.5, 0);
  for (let i = 0; i < 4; i++) { k.box(3, 4, 18, '#b0bec5', -22 + i * 15, 5, 22); k.box(3.2, 0.2, 18, '#78909c', -22 + i * 15, 7.1, 22); }   // jet bridges
  k.cyl(2.2, 2.6, 30, 12, '#eceff1', 34, 15, -6);
  k.cyl(5, 4, 4, 12, '#263238', 34, 32, -6, { layer: 'glass' });
  k.sphere(0.6, '#ff5252', 34, 35, -6, { layer: 'glow' });
  k.box(0.2, 1.6, 20, '#1565c0', 30.1, 7.6, 0); k.box(0.22, 1.2, 18, '#ffffff', 30.15, 7.6, 0, { layer: 'glow' });
  return out(k, { size: 70 });
}
function barracks(T) {
  const k = new Kit(T);
  for (const z of [-10, 10]) { k.box(40, 6, 12, '#6b7d4e', 0, 3, z); k.prism([[-6.5, 0], [6.5, 0], [0, 3]], 41, '#3e4a2f', 0, 6, z, { ry: Math.PI / 2 }); windowsRow(k, 40, 12, 3.5, 1.2, 8, 'sides'); }
  k.box(30, 0.05, 6, '#9e9e9e', 0, 0.03, 0);                                     // parade ground
  for (const [x, z, w, d] of [[0, 24, 60, 0.3], [0, -24, 60, 0.3], [30, 0, 0.3, 48], [-30, 0, 0.3, 48]]) k.box(w, 2.4, d, '#9e9e9e', x, 1.2, z, { jitter: 0.2 });
  k.cyl(0.12, 0.12, 12, 6, '#eceff1', 18, 6, 0); k.box(0.05, 1.6, 2.6, '#c62828', 18, 11, 1.3);
  return out(k, { size: 66 });
}
function armyTruck(T) {
  const k = new Kit(T);
  k.box(2.4, 2.4, 2.5, '#556b2f', 3.3, 1.8, 0);
  k.box(0.1, 0.9, 2.1, '#22313f', 4.52, 2.3, 0, { layer: 'glass' });
  k.box(6.4, 2.6, 2.6, '#4b5d29', -1.3, 2.2, 0);
  k.prism([[-1.3, 0], [1.3, 0], [1.1, 0.7], [-1.1, 0.7]], 6.4, '#3e4a22', -1.3, 3.5, 0, { ry: Math.PI / 2 });
  k.box(9, 0.35, 2.3, '#263238', 0.3, 0.6, 0);
  return { ...k.build(), parts: [wheelPair(T, 3.2, 0.55, 1.15, 0.55, 0.4), wheelPair(T, -2.8, 0.55, 1.15, 0.55, 0.4)], size: 10 };
}
function patrolBoat(T) {
  const k = new Kit(T);
  k.prism([[-9, 2.4], [11, 2.4], [9, 0], [-8.5, 0]], 4, '#78909c', 0, -0.8, 0);
  k.box(6, 2.2, 3, '#90a4ae', -1, 2.7, 0); k.box(0.08, 0.8, 2.6, '#22313f', 2.05, 3.1, 0, { layer: 'glass', rz: -0.4 });
  k.cyl(0.12, 0.12, 3.5, 5, '#b0bec5', -1, 5.4, 0); k.box(1.6, 0.6, 0.6, '#607d8b', 6, 2, 0);
  k.box(0.3, 0.3, 1.2, '#1565c0', -1, 7.1, 0, { layer: 'glow' });
  return out(k, { size: 20, wake: true });
}

function thing(T, kind, seed) {
  const k = new Kit(T);
  const c = ['#f3c623', '#36d1c4', '#8f86ff', '#3ddc84', '#ff9b7a'][seed % 5];
  k.box(1.2, 1.2, 1.2, c, 0, 0.6, 0); k.sphere(0.4, '#fafafa', 0, 1.5, 0);
  return out(k, { size: 2 });
}

// --- the factory ----------------------------------------------------------------------

const PROP_KEYS = ['color', 'roof', 'floors', 'length', 'width', 'size', 'shirt', 'livery', 'awning', 'lattice', 'built', 'sea'];
export function modelKey(kind, p, id) {
  const b = baseKind(kind);
  const c = classOf(kind);
  const parts = PROP_KEYS.map((k) => (p && p[k] !== undefined ? `${k}=${p[k]}` : '')).join('|');
  // People and trees vary by id (skin, hair, greens), the rest by colours only.
  const vary = c === 'person' || b === 'tree' || b === 'pine' || b === 'bush' || b === 'rock' || b === 'asteroid' ? (hashOf(id) % 6) : 0;
  return `${b}|${parts}|${vary}`;
}

export function buildModel(T, kind, p = {}, id = '') {
  const b = baseKind(kind);
  const seed = hashOf(id || kind);
  if (typeof p.built === 'number' && p.built < 100) return scaffold(T, b, p.built);
  switch (b) {
    case 'person': return person(T, p, seed);
    case 'child': return person(T, p, seed, { child: true });
    case 'astronaut': return person(T, p, seed, { astronaut: true });
    case 'dog': return quadruped(T, { len: 0.9, h: 0.45, w: 0.3, color: '#a1887f', ear: '#6d4c41', tail: '#a1887f' });
    case 'cat': return quadruped(T, { len: 0.55, h: 0.25, w: 0.2, color: '#ff9800', ear: '#ff9800', tail: '#ff9800' });
    case 'rabbit': return quadruped(T, { len: 0.45, h: 0.18, w: 0.24, color: '#bcaaa4', belly: '#efebe9', ear: 'long', tail: '#fafafa' });
    case 'fox': return quadruped(T, { len: 0.9, h: 0.4, w: 0.28, color: '#e65100', belly: '#fafafa', ear: '#e65100', tail: '#e65100', legColor: '#3e2723' });
    case 'deer': return quadruped(T, { len: 1.5, h: 0.9, w: 0.42, color: '#8d6e63', belly: '#d7ccc8', ear: 'antlers', tail: '#efebe9' });
    case 'horse': return quadruped(T, { len: 2.2, h: 1.2, w: 0.6, color: '#5d4037', ear: '#5d4037', tail: '#212121', legColor: '#4e342e' });
    case 'cow': return quadruped(T, { len: 2.2, h: 0.9, w: 0.8, color: '#fafafa', spots: '#212121', ear: '#fafafa', tail: '#fafafa', head: '#fafafa' });
    case 'fish': return quadruped(T, { len: 0.5, h: 0.05, w: 0.15, color: '#4fc3f7' });
    case 'bird': return bird(T, p, seed);
    case 'tree': return tree(T, p, seed);
    case 'pine': return pine(T, p, seed);
    case 'palm': return palm(T, p);
    case 'bush': return bush(T, p, seed);
    case 'flower': return flower(T, p);
    case 'grass': return grass(T);
    case 'crop': return crop(T, p);
    case 'house': return house(T, p, seed);
    case 'cabin': return house(T, p, seed, { cabin: true });
    case 'apartment': return apartment(T, p);
    case 'tower': return tower(T, p);
    case 'shop': return shop(T, p);
    case 'cafe': return shop(T, p, { cafe: true });
    case 'school': return school(T, p);
    case 'hospital': return hospital(T, p);
    case 'station': return station(T, p);
    case 'factory': return factory(T, p);
    case 'barn': return barn(T, p);
    case 'hangar': return hangar(T, p);
    case 'road': return road(T, p);
    case 'runway': return road(T, p, { runway: true });
    case 'bridge': return road(T, p, { bridge: true });
    case 'launch_pad': return launchPad(T);
    case 'rock': return rock(T, p, seed);
    case 'crater': return crater(T, p, seed);
    case 'fence': return fence(T, p);
    case 'lamp': return lamp(T);
    case 'fountain': return fountain(T);
    case 'car': return car(T, p, seed);
    case 'taxi': return car(T, p, seed, 'taxi');
    case 'police_car': return car(T, p, seed, 'police');
    case 'bus': return bus(T, p);
    case 'truck': return truck(T, p);
    case 'tractor': return tractor(T, p);
    case 'train': return train(T);
    case 'bike': return bike(T, p, seed);
    case 'motorbike': return bike(T, p, seed, { motor: true });
    case 'boat': return boat(T, p);
    case 'ship': return boat(T, p, { ship: true });
    case 'plane': return plane(T, p);
    case 'small_plane': return plane(T, p, { small: true });
    case 'jet': return plane(T, p, { jet: true });
    case 'helicopter': return helicopter(T, p);
    case 'drone': return drone(T);
    case 'hot_air_balloon': return balloon(T, p);
    case 'rocket': return rocket(T, p);
    case 'shuttle': return shuttle(T, p);
    case 'space_station': return spaceStation(T);
    case 'satellite': return satellite(T);
    case 'asteroid': return asteroid(T, p, seed);
    case 'police_station': return policeStation(T);
    case 'prison': return prison(T);
    case 'colony': return colony(T);
    case 'alien_ship': return alienShip(T);
    case 'alien': return alienVisitor(T, p, seed);
    case 'hotel': return hotel(T, p);
    case 'cinema': return cinema(T, p);
    case 'theatre': return theatre(T, p);
    case 'bar': return bar(T, p);
    case 'stadium': return stadium(T);
    case 'beach': return beach(T, p, seed);
    case 'amusement': return amusement(T);
    case 'port': return port(T);
    case 'monument': return monument(T, p);
    case 'ferry': return ferry(T, p);
    case 'terminal': return terminal(T);
    case 'barracks': return barracks(T);
    case 'army_truck': return armyTruck(T);
    case 'patrol_boat': return patrolBoat(T);
    default: return thing(T, kind, seed);
  }
}
