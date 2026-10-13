// PG1 Sound render stages, run by scripts/music-render.mjs on GitHub
// Actions:
//
//   preview  two low-cost takes (the music tier without ElevenLabs: Lyria on
//            the paid Gemini key, then Replicate), about 30 s each, stored
//            in the media library, each with its own MUSIC_FINAL approval
//            ("use take N"); the track waits in awaiting_choice
//   final    the approved take's direction rendered at the asked length on
//            the full music tier (ElevenLabs when set, Lyria, Replicate);
//            the master is stored with its provider, model and licence note
//   export   stems, MIDI, WAV master and README as one zip (lib/music/export.mjs)
//
// Spend. Before each engine call the track is charged the dearest engine in
// the plan (pg1_music_charge: only if it still fits under the cap); after
// it, the difference to the engine that made it is given back, and a call
// that failed is given back whole (the engines bill finished tracks only).

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { generateMusic, musicPlan, musicCallUsd } from './engines.mjs';
import { musicPath } from './store.mjs';
import { runExport, runCommand } from './export.mjs';
import { MUSIC_ACTIONS, MUSIC_LABEL, PREVIEW_COUNT, shortTrackId, specText, usd } from './text.mjs';

export class MusicCapReached extends Error {
  constructor(spentUsd, capUsd) {
    super("the track's spending cap is reached");
    this.code = 'cap_reached';
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
  }
}

// A stage stopped by the engines: kind is 'billing' | 'throttled' |
// 'refused' | 'engine' | 'not_configured'.
export class MusicStageError extends Error {
  constructor(kind, detail) {
    super(`music engines failed (${kind})`);
    this.kind = kind;
    this.detail = String(detail || '').slice(0, 500);
  }
}

export const PREVIEW_EXCLUDE = Object.freeze(['elevenlabs']);

export function trackSpec(track, extra = {}) {
  const o = track.options && typeof track.options === 'object' ? track.options : {};
  return { prompt: track.prompt, instrumental: !!o.instrumental, bpm: o.bpm || null, key: o.key || null, length: o.length === 'full' ? 'full' : 'short', lyrics: o.lyrics || '', ...extra };
}

// The most one call on `plan` can cost (what is reserved before it).
export function reserveUsd(plan, length) {
  return plan.reduce((m, c) => Math.max(m, musicCallUsd(c.provider, length)), 0);
}

// What a stage is expected to cost on this deployment's engines.
export function estimateMusic(env, stage, length = 'short') {
  if (stage === 'preview') return Math.round(PREVIEW_COUNT * reserveUsd(musicPlan(env, { exclude: [...PREVIEW_EXCLUDE] }), 'short') * 100) / 100;
  if (stage === 'final') return Math.round(reserveUsd(musicPlan(env), length) * 100) / 100;
  return 0;
}

function extOf(p) {
  return String(p || '').split('?')[0].split('.').pop().toLowerCase();
}

// One paid call: reserve, call, settle. Resolves to the generateMusic result.
async function paidCall({ track, store, env, spec, exclude, deps, what }) {
  const plan = musicPlan(env, { exclude, ledger: deps.ledger });
  if (!plan.length) throw new MusicStageError('not_configured', 'no music engine is configured (or all are over their daily budget)');
  const reserve = reserveUsd(plan, spec.length);
  const charge = await store.charge(track.id, reserve);
  if (!charge.charged) throw new MusicCapReached(charge.spentUsd, charge.capUsd);
  let out;
  try {
    out = await generateMusic({ env, spec, plan, fetchImpl: deps.fetchImpl, sleep: deps.sleep, log: deps.log, ledger: deps.ledger, requestId: track.request_id || null });
  } catch (e) {
    out = { ok: false, kind: 'engine', failures: [], detail: e && e.message };
  }
  if (!out.ok) {
    await store.refund(track.id, reserve).catch(() => {});
    deps.say(`${what}: ${out.kind} (${String(out.detail || '').slice(0, 200)})`);
    throw new MusicStageError(out.kind, out.detail);
  }
  if (reserve - out.costUsd > 0.004) await store.refund(track.id, reserve - out.costUsd).catch(() => {});
  deps.say(`${what}: made by ${out.provider} (${out.model})${out.fallbacks ? ` after ${out.failures.map((f) => f.provider).join(', ')} failed` : ''}`);
  return out;
}

async function duration(file, deps) {
  try { return await deps.probeDuration(file); } catch (e) { return null; }
}

// --- preview ---------------------------------------------------------------------------

