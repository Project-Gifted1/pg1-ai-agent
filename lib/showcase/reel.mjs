// "Inside PG1 City" (the 24 November 2026 post): thirteen City shots (day and night) for the
// Showcase render (scripts/showcase-render.mjs --reel inside-city), what
// real data each one replays, and their scripted cameras. Pure: no
// browser, no three.js (tests/showcase-reel.test.mjs).
//
// Real only. Every event a shot replays is one PG1 logged in the defence
// feed's last 7 days (lib/defenseFeed.mjs, read only); nothing is invented
// or simulated. A shot whose kind of event did not happen in the window is
// left out, and the manifest says so. Payments never appear. The weather
// shot replays Dublin's recorded hourly weather (Open-Meteo's archive),
// dated, never called live.
//
//   REEL_SHOTS                     the ten shots, in cut order
//   pickReelEvents(events, now)    the real events each shot replays
//   reelCounts(feed, now)          the counts a caption may show, and their dates
//   pickWeatherChange(hourly)      a recorded rain hour followed by clearing
//   planReelShot(id, ctx)          a shot's camera plan (ctx from the scene)
//   followPose(base, p, t)         a pose that keeps a moving subject framed
//   STILL_LOOK                     how a 2x still is drawn (lighter fog, less bloom)

import { frameCount, SHOWCASE_FPS } from './shots.mjs';

export const REEL_ID = 'inside-city';
// A still (the slides and the Story) is drawn at 2x and downscaled: lighter
// fog, so distant buildings keep their shape; less bloom and a dimmer
// emblem glow, so nothing smears.
export const STILL_SCALE = 2;
export const STILL_LOOK = Object.freeze({ fogScale: 0.16, bloom: 0.6, emblem: 0.4 });
export const REEL_WINDOW_DAYS = 7;
const RAIN = Object.freeze({ state: 'rain', cloud: 1 });
const DAY = Object.freeze({ state: 'partly_cloudy', cloud: 0.4 });

// light: 'day' (13:00 Dublin), 'night' (23:10), 'night-rain' (22:00), 'day-to-night' (the
// clock runs from late afternoon to after dark), 'recorded' (the weather
// record's own hour). replay: which real events the shot plays ('director':
// the window's most important few). ambient: the city's own life placed in
// the frame (never an event, never counted or captioned): `aircraft`, an
// airliner crossing the view mid-shot; `boats`, boats sailing past the
// shot's target on the river.
export const REEL_SHOTS = Object.freeze([
  Object.freeze({ id: 'crown-tower', title: 'The crown tower', seconds: 4.5, light: 'night-rain', weather: RAIN, replay: null, ambient: { aircraft: true }, caption: 'A city built from real AI-agent activity', move: 'a slow crane up the spire to the PG1 shield: lit windows, the beacon ring' }),
  Object.freeze({ id: 'probe-arrives', title: 'A real probe arrives', seconds: 4.5, light: 'night-rain', weather: RAIN, replay: 'probe', caption: '{events} real events in 7 days', move: 'follows a real probe from its origin to the gate, where the Gate Wardens turn it back' }),
  Object.freeze({ id: 'seal-forge', title: 'A result is signed', seconds: 4.5, light: 'night-rain', weather: RAIN, replay: 'signed', caption: 'Signed results you can check', move: 'the Seal Forge stamps a real signed result; the seal rises to the tower' }),
  Object.freeze({ id: 'junction-traffic', title: 'Lane traffic at a junction', seconds: 4.5, light: 'night-rain', weather: RAIN, replay: null, caption: 'Traffic keeps its lanes', move: 'low over the busiest junction at night: cars, buses and taxis in their lanes with brake lights at the signals, lit shop podiums, wet streets streaked with headlights' }),
  Object.freeze({ id: 'river-bridge', title: 'The river and the arched bridge', seconds: 4.5, light: 'night-rain', weather: RAIN, replay: null, ambient: { boats: true, aircraft: true }, caption: 'One week, replayed as it happened', move: 'low along the river to the arched bridge: water taxis and ferries passing under it with their lights, reflections, lamp pools along the promenade, an airliner overhead' }),
  Object.freeze({ id: 'drone-patrol', title: 'Patrols meet real probes', seconds: 4.5, light: 'night-rain', weather: RAIN, replay: 'director', ambient: { aircraft: true }, caption: 'Probes and checks from {countries} countries', move: 'over the rooftops as real events from the window arrive and PG1 answers them, the patrol drones round the tower, an airliner crossing above' }),
  Object.freeze({ id: 'dublin-weather', title: 'Recorded weather', seconds: 4.5, light: 'recorded', weather: null, replay: null, ambient: { boats: true }, caption: 'Real weather, real time of day', move: 'the same street in recorded rain, then clearing' }),
  Object.freeze({ id: 'street-level', title: 'Street level in the plaza', seconds: 4.5, light: 'day', weather: DAY, replay: null, ambient: { aircraft: true }, caption: 'People in the plaza', move: 'at eye level in the plaza by day: people walking, cafe tables, buskers, the tower rising behind, an airliner high above' }),
  Object.freeze({ id: 'tram', title: 'The tram line by day', seconds: 4.5, light: 'day', weather: DAY, replay: null, follow: 'tram', caption: 'Trams on the line', move: 'alongside a tram on the elevated line by day, the streets and traffic below' }),
  Object.freeze({ id: 'city-day', title: 'The city by day', seconds: 4.5, light: 'day', weather: DAY, replay: null, ambient: { boats: true }, caption: 'The city by day', move: 'a slow aerial drift over the city by day: traffic on every street, boats on the river' }),
  Object.freeze({ id: 'day-to-night', title: 'Day to night', seconds: 4.5, light: 'day-to-night', weather: { state: 'partly_cloudy', cloud: 0.35 }, replay: null, ambient: { aircraft: true, boats: true }, caption: 'Windows follow the time of day', move: 'the skyline from late afternoon to after dark, the windows lighting up' }),
  Object.freeze({ id: 'director', title: 'Director mode', seconds: 6, light: 'night-rain', weather: RAIN, replay: 'director', caption: 'Director picks the shots', move: 'director mode on: the camera cuts between real events on its own' }),
  Object.freeze({ id: 'city-wide', title: 'The whole city', seconds: 4.5, light: 'night-rain', weather: RAIN, replay: 'director', ambient: { aircraft: true, boats: true }, caption: 'Free checks for AI agents · Link in bio', move: 'a wide pull-back over the whole city as real events arrive, boats on the river, an airliner on approach, the shield glowing on the tower' })
]);
export const reelShotById = (id) => REEL_SHOTS.find((s) => s.id === id) || null;

