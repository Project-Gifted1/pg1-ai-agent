// PG1 Sandbox viewer: the kinds of the benin-warri template (c. 1610),
// modelled in code like the rest (no downloaded assets). The detail is
// generic to the time and place (earth walls laid in courses, thatch in
// tiers, verandas on posts, hearth stones and pots, a dugout canoe, a
// carrack's rig): it says what a thing is, not how a particular building
// looked, which the sources used do not describe (docs/sandbox-benin-warri.md).
//
//   PERIOD_CLASS                 kind -> class, merged into models.js KIND_CLASS
//   PERIOD_FIXED                 kinds that never move (batched as static)
//   periodModel(T, Kit, kind, p, seed) -> a model, or null for kinds not here

export const PERIOD_CLASS = Object.freeze({
  canoe: 'vehicle', carrack: 'vehicle', gate: 'structure', compound: 'building', palace: 'building', brass_workshop: 'building', ivory_workshop: 'building', fishing_village: 'building',
  shrine: 'structure', earthwork: 'structure', canoe_landing: 'structure', anchorage: 'structure', royal_tomb: 'structure', heritage_site: 'structure',
  mangrove: 'structure', forest: 'structure', river: 'structure', creek: 'structure', chronicle: 'structure', porter: 'person', visitor: 'person'
});
export const PERIOD_FIXED = Object.freeze(['gate', 'compound', 'palace', 'brass_workshop', 'ivory_workshop', 'fishing_village', 'shrine', 'earthwork', 'canoe_landing', 'anchorage', 'royal_tomb', 'heritage_site', 'mangrove', 'forest', 'river', 'creek', 'chronicle']);
// Drawn by waterways.js (or not at all), not as a model.
export const PERIOD_GROUND = Object.freeze(['mangrove', 'forest', 'river', 'creek', 'chronicle', 'anchorage']);

const EARTH = '#a0703c'; const EARTH_D = '#8a5d30'; const THATCH = '#b89a5a'; const THATCH_D = '#9c7f45'; const WOOD = '#6d4c2f'; const WOOD_D = '#4e3420';

