// Other civilisations are met only when the people are ready (society.mjs,
// contactStep): by their own deep-space expedition at interstellar
// technology, or by a visiting ship, which comes only to a people with a
// colony in space. A craft that merely passes by meets no one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactStep } from '../lib/sandbox/society.mjs';

const far = { id: 'far-1', kind: 'alien_world', position: { x: 5000, y: 5000, z: 9000 }, properties: { name: 'the Vel' } };
const at = (p) => ({ x: p.x + 50, y: p.y, z: p.z });
function run({ tech, colonies = 0, craft = null, dice = 0 }) {
  const ents = [far, { id: 'fountain-1', kind: 'fountain', position: { x: 0, y: 0, z: 0 }, properties: {} }, ...(craft ? [craft] : [])];
  const soc = { tech, colonies, contacts: [] };
  const events = []; const added = [];
  contactStep({ ents, removed: new Set() }, { live: [], index: new Map(), add: (e) => { added.push(e); ents.push(e); return e; }, newId: (k) => `${k}-9`, room: () => true, emit: (kind, summary) => events.push({ kind, summary }), soc, rand: () => dice });
  return { soc, events, added };
}

test('a craft passing a far world meets no one, whatever it is', () => {
  for (const tech of [0, 4, 6]) {
    const r = run({ tech, craft: { id: 'shuttle-1', kind: 'shuttle', position: at(far.position), properties: {} } });
    assert.deepEqual(r.soc.contacts, [], `tech ${tech}: no contact without an expedition`);
  }
});

test('their own deep-space expedition meets them, at interstellar technology only', () => {
  const craft = () => ({ id: 'shuttle-1', kind: 'shuttle', position: at(far.position), properties: { expedition: 'deep' } });
  assert.deepEqual(run({ tech: 5, craft: craft() }).soc.contacts, [], 'not before interstellar travel');
  const r = run({ tech: 6, craft: craft() });
  assert.deepEqual(r.soc.contacts, ['the Vel']);
  assert.ok(r.events.some((e) => e.kind === 'first_contact'));
});

test('their ships come only to a people with a colony in space', () => {
  assert.equal(run({ tech: 5, colonies: 0, dice: 0 }).added.length, 0, 'spaceflight alone is not enough');
  assert.equal(run({ tech: 4, colonies: 1, dice: 0 }).added.length, 0, 'nor a colony without the technology');
  const r = run({ tech: 5, colonies: 1, dice: 0 });
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].kind, 'alien_ship');
  assert.ok(r.events.some((e) => e.kind === 'sighting'));
});