// Never a payment (the toll, 402s, settlements, paid jobs).
export const isPaymentEvent = (e) => !!e && (e.gadget === 'toll_bridge' || /pay|settle|402|x402/i.test(`${e.kind || ''} ${e.verdict_code || e.verdict || ''} ${e.check || ''}`) || (e.verdict_code || e.verdict) === 'JOB_PAID');
const t = (e) => Date.parse(e.last || e.time);
const within = (events, now) => (events || []).filter((e) => e && !isPaymentEvent(e) && Number.isFinite(t(e)) && t(e) <= now + 60000 && t(e) >= now - REEL_WINDOW_DAYS * 86400000);

// The real events each shot replays: the latest probe with a known
// country (a flag and an arc need one), the latest signed result, and the
// director's handful (the most important events, a few kinds, never a
// payment). A missing one is null: that shot is left out.
export function pickReelEvents(events, now = Date.now()) {
  const list = within(events, now).sort((a, b) => t(b) - t(a));
  const probe = list.find((e) => e.kind === 'probe' && e.role === 'attacker' && /^[A-Z]{2}$/.test(e.country_code || '')) || null;
  const signed = list.find((e) => e.kind === 'signed_result' || e.verdict_code === 'SIGNED') || null;
  const sev = { high: 3, medium: 2, low: 1 };
  const director = [];
  const kinds = new Set();
  for (const e of [...list].sort((a, b) => (sev[b.severity] || 1) * Math.log10(10 + b.count) - (sev[a.severity] || 1) * Math.log10(10 + a.count) || t(b) - t(a))) {
    if (director.length >= 4) break;
    if (kinds.has(e.gadget)) continue;
    kinds.add(e.gadget); director.push(e);
  }
  return { probe, signed, director };
}

// What a caption may count, from the same events, with the dates it covers.
// countries: origin countries of probes and checks (attacker events with a
// country). Never a payment figure.
export function reelCounts(events, now = Date.now()) {
  const list = within(events, now);
  const countries = new Set(list.filter((e) => e.role === 'attacker' && /^[A-Z]{2}$/.test(e.country_code || '')).map((e) => e.country_code));
  const times = list.map(t);
  return {
    countries: countries.size,
    country_codes: [...countries].sort(),
    events: list.length,
    from: times.length ? new Date(Math.min(...times)).toISOString() : null,
    to: times.length ? new Date(Math.max(...times)).toISOString() : null,
    window: { from: new Date(now - REEL_WINDOW_DAYS * 86400000).toISOString(), to: new Date(now).toISOString() }
  };
}

