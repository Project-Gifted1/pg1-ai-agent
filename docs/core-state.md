# PG1 Core State

One shared workspace that every module publishes to, so PG1, the operator and PG1's reflections read the same picture. Nothing in it calls an AI engine.

## Pieces

- **Workspace** (`lib/core/state.mjs`, `lib/core/collect.mjs`). It keeps one snapshot per area: router, spend, autonomy, missions, lab, feed, media, self_heal, errors, approvals, integrations and sandbox (worlds, steps today, quota use, world-mission errors and running experiments: counts only, labelled as simulation; see [sandbox.md](sandbox.md)). It also keeps an event log of the last 30 days.
  - It is stored in `pg1_core_state` / `pg1_core_events`. Until the migration runs, it is kept in each instance's memory.
  - It never holds secrets, client data or request content: those keys are dropped and the text is scrubbed.
  - A relayed message (`/relay`) can never write to it.
- **Self-model** (`lib/core/self.mjs`). It gives each of 17 capabilities a status of `available`, `degraded` or `unavailable`, with a plain reason and a fix. It also gives the current focus, today's spend against the cap, and the open problems ranked by impact.
  - It is checked before missions, autonomy, films, movies, music and the lab start. A state known from live data stops the work at the start, with its reason: out of credit, a resting quota, or Autonomous mode off.
  - The "confirm a budget" step at the $0 default is the start flow's own Confirm, so the self-model never blocks it.
  - On a self question ("how are you?", "why did X fail?"), PG1's prompt gets a block of at most 400 tokens from it.
- **Reflections and lessons** (`lib/core/reflect.mjs`). Each hour the pulse looks at the last 24 hours. Any problem that repeated becomes a proposed lesson in `pg1_core_lessons`.
  - Only lessons the operator approves act, and only as hints.
  - A lesson can never change code, secrets, caps, rules or permissions: such text is refused when it is proposed.
- **Honesty** (`lib/core/honesty.mjs`). PG1 never claims to be conscious, sentient or alive, or to have feelings.
  - Asked, it says whether an AI can be conscious is an open question, and describes its state functionally.
  - The identity rules still apply: no engine, provider or model names.

## Commands (operator only)

| command | what it does |
|---|---|
| `/state` | the Core State card |
| `/lessons` | lessons: proposed, approved, retired |
| `/lessons approve <id>` | the lesson acts from now on, as a hint |
| `/lessons retire <id>` | it stops acting |
| `/lessons reflect` | reflect on the last 24 h now |

## Migration

`supabase/migrations/20261109120000_pg1_core_state.sql` is **not applied automatically**. It is safe to run more than once, changes no existing data and is service role only.
