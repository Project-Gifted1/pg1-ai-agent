# PG1 lab and promotion pipeline

The lab is where PG1 tries things: research, skill drafts with evals, and code
changes. It runs only on GitHub Actions (`.github/workflows/lab.yml`), never on
the production server, with keys that are scoped to the lab.

## What the lab can and cannot touch

| | Lab | Production |
|---|---|---|
| Model keys | `PG1_LAB_ANTHROPIC_API_KEY`, `PG1_LAB_GEMINI_API_KEY` (set a low spend limit at each provider); when unset, the repository's `ANTHROPIC_API_KEY` / `GEMINI_API_KEY_PAID` | the deployment's own keys |
| Data | none: mocks and the repository's fixtures | Supabase (service role) |
| Payments / wallet | none | x402, CDP |
| GitHub | `PG1_LAB_GITHUB_TOKEN` (or, when unset, the pull job's built-in token): push a `lab/<id>` branch and open a **draft** PR | `GITHUB_TOKEN` dispatches the workflow and reads its result |
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

`PG1_LAB_DISPATCH_SECRET` is always required, in GitHub and in Vercel. The others are optional:

- **Model keys.** With no `PG1_LAB_*` model key, the experiment job uses the repository secrets `ANTHROPIC_API_KEY` and `GEMINI_API_KEY_PAID` (the ones `claude.yml` and the render workflows already use). The signed per-experiment budget and `PG1_LAB_DAILY_USD` still cap spend, but those keys have no lab-only cap at the provider, so a separate lab key is still the safer choice.
- **Free engines.** At the $0 default the experiment job runs on the free engines only, falling back from one to the next when one is resting or busy: `GEMINI_API_KEY_FREE` (else `GEMINI_API_KEY2`, where the free key is saved today), `GROQ_API_KEY`, `MISTRAL_API_KEY`, `PG1_MODELS_TOKEN` (GitHub Models) and `CLOUDFLARE_AI_TOKEN` with `CLOUDFLARE_ACCOUNT_ID`, each read from the `lab` environment or the repository under exactly that name. A free key saved under any other name is not seen. The more of them are set, the less a run stalls on one engine's per-minute limit.
- **GitHub token.** With no `PG1_LAB_GITHUB_TOKEN`, the pull job uses the built-in `GITHUB_TOKEN` with `contents: write` and `pull-requests: write` (that job only; the workflow default stays `contents: read`). Turn on *Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests*, or the PR call is refused. **Limitation:** GitHub never starts workflows for pushes and PRs made with the built-in token, so the Tests workflow does not run on the draft PR. The promotion gate requires an `npm test` check on the PR head and treats its absence as `CI none`, a failure, so nothing reaches the approval card untested. To start CI, close and reopen the draft PR (or push a commit to `lab/<id>`) yourself; the next `/lab status` re-reads the checks. A fine-grained `PG1_LAB_GITHUB_TOKEN` avoids that step: its PRs trigger Tests normally.

The Supabase service-role key, the wallet and the payment secrets (`SUPABASE_*`, `CDP_*`, `X402_*`) are never given to the lab, whether or not the `PG1_LAB_*` secrets are set.

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
| `/lab report [id]` | Shows the findings, the spend and the gate's evidence. With no id, the latest experiment. An unfinished experiment is synced with its run first. |

## The lab card

**Kinds and stages.** Without `--kind`, the goal's words choose the kind (`classifyLabKind` in `lib/lab/policy.mjs`). A goal that implements, builds, prototypes or drafts code (a tool, an endpoint, middleware, a component) is a **code** experiment, even when `--kind research` was given. A goal about a skill is a **skill** experiment, and anything else is **research**. Each kind has required stages: research needs research only; skill needs build, test (its evals) and gate; code needs research (a short search-grounded step), build, test (the lab's test run and the draft PR) and gate. A Foundry build's gate is `/foundry approve`. An experiment is `done` only when every required stage passed. A code or skill experiment stays `running` while the gate waits on CI, then ends `done` (gate passed) or `failed` (gate failed, or CI silent for 7 days). Research that comes back empty fails (`research: ...`), never `done`. Every error names the stage it stopped in, and `/lab report` lists what each stage did.

`/lab status` (the latest six), `/lab report` and every lab watch report show a card built from the experiment's row on the server (`lib/lab/card.mjs`). Each card shows the PG1 lab mascot in the pose of the real status (queued taps its clipboard, running stirs its flask, done holds up the result, failed puffs smoke and shrugs, a budget stop turns out an empty pocket). It has a beaker filled to the spend over the budget cap (red from 90%), and the stage track research → build → test → gate, which always agrees with the status. A queued card has no active stage. On a failed card, the stage it stopped at is red and the rest are empty dots. "Over budget" means the spend passed the budget. The runner stops before a call that could cross the budget, so a stop under it reads "near budget" with its stop threshold. On `/lab status` each card carries its own Report button (and Stop while it runs), and no text list repeats the cards. The page keys cards by lab id, so a later card for the same lab replaces the earlier one. Finished states play once and rest; a card restored from a saved chat does not move. Nothing moves under reduced motion.

## How a result gets back

The runner never writes to Supabase or to the Vercel deployment. It uploads its result as the run's artifact `lab-result-<id>`. The deployment pulls it from GitHub with its own token (`PG1_LAB_DISPATCH_GITHUB_TOKEN` or `GITHUB_TOKEN`, which needs Actions: read). The artifact download redirects to blob storage, and the deployment follows that redirect without the token. It then writes the result to `pg1_lab_experiments`. This happens on `/lab status`, on `/lab report`, and every hour from `/api/flags/monitor`.

A finished run always ends as `done`, as the runner's own `failed`, `over_budget` or `timeout`, or as `failed` with the reason in `error`. Possible reasons: no artifact, the artifact list refused (HTTP 401/403/404 means the token lacks Actions: read), an unreadable zip, or no `result.json`. Only a transient read failure (network, 429, 5xx) waits, for at most 30 minutes after the run ended. The reason is shown in `/lab report` while it waits. A result Postgres cannot store as is gets cleaned (NUL characters removed). If the full result still cannot be stored, the outcome and spend are stored with the report cut to 8000 characters. Spend goes on the ledger only after the record is written, so a retry never counts it twice.
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