// Open-Meteo hourly { time[], weather_code[], cloud_cover[], precipitation[] }
// -> the latest recorded rain hour that is followed, within 6 hours, by a
// dry hour with less cloud (clearing). null when the record has none.
const RAINY = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82);
const DRY = (c) => c >= 0 && c <= 3;
export function pickWeatherChange(hourly) {
  const h = hourly || {}; const time = h.time || []; const code = h.weather_code || []; const cloud = h.cloud_cover || []; const rain = h.precipitation || [];
  for (let i = time.length - 1; i >= 0; i--) {
    if (code[i] == null || !RAINY(code[i])) continue;
    for (let j = i + 1; j < Math.min(time.length, i + 7); j++) {
      if (code[j] == null) break;
      if (DRY(code[j]) && Number(cloud[j]) < Number(cloud[i])) {
        return { rain: { time: time[i], code: code[i], cloud: Number(cloud[i]) / 100, precipitation: Number(rain[i]) || 0 }, clear: { time: time[j], code: code[j], cloud: Number(cloud[j]) / 100, precipitation: Number(rain[j]) || 0 } };
      }
    }
  }
  return null;
}
// The City's weather object for a record (lib/cityWeather.mjs stateForCode).
export function weatherFromRecord(r) {
  const c = Number(r.code);
  const state = c === 0 || c === 1 ? 'clear' : c === 2 ? 'partly_cloudy' : c === 3 ? 'overcast' : c >= 51 && c <= 57 ? 'drizzle' : (c >= 63 && c <= 67) || c === 81 || c === 82 ? 'heavy_rain' : 'rain';
  return { state, cloud: Math.max(0, Math.min(1, Number(r.cloud) || 0)), rain: state === 'rain' || state === 'heavy_rain' ? Math.min(1, 0.4 + (Number(r.precipitation) || 0) / 4) : state === 'drizzle' ? 0.25 : 0 };
}

const key = (tt, pose) => ({ t: tt, pose });
const P = (target, dist, theta, phi, fov = 40) => ({ target, dist, theta, phi, fov, focus: dist });

