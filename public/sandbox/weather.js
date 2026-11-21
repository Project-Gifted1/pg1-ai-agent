// PG1 Sandbox viewer: the weather, drawn, never simulated.
//
// Each island has its own weather, from its climate, the world's seed and
// the time of day: it changes every six hours of the world's day, blending
// over the last hour of each spell, so a shower passes, a morning fog lifts
// and a storm builds. The same world at the same tick always has the same
// weather (no randomness, nothing sent to or from the server), and nothing
// in the simulation reads it: people, animals and routes are untouched.
// Weather for the world as it was (Benin–Warri c. 1610 included): rain,
// cloud, mist, wind and thunder only.
//
//   weatherAt({ seed, key, tick, daySteps, climate }) -> a Weather (pure)
//   weatherWord(w)      what the clock says ('' when fair)
//   WEATHER_LOOK        each state's numbers
//
// A Weather: { state, cloud, rain, snow, wind, fog, dark, lightning }, each
// number 0..1. sandbox-scene.js eases the view towards it and draws it
// (atmosphere.js).

// How each state looks.
//   cloud   cover          rain / snow   how hard it falls
//   wind    trees, clouds and rain slant
//   fog     extra haze     dark   how much of the sun is lost
export const WEATHER_LOOK = Object.freeze({
  clear: Object.freeze({ cloud: 0.08, rain: 0, snow: 0, wind: 0.15, fog: 0, dark: 0, lightning: false }),
  partly_cloudy: Object.freeze({ cloud: 0.4, rain: 0, snow: 0, wind: 0.25, fog: 0, dark: 0.08, lightning: false }),
  overcast: Object.freeze({ cloud: 0.85, rain: 0, snow: 0, wind: 0.3, fog: 0.1, dark: 0.35, lightning: false }),
  drizzle: Object.freeze({ cloud: 0.9, rain: 0.25, snow: 0, wind: 0.25, fog: 0.2, dark: 0.4, lightning: false }),
  showers: Object.freeze({ cloud: 0.7, rain: 0.55, snow: 0, wind: 0.45, fog: 0.05, dark: 0.3, lightning: false }),
  rain: Object.freeze({ cloud: 0.95, rain: 0.7, snow: 0, wind: 0.45, fog: 0.15, dark: 0.6, lightning: false }),
  storm: Object.freeze({ cloud: 1, rain: 1, snow: 0, wind: 0.85, fog: 0.1, dark: 0.82, lightning: true }),
  mist: Object.freeze({ cloud: 0.5, rain: 0, snow: 0, wind: 0.05, fog: 1, dark: 0.2, lightning: false }),
  snow: Object.freeze({ cloud: 0.9, rain: 0, snow: 0.7, wind: 0.3, fog: 0.25, dark: 0.3, lightning: false })
});

// How often each state comes, by climate (weights). Tropical: sunny spells,
// heavy showers and thunderstorms; cold: grey skies and snow; maritime: grey,
// drizzle and sea mist; temperate: a bit of everything.
export const CLIMATE_WEATHER = Object.freeze({
  tropical: Object.freeze({ clear: 26, partly_cloudy: 26, overcast: 8, showers: 20, rain: 6, storm: 9, mist: 5 }),
  temperate: Object.freeze({ clear: 24, partly_cloudy: 26, overcast: 18, drizzle: 8, showers: 8, rain: 8, storm: 3, mist: 5 }),
  maritime: Object.freeze({ clear: 12, partly_cloudy: 24, overcast: 22, drizzle: 14, showers: 10, rain: 8, storm: 3, mist: 7 }),
  cold: Object.freeze({ clear: 18, partly_cloudy: 20, overcast: 24, snow: 26, mist: 8, storm: 4 })
});

// Mist only forms in the early morning; it lifts by late morning.
const MORNING_ONLY = new Set(['mist']);
export const SPELL_HOURS = 6;

function hash(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) for (const ch of String(p)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function spellState({ seed, key, spell, climate }) {
  const table = CLIMATE_WEATHER[climate] || CLIMATE_WEATHER.temperate;
  const hourOfSpell = ((spell % (24 / SPELL_HOURS)) + 4) % (24 / SPELL_HOURS); // 0: 00-06, 1: 06-12, ...
  const entries = Object.entries(table).filter(([s]) => !MORNING_ONLY.has(s) || hourOfSpell === 1);
  const total = entries.reduce((k, [, w]) => k + w, 0);
  let r = hash(seed, key, spell, climate) * total;
  for (const [s, w] of entries) { r -= w; if (r < 0) return s; }
  return entries[entries.length - 1][0];
}

const lerp = (a, b, t) => a + (b - a) * t;

// The weather at a tick: this spell's, blending into the next spell's over
// its last hour (smoothstep), so nothing ever changes at once.
export function weatherAt({ seed = 1, key = 'world', tick = 0, daySteps = 240, climate = 'temperate' } = {}) {
  const hours = ((Number(tick) || 0) / Math.max(1, daySteps)) * 24 + 6; // tick 0 is 06:00 (sandbox-scene clock)
  const spell = Math.floor(hours / SPELL_HOURS);
  const into = hours / SPELL_HOURS - spell;
  const a = spellState({ seed, key, spell, climate });
  const b = spellState({ seed, key, spell: spell + 1, climate });
  const k = Math.max(0, (into - (1 - 1 / SPELL_HOURS)) * SPELL_HOURS);
  const t = k * k * (3 - 2 * k);
  const A = WEATHER_LOOK[a]; const B = WEATHER_LOOK[b];
  const out = { state: t < 0.5 ? a : b, next: b, blend: Math.round(t * 1000) / 1000 };
  for (const n of ['cloud', 'rain', 'snow', 'wind', 'fog', 'dark']) out[n] = Math.round(lerp(A[n], B[n], t) * 1000) / 1000;
  out.lightning = (t < 0.5 ? A : B).lightning;
  return Object.freeze(out);
}

// What the clock adds: nothing in fair weather.
const WORDS = { overcast: 'overcast', drizzle: 'drizzle', showers: 'showers', rain: 'rain', storm: 'thunderstorm', mist: 'mist', snow: 'snow' };
export function weatherWord(w) { return (w && WORDS[w.state]) || ''; }
