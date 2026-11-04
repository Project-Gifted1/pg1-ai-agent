// Timing-safe comparison of a presented secret with the expected one. A
// length mismatch still runs a same-length timingSafeEqual, so it does not
// return measurably sooner. Shared by every operator credential check
// (api/chat.mjs re-exports it for the routes that import it from there).

import crypto from 'node:crypto';

export function safeCompare(provided, expected) {
  const providedBuf = Buffer.from(String(provided == null ? '' : provided), 'utf-8');
  const expectedBuf = Buffer.from(String(expected == null ? '' : expected), 'utf-8');
  if (providedBuf.length !== expectedBuf.length) {
    crypto.timingSafeEqual(providedBuf, providedBuf);
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}
