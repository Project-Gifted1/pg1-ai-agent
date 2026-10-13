// The HTML page a browser gets from a paid PG1 route (/api/ioc,
// /api/ioc/context) once the free tier is used up, in place of the x402
// library's placeholder ("Note to developers: install @x402/paywall").
//
// Registered as the x402 paywall provider (paymentMiddleware's 4th
// argument), which the library calls ONLY for a browser request (Accept
// text/html and a Mozilla user agent). Programmatic clients keep the exact
// JSON body and PAYMENT-REQUIRED header they got before; the page is sent
// with that same header and status.
//
// Static and self-contained: no scripts, no wallet UI, no external
// fonts or images. Colours follow public/about/index.html. The only value
// taken from the request is the resource URL's path, escaped.

import { FREE_TIER_DAILY_LIMIT } from './freeTier.mjs';
import { X402_ASSET_SYMBOL, X402_NETWORK, X402_NETWORK_NAME, x402PriceText } from './x402Config.mjs';

const SITE = 'https://pg1-ai-agent.vercel.app';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// What each paid REST path is, in a sentence (unknown paths get a generic one).
const ENDPOINTS = Object.freeze({
  '/api/ioc': 'A STIX 2.1 threat indicator feed for agents and security tooling, built only from sources PG1 may redistribute commercially (currently NVD).',
  '/api/feeds/ioc': 'A STIX 2.1 threat indicator feed for agents and security tooling, built only from sources PG1 may redistribute commercially (currently NVD).',
  '/api/ioc/context': 'Context for one indicator (IP, domain, URL or file hash) from the STIX feed\'s sources. A lookup with nothing on record is always free.'
});

function resourcePath(paymentRequired) {
  try {
    return new URL(paymentRequired?.resource?.url || '', SITE).pathname;
  } catch {
    return '/api/ioc';
  }
}

export function renderPaywallPage(paymentRequired) {
  const path = resourcePath(paymentRequired);
  const what = ENDPOINTS[path] || 'A paid PG1 Threat Intelligence endpoint.';
  const price = x402PriceText();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>PG1 Threat Intelligence: payment required</title>
  <link rel="icon" href="/brand/pg1-shield.svg" type="image/svg+xml">
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0a0b; --surface-1: #121214; --border: #26262b;
      --text: #ececee; --text-2: #a8a8b0; --text-strong: #fff;
      --gold: #f3c623; --gold-strong: #ffd84d; --gold-soft: rgba(243, 198, 35, 0.12);
      --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
      --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Roboto Mono", "Liberation Mono", monospace;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-sans); font-size: 1rem; line-height: 1.6; }
    main { max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
    header { display: flex; align-items: center; gap: 0.875rem; margin: 0.5rem 0 1.5rem; }
    header svg { flex: none; width: 3.25rem; height: 3.25rem; }
    h1 { margin: 0; font-size: 1.5rem; line-height: 1.25; color: var(--text-strong); }
    .sub { margin: 0.125rem 0 0; color: var(--text-2); font-size: 0.9375rem; }
    h2 { margin: 2rem 0 0.75rem; font-size: 1.125rem; color: var(--gold); border-bottom: 1px solid var(--border); padding-bottom: 0.375rem; }
    p { margin: 0 0 1rem; }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.625rem; margin: 0 0 1rem; }
    .fact { background: var(--surface-1); border: 1px solid var(--border); border-radius: 0.625rem; padding: 0.75rem 0.875rem; }
    .fact b { display: block; color: var(--text-strong); font-size: 1.25rem; }
    .fact span { color: var(--text-2); font-size: 0.875rem; }
    ul { margin: 0 0 1rem; padding: 0; list-style: none; }
    li { margin: 0 0 0.625rem; padding: 0.75rem 0.875rem; background: var(--surface-1); border: 1px solid var(--border); border-radius: 0.625rem; }
    code { font-family: var(--font-mono); font-size: 0.875em; color: var(--gold-strong); background: var(--gold-soft); padding: 0.0625rem 0.3125rem; border-radius: 0.25rem; overflow-wrap: anywhere; }
    a { color: var(--gold-strong); text-underline-offset: 0.15em; overflow-wrap: anywhere; }
    a:hover { color: var(--text-strong); }
    a:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; border-radius: 2px; }
    .note { color: var(--text-2); font-size: 0.9375rem; }
    footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--text-2); font-size: 0.875rem; }
  </style>
</head>
<body>
<main>
  <header>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="169.76 -2 104 104" width="104" height="104" role="img" aria-label="PG1">
      <title>PG1</title>
      <path d="M221.76 0L262.5 15.2V47.3C262.5 73.9 245.1 91.85 221.76 100C198.4 91.85 181 73.9 181 47.3V15.2Z" fill="#f3c623"/>
      <path d="M220 20H233V72H220V37.5L208.5 43.5V31Z" fill="#0a0a0b"/>
    </svg>
    <div>
      <h1>Payment required</h1>
      <p class="sub">PG1 Threat Intelligence · <code>${escapeHtml(path)}</code></p>
    </div>
  </header>

  <p>${escapeHtml(what)}</p>

  <div class="facts">
    <div class="fact"><b>${FREE_TIER_DAILY_LIMIT} free calls</b><span>a day per caller, shared across PG1's paid endpoints</span></div>
    <div class="fact"><b>${escapeHtml(price)}</b><span>per call after that, in ${escapeHtml(X402_ASSET_SYMBOL)} on ${escapeHtml(X402_NETWORK_NAME)}</span></div>
  </div>
  <p class="note">This address has used today's free calls (or asked to skip them with <code>X-Free-Tier: 0</code>). They reset at midnight UTC.</p>

  <h2>How agents pay</h2>
  <ul>
    <li><b>x402, per call.</b> Send the signed payment in the <code>PAYMENT-SIGNATURE</code> header. An x402 client such as <code>@x402/fetch</code> reads this response's <code>PAYMENT-REQUIRED</code> header and does it for you. Network <code>${escapeHtml(X402_NETWORK)}</code>.</li>
    <li><b>MCP.</b> Connect to <code>${SITE}/api/mcp</code>. Paid tools take the payment in <code>params._meta["x402/payment"]</code>; the free checks need nothing.</li>
    <li><b>A2A.</b> <code>${SITE}/api/a2a</code>, with the payment in the message metadata (a2a-x402). Agent card: <a href="/.well-known/agent-card.json">/.well-known/agent-card.json</a>.</li>
  </ul>
  <p class="note">Programmatic clients get this same 402 as JSON with the <code>PAYMENT-REQUIRED</code> header. Docs: <a href="/about">About PG1</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/llms.txt">llms.txt</a> · <a href="/.well-known/x402">/.well-known/x402</a></p>

  <footer>Project-Gifted1&trade; &middot; PG1 Threat Intelligence</footer>
</main>
</body>
</html>`;
}

// The x402 paywall provider interface: { generateHtml(paymentRequired, config) }.
export const pg1Paywall = Object.freeze({
  generateHtml: (paymentRequired) => renderPaywallPage(paymentRequired)
});
