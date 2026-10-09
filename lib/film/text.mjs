// PG1 Studio: names, commands and wording for multi-shot films, with no
// engine code (api/chat.mjs imports it on every request).
//
// White-label: everything the operator reads says "PG1 Studio" (or PG1
// Motion for single clips, lib/videoText.mjs). No provider, model or engine
// name ever appears in a reply, a card, a caption, a title card or the
// rendered file's metadata; those go to pg1_errors only.

import { ENGINE_LABELS } from '../aiRouter.mjs';

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
// /film sync-secrets                   copy the worker's secrets to GitHub (approve/decline)
// /film retry <id>                     restart a failed film at the stage it stopped (approve/decline)
const SUBCOMMANDS = new Set(['status', 'list', 'preview', 'render', 'edit', 'media', 'timeline', 'help', 'sync-secrets', 'retry']);
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
  if (word === 'list' || word === 'help' || word === 'sync-secrets') return { sub: word, id: null, rest: '' };
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
  '- **/film timeline** <id>: the timeline JSON',
  '- **/film retry** <id>: restart a film that stopped, from the stage it stopped at; everything already made is reused, so nothing paid for is made twice (approve first)',
  '- **/film sync-secrets**: copy the render worker\'s secrets from this deployment into GitHub Actions (names only are shown; approve first)'
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
// decline flow. FILM_SYNC_SECRETS is the one-off /film sync-secrets
// (lib/film/secretsSync.mjs); it belongs to no film.
// FILM_RETRY is /film retry: the failed stage again, reusing every asset.
export const FILM_ACTIONS = Object.freeze({ preview: 'FILM_PREVIEW', full: 'FILM_FULL', edit: 'FILM_EDIT', syncSecrets: 'FILM_SYNC_SECRETS', retry: 'FILM_RETRY' });

export function isFilmAction(actionType) {
  return Object.values(FILM_ACTIONS).includes(actionType);
}

// Plain reasons a film stopped, for the operator. The engine's own words
// stay in pg1_errors / error_detail.
export const FILM_FAILURE_TEXT = Object.freeze({
  cap_reached: "the film's spending cap was reached, so nothing more was generated",
  throttled: 'the media engine kept rate-limiting requests (throttling), even after waiting and retrying for up to 3 minutes',
  out_of_credit: 'the media engine is out of credit',
  budget: "today's AI budget for the media engine is reached",
  not_configured: 'the render is not configured on this deployment',
  storyboard_failed: 'the storyboard could not be written',
  refused: 'the request was declined by the content check, so nothing more was generated',
  timeout: 'the render ran out of time',
  default: 'a render step failed'
});

export function filmFailureText(reason) {
  return FILM_FAILURE_TEXT[reason] || FILM_FAILURE_TEXT.default;
}

// --- why a film stopped, for the film card -----------------------------------------

export const FILM_STAGE_WORDS = Object.freeze({ storyboard: 'the storyboard', preview: 'the preview', full: 'the full render' });
const STEP_WORDS = Object.freeze({ reference: 'the reference still', stills: 'the shot stills', voice: 'the voiceover', music: 'the music beds', clips: 'the video clips' });
const STEP_NOUNS = Object.freeze({ reference: 'stills', stills: 'stills', music: 'music', clips: 'video clips', voice: 'voiceover' });

// The stage a failed film stopped at: what the worker recorded, else what
// the film has (no storyboard yet, no preview yet, else the full render).
export function failedStage(p) {
  const f = p && p.failure && typeof p.failure === 'object' ? p.failure : null;
  if (f && FILM_STAGE_WORDS[f.stage]) return f.stage;
  if (!p || !p.timeline) return 'storyboard';
  return p.preview_path ? 'full' : 'preview';
}

// One sentence for a failed film: the stage (and step) it stopped at, and
// whether that was throttling or credit, naming engines by their PG1
// labels only (lib/aiRouter.mjs ENGINE_LABELS).
export function filmFailureMessage(p) {
  const f = p && p.failure && typeof p.failure === 'object' ? p.failure : {};
  const reason = p && p.error_reason;
  const stage = failedStage(p);
  const where = ` at ${FILM_STAGE_WORDS[stage]}${STEP_WORDS[f.step] ? ` (${STEP_WORDS[f.step]})` : ''}`;
  const engine = f.engine || ENGINE_LABELS.replicate;
  let why;
  if (reason === 'throttled') why = `the ${engine} kept rate-limiting requests (throttling), even after waiting and retrying for up to 3 minutes`;
  else if (reason === 'out_of_credit') why = `the ${engine} is out of credit`;
  else if (reason === 'budget') why = `today's AI budget for the ${engine} is reached`;
  else why = filmFailureText(reason);
  const fb = f.fallback;
  if (fb && fb.engine && (reason === 'throttled' || reason === 'out_of_credit')) {
    if (fb.outcome === 'not_configured') why += `, and no ${ENGINE_LABELS.gemini_paid} key is set up to take over`;
    else if (fb.outcome === 'unavailable') why += `, and the ${fb.engine} cannot stand in for ${STEP_NOUNS[f.step] || 'this step'}`;
    else if (fb.outcome === 'failed') why += `, and the ${fb.engine} could not take over either`;
  } else if (f.switched && f.switched.to) {
    why += ` (the ${f.switched.to} had taken over after the ${f.switched.from} ${f.switched.reason === 'billing' ? 'ran out of credit' : 'was throttled'})`;
  }
  const sid = p && p.id ? shortFilmId(p.id) : '';
  return `${FILM_LABEL} stopped${where}: ${why}. Everything already made is kept; /film retry ${sid} starts again from ${FILM_STAGE_WORDS[stage]} without paying for it twice.`;
}
