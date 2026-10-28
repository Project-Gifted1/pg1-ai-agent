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
import { RESCUE_CLASS, RESCUE_FIXED, rescueModel } from './rescue-models.js';

import { Kit } from './kit.js';
import { PERIOD_CLASS, PERIOD_FIXED, periodModel, setPeriodDetail } from './period-models.js';

// The viewer's copy of the catalogue's classes (lib/sandbox/catalog.mjs).
export const KIND_CLASS = {
  person: 'person', child: 'person', astronaut: 'person', alien: 'person',
  dog: 'animal', cat: 'animal', rabbit: 'animal', fox: 'animal', deer: 'animal', horse: 'animal', cow: 'animal', goat: 'animal', fowl: 'animal', bird: 'animal', fish: 'animal',
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
// The benin-warri template's kinds (period-models.js).
Object.assign(KIND_CLASS, PERIOD_CLASS);
for (const k of PERIOD_FIXED) FIXED_KINDS.add(k);
// Homes whose insides the viewer furnishes (see furnitureFor).
export const HOME_KINDS = new Set(['house', 'cabin', 'apartment']);
// Where a meteorite struck (lib/sandbox/cosmos.mjs).
KIND_CLASS.crater = 'structure';   // drawn on its own (not batched), so a new one can wait for its meteorite

// Emergency services and the beach (rescue-models.js).
Object.assign(KIND_CLASS, RESCUE_CLASS);
for (const k of RESCUE_FIXED) FIXED_KINDS.add(k);
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

// How much small detail models carry: 1 (Low: the plain shapes) or 2
// (Medium and up: fingers, glasses, roof tiles, railings, mullions...). The
// scene sets it from its quality tier; it is part of every model's key.
let DETAIL = 2;
export function setModelDetail(d) { DETAIL = d >= 2 ? 2 : 1; setPeriodDetail(DETAIL); }
function partOf(THREE, fill, pivot, role) {
  const k = new Kit(THREE);
  fill(k);
  return { geo: k.build(), pivot, role };
}

// --- people ---------------------------------------------------------------------------

// A person, in proportion (about seven and a half heads tall): a torso
// turned on a lathe (chest, waist, hips), tapered limbs with knees and
// elbows, hands with a thumb and four fingers, feet in shoes or bare. The
// head has a cranium and jaw, a brow, a nose with nostrils, eyes with lids,
// irises and a catch-light, lips and ears; one of seven hair styles, some
// with a beard. Clothes: a shirt with a collar and buttons, trousers with a
// belt, or a dress or skirt; some wear a jacket, glasses or a hat, some
// carry a bag. 24 looks per kind, from the id; arms and legs swing (parts).
//
// The benin-warri template's people (PERIOD_PEOPLE) wear a cloth wrapper
// and go barefoot; the royal family wear a collar of coral beads (C1 in
// docs/sandbox-benin-warri.md). Its Portuguese visitors are bearded under a
// brimmed hat with feathers (C2).
const PERIOD_PEOPLE = new Set(['benin', 'warri', 'urhobo', 'ijaw']);
const CORAL = '#d4502f';
const shade = (T, c, f) => `#${new T.Color(c).multiplyScalar(f).getHexString()}`;

// A limb segment hanging from y0: a cone from r0 to r1, with a ball at the top.
function limb(q, r0, r1, len, color, x, y0, z, seg) {
  q.sphere(r0 * 0.98, color, x, y0, z, { seg, rings: Math.max(6, seg >> 1) });
  q.cyl(r0, r1, len, seg, color, x, y0 - len / 2, z);
}

function person(T, p, seed0, { child = false, astronaut = false, visitor: guest = false } = {}) {
  const s = child ? 0.7 : 1;
  // Everything about the look comes from one of 24 (as the model's cache key does).
  const seed = Math.imul(seed0 % 24 + 7, 40503) >>> 0;
  const v = Math.imul(seed0 % 24 + 1, 2654435761) >>> 0;   // the look's own bits
  const bit = (n, m) => (v >>> n) % m;
  const hi = DETAIL >= 2;
  const seg = hi ? 14 : 9;
  const period = !astronaut && PERIOD_PEOPLE.has(p.country);
  const visitor = !astronaut && guest;
  const female = !visitor && (p.sex === 'female' || (p.sex === undefined && bit(5, 2) === 0));
  const skin = period ? pickBy(seed, ['#5c3a21', '#6b4226', '#4a2c17', '#7a4b2a']) : visitor ? pickBy(seed, ['#e8c4a0', '#d9a77c', '#f1c9a5']) : pickBy(seed, SKIN);
  const skinD = shade(T, skin, 0.82);
  const hair = period ? '#141010' : pickBy(seed >> 3, HAIR);
  const cloth = col(p.shirt, pickBy(seed >> 5, ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#ecf0f1', '#ff8a65', '#4db6ac']));
  const shirt = astronaut ? '#f4f4f4' : period ? skin : visitor ? pickBy(seed >> 5, ['#3b2a20', '#1f2a3a', '#4a1f1f']) : cloth;
  const pants = astronaut ? '#e8e8e8' : visitor ? pickBy(seed >> 7, ['#2b2b2b', '#4e342e', '#283593']) : pickBy(seed >> 7, ['#2c3e50', '#34495e', '#1f2a44', '#5d4037', '#212121', '#6d7a8a']);
  const shoe = astronaut ? '#bbbbbb' : visitor ? '#2a1d14' : pickBy(v >> 9, ['#1a1a1a', '#3e2723', '#fafafa', '#5d4037']);
  const modern = !astronaut && !period && !visitor;
  const jacket = modern && !child && bit(3, 4) === 0 ? pickBy(v >> 11, ['#263238', '#4e342e', '#1a237e', '#33691e']) : null;
  const dress = modern && female && bit(7, 3) === 0;
  const skirt = modern && female && !dress && bit(9, 3) === 0;
  const skirtCol = dress ? cloth : pickBy(v >> 15, ['#ad1457', '#283593', '#212121', '#6a1b9a']);
  // Hair: 0 short, 1 long, 2 bun, 3 curly, 4 cap, 5 side parting, 6 close-cropped.
  const style = astronaut ? -1 : period ? (female ? 3 : 6) : visitor ? 1 : female ? [1, 2, 3, 1, 5, 2][bit(13, 6)] : [0, 6, 3, 4, 5, 0][bit(13, 6)];
  const beard = visitor || (modern && !female && !child && bit(19, 5) === 0);
  const k = new Kit(T);

  // --- body ---------------------------------------------------------------
  // Lathe profiles: [half-width, height]; x (front to back) is squeezed.
  const torso = female
    ? [[0.001, 0.86], [0.1, 0.87], [0.168, 0.93], [0.17, 0.99], [0.135, 1.08], [0.13, 1.14], [0.148, 1.24], [0.155, 1.31], [0.16, 1.38], [0.165, 1.42], [0.145, 1.46], [0.1, 1.49], [0.055, 1.505]]
    : [[0.001, 0.86], [0.1, 0.87], [0.158, 0.93], [0.155, 1.0], [0.145, 1.08], [0.15, 1.16], [0.165, 1.26], [0.18, 1.35], [0.19, 1.41], [0.165, 1.455], [0.11, 1.49], [0.055, 1.505]];
  const up = (pts, y0, y1) => pts.filter(([, y]) => y >= y0 && y <= y1).map(([r, y]) => [r * s, (y - y0) * s]);
  const lower = period ? skin : dress ? skirtCol : pants;
  // Upper body from the waist, lower from the crotch, each its own colour.
  k.lathe(up(torso, 0.86, 1.08), seg + 4, lower, 0, 0.86 * s, 0, { sx: 0.66 });
  k.lathe(up(torso, 1.08, 1.5), seg + 4, astronaut ? '#f4f4f4' : jacket || shirt, 0, 1.08 * s, 0, { sx: female ? 0.62 : 0.6 });
  if (female && !astronaut && !child) k.sphere(0.1 * s, jacket || shirt, 0.04 * s, 1.3 * s, 0, { sx: 0.6, sy: 0.55, sz: 1.35, seg, rings: seg >> 1 });   // bust
  if (period && !female && hi) k.box(0.01 * s, 0.006 * s, 0.006 * s, skinD, 0.098 * s, 1.1 * s, 0);                              // navel

  // --- clothes ------------------------------------------------------------
  if (modern || astronaut) {
    if (modern && !dress) {
      k.cyl(0.152 * s, 0.155 * s, 0.045 * s, seg + 4, '#3e2723', 0, 1.03 * s, 0, { sx: 0.67 });                               // belt
      k.box(0.012 * s, 0.035 * s, 0.045 * s, '#c9a227', 0.1 * s, 1.03 * s, 0);                                                // buckle
    }
    if (modern) {
      k.cyl(0.058 * s, 0.07 * s, 0.05 * s, seg, shirt, 0, 1.5 * s, 0, { sx: 0.95 });                                           // collar
      if (!jacket) for (let i = 0; i < 4; i++) k.sphere(0.009 * s, '#eeeeee', (0.093 + i * 0.002) * s, (1.42 - i * 0.09) * s, 0, { seg: 5, rings: 4 });   // buttons
      if (hi) for (const z of [0.045, -0.045]) k.box(0.05 * s, 0.01 * s, 0.045 * s, shirt, 0.07 * s, 1.49 * s, z * s, { ry: z > 0 ? 0.6 : -0.6, rz: -0.6 });   // collar points
    }
    if (jacket) {
      // An open front: the shirt shows in a V between lapels.
      k.box(0.006 * s, 0.32 * s, 0.07 * s, shirt, 0.104 * s, 1.31 * s, 0);
      for (const z of [0.045, -0.045]) k.box(0.012 * s, 0.24 * s, 0.045 * s, shade(T, jacket, 0.85), 0.104 * s, 1.36 * s, z * s, { rx: z > 0 ? -0.25 : 0.25 });
      k.lathe([[0.15 * s, 0], [0.152 * s, 0.1 * s]], seg + 4, jacket, 0, 1.0 * s, 0, { sx: 0.68 });                         // hem over the belt
      if (hi) for (const z of [0.09, -0.09]) k.box(0.01 * s, 0.012 * s, 0.07 * s, shade(T, jacket, 0.75), 0.098 * s, 1.08 * s, z * s);   // pocket flaps
    }
    if (dress || skirt) k.lathe([[0.135 * s, 0], [0.17 * s, 0.1 * s], [0.25 * s, (dress ? 0.5 : 0.38) * s], [0.26 * s, (dress ? 0.52 : 0.4) * s]].map(([r, y]) => [r, -y]).reverse(), seg + 6, skirtCol, 0, 1.05 * s, 0, { sx: 0.82 });
    if (modern && bit(17, 5) === 0 && !child) {                                                                               // a shoulder bag
      k.box(0.07 * s, 0.22 * s, 0.24 * s, pickBy(v >> 19, ['#6d4c41', '#212121', '#8d6e63']), -0.01 * s, 0.98 * s, 0.2 * s, { rx: 0.05 });
      k.box(0.012 * s, 0.62 * s, 0.03 * s, '#3e2723', 0.02 * s, 1.24 * s, 0.07 * s, { rx: 0.52 });
    }
    if (astronaut) {
      k.box(0.2 * s, 0.46 * s, 0.34 * s, '#d0d0d0', -0.19 * s, 1.24 * s, 0);                                                   // life-support pack
      k.box(0.03 * s, 0.12 * s, 0.16 * s, '#1565c0', 0.1 * s, 1.3 * s, 0);                                                    // chest panel
      for (const z of [0.04, -0.04]) k.sphere(0.012 * s, z > 0 ? '#e53935' : '#43a047', 0.118 * s, 1.33 * s, z * s, { seg: 6, rings: 4, layer: 'glow' });
      k.torus(0.075 * s, 0.018 * s, '#c0c0c0', 0, 1.5 * s, 0, { rx: Math.PI / 2 });                                          // neck ring
    }
  } else if (period) {
    // A cloth wrapper: from the waist to the knee (men), the chest to the calf (women), knotted at the left hip.
    const top = female ? 1.36 : 1.06; const hem = female ? 0.32 : 0.5;
    k.lathe([[0.16, hem], [0.2, hem + 0.02], [0.185, (hem + 0.92) / 2], [0.17, 0.92], [0.162, 1.0], female ? [0.14, 1.1] : [0.15, 1.06], ...(female ? [[0.15, 1.24], [0.157, 1.36]] : [])]
      .map(([r, y]) => [r * s, (y - hem) * s]), seg + 6, cloth, 0, hem * s, 0, { sx: 0.74 });
    k.sphere(0.035 * s, shade(T, cloth, 0.9), 0.02 * s, (top - 0.03) * s, 0.14 * s, { sx: 0.8 });                            // the knot
    if (hi) k.lathe([[0.164 * s, 0], [0.168 * s, 0.025 * s]], seg + 6, shade(T, cloth, 0.75), 0, (top - 0.04) * s, 0, { sx: 0.72 });   // a sash
    if (hi && !female) k.cone(0.06 * s, 0.32 * s, 6, cloth, 0.02 * s, (hem + 0.13) * s, 0.16 * s, { rx: -0.12 });           // the loose end
    if (p.royal) for (let i = 0; i < (hi ? 5 : 3); i++) k.torus((0.054 + i * 0.002) * s, 0.012 * s, i % 2 ? CORAL : '#e0643f', 0, (1.545 - i * 0.02) * s, 0, { rx: Math.PI / 2, sx: 1.12, tseg: hi ? 18 : 10, rseg: 5 });   // the coral collar, high on the neck (C1)
  } else if (visitor) {
    // A doublet buttoned down the front, a falling collar, breeches and hose.
    k.lathe([[0.16 * s, 0], [0.19 * s, 0.12 * s], [0.18 * s, 0.24 * s]], seg + 4, pants, 0, 0.74 * s, 0, { sx: 0.75 });     // breeches
    for (let i = 0; i < 6; i++) k.sphere(0.008 * s, '#c9a227', 0.096 * s, (1.42 - i * 0.065) * s, 0, { seg: 5, rings: 4 });
    k.cyl(0.07 * s, 0.11 * s, 0.03 * s, seg, '#eeeeee', 0, 1.49 * s, 0, { sx: 0.9 });                                         // the collar
    k.cyl(0.153 * s, 0.153 * s, 0.035 * s, seg + 4, '#2a1d14', 0, 1.04 * s, 0, { sx: 0.68 });                                 // a sword belt
  }

  // --- neck and head ------------------------------------------------------
  // Children's heads are larger for their height.
  const hs = child ? 1.15 : 1;
  const hy = 1.635 * s + (child ? 0.01 : 0);
  const H = (n) => n * s * hs;
  k.cyl(H(0.045), H(0.052), H(0.12), seg, skin, 0, hy - H(0.115), 0);
  if (astronaut) {
    k.sphere(H(0.165), '#f4f4f4', 0, hy + H(0.01), 0, { seg: 20, rings: 14 });
    k.sphere(H(0.13), '#1b2a3a', H(0.055), hy + H(0.015), 0, { sx: 0.85, sy: 0.8, sz: 0.95, layer: 'glass', seg: 18, rings: 12 });
    k.torus(H(0.13), H(0.012), '#c9a227', H(0.055), hy + H(0.015), 0, { ry: Math.PI / 2, sx: 0.85, tseg: 24 });
  } else {
    k.sphere(H(0.098), skin, H(-0.008), hy + H(0.02), 0, { sx: 1.1, sy: 1.12, sz: 0.9, seg: hi ? 24 : 16, rings: hi ? 16 : 10 });   // cranium
    k.sphere(H(0.074), skin, H(0.012), hy - H(0.042), 0, { sx: 0.95, sy: 0.92, sz: 0.95, seg: hi ? 18 : 12, rings: hi ? 12 : 8 });   // jaw and cheeks
    k.sphere(H(0.028), skin, H(0.06), hy - H(0.088), 0, { sx: 0.85, sy: 0.85, sz: 1.3, seg: 10, rings: 6 });                      // chin
    k.sphere(H(0.05), skin, H(0.06), hy + H(0.04), 0, { sx: 0.6, sy: 0.4, sz: 1.5, seg: 12, rings: 8 });                         // brow
    // Nose: a ridge down to a rounded tip, with nostril wings.
    const nose = period ? 1.25 : 1;
    k.sphere(H(0.016), skin, H(0.092), hy - H(0.005), 0, { sx: 0.8, sy: 2.0, sz: 0.75 * nose, rz: -0.3, seg: 10, rings: 8 });
    k.sphere(H(0.014), skin, H(0.1), hy - H(0.028), 0, { sz: nose, seg: 10, rings: 8 });
    for (const z of [0.012, -0.012]) k.sphere(H(0.01), skin, H(0.093), hy - H(0.03), H(z * nose), { sx: 0.9, seg: 8, rings: 6 });
    // Eyes: white, iris, pupil, a catch-light, an upper lid.
    const iris = period ? '#2a1a10' : pickBy(v >> 21, ['#3e2723', '#1565c0', '#2e7d32', '#212121', '#6d4c2f']);
    for (const z of [0.034, -0.034]) {
      k.sphere(H(0.0165), '#f4f1ea', H(0.077), hy + H(0.015), H(z), { seg: 10, rings: 8 });
      k.sphere(H(0.0095), iris, H(0.09), hy + H(0.015), H(z), { sx: 0.5, seg: 8, rings: 6 });
      if (hi) { k.sphere(H(0.005), '#050505', H(0.095), hy + H(0.015), H(z), { sx: 0.5, seg: 6, rings: 4 }); k.sphere(H(0.002), '#ffffff', H(0.097), hy + H(0.019), H(z + 0.003), { seg: 4, rings: 3, layer: 'glow' }); }
      k.sphere(H(0.0175), skinD, H(0.076), hy + H(0.022), H(z), { sy: 0.55, seg: 10, rings: 6 });                                 // lid
      k.capsule(H(0.004), H(0.026), hair, H(0.086), hy + H(0.039), H(z), { rx: Math.PI / 2 + (z > 0 ? 0.15 : -0.15), rseg: 5, cseg: 2 });   // eyebrow
    }
    // Lips, ears.
    const lip = period ? '#5a2f25' : shade(T, '#b5585a', 0.7 + (seed % 5) * 0.06);
    k.sphere(H(0.022), lip, H(0.08), hy - H(0.053), 0, { sx: 0.32, sy: 0.24 * (period ? 1.3 : 1), sz: 1.0, seg: 12, rings: 8 });
    k.sphere(H(0.02), shade(T, lip, 1.12), H(0.078), hy - H(0.064), 0, { sx: 0.34, sy: 0.3 * (period ? 1.3 : 1), sz: 0.95, seg: 12, rings: 8 });
    for (const z of [0.088, -0.088]) {
      k.sphere(H(0.026), skin, H(-0.005), hy + H(0.005), H(z), { sx: 0.7, sy: 1.25, sz: 0.38, seg: 10, rings: 8 });
      if (hi) k.sphere(H(0.012), skinD, H(-0.002), hy + H(0.003), H(z * 1.05), { sx: 0.7, sy: 1.3, sz: 0.3, seg: 6, rings: 4 });
    }
    // Hair.
    const cap = (r, sx, sy, dy, dx = -0.02, c = hair) => k.sphere(H(r), c, H(dx), hy + H(dy), 0, { sx, sy, sz: 0.94, seg: hi ? 20 : 14, rings: hi ? 12 : 8 });
    if (style === 6) cap(0.101, 1.08, 0.98, 0.04, -0.015);                                                                          // close-cropped
    else if (style === 4) { const hc = pickBy(v >> 23, ['#c62828', '#1565c0', '#212121', '#2e7d32']); cap(0.104, 1.06, 0.82, 0.05, -0.01, hc); k.box(H(0.1), H(0.012), H(0.16), hc, H(0.105), hy + H(0.065), 0, { rz: -0.12 }); }   // a cap with a peak
    else if (style === 3) { cap(0.103, 1.08, 1.0, 0.045); for (let i = 0; i < (hi ? 22 : 10); i++) { const a = (i / (hi ? 22 : 10)) * Math.PI * 2; const ring = i % 2; k.ico(H(0.04), 0, hair, H(Math.cos(a) * 0.075 - 0.02), hy + H(0.075 + ring * 0.03 - (Math.cos(a) > 0.5 ? 0.02 : 0)), H(Math.sin(a) * 0.085)); } }   // curly
    else {
      cap(0.104, 1.1, 1.0, 0.04);
      if (style === 0) k.box(H(0.06), H(0.025), H(0.15), hair, H(0.07), hy + H(0.1), 0, { rz: -0.35 });                          // short, swept up
      if (style === 5) k.capsule(H(0.03), H(0.11), hair, H(0.065), hy + H(0.095), H(0.02), { rx: Math.PI / 2, rz: -0.3, rseg: 8 });   // a side parting
      if (style === 1) {                                                                                                            // long, over the shoulders
        k.sphere(H(0.11), hair, H(-0.04), hy - H(0.03), 0, { sx: 0.8, sy: 1.25, sz: 0.98, seg: 16, rings: 10 });
        if (hi) for (const z of [-0.07, -0.025, 0.025, 0.07]) k.capsule(H(0.026), H(0.2), hair, H(-0.06), hy - H(0.12), H(z), { rseg: 6 });
      }
      if (style === 2) { k.sphere(H(0.05), hair, H(-0.1), hy + H(0.08), 0, { seg: 12, rings: 8 }); if (hi) k.torus(H(0.035), H(0.01), shade(T, hair, 0.7), H(-0.09), hy + H(0.065), 0, { ry: Math.PI / 2, rz: 0.6 }); }   // a bun
    }
    if (beard) {
      k.sphere(H(0.066), hair, H(0.03), hy - H(0.075), 0, { sx: 0.95, sy: 0.85, sz: 1.08, seg: 14, rings: 10 });
      k.sphere(H(0.032), hair, H(0.072), hy - H(0.105), 0, { sx: 0.9, sz: 1.3, seg: 10, rings: 6 });                             // over the chin
      k.capsule(H(0.01), H(0.045), hair, H(0.096), hy - H(0.04), 0, { rx: Math.PI / 2, rseg: 6, cseg: 2 });                     // moustache
      k.capsule(H(0.008), H(0.034), lip, H(0.1), hy - H(0.058), 0, { rx: Math.PI / 2, rseg: 6, cseg: 2 });                    // the lip shows through
    }
    if (visitor) {                                                                                                                   // a brimmed hat, banded, with feathers (C2)
      k.cyl(H(0.17), H(0.17), H(0.012), 22, '#1c1c1c', 0, hy + H(0.09), 0);
      k.cyl(H(0.085), H(0.1), H(0.1), 18, '#1c1c1c', 0, hy + H(0.14), 0);
      for (let i = 0; i < 3; i++) k.torus(H(0.098 - i * 0.005), H(0.006), '#c9a227', 0, hy + H(0.105 + i * 0.03), 0, { rx: Math.PI / 2, tseg: 18, rseg: 4 });
      for (const t of [0.4, 0.7]) k.capsule(H(0.012), H(0.16), '#f5f0e6', H(-0.06), hy + H(0.2), H(-0.06 + t * 0.05), { rz: t, rx: -0.3, rseg: 5 });
    } else if (modern && hi && bit(29, 8) === 0 && style !== 4) {                                                                  // a sun hat
      k.cyl(H(0.19), H(0.19), H(0.01), 20, '#d7b56d', 0, hy + H(0.08), 0); k.cyl(H(0.1), H(0.11), H(0.09), 16, '#d7b56d', 0, hy + H(0.13), 0); k.cyl(H(0.112), H(0.112), H(0.022), 16, '#5d4037', 0, hy + H(0.1), 0);
    }
    if (modern && hi && bit(27, 6) === 0) {                                                                                          // glasses
      for (const z of [0.034, -0.034]) k.torus(H(0.021), H(0.0035), '#212121', H(0.098), hy + H(0.015), H(z), { ry: Math.PI / 2, tseg: 14, rseg: 4 });
      k.box(H(0.005), H(0.005), H(0.024), '#212121', H(0.1), hy + H(0.02), 0);
      for (const z of [0.056, -0.056]) k.box(H(0.1), H(0.005), H(0.005), '#212121', H(0.05), hy + H(0.02), H(z * 1.5));
    }
  }

  // --- legs and arms (moving parts) ---------------------------------------
  // Legs hang from the hip (y 0.88): thigh, knee, shin with a calf, a foot.
  const bare = period;
  const shin = period || ((dress || skirt) && !astronaut) ? skin : visitor ? '#e8e0d0' : pants;
  const thigh = period ? (female ? cloth : skin) : dress ? skin : pants;
  const leg = (z) => partOf(T, (q) => {
    limb(q, 0.078 * s, 0.056 * s, 0.42 * s, thigh, 0, 0, 0, seg);
    limb(q, 0.055 * s, 0.038 * s, 0.4 * s, shin, 0, -0.43 * s, 0, seg);
    if (hi) q.sphere(0.05 * s, shin, -0.012 * s, -0.56 * s, 0, { sy: 2.0, sx: 0.9, seg, rings: seg >> 1 });                   // calf
    if (bare) {
      q.sphere(0.042 * s, skin, 0.045 * s, -0.85 * s, 0, { sx: 2.3, sy: 0.65, sz: 1.05, seg, rings: seg >> 1 });
      if (hi) for (let t = 0; t < 5; t++) q.sphere(0.011 * s, skin, 0.135 * s, -0.865 * s, (t - 2) * 0.017 * s, { seg: 6, rings: 4 });   // toes
    } else {
      q.sphere(0.048 * s, shoe, 0.05 * s, -0.845 * s, 0, { sx: 2.4, sy: 0.75, sz: 1.08, seg, rings: seg >> 1 });               // shoe
      q.box(0.24 * s, 0.022 * s, 0.1 * s, '#2b2b2b', 0.05 * s, -0.874 * s, 0);                                                 // sole
      if (hi && modern) q.box(0.07 * s, 0.008 * s, 0.05 * s, '#e0e0e0', 0.07 * s, -0.81 * s, 0, { rz: -0.3 });                 // laces
    }
  }, [0, 0.88 * s, z], z > 0 ? 'legL' : 'legR');
  // Arms hang from the shoulder (y 1.43): upper arm, elbow, forearm, a hand.
  const sleeve = astronaut ? '#f4f4f4' : period ? skin : jacket || shirt;
  const longSleeve = astronaut || jacket || visitor || (modern && bit(25, 2) === 0);
  const fore = longSleeve ? sleeve : skin;
  const hand = astronaut ? '#dddddd' : skin;
  const arm = (z) => partOf(T, (q) => {
    const side = z > 0 ? 1 : -1;
    limb(q, 0.05 * s, 0.04 * s, 0.29 * s, sleeve, 0, 0, 0, seg);
    if (modern && !longSleeve) q.cyl(0.054 * s, 0.05 * s, 0.05 * s, seg, sleeve, 0, -0.13 * s, 0);                             // the short sleeve's hem
    limb(q, 0.04 * s, 0.03 * s, 0.26 * s, fore, 0.005 * s, -0.29 * s, 0, seg);
    if (longSleeve && !astronaut) q.cyl(0.036 * s, 0.036 * s, 0.03 * s, seg, visitor ? '#eeeeee' : shade(T, sleeve, 0.9), 0.005 * s, -0.54 * s, 0);   // cuff
    if (astronaut) q.cyl(0.045 * s, 0.04 * s, 0.06 * s, seg, '#c0c0c0', 0.005 * s, -0.55 * s, 0);                            // glove ring
    q.sphere(0.034 * s, hand, 0.012 * s, -0.6 * s, 0, { sx: 0.62, sy: 1.25, sz: 1.0, seg: 10, rings: 8 });                   // palm
    q.capsule(0.011 * s, 0.035 * s, hand, 0.03 * s, -0.59 * s, side * -0.022 * s, { rz: 0.5, rx: side * 0.3, rseg: 6, cseg: 2 });   // thumb
    if (hi) for (let f = 0; f < 4; f++) q.capsule(0.0085 * s, (0.05 - Math.abs(f - 1.5) * 0.006) * s, hand, 0.012 * s, -0.66 * s, (f - 1.5) * 0.015 * s, { rz: -0.15, rseg: 5, cseg: 2 });   // fingers
    else q.box(0.03 * s, 0.05 * s, 0.055 * s, hand, 0.012 * s, -0.655 * s, 0);
    if (modern && hi && z > 0 && bit(30, 3) === 0) q.cyl(0.033 * s, 0.033 * s, 0.018 * s, 10, '#37474f', 0.005 * s, -0.5 * s, 0);   // a watch
  }, [0, 1.43 * s, z], z > 0 ? 'armL' : 'armR');
  return { ...k.build(), parts: [leg(0.095 * s), leg(-0.095 * s), arm(0.205 * s), arm(-0.205 * s)], size: 1.8 * s };
}

// --- animals --------------------------------------------------------------------------

function quadruped(T, o) {
  const k = new Kit(T);
  const { len, h, w, color, belly = color, head = color, ear = null, tail = null, legColor = color } = o;
  k.capsule(w / 2, len - w, color, 0, h, 0, { rz: Math.PI / 2 });
  k.box(len * 0.6, w * 0.4, w * 0.8, belly, 0, h - w * 0.35, 0);
  {
    k.sphere(w * 0.55, head, len / 2 + w * 0.15, h + w * 0.45, 0, { sx: 1.25 });
    k.cone(w * 0.22, w * 0.5, 8, head, len / 2 + w * 0.75, h + w * 0.38, 0, { rz: -Math.PI / 2 });    // snout
    k.sphere(w * 0.08, '#111', len / 2 + w * 0.42, h + w * 0.6, w * 0.25);
    k.sphere(w * 0.08, '#111', len / 2 + w * 0.42, h + w * 0.6, -w * 0.25);
    if (ear === 'long') { k.box(w * 0.15, w * 1.1, w * 0.3, head, len / 2, h + w * 1.3, w * 0.18, { rz: 0.15 }); k.box(w * 0.15, w * 1.1, w * 0.3, head, len / 2, h + w * 1.3, -w * 0.18, { rz: 0.15 }); }
    else if (ear === 'antlers') { for (const z of [w * 0.25, -w * 0.25]) { k.cyl(0.03, 0.04, w * 1.4, 6, '#6d4c2f', len / 2 + w * 0.1, h + w * 1.5, z, { rx: z > 0 ? -0.35 : 0.35 }); k.cyl(0.02, 0.03, w * 0.6, 6, '#6d4c2f', len / 2 + w * 0.3, h + w * 1.6, z * 1.6, { rz: -0.8 }); } }
    else if (ear) { k.cone(w * 0.16, w * 0.35, 6, ear, len / 2 + w * 0.05, h + w * 0.95, w * 0.28); k.cone(w * 0.16, w * 0.35, 6, ear, len / 2 + w * 0.05, h + w * 0.95, -w * 0.28); }
  }
  if (tail) k.cone(w * 0.2, len * 0.45, 8, tail, -len / 2 - len * 0.15, h + w * 0.1, 0, { rz: Math.PI / 2 + 0.5 });
  if (o.spots) for (let i = 0; i < 5; i++) k.sphere(w * 0.32, o.spots, (i - 2) * len * 0.18, h + w * 0.35, (i % 2 ? 1 : -1) * w * 0.33, { sy: 0.7, sz: 0.4 });
  const legs = [];
  for (const [x, z, role] of [[len * 0.36, w * 0.3, 'legL'], [len * 0.36, -w * 0.3, 'legR'], [-len * 0.36, w * 0.3, 'legR'], [-len * 0.36, -w * 0.3, 'legL']]) {
    legs.push(partOf(T, (q) => { q.cyl(w * 0.13, w * 0.1, h, 6, legColor, 0, -h / 2, 0); q.box(w * 0.24, h * 0.08, w * 0.22, '#2a1d14', w * 0.04, -h, 0); }, [x, h, z], role));
  }
  return { ...k.build(), parts: legs, size: len * 1.4 };
}

// A four-legged animal: a body turned on a lathe (deeper at the chest,
// rounded at the rump) with shoulders and haunches, a neck rising forward
// to a long head with eyes on its sides, a muzzle or a nose, ears of its
// kind, horns or antlers; jointed legs ending in hooves or paws (they walk:
// parts), and a tail of its kind (a horse's hanging hair, a cow's tuft, a
// goat's or deer's flag, a dog's or fox's brush, a rabbit's puff).
//   o: len, h (leg length), w (body width), color, belly, legColor, hoof,
//      neck, neckTilt, headR, headLen, muzzle, nose, ears ('point' | 'droop'
//      | 'side' | 'long'), horns ('cow' | 'goat' | 'antlers'), mane, tail
//      ('hair' | 'tuft' | 'flag' | 'brush' | 'puff'), tailColor, spots,
//      udder, beard, deep (the chest's depth)
function beast(T, o) {
  const k = new Kit(T);
  const hi = DETAIL >= 2;
  const { len, h, w, color, belly = color, legColor = color } = o;
  const R = w / 2; const deep = o.deep || 1.1; const seg = hi ? 10 : 7;
  const by = h + R * 0.35;                                              // the body's axis
  // Body: rump to chest, along x.
  const prof = [[0.001, 0], [0.45, 0.015], [0.62, 0.04], [0.9, 0.14], [0.95, 0.3], [0.88, 0.5], [0.92, 0.68], [1.0, 0.82], [0.82, 0.94], [0.4, 0.99], [0.001, 1.0]];
  k.lathe(prof.map(([r, t]) => [r * R, t * len]), seg + 4, color, -len / 2, by, 0, { rz: -Math.PI / 2, sx: deep, jitter: hi ? 0.03 : 0 });
  if (belly !== color) k.sphere(R * 0.8, belly, 0, by - R * deep * 0.45, 0, { sx: len / R * 0.42, sy: 0.4, sz: 0.95, seg, rings: seg >> 1 });
  for (const s of [1, -1]) {
    k.sphere(R * 0.55, color, len * 0.3, by - R * 0.15, s * R * 0.42, { sx: 1.1, sy: 1.5, sz: 0.8, seg, rings: seg >> 1 });     // shoulder
    k.sphere(R * 0.62, color, -len * 0.3, by - R * 0.05, s * R * 0.45, { sx: 1.3, sy: 1.5, sz: 0.8, seg, rings: seg >> 1 });    // haunch
  }
  if (o.spots) for (let i = 0; i < 6; i++) k.sphere(R * 0.55, o.spots, (i - 2.5) * len * 0.15, by + R * ((i % 3) - 1) * 0.3, (i % 2 ? 1 : -1) * R * 0.86, { sx: 1.3, sy: 0.9, sz: 0.25, seg: 10, rings: 6 });
  if (o.udder) { k.sphere(R * 0.32, o.udder, -len * 0.22, by - R * deep * 0.95, 0, { sx: 1.1, sy: 0.75, seg: 10, rings: 6 }); for (const [dx, dz] of [[-0.1, -0.12], [-0.1, 0.12], [0.1, -0.12], [0.1, 0.12]]) k.cyl(R * 0.04, R * 0.05, R * 0.18, 5, o.udder, -len * 0.22 + dx * R, by - R * deep * 1.17, dz * R); }

  // Neck and head: the neck from the chest, forward and up; the head angled down.
  const a = o.neckTilt ?? 0.75; const nl = o.neck ?? R * 0.6;
  const bx = len / 2 - R * 0.55, ny = by + R * 0.45;
  const tx = bx + Math.sin(a) * nl, ty = ny + Math.cos(a) * nl;
  k.cyl(R * 0.42, R * 0.62, nl + R * 0.5, seg, color, (bx + tx) / 2, (ny + ty) / 2, 0, { rz: -a });
  if (o.mane) { k.box(R * 0.14, nl + R * 0.6, R * 0.12, o.mane, (bx + tx) / 2 - R * 0.42 * Math.cos(a), (ny + ty) / 2 + R * 0.42 * Math.sin(a), 0, { rz: -a, jitter: 0.1 }); }
  const hr = w * (o.headR ?? 0.3), hl = o.headLen ?? 1.9, d = o.headDip ?? -0.55;
  const ax = Math.cos(d), ay = Math.sin(d);                             // along the head, towards the nose
  const hx = tx + ax * hr * hl * 0.5, hy = ty + ay * hr * hl * 0.5;
  k.sphere(hr, color, tx, ty, 0, { sx: 1.0, sy: 1.0, sz: 0.9, seg, rings: seg >> 1 });                          // the poll and cheeks
  k.sphere(hr * 0.86, color, hx, hy, 0, { sx: hl * 0.8, sz: 0.85, rz: d, seg, rings: seg >> 1 });              // the face
  const nx = tx + ax * hr * hl * 1.0, nyy = ty + ay * hr * hl * 1.0;
  if (o.nose) k.sphere(hr * 0.24, o.nose, nx + ax * hr * 0.25, nyy + ay * hr * 0.25, 0, { seg: 8, rings: 6 });  // a dog's, a cat's nose
  else { k.sphere(hr * 0.62, o.muzzle || shade(T, color, 0.55), nx, nyy, 0, { sx: 1.0, sy: 0.9, seg: 10, rings: 8 }); if (hi) for (const z of [0.25, -0.25]) k.sphere(hr * 0.12, '#140d08', nx + ax * hr * 0.5, nyy + ay * hr * 0.5 + hr * 0.1, z * hr, { seg: 6, rings: 4 }); }
  if (o.beard) k.cone(hr * 0.22, hr * 1.1, 6, o.beard, nx - ax * hr * 0.4, nyy - hr * 0.75, 0, { rz: Math.PI });
  for (const s of [1, -1]) {
    const ex = tx + ax * hr * 0.35, ey = ty + ay * hr * 0.35 + hr * 0.38;
    k.sphere(hr * 0.17, '#120c08', ex, ey, s * hr * 0.78, { seg: 8, rings: 6 });                                           // eyes
    if (hi) k.sphere(hr * 0.05, '#ffffff', ex + hr * 0.08, ey + hr * 0.06, s * hr * 0.9, { seg: 4, rings: 3, layer: 'glow' });
    const ear = o.ears || 'point';
    if (ear === 'point') k.cone(hr * 0.3, hr * 0.9, 6, color, tx - hr * 0.2, ty + hr * 1.05, s * hr * 0.55, { rx: s * 0.3 });
    if (ear === 'droop') k.sphere(hr * 0.42, shade(T, color, 0.8), tx - hr * 0.15, ty + hr * 0.15, s * hr * 1.0, { sx: 0.7, sy: 1.4, sz: 0.3, rx: s * 0.3, seg: 8, rings: 6 });
    if (ear === 'side') k.sphere(hr * 0.35, color, tx - hr * 0.2, ty + hr * 0.55, s * hr * 1.15, { sx: 0.55, sy: 0.35, sz: 1.3, seg: 8, rings: 6 });
    if (ear === 'long') k.capsule(hr * 0.22, hr * 2.0, color, tx - hr * 0.3, ty + hr * 1.7, s * hr * 0.35, { rx: s * 0.18, rz: 0.25, sz: 0.5, rseg: 8 });
    if (o.horns === 'cow') k.cone(hr * 0.16, hr * 1.4, 6, '#e8dcc0', tx - hr * 0.1, ty + hr * 1.0, s * hr * 1.3, { rx: s * 1.0 });
    if (o.horns === 'goat') k.cone(hr * 0.15, hr * 1.7, 6, '#6d5d4b', tx - hr * 0.6, ty + hr * 1.35, s * hr * 0.35, { rz: 0.9 });
    if (o.horns === 'antlers') {
      const at = '#6d4c2f'; const b0x = tx - hr * 0.1, b0y = ty + hr * 0.9, z0 = s * hr * 0.4;
      k.cyl(hr * 0.06, hr * 0.09, hr * 2.4, 6, at, b0x - hr * 0.2, b0y + hr * 1.1, z0 * 1.6, { rx: s * -0.45, rz: 0.2 });
      for (let i = 0; i < 3; i++) k.cyl(hr * 0.04, hr * 0.06, hr * 0.9, 5, at, b0x - hr * (0.05 + i * 0.15), b0y + hr * (0.8 + i * 0.6), z0 * (1.4 + i * 0.5), { rz: -0.7 + i * 0.1, rx: s * -0.3 });
    }
  }

  // Tail, from the top of the rump.
  const tc = o.tailColor || color; const rx0 = -len / 2 - R * 0.05, ry0 = by + R * 0.55;
  if (o.tail === 'hair') for (let i = 0; i < (hi ? 5 : 2); i++) k.capsule(R * 0.1, h * 0.75, tc, rx0 - R * 0.25 - i * R * 0.05, ry0 - h * 0.42, (i - 2) * R * 0.06, { rz: -0.25 - i * 0.03, rseg: 6 });
  if (o.tail === 'tuft') { k.cyl(R * 0.05, R * 0.06, h * 0.85, 5, tc, rx0 - R * 0.1, ry0 - h * 0.42, 0, { rz: -0.08 }); k.sphere(R * 0.14, shade(T, tc, 0.6), rx0 - R * 0.17, ry0 - h * 0.85, 0, { sy: 1.6, seg: 6, rings: 4 }); }
  if (o.tail === 'flag') { k.cone(R * 0.16, R * 0.75, 6, tc, rx0 - R * 0.2, ry0 + R * 0.15, 0, { rz: 0.6 }); if (o.tailUnder) k.cone(R * 0.12, R * 0.55, 6, o.tailUnder, rx0 - R * 0.18, ry0 + R * 0.05, 0, { rz: 0.6 }); }
  if (o.tail === 'brush') { k.capsule(R * (o.bushy ? 0.3 : 0.14), len * 0.42, tc, rx0 - len * 0.2, ry0 + R * 0.05, 0, { rz: 1.05, rseg: 8 }); if (o.tailTip) k.sphere(R * 0.24, o.tailTip, rx0 - len * 0.43, ry0 + R * 0.16, 0, { seg: 8, rings: 6 }); }
  if (o.tail === 'puff') k.sphere(R * 0.35, tc, rx0 - R * 0.1, ry0, 0, { seg: 8, rings: 6 });

  // Legs: a strong upper leg, a joint, a slender lower leg, a hoof or a paw.
  const hoof = o.hoof; const legs = [];
  for (const [x, z, role] of [[len * 0.3, R * 0.42, 'legL'], [len * 0.3, -R * 0.42, 'legR'], [-len * 0.3, R * 0.45, 'legR'], [-len * 0.3, -R * 0.45, 'legL']]) {
    legs.push(partOf(T, (q) => {
      const up = h * 0.5, lo = h * 0.44;
      limb(q, R * 0.3, R * 0.18, up, legColor, 0, 0, 0, seg);
      limb(q, R * 0.15, R * 0.12, lo, legColor, 0, -up, 0, seg);
      if (hoof) { q.cyl(R * 0.13, R * 0.16, h * 0.07, seg, hoof, 0, -h + h * 0.035, 0); if (hi && o.feather) q.cyl(R * 0.17, R * 0.15, h * 0.06, seg, o.feather, 0, -h + h * 0.1, 0); }
      else q.sphere(R * 0.17, shade(T, legColor, 0.85), R * 0.08, -h + R * 0.07, 0, { sx: 1.5, sy: 0.6, seg: 8, rings: 5 });
    }, [x, h, z], role));
  }
  return { ...k.build(), parts: legs, size: len * 1.4 };
}

// A hen: an egg-shaped body, a wing folded on each side, a fan of tail
// feathers, a comb and wattles, a beak, eyes, legs with toes.
function fowl(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#8d4a24');
  const dk = shade(T, c, 0.7);
  k.lathe([[0.001, 0], [0.11, 0.04], [0.16, 0.13], [0.15, 0.24], [0.1, 0.32], [0.001, 0.37]], 12, c, -0.2, 0.28, 0, { rz: -Math.PI / 2, sx: 0.95 });
  k.sphere(0.058, c, 0.15, 0.44, 0, { seg: 10, rings: 8 });                                      // head
  k.cyl(0.045, 0.06, 0.12, 8, c, 0.12, 0.37, 0, { rz: -0.4 });                                   // neck
  for (let i = 0; i < 3; i++) k.sphere(0.022, '#c62828', 0.12 + i * 0.025, 0.5 + (i === 1 ? 0.012 : 0), 0, { sz: 0.45, seg: 6, rings: 4 });   // comb
  k.sphere(0.02, '#c62828', 0.19, 0.38, 0, { sy: 1.4, sz: 0.5, seg: 6, rings: 4 });             // wattle
  k.cone(0.02, 0.05, 6, '#f9a825', 0.225, 0.43, 0, { rz: -Math.PI / 2 });                          // beak
  for (const z of [0.04, -0.04]) k.sphere(0.01, '#111', 0.17, 0.45, z, { seg: 5, rings: 4 });
  for (const z of [0.1, -0.1]) k.sphere(0.1, dk, -0.03, 0.29, z, { sx: 1.3, sy: 0.75, sz: 0.3, seg: 10, rings: 6 });   // wings
  for (let i = 0; i < 5; i++) k.box(0.03, 0.18, 0.06, i % 2 ? dk : '#2b2b2b', -0.2, 0.38 + i * 0.012, (i - 2) * 0.025, { rz: 0.5 + i * 0.05, rx: (i - 2) * 0.15 });   // tail feathers
  for (const z of [0.045, -0.045]) {
    k.cyl(0.012, 0.012, 0.14, 4, '#f9a825', 0.0, 0.08, z);
    for (const t of [-0.5, 0, 0.5]) k.box(0.05, 0.008, 0.01, '#f9a825', 0.025, 0.006, z + t * 0.02, { ry: t });
  }
  return { ...k.build(), parts: [], size: 0.5 };
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

// A row of windows round a block at height y: each a pane (lit at night),
// in a frame, over a sill.
function windowsRow(k, w, d, y, h, count, sides = 'all') {
  const glow = '#ffd98a'; const frame = '#e8e4dc'; const sill = '#bdb6aa';
  const pane = (x, z, pw, along) => {
    // along: 'x' (front and back walls) or 'z' (the sides); out: the outward sign
    for (const out of [1, -1]) {
      if (along === 'x') {
        const zz = out * (d / 2);
        k.box(pw + 0.16, h + 0.16, 0.05, frame, x, y, zz + out * 0.015);
        k.box(pw, h, 0.08, glow, x, y, zz + out * 0.03, { layer: 'glow' });
        k.box(pw + 0.1, 0.03, 0.06, frame, x, y, zz + out * 0.06);                                 // the transom
        k.box(pw + 0.3, 0.07, 0.2, sill, x, y - h / 2 - 0.1, zz + out * 0.09);
      } else {
        const xx = out * (w / 2);
        k.box(0.05, h + 0.16, pw + 0.16, frame, xx + out * 0.015, y, z);
        k.box(0.08, h, pw, glow, xx + out * 0.03, y, z, { layer: 'glow' });
        k.box(0.06, 0.03, pw + 0.1, frame, xx + out * 0.06, y, z);
        k.box(0.2, 0.07, pw + 0.3, sill, xx + out * 0.09, y - h / 2 - 0.1, z);
      }
    }
  };
  if (sides !== 'sides') for (let i = 0; i < count; i++) pane(-w / 2 + (i + 0.5) * (w / count), 0, w / count * 0.5, 'x');
  const m = Math.max(1, Math.round(count * d / w));
  for (let i = 0; i < m; i++) pane(0, -d / 2 + (i + 0.5) * (d / m), d / m * 0.5, 'z');
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
  k.box(0.08, 2.3, 1.4, '#efebe9', W / 2 + 0.02, 1.5, 0);                       // its frame
  k.sphere(0.04, '#c9a227', W / 2 + 0.12, 1.4, 0.38, { seg: 6, rings: 4 });     // handle
  k.box(0.12, 0.2, 0.14, '#fff3c4', W / 2 + 0.1, 2.75, 0.85, { layer: 'glow' }); // porch light
  k.box(1.6, 0.08, 1.8, roof, W / 2 + 0.7, 2.75, 0);                            // porch canopy
  for (const z of [D / 2 + 0.55, -D / 2 - 0.55]) k.cyl(0.07, 0.07, W + 0.8, 8, '#616161', 0, 0.4 + H - 0.05, z, { rz: Math.PI / 2 });   // gutters
  k.cyl(0.05, 0.05, H, 6, '#616161', W / 2 + 0.3, 0.4 + H / 2, D / 2 + 0.55);   // downpipe
  k.box(W + 1, 0.12, 0.16, '#5d4037', 0, 0.4 + H + D * 0.45, 0, { jitter: 0 }); // ridge
  k.box(0.1, 0.9, 0.9, '#fafafa', W / 2 + 6.5, 0.5, D / 2 - 0.8);               // letterbox post
  k.box(0.35, 0.25, 0.25, '#c62828', W / 2 + 6.5, 1.05, D / 2 - 0.8);
  k.box(0.6, 0.2, 1.6, '#9e9e9e', W / 2 + 0.4, 0.3, 0);                        // step
  for (let f = 0; f < floors; f++) windowsRow(k, W, D, 0.4 + 1.7 + f * 3.1, 1.1, 3);
  if (DETAIL >= 2) {
    // Roof tiles in rows down both slopes, a chimney cap, shutters by the front windows.
    const run = D / 2 + 0.6; const rise = D * 0.45; const slope = Math.hypot(run, rise); const ang = Math.atan2(rise, run);
    for (const sd of [1, -1]) for (let i = 0; i < 7; i++) {
      const t = (i + 0.5) / 7;
      k.box(W + 0.8, 0.07, slope / 7 + 0.05, i % 2 ? roof : `#${new T.Color(roof).multiplyScalar(0.85).getHexString()}`, 0, 0.4 + H + rise * (1 - t) + 0.06, sd * run * t, { rx: sd * ang });
    }
    k.box(1.5, 0.2, 1.5, '#5d4037', W * 0.25, 0.4 + H + 4.1, D * 0.18);
    for (let f = 0; f < floors; f++) for (const z of [-D / 3, D / 3]) for (const dz of [-0.95, 0.95]) k.box(0.06, 1.25, 0.45, '#2e5d3a', W / 2 + 0.08, 0.4 + 1.7 + f * 3.1, z + dz);
    // The garden: a picket fence along the front, flower beds, two bins.
    for (let z = -D / 2 - 1.5; z <= D / 2 + 1.5; z += 0.6) if (Math.abs(z) > 0.9) k.box(0.06, 0.9, 0.1, '#fafafa', W / 2 + 7.2, 0.45, z);
    for (const y of [0.35, 0.75]) for (const sz of [1, -1]) k.box(0.05, 0.08, D / 2 + 0.6, '#fafafa', W / 2 + 7.2, y, sz * (D / 4 + 1.05));
    for (let i = 0; i < 10; i++) k.ico(0.28, 0, ['#e91e63', '#ffeb3b', '#9c27b0', '#ff5722', '#ffffff'][(i + seed % 12) % 5], W / 2 + 1.4 + (i % 5) * 0.9, 0.35, (i < 5 ? 1 : -1) * (D / 2 - 0.6), { jitter: 0.06 });
    for (const [z, c2] of [[-D / 2 - 0.9, '#2e7d32'], [-D / 2 - 1.6, '#424242']]) { k.box(0.6, 1.0, 0.6, c2, W / 2 + 0.5, 0.5, z); k.box(0.65, 0.06, 0.65, c2, W / 2 + 0.5, 1.03, z); }
    // Some have a garage; some have solar panels on the roof.
    if (seed % 3 === 0 && !cabin) { k.box(6, 2.8, 4, wall, 0.5, 1.4, D / 2 + 2.6); k.box(6.4, 0.25, 4.4, roof, 0.5, 2.9, D / 2 + 2.6); k.box(0.06, 2.2, 3.2, '#cfd8dc', 3.52, 1.15, D / 2 + 2.6); for (let i = 0; i < 6; i++) k.box(0.07, 0.03, 3.2, '#9e9e9e', 3.55, 0.3 + i * 0.36, D / 2 + 2.6); }
    if (seed % 4 === 1 && !cabin) for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) k.box(1.6, 0.06, 1.0, '#1a237e', -W / 3 + i * 1.75, 0.4 + H + rise * 0.45 + j * 1.05 * Math.sin(ang) + 0.2, -run * 0.55 + j * 1.05 * Math.cos(ang), { rx: -ang });
  }
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
  if (DETAIL >= 2) {
    for (let f = 1; f < floors; f++) {
      const y = f * 3.2;
      k.box(0.05, 0.05, 12, '#616161', 12.55, y + 1.0, 0);                                       // the balcony rail
      for (let z = -5.8; z <= 5.8; z += 0.4) k.box(0.03, 1.0, 0.03, '#616161', 12.55, y + 0.5, z);
      for (const z of [-6, 6]) k.box(1.6, 1.0, 0.03, '#616161', 11.8, y + 0.5, z);
      if (f % 2) { k.box(0.6, 0.5, 0.8, '#e0e0e0', -11.3, y - 1.2, -4); k.cyl(0.2, 0.2, 0.05, 10, '#9e9e9e', -11.62, y - 1.2, -4, { rz: Math.PI / 2 }); }   // an air conditioner
      if (f % 3 === 0) k.box(1.0, 0.4, 0.06, '#5d4037', 11.05, y + 1.7, 4.5);                          // a window box
    }
    k.cyl(1.4, 1.4, 2.4, 14, '#90a4ae', -6, H + 3.2, -4); for (const [x, z] of [[-7, -5], [-5, -5], [-7, -3], [-5, -3]]) k.box(0.15, 1.6, 0.15, '#616161', x, H + 1.6, z);   // the water tank
    k.box(4, 0.25, 3, '#455a64', 13.2, 3.3, 0); for (const z of [-1.2, 1.2]) k.box(0.3, 0.2, 0.3, '#fff3c4', 13.2, 3.1, z, { layer: 'glow' });   // the entrance canopy
  }
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
  if (DETAIL >= 2) {
    // Mullions up every face, a lit crown, an entrance canopy, a helipad, planters.
    for (let t = -11.7; t <= 11.8; t += 2.6) { k.box(0.18, H, 0.18, '#cfd8dc', t, H / 2, 13.05); k.box(0.18, H, 0.18, '#cfd8dc', t, H / 2, -13.05); k.box(0.18, H, 0.18, '#cfd8dc', 13.05, H / 2, t); k.box(0.18, H, 0.18, '#cfd8dc', -13.05, H / 2, t); }
    for (const [x, z, w, d] of [[0, 10.1, 20.2, 0.15], [0, -10.1, 20.2, 0.15], [10.1, 0, 0.15, 20.2], [-10.1, 0, 0.15, 20.2]]) k.box(w, 0.35, d, '#b3e5fc', x, H + 3.6, z, { layer: 'glow' });
    k.box(5, 0.35, 10, '#37474f', 15.4, 4, 0); for (const z of [-3.5, 0, 3.5]) k.box(0.4, 0.15, 0.4, '#fff3c4', 15.4, 3.8, z, { layer: 'glow' });
    k.cyl(4.5, 4.5, 0.15, 24, '#455a64', 0, H + 7.1, 0); k.torus(3.6, 0.1, '#ffeb3b', 0, H + 7.2, 0, { rx: Math.PI / 2, tseg: 32 });
    for (const z of [-8, 8]) { k.box(1.6, 0.8, 1.6, '#795548', 15.5, 0.6, z); k.ico(0.9, 1, '#2e7d32', 15.5, 1.5, z); }
  }
  return out(k, { size: 32 });
}

const GOODS_OUT = ['#ef6c00', '#7cb342', '#c62828'];
// A two-storey shop (or cafe) on the street, its front to +x: a plinth,
// corner pilasters and a cornice, a lit shop window with mullions and a
// glazed door up a step, a striped awning on brackets, a lit sign, upper
// windows; a parapet with a roof unit and vent, a downpipe, a bench and
// planters, crates of goods or a cafe's tables with chairs, umbrellas, a menu
// board and a string of lights.
function shop(T, p, { cafe = false } = {}) {
  const k = new Kit(T);
  const c = col(p.color, '#f2e6b3');
  const trim = '#ece6d6'; const dark = '#3e2723';
  k.box(16, 6, 12, c, 0, 3, 0);
  k.box(16.3, 0.5, 12.3, '#8d8478', 0, 0.25, 0);                                  // plinth
  k.box(0.1, 3, 12, '#ffd98a', 8.05, 2, 0, { layer: 'glow' });                   // shop window
  k.box(0.08, 3.1, 12.2, dark, 8.03, 2, 0);                                      // the window's frame
  for (const z of [-3, 3]) k.box(0.1, 3, 0.12, dark, 8.09, 2, z);                // mullions
  k.box(0.14, 2.6, 1.6, '#4e342e', 8.07, 1.55, 4);                               // the door
  k.box(0.6, 0.18, 2.2, '#9e9e9e', 8.35, 0.09, 4);                               // its step
  for (let i = 0; i < 9; i++) k.box(3, 0.25, 13 / 9, i % 2 ? '#fafafa' : col(p.awning, '#c0392b'), 9.4, 4.4, -6.5 + (i + 0.5) * (13 / 9), { rz: -0.35 });   // striped awning
  k.box(0.32, 0.8, 7, cafe ? '#ffcc80' : '#80deea', 8.36, 5.4, 0, { layer: 'glow' });   // the sign, lit
  k.box(0.3, 1.2, 8, cafe ? '#6d4c41' : '#263238', 8.2, 5.4, 0);                // sign
  k.box(16.5, 0.5, 12.5, '#8d6e63', 0, 6.25, 0);
  k.box(0.6, 0.9, 1.2, '#455a64', 9, 0.45, -5);                                  // a bin
  if (!cafe) for (let i = 0; i < 3; i++) k.box(0.5, 0.5, 0.5, GOODS_OUT[i], 8.4, 0.25, -3.5 - i * 0.6);
  if (cafe) for (const z of [-3.5, 0, 3.5]) { k.cyl(0.6, 0.6, 0.06, 12, '#fafafa', 12, 1, z); k.cyl(0.05, 0.05, 1, 6, '#424242', 12, 0.5, z); k.cone(1.5, 1, 10, '#e53935', 12, 2.6, z); k.cyl(0.04, 0.04, 2.4, 5, '#bdbdbd', 12, 1.3, z); }
  if (DETAIL >= 2) {
    for (const z of [-6.05, 6.05]) k.box(16.4, 0.3, 0.3, trim, 0, 6.05, z);                               // cornice
    for (const x of [-8.05, 8.05]) for (const z of [-6.05, 6.05]) k.box(0.5, 6, 0.5, trim, x, 3, z);     // pilasters
    k.box(16.2, 0.8, 0.25, c, 0, 6.9, 6.1); k.box(16.2, 0.8, 0.25, c, 0, 6.9, -6.1); k.box(0.25, 0.8, 12.2, c, -8.1, 6.9, 0); k.box(0.25, 0.8, 12.2, c, 8.1, 6.9, 0);   // parapet
    k.box(2.4, 1.2, 1.6, '#b0bec5', -4, 7.1, -2); for (let i = 0; i < 5; i++) k.box(0.05, 1, 1.4, '#78909c', -2.78, 7.1, -2.6 + i * 0.3);   // roof unit
    k.cyl(0.25, 0.25, 1.2, 8, '#90a4ae', 3, 7.1, 3); k.cyl(0.35, 0.35, 0.1, 8, '#78909c', 3, 7.75, 3);
    k.cyl(0.08, 0.08, 6.2, 6, '#5d4037', 7.9, 3.1, -6.15);                                                   // downpipe
    for (const z of [-6.03, 6.03]) for (const x of [-5, -1, 3]) {                                              // the side walls' windows, upstairs
      k.box(1.9, 1.35, 0.06, trim, x, 4.5, z); k.box(1.7, 1.15, 0.08, '#ffd98a', x, 4.5, z * 1.003, { layer: 'glow' });
      k.box(0.06, 1.15, 0.1, trim, x, 4.5, z * 1.006); k.box(2.1, 0.08, 0.25, '#bdb6aa', x, 3.85, z * 1.01);
    }
    k.box(0.06, 2.2, 1.3, '#22313f', 8.1, 1.6, 4, { layer: 'glass' });                                        // the door's glass
    k.sphere(0.06, '#c9a227', 8.16, 1.4, 3.5, { seg: 6, rings: 4 });                                           // handle
    for (const z of [-4.5, -1.5, 1.5, 4.5]) { k.box(0.06, 1.1, 1.8, '#ffd98a', 8.03, 4.7, z, { layer: 'glow' }); k.box(0.12, 1.25, 1.95, trim, 8.0, 4.7, z); }   // upper windows
    for (let i = 0; i < 9; i++) k.box(0.08, 0.08, 1.4, '#424242', 8.2 + 0.6, 4.95 - 0.3, -6.5 + (i + 0.5) * (13 / 9), { rz: 0.9 });   // awning brackets
    for (const z of [-2, -1, 0, 1, 2]) k.box(0.04, 0.04, 0.8, '#ffffff', 8.12, 3.0, z * 2, {});                // lettering on the glass
    k.box(0.5, 0.45, 2.4, '#6d4c41', 9.2, 0.45, -1); for (const z of [-2, 0]) k.box(0.5, 0.05, 0.1, '#424242', 9.2, 0.22, z);   // a bench
    for (const z of [-5.8, 5.8]) { k.box(0.8, 0.6, 0.8, '#8d6e63', 8.8, 0.3, z); k.sphere(0.55, '#388e3c', 8.8, 0.9, z, { jitter: 0.2, seg: 8, rings: 6 }); }   // planters
    if (!cafe) for (let i = 0; i < 4; i++) { k.box(0.7, 0.4, 0.5, '#a1887f', 8.6, 0.2, -1.6 - i * 0.65); k.sphere(0.12, GOODS_OUT[i % 3], 8.6, 0.48, -1.6 - i * 0.65, { seg: 6, rings: 4 }); }   // crates of fruit
    if (cafe) {
      for (const z of [-3.5, 0, 3.5]) for (const dz of [-0.9, 0.9]) { k.box(0.45, 0.06, 0.45, '#5d4037', 12, 0.55, z + dz); k.box(0.06, 0.55, 0.45, '#5d4037', 12, 0.85, z + dz * 1.25); k.cyl(0.025, 0.025, 0.55, 4, '#424242', 12, 0.27, z + dz); }   // chairs
      k.box(0.08, 1.1, 0.7, '#212121', 9.5, 0.75, 5.2, { rz: 0.2 }); k.box(0.02, 0.8, 0.5, '#fafafa', 9.6, 0.85, 5.2, { rz: 0.2 });   // menu board
      for (let i = 0; i < 12; i++) k.sphere(0.06, '#ffe082', 10.4, 3.3 - Math.sin((i / 11) * Math.PI) * 0.4, -5.5 + i, { seg: 6, rings: 4, layer: 'glow' });   // string lights
    }
  }
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
  if (DETAIL >= 2) {
    for (const x of [-6, 22]) { k.cyl(0.08, 0.08, 3, 6, '#eceff1', x, 1.5, 22); k.box(0.1, 1, 1.6, '#fafafa', x + (x < 0 ? 0.3 : -0.3), 3, 22); k.torus(0.25, 0.03, '#ff5722', x + (x < 0 ? 0.6 : -0.6), 2.6, 22, { rx: Math.PI / 2, tseg: 12 }); }   // basketball hoops
    for (let i = 0; i < 3; i++) k.box(29.8, 0.02, 0.12, '#fafafa', 8, 0.07, 14 + i * 8);                  // court lines
    // The playground: swings and a slide.
    k.box(4, 0.15, 0.15, '#1565c0', -16, 2.5, -14); for (const x of [-18, -14]) for (const z of [-14.6, -13.4]) k.box(0.12, 2.6, 0.12, '#1565c0', x, 1.3, z, { rx: z < -14 ? 0.2 : -0.2 });
    for (const x of [-17, -15]) { k.box(0.6, 0.06, 0.3, '#ff7043', x, 0.6, -14); k.cyl(0.01, 0.01, 1.9, 4, '#9e9e9e', x, 1.55, -14); }
    k.box(0.6, 2, 0.6, '#ffca28', -10, 1, -14); k.box(3, 0.08, 0.8, '#ef5350', -8.6, 1.0, -14, { rz: -0.6 });
  }
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
  if (DETAIL >= 2) {
    // A plinth and cornice, ribs on the arched roof, the clock's face and
    // hands, a pitched cap on the clock tower; the platform's canopy on
    // columns, its yellow edge, benches, lamps and a sign; two tracks on
    // sleepers beyond it; an entrance with doors under an awning.
    k.box(50.4, 0.6, 18.4, '#8d8478', 0, 0.3, 0); k.box(50.4, 0.4, 18.4, '#e8e4dc', 0, 6.9, 0);
    for (let i = 0; i <= 12; i++) k.torus(9.55, 0.12, '#546e7a', -26 + i * (52 / 12), 7, 0, { ry: Math.PI / 2, sz: 0.5, tseg: 22, rseg: 4 });
    k.cyl(1.4, 1.4, 0.32, 20, '#fafafa', 28.15, 7, -7, { rz: Math.PI / 2 }); k.torus(1.45, 0.08, '#37474f', 28.3, 7, -7, { ry: Math.PI / 2, tseg: 24 });
    k.box(0.06, 0.9, 0.1, '#212121', 28.36, 7.35, -7); k.box(0.06, 0.1, 0.7, '#212121', 28.36, 7, -6.75);
    k.prism([[-2.4, 0], [2.4, 0], [0, 2.2]], 4.6, '#5d4037', 26, 9, -7, { ry: Math.PI / 2 });
    k.box(56, 0.3, 4.6, '#607d8b', 0, 5.2, 14.4); for (let i = 0; i < 8; i++) k.cyl(0.15, 0.15, 4.1, 8, '#455a64', -24 + i * (48 / 7), 3.1, 14.4);   // canopy
    k.box(60, 0.04, 0.4, '#fdd835', 0, 1.17, 16.8);
    for (let i = 0; i < 4; i++) { const x = -18 + i * 12; k.box(2, 0.1, 0.5, '#6d4c41', x, 1.6, 13); k.box(2, 0.5, 0.08, '#6d4c41', x, 1.9, 12.75); for (const d of [-0.8, 0.8]) k.box(0.08, 0.45, 0.45, '#424242', x + d, 1.35, 13); }
    for (const x of [-27, 27]) { k.cyl(0.08, 0.1, 4, 6, '#37474f', x, 3.1, 16); k.sphere(0.25, '#ffe082', x, 5.1, 16, { layer: 'glow' }); }
    k.box(4, 0.8, 0.12, '#1565c0', 0, 4.5, 16.3); k.box(3.6, 0.5, 0.14, '#ffffff', 0, 4.5, 16.3);
    for (const z of [18.6, 21.6]) { for (const dz of [-0.72, 0.72]) k.box(64, 0.15, 0.1, '#9e9e9e', 0, 0.35, z + dz); for (let i = 0; i < 40; i++) k.box(0.3, 0.12, 2.2, '#5d4037', -31.5 + i * 1.6, 0.22, z); }
    k.box(0.2, 3.4, 5, '#3e2723', 25.1, 1.9, 4); k.box(0.22, 2.8, 4.2, '#22313f', 25.15, 1.8, 4, { layer: 'glass' }); k.box(2, 0.25, 6.4, '#455a64', 26, 3.9, 4);
  }
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
  if (DETAIL >= 2) {
    // Loading docks with their shutters, pipes along the wall, a tank and a forklift.
    for (const z of [3, 7, 11]) { k.box(0.1, 3.6, 3, '#78909c', 20.06, 1.9, z); for (let i = 0; i < 8; i++) k.box(0.12, 0.05, 3, '#546e7a', 20.1, 0.3 + i * 0.45, z); k.box(1.4, 1.2, 3.4, '#616161', 20.7, 0.6, z); }
    for (const y of [7.5, 8.2]) k.cyl(0.25, 0.25, 38, 8, '#8d6e63', 0, y, -13.3, { rz: Math.PI / 2 });
    k.cyl(3, 3, 7, 18, '#cfd8dc', -24, 3.5, 6); k.cyl(3.05, 3.05, 0.3, 18, '#90a4ae', -24, 7.1, 6);
    k.box(2, 1.2, 1.1, '#fbc02d', 23, 0.9, -8); k.box(0.1, 2.4, 1, '#424242', 24.1, 1.4, -8);
  }
  return out(k, { size: 44, smoke: [[14, 26.5, 8], [18, 22.5, 8]] });
}

function barn(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#9b2d20');
  const white = '#f4f1ea';
  k.box(18, 8, 12, c, 0, 4, 0, { jitter: 0.08 });
  k.prism([[-6.5, 0], [6.5, 0], [4.5, 3], [0, 5], [-4.5, 3]], 18.6, '#4e342e', 0, 8, 0, { ry: Math.PI / 2 });
  k.box(0.2, 5, 5, '#fafafa', 9.05, 2.6, 0); k.box(0.22, 4.6, 0.3, '#fafafa', 9.07, 2.6, 0, { rx: 0.8 }); k.box(0.22, 4.6, 0.3, '#fafafa', 9.07, 2.6, 0, { rx: -0.8 });
  k.cyl(2.2, 2.2, 12, 14, '#b0bec5', -6, 6, -9); k.sphere(2.2, '#90a4ae', -6, 12, -9, { sy: 0.6 });
  if (DETAIL >= 2) {
    // Boards, white trim at the corners and under the eaves, the hayloft
    // door with bales and a hoist beam, small windows, a cupola with a vane;
    // bands on the silo with its ladder; bales and a fenced pen outside.
    for (let i = 0; i < 24; i++) { k.box(0.05, 8, 0.06, shade(T, c, 0.8), -9 + (i + 0.5) * 0.75, 4, 6.03); k.box(0.05, 8, 0.06, shade(T, c, 0.8), -9 + (i + 0.5) * 0.75, 4, -6.03); }
    for (const x of [-9, 9]) for (const z of [-6, 6]) k.box(0.35, 8, 0.35, white, x, 4, z);
    for (const z of [-6.05, 6.05]) k.box(18.4, 0.3, 0.12, white, 0, 7.9, z);
    k.box(0.25, 5.4, 5.4, white, 9.02, 2.6, 0);                                                  // the door's frame
    k.box(0.2, 2.2, 2.4, '#3e2723', 9.05, 10, 0); k.box(0.24, 2.5, 2.7, white, 9.02, 10, 0);   // hayloft door
    for (let i = 0; i < 3; i++) k.box(0.9, 0.5, 0.7, '#d4b05a', 8.6, 9.2 + i * 0.5, -0.5 + (i % 2) * 0.8, { jitter: 0.1 });
    k.box(2.2, 0.3, 0.3, '#5d4037', 10, 12.2, 0); k.cyl(0.02, 0.02, 2.5, 4, '#212121', 10.9, 11, 0);   // hoist beam and rope
    for (const x of [-5, 0, 5]) for (const z of [-6.04, 6.04]) { k.box(1.2, 1.0, 0.06, white, x, 5.6, z); k.box(1.0, 0.8, 0.08, '#2a2a2a', x, 5.6, z * 1.003, { layer: 'glass' }); }
    k.box(2, 1.8, 2, white, 0, 13.9, 0); k.prism([[-1.4, 0], [1.4, 0], [0, 1.2]], 2.6, '#4e342e', 0, 14.8, 0, { ry: Math.PI / 2 });   // cupola
    for (const z of [-0.6, 0.6]) k.box(0.1, 1.0, 0.5, '#2a2a2a', 1.02, 13.9, z, { layer: 'glass' });
    k.cyl(0.03, 0.03, 1.4, 4, '#424242', 0, 16.5, 0); k.box(0.9, 0.04, 0.04, '#424242', 0, 16.9, 0); k.cone(0.1, 0.3, 4, '#424242', 0.5, 16.9, 0, { rz: -Math.PI / 2 });   // weather vane
    for (let i = 0; i < 5; i++) k.torus(2.22, 0.05, '#78909c', -6, 1.5 + i * 2.2, -9, { rx: Math.PI / 2, tseg: 20, rseg: 4 });
    for (let i = 0; i < 12; i++) k.box(0.5, 0.04, 0.04, '#616161', -6, 0.6 + i, -6.75); for (const z of [-0.25, 0.25]) k.box(0.04, 12, 0.04, '#616161', -6 + z, 6, -6.75);   // ladder
    for (let i = 0; i < 4; i++) k.cyl(0.6, 0.6, 1.2, 12, '#d4b05a', 11 + (i % 2) * 1.3, 0.6, 7 + Math.floor(i / 2) * 1.3, { rx: Math.PI / 2 });   // round bales
    for (let i = 0; i < 6; i++) k.box(0.15, 1.2, 0.15, '#8d6e63', 10 + i * 2, 0.6, -10); k.box(10, 0.1, 0.08, '#8d6e63', 15, 0.9, -10); k.box(10, 0.1, 0.08, '#8d6e63', 15, 0.4, -10);   // the pen
  }
  return out(k, { size: 22 });
}

function hangar(T, p) {
  const k = new Kit(T);
  k.cyl(14, 14, 40, 24, col(p.color, '#b0b8c0'), 0, 0, 0, { rx: Math.PI / 2, open: false });
  k.box(30, 0.3, 40, '#9e9e9e', 0, 0.15, 0);
  k.box(0.2, 11, 20, '#455a64', 14.1, 5.5, 0);
  if (DETAIL >= 2) {
    // Ribs over the vault, the doors in panels on a rail, a gable wall with
    // a small door and windows, roof lights, a windsock.
    for (let i = 0; i <= 10; i++) k.torus(14.05, 0.18, '#78909c', 0, 0, -20 + i * 4, { tseg: 26, rseg: 4, arc: Math.PI });
    for (let i = 0; i < 5; i++) { k.box(0.24, 10.6, 3.8, i % 2 ? '#546e7a' : '#4f6470', 14.15, 5.5, -8 + i * 4); for (let j = 0; j < 4; j++) k.box(0.26, 0.06, 3.7, '#37474f', 14.2, 1.5 + j * 2.6, -8 + i * 4); }
    k.box(0.4, 0.4, 22, '#37474f', 14.2, 11.2, 0);
    for (const x of [-12, 12]) for (let i = 0; i < 3; i++) k.box(0.06, 1.2, 2, '#22313f', x > 0 ? 13.3 : -13.3, 6 + i * 0.01, -16 + i * 16, { layer: 'glass' });
    k.box(0.2, 2.4, 1.2, '#455a64', -14.05, 1.2, 8); k.box(0.2, 1.0, 2.0, '#22313f', -14.05, 4, -6, { layer: 'glass' });
    for (let i = 0; i < 4; i++) k.box(1.2, 0.08, 6, '#b3e5fc', 0, 14.02, -15 + i * 10, { layer: 'glass' });
    k.cyl(0.08, 0.08, 7, 6, '#9e9e9e', 18, 3.5, 22); k.cone(0.5, 2.2, 10, '#ff6d00', 19.1, 6.6, 22, { rz: Math.PI / 2 });
  }
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

// A pair of wheels on one axle: tyres with a tread band, rims with five
// spokes and a hub cap. Turns as one part ('wheel').
function wheelPair(T, x, y, z, r, w, color = '#1a1a1a', rim = '#c7ccd1') {
  return partOf(T, (q) => {
    for (const s of [1, -1]) {
      q.cyl(r, r, w, 20, color, 0, 0, s * z, { rx: Math.PI / 2 });
      q.cyl(r * 1.005, r * 1.005, w * 0.6, 20, '#262626', 0, 0, s * z, { rx: Math.PI / 2 });             // tread
      q.cyl(r * 0.62, r * 0.62, w + 0.02, 16, '#3a3a3a', 0, 0, s * z, { rx: Math.PI / 2 });              // the rim's well
      q.cyl(r * 0.58, r * 0.58, 0.02, 16, rim, 0, 0, s * (z + w / 2 + 0.005), { rx: Math.PI / 2 });     // the rim's face
      for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; q.box(r * 0.5, r * 0.11, 0.03, rim, Math.cos(a) * r * 0.27, Math.sin(a) * r * 0.27, s * (z + w / 2 + 0.02), { rz: a }); }
      q.cyl(r * 0.14, r * 0.14, 0.04, 10, '#9e9e9e', 0, 0, s * (z + w / 2 + 0.03), { rx: Math.PI / 2 });  // hub cap
      if (DETAIL >= 2) {
        for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; q.box(r * 0.12, 0.03, w * 0.85, '#202020', Math.cos(a) * r, Math.sin(a) * r, s * z, { rz: a + Math.PI / 2 }); }   // tread blocks
        q.cyl(r * 0.5, r * 0.5, 0.02, 16, '#8d8d8d', 0, 0, s * (z + w / 2 - 0.02), { rx: Math.PI / 2 });            // brake disc
        q.box(r * 0.3, r * 0.22, 0.05, '#c62828', r * 0.3, r * 0.25, s * (z + w / 2 - 0.01));                       // calliper
      }
    }
  }, [x, y, 0], 'wheel');
}

// Car body styles, from the side (x along the car, rear to front; y up):
// the lower body's outline, the glass cabin, the axles and the wheel size.
const CAR_STYLES = {
  saloon:    { lower: [[-2.27, 0.92], [-2.05, 1.0], [-1.25, 1.04], [1.05, 1.04], [2.05, 0.93], [2.27, 0.76]], cabin: [[-1.28, 1.03], [-0.95, 1.44], [0.32, 1.44], [1.07, 1.03]], ax: [1.38, -1.38], r: 0.36, W: 1.78, half: 2.25 },
  hatchback: { lower: [[-2.0, 0.95], [-1.95, 1.04], [0.95, 1.04], [1.85, 0.93], [2.02, 0.76]], cabin: [[-1.96, 1.03], [-1.8, 1.46], [0.25, 1.46], [0.98, 1.03]], ax: [1.25, -1.3], r: 0.34, W: 1.74, half: 2.0 },
  estate:    { lower: [[-2.33, 0.95], [-2.25, 1.04], [1.05, 1.04], [2.05, 0.93], [2.3, 0.76]], cabin: [[-2.24, 1.03], [-2.18, 1.47], [0.32, 1.47], [1.07, 1.03]], ax: [1.42, -1.42], r: 0.36, W: 1.8, half: 2.3 },
  suv:       { lower: [[-2.3, 1.12], [-2.22, 1.25], [1.05, 1.25], [2.05, 1.15], [2.3, 0.95]], cabin: [[-2.2, 1.24], [-2.1, 1.78], [0.4, 1.78], [1.1, 1.24]], ax: [1.45, -1.45], r: 0.44, W: 1.92, half: 2.3, clear: 0.48, rails: true },
  pickup:    { lower: [[-2.6, 1.05], [-0.7, 1.1], [1.15, 1.12], [2.25, 1.02], [2.5, 0.85]], cabin: [[-0.68, 1.1], [-0.6, 1.66], [0.4, 1.66], [1.15, 1.1]], ax: [1.6, -1.65], r: 0.42, W: 1.9, half: 2.55, clear: 0.45, bed: true },
  van:       { lower: [[-2.45, 1.0], [1.4, 1.0], [2.3, 0.95], [2.45, 0.78]], cabin: [[-2.42, 1.0], [-2.42, 2.05], [0.9, 2.05], [1.55, 1.0]], ax: [1.55, -1.6], r: 0.38, W: 1.95, half: 2.45, solid: true },
  sports:    { lower: [[-2.2, 0.82], [-2.05, 0.88], [-1.0, 0.9], [0.9, 0.9], [2.1, 0.72], [2.3, 0.58]], cabin: [[-1.05, 0.89], [-0.55, 1.2], [0.15, 1.2], [0.95, 0.89]], ax: [1.42, -1.35], r: 0.35, W: 1.86, half: 2.25, clear: 0.24, spoiler: true }
};
const CAR_ORDER = ['saloon', 'hatchback', 'estate', 'suv', 'pickup', 'van', 'sports'];
const STYLE_OF = { car: CAR_ORDER, taxi: ['saloon', 'estate', 'hatchback', 'suv'], police_car: ['saloon', 'estate', 'suv'] };
export const carStyle = (variant, seed) => { const list = STYLE_OF[variant === 'taxi' ? 'taxi' : variant === 'police' ? 'police_car' : 'car']; return list[seed % 7 % list.length]; };

// A car in one of seven body styles (saloon, hatchback, estate, SUV,
// pickup, van, sports): a shaped body cut away round the wheels, a glass
// cabin with pillars, bumpers, a grille, head and tail lights, door lines
// and handles, mirrors, number plates, an aerial; roof rails, a load bed or
// a spoiler where the style has them; a taxi's sign or a police car's
// stripes and light bar.
function car(T, p, seed, variant = 'car') {
  const k = new Kit(T);
  const name = carStyle(variant, seed); const S = CAR_STYLES[name];
  const paint = variant === 'taxi' ? '#f6c90e' : variant === 'police' ? '#f5f5f5' : col(p.color, pickBy(Math.floor((seed % 63) / 7), ['#c0392b', '#2c3e50', '#ecf0f1', '#2980b9', '#16a085', '#7f8c8d', '#8e44ad', '#d35400', '#1b1b1b']));
  const W = S.W; const trim = '#2b2b2b'; const chrome = '#cfd8dc'; const h = S.half; const r = S.r; const ay = r; const bottom = S.clear || 0.32;
  // The lower body, cut away round the wheels (the arches), extruded across the width.
  const arch = (cx) => Array.from({ length: 11 }, (_, i) => { const a = Math.PI - (i / 10) * Math.PI; return [cx + Math.cos(a) * (r + 0.09), ay + Math.sin(a) * (r + 0.09)]; });
  const [xf, xr] = S.ax;
  const outline = [[-h, bottom], [xr - r - 0.09, bottom], ...arch(xr), [xf - r - 0.09, bottom], ...arch(xf), [h, bottom], ...S.lower.slice().reverse()];
  k.prism(outline, W, paint, 0, 0, 0);
  // The cabin: glass, then roof and pillars (a van's sides are painted, with a window strip).
  const c = S.cabin; const roofY = c[1][1]; const roofA = c[1][0]; const roofB = c[2][0];
  k.prism(c, W - 0.14, '#1d2733', 0, 0, 0, { layer: 'glass' });
  if (S.solid) { k.prism([[c[0][0], c[0][1]], [c[1][0], c[1][1]], [roofB - 0.6, roofY], [roofB - 0.6, c[0][1]]], W - 0.1, paint, 0, 0, 0); k.box(1.6, 0.4, W - 0.08, '#1d2733', roofB - 2.3, roofY - 0.45, 0, { layer: 'glass' }); }
  k.box(roofB - roofA + 0.04, 0.06, W - 0.1, paint, (roofA + roofB) / 2, roofY + 0.025, 0);
  for (const z of [W / 2 - 0.08, -(W / 2 - 0.08)]) {
    const sz = Math.sign(z);
    const pil = (a, b, t = 0.07) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]); k.box(L, t, 0.06, paint, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z, { rz: Math.atan2(b[1] - a[1], b[0] - a[0]) }); };
    pil(c[3], c[2]); pil(c[0], c[1], 0.09);
    const bx = (roofA + roofB) / 2 - 0.1;
    k.box(0.09, roofY - c[0][1], 0.06, paint, bx, (roofY + c[0][1]) / 2, z);
    const beltY = c[0][1];
    for (const x of [c[3][0] - 0.45, bx, name === 'van' || name === 'pickup' || name === 'sports' ? null : c[0][0] + 0.1]) if (x !== null) k.box(0.012, beltY - bottom - 0.12, 0.01, '#1a1a1a', x, (beltY + bottom) / 2 + 0.03, z + sz * 0.08);
    for (const x of [bx + 0.5, name === 'sports' || name === 'pickup' ? null : bx - 0.45]) if (x !== null) k.box(0.16, 0.035, 0.02, chrome, x, beltY - 0.12, z + sz * 0.09);
    k.box(xf - xr - 2 * r - 0.3, 0.07, 0.03, trim, (xf + xr) / 2, bottom + 0.06, z + sz * 0.08);
    k.box(0.12, 0.1, 0.18, paint, c[3][0] - 0.15, beltY + 0.05, z + sz * 0.14); k.box(0.02, 0.08, 0.14, '#90a4ae', c[3][0] - 0.21, beltY + 0.05, z + sz * 0.15, { layer: 'glass' });
    if (S.rails) k.box(roofB - roofA - 0.2, 0.05, 0.05, '#212121', (roofA + roofB) / 2, roofY + 0.1, z - sz * 0.05);
  }
  // Dark wheel wells behind the arches.
  for (const x of S.ax) k.box(2 * r + 0.18, r + 0.14, W - 0.56, '#141414', x, ay + 0.2, 0);
  // A pickup's open load bed.
  if (S.bed) { k.box(1.85, 0.06, W - 0.1, '#3b3b3b', -1.65, 1.0, 0); for (const z of [W / 2 - 0.04, -(W / 2 - 0.04)]) k.box(1.9, 0.12, 0.05, paint, -1.65, 1.1, z); k.box(0.06, 0.4, W - 0.06, paint, -h + 0.04, 0.92, 0); }
  if (S.spoiler) { k.box(0.35, 0.04, W - 0.2, '#111', -h + 0.2, 1.02, 0); for (const z of [0.6, -0.6]) k.box(0.06, 0.14, 0.04, '#111', -h + 0.22, 0.94, z); }
  // Front and back: bumpers, grille, lights, indicators, plates.
  const front = S.lower[S.lower.length - 1]; const fy = Math.max(bottom + 0.3, front[1]);
  k.box(0.2, 0.2, W + 0.04, trim, h, bottom + 0.1, 0); k.box(0.2, 0.2, W + 0.04, trim, -h, bottom + 0.1, 0);
  k.box(0.03, 0.17, 0.78, '#111', h + 0.02, fy - 0.08, 0); for (let i = 0; i < 4; i++) k.box(0.035, 0.012, 0.74, '#555', h + 0.025, fy - 0.14 + i * 0.04, 0);
  for (const z of [W / 2 - 0.3, -(W / 2 - 0.3)]) {
    k.box(0.06, 0.12, 0.34, '#fff8e1', h - 0.01, fy + 0.04, z, { layer: 'glow' }); k.box(0.05, 0.14, 0.38, '#cfd8dc', h + 0.01, fy + 0.04, z, { layer: 'glass' });
    k.box(0.06, 0.12, 0.3, '#ff1744', -h - 0.02, S.lower[0][1] - 0.1, z, { layer: 'glow' });
    k.box(0.05, 0.06, 0.12, '#ffa000', h, bottom + 0.26, z * 1.15, { layer: 'glow' });
  }
  k.box(0.02, 0.11, 0.5, '#fafafa', h + 0.11, bottom + 0.12, 0); k.box(0.02, 0.11, 0.5, '#ffeb3b', -h - 0.11, bottom + 0.12, 0);
  k.box(0.021, 0.04, 0.36, '#212121', h + 0.115, bottom + 0.12, 0); k.box(0.021, 0.04, 0.36, '#212121', -h - 0.115, bottom + 0.12, 0);
  k.cyl(0.006, 0.006, 0.5, 4, '#212121', roofA - 0.1, roofY + 0.2, 0.5);
  if (DETAIL >= 2) {
    // Inside, seen through the glass: seats, a steering wheel, the dashboard.
    const beltY = c[0][1]; const seatY = beltY - 0.25; const dashX = c[3][0] - 0.3;
    for (const x of [dashX - 0.9, dashX - 1.8 > c[0][0] + 0.3 && !S.bed ? dashX - 1.8 : null]) if (x !== null) for (const z of (x === dashX - 0.9 ? [0.4, -0.4] : [0])) { k.box(0.5, 0.12, z ? 0.5 : W - 0.5, '#3e3e3e', x, seatY, z); k.box(0.12, 0.6, z ? 0.5 : W - 0.5, '#3e3e3e', x - 0.25, seatY + 0.3, z, { rz: -0.15 }); k.box(0.1, 0.2, z ? 0.3 : 0.3, '#4a4a4a', x - 0.3, seatY + 0.7, z); }
    k.box(0.4, 0.25, W - 0.3, '#2a2a2a', dashX + 0.1, beltY - 0.05, 0);
    k.torus(0.17, 0.025, '#1a1a1a', dashX - 0.25, beltY + 0.1, 0.4, { ry: Math.PI / 2, rz: 0.4, tseg: 16 });
    k.box(0.03, 0.06, 0.25, '#4fc3f7', dashX - 0.05, beltY + 0.12, -0.05, { layer: 'glow' });                    // the screen
    // Wipers, an exhaust, a fuel cap, a fin aerial, side indicators, a badge.
    for (const z of [0.25, -0.45]) k.box(0.03, 0.02, 0.6, '#111', c[3][0] - 0.05, c[3][1] + 0.03, z, { ry: 0.3 });
    k.cyl(0.04, 0.045, 0.25, 8, '#9e9e9e', -h - 0.05, bottom + 0.02, W / 2 - 0.35, { rz: Math.PI / 2 });
    k.cyl(0.09, 0.09, 0.02, 12, paint, xr + 0.55, c[0][1] - 0.2, -(W / 2 + 0.005), { rx: Math.PI / 2 });
    k.box(0.25, 0.07, 0.07, '#111', roofA + 0.15, roofY + 0.07, 0);
    for (const z of [W / 2 + 0.005, -(W / 2 + 0.005)]) k.box(0.1, 0.04, 0.02, '#ffa000', xf + r + 0.15, bottom + 0.42, z, { layer: 'glow' });
    k.cyl(0.07, 0.07, 0.02, 12, chrome, h + 0.035, fy - 0.08, 0, { rz: Math.PI / 2 });
    // Rear-window heater lines; roof bars on estates and SUVs; a sunroof on some.
    for (let i = 0; i < 4; i++) k.box(0.01, 0.005, W - 0.5, '#5d4037', c[0][0] + (c[1][0] - c[0][0]) * (0.3 + i * 0.15) + 0.02, c[0][1] + (c[1][1] - c[0][1]) * (0.3 + i * 0.15), 0, { layer: 'glass' });
    if (name === 'estate' || name === 'suv') for (const x of [roofA + 0.2, roofB - 0.2]) k.box(0.05, 0.05, W - 0.2, '#212121', x, roofY + 0.14, 0);
    if (seed % 63 % 5 === 2 && name !== 'van' && name !== 'pickup') k.box(0.7, 0.012, 0.8, '#1d2733', (roofA + roofB) / 2 + 0.1, roofY + 0.06, 0, { layer: 'glass' });
  }
  if (variant === 'taxi') { k.box(0.5, 0.18, 0.28, '#212121', (roofA + roofB) / 2, roofY + 0.12, 0); k.box(0.46, 0.14, 0.3, '#fff59d', (roofA + roofB) / 2, roofY + 0.13, 0, { layer: 'glow' }); k.box(2 * h - 0.2, 0.08, W + 0.03, '#212121', 0, c[0][1] - 0.18, 0); }
  if (variant === 'police') {
    k.box(2 * h * 0.58, 0.26, W + 0.03, '#1a237e', 0.1, c[0][1] - 0.32, 0);
    k.box(0.3, 0.1, 1.2, '#212121', (roofA + roofB) / 2, roofY + 0.08, 0); k.box(0.26, 0.12, 0.5, '#ff1744', (roofA + roofB) / 2, roofY + 0.14, 0.3, { layer: 'glow' }); k.box(0.26, 0.12, 0.5, '#2979ff', (roofA + roofB) / 2, roofY + 0.14, -0.3, { layer: 'glow' });
  }
  return { ...k.build(), parts: [wheelPair(T, xf, ay, W / 2 - 0.1, r, 0.24), wheelPair(T, xr, ay, W / 2 - 0.1, r, 0.24)], size: 2 * h + 0.5, style: name };
}

