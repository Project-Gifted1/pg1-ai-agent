// The lab dispatch token: an HMAC over the experiment's id, kind, budget
// and a hash of its goal and input, with an expiry, signed with
// PG1_LAB_DISPATCH_SECRET (the same lab-scoped secret is set in the
// deployment and in the GitHub "lab" environment). The runner refuses a run
// whose token does not verify, so a hand-made or replayed dispatch, or one
// with a larger budget, runs nothing.

import crypto from 'node:crypto';

export const LAB_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

export function labPayloadHash({ goal = '', input = '' }) {
  return crypto.createHash('sha256').update(`${goal}\u0000${input}`).digest('hex').slice(0, 32);
}

function sig(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function signLabToken({ id, kind, budgetUsd, goal, input, secret, now = Date.now() }) {
  if (!secret) throw new Error('PG1_LAB_DISPATCH_SECRET is not set');
  const exp = Math.floor(now + LAB_TOKEN_TTL_MS);
  const body = `${id}.${kind}.${Number(budgetUsd).toFixed(2)}.${labPayloadHash({ goal, input })}.${exp}`;
  return `${exp}.${sig(secret, body)}`;
}

export function verifyLabToken(token, { id, kind, budgetUsd, goal, input, secret, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(String(token || '').trim());
  if (!m) return { ok: false, reason: 'malformed' };
  const exp = Number(m[1]);
  const expected = Buffer.from(sig(secret, `${id}.${kind}.${Number(budgetUsd).toFixed(2)}.${labPayloadHash({ goal, input })}.${exp}`));
  const given = Buffer.from(m[2]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };
  if (!(exp > now) || exp > now + LAB_TOKEN_TTL_MS + 60000) return { ok: false, reason: 'expired' };
  return { ok: true };
}
