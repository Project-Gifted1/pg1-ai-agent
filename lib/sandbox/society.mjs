// PG1 SANDBOX SOCIETY: what the `life` rule does each step (lib/sandbox/
// engine.mjs). Data in, data out, deterministic from the world's seed: no
// AI engine, no network, no cost. The inhabitants do not know they are in
// a simulation; nothing here ever tells them, and what they say is built
// from their own lives (tests scan it for the words a blind subject must
// not see).
//
// Each inhabitant has:
//   who they are     name, sex, age, lifespan, a personality (honesty,
//                    ambition, sociability, curiosity: 0..1)
//   needs            hunger, energy, hygiene, social (0..100)
//   a life           home, partner, parents, children, education (years),
//                    a career (job, workplace), money, mood
// and free will: every step they weigh what they could do (sleep, eat,
// shower, work, study, see someone, go out, explore; steal, if desperate
// and dishonest enough) by their needs and personality, and choose with a
// little chance in it, so no two lives run the same.
//
// Together they make a society (state.society):
//   money            once there are enough of them and a shop, they found a
//                    currency (its name is theirs); wages, prices, savings
//   government       elections among the adults: the winner leads, sets
//                    the tax and the laws; taxes fill the treasury
//   law and order    theft when someone is poor, hungry and dishonest;
//                    police arrest; a prison once it is built; sentences
//   knowledge        teachers, scientists and engineers add to research;
//                    technology rises through settlement, roads, industry,
//                    flight, spaceflight, colonies and interstellar travel;
//                    research and development branch by branch (energy,
//                    industry, weapons, medicine, computing, materials:
//                    research.mjs), with real effects
//   building         builders put up houses, roads (with names), schools,
//                    a hospital, a police station and a prison, and later
//                    colonies in space; people furnish their homes
//   contact          other civilisations exist out there, far away; only a
//                    deep-space expedition at interstellar technology can
//                    reach one, and their ships come very rarely
//   countries        a world can hold several countries (island entities
//                    with a name, culture, government and climate): each
//                    has its own society, people, names and currency;
//                    people holiday abroad by ship and stay in hotels
//   leisure          cinemas, theatres, bars, stadiums, beaches, fairs:
//                    they cost a little and lift the mood; matches and
//                    shows draw crowds
//   awareness        nobody tells them what their world is. If their
//                    explorers reach the hard edge of the sea or the top of
//                    the sky, and their best scientists study it long
//                    enough, they may conclude their world was made and is
//                    watched, test it, and try to leave a message for
//                    whoever watches (awarenessStep). It is rare and slow.
// Every notable thing is an event (and so in the black box).

import { researchStep, rdEffects, emptyRd } from './research.mjs';

export const JOBS = Object.freeze({
  farmer: { places: ['barn', 'crop'], wage: 6, edu: 0 },
  shopkeeper: { places: ['shop', 'cafe'], wage: 7, edu: 6 },
  driver: { places: ['station'], wage: 7, edu: 8 },
  builder: { places: ['factory', 'station'], wage: 8, edu: 6 },
  teacher: { places: ['school'], wage: 9, edu: 16, research: 0.4 },
  police: { places: ['police_station', 'station'], wage: 9, edu: 12 },
  soldier: { places: ['barracks'], wage: 9, edu: 8 },
  engineer: { places: ['factory'], wage: 11, edu: 15, research: 0.8 },
  doctor: { places: ['hospital'], wage: 13, edu: 18 },
  scientist: { places: ['tower', 'school'], wage: 12, edu: 18, research: 2 },
  pilot: { places: ['hangar'], wage: 12, edu: 14, tech: 3 },
  astronaut: { places: ['launch_pad', 'space_station'], wage: 15, edu: 18, tech: 4, research: 1 },
  leader: { places: ['tower'], wage: 14, edu: 0 },
  // c. 1610 (the benin-warri template; docs/sandbox-benin-warri.md).
  fisher: { places: ['fishing_village'], wage: 6, edu: 0 },
  trader: { places: ['canoe_landing'], wage: 7, edu: 0 },
  brass_caster: { places: ['brass_workshop'], wage: 9, edu: 0 },
  ivory_carver: { places: ['ivory_workshop'], wage: 9, edu: 0 },
  chief: { places: ['palace'], wage: 10, edu: 0 },
  guard: { places: ['gate'], wage: 5, edu: 0 }
});
export const TECH_LEVELS = Object.freeze(['settlement', 'roads and houses', 'industry', 'flight', 'spaceflight', 'space colonies', 'interstellar travel']);
// Research points needed to reach each level (cumulative).
export const TECH_AT = Object.freeze([0, 60, 400, 1200, 3000, 7000, 15000]);
const STREET_NAMES = ['Oak Street', 'Mill Lane', 'River Road', 'Harbour Way', 'Elm Avenue', 'Station Road', 'Market Street', 'Hill Rise', 'Linden Walk', 'Quarry Lane', 'Meadow Way', 'Bridge Street', 'Cedar Row', 'Lantern Lane', 'Orchard Road', 'Founders Avenue', 'Chapel Street', 'Willow Close', 'Kings Road', 'Pioneer Way'];
const CIV_NAMES = ['the Vel', 'the Oru', 'the Thessari', 'the Kaal', 'the Mireen'];
// What people buy for their homes, in order (public/sandbox/models.js furnitureFor draws them).
const FURNITURE = ['a sofa', 'a wardrobe', 'a bookshelf', 'a rug', 'a lamp', 'a desk', 'a television', 'a dining set', 'a plant', 'a mirror'];

const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(v * 100) / 100));
const r2 = (v) => Math.round(v * 100) / 100;
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const dist2 = (a, b) => Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
export const FRIEND_AT = 12;
export const PARTNER_AT = 25;
// Each culture names its people its own way.
export const CULTURES = Object.freeze({
  aurelian: {
    female: ['Ada', 'Amara', 'Bea', 'Chloe', 'Dara', 'Elena', 'Freya', 'Grace', 'Hana', 'Iris', 'Jade', 'Kira', 'Lena', 'Maya', 'Nia', 'Olive', 'Priya', 'Rosa', 'Sana', 'Tara', 'Uma', 'Vera', 'Wren', 'Yara', 'Zoe'],
    male: ['Abel', 'Ben', 'Caleb', 'Dev', 'Eli', 'Femi', 'Gus', 'Hugo', 'Ian', 'Jon', 'Kai', 'Leo', 'Milo', 'Nate', 'Omar', 'Paul', 'Quinn', 'Ravi', 'Sam', 'Theo', 'Uri', 'Vic', 'Will', 'Yusuf', 'Zane'],
    family: ['Adler', 'Baker', 'Costa', 'Diallo', 'Evans', 'Fischer', 'Garcia', 'Haddad', 'Ito', 'Jensen', 'Khan', 'Larsen', 'Mbeki', 'Novak', 'Okafor', 'Petrov', 'Quist', 'Rossi', 'Silva', 'Tanaka', 'Usman', 'Varga', 'Weber', 'Yilmaz', 'Zhou'],
    currency: ['Aster', 'Crown', 'Mark', 'Sol', 'Lumen']
  },
  maravian: {
    female: ['Lucia', 'Ines', 'Marisol', 'Paloma', 'Catalina', 'Renata', 'Ximena', 'Beatriz', 'Alma', 'Dalia', 'Graciela', 'Noemi'],
    male: ['Mateo', 'Joaquin', 'Rafael', 'Tiago', 'Emilio', 'Bruno', 'Dario', 'Lazaro', 'Ramon', 'Santiago', 'Vicente', 'Hector'],
    family: ['Almeida', 'Barros', 'Cardenas', 'Duarte', 'Esteves', 'Fonseca', 'Herrera', 'Lozano', 'Moreira', 'Navarro', 'Paredes', 'Serrano'],
    currency: ['Coral', 'Peso', 'Shell', 'Sunmark']
  },
  nordic: {
    female: ['Astrid', 'Sigrid', 'Ingrid', 'Liv', 'Solveig', 'Freja', 'Runa', 'Ylva', 'Hedda', 'Tove', 'Maja', 'Elin'],
    male: ['Bjorn', 'Leif', 'Sven', 'Ivar', 'Haakon', 'Erik', 'Arne', 'Torvald', 'Rune', 'Gunnar', 'Olav', 'Stig'],
    family: ['Ahlberg', 'Berg', 'Dahl', 'Eklund', 'Halvorsen', 'Lund', 'Nygaard', 'Sandvik', 'Strand', 'Vik', 'Holm', 'Lindqvist'],
    currency: ['Krona', 'Rune', 'Frost', 'Sild']
  },
  saltreach: {
    female: ['Niamh', 'Aoife', 'Brigid', 'Ciara', 'Orla', 'Maeve', 'Saoirse', 'Roisin'],
    male: ['Cian', 'Oisin', 'Ronan', 'Declan', 'Fintan', 'Lorcan', 'Tadhg', 'Eoin'],
    family: ['Breen', 'Carey', 'Doyle', 'Flynn', 'Keane', 'Mullan', 'Quill', 'Rooney'],
    currency: ['Tide', 'Salt', 'Penny']
  },
  // c. 1610 (benin-warri): common given names in each language, for
  // fictional people; none is the name of a ruler of either royal house.
  // The money is the simulation's; its name comes from the brass manillas
  // of the trade (docs/sandbox-benin-warri.md B6).
  edo: {
    female: ['Ivie', 'Eki', 'Esohe', 'Osarugue', 'Itohan', 'Isoken', 'Ewaen', 'Imuetinyan', 'Omosede', 'Aiwanose'],
    male: ['Osaro', 'Osagie', 'Eghosa', 'Efosa', 'Uyi', 'Iyobosa', 'Osayande', 'Ehigie', 'Omoruyi', 'Nosakhare'],
    family: ['Aigbe', 'Edosa', 'Ighodaro', 'Iyoha', 'Ehiorobo', 'Ogbebor', 'Okundaye', 'Omoregie', 'Uwaifo', 'Osifo'],
    currency: ['Manilla']
  },
  itsekiri: {
    female: ['Eyitemi', 'Temisan', 'Omawunmi', 'Oritsetimeyin', 'Toritsemi', 'Ayomide', 'Oritsematosan', 'Tsemaye'],
    male: ['Tuoyo', 'Toritseju', 'Omagbitse', 'Oritsejafor', 'Ayiri', 'Omatseye', 'Oritsegbubemi', 'Tsola'],
    family: ['Arenyeka', 'Ayomike', 'Eyeoyibo', 'Mabiaku', 'Uwawah', 'Edema', 'Omadeli', 'Eyengho'],
    currency: ['Manilla']
  },
  urhobo: {
    female: ['Ejiro', 'Ese', 'Onome', 'Rukevwe', 'Ufuoma', 'Oghogho', 'Avwerosuo', 'Oghenefejiro'],
    male: ['Ovie', 'Oghenekaro', 'Efe', 'Akpo', 'Oghenetega', 'Onoriode', 'Ejovi', 'Okiemute'],
    family: ['Akpofure', 'Edewor', 'Ighoyota', 'Ogbe', 'Okumagba', 'Oviri', 'Emuobo', 'Ukoli'],
    currency: ['Manilla']
  },
  ijaw: {
    female: ['Ebiere', 'Tamara', 'Ebimobowei', 'Seiyefa', 'Inemotimi', 'Ere', 'Timipre', 'Ebiye'],
    male: ['Ebi', 'Tari', 'Preye', 'Timi', 'Boma', 'Tonye', 'Ebikeme', 'Perekeme'],
    family: ['Amakiri', 'Ebiowei', 'Ogbotubo', 'Pereowei', 'Ayibakuro', 'Ebiakpo', 'Tuobodei', 'Sapere'],
    currency: ['Manilla']
  },
  portuguese: {
    female: ['Isabel', 'Catarina', 'Inês', 'Leonor', 'Beatriz', 'Joana'],
    male: ['João', 'Pedro', 'Manuel', 'Francisco', 'António', 'Diogo'],
    family: ['Teixeira', 'Barros', 'Correia', 'Lobo', 'Machado', 'Pinto'],
    currency: ['Real']
  }
});
const cultureOf = (c) => CULTURES[c] || CULTURES.aurelian;
export function nameFor(sex, rand, culture = 'aurelian') { const l = cultureOf(culture)[sex === 'male' ? 'male' : 'female']; return l[Math.floor(rand() * l.length)]; }
export function familyName(rand, culture = 'aurelian') { const l = cultureOf(culture).family; return l[Math.floor(rand() * l.length)]; }
export const GOVERNMENTS = Object.freeze(['democracy', 'monarchy', 'council']);
export const LEISURE_KINDS = Object.freeze(['cinema', 'theatre', 'bar', 'stadium', 'beach', 'amusement', 'fountain', 'lake']);
const hourOf = (tick, daySteps) => ((((tick / daySteps) + 0.25) % 1) * 24);
// The country names a step knows (set per step from the island entities).
let COUNTRY_NAMES = {};
const countryName = (code) => COUNTRY_NAMES[code] || code;
const an = (w) => (/^[aeiou]/i.test(String(w)) ? `an ${w}` : `a ${w}`);
const who = (e) => `${e.properties.name || e.id}${e.properties.family ? ` ${e.properties.family}` : ''}`;

