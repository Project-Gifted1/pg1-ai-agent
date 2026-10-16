// PG1 Studio movies (/movie): names, commands, statuses and wording, with
// no engine code (api/chat.mjs imports it on every request).
//
// A movie is told by its characters: they act and speak on screen, cut
// with coverage, not narrated over a montage (that is /film). It is kept in
// the same table as a film (pg1_film_projects, mode 'director') with
// director.kind = 'movie': the Director pattern's saved-stages jsonb holds
// the screenplay, the bibles, the cast, the shot list and every accepted
// take, so a resume, retry or retake reuses everything already approved.
//
// White label: every text here is what the operator reads. It says PG1
// Studio (picture) and PG1 Sound (score and voices) and never names a
// provider, a company or a model (sayMovie runs every reply through
// whiteLabel as a last guard; the tests hold every message to it).

import { whiteLabel } from '../whiteLabel.mjs';

export const MOVIE_LABEL = 'PG1 Studio';
export const MOVIE_KIND = 'movie';
export const DEFAULT_MOVIE_MINUTES = 2;
export const MIN_MOVIE_MINUTES = 0.5;
export const MAX_MOVIE_MINUTES = 10;
export const MAX_MOVIE_IDEA_CHARS = 2000;
export const DEFAULT_MOVIE_CAP_USD = 60;

// The worker stages (lib/film/dispatch.mjs FILM_STAGES, scripts/film-render.mjs).
export const MOVIE_STAGES = Object.freeze({ script: 'movie_script', render: 'movie' });

// The approve / decline flow (pending_actions.action_type):
//   MOVIE_SCRIPT   checkpoint (a): the screenplay and the cast
//   MOVIE_BUDGET   checkpoint (b): the cost per stage and the total; only
//                  this approval lets the render spend
//   MOVIE_RETRY    a stopped movie again from where it stopped, or a retake
//                  of shots the operator named, reusing everything else
export const MOVIE_ACTIONS = Object.freeze({ script: 'MOVIE_SCRIPT', budget: 'MOVIE_BUDGET', retry: 'MOVIE_RETRY' });

export function isMovieAction(actionType) {
  return Object.values(MOVIE_ACTIONS).includes(actionType);
}

// A movie's statuses are the film table's own (no new database states):
export const MOVIE_STATUS_LABELS = Object.freeze({
  storyboard_queued: 'Writing the screenplay…',
  storyboarding: 'Writing the screenplay and casting…',
  awaiting_preview_approval: 'Screenplay and cast ready: approve them',
  awaiting_director_approval: 'Cost estimate ready: approve it to start the shoot',
  director_queued: 'Shooting: starting…',
  directing: 'Shooting, reviewing takes, recording and cutting…',
  done: 'Movie ready',
  failed: 'The movie could not be finished',
  cancelled: 'Cancelled'
});

export function isMovieProject(p) {
  return !!(p && p.director && typeof p.director === 'object' && p.director.kind === MOVIE_KIND);
}

export function shortMovieId(id) {
  return String(id || '').slice(0, 8);
}

export function usd(n) {
  return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
}

// Every movie reply goes out through here: PG1's words only.
export function sayMovie(text) {
  return whiteLabel(String(text == null ? '' : text));
}

export function movieCapUsd(env = {}) {
  const raw = String(env.PG1_MOVIE_MAX_USD == null ? '' : env.PG1_MOVIE_MAX_USD).trim();
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(raw)) return DEFAULT_MOVIE_CAP_USD;
  return Number(raw);
}

// --- the command ---------------------------------------------------------------------

export function isMovieCommand(text) {
  return /^\/movie(?:\s|$)/i.test(String(text || '').trim());
}

