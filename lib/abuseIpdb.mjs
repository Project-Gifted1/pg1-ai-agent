// Bring-your-own-key AbuseIPDB lookups for the check_ip_abuse MCP tool and
// A2A skill (1.16.0).
//
// Terms agreed in writing with AbuseIPDB (2026-10-06). These are hard rules
// and everything in this file exists to enforce them:
//   1. AbuseIPDB is queried only with the CUSTOMER'S OWN key, sent by the
//      caller in the X-AbuseIPDB-Key request header on /api/mcp or /api/a2a.
//      PG1 has no AbuseIPDB key of its own: nothing here reads a key from
//      the environment, and there is no fallback key. The key is never a
//      tool argument (it would end up in model context and in logs).
//   2. Results go only to the customer whose key was used, with attribution
//      to AbuseIPDB.
//   3. Caching is per customer key only: the cache key starts with
//      sha256(customer key), so one customer's results can never be served
//      to another. The cache is in memory only (never a database), lasts 15
//      minutes, and never holds a raw key.
//   4. The connection is off unless the customer supplied a key: no header,
//      no request to AbuseIPDB.
// Results never go into threat_ioc_telemetry, get_ioc_context,
// get_threat_indicators, the pipeline or any other customer's response:
// nothing here writes anywhere.
//
// The key never appears in a log line, a pg1_errors row, a response, a
// telemetry row or a trace: errors carry fixed PG1-written reason strings
// only, and never the upstream response body.
//
// AbuseIPDB API v2 CHECK endpoint, as used here:
//   GET https://api.abuseipdb.com/api/v2/check?ipAddress=<ip>&maxAgeInDays=<1..365>
//   Headers: Key: <customer key>, Accept: application/json
//   200: { data: { ipAddress, isPublic, ipVersion, isWhitelisted,
//          abuseConfidenceScore, countryCode, usageType, isp, domain,
//          hostnames, isTor, totalReports, numDistinctUsers,
//          lastReportedAt } }
//   401/403: bad or unauthorised key. 429: daily quota reached, with
//   Retry-After (seconds). 422: parameters rejected.

import crypto from 'node:crypto';
import net from 'node:net';
import { withFixIt } from './invalidInput.mjs';

export const ABUSEIPDB_KEY_HEADER = 'X-AbuseIPDB-Key';
const HEADER_LOOKUP = ABUSEIPDB_KEY_HEADER.toLowerCase();

export const ABUSEIPDB_CHECK_URL = 'https://api.abuseipdb.com/api/v2/check';
export const ABUSEIPDB_ATTRIBUTION_TEXT = 'Data from AbuseIPDB';
export const ABUSEIPDB_TIMEOUT_MS = 5000;
export const ABUSEIPDB_CACHE_TTL_MS = 15 * 60 * 1000;
// Bounded so a flood of distinct keys/IPs can't grow memory without limit;
// the oldest entry goes first.
export const ABUSEIPDB_CACHE_MAX_ENTRIES = 5000;

export const MAX_AGE_DAYS_DEFAULT = 90;
export const MAX_AGE_DAYS_MIN = 1;
export const MAX_AGE_DAYS_MAX = 365;

export function abuseIpdbCheckUrlFor(ip) {
  return `https://www.abuseipdb.com/check/${encodeURIComponent(ip)}`;
}

// ---------------------------------------------------------------------------
// Errors. Every one is an MCP tool error (isError: true) with a fixed
// message - never caller input, never the key, never an upstream body.
// `logReason` (a fixed string) marks the ones the dispatchers record in
// pg1_errors.

class AbuseIpdbToolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AbuseIpdbToolError';
    this.mcpToolError = true;
    this.code = code;
    Object.assign(this, extra);
  }
}

export function keyRequiredError() {
  return new AbuseIpdbToolError(
    'abuseipdb_key_required',
    `check_ip_abuse uses your own AbuseIPDB API key, and none was sent, so AbuseIPDB was not contacted. Send your key in the ${ABUSEIPDB_KEY_HEADER} HTTP request header on /api/mcp or /api/a2a (never as a tool argument). A free key is available from your AbuseIPDB account (https://www.abuseipdb.com/account/api); lookups count against your own AbuseIPDB quota.`
  );
}

function invalidKeyError({ upstream } = {}) {
  return new AbuseIpdbToolError(
    'invalid_abuseipdb_key',
    upstream
      ? `AbuseIPDB rejected the key sent in ${ABUSEIPDB_KEY_HEADER} (unauthorised). Check the key in your AbuseIPDB account (https://www.abuseipdb.com/account/api) and send it exactly as issued.`
      : `The ${ABUSEIPDB_KEY_HEADER} header is not a usable key (empty, too long, or contains spaces or control characters). Send your AbuseIPDB API key exactly as issued.`,
    upstream ? { logReason: 'check_ip_abuse_invalid_key', logStatus: 401, logCategory: 'upstream' } : {}
  );
}

