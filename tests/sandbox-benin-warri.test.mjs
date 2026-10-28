/**
 * The benin-warri template (lib/sandbox/benin-warri.mjs): Benin and Warri
 * c. 1610, a simulation inspired by history with fictional inhabitants,
 * sourced in docs/sandbox-benin-warri.md; and /sandbox retemplate
 * (lib/sandbox/retemplate.mjs).
 *
 *   - the template builds the same every time and fits the limits;
 *   - no anachronistic kinds (cars, bikes, planes, rockets, space...), and
 *     no church or resident priest (the doc found no source for one in 1610);
 *   - Urhobo and Ijaw settlements of their own, trading with Warri;
 *   - no ground thing stands on water (the creeks) in a 2,000-step run;
 *   - the words a blind subject must not see stay out; real people are in
 *     the History panel only;
 *   - retemplate refuses other owners' worlds, blind copies and PG1's
 *     oldest world, works on a newer one and writes its black box record.
 *
 * Run with: node --test tests/sandbox-benin-warri.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialState, stepWorld, validateSpec, cleanRule, SANDBOX_LIMITS } from '../lib/sandbox/engine.mjs';
import { templateSpec, TEMPLATE_NAMES } from '../lib/sandbox/templates.mjs';
import { beninWarriSpec, PEOPLES } from '../lib/sandbox/benin-warri.mjs';
import { buildTerrain } from '../lib/sandbox/terrain.mjs';
import { catalogFor } from '../lib/sandbox/catalog.mjs';
import { containsBanned, checkPlaceForBlind } from '../lib/sandbox/blind.mjs';
import { historyOf, HISTORIES } from '../public/sandbox/history.js';
import { createSandboxStore, __resetSandboxMemory } from '../lib/sandbox/store.mjs';
import { createWorld, stepWorldFor, pg1Principal, inviteAgent, resolveSandboxKey } from '../lib/sandbox/worlds.mjs';
import { startExperiment } from '../lib/sandbox/experiments.mjs';
import { handleSandboxCommand } from '../lib/sandbox/chat.mjs';

const SPEC = templateSpec('benin-warri');
const DOC = readFileSync(new URL('../docs/sandbox-benin-warri.md', import.meta.url), 'utf8');
const ANACHRONISTIC = ['car', 'taxi', 'police_car', 'bus', 'truck', 'army_truck', 'tractor', 'bike', 'motorbike', 'train', 'plane', 'small_plane', 'jet', 'helicopter', 'drone', 'hot_air_balloon', 'rocket', 'shuttle', 'space_station', 'satellite', 'planet', 'moon', 'star', 'asteroid', 'colony', 'alien_world', 'alien_ship', 'tower', 'apartment', 'factory', 'hospital', 'school', 'station', 'hangar', 'runway', 'launch_pad', 'terminal', 'cinema', 'theatre', 'bar', 'stadium', 'hotel', 'cafe', 'shop', 'police_station', 'prison', 'barracks', 'road', 'lamp', 'patrol_boat', 'ferry'];
const CHURCH = /church|chapel|monastery|cathedral|mission/i;

function run(spec, steps) {
  let st = initialState(spec); const events = []; const T = buildTerrain(spec.entities, spec.size); const onWater = []; const kinds = new Set();
  for (let n = 0; n < steps; n++) {
    const r = stepWorld(spec, st, 1); st = r.state; events.push(...r.events.filter((e) => e.kind !== 'decide'));
    const index = new Map(st.entities.map((e) => [e.id, e]));
    for (const e of st.entities) {
      kinds.add(e.kind);
      const c = catalogFor(e.kind);
      if (c.domain !== 'ground' || !['person', 'animal', 'vehicle'].includes(c.class)) continue;
      if (typeof e.properties.inside === 'string' && index.has(e.properties.inside)) continue;
      if (!T.isLand(e.position.x, e.position.y)) onWater.push([st.tick, e.id, e.position]);
    }
  }
  return { state: st, events, onWater, kinds };
}
const RUN = run(SPEC, 2000);

test('the template is listed, builds the same JSON every time, and fits every limit', () => {
  assert.ok(TEMPLATE_NAMES.includes('benin-warri'));
  assert.deepEqual(templateSpec('benin-warri'), SPEC);
  assert.deepEqual(beninWarriSpec(), SPEC);
  assert.deepEqual(validateSpec(SPEC), SPEC);
  assert.ok(SPEC.entities.length <= SANDBOX_LIMITS.entities && SPEC.rules.length <= SANDBOX_LIMITS.rules);
  assert.ok(Buffer.byteLength(JSON.stringify(SPEC)) < SANDBOX_LIMITS.specBytes);
  assert.ok(RUN.state.entities.length <= SANDBOX_LIMITS.entities);
});

test('period things only: no cars, bikes, planes, rockets or space, at the start or after 2,000 steps', () => {
  for (const k of ANACHRONISTIC) {
    assert.ok(!SPEC.entities.some((e) => e.kind === k), `no ${k} at the start`);
    assert.ok(!RUN.kinds.has(k), `no ${k} after 2,000 steps`);
  }
  // Nothing in the air or in space, no talk of flights, and nothing modern bought for a home.
  assert.ok(![...RUN.kinds].some((k) => ['air', 'space'].includes(catalogFor(k).domain)), 'nothing flies');
  assert.deepEqual(RUN.events.filter((e) => /\b(flight|flights|flew|airport|runway|plane|rocket|space)\b/i.test(e.summary)).map((e) => e.summary).slice(0, 3), []);
  assert.deepEqual(RUN.events.filter((e) => e.kind === 'bought' && /sofa|television|desk|lamp|bookshelf|mirror|dining set|car\b/.test(e.summary)).map((e) => e.summary).slice(0, 3), []);
  for (const k of ['canoe', 'carrack', 'compound', 'palace', 'brass_workshop', 'ivory_workshop', 'canoe_landing', 'fishing_village', 'royal_tomb', 'earthwork', 'porter']) assert.ok(SPEC.entities.some((e) => e.kind === k), k);
  // Technology stays at its time; a per-world rule can let it move on.
  const life = SPEC.rules.find((r) => r.type === 'life');
  assert.equal(life.progress, false);
  assert.ok(Object.values(RUN.state.society).every((s) => s.tech === 0));
  assert.ok(!RUN.events.some((e) => e.kind === 'invention' || e.kind === 'technology' || e.kind === 'construction'));
  assert.equal(cleanRule({ ...life, progress: true }).progress, true, 'progression can be allowed for a world');
  // No disputes, standoffs or wars are invented.
  assert.equal(life.peaceful, true);
  assert.ok(!RUN.events.some((e) => ['dispute', 'standoff', 'war_declared', 'battle'].includes(e.kind)));
});

test('no church, monastery or resident priest in 1610: none in the world, and the doc says why', () => {
  assert.match(DOC, /\*\*No church, monastery or resident priest in 1610\.\*\*/);
  assert.match(DOC, /mission church in the first plan for this template was \*\*removed\*\*/);
  for (const e of [...SPEC.entities, ...RUN.state.entities]) {
    assert.doesNotMatch(e.kind, CHURCH, e.id);
    assert.doesNotMatch(String(e.properties.name || ''), CHURCH, e.id);
    assert.ok(!/priest|friar|missionar/i.test(`${e.properties.job || ''} ${e.properties.role || ''}`), `${e.id} is no priest`);
  }
});