// /movie "<idea>" [--length <minutes>] [--voice "<narrator>"] [--client ["Name"]]
// /movie status <id> | list | screenplay <id> | retry <id> | retake <id> <shot ids> | help
const SUBCOMMANDS = new Set(['status', 'list', 'screenplay', 'retry', 'retake', 'help']);
const ID_RE = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const unquote = (s) => String(s || '').trim().replace(/^["'“‘]([\s\S]*)["'”’]$/, '$1').trim();

// { sub, id, rest, idea, minutes, voice, client }. sub is 'new' for a movie
// idea, 'help' for a bare /movie, or one of SUBCOMMANDS.
export function parseMovieCommand(text) {
  const body = String(text || '').trim().replace(/^\/movie\b[:\s]*/i, '');
  if (!body) return { sub: 'help', id: null, rest: '' };
  const m = /^(\S+)\s*([\s\S]*)$/.exec(body);
  const word = m[1].toLowerCase();
  if (SUBCOMMANDS.has(word)) {
    if (word === 'list' || word === 'help') return { sub: word, id: null, rest: '' };
    const m2 = /^(\S+)\s*([\s\S]*)$/.exec(m[2] || '');
    const id = m2 && ID_RE.test(m2[1]) ? m2[1].toLowerCase() : null;
    return { sub: word, id, rest: id ? (m2[2] || '').trim() : (m[2] || '').trim() };
  }
  let t = body;
  const take = (re) => { const x = re.exec(t); if (!x) return null; t = (t.slice(0, x.index) + ' ' + t.slice(x.index + x[0].length)); return x; };
  const len = take(/(?:^|\s)--length(?:\s+|=)(\d{1,2}(?:\.\d{1,2})?)\s*(?:m|min|mins|minutes?)?(?=\s|$)/i);
  const voice = take(/(?:^|\s)--voice(?:\s+|=)(?:"([^"]{1,120})"|'([^']{1,120})'|“([^”]{1,120})”|(\S{1,120}))/i);
  const client = take(/(?:^|\s)--client(?:(?:\s+|=)(?:"([^"]{1,80})"|'([^']{1,80})'|“([^”]{1,80})”))?(?=\s|$)/i);
  const minutes = len ? Math.min(MAX_MOVIE_MINUTES, Math.max(MIN_MOVIE_MINUTES, Number(len[1]))) : DEFAULT_MOVIE_MINUTES;
  const clientName = client ? (client[1] || client[2] || client[3] || '').trim() : '';
  return {
    sub: 'new', id: null, rest: '',
    idea: unquote(t.replace(/\s+/g, ' ')).slice(0, MAX_MOVIE_IDEA_CHARS),
    minutes,
    voice: voice ? (voice[1] || voice[2] || voice[3] || voice[4] || '').trim() || null : null,
    client: client ? { name: clientName || 'Client', credit: true } : null
  };
}

export const MOVIE_HELP_TEXT = [
  `### [ ${MOVIE_LABEL.toUpperCase()}: MOVIES ]`,
  'Movies with characters who act and speak on screen, cut with real coverage. Narration is off unless you ask for it. /film stays for narrated films.',
  '- **/movie** "<idea>" [--length <minutes>, default 2] [--voice "<narrator>" only if you want narration] [--client]: PG1 writes a three-act screenplay and casts a voice for every speaking character. Nothing else is spent until you approve the screenplay and cast, then the cost estimate.',
  '- **/movie status** <id>, **/movie list**: where a movie is',
  '- **/movie screenplay** <id>: the saved screenplay',
  '- **/movie retry** <id>: start a stopped movie again from where it stopped; the screenplay, bibles, cast and accepted takes are reused, never made or paid for twice (approve first)',
  '- **/movie retake** <id> <shot ids>: a new take of the shots you name (for example s2-d3); everything else is kept (approve first)',
  'Every movie: character and location bibles with fixed reference images, one voice per character for the whole movie, coverage (wides, over-the-shoulders, reverses, close-ups), every take checked and retaken up to twice, dialogue, effects and ambience, and score stems, mastered at -14 LUFS, 24 fps, 1920x1080 when the picture allows it, and checked before delivery.'
].join('\n');

// --- why a movie stopped ------------------------------------------------------------

export const MOVIE_FAILURE_TEXT = Object.freeze({
  cap_reached: "the movie's spending cap was reached, so nothing more was generated",
  price_floor: 'the next step would take spend past the package floor, so nothing more was generated',
  throttled: 'the picture engine kept rate-limiting requests, even after waiting and retrying',
  out_of_credit: 'the picture engine is out of credit',
  budget: "today's AI budget for the picture engine is reached",
  not_configured: 'the render is not configured on this deployment',
  screenplay_failed: 'the screenplay could not be written',
  no_speech_engine: 'no picture engine that can show characters speaking is available for this movie',
  refused: 'the request was declined by the content check, so nothing more was generated',
  timeout: 'the render ran out of time',
  default: 'a render step failed'
});

export function movieFailureMessage(p) {
  const reason = (p && p.error_reason) || 'default';
  const sid = shortMovieId(p && p.id);
  const stage = p && p.failure && p.failure.stage === MOVIE_STAGES.script ? 'the screenplay' : 'the shoot';
  return sayMovie(`${MOVIE_LABEL} stopped at ${stage}: ${MOVIE_FAILURE_TEXT[reason] || MOVIE_FAILURE_TEXT.default}. Everything already made and approved is kept; /movie retry ${sid} starts again from there without paying for it twice.`);
}
