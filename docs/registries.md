# Registries for PG1 1.20.0 (report only: nothing submitted)

| Registry | What | State | To submit |
|---|---|---|---|
| Official MCP Registry | `server.json` (`io.github.Project-Gifted1/pg1-threat-intel`, 1.20.0) | Listed at an earlier version; 1.20.0 is not published | After merge and the production deploy: Actions, "Publish MCP Server" (`.github/workflows/publish-mcp.yml`), Run workflow on `main`. It logs in with GitHub OIDC and runs `mcp-publisher publish` |
| Smithery | `@gikewun/pg1-threat-intel`, a URL listing of `/api/mcp` (no config file in the repo) | Listed; Smithery scans the live tools/list | After the deploy: `npx @smithery/cli mcp publish "https://pg1-ai-agent.vercel.app/api/mcp" -n @gikewun/pg1-threat-intel`, or republish from the server's page on smithery.ai, so it rescans 20 tools |
| Glama | the MCP server | Listed; re-reads tools/list | Nothing, or "refresh" in its dashboard |
| npm | `sdk/js` as `pg1-sdk` 0.1.0 | Publish-ready, not published; name availability not checked | `cd sdk/js && npm publish --access public` (Apache-2.0; prepack copies sdk/LICENSE in) |
| PyPI | `sdk/python` as `pg1-sdk` 0.1.0 | Publish-ready, not published; name availability not checked | `cd sdk/python && cp ../LICENSE . && python -m build && twine upload dist/* && rm LICENSE` (Apache-2.0; the licence file lives once, in sdk/) |
| A2A agent directories | `/.well-known/agent-card.json` (new skills: preflight_check, check_x402_endpoint, check_agent_card, verify_result) | Served on deploy | Re-submit where PG1 is listed (docs/a2a-discovery.md) |
| x402 Bazaar / discovery | `/api/preflight` and `/api/watchlists` answer 402 with PAYMENT-REQUIRED | Discoverable on deploy | Nothing: crawlers list paid resources from the 402 |

## Signing key: env secret now, KMS later

Recommendation: **an env secret (`PG1_SIGNING_KEY`, marked Sensitive in Vercel) now**. Signing runs in process (microseconds, no extra network hop, no per-signature cost) and rotation is built in (`PG1_SIGNING_PREVIOUS_JWKS`). Move to a KMS (Vercel KMS, or a cloud KMS) when the key's value justifies a non-exportable key: the trade is a network call per signature (latency on every result, a new failure mode that must not block answers) and cost. Not verified: whether Vercel KMS offers Ed25519 signing keys; `lib/signing.mjs` would need a remote-signer adapter for it.
