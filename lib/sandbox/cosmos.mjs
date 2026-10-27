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
//   After first contact (a society's `contacts` holds the civilisation)
//     Peaceful by default: exchanges of goods, learning and culture; the
//     less advanced side learns a little from the more advanced
//     (research). With `conflict: true` on the rule (a per-world choice),
//     relations can also sour into disputes and standoffs, and, rarely,
//     at the very worst, a clash between ships in orbit that ends in a
//     truce; never on the ground, and never against civilians.
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
// State: state.cosmos = { civs: { [world id]: { tech, research, outposts,
// relations: { [country]: score }, standoff } }, flare_until, next_flare }.

import { TECH_LEVELS } from './society.mjs';

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
    cosmos.civs[w.id] = { name: w.properties.name || w.id, tech, research: 0, outposts: 0, relations: {}, standoff: false };
  }
  return cosmos.civs[w.id];
}

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
    // After contact: peaceful exchange; with the conflict rule, disputes too.
    for (const [code, soc] of socs) {
      for (const name of soc.contacts || []) {
        const it = civByName.get(name); if (!it) continue;
        const { c, w } = it;
        const rel = c.relations[code] ?? 20;
        let next = rel;
        if (rand() < 0.35) {
          const what = ['traded goods', 'exchanged scholars', 'shared music and stories', 'compared maps of the sky', 'exchanged seeds and medicines'][Math.floor(rand() * 5)];
          next += 3;
          // The less advanced learn a little from the more advanced.
          if (c.tech > soc.tech) soc.research = r2((soc.research || 0) + 5 * (c.tech - soc.tech));
          emit('exchange', `${soc.name || 'The people'} and ${c.name} ${what}`, w.id);
        }
        if (r.conflict) {
          if (rand() < 0.08) { next -= 10 + Math.round(rand() * 15); emit('dispute', `A dispute between ${soc.name || 'the people'} and ${c.name}`, w.id); }
          if (!c.standoff && next <= -60) { c.standoff = true; emit('standoff', `${soc.name || 'The people'} and ${c.name} are in a standoff; envoys are talking`, w.id); }
          if (c.standoff && next <= -85 && rand() < 0.1) {
            // A clash between ships in orbit, never on the ground: both pay, then a truce.
            soc.treasury = r2(Math.max(0, (soc.treasury || 0) - 200));
            next = -30; c.standoff = false;
            emit('skirmish', `A clash between ships of ${soc.name || 'the people'} and ${c.name} in orbit, far from anyone's home; a truce followed`, w.id);
          } else if (c.standoff && next > -40) { c.standoff = false; emit('treaty', `${soc.name || 'The people'} and ${c.name} settled their differences`, w.id); }
        }
        c.relations[code] = Math.max(-100, Math.min(100, next));
      }
    }
  }

  if (r.hazards === false) return;
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
