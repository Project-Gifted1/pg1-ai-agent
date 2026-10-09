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
import { estimateStage, estimateText, FILM_PRICES, MAX_SHOT_RETRIES, clipCostUsd, voiceCostUsd, musicCostUsd } from './cost.mjs';
import { planCuts } from './cuts.mjs';
import { QC_SYSTEM, qcFrameTimes, qcPromptText, parseQcVerdict, retryPrompt, checkTranscript, MAX_LINE_RETRIES } from './qc.mjs';
import { filmPath } from './store.mjs';
import { FILM_ACTIONS, FILM_LABEL, shortFilmId } from './text.mjs';

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

// --- one film's working context -------------------------------------------------

function createContext({ project, store, engines, ff, workdir, env = {}, log = () => {}, onFailure = () => {}, now = () => Date.now() }) {
  const ctx = {
    project, store, engines, ff, workdir, env, log, onFailure, now,
    timeline: project.timeline,
    assets: [],
    generated: { reference: 0, keyframes: 0, clips: 0, voice: 0, music: 0, retries: 0 },
    reused: { reference: 0, keyframes: 0, clips: 0, voice: 0, music: 0 },
    lastProgress: 0
  };
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
  const warnings = [];
  let timeline = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2 && !timeline; attempt++) {
    try {
      const r = await engines.think({ system: STORYBOARD_SYSTEM, content: storyboardUserPrompt(project.request, { tier: project.tier }) + (lastErr ? `\n\nYour last reply could not be used (${lastErr}). Reply with the JSON object only.` : ''), effort: 'medium', maxTokens: 16000 });
      timeline = normaliseTimeline({ ...extractJsonObject(r.text), tier: project.tier }, { warnings });
    } catch (e) {
      if (e && e.refused) throw e;
      lastErr = String(e && e.message || e).slice(0, 120);
      ctx.report('film_storyboard_failed', `attempt=${attempt} ${e && e.detail ? e.detail : lastErr}`);
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
  const png = await ctx.engines.still({ prompt });
  const f = ctx.file('reference.png');
  await writeFile(f, png);
  ctx.generated.reference++;
  return ctx.save({ kind: 'reference', bytes: png, ext: 'png', mime: 'image/png', fingerprint: fp.reference, prompt, description: 'Character and style reference', costUsd: FILM_PRICES.stillUsd, thumbFrom: f });
}

async function ensureKeyframe(ctx, ref, fp, refUrl, { force = false, seed = null, attempt = 1 } = {}) {
  const key = fp.keyframes[ref.shot.id];
  if (!force) {
    const have = ctx.find('keyframe', key);
    if (have) { ctx.reused.keyframes++; return have; }
  }
  await ctx.paid(FILM_PRICES.stillUsd, `the still for shot ${ref.sceneIndex}.${ref.shotIndex}`);
  const prompt = stillPrompt(ctx.timeline, ref.shot);
  const png = await ctx.engines.still({ prompt, referenceUrl: refUrl, seed });
  const f = ctx.file(`key-${ref.shot.id}-a${attempt}.png`);
  await writeFile(f, png);
  ctx.generated.keyframes++;
  if (force) for (const a of ctx.assets) if (a.kind === 'keyframe' && a.fingerprint === key && a.status === 'ok' && a.id) { a.status = 'superseded'; await ctx.store.updateAsset(a.id, { status: 'superseded' }).catch(() => {}); }
  return ctx.save({ kind: 'keyframe', bytes: png, ext: 'png', mime: 'image/png', fingerprint: key, shotRef: ref, prompt, description: `Still: ${ref.shot.description}`, costUsd: FILM_PRICES.stillUsd, attempt, thumbFrom: f });
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
  const line = await ctx.engines.voice({ text: ref.shot.voiceover });
  ctx.generated.voice++;
  return ctx.save({
    kind: 'voice', bytes: line.wav, ext: 'wav', mime: 'audio/wav', fingerprint: key, shotRef: ref, prompt: ref.shot.voiceover,
    description: `Voiceover for ${ref.shot.description}: "${ref.shot.voiceover}"`, durationS: line.durationS, costUsd: cost, attempt,
    meta: { words: line.words }
  });
}

async function ensureMusic(ctx, scene, sceneIndex, fp) {
  const key = fp.music[scene.id];
  const have = ctx.find('music', key);
  if (have) { ctx.reused.music++; return have; }
  await ctx.paid(musicCostUsd(), `the music for scene ${sceneIndex}`);
  const bed = await ctx.engines.music({ mood: scene.music.mood, bpm: scene.music.bpm });
  ctx.generated.music++;
  return ctx.save({
    kind: 'music', bytes: bed.bytes, ext: bed.ext, mime: bed.mime, fingerprint: key, prompt: scene.music.mood,
    description: `Music for scene ${sceneIndex}${scene.title ? ` (${scene.title})` : ''}: ${scene.music.mood}, ${scene.music.bpm} bpm`, costUsd: musicCostUsd(),
    meta: { scene: sceneIndex, sceneId: scene.id, bpm: scene.music.bpm }
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
    const r = await ctx.engines.think({ system: QC_SYSTEM, content, effort: 'low', maxTokens: 4000 });
    return parseQcVerdict(r.text, { clipS, durationS: ref.shot.duration_s });
  } catch (e) {
    ctx.report('film_qc_failed', `shot=${ref.shot.id} ${e && e.detail ? e.detail : e && e.message}`);
    return { pass: true, score: null, issues: [{ type: 'other', detail: 'the check could not run' }], bestStartS: 0, description: '', unreadable: true };
  }
}

// One shot's clip, checked, with up to MAX_SHOT_RETRIES regenerations.
// Resolves to { asset, file, durationS, verdict, attempts }.
async function ensureClip(ctx, ref, fp, { refAsset, refFile, startFrame, prevFrameFile }) {
  const key = fp.clips[ref.shot.id];
  const have = clipFingerprints(key).map((f) => ctx.find('clip', f)).find(Boolean);
  if (have) {
    ctx.reused.clips++;
    const file = await ctx.local(have, `clip-${ref.shot.id}.mp4`);
    return { asset: have, file, durationS: Number(have.duration_s) || await ctx.ff.probeDuration(file), verdict: (have.meta && have.meta.qc) || null, attempts: 0, reused: true };
  }
  const seconds = clipSecondsFor(ref.shot);
  const tier = ctx.timeline.tier;
  const tries = [];
  let best = null;
  let start = startFrame;
  for (let attempt = 1; attempt <= 1 + MAX_SHOT_RETRIES; attempt++) {
    const cost = clipCostUsd(tier, seconds) + FILM_PRICES.qcUsd;
    await ctx.paid(cost, `the clip for shot ${ref.sceneIndex}.${ref.shotIndex}`);
    if (attempt > 1) ctx.generated.retries++;
    // The second retry of a shot that starts from its own still draws a new
    // still too: the problem may be in the still itself.
    if (attempt === 3 && !ref.shot.continuous) {
      const k = await ensureKeyframe(ctx, ref, fp, await ctx.store.sign(refAsset.storage_path, 3600), { force: true, seed: 1000 + attempt, attempt });
      start = { asset: k, url: await ctx.store.sign(k.storage_path, 3600) };
    }
    const issues = best ? best.verdict.issues : [];
    const prompt = attempt === 1 ? clipPrompt(ctx.timeline, ref.shot) : retryPrompt(clipPrompt(ctx.timeline, ref.shot), issues);
    let bytes;
    try {
      bytes = await ctx.engines.clip({ prompt, startImageUrl: start.url, tier, seconds });
    } catch (e) {
      if (e instanceof CapReached) throw e;
      ctx.report('film_clip_failed', `shot=${ref.shot.id} attempt=${attempt} ${e && e.detail ? e.detail : e && e.message}`);
      tries.push({ attempt, error: e && e.refused ? 'refused' : 'engine_error' });
      continue;
    }
    const file = ctx.file(`clip-${ref.shot.id}-a${attempt}.mp4`);
    await writeFile(file, bytes);
    const durationS = await ctx.ff.probeDuration(file);
    const verdict = await checkClip(ctx, ref, file, durationS, refFile, prevFrameFile);
    tries.push({ attempt, pass: verdict.pass, score: verdict.score, issues: verdict.issues });
    const cand = { bytes, file, durationS, verdict, attempt };
    if (!best || (verdict.pass && !best.verdict.pass) || (verdict.pass === best.verdict.pass && (verdict.score || 0) > (best.verdict.score || 0))) best = cand;
    ctx.generated.clips++;
    if (verdict.pass) break;
  }
  if (!best) throw Object.assign(new Error(`shot ${ref.sceneIndex}.${ref.shotIndex} could not be generated`), { code: 'engine_error' });
  const asset = await ctx.save({
    kind: 'clip', bytes: best.bytes, ext: 'mp4', mime: 'video/mp4', fingerprint: key, shotRef: ref, prompt: clipPrompt(ctx.timeline, ref.shot),
    description: best.verdict.description || ref.shot.description, durationS: best.durationS, attempt: best.attempt,
    costUsd: clipCostUsd(tier, seconds), thumbFrom: best.file, thumbAtS: Math.min(1, best.durationS / 2),
    meta: { qc: best.verdict, attempts: tries, shotDescription: ref.shot.description, camera: ref.shot.camera, flagged: !best.verdict.pass }
  });
  return { asset, file: best.file, durationS: best.durationS, verdict: best.verdict, attempts: tries.length };
}

// Runs `fn` over items with at most `n` at once, in order of start.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  let failed = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { failed = failed || e; }
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
    for (const ref of shots.filter(needStill)) {
      keyAssets[ref.shot.id] = await ensureKeyframe(ctx, ref, fp, refUrl);
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
  if (stage === 'full') {
    const concurrency = Math.max(1, Math.min(4, Number(env.PG1_FILM_CONCURRENCY) || 3));
    await pool(shotChains(timeline), concurrency, async (chain) => {
      let prev = null;
      for (const ref of chain) {
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
        const c = await ensureClip(ctx, ref, fp, { refAsset, refFile, startFrame, prevFrameFile });
        clips[ref.shot.id] = { durationS: c.durationS, bestStartS: c.verdict ? c.verdict.bestStartS : 0 };
        clipFiles[ref.shot.id] = c.file;
        qcShots.push({ shotId: ref.shot.id, scene: ref.sceneIndex, shot: ref.shotIndex, description: ref.shot.description, reused: !!c.reused, attempts: c.attempts, pass: c.verdict ? c.verdict.pass : null, score: c.verdict ? c.verdict.score : null, issues: c.verdict ? c.verdict.issues : [] });
        prev = c;
        await step(`Clip ${ref.sceneIndex}.${ref.shotIndex}`);
      }
    });
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
    generated: ctx.generated, reused: ctx.reused
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
