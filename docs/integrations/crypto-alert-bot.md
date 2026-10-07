# Example: a Telegram alert bot that screens wallets with PG1

This is a worked example for developers. It shows a Telegram alert bot, written in Node with axios, that screens the wallet named in each DEX signal with two of PG1's free checks before it posts an alert:

- `check_wallet_sanctions`: is the address on the sanctions list?
- `check_wallet_age`: when did the address first show up on a given chain?

The same pattern fits any bot or agent that acts on a wallet address. Every endpoint, field, status value, reason code and limit below is taken from PG1's code, and PG1's test suite fails if any of them stops existing.

**Base URL:** `https://pg1-ai-agent.vercel.app`

| What | Where |
|---|---|
| A2A JSON-RPC endpoint (use this one) | `POST https://pg1-ai-agent.vercel.app/api/a2a` |
| Agent card | `GET https://pg1-ai-agent.vercel.app/.well-known/agent-card.json` |
| Playground endpoint (plain JSON, see [REST](#8-rest-the-playground-endpoint)) | `POST https://pg1-ai-agent.vercel.app/api/playground` |

Neither check needs a key or a payment.

---

## 1. The A2A request

Both checks use the same JSON-RPC 2.0 envelope. The method is `message/send`. `SendMessage` is accepted as an alias. `params.message.parts` must contain one data part that carries `skill` and `arguments`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "messageId": "any-unique-id",
      "parts": [
        {
          "kind": "data",
          "data": {
            "skill": "check_wallet_age",
            "arguments": { "address": "0x7067312d746573742d6669787475726500000002", "chain": "ethereum" }
          }
        }
      ]
    }
  }
}
```

Send `Content-Type: application/json`. Without an `A2A-Version` header the server answers in the 0.3 shape shown in this guide (`"kind": "data"` parts, task state `"completed"`). Sending `A2A-Version: 1.0` changes the shape: parts lose `kind` and the state becomes `TASK_STATE_COMPLETED`. The bot below leaves the header off.

### Where the result is

A successful call returns HTTP 200 with a task. The check's result is the `data` of the first part of the first artifact:

```
response.data.result.artifacts[0].parts[0].data
```

The same object appears again in `result.history` (the agent message). One copy is enough.

A failed call returns an `error` object instead of a `result`. Section 4 covers how the bot handles it.

---

## 2. `check_wallet_sanctions`

### Arguments

| Argument | Required | Notes |
|---|---|---|
| `address` | yes | The wallet address. EVM `0x` addresses and the other formats the tool recognises are accepted. A malformed address returns the error code `invalid_address`. It never returns `listed: false` for bad input. |
| `currency` | no | Narrows the match, e.g. `"ETH"`. The bot leaves it out. |

### Response (`artifacts[0].parts[0].data`)

Here is a live `listed: false` answer, using the CLEAN test address from [Testing](#9-testing-without-touching-live-data). A test address also returns `test_fixture: true` and `checks[].source` `"fixture"`. The `source` and `message` values name the list's publisher, so they are shortened to `…` here. The bot never forwards them to Telegram:

```json
{
  "address": "0x7067312d746573742d6669787475726500000002",
  "address_normalized": "0x7067312d746573742d6669787475726500000002",
  "source": "…",
  "list_last_synced": "2026-01-01T00:00:00.000Z",
  "listed": false,
  "matches": [],
  "message": "Not on the … sanctions list as of 2026-01-01T00:00:00.000Z.",
  "disclaimer": "Informational only; not legal or sanctions-compliance advice.",
  "reasons": [],
  "status": "no_flags",
  "checks": [
    { "source": "sanctions list", "result": "ok", "checked_at": "2026-10-03T14:17:11.316Z", "data_as_of": "2026-01-01T00:00:00.000Z" }
  ],
  "request_id": "5fb71493-4615-45c4-9a2a-02646377cd8e"
}
```

When the address is on the list, `listed` is `true`, `status` is `"flagged"`, and `reasons` holds `{ "code": "WALLET_SANCTIONED", "message": "Address matches an entry on the sanctions list." }`. Each entry in `matches` has `sdn_name`, `currency`, `programs` and `sdn_uid`. The listed response has no `message` field.

| Field | Meaning |
|---|---|
| `listed` | `true` if the address is on the list, otherwise `false`. |
| `matches` | The matching list entries. Empty when `listed` is `false`. |
| `list_last_synced` | When the list was last refreshed. |
| `disclaimer` | Always `"Informational only; not legal or sanctions-compliance advice."` |
| `status` | `"flagged"`, `"no_flags"` or `"unknown"`. The bot decides from this field. |
| `reasons` | `[{ code, message }]`. The only code this check uses is `WALLET_SANCTIONED`. |
| `checks` | `[{ source, result, checked_at, data_as_of }]`. `result` is `"ok"` when the lookup completed. |
| `request_id` | A UUID for this call. Log it next to any failure. |

### axios example

```js
const axios = require('axios');
const crypto = require('node:crypto');

