// PG1 SANDBOX ENGINE: worlds are data, never code. A world is JSON:
// entities (id, kind, properties, position), rules from the fixed
// vocabulary below, and a seed. stepWorld() runs the rules a number of
// times, deterministically: the same spec, state and seed give the same
// result on every run. Nothing here evaluates a string, builds a function,
// imports, reads a file or opens a connection: every value in a spec is
// data, so "process.exit()" in a property is a string like any other.
//
// Rules (type, then its fields):
//   move       kind, velocity {x,y,z}? | wander (max distance a step)
//   spawn      kind, every (steps), chance (0..1), near? (kind), properties?
//   decay      kind, property, amount, remove_below?
//   grow       kind, property, amount, max?
//   interact   a, b (kinds), radius, effect? {on: a|b, property, delta},
//              remove? (a|b), emit? (event kind)
//   emit       kind, every (steps), event (event kind)
//   attract    kind, toward (kind), strength, radius
//   repel      kind, from (kind), strength, radius
//   condition  kind, if {property, op, value}, then {property, set|delta}?,
//              remove?, emit?
//   travel     kind, speed? : each entity of the kind with a `target`
//              property (another entity's id) or target_x/target_y/target_z
//              heads there at its speed (the rule's, else its `speed`
//              property, else the catalogue's), keeping to its domain: cars
//              on the ground, boats on the water, planes below the space
//              altitude (climbing to cruise on the way), rockets anywhere.
//              It stops at the target's footprint (a house's door, not
//              its middle). On arrival the target is cleared, `at` names where it is,
//              and an "arrive" event is recorded (with roam [up to 12 kinds], it
//              then picks its next target among those kinds, at random
//              from the seed, so a town keeps moving); crossing the space
//              altitude records "space" (going up) or "reentry".
//   orbit      kind, around? (kind) : each entity of the kind with an
//              orbit_radius circles the entity named by its `orbits`
//              property (else the first entity of kind `around`) once every
//              orbit_period steps (default 100), starting at orbit_phase
//              (0..1), orbit_altitude metres above it (default 0).
//
// Riders: after the rules, an entity whose `inside` property names another
// entity moves with it (a person in a car, a crew in a rocket).
// Kinds come from lib/sandbox/catalog.mjs when listed there (class, domain,
// speed, seats); any other kind is a thing that walks on the ground.
//
// Hard limits (SANDBOX_LIMITS): 500 entities, 50 rules, 100 steps a call,
// 256 KB of world JSON, 10 worlds an owner (the store enforces that one).

export const SANDBOX_LIMITS = Object.freeze({ entities: 500, rules: 50, stepsPerCall: 100, specBytes: 256 * 1024, worldsPerOwner: 10, propertiesPerEntity: 20, eventsPerStep: 50 });
export const RULE_TYPES = Object.freeze(['move', 'spawn', 'decay', 'grow', 'interact', 'emit', 'attract', 'repel', 'condition', 'travel', 'orbit']);
export const CONDITION_OPS = Object.freeze(['<', '<=', '>', '>=', '==', '!=']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const PROP_RE = /^[a-z][a-z0-9_]{0,31}$/;
const EVENT_RE = /^[a-z][a-z0-9_]{0,31}$/;
const DEFAULT_SIZE = Object.freeze({ x: 100, y: 100, z: 20 });
import { catalogFor, DEFAULT_SPACE_ALTITUDE, CRUISE_ALTITUDE } from './catalog.mjs';

export class WorldError extends Error {
  constructor(message, code = 'invalid_world') { super(message); this.name = 'WorldError'; this.code = code; }
}
const bad = (m, code) => { throw new WorldError(m, code); };

// --- validation -------------------------------------------------------------------------

const num = (v, name, { min = -1e6, max = 1e6 } = {}) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(`${name} must be a number between ${min} and ${max}`);
  return v;
};
const kind = (v, name) => (typeof v === 'string' && KIND_RE.test(v) ? v : bad(`${name} must be a kind: lower-case letters, digits, _ or -, up to 32 characters`));
const prop = (v, name) => (typeof v === 'string' && PROP_RE.test(v) ? v : bad(`${name} must be a property name: lower-case letters, digits or _, up to 32 characters`));
const eventKind = (v, name) => (typeof v === 'string' && EVENT_RE.test(v) ? v : bad(`${name} must be an event name: lower-case letters, digits or _, up to 32 characters`));
const vec = (v, name, size) => {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return { x: num(o.x ?? 0, `${name}.x`, { min: -size.x, max: size.x }), y: num(o.y ?? 0, `${name}.y`, { min: -size.y, max: size.y }), z: num(o.z ?? 0, `${name}.z`, { min: -size.z, max: size.z }) };
};

