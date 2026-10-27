// PG1 SANDBOX TERRAIN: where a world is land and where it is water. The one
// source of truth for the engine (ground things stay on land, boats on
// water) and the viewer (the coastline it draws): public/sandbox/terrain.js
// is a byte-for-byte copy made by scripts/build-sandbox-terrain.mjs, and
// tests/sandbox-terrain.test.mjs checks the two agree on 10,000 points.
//
// Built from the world's own entities, as data:
//   island    a disc of land (properties.radius, default 500): a country
//   mangrove  a disc of land of its own type (radius, default 200)
//   forest    a disc of land, not a country (radius, default 1000): the
//             mainland behind a coast
//   lake      a disc of water (radius, default 60), cut out of the land
//   river, creek  a strip of water from the entity's position to
//             (to_x, to_y), width wide (default 30 for a river, 14 for a
//             creek), cut out of the land
// A world with no island or mangrove is land everywhere (but its lakes,
// rivers and creeks); a world with them is sea everywhere else.
//
//   buildTerrain(entities, size)  -> terrain:
//     coastDistance(x, y)  metres to the coast: positive on land, negative
//                          at sea (the coastline is where it is 0)
//     isLand(x, y) / isWater(x, y)
//     landType(x, y)       'land' | 'mangrove' | 'water'
//     islandAt(x, y)       the land mass a point is on ('main' in a world
//                          without islands), or null on water
//     nearestLand(x, y, { island? }) / nearestWater(x, y)
//     clearLine(a, b, water?)  whether a straight line stays on land (or water)
// Pure functions of the entities: no imports, nothing random, the same
// answer every time.

const LAND = { island: 500, mangrove: 200, forest: 1000 };
const WATER_DISC = { lake: 60 };
const STRIPS = { river: 30, creek: 14 };
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const TERRAIN_WORD = /island|mangrove|forest|lake|river|creek/;
const baseOf = (kind) => { const k = String(kind || ''); if (LAND[k] || WATER_DISC[k] || STRIPS[k] || !TERRAIN_WORD.test(k)) return k; const b = k.replace(/[_-][a-z0-9]+$/, ''); return b !== k && (LAND[b] || WATER_DISC[b] || STRIPS[b]) ? b : k; };

