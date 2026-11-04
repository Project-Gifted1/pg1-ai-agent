// PG1 Sandbox viewer: what the Tour and Next / Previous show. Pure (tests
// call it directly).
//
// pickTourTarget(candidates, { recent, events, rand }) -> a candidate or null
//   candidates  [{ id, base, cls, moving }] (things that can be shown)
//   recent      ids shown lately (not shown again until the rest have been)
//   events      the world's latest events ({ kind, ref }): something that
//               has just happened (a birth, a launch, a fire, a landing, a
//               trade, a rescue) is shown first, while it is news
// Then flying and sailing craft and buses, then anything moving.
//
// cycleFollow(candidates, currentId, dir) -> the next (dir 1) or previous
//   (dir -1) candidate in a stable order (by kind, then id): Next and
//   Previous step through everything that moves, one by one.

export const TOUR_DWELL_MS = 14000;            // how long the tour stays on one thing
export const TOUR_DWELL_RECORDING_MS = 20000;  // longer while recording (calmer footage)
export const NEWS_EVENTS = Object.freeze(['birth', 'space', 'reentry', 'touchdown', 'fire', 'rescue', 'arrive', 'travel', 'trade', 'moved_in', 'partners', 'contact', 'built', 'launch']);
const SHOWY = new Set(['rocket', 'shuttle', 'plane', 'small_plane', 'jet', 'helicopter', 'hot_air_balloon', 'ship', 'ferry', 'carrack', 'bus', 'fire_truck', 'ambulance', 'police_car']);

export function pickTourTarget(candidates, { recent = [], events = [], rand = Math.random } = {}) {
  const list = (candidates || []).filter((c) => c && c.id);
  if (!list.length) return null;
  const seen = new Set(recent);
  const fresh = list.filter((c) => !seen.has(c.id));
  const pool = fresh.length ? fresh : list;
  const byId = new Map(pool.map((c) => [c.id, c]));
  // News first: the latest events about something we can show.
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && NEWS_EVENTS.includes(ev.kind) && byId.has(ev.ref)) return byId.get(ev.ref);
  }
  const showy = pool.filter((c) => c.moving && SHOWY.has(c.base));
  const moving = pool.filter((c) => c.moving);
  const from = showy.length && rand() < 0.6 ? showy : moving.length ? moving : pool;
  return from[Math.floor(rand() * from.length)] || null;
}

export function cycleFollow(candidates, currentId, dir = 1) {
  const list = (candidates || []).filter((c) => c && c.id).slice().sort((a, b) => (a.cls === b.cls ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.cls < b.cls ? -1 : 1));
  if (!list.length) return null;
  const i = list.findIndex((c) => c.id === currentId);
  if (i < 0) return dir < 0 ? list[list.length - 1] : list[0];
  return list[(i + (dir < 0 ? -1 : 1) + list.length) % list.length];
}

// The keys of the 3D view (while the Sandbox is open and no text field has
// focus): what each does, for the help line and for the scene.
export const VIEW_KEYS = Object.freeze({
  pan: 'W A S D or the arrows: move',
  turn: 'Q / E: turn',
  tilt: 'R / F: tilt',
  zoom: '+ / -: closer, further',
  next: 'N / B: follow the next / previous moving thing',
  tour: 'T: tour',
  overview: 'O: overview',
  play: 'Space: play or pause',
  record: 'V: record a video'
});