// A bus: rounded front, windows in pillars, doors, a lit destination sign,
// mirrors on arms, bumpers, wheel arches, a roof unit.
function bus(T, p, seed = 0) {
  const k = new Kit(T);
  const c = col(p.color, '#f1c40f');
  // One bus in three is a double-decker: an upper deck with its own windows.
  if (seed % 7 % 3 === 0) {
    k.box(11.6, 1.9, 2.55, c, -0.2, 3.95, 0);
    k.box(11.7, 0.85, 2.58, '#1d2733', -0.2, 4.1, 0, { layer: 'glass' });
    for (let i = 0; i < 8; i++) for (const z of [1.3, -1.3]) k.box(0.12, 0.85, 0.03, c, -5.4 + i * 1.5, 4.1, z);
    k.box(0.1, 0.9, 2.3, '#1d2733', 5.95, 4.15, 0, { layer: 'glass' });
    k.box(11.4, 0.12, 2.4, '#eeeeee', -0.2, 4.95, 0);
    for (let i = 0; i < 6; i++) k.box(1.3, 0.6, 0.05, '#ffe082', -4.5 + i * 1.8, 4.1, 1.27, { layer: 'glow' });
  }
  k.box(11.6, 2.5, 2.55, c, -0.2, 1.8, 0);
  for (const z of [1.2, -1.2]) k.cyl(0.08, 0.08, 2.5, 8, c, 5.95, 1.8, z);                                // rounded front corners
  k.box(11.7, 0.95, 2.58, '#1d2733', -0.2, 2.35, 0, { layer: 'glass' });
  for (let i = 0; i < 8; i++) for (const z of [1.3, -1.3]) k.box(0.12, 0.95, 0.03, c, -5.4 + i * 1.5, 2.35, z);   // window pillars
  k.box(0.1, 1.5, 2.3, '#1d2733', 6.0, 2.15, 0, { layer: 'glass' });
  k.box(1.2, 2.2, 0.04, '#263238', 4.4, 1.55, 1.29, { layer: 'glass' }); k.box(1.2, 2.2, 0.04, '#263238', -0.8, 1.55, 1.29, { layer: 'glass' });   // doors
  k.box(0.02, 2.2, 0.05, '#9e9e9e', 4.4, 1.55, 1.3); k.box(0.02, 2.2, 0.05, '#9e9e9e', -0.8, 1.55, 1.3);
  k.box(12.1, 0.3, 2.62, '#37474f', -0.1, 0.6, 0); k.box(0.25, 0.35, 2.6, '#263238', 6.1, 0.65, 0); k.box(0.25, 0.35, 2.6, '#263238', -6.15, 0.65, 0);
  k.box(0.1, 0.4, 1.7, '#111', 6.05, 3.15, 0); k.box(0.1, 0.28, 1.5, '#ff9800', 6.08, 3.15, 0, { layer: 'glow' });
  for (const z of [0.9, -0.9]) { k.box(0.08, 0.2, 0.38, '#fff8e1', 6.12, 0.85, z, { layer: 'glow' }); k.box(0.08, 0.25, 0.3, '#ff1744', -6.32, 1.0, z, { layer: 'glow' }); }
  for (const z of [1.45, -1.45]) { k.box(0.05, 0.05, 0.4, '#212121', 6.0, 2.9, z * 0.9); k.box(0.08, 0.45, 0.2, '#212121', 6.1, 2.65, z); }
  for (let i = 0; i < 6; i++) k.box(1.3, 0.7, 0.05, '#ffe082', -4.5 + i * 1.8, 2.3, 1.27, { layer: 'glow' });
  if (seed % 7 % 3 !== 0) k.box(2.6, 0.35, 1.6, '#cfd8dc', -2.5, 3.2, 0);                             // roof unit
  if (DETAIL >= 2) {
    // Seats in pairs either side of the aisle, grab rails, wipers, a lit route number, an exhaust.
    for (let i = 0; i < 9; i++) for (const z of [0.85, 0.4, -0.4, -0.85]) { const x = -5 + i * 1.1; k.box(0.45, 0.1, 0.42, '#1565c0', x, 1.15, z); k.box(0.1, 0.55, 0.42, '#1565c0', x - 0.2, 1.45, z); }
    for (const z of [0.15, -0.15]) k.cyl(0.02, 0.02, 10, 6, '#bdbdbd', 0, 2.75, z, { rz: Math.PI / 2 });
    for (let i = 0; i < 5; i++) k.cyl(0.02, 0.02, 1.6, 6, '#ffeb3b', -4 + i * 2, 1.85, 0.2);
    for (const z of [0.5, -0.5]) k.box(0.03, 0.02, 0.9, '#111', 6.07, 1.5, z, { rx: 0.3 });
    k.box(0.04, 0.24, 0.4, '#ff9800', 6.1, 3.15, -0.6, { layer: 'glow' }); k.box(0.04, 0.2, 0.4, '#ffe0b2', 6.1, 3.15, 0.6, { layer: 'glow' });
    k.cyl(0.06, 0.06, 0.3, 8, '#757575', -6.25, 0.55, 0.9, { rz: Math.PI / 2 });
  }

  return { ...k.build(), parts: [wheelPair(T, 4, 0.5, 1.12, 0.5, 0.32), wheelPair(T, -3.6, 0.5, 1.12, 0.5, 0.32)], size: 13 };
}
// A lorry: a cab with a windscreen, grille, bumper, steps and mirrors; a
// fuel tank; three axles; and one of three loads: a ribbed box body, a
// tank, or a flatbed with crates.
function truck(T, p, seed = 0) {
  const k = new Kit(T);
  const load = ['box', 'tanker', 'flatbed'][seed % 7 % 3];
  const c = col(p.color, '#ecf0f1'); const cab = '#c62828';
  k.box(2.3, 2.3, 2.45, cab, 3.35, 1.85, 0);
  k.box(0.6, 0.9, 2.45, cab, 4.7, 1.2, 0);
  k.prism([[2.2, 2.2], [4.2, 2.2], [4.5, 3.0], [2.2, 3.0]], 2.35, cab, 0, 0, 0);
  k.box(0.08, 0.9, 2.2, '#1d2733', 4.52, 2.45, 0, { layer: 'glass', rz: 0.3 });
  for (const z of [1.23, -1.23]) { k.box(1.1, 0.75, 0.03, '#1d2733', 3.6, 2.45, z, { layer: 'glass' }); k.box(0.06, 0.6, 0.15, '#212121', 4.6, 2.5, z * 1.12); k.box(0.5, 0.06, 0.3, '#9e9e9e', 4.0, 0.7, z); }
  k.box(0.04, 0.6, 1.5, '#111', 5.01, 1.2, 0); for (let i = 0; i < 5; i++) k.box(0.05, 0.03, 1.45, '#616161', 5.03, 0.95 + i * 0.12, 0);
  k.box(0.25, 0.3, 2.5, '#424242', 5.05, 0.6, 0);
  for (const z of [0.95, -0.95]) k.box(0.06, 0.2, 0.36, '#fff8e1', 5.06, 0.82, z, { layer: 'glow' });
  if (load === 'box') {
    k.box(6.4, 2.9, 2.5, c, -1.4, 2.25, 0);
    for (let i = 0; i < 11; i++) for (const z of [1.26, -1.26]) k.box(0.06, 2.8, 0.03, '#cfd8dc', -4.5 + i * 0.62, 2.25, z);   // ribs
  } else if (load === 'tanker') {
    k.capsule(1.15, 5.2, '#b0bec5', -1.4, 2.05, 0, { rz: Math.PI / 2, rseg: 18 });
    for (const x of [-3.6, -1.4, 0.8]) k.cyl(1.2, 1.2, 0.12, 18, '#78909c', x, 2.05, 0, { rz: Math.PI / 2 });
    k.box(5.6, 0.06, 0.5, '#616161', -1.4, 3.25, 0); k.cyl(0.25, 0.25, 0.2, 10, '#616161', -1.4, 3.3, 0);
    k.box(4, 0.4, 0.02, '#ff6f00', -1.4, 2.05, 1.16);
  } else {
    k.box(6.4, 0.15, 2.4, '#5d4037', -1.4, 0.95, 0);
    for (let i = 0; i < 6; i++) k.box(1.6, 1.1 + (i % 2) * 0.4, 1.0, ['#a1887f', '#8d6e63', '#795548'][i % 3], -4 + (i % 3) * 2.2, 1.6 + (i % 2) * 0.2, i < 3 ? 0.6 : -0.6);
    for (const z of [1.15, -1.15]) for (let i = 0; i < 5; i++) k.box(0.08, 0.6, 0.06, '#424242', -4.4 + i * 1.5, 1.3, z);
  }
  for (const z of [0.9, -0.9]) k.box(0.05, 0.25, 0.3, '#ff1744', -4.62, 0.9, z, { layer: 'glow' });
  k.box(9.4, 0.35, 2.2, '#263238', 0.3, 0.62, 0);
  k.cyl(0.32, 0.32, 1.2, 14, '#9e9e9e', 2.2, 0.85, 1.0, { rz: Math.PI / 2 });                        // fuel tank
  if (DETAIL >= 2) {
    // Exhaust stacks, air horns, a roof light bar, mud flaps, side guards, a sun visor.
    for (const z of [1.15, -1.15]) { k.cyl(0.09, 0.09, 2.6, 10, '#bdbdbd', 2.15, 2.4, z); k.cyl(0.1, 0.09, 0.12, 10, '#424242', 2.15, 3.75, z); }
    for (const z of [0.3, -0.3]) k.cone(0.07, 0.6, 10, '#cfd8dc', 3.6, 3.1, z, { rz: -Math.PI / 2 });
    k.box(0.3, 0.12, 1.8, '#212121', 3.9, 3.08, 0); for (let i = 0; i < 5; i++) k.box(0.05, 0.08, 0.2, '#ffb300', 4.06, 3.08, -0.7 + i * 0.35, { layer: 'glow' });
    k.box(0.35, 0.06, 2.3, cab, 4.55, 3.02, 0);
    for (const z of [1.0, -1.0]) for (const x of [-4.55, 2.75]) k.box(0.03, 0.5, 0.45, '#111', x, 0.35, z);
    for (const z of [1.18, -1.18]) for (let i = 0; i < 2; i++) k.box(4.2, 0.06, 0.04, '#9e9e9e', -0.9, 0.55 + i * 0.25, z);
  }
  return { ...k.build(), parts: [wheelPair(T, 3.4, 0.5, 1.1, 0.5, 0.32), wheelPair(T, -2.4, 0.5, 1.1, 0.5, 0.32), wheelPair(T, -3.6, 0.5, 1.1, 0.5, 0.32)], size: 10 };
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
    if (DETAIL >= 2) {
      k.cyl(0.05, 0.06, 0.9, 8, '#bdbdbd', -0.45, 0.42, 0.2, { rz: Math.PI / 2 - 0.15 }); k.cyl(0.065, 0.065, 0.2, 8, '#757575', -0.92, 0.48, 0.2, { rz: Math.PI / 2 });   // exhaust
      for (const z of [0.32, -0.32]) { k.cyl(0.01, 0.01, 0.25, 4, '#212121', 0.75, 1.25, z); k.box(0.02, 0.07, 0.1, '#90a4ae', 0.75, 1.38, z, { layer: 'glass' }); }   // mirrors
      k.box(0.3, 0.2, 0.42, c, 0.62, 0.5, 0, { rz: 0.3 }); k.box(0.12, 0.08, 0.08, '#ff1744', -0.75, 0.9, 0, { layer: 'glow' }); k.box(0.2, 0.1, 0.42, '#212121', 0.05, 1.0, 0);   // fairing, tail light, tank cap
    }
  } else {
    k.cyl(0.03, 0.03, 0.9, 6, c, 0.15, 0.62, 0, { rz: 1.0 });
    k.cyl(0.03, 0.03, 0.75, 6, c, -0.18, 0.6, 0, { rz: -0.45 });
    k.cyl(0.03, 0.03, 0.8, 6, c, 0.05, 0.85, 0, { rz: Math.PI / 2 });
    k.box(0.25, 0.06, 0.12, '#212121', -0.33, 0.96, 0);
    k.cyl(0.025, 0.025, 0.5, 6, '#9e9e9e', 0.5, 0.85, 0, { rz: -0.3 });
    k.box(0.05, 0.04, 0.55, '#212121', 0.55, 1.08, 0);
    if (DETAIL >= 2) {
      k.torus(0.1, 0.015, '#9e9e9e', 0, 0.34, 0.04, { tseg: 16 }); for (const sz of [1, -1]) { k.box(0.16, 0.012, 0.012, '#757575', 0, 0.34, sz * 0.08, { rz: 0.8 }); k.box(0.12, 0.03, 0.06, '#212121', sz * 0.11, 0.34 - sz * 0.08, sz * 0.12); }   // chainring and pedals
      k.box(0.56, 0.012, 0.012, '#424242', -0.27, 0.36, 0.04); k.box(0.56, 0.012, 0.012, '#424242', -0.27, 0.32, 0.04);   // the chain
      k.box(0.05, 0.05, 0.08, '#fff8e1', 0.58, 0.98, 0, { layer: 'glow' }); k.box(0.03, 0.04, 0.06, '#ff1744', -0.48, 0.7, 0, { layer: 'glow' });
      k.box(0.6, 0.02, 0.1, c, -0.42, 0.72, 0, { rz: 0.15 });                                                         // the rack
    }
  }
  const r = motor ? 0.32 : 0.34;
  const spokes = DETAIL >= 2 ? 12 : 4;
  const wheel = (x) => partOf(T, (q) => { q.torus(r, motor ? 0.08 : 0.03, '#1a1a1a', 0, 0, 0, { tseg: DETAIL >= 2 ? 28 : 18 }); q.cyl(0.04, 0.04, 0.06, 6, '#bdbdbd', 0, 0, 0, { rx: Math.PI / 2 }); if (!motor) for (let i = 0; i < spokes; i++) q.box(0.006, r * 2, 0.006, '#bdbdbd', 0, 0, 0, { rz: i * Math.PI / spokes }); else if (DETAIL >= 2) { q.cyl(r * 0.6, r * 0.6, 0.06, 18, '#424242', 0, 0, 0, { rx: Math.PI / 2 }); for (let i = 0; i < 5; i++) q.box(r * 0.55, 0.04, 0.07, '#9e9e9e', 0, 0, 0, { rz: i * Math.PI / 5 }); q.cyl(r * 0.45, r * 0.45, 0.02, 16, '#8d8d8d', 0, 0, 0.05, { rx: Math.PI / 2 }); } }, [x, r, 0], 'wheel');
  return { ...k.build(), parts: [wheel(motor ? 0.7 : 0.55), wheel(motor ? -0.7 : -0.5)], size: 2, seat: [motor ? -0.3 : -0.33, motor ? 1.0 : 0.98, 0] };
}
// A train: a locomotive with a sloped nose, windscreen and headlights, and
// three coaches with window bands, doors and gangways, all on bogies.
function train(T) {
  const k = new Kit(T);
  for (let i = 0; i < 4; i++) {
    const x = -i * 22;
    k.box(20, 3.6, 3, i ? '#eceff1' : '#c62828', x, 2.6, 0);
    k.box(19, 0.9, 3.05, '#22313f', x, 3, 0, { layer: 'glass' });
    k.box(20, 0.5, 2.8, '#37474f', x, 0.6, 0);
    if (DETAIL >= 2) {
      k.box(20.05, 0.25, 3.06, i ? '#c62828' : '#eceff1', x, 1.75, 0);                       // a stripe
      k.box(19.8, 0.3, 2.9, '#b0bec5', x, 4.55, 0, {});                                      // roof
      for (const d of [-6, 6]) for (const z of [1.53, -1.53]) { k.box(1.1, 2.4, 0.04, '#90a4ae', x + d, 2.3, z); k.box(0.04, 2.3, 0.05, '#455a64', x + d, 2.3, z * 1.01); }   // doors
      for (const d of [-7, 7]) for (const z of [1.1, -1.1]) {                                 // bogies
        k.box(2.6, 0.5, 0.3, '#263238', x + d, 0.55, z * 1.05);
        for (const w of [-0.75, 0.75]) k.cyl(0.42, 0.42, 0.18, 12, '#1a1a1a', x + d + w, 0.42, z * 1.18, { rx: Math.PI / 2 });
      }
      if (i) k.box(1.4, 3, 2.2, '#37474f', x + 10.7, 2.5, 0);                                // gangway
      if (i && i < 3) for (let j = 0; j < 2; j++) k.box(1.2, 0.4, 0.9, '#78909c', x - 4 + j * 8, 4.9, 0);   // roof vents
    }
  }
  k.box(1.5, 2, 3, '#c62828', 10.5, 2, 0, { rz: 0.4 });
  if (DETAIL >= 2) {
    k.box(0.08, 1.3, 2.6, '#22313f', 10.85, 3.5, 0, { layer: 'glass', rz: -0.5 });          // windscreen
    for (const z of [0.95, -0.95]) k.sphere(0.18, '#fff8e1', 11.05, 1.5, z, { layer: 'glow' });
    k.box(0.3, 0.3, 2.4, '#212121', 11.2, 0.6, 0);                                           // buffer beam
    k.box(1.6, 0.1, 0.1, '#424242', 0, 5.4, 0, { rz: 0.5 }); k.box(1.6, 0.1, 0.1, '#424242', 0.6, 5.4, 0, { rz: -0.5 }); k.box(0.2, 0.08, 1.6, '#424242', 0.3, 5.8, 0);   // pantograph
  }
  return out(k, { size: 90 });
}

