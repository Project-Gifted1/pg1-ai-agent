// Outbound URL guard: https only (http only where a caller allows it), no
// credentials in the URL, no private, loopback, link-local, multicast,
// carrier-grade NAT, documentation or cloud-metadata addresses, whether
// the URL names the address directly or a hostname that resolves to one.
// Every resolved address is checked, so a name with one public and one
// private record is refused. Redirects are never followed by safeFetch
// (redirect: 'manual'), so a public URL cannot bounce to a private one.
//
// Used by the lab's read-only research fetch (lib/lab/netPolicy.mjs) and by
// webhook delivery (P8). DNS rebinding between the check and the connection
// is narrowed by connecting to the checked address for the webhook path.

import net from 'node:net';
import dns from 'node:dns/promises';

export class UnsafeUrlError extends Error {
  constructor(message, code = 'unsafe_url') {
    super(message);
    this.name = 'UnsafeUrlError';
    this.code = code;
  }
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32]
].map(([base, bits]) => [ipv4ToInt(base), bits]);

export function isPrivateAddress(address) {
  const a = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(a)) {
    const n = ipv4ToInt(a);
    return V4_BLOCKS.some(([base, bits]) => (bits === 0 ? true : (n >>> (32 - bits)) === (base >>> (32 - bits))));
  }
  if (net.isIPv6(a)) {
    if (a === '::' || a === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]);
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (a.startsWith('2001:db8:') || a.startsWith('64:ff9b:') || a.startsWith('100::')) return true;
    return false;
  }
  return true; // not an address at all: refuse
}

const BLOCKED_NAMES = /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa|metadata\.google\.internal|metadata)$/i;

// Parses and checks the URL itself (no DNS). Returns the URL object.
export function checkUrlShape(raw, { allowHttp = false } = {}) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch (e) {
    throw new UnsafeUrlError('not a valid URL', 'invalid_url');
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new UnsafeUrlError('only https URLs are allowed', 'not_https');
  if (u.username || u.password) throw new UnsafeUrlError('URLs with credentials are not allowed', 'credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new UnsafeUrlError('the URL has no host', 'invalid_url');
  if (BLOCKED_NAMES.test(host)) throw new UnsafeUrlError('private host names are not allowed', 'private_host');
  if ((net.isIP(host) && isPrivateAddress(host))) throw new UnsafeUrlError('private or reserved addresses are not allowed', 'private_address');
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || /^[\d.]+$/.test(host) && !net.isIPv4(host)) throw new UnsafeUrlError('numeric host forms are not allowed', 'private_address');
  if (u.port && !['443', '80', '8443'].includes(u.port)) throw new UnsafeUrlError('only the standard web ports are allowed', 'port');
  return u;
}

// Shape check, then every DNS answer. Resolves to { url, addresses }.
export async function assertPublicUrl(raw, { allowHttp = false, lookup = (h) => dns.lookup(h, { all: true, verbatim: true }) } = {}) {
  const u = checkUrlShape(raw, { allowHttp });
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return { url: u, addresses: [host] };
  let answers;
  try {
    answers = await lookup(host);
  } catch (e) {
    throw new UnsafeUrlError('the host name does not resolve', 'unresolvable');
  }
  const addresses = (Array.isArray(answers) ? answers : [answers]).map((a) => (typeof a === 'string' ? a : a && a.address)).filter(Boolean);
  if (!addresses.length) throw new UnsafeUrlError('the host name does not resolve', 'unresolvable');
  if (addresses.some(isPrivateAddress)) throw new UnsafeUrlError('the host name resolves to a private or reserved address', 'private_address');
  return { url: u, addresses };
}

// A fetch that checks the URL first and never follows redirects.
export async function safeFetch(raw, options = {}, { fetchImpl = globalThis.fetch, allowHttp = false, lookup, timeoutMs = 10000 } = {}) {
  const { url } = await assertPublicUrl(raw, { allowHttp, lookup });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url.toString(), { ...options, redirect: 'manual', signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}
