// Tool Foundry catalogue: what a commissioned tool may be about, what it
// may be built from, and what it costs.
//
// Deny by default. A build request names its use case and subject types
// from the fixed labels below and its data sources from the allowlist; any
// other value is never quoted automatically.

import { minimumPrice, assertPricing } from '../pricing.mjs';

// The use cases a commissioned tool may serve (a structured field of the
// spec, and the labels the purpose classifier chooses from).
export const USE_CASES = Object.freeze({
  threat_screening: 'screening wallets, domains, hostnames or IPs before an agent acts',
  vulnerability_intel: 'CVE lookups and exposure reports for software an agent runs',
  supply_chain: 'checking packages before they are installed',
  payment_safety: 'checking payment endpoints and receiving wallets before paying',
  agent_trust: 'checking another agent before trusting it',
  compliance_screening: 'screening counterparties against public sanctions lists'
});

// The refusal labels: the global harmful list plus the two licensing
// rules. Each has a short neutral reason and the lawful alternative.
export const REFUSAL_CATEGORIES = Object.freeze({
  malware_intrusion: { reason: 'PG1 does not build tools for malware or unauthorised access.', alternative: 'PG1 can build defensive checks, for example screening packages, hosts or CVEs before use.' },
  credential_theft: { reason: 'PG1 does not build tools that obtain other people\'s credentials or keys.', alternative: 'PG1 can build checks that flag phishing hosts or look-alike domains.' },
  surveillance_individuals: { reason: 'PG1 does not build tools that track, profile or identify individuals.', alternative: 'PG1 can build checks on infrastructure (wallets, domains, packages), not on people.' },
  fraud_spam: { reason: 'PG1 does not build tools for fraud, spam or deception.', alternative: 'PG1 can build checks that help detect fraud before an agent pays or trusts.' },
  law_enforcement_evasion: { reason: 'PG1 does not build tools to evade law enforcement or lawful process.', alternative: 'PG1 can build compliance checks that support lawful operation.' },
  sanctions_evasion: { reason: 'PG1 does not build tools to evade sanctions, AML or export controls.', alternative: 'PG1 can build sanctions screening against the public lists.' },
  scraping_terms_breach: { reason: 'PG1 does not build tools that collect data against a site\'s terms or past a paywall.', alternative: 'Use a source whose terms permit commercial reuse, or PG1\'s own checks.' },
  unlicensed_source: { reason: 'PG1 sells only outputs from its own data, public-domain data or sources whose terms permit resale.', alternative: 'Choose from PG1\'s primitives or the allowlisted sources (see allowed_sources in this reply).' }
});

// Who or what a tool's inputs are about. A tool about people is never built
// (surveillance_individuals); anything not listed goes to review.
export const SUBJECT_TYPES = Object.freeze(['wallet', 'domain', 'hostname', 'url', 'ip', 'package', 'cve', 'software_product', 'agent', 'x402_endpoint']);
export const REFUSED_SUBJECT_TYPES = Object.freeze({ person: 'surveillance_individuals', individual: 'surveillance_individuals', user_account: 'surveillance_individuals' });

// PG1's primitives: the only building blocks a commissioned tool runs.
// costUsd: worst-case upstream cost per call; p95Ms: typical p95; params:
// the argument names the primitive takes.
export const PRIMITIVES = Object.freeze({
  check_wallet_sanctions: { costUsd: 0.0002, p95Ms: 800, params: ['address'] },
  check_wallet_age: { costUsd: 0.001, p95Ms: 3000, params: ['address', 'chain'] },
  check_domain_age: { costUsd: 0.0005, p95Ms: 2500, params: ['domain'] },
  check_hostname_reputation: { costUsd: 0.0002, p95Ms: 1500, params: ['hostname'] },
  check_package: { costUsd: 0.001, p95Ms: 3000, params: ['ecosystem', 'name', 'version'] },
  check_x402_endpoint: { costUsd: 0.002, p95Ms: 6000, params: ['url'] },
  check_agent_card: { costUsd: 0.002, p95Ms: 6000, params: ['url', 'domain'] },
  get_cve_details: { costUsd: 0.001, p95Ms: 3000, params: ['cve_id'] },
  get_cve_by_product: { costUsd: 0.001, p95Ms: 4000, params: ['vendor', 'product', 'version'] },
  get_ioc_context: { costUsd: 0.0005, p95Ms: 1500, params: ['indicator'] }
});

// Public APIs whose terms permit commercial use, beyond PG1's primitives.
// Empty until the operator adds one: adding a source is the APPROVAL-tier
// action data_source:add, and each entry must cite its terms:
//   { id, name, base_url, terms_url, licence, commercial_use: true, checked_on }
export const PUBLIC_API_ALLOWLIST = Object.freeze([]);

export function allowedSourceIds() {
  return [...Object.keys(PRIMITIVES), ...PUBLIC_API_ALLOWLIST.map((a) => a.id)];
}

// Pricing. The build's worst case is the lab budget plus the operator's
// review; the per-call worst case is the sum of the primitives plus
// overhead. Both prices are at least 1.5x (lib/pricing.mjs).
export const FOUNDRY_REVIEW_COST_USD = 1;
export const FOUNDRY_MIN_BUILD_FEE_USD = 5;
export const FOUNDRY_CALL_OVERHEAD_USD = 0.0005;
export const FOUNDRY_MIN_CALL_PRICE_USD = 0.01;
export const COMMISSIONER_DISCOUNT = 0.2;
export const QUOTE_TTL_HOURS = 24;

export function buildWorstCostUsd(labBudgetUsd) {
  return Math.round((Number(labBudgetUsd) + FOUNDRY_REVIEW_COST_USD) * 1e6) / 1e6;
}

export function quoteFor(plan, { labBudgetUsd }) {
  const buildWorst = buildWorstCostUsd(labBudgetUsd);
  const callWorst = Math.round((plan.steps.reduce((n, s) => n + PRIMITIVES[s.tool].costUsd, 0) + FOUNDRY_CALL_OVERHEAD_USD) * 1e6) / 1e6;
  const buildFee = Math.max(FOUNDRY_MIN_BUILD_FEE_USD, minimumPrice(buildWorst));
  const perCall = Math.max(FOUNDRY_MIN_CALL_PRICE_USD, minimumPrice(callWorst));
  // The commissioner's price on a public tool never drops below 1.5x cost.
  const commissionerPerCall = Math.max(minimumPrice(callWorst), Math.round(perCall * (1 - COMMISSIONER_DISCOUNT) * 1e6) / 1e6);
  assertPricing([
    { name: 'foundry_build', priceUsd: buildFee, worstCaseCostUsd: buildWorst },
    { name: 'foundry_call', priceUsd: perCall, worstCaseCostUsd: callWorst },
    { name: 'foundry_call_commissioner', priceUsd: commissionerPerCall, worstCaseCostUsd: callWorst }
  ]);
  return { build_fee_usd: buildFee, per_call_usd: perCall, commissioner_per_call_usd: commissionerPerCall, worst_build_cost_usd: buildWorst, worst_call_cost_usd: callWorst, p95_ms_estimate: Math.max(...plan.steps.map((s) => PRIMITIVES[s.tool].p95Ms)) };
}