export function emptySociety(meta = {}) {
  return { name: meta.name || null, culture: meta.culture || 'aurelian', government: GOVERNMENTS.includes(meta.government) ? meta.government : 'democracy', climate: meta.climate || 'temperate', ...(meta.title ? { ruler_title: String(meta.title).slice(0, 40) } : {}), ...(meta.crafts ? { crafts: String(meta.crafts).slice(0, 200) } : {}), currency: null, treasury: 0, tax: 0.1, leader: null, title: null, term_end: 0, elections: 0, laws: [], tech: 0, research: 0, prison: null, contacts: [], colonies: 0, crimes: 0, arrests: 0, births: 0, deaths: 0, projects: [], streets: 0, founded: null, tourists: 0, shows: 0, rd: emptyRd() };
}
// The world-wide record of what the inhabitants have worked out about
// their world (awarenessStep): evidence, how far they have got, messages.
export function emptyAwareness() {
  return { evidence: 0, level: 0, edge_seen: 0, sky_seen: 0, hypothesis_by: null, messages: [], next_try: 0 };
}

// Which country a place is in: the island entity it stands on (within its
// radius), else 'home'. islands: [{ code, x, y, r }].
export function countryAt(pos, islands) {
  let best = null; let bd = Infinity;
  for (const i of islands || []) { const d = Math.hypot(pos.x - i.x, pos.y - i.y); if (d <= i.r + 120 && d - i.r < bd) { bd = d - i.r; best = i; } }
  return best ? best.code : 'home';
}

