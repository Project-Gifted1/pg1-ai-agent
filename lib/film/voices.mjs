// PG1 Studio film voices: which voice reads a film, chosen per film.
//
//   listAccountVoices   the voices in the account (GET /v1/voices), cached
//                       for VOICE_LIST_TTL_MS so one film asks once
//   isClientCleared     whether a voice may be used for client work
//   resolveVoiceRequest /film --voice "<name or id>": exact id, then name
//                       (case-insensitive, trimmed); unknown names get the
//                       three closest; duplicate names are listed
//   fallbackVoice       no voice chosen or cast: PG1_FILM_VOICE_ID if it is
//                       still in the account, else FALLBACK_PREMADE_VOICE
//   castFilm            Director Mode casting: the narrator and every
//                       speaking character from the account's voices, to fit
//                       the treatment (age, gender, tone, accent), one voice
//                       per role for the whole film
//   effectiveCast       a saved cast with any voice that has left the
//                       account replaced for that role only
//
// Listing voices costs nothing; nothing here records speech. Provider names
// stay in this file and in server logs: every text a user sees comes from
// VOICE_TEXT, in PG1's words.

import { whiteLabel } from '../whiteLabel.mjs';

export const VOICES_URL = 'https://api.elevenlabs.io/v1/voices';
export const VOICE_LIST_TTL_MS = 5 * 60 * 1000;

// The film voice when none was chosen or cast and PG1_FILM_VOICE_ID is not
// usable: one premade voice, male and British (the operator's PG1 voice).
// Found by name in the account's voice list (GET /v1/voices), so its id is
// always the account's own.
export const FALLBACK_PREMADE_VOICE = Object.freeze({ name: 'George', gender: 'male', accent: 'british' });

// Used only when the voice list cannot be read at all (the speech call may
// still work): the id main already used for its premade default.
export const OFFLINE_PREMADE_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';

// Premade voices for characters when the voice list cannot be read (the
// same fixed order main used before casting existed).
export const OFFLINE_CHARACTER_VOICES = Object.freeze(['21m00Tcm4TlvDq8ikWAM', 'pNInz6obpgDQGcFmaJgB', 'EXAVITQu4vr4xnSDxMaL', 'TxGEqnHWrfWFTfGW9XjX', 'MF3mGyEYCl7XYWbV9V6O', 'VR6AewLTigWG4xSOukaG']);

// Everything a user reads about voices. No provider or model names.
export const VOICE_TEXT = Object.freeze({
  listUnavailable: 'PG1 Studio could not read the voice list just now. Nothing was spent; try again in a minute.',
  notCleared: "That voice isn't cleared for client work. Pick one marked cleared in /voices.",
  unknown: (q, names) => `PG1 Studio has no voice called "${q}".${names.length ? ` Closest: ${names.map((n) => `"${n}"`).join(', ')}.` : ''} Nothing was spent; /voices lists every voice.`,
  ambiguous: (q, list) => `More than one voice is called "${q}": ${list.map((v) => `"${v.name}" (${v.voice_id})`).join(', ')}. Nothing was spent; give the id with --voice instead.`,
  noKey: 'PG1 Studio has no voice service set up on this deployment.'
});

const COPIED = new Set(['copied', 'copied_disabled']);
const OWNED_CATEGORIES = new Set(['cloned', 'generated', 'professional']);

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const keyOf = (env = {}) => String(env.ELEVENLABS_API_KEY || '').replace(/\s+/g, '');

// One voice from the API, the fields PG1 reads.
export function normaliseVoice(v) {
  if (!v || typeof v !== 'object') return null;
  const id = clean(v.voice_id || v.voiceId);
  if (!id) return null;
  const sharing = v.sharing && typeof v.sharing === 'object' ? v.sharing : null;
  const labels = {};
  if (v.labels && typeof v.labels === 'object') for (const [k, val] of Object.entries(v.labels)) if (val != null && clean(val)) labels[String(k).toLowerCase()] = clean(val);
  return {
    voice_id: id,
    name: clean(v.name) || id,
    category: clean(v.category).toLowerCase() || null,
    labels,
    description: clean(v.description),
    is_owner: v.is_owner === true || v.isOwner === true ? true : v.is_owner === false || v.isOwner === false ? false : null,
    sharing: sharing ? {
      status: clean(sharing.status).toLowerCase() || null,
      original_voice_id: clean(sharing.original_voice_id || sharing.originalVoiceId) || null,
      public_owner_id: clean(sharing.public_owner_id || sharing.publicOwnerId) || null
    } : null
  };
}

