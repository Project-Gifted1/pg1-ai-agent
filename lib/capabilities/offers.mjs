// What PG1 may offer in a Studio or Sound package, decided from the
// capability registry (lib/capabilities/registry.mjs), not by the model.
//
//   offerability(entry)   'offer'       standard and commercial_ok: may be
//                                       offered as part of a package
//                         'on_request'  custom and commercial_ok: only as
//                                       "custom, on request"
//                         'review'      licence unclear: never offered to a
//                                       client until the operator settles it
//                         'never'       unavailable, non-commercial, or
//                                       gated to a later phase
//   offersDirective()     the [OFFERS] block in every chat prompt
//   offerViolations(text) what a reply or document offers that it may not:
//                         client accounts or seats, account managers,
//                         dedicated compute, IP indemnification, exclusive
//                         rights, an unavailable or gated feature, a custom
//                         feature not marked as custom, ownership or
//                         "no filters" promises
//   offerNote(v)          the line appended to a reply that broke the rules
//
// Pure functions; api/chat.mjs and lib/pdf/chat.mjs wire them in.

import { REGISTRY, NOT_OFFERED, LICENCE_QUESTIONS, capability } from './registry.mjs';

// Phases that have shipped. Voice cloning (phase 4) is offered only once 4
// is listed here, and then only as consented own-voice cloning.
export const SHIPPED_PHASES = Object.freeze([1]);

export function phaseShipped(phase, shipped = SHIPPED_PHASES) {
  const n = Number(String(phase || '').replace(/^phase/i, ''));
  return Number.isInteger(n) && shipped.includes(n);
}

export function offerability(entry, { shipped = SHIPPED_PHASES } = {}) {
  if (!entry) return 'never';
  if (entry.status === 'unavailable') return 'never';
  if (entry.gatedUntil && !phaseShipped(entry.gatedUntil, shipped)) return 'never';
  if (entry.licence === 'non_commercial') return 'never';
  if (entry.licence !== 'commercial_ok') return 'review';
  return entry.status === 'standard' ? 'offer' : 'on_request';
}

const money = (n) => (n == null ? null : n >= 1 ? n.toFixed(2) : String(Number(n.toFixed(4))));

export function minPriceText(entry) {
  const p = entry.minPrice;
  if (!p || p.usd == null) return 'quoted after a priced test run';
  return `at least ${money(p.usd)} USD per ${p.unit}${p.basis === 'pg1_estimate' ? ' (from PG1\'s own cost estimate)' : ''}`;
}

// --- wording every package and client document uses -----------------------------

// Item 2: what the safety filters do, said the same way every time.
export const SAFETY_WORDING = 'Every request passes PG1\'s own content checks and the generation providers\' safety filters. PG1 does not make sexual content, content about real people without their consent, real artists\' voices or styles, copyrighted characters, songs or lyrics, or brand logos. A shot or track a filter declines is reworded or replaced, and a declined attempt is not charged twice.';

// Item 3: the rights wording. No ownership transfer, no exclusivity, no
// indemnity.
export const RIGHTS_WORDING = 'The client may use the delivered files commercially as the licence of each deliverable allows (the conditions are listed with it). PG1 does not transfer copyright, does not grant exclusive rights and does not provide IP indemnification. In some countries material made with AI may not be protected by copyright.';

// --- the [OFFERS] prompt block ---------------------------------------------------

export function offersDirective({ shipped = SHIPPED_PHASES } = {}) {
  const by = { offer: [], on_request: [], review: [], never: [] };
  for (const e of REGISTRY) by[offerability(e, { shipped })].push(e);
  const line = (e) => `${e.feature} (${minPriceText(e)})`;
  const reviewLine = (e) => `${e.feature} [licence question ${e.review.join(', ') || 'open'}]`;
  const neverLine = (e) => `${e.feature}${e.status === 'unavailable' ? ' (no provider offers it)' : e.gatedUntil ? ' (not before a later phase)' : ' (non-commercial licence)'}`;
  return [
    '[OFFERS]: When you propose or describe a PG1 Studio or PG1 Sound package, offer, quote or price list, only these rules apply (they come from PG1\'s capability registry):',
    `- May be included in a package: ${by.offer.map(line).join('; ') || 'none yet'}.`,
    `- Only as "custom, on request" (never as included, never with a firm delivery promise): ${by.on_request.map(line).join('; ') || 'none'}.`,
    `- Not offered to clients until the operator settles its licence (say "licence under review" if the operator asks; never put it in a client offer): ${by.review.map(reviewLine).join('; ') || 'none'}.`,
    `- Never offered: ${by.never.map(neverLine).join('; ')}; and ${NOT_OFFERED.map((n) => n.label).join(', ')}.`,
    `- Voice cloning: ${phaseShipped('phase4', shipped) ? 'only consented cloning of the client\'s own voice, verified by the provider.' : 'not offered at all yet.'}`,
    '- A price is never below the minimum shown. Say which figures are PG1\'s own estimates.',
    `- Rights, in these words: ${RIGHTS_WORDING}`,
    `- Safety, in these words: ${SAFETY_WORDING}`,
    '- Never promise ownership of all rights, exclusivity, indemnity, "no restrictions", "no filters" or "any content".'
  ].join('\n');
}