// One step of everyone's lives. ctx: { s, ents, removed, relations, society,
// tick, rand, emit, limits, catalogFor, spaceAltitude, newId }.
export function lifeStep(r, ctx) {
  const { s, ents, removed, relations, tick, rand, emit, limits, catalogFor } = ctx;
  const soc = ctx.society;
  const country = ctx.country || 'home';
  const islands = ctx.islands || [];
  const culture = soc.culture || 'aurelian';
  const placeIn = new Map();
  const where = (e) => { let c = placeIn.get(e.id); if (!c) { c = typeof e.properties.country === 'string' && e.properties.country ? e.properties.country : countryAt(e.position, islands); placeIn.set(e.id, c); } return c; };
  const homeCountry = ctx.homeCountry || ((e) => where(e));
  COUNTRY_NAMES = Object.fromEntries(islands.map((i) => [i.code, i.name || i.code]));
  const daySteps = s.day_steps || 240;
  const hour = hourOf(tick, daySteps);
  const night = hour >= 22.5 || hour < 6.5;
  const workHours = hour >= 8.5 && hour < 17;
  const morning = hour >= 6.5 && hour < 8.5;
  const isLiving = (e) => e.kind === r.kind || e.kind === r.child_kind;
  const live = ents.filter((e) => !removed.has(e.id) && isLiving(e) && homeCountry(e) === country);
  if (!live.length) return;
  const index = new Map(ents.filter((e) => !removed.has(e.id)).map((e) => [e.id, e]));
  // Places: in this country unless asked for another (a holiday abroad).
  const ofKinds = (kinds, inCountry = country) => ents.filter((e) => !removed.has(e.id) && kinds.includes(e.kind) && (e.properties.built === undefined || e.properties.built >= 100) && where(e) === inCountry);
  const nearestOf = (e, list) => { let best = null; let bd = Infinity; for (const o of list) { const d = dist2(o, e); if (d < bd) { bd = d; best = o; } } return best; };
  const homes = ofKinds(r.home_kinds); const food = ofKinds(r.food_kinds); const fun = ofKinds([...new Set([...r.fun_kinds, ...LEISURE_KINDS])]);
  const ports = ofKinds(['port']);
  const airports = ofKinds(['runway']);
  const foreign = [...new Set(islands.map((i) => i.code))].filter((c) => c !== country && ofKinds(['hotel'], c).length && (ofKinds(['port'], c).length || ofKinds(['runway'], c).length));
  // How a trip goes: by air (airports at both ends, flight technology, a
  // dearer ticket) or by sea (ports at both ends).
  const HUB = { air: 'runway', sea: 'port' };
  const CRAFT = { air: ['plane', 'small_plane'], sea: ['ship', 'ferry'] };
  const FARE = { air: 40, sea: 15 };
  const modeFor = (dest, money) => {
    const air = soc.tech >= 3 && airports.length && ofKinds(['runway'], dest).length && money >= 250;
    if (air) return 'air';
    return ports.length && ofKinds(['port'], dest).length ? 'sea' : (airports.length && ofKinds(['runway'], dest).length ? 'air' : null);
  };
  const yearFrac = 1 / r.year_steps;
  const adults = live.filter((e) => (e.properties.age || 0) >= r.adult_age);
  const count = () => ents.length - removed.size;
  const room = (n = 1) => count() + n <= limits.entities - 10;
  const add = (entity) => { ents.push(entity); index.set(entity.id, entity); return entity; };
  const newId = (prefix) => { let id; do { id = `${prefix}-${tick}-${Math.floor(rand() * 1e6)}`; } while (index.has(id)); return id; };
  if (!soc.rd) soc.rd = emptyRd();
  const fx = rdEffects(soc);
  // progress: false (a period world): technology stays where it starts.
  const level = () => { if (r.progress === false) return soc.tech || 0; let l = 0; for (let i = 0; i < TECH_AT.length; i++) if (soc.research >= TECH_AT[i]) l = i; return l; };
  const say = (a, b, line) => {
    a.properties.saying = line.slice(0, 160);
    a.properties.talking_to = b ? b.id : '';
    a.properties.saying_until = tick + 3;
    emit('talk', `${who(a)}${b ? ` to ${who(b)}` : ''}: "${line.slice(0, 160)}"`, a.id);
  };

  // --- who they are, and time passing -------------------------------------------------------
  for (const e of live) {
    const p = e.properties;
    if (p.sex !== 'female' && p.sex !== 'male') p.sex = rand() < 0.5 ? 'female' : 'male';
    if (typeof p.name !== 'string' || !p.name) p.name = nameFor(p.sex, rand, culture);
    if (typeof p.family !== 'string' || !p.family) p.family = (p.mother && index.get(p.mother) && index.get(p.mother).properties.family) || familyName(rand, culture);
    if (typeof p.country !== 'string' || !p.country) p.country = country;
    if (typeof p.age !== 'number') p.age = e.kind === r.child_kind && r.child_kind !== r.kind ? Math.round(rand() * (r.adult_age - 1)) : Math.round(r.adult_age + rand() * 40);
    if (typeof p.lifespan !== 'number') p.lifespan = r2(r.max_age - 10 + rand() * 20);
    for (const t of ['honesty', 'ambition', 'sociability', 'curiosity']) if (typeof p[t] !== 'number') p[t] = r2(0.15 + rand() * 0.85);
    if (typeof p.home !== 'string' || !index.has(p.home)) { const h = nearestOf(e, homes); if (h) p.home = h.id; }
    for (const need of ['hunger', 'energy', 'social', 'hygiene']) if (typeof p[need] !== 'number') p[need] = need === 'energy' || need === 'hygiene' ? 60 + rand() * 40 : rand() * 40;
    if (typeof p.education !== 'number') p.education = Math.max(0, Math.min(22, Math.round((p.age >= r.adult_age ? 8 + rand() * 12 : Math.max(0, p.age - 5)))));
    if (p.saying && (p.saying_until || 0) <= tick) { delete p.saying; delete p.talking_to; delete p.saying_until; }
    p.age = Math.round((p.age + yearFrac) * 10000) / 10000;
    if (p.age >= 3 && p.age < r.adult_age) p.education = Math.min(22, Math.round(((p.education || 0) + yearFrac * 0.4) * 1000) / 1000);   // learning at home
    p.hunger = clamp100(p.hunger + 0.7);
    p.energy = clamp100(p.energy - (night ? 1.0 : 0.5));
    p.hygiene = clamp100(p.hygiene - 0.35);
    p.social = clamp100(p.social - 0.35 * (0.5 + p.sociability));
  }

  // --- money: founded once there are enough people and somewhere to trade ----------------------
  if (!soc.currency && live.length >= 8 && food.length) {
    const names = cultureOf(culture).currency;
    soc.currency = names[Math.floor(rand() * names.length)];
    soc.founded = tick;
    for (const e of adults) e.properties.money = 40 + Math.round(rand() * 60);
    emit('currency', `${soc.name ? `In ${soc.name}, the` : 'The'} people agreed on money: the ${soc.currency}. Everyone starts with a little.`, null);
  }

  // Once a day: pensions for the retired and help for those out of work, from the treasury.
  if (soc.currency && tick % daySteps === 0) {
    for (const e of adults) {
      const j = e.properties.job;
      const due = j === 'retired' ? 12 : j === 'unemployed' ? 8 : 0;
      if (due && soc.treasury >= due) { soc.treasury = r2(soc.treasury - due); e.properties.money = r2((e.properties.money || 0) + due); }
    }
  }

  // --- government -------------------------------------------------------------------------------
  // A monarchy passes the crown in the family; a democracy elects a leader
  // for five days; a council is elected for three and governs by consensus.
  if (soc.government === 'monarchy' && adults.length >= 4 && (!soc.leader || !index.has(soc.leader))) {
    const old = soc.leader_family;
    // The old line, else a royal house the world starts with (properties.royal), else the most ambitious.
    const royal = adults.filter((e) => e.properties.royal === true).sort((a, b) => b.properties.age - a.properties.age || (a.id < b.id ? -1 : 1));
    const heirs = adults.filter((e) => old && e.properties.family === old).sort((a, b) => b.properties.age - a.properties.age || (a.id < b.id ? -1 : 1));
    const pool = heirs.length ? heirs : royal.length ? royal : adults.slice().sort((a, b) => (b.properties.ambition + b.properties.age / 100) - (a.properties.ambition + a.properties.age / 100) || (a.id < b.id ? -1 : 1));
    const ruler = pool[0];
    soc.leader = ruler.id; soc.leader_family = ruler.properties.family; soc.title = soc.ruler_title || (ruler.properties.sex === 'female' ? 'Queen' : 'King');
    ruler.properties.job = 'leader';
    soc.tax = r2(0.08 + ruler.properties.ambition * 0.2);
    soc.laws = [`royal tax ${Math.round(soc.tax * 100)}%`, `theft: ${ruler.properties.honesty > 0.5 ? 2 : 3} days in prison`, ruler.properties.curiosity > 0.6 ? 'the crown funds learning' : 'the crown funds building'];
    emit('election', `${soc.title} ${who(ruler)} now rules ${soc.name || 'the land'}${heirs.length ? ', heir of the old line' : royal.length ? ', of the royal house' : ', founding a royal house'}. Laws: ${soc.laws.join('; ')}.`, ruler.id);
  }
  if (soc.government !== 'monarchy' && adults.length >= 8 && (!soc.leader || tick >= soc.term_end || !index.has(soc.leader))) {
    const pool = adults.filter((e) => !e.properties.jail_until || e.properties.jail_until <= tick);
    const score = (c) => (c.properties.education || 0) * 0.5 + (c.properties.ambition || 0) * 10 + (c.properties.honesty || 0) * 6 + rand() * 4;
    const candidates = pool.slice().sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : 1)).slice(0, 3);
    const votes = new Map(candidates.map((c) => [c.id, 0]));
    for (const v of pool) {
      let best = null; let bv = -Infinity;
      for (const c of candidates) { const like = (relations[pairKey(v.id, c.id)] || 0) + (v.id === c.id ? 50 : 0) + (c.properties.honesty || 0) * 10 + rand() * 8; if (like > bv) { bv = like; best = c; } }
      if (best) votes.set(best.id, votes.get(best.id) + 1);
    }
    const winner = candidates.slice().sort((a, b) => votes.get(b.id) - votes.get(a.id) || (a.id < b.id ? -1 : 1))[0];
    if (winner) {
      if (soc.leader && index.has(soc.leader) && soc.leader !== winner.id) { const old = index.get(soc.leader); if (old.properties.job === 'leader') delete old.properties.job; }
      soc.leader = winner.id;
      soc.elections += 1;
      soc.term_end = tick + daySteps * (soc.government === 'council' ? 3 : 5);
      soc.title = soc.ruler_title || (soc.government === 'council' ? 'Speaker of the Council' : 'Leader');
      winner.properties.job = 'leader';
      // The leader's character sets the tax and the laws.
      soc.tax = soc.government === 'council' ? 0.12 : r2(0.05 + (1 - winner.properties.honesty) * 0.1 + winner.properties.ambition * 0.15);
      soc.laws = [`income tax ${Math.round(soc.tax * 100)}%`, `theft: ${winner.properties.honesty > 0.6 ? 2 : 1} days in prison`, winner.properties.curiosity > 0.6 ? 'research is funded first' : 'housing is funded first'];
      emit('election', `${who(winner)} won election ${soc.elections}${soc.name ? ` in ${soc.name}` : ''} with ${votes.get(winner.id)} of ${pool.length} votes and is now ${soc.title}. Laws: ${soc.laws.join('; ')}.`, winner.id);
    }
  }

  // --- careers ----------------------------------------------------------------------------------
  const techNow = level();
  for (const e of adults) {
    const p = e.properties;
    if (p.age >= 67 && p.job !== 'leader') { if (p.job !== 'retired') { p.job = 'retired'; delete p.work; emit('career', `${who(e)} retired`, e.id); } continue; }
    const better = p.job && JOBS[p.job] && p.job !== 'leader' && rand() < 0.01 && Object.entries(JOBS).some(([j, d]) => j !== 'leader' && d.wage > JOBS[p.job].wage + 2 && (p.education || 0) >= d.edu && (!d.tech || techNow >= d.tech));
    if (!better && p.job && p.job !== 'unemployed' && (p.job === 'leader' || p.job === 'retired' || (p.work && index.has(p.work)))) continue;
    const options = Object.entries(JOBS).filter(([j, d]) => j !== 'leader' && (p.education || 0) >= d.edu && (!d.tech || techNow >= d.tech) && ofKinds(d.places).length);
    if (!options.length) { if (p.job !== 'unemployed') { p.job = 'unemployed'; delete p.work; } continue; }
    // Ambitious, educated people reach for the demanding jobs; everyone has some say.
    // A crowded job is less attractive: workplaces only need so many.
    const holders = (j) => adults.filter((x) => x.properties.job === j).length;
    const pick = options.map(([j, d]) => [j, d, d.edu * p.ambition + d.wage + rand() * 10 - Math.max(0, holders(j) - (j === 'shopkeeper' || j === 'farmer' ? 2 : 4) * ofKinds(d.places).length) * 6]).sort((a, b) => b[2] - a[2])[0];
    p.job = pick[0];
    p.work = nearestOf(e, ofKinds(pick[1].places)).id;
    emit('career', `${who(e)} became ${an(pick[0])} at ${p.work}`, e.id);
  }

  // --- company: time together builds friendships and partnerships; they talk ------------------------
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j];
      if (dist2(a, b) > r.meet_radius) continue;
      const k = pairKey(a.id, b.id);
      const before = relations[k] || 0;
      const now = Math.min(1000, before + 1);
      relations[k] = now;
      a.properties.social = clamp100(a.properties.social + 1.5 * (0.5 + a.properties.sociability));
      b.properties.social = clamp100(b.properties.social + 1.5 * (0.5 + b.properties.sociability));
      if (before < FRIEND_AT && now >= FRIEND_AT) emit('friends', `${who(a)} (${a.id}) and ${who(b)} (${b.id}) became friends`, a.id);
      const grownUps = a.properties.age >= r.adult_age && b.properties.age >= r.adult_age;
      const free = !a.properties.partner && !b.properties.partner;
      const family = a.properties.mother === b.id || a.properties.father === b.id || b.properties.mother === a.id || b.properties.father === a.id || (a.properties.mother && a.properties.mother === b.properties.mother);
      const sameSex = a.properties.sex === b.properties.sex;
      if (now >= PARTNER_AT && grownUps && free && !family && rand() < 0.08 * (a.properties.sociability + b.properties.sociability) * (sameSex ? 0.15 : 1)) {
        a.properties.partner = b.id; b.properties.partner = a.id;
        emit('partners', `${who(a)} (${a.id}) and ${who(b)} (${b.id}) became partners`, a.id);
        if (a.properties.home && b.properties.home !== a.properties.home) { b.properties.home = a.properties.home; emit('moved_in', `${who(b)} moved in with ${who(a)} at ${a.properties.home}`, b.id); }
      }
      if (!a.properties.saying && !b.properties.saying && rand() < 0.02 * (a.properties.sociability + b.properties.sociability)) {
        const [x, y] = rand() < 0.5 ? [a, b] : [b, a];
        say(x, y, chatLine(x, y, { soc, relations: now, techNow, rand, index }));
      }
    }
  }

  // --- children -----------------------------------------------------------------------------------
  for (const mum of live) {
    const p = mum.properties;
    if (p.sex !== 'female' || !p.partner || p.age < r.adult_age || p.age > 45) continue;
    const dad = index.get(p.partner);
    if (!dad || dad.properties.sex !== 'male' || removed.has(dad.id)) continue;
    const home = index.get(p.home);
    if (!home || dist2(mum, home) > 25 || dist2(dad, home) > 25) continue;
    if ((p.children || 0) >= 4 || (typeof p.last_birth === 'number' && tick - p.last_birth < r.year_steps)) continue;
    if (rand() >= r.birth_chance) continue;
    if (!room()) { emit('limit', `no room for a baby: the world has ${limits.entities} entities`); continue; }
    const sex = rand() < 0.5 ? 'female' : 'male';
    const baby = add({ id: newId(r.child_kind), kind: r.child_kind, position: { ...home.position }, properties: { name: nameFor(sex, rand, culture), family: p.family, country, sex, age: 0, mother: mum.id, father: dad.id, home: home.id, hunger: 10, energy: 90, social: 50, hygiene: 90, education: 0, lifespan: r2(r.max_age - 10 + rand() * 20 + fx.lifeYears), at: home.id } });
    p.children = (p.children || 0) + 1; p.last_birth = tick;
    dad.properties.children = (dad.properties.children || 0) + 1;
    soc.births += 1;
    emit('birth', `${who(baby)} (${baby.id}) was born to ${who(mum)} and ${who(dad)}`, baby.id);
  }

  // --- each life, one step: growing, working, choosing ------------------------------------------------
  const police = adults.filter((e) => e.properties.job === 'police' && (!e.properties.jail_until || e.properties.jail_until <= tick));
  for (const e of live) {
    if (removed.has(e.id)) continue;
    const p = e.properties;
    if (e.kind === r.child_kind && r.child_kind !== r.kind && p.age >= r.adult_age) { e.kind = r.kind; if (soc.currency) p.money = (p.money || 0) + 25; emit('grew_up', `${who(e)} grew up (${Math.round(p.education)} years of school)`, e.id); }
    if (p.age >= p.lifespan - fx.pollutionYears) {
      removed.add(e.id);
      if (p.partner && index.get(p.partner)) delete index.get(p.partner).properties.partner;
      if (soc.leader === e.id) soc.leader = null;
      soc.deaths += 1;
      emit('death', `${who(e)} (${e.id}) died at ${Math.floor(p.age)}${p.job ? `, ${an(p.job)}` : ''}`, e.id);
      continue;
    }
    // On a ship for a trip: get off at the right port.
    if (p.inside) {
      const ship = index.get(p.inside);
      const port = ship && !ship.properties.target && typeof ship.properties.at === 'string' ? index.get(ship.properties.at) : null;
      if (port && (port.kind === 'port' || port.kind === 'runway') && p.trip_stage) {
        const there = where(port);
        if (p.trip_stage === 'out' && there === p.trip) {
          delete p.inside; delete p.trip_stage;
          p.abroad = p.trip; p.trip_until = tick + daySteps * 2;
          e.position = { x: port.position.x + 3, y: port.position.y, z: 0 };
          const hotel = nearestOf(e, ofKinds(['hotel'], p.abroad));
          if (hotel) p.target = hotel.id;
          soc.tourists += 1;
          emit('travel', `${who(e)} ${port.kind === 'runway' ? 'landed' : 'arrived'} in ${countryName(p.abroad)} for a holiday`, e.id);
        } else if (p.trip_stage === 'back' && there === country) {
          delete p.inside; delete p.trip_stage; delete p.abroad; delete p.trip; delete p.trip_until; delete p.trip_mode;
          e.position = { x: port.position.x + 3, y: port.position.y, z: 0 };
          if (p.home) p.target = p.home;
          emit('travel', `${who(e)} came home from a holiday`, e.id);
        }
      }
      continue;
    }
    const at = typeof p.at === 'string' && !p.target ? index.get(p.at) : null;
    const local = p.abroad || country;
    // Abroad, a hotel is home.
    const homeHere = p.abroad ? nearestOf(e, ofKinds(['hotel'], local)) : index.get(p.home);
    const atHome = at && homeHere && at.id === homeHere.id;
    // At a port or an airport with a trip ahead: board what is in, and pay the fare.
    if (at && (at.kind === 'port' || at.kind === 'runway') && (p.trip || (p.abroad && tick >= (p.trip_until || 0)))) {
      const mode = at.kind === 'runway' ? 'air' : 'sea';
      const craft = ents.find((x) => !removed.has(x.id) && CRAFT[mode].includes(x.kind) && x.properties.at === at.id && !x.properties.target && dist2(x, at) < (mode === 'air' ? 800 : 150));
      if (craft) {
        p.inside = craft.id; p.trip_stage = p.abroad ? 'back' : 'out';
        e.position = { ...craft.position };
        if (soc.currency) { const fare = FARE[mode]; p.money = r2(Math.max(0, (p.money || 0) - fare)); soc.treasury = r2(soc.treasury + fare * 0.2); }
        emit('travel', `${who(e)} ${mode === 'air' ? 'took a flight' : 'boarded'} ${craft.properties.name || craft.id} at ${at.properties.name || at.id}${p.abroad ? ', heading home' : ` for ${countryName(p.trip)}`}`, e.id);
        continue;
      }
    }
    // In prison: they stay until the sentence is served.
    if (p.jail_until && p.jail_until > tick) { const pr = soc.prison && index.get(soc.prison); if (pr && p.target !== pr.id && p.at !== pr.id) p.target = pr.id; continue; }
    if (p.jail_until && p.jail_until <= tick) { delete p.jail_until; emit('released', `${who(e)} was released`, e.id); }
    // What being somewhere does. In a building, they go inside.
    if (at && catalogFor(at.kind).class === 'building') {
      const inner = Math.max(2, (catalogFor(at.kind).footprint || 8) * 0.35);
      if (dist2(e, at) > inner * 1.5) e.position = { x: r2(at.position.x + (rand() * 2 - 1) * inner), y: r2(at.position.y + (rand() * 2 - 1) * inner), z: 0 };
    }
    if (at) {
      if (atHome) {
        p.energy = clamp100(p.energy + (night ? 5 : 2));
        if (p.hygiene < 50 && rand() < 0.3) { p.hygiene = 100; emit('shower', `${who(e)} showered ${p.abroad ? 'at the hotel' : 'at home'}`, e.id); }
        p.hunger = clamp100(p.hunger - (p.age < r.adult_age ? 6 : 1.5));   // the family kitchen, or room service
        // A night at a hotel is paid once a day.
        if (p.abroad && soc.currency && night && p.paid_day !== Math.floor(tick / daySteps)) { p.paid_day = Math.floor(tick / daySteps); const fee = 12; p.money = r2(Math.max(0, (p.money || 0) - fee)); at.properties.till = r2((at.properties.till || 0) + fee); }
      }
      // Fun costs a little and lifts the mood.
      if (['cinema', 'theatre', 'bar', 'stadium', 'amusement'].includes(at.kind) && p.fun_day !== `${at.id}:${Math.floor(tick / 24)}`) {
        p.fun_day = `${at.id}:${Math.floor(tick / 24)}`;
        const price = soc.currency ? 3 : 0;
        if (!price || (p.money || 0) >= price) { if (price) { p.money = r2(p.money - price); at.properties.till = r2((at.properties.till || 0) + price); } p.social = clamp100(p.social + 12); p.mood = 'happy'; if (rand() < 0.15) emit('leisure', `${who(e)} enjoyed an evening at ${at.properties.name || at.id}`, e.id); }
      }
      if (at.kind === 'beach') { p.social = clamp100(p.social + 2); p.mood = 'relaxed'; }
      if (r.food_kinds.includes(at.kind) && p.hunger > 30) {
        const price = soc.currency ? 5 : 0;
        if (!price || (p.money || 0) >= price) {
          p.hunger = clamp100(p.hunger - 45);
          if (price) { p.money = r2((p.money || 0) - price); at.properties.till = r2((at.properties.till || 0) + price); }
          if (rand() < 0.2) emit('meal', `${who(e)} ate at ${at.id}${price ? ` for ${price} ${soc.currency}` : ''}`, e.id);
        } else if (p.hunger > 75 && p.honesty < 0.35 && rand() < (1 - p.honesty) * 0.5) {
          p.hunger = clamp100(p.hunger - 45);
          p.crimes = (p.crimes || 0) + 1;
          soc.crimes += 1;
          emit('crime', `${who(e)} stole food from ${at.id}`, e.id);
          const cop = police.find((c) => dist2(c, e) < 600) || (workHours && police.length && rand() < 0.5 ? police[Math.floor(rand() * police.length)] : null);
          if (cop) arrest(e, cop);
        }
        // Spare money buys something for the home now and then.
        if (soc.currency && (p.money || 0) > 80 && p.home && rand() < 0.05) {
          const h = index.get(p.home);
          if (h && (h.properties.furniture || 0) < FURNITURE.length) {
            const what = FURNITURE[(h.properties.furniture || 0) % FURNITURE.length];
            h.properties.furniture = (h.properties.furniture || 0) + 1;
            p.money = r2(p.money - 30);
            at.properties.till = r2((at.properties.till || 0) + 30);
            emit('bought', `${who(e)} bought ${what} for their home (${p.home})`, e.id);
          }
        }
      }
      if (r.fun_kinds.includes(at.kind)) p.social = clamp100(p.social + 3);
      // Work: wages, taxes, and what the work produces.
      if (p.job && p.work === at.id && workHours && JOBS[p.job]) {
        const d = JOBS[p.job];
        if (soc.currency) {
          const pay = d.wage * 0.3 * fx.pay;
          const fromTill = at.properties.till > pay ? pay : 0;
          if (fromTill) at.properties.till = r2(at.properties.till - pay);
          const tax = pay * soc.tax;
          p.money = r2((p.money || 0) + pay - tax);
          soc.treasury = r2(soc.treasury + tax);
        }
        if (d.research) soc.research = r2(soc.research + d.research * 0.5 * (0.5 + (p.education || 0) / 20) * (0.5 + p.curiosity) * fx.research);
      }
      // School (and, for the unemployed and ambitious, study as adults).
      if (r.school_kinds.includes(at.kind) && (p.age < r.adult_age || p.job === 'unemployed' || p.studying)) p.education = Math.min(22, Math.round(((p.education || 0) + yearFrac * 3 * (0.6 + p.curiosity * 0.6)) * 1000) / 1000);
    }

    // Free will: weigh every option by need and character, then choose with a little chance.
    const child = p.age < r.adult_age;
    const home = homeHere;
    const partner = p.partner ? index.get(p.partner) : null;
    const options = [];
    const offer = (w, goal, why, act = null) => { if (goal && goal.id !== e.id && w > 0) options.push({ w, goal, why, act }); };
    const foodHere = p.abroad ? ofKinds(r.food_kinds, local) : food;
    const funHere = p.abroad ? ofKinds([...new Set([...r.fun_kinds, ...LEISURE_KINDS])], local) : fun;
    offer((night ? 60 : 0) + Math.max(0, 70 - p.energy), home, night ? (p.abroad ? 'back to the hotel to sleep' : 'going home to sleep') : 'tired: going home to rest');
    offer(Math.max(0, p.hunger - 35) * 1.3, child ? home : nearestOf(e, foodHere), child ? 'hungry: going home to eat' : 'hungry: going to eat');
    offer(Math.max(0, 55 - p.hygiene), home, 'going home to shower');
    // A holiday: the trip home when it is over; a trip abroad for those who can afford one.
    if (p.abroad && tick >= (p.trip_until || 0)) { const hub = HUB[p.trip_mode || 'sea']; offer(90, nearestOf(e, ofKinds([hub], local)) || nearestOf(e, ofKinds(['port', 'runway'], local)), `the holiday is over: heading to the ${hub === 'runway' ? 'airport' : 'port'}`); }
    if (p.trip && !p.abroad) offer(80, nearestOf(e, ofKinds([HUB[p.trip_mode || 'sea']])), p.trip_mode === 'air' ? `waiting for a flight to ${countryName(p.trip)}` : `waiting for a ship to ${countryName(p.trip)}`);
    if (!p.abroad && !p.trip && !child && foreign.length && soc.currency && (p.money || 0) > 160 && !workHours) {
      const dest = foreign[Math.floor(rand() * foreign.length)];
      // No holidays in a country at war with this one, or standing off with it.
      const rel = (ctx.diplomacy || {})[[country, dest].sort().join('|')];
      const mode = rel && (rel.status === 'war' || rel.status === 'standoff') ? null : modeFor(dest, p.money || 0);
      if (mode) offer(3 + p.curiosity * 8 + ((p.money || 0) > 300 ? 6 : 0), nearestOf(e, ofKinds([HUB[mode]])), `off on holiday to ${countryName(dest)} by ${mode === 'air' ? 'plane' : 'sea'}`, () => { p.trip = dest; p.trip_mode = mode; });
    }
    if (!child && p.job && p.work && workHours && JOBS[p.job]) offer(30 + p.ambition * 30 + (soc.currency && (p.money || 0) < 20 ? 25 : 0), index.get(p.work), `going to work (${p.job})`);
    if (child && p.age >= 5 && workHours) offer(70, nearestOf(e, ofKinds(r.school_kinds)), 'going to school');
    if (child && p.age < 5) offer(60, home, 'staying home with family');
    if (!child && (p.job === 'unemployed' || (p.ambition > 0.7 && (p.education || 0) < 16)) && workHours) { p.studying = p.job === 'unemployed' || p.ambition > 0.7; offer(25 + p.ambition * 25, nearestOf(e, ofKinds(r.school_kinds)), 'studying for a better job'); }
    if (p.social < 45) {
      let friend = null; let fv = 0;
      for (const o of live) { if (o.id === e.id) continue; const v = relations[pairKey(e.id, o.id)] || 0; if (v >= FRIEND_AT && v > fv) { fv = v; friend = o; } }
      const f = partner || friend;
      offer((50 - p.social) * (0.5 + p.sociability) * 1.2, f || nearestOf(e, fun), f ? `lonely: going to see ${who(f)}` : 'lonely: going somewhere lively');
    }
    offer(8 + p.curiosity * 12 + (p.abroad ? 15 : 0), funHere.length ? funHere[Math.floor(rand() * funHere.length)] : null, p.abroad ? 'sightseeing' : 'free time: going out');
    if (!child && !workHours && !night && soc.currency && (p.money || 0) > 20) { const ent = ofKinds(['cinema', 'theatre', 'bar', 'stadium', 'amusement'], local); offer(10 + p.sociability * 12, ent.length ? ent[Math.floor(rand() * ent.length)] : null, 'an evening out'); }
    if (p.curiosity > 0.7 && !child && rand() < 0.02) { const any = ents.filter((x) => !removed.has(x.id) && x.properties.built === undefined && (['lake', 'bridge', 'tower', 'launch_pad', 'runway', 'barn'].includes(x.kind) || (x.kind === 'heritage_site' && x.properties.reach === country))); offer(15, any.length ? any[Math.floor(rand() * any.length)] : null, 'curious: exploring'); }
    if (!options.length) continue;
    // Keep doing what they are doing unless something matters more.
    const current = p.target || (at && at.id);
    let total = 0; for (const o of options) total += o.w * o.w;
    let x = rand() * total; let choice = options[options.length - 1];
    for (const o of options) { x -= o.w * o.w; if (x <= 0) { choice = o; break; } }
    const best = options.reduce((m, o) => (o.w > m.w ? o : m), options[0]);
    if (best.w > choice.w * 2) choice = best;                      // free, not reckless
    if (choice.goal.id === current) continue;
    if (current && options.some((o) => o.goal.id === current && o.w >= choice.w * 0.8)) continue;
    if (choice.act) choice.act();
    p.target = choice.goal.id;
    emit('decide', `${who(e)} (${e.id}) is heading to ${choice.goal.id} (${choice.why})`, e.id);
  }

  function arrest(e, cop) {
    const days = soc.laws.some((l) => /2 days/.test(l)) ? 2 : 1;
    soc.arrests += 1;
    const pr = soc.prison && index.get(soc.prison);
    if (pr) { e.properties.jail_until = tick + days * daySteps; e.properties.target = pr.id; emit('arrest', `${who(cop)} arrested ${who(e)} for theft: ${days} day${days > 1 ? 's' : ''} in prison`, cop.id); }
    else if (soc.currency) { const fine = Math.min(e.properties.money || 0, 10); e.properties.money = r2((e.properties.money || 0) - fine); soc.treasury = r2(soc.treasury + fine); emit('arrest', `${who(cop)} caught ${who(e)} stealing; with no prison yet, a fine of ${fine} ${soc.currency}`, cop.id); }
  }

  // Matches and shows: a crowd at a stadium or theatre makes the news.
  if (tick % 12 === 0) {
    for (const venue of ofKinds(['stadium', 'theatre'])) {
      const crowd = ents.filter((x) => !removed.has(x.id) && x.properties.at === venue.id && !x.properties.target && (x.kind === 'person' || x.kind === 'child')).length;
      if (crowd >= 4) { soc.shows += 1; emit('show', `${venue.kind === 'stadium' ? 'A match' : 'A show'} at ${venue.properties.name || venue.id} drew ${crowd} people`, venue.id); }
    }
  }

  // --- knowledge and building -------------------------------------------------------------------------
  const before = soc.tech;
  soc.tech = level();
  if (soc.tech > before) emit('technology', `${soc.name ? `${soc.name} reached` : 'The people reached'} ${TECH_LEVELS[soc.tech]} (technology level ${soc.tech})`, null);
  // Research and development, once a day: branch by branch (research.mjs).
  if (tick % (s.day_steps || 240) === 12 && r.progress !== false) {
    const atRisk = Object.entries(ctx.diplomacy || {}).some(([k, d]) => k.split('|').includes(country) && (d.status === 'standoff' || d.status === 'war'));
    const lead = soc.leader && index.get(soc.leader);
    researchStep({ soc, rand, emit, atRisk, hawk: lead ? (lead.properties.ambition || 0) - (lead.properties.honesty || 0) : 0, people: live });
  }
  // A period world builds nothing new (no technology past its time).
  if (tick % 12 === 0 && r.progress !== false) buildStep(r, ctx, { live, index, add, newId, room, emit, soc, rand, ofKinds });
  if (tick % 6 === 0) contactStep(ctx, { live, index, add, newId, room, emit, soc, rand });
  if (tick % 12 === 6) expeditionStep({ soc, ents, removed: ctx.removed, emit, rand, s, add, newId, room, country });
}

