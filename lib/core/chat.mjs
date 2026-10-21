// /state and /lessons in the chat, the hourly pulse's Core State step, and
// the self-model block in PG1's prompt. Operator only; no AI call.
//
//   /state                       the self-model and the workspace as a card
//   /lessons                     proposed, approved and retired lessons
//   /lessons approve <id>        an approved lesson acts, as a hint
//   /lessons retire <id>         it stops acting
//   /lessons reflect             reflect on the last 24 h now (the pulse
//                                does it every hour)
//
// A relayed message (/relay) never reaches these handlers (the chat runs no
// command from one), and every write refuses a relayed turn anyway
// (lib/core/state.mjs isRelayTurn).

import { createCoreState } from './state.mjs';
import { collectCoreState } from './collect.mjs';
import { selfModel, selfBlock } from './self.mjs';
import { reflect, createLessonStore, proposeFromReflections, lessonHints } from './reflect.mjs';
import { HONESTY_DIRECTIVE } from './honesty.mjs';

export const STATE_RE = /^\/state\b/i;
export const LESSONS_RE = /^\/lessons\b/i;
export const isStateCommand = (t) => STATE_RE.test(String(t || '').trim());
export const isLessonsCommand = (t) => LESSONS_RE.test(String(t || '').trim());
const OPERATOR_ONLY = 'PG1 Core State is for the signed-in operator only.';

const STATUS_WORD = { available: 'available', degraded: 'degraded', unavailable: 'unavailable' };

export async function handleStateCommand({ env = process.env, supUrl = null, supKey = null, fetchImpl = globalThis.fetch, isOperator = false, now = Date.now() } = {}) {
  if (isOperator !== true) return { status: 401, reply: OPERATOR_ONLY };
  const store = createCoreState({ supUrl, supKey, fetchImpl, now: () => now });
  await collectCoreState({ env, supUrl, supKey, fetchImpl, store, now });
  const st = await store.read({ events: 12 });
  const model = selfModel(st, { env, now });
  const by = (s) => model.capabilities.filter((c) => c.status === s);
  // A short lead; the card under it has every capability.
  const down = [...by('unavailable'), ...by('degraded')];
  const lines = [
    `**PG1 Core State:** ${by('available').length} available, ${by('degraded').length} degraded, ${by('unavailable').length} unavailable.`,
    down.length ? `Limited now: ${down.slice(0, 4).map((c) => `${c.label} (${c.reason})`).join('; ')}${down.length > 4 ? '; more in the card' : ''}.` : 'Everything is available.',
    model.focus,
    st.storage === 'memory' ? '*Kept in this instance\'s memory: the Core State tables are not set up yet.*' : ''
  ].filter(Boolean);
  return {
    reply: lines.join('\n\n'),
    coreState: {
      at: model.at,
      storage: st.storage,
      capabilities: model.capabilities,
      focus: model.focus,
      spend: model.spend,
      problems: model.problems.slice(0, 8),
      events: (st.events || []).slice(0, 12).map((e) => ({ area: e.area, kind: e.kind, severity: e.severity, summary: e.summary, at: e.created_at }))
    }
  };
}

function lessonsCard(items, extra = {}) {
  return { items: items.map((l) => ({ id: l.id, text: l.text, status: l.status, source: l.source_event || null, at: l.created_at })), ...extra };
}

