// Shared CRON_SECRET check for the Vercel cron routes (api/heartbeat/pulse.js,
// api/errors/cleanup.mjs). Vercel sends the project's CRON_SECRET env var on
// every cron invocation as `Authorization: Bearer <CRON_SECRET>`.
//
// Fails closed: with CRON_SECRET unset (or blank) the route answers 403 to
// everyone, cron included, instead of running unauthenticated. The header
// is compared in constant time: both sides are hashed to fixed-length
// digests first, so neither the length nor the content of the secret leaks
// through timing.

import crypto from 'node:crypto';

const digest = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest();

// Returns { ok: true } or { ok: false, status, error } for the caller to send.
export function checkCronAuth(req, env = process.env) {
  const secret = String(env.CRON_SECRET || '');
  if (!secret.trim()) return { ok: false, status: 403, error: 'Cron secret not configured on this deployment.' };
  const header = req && req.headers ? req.headers.authorization : undefined;
  const given = typeof header === 'string' ? header : '';
  if (!crypto.timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}
