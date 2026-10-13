// PG1 Sound render stages, run by scripts/music-render.mjs on GitHub
// Actions:
//
//   preview  two low-cost takes, 30 s each: the Lyria 30-second clip model
//            on the paid Gemini key; if it fails, the music tier without
//            ElevenLabs (Lyria, then Replicate) trimmed to 30 s; stored
//            in the media library, each with its own MUSIC_FINAL approval
//            ("use take N"); the track waits in awaiting_choice
//   final    the approved take's direction rendered at the asked length:
//            --length short on the clip model the same way (falling back to
//            the full tier, trimmed to 30 s), full on the full music tier
//            (ElevenLabs when set, Lyria, Replicate);
//            the master is stored with its provider, model and licence note
//   export   stems, MIDI, WAV master and README as one zip (lib/music/export.mjs)
//
// Spend. Before each engine call the track is charged the dearest engine in
// the plan (pg1_music_charge: only if it still fits under the cap); after
// it, the difference to the engine that made it is given back, and a call
// that failed is given back whole (the engines bill finished tracks only).
// A clip call is reserved, settled and logged at the clip price
// (music_lyria_clip); its fallback is a separate call with its own
// reservation.
//
// Storage limit. Every upload is checked against PG1_STORAGE_MAX_MB first
// (lib/music/export.mjs guardedUpload). A preview or master over it stops
// the stage with "file too large for storage limit", and its charge is given
// back like any call that produced nothing usable.

import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { generateMusic, musicPlan, musicClipPlan, musicCallUsd, LYRIA_CLIP_S } from './engines.mjs';
import { musicPath } from './store.mjs';
import { runExport, runCommand, trimAudio, guardedUpload, storageMaxBytes, StorageLimitError } from './export.mjs';
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
  return plan.reduce((m, c) => Math.max(m, musicCallUsd(c.provider, length, { clip: !!c.clip })), 0);
}

// What a stage is expected to cost on this deployment's engines: the clip
// model's price when it makes the stage (previews, short finals).
export function estimateMusic(env, stage, length = 'short') {
  const clip = musicClipPlan(env);
  if (stage === 'preview') return Math.round(PREVIEW_COUNT * reserveUsd(clip.length ? clip : musicPlan(env, { exclude: [...PREVIEW_EXCLUDE] }), 'short') * 100) / 100;
  if (stage === 'final') return Math.round(reserveUsd(length !== 'full' && clip.length ? clip : musicPlan(env), length) * 100) / 100;
  return 0;
}

function extOf(p) {
  return String(p || '').split('?')[0].split('.').pop().toLowerCase();
}

