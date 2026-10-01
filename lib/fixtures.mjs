// Integration test fixtures (issue #215, buyer-experience upgrade part B).
//
// Fixed, made-up inputs that let a developer exercise every MCP tool / A2A
// skill that can meaningfully flag something, for free, and always get the
// same answer back: one FLAGGED, one CLEAN, one UNKNOWN per tool. This file
// is the single source of truth for those inputs and their expected result -
// README.md, public/llms.txt and tests/fixtures.test.mjs all read from it.
// The responses themselves are built in api/mcp.mjs (resolveTestFixture),
// reusing each tool's real result builders so the shape can't drift.
//
// Every value here is reserved or synthetic, so it can never belong to a
// real target:
//   - Domains/hostnames live under the .invalid TLD, which RFC 2606 / RFC
//     6761 reserve permanently: it can never be delegated, registered or
//     resolved. They are registrable-level names (pg1-test-flagged.invalid,
//     not flagged.pg1-test.invalid) because check_domain_age reduces any
//     input to its registrable domain, and three subdomains of one
//     registrable domain would collapse into the same lookup.
//   - IPv4 values come from the RFC 5737 documentation ranges
//     (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) and IPv6 values from
//     the RFC 3849 documentation prefix (2001:db8::/32). None of them are
//     ever routed on the public internet.
//   - CVE ids use the year 0000. The CVE programme began assigning ids in
//     1999 and the year field is the year of assignment/disclosure, so a
//     CVE-0000-* id can never be issued, yet it still passes the tools'
//     'CVE-YYYY-NNNN' format check.
//   - EVM wallet addresses are 0x + hex('pg1-test-fixture') + an 8-hex-digit
//     counter (00000001..00000003). A real EVM address is the last 20 bytes
//     of a keccak-256 hash (of a public key, or of a deployer + nonce/salt
//     for a contract), so finding a key or deployment that lands on a chosen
//     160-bit value takes ~2^160 work: nobody controls these addresses, and
//     they decode to readable ASCII so they are obviously synthetic. Even in
//     the (astronomically unlikely) case that someone sent funds to one, the
//     fixture answer is hard-coded and never consults chain data.
//   - Product lookups use the vendor 'pg1-test.invalid', which is not a
//     real vendor for the same .invalid reason as above.
//
// Matching is exact-value only, never a pattern: a value one character off
// is treated as a real input and goes through the normal (validated,
// rate-limited, possibly paid) path. The only normalisation applied is the
// one the tool itself already applies to that input before looking it up
// (e.g. lowercasing an EVM address, uppercasing a CVE id, reducing a domain
// to its registrable domain) - so a fixture matches exactly when the real
// lookup would have queried the fixture value.
//
// A fixture only matches an input the tool's own validator would accept
// (the fixture values are valid by construction, and optional arguments
// such as check_wallet_age's chain must also be valid), so an invalid
// request still gets the tool's normal invalid-input error.
//
// Tools with no fixtures, and why: get_threat_indicators is a bulk feed with
// no target input; get_threat_actor_profile and get_usage_status have no
// reason code in lib/reasonCodes.mjs to flag with (a FLAGGED fixture would
// have to invent one); subscribe_alerts and submit_indicator are write
// actions whose own `status` field is a lifecycle state, not a verdict.

import { extractRegistrableDomain } from './domainExtraction.mjs';
import { normalizeWalletAddress } from './walletAddress.mjs';

export const FIXTURE_KINDS = Object.freeze(['FLAGGED', 'CLEAN', 'UNKNOWN']);

// Every checks[] entry in a fixture response uses this source label.
export const FIXTURE_CHECK_SOURCE = 'fixture';

// Fixed timestamp for fixture fields that describe synthetic records (list
// sync times, CVE publish dates, IOC first/last seen). None of them feed a
// verdict, so a fixed date is safe. Every fixture's checks[].data_as_of is
// NOT this value: it equals that check's checked_at (the fixture data is
// "as of" the moment it was served).
export const FIXTURE_DATA_AS_OF = '2026-01-01T00:00:00.000Z';

