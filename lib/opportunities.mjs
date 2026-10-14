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

import { priceCoversCost, minimumPrice } from './pricing.mjs';
import { startLabExperiment } from './lab/chat.mjs';
import { authorize, autonomyMode, logAutonomy } from './autonomy.mjs';

export const OPPORTUNITY_TABLE = 'pg1_opportunities';
export const LICENCE_STATUSES = Object.freeze(['own_data', 'public_domain', 'resale_permitted', 'unverified', 'not_permitted']);
export const MAX_PROPOSALS = 3;

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
    risks: str(p.risks, 1000)
  };
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
export async function storeProposals({ supUrl, supKey, fetchImpl, experimentId, proposals }) {
  const store = createOpportunityStore({ supUrl, supKey, fetchImpl });
  const out = [];
  for (const p of (Array.isArray(proposals) ? proposals : []).slice(0, MAX_PROPOSALS)) {
    const n = normaliseProposal(p);
    if (n) out.push(await store.add(experimentId, n));
  }
  return out;
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
    '',
    o.status === 'proposed' ? `/opportunities approve ${o.id.slice(0, 8)} to prototype it in the lab (it comes back through the gate), or /opportunities dismiss ${o.id.slice(0, 8)}.` : ''
  ].join('\n');
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
      const rows = await store.list(20);
      if (!rows.length) return { reply: 'No opportunities yet. The weekly scan writes them; /opportunities scan runs one now.' };
      return { reply: ['### [ OPPORTUNITIES ]', ...rows.map((o) => `- ${o.id.slice(0, 8)} · ${o.status} · **${o.title}** · price ${o.price_usd == null ? "?" : `$${Number(o.price_usd)}`} (${o.margin_ok ? 'margin ok' : 'margin NOT ok'}, ${o.licence_ok ? 'licences ok' : 'licences not cleared'})`), '', '/opportunities show <id>'].join('\n') };
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
      if (o.status !== 'proposed') return { reply: `${o.id.slice(0, 8)} is ${o.status}; only a proposed one can be prototyped.` };
      const goal = `Prototype: ${o.title}. ${o.problem}`.slice(0, 900);
      const notes = `Build only a prototype behind a feature flag; do not launch, price or publish. Use only these data sources: ${(o.data_sources || []).map((d) => `${d.name} (${d.licence_status})`).join('; ') || 'PG1\'s own data'}. Target run cost per call: ${o.run_cost_per_call_usd ?? '?'} USD.`;
      const started = await startLabExperiment({ env, supUrl, supKey, fetchImpl, kind: 'code', goal, input: { notes, opportunity_id: o.id }, action: 'opportunity:prototype', now });
      if (started.ok) await store.update(o.id, { status: 'prototyping', prototype_experiment_id: started.id });
      return { reply: started.ok ? `Prototyping ${o.id.slice(0, 8)} in the lab. ${started.reply} It reaches your approval card only after the gate (CI, safety, licence with cited resale terms, price at least 1.5x worst-case cost). PG1 will not launch, price or publish it.` : started.reply };
    }
    return { reply: 'Use /opportunities, /opportunities scan, show <id>, approve <id> or dismiss <id>.' };
  } catch (e) {
    return { reply: e.message && /not configured/.test(e.message) ? e.message : 'Opportunities could not be reached right now.' };
  }
}
