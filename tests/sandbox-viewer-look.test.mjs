// The viewer's look, the parts that run without a browser: the road network
// streets.js draws from (a road graph, or road strips joined at their ends),
// and the quality tiers (Cinematic exists, is the top tier, and Auto never
// picks it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roadSegments, FOOTPATH_WIDTH } from '../public/sandbox/streets.js';
import { TIERS, TIER_SETTINGS, TIER_LABEL, pickTier, createGovernor } from '../public/sandbox/quality.js';
import { templateSpec } from '../lib/sandbox/templates.mjs';

test('streets come from the road graph when a world has one', () => {
  const world = { size: { x: 1000, y: 1000 }, entities: [], roads: { nodes: [[100, 100], [300, 100], [300, 400]], edges: [[0, 1, 12, 0], [1, 2, 2.5, 0]], names: ['High Street'] } };
  const segs = roadSegments(world);
  assert.equal(segs.length, 2);
  assert.deepEqual([segs[0].ax, segs[0].ay, segs[0].bx, segs[0].by, segs[0].w], [100, 100, 300, 100, 12]);
  assert.equal(segs[0].b, segs[1].a, 'the two edges share their node');
  assert.ok(segs[1].w < FOOTPATH_WIDTH, 'a footpath');
});

test('without a graph, road strips become segments that share nodes where they meet', () => {
  const world = { size: { x: 1000, y: 1000 }, entities: [
    { base: 'road', x: 500, y: 500, props: { heading: 0, length: 200, width: 12 } },
    { base: 'road', x: 700, y: 600, props: { heading: 90, length: 200, width: 10 } },
    { base: 'house', x: 10, y: 10, props: {} }
  ] };
  const segs = roadSegments(world);
  assert.equal(segs.length, 2);
  assert.ok(Math.abs(segs[0].bx - 600) < 1e-9 && Math.abs(segs[0].by - 500) < 1e-9, 'heading 0 runs east');
  assert.ok(Math.abs(segs[1].ax - 700) < 1e-9 && Math.abs(segs[1].ay - 500) < 1e-9, 'heading 90 runs north');
  // (600, 500) and (700, 500) are 100 m apart: not joined.
  assert.notEqual(segs[0].b, segs[1].a);
});

test('the universe template has streets to draw', () => {
  const spec = templateSpec('universe');
  const entities = spec.entities.map((e) => ({ base: e.kind, x: e.position.x, y: e.position.y, props: e.properties || {} }));
  const segs = roadSegments({ size: spec.size, entities, roads: spec.roads });
  assert.ok(segs.length >= 10, `${segs.length} segments`);
  for (const s of segs) assert.ok(Number.isFinite(s.ax + s.ay + s.bx + s.by + s.w));
});

test('quality tiers: Cinematic is the top tier, by hand only; every tier says what it turns on', () => {
  assert.deepEqual(TIERS, ['low', 'medium', 'high', 'ultra', 'cinematic']);
  assert.equal(TIER_LABEL.cinematic, 'Cinematic');
  for (const t of TIERS) for (const k of ['streets', 'coast', 'ibl', 'lod', 'reflect', 'dof', 'ease', 'foliage', 'foliageRadius']) assert.ok(k in TIER_SETTINGS[t], `${t}.${k}`);
  assert.equal(TIER_SETTINGS.low.streets, false, 'Low keeps the plain road strips');
  assert.equal(TIER_SETTINGS.low.foliage, 0);
  assert.equal(TIER_SETTINGS.cinematic.dof, true);
  assert.equal(TIER_SETTINGS.cinematic.reflect, 'planar');
  assert.ok(TIER_SETTINGS.cinematic.ease < TIER_SETTINGS.ultra.ease, 'a slower camera');
  for (const dev of [{ coarse: true, memory: 8, cores: 8 }, { coarse: false, memory: 16, cores: 16 }, { coarse: true }, {}]) assert.notEqual(pickTier(dev), 'cinematic');
  assert.equal(pickTier({ saved: 'cinematic' }), 'cinematic', 'a saved choice is kept');
  const changes = [];
  const g = createGovernor({ tier: 'cinematic', budgetMs: 33, window: 10, onChange: (t) => changes.push(t) });
  for (let i = 0; i < 25; i++) g.sample(80);
  assert.equal(changes[0], 'ultra', 'too slow: one step down');
});
