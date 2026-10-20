# PG1 full system audit — 20 Oct 2026

Audited `main` at `dac730f` (PR 2 and PR 3 merged; PR 1, 4, 5 and 6 open).

**How it was checked:**
- **Code and tests:** I read the code and ran the test files for each area under the repo's network guard (`NODE_OPTIONS=--import=./tests/ci/no-network.mjs`). The guard logged no outbound call.
- **Handlers:** I called the request handlers in-process with `fetch` stubbed.
- **Production:** I read the Vercel runtime errors for the last 7 days (read only).

**What was not done:**
- No money was spent: no paid AI call, no paid x402 call, no film, movie or music render.
- No message, email, push or webhook went to anyone.
- No production data was changed and no migration was run.

Anything that needs production is under [Needs Gift](#needs-gift), with the exact command, URL or read-only SQL.

**Result: 44 pass, 24 fail, 8 need a live check (76 checks).**
- 9 of the 24 failures are fixed in the focused PRs linked in the table: #351 (merged), #353, #354, and #356 (5 failures).
- 4 are covered by PRs 1 (#344, merged), 4 (#348), 5 (#349, merged) and 6 (#350).
- One more fix came out of the audit: #355, the intermittent voice-playback test.
- The other 11 are recommendations below the table. Three of them need a decision from Gift: the spend-cap default, the `/help` provider names, and the client-facing docs.

| # | Area | Check | Result | Evidence | Fix PR |
|---|---|---|---|---|---|
| 1 | MCP | Exactly 20 tools | pass | In-process `tools/list` returns 20 (`api/mcp.mjs:665-672`), 21 only with `PG1_ALERTS=true` (`subscribe_alerts`) | — |
| 2 | MCP | Version from GET /api/mcp matches package.json | fail | `pg1Version()` reads `server.json` (1.20.2, `lib/signing.mjs:33-38`); `package.json` says 1.0.3 and is never read. Every served version (MCP, agent card, openapi) says 1.20.2 | Recommendation R1 |
| 3 | MCP | Contract tests freeze tool names, inputs and responses | pass | `presign-guard-contract` 18/18 (4 tools, `tests/fixtures/presign-guard-tools-v1.14.0.json`); `check-ip-abuse` 44/44 (14 tools byte for byte, `existing-14-tools-snapshot.json`); `listings-drift` 15/15; `mcp-tools` 13/13. The 6 newest tools have no frozen snapshot yet | Recommendation R2 |
| 4 | MCP | Fixtures: FLAGGED / CLEAN / UNKNOWN / DELEGATED, `test_fixture: true` | pass | `lib/fixtures.mjs:80,94`; `api/mcp.mjs:2911,3181,3187`; `fixtures` 9/9, `fixtures-dispatch` 10/10 | — |
| 5 | MCP | `check_wallet_age` timeout: `isError`, `code upstream_unavailable`, `status unknown`, `found` omitted | pass | `api/mcp.mjs:3009` (fixture), `:4022-4045` (real); `tests/wallet-age-timeout.test.mjs:121-133`; 25/25, `wallet-age` 37/37 | — |
| 6 | A2A | Agent card | pass | `public/.well-known/agent-card.json`: 1.20.2, protocol 0.3.0, 22 skills; `agent-card` 8/8 | — |
| 7 | A2A | Skills match MCP tools | pass | 16 skills, all MCP tool names (`api/a2a.mjs:139-141`); the feed tools stay MCP-only by design | — |
| 8 | A2A | Version negotiation | pass | `api/a2a.mjs:227-238` (header, then query, default 0.3, 1.0 supported, otherwise VersionNotSupported); `a2a` 25/25, `jsonrpc-envelope` 2/2 | — |
| 9 | REST | `/api/preflight`: licence, free tier, x402, signed result | pass | `api/preflight.mjs`; `edge` 21/21 | — |
| 10 | REST | `/api/ioc`: free NVD CVE only, never ThreatFox or OTX | pass | Every read goes through `fetchThreatTelemetry`, filtered in the query and after it (`lib/sourcePolicy.mjs:174-181`). abuse.ch, ThreatFox, OTX and AbuseIPDB are `locked: true` (`:58-61`); `source-policy` 32/32 | — |
| 11 | REST | `/api/ioc` live: no `SOURCE_*` switch on in production | needs live check | blocklist_de, pg1_swarm and scamsniffer are not locked, so an env var can turn them on | [Needs Gift](#needs-gift) 3 |
| 12 | REST | `/api/watchlists`: 402, then 201, HMAC-signed webhook | pass | `api/watchlists.mjs:61-66`; HMAC-SHA256 `X-PG1-Signature` with a 5-minute replay window and timing-safe compare (`lib/watchlists.mjs:120-134`); `edge` tests | — |
| 13 | REST | `/api/health` | pass | `api/health.mjs`; 7/7 | — |
| 14 | REST | `/status` | pass | Rewrite to `api/status.mjs`; in-process JSON 200 | — |
| 15 | REST | `/openapi.json` lists every public route | fail | `public/openapi.json` lists only `/api/ioc` and `/api/health`. Missing: `/api/preflight`, `/api/hosting-advisor`, `/api/watchlists`, `/status`, `/.well-known/pg1-signing-key` | Recommendation R3 |
| 16 | REST | `/.well-known/pg1-signing-key` serves a key | needs live check | `api/signing-key.mjs`, `application/jwk-set+json`; locally `{"keys":[]}` because no key is set | [Needs Gift](#needs-gift) 8 |
| 17 | REST | `verify_result` | pass | Free (`api/mcp.mjs:246`); `edge` round trip, tampering, request binding, key rotation, JS and Python SDKs | — |
| 18 | x402 | Free tier 5 a day, one counter for MCP, A2A and ioc | pass | `FREE_TIER_DAILY_LIMIT = 5` (`lib/freeTier.mjs:45`); `free-tier-routes` 19/19, `free-tier-defer` 4/4, `free-tier-privacy` 6/6 | — |
| 19 | x402 | `X-Free-Tier-Limit` / `-Remaining` headers | pass | `lib/freeTier.mjs:102-106`; set on mcp, a2a, preflight and ioc; exposed in CORS | — |
| 20 | x402 | `X-Free-Tier: 0` opts out | pass | `freeTierOptedOut` (`lib/freeTier.mjs:95-98`); `free-tier-routes:189` | — |
| 21 | x402 | `PAYMENT-REQUIRED` header mirrored exactly in the 402 body | pass | `x402-header-body-mirror` 7/7. Minor: four fallback 402s (`api/chat.mjs:2236,2257,2279`, `api/preflight.mjs:74`) send no header | Recommendation R4 |
| 22 | x402 | Licence key via `x-api-key`, cached 24 h | pass | `LICENSE_CACHE_TTL_MS = 24h`, key stored as a hash, valid results only (`lib/paymentGate.mjs:19,62-101`); 22/22 | — |
| 23 | Live x402 | 402 mirror and free-tier headers in production | needs live check | — | [Needs Gift](#needs-gift) 4, 5 |
| 24 | Docs | ThreatFox described only as locked off | pass | Not fetched anywhere in `lib/` or `api/`; `README.md:294` says "always off (locked)" | — |
| 25 | Docs | No claim of OTX data in paid responses | pass | `otx` locked, off by default (`lib/sourcePolicy.mjs:61`); `README.md:295` | — |
| 26 | Docs | "Free while it holds no current data" | pass | Docs match the code (free unless `PG1_FEED_PAID`, `lib/x402Config.mjs:28-43`). A stale code comment remains: `lib/autonomous/capabilities.mjs:90` says "Free while the feed holds no data" | Comment fixed in #354 |
| 27 | Docs | Feed free in production (`PG1_FEED_PAID` unset) | needs live check | Docs last checked 2026-10-13 | [Needs Gift](#needs-gift) 3 |
| 28 | Docs | Paid-call table in the payment test plan | fail | `docs/payment-test-plan.md:12,13` left out `preflight_check` and `hosting_advisor`, which are paid (`api/mcp.mjs:17-19`, `A2A_PAID_SKILL_NAMES`) | Fixed: #354 |
| 29 | Docs | Never "safe" as a verdict | pass | `no-safe-wording` 6/6; every hit is a negation. The agent-card example prompt "Is it safe to pay …" is a user's question, not a verdict | — |
| 30 | Docs | Company mark Project-Gifted1™, no © | fail | No © anywhere public (only a vendored third-party licence header). Missing ™: `public/about/index.html:102`, `public/manifest.webmanifest:4` | Fixed: #354 |
| 31 | Docs | Tool count, prices, free-tier limit and endpoints match the code | pass | 14 doc test files, 167/167 | — |
| 32 | Wording | Client-facing output never names providers or models | fail | An unauthenticated `/help` lists the operator commands, including "the OpenRouter balance" and "(Grok, ChatGPT, ...)" (`api/chat.mjs:3299`). Note: the repo is public, and `docs/director-mode.md` and `docs/studio-sound-phase1.md` name providers | Recommendation R5 |
| 33 | Wording | Movie and film output white-label (PG1 Studio) | pass | `sayMovie` / `whiteLabel` on every reply; `movie`, `white-label`, `error-text-branding` tests | — |
| 34 | Hosts | Never call api.deepseek.com | pass | 0 hits in the repo; `keys-and-free-engines:160` | — |
| 35 | Router | No DeepSeek model in any engine list | fail | `OPENROUTER_FREE_MODELS` started with `deepseek/deepseek-chat-v3.1:free` (`lib/aiRouter.mjs:913`). On 20 Oct movie dailies were sent to it (404, model gone) | Fixed: #356 |
| 36 | Router | Free-first for operator chat | pass | `freeFirst` (`lib/aiRouter.mjs:1038,1046`) | — |
| 37 | Router | Free engines kept off client work | pass | `clientAllowedStep` (`lib/aiRouter.mjs:997`, `registry.mjs:671-672`), `chains.mjs:63-64` | — |
| 38 | Router | Customer data only on commercial_ok engines | fail | Without `clientWork`, customer data could plan OpenRouter, the AI gateway and OpenAI (licence "unclear", T1). Film text listed OpenRouter, and the A2A `jobModel` (`lib/a2aJobs/service.mjs:66`) did not pass `clientWork` | Fixed: #356 (`planRoute` limits customer data to commercial_ok engines) |
| 39 | Router | An engine out of credit is not called again and again | fail | A billing failure only moved the key to the back for 15 minutes, so it was still tried. On 20 Oct a Claude key with no credit was called on every movie shot | Fixed: #356 (left out for 1 hour) |
| 40 | Router | `PG1_DAILY_SPEND_CAP_USD` defaults to $0 | fail | Unset, empty or invalid returns `Infinity` (no cap, fail-open, `lib/aiRouter.mjs:751-756`); per-engine budgets also default to Infinity (`:645-650`) | Recommendation R6 (Gift decides) |
| 41 | Router | Tests | pass | ai-router, router-*, free-*, keys-and-free-engines, compat-reasoning-effort: 164/164 | — |
| 42 | Command Centre | Every handled command is listed in /help | fail | Not listed: `/auth`, `/smoke`, `/vault`, `/patch`, `/deploy-cron`, `/build-validator`, the `/tts` alias, "/status update" (`api/chat.mjs:3297-3299`) | Open PR #348 (one command registry; /help generated from it) |
| 43 | Command Centre | `/smoke` matches only the command | fail | `api/chat.mjs:2553` uses `includes('/smoke')`, so any operator message that mentions it makes a live call to the onrender API | Recommendation R7 |
| 44 | Relay | `/relay` (PR #343): parsed, no tools, no command dispatch | pass | `api/chat.mjs:2306-2316,2973,4440`; `chat-relay` + browser 24/24 | — |
| 45 | Autonomous | Free engines only by default | pass | `allowPaid = daily_budget_usd > 0`, default $0 (`lib/autonomous/runner.mjs:107`; `freeText.mjs:46-47`) | — |
| 46 | Autonomous | Hourly action cap | pass | `lib/autonomous/state.mjs:249-251` | — |
| 47 | Autonomous | A paid budget above $0 is counted | fail | Self-heal and missions report no cost (`runner.mjs:129,172,183`), so `state.mjs:253-255` never counts their spend | Recommendation R8 |
| 48 | Autonomous | Tests | pass | 4 suites + 2 browser files: 42/42 | — |
| 49 | Living lab | Failures shown; red workflow on a failed run | pass | `scripts/lab-verdict.mjs:12-20`; `lab.yml` verdict job `if: always()`; 51/51 | — |
| 50 | Living lab | `lab.yml` `PG1_URL` defaults to production when unset | fail | The notify step read `vars.PG1_URL` only; unset, no result notice was sent | Fixed: #353 |
| 51 | Living lab | Lab keys separate from production | fail | `lab.yml:110-111` falls back to the production `ANTHROPIC_API_KEY` and `GEMINI_API_KEY_PAID` when the lab-only secrets are missing | Recommendation R9 |
| 52 | Studio | Film: credit check before anything is created; cap on approval | pass | `lib/film/chat.mjs:272,459,628` | — |
| 53 | Studio | Movie: worst-case budget confirmed, retakes capped, pauses before overspend | fail | 20 Oct, movie 6da446ca: 27 clips (~18.60 USD) in 16 minutes for ~12 shots. Six shots were rendered three times (`MAX_RETAKES = 2`, plus the QC gate's extra take), and the movie then failed out of credit | Fixed: #356 |
| 54 | Studio | Movie: resume and rerun without paying twice | fail | There was only `/movie retry`, which ran under the old cap: a movie stopped by its cap could not continue | Fixed: #356 (`/movie resume`, Rerun button) |
| 55 | Studio | `PG1_VIDEO_ENABLED` gates every video spend | fail | /video, `api/video-render.mjs:80` and /film are gated. /movie (`lib/movie/chat.mjs:73-122`) and film approvals (`lib/film/chat.mjs:583`) are not | Recommendation R10 |
| 56 | Sound | Music: credit check before spending | fail | A per-track cap and per-engine budgets exist (`lib/music/chat.mjs:346-350`), but no credit probe before a render | Recommendation R10 |
| 57 | Studio / Sound | Tests | pass | film-*, movie, music*, video-*, ledger-clip-costs, spend-cap, browser cards: 322/323. The film ffmpeg end-to-end test timed out under load and passes alone | — |
| 58 | Camera | Fallback when the vision engine is unavailable | pass | `lib/cameraFeed.mjs:91,118-125`: free key, paid key, Claude; `ai_unavailable` or a retry hint; 11/11 | — |
| 59 | Tool Foundry | No paid AI call before payment | fail | An unpaid `build_tool` submission runs the paid light classifier (`lib/foundry/jobs.mjs:82` → `lib/a2aJobs/service.mjs:97`) before the fee, with no limit per caller (`api/a2a.mjs:689`) | Recommendation R11 |
| 60 | hosting_advisor | Free paths make no paid call | pass | Reads its dataset only; 54/54 with Foundry and playground | — |
| 61 | Playground | Free paths make no paid call | pass | Guest tools only, no model call (`lib/chatTools.mjs:147`) | — |
| 62 | Housekeeping | `url.parse()` (DEP0169) on /api/watchlists, /api/status, /api/preflight | fail | Vercel runtime errors, last 7 days: DEP0169 ×37 on `/api/watchlists`, `/api/status`, `/api/a2a`, `/api/preflight`. The Vercel helpers fill `req.query` lazily with `url.parse()` | Fixed: #351, merged (`lib/requestQuery.mjs`, WHATWG `URL`; also a2a, ioc/context, the system status check) |
| 63 | Housekeeping | Old tests run in CI | fail | `tests/preflight.test.js` is CommonJS under `"type": "module"`, fails if run, and is outside the `npm test` glob | Recommendation R12 |
| 64 | Housekeeping | `/api/ioc` query values encoded | pass | Hygiene note only: `since`, `type` and `min_score` go into the PostgREST query unencoded (`api/chat.mjs:2014-2021`), but the source allowlist and the row filter after the query still hold | — |
| 65 | Production | Chat: `tool_results_rejected` (a function call on a round with tools off) | needs live check | Vercel, 14 and 16 Oct: `[gemini-3.8-flash] 200 with no usable text (function call search_history on a round with tools off)` ×2. PR 1 (#344) moves history questions to the history route | [Needs Gift](#needs-gift) 12 |
| 66 | Production | Chat: every engine out of credit | needs live check | Vercel, 17 Oct ×3: Anthropic 400 "credit balance is too low" and Gemini 402 "prepayment credits are depleted"; 16 Oct ×2: the backups (gpt-5-mini) timed out | [Needs Gift](#needs-gift) 10 |
| 67 | Production | Voice timeouts | needs live check | Vercel, 14 and 16 Oct: `voice_synthesis_failed … message=timed out` ×4 on the speech engine | [Needs Gift](#needs-gift) 12 |
| 68 | Production | `/api/watches` storage | pass | Vercel, 17 Oct: `[WATCHES] storage failed: status=404` ×1, not repeated since | — |
| 69 | Tests | MCP, A2A, REST, x402, discovery | pass | 42 files, 544/544 | — |
| 70 | Tests | Docs and discovery | pass | 14 files, 167/167 | — |
| 71 | Tests | Command Centre, modes, Studio, router | pass | Every suite above, 0 failures except the load timeout (row 57) | — |
| 72 | Branding | Movie and film errors name no engine | pass | `movie`: the help, status, failure and gate wording test | — |
| 73 | Branding | Infrastructure names in conversation | fail | PG1 called itself "running on Vercel" and mentioned Supabase in ordinary replies | Fixed: #349, merged |
| 74 | Chat | Default route and search footer | fail | Production logged `route=search reason=default` on every chat; the footer was on every reply | Fixed: #344, merged |
| 75 | Chat | Rate-limited free keys held replies ~19 s | fail | Chat limiter `maxWaitMs` 20 s and a breaker per instance | Fixed: #350 |
| 76 | CI | Cloudflare "Workers Builds: pg1-ai-agent" check | needs live check | Fails on every PR, including #343 from before this audit. The build runs in the Cloudflare project, outside the repo | [Needs Gift](#needs-gift) 14 |

## Fix PRs

| PR | What |
|---|---|
| #351 (merged) | Query strings read with WHATWG `URL`, not `url.parse()` (DEP0169) |
| #353 | Living lab: the verdict job runs without npm packages (self-heal #352, found during the audit); `PG1_URL` defaults to https://pg1-ai-agent.vercel.app |
| #354 | Payment test plan paid-call rows; Project-Gifted1™ on the about page and manifest; the feed comment |
| #355 | The `voice-playback` browser test's harness race (an intermittent "no silent gap" failure seen on PR 4 and PR 5) |
| #356 | Movie spending: confirmed worst-case budget, 1 retake per shot, `paused_budget`, resume and Rerun, customer data on commercial_ok engines only, no DeepSeek, out-of-credit engines left out for an hour, cheapest dailies once per take |
| #350 | PR 6, rate limits on the AI keys |

## Recommendations (bigger than a focused fix)

- **R1. Version:** set `package.json` `version` to 1.20.2. Better, have one file be the source and add a test that the two match.
- **R2. Contract freeze:** freeze `preflight_check`, `check_x402_endpoint`, `check_agent_card`, `verify_result`, `hosting_advisor` and `check_package` in a v1.20.2 contract snapshot, as was done for the 1.14.0 tools. Additions only.
- **R3. OpenAPI:** add `/api/preflight`, `/api/hosting-advisor`, `/api/watchlists` (POST, GET, DELETE), `/status` and `/.well-known/pg1-signing-key` to `public/openapi.json`, with their 402 / `PAYMENT-REQUIRED` responses.
- **R4. Fallback 402s:** send a v2 `PAYMENT-REQUIRED` challenge on them, or a 503 for the outage cases (facilitator down, x402 not configured).
- **R5. `/help` and the public docs:**
  - An unauthenticated `/help` should show only the public commands, with no provider names. PR #348 generates /help from the registry, which is the natural place to filter by `operatorOnly`.
  - Decide whether `docs/director-mode.md` and `docs/studio-sound-phase1.md` should stay in a public repo. They name providers.
  - Decide whether `README.md:152` "Best for Claude, MCP-compatible agents" counts as naming a provider. It names a client, not an engine PG1 uses.
- **R6. Spend cap (Gift decides):** the spec says `PG1_DAILY_SPEND_CAP_USD` defaults to $0, but the code treats unset as "no cap". Changing the default to $0 (and invalid values to $0) stops every paid engine until Gift sets a cap. Production currently relies on the paid keys for chat, so set the variable in Vercel first, then change the default. PR 1 already treats "unset" as $0 for paid search grounding.
- **R7. `/smoke`:** match `^/smoke(\s|$)` only.
- **R8. Autonomous spend:** return each paid call's cost from `autonomousText` into `costUsd`, and pass a worst-case `estimateUsd` when `allowPaid` is on, so the daily budget stops self-heal and missions.
- **R9. Lab keys:** remove the `lab.yml` fallback to production keys, or document it in /help.
- **R10. Video switch and music credit:** check `videoEnabled(env)` in `handleMovieCommand`, `handleMovieApproval` and `handleFilmApproval`. Add the `filmMediaCredit` probe to `/music` before a render.
- **R11. Tool Foundry:** rate-limit `build_tool` submissions per caller, or classify only after the build fee settles.
- **R12. Old test:** delete `tests/preflight.test.js` or convert it to `.mjs`.

## Needs Gift

Every command below is free: GET, or a POST that only returns a 402 challenge or a reply made before any model call. None of them spends money or messages anyone. `X-Free-Tier: 0` keeps the free tier unspent. The SQL is read-only.

1. **Live version and status:**
   ```
   curl -s https://pg1-ai-agent.vercel.app/api/mcp | jq '{name,version,status}'
   ```
   Expect version "1.20.2".

2. **Agent card:**
   ```
   curl -s https://pg1-ai-agent.vercel.app/.well-known/agent-card.json | jq '{version, protocolVersion, skills: (.skills|length)}'
   ```
   Expect 1.20.2 and 22 skills.

3. **/api/ioc sources and the env switches (rows 11, 27):**
   ```
   curl -s 'https://pg1-ai-agent.vercel.app/api/ioc?limit=1000' -H 'X-Free-Tier: 0' -o /tmp/ioc.json -w '%{http_code}\n'; jq '[.objects[].type] | group_by(.) | map({(.[0]): length}) | add' /tmp/ioc.json; grep -ciE 'threatfox|urlhaus|abuse\.ch|otx|alienvault|abuseipdb' /tmp/ioc.json
   ```
   Expect 200 (402 if `PG1_FEED_PAID` is on), only `vulnerability` and `bundle` types, and a grep count of 0. Then, with the Vercel CLI (no values printed):
   ```
   vercel env ls production | grep -E 'SOURCE_|PG1_FEED_PAID|PG1_ALERTS|PG1_DAILY_SPEND_CAP_USD|PG1_MOVIE_MAX_RETAKES|PG1_MOVIE_MAX_USD'
   ```
   Expect no `SOURCE_*_ENABLED` set to true and no `PG1_ALERTS`. Note whether `PG1_DAILY_SPEND_CAP_USD` is set (R6).

4. **Preflight 402 mirror, free tier declined:**
   ```
   curl -s -D /tmp/h.txt 'https://pg1-ai-agent.vercel.app/api/preflight?action=pay&target=0x7067312d746573742d6669787475726500000002' -H 'X-Free-Tier: 0' -o /tmp/b.json -w '%{http_code}\n'; grep -i '^payment-required:' /tmp/h.txt | cut -d' ' -f2 | tr -d '\r' | base64 -d | jq -S . > /tmp/hdr.json; jq -S . /tmp/b.json | diff - /tmp/hdr.json && echo MIRROR_OK
   ```
   Expect 402 and `MIRROR_OK`.

5. **Free-tier headers:** this uses 1 of today's 5 free calls, costs nothing, and runs on a test fixture with no upstream call.
   ```
   curl -si 'https://pg1-ai-agent.vercel.app/api/preflight?action=pay&target=0x7067312d746573742d6669787475726500000002' | grep -iE '^HTTP|x-free-tier-(limit|remaining)'
   ```
   Expect 200, `X-Free-Tier-Limit: 5` and `X-Free-Tier-Remaining` between 0 and 4.

6. **Health:**
   ```
   curl -s -w '\n%{http_code}\n' https://pg1-ai-agent.vercel.app/api/health
   ```

7. **Status page JSON:**
   ```
   curl -s 'https://pg1-ai-agent.vercel.app/status?format=json' | jq '{available, window_hours, signing, tools: (.tools|length)}'
   ```
   Expect `signing` true.

8. **Signing key (row 16):**
   ```
   curl -si https://pg1-ai-agent.vercel.app/.well-known/pg1-signing-key | grep -i content-type; curl -s https://pg1-ai-agent.vercel.app/.well-known/pg1-signing-key | jq '.keys | length, .[0].kty, .[0].crv'
   ```
   Expect `application/jwk-set+json`, at least 1 key, OKP, Ed25519.

9. **Watchlists 402, nothing stored or paid:**
   ```
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://pg1-ai-agent.vercel.app/api/watchlists -H 'Content-Type: application/json' -H 'X-Free-Tier: 0' -d '{"items":[{"kind":"domain","target":"pg1-test-clean.invalid"}],"webhook_url":"https://hooks.example.com/x"}'
   ```
   Expect 402.

10. **Engine credit (row 66):** the Anthropic and paid Gemini accounts were out of credit on 17 and 20 Oct. Check them in the app with `/keys fresh`. It makes one-token probes on the free paths, and its paid checks only read balances. Top up at https://console.anthropic.com/settings/billing and https://ai.studio/spend before rerunning movie 6da446ca.

11. **Movie 6da446ca: were its shots stored? (read-only):**
    ```sql
    select id, status, error_reason, spent_usd, cap_usd,
           jsonb_array_length(coalesce(director->'shots', '[]'::jsonb)) as shots,
           (select count(*) from jsonb_each(coalesce(director->'takes', '{}'::jsonb)) t where t.value ? 'accepted') as accepted_shots,
           (select string_agg(t.key || ':' || jsonb_array_length(coalesce(t.value->'attempts', '[]'::jsonb)), ', ' order by t.key) from jsonb_each(coalesce(director->'takes', '{}'::jsonb)) t) as takes_per_shot
    from public.pg1_film_projects
    where id = '6da446ca-6efe-4de1-8271-3d5dcb5bb021';
    ```
    ```sql
    select kind, status, count(*) from public.pg1_film_assets
    where project_id = '6da446ca-6efe-4de1-8271-3d5dcb5bb021'
    group by kind, status order by kind, status;
    ```
    The pipeline saves every take and every accepted shot (with its voice) the moment it is made, so `accepted_shots` should be about 12. With the movie spending PR deployed, its card shows **Rerun**, which continues from shot s3-w1.

12. **Production logs after the fixes deploy:** Vercel → Project → Logs, last 24 h, filter by message:
    - `DEP0169`: expect none after `fix-whatwg-url`.
    - `route=search reason=default`: expect none after PR 1.
    - `tool_results_rejected`: expect none after PR 1.
    - `voice_synthesis_failed`: the speech engine's timeouts, if they are still there.

13. **Migrations to run by hand, after review (none was run):**
    - `supabase/migrations/20261107120000_pg1_rate_tokens.sql` (PR 6)
    - `supabase/migrations/20261108120000_pg1_movie_paused_budget.sql` (movie spending PR)

    Both are safe to run more than once.

14. **Cloudflare Workers build (row 76):** open the build log from any PR's "Workers Builds: pg1-ai-agent" check, for example https://dash.cloudflare.com/f4ca340d9bcbeeab89bba95915dd072e/workers/services/view/pg1-ai-agent/production. If PG1 does not deploy to Cloudflare Workers, disconnect the Git integration there (Settings → Build → Disconnect), so every PR stops carrying a red check. Otherwise fix the build command or the root directory it uses.
