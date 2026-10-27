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
//   life       kind, child_kind?, year_steps?, adult_age?, max_age?,
//              meet_radius?, birth_chance?, home/food/work/school/fun kinds:
//              the inhabitants live. Each has needs (hunger, energy,
//              company) and decides for itself where to go next: home to
//              sleep at night or when tired, to a shop or café when
//              hungry, to its partner or a friend or somewhere lively when
//              lonely, to work (adults) or school (children) by day. It
//              sets its own `target`; a travel rule takes it there.
//              People who spend time together become friends, then
//              partners, and move in together; a couple of a woman and a
//              man at home may have a child (`birth_chance` a step, at most
//              4, room permitting); children grow up into adults at
//              adult_age; everyone ages a year every year_steps and dies of
//              old age near max_age. Relationships are kept in the state
//              (state.relations), never in a spec. Recorded events:
//              decide, friends, partners, moved_in, birth, grew_up, death.
//              With island entities (properties: country, name, culture,
//              government, climate, radius), each country lives its own
//              life: state.society is { [country]: society }.
//              Their society (state.society; lib/sandbox/society.mjs):
//              careers and education, money, elections, taxes and laws,
//              theft, police and prison, research and technology,
//              building, colonies in space, contact with other
//              civilisations, and what they say to each other.
//              Rule-based and deterministic: no AI engine, no cost.
//
// Riders: after the rules, an entity whose `inside` property names another
// entity moves with it (a person in a car, a crew in a rocket).
// Kinds come from lib/sandbox/catalog.mjs when listed there (class, domain,
// speed, seats); any other kind is a thing that walks on the ground.
//
// Hard limits (SANDBOX_LIMITS): 500 entities, 50 rules, 100 steps a call,
// 256 KB of world JSON, 10 worlds an owner (the store enforces that one).

