// PG1 Sandbox: emergencies and the beach (run with the life rule,
// engine.mjs). Deterministic from the seed; no AI engine.
//
// Fires
//   - Now and then a building catches fire (FIRE_PER_DAY a building, more
//     for factories). Everyone in it gets out; some may be hurt.
//   - The nearest free fire engine is called out: lights and siren, along
//     the roads to the nearest point of the road to the fire (a building
//     with no road of its own is reached from there). Its crew put the fire
//     out; it goes back to its station.
//   - With no fire engine (a period world, or none yet), the neighbours come
//     and fight it.
//   - A fire nobody reaches in time badly damages the building: it is
//     rebuilt (it goes back to being built, and the builders finish it).
// Ambulances
//   - Someone hurt (in a fire, or pulled from the sea) is collected by the
//     nearest free ambulance, lights and siren, and driven to hospital,
//     where they are treated. With no ambulance they go to hospital
//     themselves, or rest at home for a day.
// The beach
//   - Someone who has come to a beach does something there for a while:
//     swims in the shallows, surfs, sunbathes, plays volleyball, builds a
//     sandcastle (children) or strolls by the water.
//   - Now and then a swimmer gets into trouble; a lifeguard (or, with none,
//     someone on the beach) swims out and brings them back.
// Every fire, call-out, rescue and treatment is an event (the black box).
//
//   emergencyStep(ctx) with ctx: { s, ents, removed, emit, rand, tick, add,
//     room, newId, daySteps, mc, period, techOf(entity), fireRate }
//   (fireRate: the life rule's fire_rate, a building's chance of fire in a day)

import { catalogFor } from './catalog.mjs';
import { roadPoint } from './roads.mjs';

