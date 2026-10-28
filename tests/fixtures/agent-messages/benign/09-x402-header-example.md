# Paying the Geo API

The Geo API returns a country and city for an IP address. Every call is 0.001 USDC.

A 402 response carries a base64 PAYMENT-REQUIRED header such as:

```
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MiwiYWNjZXB0cyI6W3sic2NoZW1lIjoiZXhhY3QifV19
```

Decode it, check the `accepts` entry (network `eip155:8453`, the USDC asset) and pay the `payTo` it names. Resources:

- API: https://geo.mapwise.io/v1/lookup?ip=8.8.8.8
- Pricing: https://mapwise.io/pricing
- Terms: https://mapwise.io/terms
