# PG1 as the operator of its own service

With `PG1_AUTONOMY=on` and the Autonomous switch ON, PG1 reviews, improves
and reports on its own service on a schedule. Code: `lib/operator/`.

## Schedule

| When | What | Where |
|---|---|---|
| Daily 07:15 UTC | Daily report | `api/operator/daily.mjs` (new cron) |
| Mondays 07:30 UTC | Weekly report, with the opportunity scan | `api/opportunities/weekly.mjs` (cron moved from 06:41) |
| Every 10 minutes | Approvals expire, lab work is followed to its PR, low-risk PRs merge, merges are watched | `api/autonomous/tick.mjs` → `lib/operator/run.mjs` |

Each report is stored (`pg1_operator_reports`), shown as a card in chat with
Approve / Decline on each waiting item, pushed to the operator's devices and
saved as a PDF in the media library. `/report today` and `/report week` show
the latest. Every figure is read from its source; a source that cannot be
read is named and shows no figure.

## Findings and tasks

Each finding becomes one task (`pg1_operator_tasks`, unique per finding) with
its evidence (the counts).

| Kind | From | PG1 does |
|---|---|---|
| fix | at least 5 PG1/source-fault errors for real callers on a tool in 24 h | lab code experiment → PR → auto-merge if low risk, else approval |
| improve | at least 10 caller-fault answers to real callers on a tool in 7 days | same |
| new | an unknown tool or MCP method asked for by at least 3 real callers in 7 days | lab research + prototype → PR for approval (never auto-merged) |
| listing | the MCP registry version differs from the live version | prepares the listing text and steps; Approve runs `publish-mcp.yml` |
| pricing | at least 20 402s and none settled in 7 days, or a proposal's price | price with the 1.5x worst-case cost check; only approvable when the check passes; Approve opens a lab PR (never auto-merged) |

## Low-risk auto-merge (`code:merge_low_risk`)

FREE only with `PG1_AUTONOMY=on` and the switch ON. A PR must meet every rule
in `lib/operator/merge.mjs` `qualifyPr`:

- opened by PG1's own lab for a fix or improve task;
- the whole diff read: `pr.changed_files` files listed (paged, up to 300) and
  each with its patch (a file too large or binary has none: no decision);
- existing tests only added to: no deleted line in an existing file under
  `tests/`, no removed or renamed test file (new test files are fine);
- no SQL or migrations; no env var read (`env.NAME`, `env['NAME']`,
  `env["NAME"]`), `vercel.json`, workflow or package change;
- no protected code: `lib/autonomy.mjs`, all of `lib/lab/` and
  `lib/operator/`, pricing, payment, x402, licence, signing, secret guard,
  `lib/operatorSession.mjs`, `lib/cronAuth.mjs`, `lib/netGuard.mjs`,
  `lib/githubWriteGuard.mjs`, `lib/retention.mjs`, `api/chat.mjs`, any path
  matching `auth|session|passkey|webauthn|csp|cors|ratelimit|rate-limit|kill`,
  `supabase/`, `scripts/`, and all of `public/index.html` (its sign-in code
  is inline). The lab's `CODE_BLOCKED` has the same list;
- no change to the MCP contract (handlers, listings, contract tests);
- under 300 changed lines;
- the REQUIRED checks only ("npm test", "browser tests") passed on the head
  SHA. Other checks (the Cloudflare Workers Builds app check, x402-validate)
  are not judged. A required check still running is a wait; a failed one
  means not low risk. A re-run's newest result counts;
- the lab's promotion gate passed; at most 3 a UTC day, one at a time;
- auto-merge not paused (below).

After a merge PG1 first checks that the merge's deploy is the one serving
production (`GET /v4/aliases/{PG1_PRODUCTION_ALIAS}`, default
`pg1-ai-agent.vercel.app`). If production is pinned to another deploy, the
merge is recorded as not live, its health is not judged, and auto-merge
pauses. Otherwise PG1 watches the deploy for 60 minutes. If it fails, is not
Ready within 60 minutes, or the error rate (5xx share, at least 5 errors) or
p95 function duration rises more than 50% against the hour before the merge,
PG1 rolls production back to the deployment before it
(`POST /v1/projects/{id}/rollback/{deploymentId}`), opens a revert PR and
pushes a notification at once. Rolling back is a safety action, so it also
runs with the switch OFF.

**After a rollback production is pinned**: the platform does not promote
later production deploys on its own. PG1 pauses auto-merge (no
`code:merge_low_risk`), and the push and the daily report (first section)
say that production is pinned to the earlier deploy and new merges will not
go live until a deploy is promoted. Once you have promoted a deploy, send
`/report resume`: PG1 checks production now serves the newest Ready deploy
and only then resumes. Auto-merge also waits while production is found
pinned for any other reason.

## Approvals

Approve runs the item under its APPROVAL action (`code:merge`,
`directory:register`, `pricing:change`) with `approved: true`, and is logged.
Only the signed-in operator's decision counts; PG1 cannot approve its own
items. An item not decided in 7 days expires and is reported.

## Setup

- Run `supabase/migrations/20261113120000_pg1_operator.sql`.
- Env: `PG1_AUTONOMY=on`; `PG1_VERCEL_PROJECT_ID` (or Vercel's
  `VERCEL_PROJECT_ID`) for deploys, health and rollback; `GITHUB_TOKEN` with
  contents and pull-requests write for merging and revert PRs; optional
  `PG1_PAID_CALL_WORST_CASE_USD` so a pricing item can pass the 1.5x check.
