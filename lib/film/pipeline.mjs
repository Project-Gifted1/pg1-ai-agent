// PG1 Studio pipeline: the work the render worker does for one film
// (scripts/film-render.mjs). Three stages, each started by an approval:
//
//   storyboard  the request -> a checked timeline, its cost estimate, and a
//               FILM_PREVIEW proposal (approve to spend on the preview)
//   preview     reference still, a still per shot, voiceover, music, then a
//               low-res animatic (stills with their camera moves) to watch,
//               and a FILM_FULL proposal with the full render's estimate
//   full        an image-to-video clip per shot (continuous shots start from
//               the previous clip's last frame), each checked and
//               regenerated up to twice, then the edit, grade, captions,
//               mix and loudness, then a transcript check of the voiceover
//
// Attached images (lib/film/attachments.mjs). The storyboard step is given
// the film's attached images and may place one as a shot (shot.asset); one
// the request said to use as it is always gets a shot. Such a shot is never
// sent to an image or video engine, in the preview or the full render:
// ffmpeg places the original image (segmentFromImage), and instead of the
// generated-shot check and its retries, its rendered frames are compared
// with the image (matchImageSegment). It is never regenerated.
//
// Every generated asset is stored with its fingerprint
// (lib/film/timeline.mjs), so a stage only makes what is not stored yet:
// after an approved edit, a re-render regenerates only what the edit
// changed. Every paid call is charged against the film's cap first
// (store.charge); when the cap is reached the stage stops with what it has.
// A call the engine refused (throttled to the end, out of credit: it ran
// nothing and was billed nothing) is given back (store.refund), and so is
// the unused part of a clip's reservation.
//
// Engine trouble (lib/film/providers.mjs createFilmMedia, through the AI
// router). Every media call gets the stage's state (ctx.media): a 429 is
// waited out and the same request sent again on the same engine (it never
// uses up one of a shot's QC retries), and from the first one the stage
// renders one clip at a time; once the media engine is out of credit or
// still throttled, the rest of the stage goes to the paid Gemini key, with
// the reference still and the previous shot's last frame for continuity.
// Each asset records which engine made it (PG1 labels), as does the QC
// report. A stage that stops on engine trouble throws an error with
// `step` set; the worker records it (failure) for the film card and for
// /film retry, which restarts the stage and reuses everything stored,
// including the best clip of a shot that was still being retried
// (kept as a 'rejected' candidate with its attempts).
//
// Voice and music never stop a film on their own (lib/film/providers.mjs
// createFilmVoice, createFilmMedia music). A voiceover line Cartesia times
// out on is sent once more, then made by ElevenLabs, which keeps the rest
// of the stage; the lines Cartesia made before the switch are recorded
// again on ElevenLabs, so the film has one narrator. A music bed the music
// engines cannot make (rate limited, out of quota, down, declined) is left
// out: its reservation is given back, the scenes after it are not tried
// again once the engine is throttled or out of quota, and the film finishes
// without that music, with "music unavailable" in its QC report and card.
// The bed is made on the next render, since nothing was stored for it.
//
// Dependencies are injected so the tests run without network or ffmpeg:
//   store    lib/film/store.mjs createFilmStore(...)
//   engines  { still, clip, music, voice, think, transcribe } (see
//            scripts/film-render.mjs for the real ones)
//   ff       lib/film/ffmpeg.mjs (or a stand-in)

import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { flatShots, normaliseTimeline, storyboardSystem, storyboardUserPrompt, extractJsonObject, timelineSummary, isAssetShot, placeAttachments } from './storyboard.mjs';
import { listFilmAttachments, YOUR_IMAGE_LABEL, yourImageLabel } from './attachments.mjs';
import { assetFingerprints, clipSecondsFor, clipFingerprints, hash } from './timeline.mjs';
import { estimateStage, estimateText, FILM_PRICES, MAX_SHOT_RETRIES, clipCostOnUsd, clipReserveUsd, voiceCostUsd, musicCostUsd } from './cost.mjs';
import { planCuts } from './cuts.mjs';
import { QC_SYSTEM, DAILIES_SYSTEM, STILL_CHECK_SYSTEM, intentText, qcFrameTimes, qcPromptText, parseQcVerdict, retryPrompt, checkTranscript, MAX_LINE_RETRIES } from './qc.mjs';
import { filmPath } from './store.mjs';
import { FILM_ACTIONS, FILM_LABEL, shortFilmId } from './text.mjs';
import { ENGINE_LABELS } from '../aiRouter.mjs';
import { PRICE_MULTIPLIER } from '../capabilities/registry.mjs';
import { filmMusicPlan, musicCallUsd } from '../music/engines.mjs';
import { filmMusicExclude } from './providers.mjs';

export class CapReached extends Error {
  constructor(spentUsd, capUsd) {
    super('cap reached');
    this.code = 'cap_reached';
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
  }
}

const CAMERA_WORDS = {
  static: 'locked-off static camera', push_in: 'slow push in', pull_out: 'slow pull out', pan_left: 'smooth pan left', pan_right: 'smooth pan right',
  tilt_up: 'slow tilt up', tilt_down: 'slow tilt down', tracking: 'tracking shot following the subject', orbit: 'slow orbit around the subject',
  drone_flyover: 'aerial drone flyover', handheld: 'subtle handheld camera', crane_up: 'crane up revealing the scene', dolly_zoom: 'dolly zoom'
};

export function clipPrompt(timeline, shot) {
  return `${shot.visual_prompt}\nCamera: ${CAMERA_WORDS[shot.camera] || shot.camera}. Look: ${timeline.style.look}. One continuous shot, cinematic, no text on screen.`;
}

export function stillPrompt(timeline, shot) {
  const cast = timeline.characters.filter((c) => shot.characters.includes(c.id)).map((c) => `${c.name ? `${c.name}: ` : ''}${c.description}`);
  return `${shot.visual_prompt}\n${cast.length ? `Characters, exactly as in the reference image: ${cast.join(' | ')}\n` : ''}Same visual style and palette as the reference image. ${timeline.style.look}. Cinematic 16:9 film still, no text, no lettering.`;
}

export function referencePrompt(timeline) {
  const cast = timeline.characters.map((c) => `${c.name ? `${c.name}: ` : ''}${c.description}`).join(' | ');
  return `${timeline.style.reference_prompt || 'Character and style reference sheet for a short film.'}\n${cast ? `Characters side by side, full body, clearly visible: ${cast}\n` : ''}${timeline.style.look}. Neutral background, even lighting, 16:9, no text, no lettering.`;
}

// --- engine trouble -----------------------------------------------------------------

// Media failures that stop the stage instead of using up a shot's retries:
// throttled to the end or out of credit (after the fallback, when there is
// one), no engine configured, or a daily budget reached.
const STAGE_STOPS = new Set(['throttled', 'billing', 'not_configured', 'budget']);

export function isStageStop(e) {
  return !!(e && typeof e === 'object' && (STAGE_STOPS.has(e.kind) || e.exhausted));
}

// A media engine's answer: { bytes, engine, ...} from the real engines; a
// stand-in may return the bytes alone (the primary media engine's).
function mediaOut(out) {
  if (Buffer.isBuffer(out) || out instanceof Uint8Array) return { bytes: Buffer.from(out), engine: 'replicate' };
  return { ...out, engine: (out && out.engine) || 'replicate' };
}

export const engineLabel = (engine) => ENGINE_LABELS[engine] || ENGINE_LABELS.replicate;

