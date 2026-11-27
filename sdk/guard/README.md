# pg1-guard

A guard for AI agents. Every tool call is checked against your rules **before it runs**:

- **allow:** it runs straight away
- **ask:** it waits for a person to approve (your approval card, chat prompt or phone push)
- **block:** it never runs, and the agent is told why

Every step is logged, with secrets withheld. No dependencies; Node 20+.

```js
import { createGuard } from 'pg1-guard';

const guard = createGuard({
  policy: { money: { max_per_call: 50, max_per_day: 200 } },
  approve: async (action) => askOnPhone(action)      // resolve true to run it
});

const tools = guard.wrapAll({ web_search, send_payment, http_post });
await tools.send_payment({ to: 'IE29…', amount: 40 });  // waits for approve(), then runs
```

## What it checks

| Rule | What it does | Default |
| --- | --- | --- |
| Tools | Block, ask or allow by tool name (`*` wildcards) | blocks `*drop_database*`, `*delete_account*`; asks for email, posting, deploys, merges, deletes |
| Money | Tools that move money always wait for a person; over a limit they are blocked | ask every time; 100 per call, 250 a day |
| Network | Every URL in the arguments: https only, no private or internal addresses, allow and block lists | on |
| Secrets | Keys, tokens, private keys or seed phrases in the arguments are blocked | on |
| Rate | Calls per tool per minute | 30 |

Order: any block reason wins, then any ask reason, then an explicit allow, then the policy's `default`. The default policy is in `default-policy.json`; pass only what you change.

**Fail closed.** No approver set means nothing that needs approval runs. An approver that throws counts as no.

## PG1 checks

Pass a `pg1-sdk` client and money or install actions also get PG1's preflight check first. A flagged or unknown result, or one whose signature does not verify, turns the call into an approval, never an automatic yes.

```js
import { PG1Client } from 'pg1-sdk';
const guard = createGuard({ pg1: new PG1Client(), approve });
```

## Frameworks

```js
import { guardVercelAiTools, guardDispatcher, guardLangchainTools } from 'pg1-guard/frameworks';
```

A blocked call comes back to the model as `{ blocked: true, reasons }` instead of throwing, so the agent can explain or try another way.

## MCP server

Any MCP client can ask the guard before acting:

```
PG1_GUARD_POLICY=./policy.json PG1_GUARD_LOG=./actions.jsonl npx pg1-guard-mcp
```

Tools: `check_action { tool, args }` → `allow | ask | block` with reasons, and `recent_actions { limit }`.

## Log

`guard.log.entries()` and `guard.log.replay(actionId)`: proposed, PG1 check, decided, approved or declined, ran or failed. Pass `createLog({ sink: jsonlSink('./actions.jsonl') })` to keep it on disk.

Example: `node sdk/guard/examples/basic.mjs`.

Status: first version (week 1 of the plan), **not published**.
Licence: Apache-2.0 (sdk/LICENSE).
