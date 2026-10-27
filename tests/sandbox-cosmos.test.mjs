// The wider cosmos (lib/sandbox/cosmos.mjs): other civilisations at many
// levels of technology, living lives of their own; peaceful contact by
// default, conflict only by a world's own rule and never on the ground;
// the hazards of space (radiation belts, flares, meteoroids), with
// shielding by technology; deterministic and within the limits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosmosStep, emptyCosmos, civFor, shieldOf, CIV_LEVELS } from '../lib/sandbox/cosmos.mjs';
import { initialState, stepWorld, validateSpec, SANDBOX_LIMITS } from '../lib/sandbox/engine.mjs';
import { templateSpec } from '../lib/sandbox/templates.mjs';
import { containsBanned } from '../lib/sandbox/blind.mjs';

const UNI = templateSpec('universe');

function ctx({ ents, societies = {}, cosmos = emptyCosmos(), tick = 240, dice = () => 0.5, s = { day_steps: 240, space_altitude: 2000, seed: 1 } }) {
  const events = [];
  return { args: { s, ents, removed: new Set(), societies, cosmos, emit: (kind, summary, ref) => events.push({ kind, summary, ref }), rand: dice, tick, add: (e) => { ents.push(e); return e; }, room: () => ents.length < SANDBOX_LIMITS.entities - 10, newId: (k) => `${k}-${tick}-${ents.length}` }, events };
}
const far = (id, name, tech) => ({ id, kind: 'alien_world', position: { x: 11000, y: 7000, z: 9900 }, properties: { name, tech, size: 80 } });

test('far worlds at many levels: from far behind the inhabitants to far beyond them', () => {
  const civs = UNI.entities.filter((e) => e.kind === 'alien_world');
  const levels = new Set(civs.map((w) => civFor(emptyCosmos(), w).tech));
  assert.ok(levels.size >= 3, `levels ${[...levels].join(', ')}`);
  assert.ok(Math.max(...levels) === 7 && Math.min(...levels) === 0);
  assert.equal(CIV_LEVELS[7], 'far beyond interstellar travel');
  // A world without a set level gets one from the seed, the same every time.
  const w = far('alien_world-x', 'the Test', undefined);
  assert.equal(civFor(emptyCosmos(), w, 5).tech, civFor(emptyCosmos(), w, 5).tech);
});

test('they progress and found outposts of their own, at most two each', () => {
  const ents = [far('w1', 'the Kesh', 5), far('w2', 'the Amaru', 0), ...Array.from({ length: 4 }, (_, i) => ({ id: `moon-${i}`, kind: 'moon', position: { x: 0, y: 0, z: 9000 }, properties: { size: 20 } }))];
  const cosmos = emptyCosmos();
  const all = [];
  for (let d = 1; d <= 200; d++) { const { args, events } = ctx({ ents, cosmos, tick: d * 240, dice: () => 0.01 }); cosmosStep({ hazards: false }, args); all.push(...events); }
  assert.equal(ents.filter((e) => e.kind === 'colony' && e.properties.civ === 'the Kesh').length, 2, 'two outposts, no more');
  assert.ok(all.some((e) => e.kind === 'civ_progress' && /the Amaru/.test(e.summary)), 'a young civilisation rises a level (slowly: months of their days)');
  assert.ok(all.every((e) => !containsBanned(e.summary)), 'nothing a blind subject must not see');
});

test('peaceful by default: exchanges only, and the less advanced learn from the more advanced', () => {
  const ents = [far('w1', 'the Vel', 7)];
  const soc = { name: 'Aurelia', tech: 3, research: 0, treasury: 1000, contacts: ['the Vel'] };
  const cosmos = emptyCosmos(); const all = [];
  for (let d = 1; d <= 60; d++) { let q = d; const { args, events } = ctx({ ents, societies: { home: soc }, cosmos, tick: d * 240, dice: () => { q = (q * 9301 + 49297) % 233280; return q / 233280; } }); cosmosStep({ hazards: false }, args); all.push(...events); }
  const kinds = new Set(all.map((e) => e.kind));
  assert.ok(kinds.has('exchange'));
  for (const k of ['dispute', 'standoff', 'skirmish']) assert.ok(!kinds.has(k), `no ${k} without the conflict rule`);
  assert.ok(soc.research > 0, 'they learned something');
  assert.equal(soc.treasury, 1000, 'nothing lost');
});