async function checkWalletSanctions(address) {
  const res = await axios.post('https://pg1-ai-agent.vercel.app/api/a2a', {
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        messageId: crypto.randomUUID(),
        parts: [{ kind: 'data', data: { skill: 'check_wallet_sanctions', arguments: { address } } }]
      }
    }
  }, { timeout: 15000, validateStatus: () => true });

  if (res.data && res.data.error) return { error: res.data.error, httpStatus: res.status };
  return res.data.result.artifacts[0].parts[0].data; // { listed, status, reasons, ... }
}

checkWalletSanctions('0x7067312d746573742d6669787475726500000002').then((r) => console.log(r.status, r.listed));
// -> no_flags false
```

---

## 3. `check_wallet_age`

### Arguments

| Argument | Required | Notes |
|---|---|---|
| `address` | yes | An EVM address: `0x` followed by exactly 40 hex characters, in any case. Any other format returns the error code `invalid_address`. |
| `chain` | no | One of the values below. Defaults to `base` when left out. Any other value returns the error code `invalid_chain`. |

**Allowed `chain` values:** `base`, `ethereum`, `arbitrum`, `optimism`, `polygon`, `bsc`.

Age is reported per chain, so send the chain the signal came from. If a signal's chain is not on this list, the bot cannot check wallet age for it. That wallet counts as not verified (section 4). The bot does not send it with some other chain.

### Response (`artifacts[0].parts[0].data`)

Here is a live `found: true` answer, using the CLEAN test address with `"chain": "ethereum"`. A test address also returns `test_fixture: true` and `checks[].source` `"fixture"`:

```json
{
  "address": "0x7067312d746573742d6669787475726500000002",
  "chain": "ethereum",
  "found": true,
  "first_seen": "2023-09-01T00:00:00.000Z",
  "age_days": 1128,
  "first_seen_block": 1000000,
  "first_direction": "in",
  "is_contract": false,
  "delegated": false,
  "delegate_address": null,
  "note": null,
  "source": "on-chain transfer history",
  "cached": false,
  "reasons": [],
  "status": "no_flags",
  "checks": [
    { "source": "on-chain transfer history", "result": "ok", "checked_at": "2026-10-03T14:17:11.318Z", "data_as_of": null },
    { "source": "on-chain code", "result": "ok", "checked_at": "2026-10-03T14:17:11.318Z", "data_as_of": null }
  ],
  "request_id": "0c0e4b8e-6a5d-4c55-9a43-2f1d4f7b9e10"
}
```

| Field | Meaning |
|---|---|
| `found` | `true` if the address has transfer history on this chain. |
| `first_seen` | ISO timestamp of the earliest transfer in or out. `null` when `found` is `false`. |
| `age_days` | Whole days since `first_seen`, rounded down. `null` when `found` is `false`. |
| `first_seen_block`, `first_direction` | The block of that first transfer, and whether it was `"in"` or `"out"`. |
| `is_contract` | `true` if the address has code. |
| `delegated`, `delegate_address` | EIP-7702 delegation. `delegated` is `true` or `false`, or `null` when the code check did not complete. `delegate_address` is set only when `delegated` is `true`. |
| `cached` | `true` if PG1 answered from its own cache. |
| `status`, `reasons`, `checks`, `request_id` | Same meaning as for sanctions. |

Reason codes this check can return:

| Code | Effect on `status` | Meaning |
|---|---|---|
| `WALLET_NO_HISTORY` | `"flagged"` | No transfer history on this chain (`found: false`). This is the normal result for a brand-new or never-used address. |
| `WALLET_AGE_PARTIAL` | `"unknown"` | Internal transfers were not checked in time. The wallet may be older than `age_days` shows. |
| `WALLET_DELEGATED` | none (informational) | An EIP-7702 delegation is currently set. On its own it does not change `status`. |

On the PG1 side, a found answer is cached permanently and a `found: false` answer is cached for 10 minutes. The delegation check runs live on every call.

### There is no age threshold in PG1

`check_wallet_age` has no age threshold anywhere in the code. It reports `first_seen` and `age_days`, and the caller decides what "new" means. The bot below sets its own rule, "newer than 7 days", as `age_days < 7`:

```js
const newWalletDays = 7; // the bot's own choice; PG1 has no threshold

