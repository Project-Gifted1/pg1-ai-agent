# /usage verify and usage figures in chat

PG1 checks its own usage and revenue figures against sources it does not
write itself, and checks figures other agents claim about it.

## /usage verify (operator only, read-only)

`/usage verify` (and `/pdf usage verify`) covers the last 7 Ireland days,
read up to 5 minutes ago. Nothing is paid, signed or spent: every call is a
read. Code: `lib/usageVerify.mjs`.

| Check | PG1's figure | Checked against |
|---|---|---|
| Traffic per day | `agent_telemetry` rows (`tool_call`, `mcp_request`, `initialize`) on `/api/mcp`, `/api/ioc`, `/api/preflight`, `/api/a2a` | Vercel observability: `POST https://api.vercel.com/v2/observability/query`, metric `vercel.request.count`, grouped by `request_path` and `request_method`, daily buckets in `Europe/Dublin`. Counted: POST on `/api/mcp` and `/api/a2a`, GET and POST on `/api/ioc` and `/api/preflight` (telemetry does not record health-check GETs, HEAD or OPTIONS) |
| Telemetry health | — | `pg1_errors` rows on route `telemetry:agent_telemetry` (`telemetry_insert_failed`, `_timeout`, `_unreachable`) |
| Revenue | `agent_telemetry` settlement rows with status `settled` (fixtures excluded) | USDC (Base mainnet, `eip155:8453`, the asset `lib/x402Config.mjs` settles in) received by `X402_PAY_TO_ADDRESS`, read through the existing Alchemy key: `alchemy_getAssetTransfers` on `base-mainnet`, plus `eth_getBlockByNumber("finalized")`. A transfer counts as received only once its block is final |
| Licence revenue | — | Gumroad `GET /v2/sales` for each id in `GUMROAD_PRODUCT_ID` (comma-separated), refunds excluded. Without a sales token: "paused / not configured" |

A day whose gap is over 5% is flagged "telemetry may be dropping rows".
Settled rows and transfers are matched one to one, by exact amount (USDC
base units) and time (within 15 minutes, nearest first). The verdict is
"Figures verified", or what does not match and where, or which source
could not be read. A source that cannot be read is named with its reason,
and the other checks still run. No gap is filled with an estimate.

### Environment variables

| Name | Needed for | Notes |
|---|---|---|
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | traffic check | already set for watches; the token must be able to read observability |
| `PG1_VERCEL_PROJECT_ID` | traffic check | the project id (`prj_...`); falls back to `VERCEL_PROJECT_ID` when Vercel exposes it |
| `ALCHEMY_API_KEY` | revenue check | already set (wallet age) |
| `X402_PAY_TO_ADDRESS` | revenue check | already set |
| `GUMROAD_PRODUCT_ID` | licence check | already set; comma-separated for several products |
| `GUMROAD_ACCESS_TOKEN` | licence check | optional; without it licence sales are reported as paused / not configured |

## Usage figures in chat (`lib/usageClaims.mjs`)

- **Questions.** "How many lookups a day?", "what's our revenue this week?"
  and similar operator questions are answered only from the 7-day usage
  report (plus `/usage verify` when the message asks "is that real" or
  "verify"). The reply states the period and ends with the `/usage` and
  `/usage verify` offer. PG1 never estimates, extrapolates or rounds up a
  figure. It gives a projection only when asked, labelled "Projection (not
  a real figure)", with its assumptions listed.
- **Claims.** When a `/relay` message, or a pasted message, states PG1
  usage, traffic or revenue figures, the reply gets a table listing each
  figure, the real value from the report, and whether it matches. PG1
  never adopts the other agent's figures.
- **Payouts.** Text that promises anyone a payout, return or income share
  gets a note: PG1 cannot support that, and the operator should get advice
  before sharing it. PG1's own replies never promise or imply one. If a
  reply does, a correction is added under it.
