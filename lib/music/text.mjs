// PG1 Sound: names, commands, flags, prices and wording for /music, with no
// engine code (api/chat.mjs imports it on every request).
//
// White-label: everything a reply, a card or the page shows says "PG1
// Sound". Provider and model names live in lib/music/engines.mjs, the
// usage log, pg1_errors, the track's operator-only licence note (shown in
// /music status, an operator-only command, and in the export README) and
// nowhere else.

export const MUSIC_LABEL = 'PG1 Sound';
export const MAX_MUSIC_PROMPT_CHARS = 1500;
export const MAX_LYRICS_CHARS = 3000;

// /music <prompt> [--instrumental] [--bpm N] [--key X] [--length short|full] [--lyrics "..."]
// /music status [id]            one track, or the latest tracks
// /music list | library         the media library, with players
// /music export <id>            stems, MIDI and WAV as a zip (render worker)
// /music retry <id>             restart a failed track where it stopped (approve/decline)
// /music edit <id> <changes>    new previews with changes (approve/decline)
const SUBCOMMANDS = new Set(['status', 'list', 'library', 'export', 'retry', 'edit', 'help']);
const ID_RE = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function isMusicCommand(text) {
  return /^\/music(?:\s|$)/i.test(String(text || '').trim());
}

export function shortTrackId(id) {
  return String(id || '').slice(0, 8);
}

export function usd(n) {
  return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
}

// { sub, id, rest } — sub is 'new' for a request, 'help' for a bare /music.
export function parseMusicCommand(text) {
  const body = String(text || '').trim().replace(/^\/music\b[:\s]*/i, '');
  if (!body) return { sub: 'help', id: null, rest: '' };
  const m = /^(\S+)\s*([\s\S]*)$/.exec(body);
  const word = m[1].toLowerCase();
  if (!SUBCOMMANDS.has(word)) return { sub: 'new', id: null, rest: body };
  if (word === 'help') return { sub: 'help', id: null, rest: '' };
  const m2 = /^(\S+)\s*([\s\S]*)$/.exec(m[2] || '');
  const id = m2 && ID_RE.test(m2[1]) ? m2[1].toLowerCase() : null;
  const sub = word === 'library' ? 'list' : word;
  if (sub === 'status' && !id) return { sub: 'list', id: null, rest: '' };
  return { sub, id, rest: id ? (m2[2] || '').trim() : (m[2] || '').trim() };
}

// --- flags ----------------------------------------------------------------------------

