// PG1 SANDBOX: the wider cosmos, run by the `cosmos` rule (engine.mjs):
// other civilisations with lives of their own, what the inhabitants meet
// after first contact, and the hazards of space. A simulation: rules and
// seeded dice, no AI engine, the same world and seed always giving the
// same result.
//
//   Other civilisations (alien_world entities)
//     Each has a technology level on the inhabitants' own ladder (0
//     settlement ... 6 interstellar travel) or beyond it (7, far beyond):
//     set by the template (properties.tech) or, if not, from the world's
//     seed. They research and rise a level now and then, and at space
//     colonies (5) found outposts of their own (colony entities with a
//     `civ`), at most two each. They are met only as society.mjs allows
//     (contactStep): this file never makes first contact.
//
//   They govern themselves: each has a government (council, monarchy,
//     democracy or collective) and a leader whose temper, hawk or dove,
//     colours its dealings; leaders change in each one's own way; wealth
//     and technology build their fleets.
//
//   Between peoples who have met (relationsStep, below)
//     The way the inhabitants' countries deal with each other: exchange of
//     goods, learning and culture warms relations (the less advanced learn
//     a little from the more advanced). With `conflict: true` on the rule,
//     hawkish leaders, rivalry for the same worlds and incidents strain
//     them; standoffs with talks and mediation; and war only at the very
//     worst, after the talks fail, with a hawk leading: fought between
//     ships in space, never on anyone's ground, with losses, weariness, an
//     armistice and reparations. Without the rule: peace only.
//
//   Hazards (`hazards: false` turns them off)
//     For craft in space with people aboard:
//       radiation belts   round the home world (a band above the space
//                         altitude) and round worlds with a belt
//                         (properties belt_inner and belt_outer, times its size)
//       solar flares      every few days, for a while: a dose to everyone
//                         in space
//       meteoroids        in the asteroid field (where the star's asteroids
//                         orbit, else the widest gap between orbits):
//                         damage to a craft
//     Shielding grows with the owner's technology. A crew's dose
//     (properties.rad_dose) past a limit means radiation sickness (ill
//     for a few days; never fatal here) and the craft turns back; a craft
//     damaged past a limit turns back too (mission_abort).
//
//   Impacts (impactStep, with the hazards): now and then a meteorite strikes
//     a moon or planet, or the home world: never a building or a person. On
//     land it leaves a crater (kind crater; the oldest go when there are
//     many); at sea, a splash. People nearby go to look, and the scientists
//     study what fell (research).
//
// State: state.cosmos = { civs: { [world id]: { tech, research, outposts,
// treasury, fleet, government, leader, term } }, relations: { "a|b": ... },
// flare_until, next_flare, next_impact }.

import { TECH_LEVELS } from './society.mjs';
import { terrainOf } from './movement.mjs';

export const CIV_LEVELS = Object.freeze([...TECH_LEVELS, 'far beyond interstellar travel']);
const CREWED = ['rocket', 'shuttle', 'alien_ship'];
const DOSE_SICK = 60;
const DAMAGE_ABORT = 60;
const r2 = (n) => Math.round(n * 100) / 100;

export function emptyCosmos() { return { civs: {}, flare_until: 0, next_flare: 0 }; }

const hash = (str) => { let h = 2166136261; for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; };

// A civilisation's record, made the first time it is seen.
export function civFor(cosmos, w, seed = 0) {
  if (!cosmos.civs[w.id]) {
    const t = Number(w.properties.tech);
    const tech = Number.isFinite(t) ? Math.max(0, Math.min(7, Math.round(t))) : hash(`${w.id}|${seed}`) % 8;
    const GOVS = ['council', 'monarchy', 'democracy', 'collective'];
    const h = hash(`${w.id}|gov|${seed}`);
    cosmos.civs[w.id] = { name: w.properties.name || w.id, tech, research: 0, outposts: 0, treasury: 1000 + (h % 9) * 250, fleet: Math.max(0, tech - 2) * 2, government: GOVS[h % GOVS.length], leader: leaderFor(w.id, 0, seed), term: 0 };
  }
  return cosmos.civs[w.id];
}

