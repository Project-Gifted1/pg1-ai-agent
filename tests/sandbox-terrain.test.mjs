/**
 * One terrain for the engine and the viewer (lib/sandbox/terrain.mjs and
 * its byte-for-byte copy public/sandbox/terrain.js): the copy is current,
 * and on 10,000 points of the universe (and of a world with a lake, a river,
 * a creek and mangroves) both say the same about land, water and the coast.
 * The viewer's ground takes its coastline from the same module.
 *
 * Run with: node --test tests/sandbox-terrain.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTerrain as engineTerrain } from '../lib/sandbox/terrain.mjs';
import { buildTerrain as viewerTerrain } from '../public/sandbox/terrain.js';
import { templateSpec } from '../lib/sandbox/templates.mjs';

const ROOT = new URL('../', import.meta.url);

test('the viewer\'s terrain is the engine\'s, to the byte (node scripts/build-sandbox-terrain.mjs)', () => {
  assert.equal(readFileSync(new URL('public/sandbox/terrain.js', ROOT), 'utf8'), readFileSync(new URL('lib/sandbox/terrain.mjs', ROOT), 'utf8'));
  // The viewer's ground and coast come from it.
  const env = readFileSync(new URL('public/sandbox/environment.js', ROOT), 'utf8');
  assert.match(env, /T\.coastDistance\(x \+ W \/ 2, -z \+ D \/ 2\)/);
  const scene = readFileSync(new URL('public/sandbox/sandbox-scene.js', ROOT), 'utf8');
  assert.match(scene, /import \{ buildTerrain \} from '\.\/terrain\.js'/);
  assert.match(scene, /terrain: terrainOfWorld\(world\)/);
});

function agree(entities, size) {
  const a = engineTerrain(entities, size); const b = viewerTerrain(entities, size);
  let s = 7; const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  let land = 0;
  for (let i = 0; i < 10000; i++) {
    const x = r() * size.x; const y = r() * size.y;
    assert.equal(a.isLand(x, y), b.isLand(x, y), `land at ${x}, ${y}`);
    assert.equal(a.coastDistance(x, y), b.coastDistance(x, y));
    assert.equal(a.landType(x, y), b.landType(x, y));
    assert.equal(a.islandAt(x, y), b.islandAt(x, y));
    // The fast path agrees with the exact distance.
    assert.equal(a.isLand(x, y), a.coastDistance(x, y) >= 0);
    if (a.isLand(x, y)) land++;
  }
  return land;
}

test('engine and viewer agree on 10,000 points of the universe: land, coast distance, land type, island', () => {
  const uni = templateSpec('universe');
  const land = agree(uni.entities, uni.size);
  assert.ok(land > 1000 && land < 9000, `${land} of 10,000 points on land: islands in a sea`);
  const T = engineTerrain(uni.entities, uni.size);
  assert.equal(T.islandAt(2000, 2200), 'aurelia');
  assert.equal(T.islandAt(8200, 2300), 'maravia');
  assert.equal(T.islandAt(5000, 4500), null, 'the open sea');
  assert.equal(T.isLand(3000, 1340), false, 'the lake is water');
});

test('rivers, creeks and lakes are water; mangrove is land of its own type; a world without islands is land', () => {
  const ents = [
    { id: 'isl', kind: 'island', properties: { radius: 1500, country: 'a' }, position: { x: 2000, y: 2000 } },
    { id: 'm1', kind: 'mangrove', properties: { radius: 600 }, position: { x: 3300, y: 2000 } },
    { id: 'r1', kind: 'river', properties: { to_x: 2000, to_y: 3600, width: 40 }, position: { x: 2000, y: 400 } },
    { id: 'c1', kind: 'creek', properties: { to_x: 3800, to_y: 2100 }, position: { x: 2900, y: 1900 } },
    { id: 'l1', kind: 'lake', properties: { radius: 100 }, position: { x: 1500, y: 2500 } }
  ];
  agree(ents, { x: 4000, y: 4000 });
  const T = engineTerrain(ents, { x: 4000, y: 4000 });
  assert.equal(T.landType(1000, 2000), 'land');
  assert.equal(T.landType(2000, 2000), 'water', 'the river cuts the island');
  assert.equal(T.landType(1500, 2500), 'water', 'the lake');
  assert.equal(T.landType(3600, 1700), 'mangrove');
  assert.equal(T.isWater(3350, 2000), true, 'the creek through the mangroves');
  const plain = engineTerrain([{ id: 'l', kind: 'lake', properties: { radius: 50 }, position: { x: 50, y: 50 } }], { x: 400, y: 400 });
  assert.equal(plain.isLand(300, 300), true);
  assert.equal(plain.isLand(50, 50), false);
  assert.equal(plain.islandAt(300, 300), 'main');
});
