# hosting_advisor

Ranked hosting regions and providers for a workload, available as an MCP tool, an A2A skill, and REST at `POST /api/hosting-advisor`. It is paid like the CVE tools: the shared free tier first, then $0.01 per call via x402. Results are signed.

**Input.** The input is structured fields only, so there is no free text to interpret:
- `workload_type`
- `latency_regions`
- `data_residency` (`any`, `eu`, `eea`, `eu_adequate` or ISO codes)
- `privacy_priority`
- `uptime_target`
- `budget_usd_month`
- `requirements` (`customer_managed_keys`, `no_us_parent`, `dedicated_hardware`, `multi_provider`)

**Output.** Up to five (jurisdiction, provider) pairs. Each pair has cited reasons:
- the data-protection regime;
- EU transfer status;
- the published government data-access frameworks (named statutes with official links: factual, not an assessment);
- the provider's jurisdiction (the CLOUD Act exposure of a US-parented provider);
- acceptable-use fit (the provider's AUP to check for the workload);
- sanctions and export controls;
- estimated latency;
- the published SLA against the target.

The output also includes a redundancy and resilience plan, privacy-by-design guidance, `data_quality` (counts of stale and unverified facts) and the disclaimer "Not legal advice".

**Lawful only.** Some requests get a short neutral refusal with the lawful alternative:
- the requirement labels `ignore_abuse_reports` (bulletproof hosting), `evade_lawful_process` and `sanctions_bypass`;
- residency in an embargoed destination (Cuba, Iran, North Korea, and the occupied regions of Ukraine).

Russia and Belarus are never ranked: they are under EU sectoral sanctions, including on IT and cloud services, and the operator is EU-based.

**Data.**
- PG1's own curated dataset (`lib/hosting/dataset.mjs`), seeded into `pg1_jurisdictions` and `pg1_providers`.
- Every fact is `{ value, source_url, checked_on, verified }`, from official and public sources.
- Facts older than 180 days are flagged stale.
- The seed facts are **unverified** until the operator checks them (`/hosting confirm <key> <field>`).
- Updates are researched in the lab (`/hosting research <topic>`) and written only after the operator reviews and confirms them (`/hosting apply <experiment> confirm`).
- Without the tables, the bundled seed answers.