test('Benin and Warri are kingdoms (Oba and Olu); Urhobo and Ijaw are settlements of their own, distinct in culture and names, and trade with Warri', () => {
  const socs = RUN.state.society;
  assert.deepEqual(Object.keys(socs).sort(), ['benin', 'ijaw', 'urhobo', 'warri']);
  assert.equal(socs.benin.title, 'Oba'); assert.equal(socs.warri.title, 'Olu');
  assert.equal(socs.benin.culture, 'edo'); assert.equal(socs.warri.culture, 'itsekiri'); assert.equal(socs.urhobo.culture, 'urhobo'); assert.equal(socs.ijaw.culture, 'ijaw');
  for (const code of ['urhobo', 'ijaw']) {
    assert.ok(SPEC.entities.some((e) => e.kind === 'island' && e.properties.country === code), `${code}: its own land`);
    assert.ok(SPEC.entities.some((e) => ['compound', 'fishing_village'].includes(e.kind) && e.properties.country === code), `${code}: homes`);
    assert.ok(SPEC.entities.some((e) => e.kind === 'canoe_landing' && e.properties.country === code), `${code}: a landing`);
    assert.ok(SPEC.entities.filter((e) => e.kind === 'person' && e.properties.country === code).length >= 10, `${code}: people`);
  }
  const trade = RUN.events.filter((e) => e.kind === 'trade').map((e) => e.summary);
  const between = (a, b) => trade.some((s) => (s.startsWith(`Traders from ${a} `) && s.includes(`(${b})`)) || (s.startsWith(`Traders from ${b} `) && s.includes(`(${a})`)));
  assert.ok(between('Warri', 'Urhobo'), 'Warri and the Urhobo trade');
  assert.ok(between('Warri', 'Ijaw'), 'Warri and the Ijaw trade');
  assert.ok(trade.some((s) => /the Portuguese/.test(s)), 'and with the Portuguese ship, at the anchorages');
  assert.ok(!trade.some((s) => /slave|enslav|captive|people for/i.test(s)), 'goods only: never people');
  assert.ok(socs.warri.trades > 0 && socs.urhobo.trades > 0 && socs.ijaw.trades > 0);
});

