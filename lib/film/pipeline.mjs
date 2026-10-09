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
// Dependencies are injected so the tests run without network or ffmpeg:
//   store    lib/film/store.mjs createFilmStore(...)
//   engines  { still, clip, music, voice, think, transcribe } (see
//            scripts/film-render.mjs for the real ones)
//   ff       lib/film/ffmpeg.mjs (or a stand-in)

import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { flatShots, normaliseTimeline, STORYBOARD_SYSTEM, storyboardUserPrompt, extractJsonObject, timelineSummary } from './storyboard.mjs';
import { assetFingerprints, clipSecondsFor, clipFingerprints } from './timeline.mjs';
import { estimateStage, estimateText, FILM_PRICES, MAX_SHOT_RETRIES, clipCostOnUsd, clipReserveUsd, voiceCostUsd, musicCostUsd } from './cost.mjs';
import { planCuts } from './cuts.mjs';
import { QC_SYSTEM, qcFrameTimes, qcPromptText, parseQcVerdict, retryPrompt, checkTranscript, MAX_LINE_RETRIES } from './qc.mjs';
import { filmPath } from './store.mjs';
import { FILM_ACTIONS, FILM_LABEL, shortFilmId } from './text.mjs';
import { ENGINE_LABELS } from '../aiRouter.mjs';

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
  return !!(e && typeof e === 'object' && STAGE_STOPS.has(e.kind));
}

// A media engine's answer: { bytes, engine, ...} from the real engines; a
// stand-in may return the bytes alone (the primary media engine's).
function mediaOut(out) {
  if (Buffer.isBuffer(out) || out instanceof Uint8Array) return { bytes: Buffer.from(out), engine: 'replicate' };
  return { ...out, engine: (out && out.engine) || 'replicate' };
}

export const engineLabel = (engine) => ENGINE_LABELS[engine] || ENGINE_LABELS.replicate;

// --- one film's working context -------------------------------------------------

