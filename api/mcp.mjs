/**
 * PG1 Sovereign Threat Intelligence MCP Server
 * Endpoint: /api/mcp
 * Protocol: Model Context Protocol (MCP) over Streamable HTTP
 * Monetization: x402 (Base chain micropayments) & Gumroad license keys
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
import { checkAndConsumeFreeTier, getRequestIdentifier, logSettlementOutcome, FREE_TIER_DAILY_LIMIT } from '../lib/freeTier.mjs';
import { verifyGumroadLicense } from '../lib/paymentGate.mjs';
import { getSupabaseCreds } from '../lib/supabase.mjs';
import { detectIndicatorType, lookupIocContext } from '../lib/iocContext.mjs';
import { normalizeWalletAddress, isRecognizedWalletAddress } from '../lib/walletAddress.mjs';
import { extractRegistrableDomain } from '../lib/domainExtraction.mjs';
import { domainToASCII, domainToUnicode } from 'node:url';

export const config = { maxDuration: 30 };

// ---------------------------------------------------------------------
// TOOLS
// ---------------------------------------------------------------------

const CVE_BATCH_MAX = 20;
const IOC_BATCH_MAX = 20;

const TOOLS = [
  {
    name: 'get_threat_indicators',
    description: 'PG1 Sovereign Threat Intelligence: returns a STIX 2.1 bundle of verified threat indicators (IPs, domains, URLs, file hashes) sourced from ThreatFox, URLhaus, OTX and NVD. Payment required: $0.01 via x402, sent in params._meta["x402/payment"] (the PAYMENT-SIGNATURE header is also accepted), or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use ONLY for bulk feed synchronizations. Do NOT use for single-item lookups (use get_ioc_context) or CVE analysis (use get_cve_details). USAGE EXCLUSIONS: Does not provide historical query archival beyond the active ingestion window. BEHAVIOR: Pagination is handled via the limit parameter (max 1000). If payment is missing or fails, returns a normal tool result with isError: true, the x402 v2 PaymentRequired object in structuredContent and the same JSON in content[0].text; on success the settlement receipt is in result._meta["x402/payment-response"].',
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
    description: "PG1 Sovereign Threat Intelligence: looks up a single specific indicator value (IP, domain, URL, or hash) — the recommended pre-action safety check for AI agents before visiting, downloading, or connecting to something. Returns aggregated provenance from ThreatFox, URLhaus, and OTX — reporting sources, observation count, aggregated confidence score, known malware families, tags, and first/last seen timestamps. SIBLING DIFFERENTIATION: Use ONLY for point-lookup enrichment of a single indicator. Do NOT use for bulk intelligence downloads (use get_threat_indicators), multiple indicators at once (use get_ioc_batch), or software vulnerability analysis (use get_cve_details). BEHAVIOR: Returns a normal result shaped { found: true, indicator_type, provenance } or { found: false } — never an error for 'not found'. A found:false result means nothing bad is recorded in PG1's sources; it does NOT mean the indicator is safe, only that it isn't in this dataset. Lookups that return found:false are FREE — no payment or free-tier quota is consumed. Payment (x402 via params._meta['x402/payment'], with the PAYMENT-SIGNATURE header also accepted, or a Gumroad X-API-KEY license) is only required when a real record is found. If payment is required but missing or fails, the result has isError: true with the x402 v2 PaymentRequired object in structuredContent.",
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
    description: "PG1 Sovereign Threat Intelligence: looks up multiple CVE identifiers in a single call, each enriched with NVD description/CVSS, FIRST.org EPSS score, and CISA KEV status — same enrichment as get_cve_details, batched. Payment required: $0.01 via x402 (PAYMENT-SIGNATURE header) or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use for looking up several known CVE ids at once (e.g. from an SBOM or scan report). Do NOT use for a single CVE (use get_cve_details, lower overhead) or for discovering CVEs by vendor/product (use get_cve_by_product). BEHAVIOR: Accepts up to " + CVE_BATCH_MAX + " ids per call; malformed or not-found ids are reported per-entry rather than failing the whole batch.",
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
    description: "PG1 Sovereign Threat Intelligence: looks up multiple indicators (IPs, domains, URLs, hashes) in a single call — a batched pre-action safety check for AI agents. Each returns the same aggregated provenance as get_ioc_context from ThreatFox, URLhaus, AbuseIPDB, and OTX. SIBLING DIFFERENTIATION: Use for checking several indicators at once (e.g. all URLs an agent is about to visit). Do NOT use for a single indicator (use get_ioc_context, lower overhead) or bulk feed synchronization (use get_threat_indicators). BEHAVIOR: Accepts up to " + IOC_BATCH_MAX + " indicators per call. A found:false result for any indicator means nothing bad is recorded in PG1's sources — NOT that it's safe. If NONE of the submitted indicators are found, the whole batch is FREE — no payment or free-tier quota consumed. If at least one indicator is found, the normal payment gate (x402 PAYMENT-SIGNATURE header or a Gumroad X-API-KEY license) applies to the full batch result.",
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
    description: "PG1 Sovereign Threat Intelligence: returns a dossier for a known threat actor / APT group — aliases, description, associated MITRE ATT&CK techniques, and associated malware/tooling. Sourced from MITRE ATT&CK Enterprise. Payment required: $0.01 via x402 (PAYMENT-SIGNATURE header) or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use for actor/group-level profiling. Do NOT use for single-indicator lookups (use get_ioc_context) or vulnerability data (use get_cve_details / get_cve_batch). USAGE EXCLUSIONS: Coverage is limited to groups tracked in MITRE ATT&CK — not all threat actors have an entry. BEHAVIOR: Returns 404 if no matching group or alias is found.",
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
    description: 'PG1 Sovereign Threat Intelligence: returns CVEs affecting a given vendor/product (optionally a specific version), enriched with CVSS, EPSS, and CISA KEV status, sorted by exploitation risk. Sourced from NVD keyword search. Payment required: $0.01 via x402 (PAYMENT-SIGNATURE header) or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use for discovering CVEs by vendor/product when you do not already have an exact CVE id. Do NOT use for a known CVE id (use get_cve_details / get_cve_batch). USAGE EXCLUSIONS: Uses NVD keyword search, not strict CPE matching — results may include near-matches. BEHAVIOR: Returns up to 50 results per call.',
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
        disclaimer: { type: 'string' }
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
        reason_code: { type: ['string', 'null'], enum: ['invalid_domain', 'bootstrap_unavailable', 'unsupported_tld', 'timeout', 'lookup_failed', null] }
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
        attribution: { type: 'string' }
      },
      required: ['hostname', 'verdict', 'sources', 'lookalike_of', 'list_synced_at', 'checked_at', 'attribution']
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

  let res;
  try {
    res = await fetch(`${supUrl}/rest/v1/threat_ioc_telemetry?${filters.join('&')}`, {
      headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }
    });
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

  return {
    type: 'bundle',
    id: `bundle--${crypto.randomUUID()}`,
    spec_version: '2.1',
    objects
  };
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

async function handleCveDetails(args) {
  const cveId = args?.cve_id;
  if (!cveId || !/^CVE-\d{4}-\d{4,}$/i.test(String(cveId))) {
    const err = new Error("cve_id is required and must match the format 'CVE-YYYY-NNNN'.");
    err.notFound = true;
    throw err;
  }
  const normalizedId = String(cveId).toUpperCase();

  const [nvd, epss, kevCatalog] = await Promise.all([
    fetchNvdCveDetails(normalizedId).catch((e) => ({ error: e.message })),
    fetchEpssScore(normalizedId).catch(() => null),
    getKevCatalog().catch(() => ({}))
  ]);

  if (!nvd || nvd.error) {
    const err = new Error(`CVE not found or NVD lookup failed for ${normalizedId}.`);
    err.notFound = true;
    throw err;
  }

  const kevEntry = kevCatalog[normalizedId];

  return {
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
  };
}

async function handleCveBatch(args) {
  const cveIds = args?.cve_ids;
  if (!Array.isArray(cveIds) || cveIds.length === 0) {
    throw new Error('cve_ids is required and must be a non-empty array of strings.');
  }
  if (cveIds.length > CVE_BATCH_MAX) {
    throw new Error(`cve_ids exceeds the maximum batch size of ${CVE_BATCH_MAX}.`);
  }

  const kevCatalog = await getKevCatalog().catch(() => ({}));

  const results = await Promise.all(cveIds.map(async (rawId) => {
    const cveId = String(rawId || '').toUpperCase();
    if (!/^CVE-\d{4}-\d{4,}$/i.test(cveId)) {
      return { cve_id: rawId, found: false, error: "Malformed CVE id — expected 'CVE-YYYY-NNNN'." };
    }

    const [nvd, epss] = await Promise.all([
      fetchNvdCveDetails(cveId).catch((e) => ({ error: e.message })),
      fetchEpssScore(cveId).catch(() => null)
    ]);

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

  return {
    total_requested: cveIds.length,
    total_found: results.filter((r) => r.found).length,
    results
  };
}

async function handleCveByProduct(args) {
  const vendor = args?.vendor;
  const product = args?.product;
  const version = args?.version;
  const onlyKev = !!args?.only_kev;

  if (!vendor || !product) {
    throw new Error('vendor and product are both required.');
  }

  const keywords = [vendor, product, version].filter(Boolean).join(' ');
  const headers = {};
  if (process.env.NVD_API_KEY) headers.apiKey = process.env.NVD_API_KEY;

  const nvdRes = await fetch(`https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(keywords)}&resultsPerPage=50`, { headers });
  if (!nvdRes.ok) throw new Error('NVD lookup failed: ' + nvdRes.status);
  const nvdData = await nvdRes.json();
  const vulns = (nvdData.vulnerabilities || []).map((v) => v.cve).filter(Boolean);

  if (!vulns.length) {
    return { vendor, product, version: version || null, total_found: 0, cves: [] };
  }

  const kevCatalog = await getKevCatalog().catch(() => ({}));

  const enriched = await Promise.all(vulns.map(async (vuln) => {
    const cveId = vuln.id;
    const enDesc = (vuln.descriptions || []).find((d) => d.lang === 'en');
    const metrics = vuln.metrics || {};
    let cvssData = null, cvssVersion = null;
    if (metrics.cvssMetricV31?.[0]) { cvssData = metrics.cvssMetricV31[0].cvssData; cvssVersion = '3.1'; }
    else if (metrics.cvssMetricV30?.[0]) { cvssData = metrics.cvssMetricV30[0].cvssData; cvssVersion = '3.0'; }
    else if (metrics.cvssMetricV2?.[0]) { cvssData = metrics.cvssMetricV2[0].cvssData; cvssVersion = '2.0'; }

    const epss = await fetchEpssScore(cveId).catch(() => null);
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

  return { vendor, product, version: version || null, total_found: filtered.length, cves: filtered };
}

// ---------------------------------------------------------------------
// get_ioc_context / get_ioc_batch shared helpers
// ---------------------------------------------------------------------

async function handleIocContext(args) {
  const value = args?.value?.trim();
  if (!value) {
    throw new Error('value is required.');
  }

  const { supUrl, supKey } = getSupabaseCreds();
  return await lookupIocContext(value, supUrl, supKey);
}

async function handleIocBatch(args) {
  const values = args?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('values is required and must be a non-empty array of strings.');
  }
  if (values.length > IOC_BATCH_MAX) {
    throw new Error(`values exceeds the maximum batch size of ${IOC_BATCH_MAX}.`);
  }

  const { supUrl, supKey } = getSupabaseCreds();

  const results = await Promise.all(values.map(async (rawValue) => {
    const value = String(rawValue || '').trim();
    if (!value) {
      return { indicator: rawValue, found: false, error: 'Empty indicator value.' };
    }
    return await lookupIocContext(value, supUrl, supKey);
  }));

  return {
    total_requested: values.length,
    total_found: results.filter((r) => r.found).length,
    results
  };
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

async function handleThreatActorProfile(args) {
  const actorName = args?.actor_name?.trim();
  if (!actorName) {
    throw new Error('actor_name is required.');
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

  return {
    actor_name: group.name,
    attack_group_id: attackId ? attackId.external_id : null,
    aliases: group.aliases || [],
    description: group.description || null,
    associated_techniques: techniques,
    associated_software: software,
    source: 'MITRE ATT&CK Enterprise'
  };
}

// ---------------------------------------------------------------------
// get_usage_status — free, no payment gate
// ---------------------------------------------------------------------

async function handleUsageStatus(args, requestIdentifier) {
  const identifier = args?.identifier || requestIdentifier;
  if (!identifier) {
    throw new Error('identifier is required (or must be derivable from the request).');
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
  if (args?.license_key) {
    const check = await verifyGumroadLicense(args.license_key).catch(() => ({ valid: false, error: 'check failed' }));
    licenseStatus = check.valid ? 'active' : 'invalid_or_expired';
  }

  return {
    identifier,
    free_tier_daily_limit: FREE_TIER_DAILY_LIMIT,
    free_tier_calls_used_today: callsToday,
    free_tier_calls_remaining_today: remaining,
    license_status: licenseStatus,
    checked_at: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------
// subscribe_alerts — license-key-only, writes a subscription row
// ---------------------------------------------------------------------

async function handleSubscribeAlerts(args, licenseKey) {
  const webhookUrl = args?.webhook_url;
  if (!webhookUrl || !/^https:\/\//i.test(webhookUrl)) {
    throw new Error('webhook_url is required and must be an https:// URL.');
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

  return {
    subscription_id: inserted[0]?.id,
    webhook_url: webhookUrl,
    filter,
    status: 'active',
    created_at: inserted[0]?.created_at
  };
}

// ---------------------------------------------------------------------
// submit_indicator — license-key-only, writes to a staging table
// ---------------------------------------------------------------------

async function handleSubmitIndicator(args, licenseKey) {
  const indicator = args?.indicator;
  const indicatorType = args?.indicator_type;
  if (!indicator || !indicatorType) {
    throw new Error('indicator and indicator_type are both required.');
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
    return { status: 'duplicate_pending_review', indicator, staging_id: dupRows[0].id };
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

  return {
    status: 'submitted_pending_review',
    indicator,
    staging_id: inserted[0]?.id
  };
}

// ---------------------------------------------------------------------
// check_wallet_sanctions — free, no payment gate
// ---------------------------------------------------------------------

const SANCTIONS_DISCLAIMER = 'Informational only; not legal or sanctions-compliance advice.';
const SANCTIONS_SOURCE = 'OFAC SDN List (US Treasury)';

class InvalidAddressError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidAddressError';
    this.mcpToolError = true;
    this.code = 'invalid_address';
  }
}

async function handleCheckWalletSanctions(args) {
  const rawAddress = args?.address;
  if (typeof rawAddress !== 'string') {
    throw new Error('address is required.');
  }
  if (!rawAddress.trim()) {
    throw new InvalidAddressError(
      `'${rawAddress}' does not match any recognised wallet address format (EVM 0x+40 hex, BTC/LTC/BCH/DOGE/DASH/ZEC base58 or bech32/cashaddr, TRON, Monero, or Solana base58). Not screened.`
    );
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
      throw new InvalidAddressError(
        `'${rawAddress}' does not match any recognised wallet address format (EVM 0x+40 hex, BTC/LTC/BCH/DOGE/DASH/ZEC base58 or bech32/cashaddr, TRON, Monero, or Solana base58). Not screened.`
      );
    }
    return {
      address: rawAddress,
      address_normalized: normalized,
      listed: false,
      matches: [],
      source: SANCTIONS_SOURCE,
      list_last_synced: listLastSynced,
      message: `Not on the OFAC SDN sanctions list as of ${listLastSynced}.`,
      disclaimer: SANCTIONS_DISCLAIMER
    };
  }

  return {
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
  };
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
const DOMAIN_AGE_RATE_LIMIT_MAX = 60;
const DOMAIN_AGE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
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

function domainNotFound(domain, reason, reasonCode) {
  return { found: false, available: false, domain, reason, reason_code: reasonCode };
}

async function handleCheckDomainAge(args, identifier, licenseKey) {
  const raw = args?.domain;
  if (!raw || typeof raw !== 'string') {
    throw new Error('domain is required.');
  }

  const registrable = extractRegistrableDomain(raw);
  if (!registrable) {
    return domainNotFound(raw, 'Could not extract a registrable domain from the provided value.', 'invalid_domain');
  }

  const cached = getCachedDomainResult(registrable);
  if (cached) return cached;

  let licensed = false;
  if (licenseKey) {
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

  const result = {
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
  };
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
  constructor(message) {
    super(message);
    this.name = 'InvalidHostnameError';
    this.mcpToolError = true;
    this.code = 'invalid_hostname';
  }
}

// Trim, lowercase, strip a trailing dot, convert IDN to punycode. Rejects
// anything containing a scheme, path, port, spaces, or wildcards — this is a
// single bare-hostname check, never a bulk/URL input (see issue #121).
function normalizeHostname(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new InvalidHostnameError(`'${raw}' is not a valid bare hostname — provide a single hostname such as 'example.com'.`);
  }
  const original = raw.trim();
  if (/\s/.test(original)) {
    throw new InvalidHostnameError(`'${original}' contains whitespace — provide exactly one bare hostname per call, not a list.`);
  }
  if (original.includes('*')) {
    throw new InvalidHostnameError(`'${original}' contains a wildcard ('*') — wildcards are not supported, provide a single concrete hostname.`);
  }
  if (original.includes('/') || original.includes('\\')) {
    throw new InvalidHostnameError(`'${original}' looks like a URL or path, not a bare hostname — strip any scheme and path, e.g. use 'example.com' not 'https://example.com/path'.`);
  }
  if (original.includes(':')) {
    throw new InvalidHostnameError(`'${original}' contains a colon (a scheme or port) — provide a bare hostname only, e.g. 'example.com'.`);
  }

  let h = original.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) {
    throw new InvalidHostnameError(`'${original}' is not a valid bare hostname.`);
  }

  let ascii;
  try {
    ascii = domainToASCII(h);
  } catch {
    ascii = '';
  }
  if (!ascii || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(ascii)) {
    throw new InvalidHostnameError(`'${original}' could not be normalized to a valid hostname.`);
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
const HOSTNAME_REPUTATION_RATE_LIMIT_MAX = 60;
const HOSTNAME_REPUTATION_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
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
  return {
    hostname,
    verdict,
    sources,
    lookalike_of: lookalikeOf || null,
    list_synced_at: listSyncedAt || null,
    checked_at: new Date().toISOString(),
    attribution: PHISHING_ATTRIBUTION
  };
}

async function handleCheckHostnameReputation(args, identifier, licenseKey) {
  const hostname = normalizeHostname(args?.hostname);

  const cached = getCachedHostnameResult(hostname);
  if (cached) return cached;

  let licensed = false;
  if (licenseKey) {
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
// AUTHORIZATION
// ---------------------------------------------------------------------
// verifyGumroadLicense lives in lib/paymentGate.mjs, shared with
// api/chat.mjs and api/ioc/context.js so all Gumroad verify call sites
// behave identically (increment_uses_count=false, subscription-lapse
// checks, 10min success cache, 2s timeout with cache fallback).

const X402_PAY_TO = (process.env.X402_PAY_TO_ADDRESS || '').trim();
const X402_NETWORK = 'eip155:8453';
const X402_SCHEME = 'exact';
const X402_PRICE = '$0.01';
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
  return { x402Version: 2, error, resource: resourceInfo, accepts: [] };
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
async function runPaymentGate(req, res, requestId, licenseKey, mcpRequestIdentifier, params) {
  if (licenseKey) {
    const check = await verifyGumroadLicense(licenseKey);
    if (check.valid) return { authorized: true };
    if (check.reason === 'verification_unavailable') {
      res.setHeader('Retry-After', '5');
      res.status(503).json({ jsonrpc: '2.0', error: { code: -32003, message: 'License verification temporarily unavailable, please retry.' }, id: requestId });
      return { authorized: false, handled: true };
    }
    res.status(402).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Payment Required: ' + check.error }, id: requestId });
    return { authorized: false, handled: true };
  }

  const rawPayment = params?._meta?.['x402/payment'] || req.headers['x-payment'] || req.headers['payment-signature'];
  const freeTierOptIn = req.headers['x-free-tier'] === '1';

  if (!rawPayment && freeTierOptIn) {
    try {
      const { supUrl, supKey } = getSupabaseCreds();
      const freeTierResult = await checkAndConsumeFreeTier(supUrl, supKey, mcpRequestIdentifier);
      if (freeTierResult.allowed) {
        logSettlementOutcome('/api/mcp', 'free_tier', mcpRequestIdentifier, 'remaining=' + freeTierResult.remaining);
        return { authorized: true };
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
function sendPaymentRequiredResult(res, requestId, paymentRequired) {
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
async function settleAndRespondOnFailure(res, requestId, gate) {
  let settleResult;
  try {
    settleResult = await gate.settle();
  } catch (e) {
    const paymentRequired = await gate.settlementFailurePaymentRequired('Settlement failed: ' + e.message);
    sendPaymentRequiredResult(res, requestId, paymentRequired);
    return null;
  }
  if (!settleResult.success) {
    const paymentRequired = await gate.settlementFailurePaymentRequired(settleResult.errorMessage || settleResult.errorReason || 'Settlement failed');
    sendPaymentRequiredResult(res, requestId, paymentRequired);
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

const FREE_TOOLS = new Set(['get_usage_status', 'check_wallet_sanctions', 'check_domain_age', 'check_hostname_reputation']);

const LICENSE_ONLY_TOOLS = new Set(['subscribe_alerts', 'submit_indicator']);

// ---------------------------------------------------------------------
// HTTP HANDLER
// ---------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, PAYMENT-SIGNATURE, X-Payment, X-Free-Tier');
  res.setHeader('Access-Control-Expose-Headers', 'X-Payment, Payment-Signature, x-free-tier, X-API-KEY, PAYMENT-REQUIRED, PAYMENT-RESPONSE');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      name: 'pg1-threat-intel',
      version: '1.12.0',
      status: 'healthy',
      protocol: 'Model Context Protocol over Streamable HTTP',
      endpoint: 'https://pg1-ai-agent.vercel.app/api/mcp'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST for MCP JSON-RPC requests.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: '1' });
  }

  const { id, method, params } = body;
  const requestId = (id !== undefined && id !== null) ? id : '1';

  try {
    if (method === 'initialize') {
      return res.status(200).json({
        jsonrpc: '2.0',
        result: { protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(params?.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pg1-threat-intel', version: '1.12.0' } },
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
      const licenseKey = req.headers['x-api-key'];
      const mcpRequestIdentifier = getRequestIdentifier(req);

      if (FREE_TOOLS.has(toolName)) {
        let toolResult;
        try {
          if (toolName === 'get_usage_status') {
            toolResult = await handleUsageStatus(toolArgs, mcpRequestIdentifier);
          } else if (toolName === 'check_wallet_sanctions') {
            toolResult = await handleCheckWalletSanctions(toolArgs);
          } else if (toolName === 'check_domain_age') {
            toolResult = await handleCheckDomainAge(toolArgs, mcpRequestIdentifier, licenseKey);
          } else {
            toolResult = await handleCheckHostnameReputation(toolArgs, mcpRequestIdentifier, licenseKey);
          }
        } catch (toolErr) {
          if (toolErr.serviceUnavailable) {
            return res.status(503).json({ jsonrpc: '2.0', error: { code: -32003, message: toolErr.message }, id: requestId });
          }
          if (toolErr.mcpToolError) {
            return res.status(200).json({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: JSON.stringify({ error: true, code: toolErr.code, message: toolErr.message }, null, 2) }],
                isError: true
              },
              id: requestId
            });
          }
          return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: toolErr.message }, id: requestId });
        }
        const result = { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] };
        if (toolName === 'check_wallet_sanctions' || toolName === 'check_domain_age' || toolName === 'check_hostname_reputation') {
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
          return res.status(503).json({ jsonrpc: '2.0', error: { code: -32003, message: 'License verification temporarily unavailable, please retry.' }, id: requestId });
        }
        if (!check.valid) {
          return res.status(402).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Payment Required: ' + check.error }, id: requestId });
        }
        let toolResult;
        try {
          toolResult = toolName === 'subscribe_alerts'
            ? await handleSubscribeAlerts(toolArgs, licenseKey)
            : await handleSubmitIndicator(toolArgs, licenseKey);
        } catch (toolErr) {
          return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: toolErr.message }, id: requestId });
        }
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
          return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: 'value is required.' }, id: requestId });
        }
        let lookupResult;
        try {
          const { supUrl, supKey } = getSupabaseCreds();
          lookupResult = await lookupIocContext(value, supUrl, supKey);
        } catch (e) {
          const status = e.serviceUnavailable ? 503 : 500;
          return res.status(status).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: requestId });
        }

        if (!lookupResult.found) {
          return res.status(200).json({
            jsonrpc: '2.0',
            result: { content: [{ type: 'text', text: JSON.stringify(lookupResult, null, 2) }] },
            id: requestId
          });
        }

        const gate = await runPaymentGate(req, res, requestId, licenseKey, mcpRequestIdentifier, params);
        if (gate.handled) return;
        if (!gate.authorized) return sendPaymentRequiredResult(res, requestId, gate.paymentRequired);

        const result = { content: [{ type: 'text', text: JSON.stringify(lookupResult, null, 2) }] };
        if (gate.settle) {
          const settlement = await settleAndRespondOnFailure(res, requestId, gate);
          if (!settlement) return;
          result._meta = { 'x402/payment-response': settlement };
        }
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
            return res.status(503).json({ jsonrpc: '2.0', error: { code: -32003, message: toolErr.message }, id: requestId });
          }
          return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: toolErr.message }, id: requestId });
        }

        if (batchResult.total_found === 0) {
          return res.status(200).json({
            jsonrpc: '2.0',
            result: { content: [{ type: 'text', text: JSON.stringify(batchResult, null, 2) }] },
            id: requestId
          });
        }

        const gate = await runPaymentGate(req, res, requestId, licenseKey, mcpRequestIdentifier, params);
        if (gate.handled) return;
        if (!gate.authorized) return sendPaymentRequiredResult(res, requestId, gate.paymentRequired);

        const result = { content: [{ type: 'text', text: JSON.stringify(batchResult, null, 2) }] };
        if (gate.settle) {
          const settlement = await settleAndRespondOnFailure(res, requestId, gate);
          if (!settlement) return;
          result._meta = { 'x402/payment-response': settlement };
        }
        return res.status(200).json({ jsonrpc: '2.0', result, id: requestId });
      }

      const toolHandler = STANDARD_TOOL_HANDLERS[toolName];
      if (!toolHandler) {
        return res.status(200).json({ jsonrpc: '2.0', error: { code: -32602, message: `Unknown tool: ${toolName}` }, id: requestId });
      }

      const gate = await runPaymentGate(req, res, requestId, licenseKey, mcpRequestIdentifier, params);
      if (gate.handled) return;
      if (!gate.authorized) return sendPaymentRequiredResult(res, requestId, gate.paymentRequired);

      let toolResult;
      try {
        toolResult = await toolHandler(toolArgs);
      } catch (toolErr) {
        if (toolErr.serviceUnavailable) {
          return res.status(503).json({ jsonrpc: '2.0', error: { code: -32003, message: toolErr.message }, id: requestId });
        }
        const code = toolErr.notFound ? 404 : 400;
        return res.status(code).json({ jsonrpc: '2.0', error: { code: toolErr.notFound ? -32004 : -32602, message: toolErr.message }, id: requestId });
      }

      const result = { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] };
      if (gate.settle) {
        const settlement = await settleAndRespondOnFailure(res, requestId, gate);
        if (!settlement) return;
        result._meta = { 'x402/payment-response': settlement };
      }
      return res.status(200).json({ jsonrpc: '2.0', result, id: requestId });
    }

    return res.status(200).json({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${method || 'unknown'}` }, id: requestId });
  } catch (err) {
    return res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error', data: err.message }, id: requestId });
  }
}