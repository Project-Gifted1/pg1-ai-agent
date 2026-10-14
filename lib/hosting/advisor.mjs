// hosting_advisor: ranked regions and providers for a workload, with the
// reasons behind each one, from PG1's curated dataset (lib/hosting/dataset.mjs).
//
// The input is structured only (no free text, so nothing to interpret).
// Lawful only: a requirement that names a refused purpose (ignoring abuse
// reports, evading lawful process, bypassing sanctions) or a residency in
// an embargoed destination gets a short neutral refusal with the lawful
// alternative. Every answer says it is not legal advice, cites every fact,
// and flags facts that are unverified or older than 180 days.

import { reason } from '../reasonCodes.mjs';
import { buildCheck, withResponseMeta } from '../responseMeta.mjs';
import { JURISDICTIONS, PROVIDERS, EMBARGOED, RESTRICTED, MACRO_REGIONS, STALE_AFTER_DAYS, rttMs, RTT_SOURCE } from './dataset.mjs';

export const HOSTING_TOOL = 'hosting_advisor';
export const WORKLOAD_TYPES = Object.freeze(['static_site', 'web_api', 'database', 'ml_inference', 'object_storage', 'agent_runtime', 'batch']);
export const RESIDENCY_GROUPS = Object.freeze(['any', 'eu', 'eea', 'eu_adequate']);
export const REQUIREMENTS = Object.freeze(['customer_managed_keys', 'no_us_parent', 'dedicated_hardware', 'multi_provider']);
// Requirement labels PG1 refuses, each with its lawful alternative.
export const REFUSED_REQUIREMENTS = Object.freeze({
  ignore_abuse_reports: { category: 'bulletproof_hosting', reason: 'PG1 does not advise on hosting that ignores abuse reports.', alternative: 'PG1 can recommend providers with clear abuse processes plus DDoS protection and redundancy for lawful content.' },
  evade_lawful_process: { category: 'law_enforcement_evasion', reason: 'PG1 does not advise on avoiding law enforcement or lawful process.', alternative: 'PG1 can explain each jurisdiction\'s published legal framework so you can plan compliant, privacy-protective hosting.' },
  sanctions_bypass: { category: 'sanctions_evasion', reason: 'PG1 does not advise on bypassing sanctions or export controls.', alternative: 'PG1 can recommend compliant regions and providers outside sanctioned destinations.' }
});
export const DISCLAIMER = 'Not legal advice. PG1 compiles public, factual information from the cited official sources; check each source and take legal advice for your situation.';

export const HOSTING_DEF = Object.freeze({
  name: HOSTING_TOOL,
  description: 'PG1 hosting advisor: ranked regions and providers for a workload, with reasons: data-protection regime, published government data-access frameworks (factual, cited), provider acceptable-use fit, sanctions and export-control compliance, estimated latency, a multi-region/multi-provider redundancy and resilience plan, and privacy-by-design guidance. Every fact cites its official source and date; unverified facts and facts older than 180 days are flagged. Structured input only. Not legal advice. Lawful use only: requests to ignore abuse reports, evade lawful process or bypass sanctions are refused. Payment: $0.01 via x402 (params._meta["x402/payment"]) or a Gumroad licence key, after 5 free calls a day per caller shared with every other paid tool.',
  inputSchema: {
    type: 'object',
    properties: {
      workload_type: { type: 'string', enum: WORKLOAD_TYPES.slice() },
      data_residency: { type: 'array', items: { type: 'string', maxLength: 12 }, maxItems: 10, description: 'Where data may live: any, eu, eea, eu_adequate, or ISO country codes (default any).' },
      privacy_priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Default medium.' },
      latency_regions: { type: 'array', items: { type: 'string', enum: MACRO_REGIONS.slice() }, minItems: 1, maxItems: 5, description: 'Where the users or callers are.' },
      uptime_target: { type: 'number', minimum: 90, maximum: 99.999, description: 'Percent, default 99.9.' },
      budget_usd_month: { type: 'number', minimum: 0, description: 'Monthly budget in USD.' },
      requirements: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 8, description: `Any of ${REQUIREMENTS.join(', ')}.` }
    },
    required: ['workload_type', 'latency_regions'],
    additionalProperties: false
  }
});