function createContext({ project, store, engines, ff, workdir, env = {}, log = () => {}, onFailure = () => {}, now = () => Date.now(), media = null }) {
  const ctx = {
    project, store, engines, ff, workdir, env, log, onFailure, now,
    timeline: project.timeline,
    assets: [],
    candidates: [],
    generated: { reference: 0, keyframes: 0, clips: 0, voice: 0, music: 0, retries: 0 },
    reused: { reference: 0, keyframes: 0, clips: 0, voice: 0, music: 0, candidates: 0 },
    engines_used: {},
    // The stage's media state (lib/film/providers.mjs newMediaStage).
    media: media || { engine: null, throttled: false, throttles: 0, switched: null },
    lastProgress: 0
  };
  ctx.made = (engine) => { const l = engineLabel(engine); ctx.engines_used[l] = (ctx.engines_used[l] || 0) + 1; return l; };
  ctx.say = (line) => { try { log(`[film ${shortFilmId(project.id)}] ${line}`); } catch (e) { /* never breaks the render */ } };
  ctx.report = (reason, detail) => { try { onFailure({ reason, detail: String(detail || ''), requestId: project.request_id || null }); } catch (e) { /* ditto */ } };
  ctx.paid = async (usd, what) => {
    if (!(usd > 0)) return;
    const r = await store.charge(project.id, usd);
    if (!r.charged) {
      ctx.say(`cap reached before ${what} (spent ${r.spentUsd} of ${r.capUsd})`);
      throw new CapReached(r.spentUsd, r.capUsd);
    }
  };
  ctx.refund = async (usd, what) => {
    if (!(usd > 0.004) || typeof store.refund !== 'function') return;
    try { await store.refund(project.id, usd); } catch (e) { ctx.say(`could not give back ${usd} for ${what}: ${e.message}`); }
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

export async function runStoryboard(opts) {
  const { project, store, engines } = opts;
  const ctx = createContext(opts);
  await ctx.paid(FILM_PRICES.storyboardUsd, 'the storyboard');
  // The storyboard must pass the same checks whichever engine writes it.
  // The real engines (filmThink) validate each reply, ask the same engine
  // once more on a bad one, then fall back to the next engine, and return
  // the checked timeline as `value`; an engine without that (a stand-in)
  // gets the same one retry here.
  let warnings = [];
  const validate = (text) => {
    const w = [];
    const t = normaliseTimeline({ ...extractJsonObject(text), tier: project.tier }, { warnings: w });
    warnings = w;
    return t;
  };
  let timeline = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2 && !timeline; attempt++) {
    try {
      const r = await engines.think({ system: STORYBOARD_SYSTEM, content: storyboardUserPrompt(project.request, { tier: project.tier }) + (lastErr ? `\n\nYour last reply could not be used (${lastErr}). Reply with the JSON object only.` : ''), effort: 'medium', maxTokens: 16000, validate, purpose: 'storyboard' });
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
  const out = await ctx.call('reference', FILM_PRICES.stillUsd, () => ctx.engines.still({ prompt, stage: ctx.media }));
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
  const out = await ctx.call('stills', FILM_PRICES.stillUsd, () => ctx.engines.still({ prompt, referenceUrl: refUrl, prevFrameUrl, seed, stage: ctx.media }));
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
  try {
    line = await ctx.engines.voice({ text: ref.shot.voiceover });
  } catch (e) {
    if (e && typeof e === 'object' && !e.step) e.step = 'voice';
    throw e;
  }
  ctx.generated.voice++;
  return ctx.save({
    kind: 'voice', bytes: line.wav, ext: 'wav', mime: 'audio/wav', fingerprint: key, shotRef: ref, prompt: ref.shot.voiceover,
    description: `Voiceover for ${ref.shot.description}: "${ref.shot.voiceover}"`, durationS: line.durationS, costUsd: cost, attempt,
    meta: { words: line.words, engine: ctx.made('cartesia') }
  });
}

async function ensureMusic(ctx, scene, sceneIndex, fp) {
  const key = fp.music[scene.id];
  const have = ctx.find('music', key);
  if (have) { ctx.reused.music++; return have; }
  await ctx.paid(musicCostUsd(), `the music for scene ${sceneIndex}`);
  const bed = await ctx.call('music', musicCostUsd(), () => ctx.engines.music({ mood: scene.music.mood, bpm: scene.music.bpm, stage: ctx.media }));
  ctx.generated.music++;
  return ctx.save({
    kind: 'music', bytes: bed.bytes, ext: bed.ext, mime: bed.mime, fingerprint: key, prompt: scene.music.mood,
    description: `Music for scene ${sceneIndex}${scene.title ? ` (${scene.title})` : ''}: ${scene.music.mood}, ${scene.music.bpm} bpm`, costUsd: musicCostUsd(),
    meta: { scene: sceneIndex, sceneId: scene.id, bpm: scene.music.bpm, engine: ctx.made(bed.engine) }
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
    const r = await ctx.engines.think({ system: QC_SYSTEM, content, effort: 'low', maxTokens: 4000, validate, purpose: `shot check ${ref.shot.id}` });
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
async function ensureClip(ctx, ref, fp, { refAsset, refFile, refUrl = null, startFrame, prevFrameFile, prevFrameUrl = null }) {
  const key = fp.clips[ref.shot.id];
  const have = clipFingerprints(key).map((f) => ctx.find('clip', f)).find(Boolean);
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
  const kept = ctx.candidates.find((a) => a.fingerprint === key);
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
  }
  return { asset, file: best.file, durationS: best.durationS, verdict: best.verdict, attempts: tries.length, engine: best.engine };
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
  const total = shots.length * (stage === 'full' ? 3 : 2) + timeline.scenes.length + 3;
  let done = 0;
  const step = async (label) => { done++; await ctx.progress(label, done, total); };

  // Stills (the preview's frames; the full render's start images).
  const needStill = (ref) => stage === 'preview' || !(ref.shot.continuous && ref.shotIndex > 1);
  let refAsset = null;
  let refFile = null;
  let refUrl = null;
  const keyAssets = {};
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
      keyAssets[ref.shot.id] = await ensureKeyframe(ctx, ref, fp, refUrl, { prevFrameUrl });
      prevKey = keyAssets[ref.shot.id];
      await step(`Still for shot ${ref.sceneIndex}.${ref.shotIndex}`);
    }
  }

  // Voice and music.
  const voice = {};
  const voiceAssets = {};
  for (const ref of shots) {
    const a = await ensureVoice(ctx, ref, fp);
    if (a) {
      voiceAssets[ref.shot.id] = a;
      voice[ref.shot.id] = { durationS: Number(a.duration_s) || 0, words: (a.meta && a.meta.words) || [] };
    }
    await step(`Voiceover ${ref.sceneIndex}.${ref.shotIndex}`);
  }
  const musicAssets = {};
  for (const [i, scene] of timeline.scenes.entries()) {
    musicAssets[scene.id] = await ensureMusic(ctx, scene, i + 1, fp);
    await step(`Music for scene ${i + 1}`);
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
    // Throttled once: one clip at a time for the rest of the stage.
    await pool(shotChains(timeline), concurrency, async (chain) => {
      let prev = null;
      for (const ref of chain) {
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
        const c = await ensureClip(ctx, ref, fp, { refAsset, refFile, refUrl, startFrame, prevFrameFile, prevFrameUrl });
        clips[ref.shot.id] = { durationS: c.durationS, bestStartS: c.verdict ? c.verdict.bestStartS : 0 };
        clipFiles[ref.shot.id] = c.file;
        qcShots.push({ shotId: ref.shot.id, scene: ref.sceneIndex, shot: ref.shotIndex, description: ref.shot.description, reused: !!c.reused, attempts: c.attempts, pass: c.verdict ? c.verdict.pass : null, score: c.verdict ? c.verdict.score : null, issues: c.verdict ? c.verdict.issues : [], engine: c.engine || null });
        prev = c;
        await step(`Clip ${ref.sceneIndex}.${ref.shotIndex}`);
      }
    }, () => (ctx.media.throttled ? 1 : concurrency));
  }

  // Assembly.
  const size = stage === 'preview' ? ff.FILM_SIZES.preview : ff.FILM_SIZES[timeline.tier] || ff.FILM_SIZES.standard;
  const voiceFiles = {};
  for (const [id, a] of Object.entries(voiceAssets)) voiceFiles[id] = await ctx.local(a, `vo-${id}.wav`);
  const musicFiles = {};
  for (const [id, a] of Object.entries(musicAssets)) musicFiles[id] = await ctx.local(a, `music-${id}.${String(a.storage_path).split('.').pop()}`);
  const stillFiles = {};
  if (stage === 'preview') for (const [id, a] of Object.entries(keyAssets)) stillFiles[id] = await ctx.local(a, `still-${id}.png`);

  const assemble = async (voiceNow) => {
    const plan = planCuts(timeline, { voice: voiceNow, clips: stage === 'full' ? clips : null });
    const segFiles = [];
    for (const [i, s] of plan.segments.entries()) {
      const out = ctx.file(`seg-${String(i).padStart(3, '0')}.mp4`);
      if (s.kind === 'card') await ff.segmentCard({ durationS: s.durationS, out, size });
      else if (stage === 'preview') await ff.segmentFromStill(stillFiles[s.shotId], { camera: s.camera, durationS: s.durationS, out, size, grade: timeline.style.grade });
      else await ff.segmentFromClip(clipFiles[s.shotId], { inS: s.inS, durationS: s.durationS, clipS: s.clipS, out, size, grade: timeline.style.grade });
      segFiles.push(out);
    }
    const joined = await ff.joinSegments(segFiles, plan.segments.map((s) => s.durationS), plan.joins, ctx.file('joined.mp4'), size);
    const mix = await ff.mixAudio({
      voice: plan.voice.map((v) => ({ file: voiceFiles[v.shotId], atS: v.atS })),
      music: plan.music.map((m) => ({ file: musicFiles[m.sceneId], startS: m.startS, endS: m.endS })),
      totalS: plan.totalS, out: ctx.file('mix.wav')
    });
    const loud = await ff.normaliseLoudness(mix, ctx.file('mix-norm.wav'));
    const ass = await ff.writeText(ctx.file('captions.ass'), ff.buildAss({ width: size.width, height: size.height, captions: plan.captions, titles: plan.titles }));
    const out = await ff.finalEncode({ video: joined, audio: loud.file, ass, out: ctx.file(`${stage}.mp4`), size, title: timeline.title, totalS: plan.totalS, cwd: opts.workdir });
    return { plan, out, loud };
  };

  await ctx.progress('Editing', done, total, true);
  let { plan, out, loud } = await assemble(voice);
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
      ({ plan, out, loud } = await assemble(voice));
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

  const qcReport = {
    stage, version, durationS: plan.totalS,
    loudness: { before: Number(loud.measured.input_i), after: loud.after ? Number(loud.after.input_i) : null, target: ff.TARGET_LUFS },
    shots: qcShots, flagged: qcShots.filter((s) => s.pass === false).map((s) => s.shotId), audio: audioCheck,
    generated: ctx.generated, reused: ctx.reused,
    // Which engine made what this stage (PG1 labels), and any engine trouble.
    engines: ctx.engines_used,
    media: {
      throttled: ctx.media.throttled, throttles: ctx.media.throttles,
      concurrency: stage === 'full' ? (ctx.media.throttled ? 1 : concurrency) : 1,
      fallback: ctx.media.switched ? { from: engineLabel(ctx.media.switched.from), to: engineLabel(ctx.media.switched.to), reason: ctx.media.switched.kind, at: ctx.media.switched.what } : null
    }
  };
  return { path: mainPath, posterPath, plan, qcReport, size };
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