function isNewerThan7Days(age) {
  return age.found === true && typeof age.age_days === 'number' && age.age_days < newWalletDays;
}
```

The bot applies this rule only when the age check returned `status: "no_flags"`. An `"unknown"` age may be too low (`WALLET_AGE_PARTIAL`), so it is not used for this decision.

### axios example

```js
const axios = require('axios');
const crypto = require('node:crypto');

async function checkWalletAge(address, chain = 'base') {
  const res = await axios.post('https://pg1-ai-agent.vercel.app/api/a2a', {
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        messageId: crypto.randomUUID(),
        parts: [{ kind: 'data', data: { skill: 'check_wallet_age', arguments: { address, chain } } }]
      }
    }
  }, { timeout: 15000, validateStatus: () => true });

  if (res.data && res.data.error) return { error: res.data.error, httpStatus: res.status };
  return res.data.result.artifacts[0].parts[0].data; // { found, first_seen, age_days, status, ... }
}

checkWalletAge('0x7067312d746573742d6669787475726500000002', 'ethereum').then((r) => console.log(r.status, r.age_days));
// -> no_flags 1128   (the number grows by one each day)
```

---

## 4. Handling rules

The bot decides from `status`. It never reads `listed` or `found` alone.

| What came back | Bot action |
|---|---|
| Either check has `status: "flagged"` | **Drop.** Post no alert. This includes `WALLET_SANCTIONED` and `WALLET_NO_HISTORY`. |
| Either check has `status: "unknown"`, returns an `error`, times out, hits a rate limit, returns a non-2xx response, or can't run (unsupported chain) | **Not verified.** Hold the alert, or post it with a "NOT VERIFIED" label. Never post it as screened. |
| Both checks have `status: "no_flags"` | **Allowed.** Post the alert with the caveat: *"No flags means nothing was found in the sources checked. It is not an endorsement or guarantee of safety."* |

`no_flags` means the sources PG1 checked found nothing. It is never "safe" or "clean", and the alert must not say it is.

### What a failure looks like

Failures from `/api/a2a` come back as a JSON-RPC `error`, not a `result`:

| Situation | HTTP | `error.code` | `error.data.code` | `error.data.status` |
|---|---|---|---|---|
| Wallet-age lookup failed or timed out (5 s upstream timeout, one retry within a 12 s budget) | 200 | `-32000` | `upstream_unavailable` | `"unknown"` |
| Wallet-age or sanctions rate limit reached | 200 | `-32000` | `rate_limited` | `"unknown"` |
| Bad address or chain | 200 | `-32000` | `invalid_address` / `invalid_chain` | `"unknown"` |
| Sanctions list unreachable | 503 | `-32010` | (none) | (none) |
| Malformed request | 400 | `-32602` | (none) | (none) |

Every error has `error.data.request_id`, and the same id is in the `X-Request-Id` response header. This is the real wallet-age timeout response (the UNKNOWN test address):

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32000,
    "message": "Wallet age lookup timed out after 5000ms.",
    "data": {
      "code": "upstream_unavailable",
      "reasons": [],
      "status": "unknown",
      "checks": [{ "source": "on-chain transfer history", "result": "timeout", "checked_at": "2026-10-03T14:17:14.570Z", "data_as_of": null }],
      "request_id": "4af5e569-d6ac-4b67-ac7c-3ac33f6b976d"
    }
  },
  "id": 1
}
```

A wallet-age outage is always an `error`, never `found: false`. So an outage can't make a wallet look brand new, and it can't make one look established either.

---

## 5. Rate limits, caching and backoff

### Limits without a key

| Endpoint | Check | Limit without a key |
|---|---|---|
| `/api/a2a` | `check_wallet_age` | **60 calls/hour per caller** (per IP, fixed one-hour window). Calls that PG1 answers from its cache count too. |
| `/api/a2a` | `check_wallet_sanctions` | **120 calls/hour per caller** (per IP, fixed one-hour window). |
| `/api/playground` | each check | 60 calls/hour per check per visitor, plus a shared cap of 2000 calls/day across all visitors. |