// Voiceover engines by PG1 label (ElevenLabs is otherwise labelled for
// music). Lines stored by #323's fallback carry the old ElevenLabs label.
export const VOICE_LABELS = Object.freeze({ cartesia: ENGINE_LABELS.cartesia, elevenlabs: 'PG1 Studio voice' });
const LEGACY_VOICE_LABELS = Object.freeze({ 'PG1 backup voice engine': 'elevenlabs' });
export const voiceLabel = (engine) => VOICE_LABELS[engine] || VOICE_LABELS.cartesia;
export const voiceEngineOf = (asset) => {
  const l = asset && asset.meta && asset.meta.engine;
  if (l === VOICE_LABELS.elevenlabs || LEGACY_VOICE_LABELS[l] === 'elevenlabs') return 'elevenlabs';
  return 'cartesia';
};
// A media asset's engine (ledger name) from its PG1 label.
const MEDIA_ENGINE_BY_LABEL = Object.freeze(Object.fromEntries(Object.entries(ENGINE_LABELS).map(([k, v]) => [v, k])));
export const mediaEngineOf = (asset) => (asset && asset.meta && MEDIA_ENGINE_BY_LABEL[asset.meta.engine]) || null;
// The engine most of these stored assets were made by, or null.
function storedEngine(assets, of) {
  const n = {};
  for (const a of assets) { const e = of(a); if (e) n[e] = (n[e] || 0) + 1; }
  const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// Music failures after which the scenes left are not tried again this stage.
const MUSIC_STAGE_STOPS = new Set(['throttled', 'billing', 'not_configured', 'budget']);
export const MUSIC_UNAVAILABLE_NOTE = 'Music unavailable: the music engine could not make it this time, so the film has no music bed there. It will be made on the next render.';

// A still whose job ran and failed (a refusal and engine trouble that stops
// the stage aside) is made once more: Replicate fetching the reference
// still from storage can time out on one try (PG1 Studio render run 17).
async function stillWithRetry(ctx, step, what, make) {
  try {
    return await ctx.call(step, FILM_PRICES.stillUsd, make);
  } catch (e) {
    if (e instanceof CapReached || isStageStop(e) || (e && e.refused)) throw e;
    ctx.report('film_still_retry', `${what}: ${e && e.detail ? e.detail : e && e.message}`);
    ctx.say(`${what}: the still failed (${e && e.message}); making it once more`);
    await ctx.paid(FILM_PRICES.stillUsd, `${what} (second try)`);
    return ctx.call(step, FILM_PRICES.stillUsd, make);
  }
}

// --- one film's working context -------------------------------------------------

// director: Director Mode's options for runRender (lib/film/director.mjs):
//   { dailies: true (the dailies rubric), stillCritic: true, sfx: true,
//     credits: { lines, logoFile, logoS, crawlS } | null, deliverables: true }
function createContext({ project, store, engines, ff, workdir, env = {}, log = () => {}, onFailure = () => {}, now = () => Date.now(), media = null, director = null }) {
  const ctx = {
    project, store, engines, ff, workdir, env, log, onFailure, now, director,
    stillChecks: [], sfxMissing: [],
    timeline: project.timeline,
    assets: [],
    candidates: [],
    generated: { reference: 0, keyframes: 0, clips: 0, voice: 0, music: 0, retries: 0 },
    reused: { reference: 0, keyframes: 0, clips: 0, voice: 0, music: 0, candidates: 0 },
    engines_used: {},
    // The stage's media state (lib/film/providers.mjs newMediaStage).
    media: media || { engine: null, throttled: false, throttles: 0, switched: null, kinds: {} },
    // The stage's voice state (lib/film/providers.mjs newVoiceStage).
    voiceStage: { engine: null, retries: 0, switched: null },
    // Scenes left without music this stage: { scene, reason }.
    musicMissing: [],
    musicStopped: null,
    lastProgress: 0
  };
  ctx.made = (engine) => { const l = engineLabel(engine); ctx.engines_used[l] = (ctx.engines_used[l] || 0) + 1; return l; };
  ctx.say = (line) => { try { log(`[film ${shortFilmId(project.id)}] ${line}`); } catch (e) { /* never breaks the render */ } };
  ctx.report = (reason, detail) => { try { onFailure({ reason, detail: String(detail || ''), requestId: project.request_id || null }); } catch (e) { /* ditto */ } };
  // A priced client film also keeps the 1.5x floor (A5): spend may not pass
  // price / 1.5, whichever engine the chain falls to.
  ctx.spent = Number(project.spent_usd) || 0;
  ctx.floorUsd = Number(project.price_usd) > 0 ? Math.floor(Number(project.price_usd) / PRICE_MULTIPLIER * 100) / 100 : null;
  ctx.paid = async (usd, what) => {
    if (!(usd > 0)) return;
    if (ctx.floorUsd != null && ctx.spent + usd > ctx.floorUsd + 1e-9) {
      ctx.say(`price floor reached before ${what}: ${usd} more would pass ${ctx.floorUsd} (the package price / ${PRICE_MULTIPLIER})`);
      throw Object.assign(new CapReached(ctx.spent, ctx.floorUsd), { floor: true, step: what });
    }
    const r = await store.charge(project.id, usd);
    if (!r.charged) {
      ctx.say(`cap reached before ${what} (spent ${r.spentUsd} of ${r.capUsd})`);
      throw new CapReached(r.spentUsd, r.capUsd);
    }
    ctx.spent = Number(r.spentUsd) || ctx.spent + usd;
  };
  ctx.refund = async (usd, what) => {
    if (!(usd > 0.004) || typeof store.refund !== 'function') return;
    try { await store.refund(project.id, usd); ctx.spent = Math.max(0, ctx.spent - usd); } catch (e) { ctx.say(`could not give back ${usd} for ${what}: ${e.message}`); }
  };
  // One media call that cost `usd`: a call the engine refused is given back,
  // and the error is labelled with the step it stopped (for the film card).
  ctx.call = async (step, usd, fn) => {
    try {
      return mediaOut(await fn());
    } catch (e) {
      if (e && typeof e === 'object') {
        if (!e.step) e.step = step;
        if (e.notStarted && !e.refunded) { e.refunded = true; await ctx.refund(usd, step); }
      }
      throw e;
    }
  };
  // Once the stage is throttled, one media call at a time: a call waits
  // here while another is in flight (calls already running finish first).
  let inFlight = 0;
  const waiting = [];
  ctx.oneAtATime = async (fn) => {
    while (ctx.media.throttled && inFlight > 0) await new Promise((r) => waiting.push(r));
    inFlight++;
    try {
      return await fn();
    } finally {
      inFlight--;
      const next = waiting.shift();
      if (next) next();
    }
  };
  ctx.progress = async (label, done, total, force = false) => {
    if (!force && now() - ctx.lastProgress < 4000) return;
    ctx.lastProgress = now();
    await store.updateProject(project.id, { progress: { label, done, total } }).catch(() => {});
  };
  ctx.file = (name) => path.join(workdir, name);
  ctx.find = (kind, fingerprint) => ctx.assets.find((a) => a.kind === kind && a.fingerprint === fingerprint && a.status === 'ok');
  // A stored asset's bytes in the working folder.
  ctx.local = async (asset, name) => {
    const f = ctx.file(name);
    await writeFile(f, await store.download(asset.storage_path));
    return f;
  };
  ctx.save = async ({ kind, bytes, ext, mime, fingerprint, shotRef = null, prompt = null, description = null, durationS = null, meta = null, attempt = 1, status = 'ok', costUsd = 0, thumbFrom = null, thumbAtS = 0 }) => {
    const base = `${shotRef ? shotRef.shot.id : kind}-${fingerprint || 'x'}-a${attempt}`;
    const storage = await store.upload(filmPath(project.id, kind, `${base}.${ext}`), bytes, mime);
    let thumb = null;
    if (thumbFrom) {
      try {
        const tf = ctx.file(`${base}-thumb.jpg`);
        await ff.thumbnail(thumbFrom, thumbAtS, tf);
        thumb = await store.upload(filmPath(project.id, 'thumbs', `${base}.jpg`), await readFile(tf), 'image/jpeg');
      } catch (e) { ctx.say(`thumbnail skipped: ${e.message}`); }
    }
    const row = await store.insertAsset({
      project_id: project.id, kind, scene: shotRef ? shotRef.sceneIndex : null, shot: shotRef ? shotRef.shotIndex : null,
      shot_id: shotRef ? shotRef.shot.id : null, timeline_version: project.timeline_version, fingerprint, attempt, status,
      prompt, description, storage_path: storage, thumb_path: thumb, mime_type: mime, duration_s: durationS, cost_usd: costUsd, meta
    });
    const asset = row || { kind, fingerprint, status, storage_path: storage, meta, duration_s: durationS };
    ctx.assets.push(asset);
    return asset;
  };
  return ctx;
}

// --- storyboard -------------------------------------------------------------------

// opts.attachments: the film's attached images (lib/film/attachments.mjs
// listFilmAttachments, which scripts/film-render.mjs passes); read from the
// film's assets when not given.
export async function runStoryboard(opts) {
  const { project, store, engines } = opts;
  const ctx = createContext(opts);
  const attachments = Array.isArray(opts.attachments) ? opts.attachments : await listFilmAttachments(store, project.id);
  await ctx.paid(FILM_PRICES.storyboardUsd, 'the storyboard');
  // The storyboard must pass the same checks whichever engine writes it.
  // The real engines (filmThink) validate each reply, ask the same engine
  // once more on a bad one, then fall back to the next engine, and return
  // the checked timeline as `value`; an engine without that (a stand-in)
  // gets the same one retry here.
  let warnings = [];
  const validate = (text) => {
    const w = [];
    // The attached images are always the film's own, never the reply's.
    const t = normaliseTimeline({ ...extractJsonObject(text), tier: project.tier, attachments }, { warnings: w });
    warnings = w;
    return t;
  };
  let timeline = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2 && !timeline; attempt++) {
    try {
      const r = await engines.think({ system: storyboardSystem({ attachments }), content: storyboardUserPrompt(project.request, { tier: project.tier, attachments }) + (lastErr ? `\n\nYour last reply could not be used (${lastErr}). Reply with the JSON object only.` : ''), effort: 'medium', maxTokens: 16000, validate, purpose: 'storyboard' });
      if (r && r.value !== undefined) {
        timeline = r.value;
        ctx.say(`storyboard written by ${r.provider || 'the reasoning engine'}${r.model ? ` (${r.model})` : ''}`);
        break;
      }
      timeline = validate(r.text);
    } catch (e) {
      if (e && e.refused) throw e;
      lastErr = String(e && e.message || e).slice(0, 120);
      ctx.report('film_storyboard_failed', `attempt=${attempt} ${e && e.detail ? e.detail : lastErr}`);
      // The real engines already retried and fell back through every one.
      if (e && e.kind) break;
    }
  }
  if (!timeline) throw Object.assign(new Error('storyboard failed'), { code: 'storyboard_failed' });
  if (attachments.length) {
    // An image the request said to use as it is always gets its own shot.
    const placed = placeAttachments(timeline);
    timeline = placed.timeline;
    for (const n of placed.placed) warnings.push(`${yourImageLabel(n)} was placed as its own shot at the end`);
    const used = flatShots(timeline).filter((x) => isAssetShot(x.shot)).map((x) => `${yourImageLabel(x.shot.asset.attachment)} as shot ${x.sceneIndex}.${x.shotIndex}`);
    ctx.say(`attached images: ${used.length ? used.join(', ') : 'none placed'}`);
  }
  const preview = estimateStage(timeline, { stage: 'preview' });
  const full = estimateStage(timeline, { stage: 'full' });
  const fresh = await store.getProject(project.id);
  const spent = Number(fresh && fresh.spent_usd) || 0;
  const cap = Number(project.cap_usd);
  const proposal = await store.createPendingAction({
    actionType: FILM_ACTIONS.preview,
    plan: { projectId: project.id, timelineVersion: 1, estimateUsd: preview.expectedUsd },
    diffSummary: `${FILM_LABEL} storyboard\n${timelineSummary(timeline)}\n\nPreview (stills, voice, music, low-res):\n${estimateText(preview, { capUsd: cap, spentUsd: spent })}\nFull film afterwards: about ${full.expectedUsd.toFixed(2)} USD more.`
  });
  await store.updateProject(project.id, {
    status: 'awaiting_preview_approval', title: timeline.title, timeline, timeline_version: 1,
    est_preview_usd: preview.expectedUsd, est_full_usd: full.expectedUsd, pending_token: proposal.token,
    progress: { label: 'Storyboard ready', done: 1, total: 1, warnings }
  }, { onlyIfStatus: ['storyboarding'] });
  return { timeline, preview, full, token: proposal.token, warnings };
}

