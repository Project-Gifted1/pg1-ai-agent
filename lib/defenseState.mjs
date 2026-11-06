// PG1 City: PG1's real current state, for its tower and guardians
// (/api/defense-feed's `state`, on full loads only, cached a minute).
//
//   tower.beacon   'gold'    the latest production deploy is Ready
//                  'amber'   auto-merge is paused or production is pinned
//                  'dim'     the latest production deploy failed (shown, not hidden)
//                  'unknown' the deploy state could not be read
//   checks_live    how many tools PG1's MCP server lists right now (tools/list):
//                  one sentinel drone each
//   seal           SealKeeper SEAL tier as it really stands (SEAL_TIER_RECORD,
//                  or PG1_SEALKEEPER_TIER when set); null when unknown
//   passkeys       whether an operator passkey exists (the vault only shows then)
//   signing        whether results are signed (the Ed25519 seal emblem)
//   approvals_waiting   how many approvals wait for Gift (one beacon each)
//
// Read-only; every source that cannot be read is null, never guessed.

import { gatherHomeContext } from './homeContext.mjs';
import { signingStatus } from './signing.mjs';

// The SEAL tier PG1 holds on SealKeeper, as recorded by the operator. It
// changes only when the real tier changes: by a reviewed edit here, or by
// PG1_SEALKEEPER_TIER on the deployment.
export const SEAL_TIERS = Object.freeze(['bronze', 'silver', 'gold', 'platinum']);
export const SEAL_TIER_RECORD = Object.freeze({ tier: 'bronze', as_of: '2026-11-05', source: 'SealKeeper listing for pg1-ai-agent.vercel.app' });

export function sealTier(env = process.env) {
  const v = String(env.PG1_SEALKEEPER_TIER || '').trim().toLowerCase();
  if (v === 'none') return null;
  if (SEAL_TIERS.includes(v)) return { tier: v, source: 'PG1_SEALKEEPER_TIER' };
  return SEAL_TIER_RECORD.tier ? { tier: SEAL_TIER_RECORD.tier, source: SEAL_TIER_RECORD.source, as_of: SEAL_TIER_RECORD.as_of } : null;
}

export function towerBeacon(signals) {
  const s = signals || {};
  if (s.deploy && s.deploy.failed) return { beacon: 'dim', reason: 'deploy_failed' };
  const am = s.auto_merge || {};
  if (am.production_pinned) return { beacon: 'amber', reason: 'production_pinned' };
  if (am.state === 'paused') return { beacon: 'amber', reason: 'auto_merge_paused' };
  if (s.deploy && String(s.deploy.state).toUpperCase() === 'READY') return { beacon: 'gold', reason: 'production_ready' };
  return { beacon: 'unknown', reason: s.deploy ? 'deploy_not_ready' : 'deploy_unread' };
}

async function liveToolCount(env) {
  try {
    const mcp = await import('../api/mcp.mjs');
    return mcp.listedTools(env).length;
  } catch (e) { return null; }
}

async function hasPasskey({ supUrl, supKey, fetchImpl }) {
  if (!supUrl || !supKey) return null;
  try {
    const res = await fetchImpl(`${supUrl}/rest/v1/pg1_operator_passkeys?select=id&limit=1`, { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } });
    if (!res || !res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows.length > 0 : null;
  } catch (e) { return null; }
}

// deps (tests): { home: () => signals, tools: () => n, passkeys: () => bool }
export async function buildDefenseState({ supUrl = null, supKey = null, fetchImpl = globalThis.fetch, env = process.env, now = Date.now(), deps = {} } = {}) {
  const safe = async (fn, fallback = null) => { try { return await fn(); } catch (e) { return fallback; } };
  const [signals, tools, passkeys] = await Promise.all([
    safe(() => (deps.home || (() => gatherHomeContext({ env, supUrl, supKey, fetchImpl, now })))()),
    safe(() => (deps.tools || (() => liveToolCount(env)))()),
    safe(() => (deps.passkeys || (() => hasPasskey({ supUrl, supKey, fetchImpl })))())
  ]);
  const beacon = towerBeacon(signals);
  const approvals = signals && signals.approvals && Number.isFinite(signals.approvals.total) ? signals.approvals.total : null;
  return {
    tower: { ...beacon, deploy_state: signals && signals.deploy ? String(signals.deploy.state || '').slice(0, 20) : null },
    checks_live: Number.isFinite(tools) ? tools : null,
    seal: sealTier(env),
    passkeys: typeof passkeys === 'boolean' ? passkeys : null,
    signing: !!signingStatus(env).enabled,
    approvals_waiting: approvals,
    // Registry and directory listings: reserved until PG1 records them.
    listings: []
  };
}
