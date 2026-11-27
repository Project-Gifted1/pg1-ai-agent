// The opportunity pipeline: once a week PG1 looks at how agents use it,
// researches the market in the lab, and writes 1-3 proposals for new
// tools. It never launches, prices or publishes anything on its own.
//
//   1. /api/opportunities/weekly (cron, or /opportunities scan) reads the
//      last 7 days of /usage as aggregates only (opportunitySignals): tool
//      names agents asked for that PG1 does not have, payment requests that
//      never settled, the top tools, errors by tool, A2A and Foundry demand.
//      No caller, address or hash leaves this file.
//   2. It starts a lab research experiment (lib/lab, budgets and the kill
//      switch apply) with those signals. The runner (lib/lab/runner.mjs
//      opportunityScan) writes 1-3 proposals: problem, target agents, data
//      sources with licence status, build cost, run cost per call, price,
//      risks.
//   3. /lab status reads the result back; the proposals land in
//      pg1_opportunities with status proposed. /opportunities lists them.
//   4. /opportunities approve <id> only starts a lab PROTOTYPE (a code
//      experiment); it comes back through the P4 gate (CI, safety, licence
//      with cited resale terms, price >= 1.5x worst-case cost) to the
//      operator's approval card. Launching, pricing and publishing stay the
//      operator's.
//   5. ACTING WITHOUT WAITING (actOnOpportunities, hourly with the lab
//      monitor and with the weekly scan): every proposal is scored
//      (scoreProposal: 0 unless the licences and the 1.5x margin are
//      cleared; then margin, demand PG1 can verify in its own usage signals,
//      build cost). The best one at or above AUTO_MIN_SCORE, with verified
//      demand, is prototyped in the lab on PG1's own authority
//      (opportunity:prototype, tier FREE, lab scope), one at a time. A failed
//      prototype is marked prototype_failed and retried once with the reason;
//      a passed one is marked ready and waits on the operator's card.
//      Launching, pricing and publishing still never happen on their own.

import { priceCoversCost, minimumPrice } from './pricing.mjs';
import { startLabExperiment } from './lab/chat.mjs';
import { authorize, autonomyMode, logAutonomy } from './autonomy.mjs';
import { specVerdict } from './lab/specCheck.mjs';
import { createLabStore } from './lab/store.mjs';

export const OPPORTUNITY_TABLE = 'pg1_opportunities';
export const LICENCE_STATUSES = Object.freeze(['own_data', 'public_domain', 'resale_permitted', 'unverified', 'not_permitted']);
export const MAX_PROPOSALS = 3;
export const OPPORTUNITY_STATUSES = Object.freeze(['proposed', 'prototyping', 'prototype_failed', 'ready', 'dismissed']);
// The lowest score PG1 prototypes on its own, and how often it tries.
export const AUTO_MIN_SCORE = 55;
export const MAX_AUTO_ATTEMPTS = 2;
// Lab statuses that end a prototype without passing the gate.
const LAB_FAILED = new Set(['failed', 'over_budget', 'timeout', 'stopped']);

const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 1e6 ? Math.round(n * 1e6) / 1e6 : null; };

