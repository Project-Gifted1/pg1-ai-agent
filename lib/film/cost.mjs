// PG1 Studio prices and estimates. Every cost the operator sees before a
// film spends anything, and every charge against a film's cap, comes from
// this one table. They are ESTIMATES: the engines bill per run, and PG1
// charges each run's estimate against the cap before making the call
// (pg1_film_charge), so the cap holds even when a bill comes in later.
//
// Clips reuse PG1 Motion's own price table (lib/videoText.mjs), so a
// single /video clip and a film shot are estimated the same way.

import { klingClipCost, VIDEO_TIER_SETTINGS } from '../videoText.mjs';
import { flatShots } from './storyboard.mjs';
import { missingAssets, clipSecondsFor } from './timeline.mjs';

export const FILM_PRICES = Object.freeze({
  stillUsd: 0.04,             // one keyframe or reference still
  musicBedS: 30,              // one music bed per scene, about 30 s, looped
  musicPerSecondUsd: 0.002,
  voicePerCharUsd: 0.00005,   // about 0.05 USD per 1,000 characters
  transcribePerSecondUsd: 0.0002,
  storyboardUsd: 0.15,        // one storyboard
  editUsd: 0.03,              // turning a spoken edit into timeline changes
  qcUsd: 0.04                 // one shot checked against its description
});

// Retries a failed shot may have after its first attempt.
export const MAX_SHOT_RETRIES = 2;
// The share of shots expected to need one retry, for the expected figure.
export const EXPECTED_RETRY_SHARE = 0.25;
export const DEFAULT_FILM_CAP_USD = 20;

const round2 = (n) => Math.round(n * 100) / 100;

export function filmCapUsd(env = {}) {
  const raw = String(env.PG1_FILM_MAX_USD == null ? '' : env.PG1_FILM_MAX_USD).trim();
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(raw)) return DEFAULT_FILM_CAP_USD;
  return Number(raw);
}

export function clipCostUsd(tier, seconds) {
  // Draft films use the standard clip mode; no film clip is cheaper.
  const t = VIDEO_TIER_SETTINGS[tier] ? tier : 'standard';
  return klingClipCost(t, seconds === 10 ? 10 : 5);
}

export function voiceCostUsd(text) {
  return round2(String(text || '').length * FILM_PRICES.voicePerCharUsd);
}

export function musicCostUsd() {
  return round2(FILM_PRICES.musicBedS * FILM_PRICES.musicPerSecondUsd);
}

// The estimate for one render stage, counting only what is not stored yet
// (`stored`, a Set of "kind:fingerprint"; empty for a new film).
// Resolves to { stage, lines: [{ label, count, usd }], expectedUsd,
// worstUsd, missing } — worstUsd assumes every shot needs both retries.
export function estimateStage(timeline, { stage = 'full', stored = new Set(), voiceKey = '', withStoryboard = false } = {}) {
  const missing = missingAssets(timeline, stored, { stage, voiceKey });
  const byId = new Map(flatShots(timeline).map((x) => [x.shot.id, x]));
  const lines = [];
  const add = (label, count, usd) => { if (count > 0 && usd > 0) lines.push({ label, count, usd: round2(usd) }); };
  if (withStoryboard) add('Storyboard', 1, FILM_PRICES.storyboardUsd);
  add('Reference still', missing.reference ? 1 : 0, FILM_PRICES.stillUsd);
  add('Shot stills', missing.keyframes.length, missing.keyframes.length * FILM_PRICES.stillUsd);
  const clipUsd = missing.clips.reduce((s, id) => s + clipCostUsd(timeline.tier, clipSecondsFor(byId.get(id).shot)), 0);
  add('Video clips', missing.clips.length, clipUsd);
  add('Shot checks', missing.clips.length, missing.clips.length * FILM_PRICES.qcUsd);
  const voiceUsd = missing.voice.reduce((s, id) => s + voiceCostUsd(byId.get(id).shot.voiceover), 0);
  add('Voiceover lines', missing.voice.length, Math.max(voiceUsd, missing.voice.length ? 0.01 : 0));
  add('Music beds', missing.music.length, missing.music.length * musicCostUsd());
  if (stage === 'full') {
    const seconds = flatShots(timeline).reduce((s, x) => s + x.shot.duration_s, 0);
    add('Final audio check', 1, Math.max(0.01, seconds * FILM_PRICES.transcribePerSecondUsd));
  }
  const base = lines.reduce((s, l) => s + l.usd, 0);
  const perShotRetry = missing.clips.length ? (clipUsd + missing.clips.length * (FILM_PRICES.qcUsd + FILM_PRICES.stillUsd)) / missing.clips.length : 0;
  const expectedUsd = round2(base + Math.ceil(missing.clips.length * EXPECTED_RETRY_SHARE) * perShotRetry);
  const worstUsd = round2(base + missing.clips.length * MAX_SHOT_RETRIES * perShotRetry);
  return { stage, lines, expectedUsd, worstUsd, missing };
}

export function estimateText(est, { capUsd, spentUsd = 0 } = {}) {
  const left = round2(Math.max(0, capUsd - spentUsd));
  const items = est.lines.map((l) => `- ${l.label}${l.count > 1 ? ` ×${l.count}` : ''}: about ${l.usd.toFixed(2)} USD`);
  return [
    ...(items.length ? items : ['- Nothing new to generate: only the edit is re-rendered']),
    `Estimate: about ${est.expectedUsd.toFixed(2)} USD (up to ${est.worstUsd.toFixed(2)} USD if every shot needs both retries). Cap for this film: ${capUsd.toFixed(2)} USD, ${left.toFixed(2)} USD left.`
  ].join('\n');
}

// Whether a stage may start: its expected cost has to fit under what is
// left of the cap. Retries beyond that stop at the cap.
export function fitsCap(est, { capUsd, spentUsd = 0 }) {
  return est.expectedUsd <= capUsd - spentUsd + 1e-9;
}