The counters are kept in memory on each server instance. Plan around 60/hour for wallet age and 120/hour for sanctions as your budget, but don't assume you'll be cut off at exactly those numbers. A valid PG1 license key sent in the `X-API-KEY` header removes both `/api/a2a` limits. The bot doesn't need one.

Each new wallet costs one `check_wallet_age` call and one `check_wallet_sanctions` call. With the bot's cache, that is up to about 60 new wallets an hour; the wallet age limit runs out first.

### How each endpoint reports a rate limit

- **`/api/a2a`** reports the limit inside the response: HTTP 200, `error.code` `-32000`, `error.data.code` `"rate_limited"`. The message reads `"check_wallet_age is limited to 60 calls/hour per caller. Retry in about N minute(s)."` (or `"check_wallet_sanctions is limited to 120 calls/hour per caller. Retry in about N minute(s)."`). There is no `Retry-After` header on this path. The bot reads N from the message, and waits 60 minutes if it can't.
- **`/api/playground`** returns a real **HTTP 429** with a `Retry-After` header in seconds and `error.retry_after_seconds` in the body.

The bot handles both cases. Any HTTP 429 pauses that check until `Retry-After` has passed, and an A2A `rate_limited` error does the same. While a check is paused, wallets that arrive count as **not verified**. The bot never treats a skipped call as a pass.

### Per-wallet cache (bot side, 1 hour)

The bot keeps its own in-memory cache for one hour (its own choice), keyed by `chain:address`. It stores only completed answers (`"flagged"` and `"no_flags"`). It never caches a not-verified answer, so the next signal for that wallet retries the checks.

---

## 6. Complete bot module

`screen.js`, CommonJS, needs only `axios`:

```js
'use strict';
const axios = require('axios');
const crypto = require('node:crypto');

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');

const pg1 = axios.create({
  baseURL: 'https://pg1-ai-agent.vercel.app',
  timeout: 15000,                 // the bot's own budget; a timeout = not verified
  validateStatus: () => true      // inspect every status ourselves
});

// PG1's own enum for check_wallet_age's chain argument.
const supportedChains = ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'bsc'];

const cacheTtlMs = 60 * 60 * 1000;   // bot's choice: 1 hour
const newWalletDays = 7;             // bot's choice: PG1 has no age threshold
const unverifiedMode = 'label';      // 'label' = post with a NOT VERIFIED label, 'hold' = don't post

const cache = new Map();             // `${chain}:${address}` -> { at, verdict }
const pausedUntil = new Map();       // skill -> epoch ms

function unverified(why, requestId) {
  return { status: 'unverified', why, requestId };
}

async function callSkill(skill, args) {
  if (Date.now() < (pausedUntil.get(skill) || 0)) return unverified('rate limited (backing off)');

  let res;
  try {
    res = await pg1.post('/api/a2a', {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'data', data: { skill, arguments: args } }] } }
    });
  } catch (err) {
    // Never log err.config: on the Telegram call it carries the bot token in the URL.
    return unverified(err.code === 'ECONNABORTED' ? 'timeout' : 'network error');
  }

  if (res.status === 429) {
    const seconds = Number(res.headers['retry-after']) || 60;
    pausedUntil.set(skill, Date.now() + seconds * 1000);
    return unverified('rate limited');
  }

  const body = res.data || {};
  if (body.error) {
    const data = body.error.data || {};
    if (data.code === 'rate_limited') {
      const m = /Retry in about (\d+) minute/.exec(body.error.message || '');
      pausedUntil.set(skill, Date.now() + (m ? Number(m[1]) : 60) * 60 * 1000);
    }
    return unverified(data.code || `error ${body.error.code} (HTTP ${res.status})`, data.request_id);
  }

  const artifact = body.result && Array.isArray(body.result.artifacts) ? body.result.artifacts[0] : null;
  const part = artifact && Array.isArray(artifact.parts) ? artifact.parts.find((p) => p && p.data) : null;
  if (res.status !== 200 || !part) return unverified(`unexpected response (HTTP ${res.status})`);

  const result = part.data;
  if (result.status === 'flagged' || result.status === 'no_flags') return { status: result.status, result };
  return unverified(`status ${result.status}`, result.request_id); // "unknown", or anything new
}

async function screenWallet(address, chain) {
  const chainName = String(chain || '').toLowerCase();
  const key = `${chainName}:${String(address).toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cacheTtlMs) return hit.verdict;

  const [sanctions, age] = await Promise.all([
    callSkill('check_wallet_sanctions', { address }),
    supportedChains.includes(chainName)
      ? callSkill('check_wallet_age', { address, chain: chainName })
      : Promise.resolve(unverified(`chain "${chain}" not supported for wallet age`))
  ]);

  let verdict;
  if (sanctions.status === 'flagged' || age.status === 'flagged') {
    verdict = { action: 'drop', sanctions, age };
  } else if (sanctions.status === 'no_flags' && age.status === 'no_flags') {
    const a = age.result;
    verdict = { action: 'allow', sanctions, age, isNew: a.found === true && typeof a.age_days === 'number' && a.age_days < newWalletDays };
  } else {
    verdict = { action: 'unverified', sanctions, age };
  }

  if (verdict.action !== 'unverified') cache.set(key, { at: Date.now(), verdict });
  return verdict;
}