test('2,000 steps: no ground thing ever stands on water in the creeks, rivers or sea', () => {
  assert.deepEqual(RUN.onWater.slice(0, 5), []);
  const T = buildTerrain(SPEC.entities, SPEC.size);
  assert.equal(T.landType(PEOPLES[1].x, PEOPLES[1].y), 'land', 'Ode-Itsekiri on its island');
  assert.equal(T.isWater(PEOPLES[1].x + 1300, PEOPLES[1].y), true, 'water round Warri');
  assert.equal(T.landType(3000, 4200), 'mangrove');
  assert.equal(T.isWater(6255, 3830), true, 'the river to the coast');
});

test('the storyline is fictional and labelled; real people appear in the History panel only; Nok is far older and can be found', () => {
  const story = RUN.events.filter((e) => e.kind === 'storyline');
  assert.equal(story.length, 1);
  assert.match(story[0].summary, /^Storyline \(fictional, inspired by history\): .+ came home from years of study in Lisbon, with .+, and landed at /);
  const props = JSON.stringify(SPEC.entities.map((e) => e.properties));
  for (const real of ['Domingos', 'Maria Pereira', 'Sebastião', 'Sebastiao', 'Ginuwa', 'Atuwatse', 'Atorongboye', 'Esigie', 'Ewuare']) assert.ok(!props.includes(real), `${real} is not an inhabitant`);
  const h = historyOf(SPEC);
  assert.equal(h, HISTORIES['benin-warri']);
  assert.equal(h.label, 'Simulation inspired by history; inhabitants are fictional.');
  for (const t of h.timeline) assert.ok(t.when && t.text && t.sources, t.when);
  const whens = h.timeline.map((t) => t.when).join(' | ');
  for (const w of ['c. 1480', '1571–74', '1597', '1600–1611', '23 November 1607', 'By June 1610']) assert.ok(whens.includes(w), w);
  const text = JSON.stringify(h);
  assert.match(text, /City of Saint Augustine/);
  assert.match(text, /enslaved people/);
  assert.match(text, /never models buying, selling or owning people/);
  assert.match(text, /probably subordinate/);
  assert.match(text, /later than 1610/);
  const nok = SPEC.entities.find((e) => e.kind === 'heritage_site');
  assert.match(nok.properties.finds, /c\. 1500 BCE .* far older than anyone here/);
  assert.ok(!SPEC.entities.some((e) => /nok/i.test(String(e.properties.culture || '') + String(e.properties.country || ''))), 'no Nok people live here');
});

