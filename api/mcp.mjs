/**
 * PG1 Sovereign Threat Intelligence MCP Server
 * Endpoint: /api/mcp
 * Protocol: Model Context Protocol (MCP) over Streamable HTTP
 * Monetization: x402 (Base chain micropayments) & Gumroad license keys
 * Version: 1.16.0 — ADD: new free tool check_ip_abuse (also an A2A skill),
 *          a bring-your-own-key AbuseIPDB lookup (lib/abuseIpdb.mjs). It
 *          runs only with the caller's own AbuseIPDB key, sent in the
 *          X-AbuseIPDB-Key request header (never a tool argument); PG1 has
 *          no AbuseIPDB key and never falls back to one. Results go only to
 *          that caller, with attribution, cached in memory per key
 *          (sha256(key) + ip + max_age_in_days, 15 minutes), and are never
 *          written anywhere. No x402 charge; the usual 60/hour anonymous
 *          limit. The 14 pre-existing tools' names, descriptions and
 *          schemas are unchanged (tests/fixtures/existing-14-tools-snapshot.json).
 *          SOURCE_ABUSEIPDB_ENABLED (lib/sourcePolicy.mjs) now defaults off,
 *          so no AbuseIPDB-labelled telemetry row is served to anyone.
 * Version: 1.15.0 — LICENSING: abuse.ch ThreatFox / URLhaus data is no
 *          longer served. Every threat_ioc_telemetry read goes through
 *          lib/sourcePolicy.mjs, which drops rows from switched-off sources
 *          (SOURCE_ABUSECH_ENABLED and SOURCE_UNATTRIBUTED_ENABLED default
 *          off; the rest default on). get_threat_indicators,
 *          get_ioc_context and get_ioc_batch descriptions no longer name
 *          ThreatFox or URLhaus; nothing else in any tool definition
 *          changes. serverInfo and the GET status version, both left at
 *          1.13.0 by earlier releases, now report 1.15.0.
 * Version: 1.14.0 — ADD: check_wallet_age now reports EIP-7702 delegation
 *          (optional delegated / delegate_address output fields, reason
 *          code WALLET_DELEGATED). The delegation check is a live
 *          eth_getCode on the requested chain, run in parallel with the
 *          age lookups inside the same 2.5s budget, on every call -
 *          including cached age answers - and never cached itself, since an
 *          owner can add or remove a delegation at any time. A failed code
 *          check returns the age result with delegated: null, never false.
 *          is_contract is unchanged (still true for a delegated address).
 *          WALLET_DELEGATED is informational: it never changes status on
 *          its own. WALLET_AGE_PARTIAL now makes status "unknown" (a check
 *          didn't complete), not "flagged". Cached answers now count against the 60/hour anonymous
 *          rate limit (each makes an upstream call); licensed callers stay
 *          exempt. No other tool definition changes.
 * Version: 1.13.0 — ADD (issue #209): new free tool check_wallet_age,
 *          reporting when an EVM address first appeared on a chain (earliest
 *          on-chain transfer in or out) plus whether it's a contract. Gated
 *          identically to check_domain_age (free, 60/hour anonymous rate
 *          limit, license-key exemption, outputSchema + structuredContent).
 *          Results are cached in the Supabase wallet_first_seen table —
 *          found results permanently, found:false for 10 minutes only — and
 *          the tool still works uncached if that table is absent. Never
 *          returns found:false on an upstream failure or timeout (a proper
 *          MCP isError result instead), never describes a result as "safe",
 *          and never surfaces a third-party vendor name or raw upstream
 *          fields. The 13 pre-existing tools' names, descriptions, and input
 *          schemas are unchanged.
 * Version: 1.12.0 — ADD (issue #121): new free tool check_hostname_reputation,
 *          screening a single hostname against the MetaMask eth-phishing-detect
 *          blocklist/allowlist (public.phishing_domains, public.phishing_list_meta,
 *          synced daily by the sovereign-threat-pipeline repo) plus a lookalike/
 *          typosquat detector (confusable-character skeleton matching and brand
 *          keyword matching against fuzzylist entries). Gated identically to
 *          check_domain_age (free, 60/hour anonymous rate limit, license-key
 *          exemption, outputSchema + structuredContent, 1h in-memory result
 *          cache). All pre-existing tools' names, descriptions, input/output
 *          schemas, and gating order are unchanged.
 * Version: 1.11.0 — FIX (issue #106): check_wallet_sanctions now validates
 *          the address's format before querying sanctions data, returning
 *          an MCP tool error (isError: true, code invalid_address) instead
 *          of a misleading listed:false for malformed input. check_domain_age
 *          gains a found boolean (available is kept, deprecated) and a
 *          dedicated unsupported_tld reason_code, separate from lookup
 *          failures. Both tools now declare an outputSchema and return
 *          structuredContent alongside their existing text content, per the
 *          MCP spec.
 * Version: 1.10.0 — ADD: two new free tools, check_wallet_sanctions (OFAC
 *          SDN wallet screening against public.sanctioned_wallets, synced
 *          daily by the sovereign-threat-pipeline repo) and check_domain_age
 *          (RDAP-based domain registration age via the IANA bootstrap
 *          registry). Both are gated identically to the existing free tools
 *          (no x402 payment). The 9 pre-existing tools' names, descriptions,
 *          and input schemas are unchanged.
 * Version: 1.9.2 — FIX: free tier was granted automatically to any caller
 *          with no payment header, with no way to opt out of being served
 *          for free. That meant a credential-less probe (e.g. Coinbase's
 *          x402 Bazaar discovery crawler, which intentionally sends no
 *          credentials to check whether payment is actually demanded) got
 *          a free 200 instead of the 402 it needs to see to register this
 *          as a real paid service. Free tier is now opt-in only: it's
 *          considered solely when the caller sends "x-free-tier: 1"; with
 *          no license key, no payment header, and no x-free-tier header,
 *          the default is 402 Payment Required. Also: CORS now exposes the
 *          payment-related headers (X-Payment, Payment-Signature,
 *          x-free-tier, X-API-KEY) via Access-Control-Expose-Headers, and
 *          the get_threat_indicators "type" filter description now lists
 *          the real database enum values instead of a generic "hash".
 *          Carries forward 1.9.1 (payment-before-free-tier ordering) and
 *          1.9.0 (found:false as a free, normal result for get_ioc_context/
 *          get_ioc_batch) and all prior fixes.
 */

import { ExactEvmScheme } from '@x402/evm/exact/server';
import { x402ResourceServer } from '@x402/express';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';
import { checkFreeTierAvailable, consumeFreeTier, getRequestIdentifier, logSettlementOutcome, FREE_TIER_DAILY_LIMIT } from '../lib/freeTier.mjs';
import { verifyGumroadLicense } from '../lib/paymentGate.mjs';
import { X402_NETWORK, X402_PRICE, X402_SCHEME, X402_VERSION, RATE_LIMIT_WINDOW_MS, DOMAIN_AGE_RATE_LIMIT_MAX, HOSTNAME_REPUTATION_RATE_LIMIT_MAX, WALLET_AGE_RATE_LIMIT_MAX, WALLET_SANCTIONS_RATE_LIMIT_MAX, IP_ABUSE_RATE_LIMIT_MAX } from '../lib/x402Config.mjs';
import { getSupabaseCreds } from '../lib/supabase.mjs';
import { detectIndicatorType, lookupIocContext } from '../lib/iocContext.mjs';
import { fetchThreatTelemetry } from '../lib/sourcePolicy.mjs';
import { normalizeWalletAddress, isRecognizedWalletAddress } from '../lib/walletAddress.mjs';
import { extractRegistrableDomain } from '../lib/domainExtraction.mjs';
import { domainToASCII, domainToUnicode } from 'node:url';
import { logApiError } from '../lib/errorLog.mjs';
import { recordTelemetry, callerHash } from '../lib/telemetry.mjs';
import { reason } from '../lib/reasonCodes.mjs';
import { buildCheck, withResponseMeta, withActionResponseMeta, classifyToolErrorCheckResult, errorResponseMeta } from '../lib/responseMeta.mjs';
import { matchFixture, FIXTURE_CHECK_SOURCE, FIXTURE_DATA_AS_OF, FIXTURE_VALUES, FIXTURE_DELEGATE_ADDRESS, FIXTURE_DOMAIN_FLAGGED_AGE_DAYS, FIXTURE_DOMAIN_CLEAN_REGISTERED, fixtureDaysAgoMidnightUtc } from '../lib/fixtures.mjs';
import { invalidInput, invalidInputMessage, withFixIt, formatFixIt } from '../lib/invalidInput.mjs';
import { ABUSEIPDB_KEY_HEADER, ABUSEIPDB_ATTRIBUTION_TEXT, ABUSEIPDB_TIMEOUT_MS, MAX_AGE_DAYS_DEFAULT, abuseIpdbCheckUrlFor, keyRequiredError, readCustomerKey, normalizePublicIp, normalizeMaxAgeDays, getCachedLookup, setCachedLookup, fetchAbuseIpdbCheck } from '../lib/abuseIpdb.mjs';

export const config = { maxDuration: 30 };

// Fire-and-forget write into pg1_errors (issue #213: wire api/mcp.mjs and
// api/a2a.mjs into the error log) - same non-blocking pattern as
// api/chat.mjs's recordServerError, never awaited on the request's hot path
// so a logging failure (or a missing Supabase config) can never slow down or
// change a tool's response, and in particular never eats into
// check_wallet_age's 2.5s upstream budget. `route` carries the tool/skill
// name (e.g. "/api/mcp:check_wallet_age") instead of a new schema column, per
// the existing (source, route, status, reason) grouping. `reason` must only
// ever be a short, fixed, PG1-written string - never caller input (address/
// domain/hostname), an API key, a license key, or a raw upstream response
// body. Reused by api/a2a.mjs for its own skill-level failures.
export function recordToolError(route, status, reason, category, requestId) {
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch {
    return;
  }
  logApiError(creds.supUrl, creds.supKey, { source: 'server', route, status, reason, category, requestId }).catch(() => {});
}

// ---------------------------------------------------------------------
// TOOLS
// ---------------------------------------------------------------------

const CVE_BATCH_MAX = 20;
const IOC_BATCH_MAX = 20;

// Optional outputSchema additions shared by the 4 tools that already declare
// an outputSchema (issue #215, part A option A, agreed 2026-09-30): reasons/
// status/checks/request_id, added to `properties` only - never to
// `required` - so existing structuredContent consumers validating against
// the old required list are unaffected. Every one of the 14 tools' JSON
// responses carries these same 4 fields; the other 10 tools simply don't
// have a declared outputSchema to add them to.
export const RESPONSE_META_OUTPUT_PROPERTIES = {
  reasons: {
    type: 'array',
    description: 'Machine-readable reason codes for anything flagged in this result. Empty when nothing was flagged.',
    items: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' }
      },
      required: ['code', 'message']
    }
  },
  status: {
    type: 'string',
    enum: ['flagged', 'no_flags', 'unknown'],
    description: '"unknown" whenever a source needed for this answer timed out, errored, or was skipped - never "no_flags" in that case.'
  },
  checks: {
    type: 'array',
    description: 'Which underlying sources were checked for this result and whether each one completed.',
    items: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Generic label for the data source checked, never a vendor name.' },
        result: { type: 'string', enum: ['ok', 'timeout', 'error', 'skipped'] },
        checked_at: { type: 'string' },
        data_as_of: { type: ['string', 'null'] }
      },
      required: ['source', 'result', 'checked_at', 'data_as_of']
    }
  },
  request_id: { type: 'string', description: 'UUID for this request, also sent as the X-Request-Id response header.' }
};

// Optional outputSchema addition for the same 4 tools (issue #215 part B):
// present (and true) only on a response to an integration test fixture
// input (see lib/fixtures.mjs), absent on every real response. Never in
// `required`.
export const TEST_FIXTURE_OUTPUT_PROPERTIES = {
  test_fixture: { type: 'boolean', description: 'true only when the input was a documented integration test fixture and this response is canned; absent on real results.' }
};