// Property values: numbers, short strings, booleans. Never anything run.
export function cleanProperties(p, name = 'properties') {
  if (p === undefined || p === null) return {};
  if (typeof p !== 'object' || Array.isArray(p)) bad(`${name} must be an object`);
  const keys = Object.keys(p);
  if (keys.length > SANDBOX_LIMITS.propertiesPerEntity) bad(`${name} can have at most ${SANDBOX_LIMITS.propertiesPerEntity} properties`, 'limit');
  const out = {};
  for (const k of keys) {
    prop(k, `${name} key`);
    const v = p[k];
    if (typeof v === 'number') out[k] = num(v, `${name}.${k}`);
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') { if (v.length > 200) bad(`${name}.${k} is longer than 200 characters`); out[k] = v; }
    else bad(`${name}.${k} must be a number, a string or true/false`);
  }
  return out;
}

export function cleanEntity(e, size = DEFAULT_SIZE, name = 'entity') {
  if (!e || typeof e !== 'object' || Array.isArray(e)) bad(`${name} must be an object`);
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) bad(`${name}.id must be 1 to 64 letters, digits, _ or -`);
  return { id: e.id, kind: kind(e.kind, `${name}.kind`), properties: cleanProperties(e.properties, `${name}.properties`), position: clampPos(vec(e.position, `${name}.position`, size), size) };
}

