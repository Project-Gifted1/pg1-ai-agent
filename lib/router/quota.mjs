// What a 429 really says, and a cool-down per engine and model, so a quota
// that will not reset for hours is skipped at once instead of waited for.
//
// Production, 19-20 Oct: the free Gemini key answered 429 on almost every
// chat request, minutes apart (a daily quota, not the per-minute one), and
// each request still waited ~19 s before the next engine; Groq answered
// "Rate limit reached for model openai/gpt-oss-20b ... tokens per minute
// (TPM): Limit 8000, Used 3769, Requested 4525".
//
//   classify429({ provider, status, text, headers, now })
//     -> { scope, metric, limit, used, requested, retryAfterMs, resetAt }
//     scope  'minute'     a per-minute rate (RPM or TPM): worth a short wait
//            'day'        a daily quota (RPD or TPD): skip until resetAt
//            'spend_cap'  the account's monthly spending cap
//            'credit'     out of credit
//            null         the engine did not say
//   Reads Gemini's QuotaFailure quotaId and RetryInfo (error.details),
//   Groq's "on tokens per minute (TPM): Limit .., Used .., Requested ..
//   Please try again in 1.9s" and the x-ratelimit-* / Retry-After headers.
//
//   coolDown / coolingUntil / isCooling / cooldownRows
//     A day's quota cools the engine+model until its reset (Google's free
//     tier at midnight Pacific, the others at midnight UTC); a per-minute
//     limit with a long retry hint cools it for that hint. A cooled model is
//     skipped by the chat round and by background work with no request.
//     Per instance; the shared limiter (lib/router/freeLimiter.mjs) counts
//     the tokens across instances.
//
//   noteRateHeaders(provider, headers) keeps what an engine's headers say
//   about its limits (limit and remaining requests and tokens, and when they
//   reset), for the limiter and /keys.

import { quotaScope, geminiQuotaInfo, isBillingFailure, isSpendCapFailure, retryAfterMs as hintFrom, nextDailyResetMs, onRouterReset } from '../aiRouter.mjs';

