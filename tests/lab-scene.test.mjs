/**
 * The living lab's state (lib/labScene.mjs, api/watches.mjs op lab_scene) and
 * the scene's own state handling (public/lab/living-lab.js normalizeState):
 *   - the mode comes from real lab and autonomous rows only: error, running,
 *     thinking, success, idle, in that order of precedence;
 *   - experiments are shortened ids and statuses, events are webhooks
 *     (watch reports), scans (autonomous checks) and feed rows (through the
 *     source policy, counted, never their values);
 *   - nothing else leaves the server (no goal, value or link);
 *   - three.js is vendored with its licence, and the scene module imports it
 *     only from the app.
 *
 * Run with: node --test tests/lab-scene.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { sceneMode, labSceneState } from '../lib/labScene.mjs';
import { normalizeState, MODE_STYLE } from '../public/lab/living-lab.js';

const NOW = Date.UTC(2026, 9, 17, 18);
const ago = (min) => new Date(NOW - min * 60000).toISOString();

test('the mode follows the real state, error first', () => {
  assert.equal(sceneMode({ experiments: [], actions: [], now: NOW }), 'idle');
  assert.equal(sceneMode({ experiments: [{ status: 'running' }], actions: [], now: NOW }), 'running');
  assert.equal(sceneMode({ experiments: [], actions: [{ status: 'running', at: ago(1) }], now: NOW }), 'thinking');
  assert.equal(sceneMode({ experiments: [{ status: 'done', updated_at: ago(5) }], actions: [], now: NOW }), 'success');
  assert.equal(sceneMode({ experiments: [{ status: 'done', updated_at: ago(90) }], actions: [], now: NOW }), 'idle', 'an old result is not fresh activity');
  assert.equal(sceneMode({ experiments: [{ status: 'running' }, { status: 'failed', updated_at: ago(10) }], actions: [], now: NOW }), 'error');
  assert.equal(sceneMode({ experiments: [], actions: [{ status: 'failed', at: ago(3), finished_at: ago(2) }], now: NOW }), 'error');
});

test('the state is built from the lab, watch, autonomous and feed tables, and carries no goal, value or link', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const u = decodeURIComponent(String(url));
    seen.push(u);
    if (u.includes('/pg1_lab_experiments')) return Response.json([{ id: 'a1b2c3d4-0000-4000-8000-000000000001', status: 'running', updated_at: ago(1), goal: 'secret goal text' }, { id: 'e5f6a7b8-0000-4000-8000-000000000002', status: 'cancelled', updated_at: ago(30) }]);
    if (u.includes('/pg1_watch_reports')) return Response.json([{ id: '11111111-0000-4000-8000-000000000000', created_at: ago(20), body: 'a report body' }]);
    if (u.includes('/pg1_autonomous_actions')) return Response.json([{ id: '22222222-0000-4000-8000-000000000000', at: ago(10), type: 'feed_guardian', status: 'done' }, { id: '33333333-0000-4000-8000-000000000000', at: ago(5), type: 'self_heal', status: 'queued' }]);
    if (u.includes('/threat_ioc_telemetry')) return Response.json([{ ingested_at: ago(15), value: 'CVE-2026-1001', verification_source: 'NVD-CVE-API' }]);
    return Response.json([]);
  };
  const s = await labSceneState({ supUrl: 'https://db.test', supKey: 'k', fetchImpl, env: {}, now: NOW });
  assert.equal(s.mode, 'running');
  assert.deepEqual(s.experiments, [{ id8: 'a1b2c3d4', status: 'running' }, { id8: 'e5f6a7b8', status: 'stopped' }]);
  assert.deepEqual(s.events.map((e) => e.kind), ['webhook', 'feed', 'scan'], 'oldest first; a queued action is not an event yet');
  const all = JSON.stringify(s);
  assert.doesNotMatch(all, /secret goal|report body|CVE-2026-1001|https?:\/\//);
  assert.ok(seen.some((u) => u.includes('/threat_ioc_telemetry') && /and=/.test(u)), 'feed rows through the /api/ioc source policy');
});

test('the scene accepts only known modes, statuses and event kinds', () => {
  const s = normalizeState({ mode: 'party', experiments: [{ id8: 'abcdefgh1234', status: 'weird' }, { nope: 1 }], events: [{ id: 'x', kind: 'webhook' }, { id: 'y', kind: 'fireworks' }] });
  assert.equal(s.mode, 'idle');
  assert.deepEqual(s.experiments, [{ id8: 'abcdefgh', status: 'queued' }]);
  assert.deepEqual(s.events.map((e) => e.kind), ['webhook']);
  assert.deepEqual(Object.keys(MODE_STYLE), ['idle', 'thinking', 'running', 'success', 'error']);
  for (const m of Object.values(MODE_STYLE)) assert.ok(m.pulseHz <= 1, 'no brightness change faster than 1 Hz');
});

test('three.js is vendored with its licence and loaded only from the app', () => {
  for (const f of ['public/vendor/three/three.module.min.js', 'public/vendor/three/three.core.min.js', 'public/vendor/three/LICENSE.txt']) assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), f);
  const mod = readFileSync(new URL('../public/lab/living-lab.js', import.meta.url), 'utf8');
  assert.match(mod, /threeUrl = '\/vendor\/three\/three\.module\.min\.js'/);
  assert.doesNotMatch(mod, /https?:\/\/(?!www\.w3\.org)/, 'no outside URL in the scene');
  assert.doesNotMatch(mod, /gemini|claude|anthropic|openai|groq/i, 'no provider names');
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /import\('\/lab\/living-lab\.js'\)/, 'lazy-loaded when the lab screen opens');
  assert.doesNotMatch(page, /<script[^>]+three/i, 'never loaded with the page');
});
