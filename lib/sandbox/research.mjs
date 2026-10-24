// RESEARCH AND DEVELOPMENT: what a country works out, branch by branch.
//
// Each country's research (scientists, engineers, teachers, grants: see
// society.mjs) is split once a day between six branches, by what the
// country needs and who leads it:
//
//   energy     fire, water wheels, coal and steam, electricity, oil and gas,
//              nuclear fission, solar and wind; then fusion and antimatter
//   industry   hand tools to factories, assembly lines, chemistry,
//              automation, robotics; then nanofabrication
//   weapons    spears and bows to gunpowder, rifles, artillery, aircraft,
//              missiles and a nuclear deterrent; then energy weapons and
//              orbital defence
//   medicine   remedies, sanitation, vaccines, antibiotics, surgery,
//              genetics; then gene therapy and regeneration
//   computing  counting, printing, the telegraph, radio, computers, the
//              network, thinking machines; then quantum computing
//   materials  stone and wood, bronze, iron, steel, concrete, alloys,
//              composites; then room-temperature superconductors
//
// Discoveries in the order they came for us, each building on the last,
// and past today's science some that might come next (marked future).
//
// What they change, realistically:
//   energy     richer work (wages and taxes), more research; coal and oil
//              pollute (shorter lives) until clean power replaces them;
//              fission now and then has an accident
//   industry   cheaper building
//   weapons    a stronger army in a war; when both sides of a quarrel hold
//              a nuclear deterrent, war becomes far less likely; arms cost
//              the treasury
//   medicine   longer lives
//   computing  faster research
//   materials  cheaper building, and the way to space and the stars
//
// Deterministic from the seed; no AI engine.

export const RD_BRANCHES = Object.freeze({
  energy: [
    ['wood and fire', 0], ['water wheels', 15], ['coal and steam power', 80], ['electricity', 220], ['oil and gas', 420], ['nuclear fission', 800], ['solar and wind power', 1100], ['fusion power', 2600, 'future'], ['antimatter power', 5200, 'future']
  ],
  industry: [
    ['hand tools', 0], ['workshops', 20], ['factories', 100], ['assembly lines', 280], ['chemistry and plastics', 500], ['automation', 950], ['robotics', 1700], ['nanofabrication', 3600, 'future']
  ],
  weapons: [
    ['spears and bows', 0], ['swords and armour', 25], ['gunpowder', 110], ['rifles', 260], ['artillery and armour', 450], ['aircraft and warships', 700], ['guided missiles', 1150], ['a nuclear deterrent', 1700], ['energy weapons', 3400, 'future'], ['orbital defence', 6000, 'future']
  ],
  medicine: [
    ['herbal remedies', 0], ['sanitation', 30], ['vaccines', 160], ['antibiotics', 340], ['surgery and imaging', 620], ['genetics', 1300], ['gene therapy', 2600, 'future'], ['regenerative medicine', 4800, 'future']
  ],
  computing: [
    ['counting boards', 0], ['the printing press', 35], ['the telegraph', 170], ['radio', 330], ['computers', 650], ['the network', 1050], ['thinking machines', 2100], ['quantum computing', 3900, 'future']
  ],
  materials: [
    ['stone and wood', 0], ['bronze', 20], ['iron', 70], ['steel', 200], ['concrete', 360], ['light alloys', 700], ['composites', 1300], ['room-temperature superconductors', 3000, 'future']
  ]
});
export const RD_BRANCH_NAMES = Object.freeze(Object.keys(RD_BRANCHES));
const FOSSIL_FROM = 2; // coal and steam
const CLEAN_FROM = 6; // solar and wind
const FISSION = 5;
const DETERRENT = 7;

export function emptyRd() {
  const rd = { last: 0, points: {}, level: {}, pollution: 0, accidents: 0, arms_spent: 0 };
  for (const b of RD_BRANCH_NAMES) { rd.points[b] = 0; rd.level[b] = 0; }
  return rd;
}

// The discovery a country has reached in a branch, and the next one.
export function rdLevel(soc, branch) { return (soc && soc.rd && soc.rd.level && soc.rd.level[branch]) || 0; }
export function rdNow(soc, branch) { return RD_BRANCHES[branch][rdLevel(soc, branch)][0]; }
export function rdNext(soc, branch) { const n = RD_BRANCHES[branch][rdLevel(soc, branch) + 1]; return n ? { name: n[0], at: n[1], future: !!n[2] } : null; }