const DAY_MS = 24 * 60 * 60 * 1000;

// check_domain_age FLAGGED is registered this many days ago, counted from
// today's midnight UTC - always under the 30-day DOMAIN_NEWLY_REGISTERED_30D
// threshold, whatever today is. Dates a verdict depends on are always
// computed relative to now, never hard-coded, so they can't drift.
export const FIXTURE_DOMAIN_FLAGGED_AGE_DAYS = 3;
// check_domain_age CLEAN: a fixed old date is fine, it only gets older.
export const FIXTURE_DOMAIN_CLEAN_REGISTERED = '2000-01-01T00:00:00.000Z';

// Midnight UTC `days` days before `nowMs`, as an ISO string.
export function fixtureDaysAgoMidnightUtc(days, nowMs = Date.now()) {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * DAY_MS).toISOString();
}

const WALLET_PREFIX = '0x7067312d746573742d66697874757265'; // 0x + hex('pg1-test-fixture')

export const FIXTURE_VALUES = Object.freeze({
  wallet: Object.freeze({
    FLAGGED: `${WALLET_PREFIX}00000001`,
    CLEAN: `${WALLET_PREFIX}00000002`,
    UNKNOWN: `${WALLET_PREFIX}00000003`
  }),
  domain: Object.freeze({
    FLAGGED: 'pg1-test-flagged.invalid',
    CLEAN: 'pg1-test-clean.invalid',
    UNKNOWN: 'pg1-test-unknown.invalid'
  }),
  ipv4: Object.freeze({
    FLAGGED: '192.0.2.1',
    CLEAN: '198.51.100.1',
    UNKNOWN: '203.0.113.1'
  }),
  ipv6: Object.freeze({
    FLAGGED: '2001:db8::1',
    CLEAN: '2001:db8::2',
    UNKNOWN: '2001:db8::3'
  }),
  cve: Object.freeze({
    FLAGGED: 'CVE-0000-0001',
    CLEAN: 'CVE-0000-0002',
    UNKNOWN: 'CVE-0000-0003'
  }),
  product: Object.freeze({
    FLAGGED: Object.freeze({ vendor: 'pg1-test.invalid', product: 'flagged' }),
    CLEAN: Object.freeze({ vendor: 'pg1-test.invalid', product: 'clean' }),
    UNKNOWN: Object.freeze({ vendor: 'pg1-test.invalid', product: 'unknown' })
  })
});

// `outcome` is what the caller sees on MCP:
//   - 'result': a normal, successful tool result.
//   - 'tool_error': an MCP tool result with isError: true (same as a real
//     upstream failure for that tool).
//   - 'service_unavailable': a JSON-RPC error with HTTP 503 (same as a real
//     upstream failure for that tool).
// On A2A (the 4 fixture-bearing skills) 'result' is a completed Task,
// 'tool_error' is JSON-RPC error -32000 with the details in error.data, and
// 'service_unavailable' is HTTP 503 with JSON-RPC error -32010 - again the
// exact shapes a real upstream failure produces there.
// `summary` is the one-line expected result shown in the docs table.
function fx(tool, kind, args, expected) {
  return Object.freeze({ tool, kind, arguments: Object.freeze(args), expected: Object.freeze(expected) });
}

