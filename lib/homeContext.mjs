// The home screen's live context (api/home-context.mjs): what the empty
// chat state says under the greeting and which four starting points it
// offers, from PG1's real current state. Signed-in operator only.
//
// gatherHomeContext() reads existing sources only (no AI call), each on its
// own with a short timeout:
//   approvals     operator report items + Autonomous approval cards
//                 (lib/operator/reports.mjs waitingApprovals)
//   report        the latest daily or weekly report: when, its number of
//                 findings (stored on the card since this change; left out
//                 for older reports) and whether it was opened (shown in
//                 the chat: delivered_at)
//   auto_merge    paused (a pinned merge not yet resumed), production
//                 pinned (lib/operator/merge.mjs productionPinned), on/off
//   deploy        the latest production deploy and its state
//   tasks         open operator tasks by kind
//   errors        real-caller errors in the last 24 h that were PG1's or a
//                 source's fault (lib/usageStats.mjs, fault "pg1")
//   firsts        first-ever events in the last 7 days: the first settled
//                 payment, the first completed A2A job, the first registry
//                 listing
//   experiments   lab experiments queued or running, sandbox runs running
//   autonomous    Autonomous mode on or off
// A source that cannot be read is left out: its key is absent. Nothing is
// estimated, and a figure is never filled in from anything else.
//
// pickHome() turns the signals into one subtitle and four cards. It is
// pure (no I/O) so the priority order is tested directly. None of this text
// is a chat reply: it never passes through the chat reply guard
// (lib/chatStream.mjs, lib/usageClaims.mjs and the rest), so its digits are
// shown as they are.

import { waitingApprovals, readDeploys } from './operator/reports.mjs';
import { productionPinned } from './operator/merge.mjs';
import { OPEN_TASK_STATUSES } from './operator/store.mjs';
import { autonomyMode } from './autonomy.mjs';
import { USAGE_TIME_ZONE } from './usageStats.mjs';

const H = 3600000;
const DAY = 24 * H;
export const HOME_CONTEXT_CACHE_MS = 60 * 1000;
export const SOURCE_TIMEOUT_MS = 4000;
export const FIRSTS_WINDOW_MS = 7 * DAY;
// A report counts as new (for the subtitle) for this long after it was made.
export const NEW_REPORT_MS = 36 * H;
const FAILED_DEPLOY_STATES = Object.freeze(['ERROR']);

// --- reading ---------------------------------------------------------------------

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })
  ]);
}

