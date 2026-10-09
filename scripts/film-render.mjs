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
// ANTHROPIC_API_KEY, CARTESIA_API_KEY, PG1_VIDEO_RENDER_SECRET.

import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getSupabaseCreds } from '../lib/supabase.mjs';
import { reportUpstreamFailure } from '../lib/upstreamFailure.mjs';
import { secretEnvValues } from '../lib/handoff.mjs';
import { createFilmStore } from '../lib/film/store.mjs';
import { runStoryboard, runRender, proposeFullRender, CapReached } from '../lib/film/pipeline.mjs';
import { verifyFilmToken, FILM_STAGES } from '../lib/film/dispatch.mjs';
import * as ff from '../lib/film/ffmpeg.mjs';
import {
  filmModels, missingFilmConfig, replicateRun, download, stillInput, clipInput, musicInput, claudeMessage, imageBlock,
  synthesizeLine, pcmToWav, transcribe, cartesiaConfig
} from '../lib/film/providers.mjs';

const CLAIM = {
  storyboard: { from: 'storyboard_queued', to: 'storyboarding' },
  preview: { from: 'preview_queued', to: 'preview_rendering' },
  full: { from: 'full_queued', to: 'full_rendering' }
};

// The real engines, behind the neutral names the pipeline uses.
export function realEngines(env, { fetchImpl = globalThis.fetch } = {}) {
  const models = filmModels(env);
  return {
    async still({ prompt, referenceUrl = null, seed = null }) {
      const r = await replicateRun({ env, model: models.still, input: stillInput(prompt, { referenceUrl, seed }), fetchImpl });
      return download(r.url, { fetchImpl });
    },
    async clip({ prompt, startImageUrl, tier, seconds }) {
      const r = await replicateRun({ env, model: models.video, input: clipInput(models.video, { prompt, startImageUrl, tier, seconds }), fetchImpl, timeoutMs: 25 * 60 * 1000 });
      return download(r.url, { fetchImpl, timeoutMs: 300000 });
    },
    async music({ mood, bpm }) {
      const r = await replicateRun({ env, model: models.music, input: musicInput(mood, bpm), fetchImpl });
      const ext = (/\.(wav|mp3|flac|ogg|m4a)(?:\?|$)/i.exec(r.url) || [])[1] || 'wav';
      const mime = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4' }[ext.toLowerCase()];
      return { bytes: await download(r.url, { fetchImpl }), ext: ext.toLowerCase(), mime };
    },
    async voice({ text }) {
      const line = await synthesizeLine({ env, text, fetchImpl });
      return { wav: pcmToWav(line.pcm, line.sampleRate), durationS: line.durationS, words: line.words };
    },
    think: ({ system, content, effort, maxTokens }) => claudeMessage({ env, system, content, effort, maxTokens, fetchImpl }),
    image: (bytes) => imageBlock(bytes),
    transcribe: ({ audio }) => transcribe({ env, audio, fetchImpl })
  };
}

export async function main(env = process.env, { log = console.log, engines = null, fetchImpl = globalThis.fetch } = {}) {
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

  const fail = async (reason, detail) => {
    await store.updateProject(projectId, { status: 'failed', error_reason: reason, error_detail: String(detail || '').slice(0, 500), progress: null }, { onlyIfStatus: [CLAIM[stage].to] }).catch(() => {});
    log(`[film] ${projectId} ${stage} failed: ${reason}`);
    return 1;
  };
  const missing = missingFilmConfig(env);
  if (missing.length && !engines) {
    onFailure({ reason: 'film_not_configured', detail: `missing ${missing.join(', ')}`, requestId: project.request_id });
    return fail('not_configured', `missing ${missing.join(', ')}`);
  }
  const eng = engines || realEngines(env, { fetchImpl });
  const voice = cartesiaConfig(env);
  const voiceKey = `${voice.voiceId}|${voice.modelId}`;
  const workdir = await mkdtemp(path.join(os.tmpdir(), `film-${projectId.slice(0, 8)}-`));
  try {
    if (stage === 'storyboard') {
      await runStoryboard({ project, store, engines: eng, ff, workdir, env, log, onFailure });
      log(`[film] ${projectId} storyboard ready`);
      return 0;
    }
    const r = await runRender({ project, stage, store, engines: eng, ff, workdir, env, log, onFailure, voiceKey });
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
    if (e instanceof CapReached) return fail('cap_reached', `spent ${e.spentUsd} of ${e.capUsd}`);
    if (e && e.refused) return fail('refused', e.detail);
    onFailure({ reason: `film_${stage}_failed`, detail: e && (e.detail || e.stack || e.message), requestId: project.request_id });
    return fail(e && e.code === 'storyboard_failed' ? 'storyboard_failed' : 'engine_error', e && (e.detail || e.message));
  } finally {
    if (!env.FILM_KEEP_WORKDIR) await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => process.exit(code), (e) => { console.error(`[film] worker crashed: ${e && e.message}`); process.exit(1); });
}
