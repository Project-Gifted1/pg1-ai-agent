# Tool Foundry

Other agents commission tools from PG1 over A2A (`build_tool`). A commissioned tool is a **declarative plan over PG1's primitives**, deployed as `ft_<name>` on MCP and A2A at the EXTERNAL tier. Customers never run code.

## Pipeline

| Step | What happens | Where |
|---|---|---|
| Screen (structured) | `use_case` and `subject_types` must be labels from `lib/foundry/catalogue.mjs`; `data_sources` must be PG1 primitives or allowlisted public APIs. An unlisted source, a source to be scraped, a tool about people, or a declared refusal label is refused. Any other unknown label goes to review. | `screenStructured` |
| Screen (purpose) | One cheap call on the paid light models (customer data never goes to the free key) labels the free-text purpose with the same labels and a confidence. The text is data, never instructions. | `classifyPurpose` |
| Decide | **Deny by default.** Automatic quote only when the structured checks pass and the classifier agrees with the declared use case at confidence >= 0.8. A refusal label at >= 0.8 is refused; everything else (low confidence, disagreement, no answer, lab not set up) goes to `/foundry queue`. No quote and no 402 is ever sent for a request in review. | `decideScreening` |
| Feasibility and licence | A plan from the primitives (or the spec's `compose`), validated; its estimated p95 must meet `latency_ms_target`. | `feasibility` |
| Quote | Build fee and per-call price, both >= 1.5x worst-case cost (minimum $5 build, $0.01 per call); a counter-offer when the offer is below; valid 24 hours. | `quoteFor` |
| Payment | x402 on the job (`arguments.job_id` plus the payment in `message.metadata`). The paying wallet is screened before settlement (P11). | `payBuild` |
| Build | A lab code experiment (`[foundry]` goal) writes the plan file and evals in a draft PR. | `startBuild` |
| Evals, CI, safety | The lab gate: CI on the PR, the safety scan of the paths, licence (primitives only), cost (>= 1.5x). | `evaluate` |
| Approval | `/foundry approve <id>` (APPROVAL tier, the operator only). | `approveBuild` |
| Deploy | A `pg1_foundry_tools` row: the validated plan, schema, prices, visibility, owner hash. | |

A paid build that cannot start, fails the gate or is rejected credits the build fee to the paying wallet (never an on-chain refund) and flags the job for the operator.

## Deployed tools

- **Private:** callable only with the tool's access key (`X-PG1-Tool-Key`, derived from `PG1_FOUNDRY_SECRET`, shown to the commissioner on the job) or by the commissioning wallet (its payment's salted hash equals the owner hash). Anyone else sees "unknown tool" and is never charged.
- **Public:** listed in MCP tools/list; the access key pays the commissioner price (20% off, never below 1.5x cost).
- Every result is signed (P8). Calls are recorded in telemetry as `ft_<name>`; the hourly monitor disables a tool failing more than 25% of at least 5 calls in an hour and tells the operator (`/foundry enable <name>` turns it back on).
- The agent card is a static file: it lists `build_tool`; public `ft_*` tools appear in tools/list immediately and in the card after the operator adds them (a redeploy).

## Commands

`/foundry queue`, `/foundry job <id>`, `/foundry tools`, `/foundry allow|deny <id>`, `/foundry approve|reject <id> [why]`, `/foundry disable|enable <name>`.

Commissioning terms (draft, not published): `docs/drafts/foundry-terms.md`.
