// The lab's research agenda: what the continuous lab loop (lib/lab/loop.mjs,
// run by the Autonomous tick) works on next, one row per goal in
// public.pg1_lab_agenda (supabase/migrations/20261112120000_pg1_lab_agenda.sql;
// in memory until that migration runs). Goals are de-duplicated by their
// normalised text (goalKey).
//
//   syncAgenda(...)      brings the agenda up to date with the lab's own
//                        record (pg1_lab_experiments). On the first run
//                        after deploy that builds it from every earlier
//                        experiment (agendaFromHistory); after that it adds
//                        what is new and closes what finished:
//                          - failed, timeout, over_budget, or done with the
//                            search skipped: a "continue" item carrying the
//                            previous findings (notes) and continued_from
//                          - finished research: its findings proposed as a
//                            lesson (pg1_core_lessons) unless already there
//                          - passed the gate, not promoted: left as it is
//                            (its approval card is the operator's); the
//                            goal is marked done so it is not run again
//                          - queued or running: running; stopped: dropped
//   ownAgendaItems(...)  PG1's own items when nothing is open: its active
//                        missions' goals and its approved lessons
//   pickNext(items)      the open item to run next (priority, then oldest)
//   contextFor(...)      the most relevant earlier findings for a goal: the
//                        experiment it continues first, then the closest by
//                        shared words (at most 3), each cut to 1500 chars
//
// /lab agenda (list), /lab agenda add "<goal>", /lab agenda drop <id> and
// /lab agenda top <id> are the operator's (lib/lab/chat.mjs).

import { classifyLabKind, LAB_KINDS } from './policy.mjs';
import { searchTerms } from './freeSearch.mjs';
import { checkLessonText } from '../core/reflect.mjs';

export const AGENDA_TABLE = 'pg1_lab_agenda';
export const AGENDA_STATUSES = Object.freeze(['open', 'running', 'done', 'dropped']);
export const MAX_ATTEMPTS = 3;          // loop runs on one goal before it rests
export const DEFAULT_PRIORITY = 50;
export const CONTINUE_PRIORITY = 60;    // unfinished work goes first
export const OPERATOR_PRIORITY = 70;    // /lab agenda add
export const NOTES_MAX = 4000;
export const CONTEXT_CHARS = 1500;
const ENDED_BAD = new Set(['failed', 'timeout', 'over_budget']);
const FOUNDRY = '[foundry]';

// A goal's identity: lower-case letters and digits, single spaces.
export function goalKey(goal) {
  return String(goal || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 1000);
}

const searchSkipped = (e) => Array.isArray(e && e.skipped) && e.skipped.some((s) => s && s.step === 'web search');
const time = (e) => Date.parse((e && (e.updated_at || e.created_at)) || '') || 0;
const created = (e) => Date.parse((e && e.created_at) || '') || 0;

