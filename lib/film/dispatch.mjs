// Starts a PG1 Studio render on GitHub Actions (.github/workflows/
// film-render.yml). Long renders never run in a Vercel function: the chat
// only queues the stage on the film's row and dispatches the workflow,
// which runs scripts/film-render.mjs with ffmpeg and no time limit worth
// worrying about (the job's own timeout is two hours).
//
// The dispatch carries a short-lived token over the film's id, signed with
// the same secret as PG1 Motion's render (PG1_VIDEO_RENDER_SECRET, or
// CRON_SECRET): the worker refuses a stage whose token does not verify, so
// a dispatch made by hand, or replayed later, renders nothing.

import { signRenderToken, verifyRenderToken, videoRenderSecret } from '../videoJobs.mjs';

export const FILM_WORKFLOW = 'film-render.yml';
export const DEFAULT_FILM_REPO = 'Project-Gifted1/pg1-ai-agent';
// Long enough for the job to wait in GitHub's queue.
export const FILM_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
export const FILM_STAGES = Object.freeze(['storyboard', 'preview', 'full']);

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function filmRenderRepo(env = {}) {
  const r = String(env.PG1_FILM_RENDER_REPO || '').trim();
  return REPO_RE.test(r) ? r : DEFAULT_FILM_REPO;
}

export function filmRenderRef(env = {}) {
  const r = String(env.PG1_FILM_RENDER_REF || '').trim();
  return /^[A-Za-z0-9_./-]{1,100}$/.test(r) ? r : 'main';
}

export function filmDispatchToken(env = {}) {
  return String(env.PG1_FILM_GITHUB_TOKEN || env.GITHUB_TOKEN || '').replace(/\s+/g, '');
}

// What a dispatch needs; [] when ready.
export function missingDispatchConfig(env = {}) {
  const out = [];
  if (!videoRenderSecret(env)) out.push('PG1_VIDEO_RENDER_SECRET');
  if (!filmDispatchToken(env)) out.push('GITHUB_TOKEN');
  return out;
}

export function signFilmToken(projectId, env = {}, now = Date.now()) {
  return signRenderToken({ jobId: projectId, secret: videoRenderSecret(env), now, ttlMs: FILM_TOKEN_TTL_MS });
}

export function verifyFilmToken(token, projectId, env = {}, now = Date.now()) {
  const v = verifyRenderToken(token, { secret: videoRenderSecret(env), now, ttlMs: FILM_TOKEN_TTL_MS });
  return v.ok && v.jobId === String(projectId || '').toLowerCase() ? { ok: true } : { ok: false, reason: v.ok ? 'wrong_project' : v.reason };
}

// Resolves to { ok, status, detail }. Never throws.
export async function dispatchFilmRender({ env = {}, projectId, stage, fetchImpl = globalThis.fetch, now = Date.now() }) {
  if (!FILM_STAGES.includes(stage)) return { ok: false, status: null, detail: 'unknown stage' };
  const missing = missingDispatchConfig(env);
  if (missing.length) return { ok: false, status: null, detail: `missing ${missing.join(' and ')}` };
  const repo = filmRenderRepo(env);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${FILM_WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${filmDispatchToken(env)}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'PG1-Studio',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ref: filmRenderRef(env), inputs: { project_id: projectId, stage, token: signFilmToken(projectId, env, now) } }),
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