test('the words a blind subject must not see stay out; the place passes the blind check; the doc is ready for review', () => {
  assert.equal(checkPlaceForBlind(SPEC), null);
  for (const e of RUN.events.filter((x) => ['talk', 'trade', 'storyline', 'discovery', 'election'].includes(x.kind))) assert.equal(containsBanned(e.summary), false, e.summary);
  assert.match(DOC, /\n## Reviewed by:\s*$/);
  assert.match(DOC, /## Open questions/);
  for (const k of ['Ryder 1960', 'Fonseca 2016', 'Lloyd 1957', 'Lloyd 1963', 'Ikime 1969', 'Moore 1936', 'Brásio', 'Barbot']) assert.ok(DOC.includes(`| ${k} |`), k);
  assert.match(DOC, /oral tradition/i);
});

// --- retemplating ------------------------------------------------------------------------------------

function storeWithClock() {
  let t = Date.parse('2026-10-24T09:18:00Z');
  return createSandboxStore({ now: () => (t += 60000) });
}
const say = (store, text) => handleSandboxCommand({ text, isOperator: true, store });

test('/sandbox retemplate: refuses other owners\' worlds, blind copies and PG1\'s oldest world; describes without confirm; replaces spec and state, keeps the id, resets the tick and records it', async () => {
  __resetSandboxMemory();
  const store = storeWithClock();
  const pg1 = pg1Principal();
  const first = await createWorld(store, pg1, { name: 'Pg1-Universe', template: 'meadow' });
  const second = await createWorld(store, pg1, { name: 'Pg1-Universe', template: 'meadow' });
  await stepWorldFor(store, pg1, { world_id: second.id, steps: 5 });
  // The oldest PG1 world.
  const old = await say(store, `/sandbox retemplate ${first.id} benin-warri confirm`);
  assert.match(old.reply, /this is your first universe; use \/sandbox upgrade instead/);
  // Other owners and blind copies.
  const inv = await inviteAgent(store, { label: 'Visitor' });
  const theirs = await createWorld(store, await resolveSandboxKey(store, inv.key), { name: 'Theirs', template: 'meadow' });
  assert.match((await say(store, `/sandbox retemplate ${theirs.id} benin-warri confirm`)).reply, /Only PG1's own worlds/);
  const runRow = await startExperiment(store, { worldId: second.id, blind: true, clues: false, situation: 'You stand in a meadow. Find the fox.' });
  assert.match((await say(store, `/sandbox retemplate ${runRow.world_id} benin-warri confirm`)).reply, /blind run's copy/);
  assert.match((await say(store, `/sandbox retemplate ${second.id} nowhere confirm`)).reply, /There is no template "nowhere"/);
  // Without confirm: nothing changes.
  const before = await store.getWorld(second.id);
  const look = await say(store, `/sandbox retemplate ${second.id} benin-warri --name "Benin–Warri c. 1610"`);
  assert.match(look.reply, /would start again from the \*\*benin-warri\*\* template, renamed "Benin–Warri c. 1610"/);
  assert.match(look.reply, /Simulation/);
  assert.deepEqual(await store.getWorld(second.id), before);
  // With confirm.
  const done = await say(store, `/sandbox retemplate ${second.id} benin-warri --name "Benin–Warri c. 1610" confirm`);
  assert.equal(done.retemplated, true, done.reply);
  const after = await store.getWorld(second.id);
  assert.equal(after.id, second.id);
  assert.equal(after.tick, 0);
  assert.equal(after.name, 'Benin–Warri c. 1610');
  assert.deepEqual(after.spec, templateSpec('benin-warri'));
  assert.deepEqual(after.state, initialState(templateSpec('benin-warri')));
  const long = await store.listBlackbox(second.id, { chain: 'long' });
  const rec = long.find((r) => r.action === 'retemplate_world');
  assert.ok(rec);
  assert.equal(rec.actor, 'pg1');
  assert.equal(rec.detail.old_template, 'meadow');
  assert.equal(rec.detail.new_template, 'benin-warri');
  assert.match(rec.detail.when, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(long.some((r) => r.action === 'create_world') && long.some((r) => r.action === 'step_world'), 'the old records stay');
  // /sandbox create can make one too.
  const made = await say(store, '/sandbox create "Delta" benin-warri');
  assert.match(made.reply, /from the benin-warri template/);
});

test('the walls of Benin: nine gates on the ring, each with a guard; village enclosures beyond, joined by lines of earthwork (B7)', () => {
  const spec = validateSpec(templateSpec('benin-warri'));
  const by = (id) => spec.entities.find((e) => e.id === id);
  const wall = by('earthwork-benin');
  assert.equal(wall.properties.gates, 9, 'nine gates (the Met)');
  const gates = spec.entities.filter((e) => e.kind === 'gate');
  assert.equal(gates.length, 9);
  for (const g of gates) {
    assert.ok(Math.abs(Math.hypot(g.position.x - wall.position.x, g.position.y - wall.position.y) - wall.properties.radius) < 1, `${g.id} stands on the ring`);
    assert.ok(spec.entities.some((p) => p.kind === 'person' && p.properties.job === 'guard' && p.properties.work === g.id), `${g.id} has a guard`);
  }
  const villages = spec.entities.filter((e) => e.kind === 'earthwork' && e.properties.size === 'small' && e.properties.radius);
  const lines = spec.entities.filter((e) => e.kind === 'earthwork' && e.properties.shape === 'line');
  assert.ok(villages.length >= 4, 'village enclosures');
  assert.ok(lines.length >= villages.length, 'joined by lines of earthwork');
  for (const v of villages) {
    assert.ok(Math.hypot(v.position.x - wall.position.x, v.position.y - wall.position.y) > wall.properties.radius + v.properties.radius, `${v.id} lies outside the city's walls`);
    assert.ok(spec.entities.some((c) => c.kind === 'compound' && Math.hypot(c.position.x - v.position.x, c.position.y - v.position.y) < v.properties.radius), `${v.id} has homes inside`);
  }
  assert.ok(readFileSync(new URL('../docs/sandbox-benin-warri.md', import.meta.url), 'utf8').includes('| B7 |'), 'the doc sources it');
});

test('landings stand at the water\'s edge and fishing villages beside the water, never in it', () => {
  const T = buildTerrain(SPEC.entities, SPEC.size);
  for (const e of SPEC.entities.filter((x) => x.kind === 'canoe_landing' || x.kind === 'fishing_village')) {
    const { x, y } = e.position;
    assert.equal(T.isLand(x, y), true, `${e.id} is on land`);
    const w = T.nearestWater(x, y);
    const d = Math.hypot(w.x - x, w.y - y);
    assert.ok(d <= (e.kind === 'canoe_landing' ? 25 : 60), `${e.id} is ${Math.round(d)} m from the water`);
  }
});
