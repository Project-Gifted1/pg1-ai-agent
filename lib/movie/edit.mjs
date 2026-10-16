// PG1 Studio movies: the edit. Assembled from the shot list and the takes
// that were accepted, fitted to their real lengths:
//
//  - a dialogue shot runs from just before its line to just after it (the
//    speech span found in the take), so the line plays whole and in sync;
//  - every other shot plays its planned length from its best start, or less
//    when the take is shorter: a shot is never padded with a held frame (it
//    is shortened; a take that is too short for its line would have failed
//    the dailies and been retaken);
//  - cut on action: a shot marked cutOnAction starts CUT_ON_ACTION_S into its
//    take, picking the movement up mid-way;
//  - J and L cuts on dialogue: as the speakers alternate, the outgoing line's
//    sound runs on under the next picture (L) or the incoming line's sound
//    starts before its picture (J), by JL_S, wherever the takes have the
//    handles for it;
//  - one grade for every shot (the bible's look), a title card first and the
//    end credits last, each faded from and to black.
//
// The plan also places every sound: dialogue cues (the converted lines),
// narration (only with --voice), a sound effect per action shot, and one
// span per scene for its ambience and its score; the first scene starts
// under the title, the last runs under the credits, so the audio covers the
// whole runtime.

export const LEAD_S = 0.35;
export const TAIL_S = 0.35;
export const JL_S = 0.3;
export const MIN_JL_S = 0.12;
export const CUT_ON_ACTION_S = 0.25;
export const TITLE_S = 3;
export const TITLE_FADE_S = 0.5;
export const CREDITS_FADE_S = 0.6;
export const MIN_SHOT_PLAY_S = 0.8;

const r3 = (n) => Math.round(n * 1000) / 1000;