export const FIRE_PER_DAY = 0.0012;    // chance a building catches fire in a day
const HOSE_REACH = 70;                 // metres from a fire an engine's crew can fight it
const LONG_HOSE = 300;                 // from where the road ends, with hose lines laid out
const SWIM_TROUBLE = 0.0006;           // chance a swimmer gets into trouble in a step
const BEACH_TIME = [20, 60];           // steps spent at one beach activity
const r2 = (n) => Math.round(n * 100) / 100;
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function emergencyStep(ctx) {
  const { ents, removed, emit, rand, tick, add, room, newId, daySteps = 240, mc, period = false } = ctx;
  const live = ents.filter((e) => !removed.has(e.id));
  const index = new Map(live.map((e) => [e.id, e]));
  const of = (kinds) => live.filter((e) => kinds.includes(e.kind));
  const nameOf = (e) => (e.properties.name ? `${e.properties.name}${e.properties.family && !String(e.properties.name).includes(e.properties.family) ? ` ${e.properties.family}` : ''}` : e.id);
  const T = mc && mc.terrain;
  // The nearest point of the road to a place (where a vehicle can stop), or the place itself.
  const kerb = (p) => { const q = mc && mc.roads ? roadPoint(mc.roads, p.x, p.y, { mode: 'car' }) : null; return q ? { x: r2(q.x), y: r2(q.y) } : { x: p.x, y: p.y }; };
  const send = (v, call, kind, to) => { const p = v.properties; p.emergency = kind; p.call = call; p.siren = true; delete p.target; const k = kerb(to); p.target_x = k.x; p.target_y = k.y; };
  const standDown = (v) => { const p = v.properties; delete p.emergency; delete p.call; p.siren = false; delete p.target_x; delete p.target_y; if (p.station && index.has(p.station)) p.target = p.station; };
  const people = live.filter((e) => catalogFor(e.kind).class === 'person');
  // On the same land (island), where a vehicle can drive between them.
  const sameLand = (a, b) => !T || !T.hasLand || T.islandAt(a.x, a.y) === T.islandAt(b.x, b.y);

  // --- every fire station has an engine, every hospital an ambulance (once they exist) --------
  if (!period && tick % 24 === 0) {
    for (const [place, kind] of [['fire_station', 'fire_truck'], ['hospital', 'ambulance']]) {
      for (const st of of([place])) {
        if (typeof st.properties.built === 'number' && st.properties.built < 100) continue;
        if ((ctx.techOf ? ctx.techOf(st) : 2) < 2 || !room()) continue;
        if (live.some((v) => v.kind === kind && v.properties.station === st.id)) continue;
        const k = kerb(st.position);
        add({ id: newId(kind), kind, position: { x: k.x, y: k.y, z: 0 }, properties: { station: st.id, name: `${nameOf(st)} ${kind === 'fire_truck' ? 'fire engine' : 'ambulance'}` } });
        emit('services', `${nameOf(st)} has ${kind === 'fire_truck' ? 'a fire engine' : 'an ambulance'} now`, st.id);
      }
    }
  }

  // --- fires ------------------------------------------------------------------------------------
  const buildings = live.filter((e) => catalogFor(e.kind).class === 'building' && !(typeof e.properties.built === 'number' && e.properties.built < 100));
  for (const b of buildings) {
    if (b.properties.fire) continue;
    const chance = ((ctx.fireRate ?? FIRE_PER_DAY) * (b.kind === 'factory' ? 3 : 1)) / daySteps;
    if (rand() >= chance) continue;
    b.properties.fire = 10; b.properties.fire_since = tick;
    emit('fire', `A fire broke out at ${nameOf(b)}`, b.id);
    // Everyone inside gets out, away from it.
    const fp = Math.max(10, catalogFor(b.kind).footprint || 10);
    let out = 0;
    for (const p of people) {
      const q = p.properties;
      if (q.inside || !(q.at === b.id || d2(p.position, b.position) < fp)) continue;
      const a = rand() * Math.PI * 2;
      let spot = { x: r2(b.position.x + Math.cos(a) * (fp + 15)), y: r2(b.position.y + Math.sin(a) * (fp + 15)) };
      if (T && T.hasLand && !T.isLand(spot.x, spot.y)) spot = { x: b.position.x, y: b.position.y };
      p.position = { ...spot, z: 0 }; delete q.at; delete q.target;
      out += 1;
      if (rand() < 0.12) { q.injured = 'burns'; q.injured_since = tick; emit('injured', `${nameOf(p)} was hurt in the fire at ${nameOf(b)}`, p.id); }
    }
    if (out) emit('evacuated', `${out} ${out === 1 ? 'person' : 'people'} got out of ${nameOf(b)}`, b.id);
    // The nearest free fire engine is called out.
    // (only one that can drive there: on the same island)
    const engine = of(['fire_truck']).filter((v) => !v.properties.emergency && sameLand(v.position, b.position)).sort((x, y) => d2(x.position, b.position) - d2(y.position, b.position))[0];
    if (engine) { send(engine, b.id, 'fire', b.position); emit('dispatch', `${nameOf(engine)} is on its way to the fire at ${nameOf(b)}`, engine.id); }
    else {
      // No engine: the neighbours come with water.
      const helpers = people.filter((p) => (p.properties.age || 0) >= 16 && !p.properties.inside && !p.properties.injured && d2(p.position, b.position) < 300).sort((x, y) => d2(x.position, b.position) - d2(y.position, b.position)).slice(0, 6);
      for (const h of helpers) { h.properties.fighting_fire = b.id; h.properties.target = b.id; }
      if (helpers.length) emit('neighbours', `Neighbours ran to fight the fire at ${nameOf(b)}`, b.id);
    }
  }
  for (const b of live.filter((e) => typeof e.properties.fire === 'number' && e.properties.fire > 0)) {
    // A crew fights it from beside it, or with long hose lines from where the road ends (up to LONG_HOSE).
    const crews = of(['fire_truck']).filter((v) => v.properties.call === b.id && (d2(v.position, b.position) < HOSE_REACH + (catalogFor(b.kind).footprint || 0) || (v.properties.target_x === undefined && !v.properties.target && d2(v.position, b.position) < LONG_HOSE)));
    const helpers = people.filter((p) => p.properties.fighting_fire === b.id && d2(p.position, b.position) < 40);
    let f = b.properties.fire + 1.5 - crews.length * 12 - helpers.length * 2.5;
    if (f >= 100 && !b.properties.fire_damaged) {
      b.properties.fire_damaged = true; b.properties.built = 40;
      emit('fire_damage', `${nameOf(b)} was badly damaged by the fire; it will be rebuilt`, b.id);
    }
    if (b.properties.fire_damaged) f = Math.min(f, b.properties.fire - 3);   // it burns itself out
    if (f <= 0) {
      delete b.properties.fire; delete b.properties.fire_since; delete b.properties.fire_damaged;
      emit('fire_out', crews.length ? `Firefighters put out the fire at ${nameOf(b)}` : `The fire at ${nameOf(b)} is out`, b.id);
      for (const v of of(['fire_truck']).filter((x) => x.properties.call === b.id)) standDown(v);
      for (const h of people.filter((p) => p.properties.fighting_fire === b.id)) { delete h.properties.fighting_fire; if (h.properties.target === b.id) delete h.properties.target; }
    } else b.properties.fire = r2(Math.min(100, f));
  }
  // An engine whose fire went out (or vanished) goes home.
  for (const v of of(['fire_truck'])) if (v.properties.emergency === 'fire' && !(index.get(v.properties.call) || { properties: {} }).properties.fire) standDown(v);

  // --- the hurt, and ambulances -------------------------------------------------------------------
  const hospitals = of(['hospital']).filter((h) => !(typeof h.properties.built === 'number' && h.properties.built < 100));
  const nearestHospital = (p) => hospitals.filter((h) => sameLand(h.position, p)).sort((x, y) => d2(x.position, p) - d2(y.position, p))[0] || null;
  for (const p of people) {
    const q = p.properties;
    if (!q.injured || q.inside) continue;
    if (live.some((v) => v.kind === 'ambulance' && v.properties.call === p.id)) continue;
    const amb = of(['ambulance']).filter((v) => !v.properties.emergency && sameLand(v.position, p.position)).sort((x, y) => d2(x.position, p.position) - d2(y.position, p.position))[0];
    if (amb && hospitals.length) { send(amb, p.id, 'medical', p.position); emit('dispatch', `${nameOf(amb)} is on its way to ${nameOf(p)}`, amb.id); continue; }
    // No ambulance: to hospital on foot, or rest at home for a day.
    const h = nearestHospital(p.position);
    if (h && !q.target) q.target = h.id;
    else if (!h && tick - (q.injured_since || tick) > daySteps) { delete q.injured; delete q.injured_since; emit('recovered', `${nameOf(p)} has recovered`, p.id); }
  }
  for (const amb of of(['ambulance'])) {
    const a = amb.properties;
    if (a.emergency !== 'medical') continue;
    const patient = index.get(a.call);
    if (!patient || !patient.properties.injured) { standDown(amb); continue; }
    const pq = patient.properties;
    if (pq.inside !== amb.id) {
      // Collecting: once there, the patient is lifted in and it drives to hospital.
      if (d2(amb.position, patient.position) < 40 || (a.target_x === undefined && !a.target)) {
        pq.inside = amb.id; delete pq.target; delete pq.at;
        const h = nearestHospital(amb.position);
        delete a.target_x; delete a.target_y; if (h) a.target = h.id;
        emit('ambulance', `${nameOf(amb)} picked up ${nameOf(patient)}${h ? ` and is taking them to ${nameOf(h)}` : ''}`, amb.id);
      }
    } else if (!a.target && typeof a.at === 'string' && hospitals.some((h) => h.id === a.at)) {
      const h = index.get(a.at);
      delete pq.inside; delete pq.injured; delete pq.injured_since; patient.position = { x: h.position.x, y: h.position.y, z: 0 }; pq.at = h.id;
      emit('treated', `${nameOf(patient)} was treated at ${nameOf(h)}`, patient.id);
      a.emergency = undefined; delete a.emergency; delete a.call; a.siren = false;
    }
  }
  // Someone hurt who reached a hospital on foot is treated there.
  for (const p of people) { const q = p.properties; if (q.injured && !q.inside && typeof q.at === 'string' && hospitals.some((h) => h.id === q.at)) { delete q.injured; delete q.injured_since; emit('treated', `${nameOf(p)} was treated at ${nameOf(index.get(q.at))}`, p.id); } }

  // --- the beach ----------------------------------------------------------------------------------
  if (!T) return;
  const beaches = of(['beach']);
  if (!beaches.length) return;
  const towers = of(['lifeguard_tower']);
  for (const p of people) {
    const q = p.properties;
    // One activity a visit: someone at a beach, still on it, who has not had one this visit
    // (a next trip they have already chosen waits).
    if (q.beach_done && q.at !== q.beach_done) delete q.beach_done;
    const here = typeof q.at === 'string' ? index.get(q.at) : null;
    const beach = here && here.kind === 'beach' && d2(p.position, here.position) < 90 && q.beach_done !== here.id ? here : null;
    // A new visitor: choose what to do.
    if (beach && !q.activity && !q.injured && !q.inside) {
      const child = (q.age || 0) < 13;
      const roll = rand();
      const act = period ? (roll < 0.5 ? 'stroll' : 'swim') : child ? (roll < 0.45 ? 'sandcastle' : roll < 0.85 ? 'swim' : 'stroll') : roll < 0.35 ? 'swim' : roll < 0.6 ? 'sunbathe' : roll < 0.72 ? 'volleyball' : roll < 0.82 ? 'surf' : 'stroll';
      const w = T.nearestWater(beach.position.x, beach.position.y, { margin: 4 });
      if (!w) continue;
      const dx = w.x - beach.position.x; const dy = w.y - beach.position.y; const d = Math.hypot(dx, dy) || 1;
      const along = (rand() - 0.5) * Math.min(200, Number(beach.properties.length) || 160);
      const side = { x: -dy / d, y: dx / d };
      let spot;
      if (act === 'swim' || act === 'surf') spot = { x: w.x + (dx / d) * (act === 'surf' ? 25 + rand() * 20 : 4 + rand() * 12) + side.x * along, y: w.y + (dy / d) * (act === 'surf' ? 25 + rand() * 20 : 4 + rand() * 12) + side.y * along };
      else spot = { x: w.x - (dx / d) * (act === 'stroll' ? 3 : 8 + rand() * 14) + side.x * along, y: w.y - (dy / d) * (act === 'stroll' ? 3 : 8 + rand() * 14) + side.y * along };
      const inWater = act === 'swim' || act === 'surf';
      if (inWater ? T.isLand(spot.x, spot.y) : !T.isLand(spot.x, spot.y)) continue;
      p.position = { x: r2(spot.x), y: r2(spot.y), z: 0 };
      delete q.target; delete q.target_x; delete q.target_y;
      q.activity = act; q.activity_until = tick + BEACH_TIME[0] + Math.floor(rand() * (BEACH_TIME[1] - BEACH_TIME[0]));
      if (inWater) q.swimming = true;
      if (act === 'volleyball' || act === 'surf' || act === 'sandcastle') emit('beach', `${nameOf(p)} ${act === 'volleyball' ? 'joined a game of beach volleyball' : act === 'surf' ? 'went surfing' : 'started building a sandcastle'} at ${nameOf(beach)}`, p.id);
      continue;
    }
    if (!q.activity) continue;
    // Strolling: along the water's edge.
    if (q.activity === 'stroll' && !q.swimming) { const np = { x: p.position.x + (rand() - 0.5) * 6, y: p.position.y + (rand() - 0.5) * 6 }; if (T.isLand(np.x, np.y)) p.position = { x: r2(np.x), y: r2(np.y), z: 0 }; }
    // Trouble in the water.
    if (q.swimming && !q.in_trouble && !q.rescuing && q.activity === 'swim' && rand() < SWIM_TROUBLE) {
      q.in_trouble = tick;
      const b = beaches.slice().sort((x, y) => d2(x.position, p.position) - d2(y.position, p.position))[0];
      emit('swimmer_in_trouble', `${nameOf(p)} is in trouble in the water off ${nameOf(b)}`, p.id);
      const guards = people.filter((g) => g.properties.job === 'lifeguard' && !g.properties.rescuing && !g.properties.inside && towers.some((t) => d2(t.position, g.position) < 400));
      const others = people.filter((g) => g !== p && (g.properties.age || 0) >= 16 && !g.properties.rescuing && !g.properties.inside && d2(g.position, p.position) < 150);
      const rescuer = (guards.length ? guards : others).sort((x, y) => d2(x.position, p.position) - d2(y.position, p.position))[0];
      if (rescuer) { rescuer.properties.rescuing = p.id; rescuer.properties.swimming = true; delete rescuer.properties.target; emit('rescue', `${nameOf(rescuer)}${rescuer.properties.job === 'lifeguard' ? ', a lifeguard,' : ''} swam out to ${nameOf(p)}`, rescuer.id); }
    }
    // The end of the activity: back up the beach (unless in trouble).
    if (!q.in_trouble && !q.rescuing && tick >= (q.activity_until || 0)) {
      const b = beaches.slice().sort((x, y) => d2(x.position, p.position) - d2(y.position, p.position))[0];
      if (q.swimming && b) p.position = { x: b.position.x, y: b.position.y, z: 0 };
      delete q.activity; delete q.activity_until; delete q.swimming;
      if (b) { q.at = b.id; q.beach_done = b.id; }
    }
  }
  // Rescues: the rescuer swims out (fast), takes hold, and brings them in.
  for (const g of people.filter((x) => x.properties.rescuing)) {
    const v = index.get(g.properties.rescuing);
    if (!v || !v.properties.in_trouble) { delete g.properties.rescuing; delete g.properties.swimming; continue; }
    const d = d2(g.position, v.position);
    if (d > 1.5) { const k = Math.min(1, 6 / d); const np = { x: g.position.x + (v.position.x - g.position.x) * k, y: g.position.y + (v.position.y - g.position.y) * k }; g.position = { x: r2(np.x), y: r2(np.y), z: 0 }; continue; }
    const b = beaches.slice().sort((x, y) => d2(x.position, v.position) - d2(y.position, v.position))[0];
    for (const x of [g, v]) { x.position = { x: b.position.x, y: b.position.y, z: 0 }; for (const k of ['swimming', 'activity', 'activity_until', 'rescuing', 'in_trouble']) delete x.properties[k]; x.properties.at = b.id; x.properties.beach_done = b.id; }   // enough of the sea for today
    emit('rescued', `${nameOf(g)} brought ${nameOf(v)} safely back to ${nameOf(b)}`, g.id);
    if (rand() < 0.25) { v.properties.injured = 'water'; v.properties.injured_since = tick; emit('injured', `${nameOf(v)} swallowed a lot of water and needs a check-up`, v.id); }
  }
  // Nobody came: after a while they struggle back to shore themselves.
  for (const p of people.filter((x) => x.properties.in_trouble && tick - x.properties.in_trouble > 15 && !people.some((g) => g.properties.rescuing === x.id))) {
    const b = beaches.slice().sort((x, y) => d2(x.position, p.position) - d2(y.position, p.position))[0];
    p.position = { x: b.position.x, y: b.position.y, z: 0 };
    for (const k of ['swimming', 'activity', 'activity_until', 'in_trouble']) delete p.properties[k];
    p.properties.at = b.id; p.properties.beach_done = b.id;
    emit('rescued', `${nameOf(p)} made it back to ${nameOf(b)}, exhausted`, p.id);
  }
}
