// Feature flags for promoted lab work (lib/lab), Foundry tools (P9) and new
// public tools: public.pg1_feature_flags, one row per key.
//
//   stage  operator   on for the signed-in operator only (first rollout)
//          public     on for everyone (/promote <key>)
//          disabled   off; disabled_reason says why (the operator, or the
//                     hourly monitor)
//
// The monitor (api/flags/monitor.mjs, hourly cron) reads the last hour for
// each operator- or public-stage flag: its error rate from agent_telemetry
// (tool_name = key) and its cost per call from the usage ledger
// (pg1_ai_usage, task = cost_task). Over a threshold with at least
// min_calls calls, the flag is disabled and the operator is told (error log,
// category alert). Defaults: error rate 25%, cost per call from the flag.

import { ERROR_STATUSES } from './usageStats.mjs';
import { notifyOperator } from './notify.mjs';

export const FLAG_TABLE = 'pg1_feature_flags';
export const FLAG_STAGES = Object.freeze(['operator', 'public', 'disabled']);
export const DEFAULT_MAX_ERROR_RATE = 0.25;
export const DEFAULT_MIN_CALLS = 5;
export const FLAG_CACHE_MS = 30000;

function headers(supKey, extra = {}) {
  return { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra };
}

export function createFlagStore({ supUrl, supKey, fetchImpl = globalThis.fetch }) {
  if (!supUrl || !supKey) throw new Error('flags need the vault (Supabase)');
  const rest = async (path, options = {}) => {
    const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { ...options, headers: headers(supKey, options.headers), cache: 'no-store' });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`flags storage ${res.status}`), { status: res.status });
    return text ? JSON.parse(text) : null;
  };
  const one = (r) => (Array.isArray(r) ? r[0] || null : r);
  return {
    async list() {
      const rows = await rest(`${FLAG_TABLE}?select=*&order=key.asc&limit=500`);
      return Array.isArray(rows) ? rows : [];
    },
    async get(key) {
      if (!/^[a-z0-9:_-]{2,64}$/.test(String(key))) return null;
      return one(await rest(`${FLAG_TABLE}?select=*&key=eq.${encodeURIComponent(key)}`));
    },
    async upsert(flag) {
      return one(await rest(`${FLAG_TABLE}?select=*&on_conflict=key`, { method: 'POST', headers: { Prefer: 'return=representation,resolution=merge-duplicates' }, body: JSON.stringify({ ...flag, updated_at: new Date().toISOString() }) }));
    },
    async setStage(key, stage, reason = null) {
      if (!FLAG_STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
      return one(await rest(`${FLAG_TABLE}?key=eq.${encodeURIComponent(key)}&select=*`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ stage, disabled_reason: stage === 'disabled' ? String(reason || 'disabled').slice(0, 300) : null, updated_at: new Date().toISOString() }) }));
    },
    async toolMetrics(key, sinceIso) {
      const rows = await rest(`agent_telemetry?select=status&tool_name=eq.${encodeURIComponent(key)}&event_type=eq.tool_call&created_at=gte.${encodeURIComponent(sinceIso)}&limit=10000`);
      const list = Array.isArray(rows) ? rows : [];
      return { calls: list.length, errors: list.filter((r) => ERROR_STATUSES.includes(r.status)).length };
    },
    async costSince(task, sinceIso) {
      if (!task) return null;
      const rows = await rest(`pg1_ai_usage?select=cost_usd&task=eq.${encodeURIComponent(task)}&at=gte.${encodeURIComponent(sinceIso)}&limit=10000`);
      return (Array.isArray(rows) ? rows : []).reduce((n, r) => n + (Number(r.cost_usd) || 0), 0);
    }
  };
}

// Is the flag on for this caller? Unknown flags are off.
export function flagOn(flag, { isOperator = false } = {}) {
  if (!flag) return false;
  if (flag.stage === 'public') return true;
  if (flag.stage === 'operator') return isOperator === true;
  return false;
}

let cache = { at: 0, rows: null };
export function __clearFlagCache() {
  cache = { at: 0, rows: null };
}
export async function cachedFlags({ supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (cache.rows && now - cache.at < FLAG_CACHE_MS) return cache.rows;
  try {
    const rows = await createFlagStore({ supUrl, supKey, fetchImpl }).list();
    cache = { at: now, rows };
    return rows;
  } catch (e) {
    return cache.rows || [];
  }
}

// One flag's verdict for the last hour: { breach, reason, errorRate, costPerCall, calls }.
export function judgeFlag(flag, { calls = 0, errors = 0, costUsd = null }) {
  const t = flag.thresholds && typeof flag.thresholds === 'object' ? flag.thresholds : {};
  const minCalls = Number.isInteger(t.min_calls) && t.min_calls > 0 ? t.min_calls : DEFAULT_MIN_CALLS;
  const maxErr = Number.isFinite(Number(t.max_error_rate)) ? Number(t.max_error_rate) : DEFAULT_MAX_ERROR_RATE;
  const maxCost = Number.isFinite(Number(t.max_cost_per_call_usd)) && Number(t.max_cost_per_call_usd) > 0 ? Number(t.max_cost_per_call_usd) : null;
  const errorRate = calls ? errors / calls : 0;
  const costPerCall = calls && costUsd != null ? costUsd / calls : null;
  if (calls < minCalls) return { breach: false, reason: null, errorRate, costPerCall, calls };
  if (errorRate > maxErr) return { breach: true, reason: `error rate ${(errorRate * 100).toFixed(1)}% over ${(maxErr * 100).toFixed(0)}% in the last hour (${errors} of ${calls} calls)`, errorRate, costPerCall, calls };
  if (maxCost != null && costPerCall != null && costPerCall > maxCost) return { breach: true, reason: `cost per call $${costPerCall.toFixed(4)} over $${maxCost} in the last hour (${calls} calls)`, errorRate, costPerCall, calls };
  return { breach: false, reason: null, errorRate, costPerCall, calls };
}

// The hourly check. Disables every breaching flag and tells the operator.
export async function monitorFlags({ supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), notify = notifyOperator }) {
  const store = createFlagStore({ supUrl, supKey, fetchImpl });
  const since = new Date(now - 3600000).toISOString();
  const out = [];
  for (const flag of await store.list()) {
    if (flag.stage === 'disabled') continue;
    try {
      const m = await store.toolMetrics(flag.key, since);
      const costUsd = await store.costSince(flag.cost_task, since);
      const v = judgeFlag(flag, { ...m, costUsd });
      if (v.breach) {
        await store.setStage(flag.key, 'disabled', `auto-disabled: ${v.reason}`);
        await notify({ supUrl, supKey, route: '/flags', reason: 'flag_auto_disabled', message: `${flag.key} was switched off automatically: ${v.reason}. Re-enable with /promote ${flag.key} after fixing it.` });
      }
      out.push({ key: flag.key, ...v });
    } catch (e) {
      out.push({ key: flag.key, error: 'unreadable' });
    }
  }
  return out;
}