// What two people say to each other: from their own lives and the news.
function chatLine(a, b, { soc, relations, techNow, rand, index }) {
  const pa = a.properties; const pb = b.properties;
  const lines = [];
  if (pa.hunger > 60) lines.push(`I'm starving. Want to get something to eat, ${pb.name}?`);
  if (pa.energy < 30) lines.push('I barely slept. I need an early night.');
  if (pa.job && pa.job !== 'unemployed' && pa.job !== 'retired') lines.push(`Busy day at work. Being ${an(pa.job)} is ${pa.ambition > 0.6 ? 'what I always wanted' : 'tiring'}.`);
  if (pa.job === 'unemployed') lines.push('Still looking for work. Do you know anyone hiring?');
  if (pa.partner && index.get(pa.partner)) lines.push(`${index.get(pa.partner).properties.name} and I are doing well.`);
  if ((pa.children || 0) > 0) lines.push(`The kids keep me busy, ${pa.children} of them now.`);
  if (soc.currency && (pa.money || 0) < 15) lines.push(`Money's tight. Everything costs ${soc.currency}s these days.`);
  if (soc.currency && (pa.money || 0) > 150) lines.push(`I've saved up. Thinking of buying something nice for the house.`);
  if (soc.leader && index.get(soc.leader)) { const l = index.get(soc.leader).properties; lines.push(pa.honesty > 0.5 ? `Do you trust ${l.name} to lead us? The tax is ${Math.round(soc.tax * 100)}% now.` : `${l.name} only looks after friends.`); }
  if (soc.crimes > 0 && rand() < 0.3) lines.push('Did you hear about the theft at the shop?');
  if (techNow >= 2) lines.push(techNow >= 4 ? 'They say the rocket goes up again soon. Imagine standing up there.' : techNow >= 3 ? 'I watched a plane take off today. Amazing.' : 'The factory is turning out machines now.');
  if (soc.contacts && soc.contacts.length) lines.push(`Do you think ${soc.contacts[0]} are friendly?`);
  if (soc.colonies > 0) lines.push('My cousin wants to move to the colony out there.');
  if (relations > 200) lines.push(`You're one of my oldest friends, ${pb.name}.`);
  if (pa.curiosity > 0.7) lines.push('Have you ever wondered what lies past the hills?');
  lines.push(`Lovely day, ${pb.name}.`, `How have you been, ${pb.name}?`);
  return lines[Math.floor(rand() * lines.length)];
}

