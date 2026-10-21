// The area snapshots of the Core State workspace (lib/core/state.mjs),
// read deterministically from what each module already keeps: the router's
// own state (credit, cool-downs, the spend ledger), the autonomy switch,
// missions, lab runs, films, movies and music, the error log, the pending
// approvals and the integrations' telemetry. No AI call; counts and
// statuses only, never a row's content, a client's data or a key.
//
//   collectCoreState({ env, supUrl, supKey, fetchImpl, store }) publishes
//   every area and resolves to the snapshots it published. Called by /state
//   and by the hourly pulse; one area that cannot be read is published as
//   { readable: false } and never stops the others.

import {
  PROVIDERS, ENGINE_LABELS, isPaidProvider, resolveKeys, creditOutKeys, spentToday, dailyBudgetUsd, dailySpendCapUsd, paidSpentToday, utcDay
} from '../aiRouter.mjs';
import { isCooling, coolingUntil } from '../router/quota.mjs';
import { autonomyMode } from '../autonomy.mjs';
import { createCoreState, CORE_AREAS } from './state.mjs';

const KEY_FIELD = { gemini_free: 'geminiFree', gemini_paid: 'geminiPaid', anthropic: 'anthropic', openai: 'openai', openrouter: 'openrouter', gateway: 'gateway', groq: 'groq', mistral: 'mistral', github_models: 'github_models', cloudflare: 'cloudflare', replicate: 'replicate', cartesia: 'cartesia', elevenlabs: 'elevenlabs' };
const isConfigured = (keys, p) => { const v = keys[KEY_FIELD[p]]; return Array.isArray(v) ? v.length > 0 : !!v; };

// The router: per engine, configured, out of credit, cooling (and until).
export function routerSnapshot(env = {}, now = Date.now()) {
  const keys = resolveKeys(env);
  const out = creditOutKeys(now);
  const engines = PROVIDERS.map((p) => {
    const cooling = isCooling(p, '*', now);
    const until = cooling ? coolingUntil(p, '*', now) : null;
    return {
      engine: p, label: ENGINE_LABELS[p] || p, paid: isPaidProvider(p),
      configured: isConfigured(keys, p),
      out_of_credit: out.some((k) => k === p || k.startsWith(`${p}#`)),
      cooling, cooling_until: until ? new Date(until).toISOString() : null
    };
  });
  return { engines };
}

// Spend today per engine against its cap, and the all-paid cap.
export function spendSnapshot(env = {}, { ledger = null, now = Date.now() } = {}) {
  const cap = dailySpendCapUsd(env);
  return {
    day: utcDay(now),
    cap_usd: cap,
    paid_today_usd: paidSpentToday({ ledger, now }),
    engines: PROVIDERS.filter(isPaidProvider).map((p) => {
      const budget = dailyBudgetUsd(env, p);
      return { engine: p, spent_usd: spentToday(p, { ledger, now }), cap_usd: budget === Infinity ? null : budget };
    })
  };
}

// GET a table's rows (a few columns), or null when it cannot be read.
async function rows(ctx, path) {
  if (!ctx.supUrl || !ctx.supKey) return null;
  try {
    const res = await ctx.fetchImpl(`${ctx.supUrl}/rest/v1/${path}`, { headers: { apikey: ctx.supKey, Authorization: `Bearer ${ctx.supKey}` } });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j) ? j : null;
  } catch (e) { return null; }
}
const countBy = (list, f) => list.reduce((m, r) => { const k = String(f(r) || 'unknown'); m[k] = (m[k] || 0) + 1; return m; }, {});
const unreadable = { readable: false };