// --- the render stages ----------------------------------------------------------

async function ensureReference(ctx, fp) {
  const have = ctx.find('reference', fp.reference);
  if (have) { ctx.reused.reference++; return have; }
  await ctx.paid(FILM_PRICES.stillUsd, 'the reference still');
  const prompt = referencePrompt(ctx.timeline);
  const out = await stillWithRetry(ctx, 'reference', 'the reference still', () => ctx.engines.still({ prompt, stage: ctx.media }));
  const png = out.bytes;
  const f = ctx.file('reference.png');
  await writeFile(f, png);
  ctx.generated.reference++;
  return ctx.save({ kind: 'reference', bytes: png, ext: 'png', mime: 'image/png', fingerprint: fp.reference, prompt, description: 'Character and style reference', costUsd: FILM_PRICES.stillUsd, thumbFrom: f, meta: { engine: ctx.made(out.engine) } });
}

// prevFrameUrl: the previous shot's last frame (a link, or a function
// resolving to one), for the fallback engine's continuity.
async function ensureKeyframe(ctx, ref, fp, refUrl, { force = false, seed = null, attempt = 1, prevFrameUrl = null } = {}) {
  const key = fp.keyframes[ref.shot.id];
  if (!force) {
    const have = ctx.find('keyframe', key);
    if (have) { ctx.reused.keyframes++; return have; }
  }
  await ctx.paid(FILM_PRICES.stillUsd, `the still for shot ${ref.sceneIndex}.${ref.shotIndex}`);
  const prompt = stillPrompt(ctx.timeline, ref.shot);
  const out = await stillWithRetry(ctx, 'stills', `the still for shot ${ref.sceneIndex}.${ref.shotIndex}`, () => ctx.engines.still({ prompt, referenceUrl: refUrl, prevFrameUrl, seed, stage: ctx.media }));
  const png = out.bytes;
  const f = ctx.file(`key-${ref.shot.id}-a${attempt}.png`);
  await writeFile(f, png);
  ctx.generated.keyframes++;
  if (force) for (const a of ctx.assets) if (a.kind === 'keyframe' && a.fingerprint === key && a.status === 'ok' && a.id) { a.status = 'superseded'; await ctx.store.updateAsset(a.id, { status: 'superseded' }).catch(() => {}); }
  return ctx.save({ kind: 'keyframe', bytes: png, ext: 'png', mime: 'image/png', fingerprint: key, shotRef: ref, prompt, description: `Still: ${ref.shot.description}`, costUsd: FILM_PRICES.stillUsd, attempt, thumbFrom: f, meta: { engine: ctx.made(out.engine) } });
}

async function ensureVoice(ctx, ref, fp, { force = false, attempt = 1 } = {}) {
  const key = fp.voice[ref.shot.id];
  if (!key) return null;
  if (!force) {
    const have = ctx.find('voice', key);
    if (have) { ctx.reused.voice++; return have; }
  }
  const cost = Math.max(0.01, voiceCostUsd(ref.shot.voiceover));
  await ctx.paid(cost, `the voiceover for shot ${ref.sceneIndex}.${ref.shotIndex}`);
  let line;
  const dialogue = Array.isArray(ref.shot.dialogue) && ref.shot.dialogue.length && typeof ctx.engines.dialogue === 'function';
  try {
    line = dialogue
      ? await ctx.engines.dialogue({ lines: ref.shot.dialogue, stage: ctx.voiceStage })
      : await ctx.engines.voice({ text: ref.shot.voiceover, stage: ctx.voiceStage });
  } catch (e) {
    if (e && typeof e === 'object' && !e.step) e.step = 'voice';
    if (e && e.notStarted) await ctx.refund(cost, `the voiceover for shot ${ref.shot.id}`);
    throw e;
  }
  ctx.generated.voice++;
  const engine = (line && line.engine) || 'cartesia';
  const label = voiceLabel(engine);
  ctx.engines_used[label] = (ctx.engines_used[label] || 0) + 1;
  // A line recorded again replaces the old one, so a later render never
  // picks the old one up.
  if (force) for (const a of ctx.assets) if (a.kind === 'voice' && a.fingerprint === key && a.status === 'ok') { a.status = 'superseded'; if (a.id) await ctx.store.updateAsset(a.id, { status: 'superseded' }).catch(() => {}); }
  return ctx.save({
    kind: 'voice', bytes: line.wav, ext: 'wav', mime: 'audio/wav', fingerprint: key, shotRef: ref, prompt: ref.shot.voiceover,
    description: `${dialogue ? 'Dialogue' : 'Voiceover'} for ${ref.shot.description}: "${ref.shot.voiceover}"`, durationS: line.durationS, costUsd: cost, attempt,
    meta: { words: line.words, engine: label, ...(dialogue ? { dialogue: true } : {}) }
  });
}

async function ensureMusic(ctx, scene, sceneIndex, fp, seconds = null) {
  const key = fp.music[scene.id];
  const have = ctx.find('music', key);
  if (have) { ctx.reused.music++; return have; }
  // The music engine is throttled or out of quota this stage: no new call.
  if (ctx.musicStopped) { ctx.musicMissing.push({ scene: sceneIndex, reason: ctx.musicStopped }); return null; }
  // The film's music engines differ in price: reserve the dearest one this
  // worker could use, and give back the difference to the one that made it.
  const reserve = Math.max(musicCostUsd(), ...filmMusicPlan(ctx.env, { exclude: filmMusicExclude(ctx.env) }).map((c) => musicCallUsd(c.provider, 'short', { clip: !!c.clip })));
  await ctx.paid(reserve, `the music for scene ${sceneIndex}`);
  let bed;
  try {
    bed = await ctx.call('music', reserve, () => ctx.engines.music({ mood: scene.music.mood, bpm: scene.music.bpm, seconds, stage: ctx.media }));
  } catch (e) {
    if (e instanceof CapReached) throw e;
    // No bed came back: nothing to pay for (ctx.call already gave back a
    // call that never started).
    if (!e || !e.refunded) await ctx.refund(reserve, `the music for scene ${sceneIndex}`);
    const reason = (e && (e.refused ? 'refused' : e.kind)) || 'engine';
    if (MUSIC_STAGE_STOPS.has(reason)) ctx.musicStopped = reason;
    ctx.musicMissing.push({ scene: sceneIndex, reason });
    ctx.report('film_music_unavailable', `scene=${sceneIndex} ${e && e.detail ? e.detail : e && e.message}`);
    ctx.say(`music for scene ${sceneIndex} unavailable (${reason}); the film carries on without it`);
    return null;
  }
  const costUsd = Number.isFinite(bed.costUsd) ? bed.costUsd : musicCostUsd();
  await ctx.refund(reserve - costUsd, `the music for scene ${sceneIndex}`);
  ctx.generated.music++;
  // The bed's own length, so the mix fades it out where it ends (never a loop).
  let durationS = null;
  try {
    const f = ctx.file(`bed-${scene.id}.${bed.ext}`);
    await writeFile(f, bed.bytes);
    durationS = Number(await ctx.ff.probeDuration(f)) || null;
  } catch (e) { durationS = null; }
  return ctx.save({
    kind: 'music', bytes: bed.bytes, ext: bed.ext, mime: bed.mime, fingerprint: key, prompt: scene.music.mood, durationS,
    description: `Music for scene ${sceneIndex}${scene.title ? ` (${scene.title})` : ''}: ${scene.music.mood}, ${scene.music.bpm} bpm`, costUsd,
    meta: { scene: sceneIndex, sceneId: scene.id, bpm: scene.music.bpm, seconds, engine: ctx.made(bed.engine) }
  });
}