function rateLimitedError(retryAfter) {
  const wait = retryAfter ? ` Retry after ${retryAfter} second(s).` : '';
  return new AbuseIpdbToolError(
    'abuseipdb_rate_limited',
    `Your AbuseIPDB key has reached its AbuseIPDB request limit.${wait} This is your own AbuseIPDB quota, not a PG1 limit.`,
    { retryAfter: retryAfter || null, logReason: 'check_ip_abuse_upstream_rate_limited', logStatus: 429, logCategory: 'upstream' }
  );
}

function upstreamUnavailableError(timedOut) {
  return new AbuseIpdbToolError(
    'upstream_unavailable',
    timedOut
      ? `AbuseIPDB lookup timed out after ${ABUSEIPDB_TIMEOUT_MS}ms.`
      : 'AbuseIPDB lookup failed: AbuseIPDB is unavailable right now, please retry.',
    { logReason: timedOut ? 'check_ip_abuse_timeout' : 'check_ip_abuse_upstream_unavailable', logStatus: null, logCategory: timedOut ? 'timeout' : 'upstream' }
  );
}

export class InvalidIpError extends Error {
  constructor(problem) {
    super('');
    withFixIt(this, { problem, expected: 'one public IPv4 or IPv6 address, with no port, CIDR range, brackets or zone id', example: '8.8.8.8' });
    this.name = 'InvalidIpError';
    this.mcpToolError = true;
    this.code = 'invalid_ip';
  }
}

export class InvalidMaxAgeError extends Error {
  constructor() {
    super('');
    withFixIt(this, {
      problem: 'max_age_in_days is not a whole number from 1 to 365',
      expected: `an integer from ${MAX_AGE_DAYS_MIN} to ${MAX_AGE_DAYS_MAX}, or omit it for ${MAX_AGE_DAYS_DEFAULT}`,
      example: String(MAX_AGE_DAYS_DEFAULT)
    });
    this.name = 'InvalidMaxAgeError';
    this.mcpToolError = true;
    this.code = 'invalid_max_age';
  }
}

// ---------------------------------------------------------------------------
// The customer's key, from the request header only.

// Returns the trimmed key, null when the header is absent or empty, or
// throws invalid_abuseipdb_key when it can't be a key at all (control
// characters, whitespace inside, absurd length) - checked locally, without
// calling AbuseIPDB. The format itself is not checked further, so a key
// format change on AbuseIPDB's side never locks customers out; AbuseIPDB
// decides whether the key is valid.
export function readCustomerKey(headers) {
  let raw = headers ? headers[HEADER_LOOKUP] ?? headers[ABUSEIPDB_KEY_HEADER] : undefined;
  if (Array.isArray(raw)) raw = raw[0];
  if (raw === undefined || raw === null) return null;
  const key = String(raw).trim();
  if (!key) return null;
  if (key.length > 256 || !/^[\x21-\x7e]+$/.test(key)) throw invalidKeyError();
  return key;
}

// The only form of the key that is ever kept (as a cache-key prefix).
export function keyFingerprint(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

// Copy of a request's headers that is safe to log: the customer's AbuseIPDB
// key is replaced, whatever its case.
export function redactRequestHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name] = name.toLowerCase() === HEADER_LOOKUP ? '[removed]' : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Input validation: exactly one public IPv4 or IPv6 address.

const NON_PUBLIC = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) NON_PUBLIC.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['2620:4f:8000::', 48], ['3fff::', 20]
]) NON_PUBLIC.addSubnet(addr, prefix, 'ipv6');
// Only global unicast IPv6 (2000::/3) can be public; that rules out ::,
// ::1, IPv4-mapped/-compatible, unique-local, link-local and multicast.
const GLOBAL_UNICAST_V6 = new net.BlockList();
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6');

// Canonical compressed lowercase form of a valid IPv6 literal.
function canonicalIpv6(ip) {
  return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
}

