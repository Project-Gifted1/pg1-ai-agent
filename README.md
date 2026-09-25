# PG1 Sovereign Threat Intelligence API

Cryptographically-gated threat telemetry and IOC feeds for enterprise and autonomous nodes.

**License keys:** new sales are temporarily paused while data licensing is finalised. The free tier and x402 remain available.

## Two Ways to Connect

- **`/api/ioc`** — simple REST GET, returns the STIX 2.1 indicator feed directly. Best for scripts, curl, and simple integrations.
- **`/api/mcp`** — full Model Context Protocol server, 12 tools (CVE lookups, batch operations, threat actor dossiers, wallet sanctions screening, domain age, and more). Best for Claude, MCP-compatible agents, and any client speaking the MCP standard.

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

### Important wording caveats

- **`check_wallet_sanctions`**: a `listed: false` result means the address is not on the OFAC SDN list as of the reported `list_last_synced` time. It is **informational only, not legal or sanctions-compliance advice**, and is never phrased as "safe" or "clean". If the sanctions data is empty or unreachable, the tool returns an error instead of a false `listed: false`. **Address validation:** the tool queries `public.sanctioned_wallets` for the (normalised) address *first* — a match always returns `listed: true`, even if the address doesn't fit a currently-recognised format. Only when there is **no match** does the tool fall back to a format check: if `address` does not match a recognised format for any currency in the sanctions list (EVM `0x` + 40 hex; BTC/LTC/BCH/DOGE/DASH/ZEC base58 or bech32/CashAddr; TRON; Monero; Solana base58), it returns an MCP tool error (`isError: true`, `code: "invalid_address"`) instead of `listed: false` — this applies to malformed input like `"hello"` or a `0x` address of the wrong length. An empty `address` is always rejected as `invalid_address` before any lookup.
- **`check_domain_age`**: a newly registered domain (`age_days < 30`) is reported as **a common phishing signal, not proof of malicious intent**. On a successful lookup the tool returns `found: true` (and, for backward compatibility, `available: true` — **`available` is deprecated, prefer `found`**). When the lookup does not resolve it returns `found: false` / `available: false` with a `reason` and a `reason_code`: `"unsupported_tld"` when the TLD has no RDAP server in the IANA bootstrap registry, `"timeout"` when the RDAP lookup times out, `"invalid_domain"`/`"bootstrap_unavailable"`/`"lookup_failed"` for other failure modes. It never guesses an age and never falls back to WHOIS.
- **`get_ioc_context` / `get_ioc_batch`** (existing behavior): a `found: false` result means nothing bad is recorded in PG1's sources — it does **not** mean the indicator is safe, only that it isn't in this dataset.
- **`check_wallet_sanctions` / `check_domain_age`** both declare an `outputSchema` and return a matching `structuredContent` object alongside the existing `content` text block, per the MCP spec — clients that support structured tool output can read fields directly instead of parsing the text block.

## Acknowledgements

- **Frits** ([x402 Doctor](https://x402-doctor.onrender.com/)): found the payment-gate ordering bug and confirmed the fix, so PG1 now returns a proper x402 payment challenge by default.