// The findings part of a report (what the next experiment builds on).
export function findingsOf(report, max = CONTEXT_CHARS) {
  const t = String(report || '').replace(/\r/g, '');
  const m = /##\s*Findings\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(t);
  return (m ? m[1] : t).replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

// The first sentence of a finding, as a short lesson (or null).
export function lessonFromFindings(exp, report) {
  const f = findingsOf(report, 2000).replace(/^[-*\d.\s]+/gm, '').replace(/\[[0-9, ]+\]/g, '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  const first = (/^(.{20,300}?[.!?])(?:\s|$)/.exec(f) || [null, f.slice(0, 300)])[1];
  if (!first || first.length < 20) return null;
  const text = `Lab finding (${String(exp.id).slice(0, 8)}, ${String(exp.goal || '').replace(/\s+/g, ' ').slice(0, 60)}): ${first}`.slice(0, 400);
  const ok = checkLessonText(text);
  return ok.ok ? ok.text : null;
}

// Pure. rows: earlier experiments, light (id, created_at, updated_at, kind,
// goal, status, error, gate, promoted_stage, candidate, skipped). reports:
// Map id -> report_markdown (only what is needed; may be empty). Returns
// { items, lessons } with one item per goal key (the latest experiment
// decides), lessons [{ text, source_event }] for finished research.
export function agendaFromHistory(rows, { reports = new Map(), source = 'history' } = {}) {
  const byKey = new Map();
  for (const e of [...(rows || [])].filter((x) => x && x.id && x.goal).sort((a, b) => created(a) - created(b))) {
    if (String(e.goal).startsWith(FOUNDRY)) continue;
    const key = goalKey(e.goal);
    if (!key) continue;
    const g = byKey.get(key) || { key, runs: [] };
    g.runs.push(e);
    byKey.set(key, g);
  }
  const items = [];
  const lessons = [];
  for (const { key, runs } of byKey.values()) {
    const last = runs[runs.length - 1];
    const kind = LAB_KINDS.includes(last.kind) ? last.kind : classifyLabKind(last.goal);
    const base = { goal: String(last.goal).replace(/\s+/g, ' ').trim().slice(0, 1000), goal_key: key, kind, source, attempts: 0 };
    const report = reports.get(last.id) || '';
    const passedGate = last.gate && last.gate.pass === true && (last.promoted_stage || 'none') === 'none';
    if (passedGate || (last.status === 'done' && !searchSkipped(last))) {
      items.push({ ...base, status: 'done', priority: DEFAULT_PRIORITY, continued_from: last.id, notes: findingsOf(report, NOTES_MAX) || null });
      if (last.status === 'done' && last.kind === 'research' && report) {
        const text = lessonFromFindings(last, report);
        if (text) lessons.push({ text, source_event: `lab:${String(last.id).slice(0, 36)}` });
      }
      continue;
    }
    if (ENDED_BAD.has(last.status) || (last.status === 'done' && searchSkipped(last))) {
      const why = last.status === 'done' ? 'the search was skipped (no web search at $0)' : `${last.status}: ${String(last.error || 'no reason recorded').slice(0, 300)}`;
      const found = findingsOf(report, NOTES_MAX - 400);
      items.push({ ...base, status: 'open', priority: CONTINUE_PRIORITY, continued_from: last.id, notes: `Continue from ${String(last.id).slice(0, 8)} (${why}).${found ? `\nPrevious findings:\n${found}` : ''}`.slice(0, NOTES_MAX) });
      continue;
    }
    if (last.status === 'queued' || last.status === 'running') { items.push({ ...base, status: 'running', priority: DEFAULT_PRIORITY, experiment_id: last.id, continued_from: null, notes: null }); continue; }
    if (last.status === 'stopped') items.push({ ...base, status: 'dropped', priority: DEFAULT_PRIORITY, continued_from: last.id, notes: 'Stopped by the operator.' });
  }
  return { items, lessons };
}

// The ids whose reports agendaFromHistory needs (the latest run of each goal
// that finished, or failed with findings to carry).
export function reportIdsFor(rows) {
  const latest = new Map();
  for (const e of [...(rows || [])].filter((x) => x && x.id && x.goal).sort((a, b) => created(a) - created(b))) latest.set(goalKey(e.goal), e);
  return [...latest.values()].filter((e) => e.status === 'done' || ENDED_BAD.has(e.status)).map((e) => e.id);
}

// The open item to run next: highest priority, then the oldest.
export function pickNext(items) {
  return (items || []).filter((i) => i && i.status === 'open' && (Number(i.attempts) || 0) < MAX_ATTEMPTS)
    .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

// The most relevant earlier findings for a goal. history: [{ id, goal,
// report }] (finished experiments with a report). The continued
// experiment first, then up to `limit` more by shared words.
export function contextFor(goal, history, { continuedFrom = null, limit = 3, min = 0.25 } = {}) {
  const want = new Set(searchTerms(goal, 24));
  const out = [];
  const seen = new Set();
  const add = (h) => { const f = findingsOf(h.report); if (f.length >= 40 && !seen.has(h.id)) { seen.add(h.id); out.push({ id: h.id, goal: String(h.goal || '').slice(0, 300), findings: f }); } };
  const cf = continuedFrom ? (history || []).find((h) => h.id === continuedFrom) : null;
  if (cf) add(cf);
  if (!want.size) return out;
  const scored = (history || []).filter((h) => h && h.id !== continuedFrom && h.report).map((h) => {
    const g = new Set(searchTerms(h.goal, 24));
    const f = new Set(searchTerms(findingsOf(h.report, 1200), 60));
    let hit = 0;
    for (const w of want) if (g.has(w)) hit += 1; else if (f.has(w)) hit += 0.5;
    return { h, score: hit / want.size };
  }).filter((x) => x.score >= min).sort((a, b) => b.score - a.score || time(b.h) - time(a.h));
  for (const { h } of scored) { if (out.length >= limit + (cf ? 1 : 0)) break; add(h); }
  return out;
}

// PG1's own items, when nothing is open: its active missions' goals, and
// its approved lessons (how to do better what each one says). Keys already
// on the agenda are left out.
export function ownAgendaItems({ missions = [], lessons = [], existingKeys = new Set() } = {}) {
  const out = [];
  const add = (goal, priority) => {
    const g = String(goal || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    const key = goalKey(g);
    if (g.length < 3 || !key || existingKeys.has(key) || out.some((o) => o.goal_key === key)) return;
    out.push({ goal: g, goal_key: key, kind: classifyLabKind(g), priority, status: 'open', source: 'pg1', attempts: 0, continued_from: null, notes: null });
  };
  for (const m of missions) if (m && m.status === 'active' && m.goal) add(m.goal, DEFAULT_PRIORITY);
  for (const l of lessons) if (l && l.status === 'approved' && l.text) add(`Research better practice and evidence for this lesson: ${l.text}`, DEFAULT_PRIORITY - 10);
  return out.slice(0, 5);
}

// --- the store ---------------------------------------------------------------------------

const memory = new Map(); // supUrl -> rows (the table not there yet, or no database)
const missing = new Set();
export function __resetAgenda() { memory.clear(); missing.clear(); }
const isMissing = (status, text) => status === 404 || /42P01|does not exist|schema cache/i.test(String(text || ''));
const COLS = 'id,goal,goal_key,kind,priority,status,continued_from,notes,source,experiment_id,attempts,created_at,updated_at';

export function createAgendaStore({ supUrl = null, supKey = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const memKey = supUrl || '(none)';
  const db = () => !!(supUrl && supKey && !missing.has(supUrl));
  const mem = () => { if (!memory.has(memKey)) memory.set(memKey, []); return memory.get(memKey); };
  const rest = async (path, init = {}) => {
    const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { cache: 'no-store', ...init, headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    const text = await res.text();
    if (!res.ok) {
      if (isMissing(res.status, text)) missing.add(supUrl);
      throw Object.assign(new Error(`lab agenda ${res.status}`), { status: res.status });
    }
    return text ? JSON.parse(text) : null;
  };
  const tryDb = async (fn, fallback) => {
    if (db()) { try { return await fn(); } catch (e) { if (!missing.has(supUrl)) throw e; } }
    return fallback();
  };
  const iso = () => new Date(now()).toISOString();
  const clean = (row) => {
    const out = {};
    if ('goal' in row) { out.goal = String(row.goal || '').replace(/\s+/g, ' ').trim().slice(0, 1000); out.goal_key = goalKey(out.goal); }
    if ('kind' in row) out.kind = LAB_KINDS.includes(row.kind) ? row.kind : 'research';
    if ('priority' in row) out.priority = Math.max(-1000, Math.min(100000, Math.round(Number(row.priority) || 0)));
    if ('status' in row) out.status = AGENDA_STATUSES.includes(row.status) ? row.status : 'open';
    if ('continued_from' in row) out.continued_from = /^[0-9a-f-]{36}$/i.test(String(row.continued_from || '')) ? row.continued_from : null;
    if ('experiment_id' in row) out.experiment_id = /^[0-9a-f-]{36}$/i.test(String(row.experiment_id || '')) ? row.experiment_id : null;
    if ('notes' in row) out.notes = row.notes == null ? null : String(row.notes).replace(/\u0000/g, '').slice(0, NOTES_MAX);
    if ('source' in row) out.source = ['history', 'pg1', 'operator'].includes(row.source) ? row.source : 'pg1';
    if ('attempts' in row) out.attempts = Math.max(0, Math.round(Number(row.attempts) || 0));
    return out;
  };
  const store = {
    get persistent() { return db(); },
    async list({ statuses = null, limit = 200 } = {}) {
      const n = Math.max(1, Math.min(500, limit));
      return tryDb(
        async () => (await rest(`${AGENDA_TABLE}?select=${COLS}${statuses ? `&status=in.(${statuses.join(',')})` : ''}&order=priority.desc,created_at.asc&limit=${n}`)) || [],
        () => mem().filter((r) => !statuses || statuses.includes(r.status)).slice().sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.seq - b.seq).slice(0, n)
      );
    },
    // Inserts the rows whose goal_key is not on the agenda yet; returns the new ones.
    async addMissing(rows) {
      const have = new Set((await store.list({ limit: 500 })).map((r) => r.goal_key));
      const fresh = [];
      for (const r of rows || []) { const c = { status: 'open', priority: DEFAULT_PRIORITY, source: 'pg1', attempts: 0, ...clean(r) }; if (!c.goal_key || have.has(c.goal_key)) continue; have.add(c.goal_key); fresh.push(c); }
      if (!fresh.length) return [];
      const at = iso();
      return tryDb(
        async () => {
          const out = [];
          // One at a time: PostgREST wants the same keys in every row of a bulk insert.
          for (const c of fresh) out.push(...((await rest(`${AGENDA_TABLE}?select=${COLS}`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ continued_from: null, notes: null, experiment_id: null, ...c, created_at: at, updated_at: at }) })) || []));
          return out;
        },
        () => fresh.map((c) => { const row = { id: globalThis.crypto.randomUUID(), continued_from: null, notes: null, experiment_id: null, ...c, created_at: at, updated_at: at, seq: mem().length }; mem().push(row); return row; })
      );
    },
    async update(id, patch) {
      const body = { ...clean(patch), updated_at: iso() };
      return tryDb(
        async () => ((await rest(`${AGENDA_TABLE}?id=eq.${encodeURIComponent(id)}&select=${COLS}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) })) || [])[0] || null,
        () => { const r = mem().find((x) => x.id === id); if (r) Object.assign(r, body); return r || null; }
      );
    },
    // By id or an 8+ character prefix of it (one match only).
    async find(ref) {
      const p = String(ref || '').toLowerCase().replace(/[^0-9a-f-]/g, '');
      if (p.length < 4) return null;
      const hits = (await store.list({ limit: 500 })).filter((r) => String(r.id).startsWith(p));
      return hits.length === 1 ? hits[0] : null;
    }
  };
  return store;
}

// Brings the agenda up to date with the lab's record (see the top of the
// file). history: light rows, newest first or any order; reportsFor(ids) ->
// Map id -> report. lessons: a lesson store (lib/core/reflect.mjs) or null.
// Resolves to { added, closed, reopened, lessons, seeded }. Never throws.
export async function syncAgenda({ agenda, history = [], reportsFor = async () => new Map(), lessons = null } = {}) {
  const out = { added: 0, closed: 0, reopened: 0, lessons: 0, seeded: false };
  try {
    const items = await agenda.list({ limit: 500 });
    const keys = new Map(items.map((i) => [i.goal_key, i]));
    out.seeded = items.length === 0;
    const byId = new Map((history || []).map((e) => [e.id, e]));
    // Items the loop is running: closed when their experiment ends.
    const ended = [];
    for (const it of items.filter((i) => i.status === 'running' && i.experiment_id)) {
      const e = byId.get(it.experiment_id);
      if (e && !['queued', 'running'].includes(e.status)) ended.push({ it, e });
    }
    // New goals (everything, the first time) and the ended runs need their reports.
    const fresh = (history || []).filter((e) => e && e.goal && !keys.has(goalKey(e.goal)));
    const ids = [...new Set([...reportIdsFor(fresh), ...ended.map((x) => x.e.id)])];
    const reports = ids.length ? await reportsFor(ids) : new Map();
    for (const { it, e } of ended) {
      const report = reports.get(e.id) || '';
      if (e.status === 'stopped') { await agenda.update(it.id, { status: 'dropped', experiment_id: null, continued_from: e.id, notes: 'Stopped by the operator.' }); out.closed++; continue; }
      const unfinished = ENDED_BAD.has(e.status) || searchSkipped(e);
      if (unfinished && (Number(it.attempts) || 0) < MAX_ATTEMPTS) {
        const why = e.status === 'done' ? 'the search was skipped' : `${e.status}: ${String(e.error || 'no reason recorded').slice(0, 300)}`;
        const found = findingsOf(report, NOTES_MAX - 400);
        await agenda.update(it.id, { status: 'open', experiment_id: null, continued_from: e.id, priority: CONTINUE_PRIORITY - 5 * (Number(it.attempts) || 0), notes: `Continue from ${String(e.id).slice(0, 8)} (${why}).${found ? `\nPrevious findings:\n${found}` : ''}` });
        out.reopened++;
      } else {
        await agenda.update(it.id, { status: 'done', experiment_id: null, continued_from: e.id, notes: unfinished ? `Rested after ${MAX_ATTEMPTS} attempts; the last ended ${e.status}.` : findingsOf(report, NOTES_MAX) || null });
        out.closed++;
      }
      if (e.status === 'done' && e.kind === 'research' && report && lessons) out.lessons += await proposeLessons(lessons, [{ text: lessonFromFindings(e, report), source_event: `lab:${e.id}` }]);
    }
    const built = agendaFromHistory(fresh, { reports, source: out.seeded ? 'history' : 'pg1' });
    out.added = (await agenda.addMissing(built.items)).length;
    if (lessons) out.lessons += await proposeLessons(lessons, built.lessons);
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 120);
  }
  return out;
}

// Lessons not already there (by the experiment they came from, or the text).
async function proposeLessons(store, list) {
  const todo = (list || []).filter((l) => l && l.text);
  if (!todo.length) return 0;
  const have = await store.list({ limit: 200 });
  let n = 0;
  for (const l of todo) {
    if (have.some((h) => h.source_event === l.source_event || h.text === l.text)) continue;
    const r = await store.propose(l.text, { sourceEvent: l.source_event });
    if (r && r.ok && !r.duplicate) n++;
  }
  return n;
}
