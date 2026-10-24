# PG1 projects

`/mission add project "<goal>"` (operator only, `lib/autonomous/projects.mjs`). While Autonomous mode is ON, a project moves one stage every tick, every 10 minutes, on the free engines only ($0). The kill switch stops it at every checkpoint.

| stage | what happens |
|---|---|
| research | a written brief: the problem, the approach, the files, the tests |
| build | the code, its test and a short doc, committed to a fresh `project-*` branch and opened as a **draft** pull request |
| test | the repository's CI runs on the pull request, including the **project tests** job; PG1 reads the result |
| fix | on a failure PG1 reads what failed and pushes a fix, at most twice, then tests again |
| review | one approval card with the brief, what was built, the test result and the link. This is the only time you are asked or notified. |

## Guardrails

- **Where it writes:** only new files under `lib/projects/<slug>/` (the code and its test, side by side) and `docs/projects/<slug>.md`. Never existing code, workflows, package files, environment or migrations. Always its own branch, as a draft. PG1 never merges or deploys.
- **What the code may import** (`lib/autonomous/projectCode.mjs`): an allowlist read from the code itself. Every static import, re-export and dynamic `import()` is found, and its module checked. Only these are allowed:
  - `node:assert` (and `node:assert/strict`), `node:test`, `node:crypto`, `node:util`, `node:path`;
  - the project's own files, as `./file.mjs`.
  - A dynamic import of anything not written out literally is refused, and so is any other use of `import` the check cannot read.
- **No way to the process or the network.** The check refuses the following, anywhere in the text (strings and comments included) after decoding `\u` and `\x` escapes:
  - `require` and `process`, in any form;
  - the global object (`globalThis`, `global`), `eval`, the `Function` constructor and the usual ways round them (`constructor`, prototype and property-descriptor lookups, `Reflect`, `Proxy`);
  - `import.meta`, `fetch`, `WebSocket`, `XMLHttpRequest` and workers.
- **CI is the second layer.** A static check of JavaScript cannot be complete, so the project tests also run in their own CI job, **project tests** (`.github/workflows/tests.yml`), with:
  - the network blocked (`tests/ci/no-network.mjs`);
  - an empty environment (`env -i`);
  - no packages installed;
  - no secrets: the workflow references none, its token is read-only (`contents: read`), and checkout does not keep it.
- **No mentions.** Every "@" in what PG1 writes to GitHub (pull request titles and bodies, commit messages, and any title, body or message field it sends) becomes "＠". So it can never call `@claude` (`.github/workflows/claude.yml`) or notify anyone.

## Migration

`supabase/migrations/20261111120000_pg1_projects.sql` is **not applied automatically**. Run it after the sandbox migration (`20261110120000_pg1_sandbox.sql`).

- **What it changes in `pg1_missions`:**
  - adds `stage` (research, build, test, fix, review, done or failed) and `project` (the brief, branch, pull request and test result, at most 16 KB, no code);
  - widens `kind` to include `project`;
  - lets a project's interval be as short as 5 minutes; other missions keep 60 minutes to a week.
- **Before it runs,** `/mission add project` answers that the migration is needed.