// Building: what the society needs, funded from the treasury, put up by
// builders; technology unlocks more (vehicles, flight, space, colonies).
function buildStep(r, ctx, { live, index, add, newId, room, emit, soc, rand, ofKinds }) {
  const { ents, removed, tick, s } = ctx;
  const builders = live.filter((e) => e.properties.job === 'builder' || e.properties.job === 'engineer');
  // Work on anything under construction.
  for (const site of ents.filter((e) => !removed.has(e.id) && typeof e.properties.built === 'number' && e.properties.built < 100)) {
    const crew = builders.filter((b) => dist2(b, site) < 200).length + (builders.length ? 1 : 0);
    if (!crew) continue;
    site.properties.built = Math.min(100, Math.round(site.properties.built + crew * 6));
    for (const b of builders.slice(0, 3)) if (b.properties.target !== site.id && !b.properties.inside && rand() < 0.5) b.properties.target = site.id;
    if (site.properties.built >= 100) emit('built', `${site.properties.name || site.id} was finished`, site.id);
  }
  if (ents.some((e) => !removed.has(e.id) && typeof e.properties.built === 'number' && e.properties.built < 100)) return;
  if (!builders.length || !soc.currency) return;
  const country = ctx.country || 'home';
  const isl = (ctx.islands || []).find((i) => i.code === country);
  const centre = isl ? { x: isl.x, y: isl.y } : (() => { const hs = ofKinds(r.home_kinds); if (!hs.length) return { x: s.size.x / 2, y: s.size.y / 2 }; let x = 0; let y = 0; for (const h of hs) { x += h.position.x; y += h.position.y; } return { x: x / hs.length, y: y / hs.length }; })();
  const near = (d0) => { const d = isl ? Math.min(d0, isl.r * 0.55) : d0; const a = rand() * Math.PI * 2; return { x: Math.min(s.size.x - 20, Math.max(20, centre.x + Math.cos(a) * d)), y: Math.min(s.size.y - 20, Math.max(20, centre.y + Math.sin(a) * d)), z: 0 }; };
  const site = (kind, cost0, props = {}, pos = null) => {
    const cost = Math.round(cost0 * rdEffects(soc).buildCost);
    if (soc.treasury < cost || !room(40)) return false;
    soc.treasury -= cost;
    const id = newId(kind);
    const name = props.name || null;
    add({ id, kind, position: pos || near(500 + rand() * 500), properties: { built: 0, ...props } });
    emit('construction', `Work began on ${name || `a new ${kind.replace(/_/g, ' ')}`} (${id}), paid from the treasury`, id);
    return true;
  };
  const homes = ofKinds(r.home_kinds).length;
  const people = live.length;
  const has = (k) => ofKinds([k]).length > 0 || ents.some((e) => !removed.has(e.id) && e.kind === k && typeof e.properties.built === 'number' && e.properties.built < 100 && countryAt(e.position, ctx.islands || []) === (ctx.country || 'home'));
  const research = soc.laws.some((l) => /research/.test(l));
  // Government spending: research grants (more under a research law), public works.
  if (soc.treasury > 300) {
    const grant = r2(soc.treasury * (soc.laws.some((l) => /research/.test(l)) ? 0.03 : 0.015));
    soc.treasury = r2(soc.treasury - grant);
    soc.research = r2(soc.research + grant * 0.4 * rdEffects(soc).research);
  }
  // Priorities: a prison once there is crime, homes when crowded, a road to them, services, then technology.
  if (!soc.prison && soc.crimes >= 2 && soc.tech >= 1) { if (site('prison', 150, { name: 'the town prison' })) { soc.prison = ents[ents.length - 1].id; return; } }
  if (!has('police_station') && people >= 30 && soc.tech >= 1) { if (site('police_station', 120, { name: 'the police station' })) return; }
  if (!research && people > homes * 3 && soc.tech >= 1) {
    if (site('house', 60, { color: ['#e8d9c4', '#d9a679', '#b8c7d9', '#f2e6b3'][Math.floor(rand() * 4)], roof: ['#8c3b2e', '#4a4f5c', '#2f5c4a'][Math.floor(rand() * 3)], floors: 1 + Math.floor(rand() * 2) })) {
      const h = ents[ents.length - 1];
      if (rand() < 0.5 && room(1)) {
        const street = STREET_NAMES[soc.streets % STREET_NAMES.length];
        soc.streets += 1;
        add({ id: newId('road'), kind: 'road', position: { x: h.position.x, y: h.position.y - 20, z: 0 }, properties: { name: street, length: 200, width: 12, heading: Math.round(rand() * 4) * 45, built: 0 } });
        emit('construction', `Work began on ${street}`, h.id);
      }
      return;
    }
  }
  // Defence: barracks once there is industry and money; trucks and a patrol boat to go with them.
  const mine = (k) => ofKinds([k]).length;
  if (soc.tech >= 2 && !mine('barracks') && soc.treasury > 400 && (soc.government === 'monarchy' || rand() < 0.5)) { if (site('barracks', 300, { name: `${soc.name || 'The'} Army barracks` })) return; }
  if (mine('barracks') && soc.treasury > 200 && room(80) && rand() < 0.3) {
    const base = ofKinds(['barracks'])[0];
    const own = (k) => ents.filter((v) => !removed.has(v.id) && v.kind === k && v.properties.army === country).length;
    if (own('army_truck') < 2) { soc.treasury -= 80; add({ id: newId('army_truck'), kind: 'army_truck', position: { ...base.position }, properties: { army: country, name: `${soc.name || ''} Army truck`.trim() } }); return; }
    const port = ofKinds(['port'])[0];
    if (port && own('patrol_boat') < 1 && soc.tech >= 3) { soc.treasury -= 150; add({ id: newId('patrol_boat'), kind: 'patrol_boat', position: { x: port.position.x + 30, y: port.position.y, z: 0 }, properties: { army: country, name: `${soc.name || ''} Navy patrol`.trim() } }); return; }
  }
  if (soc.tech >= 1 && people >= 25 && !has('hospital')) { if (site('hospital', 200, { name: 'the hospital' })) return; }
  const kids = live.filter((e) => e.properties.age < r.adult_age).length;
  if (soc.tech >= 1 && kids > 30 * ofKinds(r.school_kinds).length && site('school', 250, { name: `${STREET_NAMES[(soc.streets + 3) % STREET_NAMES.length].split(' ')[0]} School` })) return;
  if (soc.treasury > 1500 && rand() < 0.1) {
    const street = STREET_NAMES[soc.streets % STREET_NAMES.length];
    soc.streets += 1;
    if (site('road', 120, { name: street, length: 300, width: 12, heading: Math.round(rand() * 4) * 45 })) return;
  }
  if (soc.treasury > 1200 && rand() < 0.05 && site(rand() < 0.5 ? 'fountain' : 'cafe', 100, { name: rand() < 0.5 ? 'a new park' : 'a new café' })) return;
  if (soc.tech >= 2 && soc.treasury > 80 && rand() < 0.4) {
    // Industry: the factory turns out cars for those who can afford one.
    const buyer = live.filter((e) => (e.properties.money || 0) > 120 && !e.properties.owns).sort((a, b) => b.properties.money - a.properties.money)[0];
    const fac = ofKinds(['factory'])[0];
    if (buyer && fac && room(80)) {
      buyer.properties.money = r2(buyer.properties.money - 100);
      soc.treasury = r2(soc.treasury + 20);
      const car = add({ id: newId('car'), kind: 'car', position: { ...fac.position }, properties: { owner: buyer.id, color: ['#c0392b', '#2980b9', '#16a085', '#8e44ad', '#ecf0f1'][Math.floor(rand() * 5)] } });
      buyer.properties.owns = car.id;
      emit('bought', `${who(buyer)} bought a new car (${car.id}) from the factory`, buyer.id);
      return;
    }
  }
  if (soc.tech >= 3 && !has('hangar') && site('hangar', 250, { name: 'the airfield hangar' })) return;
  if (soc.tech >= 4 && !ents.some((e) => !removed.has(e.id) && e.kind === 'rocket' && e.properties.owner === 'society') && soc.treasury > 300) {
    const pad = ofKinds(['launch_pad'])[0];
    if (pad && room(1)) { soc.treasury -= 300; add({ id: newId('rocket'), kind: 'rocket', position: { ...pad.position }, properties: { owner: 'society', name: `${soc.currency || 'People'}'s Rocket` } }); emit('construction', 'The people built their own rocket', null); return; }
  }
  // Space colonies: on a planet, once the technology allows.
  if (soc.tech >= 5 && soc.treasury > 400 && soc.colonies < 4) {
    const planets = ents.filter((e) => !removed.has(e.id) && (e.kind === 'planet' || e.kind === 'moon'));
    const target = planets[soc.colonies % Math.max(1, planets.length)];
    if (target && room(1)) {
      soc.treasury -= 400; soc.colonies += 1;
      add({ id: newId('colony'), kind: 'colony', position: { ...target.position }, properties: { name: `${target.properties.name || target.id} Colony`, orbits: target.id, orbit_radius: (Number(target.properties.size) || 60) * 1.4, orbit_period: 60, orbit_altitude: 0, built: 0 } });
      emit('colony', `The people founded a colony at ${target.properties.name || target.id}`, target.id);
    }
  }
}

