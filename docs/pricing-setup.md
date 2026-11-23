# Pricing setup (1.23.0)

How to switch on paid plans for `check_agent_message` and `check_repo_trap`.
Everything ships **off** (`PG1_PAID_CHECKS` unset). Nothing on this page
happens automatically: Claude Code did not create anything on Gumroad or in
Vercel.

The public pages never name the payment providers ("card payment", "pay per
check"). This page does, because it is for the operator only.

## What the plans are

| Plan | Checks | Price | How it is paid |
|---|---|---|---|
| No key | 25 a day per caller | free | — |
| Free key | 500 a day | free | email signup at `/keys` |
| Builder | 10,000 a month | 9 USD a month | Gumroad membership (card) |
| Team | 100,000 a month, up to 5 keys | 49 USD a month | Gumroad membership (card) |
| Partner | unlimited | none | only the licences listed in `PG1_PARTNER_LICENCE_HASHES` (Frits's presign-guard licence). Any other licence of the original product (`GUMROAD_PRODUCT_ID`) counts as **Builder** on these two checks and keeps everything else it had before |
| Pay per check | one check | 0.002 USD | x402, USDC on Base (existing facilitator and `X402_PAY_TO_ADDRESS`) |

The two tools share one quota. The source of truth is `lib/plans.mjs`.

## 1. Run the migrations (Supabase SQL editor)

In order, each once (all are safe to run again):

1. `supabase/migrations/20261122120000_pg1_paid_checks.sql`
2. `supabase/migrations/20261122130000_pg1_telemetry_plan.sql`
3. `supabase/migrations/20261123120000_pg1_telemetry_drops.sql` (from PR #430, merged in here)
4. `supabase/migrations/20261123130000_pg1_key_deletion_requests.sql`

Each file ends with read-only checks you can paste afterwards.

## 2. Create the two Gumroad products (from your phone)

Use the phone's browser (the Gumroad app cannot create products):

1. Open **gumroad.com**, log in, tap **Products**, then **New product**.
2. Name: `PG1 Builder`. Type: **Membership**. Price: **9 USD**, billing **Monthly**. Tap **Next: Customize**.
3. In the product's settings, turn on **Generate a unique license key per sale** (it is under the content / "License key" section). This is what the customer pastes into `X-API-KEY`.
4. Description (suggested): "10,000 PG1 checks a month (check_agent_message and check_repo_trap). Send your licence key in the X-API-KEY header. Cancel any time." Link to `https://pg1-ai-agent.vercel.app/pricing`.
5. **Publish**.
6. Copy two things:
   - the **product ID**: on the product's edit page, in the License key section ("use your product ID to verify licenses through the API");
   - the **product page URL**, e.g. `https://yourname.gumroad.com/l/abcde`.
7. Repeat for `PG1 Team`: **49 USD**, monthly, licence keys on. Description: "100,000 PG1 checks a month, up to 5 keys (your licence key plus 4 team keys from POST /api/keys/team)."

### The original product ($5/month): unpublish it

The original licence product (`GUMROAD_PRODUCT_ID`) should no longer be sold: on Gumroad, open it, **Unpublish** it. Do **not** delete it, and keep `GUMROAD_PRODUCT_ID` set in Vercel: existing licences are still checked against it, and Frits's licence is one of them. After unpublishing, check Frits's integration still answers (his calls show as partner calls in `/usage`; or ask him).

A licence of the original product is unlimited on the two metered checks **only** if its hash is in `PG1_PARTNER_LICENCE_HASHES` (next section). Every other licence of it counts as Builder there (10,000 a month) and keeps everything else it had before 1.23.0.

### Frits's licence hash (Partner)

`PG1_PARTNER_LICENCE_HASHES` holds the SHA-256 of each partner's licence key, never the key. To make Frits's:

1. On your phone or computer, open `https://pg1-ai-agent.vercel.app/keys/licence-hash.html` (it works out the hash in the browser: the key is never sent, stored or logged), paste Frits's licence key from your Gumroad sales page (Gumroad → Sales → his purchase), tap **Make the hash**, copy the 64 characters. Or, in a terminal on your own computer: `printf '%s' 'THE-LICENCE-KEY' | shasum -a 256` (the first word of the output).
2. Never paste the licence key itself into a chat, an issue, a PR, Slack or Vercel; only the hash goes into Vercel.
3. Set `PG1_PARTNER_LICENCE_HASHES` to that hash (several partners: comma-separated, no spaces needed).

Set it **before** `PG1_PAID_CHECKS=on`. While the switch is off nothing is counted, so Frits sees no change either way; once it is on, a licence not in the list is Builder on the two metered checks.

## 3. Set the environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Value | Needed for |
|---|---|---|
| `GUMROAD_PRODUCT_BUILDER` | the Builder product ID | Builder licences to be recognised |
| `GUMROAD_PRODUCT_TEAM` | the Team product ID | Team licences and Team keys |
| `PG1_CHECKOUT_URL_BUILDER` | the Builder product page URL (https) | the "Subscribe by card" button on `/pricing` |
| `PG1_CHECKOUT_URL_TEAM` | the Team product page URL (https) | the same, for Team |
| `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` | optional: a Cloudflare Turnstile widget's keys (dash.cloudflare.com → Turnstile → Add widget, domain `pg1-ai-agent.vercel.app`) | a bot check on the `/keys` form. Without them, signup is limited to 3 keys a day per network. |
| `PG1_PARTNER_LICENCE_HASHES` | the SHA-256 of Frits's licence key (see above); comma-separated for more partners | Partner (unlimited) — set it **before** the switch |
| `PG1_PAID_CHECKS` | `on` — **last**, when you are ready | switching the plans on |

Already set and unchanged: `GUMROAD_PRODUCT_ID` (the original product: keep it set even once unpublished), `X402_PAY_TO_ADDRESS`, the facilitator keys, `TELEMETRY_IP_SALT`, the Supabase keys.

Redeploy after changing variables (Vercel → Deployments → ⋯ → Redeploy), or wait for the next push.

## 4. What changes when `PG1_PAID_CHECKS=on`

- **No key:** 25 checks a day per caller (its own counter, not the 5/day of the paid tools), then an x402 challenge for 0.002 USD with links to `/keys` and `/pricing`. The 60/hour abuse limit stays.
- **Free key:** 500 a day (500/hour abuse limit), then the same 0.002 USD challenge.
- **Builder / Team:** 10,000 / 100,000 a month, no hourly limit. Over the quota: a `quota_exceeded` error naming the quota, the reset date (1st of next month, 00:00 UTC) and the upgrade. Never a degraded result.
- **Partner** (only the licences in `PG1_PARTNER_LICENCE_HASHES`): unlimited, no hourly limit — exactly as today. Any other licence of the original product: Builder on these two checks (10,000 a month, no hourly limit).
- **Paying per check:** any call that carries an x402 payment is charged 0.002 USD and not counted against a quota.
- Responses carry `X-PG1-Plan` (and `X-PG1-Quota`, `X-PG1-Quota-Remaining`, `X-PG1-Quota-Reset` where a quota applies).

While it is **off** (the default): nothing changes, except that free keys already work (500/hour and 500/day; after that, the key's holder is treated as having no key: 60/hour, no daily cap).

## 5. Cancellations and refunds

A licence is re-checked with Gumroad at most every 24 hours (cached per server instance). A cancelled membership keeps its plan until its paid period ends; a refunded, charged-back or failed one loses it at the next check, and the caller is then treated as having no key.

## 6. Checking it works

- `/usage` in the operator chat: "Message and repo checks by plan" and "Free-key signups".
- Supabase: `select tier, period, used from pg1_check_usage order by updated_at desc limit 20;`
- A Team holder manages team keys with their licence key in `X-API-KEY`: `GET /api/keys/team` lists, `POST /api/keys/team {"label":"ci"}` creates (shown once), `DELETE /api/keys/team?id=…` revokes.

## 7. Free keys: deletion and marketing

- **Deletion with the key** (on `/keys` or `POST /api/keys/delete` with `X-API-KEY`): immediate.
- **Deletion with only an email** (a holder who lost the key): nothing is deleted at once, because anyone can type an email. The request is recorded (by email hash, never the address), the holder is told "We'll delete your email and key within 30 days", and you are told in the error log and the next daily report. `/keys delete-requests` lists them; `/keys delete-request <id> approve` deletes that email's keys, the email and its usage counts (`decline` closes it). The answer is the same whether or not the email had a key, and nothing is recorded for an email with no key.
- **Signup** never says whether an email is registered: the same answer either way ("If this email can get a key, it has been issued; check the page"); a key is shown only when one was created.
- **Marketing:** the optional "product news" box is stored (`marketing_opt_in`). No marketing email may be sent until the address is verified: nothing yet checks that the person who ticked it owns the address. Email verification is a later PR.