// Multipliers the rest of the society uses.
export function rdEffects(soc) {
  const L = (b) => rdLevel(soc, b);
  return {
    pay: 1 + L('energy') * 0.06,
    research: (1 + L('energy') * 0.03) * (1 + L('computing') * 0.08),
    buildCost: Math.max(0.45, 1 - L('industry') * 0.05 - L('materials') * 0.03),
    army: 1 + L('weapons') * 0.25,
    deterrent: L('weapons') >= DETERRENT,
    lifeYears: L('medicine') * 2,
    pollutionYears: Math.min(6, ((soc && soc.rd && soc.rd.pollution) || 0) / 20)
  };
}

// Once a day: share out the research gained since yesterday, make
// discoveries, pay for arms, add (or clean up) pollution, and now and then
// a reactor accident.
// atRisk: this country is standing off with, or at war with, another.
// hawk: its leader's ambition minus honesty.
export function researchStep({ soc, rand, emit, atRisk = false, hawk = 0, people = [] }) {
  if (!soc.rd) soc.rd = emptyRd();
  const rd = soc.rd;
  for (const b of RD_BRANCH_NAMES) { if (typeof rd.points[b] !== 'number') rd.points[b] = 0; if (typeof rd.level[b] !== 'number') rd.level[b] = 0; }
  const gained = Math.max(0, (soc.research || 0) - (rd.last || 0));
  rd.last = soc.research || 0;
  // What the country needs decides where the effort goes.
  const w = {
    energy: 1.2,
    industry: 1.1,
    weapons: 0.35 + (atRisk ? 1.6 : 0) + Math.max(0, hawk) * 0.8 + (soc.government === 'monarchy' ? 0.2 : 0),
    medicine: 0.8 + ((soc.deaths || 0) > (soc.births || 0) ? 0.5 : 0) + (rd.pollution > 30 ? 0.3 : 0),
    computing: 0.9,
    materials: 0.9
  };
  if (rd.pollution > 40) w.energy += 0.6; // the push for clean power
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  for (const b of RD_BRANCH_NAMES) rd.points[b] = Math.round((rd.points[b] + gained * w[b] / total) * 100) / 100;
  // Arms cost money: a share of the treasury while the effort leans to weapons.
  if (soc.currency && w.weapons > 1 && soc.treasury > 100) { const spend = Math.round(soc.treasury * 0.01 * w.weapons * 100) / 100; soc.treasury = Math.round((soc.treasury - spend) * 100) / 100; rd.arms_spent = Math.round(((rd.arms_spent || 0) + spend) * 100) / 100; }
  // Discoveries.
  const found = [];
  for (const b of RD_BRANCH_NAMES) {
    const ladder = RD_BRANCHES[b];
    while (ladder[rd.level[b] + 1] && rd.points[b] >= ladder[rd.level[b] + 1][1]) {
      rd.level[b] += 1;
      const [name, , future] = ladder[rd.level[b]];
      found.push([b, name]);
      emit('invention', `${soc.name || 'The people'} ${future ? 'made a breakthrough' : 'mastered'}: ${name} (${b})`, null);
      if (b === 'medicine') for (const p of people) if (typeof p.properties.lifespan === 'number') p.properties.lifespan = Math.round((p.properties.lifespan + 2) * 100) / 100;
    }
  }
  // Pollution: coal, oil and gas until clean power takes over.
  const e = rd.level.energy;
  if (e >= FOSSIL_FROM && e < CLEAN_FROM) rd.pollution = Math.min(100, Math.round((rd.pollution + 0.25 * (e - 1)) * 100) / 100);
  else if (e >= CLEAN_FROM) rd.pollution = Math.max(0, Math.round((rd.pollution - 2) * 100) / 100);
  // Fission is powerful and now and then goes wrong.
  if (e >= FISSION && e < CLEAN_FROM + 1 && rand() < 0.01) {
    rd.accidents = (rd.accidents || 0) + 1;
    soc.treasury = Math.round(Math.max(0, (soc.treasury || 0) - 200) * 100) / 100;
    rd.pollution = Math.min(100, rd.pollution + 10);
    emit('accident', `A reactor accident in ${soc.name || 'the country'}: the area was evacuated and the clean-up began`, null);
  }
  return found;
}
