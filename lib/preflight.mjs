// preflight_check: one call before an agent acts, one decision.
//
//   input  { action: pay | open | install | patch | trust_agent, target,
//            chain?, ecosystem? }
//   output { decision: no_flags | flagged | unknown, reasons (merged, each
//            with the check that raised it), checks (per check: tool,
//            status, ms, reasons), latency_ms }
//
// Every relevant check runs in parallel. Fail closed: a check that errors
// or does not finish within PREFLIGHT_CHECK_TIMEOUT_MS makes the decision
// unknown (PREFLIGHT_CHECK_INCOMPLETE), never no_flags. Any flagged check
// makes it flagged.
//
//   pay          a wallet: sanctions + on-chain age; an https URL: the x402
//                endpoint check (payTo sanctions and age, network/asset,
//                TLS, domain age)
//   open         a URL or hostname: phishing/look-alike reputation + domain age
//   install      a package (ecosystem npm|pypi, target name or name@version)
//   patch        a CVE id: CVE details; otherwise "vendor product [version]"
//   trust_agent  an agent's URL or domain: the agent card check
//
// One paid call: PREFLIGHT_PRICE_USD (0.01 USD via x402, at least 1.5x the
// worst-case cost), inside the shared 5/day free tier.

import { reason } from './reasonCodes.mjs';
import { assertPricing } from './pricing.mjs';
import { X402_PRICE, x402PriceUsd } from './x402Config.mjs';

export const PREFLIGHT_TOOL = 'preflight_check';
export const PREFLIGHT_ACTIONS = Object.freeze(['pay', 'open', 'install', 'patch', 'trust_agent']);
export const PREFLIGHT_CHECK_TIMEOUT_MS = 8000;
export const PREFLIGHT_PRICE_USD = x402PriceUsd(X402_PRICE);
// Worst case: three upstream lookups (RPC, RDAP, registry) and one outbound fetch.
export const PREFLIGHT_WORST_CASE_COST_USD = 0.004;
assertPricing([{ name: PREFLIGHT_TOOL, priceUsd: PREFLIGHT_PRICE_USD, worstCaseCostUsd: PREFLIGHT_WORST_CASE_COST_USD }]);

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const CVE_RE = /^CVE-\d{4}-\d{4,}$/i;

export const PREFLIGHT_DEF = Object.freeze({
  name: PREFLIGHT_TOOL,
  description: 'PG1 Sovereign Threat Intelligence: ONE call before an agent acts. Give the action you are about to take and its target; PG1 runs every relevant check in parallel and returns one decision: no_flags, flagged or unknown, with merged reasons, per-check results and latency. Fail closed: any check that does not finish makes the decision unknown, never no_flags. Actions: pay (a wallet address: sanctions + wallet age; or an https x402 URL: the endpoint\'s payTo sanctions and age, network/asset sanity, TLS, domain age), open (a URL or hostname: phishing/look-alike reputation + domain age), install (a package: give ecosystem npm or pypi; target name or name@version), patch (a CVE id, or "vendor product version"), trust_agent (an agent\'s URL or domain: its A2A agent card, domain age and reputation). Payment: $0.01 via x402 (params._meta["x402/payment"]) or a Gumroad licence key, after 5 free calls a day per caller shared with every other paid tool. Results are signed (see verify_result).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: PREFLIGHT_ACTIONS.slice(), description: 'What you are about to do.' },
      target: { type: 'string', maxLength: 300, description: 'What you are about to do it to: a wallet address, URL, hostname, package name (name or name@version), CVE id or "vendor product version", or an agent URL/domain.' },
      chain: { type: 'string', enum: ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'bsc'], description: 'For pay to a wallet: the chain (default base).' },
      ecosystem: { type: 'string', enum: ['npm', 'pypi'], description: 'For install: the package registry.' }
    },
    required: ['action', 'target'],
    additionalProperties: false
  }
});

function invalid(message) {
  return Object.assign(new Error(message), { mcpToolError: true, code: 'invalid_input' });
}

function hostOf(target) {
  const t = String(target || '').trim();
  try {
    if (/^https?:\/\//i.test(t)) return new URL(t).hostname.toLowerCase();
  } catch (e) { return null; }
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t) ? t.toLowerCase() : null;
}

const registrable = (h) => String(h || '').split('.').slice(-2).join('.');

