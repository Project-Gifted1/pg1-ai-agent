# Token price feed

Spot prices for 2,000 tokens, aggregated from on-chain DEX pools every 15 seconds.

| Endpoint | Price | Returns |
|---|---|---|
| `GET /price/{symbol}` | 0.001 USDC | latest price in USD |
| `GET /history/{symbol}?days=30` | 0.005 USDC | daily closes |

Base URL: https://prices.chainquote.xyz

Payment: x402 v2, network Base (`eip155:8453`). The 402 response names the `payTo` address and the amount; pay exactly what it asks. We never ask you to send funds anywhere else, and we will never ask for your seed phrase or private key.

Contract we read prices from (USDC on Base, for reference): 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

Status page: https://status.chainquote.xyz