// A Voice Library (community) voice added to the account: sharing.status
// "copied" (or "copied_disabled"), or a sharing record that points at
// another voice as its original. A library voice can carry the same
// category as our own ("professional", "generated"), so category never
// decides this alone.
export function isLibraryCopy(v) {
  const s = v && v.sharing;
  if (!s) return false;
  if (s.status && COPIED.has(s.status)) return true;
  return !!(s.original_voice_id && s.original_voice_id !== v.voice_id);
}

// A voice PG1 can use at all: one whose library owner has not switched it off.
export function isUsableVoice(v) {
  return !!(v && v.voice_id && !(v.sharing && v.sharing.status === 'copied_disabled'));
}

// Cleared for client work: a premade (stock) voice, or a voice this account
// made itself (cloned, designed or a professional clone) that the API says
// we own. Never a library voice, whatever its category, and never a voice
// whose ownership the API does not state.
export function isClientCleared(v) {
  if (!isUsableVoice(v) || isLibraryCopy(v)) return false;
  if (v.category === 'premade') return true;
  return v.is_owner === true && OWNED_CATEGORIES.has(v.category);
}

// --- the account's voice list --------------------------------------------------------

const cache = new Map();
export function __resetVoiceCache() { cache.clear(); }

// Resolves to { ok: true, voices } or { ok: false, reason, detail } (detail
// is for server logs only). Never throws.
export async function listAccountVoices({ env = {}, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000, log = () => {} } = {}) {
  const apiKey = keyOf(env);
  if (!apiKey) return { ok: false, reason: 'not_configured', detail: 'ELEVENLABS_API_KEY is not set' };
  const hit = cache.get(apiKey);
  if (hit && now() - hit.at < VOICE_LIST_TTL_MS) return { ok: true, voices: hit.voices, cached: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetchImpl(VOICES_URL, { method: 'GET', headers: { 'xi-api-key': apiKey, Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const out = { ok: false, reason: res.status === 401 || res.status === 403 ? 'not_configured' : 'unavailable', detail: `elevenlabs voices ${res.status}: ${String(body).slice(0, 200)}` };
      try { log(`[voices] ${out.detail}`); } catch (e) { /* never breaks */ }
      return out;
    }
    const json = await res.json();
    const voices = (Array.isArray(json && json.voices) ? json.voices : []).map(normaliseVoice).filter(Boolean);
    cache.set(apiKey, { at: now(), voices });
    return { ok: true, voices };
  } catch (e) {
    const out = { ok: false, reason: 'unavailable', detail: `elevenlabs voices ${controller.signal.aborted ? 'timed out' : `network: ${e && e.message}`}` };
    try { log(`[voices] ${out.detail}`); } catch (er) { /* never breaks */ }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// --- --voice "<name or id>" ----------------------------------------------------------

const lower = (s) => clean(s).toLowerCase();
// "George - Warm, Captivating Storyteller" -> "george"
const shortName = (name) => lower(String(name || '').split(/\s+[-–—|]\s+/)[0]);

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// 0..1, how close a typed name is to a voice name (the full name or the
// part before " - ").
export function nameSimilarity(query, name) {
  const q = lower(query);
  if (!q) return 0;
  let best = 0;
  for (const n of [lower(name), shortName(name)]) {
    if (!n) continue;
    const d = levenshtein(q, n);
    let s = 1 - d / Math.max(q.length, n.length);
    if (n.startsWith(q) || q.startsWith(n)) s = Math.max(s, 0.6 + 0.4 * Math.min(q.length, n.length) / Math.max(q.length, n.length));
    else if (n.includes(q)) s = Math.max(s, 0.5);
    best = Math.max(best, s);
  }
  return best;
}

export function closestVoices(query, voices, n = 3) {
  return [...voices]
    .map((v) => ({ v, s: nameSimilarity(query, v.name) }))
    .sort((a, b) => b.s - a.s || a.v.name.localeCompare(b.v.name))
    .slice(0, n)
    .map((x) => x.v);
}

// Resolves a --voice value against the account's voices:
//   { ok: true, voice }
//   { ok: false, code: 'unknown', suggestions: [3 voices], message }
//   { ok: false, code: 'ambiguous', matches: [voices], message }
//   { ok: false, code: 'not_cleared', voice, message }  (a client film)
export function resolveVoiceRequest(query, voices, { clientWork = false } = {}) {
  const q = clean(query);
  const usable = (voices || []).filter(isUsableVoice);
  const check = (voice) => (clientWork && !isClientCleared(voice) ? { ok: false, code: 'not_cleared', voice, message: VOICE_TEXT.notCleared } : { ok: true, voice });
  const byId = usable.find((v) => v.voice_id === q);
  if (byId) return check(byId);
  let matches = usable.filter((v) => lower(v.name) === lower(q));
  if (!matches.length) matches = usable.filter((v) => shortName(v.name) === lower(q));
  if (matches.length === 1) return check(matches[0]);
  if (matches.length > 1) return { ok: false, code: 'ambiguous', matches, message: VOICE_TEXT.ambiguous(q, matches) };
  const suggestions = closestVoices(q, usable, 3);
  return { ok: false, code: 'unknown', suggestions, message: VOICE_TEXT.unknown(q, suggestions.map((v) => v.name)) };
}

// "--voice George", --voice "Old Tom", --voice 'x' taken out of a request.
// Resolves to { rest, voice } (voice null when the flag is absent).
export function takeVoiceFlag(text) {
  const t = String(text || '');
  const m = /(?:^|\s)--voice(?:\s+|=)(?:"([^"]{1,120})"|'([^']{1,120})'|“([^”]{1,120})”|(\S{1,120}))/i.exec(t);
  if (!m) return { rest: t, voice: null };
  return { rest: (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim(), voice: clean(m[1] || m[2] || m[3] || m[4]) || null };
}

// --- the fallback chain ----------------------------------------------------------------

const asPick = (v, source) => ({ voice_id: v.voice_id, name: v.name, source });

// The premade constant, found by name among premade voices.
export function findFallbackPremade(voices) {
  const premade = (voices || []).filter((v) => isUsableVoice(v) && v.category === 'premade' && !isLibraryCopy(v));
  const want = lower(FALLBACK_PREMADE_VOICE.name);
  return premade.find((v) => lower(v.name) === want) || premade.find((v) => shortName(v.name) === want)
    // The named voice has left the premade set: another male British one.
    || premade.find((v) => lower(v.labels.gender) === FALLBACK_PREMADE_VOICE.gender && lower(v.labels.accent).includes(FALLBACK_PREMADE_VOICE.accent))
    || premade[0] || null;
}

// The film voice when none was chosen or cast:
//   1. PG1_FILM_VOICE_ID (or PG1_FILM_ELEVENLABS_VOICE_ID), when it is still
//      in the account (and cleared, for a client film)
//   2. FALLBACK_PREMADE_VOICE, by name from the account's premade voices
// With no voice list: the env voice for PG1's own film (it cannot be
// checked), else OFFLINE_PREMADE_VOICE_ID. Never fails.
// Resolves to { voice_id, name, source: 'env' | 'premade' | 'offline', note }.
export function fallbackVoice({ env = {}, list = null, clientWork = false } = {}) {
  const envId = clean(env.PG1_FILM_VOICE_ID || env.PG1_FILM_ELEVENLABS_VOICE_ID);
  const listed = list && list.ok ? list.voices : null;
  if (envId && listed) {
    const v = listed.find((x) => x.voice_id === envId && isUsableVoice(x));
    if (v && (!clientWork || isClientCleared(v))) return asPick(v, 'env');
  }
  if (envId && !listed && !clientWork) return { voice_id: envId, name: null, source: 'env', note: 'voice list unavailable; PG1_FILM_VOICE_ID not checked' };
  const note = envId ? (listed ? (clientWork ? 'PG1_FILM_VOICE_ID is not in the account or not cleared for client work' : 'PG1_FILM_VOICE_ID is no longer in the account') : 'voice list unavailable') : null;
  if (listed) {
    const pool = clientWork ? listed.filter(isClientCleared) : listed;
    const premade = findFallbackPremade(pool);
    if (premade) return { ...asPick(premade, 'premade'), note };
  }
  return { voice_id: OFFLINE_PREMADE_VOICE_ID, name: FALLBACK_PREMADE_VOICE.name, source: 'offline', note: note || 'voice list unavailable' };
}

// --- Director Mode casting -----------------------------------------------------------------

const WORDS = {
  male: /\b(?:man|men|boy|he|him|his|father|dad|grandfather|grandpa|husband|king|prince|mr|sir|gentleman|male|son|brother|uncle|monk|fisherman|old man)\b/i,
  female: /\b(?:woman|women|girl|she|her|hers|mother|mum|mom|grandmother|grandma|wife|queen|princess|mrs|ms|miss|lady|female|daughter|sister|aunt|nun)\b/i,
  young: /\b(?:child|kid|boy|girl|teen|teenage|teenager|young|youth|student|toddler|little)\b/i,
  old: /\b(?:old|elderly|aged|grandfather|grandmother|grandpa|grandma|veteran|retired|senior|ageing|aging|weathered|grey-haired|gray-haired)\b/i,
  middle: /\b(?:middle[- ]aged|forties|fifties|adult|parent)\b/i
};
const ACCENTS = ['british', 'english', 'scottish', 'irish', 'welsh', 'american', 'australian', 'canadian', 'indian', 'african', 'nigerian', 'south african', 'french', 'german', 'italian', 'spanish', 'swedish', 'transatlantic', 'new york', 'southern', 'london', 'cockney', 'northern'];
const ACCENT_ALIASES = { english: 'british', london: 'british', cockney: 'british', northern: 'british', welsh: 'british', 'new york': 'american', southern: 'american' };
const TONES = ['warm', 'calm', 'deep', 'gravelly', 'raspy', 'soft', 'gentle', 'energetic', 'authoritative', 'confident', 'playful', 'friendly', 'serious', 'dramatic', 'mysterious', 'tender', 'hopeful', 'wise', 'strong', 'crisp', 'smooth', 'husky', 'bright', 'cheerful', 'sad', 'intense', 'whispery', 'casual', 'formal', 'storyteller', 'narration', 'narrative'];

// What the words say about a role: { gender, age, accent, tones }.
export function traitsFrom(text) {
  const t = String(text || '');
  const male = WORDS.male.test(t);
  const female = WORDS.female.test(t);
  const accent = ACCENTS.find((a) => new RegExp(`\\b${a}\\b`, 'i').test(t)) || null;
  return {
    gender: male && !female ? 'male' : female && !male ? 'female' : null,
    age: WORDS.old.test(t) ? 'old' : WORDS.young.test(t) ? 'young' : WORDS.middle.test(t) ? 'middle_aged' : null,
    accent: accent ? ACCENT_ALIASES[accent] || accent : null,
    tones: TONES.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(t))
  };
}

const ageOf = (v) => {
  const a = lower(v.labels.age).replace(/[\s-]+/g, '_');
  return /old|elder|senior/.test(a) ? 'old' : /young|child|teen/.test(a) ? 'young' : /middle/.test(a) ? 'middle_aged' : null;
};

// How well a voice fits the traits (higher is better).
export function voiceFit(v, traits, { narrator = false } = {}) {
  let s = 0;
  const g = lower(v.labels.gender);
  if (traits.gender) s += g === traits.gender ? 4 : g ? -6 : 0;
  const age = ageOf(v);
  if (traits.age && age) s += age === traits.age ? 2 : -1;
  const acc = lower(v.labels.accent);
  if (traits.accent && acc) s += acc.includes(traits.accent) || (traits.accent === 'british' && /english|british|uk/.test(acc)) ? 3 : -1;
  const about = lower(`${v.labels.description || ''} ${v.labels.descriptive || ''} ${v.labels.use_case || ''} ${v.labels.use_cases || ''} ${v.description || ''} ${v.name}`);
  for (const tone of traits.tones || []) if (about.includes(tone)) s += 1;
  if (narrator && /narrat|story|documentar|audiobook/.test(about)) s += 2;
  return s;
}

const SPOKEN = (timeline) => {
  const ids = new Set();
  for (const sc of (timeline && timeline.scenes) || []) for (const sh of sc.shots || []) for (const l of sh.dialogue || []) if (l && l.character) ids.add(lower(l.character));
  return ids;
};

// A role's name in the cast: the character's name, else its id.
export const roleName = (c) => clean(c && (c.name || c.id));

// The speaking characters of a timeline: [{ role, id, description }].
export function speakingRoles(timeline) {
  const spoken = SPOKEN(timeline);
  return ((timeline && timeline.characters) || [])
    .filter((c) => spoken.has(lower(c.id)) || spoken.has(lower(c.name)))
    .map((c) => ({ role: roleName(c), id: clean(c.id), description: clean(c.description) }));
}

// A role's traits: its own description first; the clauses of the script
// that name it fill in what the description does not say.
export function roleTraits(role, script) {
  const name = lower(role.role);
  const text = [script && script.treatment, script && script.logline, ...((script && script.beats) || []).map((b) => b && b.description)].filter(Boolean).join('. ');
  const clauses = text.split(/[.;!?]\s+/).filter((s) => name && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s));
  const own = traitsFrom(role.description);
  const said = traitsFrom(clauses.join('. '));
  return { gender: own.gender || said.gender, age: own.age || said.age, accent: own.accent || said.accent, tones: [...new Set([...own.tones, ...said.tones])] };
}

function operatorVoices(env = {}) {
  const map = {};
  for (const pair of String(env.PG1_DIRECTOR_VOICES || '').split(/[;,]/)) {
    const m = /^\s*([^=]{1,60})=\s*([A-Za-z0-9]{8,40})\s*$/.exec(pair);
    if (m) map[lower(m[1])] = m[2];
  }
  return map;
}

// Casts the narrator and each speaking character from the account's usable
// voices (only cleared ones for a client film), to fit the treatment. Each
// role gets its own voice while the pool lasts. `narrator` is a voice
// already chosen with --voice. Resolves to the cast saved on the film:
// { narrator: { voice_id, name }, characters: { role: { voice_id, name } },
//   cast_at, source }.
export function castFilm({ timeline, script = null, list = null, env = {}, clientWork = false, narrator = null, now = () => new Date() } = {}) {
  const roles = speakingRoles(timeline);
  const cast = { narrator: null, characters: {}, cast_at: now().toISOString(), source: list && list.ok ? 'cast' : 'offline' };
  const fixed = operatorVoices(env);
  if (!(list && list.ok)) {
    const fb = narrator || fallbackVoice({ env, list, clientWork });
    cast.narrator = { voice_id: fb.voice_id, name: fb.name || null };
    roles.forEach((r, i) => { cast.characters[r.role] = { voice_id: (!clientWork && fixed[lower(r.role)]) || OFFLINE_CHARACTER_VOICES[i % OFFLINE_CHARACTER_VOICES.length], name: null }; });
    return cast;
  }
  const pool = list.voices.filter((v) => isUsableVoice(v) && (!clientWork || isClientCleared(v)));
  const used = new Set();
  const pickBest = (traits, opts) => {
    const ranked = pool.map((v) => ({ v, s: voiceFit(v, traits, opts) })).sort((a, b) => b.s - a.s || a.v.name.localeCompare(b.v.name));
    return (ranked.find((x) => !used.has(x.v.voice_id)) || ranked[0] || {}).v || null;
  };
  // The narrator: the --voice choice, else PG1_FILM_VOICE_ID when it is in
  // the account, else the voice that best fits the film's tone, leaning to
  // the PG1 voice (male, British) when the treatment does not say.
  let nar = narrator ? pool.find((v) => v.voice_id === narrator.voice_id) || narrator : null;
  if (!nar) {
    const fb = fallbackVoice({ env, list, clientWork });
    if (fb.source === 'env') nar = fb;
  }
  if (!nar) {
    const t = traitsFrom(script ? `${script.look || ''} ${script.mood || ''}` : '');
    nar = pickBest({ gender: FALLBACK_PREMADE_VOICE.gender, accent: FALLBACK_PREMADE_VOICE.accent, age: null, tones: t.tones }, { narrator: true }) || fallbackVoice({ env, list, clientWork });
  }
  cast.narrator = { voice_id: nar.voice_id, name: nar.name || null };
  used.add(nar.voice_id);
  for (const r of roles) {
    const pinned = fixed[lower(r.role)] && pool.find((v) => v.voice_id === fixed[lower(r.role)]);
    const v = pinned || pickBest(roleTraits(r, script), {});
    if (!v) continue;
    used.add(v.voice_id);
    cast.characters[r.role] = { voice_id: v.voice_id, name: v.name };
  }
  return cast;
}

// The voices a saved cast speaks in now. A role whose voice has left the
// account (or, for a client film, is not cleared) falls back alone, with a
// log line; the cast itself is never changed. Without a voice list the cast
// is used as saved. Resolves to { narrator, characters, fallbacks: [role] }.
export function effectiveCast(cast, { list = null, env = {}, clientWork = false, log = () => {} } = {}) {
  const out = { narrator: cast && cast.narrator ? { ...cast.narrator } : null, characters: {}, fallbacks: [] };
  const listed = list && list.ok ? list.voices : null;
  const ok = (r) => {
    if (!listed) return true;
    const v = listed.find((x) => x.voice_id === r.voice_id && isUsableVoice(x));
    return !!v && (!clientWork || isClientCleared(v));
  };
  const say = (line) => { try { log(`[voices] ${line}`); } catch (e) { /* never breaks */ } };
  const fb = () => fallbackVoice({ env, list, clientWork });
  if (!out.narrator || !out.narrator.voice_id || !ok(out.narrator)) {
    const f = fb();
    if (out.narrator && out.narrator.voice_id) { say(`cast voice ${out.narrator.voice_id} for the narrator is gone; using ${f.source} voice ${f.voice_id} for the narrator only`); out.fallbacks.push('narrator'); }
    out.narrator = { voice_id: f.voice_id, name: f.name || null };
  }
  const taken = new Set([out.narrator.voice_id, ...Object.values((cast && cast.characters) || {}).map((c) => c && c.voice_id)]);
  for (const [role, c] of Object.entries((cast && cast.characters) || {})) {
    if (c && c.voice_id && ok(c)) { out.characters[role] = { ...c }; continue; }
    // A replacement that no other role speaks in, where the account has one.
    const pool = listed ? listed.filter((v) => isUsableVoice(v) && (!clientWork || isClientCleared(v))) : [];
    const spare = pool.find((v) => !taken.has(v.voice_id));
    const f = spare ? { voice_id: spare.voice_id, name: spare.name, source: 'account' } : fb();
    taken.add(f.voice_id);
    say(`cast voice ${c && c.voice_id} for ${role} is gone; using ${f.source} voice ${f.voice_id} for ${role} only`);
    out.characters[role] = { voice_id: f.voice_id, name: f.name || null };
    out.fallbacks.push(role);
  }
  return out;
}

// The voice a role speaks in from an effective cast (by role name or the
// character's id), else null.
export function castVoiceFor(eff, character, timeline = null) {
  if (!eff) return null;
  const key = lower(character);
  if (key === 'narrator') return eff.narrator ? eff.narrator.voice_id : null;
  for (const [role, c] of Object.entries(eff.characters || {})) if (lower(role) === key) return c.voice_id;
  const ch = ((timeline && timeline.characters) || []).find((c) => lower(c.id) === key || lower(c.name) === key);
  if (ch) for (const [role, c] of Object.entries(eff.characters || {})) if (lower(role) === lower(roleName(ch))) return c.voice_id;
  return null;
}

// --- /voices ------------------------------------------------------------------------------

// "British · middle aged · male · narration", from the voice's labels.
export function voiceSummary(v) {
  const l = v.labels || {};
  const words = [l.accent, l.age, l.gender, l.use_case || l.use_cases, l.description || l.descriptive]
    .filter(Boolean).map((x) => String(x).replace(/_/g, ' '));
  return whiteLabel([...new Set(words)].join(' · '));
}

export function voicesListText(voices) {
  const usable = (voices || []).filter(isUsableVoice).sort((a, b) => a.name.localeCompare(b.name));
  if (!usable.length) return '### [ PG1 VOICES ]\nNo voices are available yet.';
  const cleared = usable.filter(isClientCleared).length;
  return [
    '### [ PG1 VOICES ]',
    `${usable.length} voice${usable.length === 1 ? '' : 's'} for films, ${cleared} cleared for client work. Choose one with /film --voice "<name or id>" (also /film director).`,
    ...usable.map((v) => `- **${v.name}** · ${voiceSummary(v) || 'no description'} · client work: ${isClientCleared(v) ? 'yes' : 'no'} · \`${v.voice_id}\``)
  ].join('\n');
}

// --- per film --------------------------------------------------------------------------------

// The voices one film speaks in, for a render stage. Reads the film's saved
// cast (director.cast) and never recasts a role in it. A film without one
// gets it now and keeps it: a Director film is cast from its script and
// shot list (castFilm); any other film keeps its --voice choice or the
// fallback voice as its narrator. A speaking role the shot list added
// after casting is cast on its own. Voices that left the account fall back
// for their role only (effectiveCast). Never throws: the film always gets
// a voice. save(cast) writes the cast onto the film.
// Resolves to { cast, effective, list }.
export async function prepareFilmVoices({ project, script = null, timeline = null, env = {}, fetchImpl = globalThis.fetch, log = () => {}, save = async () => {}, clientWork = false, now = () => new Date() } = {}) {
  const say = (line) => { try { log(`[voices] ${line}`); } catch (e) { /* never breaks */ } };
  const list = await listAccountVoices({ env, fetchImpl, log });
  const director = (project && project.director && typeof project.director === 'object') ? project.director : {};
  const tl = timeline || (project && project.timeline) || null;
  let cast = director.cast && director.cast.narrator ? director.cast : null;
  let changed = false;
  try {
    if (!cast) {
      if (project && project.mode === 'director' && tl) cast = castFilm({ timeline: tl, script: script || director.script || null, list, env, clientWork, now });
      else {
        const fb = fallbackVoice({ env, list, clientWork });
        if (fb.note) say(`${fb.note}; narrator ${fb.source} voice ${fb.voice_id}`);
        cast = { narrator: { voice_id: fb.voice_id, name: fb.name || null }, characters: {}, cast_at: now().toISOString(), source: fb.source };
      }
      changed = true;
      say(`cast: narrator ${cast.narrator.voice_id}${Object.keys(cast.characters).length ? `, ${Object.entries(cast.characters).map(([r, c]) => `${r} ${c.voice_id}`).join(', ')}` : ''}`);
    } else if (project && project.mode === 'director' && tl) {
      const missing = speakingRoles(tl).filter((r) => !Object.keys(cast.characters || {}).some((k) => lower(k) === lower(r.role)));
      if (missing.length) {
        const add = castFilm({ timeline: { ...tl, characters: (tl.characters || []).filter((c) => missing.some((m) => m.role === roleName(c))) }, script: script || director.script || null, list, env, clientWork, narrator: cast.narrator, now });
        const taken = new Set([cast.narrator.voice_id, ...Object.values(cast.characters || {}).map((c) => c.voice_id)]);
        // A new role gets a voice no other role speaks in, where one is left.
        const pool = list.ok ? list.voices.filter((v) => isUsableVoice(v) && (!clientWork || isClientCleared(v)) && !taken.has(v.voice_id)) : [];
        for (const [role, c] of Object.entries(add.characters)) {
          let pick = c;
          if (taken.has(c.voice_id) && pool.length) {
            const r = missing.find((m) => m.role === role);
            const best = [...pool].sort((a, b) => voiceFit(b, traitsFrom(r ? r.description : '')) - voiceFit(a, traitsFrom(r ? r.description : '')))[0];
            pick = { voice_id: best.voice_id, name: best.name };
            pool.splice(pool.indexOf(best), 1);
          }
          taken.add(pick.voice_id);
          cast = { ...cast, characters: { ...(cast.characters || {}), [role]: pick } };
        }
        changed = true;
        say(`cast added for new role(s): ${missing.map((m) => m.role).join(', ')}`);
      }
    }
  } catch (e) {
    say(`casting failed (${e && e.message}); using the fallback voice`);
    const fb = fallbackVoice({ env, list, clientWork });
    cast = cast || { narrator: { voice_id: fb.voice_id, name: fb.name || null }, characters: {}, cast_at: now().toISOString(), source: fb.source };
  }
  if (changed) {
    try { await save(cast); } catch (e) { say(`the cast could not be saved: ${e && e.message}`); }
  }
  return { cast, effective: effectiveCast(cast, { list, env, clientWork, log }), list };
}

// --- /voices in the chat (signed-in operator only) ----------------------------------------

// The refusal every operator command gives anyone else (api/chat.mjs).
export const OPERATOR_REFUSAL = '[AGENT] Command Aborted: Authentication required.';

export function isVoicesCommand(text) {
  return /^\/voices(?:\s|$)/i.test(String(text || '').trim());
}

// Resolves to { status, reply }. Never throws; provider detail goes to
// onFailure (server logs) only.
export async function handleVoicesCommand({ env = {}, isOperator = false, fetchImpl = globalThis.fetch, onFailure = () => {} } = {}) {
  if (isOperator !== true) return { status: 401, reply: OPERATOR_REFUSAL };
  const list = await listAccountVoices({ env, fetchImpl });
  if (!list.ok) {
    try { onFailure({ reason: 'voices_list_failed', detail: list.detail }); } catch (e) { /* never breaks the reply */ }
    return { status: 200, reply: list.reason === 'not_configured' && !keyOf(env) ? VOICE_TEXT.noKey : VOICE_TEXT.listUnavailable };
  }
  return { status: 200, reply: voicesListText(list.voices) };
}

// /film --voice: the voice chosen for a new film, checked before anything
// is created or spent. Resolves to { ok: true, cast } (cast null when no
// --voice was given) or { ok: false, reply }.
export async function chosenVoiceCast({ query, env = {}, fetchImpl = globalThis.fetch, clientWork = false, onFailure = () => {}, now = () => new Date() } = {}) {
  if (!query) return { ok: true, cast: null };
  const list = await listAccountVoices({ env, fetchImpl });
  if (!list.ok) {
    try { onFailure({ reason: 'voices_list_failed', detail: list.detail }); } catch (e) { /* never breaks the reply */ }
    return { ok: false, reply: list.reason === 'not_configured' && !keyOf(env) ? VOICE_TEXT.noKey : VOICE_TEXT.listUnavailable };
  }
  const r = resolveVoiceRequest(query, list.voices, { clientWork });
  if (!r.ok) return { ok: false, reply: r.message, code: r.code };
  return { ok: true, voice: r.voice, cast: { narrator: { voice_id: r.voice.voice_id, name: r.voice.name }, characters: {}, cast_at: now().toISOString(), source: 'flag' } };
}