// The usage report reduced to what the scan needs: counts and tool names
// only. Unrecognised tool names are caller-supplied text (already reduced
// before storage); they are passed as data and marked untrusted.
export function opportunitySignals(stats = {}) {
  const errors = stats.errors || {};
  const traffic = stats.traffic || {};
  const pay = stats.payments || {};
  const routes = Array.isArray(traffic.by_route) ? traffic.by_route : [];
  const a2a = routes.find((r) => r && r.route === '/api/a2a');
  const tools = Array.isArray(stats.tools) ? stats.tools : [];
  return {
    period: stats.period || '7d',
    requested_unknown_tools: (Array.isArray(errors.unrecognised_tools) ? errors.unrecognised_tools : []).slice(0, 10).map((t) => ({ name: str(t.name, 64), count: Number(t.count) || 0 })),
    unknown_tool_calls: Number(errors.unknown_tool_calls) || 0,
    payment_requests: Number(pay.payment_requests) || 0,
    payments_settled: Number(pay.payments_settled) || 0,
    payment_requests_without_settlement: Math.max(0, (Number(pay.payment_requests) || 0) - (Number(pay.payments_settled) || 0)),
    free_limit_hits: Number(pay.callers_hit_free_limit) || 0,
    top_tools: tools.slice(0, 5).map((t) => ({ tool: str(t.tool, 64), calls: Number(t.calls) || 0, pricing: t.pricing || null })),
    errors_by_tool: (Array.isArray(errors.by_tool) ? errors.by_tool : []).slice(0, 5).map((t) => ({ tool: str(t.tool, 64), errors: Number(t.errors) || 0 })),
    // Errors PG1 returns to callers, each with the spec's verdict: one that is
    // the correct answer is not a gap to fill (lib/lab/specCheck.mjs).
    errors_returned: (Array.isArray(errors.breakdown) ? errors.breakdown : []).filter((c) => c && (c.fault === 'caller')).slice(0, 8).map((c) => { const m = /^\(.+\)$/.test(String(c.tool || '')) ? String(c.tool).slice(1, -1) : null; const v = specVerdict({ type: c.type, method: m, endpoint: c.route || '/api/mcp' }); return { tool: str(c.tool, 64), type: str(c.type, 40), real: Number(c.real) || 0, verdict: v.correct === true ? 'correct behaviour, no change' : v.correct === false ? `adopt: ${v.adopt.method} (${v.adopt.spec})` : 'look into it', source: v.source || (v.adopt && v.adopt.source) || null }; }),
    a2a_requests: a2a ? Number(a2a.requests) || 0 : 0,
    foundry_requests: tools.filter((t) => t && t.tool === 'build_tool').reduce((n, t) => n + (Number(t.calls) || 0), 0)
  };
}

// One proposal from the lab, checked and normalised; null when unusable.
export function normaliseProposal(p) {
  if (!p || typeof p !== 'object') return null;
  const title = str(p.title, 120);
  const problem = str(p.problem, 1000);
  if (!title || !problem) return null;
  const sources = (Array.isArray(p.data_sources) ? p.data_sources : []).slice(0, 8).map((d) => ({
    name: str(d && d.name, 120),
    url: /^https:\/\//i.test(String(d && d.url || '')) ? str(d.url, 300) : null,
    licence_status: LICENCE_STATUSES.includes(d && d.licence_status) ? d.licence_status : 'unverified',
    resale_terms_url: /^https:\/\//i.test(String(d && d.resale_terms_url || '')) ? str(d.resale_terms_url, 300) : null
  })).filter((d) => d.name);
  const run = money(p.run_cost_per_call_usd);
  let price = money(p.price_usd);
  const margin = run != null && price != null ? priceCoversCost(price, run) : false;
  return {
    title,
    problem,
    target_agents: str(p.target_agents, 500),
    data_sources: sources,
    build_cost_usd: money(p.build_cost_usd),
    run_cost_per_call_usd: run,
    price_usd: price,
    // The lowest price the 1.5x rule allows, for the operator to compare.
    min_price_usd: run != null ? minimumPrice(run) : null,
    margin_ok: margin,
    licence_ok: sources.length > 0 && sources.every((d) => ['own_data', 'public_domain'].includes(d.licence_status) || (d.licence_status === 'resale_permitted' && !!d.resale_terms_url)),
    risks: str(p.risks, 1000),
    // What the scan says backs the demand: { signal, detail } pairs, checked
    // against the real signals by verifyEvidence before they count.
    evidence: (Array.isArray(p.evidence) ? p.evidence : []).slice(0, 6).map((e) => ({ signal: str(e && e.signal, 48), detail: str(e && e.detail, 120) })).filter((e) => e.signal)
  };
}

