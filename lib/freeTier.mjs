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
// TRADEOFF: the increment below is read-then-write, not atomic (no Postgres
// function/RPC backing it). A burst of concurrent requests from the same
// identifier could race past the limit by a request or two before the count
// catches up. That's an acceptable cost for a soft 5/day free tier and it
// avoids requiring a DB function on top of the table; swap in a Postgres RPC
// (e.g. `rpc/increment_free_tier_usage`) if exact enforcement ever matters.

export const FREE_TIER_DAILY_LIMIT = 5;

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
export async function checkAndConsumeFreeTier(supUrl, supKey, identifier) {
  if (!supUrl || !supKey) {
    return { allowed: false, reason: 'not_configured' };
  }

  var usageDate = new Date().toISOString().slice(0, 10);
  var filter = `identifier=eq.${encodeURIComponent(identifier)}&usage_date=eq.${usageDate}`;

  try {
    var getRes = await fetch(`${supUrl}/rest/v1/free_tier_usage?${filter}&select=request_count`, {
      headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }
    });
    var rows = getRes.ok ? await getRes.json() : [];
    var currentCount = rows.length ? rows[0].request_count : 0;

    if (currentCount >= FREE_TIER_DAILY_LIMIT) {
      return { allowed: false, reason: 'limit_exceeded' };
    }

    if (rows.length) {
      await fetch(`${supUrl}/rest/v1/free_tier_usage?${filter}`, {
        method: 'PATCH',
        headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ request_count: currentCount + 1 })
      });
    } else {
      await fetch(`${supUrl}/rest/v1/free_tier_usage`, {
        method: 'POST',
        headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ identifier: identifier, usage_date: usageDate, request_count: 1 })
      });
    }

    return { allowed: true, remaining: FREE_TIER_DAILY_LIMIT - (currentCount + 1) };
  } catch (e) {
    return { allowed: false, reason: 'error: ' + e.message };
  }
}

// Single greppable line per request that reaches the payment-check step.
// outcome is one of: free_tier | no_payment | rejected | success
export function logSettlementOutcome(endpoint, outcome, identifier, detail) {
  console.log('[X402_SETTLEMENT] outcome=%s endpoint=%s identifier=%s detail=%s', outcome, endpoint, identifier, detail || '');
}
