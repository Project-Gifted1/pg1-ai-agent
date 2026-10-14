# PG1 lab and promotion pipeline

The lab is where PG1 tries things: research, skill drafts with evals, and code
changes. It runs only on GitHub Actions (`.github/workflows/lab.yml`), never on
the production server, with keys that are scoped to the lab.

## What the lab can and cannot touch

| | Lab | Production |
|---|---|---|
| Model keys | `PG1_LAB_ANTHROPIC_API_KEY`, `PG1_LAB_GEMINI_API_KEY` (set a low spend limit at each provider) | the deployment's own keys |
| Data | none: mocks and the repository's fixtures | Supabase (service role) |
| Payments / wallet | none | x402, CDP |
| GitHub | `PG1_LAB_GITHUB_TOKEN`: push a `lab/<id>` branch and open a **draft** PR | `GITHUB_TOKEN` dispatches the workflow and reads its result |
| Network | GET public https pages through `lib/netGuard.mjs` (no private addresses, no redirects); POST only to the model APIs | — |
| Limits | `PG1_LAB_BUDGET_USD` (default 2) per experiment, `PG1_LAB_DAILY_USD` (default 5) per UTC day, 15 minutes per experiment, 20 per job | — |

The workflow has three jobs on three fresh runners:

1. **experiment** has the model keys only. It writes the result, plus the proposed files for a code experiment.
2. **test** runs for code experiments only. It applies the files and runs `npm test` with **no secrets** and the network blocked.
3. **pull** runs for code experiments only, and only when job 2 passed. A fresh checkout commits exactly the proposed files and opens a **draft** pull request. PG1 never merges it.

## Secrets and settings to create

In GitHub, under *Settings → Environments → New environment*, create an environment named `lab`. Add these environment secrets to it:

| Secret | What |
|---|---|
| `PG1_LAB_DISPATCH_SECRET` | 32+ random characters. Set the **same value** in Vercel as `PG1_LAB_DISPATCH_SECRET`. |
| `PG1_LAB_ANTHROPIC_API_KEY` and/or `PG1_LAB_GEMINI_API_KEY` | Separate keys for the lab, each with a provider-side spend cap. |
| `PG1_LAB_GITHUB_TOKEN` | The fine-grained token below. |

In Vercel, set `PG1_LAB_DISPATCH_SECRET`, and optionally `PG1_LAB_BUDGET_USD` and `PG1_LAB_DAILY_USD`. The existing `GITHUB_TOKEN` (Actions: read and write) dispatches the workflow and reads its results. To keep these lab permissions on their own token, set `PG1_LAB_DISPATCH_GITHUB_TOKEN` instead.

### Minimal fine-grained token for self-PRs (`PG1_LAB_GITHUB_TOKEN`)

Create it under *GitHub → Settings → Developer settings → Fine-grained tokens*:

- **Resource owner:** `Project-Gifted1`
- **Repository access:** *Only select repositories* → `pg1-ai-agent`
- **Repository permissions:**
  - **Contents: Read and write**, to push the `lab/<id>` branch
  - **Pull requests: Read and write**, to open the draft PR
  - **Metadata: Read-only** (GitHub adds this automatically)
  - everything else: **No access**. That includes no Administration, no Actions, no Workflows, no Secrets and no Environments.
- **Organization permissions:** none
- **Expiration:** 90 days or less. Rotate it before it expires.

This token cannot change branch protection, cannot edit workflows (the Workflows permission is off, so a push that touches `.github/workflows` is refused), and cannot reach any other repository.

### Branch protection to enable on `main`

None of this is assumed to exist today. Under *Settings → Branches → Add branch ruleset* (or *Add rule*) for `main`:

- **Require a pull request before merging**, with at least 1 approval.
- **Dismiss stale approvals** when new commits are pushed.
- **Require status checks to pass**, with the branch up to date. Required checks:
  - `npm test`
  - `browser tests`
- **Block force pushes** and **restrict deletions**.
- **Do not allow bypassing the above settings**: no bypass list, and admins are included.
- **Restrict who can push to matching branches**: only you (the lab token can then push `lab/*` branches but never `main`).

With this in place, a lab pull request reaches `main` only through your review and green CI.

## Commands

| Command | What it does |
|---|---|
| `/lab start <goal> [--kind research\|skill\|code] [--skill <name>] [--url <https url>]` | Checks the budgets, records the experiment, and dispatches the workflow with a signed token. |
| `/lab status` | Lists the latest experiments. A finished one is read back: its spend goes on the usage ledger (task `lab`), skill drafts are stored with status `lab`, and the gate runs. |
| `/lab stop <id>` | Cancels the run. |
| `/lab report <id>` | Shows the findings and the gate's evidence. |
| `/promote` | Lists the feature flags. |
| `/promote <flag>` | Moves a flag from operator-only to public. |

## The promotion gate

A candidate reaches your approval card only after passing all four checks. The card shows the evidence for each:

1. **Evals or CI:** for a skill, every lab eval passed; for code, CI is green on the draft PR's head.
2. **Safety:** no secrets, no override or injection phrasing, no code in skills, `allowed_tools` within the allowlist, and changed files only in allowed paths.
3. **Licence:** every new data source cites its resale terms (a licence and an https terms URL).
4. **Cost:** when the candidate is priced, the price is at least 1.5 × the worst-case cost.

Approving turns the candidate on **for the operator only**: a skill becomes active, and a code change is marked approved for you to merge. A feature flag is created at stage `operator`. `/promote <flag>` makes it public.

Every hour, `/api/flags/monitor` checks each live flag over the last hour. If its error rate is over its threshold (default 25%, from 5 calls), or its cost per call is over its threshold, the monitor switches the flag off and adds an alert to your error log.
