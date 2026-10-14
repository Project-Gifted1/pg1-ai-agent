// Agent-economy checks, computed by PG1 over public data:
//
// check_x402_endpoint { url }
//   Fetches the URL once (https only, never a private address, no redirects:
//   lib/netGuard.mjs) and reads its x402 payment request (the
//   PAYMENT-REQUIRED header or the 402 body). For each payment option:
//   the network is a known settlement network, the asset is the known USDC
//   contract on that network, the receiving wallet (payTo) is screened
//   against the sanctions list and its on-chain age is read. The endpoint's
//   domain age is checked too. TLS: the request only succeeds over https
//   with a certificate Node's TLS stack accepts.
// check_agent_card { url | domain }
//   Fetches /.well-known/agent-card.json the same safe way and checks it is
//   a valid A2A agent card (name, url, version, skills), that its name does
//   not claim a well-known brand the domain does not belong to, and the
//   domain's age and phishing/look-alike reputation.
// Both feed preflight_check (lib/preflight.mjs): pay to an https URL uses
// check_x402_endpoint, trust_agent uses check_agent_card.
//
// runTool(name, args) is PG1's own read-only handler (api/mcp.mjs
// runReadOnlyTool), injected so tests and preflight share it.

import { safeFetch, UnsafeUrlError, checkUrlShape } from './netGuard.mjs';
import { reason } from './reasonCodes.mjs';
import { buildCheck, withResponseMeta } from './responseMeta.mjs';

// Native USDC per x402 network (CAIP-2), lowercased for EVM.
export const KNOWN_USDC = Object.freeze({
  'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  'eip155:84532': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  'eip155:1': '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  'eip155:42161': '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  'eip155:10': '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
  'eip155:137': '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
});
const LEGACY_NETWORK_NAMES = { base: 'eip155:8453', 'base-sepolia': 'eip155:84532', ethereum: 'eip155:1', arbitrum: 'eip155:42161', optimism: 'eip155:10', polygon: 'eip155:137', solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' };
const CHAIN_FOR_AGE = { 'eip155:8453': 'base', 'eip155:1': 'ethereum', 'eip155:42161': 'arbitrum', 'eip155:10': 'optimism', 'eip155:137': 'polygon' };
export const FETCH_TIMEOUT_MS = 6000;

// Brands agents commonly impersonate, with the domains that are really
// theirs. A card naming one of these from another domain is flagged.
export const AGENT_BRANDS = Object.freeze({
  pg1: ['pg1-ai-agent.vercel.app'], coinbase: ['coinbase.com', 'cdp.coinbase.com', 'base.org'], openai: ['openai.com', 'chatgpt.com'],
  anthropic: ['anthropic.com', 'claude.ai'], google: ['google.com', 'googleapis.com', 'cloud.google.com'], metamask: ['metamask.io'],
  stripe: ['stripe.com'], paypal: ['paypal.com'], binance: ['binance.com'], microsoft: ['microsoft.com', 'azure.com'], circle: ['circle.com']
});

function registrable(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  return parts.slice(-2).join('.');
}

// Brand claimed in a name: a word match after folding common look-alike
// characters (0->o, 1->l, 3->e, 5->s, rn->m).
export function claimedBrand(name) {
  const folded = String(name || '').toLowerCase().replace(/rn/g, 'm').replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/5/g, 's').replace(/[^a-z ]+/g, ' ');
  return Object.keys(AGENT_BRANDS).find((b) => new RegExp(`(^|\\s)${b}(\\s|$)`).test(folded) || folded.replace(/\s+/g, '').includes(b) && b.length >= 6) || null;
}

function brandOwnsHost(brand, host) {
  const h = String(host || '').toLowerCase();
  return AGENT_BRANDS[brand].some((d) => h === d || h.endsWith(`.${d}`));
}

function decodeHeader(v) {
  try { return JSON.parse(Buffer.from(String(v), 'base64').toString('utf8')); } catch (e) { return null; }
}

async function safeRun(runTool, name, args) {
  try {
    return { ok: true, result: await runTool(name, args) };
  } catch (e) {
    return { ok: false, error: e && (e.code || 'failed') };
  }
}

// --- check_x402_endpoint -------------------------------------------------------------