function reasonCodes(check) {
  return check.result ? check.result.reasons.map((r) => r.code).join(', ') : '';
}

function alertText(signal, v) {
  const lines = [signal.summary, `Wallet: ${signal.address}`, `Chain: ${signal.chain}`];
  if (v.action === 'allow') {
    const a = v.age.result;
    lines.push(`Sanctions list: not listed (as of ${v.sanctions.result.list_last_synced})`);
    lines.push(`First seen: ${a.first_seen.slice(0, 10)} (${a.age_days} days)${v.isNew ? ' - NEW: under 7 days' : ''}`);
    if (a.delegated === true) lines.push(`EIP-7702 delegation set to ${a.delegate_address}`);
    lines.push('', 'PG1 screening: no flags. No flags means nothing was found in the sources checked. It is not an endorsement or guarantee of safety.');
  } else {
    lines.push('', 'NOT VERIFIED: PG1 screening could not complete. Treat this wallet as unverified, not as safe.');
    for (const [name, c] of [['Sanctions', v.sanctions], ['Wallet age', v.age]]) {
      if (c.status === 'unverified') lines.push(`${name}: ${c.why}${c.requestId ? ` (request_id ${c.requestId})` : ''}`);
    }
  }
  return lines.join('\n');
}

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text }, { timeout: 15000 });
}

// Call this from wherever the bot receives a DEX signal.
async function onSignal(signal) {           // { address, chain, summary }
  const v = await screenWallet(signal.address, signal.chain);
  if (v.action === 'drop') {
    console.log(`dropped ${signal.address}: ${reasonCodes(v.sanctions) || reasonCodes(v.age)}`);
    return;
  }
  if (v.action === 'unverified' && unverifiedMode === 'hold') {
    console.log(`held ${signal.address}: not verified`);
    return;
  }
  await sendTelegram(alertText(signal, v));
}

module.exports = { onSignal, screenWallet };
```

Notes:

- The bot maps its DEX feed's chain names to PG1's (for example, if your feed says `eth`, send `ethereum`). An unsupported chain is never swapped for another one.
- `found: false` comes back as `status: "flagged"` with `WALLET_NO_HISTORY`, so a wallet with no history on that chain is dropped under these rules. To post those wallets with a warning instead, check for that reason code before dropping. That would be a change to the rules in this guide.
- `WALLET_DELEGATED` doesn't change `status`. The alert mentions the delegation and leaves the call to the reader.

---

## 7. Secrets: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`

- Read both values from the environment only: a `.env` file loaded at startup, or the host's secret settings.
- **Never commit them.** Add `.env` to `.gitignore` before the first commit, and commit a `.env.example` with empty values:

  ```
  TELEGRAM_BOT_TOKEN=
  TELEGRAM_CHAT_ID=
  ```

- Never log the token. Telegram's API URL contains it, so don't log full axios errors or `err.config` from the Telegram call.
- If the token ever lands in git history, revoke it and issue a new one. Deleting the commit is not enough.

PG1 itself needs no secret for these checks.

---

## 8. REST: the playground endpoint

