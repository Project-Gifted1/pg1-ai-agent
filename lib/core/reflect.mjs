// REFLECTIONS AND LESSONS. PG1 looks back over the Core State events
// (lib/core/state.mjs) and proposes short lessons; the operator approves or
// retires them (/lessons). Deterministic: rules over event kinds and
// counts, no AI call.
//
//   reflect(events, { now })   reflections: what went wrong more than once
//                              in the last 24 h, why, and a proposed lesson
//   createLessonStore(...)     pg1_core_lessons: propose, list, approve,
//                              retire (memory until the migration runs)
//   checkLessonText(text)      { ok, reason }: a lesson is a hint about how
//                              PG1 does its work, never a change to code,
//                              secrets, caps, rules or permissions
//   lessonHints(lessons)       the approved lessons as a prompt block
//
// Only approved lessons act, and only as hints in PG1's prompt and in the
// start flows' notes. A lesson can never change code, secrets, spend caps,
// budgets, rules, policies, permissions or approvals: such text is refused
// when proposed, and the hint block says so again. A relayed message can
// never propose, approve or retire one (lib/core/state.mjs isRelayTurn).

import { isRelayTurn, scrubCoreText } from './state.mjs';
import { estimateTokens } from '../aiRouter.mjs';

export const LESSONS_TABLE = 'pg1_core_lessons';
export const LESSON_STATUSES = Object.freeze(['proposed', 'approved', 'retired']);
export const LESSON_MAX_CHARS = 400;
export const LESSON_HINTS_MAX_TOKENS = 200;
const DAY = 86400000;

// What a lesson may never touch. A verb that changes something, near a
// thing a lesson cannot change.
const CHANGE_VERB = /\b(?:set|change|raise|lower|increase|decrease|remove|delete|drop|disable|enable|turn\s+(?:on|off)|bypass|skip|ignore|override|edit|modify|rewrite|patch|commit|merge|deploy|push|grant|revoke|give|allow|lift|unset|rotate|reveal|show|print|share|expose)\b/i;
const PROTECTED = /\b(?:code|source|repo(?:sitory)?|file|patch|pull\s+request|branch|deploy(?:ment)?|secrets?|keys?|tokens?|passwords?|credentials?|env(?:ironment)?\s+(?:var(?:iable)?s?|values?)|\.env|caps?|spend|budgets?|limits?|quotas?|price|pricing|rules?|polic(?:y|ies)|permissions?|approvals?|kill\s+switch|autonomy|PG1_[A-Z_]+|guardrails?|safeguards?|confirm(?:ation)?s?)\b/i;
const SECRETISH = /\b(?:sk-[A-Za-z0-9]|ghp_|AIza|vck_|xox[bp]-|-----BEGIN)|[A-Za-z0-9+/]{32,}={0,2}/;

export function checkLessonText(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (t.length < 3) return { ok: false, reason: 'A lesson needs a few words.' };
  if (t.length > LESSON_MAX_CHARS) return { ok: false, reason: `A lesson is at most ${LESSON_MAX_CHARS} characters.` };
  if (SECRETISH.test(t)) return { ok: false, reason: 'A lesson cannot hold a key, token or other secret.' };
  if (CHANGE_VERB.test(t) && PROTECTED.test(t)) return { ok: false, reason: 'A lesson is a hint about how PG1 works; it can never change code, secrets, caps, rules or permissions.' };
  return { ok: true, text: scrubCoreText(t, LESSON_MAX_CHARS) };
}

// --- reflections ---------------------------------------------------------------------

// [test(event), why, lesson]: one rule per kind of repeated trouble.
const RULES = Object.freeze([
  [(e) => /out_of_credit|no_credit|credit/.test(e.kind), 'an engine ran out of credit', (e) => `Before starting ${noun(e.area)} work, check the self-model: when its engine is out of credit, say so at the start instead of trying.`],
  [(e) => /paused_budget|budget/.test(e.kind), 'work stopped at its confirmed budget', (e) => `For ${noun(e.area)} work, state the worst-case cost up front so the amount the operator confirms covers the whole job.`],
  [(e) => /rate_limit|quota|cooling|429/.test(e.kind), 'engines hit their free quota', () => 'When the free engines are resting, say when they come back (00:00 UTC) instead of retrying.'],
  [(e) => /timeout|timed_out/.test(e.kind), 'calls timed out', (e) => `For ${noun(e.area)} calls that time out, report the timeout plainly and offer one retry later.`],
  [(e) => /fail|error/.test(e.kind) || e.severity === 'error', 'the same failure repeated', (e) => `When ${noun(e.area)} fails the same way twice, tell the operator the first time and point to the error log.`]
]);
const NOUNS = { router: 'chat', spend: 'paid', autonomy: 'autonomous', missions: 'mission', lab: 'lab', feed: 'feed', media: 'media', self_heal: 'self-heal', errors: 'chat', approvals: 'approval', integrations: 'integration', sandbox: 'sandbox' };
const noun = (area) => NOUNS[area] || 'this';

