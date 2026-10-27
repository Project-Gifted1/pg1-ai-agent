// PG1 Sandbox viewer: the insides of buildings, so they can be visited.
//
// Each kind of building has a footprint (its main block, in model metres,
// matching models.js), a storey height and how many storeys get an inside,
// and is furnished for what it is: shelves and a till in a shop, tables
// and a counter in a café or bar, desks facing a board in a school, beds
// in a hospital, desks and screens in an office tower, seats facing a
// screen or stage, benches and a departures board in a station or
// terminal, machines and crates in a factory or hangar, bunks in barracks,
// cells in a prison. Every storey has a floor, a stair and lift core, and
// lights that glow. Homes are furnished by models.js (furnitureFor).
//
// Like the rest of the viewer, it is all made in code. The front door is
// on the +x side, as on the models.
//
//   INTERIORS[kind]              { w, d, x?, z?, fh, floors? }
//   storeysOf(kind, props)       how many storeys get an inside (0: none)
//   doorOf(kind)                 { x, z } just inside the front door, model metres
//   interiorFor(THREE, Kit, kind, props) -> { body, glow, glass } or null

export const INTERIORS = Object.freeze({
  shop: { w: 16, d: 12, fh: 6, floors: 1 }, cafe: { w: 16, d: 12, fh: 6, floors: 1 }, bar: { w: 12, d: 10, fh: 5, floors: 1 },
  school: { w: 40, d: 14, fh: 4, floors: 2 }, hospital: { w: 34, d: 22, fh: 3.2, floors: 5 }, police_station: { w: 24, d: 16, fh: 4, floors: 2 },
  tower: { w: 26, d: 26, fh: 3.6 }, apartment_office: { w: 22, d: 16, fh: 3.2 }, hotel: { w: 30, d: 16, fh: 3.2 },
  cinema: { w: 26, d: 20, fh: 11, floors: 1 }, theatre: { w: 28, d: 22, x: -2, fh: 14, floors: 1 },
  station: { w: 50, d: 18, fh: 7, floors: 1 }, terminal: { w: 60, d: 24, fh: 9, floors: 1 },
  factory: { w: 40, d: 26, fh: 10, floors: 1 }, barn: { w: 18, d: 12, fh: 8, floors: 1 }, hangar: { w: 28, d: 38, fh: 11, floors: 1 },
  prison: { w: 34, d: 16, fh: 3.4, floors: 3 }, barracks: { w: 40, d: 12, z: 10, fh: 6, floors: 1 }
});
const MAX_STOREYS = 8;

export function storeysOf(kind, p = {}) {
  const I = INTERIORS[kind]; if (!I) return 0;
  if (I.floors) return I.floors;
  const f = Math.round(Number(p.floors) || (kind === 'tower' ? 30 : 7));
  return Math.max(1, Math.min(MAX_STOREYS, f));
}
export function doorOf(kind) {
  const I = INTERIORS[kind]; if (!I) return null;
  return { x: (I.x || 0) + I.w / 2 - 2.5, z: I.z || 0 };
}

const WOOD = '#8d6e63'; const DARK = '#4e342e'; const METAL = '#90a4ae'; const WHITE = '#eceff1'; const LIGHT = '#fff3d6';
const GOODS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00897b'];

function chair(k, x, y, z, c = DARK) { k.box(0.45, 0.06, 0.45, c, x, y + 0.45, z); k.box(0.06, 0.5, 0.45, c, x - 0.2, y + 0.72, z); for (const [a, b] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) k.box(0.04, 0.45, 0.04, c, x + a, y + 0.22, z + b); }
function table(k, x, y, z, w = 1.2, d = 0.8, c = WOOD) { k.box(w, 0.05, d, c, x, y + 0.75, z); for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(0.05, 0.73, 0.05, c, x + a * (w / 2 - 0.06), y + 0.37, z + b * (d / 2 - 0.06)); }
function desk(k, x, y, z) { table(k, x, y, z, 1.4, 0.7, '#cfd8dc'); k.box(0.04, 0.35, 0.55, '#212121', x + 0.25, y + 1.0, z); k.box(0.02, 0.3, 0.5, '#4fc3f7', x + 0.22, y + 1.0, z, { layer: 'glow' }); chair(k, x - 0.75, y, z, '#37474f'); }
function plant(k, x, y, z) { k.cyl(0.22, 0.18, 0.4, 8, '#795548', x, y + 0.2, z); k.ico(0.45, 1, '#388e3c', x, y + 0.85, z, { jitter: 0.08 }); }
function lamps(k, w, d, y, step = 5) { for (let x = -w / 2 + step / 2; x < w / 2; x += step) for (let z = -d / 2 + step / 2; z < d / 2; z += step) k.box(1.2, 0.05, 0.3, LIGHT, x, y - 0.06, z, { layer: 'glow' }); }