// The terrain features of a list of entities (anything with an id, kind,
// properties and position), in a fixed order.
export function terrainFeatures(entities) {
  const land = []; const water = []; const strips = [];
  for (const e of entities || []) {
    if (!e || !e.position) continue;
    const p = e.properties || {};
    const k = baseOf(e.kind);
    const x = num(e.position.x, 0); const y = num(e.position.y, 0);
    if (LAND[k]) land.push({ id: e.id, x, y, r: Math.max(1, num(p.radius, LAND[k])), type: k === 'mangrove' ? 'mangrove' : 'land', country: k === 'island', code: k === 'island' && typeof p.country === 'string' && p.country ? p.country : e.id });
    else if (WATER_DISC[k]) water.push({ id: e.id, x, y, r: Math.max(1, num(p.radius, WATER_DISC[k])) });
    else if (STRIPS[k]) strips.push({ id: e.id, x, y, x2: num(p.to_x, x), y2: num(p.to_y, y), w: Math.max(1, num(p.width, STRIPS[k])) });
  }
  return { land, water, strips };
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay; const L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export function buildTerrain(entities, size = { x: 100, y: 100 }) {
  const { land, water, strips } = terrainFeatures(entities);
  const hasLand = land.length > 0;
  // Land masses: overlapping discs are one mass, named after its first disc.
  const parent = land.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < land.length; i++) for (let j = i + 1; j < land.length; j++) if (Math.hypot(land[i].x - land[j].x, land[i].y - land[j].y) < land[i].r + land[j].r) { const a = find(i); const b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
  // An island (a country) names its mass; else the first land disc does.
  const massName = new Map();
  const rank = (d) => (d.country ? 2 : d.type === 'land' ? 1 : 0);
  for (let i = 0; i < land.length; i++) { const root = find(i); if (!massName.has(root) || rank(land[i]) > rank(land[massName.get(root)])) massName.set(root, i); }

  // Metres inside the land discs (negative: outside every one), and which disc.
  const landEdge = (x, y) => {
    if (!hasLand) return { d: Infinity, i: -1 };
    let best = -Infinity; let bi = -1;
    for (let i = 0; i < land.length; i++) { const d = land[i].r - Math.hypot(x - land[i].x, y - land[i].y); if (d > best || (d === best && land[i].type === 'land')) { best = d; bi = i; } }
    return { d: best, i: bi };
  };
  // Metres inside the water cut-outs (negative: outside every one).
  const waterIn = (x, y) => {
    let best = -Infinity;
    for (const w of water) { const d = w.r - Math.hypot(x - w.x, y - w.y); if (d > best) best = d; }
    for (const s of strips) { const d = s.w / 2 - segDist(x, y, s.x, s.y, s.x2, s.y2); if (d > best) best = d; }
    return best;
  };
  const coastDistance = (x, y) => {
    const l = landEdge(x, y).d;
    const w = waterIn(x, y);
    const v = Math.min(l, -w);
    return v === Infinity ? 1e9 : v;
  };
  // A fast answer away from the coast: the distance to it changes by at
  // most a metre a metre, so within a cell it is within half the cell's
  // diagonal of its value at the middle. Answers stay exact.
  const CELL = 40; const HALF = (CELL * Math.SQRT2) / 2;
  const gx = Math.max(1, Math.ceil((size.x || 1) / CELL) + 2); const gy = Math.max(1, Math.ceil((size.y || 1) / CELL) + 2);
  const mid = new Float64Array(gx * gy).fill(NaN);
  const midOf = (x, y) => {
    const i = Math.floor(x / CELL) + 1; const j = Math.floor(y / CELL) + 1;
    if (i < 0 || j < 0 || i >= gx || j >= gy) return NaN;
    const k = j * gx + i;
    let v = mid[k];
    if (v !== v) { v = coastDistance((i - 0.5) * CELL, (j - 0.5) * CELL); mid[k] = v; }
    return v;
  };
  // coastDistance(x, y) >= m, and <= m, without working it out when the cell knows.
  const atLeast = (x, y, m) => { const v = midOf(x, y); if (v - HALF >= m) return true; if (v + HALF < m) return false; return coastDistance(x, y) >= m; };
  const atMost = (x, y, m) => { const v = midOf(x, y); if (v + HALF <= m) return true; if (v - HALF > m) return false; return coastDistance(x, y) <= m; };
  const isLand = (x, y) => atLeast(x, y, 0);
  const isWater = (x, y) => !isLand(x, y);
  const landType = (x, y) => {
    if (!isLand(x, y)) return 'water';
    if (!hasLand) return 'land';
    // Land if any island disc holds it, else mangrove.
    for (const d of land) if (d.type === 'land' && Math.hypot(x - d.x, y - d.y) <= d.r) return 'land';
    return 'mangrove';
  };
  const islandAt = (x, y) => {
    if (!isLand(x, y)) return null;
    if (!hasLand) return 'main';
    const { i } = landEdge(x, y);
    return land[massName.get(find(i))].code;
  };
  // The island (land mass) by its code: its discs.
  const discsOf = (code) => land.filter((d, i) => land[massName.get(find(i))].code === code);
  // Rings of points around (x, y), nearest first; the first that passes, or null.
  const searchNear = (x, y, ok, { step = 5, max = 4000 } = {}) => {
    if (ok(x, y)) return { x, y };
    for (let r = step; r <= max; r += r < 100 ? step : step * 4) {
      const n = Math.max(16, Math.min(256, Math.round((2 * Math.PI * r) / Math.max(step, r / 20))));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const px = x + Math.cos(a) * r; const py = y + Math.sin(a) * r;
        if (px < 0 || py < 0 || px > size.x || py > size.y) continue;
        if (ok(px, py)) return { x: Math.round(px * 100) / 100, y: Math.round(py * 100) / 100 };
      }
    }
    return null;
  };
  // The nearest point on land, a little way in (margin); with island, on that
  // island: straight in from the sea to its coast when that is land.
  const nearestLand = (x, y, { island = null, margin = 3 } = {}) => {
    const discs = island ? discsOf(island) : [];
    if (discs.length) {
      let best = null; let bd = Infinity;
      for (const d of discs) {
        const dx = x - d.x; const dy = y - d.y; const r0 = Math.hypot(dx, dy) || 1;
        const k = Math.max(0, d.r - margin);
        const px = d.x + (dx / r0) * Math.min(k, r0); const py = d.y + (dy / r0) * Math.min(k, r0);
        const dd = Math.hypot(px - x, py - y);
        if (dd < bd && coastDistance(px, py) >= margin * 0.5) { bd = dd; best = { x: Math.round(px * 100) / 100, y: Math.round(py * 100) / 100 }; }
      }
      if (best) return best;
      const near = searchNear(x, y, (px, py) => islandAt(px, py) === island && coastDistance(px, py) >= margin);
      if (near) return near;
    }
    return searchNear(x, y, (px, py) => coastDistance(px, py) >= margin);
  };
  const nearestWater = (x, y, { margin = 3 } = {}) => searchNear(x, y, (px, py) => coastDistance(px, py) <= -margin);
  // Whether the straight line a -> b stays on land (or, with water, on water).
  const clearLine = (a, b, wantWater = false, { every = 10, margin = 0 } = {}) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(L / every));
    for (let i = 0; i <= n; i++) {
      const t = i / n; const x = a.x + (b.x - a.x) * t; const y = a.y + (b.y - a.y) * t;
      if (wantWater ? !atMost(x, y, -margin) : !atLeast(x, y, margin)) return false;
    }
    return true;
  };
  return { hasLand, features: { land, water, strips }, coastDistance, isLand, isWater, landType, islandAt, nearestLand, nearestWater, clearLine, size };
}

// The terrain's signature: worlds whose terrain features are the same share it.
export function terrainSignature(entities) {
  const { land, water, strips } = terrainFeatures(entities);
  return [...land.map((d) => `L${d.type[0]}${d.x},${d.y},${d.r},${d.code}`), ...water.map((d) => `W${d.x},${d.y},${d.r}`), ...strips.map((s) => `S${s.x},${s.y},${s.x2},${s.y2},${s.w}`)].join(';');
}
