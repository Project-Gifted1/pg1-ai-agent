// ENS name -> EVM address, for the public playground (api/playground.mjs).
//
// Only plain on-chain names are resolved: the name's resolver is read from
// the ENS registry on Ethereum mainnet, then that resolver's addr(). Names
// served through a wildcard or off-chain resolver (ENSIP-10 / CCIP-Read)
// have no registry entry of their own and come back as not resolved, never
// as a guessed address.
//
// Input is strict (ENS_NAME_RE): lowercase ASCII labels ending in ".eth",
// so the name is already in normalised form and needs no Unicode
// normalisation (ENSIP-15) before hashing.
//
// keccak256 is implemented here because node:crypto only has the NIST
// SHA3-256 padding, which gives different hashes.

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
// Rotation offsets, ROT[x][y].
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14]
];

function rotl(v, n) {
  if (n === 0) return v;
  const b = BigInt(n);
  return ((v << b) | (v >> (64n - b))) & MASK;
}

function keccakF(s) {
  const c = new Array(5);
  const b = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
    }
    s[0] ^= RC[round];
  }
}

// keccak256(Uint8Array | string) -> Uint8Array(32)
export function keccak256(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const rate = 136;
  const padded = new Uint8Array(Math.floor(data.length / rate) * rate + rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = s[i];
    for (let k = 0; k < 8; k++) { out[i * 8 + k] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// One or more lowercase ASCII labels, then ".eth". 255 characters at most.
export const ENS_NAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+eth$/;

export function isEnsName(value) {
  return typeof value === 'string' && value.length <= 255 && ENS_NAME_RE.test(value);
}

// EIP-137 namehash, as 0x-prefixed hex.
export function namehash(name) {
  let node = new Uint8Array(32);
  const labels = name ? name.split('.') : [];
  for (let i = labels.length - 1; i >= 0; i--) {
    const joined = new Uint8Array(64);
    joined.set(node);
    joined.set(keccak256(labels[i]), 32);
    node = keccak256(joined);
  }
  return '0x' + toHex(node);
}

export const ENS_REGISTRY = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
const RESOLVER_SELECTOR = '0x0178b8bf'; // resolver(bytes32)
const ADDR_SELECTOR = '0x3b3b57de'; // addr(bytes32)
export const ENS_TIMEOUT_MS = 3000;
const ZERO_ADDRESS = '0x' + '0'.repeat(40);

function addressFromWord(result) {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) return null;
  const addr = '0x' + result.slice(-40).toLowerCase();
  return addr === ZERO_ADDRESS ? null : addr;
}

function unavailable() {
  const err = new Error('name lookup unavailable');
  err.ensUnavailable = true;
  return err;
}

function mainnetRpcUrl() {
  const apiKey = process.env.ALCHEMY_API_KEY;
  return apiKey ? `https://eth-mainnet.g.alchemy.com/v2/${apiKey}` : null;
}

async function ethCall(url, to, data, signal) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
    });
  } catch {
    const err = unavailable();
    if (signal && signal.aborted) err.timeout = true;
    throw err;
  }
  if (!res.ok) throw unavailable();
  let body;
  try { body = await res.json(); } catch { throw unavailable(); }
  if (!body || body.error) throw unavailable();
  return body.result;
}

// resolveEnsName('vitalik.eth') -> '0x…' (lowercase), or null when the name
// has no resolver or no address. Throws an error with `ensUnavailable` set
// when the lookup itself could not be made (no RPC configured, network
// failure, timeout - `timeout` is then set too - or an RPC error): that
// is an unknown, never "no address".
export async function resolveEnsName(name, { timeoutMs = ENS_TIMEOUT_MS, rpcUrl = mainnetRpcUrl() } = {}) {
  if (!isEnsName(name)) return null;
  if (!rpcUrl) throw unavailable();
  const node = namehash(name).slice(2);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resolver = addressFromWord(await ethCall(rpcUrl, ENS_REGISTRY, RESOLVER_SELECTOR + node, controller.signal));
    if (!resolver) return null;
    return addressFromWord(await ethCall(rpcUrl, resolver, ADDR_SELECTOR + node, controller.signal));
  } finally {
    clearTimeout(timer);
  }
}
