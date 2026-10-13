// Payment configuration checks (Phase 2, item 5). Read-only: nothing here
// pays, settles, spends free-tier quota or writes anything.
//
//   staticPaymentChecks()      the repo agrees with itself: lib/x402Config.mjs
//                              (price, network, asset) against the published
//                              discovery document public/.well-known/x402,
//                              the free-tier limit against the docs, and the
//                              A2A agent card against api/a2a.mjs.
//   livePaymentChecks(base)    a deployment answers unpaid calls with the
//                              same terms: /api/mcp (x402 v2 MCP transport),
//                              /api/a2a (a2a-x402 input-required task) and
//                              /api/ioc (HTTP 402 + PAYMENT-REQUIRED), each
//                              naming the network, asset, amount and payTo
//                              that /.well-known/x402 publishes.
//
// Each check is { name, ok, detail }. scripts/verify-payment-config.mjs runs
// them from the command line; tests/payment-config.test.mjs runs the static
// ones and the live ones against a mocked deployment.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultAsset } from '@x402/evm';
import { X402_NETWORK, X402_PRICE, X402_SCHEME, x402PriceUsd } from './x402Config.mjs';
import { FREE_TIER_DAILY_LIMIT } from './freeTier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

export const PROD_BASE_URL = 'https://pg1-ai-agent.vercel.app';

// The paid call each live check makes without paying: a CVE lookup, the
// cheapest paid tool, which never runs because the gate answers first.
const PAID_PROBE = { tool: 'get_cve_details', args: { cve_id: 'CVE-2021-44228' } };

// x402 amounts are in the asset's smallest unit: 0.01 USD of USDC (6
// decimals) is "10000".
export function expectedAccepts() {
  const asset = getDefaultAsset(X402_NETWORK);
  const amount = String(Math.round(x402PriceUsd(X402_PRICE) * 10 ** asset.decimals));
  return { scheme: X402_SCHEME, network: X402_NETWORK, asset: asset.asset || asset.address, amount };
}

const check = (name, ok, detail = '') => ({ name, ok: !!ok, detail });
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function acceptsMismatch(accept, want, payTo) {
  if (!accept || typeof accept !== 'object') return 'no accepts entry';
  const wrong = [];
  if (accept.scheme !== want.scheme) wrong.push(`scheme ${accept.scheme}`);
  if (accept.network !== want.network) wrong.push(`network ${accept.network}`);
  if (!sameAddress(accept.asset, want.asset)) wrong.push(`asset ${accept.asset}`);
  if (String(accept.amount ?? accept.maxAmountRequired) !== want.amount) wrong.push(`amount ${accept.amount ?? accept.maxAmountRequired}`);
  if (payTo && !sameAddress(accept.payTo, payTo)) wrong.push(`payTo ${accept.payTo}`);
  return wrong.join(', ');
}

export function staticPaymentChecks() {
  const want = expectedAccepts();
  const results = [];
  const wellKnown = JSON.parse(read('public/.well-known/x402'));
  const resources = Array.isArray(wellKnown.resources) ? wellKnown.resources : [];
  results.push(check('/.well-known/x402 is x402 v2 and lists /api/ioc and /api/mcp', wellKnown.x402Version === 2 && ['/api/ioc', '/api/mcp'].every((p) => resources.some((r) => String(r.resource).endsWith(p))), `x402Version ${wellKnown.x402Version}, ${resources.length} resources`));
  const payTos = new Set();
  for (const r of resources) {
    const accept = (r.accepts || [])[0];
    if (accept) payTos.add(String(accept.payTo).toLowerCase());
    const mismatch = acceptsMismatch(accept, want);
    results.push(check(`${r.resource}: scheme, network, asset and amount match lib/x402Config.mjs`, !mismatch, mismatch || `${want.amount} of ${want.asset} on ${want.network}`));
  }
  results.push(check('every published resource pays the same address', payTos.size === 1, [...payTos].join(', ')));

  const openapi = read('public/openapi.json');
  results.push(check(`docs state the free tier as ${FREE_TIER_DAILY_LIMIT} calls/day`, openapi.includes(`${FREE_TIER_DAILY_LIMIT} calls/day`), 'public/openapi.json'));

  const card = JSON.parse(read('public/.well-known/agent-card.json'));
  const priceText = `${x402PriceUsd(X402_PRICE)} USD`;
  const ext = (card.capabilities && card.capabilities.extensions) || [];
  results.push(check('agent card declares the a2a-x402 extension and the price', ext.some((e) => /a2a-x402/.test(e.uri)) && card.description.includes(priceText), priceText));
  return results;
}

