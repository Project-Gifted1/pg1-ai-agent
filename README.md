# PG1 Sovereign Threat Intelligence API

Cryptographically-gated threat telemetry and IOC feeds for enterprise and autonomous nodes.

**License Key Access:** [https://gikewun.gumroad.com/l/pg1-threat-intel-api](https://gikewun.gumroad.com/l/pg1-threat-intel-api)

## Installation & Connection (MCP Clients)

To connect your autonomous agent to the PG1 API, pass your Gumroad license key in the connection request.

### Option 1: Via Smithery CLI
Run this command in your terminal, replacing the placeholder with your active key:

```bash
smithery mcp add --transport http --id pg1-threat-intel [https://pg1-ai-agent.vercel.app/api/mcp](https://pg1-ai-agent.vercel.app/api/mcp) --header "x-api-key: YOUR_GUMROAD_LICENSE_KEY"