test('conflict only with the world\'s own rule: disputes and standoffs, rarely a clash in orbit, never on the ground', () => {
  const ents = [far('w1', 'the Kesh', 5), { id: 'person-1', kind: 'person', position: { x: 0, y: 0, z: 0 }, properties: {} }];
  const soc = { name: 'Aurelia', tech: 5, research: 0, treasury: 5000, contacts: ['the Kesh'] };
  const cosmos = emptyCosmos(); const all = [];
  for (let d = 1; d <= 400; d++) { let q = d * 7; const { args, events } = ctx({ ents, societies: { home: soc }, cosmos, tick: d * 240, dice: () => { q = (q * 9301 + 49297) % 233280; return q / 233280; } }); cosmosStep({ conflict: true, hazards: false }, args); all.push(...events); }
  const kinds = new Set(all.map((e) => e.kind));
  assert.ok(kinds.has('dispute'), 'disputes happen');
  assert.ok(ents.some((e) => e.id === 'person-1'), 'no one on the ground is touched');
  for (const e of all.filter((x) => x.kind === 'skirmish')) assert.match(e.summary, /in orbit, far from anyone's home; a truce followed/);
});

test('hazards: the radiation belt makes an unshielded crew ill and the craft turns back; shielding helps; hazards can be turned off', () => {
  const make = () => [
    { id: 'pad-1', kind: 'launch_pad', position: { x: 0, y: 0, z: 0 }, properties: {} },
    { id: 'rocket-1', kind: 'rocket', position: { x: 0, y: 0, z: 2400 }, properties: { name: 'Dawn', target: 'planet-x' } },
    { id: 'astro-1', kind: 'astronaut', position: { x: 0, y: 0, z: 2400 }, properties: { name: 'Ida', inside: 'rocket-1' } }
  ];
  const run = (tech, rule, steps = 140) => { const ents = make(); const cosmos = emptyCosmos(); cosmos.next_flare = 1e9; const all = []; for (let t = 1; t <= steps; t++) { const { args, events } = ctx({ ents, societies: { home: { tech, contacts: [] } }, cosmos, tick: t }); cosmosStep(rule, args); all.push(...events); } return { ents, all }; };
  const raw = run(0, { hazards: true });
  assert.ok(raw.all.some((e) => e.kind === 'radiation_sickness'), 'ill');
  assert.ok(raw.all.some((e) => e.kind === 'mission_abort'), 'turned back');
  assert.equal(raw.ents.find((e) => e.id === 'rocket-1').properties.target, 'pad-1', 'heading home');
  assert.ok(raw.ents.some((e) => e.id === 'astro-1'), 'no one dies of it');
  const shielded = run(6, { hazards: true });
  assert.ok((shielded.ents.find((e) => e.id === 'astro-1').properties.rad_dose || 0) < (raw.ents.find((e) => e.id === 'astro-1').properties.rad_dose || 60), 'less dose with shielding');
  assert.ok(shieldOf(6) > shieldOf(0));
  const off = run(0, { hazards: false });
  assert.equal(off.ents.find((e) => e.id === 'astro-1').properties.rad_dose, undefined, 'no hazards when turned off');
});

test('the universe with the cosmos: 2,000 steps, the same every time, within the limits, flares and belts met', () => {
  const run = () => { let st = initialState(UNI); const ev = []; for (let i = 0; i < 20; i++) { const r = stepWorld(UNI, st, 100); st = r.state; ev.push(...r.events); } return { st, ev }; };
  const a = run(); const b = run();
  assert.deepEqual(a.st.cosmos, b.st.cosmos, 'deterministic');
  assert.equal(JSON.stringify(a.st.entities), JSON.stringify(b.st.entities));
  assert.ok(a.st.entities.length <= SANDBOX_LIMITS.entities);
  assert.ok(a.ev.some((e) => e.kind === 'flare'), 'a solar flare');
  assert.ok(a.ev.some((e) => ['radiation_sickness', 'mission_abort', 'meteoroid'].includes(e.kind)), 'a hazard met in space');
  assert.ok(UNI.rules.some((r) => r.type === 'cosmos' && r.conflict === false), 'peaceful in the template');
  assert.doesNotThrow(() => validateSpec({ ...UNI, rules: [...UNI.rules.filter((r) => r.type !== 'cosmos'), { id: 'c', type: 'cosmos', conflict: true }] }));
});