// takes: { shotId: { clipS, speech: { startS, endS } | null, bestStartS } }
// Resolves to { segments, joins, totalS, dialogue, narration, effects,
// scenes, titles, crawl, jl }.
export function planMovieEdit({ title, shots, takes, credits = [], creditsS = 8, trims = {} }) {
  const segments = [];
  const joins = [];
  segments.push({ kind: 'card', text: title, durationS: TITLE_S });
  let prev = null;
  for (const shot of shots) {
    const t = takes[shot.id];
    if (!t) continue;
    const clipS = Number(t.clipS) || shot.clipS;
    let inS;
    let dur;
    if (shot.kind === 'dialogue' && t.speech) {
      inS = Math.max(0, t.speech.startS - LEAD_S);
      const out = Math.min(clipS, t.speech.endS + TAIL_S);
      dur = out - inS;
    } else {
      inS = Math.max(0, Math.min(Number(t.bestStartS) || 0, clipS - Math.min(shot.durationS, clipS)));
      if (shot.cutOnAction && prev && prev.shot.kind === 'action') inS = Math.min(clipS - MIN_SHOT_PLAY_S, inS + CUT_ON_ACTION_S);
      dur = Math.min(shot.durationS, clipS - inS);
    }
    // The QC gate's fix for a held frame: the shot played shorter.
    if (trims[shot.id]) dur = Math.max(MIN_SHOT_PLAY_S, dur - trims[shot.id]);
    dur = Math.max(Math.min(MIN_SHOT_PLAY_S, clipS - inS), Math.min(dur, clipS - inS));
    joins.push(segments.length === 1 ? { transition: 'fade_black', durationS: TITLE_FADE_S } : { transition: 'cut', durationS: 0, ...(shot.cutOnAction ? { cutOnAction: true } : {}) });
    const seg = { kind: 'shot', shotId: shot.id, sceneId: shot.sceneId, shotKind: shot.kind, inS: r3(inS), durationS: r3(dur), clipS, speaker: shot.speaker || null };
    segments.push(seg);
    prev = { shot, seg };
  }
  if (credits.length) {
    joins.push({ transition: 'fade_black', durationS: CREDITS_FADE_S });
    segments.push({ kind: 'crawl', durationS: creditsS });
  }
  let t = 0;
  segments.forEach((s, i) => {
    if (i > 0) t = t + segments[i - 1].durationS - joins[i - 1].durationS;
    s.startS = r3(t);
  });
  const last = segments[segments.length - 1];
  const totalS = r3(last.startS + last.durationS);

  // Dialogue: each line from its take's converted audio, where its picture
  // plays, then the J and L cuts.
  const shotSegs = segments.filter((s) => s.kind === 'shot');
  const dialogue = shotSegs.filter((s) => s.shotKind === 'dialogue').map((s) => ({ shotId: s.shotId, srcInS: s.inS, atS: s.startS, durationS: s.durationS }));
  const jl = [];
  let pair = 0;
  for (let i = 1; i < shotSegs.length; i++) {
    const a = shotSegs[i - 1];
    const b = shotSegs[i];
    if (a.shotKind !== 'dialogue' || b.shotKind !== 'dialogue' || !a.speaker || a.speaker === b.speaker) continue;
    const ca = dialogue.find((d) => d.shotId === a.shotId);
    const cb = dialogue.find((d) => d.shotId === b.shotId);
    // As much of JL_S as the takes have room for (at least MIN_JL_S).
    const lRoom = Math.min(JL_S, a.clipS - (a.inS + a.durationS));
    const jRoom = Math.min(JL_S, b.inS);
    if (pair % 2 === 0 && lRoom >= MIN_JL_S) {
      ca.durationS = r3(ca.durationS + lRoom);
      jl.push({ kind: 'L', from: a.shotId, to: b.shotId, cutS: b.startS, s: r3(lRoom) });
    } else if (jRoom >= MIN_JL_S) {
      cb.srcInS = r3(cb.srcInS - jRoom);
      cb.atS = r3(cb.atS - jRoom);
      cb.durationS = r3(cb.durationS + jRoom);
      jl.push({ kind: 'J', from: a.shotId, to: b.shotId, cutS: b.startS, s: r3(jRoom) });
    } else if (lRoom >= MIN_JL_S) {
      ca.durationS = r3(ca.durationS + lRoom);
      jl.push({ kind: 'L', from: a.shotId, to: b.shotId, cutS: b.startS, s: r3(lRoom) });
    }
    pair++;
  }
  const byId = new Map(shots.map((s) => [s.id, s]));
  const narration = [];
  for (const s of shotSegs) for (const [k, text] of (byId.get(s.shotId).narration || []).entries()) narration.push({ shotId: s.shotId, text, atS: r3(s.startS + 0.3 + k * 0.1) });
  const effects = shotSegs.filter((s) => byId.get(s.shotId).sfx).map((s) => ({ shotId: s.shotId, atS: r3(s.startS + 0.15), durationS: s.durationS, text: byId.get(s.shotId).sfx }));
  const sceneIds = [...new Set(shotSegs.map((s) => s.sceneId))];
  const scenes = sceneIds.map((id, k) => {
    const segs = shotSegs.filter((s) => s.sceneId === id);
    const startS = k === 0 ? 0 : segs[0].startS;
    const endS = k === sceneIds.length - 1 ? totalS : segs[segs.length - 1].startS + segs[segs.length - 1].durationS;
    return { sceneId: id, startS: r3(startS), endS: r3(endS) };
  });
  const titles = [{ startS: 0.2, endS: r3(TITLE_S - 0.2), text: title, style: 'Card' }];
  const crawlSeg = segments.find((s) => s.kind === 'crawl');
  const crawl = crawlSeg ? { startS: crawlSeg.startS, endS: r3(crawlSeg.startS + crawlSeg.durationS), lines: credits } : null;
  return { segments, joins, totalS, dialogue, narration, effects, scenes, titles, crawl, jl };
}

// The edit never holds a frame: every shot plays inside its take.
export function noPadding(plan) {
  return plan.segments.filter((s) => s.kind === 'shot').every((s) => s.inS >= 0 && s.inS + s.durationS <= s.clipS + 1e-6);
}

// The end credits: the title, the cast (character and voice names), PG1's
// lines; white-labelled, never a provider, a model or a copyright line.
export function movieCredits({ sp, cast, client = null, labels }) {
  const lines = [sp.title, ''];
  if (client) lines.push(`Made for ${client.name}`, '');
  lines.push('Cast');
  for (const c of sp.characters) {
    const v = cast && cast.characters ? Object.entries(cast.characters).find(([role]) => role.toLowerCase() === c.name.toLowerCase()) : null;
    lines.push(v && v[1] && v[1].name ? `${c.name} · voice ${v[1].name}` : c.name);
  }
  lines.push('', `Written, directed and edited by ${labels.studio}`, `Score and sound by ${labels.sound}`, `A ${labels.trademark} production`);
  return lines;
}