export function cleanRule(r, size = DEFAULT_SIZE, name = 'rule') {
  if (!r || typeof r !== 'object' || Array.isArray(r)) bad(`${name} must be an object`);
  if (!RULE_TYPES.includes(r.type)) bad(`${name}.type must be one of ${RULE_TYPES.join(', ')}`);
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) bad(`${name}.id must be 1 to 64 letters, digits, _ or -`);
  const out = { id: r.id, type: r.type };
  switch (r.type) {
    case 'move':
      out.kind = kind(r.kind, `${name}.kind`);
      if (r.wander !== undefined) out.wander = num(r.wander, `${name}.wander`, { min: 0, max: 10 });
      else out.velocity = vec(r.velocity, `${name}.velocity`, { x: 10, y: 10, z: 10 });
      break;
    case 'spawn':
      out.kind = kind(r.kind, `${name}.kind`);
      out.every = Math.round(num(r.every ?? 1, `${name}.every`, { min: 1, max: 10000 }));
      out.chance = num(r.chance ?? 1, `${name}.chance`, { min: 0, max: 1 });
      if (r.near !== undefined) out.near = kind(r.near, `${name}.near`);
      out.properties = cleanProperties(r.properties, `${name}.properties`);
      break;
    case 'decay':
    case 'grow':
      out.kind = kind(r.kind, `${name}.kind`);
      out.property = prop(r.property, `${name}.property`);
      out.amount = num(r.amount, `${name}.amount`, { min: 0, max: 1e4 });
      if (r.type === 'decay' && r.remove_below !== undefined) out.remove_below = num(r.remove_below, `${name}.remove_below`);
      if (r.type === 'grow' && r.max !== undefined) out.max = num(r.max, `${name}.max`);
      break;
    case 'interact':
      out.a = kind(r.a, `${name}.a`);
      out.b = kind(r.b, `${name}.b`);
      out.radius = num(r.radius, `${name}.radius`, { min: 0, max: 1000 });
      if (r.effect !== undefined) {
        const f = r.effect || {};
        if (!['a', 'b'].includes(f.on)) bad(`${name}.effect.on must be a or b`);
        out.effect = { on: f.on, property: prop(f.property, `${name}.effect.property`), delta: num(f.delta, `${name}.effect.delta`) };
      }
      if (r.remove !== undefined) { if (!['a', 'b'].includes(r.remove)) bad(`${name}.remove must be a or b`); out.remove = r.remove; }
      if (r.emit !== undefined) out.emit = eventKind(r.emit, `${name}.emit`);
      if (!out.effect && !out.remove && !out.emit) bad(`${name} needs an effect, remove or emit`);
      break;
    case 'emit':
      out.kind = kind(r.kind, `${name}.kind`);
      out.every = Math.round(num(r.every ?? 1, `${name}.every`, { min: 1, max: 10000 }));
      out.event = eventKind(r.event, `${name}.event`);
      break;
    case 'attract':
    case 'repel':
      out.kind = kind(r.kind, `${name}.kind`);
      out[r.type === 'attract' ? 'toward' : 'from'] = kind(r.type === 'attract' ? r.toward : r.from, `${name}.${r.type === 'attract' ? 'toward' : 'from'}`);
      out.strength = num(r.strength, `${name}.strength`, { min: 0, max: 10 });
      out.radius = num(r.radius, `${name}.radius`, { min: 0, max: 1000 });
      break;
    case 'condition': {
      out.kind = kind(r.kind, `${name}.kind`);
      const c = r.if || {};
      if (!CONDITION_OPS.includes(c.op)) bad(`${name}.if.op must be one of ${CONDITION_OPS.join(' ')}`);
      if (!['number', 'string', 'boolean'].includes(typeof c.value)) bad(`${name}.if.value must be a number, a string or true/false`);
      if (typeof c.value === 'string' && c.value.length > 200) bad(`${name}.if.value is longer than 200 characters`);
      out.if = { property: prop(c.property, `${name}.if.property`), op: c.op, value: c.value };
      if (r.then !== undefined) {
        const t = r.then || {};
        out.then = { property: prop(t.property, `${name}.then.property`) };
        if (t.delta !== undefined) out.then.delta = num(t.delta, `${name}.then.delta`);
        else if (['number', 'string', 'boolean'].includes(typeof t.set)) out.then.set = typeof t.set === 'number' ? num(t.set, `${name}.then.set`) : typeof t.set === 'string' ? t.set.slice(0, 200) : t.set;
        else bad(`${name}.then needs set or delta`);
      }
      if (r.remove !== undefined) out.remove = r.remove === true;
      if (r.emit !== undefined) out.emit = eventKind(r.emit, `${name}.emit`);
      if (!out.then && !out.remove && !out.emit) bad(`${name} needs then, remove or emit`);
      break;
    }
    case 'travel':
      out.kind = kind(r.kind, `${name}.kind`);
      if (r.speed !== undefined) out.speed = num(r.speed, `${name}.speed`, { min: 0, max: 20000 });
      if (r.roam !== undefined) {
        if (!Array.isArray(r.roam) || !r.roam.length || r.roam.length > 12) bad(`${name}.roam must be a list of 1 to 12 kinds`);
        out.roam = r.roam.map((x, i) => kind(x, `${name}.roam[${i}]`));
      }
      break;
    case 'orbit':
      out.kind = kind(r.kind, `${name}.kind`);
      if (r.around !== undefined) out.around = kind(r.around, `${name}.around`);
      break;
    default: bad(`${name}.type is not known`);
  }
  return out;
}

export function specBytes(spec) {
  return Buffer.byteLength(JSON.stringify(spec), 'utf8');
}