export const SANDBOX_LIMITS = Object.freeze({ entities: 1000, rules: 50, stepsPerCall: 100, specBytes: 256 * 1024, worldsPerOwner: 10, propertiesPerEntity: 40, eventsPerStep: 100 });
export const RULE_TYPES = Object.freeze(['move', 'spawn', 'decay', 'grow', 'interact', 'emit', 'attract', 'repel', 'condition', 'travel', 'orbit', 'life']);
export const CONDITION_OPS = Object.freeze(['<', '<=', '>', '>=', '==', '!=']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const PROP_RE = /^[a-z][a-z0-9_]{0,31}$/;
const EVENT_RE = /^[a-z][a-z0-9_]{0,31}$/;
const DEFAULT_SIZE = Object.freeze({ x: 100, y: 100, z: 20 });
import { catalogFor, DEFAULT_SPACE_ALTITUDE } from './catalog.mjs';
import { cleanRoads } from './roads.mjs';
import { keepApart, watchdog, settleContext } from './watchdog.mjs';
import { moveContext, travelStep, correctDomains, keepDomains, isGroundKind, isWaterKind } from './movement.mjs';
import { lifeStep, emptySociety, emptyAwareness, awarenessStep, countryAt, diplomacyStep, armyResponse } from './society.mjs';
export { FRIEND_AT, PARTNER_AT, nameFor, familyName } from './society.mjs';

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
    case 'life': {
      out.kind = kind(r.kind, `${name}.kind`);
      out.child_kind = r.child_kind === undefined ? out.kind : kind(r.child_kind, `${name}.child_kind`);
      out.year_steps = Math.round(num(r.year_steps ?? 240, `${name}.year_steps`, { min: 1, max: 1e6 }));
      out.adult_age = num(r.adult_age ?? 18, `${name}.adult_age`, { min: 1, max: 200 });
      out.max_age = num(r.max_age ?? 85, `${name}.max_age`, { min: 2, max: 500 });
      out.meet_radius = num(r.meet_radius ?? 15, `${name}.meet_radius`, { min: 1, max: 1000 });
      out.birth_chance = num(r.birth_chance ?? 0.02, `${name}.birth_chance`, { min: 0, max: 1 });
      const kl = (v, d, n2) => {
        const list = v === undefined ? d : v;
        if (!Array.isArray(list) || list.length > 12) bad(`${name}.${n2} must be a list of up to 12 kinds`);
        return list.map((x, i) => kind(x, `${name}.${n2}[${i}]`));
      };
      out.home_kinds = kl(r.home_kinds, ['house', 'apartment', 'cabin'], 'home_kinds');
      out.food_kinds = kl(r.food_kinds, ['shop', 'cafe'], 'food_kinds');
      out.work_kinds = kl(r.work_kinds, ['tower', 'factory', 'hospital', 'station', 'school', 'shop', 'cafe', 'farm', 'barn'], 'work_kinds');
      out.school_kinds = kl(r.school_kinds, ['school'], 'school_kinds');
      out.fun_kinds = kl(r.fun_kinds, ['fountain', 'cafe', 'lake'], 'fun_kinds');
      break;
    }
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
  const size = { x: num(s.x ?? DEFAULT_SIZE.x, 'size.x', { min: 1, max: 20000 }), y: num(s.y ?? DEFAULT_SIZE.y, 'size.y', { min: 1, max: 20000 }), z: num(s.z ?? DEFAULT_SIZE.z, 'size.z', { min: 0, max: 10000 }) };
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
  // The road network, as data (lib/sandbox/roads.mjs).
  if (raw.roads !== undefined) { try { out.roads = cleanRoads(raw.roads, size); } catch (e) { bad(e.message); } }
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
  return { tick: 0, rng: s.seed >>> 0, next_id: 1, relations: {}, society: {}, awareness: emptyAwareness(), diplomacy: {}, entities: s.entities.map((e) => ({ ...e, properties: { ...e.properties }, position: { ...e.position } })).sort(byId) };
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
  // Who knows whom: "a|b" (ids in order) -> how much time they have spent together.
  const relations = { ...(st.relations && typeof st.relations === 'object' ? st.relations : {}) };
  // The inhabitants' society (lib/sandbox/society.mjs): money, government, law, knowledge.
  // One society per country: { [country]: society }. (A world saved with a
  // single society, before countries, has its fields at the top level.)
  const rawSoc = st.society && typeof st.society === 'object' ? JSON.parse(JSON.stringify(st.society)) : {};
  const societies = 'currency' in rawSoc || 'treasury' in rawSoc ? { home: { ...emptySociety(), ...rawSoc } } : rawSoc;
  const awareness = { ...emptyAwareness(), ...(st.awareness && typeof st.awareness === 'object' ? JSON.parse(JSON.stringify(st.awareness)) : {}) };
  // Between countries (society.mjs diplomacyStep): { "a|b": { score, status } }.
  const diplomacy = st.diplomacy && typeof st.diplomacy === 'object' ? JSON.parse(JSON.stringify(st.diplomacy)) : {};
  const events = [];
  const rand = () => { const r = nextRandom(rng); rng = r.state; return r.value; };
  const emit = (kindName, summary, ref = null) => { if (events.filter((e) => e.tick === tick).length < SANDBOX_LIMITS.eventsPerStep) events.push({ tick, kind: kindName, summary: String(summary).slice(0, 200), ref }); };

  for (let k = 0; k < n; k++) {
    tick += 1;
    const removed = new Set();
    const of = (kd) => ents.filter((e) => e.kind === kd && !removed.has(e.id));
    // Land and water (lib/sandbox/terrain.mjs): a world from before them is
    // put right first, one event each; then whatever moves keeps to its domain.
    let ctx = null;
    const mc = () => ctx || (ctx = moveContext(s, ents));
    if (k === 0) correctDomains(ents, removed, mc(), emit, s.size);
    const before = new Map();
    for (const e of ents) if (isGroundKind(e.kind) || isWaterKind(e.kind)) before.set(e.id, { ...e.position });
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
        case 'travel':
          // lib/sandbox/movement.mjs: by land on the roads, by sea round the islands, by air on runways.
          travelStep(r, { s, ents, removed, rand, emit, mc: mc(), spaceAt: spaceAltitude(s) });
          break;
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
        case 'life':
          {
            // The countries: island entities, or one 'home' country.
            const islands = ents.filter((e) => !removed.has(e.id) && e.kind === 'island').map((e) => ({ code: typeof e.properties.country === 'string' && e.properties.country ? e.properties.country : e.id, name: e.properties.name || e.id, culture: e.properties.culture, government: e.properties.government, climate: e.properties.climate, x: e.position.x, y: e.position.y, r: typeof e.properties.radius === 'number' ? e.properties.radius : 500 }));
            const homeCountry = (e) => (typeof e.properties.country === 'string' && e.properties.country ? e.properties.country : countryAt(e.position, islands));
            const codes = islands.length ? islands.map((i) => i.code) : ['home'];
            for (const code of codes) {
              const meta = islands.find((i) => i.code === code) || {};
              if (!societies[code]) societies[code] = emptySociety(meta);
              lifeStep(r, { s, ents, removed, relations, diplomacy, society: societies[code], country: code, islands, homeCountry, tick, rand, emit, limits: SANDBOX_LIMITS, catalogFor });
            }
            const add = (entity) => { ents.push(entity); return entity; };
            const room = (n = 1) => ents.length - removed.size + n <= SANDBOX_LIMITS.entities - 10;
            const newId = (prefix) => `${prefix}-${tick}-${nextId++}`;
            awarenessStep({}, { awareness, societies, emit, rand, tick, ents, removed, add, room, newId, s, daySteps: s.day_steps || 240 });
            diplomacyStep({ diplomacy, societies, ents, removed, emit, rand, tick, daySteps: s.day_steps || 240 });
            armyResponse({ ents, removed, emit });
          }
          break;
        default: break;
      }
    }
    keepDomains(ents, removed, before, mc(), s.size);
    // Nothing passes through anything else; the watchdog puts right the rest (watchdog.mjs).
    {
      const shared = settleContext(ents, removed);
      keepApart(ents, removed, before, mc(), shared);
      watchdog(ents, removed, before, mc(), s.size, emit, shared, { full: k === 0 });
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
  // Keep the relations bounded: the strongest MAX_RELATIONS, none for the departed.
  {
    const alive = new Set(ents.map((e) => e.id));
    let keys = Object.keys(relations).filter((k) => { const [a, b] = k.split('|'); return alive.has(a) && alive.has(b); });
    if (keys.length > MAX_RELATIONS) keys = keys.sort((a, b) => relations[b] - relations[a] || (a < b ? -1 : 1)).slice(0, MAX_RELATIONS);
    const kept = {};
    for (const k of keys.sort()) kept[k] = relations[k];
    return { state: { tick, rng, next_id: nextId, relations: kept, society: societies, awareness, diplomacy, entities: ents }, events };
  }
}

const MAX_RELATIONS = 4000;

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
