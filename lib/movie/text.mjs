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
//                  of shots the operator named, reusing everything else; a
//                  paused movie resumed (/movie resume), with its new budget
export const MOVIE_ACTIONS = Object.freeze({ script: 'MOVIE_SCRIPT', budget: 'MOVIE_BUDGET', retry: 'MOVIE_RETRY' });

export function isMovieAction(actionType) {
  return Object.values(MOVIE_ACTIONS).includes(actionType);
}

// Paused before spending more: over its confirmed budget, or the engine for
// the next step out of credit. Not a failure: /movie resume continues from
// the first missing shot. Its own status after migration
// 20261108120000_pg1_movie_paused_budget.sql; before it, stored as failed
// with error_reason paused_budget (isMoviePaused reads both).
export const MOVIE_PAUSED_STATUS = 'paused_budget';
export function isMoviePaused(p) {
  return !!(p && (p.status === MOVIE_PAUSED_STATUS || (p.status === 'failed' && p.error_reason === 'paused_budget')));
}

// A movie's statuses are the film table's own, plus paused_budget:
export const MOVIE_STATUS_LABELS = Object.freeze({
  storyboard_queued: 'Writing the screenplay…',
  storyboarding: 'Writing the screenplay and casting…',
  awaiting_preview_approval: 'Screenplay and cast ready: approve them',
  awaiting_director_approval: 'Cost estimate ready: approve it to start the shoot',
  director_queued: 'Shooting: starting…',
  directing: 'Shooting, reviewing takes, recording and cutting…',
  done: 'Movie ready',
  failed: 'The movie could not be finished',
  paused_budget: 'Paused before spending more: resume when ready',
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
// /movie "<idea>" ... [--budget <usd>]
// /movie status <id> | list | screenplay <id> | retry <id> | resume <id> [--budget <usd>] | retake <id> <shot ids> | help
const SUBCOMMANDS = new Set(['status', 'list', 'screenplay', 'retry', 'resume', 'retake', 'help']);
// --budget: a hard cap in USD for the shoot (default: the worst-case estimate).
export const MAX_MOVIE_BUDGET_USD = 1000;
const BUDGET_RE = /(?:^|\s)--budget(?:\s+|=)\$?(\d{1,4}(?:\.\d{1,2})?)(?:\s*usd)?(?=\s|$)/i;
export function parseBudget(text) {
  const m = BUDGET_RE.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 && n <= MAX_MOVIE_BUDGET_USD ? n : null;
}
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
    const rest = id ? (m2[2] || '').trim() : (m[2] || '').trim();
    return { sub: word, id, rest, budgetUsd: word === 'resume' ? parseBudget(rest) : null };
  }
  let t = body;
  const take = (re) => { const x = re.exec(t); if (!x) return null; t = (t.slice(0, x.index) + ' ' + t.slice(x.index + x[0].length)); return x; };
  const len = take(/(?:^|\s)--length(?:\s+|=)(\d{1,2}(?:\.\d{1,2})?)\s*(?:m|min|mins|minutes?)?(?=\s|$)/i);
  const voice = take(/(?:^|\s)--voice(?:\s+|=)(?:"([^"]{1,120})"|'([^']{1,120})'|“([^”]{1,120})”|(\S{1,120}))/i);
  const client = take(/(?:^|\s)--client(?:(?:\s+|=)(?:"([^"]{1,80})"|'([^']{1,80})'|“([^”]{1,80})”))?(?=\s|$)/i);
  const budgetUsd = parseBudget(t);
  take(BUDGET_RE);
  const minutes = len ? Math.min(MAX_MOVIE_MINUTES, Math.max(MIN_MOVIE_MINUTES, Number(len[1]))) : DEFAULT_MOVIE_MINUTES;
  const clientName = client ? (client[1] || client[2] || client[3] || '').trim() : '';
  return {
    sub: 'new', id: null, rest: '',
    idea: unquote(t.replace(/\s+/g, ' ')).slice(0, MAX_MOVIE_IDEA_CHARS),
    minutes,
    voice: voice ? (voice[1] || voice[2] || voice[3] || voice[4] || '').trim() || null : null,
    budgetUsd,
    client: client ? { name: clientName || 'Client', credit: true } : null
  };
}

export const MOVIE_HELP_TEXT = [
  `### [ ${MOVIE_LABEL.toUpperCase()}: MOVIES ]`,
  'Movies with characters who act and speak on screen, cut with real coverage. Narration is off unless you ask for it. /film stays for narrated films.',
  '- **/movie** "<idea>" [--length <minutes>, default 2] [--voice "<narrator>" only if you want narration] [--client] [--budget <usd>]: PG1 writes a three-act screenplay and casts a voice for every speaking character. Nothing else is spent until you approve the screenplay and cast, then confirm the budget (the worst case, or your --budget as a hard cap).',
  '- **/movie status** <id>, **/movie list**: where a movie is',
  '- **/movie screenplay** <id>: the saved screenplay',
  '- **/movie retry** <id>: start a stopped movie again from where it stopped; the screenplay, bibles, cast and accepted takes are reused, never made or paid for twice (approve first)',
  '- **/movie resume** <id> [--budget <usd>]: continue a paused movie from its first missing shot; saved shots and voices are never made again (confirm first)',
  '- **/movie retake** <id> <shot ids>: a new take of the shots you name (for example s2-d3); everything else is kept (approve first)',
  'Every movie: character and location bibles with fixed reference images, one voice per character for the whole movie, coverage (wides, over-the-shoulders, reverses, close-ups), every take checked once and retaken at most once (PG1_MOVIE_MAX_RETAKES), dialogue, effects and ambience, and score stems, mastered at -14 LUFS, 24 fps, 1920x1080 when the picture allows it, and checked before delivery.'
].join('\n');

// --- why a movie stopped ------------------------------------------------------------

export const MOVIE_FAILURE_TEXT = Object.freeze({
  cap_reached: "the movie's spending cap was reached, so nothing more was generated",
  price_floor: 'the next step would take spend past the package floor, so nothing more was generated',
  throttled: 'the picture engine kept rate-limiting requests, even after waiting and retrying',
  out_of_credit: 'the picture engine is out of credit',
  spend_cap_reached: "the picture engine's monthly spending cap is reached (not a credit problem: the cap needs raising; /keys shows which account)",
  budget: "today's AI budget for the picture engine is reached",
  not_configured: 'the render is not configured on this deployment',
  screenplay_failed: 'the screenplay could not be written',
  no_speech_engine: 'no picture engine that can show characters speaking is available for this movie',
  refused: 'the request was declined by the content check, so nothing more was generated',
  paused_budget: 'it paused before spending more than its budget or the engine\'s credit allows',
  timeout: 'the render ran out of time',
  default: 'a render step failed'
});

// The paused card and push: why, what is saved, and what finishing needs.
export function moviePausedText(p) {
  const d = (p && p.director) || {};
  const x = d.pause || {};
  const sid = shortMovieId(p && p.id);
  const why = x.reason === 'credit' ? "the picture engine's credit is too low for the next shot" : "the next step would go over this movie's budget";
  return sayMovie([
    `${MOVIE_LABEL}: movie ${sid} paused before spending more: ${why}. Nothing over the budget was spent.`,
    x.shotsTotal ? `${x.shotsDone || 0} of ${x.shotsTotal} shots are saved with their voices and will not be made again.` : '',
    `To finish: about ${usd(x.needUsd)} USD (at most ${usd(x.worstUsd)} USD).${x.reason === 'credit' ? ' Top up the account first (/keys shows which one).' : ''}`,
    `/movie resume ${sid} continues from the first missing shot${x.reason === 'budget' ? '; add --budget <usd> to raise the cap' : ''}.`
  ].filter(Boolean).join('\n'));
}

export function movieFailureMessage(p) {
  if (isMoviePaused(p)) return moviePausedText(p);
  const reason = (p && p.error_reason) || 'default';
  const sid = shortMovieId(p && p.id);
  const stage = p && p.failure && p.failure.stage === MOVIE_STAGES.script ? 'the screenplay' : 'the shoot';
  return sayMovie(`${MOVIE_LABEL} stopped at ${stage}: ${MOVIE_FAILURE_TEXT[reason] || MOVIE_FAILURE_TEXT.default}. Everything already made and approved is kept; /movie retry ${sid} starts again from there without paying for it twice.`);
}
