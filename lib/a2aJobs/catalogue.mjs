// The A2A job catalogue: a fixed allowlist of jobs other agents can buy.
// Each job type has an input schema (validated field by field: schema
// fields only, sizes capped, free text never executed), a price formula, a
// worst-case cost formula, an ETA and its outputs. Prices are at least 1.5x
// the worst-case cost for every allowed input size: asserted when this file
// loads (so a bad edit fails at startup) and in the tests.
//
// Media jobs are off unless PG1_A2A_MEDIA=true, and none are implemented:
// the catalogue has no media job, so the flag only keeps it that way.

import { assertPricing, priceCoversCost } from '../pricing.mjs';
import { isRecognizedWalletAddress } from '../walletAddress.mjs';

export const FREE_TIER_JOB_MAX_USD = 0.05;
export const MAX_FREE_TEXT = 200;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;
const CVE_RE = /^CVE-\d{4}-\d{4,}$/i;
const CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'];

export class JobInputError extends Error {
  constructor(message) {
    super(message);
    this.code = 'invalid_job_input';
  }
}

const round = (n) => Math.round(n * 1e6) / 1e6;
const cleanText = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>`]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FREE_TEXT);

function onlyKeys(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new JobInputError('input must be an object');
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length) throw new JobInputError(`unknown input field${extra.length === 1 ? '' : 's'}: ${extra.slice(0, 5).join(', ')} (allowed: ${allowed.join(', ')})`);
}

function list(input, key, { min = 1, max, item }) {
  const v = input[key];
  if (!Array.isArray(v)) throw new JobInputError(`${key} must be an array`);
  if (v.length < min || v.length > max) throw new JobInputError(`${key} must have ${min} to ${max} items (got ${v.length})`);
  const out = v.map((x, i) => {
    try { return item(x); } catch (e) { throw new JobInputError(`${key}[${i}]: ${e.message}`); }
  });
  return [...new Map(out.map((x) => [JSON.stringify(x), x])).values()];
}

export const JOB_TYPES = Object.freeze({
  batch_wallet_screen: Object.freeze({
    title: 'Batch wallet screen',
    description: 'Screens up to 500 EVM wallets: OFAC SDN sanctions match and on-chain age (first seen) per wallet, as one JSON report.',
    maxItems: 500,
    inputSchema: { type: 'object', properties: { wallets: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } }, chain: { type: 'string', enum: CHAINS } }, required: ['wallets'], additionalProperties: false },
    validate(input) {
      onlyKeys(input, ['wallets', 'chain']);
      const wallets = list(input, 'wallets', { max: 500, item: (w) => { const s = String(w || '').trim(); if (!EVM_RE.test(s)) throw new Error('not a 0x EVM address'); return s.toLowerCase(); } });
      const chain = input.chain == null ? 'ethereum' : String(input.chain);
      if (!CHAINS.includes(chain)) throw new JobInputError(`chain must be one of ${CHAINS.join(', ')}`);
      return { wallets, chain };
    },
    size: (v) => v.wallets.length,
    // Worst case per wallet: one sanctions lookup (local list) and up to
    // three RPC calls for the age; $0.0006 each at public-RPC paid rates.
    worstCaseCostUsd: (n) => round(0.002 + n * 0.0018),
    priceUsd: (n) => round(0.01 + n * 0.003),
    etaSeconds: (n) => 20 + Math.ceil(n * 0.4),
    outputs: ['json']
  }),
  cve_exposure_report: Object.freeze({
    title: 'CVE exposure report',
    description: 'For up to 25 products (vendor, product, optional version): the known CVEs from NVD with severity, as JSON and a PDF report.',
    maxItems: 25,
    inputSchema: { type: 'object', properties: { products: { type: 'array', minItems: 1, maxItems: 25, items: { type: 'object', properties: { vendor: { type: 'string', maxLength: 80 }, product: { type: 'string', maxLength: 80 }, version: { type: 'string', maxLength: 40 } }, required: ['product'], additionalProperties: false } }, title: { type: 'string', maxLength: 200 } }, required: ['products'], additionalProperties: false },
    validate(input) {
      onlyKeys(input, ['products', 'title']);
      const products = list(input, 'products', { max: 25, item: (p) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('must be an object');
        const extra = Object.keys(p).filter((k) => !['vendor', 'product', 'version'].includes(k));
        if (extra.length) throw new Error(`unknown field ${extra[0]}`);
        const word = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
        const product = word(p.product, 80);
        if (!/^[\w .+:-]{1,80}$/.test(product)) throw new Error('product must be a plain name');
        const vendor = word(p.vendor, 80);
        const version = word(p.version, 40);
        if (vendor && !/^[\w .+:-]{1,80}$/.test(vendor)) throw new Error('vendor must be a plain name');
        if (version && !/^[\w.+:-]{1,40}$/.test(version)) throw new Error('version must be a plain version string');
        return { vendor: vendor || null, product, version: version || null };
      } });
      return { products, title: cleanText(input.title) || 'CVE exposure report' };
    },
    size: (v) => v.products.length,
    worstCaseCostUsd: (n) => round(0.004 + n * 0.004),
    priceUsd: (n) => round(0.05 + n * 0.01),
    etaSeconds: (n) => 30 + n * 6,
    outputs: ['json', 'pdf']
  }),
  hostname_package_batch: Object.freeze({
    title: 'Hostname and package batch check',
    description: 'Up to 200 items in total: hostnames (phishing blocklist and look-alike check) and npm/PyPI packages (existence, age, malicious reports, known vulnerabilities), as one JSON report.',
    maxItems: 200,
    inputSchema: { type: 'object', properties: { hostnames: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 253 } }, packages: { type: 'array', maxItems: 200, items: { type: 'object', properties: { ecosystem: { type: 'string', enum: ['npm', 'pypi'] }, name: { type: 'string', maxLength: 214 }, version: { type: 'string', maxLength: 64 } }, required: ['ecosystem', 'name'], additionalProperties: false } } }, additionalProperties: false },
    validate(input) {
      onlyKeys(input, ['hostnames', 'packages']);
      const hostnames = input.hostnames == null ? [] : list(input, 'hostnames', { min: 0, max: 200, item: (h) => { const s = String(h || '').trim().toLowerCase(); if (!HOST_RE.test(s)) throw new Error('not a bare hostname'); return s; } });
      const packages = input.packages == null ? [] : list(input, 'packages', { min: 0, max: 200, item: (p) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('must be an object');
        const extra = Object.keys(p).filter((k) => !['ecosystem', 'name', 'version'].includes(k));
        if (extra.length) throw new Error(`unknown field ${extra[0]}`);
        const ecosystem = String(p.ecosystem || '').toLowerCase();
        if (!['npm', 'pypi'].includes(ecosystem)) throw new Error('ecosystem must be npm or pypi');
        const name = String(p.name || '').trim();
        if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]{0,213}$/i.test(name)) throw new Error('not a package name');
        const version = p.version == null ? null : String(p.version).trim();
        if (version && !/^[\w.+-]{1,64}$/.test(version)) throw new Error('not a version');
        return { ecosystem, name, version };
      } });
      if (hostnames.length + packages.length < 1) throw new JobInputError('give at least one hostname or package');
      if (hostnames.length + packages.length > 200) throw new JobInputError('at most 200 hostnames and packages in total');
      return { hostnames, packages };
    },
    size: (v) => v.hostnames.length + v.packages.length,
    worstCaseCostUsd: (n) => round(0.001 + n * 0.0008),
    priceUsd: (n) => round(0.005 + n * 0.0015),
    etaSeconds: (n) => 15 + Math.ceil(n * 0.5),
    outputs: ['json']
  }),
  threat_writeup_pdf: Object.freeze({
    title: 'Threat write-up (PDF)',
    description: 'Runs PG1\'s checks on up to 20 subjects (wallets, domains, hostnames, packages, CVEs) and writes a plain-language threat write-up from the results only, as a PDF plus the JSON results.',
    maxItems: 20,
    inputSchema: { type: 'object', properties: { subjects: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { type: { type: 'string', enum: ['wallet', 'domain', 'hostname', 'package', 'cve'] }, value: { type: 'string', maxLength: 253 }, ecosystem: { type: 'string', enum: ['npm', 'pypi'] } }, required: ['type', 'value'], additionalProperties: false } }, audience: { type: 'string', maxLength: 200 }, title: { type: 'string', maxLength: 200 } }, required: ['subjects'], additionalProperties: false },
    validate(input) {
      onlyKeys(input, ['subjects', 'audience', 'title']);
      const subjects = list(input, 'subjects', { max: 20, item: (s) => {
        if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('must be an object');
        const extra = Object.keys(s).filter((k) => !['type', 'value', 'ecosystem'].includes(k));
        if (extra.length) throw new Error(`unknown field ${extra[0]}`);
        const type = String(s.type || '');
        const value = String(s.value || '').trim();
        if (type === 'wallet' && !(EVM_RE.test(value) || isRecognizedWalletAddress(value))) throw new Error('not a wallet address');
        if ((type === 'domain' || type === 'hostname') && !HOST_RE.test(value)) throw new Error('not a hostname');
        if (type === 'cve' && !CVE_RE.test(value)) throw new Error('not a CVE id');
        if (type === 'package') {
          if (!['npm', 'pypi'].includes(String(s.ecosystem || ''))) throw new Error('a package needs ecosystem npm or pypi');
          if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]{0,213}$/i.test(value)) throw new Error('not a package name');
        }
        if (!['wallet', 'domain', 'hostname', 'package', 'cve'].includes(type)) throw new Error('type must be wallet, domain, hostname, package or cve');
        return type === 'package' ? { type, value, ecosystem: s.ecosystem } : { type, value: type === 'cve' ? value.toUpperCase() : type === 'wallet' && EVM_RE.test(value) ? value.toLowerCase() : value.toLowerCase() };
      } });
      return { subjects, audience: cleanText(input.audience), title: cleanText(input.title) || 'Threat write-up' };
    },
    size: (v) => v.subjects.length,
    // One write-up model call (up to ~12k tokens in, 4k out on the
    // reasoning core) plus the checks.
    worstCaseCostUsd: (n) => round(0.14 + n * 0.003),
    priceUsd: (n) => round(0.25 + n * 0.01),
    etaSeconds: (n) => 60 + n * 5,
    outputs: ['json', 'pdf']
  })
});

export function mediaJobsEnabled(env = process.env) {
  return String(env.PG1_A2A_MEDIA || '').trim().toLowerCase() === 'true';
}

// The job types on offer. No media job exists; PG1_A2A_MEDIA cannot add one.
export function catalogue(env = process.env) {
  void mediaJobsEnabled(env);
  return Object.keys(JOB_TYPES);
}

// Validate and price one request. Throws JobInputError.
export function quoteFor(jobType, input) {
  const t = JOB_TYPES[jobType];
  if (!t) throw new JobInputError(`unknown job_type: use one of ${Object.keys(JOB_TYPES).join(', ')}`);
  const value = t.validate(input);
  const n = t.size(value);
  const price = t.priceUsd(n);
  const cost = t.worstCaseCostUsd(n);
  if (!priceCoversCost(price, cost)) throw new Error(`pricing bug: ${jobType} at ${n}`);
  return { jobType, input: value, items: n, priceUsd: price, worstCaseCostUsd: cost, etaSeconds: t.etaSeconds(n), outputs: t.outputs, freeTierEligible: price < FREE_TIER_JOB_MAX_USD };
}

// Every job type at every allowed size: price >= 1.5x worst-case cost.
export function assertCataloguePricing() {
  const items = [];
  for (const [name, t] of Object.entries(JOB_TYPES)) {
    for (const n of [1, 2, Math.ceil(t.maxItems / 2), t.maxItems]) items.push({ name: `${name}@${n}`, priceUsd: t.priceUsd(n), worstCaseCostUsd: t.worstCaseCostUsd(n) });
  }
  return assertPricing(items);
}
assertCataloguePricing();

// The agent card's entries for the jobs (public/.well-known/agent-card.json).
export function agentCardJobSkills() {
  return Object.entries(JOB_TYPES).map(([id, t]) => ({
    id: `job.${id}`,
    name: t.title,
    description: `${t.description} Paid A2A job: submit with the submit_job skill ({"skill":"submit_job","arguments":{"job_type":"${id}","input":{...}}}); PG1 validates and returns a quote (price, ETA, expiry) as an input-required task with the x402 payment requirements; pay by sending the PaymentPayload in message.metadata["x402.payment.payload"] with the task's taskId. Settled only when the job is accepted to run. Price: ${t.priceUsd(1)} USD for 1 item, ${t.priceUsd(t.maxItems)} USD for ${t.maxItems}. Jobs under ${FREE_TIER_JOB_MAX_USD} USD can use the shared 5/day free tier.`,
    tags: ['job', 'paid', 'x402', ...(t.outputs.includes('pdf') ? ['pdf'] : [])],
    examples: [`Submit a ${id} job`],
    inputModes: ['application/json'],
    outputModes: t.outputs.includes('pdf') ? ['application/json', 'application/pdf'] : ['application/json'],
    inputSchema: t.inputSchema,
    pricing: { currency: 'USD', base_usd: t.priceUsd(0), per_item_usd: round(t.priceUsd(1) - t.priceUsd(0)), max_items: t.maxItems, eta_seconds_per_item: round((t.etaSeconds(t.maxItems) - t.etaSeconds(1)) / Math.max(1, t.maxItems - 1)) }
  }));
}
