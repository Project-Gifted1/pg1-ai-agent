/**
 * Pg1-Universe's people (lib/sandbox/society.mjs): countries with their own
 * cultures, governments and money; holidays abroad by ferry and by plane;
 * entertainment; police, prisons and armies; diplomacy between countries;
 * rare contact with other civilisations; and the slow, rare path to
 * working out what their world is and leaving a message for whoever
 * watches. Deterministic from the seed; no AI engine.
 *
 * Run with: node --test tests/sandbox-society.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepWorld, initialState, validateSpec, SANDBOX_LIMITS } from '../lib/sandbox/engine.mjs';
import { templateSpec, COUNTRIES } from '../lib/sandbox/templates.mjs';
import { CULTURES, GOVERNMENTS, awarenessStep, emptyAwareness, diplomacyStep, countryAt, AWARENESS_LEVELS, WAR_SCORE } from '../lib/sandbox/society.mjs';
import { containsBanned } from '../lib/sandbox/blind.mjs';
import { fromEvents } from '../lib/sandbox/blackbox.mjs';

const run = (spec, steps, st = null) => { let state = st || initialState(spec); const events = []; for (let n = steps; n > 0; n -= 100) { const r = stepWorld(spec, state, Math.min(100, n)); state = r.state; events.push(...r.events); } return { state, events }; };

// One run shared by the tests below (the universe, 4,000 steps).
const UNI = templateSpec('universe');
const LIVE = run(UNI, 4000);

test('the population limit is 1,000 entities, and the universe starts well under it', () => {
  assert.equal(SANDBOX_LIMITS.entities, 1000);
  assert.ok(UNI.entities.length < 700, `${UNI.entities.length} at the start`);
  assert.ok(LIVE.state.entities.length <= 1000);
});

test('four countries, each with its own culture, government, climate, names and currency', () => {
  const socs = LIVE.state.society;
  assert.deepEqual(Object.keys(socs).sort(), ['aurelia', 'maravia', 'nordheim', 'saltreach']);
  assert.deepEqual(new Set(Object.values(socs).map((x) => x.government)), new Set(GOVERNMENTS));
  for (const c of COUNTRIES) {
    const s = socs[c.code];
    assert.equal(s.name, c.name); assert.equal(s.culture, c.culture); assert.equal(s.climate, c.climate);
    assert.ok(CULTURES[c.culture].currency.includes(s.currency), `${c.name} money is its own (${s.currency})`);
    const people = LIVE.state.entities.filter((e) => e.kind === 'person' && e.properties.country === c.code && !e.properties.abroad);
    assert.ok(people.length > 0);
    const names = new Set([...CULTURES[c.culture].female, ...CULTURES[c.culture].male]);
    assert.ok(people.filter((p) => !p.id.startsWith('child-')).every((p) => names.has(p.properties.name) || p.id.startsWith('person-')), `${c.name} names its people its own way`);
  }
  // A monarchy has a King or Queen; a council a Speaker; a democracy elections.
  assert.match(socs.nordheim.title, /^(King|Queen)$/);
  assert.equal(socs.maravia.title, 'Speaker of the Council');
  assert.ok(socs.aurelia.elections > 0);
});

test('people holiday abroad by ferry and by plane, pay their fares and hotel, and come home', () => {
  const travel = LIVE.events.filter((e) => e.kind === 'travel').map((e) => e.summary);
  assert.ok(travel.some((t) => /boarded .+ (Harbour)/.test(t)), 'by sea');
  assert.ok(travel.some((t) => /arrived in (Aurelia|Maravia|Nordheim|Saltreach) for a holiday/.test(t)));
  assert.ok(travel.some((t) => /came home from a holiday/.test(t)), 'and home again');
  // By air once flight is known: a long run with flight technology everywhere.
  const spec = validateSpec({ ...UNI });
  let st = JSON.parse(JSON.stringify(LIVE.state));
  for (const s of Object.values(st.society)) { s.research = Math.max(s.research, 1300); s.tech = 3; }
  for (const e of st.entities) if (e.kind === 'person') e.properties.money = 400;
  const air = run(spec, 1500, st).events.filter((e) => e.kind === 'travel').map((e) => e.summary);
  assert.ok(air.some((t) => /took a flight/.test(t)), 'by plane');
  assert.ok(air.some((t) => /landed in/.test(t)), 'landing abroad');
});

test('leisure, shows, police and prisons, and every inhabitant\'s words stay free of the words a blind subject must not see', () => {
  const kinds = new Set(LIVE.events.map((e) => e.kind));
  for (const k of ['leisure', 'election', 'currency', 'talk', 'birth', 'career']) assert.ok(kinds.has(k), k);
  for (const e of LIVE.events.filter((x) => ['talk', 'hypothesis', 'proof', 'message_to_observer'].includes(x.kind))) assert.equal(containsBanned(e.summary), false, e.summary);
  // The black box records inhabitants' travel and leisure.
  const byId = new Map(LIVE.state.entities.map((e) => [e.id, e]));
  const recs = fromEvents(LIVE.events, byId);
  assert.ok(recs.some((r) => r.action === 'travel' && r.actor_type === 'inhabitant'));
});

test('countries are where their islands are', () => {
  const islands = UNI.entities.filter((e) => e.kind === 'island').map((e) => ({ code: e.properties.country, x: e.position.x, y: e.position.y, r: e.properties.radius }));
  assert.equal(countryAt({ x: 2000, y: 2200 }, islands), 'aurelia');
  assert.equal(countryAt({ x: 8200, y: 2300 }, islands), 'maravia');
  assert.equal(countryAt({ x: 5000, y: 4500 }, islands), 'home', 'the open sea is no country');
});

test('diplomacy: tourism and trade warm relations, disputes strain them; a standoff mobilises both armies and, short of the worst, ends in a peace treaty without fighting', () => {
  const societies = { a: { name: 'Avalon', tourists: 0, leader: 'la' }, b: { name: 'Borea', tourists: 0, leader: 'lb' } };
  const ents = [
    { id: 'la', kind: 'person', properties: { ambition: 1, honesty: 0 }, position: { x: 0, y: 0 } },
    { id: 'lb', kind: 'person', properties: { ambition: 1, honesty: 0 }, position: { x: 0, y: 0 } },
    { id: 'sold-a', kind: 'person', properties: { job: 'soldier', country: 'a' }, position: { x: 0, y: 0 } },
    { id: 'port-a', kind: 'port', properties: {}, position: { x: 50, y: 0 } }
  ];
  const diplomacy = { 'a|b': { score: -70, status: 'peace', since: 0, tourists: 0 } };
  const events = [];
  const emit = (kind, summary) => events.push({ kind, summary });
  let x = 0.5; const rand = () => { x = (x * 9301 + 49297) % 233280 / 233280; return x; };
  diplomacyStep({ diplomacy, societies, ents, removed: new Set(), emit, rand, tick: 24 });
  assert.equal(diplomacy['a|b'].status, 'standoff');
  assert.equal(ents[2].properties.target, 'port-a', 'soldiers to their harbour');
  diplomacyStep({ diplomacy, societies, ents, removed: new Set(), emit, rand, tick: 24 + 240 * 3 });
  assert.equal(diplomacy['a|b'].status, 'peace');
  assert.ok(events.some((e) => e.kind === 'treaty' && /peace treaty/.test(e.summary)));
  assert.ok(!events.some((e) => /killed|died|battle/i.test(e.summary)), 'no fighting');
});

// Two countries at their worst, standing off; leaders, soldiers and treasuries as given.
function brink({ hawks = true, government = 'monarchy', soldiers = 6, score = -95 } = {}) {
  const societies = { a: { name: 'Avalon', leader: 'la', government, treasury: 1000, currency: 'crown', tech: 2 }, b: { name: 'Borea', leader: 'lb', government: 'monarchy', treasury: 1000, currency: 'mark', tech: 2 } };
  const leader = (id) => ({ id, kind: 'person', properties: hawks ? { ambition: 0.9, honesty: 0.1 } : { ambition: 0.3, honesty: 0.9 }, position: { x: 0, y: 0 } });
  const ents = [leader('la'), leader('lb')];
  for (const c of ['a', 'b']) for (let i = 0; i < soldiers; i++) ents.push({ id: `sold-${c}-${i}`, kind: 'person', properties: { job: 'soldier', country: c, name: `S${i}` }, position: { x: 0, y: 0 } });
  const diplomacy = { 'a|b': { score, status: 'standoff', since: 0, tourists: 0 } };
  const events = [];
  return { societies, ents, diplomacy, events, removed: new Set(), emit: (kind, summary, ref) => events.push({ kind, summary, ref }) };
}

test('war is possible but the last resort: only at the worst relations, after the talks run out, with a hawk in charge; soldiers die, treasuries pay, and it ends in an armistice', () => {
  const w = brink();
  const rand = () => 0.2; // no dispute, no trade deal, the talks fail, the dice say war
  let tick = 240 * 3;
  diplomacyStep({ ...w, rand, tick });
  assert.equal(w.diplomacy['a|b'].status, 'war');
  assert.ok(w.events.some((e) => e.kind === 'war_declared' && /after talks failed/.test(e.summary)));
  while (w.diplomacy['a|b'].status === 'war' && tick < 240 * 20) { tick += 24; diplomacyStep({ ...w, rand, tick }); }
  const d = w.diplomacy['a|b'];
  assert.equal(d.status, 'peace', 'every war ends');
  assert.equal(d.score, -40, 'and relations stay cold');
  assert.ok(w.events.some((e) => e.kind === 'battle'));
  const fallen = w.events.filter((e) => e.kind === 'death' && /died in the war/.test(e.summary));
  assert.ok(fallen.length > 0 && fallen.length === d.last_war.dead);
  assert.ok(fallen.every((e) => e.ref.startsWith('sold-')), 'only soldiers fall; civilians are not targeted');
  assert.ok(fallen.every((e) => w.removed.has(e.ref)));
  assert.ok(w.events.some((e) => e.kind === 'armistice' && /reparations/.test(e.summary)));
  assert.ok(w.societies.a.treasury !== w.societies.b.treasury, 'the loser paid the winner');
  assert.equal(w.societies.a.wars, 1);
});

test('war is not the go-to: honest leaders, relations short of the worst, no army, or the talks succeeding all end in peace', () => {
  const rand = () => 0.2;
  for (const opts of [{ hawks: false }, { score: WAR_SCORE + 20 }, { soldiers: 0 }]) {
    const w = brink(opts);
    diplomacyStep({ ...w, rand, tick: 240 * 3 });
    assert.equal(w.diplomacy['a|b'].status, 'peace', JSON.stringify(opts));
    assert.ok(w.events.some((e) => e.kind === 'treaty' && /peace treaty/.test(e.summary)));
  }
  // Talks can end a standoff early, before the deadline.
  const early = brink();
  diplomacyStep({ ...early, rand: () => 0.02, tick: 24 });
  assert.equal(early.diplomacy['a|b'].status, 'peace');
  assert.match(early.events.find((e) => e.kind === 'treaty').summary, /after talks/);
  // A democracy is less willing: the same dice that send a monarchy to war keep it at peace.
  const demo = brink({ government: 'democracy' });
  diplomacyStep({ ...demo, rand: () => 0.25, tick: 240 * 3 });
  assert.equal(demo.diplomacy['a|b'].status, 'peace');
  // And in four thousand steps of the universe, no war broke out.
  assert.ok(!LIVE.events.some((e) => e.kind === 'war_declared'));
});

test('awareness is rare: nothing before both the edge of the sea and the roof of the sky are seen; then a hypothesis, a test at interstellar technology, and a message left for whoever watches', () => {
  assert.equal(LIVE.state.awareness.level, 0, 'four thousand steps in, they have not worked it out');
  const aw = { ...emptyAwareness(), evidence: 500, edge_seen: 1, sky_seen: 0 };
  const sci = { id: 'sci', kind: 'person', properties: { name: 'Iris', family: 'Novak', job: 'scientist', curiosity: 0.95, education: 21 }, position: { x: 100, y: 100 } };
  const ents = [sci];
  const events = [];
  const ctx = { awareness: aw, societies: { home: { name: 'Avalon', tech: 6, leader: null } }, emit: (kind, summary, ref) => events.push({ kind, summary, ref }), rand: () => 0.01, tick: 40, ents, removed: new Set(), add: (e) => { ents.push(e); return e; }, room: () => true, newId: (p) => `${p}-1`, s: { size: { x: 1000, y: 1000, z: 1000 } } };
  awarenessStep({}, ctx);
  assert.equal(aw.level, 0, 'the roof of the sky has not been seen');
  aw.sky_seen = 1;
  awarenessStep({}, ctx);
  assert.ok(aw.level >= 1);
  assert.ok(events.some((e) => e.kind === 'hypothesis' && /was made, and is watched/.test(e.summary)));
  ctx.tick = 80; awarenessStep({}, ctx);
  assert.ok(events.some((e) => e.kind === 'proof'));
  assert.ok(events.some((e) => e.kind === 'message_to_observer' && /whoever watches/.test(e.summary)));
  assert.ok(ents.some((e) => e.kind === 'monument' && e.properties.name === 'the Listening Stone'), 'they raise a monument with the message');
  assert.equal(AWARENESS_LEVELS[aw.level], 'is trying to reach whoever watches');
  assert.equal(aw.messages.length, 1);
  for (const e of events) assert.equal(containsBanned(e.summary), false, e.summary);
});

test('other civilisations are hard to meet: no contact without an expedition getting there', () => {
  const contacts = Object.values(LIVE.state.society).flatMap((s) => s.contacts);
  assert.deepEqual(contacts, [], 'no contact in four thousand steps');
  const far = UNI.entities.filter((e) => e.kind === 'alien_world');
  assert.equal(far.length, 2);
  for (const w of far) assert.ok(w.position.z >= 9800 && (w.position.x > 11000 || w.position.y < 500), 'at the very edge of the sky');
});
