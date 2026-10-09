// PG1 Studio: names, commands and wording for multi-shot films, with no
// engine code (api/chat.mjs imports it on every request).
//
// White-label: everything the operator reads says "PG1 Studio" (or PG1
// Motion for single clips, lib/videoText.mjs). No provider, model or engine
// name ever appears in a reply, a card, a caption, a title card or the
// rendered file's metadata; those go to pg1_errors only.

export const FILM_LABEL = 'PG1 Studio';
export const MAX_FILM_REQUEST_CHARS = 4000;

// /film <what the film is about>      storyboard a new film
// /film status <id>                    where a film is
// /film list                           the latest films
// /film preview <id>                   ask again for the preview approval
// /film render <id>                    ask again for the full-render approval
// /film edit <id> <change>             change the timeline (approve/decline)
// /film media <id> [what]              find a shot, clip or still
// /film timeline <id>                  the timeline JSON
const SUBCOMMANDS = new Set(['status', 'list', 'preview', 'render', 'edit', 'media', 'timeline', 'help']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A short id is the first 8 hex characters of a project id.
const ID_RE = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function isFilmCommand(text) {
  return /^\/film(?:\s|$)/i.test(String(text || '').trim());
}

// { sub, id, rest } — sub is 'new' for a storyboard request, 'help' for a
// bare /film, or one of SUBCOMMANDS. id is a full or short project id
// (lowercased) or null.
export function parseFilmCommand(text) {
  const body = String(text || '').trim().replace(/^\/film\b[:\s]*/i, '');
  if (!body) return { sub: 'help', id: null, rest: '' };
  const m = /^(\S+)\s*([\s\S]*)$/.exec(body);
  const word = m[1].toLowerCase();
  if (!SUBCOMMANDS.has(word)) return { sub: 'new', id: null, rest: body.slice(0, MAX_FILM_REQUEST_CHARS) };
  if (word === 'list' || word === 'help') return { sub: word, id: null, rest: '' };
  const m2 = /^(\S+)\s*([\s\S]*)$/.exec(m[2] || '');
  const id = m2 && ID_RE.test(m2[1]) ? m2[1].toLowerCase() : null;
  return { sub: word, id, rest: id ? (m2[2] || '').trim() : (m[2] || '').trim() };
}

export function isFullProjectId(id) {
  return UUID_RE.test(String(id || ''));
}

export function shortFilmId(id) {
  return String(id || '').slice(0, 8);
}

export function usd(n) {
  return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
}

export const FILM_HELP_TEXT = [
  `### [ ${FILM_LABEL.toUpperCase()} ]`,
  'Multi-shot films of a minute or more: storyboard, low-res preview, then the full render. Every spend step waits for your approval, and each film has a spending cap.',
  '- **/film** plus what the film is about: PG1 writes the storyboard and estimates the cost',
  '- **/film status** <id>, **/film list**: where a film is',
  '- **/film edit** <id> plus a change ("trim the drone shot in scene 3 to 4 seconds", "swap the music in scene 2 for something calmer", "turn captions off"): a timeline change to approve; only what changed is re-rendered',
  '- **/film media** <id> [what]: find a shot, clip or still ("the drone shot in scene 3")',
  '- **/film preview** <id>, **/film render** <id>: ask again for an approval that expired',
  '- **/film timeline** <id>: the timeline JSON'
].join('\n');

export const FILM_STATUS_LABELS = Object.freeze({
  storyboard_queued: 'Writing the storyboard…',
  storyboarding: 'Writing the storyboard…',
  awaiting_preview_approval: 'Storyboard ready: approve the preview',
  preview_queued: 'Rendering the preview…',
  preview_rendering: 'Rendering the preview…',
  preview_done: 'Preview ready: approve the full render',
  full_queued: 'Rendering the film…',
  full_rendering: 'Rendering the film…',
  done: 'Film ready',
  failed: 'The film could not be finished',
  cancelled: 'Cancelled'
});

export const FILM_ACTIVE_STATUSES = Object.freeze(['storyboard_queued', 'storyboarding', 'preview_queued', 'preview_rendering', 'full_queued', 'full_rendering']);

export function filmIsActive(status) {
  return FILM_ACTIVE_STATUSES.includes(status);
}

// The pending_actions action types this feature adds to the approve /
// decline flow.
export const FILM_ACTIONS = Object.freeze({ preview: 'FILM_PREVIEW', full: 'FILM_FULL', edit: 'FILM_EDIT' });

export function isFilmAction(actionType) {
  return Object.values(FILM_ACTIONS).includes(actionType);
}

// Plain reasons a film stopped, for the operator. The engine's own words
// stay in pg1_errors / error_detail.
export const FILM_FAILURE_TEXT = Object.freeze({
  cap_reached: "the film's spending cap was reached, so nothing more was generated",
  not_configured: 'the render is not configured on this deployment',
  storyboard_failed: 'the storyboard could not be written',
  refused: 'the request was declined by the content check, so nothing more was generated',
  timeout: 'the render ran out of time',
  default: 'a render step failed'
});

export function filmFailureText(reason) {
  return FILM_FAILURE_TEXT[reason] || FILM_FAILURE_TEXT.default;
}
