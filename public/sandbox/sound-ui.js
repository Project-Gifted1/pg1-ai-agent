// PG1 Sandbox viewer: the Sound and Music switches and the volume, and what
// the sound hears of the world (sound.js). Off until the person turns it on;
// the choice and the volume are remembered on this device.
//
// Each second it reads where the camera is from the page (the view, the
// clock: "in space", "on <world>"), the time of day from the clock, what
// the world holds (sea, a town or a village, traffic), and who is talking
// near where the camera looks.

import { createSound } from './sound.js';

const KEY = 'pg1_sandbox_sound';
const MOTOR = new Set(['car', 'bus', 'truck', 'taxi', 'motorbike', 'police_car', 'army_truck', 'tractor']);
const $ = (id) => document.getElementById(id);
let sound = null;

function saved() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } }
function save(v) { try { localStorage.setItem(KEY, JSON.stringify({ ...saved(), ...v })); } catch (e) { /* private mode */ } }

// Where the camera is, in the sound's words.
function placeOf() {
  const clock = (document.querySelector('#sandbox-view .sandbox-clock') || {}).textContent || '';
  const w = window.sandboxState && window.sandboxState.world;
  const ents = (w && w.entities) || [];
  if (/ · on /.test(clock)) return /alien|Vel|Oru|Kesh|Amaru/i.test(clock) ? 'alien' : 'space';
  if (/in space/.test(clock)) return 'space';
  const view = window.sandboxScene && window.sandboxScene.view ? window.sandboxScene.view() : 'overview';
  if (view === 'space') return 'space';
  const motor = ents.some((e) => MOTOR.has(e.kind));
  const homes = ents.some((e) => ['house', 'apartment', 'shop', 'tower', 'compound', 'fishing_village'].includes(e.kind));
  const sea = ents.some((e) => e.kind === 'island');
  // A town has traffic; a village (no motor traffic: a period world) has none.
  return homes ? (motor ? 'town' : 'village') : sea ? 'sea' : 'land';
}
function nightOf() {
  const m = /(\d\d):(\d\d)/.exec(((document.querySelector('#sandbox-view .sandbox-clock') || {}).textContent) || '');
  if (!m) return 0;
  const h = Number(m[1]) + Number(m[2]) / 60;
  return h < 5 || h > 21 ? 1 : h < 7 ? (7 - h) / 2 : h > 19 ? (h - 19) / 2 : 0;
}
// People talking within 60 m of where the camera looks, and how far the camera is.
function talkersNear(w) {
  const inner = window.sandboxScene && window.sandboxScene.inner;
  const cam = inner && inner.cameraState ? inner.cameraState() : null;
  if (!w || !cam || !w.size) return { talkers: 0, distance: 1000 };
  const x = cam.target.x + w.size.x / 2; const y = -cam.target.z + w.size.y / 2;
  const talkers = (w.entities || []).filter((e) => e.properties && e.properties.saying && Math.hypot(e.position.x - x, e.position.y - y) < 60).length;
  return { talkers, distance: cam.dist };
}
function tick() {
  if (!sound || !sound.playing) return;
  const w = window.sandboxState && window.sandboxState.world;
  const ents = (w && w.entities) || [];
  let seed = 0; for (const ch of String((w && w.id) || 'world')) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  sound.update({ place: placeOf(), night: nightOf(), seed, near: { traffic: ents.filter((e) => MOTOR.has(e.kind)).length / 10, ...talkersNear(w) } });
}

function mark() {
  const s = $('sandbox-sound'); const m = $('sandbox-music'); const v = $('sandbox-volume');
  if (s) s.setAttribute('aria-pressed', String(!!(sound && sound.playing)));
  if (m) { m.setAttribute('aria-pressed', String(!!(sound && sound.musicOn))); m.disabled = !(sound && sound.playing); }
  if (v) v.disabled = !(sound && sound.playing);
}

function wire() {
  const s = $('sandbox-sound'); const m = $('sandbox-music'); const v = $('sandbox-volume');
  if (!s || s.dataset.wired) return;
  s.dataset.wired = '1';
  const pref = saved();
  if (v) v.value = String(Math.round((pref.volume ?? 0.5) * 100));
  s.addEventListener('click', () => {
    if (!sound) sound = createSound();
    if (sound.playing) { sound.off(); save({ on: false }); } else if (sound.on()) { sound.volume(Number(v ? v.value : 50) / 100); sound.music(!!pref.music); save({ on: true }); tick(); }
    mark();
  });
  if (m) m.addEventListener('click', () => { if (!sound || !sound.playing) return; sound.music(!sound.musicOn); save({ music: sound.musicOn }); mark(); });
  if (v) v.addEventListener('input', () => { if (sound) sound.volume(Number(v.value) / 100); save({ volume: Number(v.value) / 100 }); });
  // Leaving the Sandbox screen: silence.
  const close = document.querySelector('#sandbox-screen [data-dialog-close]');
  if (close) close.addEventListener('click', () => { if (sound) sound.off(); mark(); });
  mark();
  setInterval(tick, 1000);
}

wire();
document.addEventListener('DOMContentLoaded', wire);
window.__sandboxSound = () => sound;
