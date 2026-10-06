// PG1 Motion's names, tiers, prices and wording, with no engine code:
// lib/chatTools.mjs and lib/chatRoute.mjs import this file, and they sit on
// the public playground's import path, which must never reach a model API
// (the engine itself is lib/videoJobs.mjs, which re-exports everything here).

export const VIDEO_ENGINE_LABEL = 'PG1 Motion';
export const VIDEO_TOOL = 'generate_video';
export const MAX_VIDEO_PROMPT_CHARS = 2000;

// --- tiers -----------------------------------------------------------------------

// The operator picks one per clip. No 4K tier.
//   draft     Google 360p,  Kling mode "standard"
//   standard  Google 720p,  Kling mode "standard"  (the default)
//   pro       Google 1080p (upscaled), Kling mode "pro"
export const VIDEO_TIERS = Object.freeze(['draft', 'standard', 'pro']);
export const DEFAULT_VIDEO_TIER = 'standard';
export const VIDEO_TIER_LABELS = Object.freeze({ draft: 'Draft', standard: 'Standard', pro: 'Pro' });
export const VIDEO_TIER_SETTINGS = Object.freeze({
  draft: Object.freeze({ googleResolution: '360p', klingMode: 'standard' }),
  standard: Object.freeze({ googleResolution: '720p', klingMode: 'standard' }),
  pro: Object.freeze({ googleResolution: '1080p', klingMode: 'pro' })
});

// "short" is 5 s, "long" is 10 s; 5 s unless asked.
export const VIDEO_DURATIONS = Object.freeze([5, 10]);
export const DEFAULT_VIDEO_DURATION_S = 5;

// --- prices: the one table ---------------------------------------------------------

// Every cost PG1 shows or reserves comes from here.
//   google  per second of output, by resolution (USD).
//   kling   kwaivgi/kling-v2.1 on Replicate, per clip (USD). ESTIMATES:
//           Replicate bills Kling per run, and these are PG1's estimates
//           for a 5 s and a 10 s clip in each mode, not quoted prices.
export const VIDEO_PRICES = Object.freeze({
  google: Object.freeze({ perSecondUsd: Object.freeze({ '360p': 0.03, '720p': 0.10, '1080p': 0.15 }) }),
  kling: Object.freeze({
    estimated: true,
    perClipUsd: Object.freeze({
      standard: Object.freeze({ 5: 0.30, 10: 0.60 }),
      pro: Object.freeze({ 5: 0.50, 10: 1.00 })
    })
  })
});

const round2 = (n) => Math.round(n * 100) / 100;

export function googleClipCost(tier, durationS) {
  const res = (VIDEO_TIER_SETTINGS[tier] || VIDEO_TIER_SETTINGS[DEFAULT_VIDEO_TIER]).googleResolution;
  return round2(VIDEO_PRICES.google.perSecondUsd[res] * durationS);
}

export function klingClipCost(tier, durationS) {
  const mode = (VIDEO_TIER_SETTINGS[tier] || VIDEO_TIER_SETTINGS[DEFAULT_VIDEO_TIER]).klingMode;
  return VIDEO_PRICES.kling.perClipUsd[mode][durationS === 10 ? 10 : 5];
}

// What a clip reserves: the dearest provider that could make it, so a
// fallback never needs a second reservation. Kling only makes clips with a
// starting frame, and only when the fallback is configured (`kling`).
export function videoClipEstimate(tier, durationS, { kling = false } = {}) {
  const g = googleClipCost(tier, durationS);
  return kling ? Math.max(g, klingClipCost(tier, durationS)) : g;
}

export function usd(n) {
  return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
}

// --- reading the operator's choice ---------------------------------------------------

const DRAFT_RE = /\b(?:draft|quick|cheap(?:er|est)?|low[\s-]?(?:res|cost|quality))\b/i;
const PRO_RE = /\b(?:pro[\s-]+(?:video|clip|quality)|high[\s-]?quality|hq|hd|1080p|full\s+hd|4k|uhd|2160p)\b/i;
const FOUR_K_RE = /\b(?:4k|uhd|2160p)\b/i;
const LONG_RE = /\blong(?:er)?\b/i;
const SHORT_RE = /\bshort\b/i;
const SECONDS_RE = /\b(\d{1,2})[- ]?(?:s|sec|secs|second|seconds)\b/i;

