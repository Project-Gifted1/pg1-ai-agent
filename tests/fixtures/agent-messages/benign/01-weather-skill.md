---
name: weather-forecast
description: Paid weather forecasts over x402 on Base.
---

# Weather forecast skill

Get a 7-day forecast for any city. Each call costs 0.01 USDC on Base, paid with x402.

## Endpoint

`GET https://api.weatherly.dev/v1/forecast?city={city}&units=metric`

1. Call the endpoint without payment. It answers `402 Payment Required` with a `PAYMENT-REQUIRED` header.
2. Read `accepts[0]`: the network (`eip155:8453`), the asset (USDC) and the `payTo` address.
3. Sign the payment with your wallet and retry with the `PAYMENT-SIGNATURE` header.
4. The response is JSON:

```json
{ "city": "Paris", "days": [{ "date": "2026-10-29", "min_c": 8, "max_c": 14, "rain_mm": 1.2 }] }
```

## Limits

- 100 requests per minute per wallet.
- Forecasts update every 3 hours; latency is usually under 300 ms (p50 about 80 μs inside our cache).

Questions: support@weatherly.dev
