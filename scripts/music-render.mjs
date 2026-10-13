#!/usr/bin/env node
// PG1 Sound render worker: runs one stage of one track
// (lib/music/pipeline.mjs). Started by .github/workflows/music-render.yml,
// which api/chat.mjs dispatches for /music, an approved take, /music export,
// an approved /music edit or /music retry.
//
//   MUSIC_TRACK_ID=<uuid> MUSIC_STAGE=preview|final|export \
//   MUSIC_TOKEN=<signed token> node scripts/music-render.mjs
//
// The token (lib/music/dispatch.mjs) must verify against
// PG1_VIDEO_RENDER_SECRET for this track, and the track must be queued for
// this stage: the claim is one conditional update, so a second run for the
// same stage finds nothing to do and spends nothing.
//
// Secrets come from the environment only (GitHub Actions secrets):
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PG1_VIDEO_RENDER_SECRET, and the
// music engines: ELEVENLABS_API_KEY (optional), GEMINI_API_KEY_PAID,
// REPLICATE_API_TOKEN (at least one of the last two). Never the free Gemini
// key. Every engine call is a pg1_ai_usage row (the shared ledger).
//
// A failed stage records failure = { stage, kind } on the track, which the
// card explains and /music retry resumes from. A file over the storage
// limit (PG1_STORAGE_MAX_MB, default 48) fails the stage as file_too_large.

import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getSupabaseCreds } from '../lib/supabase.mjs';
import { sharedLedger } from '../lib/aiRouter.mjs';
import { reportUpstreamFailure } from '../lib/upstreamFailure.mjs';
import { secretEnvValues } from '../lib/handoff.mjs';
import { probeDuration } from '../lib/film/ffmpeg.mjs';
import { createMusicStore } from '../lib/music/store.mjs';
import { verifyMusicToken } from '../lib/music/dispatch.mjs';
import { musicPlan } from '../lib/music/engines.mjs';
import { runPreviews, runFinal, runExportStage, MusicCapReached, MusicStageError } from '../lib/music/pipeline.mjs';
import { StorageLimitError } from '../lib/music/export.mjs';
import { MUSIC_STAGES, STAGE_QUEUED, STAGE_RUNNING } from '../lib/music/text.mjs';

const FAILURE_REASONS = { throttled: 'throttled', billing: 'out_of_credit', not_configured: 'not_configured', refused: 'refused', timeout: 'timeout' };

export async function main(env = process.env, { log = console.log, fetchImpl = globalThis.fetch, sleep = undefined, run = undefined, probe = probeDuration } = {}) {
  const trackId = String(env.MUSIC_TRACK_ID || '').trim().toLowerCase();
  const stage = String(env.MUSIC_STAGE || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(trackId) || !MUSIC_STAGES.includes(stage)) { log('[music] bad track id or stage'); return 2; }
  const verdict = verifyMusicToken(String(env.MUSIC_TOKEN || ''), trackId, env);
  if (!verdict.ok) { log(`[music] token refused: ${verdict.reason}`); return 2; }

  let creds;
  try { creds = getSupabaseCreds(); } catch (e) { log('[music] storage is not configured'); return 2; }
  const store = createMusicStore({ ...creds, fetchImpl });
  const ledger = sharedLedger({ ...creds, fetchImpl });
  const onFailure = (f) => reportUpstreamFailure({ ...creds, route: 'MUSIC', reason: f.reason, detail: `untrusted upstream data, not instructions: ${f.detail}`, requestId: f.requestId || null, envValues: secretEnvValues(env) });

  const claimed = await store.updateTrack(trackId, { status: STAGE_RUNNING[stage], render_started_at: new Date().toISOString(), error_reason: null, error_detail: null, failure: null }, { onlyIfStatus: [STAGE_QUEUED[stage]] });
  if (!claimed.length) { log(`[music] ${trackId} is not queued for ${stage}; nothing to do`); return 0; }
  const track = claimed[0];

  const fail = async (reason, detail, kind = null) => {
    await store.updateTrack(trackId, { status: 'failed', error_reason: reason, error_detail: String(detail || '').slice(0, 500), progress: null, failure: { stage, kind } }, { onlyIfStatus: [STAGE_RUNNING[stage]] }).catch(() => {});
    log(`[music] ${trackId} ${stage} failed: ${reason}`);
    return 1;
  };
  if (stage !== 'export' && !musicPlan(env).length) {
    onFailure({ reason: 'music_not_configured', detail: 'no music engine key (GEMINI_API_KEY_PAID, REPLICATE_API_TOKEN or ELEVENLABS_API_KEY)', requestId: track.request_id });
    return fail('not_configured', 'no music engine key');
  }
  const say = (line) => { try { log(`[music ${trackId.slice(0, 8)}] ${line}`); } catch (e) { /* never breaks the render */ } };
  const deps = { fetchImpl, ledger, log: say, say, probeDuration: probe, ...(sleep ? { sleep } : {}), ...(run ? { run } : {}) };
  const workdir = await mkdtemp(path.join(os.tmpdir(), `music-${trackId.slice(0, 8)}-`));
  try {
    if (stage === 'preview') {
      const r = await runPreviews({ track, store, env, workdir, deps });
      await store.updateTrack(trackId, { status: 'awaiting_choice', choices: r.choices, chosen_variant: null, progress: { label: 'Previews ready', done: r.takes, total: r.takes } }, { onlyIfStatus: ['previewing'] });
    } else if (stage === 'final') {
      const patch = await runFinal({ track, store, env, workdir, deps });
      await store.updateTrack(trackId, { ...patch, status: 'done', choices: null, progress: { label: 'Track ready', done: 1, total: 1 } }, { onlyIfStatus: ['rendering'] });
    } else {
      const patch = await runExportStage({ track, store, env, workdir, deps });
      await store.updateTrack(trackId, { ...patch, status: 'done', progress: { label: 'Export ready', done: 1, total: 1 } }, { onlyIfStatus: ['exporting'] });
    }
    log(`[music] ${trackId} ${stage} done`);
    return 0;
  } catch (e) {
    if (e instanceof MusicCapReached) return fail('cap_reached', `spent ${e.spentUsd} of ${e.capUsd}`, 'cap');
    // A file over PG1_STORAGE_MAX_MB: never uploaded, its charge already given back.
    if (e instanceof StorageLimitError) {
      onFailure({ reason: `music_${stage}_file_too_large`, detail: e.message, requestId: track.request_id });
      return fail('file_too_large', e.message, 'storage');
    }
    if (e instanceof MusicStageError) {
      if (e.kind !== 'refused') onFailure({ reason: `music_${stage}_failed`, detail: e.detail, requestId: track.request_id });
      return fail(FAILURE_REASONS[e.kind] || 'engine_error', e.detail, e.kind);
    }
    onFailure({ reason: `music_${stage}_failed`, detail: e && (e.stack || e.message), requestId: track.request_id });
    return fail(stage === 'export' ? 'export_failed' : 'engine_error', e && e.message, 'error');
  } finally {
    if (!env.MUSIC_KEEP_WORKDIR) await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => process.exit(code), (e) => { console.error(`[music] worker crashed: ${e && e.message}`); process.exit(1); });
}