// "2m59.56s", "7.66s", "1h2m", "450ms" -> ms.
export function parseDuration(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  if (/^\d+(?:\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  let ms = 0;
  let hit = false;
  for (const [, n, u] of t.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
    hit = true;
    const unit = u.toLowerCase();
    ms += Number(n) * (unit === 'ms' ? 1 : unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 1000);
  }
  return hit ? Math.round(ms) : null;
}

const GROQ_RE = /on\s+(tokens|requests)\s+per\s+(minute|day)\s*\((TPM|RPM|TPD|RPD)\)\s*:\s*Limit\s+(\d+),\s*Used\s+(\d+),\s*Requested\s+(\d+)/i;

function header(headers, name) {
  try { return headers && typeof headers.get === 'function' ? headers.get(name) : headers ? headers[name] : null; } catch (e) { return null; }
}

export function classify429({ provider = '', status = 429, text = '', headers = null, now = Date.now() } = {}) {
  const t = String(text || '');
  if (isSpendCapFailure(status, t)) return { scope: 'spend_cap', metric: null, limit: null, used: null, requested: null, retryAfterMs: null, resetAt: null };
  if (status !== 429 && isBillingFailure(status, t)) return { scope: 'credit', metric: null, limit: null, used: null, requested: null, retryAfterMs: null, resetAt: null };
  const out = { scope: null, metric: null, limit: null, used: null, requested: null, retryAfterMs: null, resetAt: null };
  const g = GROQ_RE.exec(t);
  if (g) {
    out.metric = g[3].toUpperCase();
    out.scope = /day/i.test(g[2]) ? 'day' : 'minute';
    out.limit = Number(g[4]);
    out.used = Number(g[5]);
    out.requested = Number(g[6]);
  } else if (/gemini/.test(provider) || /"status"\s*:\s*"RESOURCE_EXHAUSTED"|google\.rpc/i.test(t)) {
    const info = geminiQuotaInfo(t);
    out.scope = info.scope;
    if (Number.isFinite(info.retryAfterMs)) out.retryAfterMs = info.retryAfterMs;
    const m = /(?:quotaId|quota_id)"?\s*:\s*"([^"]+)"/.exec(t);
    if (m) out.metric = m[1];
    const v = /"quotaValue"\s*:\s*"(\d+)"/.exec(t);
    if (v) out.limit = Number(v[1]);
  } else {
    out.scope = quotaScope(t);
  }
  if (out.retryAfterMs == null) {
    const h = hintFrom({ headers, text: t, now });
    if (Number.isFinite(h)) out.retryAfterMs = h;
  }
  // Groq: the token and request windows reset on their own clocks.
  const resetTokens = parseDuration(header(headers, 'x-ratelimit-reset-tokens'));
  const resetRequests = parseDuration(header(headers, 'x-ratelimit-reset-requests'));
  if (out.retryAfterMs == null && Number.isFinite(resetTokens) && /TP/.test(out.metric || '')) out.retryAfterMs = resetTokens;
  if (out.retryAfterMs == null && Number.isFinite(resetRequests) && /RP/.test(out.metric || '')) out.retryAfterMs = resetRequests;
  // A request larger than the whole per-minute budget never fits: as good
  // as a day for this request (wait would not help).
  if (out.scope === 'minute' && out.limit && out.requested && out.requested > out.limit) out.oversize = true;
  if (out.scope === 'day') out.resetAt = provider === 'gemini_free' || provider === 'gemini_paid' ? nextDailyResetMs(now) : Number.isFinite(out.retryAfterMs) && out.retryAfterMs > 60000 ? now + out.retryAfterMs : nextUtcMidnight(now);
  else if (Number.isFinite(out.retryAfterMs)) out.resetAt = now + out.retryAfterMs;
  return out;
}

function nextUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

// --- cool-downs per engine and model -------------------------------------------------------

const cooling = new Map(); // `${provider}|${model}` -> { until, scope, reason, at }
const learned = new Map(); // provider -> { limitRequests, remainingRequests, limitTokens, remainingTokens, resetRequestsAt, resetTokensAt, at }

export function __resetQuota() { cooling.clear(); learned.clear(); }
onRouterReset(__resetQuota);

// Waits shorter than this are left to the throttle; longer ones cool.
export const COOL_MIN_MS = 5000;

// Cools one engine+model ('*': the whole engine) for what the 429 says.
// Returns the cool-down or null when there is nothing to cool.
export function coolDown(provider, model, info, now = Date.now()) {
  if (!provider || !info) return null;
  let until = null;
  if (info.scope === 'day' || info.scope === 'spend_cap' || info.scope === 'credit') until = info.resetAt || nextUtcMidnight(now);
  else if (info.oversize) until = now + 60000;
  else if (info.scope === 'minute' || info.scope == null) {
    if (Number.isFinite(info.retryAfterMs) && info.retryAfterMs > COOL_MIN_MS) until = now + info.retryAfterMs;
  }
  if (!until) return null;
  const key = `${provider}|${model || '*'}`;
  const cur = cooling.get(key);
  const row = { until: Math.max(until, cur ? cur.until : 0), scope: info.scope || 'minute', metric: info.metric || null, at: now };
  cooling.set(key, row);
  return row;
}

export function coolingUntil(provider, model = '*', now = Date.now()) {
  let best = 0;
  for (const k of [`${provider}|*`, `${provider}|${model || '*'}`]) {
    const c = cooling.get(k);
    if (!c) continue;
    if (now >= c.until) { cooling.delete(k); continue; }
    best = Math.max(best, c.until);
  }
  return best;
}

export function isCooling(provider, model = '*', now = Date.now()) {
  return coolingUntil(provider, model, now) > now;
}

// The models of a list that are not cooling, in order.
export function readyModels(provider, models, now = Date.now()) {
  return (models || []).filter((m) => !isCooling(provider, Array.isArray(m) ? m[0] : m, now));
}

// What the engine's headers say about its limits (Groq, OpenRouter,
// GitHub Models and others use x-ratelimit-*).
export function noteRateHeaders(provider, headers, now = Date.now()) {
  const n = (name) => { const v = Number(header(headers, name)); return Number.isFinite(v) && String(header(headers, name)).trim() !== '' ? v : null; };
  const row = {
    limitRequests: n('x-ratelimit-limit-requests'), remainingRequests: n('x-ratelimit-remaining-requests'),
    limitTokens: n('x-ratelimit-limit-tokens'), remainingTokens: n('x-ratelimit-remaining-tokens')
  };
  if (Object.values(row).every((v) => v == null)) return null;
  const rr = parseDuration(header(headers, 'x-ratelimit-reset-requests'));
  const rt = parseDuration(header(headers, 'x-ratelimit-reset-tokens'));
  const out = { ...(learned.get(provider) || {}), ...Object.fromEntries(Object.entries(row).filter(([, v]) => v != null)), at: now };
  if (Number.isFinite(rr)) out.resetRequestsAt = now + rr;
  if (Number.isFinite(rt)) out.resetTokensAt = now + rt;
  learned.set(provider, out);
  return out;
}

export function learnedLimits(provider) {
  return learned.get(provider) || null;
}

// For /keys and /usage: every engine that is cooling or has learned limits.
// [{ engine, state, model, remaining, resetAt }]
export const QUOTA_STATES = Object.freeze({ OK: 'ok', MINUTE: 'per-minute limited', DAY: 'daily quota used', SPEND_CAP: 'spend cap', CREDIT: 'out of credit' });
export function cooldownRows(now = Date.now()) {
  const rows = [];
  for (const [k, c] of cooling) {
    if (now >= c.until) continue;
    const [engine, model] = k.split('|');
    rows.push({ engine, model: model === '*' ? null : model, state: c.scope === 'day' ? QUOTA_STATES.DAY : c.scope === 'spend_cap' ? QUOTA_STATES.SPEND_CAP : c.scope === 'credit' ? QUOTA_STATES.CREDIT : QUOTA_STATES.MINUTE, resetAt: c.until, metric: c.metric });
  }
  return rows;
}