PG1 has no dedicated REST API for these two checks. The closest thing is `POST https://pg1-ai-agent.vercel.app/api/playground`, which powers the public playground page. It runs the same check handlers and returns a display card rather than the raw result, so **use `/api/a2a` for the bot**. The playground endpoint is documented here because it is the only route that returns HTTP 429 with `Retry-After`.

Request body, exactly these keys and nothing else: `tool`, `input`, and optionally `chain` (only for `check_wallet_age`; the same allowed values, default `base`).

```json
{ "tool": "check_wallet_age", "input": "0x7067312d746573742d6669787475726500000002", "chain": "base" }
```

Response (HTTP 200):

```json
{
  "ok": true,
  "card": {
    "tool": "check_wallet_age",
    "title": "Wallet age",
    "subject": "0x7067312d746573742d6669787475726500000002",
    "subject_short": "0x7067…0002",
    "subject_kind": "address",
    "status": "no_flags",
    "status_label": "No flags",
    "note": "No flags means nothing was found in the sources checked. It is not an endorsement or guarantee of safety.",
    "error": null,
    "fields": [
      { "label": "Chain", "value": "base" },
      { "label": "Found", "value": "yes" },
      { "label": "First seen", "value": "2023-09-01" },
      { "label": "Age", "value": "1128 days" },
      { "label": "First direction", "value": "in" },
      { "label": "Contract", "value": "no" },
      { "label": "Delegated", "value": "no" }
    ],
    "reasons": [],
    "checks": [
      { "source": "on-chain transfer history", "result": "ok", "data_as_of": null },
      { "source": "on-chain code", "result": "ok", "data_as_of": null }
    ],
    "request_id": "16759d8d-fe24-4355-8745-5cecf4ea25e6",
    "ms": 412
  }
}
```

The card's `status` can also be `"failed"` when the check didn't run. `card.error` then holds `{ code, message }`. As with A2A, treat `"unknown"` and `"failed"` as not verified. `fields` are display strings (`"1128 days"`), not numbers, which is another reason to use A2A.

Errors: 400 with `error.code` `invalid_input` or `not_available`; 429 with `error.code` `rate_limited`, `error.retry_after_seconds` and a `Retry-After` header; 500 with `error.code` `unavailable`.

```js
const axios = require('axios');

async function playgroundCheck(tool, input, chain) {
  const body = chain ? { tool, input, chain } : { tool, input };
  const res = await axios.post('https://pg1-ai-agent.vercel.app/api/playground', body, { timeout: 15000, validateStatus: () => true });
  if (res.status === 429) return { retryAfterSeconds: Number(res.headers['retry-after']) || res.data.error.retry_after_seconds };
  if (!res.data.ok) return { error: res.data.error };
  return res.data.card; // { status, note, fields, reasons, checks, request_id }
}

playgroundCheck('check_wallet_sanctions', '0x7067312d746573742d6669787475726500000002').then((c) => console.log(c.status));
playgroundCheck('check_wallet_age', '0x7067312d746573742d6669787475726500000002', 'base').then((c) => console.log(c.status));
```

---

## 9. Testing without touching live data

PG1 answers fixed test addresses with fixed responses. They cost nothing, don't count against either rate limit, and look like real responses plus `test_fixture: true`. Each fixture's `checks[].source` is `"fixture"`. Every path in section 4 can be tested with them:

| Address | `check_wallet_sanctions` | `check_wallet_age` | Bot action |
|---|---|---|---|
| `0x7067312d746573742d6669787475726500000001` | `listed: true`, `"flagged"`, `WALLET_SANCTIONED` | `found: false`, `"flagged"`, `WALLET_NO_HISTORY` | drop |
| `0x7067312d746573742d6669787475726500000002` | `listed: false`, `"no_flags"` | `found: true`, `first_seen` 2023-09-01, `"no_flags"` | allow, with caveat |
| `0x7067312d746573742d6669787475726500000003` | HTTP 503, error `-32010` | error `-32000`, `upstream_unavailable`, `"unknown"` | not verified |
| `0x7067312d746573742d6669787475726500000004` | (real lookup) | `delegated: true`, `WALLET_DELEGATED`, `"no_flags"` | depends on the sanctions answer |

The `chain` argument works with these addresses and is echoed back. An unsupported chain still returns `invalid_chain`. Fixtures can't exercise the "newer than 7 days" rule, because the CLEAN fixture's `first_seen` is fixed in 2023. Test that rule by passing a result object with a small `age_days` to your own code.