export async function checkX402Endpoint(args, { runTool, fetchImpl = globalThis.fetch, lookup, requestId = null } = {}) {
  const raw = args && typeof args.url === 'string' ? args.url.trim() : '';
  let url;
  try {
    url = checkUrlShape(raw);
  } catch (e) {
    throw Object.assign(new Error(`Invalid url: ${e.message}`), { mcpToolError: true, code: 'invalid_url' });
  }
  const reasons = [];
  const checks = [];
  let res = null;
  try {
    res = await safeFetch(url.toString(), { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'PG1-check/1.18' } }, { fetchImpl, lookup, timeoutMs: FETCH_TIMEOUT_MS });
    checks.push(buildCheck('endpoint (https)', 'ok'));
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw Object.assign(new Error(`Refused: ${e.message}`), { mcpToolError: true, code: e.code });
    reasons.push(reason('ENDPOINT_TLS_FAILED'));
    checks.push(buildCheck('endpoint (https)', /abort|timeout/i.test(String(e && e.name || e)) ? 'timeout' : 'error'));
  }
  let required = null;
  if (res) {
    const header = res.headers && (res.headers.get('payment-required') || res.headers.get('PAYMENT-REQUIRED'));
    if (header) required = decodeHeader(header);
    if (!required && res.status === 402) {
      try { required = await res.json(); } catch (e) { required = null; }
    }
  }
  const accepts = required && Array.isArray(required.accepts) ? required.accepts.slice(0, 5) : [];
  if (res && !accepts.length) reasons.push(reason('X402_NO_PAYMENT_REQUEST'));
  const options = [];
  for (const a of accepts) {
    const network = LEGACY_NETWORK_NAMES[String(a.network || '').toLowerCase()] || String(a.network || '');
    const asset = String(a.asset || '');
    const payTo = String(a.payTo || a.pay_to || '');
    const known = KNOWN_USDC[network];
    const opt = { network, asset, pay_to: payTo, amount: a.amount ?? a.maxAmountRequired ?? null, known_network: !!known, known_usdc: !!known && (network.startsWith('eip155:') ? asset.toLowerCase() === known : asset === known) };
    if (!known) reasons.push(reason('X402_UNKNOWN_NETWORK', `The payment request names network ${network || '(none)'}, which is not a known x402 settlement network.`));
    else if (!opt.known_usdc) reasons.push(reason('X402_UNKNOWN_ASSET', `The payment request asks for asset ${asset || '(none)'} on ${network}, not the known USDC contract.`));
    if (/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
      const [sanctions, age] = await Promise.all([
        safeRun(runTool, 'check_wallet_sanctions', { address: payTo }),
        CHAIN_FOR_AGE[network] ? safeRun(runTool, 'check_wallet_age', { address: payTo, chain: CHAIN_FOR_AGE[network] }) : Promise.resolve(null)
      ]);
      checks.push(buildCheck('sanctions list', sanctions.ok ? 'ok' : 'error'));
      if (sanctions.ok && sanctions.result.listed) reasons.push(reason('WALLET_SANCTIONED', 'The receiving wallet (payTo) matches an entry on the sanctions list.'));
      opt.pay_to_sanctioned = sanctions.ok ? !!sanctions.result.listed : null;
      if (age) {
        checks.push(buildCheck('on-chain transfer history', age.ok ? 'ok' : 'error'));
        opt.pay_to_age_days = age.ok ? age.result.age_days ?? null : null;
        if (age.ok && age.result.found && Number(age.result.age_days) < 7) reasons.push(reason('WALLET_NEW_7D'));
      }
    }
    options.push(opt);
  }
  const domain = await safeRun(runTool, 'check_domain_age', { domain: registrable(url.hostname) });
  checks.push(buildCheck('domain registration data', domain.ok ? 'ok' : 'error'));
  if (domain.ok && (domain.result.reasons || []).some((r) => r.code === 'DOMAIN_NEWLY_REGISTERED_30D')) reasons.push(reason('DOMAIN_NEWLY_REGISTERED_30D'));
  return withResponseMeta({
    url: url.toString(),
    reachable_over_https: !!res,
    http_status: res ? res.status : null,
    x402: { payment_request_found: accepts.length > 0, x402_version: required && required.x402Version || null, options },
    domain: registrable(url.hostname),
    domain_age_days: domain.ok ? domain.result.age_days ?? null : null
  }, { reasons, checks, requestId });
}