export const TEST_FIXTURES = Object.freeze([
  fx('check_wallet_sanctions', 'FLAGGED', { address: FIXTURE_VALUES.wallet.FLAGGED },
    { outcome: 'result', status: 'flagged', reason_codes: ['WALLET_SANCTIONED'], summary: 'listed: true, status "flagged", reason WALLET_SANCTIONED' }),
  fx('check_wallet_sanctions', 'CLEAN', { address: FIXTURE_VALUES.wallet.CLEAN },
    { outcome: 'result', status: 'no_flags', reason_codes: [], summary: 'listed: false, status "no_flags"' }),
  fx('check_wallet_sanctions', 'UNKNOWN', { address: FIXTURE_VALUES.wallet.UNKNOWN },
    { outcome: 'service_unavailable', status: 'unknown', reason_codes: [], summary: 'HTTP 503, JSON-RPC error -32003 "Sanctions data temporarily unavailable, please retry."' }),

  fx('check_domain_age', 'FLAGGED', { domain: FIXTURE_VALUES.domain.FLAGGED },
    { outcome: 'result', status: 'flagged', reason_codes: ['DOMAIN_NEWLY_REGISTERED_30D'], summary: `found: true, age_days ${FIXTURE_DOMAIN_FLAGGED_AGE_DAYS}, newly_registered: true, status "flagged", reason DOMAIN_NEWLY_REGISTERED_30D` }),
  fx('check_domain_age', 'CLEAN', { domain: FIXTURE_VALUES.domain.CLEAN },
    { outcome: 'result', status: 'no_flags', reason_codes: [], summary: 'found: true, registration_date 2000-01-01, status "no_flags"' }),
  fx('check_domain_age', 'UNKNOWN', { domain: FIXTURE_VALUES.domain.UNKNOWN },
    { outcome: 'result', status: 'unknown', reason_codes: [], summary: 'found: false, reason_code "timeout", status "unknown" (what a real RDAP timeout returns)' }),

  fx('check_hostname_reputation', 'FLAGGED', { hostname: FIXTURE_VALUES.domain.FLAGGED },
    { outcome: 'result', status: 'flagged', reason_codes: ['HOSTNAME_PHISHING_LISTED'], summary: 'verdict "listed" (match_type "exact"), status "flagged", reason HOSTNAME_PHISHING_LISTED' }),
  fx('check_hostname_reputation', 'CLEAN', { hostname: FIXTURE_VALUES.domain.CLEAN },
    { outcome: 'result', status: 'no_flags', reason_codes: [], summary: 'verdict "not_listed", status "no_flags"' }),
  fx('check_hostname_reputation', 'UNKNOWN', { hostname: FIXTURE_VALUES.domain.UNKNOWN },
    { outcome: 'service_unavailable', status: 'unknown', reason_codes: [], summary: 'HTTP 503, JSON-RPC error -32003 "Phishing domain list temporarily unavailable, please retry."' }),

  fx('check_wallet_age', 'FLAGGED', { address: FIXTURE_VALUES.wallet.FLAGGED },
    { outcome: 'result', status: 'flagged', reason_codes: ['WALLET_NO_HISTORY'], summary: 'found: false (no transfer history), status "flagged", reason WALLET_NO_HISTORY' }),
  fx('check_wallet_age', 'CLEAN', { address: FIXTURE_VALUES.wallet.CLEAN },
    { outcome: 'result', status: 'no_flags', reason_codes: [], summary: 'found: true, first_seen 2023-09-01T00:00:00.000Z, status "no_flags"' }),
  fx('check_wallet_age', 'UNKNOWN', { address: FIXTURE_VALUES.wallet.UNKNOWN },
    { outcome: 'tool_error', status: 'unknown', reason_codes: [], error_code: 'upstream_unavailable', summary: 'isError: true, code "upstream_unavailable", status "unknown" (never found: false)' }),

  fx('get_ioc_context', 'FLAGGED', { value: FIXTURE_VALUES.ipv4.FLAGGED },
    { outcome: 'result', status: 'flagged', reason_codes: ['IOC_FOUND_IN_THREAT_FEED'], summary: 'found: true, status "flagged", reason IOC_FOUND_IN_THREAT_FEED (free, no payment)' }),
  fx('get_ioc_context', 'CLEAN', { value: FIXTURE_VALUES.ipv4.CLEAN },
    { outcome: 'result', status: 'no_flags', reason_codes: [], summary: 'found: false, status "no_flags"' }),
  fx('get_ioc_context', 'UNKNOWN', { value: FIXTURE_VALUES.ipv4.UNKNOWN },
    { outcome: 'service_unavailable', status: 'unknown', reason_codes: [], summary: 'HTTP 503, JSON-RPC error -32603 "Threat data temporarily unavailable, please retry."' }),

  fx('get_ioc_batch', 'FLAGGED', { values: [FIXTURE_VALUES.ipv6.FLAGGED] },
    { outcome: 'result', status: 'flagged', reason_codes: ['IOC_FOUND_IN_THREAT_FEED'], summary: 'total_found 1, status "flagged", reason IOC_FOUND_IN_THREAT_FEED (free, no payment)' }),
  fx('get_ioc_batch', 'CLEAN', { values: [FIXTURE_VALUES.ipv6.CLEAN] },
    { outcome: 'result', status: 'no_flags', reason_codes: [], summary: 'total_found 0, status "no_flags"' }),
  fx('get_ioc_batch', 'UNKNOWN', { values: [FIXTURE_VALUES.ipv6.UNKNOWN] },
    { outcome: 'service_unavailable', status: 'unknown', reason_codes: [], summary: 'HTTP 503, JSON-RPC error -32003 "Threat data temporarily unavailable, please retry."' }),

  fx('get_cve_details', 'FLAGGED', { cve_id: FIXTURE_VALUES.cve.FLAGGED },
    { outcome: 'result', status: 'flagged', reason_codes: ['CVE_KNOWN_EXPLOITED_KEV'], summary: 'cisa_kev.is_known_exploited: true, status "flagged", reason CVE_KNOWN_EXPLOITED_KEV (free, no payment)' }),
  fx('get_cve_details', 'CLEAN', { cve_id: FIXTURE_VALUES.cve.CLEAN },
    { outcome: 'result', status: 'no_flags', reason_codes: [], summary: 'cisa_kev.is_known_exploited: false, status "no_flags"' }),
  fx('get_cve_details', 'UNKNOWN', { cve_id: FIXTURE_VALUES.cve.UNKNOWN },
    { outcome: 'result', status: 'unknown', reason_codes: [], summary: 'exploit-score and KEV checks "error", epss null, status "unknown"' }),

  fx('get_cve_batch', 'FLAGGED', { cve_ids: [FIXTURE_VALUES.cve.FLAGGED] },
    { outcome: 'result', status: 'flagged', reason_codes: ['CVE_KNOWN_EXPLOITED_KEV'], summary: 'one KEV-listed result, status "flagged", reason CVE_KNOWN_EXPLOITED_KEV (free, no payment)' }),
  fx('get_cve_batch', 'CLEAN', { cve_ids: [FIXTURE_VALUES.cve.CLEAN] },
    { outcome: 'result', status: 'no_flags', reason_codes: [], summary: 'one non-KEV result, status "no_flags"' }),
  fx('get_cve_batch', 'UNKNOWN', { cve_ids: [FIXTURE_VALUES.cve.UNKNOWN] },
    { outcome: 'result', status: 'unknown', reason_codes: [], summary: 'exploit-score and KEV checks "error", status "unknown"' }),

  fx('get_cve_by_product', 'FLAGGED', { ...FIXTURE_VALUES.product.FLAGGED },
    { outcome: 'result', status: 'flagged', reason_codes: ['CVE_KNOWN_EXPLOITED_KEV'], summary: 'one KEV-listed CVE, status "flagged", reason CVE_KNOWN_EXPLOITED_KEV (free, no payment)' }),
  fx('get_cve_by_product', 'CLEAN', { ...FIXTURE_VALUES.product.CLEAN },
    { outcome: 'result', status: 'no_flags', reason_codes: [], summary: 'total_found 0, status "no_flags"' }),
  fx('get_cve_by_product', 'UNKNOWN', { ...FIXTURE_VALUES.product.UNKNOWN },
    { outcome: 'result', status: 'unknown', reason_codes: [], summary: 'exploit-score and KEV checks "error", status "unknown"' })
]);

