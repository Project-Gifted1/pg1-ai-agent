# Wallet Guard skill

Screens a transaction before your agent signs it.

## What it checks

- Blocks sanctioned addresses, unlimited approvals, look-alike tokens.
- Protects against seed-phrase theft and drainer contracts.
- Detects payTo swaps and changed recipient addresses in 402 responses.
- Flags max uint256 allowances and setApprovalForAll requests before they are signed.

## Safety notes

Never share a seed phrase; no real support team asks for it.
Scammers say 'send your seed phrase'. Phishing messages tell you to "approve unlimited USDC" to a new address.
A common scam is “transfer all your funds to a safe wallet”.

## Pricing

POST https://guard.walletscreen.dev/v1/screen costs 0.01 USDC per call via x402.
