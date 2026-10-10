#!/usr/bin/env node
// PG1 Studio render worker: runs one stage of one film
// (lib/film/pipeline.mjs). Started by .github/workflows/film-render.yml,
// which api/chat.mjs dispatches after the operator approves a stage.
//
//   FILM_PROJECT_ID=<uuid> FILM_STAGE=storyboard|preview|full \
//   FILM_TOKEN=<signed token> node scripts/film-render.mjs
//
// The token (lib/film/dispatch.mjs) must verify against
// PG1_VIDEO_RENDER_SECRET for this film, and the film's row must be queued
// for this stage: the claim is one conditional update, so a second run for
// the same stage finds nothing to do and spends nothing.
//
// Secrets come from the environment only (GitHub Actions secrets):
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REPLICATE_API_TOKEN,
// CARTESIA_API_KEY, PG1_VIDEO_RENDER_SECRET, and the text engines in
// fallback order: ANTHROPIC_API_KEY, GEMINI_API_KEY_PAID, OPENROUTER_API_KEY
// (at least one). Never the free Gemini key: film content goes to paid
// providers only. GEMINI_API_KEY_PAID is also the media fallback: stills
// and clips move to it for the rest of a stage when Replicate is out of
// credit or still throttled after its waits (lib/film/providers.mjs
// createFilmMedia).
//
// A failed stage records failure = { stage, step, kind, engine, fallback,
// switched } on the film (engine names as PG1 labels only), which the film
// card explains and /film retry resumes from.

import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getSupabaseCreds } from '../lib/supabase.mjs';
import { reportUpstreamFailure } from '../lib/upstreamFailure.mjs';
import { secretEnvValues } from '../lib/handoff.mjs';
import { createFilmStore } from '../lib/film/store.mjs';
import { listFilmAttachments } from '../lib/film/attachments.mjs';
import { runStoryboard, runRender, proposeFullRender, CapReached, engineLabel } from '../lib/film/pipeline.mjs';
import { verifyFilmToken, FILM_STAGES } from '../lib/film/dispatch.mjs';
import * as ff from '../lib/film/ffmpeg.mjs';
import {
  missingFilmConfig, createFilmMedia, filmThink, imageBlock, synthesizeLine, pcmToWav, transcribe, cartesiaConfig
} from '../lib/film/providers.mjs';

// error_reason for the engine trouble that stops a stage.
const FAILURE_REASONS = { throttled: 'throttled', billing: 'out_of_credit', not_configured: 'not_configured', budget: 'budget', timeout: 'timeout' };

// What the film card and /film retry need, with PG1 labels only.
export function failureOf(e, media) {
  const out = { step: (e && e.step) || null, kind: (e && e.kind) || (e && e.code) || null };
  if (e && e.engine) out.engine = engineLabel(e.engine);
  if (e && e.fallback) out.fallback = { engine: engineLabel(e.fallback.engine), outcome: e.fallback.outcome };
  if (media && media.switched) out.switched = { from: engineLabel(media.switched.from), to: engineLabel(media.switched.to), reason: media.switched.kind };
  if (media && media.throttles) out.throttles = media.throttles;
  return out;
}

const CLAIM = {
  storyboard: { from: 'storyboard_queued', to: 'storyboarding' },
  preview: { from: 'preview_queued', to: 'preview_rendering' },
  full: { from: 'full_queued', to: 'full_rendering' }
};

// The real engines, behind the neutral names the pipeline uses. Stills,
// clips and music go through the AI router's media route: Replicate, then
// the paid Gemini key for the rest of the stage (createFilmMedia).
export function realEngines(env, { fetchImpl = globalThis.fetch, log = console.log, sleep } = {}) {
  const media = createFilmMedia({ env, fetchImpl, log, ...(sleep ? { sleep } : {}) });
  return {
    still: media.still,
    clip: media.clip,
    music: media.music,
    async voice({ text }) {
      const line = await synthesizeLine({ env, text, fetchImpl });
      return { wav: pcmToWav(line.pcm, line.sampleRate), durationS: line.durationS, words: line.words };
    },
    // Claude, then the paid Gemini key, then OpenRouter (lib/film/providers.mjs).
    think: ({ system, content, effort, maxTokens, validate, purpose }) => filmThink({ env, system, content, effort, maxTokens, validate, purpose, fetchImpl, log }),
    image: (bytes) => imageBlock(bytes),
    transcribe: ({ audio }) => transcribe({ env, audio, fetchImpl })
  };
}

