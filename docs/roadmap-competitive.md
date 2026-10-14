# What PG1 needs to compete with the big assistants

PG1's edge is narrow and real: signed, fail-closed threat-intelligence checks that other agents can pay for per call (MCP, A2A, x402). Products like ChatGPT, Gemini and Claude are general assistants with far larger teams, so PG1 should not try to match them on breadth. It should be the best at its niche and feel as polished as they do. Ranked by impact for the effort:

## 1. Reliability first (weeks)
- **One status page from real checks.** Uptime and p95 latency per MCP tool, and the model fallbacks of the last 24 hours, public at `/status`. Buyers of a paid API check this before they integrate.
- **Alert on model-key failures.** Today an out-of-credit Anthropic key falls back to Gemini silently. Raise an operator alert on the first 401/402 or credit-related 400, with the provider's own message, and track it in `/spend`.
- **Error budgets on the paid tools.** The hourly monitor already switches off failing flags. Add the same for each paid tool (p95 latency, error rate), and publish them as SLAs.
- **Nightly end-to-end checks against production.** One paid call per tool with a test wallet, checking the signature, the reason codes and the price. Run it from GitHub Actions and post the result to the error log.

## 2. Quality you can measure (weeks)
- **Answer evals for the chat.** The lab already runs skill evals. Run a fixed set of 50–100 real operator questions (pricing, checks, lab, PDF, voice) on every PR touching `api/chat.mjs` or a prompt. A grader model scores them on the rules in `lib/persona.mjs` and `lib/replyFacts.mjs`, and the PR fails if the score drops.
- **Tool-result accuracy benchmarks.** A labelled set of known-bad and known-good wallets, domains and packages. Publish precision and recall per check. This is the number agent buyers compare.
- **Regression screenshots.** The browser tests already write screenshots. Diff them on each PR so a layout break is caught before it ships.

## 3. A premium conversational experience (this PR, then months)
- Done in this PR: buttons instead of "run /command", spoken commands with confirm by voice, PG1's own conversational standard, full answers on request, sourced figures, flagged changes to proposed numbers.
- **Next: memory the operator controls.** Long-term facts PG1 learns ("Gift prices in USD", "the Studio tier includes editing"), each shown and editable in a Memory panel, used across threads. Today only the thread's task state carries over.
- **Next: one-tap voice everywhere.** Push-to-talk on the lock screen (PWA shortcut), a wake word on desktop, and the reply's actions read out at the end ("Say 'report' to open it").
- **Next: artifacts.** Turn a long answer into an editable document or table in place (the PDF route already exists), with version history.
- **Latency.** Stream the first sentence within one second: prewarm the function, keep the system prompt cached at the provider (prompt caching), and move the context loads (vault list, errors) off the critical path.

## 4. Trust and compliance (months)
- **Data handling page.** What is stored, where (Supabase region), for how long (`lib/retention.mjs`), and who can see it. Enterprise buyers ask for this before anything else.
- **Security review and a bug bounty** for the paid API and the payment flow (x402, CDP), with the results summarised publicly.
- **Licence audit of every data source** behind a paid check, with resale terms linked. The promotion gate already requires this for new sources; apply it to the existing ones too.
- **SOC 2 readiness checklist** (access reviews, change management via PRs and CI, incident log). Much of it is already in place (CI, branch protection, audit log), so write it down.

## 5. Distribution and pricing (ongoing)
- **List everywhere agents look:** the MCP registries, A2A directories and x402 marketplaces (the awesome-x402 and gold-402 lists).
- **Free tier → paid funnel metrics** in `/usage` (already started): conversion per tool, revenue per caller, churn.
- **Bundles agents can budget for:** for example a "preflight pack" of 1,000 calls at a fixed price, alongside per-call x402.
- **Case studies:** one page per real integration showing the calls, what was caught and what it cost.

## What not to do
- Don't build a general chatbot to compete on breadth. Use the best available models through `lib/aiRouter.mjs`, and spend the effort on PG1's own data, checks and experience.
- Don't let PG1 act outside the autonomy policy to look capable. The approval cards and the audit log are part of what makes it trustworthy.
