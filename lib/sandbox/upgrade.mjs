// /sandbox upgrade <world-id> [confirm]: brings one of PG1's worlds made
// before the road network up to date, in place.
//
//   without confirm   describes what it would add; nothing changes
//   with confirm      adds a connected road network to each island (a ring
//                     road, the town's existing streets joined up, a road or
//                     driveway to every house, harbour, airport, school,
//                     hospital, factory and pad) and a runway, with a
//                     heading, to each island country that has none
//
// It never removes, renames or moves a building, person, animal or
// vehicle (a new road goes round an existing building instead), and keeps
// the world's id, tick, state, society, research, relations and
// treasuries. One record on the black box long chain says who, when and
// what was added. It must fit the world's limits; if it cannot, it refuses
// and says what to delete first. PG1's own worlds only, never a blind copy.

import { validateSpec, specBytes, SANDBOX_LIMITS } from './engine.mjs';
import { catalogFor } from './catalog.mjs';
import { buildTerrain } from './terrain.mjs';
import { planRoads, stripOf, obstaclesOf } from './roads.mjs';
import { record as recordBlackbox, agentAction } from './blackbox.mjs';
import { pg1Principal } from './worlds.mjs';
import { PG1_OWNER } from './store.mjs';

const ID_RE = /^[0-9a-f-]{36}$/i;
const RUNWAY = catalogFor('runway');
const r1 = (v) => Math.round(v * 10) / 10;

// A runway for an island that has none: the longest that fits on its land,
// clear of every building, tried from the middle outward, the same every time.
export function runwaySite(island, entities, terrain) {
  const R = typeof island.properties.radius === 'number' ? island.properties.radius : 500;
  const obstacles = obstaclesOf(entities);
  const W = 30;
  for (const L of [900, 800, 700, 640, 560, 480]) {
    if (L > R * 1.3) continue;
    for (let ring = 0; ring <= 8; ring++) {
      const d = ring * R * 0.08;
      const n = ring === 0 ? 1 : 12;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const cx = island.position.x + Math.cos(a) * d; const cy = island.position.y + Math.sin(a) * d;
        for (const heading of [0, 90, 45, 135]) {
          const ux = Math.cos((heading * Math.PI) / 180); const uy = Math.sin((heading * Math.PI) / 180);
          let ok = true;
          for (let t = -L / 2 - 60; t <= L / 2 + 60 && ok; t += 20) {
            const x = cx + ux * t; const y = cy + uy * t;
            if (terrain.coastDistance(x, y) < 40 || terrain.islandAt(x, y) !== terrain.islandAt(island.position.x, island.position.y)) ok = false;
            for (const o of obstacles) if (ok && Math.hypot(o.x - x, o.y - y) < (o.rect ? Math.max(o.rect.L, o.rect.W) / 2 + 40 : o.r + 45)) ok = false;
          }
          if (ok) return { x: r1(cx), y: r1(cy), heading, length: L, width: W };
        }
      }
    }
  }
  return null;
}

