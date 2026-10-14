// Shared free-tier rate limiting + settlement outcome logging for the paid
// endpoints (api/mcp.mjs's tools/call, api/chat.mjs's /api/ioc). Both files
// are otherwise self-contained (mcp.mjs deliberately doesn't import from
// chat.mjs), but this module has no dependency on either of them, so
// importing it from both doesn't reintroduce that coupling.
//
// STORAGE CHOICE: Supabase (already a dependency, already used by both files
// for threat_ioc_telemetry/api_access_logs via its REST/PostgREST API) - not
// Vercel KV. Vercel serverless functions don't share memory across
// invocations, so an in-memory counter resets on every cold start and often
// differs between concurrently warm instances; it needed a real datastore.
// Supabase avoids adding a new provider/dependency/env-var set just for this.
//
// Requires this table to exist in Supabase (run once, not created by this
// code - PostgREST has no DDL endpoint):
//
//   create table free_tier_usage (
//     identifier text not null,
//     usage_date date not null,
//     request_count int not null default 1,
//     primary key (identifier, usage_date)
//   );
//
// PRIVACY: `identifier` is never the caller's IP. It is freeTierKey(ip): the
// salted HMAC-SHA256 that lib/telemetry.mjs callerHash computes (salt
// TELEMETRY_IP_SALT), 32 hex characters. With no salt or no IP there is no
// key, and so no free tier (fails closed), never a raw IP. The
// 20261016120000_free_tier_usage_hashed migration clears the old raw-IP rows
// and makes the table accept only hashes; rows older than
// FREE_TIER_RETENTION_DAYS are deleted daily by the /api/errors/cleanup cron
// (purgeExpiredFreeTierUsage). The raw IP still keys the in-memory rate
// limiters, which are never written anywhere.
//
// TRADEOFF: the increment below is read-then-write, not atomic (no Postgres
// function/RPC backing it). A burst of concurrent requests from the same
// identifier could race past the limit by a request or two before the count
// catches up. That's an acceptable cost for a soft 5/day free tier and it
// avoids requiring a DB function on top of the table; swap in a Postgres RPC
// (e.g. `rpc/increment_free_tier_usage`) if exact enforcement ever matters.

import { FREE_TIER_SKIP_USER_AGENTS } from '../config/usageProbes.mjs';
import { callerHash } from './telemetry.mjs';
import { getSupabaseCreds } from './supabase.mjs';

export const FREE_TIER_DAILY_LIMIT = 5;

// WHO GETS THE FREE TIER (Phase 2). Every paid route (/api/mcp tools/call,
// /api/a2a paid skills, GET/POST /api/ioc, /api/ioc/context) spends this one
// counter, keyed by getRequestIdentifier (below), BEFORE any payment
// challenge: a new caller gets FREE_TIER_DAILY_LIMIT free paid calls a day,
// then the 402. It used to be opt-in ("X-Free-Tier: 1", 1.9.2), which no
// browser and almost no MCP client sends, so callers went straight to the
// 402. Skipped only when the caller:
//   - offers a payment (x402 header or MCP/A2A payment metadata): a payer is
//     always verified and charged, never served free (1.9.1);
//   - sends a licence key (checked first, never counted);
//   - opts out with "X-Free-Tier: 0" (also false/no/off): a discovery
//     crawler or a client that wants the 402 challenge straight away;
//   - identifies as an x402 scanner, crawler or bot in its User-Agent
//     (config/usageProbes.mjs FREE_TIER_SKIP_USER_AGENTS), so discovery
//     scanners still see the 402 they list a paid resource by. A scanner
//     that sends neither gets its 5 free calls, then the 402.
// HEAD requests never spend it.
export const FREE_TIER_HEADER = 'x-free-tier';