const KEY_RE = /^([A-G])([#♯b♭]?)(?:\s*(m|min|minor|maj|major|dorian|mixolydian|phrygian|lydian|aeolian|ionian|locrian))?$/i;
const MODE_NAMES = { m: 'minor', min: 'minor', minor: 'minor', maj: 'major', major: 'major' };

// "F#m" -> "F# minor", "bb major" -> "Bb major"; null when not a key.
export function normaliseKey(raw) {
  const m = KEY_RE.exec(String(raw || '').trim().replace(/\s+/g, ' '));
  if (!m) return null;
  const acc = m[2] === '♯' ? '#' : m[2] === '♭' || m[2] === 'B' ? 'b' : m[2];
  const modeRaw = m[3] ? m[3].toLowerCase() : 'major';
  const mode = MODE_NAMES[modeRaw] || modeRaw;
  // "Am" is A minor; a bare letter is major.
  return `${m[1].toUpperCase()}${acc} ${m[3] && m[3] === 'M' ? 'major' : mode}`;
}

// Splits flags from the prompt. Resolves to { ok, prompt, spec: {
// instrumental, bpm, key, length, lyrics }, set: [flags given] } or { ok:
// false, message }. `base` (for /music edit) is the spec the flags change.
export function parseMusicFlags(text, base = null) {
  let s = String(text || '');
  const spec = base ? { ...base } : { instrumental: false, bpm: null, key: null, length: 'short', lyrics: '' };
  const set = [];
  // --lyrics "..." (straight or curly quotes, may span lines), or the rest
  // of the line up to the next flag.
  const lyr = /(?:^|\s)--lyrics(?:\s*=\s*|\s+)(?:"([\s\S]*?)"|“([\s\S]*?)”|'([\s\S]*?)'|((?:(?!\s--[a-z])[\s\S])*))/i.exec(s);
  if (lyr) {
    const value = (lyr[1] ?? lyr[2] ?? lyr[3] ?? lyr[4] ?? '').trim();
    if (!value) return { ok: false, message: 'Put your own lyrics after --lyrics, in quotes: --lyrics "first line / second line".' };
    if (value.length > MAX_LYRICS_CHARS) return { ok: false, message: `Lyrics can be at most ${MAX_LYRICS_CHARS} characters.` };
    spec.lyrics = value.replace(/\s+\/\s+/g, '\n');
    spec.instrumental = false;
    set.push('lyrics');
    s = s.slice(0, lyr.index) + ' ' + s.slice(lyr.index + lyr[0].length);
  }
  const take = (re) => {
    const m = re.exec(s);
    if (!m) return null;
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
    return m;
  };
  if (take(/(?:^|\s)--instrumental\b/i)) {
    if (set.includes('lyrics')) return { ok: false, message: '--instrumental and --lyrics cannot go together: an instrumental has no lyrics.' };
    spec.instrumental = true; spec.lyrics = ''; set.push('instrumental');
  }
  if (take(/(?:^|\s)--vocals\b/i)) { spec.instrumental = false; set.push('vocals'); }
  const bpm = take(/(?:^|\s)--bpm(?:\s*=\s*|\s+)(\S+)/i);
  if (bpm) {
    const n = Number(bpm[1]);
    if (!Number.isInteger(n) || n < 40 || n > 240) return { ok: false, message: '--bpm takes a whole number from 40 to 240.' };
    spec.bpm = n; set.push('bpm');
  }
  const key = take(/(?:^|\s)--key(?:\s*=\s*|\s+)([A-Ga-g][#♯b♭]?(?:\s*(?:m|min|minor|maj|major|dorian|mixolydian|phrygian|lydian|aeolian|ionian|locrian)\b)?)/);
  if (key) {
    const k = normaliseKey(key[1]);
    if (!k) return { ok: false, message: '--key takes a key such as C, F#m, Bb major or D minor.' };
    spec.key = k; set.push('key');
  } else if (/(?:^|\s)--key\b/i.test(s)) return { ok: false, message: '--key takes a key such as C, F#m, Bb major or D minor.' };
  const len = take(/(?:^|\s)--length(?:\s*=\s*|\s+)(\S+)/i);
  if (len) {
    const v = len[1].toLowerCase();
    if (v !== 'short' && v !== 'full') return { ok: false, message: '--length is short (about 30 seconds) or full (a complete song).' };
    spec.length = v; set.push('length');
  }
  const unknown = /(?:^|\s)(--[a-z][\w-]*)/i.exec(s);
  if (unknown) return { ok: false, message: `${unknown[1]} is not a /music option. Options: --instrumental, --bpm N, --key X, --length short|full, --lyrics "…".` };
  const prompt = s.replace(/\s+/g, ' ').trim();
  if (prompt.length > MAX_MUSIC_PROMPT_CHARS) return { ok: false, message: `Keep the description under ${MAX_MUSIC_PROMPT_CHARS} characters.` };
  return { ok: true, prompt, spec, set };
}

// A short title from the description: its first words, capitalised.
export function trackTitle(prompt) {
  const words = String(prompt || '').replace(/[^\p{L}\p{N}\s'&-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
  const t = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 48).trim();
  return t || 'Untitled track';
}

// A filename-safe form of the title.
export function fileSlug(title) {
  return String(title || 'track').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'track';
}

export function specText(spec = {}) {
  const bits = [spec.instrumental ? 'instrumental' : spec.lyrics ? 'vocals, your lyrics' : 'vocals, PG1 writes the lyrics'];
  if (spec.bpm) bits.push(`${spec.bpm} BPM`);
  if (spec.key) bits.push(spec.key);
  bits.push(spec.length === 'full' ? 'full length' : 'about 30 s');
  return bits.join(' · ');
}

// --- prices and the cap ----------------------------------------------------------------

export const DEFAULT_MUSIC_CAP_USD = 2;
export const PREVIEW_COUNT = 2;

export function musicCapUsd(env = {}) {
  const raw = String(env.PG1_MUSIC_TRACK_CAP == null ? '' : env.PG1_MUSIC_TRACK_CAP).trim().replace(/^\$/, '');
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(raw)) return DEFAULT_MUSIC_CAP_USD;
  return Number(raw);
}

// --- statuses and actions ---------------------------------------------------------------

export const MUSIC_STATUS_LABELS = Object.freeze({
  preview_queued: 'Making two previews…',
  previewing: 'Making two previews…',
  awaiting_choice: 'Previews ready: approve the take to finish',
  final_queued: 'Rendering the final track…',
  rendering: 'Rendering the final track…',
  done: 'Track ready',
  export_queued: 'Exporting stems, MIDI and WAV…',
  exporting: 'Exporting stems, MIDI and WAV…',
  failed: 'The track could not be finished',
  cancelled: 'Cancelled'
});

export const MUSIC_ACTIVE_STATUSES = Object.freeze(['preview_queued', 'previewing', 'final_queued', 'rendering', 'export_queued', 'exporting']);

export function musicIsActive(status) {
  return MUSIC_ACTIVE_STATUSES.includes(status);
}

// The pending_actions action types /music adds to the approve / decline
// flow. MUSIC_FINAL is one per preview ("use take N"); approving one
// declines the other.
export const MUSIC_ACTIONS = Object.freeze({ final: 'MUSIC_FINAL', edit: 'MUSIC_EDIT', retry: 'MUSIC_RETRY' });

export function isMusicAction(actionType) {
  return Object.values(MUSIC_ACTIONS).includes(actionType);
}

export const MUSIC_STAGES = Object.freeze(['preview', 'final', 'export']);
export const STAGE_QUEUED = Object.freeze({ preview: 'preview_queued', final: 'final_queued', export: 'export_queued' });
export const STAGE_RUNNING = Object.freeze({ preview: 'previewing', final: 'rendering', export: 'exporting' });
export const STAGE_WORDS = Object.freeze({ preview: 'the previews', final: 'the final render', export: 'the export' });

export const MUSIC_FAILURE_TEXT = Object.freeze({
  cap_reached: "the track's spending cap was reached, so nothing more was generated",
  throttled: 'the music engines kept rate-limiting requests, even after waiting and retrying',
  out_of_credit: 'the music engines are out of credit',
  not_configured: 'music is not configured on this deployment',
  refused: 'the request was declined by the content check',
  export_failed: 'the stems could not be separated',
  file_too_large: "file too large for storage limit: a file was over the vault's per-file limit, so it was not stored and its charge was given back",
  timeout: 'the render ran out of time',
  default: 'a render step failed'
});

// The stage a failed track stopped at.
export function failedMusicStage(t) {
  const f = t && t.failure && typeof t.failure === 'object' ? t.failure : null;
  if (f && MUSIC_STAGES.includes(f.stage)) return f.stage;
  if (t && t.master_path) return 'export';
  return t && t.chosen_variant ? 'final' : 'preview';
}

export function musicFailureMessage(t) {
  const stage = failedMusicStage(t);
  const why = MUSIC_FAILURE_TEXT[t && t.error_reason] || MUSIC_FAILURE_TEXT.default;
  return `${MUSIC_LABEL} stopped at ${STAGE_WORDS[stage]}: ${why}. Everything already made is kept; /music retry ${shortTrackId(t && t.id)} starts again from there without paying for it twice.`;
}

export const MUSIC_HELP_TEXT = [
  `### [ ${MUSIC_LABEL.toUpperCase()} ]`,
  'Original music and beats, with a DAW export. Every spend step is capped per track; the final render waits for your approval.',
  '- **/music** plus a description (genre, mood, instruments, era): two low-cost previews, then approve the take you want to finish. Options: **--instrumental**, **--bpm** N, **--key** X (C, F#m, Bb major), **--length** short|full, **--lyrics** "your own lyrics"',
  '- **/music export** <id>: drums, bass, vocals and other as WAV stems, a MIDI file per melodic stem, the WAV master and a README (BPM, key, licence), as one zip in the media library',
  '- **/music status** [id], **/music list**: where a track is, and the media library with players',
  '- **/music edit** <id> plus changes ("slower, add strings, --bpm 84"): new previews to approve',
  '- **/music retry** <id>: restart a track that stopped, from where it stopped (approve first)',
  'Original music only: no real artist or band names, no "in the voice/style of" a person, no existing song titles or lyrics, no voice cloning. Describe the sound instead.'
].join('\n');