// Each civilisation governs itself: a government, and a leader whose
// temper (hawk > 0, dove < 0) colours its dealings with others. Leaders
// change: a democracy holds elections, a council rotates, a collective
// re-forms its consensus, a monarch rules long.
const TERM_DAYS = { democracy: 20, council: 30, collective: 45, monarchy: 120 };
function leaderFor(id, term, seed) { const h = hash(`${id}|leader|${term}|${seed}`); return { temper: r2(((h % 1000) / 1000) * 1.3 - 0.55), title: ['First Speaker', 'Sovereign', 'President', 'Voice of the Many'][(h >> 10) % 4] }; }

// Shielding against radiation and debris: 0 (none) to 0.9, by technology.
export const shieldOf = (tech) => Math.max(0, Math.min(0.9, (Number(tech) || 0) * 0.13));

export function cosmosStep(r, { s, ents, removed, societies, cosmos, emit, rand, tick, add, room, newId }) {
  const daySteps = s.day_steps || 240;
  const live = (e) => !removed.has(e.id);
  const worlds = ents.filter((e) => live(e) && e.kind === 'alien_world');
  const socs = Object.entries(societies || {});
  const civByName = new Map();
  for (const w of worlds) { const c = civFor(cosmos, w, s.seed); civByName.set(c.name, { c, w }); }

  // Once a day: the civilisations' own progress, and life after contact.
  if (tick % daySteps === 0) {
    for (const w of worlds) {
      const c = cosmos.civs[w.id];
      if (c.tech < 7) {
        c.research = r2(c.research + (1 + c.tech) * (0.5 + rand()));
        const need = Math.round(60 * Math.pow(c.tech + 1, 1.7));
        if (c.research >= need) { c.research = 0; c.tech += 1; emit('civ_progress', `Far away, ${c.name} reached ${CIV_LEVELS[c.tech]} (observed; the inhabitants do not know)`, w.id); }
      }
      // Outposts of their own, on worlds no one has settled.
      if (c.tech >= 5 && c.outposts < 2 && rand() < 0.05 && room(1)) {
        const taken = new Set(ents.filter((e) => live(e) && e.kind === 'colony').map((e) => e.properties.orbits));
        const free = ents.filter((e) => live(e) && (e.kind === 'planet' || e.kind === 'moon') && !taken.has(e.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
        if (free.length) {
          const target = free[Math.floor(rand() * free.length)];
          c.outposts += 1;
          add({ id: newId('colony'), kind: 'colony', position: { ...target.position }, properties: { name: `${c.name} outpost`, civ: c.name, owner: 'civ', orbits: target.id, orbit_radius: (Number(target.properties.size) || 60) * 1.4, orbit_period: 60, orbit_altitude: 0 } });
          emit('civ_outpost', `${c.name} founded an outpost at ${target.properties.name || target.id} (observed)`, target.id);
        }
      }
    }
    // Leaders change, by each civilisation's own way.
    for (const w of worlds) {
      const c = cosmos.civs[w.id];
      if (Math.floor(tick / daySteps) % (TERM_DAYS[c.government] || 30) === 0) {
        c.term = (c.term || 0) + 1; c.leader = leaderFor(w.id, c.term, s.seed);
        emit('civ_leader', `${c.name} have a new leader (${c.government}): ${c.leader.temper > 0.3 ? 'a hawk' : c.leader.temper < -0.2 ? 'a dove' : 'a pragmatist'} (observed)`, w.id);
      }
      // Fleets grow with wealth and technology.
      c.treasury = r2(c.treasury + 20 * (1 + c.tech));
      if (c.tech >= 4 && c.treasury > 600 && c.fleet < 2 + c.tech * 2) { c.treasury = r2(c.treasury - 400); c.fleet += 1; }
    }
  }
  // Relations, every 24 steps, the way the countries' are (society.mjs diplomacyStep).
  if (tick % 24 === 0) relationsStep(r, { s, ents, removed, societies, cosmos, emit, rand, tick, daySteps, civByName, worlds });

  if (r.hazards === false) return;
  impactStep({ s, ents, removed, societies, cosmos, emit, rand, tick, add, room, newId, daySteps });
  // Hazards for crewed craft in space.
  const spaceAt = typeof s.space_altitude === 'number' ? s.space_altitude : 2000;
  if (!cosmos.next_flare) cosmos.next_flare = tick + Math.round(daySteps * (1 + rand() * 3));
  const flaring = tick < cosmos.flare_until;
  if (tick >= cosmos.next_flare) {
    cosmos.flare_until = tick + Math.round(10 + rand() * 20);
    cosmos.next_flare = cosmos.flare_until + Math.round(daySteps * (1.5 + rand() * 3));
    if (ents.some((e) => live(e) && CREWED.includes(e.kind) && (e.position.z || 0) > spaceAt)) emit('flare', 'A solar flare: a storm of radiation sweeps through space', null);
  }
  const belts = ents.filter((e) => live(e) && Number(e.properties.belt_outer) > Number(e.properties.belt_inner)).map((e) => ({ e, inner: Number(e.properties.belt_inner) * (Number(e.properties.size) || 60), outer: Number(e.properties.belt_outer) * (Number(e.properties.size) || 60) }));
  const star = ents.find((e) => live(e) && e.kind === 'star');
  const rocks = star ? ents.filter((e) => live(e) && e.kind === 'asteroid' && e.properties.orbits === star.id).map((e) => Number(e.properties.orbit_radius)).filter((x) => x > 0) : [];
  const field = !star ? null : rocks.length ? { inner: Math.min(...rocks) - 60, outer: Math.max(...rocks) + 60 } : asteroidField(ents.filter((e) => live(e) && e.properties.orbits === star.id).map((e) => Number(e.properties.orbit_radius)).filter((x) => x > 0));
  for (const craft of ents) {
    if (!live(craft) || !CREWED.includes(craft.kind)) continue;
    const z = craft.position.z || 0;
    if (z <= spaceAt) continue;
    const crew = ents.filter((p) => live(p) && p.properties.inside === craft.id);
    const owner = craft.properties.civ ? civByName.get(craft.properties.civ) : null;
    const tech = owner ? owner.c.tech : Math.max(0, ...socs.map(([, sc]) => sc.tech || 0));
    const shield = shieldOf(tech);
    let dose = 0; let where = null;
    if (z > spaceAt * 1.05 && z < spaceAt * 1.35) { dose += 0.6; where = 'the radiation belt round their world'; }
    for (const b of belts) { const d = Math.hypot(craft.position.x - b.e.position.x, craft.position.y - b.e.position.y, z - (b.e.position.z || 0)); if (d > b.inner && d < b.outer) { dose += 1.5; where = `the radiation belt of ${b.e.properties.name || b.e.id}`; } }
    if (flaring) { dose += 2.5; where = where || 'the solar flare'; }
    dose = r2(dose * (1 - shield));
    if (dose > 0 && crew.length) {
      for (const p of crew) {
        p.properties.rad_dose = r2((Number(p.properties.rad_dose) || 0) + dose);
        if (p.properties.rad_dose >= DOSE_SICK && !(p.properties.ill_until > tick)) {
          p.properties.ill_until = tick + daySteps * 3;
          emit('radiation_sickness', `${p.properties.name || p.id} aboard ${craft.properties.name || craft.id} fell ill from radiation in ${where}; they are heading home`, p.id);
          turnBack(craft, ents, live, emit, 'radiation sickness aboard');
        }
      }
    }
    // Meteoroids in the asteroid field.
    if (field && star) {
      const d = Math.hypot(craft.position.x - star.position.x, craft.position.y - star.position.y);
      if (d > field.inner && d < field.outer && rand() < 0.02 * (1 - shield)) {
        craft.properties.damage = r2((Number(craft.properties.damage) || 0) + 10 + rand() * 25);
        emit('meteoroid', `${craft.properties.name || craft.id} was struck by meteoroids in the asteroid field (damage ${Math.round(craft.properties.damage)})`, craft.id);
        if (craft.properties.damage >= DAMAGE_ABORT) turnBack(craft, ents, live, emit, 'damage from meteoroids');
      }
    }
  }
  // The ill get better; a craft home again is repaired.
  for (const p of ents) if (live(p) && typeof p.properties.ill_until === 'number' && p.properties.ill_until <= tick) { delete p.properties.ill_until; p.properties.rad_dose = 0; }
  for (const craft of ents) {
    if (!live(craft) || !craft.properties.returning || (craft.position.z || 0) > spaceAt) continue;
    const home = ents.find((e) => e.id === craft.properties.target);
    if (!home || Math.hypot(craft.position.x - home.position.x, craft.position.y - home.position.y) < 60) { delete craft.properties.returning; delete craft.properties.damage; emit('repaired', `${craft.properties.name || craft.id} is home and repaired`, craft.id); }
  }
}

// Between peoples who have met: the inhabitants' countries and the
// civilisations they have contacted (society.mjs contactStep), and two
// civilisations once both reach interstellar travel. Like the countries:
// exchange and trade warm relations; hawkish leaders, rivalry for the same
// worlds and incidents strain them; at -60 a standoff, with envoys talking
// (doves, and a friend of both mediating, make peace likelier); after three
// days of talks, war only at the very worst (-85), with a hawk leading and
// fleets on both sides, a democracy less willing, and without the conflict
// rule never at all. A war is fought between ships in space, never on
// anyone's ground: clashes cost ships and crews, treasuries pay, weariness
// grows until an armistice, and the side that lost more pays reparations.
// cosmos.relations: { "a|b": { score, status, since, war? } }, keys sorted.
function relationsStep(r, { s, ents, removed, societies, cosmos, emit, rand, tick, daySteps, civByName, worlds }) {
  const rel = cosmos.relations || (cosmos.relations = {});
  const parties = new Map();
  for (const [code, soc] of Object.entries(societies || {})) if (soc && soc.name) parties.set(`home:${code}`, { kind: 'home', code, soc, name: soc.name });
  for (const w of worlds) { const c = cosmos.civs[w.id]; parties.set(`civ:${w.id}`, { kind: 'civ', c, w, name: c.name }); }
  const met = (a, b) => {
    if (a.kind === 'home' && b.kind === 'home') return false;   // the countries have their own diplomacy
    if (a.kind === 'home') return (a.soc.contacts || []).includes(b.name);
    if (b.kind === 'home') return (b.soc.contacts || []).includes(a.name);
    return a.c.tech >= 6 && b.c.tech >= 6;
  };
  const leaderTemper = (p) => {
    if (p.kind === 'civ') return p.c.leader ? p.c.leader.temper : 0;
    const l = ents.find((e) => e.id === p.soc.leader && !removed.has(e.id));
    return l ? (l.properties.ambition || 0) - (l.properties.honesty || 0) : 0;
  };
  const techOf = (p) => (p.kind === 'civ' ? p.c.tech : p.soc.tech || 0);
  const gov = (p) => (p.kind === 'civ' ? p.c.government : p.soc.government);
  const fleetOf = (p) => (p.kind === 'civ' ? p.c.fleet : ents.filter((e) => !removed.has(e.id) && ['rocket', 'shuttle'].includes(e.kind)).length);
  const pay = (p, n) => { const o = p.kind === 'civ' ? p.c : p.soc; o.treasury = r2(Math.max(0, (o.treasury || 0) - n)); return o; };
  const keys = [...parties.keys()].sort();
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const A = parties.get(keys[i]); const B = parties.get(keys[j]);
    if (!met(A, B)) continue;
    const key = `${keys[i]}|${keys[j]}`;
    const d = rel[key] || (rel[key] = { score: 15, status: 'peace', since: tick });
    if (d.status === 'war') { warDay(A, B, d); continue; }
    // Exchange and trade warm; the less advanced learn a little.
    if (rand() < 0.12) {
      d.score += 4;
      const what = ['traded goods', 'exchanged scholars', 'shared music and stories', 'compared maps of the sky', 'exchanged seeds and medicines'][Math.floor(rand() * 5)];
      for (const [x, y] of [[A, B], [B, A]]) if (x.kind === 'home' && techOf(y) > techOf(x)) x.soc.research = r2((x.soc.research || 0) + 5 * (techOf(y) - techOf(x)));
      emit('exchange', `${A.name} and ${B.name} ${what}`, A.w ? A.w.id : B.w ? B.w.id : null);
    }
    if (r.conflict) {
      d.score -= Math.max(0, leaderTemper(A) + leaderTemper(B));
      // Rivalry for the same worlds: outposts and colonies round the same body.
      if (rand() < 0.01 && rivals(A, B)) { d.score -= 20; emit('dispute', `${A.name} and ${B.name} quarrel over who may settle the same world`, null); }
      if (rand() < 0.006) { d.score -= 25; emit('dispute', `A dispute flared between ${A.name} and ${B.name} over the right to mine the asteroids`, null); }
      if (rand() < 0.01) { d.score += 20; emit('treaty', `${A.name} and ${B.name} signed an agreement on trade and the sharing of the skies`, null); }
    }
    d.score = Math.max(-100, Math.min(100, Math.round(d.score * 10) / 10 * 0.99));
    if (r.conflict && d.status !== 'standoff' && d.score <= -60) {
      d.status = 'standoff'; d.since = tick;
      emit('standoff', `${A.name} and ${B.name} broke off talks; their fleets are on alert`, null);
    } else if (d.status === 'standoff') {
      const mediator = keys.find((k) => k !== keys[i] && k !== keys[j] && ['alliance'].includes((rel[[keys[i], k].sort().join('|')] || {}).status) && ['alliance'].includes((rel[[keys[j], k].sort().join('|')] || {}).status));
      const talks = 0.03 + 0.04 * Math.max(0, -leaderTemper(A)) + 0.04 * Math.max(0, -leaderTemper(B)) + (mediator ? 0.08 : 0);
      if (rand() < talks) { d.status = 'peace'; d.score = 0; d.since = tick; emit('treaty', `${A.name} and ${B.name} made peace ${mediator ? `with ${parties.get(mediator).name} mediating` : 'after talks'}; their fleets stood down`, null); continue; }
      if (tick - d.since < daySteps * 3) continue;
      const worst = d.score <= -85;
      const hawkish = Math.max(leaderTemper(A), leaderTemper(B)) > 0.3;
      const armed = fleetOf(A) > 0 && fleetOf(B) > 0;
      const willing = 0.35 * ([A, B].some((x) => gov(x) === 'democracy') ? 0.5 : 1);
      if (worst && hawkish && armed && rand() < willing) {
        const aggressor = leaderTemper(A) >= leaderTemper(B) ? A : B;
        d.status = 'war'; d.since = tick; d.war = { started: tick, losses: { a: 0, b: 0 }, weariness: 0 };
        emit('space_war', `${aggressor.name} declared war on ${aggressor === A ? B.name : A.name} after talks failed; it will be fought between ships in space, far from anyone's home`, null);
      } else { d.status = 'peace'; d.score = 0; d.since = tick; emit('treaty', `${A.name} and ${B.name} made peace when the talks ran their course`, null); }
    } else if (d.status === 'peace' && d.score >= 60) { d.status = 'alliance'; d.since = tick; emit('alliance', `${A.name} and ${B.name} became allies`, null); }
    else if (d.status === 'alliance' && d.score < 30) { d.status = 'peace'; d.since = tick; }
  }
  function rivals(A, B) {
    const owned = (p) => new Set(ents.filter((e) => !removed.has(e.id) && e.kind === 'colony' && (p.kind === 'civ' ? e.properties.civ === p.name : !e.properties.civ)).map((e) => e.properties.orbits));
    const a = owned(A); return [...owned(B)].some((x) => a.has(x)) || (a.size > 0 && owned(B).size > 0);
  }
  // One look at a war: maybe a clash between ships, the cost, the weariness, maybe an armistice.
  function warDay(A, B, d) {
    const w = d.war;
    pay(A, 8); pay(B, 8);
    if (rand() < 0.3 && fleetOf(A) > 0 && fleetOf(B) > 0) {
      const strength = (p) => (1 + techOf(p)) * Math.max(1, fleetOf(p)) * (0.6 + rand() * 0.8);
      const aWins = strength(A) >= strength(B);
      const [loser, lk] = aWins ? [B, 'b'] : [A, 'a'];
      const crew = 2 + Math.floor(rand() * 6);
      w.losses[lk] += crew;
      if (loser.kind === 'civ') loser.c.fleet = Math.max(0, loser.c.fleet - 1);
      else {
        // The inhabitants' losses are real people: astronauts in space.
        const fallen = ents.filter((e) => !removed.has(e.id) && (e.kind === 'astronaut' || e.properties.job === 'astronaut')).slice(0, 1);
        for (const f of fallen) { removed.add(f.id); emit('death', `${f.properties.name || f.id} (${f.id}) died in the war in space`, f.id); }
      }
      emit('space_battle', `Ships of ${A.name} and ${B.name} clashed in space, far from anyone's home; ${aWins ? A.name : B.name} held; ${loser.name} lost a ship and ${crew} crew`, A.w ? A.w.id : B.w ? B.w.id : null);
    }
    w.weariness += 1 + (w.losses.a + w.losses.b) * 0.15;
    if (fleetOf(A) === 0 || fleetOf(B) === 0 || w.weariness >= 14 + rand() * 10 || tick - w.started >= daySteps * 6) {
      const [loser, winner] = w.losses.a > w.losses.b ? [A, B] : [B, A];
      const lo = loser.kind === 'civ' ? loser.c : loser.soc; const wi = winner.kind === 'civ' ? winner.c : winner.soc;
      const reparations = r2(Math.min(500, (lo.treasury || 0) * 0.2));
      lo.treasury = r2((lo.treasury || 0) - reparations); wi.treasury = r2((wi.treasury || 0) + reparations);
      emit('armistice', `${A.name} and ${B.name} signed an armistice; ${w.losses.a + w.losses.b} crew were lost. ${loser.name} pays ${Math.round(reparations)} in reparations`, null);
      d.status = 'peace'; d.score = -40; d.since = tick; d.last_war = { started: w.started, ended: tick, lost: w.losses.a + w.losses.b, loser: loser.name };
      delete d.war;
    }
  }
}

// Meteorites: every few days one strikes a moon or planet, or the home
// world. Never a building or a person: the spot is at least 70 m from
// anything there. On land, a crater (at most 8; the oldest goes); at sea, a
// splash (gone after a day). People nearby go to look; scientists study it.
const MAX_CRATERS = 8;
function impactStep({ s, ents, removed, societies, cosmos, emit, rand, tick, add, room, newId, daySteps }) {
  const live = (e) => !removed.has(e.id);
  for (const e of ents) if (live(e) && e.kind === 'crater' && e.properties.sea && tick - (e.properties.fell || 0) > daySteps) removed.add(e.id);
  if (!cosmos.next_impact) cosmos.next_impact = tick + Math.round(daySteps * (2 + rand() * 4));
  if (tick < cosmos.next_impact) return;
  cosmos.next_impact = tick + Math.round(daySteps * (3 + rand() * 5));
  const bodies = ents.filter((e) => live(e) && (e.kind === 'moon' || e.kind === 'planet')).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (bodies.length && rand() < 0.55) {
    const b = bodies[Math.floor(rand() * bodies.length)];
    emit('impact', `A meteorite struck ${b.properties.name || b.id}: a flash and a new crater on its face (observed)`, b.id);
    return;
  }
  if (!room(2)) return;
  const S = s.size; const near = ents.filter((e) => live(e) && (e.position.z || 0) < 5 && !['grass', 'flower', 'crop', 'island', 'lake', 'tree', 'pine', 'palm', 'bush'].includes(e.kind));
  let spot = null;
  for (let t = 0; t < 40 && !spot; t++) {
    const x = S.x * (0.05 + rand() * 0.9); const y = S.y * (0.05 + rand() * 0.9);
    if (!near.some((e) => Math.hypot(e.position.x - x, e.position.y - y) < 70)) spot = { x: r2(x), y: r2(y) };
  }
  if (!spot) return;
  // Land or water by the world's own terrain (terrain.mjs, the one movement uses).
  const sea = terrainOf(s, ents.filter(live)).isWater(spot.x, spot.y);
  const radius = r2(6 + rand() * 14);
  const crater = add({ id: newId('crater'), kind: 'crater', position: { x: spot.x, y: spot.y, z: 0 }, properties: { name: sea ? 'where a meteorite fell into the water' : 'a meteorite crater', radius, fell: tick, ...(sea ? { sea: true } : {}) } });
  const craters = ents.filter((e) => live(e) && e.kind === 'crater' && !e.properties.sea).sort((a, b) => (a.properties.fell || 0) - (b.properties.fell || 0));
  while (craters.length > MAX_CRATERS) removed.add(craters.shift().id);
  const nearest = near.filter((e) => e.properties.name).sort((a, b) => Math.hypot(a.position.x - spot.x, a.position.y - spot.y) - Math.hypot(b.position.x - spot.x, b.position.y - spot.y))[0];
  emit('impact', sea ? `A meteorite fell from the sky into the water${nearest ? ` off ${nearest.properties.name}` : ''}: a flash, a column of spray, a wave` : `A meteorite struck the ground${nearest ? ` near ${nearest.properties.name}` : ''}: a flash, a boom, a cloud of dust, and a crater ${Math.round(radius * 2)} m across`, crater.id);
  if (sea) return;
  // People nearby go to look; scientists study what fell.
  const onlookers = ents.filter((e) => live(e) && (e.kind === 'person' || e.kind === 'child') && !e.properties.inside && !e.properties.target && Math.hypot(e.position.x - spot.x, e.position.y - spot.y) < 450).slice(0, 6);
  for (const p of onlookers) p.properties.target = crater.id;
  for (const soc of Object.values(societies || {})) if (soc && (soc.tech || 0) >= 2) soc.research = r2((soc.research || 0) + 15);
  if (Object.values(societies || {}).some((x) => x && (x.tech || 0) >= 2)) emit('discovery', 'Scientists study the meteorite: iron and nickel, and rock older than their world', crater.id);
}

// Where there are no asteroids, the asteroid field is the widest gap
// between the orbits round the star.
export function asteroidField(radii) {
  const rs = radii.slice().sort((a, b) => a - b);
  let gap = 0; let at = 0;
  for (let i = 1; i < rs.length; i++) if (rs[i] - rs[i - 1] > gap) { gap = rs[i] - rs[i - 1]; at = (rs[i] + rs[i - 1]) / 2; }
  return gap > 0 ? { inner: at - gap * 0.18, outer: at + gap * 0.18 } : null;
}

// A craft giving up its mission: back to a launch pad or station, repaired there.
function turnBack(craft, ents, live, emit, why) {
  if (craft.properties.returning) return;
  const home = ents.find((e) => live(e) && e.kind === 'launch_pad') || ents.find((e) => live(e) && e.kind === 'space_station');
  craft.properties.returning = true;
  delete craft.properties.expedition; delete craft.properties.target_x; delete craft.properties.target_y; delete craft.properties.target_z;
  if (home) craft.properties.target = home.id;
  emit('mission_abort', `${craft.properties.name || craft.id} turned back: ${why}`, craft.id);
}