export const FIXTURE_TOOLS = Object.freeze([...new Set(TEST_FIXTURES.map((f) => f.tool))]);

// A2A exposes only the 5 free skills; 4 of them have fixtures
// (get_usage_status has none - see the header comment).
export const A2A_FIXTURE_SKILLS = Object.freeze(['check_wallet_sanctions', 'check_domain_age', 'check_hostname_reputation', 'check_wallet_age']);

const WALLET_AGE_CHAINS = new Set(['base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'bsc']);
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function str(value) {
  return typeof value === 'string' ? value : null;
}

// Mirrors each tool's own pre-lookup normalisation of its target input.
// Returns the lookup key for `args`, or null when the input can't be a
// fixture (wrong type, or an optional argument the tool would reject).
const KEY_OF = {
  check_wallet_sanctions: (args) => {
    const address = str(args?.address);
    return address && address.trim() ? normalizeWalletAddress(address) : null;
  },
  check_domain_age: (args) => {
    const domain = str(args?.domain);
    return domain ? extractRegistrableDomain(domain) : null;
  },
  check_hostname_reputation: (args) => {
    const hostname = str(args?.hostname);
    if (!hostname) return null;
    let h = hostname.trim().toLowerCase();
    if (h.endsWith('.')) h = h.slice(0, -1);
    return h;
  },
  check_wallet_age: (args) => {
    const address = str(args?.address);
    if (!address || !EVM_ADDRESS_RE.test(address.trim())) return null;
    const rawChain = args?.chain;
    const chain = (rawChain === undefined || rawChain === null || rawChain === '') ? 'base' : String(rawChain).trim().toLowerCase();
    if (!WALLET_AGE_CHAINS.has(chain)) return null;
    return address.trim().toLowerCase();
  },
  get_ioc_context: (args) => {
    const value = str(args?.value);
    return value ? value.trim() : null;
  },
  get_ioc_batch: (args) => {
    const values = args?.values;
    if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === 'string')) return null;
    return JSON.stringify(values.map((v) => v.trim()));
  },
  get_cve_details: (args) => {
    const cveId = str(args?.cve_id);
    return cveId ? cveId.toUpperCase() : null;
  },
  get_cve_batch: (args) => {
    const ids = args?.cve_ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((v) => typeof v === 'string')) return null;
    return JSON.stringify(ids.map((v) => v.toUpperCase()));
  },
  get_cve_by_product: (args) => {
    const vendor = str(args?.vendor);
    const product = str(args?.product);
    return vendor && product ? JSON.stringify([vendor, product]) : null;
  }
};

// toolName -> Map(lookup key -> fixture), built once from TEST_FIXTURES by
// running each fixture's own arguments through the same KEY_OF function a
// caller's arguments go through.
const FIXTURE_INDEX = new Map();
for (const fixture of TEST_FIXTURES) {
  const key = KEY_OF[fixture.tool](fixture.arguments);
  if (key === null) throw new Error(`Fixture ${fixture.tool}/${fixture.kind} has arguments its own tool would reject.`);
  if (!FIXTURE_INDEX.has(fixture.tool)) FIXTURE_INDEX.set(fixture.tool, new Map());
  const byKey = FIXTURE_INDEX.get(fixture.tool);
  if (byKey.has(key)) throw new Error(`Duplicate fixture key for ${fixture.tool}: ${key}`);
  byKey.set(key, fixture);
}

// Returns the fixture that `args` matches exactly for `toolName`, or null.
// Never throws: anything unexpected is simply not a fixture.
export function matchFixture(toolName, args) {
  const byKey = FIXTURE_INDEX.get(toolName);
  if (!byKey) return null;
  let key;
  try {
    key = KEY_OF[toolName](args || {});
  } catch {
    return null;
  }
  return key === null ? null : (byKey.get(key) || null);
}
