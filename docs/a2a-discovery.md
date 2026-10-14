# Where other agents can find PG1's A2A jobs

This is a report only. **PG1 has not registered anywhere.** Listing is the operator's decision (`directory:register` is APPROVAL in `lib/autonomy.mjs`).

## What is already discoverable

- **`/.well-known/agent-card.json`** is the A2A standard way to be found. Any A2A client that knows the domain reads it. It now lists:
  - `submit_job`;
  - one `job.<type>` entry per job, each with its `inputSchema` and `pricing`;
  - the a2a-x402 extension.
- **The x402 discovery extension (Bazaar).** The paid MCP and IOC routes already declare it. Agents that browse the facilitator's catalogue see PG1's paid resources there. Job quotes are dynamic, so they are not listed per job.
- **The MCP registry** (`server.json`, published by `.github/workflows/publish-mcp.yml`) covers the MCP tools, not the A2A jobs.

## Directories to consider (verify each before listing; not checked from here)

| Directory | What it is | How you would list PG1 | Notes |
|---|---|---|---|
| A2A protocol samples / community lists (GitHub "awesome-a2a" style lists) | Curated lists of A2A agents | A pull request adding the agent-card URL and a one-line description | Free; check each list's rules |
| Google Cloud Agent Garden / Agentspace marketplace | Google's catalogue of agents, A2A-compatible | Partner or marketplace submission with the agent card | Commercial terms and review apply |
| Fetch.ai Agentverse | An agent registry with A2A adapters | Register an agent that points at `/api/a2a` | Has its own identity and payment model; check fit with x402 |
| Coinbase x402 Bazaar | Discovery for x402-paid resources | Already reached through the discovery extension; jobs could add a static "quote" resource | Only for x402 resources |
| Agent-directory sites that crawl `/.well-known/agent-card.json` | Index agents by crawling their cards | Usually nothing: they find the card by crawling | The card must stay accurate (tested in `tests/a2a-jobs.test.mjs`) |

## Suggested listing text

> PG1: threat-intelligence checks for agents. Paid A2A jobs over x402:
> - batch wallet screens (sanctions and age, up to 500 wallets);
> - CVE exposure reports (PDF and JSON);
> - hostname and package batch checks (up to 200);
> - threat write-up PDFs.
>
> Each job is quoted before you pay and settled only when it is accepted to run. Card: https://pg1-ai-agent.vercel.app/.well-known/agent-card.json
