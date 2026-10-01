# PG1 Sovereign Threat Intelligence API

Threat intelligence API and MCP server for AI agents and security tooling.

**License keys:** new sales are temporarily paused while data licensing is finalised. The free tier and x402 remain available.

## Two Ways to Connect

- **`/api/ioc`** — simple REST GET, returns the STIX 2.1 indicator feed directly. Best for scripts, curl, and simple integrations.
- **`/api/mcp`** — full Model Context Protocol server, 14 tools (CVE lookups, batch operations, threat actor dossiers, wallet sanctions screening, domain age, hostname/phishing reputation, wallet age/history, and more). Best for Claude, MCP-compatible agents, and any client speaking the MCP standard.

**Discovery:** [`/llms.txt`](https://pg1-ai-agent.vercel.app/llms.txt) (llmstxt.org format, for AI agents/crawlers) and [`/openapi.json`](https://pg1-ai-agent.vercel.app/openapi.json) (OpenAPI 3.1 spec for `/api/ioc` and `/api/health`).

**Opt-in:** `/api/ioc/context?value=<indicator>` — a REST mirror of the `get_ioc_context` MCP tool, disabled by default. The operator must set `ENABLE_REST_IOC_CONTEXT=true` for this route to respond; otherwise it returns `404 {"error":"not available"}`. Not listed in x402 Bazaar/discovery metadata.

Both accept the same Gumroad license key via the `x-api-key` header, or per-call x402 micropayments ($0.01/call) via the `PAYMENT-SIGNATURE` header (x402 v2).

## Free Tier (5 calls/day)

The free tier is **opt-in** — add `x-free-tier: 1` to your request header. Without it, a request with no license key and no payment header returns `402 Payment Required` by default.

```bash
curl -X GET "https://pg1-ai-agent.vercel.app/api/ioc" \
  -H "x-free-tier: 1"
```

Optional query parameters: `?since=<ISO timestamp>`, `?type=<IPv4|domain|URL|FileHash-MD5|FileHash-SHA1|FileHash-SHA256>`, `?min_score=<0-100>`, `?limit=<1-1000>`

**Note on confidence scores:** indicator `confidence` currently defaults to a fixed value of 50 whenever the source record has no `confidence_score` — it is not yet a computed/weighted score for those records.

**Exception:** `get_ioc_context` and `get_ioc_batch` (the pre-action safety-check tools) are always free when the result is `found: false` — no `x-free-tier` header needed for those specific "nothing on record" responses. The header is only required for the general free tier.

## Paying for MCP Tool Calls (x402 v2)

`/api/mcp` follows the [x402 v2 MCP transport spec](https://github.com/coinbase/x402) for paid `tools/call` requests, so a payment can be attached either as an MCP-native field or as an HTTP header — whichever your client library supports:

1. **`params._meta["x402/payment"]`** (recommended for MCP clients, e.g. `@x402/mcp`) — attach the signed x402 v2 `PaymentPayload` object directly to the JSON-RPC request:

   ```jsonc
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "tools/call",
     "params": {
       "name": "get_cve_details",
       "arguments": { "cve_id": "CVE-2021-44228" },
       "_meta": { "x402/payment": { "x402Version": 2, "scheme": "exact", "network": "eip155:8453", "accepted": { /* … */ }, "payload": { /* … */ } } }
     }
   }
   ```

2. **`PAYMENT-SIGNATURE` header** (or `X-Payment`) — the same signed payload, base64-encoded, attached at the HTTP transport level instead of inside the JSON-RPC request. This is how non-MCP-aware HTTP clients pay.

If both are present on the same request, `_meta` wins.

**Unpaid calls don't get an HTTP 402.** A `tools/call` for a paid tool with no license key, no free tier, and no payment returns a normal `200 OK` JSON-RPC result shaped as an MCP tool error:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "isError": true,
    "structuredContent": { "x402Version": 2, "error": "Payment required", "resource": { /* … */ }, "accepts": [ /* … */ ] },
    "content": [{ "type": "text", "text": "{\"x402Version\":2,...}" }]
  }
}
```

The same object is also sent, base64-encoded, in the `PAYMENT-REQUIRED` response header for backward compatibility with clients that only read headers. A verification or settlement failure returns this exact same shape (still `200 OK`, `isError: true`), with `structuredContent.error` describing what went wrong.

On a successful payment, the tool result carries the facilitator's settlement receipt in `result._meta["x402/payment-response"]`, and the `PAYMENT-RESPONSE` header is set as before.

## Installation & Connection (MCP Clients)

To connect your autonomous agent to the PG1 API, pass your Gumroad license key in the connection request.

### Option 1: Via Smithery CLI

Run this command in your terminal, replacing the placeholder with your active key:

```bash
smithery mcp add --transport http --id pg1-threat-intel https://pg1-ai-agent.vercel.app/api/mcp --header "x-api-key: YOUR_GUMROAD_LICENSE_KEY"
```

### Option 2: Free-tier test via curl (no key needed)

```bash
curl -X POST https://pg1-ai-agent.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-free-tier: 1" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "get_cve_details",
      "arguments": { "cve_id": "CVE-2021-44228" }
    }
  }'