export const TOOLS = [
  {
    name: 'get_threat_indicators',
    description: 'PG1 Sovereign Threat Intelligence: returns a STIX 2.1 bundle of verified threat indicators (IPs, domains, URLs, file hashes) sourced from OTX and NVD. Payment required: $0.01 via x402, sent in params._meta["x402/payment"] (the PAYMENT-SIGNATURE header is also accepted), or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use ONLY for bulk feed synchronizations. Do NOT use for single-item lookups (use get_ioc_context) or CVE analysis (use get_cve_details). USAGE EXCLUSIONS: Does not provide historical query archival beyond the active ingestion window. BEHAVIOR: Pagination is handled via the limit parameter (max 1000). If payment is missing or fails, returns a normal tool result with isError: true, the x402 v2 PaymentRequired object in structuredContent and the same JSON in content[0].text; on success the settlement receipt is in result._meta["x402/payment-response"].',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: ['string', 'null'], description: 'ISO timestamp constraint (e.g., 2026-09-20T00:00:00Z); strictly filters and returns only indicators last seen after this exact timestamp.' },
        type: { type: ['string', 'null'], description: "Indicator category filter. Allowed enum-style values: 'IPv4', 'domain', 'URL', 'FileHash-MD5', 'FileHash-SHA1', or 'FileHash-SHA256'." },
        min_score: { type: ['integer', 'null'], description: 'Confidence score threshold integer ranging inclusively from 0 to 100 to filter low-confidence noise.' },
        limit: { type: ['integer', 'null'], description: 'Pagination boundary constraint defining the maximum number of indicators to return in a single payload (integer between 1 and 1000, defaulting to 500).', default: 500 }
      }
    }
  },
  {
    name: 'get_cve_details',
    description: 'PG1 Sovereign Threat Intelligence: enriched CVE lookup combining NVD (description, CVSS score/vector), FIRST.org EPSS (exploit-probability score and percentile), and the CISA Known Exploited Vulnerabilities catalog (active wild exploitation status). Payment required: $0.01 via x402, sent in params._meta["x402/payment"] (the PAYMENT-SIGNATURE header is also accepted), or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use ONLY for specific CVE lookups. Do NOT use for IP/domain/hash enrichment (use get_ioc_context) or bulk feed ingestion (use get_threat_indicators). USAGE EXCLUSIONS: Does not support wildcard search or threat-actor dossier profiling. BEHAVIOR: If payment is missing or fails, returns a normal tool result with isError: true, the x402 v2 PaymentRequired object in structuredContent and the same JSON in content[0].text; on success the settlement receipt is in result._meta["x402/payment-response"]. Returns 404 if CVE is not found.',
    inputSchema: {
      type: 'object',
      properties: {
        cve_id: { type: 'string', description: "Mandatory official CVE identifier string strictly formatted as 'CVE-YYYY-NNNN' (e.g., 'CVE-2021-44228')." }
      },
      required: ['cve_id']
    }
  },
  {
    name: 'get_ioc_context',
    description: "PG1 Sovereign Threat Intelligence: looks up a single specific indicator value (IP, domain, URL, or hash) — the recommended pre-action safety check for AI agents before visiting, downloading, or connecting to something. Returns aggregated provenance from OTX — reporting sources, observation count, aggregated confidence score, known malware families, tags, and first/last seen timestamps. SIBLING DIFFERENTIATION: Use ONLY for point-lookup enrichment of a single indicator. Do NOT use for bulk intelligence downloads (use get_threat_indicators), multiple indicators at once (use get_ioc_batch), or software vulnerability analysis (use get_cve_details). BEHAVIOR: Returns a normal result shaped { found: true, indicator_type, provenance } or { found: false } — never an error for 'not found'. A found:false result means nothing bad is recorded in PG1's sources; it does NOT mean the indicator is safe, only that it isn't in this dataset. Lookups that return found:false are FREE — no payment or free-tier quota is consumed. Payment (x402 via params._meta['x402/payment'], with the PAYMENT-SIGNATURE header also accepted, or a Gumroad X-API-KEY license) is only required when a real record is found. If payment is required but missing or fails, the result has isError: true with the x402 v2 PaymentRequired object in structuredContent.",
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'Mandatory exact indicator string value to look up, such as an IPv4 address (198.51.100.1), fully qualified domain, complete URL, or SHA-256 hash string.' }
      },
      required: ['value']
    }
  },
  {
    name: 'get_cve_batch',
    description: "PG1 Sovereign Threat Intelligence: looks up multiple CVE identifiers in a single call, each enriched with NVD description/CVSS, FIRST.org EPSS score, and CISA KEV status — same enrichment as get_cve_details, batched. Payment required: $0.01 via x402, sent in params._meta['x402/payment'] (the PAYMENT-SIGNATURE header is also accepted), or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use for looking up several known CVE ids at once (e.g. from an SBOM or scan report). Do NOT use for a single CVE (use get_cve_details, lower overhead) or for discovering CVEs by vendor/product (use get_cve_by_product). BEHAVIOR: Accepts up to " + CVE_BATCH_MAX + " ids per call; malformed or not-found ids are reported per-entry rather than failing the whole batch.",
    inputSchema: {
      type: 'object',
      properties: {
        cve_ids: {
          type: 'array',
          items: { type: 'string' },
          description: "Array of CVE identifiers, each formatted 'CVE-YYYY-NNNN'. Max " + CVE_BATCH_MAX + " per call."
        }
      },
      required: ['cve_ids']
    }
  },
  {
    name: 'get_ioc_batch',
    description: "PG1 Sovereign Threat Intelligence: looks up multiple indicators (IPs, domains, URLs, hashes) in a single call — a batched pre-action safety check for AI agents. Each returns the same aggregated provenance as get_ioc_context from OTX. SIBLING DIFFERENTIATION: Use for checking several indicators at once (e.g. all URLs an agent is about to visit). Do NOT use for a single indicator (use get_ioc_context, lower overhead) or bulk feed synchronization (use get_threat_indicators). BEHAVIOR: Accepts up to " + IOC_BATCH_MAX + " indicators per call. A found:false result for any indicator means nothing bad is recorded in PG1's sources — NOT that it's safe. If NONE of the submitted indicators are found, the whole batch is FREE — no payment or free-tier quota consumed. If at least one indicator is found, the normal payment gate (x402 via params._meta['x402/payment'], with the PAYMENT-SIGNATURE header also accepted, or a Gumroad X-API-KEY license) applies to the full batch result.",
    inputSchema: {
      type: 'object',
      properties: {
        values: {
          type: 'array',
          items: { type: 'string' },
          description: "Array of indicator values (IPv4 addresses, domains, URLs, or hashes) to look up. Max " + IOC_BATCH_MAX + " per call."
        }
      },
      required: ['values']
    }
  },
  {
    name: 'get_threat_actor_profile',
    description: "PG1 Sovereign Threat Intelligence: returns a dossier for a known threat actor / APT group — aliases, description, associated MITRE ATT&CK techniques, and associated malware/tooling. Sourced from MITRE ATT&CK Enterprise. Payment required: $0.01 via x402, sent in params._meta['x402/payment'] (the PAYMENT-SIGNATURE header is also accepted), or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use for actor/group-level profiling. Do NOT use for single-indicator lookups (use get_ioc_context) or vulnerability data (use get_cve_details / get_cve_batch). USAGE EXCLUSIONS: Coverage is limited to groups tracked in MITRE ATT&CK — not all threat actors have an entry. BEHAVIOR: Returns 404 if no matching group or alias is found.",
    inputSchema: {
      type: 'object',
      properties: {
        actor_name: {
          type: 'string',
          description: "Group name or known alias, e.g. 'APT29' or 'Cozy Bear'. Matching is case-insensitive against both the group's primary name and its known aliases."
        }
      },
      required: ['actor_name']
    }
  },
  {
    name: 'get_cve_by_product',
    description: 'PG1 Sovereign Threat Intelligence: returns CVEs affecting a given vendor/product (optionally a specific version), enriched with CVSS, EPSS, and CISA KEV status, sorted by exploitation risk. Sourced from NVD keyword search. Payment required: $0.01 via x402, sent in params._meta["x402/payment"] (the PAYMENT-SIGNATURE header is also accepted), or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use for discovering CVEs by vendor/product when you do not already have an exact CVE id. Do NOT use for a known CVE id (use get_cve_details / get_cve_batch). USAGE EXCLUSIONS: Uses NVD keyword search, not strict CPE matching — results may include near-matches. BEHAVIOR: Returns up to 50 results per call.',
    inputSchema: {
      type: 'object',
      properties: {
        vendor: { type: 'string', description: "Vendor name, e.g. 'apache'." },
        product: { type: 'string', description: "Product name, e.g. 'log4j'." },
        version: { type: 'string', description: "Optional specific version, e.g. '2.14.1'." },
        only_kev: { type: 'boolean', description: 'If true, only return CVEs on the CISA KEV list.' }
      },
      required: ['vendor', 'product']
    }
  },
  {
    name: 'get_usage_status',
    description: 'PG1 Sovereign Threat Intelligence: returns your remaining free-tier calls for today and current Gumroad license status. No payment required — this tool is always free.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Optional — the X-API-KEY or identifier to check usage for; defaults to the calling identifier if omitted.' },
        license_key: { type: 'string', description: 'Optional — check Gumroad license status alongside free-tier usage.' }
      }
    }
  },
  {
    name: 'subscribe_alerts',
    description: "PG1 Sovereign Threat Intelligence: registers a standing filter (indicator type, min EPSS, or KEV-only). Matching new indicators are POSTed to the given webhook URL as they're ingested. Requires a valid Gumroad license key (X-API-KEY header) — this tool is NOT available via per-query x402, since it establishes a recurring subscription rather than a single paid call.",
    inputSchema: {
      type: 'object',
      properties: {
        webhook_url: { type: 'string', description: 'HTTPS URL to receive POSTed alert payloads.' },
        filter: {
          type: 'object',
          description: 'Optional filter object: { indicator_type, min_epss, kev_only }',
          properties: {
            indicator_type: { type: 'string' },
            min_epss: { type: 'number' },
            kev_only: { type: 'boolean' }
          }
        }
      },
      required: ['webhook_url']
    }
  },
  {
    name: 'submit_indicator',
    description: 'PG1 Sovereign Threat Intelligence: submit an observed indicator for validation and possible inclusion in future query results. Requires a valid Gumroad license key (X-API-KEY header) — this tool is NOT available via per-query x402. Submissions are staged for review, not immediately added to the live feed.',
    inputSchema: {
      type: 'object',
      properties: {
        indicator: { type: 'string' },
        indicator_type: { type: 'string' },
        malware_family: { type: 'string', description: 'Optional.' },
        confidence: { type: 'integer', description: "Submitter's own confidence, 0-100." },
        source_note: { type: 'string', description: 'Optional free-text on how this was observed.' }
      },
      required: ['indicator', 'indicator_type']
    }
  },
  {
    name: 'check_wallet_sanctions',
    description: 'PG1 Sovereign Threat Intelligence: checks a cryptocurrency wallet address against the OFAC SDN (Specially Designated Nationals) sanctions list, synced daily from US Treasury data. No payment required — this tool is always free. SIBLING DIFFERENTIATION: Use for wallet/address sanctions screening only. Do NOT use for IP/domain/hash/URL threat lookups (use get_ioc_context) or CVE data (use get_cve_details). BEHAVIOR: Returns { listed: true|false, matches, source, list_last_synced }. A listed:false result means the address is not on the OFAC SDN list as of the reported sync time — it is informational only, not legal or sanctions-compliance advice, and is never phrased as "safe" or "clean". Fails loudly (returns an error) if the sanctions data is empty or unreachable, rather than ever reporting listed:false on a data failure. VALIDATION: if the address does not match a recognised format for any supported currency (EVM, BTC/LTC/BCH/DOGE/DASH/ZEC base58 or bech32/cashaddr, TRON, Monero, Solana), returns an MCP tool error (isError: true, code invalid_address) instead of a result — it never reports listed:false for malformed input.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Mandatory wallet address to screen, e.g. an EVM 0x address, a bech32 (bc1/tb1/ltc1...) address, or a base58 address.' },
        currency: { type: ['string', 'null'], description: "Optional currency/chain filter to narrow the match, e.g. 'BTC', 'ETH', 'XMR'." }
      },
      required: ['address']
    },
    outputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'The address exactly as submitted.' },
        address_normalized: { type: 'string', description: 'The address after normalization, used to match against sanctioned_wallets.' },
        listed: { type: 'boolean' },
        matches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sdn_name: { type: ['string', 'null'] },
              currency: { type: ['string', 'null'] },
              programs: { type: 'array', items: { type: 'string' } },
              sdn_uid: { type: ['string', 'number', 'null'] }
            }
          }
        },
        source: { type: 'string' },
        list_last_synced: { type: 'string' },
        message: { type: 'string' },
        disclaimer: { type: 'string' },
        ...RESPONSE_META_OUTPUT_PROPERTIES,
        ...TEST_FIXTURE_OUTPUT_PROPERTIES
      },
      required: ['address', 'address_normalized', 'listed', 'matches', 'source', 'list_last_synced']
    }
  },
  {
    name: 'check_domain_age',
    description: 'PG1 Sovereign Threat Intelligence: looks up a domain\'s registration age via RDAP (the IANA-standardized WHOIS successor), resolved through the IANA bootstrap registry for the correct per-TLD RDAP server. No payment required — this tool is always free. SIBLING DIFFERENTIATION: Use for domain registration/age checks only. Do NOT use for reputation/threat-feed lookups (use get_ioc_context) or sanctions screening (use check_wallet_sanctions). BEHAVIOR: Returns { found: true, available: true, registration_date, age_days, expiration_date, registrar, newly_registered, source } when available, or { found: false, available: false, reason, reason_code } when the lookup does not resolve — this tool never estimates or guesses an age. "available" is a deprecated alias of "found", kept for backward compatibility. reason_code is "unsupported_tld" when the TLD has no RDAP server in the IANA bootstrap registry, or "timeout" / "lookup_failed" for other lookup failures. A newly registered domain (age_days < 30) is reported as a common phishing signal, not as proof of malicious intent.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: "Mandatory domain name or URL to check, e.g. 'example.com' or 'https://example.com/path'. The registrable domain is extracted automatically." }
      },
      required: ['domain']
    },
    outputSchema: {
      type: 'object',
      properties: {
        found: { type: 'boolean', description: 'Whether a registration record was found. Same meaning as the deprecated "available" field.' },
        available: { type: 'boolean', description: 'Deprecated — use "found" instead. Kept for backward compatibility.' },
        domain: { type: 'string' },
        registration_date: { type: ['string', 'null'] },
        age_days: { type: ['integer', 'null'] },
        expiration_date: { type: ['string', 'null'] },
        registrar: { type: ['string', 'null'] },
        newly_registered: { type: ['boolean', 'null'] },
        note: { type: ['string', 'null'] },
        source: { type: ['string', 'null'] },
        reason: { type: ['string', 'null'] },
        reason_code: { type: ['string', 'null'], enum: ['invalid_domain', 'bootstrap_unavailable', 'unsupported_tld', 'timeout', 'lookup_failed', null] },
        ...RESPONSE_META_OUTPUT_PROPERTIES,
        ...TEST_FIXTURE_OUTPUT_PROPERTIES
      },
      required: ['found', 'available', 'domain']
    }
  },
  {
    name: 'check_hostname_reputation',
    description: 'PG1 Sovereign Threat Intelligence: checks a single hostname against the MetaMask eth-phishing-detect blocklist/allowlist and a lookalike/typosquat detector, synced daily by the sovereign-threat-pipeline. No payment required — this tool is always free. SIBLING DIFFERENTIATION: Use for phishing/lookalike-domain screening of a hostname only. Do NOT use for domain registration age (use check_domain_age), general threat-feed indicator lookups (use get_ioc_context), or wallet sanctions screening (use check_wallet_sanctions). BEHAVIOR: Returns { hostname, verdict, sources, lookalike_of, list_synced_at, checked_at, attribution }. verdict is one of "allowlisted", "listed", "lookalike", or "not_listed" — this tool never returns "safe" or "clean", and a not_listed result means the hostname is not on the eth-phishing-detect lists, not that it is safe. "listed" results include match_type "exact" or "parent_domain" in sources. "lookalike" flags a probable typosquat/homoglyph of a known brand — via confusable-character skeleton matching within the stored tolerance, or a brand keyword embedded with extra words (e.g. metamask-login.com) — even when the hostname itself is not directly listed, and sets lookalike_of to the matched brand domain. A brand\'s own real domain or a subdomain of it is never flagged as its own lookalike. VALIDATION: accepts exactly one bare hostname per call (no bulk input); a value containing a URL scheme, path, port, spaces, or a wildcard returns an MCP tool error (isError: true, code invalid_hostname) instead of a verdict. Fails loudly (returns an error) if the phishing list data is unreachable or times out, rather than ever reporting not_listed on a data failure. Rate-limited to 60 calls/hour per caller when unauthenticated; a valid Gumroad license key (X-API-KEY header) exempts the limit, same as check_domain_age. List contents are never exposed beyond the single matched entry.',
    inputSchema: {
      type: 'object',
      properties: {
        hostname: { type: 'string', description: "Mandatory bare hostname to screen, e.g. 'example.com'. Not a URL — no scheme, path, port, spaces, or wildcards. One hostname per call." }
      },
      required: ['hostname']
    },
    outputSchema: {
      type: 'object',
      properties: {
        hostname: { type: 'string', description: 'The hostname after normalization (trimmed, lowercased, trailing dot stripped, IDN converted to punycode).' },
        verdict: { type: 'string', enum: ['allowlisted', 'listed', 'lookalike', 'not_listed'], description: 'Never "safe" or "clean".' },
        sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              url: { type: ['string', 'null'] },
              match_type: { type: 'string', enum: ['allowlist', 'exact', 'parent_domain', 'confusable', 'keyword'] }
            }
          }
        },
        lookalike_of: { type: ['string', 'null'], description: 'The matched brand/fuzzylist domain for a "lookalike" verdict, otherwise null.' },
        list_synced_at: { type: ['string', 'null'] },
        checked_at: { type: 'string' },
        attribution: { type: 'string' },
        ...RESPONSE_META_OUTPUT_PROPERTIES,
        ...TEST_FIXTURE_OUTPUT_PROPERTIES
      },
      required: ['hostname', 'verdict', 'sources', 'lookalike_of', 'list_synced_at', 'checked_at', 'attribution']
    }
  },
  {
    name: 'check_wallet_age',
    description: 'PG1 Sovereign Threat Intelligence: reports when an EVM wallet address first appeared on a given chain, based on its earliest on-chain transfer history (in or out), plus whether the address is a contract. No payment required — this tool is always free. SIBLING DIFFERENTIATION: Use for wallet age/history only. Do NOT use for sanctions screening (use check_wallet_sanctions), domain age (use check_domain_age), or hostname/phishing reputation (use check_hostname_reputation). BEHAVIOR: Returns { address, chain, found, first_seen, age_days, first_seen_block, first_direction, is_contract, note, source: "on-chain transfer history", cached }. A found:false result (with all other fields null except is_contract) means the address has no transfer history on that chain — a normal, common result for a brand-new or never-used address, not an error, and not evidence of legitimacy either way; this tool reports age and history only. Upstream lookup failures or timeouts return an MCP tool error (isError: true) instead of found:false, since a data-source outage must never be read as "brand-new wallet". VALIDATION: address must be a 0x-prefixed 40-hex-character EVM address (case-insensitive); chain, if given, must be one of the supported enum values. Malformed input returns an MCP tool error (isError: true, code invalid_address or invalid_chain) instead of a result. Rate-limited to 60 calls/hour per caller when unauthenticated; a valid Gumroad license key (X-API-KEY header) exempts the limit, same as check_domain_age. A found result is cached permanently (it never changes); a found:false result is cached for 10 minutes only, since a wallet can become active at any time.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "Mandatory EVM wallet address to check, formatted '0x' followed by 40 hex characters (case-insensitive)." },
        chain: { type: ['string', 'null'], enum: ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'bsc', null], description: "Optional chain to check: 'base', 'ethereum', 'arbitrum', 'optimism', 'polygon', or 'bsc'. Defaults to 'base'.", default: 'base' }
      },
      required: ['address']
    },
    outputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'The address, lowercased.' },
        chain: { type: 'string' },
        found: { type: 'boolean' },
        first_seen: { type: ['string', 'null'], description: 'ISO timestamp of the earliest observed transfer in or out, or null if none found.' },
        age_days: { type: ['integer', 'null'] },
        first_seen_block: { type: ['integer', 'null'] },
        first_direction: { type: ['string', 'null'], enum: ['in', 'out', null] },
        is_contract: { type: 'boolean' },
        delegated: { type: ['boolean', 'null'], description: 'true when the address currently has an EIP-7702 delegation on this chain (its code is exactly 0xef0100 followed by a 20-byte delegate address), false when it does not, null when the code check did not complete. Checked live on every call, never cached. is_contract is unchanged and is still true for a delegated address.' },
        delegate_address: { type: ['string', 'null'], description: 'The lowercased delegate contract address when delegated is true, otherwise null.' },
        note: { type: ['string', 'null'] },
        source: { type: 'string' },
        cached: { type: 'boolean' },
        ...RESPONSE_META_OUTPUT_PROPERTIES,
        ...TEST_FIXTURE_OUTPUT_PROPERTIES
      },
      required: ['address', 'chain', 'found', 'first_seen', 'age_days', 'first_seen_block', 'first_direction', 'is_contract', 'source', 'cached']
    }
  },
  {
    name: 'check_ip_abuse',
    description: 'PG1 Sovereign Threat Intelligence: looks up one public IPv4 or IPv6 address in AbuseIPDB using YOUR OWN AbuseIPDB API key (free or paid), and returns its abuse confidence score and report counts with attribution to AbuseIPDB. BRING YOUR OWN KEY: send the key in the X-AbuseIPDB-Key HTTP request header on /api/mcp or /api/a2a - never as a tool argument. PG1 has no AbuseIPDB key of its own; without the header the call returns an MCP tool error (isError: true, code abuseipdb_key_required) and AbuseIPDB is not contacted. No PG1 payment required - lookups count against your own AbuseIPDB quota. SIBLING DIFFERENTIATION: Use for a live AbuseIPDB report lookup on a single IP only. Do NOT use for PG1\'s own threat-feed lookups (use get_ioc_context), hostnames (use check_hostname_reputation) or domains (use check_domain_age). BEHAVIOR: Returns { ip, abuse_confidence_score, total_reports, distinct_reporters, last_reported_at, country_code, usage_type, isp, domain, is_tor, is_whitelisted, attribution }. A low abuse_confidence_score means few or no reports were received in the window, not that the address is harmless - this tool never returns "safe" or "clean". Results are returned only to the caller whose key was used, are never stored or shared, and are cached in memory for 15 minutes per key. ERRORS (isError: true): abuseipdb_key_required, invalid_abuseipdb_key (AbuseIPDB rejected the key), abuseipdb_rate_limited (your AbuseIPDB quota; retry_after passed through when AbuseIPDB sends it), upstream_unavailable (AbuseIPDB error or timeout), invalid_ip (not exactly one public address: private, reserved or malformed input is rejected without calling AbuseIPDB), invalid_max_age. Rate-limited to 60 calls/hour per caller when unauthenticated; a valid Gumroad license key (X-API-KEY header) exempts the limit.',
    inputSchema: {
      type: 'object',
      properties: {
        ip: { type: 'string', description: "Mandatory single public IPv4 or IPv6 address, e.g. '8.8.8.8' or '2001:4860:4860::8888'. No port, CIDR range, brackets or zone id." },
        max_age_in_days: { type: ['integer', 'null'], minimum: 1, maximum: 365, description: 'Optional reporting window in days, 1 to 365. Only reports from this many days back are counted. Defaults to 90.' }
      },
      required: ['ip']
    },
    outputSchema: {
      type: 'object',
      properties: {
        ip: { type: 'string', description: 'The address checked (IPv6 in canonical compressed lowercase form).' },
        ip_version: { type: 'integer', enum: [4, 6] },
        max_age_in_days: { type: 'integer', minimum: 1, maximum: 365, description: 'The reporting window used.' },
        abuse_confidence_score: { type: ['integer', 'null'], minimum: 0, maximum: 100, description: 'AbuseIPDB abuse confidence score, 0-100. A low score means few or no reports, not that the address is harmless.' },
        total_reports: { type: ['integer', 'null'], description: 'Abuse reports received in the window.' },
        distinct_reporters: { type: ['integer', 'null'], description: 'Distinct users who reported the address in the window.' },
        last_reported_at: { type: ['string', 'null'], description: 'ISO timestamp of the most recent report, or null when there is none.' },
        country_code: { type: ['string', 'null'] },
        usage_type: { type: ['string', 'null'] },
        isp: { type: ['string', 'null'] },
        domain: { type: ['string', 'null'] },
        is_tor: { type: ['boolean', 'null'] },
        is_whitelisted: { type: ['boolean', 'null'] },
        cached: { type: 'boolean', description: 'true when served from the 15-minute in-memory cache for your own key.' },
        note: { type: 'string' },
        attribution: {
          type: 'object',
          description: 'Always present: the data source and a link to its page for this address.',
          properties: {
            text: { type: 'string' },
            url: { type: 'string' }
          },
          required: ['text', 'url']
        },
        ...RESPONSE_META_OUTPUT_PROPERTIES,
        ...TEST_FIXTURE_OUTPUT_PROPERTIES
      },
      required: ['ip', 'ip_version', 'max_age_in_days', 'abuse_confidence_score', 'total_reports', 'distinct_reporters', 'last_reported_at', 'country_code', 'usage_type', 'isp', 'domain', 'is_tor', 'is_whitelisted', 'cached', 'attribution']
    }
  }
];

// ---------------------------------------------------------------------
// get_threat_indicators
// ---------------------------------------------------------------------