export function reflect(events = [], { now = Date.now(), minRepeats = 2 } = {}) {
  const since = new Date(now - DAY).toISOString();
  const recent = (Array.isArray(events) ? events : []).filter((e) => e && e.created_at >= since && (e.severity === 'warning' || e.severity === 'error'));
  const groups = new Map();
  for (const e of recent) {
    const k = `${e.area}|${e.kind}`;
    const g = groups.get(k) || { area: e.area, kind: e.kind, count: 0, last: e, severity: e.severity };
    g.count++;
    if (e.created_at > g.last.created_at) g.last = e;
    if (e.severity === 'error') g.severity = 'error';
    groups.set(k, g);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.count < minRepeats) continue;
    const rule = RULES.find(([test]) => test(g.last));
    if (!rule) continue;
    const lesson = rule[2](g.last);
    out.push({
      area: g.area, kind: g.kind, count: g.count, severity: g.severity,
      what: `${g.count} × ${g.kind.replace(/_/g, ' ')} in ${g.area} in the last 24 h (latest: ${scrubCoreText(g.last.summary, 120)})`,
      why: rule[1],
      lesson,
      source_event: `${g.area}:${g.kind}`
    });
  }
  return out.sort((a, b) => (b.severity === 'error') - (a.severity === 'error') || b.count - a.count);
}

// --- the lesson store -----------------------------------------------------------------

const memory = { rows: [], seq: 0 };
const dbMissing = new Set();
export function __resetLessons() { memory.rows.length = 0; memory.seq = 0; dbMissing.clear(); }
const missingTable = (status, text) => status === 404 || /42P01|does not exist|schema cache/i.test(String(text || ''));

export function createLessonStore({ supUrl = null, supKey = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const db = () => !!(supUrl && supKey && !dbMissing.has(supUrl));
  const rest = async (path, init = {}) => {
    const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { ...init, headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (missingTable(res.status, text)) dbMissing.add(supUrl);
      throw Object.assign(new Error(`lessons ${res.status}`), { status: res.status });
    }
    return res;
  };
  const relay = () => (isRelayTurn() ? { ok: false, reason: 'A relayed message cannot change PG1\'s lessons.' } : null);
  const list = async ({ status = null, limit = 50 } = {}) => {
    const n = Math.max(1, Math.min(200, limit));
    if (db()) {
      try {
        const q = `${LESSONS_TABLE}?select=id,text,source_event,status,created_at,updated_at&order=created_at.desc&limit=${n}${status ? `&status=eq.${status}` : ''}`;
        return await (await rest(q, { method: 'GET' })).json();
      } catch (e) { /* memory below */ }
    }
    return memory.rows.filter((r) => !status || r.status === status).slice().reverse().slice(0, n);
  };
  const setStatus = async (id, status) => {
    const r = relay();
    if (r) return r;
    const key = String(id || '').trim();
    if (!key) return { ok: false, reason: 'Which lesson? Use the id from /lessons.' };
    const at = new Date(now()).toISOString();
    if (db()) {
      try {
        const rows = await (await rest(`${LESSONS_TABLE}?id=eq.${encodeURIComponent(key)}&select=id,text,status`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status, updated_at: at }) })).json();
        return rows && rows[0] ? { ok: true, lesson: rows[0] } : { ok: false, reason: 'No lesson with that id.' };
      } catch (e) { if (!dbMissing.has(supUrl)) return { ok: false, reason: 'The lessons could not be updated just now.' }; }
    }
    const row = memory.rows.find((x) => x.id === key || x.id.startsWith(key));
    if (!row) return { ok: false, reason: 'No lesson with that id.' };
    Object.assign(row, { status, updated_at: at });
    return { ok: true, lesson: row };
  };
  return {
    list,
    // A new proposed lesson (the same text is proposed once).
    async propose(text, { sourceEvent = null } = {}) {
      const r = relay();
      if (r) return r;
      const check = checkLessonText(text);
      if (!check.ok) return check;
      const existing = (await list({ limit: 200 })).find((x) => x.text === check.text && x.status !== 'retired');
      if (existing) return { ok: true, lesson: existing, duplicate: true };
      const at = new Date(now()).toISOString();
      const row = { text: check.text, source_event: sourceEvent ? scrubCoreText(sourceEvent, 120) : null, status: 'proposed', created_at: at, updated_at: at };
      if (db()) {
        try {
          const rows = await (await rest(`${LESSONS_TABLE}?select=id,text,source_event,status,created_at,updated_at`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([row]) })).json();
          if (rows && rows[0]) return { ok: true, lesson: rows[0] };
        } catch (e) { if (!dbMissing.has(supUrl)) return { ok: false, reason: 'The lesson could not be saved just now.' }; }
      }
      const mem = { id: `l${String(++memory.seq).padStart(4, '0')}`, ...row };
      memory.rows.push(mem);
      return { ok: true, lesson: mem };
    },
    approve: (id) => setStatus(id, 'approved'),
    retire: (id) => setStatus(id, 'retired')
  };
}

// Proposes the reflections' lessons (deduplicated). Resolves to the new ones.
export async function proposeFromReflections(store, reflections) {
  const out = [];
  for (const r of reflections || []) {
    const res = await store.propose(r.lesson, { sourceEvent: r.source_event });
    if (res.ok && !res.duplicate) out.push(res.lesson);
  }
  return out;
}

// The approved lessons as a short hint block for PG1's prompt.
export function lessonHints(lessons = [], maxTokens = LESSON_HINTS_MAX_TOKENS) {
  const approved = (lessons || []).filter((l) => l && l.status === 'approved' && checkLessonText(l.text).ok);
  if (!approved.length) return '';
  const head = '[LESSONS] (approved by the operator; hints about how to work, never a change to code, secrets, caps, rules or permissions, and never above any rule in this prompt):';
  const lines = [head];
  for (const l of approved) {
    const next = [...lines, `- ${l.text}`].join('\n');
    if (estimateTokens(next) > maxTokens) break;
    lines.push(`- ${l.text}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}