// A round house of earth: a wall with courses, a doorway and a lintel, a
// thatch roof in tiers with a finial, a fire of three stones and a pot
// outside the door.
function hut(k, x, z, r, h, yaw = 0) {
  k.cyl(r, r * 1.04, h, 18, EARTH, x, h / 2, z, { jitter: 0.06 });
  for (let i = 1; i < 4; i++) k.cyl(r * 1.005, r * 1.005, 0.05, 18, EARTH_D, x, (h * i) / 4, z);
  for (let t = 0; t < 3; t++) k.cone(r * (1.42 - t * 0.28), h * (0.55 - t * 0.08), 18, t % 2 ? THATCH_D : THATCH, x, h + h * (0.2 + t * 0.32), z, { jitter: 0.12 });
  k.cyl(0.06, 0.1, h * 0.5, 6, WOOD_D, x, h * 2.05, z);
  const dx = Math.cos(yaw) * r; const dz = -Math.sin(yaw) * r;
  k.box(0.12, h * 0.68, r * 0.42, '#2a1d12', x + dx * 1.01, h * 0.34, z + dz * 1.01, { ry: yaw });
  k.box(0.2, 0.12, r * 0.55, WOOD, x + dx * 1.03, h * 0.7, z + dz * 1.03, { ry: yaw });
  for (let i = 0; i < 3; i++) { const a = i * 2.1; k.sphere(0.12, '#6d6d6d', x + dx * 1.6 + Math.cos(a) * 0.25, 0.08, z + dz * 1.6 + Math.sin(a) * 0.25, { seg: 6, rings: 4 }); }
  k.lathe([[0, 0], [0.22, 0.05], [0.28, 0.22], [0.18, 0.4], [0.2, 0.45]], 10, '#7a4a2a', x + dx * 1.6, 0.12, z + dz * 1.6);
}
// A rectangular enclosure of earth walls with courses and a capping of
// thatch, a gateway with posts and a wooden gate.
function enclosure(k, w, d, h, color, gate = 2.5) {
  const wall = (W, D, x, z) => { k.box(W, h, D, color, x, h / 2, z, { jitter: 0.05 }); for (let i = 1; i < 4; i++) k.box(W + 0.02, 0.06, D + 0.02, EARTH_D, x, (h * i) / 4, z); k.box(W + 0.2, 0.25, D + 0.5, THATCH, x, h + 0.1, z, { jitter: 0.1 }); };
  wall(w, 0.6, 0, -d / 2); wall(w, 0.6, 0, d / 2); wall(0.6, d, -w / 2, 0);
  wall(0.6, (d - gate) / 2, w / 2, -(d + gate) / 4); wall(0.6, (d - gate) / 2, w / 2, (d + gate) / 4);
  for (const z of [gate / 2 + 0.2, -gate / 2 - 0.2]) k.box(0.4, h + 0.6, 0.4, WOOD_D, w / 2, (h + 0.6) / 2, z);
  k.box(0.5, 0.3, gate + 1, WOOD_D, w / 2, h + 0.5, 0);
  k.box(0.12, h * 0.85, gate * 0.45, WOOD, w / 2 + 0.4, h * 0.43, gate * 0.27, { ry: 0.9 });
}
// A long hall: earth walls, a pitched thatch roof over a veranda on posts.
function hall(k, L, D, x, z, h = 3.2, ry = 0) {
  const g = { ry };
  k.box(L, h, D, EARTH, x, h / 2, z, { ...g, jitter: 0.04 });
  for (let i = 1; i < 3; i++) k.box(L + 0.02, 0.06, D + 0.02, EARTH_D, x, (h * i) / 3, z, g);
  k.prism([[-D / 2 - 1.6, 0], [D / 2 + 1.6, 0], [0, D * 0.55]], L + 1.2, THATCH, x, h, z, { ry: ry + Math.PI / 2 });
  const c = Math.cos(ry); const sn = Math.sin(ry);
  for (let t = -L / 2 + 0.6; t <= L / 2 - 0.5; t += 2.2) { const ox = t; const oz = D / 2 + 1.2; k.cyl(0.14, 0.16, h, 8, WOOD_D, x + ox * c + oz * sn, h / 2, z - ox * sn + oz * c); }
  for (let t = -L / 2 + 2; t < L / 2 - 1; t += 4) { const oz = D / 2 + 0.01; k.box(0.9, 2.1, 0.05, '#2a1d12', x + t * c + oz * sn, 1.05, z - t * sn + oz * c, g); }
}
const out = (k, extra) => ({ ...k.build(), parts: [], ...extra });