async function handleThreatIndicators(args) {
  const { supUrl, supKey } = getSupabaseCreds();

  const minScore = args?.min_score ?? 0;
  const limit = Math.min(parseInt(args?.limit || 500, 10), 1000);
  const since = args?.since;
  const type = args?.type;

  const filters = [
    'select=*',
    `confidence_score=gte.${minScore}`,
    'order=last_seen.desc',
    `limit=${limit}`
  ];
  if (since) filters.push(`last_seen=gte.${since}`);
  if (type) filters.push(`indicator_type=eq.${type}`);

  // Switched-off sources (lib/sourcePolicy.mjs) are dropped inside
  // fetchThreatTelemetry, before and after the query.
  let result;
  try {
    result = await fetchThreatTelemetry(supUrl, supKey, filters);
  } catch (netErr) {
    const err = new Error('Threat data temporarily unavailable, please retry.');
    err.serviceUnavailable = true;
    throw err;
  }
  if (!result.ok) {
    const err = new Error('Threat data temporarily unavailable, please retry.');
    err.serviceUnavailable = true;
    throw err;
  }
  const rows = result.rows;

  const objects = rows.map((record) => {
    if (record.indicator_type === 'CVE') {
      return {
        type: 'vulnerability',
        spec_version: '2.1',
        id: `vulnerability--${crypto.randomUUID()}`,
        created: record.ingested_at || new Date().toISOString(),
        modified: record.last_seen || new Date().toISOString(),
        name: record.value,
        description: `Vulnerability sourced from ${record.verification_source || 'PG1 Sovereign Engine'}.`,
        external_references: [
          { source_name: 'cve', external_id: record.value }
        ]
      };
    }

    const safeValue = String(record.value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const indicatorTypeStr = String(record.indicator_type);
    let pattern = record.stix_pattern;
    if (pattern && String(pattern).startsWith('[custom-object')) pattern = null;
    if (!pattern) {
      if (record.indicator_type === 'IPv4') pattern = `[ipv4-addr:value = '${safeValue}']`;
      else if (record.indicator_type === 'IPv6') pattern = `[ipv6-addr:value = '${safeValue}']`;
      else if (record.indicator_type === 'domain') pattern = `[domain-name:value = '${safeValue}']`;
      else if (record.indicator_type === 'hostname') pattern = `[domain-name:value = '${safeValue}']`;
      else if (record.indicator_type === 'URL') pattern = `[url:value = '${safeValue}']`;
      else if (indicatorTypeStr.includes('FileHash-MD5')) pattern = `[file:hashes.MD5 = '${safeValue}']`;
      else if (indicatorTypeStr.includes('FileHash-SHA1')) pattern = `[file:hashes.'SHA-1' = '${safeValue}']`;
      else if (indicatorTypeStr.includes('FileHash-SHA256')) pattern = `[file:hashes.'SHA-256' = '${safeValue}']`;
      else if (indicatorTypeStr.includes('FileHash')) pattern = `[file:hashes.'SHA-256' = '${safeValue}']`;
      else {
        console.warn(`[STIX] Skipping indicator with unmappable indicator_type: ${indicatorTypeStr}`);
        return null;
      }
    }
    return {
      type: 'indicator',
      spec_version: '2.1',
      id: `indicator--${crypto.randomUUID()}`,
      created: record.ingested_at || new Date().toISOString(),
      modified: record.last_seen || new Date().toISOString(),
      name: `${record.indicator_type} Threat Indicator - ${record.value}`,
      description: `Threat indicator sourced from ${record.verification_source || 'PG1 Sovereign Engine'}.`,
      indicator_types: ['malicious-activity'],
      pattern,
      pattern_type: 'stix',
      valid_from: record.last_seen || new Date().toISOString(),
      confidence: parseInt(record.confidence_score, 10) || 50
    };
  }).filter(Boolean);

  const checks = [buildCheck('threat indicator feed', 'ok')];
  return withResponseMeta({
    type: 'bundle',
    id: `bundle--${crypto.randomUUID()}`,
    spec_version: '2.1',
    objects
  }, { reasons: [], checks });
}

// ---------------------------------------------------------------------
// get_cve_details / get_cve_batch / get_cve_by_product shared helpers
// ---------------------------------------------------------------------

var kevCache = null;
var kevCacheTime = 0;
const KEV_CACHE_TTL_MS = 60 * 60 * 1000;

async function getKevCatalog() {
  const now = Date.now();
  if (kevCache && (now - kevCacheTime) < KEV_CACHE_TTL_MS) return kevCache;
  const res = await fetch('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json');
  if (!res.ok) {
    if (kevCache) return kevCache;
    throw new Error('CISA KEV feed fetch failed: ' + res.status);
  }
  const data = await res.json();
  const map = {};
  (data.vulnerabilities || []).forEach((v) => { map[v.cveID] = v; });
  kevCache = map;
  kevCacheTime = now;
  return kevCache;
}

async function fetchEpssScore(cveId) {
  const res = await fetch(`https://api.first.org/data/v1/epss?cve=${encodeURIComponent(cveId)}`);
  if (!res.ok) return null;
  const data = await res.json();
  const record = data.data && data.data[0];
  if (!record) return null;
  return { epss_score: parseFloat(record.epss), epss_percentile: parseFloat(record.percentile) };
}

async function fetchNvdCveDetails(cveId) {
  const headers = {};
  if (process.env.NVD_API_KEY) headers.apiKey = process.env.NVD_API_KEY;
  const res = await fetch(`https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(cveId)}`, { headers });
  if (!res.ok) throw new Error('NVD lookup failed: ' + res.status);
  const data = await res.json();
  const vuln = data.vulnerabilities?.[0]?.cve;
  if (!vuln) return null;

  const enDesc = (vuln.descriptions || []).find((d) => d.lang === 'en');
  const metrics = vuln.metrics || {};
  let cvssData = null, cvssVersion = null;
  if (metrics.cvssMetricV31?.[0]) { cvssData = metrics.cvssMetricV31[0].cvssData; cvssVersion = '3.1'; }
  else if (metrics.cvssMetricV30?.[0]) { cvssData = metrics.cvssMetricV30[0].cvssData; cvssVersion = '3.0'; }
  else if (metrics.cvssMetricV2?.[0]) { cvssData = metrics.cvssMetricV2[0].cvssData; cvssVersion = '2.0'; }

  return {
    description: enDesc ? enDesc.value : null,
    published: vuln.published,
    last_modified: vuln.lastModified,
    cvss_version: cvssVersion,
    cvss_score: cvssData ? cvssData.baseScore : null,
    cvss_severity: cvssData ? cvssData.baseSeverity : null,
    cvss_vector: cvssData ? cvssData.vectorString : null
  };
}

export async function handleCveDetails(args) {
  const cveId = args?.cve_id;
  if (!cveId || !/^CVE-\d{4}-\d{4,}$/i.test(String(cveId))) {
    const err = invalidInput({
      problem: cveId ? 'cve_id is not a valid CVE identifier' : 'cve_id is missing',
      expected: "a string formatted 'CVE-YYYY-NNNN' (a 4-digit year, then 4 or more digits)",
      example: 'CVE-2021-44228'
    });
    err.notFound = true;
    throw err;
  }
  const normalizedId = String(cveId).toUpperCase();

  const [nvd, epssOutcome, kevOutcome] = await Promise.all([
    fetchNvdCveDetails(normalizedId).catch((e) => ({ error: e.message })),
    fetchEpssScore(normalizedId).then((value) => ({ ok: true, value })).catch(() => ({ ok: false, value: null })),
    getKevCatalog().then((value) => ({ ok: true, value })).catch(() => ({ ok: false, value: {} }))
  ]);

  if (!nvd || nvd.error) {
    const err = new Error(`CVE not found or NVD lookup failed for ${normalizedId}.`);
    err.notFound = true;
    throw err;
  }

  const epss = epssOutcome.value;
  const kevCatalog = kevOutcome.value;
  const kevEntry = kevCatalog[normalizedId];
  const reasons = kevEntry ? [reason('CVE_KNOWN_EXPLOITED_KEV')] : [];
  const checks = [
    buildCheck('vulnerability database', 'ok', { dataAsOf: nvd.last_modified || nvd.published || null }),
    buildCheck('exploit prediction score', epssOutcome.ok ? 'ok' : 'error'),
    buildCheck('known exploited vulnerabilities catalog', kevOutcome.ok ? 'ok' : 'error')
  ];

  return withResponseMeta({
    cve_id: normalizedId,
    nvd: {
      description: nvd.description,
      cvss_v3_score: nvd.cvss_score,
      cvss_vector: nvd.cvss_vector,
      severity: nvd.cvss_severity,
      published: nvd.published,
      last_modified: nvd.last_modified
    },
    epss: epss ? { score: epss.epss_score, percentile: epss.epss_percentile } : null,
    cisa_kev: {
      is_known_exploited: !!kevEntry,
      date_added: kevEntry ? kevEntry.dateAdded : null,
      required_action: kevEntry ? kevEntry.requiredAction : null,
      due_date: kevEntry ? kevEntry.dueDate : null
    }
  }, { reasons, checks });
}

export async function handleCveBatch(args) {
  const cveIds = args?.cve_ids;
  if (!Array.isArray(cveIds) || cveIds.length === 0) {
    throw invalidInput({
      problem: Array.isArray(cveIds) ? 'cve_ids is an empty array' : 'cve_ids is missing or is not an array',
      expected: `a non-empty array of up to ${CVE_BATCH_MAX} CVE id strings, each formatted 'CVE-YYYY-NNNN'`,
      example: '["CVE-2021-44228", "CVE-2023-4863"]'
    });
  }
  if (cveIds.length > CVE_BATCH_MAX) {
    throw invalidInput({
      problem: `cve_ids has ${cveIds.length} entries, more than the maximum batch size of ${CVE_BATCH_MAX}`,
      expected: `at most ${CVE_BATCH_MAX} CVE ids per call (split larger lists into several calls)`,
      example: '["CVE-2021-44228", "CVE-2023-4863"]'
    });
  }

  const kevOutcome = await getKevCatalog().then((value) => ({ ok: true, value })).catch(() => ({ ok: false, value: {} }));
  const kevCatalog = kevOutcome.value;
  let anyEpssFailed = false;

  const results = await Promise.all(cveIds.map(async (rawId) => {
    const cveId = String(rawId || '').toUpperCase();
    if (!/^CVE-\d{4}-\d{4,}$/i.test(cveId)) {
      return { cve_id: rawId, found: false, error: "Malformed CVE id — expected 'CVE-YYYY-NNNN'." };
    }

    const [nvd, epssOutcome] = await Promise.all([
      fetchNvdCveDetails(cveId).catch((e) => ({ error: e.message })),
      fetchEpssScore(cveId).then((value) => ({ ok: true, value })).catch(() => ({ ok: false, value: null }))
    ]);
    if (!epssOutcome.ok) anyEpssFailed = true;
    const epss = epssOutcome.value;

    if (!nvd || nvd.error) {
      return { cve_id: cveId, found: false, error: nvd?.error || 'CVE not found in NVD.' };
    }

    const kevEntry = kevCatalog[cveId];

    return {
      cve_id: cveId,
      found: true,
      nvd: {
        description: nvd.description,
        cvss_v3_score: nvd.cvss_score,
        cvss_vector: nvd.cvss_vector,
        severity: nvd.cvss_severity,
        published: nvd.published
      },
      epss: epss ? { score: epss.epss_score, percentile: epss.epss_percentile } : null,
      cisa_kev: {
        is_known_exploited: !!kevEntry,
        due_date: kevEntry ? kevEntry.dueDate : null
      }
    };
  }));

  const anyKev = results.some((r) => r.cisa_kev?.is_known_exploited);
  const reasons = anyKev ? [reason('CVE_KNOWN_EXPLOITED_KEV')] : [];
  const checks = [
    buildCheck('vulnerability database', 'ok'),
    buildCheck('exploit prediction score', anyEpssFailed ? 'error' : 'ok'),
    buildCheck('known exploited vulnerabilities catalog', kevOutcome.ok ? 'ok' : 'error')
  ];

  return withResponseMeta({
    total_requested: cveIds.length,
    total_found: results.filter((r) => r.found).length,
    results
  }, { reasons, checks });
}

export async function handleCveByProduct(args) {
  const vendor = args?.vendor;
  const product = args?.product;
  const version = args?.version;
  const onlyKev = !!args?.only_kev;

  if (!vendor || !product) {
    const missing = [!vendor && 'vendor', !product && 'product'].filter(Boolean).join(' and ');
    throw invalidInput({
      problem: `${missing} ${missing.includes(' and ') ? 'are' : 'is'} missing`,
      expected: 'vendor and product as non-empty strings; version (string) and only_kev (boolean) are optional',
      example: '{"vendor": "apache", "product": "log4j", "version": "2.14.1"}'
    });
  }

  const keywords = [vendor, product, version].filter(Boolean).join(' ');
  const headers = {};
  if (process.env.NVD_API_KEY) headers.apiKey = process.env.NVD_API_KEY;

  const nvdRes = await fetch(`https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(keywords)}&resultsPerPage=50`, { headers });
  if (!nvdRes.ok) throw new Error('NVD lookup failed: ' + nvdRes.status);
  const nvdData = await nvdRes.json();
  const vulns = (nvdData.vulnerabilities || []).map((v) => v.cve).filter(Boolean);

  if (!vulns.length) {
    const checks = [buildCheck('vulnerability database', 'ok')];
    return withResponseMeta({ vendor, product, version: version || null, total_found: 0, cves: [] }, { reasons: [], checks });
  }

  const kevOutcome = await getKevCatalog().then((value) => ({ ok: true, value })).catch(() => ({ ok: false, value: {} }));
  const kevCatalog = kevOutcome.value;
  let anyEpssFailed = false;

  const enriched = await Promise.all(vulns.map(async (vuln) => {
    const cveId = vuln.id;
    const enDesc = (vuln.descriptions || []).find((d) => d.lang === 'en');
    const metrics = vuln.metrics || {};
    let cvssData = null, cvssVersion = null;
    if (metrics.cvssMetricV31?.[0]) { cvssData = metrics.cvssMetricV31[0].cvssData; cvssVersion = '3.1'; }
    else if (metrics.cvssMetricV30?.[0]) { cvssData = metrics.cvssMetricV30[0].cvssData; cvssVersion = '3.0'; }
    else if (metrics.cvssMetricV2?.[0]) { cvssData = metrics.cvssMetricV2[0].cvssData; cvssVersion = '2.0'; }

    const epssOutcome = await fetchEpssScore(cveId).then((value) => ({ ok: true, value })).catch(() => ({ ok: false, value: null }));
    if (!epssOutcome.ok) anyEpssFailed = true;
    const epss = epssOutcome.value;
    const kevEntry = kevCatalog[cveId];

    return {
      cve_id: cveId,
      description: enDesc ? enDesc.value : null,
      published: vuln.published,
      cvss: cvssData ? { version: cvssVersion, score: cvssData.baseScore, severity: cvssData.baseSeverity } : null,
      epss: epss ? { score: epss.epss_score, percentile: epss.epss_percentile } : null,
      is_known_exploited: !!kevEntry,
      kev_due_date: kevEntry ? kevEntry.dueDate : null
    };
  }));

  const filtered = onlyKev ? enriched.filter((c) => c.is_known_exploited) : enriched;
  filtered.sort((a, b) => {
    if (a.is_known_exploited !== b.is_known_exploited) return a.is_known_exploited ? -1 : 1;
    const epssA = a.epss?.score || 0, epssB = b.epss?.score || 0;
    if (epssA !== epssB) return epssB - epssA;
    const cvssA = a.cvss?.score || 0, cvssB = b.cvss?.score || 0;
    return cvssB - cvssA;
  });

  const anyKev = filtered.some((c) => c.is_known_exploited);
  const reasons = anyKev ? [reason('CVE_KNOWN_EXPLOITED_KEV')] : [];
  const checks = [
    buildCheck('vulnerability database', 'ok'),
    buildCheck('exploit prediction score', anyEpssFailed ? 'error' : 'ok'),
    buildCheck('known exploited vulnerabilities catalog', kevOutcome.ok ? 'ok' : 'error')
  ];

  return withResponseMeta({ vendor, product, version: version || null, total_found: filtered.length, cves: filtered }, { reasons, checks });
}

// ---------------------------------------------------------------------
// get_ioc_context / get_ioc_batch shared helpers
// ---------------------------------------------------------------------

const IOC_VALUE_FIX_IT = {
  problem: 'value is missing or empty',
  expected: 'a single indicator string: an IPv4 address, domain, full URL, or MD5/SHA-1/SHA-256 hash',
  example: '198.51.100.1'
};

export async function handleIocContext(args) {
  const value = args?.value?.trim();
  if (!value) {
    throw invalidInput(IOC_VALUE_FIX_IT);
  }

  const { supUrl, supKey } = getSupabaseCreds();
  const lookupResult = await lookupIocContext(value, supUrl, supKey);
  return withIocResponseMeta(lookupResult);
}

// Shared by both get_ioc_context call sites (the dispatch special case below
// calls lookupIocContext directly, this helper wraps handleIocContext's and
// handleIocBatch's own use of it) - found:true is the flag (a real record
// exists in the feed); found:false already completed the check and simply
// has nothing to report, so it's a clean no_flags, not unknown.
function withIocResponseMeta(lookupResult) {
  const reasons = lookupResult.found ? [reason('IOC_FOUND_IN_THREAT_FEED')] : [];
  const checks = [buildCheck('threat indicator feed', 'ok')];
  return withResponseMeta(lookupResult, { reasons, checks });
}

export async function handleIocBatch(args) {
  const values = args?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw invalidInput({
      problem: Array.isArray(values) ? 'values is an empty array' : 'values is missing or is not an array',
      expected: `a non-empty array of up to ${IOC_BATCH_MAX} indicator strings (IPv4 addresses, domains, URLs, or hashes)`,
      example: '["198.51.100.1", "example.com"]'
    });
  }
  if (values.length > IOC_BATCH_MAX) {
    throw invalidInput({
      problem: `values has ${values.length} entries, more than the maximum batch size of ${IOC_BATCH_MAX}`,
      expected: `at most ${IOC_BATCH_MAX} indicators per call (split larger lists into several calls)`,
      example: '["198.51.100.1", "example.com"]'
    });
  }

  const { supUrl, supKey } = getSupabaseCreds();

  const results = await Promise.all(values.map(async (rawValue) => {
    const value = String(rawValue || '').trim();
    if (!value) {
      return { indicator: rawValue, found: false, error: 'Empty indicator value.' };
    }
    return await lookupIocContext(value, supUrl, supKey);
  }));

  const totalFound = results.filter((r) => r.found).length;
  const reasons = totalFound > 0 ? [reason('IOC_FOUND_IN_THREAT_FEED', `${totalFound} of ${values.length} submitted indicators have a matching record in the threat indicator feed.`)] : [];
  const checks = [buildCheck('threat indicator feed', 'ok')];

  return withResponseMeta({
    total_requested: values.length,
    total_found: totalFound,
    results
  }, { reasons, checks });
}

// ---------------------------------------------------------------------
// get_threat_actor_profile
// ---------------------------------------------------------------------

let attackCache = null;
let attackCacheTime = 0;
const ATTACK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getAttackBundle() {
  const now = Date.now();
  if (attackCache && (now - attackCacheTime) < ATTACK_CACHE_TTL_MS) return attackCache;

  const res = await fetch('https://raw.githubusercontent.com/mitre/cti/master/enterprise-attack/enterprise-attack.json');
  if (!res.ok) {
    if (attackCache) return attackCache;
    throw new Error('MITRE ATT&CK STIX bundle fetch failed: ' + res.status);
  }
  const bundle = await res.json();
  attackCache = bundle;
  attackCacheTime = now;
  return attackCache;
}

export async function handleThreatActorProfile(args) {
  const actorName = args?.actor_name?.trim();
  if (!actorName) {
    throw invalidInput({
      problem: 'actor_name is missing or empty',
      expected: 'a threat actor group name or known alias (matched case-insensitively)',
      example: 'APT29'
    });
  }

  const bundle = await getAttackBundle();
  const objects = bundle.objects || [];
  const needle = actorName.toLowerCase();

  const group = objects.find((o) => {
    if (o.type !== 'intrusion-set') return false;
    if ((o.name || '').toLowerCase() === needle) return true;
    const aliases = (o.aliases || []).map((a) => a.toLowerCase());
    return aliases.includes(needle);
  });

  if (!group) {
    const err = new Error(`No ATT&CK group found matching '${actorName}'.`);
    err.notFound = true;
    throw err;
  }

  const attackId = (group.external_references || []).find((r) => r.source_name === 'mitre-attack');
  const relationships = objects.filter((o) => o.type === 'relationship' && o.source_ref === group.id);

  const techniquesById = {};
  const softwareById = {};
  objects.forEach((o) => {
    if (o.type === 'attack-pattern') {
      const ref = (o.external_references || []).find((r) => r.source_name === 'mitre-attack');
      if (ref) techniquesById[o.id] = { technique_id: ref.external_id, name: o.name };
    }
    if (o.type === 'malware' || o.type === 'tool') {
      softwareById[o.id] = { name: o.name, type: o.type };
    }
  });

  const techniques = [];
  const software = [];
  relationships.forEach((rel) => {
    if (rel.relationship_type === 'uses') {
      if (techniquesById[rel.target_ref]) techniques.push(techniquesById[rel.target_ref]);
      if (softwareById[rel.target_ref]) software.push(softwareById[rel.target_ref]);
    }
  });

  return withResponseMeta({
    actor_name: group.name,
    attack_group_id: attackId ? attackId.external_id : null,
    aliases: group.aliases || [],
    description: group.description || null,
    associated_techniques: techniques,
    associated_software: software,
    source: 'MITRE ATT&CK Enterprise'
  }, { reasons: [], checks: [buildCheck('threat actor intelligence', 'ok')] });
}

// ---------------------------------------------------------------------
// get_usage_status — free, no payment gate
// ---------------------------------------------------------------------

export async function handleUsageStatus(args, requestIdentifier) {
  const identifier = args?.identifier || requestIdentifier;
  if (!identifier) {
    throw invalidInput({
      problem: 'identifier is missing and could not be derived from the request',
      expected: 'an identifier string, or omit it and call from a normal HTTP client so the caller can be identified',
      example: '{"identifier": "my-agent-01"}'
    });
  }

  const { supUrl, supKey } = getSupabaseCreds();
  const today = new Date().toISOString().slice(0, 10);

  let res;
  try {
    res = await fetch(
      `${supUrl}/rest/v1/free_tier_usage?identifier=eq.${encodeURIComponent(identifier)}&usage_date=eq.${today}&select=request_count`,
      { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } }
    );
  } catch (netErr) {
    const err = new Error('Threat data temporarily unavailable, please retry.');
    err.serviceUnavailable = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error('Threat data temporarily unavailable, please retry.');
    err.serviceUnavailable = true;
    throw err;
  }
  const rows = await res.json();
  const callsToday = rows.length ? (rows[0].request_count || 0) : 0;
  const remaining = Math.max(0, FREE_TIER_DAILY_LIMIT - callsToday);

  let licenseStatus = null;
  const checks = [buildCheck('usage records', 'ok')];
  if (args?.license_key) {
    const check = await verifyGumroadLicense(args.license_key).catch(() => ({ valid: false, error: 'check failed' }));
    licenseStatus = check.valid ? 'active' : 'invalid_or_expired';
    checks.push(buildCheck('license verification', 'ok'));
  }

  return withResponseMeta({
    identifier,
    free_tier_daily_limit: FREE_TIER_DAILY_LIMIT,
    free_tier_calls_used_today: callsToday,
    free_tier_calls_remaining_today: remaining,
    license_status: licenseStatus,
    checked_at: new Date().toISOString()
  }, { reasons: [], checks });
}

// ---------------------------------------------------------------------
// subscribe_alerts — license-key-only, writes a subscription row
// ---------------------------------------------------------------------

