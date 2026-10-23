// Autonomous mode: the operator's one ON/OFF switch (the Command Centre
// header, /auto on|off|status|log), shared by every device and every server
// instance through Supabase (pg1_autonomous_state), and the audit log of
// every autonomous action (pg1_autonomous_actions,
// supabase/migrations/20261104120000_pg1_autonomous.sql).
//
// OFF is an instant kill switch:
//   - no new autonomous action starts (runAutonomousAction reads the state
//     fresh before it starts one),
//   - queued actions are cancelled when it goes off,
//   - running ones stop at their next safe checkpoint (checkpoint() reads
//     the state again and throws AutonomousStopped).
// Background jobs, crons and webhook handlers call refreshAutonomousSnapshot()
// first; lib/autonomy.mjs authorize() then refuses PG1's own actions while
// the switch is off (safety actions such as alerts still run).
//
// Automatic OFF, with one push to the operator, when:
//   - more than max_actions_per_hour actions started in the last hour
//     (default 30, /auto limit <n>),
//   - the same action type failed 3 times in a row,
//   - today's autonomous spend reached daily_budget_usd (default $0: free
//     tiers only; /auto budget <usd>). The cap is enforced before every
//     action: an action whose estimate would pass it does not start.
//
// The guardrails the switch can never lift (Part 3's hard guardrails) live
// in ACTION_TYPES (the allowlist) and in each capability; nothing here can
// merge, deploy, change a schema or data, or send to a client.
//
// The log holds no secrets or personal data: every text field goes through
// scrub() (keys, tokens, emails, phone numbers removed; capped) before it is
// written. A switch that cannot be read counts as OFF for Autonomous
// mode's own actions.

export const STATE_TABLE = 'pg1_autonomous_state';
export const ACTIONS_TABLE = 'pg1_autonomous_actions';
export const DEFAULT_MAX_PER_HOUR = 30;
export const DEFAULT_DAILY_BUDGET_USD = 0;
export const FAILURE_STREAK = 3;
export const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

// The action allowlist: the only autonomous action types that may run.
// Anything else is refused and logged as refused.
export const ACTION_TYPES = Object.freeze({
  self_heal: 'Self-healing ops (draft PR only)',
  feed_guardian: 'Feed guardian',
  engine_watchdog: 'Engine and credit watchdog',
  mission: 'Mission task',
  daily_briefing: 'Daily briefing',
  lab_autopilot: 'Lab autopilot',
  integration_watch: 'Integration watch',
  // PG1 Sandbox (lib/sandbox): simulations only, free engines only.
  world_mission: 'World mission (simulation)',
  world_experiment: 'Sandbox experiment (simulation)'
});
export const isAllowedType = (type) => Object.hasOwn(ACTION_TYPES, String(type || ''));

export class AutonomousStopped extends Error {
  constructor(reason = 'Autonomous mode was switched off') { super(reason); this.name = 'AutonomousStopped'; }
}

// --- scrubbing ------------------------------------------------------------------

