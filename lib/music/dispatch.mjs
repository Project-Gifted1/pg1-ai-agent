// Starts a PG1 Sound render on GitHub Actions (.github/workflows/
// music-render.yml): the previews, the final render and the stems export
// all run there (a full-length song and stem separation take far longer
// than a chat function may run). The chat only queues the stage on the
// track's row and dispatches the workflow.
//
// The dispatch carries a short-lived token over the track's id, signed with
// the same secret as PG1 Studio's (PG1_VIDEO_RENDER_SECRET, or CRON_SECRET),
// and the workflow takes the same repo, ref and dispatch token settings
// (PG1_FILM_RENDER_REPO, PG1_FILM_RENDER_REF, PG1_FILM_GITHUB_TOKEN or
// GITHUB_TOKEN). The worker refuses a stage whose token does not verify and
// only claims a track that is queued for it.

import { retryOnce } from '../commands/retry.mjs';
import { filmRenderRepo, filmRenderRef, filmDispatchToken, missingDispatchConfig } from '../film/dispatch.mjs';
import { signRenderToken, verifyRenderToken, videoRenderSecret } from '../videoJobs.mjs';
import { MUSIC_STAGES } from './text.mjs';

export const MUSIC_WORKFLOW = 'music-render.yml';
export const MUSIC_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
export { missingDispatchConfig };

export function signMusicToken(trackId, env = {}, now = Date.now()) {
  return signRenderToken({ jobId: trackId, secret: videoRenderSecret(env), now, ttlMs: MUSIC_TOKEN_TTL_MS });
}

export function verifyMusicToken(token, trackId, env = {}, now = Date.now()) {
  const v = verifyRenderToken(token, { secret: videoRenderSecret(env), now, ttlMs: MUSIC_TOKEN_TTL_MS });
  return v.ok && v.jobId === String(trackId || '').toLowerCase() ? { ok: true } : { ok: false, reason: v.ok ? 'wrong_track' : v.reason };
}

// Resolves to { ok, status, detail }. Never throws.
export async function dispatchMusicRender({ env = {}, trackId, stage, fetchImpl = globalThis.fetch, now = Date.now() }) {
  if (!MUSIC_STAGES.includes(stage)) return { ok: false, status: null, detail: 'unknown stage' };
  const missing = missingDispatchConfig(env);
  if (missing.length) return { ok: false, status: null, detail: `missing ${missing.join(' and ')}` };
  // FAILURE -> RETRY (lib/commands/retry.mjs): a 429, 5xx or dropped
  // connection is dispatched once more (the worker's claim makes a second
  // run of the same stage a no-op).
  return (await retryOnce(() => dispatchOnce({ env, trackId, stage, fetchImpl, now }))).result;
}

async function dispatchOnce({ env, trackId, stage, fetchImpl, now }) {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${filmRenderRepo(env)}/actions/workflows/${MUSIC_WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${filmDispatchToken(env)}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'PG1-Sound',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ref: filmRenderRef(env), inputs: { track_id: trackId, stage, token: signMusicToken(trackId, env, now) } }),
      cache: 'no-store'
    });
    if (res.status === 204 || res.status === 200) return { ok: true, status: res.status, detail: '' };
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch (e) { body = ''; }
    return { ok: false, status: res.status, detail: `workflow dispatch ${res.status}: ${body}` };
  } catch (e) {
    return { ok: false, status: null, detail: `workflow dispatch failed: ${e && e.message}` };
  }
}