// What an upgrade would add to a world: { spec, state, added } or { refuse }.
export function planUpgrade(w) {
  const spec = validateSpec(w.spec);
  const st = w.state && Array.isArray(w.state.entities) ? w.state : { entities: spec.entities };
  const ents = st.entities;
  const terrain = buildTerrain(ents, spec.size);
  // Runways: one for every island country without one on its land.
  const runways = [];
  for (const isl of ents.filter((e) => e.kind === 'island')) {
    const mass = terrain.islandAt(isl.position.x, isl.position.y);
    if (!mass) continue;
    if (ents.concat(runways).some((e) => catalogFor(e.kind) === RUNWAY && terrain.islandAt(e.position.x, e.position.y) === mass)) continue;
    const site = runwaySite(isl, ents.concat(runways), terrain);
    const name = `${isl.properties.name || isl.id} Airstrip`;
    if (!site) return { refuse: `There is no clear, flat stretch of land on ${isl.properties.name || isl.id} for a runway. Clear a strip of about 600 m (move or delete a few buildings) first.` };
    let id = `runway-${isl.properties.country || isl.id}`.slice(0, 64);
    for (let n = 2; ents.some((e) => e.id === id) || runways.some((e) => e.id === id); n++) id = `runway-${isl.properties.country || isl.id}-${n}`.slice(0, 64);
    runways.push({ id, kind: 'runway', position: { x: site.x, y: site.y, z: 0 }, properties: { name, length: site.length, width: site.width, heading: site.heading } });
  }
  const all = ents.concat(runways);
  // The roads: the streets already there joined up, a ring road round each
  // island (or round the town), and a way in to every place.
  const streets = all.filter((e) => catalogFor(e.kind) === catalogFor('road') && !(typeof e.properties.built === 'number' && e.properties.built < 100)).map((e) => { const s = stripOf(e); return { points: [[s.ax, s.ay], [s.bx, s.by]], width: s.w, name: s.name }; });
  let townRing = null;
  if (!all.some((e) => e.kind === 'island')) {
    const b = all.filter((e) => catalogFor(e.kind).class === 'building');
    if (b.length) {
      const xs = b.map((e) => e.position.x); const ys = b.map((e) => e.position.y);
      const x0 = Math.max(40, Math.min(...xs) - 160); const y0 = Math.max(40, Math.min(...ys) - 160); const x1 = Math.min(spec.size.x - 40, Math.max(...xs) + 160); const y1 = Math.min(spec.size.y - 40, Math.max(...ys) + 160);
      townRing = { name: 'Ring Road', points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
    }
  }
  const roads = planRoads(all, terrain, { size: spec.size, streets, townRing });
  const nextSpec = { ...spec, entities: spec.entities.concat(runways), roads };
  // The limits: entities and size.
  if (all.length > SANDBOX_LIMITS.entities) return { refuse: `The world has ${ents.length} things; adding ${runways.length} runway${runways.length === 1 ? '' : 's'} would take it past ${SANDBOX_LIMITS.entities}. Delete at least ${all.length - SANDBOX_LIMITS.entities} things (for example trees or rocks) first.` };
  const bytes = specBytes(nextSpec);
  if (bytes > SANDBOX_LIMITS.specBytes) return { refuse: `With the roads, the world's data would be ${Math.ceil(bytes / 1024)} KB, over the ${SANDBOX_LIMITS.specBytes / 1024} KB limit. Delete about ${Math.ceil((bytes - SANDBOX_LIMITS.specBytes) / 1024) + 4} KB first (for example some trees, rocks or flowers from the starting world) and try again.` };
  let clean;
  try { clean = validateSpec(nextSpec); } catch (e) { return { refuse: `The road network would not fit: ${e.message}` }; }
  const km = roads.edges.reduce((t, [a, b, wd]) => t + (wd >= 3.5 ? Math.hypot(roads.nodes[a][0] - roads.nodes[b][0], roads.nodes[a][1] - roads.nodes[b][1]) : 0), 0) / 1000;
  const state = { ...st, entities: st.entities.concat(runways.map((e) => ({ ...e, properties: { ...e.properties }, position: { ...e.position } }))).sort((a, b) => (a.id < b.id ? -1 : 1)) };
  return { spec: clean, state, added: { roads: { nodes: roads.nodes.length, edges: roads.edges.length, km: Math.round(km * 10) / 10, named: roads.names.length }, runways: runways.map((e) => ({ id: e.id, name: e.properties.name, length: e.properties.length, heading: e.properties.heading, at: [e.position.x, e.position.y] })), spec_kb: Math.round(bytes / 102.4) / 10 } };
}

const dayOf = (w) => Math.floor((Number(w.tick) || 0) / ((w.spec && w.spec.day_steps) || 240)) + 1;
function describe(w, added) {
  const rw = added.runways.length ? added.runways.map((r) => `${r.name} (${r.length} m, heading ${r.heading}°)`).join('; ') : 'none needed: every island already has one';
  return [
    `- a connected road network: ${added.roads.edges} stretches of road, ${added.roads.km} km, ${added.roads.named} named roads, joining the streets already there (nothing removed or moved; new roads go round buildings)`,
    `- runways: ${rw}`,
    `- kept as they are: the world id, tick ${Number(w.tick) || 0} (in-world day ${dayOf(w)}), every inhabitant, family, country, treasury, research level, relation and black box record`,
    `- the world's data becomes ${added.spec_kb} KB (limit ${SANDBOX_LIMITS.specBytes / 1024} KB)`
  ].join('\n');
}

// { status, reply, upgraded? } for the chat. rest: "<world-id> [confirm]".
export async function sandboxUpgradeCommand(store, rest, { who = 'operator' } = {}) {
  const words = String(rest || '').trim().split(/\s+/).filter(Boolean);
  const id = (words[0] || '').toLowerCase();
  const confirm = words.slice(1).some((x) => x.toLowerCase() === 'confirm');
  if (!ID_RE.test(id)) return { status: 200, reply: 'Usage: /sandbox upgrade <world-id> [confirm] (the full world id, from /sandbox).' };
  const w = await store.getWorld(id);
  if (!w || w.owner !== PG1_OWNER) return { status: 200, reply: 'No PG1 world has that id. Only PG1\'s own worlds can be upgraded.' };
  if (w.blind) return { status: 200, reply: 'That world is a blind run\'s copy (SIMULATION — blind experiment). It is not upgraded.' };
  if (w.spec && w.spec.roads && w.state && w.state.entities) {
    const T = buildTerrain(w.state.entities, w.spec.size);
    const islands = w.state.entities.filter((e) => e.kind === 'island');
    const missing = islands.filter((i) => !w.state.entities.some((e) => catalogFor(e.kind) === RUNWAY && T.islandAt(e.position.x, e.position.y) === T.islandAt(i.position.x, i.position.y)));
    if (!missing.length) return { status: 200, reply: `**${w.name}** (Simulation) already has its road network and a runway on every island. Nothing to add.` };
  }
  const plan = planUpgrade(w);
  if (plan.refuse) return { status: 200, reply: `Not upgraded: ${plan.refuse}` };
  if (!confirm) return { status: 200, reply: `This would upgrade **${w.name}** (Simulation, \`${w.id}\`) in place:\n${describe(w, plan.added)}\nNothing has changed yet. To upgrade it, repeat the command with confirm:\n\`/sandbox upgrade ${w.id} confirm\`` };
  await store.updateWorld(w.id, { spec: plan.spec, state: plan.state });
  await recordBlackbox(store, w.id, [agentAction(pg1Principal(), 'upgrade_world', { who, when: new Date().toISOString(), added: plan.added }, Number(w.tick) || 0)]);
  return { status: 200, upgraded: true, added: plan.added, reply: `Upgraded **${w.name}** (Simulation, \`${w.id}\`) in place:\n${describe(w, plan.added)}\nOne record of the upgrade is on its black box long chain.` };
}