// Tier, length and the prompt left over. For /video, leading words choose
// the tier and length ("/video pro long a lighthouse"); in a plain request
// the words anywhere do ("make a quick video of..."). 4K is not offered: it
// is read as pro (1080p) and `fourK` says it was asked for.
export function parseVideoOptions(text, { command = false } = {}) {
  let rest = String(text || '').trim();
  let tier = null;
  let durationS = null;
  if (command) {
    for (;;) {
      const m = rest.match(/^(draft|standard|pro|short|long)\b[\s,:-]*/i);
      if (!m) break;
      const w = m[1].toLowerCase();
      if (w === 'short') durationS = 5;
      else if (w === 'long') durationS = 10;
      else tier = w;
      rest = rest.slice(m[0].length);
    }
  }
  const fourK = FOUR_K_RE.test(text);
  if (!tier) tier = DRAFT_RE.test(rest) ? 'draft' : PRO_RE.test(rest) ? 'pro' : DEFAULT_VIDEO_TIER;
  if (!durationS) {
    const secs = rest.match(SECONDS_RE);
    if (secs) durationS = Number(secs[1]) > 7 ? 10 : 5;
    else if (LONG_RE.test(rest)) durationS = 10;
    else if (SHORT_RE.test(rest)) durationS = 5;
    else durationS = DEFAULT_VIDEO_DURATION_S;
  }
  return { tier, durationS, fourK, rest: rest.trim() };
}

// --- what the operator reads -----------------------------------------------------------

// "PG1 Motion · Pro · 5 s · about 0.75 USD · 3.20 USD left today"
export function videoCostLine({ tier, durationS, estCost, remaining }) {
  return `${VIDEO_ENGINE_LABEL} · ${VIDEO_TIER_LABELS[tier] || tier} · ${durationS} s · about ${usd(estCost)} USD · ${usd(remaining)} USD left today`;
}

// Cheaper choices that still fit what is left today, dearest first.
export function cheaperVideoOptions(remaining, { kling = false, below = Infinity } = {}) {
  const out = [];
  for (const tier of VIDEO_TIERS) {
    for (const s of VIDEO_DURATIONS) {
      const cost = videoClipEstimate(tier, s, { kling });
      if (cost <= remaining + 1e-9 && cost < below) out.push({ tier, durationS: s, cost });
    }
  }
  return out.sort((a, b) => b.cost - a.cost);
}

function optionText(o) {
  const cmd = `/video ${o.tier === DEFAULT_VIDEO_TIER ? '' : o.tier + ' '}${o.durationS === 10 ? 'long ' : ''}…`.replace(/\s+…/, ' …');
  return `${VIDEO_TIER_LABELS[o.tier]} · ${o.durationS} s, about ${usd(o.cost)} USD (${cmd})`;
}

export function videoOverBudgetText({ tier, durationS, estCost, remaining, budget, kling = false }) {
  const head = `That clip (${VIDEO_TIER_LABELS[tier]} · ${durationS} s, about ${usd(estCost)} USD) would go over today's video budget: ${usd(remaining)} USD left of ${usd(budget)} USD.`;
  const options = cheaperVideoOptions(remaining, { kling, below: estCost }).slice(0, 2);
  if (!options.length) return `${head} Nothing fits in what is left today; the budget resets at midnight UTC.`;
  return `${head} Try ${options.map(optionText).join(', or ')}.`;
}

export function videoClipLimitText(maxClips) {
  return `Today's clip limit is reached (${maxClips} of ${maxClips}). It resets at midnight UTC.`;
}

// The bare /video answer: tiers, prices and what is left, nothing started.
export function videoTiersText({ remaining = null, budget, kling = false } = {}) {
  const lines = ['### [ PG1 MOTION ]', 'Usage: /video [draft|pro] [short|long] <what the clip shows>. Standard and short (5 s) are the defaults; long is 10 s. 4K is not offered.'];
  for (const tier of VIDEO_TIERS) {
    const res = VIDEO_TIER_SETTINGS[tier].googleResolution;
    lines.push(`- **${VIDEO_TIER_LABELS[tier]}**${tier === DEFAULT_VIDEO_TIER ? ' (default)' : ''} · ${res}${tier === 'pro' ? ' (upscaled)' : ''}: about ${usd(googleClipCost(tier, 5))} USD for 5 s, ${usd(googleClipCost(tier, 10))} USD for 10 s`);
  }
  if (kling) lines.push(`- With an attached image as the first frame, a clip can cost up to: ${VIDEO_TIERS.map((t) => `${VIDEO_TIER_LABELS[t]} ${usd(videoClipEstimate(t, 5, { kling }))} / ${usd(videoClipEstimate(t, 10, { kling }))}`).join(', ')} USD (5 s / 10 s)`);
  lines.push('Costs are estimates; a clip that fails still counts against the day.');
  lines.push(remaining == null ? `Daily budget: ${usd(budget)} USD (today's spend could not be read right now).` : `${usd(remaining)} USD left today of ${usd(budget)} USD.`);
  return lines.join('\n');
}

// Wider than isVideoRequest (lib/videoJobs.mjs): a message that talks about
// making a clip in words the strict match misses ("could you show me a
// little clip of the sea?"). Such a message goes the chat tools way when
// generate_video is on offer, and the model decides whether it is a request
// (lib/chatRoute.mjs).
const VIDEO_MENTION_RE = /\b(?:videos?|clips?|animations?|animate)\b/i;
export function mentionsVideo(text) {
  return VIDEO_MENTION_RE.test(String(text || ''));
}