// A shot's plan. ctx (from the scene, all optional): { landmarks: { deckY,
// emblemY, forge: [x,y,z] }, junction: { x, z }, heroBearing }. Shots that
// follow a subject (a probe, a seal) give a base pose; the renderer moves
// its target onto the subject every frame (followPose).
export function planReelShot(id, ctx = {}) {
  const shot = reelShotById(id);
  if (!shot) throw new Error(`unknown reel shot ${id}`);
  const base = { id, seconds: shot.seconds, frames: frameCount(shot.seconds, SHOWCASE_FPS) };
  const lm = ctx.landmarks || {};
  const deck = Number(lm.deckY) || 60; const crown = Number(lm.emblemY) || 240;
  const th = ctx.heroBearing ?? 0.16;
  switch (id) {
    // The still (slide 2): the whole shield and the spire's top inside the slide's crop, with margin above.
    case 'crown-tower': return { ...base, still: { t: 0.66, pose: P([0, 170, 0], 400, th + 0.1, 1.45, 34) }, keys: [key(0, P([0, deck + 10, 0], 210, th + 0.25, 1.5, 38)), key(1, P([0, crown, 0], 150, th + 0.1, 1.36, 34))] };
    case 'probe-arrives': return { ...base, follow: 'event', keys: [key(0, P([0, 30, 0], 150, th + 0.6, 1.2, 42)), key(1, P([0, 30, 0], 115, th + 0.85, 1.25, 40))] };
    // From the north side of the forge (the river and its bridge are to the south, +z).
    case 'seal-forge': { const f = lm.forge || [-40, 0, 24]; return { ...base, follow: 'seal', keys: [key(0, P([f[0], f[1] + 6, f[2]], 70, -1.75, 1.32, 40)), key(1, P([f[0] * 0.5, deck * 0.6, f[2] * 0.7], 120, -1.95, 1.25, 40))] }; }
    // The street in front of the shopping centre (its front faces +z), else the busiest junction.
    case 'junction-traffic': {
      const j = ctx.junction || { x: 0, z: -60 }; return { ...base, keys: [key(0, P([j.x, 5, j.z], 72, th + 0.5, 1.36, 42)), key(1, P([j.x, 5, j.z], 56, th + 0.72, 1.38, 40))] };
    }
    // Low along the river to the arched bridge, never nearer a boat than its detail holds (the camera stays 240 m out and 30 m up).
    // From the west (the harbour pier and its moored boats are east of the bridge, out of the frame).
    case 'river-bridge': return { ...base, keys: [key(0, P([0, 22, 120], 330, Math.PI - 0.05, 1.5, 38)), key(1, P([0, 24, 120], 260, Math.PI - 0.1, 1.49, 36))] };
    // Wider than a patrol alone: the rooftops, the rings and the gate the real events come to.
    // The whole tower and its shield stay in the frame (the spire top with margin).
    case 'drone-patrol': return { ...base, still: { t: 0.66, pose: P([0, 135, -30], 480, th + 0.5, 1.27, 42) }, keys: [key(0, P([0, 120, -40], 520, th + 0.25, 1.3, 44)), key(1, P([0, 125, -30], 470, th + 0.55, 1.27, 42))] };
    case 'dublin-weather': return { ...base, keys: [key(0, P([-250, 12, 66], 230, 3.02, 1.46, 36)), key(1, P([-235, 12, 66], 210, 3.06, 1.46, 35))] };
    // At eye level in the plaza by day: people walking the ring, cafe tables, the buskers, the tower behind. free: no lift (the plaza is open).
    // From inside the plaza, out through a gap in its ring of trees (46 m, one
    // every 15 deg) to its shops (kingdom-shops.js plazaArcade, 59 m): people
    // walking the ring in front, benches, planters, lit windows; no tree or
    // flagpole in the way. The camera stays outside the tower's 60 m obstacle
    // box (|z| > 30), or it would be lifted clear of it, and just outside the
    // cafes (38 m), so no parasol passes under the lens.
    case 'street-level': return { ...base, free: true, keys: [key(0, { ...P([34.8, 2.0, 47.6], 18.6, -2.194, 1.452, 44), free: true }), key(1, { ...P([34.8, 2.0, 47.6], 15.8, -2.18, 1.46, 42), free: true })] };
    // Beside a tram on the elevated line (its target follows the tram).
    // Wide enough for the whole five-car set and the street under the viaduct.
    case 'tram': { const tr = (ctx.trams && ctx.trams[0]) || { x: -300, y: 17.4, z: -202 }; return { ...base, follow: 'tram', keys: [key(0, { ...P([tr.x, 19, tr.z], 120, Math.PI / 2 + 0.75, 1.42, 40), free: true }), key(1, { ...P([tr.x, 19, tr.z], 100, Math.PI / 2 + 0.5, 1.45, 38), free: true })] }; }
    case 'city-day': return { ...base, keys: [key(0, P([-120, 60, 60], 820, th + 0.5, 1.2, 42)), key(1, P([-60, 70, 50], 740, th + 0.32, 1.22, 40))] };
    case 'day-to-night': return { ...base, keys: [key(0, P([0, 110, 60], 900, th + 0.04, 1.45, 40)), key(1, P([0, 120, 50], 860, th - 0.02, 1.44, 39))] };
    case 'director': return { ...base, director: true, keys: [key(0, P([0, 100, 0], 600, th, 1.3)), key(1, P([0, 100, 0], 600, th, 1.3))] };
    case 'city-wide': return { ...base, keys: [key(0, P([0, 140, 40], 900, th + 0.1, 1.38, 40)), key(1, P([0, 160, 30], 1300, th - 0.05, 1.3, 42))] };
    default: throw new Error(`no plan for ${id}`);
  }
}

// The pose at t with its target moved onto a moving subject (eased in over
// the first 15% so the camera never jumps).
export function followPose(pose, subject, t) {
  if (!subject) return pose;
  const k = Math.min(1, Math.max(0, t / 0.15));
  const target = pose.target.map((v, i) => v + ([subject.x, subject.y, subject.z][i] - v) * k);
  return { ...pose, target };
}

// The caption with its real counts filled in ("212 real events in 7 days",
// "Probes and checks from 12 countries"). No city or place name in any caption.
export function captionFor(shot, counts) {
  const n = (k) => String(counts && Number.isFinite(counts[k]) ? counts[k] : '');
  return String(shot.caption || '').replace('{countries}', n('countries')).replace('{events}', n('events'));
}