// Returns { ip, version } or throws invalid_ip. Never echoes the input.
export function normalizePublicIp(raw) {
  if (typeof raw !== 'string') throw new InvalidIpError('ip is missing or is not a string');
  const value = raw.trim();
  if (!value) throw new InvalidIpError('ip is empty');
  if (value.length > 64) throw new InvalidIpError('ip is too long to be an IP address');
  if (/[\s,;]/.test(value)) throw new InvalidIpError('ip contains spaces or separators; send exactly one address per call');
  const version = net.isIP(value);
  if (version === 4) {
    if (NON_PUBLIC.check(value, 'ipv4')) throw new InvalidIpError('ip is a private, reserved or special-purpose IPv4 address, not a public one');
    return { ip: value, version: 4 };
  }
  if (version === 6) {
    if (value.includes('%')) throw new InvalidIpError('ip carries a zone id, so it is not a public address');
    const ip = canonicalIpv6(value);
    if (!GLOBAL_UNICAST_V6.check(ip, 'ipv6') || NON_PUBLIC.check(ip, 'ipv6')) {
      throw new InvalidIpError('ip is a private, reserved or special-purpose IPv6 address, not a public one');
    }
    return { ip, version: 6 };
  }
  throw new InvalidIpError('ip is not a valid IPv4 or IPv6 address');
}

export function normalizeMaxAgeDays(raw) {
  if (raw === undefined || raw === null || raw === '') return MAX_AGE_DAYS_DEFAULT;
  const n = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < MAX_AGE_DAYS_MIN || n > MAX_AGE_DAYS_MAX) throw new InvalidMaxAgeError();
  return n;
}

// ---------------------------------------------------------------------------
// Per-customer-key cache, in memory only.

const cache = new Map();

function cacheKey(key, ip, maxAgeDays) {
  return `${keyFingerprint(key)}|${ip}|${maxAgeDays}`;
}

export function getCachedLookup(key, ip, maxAgeDays) {
  const k = cacheKey(key, ip, maxAgeDays);
  const entry = cache.get(k);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(k);
    return null;
  }
  return entry.value;
}

export function setCachedLookup(key, ip, maxAgeDays, value) {
  const k = cacheKey(key, ip, maxAgeDays);
  cache.delete(k);
  while (cache.size >= ABUSEIPDB_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(k, { value, expiresAt: Date.now() + ABUSEIPDB_CACHE_TTL_MS });
}

// For tests: the cache's own keys (fingerprints, never raw keys).
export function __cacheKeysForTests() {
  return [...cache.keys()];
}

export function __clearAbuseIpdbCacheForTests() {
  cache.clear();
}

// ---------------------------------------------------------------------------
// The upstream call.

let fetchImpl = (...args) => fetch(...args);

export function __setAbuseIpdbFetchForTests(fn) {
  fetchImpl = fn || ((...args) => fetch(...args));
}

// Retry-After passed through as AbuseIPDB sent it, when it is a plain number
// of seconds; anything else (or nothing) is dropped rather than echoed.
function parseRetryAfter(value) {
  const v = String(value ?? '').trim();
  return /^\d{1,7}$/.test(v) ? Number(v) : null;
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function int(v) {
  return Number.isInteger(v) ? v : null;
}

function bool(v) {
  return typeof v === 'boolean' ? v : null;
}

// Only the fields check_ip_abuse returns, renamed; everything else in the
// upstream body (hostnames, reports, ...) is dropped here.
function pickFields(data) {
  const lastReported = str(data.lastReportedAt);
  const t = lastReported ? new Date(lastReported).getTime() : NaN;
  return {
    abuse_confidence_score: int(data.abuseConfidenceScore),
    total_reports: int(data.totalReports),
    distinct_reporters: int(data.numDistinctUsers),
    last_reported_at: Number.isNaN(t) ? null : new Date(t).toISOString(),
    country_code: str(data.countryCode),
    usage_type: str(data.usageType),
    isp: str(data.isp),
    domain: str(data.domain),
    is_tor: bool(data.isTor),
    is_whitelisted: bool(data.isWhitelisted)
  };
}

// One CHECK request with the customer's key. Returns the picked fields, or
// throws one of the tool errors above.
export async function fetchAbuseIpdbCheck(key, ip, maxAgeDays) {
  const url = `${ABUSEIPDB_CHECK_URL}?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=${maxAgeDays}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ABUSEIPDB_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { Key: key, Accept: 'application/json' }, signal: controller.signal });
  } catch (err) {
    throw upstreamUnavailableError(err && err.name === 'AbortError');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) throw invalidKeyError({ upstream: true });
  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null);
    throw rateLimitedError(retryAfter);
  }
  if (res.status === 422) {
    // Both parameters are validated before the call, so AbuseIPDB refusing
    // them means it does not accept this address.
    throw new InvalidIpError('AbuseIPDB did not accept this address');
  }
  if (!res.ok) throw upstreamUnavailableError(false);

  let body;
  try {
    body = await res.json();
  } catch {
    throw upstreamUnavailableError(false);
  }
  const data = body && typeof body === 'object' ? body.data : null;
  if (!data || typeof data !== 'object') throw upstreamUnavailableError(false);
  return pickFields(data);
}