```

## All Available MCP Tools

Call `"method": "tools/list"` against `/api/mcp` for full schemas. Summary:

| Tool | Purpose | Source(s) | Free tier applies? |
|---|---|---|---|
| `get_threat_indicators` | Bulk STIX 2.1 indicator feed | ThreatFox, URLhaus, OTX, NVD | Yes (needs `x-free-tier: 1`) |
| `get_ioc_context` | Single-indicator safety check | ThreatFox, URLhaus, OTX | Always free if not found |
| `get_ioc_batch` | Up to 20 indicators per call | ThreatFox, URLhaus, OTX | Always free if none found |
| `get_cve_details` | CVE lookup enriched with NVD, EPSS, CISA KEV | NVD, FIRST.org EPSS, CISA KEV | Yes (needs `x-free-tier: 1`) |
| `get_cve_batch` | Up to 20 CVE IDs per call | NVD, FIRST.org EPSS, CISA KEV | Yes (needs `x-free-tier: 1`) |
| `get_cve_by_product` | Discover CVEs by vendor/product | NVD | Yes (needs `x-free-tier: 1`) |
| `get_threat_actor_profile` | APT/threat actor dossiers with MITRE ATT&CK | MITRE ATT&CK Enterprise | Yes (needs `x-free-tier: 1`) |
| `get_usage_status` | Check your remaining free-tier quota | — | Always free, no header needed |
| `subscribe_alerts` | Register a webhook for new matching indicators | — | No — license key required |
| `submit_indicator` | Contribute an observed indicator for review | — | No — license key required |
| `check_wallet_sanctions` | Screen a wallet address against sanctions | OFAC SDN List (US Treasury), synced daily | Always free |
| `check_domain_age` | Domain registration age via RDAP | RDAP (per-TLD server, resolved via the IANA bootstrap registry) | Always free |
| `check_hostname_reputation` | Screen a hostname for phishing/lookalike domains | MetaMask eth-phishing-detect, synced daily | Always free (60 calls/hour without a licence key) |
| `check_wallet_age` | When an EVM address first appeared on a chain, via on-chain transfer history | On-chain transfer history (per-chain) | Always free (60 calls/hour without a licence key) |

### Important wording caveats

- **`check_wallet_sanctions`**: a `listed: false` result means the address is not on the OFAC SDN list as of the reported `list_last_synced` time. It is **informational only, not legal or sanctions-compliance advice**, and is never phrased as "safe" or "clean". If the sanctions data is empty or unreachable, the tool returns an error instead of a false `listed: false`. **Address validation:** the tool queries `public.sanctioned_wallets` for the (normalised) address *first* — a match always returns `listed: true`, even if the address doesn't fit a currently-recognised format. Only when there is **no match** does the tool fall back to a format check: if `address` does not match a recognised format for any currency in the sanctions list (EVM `0x` + 40 hex; BTC/LTC/BCH/DOGE/DASH/ZEC base58 or bech32/CashAddr; TRON; Monero; Solana base58), it returns an MCP tool error (`isError: true`, `code: "invalid_address"`) instead of `listed: false` — this applies to malformed input like `"hello"` or a `0x` address of the wrong length. An empty `address` is always rejected as `invalid_address` before any lookup.
- **`check_domain_age`**: a newly registered domain (`age_days < 30`) is reported as **a common phishing signal, not proof of malicious intent**. On a successful lookup the tool returns `found: true` (and, for backward compatibility, `available: true` — **`available` is deprecated, prefer `found`**). When the lookup does not resolve it returns `found: false` / `available: false` with a `reason` and a `reason_code`: `"unsupported_tld"` when the TLD has no RDAP server in the IANA bootstrap registry, `"timeout"` when the RDAP lookup times out, `"invalid_domain"`/`"bootstrap_unavailable"`/`"lookup_failed"` for other failure modes. It never guesses an age and never falls back to WHOIS.
- **`get_ioc_context` / `get_ioc_batch`** (existing behavior): a `found: false` result means nothing bad is recorded in PG1's sources — it does **not** mean the indicator is safe, only that it isn't in this dataset.
- **`check_hostname_reputation`**: takes a single bare hostname (no bulk input, no URL/scheme/path/port/wildcards) and screens it — plus every parent domain — against `public.phishing_domains` (blocklist/allowlist/fuzzylist, synced daily by the sovereign-threat-pipeline repo) and `public.phishing_list_meta`. Returns `verdict: "allowlisted" | "listed" | "lookalike" | "not_listed"` — **never** `"safe"` or `"clean"`. An allowlist match always wins over a blocklist match. A `"listed"` verdict reports `match_type: "exact"` or `"parent_domain"`. A `"lookalike"` verdict means the hostname wasn't directly listed but resembles a known brand domain from the fuzzylist — either a confusable-character/typo skeleton within the stored tolerance (default 3), or a brand keyword (min. 5 chars) embedded alongside other words (e.g. `metamask-login.com`) — and sets `lookalike_of` to the matched brand domain; the brand's own real domain and its subdomains are never flagged. If the phishing list data is unreachable or times out, the tool returns an error rather than ever reporting `not_listed`. Malformed hostname input returns an MCP tool error (`isError: true`, `code: "invalid_hostname"`). List contents are never exposed beyond the single matched entry. It is free and, without a Gumroad license key, limited to 60 calls/hour per caller; a license key (`X-API-KEY`) bypasses this limit.
- **`check_wallet_age`**: reports when an EVM address (`0x` + 40 hex, case-insensitive) first appeared on a given chain (`base` by default, or `ethereum`/`arbitrum`/`optimism`/`polygon`/`bsc`), based on the earliest of its on-chain transfers in or out, plus whether it's a contract (`is_contract`). **Age is per chain**: `first_seen`/`age_days` describe this address's history on the requested `chain` only, so the same address can be old on one chain and brand-new (or `found: false`) on another — check each chain you care about. A `found: false` result (all other fields `null` except `is_contract`) means the address has no transfer history on that chain — a normal, common result, **not an error**, and **not evidence the address is safe or unsafe either way**; this tool reports age and history only. An upstream failure or timeout returns an MCP tool error (`isError: true`, `code: "upstream_unavailable"`) rather than ever falling back to `found: false`, since a data-source outage must never be read as "brand-new wallet". Malformed `address`/`chain` input returns an MCP tool error (`code: "invalid_address"` / `"invalid_chain"`). A found result is cached permanently; a `found: false` result is cached for 10 minutes only. It is free and, without a Gumroad license key, limited to 60 calls/hour per caller, same as `check_domain_age` / `check_hostname_reputation`.
  - **EIP-7702 delegation (`delegated`, `delegate_address`)**, added in 1.14.0 as optional fields: `delegated: true` when the address's code on the requested chain is exactly 23 bytes, `0xef0100` followed by a 20-byte delegate address (an [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) delegation), with that address, lowercased, in `delegate_address`. `delegated: false` (and `delegate_address: null`) when the code is anything else: empty, an ordinary contract, or something that only looks like the prefix at the wrong length. `delegated: null` means the code check did not complete (timeout or upstream error). It is never guessed as `false`; the age result is still returned, and `status` is `"unknown"` with a `checks` entry `source: "on-chain code (delegation)"`. Delegation is **never cached**: the owner can add or remove it at any time, so it is checked live on every call, cached age answers included, while `first_seen` stays cached as before. A delegated address gets reason code `WALLET_DELEGATED`, which states the fact only, not a judgement. `is_contract` has not changed and is still `true` for a delegated address, so existing integrations behave as before. Delegation is per chain too: a delegation on one chain says nothing about another.
- **`check_wallet_sanctions` / `check_domain_age` / `check_hostname_reputation` / `check_wallet_age`** all declare an `outputSchema` and return a matching `structuredContent` object alongside the existing `content` text block, per the MCP spec — clients that support structured tool output can read fields directly instead of parsing the text block.

## A2A (Agent2Agent Protocol)

`/api/a2a` exposes the five always-free tools (`check_wallet_sanctions`, `check_domain_age`, `check_hostname_reputation`, `check_wallet_age`, `get_usage_status`) over [A2A](https://a2a-protocol.org/latest/specification/), JSON-RPC 2.0. Paid tools are not available via A2A yet. The agent card is published at [`/.well-known/agent-card.json`](https://pg1-ai-agent.vercel.app/.well-known/agent-card.json). `message/send` (the v0.3 method name) is accepted as an alias of `SendMessage`. The `A2A-Version` header (or query param) selects the response shape — `1.0` or `0.3` (the default when omitted). Send the skill and its arguments as a `DataPart`:

```bash
curl -X POST https://pg1-ai-agent.vercel.app/api/a2a \
  -H "Content-Type: application/json" \
  -H "A2A-Version: 1.0" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "SendMessage",
    "params": {
      "message": {
        "role": "user",
        "messageId": "1",
        "parts": [{ "kind": "data", "data": { "skill": "check_domain_age", "arguments": { "domain": "example.com" } } }]
      }
    }
  }'