async function checkClip(ctx, ref, clipFile, clipS, refFile, prevFrameFile) {
  const frames = [];
  for (const [i, t] of qcFrameTimes(clipS).entries()) frames.push({ t, file: await ctx.ff.extractFrame(clipFile, t, ctx.file(`qc-${ref.shot.id}-${i}.jpg`)) });
  const content = [{ type: 'text', text: 'Reference still:' }, ctx.engines.image(await readFile(refFile))];
  if (prevFrameFile) content.push({ type: 'text', text: 'Last frame of the previous shot:' }, ctx.engines.image(await readFile(prevFrameFile)));
  for (const fr of frames) content.push({ type: 'text', text: `Frame at ${fr.t} s:` }, ctx.engines.image(await readFile(fr.file)));
  const characters = ctx.timeline.characters.filter((c) => ref.shot.characters.includes(c.id));
  content.push({ type: 'text', text: qcPromptText({ shot: ref.shot, sceneIndex: ref.sceneIndex, shotIndex: ref.shotIndex, durationS: ref.shot.duration_s, clipS, continuous: ref.shot.continuous, characters }) });
  try {
    const opts = { clipS, durationS: ref.shot.duration_s };
    // An unreadable verdict is asked for again (then from the next engine)
    // by engines that validate; otherwise it counts as a pass with a note.
    const validate = (text) => {
      const v = parseQcVerdict(text, opts);
      if (v.unreadable) throw new Error('no JSON verdict in the reply');
      return v;
    };
    const daily = !!(ctx.director && ctx.director.dailies);
    const r = await ctx.engines.think({ system: daily ? DAILIES_SYSTEM : QC_SYSTEM, content, effort: daily ? 'medium' : 'low', maxTokens: 4000, validate, purpose: `${daily ? 'dailies' : 'shot check'} ${ref.shot.id}` });
    return r && r.value !== undefined ? r.value : parseQcVerdict(r.text, opts);
  } catch (e) {
    ctx.report('film_qc_failed', `shot=${ref.shot.id} ${e && e.detail ? e.detail : e && e.message}`);
    return { pass: true, score: null, issues: [{ type: 'other', detail: 'the check could not run' }], bestStartS: 0, description: '', unreadable: true };
  }
}

// One shot's clip, checked, with up to MAX_SHOT_RETRIES regenerations.
// Resolves to { asset, file, durationS, verdict, attempts, engine }.
//
// Only an attempt that made a clip, or failed in a way a retry may fix,
// counts against the retries: a throttled request is waited out inside the
// engine call, and engine trouble that stops the stage (isStageStop) is
// thrown at once. Before it is thrown, the best clip so far is kept as a
// 'rejected' candidate with its attempts, so a resumed render (/film retry)
// starts from it instead of paying for it again.
async function ensureClip(ctx, ref, fp, { refAsset, refFile, refUrl = null, startFrame, prevFrameFile, prevFrameUrl = null, force = false }) {
  const key = fp.clips[ref.shot.id];
  const have = force ? null : clipFingerprints(key).map((f) => ctx.find('clip', f)).find(Boolean);
  if (have) {
    ctx.reused.clips++;
    const file = await ctx.local(have, `clip-${ref.shot.id}.mp4`);
    return { asset: have, file, durationS: Number(have.duration_s) || await ctx.ff.probeDuration(file), verdict: (have.meta && have.meta.qc) || null, attempts: 0, reused: true, engine: (have.meta && have.meta.engine) || null };
  }
  const seconds = clipSecondsFor(ref.shot);
  const tier = ctx.timeline.tier;
  let tries = [];
  let best = null;
  let start = startFrame;
  let first = 1;
  const kept = force ? null : ctx.candidates.find((a) => a.fingerprint === key);
  if (kept) {
    const file = await ctx.local(kept, `clip-${ref.shot.id}-kept.mp4`);
    tries = Array.isArray(kept.meta && kept.meta.attempts) ? kept.meta.attempts : [];
    first = tries.length + 1;
    best = { kept, bytes: null, file, durationS: Number(kept.duration_s) || await ctx.ff.probeDuration(file), verdict: kept.meta.qc, attempt: kept.attempt, engine: kept.meta.engine || engineLabel('replicate'), costUsd: Number(kept.cost_usd) || 0 };
    ctx.reused.candidates++;
    ctx.say(`shot ${ref.shot.id}: resuming from the clip kept after ${tries.length} attempt(s)`);
  }
  try {
    for (let attempt = first; attempt <= 1 + MAX_SHOT_RETRIES; attempt++) {
      const reserve = clipReserveUsd(tier, seconds) + FILM_PRICES.qcUsd;
      await ctx.paid(reserve, `the clip for shot ${ref.sceneIndex}.${ref.shotIndex}`);
      if (attempt > 1) ctx.generated.retries++;
      // The second retry of a shot that starts from its own still draws a new
      // still too: the problem may be in the still itself.
      if (attempt === 3 && !ref.shot.continuous) {
        let k;
        try {
          k = await ensureKeyframe(ctx, ref, fp, await ctx.store.sign(refAsset.storage_path, 3600), { force: true, seed: 1000 + attempt, attempt, prevFrameUrl });
        } catch (e) {
          await ctx.refund(reserve, `the clip for shot ${ref.shot.id}`);
          throw e;
        }
        start = { asset: k, url: await ctx.store.sign(k.storage_path, 3600) };
      }
      const issues = best ? best.verdict.issues : [];
      const prompt = attempt === 1 ? clipPrompt(ctx.timeline, ref.shot) : retryPrompt(clipPrompt(ctx.timeline, ref.shot), issues);
      let out;
      try {
        out = await ctx.call('clips', reserve, () => ctx.oneAtATime(() => ctx.engines.clip({ prompt, startImageUrl: start.url, referenceUrl: refUrl, prevFrameUrl, tier, seconds, stage: ctx.media })));
      } catch (e) {
        if (e instanceof CapReached || isStageStop(e)) throw e;
        ctx.report('film_clip_failed', `shot=${ref.shot.id} attempt=${attempt} ${e && e.detail ? e.detail : e && e.message}`);
        tries.push({ attempt, error: e && e.refused ? 'refused' : 'engine_error' });
        continue;
      }
      // The reservation was for the dearest engine; give back the rest.
      const costUsd = clipCostOnUsd(out.engine, tier, seconds);
      await ctx.refund(clipReserveUsd(tier, seconds) - costUsd, `the clip for shot ${ref.shot.id}`);
      const engine = ctx.made(out.engine);
      const file = ctx.file(`clip-${ref.shot.id}-a${attempt}.mp4`);
      await writeFile(file, out.bytes);
      const durationS = await ctx.ff.probeDuration(file);
      const verdict = await checkClip(ctx, ref, file, durationS, refFile, prevFrameFile);
      tries.push({ attempt, pass: verdict.pass, score: verdict.score, issues: verdict.issues, engine });
      const cand = { bytes: out.bytes, file, durationS, verdict, attempt, engine, costUsd };
      if (!best || (verdict.pass && !best.verdict.pass) || (verdict.pass === best.verdict.pass && (verdict.score || 0) > (best.verdict.score || 0))) best = cand;
      ctx.generated.clips++;
      if (verdict.pass) break;
    }
  } catch (e) {
    // No other shot starts after this: the stage is stopping.
    ctx.stopped = ctx.stopped || e;
    if (best && !best.kept) {
      await ctx.save({
        kind: 'clip', status: 'rejected', bytes: best.bytes, ext: 'mp4', mime: 'video/mp4', fingerprint: key, shotRef: ref, prompt: clipPrompt(ctx.timeline, ref.shot),
        description: best.verdict.description || ref.shot.description, durationS: best.durationS, attempt: best.attempt, costUsd: best.costUsd,
        meta: { candidate: true, qc: best.verdict, attempts: tries, engine: best.engine, shotDescription: ref.shot.description }
      }).catch((err) => ctx.say(`could not keep the clip for ${ref.shot.id}: ${err.message}`));
    } else if (best && best.kept && tries.length > (best.kept.meta.attempts || []).length) {
      await ctx.store.updateAsset(best.kept.id, { meta: { ...best.kept.meta, attempts: tries } }).catch(() => {});
    }
    throw e;
  }
  if (!best) throw Object.assign(new Error(`shot ${ref.sceneIndex}.${ref.shotIndex} could not be generated`), { code: 'engine_error', step: 'clips' });
  const meta = { qc: best.verdict, attempts: tries, shotDescription: ref.shot.description, camera: ref.shot.camera, flagged: !best.verdict.pass, engine: best.engine };
  let asset;
  if (best.kept) {
    // The kept candidate is still the best: it becomes the shot's clip as it is.
    asset = { ...best.kept, status: 'ok', meta };
    await ctx.store.updateAsset(best.kept.id, { status: 'ok', meta });
    ctx.assets.push(asset);
  } else {
    asset = await ctx.save({
      kind: 'clip', bytes: best.bytes, ext: 'mp4', mime: 'video/mp4', fingerprint: key, shotRef: ref, prompt: clipPrompt(ctx.timeline, ref.shot),
      description: best.verdict.description || ref.shot.description, durationS: best.durationS, attempt: best.attempt,
      costUsd: best.costUsd, thumbFrom: best.file, thumbAtS: Math.min(1, best.durationS / 2), meta
    });
    if (kept) await ctx.store.updateAsset(kept.id, { status: 'superseded' }).catch(() => {});
    // A clip made again (the stage moved engine) replaces the old one.
    if (force) for (const a of ctx.assets) if (a !== asset && a.kind === 'clip' && clipFingerprints(key).includes(a.fingerprint) && a.status === 'ok') { a.status = 'superseded'; if (a.id) await ctx.store.updateAsset(a.id, { status: 'superseded' }).catch(() => {}); }
  }
  return { asset, file: best.file, durationS: best.durationS, verdict: best.verdict, attempts: tries.length, engine: best.engine, tries };
}

