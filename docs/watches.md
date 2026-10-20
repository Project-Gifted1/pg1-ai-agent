# Background watching and reports

PG1 keeps an eye on the things it starts or the operator asks about, and
reports back in the chat thread they came from, with a web push
notification, as soon as they change state.

| What | Watched when | Reported |
|---|---|---|
| Lab experiment | every `/lab start` (and the weekly scan, Foundry builds), "watch it", `/watch lab <id>` | when it ends: done, failed, over budget, timeout, stopped |
| Pull request | every PR PG1 opens (patch, approve, reorganize), "watch it", `/watch pr <url>` | CI passed / failed on the head commit, merged, closed |
| Workflow run | "watch it", `/watch run <url>` | when it completes, with its conclusion |
| Deploy | every production deploy (automatic), `/watch deploy <dpl_...>` | ready, error, canceled |

A report says what happened, the result, the cost and the next step, with
buttons (`Lab report <id>`, `Open PR`, `Open run`). It is built by code from
the state PG1 read, never written by a model.

## Commands

- **"watch it"**, **"monitor it"**, **"tell me when it's done"** (typed or
  spoken): watches the newest lab experiment, PR, workflow run or deploy
  named in this message or the last few messages. With nothing to watch,
  PG1 says so and watches nothing.
- **/watch list**: open watches. **/watch stop &lt;id&gt;**: stops one.
- **/watch lab &lt;id&gt;**, **/watch pr &lt;owner/repo#n or PR URL&gt;**,
  **/watch run &lt;run URL&gt;**, **/watch deploy &lt;dpl_...&gt;**.

Operator only. Watches expire (lab 48 h, PR 14 days, run and deploy 24 h).

## How events come in

1. **GitHub webhook** `POST /api/hooks/github` (workflow_run, pull_request,
   check_suite), verified with `X-Hub-Signature-256` and
   `GITHUB_WEBHOOK_SECRET`. A finished lab run (`lab <id>`) syncs its
   experiment at once.
2. **Lab notice** `POST /api/hooks/lab`: the `notify` job at the end of
   `.github/workflows/lab.yml` posts `{ experiment_id, run_id, conclusion }`
   signed with `PG1_LAB_DISPATCH_SECRET` over `<timestamp>.<body>`
   (refused after 10 minutes). PG1 answers at once and syncs the experiment
   as soon as GitHub shows the run completed.
3. **Vercel webhook** `POST /api/hooks/vercel` (deployment created,
   succeeded, error, canceled), verified with `x-vercel-signature`
   (HMAC-SHA1) and `VERCEL_WEBHOOK_SECRET`.
4. **Fallback cron** `/api/watches/sync`, every 5 minutes: re-reads every
   open watch from its source and reports any change a webhook missed;
   expires old watches. Needs the Pro plan (Hobby crons run at most once a
   day; the existing hourly crons already need Pro).

Unsigned, wrongly signed or unconfigured events are refused (401, or 503
when the secret is not set). Each refusal logs one line, the source and the
reason (`[hooks] rejected source=github reason=bad_signature`), never the
payload.

The signature is checked over the exact bytes sent. The hook routes are
Web handlers (`export const POST`, no default export), so Vercel does not
read or JSON-parse the body first; keep them that way. The secret is
trimmed of surrounding whitespace and newlines. Reasons: `not_configured`,
`unsigned`, `malformed`, `no_raw_body` (the body was already consumed,
i.e. a route was turned back into a `(req, res)` handler), `bad_signature`
(the secret differs, or the body was changed), `stale` (lab only).

## Autonomy and the kill switch

- Watching something on its own (`watch:auto`) and reporting
  (`watch:report`) are FREE actions marked `notify`: allowed with
  `PG1_AUTONOMY=lab` (the default) and `on`, held with `off`. With `off`
  nothing is watched automatically and no report or push goes out; the
  watch keeps its last reported state, so the report goes out once autonomy
  is back on. Every decision goes on the audit log (`/autonomy`).
- The operator's own `/watch` always works.

## Honest actions

A model reply cannot start, stop, watch or change anything. The system
prompt says so, and `lib/honestActions.mjs` checks every model reply: a
sentence such as "Starting the experiment now." with no action behind it is
replaced (JSON) or corrected (streamed) with what is true, and the reply
gets a **Start experiment** button that runs `/lab start <goal>`, so the
autonomy policy, the lab budgets and the kill switch all apply.

## Push notifications

The menu's **Notifications** switch (top of the menu, under **Background
reports**; shown only after the operator signs in) registers `/sw.js`,
subscribes with the deployment's `VAPID_PUBLIC_KEY` and stores the
subscription in `pg1_push_subscriptions` (operator only). Under the switch it
shows the state (on, off, blocked by the browser, not available, not set up
on the server) and every result, including how to unblock the site in
Chrome. **Send test notification** stores this device again and pushes one
test to it (`/api/watches` `op: 'test'`), so delivery can be checked at once.
After sign-in a device that already has a subscription is stored again, so a
row the server lost comes back on its own. A notification carries a short
title and one line, cleaned of secrets, key and wallet shapes, links and
provider names; tapping it opens PG1 on the report's thread, where the full
report is fetched after sign-in.

## Setup

### Supabase

Run `supabase/migrations/20261028120000_pg1_watches.sql` (creates
`pg1_watches`, `pg1_watch_reports`, `pg1_push_subscriptions`; RLS on, no
policies; deletes no data).

### Environment variables (Vercel project)

| Name | Required | What |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | yes | the GitHub webhook's secret |
| `VERCEL_WEBHOOK_SECRET` | yes | the Vercel webhook's secret |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | already set | web push |
| `VAPID_SUBJECT` | no | push contact, default `mailto:admin@project-gifted1.dev` |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | no | lets the cron read a deploy whose webhook was missed |
| `CRON_SECRET`, `GITHUB_TOKEN`, `PG1_LAB_DISPATCH_SECRET` | already set | cron auth, GitHub reads, lab notice |

### GitHub webhook

Repository **Settings → Webhooks → Add webhook** (on every repository PG1
opens PRs in):

- Payload URL: `https://pg1-ai-agent.vercel.app/api/hooks/github`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- Events: **Let me select individual events** → Check suites, Pull
  requests, Workflow runs
- Active: on

### Lab notice

The notice goes to `https://pg1-ai-agent.vercel.app` unless the repository
variable `PG1_URL` (**Settings → Secrets and variables → Actions →
Variables**, or the `lab` environment's variables) names another address.
`PG1_LAB_DISPATCH_SECRET` is already in the `lab` environment.

### Vercel webhook

Vercel **Team Settings → Webhooks → Create Webhook**:

- Events: Deployment Created, Deployment Succeeded, Deployment Error,
  Deployment Canceled
- Projects: pg1-ai-agent
- Endpoint: `https://pg1-ai-agent.vercel.app/api/hooks/vercel`
- Copy the secret shown once into `VERCEL_WEBHOOK_SECRET`, then redeploy.

### Push opt-in

Open PG1, sign in, open the ☰ menu and turn **Notifications** on (the first
section, under **Background reports**); tap **Allow** when the browser asks,
then tap **Send test notification**. If the state says **Blocked by the
browser**, follow the steps shown under the switch: in Chrome, tap the icon
left of the address bar → Permissions → Notifications → Allow (or ⋮ →
Settings → Site settings → Notifications → the PG1 site → Allow), make sure
Android Settings → Apps → Chrome → Notifications is on, then reload PG1. On iPhone or iPad, add PG1 to the Home
Screen first (Share → Add to Home Screen) and turn it on from there.