async function json(res) {
  try { return await res.json(); } catch { return null; }
}

function decodeHeader(value) {
  if (!value) return null;
  try { return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8')); } catch { return null; }
}

// payTo: the address the deployment must be paid to (default: the one
// /.well-known/x402 publishes in this repo).
export async function livePaymentChecks(base = PROD_BASE_URL, { fetchImpl = fetch, payTo } = {}) {
  const want = expectedAccepts();
  const wellKnown = JSON.parse(read('public/.well-known/x402'));
  const expectedPayTo = payTo || (wellKnown.resources[0].accepts[0] || {}).payTo;
  const results = [];
  const post = (p, body, headers = {}) => fetchImpl(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  try {
    const res = await fetchImpl(`${base}/.well-known/x402`);
    const live = res.ok ? await json(res) : null;
    const liveAccept = live && live.resources && live.resources[0] && live.resources[0].accepts[0];
    const mismatch = acceptsMismatch(liveAccept, want, expectedPayTo);
    results.push(check('deployed /.well-known/x402 matches this repo', res.ok && !mismatch, mismatch || `HTTP ${res.status}`));
  } catch (e) {
    results.push(check('deployed /.well-known/x402 matches this repo', false, e.message));
  }

  try {
    const res = await post('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: PAID_PROBE.tool, arguments: PAID_PROBE.args } });
    const body = await json(res);
    const pr = body && body.result && body.result.isError ? body.result.structuredContent : null;
    const mismatch = acceptsMismatch(pr && pr.accepts && pr.accepts[0], want, expectedPayTo);
    results.push(check('/api/mcp: an unpaid paid-tool call returns the x402 v2 PaymentRequired result', res.status === 200 && pr && pr.x402Version === 2 && !mismatch, mismatch || (pr ? 'ok' : `HTTP ${res.status}, no PaymentRequired`)));
    results.push(check('/api/mcp: PAYMENT-REQUIRED header carries the same object', !!decodeHeader(res.headers.get('payment-required')), ''));
  } catch (e) {
    results.push(check('/api/mcp: an unpaid paid-tool call returns the x402 v2 PaymentRequired result', false, e.message));
  }

  try {
    const res = await post('/api/a2a', { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'payment-config-check', parts: [{ kind: 'data', data: { skill: PAID_PROBE.tool, arguments: PAID_PROBE.args } }] } } });
    const body = await json(res);
    const task = body && body.result;
    const meta = task && task.status && task.status.message && task.status.message.metadata;
    const pr = meta && meta['x402.payment.required'];
    const mismatch = acceptsMismatch(pr && pr.accepts && pr.accepts[0], want, expectedPayTo);
    results.push(check('/api/a2a: an unpaid paid skill returns an input-required task with x402.payment.required', task && task.status.state === 'input-required' && meta['x402.payment.status'] === 'payment-required' && !mismatch, mismatch || (pr ? 'ok' : `HTTP ${res.status}, no payment-required task`)));
  } catch (e) {
    results.push(check('/api/a2a: an unpaid paid skill returns an input-required task with x402.payment.required', false, e.message));
  }

  try {
    const res = await fetchImpl(`${base}/api/ioc`);
    const pr = decodeHeader(res.headers.get('payment-required'));
    const mismatch = acceptsMismatch(pr && pr.accepts && pr.accepts[0], want, expectedPayTo);
    results.push(check('/api/ioc: an unpaid request returns 402 with PAYMENT-REQUIRED', res.status === 402 && pr && !mismatch, mismatch || `HTTP ${res.status}`));
  } catch (e) {
    results.push(check('/api/ioc: an unpaid request returns 402 with PAYMENT-REQUIRED', false, e.message));
  }

  try {
    const res = await post('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_usage_status', arguments: {} } });
    const body = await json(res);
    const text = body && body.result && body.result.content && body.result.content[0] && body.result.content[0].text;
    const usage = text ? JSON.parse(text) : null;
    results.push(check(`free tier is live at ${FREE_TIER_DAILY_LIMIT}/day (get_usage_status)`, usage && usage.free_tier_daily_limit === FREE_TIER_DAILY_LIMIT, usage ? `limit ${usage.free_tier_daily_limit}` : `HTTP ${res.status}`));
  } catch (e) {
    results.push(check(`free tier is live at ${FREE_TIER_DAILY_LIMIT}/day (get_usage_status)`, false, e.message));
  }
  return results;
}