const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Each evidence item checked against the week's signals (aggregates PG1
// computed itself). Only a signal that is really there, with a count above
// zero, counts; the model's word alone never does. Returns the items with
// verified and points, and demand (0-40).
export function verifyEvidence(evidence = [], signals = {}) {
  const s = signals || {};
  const items = (Array.isArray(evidence) ? evidence : []).map((e) => {
    const d = norm(e.detail);
    let points = 0;
    let found = null;
    switch (e.signal) {
      case 'requested_unknown_tools': {
        const t = (s.requested_unknown_tools || []).find((x) => norm(x.name) === d && x.count > 0);
        if (t) { points = Math.min(20, 5 + t.count); found = `${t.name} asked for ${t.count} times`; }
        break;
      }
      case 'errors_returned': {
        const t = (s.errors_returned || []).find((x) => norm(x.tool) === d && /^adopt:/.test(x.verdict || ''));
        if (t) { points = 15; found = `${t.tool}: ${t.verdict}`; }
        break;
      }
      case 'top_tools': {
        const t = (s.top_tools || []).find((x) => norm(x.tool) === d && x.calls > 0);
        if (t) { points = 5; found = `${t.tool}: ${t.calls} calls`; }
        break;
      }
      case 'payment_requests_without_settlement':
      case 'free_limit_hits':
      case 'a2a_requests':
      case 'foundry_requests': {
        const n = Number(s[e.signal]) || 0;
        if (n > 0) { points = e.signal === 'a2a_requests' || e.signal === 'foundry_requests' ? 5 : 10; found = `${e.signal}: ${n}`; }
        break;
      }
      default: break;
    }
    return { signal: e.signal, detail: e.detail, verified: points > 0, points, found };
  });
  // One signal counts once, however often it is cited.
  const seen = new Set();
  let demand = 0;
  for (const i of items) {
    const k = `${i.signal}:${norm(i.detail)}`;
    if (!i.verified || seen.has(k)) continue;
    seen.add(k);
    demand += i.points;
  }
  return { items, demand: Math.min(40, demand) };
}

// 0-100. Zero unless the licences and the 1.5x margin are cleared and the
// price is above zero: PG1 never acts on an unprofitable or unlicensed idea.
// Then: margin (up to 40), verified demand (up to 40), build cost (up to 20).
export function scoreProposal(n, signals = {}) {
  const { items, demand } = verifyEvidence(n && n.evidence, signals);
  const price = Number(n && n.price_usd);
  const run = Number(n && n.run_cost_per_call_usd);
  if (!n || !n.licence_ok || !n.margin_ok || !(price > 0) || !(run >= 0)) return { score: 0, demand, evidence: items };
  const margin = 40 * Math.max(0, Math.min(1, (price - run) / price));
  const b = n.build_cost_usd;
  const build = b == null ? 5 : b <= 100 ? 20 : b <= 300 ? 15 : b <= 600 ? 10 : 0;
  return { score: Math.round((margin + demand + build) * 10) / 10, demand, evidence: items };
}

// May PG1 prototype this one on its own? Cleared, scored high enough, with
// demand it verified itself.
export function autoEligible(o) {
  if (!o || Number(o.score) < AUTO_MIN_SCORE) return false;
  if (!(Array.isArray(o.evidence) && o.evidence.some((e) => e && e.verified))) return false;
  if (!o.licence_ok || !o.margin_ok) return false;
  if (o.status === 'proposed') return true;
  return o.status === 'prototype_failed' && o.auto_started === true && (Number(o.attempts) || 0) < MAX_AUTO_ATTEMPTS;
}

function headers(supKey, extra = {}) {
  return { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra };
}

export function createOpportunityStore({ supUrl, supKey, fetchImpl = globalThis.fetch }) {
  if (!supUrl || !supKey) throw new Error('Opportunities need the vault (Supabase), which is not configured on this deployment.');
  const rest = async (path, options = {}) => {
    const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { ...options, headers: headers(supKey, options.headers), cache: 'no-store' });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`opportunities storage ${res.status}`), { status: res.status });
    return text ? JSON.parse(text) : null;
  };
  const one = (r) => (Array.isArray(r) ? r[0] || null : r);
  return {
    async add(experimentId, proposal) {
      return one(await rest(`${OPPORTUNITY_TABLE}?select=*`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ experiment_id: experimentId, status: 'proposed', ...proposal }) }));
    },
    async list(limit = 20) {
      const rows = await rest(`${OPPORTUNITY_TABLE}?select=*&order=created_at.desc&limit=${limit}`);
      return Array.isArray(rows) ? rows : [];
    },
    async byStatus(status, limit = 50) {
      const rows = await rest(`${OPPORTUNITY_TABLE}?select=*&status=eq.${encodeURIComponent(status)}&order=created_at.desc&limit=${limit}`);
      return Array.isArray(rows) ? rows : [];
    },
    async get(id) {
      const s = String(id || '').toLowerCase();
      if (/^[0-9a-f-]{36}$/.test(s)) return one(await rest(`${OPPORTUNITY_TABLE}?select=*&id=eq.${s}`));
      if (!/^[0-9a-f]{8}$/.test(s)) return null;
      const hit = (await this.list(100)).filter((r) => r.id.startsWith(s));
      return hit.length === 1 ? hit[0] : null;
    },
    async update(id, patch) {
      return one(await rest(`${OPPORTUNITY_TABLE}?id=eq.${id}&select=*`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) }));
    }
  };
}