// Other civilisations: out there from the start; met at interstellar
// technology, or when one of their ships comes calling.
function contactStep(ctx, { live, index, add, newId, room, emit, soc, rand }) {
  const { ents, removed } = ctx;
  const civs = ents.filter((e) => !removed.has(e.id) && e.kind === 'alien_world');
  for (const w of civs) {
    const name = w.properties.name || CIV_NAMES[0];
    if (soc.contacts.includes(name)) continue;
    // Only an explorer that actually gets there makes contact (a deep-space
    // expedition, buildStep, at interstellar technology).
    const explorer = ents.find((e) => !removed.has(e.id) && (e.kind === 'shuttle' || e.kind === 'rocket') && Math.hypot(e.position.x - w.position.x, e.position.y - w.position.y, (e.position.z || 0) - (w.position.z || 0)) < 400);
    if (explorer) {
      soc.contacts.push(name);
      emit('first_contact', `First contact: ${explorer.properties.name || explorer.id} reached the world of ${name}, and its crew met them`, w.id);
      continue;
    }
    // Their ships come very rarely, and only to a people who already fly to space.
    if (soc.tech >= 5 && rand() < 0.0004 && room(4) && !ents.some((e) => !removed.has(e.id) && e.kind === 'alien_ship')) {
      const ship = add({ id: newId('alien_ship'), kind: 'alien_ship', position: { ...w.position }, properties: { name: `a ship of ${name}`, civ: name, target: (ents.find((e) => e.kind === 'fountain') || live[0]).id } });
      emit('sighting', `Astronomers saw a strange craft leave a far world (${name}); it is heading this way (${ship.id})`, ship.id);
    }
  }
  const ship = ents.find((e) => !removed.has(e.id) && e.kind === 'alien_ship' && !e.properties.target);
  if (ship && !soc.contacts.includes(ship.properties.civ)) {
    soc.contacts.push(ship.properties.civ);
    emit('first_contact', `First contact: a ship of ${ship.properties.civ} landed and its crew met the people`, ship.id);
    if (room(2)) for (let i = 0; i < 2; i++) add({ id: newId('alien'), kind: 'alien', position: { x: ship.position.x + 4 + i * 2, y: ship.position.y, z: 0 }, properties: { name: ['Ixa', 'Moru', 'Tal', 'Vesh'][Math.floor(rand() * 4)], civ: ship.properties.civ } });
  }
}

// --- awareness: working out what their world is ----------------------------------------------
//
// Evidence comes from what they can actually observe:
//   - an expedition ship reaching the end of the sea finds a hard, flat edge
//     (edge_seen: the world's bounds): 25 points the first time, less each
//     time after
//   - a craft climbing to the top of the sky finds it cannot go higher
//     (sky_seen: the world's ceiling): the same
//   - their best scientists studying physics at spaceflight or beyond: a
//     very little every step, more for the curious and the highly educated
// With 100 points, both the edge and the roof seen, and a scientist curious
// and learned enough, someone
// proposes that the world was made and is watched (level 1). Testing it
// needs interstellar technology and luck (level 2: they find the jumps in
// time and the same result, exactly, every time). Then they try to reach
// whoever watches: they raise a monument with a message and keep it in
// their records, the only place an observer is sure to read (level 3, and
// again every few days, at most 5 messages). Nothing here tells them; it
// is rare and slow on purpose.
export const AWARENESS_LEVELS = Object.freeze(['unaware', 'suspects it was made', 'has tested it', 'is trying to reach whoever watches']);
const MESSAGE_LINES = [
  (w) => `To whoever watches over ${w.place}: we are the people of ${w.place}. We found the edge of our sea and the roof of our sky. We know you are there.`,
  (w) => `${w.author} writes: every experiment repeats to the last digit, and time moves in tiny jumps. If this was made, we would like to know why.`,
  (w) => `We mean no harm. We have built ${w.count} homes and raised ${w.children} children. If you can hear us, change one small thing near this stone.`,
  (w) => `This is message ${w.n} from ${w.place}. ${w.leader ? `${w.leader} speaks for us.` : ''} We will keep listening at the monument.`,
  (w) => `To the watcher: we are not afraid. Tell us what you want us to learn.`
];
export function awarenessStep(ctx, { awareness, societies, emit, rand, tick, ents, removed, add, room, newId, s, daySteps = 240 }) {
  const people = ents.filter((e) => !removed.has(e.id) && (e.kind === 'person' || e.kind === 'child'));
  const scientists = people.filter((e) => e.properties.job === 'scientist' || e.properties.job === 'astronaut');
  const topTech = Math.max(0, ...Object.values(societies).map((x) => x.tech || 0));
  // Observations at the edges (the engine's travel rule clamps there).
  for (const v of ents) {
    if (removed.has(v.id) || !['ship', 'ferry', 'boat', 'shuttle', 'rocket'].includes(v.kind) || !v.properties.expedition) continue;
    const atEdge = v.position.x <= 1 || v.position.y <= 1 || v.position.x >= s.size.x - 1 || v.position.y >= s.size.y - 1;
    const atTop = (v.position.z || 0) >= s.size.z - 1;
    if (atEdge && v.properties.expedition === 'edge') { awareness.edge_seen += 1; awareness.evidence = r2(awareness.evidence + 25 / awareness.edge_seen); delete v.properties.expedition; emit('discovery', `The expedition aboard ${v.properties.name || v.id} reached the end of the sea: the water stops at a flat, invisible wall that nothing can pass`, v.id); }
    if (atTop && v.properties.expedition === 'sky') { awareness.sky_seen += 1; awareness.evidence = r2(awareness.evidence + 25 / awareness.sky_seen); delete v.properties.expedition; emit('discovery', `${v.properties.name || v.id} climbed as high as it could go: above a certain height there is nothing to climb into`, v.id); }
  }
  if (topTech >= 4) for (const sci of scientists) awareness.evidence = r2(awareness.evidence + 0.0008 * (sci.properties.curiosity || 0) * ((sci.properties.education || 0) / 20));
  // Level 1: a hypothesis.
  // Both the edge of the sea and the roof of the sky must have been seen.
  if (awareness.level === 0 && awareness.evidence >= 100 && awareness.edge_seen > 0 && awareness.sky_seen > 0) {
    const thinker = scientists.filter((x) => (x.properties.curiosity || 0) > 0.85 && (x.properties.education || 0) >= 18).sort((a, b) => b.properties.curiosity - a.properties.curiosity)[0];
    if (thinker) {
      awareness.level = 1; awareness.hypothesis_by = thinker.id;
      emit('hypothesis', `${who(thinker)} published a startling idea: the edge of the sea, the roof of the sky and laws that never vary suggest that everything around them was made, and is watched`, thinker.id);
    }
  }
  // Level 2: a test, at interstellar technology, a few tries a day.
  if (awareness.level === 1 && topTech >= 6 && tick % 40 === 0 && rand() < 0.08) {
    awareness.level = 2;
    const by = ents.find((x) => x.id === awareness.hypothesis_by) || scientists[0];
    emit('proof', `${by ? who(by) : 'Their scientists'} ran the same experiment a thousand times and got exactly the same result, to the last digit, and measured time moving in tiny, equal jumps`, by ? by.id : null);
  }
  // Level 3: a message to whoever watches, left where they are sure to look.
  if (awareness.level >= 2 && awareness.messages.length < 5 && tick >= (awareness.next_try || 0) && room(1)) {
    const home = Object.entries(societies).sort((a, b) => (b[1].tech || 0) - (a[1].tech || 0))[0];
    const soc = home ? home[1] : {};
    const by = ents.find((x) => x.id === awareness.hypothesis_by && !removed.has(x.id)) || scientists[0] || people[0];
    const n = awareness.messages.length + 1;
    const leader = soc.leader ? ents.find((x) => x.id === soc.leader) : null;
    const text = MESSAGE_LINES[(n - 1) % MESSAGE_LINES.length]({ place: soc.name || 'our home', author: by ? who(by) : 'One of us', count: ents.filter((x) => ['house', 'apartment', 'cabin'].includes(x.kind)).length, children: people.filter((x) => x.kind === 'child').length, n, leader: leader ? who(leader) : null });
    const spot = by ? by.position : { x: s.size.x / 2, y: s.size.y / 2 };
    if (n === 1) add({ id: newId('monument'), kind: 'monument', position: { x: spot.x + 8, y: spot.y + 8, z: 0 }, properties: { name: 'the Listening Stone', text: text.slice(0, 200) } });
    awareness.level = 3;
    awareness.messages.push({ n, tick, text: text.slice(0, 400), by: by ? by.id : null });
    awareness.next_try = tick + daySteps * 3;
    emit('message_to_observer', text.slice(0, 400), by ? by.id : null);
  }
}