// The core: stairs and a lift, at the back of each storey.
function core(k, I, y, fh) {
  const x = (I.x || 0) - I.w / 2 + 2.2; const z = (I.z || 0) + I.d / 2 - 2.4;
  k.box(3.2, fh - 0.3, 0.12, WHITE, x, y + fh / 2, z - 1.5);
  k.box(1.6, fh - 0.4, 1.6, '#b0bec5', x - 0.6, y + fh / 2, z + 0.3, { layer: 'glass' });            // the lift
  for (let i = 0; i < 8; i++) k.box(1.2, 0.18, 0.3, '#9e9e9e', x + 1.0, y + 0.1 + i * (fh / 8), z - 1.1 + i * 0.28);   // the stair
}

function furnish(k, kind, I, y, fh, storey) {
  const ox = I.x || 0; const oz = I.z || 0; const w = I.w; const d = I.d;
  const X = (t) => ox + t; const Z = (t) => oz + t;
  switch (kind) {
    case 'shop': {
      for (let r = 0; r < 3; r++) { const z = Z(-d / 2 + 2.5 + r * 3.2); k.box(9, 1.8, 0.6, '#eceff1', X(-1.5), y + 0.9, z); for (let i = 0; i < 18; i++) k.box(0.4, 0.3, 0.3, GOODS[(i + r) % GOODS.length], X(-5.5 + i * 0.47), y + 0.5 + (i % 3) * 0.55, z + 0.3); }
      k.box(1, 1, 3, WOOD, X(w / 2 - 3.5), y + 0.5, Z(3.5)); k.box(0.3, 0.25, 0.4, '#212121', X(w / 2 - 3.5), y + 1.15, Z(3)); k.box(0.02, 0.18, 0.32, '#81d4fa', X(w / 2 - 3.36), y + 1.17, Z(3), { layer: 'glow' });
      lamps(k, w, d, y + fh, 4); break;
    }
    case 'cafe': case 'bar': {
      k.box(1, 1.1, d * 0.6, kind === 'bar' ? DARK : WOOD, X(-w / 2 + 2), y + 0.55, Z(-0.5));
      if (kind === 'bar') for (let i = 0; i < 10; i++) k.cyl(0.07, 0.07, 0.3, 6, GOODS[i % GOODS.length], X(-w / 2 + 0.6), y + 1.7 + (i % 2) * 0.5, Z(-d * 0.3 + i * 0.5), { layer: i % 3 ? 'body' : 'glass' });
      else { k.box(0.5, 0.5, 0.5, '#424242', X(-w / 2 + 2), y + 1.35, Z(-2)); k.box(0.02, 0.2, 0.3, '#ff7043', X(-w / 2 + 2.26), y + 1.4, Z(-2), { layer: 'glow' }); }
      for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) { const x = X(-w / 2 + 5 + i * 3.8); const z = Z(-d / 2 + 2.5 + j * 3.2); k.cyl(0.45, 0.45, 0.05, 12, WOOD, x, y + 0.75, z); k.cyl(0.05, 0.05, 0.73, 6, '#424242', x, y + 0.37, z); chair(k, x - 0.8, y, z); chair(k, x + 0.8, y, z); k.cyl(0.02, 0.02, fh - 2.4, 4, '#212121', x, y + fh - (fh - 2.4) / 2, z); k.sphere(0.18, '#ffd180', x, y + 2.3, z, { layer: 'glow', seg: 8, rings: 6 }); }
      break;
    }
    case 'school': {
      for (const cx of [-w / 4, w / 4]) {
        k.box(0.1, 1.4, 4, '#2e7d32', X(cx - 8.5), y + 1.6, Z(0));                                         // the board
        for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) { const x = X(cx - 5 + r * 2); const z = Z(-3 + c * 3); table(k, x, y, z, 0.7, 1.2, '#bcaaa4'); chair(k, x + 0.6, y, z, '#1565c0'); }
        k.box(0.12, fh - 0.3, d - 0.4, WHITE, X(cx + 4), y + fh / 2, Z(0));
      }
      lamps(k, w, d, y + fh, 4); break;
    }
    case 'hospital': {
      if (storey === 0) { k.box(1, 1.1, 5, '#e3f2fd', X(w / 2 - 4), y + 0.55, Z(0)); for (let i = 0; i < 6; i++) chair(k, X(w / 2 - 7), y, Z(-5 + i * 1.2), '#26a69a'); }
      else for (let i = 0; i < 6; i++) for (const s of [-1, 1]) {
        const x = X(-w / 2 + 4 + i * 5); const z = Z(s * (d / 2 - 2.2));
        k.box(2.1, 0.55, 1, WHITE, x, y + 0.45, z); k.box(1.9, 0.15, 0.9, '#bbdefb', x, y + 0.8, z); k.box(0.5, 0.12, 0.8, '#fafafa', x - 0.75, y + 0.92, z);
        k.box(0.5, 0.8, 0.5, '#b0bec5', x + 1.4, y + 0.4, z); k.box(2.4, 2.2, 0.03, '#80cbc4', x, y + 1.3, z - s * 0.9, { layer: 'glass' });
      }
      lamps(k, w, d, y + fh, 4); break;
    }
    case 'tower': case 'hotel': case 'police_station': case 'apartment_office': {
      if (storey === 0) { k.box(1, 1.1, 4, '#cfd8dc', X(w / 2 - 4), y + 0.55, Z(0)); plant(k, X(w / 2 - 1.5), y, Z(-d / 2 + 1.5)); plant(k, X(w / 2 - 1.5), y, Z(d / 2 - 1.5)); for (let i = 0; i < 3; i++) k.box(2, 0.45, 0.8, '#5d4037', X(0), y + 0.25, Z(-3 + i * 3)); }
      else if (kind === 'hotel') for (let i = 0; i < 5; i++) { const x = X(-w / 2 + 3 + i * 6); for (const s of [-1, 1]) { const z = Z(s * (d / 2 - 2.5)); k.box(2, 0.5, 1.8, '#5d4037', x, y + 0.3, z); k.box(1.9, 0.2, 1.7, '#fafafa', x, y + 0.6, z); k.box(0.12, fh - 0.3, 4.5, WHITE, x + 3, y + fh / 2, z); } }
      else { for (let i = 0; i < Math.floor((w - 6) / 3); i++) for (const z of [-d / 4, d / 4]) desk(k, X(-w / 2 + 4.5 + i * 3), y, Z(z)); table(k, X(w / 2 - 4), y, Z(0), 3, 1.4); for (const z of [-1, 1]) chair(k, X(w / 2 - 4), y, Z(z)); plant(k, X(w / 2 - 1.2), y, Z(d / 2 - 1.2)); }
      lamps(k, w, d, y + fh, 4); break;
    }
    case 'cinema': case 'theatre': {
      const front = X(-w / 2 + 2);
      if (kind === 'cinema') k.box(0.1, 6, d - 3, '#e3f2fd', front, y + 5, Z(0), { layer: 'glow' });
      else { k.box(6, 1.2, d - 2, '#5d4037', front + 2, y + 0.6, Z(0)); k.box(0.2, fh - 2, d - 2, '#b71c1c', front - 0.8, y + (fh - 2) / 2 + 1.2, Z(0)); }
      for (let r = 0; r < 9; r++) for (let c = 0; c < Math.floor((d - 4) / 0.7); c++) { const x = front + 7 + r * 1.1; const z = Z(-d / 2 + 2 + c * 0.7); k.box(0.55, 0.45, 0.55, '#c62828', x, y + 0.25 + r * 0.25, z); k.box(0.12, 0.55, 0.55, '#b71c1c', x + 0.25, y + 0.7 + r * 0.25, z); }
      break;
    }
    case 'station': case 'terminal': {
      for (let i = 0; i < Math.floor(w / 6); i++) for (const z of [-2, 2]) { k.box(3, 0.08, 0.6, METAL, X(-w / 2 + 4 + i * 5.5), y + 0.45, Z(z)); k.box(3, 0.5, 0.08, METAL, X(-w / 2 + 4 + i * 5.5), y + 0.75, Z(z + 0.3)); }
      k.box(0.2, 1.6, 6, '#212121', X(-w / 2 + 1), y + 3.6, Z(0)); k.box(0.05, 1.3, 5.6, '#ffca28', X(-w / 2 + 1.12), y + 3.6, Z(0), { layer: 'glow' });   // departures
      k.box(1.2, 1.1, 8, '#cfd8dc', X(w / 2 - 4), y + 0.55, Z(-d / 4));
      lamps(k, w, d, y + fh, 6); break;
    }
    case 'factory': case 'hangar': {
      for (let i = 0; i < 4; i++) { k.box(4, 2.2, 2.4, '#607d8b', X(-w / 2 + 5 + i * 8), y + 1.1, Z(-d / 4)); k.box(0.6, 0.6, 0.1, '#ff7043', X(-w / 2 + 5 + i * 8), y + 1.7, Z(-d / 4 + 1.25), { layer: 'glow' }); }
      for (let i = 0; i < 12; i++) k.box(1.2, 1.2, 1.2, i % 3 ? '#a1887f' : '#8d6e63', X(-w / 2 + 3 + (i % 6) * 1.4), y + 0.6 + Math.floor(i / 6) * 1.2, Z(d / 3));
      k.box(w * 0.7, 0.04, 1.2, '#fdd835', X(0), y + 0.02, Z(0));                                             // the walkway line
      lamps(k, w, d, y + fh, 8); break;
    }
    case 'barn': { for (let i = 0; i < 10; i++) k.cyl(0.7, 0.7, 1.4, 12, '#d4b45a', X(-w / 2 + 2 + (i % 5) * 1.6), y + 0.7 + Math.floor(i / 5) * 1.4, Z(-d / 2 + 2), { rx: Math.PI / 2 }); for (let i = 0; i < 4; i++) k.box(0.1, 1.2, 3, WOOD, X(-2 + i * 3), y + 0.6, Z(2)); break; }
    case 'barracks': { for (let i = 0; i < 8; i++) for (const s of [-1, 1]) { const x = X(-w / 2 + 3 + i * 4.6); const z = Z(s * (d / 2 - 1.5)); for (const h of [0.4, 1.4]) { k.box(2, 0.15, 0.9, '#556b2f', x, y + h, z); } for (const a of [-0.95, 0.95]) k.box(0.06, 1.8, 0.06, '#424242', x + a, y + 0.9, z); } break; }
    case 'prison': { for (let i = 0; i < 8; i++) { const x = X(-w / 2 + 2 + i * 4); k.box(0.1, fh - 0.4, 3, '#bdbdbd', x - 2, y + fh / 2, Z(d / 2 - 1.6)); for (let b = 0; b < 8; b++) k.cyl(0.03, 0.03, fh - 0.5, 4, '#616161', x - 1.6 + b * 0.45, y + fh / 2, Z(d / 2 - 3.1)); k.box(1.9, 0.4, 0.8, '#9e9e9e', x, y + 0.4, Z(d / 2 - 0.6)); } lamps(k, w, d, y + fh, 5); break; }
    default: break;
  }
}

export function interiorFor(THREE, Kit, kind, p = {}) {
  const I = INTERIORS[kind]; if (!I) return null;
  const n = storeysOf(kind, p); if (!n) return null;
  const k = new Kit(THREE);
  const fh = I.fh;
  for (let f = 0; f < n; f++) {
    const y = 0.3 + f * fh;
    k.box(I.w - 0.6, 0.06, I.d - 0.6, f % 2 ? '#b0a596' : '#a1887f', I.x || 0, y + 0.03, I.z || 0);   // the floor
    if (f > 0 || n > 1) core(k, I, y, fh);
    furnish(k, kind, I, y, fh, f);
  }
  return k.build();
}
