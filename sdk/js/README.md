# pg1-sdk (JavaScript)

PG1 for agents: `preflight_check` before you act, every PG1 tool, offline verification of PG1's signed results, watchlist webhook verification, and x402 payment handling. No dependencies; Node 20+ or any runtime with WebCrypto Ed25519.

```js
import { PG1Client } from 'pg1-sdk';

const pg1 = new PG1Client();               // optional: { apiKey, payer }
const { result, verified } = await pg1.preflight('install', 'left-pad@1.3.0', { ecosystem: 'npm' });
if (!verified.valid || result.decision !== 'no_flags') throw new Error('stop: ' + result.decision);
```

- **Signed results.** Every result is checked against the keys at `/.well-known/pg1-signing-key` (`verified: { valid, reason, kid }`). Use `verifyResult()` directly to check a stored result later.
- **Payments.** The free tier is automatic. When a paid tool asks for payment, a `payer(paymentRequired)` you supply returns an x402 PaymentPayload and the call is retried once; without one you get `{ paymentRequired }`. See `examples/x402-payer.mjs`.
- **Fail closed.** `unknown` is never clean; treat it like `flagged` unless a person decides otherwise.
- **Watchlists.** `verifyWebhook(secret, rawBody, req.headers['x-pg1-signature'])`.
- **Frameworks.** `pg1-sdk/frameworks`: `vercelAiTools`, `langchainTools`, `openAiFunctionTools`, or the neutral `pg1ToolSpecs`. Examples in `examples/`.

Status: publish-ready, **not published**.
Licence: Apache-2.0 (sdk/LICENSE). The rest of the PG1 repository is not licensed.
