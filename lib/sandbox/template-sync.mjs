// Bringing a world made from a template up to date with that template, for
// /sandbox upgrade (lib/sandbox/upgrade.mjs). A world keeps the things it
// was made with; when the template later gains a new kind of thing (a fire
// station, a lifeguard tower, another far world), a world made earlier never
// gets it. This works out what to add, and only adds:
//
//   things    every thing in the template whose id the world lacks, when the
//             world has no thing of that kind at all, or the kind is a fixture
//             of the sky (star, planet, moon, far world, asteroid). Never a
//             person or an animal: the world's own inhabitants are its own.
//             A new building that would stand on one the world has built
//             since is moved to the nearest clear spot on the same land, and
//             what belongs to it (its fire engines) with it. A thing whose
//             beach, station or orbit the world lacks is left out.
//   details   properties a fixture of the sky has in the template but not
//             in the world (a far world's technology, a planet's radiation
//             belt); never one the world already has
//   rules     every template rule whose id the world lacks, and the
//             template's version of a travel rule that differs (where
//             helicopters may land, for example)
//
// Same world, same result. Nothing is removed, renamed or moved.

import { templateSpec } from './templates.mjs';
import { catalogFor } from './catalog.mjs';
import { obstaclesOf } from './roads.mjs';

const FIXTURES = new Set(['star', 'planet', 'moon', 'alien_world', 'asteroid']);
const NEVER = new Set(['person', 'animal']);
const REFS = ['beach', 'home_beach', 'station', 'orbits'];
const r1 = (v) => Math.round(v * 10) / 10;
const clone = (e) => ({ ...e, position: { ...e.position }, properties: { ...e.properties } });

// Which template a world was made from, from what is in it: 'universe',
// 'town' or null (a meadow, Benin–Warri or a world of its own).
export function templateOf(entities) {
  const ents = Array.isArray(entities) ? entities : [];
  if (ents.some((e) => e.kind === 'chronicle')) return null;
  const ids = new Set(ents.map((e) => e.id));
  const kinds = new Set(ents.map((e) => e.kind));
  if (ids.has('star-1') && kinds.has('island')) return 'universe';
  if (ids.has('hospital-1') && !kinds.has('island')) return 'town';
  return null;
}

const reach = (kind) => Math.max(8, (catalogFor(kind).footprint || 8) * 0.8 + 3);
function blocked(x, y, kind, obstacles) {
  const r = reach(kind);
  for (const o of obstacles) {
    if (o.rect) {
      const c = Math.cos(o.rect.h); const s = Math.sin(o.rect.h);
      const u = (x - o.x) * c + (y - o.y) * s; const v = -(x - o.x) * s + (y - o.y) * c;
      if (Math.abs(u) < o.rect.L / 2 + r && Math.abs(v) < o.rect.W / 2 + r) return true;
    } else if (Math.hypot(o.x - x, o.y - y) < o.r + r) return true;
  }
  return false;
}
// The nearest clear spot on the same land, rings of 15 m out to 300 m; null if none.
function clearSpot(e, obstacles, terrain) {
  const { x, y } = e.position;
  if (!blocked(x, y, e.kind, obstacles)) return { x, y };
  const land = terrain.islandAt ? terrain.islandAt(x, y) : null;
  for (let d = 15; d <= 300; d += 15) {
    const n = Math.max(8, Math.round((2 * Math.PI * d) / 15));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const px = r1(x + Math.cos(a) * d); const py = r1(y + Math.sin(a) * d);
      if (!terrain.isLand(px, py) || terrain.coastDistance(px, py) < 15) continue;
      if (terrain.islandAt && terrain.islandAt(px, py) !== land) continue;
      if (!blocked(px, py, e.kind, obstacles)) return { x: px, y: py };
    }
  }
  return null;
}

// { template, entities, rules, details, things, rulesAdded, rulesUpdated }
// for a world's spec and current entities; template is null when the world
// is not a template's, and everything is empty when it is up to date.
export function planTemplateSync(spec, entities, terrain) {
  const none = { template: null, entities: [], rules: spec.rules || [], details: new Map(), things: {}, rulesAdded: [], rulesUpdated: [] };
  const name = templateOf(entities);
  const tpl = name ? templateSpec(name) : null;
  if (!tpl) return none;
  const have = new Map(entities.map((e) => [e.id, e]));
  const kinds = new Set(entities.map((e) => e.kind));
  // Things.
  let add = tpl.entities.filter((e) => !have.has(e.id) && !NEVER.has(catalogFor(e.kind).class) && (!kinds.has(e.kind) || FIXTURES.has(e.kind))).map(clone);
  // What they belong to must be there.
  for (let changed = true; changed;) {
    changed = false;
    const ids = new Set([...have.keys(), ...add.map((e) => e.id)]);
    const keep = add.filter((e) => REFS.every((k) => typeof e.properties[k] !== 'string' || ids.has(e.properties[k])));
    if (keep.length !== add.length) { add = keep; changed = true; }
  }
  const ids = new Set([...have.keys(), ...add.map((e) => e.id)]);
  for (const e of add) if (typeof e.properties.target === 'string' && !ids.has(e.properties.target)) delete e.properties.target;
  // New buildings clear of what the world has built since; what belongs to one moves with it.
  const obstacles = obstaclesOf(entities);
  const out = [];
  const moved = new Map();
  for (const e of add) {
    if (catalogFor(e.kind).class === 'building') {
      const at = clearSpot(e, obstacles, terrain);
      if (!at) continue;
      moved.set(e.id, { dx: at.x - e.position.x, dy: at.y - e.position.y });
      e.position.x = at.x; e.position.y = at.y;
      obstacles.push(...obstaclesOf([e]));
    }
    out.push(e);
  }
  const placed = new Set(out.map((e) => e.id));
  const final = [];
  for (const e of out) {
    const home = typeof e.properties.station === 'string' && !have.has(e.properties.station) ? e.properties.station : null;
    if (home && !placed.has(home)) continue;   // its station found no room
    const m = home && moved.get(home);
    if (m) { e.position.x = r1(e.position.x + m.dx); e.position.y = r1(e.position.y + m.dy); }
    final.push(e);
  }
  // Details of the sky.
  const details = new Map();
  for (const t of tpl.entities) {
    const e = have.get(t.id);
    if (!e || e.kind !== t.kind || !FIXTURES.has(t.kind)) continue;
    const extra = {};
    for (const [k, v] of Object.entries(t.properties || {})) if (!(k in (e.properties || {}))) extra[k] = v;
    if (Object.keys(extra).length) details.set(e.id, extra);
  }
  // Rules.
  const mine = spec.rules || [];
  const theirs = new Map(tpl.rules.map((r) => [r.id, r]));
  const rulesUpdated = [];
  const rules = mine.map((r) => {
    const t = theirs.get(r.id);
    if (t && r.type === 'travel' && t.type === 'travel' && JSON.stringify(r) !== JSON.stringify(t)) { rulesUpdated.push(r.id); return t; }
    return r;
  });
  const rulesAdded = [];
  for (const t of tpl.rules) if (!mine.some((r) => r.id === t.id)) { rules.push(t); rulesAdded.push(t.id); }
  const things = {};
  for (const e of final) things[e.kind] = (things[e.kind] || 0) + 1;
  return { template: name, entities: final, rules, details, things, rulesAdded, rulesUpdated };
}

export const syncIsEmpty = (s) => !s.entities.length && !s.details.size && !s.rulesAdded.length && !s.rulesUpdated.length;
