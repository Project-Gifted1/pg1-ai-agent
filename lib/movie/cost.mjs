// PG1 Studio movies: the cost estimate per stage and in total, shown at
// checkpoint (b) before anything in the shoot is spent. Counts only what is
// not saved on the movie yet (a reference, an accepted take, a voiced line,
// a cue), so a retry or a retake is priced for what it will really make.
// ESTIMATES, from the registry's prices (lib/capabilities/registry.mjs);
// each paid call is charged against the movie's cap before it is made.

import { engineCostUsd, PRICE_MULTIPLIER } from '../capabilities/registry.mjs';
import { stillReserveUsd } from '../film/cost.mjs';
import { allRefs } from './bible.mjs';
import { allScenes } from './screenplay.mjs';

export const MOVIE_PRICES = Object.freeze({
  screenplayUsd: 0.15,
  dailiesUsd: 0.04,                 // one take reviewed by the critic
  scoreCueUsd: 0.08                 // one cue per scene (PG1 Sound)
});
// Retakes a failing shot may have after its first take.
export const MAX_RETAKES = 2;
// The share of shots expected to need one retake, for the expected figure.
export const EXPECTED_RETAKE_SHARE = 0.3;
export const CREDITS_S = 8;

const r2 = (n) => Math.round(n * 100) / 100;
export const clipUsd = (seconds) => (seconds > 0 ? engineCostUsd('video_gemini_1080', { seconds }) : 0);
export const stsUsd = (seconds) => Math.max(0.01, engineCostUsd('sts_elevenlabs', { seconds }));
export const sfxUsd = (seconds) => Math.max(0.01, engineCostUsd('sfx_elevenlabs', { seconds: Math.min(30, seconds) }));

// saved: { refs: Set(key), takes: Set(shotId), voiced: Set(shotId),
// ambience: Set(sceneId), effects: Set(shotId), score: Set(sceneId) }.
// Resolves to { stages: [{ stage, label, count, usd }], expectedUsd,
// worstUsd, stats }.
export function estimateMovie({ screenplay, bibles, shots, saved = {} } = {}) {
  const has = (k, id) => !!(saved[k] && saved[k].has(id));
  const refs = allRefs(bibles).filter((r) => !has('refs', r.key));
  const todo = shots.filter((s) => !has('takes', s.id));
  const speaking = shots.filter((s) => s.kind === 'dialogue' && !has('voiced', s.id));
  const scenes = allScenes(screenplay);
  const sceneLen = (sc) => shots.filter((s) => s.sceneId === sc.id).reduce((t, s) => t + s.durationS, 0);
  const amb = scenes.filter((sc) => !has('ambience', sc.id));
  const fx = shots.filter((s) => s.sfx && !has('effects', s.id));
  const cues = scenes.filter((sc) => !has('score', sc.id));
  const clipSeconds = todo.reduce((t, s) => t + s.clipS, 0);
  const stages = [
    { stage: 'bibles', label: 'Character and location bibles (reference images)', count: refs.length, usd: refs.length * stillReserveUsd() },
    { stage: 'shots', label: `Shots with on-screen speech, 1080p (${clipSeconds} s of picture)`, count: todo.length, usd: clipUsd(clipSeconds) },
    { stage: 'dailies', label: 'Dailies: every take checked (character, lip sync, artefacts, text)', count: todo.length, usd: todo.length * MOVIE_PRICES.dailiesUsd },
    { stage: 'voices', label: 'Dialogue in each character\'s cast voice', count: speaking.length, usd: speaking.reduce((t, s) => t + stsUsd(s.clipS), 0) },
    { stage: 'effects', label: 'Effects and ambience', count: amb.length + fx.length, usd: amb.reduce((t, sc) => t + sfxUsd(sceneLen(sc)), 0) + fx.reduce((t, s) => t + sfxUsd(s.durationS), 0) },
    { stage: 'score', label: 'Score (PG1 Sound), one cue per scene', count: cues.length, usd: cues.length * MOVIE_PRICES.scoreCueUsd },
    { stage: 'edit', label: 'Edit, mix, master and QC (runner time only)', count: 1, usd: 0 }
  ].map((s) => ({ ...s, usd: r2(s.usd) }));
  const base = stages.reduce((t, s) => t + s.usd, 0);
  const perRetake = todo.length ? (clipUsd(clipSeconds) + todo.length * MOVIE_PRICES.dailiesUsd + speaking.reduce((t, s) => t + stsUsd(s.clipS), 0)) / todo.length : 0;
  const expectedRetakes = Math.ceil(todo.length * EXPECTED_RETAKE_SHARE);
  const retakes = { stage: 'retakes', label: `Retakes (about ${expectedRetakes} expected; at most ${MAX_RETAKES} per shot)`, count: expectedRetakes, usd: r2(expectedRetakes * perRetake) };
  return {
    stages: [...stages, retakes],
    expectedUsd: r2(base + retakes.usd),
    worstUsd: r2(base + todo.length * MAX_RETAKES * perRetake),
    stats: { shots: shots.length, newShots: todo.length, clipSeconds, references: refs.length }
  };
}

export function estimateMovieText(est, { capUsd, spentUsd = 0, priceUsd = null } = {}) {
  const usd = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  return [
    ...est.stages.filter((s) => s.count > 0 || s.stage === 'edit').map((s) => `- ${s.label}${s.count > 1 ? ` ×${s.count}` : ''}: about ${usd(s.usd)} USD`),
    `Total: about ${usd(est.expectedUsd)} USD (up to ${usd(est.worstUsd)} USD if every shot needs both retakes). Cap for this movie: ${usd(capUsd)} USD, ${usd(Math.max(0, capUsd - spentUsd))} USD left.${priceUsd ? ` Package price ${usd(priceUsd)} USD: spend stops at ${usd(Math.floor((priceUsd / PRICE_MULTIPLIER) * 100) / 100)} USD.` : ''}`
  ].join('\n');
}
