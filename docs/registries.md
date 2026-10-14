# Registries for PG1 1.18.0 (report only: nothing submitted)

| Registry | What | State | To submit |
|---|---|---|---|
| Official MCP Registry | `server.json` (`io.github.Project-Gifted1/pg1-threat-intel`, 1.18.0, new description) | Already listed at 1.17.0; the new version is not published | `mcp-publisher publish` from the repo root after merge (GitHub OIDC login) |
| Smithery, Glama | the MCP server | Listed; they re-read tools/list | Nothing, or "refresh" in their dashboards |
| npm | `sdk/js` as `pg1-sdk` 0.1.0 | Publish-ready, not published; name availability not checked | Pick a licence, then `cd sdk/js && npm publish --access public` |
| PyPI | `sdk/python` as `pg1-sdk` 0.1.0 | Publish-ready, not published; name availability not checked | Pick a licence, then `python -m build && twine upload dist/*` |
| A2A agent directories | `/.well-known/agent-card.json` (new skills: preflight_check, check_x402_endpoint, check_agent_card, verify_result) | Served on deploy | Re-submit where PG1 is listed (docs/a2a-discovery.md) |
| x402 Bazaar / discovery | `/api/preflight` and `/api/watchlists` answer 402 with PAYMENT-REQUIRED | Discoverable on deploy | Nothing: crawlers list paid resources from the 402 |

## Signing key: env secret now, KMS later

Recommendation: **an env secret (`PG1_SIGNING_KEY`, marked Sensitive in Vercel) now**. Signing runs in process (microseconds, no extra network hop, no per-signature cost) and rotation is built in (`PG1_SIGNING_PREVIOUS_JWKS`). Move to a KMS (Vercel KMS, or a cloud KMS) when the key's value justifies a non-exportable key: the trade is a network call per signature (latency on every result, a new failure mode that must not block answers) and cost. Not verified: whether Vercel KMS offers Ed25519 signing keys; `lib/signing.mjs` would need a remote-signer adapter for it.
