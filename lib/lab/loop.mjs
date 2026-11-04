// The continuous lab loop: while Autonomous mode is ON, PG1 runs lab
// experiments of every kind (research, skill, code) from its research
// agenda (lib/lab/agenda.mjs), one at a time, back to back. The Autonomous
// tick (lib/autonomous/runner.mjs, every 10 minutes) asks loopDecision
// whether the next one may start:
//
//   one at a time  nothing queued, and nothing running that has not reached
//                  its gate (a code experiment waiting days on CI for the
//                  gate does not hold the loop up)
//   gap            PG1_LAB_GAP_MINUTES (default 10) since the last one ended
//   daily cap      PG1_LAB_MAX_PER_DAY (default 24) experiments a UTC day,
//                  whoever started them
//   backing off    when the free engines are cooling down (their quota
//                  cool-downs, lib/router/quota.mjs), and after runs that
//                  ended on an engine's quota or rate limit: the gap doubles
//                  for each one in a row, up to 4 hours
//
// A run at $0 (labPaidOff) uses only the free engines and records $0, so
// its estimate is $0 (labEstimateUsd) and the $0 Autonomous budget never
// refuses it. Only a run that will call a paid engine carries the lab's
// per-experiment budget as its estimate.
//
// Nothing here changes the gate: code reaches GitHub only as a draft PR from
// the lab workflow's pull job, after the test job (no secrets, network
// blocked), and promotion needs the gate and the operator's /promote.

import { labPaidOff, labBudgetUsd } from './policy.mjs';
import { planRoute, TASKS, DATA, isPaidProvider } from '../aiRouter.mjs';
import { isCooling, readyModels, coolingUntil } from '../router/quota.mjs';

export const DEFAULT_LAB_GAP_MINUTES = 10;
export const DEFAULT_LAB_MAX_PER_DAY = 24;
export const MAX_BACKOFF_MINUTES = 240;
const QUOTA_ERROR = /\b429\b|rate[ -]?limit|quota|cool(?:ing|s)? down|cooling|resting|busy|spending cap|out of credit|paused/i;

const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : d; };
export const labGapMinutes = (env = process.env) => num(env.PG1_LAB_GAP_MINUTES, DEFAULT_LAB_GAP_MINUTES, 0, 1440);
export const labMaxPerDay = (env = process.env) => Math.round(num(env.PG1_LAB_MAX_PER_DAY, DEFAULT_LAB_MAX_PER_DAY, 0, 500));

// The paid estimate of the next lab run: $0 when it runs on the free engines.
export function labEstimateUsd(env = process.env) {
  return labPaidOff(env) ? 0 : labBudgetUsd(env);
}

// Whether every free text engine this deployment has is cooling down.
// { cooling, until } (until: when the first one is back, ms).
export function freeEnginesCooling(env = process.env, now = Date.now()) {
  let plan = [];
  try { plan = planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR, background: true }).filter((c) => !isPaidProvider(c.provider) && (c.family === 'gemini' || c.family === 'openai_compat')); } catch (e) { plan = []; }
  if (!plan.length) return { cooling: false, until: null };
  const cool = (c) => isCooling(c.provider, '*', now) || (Array.isArray(c.models) && c.models.length > 0 && readyModels(c.provider, c.models, now).length === 0);
  if (!plan.every(cool)) return { cooling: false, until: null };
  const until = Math.min(...plan.map((c) => coolingUntil(c.provider, '*', now) || now + 15 * 60000));
  return { cooling: true, until };
}

const utcDayStart = (now) => Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`);
const t = (iso) => Date.parse(iso || '') || 0;

// rows: the latest experiments (id, created_at, updated_at, status,
// candidate, error), any order. Returns { go, reason, waitUntil? }.
export function loopDecision({ rows = [], env = process.env, now = Date.now(), cooling = { cooling: false } } = {}) {
  const list = (rows || []).filter(Boolean);
  const active = list.filter((e) => e.status === 'queued' || (e.status === 'running' && !e.candidate));
  if (active.length) return { go: false, reason: `one at a time: experiment ${String(active[0].id).slice(0, 8)} is ${active[0].status}` };
  const cap = labMaxPerDay(env);
  const today = list.filter((e) => t(e.created_at) >= utcDayStart(now)).length;
  if (today >= cap) return { go: false, reason: `the daily cap: ${today} of ${cap} experiments today (PG1_LAB_MAX_PER_DAY); more after 00:00 UTC`, waitUntil: utcDayStart(now) + 86400000 };
  if (cooling && cooling.cooling) return { go: false, reason: 'backing off: the free engines are cooling down', waitUntil: cooling.until || null };
  // Newest first by when they ended.
  const ended = list.filter((e) => !['queued', 'running'].includes(e.status)).sort((a, b) => t(b.updated_at || b.created_at) - t(a.updated_at || a.created_at));
  let quotaRun = 0;
  for (const e of ended) { if (e.status !== 'done' && QUOTA_ERROR.test(String(e.error || ''))) quotaRun++; else break; }
  const gapMin = Math.min(MAX_BACKOFF_MINUTES, labGapMinutes(env) * 2 ** quotaRun);
  const last = ended[0] || list.slice().sort((a, b) => t(b.created_at) - t(a.created_at))[0];
  const lastAt = last ? Math.max(t(last.updated_at), t(last.created_at)) : 0;
  if (last && now - lastAt < gapMin * 60000) return { go: false, reason: quotaRun ? `backing off: the last ${quotaRun === 1 ? 'run' : `${quotaRun} runs`} hit an engine's quota; waiting ${gapMin} minutes` : `the gap: ${gapMin} minutes between runs (PG1_LAB_GAP_MINUTES)`, waitUntil: lastAt + gapMin * 60000 };
  return { go: true, reason: 'ready' };
}
