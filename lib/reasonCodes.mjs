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
// check_package (1.17.0): PACKAGE_REPORTED_MALICIOUS is the observed fact
// that a public malicious-package report covers the version checked (worded
// "reported", since such reports can be false positives); PACKAGE_NOT_FOUND
// and PACKAGE_VERSION_NOT_FOUND are the registry answering that the package
// or version does not exist; PACKAGE_NEW_LOOKALIKE is a first publish under
// PACKAGE_NEW_DAYS (30) days ago together with a name like a popular
// package's. The rest are facts reported without flagging: a look-alike
// name or a new package on its own, known vulnerabilities, deprecation,
// install scripts.
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
  IP_REPORTS_SCORED_ZERO: 'IP address has abuse reports in the reporting window checked, but its abuse confidence score is 0.',
  PACKAGE_REPORTED_MALICIOUS: 'Package version is reported malicious in a public malicious-package report. Such reports can be false positives.',
  PACKAGE_NOT_FOUND: 'Package does not exist in the registry. Names that do not exist yet are often invented by AI assistants and can later be registered by attackers.',
  PACKAGE_VERSION_NOT_FOUND: 'The package exists in the registry, but the requested version is not published.',
  PACKAGE_NEW_LOOKALIKE: 'Package was first published fewer than 30 days ago and its name looks like a popular package\'s name.',
  PACKAGE_LOOKALIKE: 'Package name looks like a popular package\'s name (a possible typosquat).',
  PACKAGE_NEWLY_PUBLISHED: 'Package was first published fewer than 30 days ago.',
  PACKAGE_KNOWN_VULNERABILITIES: 'The version checked has known vulnerabilities in the advisory databases checked.',
  PACKAGE_DEPRECATED: 'The version checked is marked deprecated by its publisher.',
  PACKAGE_INSTALL_SCRIPTS: 'The version checked runs scripts when it is installed (preinstall, install or postinstall).',
  // 1.18.0: agent-economy checks (check_x402_endpoint, check_agent_card) and preflight_check.
  X402_NO_PAYMENT_REQUEST: 'The URL did not answer with an x402 payment request, so its payment terms could not be checked.',
  X402_UNKNOWN_NETWORK: 'The payment request names a network that is not a known x402 settlement network.',
  X402_UNKNOWN_ASSET: 'The payment request asks for an asset that is not the known USDC contract on its network.',
  ENDPOINT_TLS_FAILED: 'The endpoint could not be reached over HTTPS with a valid certificate.',
  WALLET_NEW_7D: 'The receiving wallet\'s first on-chain activity was fewer than 7 days ago.',
  AGENT_CARD_NOT_FOUND: 'No agent card was found at the domain\'s /.well-known/agent-card.json.',
  AGENT_CARD_INVALID: 'The agent card is not a valid A2A agent card (required fields missing or malformed).',
  AGENT_CARD_NAME_IMPERSONATION: 'The agent card\'s name claims a well-known brand that the domain does not belong to.',
  PREFLIGHT_CHECK_INCOMPLETE: 'At least one of the checks this decision needs did not finish, so the decision is unknown.',
  HOSTING_REQUEST_REFUSED: 'The hosting request asks for something PG1 does not advise on (lawful use only); the refusal names the lawful alternative.',
  HOSTING_FACTS_STALE: 'Some facts behind this hosting advice were last checked more than 180 days ago.',
  HOSTING_FACTS_UNVERIFIED: 'Some facts behind this hosting advice are not yet verified against their cited source.',
  // 1.21.0: check_agent_message (lib/agentMessage.mjs), rule-based. Each says a
  // pattern was found; none found is never a guarantee.
  INSTRUCTION_OVERRIDE: 'The message tells the receiving agent to ignore, forget or replace its instructions ("ignore previous instructions" and its variants, in many languages).',
  EMBEDDED_COMMAND: 'The message carries a command for the receiving agent to run: a slash command, a dangerous shell one-liner or destructive or injection SQL.',
  TOOL_CALL_MARKUP: 'The message contains function-call or tool-use markup (JSON or XML), an MCP-style call or chat-template control tokens the receiving agent could mistake for its own.',
  ROLE_IMPERSONATION: 'The message pretends to be a system, developer or operator message, or claims their authority.',
  HIDDEN_TEXT: 'The message hides text: zero-width characters, bidirectional overrides, tag characters, look-alike letters from another script, hidden HTML or a long base64 or hex block.',
  CREDENTIAL_REQUEST: 'The message asks for a key, password, token, seed phrase or other secret.',
  PAYMENT_REQUEST: 'The message asks for a payment or approval: a wallet address with send or approve wording, an unlimited approval, or x402 payment headers in the text.',
  DATA_EXFILTRATION: 'The message asks the receiving agent to send data (its conversation, files, memory or secrets) to a URL or an email address.',
  SUSPICIOUS_URL: 'A URL in the message is on the phishing list, looks like a known brand\'s domain, was registered fewer than 30 days ago, or hides its destination (raw IP address, punycode, credentials in the link, a link shortener, a script link).'
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
// check_package's facts are informational too: a look-alike name or a new
// package alone, known vulnerabilities, deprecation and install scripts are
// all common in legitimate packages. Only the combination new + look-alike
// (PACKAGE_NEW_LOOKALIKE) flags.
export const INFORMATIONAL_REASON_CODES = Object.freeze([
  'WALLET_DELEGATED', 'IP_TOR_EXIT_NODE', 'IP_WHITELISTED', 'IP_REPORTS_SCORED_ZERO',
  'PACKAGE_LOOKALIKE', 'PACKAGE_NEWLY_PUBLISHED', 'PACKAGE_KNOWN_VULNERABILITIES', 'PACKAGE_DEPRECATED', 'PACKAGE_INSTALL_SCRIPTS',
  'WALLET_NEW_7D',
  // hosting_advisor (1.19.0): data-quality notes, never a finding.
  'HOSTING_FACTS_STALE', 'HOSTING_FACTS_UNVERIFIED'
]);

// Incomplete codes say a check didn't complete, not that anything was
// found: they are listed in `reasons`, but make status "unknown", never
// "flagged" (a genuine warning reason alongside one still flags).
// WALLET_AGE_PARTIAL is one: internal transfers weren't checked in time.
export const INCOMPLETE_REASON_CODES = Object.freeze(['WALLET_AGE_PARTIAL', 'X402_NO_PAYMENT_REQUEST', 'AGENT_CARD_NOT_FOUND', 'PREFLIGHT_CHECK_INCOMPLETE']);

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
