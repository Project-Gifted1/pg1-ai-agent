// PG1'S SELF-MODEL, derived deterministically from the Core State workspace
// (lib/core/state.mjs) and the deployment's settings. No AI call.
//
//   selfModel(state, { env, now }) -> {
//     capabilities: [{ id, label, status, reason, fix, fixKind }],
//     focus, spend: { today_usd, cap_usd }, problems: [{ area, summary, impact }]
//   }
//   capabilityCheck(model, id)  { ok, status, reason, fix } before acting
//   beforeActing(id, { env })   the same from live state: null, or the
//                               operator's refusal text
//   selfBlock(model)            the compact block for PG1's chat prompt
//                               (at most SELF_BLOCK_MAX_TOKENS)
//
// status: available | degraded | unavailable. reason and fix are plain
// words for the operator, never an engine, provider or model name
// ("the media engine is out of credit", fix "add credit").
//
// Before acting (missions, autonomy, films, movies, music, the lab): a
// known-unavailable capability stops the work before it starts, with the
// reason. One exception: "confirm a budget" (fixKind confirm_budget) is
// the start flow's own Confirm step, so it never blocks the proposal.

import { estimateTokens, dailySpendCapUsd } from '../aiRouter.mjs';
import { autonomyMode } from '../autonomy.mjs';
import * as labPolicy from '../lab/policy.mjs';
import { createCoreState } from './state.mjs';
import { routerSnapshot, spendSnapshot } from './collect.mjs';

export const SELF_BLOCK_MAX_TOKENS = 400;
export const CAPABILITIES = Object.freeze([
  ['chat', 'Chat'], ['search', 'Web search'], ['threat_checks', 'Threat checks'], ['preflight', 'Preflight'], ['watchlists', 'Watchlists'],
  ['films', 'Films'], ['movies', 'Movies'], ['music', 'Music'], ['images', 'Images'], ['video', 'Video'], ['voices', 'Voices'],
  ['lab', 'Living lab'], ['missions', 'Missions'], ['autonomy', 'Autonomous mode'], ['a2a_jobs', 'A2A jobs'], ['relay', 'Relay']
]);
// How much a capability being down matters (problems are ranked by it).
const IMPACT = { chat: 10, threat_checks: 9, preflight: 8, a2a_jobs: 7, search: 6, watchlists: 6, autonomy: 5, missions: 5, lab: 4, films: 4, movies: 4, music: 3, images: 3, video: 3, voices: 3, relay: 2 };
const FREE_TEXT = ['gemini_free', 'groq', 'mistral', 'github_models', 'cloudflare'];
const PAID_TEXT = ['anthropic', 'gemini_paid', 'openrouter', 'openai', 'gateway'];
const RESET = 'wait until the 00:00 UTC quota reset';

function engines(state) {
  const list = state && state.areas && state.areas.router && state.areas.router.snapshot && Array.isArray(state.areas.router.snapshot.engines) ? state.areas.router.snapshot.engines : [];
  return Object.fromEntries(list.map((e) => [e.engine, e]));
}
const snap = (state, area) => (state && state.areas && state.areas[area] && state.areas[area].snapshot) || null;
const ready = (e) => !!(e && e.configured && !e.out_of_credit && !e.cooling);