export async function runPreviews({ track, store, env = {}, workdir, deps }) {
  const version = track.version || 1;
  await store.updateAssets(track.id, { status: 'superseded' }, { kinds: ['preview'] }).catch(() => {});
  const takes = [];
  let lastError = null;
  for (let variant = 1; variant <= PREVIEW_COUNT; variant++) {
    await store.updateTrack(track.id, { progress: { label: `Making preview ${variant} of ${PREVIEW_COUNT}`, done: variant - 1, total: PREVIEW_COUNT } }).catch(() => {});
    let out;
    try {
      out = await paidCall({ track, store, env, spec: trackSpec(track, { variant, length: 'short' }), exclude: [...PREVIEW_EXCLUDE], deps, what: `preview ${variant}` });
    } catch (e) {
      // The cap or a refusal stops the stage; an engine failure on one take
      // still lets the other through.
      if (e instanceof MusicCapReached || (e instanceof MusicStageError && (e.kind === 'refused' || e.kind === 'not_configured'))) throw e;
      lastError = e;
      continue;
    }
    const file = path.join(workdir, `preview-${variant}.${out.ext}`);
    await writeFile(file, out.bytes);
    const storage = await store.upload(musicPath(track.id, 'preview', `v${version}-take${variant}.${out.ext}`), out.bytes, out.mime);
    const asset = await store.insertAsset({
      track_id: track.id, version, kind: 'preview', variant, storage_path: storage, mime_type: out.mime, duration_s: await duration(file, deps),
      cost_usd: out.costUsd, provider: out.provider, model: out.model, licence_note: out.licenceNote, prompt: track.prompt,
      meta: { instrumentalOnly: !!out.instrumentalOnly, lyrics: out.lyricsText ? out.lyricsText.slice(0, 2000) : null }
    });
    takes.push({ variant, asset });
  }
  if (!takes.length) throw lastError || new MusicStageError('engine', 'no preview was made');
  // One "use take N" approval per preview.
  const finalUsd = estimateMusic(env, 'final', trackSpec(track).length);
  const fresh = await store.getTrack(track.id);
  const choices = [];
  for (const { variant, asset } of takes) {
    const text = [
      `${MUSIC_LABEL}: use take ${variant} of "${track.title}" (${shortTrackId(track.id)}) for the final render.`,
      `${specText(trackSpec(track))}.`,
      `Final render: about ${usd(finalUsd)} USD. Spent so far ${usd(fresh.spent_usd)} of a ${usd(fresh.cap_usd)} USD cap.`,
      takes.length > 1 ? 'Approving this take declines the other.' : 'The other take could not be made.'
    ].join('\n');
    const p = await store.createPendingAction({ actionType: MUSIC_ACTIONS.final, plan: { trackId: track.id, variant, version, assetId: asset && asset.id, estimateUsd: finalUsd }, diffSummary: text });
    choices.push({ variant, token: p.token, asset_id: asset ? asset.id : null });
  }
  return { choices, takes: takes.length };
}

// --- final -----------------------------------------------------------------------------

export async function runFinal({ track, store, env = {}, workdir, deps }) {
  const version = track.version || 1;
  const spec = trackSpec(track, { variant: track.chosen_variant || 1 });
  await store.updateTrack(track.id, { progress: { label: 'Rendering the final track', done: 0, total: 1 } }).catch(() => {});
  const out = await paidCall({ track, store, env, spec, exclude: [], deps, what: 'final render' });
  const ext = out.ext || extOf(out.mime);
  const file = path.join(workdir, `master.${ext}`);
  await writeFile(file, out.bytes);
  const storage = await store.upload(musicPath(track.id, 'master', `v${version}-master.${ext}`), out.bytes, out.mime);
  const durationS = await duration(file, deps);
  await store.updateAssets(track.id, { status: 'superseded' }, { kinds: ['master', 'stems_zip'] }).catch(() => {});
  await store.insertAsset({
    track_id: track.id, version, kind: 'master', variant: track.chosen_variant || null, storage_path: storage, mime_type: out.mime, duration_s: durationS,
    cost_usd: out.costUsd, provider: out.provider, model: out.model, licence_note: out.licenceNote, prompt: track.prompt,
    meta: { instrumentalOnly: !!out.instrumentalOnly }
  });
  return {
    provider: out.provider, model: out.model, licence_note: out.licenceNote, master_path: storage, master_mime: out.mime,
    duration_s: durationS, lyrics_text: out.lyricsText ? out.lyricsText.slice(0, 4000) : null, stems_path: null, bpm: null, musical_key: null
  };
}

// --- export ----------------------------------------------------------------------------

export async function runExportStage({ track, store, workdir, deps }) {
  await store.updateTrack(track.id, { progress: { label: 'Separating stems and writing MIDI', done: 0, total: 1 } }).catch(() => {});
  const r = await runExport({ track, store, workdir, run: deps.run || runCommand });
  await store.insertAsset({
    track_id: track.id, version: track.version || 1, kind: 'stems_zip', storage_path: r.path, mime_type: 'application/zip',
    provider: track.provider, model: track.model, licence_note: track.licence_note, prompt: track.prompt,
    meta: { name: r.name, files: r.files, bpm: r.bpm, key: r.key, bytes: r.bytes.length }
  });
  return { stems_path: r.path, bpm: r.bpm, musical_key: r.key };
}
