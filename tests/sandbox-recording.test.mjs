/**
 * Navigating and recording the Sandbox viewer (public/sandbox/tour.js,
 * capture.js, controls.js, sandbox-scene.js, the page):
 *   - the tour shows what is news first, never the same thing twice in a
 *     row, and lingers (longer while recording)
 *   - Next / Previous step through everything that moves, in a stable order
 *   - keys work whenever the Sandbox is open (not only with the canvas
 *     focused): move, turn, tilt, zoom, next, tour, overview, play, record
 *   - recording never changes the quality tier (a change rebuilds the view:
 *     the freeze seen in recordings), the render scale adapts instead, the
 *     panels update at most every 10 s, and the video is made in the
 *     browser (best format it has), stamped "Simulation"
 *
 * Run with: node --test tests/sandbox-recording.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickTourTarget, cycleFollow, TOUR_DWELL_MS, TOUR_DWELL_RECORDING_MS, VIEW_KEYS } from '../public/sandbox/tour.js';
import { pickMime, fileExtension, CAPTURE_BITS, CAPTURE_FPS } from '../public/sandbox/capture.js';

const ROOT = new URL('../', import.meta.url);
const read = (f) => readFileSync(new URL(f, ROOT), 'utf8');

const C = [
  { id: 'person-1', base: 'person', cls: 'person', moving: true },
  { id: 'car-2', base: 'car', cls: 'vehicle', moving: true },
  { id: 'plane-1', base: 'plane', cls: 'vehicle', moving: true },
  { id: 'person-9', base: 'person', cls: 'person', moving: false }
];

test('the tour shows what just happened first, then craft and buses, and never the same thing twice in a row', () => {
  assert.equal(pickTourTarget(C, { events: [{ kind: 'arrive', ref: 'car-2' }, { kind: 'birth', ref: 'person-9' }], rand: () => 0.9 }).id, 'person-9', 'the latest news');
  assert.equal(pickTourTarget(C, { events: [{ kind: 'decide', ref: 'person-1' }], rand: () => 0.1 }).id, 'plane-1', 'craft first when nothing is news');
  const seen = [];
  for (let i = 0; i < 6; i++) { const p = pickTourTarget(C, { recent: seen.slice(-3), rand: () => 0.1 }); seen.push(p.id); }
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1], `no repeat: ${seen.join(', ')}`);
  assert.equal(pickTourTarget([], {}), null);
  assert.ok(TOUR_DWELL_MS >= 12000 && TOUR_DWELL_RECORDING_MS > TOUR_DWELL_MS, 'long, calm looks');
});

test('Next and Previous step through everything that moves, in a stable order, round and round', () => {
  const moving = C.filter((c) => c.moving);
  const order = [];
  let id = null;
  for (let i = 0; i < 4; i++) { id = cycleFollow(moving, id, 1).id; order.push(id); }
  assert.deepEqual(order, ['person-1', 'car-2', 'plane-1', 'person-1']);
  assert.equal(cycleFollow(moving, 'car-2', -1).id, 'person-1');
  assert.equal(cycleFollow(moving, 'person-1', -1).id, 'plane-1', 'round from the first to the last');
  assert.equal(cycleFollow([], null, 1), null);
});

test('keys move the camera whenever the Sandbox is open, not only with the canvas focused', () => {
  const controls = read('public/sandbox/controls.js');
  assert.match(controls, /c\.key = \(e\) =>/);
  assert.match(controls, /keys\.has\('r'\)\) c\.goalPhi/);
  assert.match(controls, /keys\.has\('\+'\) \|\| keys\.has\('='\)/);
  const html = read('public/index.html');
  assert.match(html, /document\.addEventListener\('keydown', onSandboxKey\);/);
  assert.match(html, /if \(t && \(\/\^\(\?:INPUT\|TEXTAREA\|SELECT\)\$\/\.test\(t\.tagName\) \|\| t\.isContentEditable\)\) return;/, 'never while typing');
  for (const k of ["k === 'n' || k === 'b'", "k === 't'", "k === 'o'", "k === ' '", "k === 'v'"]) assert.ok(html.includes(k), k);
  assert.match(html, /id="sandbox-prev"[^>]*>◀ Prev<\/button>/);
  assert.match(html, /id="sandbox-next"[^>]*>Next ▶<\/button>/);
  assert.ok(Object.keys(VIEW_KEYS).length >= 8);
});

test('recording: no tier changes (they rebuild the view), the render scale adapts, panels every 10 s, a glide not a jump', () => {
  const scene = read('public/sandbox/sandbox-scene.js');
  assert.match(scene, /onTierChange: \(t\) => \{ if \(auto && !recordingOn\) switchTo\(t, \{ manual: false \}\); \}/);
  assert.match(scene, /inner\.governor\.setAuto\(auto && !recordingOn\)/);
  assert.match(scene, /const scaling = \(\) => tier === 'cinematic' \|\| recording;/);
  assert.match(scene, /const lock = now < glideUntil \? 1\.4 : 9;/, 'a new target is glided to');
  assert.match(scene, /if \(capture && capture\.recording\) capture\.frame\(\);/, 'every drawn frame, once');
  const html = read('public/index.html');
  assert.match(html, /if \(sandboxRecording && w && sandboxPanelsAt\.id === w\.id && now - sandboxPanelsAt\.at < 10000\) return;/);
  assert.match(html, /if \(!w \|\| sandboxHistoryFor !== w\.id\)/, 'the History tab only with the world');
  assert.match(html, /\.sandbox-view\.is-recording \.sandbox-minimap/);
  assert.match(html, /if \(sandboxRecording\) \{ toggleSandboxRecord\(\)\.finally\(\(\) => closeSandboxScreen\(\)\); return; \}/, 'closing saves the recording first');
});

test('the video: the best format the browser has, a high bit rate, the Simulation stamp burnt in', () => {
  assert.equal(pickMime((m) => m.startsWith('video/webm')), 'video/webm;codecs=vp9');
  assert.equal(pickMime((m) => m === 'video/mp4'), 'video/mp4');
  assert.equal(pickMime(() => false), null);
  assert.equal(fileExtension('video/mp4;codecs=avc1.640028'), 'mp4');
  assert.equal(fileExtension('video/webm;codecs=vp9'), 'webm');
  assert.ok(CAPTURE_BITS >= 12_000_000 && CAPTURE_FPS >= 30);
  const cap = read('public/sandbox/capture.js');
  assert.match(cap, /stream = out\.captureStream\(0\);/, 'frames only as the view draws them');
  assert.match(cap, /g\.fillText\(text,/);
  assert.match(read('public/sandbox/sandbox-scene.js'), /stamp: \(\) => clockEl\.textContent \|\| 'Simulation'/);
});