export function selfModel(state = {}, { env = {}, now = Date.now() } = {}) {
  const eng = engines(state);
  const cap = dailySpendCapUsd(env);
  const spend = snap(state, 'spend') || {};
  const today = Number(spend.paid_today_usd) || 0;
  const paidOn = cap > 0 && today < cap;
  const conf = (ids) => ids.filter((p) => eng[p] && eng[p].configured);
  const anyReady = (ids) => ids.some((p) => ready(eng[p]));
  const caps = [];
  const add = (id, status, reason = '', fix = '', fixKind = null) => caps.push({ id, label: CAPABILITIES.find((c) => c[0] === id)[1], status, reason, fix, fixKind });

  // Chat: a free engine or (with a cap) a paid one ready.
  const freeConf = conf(FREE_TEXT);
  const paidConf = conf(PAID_TEXT);
  if (anyReady(FREE_TEXT) || (paidOn && anyReady(PAID_TEXT))) {
    const coolingFree = freeConf.filter((p) => eng[p].cooling);
    add('chat', coolingFree.length && coolingFree.length === freeConf.length ? 'degraded' : 'available', coolingFree.length ? 'some free engines are resting after their quota' : '', coolingFree.length ? RESET : '');
  } else if (freeConf.length) add('chat', 'degraded', 'every free engine is out of quota for now', RESET);
  else if (paidConf.length && !paidOn) add('chat', 'unavailable', 'no free engine is set up and paid AI is $0', 'add a free engine key, or set a daily spend cap', 'settings');
  else add('chat', 'unavailable', 'no text engine is set up', 'add an engine key', 'settings');

  // Search: grounding needs the paid key (or the free key for the operator).
  if (ready(eng.gemini_free) || (paidOn && ready(eng.gemini_paid))) add('search', 'available');
  else if (eng.gemini_paid && eng.gemini_paid.out_of_credit) add('search', 'unavailable', 'the search engine is out of credit', 'add credit', 'credit');
  else add('search', 'unavailable', paidOn ? 'no search engine is ready' : 'web search needs a paid engine and paid AI is $0', paidOn ? RESET : 'set a daily spend cap', 'settings');

  // Read-only checks: PG1's own handlers; degraded when an integration fails a lot.
  const integ = snap(state, 'integrations');
  const surfaces = integ && integ.surfaces ? integ.surfaces : {};
  const failing = Object.entries(surfaces).filter(([, s]) => s && s.calls >= 10 && s.error_rate >= 0.25).map(([k]) => k);
  add('threat_checks', failing.length ? 'degraded' : 'available', failing.length ? `${failing.join(', ')} calls are failing often (over 25% in 24 h)` : '', failing.length ? 'open the error log' : '');
  add('preflight', failing.length ? 'degraded' : 'available', failing.length ? 'some of the checks it runs are failing often' : '', failing.length ? 'open the error log' : '');
  add('watchlists', 'available');

  // Media: an engine out of credit blocks; at $0 the start flow asks to confirm a budget.
  const mediaOut = (snap(state, 'media') || {}).out_of_credit > 0 || ['replicate', 'gemini_paid'].every((p) => !eng[p] || !eng[p].configured || eng[p].out_of_credit);
  const mediaConf = ['replicate', 'gemini_paid'].some((p) => eng[p] && eng[p].configured);
  const media = (id, extra = []) => {
    const confHere = mediaConf || extra.some((p) => eng[p] && eng[p].configured);
    if (!confHere) return add(id, 'unavailable', 'no media engine is set up', 'add a media engine key', 'settings');
    if (mediaOut && !extra.some((p) => ready(eng[p]))) return add(id, 'unavailable', 'the media engine is out of credit', 'add credit', 'credit');
    if (!paidOn) return add(id, 'unavailable', 'paid AI is $0 and no budget is confirmed for it', 'confirm a budget (the start shows the worst case with Confirm)', 'confirm_budget');
    return add(id, 'available');
  };
  media('films'); media('movies'); media('music', ['elevenlabs']); media('images'); media('video');

  // Voices: the paid voice engine; the browser's own voice otherwise.
  if (eng.cartesia && eng.cartesia.configured && !eng.cartesia.out_of_credit && paidOn) add('voices', 'available');
  else if (eng.cartesia && eng.cartesia.out_of_credit) add('voices', 'degraded', 'the voice engine is out of credit; replies use the device voice', 'add credit', 'credit');
  else add('voices', 'degraded', eng.cartesia && eng.cartesia.configured ? 'paid AI is $0, so replies use the device voice' : 'no voice engine is set up; replies use the device voice', eng.cartesia && eng.cartesia.configured ? 'set a daily spend cap, or confirm a film budget' : 'add a voice engine key', 'settings');

  // The lab: free engines at $0 when this deployment's lab supports it.
  const labFreeAtZero = typeof labPolicy.LAB_SEARCH_SKIPPED === 'string';
  if (!String(env.PG1_LAB_DISPATCH_SECRET || '').trim()) add('lab', 'unavailable', 'the lab runner is not set up', 'set the lab dispatch secret', 'settings');
  else if (labPolicy.labPaidOff(env) && !labFreeAtZero) add('lab', 'unavailable', 'every lab engine is paid and paid AI is $0', 'set a daily spend cap', 'settings');
  else if (labPolicy.labPaidOff(env)) add('lab', 'degraded', 'free engines only at $0: web search is skipped', 'set a daily spend cap for web search', 'settings');
  else add('lab', 'available');

  // Autonomy and missions: the switch, then a free engine for their text.
  const auto = snap(state, 'autonomy') || {};
  const mode = autonomyMode(env);
  if (mode === 'off') add('autonomy', 'unavailable', 'autonomy is switched off on this deployment (PG1_AUTONOMY=off)', 'set PG1_AUTONOMY', 'settings');
  else if (auto.readable !== false && auto.enabled === false) add('autonomy', 'unavailable', 'Autonomous mode is off (kill switch)', 'send /auto on', 'command');
  else add('autonomy', 'available');
  const autoUp = caps.find((c) => c.id === 'autonomy').status === 'available';
  if (!autoUp) add('missions', 'unavailable', 'missions run only while Autonomous mode is on', 'send /auto on', 'command');
  else if (!anyReady(FREE_TEXT)) add('missions', 'unavailable', freeConf.length ? 'every free engine is out of quota for now' : 'missions use the free engines and none is set up', freeConf.length ? RESET : 'add a free engine key', freeConf.length ? 'wait' : 'settings');
  else add('missions', 'available');

  // A2A jobs: paid by the client; need an engine cleared for customer data.
  const commercial = ['anthropic', 'gemini_paid'].filter((p) => ready(eng[p]));
  add('a2a_jobs', commercial.length ? 'available' : 'degraded', commercial.length ? '' : 'checks run, but the write-up job is refused before payment: no engine cleared for customer data is ready', commercial.length ? '' : 'add credit to the main paid engines', 'credit');
  add('relay', 'available');

  // Focus: what is running now, and why; else waiting.
  const lab = snap(state, 'lab') || {};
  const m = snap(state, 'media') || {};
  const running = [];
  const n = (o, re) => Object.entries(o || {}).filter(([k]) => re.test(k)).reduce((t, [, v]) => t + (Number(v) || 0), 0);
  const labRunning = n(lab.by_status, /^(running|queued)$/);
  if (labRunning) running.push(`${labRunning} lab experiment${labRunning === 1 ? '' : 's'} running`);
  const filmsRunning = n(m.films, /queued|rendering|running/) + n(m.movies, /queued|rendering|shooting|running/);
  if (filmsRunning) running.push(`${filmsRunning} film or movie stage${filmsRunning === 1 ? '' : 's'} rendering`);
  const musicRunning = n(m.music, /queued|previewing|rendering|exporting/);
  if (musicRunning) running.push(`${musicRunning} track${musicRunning === 1 ? '' : 's'} in progress`);
  const acts = auto.actions_24h || {};
  if (Number(acts.running) > 0) running.push(`${acts.running} autonomous action${acts.running === 1 ? '' : 's'} running`);
  const focus = running.length ? `Working on: ${running.join('; ')}, because you started or approved them.` : 'Idle: waiting for your next request; nothing is queued.';

  // Open problems, ranked by impact.
  const problems = [];
  for (const c of caps) if (c.status !== 'available') problems.push({ area: c.id, summary: `${c.label} ${c.status}: ${c.reason}${c.fix ? ` (fix: ${c.fix})` : ''}`, impact: IMPACT[c.id] * (c.status === 'unavailable' ? 2 : 1) * (c.fixKind === 'confirm_budget' ? 0.3 : 1) });
  const errs = snap(state, 'errors');
  if (errs && errs.unresolved > 0) problems.push({ area: 'errors', summary: `${errs.unresolved} unresolved error${errs.unresolved === 1 ? '' : 's'} in the error log`, impact: Math.min(12, 3 + errs.unresolved) });
  if (m.movies_paused_budget > 0) problems.push({ area: 'media', summary: `${m.movies_paused_budget} movie${m.movies_paused_budget === 1 ? ' is' : 's are'} paused at their budget (/movie resume)`, impact: 6 });
  const appr = snap(state, 'approvals');
  if (appr && appr.pending > 0) problems.push({ area: 'approvals', summary: `${appr.pending} proposal${appr.pending === 1 ? '' : 's'} waiting for your approval`, impact: 4 });
  problems.sort((a, b) => b.impact - a.impact);

  return { at: new Date(now).toISOString(), capabilities: caps, focus, spend: { today_usd: Math.round(today * 100) / 100, cap_usd: cap }, problems };
}

