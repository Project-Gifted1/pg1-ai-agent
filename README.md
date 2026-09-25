# PG1 Sovereign Threat Intelligence API

Cryptographically-gated threat telemetry and IOC feeds for enterprise and autonomous nodes.

**License Key Access:** [https://gikewun.gumroad.com/l/pg1-threat-intel-api](https://gikewun.gumroad.com/l/pg1-threat-intel-api)

## Two Ways to Connect

- **`/api/ioc`** — simple REST GET, returns the STIX 2.1 indicator feed directly. Best for scripts, curl, and simple integrations.
- **`/api/mcp`** — full Model Context Protocol server, 9 tools (CVE lookups, batch operations, threat actor dossiers, and more). Best for Claude, MCP-compatible agents, and any client speaking the MCP standard.

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

| Tool | Purpose | Free tier applies? |
|---|---|---|
| `get_threat_indicators` | Bulk STIX 2.1 indicator feed | Yes (needs `x-free-tier: 1`) |
| `get_ioc_context` | Single-indicator safety check | Always free if not found |
| `get_ioc_batch` | Up to 20 indicators per call | Always free if none found |
| `get_cve_details` | CVE lookup enriched with NVD, EPSS, CISA KEV | Yes (needs `x-free-tier: 1`) |
| `get_cve_batch` | Up to 20 CVE IDs per call | Yes (needs `x-free-tier: 1`) |
| `get_cve_by_product` | Discover CVEs by vendor/product | Yes (needs `x-free-tier: 1`) |
| `get_threat_actor_profile` | APT/threat actor dossiers with MITRE ATT&CK | Yes (needs `x-free-tier: 1`) |
| `get_usage_status` | Check your remaining free-tier quota | Always free, no header needed |
| `subscribe_alerts` | Register a webhook for new matching indicators | No — license key required |
| `submit_indicator` | Contribute an observed indicator for review | No — license key required | 

## Acknowledgements

- **Frits** ([x402 Doctor](https://x402-doctor.onrender.com/)): found the payment-gate ordering bug and confirmed the fix, so PG1 now returns a proper x402 payment challenge by default.