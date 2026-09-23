
# PG1 Sovereign Threat Intelligence API

Cryptographically-gated threat telemetry and IOC feeds for enterprise and autonomous nodes.

**License Key Access:** [https://gikewun.gumroad.com/l/pg1-threat-intel-api](https://gikewun.gumroad.com/l/pg1-threat-intel-api)

## Two Ways to Connect

- **`/api/ioc`** — simple REST GET, returns the STIX 2.1 indicator feed directly. Best for scripts, curl, and simple integrations.
- **`/api/mcp`** — full Model Context Protocol server, 9 tools (CVE lookups, batch operations, threat actor dossiers, and more). Best for Claude, MCP-compatible agents, and any client speaking the MCP standard.

Both accept the same Gumroad license key via the `x-api-key` header, or per-call x402 micropayments ($0.01/call) via the `X-PAYMENT` header. A free tier (5 calls/day, no key required) is also available on both.

## Quick Test (REST)

```bash
curl -X GET "https://pg1-ai-agent.vercel.app/api/ioc" \
  -H "x-api-key: YOUR_GUMROAD_LICENSE_KEY"
```

Optional query parameters: `?since=<ISO timestamp>`, `?type=<IPv4|domain|URL|hash>`, `?min_score=<0-100>`, `?limit=<1-1000>`

## Installation & Connection (MCP Clients)

To connect your autonomous agent to the PG1 API, pass your Gumroad license key in the connection request.

### Option 1: Via Smithery CLI

Run this command in your terminal, replacing the placeholder with your active key:

```bash
smithery mcp add --transport http --id pg1-threat-intel https://pg1-ai-agent.vercel.app/api/mcp --header "x-api-key: YOUR_GUMROAD_LICENSE_KEY"
```

## All Available MCP Tools

Call `"method": "tools/list"` against `/api/mcp` for full schemas. Summary:

| Tool | Purpose |
|---|---|
| `get_threat_indicators` | Bulk STIX 2.1 indicator feed |
| `get_ioc_context` | Single-indicator lookup |
| `get_ioc_batch` | Up to 20 indicators per call |
| `get_cve_details` | CVE lookup enriched with NVD, EPSS, CISA KEV |
| `get_cve_batch` | Up to 20 CVE IDs per call |
| `get_cve_by_product` | Discover CVEs by vendor/product |
| `get_threat_actor_profile` | APT/threat actor dossiers with MITRE ATT&CK |
| `subscribe_alerts` | Register a webhook for new matching indicators (license key required) |
| `submit_indicator` | Contribute an observed indicator for review (license key required) |
```