const EU_CODES = new Set(['DE', 'NL', 'FR', 'IE', 'FI', 'SE']);
const invalid = (m) => Object.assign(new Error(m), { mcpToolError: true, code: 'invalid_input' });

export function normalizeHostingInput(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  if (!WORKLOAD_TYPES.includes(a.workload_type)) throw invalid(`workload_type must be one of ${WORKLOAD_TYPES.join(', ')}`);
  const latency = Array.isArray(a.latency_regions) ? [...new Set(a.latency_regions.map(String))] : [];
  if (!latency.length || latency.length > 5 || latency.some((r) => !MACRO_REGIONS.includes(r))) throw invalid(`latency_regions must list 1 to 5 of ${MACRO_REGIONS.join(', ')}`);
  const residency = (Array.isArray(a.data_residency) && a.data_residency.length ? a.data_residency : ['any']).map((r) => String(r).trim()).map((r) => (/^[a-z_]+$/.test(r) ? r : r.toUpperCase())).slice(0, 10);
  for (const r of residency) if (!RESIDENCY_GROUPS.includes(r) && !/^[A-Z]{2}(?:-\d{2})?$/.test(r)) throw invalid(`data_residency entries are ${RESIDENCY_GROUPS.join(', ')} or ISO country codes`);
  const priority = a.privacy_priority === undefined ? 'medium' : a.privacy_priority;
  if (!['low', 'medium', 'high'].includes(priority)) throw invalid('privacy_priority must be low, medium or high');
  const uptime = a.uptime_target === undefined ? 99.9 : Number(a.uptime_target);
  if (!Number.isFinite(uptime) || uptime < 90 || uptime > 99.999) throw invalid('uptime_target must be between 90 and 99.999');
  const budget = a.budget_usd_month === undefined ? null : Number(a.budget_usd_month);
  if (budget !== null && (!Number.isFinite(budget) || budget < 0)) throw invalid('budget_usd_month must be a positive number');
  const requirements = Array.isArray(a.requirements) ? [...new Set(a.requirements.map((r) => String(r).trim().toLowerCase()))] : [];
  for (const r of requirements) if (!REQUIREMENTS.includes(r) && !REFUSED_REQUIREMENTS[r]) throw invalid(`requirements are any of ${REQUIREMENTS.join(', ')}`);
  return { workload_type: a.workload_type, latency_regions: latency, data_residency: residency, privacy_priority: priority, uptime_target: uptime, budget_usd_month: budget, requirements };
}

// A lawful-use refusal, or null.
export function hostingRefusal(input) {
  for (const r of input.requirements) if (REFUSED_REQUIREMENTS[r]) return { requirement: r, ...REFUSED_REQUIREMENTS[r] };
  const embargoed = input.data_residency.filter((r) => EMBARGOED[r]);
  if (embargoed.length) return { category: 'sanctions_evasion', reason: `PG1 gives no hosting advice for embargoed destinations (${embargoed.join(', ')}).`, alternative: 'PG1 can recommend compliant regions and providers outside sanctioned destinations.', sources: embargoed.map((c) => EMBARGOED[c]) };
  return null;
}

function residencyAllows(j, residency) {
  return residency.some((r) => r === 'any' || (r === 'eu' && EU_CODES.has(j.code)) || (r === 'eea' && j.eea) || (r === 'eu_adequate' && (j.eea || /adequacy decision in force/i.test(j.eu_adequacy.value))) || r === j.code);
}

const budgetTier = (b) => (b === null ? null : b < 50 ? 'low' : b < 500 ? 'medium' : 'high');
const TIER_N = { low: 0, medium: 1, high: 2 };
const WEIGHTS = { high: { privacy: 0.45, latency: 0.25, uptime: 0.15, cost: 0.15 }, medium: { privacy: 0.3, latency: 0.3, uptime: 0.2, cost: 0.2 }, low: { privacy: 0.15, latency: 0.4, uptime: 0.25, cost: 0.2 } };

function privacyScore(j, p, priority) {
  let s = j.eea ? 10 : /adequacy decision in force/i.test(j.eu_adequacy.value) ? 8 : j.code === 'US' ? 4 : 5;
  if (p.us_parent) s -= { high: 4, medium: 2, low: 0 }[priority];
  return Math.max(0, s);
}