// Expeditions to the edge of the sea and the top of the sky (buildStep, flight and spaceflight).
export function expeditionStep({ soc, ents, removed, emit, rand, s, add, newId, room, country }) {
  if (soc.tech >= 3 && soc.treasury > 600 && rand() < 0.004 && !ents.some((v) => !removed.has(v.id) && v.properties.expedition === 'edge')) {
    const ship = ents.find((v) => !removed.has(v.id) && (v.kind === 'ship' || v.kind === 'boat') && !ents.some((x) => x.properties.inside === v.id));
    if (ship) {
      soc.treasury = r2(soc.treasury - 150);
      const side = Math.floor(rand() * 4);
      Object.assign(ship.properties, { expedition: 'edge', target_x: side === 0 ? 0 : side === 1 ? s.size.x : rand() * s.size.x, target_y: side === 2 ? 0 : side === 3 ? s.size.y : rand() * s.size.y });
      delete ship.properties.target;
      emit('expedition', `${soc.name || 'The people'} sent ${ship.properties.name || ship.id} to find where the sea ends`, ship.id);
    }
  }
  if (soc.tech >= 4 && soc.treasury > 900 && rand() < 0.003 && !ents.some((v) => !removed.has(v.id) && v.properties.expedition === 'sky')) {
    const craft = ents.find((v) => !removed.has(v.id) && (v.kind === 'rocket' || v.kind === 'shuttle'));
    if (craft) {
      soc.treasury = r2(soc.treasury - 300);
      Object.assign(craft.properties, { expedition: 'sky', target_x: craft.position.x, target_y: craft.position.y, target_z: s.size.z });
      delete craft.properties.target;
      emit('expedition', `${soc.name || 'The people'} sent ${craft.properties.name || craft.id} as high as it can climb`, craft.id);
    }
  }
  // A deep-space expedition to a far world, at interstellar technology.
  if (soc.tech >= 6 && soc.treasury > 3000 && rand() < 0.02) {
    const far = ents.filter((w) => !removed.has(w.id) && w.kind === 'alien_world' && !soc.contacts.includes(w.properties.name));
    const craft = ents.find((v) => !removed.has(v.id) && v.kind === 'shuttle' && !v.properties.expedition);
    if (far.length && craft) {
      soc.treasury = r2(soc.treasury - 2000);
      const w = far[Math.floor(rand() * far.length)];
      Object.assign(craft.properties, { expedition: 'deep', target: w.id });
      emit('expedition', `${soc.name || 'The people'} launched a deep-space expedition aboard ${craft.properties.name || craft.id} toward a far world`, craft.id);
    }
  }
}

// --- between countries: friendship, disputes, alliances, standoffs, talks, war --------------
//
// diplomacy: { "a|b": { score, status, since } }, score -100..100. Tourism
// and trade (holiday arrivals) warm relations; leaders who are ambitious
// and dishonest strain them; now and then a dispute flares or a trade deal
// is struck. Above 60 they become allies.
//
// Below -60 the two stand off: their armies mobilise (soldiers to their own
// harbours, patrol boats out) and talks begin. Talks, and an ally of both
// mediating, usually end it early; otherwise a peace treaty after a few
// days. War is the last resort, not the habit: only when relations are at
// their worst (-85 or below) when the talks run out, a leader is a hawk,
// both sides have soldiers, and a dice roll goes that way (a democracy's
// people are less willing). A war is a few clashes between soldiers: some
// die, both treasuries pay, tourism between them stops, and weariness grows
// with every loss until an armistice; the side that lost more pays
// reparations. Relations stay cold afterwards. Civilians are not targeted.
export const WAR_SCORE = -85;
export const WAR_MAX_DAYS = 6;
export function emptyDiplomacy() { return {}; }
export function diplomacyStep({ diplomacy, societies, ents, removed, emit, rand, tick, daySteps = 240, peaceful = false }) {
  const codes = Object.keys(societies).filter((c) => societies[c] && societies[c].name);
  if (codes.length < 2 || tick % 24 !== 0) return;
  // peaceful (a period world inspired by real peoples): no disputes,
  // standoffs or wars are invented; trade and visits warm relations.
  if (peaceful) {
    for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) {
      const key = `${codes[i]}|${codes[j]}`;
      const d = diplomacy[key] || (diplomacy[key] = { score: 10, status: 'peace', since: tick, tourists: 0 });
      const t = (societies[codes[i]].tourists || 0) + (societies[codes[j]].tourists || 0);
      d.score += Math.min(4, (t - (d.tourists || 0)) * 0.5); d.tourists = t;
      d.score = Math.max(-100, Math.min(100, Math.round(d.score * 10) / 10 * 0.99));
      if (d.status !== 'alliance' && d.score >= 60) { d.status = 'alliance'; d.since = tick; emit('alliance', `${societies[codes[i]].name} and ${societies[codes[j]].name} became close partners in trade`, null); }
      else if (d.status === 'alliance' && d.score < 30) { d.status = 'peace'; d.since = tick; }
    }
    return;
  }
  const leaderOf = (c) => ents.find((e) => e.id === societies[c].leader && !removed.has(e.id));
  const hawk = (l) => (l ? (l.properties.ambition || 0) - (l.properties.honesty || 0) : 0);
  const soldiersOf = (c) => ents.filter((e) => !removed.has(e.id) && e.properties.job === 'soldier' && e.properties.country === c && !e.properties.jail_until);
  const r2 = (n) => Math.round(n * 100) / 100;
  for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) {
    const a = codes[i]; const b = codes[j]; const key = `${a}|${b}`;
    const d = diplomacy[key] || (diplomacy[key] = { score: 10, status: 'peace', since: tick, tourists: 0 });
    const A = societies[a]; const B = societies[b];
    const la = leaderOf(a); const lb = leaderOf(b);
    if (d.status === 'war') { warDay(a, b, A, B, d); continue; }
    // Tourism since the last look warms things.
    const t = (A.tourists || 0) + (B.tourists || 0);
    d.score += Math.min(4, (t - (d.tourists || 0)) * 0.5); d.tourists = t;
    d.score -= Math.max(0, hawk(la) + hawk(lb)) * 1;
    if (rand() < 0.006) { d.score -= 25; emit('dispute', `A dispute flared between ${A.name} and ${B.name} over fishing waters`, null); }
    if (rand() < 0.01) { d.score += 20; emit('treaty', `${A.name} and ${B.name} signed a trade agreement`, null); }
    d.score = Math.max(-100, Math.min(100, Math.round(d.score * 10) / 10 * 0.99));
    if (d.status !== 'standoff' && d.score <= -60) {
      d.status = 'standoff'; d.since = tick;
      emit('standoff', `${A.name} and ${B.name} broke off talks; both armies are on alert`, null);
      for (const c of [a, b]) mobilise(c, true);
    } else if (d.status === 'standoff') {
      // Talks first: honest leaders, and an ally of both, make peace likelier.
      const mediator = codes.find((c) => c !== a && c !== b && ['alliance'].includes((diplomacy[[a, c].sort().join('|')] || {}).status) && ['alliance'].includes((diplomacy[[b, c].sort().join('|')] || {}).status));
      const talks = 0.03 + 0.03 * ((la ? la.properties.honesty || 0 : 0) + (lb ? lb.properties.honesty || 0 : 0)) + (mediator ? 0.08 : 0);
      if (rand() < talks) { endStandoff(A, B, d, mediator ? `with ${societies[mediator].name} mediating` : 'after talks'); for (const c of [a, b]) mobilise(c, false); continue; }
      if (tick - d.since < daySteps * 3) continue;
      // The talks have run out: war only at the very worst, with a hawk in charge.
      const worst = d.score <= WAR_SCORE;
      const hawkish = Math.max(hawk(la), hawk(lb)) > 0.3;
      const armed = soldiersOf(a).length > 0 && soldiersOf(b).length > 0;
      // Mutual deterrence: when both hold a nuclear deterrent, war is far less likely.
      const willing = 0.35 * ([A, B].some((x) => x.government === 'democracy') ? 0.5 : 1) * (rdEffects(A).deterrent && rdEffects(B).deterrent ? 0.15 : 1);
      if (worst && hawkish && armed && rand() < willing) {
        const aggressor = hawk(la) >= hawk(lb) ? A : B;
        d.status = 'war'; d.since = tick; d.war = { started: tick, losses: { [a]: 0, [b]: 0 }, weariness: 0, clashes: 0 };
        d.wars = (d.wars || 0) + 1;
        for (const x of [A, B]) x.wars = (x.wars || 0) + 1;
        emit('war_declared', `${aggressor.name} declared war on ${aggressor === A ? B.name : A.name} after talks failed`, null);
      } else {
        endStandoff(A, B, d, 'when the talks ran their course');
        for (const c of [a, b]) mobilise(c, false);
      }
    } else if (d.status === 'peace' && d.score >= 60) {
      d.status = 'alliance'; d.since = tick;
      emit('alliance', `${A.name} and ${B.name} became allies`, null);
    } else if (d.status === 'alliance' && d.score < 30) { d.status = 'peace'; d.since = tick; }
  }
  function endStandoff(A, B, d, how) {
    d.status = 'peace'; d.score = 0; d.since = tick;
    emit('treaty', `${A.name} and ${B.name} signed a peace treaty ${how}; their armies stood down`, null);
  }
  // One look at a war (every 24 steps): maybe a clash, the cost, the weariness, maybe an armistice.
  function warDay(a, b, A, B, d) {
    const w = d.war;
    for (const x of [A, B]) x.treasury = r2(Math.max(0, (x.treasury || 0) - 6));
    if (rand() < 0.3) {
      const sa = soldiersOf(a); const sb = soldiersOf(b);
      if (sa.length && sb.length) {
        const strength = (list, x) => list.length * rdEffects(x).army * (0.6 + rand() * 0.8);
        const aWins = strength(sa, A) >= strength(sb, B);
        const [loserC, loserList, winC, winList] = aWins ? [b, sb, a, sa] : [a, sa, b, sb];
        w.clashes += 1;
        const fallen = [];
        if (rand() < 0.6) fallen.push([loserC, loserList[Math.floor(rand() * loserList.length)]]);
        if (rand() < 0.2) fallen.push([winC, winList[Math.floor(rand() * winList.length)]]);
        emit('battle', `Soldiers of ${A.name} and ${B.name} clashed at sea; ${societies[winC].name} held the waters${fallen.length ? `, ${fallen.length} fell` : ', no one fell'}`, null);
        for (const [c, s2] of fallen) {
          removed.add(s2.id); w.losses[c] += 1; societies[c].deaths = (societies[c].deaths || 0) + 1;
          societies[c].war_dead = (societies[c].war_dead || 0) + 1;
          const partner = s2.properties.partner && ents.find((e) => e.id === s2.properties.partner);
          if (partner) { delete partner.properties.partner; partner.properties.mood = 'grieving'; }
          emit('death', `${s2.properties.name || s2.id}${s2.properties.family ? ' ' + s2.properties.family : ''} (${s2.id}), a soldier of ${societies[c].name}, died in the war`, s2.id);
        }
      }
    }
    w.weariness += 1 + (w.losses[a] + w.losses[b]) * 0.5;
    const out = soldiersOf(a).length === 0 || soldiersOf(b).length === 0;
    if (out || w.weariness >= 14 + rand() * 10 || tick - w.started >= daySteps * WAR_MAX_DAYS) {
      const [loser, winner] = w.losses[a] > w.losses[b] || (w.losses[a] === w.losses[b] && soldiersOf(a).length < soldiersOf(b).length) ? [A, B] : [B, A];
      const reparations = r2(Math.min(500, (loser.treasury || 0) * 0.2));
      loser.treasury = r2(loser.treasury - reparations); winner.treasury = r2((winner.treasury || 0) + reparations);
      emit('armistice', `${A.name} and ${B.name} signed an armistice; ${w.losses[a] + w.losses[b]} soldiers died. ${loser.name} pays ${Math.round(reparations)}${loser.currency ? ' ' + loser.currency : ''} in reparations`, null);
      d.status = 'peace'; d.score = -40; d.since = tick; d.last_war = { started: w.started, ended: tick, dead: w.losses[a] + w.losses[b], loser: loser.name };
      delete d.war;
      for (const c of [a, b]) mobilise(c, false);
    }
  }
  function mobilise(code, on) {
    for (const e of ents) {
      if (removed.has(e.id)) continue;
      if (e.properties.job === 'soldier' && e.properties.country === code) {
        if (on) { const port = ents.find((x) => x.kind === 'port' && countryOfPort(x) === code); if (port) e.properties.target = port.id; e.properties.on_alert = true; }
        else delete e.properties.on_alert;
      }
      if (e.kind === 'patrol_boat' && e.properties.army === code) {
        if (on) { e.properties.target_x = e.position.x + (rand() - 0.5) * 1600; e.properties.target_y = e.position.y + (rand() - 0.5) * 1600; }
      }
    }
  }
  function countryOfPort(x) { return typeof x.properties.country === 'string' ? x.properties.country : (x.id.startsWith('port-') ? x.id.slice(5) : null); }
}