// A whole world spec, checked against every limit. Returns a clean copy.
export function validateSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('the world must be a JSON object');
  if (specBytes(raw) > SANDBOX_LIMITS.specBytes) bad(`the world is larger than ${SANDBOX_LIMITS.specBytes / 1024} KB`, 'limit');
  const s = raw.size && typeof raw.size === 'object' ? raw.size : {};
  const size = { x: num(s.x ?? DEFAULT_SIZE.x, 'size.x', { min: 1, max: 10000 }), y: num(s.y ?? DEFAULT_SIZE.y, 'size.y', { min: 1, max: 10000 }), z: num(s.z ?? DEFAULT_SIZE.z, 'size.z', { min: 0, max: 10000 }) };
  const seed = raw.seed === undefined ? 1 : Math.trunc(num(raw.seed, 'seed', { min: 0, max: 4294967295 }));
  const entities = raw.entities === undefined ? [] : raw.entities;
  const rules = raw.rules === undefined ? [] : raw.rules;
  if (!Array.isArray(entities)) bad('entities must be a list');
  if (!Array.isArray(rules)) bad('rules must be a list');
  if (entities.length > SANDBOX_LIMITS.entities) bad(`a world can have at most ${SANDBOX_LIMITS.entities} entities`, 'limit');
  if (rules.length > SANDBOX_LIMITS.rules) bad(`a world can have at most ${SANDBOX_LIMITS.rules} rules`, 'limit');
  const ents = entities.map((e, i) => cleanEntity(e, size, `entities[${i}]`));
  const ids = new Set();
  for (const e of ents) { if (ids.has(e.id)) bad(`entity id ${e.id} is used twice`); ids.add(e.id); }
  const rls = rules.map((r, i) => cleanRule(r, size, `rules[${i}]`));
  const rids = new Set();
  for (const r of rls) { if (rids.has(r.id)) bad(`rule id ${r.id} is used twice`); rids.add(r.id); }
  const out = { size, seed, entities: ents, rules: rls };
  if (raw.space_altitude !== undefined) out.space_altitude = num(raw.space_altitude, 'space_altitude', { min: 1, max: 10000 });
  if (raw.day_steps !== undefined) out.day_steps = Math.round(num(raw.day_steps, 'day_steps', { min: 10, max: 100000 }));
  return out;
}

// Where space begins in this world: space_altitude, else 2,000 m when the
// world is tall enough, else half its height.
export function spaceAltitude(spec) {
  if (spec && typeof spec.space_altitude === 'number') return spec.space_altitude;
  const z = (spec && spec.size && spec.size.z) || DEFAULT_SIZE.z;
  return z >= DEFAULT_SPACE_ALTITUDE * 2 ? DEFAULT_SPACE_ALTITUDE : z / 2;
}

// --- the seeded random number generator (mulberry32) ------------------------------------

export function nextRandom(stateU32) {
  let t = (stateU32 + 0x6D2B79F5) >>> 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: next };
}

// --- state --------------------------------------------------------------------------------

const round = (n) => Math.round(n * 1e4) / 1e4;
function clampPos(p, size) {
  return { x: round(Math.min(size.x, Math.max(0, p.x))), y: round(Math.min(size.y, Math.max(0, p.y))), z: round(Math.min(size.z, Math.max(0, p.z))) };
}
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const dist = (a, b) => Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);

// The first state of a world: its entities, tick 0, the RNG at the seed.
export function initialState(spec) {
  const s = validateSpec(spec);
  return { tick: 0, rng: s.seed >>> 0, next_id: 1, entities: s.entities.map((e) => ({ ...e, properties: { ...e.properties }, position: { ...e.position } })).sort(byId) };
}

function compare(a, op, b) {
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '==': return a === b;
    case '!=': return a !== b;
    default: return false;
  }
}