// One paid call: reserve, call, settle. Resolves to the generateMusic result.
async function paidCall({ track, store, env, spec, exclude, deps, what, plan: given = null }) {
  const plan = given || musicPlan(env, { exclude, ledger: deps.ledger });
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

// A 30-second track (a preview, or --length short): the clip model first;
// if it fails (anything but a refusal or the cap), the tier as before, and
// that track is marked to be trimmed to 30 s (out.trimTo).
async function clipCall({ track, store, env, spec, exclude, deps, what }) {
  const plan = musicClipPlan(env, { ledger: deps.ledger });
  if (plan.length) {
    try {
      return await paidCall({ track, store, env, spec, exclude, deps, what: `${what} (clip)`, plan });
    } catch (e) {
      if (e instanceof MusicCapReached || (e instanceof MusicStageError && e.kind === 'refused')) throw e;
      deps.say(`${what}: the clip model failed (${e.kind || 'error'}); using the music tier, trimmed to ${LYRIA_CLIP_S} s`);
    }
  }
  const out = await paidCall({ track, store, env, spec, exclude, deps, what });
  return { ...out, trimTo: LYRIA_CLIP_S };
}

// Writes the made track to `file`, trimmed to out.trimTo seconds when it is
// longer (ffmpeg). Resolves to { out, file, trimmedFromS }: out.bytes is
// what is uploaded. A trim that fails keeps the track as made.
async function writeTrack(out, file, deps) {
  await writeFile(file, out.bytes);
  if (!out.trimTo) return { out, file, trimmedFromS: null };
  const made = await duration(file, deps);
  if (!(made > out.trimTo + 0.5)) return { out, file, trimmedFromS: null };
  const trimmed = file.replace(/(\.[a-z0-9]+)$/i, `-${out.trimTo}s$1`);
  try {
    await trimAudio(file, trimmed, out.trimTo, { run: deps.run || runCommand });
    return { out: { ...out, bytes: await readFile(trimmed) }, file: trimmed, trimmedFromS: made };
  } catch (e) {
    deps.say(`trim to ${out.trimTo} s failed: ${String(e && e.message).slice(0, 200)}`);
    return { out, file, trimmedFromS: null };
  }
}

// A made track's upload, under the storage limit. Over it, the call's charge
// is given back and the stage stops (StorageLimitError).
async function uploadOrRefund({ track, store, env, out, storagePath }) {
  try {
    return await guardedUpload(store, storagePath, out.bytes, out.mime, storageMaxBytes(env));
  } catch (e) {
    if (e instanceof StorageLimitError) await store.refund(track.id, out.costUsd).catch(() => {});
    throw e;
  }
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
    let made;
    try {
      made = await clipCall({ track, store, env, spec: trackSpec(track, { variant, length: 'short' }), exclude: [...PREVIEW_EXCLUDE], deps, what: `preview ${variant}` });
    } catch (e) {
      // The cap or a refusal stops the stage; an engine failure on one take
      // still lets the other through.
      if (e instanceof MusicCapReached || (e instanceof MusicStageError && (e.kind === 'refused' || e.kind === 'not_configured'))) throw e;
      lastError = e;
      continue;
    }
    const { out, file, trimmedFromS } = await writeTrack(made, path.join(workdir, `preview-${variant}.${made.ext}`), deps);
    const storage = await uploadOrRefund({ track, store, env, out, storagePath: musicPath(track.id, 'preview', `v${version}-take${variant}.${out.ext}`) });
    const asset = await store.insertAsset({
      track_id: track.id, version, kind: 'preview', variant, storage_path: storage, mime_type: out.mime, duration_s: await duration(file, deps),
      cost_usd: out.costUsd, provider: out.provider, model: out.model, licence_note: out.licenceNote, prompt: track.prompt,
      meta: { instrumentalOnly: !!out.instrumentalOnly, lyrics: out.lyricsText ? out.lyricsText.slice(0, 2000) : null, ...(trimmedFromS ? { trimmedFromS } : {}) }
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
  const made = spec.length === 'full'
    ? await paidCall({ track, store, env, spec, exclude: [], deps, what: 'final render' })
    : await clipCall({ track, store, env, spec, exclude: [], deps, what: 'final render' });
  const ext = made.ext || extOf(made.mime);
  const { out, file, trimmedFromS } = await writeTrack(made, path.join(workdir, `master.${ext}`), deps);
  const storage = await uploadOrRefund({ track, store, env, out, storagePath: musicPath(track.id, 'master', `v${version}-master.${ext}`) });
  const durationS = await duration(file, deps);
  await store.updateAssets(track.id, { status: 'superseded' }, { kinds: ['master', 'stems_zip'] }).catch(() => {});
  await store.insertAsset({
    track_id: track.id, version, kind: 'master', variant: track.chosen_variant || null, storage_path: storage, mime_type: out.mime, duration_s: durationS,
    cost_usd: out.costUsd, provider: out.provider, model: out.model, licence_note: out.licenceNote, prompt: track.prompt,
    meta: { instrumentalOnly: !!out.instrumentalOnly, ...(trimmedFromS ? { trimmedFromS } : {}) }
  });
  return {
    provider: out.provider, model: out.model, licence_note: out.licenceNote, master_path: storage, master_mime: out.mime,
    duration_s: durationS, lyrics_text: out.lyricsText ? out.lyricsText.slice(0, 4000) : null, stems_path: null, bpm: null, musical_key: null
  };
}

// --- export ----------------------------------------------------------------------------

// The export's files are pg1_music_assets rows of kind 'stems_zip' (the kind
// the applied migration allows), one per file, told apart by meta.part:
// 'master' | 'drums' | 'bass' | 'vocals' | 'other' | 'midi' | 'readme' | 'zip'.
export const EXPORT_PARTS = Object.freeze(['master', 'drums', 'bass', 'vocals', 'other', 'midi', 'readme', 'zip']);

export async function runExportStage({ track, store, env = {}, workdir, deps }) {
  await store.updateTrack(track.id, { progress: { label: 'Separating stems and writing MIDI', done: 0, total: 1 } }).catch(() => {});
  const version = track.version || 1;
  // A re-run replaces an earlier export of this version.
  await store.updateAssets(track.id, { status: 'superseded' }, { kinds: ['stems_zip'] }).catch(() => {});
  const r = await runExport({ track, store, workdir, maxBytes: storageMaxBytes(env), run: deps.run || runCommand });
  const common = { track_id: track.id, version, kind: 'stems_zip', provider: track.provider, model: track.model, licence_note: track.licence_note, prompt: track.prompt };
  for (const p of r.parts) {
    await store.insertAsset({ ...common, storage_path: p.path, mime_type: p.mime, meta: { part: p.part, ...(p.stem ? { stem: p.stem } : {}), name: p.download, bytes: p.size, bpm: r.bpm, key: r.key } });
  }
  if (r.zip) {
    await store.insertAsset({ ...common, storage_path: r.zip.path, mime_type: 'application/zip', meta: { part: 'zip', name: r.zip.name, bytes: r.zip.size, files: r.parts.map((p) => p.download), bpm: r.bpm, key: r.key } });
  } else {
    deps.say(`export: the zip (${Math.round(r.zipSkipped.size / 1024 / 1024)} MB) is over the storage limit; the separate files are the export`);
  }
  return { stems_path: r.zip ? r.zip.path : null, bpm: r.bpm, musical_key: r.key };
}