// --- checking text ----------------------------------------------------------------

// A sentence that declines, excludes or limits the thing it names is not an
// offer ("PG1 does not provide IP indemnification", "no 8K").
const NEGATION_RE = /\b(?:no|not|never|without|exclud(?:e|es|ed|ing)|isn['’]?t|aren['’]?t|doesn['’]?t|don['’]?t|won['’]?t|cannot|can['’]?t|unavailable|not\s+available|not\s+offered|not\s+included|except|neither|nor|unable)\b/i;
const CUSTOM_RE = /\b(?:custom|on\s+request|by\s+request|upon\s+request|bespoke\s+quote|quoted\s+separately)\b/i;

const NOT_OFFERED_RES = Object.freeze({
  client_accounts: /\b(?:client|team|customer|user|studio)\s+(?:accounts?|logins?|portals?|dashboards?)\b|\b(?:seats?|per[- ]seat|multi[- ]seat|team\s+seats?|user\s+seats?)\b/i,
  account_manager: /\b(?:dedicated\s+|personal\s+)?account\s+managers?\b|\bdedicated\s+(?:producer|support\s+manager|success\s+manager)\b|\bcustomer\s+success\s+managers?\b/i,
  dedicated_compute: /\bdedicated\s+(?:compute|gpus?|servers?|render\s+(?:farm|nodes?|capacity)|capacity|instances?|hardware)\b|\breserved\s+(?:gpus?|compute|capacity)\b/i,
  ip_indemnification: /\bindemni(?:fy|fies|fied|fication|ty|ties)\b|\blegal\s+protection\s+against\s+(?:copyright|ip)\b/i,
  exclusive_rights: /\bexclusiv(?:e|ely|ity)\b[^.\n]{0,40}\b(?:rights?|licen[cs]es?|ownership|use|buyout)\b|\b(?:rights?|licen[cs]e)\b[^.\n]{0,20}\bexclusiv(?:e|ity)\b|\bbuy[- ]?out\b/i
});

// Ownership and filter promises (items 2 and 3).
const PROMISE_RES = Object.freeze([
  { id: 'ownership_promise', re: /\b(?:you|the\s+client|clients?)\s+(?:will\s+)?(?:own|get|receive|retain|keep)\s+(?:all|full|complete|100\s?%|total|the\s+full)\s+(?:the\s+)?(?:rights?|copyrights?|ownership|ip|intellectual\s+property)\b|\b(?:full|complete|100\s?%|total)\s+(?:copyright|ownership|ip\s+ownership)\b|\bcopyright\s+(?:transfer|assignment)\b/i, reason: 'PG1 does not transfer copyright or promise ownership of all rights; use the rights wording' },
  { id: 'no_filter_promise', re: /\b(?:no|without)\s+(?:content\s+)?(?:filters?|restrictions?|censorship|limits?\s+on\s+content)\b|\buncensored\b|\bany\s+content\s+you\s+(?:want|like)\b/i, reason: 'every request passes PG1\'s checks and the providers\' safety filters; use the safety wording' }
]);

// Registry features with words that name them in a reply.
const FEATURE_RES = Object.freeze({
  upscale_8k: /\b8\s?k\b/i,
  upscale_4k: /\b(?:4\s?k|2160p|uhd)\b[^.\n]{0,40}\b(?:upscal\w*|master|version|delivery|export|resolution|output)\b|\bupscal\w*\b[^.\n]{0,40}\b(?:4\s?k|2160p|uhd)\b/i,
  frame_interpolation: /\bframe[- ]interpolat\w*\b|\b(?:60|120)\s?fps\b|\bslow[- ]motion\s+(?:upgrade|conversion)\b/i,
  dialogue_tts: /\b(?:multi(?:ple)?[- ]?voices?|several\s+voices|multi[- ]speaker|dialogue\s+(?:voices?|tts|between))\b/i,
  sound_effects: /\b(?:sound\s+effects?|sfx|foley)\b/i,
  film_music: /\b(?:music|score|soundtrack|songs?|tracks?)\b[^.\n]{0,60}\b(?:films?|movies?|tv|television|broadcast|radio|cinema|trailers?)\b|\b(?:films?|movies?|tv|television|broadcast|radio|cinema|trailers?)\b[^.\n]{0,40}\b(?:music|score|soundtrack)\b/i,
  surround_upmix: /\b(?:5\.1|7\.1|surround(?:\s+sound|\s+mix)?|dolby\s+atmos|atmos)\b/i,
  voice_cloning: /\bvoice[- ]?clon\w*\b|\bclon(?:e|ed|ing)\s+(?:your|the\s+client['’]?s|their|a|any|someone['’]?s)?\s*voices?\b|\bcustom\s+voice\s+(?:model|clone)\b/i
});