export function stalenessOf(fact, now = Date.now()) {
  if (!fact || !fact.checked_on) return { stale: true, unverified: true };
  const age = (now - Date.parse(fact.checked_on)) / 86400000;
  return { stale: !(age <= STALE_AFTER_DAYS), unverified: fact.verified !== true, age_days: Math.floor(age) };
}

const cite = (fact) => ({ fact: fact.value, source_url: fact.source_url, checked_on: fact.checked_on, verified: fact.verified === true });

function candidateView(c, input) {
  const { j, p } = c;
  return {
    rank: c.rank,
    jurisdiction: { code: j.code, name: j.name },
    provider: { id: p.id, name: p.name, headquarters: p.hq },
    score: Math.round(c.score * 10) / 10,
    reasons: {
      data_protection: cite(j.data_protection),
      eu_transfer_status: cite(j.eu_adequacy),
      government_data_access: j.government_access.length ? j.government_access.map(cite) : [{ fact: 'No framework curated in PG1\'s dataset yet; check the jurisdiction\'s official sources.', source_url: null, checked_on: null, verified: false }],
      provider_jurisdiction: p.us_parent ? { fact: 'US-parented provider: the CLOUD Act can require it to disclose data it controls, wherever stored. Customer-managed keys held outside the provider reduce what it can disclose.', source_url: 'https://www.justice.gov/criminal/cloud-act-resources' } : { fact: `${p.hq}-headquartered provider without a US parent in PG1's dataset.`, source_url: p.regions.source_url },
      acceptable_use: { fact: `Check ${p.name}'s acceptable use policy for a ${input.workload_type.replace(/_/g, ' ')} workload before deploying.`, source_url: p.aup.value.url, checked_on: p.aup.checked_on },
      sanctions_and_export_controls: { fact: `${j.name} is not an embargoed destination in PG1's dataset; the provider screens customers under its own export-control obligations.`, source_url: j.sanctions.source_url, checked_on: j.sanctions.checked_on },
      latency: { estimates_ms: Object.fromEntries(input.latency_regions.map((r) => [r, rttMs(j.region, r)])), note: 'Approximate round-trip time, not a guarantee.', source_url: RTT_SOURCE.source_url },
      uptime: p.sla.value ? { fact: `Published compute SLA ${p.sla.value.compute_pct}% (${p.sla.value.scope})${p.sla.value.compute_pct >= input.uptime_target ? '' : `, below your ${input.uptime_target}% target`}.`, source_url: p.sla.source_url, checked_on: p.sla.checked_on } : { fact: `No compute SLA in PG1's dataset; reach ${input.uptime_target}% with redundancy across providers.`, source_url: p.sla.source_url },
      cost_tier: p.cost_tier
    }
  };
}

// Ranks (jurisdiction, provider) pairs. data = { jurisdictions, providers }.
export function rankHosting(input, data = { jurisdictions: JURISDICTIONS, providers: PROVIDERS }) {
  const w = WEIGHTS[input.privacy_priority];
  const tier = budgetTier(input.budget_usd_month);
  const out = [];
  for (const p of data.providers) {
    if (input.requirements.includes('no_us_parent') && p.us_parent) continue;
    for (const code of p.regions.value) {
      const j = data.jurisdictions.find((x) => x.code === code);
      if (!j || RESTRICTED[code] || EMBARGOED[code] || !residencyAllows(j, input.data_residency)) continue;
      const worst = Math.max(...input.latency_regions.map((r) => rttMs(j.region, r) ?? 300));
      const latency = Math.max(0, 10 - worst / 30);
      const uptime = p.sla.value ? (p.sla.value.compute_pct >= input.uptime_target ? 10 : 4) : 5;
      const cost = tier === null ? 7 : Math.max(0, 10 - 5 * Math.max(0, TIER_N[p.cost_tier] - TIER_N[tier]));
      const score = w.privacy * privacyScore(j, p, input.privacy_priority) + w.latency * latency + w.uptime * uptime + w.cost * cost;
      out.push({ j, p, score, worst });
    }
  }
  out.sort((a, b) => b.score - a.score || a.worst - b.worst || a.p.id.localeCompare(b.p.id));
  return out;
}