// Runs `fn` over items, in order of start, with at most limit() at once
// (read again before each new item, so a stage that is throttled drops to
// one at a time: the runs above the limit finish and stop).
async function pool(items, n, fn, limit = () => n) {
  const out = new Array(items.length);
  let next = 0;
  let failed = null;
  let active = 0;
  const worker = async () => {
    while (next < items.length && !failed) {
      if (active >= Math.max(1, Math.min(n, limit()))) return;
      const i = next++;
      active++;
      try { out[i] = await fn(items[i], i); } catch (e) { failed = failed || e; } finally { active--; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  if (failed) throw failed;
  return out;
}

// Shots grouped into chains: a shot that starts from its own still, then
// the continuous shots that follow it. Chains can render side by side; a
// chain renders in order.
export function shotChains(timeline) {
  const chains = [];
  for (const ref of flatShots(timeline)) {
    if (ref.shot.continuous && ref.shotIndex > 1 && chains.length) chains[chains.length - 1].push(ref);
    else chains.push([ref]);
  }
  return chains;
}

export async function runRender(opts) {
  const { project, stage = 'full', store, ff, env = {} } = opts;
  const ctx = createContext(opts);
  const timeline = ctx.timeline;
  const voiceKey = opts.voiceKey || '';
  const fp = assetFingerprints(timeline, { voiceKey });
  const shots = flatShots(timeline);
  await mkdir(opts.workdir, { recursive: true });
  ctx.assets = await store.listAssets(project.id);
  // Clips a stopped render kept while their shot was still being retried.
  if (stage === 'full') ctx.candidates = (await store.listAssets(project.id, { kinds: ['clip'], status: 'rejected' })).filter((a) => a.meta && a.meta.candidate);
  const generatedShots = shots.filter((r) => !isAssetShot(r.shot)).length;
  const total = shots.length + generatedShots * (stage === 'full' ? 2 : 1) + timeline.scenes.length + 3;
  let done = 0;
  const step = async (label) => { done++; await ctx.progress(label, done, total); };

  // Attached images placed as shots: the stored originals, never generated.
  const attachmentFiles = await loadAttachmentFiles(ctx, timeline, shots);

  // Stills (the preview's frames; the full render's start images).
  const needStill = (ref) => !isAssetShot(ref.shot) && (stage === 'preview' || !(ref.shot.continuous && ref.shotIndex > 1));
  let refAsset = null;
  let refFile = null;
  let refUrl = null;
  const keyAssets = {};
  // One engine per kind for the whole film (A4): a stage starts on the
  // engine the stored stills and clips were made by.
  ctx.media.kinds = ctx.media.kinds || {};
  for (const [kind, assetKind] of [['still', 'keyframe'], ['clip', 'clip']]) {
    const e = storedEngine(ctx.assets.filter((a) => a.kind === assetKind && a.status === 'ok'), mediaEngineOf);
    if (e && !(ctx.media.kinds[kind] && ctx.media.kinds[kind].engine)) ctx.media.kinds[kind] = { engine: e, switched: null, pinned: true };
  }
  const regenerated = [];
  if (shots.some(needStill)) {
    refAsset = await ensureReference(ctx, fp);
    refFile = await ctx.local(refAsset, 'reference.png');
    refUrl = await store.sign(refAsset.storage_path, 3600);
    await step('Reference still');
    let prevKey = null;
    for (const ref of shots.filter(needStill)) {
      const before = prevKey;
      // The previous shot's frame, signed only if the fallback engine asks.
      const prevFrameUrl = before ? () => store.sign(before.storage_path, 3600) : null;
      const madeBefore = ctx.generated.keyframes;
      keyAssets[ref.shot.id] = await ensureKeyframe(ctx, ref, fp, refUrl, { prevFrameUrl });
      // Director Mode: a still made now is checked against its script beat
      // and made once more when it misses (the reason goes in the notes).
      if (ctx.director && ctx.director.stillCritic && ctx.generated.keyframes > madeBefore) {
        const verdict = await checkStill(ctx, ref, keyAssets[ref.shot.id], refFile);
        ctx.stillChecks.push({ shotId: ref.shot.id, pass: verdict.pass, score: verdict.score, issues: verdict.issues });
        if (!verdict.pass) {
          keyAssets[ref.shot.id] = await ensureKeyframe(ctx, ref, fp, refUrl, { force: true, seed: 2000 + ref.shotIndex, attempt: 2, prevFrameUrl });
          regenerated.push({ shotId: ref.shot.id, what: 'still', reason: `missed its script beat: ${verdict.issues.map((i) => i.detail || i.type).join('; ').slice(0, 160) || `score ${verdict.score}`}` });
        }
      }
      prevKey = keyAssets[ref.shot.id];
      await step(`Still for shot ${ref.sceneIndex}.${ref.shotIndex}`);
    }
    // The stills moved engine during the stage (or were stored from another):
    // the ones made on the old engine are made again on the new one.
    const stillEngine = ctx.media.kinds.still && ctx.media.kinds.still.engine;
    if (stillEngine) {
      let prev = null;
      for (const ref of shots.filter(needStill)) {
        const a = keyAssets[ref.shot.id];
        const made = mediaEngineOf(a);
        if (made && made !== stillEngine) {
          const before = prev;
          keyAssets[ref.shot.id] = await ensureKeyframe(ctx, ref, fp, refUrl, { force: true, attempt: (Number(a.attempt) || 1) + 1, prevFrameUrl: before ? () => store.sign(before.storage_path, 3600) : null });
          regenerated.push({ shotId: ref.shot.id, what: 'still', reason: `made again on the ${engineLabel(stillEngine)} so every still has one look` });
        }
        prev = keyAssets[ref.shot.id];
      }
    }
  }

  // Voice and music. A film keeps one narrator: a stage starts on the voice
  // its stored lines were recorded in.
  const storedVoice = ctx.assets.filter((a) => a.kind === 'voice' && a.status === 'ok');
  const pinnedVoice = storedEngine(storedVoice, voiceEngineOf);
  if (pinnedVoice && storedVoice.length) ctx.voiceStage.engine = pinnedVoice;
  const voice = {};
  const voiceAssets = {};
  const setVoice = (id, a) => {
    voiceAssets[id] = a;
    voice[id] = { durationS: Number(a.duration_s) || 0, words: (a.meta && a.meta.words) || [] };
  };
  for (const ref of shots) {
    const a = await ensureVoice(ctx, ref, fp);
    if (a) setVoice(ref.shot.id, a);
    await step(`Voiceover ${ref.sceneIndex}.${ref.shotIndex}`);
  }
  // The voice moved engine during the stage (or stored lines are in
  // another voice): the lines in the other voice are recorded again on the
  // stage's voice (about 0.01 USD a line), so the voice never changes
  // mid-film.
  let rerecorded = 0;
  const finalVoice = ctx.voiceStage.engine;
  if (finalVoice) {
    for (const ref of shots) {
      const a = voiceAssets[ref.shot.id];
      // Dialogue is in its characters' voices, not the narrator's.
      if (!a || voiceEngineOf(a) === finalVoice || (a.meta && a.meta.dialogue)) continue;
      const again = await ensureVoice(ctx, ref, fp, { force: true, attempt: (Number(a.attempt) || 1) + 1 });
      setVoice(ref.shot.id, again);
      rerecorded++;
      regenerated.push({ shotId: ref.shot.id, what: 'voice', reason: `recorded again in the ${voiceLabel(finalVoice)} so the film keeps one voice` });
      // That voice was not available for it after all: stop here.
      if (voiceEngineOf(again) !== finalVoice) break;
    }
    if (rerecorded) ctx.say(`${rerecorded} voiceover line(s) recorded again in the ${voiceLabel(finalVoice)}, so the film keeps one voice`);
  }
  // Music: one cue per scene, scored to the scene's length in the edit.
  const sceneSeconds = {};
  for (const m of planCuts(timeline, { voice, clips: null }).music) sceneSeconds[m.sceneId] = Math.max(5, Math.round(m.endS - m.startS));
  const musicAssets = {};
  for (const [i, scene] of timeline.scenes.entries()) {
    const a = await ensureMusic(ctx, scene, i + 1, fp, sceneSeconds[scene.id] || null);
    if (a) musicAssets[scene.id] = a;
    await step(`Music for scene ${i + 1}`);
  }

  // Director Mode: one sound effect per shot that has a cue. A cue that
  // cannot be made is left out (never stops the film).
  const sfxAssets = {};
  if (ctx.director && ctx.director.sfx && typeof ctx.engines.sfx === 'function') {
    for (const ref of shots.filter((r) => r.shot.sfx)) {
      const a = await ensureSfx(ctx, ref);
      if (a) sfxAssets[ref.shot.id] = a;
    }
  }

  // Clips (full only), chains side by side.
  const clips = {};
  const clipFiles = {};
  const qcShots = [];
  const concurrency = Math.max(1, Math.min(4, Number(env.PG1_FILM_CONCURRENCY) || 3));
  if (stage === 'full') {
    // The previous shot's last frame (for the fallback engine's continuity):
    // its clip's last frame once that clip is made, else its still.
    const order = shots.map((r) => r.shot.id);
    const lastFrames = {};
    const lastFrameOf = (shotId) => {
      if (lastFrames[shotId]) return lastFrames[shotId];
      if (clipFiles[shotId]) {
        lastFrames[shotId] = (async () => {
          const lf = await ff.extractLastFrame(clipFiles[shotId], ctx.file(`end-${shotId}.jpg`));
          const up = await store.upload(filmPath(project.id, 'frames', `end-${shotId}-${fp.clips[shotId]}.jpg`), await readFile(lf), 'image/jpeg');
          return store.sign(up, 3600);
        })();
        return lastFrames[shotId];
      }
      return keyAssets[shotId] ? store.sign(keyAssets[shotId].storage_path, 3600) : null;
    };
    // One chain of shots in order. forceFrom: the index from which the
    // chain's clips are made again (the stage moved engine; a continuous
    // shot after a remade one starts from its new last frame, so it is made
    // again too).
    const renderChain = async (chain, { forceFrom = Infinity } = {}) => {
      let prev = null;
      for (const [ci, ref] of chain.entries()) {
        if (ctx.stopped) return;
        let startFrame;
        let prevFrameFile = null;
        if (ref.shot.continuous && prev) {
          const lf = await ff.extractLastFrame(prev.file, ctx.file(`last-${ref.shot.id}.jpg`));
          prevFrameFile = lf;
          const up = await store.upload(filmPath(project.id, 'frames', `start-${ref.shot.id}-${fp.clips[ref.shot.id]}.jpg`), await readFile(lf), 'image/jpeg');
          startFrame = { url: await store.sign(up, 3600) };
        } else {
          startFrame = { url: await store.sign(keyAssets[ref.shot.id].storage_path, 3600) };
        }
        const before = order[order.indexOf(ref.shot.id) - 1];
        const prevFrameUrl = ref.shot.continuous && prev ? startFrame.url : before ? () => lastFrameOf(before) : null;
        const force = ci >= forceFrom;
        if (force) delete lastFrames[ref.shot.id];
        const c = await ensureClip(ctx, ref, fp, { refAsset, refFile, refUrl, startFrame, prevFrameFile, prevFrameUrl, force });
        clips[ref.shot.id] = { durationS: c.durationS, bestStartS: c.verdict ? c.verdict.bestStartS : 0 };
        clipFiles[ref.shot.id] = c.file;
        // Why earlier takes were rejected (the dailies' reasons for the notes).
        const retryReasons = (c.tries || []).filter((t) => t.pass === false || t.error).flatMap((t) => (t.error ? [t.error === 'refused' ? 'declined by the engine' : 'the engine failed'] : (t.issues || []).map((i) => i.detail || i.type))).slice(0, 6);
        const entry = { shotId: ref.shot.id, scene: ref.sceneIndex, shot: ref.shotIndex, description: ref.shot.description, reused: !!c.reused, attempts: c.attempts, pass: c.verdict ? c.verdict.pass : null, score: c.verdict ? c.verdict.score : null, issues: c.verdict ? c.verdict.issues : [], engine: c.engine || null, ...(retryReasons.length ? { retryReasons } : {}) };
        const at = qcShots.findIndex((q) => q.shotId === ref.shot.id);
        if (at >= 0) qcShots[at] = entry; else qcShots.push(entry);
        prev = c;
        if (!force) await step(`Clip ${ref.sceneIndex}.${ref.shotIndex}`);
      }
    };
    // Throttled once: one clip at a time for the rest of the stage.
    // An attached image's shot is never a clip (and starts no chain).
    const chains = shotChains(timeline).filter((chain) => !isAssetShot(chain[0].shot));
    await pool(chains, concurrency, (chain) => renderChain(chain), () => (ctx.media.throttled ? 1 : concurrency));
    // The clips moved engine during the stage (or stored clips are from
    // another engine): the clips made on the old engine are made again on
    // the new one, so the film never mixes clip styles (A4).
    const clipEngine = ctx.media.kinds.clip && ctx.media.kinds.clip.engine;
    if (clipEngine && !ctx.stopped) {
      const madeBy = (id) => { const q = qcShots.find((x) => x.shotId === id); return q && q.engine ? MEDIA_ENGINE_BY_LABEL[q.engine] || null : null; };
      for (const chain of chains) {
        const from = chain.findIndex((ref) => madeBy(ref.shot.id) && madeBy(ref.shot.id) !== clipEngine);
        if (from < 0) continue;
        await renderChain(chain, { forceFrom: from });
        for (const ref of chain.slice(from)) regenerated.push({ shotId: ref.shot.id, what: 'clip', reason: `made again on the ${engineLabel(clipEngine)} so the film has one clip style` });
      }
    }
  }

  // Assembly.
  const size = stage === 'preview' ? ff.FILM_SIZES.preview : ff.FILM_SIZES[timeline.tier] || ff.FILM_SIZES.standard;
  const voiceFiles = {};
  for (const [id, a] of Object.entries(voiceAssets)) voiceFiles[id] = await ctx.local(a, `vo-${id}.wav`);
  const musicFiles = {};
  for (const [id, a] of Object.entries(musicAssets)) musicFiles[id] = await ctx.local(a, `music-${id}.${String(a.storage_path).split('.').pop()}`);
  const stillFiles = {};
  if (stage === 'preview') for (const [id, a] of Object.entries(keyAssets)) stillFiles[id] = await ctx.local(a, `still-${id}.png`);
  const sfxFiles = {};
  for (const [id, a] of Object.entries(sfxAssets)) sfxFiles[id] = await ctx.local(a, `sfx-${id}.${String(a.storage_path).split('.').pop()}`);
  const credits = ctx.director && ctx.director.credits && stage === 'full' ? ctx.director.credits : null;

  // The check of each attached image's rendered shot, by shot id.
  let imageChecks = {};
  const assemble = async (voiceNow) => {
    const plan = withCredits(planCuts(timeline, { voice: voiceNow, clips: stage === 'full' ? clips : null }), credits);
    const segFiles = [];
    imageChecks = {};
    for (const [i, s] of plan.segments.entries()) {
      const out = ctx.file(`seg-${String(i).padStart(3, '0')}.mp4`);
      if (s.kind === 'card' || s.kind === 'crawl') await ff.segmentCard({ durationS: s.durationS, out, size });
      else if (s.kind === 'logo') await ff.segmentFromImage(s.file, { mode: 'hold', durationS: s.durationS, out, size });
      else if (s.asset) {
        // The original image, fitted whole into the frame, no grade.
        await ff.segmentFromImage(attachmentFiles[s.asset.attachment], { mode: s.asset.mode, durationS: s.durationS, out, size });
        imageChecks[s.shotId] = await checkImageShot(ctx, s, out, attachmentFiles[s.asset.attachment], size);
      } else if (stage === 'preview') await ff.segmentFromStill(stillFiles[s.shotId], { camera: s.camera, durationS: s.durationS, out, size, grade: timeline.style.grade });
      else await ff.segmentFromClip(clipFiles[s.shotId], { inS: s.inS, durationS: s.durationS, clipS: s.clipS, out, size, grade: timeline.style.grade });
      segFiles.push(out);
    }
    const joined = await ff.joinSegments(segFiles, plan.segments.map((s) => s.durationS), plan.joins, ctx.file('joined.mp4'), size);
    const parts = {
      voice: plan.voice.map((v) => ({ file: voiceFiles[v.shotId], atS: v.atS })),
      // A scene whose music was unavailable plays with voice alone.
      music: plan.music.filter((m) => musicFiles[m.sceneId]).map((m) => ({ file: musicFiles[m.sceneId], startS: m.startS, endS: m.endS, bedS: Number(musicAssets[m.sceneId].duration_s) || null })),
      sfx: plan.segments.filter((s) => s.kind === 'shot' && sfxFiles[s.shotId]).map((s) => ({ file: sfxFiles[s.shotId], atS: s.startS + Math.min(0.4, s.durationS / 4), durationS: Math.min(s.durationS, Number(sfxAssets[s.shotId].duration_s) || s.durationS) })),
      totalS: plan.totalS
    };
    const mix = await ff.mixAudio({ ...parts, out: ctx.file('mix.wav') });
    const loud = await ff.normaliseLoudness(mix, ctx.file('mix-norm.wav'));
    const ass = await ff.writeText(ctx.file('captions.ass'), ff.buildAss({ width: size.width, height: size.height, captions: plan.captions, titles: plan.titles, crawl: plan.crawl || null }));
    const out = await ff.finalEncode({ video: joined, audio: loud.file, ass, out: ctx.file(`${stage}.mp4`), size, title: timeline.title, totalS: plan.totalS, cwd: opts.workdir });
    return { plan, out, loud, parts };
  };

  await ctx.progress('Editing', done, total, true);
  let { plan, out, loud, parts } = await assemble(voice);
  await step('Edit');

  // Transcript check of the final mix (full only): lines that do not come
  // through are recorded again, at most MAX_LINE_RETRIES times.
  let audioCheck = null;
  if (stage === 'full' && plan.voice.length) {
    for (let round = 0; round <= MAX_LINE_RETRIES; round++) {
      await ctx.paid(Math.max(0.01, plan.totalS * FILM_PRICES.transcribePerSecondUsd), 'the audio check');
      const wav = await ff.extractAudioForCheck(out, ctx.file(`check-${round}.wav`));
      let transcript;
      try {
        transcript = await ctx.engines.transcribe({ audio: await readFile(wav) });
      } catch (e) {
        ctx.report('film_transcribe_failed', e && e.detail ? e.detail : e && e.message);
        audioCheck = { ok: null, wer: null, lines: [], note: 'the audio check could not run' };
        break;
      }
      const cues = plan.voice.map((v) => {
        const sh = shots.find((x) => x.shot.id === v.shotId).shot;
        const w = voice[v.shotId].words;
        return { shotId: v.shotId, atS: v.atS, durationS: v.durationS, text: sh.voiceover, firstWordS: w && w[0] ? w[0].start : 0 };
      });
      audioCheck = { ...checkTranscript(cues, transcript), round };
      const bad = audioCheck.lines.filter((l) => l.ok === false);
      if (!bad.length || round === MAX_LINE_RETRIES) break;
      for (const l of bad) {
        const ref = shots.find((x) => x.shot.id === l.shotId);
        const a = await ensureVoice(ctx, ref, fp, { force: true, attempt: round + 2 });
        voiceAssets[l.shotId] = a;
        voice[l.shotId] = { durationS: Number(a.duration_s) || 0, words: (a.meta && a.meta.words) || [] };
        voiceFiles[l.shotId] = await ctx.local(a, `vo-${l.shotId}-r${round + 1}.wav`);
      }
      ({ plan, out, loud, parts } = await assemble(voice));
    }
  }

  // Store the film, its poster and a frame from every shot for the library.
  const bytes = await readFile(out);
  const version = project.timeline_version;
  const kind = stage === 'preview' ? 'preview' : 'final';
  const mainPath = await store.upload(filmPath(project.id, kind, `v${version}-${Date.now()}.mp4`), bytes, 'video/mp4');
  const posterFile = await ff.thumbnail(out, Math.min(plan.totalS / 3, 8), ctx.file('poster.jpg'), { width: 1280 });
  const posterPath = await store.upload(filmPath(project.id, 'posters', `${kind}-v${version}.jpg`), await readFile(posterFile), 'image/jpeg');
  await store.insertAsset({
    project_id: project.id, kind, timeline_version: version, fingerprint: null, prompt: project.request.slice(0, 2000),
    description: `${kind === 'preview' ? 'Preview' : 'Final film'}: ${timeline.title}, version ${version}`, storage_path: mainPath, thumb_path: posterPath,
    mime_type: 'video/mp4', duration_s: plan.totalS, meta: { loudness: loud.after ? Number(loud.after.input_i) : null, segments: plan.segments.length }
  });
  for (const s of plan.segments.filter((x) => x.kind === 'shot')) {
    try {
      const f = await ff.extractFrame(out, s.startS + s.durationS / 2, ctx.file(`frame-${s.shotId}.jpg`), { width: 640 });
      const p = await store.upload(filmPath(project.id, 'frames', `${kind}-v${version}-${s.shotId}.jpg`), await readFile(f), 'image/jpeg');
      const ref = shots.find((x) => x.shot.id === s.shotId);
      await store.insertAsset({
        project_id: project.id, kind: 'frame', scene: s.scene, shot: s.shot, shot_id: s.shotId, timeline_version: version,
        description: `${kind === 'preview' ? 'Preview' : 'Film'} frame, shot ${s.scene}.${s.shot}: ${ref.shot.description}`, prompt: ref.shot.visual_prompt,
        storage_path: p, thumb_path: p, mime_type: 'image/jpeg', start_s: s.startS, end_s: s.startS + s.durationS, meta: { stage: kind }
      });
    } catch (e) { ctx.say(`frame for ${s.shotId} skipped: ${e.message}`); }
  }

  // Attached images: in the shot list (full) and their own list (both).
  const imageShots = plan.segments.filter((s) => s.kind === 'shot' && s.asset).map((s) => {
    const c = imageChecks[s.shotId] || { pass: null, similarity: null };
    return { shotId: s.shotId, scene: s.scene, shot: s.shot, attachment: s.asset.attachment, mode: s.asset.mode, label: YOUR_IMAGE_LABEL, pass: c.pass, similarity: c.similarity, ...(c.note ? { note: c.note } : {}) };
  });
  if (stage === 'full') {
    for (const a of imageShots) {
      const ref = shots.find((x) => x.shot.id === a.shotId);
      qcShots.push({
        shotId: a.shotId, scene: a.scene, shot: a.shot, description: ref.shot.description, reused: false, attempts: 0, pass: a.pass, score: null,
        issues: a.pass === false ? [{ type: 'other', detail: `the rendered frames differ from ${yourImageLabel(a.attachment).toLowerCase()} (similarity ${a.similarity})` }] : [],
        engine: YOUR_IMAGE_LABEL, attachment: a.attachment, similarity: a.similarity
      });
    }
  }

  const qcReport = {
    stage, version, durationS: plan.totalS,
    loudness: { before: Number(loud.measured.input_i), after: loud.after ? Number(loud.after.input_i) : null, target: ff.TARGET_LUFS },
    shots: qcShots, flagged: qcShots.filter((s) => s.pass === false).map((s) => s.shotId), audio: audioCheck,
    generated: ctx.generated, reused: ctx.reused,
    ...(imageShots.length ? { attachments: imageShots } : {}),
    // Which engine made what this stage (PG1 labels), and any engine trouble.
    engines: ctx.engines_used,
    // What was made again for consistency, and why (A4).
    regenerated,
    // Voiceover: which engine, Cartesia's second sends, and the switch.
    voice: {
      engine: voiceLabel(ctx.voiceStage.engine || 'cartesia'), retries: ctx.voiceStage.retries, rerecorded,
      fallback: ctx.voiceStage.switched ? { from: voiceLabel(ctx.voiceStage.switched.from), to: voiceLabel(ctx.voiceStage.switched.to), reason: ctx.voiceStage.switched.kind } : null
    },
    // Scenes without music this stage (the film finished without them).
    music: ctx.musicMissing.length
      ? { unavailable: true, scenes: ctx.musicMissing.map((m) => m.scene), reason: ctx.musicMissing[0].reason, note: MUSIC_UNAVAILABLE_NOTE }
      : { unavailable: false, scenes: [], reason: null, note: null },
    media: {
      throttled: ctx.media.throttled, throttles: ctx.media.throttles,
      concurrency: stage === 'full' ? (ctx.media.throttled ? 1 : concurrency) : 1,
      fallback: ctx.media.switched ? { from: engineLabel(ctx.media.switched.from), to: engineLabel(ctx.media.switched.to), reason: ctx.media.switched.kind, at: ctx.media.switched.what } : null
    }
  };
  // Director Mode's deliverables: a 9:16 social cut of the master and the
  // audio stems (voice, music, SFX), each in the media library.
  const deliverables = {};
  if (ctx.director && ctx.director.deliverables && stage === 'full') {
    try {
      const social = await ff.socialCut(out, ctx.file('social.mp4'));
      deliverables.social = await store.upload(filmPath(project.id, 'social', `v${version}-9x16.mp4`), await readFile(social), 'video/mp4');
      await store.insertAsset({ project_id: project.id, kind: 'social', timeline_version: version, description: `Social cut (9:16): ${timeline.title}, version ${version}`, storage_path: deliverables.social, mime_type: 'video/mp4', duration_s: plan.totalS, meta: { width: 1080, height: 1920 } });
    } catch (e) { ctx.say(`social cut skipped: ${e.message}`); deliverables.socialError = String(e.message || e).slice(0, 200); }
    deliverables.stems = {};
    for (const [stem, keep] of [['voice', { voice: parts.voice, music: [], sfx: [] }], ['music', { voice: [], music: parts.music, sfx: [] }], ['sfx', { voice: [], music: [], sfx: parts.sfx }]]) {
      if (!keep.voice.length && !keep.music.length && !keep.sfx.length) continue;
      try {
        const f = await ff.mixAudio({ ...keep, totalS: parts.totalS, out: ctx.file(`stem-${stem}.wav`) });
        const pth = await store.upload(filmPath(project.id, 'stems', `v${version}-${stem}.wav`), await readFile(f), 'audio/wav');
        await store.insertAsset({ project_id: project.id, kind: 'stem', timeline_version: version, description: `Audio stem (${stem}): ${timeline.title}, version ${version}`, storage_path: pth, mime_type: 'audio/wav', duration_s: plan.totalS, meta: { stem } });
        deliverables.stems[stem] = pth;
      } catch (e) { ctx.say(`${stem} stem skipped: ${e.message}`); }
    }
    qcReport.deliverables = { social: !!deliverables.social, stems: Object.keys(deliverables.stems) };
  }
  if (ctx.director) {
    qcReport.stillChecks = ctx.stillChecks;
    qcReport.sfx = { made: Object.keys(sfxAssets).length, missing: ctx.sfxMissing };
  }
  return { path: mainPath, posterPath, plan, qcReport, size, deliverables };
}

// --- Director Mode helpers ---------------------------------------------------------

// One still checked against its script beat (STILL_CHECK_SYSTEM). A check
// that cannot run counts as a pass with a note.
async function checkStill(ctx, ref, asset, refFile) {
  try {
    const file = await ctx.local(asset, `check-${ref.shot.id}.png`);
    const content = [
      { type: 'text', text: 'Character and style reference:' }, ctx.engines.image(await readFile(refFile)),
      { type: 'text', text: 'The still to check:' }, ctx.engines.image(await readFile(file)),
      { type: 'text', text: `Shot ${ref.sceneIndex}.${ref.shotIndex}: ${ref.shot.description}\nWhat it should show: ${ref.shot.visual_prompt}\n${intentText(ref.shot)}` }
    ];
    const validate = (text) => { const v = parseQcVerdict(text); if (v.unreadable) throw new Error('no JSON verdict in the reply'); return v; };
    const r = await ctx.engines.think({ system: STILL_CHECK_SYSTEM, content, effort: 'low', maxTokens: 2000, validate, purpose: `storyboard check ${ref.shot.id}` });
    return r && r.value !== undefined ? r.value : parseQcVerdict(r.text);
  } catch (e) {
    ctx.report('film_still_check_failed', `shot=${ref.shot.id} ${e && e.detail ? e.detail : e && e.message}`);
    return { pass: true, score: null, issues: [{ type: 'other', detail: 'the check could not run' }], unreadable: true };
  }
}

// One shot's sound effect (ROUTING_CHAINS.sfx), stored once per cue and
// length. One that cannot be made is noted and left out.
async function ensureSfx(ctx, ref) {
  const seconds = Math.min(30, Math.max(1, ref.shot.duration_s));
  const key = hash('sfx', ref.shot.sfx, seconds);
  const have = ctx.find('sfx', key);
  if (have) return have;
  const usd = Math.max(0.01, Math.round(seconds / 60 * 0.12 * 100) / 100);
  await ctx.paid(usd, `the sound effect for shot ${ref.sceneIndex}.${ref.shotIndex}`);
  let fx;
  try {
    fx = await ctx.engines.sfx({ text: ref.shot.sfx, seconds });
  } catch (e) {
    if (e instanceof CapReached) throw e;
    await ctx.refund(usd, `the sound effect for shot ${ref.shot.id}`);
    if (e && e.refused) throw Object.assign(e, { step: 'sfx' });
    ctx.sfxMissing.push({ shotId: ref.shot.id, reason: (e && e.kind) || 'engine' });
    ctx.say(`sound effect for shot ${ref.shot.id} left out (${e && e.kind})`);
    return null;
  }
  return ctx.save({ kind: 'sfx', bytes: fx.bytes, ext: fx.ext, mime: fx.mime, fingerprint: key, shotRef: ref, prompt: ref.shot.sfx, description: `Sound effect for ${ref.shot.description}: ${ref.shot.sfx}`, durationS: fx.durationS, costUsd: usd, meta: { engine: voiceLabel('elevenlabs') } });
}

// The end credits after the last shot: the crawl, then the logo end card
// (an image held as it is, never generated). credits: { lines, logoFile,
// crawlS, logoS }.
export const CREDITS_FADE_S = 0.6;
export function withCredits(plan, credits) {
  if (!credits || !Array.isArray(credits.lines) || !credits.lines.length) return plan;
  const segments = [...plan.segments];
  const joins = [...plan.joins];
  const add = (seg) => {
    const prev = segments[segments.length - 1];
    joins.push({ transition: 'fade_black', durationS: CREDITS_FADE_S });
    seg.startS = Math.round((prev.startS + prev.durationS - CREDITS_FADE_S) * 1000) / 1000;
    segments.push(seg);
  };
  const crawlS = credits.crawlS || Math.max(6, Math.min(14, credits.lines.length * 1.6));
  add({ kind: 'crawl', durationS: crawlS });
  const crawl = { startS: segments[segments.length - 1].startS, endS: segments[segments.length - 1].startS + crawlS, lines: credits.lines };
  if (credits.logoFile) add({ kind: 'logo', file: credits.logoFile, durationS: credits.logoS || 3 });
  const last = segments[segments.length - 1];
  const totalS = Math.round((last.startS + last.durationS) * 1000) / 1000;
  // The last scene's music plays on under the credits.
  const music = plan.music.map((m, i) => (i === plan.music.length - 1 ? { ...m, endS: totalS } : m));
  return { ...plan, segments, joins, totalS, crawl, music };
}

// --- attached images ---------------------------------------------------------------

// The stored original of every attached image a shot shows, in the working
// folder: { [index]: file }. A missing one stops the stage (step
// 'attachments'): it is never replaced with a generated image.
async function loadAttachmentFiles(ctx, timeline, shots) {
  const wanted = [...new Set(shots.filter((r) => isAssetShot(r.shot)).map((r) => r.shot.asset.attachment))];
  const files = {};
  for (const n of wanted) {
    const att = (timeline.attachments || []).find((a) => a.index === n);
    const row = att && ctx.assets.find((a) => a.id === att.asset_id && a.kind === 'reference');
    if (!row || !row.storage_path) throw Object.assign(new Error(`${yourImageLabel(n)} is no longer stored`), { code: 'attachment_missing', step: 'attachments' });
    const ext = String(row.storage_path).split('.').pop().replace(/[^a-z0-9]/gi, '') || 'png';
    files[n] = await ctx.local(row, `attachment-${n}.${ext}`);
  }
  return files;
}

// The rendered shot of an attached image compared with the image itself.
// A comparison that cannot run is noted, never retried or regenerated.
async function checkImageShot(ctx, seg, segFile, imageFile, size) {
  try {
    const r = await ctx.ff.matchImageSegment(segFile, imageFile, { mode: seg.asset.mode, durationS: seg.durationS, size, workdir: ctx.workdir, name: seg.shotId });
    if (!r.pass) ctx.say(`shot ${seg.shotId}: rendered frames differ from ${yourImageLabel(seg.asset.attachment).toLowerCase()} (${r.similarity})`);
    return r;
  } catch (e) {
    ctx.say(`shot ${seg.shotId}: the image check could not run: ${e.message}`);
    return { pass: null, similarity: null, note: 'the check could not run' };
  }
}

// After a preview: the FILM_FULL proposal with the full render's estimate
// (only what is not stored yet).
export async function proposeFullRender({ project, store, voiceKey = '' }) {
  const stored = await store.storedFingerprints(project.id);
  const est = estimateStage(project.timeline, { stage: 'full', stored, voiceKey });
  const proposal = await store.createPendingAction({
    actionType: FILM_ACTIONS.full,
    plan: { projectId: project.id, timelineVersion: project.timeline_version, estimateUsd: est.expectedUsd },
    diffSummary: `${FILM_LABEL}: full render of "${project.timeline.title}" (version ${project.timeline_version})\n${estimateText(est, { capUsd: Number(project.cap_usd), spentUsd: Number(project.spent_usd) })}`
  });
  return { est, ...proposal };
}