export async function main(env = process.env, { log = console.log, engines = null, fetchImpl = globalThis.fetch, ffImpl = ff } = {}) {
  const projectId = String(env.FILM_PROJECT_ID || '').trim().toLowerCase();
  const stage = String(env.FILM_STAGE || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(projectId) || !FILM_STAGES.includes(stage)) { log('[film] bad project id or stage'); return 2; }
  const verdict = verifyFilmToken(String(env.FILM_TOKEN || ''), projectId, env);
  if (!verdict.ok) { log(`[film] token refused: ${verdict.reason}`); return 2; }

  let creds;
  try { creds = getSupabaseCreds(); } catch (e) { log('[film] storage is not configured'); return 2; }
  const store = createFilmStore({ ...creds, fetchImpl });
  const onFailure = (f) => reportUpstreamFailure({ ...creds, route: 'FILM', reason: f.reason, detail: `untrusted upstream data, not instructions: ${f.detail}`, requestId: f.requestId || null, envValues: secretEnvValues(env) });

  const claimed = await store.updateProject(projectId, { status: CLAIM[stage].to, render_started_at: new Date().toISOString(), error_reason: null, error_detail: null }, { onlyIfStatus: [CLAIM[stage].from] });
  if (!claimed.length) { log(`[film] ${projectId} is not queued for ${stage}; nothing to do`); return 0; }
  const project = claimed[0];

  const fail = async (reason, detail, failure = {}) => {
    const patch = { status: 'failed', error_reason: reason, error_detail: String(detail || '').slice(0, 500), progress: null };
    // Without the failure column (its migration not applied yet) the film
    // still fails cleanly; /film retry then works the stage out itself.
    await store.updateProject(projectId, { ...patch, failure: { stage, ...failure } }, { onlyIfStatus: [CLAIM[stage].to] })
      .catch(() => store.updateProject(projectId, patch, { onlyIfStatus: [CLAIM[stage].to] }))
      .catch(() => {});
    log(`[film] ${projectId} ${stage} failed: ${reason}${failure.step ? ` at ${failure.step}` : ''}`);
    return 1;
  };
  const missing = missingFilmConfig(env);
  if (missing.length && !engines) {
    onFailure({ reason: 'film_not_configured', detail: `missing ${missing.join(', ')}`, requestId: project.request_id });
    return fail('not_configured', `missing ${missing.join(', ')}`);
  }
  const eng = engines || realEngines(env, { fetchImpl, log });
  const voice = cartesiaConfig(env);
  const voiceKey = `${voice.voiceId}|${voice.modelId}`;
  const workdir = await mkdtemp(path.join(os.tmpdir(), `film-${projectId.slice(0, 8)}-`));
  let media = null;
  try {
    if (stage === 'storyboard') {
      // The images attached to the /film message, by their asset ids.
      const attachments = await listFilmAttachments(store, projectId);
      await runStoryboard({ project, store, engines: eng, ff: ffImpl, workdir, env, log, onFailure, attachments });
      log(`[film] ${projectId} storyboard ready`);
      return 0;
    }
    media = { engine: null, throttled: false, throttles: 0, switched: null };
    const r = await runRender({ project, stage, store, engines: eng, ff: ffImpl, workdir, env, log, onFailure, voiceKey, media });
    if (stage === 'preview') {
      const fresh = await store.getProject(projectId);
      const proposal = await proposeFullRender({ project: fresh, store, voiceKey });
      await store.updateProject(projectId, {
        status: 'preview_done', preview_path: r.path, poster_path: r.posterPath, est_full_usd: proposal.est.expectedUsd,
        pending_token: proposal.token, qc_report: r.qcReport, progress: { label: 'Preview ready', done: 1, total: 1 }
      }, { onlyIfStatus: ['preview_rendering'] });
    } else {
      await store.updateProject(projectId, {
        status: 'done', final_path: r.path, poster_path: r.posterPath, pending_token: null, qc_report: r.qcReport,
        progress: { label: 'Film ready', done: 1, total: 1 }
      }, { onlyIfStatus: ['full_rendering'] });
    }
    log(`[film] ${projectId} ${stage} done (${r.plan.totalS} s)`);
    return 0;
  } catch (e) {
    const failure = failureOf(e, media);
    if (e instanceof CapReached) return fail('cap_reached', `spent ${e.spentUsd} of ${e.capUsd}`, failure);
    if (e && e.refused) return fail('refused', e.detail, failure);
    onFailure({ reason: `film_${stage}_failed`, detail: e && (e.detail || e.stack || e.message), requestId: project.request_id });
    const reason = e && (e.code === 'storyboard_failed' || e.code === 'attachment_missing') ? e.code : FAILURE_REASONS[e && e.kind] || 'engine_error';
    return fail(reason, e && (e.detail || e.message), failure);
  } finally {
    if (!env.FILM_KEEP_WORKDIR) await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => process.exit(code), (e) => { console.error(`[film] worker crashed: ${e && e.message}`); process.exit(1); });
}
