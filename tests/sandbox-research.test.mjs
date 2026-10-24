/**
 * Research and development in Pg1-Universe (lib/sandbox/research.mjs):
 * energy, industry, weapons, medicine, computing and materials, discovered
 * in the order they came for us, then possible future discoveries; with
 * real effects (richer work, pollution and clean power, reactor accidents,
 * cheaper building, stronger armies, mutual deterrence, longer lives,
 * faster research).
 *
 * Run with: node --test tests/sandbox-research.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RD_BRANCHES, RD_BRANCH_NAMES, emptyRd, researchStep, rdEffects, rdNow, rdNext } from '../lib/sandbox/research.mjs';
import { diplomacyStep } from '../lib/sandbox/society.mjs';
import { stepWorld, initialState } from '../lib/sandbox/engine.mjs';
import { templateSpec } from '../lib/sandbox/templates.mjs';
import { fromEvents } from '../lib/sandbox/blackbox.mjs';

const soc = (extra = {}) => ({ name: 'Avalon', government: 'democracy', currency: 'crown', treasury: 1000, research: 0, births: 0, deaths: 0, rd: emptyRd(), ...extra });
const quiet = () => 0.99; // no accidents

test('six branches, each a realistic ladder in order, with future discoveries only at the top', () => {
  assert.deepEqual(RD_BRANCH_NAMES, ['energy', 'industry', 'weapons', 'medicine', 'computing', 'materials']);
  for (const [b, ladder] of Object.entries(RD_BRANCHES)) {
    assert.equal(ladder[0][1], 0, `${b} starts at nothing`);
    for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i][1] > ladder[i - 1][1], `${b} climbs`);
    const firstFuture = ladder.findIndex((x) => x[2] === 'future');
    assert.ok(firstFuture > 3 && ladder.slice(firstFuture).every((x) => x[2] === 'future'), `${b}: today's science first, then the future`);
  }
  const names = (b) => RD_BRANCHES[b].map((x) => x[0]);
  assert.ok(names('energy').indexOf('coal and steam power') < names('energy').indexOf('electricity'));
  assert.ok(names('energy').indexOf('nuclear fission') < names('energy').indexOf('fusion power'));
  assert.ok(names('weapons').indexOf('gunpowder') < names('weapons').indexOf('a nuclear deterrent'));
  // The viewer's copy of the ladders matches.
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const b of RD_BRANCH_NAMES) for (const [n] of RD_BRANCHES[b]) assert.ok(html.includes(`'${n}'`), `the viewer knows ${n}`);
});

test('research is shared by need: a country under threat, or led by a hawk, leans to weapons and pays for arms', () => {
  const calm = soc({ research: 1000 });
  researchStep({ soc: calm, rand: quiet, emit: () => {} });
  const tense = soc({ research: 1000 });
  researchStep({ soc: tense, rand: quiet, emit: () => {}, atRisk: true, hawk: 0.8 });
  assert.ok(tense.rd.points.weapons > calm.rd.points.weapons * 3, 'far more into weapons');
  assert.ok(tense.rd.points.energy < calm.rd.points.energy, 'and less into the rest');
  assert.ok(tense.treasury < calm.treasury && tense.rd.arms_spent > 0, 'arms cost the treasury');
  // Only new research is shared out.
  const before = { ...tense.rd.points };
  researchStep({ soc: tense, rand: quiet, emit: () => {} });
  assert.deepEqual(tense.rd.points, before);
});

test('discoveries are announced (and kept in the black box); medicine lengthens lives; pollution rises with coal and oil and clears with clean power; fission now and then has an accident', () => {
  const s = soc({ research: 0 });
  const people = [{ id: 'p1', kind: 'person', properties: { lifespan: 70 } }];
  const events = []; const emit = (kind, summary, ref) => events.push({ kind, summary, ref, tick: 1 });
  s.research = 8000; researchStep({ soc: s, rand: quiet, emit, people });
  assert.ok(events.some((e) => e.kind === 'invention' && /mastered: electricity \(energy\)/.test(e.summary)));
  assert.ok(rdNow(s, 'energy') !== 'wood and fire' && rdNext(s, 'energy'));
  assert.ok(people[0].properties.lifespan > 70, 'medicine added years');
  assert.ok(fromEvents(events, new Map()).notable.some((r) => r.action === 'invention' && r.actor_type === 'world'));
  // Pollution: coal and oil (energy 2..5) add it; solar and wind take it away.
  const dirty = soc({ rd: { ...emptyRd(), level: { ...emptyRd().level, energy: 4 } } });
  for (let i = 0; i < 40; i++) researchStep({ soc: dirty, rand: quiet, emit });
  assert.ok(dirty.rd.pollution > 20);
  assert.ok(rdEffects(dirty).pollutionYears > 0, 'and shortens lives');
  dirty.rd.level.energy = 6;
  for (let i = 0; i < 40; i++) researchStep({ soc: dirty, rand: quiet, emit });
  assert.equal(dirty.rd.pollution, 0, 'clean power clears it');
  const reactor = soc({ rd: { ...emptyRd(), level: { ...emptyRd().level, energy: 5 } } });
  researchStep({ soc: reactor, rand: () => 0.001, emit });
  assert.equal(reactor.rd.accidents, 1);
  assert.ok(events.some((e) => e.kind === 'accident' && /reactor accident/.test(e.summary)));
});

test('what it changes: richer work, faster research, cheaper building, stronger armies, longer lives', () => {
  const low = rdEffects(soc());
  const high = rdEffects(soc({ rd: { ...emptyRd(), level: { energy: 6, industry: 6, weapons: 7, medicine: 5, computing: 6, materials: 6 } } }));
  assert.ok(high.pay > low.pay && high.research > low.research && high.buildCost < low.buildCost && high.army > low.army && high.lifeYears > low.lifeYears);
  assert.equal(low.deterrent, false); assert.equal(high.deterrent, true);
});

test('mutual deterrence: when both hold a nuclear deterrent, the same quarrel that would end in war ends in a treaty', () => {
  const setup = (deterrent) => {
    const rd = () => ({ ...emptyRd(), level: { ...emptyRd().level, weapons: deterrent ? 7 : 3 } });
    const societies = { a: { name: 'Avalon', leader: 'la', government: 'monarchy', treasury: 1000, rd: rd() }, b: { name: 'Borea', leader: 'lb', government: 'monarchy', treasury: 1000, rd: rd() } };
    const ents = [{ id: 'la', kind: 'person', properties: { ambition: 0.9, honesty: 0.1 }, position: { x: 0, y: 0 } }, { id: 'lb', kind: 'person', properties: { ambition: 0.9, honesty: 0.1 }, position: { x: 0, y: 0 } }];
    for (const c of ['a', 'b']) for (let i = 0; i < 4; i++) ents.push({ id: `sold-${c}-${i}`, kind: 'person', properties: { job: 'soldier', country: c }, position: { x: 0, y: 0 } });
    const diplomacy = { 'a|b': { score: -95, status: 'standoff', since: 0, tourists: 0 } };
    diplomacyStep({ diplomacy, societies, ents, removed: new Set(), emit: () => {}, rand: () => 0.2, tick: 720 });
    return diplomacy['a|b'].status;
  };
  assert.equal(setup(false), 'war');
  assert.equal(setup(true), 'peace');
});

test('in the universe, countries research and discover on their own', () => {
  const spec = templateSpec('universe');
  let st = initialState(spec); const events = [];
  for (let i = 0; i < 30; i++) { const r = stepWorld(spec, st, 100); st = r.state; events.push(...r.events); }
  assert.ok(events.some((e) => e.kind === 'invention'), 'some discoveries in 3,000 steps');
  for (const s of Object.values(st.society)) assert.ok(s.rd && RD_BRANCH_NAMES.every((b) => typeof s.rd.level[b] === 'number'));
});
