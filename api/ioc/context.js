/**
 * PG1 Sovereign Threat Intelligence — REST mirror of the get_ioc_context MCP tool.
 * Endpoint: GET /api/ioc/context?value=<indicator>
 *
 * Disabled by default: only served when ENABLE_REST_IOC_CONTEXT === "true".
 * Not advertised in the x402 Bazaar/discovery metadata (unlike /api/ioc) —
 * this route is meant for direct integration, not discovery-crawler probing.
 *
 * Gating mirrors get_ioc_context in api/mcp.mjs and /api/ioc in api/chat.mjs:
 * a found:false result is always free; a found:true result requires a valid
 * Gumroad license key (X-API-KEY), an explicit free-tier opt-in
 * (X-Free-Tier: 1, subject to the daily quota), or an x402 payment
 * (PAYMENT-SIGNATURE header).
 */

import { getSupabaseCreds } from '../../lib/supabase.mjs';
import { lookupIocContext } from '../../lib/iocContext.mjs';
import { checkAndConsumeFreeTier, getRequestIdentifier, logSettlementOutcome } from '../../lib/freeTier.mjs';
import { verifyGumroadLicense, ensureExpressCompat, mirrorPaymentRequiredIntoJsonBody, createX402Gate } from '../../lib/paymentGate.mjs';

export const config = { maxDuration: 30 };

const ENABLED = process.env.ENABLE_REST_IOC_CONTEXT === 'true';

// Only built when the route is actually enabled, so a disabled deployment
// never pays the cost (or noise) of constructing the x402 facilitator client.
const x402Gate = ENABLED
  ? createX402Gate({
      routeKey: 'GET /api/ioc/context',
      price: '$0.01',
      description: 'PG1 Threat Intelligence: single-indicator IOC context lookup (REST mirror of the get_ioc_context MCP tool).',
      mimeType: 'application/json'
    })
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, PAYMENT-SIGNATURE, X-Payment, X-Free-Tier');
  res.setHeader('Access-Control-Expose-Headers', 'X-Payment, Payment-Signature, x-free-tier, X-API-KEY, PAYMENT-REQUIRED, PAYMENT-RESPONSE');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!ENABLED) {
    return res.status(404).json({ error: 'not available' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
  }

  const parsedUrl = new URL(req.url || '/', 'http://localhost');
  const value = String(req.query?.value ?? parsedUrl.searchParams.get('value') ?? '').trim();
  if (!value) {
    return res.status(400).json({ error: 'value query parameter is required.' });
  }

  let lookupResult;
  try {
    const { supUrl, supKey } = getSupabaseCreds();
    lookupResult = await lookupIocContext(value, supUrl, supKey);
  } catch (e) {
    const status = e.serviceUnavailable ? 503 : 500;
    return res.status(status).json({ error: e.message });
  }

  if (!lookupResult.found) {
    return res.status(200).json(lookupResult);
  }

  const licenseKey = req.headers['x-api-key'] || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const requestIdentifier = getRequestIdentifier(req);

  let authorized = false;
  if (licenseKey) {
    const check = await verifyGumroadLicense(licenseKey);
    if (check.valid) authorized = true;
    else return res.status(402).json({ error: 'Payment Required: ' + check.error });
  }

  const rawPayment = req.headers['x-payment'] || req.headers['payment-signature'];
  const freeTierOptIn = req.headers['x-free-tier'] === '1';

  if (!authorized && !rawPayment && freeTierOptIn) {
    try {
      const { supUrl, supKey } = getSupabaseCreds();
      const freeTierResult = await checkAndConsumeFreeTier(supUrl, supKey, requestIdentifier);
      if (freeTierResult.allowed) {
        authorized = true;
        logSettlementOutcome('/api/ioc/context', 'free_tier', requestIdentifier, 'remaining=' + freeTierResult.remaining);
      }
    } catch (e) {}
  }

  if (!authorized && x402Gate?.middleware) {
    const ready = await x402Gate.ensureInitialized();
    if (!ready) {
      return res.status(402).json({ error: 'x402 payment path temporarily unavailable. Retry, or use a Gumroad license key.' });
    }
    ensureExpressCompat(req);
    mirrorPaymentRequiredIntoJsonBody(res);
    try {
      await new Promise((resolve, reject) => {
        x402Gate.middleware(req, res, (err) => (err ? reject(err) : (authorized = true, resolve())));
      });
    } catch (x402Err) {
      if (!res.headersSent) {
        return res.status(402).json({ error: 'Payment verification failed: ' + x402Err.message });
      }
      return;
    }
    if (!authorized) return; // middleware already wrote its own 402 challenge or error response
  }

  if (!authorized) {
    return res.status(402).json({
      error: 'Payment Required: send a valid Gumroad key in X-API-KEY, or pay $0.01 via x402 (PAYMENT-SIGNATURE header).'
    });
  }

  logSettlementOutcome('/api/ioc/context', 'success', requestIdentifier, licenseKey ? 'license' : 'x402');
  return res.status(200).json(lookupResult);
}
