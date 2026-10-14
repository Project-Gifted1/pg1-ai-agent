# Payment test plan

How to prove, before and after a deploy, that every way of paying for a PG1
paid call works and that production is configured to take the money. Steps
1 and 2 cost nothing and move no money. Step 3 spends a few cents of USDC
on Base from a test wallet.

Paid surfaces (all 0.01 USD a call, USDC on Base, `eip155:8453`):

| Route | Paid calls | Ways to pay |
|---|---|---|
| `POST /api/mcp` `tools/call` | `get_cve_details`, `get_cve_batch`, `get_cve_by_product`, `get_threat_actor_profile`; `get_ioc_context` / `get_ioc_batch` when something is found | x402 (`params._meta["x402/payment"]` or the header), licence key, free tier |
| `POST /api/a2a` `SendMessage` / `message/send` | `get_cve_details`, `get_cve_batch`, `get_cve_by_product`, `get_threat_actor_profile` | x402 (a2a-x402: `message.metadata["x402.payment.payload"]`, or the header), licence key, free tier |

The STIX feed (`GET`/`POST /api/ioc`, the `/api/feeds/ioc` alias, and MCP
`get_threat_indicators`) is FREE while it holds no current data: no 402, no
licence key, and it does not use the free tier. `PG1_FEED_PAID=true` makes it
paid again (x402, licence key, free tier, as before); then add `/api/ioc`
back to `/.well-known/x402` and `x-payment-info` to its OpenAPI operations.

The free tier is one 5/day counter per caller (a salted hash of the IP) across
`/api/mcp` and `/api/a2a` (and `/api/ioc` when paid) in `free_tier_usage`,
automatic (no header) before any 402, skipped with `X-Free-Tier: 0`, spent
only by a call that succeeds.

## 1. Repo checks (CI, every PR)

`npm test` runs these under the no-network guard:

- `tests/phase2-usage-and-config.test.mjs`: price, network, asset (USDC) and
  amount (`10000`) in `lib/x402Config.mjs` match `/.well-known/x402`; every
  published resource pays one address; the docs say 5 calls/day; the agent
  card declares the a2a-x402 extension and the price. The live checks below
  are also run against a mocked deployment, including one paying the wrong
  address, which must fail.
- `tests/phase2-funnel.test.mjs`: the shared counter across `/api/mcp` and
  `/api/a2a` (5 served, the 6th challenged on either route); A2A unpaid,
  licence and x402 paths (verify, run, then settle, receipt returned); a
  failed call spends no free-tier call; paid CVE responses carry no EPSS.
- `tests/mcp-x402-v2.test.mjs`, `tests/free-tier-defer.test.mjs`,
  `tests/ioc-*.test.mjs`: the MCP and REST payment paths.

## 2. Production configuration (read-only, before and after each deploy)

```bash
node scripts/verify-payment-config.mjs --live
```

Without paying or spending free-tier quota, this checks that production:

- serves `/.well-known/x402` identical to the repo;
- answers an unpaid `get_cve_details` on `/api/mcp` with the x402 v2
  PaymentRequired result (and the `PAYMENT-REQUIRED` header) naming the
  published network, asset, amount and payee;
- answers the same skill on `/api/a2a` with an `input-required` task carrying
  that PaymentRequired object (needs this PR deployed);
- serves an unpaid `/api/ioc` free (200 STIX bundle), or, if `PG1_FEED_PAID`
  is on, answers it with HTTP 402 and the same terms;
- reports a 5/day free tier from `get_usage_status`.

Add `--pay-to 0x...` to check against the payee you expect rather than the
one the repo publishes.

Environment variables in Vercel production (names only; check in the
dashboard or with `vercel env ls production`):

| Variable | Must be | Why |
|---|---|---|
| `X402_PAY_TO_ADDRESS` | set | without it every x402 path is off |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | set | the CDP facilitator verifies and settles |
| `GUMROAD_PRODUCT_ID` | set | licence-key checks |
| `SUPABASE_URL` + a service-role key | set | free-tier counter, telemetry, revenue |
| `PG1_SOURCE_EPSS_PAID` | unset | EPSS stays out of paid responses until FIRST confirms resale |
| `PG1_FEED_PAID` | unset | the STIX feed stays free until it carries current data |
| `TELEMETRY_IP_SALT` | set | keys the free-tier counter and the licence-key hash in `api_access_logs` |
| `SOURCE_*_ENABLED` | unset | data-source defaults (README, "Data source switches") |

Checked on 2026-10-13 through the Vercel API: the first four are set,
`PG1_SOURCE_EPSS_PAID` and every `SOURCE_*` are unset. `/.well-known/x402`
matched the repo, and an unpaid `/api/ioc` (then still paid) returned 402 with
`10000` USDC (`0x8335…2913`) on `eip155:8453` to `0x8975…9d53`. `NVD_API_KEY`
is not set, so CVE lookups use NVD's keyless rate limit (see the PR's cost
notes).

## 3. Paid end to end (production, after the deploy)

Use a dedicated test wallet on Base holding a little USDC (each call is 0.01
USD) and an x402 v2 client (`@x402/fetch` for REST, `@x402/mcp` for MCP; for
A2A, build the PaymentPayload with `@x402/core` from the `accepts[0]` in the
`input-required` task). Use a fresh IP (or wait a day) for the free-tier
steps.

| # | Step | Expected |
|---|---|---|
| 1 | MCP `get_cve_details` unpaid | `isError: true`, PaymentRequired in `structuredContent`, no data |
| 2 | Same, paid via `params._meta["x402/payment"]` | data; `result._meta["x402/payment-response"].success`; one 0.01 USDC transfer to the payee on BaseScan |
| 3 | Same, paid via the `PAYMENT-SIGNATURE` header | data; `PAYMENT-RESPONSE` header |
| 4 | A2A `get_cve_details` unpaid | task `input-required`, `x402.payment.status: payment-required` |
| 5 | Same, resent with `message.metadata["x402.payment.payload"]` | task `completed`, `x402.payment.status: payment-completed`, receipt in `x402.payment.receipts`; transfer on BaseScan |
| 6 | `/api/ioc` with no payment, and with `X-Free-Tier: 0` | 200 STIX bundle both times; no 402; `X-Free-Tier-Remaining` unchanged (with `PG1_FEED_PAID=true`: 402, then paid with `@x402/fetch` gives 200 + `PAYMENT-RESPONSE`) |
| 7 | Pay from a wallet with no USDC | MCP: PaymentRequired with the verify error; A2A: `input-required` again; no data, no transfer |
| 8 | Free tier, no headers: 3 calls on `/api/mcp`, 2 on `/api/a2a` | all 5 served, `X-Free-Tier-Remaining` 4→0; `get_usage_status` shows 0 left |
| 9 | 6th free-tier call on any route | payment challenge; `/usage` counts it as `free_limit_reached` |
| 10 | A free-tier call with a malformed CVE id | error; the counter does not move |
| 11 | Licence key in `X-API-KEY` on MCP and A2A | data; no transfer, counter unchanged |
| 12 | Paid CVE response | no `epss` field and no EPSS credit while `PG1_SOURCE_EPSS_PAID` is unset |
| 13 | `/usage 24h` in the PG1 chat | the settlements and revenue from steps 2–5 (A2A included), free tier by route from step 8, the feed as free |

Record each step's request id (`X-Request-Id`) and transaction hash.

If a step fails, x402 can be switched off at once by unsetting
`X402_PAY_TO_ADDRESS` in Vercel and redeploying. Every paid call then
answers with a payment challenge that cannot be paid, and the licence key and
free tier keep working.
