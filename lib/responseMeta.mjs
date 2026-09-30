// Shared helpers for the "honest status" additions to every MCP tool / A2A
// skill response (issue #215): `checks` entries and the `status` they imply.
// Kept separate from lib/reasonCodes.mjs (the frozen code list) since these
// are plain computation helpers, not part of the permanent code list.

// One entry in a response's `checks` array. `source` is always a generic
// label (e.g. "sanctions list", "domain registration records") - never a
// vendor/provider name. `dataAsOf` is the timestamp the underlying data
// itself was last refreshed (or null when that's not applicable/known),
// distinct from `checkedAt` (when THIS request looked at it).
export function buildCheck(source, result, { checkedAt, dataAsOf } = {}) {
  return {
    source,
    result,
    checked_at: checkedAt || new Date().toISOString(),
    data_as_of: dataAsOf || null
  };
}

// status is derived, never set by hand, so it can't drift from the
// reasons/checks that justify it:
//   - any non-empty `reasons` means something was flagged, full stop.
//   - otherwise, any check that didn't cleanly complete ("ok") means the
//     answer is incomplete - never reported as a clean "no_flags".
//   - only when reasons is empty AND every check completed is it "no_flags".
export function computeStatus(reasons, checks) {
  if (reasons && reasons.length > 0) return 'flagged';
  if (checks && checks.some((c) => c.result !== 'ok')) return 'unknown';
  return 'no_flags';
}

// Merges reasons/checks/request_id onto a tool result object. Additive only:
// never overwrites an existing field the tool already returns.
export function withResponseMeta(result, { reasons, checks, requestId }) {
  return {
    ...result,
    reasons,
    status: computeStatus(reasons, checks),
    checks,
    request_id: requestId
  };
}

// Classifies an mcpToolError for its single implied `checks` entry: a
// genuine upstream outage/timeout means the check errored or timed out;
// anything else (invalid input, rate limiting) means the check was never
// attempted at all.
export function classifyToolErrorCheckResult(toolErr) {
  const isUpstreamFailure = !!toolErr.serviceUnavailable || toolErr.code === 'upstream_unavailable';
  if (!isUpstreamFailure) return 'skipped';
  return /timed out/i.test(toolErr.message || '') ? 'timeout' : 'error';
}

// Builds the { reasons: [], status: 'unknown', checks, request_id } block
// added to an isError tool result - an error response never has anything
// "flagged" (nothing completed), so reasons is always empty and status is
// always 'unknown'.
export function errorResponseMeta(checks, requestId) {
  return { reasons: [], status: 'unknown', checks, request_id: requestId };
}
