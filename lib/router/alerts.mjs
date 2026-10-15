// Capacity alerts for the operator: when an engine is out of credit or
// quota, rate limited, down or has no usable key, PG1 pushes one
// notification per engine per hour to the operator's devices, naming the
// engine (operator-only, so provider names are allowed here and nowhere
// else) and what took over.
//
// Once per engine per hour across every Vercel function and render worker:
// the claim is one row per engine in pg1_router_alerts, taken by the
// pg1_router_alert_claim RPC (supabase/migrations/20261030120000_pg1_director.sql).
// Without the table (migration not applied) or the database, the claim is
// kept per process instead, so an alert is never lost and never repeated
// within the hour by the same process.

import { pushToOperator, vapidKeys } from '../watches/push.mjs';

export const ALERT_WINDOW_MS = 60 * 60 * 1000;
export const ALERT_RPC = 'pg1_router_alert_claim';

// The operator-facing engine names (alerts only).
export const ENGINE_NAMES = Object.freeze({
  anthropic: 'Anthropic (Claude)', gemini_paid: 'Gemini (paid key)', gemini_free: 'Gemini (free key)', openrouter: 'OpenRouter',
  gateway: 'the AI gateway', openai: 'OpenAI', replicate: 'Replicate', cartesia: 'Cartesia', elevenlabs: 'ElevenLabs'
});

const KIND_WORDS = Object.freeze({
  billing: 'is out of credit', throttled: 'is rate limited', timeout: 'timed out', not_configured: 'has no usable key',
  budget: "is over today's budget", engine: 'is failing'
});

export function alertText({ engine, kind, status = null, what = '', next = null }) {
  const name = ENGINE_NAMES[engine] || engine;
  const k = kind && KIND_WORDS[kind] ? kind : status === 429 ? 'throttled' : status === 402 ? 'billing' : status == null ? 'timeout' : status === 401 || status === 403 ? 'not_configured' : 'engine';
  const after = next ? `${what || 'calls'} moved to ${ENGINE_NAMES[next] || next}` : `no engine left for ${what || 'this step'}`;
  return { title: `${name} ${KIND_WORDS[k]}`, body: `PG1 router: ${name} ${KIND_WORDS[k]}${status ? ` (${status})` : ''}; ${after}.`, kind: k };
}

const localClaims = new Map();
export function __resetAlerts() { localClaims.clear(); }

function claimLocally(engine, now, windowMs) {
  const last = localClaims.get(engine);
  if (last != null && now - last < windowMs) return false;
  localClaims.set(engine, now);
  return true;
}

// Whether this process may send the alert for `engine` now.
export async function claimAlert({ engine, supUrl = '', supKey = '', fetchImpl = globalThis.fetch, now = Date.now(), windowMs = ALERT_WINDOW_MS }) {
  if (supUrl && supKey) {
    try {
      const res = await fetchImpl(`${supUrl}/rest/v1/rpc/${ALERT_RPC}`, {
        method: 'POST',
        headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_engine: engine, p_window_s: Math.round(windowMs / 1000) })
      });
      if (res.ok) {
        const v = await res.json().catch(() => null);
        const claimed = Array.isArray(v) ? (v[0] && (v[0].claimed ?? v[0][ALERT_RPC])) : v;
        localClaims.set(engine, now);
        return claimed === true;
      }
    } catch (e) { /* the database is unreachable: claim locally */ }
  }
  return claimLocally(engine, now, windowMs);
}

// The alert hook for runChain (onCapacity) and the film engines. `store` is
// the push subscription store (lib/watches/store.mjs createWatchStore).
// Resolves to { sent, claimed }. Never throws.
export function createCapacityAlerts({ env = {}, store = null, supUrl = '', supKey = '', fetchImpl = globalThis.fetch, push = pushToOperator, now = () => Date.now(), log = () => {} } = {}) {
  return async function alert({ engine, kind = null, status = null, what = '', next = null }) {
    try {
      // No push keys: nothing can be delivered, so the alert is only logged,
      // once per process per hour, and the database is not asked.
      const canPush = !!(store && vapidKeys(env));
      const claimed = canPush ? await claimAlert({ engine, supUrl, supKey, fetchImpl, now: now() }) : claimLocally(engine, now(), ALERT_WINDOW_MS);
      if (!claimed) return { sent: 0, claimed: false };
      const t = alertText({ engine, kind, status, what, next });
      log(`[router] alert: ${t.body}`);
      const sent = canPush ? await push({ store, env, title: t.title, body: t.body, url: '/', tag: `pg1-router-${engine}`, providerNames: true }) : 0;
      return { sent, claimed: true };
    } catch (e) {
      return { sent: 0, claimed: false };
    }
  };
}
