// PG1 Sandbox viewer: the kinds of the benin-warri template (c. 1610),
// modelled in code like the rest (no downloaded assets). Shapes are simple
// and generic: they say what a thing is (a compound, a palace, a canoe, a
// sailing ship), not how a particular building looked, which the sources
// used do not describe (docs/sandbox-benin-warri.md).
//
//   PERIOD_CLASS                 kind -> class, merged into models.js KIND_CLASS
//   PERIOD_FIXED                 kinds that never move (batched as static)
//   periodModel(T, Kit, kind, p, seed) -> a model, or null for kinds not here

export const PERIOD_CLASS = Object.freeze({
  canoe: 'vehicle', carrack: 'vehicle', compound: 'building', palace: 'building', brass_workshop: 'building', ivory_workshop: 'building', fishing_village: 'building',
  shrine: 'structure', earthwork: 'structure', canoe_landing: 'structure', anchorage: 'structure', royal_tomb: 'structure', heritage_site: 'structure',
  mangrove: 'structure', forest: 'structure', river: 'structure', creek: 'structure', chronicle: 'structure', porter: 'person', visitor: 'person'
});
export const PERIOD_FIXED = Object.freeze(['compound', 'palace', 'brass_workshop', 'ivory_workshop', 'fishing_village', 'shrine', 'earthwork', 'canoe_landing', 'anchorage', 'royal_tomb', 'heritage_site', 'mangrove', 'forest', 'river', 'creek', 'chronicle']);
// Drawn by waterways.js (or not at all), not as a model.
export const PERIOD_GROUND = Object.freeze(['mangrove', 'forest', 'river', 'creek', 'chronicle', 'anchorage']);

const EARTH = '#a0703c'; const THATCH = '#b89a5a'; const WOOD = '#6d4c2f';

function hut(k, x, z, r, h) {
  k.cyl(r, r, h, 10, EARTH, x, h / 2, z, { jitter: 0.12 });
  k.cone(r * 1.35, h * 0.9, 10, THATCH, x, h + h * 0.45, z, { jitter: 0.2 });
}
function enclosure(k, w, d, h, color, gate = 2.5) {
  k.box(w, h, 0.5, color, 0, h / 2, -d / 2, { jitter: 0.1 }); k.box(w, h, 0.5, color, 0, h / 2, d / 2, { jitter: 0.1 });
  k.box(0.5, h, d, color, -w / 2, h / 2, 0, { jitter: 0.1 });
  k.box(0.5, h, (d - gate) / 2, color, w / 2, h / 2, -(d + gate) / 4, { jitter: 0.1 }); k.box(0.5, h, (d - gate) / 2, color, w / 2, h / 2, (d + gate) / 4, { jitter: 0.1 });
}
const out = (k, extra) => ({ ...k.build(), parts: [], ...extra });