// Stores the proposals of a finished scan (called from /lab status).
// signals: the week's aggregates the scan was given (the runner returns
// them with the result), so the demand can be checked and scored.
export async function storeProposals({ supUrl, supKey, fetchImpl, experimentId, proposals, signals = null }) {
  const store = createOpportunityStore({ supUrl, supKey, fetchImpl });
  const out = [];
  for (const p of (Array.isArray(proposals) ? proposals : []).slice(0, MAX_PROPOSALS)) {
    const n = normaliseProposal(p);
    if (!n) continue;
    const { score, evidence } = scoreProposal(n, signals || {});
    const row = { ...n, score, evidence };
    try {
      out.push(await store.add(experimentId, row));
    } catch (e) {
      // Before the autonomy migration the new columns are missing: store the
      // proposal as before rather than lose it.
      const { score: _s, evidence: _e, ...old } = row;
      out.push(await store.add(experimentId, old));
    }
  }
  return out;
}

function prototypeNotes(o) {
  const retry = o.last_error ? ` The last prototype failed: ${String(o.last_error).slice(0, 240)}. Make a smaller, working change this time: one new tool module with its tests.` : '';
  return `Build only a prototype behind a feature flag; do not launch, price or publish. Use only these data sources: ${(o.data_sources || []).map((d) => `${d.name} (${d.licence_status})`).join('; ') || 'PG1\'s own data'}. Target run cost per call: ${o.run_cost_per_call_usd ?? '?'} USD.${retry}`;
}

// Starts the lab prototype of one opportunity (operator's approve, or PG1
// on its own). The gate and the operator's card still stand between it and
// anything live.
async function startPrototype({ o, store, env, supUrl, supKey, fetchImpl, now, auto = false }) {
  const goal = `Prototype: ${o.title}. ${o.problem}`.slice(0, 900);
  const started = await startLabExperiment({ env, supUrl, supKey, fetchImpl, kind: 'code', goal, input: { notes: prototypeNotes(o), opportunity_id: o.id }, action: 'opportunity:prototype', now });
  if (started.ok) {
    const patch = { status: 'prototyping', prototype_experiment_id: started.id };
    try {
      await store.update(o.id, { ...patch, attempts: (Number(o.attempts) || 0) + 1, last_error: null, ...(auto ? { auto_started: true } : {}) });
    } catch (e) {
      await store.update(o.id, patch); // before the autonomy migration
    }
  }
  return started;
}

// Closes prototypes whose lab experiment ended: failed -> prototype_failed
// (with the reason), done (the gate passed, the card is waiting) -> ready.
// Without this a failed prototype stayed "prototyping" for good.
// Returns [{ id, status }]. Never throws.
export async function reconcilePrototypes({ supUrl, supKey, fetchImpl = globalThis.fetch }) {
  const out = [];
  try {
    const store = createOpportunityStore({ supUrl, supKey, fetchImpl });
    const lab = createLabStore({ supUrl, supKey, fetchImpl });
    for (const o of await store.byStatus('prototyping')) {
      if (!o.prototype_experiment_id) continue;
      const e = await lab.get(o.prototype_experiment_id).catch(() => null);
      if (!e) continue;
      let patch = null;
      if (e.status === 'done') patch = { status: 'ready', last_error: null };
      else if (LAB_FAILED.has(e.status)) patch = { status: 'prototype_failed', last_error: String(e.error || e.status).slice(0, 300) };
      if (!patch) continue;
      try {
        await store.update(o.id, patch);
      } catch (err) {
        // Before the autonomy migration: the old status check allows only
        // proposed/prototyping/dismissed. A failed one goes back to proposed
        // so it can be approved again.
        if (patch.status === 'prototype_failed') await store.update(o.id, { status: 'proposed' }).catch(() => {});
        else continue;
      }
      out.push({ id: o.id, status: patch.status });
    }
  } catch (e) {
    console.error(`[opportunities] reconcile_failed ${String(e && e.message || e).slice(0, 160)}`);
  }
  return out;
}

