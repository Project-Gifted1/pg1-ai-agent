// Wallet address normalisation, matching the sovereign-threat-pipeline
// ingestor exactly so lookups against sanctioned_wallets.address_normalized
// hit the same rows the pipeline wrote: 0x-prefixed (EVM) and bech32
// (bc1/tb1/bcrt1/ltc1/tltc1/rltc1-prefixed) addresses are lowercased;
// everything else (e.g. base58 addresses, which are case-sensitive) is left
// untouched.

const BECH32_PREFIXES = ['bc1', 'tb1', 'bcrt1', 'ltc1', 'tltc1', 'rltc1'];

export function normalizeWalletAddress(address) {
  const trimmed = String(address ?? '').trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('0x')) return lower;
  if (BECH32_PREFIXES.some((prefix) => lower.startsWith(prefix))) return lower;
  return trimmed;
}

// Recognised wallet address *shapes*, covering every currency present in
// public.sanctioned_wallets (XBT, TRX, ETH, USDT, LTC, XMR, BCH, DASH, ZEC,
// SOL, USDC, DOGE). This is a format check only — it rejects strings that
// cannot possibly be a wallet address (e.g. "hello", "", a mis-length 0x
// string) without asserting the address is real, checksummed, or on-curve.
// Multi-chain assets (USDT/USDC) are covered by their host chains' formats
// (EVM and, for USDT, TRON; for USDC, EVM and Solana).
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const BASE58_XBT_BCH_RE = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/; // BTC/XBT & legacy BCH (P2PKH/P2SH)
const BASE58_LTC_RE = /^[LM3][1-9A-HJ-NP-Za-km-z]{25,34}$/; // Litecoin P2PKH/P2SH
const BASE58_DOGE_RE = /^[AD9][1-9A-HJ-NP-Za-km-z]{25,34}$/; // Dogecoin P2PKH/P2SH
const BASE58_DASH_RE = /^[X7][1-9A-HJ-NP-Za-km-z]{25,34}$/; // Dash P2PKH/P2SH
const ZEC_TRANSPARENT_RE = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/; // Zcash transparent (t1/t3)
const ZEC_SHIELDED_RE = /^z[a-zA-Z0-9]{77,95}$/; // Zcash shielded (sprout/sapling)
const SEGWIT_BECH32_RE = /^(bc1|tb1|bcrt1|ltc1|tltc1|rltc1)[a-z0-9]{25,90}$/i; // BTC/LTC segwit & taproot
const CASHADDR_RE = /^(bitcoincash:|bchtest:)?[qp][a-z0-9]{41}$/i; // BCH CashAddr
const MONERO_RE = /^[48][1-9A-HJ-NP-Za-km-zA-Z]{94,105}$/; // XMR standard/subaddress/integrated
const BASE58_SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // Solana (also covers USDC-SPL)

const RECOGNIZED_ADDRESS_FORMATS = [
  EVM_ADDRESS_RE,
  TRON_ADDRESS_RE,
  BASE58_XBT_BCH_RE,
  BASE58_LTC_RE,
  BASE58_DOGE_RE,
  BASE58_DASH_RE,
  ZEC_TRANSPARENT_RE,
  ZEC_SHIELDED_RE,
  SEGWIT_BECH32_RE,
  CASHADDR_RE,
  MONERO_RE,
  BASE58_SOL_RE
];

export function isRecognizedWalletAddress(address) {
  const trimmed = String(address ?? '').trim();
  if (!trimmed) return false;
  return RECOGNIZED_ADDRESS_FORMATS.some((re) => re.test(trimmed));
}