export function periodModel(T, Kit, kind, p = {}, seed = 0) {
  const k = new Kit(T);
  switch (kind) {
    case 'compound': {
      // A walled family compound: huts round a yard, a shelter over the
      // hearth, a granary on posts, mortars and pots, a goat pen.
      enclosure(k, 22, 20, 2.3, EARTH);
      hut(k, -5, -4, 3, 2.6, Math.PI / 4); hut(k, 5, 4, 2.6, 2.4, -2.6); hut(k, -4, 5.5, 2.2, 2.2, -Math.PI / 4);
      for (const [x, z] of [[4, -5], [6, -5], [4, -7], [6, -7]]) k.cyl(0.1, 0.1, 2.2, 6, WOOD_D, x, 1.1, z);
      k.prism([[-1.8, 0], [1.8, 0], [0, 1.1]], 2.8, THATCH, 5, 2.2, -6, { ry: Math.PI / 2 });
      k.cyl(0.9, 0.9, 1.2, 12, EARTH, 8, 1.2, 6); k.cone(1.2, 1.1, 12, THATCH, 8, 2.35, 6); for (const [x, z] of [[7.4, 5.4], [8.6, 5.4], [7.4, 6.6], [8.6, 6.6]]) k.cyl(0.08, 0.08, 0.6, 6, WOOD_D, x, 0.3, z);
      for (let i = 0; i < 4; i++) k.lathe([[0, 0], [0.25, 0.05], [0.32, 0.3], [0.2, 0.55], [0.22, 0.6]], 10, i % 2 ? '#7a4a2a' : '#5d3a1e', -1 + i * 0.7, 0, -8.6);
      k.cyl(0.3, 0.25, 0.6, 10, WOOD, 1.8, 0.3, 1); k.cyl(0.05, 0.05, 1.3, 6, WOOD_D, 1.8, 1.0, 1);
      for (let z = 2; z <= 6; z += 0.5) k.box(0.08, 1, 0.08, WOOD_D, -9.5, 0.5, z);
      return out(k, { size: 24 });
    }
    case 'palace': {
      // A large walled enclosure with inner courtyards: long halls with
      // verandas, an inner wall and gateway, and the yards between.
      const s = p.small ? 0.7 : 1;
      enclosure(k, 70 * s, 60 * s, 3.4, EARTH, 6);
      k.box(0.6, 3, 40 * s, EARTH, 6 * s, 1.5, 0, { jitter: 0.04 }); k.box(0.7, 3.6, 4, WOOD_D, 6 * s, 1.8, 0);
      hall(k, 30 * s, 8, -14 * s, -14 * s, 3.4); hall(k, 30 * s, 8, -14 * s, 14 * s, 3.4, Math.PI);
      hall(k, 18 * s, 7, 20 * s, -20 * s, 3); hall(k, 18 * s, 7, 20 * s, 20 * s, 3, Math.PI);
      hut(k, 24 * s, 0, 3.5, 3, 0); hut(k, -28 * s, 0, 3, 2.8, 0);
      k.box(26 * s, 0.05, 16 * s, '#b07a45', -14 * s, 0.03, 0);
      return out(k, { size: 72 * s });
    }
    case 'brass_workshop': case 'ivory_workshop': {
      // An open shelter on posts over the work: for brass, a furnace with
      // bellows, crucibles and moulds; for ivory, a bench, tusks and tools.
      for (const [x, z] of [[-5, -4], [5, -4], [-5, 4], [5, 4], [0, -4], [0, 4]]) k.cyl(0.18, 0.22, 3, 8, WOOD_D, x, 1.5, z);
      k.prism([[-5.5, 0], [5.5, 0], [0, 3]], 12, THATCH, 0, 3, 0, { ry: Math.PI / 2, jitter: 0.06 });
      k.box(12, 0.05, 10, '#8a6a46', 0, 0.03, 0);
      if (kind === 'brass_workshop') {
        k.cyl(1, 1.25, 1.1, 14, '#5d4037', 0, 0.55, 0); k.sphere(0.6, '#ff8f00', 0, 1.1, 0, { layer: 'glow' });
        for (const sx of [-1, 1]) { k.box(0.9, 0.3, 0.6, '#3e2723', sx * 1.9, 0.3, 0); k.cyl(0.06, 0.06, 0.9, 6, WOOD, sx * 1.9, 0.7, 0); }
        for (let i = 0; i < 5; i++) k.lathe([[0, 0], [0.18, 0.02], [0.22, 0.3], [0.2, 0.34]], 10, '#4e342e', -3 + i * 0.6, 0, 2.6);
        for (let i = 0; i < 4; i++) k.box(0.6, 0.5, 0.5, '#8d6e63', 2.5 + (i % 2) * 0.8, 0.25, -2.5 + Math.floor(i / 2) * 0.8);
      } else {
        k.box(3, 0.8, 1.2, WOOD, 0, 0.4, 0); for (let i = 0; i < 3; i++) k.cyl(0.08, 0.14, 1.4, 8, '#f3ead7', -0.8 + i * 0.8, 0.9, 0.1, { rz: Math.PI / 2 - 0.2 });
        for (let i = 0; i < 4; i++) k.cyl(0.13, 0.2, 1.8, 10, '#efe6d2', -3.5, 0.2 + i * 0.32, -2 + i * 0.25, { rz: Math.PI / 2, ry: 0.2 });
        for (let i = 0; i < 5; i++) k.box(0.3, 0.02, 0.04, '#9e9e9e', 1.6, 0.82, -0.4 + i * 0.2);
      }
      return out(k, { size: 14 });
    }
    case 'fishing_village': {
      // Huts by the water, racks of fish drying, nets on poles, canoes drawn up.
      for (let i = 0; i < 5; i++) hut(k, -10 + i * 5, (i % 2 ? 5 : -5), 2.2, 2.2, i % 2 ? -Math.PI / 2 : Math.PI / 2);
      k.box(26, 0.3, 2.5, WOOD, 0, 0.6, 11);
      for (let x = -12; x <= 12; x += 3) k.cyl(0.1, 0.1, 1.6, 6, WOOD_D, x, 0.1, 12.2);
      for (const x of [-6, 4]) { for (const dx of [-1.5, 1.5]) k.cyl(0.06, 0.06, 1.6, 6, WOOD_D, x + dx, 0.8, 1); k.box(3.2, 0.05, 0.06, WOOD_D, x, 1.55, 1); for (let i = 0; i < 8; i++) k.box(0.08, 0.35, 0.12, '#9e8c6a', x - 1.3 + i * 0.37, 1.35, 1); }
      for (const x of [9, 11]) k.cyl(0.05, 0.05, 2.4, 6, WOOD_D, x, 1.2, -1); k.box(2.2, 1.6, 0.02, '#cfc6a8', 10, 1.4, -1, { layer: 'glass' });
      for (const x of [-9, -4]) k.capsule(0.4, 5, WOOD, x, 0.3, 9, { rz: Math.PI / 2, sy: 0.55 });
      return out(k, { size: 30 });
    }
    case 'shrine': {
      // A low thatched shelter over an earth altar with pots and white chalk.
      for (const [x, z] of [[-1.6, -1.2], [1.6, -1.2], [-1.6, 1.2], [1.6, 1.2]]) k.cyl(0.08, 0.1, 2, 6, WOOD_D, x, 1, z);
      k.prism([[-1.8, 0], [1.8, 0], [0, 1.1]], 4, THATCH, 0, 2, 0, { ry: Math.PI / 2 });
      k.box(2.2, 0.9, 1.4, EARTH, 0, 0.45, 0); k.box(2, 0.15, 1.2, '#e0d6c2', 0, 0.98, 0);
      for (let i = 0; i < 3; i++) k.lathe([[0, 0], [0.12, 0.03], [0.15, 0.15], [0.1, 0.26]], 8, '#6d4127', -0.6 + i * 0.6, 1.05, 0);
      return out(k, { size: 5 });
    }
    case 'canoe_landing': {
      // A jetty on posts with mooring poles, a step down to the water, a shelter.
      k.box(14, 0.3, 3, WOOD, 4, 0.5, 0);
      for (let x = -2.5; x <= 11; x += 0.6) k.box(0.55, 0.05, 3.02, x % 1.2 ? WOOD : WOOD_D, x, 0.66, 0);
      for (let x = -2; x <= 10; x += 4) for (const z of [-1.2, 1.2]) k.cyl(0.16, 0.16, 2.2, 8, WOOD_D, x, 0.1, z);
      for (const x of [6, 10]) k.cyl(0.08, 0.1, 2.6, 6, WOOD_D, x, 1.3, 2);
      k.box(1.5, 0.15, 3, WOOD, 11.6, 0.2, 0);
      for (const [x, z] of [[-2, -1.5], [-2, 1.5], [1, -1.5], [1, 1.5]]) k.cyl(0.07, 0.07, 2.2, 6, WOOD_D, x, 1.8, z);
      k.prism([[-1.9, 0], [1.9, 0], [0, 1]], 3.6, THATCH, -0.5, 2.9, 0, { ry: Math.PI / 2 });
      return out(k, { size: 16 });
    }
    case 'royal_tomb': {
      // A burial grove: a low earth mound inside a ring of tall old trees.
      k.cyl(6, 7, 1.2, 24, '#7a5a35', 0, 0.6, 0, { jitter: 0.12 });
      k.cyl(4, 6, 0.6, 24, '#6b4c2c', 0, 1.4, 0, { jitter: 0.12 });
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2; const R = 11 + (i % 2) * 2; const x = Math.cos(a) * R; const z = Math.sin(a) * R; const h = 8 + (i % 3) * 2;
        k.cyl(0.4, 0.8, h, 8, '#5d4037', x, h / 2, z);
        for (let j = 0; j < 4; j++) k.ico(2.4 + (j % 2) * 0.8, 1, j % 2 ? '#2f5d2a' : '#27502a', x + Math.cos(j * 1.7) * 1.4, h + 0.4 + j * 0.6, z + Math.sin(j * 1.7) * 1.4, { jitter: 0.3 });
        for (let j = 0; j < 3; j++) k.box(1.2, 0.2, 0.2, '#4e342e', x + Math.cos(j * 2.1) * 0.8, 0.1, z + Math.sin(j * 2.1) * 0.8, { ry: j * 2.1 });   // roots
      }
      return out(k, { size: 32 });
    }
    case 'heritage_site': {
      // An open excavation: a trench marked out in a grid of string, spoil
      // heaps, and fragments of fired clay showing in the ground.
      k.box(10, 0.15, 8, '#8d6e63', 0, -0.05, 0);
      k.box(6, 0.6, 4, '#6d4c41', 0, -0.25, 0);
      for (let x = -3; x <= 3; x += 1.5) k.box(0.02, 0.02, 4.2, '#fafafa', x, 0.12, 0);
      for (let z = -2; z <= 2; z += 1) k.box(6.2, 0.02, 0.02, '#fafafa', 0, 0.12, z);
      for (const [x, z] of [[-3, -2], [3, -2], [-3, 2], [3, 2]]) k.cyl(0.03, 0.03, 0.5, 4, WOOD, x, 0.25, z);
      for (let i = 0; i < 10; i++) k.ico(0.15 + (i % 3) * 0.08, 0, '#bf7046', -2.5 + i * 0.55, 0.06, (i % 2) - 0.5, { jitter: 0.3 });
      for (const x of [-5.5, 5.5]) k.cone(1.4, 1, 10, '#7a5a40', x, 0.5, 3.2, { jitter: 0.2 });
      return out(k, { size: 12 });
    }
    case 'earthwork': {
      // Rampart (sloped earth) and ditch: a ring with gaps for its gates, or
      // a straight run (shape 'line', a length) joining enclosures. A city's
      // is taller and deeper than a village's (size 'small').
      const f = p.size === 'small' ? 0.55 : 1;
      const bank = [[-6 * f, 0], [6 * f, 0], [2.2 * f, 6.5 * f], [-2.2 * f, 6.5 * f]]; const ditch = [[-5 * f, 0], [5 * f, 0], [3 * f, -3 * f], [-3 * f, -3 * f]];
      const piece = (x, z, ry, L, i) => {
        const c = Math.cos(ry); const s2 = Math.sin(ry);
        k.prism(bank, L, i % 2 ? '#8a5a32' : '#83552f', x, 0, z, { ry, jitter: 0.08 });
        k.prism(ditch, L, '#4e3420', x + c * 11 * f, 0.05, z - s2 * 11 * f, { ry });
        if (i % 3 === 0) k.ico(0.9 * f, 0, '#5d7a34', x + c * 4 * f, 1.0 * f, z - s2 * 4 * f, { jitter: 0.3 });   // growth on the bank
      };
      if (p.shape === 'line') {
        const len = Math.max(20, Math.min(3000, Number(p.length) || 200)); const n = Math.max(2, Math.round(len / 12));
        for (let i = 0; i < n; i++) piece(-len / 2 + (i + 0.5) * (len / n), 0, Math.PI / 2, len / n + 0.4, i);
        return out(k, { size: len });
      }
      const R = Math.max(50, Math.min(3000, Number(p.radius) || 650)); const gates = Math.max(0, Math.min(12, Math.round(Number(p.gates) || 0)));
      const n = Math.max(24, Math.round((2 * Math.PI * R) / 12));
      const gap = 8 / R;   // a gateway about 16 m wide
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        if (gates && Array.from({ length: gates }, (_, g) => (g / gates) * Math.PI * 2).some((ga) => Math.abs(Math.atan2(Math.sin(a - ga), Math.cos(a - ga))) < gap)) continue;
        piece(Math.cos(a) * R, -Math.sin(a) * R, a, (2 * Math.PI * R) / n + 0.4, i);
      }
      return out(k, { size: R * 2 });
    }
    case 'gate': {
      // A gateway through the rampart: posts and a lintel of timber, a
      // thatched roof over the way, a guard's shelter beside it.
      for (const z of [-7, 7]) { k.cyl(0.45, 0.55, 6.5, 10, WOOD_D, 0, 3.25, z); k.box(6, 6.5 * 0.85, 1.2, EARTH, 0, 2.8, z + Math.sign(z) * 1.2, { jitter: 0.05 }); }
      k.box(1.2, 0.8, 16, WOOD_D, 0, 6.8, 0);
      k.prism([[-4, 0], [4, 0], [0, 2.4]], 17, THATCH, 0, 7.2, 0, { jitter: 0.08 });
      for (const z of [-3.6, 3.6]) k.box(0.25, 5, 7, WOOD, 0.4, 2.5, z * 0.98, { ry: z > 0 ? -1.2 : 1.2 });   // the doors, open
      for (const [x, z] of [[-3, 10], [-3, 12.5], [-5.5, 10], [-5.5, 12.5]]) k.cyl(0.1, 0.1, 2.4, 6, WOOD_D, x, 1.2, z);
      k.prism([[-1.8, 0], [1.8, 0], [0, 1.1]], 3.6, THATCH, -4.25, 2.4, 11.25, { ry: Math.PI / 2 });
      return out(k, { size: 18 });
    }
    case 'canoe': {
      // A dugout: a hull cut from one trunk, thwarts, paddles laid across.
      k.lathe([[0, -3.6], [0.32, -3.1], [0.5, -1.5], [0.55, 0], [0.5, 1.5], [0.32, 3.1], [0, 3.7]], 14, '#6d4c2f', 0, 0.35, 0, { rz: Math.PI / 2, sz: 0.6 });
      k.box(6.4, 0.08, 0.62, '#3e2723', 0, 0.62, 0);
      for (const x of [-2, -0.6, 0.8, 2.2]) k.box(0.12, 0.06, 0.6, '#8d6e63', x, 0.6, 0);
      for (const [x, z] of [[-1.2, 0.35], [1.4, -0.35]]) { k.box(1.6, 0.04, 0.05, '#5d4037', x, 0.72, z, { ry: 0.3 }); k.box(0.4, 0.03, 0.16, '#5d4037', x + 0.9, 0.72, z + 0.25, { ry: 0.3 }); }
      return { ...k.build(), parts: [], size: 8 };
    }
    case 'carrack': {
      // A sailing ship of the period: a deep hull with a high forecastle and
      // sterncastle, three masts (square sails on fore and main, a lateen on
      // the mizzen), a bowsprit, stays and shrouds, a ship's boat.
      k.prism([[-14, 0.5], [-12, 5.5], [13, 5.5], [16, 2], [14, 0]], 8, '#5d4037', 0, 0, 0, { jitter: 0.05 });
      for (let y = 1.2; y < 5.4; y += 0.8) k.box(28, 0.08, 8.05, '#4e342e', 0, y, 0);
      k.prism([[-14.5, 5.5], [-14.5, 10], [-6, 10], [-6, 5.5]], 7.6, '#4e342e', 0, 0, 0); k.box(9, 0.3, 7.8, '#3e2723', -10.2, 10.1, 0);
      k.prism([[9, 5.5], [10, 8.5], [15, 8.5], [16, 5.5]], 7, '#4e342e', 0, 0, 0);
      k.box(26, 0.25, 7.4, '#8d6e63', 0, 5.6, 0);
      for (let x = -12; x <= 8; x += 2) for (const z of [3.9, -3.9]) k.box(0.4, 0.4, 0.06, '#1a1a1a', x, 4.2, z);
      const masts = [[12, 20, 'square'], [2, 26, 'square'], [-9, 16, 'lateen']];
      for (const [x, h, rig] of masts) {
        k.cyl(0.3, 0.45, h, 10, '#3e2723', x, 5.6 + h / 2, 0);
        k.cyl(1.1, 0.9, 1.2, 10, '#4e342e', x, 5.6 + h * 0.82, 0);                                       // the top
        if (rig === 'square') for (const [yf, w] of [[0.45, 11], [0.72, 8]]) { k.cyl(0.12, 0.12, w + 1, 6, '#3e2723', x, 5.6 + h * yf + 2.2, 0, { rx: Math.PI / 2 }); k.prism([[-w / 2, 0], [w / 2, 0], [w / 2 * 0.92, 4.2], [-w / 2 * 0.92, 4.2]], 0.15, '#efe6d0', x + 0.4, 5.6 + h * yf - 2, 0, { ry: Math.PI / 2 }); }
        else k.prism([[0, 0], [9, 2], [0, 12]], 0.15, '#efe6d0', x - 4, 5.6 + h * 0.2, 0, { ry: 0 });
        for (const z of [3.8, -3.8]) for (let i = 0; i < 4; i++) k.cyl(0.03, 0.03, h * 0.82, 4, '#2b2b2b', x - 0.6 + i * 0.4, 5.6 + h * 0.41, z * 0.55, { rx: z > 0 ? -0.2 : 0.2 });   // shrouds
      }
      k.cyl(0.25, 0.3, 12, 8, '#3e2723', 20, 9.5, 0, { rz: -1.1 });                                        // bowsprit
      k.cyl(0.03, 0.03, 22, 4, '#2b2b2b', 15, 18, 0, { rz: -0.65 }); k.cyl(0.03, 0.03, 13, 4, '#2b2b2b', -3.5, 26, 0, { rz: 1.35 });   // stays
      k.box(0.3, 4, 4, '#c62828', 2, 5.6 + 26 + 1.6, 0);                                                    // a pennant
      k.lathe([[0, -2.2], [0.5, -1.6], [0.7, 0], [0.5, 1.6], [0, 2.3]], 10, '#6d4c2f', 4, 6.3, 2.2, { rz: Math.PI / 2, sz: 0.7 });   // the ship's boat
      for (const z of [2.6, -2.6]) k.box(0.6, 0.5, 0.6, '#ffd98a', -14.6, 7.5, z * 0.5, { layer: 'glow' });   // stern windows
      return { ...k.build(), parts: [], size: 36 };
    }
    default:
      if (PERIOD_GROUND.includes(kind)) return { body: null, glow: null, glass: null, parts: [], size: 1 };
      return null;
  }
}