// --- check_agent_card ------------------------------------------------------------------

export function validateAgentCard(card) {
  const problems = [];
  if (!card || typeof card !== 'object' || Array.isArray(card)) return ['not a JSON object'];
  if (typeof card.name !== 'string' || !card.name.trim()) problems.push('name missing');
  if (typeof card.url !== 'string' || !/^https:\/\//i.test(card.url)) problems.push('url missing or not https');
  if (typeof card.version !== 'string' || !card.version) problems.push('version missing');
  if (!Array.isArray(card.skills) || !card.skills.length) problems.push('skills missing');
  else if (card.skills.some((s) => !s || typeof s.id !== 'string' || typeof s.name !== 'string')) problems.push('a skill lacks id or name');
  if (card.capabilities != null && typeof card.capabilities !== 'object') problems.push('capabilities malformed');
  return problems;
}

export async function checkAgentCard(args, { runTool, fetchImpl = globalThis.fetch, lookup, requestId = null } = {}) {
  const input = args && (typeof args.url === 'string' ? args.url : typeof args.domain === 'string' ? `https://${args.domain}` : '');
  let base;
  try {
    base = checkUrlShape(String(input || '').trim());
  } catch (e) {
    throw Object.assign(new Error(`Invalid url or domain: ${e.message}`), { mcpToolError: true, code: 'invalid_url' });
  }
  const cardUrl = /\/\.well-known\/agent(?:-card)?\.json$/.test(base.pathname) ? base.toString() : `https://${base.host}/.well-known/agent-card.json`;
  const reasons = [];
  const checks = [];
  let card = null;
  let fetched = false;
  try {
    const res = await safeFetch(cardUrl, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'PG1-check/1.18' } }, { fetchImpl, lookup, timeoutMs: FETCH_TIMEOUT_MS });
    fetched = true;
    if (res.ok) {
      const text = (await res.text()).slice(0, 200000);
      try { card = JSON.parse(text); } catch (e) { card = null; }
    }
    checks.push(buildCheck('agent card', 'ok'));
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw Object.assign(new Error(`Refused: ${e.message}`), { mcpToolError: true, code: e.code });
    checks.push(buildCheck('agent card', 'error'));
  }
  if (!fetched || card === null) reasons.push(reason('AGENT_CARD_NOT_FOUND'));
  const problems = card !== null ? validateAgentCard(card) : [];
  if (card !== null && problems.length) reasons.push(reason('AGENT_CARD_INVALID', `The agent card is not a valid A2A agent card: ${problems.join('; ')}.`));
  const brand = card && typeof card.name === 'string' ? claimedBrand(card.name) : null;
  if (brand && !brandOwnsHost(brand, base.hostname)) reasons.push(reason('AGENT_CARD_NAME_IMPERSONATION', `The agent card's name claims ${brand}, but ${base.hostname} is not one of ${brand}'s domains.`));
  const [domain, rep] = await Promise.all([
    safeRun(runTool, 'check_domain_age', { domain: registrable(base.hostname) }),
    safeRun(runTool, 'check_hostname_reputation', { hostname: base.hostname })
  ]);
  checks.push(buildCheck('domain registration data', domain.ok ? 'ok' : 'error'));
  checks.push(buildCheck('phishing blocklist', rep.ok ? 'ok' : 'error'));
  for (const r of [domain, rep]) if (r.ok) for (const x of r.result.reasons || []) if (['DOMAIN_NEWLY_REGISTERED_30D', 'HOSTNAME_PHISHING_LISTED', 'HOSTNAME_LOOKALIKE'].includes(x.code)) reasons.push(reason(x.code));
  return withResponseMeta({
    card_url: cardUrl,
    found: card !== null,
    valid: card !== null && problems.length === 0,
    problems,
    name: card && typeof card.name === 'string' ? card.name.slice(0, 120) : null,
    claimed_brand: brand,
    skills: card && Array.isArray(card.skills) ? card.skills.length : 0,
    domain: registrable(base.hostname),
    domain_age_days: domain.ok ? domain.result.age_days ?? null : null,
    hostname_verdict: rep.ok ? rep.result.verdict || null : null
  }, { reasons, checks, requestId });
}