function sentences(text) {
  return String(text || '')
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z*_(\[|-])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

// [{ id, kind, label, reason, sentence }], one per rule broken (first
// sentence that breaks it).
export function offerViolations(text, { shipped = SHIPPED_PHASES } = {}) {
  const out = [];
  const seen = new Set();
  const add = (v) => { if (!seen.has(v.id)) { seen.add(v.id); out.push(v); } };
  for (const s of sentences(text)) {
    const negated = NEGATION_RE.test(s);
    for (const n of NOT_OFFERED) {
      if (!negated && NOT_OFFERED_RES[n.id].test(s)) add({ id: n.id, kind: 'not_offered', label: n.label, reason: n.never ? 'PG1 never offers it' : 'PG1 does not offer it yet', sentence: s.slice(0, 200) });
    }
    for (const p of PROMISE_RES) {
      // "no filters" is itself a negation, so it is checked regardless.
      if (p.re.test(s) && (p.id === 'no_filter_promise' || !negated)) add({ id: p.id, kind: 'promise', label: p.id === 'ownership_promise' ? 'ownership of all rights' : 'no content filters', reason: p.reason, sentence: s.slice(0, 200) });
    }
    if (negated) continue;
    for (const [id, re] of Object.entries(FEATURE_RES)) {
      if (!re.test(s)) continue;
      const e = capability(id);
      const o = offerability(e, { shipped });
      if (id === 'voice_cloning' && o !== 'never' && /\b(?:any|someone|another|other\s+people|celebrit|famous|their)\b/i.test(s)) {
        add({ id, kind: 'feature', label: e.feature, reason: 'only consented cloning of the client\'s own voice', sentence: s.slice(0, 200) });
        continue;
      }
      if (o === 'never') add({ id, kind: 'feature', label: e.feature, reason: e.status === 'unavailable' ? 'no provider offers it' : e.gatedUntil ? 'not offered before a later phase' : 'its licence does not allow commercial use', sentence: s.slice(0, 200) });
      else if (o === 'review') add({ id, kind: 'feature', label: e.feature, reason: `its licence is under review (${e.review.join(', ')})`, sentence: s.slice(0, 200) });
      else if (o === 'on_request' && !CUSTOM_RE.test(s)) add({ id, kind: 'feature', label: e.feature, reason: 'it may only be offered as "custom, on request"', sentence: s.slice(0, 200) });
    }
  }
  return out;
}

// The line appended to a chat reply that offered something it may not.
export function offerNote(violations) {
  const v = Array.isArray(violations) ? violations : [];
  if (!v.length) return '';
  return `**Offer check:** ${v.map((x) => `${x.label}: ${x.reason}`).join('; ')}. Correct this before it reaches a client.`;
}

// The operator-only warning for unclear licences behind standard features
// a package relies on (never written into a client document).
export function licenceReviewNote(text) {
  const t = String(text || '');
  if (!/\b(?:package|tier|plan|offer|quote|proposal|pricing)\b/i.test(t)) return '';
  const hits = [];
  if (/\b(?:video|clip|film|motion|footage|shot)s?\b/i.test(t)) hits.push('text_image_to_video');
  if (/\b(?:music|soundtrack|score|track|song|beat)s?\b/i.test(t)) hits.push(/\b(?:film|movie|video|clip|tv|broadcast|radio)s?\b/i.test(t) ? 'film_music' : 'music');
  if (/\b(?:storyboards?|keyframes?|stills?)\b/i.test(t)) hits.push('storyboard_keyframes');
  if (/\b(?:voice[- ]?over|narrat\w*)\b/i.test(t)) hits.push('voiceover_single');
  const open = hits.map(capability).filter((e) => e && e.licence === 'unclear');
  if (!open.length) return '';
  const codes = [...new Set(open.flatMap((e) => e.review))].sort();
  return `**Licence under review (operator only):** ${open.map((e) => e.feature.toLowerCase()).join(', ')} rely on licence terms PG1 has not settled (${codes.map((c) => `${c}: ${LICENCE_QUESTIONS[c].question}`).join(' ')}). Do not send this offer to a client until they are answered.`;
}
