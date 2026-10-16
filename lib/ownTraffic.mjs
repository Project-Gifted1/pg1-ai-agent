// Our own and test traffic, which /usage never counts as real (or as
// probe): it is counted apart as "own and test traffic".
//
// At write time (lib/telemetry.mjs caller_kind) a request is
//   'test'      when this deployment is not production (VERCEL_ENV is set
//               and is not 'production': previews, local runs with it set),
//               or it carries X-PG1-Test with the PG1_TEST_TRAFFIC_TOKEN
//               value (our own scripts and integration checks);
//   'internal'  when its User-Agent names one of our own or a partner
//               integration's checkers (config/usageProbes.mjs
//               OWN_USER_AGENTS: the x402 validator workflow, the payment
//               config check, x402 Doctor), or its IP is in PG1_OWN_IPS.
// Everything else is null (an outside caller).
//
// At read time (lib/usageStats.mjs) a caller is own traffic when any of its
// rows has caller_kind, or its salted IP hash is one of
// PG1_OWN_CALLER_HASHES or the hash of an address in PG1_OWN_IPS, so traffic
// recorded before caller_kind existed can still be taken out.
//
// Settings (names only):
//   PG1_OWN_IPS              comma-separated IP addresses of our own machines
//   PG1_OWN_CALLER_HASHES    comma-separated caller hashes, whole (32 hex) or
//                            the 8+ character prefix /usage shows ("caller
//                            1a2b3c4d")
//   PG1_TEST_TRAFFIC_TOKEN   the X-PG1-Test value our own scripts send
// The IPs are only ever compared and hashed here, never stored.

import crypto from 'node:crypto';
import { callerHash } from './telemetry.mjs';
import { OWN_USER_AGENTS } from '../config/usageProbes.mjs';

export const TEST_TRAFFIC_HEADER = 'x-pg1-test';

function header(req, name) {
  const h = req && req.headers;
  if (!h) return '';
  const v = typeof h.get === 'function' ? h.get(name) : h[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] || '') : '';
}

function list(value) {
  return String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
}

const words = (v) => ` ${String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const OWN_UA_WORDS = OWN_USER_AGENTS.map((w) => words(w).trim()).filter(Boolean);

export function isOwnUserAgent(userAgent, names = OWN_UA_WORDS) {
  const w = words(userAgent);
  return w.trim() !== '' && names.some((n) => w.includes(` ${n} `));
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requestIp(req) {
  const fwd = header(req, 'x-forwarded-for');
  const first = fwd ? fwd.split(',')[0].trim() : '';
  return first || (req && req.socket && req.socket.remoteAddress) || '';
}

// 'internal' | 'test' | null for one request. Never throws.
export function callerKindOf(req, env = process.env) {
  try {
    const vercelEnv = String(env.VERCEL_ENV || '').trim();
    if (vercelEnv && vercelEnv !== 'production') return 'test';
    const token = String(env.PG1_TEST_TRAFFIC_TOKEN || '').trim();
    const sent = header(req, TEST_TRAFFIC_HEADER).trim();
    if (token && sent && sameSecret(sent, token)) return 'test';
    if (isOwnUserAgent(header(req, 'user-agent'))) return 'internal';
    const ip = requestIp(req).toLowerCase();
    if (ip && list(env.PG1_OWN_IPS).map((x) => x.toLowerCase()).includes(ip)) return 'internal';
    return null;
  } catch {
    return null;
  }
}

// The caller hashes (or 8+ character prefixes) that are ours, for the read
// side.
export function ownCallerHashes(env = process.env) {
  const out = new Set(list(env.PG1_OWN_CALLER_HASHES).map((h) => h.toLowerCase()).filter((h) => /^[0-9a-f]{8,32}$/.test(h)));
  for (const ip of list(env.PG1_OWN_IPS)) {
    const h = callerHash(ip);
    if (h) out.add(h);
  }
  return out;
}

// True when `hash` is one of `own` (whole or by prefix).
export function isOwnHash(hash, own) {
  if (typeof hash !== 'string' || !hash || !own || !own.size) return false;
  const h = hash.toLowerCase();
  for (const o of own) if (h.startsWith(o)) return true;
  return false;
}

// The short label /usage shows for a caller: the first 8 characters of its
// salted hash (no IP can be recovered from it without the salt).
export function callerLabel(hash) {
  return typeof hash === 'string' && hash ? `caller ${hash.slice(0, 8)}` : 'caller (no hash)';
}
