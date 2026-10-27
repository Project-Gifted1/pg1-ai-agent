/**
 * Routes do not depend on what the caches hold (lib/sandbox/roads.mjs
 * nextHop, movement.mjs doors): a world runs the same in a fresh process
 * as in one that has already run it, or other worlds, before.
 *
 * Run with: node --test tests/sandbox-same-routes.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, stepWorld } from '../lib/sandbox/engine.mjs';
import { templateSpec } from '../lib/sandbox/templates.mjs';
import { nextHop } from '../lib/sandbox/roads.mjs';

// A fingerprint of every step's state (so a difference that comes and goes is caught too).
const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };
const run = (spec, steps) => { let st = initialState(spec); const prints = []; for (let t = 0; t < steps; t++) { st = stepWorld(spec, st, 1).state; prints.push(hash(JSON.stringify(st.entities))); } return prints; };
const firstDifference = (a, b) => { const i = a.findIndex((x, k) => x !== b[k]); return i < 0 ? 'none' : `step ${i + 1}`; };

test('the universe runs the same, step by step, a second time and after the town has run in between', () => {
  const uni = templateSpec('universe');
  const first = run(uni, 600);
  assert.equal(firstDifference(run(uni, 600), first), 'none', 'second run');
  run(templateSpec('town'), 200);
  assert.equal(firstDifference(run(uni, 600), first), 'none', 'after another world');
});

test('next hops are the same whatever was asked before, on a grid full of equal ways', () => {
  // A 6 by 6 grid of 10 m streets: between opposite corners there are many equally short ways.
  const W = 6; const n = W * W;
  const graph = () => {
    const xs = new Float64Array(n); const ys = new Float64Array(n); const adj = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) { xs[i] = (i % W) * 10; ys[i] = Math.floor(i / W) * 10; }
    for (let i = 0; i < n; i++) for (const j of [i + 1, i + W]) if (j < n && (j !== i + 1 || j % W)) { adj[i].push({ to: j, cost: 10 }); adj[j].push({ to: i, cost: 10 }); }
    for (const l of adj) l.sort((p, q) => p.to - q.to);
    return { n, xs, ys, adj: { car: adj }, hops: { car: new Map() } };
  };
  const goal = n - 1;
  const walk = (g, from) => { const path = [from]; while (path[path.length - 1] !== goal) path.push(nextHop(g, 'car', path[path.length - 1], goal)); return path.join(','); };
  const fresh = (from) => walk(graph(), from);
  // Asked in one order on one graph, and each from a fresh graph: the same routes.
  const g = graph();
  for (const from of [0, 7, 14, 2, 30, 5]) assert.equal(walk(g, from), fresh(from), `from ${from}`);
  // Every route is a shortest one: 10 m a block.
  for (let from = 0; from < n; from++) { const steps = walk(g, from).split(',').length - 1; assert.equal(steps, (W - 1 - (from % W)) + (W - 1 - Math.floor(from / W))); }
  // No way: -1.
  const lone = graph(); lone.adj.car[goal] = []; for (const l of lone.adj.car) for (let k = l.length - 1; k >= 0; k--) if (l[k].to === goal) l.splice(k, 1);
  assert.equal(nextHop(lone, 'car', 0, goal), -1);
});