export function periodModel(T, Kit, kind, p = {}, seed = 0) {
  const k = new Kit(T);
  switch (kind) {
    case 'compound': {
      enclosure(k, 20, 18, 2.2, EARTH);
      hut(k, -4, -3, 3, 2.6); hut(k, 4, 3, 2.6, 2.4); hut(k, -3, 5, 2.2, 2.2);
      return out(k, { size: 22 });
    }
    case 'palace': {
      const s = p.small ? 0.7 : 1;
      enclosure(k, 70 * s, 60 * s, 3.2, EARTH, 6);
      k.box(30 * s, 4, 22 * s, EARTH, -6 * s, 2, 0, { jitter: 0.08 });
      k.prism([[-12 * s, 0], [12 * s, 0], [0, 7]], 32 * s, THATCH, -6 * s, 4, 0, { ry: Math.PI / 2 });
      hut(k, 20 * s, -18 * s, 4, 3); hut(k, 20 * s, 18 * s, 4, 3); hut(k, -26 * s, 20 * s, 3.5, 3);
      return out(k, { size: 72 * s });
    }
    case 'brass_workshop': case 'ivory_workshop': {
      for (const [x, z] of [[-5, -4], [5, -4], [-5, 4], [5, 4]]) k.cyl(0.25, 0.25, 3, 6, WOOD, x, 1.5, z);
      k.prism([[-6, 0], [6, 0], [0, 3]], 13, THATCH, 0, 3, 0, { ry: Math.PI / 2 });
      if (kind === 'brass_workshop') { k.cyl(1, 1.2, 1, 10, '#5d4037', 0, 0.5, 0); k.sphere(0.6, '#ff8f00', 0, 1.1, 0, { layer: 'glow' }); }
      else k.box(3, 0.8, 1.5, WOOD, 0, 0.4, 0);
      return out(k, { size: 14 });
    }
    case 'fishing_village': {
      for (let i = 0; i < 5; i++) hut(k, -10 + i * 5, (i % 2 ? 5 : -5), 2.2, 2.2);
      k.box(26, 0.3, 2.5, WOOD, 0, 0.6, 11);
      return out(k, { size: 30 });
    }
    case 'shrine': {
      k.box(3, 1, 2, EARTH, 0, 0.5, 0); k.box(2.4, 0.2, 1.4, '#e0d6c2', 0, 1.1, 0);
      return out(k, { size: 4 });
    }
    case 'canoe_landing': {
      k.box(14, 0.35, 3, WOOD, 4, 0.5, 0);
      for (let x = -2; x <= 10; x += 4) for (const z of [-1.2, 1.2]) k.cyl(0.18, 0.18, 2, 6, WOOD, x, 0.2, z);
      return out(k, { size: 16 });
    }
    case 'royal_tomb': {
      k.cyl(6, 7, 1.2, 16, '#7a5a35', 0, 0.6, 0, { jitter: 0.15 });
      for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; k.cyl(0.5, 0.7, 9, 8, '#5d4037', Math.cos(a) * 11, 4.5, Math.sin(a) * 11); k.ico(4, 1, '#2f5d2a', Math.cos(a) * 11, 10, Math.sin(a) * 11, { jitter: 0.3 }); }
      return out(k, { size: 30 });
    }
    case 'heritage_site': {
      k.box(10, 0.15, 8, '#8d6e63', 0, 0.08, 0);
      for (let i = 0; i < 6; i++) k.ico(0.4, 0, '#bf7046', -3 + i * 1.2, 0.3, (i % 2) - 0.5, { jitter: 0.3 });
      return out(k, { size: 10 });
    }
    case 'earthwork': {
      // A ring of rampart and ditch, with gaps for the gates.
      const R = Math.max(50, Math.min(3000, Number(p.radius) || 650)); const gates = Math.max(0, Math.min(12, Math.round(Number(p.gates) || 6)));
      const n = Math.max(24, Math.round((2 * Math.PI * R) / 30));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        if (gates && Array.from({ length: gates }, (_, g) => (g / gates) * Math.PI * 2).some((ga) => Math.abs(Math.atan2(Math.sin(a - ga), Math.cos(a - ga))) < 0.025)) continue;
        const L = (2 * Math.PI * R) / n + 0.5;
        k.box(L, 6, 8, '#8a5a32', Math.cos(a) * R, 3, -Math.sin(a) * R, { ry: a + Math.PI / 2, jitter: 0.12 });
        k.box(L, 0.4, 9, '#4e3420', Math.cos(a) * (R + 10), -0.1, -Math.sin(a) * (R + 10), { ry: a + Math.PI / 2 });
      }
      return out(k, { size: R * 2 });
    }
    case 'canoe': {
      k.capsule(0.5, 7, '#6d4c2f', 0, 0.35, 0, { rz: Math.PI / 2, sy: 0.6 });
      k.box(7, 0.1, 0.7, '#3e2723', 0, 0.62, 0);
      return { ...k.build(), parts: [], size: 8 };
    }
    case 'carrack': {
      k.box(26, 5, 8, '#5d4037', 0, 2.5, 0, { jitter: 0.08 });
      k.box(8, 4, 8, '#4e342e', -10, 7, 0); k.box(5, 3, 7, '#4e342e', 11, 6, 0);
      for (const [x, h] of [[-4, 22], [4, 26], [12, 14]]) { k.cyl(0.35, 0.45, h, 8, '#3e2723', x, 5 + h / 2, 0); k.box(0.3, h * 0.45, 10, '#f5f0e1', x + 0.6, 5 + h * 0.62, 0); }
      k.box(0.3, 4, 4, '#c62828', -4.6, 5 + 22 * 0.75, 0);
      return { ...k.build(), parts: [], size: 30 };
    }
    default:
      if (PERIOD_GROUND.includes(kind)) return { body: null, glow: null, glass: null, parts: [], size: 1 };
      return null;
  }
}