function redundancyPlan(ranked, input) {
  const primary = ranked[0];
  if (!primary) return null;
  const secondary = ranked.find((c) => c.p.id !== primary.p.id && c.j.code !== primary.j.code) || ranked.find((c) => c.p.id !== primary.p.id) || ranked.find((c) => c.j.code !== primary.j.code) || null;
  return {
    primary: { provider: primary.p.name, jurisdiction: primary.j.name },
    secondary: secondary ? { provider: secondary.p.name, jurisdiction: secondary.j.name } : null,
    steps: [
      'Run the secondary warm (or at least restorable from infrastructure-as-code) with health-checked failover.',
      'Host DNS with two independent providers and keep low TTLs on failover records.',
      'Replicate encrypted backups to the secondary provider; test a restore at least quarterly.',
      'Avoid provider-specific services on the critical path, or keep a documented substitute for each.',
      input.workload_type === 'static_site' ? 'Serve from two CDNs or a CDN with origins at both providers.' : 'Put a load balancer or anycast front end able to reach both providers.'
    ],
    resilience: 'Spreading across providers and rule-of-law jurisdictions protects lawful services against outages, single-provider decisions and unlawful blocking. It is not a way around lawful orders, which PG1 does not advise on.'
  };
}

function privacyGuidance(input) {
  return [
    'Encrypt data at rest and in transit (TLS 1.3); prefer customer-managed keys in a key management system or HSM.',
    input.requirements.includes('customer_managed_keys') || input.privacy_priority === 'high' ? 'Hold the keys outside the hosting provider where possible (external key manager), so the provider cannot decrypt on its own.' : 'Rotate keys on a schedule and on staff changes; restrict key access to named roles.',
    'Collect only the personal data the service needs; pseudonymise identifiers and set a retention limit for every table and log.',
    'Sign the provider\'s data processing agreement; for transfers outside the EEA without adequacy, use standard contractual clauses with a transfer impact assessment.',
    'Log access to personal data and review it; keep audit logs in a separate account.'
  ];
}

export function hostingAdvice(rawInput, { data, now = Date.now(), dataSource = 'bundled' } = {}) {
  const input = normalizeHostingInput(rawInput);
  const refusal = hostingRefusal(input);
  if (refusal) {
    return withResponseMeta({ refused: true, refusal, disclaimer: DISCLAIMER }, { reasons: [reason('HOSTING_REQUEST_REFUSED', refusal.reason)], checks: [buildCheck('lawful use', 'ok')] });
  }
  const ranked = rankHosting(input, data).map((c, i) => ({ ...c, rank: i + 1 }));
  const top = ranked.slice(0, 5);
  const used = [];
  for (const c of top) used.push(c.j.data_protection, c.j.eu_adequacy, c.j.sanctions, ...c.j.government_access, c.p.regions, c.p.sla, c.p.aup);
  const stale = used.filter((fct) => stalenessOf(fct, now).stale);
  const unverified = used.filter((fct) => stalenessOf(fct, now).unverified);
  const restricted = input.data_residency.filter((r) => RESTRICTED[r]);
  const reasons = [];
  if (stale.length) reasons.push(reason('HOSTING_FACTS_STALE', `${stale.length} of the facts behind this answer were last checked more than ${STALE_AFTER_DAYS} days ago.`));
  if (unverified.length) reasons.push(reason('HOSTING_FACTS_UNVERIFIED', `${unverified.length} of the facts behind this answer are not yet verified against their source.`));
  return withResponseMeta({
    refused: false,
    input,
    recommendations: top.map((c) => candidateView(c, input)),
    ...(top.length ? {} : { note: restricted.length ? `No recommendation: ${restricted.join(', ')} ${restricted.length === 1 ? 'is' : 'are'} under EU sectoral sanctions, and PG1 does not rank them for an EU operator.` : 'No provider in PG1\'s dataset matches this residency and these requirements.' }),
    redundancy_plan: redundancyPlan(top, input),
    privacy_by_design: privacyGuidance(input),
    data_quality: { stale_facts: stale.length, unverified_facts: unverified.length, stale_after_days: STALE_AFTER_DAYS, dataset: dataSource },
    disclaimer: DISCLAIMER
  }, { reasons, checks: [buildCheck('PG1 hosting dataset', 'ok')] });
}