// PG1 acting on its own: closes finished prototypes, then, when no
// prototype is running, starts the best eligible one (autoEligible). Needs
// opportunity:prototype to be allowed (PG1_AUTONOMY lab or on; off stops
// it) and the lab's budgets; every decision is in the autonomy log.
// Resolves to { reconciled, started: { id, experiment } | null, reason }.
// Never throws.
export async function actOnOpportunities({ env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const reconciled = await reconcilePrototypes({ supUrl, supKey, fetchImpl });
  try {
    const allowed = authorize('opportunity:prototype', { actor: 'pg1', mode: autonomyMode(env) });
    if (!allowed.allowed) return { reconciled, started: null, reason: allowed.reason };
    const store = createOpportunityStore({ supUrl, supKey, fetchImpl });
    if ((await store.byStatus('prototyping', 1)).length) return { reconciled, started: null, reason: 'a prototype is already running' };
    const pool = [...await store.byStatus('proposed'), ...await store.byStatus('prototype_failed')].filter(autoEligible);
    pool.sort((a, b) => Number(b.score) - Number(a.score) || (Number(a.attempts) || 0) - (Number(b.attempts) || 0));
    const best = pool[0];
    if (!best) return { reconciled, started: null, reason: 'no proposal is cleared and scored high enough' };
    const started = await startPrototype({ o: best, store, env, supUrl, supKey, fetchImpl, now, auto: true });
    await logAutonomy({ supUrl, supKey, fetchImpl }, { action: 'opportunity:auto_prototype', actor: 'pg1', decision: started.ok ? 'allowed' : 'denied', mode: autonomyMode(env), outcome: started.ok ? 'queued' : 'not started', detail: `opportunity ${best.id.slice(0, 8)} score ${best.score}${started.ok ? `, experiment ${String(started.id).slice(0, 8)}` : `: ${String(started.reply || '').slice(0, 120)}`}` });
    return { reconciled, started: started.ok ? { id: best.id, experiment: started.id } : null, reason: started.ok ? null : started.reply };
  } catch (e) {
    console.error(`[opportunities] act_failed ${String(e && e.message || e).slice(0, 160)}`);
    return { reconciled, started: null, reason: 'failed' };
  }
}

export const SCAN_GOAL = 'Weekly opportunity scan: from this week\'s usage signals and the market, propose 1-3 new tools agents would pay for';

// The weekly scan: reads the 7-day aggregates and starts the lab research.
export async function runOpportunityScan({ env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, getStats, now = Date.now() }) {
  const allowed = authorize('opportunity:research', { actor: 'pg1', mode: autonomyMode(env) });
  if (!allowed.allowed) {
    await logAutonomy({ supUrl, supKey, fetchImpl }, { action: 'opportunity:research', decision: allowed.decision, mode: autonomyMode(env), detail: allowed.reason });
    return { ok: false, reply: `Not started: ${allowed.reason}.` };
  }
  let stats;
  try {
    stats = await getStats({ period: '7d' });
  } catch (e) {
    return { ok: false, reply: 'The usage figures could not be read, so no scan was started.' };
  }
  const signals = opportunitySignals(stats);
  return startLabExperiment({ env, supUrl, supKey, fetchImpl, kind: 'research', goal: SCAN_GOAL, input: { task: 'opportunities', signals }, action: 'opportunity:research', now });
}

function showProposal(o) {
  const src = (o.data_sources || []).map((d) => `  - ${d.name}${d.url ? ` (${d.url})` : ''}: ${d.licence_status}${d.resale_terms_url ? `, terms ${d.resale_terms_url}` : ''}`);
  const $ = (n) => (n == null ? '?' : `$${Number(n).toFixed(n < 1 ? 4 : 2)}`);
  return [
    `### [ OPPORTUNITY ${o.id.slice(0, 8)} · ${o.status} ]`,
    `**${o.title}**`,
    `- **Problem**: ${o.problem}`,
    `- **Target agents**: ${o.target_agents || '?'}`,
    '- **Data sources**:', ...(src.length ? src : ['  - none named']),
    `- **Build cost**: ${$(o.build_cost_usd)} · **run cost per call**: ${$(o.run_cost_per_call_usd)} · **proposed price**: ${$(o.price_usd)} (the 1.5x rule needs at least ${$(o.min_price_usd)}; ${o.margin_ok ? 'met' : 'NOT met'})`,
    `- **Licences**: ${o.licence_ok ? 'every source is ours, public domain or resale-permitted with cited terms' : 'not cleared: a source lacks cited resale terms'}`,
    `- **Risks**: ${o.risks || '?'}`,
    o.score != null ? `- **Score**: ${Number(o.score)} of 100 (PG1 prototypes on its own from ${AUTO_MIN_SCORE}, with demand it verified)` : null,
    ...(Array.isArray(o.evidence) && o.evidence.length ? ['- **Demand evidence**:', ...o.evidence.map((e) => `  - ${e.verified ? '✓' : '✗ not in the usage signals:'} ${e.signal}${e.detail ? ` ${e.detail}` : ''}${e.found ? ` (${e.found})` : ''}`)] : []),
    o.last_error ? `- **Last prototype failed**: ${o.last_error} (tries: ${o.attempts || 0})` : null,
    '',
    o.status === 'proposed' || o.status === 'prototype_failed' ? `/opportunities approve ${o.id.slice(0, 8)} to prototype it in the lab (it comes back through the gate), or /opportunities dismiss ${o.id.slice(0, 8)}.` : ''
  ].filter((x) => x != null).join('\n');
}

export function isOpportunitiesCommand(text) {
  return /^\/opportunit(?:y|ies)(?:\s|$)/i.test(String(text || '').trim());
}

// /opportunities [list|scan|show <id>|approve <id>|dismiss <id>]. Never throws.
export async function handleOpportunitiesCommand({ text, env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, isOperator = false, getStats, now = Date.now() }) {
  if (isOperator !== true) return { reply: 'Opportunities are for the signed-in operator only.' };
  const m = /^\/opportunit(?:y|ies)\s*(\S*)\s*(\S*)/i.exec(String(text || '').trim());
  const sub = (m[1] || 'list').toLowerCase();
  const id = (m[2] || '').toLowerCase();
  try {
    const store = createOpportunityStore({ supUrl, supKey, fetchImpl });
    if (sub === 'list') {
      await reconcilePrototypes({ supUrl, supKey, fetchImpl });
      const rows = await store.list(20);
      if (!rows.length) return { reply: 'No opportunities yet. The weekly scan writes them; /opportunities scan runs one now.' };
      return { reply: ['### [ OPPORTUNITIES ]', ...rows.map((o) => `- ${o.id.slice(0, 8)} · ${o.status} · **${o.title}** · price ${o.price_usd == null ? "?" : `$${Number(o.price_usd)}`} (${o.margin_ok ? 'margin ok' : 'margin NOT ok'}, ${o.licence_ok ? 'licences ok' : 'licences not cleared'})${o.score != null ? ` · score ${Number(o.score)}` : ''}${o.auto_started ? ' · started by PG1' : ''}`), '', '/opportunities show <id>'].join('\n') };
    }
    if (sub === 'scan') return { reply: (await runOpportunityScan({ env, supUrl, supKey, fetchImpl, getStats, now })).reply };
    const o = id ? await store.get(id) : null;
    if (!o) return { reply: `There is no opportunity ${id || '(no id)'}. /opportunities lists them.` };
    if (sub === 'show') return { reply: showProposal(o) };
    if (sub === 'dismiss') {
      await store.update(o.id, { status: 'dismissed' });
      return { reply: `Dismissed ${o.id.slice(0, 8)}.` };
    }
    if (sub === 'approve') {
      if (o.status !== 'proposed' && o.status !== 'prototype_failed') return { reply: `${o.id.slice(0, 8)} is ${o.status}; only a proposed one (or one whose prototype failed) can be prototyped.` };
      const started = await startPrototype({ o, store, env, supUrl, supKey, fetchImpl, now });
      return { reply: started.ok ? `Prototyping ${o.id.slice(0, 8)} in the lab. ${started.reply} It reaches your approval card only after the gate (CI, safety, licence with cited resale terms, price at least 1.5x worst-case cost). PG1 will not launch, price or publish it.` : started.reply };
    }
    return { reply: 'Use /opportunities, /opportunities scan, show <id>, approve <id> or dismiss <id>.' };
  } catch (e) {
    return { reply: e.message && /not configured/.test(e.message) ? e.message : 'Opportunities could not be reached right now.' };
  }
}