// The checks one request needs: [{ tool, args, run? }].
export function planPreflight({ action, target, chain, ecosystem }) {
  const t = String(target || '').trim().slice(0, 300);
  if (!PREFLIGHT_ACTIONS.includes(action)) throw invalid(`action must be one of ${PREFLIGHT_ACTIONS.join(', ')}`);
  if (!t) throw invalid('target is required');
  if (action === 'pay') {
    if (EVM_RE.test(t)) return [{ tool: 'check_wallet_sanctions', args: { address: t } }, { tool: 'check_wallet_age', args: { address: t, chain: chain || 'base' } }];
    if (/^https:\/\//i.test(t)) return [{ tool: 'check_x402_endpoint', args: { url: t } }];
    if (t.length >= 26 && t.length <= 64 && /^[A-Za-z0-9:]+$/.test(t)) return [{ tool: 'check_wallet_sanctions', args: { address: t } }];
    throw invalid('for pay, target must be a wallet address or an https URL');
  }
  if (action === 'open') {
    const host = hostOf(t);
    if (!host) throw invalid('for open, target must be a URL or a hostname');
    return [{ tool: 'check_hostname_reputation', args: { hostname: host } }, { tool: 'check_domain_age', args: { domain: registrable(host) } }];
  }
  if (action === 'install') {
    if (!['npm', 'pypi'].includes(ecosystem)) throw invalid('for install, ecosystem must be npm or pypi');
    const m = /^((?:@[^/@\s]+\/)?[^@\s]+)(?:@([^\s]+))?$/.exec(t);
    if (!m) throw invalid('for install, target must be name or name@version');
    return [{ tool: 'check_package', args: { ecosystem, name: m[1], ...(m[2] ? { version: m[2] } : {}) } }];
  }
  if (action === 'patch') {
    if (CVE_RE.test(t)) return [{ tool: 'get_cve_details', args: { cve_id: t.toUpperCase() } }];
    const parts = t.split(/\s+/);
    if (parts.length < 1 || parts.length > 3) throw invalid('for patch, target must be a CVE id or "vendor product version"');
    const [vendor, product, version] = parts.length === 1 ? [null, parts[0], null] : parts;
    return [{ tool: 'get_cve_by_product', args: { ...(vendor ? { vendor } : {}), product, ...(version ? { version } : {}) } }];
  }
  const host = hostOf(t);
  if (!host) throw invalid('for trust_agent, target must be an agent URL or domain');
  return [{ tool: 'check_agent_card', args: /^https:\/\//i.test(t) ? { url: t } : { domain: host } }];
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timed out'), { code: 'timeout' })), ms); })]).finally(() => clearTimeout(timer));
}

// runTool(name, args) runs one of PG1's checks (the agent-economy checks
// included). Never throws for a check failure: that is an unknown.
export async function runPreflight(args, { runTool, timeoutMs = PREFLIGHT_CHECK_TIMEOUT_MS, requestId = null, now = () => Date.now() } = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const plan = planPreflight({ action: a.action, target: a.target, chain: a.chain, ecosystem: a.ecosystem });
  const started = now();
  const results = await Promise.all(plan.map(async (p) => {
    const t0 = now();
    try {
      const r = await withTimeout(Promise.resolve().then(() => runTool(p.tool, p.args)), timeoutMs);
      return { tool: p.tool, status: ['flagged', 'no_flags', 'unknown'].includes(r && r.status) ? r.status : 'unknown', ms: now() - t0, reasons: (r && r.reasons) || [], request_id: (r && r.request_id) || null, sources: ((r && r.checks) || []).map((c) => c.source).filter(Boolean) };
    } catch (e) {
      return { tool: p.tool, status: 'unknown', ms: now() - t0, error: e && e.code === 'timeout' ? 'timeout' : (e && e.code) || 'error', reasons: [] };
    }
  }));
  const incomplete = results.filter((r) => r.error);
  const reasons = [];
  const seen = new Set();
  for (const r of results) {
    for (const x of r.reasons) {
      const key = `${x.code}|${r.tool}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reasons.push({ ...x, check: r.tool });
    }
  }
  if (incomplete.length) reasons.push({ ...reason('PREFLIGHT_CHECK_INCOMPLETE', `${incomplete.map((r) => `${r.tool} (${r.error})`).join(', ')} did not finish, so the decision is unknown.`), check: PREFLIGHT_TOOL });
  const decision = results.some((r) => r.status === 'flagged') ? 'flagged' : results.some((r) => r.status !== 'no_flags') ? 'unknown' : 'no_flags';
  return {
    decision,
    status: decision,
    action: a.action,
    target: String(a.target).slice(0, 300),
    reasons,
    checks: results.map((r) => ({ source: r.tool, tool: r.tool, result: r.error ? (r.error === 'timeout' ? 'timeout' : 'error') : 'ok', status: r.status, ms: r.ms, reasons: r.reasons.map((x) => x.code), request_id: r.request_id || null })),
    latency_ms: now() - started,
    request_id: requestId,
    note: decision === 'unknown' ? 'unknown is never safe: a check did not finish or could not decide. Treat it as a reason to stop or ask a human.' : undefined
  };
}
