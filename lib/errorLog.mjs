// Reusable server-side error logging helper (issue #201 Phase 2b).
//
// Writes unexpected 4xx/5xx responses from api/ routes into the Supabase
// pg1_errors table (see supabase/migrations/*_pg1_errors.sql), grouped by
// (source, route, status, reason) so a repeated failure bumps `count` and
// `last_seen` instead of spawning a new row every time. This is a plain
// read-then-write over PostgREST, not an atomic upsert (no DB function) -
// same accepted tradeoff as lib/freeTier.mjs's free_tier_usage counter: a
// burst of identical concurrent failures could race into two rows instead
// of one, which is fine for a human-reviewed error log.
//
// NEVER pass secrets, API keys or user message/prompt content as `message`
// here - callers should only ever pass short, fixed, human-written reason
// strings (see call sites in api/chat.mjs), never raw request bodies or
// unsanitized exception text that might echo a credential.
//
// Excluded by design (callers should never call this for these): 402
// paywall responses (expected, not errors), and the silent voice-profile
// fallback in api/chat.mjs (that IS the fix for an error, not one). Both
// already just don't call this function - there is nothing to filter here.

const MAX_MESSAGE_LEN = 300;
const MAX_REASON_LEN = 120;

function buildFilter(source, route, status, reason) {
  const parts = [
    `source=eq.${encodeURIComponent(source)}`,
    `route=eq.${encodeURIComponent(route)}`,
    'resolved=eq.false',
    status == null ? 'status=is.null' : `status=eq.${encodeURIComponent(status)}`,
    reason == null ? 'reason=is.null' : `reason=eq.${encodeURIComponent(reason)}`
  ];
  return parts.join('&');
}

// Best-effort, fire-and-forget by design (callers do `.catch(() => {})` and
// never await this on the request's hot path) - a logging failure must
// never affect the response already being sent to the caller.
export async function logApiError(supUrl, supKey, { source, route, status, reason, message }) {
  if (!supUrl || !supKey) return;
  if (status === 402) return; // paywall responses are expected, not errors

  const headers = { apikey: supKey, Authorization: `Bearer ${supKey}` };
  const cleanReason = reason ? String(reason).slice(0, MAX_REASON_LEN) : null;
  const cleanMessage = message ? String(message).slice(0, MAX_MESSAGE_LEN) : null;
  const now = new Date().toISOString();

  try {
    const filter = buildFilter(source, route, status, cleanReason);
    const getRes = await fetch(`${supUrl}/rest/v1/pg1_errors?${filter}&select=id,count`, { headers });
    const rows = getRes.ok ? await getRes.json() : [];

    if (Array.isArray(rows) && rows.length > 0) {
      await fetch(`${supUrl}/rest/v1/pg1_errors?id=eq.${rows[0].id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ count: rows[0].count + 1, last_seen: now, time: now, message: cleanMessage })
      });
    } else {
      await fetch(`${supUrl}/rest/v1/pg1_errors`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          source, route, status: status == null ? null : status, reason: cleanReason,
          message: cleanMessage, count: 1, first_seen: now, last_seen: now, time: now, resolved: false
        })
      });
    }
  } catch (e) {
    // Best-effort - see module comment.
  }
}