// Runs `steps` steps (1..100). Returns { state, events } and never
// changes its arguments. Events: [{ tick, kind, summary, ref }].
export function stepWorld(spec, state, steps = 1) {
  const s = validateSpec(spec);
  const n = Math.trunc(Number(steps));
  if (!Number.isFinite(n) || n < 1 || n > SANDBOX_LIMITS.stepsPerCall) bad(`steps must be between 1 and ${SANDBOX_LIMITS.stepsPerCall}`, 'limit');
  const st = state && Array.isArray(state.entities) ? state : initialState(s);
  let rng = (Number(st.rng) >>> 0);
  let nextId = Math.max(1, Math.trunc(Number(st.next_id) || 1));
  let tick = Math.max(0, Math.trunc(Number(st.tick) || 0));
  let ents = st.entities.map((e) => ({ id: e.id, kind: e.kind, properties: { ...e.properties }, position: { ...e.position } })).sort(byId);
  const events = [];
  const rand = () => { const r = nextRandom(rng); rng = r.state; return r.value; };
  const emit = (kindName, summary, ref = null) => { if (events.filter((e) => e.tick === tick).length < SANDBOX_LIMITS.eventsPerStep) events.push({ tick, kind: kindName, summary: String(summary).slice(0, 200), ref }); };

  for (let k = 0; k < n; k++) {
    tick += 1;
    const removed = new Set();
    const of = (kd) => ents.filter((e) => e.kind === kd && !removed.has(e.id));
    for (const r of s.rules) {
      switch (r.type) {
        case 'move':
          for (const e of of(r.kind)) {
            const d = r.wander !== undefined ? { x: (rand() * 2 - 1) * r.wander, y: (rand() * 2 - 1) * r.wander, z: 0 } : r.velocity;
            e.position = clampPos({ x: e.position.x + d.x, y: e.position.y + d.y, z: e.position.z + d.z }, s.size);
          }
          break;
        case 'spawn':
          if (tick % r.every !== 0) break;
          if (rand() > r.chance) break;
          if (ents.length - removed.size >= SANDBOX_LIMITS.entities) { emit('limit', `no room for another ${r.kind}: the world has ${SANDBOX_LIMITS.entities} entities`); break; }
          {
            const anchors = r.near ? of(r.near) : [];
            const at = anchors.length ? anchors[Math.floor(rand() * anchors.length)].position : { x: rand() * s.size.x, y: rand() * s.size.y, z: 0 };
            const id = `${r.kind}-${tick}-${nextId++}`;
            ents.push({ id, kind: r.kind, properties: { ...r.properties }, position: clampPos({ x: at.x + (rand() * 2 - 1), y: at.y + (rand() * 2 - 1), z: at.z }, s.size) });
            emit('spawn', `a ${r.kind} appeared (${id})`, id);
          }
          break;
        case 'decay':
          for (const e of of(r.kind)) {
            const v = typeof e.properties[r.property] === 'number' ? e.properties[r.property] : 0;
            e.properties[r.property] = round(v - r.amount);
            if (r.remove_below !== undefined && e.properties[r.property] < r.remove_below) { removed.add(e.id); emit('remove', `${e.id} faded away (${r.property} below ${r.remove_below})`, e.id); }
          }
          break;
        case 'grow':
          for (const e of of(r.kind)) {
            const v = typeof e.properties[r.property] === 'number' ? e.properties[r.property] : 0;
            e.properties[r.property] = round(r.max !== undefined ? Math.min(r.max, v + r.amount) : v + r.amount);
          }
          break;
        case 'interact':
          for (const a of of(r.a)) {
            if (removed.has(a.id)) continue;
            for (const b of of(r.b)) {
              if (a.id === b.id || removed.has(b.id) || removed.has(a.id)) continue;
              if (dist(a, b) > r.radius) continue;
              if (r.effect) { const t = r.effect.on === 'a' ? a : b; const v = typeof t.properties[r.effect.property] === 'number' ? t.properties[r.effect.property] : 0; t.properties[r.effect.property] = round(v + r.effect.delta); }
              if (r.remove) { const t = r.remove === 'a' ? a : b; removed.add(t.id); emit('remove', `${t.id} was removed when ${a.id} met ${b.id}`, t.id); }
              if (r.emit) emit(r.emit, `${a.id} met ${b.id}`, a.id);
            }
          }
          break;
        case 'emit':
          if (tick % r.every !== 0) break;
          for (const e of of(r.kind)) emit(r.event, `${e.id}: ${r.event}`, e.id);
          break;
        case 'attract':
        case 'repel': {
          const others = of(r.type === 'attract' ? r.toward : r.from);
          for (const e of of(r.kind)) {
            let best = null; let bd = Infinity;
            for (const o of others) { if (o.id === e.id) continue; const d = dist(e, o); if (d < bd && d <= r.radius) { bd = d; best = o; } }
            if (!best || bd === 0) continue;
            const sign = r.type === 'attract' ? 1 : -1;
            const f = Math.min(r.strength, bd) / bd * sign;
            e.position = clampPos({ x: e.position.x + (best.position.x - e.position.x) * f, y: e.position.y + (best.position.y - e.position.y) * f, z: e.position.z + (best.position.z - e.position.z) * f }, s.size);
          }
          break;
        }
        case 'condition':
          for (const e of of(r.kind)) {
            const v = e.properties[r.if.property];
            if (v === undefined || typeof v !== typeof r.if.value) continue;
            if (!compare(v, r.if.op, r.if.value)) continue;
            if (r.then) {
              if (r.then.delta !== undefined) { const cur = typeof e.properties[r.then.property] === 'number' ? e.properties[r.then.property] : 0; e.properties[r.then.property] = round(cur + r.then.delta); }
              else e.properties[r.then.property] = r.then.set;
            }
            if (r.emit) emit(r.emit, `${e.id}: ${r.emit}`, e.id);
            if (r.remove) { removed.add(e.id); emit('remove', `${e.id} was removed (${r.if.property} ${r.if.op} ${r.if.value})`, e.id); }
          }
          break;
        case 'travel': {
          const index = new Map(ents.filter((e) => !removed.has(e.id)).map((e) => [e.id, e]));
          const spaceAt = spaceAltitude(s);
          for (const e of of(r.kind)) {
            const p = e.properties;
            // A rider goes where its vehicle goes (the riders pass below).
            if (typeof p.inside === 'string' && p.inside && index.has(p.inside)) continue;
            let goal = null; let goalId = null;
            if (typeof p.target === 'string' && p.target) {
              const t = index.get(p.target);
              if (!t || t.id === e.id) continue;
              goal = { ...t.position }; goalId = t.id;
            } else if (['target_x', 'target_y', 'target_z'].some((key) => typeof p[key] === 'number')) {
              goal = { x: typeof p.target_x === 'number' ? p.target_x : e.position.x, y: typeof p.target_y === 'number' ? p.target_y : e.position.y, z: typeof p.target_z === 'number' ? p.target_z : e.position.z };
            } else if (r.roam) {
              const pool = ents.filter((o) => !removed.has(o.id) && o.id !== e.id && r.roam.includes(o.kind) && o.id !== p.at);
              if (!pool.length) continue;
              const t = pool[Math.floor(rand() * pool.length)];
              p.target = t.id; goal = { ...t.position }; goalId = t.id;
            } else continue;
            const cat = catalogFor(e.kind);
            if (cat.domain === 'fixed') continue;
            const speed = r.speed !== undefined ? r.speed : (typeof p.speed === 'number' && p.speed > 0 ? Math.min(p.speed, 20000) : (cat.speed || 5));
            if (!(speed > 0)) continue;
            // Stop at a building's edge, not in the middle of it.
            const fp = goalId ? (catalogFor(index.get(goalId).kind).footprint || 0) : 0;
            if (fp > 0) {
              const gx = e.position.x - goal.x; const gy = e.position.y - goal.y; const gd = Math.hypot(gx, gy);
              if (gd > fp) { goal.x += (gx / gd) * fp; goal.y += (gy / gd) * fp; } else { goal.x = e.position.x; goal.y = e.position.y; }
            }
            if (cat.domain === 'ground' || cat.domain === 'water') goal.z = 0;
            if (cat.domain === 'air') goal.z = Math.min(goal.z, spaceAt - 1);
            goal = clampPos(goal, s.size);
            const from = e.position;
            const dh = Math.hypot(goal.x - from.x, goal.y - from.y);
            const total = Math.hypot(dh, goal.z - from.z);
            let next;
            if (total <= speed) next = goal;
            else if (cat.domain === 'air') {
              // Climb toward cruise on the way, come down near the end.
              const cruise = Math.max(goal.z, Math.min(CRUISE_ALTITUDE, spaceAt - 1, s.size.z));
              const wantZ = dh > speed * 3 ? cruise : goal.z;
              const dz = Math.max(-speed * 0.5, Math.min(speed * 0.5, wantZ - from.z));
              const hs = Math.sqrt(Math.max(0, speed * speed - dz * dz));
              const f = dh > 0 ? Math.min(1, hs / dh) : 0;
              next = { x: from.x + (goal.x - from.x) * f, y: from.y + (goal.y - from.y) * f, z: from.z + dz };
            } else {
              const f = speed / total;
              next = { x: from.x + (goal.x - from.x) * f, y: from.y + (goal.y - from.y) * f, z: from.z + (goal.z - from.z) * f };
            }
            next = clampPos(next, s.size);
            if (cat.domain === 'space' && from.z < spaceAt && next.z >= spaceAt) emit('space', `${e.id} reached space`, e.id);
            if (cat.domain === 'space' && from.z >= spaceAt && next.z < spaceAt) emit('reentry', `${e.id} came back down from space`, e.id);
            e.position = next;
            if (next === goal || dist(e, { position: goal }) < 1e-6) {
              delete p.target; delete p.target_x; delete p.target_y; delete p.target_z;
              if (goalId) p.at = goalId;
              emit('arrive', `${e.id} arrived at ${goalId || 'its destination'}`, e.id);
            }
          }
          break;
        }
        case 'orbit': {
          const index = new Map(ents.filter((e) => !removed.has(e.id)).map((e) => [e.id, e]));
          const fallback = r.around ? of(r.around)[0] : null;
          for (const e of of(r.kind)) {
            const p = e.properties;
            if (typeof p.orbit_radius !== 'number' || p.orbit_radius <= 0) continue;
            const center = typeof p.orbits === 'string' ? index.get(p.orbits) : fallback;
            if (!center || center.id === e.id) continue;
            const period = typeof p.orbit_period === 'number' && p.orbit_period >= 1 ? p.orbit_period : 100;
            const phase = typeof p.orbit_phase === 'number' ? p.orbit_phase : 0;
            const a = 2 * Math.PI * (tick / period + phase);
            e.position = clampPos({ x: center.position.x + p.orbit_radius * Math.cos(a), y: center.position.y + p.orbit_radius * Math.sin(a), z: center.position.z + (typeof p.orbit_altitude === 'number' ? p.orbit_altitude : 0) }, s.size);
          }
          break;
        }
        default: break;
      }
    }
    // Riders move with what they are inside.
    {
      const index = new Map(ents.filter((e) => !removed.has(e.id)).map((e) => [e.id, e]));
      for (const e of ents) {
        const inside = e.properties.inside;
        if (removed.has(e.id) || typeof inside !== 'string' || !inside) continue;
        const v = index.get(inside);
        if (v && v.id !== e.id) e.position = { ...v.position };
      }
    }
    if (removed.size) ents = ents.filter((e) => !removed.has(e.id));
    ents.sort(byId);
  }
  return { state: { tick, rng, next_id: nextId, entities: ents }, events };
}

// The spec with one more entity or rule (replacing one with the same id).
export function withEntity(spec, entity) {
  const s = validateSpec(spec);
  const e = cleanEntity(entity, s.size);
  const entities = s.entities.filter((x) => x.id !== e.id).concat(e);
  return validateSpec({ ...s, entities });
}
export function withRule(spec, rule) {
  const s = validateSpec(spec);
  const r = cleanRule(rule, s.size);
  const rules = s.rules.filter((x) => x.id !== r.id).concat(r);
  return validateSpec({ ...s, rules });
}