// { ok: true, value } or { ok: false }: a failed or slow source is left out.
async function readSource(fn, ms = SOURCE_TIMEOUT_MS) {
  try {
    return { ok: true, value: await withTimeout(fn(), ms) };
  } catch (e) {
    return { ok: false };
  }
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const within = (iso, now, ms) => { const t = Date.parse(iso || ''); return Number.isFinite(t) && t <= now && now - t <= ms; };

function supabaseRest({ supUrl, supKey, fetchImpl }) {
  return async (path) => {
    const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('not rows');
    return rows;
  };
}

// The earliest row of a query, or null when there is none.
async function earliest(rest, path) {
  const rows = await rest(path);
  return rows[0] || null;
}

export function reportSignal(daily, weekly) {
  const rows = [daily, weekly].filter(Boolean).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const r = rows[0];
  if (!r) return null;
  const out = { kind: r.kind === 'weekly' ? 'weekly' : 'daily', at: r.created_at, opened: !!r.delivered_at };
  const findings = r.card && r.card.findings;
  if (isNum(findings) && findings >= 0) out.findings = findings;
  return out;
}

export function realPg1Errors(stats) {
  if (!stats || stats.truncated) throw new Error('partial');
  const cells = stats.errors && Array.isArray(stats.errors.breakdown) ? stats.errors.breakdown : null;
  if (!cells) throw new Error('no breakdown');
  return cells.filter((c) => c && c.fault === 'pg1').reduce((n, c) => n + (Number(c.real) || 0), 0);
}

// deps (all optional, for tests): opStore, autoStore, labStore,
// sandboxStore, getStats, readDeploys, productionPinned, rest.
export async function gatherHomeContext({ env = process.env, supUrl = null, supKey = null, fetchImpl = globalThis.fetch, now = Date.now(), deps = {}, timeoutMs = SOURCE_TIMEOUT_MS } = {}) {
  const read = (fn) => readSource(fn, timeoutMs);
  const hasVault = !!(supUrl && supKey);
  const rest = deps.rest || (hasVault ? supabaseRest({ supUrl, supKey, fetchImpl }) : null);
  const lazy = async (name, make) => {
    if (deps[name] !== undefined) return deps[name];
    if (!hasVault) return null;
    return make();
  };
  const opStore = await lazy('opStore', async () => (await import('./operator/store.mjs')).createOperatorStore({ supUrl, supKey, fetchImpl }));
  const autoStore = await lazy('autoStore', async () => (await import('./autonomous/state.mjs')).createAutonomousStore({ supUrl, supKey, fetchImpl }));
  const labStore = await lazy('labStore', async () => (await import('./lab/store.mjs')).createLabStore({ supUrl, supKey, fetchImpl }));
  const sandboxStore = await lazy('sandboxStore', async () => (await import('./sandbox/store.mjs')).createSandboxStore({ supUrl, supKey, fetchImpl }));
  const need = (x) => { if (!x) throw new Error('not configured'); return x; };

  const [approvals, daily, weekly, held, pin, deploy, tasks, stats, firstPay, firstJob, firstListing, lab, sandbox, auto] = await Promise.all([
    read(() => waitingApprovals({ opStore: need(opStore), autoStore: need(autoStore) })),
    read(() => need(opStore).latestReport('daily')),
    read(() => need(opStore).latestReport('weekly')),
    read(() => need(opStore).listTasks({ statuses: ['rolled_back', 'merged'], limit: 50 })),
    read(() => (deps.productionPinned || productionPinned)({ env, fetchImpl, now })),
    read(async () => ((await (deps.readDeploys || readDeploys)({ env, fetchImpl, sinceMs: now - 30 * DAY, limit: 1 })) || [])[0] || null),
    read(() => need(opStore).listTasks({ statuses: [...OPEN_TASK_STATUSES], limit: 200 })),
    read(() => need(deps.getStats)({ period: '24h', now })),
    // First-ever events: the oldest row; it is a "first" when it is recent.
    read(() => earliest(need(rest), 'agent_telemetry?select=created_at&event_type=eq.settlement&status=eq.settled&is_fixture=eq.false&caller_kind=is.null&order=created_at.asc&limit=1')),
    read(() => earliest(need(rest), 'pg1_a2a_jobs?select=created_at,updated_at&status=eq.completed&order=created_at.asc&limit=1')),
    read(() => earliest(need(rest), 'pg1_operator_tasks?select=updated_at&kind=eq.listing&status=eq.done&order=updated_at.asc&limit=1')),
    read(async () => (await need(labStore).list(50)).filter((r) => r.status === 'queued' || r.status === 'running').length),
    read(async () => (await need(sandboxStore).listRuns({ limit: 50, status: 'running' })).length),
    read(async () => { const s = await need(autoStore).getState(); if (!s || s.error) throw new Error('unread'); return s; })
  ]);

  const out = {};
  if (approvals.ok) {
    const list = approvals.value || [];
    out.approvals = { total: list.length, tasks: list.filter((a) => a.source === 'task').length, autonomous: list.filter((a) => a.source === 'action').length };
  }
  if (daily.ok && weekly.ok) out.report = reportSignal(daily.value, weekly.value);

  const am = {};
  if (held.ok) am.paused = held.value.some((t) => t.approval && t.approval.pinned === true && !t.decided_at);
  if (pin.ok && pin.value && typeof pin.value.pinned === 'boolean') am.production_pinned = pin.value.pinned;
  if (am.paused === true) am.state = 'paused';
  else if (am.paused === false && auto.ok) am.state = auto.value.enabled === true && autonomyMode(env) === 'on' ? 'on' : 'off';
  delete am.paused;
  if (Object.keys(am).length) out.auto_merge = am;

  if (deploy.ok && deploy.value) out.deploy = { state: deploy.value.state, at: deploy.value.created_at, failed: FAILED_DEPLOY_STATES.includes(deploy.value.state) };
  if (tasks.ok) {
    const byKind = {};
    for (const t of tasks.value) if (t.status !== 'needs_approval') byKind[t.kind] = (byKind[t.kind] || 0) + 1;
    out.tasks = { total: Object.values(byKind).reduce((n, v) => n + v, 0), by_kind: byKind };
  }
  if (stats.ok) {
    try { out.errors = { real_pg1_24h: realPg1Errors(stats.value) }; } catch (e) { /* left out */ }
  }
  const firsts = [];
  const firstsRead = [firstPay, firstJob, firstListing].every((r) => r.ok);
  if (firstPay.ok && firstPay.value && within(firstPay.value.created_at, now, FIRSTS_WINDOW_MS)) firsts.push({ kind: 'payment', at: firstPay.value.created_at });
  if (firstJob.ok && firstJob.value && within(firstJob.value.updated_at || firstJob.value.created_at, now, FIRSTS_WINDOW_MS)) firsts.push({ kind: 'a2a_job', at: firstJob.value.updated_at || firstJob.value.created_at });
  if (firstListing.ok && firstListing.value && within(firstListing.value.updated_at, now, FIRSTS_WINDOW_MS)) firsts.push({ kind: 'registry_listing', at: firstListing.value.updated_at });
  // Some sources read: report what was found. None read: leave it out.
  if (firsts.length || firstsRead) out.firsts = firsts.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const ex = {};
  if (lab.ok) ex.lab = lab.value;
  if (sandbox.ok) ex.sandbox = sandbox.value;
  if (Object.keys(ex).length) out.experiments = ex;
  if (auto.ok) out.autonomous = { enabled: auto.value.enabled === true };
  return out;
}

// --- picking -----------------------------------------------------------------------

export const GENERIC_SUBTITLE = 'PG1 is online. Ask anything, or pick a starting point.';
export const DEFAULT_CARDS = Object.freeze([
  Object.freeze({ label: 'Run a threat radar', command: '/threat-radar', icon: 'i-radar' }),
  Object.freeze({ label: 'Check system status', command: '/status', icon: 'i-pulse' }),
  Object.freeze({ label: 'Review commerce', command: '/commerce-status', icon: 'i-cart' }),
  Object.freeze({ label: 'See all commands', command: '/help', icon: 'i-help' })
]);
const HELP_CARD = DEFAULT_CARDS[3];
export const HOME_STATES = Object.freeze(['pinned', 'deploy_failed', 'approvals', 'report', 'errors', 'first', 'experiments', 'quiet', 'generic']);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The day in PG1's reporting time zone ('2026-11-05').
export function homeDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: USAGE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

// One of the templates, the same all day, a different one most days.
export function pickTemplate(list, day, state) {
  const s = `${day}|${state}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}

function whenWord(iso, now) {
  const day = homeDay(Date.parse(iso));
  if (day === homeDay(now)) return 'today';
  if (day === homeDay(now - DAY)) return 'yesterday';
  return 'this week';
}

function reportName(r, now) {
  if (r.kind === 'weekly') return 'This week\'s report';
  const day = homeDay(Date.parse(r.at));
  return day === homeDay(now) ? 'Last night\'s report' : 'The latest daily report';
}

const FIRST_TEXT = {
  payment: (w) => [`First paid call settled ${w}.`, `The first paid call settled ${w}.`],
  a2a_job: (w) => [`First A2A job completed ${w}.`, `Another agent's first A2A job finished ${w}.`],
  registry_listing: (w) => [`PG1's first registry listing went out ${w}.`, `First registry listing done ${w}.`]
};

// The single most important true thing, by priority.
export function homeState(s) {
  const am = s.auto_merge || {};
  if (am.production_pinned === true) return 'pinned';
  if (s.deploy && s.deploy.failed) return 'deploy_failed';
  if (s.approvals && s.approvals.total > 0) return 'approvals';
  if (s.report && !s.report.opened && s.report.at && s.__now - Date.parse(s.report.at) <= NEW_REPORT_MS) return 'report';
  if (s.errors && s.errors.real_pg1_24h > 0) return 'errors';
  if (s.firsts && s.firsts.length) return 'first';
  if (s.experiments && ((s.experiments.lab || 0) + (s.experiments.sandbox || 0)) > 0) return 'experiments';
  // Calm only when it is known: errors read as none and nothing waiting.
  if (s.errors && s.errors.real_pg1_24h === 0 && s.approvals && s.approvals.total === 0) return 'quiet';
  return 'generic';
}

function subtitleFor(state, s, now, day) {
  const t = (list) => pickTemplate(list, day, state);
  switch (state) {
    case 'pinned': return t(['Production is pinned to an earlier deploy. Worth a look.', 'Production is serving an earlier deploy, so auto-merge waits.', 'An earlier deploy is pinned in production. Worth a look when you can.']);
    case 'deploy_failed': return t(['The latest production deploy failed. Worth a look.', 'The last production deploy did not go through.', 'A production deploy failed; the one before it is still serving.']);
    case 'approvals': {
      const n = s.approvals.total;
      return t([`${plural(n, 'approval')} ${n === 1 ? 'is' : 'are'} waiting for you.`, `${plural(n, 'item')} ${n === 1 ? 'needs' : 'need'} your approval.`, `You have ${plural(n, 'approval')} waiting.`]);
    }
    case 'report': {
      const name = reportName(s.report, now);
      const f = s.report.findings;
      if (isNum(f)) return t([`${name} is in, with ${plural(f, 'finding')}.`, `${name} is ready: ${plural(f, 'finding')}.`]);
      return t([`${name} is in.`, `${name} is ready to read.`]);
    }
    case 'errors': {
      const n = s.errors.real_pg1_24h;
      return t([`${plural(n, 'call')} from real callers failed on PG1's side in the last 24 hours.`, `Real callers hit ${plural(n, 'error')} on PG1's side since yesterday.`, `${plural(n, 'error')} on PG1's side reached real callers in the last day.`]);
    }
    case 'first': {
      const f = s.firsts[0];
      return t(FIRST_TEXT[f.kind](whenWord(f.at, now)));
    }
    case 'experiments': {
      const lab = s.experiments.lab || 0;
      const sb = s.experiments.sandbox || 0;
      const parts = [lab ? plural(lab, 'lab experiment') : '', sb ? plural(sb, 'sandbox run') : ''].filter(Boolean).join(' and ');
      const many = lab + sb !== 1;
      return t([`${parts} ${many ? 'are' : 'is'} running.`, `PG1 has ${parts} going right now.`]);
    }
    case 'quiet': return t(['All quiet: no errors overnight and nothing waiting.', 'Quiet so far: no errors for real callers, nothing waiting.', 'Nothing waiting and no errors in the last day.']);
    default: return GENERIC_SUBTITLE;
  }
}

function cardsFor(state, s) {
  const out = [];
  const add = (label, command, icon) => out.push({ label, command, icon });
  const am = s.auto_merge || {};
  if (am.production_pinned === true) add('Check production', '/status', 'i-pulse');
  if (s.deploy && s.deploy.failed) add('Check the failed deploy', '/status', 'i-pulse');
  if (am.state === 'paused' && am.production_pinned !== true) add('Check the paused auto-merge', '/report resume', 'i-sync');
  if (s.approvals && s.approvals.total > 0) add(`Review ${plural(s.approvals.total, 'approval')}`, '/report today', 'i-check');
  if (s.report && !s.report.opened) add(s.report.kind === 'weekly' ? 'Read this week\'s report' : 'Read today\'s report', s.report.kind === 'weekly' ? '/report week' : '/report today', 'i-file');
  if (s.errors && s.errors.real_pg1_24h > 0) add(`See ${plural(s.errors.real_pg1_24h, 'error')} by fault`, '/usage 24h', 'i-alert');
  for (const f of s.firsts || []) {
    if (f.kind === 'payment') add('Review commerce', '/commerce-status', 'i-cart');
    if (f.kind === 'a2a_job') add('See the A2A jobs', '/a2a jobs', 'i-file');
    if (f.kind === 'registry_listing') add('Read the weekly report', '/report week', 'i-file');
  }
  if (s.experiments && s.experiments.lab > 0) add(`See ${plural(s.experiments.lab, 'lab experiment')}`, '/lab status', 'i-code');
  if (s.experiments && s.experiments.sandbox > 0) add(`See ${plural(s.experiments.sandbox, 'sandbox run')}`, '/sandbox', 'i-code');
  if (s.autonomous && s.autonomous.enabled) add('See what PG1 did overnight', '/autonomy', 'i-eye');
  if (s.report && s.report.opened && state !== 'generic') add(s.report.kind === 'weekly' ? 'Read this week\'s report' : 'Read today\'s report', s.report.kind === 'weekly' ? '/report week' : '/report today', 'i-file');
  // Today's defaults fill the rest; /help is always the last card.
  for (const d of DEFAULT_CARDS.slice(0, 3)) out.push({ ...d });
  const seen = new Set([HELP_CARD.command]);
  const picked = [];
  for (const c of out) {
    if (seen.has(c.command)) continue;
    seen.add(c.command);
    picked.push(c);
    if (picked.length === 3) break;
  }
  return [...picked, { ...HELP_CARD }];
}

export function pickHome(signals, { now = Date.now() } = {}) {
  const s = { ...(signals || {}), __now: now };
  const state = homeState(s);
  const day = homeDay(now);
  return { state, subtitle: subtitleFor(state, s, now, day), cards: cardsFor(state, s) };
}
