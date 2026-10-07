// Frozen list of machine-readable reason codes (issue #215, buyer-experience
// upgrade part A). Every MCP tool and A2A skill response attaches a
// `reasons: [{ code, message }]` array built ONLY from codes in this file -
// never an ad-hoc string. Codes are permanent: once shipped, a code is never
// removed or renamed (see tests/reason-codes.test.mjs), only added to.
//
// Each code maps to logic/thresholds that already exist elsewhere in the
// codebase (e.g. DOMAIN_NEWLY_REGISTERED_30D mirrors the `age_days < 30`
// check in api/mcp.mjs's handleCheckDomainAge) - this file does not invent
// new risk judgements. check_wallet_age has no age threshold anywhere in the
// code (callers choose their own), so its codes describe observed facts
// only (no history found; a partial/incomplete lookup; an EIP-7702
// delegation currently set), never an age or risk judgement. check_ip_abuse
// (1.16.0) has no score threshold of its own either: IP_ABUSE_REPORTED is
// the observed fact that the upstream abuse confidence score is above zero
// (and the address is not whitelisted upstream), and callers choose their
// own threshold on abuse_confidence_score. Reports the upstream scores 0, or
// reports on a whitelisted address, are informational only.
//
// The word "safe" must never appear in a message here, and no message may
// name a specific upstream vendor/provider.

export const REASON_CODES = Object.freeze({
  WALLET_SANCTIONED: 'Address matches an entry on the sanctions list.',
  DOMAIN_NEWLY_REGISTERED_30D: 'Domain was registered fewer than 30 days ago.',
  HOSTNAME_PHISHING_LISTED: 'Hostname, or a parent domain of it, is on the phishing blocklist.',
  HOSTNAME_LOOKALIKE: 'Hostname is a probable lookalike/typosquat of a known brand domain.',
  WALLET_NO_HISTORY: 'No on-chain transfer history was found for this address on this chain.',
  WALLET_AGE_PARTIAL: 'Internal transfers were not checked in time; the wallet may be older than shown.',
  CVE_KNOWN_EXPLOITED_KEV: 'CVE is on the known exploited vulnerabilities catalog.',
  IOC_FOUND_IN_THREAT_FEED: 'Indicator has at least one matching record in the threat indicator feed.',
  WALLET_DELEGATED: 'Address currently has an EIP-7702 delegation on this chain: its code points to a delegate contract.',
  IP_ABUSE_REPORTED: 'IP address has an abuse confidence score above 0 from reports in the reporting window checked.',
  IP_TOR_EXIT_NODE: 'IP address is a Tor exit node.',
  IP_WHITELISTED: 'IP address is whitelisted by the abuse-report source, which does not count its reports against it.',
  IP_REPORTS_SCORED_ZERO: 'IP address has abuse reports in the reporting window checked, but its abuse confidence score is 0.'
});

// Informational codes report a fact without flagging anything: they appear
// in `reasons` like any other code, but never on their own make a response's
// derived `status` "flagged" (see computeStatus in lib/responseMeta.mjs).
// WALLET_DELEGATED is one: an EIP-7702 delegation is a fact about the
// address, not a judgement, so a delegated wallet's status is whatever it
// would have been without the delegation.
// IP_TOR_EXIT_NODE is one too: being a Tor exit is a fact about the
// address, not an abuse finding. So are IP_WHITELISTED and
// IP_REPORTS_SCORED_ZERO: reports exist, but the source itself scores them
// 0 or does not count them, so they are noted, not flagged.
export const INFORMATIONAL_REASON_CODES = Object.freeze(['WALLET_DELEGATED', 'IP_TOR_EXIT_NODE', 'IP_WHITELISTED', 'IP_REPORTS_SCORED_ZERO']);

// Incomplete codes say a check didn't complete, not that anything was
// found: they are listed in `reasons`, but make status "unknown", never
// "flagged" (a genuine warning reason alongside one still flags).
// WALLET_AGE_PARTIAL is one: internal transfers weren't checked in time.
export const INCOMPLETE_REASON_CODES = Object.freeze(['WALLET_AGE_PARTIAL']);

// Builds one { code, message } entry. `detail`, if given, replaces the
// frozen one-line meaning with a more specific message for this response
// (e.g. embedding a count) - the code itself is what's permanent and
// machine-checked, not the prose.
export function reason(code, detail) {
  if (!(code in REASON_CODES)) {
    throw new Error(`Unknown reason code: '${code}'. Add it to lib/reasonCodes.mjs first.`);
  }
  return { code, message: detail || REASON_CODES[code] };
}