function boat(T, p, { ship = false } = {}) {
  const k = new Kit(T);
  const c = col(p.color, ship ? '#2c3e50' : '#ffffff');
  const L = ship ? 60 : 7; const W = ship ? 11 : 2.6; const H = ship ? 7 : 1.2;
  k.prism([[-L / 2, H], [L / 2 + L * 0.12, H], [L / 2, 0], [-L / 2 + L * 0.05, 0]], W, c, 0, -H * 0.35, 0);
  k.box(L * 1.05, H * 0.08, W * 1.02, '#c62828', 0, -H * 0.3, 0);
  k.box(L, 0.15, W * 0.94, '#d7ccc8', 0, H * 0.66, 0);
  const deck = H * 0.66;
  if (ship) {
    k.box(16, 8, 9, '#fafafa', -14, deck + 4, 0);
    windowsRow(k, 16, 9, deck + 6, 1.2, 6);
    k.box(10, 3.5, 8, '#fafafa', -14, deck + 9.7, 0);
    k.cyl(1.8, 2.2, 7, 12, '#c62828', -22, deck + 11, 0);
    for (let i = 0; i < 4; i++) k.box(7, 4, 8, ['#e65100', '#1565c0', '#2e7d32', '#f9a825'][i], 4 + i * 7.5, deck + 2, 0);
    if (DETAIL >= 2) {
      // The bridge's wide windows and wings, a mast with radar and lights, a
      // band on the funnel; ribs on the containers and a second tier; rails,
      // lifeboats in davits, bollards, an anchor and a line of portholes.
      k.box(0.1, 1.4, 7.6, '#22313f', -8.95, deck + 10, 0, { layer: 'glass' });
      for (const z of [-5.2, 5.2]) k.box(3, 0.3, 1.6, '#fafafa', -10.5, deck + 8.1, z);
      k.cyl(0.15, 0.2, 6, 6, '#eceff1', -14, deck + 14.5, 0); k.box(0.4, 0.15, 3.2, '#37474f', -14, deck + 16.2, 0); k.box(0.3, 0.3, 0.3, '#ff5252', -14, deck + 17.5, 0, { layer: 'glow' });
      k.cyl(1.85, 1.85, 0.8, 12, '#212121', -22, deck + 13.6, 0);
      for (let i = 0; i < 4; i++) { const x = 4 + i * 7.5; for (let r = 0; r < 8; r++) for (const z of [-4.02, 4.02]) k.box(0.08, 3.8, 0.05, shade(T, ['#e65100', '#1565c0', '#2e7d32', '#f9a825'][i], 0.75), x - 3.2 + r * 0.9, deck + 2, z); }
      for (let i = 0; i < 3; i++) k.box(7, 4, 8, ['#00838f', '#6a1b9a', '#c62828'][i], 7.75 + i * 7.5, deck + 6.05, 0);
      for (const z of [-5.4, 5.4]) { k.cyl(0.05, 0.05, L * 0.95, 4, '#cfd8dc', 0, deck + 1, z, { rz: Math.PI / 2 }); for (let i = 0; i < 24; i++) k.cyl(0.04, 0.04, 1, 4, '#cfd8dc', -L * 0.46 + i * L * 0.04, deck + 0.5, z); }
      for (const z of [-5.6, 5.6]) { k.lathe([[0, 0], [0.9, 0.2], [0.95, 0.9], [0.7, 1.1]], 10, '#ff6f00', -18, deck + 5.5, z, { sx: 2.6 }); k.box(0.1, 1.6, 0.1, '#90a4ae', -20, deck + 6.6, z); k.box(0.1, 1.6, 0.1, '#90a4ae', -16, deck + 6.6, z); }
      for (const x of [-26, 24]) for (const z of [-3.5, 3.5]) k.cyl(0.3, 0.35, 0.6, 8, '#424242', x, deck + 0.4, z);
      k.box(0.5, 1.6, 1.2, '#37474f', L / 2 + 1.5, deck - 2, W / 2 + 0.05);
      for (let i = 0; i < 16; i++) for (const z of [W / 2 + 0.01, -W / 2 - 0.01]) k.cyl(0.22, 0.22, 0.05, 10, '#90a4ae', -27 + i * 1, deck - 0.9, z, { rx: Math.PI / 2 });
    }
  } else {
    k.box(2.2, 1.2, 1.8, '#fafafa', -0.6, deck + 0.6, 0);
    k.box(0.08, 0.7, 1.6, '#22313f', 0.52, deck + 0.9, 0, { layer: 'glass', rz: -0.5 });
    k.cyl(0.04, 0.04, 2.5, 5, '#bdbdbd', -1.2, deck + 1.8, 0);
    // Rails, cleats, a lifebuoy, an outboard motor, cabin windows.
    for (const z of [W / 2 - 0.05, -(W / 2 - 0.05)]) { k.cyl(0.025, 0.025, L * 0.75, 5, '#cfd8dc', L * 0.05, deck + 0.55, z, { rz: Math.PI / 2 }); for (let i = 0; i < 5; i++) k.cyl(0.02, 0.02, 0.5, 4, '#cfd8dc', -L * 0.3 + i * L * 0.17, deck + 0.3, z); k.box(0.04, 0.35, 0.9, '#22313f', -0.6, deck + 0.85, z * 1.0, { layer: 'glass' }); }
    k.torus(0.25, 0.06, '#ff5722', -0.6, deck + 0.7, -0.92, { tseg: 14 });
    k.box(0.5, 0.9, 0.4, '#212121', -L / 2 - 0.15, H * 0.4, 0); k.box(0.12, 0.6, 0.12, '#424242', -L / 2 - 0.2, -0.1, 0);
    if (DETAIL >= 2) {
      // A console with a wheel, two seats, a bench at the stern, fenders,
      // navigation lights (red to port, green to starboard), a bow rail.
      k.box(0.5, 0.8, 0.7, '#eceff1', 0.9, deck + 0.4, 0.4); k.torus(0.16, 0.025, '#212121', 1.12, deck + 0.95, 0.4, { ry: Math.PI / 2, tseg: 14, rot: 0 });
      for (const z of [0.5, -0.5]) { k.box(0.5, 0.12, 0.5, '#455a64', -0.1, deck + 0.45, z); k.box(0.1, 0.5, 0.5, '#455a64', -0.35, deck + 0.7, z); k.cyl(0.05, 0.05, 0.4, 6, '#9e9e9e', -0.1, deck + 0.2, z); }
      k.box(0.6, 0.35, W * 0.8, '#455a64', -L / 2 + 0.6, deck + 0.25, 0);
      for (const x of [-1.8, 0, 1.8]) for (const z of [W / 2 + 0.08, -W / 2 - 0.08]) k.cyl(0.11, 0.11, 0.45, 8, '#1565c0', x, deck - 0.2, z);
      k.sphere(0.07, '#ff1744', 1.6, deck + 0.6, -W / 2 + 0.1, { layer: 'glow' }); k.sphere(0.07, '#00e676', 1.6, deck + 0.6, W / 2 - 0.1, { layer: 'glow' });
      k.sphere(0.06, '#ffffff', -1.2, deck + 3.05, 0, { layer: 'glow' });
      k.box(L * 0.18, 0.08, 0.08, '#cfd8dc', L / 2 + L * 0.02, deck + 0.6, 0);
    }
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
  // Detail: doors, winglets, engine pylons and fans, gear legs, the belly fairing, a beacon.
  for (const z of [2.02, -2.02]) for (const x of [13.2, -13.4]) { k.box(1.0, 1.9, 0.03, '#b0bec5', x, 4.4, z); k.box(0.9, 1.8, 0.035, c, x, 4.4, z); }
  for (const s of [1, -1]) {
    k.box(1.2, 2.4, 0.25, liv, -4.6, 4.4, s * 17.2, { rx: s * -0.15 });
    k.box(3.2, 1.1, 0.35, '#cfd8dc', 3.4, 3.0, s * 6.5);
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; k.box(0.05, 0.75, 0.16, '#90a4ae', 5.72, 2.2 + Math.sin(a) * 0.4, s * 6.5 + Math.cos(a) * 0.4, { rx: a }); }
    k.cone(0.3, 0.6, 10, '#eceff1', 5.9, 2.2, s * 6.5, { rz: -Math.PI / 2 });
    k.cyl(0.12, 0.12, 2.6, 6, '#9e9e9e', -1, 1.9, s * 2.5);
  }
  k.cyl(0.12, 0.12, 2.6, 6, '#9e9e9e', 12, 1.9, 0);
  k.capsule(1.2, 8, '#eceff1', 0, 2.3, 0, { rz: Math.PI / 2, sz: 1.5 });
  k.sphere(0.22, '#ff1744', 0, 6.05, 0, { layer: 'glow', seg: 6, rings: 4 });
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
  if (DETAIL >= 2) {
    // An engine cowling and exhausts, a door with a window on each side, a
    // tailplane, the skids' upturned toes, a beacon, a step, a stripe.
    k.sphere(0.95, c, -0.6, 3.55, 0, { sx: 1.8, sy: 0.55, sz: 0.9 });
    for (const z of [0.35, -0.35]) k.cyl(0.12, 0.12, 0.6, 8, '#616161', -1.9, 3.55, z, { rz: Math.PI / 2 });
    for (const z of [1.38, -1.38]) { k.box(1.1, 1.0, 0.05, shade(T, c, 0.8), -0.7, 2.4, z); k.box(0.8, 0.5, 0.06, '#22313f', -0.7, 2.65, z * 1.01, { layer: 'glass' }); }
    k.box(0.9, 0.08, 2.0, c, -6.6, 2.85, 0);
    for (const s of [1, -1]) k.cyl(0.06, 0.06, 0.6, 6, '#424242', 2.25, 0.5, s * 1.1, { rz: -0.9 });
    k.sphere(0.1, '#ff1744', -1.5, 3.95, 0, { layer: 'glow' }); k.sphere(0.08, '#ffffff', -7.9, 4.2, 0, { layer: 'glow' });
    k.box(0.5, 0.06, 0.3, '#616161', 0.2, 1.1, 1.3);
    k.sphere(1.62, '#fafafa', 0, 2.3, 0, { sx: 1.6, sy: 0.12, sz: 1.01 });
  }
  const rotor = partOf(T, (q) => {
    if (DETAIL >= 2) { q.cyl(0.32, 0.32, 0.18, 10, '#424242', 0, 0, 0); for (let i = 0; i < 4; i++) q.box(5.4, 0.05, 0.36, '#212121', Math.cos((i * Math.PI) / 2) * 2.85, 0, Math.sin((i * Math.PI) / 2) * 2.85, { ry: -(i * Math.PI) / 2 }); }
    else { q.box(11, 0.06, 0.4, '#212121', 0, 0, 0); q.box(0.4, 0.06, 11, '#212121', 0, 0, 0); }
  }, [0, 4.35, 0], 'rotorY');
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

// A space station, built the way real ones are: a long truss carrying four
// pairs of solar wings (cells in a grid, on masts) and white radiators;
// pressurised modules in a line across it, joined by docking nodes with
// hatches, ending in a docking port with its lights and a windowed cupola;
// a dish and antennas; red and green navigation lights; and a habitat ring
// on four spokes that turns slowly (part 'ring'), its windows lit.
function spaceStation(T) {
  const k = new Kit(T);
  const WHITE = '#eceff1'; const GREY = '#b0bec5'; const DARK = '#455a64'; const GOLD = '#c9a227'; const CELL = '#1a237e';
  // The truss: four long rails with cross braces.
  for (const [y, z] of [[-1.2, -1.2], [-1.2, 1.2], [1.2, -1.2], [1.2, 1.2]]) k.box(80, 0.25, 0.25, GREY, 0, y, z);
  for (let x = -40; x <= 40; x += 4) { k.box(0.2, 2.6, 0.2, GREY, x, 0, 1.2); k.box(0.2, 2.6, 0.2, GREY, x, 0, -1.2); k.box(0.2, 0.2, 2.6, GREY, x, 1.2, 0); k.box(0.2, 0.2, 2.6, GREY, x, -1.2, 0); k.box(2.9, 0.12, 0.12, DARK, x + 2, 0, 1.2, { rz: 0.9 }); }
  // Solar wings: four pairs on masts at the truss ends, cells in a grid, gold backing.
  for (const x of [-34, -26, 26, 34]) for (const sz of [1, -1]) {
    const zc = sz * 19;
    k.cyl(0.2, 0.2, 34, 6, GREY, x, 0, zc - sz * 0.5, { rx: Math.PI / 2 });
    for (const dx of [-2.6, 2.6]) {
      k.box(4.6, 0.06, 32, GOLD, x + dx, -0.05, zc);
      k.box(4.4, 0.08, 31.6, CELL, x + dx, 0.02, zc);
      for (let i = 1; i < 16; i++) k.box(4.42, 0.1, 0.06, '#9fa8da', x + dx, 0.03, zc - 15.8 + i * 1.975);
      k.box(0.06, 0.1, 31.6, '#9fa8da', x + dx, 0.03, zc);
    }
    k.box(1.2, 1.2, 1.2, DARK, x, 0, sz * 2);                                    // the rotary joint
  }
  // Radiators: white panels standing off the truss.
  for (const x of [-14, 14]) for (const sz of [1, -1]) k.box(10, 0.1, 6, '#fafafa', x, -3.5, sz * 4.5, { rx: sz * 0.25 });
  // Modules in a line across the truss (along z), joined by nodes with hatches.
  const mod = (z, len, r = 2.1, c = WHITE) => { k.cyl(r, r, len, 20, c, 0, 3.6, z, { rx: Math.PI / 2 }); for (const dz of [-len / 2 + 0.5, len / 2 - 0.5]) k.cyl(r + 0.08, r + 0.08, 0.25, 20, GREY, 0, 3.6, z + dz, { rx: Math.PI / 2 }); for (let i = 0; i < Math.floor(len / 2); i++) k.box(0.5, 0.35, 0.06, '#ffe0a3', r * 0.72, 3.6 + r * 0.66, z - len / 2 + 1 + i * 2, { layer: 'glow' }); };
  const node = (z) => { k.sphere(2.5, WHITE, 0, 3.6, z, { seg: 18, rings: 12 }); for (const [x, y] of [[2.5, 0], [-2.5, 0], [0, 2.5]]) { k.cyl(1.0, 1.0, 0.4, 14, GREY, x, 3.6 + y, z, { rz: x ? Math.PI / 2 : 0 }); k.cyl(0.7, 0.7, 0.42, 14, DARK, x * 1.01, 3.6 + y * 1.01, z, { rz: x ? Math.PI / 2 : 0 }); } };
  k.cyl(1.4, 1.4, 3.4, 14, GREY, 0, 2.0, 0);                                     // the stand-off to the truss
  node(0); mod(-7.5, 10); node(-15); mod(-21.5, 8, 2.0, '#f5f5f5'); mod(7.5, 10, 2.2); node(15); mod(21, 7, 1.9);
  // The docking port at one end, with its ring and lights; the cupola at the other.
  k.cyl(1.2, 1.4, 1.6, 16, GREY, 0, 3.6, 25.3, { rx: Math.PI / 2 }); k.torus(1.25, 0.12, '#ffeb3b', 0, 3.6, 26.15, { tseg: 24 });
  for (let i = 0; i < 4; i++) k.sphere(0.12, '#fff59d', Math.cos(i * Math.PI / 2) * 1.5, 3.6 + Math.sin(i * Math.PI / 2) * 1.5, 26.2, { layer: 'glow', seg: 6, rings: 4 });
  k.cyl(1.3, 1.6, 1.0, 7, GREY, 0, 3.6, -26.2, { rx: Math.PI / 2 });
  for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; k.box(0.8, 0.5, 0.05, '#90caf9', Math.cos(a) * 1.35, 3.6 + Math.sin(a) * 1.35, -26.75, { layer: 'glass', rz: a }); }
  k.cyl(0.8, 0.8, 0.06, 14, '#90caf9', 0, 3.6, -26.75, { rx: Math.PI / 2, layer: 'glass' });
  // A dish and antennas.
  k.cyl(0.08, 0.08, 4, 6, GREY, 0, 7.6, -15); k.lathe([[0, 0], [1.6, 0.5], [1.8, 0.7]], 18, '#fafafa', 0, 9.4, -15, { rx: 0.6 });
  for (const z of [-7, 7]) k.cyl(0.04, 0.04, 5, 4, '#cfd8dc', 0, 8, z);
  // Navigation lights: red to port, green to starboard, white at the ends.
  k.sphere(0.3, '#ff1744', 0, 0, -40, { layer: 'glow', seg: 6, rings: 4 }); k.sphere(0.3, '#00e676', 0, 0, 40, { layer: 'glow', seg: 6, rings: 4 });
  for (const x of [-40, 40]) k.sphere(0.3, '#ffffff', x, 1.4, 0, { layer: 'glow', seg: 6, rings: 4 });
  // The habitat ring on four spokes round a hub below the truss; it turns.
  const ring = partOf(T, (q) => {
    q.torus(24, 2.3, WHITE, 0, 0, 0, { rx: Math.PI / 2, rseg: 12, tseg: 72 });
    for (let i = 0; i < 36; i++) { const a = (i / 36) * Math.PI * 2; q.box(1.2, 0.6, 0.06, '#ffe0a3', Math.cos(a) * 26.3, 0.6, Math.sin(a) * 26.3, { ry: -a + Math.PI / 2, layer: 'glow' }); }
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; q.cyl(0.6, 0.6, 22, 10, GREY, Math.cos(a) * 12, 0, Math.sin(a) * 12, { rz: Math.PI / 2, ry: -a }); }
    q.cyl(3, 3, 3, 18, GREY, 0, 0, 0);
  }, [0, -9, 0], 'ring');
  k.cyl(1, 1, 7, 12, GREY, 0, -5, 0);                                           // the axle down to the ring's hub
  return { ...k.build(), parts: [ring], size: 90 };
}
// A satellite: a gold-foiled body, two solar wings with cells, a dish, thrusters.
function satellite(T) {
  const k = new Kit(T);
  k.box(2, 2.2, 2, '#c9a227', 0, 0, 0, { jitter: 0.02 });
  k.box(2.05, 0.15, 2.05, '#9e9e9e', 0, 1.1, 0);
  for (const s of [1, -1]) {
    k.cyl(0.06, 0.06, 1.5, 6, '#bdbdbd', s * 1.75, 0, 0, { rz: Math.PI / 2 });
    k.box(6.5, 0.06, 2.2, '#1a237e', s * 5.8, 0, 0);
    for (let i = 1; i < 6; i++) k.box(0.05, 0.08, 2.2, '#9fa8da', s * (2.55 + i * 1.08), 0, 0);
  }
  k.cyl(0.05, 0.05, 1.2, 4, '#bdbdbd', 0, -1.6, 0); k.lathe([[0, 0], [0.9, 0.3], [1.0, 0.4]], 16, '#eceff1', 0, -2.4, 0, { rx: Math.PI });
  for (const [x, z] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) k.cone(0.12, 0.3, 8, '#616161', x, 1.3, z);
  k.sphere(0.12, '#ff1744', 0, 1.3, 0, { layer: 'glow', seg: 6, rings: 4 });
  return out(k, { size: 16, spin: 0.15 });
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
  if (DETAIL >= 2) {
    // Steps and a canopy over glass doors, a blue lamp on a post either side,
    // a flagpole, railings, a radio mast on the roof and two patrol cars' bays.
    for (let i = 0; i < 3; i++) k.box(2.4 - i * 0.5, 0.2, 7 - i * 0.6, '#bdbdbd', 12.6 + (2 - i) * 0.25, 0.1 + i * 0.2, 0);
    k.box(2.6, 0.25, 7.2, '#1a237e', 13.2, 3.6, 0); for (const z of [-3.3, 3.3]) k.cyl(0.1, 0.1, 3.5, 8, '#455a64', 14.3, 1.8, z);
    k.box(0.12, 2.8, 3.6, '#22313f', 12.05, 1.5, 0, { layer: 'glass' }); k.box(0.14, 2.8, 0.1, '#90a4ae', 12.07, 1.5, 0);
    for (const z of [-4.2, 4.2]) { k.cyl(0.07, 0.07, 2.8, 6, '#212121', 13.6, 1.4, z); k.box(0.5, 0.6, 0.5, '#2979ff', 13.6, 3.1, z, { layer: 'glow' }); }
    k.cyl(0.08, 0.08, 10, 6, '#eceff1', 14, 5, -7.5); k.box(0.05, 1.3, 2.2, '#1565c0', 14, 9.2, -6.4);
    for (let i = 0; i < 20; i++) k.cyl(0.03, 0.03, 1, 4, '#37474f', 12.8, 0.5, -8 + i * 0.84); k.cyl(0.04, 0.04, 16, 4, '#37474f', 12.8, 1, 0, { rx: Math.PI / 2 });
    k.cyl(0.1, 0.15, 6, 6, '#9e9e9e', -8, 11.8, -4); for (let i = 0; i < 3; i++) k.box(0.05, 0.05, 1.4 - i * 0.3, '#9e9e9e', -8, 12.5 + i * 1.4, -4);
  }
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
  // Gardens under the big dome, tunnels between domes, a solar farm, a landing pad, a rover.
  for (let i = 0; i < 9; i++) k.ico(0.9, 0, '#43a047', Math.cos(i * 0.7) * 3.5, 1.8, Math.sin(i * 0.7) * 3.5, { jitter: 0.2 });
  for (const [x, z] of [[9, 4], [-8, 5], [3, -9]]) { const L = Math.hypot(x, z) - 6; k.cyl(1.1, 1.1, L, 10, '#cfd8dc', x / 2, 1.4, z / 2, { rz: Math.PI / 2, ry: -Math.atan2(z, x) }); }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) k.box(2.4, 0.08, 1.4, '#1a237e', 18 + i * 2.7, 1.6, -8 + j * 1.8, { rz: -0.4 });
  k.cyl(5, 5, 0.3, 24, '#9e9e9e', -20, 1.1, 8); k.torus(4, 0.15, '#ffeb3b', -20, 1.3, 8, { rx: Math.PI / 2, tseg: 32 });
  k.box(2.4, 1, 1.5, '#eceff1', -14, 1.6, -14); for (const [x, z] of [[-13.2, -13.1], [-14.8, -13.1], [-13.2, -14.9], [-14.8, -14.9]]) k.cyl(0.35, 0.35, 0.3, 10, '#424242', x, 1.15, z, { rx: Math.PI / 2 });
  return out(k, { size: 46 });
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
// A cinema: a lit marquee ringed with bulbs, a vertical sign, posters in
// frames, glass doors under the marquee, a ticket booth, steps, a cornice
// and a tall auditorium block behind, with exits and a roof unit.
function cinema(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#5c2a3d');
  k.box(26, 11, 20, c, 0, 5.5, 0);
  k.box(1.6, 3, 22, '#212121', 13.6, 7, 0); k.box(1.62, 2.4, 21, '#fff176', 13.62, 7, 0, { layer: 'glow' });             // the marquee
  for (const z of [-6, 0, 6]) k.box(0.1, 3.4, 2.4, '#ef5350', 13.1, 3, z, { layer: 'glow' });                            // posters
  k.box(0.1, 3, 6, '#ffd98a', 13.06, 1.6, 0, { layer: 'glow' });
  if (DETAIL >= 2) {
    k.box(26.4, 0.6, 20.4, '#e8e4dc', 0, 11.1, 0); k.box(26.4, 0.5, 20.4, '#8d8478', 0, 0.25, 0);
    k.box(14, 6, 18, shade(T, c, 0.85), -6, 14, 0);                                                                  // the auditorium
    for (let i = 0; i < 22; i++) for (const y of [5.55, 8.45]) k.sphere(0.12, '#fff8e1', 14.45, y, -10.5 + i, { layer: 'glow', seg: 6, rings: 4 });   // bulbs
    for (const z of [-6, 0, 6]) k.box(0.16, 3.7, 2.7, '#c9a227', 13.05, 3, z);                                          // poster frames
    k.box(1.2, 9, 2.4, '#212121', 14.2, 15, 7.5); k.box(1.25, 8.4, 1.8, '#ff5252', 14.22, 15, 7.5, { layer: 'glow' }); // the vertical sign
    for (const z of [-2.2, 2.2]) { k.box(0.12, 2.6, 1.8, '#22313f', 13.12, 1.3, z, { layer: 'glass' }); k.box(0.14, 2.7, 0.1, '#c9a227', 13.13, 1.3, z - 0.9); }
    k.box(1.4, 2.2, 1.6, '#4a148c', 14, 1.1, -9); k.box(0.1, 0.8, 1.2, '#ffd98a', 14.72, 1.6, -9, { layer: 'glow' });  // ticket booth
    for (let i = 0; i < 3; i++) k.box(1.2 - i * 0.35, 0.18, 10, '#bdbdbd', 13.6 + (2 - i) * 0.35 - 0.35, 0.09 + i * 0.18, 0);   // steps
    for (const z of [-10.05, 10.05]) { k.box(1.6, 2.4, 0.08, '#37474f', -8, 1.2, z); k.box(0.8, 0.25, 0.1, '#00e676', -8, 2.7, z, { layer: 'glow' }); }   // exits
    k.box(3, 1.4, 2.4, '#b0bec5', -6, 17.7, -4);
  }
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
  if (DETAIL >= 2) {
    // Steps up to a portico of fluted columns on bases and capitals, an
    // entablature and a pediment with a tympanum, tall windows with
    // pediments, a cornice, lamps either side, a fly tower behind.
    for (let i = 0; i < 4; i++) k.box(6 - i * 1.2, 0.25, 23 - i * 0.4, '#d7ccc8', 14 + i * 0.6 + 0.2, 0.12 + i * 0.25, 0);
    for (let i = 0; i < 6; i++) { const z = -9 + i * 3.6; k.box(1.6, 0.4, 1.6, '#eceff1', 14, 1.2, z); k.box(1.7, 0.5, 1.7, '#eceff1', 14, 11.25, z); for (let f = 0; f < 8; f++) { const a = (f / 8) * Math.PI * 2; k.box(0.08, 9.4, 0.08, '#e0e0e0', 14 + Math.cos(a) * 0.62, 6, z + Math.sin(a) * 0.62); } }
    k.box(6.6, 0.8, 22.4, c, 14, 11.9, 0); k.box(6.8, 0.25, 22.6, '#fafafa', 14, 12.35, 0);
    k.prism([[-10.5, 0], [10.5, 0], [0, 3.3]], 0.3, shade(T, c, 0.88), 17.1, 12.45, 0, { ry: Math.PI / 2 });
    for (const y of [3.6, 9]) for (const z of [-8, -4, 4, 8]) { k.box(0.1, 3, 1.4, '#ffd98a', 12.03, y, z, { layer: 'glow' }); k.box(0.2, 3.3, 1.7, '#fafafa', 12.0, y, z); k.prism([[-1, 0], [1, 0], [0, 0.5]], 0.3, '#fafafa', 12.1, y + 1.8, z, { ry: Math.PI / 2 }); }
    for (const z of [-11.05, 11.05]) k.box(28.2, 0.5, 0.3, '#fafafa', -2, 13.8, z);
    for (const z of [-11.8, 11.8]) { k.cyl(0.1, 0.12, 3.6, 8, '#212121', 17.5, 1.8, z); k.sphere(0.35, '#fff8e1', 17.5, 3.8, z, { layer: 'glow' }); }
    k.box(10, 8, 16, shade(T, c, 0.9), -9, 18, 0);
  }
  return out(k, { size: 34 });
}
function bar(T, p) {
  const k = new Kit(T);
  const c = col(p.color, '#6d4c41');
  k.box(12, 5, 10, c, 0, 2.5, 0);
  k.box(0.1, 2, 7, '#ffcc80', 6.05, 2, 0, { layer: 'glow' });
  k.box(0.3, 1, 4, '#212121', 6.3, 4.4, 0); k.box(0.32, 0.7, 3.4, '#ff8a65', 6.35, 4.4, 0, { layer: 'glow' });
  for (const z of [-3, 0, 3]) { k.cyl(0.5, 0.5, 0.05, 10, '#8d6e63', 8.5, 1, z); k.cyl(0.05, 0.05, 1, 5, '#424242', 8.5, 0.5, z); }
  if (DETAIL >= 2) {
    // Boards on the walls, a framed window in panes, a door with a lamp
    // either side, barrels, stools, a chalkboard, a chimney, a parapet.
    for (let i = 0; i < 8; i++) for (const z of [-5.02, 5.02]) k.box(12, 0.04, 0.05, shade(T, c, 0.78), 0, 0.6 * (i + 1), z);
    k.box(0.06, 2.3, 7.3, '#3e2723', 6.0, 2, 0); for (const z of [-2.33, 2.33]) k.box(0.14, 2.1, 0.1, '#3e2723', 6.07, 2, z); k.box(0.14, 0.1, 7, '#3e2723', 6.07, 2.4, 0);
    k.box(0.14, 2.5, 1.3, '#4e342e', 6.06, 1.25, 4.2); k.sphere(0.05, '#c9a227', 6.15, 1.2, 3.7, { seg: 6, rings: 4 });
    for (const z of [3.3, 5.1]) { k.box(0.2, 0.35, 0.2, '#212121', 6.2, 3.0, z); k.sphere(0.1, '#ffe082', 6.25, 2.92, z, { layer: 'glow' }); }
    for (let i = 0; i < 3; i++) { k.cyl(0.38, 0.38, 0.9, 12, '#8d6e63', 7.1, 0.45, -4.4 + i * 0.85); for (const y of [0.15, 0.75]) k.torus(0.38, 0.025, '#424242', 7.1, y, -4.4 + i * 0.85, { rx: Math.PI / 2, tseg: 14, rseg: 3 }); }
    for (const z of [-3, 0, 3]) for (const dz of [-0.75, 0.75]) { k.cyl(0.18, 0.18, 0.05, 8, '#3e2723', 8.5, 0.75, z + dz); k.cyl(0.03, 0.03, 0.75, 4, '#424242', 8.5, 0.37, z + dz); }
    k.box(0.06, 1.2, 0.8, '#212121', 7.2, 0.9, 2.2, { rz: 0.2 }); k.box(0.02, 0.9, 0.6, '#e0e0e0', 7.3, 0.95, 2.2, { rz: 0.2 });
    k.box(1, 2, 1, '#8d6e63', -4, 5.8, -3); k.box(1.2, 0.2, 1.2, '#5d4037', -4, 6.85, -3);
    k.box(12.2, 0.6, 0.25, c, 0, 5.3, 5.05); k.box(12.2, 0.6, 0.25, c, 0, 5.3, -5.05); k.box(0.25, 0.6, 10.2, c, 6.05, 5.3, 0); k.box(0.25, 0.6, 10.2, c, -6.05, 5.3, 0);
  }
  return out(k, { size: 14 });
}
function stadium(T) {
  const k = new Kit(T);
  k.lathe([[46, 0], [52, 0], [56, 14], [55, 14.5], [44, 2]], 48, '#b0bec5', 0, 0, 0, { sz: 0.7 });
  k.cyl(44, 44, 0.3, 48, '#43a047', 0, 0.2, 0, { sz: 0.7 });
  for (let i = -3; i <= 3; i++) k.box(0.3, 0.32, 60, '#fafafa', i * 12, 0.36, 0);
  for (const [x, z] of [[50, 30], [-50, 30], [50, -30], [-50, -30]]) { k.cyl(0.4, 0.5, 30, 6, '#9e9e9e', x, 15, z); k.box(5, 2, 1, '#fffde7', x, 30, z, { layer: 'glow' }); }
  if (DETAIL >= 2) {
    // Tiers of seats in the bowl, a roof over each long side on masts,
    // goals, the centre circle, scoreboards, entrances and a ring of flags.
    for (let t = 0; t < 7; t++) k.lathe([[44.6 + t * 1.4, 1.5 + t * 1.6], [46 + t * 1.4, 1.5 + t * 1.6], [46 + t * 1.4, 3.1 + t * 1.6]], 64, t % 2 ? '#1565c0' : '#1976d2', 0, 0, 0, { sz: 0.7 });
    for (const z of [-1, 1]) { k.box(70, 0.5, 9, '#eceff1', 0, 17.5, z * 35, { rx: z * 0.18 }); for (let i = 0; i < 6; i++) k.cyl(0.35, 0.35, 17.5, 8, '#9e9e9e', -30 + i * 12, 8.75, z * 39.5); }
    for (const x of [-46, 46]) { for (const z of [-3.6, 3.6]) k.cyl(0.12, 0.12, 2.4, 6, '#fafafa', x * 0.86, 1.4, z); k.cyl(0.12, 0.12, 7.4, 6, '#fafafa', x * 0.86, 2.6, 0, { rx: Math.PI / 2 }); }
    k.torus(8, 0.15, '#fafafa', 0, 0.37, 0, { rx: Math.PI / 2, tseg: 40, rseg: 3 });
    for (const x of [-52, 52]) { k.box(1, 6, 12, '#212121', x, 18, 0); k.box(1.05, 5, 11, '#0d47a1', x * 1.002, 18, 0, { layer: 'glow' }); }
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; k.box(4, 4, 4, '#90a4ae', Math.cos(a) * 54, 2, Math.sin(a) * 54 * 0.7); }
    for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; const x = Math.cos(a) * 56; const z = Math.sin(a) * 56 * 0.7; k.cyl(0.06, 0.06, 5, 4, '#9e9e9e', x, 16.5, z); k.box(0.05, 1, 1.6, ['#e53935', '#fdd835', '#43a047', '#1e88e5'][i % 4], x, 18.4, z + 0.8); }
  }
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
  if (DETAIL >= 2) {
    // Fenders on the quay's face, a yellow edge line, stacked containers, a
    // warehouse's roller doors and roof, the crane's legs and hook, light towers.
    for (let x = 4; x < 120; x += 6) for (const z of [7.05, -7.05]) k.box(0.8, 1.4, 0.3, '#212121', x, 0.4, z);
    for (const z of [6.7, -6.7]) k.box(120, 0.04, 0.25, '#fdd835', 60, 1.42, z);
    for (let i = 0; i < 12; i++) k.box(6, 2.5, 2.4, ['#e65100', '#1565c0', '#2e7d32', '#c62828', '#6a1b9a', '#00838f'][i % 6], 30 + (i % 4) * 6.4, 2.65 + Math.floor(i / 8) * 2.55, -3 + Math.floor((i % 8) / 4) * 2.6);
    for (let i = 0; i < 3; i++) k.box(0.1, 5, 4, '#78909c', -1.95, 2.5, -5 + i * 5);
    k.prism([[-8.5, 0], [8.5, 0], [0, 3]], 25, '#607d8b', -14, 10, 0, { ry: Math.PI / 2 });
    for (const x of [86, 94]) for (const z of [-6, -2]) k.box(0.6, 24, 0.6, '#f9a825', x, 12, z);
    k.box(10, 1, 6, '#f9a825', 90, 24.5, -4); k.cyl(0.03, 0.03, 12, 4, '#212121', 76, 19, -4); k.box(1, 0.5, 2, '#424242', 76, 12.8, -4);
    for (const x of [20, 70, 110]) { k.cyl(0.25, 0.3, 16, 6, '#9e9e9e', x, 9, 5.5); k.box(2, 0.6, 0.6, '#fffde7', x, 17, 5.5, { layer: 'glow' }); }
  }
  return out(k, { size: 130 });
}
function monument(T, p) {
  const k = new Kit(T);
  k.box(6, 1, 6, '#9e9e9e', 0, 0.5, 0);
  k.prism([[-1.4, 0], [1.4, 0], [1, 14], [0, 16], [-1, 14]], 2.8, '#bcaaa4', 0, 1, 0);
  for (let i = 0; i < 6; i++) k.box(2.4, 0.18, 2.9, '#80deea', 0, 3 + i * 1.6, 0, { layer: 'glow' });
  if (DETAIL >= 2) {
    // A stepped plinth, a bronze plaque, a railing and four lamps round it.
    k.box(8, 0.4, 8, '#bdbdbd', 0, 0.2, 0); k.box(4, 0.6, 4, '#a1887f', 0, 1.3, 0);
    k.box(0.06, 0.8, 1.2, '#8d6e3f', 1.43, 2.6, 0);
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; k.cyl(0.03, 0.03, 0.9, 4, '#424242', Math.cos(a) * 4.6, 0.85, Math.sin(a) * 4.6); }
    k.torus(4.6, 0.04, '#424242', 0, 1.3, 0, { rx: Math.PI / 2, tseg: 32, rseg: 3 });
    for (const [x, z] of [[5.4, 5.4], [-5.4, 5.4], [5.4, -5.4], [-5.4, -5.4]]) { k.cyl(0.07, 0.09, 3, 6, '#212121', x, 1.5, z); k.sphere(0.25, '#fff8e1', x, 3.1, z, { layer: 'glow' }); }
  }
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
  if (DETAIL >= 2) {
    // A bridge with wide windows, a band on the funnel, a mast, rails on
    // every deck, lifeboats, a car deck's ramp at the bow and stern, a name band.
    k.box(6, 2, 8.6, '#fafafa', 6, 10.4, 0); k.box(0.1, 0.9, 8, '#22313f', 9.05, 10.6, 0, { layer: 'glass' });
    k.cyl(1.15, 1.15, 0.7, 12, '#212121', -12, 12.6, 0);
    k.cyl(0.1, 0.12, 5, 6, '#eceff1', 4, 13.8, 0); k.sphere(0.2, '#ffffff', 4, 16.3, 0, { layer: 'glow' });
    for (const [L, y, x, w] of [[42, 3.6, 2, 4.4], [28, 6.8, -2, 4.0], [18, 9.6, -4, 3.5]]) for (const z of [w, -w]) { k.cyl(0.04, 0.04, L, 4, '#cfd8dc', x, y + 0.9, z, { rz: Math.PI / 2 }); for (let i = 0; i < L / 1.5; i++) k.cyl(0.03, 0.03, 0.9, 4, '#cfd8dc', x - L / 2 + i * 1.5, y + 0.45, z); }
    for (const z of [-4.3, 4.3]) for (const x of [-10, -2]) k.lathe([[0, 0], [0.7, 0.15], [0.75, 0.7], [0.55, 0.85]], 10, '#ff6f00', x, 6.9, z, { sx: 3 });
    k.box(0.3, 3, 7, '#455a64', 23.2, 2.4, 0, { rz: 0.25 }); k.box(0.3, 3, 7, '#455a64', -19.6, 2.4, 0, { rz: -0.25 });
    for (let i = 0; i < 14; i++) for (const z of [4.52, -4.52]) k.cyl(0.25, 0.25, 0.05, 10, '#90a4ae', -14 + i * 2.6, 1.6, z, { rx: Math.PI / 2 });
  }
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
  if (DETAIL >= 2) {
    // Mullions over the glass, a canopy over the kerb with columns, doors,
    // gates numbered on the jet bridges, the tower's balcony and antennas.
    for (let i = 0; i <= 30; i++) for (const z of [-12.02, 12.02]) k.box(0.15, 9, 0.1, '#90a4ae', -30 + i * 2, 4.5, z);
    for (const y of [3, 6]) for (const z of [-12.03, 12.03]) k.box(60, 0.15, 0.1, '#90a4ae', 0, y, z);
    k.box(56, 0.4, 6, '#eceff1', 0, 5.2, -15); for (let i = 0; i < 8; i++) k.cyl(0.25, 0.25, 5, 8, '#b0bec5', -26 + i * (52 / 7), 2.5, -17.6);
    for (let i = 0; i < 6; i++) k.box(3, 2.8, 0.12, '#263238', -20 + i * 8, 1.4, -12.08, { layer: 'glass' });
    for (let i = 0; i < 4; i++) { k.box(2, 1.2, 0.1, '#1565c0', -22 + i * 15, 9, 12.1); k.box(1.4, 0.8, 0.12, '#ffffff', -22 + i * 15, 9, 12.12, { layer: 'glow' }); k.box(3.6, 3, 1.4, '#78909c', -22 + i * 15, 4.5, 31.4); k.box(0.3, 3.5, 0.3, '#455a64', -22 + i * 15, 1.6, 28); }
    k.cyl(5.6, 5.6, 0.3, 16, '#90a4ae', 34, 29.9, -6); k.cyl(5.7, 5.7, 1, 16, '#cfd8dc', 34, 30.4, -6, { open: true });
    for (const d of [-1.5, 1.5]) k.cyl(0.06, 0.06, 3, 4, '#9e9e9e', 34 + d, 35.5, -6);
  }
  return out(k, { size: 70 });
}
function barracks(T) {
  const k = new Kit(T);
  for (const z of [-10, 10]) { k.box(40, 6, 12, '#6b7d4e', 0, 3, z); k.prism([[-6.5, 0], [6.5, 0], [0, 3]], 41, '#3e4a2f', 0, 6, z, { ry: Math.PI / 2 }); windowsRow(k, 40, 12, 3.5, 1.2, 8, 'sides'); }
  k.box(30, 0.05, 6, '#9e9e9e', 0, 0.03, 0);                                     // parade ground
  for (const [x, z, w, d] of [[0, 24, 60, 0.3], [0, -24, 60, 0.3], [30, 0, 0.3, 48], [-30, 0, 0.3, 48]]) k.box(w, 2.4, d, '#9e9e9e', x, 1.2, z, { jitter: 0.2 });
  k.cyl(0.12, 0.12, 12, 6, '#eceff1', 18, 6, 0); k.box(0.05, 1.6, 2.6, '#c62828', 18, 11, 1.3);
  if (DETAIL >= 2) {
    // Doors and steps on each block, gutters, a guard post and barrier at the
    // gate, a lit sign, lamps round the parade ground, vehicles' sheds.
    for (const z of [-10, 10]) { for (const x of [-12, 0, 12]) { k.box(1.6, 2.4, 0.12, '#3e2723', x, 1.2, z + (z > 0 ? -6.06 : 6.06)); k.box(2.4, 0.3, 1.2, '#9e9e9e', x, 0.15, z + (z > 0 ? -6.6 : 6.6)); } for (const dz of [-6.2, 6.2]) k.cyl(0.12, 0.12, 40, 6, '#5d4037', 0, 5.9, z + dz, { rz: Math.PI / 2 }); }
    k.box(3, 3, 3, '#6b7d4e', 33, 1.5, 5); k.prism([[-1.8, 0], [1.8, 0], [0, 1.2]], 3.6, '#3e4a2f', 33, 3, 5, { ry: Math.PI / 2 }); k.box(0.1, 1, 1.6, '#22313f', 34.55, 2, 5, { layer: 'glass' });
    k.box(0.2, 0.2, 8, '#e53935', 31.5, 1.1, 0); k.cyl(0.25, 0.25, 1.1, 8, '#424242', 31.5, 0.55, -4);
    k.box(0.15, 1.2, 4, '#3e4a2f', 30.2, 1.8, -8); k.box(0.16, 0.9, 3.6, '#fff8e1', 30.25, 1.8, -8, { layer: 'glow' });
    for (const x of [-15, 15]) for (const z of [-3.5, 3.5]) { k.cyl(0.06, 0.08, 4, 6, '#37474f', x, 2, z); k.sphere(0.2, '#ffe082', x, 4.1, z, { layer: 'glow' }); }
    k.box(14, 4, 8, '#5a6b41', -20, 2, 22 - 4.5); k.box(13, 3.2, 0.12, '#2e3a22', -20, 1.6, 22 - 8.56);
  }
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
// A patrol boat: a flared hull with a waterline stripe and number, a
// wheelhouse with a band of windows, a mast with radar and lights, rails,
// fenders, life-raft canisters and a mounted searchlight.
function patrolBoat(T) {
  const k = new Kit(T);
  k.prism([[-9, 2.4], [11, 2.4], [9, 0], [-8.5, 0]], 4, '#78909c', 0, -0.8, 0);
  k.box(6, 2.2, 3, '#90a4ae', -1, 2.7, 0); k.box(0.08, 0.8, 2.6, '#22313f', 2.05, 3.1, 0, { layer: 'glass', rz: -0.4 });
  k.cyl(0.12, 0.12, 3.5, 5, '#b0bec5', -1, 5.4, 0); k.box(1.6, 0.6, 0.6, '#607d8b', 6, 2, 0);
  k.box(0.3, 0.3, 1.2, '#1565c0', -1, 7.1, 0, { layer: 'glow' });
  if (DETAIL >= 2) {
    k.box(20.2, 0.3, 4.05, '#37474f', 0.6, -0.55, 0);                                                    // waterline
    k.box(19.6, 0.12, 3.9, '#b0bec5', 0.5, 1.62, 0);                                                     // deck
    for (const z of [2.03, -2.03]) { k.box(3, 0.8, 0.04, '#fafafa', 5, 0.9, z); k.box(2.4, 0.5, 0.05, '#263238', 5, 0.9, z * 1.002); }   // the hull number's panel
    for (const z of [1.52, -1.52]) k.box(5.4, 0.5, 0.06, '#22313f', -1, 3.2, z, { layer: 'glass' });
    k.box(6.2, 0.15, 3.2, '#607d8b', -1, 3.85, 0);
    k.box(1.6, 0.1, 0.25, '#212121', -1, 6.2, 0); k.box(0.2, 0.3, 0.2, '#ff5252', -1, 6.8, 0.4, { layer: 'glow' });   // radar, a light
    for (const z of [1.85, -1.85]) { k.cyl(0.03, 0.03, 17, 4, '#cfd8dc', 0.5, 2.4, z, { rz: Math.PI / 2 }); for (let i = 0; i < 12; i++) k.cyl(0.03, 0.03, 0.8, 4, '#cfd8dc', -7.5 + i * 1.5, 2.0, z); }
    for (const x of [-6, -2, 3]) for (const z of [2.1, -2.1]) k.cyl(0.18, 0.18, 0.7, 8, '#212121', x, 1.0, z);
    for (const x of [-7, -5.5]) k.cyl(0.35, 0.35, 1.0, 10, '#eceff1', x, 2.2, 0, { rx: Math.PI / 2 });
    k.cyl(0.25, 0.3, 0.3, 10, '#455a64', 6, 2.45, 0); k.cyl(0.22, 0.18, 0.4, 10, '#263238', 6.3, 2.75, 0, { rz: Math.PI / 2 }); k.sphere(0.15, '#fff8e1', 6.52, 2.75, 0, { layer: 'glow' });
  }
  return out(k, { size: 20, wake: true });
}

function thing(T, kind, seed) {
  const k = new Kit(T);
  const c = ['#f3c623', '#36d1c4', '#8f86ff', '#3ddc84', '#ff9b7a'][seed % 5];
  k.box(1.2, 1.2, 1.2, c, 0, 0.6, 0); k.sphere(0.4, '#fafafa', 0, 1.5, 0);
  return out(k, { size: 2 });
}

// --- the factory ----------------------------------------------------------------------

const PROP_KEYS = ['color', 'roof', 'floors', 'length', 'width', 'size', 'shirt', 'livery', 'awning', 'lattice', 'built'];
export function modelKey(kind, p, id) {
  const b = baseKind(kind);
  const c = classOf(kind);
  const parts = PROP_KEYS.map((k) => (p && p[k] !== undefined ? `${k}=${p[k]}` : '')).join('|');
  // People and trees vary by id (skin, hair, greens), the rest by colours only.
  const vary = c === 'person' ? (hashOf(id) % 24) : b === 'house' ? (hashOf(id) % 12) : b === 'car' ? (hashOf(id) % 63) : ['taxi', 'police_car', 'bus', 'truck'].includes(b) ? (hashOf(id) % 7) : b === 'tree' || b === 'pine' || b === 'bush' || b === 'rock' || b === 'asteroid' ? (hashOf(id) % 6) : 0;
  // People dress by their country (the benin-warri template's), sex and rank.
  const who = c === 'person' ? `|${p && p.country}|${p && p.sex}|${p && p.royal ? 'r' : ''}` : '';
  return `${b}|${parts}|${vary}${who}|d${DETAIL}`;
}
// The benin-warri template's properties that change a model.
PROP_KEYS.push('radius', 'gates', 'shape', 'small');

// A crater at sea is drawn differently.
PROP_KEYS.push('sea');
export function buildModel(T, kind, p = {}, id = '') {
  const b = baseKind(kind);
  // Emergency services and the beach (rescue-models.js); a building going up is a scaffold.
  if (!(typeof p.built === 'number' && p.built < 100)) { const rescue = rescueModel(T, Kit, b, p, hashOf(id || kind), { partOf, wheelPair }); if (rescue) return rescue; }
  const seed = hashOf(id || kind);
  if (typeof p.built === 'number' && p.built < 100) return scaffold(T, b, p.built);
  if (b === 'porter' || b === 'visitor') return person(T, { sex: 'male', ...p }, seed, { visitor: b === 'visitor' });   // the template's porters and visitors are men
  const period = PERIOD_CLASS[b] ? periodModel(T, Kit, b, p, seed) : null;
  if (period) return period;
  switch (b) {
    case 'person': return person(T, p, seed);
    case 'child': return person(T, p, seed, { child: true });
    case 'astronaut': return person(T, p, seed, { astronaut: true });
    case 'dog': return beast(T, { len: 0.8, h: 0.4, w: 0.3, color: '#a1887f', belly: '#d7ccc8', neck: 0.14, neckTilt: 0.5, headR: 0.42, headLen: 1.5, headDip: -0.2, nose: '#1a1a1a', ears: 'droop', tail: 'brush', deep: 1.05 });
    case 'cat': return beast(T, { len: 0.5, h: 0.22, w: 0.2, color: '#ff9800', neck: 0.06, neckTilt: 0.4, headR: 0.5, headLen: 1.1, headDip: -0.1, nose: '#d81b60', ears: 'point', tail: 'brush', deep: 1.0 });
    case 'rabbit': return beast(T, { len: 0.42, h: 0.12, w: 0.24, color: '#bcaaa4', belly: '#efebe9', neck: 0.04, neckTilt: 0.3, headR: 0.42, headLen: 1.2, headDip: -0.2, nose: '#8d6e63', ears: 'long', tail: 'puff', tailColor: '#fafafa', deep: 1.15 });
    case 'fox': return beast(T, { len: 0.85, h: 0.36, w: 0.26, color: '#e65100', belly: '#fafafa', legColor: '#3e2723', neck: 0.12, neckTilt: 0.6, headR: 0.42, headLen: 1.7, headDip: -0.2, nose: '#1a1a1a', ears: 'point', tail: 'brush', bushy: true, tailTip: '#fafafa', deep: 1.0 });
    case 'deer': return beast(T, { len: 1.35, h: 0.85, w: 0.4, color: '#8d6e63', belly: '#d7ccc8', hoof: '#2a1d14', neck: 0.45, neckTilt: 0.35, headR: 0.36, headLen: 1.8, ears: 'point', horns: 'antlers', tail: 'flag', tailUnder: '#fafafa', deep: 1.1 });
    case 'horse': { const c = col(p.color, '#5d4037'); return beast(T, { len: 2.1, h: 1.15, w: 0.62, color: c, legColor: c === '#5d4037' ? '#4e342e' : c, hoof: '#2a2a2a', neck: 0.95, neckTilt: 0.5, headR: 0.3, headLen: 2.3, muzzle: shade(T, c, 0.7), ears: 'point', mane: '#1c1c1c', tail: 'hair', tailColor: '#1c1c1c', deep: 1.15 }); }
    // A cow with a colour of its own is a small forest beast (the benin-warri
    // template's), plain and short-legged; otherwise black and white.
    case 'cow': if (p.color) { const c = col(p.color, '#3e2723'); return beast(T, { len: 1.5, h: 0.62, w: 0.64, color: c, hoof: '#1a1a1a', neck: 0.3, neckTilt: 1.05, headR: 0.32, headLen: 1.7, ears: 'side', horns: 'cow', tail: 'tuft', deep: 1.2 }); }
      return beast(T, { len: 2.2, h: 0.85, w: 0.82, color: '#fafafa', spots: '#212121', hoof: '#2a2a2a', neck: 0.35, neckTilt: 1.1, headR: 0.3, headLen: 1.7, muzzle: '#f2b8a8', ears: 'side', horns: 'cow', tail: 'tuft', udder: '#f2b8a8', deep: 1.25 });
    case 'goat': { const c = col(p.color, '#e8e0d0'); return beast(T, { len: 0.8, h: 0.45, w: 0.32, color: c, hoof: '#2a2a2a', neck: 0.22, neckTilt: 0.45, headR: 0.36, headLen: 1.7, muzzle: shade(T, c, 0.85), ears: 'side', horns: 'goat', beard: shade(T, c, 0.8), tail: 'flag', deep: 1.15 }); }
    case 'fowl': return fowl(T, p);
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
    case 'bus': return bus(T, p, seed);
    case 'truck': return truck(T, p, seed);
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
