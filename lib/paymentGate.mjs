// Reusable x402 + Gumroad license gating for a single Vercel serverless
// route. api/mcp.mjs and api/chat.mjs each build their own copy of this
// (one route each: 'POST /api/mcp' and 'GET /api/ioc'); this module exists
// so the new GET /api/ioc/context route doesn't need a third copy pasted
// in, without touching either of those two working, already-deployed
// gates.

import crypto from 'node:crypto';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';

const GUMROAD_VERIFY_TIMEOUT_MS = 2000;
const LICENSE_CACHE_TTL_MS = 10 * 60 * 1000;

// In-memory cache of successful verifications, per Vercel instance. Keyed by
// a SHA-256 hash of the license key so the raw key is never retained. Only
// successes are cached (see verifyGumroadLicense) - a failure could be
// transient (network blip, Gumroad hiccup) and shouldn't stick for 10min.
const licenseCache = new Map();

function hashLicenseKey(licenseKey) {
  return crypto.createHash('sha256').update(licenseKey).digest('hex');
}

// Gumroad reports a subscription cancellation the moment it's requested, but
// the purchaser keeps access until the paid period actually lapses - so only
// an ended/cancelled timestamp at or before now invalidates the license. A
// future-dated one must stay valid until that time.
function isPastOrNow(timestamp) {
  if (!timestamp) return false;
  const t = new Date(timestamp).getTime();
  if (Number.isNaN(t)) return false;
  return t <= Date.now();
}

function evaluateGumroadResponse(data) {
  if (!data || !data.success) {
    return { valid: false, error: 'Invalid, expired, or refunded license key.' };
  }
  const purchase = data.purchase || {};
  if (purchase.refunded || purchase.chargebacked) {
    return { valid: false, error: 'Invalid, expired, or refunded license key.' };
  }
  if (purchase.subscription_failed_at) {
    return { valid: false, error: 'Subscription payment failed.' };
  }
  if (isPastOrNow(purchase.subscription_ended_at)) {
    return { valid: false, error: 'Subscription has ended.' };
  }
  if (isPastOrNow(purchase.subscription_cancelled_at)) {
    return { valid: false, error: 'Subscription has been cancelled.' };
  }
  return { valid: true };
}

export async function verifyGumroadLicense(licenseKey) {
  if (!licenseKey) return { valid: false, error: 'No license key provided.' };

  const cacheKey = hashLicenseKey(licenseKey);
  const cachedEntry = licenseCache.get(cacheKey);
  if (cachedEntry && Date.now() <= cachedEntry.expiresAt) {
    return cachedEntry.result;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GUMROAD_VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
      body: new URLSearchParams({
        product_id: process.env.GUMROAD_PRODUCT_ID,
        license_key: licenseKey,
        increment_uses_count: 'false'
      })
    });
    const data = await res.json();
    const result = evaluateGumroadResponse(data);
    if (result.valid) {
      licenseCache.set(cacheKey, { result, expiresAt: Date.now() + LICENSE_CACHE_TTL_MS });
    }
    return result;
  } catch (e) {
    if (e.name === 'AbortError') {
      // Stale-but-present cache entry (expired above, but not yet evicted)
      // beats a hard failure on a slow Gumroad response.
      if (cachedEntry) return cachedEntry.result;
      // Distinct from a genuinely bad key: callers must not treat this as
      // "invalid" (403/402) — Gumroad itself is unreachable, so the caller
      // should be told to retry rather than being permanently rejected.
      return { valid: false, error: 'License verification timed out.', reason: 'verification_unavailable' };
    }
    return { valid: false, error: 'License verification failed: ' + e.message, reason: 'verification_unavailable' };
  } finally {
    clearTimeout(timeoutId);
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
