// x402 pay-per-call settings for /api/ioc and the paid MCP tools, and the
// anonymous rate limits of the always-free MCP tools. The x402 handlers in
// api/chat.mjs and api/mcp.mjs and the rate limiters in api/mcp.mjs read
// these values, and so does the chat's licence-key answer
// (lib/secretGuard.mjs licenceKeyDirective), so what PG1 says about pricing
// and limits is always what the code actually enforces.

import { x402Version } from '@x402/core';
import { getDefaultAsset } from '@x402/evm';

export const X402_SCHEME = 'exact';
export const X402_PRICE = '$0.01';
export const X402_NETWORK = 'eip155:8453';
// The protocol version the x402 libraries speak.
export const X402_VERSION = x402Version;
// A money price ("$0.01") is settled in the network's default asset, as the
// exact EVM scheme resolves it.
export const X402_ASSET_SYMBOL = getDefaultAsset(X402_NETWORK).symbol;

const NETWORK_NAMES = Object.freeze({ 'eip155:8453': 'Base', 'eip155:84532': 'Base Sepolia' });
export const X402_NETWORK_NAME = NETWORK_NAMES[X402_NETWORK] || X402_NETWORK;

// "$0.01" as "0.01 USD": text that reaches a chat reply never carries "$"
// followed by digits.
export function x402PriceText(price = X402_PRICE) {
  const amount = String(price).trim().replace(/^\$\s*/, '');
  return `${amount} USD`;
}

// Calls per window for a caller with no licence key.
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const DOMAIN_AGE_RATE_LIMIT_MAX = 60;
export const HOSTNAME_REPUTATION_RATE_LIMIT_MAX = 60;
export const WALLET_AGE_RATE_LIMIT_MAX = 60;
// check_wallet_sanctions over /api/a2a and /api/mcp (per IP). It reads a
// stored list, so the budget is higher than the checks that call an upstream.
export const WALLET_SANCTIONS_RATE_LIMIT_MAX = 120;

export function rateLimitWindowText(windowMs = RATE_LIMIT_WINDOW_MS) {
  if (windowMs === 60 * 60 * 1000) return 'hour';
  if (windowMs === 24 * 60 * 60 * 1000) return 'day';
  if (windowMs % 60000 === 0) return `${windowMs / 60000} minutes`;
  return `${windowMs / 1000} seconds`;
}
