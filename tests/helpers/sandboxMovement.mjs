// Runs a world forward step by step and measures how things move
// (tests/sandbox-movement.test.mjs and tests/sandbox-upgrade.test.mjs):
//   groundOnWater   ground things (people, animals, bikes, cars...) standing on water
//   waterOnLand     boats, ferries and ships on land
//   onRoad          the share of ground-vehicle positions on a road
//   steep           aircraft steps steeper than MAX_GRADIENT
//   landings / offRunway   touchdowns, and those not on a runway within its length
import { stepWorld } from '../../lib/sandbox/engine.mjs';
import { moveContext, isGroundKind, isWaterKind, isFixedWing, runwayGeometry, MAX_GRADIENT } from '../../lib/sandbox/movement.mjs';
import { onRoad } from '../../lib/sandbox/roads.mjs';

export const ROAD_VEHICLES = new Set(['bike', 'motorbike', 'car', 'taxi', 'police_car', 'bus', 'truck', 'army_truck', 'tractor']);

export function measureRun(spec, state, steps) {
  let st = state;
  const out = { groundOnWater: [], waterOnLand: [], vehiclePositions: 0, onRoadPositions: 0, steep: [], landings: 0, offRunway: [], events: [] };
  for (let t = 0; t < steps; t++) {
    const prev = new Map(st.entities.map((e) => [e.id, e.position]));
    const r = stepWorld(spec, st, 1);
    st = r.state;
    out.events.push(...r.events.filter((e) => e.kind !== 'decide' && e.kind !== 'talk'));
    const mc = moveContext(spec, st.entities);
    const index = new Map(st.entities.map((e) => [e.id, e]));
    const beaches = st.entities.filter((e) => e.kind === 'beach');
    for (const e of st.entities) {
      const inside = typeof e.properties.inside === 'string' && index.has(e.properties.inside);
      const z = e.position.z || 0;
      // (Someone swimming off a beach is in the water on purpose; anywhere else it is wrong.)
      const swimming = e.properties.swimming === true && beaches.some((b) => Math.hypot(b.position.x - e.position.x, b.position.y - e.position.y) < 200);   // (a beach is up to 200 m long; surfers go 45 m out)
      if (isGroundKind(e.kind) && !inside && z < 1 && !swimming && !mc.terrain.isLand(e.position.x, e.position.y)) out.groundOnWater.push([st.tick, e.id]);
      if (isWaterKind(e.kind) && mc.terrain.isLand(e.position.x, e.position.y)) out.waterOnLand.push([st.tick, e.id]);
      if (ROAD_VEHICLES.has(String(e.kind)) && !inside && mc.roads) { out.vehiclePositions++; if (onRoad(mc.roads, e.position.x, e.position.y, { paths: e.kind === 'bike' })) out.onRoadPositions++; }
      if (isFixedWing(e.kind) && prev.has(e.id)) {
        const a = prev.get(e.id);
        const run = Math.hypot(e.position.x - a.x, e.position.y - a.y); const rise = z - (a.z || 0);
        if (Math.abs(rise) > MAX_GRADIENT * run + 0.5) out.steep.push([st.tick, e.id, rise, run]);
        if ((a.z || 0) > 0 && z === 0) {
          out.landings++;
          const on = mc.runways.some((rw) => { const G = runwayGeometry(rw); const dx = e.position.x - G.c.x; const dy = e.position.y - G.c.y; return Math.abs(dx * G.u.x + dy * G.u.y) <= G.L / 2 && Math.abs(-dx * G.u.y + dy * G.u.x) <= G.W / 2; });
          if (!on) out.offRunway.push([st.tick, e.id, e.position]);
        }
      }
    }
  }
  out.onRoad = out.vehiclePositions ? out.onRoadPositions / out.vehiclePositions : 1;
  out.state = st;
  return out;
}