const SECRET_RES = [
  /\b(?:sk|pk|rk)[-_](?:ant-|live-|test-|or-)?[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g, /\bAQ\.[0-9A-Za-z_-]{16,}/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(?:gsk|vck|r8|cf|hf)_[A-Za-z0-9_-]{12,}/g,
  /(?:api[_-]?key|token|secret|password|passkey|authorization|bearer)\s*[:=]\s*\S+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g
];
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\+\d[\d\s().-]{7,}\d/g;
export function scrub(value, max = 200, envValues = []) {
  let t = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const v of envValues) if (v && String(v).length >= 8) t = t.split(String(v)).join('[secret]');
  for (const re of SECRET_RES) t = t.replace(re, '[secret]');
  t = t.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// A longer report (the daily briefing): line breaks kept, each line scrubbed.
export function scrubBody(text, envValues = []) {
  const out = String(text == null ? '' : text).split('\n').slice(0, 80).map((l) => (l.trim() ? scrub(l, 400, envValues) : '')).join('\n');
  return out.length > 4000 ? `${out.slice(0, 3999)}…` : out;
}

// Every string inside an object (an approval card), scrubbed and capped.
export function scrubDeep(value, envValues = [], depth = 0) {
  if (depth > 4) return null;
  if (typeof value === 'string') return scrub(value, 1500, envValues);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubDeep(v, envValues, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [String(k).slice(0, 40), scrubDeep(v, envValues, depth + 1)]));
  return typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

// --- the snapshot every instance keeps (lib/autonomy.mjs reads it) -------------

let snapshot = null; // { enabled, at }
export function setAutonomousSnapshot(enabled, at = Date.now()) { snapshot = { enabled: enabled === true, at }; }
// true / false while the last read is fresh, null when this instance does not know.
export function autonomousSnapshot(now = Date.now()) {
  return snapshot && now - snapshot.at <= SNAPSHOT_TTL_MS ? snapshot.enabled : null;
}
export function clearAutonomousSnapshot() { snapshot = null; }
export function __resetAutonomousSnapshot() { snapshot = null; }

// --- the store ---------------------------------------------------------------------

export function createAutonomousStore({ supUrl, supKey, fetchImpl = globalThis.fetch, now = () => Date.now(), envValues = [] } = {}) {
  const configured = !!(supUrl && supKey);
  const headers = (extra = {}) => ({ apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra });
  const rest = async (path, opts = {}) => {
    if (!configured) { const e = new Error('autonomous store not configured'); e.status = 503; throw e; }
    const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { cache: 'no-store', ...opts, headers: headers(opts.headers || {}) });
    if (!res.ok) { const e = new Error(`autonomous store ${res.status}`); e.status = res.status; throw e; }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  const DEFAULT_STATE = { enabled: false, changed_at: null, changed_by: 'operator', reason: null, max_actions_per_hour: DEFAULT_MAX_PER_HOUR, daily_budget_usd: DEFAULT_DAILY_BUDGET_USD, known: false };
  const clean = (row = {}) => {
    const out = {};
    if ('type' in row) out.type = scrub(row.type, 40);
    for (const k of ['reason']) if (k in row) out[k] = row[k] == null ? null : scrub(row[k], 200, envValues);
    if ('inputs_summary' in row) out.inputs_summary = row.inputs_summary == null ? null : scrub(row.inputs_summary, 300, envValues);
    if ('result' in row) out.result = row.result == null ? null : scrub(row.result, 500, envValues);
    if ('body' in row) out.body = row.body == null ? null : scrubBody(row.body, envValues);
    if ('delivered_at' in row) out.delivered_at = row.delivered_at;
    if ('link' in row) out.link = row.link && /^https:\/\/[^\s]{1,290}$/.test(String(row.link)) ? String(row.link) : null;
    if ('status' in row) out.status = row.status;
    if ('cost_usd' in row) out.cost_usd = Math.max(0, Number(row.cost_usd) || 0);
    if ('finished_at' in row) out.finished_at = row.finished_at;
    if ('approval' in row) out.approval = row.approval ? scrubDeep(row.approval, envValues) : null;
    return out;
  };
  return {
    configured,
    async getState() {
      try {
        const rows = await rest(`${STATE_TABLE}?id=eq.global&select=enabled,changed_at,changed_by,reason,max_actions_per_hour,daily_budget_usd`);
        const row = Array.isArray(rows) && rows[0] ? { ...DEFAULT_STATE, ...rows[0], daily_budget_usd: Number(rows[0].daily_budget_usd) || 0, known: true } : { ...DEFAULT_STATE, known: true };
        setAutonomousSnapshot(row.enabled === true, now());
        return row;
      } catch (e) {
        // Unreachable, or a table that does not exist yet (the migration not
        // applied): OFF for Autonomous mode's own actions (they need the
        // switch read as ON), and this instance's snapshot cleared, so the
        // older PG1_AUTONOMY rule keeps governing the rest meanwhile.
        clearAutonomousSnapshot();
        return { ...DEFAULT_STATE, error: e.status || 'unreachable' };
      }
    },
    async setState(patch) {
      const body = { id: 'global', changed_at: new Date(now()).toISOString(), ...patch };
      if ('reason' in body) body.reason = body.reason == null ? null : scrub(body.reason, 200, envValues);
      const rows = await rest(`${STATE_TABLE}?on_conflict=id`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(body) });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row && 'enabled' in row) setAutonomousSnapshot(row.enabled === true, now());
      return row;
    },
    async insertAction(row) {
      const rows = await rest(ACTIONS_TABLE, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(clean(row)) });
      return Array.isArray(rows) ? rows[0] : rows;
    },
    async updateAction(id, patch) {
      const rows = await rest(`${ACTIONS_TABLE}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(clean(patch)) });
      return Array.isArray(rows) ? rows[0] : rows;
    },
    async getAction(id) {
      const rows = await rest(`${ACTIONS_TABLE}?id=eq.${encodeURIComponent(id)}&select=*`);
      return Array.isArray(rows) ? rows[0] || null : null;
    },
    async listActions({ sinceIso = null, limit = 50, statuses = null, type = null, before = null } = {}) {
      const q = ['select=id,at,type,reason,inputs_summary,status,result,cost_usd,link,finished_at,approval,body,delivered_at', 'order=at.desc', `limit=${Math.max(1, Math.min(500, limit))}`];
      if (sinceIso) q.push(`at=gte.${encodeURIComponent(sinceIso)}`);
      if (before) q.push(`at=lt.${encodeURIComponent(before)}`);
      if (statuses) q.push(`status=in.(${statuses.join(',')})`);
      if (type) q.push(`type=eq.${encodeURIComponent(type)}`);
      return (await rest(`${ACTIONS_TABLE}?${q.join('&')}`)) || [];
    },
    async cancelQueued() {
      const rows = await rest(`${ACTIONS_TABLE}?status=eq.queued`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'cancelled', result: 'Cancelled: Autonomous mode was switched off.', finished_at: new Date(now()).toISOString() }) });
      return Array.isArray(rows) ? rows.length : 0;
    }
  };
}

// --- days and counts -------------------------------------------------------------------

export const utcDayStartIso = (now = Date.now()) => `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;

// Actions that count against the hourly limit: everything that started.
const STARTED = ['running', 'done', 'failed', 'stopped'];

export async function todaySummary(store, now = Date.now()) {
  const rows = await store.listActions({ sinceIso: utcDayStartIso(now), limit: 500 });
  const started = rows.filter((r) => STARTED.includes(r.status));
  return { count: started.length, costUsd: rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0), pendingApprovals: rows.filter((r) => r.status === 'needs_approval').length, rows };
}

// --- switching ------------------------------------------------------------------------------

// OFF from the operator or from a guardrail: queued actions are cancelled.
export async function switchOff(store, { by = 'operator', reason = 'Switched off by the operator', notify = null } = {}) {
  const row = await store.setState({ enabled: false, changed_by: by, reason });
  let cancelled = 0;
  try { cancelled = await store.cancelQueued(); } catch (e) { /* the switch itself is what matters */ }
  if (by === 'auto_off' && notify) {
    try { await notify({ title: 'PG1 Autonomous mode is OFF', body: reason }); } catch (e) { /* a push never blocks the stop */ }
  }
  return { state: row, cancelled };
}

export async function switchOn(store, { reason = 'Switched on by the operator' } = {}) {
  return { state: await store.setState({ enabled: true, changed_by: 'operator', reason }) };
}

export async function setLimits(store, { maxPerHour = null, dailyBudgetUsd = null } = {}) {
  const patch = {};
  if (maxPerHour != null) patch.max_actions_per_hour = Math.max(1, Math.min(1000, Math.round(Number(maxPerHour))));
  if (dailyBudgetUsd != null) patch.daily_budget_usd = Math.max(0, Math.round(Number(dailyBudgetUsd) * 100) / 100);
  return store.setState(patch);
}

// --- running one action -------------------------------------------------------------------------

// Runs one autonomous action within the guardrails. run({ checkpoint,
// actionId }) does the work and resolves to { ok, result, costUsd?, link?,
// needsApproval?: { title, detail, kind, payload } }; it calls checkpoint()
// between steps (a safe point to stop at). Resolves to
// { started, status, id?, reason? }. Never throws.
//   estimateUsd   the action's worst-case paid AI spend (0 for free work)
//   notify        ({ title, body }) => push to the operator
// queuedId: a queued row (queueAutonomousAction) to run now instead of a
// new row; it only runs if the switch is still on.
export async function runAutonomousAction({ store, type, reason = '', inputsSummary = '', estimateUsd = 0, run, notify = null, now = () => Date.now(), log = () => {}, queuedId = null }) {
  if (!isAllowedType(type)) {
    try { await store.insertAction({ type: String(type || 'unknown').slice(0, 40), reason, inputs_summary: inputsSummary, status: 'refused', result: 'Not on the autonomous action allowlist.', finished_at: new Date(now()).toISOString() }); } catch (e) { /* refusing needs no log to succeed */ }
    return { started: false, status: 'refused', reason: 'not on the allowlist' };
  }
  const state = await store.getState();
  if (!state.enabled) return { started: false, status: 'off', reason: state.error ? 'Autonomous mode is unavailable (its table cannot be read)' : 'Autonomous mode is off' };

  let today;
  let lastHour;
  try {
    today = await todaySummary(store, now());
    lastHour = today.rows.filter((r) => STARTED.includes(r.status) && Date.parse(r.at) >= now() - 3600000).length;
  } catch (e) {
    return { started: false, status: 'off', reason: 'the audit log cannot be read, so nothing starts' };
  }
  if (lastHour >= state.max_actions_per_hour) {
    await switchOff(store, { by: 'auto_off', reason: `More than ${state.max_actions_per_hour} autonomous actions in an hour: switched off for safety.`, notify });
    return { started: false, status: 'auto_off', reason: 'hourly limit' };
  }
  const budget = Number(state.daily_budget_usd) || 0;
  const est = Math.max(0, Number(estimateUsd) || 0);
  if (est > 0 && today.costUsd + est > budget) {
    if (today.costUsd >= budget && budget > 0) await switchOff(store, { by: 'auto_off', reason: `Today's autonomous budget of $${budget.toFixed(2)} is used up.`, notify });
    const refusal = { status: 'refused', finished_at: new Date(now()).toISOString(), result: budget > 0 ? `Would pass today's budget ($${today.costUsd.toFixed(2)} of $${budget.toFixed(2)} spent).` : 'Paid AI spend is $0 for autonomous work (free tiers only).' };
    if (queuedId) { try { await store.updateAction(queuedId, refusal); } catch (e) { /* logged when possible */ } return { started: false, status: 'refused', reason: 'budget' }; }
    try { await store.insertAction({ type, reason, inputs_summary: inputsSummary, status: 'refused', result: budget > 0 ? `Would pass today's budget ($${today.costUsd.toFixed(2)} of $${budget.toFixed(2)} spent).` : 'Paid AI spend is $0 for autonomous work (free tiers only).', finished_at: new Date(now()).toISOString() }); } catch (e) { /* logged when possible */ }
    return { started: false, status: 'refused', reason: 'budget' };
  }

  let row;
  try {
    row = queuedId
      ? await store.updateAction(queuedId, { status: 'running' })
      : await store.insertAction({ type, reason, inputs_summary: inputsSummary, status: 'running' });
  } catch (e) { return { started: false, status: 'off', reason: 'the audit log cannot be written, so nothing starts' }; }
  const id = row && row.id;
  const checkpoint = async () => {
    const s = await store.getState();
    if (!s.enabled) throw new AutonomousStopped();
  };
  let out;
  let status;
  try {
    out = (await run({ checkpoint, actionId: id })) || { ok: false, result: 'no result' };
    status = out.needsApproval ? 'needs_approval' : out.ok ? 'done' : 'failed';
  } catch (e) {
    if (e instanceof AutonomousStopped) { out = { ok: false, result: 'Stopped at a safe checkpoint: Autonomous mode was switched off.' }; status = 'stopped'; }
    else { out = { ok: false, result: `Failed: ${e && e.message ? e.message : 'error'}` }; status = 'failed'; }
  }
  const patch = { status, result: out.result || '', cost_usd: Number(out.costUsd) || 0, finished_at: status === 'needs_approval' ? null : new Date(now()).toISOString() };
  if (out.link) patch.link = out.link;
  if (out.body) patch.body = out.body;
  if (out.needsApproval) patch.approval = out.needsApproval;
  try { if (id) await store.updateAction(id, patch); } catch (e) { try { log(`[pg1-auto] could not finish action ${id}`); } catch (e2) { /* nothing */ } }

  // Guardrails after the fact: a failure streak, the day's budget.
  try {
    if (status === 'failed') {
      const recent = await store.listActions({ type, limit: FAILURE_STREAK, statuses: ['done', 'failed', 'stopped', 'needs_approval'] });
      if (recent.length >= FAILURE_STREAK && recent.every((r) => r.status === 'failed')) {
        await switchOff(store, { by: 'auto_off', reason: `${ACTION_TYPES[type]} failed ${FAILURE_STREAK} times in a row: switched off for safety.`, notify });
      }
    }
    if (budget > 0 && today.costUsd + patch.cost_usd >= budget) {
      await switchOff(store, { by: 'auto_off', reason: `Today's autonomous budget of $${budget.toFixed(2)} is used up.`, notify });
    }
  } catch (e) { /* the action is recorded; the next start checks again */ }
  return { started: true, status, id, result: out.result, link: out.link || null };
}

// Queues an action to run later (missions): it only runs if the switch is
// still on then; switching off cancels it.
export async function queueAutonomousAction(store, { type, reason = '', inputsSummary = '' }) {
  if (!isAllowedType(type)) return null;
  const s = await store.getState();
  if (!s.enabled) return null;
  return store.insertAction({ type, reason, inputs_summary: inputsSummary, status: 'queued' });
}

// Background jobs, crons and webhook handlers: read the switch before any
// autonomous action (and refresh this instance's snapshot for authorize()).
// Without a database there is no switch: false, snapshot cleared.
export async function refreshAutonomousSnapshot({ supUrl, supKey, fetchImpl = globalThis.fetch } = {}) {
  if (!supUrl || !supKey) { clearAutonomousSnapshot(); return false; }
  const s = await createAutonomousStore({ supUrl, supKey, fetchImpl }).getState();
  return s.enabled === true;
}