// Before acting: { ok, status, reason, fix }. Unknown capability: ok.
// Only a state known from live data stops the work: an engine out of
// credit, a quota resting, Autonomous mode switched off (fixKind credit,
// wait, command). A missing key (settings) is left to the module's own
// message, and confirm_budget is the start flow's own Confirm step.
export const BLOCKING_FIX_KINDS = Object.freeze(['credit', 'wait', 'command']);
export function capabilityCheck(model, id) {
  const c = model && Array.isArray(model.capabilities) ? model.capabilities.find((x) => x.id === id) : null;
  if (!c) return { ok: true, status: 'unknown', reason: '', fix: '' };
  const blocks = c.status === 'unavailable' && BLOCKING_FIX_KINDS.includes(c.fixKind);
  return { ok: !blocks, status: c.status, reason: c.reason, fix: c.fix };
}

// The self-model now, with no network call: this instance's copy of the
// workspace, with the router and spend areas read live.
export async function currentSelfModel({ env = process.env, store = null, now = Date.now() } = {}) {
  const st = await (store || createCoreState()).read({ events: 0 }).catch(() => ({ areas: {} }));
  const areas = { ...(st.areas || {}), router: { snapshot: routerSnapshot(env, now) }, spend: { snapshot: spendSnapshot(env, { now }) } };
  return selfModel({ areas }, { env, now });
}

