// Reusable x402 + Gumroad license gating for a single Vercel serverless
// route. api/mcp.mjs and api/chat.mjs each build their own copy of this
// (one route each: 'POST /api/mcp' and 'GET /api/ioc'); this module exists
// so the new GET /api/ioc/context route doesn't need a third copy pasted
// in, without touching either of those two working, already-deployed
// gates.

import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';

export async function verifyGumroadLicense(licenseKey) {
  if (!licenseKey) return { valid: false, error: 'No license key provided.' };
  try {
    const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ product_id: process.env.GUMROAD_PRODUCT_ID, license_key: licenseKey })
    });
    const data = await res.json();
    if (!data.success || (data.purchase && (data.purchase.refunded || data.purchase.chargebacked))) {
      return { valid: false, error: 'Invalid, expired, or refunded license key.' };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, error: 'License verification failed: ' + e.message };
  }
}

export function ensureExpressCompat(req) {
  if (typeof req.header !== 'function') {
    req.header = req.get = (name) => {
      const v = req.headers[String(name).toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
  }
  if (req.path === undefined) req.path = (req.url || '/').split('?')[0];
  if (req.originalUrl === undefined) req.originalUrl = req.url;
  if (req.protocol === undefined) {
    const fp = req.headers['x-forwarded-proto'];
    req.protocol = (Array.isArray(fp) ? fp[0] : fp) || 'https';
  }
}

export function mirrorPaymentRequiredIntoJsonBody(res) {
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    try {
      if (res.statusCode === 402) {
        const paymentRequiredHeader = res.getHeader('PAYMENT-REQUIRED');
        if (paymentRequiredHeader) {
          const decoded = JSON.parse(Buffer.from(String(paymentRequiredHeader), 'base64').toString('utf-8'));
          return originalJson(decoded);
        }
      }
    } catch (e) {}
    return originalJson(body);
  };
}

// Builds a per-route x402 gate. No Bazaar `extensions` metadata is set here
// on purpose — callers that need discovery metadata (like /api/ioc) build
// their own paymentMiddleware config directly instead of using this helper.
export function createX402Gate({ routeKey, price, description, mimeType }) {
  const payTo = (process.env.X402_PAY_TO_ADDRESS || '').trim();
  let middleware = null;
  let server = null;
  if (payTo) {
    try {
      const facilitatorClient = createCdpFacilitatorClient();
      server = new x402ResourceServer(facilitatorClient).register('eip155:8453', new ExactEvmScheme());
      middleware = paymentMiddleware(
        { [routeKey]: { accepts: [{ scheme: 'exact', price, network: 'eip155:8453', payTo }], description, mimeType } },
        server,
        undefined,
        undefined,
        false
      );
    } catch (e) {
      console.error(`[X402] Setup failed for ${routeKey}, payment path disabled:`, e.message);
      middleware = null;
    }
  }

  let initPromise = null;
  let initialized = false;
  async function ensureInitialized() {
    if (initialized) return true;
    if (!server) return false;
    if (!initPromise) {
      initPromise = Promise.race([
        server.initialize(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('facilitator init timeout')), 8000))
      ]).then(() => { initialized = true; return true; })
        .catch((err) => { console.error('[X402] init failed:', err.message); initPromise = null; return false; });
    }
    return initPromise;
  }

  return { middleware, ensureInitialized };
}