export async function collectCoreState({ env = process.env, supUrl = null, supKey = null, fetchImpl = globalThis.fetch, ledger = null, store = null, now = Date.now() } = {}) {
  const ctx = { supUrl, supKey, fetchImpl };
  const since = new Date(now - 86400000).toISOString();
  const [auto, actions, missions, lab, films, music, errors, approvals, telemetry, feed] = await Promise.all([
    rows(ctx, 'pg1_autonomous_state?id=eq.global&select=enabled,changed_at,changed_by,max_actions_per_hour,daily_budget_usd'),
    rows(ctx, `pg1_autonomous_actions?created_at=gte.${encodeURIComponent(since)}&select=type,status&limit=500`),
    rows(ctx, 'pg1_missions?select=status,last_run_at&limit=200'),
    rows(ctx, 'pg1_lab_experiments?select=status,kind,created_at&order=created_at.desc&limit=20'),
    rows(ctx, 'pg1_film_projects?select=status,error_reason,director&order=created_at.desc&limit=40'),
    rows(ctx, 'pg1_music_tracks?select=status,error_reason&order=created_at.desc&limit=40'),
    rows(ctx, 'pg1_errors?resolved=eq.false&select=category,count&limit=500'),
    rows(ctx, 'pending_actions?status=eq.pending&select=action_type,expires_at&limit=200'),
    rows(ctx, `agent_telemetry?created_at=gte.${encodeURIComponent(since)}&select=endpoint,status&limit=2000`),
    rows(ctx, `threat_ioc_telemetry?ingested_at=gte.${encodeURIComponent(since)}&select=verification_source&limit=5000`)
  ]);
  const movies = films ? films.filter((p) => p.director && p.director.kind === 'movie') : null;
  const plainFilms = films ? films.filter((p) => !(p.director && p.director.kind === 'movie')) : null;
  const confirmed = films ? films.filter((p) => p.director && p.director.spend_confirmed && /queued|rendering|shooting|running/.test(String(p.status))).length : null;
  const snaps = {
    router: routerSnapshot(env, now),
    spend: { ...spendSnapshot(env, { ledger, now }), confirmed_budgets_active: confirmed },
    autonomy: auto ? { mode: autonomyMode(env), enabled: !!(auto[0] && auto[0].enabled), changed_at: auto[0] ? auto[0].changed_at : null, kill_switch: !!(auto[0] && auto[0].enabled === false && auto[0].changed_by), actions_24h: actions ? countBy(actions, (a) => a.status) : null } : { mode: autonomyMode(env), ...unreadable },
    missions: missions ? { by_status: countBy(missions, (m) => m.status) } : unreadable,
    lab: lab ? { by_status: countBy(lab, (r) => r.status), latest: lab.slice(0, 5).map((r) => ({ status: r.status, kind: r.kind, at: r.created_at })) } : unreadable,
    feed: feed ? { new_24h: feed.length, by_source: countBy(feed, (r) => r.verification_source) } : unreadable,
    media: films || music ? {
      films: plainFilms ? countBy(plainFilms, (p) => p.status) : null,
      movies: movies ? countBy(movies, (p) => p.status) : null,
      movies_paused_budget: movies ? movies.filter((p) => p.status === 'paused_budget' || p.error_reason === 'paused_budget').length : null,
      out_of_credit: films ? films.filter((p) => p.error_reason === 'out_of_credit').length + (music ? music.filter((t) => t.error_reason === 'out_of_credit').length : 0) : null,
      music: music ? countBy(music, (t) => t.status) : null
    } : unreadable,
    self_heal: actions ? { reports_24h: actions.filter((a) => /self_heal|diagnos/.test(String(a.type))).length } : unreadable,
    errors: errors ? { unresolved: errors.length, by_category: countBy(errors, (e) => e.category) } : unreadable,
    approvals: approvals ? { pending: approvals.length, by_type: countBy(approvals, (a) => a.action_type) } : unreadable,
    integrations: telemetry ? (() => {
      const surface = (e) => (/mcp/.test(e) ? 'mcp' : /a2a/.test(e) ? 'a2a' : /ioc|x402|preflight/.test(e) ? 'x402' : 'other');
      const by = {};
      for (const t of telemetry) {
        const s = surface(String(t.endpoint || ''));
        const b = by[s] || (by[s] = { calls: 0, errors: 0 });
        b.calls++;
        if (/error|fail|5\d\d/.test(String(t.status || ''))) b.errors++;
      }
      for (const b of Object.values(by)) b.error_rate = b.calls ? Math.round((b.errors / b.calls) * 1000) / 1000 : 0;
      return { surfaces: by };
    })() : unreadable
  };
  const core = store || createCoreState({ supUrl, supKey, fetchImpl });
  await Promise.all(CORE_AREAS.map((a) => core.publish(a, snaps[a])));
  return snaps;
}
