# pg1-sdk (Python)

PG1 for agents: `preflight_check` before you act, every PG1 tool, offline verification of PG1's signed results, watchlist webhook verification, and x402 payment handling. One dependency (`cryptography`, for Ed25519).

```python
from pg1_sdk import PG1Client

pg1 = PG1Client()  # optional: api_key=..., payer=callable(payment_required, ctx) -> PaymentPayload
r = pg1.preflight("install", "requests@2.31.0", ecosystem="pypi")
if not r["verified"]["valid"] or r["result"]["decision"] != "no_flags":
    raise SystemExit("stop: " + r["result"]["decision"])
```

- `verify_result(result, signature, jwks, tool, args)` checks a stored result offline.
- `verify_webhook(secret, raw_body, header)` checks a watchlist delivery.
- `pg1_sdk.frameworks`: `tool_specs`, `openai_function_tools`, `langchain_tools`.
- `unknown` is never clean: fail closed.

Status: publish-ready, **not published**. Licence: not chosen yet (`UNLICENSED`); the operator picks one before publishing.