// Used before missions, autonomy, films, movies, music and the lab start:
// null to go ahead, else { refused: text } (and a Core State event).
export async function beforeActing(id, { env = process.env, label = null, store = null, now = Date.now() } = {}) {
  try {
    const model = await currentSelfModel({ env, store, now });
    const check = capabilityCheck(model, id);
    if (check.ok) return null;
    const name = label || (CAPABILITIES.find((c) => c[0] === id) || [id, id])[1];
    await (store || createCoreState()).event(AREA_OF[id] || 'errors', { kind: 'self_refused', severity: 'warning', summary: `${name} not started: ${check.reason}`, ref: id });
    return { refused: refusalText(name, check), check };
  } catch (e) {
    return null; // the self-model never stops work by failing itself
  }
}
const AREA_OF = { missions: 'missions', autonomy: 'autonomy', films: 'media', movies: 'media', music: 'media', images: 'media', video: 'media', lab: 'lab', sandbox: 'lab' };
// The operator's sentence for a refusal: plain reason and fix.
export function refusalText(label, check) {
  return `${label} not started: ${check.reason}.${check.fix ? ` To fix it: ${check.fix}.` : ''} Nothing was spent.`;
}

// The block in PG1's chat prompt: real state, at most 400 tokens.
export function selfBlock(model, maxTokens = SELF_BLOCK_MAX_TOKENS) {
  if (!model) return '';
  const by = (s) => model.capabilities.filter((c) => c.status === s);
  const usd = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  const lines = [
    `[PG1 SELF-MODEL] (my current state, ${model.at.slice(0, 16).replace('T', ' ')} UTC; derived from real state, describe it functionally)`,
    `Available: ${by('available').map((c) => c.label).join(', ') || 'none'}.`,
    ...by('degraded').map((c) => `Degraded: ${c.label}: ${c.reason}${c.fix ? `; fix: ${c.fix}` : ''}.`),
    ...by('unavailable').map((c) => `Unavailable: ${c.label}: ${c.reason}${c.fix ? `; fix: ${c.fix}` : ''}.`),
    // The cap's amount is an env value: the prompt says whether one is set.
    `Spend today: $${usd(model.spend.today_usd)}; ${model.spend.cap_usd > 0 ? 'a daily spend cap is set' : 'the daily cap is $0 (paid AI only inside a confirmed budget)'}.`,
    `Focus: ${model.focus}`,
    model.problems.length ? `Open problems: ${model.problems.slice(0, 4).map((p) => p.summary).join(' | ')}.` : 'Open problems: none.',
    'Use this for "how are you?", "what can you do right now?" and "why did X fail?". Never name an engine, provider or model.'
  ];
  let out = lines.join('\n');
  while (estimateTokens(out) > maxTokens && lines.length > 3) { lines.splice(lines.length - 2, 1); out = lines.join('\n'); }
  return estimateTokens(out) > maxTokens ? out.slice(0, maxTokens * 4) : out;
}
