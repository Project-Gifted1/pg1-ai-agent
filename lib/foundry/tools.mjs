// Deployed Foundry tools: listing, calling, monitoring.
//
// A tool is called as ft_<name> over MCP (tools/call) or A2A (skill). It
// runs its validated plan through PG1's own handlers at the EXTERNAL tier
// (lib/autonomy.mjs foundry:tool_call), is paid per call via x402, and its
// result is signed like every PG1 result.
//
// Private tools answer only to the commissioning wallet (the paying
// wallet's salted hash equals the owner's) or to the tool's access key
// (X-PG1-Tool-Key). Public tools are listed in tools/list; the key holder
// pays the commissioner price. A tool whose error rate passes 25% over an
// hour (at least 5 calls) is disabled automatically and the operator told.

import crypto from 'node:crypto';
import { runPlan } from './plan.mjs';
import { toolAccessKey } from './jobs.mjs';
import { authorize } from '../autonomy.mjs';

export const FOUNDRY_TOOL_PREFIX = 'ft_';
export const AUTO_DISABLE_ERROR_RATE = 0.25;
export const AUTO_DISABLE_MIN_CALLS = 5;
export const TOOL_KEY_HEADER = 'x-pg1-tool-key';
const LIST_CACHE_MS = 60000;

export const isFoundryToolName = (name) => typeof name === 'string' && /^ft_[a-z][a-z0-9_]{2,39}$/.test(name);

export class FoundryCallError extends Error {
  constructor(message, { status = 400, code = 'invalid_input' } = {}) {
    super(message);
    this.foundryCall = true;
    this.status = status;
    this.code = code;
  }
}

const sameKey = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function toolDefinition(tool) {
  return { name: tool.name, description: `${tool.description} Paid: $${Number(tool.per_call_usd).toFixed(3)} per call via x402. Results are signed.`.slice(0, 900), inputSchema: tool.input_schema };
}

let listCache = null;
export function __clearFoundryToolCache() {
  listCache = null;
}

// Public, active tools for tools/list. Never throws; [] when unavailable.
export async function publicFoundryToolDefs({ loadStore, now = Date.now() } = {}) {
  if (listCache && listCache.expires > now) return listCache.value;
  let value = [];
  try {
    const store = loadStore();
    value = store ? (await store.listTools({ publicOnly: true, activeOnly: true })).map(toolDefinition) : [];
  } catch (e) {
    value = [];
  }
  listCache = { value, expires: now + LIST_CACHE_MS };
  return value;
}

// deps: { store, gate(priceUsd, description) -> x402 gate, paymentOffered,
// subscriberHash(payer), runTool, sign(tool, args, result) -> signature|null,
// env, mode? }
// Resolves to { paymentRequired } or { result, signature, settlement }.
export async function callFoundryTool({ name, args, toolKey = null }, deps) {
  const tool = await deps.store.getToolByName(name);
  if (!tool) throw new FoundryCallError(`Unknown tool ${String(name).slice(0, 50)}.`, { status: 404, code: 'unknown_tool' });
  if (tool.status !== 'active') throw new FoundryCallError(`${tool.name} is disabled.`, { status: 503, code: 'tool_disabled' });
  const auth = authorize('foundry:tool_call', { actor: 'external', catalogueTool: tool.name, ...(deps.mode ? { mode: deps.mode } : {}) });
  if (!auth.allowed) throw new FoundryCallError(`${tool.name} is not available right now.`, { status: 503, code: 'unavailable' });
  const keyOk = sameKey(toolKey, toolAccessKey(tool.id, deps.env || process.env));
  const price = keyOk && tool.visibility === 'public' ? Number(tool.commissioner_per_call_usd) : Number(tool.per_call_usd);
  // A private tool does not even quote to a caller with neither its key nor
  // a payment (whose wallet is then checked against the owner's).
  if (tool.visibility === 'private' && !keyOk && !deps.paymentOffered) throw new FoundryCallError(`Unknown tool ${tool.name}.`, { status: 404, code: 'unknown_tool' });
  const g = await deps.gate(price, `PG1 Foundry tool ${tool.name}`);
  if (!g.authorized) return { paymentRequired: g.paymentRequired, tool };
  // P11: the paying wallet is screened before the tool runs or anything settles.
  if (g.settle && deps.screen) {
    const screened = await deps.screen(g.payer, 'foundry tool call');
    if (screened && screened.refused) throw new FoundryCallError(screened.message || 'This wallet cannot be served.', { status: 403, code: 'payer_refused' });
  }
  if (tool.visibility === 'private' && !keyOk) {
    const payer = g.payer ? deps.subscriberHash(g.payer) : null;
    if (!payer || !tool.owner_hash || payer !== tool.owner_hash) throw new FoundryCallError(`Unknown tool ${tool.name}.`, { status: 404, code: 'unknown_tool' });
  }
  const result = await runPlan(tool, args, { runTool: deps.runTool });
  let settlement = null;
  if (g.settle) {
    try { settlement = await g.settle(); } catch (e) { settlement = null; }
    if (!settlement || !settlement.success) return { paymentRequired: await g.settlementFailurePaymentRequired((settlement && (settlement.errorMessage || settlement.errorReason)) || 'Settlement failed'), tool };
  }
  return { result, signature: deps.sign ? deps.sign(tool.name, args, result) : null, settlement, tool };
}

// Hourly: disables tools failing more than 25% of at least 5 calls.
export async function autoDisableFoundryTools({ supUrl, supKey, store, fetchImpl = globalThis.fetch, now = Date.now(), notify }) {
  const since = new Date(now - 3600000).toISOString();
  const res = await fetchImpl(`${supUrl}/rest/v1/agent_telemetry?select=tool_name,status&event_type=eq.tool_call&tool_name=like.ft_*&created_at=gte.${encodeURIComponent(since)}&limit=20000`, { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } });
  if (!res.ok) return [];
  const rows = await res.json();
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isFoundryToolName(r.tool_name)) continue;
    const m = by.get(r.tool_name) || { ok: 0, failed: 0 };
    if (r.status === 'ok') m.ok++;
    else if (['upstream_error', 'tool_error', 'server_error', 'settlement_failed'].includes(r.status)) m.failed++;
    by.set(r.tool_name, m);
  }
  const disabled = [];
  for (const [name, m] of by) {
    const calls = m.ok + m.failed;
    if (calls < AUTO_DISABLE_MIN_CALLS || m.failed / calls <= AUTO_DISABLE_ERROR_RATE) continue;
    const tool = await store.getToolByName(name);
    if (!tool || tool.status !== 'active') continue;
    await store.updateTool(tool.id, { status: 'disabled', disabled_reason: `error rate ${Math.round((m.failed / calls) * 100)}% over the last hour` });
    disabled.push(name);
    if (notify) await notify({ supUrl, supKey, route: '/foundry', reason: 'foundry_tool_disabled', message: `${name} was disabled: ${m.failed} of ${calls} calls failed in the last hour. /foundry enable ${name} turns it back on.` });
  }
  __clearFoundryToolCache();
  return disabled;
}
