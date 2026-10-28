# Buying from the Oracle API with x402

The client signs an EIP-3009 `transferWithAuthorization` for the exact amount in the 402 response, and the facilitator settles it on Base. Your wallet should show you the amount and the `payTo` before you approve the payment.

Typical amounts:

- `/quote`: 0.002 USDC
- `/proof`: 0.05 USDC

The authorization is valid for 60 seconds (`validBefore`). If it expires, request a new 402 and sign again. Keep your normal spending limits; the API never needs more than 0.05 USDC per call.

Docs: https://oracle.truthfeed.network/docs · Agent card: https://oracle.truthfeed.network/.well-known/agent-card.json