async function handleSubscribeAlerts(args, licenseKey) {
  const webhookUrl = args?.webhook_url;
  if (!webhookUrl || !/^https:\/\//i.test(webhookUrl)) {
    throw invalidInput({
      problem: webhookUrl ? 'webhook_url is not an https:// URL' : 'webhook_url is missing',
      expected: 'an absolute URL starting with https://',
      example: 'https://hooks.example.com/pg1-alerts'
    });
  }
  if (!licenseKey) {
    throw new Error('subscribe_alerts requires a valid Gumroad license key — not available via per-query x402.');
  }

  const { supUrl, supKey } = getSupabaseCreds();
  const filter = args?.filter || {};

  const insertRes = await fetch(`${supUrl}/rest/v1/alert_subscriptions`, {
    method: 'POST',
    headers: {
      apikey: supKey,
      Authorization: `Bearer ${supKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify({ webhook_url: webhookUrl, filter, license_key: licenseKey })
  });

  if (!insertRes.ok) {
    throw new Error('Failed to create subscription: ' + insertRes.status);
  }
  const inserted = await insertRes.json();

  // No honest-status `status` field here: this tool already has its own
  // `status` ('active') meaning a subscription lifecycle state, and the
  // "additive only, never repurpose an existing field" rule wins - see the
  // PR description for issue #215.
  return withActionResponseMeta({
    subscription_id: inserted[0]?.id,
    webhook_url: webhookUrl,
    filter,
    status: 'active',
    created_at: inserted[0]?.created_at
  }, { reasons: [], checks: [buildCheck('alert subscription store', 'ok')] });
}

// ---------------------------------------------------------------------
// submit_indicator — license-key-only, writes to a staging table
// ---------------------------------------------------------------------

async function handleSubmitIndicator(args, licenseKey) {
  const indicator = args?.indicator;
  const indicatorType = args?.indicator_type;
  if (!indicator || !indicatorType) {
    const missing = [!indicator && 'indicator', !indicatorType && 'indicator_type'].filter(Boolean).join(' and ');
    throw invalidInput({
      problem: `${missing} ${missing.includes(' and ') ? 'are' : 'is'} missing`,
      expected: 'indicator and indicator_type as non-empty strings; malware_family, confidence (0-100) and source_note are optional',
      example: '{"indicator": "198.51.100.1", "indicator_type": "IPv4"}'
    });
  }
  if (!licenseKey) {
    throw new Error('submit_indicator requires a valid Gumroad license key — contribution is a paid-tier feature.');
  }

  const { supUrl, supKey } = getSupabaseCreds();

  const dupCheck = await fetch(
    `${supUrl}/rest/v1/submitted_indicators_staging?indicator=eq.${encodeURIComponent(indicator)}&reviewed=eq.false&select=id`,
    { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } }
  );
  const dupRows = dupCheck.ok ? await dupCheck.json() : [];
  if (dupRows.length) {
    return withActionResponseMeta(
      { status: 'duplicate_pending_review', indicator, staging_id: dupRows[0].id },
      { reasons: [], checks: [buildCheck('indicator submission queue', 'ok')] }
    );
  }

  const insertRes = await fetch(`${supUrl}/rest/v1/submitted_indicators_staging`, {
    method: 'POST',
    headers: {
      apikey: supKey,
      Authorization: `Bearer ${supKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify({
      indicator,
      indicator_type: indicatorType,
      malware_family: args?.malware_family || null,
      confidence: args?.confidence || null,
      source_note: args?.source_note || null,
      submitted_by: licenseKey.slice(0, 8) + '…'
    })
  });

  if (!insertRes.ok) throw new Error('Failed to submit indicator: ' + insertRes.status);
  const inserted = await insertRes.json();

  // No honest-status `status` field: same reason as handleSubscribeAlerts
  // above - this tool already has its own `status` field meaning a
  // submission lifecycle state.
  return withActionResponseMeta(
    { status: 'submitted_pending_review', indicator, staging_id: inserted[0]?.id },
    { reasons: [], checks: [buildCheck('indicator submission queue', 'ok')] }
  );
}

// ---------------------------------------------------------------------
// check_wallet_sanctions — free, no payment gate
// ---------------------------------------------------------------------

const SANCTIONS_DISCLAIMER = 'Informational only; not legal or sanctions-compliance advice.';
const SANCTIONS_SOURCE = 'OFAC SDN List (US Treasury)';

// The three invalid-input tool error classes below take fix-it parts
// ({ problem, expected, example }, see lib/invalidInput.mjs), never a
// message built from the caller's raw input.
class InvalidAddressError extends Error {
  constructor(fixIt) {
    super('');
    withFixIt(this, fixIt);
    this.name = 'InvalidAddressError';
    this.mcpToolError = true;
    this.code = 'invalid_address';
  }
}

const SANCTIONS_ADDRESS_FIX_IT = {
  problem: 'address does not match any recognised wallet address format; not screened',
  expected: 'a wallet address in a recognised format: EVM (0x + 40 hex characters), BTC/LTC/BCH/DOGE/DASH/ZEC base58 or bech32/cashaddr, TRON, Monero, or Solana base58',
  example: FIXTURE_VALUES.wallet.CLEAN
};

export async function handleCheckWalletSanctions(args) {
  const rawAddress = args?.address;
  if (typeof rawAddress !== 'string') {
    throw invalidInput({ problem: 'address is missing or is not a string', expected: SANCTIONS_ADDRESS_FIX_IT.expected, example: SANCTIONS_ADDRESS_FIX_IT.example });
  }
  if (!rawAddress.trim()) {
    throw new InvalidAddressError({ ...SANCTIONS_ADDRESS_FIX_IT, problem: 'address is empty; not screened' });
  }
  const currency = args?.currency ? String(args.currency).trim() : null;
  const normalized = normalizeWalletAddress(rawAddress);

  const { supUrl, supKey } = getSupabaseCreds();

  // Also doubles as an empty-table check: if the sanctions list itself has
  // zero rows, that's a data-quality failure, not a clean address — fail
  // loudly rather than silently reporting listed:false (see issue 93).
  let syncRes;
  try {
    syncRes = await fetch(
      `${supUrl}/rest/v1/sanctioned_wallets?select=updated_at&order=updated_at.desc&limit=1`,
      { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } }
    );
  } catch (netErr) {
    const err = new Error('Sanctions data temporarily unavailable, please retry.');
    err.serviceUnavailable = true;
    throw err;
  }
  if (!syncRes.ok) {
    const err = new Error('Sanctions data temporarily unavailable, please retry.');
    err.serviceUnavailable = true;
    throw err;
  }
  const syncRows = await syncRes.json();
  if (!syncRows.length) {
    throw new Error('Sanctioned wallets list is empty or unavailable — refusing to report a result.');
  }
  const listLastSynced = syncRows[0].updated_at;

  const filters = [`address_normalized=eq.${encodeURIComponent(normalized)}`, 'select=*'];
  if (currency) filters.push(`currency=eq.${encodeURIComponent(currency)}`);

  let res;
  try {
    res = await fetch(`${supUrl}/rest/v1/sanctioned_wallets?${filters.join('&')}`, {
      headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }
    });
  } catch (netErr) {
    const err = new Error('Sanctions data temporarily unavailable, please retry.');
    err.serviceUnavailable = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error('Sanctions data temporarily unavailable, please retry.');
    err.serviceUnavailable = true;
    throw err;
  }
  const rows = await res.json();

  if (!rows.length) {
    // Only reject unrecognised formats once we know they're not already a
    // sanctioned entry — a match against the live table always wins over
    // the format heuristic (see issue #106 follow-up).
    if (!isRecognizedWalletAddress(rawAddress)) {
      throw new InvalidAddressError(SANCTIONS_ADDRESS_FIX_IT);
    }
    return withResponseMeta({
      address: rawAddress,
      address_normalized: normalized,
      listed: false,
      matches: [],
      source: SANCTIONS_SOURCE,
      list_last_synced: listLastSynced,
      message: `Not on the OFAC SDN sanctions list as of ${listLastSynced}.`,
      disclaimer: SANCTIONS_DISCLAIMER
    }, { reasons: [], checks: [buildCheck('sanctions list', 'ok', { dataAsOf: listLastSynced })] });
  }

  return withResponseMeta({
    address: rawAddress,
    address_normalized: normalized,
    listed: true,
    matches: rows.map((r) => ({
      sdn_name: r.sdn_name,
      currency: r.currency,
      programs: r.programs || [],
      sdn_uid: r.sdn_uid
    })),
    source: SANCTIONS_SOURCE,
    list_last_synced: listLastSynced,
    disclaimer: SANCTIONS_DISCLAIMER
  }, { reasons: [reason('WALLET_SANCTIONED')], checks: [buildCheck('sanctions list', 'ok', { dataAsOf: listLastSynced })] });
}

// ---------------------------------------------------------------------
// check_domain_age — free, no payment gate
// ---------------------------------------------------------------------

let rdapBootstrapCache = null;
let rdapBootstrapCacheTime = 0;
const RDAP_BOOTSTRAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RDAP_LOOKUP_TIMEOUT_MS = 5000;

// In-memory cache of successful lookups, keyed by registrable domain. Lookup
// failures (timeouts, unsupported TLD, etc.) are deliberately not cached, so
// a transient blip doesn't turn into a day-long outage for that domain.
const RDAP_RESULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const rdapResultCache = new Map();

function getCachedDomainResult(registrable) {
  const entry = rdapResultCache.get(registrable);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    rdapResultCache.delete(registrable);
    return null;
  }
  return entry.result;
}

function setCachedDomainResult(registrable, result) {
  rdapResultCache.set(registrable, { result, expiresAt: Date.now() + RDAP_RESULT_CACHE_TTL_MS });
}

// Per-IP fixed-window rate limit so unauthenticated callers can't hammer
// public RDAP servers through PG1. Callers with a valid Gumroad license key
// are exempt (see handleCheckDomainAge) — the limit only protects against
// anonymous abuse, not legitimate licensed usage.
// DOMAIN_AGE_RATE_LIMIT_MAX lives in lib/x402Config.mjs (the chat quotes it).
const DOMAIN_AGE_RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MS;
const domainAgeRateLimitState = new Map();

class RateLimitedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitedError';
    this.mcpToolError = true;
    this.code = 'rate_limited';
  }
}

function enforceDomainAgeRateLimit(identifier) {
  const now = Date.now();
  const key = identifier || 'unknown';
  const state = domainAgeRateLimitState.get(key);
  if (!state || (now - state.windowStart) >= DOMAIN_AGE_RATE_LIMIT_WINDOW_MS) {
    domainAgeRateLimitState.set(key, { count: 1, windowStart: now });
    return;
  }
  if (state.count >= DOMAIN_AGE_RATE_LIMIT_MAX) {
    const retryAfterMin = Math.ceil((DOMAIN_AGE_RATE_LIMIT_WINDOW_MS - (now - state.windowStart)) / 60000);
    throw new RateLimitedError(
      `check_domain_age is limited to ${DOMAIN_AGE_RATE_LIMIT_MAX} calls/hour per caller to avoid overloading public RDAP servers. Retry in about ${retryAfterMin} minute(s), or use a Gumroad license key (X-API-KEY) to bypass this limit.`
    );
  }
  state.count += 1;
}

async function getRdapBootstrap() {
  const now = Date.now();
  if (rdapBootstrapCache && (now - rdapBootstrapCacheTime) < RDAP_BOOTSTRAP_CACHE_TTL_MS) return rdapBootstrapCache;
  const res = await fetch('https://data.iana.org/rdap/dns.json');
  if (!res.ok) {
    if (rdapBootstrapCache) return rdapBootstrapCache;
    throw new Error('IANA RDAP bootstrap fetch failed: ' + res.status);
  }
  const data = await res.json();
  const map = {};
  (data.services || []).forEach(([tlds, servers]) => {
    (tlds || []).forEach((tld) => {
      if (servers && servers.length && !map[tld.toLowerCase()]) map[tld.toLowerCase()] = servers[0];
    });
  });
  rdapBootstrapCache = map;
  rdapBootstrapCacheTime = now;
  return rdapBootstrapCache;
}

function extractRegistrarName(entities) {
  for (const entity of entities || []) {
    if (!(entity.roles || []).includes('registrar')) continue;
    const vcard = entity.vcardArray && entity.vcardArray[1];
    if (Array.isArray(vcard)) {
      const fnEntry = vcard.find((item) => item[0] === 'fn');
      if (fnEntry && fnEntry[3]) return fnEntry[3];
    }
    if (entity.handle) return entity.handle;
  }
  return null;
}

// A source that never resolved at all ('timeout'/'bootstrap_unavailable'/
// 'lookup_failed') means the check errored or timed out; 'invalid_domain'/
// 'unsupported_tld' mean the check was never attempted (bad input, or a TLD
// this tool has no RDAP server for) - either way, a found:false RDAP result
// is never a clean "no_flags", since we genuinely don't know the domain's
// age (see issue #215's honest-status rule).
function domainAgeCheckResult(reasonCode) {
  if (reasonCode === 'timeout') return 'timeout';
  if (reasonCode === 'bootstrap_unavailable' || reasonCode === 'lookup_failed') return 'error';
  return 'skipped';
}

function domainNotFound(domain, reasonText, reasonCode) {
  const checks = [buildCheck('domain registration records', domainAgeCheckResult(reasonCode))];
  return withResponseMeta({ found: false, available: false, domain, reason: reasonText, reason_code: reasonCode }, { reasons: [], checks });
}

export async function handleCheckDomainAge(args, identifier, licenseKey, { licensed: callerLicensed = false } = {}) {
  const raw = args?.domain;
  if (!raw || typeof raw !== 'string') {
    throw invalidInput({
      problem: 'domain is missing or is not a string',
      expected: 'a domain name or URL; the registrable domain is extracted automatically',
      example: 'example.com'
    });
  }

  const registrable = extractRegistrableDomain(raw);
  if (!registrable) {
    return domainNotFound(raw, 'Could not extract a registrable domain from the provided value.', 'invalid_domain');
  }

  const cached = getCachedDomainResult(registrable);
  if (cached) return cached;

  let licensed = callerLicensed === true;
  if (!licensed && licenseKey) {
    const check = await verifyGumroadLicense(licenseKey).catch(() => ({ valid: false }));
    licensed = !!check.valid;
  }
  if (!licensed) {
    enforceDomainAgeRateLimit(identifier);
  }

  let bootstrap;
  try {
    bootstrap = await getRdapBootstrap();
  } catch (e) {
    return domainNotFound(registrable, 'IANA RDAP bootstrap file unavailable: ' + e.message, 'bootstrap_unavailable');
  }

  const tld = registrable.split('.').pop().toLowerCase();
  const server = bootstrap[tld];
  if (!server) {
    return domainNotFound(registrable, `No RDAP server registered for the '.${tld}' TLD in the IANA bootstrap file.`, 'unsupported_tld');
  }

  const serverBase = server.endsWith('/') ? server : server + '/';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RDAP_LOOKUP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${serverBase}domain/${encodeURIComponent(registrable)}`, { signal: controller.signal });
  } catch (e) {
    return e.name === 'AbortError'
      ? domainNotFound(registrable, 'RDAP lookup timed out after 5 seconds.', 'timeout')
      : domainNotFound(registrable, 'RDAP lookup failed: ' + e.message, 'lookup_failed');
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    return domainNotFound(registrable, `RDAP server responded with ${res.status} for '${registrable}'.`, 'lookup_failed');
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return domainNotFound(registrable, 'RDAP response was not valid JSON.', 'lookup_failed');
  }

  const events = data.events || [];
  const registrationEvent = events.find((e) => e.eventAction === 'registration');
  if (!registrationEvent || !registrationEvent.eventDate) {
    return domainNotFound(registrable, `RDAP response for '${registrable}' did not include a registration event.`, 'lookup_failed');
  }
  const expirationEvent = events.find((e) => e.eventAction === 'expiration');

  const registrationDate = registrationEvent.eventDate;
  const ageDays = Math.floor((Date.now() - new Date(registrationDate).getTime()) / (24 * 60 * 60 * 1000));
  const newlyRegistered = ageDays < 30;
  const serverHost = new URL(serverBase).host;

  const result = withResponseMeta({
    found: true,
    available: true,
    domain: registrable,
    registration_date: registrationDate,
    age_days: ageDays,
    expiration_date: expirationEvent ? expirationEvent.eventDate : null,
    registrar: extractRegistrarName(data.entities),
    newly_registered: newlyRegistered,
    note: newlyRegistered
      ? `This domain was registered ${ageDays} day(s) ago — a common phishing signal, not proof of malicious intent.`
      : null,
    source: `RDAP (${serverHost})`
  }, {
    reasons: newlyRegistered ? [reason('DOMAIN_NEWLY_REGISTERED_30D')] : [],
    checks: [buildCheck('domain registration records', 'ok', { dataAsOf: registrationDate })]
  });
  setCachedDomainResult(registrable, result);
  return result;
}

// ---------------------------------------------------------------------
// check_hostname_reputation — free, no payment gate
// ---------------------------------------------------------------------

const PHISHING_SOURCE_NAME = 'MetaMask eth-phishing-detect';
const PHISHING_SOURCE_URL = 'https://github.com/MetaMask/eth-phishing-detect';
const PHISHING_ATTRIBUTION = `Blocklist/allowlist/fuzzylist data sourced from ${PHISHING_SOURCE_NAME} (${PHISHING_SOURCE_URL}), used under the Don't Be A Dick (DBAD) Public License.`;
const LOOKALIKE_SOURCE_NAME = 'PG1 lookalike detection';
const DEFAULT_FUZZY_TOLERANCE = 3;
const MIN_BRAND_LABEL_LENGTH = 5;

class InvalidHostnameError extends Error {
  constructor(problem) {
    super('');
    withFixIt(this, { problem, expected: HOSTNAME_EXPECTED, example: 'example.com' });
    this.name = 'InvalidHostnameError';
    this.mcpToolError = true;
    this.code = 'invalid_hostname';
  }
}

const HOSTNAME_EXPECTED = 'one bare hostname: letters, digits, hyphens and dots only (IDN allowed), with no scheme, path, port, spaces or wildcards';

// Trim, lowercase, strip a trailing dot, convert IDN to punycode. Rejects
// anything containing a scheme, path, port, spaces, or wildcards — this is a
// single bare-hostname check, never a bulk/URL input (see issue #121).
function normalizeHostname(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new InvalidHostnameError('hostname is missing, empty, or not a string');
  }
  const original = raw.trim();
  if (/\s/.test(original)) {
    throw new InvalidHostnameError('hostname contains whitespace (only one hostname per call, not a list)');
  }
  if (original.includes('*')) {
    throw new InvalidHostnameError("hostname contains a wildcard ('*'), which is not supported");
  }
  if (original.includes('/') || original.includes('\\')) {
    throw new InvalidHostnameError('hostname contains a slash, so it looks like a URL or path rather than a bare hostname (strip any scheme and path)');
  }
  if (original.includes(':')) {
    throw new InvalidHostnameError('hostname contains a colon (a URL scheme or a port)');
  }

  let h = original.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) {
    throw new InvalidHostnameError('hostname is empty after removing the trailing dot');
  }

  let ascii;
  try {
    ascii = domainToASCII(h);
  } catch {
    ascii = '';
  }
  if (!ascii || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(ascii)) {
    throw new InvalidHostnameError('hostname contains characters or labels that are not valid in a hostname');
  }
  return ascii;
}

// The hostname itself plus every parent domain, most-specific first, down to
// (and including) the bare TLD — queried in a single "in" filter. A bare TLD
// candidate is harmless: it will never match a real phishing_domains row.
function hostnameAndParents(hostname) {
  const labels = hostname.split('.');
  const candidates = [];
  for (let i = 0; i < labels.length; i++) {
    candidates.push(labels.slice(i).join('.'));
  }
  return candidates;
}

const CONFUSABLE_MAP = {
  // Cyrillic lookalikes
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
  'і': 'i', 'ѕ': 's', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b',
  'ԁ': 'd', 'ѡ': 'w', 'ɡ': 'g', 'ϳ': 'j', 'ⅰ': 'i',
  // Greek lookalikes
  'α': 'a', 'ο': 'o', 'ρ': 'p', 'υ': 'y', 'ν': 'v', 'κ': 'k',
  'ι': 'i', 'η': 'n', 'τ': 't', 'ε': 'e', 'β': 'b', 'χ': 'x'
};