// The army meets visitors from elsewhere: soldiers go to a landed alien ship.
export function armyResponse({ ents, removed, emit }) {
  const ship = ents.find((e) => !removed.has(e.id) && e.kind === 'alien_ship' && !e.properties.target && !e.properties.met_by_army);
  if (!ship) return;
  const soldiers = ents.filter((e) => !removed.has(e.id) && e.properties.job === 'soldier').slice(0, 8);
  if (!soldiers.length) return;
  for (const s2 of soldiers) s2.properties.target = ship.id;
  ship.properties.met_by_army = true;
  emit('army_response', `${soldiers.length} soldiers went to meet the landed craft (${ship.id}), weapons lowered`, ship.id);
}

// --- trade between peoples, and what a period world scripts (benin-warri) ----------------------
//
// Canoes (and ships) carry trade: when one of a people's canoes reaches
// another people's landing, or a ship's anchorage, the goods the sources
// name are exchanged (docs/sandbox-benin-warri.md: W14, W15, N1, B6), both
// treasuries gain a little and relations warm. Goods only: the simulation
// never models buying, selling or owning people.
// Also: porters walk between the two places they serve; a heritage site
// is discovered once when someone first reaches it; and a fictional,
// labelled storyline lands its travellers when their ship comes in.
export const TRADE_GOODS = Object.freeze({
  itsekiri: 'fish', urhobo: 'farm produce', ijaw: 'fish and salt', edo: 'cloth, ivory and pepper', portuguese: 'coral beads and brass manillas'
});
export function tradeStep({ ents, removed, emit, societies, diplomacy, islands, tick }) {
  const live = (e) => !removed.has(e.id);
  const byId = new Map(ents.filter(live).map((e) => [e.id, e]));
  const peopleOf = (code) => (code === 'portuguese' ? { name: 'the Portuguese', culture: 'portuguese' } : societies[code] ? { name: societies[code].name || code, culture: societies[code].culture } : null);
  const countryOf = (x) => (typeof x.properties.country === 'string' && x.properties.country ? x.properties.country : countryAt(x.position, islands));
  // Trade at a landing or an anchorage.
  for (const v of ents) {
    if (!live(v) || (v.kind !== 'canoe' && v.kind !== 'carrack') || v.properties.target || typeof v.properties.at !== 'string') continue;
    if (v.properties.traded_at === v.properties.at) continue;
    const place = byId.get(v.properties.at);
    if (!place || (place.kind !== 'canoe_landing' && place.kind !== 'anchorage')) continue;
    v.properties.traded_at = place.id;
    const from = v.kind === 'carrack' ? 'portuguese' : countryOf(v);
    const to = place.kind === 'anchorage' ? (v.kind === 'carrack' ? null : 'portuguese') : countryOf(place);
    if (!to || to === from) continue;
    const A = peopleOf(from); const B = peopleOf(to);
    if (!A || !B) continue;
    for (const c of [from, to]) if (societies[c]) societies[c].treasury = Math.round(((societies[c].treasury || 0) + 2) * 100) / 100;
    const key = [from, to].sort().join('|');
    if (diplomacy[key]) diplomacy[key].score = Math.min(100, (diplomacy[key].score || 0) + 1);
    for (const c of [from, to]) if (societies[c]) societies[c].trades = (societies[c].trades || 0) + 1;
    emit('trade', `Traders from ${A.name} brought ${TRADE_GOODS[A.culture] || 'goods'} to ${place.properties.name || place.id} and went home with ${TRADE_GOODS[B.culture] || 'goods'} (${B.name})`, v.id);
  }
  // Porters: back and forth between the two places they serve.
  for (const e of ents) {
    if (!live(e) || e.kind !== 'porter' || e.properties.target) continue;
    const a = e.properties.from; const b = e.properties.to;
    if (typeof a !== 'string' || typeof b !== 'string' || !byId.has(a) || !byId.has(b)) continue;
    e.properties.target = e.properties.at === a ? b : a;
  }
  // A heritage site, discovered once.
  for (const site of ents) {
    if (!live(site) || site.kind !== 'heritage_site' || site.properties.discovered_by) continue;
    const finder = ents.find((x) => live(x) && (x.kind === 'person' || x.kind === 'child') && x.properties.at === site.id);
    if (!finder) continue;
    site.properties.discovered_by = finder.id;
    emit('discovery', `${finder.properties.name || finder.id}${finder.properties.family ? ` ${finder.properties.family}` : ''} came upon ${site.properties.name || 'an old site'}: ${site.properties.finds || 'old things in the ground'}`, finder.id);
  }
  // A labelled storyline: its travellers land when their ship anchors off their home.
  for (const e of ents) {
    if (!live(e) || typeof e.properties.storyline !== 'string' || typeof e.properties.inside !== 'string') continue;
    const ship = byId.get(e.properties.inside);
    if (!ship || ship.properties.target || typeof ship.properties.at !== 'string') continue;
    const anchorage = byId.get(ship.properties.at);
    if (!anchorage || anchorage.kind !== 'anchorage' || anchorage.properties.country !== e.properties.country) continue;
    const landing = byId.get(anchorage.properties.landing);
    if (!landing) continue;
    const party = ents.filter((x) => live(x) && x.properties.inside === ship.id && x.properties.storyline === e.properties.storyline);
    for (const x of party) { delete x.properties.inside; x.position = { x: landing.position.x + 3, y: landing.position.y, z: 0 }; x.properties.at = landing.id; }
    const names = party.map((x) => `${x.properties.name}${x.properties.family ? ` ${x.properties.family}` : ''}`);
    emit('storyline', `Storyline (fictional, inspired by history): ${names[0]} came home from years of study in Lisbon${names.length > 1 ? `, with ${names.slice(1).join(' and ')}` : ''}, and landed at ${landing.properties.name || landing.id}`, e.id);
    for (const x of party) delete x.properties.storyline;
  }
}