const headerOf = (headers, name) => {
  if (!headers) return undefined;
  const v = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const SKIP_UA_WORDS = FREE_TIER_SKIP_USER_AGENTS.map((w) => w.toLowerCase());
// Generic words also match as a word ending: "Googlebot", "UptimeRobot".
const SUFFIX_WORDS = new Set(['bot', 'crawler', 'spider', 'scanner']);

// True when a User-Agent word is (or, for the generic words, ends with)
// one of FREE_TIER_SKIP_USER_AGENTS. A browser's "Mozilla/5.0 ... Chrome"
// and plain HTTP clients ("node", "curl/8.5", "python-httpx") never match.
export function isFreeTierSkippedUserAgent(userAgent) {
  const text = String(userAgent || '').toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  const joined = ` ${words.join(' ')} `;
  return SKIP_UA_WORDS.some((skip) => skip.includes('-')
    ? joined.includes(` ${skip.replace(/-/g, ' ')} `)
    : words.some((word) => word === skip || (SUFFIX_WORDS.has(skip) && word.endsWith(skip))));
}

// Whether this request may spend the automatic free tier at all (before the
// counter is checked): not opted out and not a scanner. Payment and licence
// checks are the route's own.
export function freeTierWanted(headers) {
  return !freeTierOptedOut(headerOf(headers, FREE_TIER_HEADER)) && !isFreeTierSkippedUserAgent(headerOf(headers, 'user-agent'));
}

export function freeTierOptedOut(value) {
  const v = String(Array.isArray(value) ? value[0] : value ?? '').trim().toLowerCase();
  return ['0', 'false', 'no', 'off'].includes(v);
}

// Tells the caller where it stands on every response the free tier served
// or refused (never on licence or paid responses).
export function setFreeTierHeaders(res, remaining) {
  try {
    res.setHeader('X-Free-Tier-Limit', String(FREE_TIER_DAILY_LIMIT));
    res.setHeader('X-Free-Tier-Remaining', String(Math.max(0, remaining)));
  } catch (e) {
    // Best-effort; headers may already be sent.
  }
}

// Days a free_tier_usage row is kept. Only today's row is ever read; the
// rest are kept a week for abuse review, then deleted.
export const FREE_TIER_RETENTION_DAYS = 7;

// The free_tier_usage key for a caller IP: callerHash (salted HMAC, 32 hex)
// or null (no IP, or no salt configured).
export function freeTierKey(ip) {
  return callerHash(ip);
}

export function getRequestIdentifier(req) {
  var forwardedFor = req.headers.get ? req.headers.get('x-forwarded-for') : req.headers['x-forwarded-for'];
  if (forwardedFor) {
    var first = String(forwardedFor).split(',')[0].trim();
    if (first) return first;
  }
  var remoteAddr = req.socket && req.socket.remoteAddress;
  return remoteAddr || 'unknown';
}

// Fails CLOSED: if Supabase isn't configured or is unreachable, no free
// request is granted - the caller falls through to the existing
// payment-required path instead of silently giving unlimited free access
// during an outage.
//
// Split from the actual increment (see consumeFreeTier below): a caller must
// check availability, then run the request the quota gates, and only spend
// one of the 5/day once that request actually succeeded - a failed lookup
// (upstream timeout, 5xx, etc.) must not burn a free-tier call for nothing.
export async function checkFreeTierAvailable(supUrl, supKey, identifier) {
  if (!supUrl || !supKey) {
    return { allowed: false, reason: 'not_configured' };
  }
  var key = freeTierKey(identifier);
  if (!key) {
    return { allowed: false, reason: 'no_identifier' };
  }

  var usageDate = new Date().toISOString().slice(0, 10);
  var filter = `identifier=eq.${key}&usage_date=eq.${usageDate}`;

  try {
    var getRes = await fetch(`${supUrl}/rest/v1/free_tier_usage?${filter}&select=request_count`, {
      headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }
    });
    var rows = getRes.ok ? await getRes.json() : [];
    var currentCount = rows.length ? rows[0].request_count : 0;

    if (currentCount >= FREE_TIER_DAILY_LIMIT) {
      return { allowed: false, reason: 'limit_exceeded' };
    }

    return {
      allowed: true,
      remaining: FREE_TIER_DAILY_LIMIT - (currentCount + 1),
      rowExists: rows.length > 0,
      currentCount: currentCount,
      key: key,
      usageDate: usageDate,
      filter: filter
    };
  } catch (e) {
    return { allowed: false, reason: 'error: ' + e.message };
  }
}

// Call only once the request gated by `availability` (from
// checkFreeTierAvailable, above) has actually succeeded. Best-effort: an
// increment failure here just means the free tier ends up slightly more
// generous than 5/day, not that the caller's already-served request fails.
// `identifier` is unused (kept for the callers' signature): the row is keyed
// by availability.key, the hash checkFreeTierAvailable computed.
export async function consumeFreeTier(supUrl, supKey, identifier, availability) {
  try {
    if (availability.rowExists) {
      await fetch(`${supUrl}/rest/v1/free_tier_usage?${availability.filter}`, {
        method: 'PATCH',
        headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ request_count: availability.currentCount + 1 })
      });
    } else {
      await fetch(`${supUrl}/rest/v1/free_tier_usage`, {
        method: 'POST',
        headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ identifier: availability.key, usage_date: availability.usageDate, request_count: 1 })
      });
    }
  } catch (e) {
    // Best-effort, see comment above.
  }
}

// Single greppable line per request that reaches the payment-check step.
// outcome is one of: free_tier | no_payment | rejected | success
// The caller appears only as the first 12 characters of its hash; the IP
// itself never reaches the logs.
export function logSettlementOutcome(endpoint, outcome, identifier, detail) {
  var key = freeTierKey(identifier);
  console.log('[X402_SETTLEMENT] outcome=%s endpoint=%s caller=%s detail=%s', outcome, endpoint, key ? key.slice(0, 12) : '-', detail || '');
}

// Deletes free_tier_usage rows older than FREE_TIER_RETENTION_DAYS. Awaited
// by the daily cleanup cron; resolves to { ok, cutoff, status? }, never
// throws.
export async function purgeExpiredFreeTierUsage({ now = Date.now(), fetchImpl = fetch } = {}) {
  var cutoff = new Date(now - FREE_TIER_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    var creds = getSupabaseCreds();
    var res = await fetchImpl(`${creds.supUrl}/rest/v1/free_tier_usage?usage_date=lt.${cutoff}`, {
      method: 'DELETE',
      headers: { apikey: creds.supKey, Authorization: `Bearer ${creds.supKey}`, Prefer: 'return=minimal' }
    });
    return res && res.ok ? { ok: true, cutoff: cutoff } : { ok: false, cutoff: cutoff, status: res ? res.status : null };
  } catch (e) {
    return { ok: false, cutoff: cutoff };
  }
}