export async function handleLessonsCommand({ text = '/lessons', supUrl = null, supKey = null, fetchImpl = globalThis.fetch, isOperator = false, now = Date.now() } = {}) {
  if (isOperator !== true) return { status: 401, reply: OPERATOR_ONLY };
  const [, sub = 'list', arg = ''] = /^\/lessons\s*(\w+)?\s*(\S+)?/i.exec(String(text).trim()) || [];
  const lessons = createLessonStore({ supUrl, supKey, fetchImpl, now: () => now });
  const list = async () => lessons.list({ limit: 40 });
  const s = String(sub).toLowerCase();
  if (s === 'approve' || s === 'retire') {
    const out = s === 'approve' ? await lessons.approve(arg) : await lessons.retire(arg);
    const reply = out.ok
      ? (s === 'approve' ? `Approved: "${out.lesson.text}". It acts from now on, as a hint only.` : `Retired: "${out.lesson.text}". It no longer acts.`)
      : out.reason;
    return { reply, coreLessons: lessonsCard(await list()) };
  }
  if (s === 'reflect') {
    const st = await createCoreState({ supUrl, supKey, fetchImpl, now: () => now }).read({ events: 200 });
    const refl = reflect(st.events, { now });
    const added = await proposeFromReflections(lessons, refl);
    const reply = refl.length
      ? `Reflected on the last 24 h: ${refl.length} repeated problem${refl.length === 1 ? '' : 's'}; ${added.length} new lesson${added.length === 1 ? '' : 's'} proposed. Nothing acts until you approve it.`
      : 'Reflected on the last 24 h: nothing went wrong more than once, so no lesson is proposed.';
    return { reply, coreLessons: lessonsCard(await list(), { reflections: refl.map((r) => ({ what: r.what, why: r.why, lesson: r.lesson })) }) };
  }
  if (s !== 'list') return { reply: 'Usage: /lessons, /lessons approve <id>, /lessons retire <id>, /lessons reflect.' };
  const items = await list();
  const count = (st) => items.filter((l) => l.status === st).length;
  const reply = items.length
    ? `PG1 lessons: ${count('proposed')} proposed, ${count('approved')} approved, ${count('retired')} retired. Only approved lessons act, as hints; a lesson can never change code, secrets, caps, rules or permissions.`
    : 'No lessons yet. PG1 proposes one when something goes wrong more than once in a day (/lessons reflect looks now).';
  return { reply, coreLessons: lessonsCard(items) };
}

// The hourly pulse: publish every area, prune old events, reflect and
// propose lessons. Never throws.
export async function corePulse({ env = process.env, supUrl = null, supKey = null, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  try {
    const store = createCoreState({ supUrl, supKey, fetchImpl, now: () => now });
    await collectCoreState({ env, supUrl, supKey, fetchImpl, store, now });
    await store.prune();
    const st = await store.read({ events: 200 });
    const added = await proposeFromReflections(createLessonStore({ supUrl, supKey, fetchImpl, now: () => now }), reflect(st.events, { now }));
    return { ok: true, proposed: added.length };
  } catch (e) {
    return { ok: false };
  }
}

// "How are you?", "what can you do right now?", "why did X fail?", "are
// you conscious?": the turns that get the self-model block.
const SELF_Q_RE = /\bhow\s+are\s+(?:you|u)\b|\bhow'?s\s+it\s+going\b|\bwhat\s+can\s+(?:you|u)\s+do\b|\bwhat(?:'s|\s+is)\s+(?:broken|wrong|failing|down)\b|\bwhy\s+(?:did|does|is|was)\b.*\b(?:fail|break|stop|not\s+work)|\b(?:your|ur)\s+(?:state|status|health|capabilities|focus)\b|\bare\s+(?:you|u)\s+(?:ok|okay|working|busy|up|conscious|alive|sentient|self[-\s]?aware)\b|\bwhat\s+are\s+(?:you|u)\s+(?:doing|working\s+on)\b|\bfeel(?:ings?)?\b|\bconscious/i;
export const isSelfQuestion = (t) => SELF_Q_RE.test(String(t || ''));

// The prompt block: the honesty rule always; the self-model and the
// approved lessons on a self question (this instance's copy plus the
// lessons table; never more than ~600 tokens together).
export async function selfPromptBlock({ text = '', env = process.env, supUrl = null, supKey = null, fetchImpl = globalThis.fetch, now = Date.now(), selfModelFor = null } = {}) {
  const parts = [HONESTY_DIRECTIVE];
  if (!isSelfQuestion(text)) return parts.join('\n');
  try {
    const model = selfModelFor ? await selfModelFor() : null;
    if (model) parts.push(selfBlock(model));
    const approved = await createLessonStore({ supUrl, supKey, fetchImpl, now: () => now }).list({ status: 'approved', limit: 20 });
    const hints = lessonHints(approved);
    if (hints) parts.push(hints);
  } catch (e) { /* the block is optional */ }
  return parts.join('\n');
}
