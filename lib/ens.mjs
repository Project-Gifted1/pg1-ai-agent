// ENS name -> EVM address, for every path that takes an ENS name: the
// public playground (api/playground.mjs) and the chat's wallet checks
// (lib/chatTools.mjs createToolExecutor). An address for an ENS name only
// ever comes from resolveEnsName below, never from a model or a guess.
//
// Names are normalised with viem's ENSIP-15 implementation (normalize) and
// hashed with its namehash; nothing here hand-rolls Unicode handling or
// hashing. On top of ENSIP-15, an input carrying an invisible character
// (Default_Ignorable_Code_Point: zero-width space, joiner, soft hyphen,
// ...) is refused outright rather than silently stripped: a name pasted
// with hidden characters is a phishing signal, not something to "fix".
// Only names ending in ".eth" are taken.
//
// Resolution reads the name's resolver from the ENS registry on Ethereum
// mainnet, then that resolver's addr(). Names served through a wildcard or
// off-chain resolver (ENSIP-10 / CCIP-Read) have no registry entry of their
// own and come back as not resolved, never as a guessed address; no
// off-chain gateway is ever contacted.

import { normalize, namehash } from 'viem/ens';

export const ENS_NAME_MAX = 255;
const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/u;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Does this input claim to be an ENS name? (Ends in ".eth", any case, and
// is not an address.) Whether it is a valid one is normalizeEnsName's job.
export function looksLikeEnsName(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v.length > 4 && v.length <= ENS_NAME_MAX && !EVM_ADDRESS_RE.test(v) && /\.eth$/i.test(v);
}

// The ENSIP-15 normalised form of an ENS name ending in ".eth", or null when
// the name fails normalisation, carries an invisible character, or is not a
// .eth name with at least one label before ".eth".
export function normalizeEnsName(value) {
  if (!looksLikeEnsName(value)) return null;
  const raw = value.trim();
  if (INVISIBLE_RE.test(raw)) return null;
  let name;
  try {
    name = normalize(raw);
  } catch {
    return null;
  }
  if (!name.endsWith('.eth') || name.length <= 4 || name.split('.').some((l) => !l)) return null;
  return name;
}

// Every ENS-looking token in free text (the operator's chat message),
// valid or not, as written. Used to tell that the operator gave a name.
export function ensMentions(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const m of text.matchAll(/[^\s"'`<>()[\]{},;:!?]+\.eth\b/giu)) out.push(m[0]);
  return out;
}

export { namehash };

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
// is not a valid normalised .eth name, or has no resolver or no address.
// Throws an error with `ensUnavailable` set when the lookup itself could
// not be made (no RPC configured, network failure, timeout - `timeout` is
// then set too - or an RPC error): that is an unknown, never "no address".
export async function resolveEnsName(name, { timeoutMs = ENS_TIMEOUT_MS, rpcUrl = mainnetRpcUrl() } = {}) {
  const normalized = normalizeEnsName(name);
  if (!normalized || normalized !== name) return null;
  if (!rpcUrl) throw unavailable();
  const node = namehash(normalized).slice(2);
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