```

## Response Metadata (reasons, status, checks, request_id)

Every one of the 14 MCP tools and the 5 free A2A skills adds four fields alongside its existing output — additive only, nothing existing is renamed or repurposed:

- **`reasons`**: `[{ code, message }]`. Zero or more machine-readable codes from the permanent list below. Empty when nothing is flagged. Codes are only ever added, never removed or renamed.
- **`status`**: `"flagged"` when `reasons` is non-empty; `"unknown"` whenever any source needed for the answer timed out, errored, or was skipped (never reported as a false-clean `"no_flags"`); otherwise `"no_flags"`. (`subscribe_alerts` and `submit_indicator` keep their own pre-existing `status` field, which means a submission lifecycle state, not this honest-status value — they gain `reasons`/`checks`/`request_id` only.)
- **`checks`**: `[{ source, result, checked_at, data_as_of }]` — one entry per data source consulted for this call. `result` is one of `"ok" | "timeout" | "error" | "skipped"`. `source` is always a generic label (e.g. `"sanctions list"`, `"domain registration records"`, `"on-chain transfer history"`) — never a vendor/provider name.
- **`request_id`**: a UUID identifying this exact call, also sent as the `X-Request-Id` response header on `/api/mcp` and `/api/a2a`. It is inside the tool result (and `structuredContent`) or, for a JSON-RPC error, inside `error.data` — never at the top level of the JSON-RPC envelope, which holds only `jsonrpc`, `id` and `result`/`error`. If the call fails and gets written to the server error log, the same `request_id` is attached to that log entry.

`check_wallet_sanctions`, `check_domain_age`, `check_hostname_reputation` and `check_wallet_age` also declare these four as optional properties on their `outputSchema` (never added to `required`, and every other part of their schema is unchanged). They also declare an optional boolean `test_fixture`, which is present (and `true`) only on responses to the fixture inputs described in [Test your integration](#test-your-integration). `check_wallet_age` also declares two optional delegation properties, `delegated` (`boolean | null`) and `delegate_address` (`string | null`), which are not in `required` (see the `check_wallet_age` notes above).

### Reason codes

| Code | Meaning |
|---|---|
| `WALLET_SANCTIONED` | Address matches an entry on the sanctions list. |
| `DOMAIN_NEWLY_REGISTERED_30D` | Domain was registered fewer than 30 days ago. |
| `HOSTNAME_PHISHING_LISTED` | Hostname, or a parent domain of it, is on the phishing blocklist. |
| `HOSTNAME_LOOKALIKE` | Hostname is a probable lookalike/typosquat of a known brand domain. |
| `WALLET_NO_HISTORY` | No on-chain transfer history was found for this address on this chain. |
| `WALLET_AGE_PARTIAL` | Internal transfers were not checked in time; the wallet may be older than shown. |
| `CVE_KNOWN_EXPLOITED_KEV` | CVE is on the known exploited vulnerabilities catalog. |
| `IOC_FOUND_IN_THREAT_FEED` | Indicator has at least one matching record in the threat indicator feed. |
| `WALLET_DELEGATED` | Address currently has an EIP-7702 delegation on this chain: its code points to a delegate contract. |

Source of truth: `lib/reasonCodes.mjs`.

**Not yet covered:** the `/api/ioc` REST feed and `/api/ioc/context` don't carry `reasons`/`status`/`checks`/`request_id` yet.

## Test your integration

Every MCP tool that can flag something has three fixed, made-up fixture inputs that always return the same answer: one **FLAGGED**, one **CLEAN** and one **UNKNOWN**. `check_wallet_age` also has a fourth, **DELEGATED**. Use them to test your integration's happy path, its "flagged" path and its skip/retry path without spending anything or depending on live data.

- **Always free**, for every caller: no licence key, no `x-free-tier` header, no x402 payment, no rate-limit usage. This applies to the paid tools too.
- **Same shape as a real response**: `reasons`, `status`, `checks` and `request_id`, plus `test_fixture: true`. Every `checks[]` entry has `source: "fixture"`. On an error-shaped UNKNOWN, `test_fixture: true` is in `error.data` (JSON-RPC errors) or next to `code` (isError tool results).
- **UNKNOWN is exactly what a real upstream failure returns for that tool**, so you can test your skip path. For `check_wallet_age` that is the `upstream_unavailable` isError result, never `found: false`.
- **For `check_domain_age`, always check `status` before `found`: `found: false` with `status: "unknown"` means the lookup did not complete, not that the domain is new.**
- **Exact values only.** The only normalisation is what the tool already does itself: lowercasing a `0x` address or hostname, uppercasing a CVE id, reducing a domain/URL to its registrable domain. Anything else is treated as a real input, even one character off, so `www.pg1-test-flagged.invalid` is a real hostname lookup.
- **Every value is reserved or synthetic**, so none can belong to a real target: `.invalid` domains (RFC 2606/6761), documentation IP ranges (RFC 5737 `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`; RFC 3849 `2001:db8::/32`), `CVE-0000-*` ids (the CVE programme started in 1999) and `0x` addresses that spell `pg1-test-fixture` in hex. The reasoning for each is in [`lib/fixtures.mjs`](lib/fixtures.mjs), which is also the single source for this table and the tests.
- `check_wallet_age` has no age threshold. Its FLAGGED fixture is a wallet with no history (`found: false`, `WALLET_NO_HISTORY`) and its CLEAN fixture is an old wallet with a fixed `first_seen`. Its DELEGATED fixture is an old wallet with an EIP-7702 delegation: `delegated: true`, a synthetic `delegate_address` (also spelling `pg1-test-fixture` in hex) and reason `WALLET_DELEGATED`. The other fixtures report `delegated: false`. `chain` is optional and is echoed back; an unsupported chain is still an `invalid_chain` error.

| Tool | Fixture | Arguments | Expected result |
|---|---|---|---|
| `check_wallet_sanctions` | FLAGGED | `{"address":"0x7067312d746573742d6669787475726500000001"}` | listed: true, status "flagged", reason WALLET_SANCTIONED |
| `check_wallet_sanctions` | CLEAN | `{"address":"0x7067312d746573742d6669787475726500000002"}` | listed: false, status "no_flags" |
| `check_wallet_sanctions` | UNKNOWN | `{"address":"0x7067312d746573742d6669787475726500000003"}` | HTTP 503, JSON-RPC error -32003 "Sanctions data temporarily unavailable, please retry." |
| `check_domain_age` | FLAGGED | `{"domain":"pg1-test-flagged.invalid"}` | found: true, age_days 3, newly_registered: true, status "flagged", reason DOMAIN_NEWLY_REGISTERED_30D |
| `check_domain_age` | CLEAN | `{"domain":"pg1-test-clean.invalid"}` | found: true, registration_date 2000-01-01, status "no_flags" |
| `check_domain_age` | UNKNOWN | `{"domain":"pg1-test-unknown.invalid"}` | found: false, reason_code "timeout", status "unknown" (what a real RDAP timeout returns) |
| `check_hostname_reputation` | FLAGGED | `{"hostname":"pg1-test-flagged.invalid"}` | verdict "listed" (match_type "exact"), status "flagged", reason HOSTNAME_PHISHING_LISTED |
| `check_hostname_reputation` | CLEAN | `{"hostname":"pg1-test-clean.invalid"}` | verdict "not_listed", status "no_flags" |
| `check_hostname_reputation` | UNKNOWN | `{"hostname":"pg1-test-unknown.invalid"}` | HTTP 503, JSON-RPC error -32003 "Phishing domain list temporarily unavailable, please retry." |
| `check_wallet_age` | FLAGGED | `{"address":"0x7067312d746573742d6669787475726500000001"}` | found: false (no transfer history), status "flagged", reason WALLET_NO_HISTORY |
| `check_wallet_age` | CLEAN | `{"address":"0x7067312d746573742d6669787475726500000002"}` | found: true, first_seen 2023-09-01T00:00:00.000Z, status "no_flags" |
| `check_wallet_age` | UNKNOWN | `{"address":"0x7067312d746573742d6669787475726500000003"}` | isError: true, code "upstream_unavailable", status "unknown" (never found: false) |
| `check_wallet_age` | DELEGATED | `{"address":"0x7067312d746573742d6669787475726500000004"}` | found: true, is_contract: true, delegated: true, delegate_address 0x7067312d746573742d66697874757265de1e9a7e, status "flagged", reason WALLET_DELEGATED |
| `get_ioc_context` | FLAGGED | `{"value":"192.0.2.1"}` | found: true, status "flagged", reason IOC_FOUND_IN_THREAT_FEED (free, no payment) |
| `get_ioc_context` | CLEAN | `{"value":"198.51.100.1"}` | found: false, status "no_flags" |
| `get_ioc_context` | UNKNOWN | `{"value":"203.0.113.1"}` | HTTP 503, JSON-RPC error -32603 "Threat data temporarily unavailable, please retry." |
| `get_ioc_batch` | FLAGGED | `{"values":["2001:db8::1"]}` | total_found 1, status "flagged", reason IOC_FOUND_IN_THREAT_FEED (free, no payment) |
| `get_ioc_batch` | CLEAN | `{"values":["2001:db8::2"]}` | total_found 0, status "no_flags" |
| `get_ioc_batch` | UNKNOWN | `{"values":["2001:db8::3"]}` | HTTP 503, JSON-RPC error -32003 "Threat data temporarily unavailable, please retry." |
| `get_cve_details` | FLAGGED | `{"cve_id":"CVE-0000-0001"}` | cisa_kev.is_known_exploited: true, status "flagged", reason CVE_KNOWN_EXPLOITED_KEV (free, no payment) |
| `get_cve_details` | CLEAN | `{"cve_id":"CVE-0000-0002"}` | cisa_kev.is_known_exploited: false, status "no_flags" |
| `get_cve_details` | UNKNOWN | `{"cve_id":"CVE-0000-0003"}` | exploit-score and KEV checks "error", epss null, status "unknown" |
| `get_cve_batch` | FLAGGED | `{"cve_ids":["CVE-0000-0001"]}` | one KEV-listed result, status "flagged", reason CVE_KNOWN_EXPLOITED_KEV (free, no payment) |
| `get_cve_batch` | CLEAN | `{"cve_ids":["CVE-0000-0002"]}` | one non-KEV result, status "no_flags" |
| `get_cve_batch` | UNKNOWN | `{"cve_ids":["CVE-0000-0003"]}` | exploit-score and KEV checks "error", status "unknown" |
| `get_cve_by_product` | FLAGGED | `{"vendor":"pg1-test.invalid","product":"flagged"}` | one KEV-listed CVE, status "flagged", reason CVE_KNOWN_EXPLOITED_KEV (free, no payment) |
| `get_cve_by_product` | CLEAN | `{"vendor":"pg1-test.invalid","product":"clean"}` | total_found 0, status "no_flags" |
| `get_cve_by_product` | UNKNOWN | `{"vendor":"pg1-test.invalid","product":"unknown"}` | exploit-score and KEV checks "error", status "unknown" |

No fixtures exist for `get_threat_indicators` (a bulk feed with no target input), `get_threat_actor_profile` and `get_usage_status` (they have no reason code to flag with), or `subscribe_alerts` and `submit_indicator` (write actions whose `status` is a lifecycle state, not a verdict).

**A2A:** the four fixture-bearing free skills (`check_wallet_sanctions`, `check_domain_age`, `check_hostname_reputation`, `check_wallet_age`) accept the same fixtures on `/api/a2a`. A result comes back as a completed Task. An isError-style UNKNOWN comes back as JSON-RPC error `-32000` with the details in `error.data`. A 503-style UNKNOWN comes back as HTTP 503 with JSON-RPC error `-32010`. These are the same shapes a real failure produces on that endpoint.

**Out of scope:** the REST endpoints (`/api/ioc` and `/api/ioc/context`) have no fixtures. Fixture values sent there are looked up like any other value.

FLAGGED, over MCP, with no key:

```bash
curl -X POST https://pg1-ai-agent.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_hostname_reputation","arguments":{"hostname":"pg1-test-flagged.invalid"}}}'
```

UNKNOWN, over MCP, to test your skip path (an `upstream_unavailable` isError result):

```bash
curl -X POST https://pg1-ai-agent.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_wallet_age","arguments":{"address":"0x7067312d746573742d6669787475726500000003"}}}'
```

A paid tool's FLAGGED fixture, still free with no key:

```bash
curl -X POST https://pg1-ai-agent.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_cve_details","arguments":{"cve_id":"CVE-0000-0001"}}}'
```

### Invalid-input messages

Invalid input keeps its existing error code (JSON-RPC `-32602` for most tools, `-32004` for a malformed `get_cve_details` id, or the tool's own `invalid_address` / `invalid_hostname` / `invalid_chain` isError code). The message says what was wrong, what format is expected, gives one valid example, and ends with the `request_id`. Your raw input is never echoed back. For example:

```
address is not a valid EVM address. Expected: '0x' followed by exactly 40 hex characters (case-insensitive). Example: 0x7067312d746573742d6669787475726500000002. request_id: 9cf7345b-f8d6-46f7-8e45-0da5e25a002d
```

## Acknowledgements

- **Frits** ([x402 Doctor](https://x402-doctor.onrender.com/)): found the payment-gate ordering bug and confirmed the fix, so PG1 now returns a proper x402 payment challenge by default.
- **`check_hostname_reputation`** blocklist/allowlist/fuzzylist data is sourced from [MetaMask eth-phishing-detect](https://github.com/MetaMask/eth-phishing-detect), used under the [Don't Be A Dick (DBAD) Public License](https://github.com/MetaMask/eth-phishing-detect/blob/main/LICENSE).