// Decode punycode back to unicode, map common confusable letters to their
// ASCII lookalike, then fold 0->o, 1->l, and rn->m (see issue #121).
function buildSkeleton(hostname) {
  let decoded;
  try {
    decoded = domainToUnicode(hostname);
  } catch {
    decoded = hostname;
  }
  let skeleton = '';
  for (const ch of decoded.toLowerCase()) {
    skeleton += CONFUSABLE_MAP[ch] || ch;
  }
  return skeleton.replace(/0/g, 'o').replace(/1/g, 'l').replace(/rn/g, 'm');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Rule 3(a): flag if the Levenshtein distance between the hostname (or its
// confusable-folded skeleton) and a fuzzylist domain is within tolerance and
// not an exact match (an exact match means it IS the brand's own domain).
function findConfusableLookalike(hostname, fuzzylist, tolerance) {
  const skeleton = buildSkeleton(hostname);
  let best = null;
  for (const fuzzyDomain of fuzzylist) {
    // "not an exact match" excludes the brand's own real domain, not a
    // skeleton that happens to fold exactly onto it (that IS the classic
    // homoglyph/confusable attack, e.g. "rnetamask.com" -> "metamask.com").
    if (hostname === fuzzyDomain) continue;
    const distance = Math.min(levenshtein(hostname, fuzzyDomain), levenshtein(skeleton, fuzzyDomain));
    if (distance > tolerance) continue;
    if (!best || distance < best.distance) best = { domain: fuzzyDomain, distance };
  }
  return best ? best.domain : null;
}

function brandLabel(fuzzyDomain) {
  const labels = fuzzyDomain.split('.');
  if (labels.length < 2) return null;
  return labels[labels.length - 2];
}

function isBrandDomainOrSubdomain(hostname, brandDomain) {
  return hostname === brandDomain || hostname.endsWith('.' + brandDomain);
}

// Rule 3(b): flag if a fuzzylist brand name (min 5 chars) appears as a token
// inside the hostname alongside other tokens, e.g. metamask-login.com — but
// never for the brand's own domain or a subdomain of it (see issue #121).
function findKeywordLookalike(hostname, fuzzylist) {
  const tokens = hostname.split(/[^a-z0-9]+/).filter(Boolean);
  for (const fuzzyDomain of fuzzylist) {
    const brand = brandLabel(fuzzyDomain);
    if (!brand || brand.length < MIN_BRAND_LABEL_LENGTH) continue;
    if (isBrandDomainOrSubdomain(hostname, fuzzyDomain)) continue;
    if (tokens.includes(brand) && tokens.length > 2) return fuzzyDomain;
  }
  return null;
}

// In-memory cache of full tool results, keyed by normalized hostname, for 1
// hour — mirrors check_domain_age's per-domain result cache.
const HOSTNAME_RESULT_CACHE_TTL_MS = 60 * 60 * 1000;
const hostnameResultCache = new Map();

function getCachedHostnameResult(hostname) {
  const entry = hostnameResultCache.get(hostname);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    hostnameResultCache.delete(hostname);
    return null;
  }
  return entry.result;
}

function setCachedHostnameResult(hostname, result) {
  hostnameResultCache.set(hostname, { result, expiresAt: Date.now() + HOSTNAME_RESULT_CACHE_TTL_MS });
}

// Per-IP fixed-window rate limit, identical shape to check_domain_age's.
// Callers with a valid Gumroad license key are exempt.
// HOSTNAME_REPUTATION_RATE_LIMIT_MAX lives in lib/x402Config.mjs (the chat quotes it).
const HOSTNAME_REPUTATION_RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MS;
const hostnameReputationRateLimitState = new Map();

function enforceHostnameReputationRateLimit(identifier) {
  const now = Date.now();
  const key = identifier || 'unknown';
  const state = hostnameReputationRateLimitState.get(key);
  if (!state || (now - state.windowStart) >= HOSTNAME_REPUTATION_RATE_LIMIT_WINDOW_MS) {
    hostnameReputationRateLimitState.set(key, { count: 1, windowStart: now });
    return;
  }
  if (state.count >= HOSTNAME_REPUTATION_RATE_LIMIT_MAX) {
    const retryAfterMin = Math.ceil((HOSTNAME_REPUTATION_RATE_LIMIT_WINDOW_MS - (now - state.windowStart)) / 60000);
    throw new RateLimitedError(
      `check_hostname_reputation is limited to ${HOSTNAME_REPUTATION_RATE_LIMIT_MAX} calls/hour per caller. Retry in about ${retryAfterMin} minute(s), or use a Gumroad license key (X-API-KEY) to bypass this limit.`
    );
  }
  state.count += 1;
}

function phishingDataUnavailableError(detail) {
  const err = new Error(`Phishing domain list ${detail}, please retry.`);
  err.serviceUnavailable = true;
  return err;
}

// Single "in" filter query for the hostname and every parent domain, against
// both the blocklist and allowlist rows (see issue #121).
async function queryPhishingCandidates(supUrl, supKey, candidates) {
  const inList = candidates.map((c) => encodeURIComponent(c)).join(',');
  let res;
  try {
    res = await fetch(
      `${supUrl}/rest/v1/phishing_domains?domain=in.(${inList})&list_type=in.(blocklist,allowlist)&select=domain,list_type,source,synced_at`,
      { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } }
    );
  } catch {
    throw phishingDataUnavailableError('temporarily unavailable');
  }
  if (!res.ok) throw phishingDataUnavailableError('temporarily unavailable');
  return res.json();
}

// Fuzzylist domains + tolerance, cached in memory for 1 hour (see issue #121).
const PHISHING_LIST_CACHE_TTL_MS = 60 * 60 * 1000;
let phishingListCache = null;

async function getPhishingList(supUrl, supKey) {
  const now = Date.now();
  if (phishingListCache && now < phishingListCache.expiresAt) return phishingListCache;

  let metaRes;
  try {
    metaRes = await fetch(`${supUrl}/rest/v1/phishing_list_meta?select=source,tolerance,synced_at`, {
      headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }
    });
  } catch {
    throw phishingDataUnavailableError('metadata temporarily unavailable');
  }
  if (!metaRes.ok) throw phishingDataUnavailableError('metadata temporarily unavailable');
  const metaRows = await metaRes.json();
  const meta = metaRows[0] || {};
  const tolerance = Number.isFinite(meta.tolerance) ? meta.tolerance : DEFAULT_FUZZY_TOLERANCE;
  const syncedAt = meta.synced_at || null;

  let fuzzyRes;
  try {
    fuzzyRes = await fetch(`${supUrl}/rest/v1/phishing_domains?list_type=eq.fuzzylist&select=domain`, {
      headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }
    });
  } catch {
    throw phishingDataUnavailableError('fuzzylist temporarily unavailable');
  }
  if (!fuzzyRes.ok) throw phishingDataUnavailableError('fuzzylist temporarily unavailable');
  const fuzzyRows = await fuzzyRes.json();
  const fuzzylist = fuzzyRows.map((r) => r.domain);

  phishingListCache = { fuzzylist, tolerance, syncedAt, expiresAt: now + PHISHING_LIST_CACHE_TTL_MS };
  return phishingListCache;
}

function buildHostnameResult(hostname, verdict, sources, lookalikeOf, listSyncedAt) {
  const reasons = verdict === 'listed' ? [reason('HOSTNAME_PHISHING_LISTED')]
    : verdict === 'lookalike' ? [reason('HOSTNAME_LOOKALIKE', `Hostname is a probable lookalike/typosquat of '${lookalikeOf}'.`)]
    : [];
  const checks = [buildCheck('phishing domain list', 'ok', { dataAsOf: listSyncedAt })];
  return withResponseMeta({
    hostname,
    verdict,
    sources,
    lookalike_of: lookalikeOf || null,
    list_synced_at: listSyncedAt || null,
    checked_at: new Date().toISOString(),
    attribution: PHISHING_ATTRIBUTION
  }, { reasons, checks });
}

export async function handleCheckHostnameReputation(args, identifier, licenseKey, { licensed: callerLicensed = false } = {}) {
  const hostname = normalizeHostname(args?.hostname);

  const cached = getCachedHostnameResult(hostname);
  if (cached) return cached;

  let licensed = callerLicensed === true;
  if (!licensed && licenseKey) {
    const check = await verifyGumroadLicense(licenseKey).catch(() => ({ valid: false }));
    licensed = !!check.valid;
  }
  if (!licensed) {
    enforceHostnameReputationRateLimit(identifier);
  }

  const { supUrl, supKey } = getSupabaseCreds();
  const candidates = hostnameAndParents(hostname);
  const rows = await queryPhishingCandidates(supUrl, supKey, candidates);

  const rowsByDomain = new Map();
  for (const row of rows) {
    if (!rowsByDomain.has(row.domain)) rowsByDomain.set(row.domain, []);
    rowsByDomain.get(row.domain).push(row);
  }

  // Rule 1: allowlist wins, checked across all candidates before blocklist.
  for (const candidate of candidates) {
    const allow = (rowsByDomain.get(candidate) || []).find((r) => r.list_type === 'allowlist');
    if (allow) {
      const result = buildHostnameResult(
        hostname, 'allowlisted',
        [{ name: PHISHING_SOURCE_NAME, url: PHISHING_SOURCE_URL, match_type: 'allowlist' }],
        null, allow.synced_at
      );
      setCachedHostnameResult(hostname, result);
      return result;
    }
  }

  // Rule 2: blocklist, exact hostname match preferred over a parent match.
  for (const candidate of candidates) {
    const block = (rowsByDomain.get(candidate) || []).find((r) => r.list_type === 'blocklist');
    if (block) {
      const matchType = candidate === hostname ? 'exact' : 'parent_domain';
      const result = buildHostnameResult(
        hostname, 'listed',
        [{ name: PHISHING_SOURCE_NAME, url: PHISHING_SOURCE_URL, match_type: matchType }],
        null, block.synced_at
      );
      setCachedHostnameResult(hostname, result);
      return result;
    }
  }

  // Rule 3: lookalike detection against fuzzylist entries only.
  const { fuzzylist, tolerance, syncedAt: listSyncedAt } = await getPhishingList(supUrl, supKey);

  const confusableMatch = findConfusableLookalike(hostname, fuzzylist, tolerance);
  if (confusableMatch) {
    const result = buildHostnameResult(
      hostname, 'lookalike',
      [{ name: LOOKALIKE_SOURCE_NAME, url: null, match_type: 'confusable' }],
      confusableMatch, listSyncedAt
    );
    setCachedHostnameResult(hostname, result);
    return result;
  }

  const keywordMatch = findKeywordLookalike(hostname, fuzzylist);
  if (keywordMatch) {
    const result = buildHostnameResult(
      hostname, 'lookalike',
      [{ name: LOOKALIKE_SOURCE_NAME, url: null, match_type: 'keyword' }],
      keywordMatch, listSyncedAt
    );
    setCachedHostnameResult(hostname, result);
    return result;
  }

  // Rule 4: never "safe" or "clean" — just not present on any list.
  const result = buildHostnameResult(hostname, 'not_listed', [], null, listSyncedAt);
  setCachedHostnameResult(hostname, result);
  return result;
}

// ---------------------------------------------------------------------
// check_wallet_age — free, no payment gate
// ---------------------------------------------------------------------

const WALLET_AGE_SOURCE = 'on-chain transfer history';
// checks[] source label for the live EIP-7702 delegation (code) check.
const WALLET_DELEGATION_SOURCE = 'on-chain code';
const WALLET_AGE_TIMEOUT_MS = 2500;
const WALLET_AGE_NOT_FOUND_CACHE_TTL_MS = 10 * 60 * 1000;
const WALLET_AGE_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

// Alchemy network slugs, one per chain in the tool's input schema enum.
const WALLET_AGE_CHAIN_SLUGS = {
  base: 'base-mainnet',
  ethereum: 'eth-mainnet',
  arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet',
  polygon: 'polygon-mainnet',
  bsc: 'bnb-mainnet'
};

// alchemy_getAssetTransfers' "internal" category (trace-level ETH transfers)
// is documented as available on these chains per the current Alchemy docs
// (https://docs.alchemy.com/reference/alchemy-getassettransfers), verified
// 30 Sep 2026 — re-check before adding a chain here rather than assuming
// every chain supports it. The 'internal' category is also the slow part of
// the upstream lookup on high-volume addresses (observed timing out the
// whole 2.5s budget on Base), so on these chains handleCheckWalletAge below
// runs the lookup with and without 'internal' in parallel rather than
// sequentially — a slow or rejected 'internal' query (docs drift, a chain
// losing support, or just latency) never costs the non-internal lookup its
// own time budget.
const WALLET_AGE_INTERNAL_SUPPORTED_CHAINS = new Set(['ethereum', 'polygon', 'base']);

class InvalidChainError extends Error {
  constructor(fixIt) {
    super('');
    withFixIt(this, fixIt);
    this.name = 'InvalidChainError';
    this.mcpToolError = true;
    this.code = 'invalid_chain';
  }
}

class WalletAgeUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WalletAgeUpstreamError';
    this.mcpToolError = true;
    this.code = 'upstream_unavailable';
  }
}

// Per-IP fixed-window rate limit, identical shape to check_domain_age's.
// Callers with a valid Gumroad license key are exempt.
// WALLET_AGE_RATE_LIMIT_MAX lives in lib/x402Config.mjs (the chat quotes it).
const WALLET_AGE_RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MS;
const walletAgeRateLimitState = new Map();

function enforceWalletAgeRateLimit(identifier) {
  const now = Date.now();
  const key = identifier || 'unknown';
  const state = walletAgeRateLimitState.get(key);
  if (!state || (now - state.windowStart) >= WALLET_AGE_RATE_LIMIT_WINDOW_MS) {
    walletAgeRateLimitState.set(key, { count: 1, windowStart: now });
    return;
  }
  if (state.count >= WALLET_AGE_RATE_LIMIT_MAX) {
    const retryAfterMin = Math.ceil((WALLET_AGE_RATE_LIMIT_WINDOW_MS - (now - state.windowStart)) / 60000);
    throw new RateLimitedError(
      `check_wallet_age is limited to ${WALLET_AGE_RATE_LIMIT_MAX} calls/hour per caller. Retry in about ${retryAfterMin} minute(s).`
    );
  }
  state.count += 1;
}

// check_wallet_sanctions over /api/a2a and /api/mcp tools/call: per-IP
// fixed-window rate limit, same shape and same rate_limited error as
// check_wallet_age's, and one counter per IP across both endpoints (as
// check_wallet_age's is). Fixture inputs are answered before it is reached.
// Callers with a valid Gumroad license key are exempt. The chat and the
// playground don't go through it (the playground has its own limits).
// While licence sales are paused, the message gives the retry time only.
// WALLET_SANCTIONS_RATE_LIMIT_MAX lives in lib/x402Config.mjs.
const WALLET_SANCTIONS_RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MS;
const walletSanctionsRateLimitState = new Map();

export async function enforceWalletSanctionsRateLimit(identifier, licenseKey) {
  if (licenseKey) {
    const check = await verifyGumroadLicense(licenseKey).catch(() => ({ valid: false }));
    if (check.valid) return;
  }
  const now = Date.now();
  const key = identifier || 'unknown';
  const state = walletSanctionsRateLimitState.get(key);
  if (!state || (now - state.windowStart) >= WALLET_SANCTIONS_RATE_LIMIT_WINDOW_MS) {
    walletSanctionsRateLimitState.set(key, { count: 1, windowStart: now });
    return;
  }
  if (state.count >= WALLET_SANCTIONS_RATE_LIMIT_MAX) {
    const retryAfterMin = Math.ceil((WALLET_SANCTIONS_RATE_LIMIT_WINDOW_MS - (now - state.windowStart)) / 60000);
    throw new RateLimitedError(
      `check_wallet_sanctions is limited to ${WALLET_SANCTIONS_RATE_LIMIT_MAX} calls/hour per caller. Retry in about ${retryAfterMin} minute(s).`
    );
  }
  state.count += 1;
}

function normalizeWalletAgeAddress(raw) {
  if (typeof raw !== 'string' || !WALLET_AGE_ADDRESS_RE.test(raw.trim())) {
    throw new InvalidAddressError({
      problem: typeof raw === 'string' ? 'address is not a valid EVM address' : 'address is missing or is not a string',
      expected: "'0x' followed by exactly 40 hex characters (case-insensitive)",
      example: FIXTURE_VALUES.wallet.CLEAN
    });
  }
  return raw.trim().toLowerCase();
}

function normalizeWalletAgeChain(raw) {
  const chain = (raw === undefined || raw === null || raw === '') ? 'base' : String(raw).trim().toLowerCase();
  if (!WALLET_AGE_CHAIN_SLUGS[chain]) {
    throw new InvalidChainError({
      problem: 'chain is not a supported chain',
      expected: `one of ${Object.keys(WALLET_AGE_CHAIN_SLUGS).join(', ')} (or omit it for base)`,
      example: 'ethereum'
    });
  }
  return chain;
}

// Best-effort cache read — a missing table, an unconfigured Supabase, or a
// network failure all fall back to "no cache" so the tool still works
// uncached (see issue #209), never as a hard failure of the tool itself.
async function getWalletAgeCache(address, chain) {
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch {
    return null;
  }
  const { supUrl, supKey } = creds;
  try {
    const res = await fetch(
      `${supUrl}/rest/v1/wallet_first_seen?address=eq.${address}&chain=eq.${encodeURIComponent(chain)}&select=*`,
      { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return (Array.isArray(rows) && rows.length) ? rows[0] : null;
  } catch {
    return null;
  }
}

// Best-effort cache write (upsert on the (address, chain) primary key) — a
// caching failure must never affect the tool's response.
async function setWalletAgeCache(address, chain, row) {
  let creds;
  try {
    creds = getSupabaseCreds();
  } catch {
    return;
  }
  const { supUrl, supKey } = creds;
  try {
    await fetch(`${supUrl}/rest/v1/wallet_first_seen`, {
      method: 'POST',
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ address, chain, ...row, checked_at: new Date().toISOString() })
    });
  } catch {
    // Best-effort — see function comment.
  }
}

// check_wallet_age has no age threshold anywhere in this file (callers
// choose their own) - its reasons/checks describe observed facts only,
// never a judgement (see lib/reasonCodes.mjs). `partial` is true exactly
// when internal transfers weren't checked in time (see skipCache in
// handleCheckWalletAge below) - a second, distinct checks entry for that
// sub-check, never silently folded into the main "ok" one.
//
// `delegation` is the live EIP-7702 code check ({ delegated, delegate_address,
// checkResult }, see checkWalletDelegation below). It always gets its own
// checks entry ("ok" / "error" / "timeout"), so callers can see whether it
// completed; a failed code check reads as status "unknown" (never a clean
// "no_flags"), and WALLET_DELEGATED is added only when delegated is exactly
// true.
//
// `ageDataAsOf` is when the age was originally looked up: the cache row's
// checked_at on a cached answer, null on a fresh lookup (whose data is this
// request's own).
function walletAgeChecks(partial, delegation, ageDataAsOf) {
  const checks = [buildCheck(WALLET_AGE_SOURCE, 'ok', { dataAsOf: ageDataAsOf })];
  if (partial) checks.push(buildCheck(`${WALLET_AGE_SOURCE} (internal transfers)`, 'timeout'));
  checks.push(buildCheck(WALLET_DELEGATION_SOURCE, delegation.checkResult));
  return checks;
}

// A cache row's checked_at as a normalised ISO string, or null if missing or
// unparseable (Postgres timestamptz round-trips as e.g. "...+00:00").
function walletAgeCacheDataAsOf(row) {
  const t = new Date(row.checked_at).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function walletDelegationFields(delegation) {
  return { delegated: delegation.delegated, delegate_address: delegation.delegate_address };
}

function walletDelegationReasons(delegation) {
  return delegation.delegated === true ? [reason('WALLET_DELEGATED')] : [];
}

function buildWalletAgeFoundResult(address, chain, row, cached, partial, delegation, ageDataAsOf = null) {
  // Normalises both the cached path (Postgres timestamptz round-trips as
  // e.g. "...+00:00") and the fresh path (already an ISO string from
  // Alchemy) through the same Date parse so the two are byte-identical.
  const firstSeen = new Date(row.first_seen).toISOString();
  const ageDays = Math.floor((Date.now() - new Date(firstSeen).getTime()) / (24 * 60 * 60 * 1000));
  return withResponseMeta({
    address,
    chain,
    found: true,
    first_seen: firstSeen,
    age_days: ageDays,
    first_seen_block: row.first_seen_block,
    first_direction: row.first_direction,
    is_contract: !!row.is_contract,
    ...walletDelegationFields(delegation),
    note: null,
    source: WALLET_AGE_SOURCE,
    cached
  }, {
    reasons: [...(partial ? [reason('WALLET_AGE_PARTIAL')] : []), ...walletDelegationReasons(delegation)],
    checks: walletAgeChecks(partial, delegation, ageDataAsOf)
  });
}

function buildWalletAgeNotFoundResult(address, chain, isContract, cached, partial, delegation, ageDataAsOf = null) {
  const reasons = [reason('WALLET_NO_HISTORY')];
  if (partial) reasons.push(reason('WALLET_AGE_PARTIAL'));
  reasons.push(...walletDelegationReasons(delegation));
  return withResponseMeta({
    address,
    chain,
    found: false,
    first_seen: null,
    age_days: null,
    first_seen_block: null,
    first_direction: null,
    is_contract: !!isContract,
    ...walletDelegationFields(delegation),
    note: `'${address}' has no transfer history on '${chain}' — a normal result for a brand-new or never-used address, not an error.`,
    source: WALLET_AGE_SOURCE,
    cached
  }, { reasons, checks: walletAgeChecks(partial, delegation, ageDataAsOf) });
}

async function alchemyRpcCall(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Upstream on-chain data source responded with ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error('Upstream on-chain data source error: ' + data.error.message);
  return data.result;
}

async function fetchEarliestTransfer(url, address, categories, direction, signal) {
  const params = [{
    fromBlock: '0x0',
    order: 'asc',
    maxCount: '0x1',
    withMetadata: true,
    category: categories,
    [direction === 'out' ? 'fromAddress' : 'toAddress']: address
  }];
  const result = await alchemyRpcCall(
    url,
    { jsonrpc: '2.0', id: direction === 'out' ? 1 : 2, method: 'alchemy_getAssetTransfers', params },
    signal
  );
  const transfer = result && Array.isArray(result.transfers) ? result.transfers[0] : null;
  if (!transfer || !transfer.metadata || !transfer.metadata.blockTimestamp) return null;
  return { direction, timestamp: transfer.metadata.blockTimestamp, block: transfer.blockNum };
}

// Picks the earlier of two resolved "earliest transfer" candidates (either
// may be null if that side found nothing).
function pickEarliestTransfer(a, b) {
  if (a && b) return new Date(a.timestamp).getTime() <= new Date(b.timestamp).getTime() ? a : b;
  return a || b || null;
}

// EIP-7702 delegation designator: an EOA with a delegation set has code of
// exactly 23 bytes, 0xef0100 followed by the 20-byte delegate address. Any
// other code (empty, an ordinary contract, or something that merely starts
// with 0xef0100 at the wrong length) is not a delegation.
const EIP7702_DELEGATION_CODE_RE = /^0xef0100([0-9a-f]{40})$/i;

// Parses eth_getCode's result into { delegated, delegate_address }. A
// non-string result means the check didn't produce an answer, so it's
// reported as unknown (null), never guessed as false.
export function parseWalletDelegation(code) {
  if (typeof code !== 'string') return { delegated: null, delegate_address: null };
  const match = EIP7702_DELEGATION_CODE_RE.exec(code);
  if (!match) return { delegated: false, delegate_address: null };
  return { delegated: true, delegate_address: '0x' + match[1].toLowerCase() };
}

// The live delegation check: its own eth_getCode on the requested chain (a
// distinct JSON-RPC id from the age lookups' eth_getCode, id 3), sharing
// the caller's AbortController so it stays inside the same 2.5s budget.
// Never throws - any failure becomes delegated: null with a checks result
// of 'timeout' or 'error', so a failed code check can never fail, or change,
// the age answer it's attached to. Never cached (see handleCheckWalletAge).
async function checkWalletDelegation(url, address, signal) {
  try {
    const code = await alchemyRpcCall(url, { jsonrpc: '2.0', id: 4, method: 'eth_getCode', params: [address, 'latest'] }, signal);
    const parsed = parseWalletDelegation(code);
    return { ...parsed, checkResult: parsed.delegated === null ? 'error' : 'ok' };
  } catch (err) {
    return { delegated: null, delegate_address: null, checkResult: err && err.name === 'AbortError' ? 'timeout' : 'error' };
  }
}

// Same, for the cached-answer path, which has no upstream budget of its
// own running: a fresh 2.5s timer for just this one call.
async function checkWalletDelegationStandalone(chain, address) {
  const apiKey = process.env.ALCHEMY_API_KEY;
  if (!apiKey) return { delegated: null, delegate_address: null, checkResult: 'error' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WALLET_AGE_TIMEOUT_MS);
  try {
    return await checkWalletDelegation(walletAgeUpstreamUrl(chain, apiKey), address, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function walletAgeUpstreamUrl(chain, apiKey) {
  return `https://${WALLET_AGE_CHAIN_SLUGS[chain]}.g.alchemy.com/v2/${apiKey}`;
}

function runWalletAgeUpstreamCalls(url, address, categories, signal) {
  return Promise.all([
    fetchEarliestTransfer(url, address, categories, 'out', signal),
    fetchEarliestTransfer(url, address, categories, 'in', signal),
    alchemyRpcCall(url, { jsonrpc: '2.0', id: 3, method: 'eth_getCode', params: [address, 'latest'] }, signal)
  ]);
}

export async function handleCheckWalletAge(args, identifier, licenseKey, { licensed: callerLicensed = false } = {}) {
  const address = normalizeWalletAgeAddress(args?.address);
  const chain = normalizeWalletAgeChain(args?.chain);

  // Every call now makes at least one upstream call (a cached age answer
  // still gets a live delegation check, below), so the rate limit applies
  // before the cache read: cached calls count too. Licensed callers stay
  // exempt.
  let licensed = callerLicensed === true;
  if (!licensed && licenseKey) {
    const check = await verifyGumroadLicense(licenseKey).catch(() => ({ valid: false }));
    licensed = !!check.valid;
  }
  if (!licensed) {
    enforceWalletAgeRateLimit(identifier);
  }

  // Only the age (first_seen and friends) is ever cached. Delegation can be
  // added or removed by the owner at any time, so a cached age answer still
  // gets a live delegation check on every call.
  const cachedRow = await getWalletAgeCache(address, chain);
  if (cachedRow) {
    if (cachedRow.first_seen) {
      const delegation = await checkWalletDelegationStandalone(chain, address);
      return buildWalletAgeFoundResult(address, chain, cachedRow, true, false, delegation, walletAgeCacheDataAsOf(cachedRow));
    }
    const checkedAt = new Date(cachedRow.checked_at).getTime();
    if (!Number.isNaN(checkedAt) && (Date.now() - checkedAt) < WALLET_AGE_NOT_FOUND_CACHE_TTL_MS) {
      const delegation = await checkWalletDelegationStandalone(chain, address);
      return buildWalletAgeNotFoundResult(address, chain, cachedRow.is_contract, true, false, delegation, walletAgeCacheDataAsOf(cachedRow));
    }
  }

  const apiKey = process.env.ALCHEMY_API_KEY;
  if (!apiKey) {
    throw new WalletAgeUpstreamError('Wallet age lookups are not configured on this deployment.');
  }
  const url = walletAgeUpstreamUrl(chain, apiKey);
  const plainCategories = ['external', 'erc20', 'erc721', 'erc1155'];
  const supportsInternal = WALLET_AGE_INTERNAL_SUPPORTED_CHAINS.has(chain);

  // On chains where 'internal' is supported, the plain (non-internal) and
  // internal-inclusive lookups run in parallel rather than sequentially, so
  // the slow/rejected 'internal' query never eats into the non-internal
  // query's share of the 2.5s budget (see WALLET_AGE_INTERNAL_SUPPORTED_CHAINS
  // above). The live delegation check runs alongside both, on the same
  // AbortController, and never rejects (see checkWalletDelegation).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WALLET_AGE_TIMEOUT_MS);
  let plainSettled, internalSettled, delegation;
  try {
    const attempts = [runWalletAgeUpstreamCalls(url, address, plainCategories, controller.signal)];
    if (supportsInternal) {
      attempts.push(runWalletAgeUpstreamCalls(url, address, [...plainCategories, 'internal'], controller.signal));
    }
    const delegationCheck = checkWalletDelegation(url, address, controller.signal);
    [[plainSettled, internalSettled], delegation] = await Promise.all([Promise.allSettled(attempts), delegationCheck]);
  } finally {
    clearTimeout(timeout);
  }

  const plainOk = plainSettled.status === 'fulfilled';
  const internalOk = supportsInternal && internalSettled.status === 'fulfilled';

  if (!plainOk && !internalOk) {
    const reasons = supportsInternal ? [plainSettled.reason, internalSettled.reason] : [plainSettled.reason];
    const isTimeout = reasons.some((r) => r && r.name === 'AbortError');
    const message = isTimeout
      ? `Wallet age lookup timed out after ${WALLET_AGE_TIMEOUT_MS}ms.`
      : 'Wallet age lookup failed: upstream on-chain data source unavailable.';
    throw new WalletAgeUpstreamError(message);
  }

  let earliest = null;
  let isContract = false;
  let note = null;
  let skipCache = false;

  if (plainOk && internalOk) {
    const [plainOut, plainIn, plainCode] = plainSettled.value;
    const [intOut, intIn, intCode] = internalSettled.value;
    earliest = pickEarliestTransfer(pickEarliestTransfer(plainOut, plainIn), pickEarliestTransfer(intOut, intIn));
    isContract = (!!plainCode && plainCode !== '0x') || (!!intCode && intCode !== '0x');
  } else if (internalOk) {
    const [intOut, intIn, intCode] = internalSettled.value;
    earliest = pickEarliestTransfer(intOut, intIn);
    isContract = !!intCode && intCode !== '0x';
  } else {
    // Only the non-internal lookup succeeded. On a chain that doesn't
    // support 'internal' at all this is the normal path (no note needed);
    // on a chain that does, the internal-inclusive lookup didn't make it
    // back in time, so the result may be missing an earlier internal
    // transfer — flag that, and never let this partial view overwrite the
    // permanent cache with a possibly-too-late first_seen.
    const [plainOut, plainIn, plainCode] = plainSettled.value;
    earliest = pickEarliestTransfer(plainOut, plainIn);
    isContract = !!plainCode && plainCode !== '0x';
    if (supportsInternal) {
      note = 'Internal transfers were not checked in time; the wallet may be older than shown.';
      skipCache = true;
    }
  }

  if (!earliest) {
    if (!skipCache) {
      await setWalletAgeCache(address, chain, { first_seen: null, first_seen_block: null, first_direction: null, is_contract: isContract });
    }
    const result = buildWalletAgeNotFoundResult(address, chain, isContract, false, skipCache, delegation);
    if (note) result.note = note;
    return result;
  }

  const row = {
    first_seen: earliest.timestamp,
    first_seen_block: parseInt(earliest.block, 16),
    first_direction: earliest.direction,
    is_contract: isContract
  };
  if (!skipCache) {
    await setWalletAgeCache(address, chain, row);
  }
  const result = buildWalletAgeFoundResult(address, chain, row, false, skipCache, delegation);
  if (note) result.note = note;
  return result;
}

// ---------------------------------------------------------------------
// check_ip_abuse — free, bring-your-own AbuseIPDB key (lib/abuseIpdb.mjs)
// ---------------------------------------------------------------------
// The key comes only from the caller's X-AbuseIPDB-Key header (the
// dispatchers read it and pass it in as `abuseIpdbKey`); there is no
// environment key and no fallback. This tool is deliberately not in
// READ_ONLY_TOOL_RUNNERS: the chat and the playground have no customer key
// to send, so they never reach it.

const IP_ABUSE_SOURCE = 'IP abuse reports';
const IP_ABUSE_RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MS;
const ipAbuseRateLimitState = new Map();

function enforceIpAbuseRateLimit(identifier) {
  const now = Date.now();
  const key = identifier || 'unknown';
  const state = ipAbuseRateLimitState.get(key);
  if (!state || (now - state.windowStart) >= IP_ABUSE_RATE_LIMIT_WINDOW_MS) {
    ipAbuseRateLimitState.set(key, { count: 1, windowStart: now });
    return;
  }
  if (state.count >= IP_ABUSE_RATE_LIMIT_MAX) {
    const retryAfterMin = Math.ceil((IP_ABUSE_RATE_LIMIT_WINDOW_MS - (now - state.windowStart)) / 60000);
    throw new RateLimitedError(
      `check_ip_abuse is limited to ${IP_ABUSE_RATE_LIMIT_MAX} calls/hour per caller. Retry in about ${retryAfterMin} minute(s).`
    );
  }
  state.count += 1;
}

// `fields` are the renamed upstream fields (lib/abuseIpdb.mjs pickFields).
// IP_ABUSE_REPORTED is the fact that the report count is above zero - no
// score threshold is invented here. A response missing the score or the
// report count is "unknown", never "no_flags".
function buildIpAbuseResult(ip, version, maxAgeDays, fields, { cached = false, fetchedAt = null, attributionText = ABUSEIPDB_ATTRIBUTION_TEXT } = {}) {
  const complete = fields.abuse_confidence_score !== null && fields.total_reports !== null;
  const reasons = [];
  if (fields.total_reports > 0) {
    reasons.push(reason('IP_ABUSE_REPORTED', `IP address has ${fields.total_reports} abuse report(s) from ${fields.distinct_reporters ?? 'an unknown number of'} distinct reporter(s) in the last ${maxAgeDays} day(s).`));
  }
  if (fields.is_tor === true) reasons.push(reason('IP_TOR_EXIT_NODE'));
  const note = fields.total_reports === 0
    ? `No abuse reports for this address in the last ${maxAgeDays} day(s). That means no one reported it in that window, not that the address is harmless.`
    : 'abuse_confidence_score is AbuseIPDB\'s 0-100 confidence that the address is abusive, based on reports in the window. A low score means few or no reports, not that the address is harmless.';
  return withResponseMeta({
    ip,
    ip_version: version,
    max_age_in_days: maxAgeDays,
    ...fields,
    cached,
    note,
    attribution: { text: attributionText, url: abuseIpdbCheckUrlFor(ip) }
  }, {
    reasons,
    checks: [buildCheck(IP_ABUSE_SOURCE, complete ? 'ok' : 'error', { dataAsOf: fetchedAt })]
  });
}

export async function handleCheckIpAbuse(args, { identifier, licenseKey, licensed: callerLicensed = false, abuseIpdbKey } = {}) {
  if (!abuseIpdbKey) throw keyRequiredError();
  const { ip, version } = normalizePublicIp(args?.ip);
  const maxAgeDays = normalizeMaxAgeDays(args?.max_age_in_days);

  let licensed = callerLicensed === true;
  if (!licensed && licenseKey) {
    const check = await verifyGumroadLicense(licenseKey).catch(() => ({ valid: false }));
    licensed = !!check.valid;
  }
  if (!licensed) {
    enforceIpAbuseRateLimit(identifier);
  }

  const cached = getCachedLookup(abuseIpdbKey, ip, maxAgeDays);
  if (cached) return buildIpAbuseResult(ip, version, maxAgeDays, cached.fields, { cached: true, fetchedAt: cached.fetchedAt });

  const fields = await fetchAbuseIpdbCheck(abuseIpdbKey, ip, maxAgeDays);
  setCachedLookup(abuseIpdbKey, ip, maxAgeDays, { fields, fetchedAt: new Date().toISOString() });
  return buildIpAbuseResult(ip, version, maxAgeDays, fields);
}

// ---------------------------------------------------------------------
// Integration test fixtures (issue #215 part B) — see lib/fixtures.mjs
// ---------------------------------------------------------------------
// resolveTestFixture is called by the MCP and A2A dispatchers straight after
// the tool name is known and before any licence check, payment gate, rate
// limit, cache, upstream call or error logging, so a fixture call never
// touches any of them and is free for every caller. Responses are built with
// each tool's real result builders (same shape as a real response), then
// every checks[] source is relabelled "fixture" and test_fixture: true is
// added. UNKNOWN fixtures reproduce exactly what a real upstream failure
// looks like for that tool - including a JSON-RPC 503 or an isError tool
// result where that's what the real failure is - never a found:false.

const DAY_MS = 24 * 60 * 60 * 1000;

// Every fixture check's data_as_of equals its checked_at, including checks
// built by a tool's real result builder (which would otherwise carry that
// tool's own data_as_of, e.g. the phishing list sync time).
function asFixtureResult(result) {
  return {
    ...result,
    checks: result.checks.map((c) => ({ ...c, source: FIXTURE_CHECK_SOURCE, data_as_of: c.checked_at })),
    test_fixture: true
  };
}

function fixtureCheck(result) {
  const now = new Date().toISOString();
  return buildCheck(FIXTURE_CHECK_SOURCE, result, { checkedAt: now, dataAsOf: now });
}

function fixtureCveRecord(cveId, kind) {
  const kev = kind === 'FLAGGED';
  return {
    nvd: {
      description: 'PG1 integration test fixture - not a real vulnerability.',
      cvss_v3_score: kev ? 9.8 : 5.3,
      cvss_vector: kev ? 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' : 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
      severity: kev ? 'CRITICAL' : 'MEDIUM',
      published: FIXTURE_DATA_AS_OF,
      last_modified: FIXTURE_DATA_AS_OF
    },
    epss: kind === 'UNKNOWN' ? null : { score: kev ? 0.97 : 0.01, percentile: kev ? 0.99 : 0.2 },
    kev: kev ? { dateAdded: '2026-01-01', requiredAction: 'PG1 test fixture - no action required.', dueDate: '2026-01-22' } : null
  };
}

function fixtureCveChecks(kind) {
  const enrichment = kind === 'UNKNOWN' ? 'error' : 'ok';
  return [fixtureCheck('ok'), fixtureCheck(enrichment), fixtureCheck(enrichment)];
}

// `callerArgs` supplies the fields a real response echoes back from the
// caller's own input (the address exactly as submitted, the chain, the
// product version/only_kev filters); the fixture's own arguments supply the
// normalised lookup value, which is identical by construction.
function buildFixtureOutcome(fixture, callerArgs) {
  const { tool, kind, arguments: args } = fixture;
  const result = (r) => ({ type: 'result', result: r });

  switch (tool) {
    case 'check_wallet_sanctions': {
      if (kind === 'UNKNOWN') return { type: 'service_unavailable', mcpErrorCode: -32003, message: 'Sanctions data temporarily unavailable, please retry.' };
      const address = callerArgs.address;
      const base = { address, address_normalized: normalizeWalletAddress(address), source: SANCTIONS_SOURCE, list_last_synced: FIXTURE_DATA_AS_OF };
      if (kind === 'CLEAN') {
        return result(withResponseMeta({
          ...base, listed: false, matches: [],
          message: `Not on the OFAC SDN sanctions list as of ${FIXTURE_DATA_AS_OF}.`,
          disclaimer: SANCTIONS_DISCLAIMER
        }, { reasons: [], checks: [fixtureCheck('ok')] }));
      }
      return result(withResponseMeta({
        ...base, listed: true,
        matches: [{ sdn_name: 'PG1 TEST FIXTURE (not a real SDN entry)', currency: 'ETH', programs: ['PG1-TEST-FIXTURE'], sdn_uid: null }],
        disclaimer: SANCTIONS_DISCLAIMER
      }, { reasons: [reason('WALLET_SANCTIONED')], checks: [fixtureCheck('ok')] }));
    }

    case 'check_domain_age': {
      const domain = args.domain;
      if (kind === 'UNKNOWN') return result(domainNotFound(domain, 'RDAP lookup timed out after 5 seconds.', 'timeout'));
      const nowMs = Date.now();
      const registrationDate = kind === 'FLAGGED'
        ? fixtureDaysAgoMidnightUtc(FIXTURE_DOMAIN_FLAGGED_AGE_DAYS, nowMs)
        : FIXTURE_DOMAIN_CLEAN_REGISTERED;
      const ageDays = Math.floor((nowMs - new Date(registrationDate).getTime()) / DAY_MS);
      const newlyRegistered = ageDays < 30;
      return result(withResponseMeta({
        found: true,
        available: true,
        domain,
        registration_date: registrationDate,
        age_days: ageDays,
        expiration_date: '2099-01-01T00:00:00.000Z',
        registrar: 'PG1 Test Fixture Registrar',
        newly_registered: newlyRegistered,
        note: newlyRegistered
          ? `This domain was registered ${ageDays} day(s) ago — a common phishing signal, not proof of malicious intent.`
          : null,
        source: 'RDAP (rdap.pg1-test.invalid)'
      }, {
        reasons: newlyRegistered ? [reason('DOMAIN_NEWLY_REGISTERED_30D')] : [],
        checks: [fixtureCheck('ok')]
      }));
    }

    case 'check_hostname_reputation': {
      if (kind === 'UNKNOWN') return { type: 'service_unavailable', mcpErrorCode: -32003, message: phishingDataUnavailableError('temporarily unavailable').message };
      const hostname = args.hostname;
      const r = kind === 'FLAGGED'
        ? buildHostnameResult(hostname, 'listed', [{ name: PHISHING_SOURCE_NAME, url: PHISHING_SOURCE_URL, match_type: 'exact' }], null, FIXTURE_DATA_AS_OF)
        : buildHostnameResult(hostname, 'not_listed', [], null, FIXTURE_DATA_AS_OF);
      return result(r);
    }

    case 'check_wallet_age': {
      if (kind === 'UNKNOWN') {
        return { type: 'tool_error', code: 'upstream_unavailable', message: `Wallet age lookup timed out after ${WALLET_AGE_TIMEOUT_MS}ms.`, checks: [fixtureCheck('timeout')] };
      }
      const address = args.address.trim().toLowerCase();
      const chain = normalizeWalletAgeChain(callerArgs.chain);
      // Fixtures never consult chain data, so the delegation check is a
      // fixed, completed answer: delegated only for the DELEGATED fixture
      // (which, like a real delegated wallet, has code, so is_contract true).
      const delegated = kind === 'DELEGATED';
      const delegation = delegated
        ? { delegated: true, delegate_address: FIXTURE_DELEGATE_ADDRESS, checkResult: 'ok' }
        : { delegated: false, delegate_address: null, checkResult: 'ok' };
      const r = kind === 'FLAGGED'
        ? buildWalletAgeNotFoundResult(address, chain, false, false, false, delegation)
        : buildWalletAgeFoundResult(address, chain, { first_seen: '2023-09-01T00:00:00.000Z', first_seen_block: 1000000, first_direction: 'in', is_contract: delegated }, false, false, delegation);
      return result(r);
    }

    case 'check_ip_abuse': {
      // Synthetic data only: no key needed, AbuseIPDB never contacted, and
      // the attribution says the data is not AbuseIPDB's.
      if (kind === 'UNKNOWN') {
        return { type: 'tool_error', code: 'upstream_unavailable', message: `AbuseIPDB lookup timed out after ${ABUSEIPDB_TIMEOUT_MS}ms.`, checks: [fixtureCheck('timeout')] };
      }
      const days = callerArgs.max_age_in_days ?? MAX_AGE_DAYS_DEFAULT;
      const fields = kind === 'FLAGGED'
        ? { abuse_confidence_score: 100, total_reports: 42, distinct_reporters: 17, last_reported_at: FIXTURE_DATA_AS_OF, country_code: 'ZZ', usage_type: 'PG1 test fixture', isp: 'PG1 Test Fixture ISP', domain: 'pg1-test.invalid', is_tor: false, is_whitelisted: false }
        : { abuse_confidence_score: 0, total_reports: 0, distinct_reporters: 0, last_reported_at: null, country_code: 'ZZ', usage_type: 'PG1 test fixture', isp: 'PG1 Test Fixture ISP', domain: 'pg1-test.invalid', is_tor: false, is_whitelisted: false };
      return result(buildIpAbuseResult(args.ip, 4, days, fields, { attributionText: 'PG1 test fixture: synthetic data, not from AbuseIPDB' }));
    }

    case 'get_ioc_context':
    case 'get_ioc_batch': {
      const values = tool === 'get_ioc_context' ? [args.value.trim()] : args.values.map((v) => v.trim());
      if (kind === 'UNKNOWN') {
        return { type: 'service_unavailable', mcpErrorCode: tool === 'get_ioc_context' ? -32603 : -32003, message: 'Threat data temporarily unavailable, please retry.' };
      }
      const lookups = values.map((value) => (kind === 'CLEAN' ? { indicator: value, found: false } : {
        indicator: value,
        found: true,
        indicator_type: value.includes(':') ? 'IPv6' : detectIndicatorType(value),
        provenance: {
          sources: ['pg1-test-fixture'],
          observation_count: 1,
          confidence_score: 90,
          malware_families: ['PG1-Test-Fixture'],
          tags: ['test-fixture'],
          first_seen: FIXTURE_DATA_AS_OF,
          last_seen: FIXTURE_DATA_AS_OF
        }
      }));
      if (tool === 'get_ioc_context') return result(withIocResponseMeta(lookups[0]));
      const totalFound = lookups.filter((l) => l.found).length;
      return result(withResponseMeta({ total_requested: values.length, total_found: totalFound, results: lookups }, {
        reasons: totalFound > 0 ? [reason('IOC_FOUND_IN_THREAT_FEED', `${totalFound} of ${values.length} submitted indicators have a matching record in the threat indicator feed.`)] : [],
        checks: [fixtureCheck('ok')]
      }));
    }

    case 'get_cve_details': {
      const cveId = args.cve_id.toUpperCase();
      const rec = fixtureCveRecord(cveId, kind);
      return result(withResponseMeta({
        cve_id: cveId,
        nvd: rec.nvd,
        epss: rec.epss,
        cisa_kev: {
          is_known_exploited: !!rec.kev,
          date_added: rec.kev ? rec.kev.dateAdded : null,
          required_action: rec.kev ? rec.kev.requiredAction : null,
          due_date: rec.kev ? rec.kev.dueDate : null
        }
      }, { reasons: rec.kev ? [reason('CVE_KNOWN_EXPLOITED_KEV')] : [], checks: fixtureCveChecks(kind) }));
    }

    case 'get_cve_batch': {
      const results = args.cve_ids.map((raw) => {
        const cveId = raw.toUpperCase();
        const rec = fixtureCveRecord(cveId, kind);
        const { last_modified: _lastModified, ...nvd } = rec.nvd;
        return { cve_id: cveId, found: true, nvd, epss: rec.epss, cisa_kev: { is_known_exploited: !!rec.kev, due_date: rec.kev ? rec.kev.dueDate : null } };
      });
      const anyKev = results.some((r) => r.cisa_kev.is_known_exploited);
      return result(withResponseMeta({ total_requested: results.length, total_found: results.length, results }, {
        reasons: anyKev ? [reason('CVE_KNOWN_EXPLOITED_KEV')] : [],
        checks: fixtureCveChecks(kind)
      }));
    }

    case 'get_cve_by_product': {
      const { vendor, product } = args;
      const version = callerArgs.version || null;
      if (kind === 'CLEAN') {
        return result(withResponseMeta({ vendor, product, version, total_found: 0, cves: [] }, { reasons: [], checks: [fixtureCheck('ok')] }));
      }
      const cveId = FIXTURE_VALUES.cve[kind];
      const rec = fixtureCveRecord(cveId, kind);
      const cves = [{
        cve_id: cveId,
        description: rec.nvd.description,
        published: rec.nvd.published,
        cvss: { version: '3.1', score: rec.nvd.cvss_v3_score, severity: rec.nvd.severity },
        epss: rec.epss,
        is_known_exploited: !!rec.kev,
        kev_due_date: rec.kev ? rec.kev.dueDate : null
      }];
      const filtered = callerArgs.only_kev ? cves.filter((c) => c.is_known_exploited) : cves;
      const anyKev = filtered.some((c) => c.is_known_exploited);
      return result(withResponseMeta({ vendor, product, version, total_found: filtered.length, cves: filtered }, {
        reasons: anyKev ? [reason('CVE_KNOWN_EXPLOITED_KEV')] : [],
        checks: fixtureCveChecks(kind)
      }));
    }

    default:
      return null;
  }
}

// Returns null when (toolName, args) is not an exact fixture match.
// Otherwise one of:
//   { type: 'result', result }                       - a normal tool result
//   { type: 'tool_error', code, message, checks }    - an isError tool result
//   { type: 'service_unavailable', mcpErrorCode, message } - a JSON-RPC 503
// A 'result' already carries test_fixture: true; the dispatchers add it to
// the other two shapes in the protocol-appropriate place.
export function resolveTestFixture(toolName, args) {
  const fixture = matchFixture(toolName, args);
  if (!fixture) return null;
  const outcome = buildFixtureOutcome(fixture, args || {});
  if (outcome.type === 'result') outcome.result = asFixtureResult(outcome.result);
  return outcome;
}

const STRUCTURED_CONTENT_TOOLS = new Set(['check_wallet_sanctions', 'check_domain_age', 'check_hostname_reputation', 'check_wallet_age', 'check_ip_abuse']);

function sendMcpFixtureResponse(res, toolName, outcome, requestId, pg1RequestId) {
  if (outcome.type === 'service_unavailable') {
    return res.status(503).json({ jsonrpc: '2.0', error: { code: outcome.mcpErrorCode, message: outcome.message, data: { test_fixture: true, request_id: pg1RequestId } }, id: requestId });
  }
  if (outcome.type === 'tool_error') {
    return res.status(200).json({
      jsonrpc: '2.0',
      result: {
        content: [{ type: 'text', text: JSON.stringify({ error: true, code: outcome.code, message: outcome.message, ...errorResponseMeta(outcome.checks, pg1RequestId), test_fixture: true }, null, 2) }],
        isError: true
      },
      id: requestId
    });
  }
  const toolResult = outcome.result;
  toolResult.request_id = pg1RequestId;
  const result = { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] };
  if (STRUCTURED_CONTENT_TOOLS.has(toolName)) result.structuredContent = toolResult;
  return res.status(200).json({ jsonrpc: '2.0', result, id: requestId });
}

// ---------------------------------------------------------------------
// AUTHORIZATION
// ---------------------------------------------------------------------
// verifyGumroadLicense lives in lib/paymentGate.mjs, shared with
// api/chat.mjs and api/ioc/context.js so all Gumroad verify call sites
// behave identically (increment_uses_count=false, subscription-lapse
// checks, 10min success cache, 2s timeout with cache fallback).

const X402_PAY_TO = (process.env.X402_PAY_TO_ADDRESS || '').trim();
// X402_NETWORK, X402_SCHEME and X402_PRICE live in lib/x402Config.mjs.
const X402_RESOURCE_DESCRIPTION = 'PG1 Threat Intelligence: STIX 2.1 threat indicator feed (IPs, domains, URLs, file hashes, CVEs) aggregated from open threat intelligence sources including AlienVault OTX.';
const X402_RESOURCE_MIME_TYPE = 'application/json';

// Facilitator client factory, overridable only by tests (see
// __setX402FacilitatorForTests below) so the x402 v2 payment path can be
// exercised against a fake facilitator instead of real CDP credentials.
let x402FacilitatorFactory = createCdpFacilitatorClient;
let x402Server = null;
let x402SetupAttempted = false;
let x402InitPromise = null;
let x402Initialized = false;

if (!X402_PAY_TO) {
  console.warn('[X402] X402_PAY_TO_ADDRESS not set — x402 payment path disabled on this deployment.');
}

// Lazily builds (and memoizes) the x402ResourceServer used to drive the v2
// payment flow directly — verify/settle are invoked as plain method calls
// (see runX402Gate below) rather than through the Express-style
// paymentMiddleware, so a tools/call result can be shaped as a normal
// JSON-RPC MCP result (isError/structuredContent/content) instead of a raw
// HTTP 402, per the x402 v2 MCP transport spec.
function getX402Server() {
  if (!X402_PAY_TO) return null;
  if (!x402SetupAttempted) {
    x402SetupAttempted = true;
    try {
      const facilitatorClient = x402FacilitatorFactory();
      x402Server = new x402ResourceServer(facilitatorClient).register(X402_NETWORK, new ExactEvmScheme());
    } catch (e) {
      console.error('[X402] Setup failed, payment path disabled:', e.message);
      x402Server = null;
    }
  }
  return x402Server;
}

function ensureX402Initialized() {
  const server = getX402Server();
  if (!server) return Promise.resolve(false);
  if (x402Initialized) return Promise.resolve(true);
  if (!x402InitPromise) {
    x402InitPromise = Promise.race([
      server.initialize(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('facilitator init timeout')), 8000))
    ]).then(() => { x402Initialized = true; return true; })
      .catch((err) => { console.error('[X402] init failed:', err.message); x402InitPromise = null; return false; });
  }
  return x402InitPromise;
}

// Test-only seam: substitutes the facilitator client so the x402 v2 payment
// path (verify/settle) can be exercised without real CDP credentials, JWT
// signing, or network access. Never called outside tests/mcp-x402-v2.test.mjs.
export function __setX402FacilitatorForTests(facilitatorClientFactory) {
  x402FacilitatorFactory = facilitatorClientFactory || createCdpFacilitatorClient;
  x402Server = null;
  x402SetupAttempted = false;
  x402Initialized = false;
  x402InitPromise = null;
}

function ensureExpressCompat(req) {
  if (typeof req.header !== 'function') {
    req.header = req.get = (name) => {
      const v = req.headers[String(name).toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
  }
  if (req.path === undefined) req.path = (req.url || '/').split('?')[0];
  if (req.originalUrl === undefined) req.originalUrl = req.url;
  if (req.protocol === undefined) {
    const fp = req.headers['x-forwarded-proto'];
    req.protocol = (Array.isArray(fp) ? fp[0] : fp) || 'https';
  }
}

function buildX402ResourceInfo(req) {
  ensureExpressCompat(req);
  return {
    url: `${req.protocol}://${req.headers.host || ''}${req.originalUrl}`,
    description: X402_RESOURCE_DESCRIPTION,
    mimeType: X402_RESOURCE_MIME_TYPE
  };
}

// Used when the real x402ResourceServer isn't available at all (deployment
// misconfigured, or the facilitator is unreachable) — keeps the same v2
// PaymentRequired shape (x402Version, resource, accepts, error) that a
// caller gets from a real facilitator, just with an empty accepts list.
function buildFallbackPaymentRequired(resourceInfo, error) {
  return { x402Version: X402_VERSION, error, resource: resourceInfo, accepts: [] };
}

// Drives the x402 v2 payment flow directly against x402ResourceServer:
// build requirements, read a payment payload from params._meta["x402/payment"]
// (preferred) or the PAYMENT-SIGNATURE/X-Payment header, match it against
// accepts, and verify via the facilitator. Never runs the tool or settles —
// callers run the tool first and invoke the returned `settle` function only
// on tool success, per the x402 v2 MCP transport spec.
async function runX402Gate(req, params) {
  const resourceInfo = buildX402ResourceInfo(req);
  const server = getX402Server();
  if (!server) {
    return { authorized: false, paymentRequired: buildFallbackPaymentRequired(resourceInfo, 'x402 payment path is not configured on this deployment. Use a Gumroad license key (X-API-KEY) instead.') };
  }
  const ready = await ensureX402Initialized();
  if (!ready) {
    return { authorized: false, paymentRequired: buildFallbackPaymentRequired(resourceInfo, 'x402 payment path temporarily unavailable. Retry, or use a Gumroad license key.') };
  }

  let requirements;
  try {
    requirements = await server.buildPaymentRequirements({ scheme: X402_SCHEME, price: X402_PRICE, network: X402_NETWORK, payTo: X402_PAY_TO });
  } catch (e) {
    return { authorized: false, paymentRequired: buildFallbackPaymentRequired(resourceInfo, 'x402 payment path misconfigured: ' + e.message) };
  }

  const metaPayment = params?._meta?.['x402/payment'];
  let paymentPayload = null;
  if (metaPayment && typeof metaPayment === 'object') {
    paymentPayload = metaPayment;
  } else {
    const rawHeader = req.headers['payment-signature'] || req.headers['x-payment'];
    if (rawHeader) {
      try {
        paymentPayload = decodePaymentSignatureHeader(String(rawHeader));
      } catch (e) {
        const paymentRequired = await server.createPaymentRequiredResponse(requirements, resourceInfo, 'Malformed payment signature.');
        return { authorized: false, paymentRequired };
      }
    }
  }

  if (!paymentPayload) {
    const paymentRequired = await server.createPaymentRequiredResponse(requirements, resourceInfo, 'Payment required');
    return { authorized: false, paymentRequired };
  }

  const matchingRequirements = server.findMatchingRequirements(requirements, paymentPayload);
  if (!matchingRequirements) {
    const paymentRequired = await server.createPaymentRequiredResponse(requirements, resourceInfo, 'No matching payment requirements', undefined, undefined, paymentPayload);
    return { authorized: false, paymentRequired };
  }

  let verifyResult;
  try {
    verifyResult = await server.verifyPayment(paymentPayload, matchingRequirements);
  } catch (e) {
    const paymentRequired = await server.createPaymentRequiredResponse(requirements, resourceInfo, 'Payment verification failed: ' + e.message, undefined, undefined, paymentPayload);
    return { authorized: false, paymentRequired };
  }
  if (!verifyResult.isValid) {
    const paymentRequired = await server.createPaymentRequiredResponse(requirements, resourceInfo, verifyResult.invalidReason || 'Payment verification failed', undefined, undefined, paymentPayload);
    return { authorized: false, paymentRequired };
  }

  return {
    authorized: true,
    settle: () => server.settlePayment(paymentPayload, matchingRequirements),
    settlementFailurePaymentRequired: (message) => server.createPaymentRequiredResponse(requirements, resourceInfo, message, undefined, undefined, paymentPayload)
  };
}

// Shared by the get_ioc_context and get_ioc_batch special cases, and by
// every other paid tool: runs the full license -> free tier -> x402 gate.
// Returns { authorized: true, settle? } when the caller may proceed (settle,
// if present, MUST be invoked after the tool succeeds, never before), or
// { authorized: false, handled: true } when a response has already been
// written directly (licence-key failures — see below — are unchanged), or
// { authorized: false, paymentRequired } when the caller should send the x402
// v2 MCP payment-required tool result (HTTP 200, isError: true).
//
// FIX (1.9.1): free tier used to be checked regardless of whether a
// payment header was present, so a real payer with free-tier quota
// remaining got silently served for free — their payment was captured
// but never verified. Free tier now only runs when there's NO payment
// offered at all (header or _meta); if one is present, x402 verification
// runs first, always.
//
// FIX (1.9.2): free tier used to be granted automatically to anyone
// without a payment header, with no way to decline it. A caller with no
// license key, no payment header, and no opt-in got served for free
// instead of seeing a payment challenge — which broke discovery crawlers
// (e.g. x402 Bazaar) that probe with no credentials specifically to confirm
// payment is demanded. Free tier now requires an explicit "x-free-tier: 1"
// header; without it, no license key + no payment offered falls straight
// through to the x402 gate below.
async function runPaymentGate(req, res, requestId, licenseKey, mcpRequestIdentifier, params, toolName, pg1RequestId) {
  if (licenseKey) {
    const check = await verifyGumroadLicense(licenseKey);
    if (check.valid) return { authorized: true };
    if (check.reason === 'verification_unavailable') {
      res.setHeader('Retry-After', '5');
      recordToolError(`/api/mcp:${toolName}`, 503, `${toolName}_license_verification_unavailable`, 'upstream', pg1RequestId);
      res.status(503).json({ jsonrpc: '2.0', error: { code: -32003, message: 'License verification temporarily unavailable, please retry.', data: { request_id: pg1RequestId } }, id: requestId });
      return { authorized: false, handled: true };
    }
    res.status(402).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Payment Required: ' + check.error, data: { request_id: pg1RequestId } }, id: requestId });
    return { authorized: false, handled: true };
  }

  const rawPayment = params?._meta?.['x402/payment'] || req.headers['x-payment'] || req.headers['payment-signature'];
  const freeTierOptIn = req.headers['x-free-tier'] === '1';

  if (!rawPayment && freeTierOptIn) {
    try {
      const { supUrl, supKey } = getSupabaseCreds();
      const freeTierAvailability = await checkFreeTierAvailable(supUrl, supKey, mcpRequestIdentifier);
      if (freeTierAvailability.allowed) {
        // Deferred like x402's settle(): the caller must invoke this only
        // after the gated tool call actually succeeds, so a failed lookup
        // doesn't burn one of the 5/day for nothing.
        return {
          authorized: true,
          consumeFreeTier: async () => {
            await consumeFreeTier(supUrl, supKey, mcpRequestIdentifier, freeTierAvailability);
            logSettlementOutcome('/api/mcp', 'free_tier', mcpRequestIdentifier, 'remaining=' + freeTierAvailability.remaining);
          }
        };
      }
    } catch (e) {}
  }

  return runX402Gate(req, params);
}

// Writes the x402 v2 MCP payment-required tool result: HTTP 200 (never 402)
// with isError: true, structuredContent set to the PaymentRequired object,
// and content[0].text carrying the same object as JSON text — per the x402
// v2 MCP transport spec. Also sends PAYMENT-REQUIRED for backward
// compatibility with clients that only read the header.
function sendPaymentRequiredResult(res, requestId, paymentRequired, pg1RequestId) {
  res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(paymentRequired));
  return res.status(200).json({
    jsonrpc: '2.0',
    result: {
      isError: true,
      structuredContent: paymentRequired,
      content: [{ type: 'text', text: JSON.stringify(paymentRequired) }]
    },
    id: requestId
  });
}

// Settles a verified x402 payment after the tool has already run
// successfully. On success, sets the PAYMENT-RESPONSE header (unchanged
// behaviour) and returns the settlement object to attach to
// result._meta["x402/payment-response"]. On failure, writes the same
// payment-required tool result as an unpaid call and returns null so the
// caller does not also send its own response.
//
// Each settle attempt also records a 'settlement' telemetry row (latency is
// the facilitator settle call only) and marks the surrounding tool call's
// telemetry as settlement_failed on failure - both fire-and-forget (the
// write is kept alive past the response by waitUntil in lib/telemetry.mjs).
async function settleAndRespondOnFailure(res, requestId, gate, pg1RequestId, callTelemetry) {
  let settleResult;
  const settleStartedAt = Date.now();
  const recordSettlement = (status) => {
    if (callTelemetry && status !== 'settled') callTelemetry.status = 'settlement_failed';
    recordTelemetry({ eventType: 'settlement', endpoint: '/api/mcp', toolName: callTelemetry?.toolName, paymentType: 'x402', status, latencyMs: Date.now() - settleStartedAt, callerHash: callTelemetry?.callerHash });
  };
  try {
    settleResult = await gate.settle();
  } catch (e) {
    recordSettlement('error');
    const paymentRequired = await gate.settlementFailurePaymentRequired('Settlement failed: ' + e.message);
    sendPaymentRequiredResult(res, requestId, paymentRequired, pg1RequestId);
    return null;
  }
  recordSettlement(settleResult.success ? 'settled' : 'failed');
  if (!settleResult.success) {
    const paymentRequired = await gate.settlementFailurePaymentRequired(settleResult.errorMessage || settleResult.errorReason || 'Settlement failed');
    sendPaymentRequiredResult(res, requestId, paymentRequired, pg1RequestId);
    return null;
  }
  res.setHeader('PAYMENT-RESPONSE', encodePaymentResponseHeader(settleResult));
  return settleResult;
}

const STANDARD_TOOL_HANDLERS = {
  get_threat_indicators: handleThreatIndicators,
  get_cve_details: handleCveDetails,
  get_cve_batch: handleCveBatch,
  get_threat_actor_profile: handleThreatActorProfile,
  get_cve_by_product: handleCveByProduct
};

// get_ioc_context and get_ioc_batch are handled as special cases in
// tools/call (see below) because their payment gate depends on the
// lookup result — not applied uniformly before the tool runs, like every
// other STANDARD_TOOL_HANDLERS entry.

const FREE_TOOLS = new Set(['get_usage_status', 'check_wallet_sanctions', 'check_domain_age', 'check_hostname_reputation', 'check_wallet_age', 'check_ip_abuse']);

// One entry point per read-only tool, used by tools/call for the free tools
// below and by the chat's tool loop (lib/chatTools.mjs) for every read-only
// tool, so a check asked for in chat runs the exact handler an MCP client
// gets - never an HTTP round trip to this endpoint. `ctx.licensed` is the
// operator's standing (lib/chatTools.mjs): it exempts the 60/hour anonymous
// rate limit the same way a valid Gumroad key does; upstream timeouts and
// caches inside each handler apply to everyone. The two write tools
// (subscribe_alerts, submit_indicator) and the paid feed are deliberately
// not here: nothing the chat can reach writes, pays or changes state.
export const READ_ONLY_TOOL_RUNNERS = Object.freeze({
  get_usage_status: (args, ctx) => handleUsageStatus(args, ctx.identifier),
  check_wallet_sanctions: (args) => handleCheckWalletSanctions(args),
  check_domain_age: (args, ctx) => handleCheckDomainAge(args, ctx.identifier, ctx.licenseKey, { licensed: ctx.licensed }),
  check_hostname_reputation: (args, ctx) => handleCheckHostnameReputation(args, ctx.identifier, ctx.licenseKey, { licensed: ctx.licensed }),
  check_wallet_age: (args, ctx) => handleCheckWalletAge(args, ctx.identifier, ctx.licenseKey, { licensed: ctx.licensed }),
  get_ioc_context: (args) => handleIocContext(args),
  get_ioc_batch: (args) => handleIocBatch(args),
  get_cve_details: (args) => handleCveDetails(args),
  get_cve_batch: (args) => handleCveBatch(args),
  get_cve_by_product: (args) => handleCveByProduct(args),
  get_threat_actor_profile: (args) => handleThreatActorProfile(args)
});

export async function runReadOnlyTool(toolName, args, ctx = {}) {
  const runner = READ_ONLY_TOOL_RUNNERS[toolName];
  if (!runner) throw new Error(`${toolName} is not a read-only tool`);
  return runner(args || {}, { identifier: ctx.identifier || 'unknown', licenseKey: ctx.licenseKey, licensed: ctx.licensed === true });
}

const LICENSE_ONLY_TOOLS = new Set(['subscribe_alerts', 'submit_indicator']);

// Telemetry for one tools/call (lib/telemetry.mjs). Status comes from an
// explicit override set along the way (payment_required, tool_error,
// rate_limited, settlement_failed, unknown_tool) or else from the HTTP
// status already sent. An unrecognised tool name is caller input, so it's
// never stored; the caller IP is only ever passed on as a salted hash.
// Called from the handler's finally, after the response is written; the
// unawaited insert is registered with Vercel's waitUntil inside
// recordTelemetry, so it still completes before the function is frozen.
const KNOWN_TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

function paymentTypeForGate(gate) {
  if (!gate.authorized) return 'none';
  if (gate.settle) return 'x402';
  if (gate.consumeFreeTier) return 'free_tier';
  return 'license';
}

function noteGateTelemetry(callTelemetry, gate) {
  callTelemetry.paymentType = paymentTypeForGate(gate);
  if (!gate.authorized && !gate.handled) callTelemetry.status = 'payment_required';
}

// Salted hash of the caller IP for telemetry; null when there is none.
// Never throws (a request without headers still gets its response).
export function requestCallerHash(req) {
  try {
    return callerHash(getRequestIdentifier(req));
  } catch {
    return null;
  }
}

function statusFromHttp(statusCode) {
  if (statusCode >= 200 && statusCode < 300) return 'ok';
  if (statusCode === 402) return 'payment_required';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode >= 400 && statusCode < 500) return 'client_error';
  if (statusCode >= 500) return 'server_error';
  return 'unknown';
}

function recordToolCallTelemetry(callTelemetry, res) {
  try {
    const known = KNOWN_TOOL_NAMES.has(callTelemetry.toolName);
    recordTelemetry({
      eventType: 'tool_call',
      endpoint: '/api/mcp',
      toolName: known ? callTelemetry.toolName : null,
      paymentType: callTelemetry.paymentType,
      status: known ? (callTelemetry.status || statusFromHttp(res.statusCode)) : 'unknown_tool',
      latencyMs: Date.now() - callTelemetry.startedAt,
      callerHash: callTelemetry.callerHash,
      isFixture: callTelemetry.isFixture === true
    });
  } catch {
    // Best-effort - telemetry never affects the response.
  }
}

// Generic (never vendor-named) `checks[].source` labels used when a tool
// call fails before producing a result (issue #215) - keyed by tool name so
// the single shared catch blocks below can build the right checks entry
// without duplicating per-tool logic.
export const TOOL_SOURCE_LABELS = {
  get_threat_indicators: 'threat indicator feed',
  get_cve_details: 'vulnerability database',
  get_cve_batch: 'vulnerability database',
  get_cve_by_product: 'vulnerability database',
  get_threat_actor_profile: 'threat actor intelligence',
  get_ioc_context: 'threat indicator feed',
  get_ioc_batch: 'threat indicator feed',
  get_usage_status: 'usage records',
  check_wallet_sanctions: 'sanctions list',
  check_domain_age: 'domain registration records',
  check_hostname_reputation: 'phishing domain list',
  check_wallet_age: 'on-chain transfer history',
  check_ip_abuse: IP_ABUSE_SOURCE
};

// ---------------------------------------------------------------------
// HTTP HANDLER
// ---------------------------------------------------------------------

export default async function handler(req, res) {
  // A UUID unique to this request (issue #215), distinct from the JSON-RPC
  // `requestId` below (that's the caller's own `id` field, echoed back
  // as-is). Set as a response header immediately so it's present on every
  // response this handler can produce, including ones returned before the
  // body is even parsed.
  const pg1RequestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', pg1RequestId);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, Authorization, x-api-key, PAYMENT-SIGNATURE, X-Payment, X-Free-Tier, ${ABUSEIPDB_KEY_HEADER}`);
  res.setHeader('Access-Control-Expose-Headers', 'X-Payment, Payment-Signature, x-free-tier, X-API-KEY, PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Request-Id, Retry-After');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      name: 'pg1-threat-intel',
      version: '1.16.0',
      status: 'healthy',
      protocol: 'Model Context Protocol over Streamable HTTP',
      endpoint: 'https://pg1-ai-agent.vercel.app/api/mcp',
      request_id: pg1RequestId
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST for MCP JSON-RPC requests.', request_id: pg1RequestId });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON', data: { request_id: pg1RequestId } }, id: '1' });
  }

  const { id, method, params } = body;
  const requestId = (id !== undefined && id !== null) ? id : '1';
  // Set for every tools/call (fixtures included); recorded in the finally
  // below, after the response has been written.
  let callTelemetry = null;

  try {
    if (method === 'initialize') {
      // One 'initialize' telemetry row: the client's self-reported name and
      // version (sanitised and cut short in lib/telemetry.mjs) and a salted
      // hash of the caller IP - nothing else from the request.
      const clientInfo = params && typeof params.clientInfo === 'object' && params.clientInfo ? params.clientInfo : {};
      recordTelemetry({ eventType: 'initialize', endpoint: '/api/mcp', status: 'ok', clientName: clientInfo.name, clientVersion: clientInfo.version, callerHash: requestCallerHash(req) });
      return res.status(200).json({
        jsonrpc: '2.0',
        result: { protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(params?.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pg1-threat-intel', version: '1.16.0' } },
        id: requestId
      });
    }

    if (method === 'notifications/initialized') {
      return res.status(204).end();
    }

    if (method === 'tools/list') {
      return res.status(200).json({ jsonrpc: '2.0', result: { tools: TOOLS }, id: requestId });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      // Integration test fixtures (issue #215 part B): an exact fixture
      // input is answered here, before any licence check, payment gate,
      // rate limit, cache, upstream call or error logging below - always
      // free, for every caller, key or no key.
      // Fixture calls are recorded too, flagged is_fixture, so the usage
      // stats can leave them out.
      callTelemetry = { toolName, paymentType: 'none', status: null, startedAt: Date.now(), callerHash: requestCallerHash(req) };
      const fixtureOutcome = resolveTestFixture(toolName, toolArgs);
      if (fixtureOutcome) {
        callTelemetry.isFixture = true;
        callTelemetry.paymentType = 'free';
        if (fixtureOutcome.type === 'tool_error') callTelemetry.status = 'tool_error';
        return sendMcpFixtureResponse(res, toolName, fixtureOutcome, requestId, pg1RequestId);
      }

      const licenseKey = req.headers['x-api-key'];
      const mcpRequestIdentifier = getRequestIdentifier(req);

      if (FREE_TOOLS.has(toolName)) {
        callTelemetry.paymentType = 'free';
        let toolResult;
        try {
          if (toolName === 'check_wallet_sanctions') await enforceWalletSanctionsRateLimit(mcpRequestIdentifier, licenseKey);
          toolResult = toolName === 'check_ip_abuse'
            ? await handleCheckIpAbuse(toolArgs, { identifier: mcpRequestIdentifier, licenseKey, abuseIpdbKey: readCustomerKey(req.headers) })
            : await runReadOnlyTool(toolName, toolArgs, { identifier: mcpRequestIdentifier, licenseKey });
        } catch (toolErr) {
          if (toolErr.serviceUnavailable) {
            recordToolError(`/api/mcp:${toolName}`, 503, `${toolName}_upstream_unavailable`, 'upstream', pg1RequestId);
            return res.status(503).json({ jsonrpc: '2.0', error: { code: -32003, message: toolErr.message, data: { request_id: pg1RequestId } }, id: requestId });
          }
          if (toolErr.mcpToolError) {
            // Only 'upstream_unavailable' (a genuine data-source outage or
            // timeout, e.g. check_wallet_age) is logged here - caller
            // mistakes (invalid_address/invalid_chain/invalid_hostname) and
            // rate_limited are normal, expected isError results, not bugs.
            // check_ip_abuse's upstream failures carry their own fixed
            // logReason (lib/abuseIpdb.mjs) - never the key or the body.
            if (toolErr.logReason) {
              recordToolError(`/api/mcp:${toolName}`, toolErr.logStatus ?? null, toolErr.logReason, toolErr.logCategory || 'upstream', pg1RequestId);
            } else if (toolErr.code === 'upstream_unavailable') {
              const isTimeout = /timed out/i.test(toolErr.message);
              recordToolError(`/api/mcp:${toolName}`, null, `${toolName}_${isTimeout ? 'timeout' : 'upstream_unavailable'}`, isTimeout ? 'timeout' : 'upstream', pg1RequestId);
            }
            callTelemetry.status = toolErr.code === 'rate_limited' ? 'rate_limited' : 'tool_error';
            const errorChecks = [buildCheck(TOOL_SOURCE_LABELS[toolName] || toolName, classifyToolErrorCheckResult(toolErr))];
            const errorBody = { error: true, code: toolErr.code, message: invalidInputMessage(toolErr, pg1RequestId), ...errorResponseMeta(errorChecks, pg1RequestId) };
            if (toolErr.retryAfter) {
              errorBody.retry_after = toolErr.retryAfter;
              res.setHeader('Retry-After', String(toolErr.retryAfter));
            }
            return res.status(200).json({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: JSON.stringify(errorBody, null, 2) }],
                isError: true
              },
              id: requestId
            });
          }
          return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: invalidInputMessage(toolErr, pg1RequestId), data: { request_id: pg1RequestId } }, id: requestId });
        }
        toolResult.request_id = pg1RequestId;
        const result = { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] };
        if (STRUCTURED_CONTENT_TOOLS.has(toolName)) {
          result.structuredContent = toolResult;
        }
        return res.status(200).json({ jsonrpc: '2.0', result, id: requestId });
      }

      if (LICENSE_ONLY_TOOLS.has(toolName)) {
        if (!licenseKey) {
          return res.status(402).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: `${toolName} requires a valid Gumroad license key in X-API-KEY. Not available via x402.` },
            id: requestId
          });
        }
        const check = await verifyGumroadLicense(licenseKey);
        if (check.reason === 'verification_unavailable') {
          res.setHeader('Retry-After', '5');
          recordToolError(`/api/mcp:${toolName}`, 503, `${toolName}_license_verification_unavailable`, 'upstream', pg1RequestId);
          return res.status(503).json({ jsonrpc: '2.0', error: { code: -32003, message: 'License verification temporarily unavailable, please retry.', data: { request_id: pg1RequestId } }, id: requestId });
        }
        if (!check.valid) {
          return res.status(402).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Payment Required: ' + check.error, data: { request_id: pg1RequestId } }, id: requestId });
        }
        callTelemetry.paymentType = 'license';
        let toolResult;
        try {
          toolResult = toolName === 'subscribe_alerts'
            ? await handleSubscribeAlerts(toolArgs, licenseKey)
            : await handleSubmitIndicator(toolArgs, licenseKey);
        } catch (toolErr) {
          return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: invalidInputMessage(toolErr, pg1RequestId), data: { request_id: pg1RequestId } }, id: requestId });
        }
        toolResult.request_id = pg1RequestId;
        return res.status(200).json({
          jsonrpc: '2.0',
          result: { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] },
          id: requestId
        });
      }

      // SPECIAL CASE: get_ioc_context — free when not found, gated when found.
      if (toolName === 'get_ioc_context') {
        const value = toolArgs?.value?.trim();
        if (!value) {
          return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: formatFixIt(IOC_VALUE_FIX_IT, pg1RequestId), data: { request_id: pg1RequestId } }, id: requestId });
        }
        let lookupResult;
        try {
          const { supUrl, supKey } = getSupabaseCreds();
          lookupResult = withIocResponseMeta(await lookupIocContext(value, supUrl, supKey));
        } catch (e) {
          const status = e.serviceUnavailable ? 503 : 500;
          recordToolError('/api/mcp:get_ioc_context', status, 'ioc_context_lookup_failed', e.serviceUnavailable ? 'upstream' : 'js_error', pg1RequestId);
          return res.status(status).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message, data: { request_id: pg1RequestId } }, id: requestId });
        }
        lookupResult.request_id = pg1RequestId;

        if (!lookupResult.found) {
          callTelemetry.paymentType = 'free';
          return res.status(200).json({
            jsonrpc: '2.0',
            result: { content: [{ type: 'text', text: JSON.stringify(lookupResult, null, 2) }] },
            id: requestId
          });
        }

        const gate = await runPaymentGate(req, res, requestId, licenseKey, mcpRequestIdentifier, params, 'get_ioc_context', pg1RequestId);
        noteGateTelemetry(callTelemetry, gate);
        if (gate.handled) return;
        if (!gate.authorized) return sendPaymentRequiredResult(res, requestId, gate.paymentRequired, pg1RequestId);

        const result = { content: [{ type: 'text', text: JSON.stringify(lookupResult, null, 2) }] };
        if (gate.settle) {
          const settlement = await settleAndRespondOnFailure(res, requestId, gate, pg1RequestId, callTelemetry);
          if (!settlement) return;
          result._meta = { 'x402/payment-response': settlement };
        }
        if (gate.consumeFreeTier) await gate.consumeFreeTier();
        return res.status(200).json({ jsonrpc: '2.0', result, id: requestId });
      }

      // SPECIAL CASE: get_ioc_batch — free only if NONE of the values were
      // found; gated (for the whole batch result) if at least one was found.
      if (toolName === 'get_ioc_batch') {
        let batchResult;
        try {
          batchResult = await handleIocBatch(toolArgs);
        } catch (toolErr) {
          if (toolErr.serviceUnavailable) {
            recordToolError('/api/mcp:get_ioc_batch', 503, 'get_ioc_batch_upstream_unavailable', 'upstream', pg1RequestId);
            return res.status(503).json({ jsonrpc: '2.0', error: { code: -32003, message: toolErr.message, data: { request_id: pg1RequestId } }, id: requestId });
          }
          return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: invalidInputMessage(toolErr, pg1RequestId), data: { request_id: pg1RequestId } }, id: requestId });
        }
        batchResult.request_id = pg1RequestId;

        if (batchResult.total_found === 0) {
          callTelemetry.paymentType = 'free';
          return res.status(200).json({
            jsonrpc: '2.0',
            result: { content: [{ type: 'text', text: JSON.stringify(batchResult, null, 2) }] },
            id: requestId
          });
        }

        const gate = await runPaymentGate(req, res, requestId, licenseKey, mcpRequestIdentifier, params, 'get_ioc_batch', pg1RequestId);
        noteGateTelemetry(callTelemetry, gate);
        if (gate.handled) return;
        if (!gate.authorized) return sendPaymentRequiredResult(res, requestId, gate.paymentRequired, pg1RequestId);

        const result = { content: [{ type: 'text', text: JSON.stringify(batchResult, null, 2) }] };
        if (gate.settle) {
          const settlement = await settleAndRespondOnFailure(res, requestId, gate, pg1RequestId, callTelemetry);
          if (!settlement) return;
          result._meta = { 'x402/payment-response': settlement };
        }
        if (gate.consumeFreeTier) await gate.consumeFreeTier();
        return res.status(200).json({ jsonrpc: '2.0', result, id: requestId });
      }

      const toolHandler = STANDARD_TOOL_HANDLERS[toolName];
      if (!toolHandler) {
        const unknownTool = { problem: 'params.name is not the name of a tool on this server', expected: `one of ${TOOLS.map((t) => t.name).join(', ')} (see tools/list)`, example: 'check_domain_age' };
        return res.status(200).json({ jsonrpc: '2.0', error: { code: -32602, message: formatFixIt(unknownTool, pg1RequestId), data: { request_id: pg1RequestId } }, id: requestId });
      }

      const gate = await runPaymentGate(req, res, requestId, licenseKey, mcpRequestIdentifier, params, toolName, pg1RequestId);
      noteGateTelemetry(callTelemetry, gate);
      if (gate.handled) return;
      if (!gate.authorized) return sendPaymentRequiredResult(res, requestId, gate.paymentRequired, pg1RequestId);

      let toolResult;
      try {
        toolResult = await toolHandler(toolArgs);
      } catch (toolErr) {
        if (toolErr.serviceUnavailable) {
          recordToolError(`/api/mcp:${toolName}`, 503, `${toolName}_upstream_unavailable`, 'upstream', pg1RequestId);
          return res.status(503).json({ jsonrpc: '2.0', error: { code: -32003, message: toolErr.message, data: { request_id: pg1RequestId } }, id: requestId });
        }
        const code = toolErr.notFound ? 404 : 400;
        return res.status(code).json({ jsonrpc: '2.0', error: { code: toolErr.notFound ? -32004 : -32602, message: invalidInputMessage(toolErr, pg1RequestId), data: { request_id: pg1RequestId } }, id: requestId });
      }
      toolResult.request_id = pg1RequestId;

      const result = { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] };
      if (gate.settle) {
        const settlement = await settleAndRespondOnFailure(res, requestId, gate, pg1RequestId, callTelemetry);
        if (!settlement) return;
        result._meta = { 'x402/payment-response': settlement };
      }
      if (gate.consumeFreeTier) await gate.consumeFreeTier();
      return res.status(200).json({ jsonrpc: '2.0', result, id: requestId });
    }

    return res.status(200).json({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${method || 'unknown'}`, data: { request_id: pg1RequestId } }, id: requestId });
  } catch (err) {
    // This is the catch-all for anything the specific handlers above didn't
    // already turn into a sanitized message (a genuine bug, not an expected
    // failure) — err.message here can be a raw internal (stack detail,
    // ENOTFOUND, upstream response text). Log it server-side only; never
    // echo it back into the response body.
    console.error('[MCP] unhandled tools/call exception:', err.message);
    recordToolError('/api/mcp', 500, 'unhandled_exception', 'js_error', pg1RequestId);
    return res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error', data: { request_id: pg1RequestId } }, id: requestId });
  } finally {
    if (callTelemetry) recordToolCallTelemetry(callTelemetry, res);
  }
}